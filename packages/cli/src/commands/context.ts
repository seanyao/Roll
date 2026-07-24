import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  EventBus,
  createContextReadService,
  resolveWorkspaceTarget,
  validateStoryId,
  verifyContextSnapshot,
  type ContextReadService,
  type WorkspaceTargetFailureCode,
} from "@roll/core";
import {
  WorkspaceRegistry,
  createContextReadAdapter,
  readContextSnapshot,
  writeContextSnapshot,
  type GitLlmWikiReadAuditEventV1,
} from "@roll/infra";
import { isCanonicalWorkspaceSelectorToken } from "../lib/workspace-selector.js";
import {
  CONTEXT_PROVIDER_REGISTRY_V1,
  CONTEXT_READ_REQUEST_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  parseContextProviderRegistry,
  parseIssueManifest,
  parseWorkspaceManifest,
  resolveLang,
  t,
  v3Catalog,
  type ContextDiagnosticCode,
  type ContextProviderRegistryV1,
  type ContextReadFileV1,
  type ContextReadRequestV1,
  type ContextReadResultV1,
  type ContextStage,
  type Lang,
  type RollEvent,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import {
  inspectWorkspaceCwd,
  workspaceRegistryCandidates,
  workspaceRollHome,
  workspaceTargetSelector,
} from "./workspace-target.js";

const CONTEXT_STATUS_V1 = "roll.context-status/v1" as const;
const CONTEXT_COMMAND_ERROR_V1 = "roll.context-command-error/v1" as const;
const CONTEXT_STAGES = new Set<ContextStage>([
  "clarify",
  "design",
  "tasking",
  "build",
  "qa",
  "review",
  "fix",
  "operation",
]);

type ContextCommandErrorCode =
  | WorkspaceTargetFailureCode
  | "invalid_arguments"
  | "invalid_registry"
  | "invalid_workspace"
  | "story_conflict"
  | "snapshot_failure"
  | "read_failure";

export type ContextCommandAuditEventV1 = Extract<RollEvent, { readonly type: "context:read" }>;

export interface ContextReadServiceFactoryInput {
  readonly workspace: WorkspaceExecutionContextV1;
  readonly registry: ContextProviderRegistryV1;
  readonly authorizeRestrictedReference: (file: ContextReadFileV1) => boolean;
  readonly audit: (event: GitLlmWikiReadAuditEventV1) => void;
}

export type ContextTargetDecision =
  | { readonly workspace: WorkspaceExecutionContextV1; readonly issueStoryId?: string }
  | { readonly error: { readonly code: ContextCommandErrorCode } };

export interface ContextCommandDeps {
  readonly resolveTarget: (workspace: string | undefined) => Promise<ContextTargetDecision>;
  readonly readRegistry: () => ContextProviderRegistryV1;
  readonly readLatestSnapshot: (workspace: WorkspaceExecutionContextV1) => ContextReadResultV1 | undefined;
  readonly createReadService: (input: ContextReadServiceFactoryInput) => ContextReadService;
  readonly authorizeRestrictedReference: (request: ContextReadRequestV1, file: ContextReadFileV1) => boolean;
  readonly writeSnapshot: (workspace: WorkspaceExecutionContextV1, result: ContextReadResultV1) => void;
  readonly recordAudit: (event: ContextCommandAuditEventV1, workspace: WorkspaceExecutionContextV1) => void;
  readonly now: () => number;
}

export interface ContextCommandRuntimeOptions {
  readonly rollHome?: string;
  readonly cwd?: () => string;
  readonly now?: () => number;
  readonly createReadService?: ContextCommandDeps["createReadService"];
  readonly authorizeRestrictedReference?: ContextCommandDeps["authorizeRestrictedReference"];
  readonly writeSnapshot?: ContextCommandDeps["writeSnapshot"];
  readonly recordAudit?: ContextCommandDeps["recordAudit"];
}

interface ParsedStatusArgs {
  readonly kind: "status";
  readonly workspace?: string;
  readonly json: boolean;
}

interface ParsedReadArgs {
  readonly kind: "read";
  readonly workspace?: string;
  readonly story?: string;
  readonly stage: ContextStage;
  readonly environments: readonly string[];
  readonly refs: readonly string[];
  readonly includeNonActive: boolean;
  readonly allowRestricted: boolean;
  readonly json: boolean;
}

type ParsedContextArgs = ParsedStatusArgs | ParsedReadArgs | {
  readonly kind: "help";
  readonly command?: "status" | "read";
};

interface ContextStatusV1 {
  readonly schema: typeof CONTEXT_STATUS_V1;
  readonly workspace: {
    readonly workspaceId: string;
    readonly root: string;
    readonly lifecycle: string;
  };
  readonly freshness: {
    readonly source: "local_only";
    readonly fetched: false;
    readonly remoteFreshnessProof: false;
  };
  readonly registry: {
    readonly enabled: boolean;
    readonly providers: readonly {
      readonly providerId: string;
      readonly enabled: boolean;
      readonly branch: string;
    }[];
  };
  readonly binding: {
    readonly enabled: boolean;
    readonly providers: readonly {
      readonly providerId: string;
      readonly enabled: boolean;
      readonly required: boolean;
      readonly entrypoints: readonly string[];
    }[];
  };
  readonly latestSnapshot?: {
    readonly snapshotId: string;
    readonly snapshotDigest: string;
    readonly createdAt: string;
    readonly outcome: ContextReadResultV1["outcome"];
    readonly requestScope: ContextReadResultV1["requestScope"];
    readonly providers: readonly {
      readonly providerId: string;
      readonly branch: string;
      readonly revision: string;
      readonly bytes: number;
      readonly diagnosticCodes: readonly ContextDiagnosticCode[];
    }[];
    readonly diagnosticCodes: readonly ContextDiagnosticCode[];
  };
}

function language(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

function message(key: string, ...args: ReadonlyArray<string | number>): string {
  return t(v3Catalog, language(), key, ...args);
}

export function contextUsage(command?: "status" | "read"): string {
  if (command === "status") return message("context.status.usage");
  if (command === "read") return message("context.read.usage");
  return message("context.usage");
}

function scalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "[]") return [];
  if (/^[0-9]+$/u.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error("invalid_registry");
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value === "" || /[\x00-\x1f\x7f]/u.test(value)) throw new Error("invalid_registry");
  return value;
}

function splitMapping(line: string): readonly [string, string] {
  const index = line.indexOf(":");
  if (index <= 0) throw new Error("invalid_registry");
  const key = line.slice(0, index).trim();
  if (!/^[a-z_]+$/u.test(key)) throw new Error("invalid_registry");
  return [key, line.slice(index + 1)];
}

/** Strict parser for the documented, intentionally tiny context-providers.yaml shape. */
function parseRegistryYaml(text: string): unknown {
  const root: Record<string, unknown> = {};
  const providers: Array<Record<string, unknown>> = [];
  let provider: Record<string, unknown> | undefined;
  let inProviders = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    if (/\t/u.test(rawLine) || rawLine.trimEnd() !== rawLine) throw new Error("invalid_registry");
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent === 0) {
      const [key, rawValue] = splitMapping(rawLine);
      if (Object.hasOwn(root, key)) throw new Error("invalid_registry");
      if (key === "providers") {
        inProviders = true;
        if (rawValue.trim() === "") root[key] = providers;
        else {
          const parsed = scalar(rawValue);
          if (Array.isArray(parsed)) root[key] = parsed;
          else throw new Error("invalid_registry");
        }
      } else {
        if (inProviders) throw new Error("invalid_registry");
        root[key] = scalar(rawValue);
      }
      continue;
    }
    if (!inProviders || indent !== 2 || !rawLine.startsWith("  - ")) {
      if (!inProviders || indent !== 4 || provider === undefined) throw new Error("invalid_registry");
      const [key, rawValue] = splitMapping(rawLine.trimStart());
      if (Object.hasOwn(provider, key)) throw new Error("invalid_registry");
      provider[key] = scalar(rawValue);
      continue;
    }
    provider = {};
    providers.push(provider);
    const first = rawLine.slice(4);
    const [key, rawValue] = splitMapping(first);
    provider[key] = scalar(rawValue);
  }
  return root;
}

function readRegistryFile(path: string): ContextProviderRegistryV1 {
  if (!existsSync(path)) return { schema: CONTEXT_PROVIDER_REGISTRY_V1, enabled: false, providers: [] };
  const text = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    value = parseRegistryYaml(text);
  }
  const parsed = parseContextProviderRegistry(value);
  if (!parsed.ok) throw new Error("invalid_registry");
  return parsed.value;
}

function flagValue(args: readonly string[], index: number): string | undefined {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function parseArgs(args: readonly string[]): ParsedContextArgs | undefined {
  if (args.length === 0 || args[0] === "help") return { kind: "help" };
  if (args.includes("--help") || args.includes("-h")) {
    const command = args[0] === "status" || args[0] === "read" ? args[0] : undefined;
    return command === undefined ? { kind: "help" } : { kind: "help", command };
  }
  const kind = args[0];
  if (kind !== "status" && kind !== "read") return undefined;
  let workspace: string | undefined;
  let story: string | undefined;
  let stage: ContextStage | undefined;
  const environments: string[] = [];
  const refs: string[] = [];
  let includeNonActive = false;
  let allowRestricted = false;
  let json = false;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (isCanonicalWorkspaceSelectorToken(arg) || arg === "--story" || arg === "--stage" || arg === "--environment" || arg === "--ref") {
      const value = flagValue(args, index);
      if (value === undefined) return undefined;
      if (arg !== "--environment" && arg !== "--ref" && seen.has(arg)) return undefined;
      seen.add(arg);
      if (isCanonicalWorkspaceSelectorToken(arg)) workspace = value;
      else if (arg === "--story") story = value;
      else if (arg === "--stage") {
        if (!CONTEXT_STAGES.has(value as ContextStage)) return undefined;
        stage = value as ContextStage;
      } else if (arg === "--environment") environments.push(value);
      else refs.push(value);
      index += 1;
      continue;
    }
    if (arg === "--include-non-active" || arg === "--allow-restricted" || arg === "--json") {
      if (seen.has(arg)) return undefined;
      seen.add(arg);
      if (arg === "--include-non-active") includeNonActive = true;
      else if (arg === "--allow-restricted") allowRestricted = true;
      else json = true;
      continue;
    }
    return undefined;
  }
  if (kind === "status") {
    if (story !== undefined || stage !== undefined || environments.length > 0 || refs.length > 0 || includeNonActive || allowRestricted) return undefined;
    return { kind, ...(workspace === undefined ? {} : { workspace }), json };
  }
  if (stage === undefined) return undefined;
  return {
    kind,
    ...(workspace === undefined ? {} : { workspace }),
    ...(story === undefined ? {} : { story }),
    stage,
    environments,
    refs,
    includeNonActive,
    allowRestricted,
    json,
  };
}

function issueStoryAtCwd(cwd: string, workspaceRoot: string, workspaceId: string): string | undefined {
  const rel = relative(workspaceRoot, realpathSync(cwd));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  const parts = rel.split(sep);
  if (parts[0] !== "issues" || parts[1] === undefined) return undefined;
  const manifestPath = join(workspaceRoot, "issues", parts[1], "manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = parseIssueManifest(JSON.parse(readFileSync(manifestPath, "utf8")), {
      workspaceId,
      storyId: parts[1],
    });
    return parsed.ok ? parsed.value.storyId : undefined;
  } catch {
    return undefined;
  }
}

function executionContext(
  root: string,
  canonicalRoot: string,
  lifecycle: WorkspaceExecutionContextV1["workspace"]["lifecycle"],
  source: WorkspaceExecutionContextV1["resolution"]["source"],
  storyId?: string,
): WorkspaceExecutionContextV1 {
  const parsed = parseWorkspaceManifest(JSON.parse(readFileSync(join(canonicalRoot, "workspace.yaml"), "utf8")));
  if (!parsed.ok) throw new Error("invalid_workspace");
  const scopedRoot = storyId === undefined ? canonicalRoot : join(canonicalRoot, "issues", storyId);
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: { workspaceId: parsed.value.workspaceId, root, canonicalRoot, lifecycle },
    resolution: { source, evidence: [] },
    bindings: parsed.value.repositories,
    ...(parsed.value.contexts === undefined ? {} : { contexts: parsed.value.contexts }),
    authorities: {
      backlog: join(canonicalRoot, "backlog", "index.md"),
      features: join(canonicalRoot, "features"),
      design: join(canonicalRoot, "design"),
      requirements: join(canonicalRoot, "requirements"),
      policy: join(canonicalRoot, "policy.yaml"),
      evidence: join(scopedRoot, "evidence"),
      toolDumps: join(scopedRoot, "artifacts", "tool-dumps"),
      events: join(canonicalRoot, "runtime", "events.ndjson"),
      runtime: join(canonicalRoot, "runtime"),
      locks: join(canonicalRoot, "runtime", "locks"),
    },
  };
}

async function resolveRealTarget(selector: string | undefined, cwd: string, rollHome: string): Promise<ContextTargetDecision> {
  try {
    const inspected = new WorkspaceRegistry({ rollHome }).inspect();
    const cwdInspection = inspectWorkspaceCwd(cwd, inspected);
    const decision = resolveWorkspaceTarget({
      operation: "read",
      registry: workspaceRegistryCandidates(inspected),
      ...(selector === undefined ? {} : { explicit: workspaceTargetSelector(selector) }),
      ...(process.env["ROLL_WORKSPACE"] === undefined ? {} : { environment: workspaceTargetSelector(process.env["ROLL_WORKSPACE"]!) }),
      context: {
        ...(cwdInspection.cwdManifest === undefined ? {} : { cwdManifest: cwdInspection.cwdManifest }),
        ...(cwdInspection.legacyProject === undefined ? {} : { legacyProject: true }),
      },
    });
    if (!decision.ok) return { error: { code: decision.error.code } };
    if (decision.target.kind !== "workspace") return { error: { code: "invalid_target" } };
    const resolvedTarget = decision.target;
    const entry = inspected.find((candidate) => candidate.workspaceId === resolvedTarget.workspaceId);
    if (entry === undefined) return { error: { code: "invalid_target" } };
    const issueStoryId = issueStoryAtCwd(cwd, entry.canonicalRoot, entry.workspaceId);
    const source = decision.source === "all" ? "explicit" : decision.source;
    const workspace = executionContext(entry.root, entry.canonicalRoot, entry.lifecycle, source, issueStoryId);
    return { workspace, ...(issueStoryId === undefined ? {} : { issueStoryId }) };
  } catch (error) {
    const code = error instanceof Error && error.message === "invalid_workspace" ? "invalid_workspace" : "invalid_target";
    return { error: { code } };
  }
}

function latestSnapshot(workspace: WorkspaceExecutionContextV1): ContextReadResultV1 | undefined {
  const root = join(workspace.authorities.runtime, "context");
  if (!existsSync(root)) return undefined;
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("snapshot_failure");
  const candidates: ContextReadResultV1[] = [];
  for (const scope of readdirSync(root, { withFileTypes: true })) {
    const scopePath = join(root, scope.name);
    if (!scope.isDirectory() || scope.isSymbolicLink()) throw new Error("snapshot_failure");
    for (const file of readdirSync(scopePath, { withFileTypes: true })) {
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".json")) throw new Error("snapshot_failure");
      const artifactPath = join(scopePath, file.name);
      const verification = verifyContextSnapshot(JSON.parse(readFileSync(artifactPath, "utf8")) as unknown);
      if (!verification.valid || verification.reference.artifactPath !== artifactPath) throw new Error("snapshot_failure");
      candidates.push(readContextSnapshot(workspace, verification.reference));
    }
  }
  return candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.snapshotId.localeCompare(left.snapshotId))[0];
}

function workspaceForStory(
  workspace: WorkspaceExecutionContextV1,
  storyId: string | undefined,
): WorkspaceExecutionContextV1 {
  if (storyId === undefined) return workspace;
  const issueRoot = join(workspace.workspace.canonicalRoot, "issues", storyId);
  return {
    ...workspace,
    authorities: {
      ...workspace.authorities,
      evidence: join(issueRoot, "evidence"),
      toolDumps: join(issueRoot, "artifacts", "tool-dumps"),
    },
  };
}

function canonicalStoryId(value: string): string | undefined {
  const normalized = value.trim().toUpperCase();
  const validated = validateStoryId(normalized);
  return validated.ok ? validated.value : undefined;
}

export function createContextCommandDeps(options: ContextCommandRuntimeOptions = {}): ContextCommandDeps {
  const rollHome = options.rollHome ?? workspaceRollHome();
  const cwd = options.cwd ?? process.cwd;
  const now = options.now ?? Date.now;
  return {
    resolveTarget: (selector) => resolveRealTarget(selector, cwd(), rollHome),
    readRegistry: () => readRegistryFile(join(rollHome, "context-providers.yaml")),
    readLatestSnapshot: latestSnapshot,
    createReadService: options.createReadService ?? ((input) => createContextReadService({
      registry: input.registry,
      adapter: createContextReadAdapter({ rollHome, now, audit: input.audit }),
      now,
      authorizeRestrictedReference: (_request, file) => input.authorizeRestrictedReference(file),
    })),
    authorizeRestrictedReference: options.authorizeRestrictedReference ?? (() => false),
    writeSnapshot: options.writeSnapshot ?? ((workspace, result) => { writeContextSnapshot(workspace, result); }),
    recordAudit: options.recordAudit ?? ((event, workspace) => { new EventBus().appendEvent(workspace.authorities.events, event); }),
    now,
  };
}

function errorMessage(code: ContextCommandErrorCode): string {
  const contextKey = `context.error.${code}`;
  if (Object.hasOwn(v3Catalog, contextKey)) return message(contextKey);
  const workspaceKey = `workspace.error.${code}`;
  if (Object.hasOwn(v3Catalog, workspaceKey)) return message(workspaceKey);
  return message("context.error.read_failure");
}

function emitError(code: ContextCommandErrorCode, json: boolean): number {
  const detail = errorMessage(code);
  if (json) {
    process.stderr.write(`${JSON.stringify({ schema: CONTEXT_COMMAND_ERROR_V1, code, message: detail })}\n`);
  } else {
    process.stderr.write(`${message("context.error.line", code, detail)}\n`);
  }
  return 2;
}

function snapshotSummary(snapshot: ContextReadResultV1): NonNullable<ContextStatusV1["latestSnapshot"]> {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshot.snapshotDigest,
    createdAt: snapshot.createdAt,
    outcome: snapshot.outcome,
    requestScope: snapshot.requestScope,
    providers: snapshot.providers.map((provider) => ({
      providerId: provider.providerId,
      branch: provider.branch,
      revision: provider.revision,
      bytes: provider.files.reduce((sum, file) => sum + file.bytes, 0),
      diagnosticCodes: provider.warnings.map((warning) => warning.code),
    })),
    diagnosticCodes: snapshot.gaps.map((gap) => gap.code),
  };
}

function statusValue(
  workspace: WorkspaceExecutionContextV1,
  registry: ContextProviderRegistryV1,
  snapshot: ContextReadResultV1 | undefined,
): ContextStatusV1 {
  const contexts = workspace.contexts;
  return {
    schema: CONTEXT_STATUS_V1,
    workspace: {
      workspaceId: workspace.workspace.workspaceId,
      root: workspace.workspace.canonicalRoot,
      lifecycle: workspace.workspace.lifecycle,
    },
    freshness: { source: "local_only", fetched: false, remoteFreshnessProof: false },
    registry: {
      enabled: registry.enabled,
      providers: registry.providers.map((provider) => ({
        providerId: provider.id,
        enabled: provider.enabled,
        branch: provider.branch,
      })),
    },
    binding: {
      enabled: contexts?.enabled ?? false,
      providers: (contexts?.bindings ?? []).map((binding) => ({ ...binding })),
    },
    ...(snapshot === undefined ? {} : { latestSnapshot: snapshotSummary(snapshot) }),
  };
}

function renderStatus(value: ContextStatusV1, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${message("context.status.title", value.workspace.workspaceId)}\n`);
  process.stdout.write(`${message("context.status.freshness")}\n`);
  process.stdout.write(`${message("context.status.registry", value.registry.enabled ? "enabled" : "disabled", value.registry.providers.length)}\n`);
  process.stdout.write(`${message("context.status.binding", value.binding.enabled ? "enabled" : "disabled", value.binding.providers.length)}\n`);
  if (value.latestSnapshot === undefined) process.stdout.write(`${message("context.status.none")}\n`);
  else process.stdout.write(`${message("context.status.latest", value.latestSnapshot.snapshotId, value.latestSnapshot.outcome, value.latestSnapshot.createdAt)}\n`);
}

function renderRead(result: ContextReadResultV1, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const story = result.requestScope.storyId ?? "-";
  const environments = result.requestScope.environmentIds.length === 0 ? "-" : result.requestScope.environmentIds.join(",");
  process.stdout.write(`${message("context.read.title", result.outcome)}\n`);
  process.stdout.write(`${message("context.read.scope", result.requestScope.workspaceId, story, result.requestScope.stage, environments)}\n`);
  process.stdout.write(`${message("context.read.snapshot", result.snapshotId, result.snapshotDigest)}\n`);
  if (result.providers.length === 0) process.stdout.write(`${message("context.read.none")}\n`);
  for (const provider of result.providers) {
    process.stdout.write(`${message("context.read.provider", provider.providerId, provider.branch, provider.revision)}\n`);
    for (const file of provider.files) {
      process.stdout.write(`${message("context.read.ref", file.ref, file.sha256, file.bytes)}\n`);
    }
    for (const warning of provider.warnings) {
      process.stdout.write(`${message("context.read.diagnostic", warning.code, warning.severity, warning.providerId ?? provider.providerId)}\n`);
    }
  }
  for (const gap of result.gaps) {
    process.stdout.write(`${message("context.read.diagnostic", gap.code, gap.severity, gap.providerId ?? "-")}\n`);
  }
}

function readExit(outcome: ContextReadResultV1["outcome"]): number {
  if (outcome === "partial") return 3;
  if (outcome === "blocked") return 2;
  return 0;
}

function stableCodes(codes: readonly ContextDiagnosticCode[]): readonly ContextDiagnosticCode[] {
  return [...new Set(codes)].sort();
}

function latestTransportAudit(
  events: readonly GitLlmWikiReadAuditEventV1[],
  providerId: string,
): GitLlmWikiReadAuditEventV1 | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.providerId === providerId) return event;
  }
  return undefined;
}

function auditEvents(
  result: ContextReadResultV1,
  registry: ContextProviderRegistryV1,
  transport: readonly GitLlmWikiReadAuditEventV1[],
  startedAtMs: number,
  finishedAtMs: number,
): readonly ContextCommandAuditEventV1[] {
  const providerIds = new Set<string>([
    ...result.providers.map((provider) => provider.providerId),
    ...result.gaps.flatMap((gap) => gap.providerId === undefined ? [] : [gap.providerId]),
    ...transport.map((event) => event.providerId),
  ]);
  return [...providerIds].sort().map((providerId) => {
    const provider = result.providers.find((entry) => entry.providerId === providerId);
    const providerConfig = registry.providers.find((entry) => entry.id === providerId);
    const transportEvent = latestTransportAudit(transport, providerId);
    const codes = stableCodes([
      ...(provider?.warnings.map((warning) => warning.code) ?? []),
      ...result.gaps.filter((gap) => gap.providerId === providerId).map((gap) => gap.code),
      ...(transportEvent?.diagnosticCode === undefined ? [] : [transportEvent.diagnosticCode]),
    ]);
    const fetchOutcome = transportEvent?.outcome ?? (provider === undefined ? "not_started" : "completed");
    const revision = provider?.revision ?? transportEvent?.revision;
    const bytes = provider?.files.reduce((sum, file) => sum + file.bytes, 0) ?? transportEvent?.bytes ?? 0;
    return {
      type: "context:read",
      workspaceId: result.requestScope.workspaceId,
      ...(result.requestScope.storyId === undefined ? {} : { storyId: result.requestScope.storyId }),
      providerId,
      branch: provider?.branch ?? providerConfig?.branch ?? "unknown",
      startedAt: transportEvent?.startedAt ?? new Date(startedAtMs).toISOString(),
      durationMs: transportEvent?.durationMs ?? Math.max(0, finishedAtMs - startedAtMs),
      fetchOutcome,
      ...(revision === undefined ? {} : { revision }),
      bytes,
      diagnosticCodes: codes,
      snapshotId: result.snapshotId,
      ts: finishedAtMs,
    };
  });
}

async function runStatus(args: ParsedStatusArgs, deps: ContextCommandDeps): Promise<number> {
  const target = await deps.resolveTarget(args.workspace);
  if ("error" in target) return emitError(target.error.code, args.json);
  try {
    const registry = deps.readRegistry();
    const snapshot = deps.readLatestSnapshot(target.workspace);
    renderStatus(statusValue(target.workspace, registry, snapshot), args.json);
    return 0;
  } catch (error) {
    return emitError(error instanceof Error && error.message === "invalid_registry" ? "invalid_registry" : "snapshot_failure", args.json);
  }
}

async function runRead(args: ParsedReadArgs, deps: ContextCommandDeps): Promise<number> {
  const target = await deps.resolveTarget(args.workspace);
  if ("error" in target) return emitError(target.error.code, args.json);
  const requestedStoryId = args.story === undefined ? undefined : canonicalStoryId(args.story);
  if (args.story !== undefined && requestedStoryId === undefined) return emitError("invalid_arguments", args.json);
  const issueStoryId = target.issueStoryId === undefined ? undefined : canonicalStoryId(target.issueStoryId);
  if (requestedStoryId !== undefined && issueStoryId !== undefined && requestedStoryId !== issueStoryId) {
    return emitError("story_conflict", args.json);
  }
  let registry: ContextProviderRegistryV1;
  try {
    registry = deps.readRegistry();
  } catch {
    return emitError("invalid_registry", args.json);
  }
  const storyId = requestedStoryId ?? issueStoryId;
  const scopedWorkspace = workspaceForStory(target.workspace, storyId);
  const request: ContextReadRequestV1 = {
    schema: CONTEXT_READ_REQUEST_V1,
    workspace: scopedWorkspace,
    ...(storyId === undefined ? {} : { storyId }),
    stage: args.stage,
    ...(args.environments.length === 0 ? {} : { environmentIds: args.environments }),
    refs: args.refs,
    ...(args.includeNonActive ? { includeNonActive: true } : {}),
    ...(args.allowRestricted ? { includeRestrictedReferences: true } : {}),
  };
  const transportAudit: GitLlmWikiReadAuditEventV1[] = [];
  const startedAt = deps.now();
  const service = deps.createReadService({
    workspace: scopedWorkspace,
    registry,
    authorizeRestrictedReference: (file) => deps.authorizeRestrictedReference(request, file),
    audit: (event) => { transportAudit.push(event); },
  });
  if (!args.json) process.stderr.write(`${message("context.read.progress")}\n`);
  let result: ContextReadResultV1;
  try {
    result = await service.read(request);
  } catch {
    return emitError("read_failure", args.json);
  }
  try {
    if (result.outcome !== "disabled") deps.writeSnapshot(scopedWorkspace, result);
  } catch {
    return emitError("snapshot_failure", args.json);
  }
  const finishedAt = deps.now();
  for (const event of auditEvents(result, registry, transportAudit, startedAt, finishedAt)) {
    try {
      deps.recordAudit(event, scopedWorkspace);
    } catch {
      // Audit persistence is observational and must not replace the primary
      // Context read/snapshot result.
    }
  }
  renderRead(result, args.json);
  return readExit(result.outcome);
}

export async function contextCommand(args: string[], deps: ContextCommandDeps = createContextCommandDeps()): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === undefined) return emitError("invalid_arguments", args.includes("--json"));
  if (parsed.kind === "help") {
    process.stdout.write(contextUsage(parsed.command));
    return 0;
  }
  return parsed.kind === "status" ? runStatus(parsed, deps) : runRead(parsed, deps);
}
