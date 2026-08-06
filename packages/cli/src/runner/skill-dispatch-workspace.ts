/** US-LOOP-127 — production allocator for parent-owned Skill dispatch. */
import {
  EventBus,
  claimStoryLease,
  createSkillDispatchPlan,
  readLeases,
  releaseStoryLease,
  skillDispatchAuthority,
  type SkillDispatchActionInput,
} from "@roll/core";
import { MANAGED_WORKSPACE_SCHEMA, normalizeManagedWorkspaceSet, type ManagedWorkspaceSet } from "@roll/spec";
import { git, inspectManagedWorktree, managedWorktreeAbsent, managedWorktreeRelease, managedWorktreeRemoteContainment, projectIdentity, resolveIntegrationBranch, retainManagedWorktreeHead, worktreeAdd } from "@roll/infra";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { bootstrapWorktreeDeps, bootstrapWorktreePrebuild, bootstrapWorktreeSkills, linkRollIntoWorktree, readPrebuildDistEnabled } from "./worktree-bootstrap.js";
import type { EventsPort } from "./ports.js";

export interface SkillDispatchRunInput {
  /** The parent project checkout. Child paths and repository identity are derived here. */
  readonly projectRoot: string;
  readonly storyId: string;
  /** Must be the parent DeliveryRun id, e.g. dispatch-<uuid>. */
  readonly runId: string;
  readonly actions: readonly SkillDispatchActionInput[];
}

export interface AllocatedSkillDispatchRun {
  readonly workspace: ManagedWorkspaceSet;
  readonly paths: Readonly<Record<string, string>>;
}

export type SkillDispatchAllocationRefusal =
  | "invalid_parent_run"
  | "parent_reservation_held"
  | "base_identity_unknown"
  | "target_exists"
  | "git_add_failed"
  | "workspace_identity_mismatch"
  | "event_write_failed"
  | "bootstrap_failed"
  | "parent_contract_refused";

export interface SkillDispatchAllocatorDeps {
  readonly now?: () => number;
  readonly base?: (projectRoot: string) => string;
  readonly facts?: (projectRoot: string, base: string) => Promise<{ readonly baseSha: string; readonly repositoryId: string } | undefined>;
  readonly inspect?: (projectRoot: string, path: string) => Promise<{ readonly head: string; readonly repositoryId: string; readonly registered: boolean } | undefined>;
  readonly add?: (projectRoot: string, path: string, publishRef: string, base: string) => Promise<{ readonly code: number }>;
  readonly append?: (eventsPath: string, event: Parameters<EventBus["appendEvent"]>[1]) => void;
  /** Injectable only for tests; production runs the same bootstrap as managed cycles. */
  readonly bootstrap?: (projectRoot: string, path: string) => Promise<boolean>;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && !path.startsWith("..") && !path.includes("../");
}

function workspacePaths(root: string, workspace: ManagedWorkspaceSet): Readonly<Record<string, string>> {
  return Object.fromEntries(workspace.members.map((member) => [member.relativeLocator, resolve(root, member.relativeLocator)]));
}

function appendRecovery(
  append: (eventsPath: string, event: Parameters<EventBus["appendEvent"]>[1]) => void,
  eventsPath: string,
  workspace: ManagedWorkspaceSet,
  operationId: string,
  reason: string,
  now: number,
): boolean {
  try {
    append(eventsPath, {
      type: "worktree:recovery_required",
      runId: workspace.runId,
      relativeLocator: workspace.members[0].relativeLocator,
      reason,
      workspace,
      operationId,
      ts: now,
    });
    return true;
  } catch {
    return false;
  }
}

type LifecycleRecord = { readonly type?: unknown; readonly workspace?: ManagedWorkspaceSet; readonly operationId?: unknown; readonly runId?: unknown; readonly expectedHeads?: unknown; readonly reason?: unknown; readonly note?: unknown };

function lifecycleEvents(path: string): LifecycleRecord[] {
  try {
    return readFileSync(path, "utf8").split("\n").flatMap((line) => {
      try { return [JSON.parse(line) as LifecycleRecord]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function sameWorkspace(left: ManagedWorkspaceSet, right: ManagedWorkspaceSet): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchingLifecycle(events: readonly LifecycleRecord[], type: "worktree:allocated" | "worktree:recovery_required", workspace: ManagedWorkspaceSet, operationId: string): boolean {
  return events.some((event) => event.type === type && event.operationId === operationId && event.workspace !== undefined && sameWorkspace(event.workspace, workspace));
}

/**
 * A write-ahead allocation workspace is the durable request identity.  A retry
 * must reuse it instead of rebuilding one from a moving integration branch.
 */
function frozenAllocationWorkspace(
  events: readonly LifecycleRecord[],
  storyId: string,
  runId: string,
): { readonly found: false } | { readonly found: true; readonly workspace?: ManagedWorkspaceSet } {
  const operationId = `${runId}:allocate`;
  const record = events.find((event) => (
    (event.type === "worktree:recovery_required" || event.type === "worktree:allocated")
    && event.operationId === operationId
    && (event.runId === runId || event.workspace?.runId === runId)
  ));
  if (record === undefined || record.workspace === undefined) return { found: false };
  const normalized = normalizeManagedWorkspaceSet(record.workspace);
  if (!normalized.ok || normalized.value.kind !== "skill_dispatch"
    || normalized.value.storyId !== storyId || normalized.value.runId !== runId) return { found: true };
  return { found: true, workspace: normalized.value };
}

function workspaceMatchesDispatchInput(workspace: ManagedWorkspaceSet, input: SkillDispatchRunInput): boolean {
  if (workspace.kind !== "skill_dispatch" || workspace.storyId !== input.storyId || workspace.runId !== input.runId) return false;
  const parent = workspace.members[0];
  if (parent === undefined) return false;
  const plan = createSkillDispatchPlan({
    reservation: { storyId: input.storyId, runId: input.runId },
    workspace: {
      ...workspace,
      members: [parent],
    },
  }, input.actions);
  if (!plan.ok) return false;
  const expected: ManagedWorkspaceSet = {
    ...workspace,
    members: [
      parent,
      ...plan.value.children.map((child) => ({
        repositoryId: parent.repositoryId,
        workspaceKey: parent.workspaceKey,
        relativeLocator: child.relativeLocator,
        actionId: child.actionId,
        declaredFileScope: child.declaredFileScope,
        checkoutRef: parent.checkoutRef,
        publishRef: `refs/heads/${input.runId}/${child.actionId}`,
      })),
    ] as ManagedWorkspaceSet["members"],
  };
  return sameWorkspace(workspace, expected);
}

/**
 * A release request freezes the heads that the fresh cleanup audit actually
 * observed. They intentionally need not equal the allocation base: a normal
 * child delivery advances its detached checkout before the parent can release
 * the reservation. We only accept a complete, unique locator set here; the
 * paired completion must repeat this exact frozen set below.
 */
function isCompleteExpectedHeadSet(value: unknown, workspace: ManagedWorkspaceSet): value is readonly { readonly relativeLocator: string; readonly head: string }[] {
  if (!Array.isArray(value)) return false;
  const expected = workspace.members.map((member) => member.relativeLocator).sort();
  const found = value.flatMap((item) => typeof item === "object" && item !== null
    && typeof (item as { relativeLocator?: unknown }).relativeLocator === "string"
    && typeof (item as { head?: unknown }).head === "string"
    && (item as { head: string }).head.length > 0
    ? [(item as { relativeLocator: string }).relativeLocator]
    : []).sort();
  return JSON.stringify(found) === JSON.stringify(expected);
}

function sameExpectedHeadSet(
  left: readonly { readonly relativeLocator: string; readonly head: string }[],
  right: readonly { readonly relativeLocator: string; readonly head: string }[],
): boolean {
  const normalized = (heads: readonly { readonly relativeLocator: string; readonly head: string }[]) =>
    heads.map((head) => `${head.relativeLocator}:${head.head}`).sort();
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

async function defaultBootstrap(projectRoot: string, path: string): Promise<boolean> {
  const alertsPath = join(projectRoot, ".roll", "loop", "alerts.md");
  const bus = new EventBus();
  const events: EventsPort = {
    ensureEventFiles: bus.ensureEventFiles.bind(bus),
    appendEvent: bus.appendEvent.bind(bus),
    upsertRun: bus.upsertRun.bind(bus),
    appendAlert: (target: string, message: string): void => {
      mkdirSync(dirname(target), { recursive: true });
      appendFileSync(target, `${message}\n`, "utf8");
    },
  };
  try {
    await linkRollIntoWorktree(projectRoot, path);
    if (!await bootstrapWorktreeSkills(path, alertsPath, events, (worktreePath) => git(["submodule", "update", "--init", "--recursive"], worktreePath))) return false;
    if (!await bootstrapWorktreeDeps(path, alertsPath, events)) return false;
    await bootstrapWorktreePrebuild(path, alertsPath, events, readPrebuildDistEnabled(projectRoot));
    return true;
  } catch {
    return false;
  }
}

function inspectedMatches(
  observed: { readonly head: string; readonly repositoryId: string; readonly registered: boolean } | undefined,
  workspace: ManagedWorkspaceSet,
  locator: string,
): boolean {
  const member = workspace.members.find((item) => item.relativeLocator === locator);
  return member !== undefined && observed !== undefined && observed.registered
    && observed.repositoryId === member.repositoryId && observed.head === member.checkoutRef.head;
}

/**
 * Allocate one parent `skill_dispatch` DeliveryRun and all of its children.
 * This is the only production allocation entry: it derives the canonical root,
 * repository identity, base SHA, lifecycle event path, and Story reservation
 * from the project checkout. Callers cannot inject a root, parent workspace, or
 * claimed reservation.
 */
export async function allocateSkillDispatchRun(
  input: SkillDispatchRunInput,
  deps: SkillDispatchAllocatorDeps = {},
): Promise<{ readonly ok: true; readonly value: AllocatedSkillDispatchRun } | { readonly ok: false; readonly reason: SkillDispatchAllocationRefusal }> {
  if (!input.runId.startsWith("dispatch-") || input.storyId.trim() === "") return { ok: false, reason: "invalid_parent_run" };

  const projectRoot = realpathSync(input.projectRoot);
  const canonicalRootInput = join(projectRoot, ".roll", "loop", "worktrees");
  mkdirSync(canonicalRootInput, { recursive: true });
  const canonicalRoot = realpathSync(canonicalRootInput);
  const eventsPath = join(projectRoot, ".roll", "loop", "events.ndjson");
  const leasePath = join(projectRoot, ".roll", "loop", "leases");
  const events = lifecycleEvents(eventsPath);
  const frozen = frozenAllocationWorkspace(events, input.storyId, input.runId);
  if (frozen.found && frozen.workspace === undefined) return { ok: false, reason: "workspace_identity_mismatch" };
  const frozenWorkspace = frozen.found ? frozen.workspace : undefined;
  if (frozenWorkspace !== undefined && !workspaceMatchesDispatchInput(frozenWorkspace, input)) {
    return { ok: false, reason: "workspace_identity_mismatch" };
  }
  const base = frozenWorkspace?.members[0].checkoutRef.head ?? deps.base?.(projectRoot) ?? resolveIntegrationBranch(projectRoot);
  const facts = await (deps.facts?.(projectRoot, base) ?? defaultFacts(projectRoot, base));
  if (facts === undefined) return { ok: false, reason: "base_identity_unknown" };
  if (frozenWorkspace !== undefined && (facts.baseSha !== frozenWorkspace.members[0].checkoutRef.head
    || facts.repositoryId !== frozenWorkspace.members[0].repositoryId)) return { ok: false, reason: "workspace_identity_mismatch" };
  const workspaceCandidate = frozenWorkspace ?? (() => {
    const parent = {
      reservation: { storyId: input.storyId, runId: input.runId },
      workspace: {
        schema: MANAGED_WORKSPACE_SCHEMA,
        runId: input.runId,
        storyId: input.storyId,
        kind: "skill_dispatch" as const,
        topology: "solo" as const,
        members: [{
          repositoryId: facts.repositoryId,
          workspaceKey: input.runId,
          relativeLocator: input.runId,
          checkoutRef: { kind: "detached" as const, head: facts.baseSha },
          publishRef: `refs/heads/${input.runId}`,
        }] as const,
      },
    };
    const plan = createSkillDispatchPlan(parent, input.actions);
    if (!plan.ok) return undefined;
    return {
      ...plan.value.parent.workspace,
      members: [
        plan.value.parent.workspace.members[0],
        ...plan.value.children.map((child) => ({
          repositoryId: facts.repositoryId,
          workspaceKey: input.runId,
          relativeLocator: child.relativeLocator,
          actionId: child.actionId,
          declaredFileScope: child.declaredFileScope,
          checkoutRef: { kind: "detached" as const, head: facts.baseSha },
          publishRef: `refs/heads/${input.runId}/${child.actionId}`,
        })),
      ] as ManagedWorkspaceSet["members"],
    };
  })();
  if (workspaceCandidate === undefined) return { ok: false, reason: "parent_contract_refused" };
  const workspace: ManagedWorkspaceSet = workspaceCandidate;
  const paths = workspacePaths(canonicalRoot, workspace);
  if (Object.values(paths).some((path) => !inside(canonicalRoot, path))) return { ok: false, reason: "workspace_identity_mismatch" };
  const now = deps.now?.() ?? Date.now();
  const operationId = `${input.runId}:allocate`;
  const recoveryRecorded = matchingLifecycle(events, "worktree:recovery_required", workspace, operationId);
  const allocationRecorded = matchingLifecycle(events, "worktree:allocated", workspace, operationId);
  const existingLease = readLeases(leasePath)[input.storyId];
  const matchingLease = existingLease?.source === "skill-dispatch" && existingLease.runId === input.runId;
  let claimedNow = false;
  if (existingLease === undefined) {
    const claim = claimStoryLease(leasePath, input.storyId, { source: "skill-dispatch", runId: input.runId, claimedAt: now });
    if (claim.status !== "claimed") return { ok: false, reason: "parent_reservation_held" };
    claimedNow = true;
  } else if (!matchingLease) {
    return { ok: false, reason: "parent_reservation_held" };
  }
  const abandonFreshClaim = (): void => {
    if (claimedNow) releaseStoryLease(leasePath, input.storyId, { source: "skill-dispatch", runId: input.runId });
  };
  const inspect = deps.inspect ?? ((repoCwd, path) => inspectManagedWorktree(repoCwd, path));
  if (allocationRecorded) {
    for (const [locator, path] of Object.entries(paths)) {
      if (!inspectedMatches(await inspect(projectRoot, path), workspace, locator)) {
        appendRecovery(deps.append ?? ((eventPath, event) => new EventBus().appendEvent(eventPath, event)), eventsPath, workspace, operationId, "allocated_event_workspace_missing", now);
        return { ok: false, reason: "workspace_identity_mismatch" };
      }
    }
    return { ok: true, value: { workspace, paths } };
  }

  const append = deps.append ?? ((path, event) => new EventBus().appendEvent(path, event));
  if (!recoveryRecorded) {
    for (const path of Object.values(paths)) {
      if (existsSync(path) || await inspect(projectRoot, path) !== undefined) {
        abandonFreshClaim();
        return { ok: false, reason: "target_exists" };
      }
    }
    // This durable write-ahead marker precedes the first Git effect. A retry
    // with the same runId adopts only this exact workspace and operation.
    if (!appendRecovery(append, eventsPath, workspace, operationId, "allocation_started", now)) {
      abandonFreshClaim();
      return { ok: false, reason: "event_write_failed" };
    }
  }
  const add = deps.add ?? ((repoCwd, path, publishRef, baseRef) => worktreeAdd(repoCwd, path, publishRef, baseRef));
  const bootstrap = deps.bootstrap ?? defaultBootstrap;
  for (const member of workspace.members) {
    const path = paths[member.relativeLocator]!;
    const observedBefore = await inspect(projectRoot, path);
    if (observedBefore === undefined) {
      if (existsSync(path)) {
        appendRecovery(append, eventsPath, workspace, operationId, "existing_target_identity_unproven", now);
        return { ok: false, reason: "workspace_identity_mismatch" };
      }
      const result = await add(projectRoot, path, member.publishRef ?? input.runId, base);
      if (result.code !== 0) {
        appendRecovery(append, eventsPath, workspace, operationId, "git_add_failed", now);
        return { ok: false, reason: "git_add_failed" };
      }
    }
    const observed = await inspect(projectRoot, path);
    if (!inspectedMatches(observed, workspace, member.relativeLocator)) {
      appendRecovery(append, eventsPath, workspace, operationId, "workspace_identity_mismatch", now);
      return { ok: false, reason: "workspace_identity_mismatch" };
    }
    if (!await bootstrap(projectRoot, path)) {
      appendRecovery(append, eventsPath, workspace, operationId, "git_created_bootstrap_incomplete", now);
      return { ok: false, reason: "bootstrap_failed" };
    }
  }
  try {
    append(eventsPath, { type: "worktree:allocated", workspace, operationId, ts: now });
  } catch {
    appendRecovery(append, eventsPath, workspace, operationId, "git_created_event_missing", now);
    return { ok: false, reason: "event_write_failed" };
  }
  return { ok: true, value: { workspace, paths } };
}

/** Runtime closure boundary. Child commands cannot release their parent's lease. */
export function releaseSkillDispatchReservation(
  projectRoot: string,
  storyId: string,
  runId: string,
  executionCwd: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: "parent_required" | "workspace_release_required" | "reservation_release_refused" } {
  const actor = skillDispatchActorForCwd(executionCwd);
  // Release executes from the parent integration/control-plane checkout after
  // children are gone. A recognized child is always denied; an unclassified
  // project-root runner is the parent control plane, never a child assertion.
  const authority = skillDispatchAuthority(actor === "child" ? "child" : "parent", "release_reservation");
  if (!authority.ok) return authority;
  const root = realpathSync(projectRoot);
  const eventsPath = join(root, ".roll", "loop", "events.ndjson");
  const events = lifecycleEvents(eventsPath);
  const allocation = [...events].reverse().find((record): record is LifecycleRecord & { workspace: ManagedWorkspaceSet; operationId: string } => {
    return record.type === "worktree:allocated" && record.workspace?.runId === runId && record.workspace.storyId === storyId;
  });
  if (allocation === undefined || allocation.operationId === undefined) return { ok: false, reason: "workspace_release_required" };
  const operationId = `${allocation.operationId}:release`;
  let requestIndex = -1;
  let requestHeads: readonly { readonly relativeLocator: string; readonly head: string }[] | undefined;
  let completed = false;
  for (const [index, record] of events.entries()) {
    const expectedHeads = isCompleteExpectedHeadSet(record.expectedHeads, allocation.workspace)
      ? record.expectedHeads
      : undefined;
    if (record.runId !== runId || record.operationId !== operationId || expectedHeads === undefined) continue;
    if (record.type === "worktree:released") {
      // Completion is valid only after this operation's durable request. A
      // reversed terminal fact is corrupt lifecycle evidence, not a retry.
      if (requestIndex < 0) return { ok: false, reason: "workspace_release_required" };
      if (requestHeads === undefined || !sameExpectedHeadSet(requestHeads, expectedHeads)) {
        return { ok: false, reason: "workspace_release_required" };
      }
      completed = true;
    } else if (record.type === "worktree:release_requested" && requestIndex < 0) {
      requestIndex = index;
      requestHeads = expectedHeads;
    }
  }
  if (requestIndex < 0 || requestHeads === undefined) return { ok: false, reason: "workspace_release_required" };
  const canonicalRoot = join(root, ".roll", "loop", "worktrees");
  if (allocation.workspace.members.some((member) => existsSync(resolve(canonicalRoot, member.relativeLocator)))) {
    return { ok: false, reason: "workspace_release_required" };
  }
  // Git removal may have succeeded immediately before a durable completion
  // append failed. The paired request is the write-ahead proof; replay only its
  // exact allocation operation and never infer a release from missing paths.
  if (!completed) {
    try {
      new EventBus().appendEvent(eventsPath, {
        type: "worktree:released",
        runId,
        operationId,
        expectedHeads: requestHeads,
        ts: Date.now(),
      });
    } catch {
      return { ok: false, reason: "workspace_release_required" };
    }
  }
  const leasePath = join(root, ".roll", "loop", "leases");
  // The durable request/completion pair is the closure authority. Once a
  // matching lease was removed, an operator or cleanup retry is deliberately
  // idempotent rather than reporting a false recovery failure.
  if (readLeases(leasePath)[storyId] === undefined) return { ok: true };
  const released = releaseStoryLease(leasePath, storyId, {
    source: "skill-dispatch",
    runId,
  });
  return released ? { ok: true } : { ok: false, reason: "reservation_release_refused" };
}

export type SkillDispatchConfirmRefusal =
  | "parent_required"
  | "execution_inside_workspace"
  | "workspace_unknown"
  | "merged_or_unverifiable"
  | "attest_not_accepted"
  | "workspace_unavailable"
  | "workspace_identity_mismatch"
  | "workspace_dirty"
  | "conflicting_release_request"
  | "reservation_held_by_other"
  | "release_incomplete"
  | "reservation_release_refused";

export type SkillDispatchConfirmResult =
  | { readonly ok: true; readonly finalized: true }
  | { readonly ok: false; readonly reason: SkillDispatchConfirmRefusal; readonly releaseFailure?: { readonly relativeLocator: string; readonly reason: string } };

export interface SkillDispatchConfirmDeps {
  readonly now?: () => number;
  readonly inspect?: (repoCwd: string, path: string) => ReturnType<typeof inspectManagedWorktree>;
  readonly absent?: (repoCwd: string, path: string) => ReturnType<typeof managedWorktreeAbsent>;
  readonly release?: (repoCwd: string, path: string, expectedHead: string, repositoryId: string, options?: Parameters<typeof managedWorktreeRelease>[4]) => ReturnType<typeof managedWorktreeRelease>;
  readonly append?: (eventsPath: string, event: Parameters<EventBus["appendEvent"]>[1]) => void;
  /** Test seam; production proves every member against main and the parent PR anchor. */
  readonly merged?: (projectRoot: string, workspace: ManagedWorkspaceSet, paths: Readonly<Record<string, string>>) => boolean | Promise<boolean>;
  /** Test-only external PR lookup boundary; Git proof remains production code. */
  readonly mergedPrCommit?: (projectRoot: string, branch: string) => string | undefined;
  readonly integrationBranch?: (projectRoot?: string) => string;
  /** Test seam; production requires a durable PASS review page for the same story. */
  readonly attested?: (projectRoot: string, storyId: string) => boolean | Promise<boolean>;
}

function fullOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}

function mergedPrCommit(projectRoot: string, branch: string): string | undefined {
  try {
    const raw = execFileSync("gh", ["pr", "view", branch, "--json", "state,mergedAt,mergeCommit,headRefName"], {
      cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw) as { state?: unknown; mergedAt?: unknown; headRefName?: unknown; mergeCommit?: { oid?: unknown } | null };
    const oid = parsed.mergeCommit?.oid;
    return parsed.state === "MERGED" && typeof parsed.mergedAt === "string" && parsed.mergedAt !== ""
      && parsed.headRefName === branch && typeof oid === "string" && fullOid(oid) ? oid : undefined;
  } catch {
    return undefined;
  }
}

/** Prove a delivered multi-member dispatch without relying on its original commits surviving a squash merge. */
function deliveredDispatchOnIntegration(projectRoot: string, workspace: ManagedWorkspaceSet, paths: Readonly<Record<string, string>>, lookup = mergedPrCommit, branch = resolveIntegrationBranch): boolean {
  const integration = branch(projectRoot);
  const parent = workspace.members[0];
  const parentBranch = parent?.publishRef?.replace(/^refs\/heads\//, "");
  if (parent === undefined || parentBranch === undefined || parentBranch === "") return false;
  const merge = lookup(projectRoot, parentBranch);
  if (merge === undefined) return false;
  try {
    execFileSync("git", ["-C", projectRoot, "merge-base", "--is-ancestor", merge, integration], { stdio: "ignore" });
    const mergeTree = execFileSync("git", ["-C", projectRoot, "rev-parse", `${merge}^{tree}`], { encoding: "utf8" }).trim();
    if (mergeTree === "") return false;
    return workspace.members.every((member) => {
      const path = paths[member.relativeLocator];
      if (path === undefined) return false;
      const head = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      try {
        execFileSync("git", ["-C", projectRoot, "merge-base", "--is-ancestor", head, integration], { stdio: "ignore" });
        return true;
      } catch {
        // This is the squash-safe path. A child need not have its own PR when
        // its final tree is exactly the parent's landed PR tree.
        return execFileSync("git", ["-C", path, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim() === mergeTree;
      }
    });
  } catch {
    return false;
  }
}

function acceptedStoryAttest(projectRoot: string, storyId: string): boolean {
  const features = join(projectRoot, ".roll", "features");
  try {
    for (const epic of readdirSync(features, { withFileTypes: true })) {
      if (!epic.isDirectory()) continue;
      const latest = join(features, epic.name, storyId, "latest", `${storyId}-review.html`);
      try {
        const review = readFileSync(latest, "utf8");
        if (/Gate:\s*PASS/.test(review) && /class="ac s-pass"/.test(review)
          && !/class="ac s-(?:fail|claimed)"/.test(review)) return true;
      } catch { /* another epic/card is not an acceptance fact */ }
    }
  } catch { /* unreadable archive is not accepted evidence */ }
  return false;
}

function deliveredRequest(
  events: readonly LifecycleRecord[],
  runId: string,
  operationId: string,
  workspace: ManagedWorkspaceSet,
): { readonly heads: readonly { readonly relativeLocator: string; readonly head: string }[]; readonly completed: boolean } | "conflict" | undefined {
  let heads: readonly { readonly relativeLocator: string; readonly head: string }[] | undefined;
  let completed = false;
  for (const event of events) {
    if (event.runId !== runId) continue;
    if (event.type === "worktree:release_requested") {
      // A durable delivered request is the sole retry identity. Even a
      // byte-for-byte duplicate is ambiguous write-ahead state, not a second
      // operation to continue.
      if (heads !== undefined || event.operationId !== operationId || event.reason !== "delivered"
        || !isCompleteExpectedHeadSet(event.expectedHeads, workspace)) return "conflict";
      heads = event.expectedHeads;
      continue;
    }
    if (event.type === "worktree:released") {
      // Completion is valid only after this operation's exact request and may
      // never stand in for a missing or unrelated delivery admission.
      if (heads === undefined || completed || event.operationId !== operationId
        || !isCompleteExpectedHeadSet(event.expectedHeads, workspace)
        || !sameExpectedHeadSet(heads, event.expectedHeads)) return "conflict";
      completed = true;
    }
  }
  return heads === undefined ? undefined : { heads, completed };
}

/**
 * RL-EXEC-010: parent-only delivery confirmation. It is intentionally the only path that
 * may turn a live dispatch into the existing delivered release lifecycle.
 */
export async function confirmSkillDispatchDelivery(
  projectRoot: string,
  storyId: string,
  runId: string,
  executionCwd: string,
  deps: SkillDispatchConfirmDeps = {},
): Promise<SkillDispatchConfirmResult> {
  if (skillDispatchActorForCwd(executionCwd) === "child") return { ok: false, reason: "parent_required" };
  const root = realpathSync(projectRoot);
  const eventsPath = join(root, ".roll", "loop", "events.ndjson");
  const events = lifecycleEvents(eventsPath);
  const workspace = allocatedDispatch(eventsPath, storyId, runId);
  if (workspace === undefined) return { ok: false, reason: "workspace_unknown" };
  const paths = workspacePaths(join(root, ".roll", "loop", "worktrees"), workspace);
  if (cwdInsideAnyWorkspaceMember(executionCwd, paths)) return { ok: false, reason: "execution_inside_workspace" };
  const allocation = [...events].reverse().find((event) => event.type === "worktree:allocated" && event.workspace?.runId === runId && event.workspace.storyId === storyId);
  if (allocation?.operationId === undefined) return { ok: false, reason: "workspace_unknown" };
  const operationId = `${allocation.operationId}:release`;
  const existing = deliveredRequest(events, runId, operationId, workspace);
  if (existing === "conflict") return { ok: false, reason: "conflicting_release_request" };
  const leasePath = join(root, ".roll", "loop", "leases");
  const lease = readLeases(leasePath)[storyId];
  if (lease !== undefined && (lease.source !== "skill-dispatch" || lease.runId !== runId)) return { ok: false, reason: "reservation_held_by_other" };

  const inspect = deps.inspect ?? inspectManagedWorktree;
  const absent = deps.absent ?? managedWorktreeAbsent;
  const release = deps.release ?? managedWorktreeRelease;
  const frozen = new Map(existing?.heads.map((head) => [head.relativeLocator, head.head]) ?? []);
  const ordered = [...workspace.members].sort((left, right) => right.relativeLocator.length - left.relativeLocator.length);
  // A durable completion means every member was already removed. A later
  // reappearing path is conflicting state, never an invitation to delete it.
  if (existing?.completed && !(await Promise.all(ordered.map((member) => absent(root, paths[member.relativeLocator]!)))).every(Boolean)) {
    return { ok: false, reason: "conflicting_release_request" };
  }
  // Before the durable request, all gates are read-only and whole-set atomic.
  if (existing === undefined) {
    if (!await (deps.merged?.(root, workspace, paths) ?? deliveredDispatchOnIntegration(root, workspace, paths, deps.mergedPrCommit, deps.integrationBranch))) {
      return { ok: false, reason: "merged_or_unverifiable" };
    }
    if (!await (deps.attested?.(root, storyId) ?? acceptedStoryAttest(root, storyId))) {
      return { ok: false, reason: "attest_not_accepted" };
    }
  }
  for (const member of ordered) {
    const path = paths[member.relativeLocator]!;
    if (existing !== undefined && await absent(root, path)) continue;
    const observed = await inspect(root, path);
    if (observed === undefined) return { ok: false, reason: "workspace_unavailable" };
    if (!observed.registered || observed.repositoryId !== member.repositoryId) return { ok: false, reason: "workspace_identity_mismatch" };
    if (!observed.clean) return { ok: false, reason: "workspace_dirty" };
    const prior = frozen.get(member.relativeLocator);
    if (prior !== undefined && prior !== observed.head) return { ok: false, reason: "conflicting_release_request" };
    frozen.set(member.relativeLocator, observed.head);
  }
  const heads = workspace.members.map((member) => ({ relativeLocator: member.relativeLocator, head: frozen.get(member.relativeLocator)! }));
  if (heads.some((head) => head.head === undefined)) return { ok: false, reason: "workspace_unavailable" };
  if (existing === undefined) {
    try {
      (deps.append ?? ((path, event) => new EventBus().appendEvent(path, event)))(eventsPath, {
        type: "worktree:release_requested", runId, reason: "delivered", operationId, expectedHeads: heads, ts: deps.now?.() ?? Date.now(),
      });
    } catch { return { ok: false, reason: "release_incomplete" }; }
  }
  for (const member of ordered) {
    const path = paths[member.relativeLocator]!;
    const head = frozen.get(member.relativeLocator)!;
    if (await absent(root, path)) continue;
    const released = await release(root, path, head, member.repositoryId, { allowVerifiedSubmoduleForce: true });
    if (released.code !== 0) {
      return {
        ok: false,
        reason: "release_incomplete",
        releaseFailure: { relativeLocator: member.relativeLocator, reason: released.reason ?? "unknown" },
      };
    }
  }
  if (!existing?.completed) {
    try {
      (deps.append ?? ((path, event) => new EventBus().appendEvent(path, event)))(eventsPath, {
        type: "worktree:released", runId, operationId, expectedHeads: heads, ts: deps.now?.() ?? Date.now(),
      });
    } catch { return { ok: false, reason: "release_incomplete" }; }
  }
  if (lease !== undefined && !releaseStoryLease(leasePath, storyId, { source: "skill-dispatch", runId })) {
    return { ok: false, reason: "reservation_release_refused" };
  }
  return { ok: true, finalized: true };
}

export type SkillDispatchStopRefusal =
  | "parent_required"
  | "execution_inside_workspace"
  | "missing_reason"
  | "confirmation_mismatch"
  | "workspace_unknown"
  | "conflicting_release_request"
  | "reservation_held_by_other"
  | "workspace_unavailable"
  | "workspace_identity_mismatch"
  | "workspace_dirty"
  | "merged_or_unverifiable"
  | "published_or_unverifiable"
  | "retention_ref_refused"
  | "release_incomplete"
  | "reservation_release_refused";

export type SkillDispatchStopResult =
  | { readonly ok: true; readonly stopped: boolean; readonly retained: readonly { readonly relativeLocator: string; readonly head: string; readonly ref: string }[] }
  | { readonly ok: false; readonly reason: SkillDispatchStopRefusal };

export interface SkillDispatchStopDeps {
  readonly now?: () => number;
  readonly inspect?: (repoCwd: string, path: string) => ReturnType<typeof inspectManagedWorktree>;
  readonly absent?: (repoCwd: string, path: string) => ReturnType<typeof managedWorktreeAbsent>;
  readonly release?: (repoCwd: string, path: string, expectedHead: string, repositoryId: string, options?: Parameters<typeof managedWorktreeRelease>[4]) => ReturnType<typeof managedWorktreeRelease>;
  readonly retain?: (repoCwd: string, runId: string, relativeLocator: string, head: string) => ReturnType<typeof retainManagedWorktreeHead>;
  readonly remoteContains?: (repoCwd: string, head: string) => ReturnType<typeof managedWorktreeRemoteContainment>;
  readonly append?: (eventsPath: string, event: Parameters<EventBus["appendEvent"]>[1]) => void;
}

function cwdInsideAnyWorkspaceMember(cwd: string, paths: Readonly<Record<string, string>>): boolean {
  let resolved: string;
  try { resolved = realpathSync(cwd); } catch { return true; }
  return Object.values(paths).some((path) => resolved === path || resolved.startsWith(`${path}${sep}`));
}

function stopRequest(
  events: readonly LifecycleRecord[],
  runId: string,
  operationId: string,
  workspace: ManagedWorkspaceSet,
): { readonly heads: readonly { readonly relativeLocator: string; readonly head: string }[]; readonly note: string; readonly completed: boolean } | "conflict" | undefined {
  let request: { readonly heads: readonly { readonly relativeLocator: string; readonly head: string }[]; readonly note: string } | undefined;
  let completed = false;
  for (const record of events) {
    if (record.runId !== runId || record.type !== "worktree:release_requested") continue;
    if (record.operationId !== operationId) {
      if (record.reason !== "builder_validation") return "conflict";
      continue;
    }
    if (!isCompleteExpectedHeadSet(record.expectedHeads, workspace) || typeof record.note !== "string") return "conflict";
    if (request !== undefined && (!sameExpectedHeadSet(request.heads, record.expectedHeads) || request.note !== record.note)) return "conflict";
    request = { heads: record.expectedHeads, note: record.note };
  }
  if (request === undefined) return undefined;
  for (const record of events) {
    if (record.runId !== runId || record.operationId !== operationId || record.type !== "worktree:released") continue;
    if (!isCompleteExpectedHeadSet(record.expectedHeads, workspace) || !sameExpectedHeadSet(request.heads, record.expectedHeads)) return "conflict";
    completed = true;
  }
  return { ...request, completed };
}

function candidateCommits(repoCwd: string, base: string, head: string): readonly string[] | undefined {
  try {
    const commits = execFileSync("git", ["-C", repoCwd, "rev-list", "--reverse", `${base}..${head}`], { encoding: "utf8" })
      .trim().split("\n").filter((value) => value !== "");
    for (const commit of commits) {
      const parents = execFileSync("git", ["-C", repoCwd, "rev-list", "--parents", "-n", "1", commit], { encoding: "utf8" }).trim().split(/\s+/);
      if (parents.length !== 2) return undefined;
    }
    return commits;
  } catch { return undefined; }
}

async function unmergedFromParent(parentPath: string, memberPath: string, base: string, head: string): Promise<boolean> {
  const commits = candidateCommits(memberPath, base, head);
  if (commits === undefined) return false;
  let parentHead: string;
  try { parentHead = execFileSync("git", ["-C", parentPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return false; }
  for (const commit of commits) {
    try {
      execFileSync("git", ["-C", parentPath, "merge-base", "--is-ancestor", commit, parentHead], { stdio: "ignore" });
      return false;
    } catch { /* candidate is not literally on the parent line */ }
    try {
      const cherry = execFileSync("git", ["-C", parentPath, "cherry", parentHead, commit], { encoding: "utf8" }).trim();
      if (!cherry.startsWith(`+ ${commit}`)) return false;
    } catch { return false; }
  }
  return true;
}

/**
 * Parent-control-plane entry for abandoning a clean, unmerged and unpublished
 * Skill dispatch. It deliberately reuses the lifecycle release pair and the
 * managed infra remover; a durable request is also the sole retry identity.
 */
export async function stopSkillDispatchRun(
  projectRoot: string,
  storyId: string,
  runId: string,
  reason: string,
  confirm: string,
  executionCwd: string,
  deps: SkillDispatchStopDeps = {},
): Promise<SkillDispatchStopResult> {
  if (skillDispatchActorForCwd(executionCwd) === "child") return { ok: false, reason: "parent_required" };
  if (reason.trim() === "") return { ok: false, reason: "missing_reason" };
  if (confirm !== storyId) return { ok: false, reason: "confirmation_mismatch" };
  const root = realpathSync(projectRoot);
  const eventsPath = join(root, ".roll", "loop", "events.ndjson");
  const events = lifecycleEvents(eventsPath);
  const workspace = allocatedDispatch(eventsPath, storyId, runId);
  if (workspace === undefined) return { ok: false, reason: "workspace_unknown" };
  const canonicalRoot = join(root, ".roll", "loop", "worktrees");
  const paths = workspacePaths(canonicalRoot, workspace);
  if (cwdInsideAnyWorkspaceMember(executionCwd, paths)) return { ok: false, reason: "execution_inside_workspace" };
  const operationId = `${runId}:stop`;
  const existing = stopRequest(events, runId, operationId, workspace);
  if (existing === "conflict" || (existing !== undefined && existing.note !== reason)) return { ok: false, reason: "conflicting_release_request" };
  const lease = readLeases(join(root, ".roll", "loop", "leases"))[storyId];
  if (lease !== undefined && (lease.source !== "skill-dispatch" || lease.runId !== runId)) return { ok: false, reason: "reservation_held_by_other" };

  const inspect = deps.inspect ?? inspectManagedWorktree;
  const absent = deps.absent ?? managedWorktreeAbsent;
  const release = deps.release ?? managedWorktreeRelease;
  const retain = deps.retain ?? retainManagedWorktreeHead;
  const remoteContains = deps.remoteContains ?? managedWorktreeRemoteContainment;
  const ordered = [...workspace.members].sort((left, right) => right.relativeLocator.length - left.relativeLocator.length);
  const expectedHeads = existing?.heads ?? [];
  const frozen = new Map(expectedHeads.map((item) => [item.relativeLocator, item.head]));
  if (workspace.members[0] === undefined) return { ok: false, reason: "workspace_unknown" };

  // Admission is all read-only. A fresh request freezes real advanced heads;
  // retry admits only the original set and accepts already-removed members.
  for (const member of ordered) {
    const path = paths[member.relativeLocator]!;
    if (existing !== undefined && await absent(root, path)) continue;
    const observed = await inspect(root, path);
    if (observed === undefined) return { ok: false, reason: "workspace_unavailable" };
    if (!observed.registered || observed.repositoryId !== member.repositoryId) return { ok: false, reason: "workspace_identity_mismatch" };
    if (!observed.clean) return { ok: false, reason: "workspace_dirty" };
    if (existing !== undefined) {
      if (frozen.get(member.relativeLocator) !== observed.head) return { ok: false, reason: "conflicting_release_request" };
      continue;
    }
    frozen.set(member.relativeLocator, observed.head);
  }
  if (existing === undefined) {
    for (const member of ordered) {
      const head = frozen.get(member.relativeLocator);
      const path = paths[member.relativeLocator]!;
      // Compare every allocated member with the control-plane checkout. The
      // managed parent can itself contain abandoned work, so using its own
      // advanced HEAD would falsely classify that work as already integrated.
      if (head === undefined || !await unmergedFromParent(root, path, member.checkoutRef.head, head)) return { ok: false, reason: "merged_or_unverifiable" };
      if (head !== member.checkoutRef.head) {
        const contained = await remoteContains(path, head);
        if (contained === undefined || contained.length > 0) return { ok: false, reason: "published_or_unverifiable" };
      }
    }
  }
  const heads = workspace.members.map((member) => ({ relativeLocator: member.relativeLocator, head: frozen.get(member.relativeLocator)! }));
  if (heads.some((head) => head.head === undefined)) return { ok: false, reason: "workspace_unavailable" };
  if (existing === undefined) {
    try {
      (deps.append ?? ((path, event) => new EventBus().appendEvent(path, event)))(eventsPath, {
        type: "worktree:release_requested", runId, reason: "abandoned", note: reason, operationId, expectedHeads: heads, ts: deps.now?.() ?? Date.now(),
      });
    } catch { return { ok: false, reason: "release_incomplete" }; }
  }
  const retained: { relativeLocator: string; head: string; ref: string }[] = [];
  for (const member of ordered) {
    const path = paths[member.relativeLocator]!;
    const head = frozen.get(member.relativeLocator)!;
    if (await absent(root, path)) {
      retained.push({ relativeLocator: member.relativeLocator, head, ref: `refs/roll-retained/${runId}/${member.relativeLocator.replace(/[^A-Za-z0-9._-]/g, "-")}` });
      continue;
    }
    const retainedHead = await retain(path, runId, member.relativeLocator, head);
    if (!retainedHead.ok) return { ok: false, reason: "retention_ref_refused" };
    retained.push({ relativeLocator: member.relativeLocator, head, ref: retainedHead.ref });
    if ((await release(root, path, head, member.repositoryId, { allowVerifiedSubmoduleForce: true })).code !== 0) return { ok: false, reason: "release_incomplete" };
  }
  if (!existing?.completed) {
    try {
      (deps.append ?? ((path, event) => new EventBus().appendEvent(path, event)))(eventsPath, {
        type: "worktree:released", runId, operationId, expectedHeads: heads, ts: deps.now?.() ?? Date.now(),
      });
    } catch { return { ok: false, reason: "release_incomplete" }; }
  }
  if (lease !== undefined && !releaseStoryLease(join(root, ".roll", "loop", "leases"), storyId, { source: "skill-dispatch", runId })) {
    return { ok: false, reason: "reservation_release_refused" };
  }
  return { ok: true, stopped: true, retained };
}

/** A pure boundary used by the parent integration command and tests. */
export function skillDispatchScopeAllows(scope: readonly string[], changedPaths: readonly string[]): boolean {
  return changedPaths.every((path) => scope.some((root) => path === root || path.startsWith(`${root}/`)));
}

/**
 * Parse Git's NUL-delimited name-status output without losing the source side
 * of a rename/copy. Both paths are writes for a scoped child integration.
 */
export function skillDispatchChangedPaths(nameStatus: string): readonly string[] | undefined {
  const fields = nameStatus.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (status === undefined || status.length === 0) return undefined;
    const code = status[0];
    const needsPair = code === "R" || code === "C";
    const first = fields[index++];
    if (first === undefined || first.length === 0) return undefined;
    paths.push(first);
    if (needsPair) {
      const second = fields[index++];
      if (second === undefined || second.length === 0) return undefined;
      paths.push(second);
    }
  }
  return paths;
}

export type SkillDispatchIntegrationRefusal =
  | "parent_required"
  | "workspace_release_required"
  | "unknown_action"
  | "child_commit_unproven"
  | "scope_violation"
  | "integration_failed";

function allocatedDispatch(eventsPath: string, storyId: string, runId: string): ManagedWorkspaceSet | undefined {
  return [...lifecycleEvents(eventsPath)].reverse().find((record): record is LifecycleRecord & { workspace: ManagedWorkspaceSet } =>
    record.type === "worktree:allocated" && record.workspace?.kind === "skill_dispatch"
      && record.workspace.storyId === storyId && record.workspace.runId === runId,
  )?.workspace;
}

/**
 * Parent-only integration. It verifies the actual candidate commit's changed
 * paths against the child declaration before cherry-picking it into the parent
 * checkout, so declarations are an enforced write boundary rather than audit
 * metadata.
 */
export function integrateSkillDispatchChild(
  projectRoot: string,
  storyId: string,
  runId: string,
  actionId: string,
  commit: string,
  executionCwd: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: SkillDispatchIntegrationRefusal } {
  if (skillDispatchActorForCwd(executionCwd) === "child") return { ok: false, reason: "parent_required" };
  const root = realpathSync(projectRoot);
  const workspace = allocatedDispatch(join(root, ".roll", "loop", "events.ndjson"), storyId, runId);
  const child = workspace?.members.find((member) => member.actionId === actionId);
  const parent = workspace?.members[0];
  if (workspace === undefined || child === undefined || parent === undefined || child.declaredFileScope === undefined) return { ok: false, reason: "unknown_action" };
  const canonicalRoot = join(root, ".roll", "loop", "worktrees");
  const childPath = resolve(canonicalRoot, child.relativeLocator);
  const parentPath = resolve(canonicalRoot, parent.relativeLocator);
  if (!existsSync(childPath) || !existsSync(parentPath)) return { ok: false, reason: "workspace_release_required" };
  try {
    execFileSync("git", ["-C", childPath, "merge-base", "--is-ancestor", child.checkoutRef.head, commit], { stdio: "ignore" });
    execFileSync("git", ["-C", childPath, "merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "ignore" });
  } catch {
    return { ok: false, reason: "child_commit_unproven" };
  }
  let commits: readonly string[];
  try {
    commits = execFileSync("git", ["-C", childPath, "rev-list", "--reverse", "--topo-order", `${child.checkoutRef.head}..${commit}`], { encoding: "utf8" })
      .trim().split("\n").filter((value) => value !== "");
    if (commits.length === 0) return { ok: false, reason: "child_commit_unproven" };
    // The parent applies these commits one by one, therefore every individual
    // patch must prove its own scope before *any* parent mutation. A net
    // base-to-tip diff can hide a cancelled write from an earlier TCR commit.
    // Merge commits have no single-parent patch semantics, so reject them
    // rather than guessing which side of their history a child is allowed to
    // import.
    for (const candidate of commits) {
      const parents = execFileSync("git", ["-C", childPath, "rev-list", "--parents", "-n", "1", candidate], { encoding: "utf8" })
        .trim().split(/\s+/).filter((value) => value !== "");
      if (parents.length !== 2) return { ok: false, reason: "child_commit_unproven" };
      const changed = skillDispatchChangedPaths(execFileSync("git", [
        // `--find-copies` considers only modified sources. A child can copy an
        // unchanged file from outside its scope into an allowed destination,
        // which would otherwise be reported as a scoped add. Include every
        // eligible source so the NUL parser can prove both sides before any
        // parent mutation.
        "-C", childPath, "diff-tree", "--no-commit-id", "--name-status", "-z", "--find-renames", "--find-copies-harder", "-r", `${candidate}^`, candidate,
      ], { encoding: "utf8" }));
      if (changed === undefined) return { ok: false, reason: "child_commit_unproven" };
      if (!skillDispatchScopeAllows(child.declaredFileScope, changed)) return { ok: false, reason: "scope_violation" };
    }
  } catch {
    return { ok: false, reason: "child_commit_unproven" };
  }
  try {
    const parentHead = execFileSync("git", ["-C", parentPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    try {
      execFileSync("git", ["-C", parentPath, "merge-base", "--is-ancestor", commit, parentHead], { stdio: "ignore" });
      return { ok: true };
    } catch {
      // A normal cherry-pick has distinct object IDs; compare patch identity
      // below to make that retry idempotent as well.
    }
    // `git cherry` compares patch identities, so a retry after the complete
    // range landed is a no-op while a partial previous integration fails loud.
    const equivalence = execFileSync("git", ["-C", childPath, "cherry", parentHead, commit], { encoding: "utf8" })
      .trim().split("\n").filter((value) => value !== "");
    // `git cherry` deliberately abbreviates object names. Its output is still
    // unambiguous for this repository, but compare the returned prefix to the
    // complete proven range SHA rather than treating the abbreviation as a new
    // or missing commit.
    const stateFor = (candidate: string): string | undefined =>
      equivalence.find((line) => candidate.startsWith(line.slice(2)))?.[0];
    if (commits.some((candidate) => stateFor(candidate) === undefined)) return { ok: false, reason: "integration_failed" };
    const alreadyApplied = commits.map(stateFor);
    if (alreadyApplied.every((state) => state === "-")) return { ok: true };
    if (alreadyApplied.some((state) => state !== "+")) return { ok: false, reason: "integration_failed" };
    // Apply every proven TCR commit in order. If any pick fails, restore the
    // parent checkout to its exact pre-integration HEAD: partial integration is
    // never a successful result or a state a retry may silently extend.
    try {
      execFileSync("git", ["-C", parentPath, "cherry-pick", "--no-edit", ...commits], { stdio: "ignore" });
    } catch {
      try { execFileSync("git", ["-C", parentPath, "cherry-pick", "--abort"], { stdio: "ignore" }); } catch { /* no active sequence */ }
      try { execFileSync("git", ["-C", parentPath, "reset", "--hard", parentHead], { stdio: "ignore" }); } catch { /* failure remains fail-closed */ }
      return { ok: false, reason: "integration_failed" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "integration_failed" };
  }
}

/**
 * Resolve the delivery actor from a real allocated workspace path. This is used
 * at command boundaries (for example attest) rather than trusting an agent to
 * volunteer that it is a child.
 */
export function skillDispatchActorForCwd(cwd: string): "parent" | "child" | undefined {
  let resolvedCwd: string;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    return undefined;
  }
  const marker = `${sep}.roll${sep}loop${sep}worktrees${sep}`;
  const markerIndex = resolvedCwd.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const projectRoot = resolvedCwd.slice(0, markerIndex);
  const canonicalRoot = join(projectRoot, ".roll", "loop", "worktrees");
  let events: unknown[];
  try {
    events = readFileSync(join(projectRoot, ".roll", "loop", "events.ndjson"), "utf8")
      .split("\n")
      .flatMap((line) => {
        try { return [JSON.parse(line) as unknown]; } catch { return []; }
      });
  } catch {
    return undefined;
  }
  for (const event of [...events].reverse()) {
    if (typeof event !== "object" || event === null) continue;
    const record = event as { type?: unknown; workspace?: ManagedWorkspaceSet };
    if (record.type !== "worktree:allocated" || record.workspace?.kind !== "skill_dispatch") continue;
    for (const member of record.workspace.members) {
      const path = resolve(canonicalRoot, member.relativeLocator);
      if (resolvedCwd === path || resolvedCwd.startsWith(`${path}${sep}`)) return member.actionId === undefined ? "parent" : "child";
    }
  }
  return undefined;
}

async function defaultFacts(projectRoot: string, base: string): Promise<{ readonly baseSha: string; readonly repositoryId: string } | undefined> {
  const { git } = await import("@roll/infra");
  const resolved = await git(["rev-parse", "--verify", `${base}^{commit}`], projectRoot);
  if (resolved.code !== 0 || resolved.stdout.trim() === "") return undefined;
  return { baseSha: resolved.stdout.trim(), repositoryId: (await projectIdentity(projectRoot)).slug };
}
