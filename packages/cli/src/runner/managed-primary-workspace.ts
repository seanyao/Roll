/** US-LOOP-124 — transactional allocator for a managed primary workspace set. */
import {
  MANAGED_WORKSPACE_SCHEMA,
  normalizeManagedWorkspaceSet,
  type ManagedWorkspaceMember,
  type ManagedWorkspaceSet,
  type RollEvent,
} from "@roll/spec";
import { readLeases } from "@roll/core";
import { resolveIntegrationBranch, submoduleWorktreePath } from "@roll/infra";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSubmoduleWorktreeIfDeclared } from "./submodule-worktree.js";
import { eventTs } from "./runner-time.js";
import { bootstrapWorktreeDeps, bootstrapWorktreePrebuild, bootstrapWorktreeSkills, linkRollIntoWorktree, readPrebuildDistEnabled } from "./worktree-bootstrap.js";
import type { CycleContext } from "@roll/core";
import type { ExecuteResult, Ports } from "./ports.js";
import { allocationReason, allocationRecovery } from "./managed-workspace-guidance.js";

function readLifecycleEvents(path: string): RollEvent[] {
  try {
    return readFileSync(path, "utf8").split("\n").flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as RollEvent;
        return parsed.type.startsWith("worktree:") ? [parsed] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function sameWorkspace(left: ManagedWorkspaceSet, right: ManagedWorkspaceSet): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasMatchingAllocation(events: readonly RollEvent[], workspace: ManagedWorkspaceSet, operationId: string): boolean {
  return events.some((event) => event.type === "worktree:allocated"
    && event.operationId === operationId
    && sameWorkspace(event.workspace, workspace));
}

function hasMatchingRecovery(events: readonly RollEvent[], workspace: ManagedWorkspaceSet, operationId: string): boolean {
  return events.some((event) => event.type === "worktree:recovery_required"
    && event.operationId === operationId
    && event.workspace !== undefined
    && sameWorkspace(event.workspace, workspace));
}

function reservationMatches(ports: Ports, ctx: CycleContext): boolean {
  const leaseDir = join(dirname(ports.paths.eventsPath), "leases");
  // Unit ports intentionally do not materialise a lease directory.  A real
  // allocator always has one because reservation is the prior runner command.
  if (!existsSync(leaseDir)) return true;
  const entry = readLeases(leaseDir)[ctx.storyId ?? ""];
  return entry?.source === "cycle" && entry.runId === ctx.cycleId && entry.pid === process.pid;
}

async function bootstrapManagedWorkspace(ports: Ports): Promise<boolean> {
  try {
    await linkRollIntoWorktree(ports.repoCwd, ports.paths.worktreePath);
    if (!await bootstrapWorktreeSkills(ports.paths.worktreePath, ports.paths.alertsPath, ports.events, ports.git.worktreeSubmoduleInit)) return false;
    if (!await bootstrapWorktreeDeps(ports.paths.worktreePath, ports.paths.alertsPath, ports.events, ports.depsExec)) return false;
    await bootstrapWorktreePrebuild(ports.paths.worktreePath, ports.paths.alertsPath, ports.events, readPrebuildDistEnabled(ports.repoCwd), ports.depsExec);
    return true;
  } catch {
    return false;
  }
}

async function workspaceSetMatches(
  ports: Ports,
  workspace: ManagedWorkspaceSet,
  primary: ManagedWorkspaceMember,
): Promise<boolean> {
  const inspect = ports.git.managedWorktreeInspect;
  if (inspect === undefined) return true;
  const prefix = `${primary.workspaceKey}.submodules/`;
  const inspections = await Promise.all(workspace.members.map(async (member) => {
    const submodule = member.relativeLocator.startsWith(prefix)
      ? member.relativeLocator.slice(prefix.length)
      : undefined;
    const repoCwd = submodule === undefined ? ports.repoCwd : join(ports.repoCwd, submodule);
    const path = submodule === undefined ? ports.paths.worktreePath : submoduleWorktreePath(ports.paths.worktreePath, submodule);
    const observed = await inspect(repoCwd, path);
    return observed !== undefined
      && observed.registered
      && observed.clean
      && observed.repositoryId === member.repositoryId
      && observed.head === member.checkoutRef.head;
  }));
  return inspections.every(Boolean);
}

/**
 * Allocate exactly one immutable workspace identity.  No failure path removes
 * or repurposes a target: durable facts decide whether an existing checkout is
 * a retry of this operation or an operator-recovery case.
 */
export async function allocateManagedPrimaryWorkspace(
  ports: Ports,
  ctx: CycleContext,
  branch: string,
): Promise<ExecuteResult> {
  if (ctx.storyId === undefined || ctx.storyId === "") {
    ports.events.appendAlert(ports.paths.alertsPath, allocationRecovery(ctx.cycleId, allocationReason("reservation_required")));
    return { event: { type: "worktree_failed" } };
  }
  if (!reservationMatches(ports, ctx)) {
    ports.events.appendAlert(ports.paths.alertsPath, allocationRecovery(ctx.storyId, allocationReason("reservation_mismatch")));
    return { event: { type: "worktree_failed" } };
  }

  const operationId = `${ctx.cycleId}:allocate`;
  const primaryBase = resolveIntegrationBranch(ports.repoCwd);
  const primaryFacts = await ports.git.managedWorktreeFacts?.(ports.repoCwd, primaryBase);
  if (ports.git.managedWorktreeFacts !== undefined && primaryFacts === undefined) {
    ports.events.appendAlert(ports.paths.alertsPath, allocationRecovery(ctx.storyId, allocationReason("base_invalid")));
    return { event: { type: "worktree_failed" } };
  }

  const targetSubmodule = ctx.targetSubmodule;
  const subRepo = targetSubmodule === undefined || targetSubmodule === "" ? undefined : join(ports.repoCwd, targetSubmodule);
  const subBase = subRepo === undefined ? undefined : resolveIntegrationBranch(subRepo);
  const subFacts = subRepo === undefined ? undefined : await ports.git.managedWorktreeFacts?.(subRepo, subBase!);
  if (subRepo !== undefined && ports.git.managedWorktreeFacts !== undefined && subFacts === undefined) {
    ports.events.appendAlert(ports.paths.alertsPath, allocationRecovery(ctx.storyId, allocationReason("submodule_base_invalid")));
    return { event: { type: "worktree_failed" } };
  }

  // The fallback is restricted to legacy injected test ports.  Node ports always
  // supply facts; production events never carry a placeholder identity.
  const workspaceKey = `cycle-${ctx.cycleId}`;
  const primary: ManagedWorkspaceMember = {
    repositoryId: primaryFacts?.repositoryId ?? "legacy-test-port",
    workspaceKey,
    relativeLocator: workspaceKey,
    checkoutRef: { kind: "detached", head: primaryFacts?.baseSha ?? primaryBase },
    publishRef: `refs/heads/${branch}`,
  };
  const members: ManagedWorkspaceMember[] = subRepo === undefined ? [primary] : [primary, {
    repositoryId: subFacts?.repositoryId ?? "legacy-test-port",
    workspaceKey,
    relativeLocator: `${workspaceKey}.submodules/${targetSubmodule}`,
    checkoutRef: { kind: "detached", head: subFacts?.baseSha ?? subBase! },
  }];
  const workspace: ManagedWorkspaceSet = {
    schema: MANAGED_WORKSPACE_SCHEMA,
    runId: ctx.cycleId,
    storyId: ctx.storyId,
    kind: "cycle",
    // A verified/designed Cycle is the actual Full Delta runtime path. Persist
    // that topology with the allocated set instead of asking audits/tests to
    // infer it from a hand-written event literal.
    topology: ctx.selectedProfile === "verified" || ctx.selectedProfile === "designed"
      ? "full-delta-team"
      : "solo",
    members: members as [ManagedWorkspaceMember, ...ManagedWorkspaceMember[]],
  };
  if (!normalizeManagedWorkspaceSet(workspace).ok) {
    ports.events.appendAlert(ports.paths.alertsPath, allocationRecovery(ctx.storyId, allocationReason("identity_invalid")));
    return { event: { type: "worktree_failed" } };
  }

  const events = readLifecycleEvents(ports.paths.eventsPath);
  const existing = await ports.git.managedWorktreeInspect?.(ports.repoCwd, ports.paths.worktreePath);
  if (existing !== undefined) {
    const identityMatches = await workspaceSetMatches(ports, workspace, primary);
    if (!identityMatches) {
      recordRecovery(ports, ctx, primary, operationId, "existing_target_identity_mismatch", workspace);
      return { event: { type: "worktree_failed" } };
    }
    if (hasMatchingAllocation(events, workspace, operationId)) {
      return { event: { type: "worktree_created" }, ...(targetSubmodule === undefined ? {} : { ctxPatch: { targetSubmodule } }) };
    }
    if (hasMatchingRecovery(events, workspace, operationId)) {
      if (!await bootstrapManagedWorkspace(ports)) {
        recordRecovery(ports, ctx, primary, operationId, "git_created_bootstrap_incomplete", workspace);
        return { event: { type: "worktree_failed" } };
      }
      try {
        ports.events.appendEvent(ports.paths.eventsPath, { type: "worktree:allocated", workspace, operationId, ts: eventTs(ports) });
        return { event: { type: "worktree_created" }, ...(targetSubmodule === undefined ? {} : { ctxPatch: { targetSubmodule } }) };
      } catch {
        recordRecovery(ports, ctx, primary, operationId, "git_created_event_missing", workspace);
        return { event: { type: "worktree_failed" } };
      }
    }
    recordRecovery(ports, ctx, primary, operationId, "existing_target_unproven", workspace);
    return { event: { type: "worktree_failed" } };
  }
  if (hasMatchingAllocation(events, workspace, operationId)) {
    recordRecovery(ports, ctx, primary, operationId, "allocated_event_git_missing", workspace);
    return { event: { type: "worktree_failed" } };
  }

  // The operation marker is durable before the first Git effect.  A kill after
  // `worktree add` but before `allocated` therefore remains projected as a
  // reserved recovery candidate instead of being cleaned as a dead lease.
  if (!hasMatchingRecovery(events, workspace, operationId)) {
    try {
      ports.events.appendEvent(ports.paths.eventsPath, {
        type: "worktree:recovery_required", runId: ctx.cycleId, relativeLocator: primary.relativeLocator,
        reason: "allocation_started", workspace, operationId, ts: eventTs(ports),
      });
    } catch {
      ports.events.appendAlert(ports.paths.alertsPath, allocationRecovery(ctx.storyId, allocationReason("operation_write_failed")));
      return { event: { type: "worktree_failed" } };
    }
  }

  const added = await ports.git.worktreeAdd(ports.repoCwd, ports.paths.worktreePath, branch, primaryBase);
  if (added.code !== 0) {
    ports.events.appendAlert(ports.paths.alertsPath, allocationRecovery(ctx.storyId, allocationReason("git_add_failed")));
    return { event: { type: "worktree_failed" } };
  }
  const sub = await createSubmoduleWorktreeIfDeclared(ports, ctx, { id: ctx.storyId, ...(targetSubmodule === undefined ? {} : { targetSubmodule }) });
  if (sub.failed) {
    recordRecovery(ports, ctx, primary, operationId, "primary_created_submodule_failed", workspace);
    return { event: { type: "worktree_failed" } };
  }
  if (!await bootstrapManagedWorkspace(ports)) {
    recordRecovery(ports, ctx, primary, operationId, "git_created_bootstrap_failed", workspace);
    return { event: { type: "worktree_failed" } };
  }
  try {
    ports.events.appendEvent(ports.paths.eventsPath, { type: "worktree:allocated", workspace, operationId, ts: eventTs(ports) });
  } catch {
    recordRecovery(ports, ctx, primary, operationId, "git_created_event_missing", workspace);
    return { event: { type: "worktree_failed" } };
  }
  return { event: { type: "worktree_created" }, ...(sub.targetSubmodule === undefined ? {} : { ctxPatch: { targetSubmodule: sub.targetSubmodule } }) };
}

function recordRecovery(ports: Ports, ctx: CycleContext, primary: ManagedWorkspaceMember, operationId: string, reason: string, workspace?: ManagedWorkspaceSet): void {
  try {
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "worktree:recovery_required", runId: ctx.cycleId, relativeLocator: primary.relativeLocator,
      reason, ...(workspace === undefined ? {} : { workspace }), operationId, ts: eventTs(ports),
    });
  } catch { /* preserved checkout + reservation require explicit operator recovery */ }
}
