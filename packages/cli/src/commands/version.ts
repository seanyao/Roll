/**
 * @responsibility Runs the `version` subcommand, reporting the running Roll version from the install tree.
 */
/**
 * `roll version` — single source of truth for the running Roll version.
 *
 * FIX-202: the version probe reads the install tree's `package.json` `version`
 * field — under the v3 scheme only package.json is bumped on release. The
 * `VERSION="…"` literal baked into `bin/roll` is a v2-era fossil (frozen at the
 * v2→v3 cutover) and is consulted only as a last-resort fallback for a tree
 * that predates the package.json convention. The same probe backs `roll
 * version`, `roll update`'s "current version" line + npm self-check, and the
 * bash upgrade nag, so all three report the real installed version.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../bridge.js";

/** Read the `version` field from `<dir>/package.json`, or "" if unavailable. */
function versionFromPackageJson(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

/**
 * The version of an install tree rooted at `dir`: package.json is the single
 * source of truth (US-PORT-021 — the v2-era bin/roll `VERSION=` fallback is
 * retired with the bash engine).
 */
export function treeVersion(dir: string): string {
  return versionFromPackageJson(dir);
}

/**
 * The RUNNING binary's version. The running tree is the one containing the
 * executing `bin/roll` (repoRoot), independent of any ROLL_PKG_DIR override
 * (tests isolate the curl-swap tree there; it is not the running install).
 */
export function rollVersion(): string {
  return treeVersion(repoRoot());
}

export function versionCommand(args: string[]): number {
  void args; // `version` takes no flags.
  process.stdout.write(`roll v${rollVersion()}\n`);
  return 0;
}
