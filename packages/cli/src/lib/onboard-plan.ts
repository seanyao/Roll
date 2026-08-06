/**
 * @responsibility Plans the onboard changeset for an existing codebase.
 */
import { createHash } from "node:crypto";
import { posix as pathPosix } from "node:path";
import { type InitDiagnosis, type InitFacts } from "./init-diagnosis.js";

export const ONBOARD_SCHEMA_VERSION = 1;
export const ONBOARD_AGENT_WRITABLE_OUTPUTS = [".roll/init-diagnosis.yaml", ".roll/onboard-plan.yaml"] as const;
export const ONBOARD_HASH_PREFIX = "sha256:";

const SHELL_COMMAND_KEYS = new Set(["cmd", "command", "commands", "exec", "run", "script", "shell", "shell_commands"]);
const MERGE_INTENT_TARGETS = new Set([
  "roll_conventions",
  "claude_conventions",
  "backlog",
  "features",
  "domain",
  "briefs",
  "agent_routes",
  "gitignore",
  "sync_targets",
  "phase2_markdown",
]);

export type OnboardArtifactPath = (typeof ONBOARD_AGENT_WRITABLE_OUTPUTS)[number];
export type OnboardFileOperationMode = "write";

export interface OnboardFileOperation {
  path: OnboardArtifactPath;
  operation: OnboardFileOperationMode;
  idempotent: true;
}

export interface OnboardMergeIntent {
  target: string;
  owner: "roll-init-apply";
  strategy: string;
}

export interface OnboardDiagnosisArtifact {
  version: typeof ONBOARD_SCHEMA_VERSION;
  createdAt: string;
  factsHash: string;
  diagnosis: {
    kind: InitDiagnosis["kind"];
    recommendedPath: InitDiagnosis["recommendedPath"];
    confidence: InitDiagnosis["confidence"];
    reasons: string[];
  };
  agent: {
    name: string;
    status: "available" | "missing" | "unknown";
  };
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (isRecord(value)) {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = toJsonValue(item);
    }
    return out;
  }
  return null;
}

function deepSortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => deepSortJson(item));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) out[key] = deepSortJson(value[key] ?? null);
    return out;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(deepSortJson(toJsonValue(value)));
}

export function computeInitFactsHash(facts: InitFacts): string {
  const { root: _root, ...portableFacts } = facts;
  return `${ONBOARD_HASH_PREFIX}${createHash("sha256").update(stableJson(portableFacts), "utf8").digest("hex")}`;
}

export function buildOnboardDiagnosisArtifact(input: {
  createdAt: string;
  facts: InitFacts;
  diagnosis: InitDiagnosis;
  agent?: OnboardDiagnosisArtifact["agent"];
}): OnboardDiagnosisArtifact {
  return {
    version: ONBOARD_SCHEMA_VERSION,
    createdAt: input.createdAt,
    factsHash: computeInitFactsHash(input.facts),
    diagnosis: {
      kind: input.diagnosis.kind,
      recommendedPath: input.diagnosis.recommendedPath,
      confidence: input.diagnosis.confidence,
      reasons: [...input.diagnosis.reasons],
    },
    agent: input.agent ?? { name: "unknown", status: "unknown" },
  };
}

export function defaultOnboardFileOperations(): OnboardFileOperation[] {
  return ONBOARD_AGENT_WRITABLE_OUTPUTS.map((path) => ({ path, operation: "write", idempotent: true }));
}

function scalarYaml(value: JsonPrimitive): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function yamlValue(value: JsonValue, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"];
    const lines: string[] = [];
    for (const item of value) {
      if (Array.isArray(item) || (item !== null && typeof item === "object")) {
        lines.push(`${pad}-`);
        lines.push(...yamlValue(item, indent + 2));
      } else {
        lines.push(`${pad}- ${scalarYaml(item)}`);
      }
    }
    return lines;
  }
  if (value !== null && typeof value === "object") {
    const lines: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (Array.isArray(item) || (item !== null && typeof item === "object")) {
        const nested = yamlValue(item, indent + 2);
        lines.push(`${pad}${key}:`);
        lines.push(...nested);
      } else {
        lines.push(`${pad}${key}: ${scalarYaml(item)}`);
      }
    }
    return lines.length === 0 ? ["{}"] : lines;
  }
  return [`${pad}${scalarYaml(value)}`];
}

export function renderOnboardDiagnosisYaml(artifact: OnboardDiagnosisArtifact): string {
  return `${yamlValue(toJsonValue(artifact), 0).join("\n")}\n`;
}

function findShellCommandKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findShellCommandKeys(item, `${path}[${index}]`));
  }
  if (!isRecord(value)) return [];
  const errors: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SHELL_COMMAND_KEYS.has(key)) errors.push(`${childPath} is not allowed in onboard artifacts`);
    errors.push(...findShellCommandKeys(item, childPath));
  }
  return errors;
}

function validateFactsHash(value: unknown, field: string): string[] {
  if (typeof value !== "string") return [`${field} must be a string`];
  return /^sha256:[0-9a-f]{64}$/.test(value) ? [] : [`${field} must match sha256:<64 lowercase hex chars>`];
}

function validateProjectRelativePath(path: string, field: string): string[] {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || pathPosix.normalize(path) !== path) {
    return [`${field} must be a normalized relative project path without traversal`];
  }
  return [];
}

export function validateOnboardPlanContract(plan: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (plan["version"] !== ONBOARD_SCHEMA_VERSION) errors.push(`version must be ${ONBOARD_SCHEMA_VERSION}`);
  errors.push(...validateFactsHash(plan["factsHash"], "factsHash"));
  errors.push(...findShellCommandKeys(plan));

  const operations = plan["file_operations"];
  if (!Array.isArray(operations)) {
    errors.push("file_operations must be a list");
  } else {
    const seen = new Set<string>();
    operations.forEach((item, index) => {
      const where = `file_operations[${index}]`;
      if (!isRecord(item)) {
        errors.push(`${where} must be a mapping`);
        return;
      }
      const path = item["path"];
      if (typeof path !== "string") {
        errors.push(`${where}.path must be a string`);
      } else {
        errors.push(...validateProjectRelativePath(path, `${where}.path`));
        if (!ONBOARD_AGENT_WRITABLE_OUTPUTS.includes(path as OnboardArtifactPath)) {
          errors.push(`${where}.path '${path}' is outside the agent writable outputs`);
        } else if (seen.has(path)) {
          errors.push(`${where}.path '${path}' must not be duplicated`);
        } else {
          seen.add(path);
        }
      }
      if (item["operation"] !== "write") errors.push(`${where}.operation must be write`);
      if (item["idempotent"] !== true) errors.push(`${where}.idempotent must be true`);
    });
    for (const expected of ONBOARD_AGENT_WRITABLE_OUTPUTS) {
      if (!seen.has(expected)) errors.push(`file_operations must include ${expected}`);
    }
  }

  const intents = plan["merge_intents"];
  if (!Array.isArray(intents)) {
    errors.push("merge_intents must be a list");
  } else {
    intents.forEach((item, index) => {
      const where = `merge_intents[${index}]`;
      if (!isRecord(item)) {
        errors.push(`${where} must be a mapping`);
        return;
      }
      if (typeof item["path"] === "string") errors.push(`${where} must describe a target, not a file path`);
      if (item["owner"] !== "roll-init-apply") errors.push(`${where}.owner must be roll-init-apply`);
      const target = item["target"];
      if (typeof target !== "string" || !MERGE_INTENT_TARGETS.has(target)) {
        errors.push(`${where}.target must be one of ${[...MERGE_INTENT_TARGETS].sort().join(", ")}`);
      }
      if (typeof item["strategy"] !== "string" || item["strategy"].trim() === "") errors.push(`${where}.strategy must be a non-empty string`);
    });
  }

  return errors;
}

export function validateOnboardFactsHashMatch(diagnosis: Record<string, unknown>, plan: Record<string, unknown>): string[] {
  const errors = [...validateFactsHash(diagnosis["factsHash"], "diagnosis.factsHash"), ...validateFactsHash(plan["factsHash"], "plan.factsHash")];
  if (errors.length > 0) return errors;
  return diagnosis["factsHash"] === plan["factsHash"] ? [] : ["plan factsHash must match .roll/init-diagnosis.yaml factsHash"];
}
