import type { ContextStage } from "@roll/spec";
import type { ContextRevisionDecisionV1 } from "./revision-comparator.js";
import type { ContextSnapshotReferenceV1 } from "./snapshot.js";

export const CONTEXT_STAGE_HANDOFF_V1 = "roll.context-stage-handoff/v1" as const;

export interface ContextStageHandoffV1 {
  readonly schema: typeof CONTEXT_STAGE_HANDOFF_V1;
  readonly workspaceId: string;
  readonly storyId?: string;
  readonly snapshot: ContextSnapshotReferenceV1;
}

/** Durable input carried from one execution stage to the next. */
export interface ContextCycleStageStateV1 {
  readonly refs: readonly string[];
  readonly environmentIds?: readonly string[];
  readonly readMode?: "handoff_snapshot" | "fresh";
  readonly handoff?: ContextStageHandoffV1;
  readonly revisionDecision?: ContextRevisionDecisionV1;
  readonly includeNonActive?: boolean;
  readonly allowRestrictedReferences?: boolean;
  readonly sourceStage?: ContextStage;
}

/** Advance the durable stage state after a successful read. A revision
 * decision authorizes exactly one comparison and is never carried forward. */
export function advanceContextCycleStageState(
  current: ContextCycleStageStateV1 | undefined,
  handoff: ContextStageHandoffV1,
  sourceStage: ContextStage,
): ContextCycleStageStateV1 {
  const { revisionDecision: _consumedDecision, ...carried } = current ?? { refs: [] };
  return {
    ...carried,
    readMode: "handoff_snapshot",
    handoff,
    sourceStage,
  };
}
