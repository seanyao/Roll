/**
 * @responsibility Classifies switcher rows into real projects vs temp/roll-meta fixtures for project switching.
 */
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, sep } from "node:path";

export interface ProjectPathRow {
  path: string;
}

/**
 * A switcher row is not a real project when its resolved path is an OS temp
 * fixture or the nested roll-meta `.roll` repo. Missing paths are handled by
 * `reachableProjects`; they are not enough to classify the path shape.
 */
export function isRealProjectPath(path: string): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return true;
  }
  if (basename(real) === ".roll") return false;

  let tmpReal = tmpdir();
  try {
    tmpReal = realpathSync(tmpReal);
  } catch {
    /* keep tmpdir() */
  }
  const tmpPrefix = tmpReal.endsWith(sep) ? tmpReal : tmpReal + sep;
  if (real.startsWith(tmpPrefix)) return false;

  let sysTmpReal = "/tmp";
  try {
    sysTmpReal = realpathSync("/tmp");
  } catch {
    /* /tmp may not exist on every platform */
  }
  const sysTmpPrefix = sysTmpReal.endsWith(sep) ? sysTmpReal : sysTmpReal + sep;
  return !real.startsWith(sysTmpPrefix);
}

export function reachableProjects<T extends ProjectPathRow>(
  rows: readonly T[],
  pathExists: (p: string) => boolean = existsSync,
): T[] {
  return rows.filter((row) => pathExists(row.path) && isRealProjectPath(row.path));
}
