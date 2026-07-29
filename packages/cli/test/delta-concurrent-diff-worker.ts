/**
 * Concurrent prepare worker for different-story barrier test (US-DELTA-003).
 * Run via: npx tsx delta-concurrent-diff-worker.ts <projectDir> <storyId> <resolutionPath> <barrierPath> <workerId>
 *
 * Writes ready-diff-<workerId> file BEFORE entering barrier wait.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deltaCommand } from "../src/commands/delta.js";

const [projectDir, storyId, resolutionPath, barrierPath, workerIdRaw] = process.argv.slice(2);

if (!projectDir || !storyId || !resolutionPath || !barrierPath || !workerIdRaw) {
  process.stderr.write("Usage: tsx delta-concurrent-diff-worker.ts <projectDir> <storyId> <resolutionPath> <barrierPath> <workerId>\n");
  process.exit(2);
}

const workerId = parseInt(workerIdRaw, 10);

// Write ready acknowledgement BEFORE waiting for barrier
const readyPath = join(projectDir, `ready-diff-worker-${workerId}`);
writeFileSync(readyPath, String(process.pid), "utf8");

// Busy-wait for barrier file to contain "go"
while (true) {
  if (existsSync(barrierPath)) {
    try {
      const content = readFileSync(barrierPath, "utf8").trim();
      if (content === "go") break;
    } catch { /* retry */ }
  }
}

const saveCwd = process.cwd();
let code: number;
try {
  process.chdir(projectDir);
  code = deltaCommand([
    "prepare", storyId,
    "--trigger", "host-guided",
    "--topology", "delta-team",
    "--profile", "standard",
    "--preset", "local-preset",
    "--resolution", resolutionPath,
    "--json",
  ]);
} finally {
  process.chdir(saveCwd);
}

process.exit(code);
