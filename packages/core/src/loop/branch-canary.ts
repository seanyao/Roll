/**
 * @responsibility Verdicts on branch and worktree leak counts.
 * Branch-leak canary (US-LOOP-096) — pure verdict.
 *
 * After US-LOOP-094/095 the healthy steady state is ~0-1 loop worktrees and 0
 * ephemeral local branches (detached cycles create no local branch; rescue is a
 * bundle, not a branch). A climbing count means the cleanup contract broke — the
 * exact failure mode behind the 289-local-branch retro. The canary is a CIRCUIT
 * BREAKER, not just an alert: when it trips, the loop must stop starting new
 * cycles (which would only pile on more) until a human clears the PAUSE.
 *
 * This is a pure data→decision function: the caller gathers the two counts (git
 * branch list filtered by isEphemeralBranch + live loop worktree dirs) and
 * performs the PAUSE-marker write + ALERT the verdict authorizes.
 */

/** Default leak threshold (env ROLL_BRANCH_CANARY_MAX overrides). Healthy is
 *  0-1; 8 leaves generous headroom while still catching a leak long before it
 *  reaches the tens-to-hundreds the retro saw. */
export const DEFAULT_BRANCH_CANARY_MAX = 8;

export interface BranchCanaryInput {
  /** Local branches matching an ephemeral prefix (isEphemeralBranch). */
  ephemeralBranchCount: number;
  /** Live loop worktree directories. */
  worktreeCount: number;
  /** Trip threshold — `total > threshold` trips (so threshold=8 allows 8). */
  threshold: number;
  /** Whether a PAUSE marker already exists — dedupes the write + ALERT. */
  alreadyPaused: boolean;
}

export interface BranchCanaryVerdict {
  /** Sum of the two leak signals. */
  total: number;
  /** True ⇒ do NOT start a new cycle this tick (circuit open). */
  tripped: boolean;
  /** True ⇒ write the PAUSE marker + ALERT now (tripped AND not already paused). */
  shouldPause: boolean;
}

/** Decide the canary verdict from the gathered counts. */
export function branchCanaryVerdict(input: BranchCanaryInput): BranchCanaryVerdict {
  const total = input.ephemeralBranchCount + input.worktreeCount;
  const tripped = total > input.threshold;
  return { total, tripped, shouldPause: tripped && !input.alreadyPaused };
}
