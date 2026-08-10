/**
 * @responsibility Composes the one honest Supervisor presentation model for delivery runs.
 * US-LOOP-128 — one honest Supervisor presentation model for DeliveryRuns.
 *
 * The board deliberately composes the managed-workspace and Delta projections
 * with delivery/attest facts.  It is the only place presentation consumers
 * need to join those dimensions; CLI renderers must not parse ledgers again.
 */
import type { DeliveryRunKind, RollEvent } from "@roll/spec";
import { projectDelegationStatus, type DelegationStatus } from "../delta-team/projection.js";
import { projectDeliveryRunTruth } from "../delivery/state.js";
import { managedWorkspaceReleaseVerdict, projectManagedWorkspaceRuns, type ManagedWorkspaceMemberInspection, type ManagedWorkspaceRunState } from "../loop/managed-workspace.js";

export type SupervisorDeliveryRunKind = DeliveryRunKind | "full_delta" | "manual" | "external";
export type BoardTruth = "merged" | "unmerged" | "unknown";
export type BoardEvidenceTruth = "accepted" | "missing" | "unknown";

export interface SupervisorDeliveryRunRow {
  readonly runId: string;
  readonly kind: SupervisorDeliveryRunKind;
  readonly storyId: string;
  readonly topology: string | null;
  readonly workspaceMembers: readonly string[];
  readonly reservationState: ManagedWorkspaceRunState;
  readonly deltaStatus: DelegationStatus | null;
  readonly merge: BoardTruth;
  readonly evidence: BoardEvidenceTruth;
  readonly lifecycle: "active" | "handoff_ready" | "delivered_safe_to_release" | "released" | "legacy" | "recovery_required" | "unknown";
  readonly recoveryReason: string;
}

export interface SupervisorDeliveryRunBoard {
  readonly schema: "supervisor-delivery-runs.v1";
  readonly rows: readonly SupervisorDeliveryRunRow[];
}

/** Read-only facts from the shared worktree inspection adapter. */
export interface SupervisorWorkspaceInspection extends ManagedWorkspaceMemberInspection {
  readonly runId?: string;
  readonly owner: "loop" | "manual" | "external";
  readonly storyId?: string;
}

export interface SupervisorDeliveryRunBoardOptions {
  /** Wall clock is injected by the presentation boundary so stale is real in production and deterministic in tests. */
  readonly now?: number;
  readonly staleAfterMs?: number;
  /** Concrete audit facts; missing facts deliberately keep release truth unknown. */
  readonly inspections?: readonly SupervisorWorkspaceInspection[];
}

interface DelegationFact {
  readonly delegationId: string;
  readonly topology: string;
}

function delegationFacts(events: readonly RollEvent[]): ReadonlyMap<string, DelegationFact> {
  const byRun = new Map<string, DelegationFact>();
  for (const event of events) {
    if (event.type === "delta:prepared") byRun.set(event.runId, { delegationId: event.delegationId, topology: event.topology });
  }
  return byRun;
}

function lifecycleFor(state: ManagedWorkspaceRunState, releaseVerdict: string): SupervisorDeliveryRunRow["lifecycle"] {
  if (state === "handoff_ready") return "handoff_ready";
  // Safety is an eligibility before teardown. Once released, the honest state
  // remains released even if the preceding decision was safe.
  if (state === "released") return "released";
  if (releaseVerdict === "safe_to_release") return "delivered_safe_to_release";
  if (state === "legacy_cycle") return "legacy";
  if (state === "recovery_required" || state === "stale") return "recovery_required";
  if (state === "active" || state === "active_unstarted" || state === "release_requested") return "active";
  return "unknown";
}

function recoveryReason(
  state: ManagedWorkspaceRunState,
  deltaStatus: DelegationStatus | null,
  merge: BoardTruth,
  evidence: BoardEvidenceTruth,
  releaseVerdict: string,
  storedReason: string | undefined,
): string {
  if (storedReason !== undefined) return storedReason;
  if (deltaStatus === "blocked") return "delta protocol blocked; inspect its recorded block reason";
  if (state === "handoff_ready") return "owner delivery required; handoff is not a merge or attest verdict";
  if (state === "active_unstarted") return "managed workspace reserved; awaiting first activity";
  if (state === "stale") return "managed workspace activity is stale; inspect registration before recovery";
  if (state === "legacy_cycle") return "legacy protocol only; managed workspace facts are unavailable";
  if (state === "unknown") return "managed workspace facts are unavailable";
  if (merge !== "merged") return "delivery merge truth is not confirmed";
  if (evidence !== "accepted") return "acceptance evidence truth is not confirmed";
  if (releaseVerdict === "safe_to_release") return "managed workspace is safe to release after owner confirmation";
  if (state === "release_requested") return "release requested; await the managed release result";
  return "no recovery action recorded";
}

/**
 * Build the complete board only from shared read models and explicit ledger
 * facts.  Missing historical fields remain unknown; this function never infers
 * a workspace, merge, or acceptance result from a similarly named story.
 */
export function buildSupervisorDeliveryRunBoard(events: readonly RollEvent[], options: SupervisorDeliveryRunBoardOptions = {}): SupervisorDeliveryRunBoard {
  const byRun = delegationFacts(events);
  const inspectionsByRun = new Map<string, ManagedWorkspaceMemberInspection[]>();
  for (const inspection of options.inspections ?? []) {
    if (inspection.runId === undefined) continue;
    const members = inspectionsByRun.get(inspection.runId) ?? [];
    members.push(inspection);
    inspectionsByRun.set(inspection.runId, members);
  }
  const rows = projectManagedWorkspaceRuns(events, { now: options.now, staleAfterMs: options.staleAfterMs }).map((run) => {
    const delegation = byRun.get(run.runId);
    const delta = delegation === undefined ? null : projectDelegationStatus(delegation.delegationId, events);
    const sharedTruth = projectDeliveryRunTruth(events, run.runId);
    const mergedByDeltaClosure = events.some((event) => event.type === "delta:reservation_closed" && event.runId === run.runId && event.delegationId === delegation?.delegationId && event.reason === "merged");
    const merge: BoardTruth = mergedByDeltaClosure ? "merged" : sharedTruth.merge;
    const evidence: BoardEvidenceTruth = sharedTruth.evidence;
    const members = inspectionsByRun.get(run.runId) ?? [];
    const releaseVerdict = managedWorkspaceReleaseVerdict({
      runState: run.state,
      delivery: merge,
      attest: evidence,
      factsAgree: sharedTruth.factsAgree,
      members,
    }).verdict;
    const deltaStatus = delta?.status ?? null;
    return {
      runId: run.runId,
      kind: delegation?.topology === "full-delta-team" ? "full_delta" : run.kind,
      storyId: run.storyId,
      topology: delegation?.topology ?? run.workspace?.topology ?? null,
      workspaceMembers: run.workspace?.members.map((member) => member.relativeLocator) ?? [],
      reservationState: run.state,
      deltaStatus,
      merge,
      evidence,
      lifecycle: lifecycleFor(run.state, releaseVerdict),
      recoveryReason: recoveryReason(run.state, deltaStatus, merge, evidence, releaseVerdict, run.recoveryReason),
    } satisfies SupervisorDeliveryRunRow;
  });
  const unmanagedRows = (options.inspections ?? [])
    .filter((inspection) => inspection.runId === undefined && (inspection.owner === "manual" || inspection.owner === "external"))
    .map((inspection) => ({
      runId: `${inspection.owner}:${inspection.relativeLocator}`,
      kind: inspection.owner === "manual" ? "manual" : "external",
      storyId: inspection.storyId ?? "unknown",
      topology: null,
      workspaceMembers: [inspection.relativeLocator],
      reservationState: "unknown" as const,
      deltaStatus: null,
      merge: "unknown" as const,
      evidence: "unknown" as const,
      lifecycle: "unknown" as const,
      recoveryReason: inspection.owner === "external" ? "external workspace is unmanaged; inspect manually" : "manual workspace is outside DeliveryRun protocol; inspect manually",
    } satisfies SupervisorDeliveryRunRow));
  return { schema: "supervisor-delivery-runs.v1", rows: [...rows, ...unmanagedRows].sort((left, right) => left.runId.localeCompare(right.runId)) };
}
