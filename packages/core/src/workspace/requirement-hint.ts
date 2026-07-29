import { isAbsolute, normalize } from "node:path";
import {
  REQUIREMENT_HINT_PROVENANCES,
  REQUIREMENT_HINT_V1,
  normalizeRepositoryRemote,
  type RepositoryHintProvenance,
  type RequirementHintProvenance,
  type RequirementHintV1,
  type StructuredRequirementProvenance,
} from "@roll/spec";
import { validateStoryId } from "./issue-init-plan.js";
import { normalizeRequirementSourceReference } from "./requirement-source.js";

export const MAX_REQUIREMENT_HINT_ITEMS = 32;
export const MAX_REQUIREMENT_HINT_VALUE_LENGTH = 2_048;
export const MAX_REQUIREMENT_SEMANTIC_TERM_LENGTH = 128;

export interface RequirementHintInput {
  readonly schema?: string;
  readonly sources?: readonly {
    readonly key: { readonly provider: string; readonly ref: string };
    readonly provenance: RequirementHintProvenance;
  }[];
  readonly storyIds?: readonly {
    readonly storyId: string;
    readonly provenance: RequirementHintProvenance;
  }[];
  readonly repositoryRemotes?: readonly {
    readonly remote: string;
    readonly provenance: RequirementHintProvenance;
  }[];
  readonly paths?: readonly {
    readonly path: string;
    readonly provenance: RequirementHintProvenance;
  }[];
  readonly semanticTerms?: readonly string[];
}

export type RequirementHintFindingCode =
  | "invalid_schema"
  | "invalid_type"
  | "unknown_field"
  | "invalid_provenance"
  | "invalid_requirement_source"
  | "invalid_story_id"
  | "invalid_repository_remote"
  | "invalid_path"
  | "invalid_value"
  | "value_too_long"
  | "item_limit";

export interface RequirementHintFinding {
  readonly code: RequirementHintFindingCode;
  readonly path: string;
  readonly detail: string;
}

export type RequirementHintNormalizationResult =
  | { readonly ok: true; readonly value: RequirementHintV1 }
  | { readonly ok: false; readonly findings: readonly RequirementHintFinding[] };

const PROVENANCE = new Set<string>(REQUIREMENT_HINT_PROVENANCES);
const STRUCTURED_PROVENANCE = new Set<RequirementHintProvenance>([
  "explicit_user",
  "cli_argument",
  "issue_manifest",
  "deterministic_extraction",
]);
const REPOSITORY_PROVENANCE = new Set<RequirementHintProvenance>([
  ...STRUCTURED_PROVENANCE,
  "cwd_repository",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closedRecord(
  value: unknown,
  allowed: readonly string[],
  path: string,
  findings: RequirementHintFinding[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    findings.push({ code: "invalid_type", path, detail: "Requirement hint field must be an object" });
    return undefined;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      findings.push({ code: "unknown_field", path: path === "$" ? key : `${path}.${key}`, detail: "Requirement hint contains an unknown field" });
    }
  }
  return value;
}

function arrayField(
  input: Record<string, unknown>,
  key: string,
  findings: RequirementHintFinding[],
): readonly unknown[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push({ code: "invalid_type", path: key, detail: "Requirement hint collection must be an array" });
    return [];
  }
  return value;
}

function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const unique = new Map<string, T>();
  for (const value of values) unique.set(key(value), value);
  return [...unique.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, value]) => value);
}

function itemLimit(
  entries: readonly unknown[],
  path: string,
  findings: RequirementHintFinding[],
): boolean {
  if (entries.length <= MAX_REQUIREMENT_HINT_ITEMS) return false;
  findings.push({ code: "item_limit", path, detail: `Requirement hint accepts at most ${MAX_REQUIREMENT_HINT_ITEMS} items` });
  return true;
}

function safeString(
  value: unknown,
  path: string,
  maxLength: number,
  findings: RequirementHintFinding[],
): string | undefined {
  if (typeof value !== "string" || value.trim() === "" || /[\x00-\x1f\x7f]/u.test(value)) {
    findings.push({ code: "invalid_value", path, detail: "Requirement hint value must be a non-empty safe string" });
    return undefined;
  }
  const normalized = value.normalize("NFC").trim();
  if (normalized.length > maxLength) {
    findings.push({ code: "value_too_long", path, detail: `Requirement hint value exceeds ${maxLength} characters` });
    return undefined;
  }
  return normalized;
}

function safeRelativeRequirementPath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("~") || value.includes("\\") || /^[A-Za-z]:/u.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validProvenance(
  value: unknown,
  allowed: ReadonlySet<RequirementHintProvenance>,
  path: string,
  findings: RequirementHintFinding[],
): value is RequirementHintProvenance {
  if (typeof value === "string" && PROVENANCE.has(value) && allowed.has(value as RequirementHintProvenance)) return true;
  findings.push({ code: "invalid_provenance", path, detail: "Provenance is not allowed for this structured hint" });
  return false;
}

export function normalizeRequirementHint(input: unknown): RequirementHintNormalizationResult {
  const findings: RequirementHintFinding[] = [];
  const parsed = closedRecord(input, ["schema", "sources", "storyIds", "repositoryRemotes", "paths", "semanticTerms"], "$", findings);
  if (parsed === undefined) return { ok: false, findings };
  if (parsed["schema"] !== undefined && parsed["schema"] !== REQUIREMENT_HINT_V1) {
    findings.push({ code: "invalid_schema", path: "schema", detail: "Requirement hint schema is unsupported" });
  }

  const sourceInputs = arrayField(parsed, "sources", findings);
  const storyInputs = arrayField(parsed, "storyIds", findings);
  const repositoryInputs = arrayField(parsed, "repositoryRemotes", findings);
  const pathInputs = arrayField(parsed, "paths", findings);
  const semanticInputs = arrayField(parsed, "semanticTerms", findings);
  itemLimit(sourceInputs, "sources", findings);
  itemLimit(storyInputs, "storyIds", findings);
  itemLimit(repositoryInputs, "repositoryRemotes", findings);
  itemLimit(pathInputs, "paths", findings);
  itemLimit(semanticInputs, "semanticTerms", findings);

  const sources: RequirementHintV1["sources"][number][] = [];
  for (const [index, rawEntry] of sourceInputs.slice(0, MAX_REQUIREMENT_HINT_ITEMS).entries()) {
    const entryPath = `sources[${index}]`;
    const entry = closedRecord(rawEntry, ["key", "provenance"], entryPath, findings);
    if (entry === undefined) continue;
    const key = closedRecord(entry["key"], ["provider", "ref"], `${entryPath}.key`, findings);
    if (key === undefined) continue;
    const provenance = entry["provenance"];
    if (!validProvenance(provenance, STRUCTURED_PROVENANCE, `${entryPath}.provenance`, findings)) continue;
    const provider = safeString(key["provider"], `${entryPath}.key.provider`, MAX_REQUIREMENT_HINT_VALUE_LENGTH, findings);
    const ref = safeString(key["ref"], `${entryPath}.key.ref`, MAX_REQUIREMENT_HINT_VALUE_LENGTH, findings);
    if (provider === undefined || ref === undefined) continue;
    const normalized = normalizeRequirementSourceReference(provider, ref);
    if (!normalized.ok) {
      findings.push({ code: "invalid_requirement_source", path: `sources[${index}].key`, detail: "Requirement source must be a canonical structured provider/reference" });
      continue;
    }
    if (normalized.value.provider === "local_file" && !safeRelativeRequirementPath(normalized.value.ref)) {
      findings.push({ code: "invalid_requirement_source", path: `sources[${index}].key`, detail: "Local-file requirement source must remain inside the host-selected Workspace root" });
      continue;
    }
    sources.push({
      key: { provider: normalized.value.provider, ref: normalized.value.ref },
      provenance: provenance as StructuredRequirementProvenance,
    });
  }

  const storyIds: RequirementHintV1["storyIds"][number][] = [];
  for (const [index, rawEntry] of storyInputs.slice(0, MAX_REQUIREMENT_HINT_ITEMS).entries()) {
    const entryPath = `storyIds[${index}]`;
    const entry = closedRecord(rawEntry, ["storyId", "provenance"], entryPath, findings);
    if (entry === undefined) continue;
    const provenance = entry["provenance"];
    if (!validProvenance(provenance, STRUCTURED_PROVENANCE, `${entryPath}.provenance`, findings)) continue;
    const storyId = safeString(entry["storyId"], `${entryPath}.storyId`, MAX_REQUIREMENT_HINT_VALUE_LENGTH, findings);
    if (storyId === undefined) continue;
    const validated = validateStoryId(storyId);
    if (!validated.ok) {
      findings.push({ code: "invalid_story_id", path: `storyIds[${index}].storyId`, detail: validated.message });
      continue;
    }
    storyIds.push({ storyId: validated.value, provenance: provenance as StructuredRequirementProvenance });
  }

  const repositoryRemotes: RequirementHintV1["repositoryRemotes"][number][] = [];
  for (const [index, rawEntry] of repositoryInputs.slice(0, MAX_REQUIREMENT_HINT_ITEMS).entries()) {
    const entryPath = `repositoryRemotes[${index}]`;
    const entry = closedRecord(rawEntry, ["remote", "provenance"], entryPath, findings);
    if (entry === undefined) continue;
    const provenance = entry["provenance"];
    if (!validProvenance(provenance, REPOSITORY_PROVENANCE, `${entryPath}.provenance`, findings)) continue;
    const remote = safeString(entry["remote"], `${entryPath}.remote`, MAX_REQUIREMENT_HINT_VALUE_LENGTH, findings);
    if (remote === undefined) continue;
    const normalized = normalizeRepositoryRemote(remote);
    if (!normalized.ok) {
      findings.push({ code: "invalid_repository_remote", path: `repositoryRemotes[${index}].remote`, detail: "Repository remote is outside the closed identity contract" });
      continue;
    }
    repositoryRemotes.push({ remote: normalized.value, provenance: provenance as RepositoryHintProvenance });
  }

  const paths: RequirementHintV1["paths"][number][] = [];
  for (const [index, rawEntry] of pathInputs.slice(0, MAX_REQUIREMENT_HINT_ITEMS).entries()) {
    const entryPath = `paths[${index}]`;
    const entry = closedRecord(rawEntry, ["path", "provenance"], entryPath, findings);
    if (entry === undefined) continue;
    const provenance = entry["provenance"];
    if (!validProvenance(provenance, REPOSITORY_PROVENANCE, `${entryPath}.provenance`, findings)) continue;
    const path = safeString(entry["path"], `${entryPath}.path`, MAX_REQUIREMENT_HINT_VALUE_LENGTH, findings);
    if (path === undefined) continue;
    if (!isAbsolute(path)) {
      findings.push({ code: "invalid_path", path: `paths[${index}].path`, detail: "Candidate path must be an absolute host-canonical path" });
      continue;
    }
    paths.push({ path: normalize(path), provenance: provenance as RepositoryHintProvenance });
  }

  const semanticTerms: string[] = [];
  for (const [index, rawTerm] of semanticInputs.slice(0, MAX_REQUIREMENT_HINT_ITEMS).entries()) {
    const term = safeString(rawTerm, `semanticTerms[${index}]`, MAX_REQUIREMENT_SEMANTIC_TERM_LENGTH, findings);
    if (term === undefined) continue;
    semanticTerms.push(term.replace(/\s+/gu, " ").toLocaleLowerCase("en-US"));
  }

  if (findings.length > 0) return { ok: false, findings };
  const normalizedSemanticTerms = uniqueSorted(semanticTerms, (term) => term);
  return {
    ok: true,
    value: {
      schema: REQUIREMENT_HINT_V1,
      sources: uniqueSorted(sources, (entry) => `${entry.key.provider}\0${entry.key.ref}\0${entry.provenance}`),
      storyIds: uniqueSorted(storyIds, (entry) => `${entry.storyId}\0${entry.provenance}`),
      repositoryRemotes: uniqueSorted(repositoryRemotes, (entry) => `${entry.remote}\0${entry.provenance}`),
      paths: uniqueSorted(paths, (entry) => `${entry.path}\0${entry.provenance}`),
      ...(normalizedSemanticTerms.length === 0 ? {} : { semanticTerms: normalizedSemanticTerms }),
    },
  };
}
