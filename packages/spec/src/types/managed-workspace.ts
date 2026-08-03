/**
 * US-LOOP-122 — portable, event-backed workspace facts.
 *
 * These values deliberately identify a workspace by a canonical-root-relative
 * locator. Callers derive an absolute path at the infrastructure boundary; an
 * Execution event must never persist one.
 */
import { DELIVERY_TOPOLOGIES, type DeliveryTopology } from "./delta-team.js";

export const DELIVERY_RUN_KINDS = ["cycle", "host_delta", "skill_dispatch"] as const;
export type DeliveryRunKind = (typeof DELIVERY_RUN_KINDS)[number];
export const MANAGED_WORKSPACE_SCHEMA = 1 as const;
export type ManagedWorkspaceSchema = typeof MANAGED_WORKSPACE_SCHEMA;

/** A canonical-root-relative member name, validated by the boundary helper. */
export type ManagedWorkspaceMemberLocator = string;

export type ManagedWorkspaceCheckoutRef = {
  readonly kind: "detached";
  readonly head: string;
};

export interface ManagedWorkspaceMember {
  /** Remote/project identity; never an absolute checkout path. */
  readonly repositoryId: string;
  /** The direct-child key of the primary workspace for this set. */
  readonly workspaceKey: string;
  /**
   * Primary: key. Submodule: `${key}.submodules/<repository-relative path>`.
   * A Skill-dispatch child: `${key}.children/<actionId>`.
   */
  readonly relativeLocator: ManagedWorkspaceMemberLocator;
  /** Present only for a parent skill-dispatch child member. */
  readonly actionId?: string;
  /** Repository-relative and pairwise-disjoint for dispatch children. */
  readonly declaredFileScope?: readonly string[];
  readonly checkoutRef: ManagedWorkspaceCheckoutRef;
  /** A publication target, never a checked-out delivery branch. */
  readonly publishRef?: string;
}

export interface ManagedWorkspaceSet {
  readonly schema: ManagedWorkspaceSchema;
  readonly runId: string;
  readonly storyId: string;
  readonly kind: DeliveryRunKind;
  readonly topology: DeliveryTopology;
  readonly delegationId?: string;
  readonly members: readonly [ManagedWorkspaceMember, ...ManagedWorkspaceMember[]];
}

export type ManagedWorkspaceValidationError =
  | "invalid_workspace_set"
  | "invalid_workspace_key"
  | "invalid_relative_locator"
  | "invalid_primary_locator"
  | "invalid_submodule_locator"
  | "duplicate_locator"
  | "invalid_member"
  | "invalid_declared_scope"
  | "overlapping_declared_scope";

export type ManagedWorkspaceNormalization =
  | { readonly ok: true; readonly value: ManagedWorkspaceSet }
  | { readonly ok: false; readonly reason: ManagedWorkspaceValidationError };

/** The only cleanup outcomes; no delivery verdict is stored in Execution. */
export type ManagedWorkspaceReleaseVerdict =
  | "safe_to_release"
  | "preserve_active"
  | "preserve_unmerged"
  | "preserve_pending_evidence"
  | "preserve_truth_disagreement"
  | "preserve_unknown";

/** Lifecycle facts appended to the shared Roll event ledger. */
export type WorktreeLifecycleEvent =
  /** operationId binds a crash-retry to this exact allocation attempt. Legacy
   * records omit it and remain read-compatible. */
  | { readonly type: "worktree:allocated"; readonly workspace: ManagedWorkspaceSet; readonly operationId?: string; readonly ts: number }
  | { readonly type: "worktree:activity_observed"; readonly runId: string; readonly source: "runner" | "host_attested"; readonly ts: number }
  /**
   * `builder_validation` is a write-ahead admission checkpoint, not a request
   * to remove a workspace.  It records every member head before a managed
   * Builder artifact is accepted, so a committed detached checkout remains
   * recoverable without pretending that delivery has already happened.
   */
  | { readonly type: "worktree:release_requested"; readonly runId: string; readonly reason: "delivered" | "abandoned" | "blocked" | "builder_validation"; readonly operationId: string; readonly expectedHeads: ReadonlyArray<{ readonly relativeLocator: ManagedWorkspaceMemberLocator; readonly head: string }>; /** Human-supplied recovery context; optional for legacy records. */ readonly note?: string; readonly ts: number }
  | { readonly type: "worktree:released"; readonly runId: string; readonly operationId: string; readonly expectedHeads: ReadonlyArray<{ readonly relativeLocator: ManagedWorkspaceMemberLocator; readonly head: string }>; readonly ts: number }
  | { readonly type: "worktree:recovery_required"; readonly runId: string; readonly relativeLocator: ManagedWorkspaceMemberLocator; readonly reason: string; /** Carries the exact allocation identity when the allocation event could not be appended. */ readonly workspace?: ManagedWorkspaceSet; readonly operationId?: string; readonly ts: number };

const KEY_PREFIX: Readonly<Record<DeliveryRunKind, string>> = {
  cycle: "cycle-",
  host_delta: "delta-",
  skill_dispatch: "dispatch-",
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

/** A portable direct-child key. This intentionally rejects paths and dot names. */
export function isManagedWorkspaceKey(value: unknown, kind?: DeliveryRunKind): value is string {
  if (!nonEmptyString(value) || value === "." || value === "..") return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return false;
  return kind === undefined || value.startsWith(KEY_PREFIX[kind]);
}

/** Reject absolute, traversal, duplicate-separator, and dot-segment locators. */
export function isManagedWorkspaceLocator(value: unknown): value is string {
  if (!nonEmptyString(value) || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes("\\") || value.includes("//") || value.endsWith("/")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isRepositoryRelativePath(value: unknown): value is string {
  return isManagedWorkspaceLocator(value) && !value.includes(".submodules/");
}

function normaliseScope(scope: unknown): readonly string[] | undefined {
  if (scope === undefined) return undefined;
  if (!Array.isArray(scope) || scope.length === 0 || !scope.every(isRepositoryRelativePath)) return undefined;
  const normalized = [...new Set(scope)].sort();
  return normalized.length === scope.length ? normalized : undefined;
}

function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

/**
 * The write boundary for persisted workspace facts. It rejects rather than
 * repairs ambiguous locators, so two spellings can never name one checkout.
 */
export function normalizeManagedWorkspaceSet(input: unknown): ManagedWorkspaceNormalization {
  if (typeof input !== "object" || input === null) return { ok: false, reason: "invalid_workspace_set" };
  const set = input as Record<string, unknown>;
  if (set.schema !== MANAGED_WORKSPACE_SCHEMA || !nonEmptyString(set.runId) || !nonEmptyString(set.storyId)) return { ok: false, reason: "invalid_workspace_set" };
  if (!(DELIVERY_RUN_KINDS as readonly unknown[]).includes(set.kind) || !(DELIVERY_TOPOLOGIES as readonly unknown[]).includes(set.topology)) return { ok: false, reason: "invalid_workspace_set" };
  const kind = set.kind as DeliveryRunKind;
  if (kind === "host_delta" && (!nonEmptyString(set.delegationId) || set.runId !== `delta-${set.delegationId}` || set.topology === "full-delta-team")) return { ok: false, reason: "invalid_workspace_set" };
  if (!Array.isArray(set.members) || set.members.length === 0) return { ok: false, reason: "invalid_workspace_set" };

  const members: ManagedWorkspaceMember[] = [];
  const locators = new Set<string>();
  let primaryKey: string | undefined;
  for (let index = 0; index < set.members.length; index += 1) {
    const raw = set.members[index];
    if (typeof raw !== "object" || raw === null) return { ok: false, reason: "invalid_member" };
    const member = raw as Record<string, unknown>;
    if (!nonEmptyString(member.repositoryId) || !isManagedWorkspaceKey(member.workspaceKey, kind) || !isManagedWorkspaceLocator(member.relativeLocator)) {
      return { ok: false, reason: !isManagedWorkspaceKey(member.workspaceKey, kind) ? "invalid_workspace_key" : "invalid_member" };
    }
    if (typeof member.checkoutRef !== "object" || member.checkoutRef === null) return { ok: false, reason: "invalid_member" };
    const checkout = member.checkoutRef as Record<string, unknown>;
    if (checkout.kind !== "detached" || !nonEmptyString(checkout.head)) return { ok: false, reason: "invalid_member" };
    const key = member.workspaceKey;
    if (index === 0) {
      primaryKey = key;
      if (member.relativeLocator !== key || member.actionId !== undefined) return { ok: false, reason: "invalid_primary_locator" };
    } else {
      const isSubmodule = member.relativeLocator.startsWith(`${primaryKey}.submodules/`);
      const isDispatchChild = kind === "skill_dispatch" && member.relativeLocator.startsWith(`${primaryKey}.children/`);
      if (key !== primaryKey || (!isSubmodule && !isDispatchChild)) return { ok: false, reason: "invalid_submodule_locator" };
      // A dispatch set is a parent project checkout plus declared action
      // children. Combining an action boundary with a submodule checkout needs
      // its own explicit contract; accepting an unscoped hybrid would make the
      // submodule invisible to the dispatch scope guard.
      if (kind === "skill_dispatch" && isSubmodule) return { ok: false, reason: "invalid_member" };
      if (isDispatchChild && (!nonEmptyString(member.actionId) || member.relativeLocator !== `${primaryKey}.children/${member.actionId}`)) {
        return { ok: false, reason: "invalid_member" };
      }
    }
    if (kind !== "skill_dispatch" && (member.actionId !== undefined || member.declaredFileScope !== undefined)) return { ok: false, reason: "invalid_member" };
    if (kind === "skill_dispatch" && member.relativeLocator.startsWith(`${primaryKey}.children/`) && member.declaredFileScope === undefined) return { ok: false, reason: "invalid_declared_scope" };
    if (locators.has(member.relativeLocator)) return { ok: false, reason: "duplicate_locator" };
    locators.add(member.relativeLocator);
    const declaredFileScope = normaliseScope(member.declaredFileScope);
    if (member.declaredFileScope !== undefined && declaredFileScope === undefined) return { ok: false, reason: "invalid_declared_scope" };
    members.push({
      repositoryId: member.repositoryId,
      workspaceKey: key,
      relativeLocator: member.relativeLocator,
      ...(nonEmptyString(member.actionId) ? { actionId: member.actionId } : {}),
      ...(declaredFileScope === undefined ? {} : { declaredFileScope }),
      checkoutRef: { kind: "detached", head: checkout.head },
      ...(nonEmptyString(member.publishRef) ? { publishRef: member.publishRef } : {}),
    });
  }

  const scopedMembers = members.filter((member) => member.declaredFileScope !== undefined);
  for (let index = 0; index < scopedMembers.length; index += 1) {
    const left = scopedMembers[index]!;
    for (const right of scopedMembers.slice(index + 1)) {
      if (scopesOverlap(left.declaredFileScope!, right.declaredFileScope!)) return { ok: false, reason: "overlapping_declared_scope" };
    }
  }

  return {
    ok: true,
    value: {
      schema: MANAGED_WORKSPACE_SCHEMA,
      runId: set.runId,
      storyId: set.storyId,
      kind,
      topology: set.topology as DeliveryTopology,
      ...(nonEmptyString(set.delegationId) ? { delegationId: set.delegationId } : {}),
      members: members as [ManagedWorkspaceMember, ...ManagedWorkspaceMember[]],
    },
  };
}

/** US spelling alias kept for clients that use “worktree” in command surfaces. */
export const normalizeManagedWorktreeSet = normalizeManagedWorkspaceSet;
