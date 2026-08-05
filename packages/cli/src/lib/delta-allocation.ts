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
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  rmSync,
  openSync,
  closeSync,
  fdatasyncSync,
  realpathSync,
} from "node:fs";
import { join, dirname, basename, relative, resolve, sep } from "node:path";
import { findFeatureFiles, liveEpicOf } from "./archive.js";
import { planManagedWorkspaceBootstrap } from "./target-submodule.js";
import { configResolve, projectConfigPath, resolveIntegrationBranch } from "@roll/infra";
import { EventBus, claimStoryLease, releaseDeliveryReservation, releaseStoryLease, readLeases, parseBacklog, adoptContinuationReservation } from "@roll/core";
import { managedWorkspaceOperationId } from "./managed-workspace-operation.js";
import {
  allocateManagedWorkspaceSet,
  planManagedPrimaryWorkspace,
} from "../runner/managed-workspace-allocator.js";
import { normalizeManagedWorkspaceSet } from "@roll/spec";
import type {
  DelegationTrigger,
  DeliveryTopology,
  QualityProfile,
  DelegationResolution,
  ManagedWorkspaceSet,
  DeltaContinuationProvenance,
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
  /**
   * FIX-1502 — when set, prepare only takes over the reservation that an
   * `owner_redelegate` terminal explicitly transferred to this exact named
   * successor.  The new delegation still receives a fresh standard identity.
   */
  continuationRunId?: string;
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
  /** Present when this run picked up a redelegated reservation (FIX-1502). */
  continuation?: DeltaContinuationProvenance;
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

  // FIX-1502 — a continuation pickup has its own verified path; it must never
  // fall into the plain resume and borrow an unrelated active occupancy.
  if (input.continuationRunId !== undefined) {
    return prepareContinuationPickup(projectPath, cardDir, input, input.continuationRunId);
  }

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

// ── FIX-1502 — continuation pickup ───────────────────────────────────────────

/** Parse the durable continuation provenance of a preparation record. */
function persistedContinuation(preparationPath: string): DeltaContinuationProvenance | undefined {
  try {
    const preparation = JSON.parse(readFileSync(preparationPath, "utf8")) as { continuation?: unknown };
    const c = preparation.continuation as Record<string, unknown> | undefined;
    if (typeof c?.fromDelegationId === "string" && typeof c.fromRunId === "string" && typeof c.continuationRunId === "string") {
      return { fromDelegationId: c.fromDelegationId, fromRunId: c.fromRunId, continuationRunId: c.continuationRunId };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the immutable authorization that names exactly this successor for this
 * delegation.  Normal redelegation remains unchanged.  FIX-1517 additionally
 * accepts one explicit recovery event only when it can re-prove the exact
 * managed-v2 owner_hold terminal it authorizes; a bare recovery-looking row is
 * never enough to borrow a reservation.
 */
function findContinuationAuthorization(
  eventsPath: string,
  storyId: string,
  fromDelegationId: string,
  continuationRunId: string,
): Record<string, unknown> | undefined {
  try {
    const events = readFileSync(eventsPath, "utf8").split("\n").map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
    }).filter((event): event is Record<string, unknown> => event !== undefined);
    const redelegation = events.find((event) => event.type === "delta:terminal"
      && event.storyId === storyId
      && event.delegationId === fromDelegationId
      && event.deliveryDisposition === "owner_redelegate"
      && event.continuationRunId === continuationRunId);
    if (redelegation !== undefined) return redelegation;

    const recoveries = events.filter((event) => event.type === "delta:hold_recovered"
      && event.storyId === storyId
      && event.delegationId === fromDelegationId
      && event.continuationRunId === continuationRunId
      && event.confirmation === "explicit"
      && typeof event.runId === "string");
    if (recoveries.length !== 1) return undefined;
    const recovery = recoveries[0]!;
    const prepared = events.filter((event) => event.type === "delta:prepared"
      && event.storyId === storyId
      && event.delegationId === fromDelegationId
      && event.workspaceSchema === 2
      && event.runId === recovery.runId);
    const terminals = events.filter((event) => event.type === "delta:terminal"
      && event.storyId === storyId
      && event.delegationId === fromDelegationId
      && event.runId === recovery.runId);
    if (prepared.length !== 1 || terminals.length !== 1) return undefined;
    const terminal = terminals[0]!;
    return terminal.outcome === "handoff_ready"
      && terminal.terminalBinding === "handoff_only"
      && terminal.deliveryDisposition === "owner_hold"
      ? recovery
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * FIX-1502 — an in-flight pickup frame durably recorded THIS exact pickup
 * (same source delegation and successor name) while the lease is still the
 * old reservation: a crash between the frame write and the occupancy swap.
 * Resuming that identity is the only way a retry stays the same new task;
 * forking a second identity would strand the first frame as an orphan.
 */
function findInFlightPickupFrame(
  cardDir: string,
  fromDelegationId: string,
  continuationRunId: string,
): { delegationId: string; runId: string; frameDir: string; workspace: ManagedWorkspaceSet } | undefined {
  let entries: string[] = [];
  try { entries = readdirSync(cardDir); } catch { return undefined; }
  for (const name of entries) {
    if (!name.startsWith("delta-")) continue;
    const frameDir = join(cardDir, name);
    const continuation = persistedContinuation(join(frameDir, "preparation.json"));
    if (continuation === undefined) continue;
    if (continuation.fromDelegationId !== fromDelegationId || continuation.continuationRunId !== continuationRunId) continue;
    const delegationId = name.slice("delta-".length);
    let workspace: ManagedWorkspaceSet | undefined;
    try {
      const preparation = JSON.parse(readFileSync(join(frameDir, "preparation.json"), "utf8")) as { workspace?: unknown };
      workspace = preparation.workspace as ManagedWorkspaceSet | undefined;
    } catch { /* a corrupt preparation is not a resumable pickup */ }
    // A real pickup always plans and stores its workspace atomically with the
    // preparation; a frame without one is foreign or corrupt and is left for
    // the orphan detector rather than resumed.
    if (workspace === undefined) continue;
    return { delegationId, runId: `delta-${delegationId}`, frameDir, workspace };
  }
  return undefined;
}

/**
 * Take over exactly the reservation an `owner_redelegate` terminal transferred
 * to `continuationRunId`.  Every check fails before any side effect; the new
 * frame and its preparation material (including the pickup source) are written
 * first, and only then is the occupancy atomically compare-and-swapped into a
 * normal preparing guard for the brand-new run.  The occupancy therefore never
 * disappears, and a crash is safely resumable from either side of the swap.
 */
async function prepareContinuationPickup(
  projectPath: string,
  cardDir: string,
  input: PrepareInput,
  continuationRunId: string,
): Promise<PrepareResult> {
  const storyId = input.storyId;
  const slDir = storyLeasesPath(projectPath);
  const eventsPath = join(projectPath, ".roll", "loop", "events.ndjson");
  const current = (() => {
    try { return readLeases(slDir)[storyId]; } catch { return undefined; }
  })();

  // Resume-after-swap: the occupancy is already the new run's normal guard.
  // Only a preparation that durably records THIS pickup may resume — a retry
  // must never borrow somebody else's active task.
  if (current?.source === "host-delegation" && current.delegationId !== undefined) {
    const continuation = persistedContinuation(join(cardDir, `delta-${current.delegationId}`, "preparation.json"));
    if (continuation?.continuationRunId !== continuationRunId) {
      throw new PrepareError(
        "continuation_not_available",
        `Story ${storyId}: no reservation was redelegated to '${continuationRunId}' and the current occupancy is not its pickup`,
      );
    }
    // The recorded handoff must still exist: an unverifiable pickup identity
    // is refused exactly like a fresh pickup.
    if (findContinuationAuthorization(eventsPath, storyId, continuation.fromDelegationId, continuationRunId) === undefined) {
      throw new PrepareError(
        "continuation_not_verifiable",
        `Story ${storyId}: the pickup for '${continuationRunId}' cannot be matched to a recorded redelegation`,
      );
    }
    const resumed = await resumablePreparedResult(projectPath, cardDir, input);
    if (resumed === undefined) {
      throw new PrepareError(
        "continuation_not_available",
        `Story ${storyId}: the pickup for '${continuationRunId}' no longer holds a reservable occupancy`,
      );
    }
    return { ...resumed, continuation };
  }

  if (current?.source !== "delivery-reservation"
    || current.delegationId === undefined
    || current.runId !== continuationRunId) {
    throw new PrepareError(
      "continuation_not_available",
      `Story ${storyId}: no reservation was explicitly redelegated to '${continuationRunId}'`,
    );
  }

  // The occupancy and the recorded redelegation must agree on the same card,
  // the same source delegation, and the same successor name.
  const fromDelegationId = current.delegationId;
  const authorization = findContinuationAuthorization(eventsPath, storyId, fromDelegationId, continuationRunId);
  if (authorization === undefined) {
    throw new PrepareError(
      "continuation_not_verifiable",
      `Story ${storyId}: the reservation naming '${continuationRunId}' cannot be matched to a recorded redelegation`,
    );
  }
  const fromRunId = typeof authorization.runId === "string" ? authorization.runId : `delta-${fromDelegationId}`;
  const continuation: DeltaContinuationProvenance = { fromDelegationId, fromRunId, continuationRunId };

  // Crash-before-swap resume: a frame that already durably recorded THIS
  // pickup is the same new identity — re-run the swap, never fork a second.
  const inFlight = findInFlightPickupFrame(cardDir, fromDelegationId, continuationRunId);
  if (inFlight !== undefined) {
    // The in-flight frame was planned with the SAME immutable inputs as a
    // fresh pickup: a retry with different trigger/topology/profile/preset/
    // resolution bytes must never silently swap the recorded plan for a new
    // one (the normal resume path enforces the identical binding check).
    let persistedBinding: unknown;
    try {
      const preparation = JSON.parse(readFileSync(join(inFlight.frameDir, "preparation.json"), "utf8")) as { retryBinding?: unknown };
      persistedBinding = preparation.retryBinding;
    } catch { /* a corrupt preparation is refused below via the binding check */ }
    if (!sameRetryBinding(persistedBinding, retryBinding(input))) {
      throw new PrepareError(
        "recovery_required",
        `Existing managed Delta must be retried with its immutable trigger, topology, profile, preset, and resolution provenance`,
      );
    }
    if (!adoptContinuationReservation(slDir, storyId, fromDelegationId, continuationRunId, inFlight.delegationId, inFlight.runId)) {
      throw new PrepareError(
        "continuation_adoption_failed",
        `Story ${storyId}: the reservation redelegated to '${continuationRunId}' changed while taking over; nothing was claimed`,
      );
    }
    const operationId = managedWorkspaceOperationId(inFlight.runId, "prepare");
    try {
      await allocateManagedWorkspaceSet({ projectPath, eventsPath, workspace: inFlight.workspace, operationId });
    } catch (error) {
      throw new PrepareError("recovery_required", error instanceof Error ? error.message : String(error));
    }
    return {
      delegationId: inFlight.delegationId,
      runId: inFlight.runId,
      frameDir: inFlight.frameDir,
      resolutionPath: join(inFlight.frameDir, "role-artifacts", "delegation", "delegation-resolution.json"),
      markerPath: join(inFlight.frameDir, "delegation-open.json"),
      preparationPath: join(inFlight.frameDir, "preparation.json"),
      eventsPath,
      leasePath: slDir,
      workspace: inFlight.workspace,
      continuation,
    };
  }

  let lastError: PrepareError | null = null;
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const delegationId = generateDelegationId();
    const runId = runIdFromDelegationId(delegationId);
    let workspace: ManagedWorkspaceSet;
    try {
      workspace = await planManagedPrimaryWorkspace({
        projectPath,
        storyId,
        topology: input.topology,
        delegationId,
        runId,
        targetSubmodule: hostTargetSubmodule(projectPath, cardDir),
      });
    } catch (error) {
      throw new PrepareError("managed_workspace_required", error instanceof Error ? error.message : String(error));
    }

    // Write the new frame and its preparation material BEFORE touching the
    // occupancy.  A collision retries with a fresh identity; the redelegated
    // reservation is still untouched at this point.
    const frameDir = join(cardDir, `delta-${delegationId}`);
    try {
      mkdirSync(frameDir);
    } catch {
      lastError = new PrepareError(
        "builder_lease_conflict",
        `Frame directory collision for ${delegationId} (attempt ${attempt + 1}/${MAX_COLLISION_RETRIES})`,
      );
      continue;
    }
    const markerPath = join(frameDir, "delegation-open.json");
    atomicWriteJson(markerPath, {
      schema: "roll-delta-delegation-open/v1",
      delegationId,
      storyId,
      createdAt: new Date().toISOString(),
    });
    const resolutionPath = join(frameDir, "role-artifacts", "delegation", "delegation-resolution.json");
    atomicWriteJson(resolutionPath, { ...input.resolutionTemplate, delegationId });
    const preparationPath = join(frameDir, "preparation.json");
    atomicWriteJson(preparationPath, {
      schema: "roll-delta-preparation/v2",
      delegationId,
      runId,
      storyId,
      trigger: input.trigger,
      topology: input.topology,
      qualityProfile: input.qualityProfile,
      presetId: input.presetId,
      presetSha256: input.presetSha256,
      retryBinding: retryBinding(input),
      workspace,
      continuation,
      createdAt: new Date().toISOString(),
    });

    // Atomic compare-and-swap: the reservation must still name exactly this
    // successor from exactly this delegation.  The lease file never disappears
    // during the swap; a concurrent change refuses and removes only our own
    // freshly written frame.
    if (!adoptContinuationReservation(slDir, storyId, fromDelegationId, continuationRunId, delegationId, runId)) {
      try { rmSync(frameDir, { recursive: true, force: true }); } catch { /* best effort */ }
      throw new PrepareError(
        "continuation_adoption_failed",
        `Story ${storyId}: the reservation redelegated to '${continuationRunId}' changed while taking over; nothing was claimed`,
      );
    }

    // From here the new run owns a normal preparing guard; the standard resume
    // path completes any interrupted workspace allocation.
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
      leasePath: slDir,
      workspace,
      continuation,
    };
  }
  throw lastError ?? new PrepareError(
    "builder_lease_conflict",
    `Story ${storyId}: frame directory collision after ${MAX_COLLISION_RETRIES} retries`,
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
  deliveryState?: "changed" | "unchanged";
  publishRef: string;
  /** Derived from an immutable primary gitlink; never persisted over old facts. */
  legacyDerived?: boolean;
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

/**
 * A Builder checkpoint only proves the head examined during Builder admission.
 * Once this exact host Delta is terminal, merged, and independently accepted,
 * freeze each live detached member again for the later destructive cleanup
 * check. Any missing, attached, escaping, or unreadable member leaves the old
 * records intact and produces no release authority.
 */
function recordDeliveredReleaseHeads(
  projectPath: string,
  eventsPath: string,
  runId: string,
  workspace: ManagedWorkspaceSet,
): boolean {
  const root = resolve(projectPath, ".roll", "loop", "worktrees");
  try {
    const canonicalRoot = realpathSync(root);
    const expectedHeads = workspace.members.map((member) => {
      const checkout = resolve(root, member.relativeLocator);
      const rel = relative(root, checkout);
      if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error("workspace escape");
      const canonicalCheckout = realpathSync(checkout);
      if (!canonicalCheckout.startsWith(`${canonicalRoot}${sep}`)) throw new Error("workspace escape");
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: canonicalCheckout,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (head === "") throw new Error("missing head");
      try {
        if (execFileSync("git", ["symbolic-ref", "-q", "HEAD"], {
          cwd: canonicalCheckout,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() !== "") throw new Error("attached head");
      } catch (error) {
        if (error instanceof Error && error.message === "attached head") throw error;
      }
      return { relativeLocator: member.relativeLocator, head };
    });
    const operationId = `${runId}:delivered:${createHash("sha256").update(JSON.stringify(expectedHeads)).digest("hex").slice(0, 16)}`;
    const alreadyRecorded = readFileSync(eventsPath, "utf8").split("\n").some((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.type === "worktree:release_requested"
          && event.runId === runId
          && event.reason === "delivered"
          && event.operationId === operationId;
      } catch {
        return false;
      }
    });
    if (!alreadyRecorded) new EventBus().appendEvent(eventsPath, {
      type: "worktree:release_requested",
      runId,
      reason: "delivered",
      operationId,
      expectedHeads,
      ts: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

function submoduleGitlink(repositoryPath: string, commit: string, submodulePath: string): string | undefined {
  try {
    const line = gitOutput(repositoryPath, ["ls-tree", commit, "--", submodulePath]);
    return /^160000 commit ([0-9a-f]{40})\t/.exec(line)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Old F1502-style facts recorded the child checkout HEAD even though the
 * primary delivery commit had already fixed a different child gitlink.  Do
 * not edit that fact: derive a candidate only when the old child fact is
 * exactly its allocated base and the primary's immutable delivery commit
 * proves the replacement gitlink.
 */
function deriveLegacySubmoduleMember(
  projectPath: string,
  runId: string,
  primary: DeliveryProofMember,
  member: DeliveryProofMember,
): DeliveryProofMember | undefined {
  const prefix = `${runId}.submodules/`;
  if (!member.relativeLocator.startsWith(prefix) || member.deliveryCommit !== member.deliveryBase) return undefined;
  const submodulePath = member.relativeLocator.slice(prefix.length);
  if (submodulePath === "" || submodulePath.startsWith("/") || submodulePath.split("/").includes("..")) return undefined;
  const adopted = submoduleGitlink(projectPath, primary.deliveryCommit, submodulePath);
  const allocated = submoduleGitlink(projectPath, primary.deliveryBase, submodulePath);
  if (adopted === undefined || allocated === undefined || adopted === allocated || allocated !== member.deliveryBase) return undefined;
  const repositoryPath = memberRepositoryPath(projectPath, runId, member.relativeLocator);
  if (repositoryPath === undefined) return undefined;
  try {
    const tree = gitOutput(repositoryPath, ["show", "-s", "--format=%T", adopted]);
    if (tree === "") return undefined;
    return { ...member, deliveryCommit: adopted, deliveryTree: tree, deliveryState: "changed", legacyDerived: true };
  } catch {
    return undefined;
  }
}

function githubRepository(repositoryPath: string): string | undefined {
  try {
    const remote = gitOutput(repositoryPath, ["remote", "get-url", "origin"]);
    const match = /github\.com(?::|\/)([^/]+\/[^/.]+)(?:\.git)?$/i.exec(remote);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

type ZeroContextBlocks = ReadonlyMap<string, Readonly<{ added: readonly string[][]; removed: readonly string[][] }>>;

function zeroContextBlocks(patch: string): ZeroContextBlocks | undefined {
  if (patch.trim() === "" || patch.includes("Binary files ")) return undefined;
  const blocks = new Map<string, { added: string[][]; removed: string[][] }>();
  let path: string | undefined;
  let added: string[] = [];
  let removed: string[] = [];
  const flush = () => {
    if (path === undefined) return;
    const entry = blocks.get(path) ?? { added: [], removed: [] };
    if (added.length > 0) entry.added.push(added);
    if (removed.length > 0) entry.removed.push(removed);
    blocks.set(path, entry);
    added = [];
    removed = [];
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { flush(); path = undefined; continue; }
    if (line.startsWith("+++ b/")) { flush(); path = line.slice("+++ b/".length); continue; }
    if (line.startsWith("@@ ")) { flush(); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) { added.push(line.slice(1)); continue; }
    if (line.startsWith("-") && !line.startsWith("---")) { removed.push(line.slice(1)); continue; }
    flush();
  }
  flush();
  return blocks.size === 0 ? undefined : blocks;
}

/**
 * A squash can be applied after an intervening integration commit that touches
 * the same file.  Whole-patch identity then quite correctly differs, even when
 * every source change survived the conflict resolution.  Prove the source
 * content instead: each zero-context added block must be present at the same
 * path in the squash result and each removed block must be absent.  Binary,
 * renamed, malformed, or context-free changes are rejected unless the source
 * and squash blobs are exactly equal.  This is deliberately conservative.
 */
function sourceContentSurvivesSquash(repositoryPath: string, base: string, source: string, squash: string): boolean {
  let sourcePatch: string;
  let squashPatch: string;
  try {
    sourcePatch = execFileSync("git", ["diff", "--no-ext-diff", "--no-renames", "--unified=0", base, source], {
      cwd: repositoryPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    squashPatch = execFileSync("git", ["diff", "--no-ext-diff", "--no-renames", "--unified=0", `${squash}^`, squash], {
      cwd: repositoryPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return false; }
  const sourceBlocks = zeroContextBlocks(sourcePatch);
  const mergedBlocks = zeroContextBlocks(squashPatch);
  if (sourceBlocks === undefined || mergedBlocks === undefined) return false;
  const containsBlock = (blocks: readonly string[][], sourceBlock: readonly string[]) =>
    sourceBlock.length > 0 && blocks.some((block) => block.some((_, start) => sourceBlock.every((line, index) => block[start + index] === line)));
  for (const [changedPath, delta] of sourceBlocks) {
    if (changedPath === "" || changedPath.startsWith("/") || changedPath.split("/").includes("..")) return false;
    // The matching text must have been added by this squash, not merely have
    // existed in its parent or elsewhere on the child integration branch.
    if (delta.added.some((block) => !containsBlock(mergedBlocks.get(changedPath)?.added ?? [], block))) return false;
    let target = "";
    try { target = gitOutput(repositoryPath, ["show", `${squash}:${changedPath}`]); } catch {
      if (delta.added.length > 0) return false;
    }
    const targetLines = target === "" ? [] : target.split("\n");
    const contains = (block: string[]) => block.length > 0 && targetLines.some((_, start) => block.every((line, index) => targetLines[start + index] === line));
    if (delta.removed.some((block) => contains(block))) return false;
  }
  return true;
}

function proveLegacySquash(
  repositoryPath: string,
  member: DeliveryProofMember,
  integrationRef: string,
  integrationHead: string,
): string | undefined {
  const repository = githubRepository(repositoryPath);
  const integrationBranch = integrationRef.replace(/^origin\//, "");
  if (repository === undefined || integrationBranch === "") return undefined;
  let raw: string;
  try {
    raw = execFileSync("gh", ["api", `repos/${repository}/commits/${member.deliveryCommit}/pulls`], {
      cwd: repositoryPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return undefined; }
  let candidates: unknown;
  try { candidates = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(candidates)) return undefined;
  const matches = candidates.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const pr = candidate as Record<string, unknown>;
    const base = pr.base as Record<string, unknown> | undefined;
    const head = pr.head as Record<string, unknown> | undefined;
    const baseRepo = base?.repo as Record<string, unknown> | undefined;
    const headRepo = head?.repo as Record<string, unknown> | undefined;
    const merge = pr.merge_commit_sha;
    const headSha = head?.sha;
    if (typeof pr.merged_at !== "string" || pr.merged_at === "" || typeof merge !== "string" || !/^[0-9a-f]{40}$/i.test(merge)
      || typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)
      || base?.ref !== integrationBranch
      || baseRepo?.full_name?.toString().toLowerCase() !== repository
      || headRepo?.full_name?.toString().toLowerCase() !== repository
      || !isAncestor(repositoryPath, member.deliveryCommit, headSha)
      || !isAncestor(repositoryPath, merge, integrationHead)) return [];
    const squashParent = gitOutput(repositoryPath, ["rev-parse", `${merge}^`]);
    return sourceContentSurvivesSquash(repositoryPath, member.deliveryBase, member.deliveryCommit, merge)
      && isAncestor(repositoryPath, squashParent, merge) ? [merge] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
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

    if (member.legacyDerived === true) {
      const mergeCommit = proveLegacySquash(repositoryPath, member, integrationRef, integrationHead);
      return mergeCommit === undefined ? undefined : { member, repositoryPath, integrationRef, integrationHead, deliveredCommit: mergeCommit };
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
    // A primary may pin the original PR commit while the child independently
    // squash-merges it.  The squash proof above binds that exact source commit
    // to the integration merge; accepting the equality here is therefore not
    // a branch-name shortcut.  A later integration gitlink remains valid only
    // when it contains the verified delivered commit.
    return match[1] === submodule.member.deliveryCommit
      || isAncestor(submodule.repositoryPath, submodule.deliveredCommit, match[1]);
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
export function recordHostDeltaAttestationClosure(projectPath: string, storyId: string, acceptanceReportPath: string): boolean {
  const eventsPath = join(projectPath, ".roll", "loop", "events.ndjson");
  if (!existsSync(eventsPath)) return false;
  if (!acceptanceReportPath.startsWith(".roll/") || acceptanceReportPath.split("/").includes("..")) return false;
  try {
    if (readFileSync(join(projectPath, acceptanceReportPath), "utf8").trim() === "") return false;
  } catch { return false; }
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
  const postTerminal = events.slice(terminalIndex.index + 1);
  const existingDelivery = postTerminal.some((event) => event.type === "delivery:reconciled"
    && event.storyId === storyId
    && event.delegationId === delegationId
    && event.runId === runId
    && (event.state === "delivered" || event.state === "delivered_external" || event.state === "delivered_local"));
  if (existingDelivery) {
    // A normal re-attest may repair only the missing terminal freeze for this
    // already-proved host handoff. It never infers delivery from a terminal or
    // a Builder checkpoint: both the exact delivery fact and independent host
    // acceptance must already exist, and a released run is immutable.
    const accepted = postTerminal.some((event) => event.type === "attest:host_delta"
      && event.cycleId === runId
      && event.storyId === storyId
      && event.delegationId === delegationId);
    const released = events.some((event) => event.type === "worktree:released" && event.runId === runId);
    const allocation = events.find((event) => event.type === "worktree:allocated"
      && typeof event.workspace === "object" && event.workspace !== null
      && (event.workspace as Record<string, unknown>).runId === runId);
    const workspace = allocation === undefined ? undefined : normalizeManagedWorkspaceSet(allocation.workspace);
    return accepted
      && !released
      && workspace !== undefined
      && workspace.ok
      && workspace.value.runId === runId
      && recordDeliveredReleaseHeads(projectPath, eventsPath, runId, workspace.value);
  }
  const lease = readLeases(storyLeasesPath(projectPath))[storyId];
  if (lease?.source !== "delivery-reservation" || lease.delegationId !== delegationId || lease.runId !== runId) return false;
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
    const normalizedWorkspace = allocation === undefined
      ? undefined
      : normalizeManagedWorkspaceSet(allocation.workspace);
    if (normalizedWorkspace === undefined || !normalizedWorkspace.ok || normalizedWorkspace.value.runId !== runId) return false;
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
        ...(value.deliveryState === "changed" || value.deliveryState === "unchanged" ? { deliveryState: value.deliveryState } : {}),
        publishRef: value.publishRef,
      } satisfies DeliveryProofMember];
    });
    if (proofMembers.length !== expectedMembers.length
      || new Set(proofMembers.map((member) => member.relativeLocator)).size !== proofMembers.length
      || proofMembers.some((member) => expectedByLocator.get(member.relativeLocator) !== member.repositoryId)) return false;

    const primaryMember = proofMembers.find((member) => member.relativeLocator === runId);
    if (primaryMember === undefined) return false;
    const resolvedMembers = proofMembers.map((member) => {
      if (member.relativeLocator === runId) return member;
      return deriveLegacySubmoduleMember(projectPath, runId, primaryMember, member) ?? member;
    });
    const memberProofs = resolvedMembers.map((member) => proveMemberDelivery(projectPath, runId, member));
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
    // The caller is the successful story-scoped attest command.  Record its
    // rendered acceptance-report evidence so the managed-worktree audit can release
    // only this proven delivery, rather than treating the lack of a synthetic
    // runner cycle as missing evidence.
    new EventBus().appendEvent(eventsPath, {
      type: "attest:host_delta",
      cycleId: runId,
      storyId,
      delegationId,
      reportPath: acceptanceReportPath,
      ts: Date.now(),
    });
    // Builder admission records a pre-terminal checkpoint, not deletion
    // authority. With this exact terminal now independently proved and
    // accepted, a new delivered request freezes the actual detached members
    // for cleanup. Failure to inspect every member remains fail-closed: the
    // delivery facts stay true, but audit cannot release the workspace.
    recordDeliveredReleaseHeads(projectPath, eventsPath, runId, normalizedWorkspace.value);
    return true;
  } catch {
    return false;
  }
}
