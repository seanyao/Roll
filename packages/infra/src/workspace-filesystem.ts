import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildWorkspaceCreateApplyAuthorization,
  buildWorkspaceCreatePlan,
  renderDefaultWorkspaceAgentScope,
  validateWorkspaceCreateApplyAuthorization,
  type WorkspaceCreateConfig,
  type WorkspaceCreatePlan,
  type WorkspaceCreatePlanStep,
  type WorkspaceCreateProbe,
  type WorkspaceCreateState,
} from "@roll/core";
import type { RepositoryBinding, WorkspaceCreateApplyAuthorizationV1 } from "@roll/spec";
import {
  ensureRepositoryCache,
  inspectRepositoryCache,
  type RepositoryCacheProbeState,
} from "./repository-cache.js";
import {
  WorkspaceRegistry,
  workspaceRegistryTransactionPath,
} from "./workspace-registry.js";
import { acquireLock, releaseLock } from "./process.js";

const JOURNAL_V1 = "roll.workspace-create-journal/v1" as const;
const LEGACY_JOURNAL_V1 = "roll.workspace-init-journal/v1" as const;

export class WorkspaceCreationError extends Error {
  constructor(
    readonly code: "rejected" | "concurrent_create" | "apply_failed" | "apply_authorization_required" | "apply_authorization_stale" | "legacy_create_recovery_required",
    message: string,
    readonly nextAction?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceCreationError";
  }
}

interface WorkspaceCreateDeps {
  readonly inspectCache?: (binding: RepositoryBinding, rollHome: string) => Promise<RepositoryCacheProbeState>;
  readonly ensureCache?: (binding: RepositoryBinding, rollHome: string) => Promise<{ readonly action: "created" | "reused" | "repaired" }>;
  readonly afterStep?: (step: WorkspaceCreatePlanStep) => void;
  readonly renameFile?: (from: string, to: string) => void;
  readonly authorization?: WorkspaceCreateApplyAuthorizationV1;
}

interface CreatedNode {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly digest?: string;
}

interface CreateJournal {
  readonly schema: typeof JOURNAL_V1;
  readonly transactionId: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly configDigest: string;
  readonly status: "applying" | "repair_required";
  readonly created: readonly CreatedNode[];
  readonly preserved: readonly string[];
  readonly preservedCaches: readonly string[];
}

interface LegacyCreateJournal {
  readonly schema: typeof LEGACY_JOURNAL_V1;
  readonly transactionId: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly configDigest: string;
  readonly status: "applying" | "repair_required";
  readonly created: readonly CreatedNode[];
  readonly preserved: readonly string[];
  readonly preservedCaches: readonly string[];
}

type ParsedJournal<T> =
  | { readonly state: "absent" }
  | { readonly state: "valid"; readonly value: T; readonly path: string }
  | { readonly state: "conflict"; readonly path: string };

export function workspaceCreateJournalPath(rollHome: string, workspaceId: string): string {
  return join(resolve(rollHome), "workspace-create", `${workspaceId}.pending.json`);
}

export function workspaceLegacyCreateJournalPath(rollHome: string, workspaceId: string): string {
  return join(resolve(rollHome), "workspace-init", `${workspaceId}.pending.json`);
}

export function workspaceCreateLockPath(rollHome: string, workspaceId: string): string {
  void workspaceId;
  return join(resolve(rollHome), "locks", "workspace-create.lock");
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function manifestText(config: WorkspaceCreateConfig): string {
  return `${JSON.stringify(config.manifest, null, 2)}\n`;
}

function expectedFiles(config: WorkspaceCreateConfig): Readonly<Record<string, string>> {
  return {
    [join(config.root, "workspace.yaml")]: manifestText(config),
    [join(config.root, "charter.md")]: `# ${config.manifest.displayName}\n\nWorkspace charter.\n`,
    [join(config.root, "agents.yaml")]: renderDefaultWorkspaceAgentScope(),
    [join(config.root, "policy.yaml")]: "schema: roll.workspace-policy/v1\n",
    [join(config.root, "backlog", "index.md")]: "# Backlog\n",
  };
}

function atomicWrite(path: string, text: string, renameFile: (from: string, to: string) => void = renameSync): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    renameFile(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function configDigest(config: WorkspaceCreateConfig): string {
  return digest(JSON.stringify({ workspaceId: config.workspaceId, root: config.root, manifest: config.manifest }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function parseCreatedNodes(value: unknown): readonly CreatedNode[] | null {
  if (!Array.isArray(value)) return null;
  const nodes: CreatedNode[] = [];
  const paths = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !exactKeys(candidate, ["path", "kind", "digest"]) ||
      typeof candidate["path"] !== "string" || !isAbsolute(candidate["path"]) || resolve(candidate["path"]) !== candidate["path"] ||
      (candidate["kind"] !== "file" && candidate["kind"] !== "directory") ||
      (candidate["digest"] !== undefined && (typeof candidate["digest"] !== "string" || !/^[0-9a-f]{64}$/u.test(candidate["digest"]))) ||
      (candidate["kind"] === "file" && candidate["digest"] === undefined) ||
      (candidate["kind"] === "directory" && candidate["digest"] !== undefined) || paths.has(candidate["path"])) {
      return null;
    }
    paths.add(candidate["path"]);
    nodes.push({
      path: candidate["path"],
      kind: candidate["kind"],
      ...(candidate["digest"] === undefined ? {} : { digest: candidate["digest"] }),
    });
  }
  return nodes;
}

function parseStringArray(value: unknown, allowed: (entry: string) => boolean): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "" || seen.has(entry) || !allowed(entry)) return null;
    seen.add(entry);
    entries.push(entry);
  }
  return entries;
}

function parsePreservedPaths(value: unknown, created: readonly CreatedNode[]): readonly string[] | null {
  const createdPaths = new Set(created.map((node) => node.path));
  return parseStringArray(value, (entry) =>
    isAbsolute(entry) && resolve(entry) === entry && createdPaths.has(entry));
}

function parsePreservedCaches(value: unknown, config: WorkspaceCreateConfig): readonly string[] | null {
  const repositoryIds = new Set(config.manifest.repositories.map((repository) => repository.repoId));
  return parseStringArray(value, (entry) => repositoryIds.has(entry));
}

function readCreateJournal(config: WorkspaceCreateConfig): ParsedJournal<CreateJournal> {
  const path = workspaceCreateJournalPath(config.rollHome, config.workspaceId);
  if (!existsSync(path)) return { state: "absent" };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(value) || !exactKeys(value, ["schema", "transactionId", "workspaceId", "root", "configDigest", "status", "created", "preserved", "preservedCaches"]) ||
      value["schema"] !== JOURNAL_V1 || typeof value["transactionId"] !== "string" || value["transactionId"] === "" ||
      value["workspaceId"] !== config.workspaceId || value["root"] !== config.root || value["configDigest"] !== configDigest(config) ||
      (value["status"] !== "applying" && value["status"] !== "repair_required")) return { state: "conflict", path };
    const created = parseCreatedNodes(value["created"]);
    const preserved = created === null ? null : parsePreservedPaths(value["preserved"], created);
    const preservedCaches = parsePreservedCaches(value["preservedCaches"], config);
    if (created === null || !createdNodesAllowed(config, created) || preserved === null || preservedCaches === null) {
      return { state: "conflict", path };
    }
    return {
      state: "valid",
      path,
      value: {
        schema: JOURNAL_V1,
        transactionId: value["transactionId"],
        workspaceId: config.workspaceId,
        root: config.root,
        configDigest: value["configDigest"],
        status: value["status"],
        created,
        preserved,
        preservedCaches,
      },
    };
  } catch {
    return { state: "conflict", path };
  }
}

function readLegacyJournal(config: WorkspaceCreateConfig): ParsedJournal<LegacyCreateJournal> {
  const path = workspaceLegacyCreateJournalPath(config.rollHome, config.workspaceId);
  if (!existsSync(path)) return { state: "absent" };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(value) || !exactKeys(value, ["schema", "transactionId", "workspaceId", "root", "configDigest", "status", "created", "preserved", "preservedCaches"]) ||
      value["schema"] !== LEGACY_JOURNAL_V1 || typeof value["transactionId"] !== "string" || value["transactionId"] === "" ||
      value["workspaceId"] !== config.workspaceId || value["root"] !== config.root || value["configDigest"] !== configDigest(config) ||
      (value["status"] !== "applying" && value["status"] !== "repair_required")) return { state: "conflict", path };
    const created = parseCreatedNodes(value["created"]);
    const preserved = created === null ? null : parsePreservedPaths(value["preserved"], created);
    const preservedCaches = parsePreservedCaches(value["preservedCaches"], config);
    if (created === null || preserved === null || preservedCaches === null) return { state: "conflict", path };
    return {
      state: "valid",
      path,
      value: {
        schema: LEGACY_JOURNAL_V1,
        transactionId: value["transactionId"],
        workspaceId: config.workspaceId,
        root: config.root,
        configDigest: value["configDigest"],
        status: value["status"],
        created,
        preserved,
        preservedCaches,
      },
    };
  } catch {
    return { state: "conflict", path };
  }
}

function nodeState(path: string, expectedKind: "file" | "directory", expectedText: string | undefined, repairable: boolean): WorkspaceCreateState {
  if (!existsSync(path)) return repairable ? "repairable" : "absent";
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return "conflict";
  if (expectedKind === "directory") return stat.isDirectory() ? "compatible" : "conflict";
  if (!stat.isFile()) return "conflict";
  return readFileSync(path, "utf8") === expectedText ? "compatible" : "conflict";
}

function registryState(config: WorkspaceCreateConfig): WorkspaceCreateState {
  if (existsSync(workspaceRegistryTransactionPath(config.rollHome))) return "conflict";
  try {
    const snapshot = new WorkspaceRegistry({ rollHome: config.rollHome }).read();
    const canonicalRoot = canonicalProspectivePath(config.root);
    const byId = snapshot.entries.find((entry) => entry.workspaceId === config.workspaceId);
    const byPath = snapshot.entries.find((entry) => entry.root === config.root || entry.canonicalRoot === canonicalRoot);
    if (byId === undefined && byPath === undefined) return "absent";
    if (byId?.root === config.root && byId.canonicalRoot === canonicalRoot &&
      (byPath === undefined || byPath.workspaceId === config.workspaceId)) return "compatible";
    return "conflict";
  } catch {
    return "conflict";
  }
}

function canonicalProspectivePath(path: string): string {
  const suffix: string[] = [];
  let cursor = resolve(path);
  for (;;) {
    try {
      return resolve(realpathSync(cursor), ...suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function hasCanonicalPathConflict(config: WorkspaceCreateConfig): boolean {
  const root = canonicalProspectivePath(config.root);
  const reposRoot = canonicalProspectivePath(join(config.rollHome, "repos"));
  return contains(root, reposRoot) || contains(reposRoot, root);
}

function createdDirectoryAllowed(config: WorkspaceCreateConfig, path: string): boolean {
  const plannedDirectories = new Set(buildWorkspaceCreatePlan(config, {
    paths: {},
    caches: {},
    registry: { state: "absent" },
    journal: { state: "absent" },
  }).steps.filter((step) => step.kind === "directory").map((step) => step.target));
  if (plannedDirectories.has(path)) return true;
  return contains(config.rollHome, path) && contains(path, config.root);
}

function createdNodesAllowed(config: WorkspaceCreateConfig, nodes: readonly CreatedNode[]): boolean {
  const files = expectedFiles(config);
  return nodes.every((node) => node.kind === "file"
    ? files[node.path] !== undefined
    : createdDirectoryAllowed(config, node.path));
}

function legacyCreatedNodesMatch(
  config: WorkspaceCreateConfig,
  journal: LegacyCreateJournal,
  requirePresent: boolean,
): boolean {
  if (!createdNodesAllowed(config, journal.created)) return false;
  for (const node of journal.created) {
    if (!existsSync(node.path)) {
      if (requirePresent) return false;
      continue;
    }
    const stat = lstatSync(node.path);
    if (stat.isSymbolicLink()) return false;
    if (node.kind === "directory") {
      if (!stat.isDirectory()) return false;
      continue;
    }
    if (!stat.isFile() || node.digest === undefined || digest(readFileSync(node.path, "utf8")) !== node.digest) return false;
  }
  return true;
}

function legacyRollbackSafe(config: WorkspaceCreateConfig, journal: LegacyCreateJournal): boolean {
  if (!legacyCreatedNodesMatch(config, journal, false)) return false;
  const rollbackNodes = journal.created.filter((node) => contains(config.root, node.path));
  const createdPaths = new Set(rollbackNodes.map((node) => node.path));
  for (const node of rollbackNodes) {
    if (node.kind !== "directory" || !existsSync(node.path)) continue;
    for (const entry of readdirSync(node.path)) {
      if (!createdPaths.has(join(node.path, entry))) return false;
    }
  }
  return true;
}

function legacyRollbackNodes(config: WorkspaceCreateConfig, journal: LegacyCreateJournal): readonly CreatedNode[] {
  return journal.created
    .filter((node) => contains(config.root, node.path))
    .slice()
    .sort((left, right) => {
      const depth = left.path.split(sep).length - right.path.split(sep).length;
      if (depth !== 0) return depth;
      return left.path.localeCompare(right.path, "en");
    });
}

function classifyJournal(
  config: WorkspaceCreateConfig,
  createJournal: ParsedJournal<CreateJournal>,
  legacyJournal: ParsedJournal<LegacyCreateJournal>,
  pathProbe: Readonly<Record<string, WorkspaceCreateState>>,
  caches: Readonly<Record<string, WorkspaceCreateState>>,
  registry: WorkspaceCreateState,
): WorkspaceCreateProbe["journal"] {
  const recoveryNextAction = `roll workspace doctor ${config.workspaceId} --json`;
  if (createJournal.state !== "absent" && legacyJournal.state !== "absent") {
    const journalPath = legacyJournal.path;
    return {
      state: "conflict",
      target: journalPath,
      recovery: { kind: "journal_conflict", journalPath, nextAction: recoveryNextAction },
    };
  }
  if (createJournal.state === "conflict") return { state: "conflict", target: createJournal.path };
  if (createJournal.state === "valid") return { state: "repairable", target: createJournal.path };
  if (legacyJournal.state === "conflict") {
    return {
      state: "conflict",
      target: legacyJournal.path,
      recovery: { kind: "legacy_recovery_required", journalPath: legacyJournal.path, nextAction: recoveryNextAction },
    };
  }
  if (legacyJournal.state === "absent") return { state: "absent" };
  if (legacyJournal.value.preserved.length > 0) {
    return {
      state: "conflict",
      target: legacyJournal.path,
      recovery: { kind: "legacy_recovery_required", journalPath: legacyJournal.path, nextAction: recoveryNextAction },
    };
  }

  const layoutCompatible = Object.values(pathProbe).every((state) => state === "compatible");
  const cachesCompatible = Object.values(caches).every((state) => state === "compatible");
  if (registry === "compatible" && layoutCompatible && cachesCompatible &&
    legacyCreatedNodesMatch(config, legacyJournal.value, true)) {
    return {
      state: "repairable",
      target: legacyJournal.path,
      recovery: { kind: "legacy_completed", journalPath: legacyJournal.path },
    };
  }

  const cachesRecoverable = Object.values(caches).every((state) => state !== "conflict");
  if (registry === "absent" && cachesRecoverable && legacyRollbackSafe(config, legacyJournal.value)) {
    return {
      state: "repairable",
      target: legacyJournal.path,
      recovery: { kind: "legacy_rollback", journalPath: legacyJournal.path },
    };
  }
  return {
    state: "conflict",
    target: legacyJournal.path,
    recovery: { kind: "legacy_recovery_required", journalPath: legacyJournal.path, nextAction: recoveryNextAction },
  };
}

export async function inspectWorkspaceCreation(
  config: WorkspaceCreateConfig,
  deps: Pick<WorkspaceCreateDeps, "inspectCache"> = {},
): Promise<WorkspaceCreatePlan> {
  const createJournal = readCreateJournal(config);
  const legacyJournal = readLegacyJournal(config);
  const journalPresent = createJournal.state !== "absent" || legacyJournal.state !== "absent";
  if (hasCanonicalPathConflict(config)) {
    const journal = classifyJournal(config, createJournal, legacyJournal, { [config.root]: "conflict" }, {}, registryState(config));
    return buildWorkspaceCreatePlan(config, {
      paths: { [config.root]: "conflict" },
      caches: {},
      registry: { state: registryState(config) },
      journal,
    });
  }
  const rootExists = existsSync(config.root);
  const repairable = journalPresent;
  if (rootExists) {
    const stat = lstatSync(config.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      const registry = registryState(config);
      const journal = classifyJournal(config, createJournal, legacyJournal, { [config.root]: "conflict" }, {}, registry);
      return buildWorkspaceCreatePlan(config, { paths: { [config.root]: "conflict" }, caches: {}, registry: { state: registry }, journal });
    }
  }
  const files = expectedFiles(config);
  const pathProbe: Record<string, WorkspaceCreateState> = {};
  const planned = buildWorkspaceCreatePlan(config, { paths: {}, caches: {}, registry: { state: "absent" }, journal: { state: "absent" } });
  for (const step of planned.steps) {
    if (step.kind !== "file" && step.kind !== "directory") continue;
    pathProbe[step.target] = nodeState(step.target, step.kind, files[step.target], rootExists && repairable);
  }
  if (rootExists && !repairable && pathProbe[join(config.root, "workspace.yaml")] !== "compatible") {
    pathProbe[config.root] = "conflict";
  }
  const inspectCache = deps.inspectCache ?? ((binding: RepositoryBinding, rollHome: string) => inspectRepositoryCache({ binding, rollHome }));
  const caches: Record<string, WorkspaceCreateState> = {};
  for (const binding of config.manifest.repositories) caches[binding.repoId] = await inspectCache(binding, config.rollHome);
  const registry = registryState(config);
  const journal = classifyJournal(config, createJournal, legacyJournal, pathProbe, caches, registry);
  if (journal.recovery?.kind === "legacy_rollback" && legacyJournal.state === "valid") {
    for (const node of legacyJournal.value.created) {
      if (pathProbe[node.path] !== undefined) pathProbe[node.path] = "repairable";
    }
  }
  const probe: WorkspaceCreateProbe = { paths: pathProbe, caches, registry: { state: registry }, journal };
  return buildWorkspaceCreatePlan(config, probe);
}

function journalText(journal: CreateJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function rollback(created: readonly CreatedNode[]): readonly string[] {
  const preserved: string[] = [];
  for (const node of [...created].reverse()) {
    if (!existsSync(node.path)) continue;
    if (node.kind === "file") {
      const stat = lstatSync(node.path);
      if (!stat.isFile() || stat.isSymbolicLink() || digest(readFileSync(node.path, "utf8")) !== node.digest) {
        preserved.push(node.path);
        continue;
      }
      rmSync(node.path, { force: true });
      continue;
    }
    const stat = lstatSync(node.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(node.path).length > 0) {
      preserved.push(node.path);
      continue;
    }
    rmSync(node.path, { recursive: true, force: true });
  }
  return preserved.sort();
}

function mkdirTracked(path: string, created: CreatedNode[]): void {
  if (existsSync(path)) return;
  const missing: string[] = [];
  let cursor = path;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync(path, { recursive: true });
  for (const target of missing.reverse()) created.push({ path: target, kind: "directory" });
}

export async function applyWorkspaceCreation(
  config: WorkspaceCreateConfig,
  deps: WorkspaceCreateDeps = {},
): Promise<{
  readonly outcome: WorkspaceCreatePlan["outcome"];
  readonly plan: WorkspaceCreatePlan;
  readonly authorization: WorkspaceCreateApplyAuthorizationV1;
}> {
  const initialPlan = await inspectWorkspaceCreation(config, deps);
  if (initialPlan.outcome === "rejected") {
    if (initialPlan.recovery !== undefined) {
      throw new WorkspaceCreationError("legacy_create_recovery_required", "Legacy Workspace create recovery requires doctor", initialPlan.recovery.nextAction);
    }
    throw new WorkspaceCreationError("rejected", "Workspace creation plan was rejected");
  }
  const authorization = deps.authorization ?? buildWorkspaceCreateApplyAuthorization(initialPlan, "direct_cli_apply");
  const initialAuthorization = validateWorkspaceCreateApplyAuthorization(initialPlan, authorization);
  if (!initialAuthorization.ok) {
    throw new WorkspaceCreationError(initialAuthorization.code, "Workspace create apply authorization does not match the current preview", initialAuthorization.nextAction);
  }
  const lockPath = workspaceCreateLockPath(config.rollHome, config.workspaceId);
  const lock = acquireLock(lockPath, process.pid, {
    cycleId: `workspace-create:${config.workspaceId}`,
    unparseableIsHeld: true,
  });
  if (!lock.acquired) {
    throw new WorkspaceCreationError("concurrent_create", `Workspace creation is already running for ${config.workspaceId}`);
  }
  try {
    const plan = await inspectWorkspaceCreation(config, deps);
    if (plan.outcome === "rejected") {
      if (plan.recovery !== undefined) {
        throw new WorkspaceCreationError("legacy_create_recovery_required", "Legacy Workspace create recovery requires doctor", plan.recovery.nextAction);
      }
      throw new WorkspaceCreationError("rejected", "Workspace creation plan was rejected");
    }
    const lockedAuthorization = validateWorkspaceCreateApplyAuthorization(plan, authorization);
    if (!lockedAuthorization.ok) {
      throw new WorkspaceCreationError(lockedAuthorization.code, "Workspace create apply authorization became stale", lockedAuthorization.nextAction);
    }
    if (plan.recovery?.kind === "legacy_completed") {
      const legacy = readLegacyJournal(config);
      if (legacy.state !== "valid" || legacy.path !== plan.recovery.journalPath) {
        throw new WorkspaceCreationError("legacy_create_recovery_required", "Legacy Workspace create recovery facts changed", `roll workspace doctor ${config.workspaceId} --json`);
      }
      rmSync(legacy.path, { force: true });
      return { outcome: plan.outcome, plan, authorization };
    }
    if (plan.recovery?.kind === "legacy_rollback") {
      const legacy = readLegacyJournal(config);
      if (legacy.state !== "valid" || legacy.path !== plan.recovery.journalPath || !legacyRollbackSafe(config, legacy.value)) {
        throw new WorkspaceCreationError("legacy_create_recovery_required", "Legacy Workspace create residue is no longer safe to roll back", `roll workspace doctor ${config.workspaceId} --json`);
      }
      const preserved = rollback(legacyRollbackNodes(config, legacy.value));
      if (preserved.length > 0) {
        throw new WorkspaceCreationError("legacy_create_recovery_required", "Legacy Workspace create residue changed during rollback", `roll workspace doctor ${config.workspaceId} --json`);
      }
      rmSync(legacy.path, { force: true });
    }
    const journalPath = workspaceCreateJournalPath(config.rollHome, config.workspaceId);
    const created: CreatedNode[] = [];
    const preservedCaches: string[] = [];
    let registered = false;
    let journal: CreateJournal = {
      schema: JOURNAL_V1,
      transactionId: randomUUID(),
      workspaceId: config.workspaceId,
      root: config.root,
      configDigest: configDigest(config),
      status: "applying",
      created,
      preserved: [],
      preservedCaches,
    };
    atomicWrite(journalPath, journalText(journal), deps.renameFile);
    const files = expectedFiles(config);
    const ensureCache = deps.ensureCache ?? (async (binding: RepositoryBinding, rollHome: string) => {
      const branch = binding.integrationBranch;
      return ensureRepositoryCache({
        binding,
        rollHome,
        integrationRefspec: `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      });
    });
    try {
      for (const step of plan.steps) {
        if (step.kind === "journal" || step.kind === "registry") continue;
        if (step.action === "reused" && step.kind !== "cache") continue;
        if (step.kind === "directory") {
          if (!existsSync(step.target)) mkdirTracked(step.target, created);
        } else if (step.kind === "file") {
          const text = files[step.target];
          if (text === undefined) throw new WorkspaceCreationError("apply_failed", `No content contract for ${step.target}`);
          if (!existsSync(step.target)) {
            atomicWrite(step.target, text, deps.renameFile);
            created.push({ path: step.target, kind: "file", digest: digest(text) });
          }
        } else if (step.kind === "cache") {
          const binding = config.manifest.repositories.find((entry) => entry.repoId === step.target);
          if (binding === undefined) throw new WorkspaceCreationError("apply_failed", `Missing binding ${step.target}`);
          const result = await ensureCache(binding, config.rollHome);
          if (result.action === "created") preservedCaches.push(binding.repoId);
        }
        journal = { ...journal, created: [...created], preservedCaches: [...preservedCaches] };
        atomicWrite(journalPath, journalText(journal), deps.renameFile);
        deps.afterStep?.(step);
      }
      const registry = new WorkspaceRegistry({ rollHome: config.rollHome });
      registry.register({ workspaceId: config.workspaceId, root: config.root });
      registered = true;
      deps.afterStep?.(plan.steps.at(-1) as WorkspaceCreatePlanStep);
      rmSync(journalPath, { force: true });
      return { outcome: plan.outcome, plan, authorization };
    } catch (error) {
      const preserved = registered ? created.map((node) => node.path).sort() : rollback(created);
      journal = { ...journal, status: "repair_required", created: [...created], preserved, preservedCaches: [...preservedCaches] };
      atomicWrite(journalPath, journalText(journal), deps.renameFile);
      throw error;
    }
  } finally {
    releaseLock(lockPath);
  }
}
