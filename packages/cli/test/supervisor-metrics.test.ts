import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervisorCommand } from "../src/commands/supervisor.js";

const dirs: string[] = [];

afterEach(() => {
  delete process.env["ROLL_LANG"];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(events: readonly Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), "roll-supervisor-metrics-"));
  dirs.push(root);
  mkdirSync(join(root, ".roll", "loop"), { recursive: true });
  writeFileSync(join(root, ".roll", "backlog.md"), `# Backlog

| ID | Description | Status |
| --- | --- | --- |
| US-DEP | dependency | 📋 Todo |
| US-BLOCKED | blocked \`depends-on:US-DEP\` | 📋 Todo |
| US-HANDOFF | handoff | 📋 Todo |
| US-MERGED | merged | ✅ Done |
| US-FULL | full | ✅ Done |
| US-PARTIAL | partial \`depends-on:US-FULL\` | 📋 Todo |
`);
  writeFileSync(join(root, ".roll", "loop", "events.ndjson"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return root;
}

function execute(root: string, args: string[]): { code: number; out: string; err: string } {
  const priorCwd = process.cwd();
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (value: string | Uint8Array): boolean => (out.push(String(value)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (value: string | Uint8Array): boolean => (err.push(String(value)), true);
  try {
    process.chdir(root);
    const result = supervisorCommand(args);
    if (typeof result !== "number") throw new Error("metrics command unexpectedly async");
    return { code: result, out: out.join(""), err: err.join("") };
  } finally {
    process.chdir(priorCwd);
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

const events = [
  { type: "pick:ranked", cycleId: "blocked", picked: "US-BLOCKED", rank: 1, total: 1, reason: "ready", ranking: [{ id: "US-BLOCKED", score: 1, reason: "ready" }], source: "cache", ts: 90 },
  { type: "pick:blocked", cycleId: "blocked", storyId: "US-BLOCKED", reason: "waiting", ts: 100 },
  { type: "cycle:start", cycleId: "blocked", storyId: "US-BLOCKED", agent: "codex", model: "gpt", ts: 200 },
  { type: "delta:prepared", delegationId: "handoff", runId: "delta-handoff", storyId: "US-HANDOFF", trigger: "host-guided", topology: "delta-team", qualityProfile: "verified", presetId: "standard", presetSha256: "a".repeat(64), hostId: "codex", ts: 300 },
  { type: "delta:terminal", delegationId: "handoff", storyId: "US-HANDOFF", outcome: "handoff_ready", terminalBinding: "handoff_only", ts: 350 },
  { type: "cycle:start", cycleId: "merged", storyId: "US-MERGED", agent: "codex", model: "gpt", ts: 400 },
  { type: "cycle:first_edit", cycleId: "merged", commitHash: "m", ts: 410 },
  { type: "pr:open", prNumber: 8, storyId: "US-MERGED", ts: 420 },
  { type: "ci:pass", prNumber: 8, ts: 430 },
  { type: "delivery:merge_confirmed", cycleId: "merged", storyId: "US-MERGED", branch: "roll/merged", signal: "ancestor", ts: 440 },
  { type: "cycle:start", cycleId: "full", storyId: "US-FULL", agent: "codex", model: "gpt", ts: 500 },
  { type: "cycle:first_edit", cycleId: "full", commitHash: "f", ts: 510 },
  { type: "pr:open", prNumber: 9, storyId: "US-FULL", ts: 520 },
  { type: "ci:pass", prNumber: 9, ts: 530 },
  { type: "delivery:merge_confirmed", cycleId: "full", storyId: "US-FULL", branch: "roll/full", signal: "ancestor", ts: 540 },
  { type: "delivery:reconciled", cycleId: "full", storyId: "US-FULL", state: "delivered", mergedBy: "runner", mergeCommit: "f", signal: "pr_state", ts: 550 },
  { type: "attest:gate", cycleId: "full", verdict: "produced", reasons: [], ts: 560 },
  { type: "pick:blocked", cycleId: "partial", storyId: "US-PARTIAL", reason: "waiting", ts: 600 },
] as const;

describe("US-LOOP-130 — roll supervisor metrics", () => {
  it("renders a frozen EN read-only terminal projection without writing the ledger", () => {
    const root = fixture(events);
    const ledger = join(root, ".roll", "loop", "events.ndjson");
    const before = readFileSync(ledger, "utf8");
    const result = execute(root, ["metrics"]);
    expect(result).toMatchSnapshot();
    expect(readFileSync(ledger, "utf8")).toBe(before);
  });

  it("renders a frozen ZH terminal projection in one language", () => {
    process.env["ROLL_LANG"] = "zh";
    const result = execute(fixture(events), ["metrics"]);
    expect(result).toMatchSnapshot();
    expect(result.out).not.toContain("queue wait");
  });

  it("emits stable JSON for handoff-only, merged-but-unattested, fully reconciled, and partial history", () => {
    const root = fixture([...events, { type: "not-a-roll-event", ts: 700 }]);
    const result = execute(root, ["metrics", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as { cards: Array<{ storyId: string; delivery: string; truth: { consistency: string } }>; incomplete: boolean };
    expect(report.cards.find((card) => card.storyId === "US-HANDOFF")).toMatchObject({ delivery: "not_delivered", truth: { consistency: "incomplete" } });
    expect(report.cards.find((card) => card.storyId === "US-MERGED")?.truth.consistency).toBe("inconsistent");
    expect(report.cards.find((card) => card.storyId === "US-FULL")?.truth.consistency).toBe("consistent");
    expect(report.incomplete).toBe(true);
    expect(report).toMatchSnapshot();
  });
});
