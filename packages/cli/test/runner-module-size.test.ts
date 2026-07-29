import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runnerDir = fileURLToPath(new URL("../src/runner/", import.meta.url));

const refactor060Limits = [
  { file: "executor.ts", maxExclusive: 500 },
  { file: "run-records.ts", maxExclusive: 800 },
  { file: "runner-time.ts", maxExclusive: 800 },
  { file: "ports.ts", maxExclusive: 800 },
  { file: "pick-ranking.ts", maxExclusive: 800 },
  { file: "execution-profile.ts", maxExclusive: 800 },
  { file: "resume-truth.ts", maxExclusive: 800 },
  { file: "node-ports.ts", maxExclusive: 800 },
  { file: "publish-lifecycle.ts", maxExclusive: 800 },
  { file: "worktree-bootstrap.ts", maxExclusive: 800 },
  { file: "runner-policy.ts", maxExclusive: 800 },
  { file: "warm-sessions.ts", maxExclusive: 800 },
  { file: "project-map.ts", maxExclusive: 800 },
  { file: "spawn-observers.ts", maxExclusive: 800 },
  { file: "sandbox-boundary.ts", maxExclusive: 800 },
  { file: "agent-routing.ts", maxExclusive: 800 },
  { file: "setup-handlers.ts", maxExclusive: 810 },
  { file: "spawn-agent-handler.ts", maxExclusive: 800 },
  // US-CYCLE-008: risk-tier evaluation wiring. The feature's logic was extracted
  // into evaluation-tier.ts + evaluation-tier-stage.ts; only the unavoidable
  // capture-stage wiring remains here — the tier gate call + two fan-out deps + a
  // journal call, plus the fail-loud EARLY-block guards on each evaluator dispatch
  // (pairing loop, peer gate, score, ac-map, attest, evaluator) so a tier-blocked
  // cycle never runs a serial evaluation before blocking. Nudges this hot handler
  // just past 800 (cf. setup-handlers 810).
  { file: "capture-facts-handler.ts", maxExclusive: 825 },
  { file: "capture-peer-helpers.ts", maxExclusive: 800 },
  { file: "terminal-handlers.ts", maxExclusive: 800 },
] as const;

function lineCount(file: string): number {
  const text = readFileSync(join(runnerDir, file), "utf8").replace(/\n$/, "");
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

describe("REFACTOR-060 runner module size guard", () => {
  for (const item of refactor060Limits) {
    it(`${item.file} stays below ${item.maxExclusive} lines`, () => {
      expect(lineCount(item.file)).toBeLessThan(item.maxExclusive);
    });
  }
});
