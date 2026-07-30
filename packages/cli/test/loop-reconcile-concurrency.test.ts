/**
 * US-DELIV-011 — reconcile concurrent / re-entrant idempotency.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PrStatusProvider } from "@roll/core";
import { runReconcileTick } from "../src/commands/loop-reconcile.js";

const prMergeMock = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

vi.mock("@roll/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@roll/infra")>();
  return {
    ...actual,
    prMerge: (...args: unknown[]) => prMergeMock(...args),
  };
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const savedEnv: Record<string, string | undefined> = {};
  const gitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
  for (const k of gitVars) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-deliv011-")));
    dirs.push(p);
    mkdirSync(join(p, ".roll", "loop"), { recursive: true });
    execSync("git init -q", { cwd: p });
    execSync("git config user.email test@roll.local && git config user.name Test", { cwd: p });
    execSync("git checkout -q -b main && git commit -q --allow-empty -m init", { cwd: p });
    execSync("git remote add origin https://github.com/owner/repo.git", { cwd: p });
    return p;
  } finally {
    for (const k of gitVars) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

/** US-CYCLE-009: land a `(#N)` squash commit on main so the git plane confirms
 *  the merge (gh-state alone defers). */
function mergeOnMain(p: string, msg: string): void {
  const gitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
  const saved: Record<string, string | undefined> = {};
  for (const k of gitVars) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    execSync(`git commit -q --allow-empty -m '${msg}'`, { cwd: p });
  } finally {
    for (const k of gitVars) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function writeEvents(p: string, events: Record<string, unknown>[]): void {
  writeFileSync(
    join(p, ".roll", "loop", "events.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

function readEvents(p: string): Record<string, unknown>[] {
  return readFileSync(join(p, ".roll", "loop", "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const CYCLE = "20260713-181740-21357";
const STORY = "US-DELIV-011";
const TS_MS = 1_779_837_600_000;

function openGreenProvider(): PrStatusProvider {
  return {
    name: "fake-open-green",
    pollPrStatus: async () => ({
      kind: "open",
      ci: "green",
      // FIX-1489: merge permission is a NAMED verdict now, not the aggregate.
      checks: [{ name: "test-ts", conclusion: "success" }],
      draft: false,
      mergeable: "MERGEABLE",
      checkedAt: TS_MS,
    }),
  };
}

function mergedProvider(mergeCommit = "deadbeef"): PrStatusProvider {
  return {
    name: "fake-merged",
    pollPrStatus: async () => ({
      kind: "merged",
      mergeCommit,
      mergedAt: "2026-07-13T10:00:00Z",
      checkedAt: TS_MS,
    }),
  };
}

describe("US-DELIV-011 — reconcile concurrency", () => {
  it("concurrent reconcile ticks → at most one merge attempt and one delivered credit", async () => {
    prMergeMock.mockClear();
    const p = project();
    writeEvents(p, [
      { type: "cycle:start", cycleId: CYCLE, storyId: STORY, ts: TS_MS },
      {
        type: "delivery:published",
        cycleId: CYCLE,
        storyId: STORY,
        branch: `loop/${CYCLE}`,
        prNumber: 99,
        prUrl: "https://github.com/owner/repo/pull/99",
        ts: TS_MS + 1,
      },
    ]);

    const provider = openGreenProvider();
    const [r1, r2] = await Promise.all([
      runReconcileTick(p, { silent: true, provider }),
      runReconcileTick(p, { silent: true, provider }),
    ]);

    const processed = r1.cyclesProcessed + r2.cyclesProcessed;
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(processed).toBeLessThanOrEqual(2);
    expect(prMergeMock).toHaveBeenCalledTimes(1);

    const mergeAttempts = readEvents(p).filter((e) => e.type === "delivery:merge_attempt");
    expect(mergeAttempts).toHaveLength(1);
    expect(mergeAttempts[0]?.outcome).toBe("merged");

    const credits = readEvents(p).filter(
      (e) => e.type === "delivery:reconciled" && (e.state === "delivered" || e.state === "delivered_external"),
    );
    expect(credits).toHaveLength(0);
  });

  it("re-entry after merge_attempt merged converges to one delivered credit", async () => {
    prMergeMock.mockClear();
    const p = project();
    writeEvents(p, [
      { type: "cycle:start", cycleId: CYCLE, storyId: STORY, ts: TS_MS },
      {
        type: "delivery:published",
        cycleId: CYCLE,
        storyId: STORY,
        branch: `loop/${CYCLE}`,
        prNumber: 99,
        prUrl: "https://github.com/owner/repo/pull/99",
        ts: TS_MS + 1,
      },
      {
        type: "delivery:merge_attempt",
        cycleId: CYCLE,
        prNumber: 99,
        method: "squash",
        outcome: "merged",
        ts: TS_MS + 2,
      },
    ]);
    // The merge is genuine on the git plane (PR #99's squash commit on main),
    // so the write-back is git-plane-confirmed rather than gh-state-only.
    mergeOnMain(p, "squash: US-DELIV-011 (#99)");

    await runReconcileTick(p, { silent: true, provider: mergedProvider() });
    await runReconcileTick(p, { silent: true, provider: mergedProvider() });

    expect(prMergeMock).not.toHaveBeenCalled();
    const credits = readEvents(p).filter(
      (e) => e.type === "delivery:reconciled" && (e.state === "delivered" || e.state === "delivered_external"),
    );
    expect(credits).toHaveLength(1);
    expect(credits[0]?.cycleId).toBe(CYCLE);
  });

  it("re-entry after delivered credit does not duplicate events", async () => {
    prMergeMock.mockClear();
    const p = project();
    writeEvents(p, [
      { type: "cycle:start", cycleId: CYCLE, storyId: STORY, ts: TS_MS },
      {
        type: "delivery:published",
        cycleId: CYCLE,
        storyId: STORY,
        branch: `loop/${CYCLE}`,
        prNumber: 99,
        prUrl: "https://github.com/owner/repo/pull/99",
        ts: TS_MS + 1,
      },
      {
        type: "delivery:reconciled",
        cycleId: CYCLE,
        storyId: STORY,
        state: "delivered_external",
        mergedBy: "external",
        mergeCommit: "abc123",
        signal: "pr_state",
        ts: TS_MS + 2,
      },
    ]);

    const r = await runReconcileTick(p, { silent: true, provider: mergedProvider() });
    expect(r.cyclesProcessed).toBe(0);
    expect(prMergeMock).not.toHaveBeenCalled();
    const credits = readEvents(p).filter((e) => e.type === "delivery:reconciled");
    expect(credits).toHaveLength(1);
  });
});
