/**
 * RollEvent — the published language (BC7, I8): every loop appends these to
 * events.ndjson; all state is rebuilt from this stream, no separate cache.
 * Schema per specs/architecture §3 (v2-aligned).
 */
import type { AgentId, AgentToolchainClassification, ArtifactRef, ExecutionProfile } from "./agent.js";
import type { CycleCost, CyclePhase } from "./cycle.js";
import type {
  DelegationTrigger,
  HistoricalDelegationTrigger,
  HistoricalDeltaBlockReason,
  DeliveryTopology,
  QualityProfile,
  DeltaRole,
  ResolutionSource,
  IdentityProvenance,
  DeltaBlockReason,
  DeltaTerminalOutcome,
  TerminalBinding,
  DeliveryDisposition,
} from "./delta-team.js";
import type { GoalReviewMode, GoalSafetyGate, GoalScope, GoalStatus, GoalTransitionActor } from "./goal.js";
import type { LoopType } from "./loop.js";
import type { BlockCause, FailureClass, TerminalEvent, TerminalOutcome } from "./terminal.js";
import type { TaskLevel } from "./story.js";
import type { BuilderFinalizationFacts, BuilderFinalizationVerdict } from "./builder.js";
import type { WorktreeLifecycleEvent } from "./managed-workspace.js";

/**
 * US-PAIR-014 — why a recorded cost figure is what it is.
 * `estimated` = derived from the price table (never an invoice).
 * `unobservable` = the peer's usage could not be parsed, so 0 is NOT "free".
 */
export type CostBasis = "estimated" | "unobservable";

export type RollEvent =
  // Loop lifecycle (BC2)
  | { type: "loop:fire"; loop: LoopType; ts: number }
  | { type: "loop:idle"; loop: LoopType; nextFire: number; ts: number }
  | { type: "loop:error"; loop: LoopType; error: string; ts: number }
  | { type: "loop:paused"; loop: LoopType; ts: number }
  | { type: "loop:resumed"; loop: LoopType; ts: number }
  | { type: "loop:pending"; loop: LoopType; cycleId: string; reason: string; suspended: Array<{ agent: string; cause: string; detail?: string }>; ts: number }
  // FIX-1268: the screen is locked and at least one physical-surface card was held.
  // Emitted once per idle cycle that is blocked solely (or primarily) by this gate.
  | { type: "loop:screen_locked"; cycleId: string; storyId?: string; locked: boolean; reason: string; ts: number }
  // US-LOOP-115: loop:dormant / loop:woke / loop:dormant_failed are no longer
  // EMITTED — the dormancy and wake paths are deleted. The event union is a read
  // contract over an append-only ledger, so the shapes stay parseable forever.
  | { type: "loop:dormant"; loop: LoopType; ts: number; reason: string; since: number }
  | { type: "loop:woke"; loop: LoopType; ts: number; trigger: "roll-cmd" | "dream" | "pr" | "manual"; picked?: string; wakeEpoch: number }
  | { type: "loop:dormant_failed"; loop: LoopType; ts: number; reason: string; error: string }
  // Cycle (BC2) — cycle:end anchors reconcile + cost accounting
  | { type: "cycle:start"; cycleId: string; storyId: string; agent: AgentId; model: string; ts: number }
  // US-V4-004: the selected Story execution profile, recorded once per cycle at
  // route-resolve (before execute). standard = builder only (current behavior).
  | { type: "execution:profile"; cycleId: string; storyId: string; profile: ExecutionProfile; reason: string; ts: number }
  // US-LOOP-102 — adversarial-pairing subsequence (verified/designed profiles).
  // The orchestrator runs test_author → implementer → attack rounds; each stage
  // is a durable fact so the shadow-run aggregate (US-LOOP-104) can measure holes
  // found / rounds / termination without re-deriving from spawn logs. The
  // The `degraded` fallback event (US-LOOP-106) makes an adversarial→single-builder
  // fallback an explicit, never-silent fact: any adversarial exception (non-hetero
  // pair, agent unavailable, round hang) routes through the pure
  // adversarialDegradeDecision (US-LOOP-103) and completes the card as a standard
  // single builder — recorded here so it is auditable, not swallowed.
  | { type: "adversarial:test-authored"; cycleId: string; storyId: string; agent: string; ts: number }
  | { type: "adversarial:implemented"; cycleId: string; storyId: string; agent: string; round: number; ts: number }
  | { type: "adversarial:attack-round"; cycleId: string; storyId: string; agent: string; round: number; newHole: boolean; dryStreak: number; ts: number }
  | { type: "adversarial:terminated"; cycleId: string; storyId: string; reason: "dry" | "max_rounds" | "timeout"; rounds: number; holesFound: number; ts: number }
  | { type: "adversarial:degraded"; cycleId: string; storyId: string; from: "verified" | "designed" | "adversarial"; to: "single-builder"; cause: string; ts: number }
  | { type: "cycle:phase"; cycleId: string; phase: CyclePhase; ts: number }
  | { type: "cycle:stdout"; cycleId: string; data: string; ts: number }
  | { type: "cycle:tcr"; cycleId: string; commitHash: string; message: string; ts: number; commitTs?: number }
  | { type: "cycle:first_edit"; cycleId: string; commitHash: string; ts: number }
  // US-OBS-042 — observable TCR micro-step rhythm. These are advisory
  // supervisor/evaluator facts: they make rhythm visible and reviewable, but
  // do not terminate an active builder by themselves.
  | { type: "action:started"; cycleId: string; actionId: string; summary: string; expectedEvidence: string; fileAreaScope: string[]; ts: number }
  | { type: "test:red"; cycleId: string; actionId?: string; source: string; summary?: string; ts: number }
  | { type: "test:green"; cycleId: string; actionId?: string; source: string; summary?: string; ts: number }
  | { type: "green-uncommitted"; cycleId: string; actionId?: string; since: number; durationSec: number; ts: number }
  | { type: "action:oversized"; cycleId: string; actionId?: string; filesTouched: number; contractAreas: number; thresholdFiles: number; thresholdAreas: number; ts: number }
  // US-OBS-043 — dynamic action split checkpoints. Advisory only: these make
  // expanded action scope and accepted follow-up work visible; they do not kill
  // an active builder or mark the current Story failed.
  | { type: "split:suggested"; cycleId: string; actionId?: string; reason: string; currentBoundary: string; followupTitle?: string; ts: number }
  | { type: "followup:queued"; cycleId: string; actionId?: string; followupId?: string; title: string; reason: string; ts: number }
  // FIX-929 — agent stall detection: the builder produced zero token output for
  // a configurable threshold (default 10 min). This is a SIGNAL, not a kill —
  // fire BEFORE the hard timeout watchdog. A 2-min startup grace prevents false
  // positives during agent initialization. The signal feeds the recovery layer
  // (FIX-930) so it can switch agents before hitting the hard timeout kill.
  | { type: "agent:stall"; cycleId: string; agent: string; idleSec: number; thresholdSec: number; ts: number }
  // FIX-907 — the per-cycle HARD TIMEOUT tripped: a builder hung (process alive,
  // 0% CPU, no new commits/events) or a runaway exceeded the wall-clock ceiling.
  // `reason` is the criterion that fired — `wall` (total cycle time > ceiling),
  // `no-progress` (no new commit/stdout for the idle window; NOT pure elapsed
  // time, so a slow-but-still-emitting deepseek call never trips it), or
  // FIX-1477's `no-state-change` (no new commit AND no worktree dirty-state
  // change for the state window, EVEN IF stdout kept flowing — the thrash
  // shape: tokens burning, zero git progress). The agent process tree was
  // killed, the inflight lock released, and the worktree branch PRESERVED
  // (work salvageable). `elapsedSec`/`idleSec` make the trip auditable.
  | { type: "cycle:timeout"; cycleId: string; reason: "wall" | "no-progress" | "no-state-change"; elapsedSec: number; idleSec: number; ts: number }
  // US-CYCLE-006 — a card needed more repair rounds than the threshold, so a
  // `split-advice.md` was generated (from round-journal FACTS, not model guess)
  // to feed the sizing error back to the design side. Signal only: no backlog /
  // spec mutation. `rounds` is the distinct-round count observed in the journal.
  | { type: "split:advice"; card: string; rounds: number; path: string; ts: number }
  // US-CYCLE-008 — a NEW-regime card reached the evaluate stage without a valid
  // risk_tier in its lint-validated spec, so the tier gate FAILED CLOSED and
  // blocked evaluation before any evaluator ran (never a silent default to low).
  | { type: "eval:tier-missing"; cycleId: string; card: string; ts: number }
  // US-CYCLE-012 — a (role × model) rig failed the same card >= threshold times
  // in a row, so a MODEL-SWAP CANDIDATE was surfaced (candidate file written).
  // Signal only — never an automatic swap; a heterogeneous consensus adjudicates.
  | { type: "model:swap_candidate"; card: string; role: string; model: string; streak: number; path: string; ts: number }
  // US-CYCLE-012 — a heterogeneous consensus adjudicated a swap candidate.
  // `decision` is `agree` (unanimous — recorded as approved, still owner-applied)
  // or `escalate` (any disagreement / no valid verdicts → owner decides). The
  // model binding is NEVER rewritten automatically.
  | { type: "model:swap_decision"; card: string; role: string; model: string; decision: "agree" | "escalate"; path: string; ts: number }
  // US-CYCLE-002 — a SUB-agent spawn (designer / evaluator / adversarial builder
  // role / pick-ranking) was killed by the shared run-watchdog after breaching
  // its per-role timeout cap. Unlike `cycle:timeout` (the main builder cycle),
  // this carries role/agent/model so a supervisor delegating to sequential
  // heterogeneous subagents can read WHICH role died, on WHICH model, WHY, and
  // for HOW LONG — the terminal-visible accounting the epic requires. `reason`
  // adds `external` (the run ended by something other than the watchdog).
  | {
      type: "spawn:kill";
      cycleId: string;
      role: string;
      agent: string;
      model?: string;
      reason: "wall" | "no-progress" | "no-state-change" | "external";
      durationSec: number;
      ts: number;
    }
  // US-CYCLE-002 — the shared watchdog renewed a sub-agent spawn's liveness on
  // observed git-state progress (a new commit or a worktree dirty-state change)
  // in the run's own cwd, so a long PRODUCTIVE subagent is never mis-killed.
  // Emitted only on git-state bumps (not per stdout chunk) to keep the stream
  // legible; `idleSec` is how long the run had been idle before this renewal.
  | { type: "spawn:renew"; cycleId: string; role: string; agent: string; signal: "commit" | "dirty"; idleSec: number; ts: number }
  // FIX-1474 — the builder child process was detected DEAD/MISSING by the
  // runner's liveness probe while its spawn await had NOT settled: an
  // out-of-band death (external SIGKILL of a process-tree member, PTY leader
  // death, lost exit delivery) that the FIX-907 watchdogs cannot see (they
  // only cover a child that is ALIVE but hung/silent/thrashing). Recorded
  // BEFORE the kill + `aborted` terminal teardown so the death is auditable
  // (fail-loud, never a silent hang). `pid` is the probed child process id.
  | { type: "cycle:agent_lost"; cycleId: string; agent: string; pid?: number; ts: number }
  // US-LOOP-088 — post-cycle environment cleanup is observable in the event stream.
  | { type: "cycle:cleanup"; cycleId: string; rule: string; path: string; ok: boolean; warning?: string; ts: number }
  | { type: "cycle:end"; cycleId: string; outcome: TerminalOutcome; cost: CycleCost; ts: number; failure_class?: FailureClass; root_cause_key?: string }
  // FIX-903: leaked main commits were saved to a rescue ref before reset.
  | { type: "cycle:rescue"; cycleId: string; ref: string; rescuedSha: string; ts: number }
  // FIX-1037: a builder escaped the cycle worktree or the main checkout was
  // already dirty before spawn. This is a sandbox/execution-boundary failure,
  // distinct from agent auth/network blocks.
  | { type: "sandbox:main_dirty"; cycleId: string; phase: "pre-spawn" | "active-spawn" | "post-spawn" | "capture"; files: string[]; ts: number }
  // US-LOOP-089: builder process lifetime OS write protection for the shared
  // main checkout. recovered means a stale marker from a crashed prior cycle was
  // restored before applying protection for the new cycle.
  | { type: "sandbox:write_protected"; cycleId: string; status: "applied" | "released" | "recovered"; repoCwd: string; markerPath: string; paths: number; ts: number }
  // US-LOOP-089: main checkout pollution was moved to an auditable rescue ref
  // and quarantine manifest. FIX-1475: for reason "ahead" the shared main ref
  // is NEVER moved — the commits are bookmarked on `ref` and left in place;
  // restoreCommand is then a manual-recovery note, not an applied action.
  | {
      type: "sandbox:quarantined";
      cycleId: string;
      storyId?: string;
      phase: "pre-spawn" | "active-spawn" | "post-spawn" | "post-cycle" | "capture";
      reason: "dirty" | "ahead";
      ref: string;
      files: string[];
      manifestPath: string;
      restoreCommand: string;
      ts: number;
    }
  // FIX-1068 — Builder finalization hard gate: one adapter-agnostic verdict before
  // peer review / scoring / attest / PR creation / cleanup. Emitted on every exit
  // so recovery surfaces can read structured facts instead of parsing logs.
  | {
      type: "builder:finalized";
      cycleId: string;
      storyId: string;
      agent: string;
      verdict: BuilderFinalizationVerdict;
      facts: BuilderFinalizationFacts;
      ts: number;
    }
  | {
      type: "builder:handoff_required";
      cycleId: string;
      storyId: string;
      agent: string;
      kind: string;
      worktreePath: string;
      ts: number;
    }
  | {
      type: "builder:boundary_violation";
      cycleId: string;
      storyId: string;
      agent: string;
      kind: "main_checkout_dirty";
      files: string[];
      worktreePath: string;
      attemptedCwd?: string;
      expectedWorktreeCwd?: string;
      leakedCommits?: number;
      ts: number;
    }
  | {
      type: "warm-session:resume-selected";
      cycleId: string;
      storyId: string;
      agent: AgentId;
      sessionId: string;
      sourceCycleId: string;
      sourceStoryId: string;
      reason: "selected";
      ts: number;
    }
  | {
      type: "warm-session:resume-skipped";
      cycleId: string;
      storyId: string;
      agent: AgentId;
      reason: "policy_off" | "agent_unsupported" | "no_prior_session" | "scope_mismatch" | "stale_session";
      sourceCycleId?: string;
      sourceStoryId?: string;
      ts: number;
    }
  | {
      type: "warm-session:capture";
      cycleId: string;
      storyId: string;
      agent: AgentId;
      sessionId: string;
      rolloutPath?: string;
      spawnedWarm: boolean;
      ts: number;
    }
  // Routing (BC3) — auditable, reproducible (I10)
  | { type: "route:resolve"; storyId: string; level: TaskLevel; agent: AgentId; model: string; rule: string; ts: number }
  // FIX-1267 — hard builder rotation audit: the previous cycle's Builder was
  // excluded from this cycle's execute pool and a DIFFERENT builder was selected.
  // One event per cycle where the rotation actually changed the builder, so an
  // operator can verify the no-consecutive-repeat constraint really fired
  // (`selected` is guaranteed ≠ `previous`).
  | { type: "builder:rotation"; cycleId: string; storyId: string; previous: string; selected: string; ts: number }
  // IDEA-069 — advisory semantic backlog ranking. This is explanatory only:
  // picker eligibility gates remain authoritative.
  | {
      type: "pick:ranked";
      cycleId: string;
      picked: string;
      rank: number;
      total: number;
      reason: string;
      ranking: Array<{ id: string; score: number; reason: string }>;
      source: "agent" | "cache";
      ts: number;
    }
  | { type: "pick:skipped"; cycleId: string; storyId: string; reason: string; ts: number }
  // FIX-1215: blocked-card detail for idle observability + gh failure resilience
  | { type: "pick:blocked"; cycleId: string; storyId: string; reason: string; ts: number }
  | { type: "pick:gh_error"; cycleId: string; reason: string; ts: number }
  | { type: "pick:gh_degraded"; cycleId: string; reason: string; ts: number }
  | {
      type: "harness_failure";
      channel: "US-LOOP-090";
      operation: string;
      reason: string;
      detail: string;
      ts: number;
    }
  // Delivery (BC4)
  | { type: "pr:open"; prNumber: number; storyId: string; ts: number }
  | { type: "pr:merge"; prNumber: number; storyId: string; ts: number }
  | { type: "pr:rebase"; prNumber: number; ts: number }
  | { type: "pr:close"; prNumber: number; reason: string; ts: number }
  | { type: "ci:pass"; prNumber: number; ts: number }
  | { type: "ci:fail"; prNumber: number; failSummary: string; ts: number }
  | { type: "ci:rerun"; prNumber: number; ts: number }
  // US-DELIV-001 — delivery lifecycle events (design §3.2). These are the ONLY
  // writers of a cycle's deliveryState: `projectDeliveryState` (@roll/core)
  // folds them into the DeliveryState vocabulary; no path hand-writes a
  // terminal delivery state without appending the carrying event.
  // Push-time evidence gate (emitter lands with US-DELIV-004's hard gate).
  | { type: "delivery:evidence_gate"; cycleId: string; storyId: string; verdict: "earned" | "blocked"; reasons: string[]; ts: number }
  // PR opened = the cycle enters AWAITING_MERGE and the loop is released to
  // pick the next card — it does NOT block waiting for the merge.
  | { type: "delivery:published"; cycleId: string; storyId: string; branch: string; prNumber: number; prUrl: string; ts: number }
  // Self-driven merge attempt (emitter lands with US-DELIV-003).
  | { type: "delivery:merge_attempt"; cycleId: string; prNumber: number; method: "squash"; outcome: "merged" | "ci_red" | "blocked" | "gh_down"; ts: number }
  // US-CYCLE-009: the git plane (git fetch / ls-remote — NEVER a `gh` stdout
  // grep) confirmed the cycle branch is merged into main. This is the event that
  // drives the async reconcile write-back off the critical path; `signal` records
  // WHICH git-plane fact confirmed it (branch tip is an ancestor of main, or the
  // branch's net patch-id is present on main).
  | { type: "delivery:merge_confirmed"; cycleId: string; storyId: string; branch: string; prNumber?: number; signal: "ancestor" | "patch_id" | "merge_commit"; mergeCommit?: string; ts: number }
  // A published PR was closed without merging. This is terminal for the
  // cycle and releases its delivery lease without claiming delivery.
  | { type: "delivery:abandoned"; cycleId: string; storyId: string; reason: "pr_closed_unmerged"; ts: number }
  // Reconcile-from-main backfill (emitter lands with US-DELIV-002): a strong
  // signal (PR-state / patch-id) confirmed the cycle's change on main.
  // E3: `delivered_local` — a local-only delivery landed the cycle on the LOCAL
  // integration branch (no push / no PR / no remote merge). `mergedBy:"runner"`,
  // `mergeCommit` = the local landing SHA, `signal:"patch_id"` (the local commit
  // identity, not a PR state).
  | { type: "delivery:reconciled"; cycleId: string; storyId: string; state: "delivered" | "delivered_external" | "delivered_local" | "superseded"; mergedBy: "runner" | "external"; mergeCommit: string; signal: "pr_state" | "patch_id" | "backlog_attest"; patchId?: string; ts: number }
  // Alert (BC2/BC6)
  | { type: "alert:notify"; channel: string; message: string; ts: number }
  // Supervisor journal (US-OBS-048) — structured narrative of decisions,
  // verifications, and rescues so supervisor reasoning survives the chat session.
  | {
      type: "supervisor:journal";
      ts: number;
      actor: string;
      action: SupervisorJournalAction;
      storyId?: string;
      cycleId?: string;
      note?: string;
      evidence?: ArtifactRef[];
    }
  // Goal mode (US-GOAL-001) — the durable goal state machine facts.
  | { type: "goal:created"; schema: "goal.v1"; scope: GoalScope; status: "active"; review: GoalReviewMode; ts: number }
  // FIX-1254: a completed goal is immutable; a later `go` archives it before
  // creating a distinct active goal instead of reviving its terminal state.
  | { type: "goal:archived"; schema: "goal.v1"; scope: GoalScope; status: "complete"; archivePath: string; ts: number }
  | { type: "goal:state"; schema: "goal.v1"; from: GoalStatus; to: GoalStatus; actor: GoalTransitionActor; reason: string; ts: number }
  | { type: "goal:session_start"; sessionId: string; scope: GoalScope; ts: number }
  | { type: "goal:session_end"; sessionId: string; status: GoalStatus; reason: string; cycles: number; ts: number }
  | { type: "goal:tick_skipped"; sessionId?: string; reason: "go_session_lock"; heldByPid?: number; ts: number }
  // FIX-269: the session is parked while a scheduled cycle holds the inner lock.
  | { type: "goal:waiting_inner_lock"; sessionId: string; heldByPid: number; ts: number }
  | { type: "goal:evaluated"; sessionId: string; status: "continue" | "complete"; total: number; delivered: number; reason: string; blockers: string[]; ts: number }
  | { type: "goal:card_skipped"; sessionId: string; storyId: string; reason: "zero_delivery_streak" | "no_progress_streak"; zeroDeliveries: number; cycleId?: string; ts: number }
  // FIX-1049 — supervised recovery from a no-progress stop. The supervisor (a
  // human/agent on the loop) inspected a goal the dead-loop breaker stopped and
  // either cleared the stall for ONE more attempt by the next eligible Builder
  // (`decision: "allowed"`) or could not (`decision: "denied"`, e.g. no alternate
  // Builder to rotate to). Recording WHO resumed, which Builder last failed,
  // which is selected next, and WHY the retry is allowed keeps the breaker
  // auditable — recovery never silently bypasses it.
  | {
      type: "goal:recovery";
      decision: "allowed" | "denied";
      actor: GoalTransitionActor;
      storyId?: string;
      reason: string;
      lastBuilder?: string;
      nextBuilder?: string;
      skippedBuilders?: string[];
      noProgressCycles?: number;
      handoff?: { cycleId: string; kind: string; detail: string };
      ts: number;
    }
  | {
      type: "goal:gate_tripped";
      sessionId: string;
      gate: GoalSafetyGate;
      action: "audit" | "paused";
      reason: string;
      reading: Record<string, string | number | boolean>;
      waitUntilSec?: number;
      ts: number;
    }
  | {
      type: "goal:final_review";
      sessionId: string;
      mode: GoalReviewMode;
      effectiveMode: "hetero" | "self" | "off";
      reviewer: string;
      provider: string;
      verdict: "APPROVE" | "REQUEST_CHANGES" | "TIMEOUT" | "ERROR" | "SKIPPED";
      reason: string;
      findings: string[];
      commandFamily?: string;
      durationMs?: number;
      transcriptPath?: string;
      evidencePath?: string;
      ts: number;
    }
  | {
      type: "goal:review_degraded";
      sessionId: string;
      from: "auto";
      to: "self";
      reviewer: string;
      provider: string;
      reason: string;
      ts: number;
    }
  // Peer gate (FIX-150b) — the hard-trigger audit trail: every gated delivery
  // records whether peer review happened ("consulted") or was skipped. FIX-312
  // adds "self-review-allowed": a substantive delivery shipped with no peer
  // evidence BECAUSE no heterogeneous peer was available (recorded fallback, not
  // a block — distinct from a "skipped" violation where hetero WAS available).
  | { type: "peer:gate"; cycleId: string; verdict: "consulted" | "skipped" | "self-review-allowed"; reasons: string[]; ts: number }
  // Cross-Agent Pairing (US-PAIR-003) — a heterogeneous peer one-way reviews a
  // delivery. `pair:*` is deliberately distinct from `peer:gate` (decoupled audit).
  // FIX-1054: `attempt` (1 = ranked candidate, ≥2 = fallback/retry) and `reason`
  // (ranked_candidate / fallback_after_* / same_agent_retry / fanout) make the
  // serial cost-aware dispatch auditable — the supervisor sees WHY a peer was
  // chosen. Both optional for back-compat with the pre-FIX-1054 (parallel) logs.
  // US-PAIR-020: the isolation decision, recorded per dispatch. Without
  // `achievedTier` the question "does raising isolation actually help?" is
  // unanswerable no matter how long the stream runs — nothing recorded how far
  // apart the reviewer actually was. `degradedFrom` + `tierReason` say WHY it is
  // not stronger, distinguishing "no farther candidate exists" from "the farther
  // candidate would not open".
  | { type: "pair:selected"; cycleId: string; workingAgent: string; peer: string; stage: string; attempt?: number; reason?: string; declaredTier?: string; achievedTier?: string; degradedFrom?: string; tierReason?: string; ts: number }
  // FIX-1054 — SERIAL dispatch is the default: once a peer's result is accepted,
  // the remaining ranked candidates are SKIPPED (never spawned). This event makes
  // the un-spent candidates visible AS a policy decision (not zero-cost attempts).
  | { type: "pair:skipped"; cycleId: string; peers: string[]; reason: string; stage: string; ts: number }
  // FIX-1054 — high-risk fan-out is still allowed, but ONLY through an explicit,
  // reasoned, bounded policy decision (truth/release/evidence gate, security card,
  // repeated prior failures, owner quorum). This records the reason + the fan-out
  // limit + the concurrently-dispatched peers so fan-out is never a silent default.
  | { type: "pair:fanout"; cycleId: string; stage: string; reason: string; limit: number; peers: string[]; ts: number }
  // US-PAIR-014: `costBasis` says WHY the cost figure is what it is. Optional for
  // back-compat: a legacy row has no basis, and a bare `cost: 0` on such a row is
  // exactly the "free or unknown?" ambiguity this field removes. 5 of 7 agents hit
  // the unparseable path, so treating 0 as "free" made aggregate cost meaningless.
  // "estimated" is also honest that the figure comes from the price table, not an invoice.
  // US-PAIR-004: `stage` is optional for back-compat with PAIR-003 (code-only)
  // logs; multi-stage pairing stamps it so verdicts are distinguishable per stage.
  | { type: "pair:verdict"; cycleId: string; peer: string; verdict: "agree" | "refine" | "object"; findings: number; cost: number; costBasis?: CostBasis; model?: string; observedModel?: string; modelMismatch?: string; stage?: string; ts: number }
  // US-PAIR-009: the score stage's outcome — a heterogeneous peer scored the cycle.
  // FIX-344: `stage` widens to `"design"` for the roll-design peer Review Score
  // path. roll-design has NO loop cycle (no commitsAhead/worktree), so its
  // independent peer score is triggered at skill wrap-up via `roll pair score
  // --design` and stamped `stage: "design"` so the design score is distinguishable
  // from a build/fix cycle's `stage: "score"` in the same event stream.
  | { type: "pair:score"; cycleId: string; peer: string; score: number; verdict: "good" | "ok" | "regression"; cost: number; costBasis?: CostBasis; model?: string; observedModel?: string; modelMismatch?: string; stage: "score" | "design"; ts: number }
  | { type: "pair:none-available"; cycleId: string; stage: string; reason: string; ts: number }
  // FIX-910 — per-attempt score-stage failure attribution (unparseable / timeout /
  // auth-block / exit-error), emitted from the executor's scorePeer closure so
  // every null return from a scorer is observable (no more silently swallowed nulls).
  // The "unparseable" cause additionally triggers ONE retry with a stricter format
  // reminder; a second failure is also recorded.
  | { type: "pair:score-failure"; cycleId: string; peer: string; cause: "unparseable" | "timeout" | "auth-block" | "exit-error"; detail?: string; artifactPath?: string; stage: "score" | "design"; ts: number }
  // FIX-346 — a peer was REMOVED from the candidate pool after repeated headless
  // AUTH failures (expired/unavailable creds it cannot refresh non-interactively:
  // agy's Google OAuth, claude's macOS keychain/auth-daemon cooldown, …). The loop
  // must NEVER pop an interactive login or pull the owner into auth for an
  // unattended cycle, so once an agent has failed auth `failures` times in a row it
  // is dropped from selection (the next heterogeneous peer is swapped in) instead of
  // being re-spawned — and re-failing — every cycle. `cause` is always "auth"
  // today (network blocks are transient and not pool-excluded). Observable so the
  // owner sees WHY an agent stopped being consulted (and can re-login it offline).
  | { type: "pair:excluded"; cycleId: string; agent: string; cause: "auth"; failures: number; ts: number }
  // FIX-319 — wall-clock timing of EVERY heterogeneous peer consult (the
  // reviewPeer spawn), success or not, so the 120s hard timeout can be tuned
  // empirically from real data instead of guessed. outcome: a parsed verdict
  // (`reviewed`), the timeout fired (`timeout`), or a spawn/non-zero-exit
  // (`error`). durationMs is the real spawn wall-clock (capped near the timeout
  // when it fires).
  // FIX-363: `cause` attributes a non-`reviewed` consult to its ROOT — an
  // external block (`auth` = not logged in / 403, `network` = VPN/proxy/DNS down)
  // vs genuine slowness (absent). It lets the loop act on the real problem
  // (re-login / reconnect) instead of treating every timeout as "slow → wait
  // longer → burn → pause with a misleading code-bug hint".
  | { type: "pair:consult"; cycleId: string; peer: string; durationMs: number; outcome: "reviewed" | "timeout" | "error"; cause?: "auth" | "network"; detail?: string; artifactPath?: string; ts: number }
  // FIX-363 — a reviewer/scorer agent was found BLOCKED by an external cause
  // (not slow): `auth` (not logged in / 403) or `network` (VPN/proxy/DNS down).
  // Emitted from the review/score failure path; loop-run-once reads it to ISOLATE
  // the failure from the consecutive-code-failure counter and raise an ACTIONABLE
  // pause ("re-login <agent>" / "check the VPN") instead of "3 failures → code bug".
  // FIX-366 — `stage: "build"` extends the SAME taxonomy to the main BUILDER spawn:
  // an unauthenticated builder prints a 403 / "Please run /login" in its first
  // seconds, so the spawn output is signature-matched the same way and folds into
  // the same isolate-from-counter + PAUSE(auth)/breathe(network) path — one block
  // taxonomy for builder/reviewer/scorer (no new precheck, no probe, no cache).
  | { type: "agent:blocked"; cycleId: string; agent: string; cause: BlockCause; stage: "build" | "review" | "score"; detail: string; ts: number }
  | { type: "rig:suspended"; cycleId?: string; agent: string; cause: "quota" | "auth" | "network" | "agent_stall" | "main_checkout_leak"; detail?: string; nextProbeAt: number; ts: number }
  | { type: "rig:recovered"; cycleId?: string; agent: string; detail?: string; ts: number }
  | { type: "rig:probe"; cycleId?: string; agent: string; outcome: "live" | "still_suspended"; cause?: "quota" | "auth" | "network" | "agent_stall" | "main_checkout_leak"; detail?: string; nextProbeAt?: number; ts: number }
  // FIX-930 — failure-driven agent swap on a zero-TCR/stalled cycle: the loop
  // re-marks the story Todo and routes the NEXT untried agent (excluding the one
  // that just gave up). `attempt` is the 1-based self-heal attempt for the story.
  | { type: "agent:retry"; cycleId: string; storyId: string; fromAgent: string; toAgent: string; attempt: number; reason: "zero-tcr" | "stall"; ts: number }
  // US-V4-022 — agent toolchain health signal classified by Supervisor. Emitted
  // when setup/doctor/loop logs detect a warning, auth/network block, polluted
  // skill root, stale setup sync, or worktree permission failure. The supervisor
  // owns classification and routing; cleanup belongs to a dedicated repair card.
  | {
      type: "agent:toolchain_issue";
      agent: AgentId;
      classification: AgentToolchainClassification;
      severity: "warning" | "error";
      detail: string;
      source: string;
      storyId?: string;
      ts: number;
    }
  | { type: "agent:quarantined"; agent: AgentId; storyId: string; reason: string; ts: number }
  // Attest gate (FIX-207) — every actual delivery records whether a fresh
  // acceptance report was produced ("produced") or silently skipped ("skipped").
  | { type: "attest:gate"; cycleId: string; verdict: "produced" | "skipped"; reasons: string[]; ts: number }
  // US-RULE-004a — doc-drift gate in SOFT mode: a declared doc surface's
  // sources changed without its declared docs (verdict from the shared pure
  // checkDocDrift). This is an auditable FACT, never an adjudication: there is
  // deliberately NO actor field (nothing here accepts actor=owner), no verdict
  // claim, and a soft hit never blocks (exit 0). hitId is a stable hash of
  // cycle/story/baseline/matched-surface set, so a retry appends no duplicate.
  | {
      type: "doc_drift_soft_hit";
      hitId: string;
      cycleId: string;
      storyId: string;
      baseline: string;
      surfaces: string[];
      ts: number;
    }
  // Visual-evidence build-preflight gate (FIX-311b) — the shift-left of the
  // attest gate. BEFORE the agent spawns, the picked card's spec is checked
  // against the design-phase visual-evidence contract. `ok` ⇒ the spec can
  // satisfy the screenshot floor; `flagged` ⇒ a CONFIDENT problem (a web-surface
  // card with no declared deliverable_url, or no visual-evidence AC and no
  // exemption) — recorded loud so it is caught at the cheapest moment; `diagnostic`
  // records a non-control-flow structural observation. NEVER blocks the cycle
  // (FIX-309 is the hard backstop at delivery); ambiguous / terminal surfaces are
  // never flagged here.
  | { type: "visual:gate"; cycleId: string; storyId: string; verdict: "ok" | "flagged" | "diagnostic"; code?: string; surface?: string; reasons: string[]; ts: number }
  // ac-map remediation (FIX-246) — a real delivery that skipped skill step 10.6
  // (no ac-map.json) gets ONE surgical same-agent second pass before attest
  // renders. The outcome is auditable; honest statuses only — never a bypass.
  | { type: "attest:remediation"; cycleId: string; storyId: string; agent: string; outcome: "written" | "still-missing" | "spawn-failed"; reason?: string; transcript?: string; ts: number }
  // FIX-912 — ac-map draft auto-generation. The harness wrote an ac-map.json
  // DRAFT from cycle evidence (commits, test files, changed files) BEFORE the
  // FIX-246 remediation ran. The draft has full AC structure + evidence chain
  // with CONSERVATIVE statuses ("pass-with-evidence" only with clear test
  // signals; otherwise "needs-confirmation"). The agent only needs to confirm.
  | { type: "attest:draft-generated"; cycleId: string; storyId: string; ts: number }
  // FIX-317 — the harness bridged a REAL captured screenshot into the ac-map's
  // pass ACs (the agent wired text-only evidence; the visual floor needs a
  // per-AC screenshot ref). Auditable: `href` + `attachedCount` distinguish
  // harness-added visual baselines from agent-supplied evidence. Honest — only a
  // screenshot that exists on disk this cycle is ever attached.
  | { type: "attest:auto-attach"; cycleId: string; storyId: string; href: string; attachedCount: number; ts: number }
  // Correction loop (US-EVID-014/016) — story-level negative feedback and the
  // safety brake that stops oscillation before the loop burns cycles.
  | {
      type: "correction:action";
      cycleId?: string;
      storyId: string;
      action: string;
      plannedAction?: string;
      signal: string;
      reason: string;
      mode?: string;
      source?: string;
      failureClass?: FailureClass;
      rootCauseKey?: string;
      targetId?: string;
      ts: number;
    }
  | {
      type: "correction:circuit_breaker";
      storyId?: string;
      signal: string;
      count: number;
      threshold: number;
      reason: string;
      failureClass?: FailureClass;
      rootCauseKey?: string;
      ts: number;
    }
  // Evidence lifecycle (US-EVID-001) — the runner opened the per-cycle evidence
  // frame before spawning an agent, so later phases have a durable run dir.
  | { type: "evidence:frame-opened"; cycleId: string; storyId: string; runDir: string; ts: number }
  // E2 (submodule-aware delivery): the picked story declared a target submodule
  // and the cycle worktree was created INSIDE that submodule (on `base`, the
  // submodule's integration branch). Observability of WHERE this cycle's work +
  // delivery land — the superproject vs a named submodule.
  | { type: "worktree:submodule"; cycleId: string; storyId: string; submodule: string; base: string; ts: number }
  // FIX-1058 — evidence-repair recovery for green PRs missing acceptance reports.
  // The repair is scoped: it only generates delivery evidence (ac-map + attest
  // report); it must not modify product code unless the evidence proves the
  // delivered code no longer matches spec (recorded as a refinement).
  | { type: "evidence:repair_requested"; prNumber: number; storyId: string; reason: string; ts: number }
  | { type: "evidence:repaired"; prNumber: number; storyId: string; outcome: "evidence-generated" | "refinement-needed"; details: string; ts: number }
  // FIX-1260 — auto-repair for draft PRs during reconcile.
  // repair:auto = the decision to auto-repair was made (before promotion).
  | { type: "repair:auto"; prNumber: number; storyId: string; cycleId: string; evaluatorSource: string; evaluatorDetail: string; reason: string; ts: number }
  // repair:auto:ready = the gh pr ready call outcome.
  | { type: "repair:auto:ready"; prNumber: number; storyId: string; cycleId: string; outcome: "ready" | "failed"; ts: number }
  // FIX-1048 — neutral always-on loop digest, successor to report:morning.
  | { type: "report:loop-digest"; path: string; windowStart: number; windowEnd: number; cycles: number; corrections: number; paused: boolean; ts: number }
  // Morning report (US-EVID-016) — one fixed human-readable page is rebuilt from
  // events/runs and linked from the dossier front page.
  | { type: "report:morning"; path: string; windowStart: number; windowEnd: number; cycles: number; corrections: number; paused: boolean; ts: number }
  // Policy (BC6) — governance decisions as facts
  | { type: "policy:auto_merge"; prNumber: number; rule: string; ts: number }
  | { type: "policy:flag_review"; prNumber: number; rule: string; ts: number }
  | { type: "policy:safety_pause"; loop: LoopType; reason: string; ts: number }
  // Release gate (US-TRUTH-005) — the gate verdict and any owner waiver are
  // FACTS in the stream: a bypass with no record is itself drift, and a later
  // audit must SEE every waiver (release_verdict / release_waiver anchors).
  | { type: "release:gate"; tag: string; verdict: "pass" | "blocked" | "waived"; failCount: number; waivedRules: string[]; ts: number }
  | { type: "release:waiver"; reason: string; scope: string; expiresSec: number; operator: string; ts: number }
  // Self-downgrade (US-AGENT-042) — the durable record of an automatic
  // decomposition decision. A `capped: false` split parked the parent at 🚫 Hold
  // and appended `childStoryIds` as fresh 📋 Todo rows (each inheriting the
  // parent's ORIGINAL inbound deps, never the parked parent). A `capped: true`
  // event is a REFUSED split — the chain already auto-split `chainDepth` times
  // (≥ the cap) or the story was irreducible — so the parent is held with NO
  // children and an ALERT is raised for human triage (US-AGENT-009 cap). The
  // reconcile reads this so a deliberately-parked parent is NOT mistaken for a
  // premature-done to revert at the cycle terminal.
  | {
      type: "story:split";
      parentStoryId: string;
      childStoryIds: string[];
      reason: string;
      chainDepth: number;
      capped: boolean;
      ts: number;
    }
  // FIX-1273 — branch/worktree canary + safe recovery. The canary trip now
  // enumerates the EXACT counted ephemeral branches and loop worktree dirs with
  // their fresh audit disposition, so the pause is auditable rather than a bare
  // count. `worktree_cleanup_planned` records the minimal, audit-derived
  // candidate set a dry-run proposes; `worktree_cleanup_applied` is emitted once
  // per verified removal (after a FRESH re-audit); `worktree_cleanup_refused`
  // makes every fail-closed refusal (changed head / new dirt / missing path /
  // concurrent activation / lost disposability) a durable, never-silent fact.
  // A canary count NEVER becomes a blanket deletion: action derives from audit.
  | {
      type: "branch_canary_tripped";
      /** Leak-safety total; healthy retained capacity is reported separately. */
      total: number;
      threshold: number;
      managedCapacity: number;
      ephemeralBranches: string[];
      worktrees: Array<{ path: string; disposition: string }>;
      ts: number;
    }
  | {
      type: "worktree_cleanup_planned";
      threshold: number;
      cleanupCapacityTotal: number;
      leakSafetyTotal: number;
      managedCapacity: number;
      dryRun: boolean;
      candidates: Array<{ path: string; expectedHead: string; branch?: string; cycleId?: string }>;
      preserved: Array<{ path: string; disposition: string }>;
      ts: number;
    }
  | {
      type: "worktree_cleanup_applied";
      path: string;
      expectedHead: string;
      branch?: string;
      cycleId?: string;
      ts: number;
    }
  | {
      type: "worktree_cleanup_refused";
      path: string;
      reason: string;
      ts: number;
    }
  // US-LOOP-122 — append-only managed-workspace lifecycle. Absolute paths,
  // live Git registration, delivery truth, and release verdicts deliberately
  // stay outside this Execution event aggregate.
  | WorktreeLifecycleEvent
  // US-TRUTH-001 — the versioned complete-or-reasoned terminal record. One per
  // cycle from schema v1 on; events older than the switch are GRANDFATHERED
  // (read under legacy rules, never retro-rewritten).
  | TerminalEvent
  // ── US-DELTA-001 — Delegation aggregate events ────────────────────────────
  | {
      type: "delta:prepared";
      delegationId: string;
      runId: string;
      storyId: string;
      cycleId?: string;
      /**
       * US-LOOP-110 (codex r3/r4): the EVENT UNION is a read contract over an
       * append-only ledger, so it must hold every value Roll has ever written —
       * including the retired trigger. Emitters are constrained separately: `roll
       * delta prepare` validates against the LIVE `DELEGATION_TRIGGERS`, so no new
       * event can carry a retired literal.
       */
      trigger: DelegationTrigger | HistoricalDelegationTrigger;
      topology: DeliveryTopology;
      qualityProfile: QualityProfile;
      presetId: string;
      presetSha256: string;
      hostId: string;
      ts: number;
    }
  | {
      type: "delta:role_resolved";
      delegationId: string;
      storyId: string;
      role: DeltaRole;
      roleInstanceId: string;
      hostId: string;
      modelId: string;
      source: ResolutionSource;
      reasons: string[];
      inventorySha256: string;
      inventoryObservedAt: string;
      ts: number;
    }
  | {
      type: "delta:role_started";
      delegationId: string;
      storyId: string;
      role: DeltaRole;
      sessionId: string;
      roleInstanceId: string;
      hostId: string;
      modelId: string;
      identityProvenance: IdentityProvenance;
      worktreeAccess: "read-only" | "builder-write";
      ts: number;
    }
  | {
      type: "delta:artifact_published";
      delegationId: string;
      storyId: string;
      role: DeltaRole;
      path: string;
      sha256: string;
      manifestPath: string;
      sessionId: string;
      roleInstanceId: string;
      identityProvenance: IdentityProvenance;
      ts: number;
    }
  | {
      type: "delta:terminal";
      delegationId: string;
      storyId: string;
      outcome: DeltaTerminalOutcome;
      terminalBinding: TerminalBinding;
      deliveryDisposition?: DeliveryDisposition;
      ts: number;
    }
  | {
      type: "delta:blocked";
      delegationId: string;
      storyId: string;
      role?: DeltaRole;
      /**
       * Read contract: historical events carry the retired reason. Emitters must
       * still write a LIVE reason only — `delta validate` enforces that and puts
       * any prior/foreign value in `detail` verbatim.
       */
      reason: DeltaBlockReason | HistoricalDeltaBlockReason;
      detail: string;
      ts: number;
    };

/** Supervisor journal action kinds (US-OBS-048). */
export const SUPERVISOR_JOURNAL_ACTIONS = ["decide", "verify", "rescue", "escalate", "note"] as const;
export type SupervisorJournalAction = (typeof SUPERVISOR_JOURNAL_ACTIONS)[number];

export type RollEventType = RollEvent["type"];

/**
 * Parse one ndjson line into a RollEvent. Returns null for blank lines,
 * malformed JSON, or objects without a string `type` and numeric `ts` —
 * readers must skip bad lines, never crash (I8: rebuild always succeeds).
 */
/**
 * Bounds of the "this is epoch SECONDS, not milliseconds" window.
 *
 * A real roll timestamp in seconds is at least 1e9 (2001-09-09) and always below
 * 1e12 (the year 33658 in seconds — but only 2001 in ms). Only values inside
 * `[1e9, 1e12)` are promoted.
 *
 * The range matters, not just the ceiling: small synthetic values used as test
 * fixtures (`ts: 120_000`, i.e. 1970) CANNOT be a real epoch-seconds stamp, so
 * they are left exactly as they are. A bare `< 1e12` floor check would silently
 * rescale them and corrupt every relative-duration computation built on them.
 */
export const EVENT_TS_SECONDS_MIN = 1_000_000_000;
export const EVENT_TS_MS_FLOOR = 1_000_000_000_000;

/**
 * FIX-1490 — an event `ts` is epoch MILLISECONDS. Normalize a value that is
 * demonstrably epoch seconds onto that contract; leave everything else alone.
 *
 * Why this is needed on BOTH sides: the write-side normalization (2026-06-18,
 * c881f0ab) only covers `serializeEvent`, but three writers hand-rolled their own
 * `appendFileSync` and bypassed it — so 5,483 of 22,293 historical events carry
 * seconds, mixed WITHIN the same event types. Reading them as ms renders 2026
 * dates as 1970 and silently poisons every time-bucketed aggregation.
 *
 * Explicit and idempotent by construction — never a silent `* 1000` sprinkled at
 * call sites (a value already in ms is returned unchanged).
 */
export function eventTsMs(ts: number): number {
  if (!Number.isFinite(ts)) return ts;
  if (ts < EVENT_TS_SECONDS_MIN || ts >= EVENT_TS_MS_FLOOR) return ts;
  return ts * 1000;
}

export function parseEventLine(line: string): RollEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  // FIX-1490 deliberately does NOT normalize `ts` here. `parseEventLine` is the
  // universal read primitive, and most of its callers compare event ts against
  // ANOTHER event's ts (self-consistent, unit-agnostic). Rewriting the value for
  // everyone silently broke relative-duration renderers and the loop-digest
  // window. Only the handful of consumers that compare ts against an external
  // clock need the ms contract — they call `eventTsMs` at that comparison.
  if (typeof rec["type"] !== "string" || typeof rec["ts"] !== "number") return null;
  return obj as RollEvent;
}
