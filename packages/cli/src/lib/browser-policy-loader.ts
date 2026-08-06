/**
 * @responsibility Loads the project browser-operations policy.
 */
/**
 * US-BROW-018 — Project browser-operations policy loader.
 *
 * Reads the `browser_operations` block from `<cwd>/.roll/policy.yaml` and merges
 * it with the DEFAULT_BROWSER_POLICY.  An absent/invalid file yields the default
 * (everything-disabled) policy — the managed lane stays locked until the owner
 * explicitly opts in.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BROWSER_POLICY } from "@roll/core";
import type { BrowserOperationsPolicy } from "@roll/spec";

/**
 * Load the browser operations policy from `<cwd>/.roll/policy.yaml`.
 *
 * Merges the `browser_operations` block with default policy. Missing /
 * invalid files produce the default (everything-disabled) policy.
 */
export function loadBrowserPolicy(cwd: string): BrowserOperationsPolicy {
  const policyPath = join(cwd, ".roll", "policy.yaml");
  let raw: string;
  try {
    if (!existsSync(policyPath)) return { ...DEFAULT_BROWSER_POLICY };
    raw = readFileSync(policyPath, "utf8");
  } catch {
    return { ...DEFAULT_BROWSER_POLICY };
  }

  const parsed = parseBrowserOpsYaml(raw);
  return deepMergePolicy(DEFAULT_BROWSER_POLICY, parsed);
}

// ── Minimal YAML parser for browser_operations ───────────────────────────────

type YamlValue = string | boolean | number | string[] | Record<string, unknown>;
type YamlMap = Record<string, YamlValue>;

interface ParsedBrowserPolicy {
  enabled?: boolean;
  devtoolsServer?: string;
  managed?: Partial<YamlMap>;
  interactive?: Partial<YamlMap>;
}

function parseBrowserOpsYaml(raw: string): ParsedBrowserPolicy {
  const result: ParsedBrowserPolicy = {};
  // Pre-split and trim empty tail so array access is safe.
  const allLines = raw.replace(/\n$/, "").split("\n");
  let inBrowserOps = false;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i]!;
    if (/^\s*(#|$)/.test(line)) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (indent === 0) {
      inBrowserOps = key === "browser_operations";
      continue;
    }

    if (!inBrowserOps) continue;

    // US-BROW-020: children of a 2-space-indented `browser_operations:` block sit
    // at indent 2 — including the `managed:`/`interactive:` lane mappings. The
    // original loader looked for lanes one level deeper (indent 4), so no real
    // policy file could ever enable a lane; the live gate caught it.
    if (indent === 2) {
      if ((key === "managed" || key === "interactive") && rawValue === "") {
        result[key] = parseLanePolicy(allLines, i + 1, indent);
      } else if (key === "enabled" || key === "devtools_server" || key === "devtoolsServer") {
        const target = key === "devtools_server" ? "devtoolsServer" : key;
        result[target as keyof ParsedBrowserPolicy] = parseYamlScalar(rawValue) as never;
      }
    }
  }

  return result;
}

function parseYamlScalar(raw: string): string | boolean | number | string[] {
  const v = raw.replace(/#.*$/, "").trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  // Flow sequence: `[a, b, c]` — the dialect real policy files use for origin
  // and action lists.
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => String(parseYamlScalar(item)));
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Policy files use snake_case keys; the merged policy object is camelCase. */
function camelizeKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function parseLanePolicy(lines: string[], startIdx: number, laneIndent: number): YamlMap {
  const result: YamlMap = {};
  let currentListKey: string | null = null;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(#|$)/.test(line)) continue;
    const indent = line.search(/\S/);
    if (indent <= laneIndent) break; // dedented past lane sub-block

    const trimmed = line.trim();

    // Block sequence item: "- value"
    if (trimmed.startsWith("- ")) {
      if (currentListKey !== null) {
        const item = trimmed.slice(2).trim();
        const existing = result[currentListKey];
        const arr: string[] = Array.isArray(existing) ? existing as string[] : [];
        arr.push(item);
        result[currentListKey] = arr;
      }
      continue;
    }

    // Key: value
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;
    const key = camelizeKey(trimmed.slice(0, colonIdx).trim());
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (rawValue === "") {
      // Empty value → this key starts a block sequence
      currentListKey = key;
      result[key] = parseBlockSequence(lines, i + 1, indent);
    } else {
      currentListKey = null;
      result[key] = parseYamlScalar(rawValue);
    }
  }
  return result;
}

function parseBlockSequence(lines: string[], startIdx: number, keyIndent: number): string[] {
  const items: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(#|$)/.test(line)) continue;
    const indent = line.search(/\S/);
    if (indent <= keyIndent) break;
    const itemMatch = /^\s*-\s+(.*)$/.exec(line);
    if (itemMatch?.[1] !== undefined) items.push(itemMatch[1].trim());
  }
  return items;
}

// ── Deep merge ───────────────────────────────────────────────────────────────

function deepMergePolicy(
  base: BrowserOperationsPolicy,
  partial: ParsedBrowserPolicy,
): BrowserOperationsPolicy {
  const merged = { ...base };
  if (typeof partial.enabled === "boolean") merged.enabled = partial.enabled;
  if (typeof partial.devtoolsServer === "string") merged.devtoolsServer = partial.devtoolsServer;
  if (partial.managed) {
    merged.managed = mergeLanePolicy(base.managed, partial.managed);
  }
  if (partial.interactive) {
    merged.interactive = mergeLanePolicy(base.interactive, partial.interactive);
  }
  return merged;
}

function mergeLanePolicy(
  base: BrowserOperationsPolicy["managed"],
  partial: Partial<YamlMap>,
): BrowserOperationsPolicy["managed"] {
  const lane = { ...base };
  if (typeof partial["enabled"] === "boolean") lane.enabled = partial["enabled"] as boolean;
  if (partial["allowedOrigins"] && Array.isArray(partial["allowedOrigins"])) {
    lane.allowedOrigins = partial["allowedOrigins"] as string[];
  }
  if (partial["allowedActions"] && Array.isArray(partial["allowedActions"])) {
    lane.allowedActions = partial["allowedActions"] as unknown as BrowserOperationsPolicy["managed"]["allowedActions"];
  }
  if (typeof partial["maxRunsPerCycle"] === "number") lane.maxRunsPerCycle = partial["maxRunsPerCycle"] as number;
  if (typeof partial["performanceDiagnostics"] === "boolean") lane.performanceDiagnostics = partial["performanceDiagnostics"] as boolean;
  if (typeof partial["timeoutMs"] === "number") lane.timeoutMs = partial["timeoutMs"] as number;
  return lane;
}
