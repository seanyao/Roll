/**
 * US-CYCLE-009 — full async-merge chain: auto-merge attach (sha-pinned) →
 * git-plane merge verify (git only, never gh stdout) → reconcile write-back
 * (bounded retry + idempotent merge_confirmed + verified-only branch delete).
 */
import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RollEvent } from "@roll/spec";
import { planAutoMergeAttachArgv, matchHeadCommitSha } from "@roll/core";
import { runPublishPlan, type RunStep } from "@roll/infra";
import {
  verifyMergeGitPlane,
  reconcileMergeConfirmed,
  flipBacklogDeliveredWithRetry,
  confirmationFromReconcileResult,
  hasMergeConfirmedEvent,
  type WriteBackDeps,
} from "../src/commands/loop-reconcile-merge.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function withoutGitEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  const vars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
  for (const k of vars) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of vars) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const git = (cwd: string, cmd: string): void => execSync(`git ${cmd}`, { cwd, stdio: "ignore" });

function repoWithOrigin(setup: (p: string) => void): string {
  return withoutGitEnv(() => {
    const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-uscycle009-")));
    dirs.push(p);
    git(p, "init -q --bare remote.git");
    git(p, "init -q repo");
    const r = join(p, "repo");
    git(r, "config user.email test@roll.local");
    git(r, "config user.name Test");
    git(r, "checkout -q -b main");
    git(r, "commit -q --allow-empty -m init");
    git(r, "remote add origin ../remote.git");
    setup(r);
    git(r, "fetch -q origin");
    return r;
  });
}

const CYCLE = "cycle-20260723-000000-00001";
const BRANCH = `loop/${CYCLE}`;

describe("US-CYCLE-009 full chain: attach → git-plane verify → reconcile", () => {
  // ── Step 1: auto-merge attach (AC1) ───────────────────────────────────────
  it("attaches sha-pinned auto-merge and returns (never blocks on CI)", async () => {
    const calls: string[][] = [];
    const run: RunStep = async (_tool, argv) => {
      calls.push([...argv]);
      if (argv.includes("view")) return { code: 1, stdout: "", stderr: "" };
      if (argv.includes("create")) return { code: 0, stdout: "https://github.com/o/r/pull/42\n", stderr: "" };
      // The auto-merge attach returns immediately (armed) — no CI wait.
      return { code: 0, stdout: "", stderr: "" };
    };
    const attach = planAutoMergeAttachArgv("o/r", BRANCH, "f00dcafe");
    expect(matchHeadCommitSha(attach)).toBe("f00dcafe");
    const plan = [
      { tool: "gh" as const, kind: "gh-pr-view", argv: ["-R", "o/r", "pr", "view", BRANCH, "--json", "url", "-q", ".url"] },
      { tool: "gh" as const, kind: "gh-pr-create", argv: ["-R", "o/r", "pr", "create", "--base", "main", "--head", BRANCH, "--title", "t", "--body", "b"] },
      { tool: "gh" as const, kind: "gh-pr-merge-auto", argv: attach },
    ];
    const res = await runPublishPlan(plan, { ghAvailable: async () => true, run, sleep: async () => {} });
    expect(res.status).toBe(0);
    expect(res.prUrl).toBe("https://github.com/o/r/pull/42");
    // the merge step carried the head-sha pin.
    const mergeCall = calls.find((c) => c.includes("merge"));
    expect(mergeCall).toContain("--match-head-commit");
    expect(mergeCall).toContain("f00dcafe");
    expect(mergeCall).toContain("--auto");
  });

  // ── Step 2: git-plane verify (AC2) — git only, never gh stdout ─────────────
  it("confirms a squash merge from the git plane (patch-id), no gh consulted", () => {
    const repo = repoWithOrigin((r) => {
      git(r, `checkout -q -b ${BRANCH}`);
      execSync("echo feat > feat.txt", { cwd: r, shell: "/bin/bash" });
      git(r, "add feat.txt");
      git(r, "commit -q -m 'tcr: US-CYCLE-009 feature'");
      git(r, "checkout -q main");
      // squash-merge: same diff, different subject (subject-match blind).
      execSync("echo feat > feat.txt", { cwd: r, shell: "/bin/bash" });
      git(r, "add feat.txt");
      git(r, "commit -q -m 'Merge PR (#42)'");
      git(r, `push -q origin main ${BRANCH}`);
    });
    const confirmation = withoutGitEnv(() => verifyMergeGitPlane(repo, BRANCH, { integrationBranch: "origin/main" }));
    expect(confirmation.merged).toBe(true);
    expect(confirmation.signal).toBe("patch_id");
  });

  it("does NOT confirm an unmerged branch (no fabricated merge)", () => {
    const repo = repoWithOrigin((r) => {
      git(r, `checkout -q -b ${BRANCH}`);
      execSync("echo only > only.txt", { cwd: r, shell: "/bin/bash" });
      git(r, "add only.txt");
      git(r, "commit -q -m 'tcr: unmerged work'");
      git(r, "checkout -q main");
      git(r, `push -q origin main ${BRANCH}`);
    });
    const confirmation = withoutGitEnv(() => verifyMergeGitPlane(repo, BRANCH, { integrationBranch: "origin/main" }));
    expect(confirmation.merged).toBe(false);
    expect(confirmation.signal).toBe("none");
  });

  it("confirms a squash-merged-and-DELETED branch via the merge_commit signal (git log)", () => {
    // The common post-merge state: --delete-branch removed origin/<branch>, so
    // ancestor/patch-id cannot fire — only the (#42) commit on main proves it.
    const repo = repoWithOrigin((r) => {
      git(r, `checkout -q -b ${BRANCH}`);
      execSync("echo feat > feat.txt", { cwd: r, shell: "/bin/bash" });
      git(r, "add feat.txt");
      git(r, "commit -q -m 'tcr: work'");
      git(r, "checkout -q main");
      execSync("echo feat > feat.txt", { cwd: r, shell: "/bin/bash" });
      git(r, "add feat.txt");
      git(r, "commit -q -m 'squash: US-CYCLE-009 (#42)'");
      // push ONLY main — the branch is never on origin (deleted after merge).
      git(r, "push -q origin main");
    });
    const confirmation = withoutGitEnv(() =>
      verifyMergeGitPlane(repo, BRANCH, { integrationBranch: "origin/main", prNumber: 42, storyId: "US-CYCLE-009" }),
    );
    expect(confirmation.merged).toBe(true);
    expect(confirmation.signal).toBe("merge_commit");
  });

  it("confirms a fast-forward merge via the ancestor signal", () => {
    const repo = repoWithOrigin((r) => {
      git(r, `checkout -q -b ${BRANCH}`);
      git(r, "commit -q --allow-empty -m 'tcr: ff work'");
      // main fast-forwards to the branch tip (tip is an ancestor of main).
      git(r, "checkout -q main");
      git(r, `merge -q --ff-only ${BRANCH}`);
      git(r, `push -q origin main ${BRANCH}`);
    });
    const confirmation = withoutGitEnv(() => verifyMergeGitPlane(repo, BRANCH, { integrationBranch: "origin/main" }));
    expect(confirmation.merged).toBe(true);
    expect(confirmation.signal).toBe("ancestor");
  });

  // ── Step 3: reconcile write-back (AC3 + AC4) ──────────────────────────────
  it("write-back: bounded retry, idempotent merge_confirmed, verified-only delete", async () => {
    const events: RollEvent[] = [];
    const flips: Array<{ id: string; status: string }> = [];
    const deletions: string[] = [];
    let failFlips = 2; // fail the first two markStatus attempts, then succeed.

    const deps = (): WriteBackDeps => ({
      cwd: "/proj",
      eventsPath: "/proj/.roll/loop/events.ndjson",
      now: 1000,
      events: [...events],
      appendEvent: (_p, ev) => events.push(ev),
      markStatus: (_cwd, id, status) => {
        if (failFlips > 0) {
          failFlips--;
          throw new Error("snapshot hash changed (concurrent write)");
        }
        flips.push({ id, status });
      },
      alert: () => {},
      sleep: async () => {},
      deleteSourceBranch: (b) => { deletions.push(b); },
    });

    const cyc = {
      cycleId: CYCLE,
      storyId: "US-CYCLE-009",
      branch: BRANCH,
      prNumber: 42,
      confirmation: { merged: true, signal: "patch_id" as const },
      mergeCommit: "abc123",
    };

    const first = await reconcileMergeConfirmed(deps(), cyc);
    // AC3: bounded retry landed the flip after the 2 transient failures.
    expect(first.flipped).toBe(true);
    expect(flips).toHaveLength(1);
    // AC2: merge_confirmed recorded from the git plane.
    const confirmedEvents = events.filter((e) => e.type === "delivery:merge_confirmed");
    expect(confirmedEvents).toHaveLength(1);
    expect(confirmedEvents[0]).toMatchObject({ cycleId: CYCLE, signal: "patch_id", branch: BRANCH });
    // AC3: source branch deleted ONLY after the verified merge.
    expect(deletions).toEqual([BRANCH]);

    // AC4: a duplicate merge-confirmed observation does NOT double-record.
    const second = await reconcileMergeConfirmed(deps(), cyc);
    expect(second.flipped).toBe(true);
    expect(events.filter((e) => e.type === "delivery:merge_confirmed")).toHaveLength(1);
  });

  it("never deletes an UNVERIFIED branch (AC3 delete gate)", async () => {
    const events: RollEvent[] = [];
    const deletions: string[] = [];
    const deps: WriteBackDeps = {
      cwd: "/proj",
      eventsPath: "/proj/e.ndjson",
      now: 1,
      events,
      appendEvent: (_p, ev) => events.push(ev),
      markStatus: () => {},
      alert: () => {},
      deleteSourceBranch: (b) => { deletions.push(b); },
    };
    const out = await reconcileMergeConfirmed(deps, {
      cycleId: CYCLE,
      storyId: "US-CYCLE-009",
      branch: BRANCH,
      confirmation: { merged: false, signal: "none" },
    });
    expect(out.deleted).toBe(false);
    expect(deletions).toEqual([]);
    // no git-plane confirmation → no merge_confirmed fabricated.
    expect(events.filter((e) => e.type === "delivery:merge_confirmed")).toHaveLength(0);
  });

  // ── AC2 gate: gh-state alone NEVER flips; git-plane confirmation DOES ──────
  it("gh pr_state delivered but git plane CANNOT confirm → NO flip, NO delete, alerts (codex #1)", async () => {
    const events: RollEvent[] = [];
    const flips: string[] = [];
    const deletions: string[] = [];
    const alerts: string[] = [];
    const deps: WriteBackDeps = {
      cwd: "/proj",
      eventsPath: "/proj/e.ndjson",
      now: 1,
      events,
      appendEvent: (_p, ev) => events.push(ev),
      markStatus: (_c, id) => flips.push(id),
      alert: (m) => alerts.push(m),
      deleteSourceBranch: (b) => deletions.push(b),
      // git plane authority says NOT merged, even though the reconcile verdict is
      // a gh pr_state delivered.
      verify: () => ({ merged: false, signal: "none" }),
    };
    const out = await reconcileMergeConfirmed(deps, {
      cycleId: CYCLE,
      storyId: "US-CYCLE-009",
      branch: BRANCH,
      prNumber: 42,
      result: { kind: "delivered", via: "external", signal: "pr_state" },
    });
    expect(out.flipped).toBe(false);
    expect(out.deleted).toBe(false);
    expect(flips).toEqual([]);                // NO backlog flip on gh-state alone
    expect(deletions).toEqual([]);            // NO branch delete on gh-state alone
    expect(events.filter((e) => e.type === "delivery:merge_confirmed")).toHaveLength(0);
    // deferred, not dropped: alerts so the next reconcile / a human confirms.
    expect(alerts.some((a) => a.includes("git plane cannot confirm") && a.includes("DEFERRED"))).toBe(true);
  });

  it("git-plane verify CONFIRMS → flips + emits merge_confirmed even for a pr_state verdict (codex #1)", async () => {
    const events: RollEvent[] = [];
    const flips: string[] = [];
    const deps: WriteBackDeps = {
      cwd: "/proj",
      eventsPath: "/proj/e.ndjson",
      now: 1,
      events,
      appendEvent: (_p, ev) => events.push(ev),
      markStatus: (_c, id) => flips.push(id),
      alert: () => {},
      // git plane confirms via ancestor even though the verdict signal was pr_state.
      verify: () => ({ merged: true, signal: "ancestor" }),
    };
    const out = await reconcileMergeConfirmed(deps, {
      cycleId: CYCLE,
      storyId: "US-CYCLE-009",
      branch: BRANCH,
      prNumber: 42,
      result: { kind: "delivered", via: "external", signal: "pr_state" },
    });
    expect(out.flipped).toBe(true);
    expect(flips).toEqual(["US-CYCLE-009"]);
    const confirmed = events.filter((e) => e.type === "delivery:merge_confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ signal: "ancestor", cycleId: CYCLE });
  });

  it("verify() takes precedence over the result signal (patch_id verdict re-verified on git plane)", async () => {
    // A patch_id verdict whose git-plane re-check DISAGREES must not flip.
    const events: RollEvent[] = [];
    const flips: string[] = [];
    const deps: WriteBackDeps = {
      cwd: "/proj", eventsPath: "/proj/e.ndjson", now: 1, events,
      appendEvent: (_p, ev) => events.push(ev),
      markStatus: (_c, id) => flips.push(id),
      alert: () => {},
      verify: () => ({ merged: false, signal: "none" }),
    };
    const out = await reconcileMergeConfirmed(deps, {
      cycleId: CYCLE, storyId: "US-CYCLE-009", branch: BRANCH,
      result: { kind: "delivered", via: "external", signal: "patch_id" },
    });
    expect(out.flipped).toBe(false);
    expect(flips).toEqual([]);
  });

  it("alerts when the bounded write-back retry is exhausted (AC3)", async () => {
    const alerts: string[] = [];
    const out = await flipBacklogDeliveredWithRetry(
      "/proj",
      "US-CYCLE-009",
      {
        markStatus: () => { throw new Error("always fails"); },
        alert: (m) => alerts.push(m),
        sleep: async () => {},
        maxAttempts: 3,
      },
    );
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(3);
    expect(alerts.some((a) => a.includes("exhausted 3 attempts"))).toBe(true);
  });

  it("confirmationFromReconcileResult: only patch_id is git-plane; gh pr_state is not", () => {
    expect(confirmationFromReconcileResult({ kind: "delivered", via: "external", signal: "patch_id" })).toEqual({ merged: true, signal: "patch_id" });
    expect(confirmationFromReconcileResult({ kind: "delivered", via: "external", signal: "pr_state" })).toEqual({ merged: false, signal: "none" });
    expect(confirmationFromReconcileResult({ kind: "wait" })).toEqual({ merged: false, signal: "none" });
  });

  it("hasMergeConfirmedEvent detects a prior git-plane confirmation", () => {
    const evs: RollEvent[] = [
      { type: "delivery:merge_confirmed", cycleId: CYCLE, storyId: "US-CYCLE-009", branch: BRANCH, signal: "ancestor", ts: 1 },
    ];
    expect(hasMergeConfirmedEvent(evs, CYCLE)).toBe(true);
    expect(hasMergeConfirmedEvent(evs, "other")).toBe(false);
  });
});
