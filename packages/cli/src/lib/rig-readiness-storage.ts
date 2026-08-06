/**
 * @responsibility Persists machine-local rig readiness snapshots atomically.
 */
/**
 * US-DELTA-017 — atomic machine-local readiness snapshot persistence.
 *
 * The module writes only ROLL_HOME/delta-team/rig-readiness and does not import
 * any Delta prepare, resolution, event, lease, workspace, or truth code.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  classifyRigReadiness,
  computeCandidateFingerprint,
  validateRigReadinessSnapshot,
} from "@roll/core";
import type { RigCacheStatus } from "@roll/core";
import {
  RIG_READINESS_LATEST_SCHEMA,
  RIG_READINESS_SNAPSHOT_SCHEMA,
} from "@roll/spec";
import type {
  RigProbeObservation,
  RigReadinessCandidate,
  RigReadinessLatest,
  RigReadinessSnapshot,
} from "@roll/spec";

export interface RigStorageIo {
  exists(path: string): boolean;
  mkdirRecursive(path: string): void;
  readUtf8(path: string): string | null;
  writeTempThenFsync(path: string, content: string): void;
  rename(from: string, to: string, overwrite: boolean): void;
  listDir(path: string): readonly string[];
  rmFile(path: string): void;
  fsyncDir(path: string): void;
}

export interface RigStorageDeps {
  readonly io: RigStorageIo;
  readonly root: string;
  readonly now: () => number;
  readonly newRefreshId: () => string;
}

export const nodeRigStorageIo: RigStorageIo = {
  exists: existsSync,
  mkdirRecursive: (path) => mkdirSync(path, { recursive: true }),
  readUtf8: (path) => {
    try { return readFileSync(path, "utf8"); } catch { return null; }
  },
  writeTempThenFsync: (path, content) => {
    writeFileSync(path, content, "utf8");
    const fd = openSync(path, "r");
    try { fdatasyncSync(fd); } finally { closeSync(fd); }
  },
  rename: (from, to, overwrite) => {
    if (!overwrite && existsSync(to)) throw new Error(`readiness snapshot already exists: ${to}`);
    renameSync(from, to);
  },
  listDir: (path) => {
    try { return readdirSync(path); } catch { return []; }
  },
  rmFile: (path) => rmSync(path, { force: true }),
  fsyncDir: (path) => {
    const fd = openSync(path, "r");
    try { fdatasyncSync(fd); } finally { closeSync(fd); }
  },
};

export function rigReadinessDirectory(root: string): string {
  return join(root, "delta-team", "rig-readiness");
}

export function writeRigReadinessSnapshot(
  deps: RigStorageDeps,
  candidates: readonly RigReadinessCandidate[],
  observations: readonly RigProbeObservation[],
): RigReadinessSnapshot {
  const dir = rigReadinessDirectory(deps.root);
  deps.io.mkdirRecursive(dir);
  const refreshId = deps.newRefreshId();
  const target = join(dir, `${refreshId}.json`);
  if (deps.io.exists(target)) throw new Error(`readiness snapshot already exists: ${target}`);
  const snapshot: RigReadinessSnapshot = {
    schema: RIG_READINESS_SNAPSHOT_SCHEMA,
    refreshId,
    candidateFingerprint: computeCandidateFingerprint(candidates),
    observedAt: new Date(deps.now()).toISOString(),
    observations,
  };
  const validation = validateRigReadinessSnapshot(snapshot, candidates);
  if (!validation.ok) throw new Error(`invalid readiness snapshot: ${validation.detail}`);
  const temp = join(dir, `.tmp-${refreshId}-${randomUUID()}`);
  try {
    deps.io.writeTempThenFsync(temp, JSON.stringify(snapshot) + "\n");
    deps.io.rename(temp, target, false);
    deps.io.fsyncDir(dir);
  } catch (error) {
    try { deps.io.rmFile(temp); } catch { /* preserve the original I/O failure */ }
    throw error;
  }
  return snapshot;
}

/** Publish a re-read, fully validated immutable snapshot as the only mutable pointer. */
export function publishRigReadinessSnapshot(
  deps: RigStorageDeps,
  candidates: readonly RigReadinessCandidate[],
  refreshId: string,
): RigReadinessLatest {
  const dir = rigReadinessDirectory(deps.root);
  const snapshotPath = join(dir, `${refreshId}.json`);
  const snapshot = parseSnapshot(deps.io.readUtf8(snapshotPath));
  if (snapshot === null || snapshot.refreshId !== refreshId) throw new Error(`cannot publish unreadable readiness snapshot ${refreshId}`);
  const validation = validateRigReadinessSnapshot(snapshot, candidates);
  if (!validation.ok) throw new Error(`cannot publish invalid readiness snapshot: ${validation.detail}`);
  const pointer: RigReadinessLatest = {
    schema: RIG_READINESS_LATEST_SCHEMA,
    refreshId,
    candidateFingerprint: snapshot.candidateFingerprint,
    publishedAt: new Date(deps.now()).toISOString(),
  };
  const latestPath = join(dir, "latest.json");
  // Keep exact prior bytes so a post-rename failure can conservatively restore
  // the old publication rather than exposing a pointer we could not verify.
  const priorPointer = deps.io.readUtf8(latestPath);
  const temp = join(dir, `.tmp-latest-${randomUUID()}`);
  try {
    deps.io.writeTempThenFsync(temp, JSON.stringify(pointer) + "\n");
    deps.io.rename(temp, latestPath, true);
    deps.io.fsyncDir(dir);
    const reread = parsePointer(deps.io.readUtf8(latestPath));
    if (
      reread === null || reread.refreshId !== pointer.refreshId ||
      reread.candidateFingerprint !== pointer.candidateFingerprint ||
      reread.publishedAt !== pointer.publishedAt
    ) throw new Error(`cannot verify readiness pointer publication ${refreshId}`);
  } catch (error) {
    try { deps.io.rmFile(temp); } catch { /* preserve the original I/O failure */ }
    try { restorePriorPointer(deps, dir, latestPath, priorPointer); } catch { /* preserve original error; caller remains fail-loud */ }
    throw error;
  }
  retainReadinessSnapshots(deps, refreshId);
  return pointer;
}

/** Best-effort rollback after a publication failure; exact bytes avoid reformatting prior truth. */
function restorePriorPointer(deps: RigStorageDeps, dir: string, latestPath: string, priorPointer: string | null): void {
  if (priorPointer === null) {
    deps.io.rmFile(latestPath);
    deps.io.fsyncDir(dir);
    return;
  }
  const restoreTemp = join(dir, `.tmp-latest-restore-${randomUUID()}`);
  try {
    deps.io.writeTempThenFsync(restoreTemp, priorPointer);
    deps.io.rename(restoreTemp, latestPath, true);
    deps.io.fsyncDir(dir);
  } finally {
    try { deps.io.rmFile(restoreTemp); } catch { /* best effort */ }
  }
}

/** Readers trust only latest.json; no directory-order fallback is available. */
export function readLatestRigReadiness(deps: RigStorageDeps): { readonly pointer: RigReadinessLatest; readonly snapshot: RigReadinessSnapshot } | null {
  const dir = rigReadinessDirectory(deps.root);
  const pointer = parsePointer(deps.io.readUtf8(join(dir, "latest.json")));
  if (pointer === null) return null;
  const snapshot = parseSnapshot(deps.io.readUtf8(join(dir, `${pointer.refreshId}.json`)));
  if (snapshot === null || snapshot.refreshId !== pointer.refreshId || snapshot.candidateFingerprint !== pointer.candidateFingerprint) return null;
  return { pointer, snapshot };
}

/**
 * Read and classify the pointer-selected snapshot only. A malformed pointer or
 * target is incompatible, never an excuse to infer a result from file order.
 */
export function readRigReadinessCache(
  deps: RigStorageDeps,
  candidates: readonly RigReadinessCandidate[],
  ttlMs: number,
): { readonly status: RigCacheStatus; readonly pointer: RigReadinessLatest | null; readonly snapshot: RigReadinessSnapshot | null } {
  const dir = rigReadinessDirectory(deps.root);
  const pointerText = deps.io.readUtf8(join(dir, "latest.json"));
  if (pointerText === null) return { status: { kind: "missing" }, pointer: null, snapshot: null };
  const pointer = parsePointer(pointerText);
  if (pointer === null) return { status: { kind: "incompatible" }, pointer: null, snapshot: null };
  const snapshot = parseSnapshot(deps.io.readUtf8(join(dir, `${pointer.refreshId}.json`)));
  if (snapshot === null || snapshot.refreshId !== pointer.refreshId) return { status: { kind: "incompatible" }, pointer, snapshot: null };
  const validation = validateRigReadinessSnapshot(snapshot, candidates);
  if (!validation.ok) return { status: { kind: "incompatible" }, pointer, snapshot };
  return {
    status: classifyRigReadiness({
      currentFingerprint: computeCandidateFingerprint(candidates),
      pointer,
      snapshot,
      nowMs: deps.now(),
      ttlMs,
    }),
    pointer,
    snapshot,
  };
}

/** Retention is best-effort and occurs only after a successful pointer rename. */
export function retainReadinessSnapshots(deps: RigStorageDeps, pointedRefreshId: string): void {
  try {
    const dir = rigReadinessDirectory(deps.root);
    const unpointed = deps.io.listDir(dir)
      .filter((name) => name.endsWith(".json") && name !== "latest.json" && name !== `${pointedRefreshId}.json`)
      .map((name) => ({ name, snapshot: parseSnapshot(deps.io.readUtf8(join(dir, name))) }))
      .sort((left, right) => (right.snapshot?.observedAt ?? "").localeCompare(left.snapshot?.observedAt ?? ""));
    for (const entry of unpointed.slice(4)) {
      try { deps.io.rmFile(join(dir, entry.name)); } catch { /* retention cannot fail a published refresh */ }
    }
  } catch {
    // Retention cannot fail a published refresh.
  }
}

function parseSnapshot(text: string | null): RigReadinessSnapshot | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<RigReadinessSnapshot>;
    if (value.schema !== RIG_READINESS_SNAPSHOT_SCHEMA || typeof value.refreshId !== "string" || typeof value.candidateFingerprint !== "string" || !isCanonicalIso(value.observedAt) || !Array.isArray(value.observations)) return null;
    return value as RigReadinessSnapshot;
  } catch { return null; }
}

function parsePointer(text: string | null): RigReadinessLatest | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<RigReadinessLatest>;
    if (value.schema !== RIG_READINESS_LATEST_SCHEMA || typeof value.refreshId !== "string" || typeof value.candidateFingerprint !== "string" || !isCanonicalIso(value.publishedAt)) return null;
    return value as RigReadinessLatest;
  } catch { return null; }
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}
