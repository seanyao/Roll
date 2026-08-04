/**
 * US-PAIR-001 — Cross-Agent Pairing candidate selection (pure).
 *
 * The primitive of cross-agent collaboration is the PAIR: a working agent gets
 * cross-checked by a DIFFERENT (heterogeneous) agent for perspective diversity.
 * This module is the rational selector — randomness only ever happens INSIDE a
 * qualified candidate set (installed + available + capable + heterogeneous),
 * never on the raw pool. Pure + deterministic (seeded by cycleId) so it is
 * unit-testable and replayable, per roll's determinism discipline.
 *
 * Peer-reviewed plan (pi/kimi/codex, all REFINE): self-declared capability is a
 * HARD filter (cross-checked against the registry); heterogeneity is by vendor
 * (same vendor, different model does NOT count); MVP rotation is pure seeded
 * round-robin (hit-rate bias deferred to US-PAIR-006); fail-loud when no peer.
 */
import type { AgentName, AgentScopeConfig, AgentScopeRoleBinding, RollEvent } from "@roll/spec";
import { extractUsage, toCycleCost } from "../cost/tracker.js";
import { reconcileObservedModel } from "./isolation.js";
import { AGENT_REGISTRY_NAMES, agentIsKnown, canonicalAgentName } from "./registry.js";

// US-PAIR-009 / FIX-343: `score` — the finished cycle's Review Score is produced
// by a fresh-session peer Reviewer; the working agent never grades its own work.
export type PairingStage = "design" | "test" | "code" | "cycle" | "score";
export const PAIRING_STAGES: readonly PairingStage[] = ["design", "test", "code", "cycle", "score"];

function isStage(s: string): s is PairingStage {
  return (PAIRING_STAGES as readonly string[]).includes(s);
}

/**
 * Vendor key for heterogeneity: two agents are heterogeneous iff their vendors
 * differ. Unknown agents default to their own canonical name (treated as distinct
 * vendors). Provider aliases stay aliases in AgentSpec, while the pairing pool
 * only reasons about canonical agent names.
 */
const AGENT_VENDOR: Readonly<Record<string, string>> = {
  claude: "anthropic",
  kimi: "moonshot",
  codex: "openai",
  pi: "pi",
  agy: "google",
  reasonix: "reasonix",
  cursor: "cursor",
};

export function agentVendor(name: string): string {
  const c = canonicalAgentName(name);
  return AGENT_VENDOR[c] ?? c;
}

/** Heterogeneous = different vendor. Same vendor (incl. alias) is NOT a pair. */
export function isHeterogeneous(a: string, b: string): boolean {
  return agentVendor(a) !== agentVendor(b);
}

/**
 * FIX-312 — is a heterogeneous peer GENUINELY available for `workingAgent`?
 *
 * The owner-calibrated line for review routing: "hetero available → must use it;
 * self only when hetero is truly impossible." This is the single predicate that
 * decision drives on — `auto` defaults to hetero-FIRST, and a cycle that
 * self-reviewed while this returns true is a VIOLATION (the peer gate blocks it).
 *
 * Agent-agnostic by construction (roll core thesis): "heterogeneous" = a
 * different VENDOR than the builder, computed uniformly through {@link agentVendor}
 * — NO per-agent hardcoding. Returns true iff ≥1 CONFIGURED/installed agent
 * resolves to a vendor different from the builder's. A single-agent / single-vendor
 * setup → false → self-review is an allowed recorded fallback (never blocked).
 */
export function heteroAvailable(
  installed: readonly string[],
  workingAgent: string,
  /** FIX-935: project-config allowed agents. When supplied, only agents in this
   *  set are considered eligible reviewers. */
  allowedAgents?: Set<string> | readonly string[],
): boolean {
  const allowedSet = allowedAgents === undefined ? undefined : new Set([...allowedAgents].map(canonicalAgentName));
  const working = agentVendor(workingAgent);
  const reviewable = installed
    .map(canonicalAgentName)
    .filter((a) => agentIsKnown(a))
    .filter((a) => allowedSet === undefined || allowedSet.has(a));
  if (working === "" || canonicalAgentName(workingAgent) === "") {
    // No builder identity → can't reason about heterogeneity; conservatively
    // treat any second distinct vendor in the pool as a heterogeneous option.
    const vendors = new Set(reviewable.map(agentVendor).filter((v) => v !== ""));
    return vendors.size >= 2;
  }
  return reviewable.some((a) => {
    const c = canonicalAgentName(a);
    return c !== "" && agentVendor(c) !== working;
  });
}

export interface PairingConfig {
  enabled: boolean;
  stages: PairingStage[];
  /** agent (canonical) → the stages it is declared competent to review. */
  capability: Record<string, PairingStage[]>;
}

/** Thrown by the one-time legacy migration parser on invalid input. */
export class PairingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingConfigError";
  }
}

function uniqueKnownAgents(input: readonly string[]): AgentName[] {
  const out: AgentName[] = [];
  for (const raw of input) {
    const agent = canonicalAgentName(raw);
    if (!agentIsKnown(agent)) continue;
    if (!out.includes(agent as AgentName)) out.push(agent as AgentName);
  }
  return out;
}

function scopedEvaluateBinding(config: AgentScopeConfig): AgentScopeRoleBinding | undefined {
  return config.defaults["story"]?.roles.evaluate ?? config.roles.evaluate;
}

function roleScopedPool(config: AgentScopeConfig, binding: AgentScopeRoleBinding, installed: readonly string[]): AgentName[] {
  if (binding.kind === "fixed") return [binding.agent];
  if (binding.kind !== "select") return [];
  const base = binding.from !== undefined && binding.from.length > 0 ? [...binding.from] : uniqueKnownAgents(installed);
  const require = binding.require ?? [];
  if (require.length === 0) return uniqueKnownAgents(base);
  return uniqueKnownAgents(base).filter((agent) => {
    const declared = config.agents[agent]?.capabilities;
    return declared === undefined || require.every((role) => declared.includes(role));
  });
}

/**
 * US-V4-018 — project `roll-agents/v1` uses the recursive `evaluate` Role as
 * the authoring surface for pair-review/score candidates. This adapter keeps
 * the existing pairing selector stable while moving the config source:
 *   - `roles.evaluate` / `defaults.story.roles.evaluate` narrows the reviewer pool.
 *   - no explicit `from` means "all installed supported agents", not historical
 *     easy/default/hard route slots.
 *   - runtime auth/VPN/account health remains a selector-time availability check.
 */
export function pairingConfigFromAgentScopeConfig(config: AgentScopeConfig, installed: readonly string[] = AGENT_REGISTRY_NAMES): PairingConfig | null {
  const binding = scopedEvaluateBinding(config);
  if (binding === undefined || binding.kind === "inherit") return null;
  const pool = roleScopedPool(config, binding, installed);
  if (pool.length === 0) return { enabled: false, stages: ["code", "score"], capability: {} };
  const capability = Object.fromEntries(pool.map((agent) => [agent, ["code", "score"] as PairingStage[]]));
  return { enabled: true, stages: ["code", "score"], capability };
}

// NOTE (kimi pair-review): crude `#` truncation is safe ONLY because the schema's
// values (true/false, stage tokens, agent names) are an `[A-Za-z0-9_-]` whitelist
// that never contains a literal `#`. If a value type ever allows `#`, switch to a
// real YAML parser rather than extending this.
const stripComment = (s: string): string => {
  const i = s.indexOf("#");
  return (i >= 0 ? s.slice(0, i) : s).replace(/\s+$/, "");
};

const TOP_KEYS = new Set(["enabled", "stages", "capability"]);

/** Parse a `[a, b]` flow list from the legacy migration input. */
function parseStageList(raw: string, ctx: string): PairingStage[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (inner === "") return [];
  const out: PairingStage[] = [];
  for (const tok of inner.split(",")) {
    const v = tok.trim();
    if (v === "") continue;
    if (!isStage(v)) throw new PairingConfigError(`illegal stage "${v}" in ${ctx} (allowed: ${PAIRING_STAGES.join(", ")})`);
    out.push(v);
  }
  return out;
}

/**
 * Parse the retired pairing.yaml format for `roll agent migrate` only. Runtime
 * review selection exclusively reads the scoped evaluate role. Fail-loud on
 * illegal stages or a capability declared for an unknown agent.
 * Shape:
 *   enabled: true
 *   stages: [code]
 *   capability:
 *     kimi: [code, test]
 *     pi: [code, score]
 */
export function parsePairingConfig(yaml: string): PairingConfig {
  const cfg: PairingConfig = { enabled: false, stages: [], capability: {} };
  let inCapability = false;
  for (const rawLine of yaml.split("\n")) {
    const line = stripComment(rawLine);
    if (line.trim() === "") continue;
    const indented = /^\s/.test(rawLine);
    if (!indented) {
      inCapability = false;
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (m === null) throw new PairingConfigError(`malformed line: "${line.trim()}"`);
      const [, key, val] = m;
      // fail-loud on an unknown top-level key (kimi pair-review): silently
      // ignoring it would let a typo'd key (e.g. `stage:` for `stages:`) pass
      // unnoticed and change behaviour.
      if (!TOP_KEYS.has(key as string)) {
        throw new PairingConfigError(`unknown top-level key "${key}" (allowed: ${[...TOP_KEYS].join(", ")})`);
      }
      if (key === "enabled") cfg.enabled = val?.trim() === "true";
      else if (key === "stages") cfg.stages = parseStageList(val ?? "", "stages");
      else if (key === "capability") inCapability = true;
    } else if (inCapability) {
      const m = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (m === null) throw new PairingConfigError(`malformed capability line: "${line.trim()}"`);
      const [, agent, val] = m;
      const canon = canonicalAgentName(agent as string);
      if (!agentIsKnown(canon)) {
        throw new PairingConfigError(`capability declared for unknown agent "${agent}" (registry cross-check failed)`);
      }
      cfg.capability[canon] = parseStageList(val ?? "", `capability.${agent}`);
    } else {
      // indented line outside the only nesting block (capability) — a mis-indent
      // (e.g. an indented `stages:`) would otherwise vanish silently (kimi pair-review).
      throw new PairingConfigError(`unexpected indented line outside capability: "${line.trim()}"`);
    }
  }
  return cfg;
}

/** One installed agent's standing in the pairing pool (US-PAIR-002 observability). */
export interface PoolAgentView {
  agent: string;
  vendor: string;
  /** In the pool = declared capable for ≥1 stage AND has a heterogeneous partner. */
  inPool: boolean;
  capability: PairingStage[];
  /** Why it is NOT in the pool (empty when inPool). */
  reason: string;
}

export interface PairingPoolView {
  enabled: boolean;
  stages: PairingStage[];
  agents: PoolAgentView[];
}

/**
 * The observability view (US-PAIR-002): for each installed agent, its vendor,
 * declared capability, and whether it is an eligible pairing candidate — and if
 * not, why. Pure (installed + cfg → view) so it is testable and the CLI just
 * renders it. Observability is a first-class need, not an afterthought.
 */
export function pairingPoolView(installed: string[], cfg: PairingConfig): PairingPoolView {
  const agents = installed.map(canonicalAgentName).filter((a, i, arr) => arr.indexOf(a) === i);
  const vendorCount = new Map<string, number>();
  for (const a of agents) vendorCount.set(agentVendor(a), (vendorCount.get(agentVendor(a)) ?? 0) + 1);
  const distinctVendors = vendorCount.size;

  const rows: PoolAgentView[] = agents.map((agent) => {
    const vendor = agentVendor(agent);
    const capability = cfg.capability[agent] ?? [];
    let reason = "";
    if (capability.length === 0) reason = "no capability declared in the configured evaluate role";
    // codex pair-review: capable for SOME stage isn't enough — it must overlap an
    // ENABLED stage, else it's never actually eligible (e.g. design-only while only
    // code is on).
    else if (!capability.some((s) => cfg.stages.includes(s))) reason = "capability does not overlap any enabled stage";
    else if (distinctVendors < 2) reason = "no heterogeneous partner (only one vendor installed)";
    // A same-vendor agent can still pair with a different vendor, so the only
    // pool-blocking heterogeneity case is "everyone is the same vendor".
    return { agent, vendor, capability, inPool: reason === "" && cfg.enabled, reason: cfg.enabled ? reason : "pairing disabled" };
  });
  return { enabled: cfg.enabled, stages: cfg.stages, agents: rows };
}

// ── US-PAIR-006: cost observability ──────────────────────────────────────────

/**
 * Turn a peer agent's raw stdout into a REAL list cost (USD) for the
 * pair:verdict `cost` field — never the 0 placeholder again (owner's top
 * priority: "至少知道花了多少钱"). claude (harness) runs with `--output-format
 * stream-json` so its usage is summed via {@link sumClaudeStream}; the kimi
 * stdout-scrape agent goes through {@link extractUsage}; pi/text-mode and unknown
 * agents have no parseable usage and record 0.
 *
 * Best-effort by contract: a parse miss or any throw yields 0, NEVER an
 * exception — pairing must stay non-blocking, and cost accounting must not fail
 * the cycle. The returned figure is the kept-work list cost (revertCount 0 — a
 * one-way peer review never reverts).
 */
/**
 * US-PAIR-014 — why a cost figure is what it is.
 *
 * `0` used to mean BOTH "this review was free" and "we could not parse the peer's
 * usage" — and 5 of 7 agents hit the second case, so cost was unusable in
 * aggregate. `basis` makes the difference explicit; `estimated` is also honest
 * that the number comes from the price table, not from a provider invoice.
 */
export type PeerReviewCostFact =
  | { readonly basis: "estimated"; readonly usd: number }
  | {
      readonly basis: "unobservable";
      readonly usd: 0;
      readonly reason: "no_usage_parsed" | "zero_tokens_reported" | "extractor_threw";
    };

/**
 * US-PAIR-011 — the model the peer's own output CLAIMS it ran, or "" when the
 * agent reported nothing parseable (pi/agy extractors are deliberate stubs).
 *
 * Reconciliation only. This must NEVER feed selection: an agent whose extractor
 * is a stub would otherwise be permanently unable to satisfy a model/vendor
 * isolation tier. Compare it against the configured model and warn on mismatch
 * (US-PAIR-018) — never overrule the decision already made.
 */
export function observedModelFrom(peer: string, stdout: string): string {
  try {
    const usage = extractUsage(canonicalAgentName(peer), stdout.split("\n"));
    const model = usage?.model;
    return typeof model === "string" ? model.trim() : "";
  } catch {
    return "";
  }
}

/**
 * US-PAIR-011/014 — everything a finished peer run reports about ITSELF:
 * what it cost (and on what basis), which model config pinned it to, and which
 * model its own output claimed. One helper so the review and score paths cannot
 * drift apart on how they record identity and spend.
 */
export function peerRunIdentity(
  peer: string,
  stdout: string,
  configuredModel: string,
): {
  cost: number;
  costBasis: "estimated" | "unobservable";
  model?: string;
  observedModel?: string;
  /** US-PAIR-018: set ONLY on a real configured-vs-observed disagreement. */
  modelMismatch?: string;
} {
  const fact = peerReviewCostFact(peer, stdout);
  const observed = observedModelFrom(peer, stdout);
  // US-PAIR-018: reconcile, never re-decide. The tier was fixed from the
  // configured identity before the spawn; a mismatch is a WARNING recorded
  // alongside it, and "nothing observed" stays silent (stub extractors are honest
  // silence, not a fault).
  const recon = reconcileObservedModel(configuredModel, observed);
  return {
    cost: fact.usd,
    costBasis: fact.basis,
    ...(configuredModel !== "" ? { model: configuredModel } : {}),
    ...(observed !== "" ? { observedModel: observed } : {}),
    ...(recon.kind === "mismatch" ? { modelMismatch: recon.message } : {}),
  };
}

/** US-PAIR-014: the cost WITH its basis. Prefer this over {@link peerReviewCost}. */
export function peerReviewCostFact(peer: string, stdout: string): PeerReviewCostFact {
  try {
    const canon = canonicalAgentName(peer);
    const usage = extractUsage(canon, stdout.split("\n"));
    // Includes the deliberate always-null stubs (pi, agy): "we cannot see it" is
    // not "it cost nothing".
    if (usage === null) return { basis: "unobservable", usd: 0, reason: "no_usage_parsed" };
    if ((usage.input_tokens ?? 0) === 0 && (usage.output_tokens ?? 0) === 0) {
      return { basis: "unobservable", usd: 0, reason: "zero_tokens_reported" };
    }
    const { estimatedCost } = toCycleCost(usage, { cycleId: "pair", agent: canon, revertCount: 0 });
    if (!Number.isFinite(estimatedCost) || estimatedCost <= 0) {
      return { basis: "unobservable", usd: 0, reason: "zero_tokens_reported" };
    }
    return { basis: "estimated", usd: estimatedCost };
  } catch {
    return { basis: "unobservable", usd: 0, reason: "extractor_threw" };
  }
}

/**
 * Back-compatible numeric form. Callers that only need a number keep working;
 * anything that reports or aggregates spend should use {@link peerReviewCostFact}
 * so "unobservable" is never rendered as "$0.00".
 */
export function peerReviewCost(peer: string, stdout: string): number {
  return peerReviewCostFact(peer, stdout).usd;
}

/** Aggregate pairing activity + spend, rebuilt from the pair:* event stream. */
export interface PairingCostSummary {
  /** pair:verdict events seen (a completed pairing). */
  pairings: number;
  /** count of pairings per peer agent (canonical), e.g. { pi: 2, kimi: 1 }. */
  byPeer: Record<string, number>;
  /** sum of pair:verdict `cost` across all pairings (USD list cost). */
  totalCost: number;
  /** US-PAIR-014: rows whose cost really was measured (`costBasis: "estimated"`). */
  observedCostRows: number;
  /**
   * US-PAIR-014: rows whose cost could NOT be observed. Kept separate from
   * `totalCost` so a reader never divides by the full row count and reports
   * "unobservable" as "free". Legacy rows (written before costBasis existed)
   * count as unobservable when they carry a bare 0.
   */
  unobservableCostRows: number;
  /** sum of `findings` across all pairings (the real-problem signal). */
  totalFindings: number;
  /** pair:none-available events (fail-loud absences — a pairing that did not happen). */
  noneAvailable: number;
  /** Legacy pair:excluded events (canonical agent → most-recent recorded count). */
  excludedPeers: Record<string, number>;
}

/**
 * Fold the pair:* events into an activity/spend summary for `roll pair status`
 * and the dashboard: "pairings to date: N, by peer (pi×K, kimi×J…), total
 * cost $X, M findings". Pure (events → summary) so the CLI is a thin renderer
 * and this is unit-testable. Non-pair events are ignored.
 *
 * `totalCost` is the sum of each pair:verdict's RECORDED `cost` — the real spend
 * captured at write time by {@link peerReviewCost} (pi pair-review): this is NOT
 * recomputed from stdout here, so any legacy event written before US-PAIR-006
 * (with the old `cost: 0` placeholder) contributes 0. Forward-correct, not
 * backfilled — the spend becomes visible from the first PAIR-006 cycle on.
 */
export function aggregatePairingCost(events: readonly RollEvent[]): PairingCostSummary {
  const summary: PairingCostSummary = {
    pairings: 0,
    byPeer: {},
    totalCost: 0,
    observedCostRows: 0,
    unobservableCostRows: 0,
    totalFindings: 0,
    noneAvailable: 0,
    excludedPeers: {},
  };
  // US-PAIR-014: classify each spend row. An explicit basis wins; a legacy row
  // with no basis is "observed" only if it carries a non-zero cost — a bare 0 is
  // exactly the ambiguity this field exists to remove, so it counts unobservable.
  const tally = (basis: "estimated" | "unobservable" | undefined, cost: number): void => {
    const observed = basis === "estimated" || (basis === undefined && Number.isFinite(cost) && cost > 0);
    if (observed) summary.observedCostRows += 1;
    else summary.unobservableCostRows += 1;
  };
  for (const e of events) {
    if (e.type === "pair:verdict") {
      summary.pairings += 1;
      const peer = canonicalAgentName(e.peer);
      summary.byPeer[peer] = (summary.byPeer[peer] ?? 0) + 1;
      summary.totalCost += Number.isFinite(e.cost) ? e.cost : 0;
      tally(e.costBasis, e.cost);
      summary.totalFindings += Number.isFinite(e.findings) ? e.findings : 0;
    } else if (e.type === "pair:score") {
      // US-PAIR-009: a score pairing is pairing activity + spend (no findings axis).
      summary.pairings += 1;
      const peer = canonicalAgentName(e.peer);
      summary.byPeer[peer] = (summary.byPeer[peer] ?? 0) + 1;
      summary.totalCost += Number.isFinite(e.cost) ? e.cost : 0;
      tally(e.costBasis, e.cost);
    } else if (e.type === "pair:none-available") {
      summary.noneAvailable += 1;
    } else if (e.type === "pair:excluded") {
      // FIX-346: the LAST exclusion event per peer wins (a peer can be excluded,
      // re-logged-in, and excluded again — the latest failure count is current).
      summary.excludedPeers[canonicalAgentName(e.agent)] = Number.isFinite(e.failures) && e.failures > 0 ? e.failures : 1;
    }
  }
  return summary;
}

// ── FIX-346 legacy auth-failure observability ────────────────────────────────

/**
 * Legacy threshold retained for interpreting historical event streams.
 * V4 fair candidate pools do not bench a peer because of prior auth failures;
 * current availability is checked at resolution/spawn time instead.
 */
export const DEFAULT_AUTH_EXCLUDE_THRESHOLD = 2;

/** One peer's current auth-failure standing, folded from the event stream. */
export interface PeerAuthState {
  /** Consecutive trailing `agent:blocked cause:auth` events (reset by any success). */
  consecutiveAuthFailures: number;
  /** Legacy diagnostic: true once the historical streak reached the old threshold. */
  excluded: boolean;
}

/**
 * FIX-346 — fold the event stream into each peer's auth-failure standing.
 *
 * A peer's streak counts its consecutive trailing `agent:blocked cause:auth`
 * events; ANY later success (`pair:verdict` / `pair:score` for that peer) RESETS
 * it to 0 — so a peer that auth-failed, was re-logged-in by the owner offline, and
 * then reviewed cleanly is no longer benched. `network` blocks NEVER count: they
 * are transient connectivity, not an unrefreshable credential, so a VPN blip must
 * not permanently exclude a peer. Pure (events → state) and agent-agnostic — the
 * signal is the standard `agent:blocked cause:auth`, with NO per-agent hardcoding,
 * so agy's OAuth and claude's keychain are handled by the same rule.
 */
export function peerAuthStates(
  events: readonly RollEvent[],
  threshold: number = DEFAULT_AUTH_EXCLUDE_THRESHOLD,
): Record<string, PeerAuthState> {
  const streak: Record<string, number> = {};
  for (const e of events) {
    if (e.type === "agent:blocked" && e.cause === "auth") {
      const peer = canonicalAgentName(e.agent);
      streak[peer] = (streak[peer] ?? 0) + 1;
    } else if (e.type === "pair:verdict" || e.type === "pair:score") {
      // A real verdict/score proves this peer authenticated → reset its streak.
      streak[canonicalAgentName(e.peer)] = 0;
    }
  }
  const out: Record<string, PeerAuthState> = {};
  const bar = threshold < 1 ? 1 : threshold;
  for (const peer of Object.keys(streak)) {
    const n = streak[peer] ?? 0;
    out[peer] = { consecutiveAuthFailures: n, excluded: n >= bar };
  }
  return out;
}

/**
 * V4 fairness: historical auth failures never remove an agent from the static
 * candidate pool. The current spawn/probe decides availability for this run.
 */
export function excludedPeers(
  events: readonly RollEvent[],
  threshold: number = DEFAULT_AUTH_EXCLUDE_THRESHOLD,
): Set<string> {
  void events;
  void threshold;
  return new Set<string>();
}

/**
 * FIX-1056 — same-envelope auth COOLDOWN (a guardrail against repeated
 * unattended prompts, NOT the primary fix; the primary fix is propagating the
 * authenticated runtime context into the headless spawn envelope so a
 * once-authenticated agent does not auth-fail in the first place).
 *
 * A peer enters cooldown ONLY once its CONSECUTIVE `agent:blocked cause:auth`
 * streak reaches `threshold`. Because `agent:blocked cause:auth` is emitted only
 * after a real same-envelope spawn/probe failure (executor + agent-liveness,
 * both driven through the one shared {@link SelectInput.isAvailable}/spawn
 * envelope), an entry here always reflects a genuine same-envelope auth failure —
 * never a mere routing preference. `network` blocks NEVER count (transient
 * connectivity, not an unrefreshable credential), and ANY later success
 * (`pair:verdict` / `pair:score`) RESETS the streak — see {@link peerAuthStates}
 * — so a peer the owner re-authenticated offline recovers automatically.
 *
 * Unlike {@link excludedPeers} (the V4 fair no-op kept for back-compat), this is
 * an opt-in cooldown keyed on a live, refreshable auth-failure streak, so it
 * benches ONLY the agent that is actually auth-blocked right now while every
 * other ready agent stays fully eligible (fairness preserved). Returns each
 * cooled-down peer with its current failure count so the caller can emit a
 * visible `pair:excluded` event and swap in the next eligible candidate.
 */
export function authCooldownExclusions(
  events: readonly RollEvent[],
  threshold: number = DEFAULT_AUTH_EXCLUDE_THRESHOLD,
): Map<string, number> {
  const bar = threshold < 1 ? 1 : threshold;
  const states = peerAuthStates(events, bar);
  const out = new Map<string, number>();
  for (const [peer, state] of Object.entries(states)) {
    if (state.consecutiveAuthFailures >= bar) out.set(peer, state.consecutiveAuthFailures);
  }
  return out;
}

// ── US-PAIR-006: hit-rate-driven rotation ────────────────────────────────────

/** One peer's pairing track record: how often it reviewed and how often it hit. */
export interface PeerStat {
  /** pair:verdict events for this peer. */
  count: number;
  /** verdicts that surfaced ≥1 real finding (a "hit"). */
  hits: number;
}

/** Per-peer history (canonical agent → {count, hits}), rebuilt from pair:verdict. */
export type PairingHistory = Record<string, PeerStat>;

/**
 * Rebuild per-peer pairing history from the event stream: a HIT is a
 * pair:verdict that produced ≥1 finding (a real problem caught), regardless of
 * the agree/refine/object label — a zero-finding "agree" counts toward `count`
 * but never toward `hits`. This is the signal the ε-greedy rotation prefers on.
 */
export function pairingHistory(events: readonly RollEvent[]): PairingHistory {
  const hist: PairingHistory = {};
  for (const e of events) {
    if (e.type !== "pair:verdict") continue;
    const peer = canonicalAgentName(e.peer);
    const stat = hist[peer] ?? { count: 0, hits: 0 };
    stat.count += 1;
    // pi pair-review: guard a malformed event's `findings` (negative / NaN) —
    // only a finite, positive count is a real hit; corruption never inflates it.
    if (Number.isFinite(e.findings) && e.findings > 0) stat.hits += 1;
    hist[peer] = stat;
  }
  return hist;
}

/** Default exploration rate: 20% explore / 80% exploit (pi's ε-greedy 80/20). */
export const DEFAULT_PAIRING_EPSILON = 0.2;

/**
 * A peer's hit-rate, Laplace-smoothed so a single lucky hit on one sample does
 * not pin the rate at 1.0 (and an unproven peer starts at the prior, not 0):
 * (hits + 1) / (count + 2). No history → the neutral prior 0.5, so a cold peer
 * is neither favoured nor punished.
 */
function hitRate(stat: PeerStat | undefined): number {
  if (stat === undefined || stat.count <= 0) return 0.5;
  return (stat.hits + 1) / (stat.count + 2);
}

export interface SelectInput {
  /** Installed agents (canonical), e.g. from agentsInstalled(). */
  installed: string[];
  /** Liveness probe — only available agents survive the filter. Receives a
   *  CANONICAL agent name (kimi pair-review): the caller's probe must speak the
   *  same canonical vocabulary as the registry, not raw CLI binary names. */
  isAvailable: (agent: string) => boolean;
  /** The agent that did the work; its heterogeneous peers are the candidates. */
  workingAgent: string;
  stage: PairingStage;
  cfg: PairingConfig;
  /** Seeds the deterministic round-robin rotation (replayable, not RNG). */
  cycleId: string;
  /**
   * US-PAIR-006 (optional, backward-compatible): per-peer track record from
   * {@link pairingHistory}. Absent / empty → pure seeded round-robin (the
   * US-PAIR-001 behaviour, unchanged). Present → ε-greedy preference for the
   * highest-hit-rate heterogeneous peer.
   */
  history?: PairingHistory;
  /** ε for the ε-greedy rotation (default {@link DEFAULT_PAIRING_EPSILON}). */
  epsilon?: number;
  /**
   * FIX-935: project-config allowed agents (from `.roll/agents.yaml` slots).
   * When supplied, candidates are restricted to this set — preventing scoring
   * and pairing from auto-enabling machine-detected agents the project has not
   * configured (e.g. codex or claude). Absent → backward-compatible behaviour.
   */
  allowedAgents?: Set<string> | readonly string[];
}

/** Stable string hash (FNV-1a-ish) for the rotation seed — deterministic. */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The rational selector. Returns heterogeneous candidates ranked by a
 * cycleId-seeded round-robin (selected peer first, then alternates), or [] when
 * pairing is off / the stage is not enabled / no qualified heterogeneous peer
 * exists. [] at the call site is the fail-loud signal (emit pair:none-available)
 * — never a silently-skipped pairing.
 */
export function selectPairingCandidates(input: SelectInput): string[] {
  const { installed, isAvailable, workingAgent, stage, cfg, cycleId, history } = input;
  const working = canonicalAgentName(workingAgent);
  const order = new Map(AGENT_REGISTRY_NAMES.map((n, i) => [n as string, i]));
  const allowedSet = input.allowedAgents === undefined ? undefined : new Set([...input.allowedAgents].map(canonicalAgentName));

  // FIX-935: pre-filter the machine-detected installed list by the project
  // config allowlist (`.roll/agents.yaml` slots). This keeps the existing
  // headless / availability / capability filters untouched while preventing
  // scoring and pairing from auto-enabling agents the project has not declared.
  const basePool = installed
    .map(canonicalAgentName)
    .filter((a, i, arr) => arr.indexOf(a) === i) // de-dupe
    .filter((a) => agentIsKnown(a))
    .filter((a) => allowedSet === undefined || allowedSet.has(a))
    .sort((x, y) => (order.get(x) ?? 999) - (order.get(y) ?? 999));

  // FIX-343 (step ⑤, OWNER B-decision): the "score" stage is MANDATORY,
  // stage-aware, and RANKS heterogeneity as a PREFERENCE (not a hard filter):
  //   • NOT gated on cfg.enabled / cfg.stages — a Review Score is owed by every
  //     delivery whether or not code review is configured (the executor calls this
  //     unconditionally; an absent config must still yield a scorer).
  //   • PREFER heterogeneous candidates (different vendor = absolute
  //     heterogeneity, the encouraged/best independent signal) FIRST, then FALL
  //     BACK to a SAME-VENDOR fresh session (a fresh instance of the builder's
  //     own type) — NOT "drop the hetero filter". The same-vendor fresh session
  //     is the MINIMUM acceptable independence (a separately-spawned distinct
  //     subprocess via ports.agentSpawn, never a sub-agent sharing the builder's
  //     context); it is the fallback so a single-vendor install is never
  //     deadlocked, while a richer install still reaches for an other-vendor
  //     fresh session first. Capability is not required for scoring (no special
  //     tooling — every installed agent can score).
  // Code review (and every other stage) KEEPS the heterogeneous HARD filter and
  // the enabled/stage/capability gating unchanged (independence by vendor is a
  // HARD requirement there, not merely preferred).
  if (stage === "score") {
    // FIX-1044: the BUILDER's own agent is NOT an independent Evaluator and must
    // not become a score fallback for its OWN cycle (AC3). Whenever ANY other
    // agent is installed, the builder is excluded from the score pool entirely —
    // a delivery is graded by an independent Evaluator or it fails loud (AC4),
    // never self-graded. The ONLY exception is a TRUE single-agent install (the
    // builder is the only installed known agent): there the builder's own type
    // remains the minimum-independence scorer (a fresh, separately-spawned
    // session), preserving FIX-343's single-vendor anti-deadlock guarantee
    // WITHOUT re-opening builder self-scoring as a multi-agent fallback.
    // (Independence is still verified downstream by SESSION id, never by vendor
    // name — so this never re-creates the FIX-342 same-vendor-fresh deadlock.)
    const builderIsSoleInstalledAgent = working !== "" && basePool.every((a) => a === working);
    const eligible = basePool.filter((a) => isAvailable(a) && (builderIsSoleInstalledAgent || a !== working));
    if (eligible.length === 0) return [];
    // Split into heterogeneous (different vendor than the builder) and
    // same-vendor pools. A round-robin seed rotates WITHIN each pool so we don't
    // fixate on one peer over time, yet stay replayable. Then concatenate
    // hetero-first, same-vendor-fallback: the set is never trimmed (reachability
    // preserved), only the head order is ranked. In a multi-agent install the
    // same-vendor pool is empty (the builder — the only same-vendor candidate —
    // is excluded above), so scoring is hetero-only; the same-vendor pool is
    // non-empty ONLY for the sole-installed-agent exception.
    const hetero = eligible.filter((a) => working !== "" && isHeterogeneous(a, working));
    const sameVendor = eligible.filter((a) => working === "" || !isHeterogeneous(a, working));
    const rotate = (pool: string[]): string[] => {
      if (pool.length === 0) return pool;
      const start = seedOf(cycleId) % pool.length;
      return [...pool.slice(start), ...pool.slice(0, start)];
    };
    return [...rotate(hetero), ...rotate(sameVendor)];
  }

  if (!cfg.enabled) return [];
  if (!cfg.stages.includes(stage)) return [];

  // Rational hard filter: installed + available + capable-for-stage +
  // heterogeneous from the worker. Order by the registry so the seed maps to a
  // stable index. FIX-935: the basePool already respects the project allowlist.
  const qualified = basePool
    .filter((a) => a !== working)
    .filter((a) => isAvailable(a))
    .filter((a) => (cfg.capability[a] ?? []).includes(stage))
    .filter((a) => isHeterogeneous(a, working));

  if (qualified.length === 0) return [];

  // Seeded round-robin baseline (US-PAIR-001): rotate the stable list so
  // pairings don't fixate on one agent over time, yet stay replayable. This is
  // the EXPLORE arm — and the whole behaviour when there is no history.
  const seed = seedOf(cycleId);
  const start = seed % qualified.length;
  const explore = [...qualified.slice(start), ...qualified.slice(0, start)];

  // US-PAIR-006: ε-greedy hit-rate preference. With no history we stay on pure
  // round-robin (backward compatible). With history, an (1-ε) fraction of cycles
  // EXPLOIT — lead with the highest-hit-rate heterogeneous peer — while ε of
  // cycles keep exploring via the round-robin above. The explore/exploit coin is
  // itself seeded by cycleId, so selection stays deterministic/replayable, and
  // the ε floor is kimi's guardrail: a high scorer can never monopolise (every
  // peer still leads on some cycles). The peer SET is never trimmed — only the
  // head order changes, so a failed exploit peer falls back to the rest.
  if (history === undefined || Object.keys(history).length === 0) return explore;
  const epsilon = clampEpsilon(input.epsilon ?? DEFAULT_PAIRING_EPSILON);
  // Deterministic coin in [0,1): a second, independent seed dimension so the
  // explore/exploit decision is not correlated with the round-robin offset.
  const coin = (seedOf(`eps:${cycleId}`) % 100_000) / 100_000;
  if (coin < epsilon) return explore; // EXPLORE: keep the round-robin order

  // EXPLOIT: rank the SAME qualified set by descending hit-rate (registry order
  // breaks ties). The set is never trimmed — only re-ordered — so a failed
  // top-ranked peer falls back to the next; reachability is preserved.
  // pi pair-review caveat: with NO hits anywhere, the Laplace prior
  // (hits+1)/(count+2) favours the LEAST-used peer (a peer used once scores
  // 1/3, used ten times scores 1/12) — i.e. exploit degrades to "spread the
  // load" until a real finding lands. That is the intended cold behaviour, not
  // a bug: nothing is yet "proven", so diversification is the rational default.
  const ranked = [...qualified].sort((x, y) => {
    const d = hitRate(history[y]) - hitRate(history[x]);
    return d !== 0 ? d : (order.get(x) ?? 999) - (order.get(y) ?? 999);
  });
  return ranked;
}

/** Clamp ε to [0,1]; a NaN / out-of-range value falls back to the default. */
function clampEpsilon(e: number): number {
  if (!Number.isFinite(e)) return DEFAULT_PAIRING_EPSILON;
  return Math.min(1, Math.max(0, e));
}
