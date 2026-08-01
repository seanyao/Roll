/**
 * US-LOOP-122 — pure Execution projection and conservative release selector.
 *
 * This module folds only workspace lifecycle facts. Delivery merge and attest
 * facts are explicit selector inputs; neither is persisted in a DeliveryRun.
 */
import {
  normalizeManagedWorkspaceSet,
  type DeliveryRunKind,
  type ManagedWorkspaceReleaseVerdict,
  type ManagedWorkspaceSet,
  type RollEvent,
} from "@roll/spec";

export type ManagedWorkspaceRunState =
  | "legacy_cycle"
  | "active_unstarted"
  | "active"
  | "handoff_ready"
  | "stale"
  | "release_requested"
  | "released"
  | "recovery_required"
  | "unknown";

export interface ManagedWorkspaceRunView {
  readonly runId: string;
  readonly storyId: string;
  readonly kind: DeliveryRunKind;
  readonly state: ManagedWorkspaceRunState;
  readonly workspace?: ManagedWorkspaceSet;
  readonly lastActivityAt?: number;
  readonly activitySource?: "runner" | "host_attested";
  readonly releaseOperationId?: string;
  readonly allocationOperationId?: string;
  readonly recoveryReason?: string;
}

export interface ManagedWorkspaceProjectionOptions {
  /** Epoch milliseconds in the caller's clock; omit to avoid time-based aging. */
  readonly now?: number;
  readonly staleAfterMs?: number;
}

interface MutableRun {
  runId: string;
  storyId: string;
  kind: DeliveryRunKind;
  state: ManagedWorkspaceRunState;
  workspace?: ManagedWorkspaceSet;
  lastActivityAt?: number;
  activitySource?: "runner" | "host_attested";
  releaseOperationId?: string;
  allocationOperationId?: string;
  recoveryReason?: string;
}

function asView(run: MutableRun): ManagedWorkspaceRunView {
  return {
    runId: run.runId,
    storyId: run.storyId,
    kind: run.kind,
    state: run.state,
    ...(run.workspace === undefined ? {} : { workspace: run.workspace }),
    ...(run.lastActivityAt === undefined ? {} : { lastActivityAt: run.lastActivityAt }),
    ...(run.activitySource === undefined ? {} : { activitySource: run.activitySource }),
    ...(run.releaseOperationId === undefined ? {} : { releaseOperationId: run.releaseOperationId }),
    ...(run.allocationOperationId === undefined ? {} : { allocationOperationId: run.allocationOperationId }),
    ...(run.recoveryReason === undefined ? {} : { recoveryReason: run.recoveryReason }),
  };
}

function ensureLegacyCycle(runs: Map<string, MutableRun>, event: Extract<RollEvent, { type: "cycle:start" }>): MutableRun {
  const existing = runs.get(event.cycleId);
  if (existing !== undefined) return existing;
  const run: MutableRun = {
    runId: event.cycleId,
    storyId: event.storyId,
    kind: "cycle",
    state: "legacy_cycle",
  };
  runs.set(run.runId, run);
  return run;
}

function ensureLegacyDelta(runs: Map<string, MutableRun>, event: Extract<RollEvent, { type: "delta:prepared" }>): MutableRun {
  const existing = runs.get(event.runId);
  if (existing !== undefined) return existing;
  const run: MutableRun = {
    runId: event.runId,
    storyId: event.storyId,
    kind: event.cycleId === undefined ? "host_delta" : "cycle",
    state: "unknown",
  };
  runs.set(run.runId, run);
  return run;
}

function workspaceRun(runs: Map<string, MutableRun>, workspace: ManagedWorkspaceSet, operationId?: string): MutableRun {
  const existing = runs.get(workspace.runId);
  if (existing === undefined) {
    const run: MutableRun = {
      runId: workspace.runId,
      storyId: workspace.storyId,
      kind: workspace.kind,
      state: "active_unstarted",
      workspace,
      ...(operationId === undefined ? {} : { allocationOperationId: operationId }),
    };
    runs.set(run.runId, run);
    return run;
  }
  if (existing.workspace !== undefined && (existing.allocationOperationId !== operationId || operationId === undefined)) {
    existing.state = "recovery_required";
    existing.recoveryReason = "duplicate_allocation";
    return existing;
  }
  existing.storyId = workspace.storyId;
  existing.kind = workspace.kind;
  existing.workspace = workspace;
  existing.allocationOperationId = operationId;
  existing.state = "active_unstarted";
  return existing;
}

/**
 * Fold the append-only ledger into one deterministic view per run. Historical
 * cycle and Delta records are retained as legacy/unknown views, never upgraded
 * with guessed workspace ownership.
 */
export function projectManagedWorkspaceRuns(
  events: readonly RollEvent[],
  options: ManagedWorkspaceProjectionOptions = {},
): readonly ManagedWorkspaceRunView[] {
  const runs = new Map<string, MutableRun>();
  const delegationToRun = new Map<string, string>();
  for (const event of events) {
    switch (event.type) {
      case "cycle:start":
        ensureLegacyCycle(runs, event);
        break;
      case "delta:prepared": {
        const run = ensureLegacyDelta(runs, event);
        delegationToRun.set(event.delegationId, run.runId);
        break;
      }
      case "worktree:allocated": {
        const normalized = normalizeManagedWorkspaceSet(event.workspace);
        if (normalized.ok) {
          const run = workspaceRun(runs, normalized.value, event.operationId);
          if (normalized.value.delegationId !== undefined) delegationToRun.set(normalized.value.delegationId, run.runId);
        }
        break;
      }
      case "worktree:activity_observed": {
        const run = runs.get(event.runId);
        if (run !== undefined && run.state !== "released" && run.state !== "recovery_required") {
          run.lastActivityAt = event.ts;
          run.activitySource = event.source;
          run.state = "active";
        }
        break;
      }
      case "worktree:release_requested": {
        const run = runs.get(event.runId);
        // Builder admission freezes heads but does not authorize teardown.
        if (event.reason !== "builder_validation" && run !== undefined && run.workspace !== undefined && run.state !== "released" && run.state !== "recovery_required") {
          run.state = "release_requested";
          run.releaseOperationId = event.operationId;
        }
        break;
      }
      case "worktree:released": {
        const run = runs.get(event.runId);
        if (run !== undefined && run.releaseOperationId === event.operationId && run.state === "release_requested") run.state = "released";
        break;
      }
      case "worktree:recovery_required": {
        const run = runs.get(event.runId);
        if (run !== undefined) {
          run.state = "recovery_required";
          run.recoveryReason = event.reason;
        } else if (event.workspace !== undefined) {
          const normalized = normalizeManagedWorkspaceSet(event.workspace);
          if (normalized.ok && normalized.value.runId === event.runId) {
            const recovered = workspaceRun(runs, normalized.value, event.operationId);
            recovered.state = "recovery_required";
            recovered.recoveryReason = event.reason;
          }
        }
        break;
      }
      case "delta:terminal": {
        if (event.outcome !== "handoff_ready") break;
        const runId = delegationToRun.get(event.delegationId);
        const run = runId === undefined ? undefined : runs.get(runId);
        if (run !== undefined && run.workspace !== undefined && run.state !== "released" && run.state !== "recovery_required") run.state = "handoff_ready";
        break;
      }
      default:
        break;
    }
  }

  const staleAfterMs = options.staleAfterMs ?? 0;
  if (options.now !== undefined && staleAfterMs > 0) {
    for (const run of runs.values()) {
      if (run.state === "active" && run.lastActivityAt !== undefined && options.now - run.lastActivityAt >= staleAfterMs) run.state = "stale";
    }
  }
  return [...runs.values()].map(asView).sort((left, right) => left.runId.localeCompare(right.runId));
}

/** Selector convenience for read surfaces that request one run. */
export function projectManagedWorkspaceRun(
  runId: string,
  events: readonly RollEvent[],
  options: ManagedWorkspaceProjectionOptions = {},
): ManagedWorkspaceRunView | undefined {
  return projectManagedWorkspaceRuns(events, options).find((run) => run.runId === runId);
}

export type { ManagedWorkspaceReleaseVerdict } from "@roll/spec";

export interface ManagedWorkspaceMemberInspection {
  readonly relativeLocator: string;
  readonly registration: "registered" | "missing" | "unknown" | "foreign";
  readonly activity: "inactive" | "active" | "unknown";
  readonly head: "expected" | "mismatch" | "unknown";
  readonly cleanliness: "clean" | "dirty" | "unknown";
}

export interface ManagedWorkspaceReleaseInput {
  readonly runState: ManagedWorkspaceRunState;
  /** Delivery-owned merge fact. */
  readonly delivery: "merged" | "unmerged" | "unknown";
  /** Evidence-owned acceptance fact. */
  readonly attest: "accepted" | "missing" | "unknown";
  /** False only when authoritative delivery/evidence facts disagree. */
  readonly factsAgree: boolean;
  readonly members: readonly ManagedWorkspaceMemberInspection[];
}

export interface ManagedWorkspaceReleaseDecision {
  readonly verdict: ManagedWorkspaceReleaseVerdict;
}

/**
 * Conservative, pure cleanup eligibility. The six literal verdicts are closed:
 * callers may only destructively release after `safe_to_release`.
 */
export function managedWorkspaceReleaseVerdict(input: ManagedWorkspaceReleaseInput): ManagedWorkspaceReleaseDecision {
  if (!input.factsAgree) return { verdict: "preserve_truth_disagreement" };
  if (input.runState === "active_unstarted" || input.runState === "active") return { verdict: "preserve_active" };
  if (input.runState === "legacy_cycle" || input.runState === "stale" || input.runState === "recovery_required" || input.runState === "unknown" || input.runState === "released") {
    return { verdict: "preserve_unknown" };
  }
  if (input.delivery === "unknown" || input.attest === "unknown" || input.members.length === 0) return { verdict: "preserve_unknown" };
  if (input.delivery !== "merged") return { verdict: "preserve_unmerged" };
  if (input.attest !== "accepted") return { verdict: "preserve_pending_evidence" };
  for (const member of input.members) {
    if (member.registration !== "registered" || member.activity === "unknown" || member.head === "unknown" || member.cleanliness === "unknown") return { verdict: "preserve_unknown" };
    if (member.activity !== "inactive") return { verdict: "preserve_active" };
    if (member.head !== "expected" || member.cleanliness !== "clean") return { verdict: "preserve_unknown" };
  }
  return { verdict: "safe_to_release" };
}
