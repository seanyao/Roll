import { isSafeContextPath } from "@roll/spec";

export const LLM_WIKI_REQUIRED_PATHS = [
  "purpose.md",
  "schema.md",
  "wiki/index.md",
  "wiki/log.md",
] as const;

const RESERVED_READABLE_PATHS = new Set<string>(LLM_WIKI_REQUIRED_PATHS);
const FORBIDDEN_SEGMENTS = new Set([".git", ".llm-wiki", ".obsidian", "credentials"]);

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

export function isReadableLlmWikiPath(path: string): boolean {
  return RESERVED_READABLE_PATHS.has(path) || (path.endsWith(".md") && isSafeContextPath(path, false));
}

export function planLlmWikiRevisionPaths(
  entrypoints: readonly string[] = ["wiki/index.md"],
  refs: readonly string[] = [],
): readonly string[] {
  return stableUnique([...LLM_WIKI_REQUIRED_PATHS, ...entrypoints, ...refs]);
}

export function isSafeLlmWikiSourceReference(value: string): boolean {
  if (value === "" || value !== value.trim() || value.includes("\\") || /[\x00-\x1f\x7f]/u.test(value)) return false;

  if (/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value)) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]*@/u.test(value)) return false;
    return !/^(?:file|data|javascript):/iu.test(value);
  }

  if (value.startsWith("/") || value.includes("//")) return false;
  const segments = value.split("/");
  if (segments.some((segment) =>
    segment === "" || segment === "." || segment === ".." || segment.startsWith(".") ||
    segment.startsWith("-") || FORBIDDEN_SEGMENTS.has(segment)
  )) return false;
  return value.startsWith("raw/sources/") || value.startsWith("wiki/");
}

export function isOpaqueRestrictedReference(value: string): boolean {
  const candidate = value.startsWith("- ") ? value.slice(2).trim() : value;
  if (/^(?:secret|vault):\/\/[^\s]+$/u.test(candidate)) {
    return !/^(?:secret|vault):\/\/[^/\s]*@/u.test(candidate);
  }
  return /^(?:secret-ref|credential-ref):[^\s]+$/u.test(candidate);
}
