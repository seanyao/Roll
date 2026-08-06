/**
 * @responsibility Appends delivery records to the deliveries store atomically.
 * DeliveryStore — US-TRUTH-014 append-only deliveries.jsonl store.
 *
 * Every delivery produces one {@link DeliveryRecord} (US-TRUTH-013). This module
 * stores them in `.roll/loop/deliveries.jsonl` — append-only, one JSON line per
 * record, atomic single-line O_APPEND writes.
 *
 * Design (3-agent consensus 2):
 *   - Append-only JSONL (not SQLite) — git-native, diffable, PR-reviewable,
 *     worktree-isolated, rebuildable from the event stream (I8).
 *   - Atomic append: a single `write()` to an O_APPEND fd is atomic across
 *     concurrent writers on POSIX (one JSONL line << PIPE_BUF).
 *   - Read is pure, last-wins dedup by (storyId, cycleId).
 *   - Path resolves to `<project>/.roll/loop/deliveries.jsonl` — cross-worktree
 *     shared (I7), NOT per-worktree.
 *
 * Schema enforcement:
 *   - Every line is validated against DeliveryRecord before append.
 *   - Torn / illegal lines are silently skipped on read (never crash).
 */
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeliveryRecord, LifecycleState, AbsentReason, FactOr } from "@roll/spec";
import { LIFECYCLE_STATES } from "@roll/spec";

// ── Filesystem port ─────────────────────────────────────────────────────────

/** Minimal filesystem port for the append-only JSONL store. */
export interface DeliveryStoreInterface {
  /** True iff `path` exists. */
  exists(path: string): boolean;
  /** Create `path` (and parents) as an empty file if missing. */
  ensureFile(path: string): void;
  /** Read the whole file as UTF-8 ("" when absent). */
  readText(path: string): string;
  /** Atomically append one already-terminated line (single O_APPEND write). */
  appendLine(path: string, line: string): void;
}

/** Node-backed {@link DeliveryStoreInterface}. */
export const nodeDeliveryStore: DeliveryStoreInterface = {
  exists(path: string): boolean {
    return existsSync(path);
  },
  ensureFile(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      appendFileSync(path, "", { encoding: "utf8", flag: "a" });
    }
  },
  readText(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  },
  appendLine(path: string, line: string): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, { encoding: "utf8", flag: "a" });
  },
};

// ── Path resolution ─────────────────────────────────────────────────────────

/** File name under `.roll/loop/`. */
const DELIVERIES_FILE = "deliveries.jsonl";

/**
 * Resolve the deliveries file path for a given project root.
 *
 * @param projectRoot - Absolute path to the project directory.
 * @returns `<projectRoot>/.roll/loop/deliveries.jsonl`
 *
 * @remarks
 * This file is cross-worktree shared (I7): all cycles writing to the same
 * project use the same file. Different projects resolve to different paths.
 */
export function deliveriesPath(projectRoot: string): string {
  return join(projectRoot, ".roll", "loop", DELIVERIES_FILE);
}

// ── Schema validation ───────────────────────────────────────────────────────

/**
 * Validate an object as a {@link DeliveryRecord}.
 *
 * Checks:
 *   - Is a non-null object
 *   - `storyId`, `cycleId` are non-empty strings
 *   - `lifecycleState` is a valid {@link LifecycleState}
 *   - `recordedAt` is a finite number
 *
 * @returns The record if valid, `null` otherwise.
 */
export function validateDeliveryRecord(obj: unknown): DeliveryRecord | null {
  if (obj === null || typeof obj !== "object") return null;
  const r = obj as Record<string, unknown>;

  // Required string fields
  const storyId = r["storyId"];
  const cycleId = r["cycleId"];
  if (typeof storyId !== "string" || storyId.trim() === "") return null;
  if (typeof cycleId !== "string" || cycleId.trim() === "") return null;

  // lifecycleState must be a valid member of the closed set
  const lcs = r["lifecycleState"];
  if (typeof lcs !== "string" || !(LIFECYCLE_STATES as readonly string[]).includes(lcs)) return null;

  // recordedAt must be a finite number
  const recAt = r["recordedAt"];
  if (typeof recAt !== "number" || !Number.isFinite(recAt)) return null;

  // Build the validated record — optional fields preserved from parsed JSON.
  // JSON round-trip preserves FactOr shape; we cast the values to their
  // expected types (number for prNumber/mergedAt, string for prUrl/mergeCommit).
  const record: DeliveryRecord = {
    storyId: storyId.trim(),
    cycleId: cycleId.trim(),
    lifecycleState: lcs as LifecycleState,
    prNumber: asFactOr(r["prNumber"], "number"),
    prUrl: asFactOr(r["prUrl"], "string"),
    mergedAt: asFactOr(r["mergedAt"], "number"),
    mergeCommit: asFactOr(r["mergeCommit"], "string"),
    recordedAt: recAt,
  };

  return record;
}

/**
 * Type-safe cast for a FactOr field parsed from JSON.
 * If the value has a valid FactOr shape, pass it through with the correct
 * value type assertion (the T is runtime-polymorphic: number or string).
 * If it's malformed, return absent.
 */
function asFactOr<T>(v: unknown, _kind: "number" | "string"): FactOr<T> {
  if (v !== null && typeof v === "object") {
    const f = v as Record<string, unknown>;
    if (f["present"] === true && "value" in f && f["value"] !== undefined) {
      return { present: true, value: f["value"] as T };
    }
    if (f["present"] === false && typeof f["reason"] === "string") {
      // Narrow to AbsentReason — the runtime value may not be in the closed
      // set, but structurally it is a string reason.
      return { present: false, reason: f["reason"] as AbsentReason };
    }
  }
  return { present: false, reason: "missing_or_malformed" as AbsentReason };
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Validate and append a {@link DeliveryRecord} to `deliveries.jsonl` as a
 * single atomic line.
 *
 * @param store - Filesystem port (inject for testing).
 * @param projectRoot - Project root directory.
 * @param record - The record to append (validated before write).
 * @returns The serialized JSON line that was appended.
 * @throws {TypeError} if the record fails schema validation.
 */
export function appendDelivery(
  store: DeliveryStoreInterface,
  projectRoot: string,
  record: DeliveryRecord,
): string {
  const valid = validateDeliveryRecord(record);
  if (valid === null) {
    throw new TypeError(
      `appendDelivery: record failed schema validation (keys: ${Object.keys(record).join(", ")})`,
    );
  }

  const line = `${JSON.stringify(valid)}\n`;
  const path = deliveriesPath(projectRoot);
  store.ensureFile(path);
  store.appendLine(path, line);
  return line;
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read all delivery records from `deliveries.jsonl`.
 *
 * Rules:
 *   - Each line is parsed as JSON and validated against {@link DeliveryRecord}.
 *   - Torn (incomplete JSON) and illegal (schema-invalid) lines are SKIPPED
 *     silently — never crash the reader.
 *   - Same `(storyId, cycleId)` → **last-wins**: later lines override earlier
 *     ones. This handles the case where a cycle re-emits its delivery record
 *     (e.g. the PR merged and the lifecycle advanced).
 *   - Pure read — never writes, never modifies the file.
 *
 * @param store - Filesystem port (inject for testing).
 * @param projectRoot - Project root directory.
 * @returns Deduplicated array of valid records, oldest→newest order.
 */
export function readDeliveries(
  store: DeliveryStoreInterface,
  projectRoot: string,
): DeliveryRecord[] {
  const path = deliveriesPath(projectRoot);
  const text = store.readText(path);
  if (text.trim() === "") return [];

  const map = new Map<string, DeliveryRecord>();
  const lines = text.split("\n");

  for (const raw of lines) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Torn / illegal JSON — skip silently (AC2).
      continue;
    }
    const record = validateDeliveryRecord(parsed);
    if (record === null) continue; // Schema-invalid — skip silently (AC2).

    // Last-wins dedup by (storyId, cycleId) (AC3).
    const key = `${record.storyId}\t${record.cycleId}`;
    map.set(key, record);
  }

  // Preserve append order (Map preserves insertion order in iteration,
  // but since we overwrite on duplicate, the LAST occurrence retains its
  // position — which is equivalent to the last-wins semantics).
  return [...map.values()];
}

/**
 * Read all delivery records from `deliveries.jsonl` WITHOUT deduplication.
 *
 * Unlike {@link readDeliveries}, this returns every valid record in append
 * order, including records that would be shadowed by a later record with the
 * same `(storyId, cycleId)`. Use this when you need to see the full history —
 * e.g. finding pending records that may already have a later `done` record.
 *
 * Rules:
 *   - Each line is parsed as JSON and validated against {@link DeliveryRecord}.
 *   - Torn (incomplete JSON) and illegal (schema-invalid) lines are SKIPPED.
 *   - NO deduplication — every valid line is returned.
 *   - Pure read — never writes, never modifies the file.
 *
 * @param store - Filesystem port (inject for testing).
 * @param projectRoot - Project root directory.
 * @returns All valid records in append order (may contain duplicate keys).
 */
export function readDeliveriesRaw(
  store: DeliveryStoreInterface,
  projectRoot: string,
): DeliveryRecord[] {
  const path = deliveriesPath(projectRoot);
  const text = store.readText(path);
  if (text.trim() === "") return [];

  const records: DeliveryRecord[] = [];
  const lines = text.split("\n");

  for (const raw of lines) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Torn / illegal JSON — skip silently.
      continue;
    }
    const record = validateDeliveryRecord(parsed);
    if (record === null) continue; // Schema-invalid — skip silently.

    records.push(record);
  }

  return records;
}
