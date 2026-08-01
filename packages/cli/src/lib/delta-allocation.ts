/**
 * US-DELTA-003 — Delta delegation allocation, lease, and artifact I/O primitives.
 *
 * Extends the US-DELTA-002 preset loader with host-guided delegation frame
 * allocation, atomic no-clobber lease claim (via @roll/core claimStoryLease),
 * recovery markers, and immutable artifact writing. Deep artifact validation
 * belongs to US-DELTA-004.
 *
 * Single-owner lease truth: `.roll/loop/leases/<storyId>.lease` (per-story
 * canonical records). No single JSON map file. No lock file. Hardlink
 * no-clobber is the sole mutual-exclusion primitive.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fdatasyncSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { findFeatureFiles, liveEpicOf } from "./archive.js";
import { planManagedWorkspaceBootstrap } from "./target-submodule.js";
import { configResolve, projectConfigPath, resolveIntegrationBranch } from "@roll/infra";
import { EventBus, claimStoryLease, releaseDeliveryReservation, releaseStoryLease, readLeases, parseBacklog } from "@roll/core";
import { managedWorkspaceOperationId } from "./managed-workspace-operation.js";
import {
  allocateManagedWorkspaceSet,
  planManagedPrimaryWorkspace,
} from "../runner/managed-workspace-allocator.js";
import type {
  DelegationTrigger,
  DeliveryTopology,
  QualityProfile,
  DelegationResolution,
  ManagedWorkspaceSet,
} from "@roll/spec";

// Re-export preset loader from existing module
export { loadLocalPresets, presetPath } from "./delta-artifacts.js";

// ── ID generation ────────────────────────────────────────────────────────────

/** Seam for test injection: override CSPRNG ID generation. */
let _idGenerator: (() => string) | null = null;

/** Inject a deterministic ID generator for testing collision retry paths. */
export function injectIdGenerator(generator: (() => string) | null): void {
  _idGenerator = generator;
}

/** Generate a CSPRNG delegation ID. */
export function generateDelegationId(): string {
  if (_idGenerator) return _idGenerator();
  return randomUUID();
}

/** Canonical run ID derived from the delegation ID. */
export function runIdFromDelegationId(delegationId: string): string {
  return `delta-${delegationId}`;
}

// ── Card directory resolution ────────────────────────────────────────────────

/**
 * Resolve the single existing card archive directory for a story.
 * Must find exactly one card home; missing or ambiguous is fail-loud.
 */
export function resolveExistingUniqueCardArchiveDir(
  projectPath: string,
  storyId: string,
): string | null {
  // Strategy 1: Find feature files for this story. FIX-1495: findFeatureFiles
  // counts every markdown that MENTIONS the id (dependency blocks in other
  // cards' specs) — those are not owners. Apply the same "ID-named owner wins"
  // rule findFeatureFile documents before declaring ambiguity: an id-owned
  // file (`<id>.md`, or `<id>/spec.md`) owns the card; bare mentions without
  // any owner are the only ambiguous case.
  const files = findFeatureFiles(projectPath, storyId);
  const owned = files.filter((f) => {
    const base = basename(f);
    return base === `${storyId}.md` || (base === "spec.md" && basename(dirname(f)) === storyId);
  });
  if (owned.length > 1) return null; // genuinely ambiguous: multiple id-owned specs
  if (owned.length === 1 || files.length === 1) {
    const epic = liveEpicOf(projectPath, storyId);
    if (epic) {
      return join(projectPath, ".roll", "features", epic, storyId);
    }
  } else if (files.length > 1) {
    return null; // ambiguous: bare mentions, no owner
  }

  // Strategy 2: Try direct epic resolution from existing card dirs
  const epic = liveEpicOf(projectPath, storyId);
  if (epic) {
    const cardDir = join(projectPath, ".roll", "features", epic, storyId);
    if (existsSync(cardDir)) return cardDir;
  }

  return null;
}

// ── Lease operations ─────────────────────────────────────────────────────────

/**
 * Shared story leases directory path — the single lease truth for all sources
 * (cycle, human, supervisor, host-delegation). Each story gets its own `.lease` file.
 */
export function storyLeasesPath(projectPath: string): string {
  return join(projectPath, ".roll", "loop", "leases");
}

/**
 * Check whether any live lease exists for a story in the shared truth.
 * The claimStoryLease no-clobber contract means any entry = the story is owned.
 */
export function hasLiveLease(projectPath: string, storyId: string): boolean {
  const path = storyLeasesPath(projectPath);
  if (!existsSync(path)) return false;

  try {
    const leases = readLeases(path);
    return leases[storyId] !== undefined;
  } catch {
    return false;
  }
}

/**
 * Attempt to atomically claim a host-delegation lease for a story.
 *
 * Delegates to the core claimStoryLease primitive — hardlink no-clobber
 * on per-story canonical record files. No lock, no JSON RMW.
 *
 * Returns "claimed" on success, "exists" if any lease already exists for
 * the story (cycle, human, supervisor, or another host-delegation).
 */
export function claimHostDelegationLease(
  projectPath: string,
  storyId: string,
  delegationId: string,
  runId: string,
): "claimed" | "exists" {
  const path = storyLeasesPath(projectPath);

  // Host-delegation leases are persistent host protocol leases, not
  // short-lived CLI process leases. No pid — cleanDeadLeases must never
  // clean a live host delegation. Identity is delegationId + runId.
  const result = claimStoryLease(path, storyId, {
    claimedAt: Date.now(),
    source: "host-delegation",
    delegationId,
    runId,
  });

  if (result.status === "claimed") return "claimed";
  return "exists";
}

/**
 * Release a matching host-delegation lease. Only removes if the delegationId matches.
 *
 * Delegates to core releaseStoryLease with match-only contract.
 */
export function releaseHostDelegationLease(
  projectPath: string,
  storyId: string,
  delegationId: string,
  runId: string,
): boolean {
  return releaseStoryLease(storyLeasesPath(projectPath), storyId, {
    source: "host-delegation",
    delegationId,
    runId,
  });
}

/**
 * Read host-delegation lease for a story from the shared lease truth.
 */
export function readHostDelegationLease(
  projectPath: string,
  storyId: string,
): { storyId: string; delegationId: string; runId: string; claimedAt: number } | null {
  const path = storyLeasesPath(projectPath);
  if (!existsSync(path)) return null;

  try {
    const leases = readLeases(path);
    const entry = leases[storyId];
    if (!entry || entry.source !== "host-delegation" || !entry.delegationId) return null;
    return {
      storyId,
      delegationId: entry.delegationId,
      runId: entry.runId ?? `delta-${entry.delegationId}`,
      claimedAt: entry.claimedAt,
    };
  } catch {
    return null;
  }
}

// ── Atomic file write (temp + fsync + rename) ────────────────────────────────

/** Atomic no-clobber JSON write. Exported for test adequacy verification. */
export function atomicWriteJson(filePath: string, data: unknown): void {
  // No-overwrite invariant: target must not already exist (immutable evidence)
  if (existsSync(filePath)) {
    throw new PrepareError(
      "artifact_exists",
      `Refusing to overwrite existing artifact: ${filePath}`,
    );
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp.${randomUUID()}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  const fd = openSync(tmpPath, "r+");
  fdatasyncSync(fd);
  closeSync(fd);

  renameSync(tmpPath, filePath);

  // fsync parent dir
  const dirFd = openSync(dirname(filePath), "r");
  fdatasyncSync(dirFd);
  closeSync(dirFd);
}

// ── Error type ───────────────────────────────────────────────────────────────

export class PrepareError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PrepareError";
  }
}

// ── Prepare delegation ────────────────────────────────────────────────────────

export interface PrepareInput {
  storyId: string;
  trigger: DelegationTrigger;
  topology: DeliveryTopology;
  qualityProfile: QualityProfile;
  presetId: string;
  presetSha256: string;
  /** Exact host-supplied resolution bytes.  A retry may resume only this plan. */
  resolutionSha256: string;
  resolutionTemplate: DelegationResolution;
}

type PreparationRetryBinding = Readonly<{
  trigger: DelegationTrigger;
  topology: DeliveryTopology;
  qualityProfile: QualityProfile;
  presetId: string;
  presetSha256: string;
  resolutionSha256: string;
}>;

function retryBinding(input: PrepareInput): PreparationRetryBinding {
  return {
    trigger: input.trigger,
    topology: input.topology,
    qualityProfile: input.qualityProfile,
    presetId: input.presetId,
    presetSha256: input.presetSha256,
    resolutionSha256: input.resolutionSha256,
  };
}

function sameRetryBinding(left: unknown, right: PreparationRetryBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface PrepareResult {
  delegationId: string;
  runId: string;
  frameDir: string;
  resolutionPath: string;
  markerPath: string;
  preparationPath: string;
  eventsPath: string;
  leasePath: string;
  /** Present for post-cutover frames prepared in a real Git worktree. */
  workspace?: ManagedWorkspaceSet;
}

/** Resolve the same immutable target-member inputs that Cycle uses at pick. */
function hostTargetSubmodule(projectPath: string, cardDir: string): string | undefined {
  let specText: string | undefined;
  let gitmodulesText: string | undefined;
  try { specText = readFileSync(join(cardDir, "spec.md"), "utf8"); } catch { /* card resolver already proved the card exists */ }
  try { gitmodulesText = readFileSync(join(projectPath, ".gitmodules"), "utf8"); } catch { /* normal non-submodule project */ }
  let defaultSubmodule: string | undefined;
  try {
    const resolved = configResolve("default_submodule", { project: join(projectPath, projectConfigPath()) });
    const value = resolved?.[0]?.trim();
    if (resolved?.[1] !== undefined && resolved[1] !== "default" && value !== "") defaultSubmodule = value;
  } catch { /* a missing optional project config has no target */ }
  let storyDescription: string | undefined;
  try {
    const storyId = basename(cardDir);
    storyDescription = parseBacklog(readFileSync(join(projectPath, ".roll", "backlog.md"), "utf8"))
      .find((row) => row.id === storyId)?.desc;
  } catch { /* an unavailable backlog simply leaves the immutable tag absent */ }
  return planManagedWorkspaceBootstrap({ storyDescription, specText, gitmodulesText, defaultSubmodule }).targetSubmodule;
}

/**
 * Build the host Delta member identity from the same portable WorkspaceSet
 * contract used by Cycle allocation.  It deliberately stores no path: the
 * allocator root is an infrastructure concern and manifests carry the member
 * locator, not a machine-local checkout name.
 *
 * Old unit fixtures are intentionally not Git repositories.  Returning
 * undefined there keeps their historical protocol records readable while all
 * real prepares get the post-cutover binding.
 */
async function resumablePreparedResult(projectPath: string, cardDir: string, input: PrepareInput): Promise<PrepareResult | undefined> {
  const lease = readHostDelegationLease(projectPath, input.storyId);
  if (lease === null) return undefined;
  const frameDir = join(cardDir, `delta-${lease.delegationId}`);
  const preparationPath = join(frameDir, "preparation.json");
  try {
    const preparation = JSON.parse(readFileSync(preparationPath, "utf8")) as {
      schema?: unknown; delegationId?: unknown; runId?: unknown; storyId?: unknown;
      workspace?: ManagedWorkspaceSet; retryBinding?: unknown;
    };
    if (preparation.schema !== "roll-delta-preparation/v2") {
      // A matching live host lease is post-cutover state.  It must never be
      // silently interpreted as a historical protocol-only record merely
      // because its immutable preparation became damaged.
      throw new PrepareError("recovery_required", "Existing host Delta has no valid v2 preparation record");
    }
    if (preparation.delegationId !== lease.delegationId || preparation.runId !== lease.runId || preparation.storyId !== input.storyId || preparation.workspace === undefined) {
      throw new PrepareError("recovery_required", "Existing managed Delta preparation does not match its retained reservation");
    }
    if (!sameRetryBinding(preparation.retryBinding, retryBinding(input))) {
      throw new PrepareError("recovery_required", "Existing managed Delta must be retried with its immutable trigger, topology, profile, preset, and resolution provenance");
    }
    const operationId = managedWorkspaceOperationId(lease.runId, "prepare");
    const eventsPath = join(projectPath, ".roll", "loop", "events.ndjson");
    try {
      await allocateManagedWorkspaceSet({ projectPath, eventsPath, workspace: preparation.workspace, operationId });
    } catch (error) {
      throw new PrepareError("recovery_required", error instanceof Error ? error.message : String(error));
    }
    return { delegationId: lease.delegationId, runId: lease.runId, frameDir, resolutionPath: join(frameDir, "role-artifacts", "delegation", "delegation-resolution.json"), markerPath: join(frameDir, "delegation-open.json"), preparationPath, eventsPath, leasePath: storyLeasesPath(projectPath), workspace: preparation.workspace };
  } catch (error) {
    if (error instanceof PrepareError) throw error;
    throw new PrepareError("recovery_required", `Existing managed Delta requires recovery: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Atomically allocate a delegation frame, lease, artifacts, and events.
 * Throws PrepareError on card resolution failure, lease conflict, or I/O issues.
 * Caller must append events after this returns successfully.
 */
/** Maximum retries for frame directory collision before failing. */
const MAX_COLLISION_RETRIES = 3;

export async function prepareDelegation(
  projectPath: string,
  input: PrepareInput,
): Promise<PrepareResult> {
  // 1. Resolve existing card directory
  const cardDir = resolveExistingUniqueCardArchiveDir(projectPath, input.storyId);
  if (!cardDir) {
    throw new PrepareError(
      "card_not_found",
      `Story ${input.storyId}: card directory not found or ambiguous`,
    );
  }

  // Ensure loop directory exists
  const loopDir = join(projectPath, ".roll", "loop");
  if (!existsSync(loopDir)) mkdirSync(loopDir, { recursive: true });
  const resumed = await resumablePreparedResult(projectPath, cardDir, input);
  if (resumed !== undefined) return resumed;

  // 2–4. Bounded retry loop for ID generation + lease claim + frame creation.
  // Frame directory collision (statistically impossible with v4 UUIDs but
  // required by AC2) retries with a fresh CSPRNG ID and only own-lease cleanup.
  // A real other-owner lease conflict (claimHostDelegationLease returns "exists")
  // is fail-loud immediately — no retry across another owner.
  let lastError: PrepareError | null = null;

  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const delegationId = generateDelegationId();
    const runId = runIdFromDelegationId(delegationId);
    let workspace: ManagedWorkspaceSet;
    try {
      workspace = await planManagedPrimaryWorkspace({
        projectPath,
        storyId: input.storyId,
        topology: input.topology,
        delegationId,
        runId,
        targetSubmodule: hostTargetSubmodule(projectPath, cardDir),
      });
    } catch (error) {
      throw new PrepareError("managed_workspace_required", error instanceof Error ? error.message : String(error));
    }

    // 3. Attempt lease claim — first claim shared authority, then write frame
    const leaseResult = claimHostDelegationLease(
      projectPath,
      input.storyId,
      delegationId,
      runId,
    );

    if (leaseResult !== "claimed") {
      // Other-owner lease exists — fail-loud, no retry
      throw new PrepareError(
        "builder_lease_conflict",
        `Story ${input.storyId}: host-delegation lease conflict (${leaseResult})`,
      );
    }

    // 4. Create frame directory.  The frame and allocation recovery fact are
    // written before the first Git effect: a killed process is therefore
    // recoverable rather than silently downgraded to a legacy Delta record.
    const frameDir = join(cardDir, `delta-${delegationId}`);
    try {
      mkdirSync(frameDir);
    } catch {
      // Own-lease collision only — release our lease and retry with new ID
      releaseHostDelegationLease(projectPath, input.storyId, delegationId, runId);
      lastError = new PrepareError(
        "builder_lease_conflict",
        `Frame directory collision for ${delegationId} (attempt ${attempt + 1}/${MAX_COLLISION_RETRIES})`,
      );
      continue;
    }

    // 5–7. Write artifacts within claimed frame (no further retry on write failure)
    try {
      // 5. Write recovery marker (delegation-open.json)
      const markerPath = join(frameDir, "delegation-open.json");
      atomicWriteJson(markerPath, {
        schema: "roll-delta-delegation-open/v1",
        delegationId,
        storyId: input.storyId,
        createdAt: new Date().toISOString(),
      });

      // 6. Bind delegation ID into resolution and persist
      const resolutionPath = join(frameDir, "role-artifacts", "delegation", "delegation-resolution.json");
      const boundResolution = {
        ...input.resolutionTemplate,
        delegationId,
      };
      atomicWriteJson(resolutionPath, boundResolution);

      // 7. Write minimal preparation metadata
      const preparationPath = join(frameDir, "preparation.json");
      atomicWriteJson(preparationPath, {
        // v2 is the explicit post-cutover discriminator.  Only persisted v1
        // frames are legacy; a new failure must never masquerade as history.
        schema: "roll-delta-preparation/v2",
        delegationId,
        runId,
        storyId: input.storyId,
        trigger: input.trigger,
        topology: input.topology,
        qualityProfile: input.qualityProfile,
        presetId: input.presetId,
        presetSha256: input.presetSha256,
        retryBinding: retryBinding(input),
        workspace,
        createdAt: new Date().toISOString(),
      });

      const eventsPath = join(loopDir, "events.ndjson");

      const operationId = managedWorkspaceOperationId(runId, "prepare");
      try {
        await allocateManagedWorkspaceSet({ projectPath, eventsPath, workspace, operationId });
      } catch (error) {
        throw new PrepareError("recovery_required", error instanceof Error ? error.message : String(error));
      }

      return {
        delegationId,
        runId,
        frameDir,
        resolutionPath,
        markerPath,
        preparationPath,
        eventsPath,
        leasePath: storyLeasesPath(projectPath),
        workspace,
      };
    } catch (err) {
      // Once a frame/recovery fact exists, preserve it and the matching lease.
      // Retrying from scratch would fabricate a legacy-looking second run and
      // make an interrupted allocation unobservable.
      throw err;
    }
  }

  // All retries exhausted — throw the last error
  throw lastError ?? new PrepareError(
    "builder_lease_conflict",
    `Story ${input.storyId}: frame directory collision after ${MAX_COLLISION_RETRIES} retries`,
  );
}

// ── Recovery marker detection ─────────────────────────────────────────────────

export interface OrphanFrameInfo {
  delegationId: string;
  frameDir: string;
  markerPath: string;
  /** Whether a matching host-delegation lease exists for this delegation's story. */
  hasMatchingLease: boolean;
}

/**
 * Detect uncommitted delegation frames (marker with no matching `delta:prepared` event)
 * and classify by lease status. Supply the event stream AND lease data so committed
 * delegations are not falsely reported and lease-matching is explicit.
 */
export function detectOrphanFrames(
  cardDir: string,
  events: readonly { type: string; delegationId?: string }[],
  leases: Record<string, { source?: string; delegationId?: string }>,
  storyId: string,
): OrphanFrameInfo[] {
  if (!existsSync(cardDir)) return [];

  // Build the set of delegationIds that have a matching `delta:prepared` event
  const committedIds = new Set<string>();
  for (const ev of events) {
    if (ev.type === "delta:prepared" && ev.delegationId) {
      committedIds.add(ev.delegationId);
    }
  }

  // Check if the story has a matching host-delegation lease
  const storyLease = leases[storyId];
  const hasLeaseForStory = storyLease?.source === "host-delegation" && !!storyLease?.delegationId;
  const leaseDelegationId = hasLeaseForStory ? storyLease?.delegationId : undefined;

  const orphans: OrphanFrameInfo[] = [];

  try {
    for (const entry of readdirSync(cardDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("delta-")) continue;
      const delegationId = entry.name.slice("delta-".length);
      const frameDir = join(cardDir, entry.name);
      const markerPath = join(frameDir, "delegation-open.json");

      // Only report if marker exists AND no matching `delta:prepared` event
      if (existsSync(markerPath) && !committedIds.has(delegationId)) {
        const hasMatchingLease = leaseDelegationId === delegationId;
        orphans.push({ delegationId, frameDir, markerPath, hasMatchingLease });
      }
    }
  } catch {
    // best-effort
  }

  return orphans;
}

/**
 * Reconcile a promoted host-Delta reservation only after delivery truth has
 * been durably recorded.  `delta:terminal` deliberately cannot release it:
 * the only release causes are a main-backed delivery reconciliation or an
 * explicit abandonment event.  This is called by the production reconcile
 * tick, not merely by a unit-test helper.
 */
export function reconcileHostDeltaReservationClosures(projectPath: string): string[] {
  const eventsPath = join(projectPath, ".roll", "loop", "events.ndjson");
  if (!existsSync(eventsPath)) return [];
  const events: Array<Record<string, unknown>> = readFileSync(eventsPath, "utf8")
    .split("\n")
    .flatMap((line) => {
      try { return line === "" ? [] : [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
  const alreadyClosed = new Set(events
    .filter((event) => event.type === "delta:reservation_closed")
    .map((event) => `${event.delegationId}:${event.runId}`));
  const closed: string[] = [];
  for (const [terminalIndex, terminal] of events.entries()) {
    if (terminal.type !== "delta:terminal" || terminal.reservationSource !== "delivery-reservation") continue;
    const storyId = terminal.storyId;
    const delegationId = terminal.delegationId;
    if (typeof storyId !== "string" || typeof delegationId !== "string") continue;
    const runId = typeof terminal.continuationRunId === "string"
      ? terminal.continuationRunId
      : typeof terminal.runId === "string" ? terminal.runId : `delta-${delegationId}`;
    if (alreadyClosed.has(`${delegationId}:${runId}`)) continue;
    // Delivery facts are only authority for the exact host handoff when they
    // occur *after* that terminal and carry its immutable delegation/run
    // identity.  Story-wide historical merge/abandon events cannot release a
    // newer reopened delivery attempt.
    const closure = events.slice(terminalIndex + 1).find((event) =>
      ((event.type === "delivery:reconciled"
        && (event.state === "delivered" || event.state === "delivered_external" || event.state === "delivered_local"))
        || event.type === "delivery:abandoned")
      && event.storyId === storyId
      && event.delegationId === delegationId
      && event.runId === runId,
    );
    const reason = closure?.type === "delivery:reconciled" ? "merged"
      : closure?.type === "delivery:abandoned" ? "abandoned"
      : undefined;
    if (reason === undefined) continue;
    if (!releaseDeliveryReservation(storyLeasesPath(projectPath), storyId, delegationId, runId, reason)) continue;
    new EventBus().appendEvent(eventsPath, {
      type: "delta:reservation_closed",
      delegationId,
      storyId,
      runId,
      reason,
      ts: Date.now(),
    });
    closed.push(storyId);
  }
  return closed;
}

type DeliveryProofMember = Readonly<{
  repositoryId: string;
  relativeLocator: string;
  deliveryBase: string;
  deliveryCommit: string;
  deliveryTree: string;
  publishRef: string;
}>;

type MemberDeliveryProof = Readonly<{
  member: DeliveryProofMember;
  repositoryPath: string;
  integrationRef: string;
  integrationHead: string;
  /** Commit whose content is known to have reached the integration history. */
  deliveredCommit: string;
}>;

function gitOutput(repositoryPath: string, args: string[], input?: string | Buffer): string {
  return execFileSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

function isAncestor(repositoryPath: string, older: string, newer: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", older, newer], {
      cwd: repositoryPath,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stable patch identity for a repository-scoped delivery range.  This compares
 * the Builder's change against the squash commit, rather than comparing their
 * whole trees: an unrelated integration commit is therefore harmless, while a
 * malicious or wrong PR still cannot borrow the current integration tree.
 */
function patchIdentity(repositoryPath: string, base: string, head: string): string | undefined {
  try {
    const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", base, head], {
      cwd: repositoryPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (patch.trim() === "") return undefined;
    const result = gitOutput(repositoryPath, ["patch-id", "--stable"], patch);
    const identity = result.split(/\s+/)[0];
    return identity === undefined || !/^[0-9a-f]{40}$/i.test(identity) ? undefined : identity;
  } catch {
    return undefined;
  }
}

function memberRepositoryPath(projectPath: string, runId: string, locator: string): string | undefined {
  const prefix = `${runId}.submodules/`;
  if (!locator.startsWith(prefix)) return projectPath;
  const submodulePath = locator.slice(prefix.length);
  if (submodulePath === "" || submodulePath.startsWith("/") || submodulePath.split("/").includes("..")) return undefined;
  return join(projectPath, submodulePath);
}

function proveMemberDelivery(projectPath: string, runId: string, member: DeliveryProofMember): MemberDeliveryProof | undefined {
  const repositoryPath = memberRepositoryPath(projectPath, runId, member.relativeLocator);
  if (repositoryPath === undefined || member.deliveryBase === "" || member.deliveryCommit === "" || member.deliveryTree === "") return undefined;
  try {
    // A persisted tree literal is authority only when it is the tree of the
    // named immutable commit in this member repository; copied facts cannot
    // prove a different PR or repository.
    if (gitOutput(repositoryPath, ["show", "-s", "--format=%T", member.deliveryCommit]) !== member.deliveryTree) return undefined;
    if (!isAncestor(repositoryPath, member.deliveryBase, member.deliveryCommit)) return undefined;
    // Preserve `origin/main` (or another configured remote ref) verbatim.
    // Replacing it with local `main` accepts stale detached submodule state.
    const integrationRef = resolveIntegrationBranch(repositoryPath);
    if (integrationRef === "") return undefined;
    const integrationHead = gitOutput(repositoryPath, ["rev-parse", integrationRef]);
    if (integrationHead === "") return undefined;
    if (isAncestor(repositoryPath, member.deliveryCommit, integrationHead)) {
      return { member, repositoryPath, integrationRef, integrationHead, deliveredCommit: member.deliveryCommit };
    }

    const branch = member.publishRef.replace(/^refs\/heads\//, "");
    if (branch === "" || branch === member.publishRef || !/^[A-Za-z0-9._/-]+$/.test(branch)) return undefined;
    let raw: string;
    try {
      raw = execFileSync("gh", ["pr", "view", branch, "--json", "state,mergedAt,mergeCommit,headRefName"], {
        cwd: repositoryPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
    } catch { return undefined; }
    let pr: { state?: unknown; mergedAt?: unknown; mergeCommit?: { oid?: unknown } | null; headRefName?: unknown };
    try { pr = JSON.parse(raw) as typeof pr; } catch { return undefined; }
    const mergeCommit = pr.mergeCommit?.oid;
    if (pr.state !== "MERGED" || typeof pr.mergedAt !== "string" || pr.mergedAt === ""
      || pr.headRefName !== branch || typeof mergeCommit !== "string" || !/^[0-9a-f]{40}$/i.test(mergeCommit)) return undefined;
    if (!isAncestor(repositoryPath, mergeCommit, integrationHead)) return undefined;
    const squashParent = gitOutput(repositoryPath, ["rev-parse", `${mergeCommit}^`]);
    const builderPatch = patchIdentity(repositoryPath, member.deliveryBase, member.deliveryCommit);
    const squashPatch = patchIdentity(repositoryPath, squashParent, mergeCommit);
    if (builderPatch === undefined || builderPatch !== squashPatch) return undefined;
    return { member, repositoryPath, integrationRef, integrationHead, deliveredCommit: mergeCommit };
  } catch {
    return undefined;
  }
}

/** A primary delivery closes a submodule member only when its gitlink adopted it. */
function primaryAdoptsSubmodule(primary: MemberDeliveryProof, submodule: MemberDeliveryProof, runId: string): boolean {
  const prefix = `${runId}.submodules/`;
  const submodulePath = submodule.member.relativeLocator.slice(prefix.length);
  if (submodulePath === "" || submodulePath.startsWith("/") || submodulePath.split("/").includes("..")) return false;
  try {
    const line = gitOutput(primary.repositoryPath, ["ls-tree", primary.integrationHead, "--", submodulePath]);
    const match = /^160000 commit ([0-9a-f]{40})\t/.exec(line);
    if (match?.[1] === undefined) return false;
    // The gitlink may intentionally point at a later integration commit, but
    // it must contain the exact delivery (or its verified squash) in that
    // submodule's real repository history.
    return isAncestor(submodule.repositoryPath, submodule.deliveredCommit, match[1]);
  } catch {
    return false;
  }
}

/**
 * Bind the manual PR → pull-main → attest lane to the exact retained host
 * reservation.  Attest is deliberately after merge in the owner workflow; it
 * is therefore the narrow production entry that can create a delivery fact for
 * a host Delta without inventing a Cycle.  A stale terminal, wrong current
 * reservation, detached checkout, or non-integration branch produces no fact.
 */
export function recordHostDeltaAttestationClosure(projectPath: string, storyId: string): boolean {
  const eventsPath = join(projectPath, ".roll", "loop", "events.ndjson");
  if (!existsSync(eventsPath)) return false;
  const events: Array<Record<string, unknown>> = readFileSync(eventsPath, "utf8")
    .split("\n")
    .flatMap((line) => {
      try { return line === "" ? [] : [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
  const terminalIndex = [...events].map((event, index) => ({ event, index })).reverse().find(({ event }) => event.type === "delta:terminal"
    && event.storyId === storyId
    && event.reservationSource === "delivery-reservation"
    && typeof event.delegationId === "string"
    && typeof event.runId === "string");
  if (terminalIndex === undefined) return false;
  const terminal = terminalIndex.event;
  const delegationId = terminal.delegationId as string;
  const runId = terminal.runId as string;
  const lease = readLeases(storyLeasesPath(projectPath))[storyId];
  if (lease?.source !== "delivery-reservation" || lease.delegationId !== delegationId || lease.runId !== runId) return false;
  if (events.some((event) => event.type === "delivery:reconciled"
    && event.storyId === storyId && event.delegationId === delegationId && event.runId === runId)) return false;
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const integration = resolveIntegrationBranch(projectPath).replace(/^origin\//, "");
    if (branch !== integration) return false;
    const mergeCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (mergeCommit === "") return false;
    // Main being non-empty is not delivery evidence.  Use the immutable
    // Builder-published fact for this exact terminal/run and require that its
    // admitted detached commit is reachable from the pulled integration tip.
    // The Builder publication must be the one from this exact managed run and
    // must predate the terminal being closed.  A stale or another-run fact for
    // the same Story/delegation cannot release a retained reservation.
    const builder = events.slice(0, terminalIndex.index).reverse().find((event) => event.type === "delta:artifact_published"
      && event.storyId === storyId
      && event.delegationId === delegationId
      && event.role === "builder"
      && event.runId === runId
      && Array.isArray(event.deliveryMembers));
    if (builder === undefined) return false;
    const allocation = events.find((event) => event.type === "worktree:allocated"
      && typeof event.workspace === "object" && event.workspace !== null
      && (event.workspace as Record<string, unknown>).runId === runId);
    const expectedMembers = allocation === undefined
      ? undefined
      : (allocation.workspace as { members?: unknown }).members;
    if (!Array.isArray(expectedMembers) || expectedMembers.length === 0) return false;
    const publishedMembers = builder.deliveryMembers as unknown[];
    if (publishedMembers.length !== expectedMembers.length) return false;
    const expectedByLocator = new Map(expectedMembers.flatMap((member) => {
      if (typeof member !== "object" || member === null) return [];
      const value = member as Record<string, unknown>;
      return typeof value.relativeLocator === "string" && typeof value.repositoryId === "string"
        ? [[value.relativeLocator, value.repositoryId] as const] : [];
    }));
    if (expectedByLocator.size !== expectedMembers.length) return false;
    const proofMembers = publishedMembers.flatMap((member) => {
      if (typeof member !== "object" || member === null) return [];
      const value = member as Record<string, unknown>;
      if (typeof value.relativeLocator !== "string" || typeof value.repositoryId !== "string"
        || typeof value.deliveryBase !== "string" || typeof value.deliveryCommit !== "string" || typeof value.deliveryTree !== "string"
        || typeof value.publishRef !== "string") return [];
      return [{
        relativeLocator: value.relativeLocator,
        repositoryId: value.repositoryId,
        deliveryBase: value.deliveryBase,
        deliveryCommit: value.deliveryCommit,
        deliveryTree: value.deliveryTree,
        publishRef: value.publishRef,
      } satisfies DeliveryProofMember];
    });
    if (proofMembers.length !== expectedMembers.length
      || new Set(proofMembers.map((member) => member.relativeLocator)).size !== proofMembers.length
      || proofMembers.some((member) => expectedByLocator.get(member.relativeLocator) !== member.repositoryId)) return false;

    const memberProofs = proofMembers.map((member) => proveMemberDelivery(projectPath, runId, member));
    if (memberProofs.some((proof) => proof === undefined)) return false;
    const proofs = memberProofs as MemberDeliveryProof[];
    const primary = proofs.find((proof) => proof.member.relativeLocator === runId);
    if (primary === undefined) return false;
    const submodules = proofs.filter((proof) => proof.member.relativeLocator.startsWith(`${runId}.submodules/`));
    // A multi-repository workspace is not delivered atomically until the
    // primary integration tree actually adopts every proved submodule commit.
    if (!submodules.every((submodule) => primaryAdoptsSubmodule(primary, submodule, runId))) return false;
    new EventBus().appendEvent(eventsPath, {
      type: "delivery:reconciled",
      cycleId: runId,
      storyId,
      state: "delivered_external",
      mergedBy: "external",
      mergeCommit,
      signal: "backlog_attest",
      delegationId,
      runId,
      ts: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}
