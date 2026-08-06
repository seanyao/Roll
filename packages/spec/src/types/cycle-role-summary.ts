/**
 * @responsibility Declares the CycleRoleSummary projection types.
 */
/**
 * CycleRoleSummary — typed projection types for US-OBS-032.
 *
 * A CycleRoleSummary translates low-level RollEvent facts into a readable
 * role chain per cycle: Builder, Peer Reviewer, Evaluator, and Attest Gate.
 */
export type CycleRoleName =
  | "designer"
  | "builder"
  | "peer_reviewer"
  | "evaluator"
  | "attest_gate";

export type CycleRoleAttemptState =
  | "selected"
  | "started"
  | "returned"
  | "parsed"
  | "accepted"
  | "rejected"
  | "failed"
  // FIX-1054: a candidate NOT spawned because the serial cost-aware dispatch
  // already accepted a reviewer/evaluator — a POLICY decision, not a zero-cost
  // attempted peer. Makes skipped candidates visible AS skipped in cost/cycle views.
  | "skipped"
  | "not_required"
  | "not_available";

export interface CycleRoleAttempt {
  readonly role: CycleRoleName;
  readonly agent: string | null;
  readonly model?: string;
  readonly sessionId?: string;
  readonly stage?: "review" | "score" | "design" | "attest" | "build";
  readonly state: CycleRoleAttemptState;
  readonly verdict?: string;
  readonly score?: number;
  readonly findings?: number;
  readonly cause?: string;
  readonly detail?: string;
  readonly artifactPath?: string;
  readonly logPath?: string;
  readonly acceptedByGate: boolean;
  readonly ts: number;
}

export interface CycleRoleSummary {
  readonly schema: "cycle-role-summary.v1";
  readonly cycleId: string;
  readonly storyId: string;
  readonly executionProfile: "standard" | "verified" | "designed";
  readonly generatedAt: string;
  readonly builderSessionId?: string;
  readonly roles: readonly CycleRoleAttempt[];
  readonly gates: {
    readonly peerGate?: string;
    readonly attestGate?: string;
    readonly delivery?: string;
  };
  readonly sources: readonly string[];
}
