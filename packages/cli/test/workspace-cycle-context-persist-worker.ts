import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { WorkspaceExecutionContextV1 } from "@roll/spec";
import { persistWorkspaceCycleContext } from "../src/runner/scoped-route.js";

const [runtimeDir, cycleId, contextPath, barrierPath, readyPath] = process.argv.slice(2);
if (!runtimeDir || !cycleId || !contextPath || !barrierPath || !readyPath) {
  process.stderr.write("missing workspace context persistence worker arguments\n");
  process.exit(2);
}

const context = JSON.parse(readFileSync(contextPath, "utf8")) as WorkspaceExecutionContextV1;
writeFileSync(readyPath, "ready\n", "utf8");
while (!existsSync(barrierPath) || readFileSync(barrierPath, "utf8").trim() !== "go") {
  // The parent releases both workers through one file barrier.
}

const result = persistWorkspaceCycleContext(runtimeDir, cycleId, context);
process.stdout.write(`${JSON.stringify(result.ok ? {
  ok: true,
  resolutionSource: result.context.resolution.source,
  evidenceSource: result.context.resolution.evidence[0]?.source,
} : result)}\n`);
