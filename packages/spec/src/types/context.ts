import type { JsonSchema } from "./json-schema.js";
import {
  workspaceExecutionContextV1Schema,
  type ContractError,
  type ContractResult,
  type WorkspaceExecutionContextV1,
} from "./workspace.js";
import {
  isSafeContextPath,
  isValidContextProviderId,
  workspaceContextBindingV1Schema,
  type WorkspaceContextBindingV1,
} from "./context-binding.js";

export {
  isSafeContextPath,
  isValidContextProviderId,
  parseWorkspaceContexts,
  workspaceContextBindingV1Schema,
  workspaceContextsV1Schema,
} from "./context-binding.js";
export type { WorkspaceContextBindingV1, WorkspaceContextsV1 } from "./context-binding.js";
export { workspaceExecutionContextV1Schema } from "./workspace.js";

export const CONTEXT_PROVIDER_REGISTRY_V1 = "roll.context-providers/v1" as const;
export const CONTEXT_READ_REQUEST_V1 = "roll.context-read-request/v1" as const;
export const CONTEXT_READ_RESULT_V1 = "roll.context-read-result/v1" as const;
export const CONTEXT_PAGE_V1 = "roll.context-page/v1" as const;

export const CONTEXT_DIAGNOSTIC_CODES = [
  "context_disabled",
  "provider_not_found",
  "provider_not_bound",
  "invalid_context_binding",
  "provider_disabled",
  "invalid_provider_config",
  "unsupported_git_transport",
  "remote_identity_mismatch",
  "fetch_failed",
  "fetch_timeout",
  "branch_not_found",
  "revision_missing",
  "invalid_wiki_layout",
  "invalid_context_ref",
  "context_file_missing",
  "context_symlink_rejected",
  "context_file_too_large",
  "context_budget_exceeded",
  "invalid_page_frontmatter",
  "scope_mismatch",
  "restricted_context_denied",
  "context_revision_changed",
  "invalid_context_snapshot",
  "context_lock_timeout",
] as const;

export type ContextDiagnosticCode = (typeof CONTEXT_DIAGNOSTIC_CODES)[number];
export type ContextStage = "clarify" | "design" | "tasking" | "build" | "qa" | "review" | "fix" | "operation";

export interface GitLlmWikiProviderConfigV1 {
  readonly id: string;
  readonly type: "git_llm_wiki";
  readonly enabled: boolean;
  readonly remote: string;
  readonly branch: string;
  readonly fetch_timeout_seconds: number;
}

export interface ContextGitRemoteV1 {
  readonly remoteIdentity: string;
  readonly fetchEndpoint: string;
}

export interface ContextProviderRegistryV1 {
  readonly schema: typeof CONTEXT_PROVIDER_REGISTRY_V1;
  readonly enabled: boolean;
  readonly providers: readonly GitLlmWikiProviderConfigV1[];
}

export interface ContextRefV1 {
  readonly ref: string;
  readonly providerId: string;
  readonly path: string;
}

export interface ContextPageScopeV1 {
  readonly workspace_ids?: readonly string[];
  readonly repository_ids?: readonly string[];
  readonly environment_ids?: readonly string[];
  readonly story_ids?: readonly string[];
  readonly stages?: readonly ContextStage[];
}

export interface ContextPageMetadataV1 {
  readonly schema: typeof CONTEXT_PAGE_V1;
  readonly title: string;
  readonly page_type: string;
  readonly status: "active" | "deprecated" | "proposed";
  readonly confidence: "approved" | "source" | "inferred" | "low";
  readonly updated_at: string;
  readonly scope: ContextPageScopeV1;
  readonly sources: readonly string[];
  readonly sensitivity: "public" | "internal" | "restricted_reference";
}

export interface ContextDiagnosticV1 {
  readonly code: ContextDiagnosticCode;
  readonly severity: "warning" | "gap" | "blocking";
  readonly providerId?: string;
  readonly ref?: string;
  readonly message: string;
  readonly mismatchedDimensions?: readonly string[];
  readonly matchedScope?: Readonly<Record<string, readonly string[]>>;
}

export interface ContextReadRequestV1 {
  readonly schema: typeof CONTEXT_READ_REQUEST_V1;
  readonly workspace: WorkspaceExecutionContextV1;
  readonly storyId?: string;
  readonly stage: ContextStage;
  readonly environmentIds?: readonly string[];
  readonly refs: readonly string[];
  readonly includeNonActive?: boolean;
  readonly includeRestrictedReferences?: boolean;
}

export interface ContextReadFileV1 {
  readonly ref: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly page?: ContextPageMetadataV1;
  readonly matchedScope?: Readonly<Record<string, readonly string[]>>;
  readonly content: string;
}

export interface ContextReadProviderSnapshotV1 {
  readonly providerId: string;
  readonly remoteIdentity: string;
  readonly branch: string;
  readonly fetchedAt: string;
  readonly revision: string;
  readonly providerConfigDigest: string;
  readonly bindingDigest: string;
  readonly files: readonly ContextReadFileV1[];
  readonly warnings: readonly ContextDiagnosticV1[];
}

export interface ContextReadResultV1 {
  readonly schema: typeof CONTEXT_READ_RESULT_V1;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly createdAt: string;
  readonly artifactPath: string;
  readonly outcome: "completed" | "partial" | "blocked" | "disabled";
  readonly requestScope: {
    readonly workspaceId: string;
    readonly storyId?: string;
    readonly repositoryIds: readonly string[];
    readonly environmentIds: readonly string[];
    readonly stage: ContextStage;
  };
  readonly providers: readonly ContextReadProviderSnapshotV1[];
  readonly gaps: readonly ContextDiagnosticV1[];
}

export interface ContextProviderExecutionPlanV1 {
  readonly provider: GitLlmWikiProviderConfigV1;
  readonly binding: WorkspaceContextBindingV1;
  readonly paths: readonly string[];
  readonly providerConfigDigest: string;
  readonly bindingDigest: string;
}

export interface ContextProviderRegistry {
  resolve(providerId: string): GitLlmWikiProviderConfigV1 | undefined;
  listEnabled(): readonly GitLlmWikiProviderConfigV1[];
}

const stringSchema: JsonSchema = { type: "string", minLength: 1 };
const sha256Schema: JsonSchema = { type: "string", minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" };

function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const providerSchema = objectSchema({
  id: stringSchema,
  type: { const: "git_llm_wiki" },
  enabled: { type: "boolean" },
  remote: stringSchema,
  branch: stringSchema,
  fetch_timeout_seconds: { type: "integer", minimum: 5, maximum: 300 },
}, ["id", "type", "enabled", "remote", "branch", "fetch_timeout_seconds"]);

const stringArraySchema: JsonSchema = { type: "array", items: stringSchema };
const stringArrayRecordSchema: JsonSchema = { type: "object", additionalProperties: stringArraySchema };

export const contextDiagnosticV1Schema: JsonSchema = objectSchema({
  code: { type: "string", enum: CONTEXT_DIAGNOSTIC_CODES },
  severity: { type: "string", enum: ["warning", "gap", "blocking"] },
  providerId: stringSchema,
  ref: stringSchema,
  message: stringSchema,
  mismatchedDimensions: stringArraySchema,
  matchedScope: stringArrayRecordSchema,
}, ["code", "severity", "message"]);


export const contextProviderRegistryV1Schema: JsonSchema = objectSchema({
  schema: { const: CONTEXT_PROVIDER_REGISTRY_V1 },
  enabled: { type: "boolean" },
  providers: { type: "array", items: providerSchema },
}, ["schema", "enabled", "providers"]);

const contextStages = ["clarify", "design", "tasking", "build", "qa", "review", "fix", "operation"] as const;

export const contextReadRequestV1Schema: JsonSchema = objectSchema({
  schema: { const: CONTEXT_READ_REQUEST_V1 },
  workspace: workspaceExecutionContextV1Schema,
  storyId: stringSchema,
  stage: { type: "string", enum: contextStages },
  environmentIds: { type: "array", items: stringSchema },
  refs: { type: "array", items: stringSchema },
  includeNonActive: { type: "boolean" },
  includeRestrictedReferences: { type: "boolean" },
}, ["schema", "workspace", "stage", "refs"]);

const contextPageScopeSchema = objectSchema({
  workspace_ids: stringArraySchema,
  repository_ids: stringArraySchema,
  environment_ids: stringArraySchema,
  story_ids: stringArraySchema,
  stages: { type: "array", items: { type: "string", enum: contextStages } },
});

const contextPageMetadataSchema = objectSchema({
  schema: { const: CONTEXT_PAGE_V1 },
  title: stringSchema,
  page_type: stringSchema,
  status: { type: "string", enum: ["active", "deprecated", "proposed"] },
  confidence: { type: "string", enum: ["approved", "source", "inferred", "low"] },
  updated_at: stringSchema,
  scope: contextPageScopeSchema,
  sources: stringArraySchema,
  sensitivity: { type: "string", enum: ["public", "internal", "restricted_reference"] },
}, ["schema", "title", "page_type", "status", "confidence", "updated_at", "scope", "sources", "sensitivity"]);

const contextReadFileSchema = objectSchema({
  ref: stringSchema,
  path: stringSchema,
  sha256: sha256Schema,
  bytes: { type: "integer", minimum: 0 },
  page: contextPageMetadataSchema,
  matchedScope: stringArrayRecordSchema,
  content: { type: "string" },
}, ["ref", "path", "sha256", "bytes", "content"]);

const contextReadProviderSnapshotSchema = objectSchema({
  providerId: stringSchema,
  remoteIdentity: stringSchema,
  branch: stringSchema,
  fetchedAt: stringSchema,
  revision: stringSchema,
  providerConfigDigest: sha256Schema,
  bindingDigest: sha256Schema,
  files: { type: "array", items: contextReadFileSchema },
  warnings: { type: "array", items: contextDiagnosticV1Schema },
}, ["providerId", "remoteIdentity", "branch", "fetchedAt", "revision", "providerConfigDigest", "bindingDigest", "files", "warnings"]);

const contextRequestScopeSchema = objectSchema({
  workspaceId: stringSchema,
  storyId: stringSchema,
  repositoryIds: stringArraySchema,
  environmentIds: stringArraySchema,
  stage: { type: "string", enum: contextStages },
}, ["workspaceId", "repositoryIds", "environmentIds", "stage"]);

export const contextReadResultV1Schema: JsonSchema = objectSchema({
  schema: { const: CONTEXT_READ_RESULT_V1 },
  snapshotId: stringSchema,
  snapshotDigest: sha256Schema,
  createdAt: stringSchema,
  artifactPath: stringSchema,
  outcome: { type: "string", enum: ["completed", "partial", "blocked", "disabled"] },
  requestScope: contextRequestScopeSchema,
  providers: { type: "array", items: contextReadProviderSnapshotSchema },
  gaps: { type: "array", items: contextDiagnosticV1Schema },
}, ["schema", "snapshotId", "snapshotDigest", "createdAt", "artifactPath", "outcome", "requestScope", "providers", "gaps"]);

export const contextProviderExecutionPlanV1Schema: JsonSchema = objectSchema({
  provider: providerSchema,
  binding: workspaceContextBindingV1Schema,
  paths: stringArraySchema,
  providerConfigDigest: sha256Schema,
  bindingDigest: sha256Schema,
}, ["provider", "binding", "paths", "providerConfigDigest", "bindingDigest"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(code: ContractError["code"], path: string, message: string): ContractError {
  return { code, path, message };
}

function unknownFields(value: Record<string, unknown>, allowed: readonly string[], path: string): ContractError[] {
  const accepted = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !accepted.has(key))
    .map((key) => error("unknown_field", path === "" ? key : `${path}.${key}`, "contract contains an unknown field"));
}

function parseRequiredBoolean(
  value: Record<string, unknown>,
  key: string,
  path: string,
  errors: ContractError[],
): boolean | undefined {
  const candidate = value[key];
  if (typeof candidate !== "boolean") {
    errors.push(error("invalid_type", `${path}${key}`, "field must be a boolean"));
    return undefined;
  }
  return candidate;
}

function parseRequiredString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  errors: ContractError[],
): string | undefined {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    errors.push(error("invalid_type", `${path}${key}`, "field must be a non-empty string"));
    return undefined;
  }
  return candidate;
}

function safeRemotePath(value: string): string | undefined {
  let path = value.endsWith("/") ? value.slice(0, -1) : value;
  if (path.endsWith(".git")) path = path.slice(0, -4);
  if (path.startsWith("/")) path = path.slice(1);
  const segments = path.split("/");
  if (segments.length < 2 || segments.some((segment) =>
    segment === "" || segment === "." || segment === ".." || segment.startsWith("-") ||
    /[\x00-\x20\x7f\\?#%]/u.test(segment)
  )) return undefined;
  return segments.join("/");
}

function normalizeHost(value: string): string | undefined {
  if (value.startsWith("[")) {
    if (!/^\[[0-9A-Fa-f:.]+\]$/u.test(value)) return undefined;
  } else if (!value.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
  )) return undefined;
  try {
    return new URL(`https://${value}/`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function resolveContextGitRemote(value: unknown): ContractResult<ContextGitRemoteV1> {
  const fail = (): ContractResult<ContextGitRemoteV1> => ({
    ok: false,
    errors: [error("invalid_value", "remote", "Context provider remote must use credential-free HTTPS or SSH")],
  });
  if (typeof value !== "string" || value !== value.trim() || value === "" || /[\x00-\x20\x7f]/u.test(value)) return fail();

  const https = /^https:\/\/([^/@:]+)(?::443)?\/(.+)$/u.exec(value);
  if (https !== null) {
    const host = https[1] === undefined ? undefined : normalizeHost(https[1]);
    const path = https[2] === undefined ? undefined : safeRemotePath(https[2]);
    if (host === undefined || path === undefined) return fail();
    const remoteIdentity = `https://${host}/${path}`;
    return { ok: true, value: { remoteIdentity, fetchEndpoint: remoteIdentity } };
  }

  const ssh = /^ssh:\/\/(?:([A-Za-z0-9._~-]+)@)?([^/@:]+)(?::22)?\/(.+)$/u.exec(value);
  if (ssh !== null) {
    const user = ssh[1];
    const host = ssh[2] === undefined ? undefined : normalizeHost(ssh[2]);
    const path = ssh[3] === undefined ? undefined : safeRemotePath(ssh[3]);
    if (host === undefined || path === undefined) return fail();
    return {
      ok: true,
      value: {
        remoteIdentity: `ssh://${host}/${path}`,
        fetchEndpoint: `ssh://${user === undefined ? "" : `${user}@`}${host}/${path}`,
      },
    };
  }

  const scp = /^([A-Za-z0-9._~-]+)@([^:@/]+):(.+)$/u.exec(value);
  if (scp !== null) {
    const user = scp[1];
    const host = scp[2] === undefined ? undefined : normalizeHost(scp[2]);
    const path = scp[3] === undefined ? undefined : safeRemotePath(scp[3]);
    if (user === undefined || host === undefined || path === undefined) return fail();
    return {
      ok: true,
      value: {
        remoteIdentity: `ssh://${host}/${path}`,
        fetchEndpoint: `ssh://${user}@${host}/${path}`,
      },
    };
  }
  return fail();
}

export function normalizeContextGitRemote(value: unknown): ContractResult<string> {
  const resolved = resolveContextGitRemote(value);
  return resolved.ok ? { ok: true, value: resolved.value.remoteIdentity } : resolved;
}

export function isValidContextBranch(value: string): boolean {
  if (value.length > 255 || value.startsWith("-") || value.startsWith("refs/") || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value)) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value === "@" || value === "HEAD") return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (/[\x00-\x20\x7f~^:?*\\[]/u.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && !segment.startsWith(".") && !segment.endsWith(".lock"));
}

function parseProvider(value: unknown, index: number, errors: ContractError[]): GitLlmWikiProviderConfigV1 | undefined {
  const path = `providers[${index}]`;
  if (!isRecord(value)) {
    errors.push(error("invalid_type", path, "Context provider must be an object"));
    return undefined;
  }
  errors.push(...unknownFields(value, ["id", "type", "enabled", "remote", "branch", "fetch_timeout_seconds"], path));
  const id = parseRequiredString(value, "id", `${path}.`, errors);
  const enabled = parseRequiredBoolean(value, "enabled", `${path}.`, errors);
  const branch = parseRequiredString(value, "branch", `${path}.`, errors);
  if (value["type"] !== "git_llm_wiki") errors.push(error("invalid_value", `${path}.type`, "v1 supports only git_llm_wiki"));
  if (id !== undefined && !isValidContextProviderId(id)) errors.push(error("invalid_value", `${path}.id`, "provider id is invalid"));
  if (branch !== undefined && !isValidContextBranch(branch)) errors.push(error("invalid_value", `${path}.branch`, "provider branch is invalid"));
  const timeout = value["fetch_timeout_seconds"];
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 5 || (timeout as number) > 300) {
    errors.push(error("invalid_value", `${path}.fetch_timeout_seconds`, "fetch timeout must be an integer from 5 to 300 seconds"));
  }
  const remote = resolveContextGitRemote(value["remote"]);
  if (!remote.ok) errors.push(...remote.errors.map((entry) => ({ ...entry, path: `${path}.${entry.path}` })));
  if (
    id === undefined || enabled === undefined || branch === undefined || value["type"] !== "git_llm_wiki" ||
    !Number.isSafeInteger(timeout) || (timeout as number) < 5 || (timeout as number) > 300 || !remote.ok ||
    !isValidContextProviderId(id) || !isValidContextBranch(branch)
  ) return undefined;
  return { id, type: "git_llm_wiki", enabled, remote: remote.value.fetchEndpoint, branch, fetch_timeout_seconds: timeout as number };
}

export function parseContextProviderRegistry(value: unknown): ContractResult<ContextProviderRegistryV1> {
  if (!isRecord(value)) return { ok: false, errors: [error("invalid_type", "registry", "Context registry must be an object")] };
  const errors = unknownFields(value, ["schema", "enabled", "providers"], "");
  if (value["schema"] !== CONTEXT_PROVIDER_REGISTRY_V1) {
    errors.push(error("unknown_version", "schema", `expected ${CONTEXT_PROVIDER_REGISTRY_V1}`));
  }
  const enabled = parseRequiredBoolean(value, "enabled", "", errors);
  const rawProviders = value["providers"];
  if (!Array.isArray(rawProviders)) {
    errors.push(error("invalid_type", "providers", "providers must be an array"));
  }
  if (errors.length > 0 || enabled === undefined || !Array.isArray(rawProviders)) return { ok: false, errors };
  if (!enabled) {
    for (const [index, raw] of rawProviders.entries()) {
      if (!isRecord(raw)) continue;
      errors.push(...unknownFields(raw, ["id", "type", "enabled", "remote", "branch", "fetch_timeout_seconds"], `providers[${index}]`));
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: { schema: CONTEXT_PROVIDER_REGISTRY_V1, enabled: false, providers: [] } };
  }

  const providers: GitLlmWikiProviderConfigV1[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawProviders.entries()) {
    const parsed = parseProvider(raw, index, errors);
    if (parsed === undefined) continue;
    if (seen.has(parsed.id)) errors.push(error("duplicate_identity", `providers[${index}].id`, "duplicate Context provider id"));
    seen.add(parsed.id);
    providers.push(parsed);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { schema: CONTEXT_PROVIDER_REGISTRY_V1, enabled, providers } };
}

export function parseContextRef(value: unknown): ContractResult<ContextRefV1> {
  const fail = (): ContractResult<ContextRefV1> => ({
    ok: false,
    errors: [error("invalid_value", "ref", "Context ref must use context://<provider>/<safe-path>")],
  });
  if (typeof value !== "string" || value !== value.trim()) return fail();
  const matched = /^context:\/\/([^/]+)\/(.+)$/u.exec(value);
  if (matched === null) return fail();
  const providerId = matched[1];
  const path = matched[2];
  if (providerId === undefined || path === undefined || !isValidContextProviderId(providerId) || !isSafeContextPath(path, false)) return fail();
  return { ok: true, value: { ref: value, providerId, path } };
}
