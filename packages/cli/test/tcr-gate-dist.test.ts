/** Exercises the built CLI boundary: no source-only observation claim. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTcrObservationEvent, type TcrObservationEvent } from "@roll/spec";

const ROLL = resolve(__dirname, "../bin/roll.js");
const DIST = resolve(__dirname, "../dist/index.js");
const HOOKS = resolve(__dirname, "../../../hooks");
const STORY_ENV = { ROLL_STORY_ID: "US-DELTA-011", ROLL_DELEGATION_ID: "d-int", ROLL_HOST_ID: "codex", ROLL_MODEL_ID: "gpt-5.6-terra" };
let repo = "";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tcr-gate-dist-"));
  expect(existsSync(DIST), "build CLI before this boundary test").toBe(true);
  expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
  for (const args of [["config", "user.email", "t@example.test"], ["config", "user.name", "t"]]) {
    expect(spawnSync("git", args, { cwd: repo }).status).toBe(0);
  }
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function writeProject(script: string): void {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: script } }), "utf8");
  git("add", "-A");
  git("commit", "-qm", "init");
}
function stageChange(): void {
  writeFileSync(join(repo, "code.ts"), "export const fixture = 1;\n", "utf8");
  git("add", "-A");
}
function runRoll(args: string[], env: Record<string, string> = {}): { status: number; stderr: string } {
  const clean = { ...process.env };
  for (const key of ["ROLL_STORY_ID", "ROLL_DELEGATION_ID", "ROLL_HOST_ID", "ROLL_MODEL_ID", "ROLL_TCR_ROUND_ID"]) delete clean[key];
  const result = spawnSync("node", [ROLL, ...args], { cwd: repo, env: { ...clean, ...env }, encoding: "utf8" });
  return { status: result.status ?? 1, stderr: result.stderr ?? "" };
}
function events(): TcrObservationEvent[] {
  const file = join(repo, ".roll", "loop", "events.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const parsed = parseTcrObservationEvent(JSON.parse(line));
    expect(parsed, `strict parse: ${line}`).not.toBeNull();
    return parsed!;
  });
}
function proof(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repo, ".roll", "last-test-pass"), "utf8")) as Record<string, unknown>;
}

describe("built roll test TCR observations", () => {
  it("records one exact default round and closes it after the real commit", () => {
    writeProject("node -e \"console.log('fixture tests green')\"");
    stageChange();
    const run = runRoll(["test"], STORY_ENV);
    expect(run.status, run.stderr).toBe(0);
    const beforeCommit = events();
    expect(beforeCommit.map((event) => event.type)).toEqual(["tcr:round_started", "tcr:test_finished"]);
    expect(JSON.stringify(beforeCommit)).not.toContain("fixture tests green");
    expect(beforeCommit[0]!.roundId).toBe(beforeCommit[1]!.roundId);
    expect(proof()).toMatchObject({ roundId: beforeCommit[0]!.roundId, storyId: "US-DELTA-011", delegationId: "d-int" });
    git("config", "core.hooksPath", HOOKS);
    git("commit", "-qm", "tcr: fixture");
    const committed = events().filter((event): event is Extract<TcrObservationEvent, { type: "tcr:committed" }> => event.type === "tcr:committed");
    expect(committed).toHaveLength(1);
    expect(committed[0]!.commitSha).toBe(git("rev-parse", "HEAD"));
    expect(committed[0]!.proofAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("routes bare --affected through the same observed gate and forwards the id to a wrapper proof", () => {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "test-ts.sh"), [
      "#!/usr/bin/env bash", "set -euo pipefail", 'ROOT="$(git rev-parse --show-toplevel)"',
      'TREE="$(git -C "$ROOT" write-tree)"', 'ROUND=""',
      'if [ -n "${ROLL_TCR_ROUND_ID:-}" ]; then ROUND=",\\"roundId\\":\\"$ROLL_TCR_ROUND_ID\\",\\"storyId\\":\\"$ROLL_STORY_ID\\""; fi',
      'mkdir -p "$ROOT/.roll"', 'printf \'{"ts":%s,"tree":"%s","mode":"changed","scope":"affected"%s}\\n\' "$(date +%s)" "$TREE" "$ROUND" > "$ROOT/.roll/last-test-pass"',
    ].join("\n") + "\n", { mode: 0o755 });
    writeProject("bash scripts/test-ts.sh");
    stageChange();
    const run = runRoll(["test", "--affected"], STORY_ENV);
    expect(run.status, run.stderr).toBe(0);
    const observed = events();
    expect(observed.map((event) => event.type)).toEqual(["tcr:round_started", "tcr:test_finished"]);
    expect(observed[1]).toMatchObject({ command: "npm test -- --affected", affectedScope: "affected" });
    expect(proof()).toMatchObject({ roundId: observed[0]!.roundId, storyId: "US-DELTA-011" });
  });

  it("keeps a story-less legacy run free of fabricated observations", () => {
    writeProject("node -e \"console.log('fixture tests green')\"");
    stageChange();
    expect(runRoll(["test"]).status).toBe(0);
    expect(events()).toHaveLength(0);
    expect(proof()).not.toHaveProperty("roundId");
  });
});
