/**
 * @responsibility Declares the builder finalization hard-gate types.
 */
/**
 * FIX-1068 — Builder finalization hard gate.
 *
 * These types formalize the adapter-agnostic contract that runs after every
 * Builder subprocess exits and before peer review, scoring, attest, PR creation,
 * cleanup, or delivery recording. The gate turns the raw worktree/branch facts
 * into a single verdict so the runner can fail-loud on boundary violations,
 * preserve recoverable handoff work, and avoid killing active builders that are
 * still making progress.
 */

export interface BuilderFinalizationFacts {
  storyId: string;
  cycleId: string;
  agent: string;
  worktreePath: string;
  expectedProjectPath: string;
  processExited: boolean;
  exitCode: number | null;
  commitsAhead: number;
  tcrCount: number;
  worktreeDirty: boolean;
  mainCheckoutDirty: boolean;
  /** Local main commits ahead of origin/main; nonzero means work escaped the cycle worktree. */
  mainAhead?: number;
  prUrl: string | null;
  attestReportPath: string | null;
  recentActivity: boolean;
}

export type BuilderFinalizationVerdict =
  | "ready_for_peer_and_attest"
  | "handoff_without_tcr"
  | "boundary_violation"
  | "no_progress_still_running"
  | "gave_up_clean";
