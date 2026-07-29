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
} from "node:fs";
import { join, dirname } from "node:path";
import { findFeatureFiles, liveEpicOf } from "./archive.js";
import { claimStoryLease, releaseStoryLease, readLeases } from "@roll/core";
import type {
  DelegationTrigger,
  DeliveryTopology,
  QualityProfile,
  DelegationResolution,
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
  // Strategy 1: Find feature files for this story
  const files = findFeatureFiles(projectPath, storyId);
  if (files.length === 1) {
    const epic = liveEpicOf(projectPath, storyId);
    if (epic) {
      return join(projectPath, ".roll", "features", epic, storyId);
    }
  } else if (files.length > 1) {
    return null; // ambiguous
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
  resolutionTemplate: DelegationResolution;
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
}

/**
 * Atomically allocate a delegation frame, lease, artifacts, and events.
 * Throws PrepareError on card resolution failure, lease conflict, or I/O issues.
 * Caller must append events after this returns successfully.
 */
/** Maximum retries for frame directory collision before failing. */
const MAX_COLLISION_RETRIES = 3;

export function prepareDelegation(
  projectPath: string,
  input: PrepareInput,
): PrepareResult {
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

  // 2–4. Bounded retry loop for ID generation + lease claim + frame creation.
  // Frame directory collision (statistically impossible with v4 UUIDs but
  // required by AC2) retries with a fresh CSPRNG ID and only own-lease cleanup.
  // A real other-owner lease conflict (claimHostDelegationLease returns "exists")
  // is fail-loud immediately — no retry across another owner.
  let lastError: PrepareError | null = null;

  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const delegationId = generateDelegationId();
    const runId = runIdFromDelegationId(delegationId);

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

    // 4. Create frame directory
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
        schema: "roll-delta-preparation/v1",
        delegationId,
        runId,
        storyId: input.storyId,
        trigger: input.trigger,
        topology: input.topology,
        qualityProfile: input.qualityProfile,
        presetId: input.presetId,
        presetSha256: input.presetSha256,
        createdAt: new Date().toISOString(),
      });

      const eventsPath = join(loopDir, "events.ndjson");

      return {
        delegationId,
        runId,
        frameDir,
        resolutionPath,
        markerPath,
        preparationPath,
        eventsPath,
        leasePath: storyLeasesPath(projectPath),
      };
    } catch (err) {
      // Cleanup on write failure
      releaseHostDelegationLease(projectPath, input.storyId, delegationId, runId);
      try { rmSync(frameDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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
