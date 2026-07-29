/**
 * Concurrent prepare worker with ready-file acknowledgement for US-DELTA-003.
 * Run via: npx tsx delta-concurrent-worker-ready.ts <projectDir> <resolutionPath> <barrierPath> <workerId>
 *
 * Writes ready-<workerId> file BEFORE entering barrier wait, so the main
 * test can wait for both workers to be ready (no fixed timeout / random jitter).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deltaCommand } from "../src/commands/delta.js";

const [projectDir, resolutionPath, barrierPath, workerIdRaw] = process.argv.slice(2);

if (!projectDir || !resolutionPath || !barrierPath || !workerIdRaw) {
  process.stderr.write("Usage: tsx delta-concurrent-worker-ready.ts <projectDir> <resolutionPath> <barrierPath> <workerId>\n");
  process.exit(2);
}

const workerId = parseInt(workerIdRaw, 10);

// Write ready acknowledgement BEFORE waiting for barrier
const readyPath = join(projectDir, `ready-worker-${workerId}`);
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
// No jitter — barrier release is the sole synchronization point.
// The lock-based atomic lease claim (acquireLeaseLock + claimStoryLease)
// is the deterministic winner.

const saveCwd = process.cwd();
let code: number;
try {
  process.chdir(projectDir);
  code = deltaCommand([
    "prepare", "US-DELTA-READY",
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
