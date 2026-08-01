import type { ManagedWorkspaceSet, RollEvent } from "@roll/spec";

/** Shared allocation identity for Cycle and host-guided Delta recovery. */
export function managedWorkspaceOperationId(runId: string, phase: "allocate" | "prepare" = "allocate"): string {
  return `${runId}:${phase}`;
}

/** A recovery marker alone never authorizes role admission. */
export function hasManagedWorkspaceAllocation(
  events: readonly RollEvent[],
  workspace: ManagedWorkspaceSet,
  operationId: string,
): boolean {
  return events.some((event) => event.type === "worktree:allocated"
    && event.operationId === operationId
    && JSON.stringify(event.workspace) === JSON.stringify(workspace));
}

export function hasManagedWorkspaceRecovery(
  events: readonly RollEvent[],
  workspace: ManagedWorkspaceSet,
  operationId: string,
): boolean {
  return events.some((event) => event.type === "worktree:recovery_required"
    && event.operationId === operationId
    && event.workspace !== undefined
    && JSON.stringify(event.workspace) === JSON.stringify(workspace));
}

/**
 * One durable allocation state machine shared by Cycle's async ports and the
 * host-Delta Node adapter.  Effects remain adapter-specific; deciding whether
 * a retry may bootstrap, append allocation, or must fail closed is not.
 */
export function managedWorkspaceAllocationState(
  events: readonly RollEvent[],
  workspace: ManagedWorkspaceSet,
  operationId: string,
): "allocated" | "recovering" | "unstarted" {
  if (hasManagedWorkspaceAllocation(events, workspace, operationId)) return "allocated";
  if (hasManagedWorkspaceRecovery(events, workspace, operationId)) return "recovering";
  return "unstarted";
}
