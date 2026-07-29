import {
  CONTEXT_PAGE_V1,
  type ContextPageMetadataV1,
  type ContextPageScopeV1,
  type ContextStage,
} from "@roll/spec";
import { isOpaqueRestrictedReference, isSafeLlmWikiSourceReference } from "./context-ref.js";

export interface ContextPageParseV1 {
  readonly valid: boolean;
  readonly metadata?: ContextPageMetadataV1;
  readonly body: string;
  readonly reason?: "frontmatter" | "restricted_reference";
}

const TOP_LEVEL_KEYS = new Set([
  "schema",
  "title",
  "page_type",
  "status",
  "confidence",
  "updated_at",
  "scope",
  "sources",
  "sensitivity",
  "type",
  "tags",
  "related",
  "created",
  "updated",
]);
const SCOPE_KEYS = new Set(["workspace_ids", "repository_ids", "environment_ids", "story_ids", "stages"]);
const STAGES = new Set<ContextStage>(["clarify", "design", "tasking", "build", "qa", "review", "fix", "operation"]);
const NASH_SU_LIST_KEYS = new Set(["tags", "related"]);

type ParsedFrontmatter = Readonly<Record<string, string | readonly string[] | Readonly<Record<string, readonly string[]>>>>;

function scalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "~") return undefined;
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) return undefined;
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[\[\]{}]|[\[\]{}]$/u.test(trimmed) || /[\x00-\x1f\x7f]/u.test(trimmed)) return undefined;
  return trimmed;
}

function inlineList(value: string): readonly string[] | undefined {
  const trimmed = value.trim();
  if (trimmed === "[]") return [];
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];

  const entries: string[] = [];
  let start = 0;
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quote === "\"") {
      if (character === "\\") {
        index += 1;
        if (index >= inner.length) return undefined;
      } else if (character === "\"") {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'" && inner[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ",") {
      entries.push(inner.slice(start, index));
      start = index + 1;
    }
  }
  if (quote !== undefined) return undefined;
  entries.push(inner.slice(start));

  const items = entries.map((entry) => scalar(entry));
  return items.every((entry): entry is string => entry !== undefined) ? items : undefined;
}

function keyValue(line: string): readonly [string, string] | undefined {
  const separator = line.indexOf(":");
  if (separator <= 0) return undefined;
  return [line.slice(0, separator), line.slice(separator + 1)];
}

function parseList(lines: readonly string[], start: number, indent: string): { value?: readonly string[]; next: number } {
  const values: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    if (!line.startsWith(`${indent}- `)) break;
    const parsed = scalar(line.slice(indent.length + 2));
    if (parsed === undefined) return { next: lines.length };
    values.push(parsed);
    index += 1;
  }
  return values.length === 0 ? { next: index } : { value: values, next: index };
}

function parseScope(lines: readonly string[], start: number): { value?: Readonly<Record<string, readonly string[]>>; next: number } {
  const scope: Record<string, readonly string[]> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    if (!line.startsWith("  ") || line.startsWith("    ") || line.includes("\t")) break;
    const pair = keyValue(line.slice(2));
    if (pair === undefined || !SCOPE_KEYS.has(pair[0]) || pair[0] in scope) return { next: lines.length };
    const [key, rest] = pair;
    if (rest.trim() === "") {
      const list = parseList(lines, index + 1, "    ");
      if (list.value === undefined) return { next: lines.length };
      scope[key] = list.value;
      index = list.next;
      continue;
    }
    const list = inlineList(rest);
    if (list === undefined) return { next: lines.length };
    scope[key] = list;
    index += 1;
  }
  return Object.keys(scope).length === 0 ? { next: index } : { value: scope, next: index };
}

function parseFrontmatter(frontmatter: string): ParsedFrontmatter | undefined {
  const lines = frontmatter.split("\n");
  const result: Record<string, string | readonly string[] | Readonly<Record<string, readonly string[]>>> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.startsWith("#")) {
      index += 1;
      continue;
    }
    if (/^\s/u.test(line) || line.includes("\t")) return undefined;
    const pair = keyValue(line);
    if (pair === undefined || !TOP_LEVEL_KEYS.has(pair[0]) || pair[0] in result) return undefined;
    const [key, rest] = pair;
    if (key === "scope") {
      if (rest.trim() === "{}") {
        result[key] = {};
        index += 1;
        continue;
      }
      if (rest.trim() !== "") return undefined;
      const parsed = parseScope(lines, index + 1);
      if (parsed.value === undefined) return undefined;
      result[key] = parsed.value;
      index = parsed.next;
      continue;
    }
    if (key === "sources" || NASH_SU_LIST_KEYS.has(key)) {
      const parsedInline = inlineList(rest);
      if (parsedInline !== undefined) {
        result[key] = parsedInline;
        index += 1;
        continue;
      }
      if (rest.trim() !== "") return undefined;
      const parsed = parseList(lines, index + 1, "  ");
      if (parsed.value === undefined) return undefined;
      result[key] = parsed.value;
      index = parsed.next;
      continue;
    }
    const parsed = scalar(rest);
    if (parsed === undefined) return undefined;
    result[key] = parsed;
    index += 1;
  }
  return result;
}

function recordOfLists(value: unknown): value is Readonly<Record<string, readonly string[]>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string"));
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizedScope(value: Readonly<Record<string, readonly string[]>>): ContextPageScopeV1 | undefined {
  for (const [key, entries] of Object.entries(value)) {
    if (!SCOPE_KEYS.has(key) || entries.some((entry) => entry === "" || entry !== entry.trim())) return undefined;
    if (key === "stages" && entries.some((entry) => !STAGES.has(entry as ContextStage))) return undefined;
  }
  return Object.fromEntries(Object.entries(value).filter(([, entries]) => entries.length > 0)) as ContextPageScopeV1;
}

function restrictedBodyIsOpaque(body: string): boolean {
  const lines = body.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.length > 0 && lines.every(isOpaqueRestrictedReference);
}

export function parseContextPageMetadata(content: string): ContextPageParseV1 {
  if (!content.startsWith("---\n")) return { valid: false, body: "", reason: "frontmatter" };
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return { valid: false, body: "", reason: "frontmatter" };
  const parsed = parseFrontmatter(content.slice(4, end));
  const body = content.slice(end + 5);
  if (parsed === undefined) return { valid: false, body: "", reason: "frontmatter" };

  const schema = parsed["schema"];
  const title = parsed["title"];
  const pageType = parsed["page_type"];
  const status = parsed["status"];
  const confidence = parsed["confidence"];
  const updatedAt = parsed["updated_at"];
  const scopeValue = parsed["scope"];
  const sources = parsed["sources"];
  const sensitivity = parsed["sensitivity"];
  if (
    schema !== CONTEXT_PAGE_V1 || typeof title !== "string" || title.trim() === "" ||
    typeof pageType !== "string" || pageType.trim() === "" ||
    !(["active", "deprecated", "proposed"] as const).includes(status as "active") ||
    !(["approved", "source", "inferred", "low"] as const).includes(confidence as "approved") ||
    typeof updatedAt !== "string" || !validDate(updatedAt) || !recordOfLists(scopeValue) ||
    !Array.isArray(sources) || !sources.every((source) => typeof source === "string" && isSafeLlmWikiSourceReference(source)) ||
    !(["public", "internal", "restricted_reference"] as const).includes(sensitivity as "public")
  ) return { valid: false, body: "", reason: "frontmatter" };

  const scope = normalizedScope(scopeValue);
  if (scope === undefined) return { valid: false, body: "", reason: "frontmatter" };
  if (sensitivity === "restricted_reference" && !restrictedBodyIsOpaque(body)) {
    return { valid: false, body: "", reason: "restricted_reference" };
  }

  return {
    valid: true,
    body,
    metadata: {
      schema: CONTEXT_PAGE_V1,
      title,
      page_type: pageType,
      status: status as ContextPageMetadataV1["status"],
      confidence: confidence as ContextPageMetadataV1["confidence"],
      updated_at: updatedAt,
      scope,
      sources: sources as readonly string[],
      sensitivity: sensitivity as ContextPageMetadataV1["sensitivity"],
    },
  };
}
