/**
 * @responsibility Decides CI monitoring, the pre-run CI gate and red heal-or-alert.
 * CI Loop — pure decision layer for CI monitoring, the pre-run CI gate, and the
 * bounded red→heal-or-alert decision (US-LOOP-004 / v2 US-LOOP-046/047/048/050,
 * US-LOOP-062a, FIX-103).
 *
 * ─── v2 archaeology (verify, don't assume) ──────────────────────────────────
 * v2 retired the standalone CI loop (FIX-194): there is NO `com.roll.ci.<slug>`
 * scheduled service. CI self-heal lives in the per-cycle PRE-RUN gate
 * (`_loop_precheck_ci`, run before the loop builds on the
 * current base). The v3 card re-establishes CI as a SEPARATE loop service; the
 * BEHAVIOUR this module mirrors is exactly those two v2 paths, restructured as a
 * v3 ci-loop's two pure verdicts:
 *
 *   (A) PRE-RUN GATE — {@link precheckCiVerdict}. Mirrors `_loop_precheck_ci`
 *       (bin/roll 11220-11299): inspect the HEAD commit's CI runs; a genuinely
 *       red conclusion (FIX-103: distinguish in_progress/null from failure)
 *       either signals the hot-fix path (exit 2, within heal budget) or aborts
 *       the cycle with an ALERT (exit 1). Green/pending → pass (exit 0).
 *
 *   (B) RED → HEAL-OR-FIX_FORWARD — {@link prHealVerdict}. Mirrors `_loop_pr_heal_self`
 *       (bin/roll 11484-11524): a red loop/* PR is background-healed UP TO a
 *       per-PR budget (heal_count.pr:<n> < ROLL_LOOP_HEAL_MAX, default 2;
 *       ROLL_LOOP_NO_HEAL=1 disables), guarded by a per-PR lock (live pid ⇒
 *       already healing; dead pid ⇒ reclaim). Disabled / budget-exhausted /
 *       in-flight → a deduped ALERT (never silent — US-LOOP-062a). The heal
 *       CONTEXT (failing-run log parse) is `_loop_pr_do_heal` (11532): the
 *       gh run-list/view shapes are consumed from infra/github.ts.
 *
 * This module is PURE: budget arithmetic, the FIX-103 conclusion classifier, the
 * lock-liveness verdict, the heal-vs-alert branch, and the failing-run-id
 * selection are data→decision functions. The actual gh probes, the agent spawn
 * in a throwaway worktree, the state-file upsert, and the ALERT append are the
 * adapter's. `now` and pid-liveness are injected.
 *
 * Purity: no spawn, no sleep, no clock, no fs.
 */

// ── heal budget constants (bin/roll 11250 / 11488) ───────────────────────────

/** Default per-PR / per-HEAD heal budget — ROLL_LOOP_HEAL_MAX (bin/roll 11250/11488). */
export const DEFAULT_HEAL_MAX = 2;

/**
 * Resolve the effective heal budget from the two env knobs the oracle reads —
 * `ROLL_LOOP_NO_HEAL` (a hard off-switch) and `ROLL_LOOP_HEAL_MAX` (the count).
 * Mirrors bin/roll 11250-11251 / 11488-11489:
 *   - NO_HEAL == "1"            → 0 (healing disabled).
 *   - HEAL_MAX numeric          → that value (clamped ≥ 0).
 *   - HEAL_MAX unset/non-numeric → {@link DEFAULT_HEAL_MAX}.
 * A resolved budget of 0 means "no heal" (the oracle's `heal_max <= 0` gate).
 */
export function resolveHealMax(noHeal: string | undefined, healMax: string | undefined): number {
  if (noHeal === "1") return 0;
  if (healMax !== undefined && /^\d+$/.test(healMax.trim())) return Number(healMax.trim());
  return DEFAULT_HEAL_MAX;
}

// ── (A) pre-run CI gate (mirrors _loop_precheck_ci, bin/roll 11220-11299) ────

/**
 * Conclusions that BLOCK the loop — the FIX-103 red set (bin/roll 11238).
 * Anything else (success, skipped, neutral, OR null while still running) is
 * treated as pass/pending: this is the load-bearing FIX-103 distinction that
 * stops a still-running merge-triggered CI from killing every fresh cycle.
 */
export const CI_FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
]);

/** One HEAD-commit CI run row (`gh run list --commit <c> --json conclusion,status`). */
export interface CiRunRow {
  /** GitHub run conclusion; `null`/absent while still running (FIX-103). */
  conclusion: string | null | undefined;
  /** GitHub run status (queued/in_progress/completed); informational here. */
  status?: string | null | undefined;
}

/**
 * Are any HEAD CI runs genuinely red? — mirrors the jq at bin/roll 11237-11239:
 * collect the conclusions in {@link CI_FAILED_CONCLUSIONS}; non-empty ⇒ red. A
 * `null`/running conclusion is NOT red (FIX-103). Returns the sorted-unique list
 * of red conclusions (the oracle's `unique | join(",")`), so the caller can put
 * them in the ALERT verbatim; empty array ⇒ pass/pending.
 */
export function redConclusions(runs: readonly CiRunRow[]): string[] {
  const reds = new Set<string>();
  for (const r of runs) {
    const c = r.conclusion;
    if (typeof c === "string" && CI_FAILED_CONCLUSIONS.has(c)) reds.add(c);
  }
  return [...reds].sort();
}

/** One poll's verdict for the `roll ci --wait` gate (US-PORT-015). */
export type CiWaitTick = "no-runs" | "pending" | "failed" | "passed";

/**
 * Classify ONE poll of the HEAD-commit CI runs, mirroring `_ci_wait`'s per-loop
 * decision order EXACTLY (bin/roll): no rows → "no-runs" (caller then checks for
 * an open PR / keeps waiting); else any run whose status !== "completed" →
 * "pending" (checked BEFORE failure, so a still-running sibling defers a verdict
 * even when another already failed); else any completed conclusion that is not
 * "success"/"skipped"/null → "failed"; otherwise "passed". A null conclusion on
 * a completed run is NOT a failure (FIX-103 lenience).
 */
export function ciWaitTick(runs: readonly CiRunRow[]): CiWaitTick {
  if (runs.length === 0) return "no-runs";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  const failed = runs.some((r) => {
    const c = r.conclusion;
    return c !== "success" && c !== "skipped" && c !== null && c !== undefined;
  });
  return failed ? "failed" : "passed";
}

/** The pre-run CI gate verdict — maps 1:1 to the oracle's exit codes. */
export type PrecheckVerdict =
  | { exit: 0; reason: "no_runs" | "green_or_pending" } // pass: build allowed.
  | { exit: 2; reason: "red_heal_available"; nextCount: number } // hot-fix path armed.
  | { exit: 1; reason: "red_abort"; redConclusions: string[] }; // abort + ALERT.

/** Facts for {@link precheckCiVerdict} — gathered by the adapter. */
export interface PrecheckInput {
  /** True iff `_gh_resolve` succeeded AND a HEAD commit resolved (else exit 0). */
  ghAndCommitOk: boolean;
  /** The HEAD-commit CI run rows ([] when the list was empty / failed). */
  runs: readonly CiRunRow[];
  /** The resolved heal budget ({@link resolveHealMax}). */
  healMax: number;
  /** Current `heal_count_head_<sha8>` from the state file (0 when absent). */
  headHealCount: number;
}

/**
 * The pre-run CI gate decision — mirrors `_loop_precheck_ci` (bin/roll
 * 11220-11298) in order:
 *   - gh/commit unresolved OR no runs    → exit 0 (lenient pass, 11221-11232).
 *   - no red conclusions                 → exit 0 (green/pending, 11241 false).
 *   - red AND heal enabled AND count<max → exit 2, increment counter
 *       (the hot-fix path: agent fixes the red base, 11251-11276). nextCount is
 *       the value the caller persists to `heal_count_head_<sha8>`.
 *   - red AND (disabled OR budget hit)   → exit 1, ALERT (11279-11296).
 * Note the oracle increments the counter ONLY on the exit-2 path (11259); the
 * exit-1 path writes the ALERT and does not touch the counter.
 */
export function precheckCiVerdict(input: PrecheckInput): PrecheckVerdict {
  if (!input.ghAndCommitOk || input.runs.length === 0) {
    return { exit: 0, reason: "no_runs" };
  }
  const reds = redConclusions(input.runs);
  if (reds.length === 0) {
    return { exit: 0, reason: "green_or_pending" };
  }
  // red base: hot-fix path if enabled and under budget (bin/roll 11251-11257).
  if (input.healMax > 0 && input.headHealCount < input.healMax) {
    return { exit: 2, reason: "red_heal_available", nextCount: input.headHealCount + 1 };
  }
  return { exit: 1, reason: "red_abort", redConclusions: reds };
}

// ── (B) red loop/* PR → heal-or-alert (mirrors _loop_pr_heal_self, 11484) ────

/**
 * Per-PR heal-lock liveness — mirrors the lock check at bin/roll 11497-11503.
 * The lock file holds the healer's pid; `kill -0` decides:
 *   - live pid  → a heal is already in flight (return 0, do nothing).
 *   - dead pid  → stale lock, reclaim (rm) and proceed.
 *   - no lock   → proceed.
 */
export interface HealLockState {
  /** True iff the per-PR lock file exists (bin/roll 11497). */
  lockPresent: boolean;
  /** `kill -0 <lpid>` result; undefined when there is no lock / no pid. */
  lockPidAlive: boolean | undefined;
}

/** What to do about the heal lock before considering budget. */
export type HealLockVerdict =
  | { kind: "in_flight" } // live pid → skip (a heal is running, 11500).
  | { kind: "reclaim" } // dead pid → rm the stale lock, then proceed (11502).
  | { kind: "free" }; // no lock → proceed.

/** Decide the lock disposition — mirrors bin/roll 11497-11503. */
export function healLockVerdict(lock: HealLockState): HealLockVerdict {
  if (!lock.lockPresent) return { kind: "free" };
  if (lock.lockPidAlive === true) return { kind: "in_flight" };
  return { kind: "reclaim" };
}

/** The deduped ALERT message strings the heal path emits (bin/roll 11490/11510). */
export type HealAlertReason =
  | "disabled" // ROLL_LOOP_NO_HEAL / heal_max<=0 (bin/roll 11490).
  | "budget_exhausted"; // count >= heal_max (bin/roll 11510).

/** The red-PR heal decision. */
export type PrHealVerdict =
  | { kind: "in_flight" } // a heal is already running for this PR (lock live).
  | { kind: "alert"; reason: HealAlertReason; message: string } // truly unrecoverable → deduped ALERT.
  | { kind: "fix_forward"; reason: HealAlertReason; message: string } // auto-heal off/budget hit → signal main loop to resume original branch.
  | { kind: "dispatch"; nextCount: number; attempt: string }; // background heal.

/** Facts for {@link prHealVerdict}. */
export interface PrHealInput {
  /** The PR number (string, as gh reports it). */
  pr: string;
  /** The PR head ref (for the ALERT message / heal target). */
  headRef: string;
  /** The resolved heal budget ({@link resolveHealMax}). */
  healMax: number;
  /** Current `heal_count.pr:<num>` from the state file (0 when absent). */
  prHealCount: number;
  /** The lock disposition ({@link healLockVerdict}). */
  lock: HealLockVerdict;
}

/**
 * The red loop/* PR heal-or-fix_forward decision — mirrors `_loop_pr_heal_self`
 * (bin/roll 11484-11524) in order:
 *   1. healMax <= 0 (disabled)        → fix_forward "auto-heal off" (11489-11491).
 *   2. lock live                      → in_flight, no-op (11499-11500).
 *      lock dead → reclaim, continue (11502).
 *   3. count >= max                   → fix_forward "budget exhausted" (11509-11511).
 *   4. else                           → dispatch background heal; persist
 *                                       heal_count.pr:<n> = count+1 (11513-11522).
 * The `message` strings mirror the oracle's `_loop_pr_ci_red_alert` payloads
 * (bin/roll 11490 / 11510) so the dedup key `[TYPE:loop-pr-ci-red] PR #<n>` is
 * byte-stable across ticks.
 */
export function prHealVerdict(input: PrHealInput): PrHealVerdict {
  if (input.healMax <= 0) {
    return {
      kind: "fix_forward",
      reason: "disabled",
      message: "auto-heal off (ROLL_LOOP_NO_HEAL) — main loop should resume original branch",
    };
  }
  if (input.lock.kind === "in_flight") {
    return { kind: "in_flight" };
  }
  if (input.prHealCount >= input.healMax) {
    return {
      kind: "fix_forward",
      reason: "budget_exhausted",
      message: `auto-heal budget exhausted (${input.prHealCount}/${input.healMax}) — main loop should resume original branch`,
    };
  }
  return {
    kind: "dispatch",
    nextCount: input.prHealCount + 1,
    attempt: `${input.prHealCount + 1}/${input.healMax}`,
  };
}

// ── deduped ALERT line shape (mirrors _loop_pr_ci_red_alert, bin/roll 11450) ─

/** The dedup key for a red-loop-PR ALERT — one line per PR until consumed. */
export function ciRedAlertDedupKey(pr: string): string {
  return `[TYPE:loop-pr-ci-red] PR #${pr} `;
}

/**
 * Build the deduped CI-red ALERT line — mirrors `_loop_pr_ci_red_alert`
 * (bin/roll 11456-11457). The adapter appends this ONLY if {@link
 * ciRedAlertDedupKey} is not already present in the alert file (grep -qF,
 * bin/roll 11455). `ts` is the injected `date -u +%Y-%m-%dT%H:%M:%SZ`.
 */
export function ciRedAlertLine(ts: string, pr: string, headRef: string, message: string): string {
  return `[${ts}] [error] [TYPE:loop-pr-ci-red] PR #${pr} ${headRef}: ${message}`;
}

// ── heal context: failing-run-id selection (mirrors _loop_pr_do_heal, 11544) ─

/** A `gh pr checks --json link` row the heal path inspects (bin/roll 11544). */
export interface PrCheckLinkRow {
  /** The check's link url (the heal path greps `runs/<id>` out of it). */
  link: string | undefined;
  /** The check state — only FAILURE links are followed (bin/roll 11544 jq). */
  state: string | undefined;
}

/**
 * Pick the first failing run id from `gh pr checks --json link` rows — mirrors
 * the pipeline at bin/roll 11544-11545: select rows with state == "FAILURE",
 * extract `runs/<digits>` from the link, take the FIRST id. Returns undefined
 * when no failing run is found (the oracle then skips the log fetch).
 */
export function firstFailingRunId(rows: readonly PrCheckLinkRow[]): string | undefined {
  for (const r of rows) {
    if (r.state !== "FAILURE") continue;
    const link = r.link;
    if (link === undefined) continue;
    const m = /runs\/(\d+)/.exec(link);
    if (m && m[1] !== undefined) return m[1];
  }
  return undefined;
}

/**
 * Did the heal agent produce commits worth pushing? — mirrors the
 * `git rev-list origin/<head>..HEAD` non-empty gate at bin/roll 11562. The
 * adapter runs the rev-list; this names the decision: a non-empty ahead-list
 * ⇒ push back to the SAME PR branch, else leave the PR untouched (the budget
 * caps retries on the next tick).
 */
export function healProducedCommits(aheadCommitCount: number): boolean {
  return aheadCommitCount > 0;
}

// ── ci-loop tick state (mirrors _loop_write_tick "ci", bin/roll 8008-8035) ───

/** A CI-loop tick outcome label. */
export type CiTickOutcome = "idle" | "acted";

/** A CI-loop tick row (sans ts), serialized by the adapter via _loop_write_tick. */
export interface CiTick {
  loop: "ci";
  outcome: CiTickOutcome;
  note: string;
}

/** Build a CI-loop tick row. */
export function ciTick(outcome: CiTickOutcome, note: string): CiTick {
  return { loop: "ci", outcome, note };
}
