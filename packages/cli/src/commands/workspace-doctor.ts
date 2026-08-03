import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  HUMAN_SOFT_LEASE_HOURS,
  diagnoseWorkspace,
  normalizeAgentCapacityPolicy,
  normalizeAgentScopeConfig,
  normalizeRequirementSourceReference,
  readLeases,
  type IssueStoryContract,
  type WorkspaceDoctorProbe,
  type WorkspaceDoctorRepairKind,
  type WorkspaceDoctorRepairAction,
  type WorkspaceDoctorReport,
} from "@roll/core";
import {
  NodeAgentCapacityBroker,
  applyIssueInit,
  auditRequirementArchive,
  ensureRepositoryCache,
  git,
  inspectRepositoryCache,
  inspectAgentCapacityBrokerLock,
  inspectIssueInitJournal,
  inspectRequirementProjection,
  issueWorktreeIdentity,
  readLockOwner,
  readWorkspace,
  repairRequirementProjection,
  resolveRepositoryCacheIdentity,
  resolveRequirementSourcesForStoryOnDisk,
  resolveWorkspaceBacklogStoryContract,
  workspaceRegistryTransactionPath,
  WorkspaceRegistry,
  WorkspaceRegistryError,
  type InspectedWorkspace,
} from "@roll/infra";
import {
  AGENT_CAPACITY_LEASE_SCHEMA,
  parseIssueManifest,
  resolveLang,
  t,
  v3Catalog,
  type AgentCapacityLease,
  type Lang,
  type NormalizedAgentCapacityPolicy,
  type WorkspaceManifest,
} from "@roll/spec";
import { configLang } from "./lang.js";
import { workspaceRollHome } from "./workspace-target.js";

const WORKSPACE_DOCTOR_ERROR_V1 = "roll.workspace-doctor-error/v1" as const;
const WORKSPACE_DOCTOR_REPAIR_V1 = "roll.workspace-doctor-repair/v1" as const;

type DoctorErrorCode = "invalid_arguments" | "not_found" | "invalid_workspace" | "repair_blocked";

class WorkspaceDoctorRepairError extends Error {}

function lang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    configLang: configLang(),
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

function msg(key: string, ...args: ReadonlyArray<string | number>): string {
  return t(v3Catalog, lang(), key, ...args);
}

export function workspaceDoctorUsage(): string {
  return msg("workspace.doctor.usage");
}

interface ParsedDoctorArgs {
  readonly workspaceId: string;
  readonly json: boolean;
  readonly repair?: WorkspaceDoctorRepairAction;
  readonly path?: string;
}

const REPAIR_KINDS = new Set<WorkspaceDoctorRepairKind>([
  "update_registry_path",
  "rebuild_cache",
  "repair_requirement_projection",
  "recreate_clean_worktree",
  "cleanup_stale_owned_lease",
  "cleanup_stale_capacity_broker_lock",
]);

function parseRepairAction(value: string): WorkspaceDoctorRepairAction | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const kind = value.slice(0, separator);
  const targetId = value.slice(separator + 1);
  if (!REPAIR_KINDS.has(kind as WorkspaceDoctorRepairKind) || !/^[A-Za-z0-9._/-]+$/u.test(targetId) || targetId.includes("..")) {
    return undefined;
  }
  return { kind: kind as WorkspaceDoctorRepairKind, targetId };
}

function parseArgs(args: readonly string[]): ParsedDoctorArgs | undefined {
  let json = false;
  let repair: WorkspaceDoctorRepairAction | undefined;
  let path: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (arg === "--repair" || arg === "--path") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      if (arg === "--repair") {
        if (repair !== undefined) return undefined;
        repair = parseRepairAction(value);
        if (repair === undefined) return undefined;
      } else {
        if (path !== undefined) return undefined;
        path = value;
      }
      index += 1;
      continue;
    }
    if (arg === undefined || arg.startsWith("-")) return undefined;
    positional.push(arg);
  }
  const workspaceId = positional[0];
  if (workspaceId === undefined || workspaceId === "" || positional.length !== 1) return undefined;
  if (repair === undefined && path !== undefined) return undefined;
  if (repair?.kind === "update_registry_path") {
    if (path === undefined || !isAbsolute(path)) return undefined;
  } else if (path !== undefined) return undefined;
  return { workspaceId, json, ...(repair === undefined ? {} : { repair }), ...(path === undefined ? {} : { path }) };
}

function emitError(code: DoctorErrorCode, json: boolean): number {
  const message = msg(`workspace.doctor.error.${code}`);
  if (json) {
    process.stderr.write(`${JSON.stringify({
      schema: WORKSPACE_DOCTOR_ERROR_V1,
      error: { code, message },
    }, null, 2)}\n`);
    return 1;
  }
  process.stderr.write(`${msg("workspace.doctor.error.line", code, message)}\n`);
  return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function actionToken(action: WorkspaceDoctorRepairAction): string {
  return `${action.kind}:${action.targetId}`;
}

function renderNextAction(report: WorkspaceDoctorReport): string {
  if (report.nextAction.kind === "none") return msg("workspace.doctor.next.none");
  if (report.nextAction.kind === "repair") {
    const path = report.nextAction.action.kind === "update_registry_path"
      ? " --path <absolute-new-workspace-path>"
      : "";
    return `roll workspace doctor ${report.workspaceId} --repair ${actionToken(report.nextAction.action)}${path}`;
  }
  return msg("workspace.doctor.next.owner", report.nextAction.code);
}

function renderHuman(report: WorkspaceDoctorReport): string {
  const lines = [
    msg("workspace.doctor.title", report.workspaceId, report.status),
    msg("workspace.doctor.header"),
  ];
  if (report.findings.length === 0) {
    lines.push(msg("workspace.doctor.healthy"));
  } else {
    for (const finding of report.findings) {
      const action = finding.repairAction === undefined
        ? msg("workspace.doctor.next.owner", finding.code)
        : actionToken(finding.repairAction);
      lines.push(`${finding.status}\t${finding.code}\t${finding.evidencePath}\t${action}`);
    }
  }
  lines.push(msg("workspace.doctor.next", renderNextAction(report)));
  return `${lines.join("\n")}\n`;
}

function emitReport(report: WorkspaceDoctorReport, json: boolean): number {
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report));
  return 0;
}

function emitRepair(
  action: WorkspaceDoctorRepairAction,
  outcome: "repaired" | "reused",
  report: WorkspaceDoctorReport,
  json: boolean,
): number {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      schema: WORKSPACE_DOCTOR_REPAIR_V1,
      workspaceId: report.workspaceId,
      action,
      outcome,
      report,
    }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${msg("workspace.doctor.repair.title", actionToken(action), outcome)}\n${renderHuman(report)}`);
  return 0;
}

function registryReport(
  workspaceId: string,
  state: Extract<WorkspaceDoctorProbe, { kind: "registry" }>["state"],
): WorkspaceDoctorReport {
  return diagnoseWorkspace({
    workspaceId,
    probes: [{ kind: "registry", state, targetId: workspaceId, evidencePath: "workspaces.json" }],
  });
}

function inspectRegistry(rollHome: string, workspaceId: string):
  | { readonly report: WorkspaceDoctorReport }
  | { readonly entry: InspectedWorkspace } {
  const store = new WorkspaceRegistry({ rollHome });
  if (existsSync(workspaceRegistryTransactionPath(rollHome))) {
    try {
      store.read();
      return { report: registryReport(workspaceId, "pending_journal") };
    } catch {
      return { report: registryReport(workspaceId, "unsupported_schema") };
    }
  }
  try {
    const entry = store.inspect().find((candidate) => candidate.workspaceId === workspaceId);
    if (entry === undefined) throw new WorkspaceRegistryError("not_found", "Workspace is not registered");
    return { entry };
  } catch (error) {
    if (error instanceof WorkspaceRegistryError && error.code === "not_found") throw error;
    if (error instanceof WorkspaceRegistryError && error.code === "invalid_registry") {
      return { report: registryReport(workspaceId, "unsupported_schema") };
    }
    throw error;
  }
}

async function cacheProbes(rollHome: string, workspace: WorkspaceManifest): Promise<WorkspaceDoctorProbe[]> {
  const probes: WorkspaceDoctorProbe[] = [];
  for (const binding of workspace.repositories) {
    const state = await inspectRepositoryCache({ rollHome, binding });
    const identity = resolveRepositoryCacheIdentity({ rollHome, binding });
    let safeState = state;
    if ((state === "absent" || state === "repairable") && registeredIssueWorktreeExists(rollHome, binding.repoId)) {
      safeState = "conflict";
    }
    if (state === "repairable" && existsSync(identity.cachePath)) {
      const worktrees = await git(["--no-optional-locks", "worktree", "list", "--porcelain"], identity.cachePath);
      const linked = worktrees.code === 0
        ? worktrees.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length
        : Number.POSITIVE_INFINITY;
      if (linked > 1) safeState = "conflict";
    }
    probes.push({
      kind: "cache",
      state: safeState,
      targetId: binding.repoId,
      evidencePath: `repos/${basename(identity.cachePath)}`,
    });
  }
  return probes;
}

function requirementProbes(workspaceRoot: string, workspace: WorkspaceManifest): WorkspaceDoctorProbe[] {
  const probes: WorkspaceDoctorProbe[] = [];
  for (const declared of workspace.requirements) {
    const normalized = normalizeRequirementSourceReference(declared.provider, declared.ref);
    if (!normalized.ok) {
      probes.push({
        kind: "requirement_projection",
        state: "unsupported_schema",
        archiveStatus: "untrusted",
        targetId: "invalid-requirement",
        evidencePath: "requirements",
      });
      continue;
    }
    const { provider, requirementId } = normalized.value;
    const audit = auditRequirementArchive({ workspaceRoot, provider, requirementId });
    const projection = inspectRequirementProjection({ workspaceRoot, provider, requirementId });
    probes.push({
      kind: "requirement_projection",
      state: projection.state,
      archiveStatus: audit.status,
      targetId: requirementId,
      evidencePath: `requirements/${provider}/${requirementId}`,
    });
  }
  return probes;
}

function issueDirectories(workspaceRoot: string): readonly string[] {
  const root = join(workspaceRoot, "issues");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function issueProbes(
  rollHome: string,
  workspaceRoot: string,
  workspace: WorkspaceManifest,
): Promise<WorkspaceDoctorProbe[]> {
  const probes: WorkspaceDoctorProbe[] = [];
  for (const storyId of issueDirectories(workspaceRoot)) {
    const issueRoot = join(workspaceRoot, "issues", storyId);
    const manifestPath = join(issueRoot, "manifest.json");
    const journal = inspectIssueInitJournal(issueRoot, { workspaceId: workspace.workspaceId, storyId });
    if (journal === "unsupported_schema") {
      probes.push({
        kind: "issue",
        state: "unsupported_schema",
        targetId: storyId,
        evidencePath: `issues/${storyId}/issue-init.pending.json`,
      });
      continue;
    }
    if (!existsSync(manifestPath)) {
      probes.push({
        kind: "issue",
        state: journal === "valid" ? "partial_journal" : "unsupported_schema",
        targetId: storyId,
        evidencePath: `issues/${storyId}`,
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      raw = undefined;
    }
    const parsed = parseIssueManifest(raw);
    if (!parsed.ok || parsed.value.workspaceId !== workspace.workspaceId || parsed.value.storyId !== storyId) {
      probes.push({ kind: "issue", state: "unsupported_schema", targetId: storyId, evidencePath: `issues/${storyId}/manifest.json` });
      continue;
    }
    if (journal === "valid") {
      probes.push({ kind: "issue", state: "partial_journal", targetId: storyId, evidencePath: `issues/${storyId}/issue-init.pending.json` });
    }
    for (const target of parsed.value.repositories) {
      const binding = workspace.repositories.find((candidate) =>
        candidate.repoId === target.repoId && candidate.alias === target.alias
      );
      const evidencePath = `issues/${storyId}/${target.alias}`;
      if (binding === undefined) {
        probes.push({ kind: "issue", state: "conflict", targetId: storyId, evidencePath });
        continue;
      }
      const cache = resolveRepositoryCacheIdentity({ rollHome, binding });
      const identity = await issueWorktreeIdentity(join(issueRoot, target.alias), cache.cachePath);
      const state = identity.state === "absent"
        ? "missing_worktree"
        : identity.state === "conflict" ? "conflict" : identity.dirty ? "dirty_or_unpushed" : "compatible";
      probes.push({ kind: "issue", state, targetId: storyId, evidencePath });
    }
  }
  return probes;
}

function runtimeLockProbes(workspaceRoot: string): WorkspaceDoctorProbe[] {
  const root = join(workspaceRoot, "runtime", "locks");
  const paths = ["cycle.lock", "go.lock", "inner.lock"];
  try {
    for (const entry of readdirSync(join(root, "requirements"))) paths.push(`requirements/${entry}`);
  } catch {
    // No Requirement capture locks.
  }
  const currentHost = hostname();
  const probes: WorkspaceDoctorProbe[] = [];
  for (const relativePath of paths.sort()) {
    const path = join(root, relativePath);
    if (!existsSync(path)) continue;
    const owner = readLockOwner(path);
    const state = owner === undefined
      ? "unreadable"
      : owner.hostname !== "" && owner.hostname !== currentHost
        ? "stale_live_or_foreign"
        : pidAlive(owner.pid) ? "active" : "stale_owned_dead";
    probes.push({ kind: "runtime_lock", state, targetId: relativePath, evidencePath: `runtime/locks/${relativePath}` });
  }
  const storyLeaseDir = join(root, "leases");
  let leases: ReturnType<typeof readLeases>;
  try {
    leases = readLeases(storyLeaseDir);
  } catch {
    probes.push({ kind: "runtime_lock", state: "unsupported_schema", targetId: "story-leases", evidencePath: "runtime/locks/leases" });
    return probes;
  }
  for (const [storyId, value] of Object.entries(leases).sort(([left], [right]) => left.localeCompare(right))) {
    const evidencePath = existsSync(join(storyLeaseDir, `${storyId}.lease`))
      ? `runtime/locks/leases/${storyId}.lease`
      : "runtime/locks/story-leases.json";
    if (
      !isRecord(value) || typeof value["claimedAt"] !== "number" ||
      (value["source"] !== "cycle" && value["source"] !== "human" && value["source"] !== "supervisor" && value["source"] !== "host-delegation") ||
      (value["pid"] !== undefined && typeof value["pid"] !== "number")
    ) {
      probes.push({ kind: "runtime_lock", state: "unsupported_schema", targetId: storyId, evidencePath });
      continue;
    }
    const source = value["source"];
    const pid = value["pid"];
    const staleHuman = source !== "cycle" && Date.now() - value["claimedAt"] > HUMAN_SOFT_LEASE_HOURS * 3_600_000;
    const state = source === "cycle" && typeof pid === "number"
      ? pidAlive(pid) ? "active" : "stale_owned_dead"
      : staleHuman ? "stale_live_or_foreign" : "active";
    probes.push({ kind: "runtime_lock", state, targetId: storyId, evidencePath });
  }
  return probes;
}

function isCapacityLease(value: unknown): value is AgentCapacityLease {
  if (!isRecord(value) || value["schema"] !== AGENT_CAPACITY_LEASE_SCHEMA) return false;
  const key = value["key"];
  const owner = value["owner"];
  return isRecord(key) && typeof key["agent"] === "string" && typeof key["model"] === "string" && typeof key["contextKey"] === "string" &&
    isRecord(owner) && typeof owner["leaseId"] === "string" && typeof owner["ownerToken"] === "string" &&
    typeof owner["workspaceId"] === "string" && typeof owner["storyId"] === "string" && typeof owner["cycleId"] === "string" &&
    typeof owner["spawnId"] === "string" && typeof owner["host"] === "string" && typeof owner["pid"] === "number" &&
    typeof owner["processStartedAtMs"] === "number" && typeof value["acquiredAtMs"] === "number" && typeof value["heartbeatAtMs"] === "number";
}

function capacityLeaseProbes(rollHome: string, workspaceId: string): WorkspaceDoctorProbe[] {
  const root = join(rollHome, "locks", "capacity", "leases");
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const policy = machineCapacityPolicy(rollHome);
  if (policy === undefined) {
    return [{
      kind: "lease",
      state: "unsupported_schema",
      targetId: "capacity-policy",
      evidencePath: "agents.yaml",
    }];
  }
  const currentHost = hostname();
  const probes: WorkspaceDoctorProbe[] = [];
  for (const name of names) {
    const redactedId = createHash("sha256").update(name).digest("hex").slice(0, 12);
    const evidencePath = `locks/capacity/leases/${redactedId}.json`;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(root, name), "utf8"));
    } catch {
      probes.push({ kind: "lease", state: "unreadable", targetId: `lease-file-${redactedId}`, evidencePath });
      continue;
    }
    if (!isCapacityLease(value)) {
      probes.push({ kind: "lease", state: "unsupported_schema", targetId: `lease-file-${redactedId}`, evidencePath });
      continue;
    }
    if (value.owner.workspaceId !== workspaceId) continue;
    const stale = Date.now() - value.heartbeatAtMs > policy.staleAfterSeconds * 1_000;
    const state = !stale
      ? "active"
      : value.owner.host !== currentHost || pidAlive(value.owner.pid)
        ? "stale_live_or_foreign"
        : "stale_owned_dead";
    probes.push({ kind: "lease", state, targetId: value.owner.leaseId, evidencePath });
  }
  return probes;
}

function capacityBrokerLockProbes(rollHome: string): WorkspaceDoctorProbe[] {
  const inspection = inspectAgentCapacityBrokerLock({
    root: join(rollHome, "locks", "capacity"),
    host: hostname(),
    processIdentity: (pid) => ({ alive: pidAlive(pid) }),
  });
  if (inspection.state === "absent") return [];
  return [{
    kind: "capacity_broker_lock",
    state: inspection.state,
    targetId: "broker-lock",
    evidencePath: "locks/capacity/broker.lock",
  }];
}

function machineCapacityPolicy(rollHome: string): NormalizedAgentCapacityPolicy | undefined {
  const path = join(rollHome, "agents.yaml");
  if (!existsSync(path)) {
    return { global: 1, perAgent: {}, heartbeatSeconds: 30, staleAfterSeconds: 120 };
  }
  try {
    const parsed = normalizeAgentScopeConfig(readFileSync(path, "utf8"));
    if (parsed.config === null || parsed.config.scope !== "machine" || parsed.errors.length > 0) return undefined;
    return normalizeAgentCapacityPolicy(parsed.config);
  } catch {
    return undefined;
  }
}

async function diagnose(rollHome: string, entry: InspectedWorkspace): Promise<WorkspaceDoctorReport> {
  const registryState = entry.consistency === "consistent" ? "consistent" : entry.consistency;
  const probes: WorkspaceDoctorProbe[] = [{
    kind: "registry",
    state: registryState,
    targetId: entry.workspaceId,
    evidencePath: entry.consistency === "consistent" ? "workspace.yaml" : "workspaces.json",
  }];
  if (entry.consistency !== "consistent") return diagnoseWorkspace({ workspaceId: entry.workspaceId, probes });
  let workspace: WorkspaceManifest;
  try {
    workspace = readWorkspace(entry.root);
  } catch {
    return registryReport(entry.workspaceId, "invalid_manifest");
  }
  probes.push(...await cacheProbes(rollHome, workspace));
  probes.push(...requirementProbes(entry.root, workspace));
  probes.push(...await issueProbes(rollHome, entry.root, workspace));
  probes.push(...runtimeLockProbes(entry.root));
  probes.push(...capacityBrokerLockProbes(rollHome));
  probes.push(...capacityLeaseProbes(rollHome, entry.workspaceId));
  return diagnoseWorkspace({ workspaceId: entry.workspaceId, probes });
}

function actionMatches(left: WorkspaceDoctorRepairAction, right: WorkspaceDoctorRepairAction): boolean {
  return left.kind === right.kind && left.targetId === right.targetId;
}

function repairOffered(report: WorkspaceDoctorReport, action: WorkspaceDoctorRepairAction): boolean {
  return report.findings.some((finding) => finding.repairAction !== undefined && actionMatches(finding.repairAction, action));
}

function readIssueManifestSafe(workspaceRoot: string, storyId: string) {
  try {
    const parsed = parseIssueManifest(JSON.parse(readFileSync(join(workspaceRoot, "issues", storyId, "manifest.json"), "utf8")));
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function registeredIssueWorktreeExists(rollHome: string, repoId: string): boolean {
  let entries: readonly InspectedWorkspace[];
  try {
    entries = new WorkspaceRegistry({ rollHome }).inspect();
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (entry.consistency !== "consistent") continue;
    for (const storyId of issueDirectories(entry.root)) {
      const manifest = readIssueManifestSafe(entry.root, storyId);
      if (manifest === undefined) continue;
      for (const target of manifest.repositories) {
        if (target.repoId === repoId && existsSync(join(entry.root, "issues", storyId, target.alias))) return true;
      }
    }
  }
  return false;
}

function storyContract(workspaceRoot: string, storyId: string): IssueStoryContract {
  const resolved = resolveWorkspaceBacklogStoryContract(workspaceRoot, storyId);
  if (!resolved.ok) throw new WorkspaceDoctorRepairError("story_contract_unavailable");
  return resolved.value;
}

async function repairRegistryPath(
  rollHome: string,
  action: WorkspaceDoctorRepairAction,
  newPath: string | undefined,
  report: WorkspaceDoctorReport,
): Promise<"repaired" | "reused"> {
  if (newPath === undefined || action.targetId !== report.workspaceId) throw new WorkspaceDoctorRepairError("registry_path_required");
  const store = new WorkspaceRegistry({ rollHome });
  const entry = store.read().entries.find((candidate) => candidate.workspaceId === action.targetId);
  if (entry === undefined) throw new WorkspaceDoctorRepairError("registry_entry_missing");
  const requested = resolve(newPath);
  const current = (() => {
    try { return store.inspect().find((candidate) => candidate.workspaceId === action.targetId); } catch { return undefined; }
  })();
  if (current?.consistency === "consistent" && resolve(current.root) === requested) return "reused";
  if (!repairOffered(report, action)) throw new WorkspaceDoctorRepairError("registry_repair_not_offered");
  store.repair({ workspaceId: action.targetId, oldRoot: entry.root, newRoot: requested });
  return "repaired";
}

async function repairCache(
  rollHome: string,
  workspace: WorkspaceManifest,
  action: WorkspaceDoctorRepairAction,
  report: WorkspaceDoctorReport,
): Promise<"repaired" | "reused"> {
  const binding = workspace.repositories.find((candidate) => candidate.repoId === action.targetId);
  if (binding === undefined) throw new WorkspaceDoctorRepairError("cache_binding_missing");
  const state = await inspectRepositoryCache({ rollHome, binding });
  if (state === "compatible") return "reused";
  if (!repairOffered(report, action) || state === "conflict") throw new WorkspaceDoctorRepairError("cache_repair_not_offered");
  if (registeredIssueWorktreeExists(rollHome, binding.repoId)) {
    throw new WorkspaceDoctorRepairError("cache_has_registered_worktrees");
  }
  const identity = resolveRepositoryCacheIdentity({ rollHome, binding });
  if (existsSync(identity.cachePath)) {
    const worktrees = await git(["--no-optional-locks", "worktree", "list", "--porcelain"], identity.cachePath);
    const count = worktrees.code === 0
      ? worktrees.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length
      : Number.POSITIVE_INFINITY;
    if (count > 1) throw new WorkspaceDoctorRepairError("cache_has_linked_worktrees");
  }
  await ensureRepositoryCache({
    rollHome,
    binding,
    integrationRefspec: `+refs/heads/${binding.integrationBranch}:refs/remotes/origin/${binding.integrationBranch}`,
  });
  return "repaired";
}

function repairProjection(
  rollHome: string,
  workspaceRoot: string,
  workspace: WorkspaceManifest,
  action: WorkspaceDoctorRepairAction,
  report: WorkspaceDoctorReport,
): "repaired" | "reused" {
  const source = workspace.requirements
    .map((declared) => normalizeRequirementSourceReference(declared.provider, declared.ref))
    .find((candidate) => candidate.ok && candidate.value.requirementId === action.targetId);
  if (source === undefined || !source.ok) throw new WorkspaceDoctorRepairError("requirement_source_missing");
  const inspection = inspectRequirementProjection({
    workspaceRoot,
    provider: source.value.provider,
    requirementId: source.value.requirementId,
  });
  if (inspection.state === "current") return "reused";
  if (!repairOffered(report, action)) throw new WorkspaceDoctorRepairError("projection_repair_not_offered");
  return repairRequirementProjection({
    rollHome,
    workspaceRoot,
    provider: source.value.provider,
    requirementId: source.value.requirementId,
  }).outcome;
}

async function repairIssue(
  rollHome: string,
  entry: InspectedWorkspace,
  workspace: WorkspaceManifest,
  action: WorkspaceDoctorRepairAction,
  report: WorkspaceDoctorReport,
): Promise<"repaired" | "reused"> {
  const issueRoot = join(entry.root, "issues", action.targetId);
  const manifest = readIssueManifestSafe(entry.root, action.targetId);
  const offered = repairOffered(report, action);
  if (report.findings.some((finding) =>
    finding.targetId === action.targetId && finding.status === "data_loss_risk"
  )) {
    throw new WorkspaceDoctorRepairError("issue_has_data_loss_risk");
  }
  if (!offered && report.findings.some((finding) =>
    finding.targetId === action.targetId && finding.code.startsWith("issue_")
  )) {
    throw new WorkspaceDoctorRepairError("issue_repair_not_offered");
  }
  const hasMissing = manifest === undefined || manifest.repositories.some((target) => !existsSync(join(issueRoot, target.alias)));
  if (!hasMissing && !existsSync(join(issueRoot, "issue-init.pending.json"))) return "reused";
  if (!offered) throw new WorkspaceDoctorRepairError("issue_repair_not_offered");
  const result = await applyIssueInit({
    workspaceId: entry.workspaceId,
    rollHome,
    workspaceRoot: entry.root,
    issueRoot,
    contract: storyContract(entry.root, action.targetId),
    bindings: workspace.repositories,
    requirementManifests: resolveRequirementSourcesForStoryOnDisk(entry.root, action.targetId),
  });
  return result.outcome === "reused" ? "reused" : "repaired";
}

function cleanupLease(
  rollHome: string,
  action: WorkspaceDoctorRepairAction,
  report: WorkspaceDoctorReport,
): "repaired" | "reused" {
  const offered = repairOffered(report, action);
  if (!offered) {
    const unsafeFinding = report.findings.some((finding) =>
      finding.targetId === action.targetId && finding.code.startsWith("lease_")
    );
    if (unsafeFinding) throw new WorkspaceDoctorRepairError("lease_repair_not_offered");
    const leasePath = join(
      rollHome,
      "locks",
      "capacity",
      "leases",
      `${createHash("sha256").update(action.targetId).digest("hex")}.json`,
    );
    if (!existsSync(leasePath)) return "reused";
    throw new WorkspaceDoctorRepairError("lease_repair_not_offered");
  }
  const policy = machineCapacityPolicy(rollHome);
  if (policy === undefined) throw new WorkspaceDoctorRepairError("capacity_policy_invalid");
  const broker = new NodeAgentCapacityBroker({
    root: join(rollHome, "locks", "capacity"),
    policy,
    clockMs: Date.now,
    host: hostname(),
    processIdentity: (pid) => ({ alive: pidAlive(pid) }),
  });
  const result = broker.cleanupStaleOwned(action.targetId);
  if (result.kind === "cleaned") {
    return "repaired";
  }
  if (result.kind === "already_clean") return "reused";
  throw new WorkspaceDoctorRepairError(result.reason);
}

function cleanupCapacityBrokerLock(
  rollHome: string,
  action: WorkspaceDoctorRepairAction,
  report: WorkspaceDoctorReport,
): "repaired" | "reused" {
  const lockPath = join(rollHome, "locks", "capacity", "broker.lock");
  if (!repairOffered(report, action)) {
    if (!existsSync(lockPath)) return "reused";
    throw new WorkspaceDoctorRepairError("capacity_broker_lock_repair_not_offered");
  }
  const policy = machineCapacityPolicy(rollHome);
  if (policy === undefined) throw new WorkspaceDoctorRepairError("capacity_policy_invalid");
  const broker = new NodeAgentCapacityBroker({
    root: join(rollHome, "locks", "capacity"),
    policy,
    clockMs: Date.now,
    host: hostname(),
    processIdentity: (pid) => ({ alive: pidAlive(pid) }),
  });
  const result = broker.cleanupStaleBrokerLock();
  if (result.kind === "cleaned") return "repaired";
  if (result.kind === "already_clean") return "reused";
  throw new WorkspaceDoctorRepairError(result.reason);
}

async function executeRepair(
  rollHome: string,
  entry: InspectedWorkspace,
  action: WorkspaceDoctorRepairAction,
  path: string | undefined,
  report: WorkspaceDoctorReport,
): Promise<"repaired" | "reused"> {
  if (action.kind === "update_registry_path") return repairRegistryPath(rollHome, action, path, report);
  const workspace = readWorkspace(entry.root);
  if (action.kind === "rebuild_cache") return repairCache(rollHome, workspace, action, report);
  if (action.kind === "repair_requirement_projection") return repairProjection(rollHome, entry.root, workspace, action, report);
  if (action.kind === "recreate_clean_worktree") return repairIssue(rollHome, entry, workspace, action, report);
  if (action.kind === "cleanup_stale_capacity_broker_lock") return cleanupCapacityBrokerLock(rollHome, action, report);
  return cleanupLease(rollHome, action, report);
}

export async function workspaceDoctorCommand(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help")) {
    process.stdout.write(workspaceDoctorUsage());
    return 0;
  }
  const parsed = parseArgs(args);
  if (parsed === undefined) return emitError("invalid_arguments", json);
  const workspaceId = parsed.workspaceId;
  const rollHome = workspaceRollHome();
  try {
    const registry = inspectRegistry(rollHome, workspaceId);
    if ("report" in registry) return emitReport(registry.report, json);
    const report = await diagnose(rollHome, registry.entry);
    if (parsed.repair === undefined) return emitReport(report, json);
    let outcome: "repaired" | "reused";
    try {
      outcome = await executeRepair(rollHome, registry.entry, parsed.repair, parsed.path, report);
    } catch (error) {
      if (error instanceof WorkspaceDoctorRepairError) throw error;
      throw new WorkspaceDoctorRepairError("repair_subsystem_rejected", { cause: error });
    }
    const freshRegistry = inspectRegistry(rollHome, workspaceId);
    if ("report" in freshRegistry) return emitRepair(parsed.repair, outcome, freshRegistry.report, json);
    return emitRepair(parsed.repair, outcome, await diagnose(rollHome, freshRegistry.entry), json);
  } catch (error) {
    if (error instanceof WorkspaceRegistryError && error.code === "not_found") return emitError("not_found", json);
    if (error instanceof WorkspaceRegistryError) return emitError("invalid_workspace", json);
    if (error instanceof WorkspaceDoctorRepairError) return emitError("repair_blocked", json);
    throw error;
  }
}
