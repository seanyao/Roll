/**
 * @responsibility Plans the supervised recovery from a no-progress stop.
 */
/**
 * FIX-1049 — supervised recovery from a no-progress stop.
 *
 * The dead-loop breaker (loop-go.ts) STOPS a goal after K consecutive
 * whole-goal no-progress cycles or once every scope card is skipped. That is the
 * fail-loud backstop — an unmergeable card can never spin forever. But a stopped
 * goal used to be an OPAQUE dead end: the persisted `progress` (skippedCards /
 * zeroStreaks / noProgressCycles) makes the next `roll loop go` re-trip the
 * breaker instantly (`no_progress_on_all_cards`), so the routed NEXT eligible
 * Builder never runs without the operator hand-deleting `.roll/loop/goal.yaml`.
 *
 * This module is the PURE core of the supervised recovery path:
 *   1. {@link detectNoProgressStall} reads the persisted goal + event stream and,
 *      when the goal is stopped by no-progress, projects the auditable facts
 *      (blocked cards, per-card zero-delivery streaks, last failed Builder, the
 *      bounded handoff reference to a dirty-worktree/zero-TCR cycle).
 *   2. {@link planNoProgressRecovery} decides — given the next eligible Builder
 *      resolved by the caller — whether a supervised retry is `allowed` (a
 *      different Builder can be tried) or `denied` (no alternate Builder; the
 *      breaker correctly holds). It NEVER auto-clears: the decision is the
 *      operator's, this just adjudicates it.
 *   3. {@link clearStallForRecovery} produces the new `progress` block that frees
 *      ONE more attempt for the target card (drops its skip + zero streak, resets
 *      the whole-goal counter) without erasing the OTHER cards' accounting.
 *
 * IO (reading goal.yaml, resolving the route, writing events) lives in the
 * `loop-recover` command; this file is deterministic and unit-tested in
 * isolation.
 */
import type { GoalProgress, RollGoal, RollEvent } from "@roll/spec";

/** Reasons a goal is considered stopped by the no-progress breaker. */
const NO_PROGRESS_REASONS = new Set(["no_progress_breaker", "no_progress_on_all_cards"]);

/** A bounded reference to a failed cycle that left work but no TCR commit. */
export interface RecoveryHandoff {
  readonly cycleId: string;
  /** Why the cycle is a handoff (e.g. `zero_tcr_dirty_worktree`). */
  readonly kind: string;
  readonly detail: string;
  /** FIX-1068 — the preserved worktree path so the operator can inspect/rescue. */
  readonly worktreePath: string;
}

function worktreePathFor(cycleId: string): string {
  return `.roll/loop/worktrees/cycle-${cycleId}`;
}

/** Auditable facts about a goal stopped by the no-progress breaker. */
export interface NoProgressStall {
  /** The breaker reason the goal was stopped with. */
  readonly reason: string;
  /** Cards the breaker skipped (the trapped work). */
  readonly blockedCards: readonly string[];
  /** Per-card consecutive no-progress streaks (`{}` when none persisted). */
  readonly zeroStreaks: Readonly<Record<string, number>>;
  /** Consecutive whole-goal no-progress cycles at stop time. */
  readonly noProgressCycles: number;
  /** The Builder that ran the most recent cycle on a blocked card. */
  readonly lastBuilder?: string;
  /** The most recent cycle id on a blocked card (for the handoff reference). */
  readonly lastCycleId?: string;
  /** Bounded handoff reference when the last cycle left dirty work but no TCR. */
  readonly handoff?: RecoveryHandoff;
}

/**
 * Project the auditable no-progress facts from the persisted goal + events.
 * Returns `undefined` when the goal is NOT stopped by no-progress (an active
 * goal, a timebox/complete stop, or no goal at all) — there is nothing to
 * recover and the breaker has nothing to do with the current state.
 */
export function detectNoProgressStall(
  goal: RollGoal | undefined,
  events: readonly RollEvent[],
): NoProgressStall | undefined {
  if (goal === undefined || goal.status !== "paused") return undefined;
  const reason = stopReason(goal);
  if (reason === undefined) return undefined;

  const progress = goal.progress ?? {};
  const blockedCards = [...(progress.skippedCards ?? [])];
  const zeroStreaks = { ...(progress.zeroStreaks ?? {}) };
  const noProgressCycles = progress.noProgressCycles ?? 0;

  const blockedSet = new Set(blockedCards);
  const last = lastCycleOnBlockedCard(events, blockedSet);

  return {
    reason,
    blockedCards,
    zeroStreaks,
    noProgressCycles,
    ...(last?.agent !== undefined ? { lastBuilder: last.agent } : {}),
    ...(last?.cycleId !== undefined ? { lastCycleId: last.cycleId } : {}),
    ...(last?.handoff !== undefined ? { handoff: last.handoff } : {}),
  };
}

/** The breaker reason a paused goal carries, or undefined when not a breaker stop. */
function stopReason(goal: RollGoal): string | undefined {
  const decision = goal.lastDecisionReason;
  if (decision !== undefined && NO_PROGRESS_REASONS.has(decision)) return decision;
  // A `no_progress_breaker` pause also stamps the `progress` safety gate; honor
  // it as the fallback signal when the decision reason was overwritten.
  if (goal.safety?.lastGate === "progress") return goal.safety.lastReason || "no_progress_breaker";
  return undefined;
}

interface LastCycle {
  readonly cycleId: string;
  readonly agent?: string;
  readonly handoff?: RecoveryHandoff;
}

/**
 * Walk the event stream for the most recent `cycle:start` whose story is one of
 * the blocked cards (when `blocked` is empty, the most recent cycle overall),
 * carrying its Builder agent and — if that cycle ended `handoff_without_tcr` —
 * the bounded handoff reference (the dirty-worktree/zero-TCR case from AC4).
 */
function lastCycleOnBlockedCard(events: readonly RollEvent[], blocked: ReadonlySet<string>): LastCycle | undefined {
  const cycleStory = new Map<string, string>();
  const cycleAgent = new Map<string, string>();
  const handoffCycles = new Set<string>();
  const order: string[] = [];
  for (const ev of events) {
    if (ev.type === "cycle:start") {
      cycleStory.set(ev.cycleId, ev.storyId);
      cycleAgent.set(ev.cycleId, ev.agent);
      order.push(ev.cycleId);
    } else if (ev.type === "cycle:end" && ev.outcome === "handoff_without_tcr") {
      handoffCycles.add(ev.cycleId);
    }
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const cycleId = order[i]!;
    const story = cycleStory.get(cycleId);
    if (blocked.size > 0 && (story === undefined || !blocked.has(story))) continue;
    const agent = cycleAgent.get(cycleId);
    return {
      cycleId,
      ...(agent !== undefined && agent !== "" ? { agent } : {}),
      ...(handoffCycles.has(cycleId)
        ? {
            handoff: {
              cycleId,
              kind: "zero_tcr_dirty_worktree",
              detail: "the failed cycle left a preserved worktree with no TCR commit; inspect it before the retry",
              worktreePath: worktreePathFor(cycleId),
            },
          }
        : {}),
    };
  }
  return undefined;
}

/** The supervised-recovery adjudication. */
export type RecoveryDecision =
  | {
      readonly decision: "allowed";
      readonly storyId: string;
      readonly nextBuilder: string;
      readonly lastBuilder?: string;
      readonly skippedBuilders: readonly string[];
    }
  | { readonly decision: "denied"; readonly storyId?: string; readonly reason: string };

export interface RecoveryPlanInput {
  readonly stall: NoProgressStall;
  /** Operator-named card to recover; defaults to the sole blocked card. */
  readonly targetStoryId?: string;
  /**
   * The next eligible Builder the caller resolved (scoped route / tier router).
   * `undefined` = no Builder could be resolved at all (none installed / route
   * unresolved). When it equals {@link NoProgressStall.lastBuilder} the pool has
   * no rotation room — re-running the SAME Builder that just failed is not a
   * recovery, so it is denied.
   */
  readonly nextEligibleBuilder?: string;
}

/**
 * Adjudicate a supervised recovery. `allowed` only when a DIFFERENT eligible
 * Builder exists to try; otherwise `denied` with a clear reason. This is the AC
 * that the recovery must not become a blind retry of the failed Builder and must
 * be clearly explained when no next Builder is available.
 */
export function planNoProgressRecovery(input: RecoveryPlanInput): RecoveryDecision {
  const { stall, targetStoryId, nextEligibleBuilder } = input;

  const storyId = resolveTarget(stall.blockedCards, targetStoryId);
  if (storyId === null) {
    return { decision: "denied", reason: "no blocked card to recover (the goal was not stopped on a specific card)" };
  }
  if (storyId === undefined) {
    return {
      decision: "denied",
      reason: `multiple blocked cards (${stall.blockedCards.join(", ")}); name the card to recover`,
    };
  }

  if (nextEligibleBuilder === undefined || nextEligibleBuilder === "") {
    return {
      decision: "denied",
      storyId,
      reason: "no eligible Builder available (none installed or the route is unresolved); cannot rotate to a new Builder",
    };
  }
  if (stall.lastBuilder !== undefined && nextEligibleBuilder === stall.lastBuilder) {
    return {
      decision: "denied",
      storyId,
      reason: `only Builder '${nextEligibleBuilder}' is eligible and it already failed this card; no alternate Builder to rotate to`,
    };
  }

  return {
    decision: "allowed",
    storyId,
    nextBuilder: nextEligibleBuilder,
    ...(stall.lastBuilder !== undefined ? { lastBuilder: stall.lastBuilder } : {}),
    skippedBuilders: stall.lastBuilder !== undefined ? [stall.lastBuilder] : [],
  };
}

/**
 * Resolve the card to recover:
 *   - explicit `target` → that card (must be blocked);
 *   - no target + exactly one blocked card → that card;
 *   - no target + multiple blocked → `undefined` (ambiguous, ask);
 *   - no blocked cards at all → `null` (nothing to recover).
 * An explicit target that is NOT blocked is still returned (the operator may
 * recover a card the breaker stopped the WHOLE goal on before skipping it).
 */
function resolveTarget(blocked: readonly string[], target: string | undefined): string | undefined | null {
  const named = (target ?? "").trim();
  if (named !== "") return named;
  if (blocked.length === 0) return null;
  if (blocked.length === 1) return blocked[0]!;
  return undefined;
}

/**
 * Produce the new `progress` block that frees ONE more attempt for `storyId`:
 * drop its skip and zero-streak, reset the whole-goal no-progress counter (so the
 * pre-cycle breaker gate does not re-trip immediately), but PRESERVE every other
 * card's accounting. Returns `undefined` when the resulting block is empty (the
 * goal should then carry no `progress` at all).
 */
export function clearStallForRecovery(progress: GoalProgress | undefined, storyId: string): GoalProgress | undefined {
  const zeroStreaks: Record<string, number> = {};
  for (const [id, n] of Object.entries(progress?.zeroStreaks ?? {})) {
    if (id !== storyId && n > 0) zeroStreaks[id] = n;
  }
  const skippedCards = (progress?.skippedCards ?? []).filter((id) => id !== storyId);
  const hasZero = Object.keys(zeroStreaks).length > 0;
  if (!hasZero && skippedCards.length === 0) return undefined;
  return {
    ...(hasZero ? { zeroStreaks } : {}),
    ...(skippedCards.length > 0 ? { skippedCards } : {}),
    // noProgressCycles intentionally dropped (reset to 0) so the recovered card
    // gets a clean breaker budget; it re-accumulates if the retry also fails.
  };
}
