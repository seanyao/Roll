/**
 * CycleOrchestrator — TS port of the v2 loop "inner cycle runner" (US-LOOP-001).
 *
 * This is the COMPOSITION card: nearly every building block already exists as a
 * pure module (backlog/picker, agent/router, delivery/{pr,tcr}, reconcile/engine,
 * events/bus, loop/recovery). This module is the conductor — a PURE
 * state machine that walks the {@link CyclePhase} ladder, deciding at each step
 * WHICH building-block command to run next and WHAT terminal {@link TerminalOutcome}
 * the cycle lands on. It NEVER spawns a process, sleeps, or reads a clock; every
 * I/O result (story pick, route, worktree create, agent exit, publish status,
 * merge poll, reconcile evidence) is fed back in as an {@link CycleEvent}, and the
 * stepper returns the next state + an ordered list of {@link CycleCommand}s for an
 * injected executor (the CLI/infra adapter) to perform.
 *
 * ── v2 oracle phase map (bin/roll, frozen; read FULLY before any change) ──────
 * The inner runner heredoc spans bin/roll:8391-9380. Phase-by-phase line ranges:
 *
 *   PHASE              v2 _phase_begin/_phase_end  oracle lines   v3 CyclePhase
 *   ─────────────────  ──────────────────────────  ─────────────  ─────────────
 *   startup            startup                     8835-8836      (pre-pick env/lock/heartbeat — recovery.ts)
 *   preflight          preflight                   8837-8907      (preflightPlan + orphan recovery — recovery.ts)
 *   worktree_setup     worktree_setup              8908-9008      worktree
 *     ├─ create/sync   _worktree_create/sync_meta  8909-8917
 *     ├─ pick story    _loop_pick_next_story       8938          pick   (picker.ts)
 *     ├─ TOCTOU repick FIX-146                      8941-8956     pick   (picker re-eligibility)
 *     ├─ route         _loop_pick_agent_for_story  8957-8964     route  (router.ts resolveRoute)
 *     └─ fallback      _loop_resolve_fallback_agent 8965-8983     route  (router.ts resolveFallback)
 *   agent_invoke       agent_invoke                9026-9078      execute
 *     ├─ watchdog arm  FIX-057/068 sleep+SIGTERM   9044-9052      (watchdogVerdict)
 *     ├─ spawn+TCR     claude -p | loop-fmt        9053-9062      execute (agent runs, commits TCR)
 *     └─ retry 1..3    `for _attempt in 1 2 3`     9032-9072      execute (retryPlan)
 *   (timeout abort)    _CYCLE_TIMED_OUT short-circ 9120-9125      → blocked (watchdog breach)
 *   (capture facts)    git rev-list/log count      9127-9157      reconcile (six-state classify)
 *   publish_push       publish_push                9227-9356      publish
 *     ├─ idle (0 ahd)  _worktree_cleanup + idle    9180-9198      → idle outcome
 *     ├─ status 0      _loop_publish_pr ok         9239-9265      merge-wait→done
 *     ├─ status 2      gh missing → merge_back     9266-9318      → done | orphan | failed
 *     └─ status other  PR-fail → orphan push       9319-9356      → orphan | failed
 *   merge-wait         (retired; reconciler owns it) 9241-9250     merge-wait (handed off; see note)
 *   cleanup            cleanup                     9251-9265      cleanup
 *   (EXIT trap)        _inner_cleanup              8665-8772      (terminal-event invariant I8)
 *
 * Two phases the spec names but v2 folds differently:
 *   - "merge-wait": v2 (US-AUTO-044, bin/roll:9241-9250) HANDS the merged PR to a
 *     Delivery Reconciler rather than blocking the cycle. The pre-AUTO-044
 *     SYNCHRONOUS wait (`_loop_wait_pr_merge`, bin/roll:13580-13599) is already
 *     ported as delivery/pr.ts {@link nextWaitAction}. This orchestrator models
 *     merge-wait as an OPTIONAL phase (driven by {@link nextWaitAction}) so a
 *     caller can choose the synchronous shape (the card's "等真合并") OR the
 *     hand-off shape; the default walk hands off (v2 today) and treats `done` as
 *     "published, awaiting reconcile", with reconcile crediting built→merged
 *     on real evidence (reconcile/engine.ts {@link reconcileMergeEvidence}, I4).
 *   - "reconcile": v2 does the per-cycle status capture inline (bin/roll:9127-9157)
 *     and the real merge backfill in a SEPARATE pass (`_loop_backfill_merged`).
 *     Here `reconcile` is the phase that classifies the six-state terminal from
 *     the captured facts ({@link classifyCaptured}) and, when synchronous, folds
 *     merge evidence.
 *
 * ── Terminal outcome model ────────────────────────────────────────────────────
 * v2 stamps one of SIX runs.jsonl statuses (idle/built/failed/orphan/aborted/done)
 * — see _runs_append callers + the EXIT trap. {@link classifyCaptured} and
 * {@link captureToSpecOutcome} map v2 runner rows to TerminalOutcome. The
 * {@link V2CycleStatus} internal vocabulary is kept for byte-faithful runs-row
 * parity; emitted cycle:end events and new row `outcome` fields use the closed
 * terminal vocabulary.
 *
 * ── Hard timeout (B-group AC) ─────────────────────────────────────────────────
 * v2 LOOP_CYCLE_TIMEOUT_SEC=2700 (bin/roll:8473). The watchdog (bin/roll:9044-9052)
 * SIGTERMs the inner script at the breach, SIGKILLs after a 5s grace; the EXIT
 * trap then writes cycle_end `blocked` + ALERT and releases the inner lock WITHOUT
 * cleaning the worktree (preserved for audit, bin/roll:9122). {@link watchdogVerdict}
 * is the pure breach decision; {@link timeoutTeardownCommands} renders the clean
 * teardown command sequence (kill → terminal event → lock release), order-asserted
 * in tests. The OUTER guard (bin/roll:9562, timeout+300) is the adapter's; this
 * module owns the INNER decision.
 *
 * ── Transient retry / backoff (B-group AC, I6) ────────────────────────────────
 * v2's `for _attempt in 1 2 3` (bin/roll:9032-9072) is a PROCESS-EXIT retry: any
 * non-zero agent exit (that is not a timeout) retries up to 3 times with a FIXED
 * 30s sleep (bin/roll:9070), then falls through to `failed`. It does NOT classify
 * transient-vs-permanent and does NOT swap agents on failure (I6: in-cycle bounded
 * retry is SEPARATE from the loop-level consecutive-failure PAUSE — agent swap is a
 * PRE-SPAWN availability fallback only, router.ts {@link resolveFallback}).
 * {@link retryPlan} mirrors v2's 3-attempt budget and adds an EXPONENTIAL backoff
 * schedule (NEW v3: the AC+ asks for "退避"; v2 uses a flat 30s, kept as the base).
 * Exhaustion → `failed` (NEVER agent-swap — I6). The timeout breach short-circuits
 * the retry loop (bin/roll:9066 `break`), so a timed-out attempt is NOT retried.
 *
 * ── No cost gate (budget control removed) ─────────────────────────────────────
 * v2 had NO cost gate in the runner, and v3 no longer adds one: the dollar
 * ceiling was a lagging, gameable proxy for "this run is wasting resources".
 * route_resolved now transitions straight to the agent spawn. Runaway-spend
 * protection moved to the DIRECT progress guardrails in loop-go.ts (the
 * per-cycle productivity floor + the cross-session dead-loop breaker), which
 * stop the loop on NO PROGRESS — earlier and deterministically. Per-cycle
 * token/cost is still fully RECORDED (cost/tracker.ts → runs.jsonl); only the
 * CONTROL was removed, not the observability.
 *
 * Purity: no spawn, no sleep, no clock, no fs. The stepper is a referentially
 * transparent `(state, event) → { state, commands }`. Callers thread the returned
 * state back in with the next observed event; the {@link CycleCommand}s name the
 * existing ports/plans so the adapter dispatches them 1:1.
 */
import type {
  AgentId,
  AgentCapacityKey,
  AgentCapacityLease,
  BuilderFinalizationFacts,
  CycleCost,
  CyclePhase,
  CycleRepositoryExecutionContext,
  ExecutionProfile,
  FailureClass,
  ModelId,
  RepositoryCycleIdentity,
  RepositoryExecutionContext,
  TerminalOutcome,
} from "@roll/spec";
import { cycleCurrency } from "../cost/tracker.js";
import type { RollEvent } from "@roll/spec";
import { builderFinalizationReady, finalizeBuilder, handoffKindFor } from "./builder-finalization.js";
import { adversarialNextStep, adversarialDegradeDecision, type AdversarialFailure, type AdversarialRunSummary } from "./adversarial.js";
import { nextWaitAction, type WaitAction } from "../delivery/pr.js";

// ── v2 terminal vocabulary (six-state model) ─────────────────────────────────

/**
 * The SIX runs.jsonl statuses the v2 runner stamps (the EXIT trap + every
 * `_runs_append` call site). Kept as an explicit internal vocabulary so the
 * runs-row parity stays byte-faithful (diff-tested in outcome.difftest):
 *   - idle    : exit 0, zero commits ahead of origin/main (bin/roll:9197).
 *   - built   : exit 0, ≥1 commit ahead, claimed-but-unconfirmed (bin/roll:9142).
 *   - done    : published / ff-merged — the only success the dashboard credits
 *               (bin/roll:9261/9275; reconcile later promotes built→merged).
 *   - orphan  : publish failed but branch+tag pushed for audit (bin/roll:9293/9308/9331/9346).
 *   - failed  : agent non-zero after retry, guard/test-gate fail (a GATE failed)
 *               (bin/roll:9133/9209/9219).
 *   - local   : FIX-351 — gates PASSED (a `built` capture: exit 0, ≥1 commit, no
 *               attest/peer block) but the publish could NOT complete and no
 *               orphan branch was pushed. The work is sound + locally committed,
 *               it just never left the machine. A neutral non-failure terminal,
 *               distinct from `failed` (a gate genuinely failed) and `orphan`
 *               (publish failed but the branch WAS pushed for audit).
 *   - aborted : EXIT-trap catch-all — SIGKILL / set -e fire, no explicit terminal
 *               (bin/roll:8756).
 *   - blocked : hard-timeout breach (bin/roll:8679).
 */
export type V2CycleStatus =
  | "idle"
  | "gave_up"
  | "handoff_without_tcr"
  | "agent_internal"
  | "built"
  | "done"
  | "published"
  | "orphan"
  | "local"
  | "needs_review"
  | "pending_rig_recovery"
  | "waiting_capacity"
  | "failed"
  | "aborted"
  | "blocked"
  | "dormant";

/**
 * Bridge v2's runs.jsonl status onto the closed {@link TerminalOutcome}
 * vocabulary. This is a write-side projection for new events/rows:
 *   - idle    → "idle_no_work"              : exit-0 no-op.
 *   - built   → "published_pending_merge"  : claimed, pending merge evidence.
 *   - done    → "delivered"                : confirmed merged / locally ff-merged.
 *   - published → "published_pending_merge": PR open, merge pending.
 *   - orphan  → "aborted_with_delivery"    : pushed for audit but not delivered.
 *   - local   → "unpublished"   : FIX-351 — gates passed, work committed locally,
 *               publish could not complete (no orphan push). A neutral terminal.
 *   - failed  → "failed".
 *   - aborted → "aborted_no_delivery".
 *   - blocked → "blocked"   : hard-timeout breach.
 */
export function mapV2Status(status: V2CycleStatus): TerminalOutcome {
  switch (status) {
    case "done":
      return "delivered";
    case "published":
    case "built":
      return "published_pending_merge";
    case "idle":
      return "idle_no_work";
    case "gave_up":
      // Hook 1: an agent EXECUTED but produced nothing — a failed-class terminal,
      // NOT a silent idle. Distinct outcome so the dashboard/ledger and the
      // dead-loop breaker can tell a give-up from a genuine no-op.
      return "gave_up";
    case "handoff_without_tcr":
      // FIX-1039: builder produced uncommitted work in the worktree but never
      // TCR-committed it — a recoverable handoff contract gap. The worktree is
      // PRESERVED. This is a failed-class outcome (no delivery), but distinct
      // from gave_up (agent had nothing to show) and from idle (no agent ran).
      return "handoff_without_tcr";
    case "agent_internal":
      // REFACTOR-071: the terminal vocabulary no longer carries a dedicated
      // agent-internal outcome. The status stays diagnostic; failure attribution
      // (harness:agent_internal) carries the reason.
      return "gave_up";
    case "dormant":
      // US-LOOP-079d — 连续 N idle 后自卸;终态,此后无 idle 行.
      return "dormant_entered";
    case "orphan":
      return "aborted_with_delivery";
    case "local":
      // FIX-351: gates passed + work committed locally, but the publish could not
      // complete (push / PR-create failed before any orphan branch was pushed).
      // A NEUTRAL non-failure terminal — the dashboard renders it as "ran
      // locally, not published", never red.
      return "unpublished";
    case "needs_review":
      // FIX-908: real work (≥1 commit + ≥1 tcr:) committed and code-stage peer
      // agreed, but a REQUIRED acceptance artifact is missing at the terminal (no
      // independent peer Review Score / empty-shell report). The gate honestly
      // blocked Done; the branch is preserved. NOT a `failed` (no code defect) —
      // a distinct "awaits review" terminal so the completed work is not orphaned.
      return "needs_review";
    case "pending_rig_recovery":
      return "idle_no_work";
    case "waiting_capacity":
      return "waiting_capacity";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted_no_delivery";
    case "blocked":
      return "blocked";
  }
}

// ── Six-state classification from captured facts (mirrors bin/roll:9127-9356) ─

/** FIX-1051 — diagnostic bundle for an agent that exited cleanly but hit an
 *  internal tool error (e.g. agy GREP_SEARCH timeout → zero trajectory). */
export interface AgentInternalFailure {
  /** The classified failure class (e.g. `agy_grep_timeout`, `agy_zero_trajectory`). */
  class: string;
  /** One-line human-readable summary of the native failure. */
  summary: string;
  /** Absolute path to the native agent CLI log that contains the root cause. */
  nativeLogPath: string;
  /** Native conversation / session identifier when available. */
  conversationId?: string;
}

/** The cycle facts captured post-agent, before publish (bin/roll:9127-9157). */
export interface CapturedFacts {
  /** Worktree isolation succeeded (`_USE_WORKTREE=1`). */
  usedWorktree: boolean;
  /**
   * Hook 1 (productivity floor): did an agent actually EXECUTE this cycle? True
   * when the agent slot was non-empty AND its spend/duration was above a tiny
   * no-op epsilon (the executor reuses the `rowSpentZeroNoExecution` semantics).
   * Distinguishes a `gave_up` (agent ran, 0 output) from a genuine no-op idle.
   * Absent ⇒ treated as "executed" for back-compat with the v2 accept path
   * (capture is only reached after an agent spawn, so a captured cycle ran one).
   */
  agentExecuted?: boolean;
  /** Agent process exit code (0 = clean). bin/roll:9063 `_exit`. */
  agentExit: number;
  /** True when a hard attest or peer gate blocked the cycle — the agent
   *  produced work but it was withheld by policy, not by a code defect. */
  gateBlocked?: boolean;
  /**
   * FIX-908 — the cycle did REAL work (≥1 commit AND ≥1 tcr: commit) but is
   * missing a REQUIRED acceptance artifact at the terminal: the independent
   * fresh-session peer Review Score was NOT produced (runScorePairing status ≠
   * "scored"), or the acceptance report is an empty shell (no AC content / no
   * ac-map). The attest gate has already honestly blocked Done (no synthesized
   * artifact — `evaluateReviewScoreGate`/`readLatestStoryPeerScore` stay
   * fail-loud), so this is NOT a code defect. It marks a `gateBlocked` cycle for
   * the `needs_review` terminal (preserve the branch, record awaits-review)
   * INSTEAD of plain `failed` + an orphaned branch. The executor computes this
   * from the consumed `runScorePairing` result + the report content check; it is
   * NEVER set when the gate passed or when there is no real work. */
  needsReview?: boolean;
  /** Watchdog fired this cycle (`_CYCLE_TIMED_OUT=1`). bin/roll:9074. */
  timedOut: boolean;
  /** Commits ahead of origin/main in the worktree (bin/roll:9139). */
  commitsAhead: number;
  /** Workspace repository observations are real, but repository-scoped
   * verification/publish is intentionally deferred to US-WS-012. This explicit
   * seam blocks before legacy single-repository gates can consume the aggregate. */
  repositoryVerificationPending?: boolean;
  /** Repository-scoped verification passed and typed publish plans exist, but
   * provider delivery is owned by the next Workspace delivery phase. */
  repositoryPublishPending?: boolean;
  /** FIX-252: commits on local main that are not on origin/main. */
  mainAhead?: number;
  /** FIX-1037: main checkout has uncommitted/untracked product-code dirt. */
  mainDirty?: boolean;
  /** FIX-1218: the actual dirty file list from checkMainDirty, for diagnostic
   *  inclusion in the boundary_violation event. Absent when mainDirty is false. */
  mainDirtyFiles?: string[];
  /** CWD where leaked main-checkout work was observed, when known. */
  attemptedCwd?: string;
  /** CWD the Builder was expected to mutate, when known. */
  expectedWorktreeCwd?: string;
  /**
   * FIX-1039: the cycle worktree has uncommitted/untracked files (dirty) at
   * capture time. When combined with commitsAhead === 0, this means the
   * builder produced code but never TCR-committed it — a handoff contract
   * gap rather than a "did nothing" gave_up. The worktree is PRESERVED so
   * the owner can recover the uncommitted work. Best-effort: absence means
   * the probe didn't run (defaulting to false in classifyCaptured).
   */
  worktreeDirty?: boolean;
  /** FIX-1051: agent-internal failure diagnostics. When present, the cycle is
   * classified as `agent_internal` (mapped to `agent_internal_failure`) instead
   * of a generic `gave_up`. */
  agentInternalFailure?: AgentInternalFailure;
  /** FIX-244: PR state for the cycle branch ("OPEN"/"MERGED"/...), probed by the
   *  capture step ONLY when the exit is non-zero with commits ahead — the
   *  phantom-failure check. Absent = not probed / no PR. */
  prState?: string;
}

/**
 * Classify the PRE-publish terminal status from captured facts, mirroring the
 * inline capture block (bin/roll:9127-9157):
 *   - timed out                       → blocked (the watchdog path owns teardown).
 *   - worktree-setup failed           → failed (bin/roll:9000-9007).
 *   - agent exit ≠ 0                  → failed (bin/roll:9132-9133).
 *   - exit 0, commitsAhead === 0 and local main not ahead:
 *       · worktree dirty (uncommitted files) but no TCR commit → handoff_without_tcr
 *         (FIX-1039: recoverable, the worktree is PRESERVED).
 *       · agent-internal failure detected in native CLI log → agent_internal
 *         (FIX-1051: e.g. agy GREP_SEARCH timeout → zero trajectory; surfaces
 *         the real cause instead of a generic gave_up).
 *       · an agent EXECUTED (Hook 1 productivity floor) → gave_up (failed-class,
 *         alerted on cycle 1 — an agent that burned tokens/time but produced
 *         nothing is NOT a silent idle).
 *       · no agent executed (genuine no_story/no-op $0) → idle (bin/roll:9180).
 *   - exit 0, commitsAhead > 0        → built (bin/roll:9141-9142; refined by the
 *                                       publish ladder to done/orphan/failed).
 * Returns the status BEFORE the publish ladder runs; {@link classifyPublish}
 * refines a `built` capture per the publish status.
 */
export function classifyCaptured(facts: CapturedFacts): V2CycleStatus {
  if (facts.timedOut) return "blocked";
  if (!facts.usedWorktree) return "failed";
  if (facts.repositoryVerificationPending === true) return "blocked";
  if (facts.repositoryPublishPending === true) return "blocked";
  // FIX-1037: main checkout pollution is a sandbox/runner boundary breach. It
  // must fail before any "agent did real work" or "existing PR" branch can
  // publish, otherwise an escaped builder can both dirty main and still ship.
  if (facts.mainDirty === true) return "failed";
  // A committed prefix plus uncommitted work is an incomplete handoff, not a
  // publishable delivery. Preserve the worktree before any publish-ladder path.
  if (facts.worktreeDirty === true) return "handoff_without_tcr";
  // Gate-blocked cycles (attest/peer policy rejection) are always failures —
  // the agent's work was withheld by policy, not by a code defect. They MUST
  // NOT enter the publish ladder.
  if (facts.gateBlocked) {
    // FIX-244: gate-blocked work that is ALREADY out as a PR (observed
    // 2026-06-10: attest-blocked cycles whose PR merged minutes later) is not a
    // no-output failure — classify "published"; the merge-evidence backfill
    // (FIX-243) arbitrates the final credit.
    if (facts.commitsAhead > 0 && (facts.prState === "OPEN" || facts.prState === "MERGED"))
      return "published";
    // FIX-908: a gate-blocked cycle that did REAL work (≥1 commit, the executor
    // also requires ≥1 tcr: before setting `needsReview`) but is only missing a
    // REQUIRED acceptance artifact (no independent peer Review Score / empty-shell
    // report) is NOT a no-output failure — the work is sound and committed on the
    // branch. Classify `needs_review` (preserve the branch, awaits review) so the
    // completed work is not orphaned. The gate stays fail-loud (no Done, no
    // synthesized artifact); this only changes the TERMINAL CLASSIFICATION, never
    // the gate. Guarded on commitsAhead so a 0-commit block still falls to failed.
    if (facts.commitsAhead > 0 && facts.needsReview === true) return "needs_review";
    return "failed";
  }
  if (facts.agentExit !== 0) {
    // FIX-244: a non-zero exit with an already-existing PR (from a prior
    // cycle attempt) is "published", not failed.
    if (facts.commitsAhead > 0 && (facts.prState === "OPEN" || facts.prState === "MERGED"))
      return "published";
    // Agent exits non-zero BUT produced commits → it did real work (e.g. pi
    // often exits ≠0 after a successful build). Classify as "built" so the
    // publish ladder opens a PR; CI + peer review catch any real quality issues.
    if (facts.commitsAhead > 0) return "built";
    // Zero commits + non-zero exit = the agent crashed without producing
    // anything — a genuine failure.
    return "failed";
  }
  if (facts.commitsAhead === 0 && (facts.mainAhead ?? 0) > 0) return "failed";
  if (facts.commitsAhead === 0) {
    // FIX-1039: worktree has uncommitted/untracked changes but 0 commits
    // ahead — the builder produced code but never TCR-committed it. This is
    // a handoff contract gap, NOT a "did nothing" gave_up. The worktree is
    // PRESERVED so the owner can inspect or rescue the uncommitted work.
    // FIX-1051: agent exited cleanly but an internal tool error was detected in
    // the native CLI log (e.g. agy GREP_SEARCH timeout → zero trajectory).
    // Classify as agent_internal so the failure reason is surfaced instead of
    // collapsing into a generic gave_up.
    if (facts.agentInternalFailure !== undefined) return "agent_internal";
    // Hook 1 (productivity floor): split the commit-count-only idle. An agent
    // that EXECUTED but left 0 commits and no delivery gave_up (a failed-class
    // terminal); a cycle where no agent ran is a genuine idle no-op. `undefined`
    // ⇒ executed (back-compat: capture is only reached after an agent spawn).
    return facts.agentExecuted === false ? "idle" : "gave_up";
  }
  return "built";
}

/** A publish ladder outcome (refines a `built` capture). The three tiers mirror
 *  the cycle-end ladder branching (bin/roll:9239-9356). */
export interface PublishResult {
  /** `_publish_status`: 0 ok / 2 gh-missing / other PR-fail (bin/roll:9238). */
  status: number;
  /** Human merge required: PR may open, but no local merge-back may count done. */
  manualMerge?: boolean;
  /** FIX-909: the PR was opened as a draft awaits-review signal. */
  draft?: boolean;
  /** Did the gh-missing ff `_worktree_merge_back` succeed? (bin/roll:9272). */
  mergedBack?: boolean;
  /** Did the orphan branch+tag push succeed? (bin/roll:9303-9305 etc). */
  orphanPushed?: boolean;
  /** FIX-1214: branch pushed but transient GitHub API fault prevented PR open/merge. */
  degraded?: boolean;
  /** Machine-readable root-cause tag when {@link degraded} is true. */
  rootCauseKey?: string;
  /**
   * FIX-908 / FIX-1256: the publish was blocked by a runner gate (e.g. the
   * evidence gate) AFTER the cycle's code-stage gates passed. The work is
   * committed and CI-green; classify as `needs_review` so the branch is
   * preserved for review instead of being silently unpublished.
   */
  gateBlocked?: boolean;
}

/**
 * Refine a `built` capture through the publish ladder, mirroring bin/roll:9239-9356:
 *   - status 0                         → done   (PR published; reconciler advances merge).
 *   - status 2 + mergedBack            → done   (gh missing; ff merge_back, 9275).
 *   - status 2 + orphanPushed          → orphan (gh missing; orphan push, 9293).
 *   - status 2 + neither               → local  (FIX-351: gates passed, no publish).
 *   - status other + orphanPushed      → orphan (PR-fail; orphan push, 9331/9346).
 *   - status other + not pushed        → local  (FIX-351: gates passed, no publish).
 *
 * FIX-351 — the publish ladder is only ever reached from a `built` capture, i.e.
 * a cycle whose GATES ALREADY PASSED (exit 0, ≥1 commit, no attest/peer block).
 * If its publish cannot complete and no orphan branch was pushed, the WORK is
 * sound and locally committed — it just never left the machine. That is NOT a
 * gate failure; it is `local` (→ TerminalOutcome `unpublished`), rendered
 * neutrally. A genuine GATE failure is classified `failed` BEFORE this ladder
 * (classifyCaptured: timed-out/worktree-fail/agent-exit≠0/gave_up), so reusing
 * `local` here never masks a real failure. (Pre-FIX-351 these branches returned
 * `failed`, which painted sound gate-passed cycles red — FIX-313's case.)
 *
 * Only call on a `built` capture; idle/failed/blocked never reach the ladder.
 */
export function classifyPublish(pub: PublishResult): V2CycleStatus {
  if (pub.status === 0 && pub.manualMerge === true && pub.draft === true) return "needs_review";
  // FIX-908 / FIX-1256: a code-green cycle blocked ONLY by a runner gate
  // (e.g. missing acceptance evidence) is preserved for review, not discarded
  // as an unpublished neutral outcome.
  if (pub.gateBlocked === true) return "needs_review";
  // FIX-244: publish-ok means the PR is OPEN, merge pending — "published", not
  // "done" (done ≡ merged to main, I4). Backfill flips it on merge evidence.
  if (pub.status === 0) return "published";
  if (pub.status === 2) {
    // A manual-merge story must NEVER count a local ff merge-back as `done`
    // (done ≡ a human-confirmed merge). With manualMerge the merge-back is
    // ignored: the work is committed locally but unpublished → `local` (FIX-351,
    // formerly `failed`). An orphan push still pre-empts as `orphan` (audit branch).
    if (pub.manualMerge === true) {
      return pub.orphanPushed === true ? "orphan" : "local";
    }
    if (pub.mergedBack === true) return "done";
    if (pub.orphanPushed === true) return "orphan";
    // gh missing, no merge-back, no orphan push — work committed locally but
    // unpublished (FIX-351, formerly `failed`).
    return "local";
  }
  // PR-fail tier.
  if (pub.orphanPushed === true) return "orphan";
  return "local";
}

/** Map a captured terminal straight to the closed terminal outcome vocabulary. */
export function captureToSpecOutcome(status: V2CycleStatus): TerminalOutcome {
  return mapV2Status(status);
}

// ── FIX-1068 — Builder finalization gate (adapter-agnostic) ───────────────────

/** Build the adapter-agnostic finalization facts from captured cycle state. */
export function builderFinalizationFacts(
  ctx: Pick<CycleContext, "cycleId" | "storyId" | "agent" | "agentExitCode" | "tcrCount" | "prUrl" | "evidenceRunDir">,
  captured: CapturedFacts,
): BuilderFinalizationFacts {
  return {
    storyId: ctx.storyId ?? "",
    cycleId: ctx.cycleId,
    agent: ctx.agent ?? "",
    worktreePath: captured.expectedWorktreeCwd ?? `.roll/loop/worktrees/cycle-${ctx.cycleId}`,
    expectedProjectPath: captured.attemptedCwd ?? "",
    processExited: true,
    exitCode: captured.agentExit,
    commitsAhead: captured.commitsAhead,
    tcrCount: ctx.tcrCount ?? 0,
    worktreeDirty: captured.worktreeDirty === true,
    mainCheckoutDirty: captured.mainDirty === true,
    ...((captured.mainAhead ?? 0) > 0 ? { mainAhead: captured.mainAhead } : {}),
    prUrl: ctx.prUrl ?? null,
    attestReportPath: ctx.evidenceRunDir !== undefined ? `${ctx.evidenceRunDir}/latest/report.html` : null,
    recentActivity: false,
  };
}

// ── Hard timeout watchdog (B-group AC; mirrors bin/roll:8473 + 9044-9125) ─────

/** v2 hard cycle timeout in seconds (LOOP_CYCLE_TIMEOUT_SEC, bin/roll:8473). */
export const CYCLE_TIMEOUT_SEC = 2700;
/** SIGKILL grace after SIGTERM, seconds (bin/roll:9048 `sleep 5`). */
export const WATCHDOG_KILL_GRACE_SEC = 5;

/** The watchdog breach decision. `breached` drives the clean-teardown path. */
export type WatchdogVerdict =
  | { breached: false; remainingSec: number }
  | { breached: true; overshootSec: number };

/**
 * Pure breach decision for the cycle watchdog (bin/roll:9044 `sleep TIMEOUT`).
 * Given the elapsed seconds since `CYCLE_START` (bin/roll:8829) and the limit,
 * decide whether the hard timeout has tripped. No clock — `elapsedSec` is injected
 * (the adapter computes `now - CYCLE_START`). Breach iff `elapsed >= limit`
 * (the bash watchdog fires once the sleep completes, i.e. at the boundary).
 */
export function watchdogVerdict(
  elapsedSec: number,
  limitSec: number = CYCLE_TIMEOUT_SEC,
): WatchdogVerdict {
  if (elapsedSec >= limitSec) return { breached: true, overshootSec: elapsedSec - limitSec };
  return { breached: false, remainingSec: limitSec - elapsedSec };
}

/**
 * The clean-teardown command sequence on a hard-timeout breach, mirroring the
 * watchdog + EXIT-trap discipline (bin/roll:9044-9052, 8676-8687, 9120-9125):
 *   1. kill the agent process group (SIGTERM, then SIGKILL after the grace).
 *   2. MEASURE the preserved worktree's real `tcr:` count (FIX-1244 — a builder
 *      killed AFTER landing real commits must not read as zero-TCR; the terminal
 *      row + the loop's self-heal gate both consume this count).
 *   3. emit the TERMINAL cycle:end event with outcome `blocked` (I8 — a terminal
 *      event is ALWAYS written, even on the abort path; bin/roll:8679).
 *   4. write the runs.jsonl `failed` row (dashboard terminal record, bin/roll:8685).
 *   5. append the timeout ALERT (bin/roll:8686).
 *   6. release the inner lock (bin/roll:8770) — the worktree is PRESERVED for
 *      audit (NOT cleaned, bin/roll:9122), so no worktree-cleanup command.
 * The order is asserted in tests; lock release comes LAST so the terminal event +
 * runs row are durably written before the lock frees the slot.
 */
export function timeoutTeardownCommands(ctx: TerminalContext): CycleCommand[] {
  return [
    { kind: "kill_agent", graceSec: WATCHDOG_KILL_GRACE_SEC },
    { kind: "measure_worktree" },
    { kind: "emit_event", event: cycleEndEvent(ctx, "blocked") },
    { kind: "append_run", status: "blocked", outcome: "blocked", cycleId: ctx.cycleId },
    {
      kind: "append_alert",
      message: `cycle ${ctx.cycleId}: ${CYCLE_TIMEOUT_SEC}s timeout — agent killed; in-progress story marked Blocked`,
    },
    { kind: "release_lock" },
  ];
}

/**
 * FIX-1474 — the clean-teardown command sequence when the builder child was
 * detected DEAD/MISSING out-of-band (liveness probe; external SIGKILL / PTY
 * leader death / lost exit delivery). Same durable shape as the timeout
 * teardown (I8: kill → measure → terminal cycle:end → runs row → alert →
 * release lock LAST, worktree PRESERVED), but the terminal is the explicit
 * `aborted` status — this is NOT a timeout (`blocked`) and NOT a code failure
 * (`failed` after retries). The `cycle:agent_lost` event was already appended
 * by the probe at the detection moment.
 */
export function abortedTeardownCommands(ctx: TerminalContext): CycleCommand[] {
  return [
    { kind: "kill_agent", graceSec: WATCHDOG_KILL_GRACE_SEC },
    { kind: "measure_worktree" },
    { kind: "emit_event", event: cycleEndEvent(ctx, "aborted") },
    { kind: "append_run", status: "aborted", outcome: mapV2Status("aborted"), cycleId: ctx.cycleId },
    {
      kind: "append_alert",
      message: `cycle ${ctx.cycleId}: builder child process lost (killed out-of-band) — cycle aborted; worktree preserved`,
    },
    { kind: "release_lock" },
  ];
}

// ── FIX-907: per-cycle HARD timeout (wall-clock + no-progress) ───────────────
//
// The watchdog above ({@link watchdogVerdict}) is checked only BETWEEN steps of
// the driver loop. The agent spawn is a single blocking `await`, so while a
// builder HANGS (process alive, 0% CPU, no new commits/events) the driver is
// parked at that await and the watchdog never re-fires — a hung cycle holds the
// inflight lock forever, blocking the whole loop (实证: FIX-390's builder hung
// 46min after one TCR commit). FIX-907 races the spawn against this decision so
// a hung builder is killed and the lock freed without human intervention.
//
// THREE criteria, ANY trips:
//   (a) WALL — total cycle elapsed exceeds the hard ceiling (default 45min).
//   (b) NO-PROGRESS (true silence) — no NEW commit, dirty-state change, or
//       stdout/event for the idle window (default 15min). Keyed on the LAST
//       PROGRESS time, NOT on pure elapsed time: a slow `deepseek` call sits
//       at 0% CPU but keeps emitting stdout/events, which bumps
//       `lastProgressSec`, so it is NEVER mis-killed. Only a TRULY silent
//       hang trips no-progress.
//   (c) NO-STATE-CHANGE (FIX-1477) — no NEW commit AND no worktree dirty-state
//       change for the state window (default 25min), EVEN IF stdout flows.
//       Progress is redefined as GIT STATE CHANGE (agent-agnostic): stdout
//       activity feeds only the silence fuse (b), it no longer counts as
//       "working" — a thrashing agent (kimi打转白烧) is caught ~20min early,
//       while a stdout-buffering agent that keeps writing files (pi冤杀) is
//       saved by its dirty-state signature changes.

/** v3 per-cycle WALL-clock hard ceiling (seconds). Default 45min — a cycle that
 *  runs this long total is a runaway, killed regardless of recent progress.
 *  Aligned with the legacy {@link CYCLE_TIMEOUT_SEC} (2700s = 45min). */
export const CYCLE_WALL_TIMEOUT_SEC = 2700;
/** v3 per-cycle NO-PROGRESS idle window (seconds). Default 15min — if the
 *  builder produces no new commit AND no new stdout/event for this long, it is
 *  judged hung (the FIX-390 silent-hang shape) and killed. */
export const CYCLE_NO_PROGRESS_SEC = 900;
/** FIX-1477 — per-cycle NO-STATE-CHANGE window (seconds). Default 25min — if
 *  the cycle worktree's GIT STATE (new commit OR dirty-state signature change)
 *  has not changed for this long, the builder is judged stuck and killed EVEN
 *  IF stdout is still flowing (the kimi-thrash shape: tokens burning, zero git
 *  progress). stdout activity does NOT reset this clock — only git state does.
 *  Rationale (owner-approved): a real full test run takes minutes; 25min with
 *  zero git state change is genuinely stuck. */
export const CYCLE_NO_STATE_CHANGE_SEC = 1500;

/** FIX-929 — agent stall detection threshold (seconds). Default 10min (600s) —
 *  a softer signal that fires BEFORE the hard timeout kill. Does NOT kill the
 *  agent; emits `agent:stall` so the recovery layer (FIX-930) can switch agents. */
export const CYCLE_STALL_THRESHOLD_SEC = 600;
/** FIX-929 — startup grace period (seconds). No stall detection fires during the
 *  first 2 minutes of an agent session to avoid误杀 during normal init. */
export const STALL_STARTUP_GRACE_SEC = 120;

/** The per-cycle hard-timeout verdict. `timedOut:false` carries the tighter of
 *  the enabled budgets so the poller can schedule its next wake. */
export type CycleTimeoutVerdict =
  | { timedOut: false; remainingSec: number }
  | { timedOut: true; reason: "wall" | "no-progress" | "no-state-change"; elapsedSec: number; idleSec: number };

/** Inputs for {@link cycleTimeoutVerdict} — all clocks injected (pure). */
export interface CycleTimeoutInput {
  /** Seconds since the agent spawn started (now - spawnStart). */
  elapsedSec: number;
  /** Seconds since the LAST observed progress (new commit, dirty-state change,
   *  or stdout/event): now - lastProgressSec. Reset to 0 whenever any liveness
   *  signal is seen, so a slow but still-emitting call (deepseek) — or a
   *  stdout-buffering agent that keeps changing the worktree (pi, FIX-1477) —
   *  never accrues idle time. This is the TRUE-SILENCE fuse. */
  idleSec: number;
  /** FIX-1477 — seconds since the last GIT STATE change (new commit OR
   *  worktree dirty-state signature change): now - lastStateSec. stdout does
   *  NOT reset this clock. Omitted ⇒ the no-state-change criterion is skipped
   *  (legacy callers byte-identical). */
  stateIdleSec?: number;
  /** WALL ceiling (default {@link CYCLE_WALL_TIMEOUT_SEC}). */
  wallLimitSec?: number;
  /** NO-PROGRESS idle window (default {@link CYCLE_NO_PROGRESS_SEC}). */
  noProgressLimitSec?: number;
  /** FIX-1477 — NO-STATE-CHANGE window (default
   *  {@link CYCLE_NO_STATE_CHANGE_SEC}). Only consulted when `stateIdleSec` is
   *  supplied. */
  noStateChangeLimitSec?: number;
}

/**
 * Pure per-cycle hard-timeout decision (FIX-907; the no-state-change criterion
 * is FIX-1477). WALL is checked FIRST so a runaway that also happens to be idle
 * is attributed to the wall ceiling; NO-PROGRESS (true silence) is checked
 * before NO-STATE-CHANGE so a fully hung agent keeps its historical
 * `no-progress` attribution. A non-positive limit DISABLES that criterion (an
 * operator escape hatch); if all are disabled the cycle never times out by this
 * gate. Boundary `>=` (the limit itself is a breach, mirroring
 * {@link watchdogVerdict}).
 */
export function cycleTimeoutVerdict(input: CycleTimeoutInput): CycleTimeoutVerdict {
  const wall = input.wallLimitSec ?? CYCLE_WALL_TIMEOUT_SEC;
  const idle = input.noProgressLimitSec ?? CYCLE_NO_PROGRESS_SEC;
  const stateIdle = input.noStateChangeLimitSec ?? CYCLE_NO_STATE_CHANGE_SEC;
  if (wall > 0 && input.elapsedSec >= wall) {
    return { timedOut: true, reason: "wall", elapsedSec: input.elapsedSec, idleSec: input.idleSec };
  }
  if (idle > 0 && input.idleSec >= idle) {
    return { timedOut: true, reason: "no-progress", elapsedSec: input.elapsedSec, idleSec: input.idleSec };
  }
  if (input.stateIdleSec !== undefined && stateIdle > 0 && input.stateIdleSec >= stateIdle) {
    return { timedOut: true, reason: "no-state-change", elapsedSec: input.elapsedSec, idleSec: input.idleSec };
  }
  // Remaining = the tighter of the enabled budgets.
  const wallRemain = wall > 0 ? wall - input.elapsedSec : Number.POSITIVE_INFINITY;
  const idleRemain = idle > 0 ? idle - input.idleSec : Number.POSITIVE_INFINITY;
  const stateRemain =
    input.stateIdleSec !== undefined && stateIdle > 0 ? stateIdle - input.stateIdleSec : Number.POSITIVE_INFINITY;
  return { timedOut: false, remainingSec: Math.min(wallRemain, idleRemain, stateRemain) };
}

/** FIX-929 stall-detection inputs — all clocks injected (pure). */
export interface StallInput {
  /** Seconds since the agent spawn started (now - spawnStart). */
  elapsedSec: number;
  /** Seconds since the LAST observed stdout/progress event: now - lastProgressSec. */
  idleSec: number;
  /** Stall threshold (default {@link CYCLE_STALL_THRESHOLD_SEC}). */
  stallThresholdSec?: number;
  /** Startup grace period (default {@link STALL_STARTUP_GRACE_SEC}). */
  startupGraceSec?: number;
  /** Whether the stall has already fired (prevent repeated events). */
  alreadyFired?: boolean;
}

export type StallVerdict =
  | { stalled: false }
  | { stalled: true; idleSec: number; thresholdSec: number };

/**
 * Pure stall-detection decision (FIX-929). Returns `stalled: true` when the
 * agent has been idle (no token output) for ≥ `stallThresholdSec` AND the
 * startup grace period has elapsed AND a stall has not already been signaled.
 *
 * A zero/negative threshold DISABLES stall detection. The startup grace exempts
 * the first N seconds to avoid false positives during normal agent initialization.
 * The stall fires at most ONCE per cycle (alreadyFired gate).
 */
export function stallVerdict(input: StallInput): StallVerdict {
  const threshold = input.stallThresholdSec ?? CYCLE_STALL_THRESHOLD_SEC;
  const grace = input.startupGraceSec ?? STALL_STARTUP_GRACE_SEC;
  if (threshold <= 0) return { stalled: false };
  if (input.alreadyFired) return { stalled: false };
  if (input.elapsedSec < grace) return { stalled: false };
  if (input.idleSec < threshold) return { stalled: false };
  return { stalled: true, idleSec: input.idleSec, thresholdSec: threshold };
}

// ── Transient retry / backoff (B-group AC, I6; mirrors bin/roll:9032-9072) ────

/** v2 in-cycle agent-spawn retry budget (`for _attempt in 1 2 3`, bin/roll:9032). */
export const MAX_AGENT_ATTEMPTS = 3;
/** v2 flat retry sleep, seconds (bin/roll:9070 `sleep 30`). Used as the backoff
 *  BASE; v3 layers exponential growth on top (documented NEW). */
export const RETRY_BASE_BACKOFF_SEC = 30;

/** The retry decision after an agent attempt. */
export type RetryPlan =
  | { action: "accept" } // exit 0 — break the loop (bin/roll:9067).
  | { action: "abort_timeout" } // watchdog fired — break, no retry (bin/roll:9066).
  | { action: "retry"; nextAttempt: number; backoffSec: number } // bin/roll:9068-9070.
  | { action: "exhausted" }; // budget spent → fall through to `failed` (I6).

/** Inputs for {@link retryPlan}: the just-finished attempt + its result. */
export interface RetryInput {
  /** 1-based attempt number that just ran (1..{@link MAX_AGENT_ATTEMPTS}). */
  attempt: number;
  /** Agent exit code (0 = success). */
  exit: number;
  /** Watchdog fired during this attempt (`_CYCLE_TIMED_OUT`). */
  timedOut: boolean;
  /** Max attempts (default {@link MAX_AGENT_ATTEMPTS}). */
  maxAttempts?: number;
  /** Backoff base seconds (default {@link RETRY_BASE_BACKOFF_SEC}). */
  baseBackoffSec?: number;
}

/**
 * Decide the next retry action, mirroring the loop body (bin/roll:9064-9072):
 *   - timedOut         → abort_timeout (break; the timeout path owns teardown).
 *   - exit 0           → accept (break).
 *   - exit ≠ 0, attempt < max → retry at attempt+1 after a backoff sleep.
 *   - exit ≠ 0, attempt == max → exhausted (fall through to `failed`, I6 — NEVER
 *     swap agents; agent fallback is pre-spawn only, router.ts resolveFallback).
 *
 * Backoff (NEW v3, AC+ "退避"): v2 sleeps a FLAT 30s every retry; v3 keeps 30s as
 * the base and grows it EXPONENTIALLY: `base * 2^(attempt-1)` (30s, 60s, …). The
 * schedule is pure (no real sleep); the adapter sleeps `backoffSec`.
 */
export function retryPlan(input: RetryInput): RetryPlan {
  const max = input.maxAttempts ?? MAX_AGENT_ATTEMPTS;
  const base = input.baseBackoffSec ?? RETRY_BASE_BACKOFF_SEC;
  if (input.timedOut) return { action: "abort_timeout" };
  if (input.exit === 0) return { action: "accept" };
  if (input.attempt < max) {
    const backoffSec = base * 2 ** (input.attempt - 1);
    return { action: "retry", nextAttempt: input.attempt + 1, backoffSec };
  }
  return { action: "exhausted" };
}

/** The full backoff schedule for a fresh agent run (NEW v3), useful for callers
 *  pre-computing sleeps and for tests. Length is `maxAttempts - 1` (no sleep after
 *  the final attempt). e.g. default → [30, 60]. */
export function backoffSchedule(
  maxAttempts: number = MAX_AGENT_ATTEMPTS,
  baseBackoffSec: number = RETRY_BASE_BACKOFF_SEC,
): number[] {
  const out: number[] = [];
  for (let a = 1; a < maxAttempts; a++) out.push(baseBackoffSec * 2 ** (a - 1));
  return out;
}

// ── Adversarial-pairing subsequence (US-LOOP-102) ─────────────────────────────

/** The three adversarial-pairing roles (US-LOOP-101). `attacker` is the
 *  test_author role's second-and-later spawn (fresh session, breaking tests). */
export type AdversarialRoleName = "test_author" | "implementer" | "attacker";

/** The resolved adversarial plan the executor hands the orchestrator on
 *  `route_resolved` when the profile is verified/designed AND a heterogeneous
 *  implementer ≠ test_author pair is available. Absent ⇒ standard single-builder
 *  (zero behaviour change). The orchestrator NEVER resolves rigs itself; it only
 *  sequences the plan the executor already resolved. Independence fail-closed and
 *  the full set of degrade paths (§7) are US-LOOP-103. */
export interface AdversarialPlan {
  testAuthor: AgentId;
  implementer: AgentId;
  testAuthorModel?: ModelId;
  implementerModel?: ModelId;
  maxRounds: number;
  dryRoundsToStop: number;
  totalTimeoutSec: number;
}

/** The running adversarial subsequence state (execute phase). Purely a record of
 *  where the state machine is in test_author → implementer → attack-round loop;
 *  the termination decision is delegated to the pure {@link adversarialNextStep}
 *  (US-LOOP-100), so "never hangs" is a single-function guarantee. */
export interface AdversarialRuntime {
  plan: AdversarialPlan;
  /** attacker rounds started so far (0 before the first attacker). */
  round: number;
  /** consecutive attacker rounds with no new hole. */
  dryStreak: number;
  /** cumulative holes the attacker broke open. */
  holesFound: number;
  /** breaking test files the attacker added → Phase 6 Agent-4 audit input. */
  attackTests: string[];
  /** the role whose spawn is currently in flight (awaiting role_exited). */
  inFlight: AdversarialRoleName;
  /** true once the INITIAL implementer emitted adversarial:implemented, so a
   *  later fix-round implementer does not re-emit it. */
  implementedInitial: boolean;
}

export type PendingSpawnProcess =
  | { readonly kind: "agent"; readonly agent: AgentId; readonly attempt: number }
  | {
      readonly kind: "role";
      readonly role: AdversarialRoleName;
      readonly agent: AgentId;
      readonly round: number;
    };

export interface PendingCapacitySpawn {
  readonly spawnId: string;
  readonly key: AgentCapacityKey;
  readonly process: PendingSpawnProcess;
}

// ── Cycle commands (the language the stepper emits) ───────────────────────────

/**
 * One command the orchestrator asks the executor (adapter) to perform. Each
 * names an existing port/plan so dispatch is 1:1; the orchestrator never runs
 * any of these itself. `*_run` commands feed their result back as a {@link
 * CycleEvent} on the next step.
 */
export type CycleCommand =
  | { kind: "preflight" } // recovery.ts preflightPlan + orphan recovery.
  | { kind: "create_worktree"; branch: string } // infra/git _worktree_create.
  | { kind: "pick_story" } // backlog/picker pickStory.
  | { kind: "resume_worktree"; storyId: string } // RESUME-PRIOR-WORK re-point (post-pick).
  | { kind: "resolve_route"; storyId: string } // agent/router resolveRoute+Fallback.
  | { kind: "acquire_capacity"; pending: PendingCapacitySpawn }
  | { kind: "spawn_agent"; agent: AgentId; attempt: number } // execute (TCR inside).
  | { kind: "spawn_role"; role: AdversarialRoleName; agent: AgentId; round: number } // US-LOOP-102 adversarial execute (verified/designed).
  | { kind: "release_capacity"; leaseId: string; ownerToken: string }
  | { kind: "kill_agent"; graceSec: number } // watchdog teardown.
  | { kind: "sleep_backoff"; seconds: number } // retry backoff (adapter sleeps).
  | { kind: "capture_facts" } // git rev-list/log count (bin/roll:9127-9157).
  | { kind: "measure_worktree" } // FIX-1244: lightweight tcr-count probe on the PRESERVED worktree (timeout teardown only — no gates).
  | { kind: "publish_pr"; branch: string; docOnly: boolean; manualMerge?: boolean; draft?: boolean } // delivery/pr planPublishPr.
  | { kind: "merge_back"; branch: string } // _worktree_merge_back (gh-missing tier).
  | { kind: "push_orphan"; branch: string } // FIX-039 orphan branch+tag.
  | { kind: "rescue_leaked"; cycleId: string } // FIX-903: save leaked main commits to rescue ref.
  | { kind: "wait_merge"; branch: string; elapsedSec: number } // delivery/pr nextWaitAction.
  | { kind: "reconcile" } // reconcile/engine reconcileMergeEvidence.
  | { kind: "cleanup_environment"; terminalStatus?: V2CycleStatus } // US-LOOP-088: post-cycle env cleanup before worktree removal.
  | { kind: "cleanup_worktree"; branch: string; bundleUnpushed?: boolean } // _worktree_cleanup. US-LOOP-095: bundleUnpushed=false when work is already on the remote (published/orphan) to skip the quarantine-bundle safety net.
  | { kind: "emit_event"; event: RollEvent } // events/bus appendEvent (I8).
  | { kind: "append_run"; status: V2CycleStatus; outcome: TerminalOutcome; cycleId: string; failure_class?: FailureClass; root_cause_key?: string } // events/bus upsertRun.
  | { kind: "append_alert"; message: string } // _worktree_alert.
  | { kind: "release_lock" }; // infra/process releaseLock.

// ── Cycle state + events (the state-machine carrier) ──────────────────────────

/** Per-cycle constants the stepper threads into emitted events/commands. */
export interface CycleContext {
  cycleId: string;
  branch: string;
  loop: string;
  storyId?: string;
  agent?: AgentId;
  model?: ModelId;
  /** The last agent process exit code (set when agent_exited is accepted,
   *  so the executor can read it back in capture_facts). */
  agentExitCode?: number;
  /** True iff the last agent_exited event carried timedOut:true. Used by
   *  failure-attribution to distinguish zero-output vendor stalls from genuine
   *  card failures (FIX-1213). */
  agentTimedOut?: boolean;
  /** Cycle start (epoch seconds) — set by the driver; used by the attest gate
   *  (FIX-207) to decide whether an acceptance report was produced THIS cycle. */
  startSec?: number;
  /** FIX-208: real `tcr:` commit count, captured by the executor while the
   *  worktree is alive (capture_facts — or measure_worktree on the timeout
   *  teardown, FIX-1244). Threaded into the runs row so the 可回溯链 stops
   *  reporting a hardcoded 0. Absent ⇒ not yet captured ⇒ UNKNOWN (the
   *  zero-TCR gate must treat unknown conservatively, never as 0). */
  tcrCount?: number;
  /** FIX-343 (step ①): the BUILDER's unique session id, minted ONCE at the
   *  working-agent spawn (`<cycleId>:build:<agent>:<clock>`) and reused across
   *  retries. The attest gate compares the SCORER's session id against this so
   *  "an independent fresh session (not a sub-agent sharing the builder's
   *  context) scored this delivery" is a CHECKED invariant, not asserted. Absent
   *  ⇒ the builder has not spawned yet (the gate then treats every score as a
   *  potential self-grade and demands a session-id present + distinct). */
  builderSessionId?: string;
  /** US-V4-004: the Story execution profile selected at route-resolve (standard |
   *  verified | planned). Recorded in a durable `execution:profile` event; in
   *  v4.0 only `standard` (builder-only) actually executes — verified/planned add
   *  evaluator/planner stages in later stories. Absent ⇒ not yet selected. */
  selectedProfile?: ExecutionProfile;
  /** FIX-208: the real per-cycle cost folded from the agent's parsed usage
   *  (cost/tracker.ts), set by the executor after spawn_agent. Threaded into
   *  BOTH the cycle:end event and the runs row so they agree. Absent ⇒ no
   *  usage parsed (the cycle:end falls back to the zero-cost placeholder). */
  cost?: CycleCost;
  /** US-EVID-001: per-cycle acceptance evidence frame opened before agent spawn. */
  evidenceRunDir?: string;
  /** US-TRUTH-001: the cycle's published PR url, patched by the publish_pr
   *  executor — feeds the terminal event's pr fact. Absent ⇒ no publish. */
  prUrl?: string;
  /** The publish executor confirmed that this cycle's branch reached a PR.
   *  Kept separately from prUrl because adoption of an agent-opened PR can
   *  prove the branch state without returning a URL. */
  publishConfirmed?: boolean;
  /** FIX-304: the story's backlog status captured at pick time, BEFORE this
   *  cycle flipped it to 🔨 In Progress. The terminal uses it to UNDO a
   *  PREMATURE ✅ Done the agent wrote (via the symlinked .roll backlog) when
   *  the cycle did NOT merge — done ≡ merged. Absent ⇒ status unread at pick
   *  (no revert target; the terminal leaves the row untouched). */
  preCycleStatus?: string;
  /** FIX-1037: runner observed dirty main checkout before/after builder spawn. */
  mainDirty?: boolean;
  /** FIX-1050: agent-specific reason why usage could not be parsed (e.g.
   *  `agy_stdout_no_usage`). Recorded on the runs row so debug/detail output can
   *  distinguish parser failure from genuinely missing agent usage output. */
  usageUnknownReason?: string;
  /** FIX-1051: agent-internal failure diagnostics. Carried from the executor's
   *  native-log probe into capture_facts so classifyCaptured can surface the
   *  real cause instead of a generic gave_up. */
  agentInternalFailure?: AgentInternalFailure;
  failureClass?: FailureClass;
  rootCauseKey?: string;
  /** US-LOOP-104: the adversarial-pairing outcome summary (rounds/holes/reason/
   *  degraded), folded from this cycle's adversarial:* events by the driver at
   *  terminal and stamped onto the runs row (`adversarial`). Absent ⇒ a standard
   *  (non-adversarial) cycle — the row omits the field. */
  adversarialRun?: AdversarialRunSummary;
  /** FIX-1268: the cycle produced no_story because the screen was locked and
   *  every remaining Todo card requires a physical surface. The driver uses this
   *  to skip the idle counter / dormancy bootout while waiting for unlock. */
  screenLocked?: boolean;
  /** E2 (submodule-aware delivery): the picked story's target submodule — its
   *  declared path in the superproject's `.gitmodules` (e.g.
   *  `dukang-service-online`). Set at pick_story from the backlog tag
   *  (`target-submodule:`) OR spec frontmatter (`target_submodule:`). When
   *  present, the cycle worktree is created INSIDE that submodule and the
   *  local-delivery landing targets the submodule's local integration branch —
   *  so the user's real submodule checkout sees the branch advance. Absent ⇒ the
   *  cycle runs entirely against the superproject (the existing path, unchanged). */
  targetSubmodule?: string;
  /** US-WS-010: the only repository carrier for Workspace execution. A
   * cardinality-one Workspace still has one map entry; no repoCwd/worktree
   * compatibility fields are mirrored onto CycleContext. */
  repositoryExecution?: CycleRepositoryExecutionContext;
}

export type RepositoryCommandOperation = "context" | "edit" | "test" | "tcr" | "publish";

export interface RepositoryScopedCommand extends RepositoryCycleIdentity {
  readonly operation: RepositoryCommandOperation;
}

export type RepositoryCommandPlan =
  | { readonly ok: true; readonly commands: readonly RepositoryScopedCommand[] }
  | {
      readonly ok: false;
      readonly code: "missing_repository_context" | "invalid_repository_map" | "unknown_repository";
      readonly repoId?: string;
    }
  | {
      readonly ok: false;
      readonly code: "read_only_repository";
      readonly repoId: string;
      readonly operation: RepositoryCommandOperation;
    };

export type RepositoryEventIdentityResult =
  | { readonly ok: true; readonly identity: RepositoryCycleIdentity }
  | {
      readonly ok: false;
      readonly code: "missing_repository_context" | "invalid_repository_map" | "unknown_repository";
      readonly repoId?: string;
    };

const REPOSITORY_MUTATIONS = new Set<RepositoryCommandOperation>(["edit", "tcr", "publish"]);
type RepositoryEntry = readonly [string, RepositoryExecutionContext];

function orderedRepositoryEntries(
  ctx: CycleContext,
):
  | { readonly ok: true; readonly entries: RepositoryEntry[] }
  | { readonly ok: false; readonly code: "missing_repository_context" | "invalid_repository_map" } {
  if (ctx.storyId === undefined || ctx.repositoryExecution === undefined) {
    return { ok: false, code: "missing_repository_context" };
  }
  const entries = Object.entries(ctx.repositoryExecution.repositories);
  if (entries.length === 0) return { ok: false, code: "invalid_repository_map" };
  const aliases = new Set<string>();
  for (const [key, repository] of entries) {
    if (key !== repository.repoId || aliases.has(repository.alias)) {
      return { ok: false, code: "invalid_repository_map" };
    }
    aliases.add(repository.alias);
  }
  entries.sort(([, left], [, right]) => left.repoId.localeCompare(right.repoId));
  return { ok: true, entries };
}

/** Pure repository command planner. It selects by stable repoId, never by cwd,
 * path basename or agent output; explicit read-only mutations fail loud. */
export function planRepositoryCommands(
  ctx: CycleContext,
  operation: RepositoryCommandOperation,
  repoIds?: readonly string[],
): RepositoryCommandPlan {
  const ordered = orderedRepositoryEntries(ctx);
  if (!ordered.ok) return ordered;
  const selected: RepositoryEntry[] = [];
  if (repoIds === undefined) {
    selected.push(...ordered.entries.filter(([, repository]) =>
      !REPOSITORY_MUTATIONS.has(operation) || repository.access === "write"));
  } else {
    for (const repoId of repoIds) {
      const found = ordered.entries.find(([key]) => key === repoId);
      if (found === undefined) return { ok: false, code: "unknown_repository", repoId };
      selected.push(found);
    }
  }
  for (const [, repository] of selected) {
    if (REPOSITORY_MUTATIONS.has(operation) && repository.access === "read") {
      return { ok: false, code: "read_only_repository", repoId: repository.repoId, operation };
    }
  }
  const execution = ctx.repositoryExecution;
  const storyId = ctx.storyId;
  if (execution === undefined || storyId === undefined) {
    return { ok: false, code: "missing_repository_context" };
  }
  return {
    ok: true,
    commands: selected.map(([, repository]) => ({
      operation,
      workspaceId: execution.workspaceId,
      storyId,
      cycleId: ctx.cycleId,
      repoId: repository.repoId,
    })),
  };
}

/** Build the mandatory identity envelope for a repository-specific event. */
export function repositoryEventIdentity(
  ctx: CycleContext,
  repoId: string,
): RepositoryEventIdentityResult {
  const plan = planRepositoryCommands(ctx, "context", [repoId]);
  if (!plan.ok) {
    if (plan.code === "read_only_repository") {
      return { ok: false, code: "invalid_repository_map", repoId };
    }
    return plan;
  }
  const command = plan.commands[0];
  if (command === undefined) return { ok: false, code: "unknown_repository", repoId };
  const { operation: _operation, ...identity } = command;
  return { ok: true, identity };
}

/** Minimal context for building a terminal cycle:end event + runs row. */
export interface TerminalContext {
  cycleId: string;
  branch: string;
  agent: AgentId;
  model: ModelId;
  toolCosts?: CycleCost["toolCosts"];
  failureClass?: FailureClass;
  rootCauseKey?: string;
}

/**
 * The cycle state: the current {@link CyclePhase} plus the running context and a
 * tiny bit of phase-local memory (attempt counter, captured facts) the stepper
 * needs to decide the next transition. `done === true` marks a terminal state.
 */
export interface CycleState {
  phase: CyclePhase;
  ctx: CycleContext;
  /** 1-based agent attempt in flight (execute phase). */
  attempt: number;
  /** True once the worktree was created (distinguishes the pre-worktree pick
   *  phase, which accepts `preflight_done`, from the in-worktree pick phase,
   *  which accepts `story_picked`/`no_story`). */
  worktreeReady?: boolean;
  /** US-LOOP-102: the adversarial subsequence runtime (execute phase). Present
   *  only for verified/designed cycles whose route_resolved carried a plan; a
   *  standard cycle leaves it undefined and follows the single-spawn path. */
  adversarial?: AdversarialRuntime;
  /** Process selected by routing but forbidden to start until capacity is acquired. */
  pendingSpawn?: PendingCapacitySpawn;
  /** Exact machine lease currently authorizing one running agent process. */
  activeCapacity?: AgentCapacityLease;
  /** Captured post-agent facts (set entering reconcile). */
  captured?: CapturedFacts;
  /** Terminal status once decided. */
  terminal?: V2CycleStatus;
  /** True when `phase === "cleanup"` and a terminal status is stamped. */
  done: boolean;
}

/**
 * The events the stepper consumes — the OBSERVED results of the commands it
 * previously emitted. The adapter performs a command and feeds the result back.
 */
export type CycleEvent =
  | { type: "start"; ctx: CycleContext } // begin the cycle (→ preflight).
  | { type: "preflight_done" }
  | { type: "worktree_created" }
  | { type: "worktree_failed" } // isolation failed → failed terminal (bin/roll:9000).
  | {
      type: "story_picked";
      storyId: string;
      repositoryExecution?: CycleRepositoryExecutionContext;
    }
  | { type: "repository_setup_failed"; storyId: string }
  | { type: "no_story" } // picker returned nothing → idle (bin/roll:9180-class).
  | { type: "route_resolved"; agent: AgentId; model: ModelId; adversarial?: AdversarialPlan; adversarialDegraded?: { cause: string; from?: "verified" | "designed" } }
  | { type: "route_pending"; reason: string }
  | { type: "capacity_acquired"; spawnId: string; lease: AgentCapacityLease }
  | {
      type: "waiting_capacity";
      spawnId: string;
      retryAtMs: number;
      contenders: readonly { readonly agent: AgentId; readonly cycleId: string }[];
      suspect: boolean;
    }
  | { type: "agent_exited"; exit: number; timedOut: boolean; lost?: boolean }
  // US-LOOP-102: an adversarial role spawn (test_author/implementer/attacker)
  // exited. `newHole`/`attackTest` are meaningful only for attacker rounds;
  // `elapsedSec` lets the pure termination check enforce the total timeout.
  | { type: "role_exited"; role: AdversarialRoleName; exit: number; timedOut: boolean; newHole?: boolean; attackTest?: string; elapsedSec?: number }
  | { type: "facts_captured"; facts: CapturedFacts }
  | { type: "published"; result: PublishResult }
  | { type: "merge_polled"; state: string; elapsedSec: number } // sync merge-wait.
  | { type: "reconciled" }
  | { type: "cleaned" };

/** The stepper result: the next state + the ordered commands to perform. */
export interface StepResult {
  state: CycleState;
  commands: CycleCommand[];
}

/**
 * The phase(s) each {@link CycleEvent} is valid IN — the resumability guard. An
 * event observed in any other phase is a no-op (stale/replayed adapter event). The
 * walk order: pick → worktree → pick → route → execute → reconcile → publish →
 * (merge-wait) → cleanup. `start` is omitted (it always applies — it resets).
 */
const EVENT_VALID_PHASES: Record<Exclude<CycleEvent["type"], "start">, CyclePhase[]> = {
  preflight_done: ["pick"],
  worktree_created: ["worktree"],
  worktree_failed: ["worktree"],
  story_picked: ["pick"],
  repository_setup_failed: ["pick"],
  no_story: ["pick"],
  route_resolved: ["route"],
  route_pending: ["route"],
  capacity_acquired: ["execute"],
  waiting_capacity: ["execute"],
  agent_exited: ["execute"],
  role_exited: ["execute"],
  facts_captured: ["reconcile"],
  published: ["publish"],
  merge_polled: ["merge-wait", "publish"],
  reconciled: ["reconcile"],
  cleaned: ["cleanup"],
};

/** Build a cycle:end RollEvent for a terminal status. */
export function cycleEndEvent(
  ctx: TerminalContext,
  status: V2CycleStatus,
  ts = 0,
  outcome: TerminalOutcome = mapV2Status(status),
): RollEvent {
  return {
    type: "cycle:end",
    cycleId: ctx.cycleId,
    outcome,
    cost: zeroCost(ctx),
    ...(ctx.failureClass !== undefined ? { failure_class: ctx.failureClass } : {}),
    ...(ctx.rootCauseKey !== undefined ? { root_cause_key: ctx.rootCauseKey } : {}),
    ts,
  };
}

/** A zero-cost placeholder (the cost ledger is folded by cost/tracker.ts). */
function zeroCost(ctx: TerminalContext): CycleCost {
  return {
    cycleId: ctx.cycleId,
    agent: ctx.agent,
    model: ctx.model,
    tokensIn: 0,
    tokensOut: 0,
    estimatedCost: 0,
    revertCount: 0,
    effectiveCost: 0,
    // FIX-361: currency from model's price config; falls back to USD for unknown/empty.
    currency: ctx.model !== "" ? cycleCurrency(ctx.model) : "USD",
    ...(ctx.toolCosts !== undefined ? { toolCosts: ctx.toolCosts } : {}),
  };
}

/** Terminal context from a cycle state (best-effort defaults for unrouted cycles). */
function terminalCtx(state: CycleState): TerminalContext {
  return {
    cycleId: state.ctx.cycleId,
    branch: state.ctx.branch,
    agent: state.ctx.agent ?? "",
    model: state.ctx.model ?? "",
    failureClass: state.ctx.failureClass,
    rootCauseKey: state.ctx.rootCauseKey,
  };
}

/** Move to a terminal cleanup state with the given status, emitting the terminal
 *  cycle:end + runs row + (when commits exist) the cleanup command. I8: a terminal
 *  event is ALWAYS emitted exactly once on the terminal transition. */
function terminate(
  state: CycleState,
  status: V2CycleStatus,
  extra: CycleCommand[] = [],
  outcome: TerminalOutcome = mapV2Status(status),
): StepResult {
  const tctx = terminalCtx(state);
  const extraWithStatus = extra.map((cmd) => cmd.kind === "cleanup_environment" ? { ...cmd, terminalStatus: status } : cmd);
  const cleanup = extraWithStatus.filter((cmd) => cmd.kind === "cleanup_environment" || cmd.kind === "cleanup_worktree");
  const beforeTerminal = extraWithStatus.filter((cmd) => cmd.kind !== "cleanup_environment" && cmd.kind !== "cleanup_worktree");
  const commands: CycleCommand[] = [
    ...beforeTerminal,
    { kind: "emit_event", event: cycleEndEvent(tctx, status, 0, outcome) },
    {
      kind: "append_run",
      status,
      outcome,
      cycleId: state.ctx.cycleId,
      ...(tctx.failureClass !== undefined ? { failure_class: tctx.failureClass } : {}),
      ...(tctx.rootCauseKey !== undefined ? { root_cause_key: tctx.rootCauseKey } : {}),
    },
    { kind: "release_lock" },
    ...cleanup,
  ];
  return {
    state: { ...state, phase: "cleanup", terminal: status, done: true },
    commands,
  };
}

function pendingSpawn(
  state: CycleState,
  process: PendingSpawnProcess,
  model: ModelId,
): PendingCapacitySpawn {
  const suffix = process.kind === "agent"
    ? `agent:${process.attempt}`
    : `role:${process.role}:${process.round}`;
  return {
    spawnId: `${state.ctx.cycleId}:${suffix}`,
    key: {
      agent: process.agent,
      model,
      contextKey: `${process.agent}:default`,
    },
    process,
  };
}

function acquirePending(
  state: CycleState,
  process: PendingSpawnProcess,
  model: ModelId,
  before: CycleCommand[] = [],
): StepResult {
  const pending = pendingSpawn(state, process, model);
  return {
    state: { ...state, pendingSpawn: pending, activeCapacity: undefined },
    commands: [...before, { kind: "acquire_capacity", pending }],
  };
}

function releaseActiveCapacity(state: CycleState): { state: CycleState; commands: CycleCommand[] } {
  const lease = state.activeCapacity;
  if (lease === undefined) return { state, commands: [] };
  return {
    state: { ...state, activeCapacity: undefined },
    commands: [{
      kind: "release_capacity",
      leaseId: lease.owner.leaseId,
      ownerToken: lease.owner.ownerToken,
    }, {
      kind: "emit_event",
      event: {
        type: "workspace:capacity_released",
        workspaceId: lease.owner.workspaceId,
        storyId: lease.owner.storyId,
        cycleId: lease.owner.cycleId,
        spawnId: lease.owner.spawnId,
        agent: lease.key.agent,
        model: lease.key.model,
        ts: 0,
      },
    }],
  };
}

function capacityEventMatches(state: CycleState, spawnId: string): boolean {
  return state.pendingSpawn !== undefined && state.pendingSpawn.spawnId === spawnId;
}

/**
 * The pure cycle stepper — `(state, event) → { state, commands }`. Walks the
 * {@link CyclePhase} ladder in the v2 order (pick→route→worktree→execute→publish→
 * merge-wait→reconcile→cleanup), but mirrors v2's ACTUAL sequencing where the
 * worktree is created BEFORE the pick (the pick runs inside the worktree,
 * bin/roll:8938): phase `worktree` covers create→pick→route; `execute` runs the
 * agent (with the retry budget threaded via {@link retryPlan} by the caller, who
 * re-emits `agent_exited` per attempt); `reconcile` classifies + (optionally)
 * folds merge evidence; `cleanup` is terminal.
 *
 * Unhandled (phase, event) pairs are a no-op (state unchanged, no commands) so a
 * late/duplicate event from the adapter can never corrupt the walk (I8 resumable):
 * each event declares the phase(s) it is valid IN ({@link EVENT_VALID_PHASES}); an
 * event observed while the cycle is in any other phase (or already terminal) is
 * dropped. This is what makes the machine resumable from a persisted event stream
 * — a stale/replayed event from a crashed adapter is inert.
 */
export function cycleStep(state: CycleState, event: CycleEvent): StepResult {
  // Resumability guard (I2/I8): drop events that don't apply to the current phase
  // (or arrive after the cycle is terminal). `start` always applies (it RESETS).
  if (event.type !== "start") {
    if (state.done) return { state, commands: [] };
    const valid = EVENT_VALID_PHASES[event.type];
    // An unknown event type (e.g. a now-removed transition like the retired
    // `budget_ok`/`budget_check` replayed from a pre-upgrade persisted stream)
    // has no phase entry — treat it as inert, exactly like a stale/out-of-phase
    // event, rather than crashing the resumable replay.
    if (valid === undefined || !valid.includes(state.phase)) return { state, commands: [] };
    // Disambiguate the two `pick`-phase events: `preflight_done` only PRE-worktree,
    // `story_picked`/`no_story` only POST-worktree (the pick runs inside it).
    if (event.type === "preflight_done" && state.worktreeReady === true) return { state, commands: [] };
    if ((event.type === "story_picked" || event.type === "repository_setup_failed" || event.type === "no_story") && state.worktreeReady !== true) {
      return { state, commands: [] };
    }
  }

  switch (event.type) {
    case "start":
      return {
        state: { ...state, phase: "pick", ctx: event.ctx, attempt: 0, worktreeReady: false, done: false },
        commands: [{ kind: "preflight" }],
      };

    case "preflight_done":
      return {
        state: { ...state, phase: "worktree" },
        commands: [{ kind: "create_worktree", branch: state.ctx.branch }],
      };

    case "worktree_created":
      // Worktree up → pick the next story INSIDE it (bin/roll:8938).
      // FIX-382: cycle:start moved to route_resolved so it carries real storyId+agent.
      return {
        state: { ...state, phase: "pick", worktreeReady: true },
        commands: [
          { kind: "pick_story" },
        ],
      };

    case "worktree_failed":
      // Setup failed before story pick / agent spawn. Cleanup is tolerant, so it
      // is safe for both git-worktree-add failure and post-create bootstrap
      // failure; no cycle:start was emitted, but a terminal runs row is written.
      return terminate({ ...state, phase: "worktree" }, "failed", [
        { kind: "cleanup_environment" }, { kind: "cleanup_worktree", branch: state.ctx.branch },
      ]);

    case "no_story":
      // Nothing pickable → idle terminal (clean no-op; worktree reclaimed).
      return terminate({ ...state, phase: "pick" }, "idle", [
        { kind: "cleanup_environment" }, { kind: "cleanup_worktree", branch: state.ctx.branch },
      ]);

    case "story_picked":
      // RESUME-PRIOR-WORK is decided HERE, not at create_worktree: the picker
      // reads the backlog INSIDE the worktree (FIX-198/FIX-204C), so the story id
      // is only known AFTER the worktree exists. The worktree was created on
      // origin/main (the fresh-context default); now that we have the picked
      // story, `resume_worktree` consults resolveResumeBase(storyId) and — only
      // when a resumable un-merged branch cleanly rebases — RE-POINTS the worktree
      // to it (fetch + reset --hard) so the agent resumes the prior product code.
      // It runs BEFORE resolve_route → spawn_agent (commands execute in order), so
      // the worktree carries the resume tree by the time the agent spawns. When no
      // resume branch exists it is a clean no-op (worktree stays on origin/main).
      return {
        state: {
          ...state,
          phase: "route",
          ctx: {
            ...state.ctx,
            storyId: event.storyId,
            ...(event.repositoryExecution === undefined
              ? {}
              : { repositoryExecution: event.repositoryExecution }),
          },
        },
        commands: [
          { kind: "resume_worktree", storyId: event.storyId },
          { kind: "resolve_route", storyId: event.storyId },
        ],
      };

    case "repository_setup_failed":
      return terminate({
        ...state,
        phase: "worktree",
        ctx: { ...state.ctx, storyId: event.storyId },
      }, "failed", [
        { kind: "cleanup_environment" },
        { kind: "cleanup_worktree", branch: state.ctx.branch },
      ]);

    case "route_resolved": {
      // The cost/budget gate is REMOVED — the loop no longer stops on a dollar
      // ceiling. Route resolves straight into the agent spawn (the progress
      // guardrails in loop-go now own runaway-spend protection).
      // FIX-382: cycle:start is emitted HERE (not worktree_created) so it carries
      // the now-resolved storyId (from story_picked) + agent/model (from this event).
      const execCtx = { ...state.ctx, agent: event.agent, model: event.model };
      const startCmd: CycleCommand = { kind: "emit_event", event: cycleStartEvent(execCtx) };
      // US-LOOP-102: verified/designed cycles whose executor resolved a
      // heterogeneous test_author≠implementer pair run the ADVERSARIAL
      // subsequence: test_author (write red tests) → implementer (make green) →
      // attack rounds. Standard cycles (no plan) fall through to the single
      // spawn_agent path below — ZERO behaviour change.
      if (event.adversarial !== undefined) {
        const plan = event.adversarial;
        const nextState: CycleState = {
            ...state,
            phase: "execute",
            attempt: 1,
            ctx: execCtx,
            adversarial: {
              plan,
              round: 0,
              dryStreak: 0,
              holesFound: 0,
              attackTests: [],
              inFlight: "test_author",
              implementedInitial: false,
            },
        };
        return acquirePending(
          nextState,
          { kind: "role", role: "test_author", agent: plan.testAuthor, round: 0 },
          plan.testAuthorModel ?? "",
          [startCmd],
        );
      }
      // US-LOOP-106: a verified/designed cycle whose executor could NOT form a
      // heterogeneous test_author≠implementer pair degrades to standard — but NOT
      // silently. Emit adversarial:degraded (cause supplied by the executor, e.g.
      // "non-hetero") before the single builder so the fallback is auditable.
      const degradeCmds: CycleCommand[] =
        event.adversarialDegraded !== undefined
          ? [adversarialDegradedCmd(execCtx.cycleId, execCtx.storyId ?? "", event.adversarialDegraded.cause, event.adversarialDegraded.from ?? "adversarial")]
          : [];
      const nextState: CycleState = {
          ...state,
          phase: "execute",
          attempt: 1,
          ctx: execCtx,
      };
      return acquirePending(
        nextState,
        { kind: "agent", agent: event.agent, attempt: 1 },
        event.model,
        [startCmd, ...degradeCmds],
      );
    }

    case "route_pending":
      return terminate({ ...state, phase: "route" }, "pending_rig_recovery", [
        { kind: "cleanup_environment" }, { kind: "cleanup_worktree", branch: state.ctx.branch },
      ]);

    case "capacity_acquired": {
      if (!capacityEventMatches(state, event.spawnId)) {
        return terminate(state, "failed", [{
          kind: "append_alert",
          message: `cycle ${state.ctx.cycleId}: capacity acquisition correlation mismatch`,
        }]);
      }
      const pending = state.pendingSpawn as PendingCapacitySpawn;
      const lease = event.lease;
      const exact = lease.owner.cycleId === state.ctx.cycleId &&
        lease.owner.spawnId === pending.spawnId &&
        lease.key.agent === pending.key.agent &&
        lease.key.model === pending.key.model &&
        lease.key.contextKey === pending.key.contextKey;
      if (!exact) {
        return terminate(state, "failed", [{
          kind: "append_alert",
          message: `cycle ${state.ctx.cycleId}: capacity lease ownership mismatch`,
        }]);
      }
      const process = pending.process;
      const command: CycleCommand = process.kind === "agent"
        ? { kind: "spawn_agent", agent: process.agent, attempt: process.attempt }
        : { kind: "spawn_role", role: process.role, agent: process.agent, round: process.round };
      const workspaceId = state.ctx.repositoryExecution?.workspaceId ?? "";
      return {
        state: { ...state, pendingSpawn: undefined, activeCapacity: lease },
        commands: [
          {
            kind: "emit_event",
            event: {
              type: "workspace:capacity_acquired",
              workspaceId,
              storyId: state.ctx.storyId ?? "",
              cycleId: state.ctx.cycleId,
              spawnId: pending.spawnId,
              agent: pending.key.agent,
              model: pending.key.model,
              ts: 0,
            },
          },
          command,
        ],
      };
    }

    case "waiting_capacity": {
      if (!capacityEventMatches(state, event.spawnId)) {
        return terminate(state, "failed", [{
          kind: "append_alert",
          message: `cycle ${state.ctx.cycleId}: capacity waiting correlation mismatch`,
        }]);
      }
      const pending = state.pendingSpawn as PendingCapacitySpawn;
      return terminate(
        { ...state, pendingSpawn: undefined },
        "waiting_capacity",
        [
          {
            kind: "emit_event",
            event: {
              type: "workspace:waiting_capacity",
              workspaceId: state.ctx.repositoryExecution?.workspaceId ?? "",
              storyId: state.ctx.storyId ?? "",
              cycleId: state.ctx.cycleId,
              spawnId: pending.spawnId,
              agent: pending.key.agent,
              model: pending.key.model,
              retryAt: event.retryAtMs,
              contenders: [...new Set(event.contenders.map((contender) => contender.agent))].sort(),
              suspect: event.suspect,
              ts: 0,
            },
          },
          { kind: "cleanup_environment" },
          { kind: "cleanup_worktree", branch: state.ctx.branch },
        ],
        "waiting_capacity",
      );
    }

    case "agent_exited": {
      if (state.activeCapacity === undefined) {
        return terminate(state, "failed", [{
          kind: "append_alert",
          message: `cycle ${state.ctx.cycleId}: agent exited without active capacity ownership`,
        }]);
      }
      const released = releaseActiveCapacity(state);
      // FIX-1474 — a LOST builder child (killed out-of-band; detected by the
      // runner's liveness probe, surfaced via cycle:agent_lost) converges to
      // the explicit `aborted` terminal: no retry (the death is environmental,
      // not a code failure) and NOT the timeout's `blocked`. Takes precedence
      // over the retry plan.
      if (event.lost === true) {
        return {
          state: { ...released.state, phase: "execute", terminal: "aborted", done: true, ctx: { ...state.ctx, agentExitCode: event.exit, agentTimedOut: event.timedOut } },
          commands: [...released.commands, ...abortedTeardownCommands(terminalCtx(state))],
        };
      }
      const plan = retryPlan({ attempt: state.attempt, exit: event.exit, timedOut: event.timedOut });
      if (plan.action === "abort_timeout") {
        // Watchdog breach → clean teardown (worktree PRESERVED, bin/roll:9122).
        return {
          state: { ...released.state, phase: "execute", terminal: "blocked", done: true, ctx: { ...state.ctx, agentExitCode: event.exit, agentTimedOut: event.timedOut } },
          commands: [...released.commands, ...timeoutTeardownCommands(terminalCtx(state))],
        };
      }
      if (plan.action === "retry") {
        const nextState = { ...released.state, phase: "execute" as const, attempt: plan.nextAttempt };
        return acquirePending(
          nextState,
          { kind: "agent", agent: state.ctx.agent ?? "", attempt: plan.nextAttempt },
          state.ctx.model ?? "",
          [...released.commands, { kind: "sleep_backoff", seconds: plan.backoffSec }],
        );
      }
      if (plan.action === "exhausted") {
        // Retry budget spent → failed (NEVER agent-swap, I6).
        return terminate({ ...released.state, phase: "execute", ctx: { ...state.ctx, agentExitCode: event.exit, agentTimedOut: event.timedOut } }, "failed", [...released.commands,
          { kind: "append_alert", message: `cycle ${state.ctx.cycleId}: agent exited ${event.exit} after retries; worktree preserved` },
        ]);
      }
      // accept → capture facts before publish. Store the exit code + timedOut
      // in ctx so the executor can read them back when building CapturedFacts
      // and failure-attribution can detect zero-output vendor stalls (FIX-1213).
      return {
        state: {
          ...released.state,
          phase: "reconcile",
          ctx: { ...state.ctx, agentExitCode: event.exit, agentTimedOut: event.timedOut },
        },
        commands: [...released.commands, { kind: "capture_facts" }],
      };
    }

    case "role_exited": {
      if (state.activeCapacity === undefined) {
        return terminate(state, "failed", [{
          kind: "append_alert",
          message: `cycle ${state.ctx.cycleId}: role exited without active capacity ownership`,
        }]);
      }
      const released = releaseActiveCapacity(state);
      // US-LOOP-102 — the adversarial subsequence stepper. Purely sequences the
      // roles; the DECISION to keep attacking / fix / stop is delegated to the
      // pure {@link adversarialNextStep} (US-LOOP-100), so "never hangs" is a
      // single audited function, not scattered here.
      const adv = state.adversarial;
      if (adv === undefined) {
        // A role event with no adversarial runtime is a stale/replayed adapter
        // event — ignore it (state unchanged, no command). The phase guard
        // already blocks it outside execute.
        return { state: released.state, commands: released.commands };
      }
      const cid = state.ctx.cycleId;
      const sid = state.ctx.storyId ?? "";
      // US-LOOP-106 — §7 degrade: a failed / timed-out role spawn NEVER just
      // silently stops. The failure kind is mapped through the pure
      // adversarialDegradeDecision (US-LOOP-103) — a timed-out round is a
      // `round_hang`, a non-zero exit is `agent_unavailable` — and the cycle
      // degrades to a STANDARD single builder that completes the card from the
      // current worktree (the test_author's tests + any partial implementation
      // are still on the branch). The fallback is recorded via adversarial:degraded
      // (never silent) and clears the adversarial runtime so role events stop.
      // "never deadlock": the standard spawn_agent then owns its own retry/
      // exhausted terminal — the adversarial machinery can never spin.
      if (event.exit !== 0 || event.timedOut) {
        const failure: AdversarialFailure = event.timedOut
          ? { kind: "round_hang", round: adv.round }
          : { kind: "agent_unavailable", role: adv.inFlight };
        const decision = adversarialDegradeDecision(failure);
        const routedAgent = state.ctx.agent ?? adv.plan.implementer;
        const nextState: CycleState = {
            ...released.state,
            phase: "execute",
            attempt: 1,
            adversarial: undefined,
            ctx: { ...state.ctx, agentExitCode: event.exit, agentTimedOut: event.timedOut },
        };
        return acquirePending(
          nextState,
          { kind: "agent", agent: routedAgent, attempt: 1 },
          state.ctx.model ?? "",
          [...released.commands,
            adversarialDegradedCmd(cid, sid, decision.cause),
          ],
        );
      }
      const cfg = {
        maxRounds: adv.plan.maxRounds,
        dryRoundsToStop: adv.plan.dryRoundsToStop,
        elapsedSec: event.elapsedSec ?? 0,
        totalTimeoutSec: adv.plan.totalTimeoutSec,
      };
      const terminatedCmd = (reason: "dry" | "max_rounds" | "timeout", rounds: number, holesFound: number): CycleCommand => ({
        kind: "emit_event",
        event: { type: "adversarial:terminated", cycleId: cid, storyId: sid, reason, rounds, holesFound, ts: 0 },
      });

      if (adv.inFlight === "test_author") {
        // Red tests written → hand to the (heterogeneous) implementer, round 0.
        const nextState = { ...released.state, adversarial: { ...adv, inFlight: "implementer" as const } };
        return acquirePending(
          nextState,
          { kind: "role", role: "implementer", agent: adv.plan.implementer, round: adv.round },
          adv.plan.implementerModel ?? state.ctx.model ?? "",
          [...released.commands,
            { kind: "emit_event", event: { type: "adversarial:test-authored", cycleId: cid, storyId: sid, agent: adv.plan.testAuthor, ts: 0 } },
          ],
        );
      }

      if (adv.inFlight === "implementer") {
        // Tests green (initial impl OR a fix). A just-green state always leads to
        // an attack unless a hard cap (max_rounds / total timeout) tripped.
        const step = adversarialNextStep({ round: adv.round, dryStreak: adv.dryStreak }, null, cfg);
        const cmds: CycleCommand[] = [];
        if (!adv.implementedInitial) {
          cmds.push({
            kind: "emit_event",
            event: { type: "adversarial:implemented", cycleId: cid, storyId: sid, agent: adv.plan.implementer, round: adv.round, ts: 0 },
          });
        }
        // stop — a hard cap tripped (max_rounds / total timeout) before any /
        // further attack. `fix` is impossible here (lastRound=null), so anything
        // not `stop` is an attack.
        if (step.kind === "stop") {
          cmds.push(terminatedCmd(step.reason, adv.round, adv.holesFound));
          cmds.push({ kind: "capture_facts" });
          return {
            state: { ...released.state, phase: "reconcile", adversarial: { ...adv, implementedInitial: true } },
            commands: [...released.commands, ...cmds],
          };
        }
        const nextRound = adv.round + 1;
        return acquirePending(
          { ...released.state, adversarial: { ...adv, round: nextRound, inFlight: "attacker", implementedInitial: true } },
          { kind: "role", role: "attacker", agent: adv.plan.testAuthor, round: nextRound },
          adv.plan.testAuthorModel ?? "",
          [...released.commands, ...cmds],
        );
      }

      // inFlight === "attacker": a breaking test was added. newHole ⇒ a real
      // untested failure mode surfaced (→ fix); otherwise a dry round.
      const newHole = event.newHole === true;
      const holesFound = newHole ? adv.holesFound + 1 : adv.holesFound;
      const attackTests =
        newHole && event.attackTest !== undefined && event.attackTest !== ""
          ? [...adv.attackTests, event.attackTest]
          : adv.attackTests;
      // The streak the attack-round event REPORTS: 0 on a hole, else the running
      // streak + this dry round (mirrors adversarialNextStep's effectiveDry).
      const reportedDryStreak = newHole ? 0 : adv.dryStreak + 1;
      const attackEvent: CycleCommand = {
        kind: "emit_event",
        event: { type: "adversarial:attack-round", cycleId: cid, storyId: sid, agent: adv.plan.testAuthor, round: adv.round, newHole, dryStreak: reportedDryStreak, ts: 0 },
      };
      const step = adversarialNextStep({ round: adv.round, dryStreak: adv.dryStreak }, { newHole }, cfg);
      if (step.kind === "fix") {
        return acquirePending(
          { ...released.state, adversarial: { ...adv, dryStreak: 0, holesFound, attackTests, inFlight: "implementer" } },
          { kind: "role", role: "implementer", agent: adv.plan.implementer, round: adv.round },
          adv.plan.implementerModel ?? state.ctx.model ?? "",
          [...released.commands, attackEvent],
        );
      }
      if (step.kind === "attack") {
        const nextRound = adv.round + 1;
        return acquirePending(
          { ...released.state, adversarial: { ...adv, round: nextRound, dryStreak: reportedDryStreak, holesFound, attackTests, inFlight: "attacker" } },
          { kind: "role", role: "attacker", agent: adv.plan.testAuthor, round: nextRound },
          adv.plan.testAuthorModel ?? "",
          [...released.commands, attackEvent],
        );
      }
      // stop (dry / max_rounds / timeout) — deliver the accumulated green state.
      return {
        state: { ...released.state, phase: "reconcile", adversarial: { ...adv, dryStreak: reportedDryStreak, holesFound, attackTests } },
        commands: [...released.commands, attackEvent, terminatedCmd(step.reason, adv.round, holesFound), { kind: "capture_facts" }],
      };
    }

    case "facts_captured": {
      const status = classifyCaptured(event.facts);
      const nextCtx: CycleContext = status === "agent_internal"
        ? {
            ...state.ctx,
            agentInternalFailure: event.facts.agentInternalFailure,
            failureClass: "harness",
            rootCauseKey: "harness:agent_internal",
          }
        : status === "published" && event.facts.commitsAhead > 0 &&
            (event.facts.prState === "OPEN" || event.facts.prState === "MERGED")
          ? { ...state.ctx, publishConfirmed: true }
          : state.ctx;
      const next = { ...state, phase: "reconcile" as CyclePhase, captured: event.facts, ctx: nextCtx };
      const bFacts = builderFinalizationFacts(state.ctx, event.facts);
      const verdict = finalizeBuilder(bFacts);
      const gateEvent = ((): CycleCommand => {
        if (verdict === "boundary_violation") {
          return {
            kind: "emit_event",
            event: {
              type: "builder:boundary_violation",
              cycleId: state.ctx.cycleId,
              storyId: state.ctx.storyId ?? "",
              agent: state.ctx.agent ?? "",
              kind: "main_checkout_dirty",
              // FIX-1218: include the actual dirty file list for diagnostics
              // instead of hardcoding []. Falls back to [] if not captured.
              files: event.facts.mainDirtyFiles ?? [],
              worktreePath: bFacts.worktreePath,
              attemptedCwd: bFacts.expectedProjectPath,
              expectedWorktreeCwd: bFacts.worktreePath,
              leakedCommits: bFacts.mainAhead ?? 0,
              ts: 0,
            },
          };
        }
        if (verdict === "handoff_without_tcr") {
          return {
            kind: "emit_event",
            event: {
              type: "builder:handoff_required",
              cycleId: state.ctx.cycleId,
              storyId: state.ctx.storyId ?? "",
              agent: state.ctx.agent ?? "",
              kind: handoffKindFor(verdict) ?? "unknown",
              worktreePath: bFacts.worktreePath,
              ts: 0,
            },
          };
        }
        return {
          kind: "emit_event",
          event: {
            type: "builder:finalized",
            cycleId: state.ctx.cycleId,
            storyId: state.ctx.storyId ?? "",
            agent: state.ctx.agent ?? "",
            verdict,
            facts: bFacts,
            ts: 0,
          },
        };
      })();
      if (status !== "built") {
        if (status === "needs_review") {
          return {
            state: { ...next, phase: "publish" },
            commands: [gateEvent, { kind: "publish_pr", branch: state.ctx.branch, docOnly: false, manualMerge: true, draft: true }],
          };
        }
        // idle → clean + terminal; failed/blocked → terminal (no publish).
        // idle: nothing to keep. published (FIX-244): branch + PR are on the
        // remote — keep the worktree too would strand it (FIX-247's lesson).
        // failed WITH commits (FIX-247 AC1): a gate-kill is not a discard —
        // push the branch so the work is reachable on the remote, and say so.
        // Ruling (AC2): the next cycle does NOT auto-reuse stranded work —
        // I12's fresh-context contract stands; rescue is a human decision on
        // an auditable branch.
        const extra: CycleCommand[] =
          status === "idle" || status === "published"
            // published: work is on the remote branch already → skip the bundle
            // (US-LOOP-095 AC3, no noise). idle: no commits, bundle is a no-op.
            ? [{ kind: "cleanup_environment" }, { kind: "cleanup_worktree", branch: state.ctx.branch, bundleUnpushed: status !== "published" }]
            : status === "gave_up"
              ? // Hook 1: an agent ran but produced nothing — clean the (empty)
                // worktree AND ALERT on the FIRST occurrence (no 2-hit streak).
                // failed-class, so the terminal runs revertPrematureDone.
                [
                  { kind: "cleanup_environment" }, { kind: "cleanup_worktree", branch: state.ctx.branch },
                  {
                    kind: "append_alert",
                    message: `cycle ${state.ctx.cycleId}: agent executed but produced 0 commits and no delivery — gave_up (productivity floor); story left re-pickable, spec truth reset`,
                  },
                ]
            : status === "agent_internal"
              ? // FIX-1051: agent exited cleanly but hit an internal tool error.
                // Clean the empty worktree and ALERT with the specific native-log
                // failure reason so the supervisor sees the real cause.
                [
                  { kind: "cleanup_environment" }, { kind: "cleanup_worktree", branch: state.ctx.branch },
                  {
                    kind: "append_alert",
                    message: (() => {
                      const diag = event.facts.agentInternalFailure;
                      const base = `cycle ${state.ctx.cycleId}: agent ${state.ctx.agent ?? "?"} exited 0 but internal tool failure detected — agent_internal`;
                      if (diag === undefined) return `${base}; see cycle log`;
                      return `${base}; class=${diag.class}; summary=${diag.summary}; nativeLog=${diag.nativeLogPath}${diag.conversationId !== undefined ? `; conversation=${diag.conversationId}` : ""}`;
                    })(),
                  },
                ]
            : status === "handoff_without_tcr"
              ? // FIX-1039: builder produced code but never TCR-committed it.
                // Preserve the worktree so the owner can inspect or rescue the
                // uncommitted work. NO cleanup_worktree — the worktree stays.
                [
                  {
                    kind: "append_alert",
                    message: `cycle ${state.ctx.cycleId}: builder exited exit 0 with uncommitted changes in worktree but 0 TCR commits — handoff_without_tcr; worktree preserved at branch ${state.ctx.branch} for recovery`,
                  },
                ]
            : status === "failed" && (event.facts.mainAhead ?? 0) > 0
              ? [
                  { kind: "rescue_leaked", cycleId: state.ctx.cycleId },
                  {
                    kind: "append_alert",
                    message: `cycle ${state.ctx.cycleId}: local main is ahead of origin/main by ${event.facts.mainAhead} commit(s) while cycle branch has ${event.facts.commitsAhead} commit(s) — leaked commits saved to quarantine bundle rescue-leaked-${state.ctx.cycleId}.bundle; shared main NOT reset (FIX-1475) — recover manually: git reset --hard origin/main`,
                  },
                ]
            : status === "failed" && event.facts.commitsAhead > 0
              ? [
                  { kind: "push_orphan", branch: state.ctx.branch },
                  {
                    kind: "append_alert",
                    message: `cycle ${state.ctx.cycleId}: gate-killed with ${event.facts.commitsAhead} commit(s) — branch ${state.ctx.branch} pushed for audit/rescue; next cycle starts fresh by design (FIX-247)`,
                  },
                ]
              : [];
        return terminate(next, status, [gateEvent, ...extra]);
      }
      // built → publish ladder.
      return {
        state: { ...next, phase: "publish" },
        commands: [gateEvent, { kind: "publish_pr", branch: state.ctx.branch, docOnly: false }],
      };
    }

    case "published": {
      const status = classifyPublish(event.result);
      if (status === "published" || status === "done") {
        // Published (PR open, awaiting the reconciler) or locally ff-merged
        // (gh-missing tier → done) → clean worktree → terminal.
        const extra: CycleCommand[] = [
          // published/done: work is on the remote (or ff-merged) → skip the bundle.
          { kind: "cleanup_environment" }, { kind: "cleanup_worktree", branch: state.ctx.branch, bundleUnpushed: false },
        ];
        return terminate({
          ...state,
          phase: "cleanup",
          ctx: event.result.degraded === true
            ? state.ctx
            : { ...state.ctx, publishConfirmed: true },
        }, status, extra);
      }
      if (status === "orphan") {
        // Commits pushed for audit; worktree cleaned (bin/roll:9333).
        return terminate({ ...state, phase: "cleanup" }, "orphan", [
          // orphan: commits were pushed to the remote for audit → skip the bundle.
          { kind: "cleanup_environment" }, { kind: "cleanup_worktree", branch: state.ctx.branch, bundleUnpushed: false },
          { kind: "append_alert", message: `cycle ${state.ctx.cycleId}: publish failed; orphan branch+tag pushed; worktree cleaned` },
        ]);
      }
      // FIX-351: a `built` (gates-passed) cycle whose publish could not complete
      // and whose orphan branch was not pushed is `local` (→ unpublished), NOT
      // failed — the work is sound and committed; only the publish step did not
      // land. Worktree PRESERVED (bin/roll:9337) so the local commits are
      // recoverable; the dashboard renders this neutrally, not red.
      return terminate({ ...state, phase: "publish" }, "local", [
        { kind: "append_alert", message: `cycle ${state.ctx.cycleId}: gates passed but publish did not complete — work committed locally, worktree preserved at branch ${state.ctx.branch} (unpublished, not a failure)` },
      ]);
    }

    case "merge_polled": {
      // Optional SYNCHRONOUS merge-wait (the card's "等真合并"): drive nextWaitAction.
      const action: WaitAction = nextWaitAction(event.state, event.elapsedSec);
      if (action.kind === "wait") {
        return {
          state: { ...state, phase: "merge-wait" },
          commands: [{ kind: "wait_merge", branch: state.ctx.branch, elapsedSec: event.elapsedSec + action.sleepSeconds }],
        };
      }
      if (action.kind === "merged") {
        return terminate({ ...state, phase: "reconcile" }, "done", [
          { kind: "reconcile" },
          { kind: "cleanup_environment" }, { kind: "cleanup_worktree", branch: state.ctx.branch },
        ]);
      }
      // closed | timeout → the PR never merged; orphan-preserve (audit).
      return terminate({ ...state, phase: "merge-wait" }, "orphan", [
        { kind: "push_orphan", branch: state.ctx.branch },
      ]);
    }

    default:
      // No-op for events that don't apply to the current phase (resumable, I8).
      return { state, commands: [] };
  }
}

/** Build the cycle:start RollEvent (bin/roll:8929 `_loop_event cycle_start`). */
export function cycleStartEvent(ctx: CycleContext, ts = 0): RollEvent {
  return {
    type: "cycle:start",
    cycleId: ctx.cycleId,
    storyId: ctx.storyId ?? "",
    agent: ctx.agent ?? "",
    model: ctx.model ?? "",
    ts,
  };
}

/** US-LOOP-106: the `adversarial:degraded` emit command — an adversarial cycle
 *  fell back to a standard single builder; recorded so the fallback is auditable
 *  (never silent). `from` is always "adversarial" at the orchestrator layer. */
function adversarialDegradedCmd(
  cycleId: string,
  storyId: string,
  cause: string,
  from: "verified" | "designed" | "adversarial" = "adversarial",
): CycleCommand {
  return {
    kind: "emit_event",
    event: { type: "adversarial:degraded", cycleId, storyId, from, to: "single-builder", cause, ts: 0 },
  };
}

/** Build a fresh initial cycle state (phase `pick`, attempt 0, not done). */
export function initialCycleState(ctx: CycleContext): CycleState {
  return { phase: "pick", ctx, attempt: 0, done: false };
}

// ── Event-sourcing fold (I8: rebuild terminal state from the event stream) ────

/** The terminal state rebuilt from a cycle's RollEvent stream. */
export interface RebuiltCycle {
  cycleId?: string;
  storyId?: string;
  agent?: AgentId;
  /** The terminal outcome from the LAST cycle:end (undefined ⇒ never ended). */
  outcome?: TerminalOutcome;
  /** Phases entered, in order (from cycle:phase events). */
  phases: CyclePhase[];
  /** True once a cycle:end was seen (terminal event written — I8). */
  ended: boolean;
}

/**
 * Fold a cycle's RollEvent stream into its terminal state (I8: all state rebuilds
 * from the published stream, no cache). A SIGKILL mid-phase leaves no cycle:end,
 * so `ended === false` — the caller's recovery layer (loop/recovery.ts) heals it.
 * The LAST cycle:end wins (idempotent re-emission is safe). Pure fold over events
 * already parsed by spec {@link parseEventLine} (the round-trip the tests assert).
 */
export function foldCycle(events: readonly RollEvent[]): RebuiltCycle {
  const out: RebuiltCycle = { phases: [], ended: false };
  for (const ev of events) {
    switch (ev.type) {
      case "cycle:start":
        out.cycleId = ev.cycleId;
        out.storyId = ev.storyId;
        out.agent = ev.agent;
        break;
      case "cycle:phase":
        out.phases.push(ev.phase);
        break;
      case "cycle:end":
        out.cycleId = ev.cycleId;
        out.outcome = ev.outcome;
        out.ended = true;
        break;
      default:
        break;
    }
  }
  return out;
}
