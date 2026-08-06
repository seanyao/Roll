/**
 * @responsibility Provides the default Node filesystem implementation of the EventStore port.
 * Default Node filesystem implementation of the {@link EventStore} port the
 * event-bus write side (bus.ts) uses to append events / upsert run rows.
 *
 * Like backlog/infra-default.ts (FileStore), the bus logic is pure: it builds
 * the line bytes + the upsert decision and lets this adapter do the I/O. An
 * in-memory fake lets tests observe the append discipline + dedupe semantics.
 *
 * The append is a SINGLE `appendFileSync` call with the `a` (O_APPEND) flag —
 * mirroring the bash `>> "$evfile"`: POSIX guarantees a write() ≤ PIPE_BUF to an
 * O_APPEND fd is atomic across concurrent writers, and one ndjson line is well
 * under that limit (bin/roll FIX-067 comment).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Minimal filesystem port used by the event bus. */
export interface EventStore {
  /** True iff `path` exists. */
  exists(path: string): boolean;
  /** Create `path` (and parents) as an empty file if missing (FIX-157 self-heal). */
  ensureFile(path: string): void;
  /** Read the whole file as UTF-8 ("" when absent). */
  readText(path: string): string;
  /** Atomically append one already-terminated line (single O_APPEND write). */
  appendLine(path: string, line: string): void;
  /** Overwrite `path` with `data` (used by the dedupe upsert rewrite). */
  writeText(path: string, data: string): void;
  /** Byte size of `path` (0 when absent) — drives rotation awareness. */
  size(path: string): number;
}

/** Node-backed {@link EventStore}. */
export const nodeEventStore: EventStore = {
  exists(path: string): boolean {
    return existsSync(path);
  },
  ensureFile(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, "", "utf8");
  },
  readText(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  },
  appendLine(path: string, line: string): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, { encoding: "utf8", flag: "a" });
  },
  writeText(path: string, data: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, "utf8");
  },
  size(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  },
};
