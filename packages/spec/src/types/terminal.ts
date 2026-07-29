/**
 * US-TRUTH-001 — the Terminal Event schema (versioned, complete-or-reasoned).
 *
 * The cycle's old terminal records (cycle:end + runs row) mixed
 * failed/aborted/delivered/unknown and let a missing usage read as $0 — every
 * consumer guessed. A TerminalEvent makes incompleteness EXPLICIT: every fact
 * field is either present with a full value or carries an enumerated
 * absentReason. The truth anchor for cycle outcome stays the runs row
 * (truth.ts `cycle_outcome`); this event is its append-only, self-describing
 * twin in the event stream — written at the same moment, from the same facts.
 *
 * Grandfather policy (AC5): events written before this schema existed stay
 * untouched and are read under the legacy rules ("grandfathered" in audits);
 * from the version that ships this module, every cycle MUST append one
 * cycle:terminal event — the audit (US-TRUTH-002) flags new cycles without it.
 */

/** Bump on breaking shape changes; consumers branch on it. */
export const TERMINAL_EVENT_SCHEMA_VERSION = 1 as const;

/** The moment schema v1 SHIPPED (PR #586 merged 2026-06-10 ~17:10Z; pinned
 *  17:30Z). Cycles/rows before it are grandfathered in audits and selectors;
 *  everything after owes the complete-or-reasoned terminal twin. ONE home —
 *  the audit gatherer and the truth adapter import this, never re-declare. */
export const TERMINAL_SCHEMA_EPOCH_SEC = Date.UTC(2026, 5, 10, 17, 30) / 1000;

/** AC2 — the closed outcome vocabulary. `idle_no_work` is the honest name for
 *  an exit-0 zero-commit cycle where NO agent ran (a genuine no-op); `gave_up`
 *  is the honest name for an exit-0 zero-commit cycle where an agent EXECUTED
 *  but produced nothing (the productivity-floor failure, alerted on cycle 1). */
export const TERMINAL_OUTCOMES = [
  "delivered",
  "published_pending_merge",
  "failed",
  "blocked",
  "aborted_no_delivery",
  "aborted_with_delivery",
  "orphan_timeout",
  "idle_no_work",
  "gave_up",
  // US-LOOP-115: dormant_entered is no longer PRODUCED (the dormancy path is gone),
  // but historical runs.jsonl rows carry it, so the terminal vocabulary keeps it for
  // read-side compatibility. Never emit it.
  "dormant_entered",
  // FIX-351 — a cycle that reached the end with its gates PASSED (attest
  // produced + peer ok/consulted, real TCR commits, exit 0 → a `built` capture)
  // but whose publish could NOT complete (push / `gh pr create` failed before
  // any orphan branch was pushed). The WORK is sound and locally committed —
  // this is NOT a gate failure. A neutral "ran locally, never published" state,
  // distinct from `failed` (a gate genuinely failed / errored) and from
  // `aborted_with_delivery` (publish failed but the branch WAS pushed for audit).
  "unpublished",
  // FIX-908 — a cycle that did REAL work (≥1 commit, ≥1 tcr: commit, code-stage
  // peer agreed) but is missing a REQUIRED acceptance artifact at the terminal
  // (no independent peer Review Score, or an empty-shell acceptance report). The
  // attest gate honestly blocks it (no Done, no synthesized artifact), but the
  // work is SOUND and committed on the cycle branch. Pre-FIX-908 this fell into
  // plain `failed` + `no_publish_attempted` and the branch was orphaned/discarded.
  // `needs_review` keeps the branch and records that the delivery awaits a human/
  // re-run review — NOT a code defect, NOT a Done. Distinct from `failed` (a real
  // gate/code failure) and `unpublished` (gates PASSED but publish could not land).
  "needs_review",
  // FIX-1032a — a cycle whose PR was merged but main CI is red on the merge
  // commit. The merge landed (code is on main), but the delivery is NOT complete
  // — the code is broken per CI evidence. Distinct from `delivered` (CI green)
  // and `failed` (no merge occurred). The CI run URL is recorded for diagnostics.
  "ci_red_after_merge",
  // FIX-1039 — a builder exited with code 0 and left changes in the worktree
  // but did not create a TCR commit. The work is real but uncommitted; the
  // worktree is PRESERVED so the owner can inspect or rescue it. Distinct
  // from `gave_up` (agent ran, 0 output, nothing to preserve) and from
  // `idle_no_work` (no agent ran at all, no dirt).
  "handoff_without_tcr",
  "unknown",
] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/**
 * REFACTOR-071 — read-side compatibility for historical terminal outcomes that
 * new writers no longer produce. These remain accepted by rebuild/adapters, but
 * are not part of the closed write-side TerminalOutcome vocabulary.
 */
export const LEGACY_TERMINAL_OUTCOMES = [
  "agent_internal_failure",
] as const;
export type LegacyTerminalOutcome = (typeof LEGACY_TERMINAL_OUTCOMES)[number];
export type HistoricalTerminalOutcome = TerminalOutcome | LegacyTerminalOutcome;

/** AC3 — why a fact field has no value. Closed enum; "we don't know" is a
 *  reason, never a zero. */
export const ABSENT_REASONS = [
  "no_publish_attempted",
  "no_commits",
  "not_rendered",
  "acmap_missing",
  "no_parseable_usage",
  "probe_failed",
  "killed_before_capture",
  "killed_before_publish",
  "not_applicable",
  "not_recorded",
  // E3: a local-only delivery has no PR by design — prNumber/prUrl are absent
  // for this reason, not because a publish was attempted and failed.
  "local_only",
] as const;
export type AbsentReason = (typeof ABSENT_REASONS)[number];

/** A fact that is either fully present or explicitly reasoned-absent. */
export type FactOr<T> = { present: true; value: T } | { present: false; reason: AbsentReason };

export function present<T>(value: T): FactOr<T> {
  return { present: true, value };
}

export function absent<T = never>(reason: AbsentReason): FactOr<T> {
  return { present: false, reason };
}

export interface TerminalPrFact {
  url: string;
  state: string;
  number?: number;
}

export interface TerminalAttestFact {
  reportPath: string;
  acMap: boolean;
}

export interface TerminalUsageFact {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface TerminalCostFact {
  estimatedUsd: number;
  effectiveUsd: number;
}

/** The versioned terminal record (AC1) — one per cycle, append-only. */
export interface TerminalEvent {
  type: "cycle:terminal";
  schema: typeof TERMINAL_EVENT_SCHEMA_VERSION;
  cycleId: string;
  storyId: string;
  agent: string;
  /** FIX-294: the routed model, fixed by the routing decision at dispatch and
   *  therefore ALWAYS knowable — present even when usage could not be parsed.
   *  The `usage` fact still owns the present-or-reasoned token/cost truth (a
   *  true-0 usage stays distinguishable from unknown); this top-level model is
   *  the answer to "which model ran this cycle" regardless of usage capture.
   *  Empty string only when there was no routing context at all (e.g. a killed
   *  cycle's signal-teardown twin). FIX-290 fixed the runs row's model; this
   *  closes the same hole on the terminal-event twin. */
  model: string;
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt: number;
  outcome: TerminalOutcome;
  pr: FactOr<TerminalPrFact>;
  branch: FactOr<string>;
  commit: FactOr<string>;
  tcr: FactOr<number>;
  attest: FactOr<TerminalAttestFact>;
  usage: FactOr<TerminalUsageFact>;
  cost: FactOr<TerminalCostFact>;
  failure_class: FailureClass | null;
  root_cause_key: string | null;
  /** RollEvent stream timestamp (epoch milliseconds) — equals endedAt by default. */
  ts: number;
}

export type FailureClass = "env" | "harness" | "card" | "unknown";

/**
 * REFACTOR-067 — shared external block cause taxonomy, used by both the
 * `agent:blocked` event type and the env attribution classifiers.
 */
export type BlockCause = "auth" | "network" | "quota";

/**
 * REFACTOR-067 — map a BlockCause to its root cause key string.
 */
export function blockCauseRootKey(cause: BlockCause): string {
  return `env:${cause}`;
}

export interface TerminalEventInput {
  cycleId: string;
  storyId: string;
  agent: string;
  /** FIX-294: routed model (always knowable at dispatch). Optional on the input
   *  for backward compatibility with older call sites; defaults to "" — the
   *  runner passes the routed model so a no-parseable-usage cycle still records
   *  WHICH model ran. */
  model?: string;
  startedAt: number;
  endedAt: number;
  outcome: TerminalOutcome;
  pr: FactOr<TerminalPrFact>;
  branch: FactOr<string>;
  commit: FactOr<string>;
  tcr: FactOr<number>;
  attest: FactOr<TerminalAttestFact>;
  usage: FactOr<TerminalUsageFact>;
  cost: FactOr<TerminalCostFact>;
  failure_class?: FailureClass | null;
  root_cause_key?: string | null;
  ts?: number;
}

function epochMs(ts: number): number {
  return ts >= 1_000_000_000_000 ? ts : ts * 1000;
}

/** The one constructor — stamps type/schema so a hand-rolled object can't ship
 *  a missing field or a stale version. */
export function buildTerminalEvent(input: TerminalEventInput): TerminalEvent {
  const endedAt = epochMs(input.endedAt);
  return {
    type: "cycle:terminal",
    schema: TERMINAL_EVENT_SCHEMA_VERSION,
    cycleId: input.cycleId,
    storyId: input.storyId,
    agent: input.agent,
    model: input.model ?? "",
    startedAt: epochMs(input.startedAt),
    endedAt,
    outcome: input.outcome,
    pr: input.pr,
    branch: input.branch,
    commit: input.commit,
    tcr: input.tcr,
    attest: input.attest,
    usage: input.usage,
    cost: input.cost,
    failure_class: input.failure_class ?? null,
    root_cause_key: input.root_cause_key ?? null,
    ts: input.ts !== undefined ? epochMs(input.ts) : endedAt,
  };
}

/** Inputs for the orphan/killed-cycle verdict (AC4) — the residue a dead or
 *  runaway cycle leaves: a lock pid, a branch, an age. */
export interface OrphanResidue {
  /** Is the lock-owning pid still alive? */
  pidAlive: boolean;
  /** Commits ahead on the cycle branch; null = probe unavailable. */
  commitsAhead: number | null;
  /** Seconds since cycle start. */
  ageSec: number;
  /** The hard cycle timeout (LOOP_CYCLE_TIMEOUT_SEC class). */
  timeoutSec: number;
}

/**
 * Derive a terminal verdict for a cycle that never wrote one (AC4): a killed
 * process or runaway orphan must yield a DERIVABLE outcome instead of a hole
 * the dashboard guesses around.
 *
 *   dead pid + commits     → aborted_with_delivery (work exists — rescue it)
 *   dead pid + none        → aborted_no_delivery
 *   dead pid + no probe    → unknown (never a guessed no-delivery)
 *   live pid past timeout  → orphan_timeout
 *   live pid within budget → null (still legitimately running)
 */
export function deriveOrphanVerdict(residue: OrphanResidue): TerminalOutcome | null {
  if (residue.pidAlive) {
    return residue.ageSec >= residue.timeoutSec ? "orphan_timeout" : null;
  }
  if (residue.commitsAhead === null) return "unknown";
  return residue.commitsAhead > 0 ? "aborted_with_delivery" : "aborted_no_delivery";
}
