/**
 * @responsibility Tracks pending-publish deliveries.
 */
/**
 * FIX-1018: pending-publish tracking.
 *
 * When a cycle exits with an unpublished terminal (`local` in v2 status,
 * mapped to `unpublished`), the story has locally-committed work that failed
 * to publish. Re-picking it in the next cycle would re-implement the same work
 * and waste tokens. This module persists the set of such stories in
 * `.roll/loop/pending-publish.json` (gitignored runtime state) so the picker
 * can skip them until the publish blocker clears.
 *
 * The marker is cleared automatically when a story is later delivered
 * (`done`/`published` terminal) or can be removed manually by deleting the file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILENAME = "pending-publish.json";

function pathFor(runtimeDir: string): string {
  return join(runtimeDir, FILENAME);
}

function readSet(runtimeDir: string): Set<string> {
  const path = pathFor(runtimeDir);
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(raw)) return new Set(raw.filter((v): v is string => typeof v === "string"));
  } catch {
    /* corrupt → treat as empty */
  }
  return new Set();
}

function writeSet(runtimeDir: string, set: Set<string>): void {
  const path = pathFor(runtimeDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify([...set].sort(), null, 2), "utf8");
  writeFileSync(path, readFileSync(tmp, "utf8"), "utf8");
  try {
    // Node 20+; best-effort cleanup.
    const { rmSync } = require("node:fs");
    rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
}

/** Read the pending-publish set from the project's runtime dir. */
export function readPendingPublish(runtimeDir: string): Set<string> {
  return readSet(runtimeDir);
}

/** Add a story id to the pending-publish set. */
export function addPendingPublish(runtimeDir: string, storyId: string): void {
  const set = readSet(runtimeDir);
  if (set.has(storyId)) return;
  set.add(storyId);
  writeSet(runtimeDir, set);
}

/** Remove a story id from the pending-publish set (e.g. on delivery). */
export function removePendingPublish(runtimeDir: string, storyId: string): void {
  const set = readSet(runtimeDir);
  if (!set.has(storyId)) return;
  set.delete(storyId);
  writeSet(runtimeDir, set);
}
