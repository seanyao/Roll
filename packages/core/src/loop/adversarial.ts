/**
 * @responsibility Drives the bounded adversarial review round state machine.
 */
export interface AdversarialState {
  round: number;
  dryStreak: number;
}

export interface AdversarialCfg {
  maxRounds: number;
  dryRoundsToStop: number;
  elapsedSec: number;
  totalTimeoutSec: number;
}

export interface AdversarialRole {
  agent: string;
  sessionId: string;
  parentSessionId?: string;
}

export type NextStep =
  | { kind: "attack" }
  | { kind: "fix" }
  | { kind: "stop"; reason: "dry" | "max_rounds" | "timeout" };

export type AdversarialFailure =
  | { kind: "non_hetero"; detail: string }
  | { kind: "agent_unavailable"; role: string }
  | { kind: "round_hang"; round: number }
  | { kind: "total_timeout" };

export function adversarialDegradeDecision(f: AdversarialFailure): {
  degrade: true;
  fallback: "single-builder";
  cause: string;
} {
  switch (f.kind) {
    case "non_hetero":
      return {
        degrade: true,
        fallback: "single-builder",
        cause: `adversarial pairing disabled: roles not heterogenous or independent (${f.detail})`,
      };
    case "agent_unavailable":
      return {
        degrade: true,
        fallback: "single-builder",
        cause: `adversarial pairing degraded: ${f.role} agent unavailable`,
      };
    case "round_hang":
      return {
        degrade: true,
        fallback: "single-builder",
        cause: `adversarial pairing degraded: round ${f.round} hung`,
      };
    case "total_timeout":
      return {
        degrade: true,
        fallback: "single-builder",
        cause: "adversarial pairing degraded: total timeout",
      };
    default: {
      const _exhaustive: never = f;
      void _exhaustive;
      return {
        degrade: true,
        fallback: "single-builder",
        cause: "adversarial pairing degraded: unknown adversarial failure",
      };
    }
  }
}

export function adversarialNextStep(
  state: AdversarialState,
  lastRound: { newHole: boolean } | null,
  cfg: AdversarialCfg,
): NextStep {
  if (cfg.elapsedSec >= cfg.totalTimeoutSec) {
    return { kind: "stop", reason: "timeout" };
  }

  if (state.round >= cfg.maxRounds) {
    return { kind: "stop", reason: "max_rounds" };
  }

  if (lastRound === null) {
    return { kind: "attack" };
  }

  if (lastRound.newHole) {
    return { kind: "fix" };
  }

  const effectiveDry = state.dryStreak + 1;
  if (effectiveDry >= cfg.dryRoundsToStop) {
    return { kind: "stop", reason: "dry" };
  }

  return { kind: "attack" };
}

/**
 * Scope (pi review, US-LOOP-100): catches self-collusion (same session) and DIRECT
 * parent/sub-agent in either direction — the realistic loop spawn scenario. It does
 * NOT walk transitive ancestor chains (grandparent↔grandchild), because an
 * AdversarialRole carries only its immediate parentSessionId; the loop spawns
 * test_author / implementer as fresh top-level sessions, so a transitive chain is
 * not a path the orchestrator produces. Revisit only if roles ever carry a full
 * ancestor list.
 */
export function assertAdversarialIndependence(
  testAuthor: AdversarialRole,
  implementer: AdversarialRole,
): { ok: true } | { ok: false; reason: string } {
  if (testAuthor.sessionId === implementer.sessionId) {
    return { ok: false, reason: "roles must use independent sessions" };
  }

  if (
    testAuthor.parentSessionId === implementer.sessionId ||
    implementer.parentSessionId === testAuthor.sessionId
  ) {
    return { ok: false, reason: "roles must not be parent/sub-agent sessions" };
  }

  return { ok: true };
}

// ── US-LOOP-104: adversarial observability (event-sourced) ────────────────────
// The adversarial:* events (US-LOOP-102/106) are the durable record; these pure
// folds derive the per-cycle summary + cross-cycle aggregate WITHOUT re-running
// anything, so the shadow-run (design §9) measures "does adversarial pairing
// really catch more bugs" from the stream, not from spawn logs.

/** One adversarial cycle's outcome, folded from its adversarial:* events. */
export interface AdversarialRunSummary {
  /** attacker rounds run (from adversarial:terminated, else counted). */
  rounds: number;
  /** holes the attacker broke open. */
  holesFound: number;
  /** how the subsequence ended. `degraded` = fell back to a single builder. */
  terminationReason: "dry" | "max_rounds" | "timeout" | "degraded";
  /** true iff the cycle degraded to a standard single builder (US-LOOP-106). */
  degraded: boolean;
}

/** Minimal event shape this fold needs (a subset of RollEvent). Kept structural
 *  so callers can pass RollEvent[] without an import cycle. */
interface AdversarialEventLike {
  type: string;
  cycleId?: string;
  round?: number;
  newHole?: boolean;
  holesFound?: number;
  rounds?: number;
  reason?: string;
}

/**
 * Fold one cycle's adversarial:* events into a summary, or `null` when the cycle
 * ran NO adversarial subsequence (a standard cycle — the common case). Robust to
 * an interrupted cycle: if no terminal `adversarial:terminated`/`:degraded` event
 * was written, it still counts the attack rounds and marks the run `degraded`
 * (it did not cleanly conclude).
 */
export function foldCycleAdversarial(
  events: readonly AdversarialEventLike[],
  cycleId: string,
): AdversarialRunSummary | null {
  const adv = events.filter(
    (e) => e.cycleId === cycleId && typeof e.type === "string" && e.type.startsWith("adversarial:"),
  );
  if (adv.length === 0) return null;

  const degraded = adv.some((e) => e.type === "adversarial:degraded");
  const terminated = [...adv].reverse().find((e) => e.type === "adversarial:terminated");
  if (terminated !== undefined) {
    const reason = terminated.reason;
    return {
      rounds: typeof terminated.rounds === "number" ? terminated.rounds : 0,
      holesFound: typeof terminated.holesFound === "number" ? terminated.holesFound : 0,
      terminationReason:
        reason === "dry" || reason === "max_rounds" || reason === "timeout" ? reason : "degraded",
      degraded,
    };
  }
  // No clean termination: count the attack rounds we saw.
  const attackRounds = adv.filter((e) => e.type === "adversarial:attack-round");
  return {
    rounds: attackRounds.reduce((m, e) => Math.max(m, typeof e.round === "number" ? e.round : 0), 0),
    holesFound: attackRounds.filter((e) => e.newHole === true).length,
    terminationReason: "degraded",
    degraded: true,
  };
}

/** The cross-cycle adversarial aggregate — the shadow-run's read-only metrics. */
export interface AdversarialAggregate {
  /** number of adversarial cycles in the cohort. */
  cards: number;
  /** mean holes broken open per adversarial cycle. */
  avgHoles: number;
  /** mean attacker rounds per adversarial cycle. */
  avgRounds: number;
  /** fraction (0..1) of adversarial cycles that degraded to a single builder. */
  degradeRate: number;
}

/** Aggregate per-cycle adversarial summaries into the cohort metrics. Empty
 *  cohort → all-zero (never NaN). */
export function aggregateAdversarial(summaries: readonly AdversarialRunSummary[]): AdversarialAggregate {
  const cards = summaries.length;
  if (cards === 0) return { cards: 0, avgHoles: 0, avgRounds: 0, degradeRate: 0 };
  const holes = summaries.reduce((s, x) => s + x.holesFound, 0);
  const rounds = summaries.reduce((s, x) => s + x.rounds, 0);
  const degraded = summaries.reduce((s, x) => s + (x.degraded ? 1 : 0), 0);
  return { cards, avgHoles: holes / cards, avgRounds: rounds / cards, degradeRate: degraded / cards };
}
