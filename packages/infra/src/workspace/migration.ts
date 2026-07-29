import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { planHistoricalWorkspaceMigration, renderDefaultWorkspaceAgentScope } from "@roll/core";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  WORKSPACE_MIGRATION_PLAN_V1,
  normalizeRepositoryRemote,
  type HistoricalMigrationMapping,
  type HistoricalMigrationPlan,
  type RepositoryBinding,
  type WorkspaceManifest,
} from "@roll/spec";
import { rawGit } from "../git.js";
import { acquireLock, releaseLock } from "../process.js";
import { ensureRepositoryCache } from "../repository-cache.js";
import { WorkspaceRegistry } from "../workspace-registry.js";
import {
  withWorkspaceAuthorityLock,
  withWorkspaceAuthorityLockSync,
  WorkspaceAuthorityLockError,
} from "../workspace-authority-lock.js";
import { collectHistoricalMigrationFacts } from "./migration-facts.js";

const JOURNAL_V1 = "roll.workspace-migration-journal/v1" as const;
const MANIFEST_V1 = "roll.workspace-migration-manifest/v1" as const;
const RELOCATION_V1 = "roll.workspace-relocation/v1" as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const REPO_ID = /^repo-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{40,64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const GIT_TIMEOUT_MS = 60_000;

export type HistoricalWorkspaceMigrationPhase =
  | "prepared"
  | "cache_ready"
  | "content_ready"
  | "workspace_ready"
  | "registered"
  | "activated"
  | "cleanup_complete";

export type HistoricalWorkspaceMigrationErrorCode =
  | "invalid_plan"
  | "plan_drift"
  | "cutover_invalid"
  | "journal_conflict"
  | "destination_conflict"
  | "source_conflict"
  | "concurrent_migration"
  | "rollback_blocked_active"
  | "apply_failed";

export class HistoricalWorkspaceMigrationError extends Error {
  constructor(readonly code: HistoricalWorkspaceMigrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HistoricalWorkspaceMigrationError";
  }
}

export interface ApplyHistoricalWorkspaceMigrationInput {
  readonly sourceRoot: string;
  readonly rollHome: string;
  readonly plan: HistoricalMigrationPlan;
}

export interface HistoricalWorkspaceMigrationDeps {
  readonly afterPhase?: (phase: HistoricalWorkspaceMigrationPhase) => void;
  readonly forceCopy?: boolean;
  readonly now?: () => number;
  readonly onLockAcquired?: (lock: "authority" | "migration" | "repository") => void;
}

export interface HistoricalWorkspaceMigrationResult {
  readonly outcome: "migrated" | "reused";
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly cachePath: string;
  readonly planId: string;
  readonly manualHandoff?: {
    readonly required: true;
    readonly gitMutationPerformed: false;
    readonly instructions: readonly string[];
  };
}

export interface RollbackHistoricalWorkspaceMigrationResult {
  readonly outcome: "rolled_back" | "absent";
  readonly workspaceId: string;
}

type TransferMode = "move" | "copy" | "discard";
type TransferState = "pending" | "staged" | "cleaned";

interface MigrationTransfer {
  readonly source: string;
  readonly destination: string | null;
  readonly digest: string;
  readonly mode: TransferMode;
  readonly state: TransferState;
}

interface MigrationJournal {
  readonly schema: typeof JOURNAL_V1;
  readonly transactionId: string;
  readonly sourceRoot: string;
  readonly rollHome: string;
  readonly workspaceRoot: string;
  readonly stagingRoot: string;
  readonly plan: HistoricalMigrationPlan;
  readonly planDigest: string;
  readonly normalizedRemote: string;
  readonly transportRemote: string;
  readonly ownership: "ordinary" | "product_tracked" | "independent_git";
  readonly phase: HistoricalWorkspaceMigrationPhase;
  readonly transfers: readonly MigrationTransfer[];
  readonly startedAt: number;
}

interface MigrationManifest {
  readonly schema: typeof MANIFEST_V1;
  readonly planId: string;
  readonly sourceRoot: string;
  readonly workspaceId: string;
  readonly repoId: string;
  readonly ownership: MigrationJournal["ownership"];
  readonly state: "staging" | "active";
  readonly mappings: HistoricalMigrationPlan["mappings"];
  readonly manualHandoffRequired: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeRelative(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.includes("\\") || value.includes("\0") || isAbsolute(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function safeOptionalRelative(value: unknown): value is string | null {
  return value === null || safeRelative(value);
}

function parseMapping(value: unknown): HistoricalMigrationMapping | null {
  if (!isRecord(value) || !exactKeys(value, ["action", "source", "destination", "digest", "reason"])) return null;
  const action = value["action"];
  const source = value["source"];
  const destination = value["destination"];
  const digest = value["digest"];
  const reason = value["reason"];
  if (
    !["move_preserve", "copy_preserve", "import_inactive", "archive_regenerate", "quarantine_unclassified", "discard_rebuildable"].includes(String(action)) ||
    !safeRelative(source) || !safeOptionalRelative(destination) || typeof digest !== "string" || !DIGEST.test(digest) ||
    typeof reason !== "string" || reason === ""
  ) return null;
  if (action === "discard_rebuildable") {
    return destination === null ? { action, source, destination, digest, reason } : null;
  }
  if (destination === null) return null;
  if (action === "move_preserve" || action === "copy_preserve" || action === "import_inactive" || action === "archive_regenerate" || action === "quarantine_unclassified") {
    return { action, source, destination, digest, reason };
  }
  return null;
}

function parseFindings(value: unknown): HistoricalMigrationPlan["findings"] | null {
  if (!Array.isArray(value)) return null;
  const findings: Array<{ severity: "info" | "error"; code: string; path?: string }> = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const keys = raw["path"] === undefined ? ["severity", "code"] : ["severity", "code", "path"];
    if (!exactKeys(raw, keys)) return null;
    const severity = raw["severity"];
    const code = raw["code"];
    const path = raw["path"];
    const infoCodes = ["workspace_id_defaulted", "cache_create_planned"];
    const errorCodes = [
      "product_dirty", "product_operation_in_flight", "head_unpushed", "remote_missing",
      "remote_default_ambiguous", "remote_truth_unverifiable", "linked_worktree_unsafe",
      "submodule_unsafe", "active_runtime", "roll_symlink_unsupported", "cache_conflict",
      "workspace_conflict",
    ];
    if ((severity !== "info" && severity !== "error") || typeof code !== "string" ||
      (severity === "info" ? !infoCodes.includes(code) : !errorCodes.includes(code))) return null;
    if (path !== undefined && typeof path !== "string") return null;
    findings.push({ severity, code, ...(path === undefined ? {} : { path }) });
  }
  return findings as HistoricalMigrationPlan["findings"];
}

/** Parse an owner-saved check document as a closed, path-safe migration plan. */
export function parseHistoricalWorkspaceMigrationPlan(value: unknown): HistoricalMigrationPlan {
  if (!isRecord(value)) throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration plan must be an object");
  const verdict = value["verdict"];
  const variantKeys = verdict === "repository_cutover_required" ? ["repositoryCutover"] :
    verdict === "manual_metadata_handoff" ? ["manualHandoff"] : [];
  if (!exactKeys(value, ["schema", "planId", "verdict", "workspaceId", "workspaceRoot", "repository", "mappings", "findings", ...variantKeys])) {
    throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration plan has an invalid or open shape");
  }
  const planId = value["planId"];
  const workspaceId = value["workspaceId"];
  const workspaceRoot = value["workspaceRoot"];
  if (
    value["schema"] !== WORKSPACE_MIGRATION_PLAN_V1 || typeof planId !== "string" || !DIGEST.test(planId) ||
    typeof workspaceId !== "string" || !SAFE_ID.test(workspaceId) || workspaceRoot !== `workspaces/${workspaceId}` ||
    !["ready", "migration_blocked", "repository_cutover_required", "manual_metadata_handoff"].includes(String(verdict))
  ) throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration plan identity is invalid");
  const repository = value["repository"];
  if (!isRecord(repository)) throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration repository is invalid");
  const hasBranch = verdict !== "migration_blocked";
  if (!exactKeys(repository, hasBranch ? ["alias", "repoId", "integrationBranch", "cachePath"] : ["alias", "repoId", "cachePath"])) {
    throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration repository has an invalid shape");
  }
  const repoId = repository["repoId"];
  const integrationBranch = repository["integrationBranch"];
  if (
    repository["alias"] !== "primary" || typeof repoId !== "string" || !REPO_ID.test(repoId) ||
    repository["cachePath"] !== `repos/${repoId}.git` ||
    (hasBranch && (typeof integrationBranch !== "string" || integrationBranch === "" || integrationBranch.includes("..")))
  ) throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration repository identity is invalid");
  if (!Array.isArray(value["mappings"])) throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration mappings must be an array");
  const mappings = value["mappings"].map(parseMapping);
  if (mappings.some((mapping) => mapping === null)) throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration mapping is invalid");
  const typedMappings = mappings as HistoricalMigrationMapping[];
  if (new Set(typedMappings.map((mapping) => mapping.source)).size !== typedMappings.length) {
    throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration mapping sources must be unique");
  }
  const destinations = typedMappings.flatMap((mapping) => mapping.destination === null ? [] : [mapping.destination]);
  if (new Set(destinations).size !== destinations.length) {
    throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration mapping destinations must be unique");
  }
  const findings = parseFindings(value["findings"]);
  if (findings === null) throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration findings are invalid");
  const base = {
    schema: WORKSPACE_MIGRATION_PLAN_V1,
    planId,
    workspaceId,
    workspaceRoot,
    repository: {
      alias: "primary" as const,
      repoId,
      ...(hasBranch ? { integrationBranch: integrationBranch as string } : {}),
      cachePath: `repos/${repoId}.git`,
    },
    mappings: typedMappings,
    findings,
  };
  if (verdict === "ready") return { ...base, verdict, repository: { ...base.repository, integrationBranch: integrationBranch as string } };
  if (verdict === "migration_blocked") {
    if (findings.length === 0 || findings[0]?.severity !== "error") throw new HistoricalWorkspaceMigrationError("invalid_plan", "Blocked plan requires an error finding");
    return { ...base, verdict, findings: findings as HistoricalMigrationPlan & never } as HistoricalMigrationPlan;
  }
  if (verdict === "repository_cutover_required") {
    const cutover = value["repositoryCutover"];
    if (!isRecord(cutover) || !exactKeys(cutover, ["sourceHead", "trackedEntries", "requiredAction"]) ||
      typeof cutover["sourceHead"] !== "string" || !SHA.test(cutover["sourceHead"]) ||
      cutover["requiredAction"] !== "remove_product_tracking_through_existing_tcr_pr_push_flow" || !Array.isArray(cutover["trackedEntries"])) {
      throw new HistoricalWorkspaceMigrationError("invalid_plan", "Repository cutover payload is invalid");
    }
    const trackedEntries = cutover["trackedEntries"].map((entry) => {
      if (!isRecord(entry) || !exactKeys(entry, ["path", "digest"]) || !safeRelative(entry["path"]) ||
        typeof entry["digest"] !== "string" || !DIGEST.test(entry["digest"])) return null;
      return { path: entry["path"], digest: entry["digest"] };
    });
    if (trackedEntries.some((entry) => entry === null) || new Set(trackedEntries.map((entry) => entry?.path)).size !== trackedEntries.length) {
      throw new HistoricalWorkspaceMigrationError("invalid_plan", "Repository cutover entries are invalid");
    }
    return {
      ...base,
      verdict,
      repository: { ...base.repository, integrationBranch: integrationBranch as string },
      repositoryCutover: {
        sourceHead: cutover["sourceHead"],
        trackedEntries: trackedEntries as Array<{ path: string; digest: string }>,
        requiredAction: "remove_product_tracking_through_existing_tcr_pr_push_flow",
      },
    };
  }
  const handoff = value["manualHandoff"];
  if (!isRecord(handoff) || !exactKeys(handoff, ["gitdirToken", "topLevelToken", "state", "head", "branch", "upstream", "normalizedRemote"]) ||
    typeof handoff["gitdirToken"] !== "string" || typeof handoff["topLevelToken"] !== "string" ||
    !["clean", "dirty", "in_flight"].includes(String(handoff["state"])) || typeof handoff["head"] !== "string" || !SHA.test(handoff["head"]) ||
    (handoff["branch"] !== null && typeof handoff["branch"] !== "string") ||
    (handoff["upstream"] !== null && typeof handoff["upstream"] !== "string") ||
    (handoff["normalizedRemote"] !== null && (typeof handoff["normalizedRemote"] !== "string" || !normalizeRepositoryRemote(handoff["normalizedRemote"]).ok))) {
    throw new HistoricalWorkspaceMigrationError("invalid_plan", "Manual metadata handoff is invalid");
  }
  return {
    ...base,
    verdict: "manual_metadata_handoff",
    repository: { ...base.repository, integrationBranch: integrationBranch as string },
    manualHandoff: {
      gitdirToken: handoff["gitdirToken"],
      topLevelToken: handoff["topLevelToken"],
      state: handoff["state"] as "clean" | "dirty" | "in_flight",
      head: handoff["head"],
      branch: handoff["branch"] as string | null,
      upstream: handoff["upstream"] as string | null,
      normalizedRemote: handoff["normalizedRemote"] as string | null,
    },
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new HistoricalWorkspaceMigrationError("source_conflict", "Migration source must remain a regular file");
  return digestBytes(readFileSync(path));
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function contained(root: string, candidate: string): boolean {
  const token = relative(root, candidate);
  return token === "" || (!isAbsolute(token) && token !== ".." && !token.startsWith(`..${sep}`));
}

function child(root: string, token: string): string {
  const candidate = resolve(root, token);
  if (!contained(root, candidate) || candidate === resolve(root)) {
    throw new HistoricalWorkspaceMigrationError("invalid_plan", "Migration path escapes its authority root");
  }
  return candidate;
}

export function historicalWorkspaceMigrationJournalPath(rollHome: string, workspaceId: string): string {
  return join(resolve(rollHome), "workspace-migrations", `${workspaceId}.pending.json`);
}

function manifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, "migration-manifest.json");
}

function planDigest(plan: HistoricalMigrationPlan): string {
  return digestBytes(Buffer.from(stable(plan), "utf8"));
}

function journalText(journal: MigrationJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function writeJournal(path: string, journal: MigrationJournal): void {
  atomicWrite(path, journalText(journal));
}

function readJournal(path: string, input: ApplyHistoricalWorkspaceMigrationInput, plan: HistoricalMigrationPlan): MigrationJournal | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new HistoricalWorkspaceMigrationError("journal_conflict", "Migration journal is unreadable", { cause: error });
  }
  const expectedStaging = join(resolve(input.rollHome), "workspace-migrations", `${plan.workspaceId}.${plan.planId}.staging`);
  const expectedWorkspace = child(resolve(input.rollHome), plan.workspaceRoot);
  const phases: readonly HistoricalWorkspaceMigrationPhase[] = ["prepared", "cache_ready", "content_ready", "workspace_ready", "registered", "activated", "cleanup_complete"];
  if (!isRecord(value) || !exactKeys(value, [
    "schema", "transactionId", "sourceRoot", "rollHome", "workspaceRoot", "stagingRoot", "plan", "planDigest",
    "normalizedRemote", "transportRemote", "ownership", "phase", "transfers", "startedAt",
  ]) || value["schema"] !== JOURNAL_V1 || value["sourceRoot"] !== resolve(input.sourceRoot) ||
    value["rollHome"] !== resolve(input.rollHome) || value["workspaceRoot"] !== expectedWorkspace || value["stagingRoot"] !== expectedStaging ||
    value["planDigest"] !== planDigest(plan) || stable(value["plan"]) !== stable(plan) ||
    typeof value["transactionId"] !== "string" || value["transactionId"] === "" ||
    typeof value["normalizedRemote"] !== "string" || !normalizeRepositoryRemote(value["normalizedRemote"]).ok ||
    typeof value["transportRemote"] !== "string" || !normalizeRepositoryRemote(value["transportRemote"]).ok ||
    !["ordinary", "product_tracked", "independent_git"].includes(String(value["ownership"])) ||
    !phases.includes(value["phase"] as HistoricalWorkspaceMigrationPhase) ||
    typeof value["startedAt"] !== "number" || !Number.isFinite(value["startedAt"]) || !Array.isArray(value["transfers"])) {
    throw new HistoricalWorkspaceMigrationError("journal_conflict", "Migration journal conflicts with the requested plan");
  }
  const normalizedTransport = normalizeRepositoryRemote(value["transportRemote"]);
  if (!normalizedTransport.ok || normalizedTransport.value !== value["normalizedRemote"] || value["transfers"].length !== plan.mappings.length) {
    throw new HistoricalWorkspaceMigrationError("journal_conflict", "Migration journal remote or transfer count is invalid");
  }
  const ownership = value["ownership"] as MigrationJournal["ownership"];
  const phase = value["phase"] as HistoricalWorkspaceMigrationPhase;
  const contentReady = phases.indexOf(phase) >= phases.indexOf("content_ready");
  const activated = phases.indexOf(phase) >= phases.indexOf("activated");
  for (const [index, raw] of value["transfers"].entries()) {
    const mapping = plan.mappings[index];
    const expectedMode = mapping === undefined ? null : transferMode(mapping, ownership);
    if (!isRecord(raw) || !exactKeys(raw, ["source", "destination", "digest", "mode", "state"]) || mapping === undefined ||
      raw["source"] !== mapping.source || raw["destination"] !== mapping.destination || raw["digest"] !== mapping.digest ||
      !["move", "copy", "discard"].includes(String(raw["mode"])) || !["pending", "staged", "cleaned"].includes(String(raw["state"])) ||
      (expectedMode === "move" ? raw["mode"] !== "move" && raw["mode"] !== "copy" : raw["mode"] !== expectedMode) ||
      (contentReady && raw["state"] === "pending") || (!activated && raw["state"] === "cleaned")) {
      throw new HistoricalWorkspaceMigrationError("journal_conflict", "Migration journal transfer is invalid");
    }
  }
  return value as unknown as MigrationJournal;
}

async function gitRequired(sourceRoot: string, args: readonly string[]): Promise<string> {
  const result = await rawGit(["--no-optional-locks", ...args], sourceRoot, { timeoutMs: GIT_TIMEOUT_MS });
  if (result.code !== 0) throw new HistoricalWorkspaceMigrationError("cutover_invalid", "Migration cutover Git proof failed");
  return result.stdout.trim();
}

function parseNameStatus(output: string): readonly { readonly status: string; readonly path: string }[] {
  const tokens = output.split("\0").filter((token) => token !== "");
  const entries: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index];
    const path = tokens[index + 1];
    if (status === undefined || path === undefined) return [];
    entries.push({ status, path });
  }
  return entries;
}

async function verifyCutover(sourceRoot: string, plan: Extract<HistoricalMigrationPlan, { verdict: "repository_cutover_required" }>): Promise<void> {
  const currentHead = await gitRequired(sourceRoot, ["rev-parse", "HEAD"]);
  const ancestor = await rawGit(["--no-optional-locks", "merge-base", "--is-ancestor", plan.repositoryCutover.sourceHead, currentHead], sourceRoot, { timeoutMs: GIT_TIMEOUT_MS });
  if (ancestor.code !== 0) throw new HistoricalWorkspaceMigrationError("cutover_invalid", "Planned source HEAD is not an ancestor of current HEAD");
  const commits = (await gitRequired(sourceRoot, ["rev-list", "--reverse", `${plan.repositoryCutover.sourceHead}..${currentHead}`]))
    .split("\n").filter((entry) => entry !== "");
  const expected = plan.repositoryCutover.trackedEntries.map((entry) => `.roll/${entry.path}`).sort();
  const matches: string[] = [];
  for (const commit of commits) {
    const parents = (await gitRequired(sourceRoot, ["rev-list", "--parents", "-n", "1", commit])).split(/\s+/u);
    if (parents.length !== 2 || parents[1] === undefined) continue;
    const diff = await gitRequired(sourceRoot, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", parents[1], commit]);
    const entries = parseNameStatus(diff);
    const removed = entries.filter((entry) => entry.status === "D").map((entry) => entry.path).sort();
    if (entries.length === expected.length && removed.length === expected.length && stable(removed) === stable(expected)) matches.push(commit);
  }
  if (matches.length !== 1) throw new HistoricalWorkspaceMigrationError("cutover_invalid", "Cutover history must contain exactly one dedicated removal commit");
  for (const entry of plan.repositoryCutover.trackedEntries) {
    if (digestFile(child(join(sourceRoot, ".roll"), entry.path)) !== entry.digest) {
      throw new HistoricalWorkspaceMigrationError("cutover_invalid", "Cutover working files no longer match the approved payload");
    }
  }
}

async function freshValidation(input: ApplyHistoricalWorkspaceMigrationInput, plan: HistoricalMigrationPlan): Promise<{
  readonly normalizedRemote: string;
  readonly transportRemote: string;
  readonly ownership: MigrationJournal["ownership"];
}> {
  const sourceRoot = resolve(input.sourceRoot);
  const facts = await collectHistoricalMigrationFacts({
    sourceRoot,
    rollHome: resolve(input.rollHome),
    requestedWorkspaceId: plan.workspaceId,
  });
  const current = planHistoricalWorkspaceMigration(facts);
  if (plan.verdict === "migration_blocked") throw new HistoricalWorkspaceMigrationError("invalid_plan", "A blocked plan cannot be applied");
  if (facts.git.remote.kind !== "verified") throw new HistoricalWorkspaceMigrationError("plan_drift", "Remote truth is no longer verified");
  if (plan.verdict === "repository_cutover_required") {
    if (current.verdict !== "ready" || stable(current.repository) !== stable(plan.repository) || stable(current.mappings) !== stable(plan.mappings)) {
      throw new HistoricalWorkspaceMigrationError("plan_drift", "Source state no longer matches the approved cutover mappings");
    }
    await verifyCutover(sourceRoot, plan);
  } else if (stable(current) !== stable(plan)) {
    throw new HistoricalWorkspaceMigrationError("plan_drift", "Fresh migration facts do not reproduce the approved plan");
  }
  const remote = await gitRequired(sourceRoot, ["remote", "get-url", "origin"]);
  const normalized = normalizeRepositoryRemote(remote);
  if (!normalized.ok || normalized.value !== facts.git.remote.normalizedRemote) {
    throw new HistoricalWorkspaceMigrationError("plan_drift", "Product remote changed after migration check");
  }
  return {
    normalizedRemote: normalized.value,
    transportRemote: remote,
    ownership: plan.verdict === "manual_metadata_handoff" ? "independent_git" :
      plan.verdict === "repository_cutover_required" ? "product_tracked" : "ordinary",
  };
}

function transferMode(mapping: HistoricalMigrationMapping, ownership: MigrationJournal["ownership"]): TransferMode {
  if (mapping.action === "discard_rebuildable") return "discard";
  if (ownership === "independent_git" || mapping.action === "copy_preserve") return "copy";
  return "move";
}

function baseManifest(journal: MigrationJournal, state: MigrationManifest["state"]): MigrationManifest {
  return {
    schema: MANIFEST_V1,
    planId: journal.plan.planId,
    sourceRoot: journal.sourceRoot,
    workspaceId: journal.plan.workspaceId,
    repoId: journal.plan.repository.repoId,
    ownership: journal.ownership,
    state,
    mappings: journal.plan.mappings,
    manualHandoffRequired: journal.ownership === "independent_git",
  };
}

function binding(journal: MigrationJournal): RepositoryBinding {
  return {
    schema: REPOSITORY_BINDING_V1,
    repoId: journal.plan.repository.repoId,
    alias: "primary",
    remote: journal.normalizedRemote,
    integrationBranch: journal.plan.repository.integrationBranch as string,
    provider: "generic",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  };
}

function workspaceManifest(journal: MigrationJournal): WorkspaceManifest {
  return {
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId: journal.plan.workspaceId,
    displayName: journal.plan.workspaceId,
    requirements: [],
    repositories: [binding(journal)],
  };
}

function createBaseLayout(journal: MigrationJournal): void {
  const root = journal.stagingRoot;
  if (existsSync(root)) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HistoricalWorkspaceMigrationError("destination_conflict", "Migration staging root is unsafe");
  } else mkdirSync(root, { recursive: true });
  for (const path of ["requirements", "design", "backlog", "issues", "runtime", "runtime/locks", "runtime/heartbeats", "runtime/alerts"]) {
    mkdirSync(child(root, path), { recursive: true });
  }
  const texts: Readonly<Record<string, string>> = {
    "workspace.yaml": `${JSON.stringify(workspaceManifest(journal), null, 2)}\n`,
    "charter.md": `# ${journal.plan.workspaceId}\n\nMigrated Workspace charter.\n`,
    "agents.yaml": renderDefaultWorkspaceAgentScope(),
    "policy.yaml": "schema: roll.workspace-policy/v1\n",
    "migration-manifest.json": `${JSON.stringify(baseManifest(journal, "staging"), null, 2)}\n`,
  };
  if (!journal.plan.mappings.some((mapping) => mapping.destination === "backlog/index.md")) {
    (texts as Record<string, string>)["backlog/index.md"] = "# Backlog\n";
  }
  for (const [token, text] of Object.entries(texts)) {
    const path = child(root, token);
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== text) throw new HistoricalWorkspaceMigrationError("destination_conflict", "Migration staging file conflicts with the approved transaction");
    } else atomicWrite(path, text);
  }
}

function sameFilesystem(source: string, destinationRoot: string): boolean {
  return statSync(source).dev === statSync(destinationRoot).dev;
}

function updateTransfer(journal: MigrationJournal, index: number, transfer: MigrationTransfer): MigrationJournal {
  return { ...journal, transfers: journal.transfers.map((entry, entryIndex) => entryIndex === index ? transfer : entry) };
}

function stageTransfers(path: string, initial: MigrationJournal, deps: HistoricalWorkspaceMigrationDeps): MigrationJournal {
  let journal = initial;
  createBaseLayout(journal);
  for (let index = 0; index < journal.transfers.length; index += 1) {
    const transfer = journal.transfers[index];
    if (transfer === undefined || transfer.state !== "pending") continue;
    const source = child(join(journal.sourceRoot, ".roll"), transfer.source);
    const destination = transfer.destination === null
      ? null
      : child(journal.stagingRoot, transfer.destination);
    if (!existsSync(source)) {
      if (transfer.mode !== "move" || destination === null || !existsSync(destination)) {
        throw new HistoricalWorkspaceMigrationError("source_conflict", "Migration source disappeared before its transfer was journaled");
      }
      if (digestFile(destination) !== transfer.digest) {
        throw new HistoricalWorkspaceMigrationError("destination_conflict", "Moved migration destination changed before journal recovery");
      }
      journal = updateTransfer(journal, index, { ...transfer, state: "staged" });
      writeJournal(path, journal);
      continue;
    }
    if (digestFile(source) !== transfer.digest) throw new HistoricalWorkspaceMigrationError("source_conflict", "Migration source changed after validation");
    let mode = transfer.mode;
    if (mode === "move" && (deps.forceCopy === true || !sameFilesystem(source, journal.stagingRoot))) mode = "copy";
    if (destination !== null) {
      mkdirSync(dirname(destination), { recursive: true });
      if (existsSync(destination)) {
        if (digestFile(destination) !== transfer.digest) throw new HistoricalWorkspaceMigrationError("destination_conflict", "Migration destination already contains different bytes");
        if (mode === "move") mode = "copy";
      } else if (mode === "move") renameSync(source, destination);
      else copyFileSync(source, destination, 0);
      if (digestFile(destination) !== transfer.digest) throw new HistoricalWorkspaceMigrationError("apply_failed", "Migration destination digest verification failed");
    }
    journal = updateTransfer(journal, index, { ...transfer, mode, state: "staged" });
    writeJournal(path, journal);
  }
  return journal;
}

function verifyStaged(journal: MigrationJournal, root: string): void {
  for (const transfer of journal.transfers) {
    if (transfer.destination === null) continue;
    if (digestFile(child(root, transfer.destination)) !== transfer.digest) {
      throw new HistoricalWorkspaceMigrationError("destination_conflict", "Migration destination verification failed");
    }
  }
}

function removeEmptyDirectories(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    removeEmptyDirectories(join(root, entry.name));
  }
  if (readdirSync(root).length === 0) rmdirSync(root);
}

function cleanupSource(path: string, initial: MigrationJournal): MigrationJournal {
  if (initial.ownership === "independent_git") return initial;
  let journal = initial;
  for (let index = 0; index < journal.transfers.length; index += 1) {
    const transfer = journal.transfers[index];
    if (transfer === undefined || transfer.state === "cleaned") continue;
    const source = child(join(journal.sourceRoot, ".roll"), transfer.source);
    if (existsSync(source)) {
      if (digestFile(source) !== transfer.digest) throw new HistoricalWorkspaceMigrationError("source_conflict", "Migration source changed before cleanup");
      rmSync(source, { force: true });
    }
    journal = updateTransfer(journal, index, { ...transfer, state: "cleaned" });
    writeJournal(path, journal);
  }
  removeEmptyDirectories(join(journal.sourceRoot, ".roll"));
  const relocationRoot = join(journal.sourceRoot, ".roll");
  mkdirSync(relocationRoot, { recursive: true });
  atomicWrite(join(relocationRoot, "RELOCATED.json"), `${JSON.stringify({
    schema: RELOCATION_V1,
    workspaceId: journal.plan.workspaceId,
    workspaceRoot: journal.workspaceRoot,
    planId: journal.plan.planId,
  }, null, 2)}\n`);
  return journal;
}

function completedResult(journal: MigrationJournal, outcome: HistoricalWorkspaceMigrationResult["outcome"]): HistoricalWorkspaceMigrationResult {
  return {
    outcome,
    workspaceId: journal.plan.workspaceId,
    workspaceRoot: journal.workspaceRoot,
    cachePath: child(journal.rollHome, journal.plan.repository.cachePath),
    planId: journal.plan.planId,
    ...(journal.ownership === "independent_git" ? {
      manualHandoff: {
        required: true as const,
        gitMutationPerformed: false as const,
        instructions: [
          "Review the preserved roll-meta repository and link it to the migrated Workspace manually if desired.",
          "Commit and push roll-meta only through its existing owner-approved workflow.",
        ],
      },
    } : {}),
  };
}

function completedManifest(input: ApplyHistoricalWorkspaceMigrationInput, plan: HistoricalMigrationPlan): MigrationManifest | null {
  const workspaceRoot = child(resolve(input.rollHome), plan.workspaceRoot);
  const path = manifestPath(workspaceRoot);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(value) || !exactKeys(value, [
      "schema", "planId", "sourceRoot", "workspaceId", "repoId", "ownership", "state", "mappings", "manualHandoffRequired",
    ]) || value["schema"] !== MANIFEST_V1 || value["planId"] !== plan.planId || value["sourceRoot"] !== resolve(input.sourceRoot) ||
      value["workspaceId"] !== plan.workspaceId || value["repoId"] !== plan.repository.repoId || value["state"] !== "active" ||
      stable(value["mappings"]) !== stable(plan.mappings)) return null;
    const workspaceRoot = child(resolve(input.rollHome), plan.workspaceRoot);
    for (const mapping of plan.mappings) {
      if (mapping.destination !== null && digestFile(child(workspaceRoot, mapping.destination)) !== mapping.digest) return null;
    }
    return value as unknown as MigrationManifest;
  } catch {
    return null;
  }
}

function completedMigrationIsActive(input: ApplyHistoricalWorkspaceMigrationInput, plan: HistoricalMigrationPlan): boolean {
  if (completedManifest(input, plan) === null) return false;
  const workspaceRoot = child(resolve(input.rollHome), plan.workspaceRoot);
  try {
    const cachePath = child(resolve(input.rollHome), plan.repository.cachePath);
    const cache = lstatSync(cachePath);
    if (!cache.isDirectory() || cache.isSymbolicLink()) return false;
    return new WorkspaceRegistry({ rollHome: resolve(input.rollHome) }).inspect().some((entry) =>
      entry.workspaceId === plan.workspaceId && entry.root === workspaceRoot && entry.lifecycle === "active" && entry.consistency === "consistent"
    );
  } catch {
    return false;
  }
}

function migrationLockPath(rollHome: string, workspaceId: string): string {
  return join(resolve(rollHome), "locks", "workspace-migration", `${workspaceId}.lock`);
}

/** Apply or resume one exact owner-approved historical migration plan. */
async function applyHistoricalWorkspaceMigrationUnlocked(
  input: ApplyHistoricalWorkspaceMigrationInput,
  deps: HistoricalWorkspaceMigrationDeps = {},
): Promise<HistoricalWorkspaceMigrationResult> {
  const plan = parseHistoricalWorkspaceMigrationPlan(input.plan);
  const normalizedInput = { ...input, sourceRoot: resolve(input.sourceRoot), rollHome: resolve(input.rollHome), plan };
  const workspaceRoot = child(normalizedInput.rollHome, plan.workspaceRoot);
  const journalPath = historicalWorkspaceMigrationJournalPath(normalizedInput.rollHome, plan.workspaceId);
  if (completedMigrationIsActive(normalizedInput, plan) && !existsSync(journalPath)) {
    const ownership = plan.verdict === "manual_metadata_handoff" ? "independent_git" : plan.verdict === "repository_cutover_required" ? "product_tracked" : "ordinary";
    return completedResult({
      schema: JOURNAL_V1,
      transactionId: "completed",
      sourceRoot: normalizedInput.sourceRoot,
      rollHome: normalizedInput.rollHome,
      workspaceRoot,
      stagingRoot: "",
      plan,
      planDigest: planDigest(plan),
      normalizedRemote: "",
      transportRemote: "",
      ownership,
      phase: "cleanup_complete",
      transfers: [],
      startedAt: 0,
    }, "reused");
  }
  let journal = readJournal(journalPath, normalizedInput, plan);
  if (journal === null) {
    if (existsSync(workspaceRoot)) throw new HistoricalWorkspaceMigrationError("destination_conflict", "Workspace destination already exists without this migration manifest");
    await freshValidation(normalizedInput, plan);
  }
  const lockPath = migrationLockPath(normalizedInput.rollHome, plan.workspaceId);
  const lock = acquireLock(lockPath, process.pid, { cycleId: `workspace-migration:${plan.workspaceId}`, unparseableIsHeld: true });
  if (!lock.acquired) throw new HistoricalWorkspaceMigrationError("concurrent_migration", "Workspace migration is already running");
  try {
    deps.onLockAcquired?.("migration");
    if (completedMigrationIsActive(normalizedInput, plan) && !existsSync(journalPath)) {
      const ownership = plan.verdict === "manual_metadata_handoff" ? "independent_git" : plan.verdict === "repository_cutover_required" ? "product_tracked" : "ordinary";
      return completedResult({
        schema: JOURNAL_V1, transactionId: "completed", sourceRoot: normalizedInput.sourceRoot, rollHome: normalizedInput.rollHome,
        workspaceRoot, stagingRoot: "", plan, planDigest: planDigest(plan), normalizedRemote: "", transportRemote: "",
        ownership, phase: "cleanup_complete", transfers: [], startedAt: 0,
      }, "reused");
    }
    journal = readJournal(journalPath, normalizedInput, plan);
    if (journal === null) {
      const validation = await freshValidation(normalizedInput, plan);
      const stagingRoot = join(normalizedInput.rollHome, "workspace-migrations", `${plan.workspaceId}.${plan.planId}.staging`);
      journal = {
        schema: JOURNAL_V1,
        transactionId: randomUUID(),
        sourceRoot: normalizedInput.sourceRoot,
        rollHome: normalizedInput.rollHome,
        workspaceRoot,
        stagingRoot,
        plan,
        planDigest: planDigest(plan),
        normalizedRemote: validation.normalizedRemote,
        transportRemote: validation.transportRemote,
        ownership: validation.ownership,
        phase: "prepared",
        transfers: plan.mappings.map((mapping) => ({
          source: mapping.source,
          destination: mapping.destination,
          digest: mapping.digest,
          mode: transferMode(mapping, validation.ownership),
          state: "pending",
        })),
        startedAt: (deps.now ?? Date.now)(),
      };
      writeJournal(journalPath, journal);
      createBaseLayout(journal);
      deps.afterPhase?.("prepared");
    }
    if (journal.phase === "prepared") {
      createBaseLayout(journal);
      const repo = binding(journal);
      await ensureRepositoryCache({
        binding: repo,
        transportRemote: journal.transportRemote,
        rollHome: journal.rollHome,
        integrationRefspec: `+refs/heads/${repo.integrationBranch}:refs/remotes/origin/${repo.integrationBranch}`,
        onLockAcquired: () => deps.onLockAcquired?.("repository"),
      });
      journal = { ...journal, phase: "cache_ready" };
      writeJournal(journalPath, journal);
      deps.afterPhase?.("cache_ready");
    }
    if (journal.phase === "cache_ready") {
      journal = stageTransfers(journalPath, journal, deps);
      verifyStaged(journal, journal.stagingRoot);
      journal = { ...journal, phase: "content_ready" };
      writeJournal(journalPath, journal);
      deps.afterPhase?.("content_ready");
    }
    if (journal.phase === "content_ready") {
      verifyStaged(journal, journal.stagingRoot);
      mkdirSync(dirname(journal.workspaceRoot), { recursive: true });
      if (!existsSync(journal.workspaceRoot)) renameSync(journal.stagingRoot, journal.workspaceRoot);
      else if (existsSync(journal.stagingRoot)) throw new HistoricalWorkspaceMigrationError("destination_conflict", "Both staging and final Workspace roots exist");
      verifyStaged(journal, journal.workspaceRoot);
      journal = { ...journal, phase: "workspace_ready" };
      writeJournal(journalPath, journal);
      deps.afterPhase?.("workspace_ready");
    }
    const registry = new WorkspaceRegistry({ rollHome: journal.rollHome });
    if (journal.phase === "workspace_ready") {
      registry.register({ workspaceId: plan.workspaceId, root: journal.workspaceRoot });
      journal = { ...journal, phase: "registered" };
      writeJournal(journalPath, journal);
      deps.afterPhase?.("registered");
    }
    if (journal.phase === "registered") {
      registry.activate(plan.workspaceId);
      journal = { ...journal, phase: "activated" };
      writeJournal(journalPath, journal);
      deps.afterPhase?.("activated");
    }
    if (journal.phase === "activated") {
      journal = cleanupSource(journalPath, journal);
      atomicWrite(manifestPath(journal.workspaceRoot), `${JSON.stringify(baseManifest(journal, "active"), null, 2)}\n`);
      journal = { ...journal, phase: "cleanup_complete" };
      writeJournal(journalPath, journal);
      deps.afterPhase?.("cleanup_complete");
    }
    rmSync(journalPath, { force: true });
    return completedResult(journal, "migrated");
  } finally {
    releaseLock(lockPath);
  }
}

export async function applyHistoricalWorkspaceMigration(
  input: ApplyHistoricalWorkspaceMigrationInput,
  deps: HistoricalWorkspaceMigrationDeps = {},
): Promise<HistoricalWorkspaceMigrationResult> {
  const plan = parseHistoricalWorkspaceMigrationPlan(input.plan);
  try {
    return await withWorkspaceAuthorityLock({
      rollHome: resolve(input.rollHome),
      workspaceId: plan.workspaceId,
      operation: "migration",
      onAcquired: () => deps.onLockAcquired?.("authority"),
    }, () => applyHistoricalWorkspaceMigrationUnlocked(input, deps));
  } catch (error) {
    if (error instanceof WorkspaceAuthorityLockError) {
      throw new HistoricalWorkspaceMigrationError("concurrent_migration", "Workspace authority is locked by another metadata writer", { cause: error });
    }
    throw error;
  }
}

/** Roll back only a non-active migration transaction; shared cache data is preserved. */
function rollbackHistoricalWorkspaceMigrationUnlocked(
  input: ApplyHistoricalWorkspaceMigrationInput,
): RollbackHistoricalWorkspaceMigrationResult {
  const plan = parseHistoricalWorkspaceMigrationPlan(input.plan);
  const normalized = { ...input, sourceRoot: resolve(input.sourceRoot), rollHome: resolve(input.rollHome), plan };
  const journalPath = historicalWorkspaceMigrationJournalPath(normalized.rollHome, plan.workspaceId);
  if (readJournal(journalPath, normalized, plan) === null) return { outcome: "absent", workspaceId: plan.workspaceId };
  const lockPath = migrationLockPath(normalized.rollHome, plan.workspaceId);
  const lock = acquireLock(lockPath, process.pid, { cycleId: `workspace-migration:${plan.workspaceId}`, unparseableIsHeld: true });
  if (!lock.acquired) throw new HistoricalWorkspaceMigrationError("concurrent_migration", "Workspace migration is already running");
  try {
    const journal = readJournal(journalPath, normalized, plan);
    if (journal === null) return { outcome: "absent", workspaceId: plan.workspaceId };
    if (["registered", "activated", "cleanup_complete"].includes(journal.phase)) {
      throw new HistoricalWorkspaceMigrationError("rollback_blocked_active", "Registered migration must resume to completion instead of rolling back");
    }
    const contentRoot = journal.phase === "workspace_ready" ? journal.workspaceRoot : journal.stagingRoot;
    for (const transfer of [...journal.transfers].reverse()) {
      if (transfer.mode !== "move" || transfer.destination === null) continue;
      const source = child(join(journal.sourceRoot, ".roll"), transfer.source);
      const destination = child(contentRoot, transfer.destination);
      if (transfer.state === "pending" && existsSync(source)) {
        if (digestFile(source) !== transfer.digest) throw new HistoricalWorkspaceMigrationError("source_conflict", "Pending migration source changed and cannot be rolled back safely");
        if (existsSync(destination) && digestFile(destination) !== transfer.digest) {
          throw new HistoricalWorkspaceMigrationError("destination_conflict", "Pending migration destination changed and cannot be removed safely");
        }
        continue;
      }
      if (transfer.state === "pending" && !existsSync(destination)) {
        throw new HistoricalWorkspaceMigrationError("source_conflict", "Pending migration bytes are missing from both source and staging");
      }
      if (!existsSync(destination)) continue;
      if (digestFile(destination) !== transfer.digest) throw new HistoricalWorkspaceMigrationError("source_conflict", "Moved migration content changed and cannot be rolled back safely");
      mkdirSync(dirname(source), { recursive: true });
      if (existsSync(source)) throw new HistoricalWorkspaceMigrationError("source_conflict", "Original migration source path was recreated");
      renameSync(destination, source);
    }
    rmSync(journal.stagingRoot, { recursive: true, force: true });
    rmSync(journal.workspaceRoot, { recursive: true, force: true });
    rmSync(journalPath, { force: true });
    return { outcome: "rolled_back", workspaceId: plan.workspaceId };
  } finally {
    releaseLock(lockPath);
  }
}

export function rollbackHistoricalWorkspaceMigration(
  input: ApplyHistoricalWorkspaceMigrationInput,
): RollbackHistoricalWorkspaceMigrationResult {
  const plan = parseHistoricalWorkspaceMigrationPlan(input.plan);
  try {
    return withWorkspaceAuthorityLockSync({
      rollHome: resolve(input.rollHome),
      workspaceId: plan.workspaceId,
      operation: "migration",
    }, () => rollbackHistoricalWorkspaceMigrationUnlocked(input));
  } catch (error) {
    if (error instanceof WorkspaceAuthorityLockError) {
      throw new HistoricalWorkspaceMigrationError("concurrent_migration", "Workspace authority is locked by another metadata writer", { cause: error });
    }
    throw error;
  }
}
