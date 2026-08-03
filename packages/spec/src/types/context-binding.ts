import type { JsonSchema } from "./json-schema.js";
import type { ContractError, ContractResult } from "./workspace.js";

export interface WorkspaceContextBindingV1 {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly entrypoints: readonly string[];
}

export interface WorkspaceContextsV1 {
  readonly enabled: boolean;
  readonly bindings: readonly WorkspaceContextBindingV1[];
}

const stringSchema: JsonSchema = { type: "string", minLength: 1 };

function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export const workspaceContextBindingV1Schema: JsonSchema = objectSchema({
  providerId: stringSchema,
  enabled: { type: "boolean" },
  required: { type: "boolean" },
  entrypoints: { type: "array", items: stringSchema },
}, ["providerId", "enabled", "required", "entrypoints"]);

export const workspaceContextsV1Schema: JsonSchema = objectSchema({
  enabled: { type: "boolean" },
  bindings: { type: "array", items: workspaceContextBindingV1Schema },
}, ["enabled", "bindings"]);

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

export function isValidContextProviderId(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

const RESERVED_CONTEXT_PATHS = new Set(["purpose.md", "schema.md"]);
const FORBIDDEN_CONTEXT_SEGMENTS = new Set([".git", ".llm-wiki", ".obsidian", "credentials"]);

export function isSafeContextPath(value: string, allowReserved: boolean): boolean {
  if (allowReserved && RESERVED_CONTEXT_PATHS.has(value)) return true;
  if (
    !value.startsWith("wiki/") || value.startsWith("/") || value.includes("\\") ||
    /[\x00-\x1f\x7f?#%]/u.test(value)
  ) return false;
  const segments = value.split("/");
  return segments.every((segment) =>
    segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith(".") &&
    !segment.startsWith("-") && !FORBIDDEN_CONTEXT_SEGMENTS.has(segment)
  );
}

function stableUnique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function parseWorkspaceContexts(value: unknown, basePath = "contexts"): ContractResult<WorkspaceContextsV1> {
  if (!isRecord(value)) return { ok: false, errors: [error("invalid_type", basePath, "Workspace contexts must be an object")] };
  const errors = unknownFields(value, ["enabled", "bindings"], basePath);
  const enabled = parseRequiredBoolean(value, "enabled", `${basePath}.`, errors);
  const rawBindings = value["bindings"];
  if (!Array.isArray(rawBindings)) {
    errors.push(error("invalid_type", `${basePath}.bindings`, "bindings must be an array"));
  }
  if (errors.length > 0 || enabled === undefined || !Array.isArray(rawBindings)) return { ok: false, errors };

  // Disabled bindings are dormant configuration. Preserve the explicit off
  // state without letting stale provider details block the Workspace.
  if (!enabled) {
    for (const [index, raw] of rawBindings.entries()) {
      if (!isRecord(raw)) continue;
      errors.push(...unknownFields(raw, ["providerId", "enabled", "required", "entrypoints"], `${basePath}.bindings[${index}]`));
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: { enabled: false, bindings: [] } };
  }

  const bindings: WorkspaceContextBindingV1[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawBindings.entries()) {
    const path = `${basePath}.bindings[${index}]`;
    if (!isRecord(raw)) {
      errors.push(error("invalid_type", path, "Context binding must be an object"));
      continue;
    }
    errors.push(...unknownFields(raw, ["providerId", "enabled", "required", "entrypoints"], path));
    const providerId = parseRequiredString(raw, "providerId", `${path}.`, errors);
    const bindingEnabled = parseRequiredBoolean(raw, "enabled", `${path}.`, errors);
    const required = parseRequiredBoolean(raw, "required", `${path}.`, errors);
    const rawEntrypoints = raw["entrypoints"];
    let entrypoints: readonly string[] | undefined;
    if (!Array.isArray(rawEntrypoints) || !rawEntrypoints.every((entry) => typeof entry === "string")) {
      errors.push(error("invalid_type", `${path}.entrypoints`, "entrypoints must be an array of strings"));
    } else {
      const valid: string[] = [];
      for (const [entryIndex, entry] of rawEntrypoints.entries()) {
        if (!isSafeContextPath(entry, false)) {
          errors.push(error("invalid_value", `${path}.entrypoints[${entryIndex}]`, "entrypoint must be a safe wiki path"));
        } else valid.push(entry);
      }
      entrypoints = stableUnique(valid);
    }
    if (providerId !== undefined && !isValidContextProviderId(providerId)) {
      errors.push(error("invalid_value", `${path}.providerId`, "provider id is invalid"));
    }
    if (bindingEnabled === false && required === true) {
      errors.push(error("invalid_value", path, "required Context binding cannot be disabled"));
    }
    if (providerId !== undefined) {
      if (seen.has(providerId)) errors.push(error("invalid_value", `${path}.providerId`, "duplicate Context binding provider id"));
      seen.add(providerId);
    }
    if (
      providerId !== undefined && isValidContextProviderId(providerId) && bindingEnabled !== undefined &&
      required !== undefined && !(bindingEnabled === false && required === true) && entrypoints !== undefined
    ) {
      bindings.push({ providerId, enabled: bindingEnabled, required, entrypoints });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { enabled: true, bindings } };
}
