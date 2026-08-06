/**
 * @responsibility Allocates managed workspaces through the common boundary.
 */
/**
 * Common managed-workspace allocation boundary.
 *
 * Callers request a durable WorkspaceSet through this module; they never
 * invent checkout roots, repository identities, or recovery facts.
 */
import type { ManagedWorkspaceSet } from "@roll/spec";
import { managedWorkspaceAllocationState } from "../lib/managed-workspace-operation.js";
import type { RollEvent } from "@roll/spec";
import {
  allocateManagedWorkspaceWithNodePort,
  planHostManagedWorkspace,
} from "../lib/managed-workspace-node-allocator.js";

export interface HostManagedWorkspacePlanRequest {
  projectPath: string;
  storyId: string;
  topology: ManagedWorkspaceSet["topology"];
  delegationId: string;
  runId: string;
  /** Immutable story input selected before any lease or checkout effect. */
  targetSubmodule?: string;
}

export interface HostManagedWorkspaceAllocationRequest {
  projectPath: string;
  eventsPath: string;
  workspace: ManagedWorkspaceSet;
  operationId: string;
}

/**
 * Caller-neutral effects for the one durable allocation transaction.  The
 * runner and the host CLI deliberately provide different transports, but they
 * cannot choose a different recovery transition: recovery marker → materialise
 * every recorded member → bootstrap → allocated fact.
 */
export interface ManagedWorkspaceAllocationEffects {
  readonly events: () => readonly RollEvent[];
  readonly recordRecovery: () => void | Promise<void>;
  /** `unverified` is only for historical injected ports; real recovery never
   * treats an unverified member as a recoverable checkout. */
  readonly inspect: () => "present" | "absent" | "unverified" | Promise<"present" | "absent" | "unverified">;
  readonly materialize: () => void | Promise<void>;
  readonly bootstrap: () => void | Promise<void>;
  readonly appendAllocated: () => void | Promise<void>;
}

export class ManagedWorkspaceAllocationTransactionError extends Error {}

/**
 * The sole state transition for all managed workspace allocation callers.
 * In particular, a recovery fact never permits recreating a missing checkout:
 * such a mismatch stays fail-loud for explicit operator recovery.
 */
export async function reconcileManagedWorkspaceAllocation(
  workspace: ManagedWorkspaceSet,
  operationId: string,
  effects: ManagedWorkspaceAllocationEffects,
): Promise<"allocated" | "recovered"> {
  const state = managedWorkspaceAllocationState(effects.events(), workspace, operationId);
  const inspected = await effects.inspect();
  if (state === "allocated") {
    if (inspected !== "present") throw new ManagedWorkspaceAllocationTransactionError("allocated_event_git_missing");
    return "allocated";
  }
  if (state === "recovering") {
    if (inspected !== "present") throw new ManagedWorkspaceAllocationTransactionError("recovery_checkout_missing");
    await effects.bootstrap();
    await effects.appendAllocated();
    return "recovered";
  }
  await effects.recordRecovery();
  await effects.materialize();
  if (await effects.inspect() === "absent") throw new ManagedWorkspaceAllocationTransactionError("allocation_identity_invalid");
  await effects.bootstrap();
  await effects.appendAllocated();
  return "recovered";
}

/**
 * Produce an immutable, portable WorkspaceSet before any Git effect.  The
 * Host branch delegates its Node facts to the same runner boundary instead of
 * letting delta protocol code inspect repositories itself.
 */
export async function planManagedPrimaryWorkspace(
  request: HostManagedWorkspacePlanRequest,
): Promise<ManagedWorkspaceSet> {
  return planHostManagedWorkspace(
    request.projectPath,
    { storyId: request.storyId, topology: request.topology },
    request.delegationId,
    request.runId,
    request.targetSubmodule,
  );
}

/** Host allocation uses the identical durable operation/recovery vocabulary. */
export async function allocateManagedWorkspaceSet(
  request: HostManagedWorkspaceAllocationRequest,
): Promise<void> {
  await allocateManagedWorkspaceWithNodePort(
    request.projectPath,
    request.eventsPath,
    request.workspace,
    request.operationId,
  );
}
