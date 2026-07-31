import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRollPackageName } from "@roll/core";
import { isOlderThan } from "../runner/binary-staleness.js";
import { rollVersion } from "./version.js";

export interface LoopControlRunnerReadout {
  bin: string;
  runningVersion: string;
  projectVersion: string;
  projectNewer: boolean;
}

export function rollBin(): string {
  return (process.env["ROLL_BIN"] ?? "").trim() || process.argv[1] || "roll";
}

export function loopControlRunnerReadout(projectPath: string): LoopControlRunnerReadout {
  const runningVersion = rollVersion() || "unknown";
  const projectVersion = projectRollPackageVersion(projectPath);
  return {
    bin: rollBin(),
    runningVersion,
    projectVersion,
    projectNewer: projectVersion !== "" && isOlderThan(runningVersion, projectVersion),
  };
}

export function staleLoopRunnerMessage(command: string, readout: LoopControlRunnerReadout): string {
  return (
    `${command}: runner_stale_for_repo — running v${readout.runningVersion}, repo-local roll is v${readout.projectVersion}. ` +
    "Install/publish the repo-local build before starting autonomous work.\n"
  );
}

function projectRollPackageVersion(projectPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    // US-INSTALL-007: either published name is roll.
    if (typeof pkg.name !== "string" || !isRollPackageName(pkg.name)) return "";
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}
