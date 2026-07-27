/**
 * US-DELIV-005 — race resolution: the FIRST merge atomically supersedes the
 * remaining sibling cycles on the same card (same-card fan-out cleanup).
 *
 * Exercises `loopReconcileCommand` end to end on the event store: one cycle's
 * PR reports MERGED → its delivery:reconciled{delivered} event lands AND every
 * other non-terminal cycle on that story gets delivery:reconciled{superseded}
 * in the same pass (the atomic cancel). Idempotent: a re-run cancels nothing.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EventBus } from "@roll/core";
import type { PrCloudState, PrStatusProvider } from "@roll/core";
import { loopReconcileCommand, type LoopReconcileDeps } from "../src/commands/loop-reconcile.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

function withoutGitEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of GIT_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of GIT_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function project(): string {
  return withoutGitEnv(() => {
    const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-deliv005-")));
    dirs.push(p);
    mkdirSync(join(p, ".roll", "loop"), { recursive: true });
    execSync("git init -q", { cwd: p });
    execSync("git config user.email test@roll.local && git config user.name Test", { cwd: p });
    execSync("git checkout -q -b main && git commit -q --allow-empty -m init", { cwd: p });
    execSync("git remote add origin https://github.com/owner/repo.git", { cwd: p });
    return p;
  });
}

function writeEvents(p: string, events: Record<string, unknown>[]): void {
  writeFileSync(join(p, ".roll", "loop", "events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function readEvents(p: string): Record<string, unknown>[] {
  return readFileSync(join(p, ".roll", "loop", "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const TS = 1_779_837_600_000;
const STORY = "US-RACE-001";
const WINNER = "cycle-win-1";
const SIBLING = "cycle-sib-2";
const OTHER = "cycle-other-3";

function fakeProvider(states: Record<number, PrCloudState>): PrStatusProvider {
  return {
    name: "fake",
    async pollPrStatus(_slug: string, prNumber: number): Promise<PrCloudState> {
      const state = states[prNumber];
      if (state === undefined) throw new Error(`no fake state for PR #${prNumber}`);
      return state;
    },
  };
}

function deps(p: string, provider?: PrStatusProvider): LoopReconcileDeps & { out: string[] } {
  const out: string[] = [];
  return {
    cwd: p,
    provider,
    bus: new EventBus(),
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: () => {} },
    out,
  };
}

function seedRace(p: string): void {
  writeEvents(p, [
    { type: "cycle:start", cycleId: WINNER, storyId: STORY, ts: TS },
    { type: "delivery:published", cycleId: WINNER, storyId: STORY, branch: `loop/${WINNER}`, prNumber: 51, prUrl: "u", ts: TS + 1 },
    { type: "cycle:start", cycleId: SIBLING, storyId: STORY, ts: TS },
    { type: "delivery:published", cycleId: SIBLING, storyId: STORY, branch: `loop/${SIBLING}`, prNumber: 52, prUrl: "u", ts: TS + 1 },
    // A different story's cycle must NOT be cancelled.
    { type: "cycle:start", cycleId: OTHER, storyId: "US-OTHER-9", ts: TS },
    { type: "delivery:published", cycleId: OTHER, storyId: "US-OTHER-9", branch: `loop/${OTHER}`, prNumber: 53, prUrl: "u", ts: TS + 1 },
  ]);
  // US-CYCLE-009 (codex r2): the winner is a GENUINE git-plane merge — PR #51's
  // squash commit is on main — so the write-back is confirmed on the git plane
  // (siblings 52/53 stay open, so they are never confirmed). Without this the
  // gh-state-only merge would (correctly) defer and cancel no siblings.
  withoutGitEnv(() => execSync("git commit -q --allow-empty -m 'squash: US-RACE-001 winner (#51)'", { cwd: p }));
}

describe("US-DELIV-005 — first merge atomically cancels siblings", () => {
  it("MERGED winner → delivered event + superseded event for the same-story sibling only", async () => {
    const p = project();
    seedRace(p);
    const d = deps(
      p,
      fakeProvider({
        51: { kind: "merged", mergeCommit: "deadbeef123", mergedAt: "2026-07-12T22:00:00Z", checkedAt: "2026-07-12T22:00:00Z" },
        52: { kind: "open", ci: "green", checkedAt: "2026-07-12T22:00:00Z" },
        53: { kind: "open", ci: "green", checkedAt: "2026-07-12T22:00:00Z" },
      }),
    );
    const code = await withoutGitEnv(() => loopReconcileCommand([], d));
    expect(code).toBe(0);

    const evs = readEvents(p);
    const delivered = evs.find((e) => e.type === "delivery:reconciled" && e.cycleId === WINNER);
    expect(delivered).toMatchObject({ state: "delivered_external", mergeCommit: "deadbeef123" });

    const cancelled = evs.find((e) => e.type === "delivery:reconciled" && e.cycleId === SIBLING);
    expect(cancelled).toMatchObject({
      state: "superseded",
      storyId: STORY,
      mergeCommit: "deadbeef123",
      mergedBy: "external",
      signal: "pr_state",
    });

    // The other story's cycle is untouched.
    expect(evs.find((e) => e.type === "delivery:reconciled" && e.cycleId === OTHER)).toBeUndefined();
  });

  it("idempotent: a second reconcile cancels nothing (superseded siblings are terminal)", async () => {
    const p = project();
    seedRace(p);
    const d = deps(
      p,
      fakeProvider({
        51: { kind: "merged", mergeCommit: "deadbeef123", mergedAt: "2026-07-12T22:00:00Z", checkedAt: "2026-07-12T22:00:00Z" },
        52: { kind: "open", ci: "green", checkedAt: "2026-07-12T22:00:00Z" },
        53: { kind: "open", ci: "green", checkedAt: "2026-07-12T22:00:00Z" },
      }),
    );
    await withoutGitEnv(() => loopReconcileCommand([], d));
    const reconciled1 = readEvents(p).filter((e) => e.type === "delivery:reconciled").length;
    await withoutGitEnv(() => loopReconcileCommand([], d));
    const evs = readEvents(p);
    // No NEW delivery:reconciled events on the second pass (merge_attempt for
    // the still-open OTHER PR is pre-existing reconcile behavior, out of scope).
    expect(evs.filter((e) => e.type === "delivery:reconciled").length).toBe(reconciled1);
    expect(evs.filter((e) => e.type === "delivery:reconciled" && e.cycleId === SIBLING)).toHaveLength(1);
  });

  it("--dry-run emits no cancel events", async () => {
    const p = project();
    seedRace(p);
    const d = deps(
      p,
      fakeProvider({
        51: { kind: "merged", mergeCommit: "deadbeef123", mergedAt: "2026-07-12T22:00:00Z", checkedAt: "2026-07-12T22:00:00Z" },
      }),
    );
    const code = await withoutGitEnv(() => loopReconcileCommand(["--dry-run"], d));
    expect(code).toBe(0);
    expect(readEvents(p).find((e) => e.type === "delivery:reconciled")).toBeUndefined();
  });
});
