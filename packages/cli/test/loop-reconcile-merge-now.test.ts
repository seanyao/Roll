/**
 * US-DELIV-003 — self-driven merge execution tests.
 *
 * Tests that `loopReconcileCommand` executes `gh pr merge --squash` when
 * `reconcileDelivery` returns `merge_now`, and emits appropriate
 * `delivery:merge_attempt` events.
 *
 * Since gh is not available in test environments, the merge attempt will
 * produce outcome "gh_down" — the key assertion is that the event IS
 * emitted (the code paths are exercised).
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

/**
 * Create a temp project directory with a git repo and GitHub remote.
 * Isolates from the parent worktree's GIT_* env vars by unsetting them.
 */
function project(): string {
  const savedEnv: Record<string, string | undefined> = {};
  const gitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
  for (const k of gitVars) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  try {
    const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-deliv003-")));
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

/** Write events to the project's event store. */
function writeEvents(p: string, events: Record<string, unknown>[]): void {
  const path = join(p, ".roll", "loop", "events.ndjson");
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Read events from the project's event store. */
function readEvents(p: string): Record<string, unknown>[] {
  const path = join(p, ".roll", "loop", "events.ndjson");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const CYCLE = "20260712-220000-99999";
const TS = 1_779_837_600_000;

/** Create a fake PR status provider from a lookup map. */
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

/** Create a deps object with captured stdout/stderr. */
function deps(p: string, provider?: PrStatusProvider): LoopReconcileDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd: p,
    provider,
    bus: new EventBus(),
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    out,
    err,
  };
}

describe("US-DELIV-003 — self-driven merge execution", () => {
  it("merge_now emits delivery:merge_attempt event (gh_down in test env)", async () => {
    const p = project();
    const savedEnv: Record<string, string | undefined> = {};
    const gitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
    for (const k of gitVars) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }

    try {
      // Set up an awaiting_merge cycle with open+green PR.
      writeEvents(p, [
        { type: "cycle:start", cycleId: CYCLE, storyId: "US-DELIV-003", ts: TS },
        { type: "delivery:published", cycleId: CYCLE, storyId: "US-DELIV-003", branch: `loop/${CYCLE}`, prNumber: 42, ts: TS + 1 },
      ]);
      // Seed branch ref so the git subcommands don't fail.
      execSync(`git checkout -q -b loop/${CYCLE}`, { cwd: p });

      const d = deps(p, fakeProvider({ 42: { kind: "open", ci: "green", checkedAt: "2026-07-12T22:00:00Z" } }));
      const code = await loopReconcileCommand([], d);
      expect(code).toBe(0);

      // Should have emitted a delivery:merge_attempt event.
      const evs = readEvents(p);
      const mergeAttempt = evs.find((e) => e.type === "delivery:merge_attempt");
      expect(mergeAttempt).toBeDefined();
      expect(mergeAttempt!.cycleId).toBe(CYCLE);
      expect(mergeAttempt!.prNumber).toBe(42);
      expect(mergeAttempt!.method).toBe("squash");
      // In test env without gh, outcome will be gh_down or blocked
      expect(["gh_down", "blocked"]).toContain(mergeAttempt!.outcome);

      // Output should show merge_now icon.
      expect(d.out.join("")).toContain("🔄");
    } finally {
      for (const k of gitVars) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  });

  it("dry-run skips merge execution", async () => {
    const p = project();
    const savedEnv: Record<string, string | undefined> = {};
    const gitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
    for (const k of gitVars) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }

    try {
      writeEvents(p, [
        { type: "cycle:start", cycleId: CYCLE, storyId: "US-DELIV-003", ts: TS },
        { type: "delivery:published", cycleId: CYCLE, storyId: "US-DELIV-003", branch: `loop/${CYCLE}`, prNumber: 42, ts: TS + 1 },
      ]);
      execSync(`git checkout -q -b loop/${CYCLE}`, { cwd: p });

      const d = deps(p, fakeProvider({ 42: { kind: "open", ci: "green", checkedAt: "2026-07-12T22:00:00Z" } }));
      const code = await loopReconcileCommand(["--dry-run"], d);
      expect(code).toBe(0);

      // No merge_attempt event in dry-run mode.
      const evs = readEvents(p);
      const mergeAttempt = evs.find((e) => e.type === "delivery:merge_attempt");
      expect(mergeAttempt).toBeUndefined();
    } finally {
      for (const k of gitVars) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  });

  it("ci_red does not trigger merge attempt", async () => {
    const p = project();
    const savedEnv: Record<string, string | undefined> = {};
    const gitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
    for (const k of gitVars) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }

    try {
      // US-DELIV-010: publish "just now" — a fresh red CI is ci_failed; a red
      // CI older than CI_STUCK_DWELL_MS would (correctly) degrade to ci_stuck.
      const now = Date.now();
      writeEvents(p, [
        { type: "cycle:start", cycleId: CYCLE, storyId: "US-DELIV-003", ts: now },
        { type: "delivery:published", cycleId: CYCLE, storyId: "US-DELIV-003", branch: `loop/${CYCLE}`, prNumber: 42, ts: now + 1 },
      ]);
      execSync(`git checkout -q -b loop/${CYCLE}`, { cwd: p });

      const d = deps(p, fakeProvider({ 42: { kind: "open", ci: "red", checkedAt: "2026-07-12T22:00:00Z" } }));
      const code = await loopReconcileCommand([], d);
      expect(code).toBe(0);

      // Should say ci_failed, not merge.
      expect(d.out.join("")).toContain("❌");
      const evs = readEvents(p);
      const mergeAttempt = evs.find((e) => e.type === "delivery:merge_attempt");
      expect(mergeAttempt).toBeUndefined();
    } finally {
      for (const k of gitVars) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  });

  it("FIX-1248: ci pending/unknown waits instead of ci_failed", async () => {
    for (const ci of ["pending", "unknown"] as const) {
      const p = project();
      const savedEnv: Record<string, string | undefined> = {};
      const gitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
      for (const k of gitVars) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }

      try {
        const now = Date.now();
        writeEvents(p, [
          { type: "cycle:start", cycleId: CYCLE, storyId: "FIX-1248", ts: now },
          { type: "delivery:published", cycleId: CYCLE, storyId: "FIX-1248", branch: `loop/${CYCLE}`, prNumber: 42, ts: now + 1 },
        ]);
        execSync(`git checkout -q -b loop/${CYCLE}`, { cwd: p });

        const d = deps(p, fakeProvider({ 42: { kind: "open", ci, checkedAt: "2026-07-12T22:00:00Z" } }));
        const code = await loopReconcileCommand([], d);
        expect(code).toBe(0);

        // unknown/pending must NOT collapse to ci_failed (❌) nor merge (🔄): wait.
        expect(d.out.join("")).not.toContain("❌");
        expect(d.out.join("")).not.toContain("🔄");
        const evs = readEvents(p);
        expect(evs.find((e) => e.type === "delivery:merge_attempt")).toBeUndefined();
      } finally {
        for (const k of gitVars) {
          if (savedEnv[k] === undefined) delete process.env[k];
          else process.env[k] = savedEnv[k];
        }
      }
    }
  });

  it("merged PR is handled by reconcile (not merge_now)", async () => {
    const p = project();
    const savedEnv: Record<string, string | undefined> = {};
    const gitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
    for (const k of gitVars) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }

    try {
      writeEvents(p, [
        { type: "cycle:start", cycleId: CYCLE, storyId: "US-DELIV-003", ts: TS },
        { type: "delivery:published", cycleId: CYCLE, storyId: "US-DELIV-003", branch: `loop/${CYCLE}`, prNumber: 42, ts: TS + 1 },
      ]);
      execSync(`git checkout -q -b loop/${CYCLE}`, { cwd: p });
      // US-CYCLE-009 (codex r2): the merge is genuine on the git plane — PR #42's
      // squash commit lands on main — so the write-back is git-plane-confirmed.
      execSync("git checkout -q main", { cwd: p });
      execSync("git commit -q --allow-empty -m 'squash: US-DELIV-003 (#42)'", { cwd: p });

      const d = deps(p, fakeProvider({
        42: { kind: "merged", mergeCommit: "abc1234def", mergedAt: "2026-07-12T22:05:00Z", checkedAt: "2026-07-12T22:05:00Z" },
      }));
      const code = await loopReconcileCommand([], d);
      expect(code).toBe(0);

      // Should say delivered, not merge_now.
      expect(d.out.join("")).toContain("✅ delivered");
      const evs = readEvents(p);
      const reconciled = evs.find((e) => e.type === "delivery:reconciled");
      expect(reconciled).toBeDefined();
      expect(reconciled!.state).toBe("delivered_external");
    } finally {
      for (const k of gitVars) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  });
});
