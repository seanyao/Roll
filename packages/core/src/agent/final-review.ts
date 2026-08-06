/**
 * @responsibility Selects the final goal reviewer through the shared ranked peer-review primitive.
 */
import type { GoalReviewMode } from "@roll/spec";
import { selectPeerReviewers } from "./peer-review.js";

export type EffectiveGoalReviewMode = "hetero" | "self";

export type GoalFinalReviewerSelection =
  | {
      status: "selected";
      effectiveMode: EffectiveGoalReviewMode;
      reviewer: string;
      provider: string;
      degraded: boolean;
      reason?: string;
    }
  | { status: "unavailable"; reason: "no_installed_reviewer" | "no_heterogeneous_reviewer" };

export interface GoalFinalReviewerInput {
  mode: Exclude<GoalReviewMode, "off">;
  installedAgents: readonly string[];
  workerAgents: readonly string[];
}

/**
 * FIX-336 — goal final review now routes through the same ranked primitive as
 * `roll peer`. This wrapper preserves the old single-reviewer return shape for
 * callers that only need the head candidate; rotation itself happens at spawn time.
 */
export function selectGoalFinalReviewer(input: GoalFinalReviewerInput): GoalFinalReviewerSelection {
  const selected = selectPeerReviewers({
    mode: input.mode,
    candidates: input.installedAgents,
    workerAgents: input.workerAgents,
  });
  if (selected.status === "unavailable") {
    if (selected.reason === "no_heterogeneous_reviewer") return { status: "unavailable", reason: "no_heterogeneous_reviewer" };
    return { status: "unavailable", reason: "no_installed_reviewer" };
  }
  const first = selected.reviewers[0];
  if (first === undefined) return { status: "unavailable", reason: "no_installed_reviewer" };
  return { status: "selected", ...first };
}
