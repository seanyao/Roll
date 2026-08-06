/**
 * @responsibility Turns raw builder-exit facts into a finalization verdict.
 * FIX-1068 — Builder finalization hard gate.
 *
 * Adapter-agnostic pure logic that turns the raw worktree/branch facts captured
 * after a Builder exits into a single {@link BuilderFinalizationVerdict}. The
 * gate is the same for every Builder (Kimi, Pi, Reasonix, Codex, Claude, …) and
 * runs before peer review, scoring, attest, PR creation, cleanup, or delivery
 * recording.
 */
import type { BuilderFinalizationFacts, BuilderFinalizationVerdict } from "@roll/spec";

/**
 * Classify the Builder's final state.
 *
 * Mapping rules (from the FIX-1068 design):
 *   - main checkout dirty           → boundary_violation (fail-loud)
 *   - process still running + recent activity → no_progress_still_running (do not kill)
 *   - dirty worktree + exited                 → handoff_without_tcr
 *   - tcrCount > 0 and clean worktree         → ready_for_peer_and_attest
 *   - tcrCount === 0 + clean worktree + exited → gave_up_clean
 */
export function finalizeBuilder(facts: BuilderFinalizationFacts): BuilderFinalizationVerdict {
  if (facts.mainCheckoutDirty || (facts.mainAhead ?? 0) > 0) return "boundary_violation";
  if (!facts.processExited && facts.recentActivity) return "no_progress_still_running";
  // A committed prefix is never permission to discard a dirty suffix. Publishing
  // it would merge an incomplete Story while cleanup loses the remaining work.
  if (facts.worktreeDirty && facts.processExited) return "handoff_without_tcr";
  // FIX-1068: positive TCR count is the normal ready signal. Commits ahead with
  // no TCR prefix still represent real work that passed the existing gate, so
  // the adapter-agnostic gate lets it continue while the TCR contract remains
  // the authoritative ready signal.
  if (facts.tcrCount > 0 || facts.commitsAhead > 0) return "ready_for_peer_and_attest";
  if (facts.processExited) return "gave_up_clean";
  return "no_progress_still_running";
}

/** The recoverable handoff kind for a handoff_without_tcr verdict. */
export function handoffKindFor(verdict: BuilderFinalizationVerdict): string | undefined {
  return verdict === "handoff_without_tcr" ? "zero_tcr_dirty_worktree" : undefined;
}

/** Whether the finalization gate allows the cycle to continue to peer/attest/PR. */
export function builderFinalizationReady(verdict: BuilderFinalizationVerdict): boolean {
  return verdict === "ready_for_peer_and_attest" || verdict === "no_progress_still_running";
}
