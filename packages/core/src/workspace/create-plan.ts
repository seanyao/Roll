import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_CREATE_APPLY_AUTHORIZATION_V1,
  WORKSPACE_MANIFEST_V1,
  parseRepositoryBinding,
  repositoryIdFromRemote,
  type ContractErrorCode,
  type RepositoryBinding,
  type RequirementSourceReference,
  type WorkspaceCreateApplyAuthorizationV1,
  type WorkspaceManifest,
} from "@roll/spec";

export const WORKSPACE_CREATE_CONFIG_V1 = "roll.workspace-create/v1" as const;

export interface WorkspaceCreateConfig {
  readonly schema: typeof WORKSPACE_CREATE_CONFIG_V1;
  readonly workspaceId: string;
  readonly root: string;
  readonly rollHome: string;
  readonly manifest: WorkspaceManifest;
}

export type WorkspaceCreateState = "absent" | "compatible" | "repairable" | "conflict";
export type WorkspaceCreateAction = "created" | "reused" | "repaired" | "rejected";

export interface WorkspaceCreateProbe {
  readonly paths: Readonly<Record<string, WorkspaceCreateState>>;
  readonly caches: Readonly<Record<string, WorkspaceCreateState>>;
  readonly registry: { readonly state: WorkspaceCreateState };
  readonly journal: {
    readonly state: "absent" | "repairable" | "conflict";
    readonly target?: string;
    readonly recovery?: WorkspaceCreateRecovery;
  };
}

export interface WorkspaceCreateRecovery {
  readonly kind: "legacy_completed" | "legacy_rollback" | "legacy_recovery_required" | "journal_conflict";
  readonly journalPath: string;
  readonly nextAction?: string;
}

export interface WorkspaceCreatePlanStep {
  readonly kind: "journal" | "directory" | "file" | "cache" | "registry";
  readonly target: string;
  readonly action: WorkspaceCreateAction;
}

export interface WorkspaceCreatePlan {
  readonly schema: "roll.workspace-create-plan/v1";
  readonly workspaceId: string;
  readonly root: string;
  readonly outcome: WorkspaceCreateAction;
  readonly configSha256: string;
  readonly planSha256: string;
  readonly recovery?: WorkspaceCreateRecovery;
  readonly steps: readonly WorkspaceCreatePlanStep[];
}

export type WorkspaceCreateApplyAuthorizationParseResult =
  | { readonly ok: true; readonly value: WorkspaceCreateApplyAuthorizationV1 }
  | { readonly ok: false; readonly code: "invalid_apply_authorization" };

export type WorkspaceCreateApplyAuthorizationValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "apply_authorization_required" | "apply_authorization_stale";
      readonly nextAction: string;
    };

export interface WorkspaceCreateParseError {
  readonly code: ContractErrorCode | "invalid_config" | "path_conflict" | "legacy_create_config";
  readonly path: string;
  readonly message: string;
  readonly conversions?: readonly {
    readonly path: string;
    readonly from: string;
    readonly to: string;
  }[];
  readonly nextAction?: string;
}

export type WorkspaceCreateParseResult =
  | { readonly ok: true; readonly value: WorkspaceCreateConfig }
  | { readonly ok: false; readonly errors: readonly WorkspaceCreateParseError[] };

export interface ParseWorkspaceCreateOptions {
  readonly workspaceId: string;
  readonly configPath: string;
  readonly homeDir: string;
  readonly rollHome: string;
}

interface RawRepository {
  alias?: unknown;
  source?: unknown;
  integration_branch?: unknown;
  provider?: unknown;
  branch_pattern?: unknown;
  required_checks?: unknown;
}

interface RawConfig {
  schema?: unknown;
  id?: unknown;
  root?: unknown;
  display_name?: unknown;
  created_at?: unknown;
  requirements?: unknown;
  repositories?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )) return trimmed.slice(1, -1);
  return trimmed;
}

function stripComment(value: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      quote = quote === null ? char : null;
      continue;
    }
    if (char === "#" && quote === null && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function parseScalar(value: string): unknown {
  const text = unquote(value);
  if (text.startsWith("[") && text.endsWith("]")) {
    const body = text.slice(1, -1).trim();
    if (body === "") return [];
    return body.split(",").map((item) => unquote(item));
  }
  return text;
}

function assignPair(target: Record<string, unknown>, text: string): void {
  const index = text.indexOf(":");
  if (index <= 0) throw new Error("invalid YAML mapping entry");
  const key = text.slice(0, index).trim();
  const value = text.slice(index + 1).trim();
  if (key === "" || value === "") throw new Error("empty YAML key or scalar");
  if (Object.hasOwn(target, key)) throw new Error(`duplicate YAML key: ${key}`);
  target[key] = parseScalar(value);
}

/** Parse only the closed roll.workspace-create/v1 YAML shape; JSON is accepted as YAML 1.2 input. */
function parseConfigDocument(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Continue with the dependency-free closed-shape YAML parser.
  }
  const root: Record<string, unknown> = {};
  let section: "requirements" | "repositories" | null = null;
  let item: Record<string, unknown> | null = null;
  for (const raw of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (raw.includes("\t")) throw new Error("tabs are not supported in Workspace create YAML");
    const line = stripComment(raw).trimEnd();
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();
    if (indent === 0) {
      item = null;
      const separator = body.indexOf(":");
      if (separator <= 0) throw new Error("invalid top-level YAML mapping");
      const key = body.slice(0, separator).trim();
      const value = body.slice(separator + 1).trim();
      if (key === "requirements" || key === "repositories") {
        if (value !== "") throw new Error(`${key} must be a block list`);
        if (Object.hasOwn(root, key)) throw new Error(`duplicate YAML key: ${key}`);
        root[key] = [];
        section = key;
      } else {
        section = null;
        if (value === "") throw new Error(`empty YAML scalar: ${key}`);
        if (Object.hasOwn(root, key)) throw new Error(`duplicate YAML key: ${key}`);
        root[key] = parseScalar(value);
      }
      continue;
    }
    if (section === null || indent < 2) throw new Error("unexpected YAML indentation");
    const list = root[section];
    if (!Array.isArray(list)) throw new Error("invalid YAML list state");
    if (body.startsWith("- ")) {
      if (indent !== 2) throw new Error("list items must use two-space indentation");
      item = {};
      list.push(item);
      assignPair(item, body.slice(2));
      continue;
    }
    if (indent !== 4 || item === null) throw new Error("list fields must use four-space indentation");
    assignPair(item, body);
  }
  return root;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allow = new Set(allowed);
  return Object.keys(value).filter((key) => !allow.has(key));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value === value.trim();
}

function safeWorkspaceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function resolveRoot(value: string, options: ParseWorkspaceCreateOptions): string {
  if (value === "~") return resolve(options.homeDir);
  if (value.startsWith("~/")) return resolve(options.homeDir, value.slice(2));
  return resolve(isAbsolute(value) ? value : join(dirname(options.configPath), value));
}

function parseRequirements(value: unknown, errors: WorkspaceCreateParseError[]): RequirementSourceReference[] {
  if (!Array.isArray(value)) {
    errors.push({ code: "invalid_type", path: "requirements", message: "requirements must be an array" });
    return [];
  }
  return value.flatMap((entry, index) => {
    if (!isRecord(entry) || exactKeys(entry, ["provider", "ref"]).length > 0 ||
      !nonEmptyString(entry["provider"]) || !nonEmptyString(entry["ref"])) {
      errors.push({ code: "invalid_value", path: `requirements[${index}]`, message: "requirement must contain provider and ref only" });
      return [];
    }
    return [{ provider: entry["provider"], ref: entry["ref"] }];
  });
}

function parseRepositories(value: unknown, errors: WorkspaceCreateParseError[]): RepositoryBinding[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ code: "invalid_type", path: "repositories", message: "repositories must be a non-empty array" });
    return [];
  }
  const repositories: RepositoryBinding[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index] as RawRepository;
    if (!isRecord(raw)) {
      errors.push({ code: "invalid_type", path: `repositories[${index}]`, message: "repository must be an object" });
      continue;
    }
    const unknown = exactKeys(raw, ["alias", "source", "integration_branch", "provider", "branch_pattern", "required_checks"]);
    if (unknown.length > 0) {
      errors.push({ code: "unknown_field", path: `repositories[${index}].${unknown[0]}`, message: "unknown repository field" });
      continue;
    }
    if (!nonEmptyString(raw.alias) || !nonEmptyString(raw.source) || !nonEmptyString(raw.integration_branch)) {
      errors.push({ code: "invalid_value", path: `repositories[${index}]`, message: "alias, source and integration_branch are required" });
      continue;
    }
    const repoId = repositoryIdFromRemote(raw.source);
    if (!repoId.ok) {
      errors.push(...repoId.errors.map((error) => ({ ...error, path: `repositories[${index}].source` })));
      continue;
    }
    const requiredChecks = raw.required_checks === undefined ? [] : raw.required_checks;
    if (!Array.isArray(requiredChecks) || !requiredChecks.every(nonEmptyString)) {
      errors.push({ code: "invalid_value", path: `repositories[${index}].required_checks`, message: "required_checks must be a string array" });
      continue;
    }
    const candidate = {
      schema: REPOSITORY_BINDING_V1,
      repoId: repoId.value,
      alias: raw.alias,
      remote: raw.source,
      integrationBranch: raw.integration_branch,
      provider: nonEmptyString(raw.provider) ? raw.provider : "generic",
      workflow: {
        branchPattern: nonEmptyString(raw.branch_pattern) ? raw.branch_pattern : "roll/{workspace_id}/{story_id}",
        requiredChecks,
      },
    } satisfies RepositoryBinding;
    const parsed = parseRepositoryBinding(candidate);
    if (!parsed.ok) {
      errors.push(...parsed.errors.map((error) => ({ ...error, path: `repositories[${index}].${error.path}` })));
      continue;
    }
    repositories.push(parsed.value);
  }
  return repositories;
}

export function parseWorkspaceCreateConfig(text: string, options: ParseWorkspaceCreateOptions): WorkspaceCreateParseResult {
  let value: unknown;
  try {
    value = parseConfigDocument(text);
  } catch (error) {
    return { ok: false, errors: [{ code: "invalid_config", path: "config", message: (error as Error).message }] };
  }
  if (!isRecord(value)) {
    return { ok: false, errors: [{ code: "invalid_type", path: "config", message: "config must be an object" }] };
  }
  const raw = value as RawConfig;
  if (raw.schema === "roll.workspace-init/v1") {
    return {
      ok: false,
      errors: [{
        code: "legacy_create_config",
        path: "schema",
        message: "Legacy Workspace init config must be converted before create",
        conversions: [{ path: "schema", from: "roll.workspace-init/v1", to: WORKSPACE_CREATE_CONFIG_V1 }],
        nextAction: `roll workspace create ${options.workspaceId} --config <converted-path>`,
      }],
    };
  }
  const errors: WorkspaceCreateParseError[] = [];
  const unknown = exactKeys(value, ["schema", "id", "root", "display_name", "created_at", "requirements", "repositories"]);
  if (unknown.length > 0) errors.push({ code: "unknown_field", path: unknown[0] ?? "config", message: "unknown config field" });
  if (raw.schema !== WORKSPACE_CREATE_CONFIG_V1) errors.push({ code: "unknown_version", path: "schema", message: `expected ${WORKSPACE_CREATE_CONFIG_V1}` });
  if (!nonEmptyString(raw.id)) errors.push({ code: "invalid_value", path: "id", message: "id is required" });
  else if (!safeWorkspaceId(raw.id)) {
    errors.push({ code: "invalid_value", path: "id", message: "Workspace ID contains unsafe characters" });
    return { ok: false, errors };
  } else if (raw.id !== options.workspaceId) errors.push({ code: "identity_mismatch", path: "id", message: "config ID must match the command ID" });
  if (!nonEmptyString(raw.root)) errors.push({ code: "invalid_value", path: "root", message: "root is required" });
  const root = nonEmptyString(raw.root) ? resolveRoot(raw.root, options) : resolve(options.homeDir, ".roll", "workspaces", options.workspaceId);
  const rollHome = resolve(options.rollHome);
  const reposRoot = resolve(rollHome, "repos");
  if (contains(root, reposRoot) || contains(reposRoot, root)) {
    errors.push({ code: "path_conflict", path: "root", message: "Workspace root and machine repository cache root must be disjoint" });
  }
  const requirements = parseRequirements(raw.requirements ?? [], errors);
  const repositories = parseRepositories(raw.repositories, errors);
  const aliases = new Set<string>();
  const repoIds = new Set<string>();
  const remotes = new Set<string>();
  for (const repository of repositories) {
    if (aliases.has(repository.alias) || repoIds.has(repository.repoId) || remotes.has(repository.remote)) {
      errors.push({ code: "duplicate_identity", path: "repositories", message: "repository alias, repoId and remote must be unique" });
      break;
    }
    aliases.add(repository.alias);
    repoIds.add(repository.repoId);
    remotes.add(repository.remote);
  }
  if (errors.length > 0) return { ok: false, errors };
  const workspaceId = raw.id as string;
  const manifest: WorkspaceManifest = {
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId,
    displayName: nonEmptyString(raw.display_name) ? raw.display_name : workspaceId,
    ...(nonEmptyString(raw.created_at) ? { createdAt: raw.created_at } : {}),
    requirements,
    repositories,
  };
  return { ok: true, value: { schema: WORKSPACE_CREATE_CONFIG_V1, workspaceId, root, rollHome, manifest } };
}

function action(state: WorkspaceCreateState): WorkspaceCreateAction {
  if (state === "absent") return "created";
  if (state === "compatible") return "reused";
  if (state === "repairable") return "repaired";
  return "rejected";
}

function layout(root: string): readonly { readonly kind: "directory" | "file"; readonly target: string }[] {
  return [
    { kind: "directory", target: root },
    { kind: "file", target: join(root, "workspace.yaml") },
    { kind: "file", target: join(root, "charter.md") },
    { kind: "file", target: join(root, "agents.yaml") },
    { kind: "file", target: join(root, "policy.yaml") },
    { kind: "directory", target: join(root, "requirements") },
    { kind: "directory", target: join(root, "design") },
    { kind: "directory", target: join(root, "backlog") },
    { kind: "file", target: join(root, "backlog", "index.md") },
    { kind: "directory", target: join(root, "issues") },
    { kind: "directory", target: join(root, "runtime") },
    { kind: "directory", target: join(root, "runtime", "locks") },
    { kind: "directory", target: join(root, "runtime", "heartbeats") },
    { kind: "directory", target: join(root, "runtime", "alerts") },
  ];
}

export function buildWorkspaceCreatePlan(config: WorkspaceCreateConfig, probe: WorkspaceCreateProbe): WorkspaceCreatePlan {
  const journalAction: WorkspaceCreateAction = probe.journal.state === "absent" ? "created" :
    probe.journal.state === "repairable" ? "repaired" : "rejected";
  const steps: WorkspaceCreatePlanStep[] = [{
    kind: "journal",
    target: probe.journal.target ?? join(config.rollHome, "workspace-create", `${config.workspaceId}.pending.json`),
    action: journalAction,
  }];
  for (const entry of layout(config.root)) {
    steps.push({ ...entry, action: action(probe.paths[entry.target] ?? "absent") });
  }
  for (const repository of config.manifest.repositories.slice().sort((left, right) => left.repoId.localeCompare(right.repoId, "en"))) {
    steps.push({ kind: "cache", target: repository.repoId, action: action(probe.caches[repository.repoId] ?? "absent") });
  }
  steps.push({ kind: "registry", target: config.workspaceId, action: action(probe.registry.state) });
  const businessActions = steps.filter((step) => step.kind !== "journal").map((step) => step.action);
  const outcome: WorkspaceCreateAction = steps.some((step) => step.action === "rejected") ? "rejected" :
    journalAction === "repaired" || businessActions.includes("repaired") ? "repaired" :
    businessActions.includes("created") ? "created" : "reused";
  const configSha256 = sha256({
    workspaceId: config.workspaceId,
    root: config.root,
    manifest: config.manifest,
  });
  const planSha256 = sha256({
    schema: "roll.workspace-create-plan/v1",
    workspaceId: config.workspaceId,
    root: config.root,
    outcome,
    configSha256,
    ...(probe.journal.recovery === undefined ? {} : { recovery: probe.journal.recovery }),
    steps,
  });
  return {
    schema: "roll.workspace-create-plan/v1",
    workspaceId: config.workspaceId,
    root: config.root,
    outcome,
    configSha256,
    planSha256,
    ...(probe.journal.recovery === undefined ? {} : { recovery: probe.journal.recovery }),
    steps,
  };
}

export function buildWorkspaceCreateApplyAuthorization(
  plan: WorkspaceCreatePlan,
  source: WorkspaceCreateApplyAuthorizationV1["source"],
): WorkspaceCreateApplyAuthorizationV1 {
  return {
    schema: WORKSPACE_CREATE_APPLY_AUTHORIZATION_V1,
    workspaceId: plan.workspaceId,
    configSha256: plan.configSha256,
    planSha256: plan.planSha256,
    source,
  };
}

export function parseWorkspaceCreateApplyAuthorization(text: string): WorkspaceCreateApplyAuthorizationParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, code: "invalid_apply_authorization" };
  }
  if (!isRecord(value) || exactKeys(value, ["schema", "workspaceId", "configSha256", "planSha256", "source"]).length > 0) {
    return { ok: false, code: "invalid_apply_authorization" };
  }
  if (value["schema"] !== WORKSPACE_CREATE_APPLY_AUTHORIZATION_V1 ||
    !nonEmptyString(value["workspaceId"]) ||
    typeof value["configSha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(value["configSha256"]) ||
    typeof value["planSha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(value["planSha256"]) ||
    (value["source"] !== "direct_cli_apply" && value["source"] !== "owner_after_preview")) {
    return { ok: false, code: "invalid_apply_authorization" };
  }
  return {
    ok: true,
    value: {
      schema: WORKSPACE_CREATE_APPLY_AUTHORIZATION_V1,
      workspaceId: value["workspaceId"],
      configSha256: value["configSha256"],
      planSha256: value["planSha256"],
      source: value["source"],
    },
  };
}

export function validateWorkspaceCreateApplyAuthorization(
  plan: WorkspaceCreatePlan,
  authorization: WorkspaceCreateApplyAuthorizationV1 | undefined,
): WorkspaceCreateApplyAuthorizationValidation {
  const nextAction = `roll workspace create ${plan.workspaceId} --config <path> --check --json`;
  if (authorization === undefined) return { ok: false, code: "apply_authorization_required", nextAction };
  if (authorization.workspaceId !== plan.workspaceId ||
    authorization.configSha256 !== plan.configSha256 ||
    authorization.planSha256 !== plan.planSha256) {
    return { ok: false, code: "apply_authorization_stale", nextAction };
  }
  return { ok: true };
}
