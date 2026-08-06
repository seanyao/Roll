/**
 * @responsibility Loads the runner policy and resume scope.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePolicy, type ResumeScope } from "@roll/core";

/**
 * Read the FIX-338 `loop_safety.project_map` flag from `<repoCwd>/.roll/policy.yaml`.
 * DEFAULT-OFF (稳字纪律): an absent / unreadable / `false` policy ⇒ `false`, so
 * deploy is a NO-OP until `project_map: true` is explicitly flipped on. Mirrors
 * {@link readPrebuildDistEnabled} exactly.
 */
export function readProjectMapEnabled(repoCwd: string): boolean {
  try {
    const p = join(repoCwd, ".roll", "policy.yaml");
    if (!existsSync(p)) return false;
    return parsePolicy(readFileSync(p, "utf8")).loopSafety.projectMap === true;
  } catch {
    return false; // unreadable / unparseable policy → default OFF (no-op)
  }
}

/**
 * Read the lever-4 `loop_safety.session_reuse` flag from
 * `<repoCwd>/.roll/policy.yaml`. DEFAULT-OFF (稳字纪律): an absent / unreadable /
 * `false` policy ⇒ `false`, so deploy is a NO-OP until `session_reuse: true` is
 * explicitly flipped on. Mirrors {@link readProjectMapEnabled} exactly.
 */
export function readSessionReuseEnabled(repoCwd: string): boolean {
  try {
    const p = join(repoCwd, ".roll", "policy.yaml");
    if (!existsSync(p)) return false;
    return parsePolicy(readFileSync(p, "utf8")).loopSafety.sessionReuse === true;
  } catch {
    return false; // unreadable / unparseable policy → default OFF (no-op)
  }
}

export function readResumeScope(repoCwd: string): ResumeScope {
  try {
    const p = join(repoCwd, ".roll", "policy.yaml");
    if (!existsSync(p)) return "off";
    return parsePolicy(readFileSync(p, "utf8")).loopSafety.resumeScope ?? "off";
  } catch {
    return "off";
  }
}
