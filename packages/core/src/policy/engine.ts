/**
 * @responsibility Applies policy decisions to observed loop and delivery facts.
 * PolicyEngine — parse + enforce `.roll/policy.yaml` (US-CORE-010).
 *
 * v2 reality vs v3 spec
 * ─────────────────────
 * v2 has NO `policy.yaml`. After FIX-172~175 the operative config is
 * `.roll/local.yaml` (loop_schedule / loop_gc / `agent:` default slot) plus the
 * agents-routes template; routing in bin/roll resolves a single default slot
 * (`_project_agent`, `_loop_resolve_agent` ~bin/roll:384-438) — there is no
 * level/type rule table, no `max_consecutive_failures` knob, no budget block.
 * The only consecutive-failure counter in v2 is the roll-meta sync one
 * (US-LOOP-057, bin/roll:11202-11211: 3 strikes → ALERT), and the only
 * "fail-loud pause" channel is the PAUSE sentinel file (bin/roll:9412-9416).
 *
 * The v3 spec (.roll/v3/specs/architecture.md §5.1 routing, §6.1 loop_safety +
 * budget) defines the RICHER `policy.yaml`. This module implements the PARSER for
 * that v3 shape while preserving v2 semantics where they exist:
 *   - first-match, deterministic, NO history (D1/I10) — exactly v2's
 *     "same input → same route", just generalised from one slot to a rule table.
 *   - `max_consecutive_failures` default 3 mirrors the only v2 strike count.
 *   - `action_on_breach: pause_and_notify` is v2's PAUSE-sentinel channel.
 *   - the cost/budget ceiling is REMOVED — the loop now stops on NO PROGRESS
 *     (a deterministic dead-loop breaker), not on a dollar ceiling; this parser
 *     ignores any stale `budget:` block a user policy.yaml may still carry.
 *
 * NEW v3 AC (B-group) — 防误伤非本项目仓: refuse to run in a non-compliant repo.
 * v2's structural guard is the FIX-065 tripwire (bin/roll:7917-7934): before any
 * loop write it refuses when the target lands under prod `~/.shared/roll` from a
 * test/temp context. The capability-map indexes this as 结构护栏 (~13700). We
 * mirror the INTENT — "only operate on a real roll project, never a stray repo" —
 * as {@link repoComplianceVerdict}: a structural check that the cwd is a git repo
 * carrying the roll markers (`.roll/` dir + `.roll/backlog.md`), declining
 * otherwise so the loop never mutates an unrelated checkout.
 *
 * Purity: the parser is a pure string→struct function; rule matching and the
 * compliance verdict are pure. Filesystem probes for compliance are injected as
 * boolean facts ({@link RepoMarkers}); core reads no files itself.
 */
import type { ResumeScope } from "../agent/session-reuse.js";

// ── policy.yaml shape (architecture §5.1 + §6.1) ─────────────────────────────

/** A routing rule's match clause — level and/or a type glob. */
export interface PolicyMatch {
  /** `epic` | `feature` | `story` | `action`, or a `|`-alternation, or `*`. */
  level?: string;
  /** `US-*` | `FIX-*|REFACTOR-*` | `*`, etc. — a `|`-alternation of globs. */
  type?: string;
}

/** One `model_routing` rule (architecture §5.1). */
export interface PolicyRoutingRule {
  match: PolicyMatch;
  agent: string;
  model: string;
  /** Availability fallback slot — pre-spawn only, NOT a failure-retry chain (I6). */
  fallback?: { agent: string; model: string };
  rationale?: string;
}

/** `loop_safety` block (architecture §6.1) — fail-loud + cost ceiling together. */
export interface LoopSafetyConfig {
  /** Consecutive failures before pause+notify (default 3; v2 strike count). */
  maxConsecutiveFailures: number;
  /** Action when the consecutive-failure ceiling trips. */
  actionOnBreach: string;
  /** FIX-207 acceptance-report gate escalation. Absent ⇒ soft (record-only);
   *  `hard` makes a delivery with no fresh acceptance report fail the cycle. */
  attestGate?: "soft" | "hard";
  /** FIX-293 peer-review gate escalation. Absent ⇒ hard (the owner default —
   *  high-complexity work without peer evidence is blocked + retried, not self-
   *  scored); set `soft` to keep the old record-only behaviour explicitly. */
  peerGate?: "soft" | "hard";
  /** FIX-1234 — what a HARD peer gate does when the retry consult finds the
   *  whole peer pool unable to answer (timeout-class pool failure). Absent ⇒
   *  `block` (FIX-312 owner ruling unchanged: no evidence ⇒ NOT-Done). Set
   *  `degrade` on projects with a small/flaky pool: the cycle records a
   *  first-class `peer_unavailable` evidence file + ALERT and falls back to the
   *  recorded self-review verdict instead of deadlocking every delivery
   *  (intel-radar 2026-07-07: the only hetero peer timed out on every cycle).
   *  The Review Score gate still applies — quality floor is not waived. */
  peerOnPoolTimeout?: "block" | "degrade";
  /** US-EVID-016: same failure signal repetitions before PAUSE (single-card oscillation folded in via REFACTOR-069). */
  correctionSignalThreshold: number;
  /** US-EVID-016: seconds in the repeated-signal window. */
  correctionSignalWindowSec: number;
  /** US-EVID-014: conservative records/alerts only; auto mutates backlog. */
  correctionActuator: "conservative" | "auto";
  /** FIX-298 network-guard recovery hook. A shell command the network guard runs
   *  to ACTIVELY enable connectivity (e.g. turn on the user's proxy) when the
   *  first-checkpoint connectivity probe fails, before it re-checks. PORTABILITY:
   *  no proxy tool is hardcoded — the user sets their own command here; absent ⇒
   *  no auto-enable (the guard halts-and-tells). Absent ⇒ undefined. */
  proxyEnableCmd?: string;
  /** FIX-1025 network-guard probe TARGET override. The connectivity precheck
   *  defaults to a well-known foreign host (github.com), which a domestic-only
   *  workflow never needs and a dropped VPN makes unreachable — wrongly halting
   *  loop/release even though every CONFIGURED provider is directly reachable.
   *  Set this to a host:port (or URL) you DO need reachable (e.g. your model /
   *  embedding provider) so the precheck probes what the work actually uses.
   *  Absent ⇒ undefined (probe the default host). */
  probeUrl?: string;
  /** FIX-1025 network-guard OPT-OUT. When true, the connectivity precheck is
   *  skipped entirely — for users whose configured providers are reachable
   *  directly and who do not want a fixed-host probe to gate their work. Absent /
   *  false ⇒ the precheck runs as before. */
  skipNetworkCheck?: boolean;
  /** FIX-338 (Phase B 杠杆1) execute-speed lever: PREBUILD the workspace dist into
   *  a fresh cycle worktree right after deps install, so the working agent finds
   *  `dist/roll.mjs` already built (saving the cold round-trips to locate + build
   *  the entry point). Agent-AGNOSTIC (any engine benefits) and does NOT break
   *  cycle isolation (each cycle still bases on fresh origin/main; dist is just a
   *  prebuilt, gitignored artifact). DEFAULT-OFF (`稳字纪律`): absent ⇒ false, so
   *  deploy is a NO-OP until `prebuild_dist: true` is explicitly flipped on. */
  prebuildDist?: boolean;
  /** FIX-338 (Phase B 杠杆2) execute-speed lever: INJECT a concise PROJECT MAP into
   *  the working agent's initial context at spawn (the repo's shallow top-level
   *  structure + the card's relevant files), so the agent does NOT burn execute
   *  time on sed/rg exploration just to build its mental model (FIX-338 analysis:
   *  codex spends ~minutes on cold structure-discovery; target省 2-4min). The map
   *  is CONCISE and BOUNDED (hard char cap — never bloat the already-lean prompt).
   *  Agent-AGNOSTIC (a structure map benefits any engine; prepended into the same
   *  prompt body every agent shape consumes — no per-agent code) and does NOT break
   *  cycle isolation (read-only inspection of the cycle worktree). DEFAULT-OFF
   *  (`稳字纪律`): absent ⇒ false, so deploy is a NO-OP until `project_map: true` is
   *  explicitly flipped on. */
  projectMap?: boolean;
  /** FIX-1260: auto-repair evidence for draft PRs in the reconcile tick.
   *  When true (default), draft PRs that are CI green + evaluator approved +
   *  merge clean are auto-repaired, promoted to ready, and merged without
   *  human intervention. Set false to revert to manual supervisor intervention. */
  autoRepairEvidence: boolean;
  /** FIX-1267 — hard builder rotation: no two CONSECUTIVE loop cycles share a
   *  Builder agent (owner 2026-07-15, to evaluate the harness's ability to
   *  normalize heterogeneous agents). DEFAULT-ON: only an explicit
   *  `builder_no_consecutive_repeat: false` disables it. When on, the previous
   *  cycle's Builder is EXCLUDED from the execute pool; a pool that reduces to
   *  only that previous builder fails loud (ALERT + pending), never repeating it
   *  silently and never idle-spinning. */
  builderNoConsecutiveRepeat: boolean;
  /** lever-4 warm-context intent. Kept for compatibility, but it is not enough
   *  to resume by itself; {@link resumeScope} must also be explicitly same-story. */
  sessionReuse?: boolean;
  /** FIX-370: explicit warm-resume boundary. Absent / invalid ⇒ off. */
  resumeScope?: ResumeScope;
  /** FIX-907: per-cycle WALL-clock hard ceiling (seconds). A cycle running this
   *  long total is killed regardless of recent progress. Default 2700 (45min). */
  cycleWallTimeoutSec: number;
  /** FIX-907: per-cycle NO-PROGRESS idle window (seconds). A builder with no new
   *  commit AND no new stdout/event for this long is judged hung and killed.
   *  Keyed on last-progress time (not pure elapsed), so a slow-but-emitting call
   *  never trips. Default 900 (15min). */
  cycleNoProgressSec: number;
}

/** The whole parsed policy.yaml. */
export interface Policy {
  modelRouting: PolicyRoutingRule[];
  loopSafety: LoopSafetyConfig;
  pick: PickPolicyConfig;
}

export interface PickPolicyConfig {
  /** IDEA-069 semantic ranking is advisory and default-on unless explicitly off. */
  semanticRanking: "on" | "off";
}

/** Defaults mirroring the only v2 numbers (US-LOOP-057 strike count = 3). */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_ACTION_ON_BREACH = "pause_and_notify";
export const DEFAULT_CORRECTION_SIGNAL_THRESHOLD = 3;
export const DEFAULT_CORRECTION_SIGNAL_WINDOW_SEC = 12 * 60 * 60;
export const DEFAULT_CORRECTION_ACTUATOR = "conservative";
/** FIX-907: per-cycle WALL-clock hard ceiling (seconds) — default 45min. */
export const DEFAULT_CYCLE_WALL_TIMEOUT_SEC = 2700;
/** FIX-907: per-cycle NO-PROGRESS idle window (seconds) — default 15min. */
export const DEFAULT_CYCLE_NO_PROGRESS_SEC = 900;

// ── Minimal YAML parser for the policy.yaml shape ────────────────────────────
//
// Dependency-free, like the rest of the codebase (cli config-get hand-rolls its
// readers). Handles exactly the documented shape: a top-level `model_routing:`
// list of `- ` items whose fields may be inline-flow maps (`match: { … }`,
// `fallback: { … }`) or scalars, plus a `loop_safety:` mapping with a nested
// `budget:` mapping with a nested `upgrade_hint:` mapping. Comments (`# …`) and
// blank lines are ignored. Not a general YAML engine — it rejects nothing it
// doesn't understand, it simply ignores unknown keys (forward-compatible).

/** Strip a trailing ` # comment` (only when the `#` is preceded by whitespace or
 *  is the line start, so `#` inside a value like a url fragment survives). */
function stripComment(s: string): string {
  // Find a `#` that begins a comment: at start, or preceded by whitespace.
  const m = /(^|\s)#/.exec(s);
  if (m === null) return s;
  // m.index points at the leading whitespace (or 0); the `#` is after group 1.
  return s.slice(0, m.index + (m[1]?.length ?? 0));
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse an inline-flow map `{ a: x, b: { c: y } }` → record of string values.
 *  Only one level of nesting is needed for our shape, but we parse generically
 *  enough by tracking brace depth for the top-level comma split. */
function parseFlowMap(body: string): Record<string, string> {
  const inner = body.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: Record<string, string> = {};
  // Split on top-level commas (none of our values contain nested braces).
  for (const pair of splitTopLevel(inner, ",")) {
    const idx = pair.indexOf(":");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = unquote(pair.slice(idx + 1).trim());
    if (key !== "") out[key] = val;
  }
  return out;
}

/** Split `s` on `sep` at brace depth 0 (so flow-map commas inside `{ }` don't
 *  split). Quotes are not nested in our shape, so depth tracking is enough. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line);
  return m?.[1]?.length ?? 0;
}

interface PreLine {
  indent: number;
  text: string;
}

/** Pre-tokenise: drop blank/comment lines, capture indent + de-commented text. */
function preprocess(yaml: string): PreLine[] {
  const out: PreLine[] = [];
  for (const raw of yaml.split("\n")) {
    const noComment = stripComment(raw.replace(/\r$/, ""));
    if (noComment.trim() === "") continue;
    out.push({ indent: indentOf(noComment), text: noComment.trimEnd() });
  }
  return out;
}

function numOr(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Parse policy.yaml text into a {@link Policy}. Forward-compatible: unknown keys
 * are ignored, missing blocks fall back to the v2-aligned defaults. Mirrors the
 * architecture §5.1/§6.1 shape exactly.
 */
export function parsePolicy(yaml: string): Policy {
  const lines = preprocess(yaml);
  const modelRouting: PolicyRoutingRule[] = [];
  let loopSafety: LoopSafetyConfig = {
    maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
    actionOnBreach: DEFAULT_ACTION_ON_BREACH,
    correctionSignalThreshold: DEFAULT_CORRECTION_SIGNAL_THRESHOLD,
    correctionSignalWindowSec: DEFAULT_CORRECTION_SIGNAL_WINDOW_SEC,
    correctionActuator: DEFAULT_CORRECTION_ACTUATOR,
    cycleWallTimeoutSec: DEFAULT_CYCLE_WALL_TIMEOUT_SEC,
    cycleNoProgressSec: DEFAULT_CYCLE_NO_PROGRESS_SEC,
    autoRepairEvidence: true,
    builderNoConsecutiveRepeat: true,
  };
  let pick: PickPolicyConfig = { semanticRanking: "on" };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === undefined || ln.indent !== 0) continue;
    if (ln.text.startsWith("model_routing:")) {
      i = parseModelRouting(lines, i + 1, modelRouting);
      i -= 1; // parseModelRouting returns the next-unconsumed index.
    } else if (ln.text.startsWith("loop_safety:")) {
      const [next, safety] = parseLoopSafety(lines, i + 1);
      loopSafety = safety;
      i = next - 1;
    } else if (ln.text.startsWith("pick:")) {
      const [next, parsedPick] = parsePickPolicy(lines, i + 1);
      pick = parsedPick;
      i = next - 1;
    }
  }
  return { modelRouting, loopSafety, pick };
}

/** Parse the `model_routing:` list starting at `start`; append rules; return the
 *  index of the first line at indent 0 (block end). */
function parseModelRouting(lines: PreLine[], start: number, out: PolicyRoutingRule[]): number {
  let i = start;
  let cur: Partial<PolicyRoutingRule> & { match: PolicyMatch } = { match: {} };
  let inItem = false;
  const flush = (): void => {
    if (inItem && cur.agent !== undefined && cur.model !== undefined) {
      out.push({ match: cur.match, agent: cur.agent, model: cur.model, ...(cur.fallback ? { fallback: cur.fallback } : {}), ...(cur.rationale !== undefined ? { rationale: cur.rationale } : {}) });
    }
  };
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === undefined) break;
    if (ln.indent === 0) break; // back to top level → block done.
    const isItemStart = ln.text.trimStart().startsWith("- ");
    if (isItemStart) {
      flush();
      cur = { match: {} };
      inItem = true;
    }
    // Normalise: an item-start line carries its first key after "- ".
    const body = ln.text.trimStart().replace(/^-\s+/, "");
    assignRuleField(cur, body);
  }
  flush();
  return i;
}

/** Assign one `key: value` (or inline-flow `key: { … }`) onto the current rule. */
function assignRuleField(cur: Partial<PolicyRoutingRule> & { match: PolicyMatch }, body: string): void {
  const idx = body.indexOf(":");
  if (idx < 0) return;
  const key = body.slice(0, idx).trim();
  const rest = body.slice(idx + 1).trim();
  switch (key) {
    case "match": {
      const m = parseFlowMap(rest);
      cur.match = {
        ...(m["level"] !== undefined ? { level: m["level"] } : {}),
        ...(m["type"] !== undefined ? { type: m["type"] } : {}),
      };
      break;
    }
    case "agent":
      cur.agent = unquote(rest);
      break;
    case "model":
      cur.model = unquote(rest);
      break;
    case "fallback": {
      const f = parseFlowMap(rest);
      if (f["agent"] !== undefined && f["model"] !== undefined) {
        cur.fallback = { agent: f["agent"], model: f["model"] };
      }
      break;
    }
    case "rationale":
      cur.rationale = unquote(rest);
      break;
    default:
      break;
  }
}

/** Parse the `loop_safety:` mapping from `start`; return
 *  [nextTopLevelIndex, config]. A stale nested `budget:` block (the removed cost
 *  ceiling) is ignored like any other unknown key. */
function parseLoopSafety(lines: PreLine[], start: number): [number, LoopSafetyConfig] {
  const flat: Record<string, string> = {};
  let i = start;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === undefined) break;
    if (ln.indent === 0) break;
    const text = ln.text.trim();
    const idx = text.indexOf(":");
    if (idx < 0) continue;
    const key = text.slice(0, idx).trim();
    const val = text.slice(idx + 1).trim();
    if (val !== "") flat[key] = unquote(val);
  }
  const cfg: LoopSafetyConfig = {
    maxConsecutiveFailures: numOr(flat["max_consecutive_failures"], DEFAULT_MAX_CONSECUTIVE_FAILURES),
    actionOnBreach: flat["action_on_breach"] ?? DEFAULT_ACTION_ON_BREACH,
    correctionSignalThreshold: numOr(flat["correction_signal_threshold"], DEFAULT_CORRECTION_SIGNAL_THRESHOLD),
    correctionSignalWindowSec: numOr(flat["correction_signal_window_sec"], DEFAULT_CORRECTION_SIGNAL_WINDOW_SEC),
    correctionActuator: flat["correction_actuator"] === "auto" ? "auto" : DEFAULT_CORRECTION_ACTUATOR,
    // FIX-907: per-cycle hard-timeout thresholds. A 0 / negative value DISABLES
    // that criterion (operator escape hatch); a garbage value falls back to the
    // default. Keyed by snake_case under `loop_safety:` (`cycle_wall_timeout_sec`
    // / `cycle_no_progress_sec`).
    cycleWallTimeoutSec: numOr(flat["cycle_wall_timeout_sec"], DEFAULT_CYCLE_WALL_TIMEOUT_SEC),
    cycleNoProgressSec: numOr(flat["cycle_no_progress_sec"], DEFAULT_CYCLE_NO_PROGRESS_SEC),
    ...(flat["attest_gate"] === "hard" || flat["attest_gate"] === "soft"
      ? { attestGate: flat["attest_gate"] as "soft" | "hard" }
      : {}),
    ...(flat["peer_gate"] === "hard" || flat["peer_gate"] === "soft"
      ? { peerGate: flat["peer_gate"] as "soft" | "hard" }
      : {}),
    // FIX-1234: opt-in downgrade when the peer POOL cannot answer (timeout
    // class). Default (absent) keeps the FIX-312 hard block.
    ...(flat["peer_on_pool_timeout"] === "degrade" || flat["peer_on_pool_timeout"] === "block"
      ? { peerOnPoolTimeout: flat["peer_on_pool_timeout"] as "block" | "degrade" }
      : {}),
    // FIX-298: the network-guard recovery hook. A non-empty string is the shell
    // command the guard runs to enable connectivity before re-checking.
    ...(flat["proxy_enable_cmd"] !== undefined && flat["proxy_enable_cmd"] !== ""
      ? { proxyEnableCmd: flat["proxy_enable_cmd"] }
      : {}),
    // FIX-1025: the connectivity-precheck probe TARGET override. A non-empty
    // string points the probe at a host the domestic workflow actually needs
    // (instead of the fixed foreign default), so a dropped VPN no longer halts
    // loop/release when every configured provider is directly reachable.
    ...(flat["probe_url"] !== undefined && flat["probe_url"] !== ""
      ? { probeUrl: flat["probe_url"] }
      : {}),
    // FIX-1025: the connectivity-precheck OPT-OUT. Only an explicit
    // `skip_network_check: true` disables the probe; anything else (absent /
    // false / garbage) leaves it on so the guard runs as before.
    ...(flat["skip_network_check"] === "true" ? { skipNetworkCheck: true } : {}),
    // FIX-338: the prebuild-dist execute-speed lever. DEFAULT-OFF — only an
    // explicit `prebuild_dist: true` turns it on; anything else (absent / false /
    // garbage) leaves it false so deploy stays a NO-OP (稳字纪律).
    ...(flat["prebuild_dist"] === "true" ? { prebuildDist: true } : {}),
    // FIX-338 (杠杆2): the project-map injection execute-speed lever. DEFAULT-OFF —
    // only an explicit `project_map: true` turns it on; anything else (absent /
    // false / garbage) leaves it false so deploy stays a NO-OP (稳字纪律).
    ...(flat["project_map"] === "true" ? { projectMap: true } : {}),
    // lever-4: the cross-card warm-context (session-reuse) execute-speed lever.
    // DEFAULT-OFF — only an explicit `session_reuse: true` turns it on; anything
    // else (absent / false / garbage) leaves it false so deploy stays a NO-OP
    // (稳字纪律) and every engine keeps its cold-spawn behavior.
    ...(flat["session_reuse"] === "true" ? { sessionReuse: true } : {}),
    ...(flat["resume_scope"] === "same-story" ? { resumeScope: "same-story" as const } : {}),
    // FIX-1260: auto-repair toggle. Only explicit `auto_repair_evidence: false`
    // disables it; anything else (absent / true / garbage) leaves the default on.
    autoRepairEvidence: flat["auto_repair_evidence"] === "false" ? false : true,
    // FIX-1267: hard builder rotation. DEFAULT-ON — only an explicit
    // `builder_no_consecutive_repeat: false` disables it; anything else (absent /
    // true / garbage) keeps the no-consecutive-repeat constraint on.
    builderNoConsecutiveRepeat: flat["builder_no_consecutive_repeat"] === "false" ? false : true,
  };
  return [i, cfg];
}

function parsePickPolicy(lines: PreLine[], start: number): [number, PickPolicyConfig] {
  const flat: Record<string, string> = {};
  let i = start;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === undefined) break;
    if (ln.indent === 0) break;
    const text = ln.text.trim();
    const idx = text.indexOf(":");
    if (idx < 0) continue;
    const key = text.slice(0, idx).trim();
    const val = text.slice(idx + 1).trim();
    if (val !== "") flat[key] = unquote(val);
  }
  return [i, { semanticRanking: flat["semantic_ranking"] === "off" ? "off" : "on" }];
}


// ── Rule matching (first-match, deterministic — D1/I10) ──────────────────────

/** Compile a `|`-alternation of globs (`US-*|FIX-*`) to a test. `*` matches any.
 *  Empty / undefined pattern matches everything (an absent dimension). */
function matchesPattern(value: string, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern.trim() === "" || pattern.trim() === "*") return true;
  const alts = pattern.split("|").map((a) => a.trim()).filter((a) => a !== "");
  if (alts.length === 0) return true;
  return alts.some((alt) => {
    if (alt === "*") return true;
    // Glob: escape regex specials, then turn `*` into `.*`. Anchored, case-sensitive.
    const re = new RegExp(`^${alt.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return re.test(value);
  });
}

/** The query a route resolution runs against the rule table. */
export interface RouteQuery {
  level: string;
  /** Story type token (e.g. `US-AUTH-001`) or bare type (`US`). Matched against
   *  the rule's `type` glob; we test the full id so `US-*` matches `US-AUTH-1`. */
  type: string;
}

/** A resolved route — agent/model + the matched rule index (audit anchor, I10). */
export interface ResolvedRoute {
  agent: string;
  model: string;
  fallback?: { agent: string; model: string };
  /** 0-based index of the matched rule (auditability). */
  ruleIndex: number;
  rationale?: string;
}

/**
 * Resolve a route by FIRST-MATCH over `modelRouting`, mirroring v2's
 * deterministic "same input → same route" (D1/I10) generalised to a rule table.
 * A rule matches iff BOTH its `match.level` and `match.type` globs match (an
 * absent dimension is a wildcard). Returns the first matching rule's
 * agent/model/fallback + its index, or `null` when nothing matches.
 */
export function resolvePolicyRoute(policy: Policy, query: RouteQuery): ResolvedRoute | null {
  for (let i = 0; i < policy.modelRouting.length; i++) {
    const rule = policy.modelRouting[i];
    if (rule === undefined) continue;
    if (!matchesPattern(query.level, rule.match.level)) continue;
    if (!matchesPattern(query.type, rule.match.type)) continue;
    return {
      agent: rule.agent,
      model: rule.model,
      ...(rule.fallback ? { fallback: rule.fallback } : {}),
      ruleIndex: i,
      ...(rule.rationale !== undefined ? { rationale: rule.rationale } : {}),
    };
  }
  return null;
}

// ── Repo compliance verdict (NEW v3 AC — 防误伤非本项目仓) ─────────────────────

/** Structural markers of a real roll project, probed by the caller (injected). */
export interface RepoMarkers {
  /** Is the cwd inside a git work tree? */
  isGitRepo: boolean;
  /** Does `.roll/` exist as a directory at the project root? */
  hasRollDir: boolean;
  /** Does `.roll/backlog.md` exist? */
  hasBacklog: boolean;
}

/** The compliance decision: run only on a structurally-compliant roll repo. */
export type ComplianceVerdict =
  | { compliant: true }
  | { compliant: false; reason: string; missing: string[] };

/**
 * Decide whether the loop may operate on this repo (防误伤非本项目仓). Mirrors the
 * INTENT of v2's structural guard (FIX-065 tripwire, bin/roll:7917-7934; indexed
 * 结构护栏 ~13700): never mutate a checkout that isn't a real roll project.
 * Compliant iff ALL markers are present: it is a git repo, has a `.roll/`
 * directory, and a `.roll/backlog.md`. Any missing marker → decline with the
 * list of what's absent, so the caller refuses to run rather than risk writing
 * into an unrelated repo.
 */
export function repoComplianceVerdict(markers: RepoMarkers): ComplianceVerdict {
  const missing: string[] = [];
  if (!markers.isGitRepo) missing.push("git-repo");
  if (!markers.hasRollDir) missing.push(".roll/");
  if (!markers.hasBacklog) missing.push(".roll/backlog.md");
  if (missing.length === 0) return { compliant: true };
  return {
    compliant: false,
    reason: `not a compliant roll project (missing: ${missing.join(", ")})`,
    missing,
  };
}
