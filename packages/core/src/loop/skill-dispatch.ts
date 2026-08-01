/**
 * US-LOOP-127 — the parent-owned contract for parallel Skill dispatch.
 *
 * A dispatch child is deliberately not a second DeliveryRun.  The shared
 * managed-workspace schema continues to describe the parent's primary
 * checkout; child records bind detached action checkouts to that one run.
 */
import {
  isManagedWorkspaceLocator,
  normalizeManagedWorkspaceSet,
  type ManagedWorkspaceSet,
} from "@roll/spec";

export interface SkillDispatchReservation {
  readonly storyId: string;
  readonly runId: string;
}

export interface SkillDispatchParent {
  /** The one durable Story reservation held for the entire dispatch. */
  readonly reservation: SkillDispatchReservation;
  /** The allocator-backed parent checkout, never a child-selected path. */
  readonly workspace: ManagedWorkspaceSet;
}

export interface SkillDispatchActionInput {
  readonly actionId: string;
  /** Every action must explicitly disclose a non-empty write scope. */
  readonly declaredFileScope: readonly string[];
}

export interface SkillDispatchChild {
  readonly actionId: string;
  /** Canonical-root-relative locator allocated from the parent's run identity. */
  readonly relativeLocator: string;
  readonly declaredFileScope: readonly string[];
}

export interface SkillDispatchPlan {
  readonly parent: SkillDispatchParent;
  readonly children: readonly SkillDispatchChild[];
}

export type SkillDispatchRefusal =
  | "parent_reservation_missing"
  | "invalid_parent_workspace"
  | "invalid_action_id"
  | "duplicate_action_id"
  | "unknown_file_scope"
  | "invalid_file_scope"
  | "overlapping_file_scope";

export type SkillDispatchPlanResult =
  | { readonly ok: true; readonly value: SkillDispatchPlan }
  | { readonly ok: false; readonly reason: SkillDispatchRefusal };

export type SkillDispatchOperation = "publish_pr" | "attest" | "close_story" | "release_reservation";
export type SkillDispatchActor = "parent" | "child";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function actionIdValid(value: unknown): value is string {
  return nonEmpty(value) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== "..";
}

function scopeValid(scope: readonly string[]): boolean {
  return scope.length > 0 && scope.every((path) => isManagedWorkspaceLocator(path) && !path.includes(".submodules/"));
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

/**
 * Derive a plan before a child receives any checkout.  It intentionally does
 * not repair input: ambiguous scope spelling or missing disclosure is a loud
 * refusal, preserving the single Story reservation.
 */
export function createSkillDispatchPlan(
  parent: SkillDispatchParent,
  actions: readonly SkillDispatchActionInput[],
): SkillDispatchPlanResult {
  const normalizedParent = normalizeManagedWorkspaceSet(parent.workspace);
  if (!normalizedParent.ok || normalizedParent.value.kind !== "skill_dispatch") return { ok: false, reason: "invalid_parent_workspace" };
  if (parent.reservation.storyId !== normalizedParent.value.storyId || parent.reservation.runId !== normalizedParent.value.runId) {
    return { ok: false, reason: "parent_reservation_missing" };
  }
  if (actions.length === 0) return { ok: false, reason: "unknown_file_scope" };

  const ids = new Set<string>();
  const children: SkillDispatchChild[] = [];
  for (const action of actions) {
    if (!actionIdValid(action.actionId)) return { ok: false, reason: "invalid_action_id" };
    if (ids.has(action.actionId)) return { ok: false, reason: "duplicate_action_id" };
    ids.add(action.actionId);
    if (action.declaredFileScope.length === 0) return { ok: false, reason: "unknown_file_scope" };
    if (!scopeValid(action.declaredFileScope)) return { ok: false, reason: "invalid_file_scope" };
    const normalizedScope = [...new Set(action.declaredFileScope)].sort();
    if (normalizedScope.length !== action.declaredFileScope.length) return { ok: false, reason: "invalid_file_scope" };
    if (children.some((child) => overlaps(child.declaredFileScope, normalizedScope))) return { ok: false, reason: "overlapping_file_scope" };
    children.push({
      actionId: action.actionId,
      relativeLocator: `${normalizedParent.value.members[0].workspaceKey}.children/${action.actionId}`,
      declaredFileScope: normalizedScope,
    });
  }
  return { ok: true, value: { parent: { ...parent, workspace: normalizedParent.value }, children } };
}

/** The parent aggregates child commits/artifacts and is the sole delivery actor. */
export function skillDispatchAuthority(
  actor: SkillDispatchActor,
  _operation: SkillDispatchOperation,
): { readonly ok: true } | { readonly ok: false; readonly reason: "parent_required" } {
  return actor === "parent" ? { ok: true } : { ok: false, reason: "parent_required" };
}
