import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deltaCommand } from "../src/commands/delta.js";
import { renderState } from "../src/render.js";

const sha = "a".repeat(64);
let cwd = "";
let originalCwd = "";

function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture
  process.stdout.write = (value: string | Uint8Array) => { stdout.push(String(value)); return true; };
  // @ts-expect-error test capture
  process.stderr.write = (value: string | Uint8Array) => { stderr.push(String(value)); return true; };
  return deltaCommand(argv).then((code) => ({ code, stdout: stdout.join(""), stderr: stderr.join("") })).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
    renderState.useColor = true;
  });
}

function eventLines(): string {
  const events = [
    { type: "delta:prepared", delegationId: "d-1", runId: "delta-d-1", storyId: "US-METRIC-1", trigger: "host-guided", topology: "delta-team", qualityProfile: "verified", presetId: "mixed", presetSha256: sha, hostId: "codex", ts: 1000 },
    { type: "delta:role_resolved", delegationId: "d-1", storyId: "US-METRIC-1", role: "builder", roleInstanceId: "b", hostId: "codex", modelId: "gpt", source: "preset", reasons: [], inventorySha256: sha, inventoryObservedAt: "2026-01-01T00:00:00Z", ts: 1010 },
    { type: "delta:role_resolved", delegationId: "d-1", storyId: "US-METRIC-1", role: "evaluator", roleInstanceId: "e", hostId: "kimi", modelId: "k3", source: "preset", reasons: [], inventorySha256: sha, inventoryObservedAt: "2026-01-01T00:00:00Z", ts: 1010 },
    { type: "delta:role_started", delegationId: "d-1", storyId: "US-METRIC-1", role: "builder", sessionId: "bs", roleInstanceId: "b", hostId: "codex", modelId: "gpt", identityProvenance: "host-attested", worktreeAccess: "builder-write", ts: 1100 },
    { type: "tcr:round_started", v: 1, storyId: "US-METRIC-1", delegationId: "d-1", roundId: "r1", role: "builder", hostId: "codex", modelId: "gpt", headSha: "head", ts: 1200 },
    { type: "tcr:test_finished", v: 1, storyId: "US-METRIC-1", delegationId: "d-1", roundId: "r1", command: "roll test affected", affectedScope: "packages/core", exitCode: 0, wallMs: 50, outputSha256: sha, ts: 1300 },
    { type: "tcr:committed", v: 1, storyId: "US-METRIC-1", delegationId: "d-1", roundId: "r1", commitSha: "commit", proofAgeMs: 100, ts: 1400 },
    { type: "delta:artifact_published", delegationId: "d-1", storyId: "US-METRIC-1", role: "builder", path: "builder", sha256: sha, manifestPath: "manifest", sessionId: "bs", roleInstanceId: "b", identityProvenance: "host-attested", ts: 5100 },
    { type: "delta:role_started", delegationId: "d-1", storyId: "US-METRIC-1", role: "evaluator", sessionId: "es", roleInstanceId: "e", hostId: "kimi", modelId: "k3", identityProvenance: "host-attested", worktreeAccess: "read-only", ts: 5200 },
    { type: "delta:artifact_published", delegationId: "d-1", storyId: "US-METRIC-1", role: "evaluator", path: "evaluation", sha256: sha, manifestPath: "manifest", sessionId: "es", roleInstanceId: "e", identityProvenance: "host-attested", ts: 7200 },
    { type: "delta:attempt_outcome", v: 1, delegationId: "d-1", storyId: "US-METRIC-1", cause: "unknown", evidenceRef: "event:terminal", terminalFact: "handoff_ready", ts: 8000 },
    { type: "delta:terminal", delegationId: "d-1", storyId: "US-METRIC-1", runId: "delta-d-1", outcome: "handoff_ready", terminalBinding: "handoff_only", deliveryDisposition: "owner_continue", ts: 8000 },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

describe("US-DELTA-013 — roll delta metrics command", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "roll-delta-metrics-"));
    mkdirSync(join(cwd, ".roll", "loop"), { recursive: true });
    writeFileSync(join(cwd, ".roll", "loop", "events.ndjson"), eventLines());
    writeFileSync(join(cwd, ".roll", "loop", "deliveries.jsonl"), `${JSON.stringify({ storyId: "US-METRIC-1", lifecycleState: "done", mergedAt: { present: true, value: 10_000 } })}\n`);
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("emits a stable single-language EN panel and does not write the ledgers", async () => {
    const eventsPath = join(cwd, ".roll", "loop", "events.ndjson");
    const before = readFileSync(eventsPath, "utf8");
    const result = await capture(["metrics"]);
    expect(result).toMatchSnapshot();
    expect(readFileSync(eventsPath, "utf8")).toBe(before);
  });

  it("emits a stable single-language ZH panel", async () => {
    const prior = process.env["ROLL_LANG"];
    process.env["ROLL_LANG"] = "zh";
    try {
      const result = await capture(["metrics"]);
      expect(result).toMatchSnapshot();
      expect(result.stdout).not.toMatch(/first-pass merge|builder wall/);
    } finally {
      if (prior === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = prior;
    }
  });

  it("emits the versioned JSON contract and honors an empty window", async () => {
    const result = await capture(["metrics", "--from", "50000", "--to", "60000", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchSnapshot();
  });

  it("reports a partial ledger loudly rather than treating it as a green zero", async () => {
    writeFileSync(join(cwd, ".roll", "loop", "events.ndjson"), `${eventLines()}{not-json}\n`);
    const result = await capture(["metrics", "--json"]);
    const json = JSON.parse(result.stdout);
    expect(json.incomplete).toBe(true);
    expect(json.diagnostics.join("\n")).toMatch(/invalid event ledger line/);
    expect(json.tcr.rounds).toBe(1);
  });
});
