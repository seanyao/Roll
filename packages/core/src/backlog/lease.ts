/**
 * Story lease — who claimed the card and when.
 *
 * FIX-1211: a lease distinguishes "the loop picked this" from "a human (or
 * another loop instance) preempted this". The picker rejects In Progress rows
 * regardless, but the UNSTICK/reclaim path consults leases:
 *
 *   1. A story WITH a loop lease and a dead PID -> eligible for death-recovery
 *      (the original starvation-prevention semantics).
 *   2. A human/supervisor preemption is explicit: either this file carries a
 *      human-style lease, or legacy backlog text carries a claim timestamp.
 *      A story WITHOUT any lease or annotation is still a dead-claim candidate
 *      during preflight reclaim.
 *
 * US-DELTA-003 (architecture adjudication a6318229): lease authority is a
 * directory of per-story canonical lease records, one file per story:
 *
 *   `.roll/loop/leases/<storyId>.lease`
 *
 * Each file is a single newline-terminated JSON `LeaseEntry`. The atomic claim
 * primitive is hardlink no-clobber (temp write + fdatasync + linkSync with
 * EEXIST detection + parent-dir fsync + temp unlink). There is no lock file
 * and no JSON read-modify-write. The legacy `story-leases.json` JSON map is
 * **read-only fallback** — never written, renamed, retired, or migrated.
 *
 * readLeases returns a merge-read: canonical records ∪ legacy entries for
 * storyIds not present canonically (canonical precedence). Legacy owners
 * are always visible and never hidden by canonical directory presence.
 */

import {
  existsSync,
  fdatasyncSync,
  linkSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** How long an explicit human/supervisor In Progress claim is respected. */
export const HUMAN_SOFT_LEASE_HOURS = 24;

/** Recognised claim sources. */
export type LeaseSource = "cycle" | "human" | "supervisor" | "host-delegation" | "skill-dispatch" | "delivery-reservation";

const VALID_SOURCES: ReadonlySet<string> = new Set([
  "cycle",
  "human",
  "supervisor",
  "host-delegation",
  "skill-dispatch",
  "delivery-reservation",
]);

/** A lease entry — who claimed a story and when. */
export interface LeaseEntry {
  /** Process id of the claiming agent (or undefined for human/supervisor). */
  pid?: number;
  /** Epoch ms of the claim. */
  claimedAt: number;
  /** Who claimed it. */
  source: LeaseSource;
  /** Host delegation identity — only meaningful when source === "host-delegation". */
  delegationId?: string;
  /** Run ID for a protocol-owned reservation. */
  runId?: string;
}

/**
 * Lease store shape — a plain Record<storyId, LeaseEntry>.
 * The on-disk authority is a directory of per-story `.lease` files.
 */
export type LeaseMap = Record<string, LeaseEntry>;

/** File extension for per-story lease records. */
const LEASE_EXT = ".lease";

// ─── Path helpers ───────────────────────────────────────────────────────────

/** Canonical path to the leases directory. */
export function leaseDirPath(eventsDirOrLoopDir: string): string {
  if (eventsDirOrLoopDir.endsWith("loop") || eventsDirOrLoopDir.endsWith("loop/")) {
    return join(eventsDirOrLoopDir, "leases");
  }
  return join(dirname(eventsDirOrLoopDir), "leases");
}

/** Legacy single-file lease path (for read-only fallback). */
export function legacyLeasePath(loopDir: string): string {
  return join(loopDir, "story-leases.json");
}

/** Per-story record file path. */
function recordPath(dirPath: string, storyId: string): string {
  return join(dirPath, `${storyId}${LEASE_EXT}`);
}

// ─── Shared strict decoder (adjudication mandatory change 3) ────────────────

/** Encode a single lease entry for storage. */
function encodeEntry(entry: LeaseEntry): string {
  return JSON.stringify(entry) + "\n";
}

/**
 * Strictly decode and validate a single lease entry from parsed JSON.
 *
 * Rejects: non-plain-object roots, arrays, null, unknown `source` values,
 * non-finite/missing `claimedAt`. Does NOT require per-source identity
 * fields (pid, delegationId, runId) — legacy human/supervisor entries
 * legitimately lack pid, and host-delegation identity is enforced at
 * claim time, not decode time.
 *
 * Applied identically to canonical `.lease` records and legacy fallback
 * entries (adjudication mandatory change 3).
 */
function decodeEntryStrict(raw: unknown): LeaseEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    const found = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
    throw new Error(`Lease entry is not a plain object (got ${found})`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.source !== "string" || !VALID_SOURCES.has(e.source)) {
    throw new Error(
      `Invalid lease source: ${JSON.stringify(e.source)} (expected one of ${[...VALID_SOURCES].join(", ")})`,
    );
  }
  if (typeof e.claimedAt !== "number" || !isFinite(e.claimedAt)) {
    throw new Error(
      `Invalid lease claimedAt: ${JSON.stringify(e.claimedAt)} (expected finite number)`,
    );
  }
  return e as unknown as LeaseEntry;
}

/**
 * Validate legacy file root shape — must be a plain object, not array/null/scalar.
 * Throws with a descriptive message on failure.
 */
function validateLegacyRoot(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    const found = raw === null ? "null" : typeof raw;
    throw new Error(`Legacy lease file root is not a valid JSON object (got ${found})`);
  }
  if (Array.isArray(raw)) {
    throw new Error(`Legacy lease file root is an array, not a plain object`);
  }
  return raw as Record<string, unknown>;
}

// ─── Read (merge-read with canonical precedence) ────────────────────────────

/**
 * Read all lease entries from canonical directory + legacy fallback.
 *
 * Adjudication mandatory change 2: merge-read with canonical precedence.
 *   1. Read every canonical `.lease` file (fail-loud on malformed records).
 *   2. Read legacy `story-leases.json` for storyIds not present canonically
 *      (read-only, canonical precedence). Fail-loud on malformed legacy.
 *
 * Legacy `story-leases.json` is NEVER written, renamed, retired, or migrated.
 * It remains byte-identical and serves as read-only fallback for storyIds
 * absent from the canonical directory.
 */
export function readLeases(dirPath: string): LeaseMap {
  const map: LeaseMap = {};

  // Step 1: read every canonical `.lease` record
  if (existsSync(dirPath)) {
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      // Directory exists but unreadable — fail-loud
      throw new Error(`Cannot read lease directory: ${dirPath}`);
    }
    for (const entry of entries) {
      if (!entry.endsWith(LEASE_EXT)) continue;
      const storyId = entry.slice(0, -LEASE_EXT.length);
      const filePath = join(dirPath, entry);
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch {
        throw new Error(`Cannot read canonical lease record: ${filePath}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        throw new Error(
          `Malformed canonical lease record ${entry}: invalid JSON`,
        );
      }
      const decoded = decodeEntryStrict(parsed);
      map[storyId] = decoded;
    }
  }

  // Step 2: overlay legacy for absent storyIds (read-only, canonical precedence)
  const parentDir = dirname(dirPath);
  const legacyPath = join(parentDir, "story-leases.json");
  if (existsSync(legacyPath)) {
    let raw: string;
    try {
      raw = readFileSync(legacyPath, "utf8");
    } catch {
      throw new Error(`Cannot read legacy lease file: ${legacyPath}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Legacy lease file ${legacyPath} contains invalid JSON`,
      );
    }
    const legacyRoot = validateLegacyRoot(parsed);
    for (const [id, entryRaw] of Object.entries(legacyRoot)) {
      if (map[id] !== undefined) continue; // canonical precedence
      const decoded = decodeEntryStrict(entryRaw);
      map[id] = decoded;
    }
  }

  return map;
}

/** Write the full lease map to disk as per-story record files. */
export function writeLeases(dirPath: string, leases: LeaseMap): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  // Write each story lease as a separate file
  for (const [storyId, entry] of Object.entries(leases)) {
    const rp = recordPath(dirPath, storyId);
    writeFileSync(rp, encodeEntry(entry), "utf8");
    const fd = openSync(rp, "r+");
    fdatasyncSync(fd);
    closeSync(fd);
  }
  // fsync parent directory
  const dirFd = openSync(dirPath, "r");
  fdatasyncSync(dirFd);
  closeSync(dirFd);
}

/**
 * Upsert a single lease. Writes a per-story record file.
 * Only for batch/non-atomic use (setup, test fixtures). For concurrent
 * atomic claims, use `claimStoryLease`.
 */
export function setLease(dirPath: string, storyId: string, entry: LeaseEntry): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  const rp = recordPath(dirPath, storyId);

  // Atomic write via temp + fsync + rename (not hardlink — this is the
  // non-contended batch writer; concurrent claims must use claimStoryLease).
  const tmpPath = join(dirPath, `${storyId}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmpPath, encodeEntry(entry), "utf8");
  const tmpFd = openSync(tmpPath, "r+");
  fdatasyncSync(tmpFd);
  closeSync(tmpFd);

  // Use rename (overwrite) — setLease is for test fixtures and batch init,
  // not concurrent atomic claim. No-clobber claims use claimStoryLease.
  try {
    if (existsSync(rp)) unlinkSync(rp);
  } catch {
    // ok if absent
  }
  try {
    linkSync(tmpPath, rp);
  } catch {
    // If link fails (directory/perms), fallback to overwrite write
    writeFileSync(rp, readFileSync(tmpPath, "utf8"), "utf8");
    const fd = openSync(rp, "r+");
    fdatasyncSync(fd);
    closeSync(fd);
  }
  try { unlinkSync(tmpPath); } catch { /* best-effort */ }

  const dirFd = openSync(dirPath, "r");
  fdatasyncSync(dirFd);
  closeSync(dirFd);
}

// ─── Atomic claim / release (US-DELTA-003 hardlink no-clobber) ──────────────

/** Outcome of an atomic story lease claim. */
export type ClaimResult =
  | { status: "claimed" }
  | { status: "conflict"; existingSource: LeaseSource }
  | { status: "exists"; existingSource: LeaseSource; existingDelegationId?: string };

// ─── Filesystem operations seam ────────────────────────────────────────────

/** Narrow filesystem operations used by the no-clobber claim protocol.
 *  Each maps to exactly one durable step. Production default uses real
 *  node:fs. Tests inject a spy that records operations + paths and can
 *  throw at any step to simulate I/O failure.
 *
 *  Simplified per adjudication: only serves the final hardlink claim,
 *  not legacy migration. `renameFile` and `mkdir` removed.
 */
export interface ClaimStepOps {
  /** Write complete owner record to a unique temp file. */
  writeTempFile(path: string, data: string): void;
  /** Open a file or directory for fsync. flags: "r+" for file, "r" for dir. */
  openFile(path: string, flags: string): number;
  /** fdatasync an open file descriptor. */
  fsyncFile(fd: number): void;
  /** Close an open file descriptor. */
  closeFile(fd: number): void;
  /** Hard-link temp to final record path (no-clobber; EEXIST = conflict). */
  hardLink(existingPath: string, newPath: string): void;
  /** Remove a temp file after successful claim or on conflict cleanup. */
  unlinkFile(path: string): void;
}

const defaultClaimOps: ClaimStepOps = {
  writeTempFile: (path, data) => writeFileSync(path, data, "utf8"),
  openFile: (path, flags) => openSync(path, flags),
  fsyncFile: (fd) => fdatasyncSync(fd),
  closeFile: (fd) => closeSync(fd),
  hardLink: (src, dest) => linkSync(src, dest),
  unlinkFile: (path) => unlinkSync(path),
};

let _injectedClaimOps: ClaimStepOps | null = null;

function claimOps(): ClaimStepOps {
  return _injectedClaimOps ?? defaultClaimOps;
}

/** Inject a filesystem operations seam for testing the claim protocol.
 *  Call with null to reset to production defaults. */
export function injectClaimOps(ops: ClaimStepOps | null): void {
  _injectedClaimOps = ops;
}

/**
 * Atomically claim a story lease using hardlink no-clobber.
 *
 * Protocol (plan §6.1, architecture adjudication):
 *   0. Strictly validate ALL legacy entries before any side effect
 *      (BLOCK-1: malformed unrelated entry throws, zero new canonical)
 *   1. Check canonical record first (canonical precedence, BLOCK-2)
 *   2. Check legacy for same-story only when canonical absent
 *   3. Ensure canonical directory exists (mkdir idempotent)
 *   4. Write complete owner record to same-directory unique temp file
 *   5. fdatasync temp file (with FD cleanup on failure)
 *   6. linkSync(temp, final) — EEXIST means another owner won (no overwrite)
 *      Malformed canonical on EEXIST throws integrity error (BLOCK-2)
 *   7. fdatasync parent directory (dir FD tracked & closed on fault, BLOCK-4)
 *   8. unlink temp file
 *
 * No lock file. No JSON read-modify-write. The hardlink is the sole
 * mutual-exclusion primitive — EEXIST = conflict.
 *
 * Legacy `story-leases.json` is read-only exclusion input. It is NEVER
 * written, renamed, retired, migrated, or deleted. Every legacy entry
 * is strictly decoded before any mkdir/temp/hardlink (BLOCK-1). If a
 * valid legacy entry exists for the same storyId and no canonical record
 * exists, the claim returns `exists` and no canonical record is created.
 *
 * Host-delegation and Skill-dispatch claims carry their durable run identity
 * for match-only release.
 *
 * @param dirPath  Path to the leases directory (e.g. `.roll/loop/leases`)
 * @param storyId  The story id to claim
 * @param entry    The lease entry (pid, source, claimedAt, delegationId, runId)
 */
export function claimStoryLease(
  dirPath: string,
  storyId: string,
  entry: LeaseEntry,
): ClaimResult {
  // Host-delegation claims MUST carry delegationId for match-only release
  if (entry.source === "host-delegation" && !entry.delegationId) {
    throw new Error("claimStoryLease: host-delegation source requires delegationId");
  }
  if (entry.source === "skill-dispatch" && !entry.runId) {
    throw new Error("claimStoryLease: skill-dispatch source requires runId");
  }

  // ═══ Step 0: Validate ALL legacy entries before any side effect ═══
  // (BLOCK-1: every legacy entry must pass strict decode; any malformed
  // unrelated entry throws with zero canonical dir/record/temp and
  // unchanged legacy bytes.)
  const parentDir = dirname(dirPath);
  const legacyPath = join(parentDir, "story-leases.json");
  const validatedLegacy: Record<string, LeaseEntry> = {};
  if (existsSync(legacyPath)) {
    let raw: string;
    try {
      raw = readFileSync(legacyPath, "utf8");
    } catch {
      throw new Error(`Cannot read legacy lease file: ${legacyPath}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Legacy lease file ${legacyPath} contains invalid JSON`,
      );
    }
    const legacyRoot = validateLegacyRoot(parsed);
    for (const [id, entryRaw] of Object.entries(legacyRoot)) {
      validatedLegacy[id] = decodeEntryStrict(entryRaw);
    }
  }

  // ═══ Step 1: Check canonical directory first (canonical precedence) ═══
  // (BLOCK-2: canonical wins over legacy; malformed canonical throws
  // deterministic integrity error, never fabricates existingSource:"cycle".)
  if (existsSync(dirPath)) {
    const rp = recordPath(dirPath, storyId);
    if (existsSync(rp)) {
      let raw: string;
      try {
        raw = readFileSync(rp, "utf8");
      } catch {
        throw new Error(`Cannot read canonical lease record for ${storyId}`);
      }
      let parsedCanon: unknown;
      try {
        parsedCanon = JSON.parse(raw.trim());
      } catch {
        throw new Error(
          `Malformed canonical lease record for ${storyId}: invalid JSON`,
        );
      }
      const existing = decodeEntryStrict(parsedCanon);
      return {
        status: "exists",
        existingSource: existing.source,
        existingDelegationId: existing.delegationId,
      };
    }
  }

  // ═══ Step 2: Check legacy for same-story conflict only when canonical absent ═══
  if (validatedLegacy[storyId] !== undefined) {
    const existing = validatedLegacy[storyId];
    return {
      status: "exists",
      existingSource: existing.source,
      existingDelegationId: existing.delegationId,
    };
  }

  // ═══ Step 3: Ensure canonical directory exists ═══
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  // ═══ Steps 4-8: Hardlink no-clobber claim with full FD lifecycle ═══
  const rp = recordPath(dirPath, storyId);
  const tmpPath = join(
    dirPath,
    `${storyId}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  const ops = claimOps();

  // Track all file descriptors and hardlink success for accurate cleanup.
  // BLOCK-4: directory FD is tracked and closed on every post-link fault;
  // pre-link vs post-link temp cleanup policies are enforced separately.
  let tmpFd = -1;
  let dirFd = -1;
  let hardLinkSucceeded = false;
  try {
    // Step 4: Write complete owner record to unique temp file
    ops.writeTempFile(tmpPath, encodeEntry(entry));

    // Step 5: fdatasync temp file
    tmpFd = ops.openFile(tmpPath, "r+");
    ops.fsyncFile(tmpFd);
    ops.closeFile(tmpFd);
    tmpFd = -1; // descriptor closed successfully

    // Step 6: Hardlink — EEXIST means someone beat us
    try {
      ops.hardLink(tmpPath, rp);
    } catch (err: unknown) {
      // Clean up temp on any hardLink error
      try { ops.unlinkFile(tmpPath); } catch { /* best-effort */ }

      const code = (err as { code?: string }).code;
      if (code === "EEXIST") {
        // Another owner's hardlink exists — read their record for conflict info.
        // BLOCK-2: malformed canonical record must throw deterministic integrity
        // error, never fabricate existingSource:"cycle".
        let rawExisting: string;
        try {
          rawExisting = readFileSync(rp, "utf8");
        } catch {
          throw new Error(
            `Cannot read canonical lease record for ${storyId}`,
          );
        }
        let parsedExisting: unknown;
        try {
          parsedExisting = JSON.parse(rawExisting.trim());
        } catch {
          throw new Error(
            `Malformed canonical lease record for ${storyId}: invalid JSON`,
          );
        }
        const existing = decodeEntryStrict(parsedExisting);
        return {
          status: "exists",
          existingSource: existing.source,
          existingDelegationId: existing.delegationId,
        };
      }
      throw err;
    }
    hardLinkSucceeded = true;

    // Step 7: fdatasync parent directory
    dirFd = ops.openFile(dirPath, "r");
    ops.fsyncFile(dirFd);
    ops.closeFile(dirFd);
    dirFd = -1; // directory descriptor closed successfully

    // Step 8: Remove temp file (best-effort — lease is already claimed)
    try { ops.unlinkFile(tmpPath); } catch { /* best-effort */ }

    return { status: "claimed" };
  } catch (err) {
    // Always close any open descriptors (BLOCK-4)
    if (tmpFd >= 0) {
      try { ops.closeFile(tmpFd); } catch { /* close itself failed */ }
    }
    if (dirFd >= 0) {
      try { ops.closeFile(dirFd); } catch { /* close itself failed */ }
    }

    // Temp cleanup policy (BLOCK-4):
    //   Pre-link (hardLinkSucceeded === false): unlink temp so retries succeed.
    //   Post-link (hardLinkSucceeded === true):  lease IS already claimed;
    //     temp cleanup is best-effort, NOT required for correctness.
    if (!hardLinkSucceeded) {
      try {
        if (existsSync(tmpPath)) ops.unlinkFile(tmpPath);
      } catch { /* best-effort */ }
    }
    throw err;
  }
}

/**
 * Release a story lease with identity match.
 *
 * Match-only contract:
 * - `source` must match the lease entry's source.
 * - For `host-delegation` source: `delegationId` AND `runId` must all match.
 * - For `cycle` source: `pid` must also match; when a durable `runId` is
 *   recorded, it must match as well (legacy pid-only leases remain readable).
 * - Never deletes other owners' entries.
 *
 * Returns `true` if the lease was released, `false` if identity mismatch
 * or no lease existed.
 */
export interface ReleaseIdentity {
  source: LeaseSource;
  pid?: number;
  delegationId?: string;
  runId?: string;
}

export function releaseStoryLease(
  dirPath: string,
  storyId: string,
  identity: ReleaseIdentity,
): boolean {
  const rp = recordPath(dirPath, storyId);
  if (!existsSync(rp)) return false;

  let existing: LeaseEntry;
  try {
    const raw = readFileSync(rp, "utf8");
    const parsed = JSON.parse(raw.trim());
    existing = decodeEntryStrict(parsed);
  } catch {
    return false;
  }

  // Source must match
  if (existing.source !== identity.source) return false;

  // Protocol and durable delivery reservations are both identity-owned.  A
  // merge, abandonment, or named continuation may release only its own run.
  if (identity.source === "host-delegation" || identity.source === "delivery-reservation") {
    if (
      !identity.delegationId ||
      !identity.runId ||
      existing.delegationId !== identity.delegationId ||
      existing.runId !== identity.runId
    ) {
      return false;
    }
  }

  // A dispatch reservation belongs to its parent DeliveryRun. Children never
  // receive this identity, so they cannot release the Story reservation.
  if (identity.source === "skill-dispatch") {
    if (!identity.runId || existing.runId !== identity.runId) return false;
  }

  // FIX-1502 — a durable delivery reservation release shares the same mutex
  // as adoption: verify the identity and unlink while holding it, so a pickup
  // can never swap the record between our identity read and the unlink.  The
  // lease filename therefore never disappears mid-swap; if the pickup holds
  // the mutex right now, the release is refused and retried later.
  if (identity.source === "delivery-reservation") {
    const mutex = acquireAdoptionMutex(dirPath, storyId, "release");
    if (mutex === undefined) return false;
    try {
      const current = (() => {
        try { return decodeEntryStrict(JSON.parse(readFileSync(rp, "utf8").trim())); } catch { return undefined; }
      })();
      if (current?.source !== "delivery-reservation"
        || current.delegationId !== identity.delegationId
        || current.runId !== identity.runId) return false;
      unlinkSync(rp);
      fsyncDir(dirPath);
      return true;
    } catch {
      return false;
    } finally {
      releaseAdoptionMutex(dirPath, storyId, mutex);
    }
  }

  // Other sources keep the historical refusal while a promotion, a named
  // continuation transfer, or a pickup swap holds its short-lived mutex.
  if (existsSync(join(dirPath, `.${storyId}.promotion.lock`))
    || existsSync(join(dirPath, `.${storyId}.continuation.lock`))
    || existsSync(join(dirPath, `.${storyId}.adoption.lock`))) return false;

  // For cycle: pid is REQUIRED and must match
  if (identity.source === "cycle") {
    if (identity.pid === undefined) return false;
    if (existing.pid !== identity.pid) return false;
    if (existing.runId !== undefined && existing.runId !== identity.runId) return false;
  }

  // Match confirmed — remove the record
  try {
    unlinkSync(rp);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically turn the protocol guard into its durable delivery reservation.
 *
 * The lease filename is deliberately retained while its complete JSON record is
 * replaced in the same directory.  A competing hard-link claimant therefore
 * always observes a record: there is no release/reclaim gap between terminal
 * handoff and normal delivery reconciliation.
 */
export function promoteHostDelegationLease(
  dirPath: string,
  storyId: string,
  delegationId: string,
  runId: string,
): boolean {
  const path = recordPath(dirPath, storyId);
  if (!existsSync(path)) return false;
  const promotionLock = join(dirPath, `.${storyId}.promotion.lock`);
  type PromotionLock = Readonly<{
    schema: "roll-lease-promotion-lock/v1";
    pid: number;
    token: string;
    delegationId: string;
    runId: string;
    recordDev: number;
    recordIno: number;
  }>;
  const writeDurable = (file: string, bytes: string, flags: string): void => {
    const fd = openSync(file, flags);
    try {
      writeFileSync(fd, bytes, "utf8");
      fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const syncDir = (): void => {
    const fd = openSync(dirPath, "r");
    try { fdatasyncSync(fd); } finally { closeSync(fd); }
  };
  const lockOwnerAlive = (pid: number): boolean => {
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const acquirePromotionLock = (): boolean => {
    try {
      // An exclusive, fsynced metadata lock makes a crashed owner
      // distinguishable from a live matching owner.  The former version used a
      // hard-link copy of the lease itself, so any matching lock looked stale
      // and one concurrent promoter could delete another's active lock.
      const stat = statSync(path);
      const lock: PromotionLock = {
        schema: "roll-lease-promotion-lock/v1",
        pid: process.pid,
        token: randomUUID(),
        delegationId,
        runId,
        recordDev: stat.dev,
        recordIno: stat.ino,
      };
      writeDurable(promotionLock, JSON.stringify(lock) + "\n", "wx");
      syncDir();
      return true;
    } catch {
      return false;
    }
  };
  if (!acquirePromotionLock()) {
    // A process can die after taking the durable lock.  Recover only a lock
    // whose owner is demonstrably dead and whose pinned record still names
    // this exact handoff.  A matching *live* lock is never treated as stale.
    try {
      const locked = JSON.parse(readFileSync(promotionLock, "utf8").trim()) as PromotionLock;
      const current = decodeEntryStrict(JSON.parse(readFileSync(path, "utf8").trim()));
      const currentStat = statSync(path);
      const sameIdentity = (entry: LeaseEntry): boolean => entry.delegationId === delegationId && entry.runId === runId
        && (entry.source === "host-delegation" || entry.source === "delivery-reservation");
      // A rename has already committed the promotion if the canonical record
      // is the durable reservation.  Its inode intentionally differs from the
      // host guard inode captured by the old lock.  Treating that expected
      // difference as foreign permanently wedged an otherwise completed
      // handoff after a crash between rename and unlink.
      const promotionAlreadyCommitted = current.source === "delivery-reservation" && sameIdentity(current);
      if (locked.schema !== "roll-lease-promotion-lock/v1"
        || locked.delegationId !== delegationId
        || locked.runId !== runId
        || lockOwnerAlive(locked.pid)
        || !sameIdentity(current)
        || (!promotionAlreadyCommitted && (currentStat.dev !== locked.recordDev || currentStat.ino !== locked.recordIno))) return false;
      unlinkSync(promotionLock);
      syncDir();
    } catch {
      return false;
    }
    if (!acquirePromotionLock()) return false;
  }
  let existing: LeaseEntry;
  try {
    existing = decodeEntryStrict(JSON.parse(readFileSync(path, "utf8").trim()));
  } catch {
    try { unlinkSync(promotionLock); } catch { /* best effort */ }
    return false;
  }
  if (existing.source === "delivery-reservation"
    && existing.delegationId === delegationId
    && existing.runId === runId) {
    try { unlinkSync(promotionLock); } catch { /* best effort */ }
    return true;
  }
  if (existing.source !== "host-delegation" || existing.delegationId !== delegationId || existing.runId !== runId) {
    try { unlinkSync(promotionLock); } catch { /* best effort */ }
    return false;
  }
  const next: LeaseEntry = {
    claimedAt: existing.claimedAt,
    source: "delivery-reservation",
    delegationId,
    runId,
  };
  const tmp = join(dirPath, `.${storyId}.${randomUUID()}.promotion.tmp`);
  try {
    writeDurable(tmp, JSON.stringify(next) + "\n", "wx");
    // The durable lock pins the exact inode that was checked before the swap.
    // releaseStoryLease refuses while it exists, so there is no ABA window.
    const lock = JSON.parse(readFileSync(promotionLock, "utf8").trim()) as PromotionLock;
    const currentStat = statSync(path);
    if (lock.schema !== "roll-lease-promotion-lock/v1"
      || lock.pid !== process.pid
      || lock.delegationId !== delegationId
      || lock.runId !== runId
      || lock.recordDev !== currentStat.dev
      || lock.recordIno !== currentStat.ino) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
      return false;
    }
    renameSync(tmp, path);
    syncDir();
    return true;
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    return false;
  } finally {
    try { if (existsSync(promotionLock)) unlinkSync(promotionLock); } catch { /* best effort */ }
  }
}

/** Closure is explicit: no terminal Delta handoff may free a reservation. */
export type DeliveryReservationReleaseReason = "merged" | "abandoned" | "continuation_transferred";

/** Release a durable host-Delta reservation after named delivery closure. */
export function releaseDeliveryReservation(
  dirPath: string,
  storyId: string,
  delegationId: string,
  runId: string,
  reason: DeliveryReservationReleaseReason,
): boolean {
  // Keep the reason in the public API: a caller must consciously select a
  // delivery closure, rather than treating a terminal Delta event as release.
  if (reason !== "merged" && reason !== "abandoned" && reason !== "continuation_transferred") return false;
  return releaseStoryLease(dirPath, storyId, {
    source: "delivery-reservation",
    delegationId,
    runId,
  });
}

/**
 * Atomically move a durable host-Delta reservation to a named continuation.
 * The canonical lease file is never absent, so a competing Cycle cannot claim
 * the Story between abandonment of one host session and pickup by its declared
 * successor.
 */
export function transferDeliveryReservation(
  dirPath: string,
  storyId: string,
  delegationId: string,
  runId: string,
  continuationRunId: string,
): boolean {
  if (continuationRunId === "" || continuationRunId === runId) return false;
  const path = recordPath(dirPath, storyId);
  if (!existsSync(path)) return false;
  type TransferLock = Readonly<{
    schema: "roll-lease-continuation-lock/v1";
    pid: number;
    delegationId: string;
    runId: string;
    continuationRunId: string;
    recordDev: number;
    recordIno: number;
  }>;
  const lockPath = join(dirPath, `.${storyId}.continuation.lock`);
  const syncDir = (): void => {
    const fd = openSync(dirPath, "r");
    try { fdatasyncSync(fd); } finally { closeSync(fd); }
  };
  const alive = (pid: number): boolean => {
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const readCurrent = (): LeaseEntry | undefined => {
    try { return decodeEntryStrict(JSON.parse(readFileSync(path, "utf8").trim())); } catch { return undefined; }
  };
  const clearCommittedDeadLock = (): boolean => {
    // A rename has made the successor canonical, but a kill before `finally`
    // can leave the old operation mutex behind.  Clean only the exact,
    // demonstrably-dead owner; a live or different-successor lock is authority
    // and must remain untouched.
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8").trim()) as TransferLock;
      if (lock.schema !== "roll-lease-continuation-lock/v1"
        || lock.delegationId !== delegationId
        || lock.runId !== runId
        || lock.continuationRunId !== continuationRunId
        || alive(lock.pid)) return false;
      unlinkSync(lockPath);
      syncDir();
      return true;
    } catch {
      return false;
    }
  };
  // The already-transferred successor is idempotent success.  It is checked
  // before acquiring the source CAS lock so a crash after rename is retryable.
  // It must still retire the dead matching mutex: release is deliberately
  // blocked while that lock exists.
  const initial = readCurrent();
  if (initial?.source === "delivery-reservation" && initial.delegationId === delegationId && initial.runId === continuationRunId) {
    if (!existsSync(lockPath)) return true;
    return clearCommittedDeadLock();
  }
  if (initial?.source !== "delivery-reservation" || initial.delegationId !== delegationId || initial.runId !== runId) return false;
  const acquire = (): boolean => {
    try {
      const stat = statSync(path);
      const lock: TransferLock = {
        schema: "roll-lease-continuation-lock/v1", pid: process.pid,
        delegationId, runId, continuationRunId, recordDev: stat.dev, recordIno: stat.ino,
      };
      const fd = openSync(lockPath, "wx");
      try { writeFileSync(fd, JSON.stringify(lock) + "\n", "utf8"); fdatasyncSync(fd); } finally { closeSync(fd); }
      syncDir();
      return true;
    } catch { return false; }
  };
  if (!acquire()) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8").trim()) as TransferLock;
      const current = readCurrent();
      // A dead predecessor which already named our successor committed safely;
      // clean the stale mutex and let the idempotent check above win.
      if (current?.source === "delivery-reservation" && current.delegationId === delegationId && current.runId === continuationRunId) return clearCommittedDeadLock();
      if (lock.schema !== "roll-lease-continuation-lock/v1" || alive(lock.pid)) return false;
      const stat = statSync(path);
      if (current?.source !== "delivery-reservation" || current.delegationId !== delegationId || current.runId !== runId
        || stat.dev !== lock.recordDev || stat.ino !== lock.recordIno) return false;
      unlinkSync(lockPath); syncDir();
    } catch { return false; }
    if (!acquire()) return false;
  }
  const tmp = join(dirPath, `.${storyId}.${randomUUID()}.continuation.tmp`);
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, JSON.stringify({ ...initial, runId: continuationRunId }) + "\n", "utf8");
      fdatasyncSync(fd);
    } finally { closeSync(fd); }
    // Re-read and compare the inode pinned by the exclusive lock immediately
    // before rename.  Two different named successors therefore cannot both
    // pass a stale read and last-writer-win.
    const current = decodeEntryStrict(JSON.parse(readFileSync(path, "utf8").trim()));
    const lock = JSON.parse(readFileSync(lockPath, "utf8").trim()) as TransferLock;
    const stat = statSync(path);
    if (current.source !== "delivery-reservation" || current.delegationId !== delegationId || current.runId !== runId
      || lock.schema !== "roll-lease-continuation-lock/v1" || lock.pid !== process.pid
      || lock.delegationId !== delegationId || lock.runId !== runId || lock.continuationRunId !== continuationRunId
      || stat.dev !== lock.recordDev || stat.ino !== lock.recordIno) return false;
    renameSync(tmp, path);
    syncDir();
    return true;
  } catch {
    return false;
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* best effort */ }
  }
}

/**
 * FIX-1502 — atomically adopt a redelegated reservation as a normal preparing
 * host guard for a brand-new delegation.
 *
 * The canonical record is replaced in the same directory only while it still
 * names exactly `fromDelegationId` + `continuationRunId` as a
 * `delivery-reservation`: the named successor is the sole pickup authority.
 * The lease filename is never absent during the swap, so no competing claimant
 * can slip in between the old holder and the new run.  The old redelegate
 * record format is deliberately not rewritten beyond this one atomic swap —
 * retrying with the same new identity after a crash is idempotent success,
 * while any other identity, name, or source is refused.
 */

// ── FIX-1502 — shared adoption/release mutex ─────────────────────────────────

/**
 * The per-story mutex serializing reservation adoption and release.  Both
 * sides acquire the SAME lock file and pin the canonical record's inode, so
 * the identity read, the CAS swap (adoption) or the unlink (release) all
 * happen under one mutual exclusion — the lease filename is never absent
 * between the old holder and the new run.
 */
export interface AdoptionMutex {
  schema: "roll-lease-adoption-lock/v1";
  pid: number;
  /** Which operation holds the mutex; used only for dead-lock attribution. */
  op: "adoption" | "release";
  recordDev: number;
  recordIno: number;
}

/** Path of the shared per-story adoption mutex. */
export function adoptionMutexPath(dirPath: string, storyId: string): string {
  return join(dirPath, `.${storyId}.adoption.lock`);
}

function fsyncDir(dirPath: string): void {
  const fd = openSync(dirPath, "r");
  try { fdatasyncSync(fd); } finally { closeSync(fd); }
}

function readAdoptionMutex(dirPath: string, storyId: string): AdoptionMutex | undefined {
  try {
    const lock = JSON.parse(readFileSync(adoptionMutexPath(dirPath, storyId), "utf8").trim()) as AdoptionMutex;
    return lock.schema === "roll-lease-adoption-lock/v1" ? lock : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Retire a demonstrably-dead mutex owner.  A dead owner's op has either
 * committed (its rename already replaced the record) or never will (it died
 * before the rename); in both cases its mutex is stale garbage and may be
 * removed so the next acquirer can proceed.
 */
export function retireDeadAdoptionMutex(dirPath: string, storyId: string): boolean {
  const lock = readAdoptionMutex(dirPath, storyId);
  if (lock === undefined || isPidAlive(lock.pid)) return false;
  try {
    unlinkSync(adoptionMutexPath(dirPath, storyId));
    fsyncDir(dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the shared per-story adoption/release mutex.  Returns the mutex
 * (with the canonical record's pinned inode) or undefined when a live owner
 * holds it.  A dead predecessor's mutex is retired first, so a crash between
 * verify and rename is safely retryable.
 */
export function acquireAdoptionMutex(
  dirPath: string,
  storyId: string,
  op: "adoption" | "release",
): AdoptionMutex | undefined {
  const path = recordPath(dirPath, storyId);
  if (!existsSync(path)) return undefined;
  const lockPath = adoptionMutexPath(dirPath, storyId);
  retireDeadAdoptionMutex(dirPath, storyId);
  try {
    const stat = statSync(path);
    const lock: AdoptionMutex = {
      schema: "roll-lease-adoption-lock/v1",
      pid: process.pid,
      op,
      recordDev: stat.dev,
      recordIno: stat.ino,
    };
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, JSON.stringify(lock) + "\n", "utf8");
      fdatasyncSync(fd);
    } finally { closeSync(fd); }
    fsyncDir(dirPath);
    return lock;
  } catch {
    return undefined;
  }
}

/**
 * Release the mutex only when it is still exactly ours (same pid, op, and
 * pinned inode).  Never removes another live operation's mutex.
 */
export function releaseAdoptionMutex(
  dirPath: string,
  storyId: string,
  mutex: AdoptionMutex | undefined,
): void {
  if (mutex === undefined) return;
  const lock = readAdoptionMutex(dirPath, storyId);
  if (lock === undefined) return;
  if (lock.pid !== mutex.pid || lock.op !== mutex.op
    || lock.recordDev !== mutex.recordDev || lock.recordIno !== mutex.recordIno) return;
  try {
    unlinkSync(adoptionMutexPath(dirPath, storyId));
  } catch { /* best effort */ }
}

/** FIX-1502 — deterministic test seam into the adoption CAS swap. */
export interface AdoptionInterrupts {
  /** Called while the adoption mutex is held, immediately before the rename. */
  beforeRename?: () => void;
}

let _injectedAdoptionInterrupts: AdoptionInterrupts | null = null;

/** Inject a test seam into the adoption CAS; pass null to reset. */
export function injectAdoptionInterrupts(interrupts: AdoptionInterrupts | null): void {
  _injectedAdoptionInterrupts = interrupts;
}

export function adoptContinuationReservation(
  dirPath: string,
  storyId: string,
  fromDelegationId: string,
  continuationRunId: string,
  newDelegationId: string,
  newRunId: string,
): boolean {
  if (continuationRunId === "" || newDelegationId === "" || newRunId === "") return false;
  const path = recordPath(dirPath, storyId);
  if (!existsSync(path)) return false;
  const readCurrent = (): LeaseEntry | undefined => {
    try { return decodeEntryStrict(JSON.parse(readFileSync(path, "utf8").trim())); } catch { return undefined; }
  };
  const isAdopted = (entry: LeaseEntry | undefined): boolean => entry?.source === "host-delegation"
    && entry.delegationId === newDelegationId && entry.runId === newRunId;
  const isRedelegatedToName = (entry: LeaseEntry | undefined): boolean => entry?.source === "delivery-reservation"
    && entry.delegationId === fromDelegationId && entry.runId === continuationRunId;

  // The already-adopted new guard is idempotent success: a crash after the CAS
  // rename is retryable.  A stale dead mutex from that crash is retired so a
  // later release of the new guard is never blocked forever.
  const initial = readCurrent();
  if (isAdopted(initial)) {
    retireDeadAdoptionMutex(dirPath, storyId);
    return true;
  }
  if (!isRedelegatedToName(initial)) return false;

  // The reservation and a release of it share this mutex: adoption holds it
  // through identity verify → temp write → rename, so a matching release can
  // never unlink the record between our verification and the swap.  The lease
  // filename therefore never disappears mid-swap.
  const mutex = acquireAdoptionMutex(dirPath, storyId, "adoption");
  if (mutex === undefined) return false;
  const tmp = join(dirPath, `.${storyId}.${randomUUID()}.adoption.tmp`);
  try {
    // Under the mutex: re-read and prove the record is STILL the exact
    // redelegation and still the file the mutex pinned.
    const current = readCurrent();
    const currentStat = statSync(path);
    if (!isRedelegatedToName(current)
      || currentStat.dev !== mutex.recordDev || currentStat.ino !== mutex.recordIno) return false;
    const next: LeaseEntry = {
      claimedAt: Date.now(),
      source: "host-delegation",
      delegationId: newDelegationId,
      runId: newRunId,
    };
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, JSON.stringify(next) + "\n", "utf8");
      fdatasyncSync(fd);
    } finally { closeSync(fd); }
    // Compare-and-swap: re-verify the exact identity and inode immediately
    // before the rename.  The mutex already excludes a concurrent release or
    // adoption; the second check keeps the invariant honest under refactors.
    const before = readCurrent();
    const beforeStat = statSync(path);
    if (!isRedelegatedToName(before)
      || beforeStat.dev !== mutex.recordDev || beforeStat.ino !== mutex.recordIno) return false;
    if (_injectedAdoptionInterrupts?.beforeRename) _injectedAdoptionInterrupts.beforeRename();
    renameSync(tmp, path);
    fsyncDir(dirPath);
    return true;
  } catch {
    return false;
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    releaseAdoptionMutex(dirPath, storyId, mutex);
  }
}

/**
 * Remove a single lease. Returns true when the key existed (and matched).
 *
 * `onlySource` scopes the removal: a terminating cycle passes "cycle" so it
 * can never wipe a HUMAN/supervisor claim that preempted the story mid-flight
 * — the soft-lease protection must survive the original cycle's terminal.
 */
export function removeLease(
  dirPath: string,
  storyId: string,
  onlySource?: LeaseSource,
): boolean {
  const rp = recordPath(dirPath, storyId);
  if (!existsSync(rp)) return false;

  if (onlySource !== undefined) {
    try {
      const raw = readFileSync(rp, "utf8");
      const parsed = JSON.parse(raw.trim());
      const existing = decodeEntryStrict(parsed);
      if (existing.source !== onlySource) return false;
    } catch {
      return false;
    }
  }

  try {
    unlinkSync(rp);
    return true;
  } catch {
    return false;
  }
}

// ─── Lifetime helpers ───────────────────────────────────────────────────────

/** True when the PID in the lease is still alive on the current machine. */
export function isPidAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

/** True when the lease's owning process is still running. */
export function isLeaseAlive(entry: LeaseEntry): boolean {
  if (entry.pid === undefined) return false;
  return isPidAlive(entry.pid);
}

/**
 * True when the story has a human-style soft lease that is still active —
 * claimed within HUMAN_SOFT_LEASE_HOURS ago.
 */
export function isHumanSoftLeaseActive(entry: LeaseEntry, now: number): boolean {
  return now - entry.claimedAt < HUMAN_SOFT_LEASE_HOURS * 3600_000;
}

/**
 * Clean dead PID leases from the lease directory.
 *
 * A lease whose pid is set but the process is no longer alive is stale — the
 * cycle that claimed it crashed or was killed without running its terminal
 * cleanup. Remove the lease so the story is not permanently blocked.
 *
 * Host-delegation leases are persistent host protocol leases (no pid)
 * and are NEVER cleaned by this function. Human/supervisor leases also
 * have no pid and are never cleaned.
 *
 * Returns the list of storyIds whose dead leases were cleaned (for alerting).
 */
export interface DeadLeaseCleanupOptions {
  /**
   * A caller that owns a durable lifecycle projection can retain a dead PID
   * lease while its workspace is still ambiguous.  A dead process is not proof
   * that its registered checkout may be handed to another delivery run.
   */
  readonly preserve?: (storyId: string, entry: LeaseEntry) => boolean;
}

export function cleanDeadLeases(dirPath: string, options: DeadLeaseCleanupOptions = {}): string[] {
  // BLOCK-3: Under the read-only legacy contract, cleanDeadLeases cleans
  // canonical records only. Legacy-only data is immutable — return no
  // cleaned IDs and perform no write (never create canonical survivor
  // copies, never mutate legacy bytes).
  if (!existsSync(dirPath)) {
    return [];
  }

  const cleaned: string[] = [];
  try {
    for (const entry of readdirSync(dirPath)) {
      if (!entry.endsWith(LEASE_EXT)) continue;
      const storyId = entry.slice(0, -LEASE_EXT.length);
      const rp = join(dirPath, entry);
      try {
        const raw = readFileSync(rp, "utf8");
        const decoded = decodeEntryStrict(JSON.parse(raw.trim()));
        // Only clean cycle leases with dead PIDs.
        if (
          decoded.pid !== undefined &&
          decoded.source !== "host-delegation" &&
          !isPidAlive(decoded.pid) &&
          options.preserve?.(storyId, decoded) !== true
        ) {
          unlinkSync(rp);
          cleaned.push(storyId);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return cleaned;
}

/**
 * Build a "claimed by other?" predicate from the lease map for the picker.
 *
 * A story whose sole claimer is this PID with a live process is NOT claimed.
 * Any other case (no lease -> human-preempted, dead lease, different PID) IS.
 */
export function buildClaimedByOther(
  leases: LeaseMap,
  _now: number,
  ownPid?: number,
): (id: string) => boolean {
  return (id: string): boolean => {
    const entry = leases[id];
    if (entry === undefined) {
      // No lease entry at all — human-preempted (or lease cleaned up).
      // The picker must conservatively skip it.
      return true;
    }
    // Live lease from the current process -> NOT other.
    if (
      entry.pid !== undefined &&
      ownPid !== undefined &&
      entry.pid === ownPid &&
      isPidAlive(entry.pid)
    ) {
      return false;
    }
    // Dead lease, different process, or human claim -> claimed by other.
    return true;
  };
}
