/**
 * US-RULE-004c — CI's doc-drift adapter and the matching merge-check set.
 *
 * The verdict itself stays in `doc-drift.ts`; this module deliberately owns
 * only the two delivery adapters: a read-only CI probe and selection of the
 * exact named checks Roll-driven merges require for one registry gate mode.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRulesRegistry, type Result, type RulesParseError, type RulesRegistry } from "@roll/spec";
import { checkDocDrift, renderDocDriftSoftHit } from "./doc-drift.js";

export const DOC_DRIFT_CHECK_NAME = "doc-drift";
export const TEST_TS_CHECK_NAME = "test-ts";

/** The registry is the sole switch for whether the named drift check blocks. */
export function requiredChecksForDocDriftGate(mode: "soft" | "hard"): readonly string[] {
  return mode === "hard" ? [TEST_TS_CHECK_NAME, DOC_DRIFT_CHECK_NAME] : [TEST_TS_CHECK_NAME];
}

/** Parse the tracked registry and project its gate onto the exact-SHA merge set. */
export function requiredChecksFromRulesRegistry(registry: Result<RulesRegistry, RulesParseError>): readonly string[] {
  if (!registry.ok) throw new Error(`policy/rules.yaml rejected: ${registry.error.message}`);
  return requiredChecksForDocDriftGate(registry.value.gates.docDrift);
}

/**
 * Read the worktree-owned registry. Missing/invalid policy is deliberately an
 * error for a self-driven merge: guessing "soft" would be an authorization
 * bypass. Callers that have no policy at all may retain their legacy default.
 */
export function configuredRequiredChecks(cwd: string): readonly string[] | undefined {
  const path = join(cwd, "policy", "rules.yaml");
  if (!existsSync(path)) return undefined;
  let registry: Result<RulesRegistry, RulesParseError>;
  try {
    registry = parseRulesRegistry(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`policy/rules.yaml unreadable in ${cwd}`);
  }
  return requiredChecksFromRulesRegistry(registry);
}

export interface CiDocDriftResult {
  readonly exitCode: 0 | 1;
  readonly mode: "clean" | "hit" | "unresolved";
  readonly baseline?: string;
  readonly diagnostic: string;
}

export interface CiDocDriftSeams {
  readonly git?: (args: readonly string[]) => string;
  readonly registry?: () => Result<RulesRegistry, RulesParseError> | undefined;
  readonly warning?: (message: string) => void;
  readonly stdout?: (message: string) => void;
}

function shellGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function warningText(diagnostic: string): string {
  return diagnostic.replace(/\r?\n/g, "%0A");
}

/**
 * Run the named CI check against `merge-base HEAD origin/main`.
 *
 * It never writes `.roll`: CI observes the same shared verdict as cycle
 * publishing, but events remain cycle-side facts. A missing base/registry is
 * a hard CI error; a soft hit emits an Actions annotation and succeeds.
 */
export function runCiDocDriftCheck(cwd: string, seam: CiDocDriftSeams = {}): CiDocDriftResult {
  const print = seam.stdout ?? ((message: string) => process.stdout.write(message));
  const warn = seam.warning ?? ((message: string) => process.stdout.write(`::warning title=doc-drift::${message}\n`));
  const git = seam.git ?? ((args: readonly string[]) => shellGit(cwd, args));
  const unresolved = (diagnostic: string): CiDocDriftResult => {
    print(`doc-drift: ${diagnostic}\n`);
    return { exitCode: 1, mode: "unresolved", diagnostic };
  };

  let baseline: string;
  try {
    baseline = git(["merge-base", "HEAD", "origin/main"]).trim();
  } catch {
    return unresolved("baseline unavailable: could not resolve merge-base HEAD origin/main; fetch origin/main and retry");
  }
  if (!/^[0-9a-f]{40}$/i.test(baseline)) {
    return unresolved("baseline unavailable: merge-base HEAD origin/main returned no commit; fetch origin/main and retry");
  }

  let registry: Result<RulesRegistry, RulesParseError> | undefined;
  try {
    registry = seam.registry?.() ?? (() => {
      const path = join(cwd, "policy", "rules.yaml");
      return existsSync(path) ? parseRulesRegistry(readFileSync(path, "utf8")) : undefined;
    })();
  } catch {
    registry = undefined;
  }
  if (registry === undefined) return unresolved("registry unavailable: policy/rules.yaml could not be read");
  if (!registry.ok) return unresolved(`registry invalid: ${registry.error.message}`);

  let changedPaths: string[];
  try {
    changedPaths = git(["diff", "--name-only", "-z", `${baseline}...HEAD`])
      .split("\0")
      .filter((path) => path !== "");
  } catch {
    return unresolved(`diff unavailable: could not inspect ${baseline}...HEAD`);
  }
  const verdict = checkDocDrift({ changedPaths, surfaces: registry.value.docSurfaces });
  if (verdict.hits.length === 0) {
    const diagnostic = `clean against ${baseline}`;
    print(`doc-drift: ${diagnostic}\n`);
    return { exitCode: 0, mode: "clean", baseline, diagnostic };
  }

  // CI has no cycle identity and no event store. Render the same registry-backed
  // finding as cycle publishing but retain it as a diagnostic only.
  const diagnostic = renderDocDriftSoftHit(`ci-${baseline}`, verdict, "en").trim();
  warn(warningText(diagnostic));
  print(`doc-drift: ${diagnostic}\n`);
  return {
    exitCode: registry.value.gates.docDrift === "hard" ? 1 : 0,
    mode: "hit",
    baseline,
    diagnostic,
  };
}
