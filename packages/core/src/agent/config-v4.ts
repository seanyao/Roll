/**
 * @responsibility Normalizes the v3/v4 project agent route profile into one typed shape.
 * US-V4-003 — pure normalizer for the project route profile (`.roll/agents.yaml`).
 *
 * Both the v3 slot form and the v4 rig/routing/execution-profile form load into
 * ONE normalized shape ({@link NormalizedAgentConfig}). The CLI calls this rather
 * than parsing YAML ad hoc. Parsing + normalization are pure (text in, structure
 * out) so they are exhaustively unit-testable and free of I/O.
 *
 * Compatibility (arch §11):
 *   - v3 `easy/default/hard/fallback` inline slots still load + normalize.
 *   - `easy/default/hard/fallback` are ROUTE SLOTS only — never Agent/Rig types.
 *   - missing `execution_profiles` → `standard` only.
 *   - missing `supervisor` → disabled.
 *   - unknown rig refs / malformed role bindings are reported as fail-loud
 *     `errors` (the caller decides whether to fail closed).
 *
 * The repo ships no YAML library by design, so this module carries a small block
 * YAML parser for the bounded subset agents.yaml uses (2-space block maps, inline
 * `{ k: v }` flow maps, scalars, null).
 */
import {
  ROUTE_SLOTS,
  EXECUTION_PROFILES,
  ROLE_NAMES,
  type AgentConfigParse,
  type AgentName,
  type ExecutionPolicy,
  type ExecutionProfile,
  type ExecutionProfileSpec,
  type NormalizedAgentConfig,
  type ResolvedSlot,
  type Rig,
  type RoleBinding,
  type RoleName,
  type RouteSlot,
  type SupervisorConfig,
} from "@roll/spec";
import { parseEffort } from "./effort.js";
import { canonicalAgentName, agentIsKnown, readSlotFromText, type AgentSlot, type SlotConfig } from "./registry.js";

// ── minimal block-YAML parser (bounded subset) ───────────────────────────────

type YamlValue = string | number | boolean | null | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

/** Strip a trailing ` # comment` that sits outside any `{...}` / quotes, plus a
 *  whole-line comment. Conservative: only treats ` #` (space-hash) as a comment
 *  start so a `#` inside a value (rare) is preserved. */
function stripComment(line: string): string {
  // whole-line comment
  if (/^\s*#/.test(line)) return "";
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === "#" && depth === 0 && i > 0 && line[i - 1] === " ") {
      return line.slice(0, i);
    }
  }
  return line;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n += 1;
  return n;
}

/** The index of the `:` that separates a block key from its value — the first
 *  top-level `:` (outside `{}`). Returns -1 when there is none. */
function keyColon(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseScalar(raw: string): YamlValue {
  const t = raw.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  // A bare number (but NOT a model id like `gpt-5` or `deepseek-v4-pro:high`).
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return unquote(t);
}

/** Parse an inline flow map `{ agent: codex, model: gpt-5 }` → YamlMap. */
function parseFlowMap(raw: string): YamlMap {
  const inner = raw.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  const map: YamlMap = {};
  if (inner === "") return map;
  // split on top-level commas (no nested flow maps in agents.yaml)
  for (const part of inner.split(",")) {
    const seg = part.trim();
    if (seg === "") continue;
    const c = seg.indexOf(":");
    if (c < 0) continue;
    map[unquote(seg.slice(0, c).trim())] = parseScalar(seg.slice(c + 1));
  }
  return map;
}

function parseValue(raw: string): YamlValue {
  const t = raw.trim();
  if (t.startsWith("{")) return parseFlowMap(t);
  return parseScalar(t);
}

/** Parse the bounded YAML subset into a nested {@link YamlMap}. Never throws —
 *  unparseable lines are skipped (the normalizer reports semantic errors). */
export function parseBlockYaml(text: string): YamlMap {
  const lines = text
    .split("\n")
    .map(stripComment)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && l.trim() !== "---");
  let i = 0;
  function parseMap(indent: number): YamlMap {
    const map: YamlMap = {};
    while (i < lines.length) {
      const line = lines[i] as string;
      const ind = leadingSpaces(line);
      if (ind < indent) break;
      if (ind > indent) {
        // stray deeper line with no parent key — skip defensively
        i += 1;
        continue;
      }
      const trimmed = line.trim();
      const colon = keyColon(trimmed);
      if (colon < 0) {
        i += 1;
        continue;
      }
      const key = unquote(trimmed.slice(0, colon).trim());
      const rest = trimmed.slice(colon + 1).trim();
      i += 1;
      if (rest === "") {
        const nextInd = i < lines.length ? leadingSpaces(lines[i] as string) : -1;
        map[key] = nextInd > indent ? parseMap(nextInd) : null;
      } else {
        map[key] = parseValue(rest);
      }
    }
    return map;
  }
  return parseMap(0);
}

// ── normalization ────────────────────────────────────────────────────────────

function isMap(v: unknown): v is YamlMap {
  return typeof v === "object" && v !== null;
}

/** Resolve a YAML map `{ agent, model? }` to a {@link Rig}, canonicalizing the
 *  agent name. Returns null (with an error pushed) on a missing/unknown agent. */
function toRig(node: YamlMap, where: string, errors: string[]): Rig | null {
  const rawAgent = typeof node["agent"] === "string" ? (node["agent"] as string) : "";
  if (rawAgent === "") {
    errors.push(`${where}: missing 'agent'`);
    return null;
  }
  const agent = canonicalAgentName(rawAgent);
  if (!agentIsKnown(agent)) {
    errors.push(`${where}: unknown agent '${rawAgent}'`);
    return null;
  }
  const model = typeof node["model"] === "string" && node["model"] !== "" ? (node["model"] as string) : undefined;
  return model !== undefined ? { agent: agent as AgentName, model } : { agent: agent as AgentName };
}

const DEFAULT_STANDARD: ExecutionProfileSpec = {
  profile: "standard",
  roles: { builder: { kind: "routing", route: "default" } },
};

function defaultExecutionPolicy(): ExecutionPolicy {
  // Conservative default: behave like today (builder-only) until a project opts
  // into `auto`/verified/designed. No regression for v3 configs.
  return { mode: "standard", defaultProfile: "standard" };
}

function disabledSupervisor(): SupervisorConfig {
  return { enabled: false, mode: "observe", maxParallelCycles: 1, budgetPerDay: null };
}

function parseRoleBinding(node: YamlValue | undefined, where: string, errors: string[]): RoleBinding | null {
  if (!isMap(node)) {
    errors.push(`${where}: malformed role binding (expected a map)`);
    return null;
  }
  const rigRef = node["rig"];
  const route = node["routing"];
  const def = node["default-agent"];
  if (typeof rigRef === "string" && rigRef !== "") return { kind: "rig", rig: rigRef };
  if (typeof route === "string" && (ROUTE_SLOTS as readonly string[]).includes(route)) {
    return { kind: "routing", route: route as RouteSlot };
  }
  if (def === true || def === null || (typeof route === "string" && route !== "")) {
    if (typeof route === "string" && route !== "" && !(ROUTE_SLOTS as readonly string[]).includes(route)) {
      errors.push(`${where}: unknown route slot '${route}'`);
      return null;
    }
    return { kind: "default-agent" };
  }
  errors.push(`${where}: malformed role binding (need one of rig|routing|default-agent)`);
  return null;
}

/**
 * Normalize a `.roll/agents.yaml` text (v3 OR v4) into the single
 * {@link NormalizedAgentConfig} shape. Pure + total: an empty/absent file yields
 * sane defaults (v3, no rigs, standard-only, supervisor disabled). Unknown rig
 * refs and malformed role bindings surface as `errors`.
 */
export function normalizeAgentConfig(text: string): AgentConfigParse {
  const errors: string[] = [];
  const root = parseBlockYaml(text ?? "");
  const schema: "v3" | "v4" = root["schema"] === "v4" ? "v4" : "v3";

  // US-PAIR-013: effort — gate → required rig distance. Absent means `standard`;
  // parse errors surface as fail-loud signals rather than degrading to `off`.
  const effortParse = parseEffort(root["effort"]);
  errors.push(...effortParse.errors);

  // rigs: named agent×model map (v4 only).
  const rigs: Record<string, Rig> = {};
  if (isMap(root["rigs"])) {
    for (const [name, node] of Object.entries(root["rigs"] as YamlMap)) {
      if (!isMap(node)) {
        errors.push(`rigs.${name}: malformed rig (expected a map)`);
        continue;
      }
      const r = toRig(node, `rigs.${name}`, errors);
      if (r !== null) rigs[name] = r;
    }
  }

  // routing: the v4 `routing:` block (slot → rigRef) takes precedence; otherwise
  // the v3 inline top-level slots (slot → { agent, model }).
  const routing: Partial<Record<RouteSlot, ResolvedSlot>> = {};
  const routingBlock = isMap(root["routing"]) ? (root["routing"] as YamlMap) : null;
  for (const slot of ROUTE_SLOTS) {
    if (routingBlock !== null && typeof routingBlock[slot] === "string") {
      const ref = routingBlock[slot] as string;
      const rig = rigs[ref];
      if (rig === undefined) {
        errors.push(`routing.${slot}: unknown rig ref '${ref}'`);
        continue;
      }
      routing[slot] = { rig, ref };
    } else if (isMap(root[slot])) {
      const r = toRig(root[slot] as YamlMap, slot, errors);
      if (r !== null) routing[slot] = { rig: r };
    }
  }

  // execution_profiles: parse the given ones; standard is ALWAYS present.
  const executionProfiles: Record<ExecutionProfile, ExecutionProfileSpec> = {
    standard: DEFAULT_STANDARD,
  } as Record<ExecutionProfile, ExecutionProfileSpec>;
  if (isMap(root["execution_profiles"])) {
    const block = root["execution_profiles"] as YamlMap;
    if (block["planned"] !== undefined) {
      errors.push("execution_profiles.planned: legacy profile key removed; use execution_profiles.designed");
      const legacy = block["planned"];
      if (isMap(legacy) && isMap(legacy["roles"]) && (legacy["roles"] as YamlMap)["planner"] !== undefined) {
        errors.push("execution_profiles.planned.roles.planner: legacy role key removed; use roles.designer");
      }
    }
    for (const profile of EXECUTION_PROFILES) {
      const node = block[profile];
      if (!isMap(node)) continue;
      const rolesNode = isMap(node["roles"]) ? (node["roles"] as YamlMap) : null;
      if (rolesNode === null) {
        errors.push(`execution_profiles.${profile}: missing 'roles'`);
        continue;
      }
      const roles: Partial<Record<RoleName, RoleBinding>> = {};
      if (rolesNode["planner"] !== undefined) {
        errors.push(`execution_profiles.${profile}.roles.planner: legacy role key removed; use roles.designer`);
      }
      for (const role of ROLE_NAMES) {
        if (rolesNode[role] === undefined) continue;
        const binding = parseRoleBinding(rolesNode[role], `execution_profiles.${profile}.roles.${role}`, errors);
        if (binding !== null) roles[role] = binding;
      }
      executionProfiles[profile] = { profile, roles };
    }
  }

  // execution_policy: flat { mode, default_profile }.
  let executionPolicy = defaultExecutionPolicy();
  if (isMap(root["execution_policy"])) {
    const block = root["execution_policy"] as YamlMap;
    const mode = block["mode"];
    const dp = block["default_profile"];
    if (mode === "planned") {
      errors.push("execution_policy.mode: legacy value 'planned' removed; use 'designed'");
    }
    if (dp === "planned") {
      errors.push("execution_policy.default_profile: legacy value 'planned' removed; use 'designed'");
    }
    executionPolicy = {
      mode:
        mode === "verified" || mode === "designed" || mode === "auto" || mode === "standard"
          ? mode
          : defaultExecutionPolicy().mode,
      defaultProfile:
        dp === "verified" || dp === "designed" || dp === "standard" ? dp : defaultExecutionPolicy().defaultProfile,
    };
  }

  // supervisor: missing → disabled.
  let supervisor = disabledSupervisor();
  if (isMap(root["supervisor"])) {
    const block = root["supervisor"] as YamlMap;
    const mode = block["mode"];
    const budget = block["budget_per_day"];
    const maxPar = block["max_parallel_cycles"];
    supervisor = {
      enabled: block["enabled"] === true,
      mode: mode === "advise" || mode === "schedule" || mode === "observe" ? mode : "observe",
      maxParallelCycles: typeof maxPar === "number" && maxPar > 0 ? Math.floor(maxPar) : 1,
      budgetPerDay: typeof budget === "number" && budget >= 0 ? budget : null,
    };
  }

  return {
    config: { schema, rigs, routing, executionProfiles, executionPolicy, supervisor, effort: effortParse.effort },
    errors,
  };
}

/**
 * FIX-1249 — resolve a route SLOT to its `{ agent, model? }` for the runtime
 * router, understanding BOTH agents.yaml shapes:
 *   - `roll-agents/v1` / v4: `rigs:` + `routing: { <slot>: <rigRef> }` — the
 *     rig's model rides through so a configured model reaches the spawn.
 *   - legacy v3: top-level inline `<slot>: { agent, model? }`.
 *
 * The v4 `routing:` block wins (via {@link normalizeAgentConfig}); the legacy
 * inline reader is the defensive fallback. Returns undefined when the slot is
 * unresolved.
 *
 * This replaces the router's previous direct call to {@link readSlotFromText},
 * which only understood the legacy inline form — so a project on the `rigs:` +
 * `routing:` schema had its per-agent model silently dropped and the spawn fell
 * back to a source-baked default (the FIX-1249 defect).
 */
export function readRouteSlot(text: string, slot: AgentSlot): SlotConfig | undefined {
  const { config } = normalizeAgentConfig(text);
  const resolved = config.routing[slot];
  if (resolved !== undefined) {
    const { agent, model } = resolved.rig;
    return model !== undefined && model !== "" ? { agent, model } : { agent };
  }
  return readSlotFromText(text, slot);
}
