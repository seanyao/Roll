/**
 * @responsibility Provides filesystem-backed mutual exclusion for browser leases.
 * US-BROW-005 — filesystem-backed exclusion for browser leases.
 *
 * Events audit a lease after the fact; this lock is the mutual-exclusion
 * primitive. The store's createExclusive operation must map to O_EXCL.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BrowserLeaseLockRecord {
  leaseId: string;
  endpointHash: string;
  holderPid: number;
  holderProcessIdentity: string;
  holderTokenHash: string;
  heartbeatAt: string;
  expiresAt: string;
  /** US-BROW-008a — lease approval payload persisted alongside holder facts. */
  storyId?: string;
  origin?: string;
  actionSummary?: string;
  credentialExportDenied?: boolean;
}

export interface BrowserLeaseLockStore {
  /** Atomically create a file only when it does not exist (O_EXCL). */
  createExclusive(path: string, text: string): boolean;
  readText(path: string): string | undefined;
  /** Atomically claims an unchanged stale record and removes its live name. */
  claimStale(path: string, expected: string): boolean;
  remove(path: string): void;
  /** Atomically replace an existing lock record after holder verification. */
  replace(path: string, text: string): void;
}

export const nodeBrowserLeaseLockStore: BrowserLeaseLockStore = {
  createExclusive(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      const fd = openSync(tmp, "wx");
      try {
        writeFileSync(fd, text, "utf8");
      } finally {
        closeSync(fd);
      }
      linkSync(tmp, path);
      return true;
    } catch (error: unknown) {
      if (isAlreadyExists(error)) return false;
      throw error;
    } finally {
      rmSync(tmp, { force: true });
    }
  },
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  claimStale(path, expected) {
    const claim = `${path}.reclaim`;
    try {
      linkSync(path, claim);
      if (readFileSync(claim, "utf8") !== expected) return false;
      unlinkSync(path);
      return true;
    } catch {
      return false;
    } finally {
      rmSync(claim, { force: true });
    }
  },
  remove(path) {
    rmSync(path, { force: true });
  },
  replace(path, text) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  },
};

export interface AcquireBrowserLeaseLockInput {
  directory: string;
  endpointHash: string;
  leaseId: string;
  holderPid: number;
  holderToken: string;
  expiresAt: string;
  /** US-BROW-008a — optional approval payload fields persisted for audit. */
  storyId?: string;
  origin?: string;
  actionSummary?: string;
  credentialExportDenied?: boolean;
}

export type BrowserLeaseLockAcquireResult =
  | { kind: "acquired"; path: string; record: BrowserLeaseLockRecord; reclaimed?: BrowserLeaseLockRecord }
  | { kind: "held"; path: string; holderPid?: number; expiresAt?: string };

export class BrowserLeaseLock {
  constructor(
    private readonly store: BrowserLeaseLockStore = nodeBrowserLeaseLockStore,
    private readonly isProcessAlive: (pid: number) => boolean = nodeProcessAlive,
    private readonly now: () => number = Date.now,
    private readonly processIdentity: (pid: number) => string | undefined = nodeProcessIdentity,
  ) {}

  acquire(input: AcquireBrowserLeaseLockInput): BrowserLeaseLockAcquireResult {
    const path = leaseLockPath(input.directory, input.endpointHash);
    const record = toRecord(input, this.now(), this.processIdentity);
    if (this.store.createExclusive(path, encode(record))) return { kind: "acquired", path, record };

    const existingText = this.store.readText(path);
    const existing = parseRecord(existingText);
    if (existing === undefined || !isStale(existing, this.isProcessAlive, this.processIdentity)) {
      return { kind: "held", path, holderPid: existing?.holderPid, expiresAt: existing?.expiresAt };
    }

    if (existingText !== undefined && this.store.claimStale(path, existingText) && this.store.createExclusive(path, encode(record))) {
      return { kind: "acquired", path, record, reclaimed: existing };
    }
    const winner = parseRecord(this.store.readText(path));
    return { kind: "held", path, holderPid: winner?.holderPid, expiresAt: winner?.expiresAt };
  }

  heartbeat(
    path: string,
    holderToken: string,
    expiresAt?: string,
  ): { kind: "renewed"; record: BrowserLeaseLockRecord } | { kind: "not_holder" } {
    const current = parseRecord(this.store.readText(path));
    const holderTokenHash = createHash("sha256").update(holderToken, "utf8").digest("hex");
    if (current === undefined || current.holderTokenHash !== holderTokenHash) return { kind: "not_holder" };
    const record: BrowserLeaseLockRecord = {
      ...current,
      heartbeatAt: new Date(this.now()).toISOString(),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
    // Heartbeats must never replace the exclusion inode: a concurrent release
    // or dead-PID reclaim may unlink that inode after verifying it. Persist a
    // token-scoped sidecar instead, so liveness updates cannot resurrect or
    // delete another holder's lock.
    this.store.replace(`${path}.${holderTokenHash}.heartbeat`, encode(record));
    return { kind: "renewed", record };
  }

  release(path: string, holderToken: string): boolean {
    const current = parseRecord(this.store.readText(path));
    const holderTokenHash = createHash("sha256").update(holderToken, "utf8").digest("hex");
    if (current === undefined || current.holderTokenHash !== holderTokenHash) return false;
    return this.store.claimStale(path, encode(current));
  }

  /** Read the persisted lock record, if any. */
  readRecord(path: string): BrowserLeaseLockRecord | undefined {
    return parseRecord(this.store.readText(path));
  }

  /**
   * Atomically remove a lock only if it still matches the expected record.
   * Used by lease expiry / dead-holder recovery paths that do not hold the
   * holder token. Returns true when this call removed the lock.
   */
  claim(path: string, expected: BrowserLeaseLockRecord): boolean {
    return this.store.claimStale(path, encode(expected));
  }
}

export function leaseLockPath(directory: string, endpointHash: string): string {
  return join(directory, `${endpointHash}.lock`);
}

function toRecord(
  input: AcquireBrowserLeaseLockInput,
  now: number,
  processIdentity: (pid: number) => string | undefined,
): BrowserLeaseLockRecord {
  const record: BrowserLeaseLockRecord = {
    leaseId: input.leaseId,
    endpointHash: input.endpointHash,
    holderPid: input.holderPid,
    holderProcessIdentity: processIdentity(input.holderPid) ?? "unknown",
    holderTokenHash: createHash("sha256").update(input.holderToken, "utf8").digest("hex"),
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: input.expiresAt,
  };
  if (input.storyId !== undefined) record.storyId = input.storyId;
  if (input.origin !== undefined) record.origin = input.origin;
  if (input.actionSummary !== undefined) record.actionSummary = input.actionSummary;
  if (input.credentialExportDenied !== undefined) record.credentialExportDenied = input.credentialExportDenied;
  return record;
}

function parseRecord(text: string | undefined): BrowserLeaseLockRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return undefined;
    const { leaseId, endpointHash, holderPid, holderProcessIdentity, holderTokenHash, heartbeatAt, expiresAt, storyId, origin, actionSummary, credentialExportDenied } = value;
    if (
      typeof leaseId !== "string" || typeof endpointHash !== "string" ||
      typeof holderPid !== "number" || !Number.isSafeInteger(holderPid) || typeof holderProcessIdentity !== "string" || typeof holderTokenHash !== "string" ||
      typeof heartbeatAt !== "string" || typeof expiresAt !== "string"
    ) return undefined;
    if (storyId !== undefined && typeof storyId !== "string") return undefined;
    if (origin !== undefined && typeof origin !== "string") return undefined;
    if (actionSummary !== undefined && typeof actionSummary !== "string") return undefined;
    if (credentialExportDenied !== undefined && typeof credentialExportDenied !== "boolean") return undefined;
    return { leaseId, endpointHash, holderPid, holderProcessIdentity, holderTokenHash, heartbeatAt, expiresAt, storyId, origin, actionSummary, credentialExportDenied };
  } catch {
    return undefined;
  }
}

function isStale(
  record: BrowserLeaseLockRecord,
  alive: (pid: number) => boolean,
  processIdentity: (pid: number) => string | undefined,
): boolean {
  // Expiry bounds the holder's authority, but is never permission to delete a
  // live holder's lock. A dead PID is reclaimable immediately; a live holder
  // must release or renew without another process seizing its endpoint.
  if (!alive(record.holderPid)) return true;
  const currentIdentity = processIdentity(record.holderPid);
  return currentIdentity !== undefined && record.holderProcessIdentity !== "unknown" && currentIdentity !== record.holderProcessIdentity;
}

function encode(record: BrowserLeaseLockRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function nodeProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function nodeProcessIdentity(pid: number): string | undefined {
  try {
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return startedAt === "" ? undefined : startedAt;
  } catch {
    return undefined;
  }
}
