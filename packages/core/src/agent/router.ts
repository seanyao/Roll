/**
 * @responsibility Routes backlog stories to agents by complexity tier with in-tier nudges.
 * AgentRouter — TS port of the v2 tier/complexity routing engine the loop uses
 * to pick which agent runs a backlog story.
 *
 * v2 oracle:
 *   - lib/loop_pick_agent.py (read fully): the pure classifier + in-tier nudge.
 *       * `_classify_complexity`  (~52-71):  est_min → easy/default/hard.
 *       * `nudge_within_tier`     (~101-184): deterministic in-tier soft nudge.
 *       * boundaries EASY_MAX_MIN=8, HARD_MIN_MIN=20 (~41-45); SAMPLE_FLOOR=8 (~98).
 *   - bin/roll:
 *       * `_loop_pick_agent_for_story` (~13263-13330): tier → slot → fallback
 *         chain + nudge wiring. classify → read tier slot → empty? default slot
 *         → empty? firstInstalledAgent (with WARN) → nudge within tier.
 *       * `_loop_resolve_fallback_agent` (~13356-13401): PRE-SPAWN availability
 *         fallback (NOT failure-retry). primary online → primary; else fallback
 *         slot online → fallback with legacy provenance metadata; else exhausted → ALERT.
 *       * `_loop_tier_nudge` (~13180-13243): candidate-pool assembly + python call.
 *
 * Invariant I10: deterministic route resolution — same inputs (est_min, slot
 * config, probe verdicts, hit-rates) → same (agent, tier) decision. No clock, no
 * rng. Availability-fallback ({@link resolveFallback}) is a PRE-SPAWN slot
 * fallback only, never a failure-retry loop (mirrors bash: one fallback hop, then
 * ALERT-and-stop). FIX-930 carve-out: the ONE failure-driven agent swap is
 * {@link resolveRouteExcluding} — a deterministic slot-chain walk that excludes
 * agents already tried zero-TCR on a story. It lives OUTSIDE the pure cycleStep
 * (the CLI adapter drives it post-cycle); cycleStep/retryPlan still NEVER swap.
 *
 * Purity: this module never reads the filesystem, runs `python3`, or probes
 * PATH. Tier classification + nudge are reimplemented as pure TS (the python is
 * itself pure). Slot reads, installed lists, and availability verdicts are all
 * injected.
 */

// ── Tier classification (mirrors loop_pick_agent.py _classify_complexity) ─────

export type Tier = "easy" | "default" | "hard";

/** est_min boundary: `<= 8` → easy. Single source of truth (py EASY_MAX_MIN). */
export const EASY_MAX_MIN = 8;
/** est_min boundary: `> 20` → hard (py HARD_MIN_MIN). */
export const HARD_MIN_MIN = 20;

/**
 * Map an `est_min` estimate onto a complexity tier. `<= 8` → easy, `> 20` →
 * hard, `8 < x <= 20` → default. A missing (`undefined`/`null`) or non-integer
 * or negative estimate falls back to `default`. Mirrors `_classify_complexity`
 * (which `int()`-truncates, so we floor toward zero like Python's int()).
 */
export function classifyComplexity(estMin: number | string | null | undefined): Tier {
  if (estMin === null || estMin === undefined) return "default";
  let n: number;
  if (typeof estMin === "number") {
    if (!Number.isFinite(estMin)) return "default";
    n = Math.trunc(estMin);
  } else {
    // Python int("12") parses base-10 ints; "12.5"/"foo" raise → default. Mirror
    // by accepting only an optional sign + digits.
    if (!/^[+-]?\d+$/.test(estMin.trim())) return "default";
    n = Number.parseInt(estMin.trim(), 10);
  }
  if (n < 0) return "default";
  if (n <= EASY_MAX_MIN) return "easy";
  if (n > HARD_MIN_MIN) return "hard";
  return "default";
}

// ── In-tier soft nudge (mirrors loop_pick_agent.py nudge_within_tier) ─────────

/** Default minimum samples a (agent × story_type) combo needs before its
 *  hit-rate may influence routing (py SAMPLE_FLOOR). */
export const SAMPLE_FLOOR = 8;

/** One per-(agent × story_type) hit-rate stat (the loop_result_eval read model). */
export interface HitRateStat {
  hit_rate?: number;
  sample_n?: number;
}

/** Hit-rate read model keyed by `"<agent>\x1f<story_type>"` (matching the python
 *  `%s\x1f%s` key). Use {@link hitRateKey} to build keys. */
export type HitRates = Record<string, HitRateStat | undefined>;

/** Build the `\x1f`-delimited hit-rate key exactly like the python. */
export function hitRateKey(agent: string, storyType: string): string {
  return `${agent}\x1f${storyType}`;
}

/** Outcome of an in-tier nudge: chosen agent + a one-line audit rationale. */
export interface NudgeResult {
  agent: string;
  rationale: string;
}

/** Read (hit_rate, sample_n) for an agent, coercing like the python `_stat`. */
function readStat(hitRates: HitRates, agent: string, storyType: string): { hr: number; n: number } {
  const st = hitRates[hitRateKey(agent, storyType)] ?? {};
  const rawN = st.sample_n;
  const n = typeof rawN === "number" && Number.isFinite(rawN) ? Math.trunc(rawN) : 0;
  const rawHr = st.hit_rate;
  const hr = typeof rawHr === "number" && Number.isFinite(rawHr) ? rawHr : 0;
  return { hr, n };
}

/** Format a float to 2 decimals like Python `%.2f` (round-half-to-even differs,
 *  but the rationale string is audit-only; we match `%.2f`'s common rounding). */
function fmt2(x: number): string {
  return x.toFixed(2);
}

/**
 * Reorder same-tier candidates by historical hit-rate and return the winner +
 * a human-readable rationale. Pure: same args → same result. Mirrors
 * `nudge_within_tier`:
 *   - falsy slotAgent → returned verbatim with a skip note.
 *   - `enabled=false` → identity (slot agent, "nudge disabled...").
 *   - candidate set = [slotAgent, ...sorted(unique rest)]; combos below
 *     `sampleFloor` are ineligible. No eligible combo → keep slot. Best hit-rate
 *     wins; ties break by the stable ordered-index (slot agent is index 0).
 */
export function nudgeWithinTier(
  slotAgent: string,
  candidates: readonly string[],
  storyType: string,
  hitRates: HitRates,
  opts: { sampleFloor?: number; enabled?: boolean } = {},
): NudgeResult {
  const sampleFloor = opts.sampleFloor ?? SAMPLE_FLOOR;
  const enabled = opts.enabled ?? true;

  if (!slotAgent) return { agent: slotAgent, rationale: "no slot agent; nudge skipped" };
  if (!enabled) {
    return { agent: slotAgent, rationale: `nudge disabled; keeping est_min slot ${slotAgent}` };
  }

  // Candidate set: slot agent first, then the rest de-duped and sorted (stable,
  // locale-independent — mirrors python `[slot_agent] + sorted(rest)`).
  const seen = new Set<string>([slotAgent]);
  const rest: string[] = [];
  for (const c of candidates) {
    if (c && !seen.has(c)) {
      seen.add(c);
      rest.push(c);
    }
  }
  rest.sort();
  const ordered = [slotAgent, ...rest];

  const indexOf = new Map<string, number>();
  ordered.forEach((a, i) => indexOf.set(a, i));

  const eligible: Array<{ agent: string; hr: number; n: number }> = [];
  for (const a of ordered) {
    const { hr, n } = readStat(hitRates, a, storyType);
    if (n >= sampleFloor) eligible.push({ agent: a, hr, n });
  }

  if (eligible.length === 0) {
    return {
      agent: slotAgent,
      rationale: `n<${sampleFloor} for all ${storyType} candidates in this tier; keeping slot ${slotAgent}`,
    };
  }

  // Best hit-rate wins; deterministic tie-break by stable ordered index.
  eligible.sort((x, y) => {
    if (y.hr !== x.hr) return y.hr - x.hr;
    return (indexOf.get(x.agent) ?? 0) - (indexOf.get(y.agent) ?? 0);
  });
  const best = eligible[0];
  if (best === undefined) {
    return { agent: slotAgent, rationale: "no slot agent; nudge skipped" };
  }

  const slotStat = readStat(hitRates, slotAgent, storyType);
  if (best.agent === slotAgent) {
    return {
      agent: slotAgent,
      rationale: `${slotAgent} best for ${storyType} in-tier (hit_rate ${fmt2(best.hr)}, n=${best.n}); slot kept`,
    };
  }
  return {
    agent: best.agent,
    rationale:
      `${best.agent} in-tier hit_rate ${fmt2(best.hr)} (n=${best.n}) > slot ${slotAgent} ` +
      `${fmt2(slotStat.hr)} (n=${slotStat.n}) for ${storyType} -> prefer ${best.agent}`,
  };
}

// ── Tier → agent slot resolution (mirrors _loop_pick_agent_for_story) ─────────

/** A routing slot's resolved value: the agent token + an optional NATIVE
 *  `--model` argument (mirrors core's `SlotConfig`; re-declared here so the
 *  router stays import-free of the registry's I/O surface and PURE — the model
 *  arrives ONLY through the injected {@link RouteDeps.readSlot}). */
export interface RouteSlot {
  agent: string;
  model?: string;
}

/** Ports injected into {@link resolveRoute}; keep the router pure. */
export interface RouteDeps {
  /** Read a tier slot's `{ agent, model? }` (`undefined` when empty/missing).
   *  Mirrors `_agents_config_slot <tier>` extended with the slot's model. */
  readSlot(slot: Tier | "fallback"): RouteSlot | undefined;
  /** First-installed last-resort agent (`undefined` when none). Mirrors
   *  `_first_installed_agent`. */
  firstInstalled(): string | undefined;
}

/** A resolved route decision (pre-fallback): the agent + the tier it came from. */
export interface RouteDecision {
  agent: string;
  tier: Tier;
  /** The NATIVE `--model` argument carried by whichever slot supplied the agent
   *  (tier → default fallback both carry their own model). Absent when the slot
   *  had no model OR the agent came from the firstInstalled last-resort (which
   *  has no slot config). The spawn omits `--model` when this is absent. */
  model?: string;
  /** A `warn`-worthy note when both the tier slot and `default` were empty and
   *  the firstInstalled fallback fired (mirrors the bash WARN), else undefined. */
  warning?: string;
}

/** Optional nudge inputs for {@link resolveRoute}. When omitted, no nudge runs
 *  (the slot agent is kept — identical to ROLL_AGENT_NUDGE=0). */
export interface RouteNudge {
  storyType: string;
  candidates: readonly string[];
  hitRates: HitRates;
  sampleFloor?: number;
  enabled?: boolean;
}

/**
 * Resolve a tier → agent, applying the same slot chain as
 * `_loop_pick_agent_for_story`:
 *   1. read the tier's slot.
 *   2. empty + tier !== "default" → read the `default` slot.
 *   3. still empty → firstInstalled() (with a WARN note).
 *   4. nothing installed → throw (bash returns 1).
 * Then apply the in-tier soft nudge when `nudge` is supplied.
 */
export function resolveRoute(tier: Tier, deps: RouteDeps, nudge?: RouteNudge): RouteDecision {
  // The model must follow whichever slot actually supplies the agent: tier slot
  // first, then the `default` slot on fallback. The firstInstalled last-resort
  // has no slot config, so it carries no model.
  let slot = deps.readSlot(tier);
  let agent = slot?.agent;
  let model = slot?.model;
  let warning: string | undefined;

  if ((agent === undefined || agent === "") && tier !== "default") {
    slot = deps.readSlot("default");
    agent = slot?.agent;
    model = slot?.model;
  }
  if (agent === undefined || agent === "") {
    const first = deps.firstInstalled();
    if (first !== undefined && first !== "") {
      agent = first;
      model = undefined; // last-resort agent has no slot config → no model.
      warning = `agents.yaml: tier '${tier}' and 'default' slot both empty; using first installed agent '${first}'`;
    }
  }
  if (agent === undefined || agent === "") {
    throw new Error(
      `no agent resolvable for tier '${tier}' (agents.yaml empty and no installed agent)`,
    );
  }

  if (nudge !== undefined) {
    const r = nudgeWithinTier(agent, nudge.candidates, nudge.storyType, nudge.hitRates, {
      sampleFloor: nudge.sampleFloor,
      enabled: nudge.enabled,
    });
    // A nudge re-points to a DIFFERENT agent (a soft historical preference). The
    // model is bound to the original slot's agent; if the nudge swaps the agent,
    // the slot's model no longer applies, so drop it (the new agent spawns with
    // its own default).
    if (r.agent !== "" && r.agent !== agent) {
      agent = r.agent;
      model = undefined;
    }
  }

  const out: RouteDecision = { agent, tier };
  if (model !== undefined && model !== "") out.model = model;
  if (warning !== undefined) out.warning = warning;
  return out;
}

// ── Pre-spawn availability fallback (mirrors _loop_resolve_fallback_agent) ────

/** Verdict of the pre-spawn availability fallback. */
export type FallbackVerdict =
  | { kind: "primary"; agent: string }
  | { kind: "fallback"; agent: string; fallbackFrom: string }
  | { kind: "exhausted"; primary: string; fallback?: string };

/** Ports for {@link resolveFallback}. */
export interface FallbackDeps {
  /** Availability verdict for an agent (true ⇒ usable now). Mirrors
   *  `_agent_available` (cache-backed; injected here). */
  isAvailable(agent: string): boolean;
  /** Read the dedicated `fallback` slot (`undefined` when unconfigured). */
  fallbackSlot(): string | undefined;
}

/**
 * Decide which agent the cycle actually runs given the routed PRIMARY, using a
 * PRE-SPAWN availability probe (NOT a failure-retry). Mirrors
 * `_loop_resolve_fallback_agent`:
 *   - primary available → run primary (no fallback).
 *   - primary down + fallback-slot agent available → run fallback (fallbackFrom).
 *   - neither usable → exhausted (the caller writes the ALERT and stops). We
 *     never chain past one fallback hop.
 */
export function resolveFallback(primary: string, deps: FallbackDeps): FallbackVerdict {
  if (primary === "") throw new Error("resolveFallback: primary agent required");
  if (deps.isAvailable(primary)) return { kind: "primary", agent: primary };

  const fb = deps.fallbackSlot();
  if (fb !== undefined && fb !== "" && deps.isAvailable(fb)) {
    return { kind: "fallback", agent: fb, fallbackFrom: primary };
  }
  return fb !== undefined && fb !== ""
    ? { kind: "exhausted", primary, fallback: fb }
    : { kind: "exhausted", primary };
}

// ── FIX-930: failure-driven agent swap (zero-TCR self-heal) ───────────────────

/**
 * FIX-930 — pick the NEXT routable agent for a tier, EXCLUDING agents already
 * tried (and failed with zero TCR) on this story. Walks the same slot chain as
 * {@link resolveRoute} extended with the dedicated `fallback` slot, returning the
 * first agent NOT in `excluded`; `null` when every chain agent is excluded
 * (roster exhausted → the caller escalates to split/PAUSE).
 *
 * SCOPE (invariant I6/I10 carve-out): this is the ONLY failure-driven agent swap
 * in the system, and it lives OUTSIDE the pure cycleStep machine — the CLI
 * adapter calls it after a `gave_up` (zero-TCR) cycle. The inner non-zero-exit
 * {@link retryPlan} budget still NEVER swaps agents (it retries the SAME agent),
 * and {@link resolveFallback} stays a pre-spawn availability hop only. Purity is
 * preserved: same (tier, slots, excluded) → same decision, no clock/rng/IO.
 * Availability is layered SEPARATELY by the caller via {@link resolveFallback}'s
 * `isAvailable` probe, keeping this function a deterministic slot-chain walk.
 */
export function resolveRouteExcluding(
  tier: Tier,
  deps: RouteDeps,
  excluded: readonly string[],
): RouteDecision | null {
  const ex = new Set(excluded.filter((a) => a !== ""));
  const chain: Array<Tier | "fallback"> = tier === "default" ? ["default", "fallback"] : [tier, "default", "fallback"];
  for (const slot of chain) {
    const s = deps.readSlot(slot);
    if (s?.agent !== undefined && s.agent !== "" && !ex.has(s.agent)) {
      const out: RouteDecision = { agent: s.agent, tier };
      if (s.model !== undefined && s.model !== "") out.model = s.model;
      return out;
    }
  }
  // Last resort: the first-installed agent, when not already excluded (no slot
  // config → no model). Mirrors resolveRoute's firstInstalled rung.
  const first = deps.firstInstalled();
  if (first !== undefined && first !== "" && !ex.has(first)) {
    return { agent: first, tier, warning: `agents.yaml: tier '${tier}' chain exhausted by exclusions; using first installed '${first}'` };
  }
  return null; // every routable agent already tried on this story → exhausted.
}
