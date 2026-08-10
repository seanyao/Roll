/**
 * @responsibility Provides the default Node filesystem implementation of the backlog FileStore port.
 * Default Node filesystem implementation of the {@link FileStore} port.
 *
 * The backlog store logic (store.ts) is pure: it never touches the filesystem
 * directly. All I/O flows through this injected interface so the marking /
 * concurrency logic is unit-testable without real files (and so the atomic
 * tmp-file+rename behaviour can be observed by an in-memory fake in tests).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Minimal filesystem port used by {@link BacklogStore}.
 *
 * `writeFileAtomic` MUST write to a sibling temp path and then `rename` it over
 * the destination, so a crash mid-write never leaves a truncated backlog.
 */
export interface FileStore {
  /** Read the whole file as UTF-8. Throws if the path does not exist. */
  readText(path: string): string;
  /** Write `data` then `rename` over `path` (crash-atomic on POSIX). */
  writeFileAtomic(path: string, data: string): void;
}

/** Node-backed {@link FileStore}: real `readFileSync` + temp-file `rename`. */
export const nodeFileStore: FileStore = {
  readText(path: string): string {
    return readFileSync(path, "utf8");
  },
  writeFileAtomic(path: string, data: string): void {
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  },
};
