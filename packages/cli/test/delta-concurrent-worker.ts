/**
 * Concurrent prepare worker for US-DELTA-003 subprocess lease contention test.
 * Run via: tsx delta-concurrent-worker.ts <projectDir> <resolutionPath> <barrierPath> <workerId>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deltaCommand } from "../src/commands/delta.js";

const [projectDir, resolutionPath, barrierPath, workerId] = process.argv.slice(2);

if (!projectDir || !resolutionPath || !barrierPath || !workerId) {
  process.stderr.write("Usage: tsx delta-concurrent-worker.ts <projectDir> <resolutionPath> <barrierPath> <workerId>\n");
  process.exit(2);
}

// This runs after the module imports have completed. The parent only releases
// the barrier after both workers have acknowledged this point.
writeFileSync(join(projectDir, `ready-concurrent-worker-${workerId}`), String(process.pid), "utf8");

// Busy-wait for barrier file to contain "go"
while (true) {
  if (existsSync(barrierPath)) {
    try {
      const content = readFileSync(barrierPath, "utf8").trim();
      if (content === "go") break;
      if (content === "abort") process.exit(3);
    } catch { /* retry */ }
  }
}
// No jitter — barrier release is the sole synchronization point.
// Both workers see "go" in the same event-loop tick; the lock-based
// atomic lease claim (acquireLeaseLock + claimStoryLease) is the
// deterministic winner.
const saveCwd = process.cwd();
let code: number;
try {
  process.chdir(projectDir);
  code = await deltaCommand([
    "prepare", "US-DELTA-CONCURRENT",
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
