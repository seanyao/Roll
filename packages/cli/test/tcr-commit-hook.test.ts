/**
 * US-DELTA-011 — the commit side of the TCR observation boundary.
 *
 * Exercises hooks/post-commit end-to-end in a throwaway git repo: the hook
 * correlates the landed commit with the roundId the `roll test` gate recorded
 * in `.roll/last-test-pass` and appends ONE strictly-parseable `tcr:committed`
 * fact. Absent correlation emits NOTHING (telemetry gap, never a fabricated
 * round); an absent proof clock emits the loud -1 sentinel, never fresh proof.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTcrObservationEvent, type TcrCommittedEvent } from "@roll/spec";

const HOOK = resolve(__dirname, "../../../hooks/post-commit");

let repo = "";
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tcr-hook-"));
  const init = spawnSync("git", ["init", "-q"], { cwd: repo });
  expect(init.status).toBe(0);
  mkdirSync(join(repo, ".roll"), { recursive: true });
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeProof(record: Record<string, unknown>): void {
  writeFileSync(join(repo, ".roll", "last-test-pass"), JSON.stringify(record) + "\n", "utf8");
}

function makeCommit(): { sha: string; tsSec: number } {
  writeFileSync(join(repo, "file.txt"), `content ${Date.now()}\n`, "utf8");
  spawnSync("git", ["add", "file.txt"], { cwd: repo });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  const c = spawnSync("git", ["commit", "-q", "-m", "tcr: test"], { cwd: repo, env });
  expect(c.status).toBe(0);
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const tsSec = Number(spawnSync("git", ["log", "-1", "--format=%ct"], { cwd: repo, encoding: "utf8" }).stdout.trim());
  return { sha, tsSec };
}

function runHook(): number {
  return spawnSync("bash", [HOOK], { cwd: repo }).status ?? 1;
}

function readCommittedEvents(): TcrCommittedEvent[] {
  const p = join(repo, ".roll", "loop", "events.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => parseTcrObservationEvent(JSON.parse(l)))
    .filter((e): e is TcrCommittedEvent => e !== null && e.type === "tcr:committed");
}

describe("hooks/post-commit — tcr:committed emission", () => {
  it("appends a strictly-parseable fact with the real commit SHA and proof age", () => {
    const { tsSec } = { tsSec: Math.floor(Date.now() / 1000) };
    writeProof({ ts: tsSec, testFinishedAtMs: Date.now(), tree: "T", mode: "affected", roundId: "tcr-1", storyId: "US-X-1", delegationId: "d1" });
    const commit = makeCommit();
    expect(runHook()).toBe(0);
    const events = readCommittedEvents();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev).toMatchObject({ v: 1, storyId: "US-X-1", delegationId: "d1", roundId: "tcr-1", commitSha: commit.sha });
    // Real timestamps: commit happened at/after the proof — age ≥ 0 and small.
    expect(ev.proofAgeMs).toBeGreaterThanOrEqual(0);
    expect(ev.proofAgeMs).toBeLessThan(60_000);
    expect(ev.ts).toBeGreaterThanOrEqual(commit.tsSec * 1000);
  });

  it("no proof file → no event, exit 0", () => {
    makeCommit();
    expect(runHook()).toBe(0);
    expect(readCommittedEvents()).toHaveLength(0);
  });

  it("legacy proof without roundId/storyId → no event (gap stays a gap)", () => {
    writeProof({ ts: Math.floor(Date.now() / 1000), tree: "T", mode: "affected" });
    makeCommit();
    expect(runHook()).toBe(0);
    expect(readCommittedEvents()).toHaveLength(0);
  });

  it("proof clock absent → loud -1 sentinel, never a fabricated fresh age", () => {
    writeProof({ tree: "T", mode: "affected", roundId: "tcr-2", storyId: "US-X-2" });
    makeCommit();
    expect(runHook()).toBe(0);
    const events = readCommittedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.proofAgeMs).toBe(-1);
  });

  it("stale proof → the computed age is recorded as-is (freshness is the projection's verdict)", () => {
    writeProof({ ts: Math.floor(Date.now() / 1000) - 300, testFinishedAtMs: Date.now() - 300_000, tree: "T", mode: "affected", roundId: "tcr-3", storyId: "US-X-3" });
    makeCommit();
    expect(runHook()).toBe(0);
    const events = readCommittedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.proofAgeMs).toBeGreaterThanOrEqual(300_000);
  });

  it("the emitted line never carries raw test output fields", () => {
    writeProof({ ts: Math.floor(Date.now() / 1000), testFinishedAtMs: Date.now(), tree: "T", mode: "affected", roundId: "tcr-4", storyId: "US-X-4" });
    makeCommit();
    expect(runHook()).toBe(0);
    const raw = readFileSync(join(repo, ".roll", "loop", "events.ndjson"), "utf8");
    expect(raw).not.toMatch(/stdout|stderr|rawOutput/);
  });
});
