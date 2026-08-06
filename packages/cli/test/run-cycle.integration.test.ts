/**
 * E2E integration test for the v3 loop RUNNER ADAPTER (US-LOOP-006 prerequisite).
 *
 * The crown: a REAL fixture git repo (bare file:// remote + working clone) with a
 * fixture backlog carrying one story, driven end-to-end through {@link
 * runCycleOnce} — pick → route → worktree → execute → publish → terminal — with
 * EVERY execution layer faked so there are NO real network / agent / PR side
 * effects:
 *   - agentSpawn  : a SHIM that fabricates a passing `tcr:` commit IN the cycle
 *                   worktree (no real `claude`), exactly like difftests fabricate
 *                   binaries.
 *   - github      : a FAKE facet returning a canned publish status (the publish
 *                   PLAN is real core output; the gh execution is faked). The
 *                   push targets the LOCAL bare remote (file://), so even the
 *                   git half stays offline.
 *
 * Asserts the runner honours the hard list:
 *   - the lock is RELEASED at the end (next cycle can take over),
 *   - a heartbeat file EXISTED during the run,
 *   - a TERMINAL cycle:end event is present (I8),
 *   - the runs.jsonl row shape matches v2 (keys checked against the dashboard
 *     difftest fixture: run_id/status/agent/built/tcr_count + the bus dedupe
 *     keys story_id/cycle_id),
 *   - the cycle lands `done` (published) / built.
 *
 * Plus a kill-mid-execute test (I2): a watchdog breach during execute → terminal
 * event STILL written, lock released, and a fresh runCycleOnce takes over cleanly.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RouteDeps } from "@roll/core";
import {
  type AgentSpawn,
  type AgentSpawnResult,
  type Ports,
  type RunnerPaths,
  nodePorts,
  runCycleOnce,
} from "../src/runner/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      execFileSync("rm", ["-rf", d]);
    } catch {
      /* best effort */
    }
  }
});

function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `roll-runner-${tag}-`));
  dirs.push(d);
  return realpathSync(d);
}

const GIT_ID = ["-c", "user.email=t@t", "-c", "user.name=t"];
function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function gitSucceeds(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", [...args], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function localLoopCycleBranches(repo: string): string[] {
  const out = git(repo, ["branch", "--list", "loop/cycle-*"]).trim();
  return out === "" ? [] : out.split("\n").map((line) => line.replace(/^\*\s*/, "").trim());
}

function bareRemoteHasRef(remote: string, branch: string): boolean {
  return gitSucceeds(remote, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

function currentGitBranch(cwd: string): string {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

const BACKLOG = [
  "| ID | Description | Status |",
  "|----|-------------|--------|",
  "| US-RUN-001 | Runner adapter smoke story est_min:5 | 📋 Todo |",
  "",
].join("\n");

function seedFeatureCard(root: string, storyId: string, title: string = "Runner adapter smoke story"): void {
  const storyDir = join(root, ".roll", "features", "uncategorized", storyId);
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(
    join(storyDir, "spec.md"),
    [`# ${storyId} — ${title}`, "", "**AC:**", "- [ ] cycle delivers with evidence", ""].join("\n"),
  );
  writeFileSync(
    join(storyDir, "ac-map.json"),
    JSON.stringify([
      {
        ac: `${storyId}:AC1`,
        status: "pass",
        evidence: [{ kind: "screenshot", label: `${storyId} terminal proof`, href: "screenshots/proof.png" }],
      },
    ]),
  );
  mkdirSync(join(storyDir, "screenshots"), { recursive: true });
  writeFileSync(join(storyDir, "screenshots", "proof.png"), "png\n");
  mkdirSync(join(storyDir, "latest"), { recursive: true });
  writeFileSync(join(storyDir, "latest", `${storyId}-report.html`), `<html><body>${storyId} report</body></html>\n`);
}

function initRollMetaOrigin(root: string, tag: string): void {
  const rollDir = join(root, ".roll");
  const remote = tmp(`${tag}-roll-meta-remote`);
  git(remote, ["init", "-q", "--bare", "-b", "main"]);
  git(rollDir, ["init", "-q", "-b", "main"]);
  git(rollDir, ["remote", "add", "origin", remote]);
  git(rollDir, [...GIT_ID, "add", "-A"]);
  git(rollDir, [...GIT_ID, "commit", "-q", "-m", "seed roll-meta"]);
  git(rollDir, ["push", "-q", "-u", "origin", "main"]);
}

/**
 * Build a fixture: a bare remote with `main` (carrying .roll/backlog.md) + a
 * working clone whose `origin` is the bare remote (file://). Returns both paths.
 */
function makeFixture(tag: string): { repo: string; remote: string } {
  const remote = tmp(`${tag}-remote`);
  git(remote, ["init", "-q", "--bare", "-b", "main"]);

  // Seed the remote's main via a throwaway clone.
  const seed = tmp(`${tag}-seed`);
  git(seed, ["clone", "-q", remote, "."]);
  mkdirSync(join(seed, ".roll"), { recursive: true });
  writeFileSync(join(seed, ".roll", "backlog.md"), BACKLOG, "utf8");
  seedFeatureCard(seed, "US-RUN-001");
  // Soft gates (9212553a fixture shape): the fixture env cannot run a REAL
  // peer consult or attest render (exit 2), and the default HARD gate modes
  // would classifyCaptured → needs_review → a manualMerge+draft publish whose
  // terminal is `local`, never `published`. `loop_safety: soft` keeps the
  // gates record-only — the same policy.yaml the US-LOOP-098 test writes.
  writeFileSync(join(seed, ".roll", "policy.yaml"), "loop_safety:\n  attest_gate: soft\n  peer_gate: soft\n", "utf8");
  git(seed, [...GIT_ID, "add", "-A"]);
  git(seed, [...GIT_ID, "commit", "-q", "-m", "seed backlog"]);
  git(seed, ["push", "-q", "origin", "main"]);

  // The working clone the runner operates from.
  const repo = tmp(`${tag}-repo`);
  git(repo, ["clone", "-q", remote, "."]);
  git(repo, ["fetch", "-q", "origin"]);
  // The honest publish path (9212553a fixture shape) commits acceptance
  // evidence / roll-meta with AMBIENT git identity (publish-lifecycle +
  // commitRollMetadata); CI runners carry no global identity, so pin a
  // persistent one (worktrees share the repo config) — same rationale as the
  // US-LOOP-098 test above.
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  // US-CYCLE-011: the round-tail `roll test --full` proof (`.roll/last-test-pass`)
  // is a TRANSIENT — production always gitignores it (roll's own `.gitignore` has
  // `.roll/`), so it never dirties the worktree or enters `git write-tree`. This
  // tracked-.roll fixture (FIX-198) commits `.roll/*`, so replicate the real
  // ignore for JUST the transient proof via the worktree-shared `.git/info/exclude`
  // (no committed-tree change). Without it the untracked proof → worktreeDirty →
  // handoff_without_tcr. The gitignored-.roll (symlink) layout already excludes
  // all of `.roll`, so it needs nothing extra.
  appendFileSync(join(repo, ".git", "info", "exclude"), "\n.roll/last-test-pass\n", "utf8");
  return { repo, remote };
}

function paths(rt: string, cycleId: string): RunnerPaths {
  return {
    eventsPath: join(rt, "events.ndjson"),
    runsPath: join(rt, "runs.jsonl"),
    alertsPath: join(rt, "alerts.log"),
    lockPath: join(rt, "inner.lock"),
    heartbeatPath: join(rt, "heartbeat"),
    worktreePath: join(rt, "worktrees", `cycle-${cycleId}`),
  };
}

const routeDeps: RouteDeps = {
  readSlot: () => "claude",
  firstInstalled: () => "claude",
};

/** A SHIM agent: makes a passing `tcr:` commit in the worktree, exit 0. Its
 *  stdout mirrors the real `claude --output-format stream-json` wire shape (a
 *  per-turn assistant `usage` + a final `result` with total_cost_usd) so the
 *  cost parse (FIX-208) has real input, exactly as difftests fabricate stdout. */
const CLAUDE_STREAM_JSON = [
  JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 } } }),
  JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.12, duration_ms: 8000 }),
].join("\n");
const shimAgentTcr: AgentSpawn = async (_agent, opts): Promise<AgentSpawnResult> => {
  const wt = opts.cwd;
  const storyId = opts.storyId ?? "US-RUN-001";
  const cycleIdFromRunDir = opts.runDir?.split(/[\\/]/).filter((part) => part !== "").pop();
  const cycleIdFromWorktree = /cycle-([^/\\]+)$/.exec(wt)?.[1];
  const scoreSessionId = `${cycleIdFromRunDir ?? cycleIdFromWorktree ?? "integration-cycle"}:score:pi:shim:1`;
  const notesDir = join(wt, ".roll", "features", "uncategorized", storyId, "notes");
  mkdirSync(notesDir, { recursive: true });
  // FIX-343 (step ③, B-decision): the attest gate honors ONLY an INDEPENDENT
  // fresh-session PEER score (`scoring: pair` + a `scored-by` + a `session-id`
  // that is NOT the builder's session id). The shim simulates the score stage's
  // peer note landing in the persistent .roll (the worktree's .roll is symlinked
  // to the repo's). Its session-id is minted under THIS cycle's score namespace
  // (`<cycleId>:score:...`) and can NEVER equal the builder's
  // `<cycleId>:build:claude:<clock>` id, so the note qualifies as an independent
  // fresh-session score and the delivery reaches PASS.
  writeFileSync(
    join(notesDir, `2026-06-08-roll-build-${storyId}-shim.md`),
    [
      "---",
      "skill: roll-build",
      `story: ${storyId}`,
      "score: 8",
      "verdict: good",
      "ts: 2026-06-08T00:00:00Z",
      "scoring: pair",
      "scored-by: pi",
      `session-id: ${scoreSessionId}`,
      "---",
      "",
      "Shim delivery wrote the required peer review score note.",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(wt, "delivered.txt"), "work done by shim agent\n", "utf8");
  // 9212553a honest-publish fixture shape: mirror the agent-deposited cycle
  // evidence into the WORKTREE's own runDir too. For the tracked-.roll layout
  // (makeFixture) the worktree carries a physical .roll checkout and the
  // publish-time in-repo evidence commit (commitInRepoEvidence) stages the
  // cycle runDir FROM THE WORKTREE — it must exist there. For the gitignored
  // layout the worktree .roll is the FIX-204C symlink, so the runDir is the
  // same persistent dir the frame opened and the write is skipped.
  const runDirName = opts.runDir?.split(/[\\/]/).filter((part) => part !== "").pop();
  if (opts.runDir !== undefined && runDirName !== undefined) {
    const wtRunDirBase = join(wt, ".roll", "features", "uncategorized", storyId, runDirName);
    let sameDir = false;
    try {
      sameDir = realpathSync(wtRunDirBase) === realpathSync(opts.runDir);
    } catch {
      sameDir = false; // the worktree-local runDir does not exist yet (tracked layout)
    }
    if (!sameDir) {
      mkdirSync(join(wtRunDirBase, "evidence"), { recursive: true });
      writeFileSync(join(wtRunDirBase, "evidence", "shim-evidence.txt"), "shim cycle evidence\n", "utf8");
    }
  }
  git(wt, [...GIT_ID, "add", "-A"]);
  git(wt, [...GIT_ID, "commit", "-q", "--no-verify", "-m", `tcr: deliver ${storyId}`]);
  // US-CYCLE-011: mint the round-tail FULL-verify proof exactly as the real
  // builder does (`roll test --full`) — as the FINAL act, AFTER the last commit.
  // `evaluateEvidenceGate` now blocks a publish that lacks a fresh `mode:"full"`
  // proof whose tree matches the delivered tree. The tree is `git write-tree`
  // right after the commit (== HEAD tree); the proof file is written UNSTAGED, so
  // it never enters `git write-tree` — the gate computes the identical tree at
  // publish time (the in-repo evidence commit runs AFTER the gate). Works for
  // BOTH .roll layouts: gitignored/symlinked .roll is excluded from write-tree,
  // and for tracked .roll the proof file is simply never staged.
  const proofTree = git(wt, ["write-tree"]).trim();
  mkdirSync(join(wt, ".roll"), { recursive: true });
  writeFileSync(
    join(wt, ".roll", "last-test-pass"),
    JSON.stringify({ ts: Math.floor(Date.now() / 1000), tree: proofTree, mode: "full" }) + "\n",
    "utf8",
  );
  return { stdout: CLAUDE_STREAM_JSON, stderr: "", exitCode: 0, timedOut: false };
};

/** A fake github facet that returns a canned publish status without any gh.
 *  `prState` defaults to "MERGED" (the auto-merge already completed) but can be
 *  overridden — FIX-211 needs to drive the "published-but-OPEN" path where the
 *  backlog row must rest at 🔨 (delivered, pending merge), never premature Done.
 *
 *  v2 honest-publish shape (9212553a): the terminal MERGED credit now requires
 *  `ctx.tcrCount > 0 && ctx.prUrl`, and `ctx.prUrl` is threaded ONLY by the
 *  normal publish path — a pre-existing OPEN/MERGED PR at publish time trips
 *  the FIX-245 self-publish adoption short-circuit, which never sets it. So
 *  the fake simulates an honest first-time publish: NO PR exists before
 *  runPublishPlan (`prState` "UNKNOWN", the real prViewState fallback when gh
 *  finds no PR), and the returned prUrl parses under prNumberFromUrl
 *  (`/pull/<n>`) so `delivery:published` is emitted and the DeliveryRecord
 *  carries a real prNumber. */
function fakeGithub(status: 0 | 1 | 2, prState: string = "MERGED"): Ports["github"] {
  let published = false;
  return {
    async repoSlug() {
      return "fixture/runner";
    },
    async runPublishPlan() {
      published = true;
      return { status, prUrl: status === 0 ? "https://github.com/fixture/runner/pull/1" : "", ok: status === 0 };
    },
    async prState() {
      return published ? prState : "UNKNOWN";
    },
    async prMergeInfo() {
      return prState === "MERGED"
        ? { state: "MERGED", mergedAt: "2026-06-21T00:00:00Z", mergeCommit: "abc123def456" }
        : { state: prState };
    },
    async openPrTitles() {
      return [];
    },
  };
}

/** A fixed clock (epoch seconds) we can advance to drive the watchdog. */
function fixedClock(start: number): { clock: () => number; set: (v: number) => void } {
  let now = start;
  return { clock: () => now, set: (v) => (now = v) };
}

describe("runCycleOnce E2E (fixture repo + shim agent + faked gh)", () => {
  it("US-LOOP-098 proves detached cycle branch governance against real git refs", async () => {
    const { repo, remote } = makeGitignoredFixture("branch-gov");
    // CI runners carry no global git identity; the cycle's own commits (worktree
    // product commit, .roll evidence/metadata push) run with ambient git, so pin
    // a persistent identity in the repo (shared by its worktrees) AND the nested
    // .roll repo — otherwise publish aborts with "Author identity unknown".
    for (const dir of [repo, join(repo, ".roll")]) {
      git(dir, ["config", "user.email", "t@t"]);
      git(dir, ["config", "user.name", "t"]);
    }
    writeFileSync(join(repo, ".roll", "policy.yaml"), "loop_safety:\n  attest_gate: soft\n  peer_gate: soft\n", "utf8");
    const rt = tmp("branch-gov-rt");
    const cycleId = "20260709-010203-4098";
    const branch = `loop/cycle-${cycleId}`;
    const p = paths(rt, cycleId);
    const observedStages: string[] = [];
    let mergeDeletedRemoteRef = false;

    const expectMainHasNoLocalLoopBranches = (stage: string): void => {
      expect(localLoopCycleBranches(repo), stage).toEqual([]);
      observedStages.push(stage);
    };
    const expectWorktreeDetached = (stage: string): void => {
      expect(currentGitBranch(p.worktreePath), stage).toBe("HEAD");
    };

    const shim: AgentSpawn = async (agent, opts) => {
      const r = await shimAgentTcr(agent, opts);
      expectMainHasNoLocalLoopBranches("after-agent-commit");
      expectWorktreeDetached("after-agent-commit");
      return r;
    };

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = {
      ...base,
      agentSpawn: shim,
      installedAgents: () => ["claude"],
      attest: {
        async render() {
          return 0;
        },
      },
      git: {
        ...base.git,
        async worktreeAdd(repoCwd, path, branchName, baseRef) {
          const r = await base.git.worktreeAdd(repoCwd, path, branchName, baseRef);
          expect(r.code).toBe(0);
          expectMainHasNoLocalLoopBranches("after-worktree-creation");
          expectWorktreeDetached("after-worktree-creation");
          return r;
        },
        async managedWorktreeRelease(repoCwd, path, expectedHead, repositoryId) {
          const r = await base.git.managedWorktreeRelease!(repoCwd, path, expectedHead, repositoryId);
          expectMainHasNoLocalLoopBranches("after-cleanup");
          return r;
        },
      },
      github: {
        async repoSlug() {
          return "fixture/runner";
        },
        async runPublishPlan(plan) {
          expectMainHasNoLocalLoopBranches("after-refspec-push");
          expectWorktreeDetached("after-refspec-push");
          expect(bareRemoteHasRef(remote, branch), "remote branch exists after refspec push").toBe(true);

          for (const step of plan) {
            if (step.kind === "gh-pr-merge-auto" || step.kind === "gh-pr-merge-admin") {
              git(remote, ["update-ref", "-d", `refs/heads/${branch}`]);
              mergeDeletedRemoteRef = true;
              expect(bareRemoteHasRef(remote, branch), "remote branch deleted by simulated --delete-branch merge").toBe(false);
            }
          }

          expect(mergeDeletedRemoteRef, "fake gh pr merge must simulate --delete-branch on the bare remote").toBe(true);
          expectMainHasNoLocalLoopBranches("after-publish");
          expectWorktreeDetached("after-publish");
          return { status: 0, prUrl: "https://example/pr/4098", ok: true };
        },
        async prState() {
          return "UNKNOWN";
        },
        async prMergeInfo() {
          return mergeDeletedRemoteRef
            ? { state: "MERGED", mergedAt: "2026-07-09T00:00:00Z", mergeCommit: "branchgov098" }
            : { state: "UNKNOWN" };
        },
        async openPrTitles() {
          return [];
        },
      },
    };

    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch, loop: "ci" as never },
    });

    expect(result.ran).toBe(true);
    const failureContext = existsSync(p.alertsPath) ? readFileSync(p.alertsPath, "utf8") : "";
    expect(result.terminal, failureContext).toBe("published");
    expect(observedStages).toEqual([
      "after-worktree-creation",
      "after-agent-commit",
      "after-refspec-push",
      "after-publish",
    ]);
    expect(localLoopCycleBranches(repo)).toEqual([]);
    expect(bareRemoteHasRef(remote, branch)).toBe(false);
    // A published PR is not merge + accepted-attest truth.  US-LOOP-124 keeps
    // the managed checkout and its Story reservation for the later release
    // operation instead of treating an open-PR terminal as permission to delete.
    expect(existsSync(p.worktreePath)).toBe(true);
  });

  it("drives pick→route→worktree→execute→publish→done, writes events/runs, releases lock", async () => {
    const { repo } = makeFixture("e2e");
    const rt = tmp("e2e-rt");
    const cycleId = "20260605-000000-1234";
    const p = paths(rt, cycleId);

    // Observe heartbeat liveness DURING the run via the agent shim (it runs in
    // the execute phase, after the heartbeat is written). Also capture the
    // worktree's commit log AT execute time (the `done` path cleans the worktree
    // afterward, so we record the tcr commit while the worktree still exists).
    let heartbeatExistedDuringRun = false;
    let tcrLogAtExecute = "";
    const shim: AgentSpawn = async (agent, opts) => {
      heartbeatExistedDuringRun = existsSync(p.heartbeatPath);
      const r = await shimAgentTcr(agent, opts);
      tcrLogAtExecute = git(opts.cwd, ["log", "--oneline"]);
      return r;
    };

    // claude is no longer a pool agent (no AgentSpec), but the claude-stream
    // harness cost extractor (sumClaudeStream) is KEPT and reachable via the
    // "claude-stream" usage kind. Route this cost-folding E2E to "claude-stream"
    // so the shim's claude wire-format stdout is parsed (the pool agents pi/kimi
    // do not emit claude stream-json).
    const claudeStreamRoute: RouteDeps = {
      readSlot: () => "claude-stream",
      firstInstalled: () => "claude-stream",
    };
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps: claudeStreamRoute });
    const ports: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };

    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    // Terminal: published → done.
    expect(result.ran).toBe(true);
    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending

    // Heartbeat existed during the agent run.
    expect(heartbeatExistedDuringRun).toBe(true);

    // Lock released (next cycle can take over).
    expect(existsSync(p.lockPath)).toBe(false);

    // Terminal cycle:end event present (I8).
    const events = readFileSync(p.eventsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { type: string; outcome?: string });
    const end = events.find((e) => e.type === "cycle:end");
    expect(end).toBeDefined();
    expect(end?.outcome).toBe("published_pending_merge");
    expect(end).not.toHaveProperty("failure_class");
    expect(end).not.toHaveProperty("root_cause_key");
    expect(events.some((e) => e.type === "cycle:start")).toBe(true);

    // runs.jsonl row shape matches v2 (keys verified vs dashboard difftest).
    const runs = readFileSync(p.runsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(runs.length).toBe(1);
    const row = runs[0] as Record<string, unknown>;
    for (const key of ["run_id", "status", "agent", "built", "tcr_count", "story_id", "cycle_id"]) {
      expect(Object.keys(row)).toContain(key);
    }
    expect(row["status"]).toBe("published"); // FIX-244: runs row keeps the pending-merge distinction for backfill
    expect(row["agent"]).toBe("claude-stream");
    expect(row["cycle_id"]).toBe(cycleId);
    expect(row["story_id"]).toBe("US-RUN-001");
    expect(row["built"]).toEqual(["US-RUN-001"]);
    expect(row["failure_class"]).toBeNull();
    expect(row["root_cause_key"]).toBeNull();
    // US-LOOP-104: a STANDARD cycle folds to no adversarial summary — the driver's
    // attachAdversarialRun read the real events off disk and buildRunRow stamped
    // null (exercises the seam end-to-end, not just the unit fold).
    expect(row["adversarial"]).toBeNull();

    // FIX-208 AC1: the runs row carries the REAL tcr commit count (the shim made
    // one `tcr:` commit) — no longer the hardcoded 0 that lied about delivery.
    expect(row["tcr_count"]).toBe(1);
    // FIX-208 AC2: cost is folded from the parsed claude stream-json usage — a
    // finite number with the real token split, not a zero placeholder.
    expect(typeof row["cost_usd"]).toBe("number");
    expect(row["tokens_in"]).toBe(100);
    expect(row["tokens_out"]).toBe(50);

    // FIX-208 AC3: the cycle:end event's cost AGREES with the runs row (one
    // source of truth — liveCtx.cost feeds both).
    const endCost = (end as { cost?: { tokensIn?: number; tokensOut?: number; estimatedCost?: number } }).cost;
    expect(endCost?.tokensIn).toBe(row["tokens_in"]);
    expect(endCost?.tokensOut).toBe(row["tokens_out"]);
    expect(endCost?.estimatedCost).toBe(row["cost_usd"]);

    // The shim's tcr commit really landed in the worktree (captured at execute
    // time; the worktree is cleaned by the `done` terminal path afterward).
    expect(tcrLogAtExecute).toContain("tcr: deliver US-RUN-001");
    // Published is pending merge, so the managed release writer preserves this
    // checkout until the merged-delivery and accepted-attest facts are durable.
    expect(existsSync(p.worktreePath)).toBe(true);

    // FIX-343 (step ③): the cycle:terminal twin resolves report/ac-map from the
    // PERSISTENT .roll (repoCwd) — never the worktree, which is torn down before
    // the terminal `append_run`. With the worktree gone, a worktree-rooted lookup
    // would false-negative `acmap_missing`; the repoCwd lookup still finds the
    // committed ac-map on disk (hasMap=true). The report freshness/`latest`
    // pointer lifecycle is exercised by the focused buildTerminalRecord unit
    // tests; here we lock that the terminal no longer false-negatives the ac-map
    // after teardown.
    const terminal = events.find((e) => (e as { type: string }).type === "cycle:terminal") as unknown as
      | { attest?: { present: boolean; value?: { acMap?: boolean; reportPath?: string }; reason?: string } }
      | undefined;
    expect(terminal).toBeDefined();
    // The committed ac-map lives in the persistent .roll, so reading repoCwd
    // finds it after the worktree is removed: present (report+map) or, if the
    // report `latest` pointer is absent, `not_rendered` — but NEVER the
    // worktree-rooted `acmap_missing` false-negative the fix eliminates.
    expect(terminal?.attest?.reason).not.toBe("acmap_missing");
  });

  it("US-EVID-001: opens the evidence frame before agent spawn and keeps agent-deposited evidence after cleanup", async () => {
    const { repo } = makeFixture("evid");
    const rt = tmp("evid-rt");
    const cycleId = "20260608-010101-9999";
    const p = paths(rt, cycleId);
    const expectedRunDir = join(repo, ".roll", "features", "uncategorized", "US-RUN-001", cycleId);
    let seenRunDir = "";

    const shim: AgentSpawn = async (agent, opts) => {
      expect(opts.runDir).toBe(expectedRunDir);
      seenRunDir = opts.runDir ?? "";
      expect(existsSync(join(seenRunDir, "evidence"))).toBe(true);
      expect(existsSync(join(seenRunDir, "screenshots"))).toBe(true);
      writeFileSync(join(seenRunDir, "evidence", "probe.txt"), "agent proof\n", "utf8");
      return shimAgentTcr(agent, opts);
    };

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };

    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    expect(seenRunDir).toBe(expectedRunDir);
    expect(readFileSync(join(expectedRunDir, "evidence", "probe.txt"), "utf8")).toBe("agent proof\n");
    const events = readFileSync(p.eventsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { type: string; runDir?: string });
    expect(events).toContainEqual({
      type: "evidence:frame-opened",
      cycleId,
      storyId: "US-RUN-001",
      runDir: expectedRunDir,
      ts: expect.any(Number),
    });
  });

  it("US-LOOP-124: watchdog breach preserves its Story reservation; a new cycle does not reuse the worktree", async () => {
    const { repo } = makeFixture("kill");
    const rt = tmp("kill-rt");
    const cycleId = "20260605-111111-2222";
    const p = paths(rt, cycleId);
    const fc = fixedClock(1_000_000);

    // Agent shim that "hangs": it advances the clock PAST the timeout so the
    // watchdog breaches on the NEXT step (simulating a SIGKILL mid-execute —
    // the cycle never gets a clean agent_exited).
    const hangingAgent: AgentSpawn = async (agent, opts) => {
      fc.set(1_000_000 + 4000); // > CYCLE_TIMEOUT_SEC (2700)
      return shimAgentTcr(agent, opts);
    };

    const base = nodePorts({
      repoCwd: repo,
      paths: p,
      skillBody: "deliver",
      routeDeps,
      clock: fc.clock,
    });
    const ports: Ports = { ...base, agentSpawn: hangingAgent, github: fakeGithub(0) };

    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
      timeoutSec: 2700,
    });

    expect(result.ran).toBe(true);
    // The watchdog breach short-circuits to a blocked terminal.
    expect(result.terminal).toBe("blocked");

    // Terminal event STILL written (I8) even on the abort path.
    const events = readFileSync(p.eventsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { type: string; outcome?: string });
    const end = events.find((e) => e.type === "cycle:end");
    expect(end).toBeDefined();
    expect(end?.outcome).toBe("blocked");

    // Lock released despite the abort.
    expect(existsSync(p.lockPath)).toBe(false);

    // A FRESH runCycleOnce finds the lock free but must not reuse the Story:
    // the ambiguous preserved checkout retains its delivery reservation.
    const cycleId2 = "20260605-222222-3333";
    const p2 = paths(rt, cycleId2);
    // US-CYCLE-011: the takeover cycle actually PUBLISHES, so its evidence gate
    // reads the shim's round-tail proof (ts = real wall clock). Use the DEFAULT
    // real clock (as every other publishing test here does) rather than an
    // artificial ~1970 fixed clock — otherwise the real-time proof looks "in the
    // future" to the gate's anti-replay freshness check and blocks the publish.
    const base2 = nodePorts({
      repoCwd: repo,
      paths: p2,
      skillBody: "deliver",
      routeDeps,
    });
    const ports2: Ports = { ...base2, agentSpawn: shimAgentTcr, github: fakeGithub(0) };
    const result2 = await runCycleOnce({
      ports: ports2,
      ctx: { cycleId: cycleId2, branch: `loop/cycle-${cycleId2}`, loop: "ci" as never },
    });
    expect(result2.ran).toBe(true);
    expect(result2.terminal).toBe("idle");
  });

  // FIX-1244 (实证 cycle-20260713-154751): a builder killed by the watchdog AFTER
  // landing real `tcr:` commits in the DETACHED cycle worktree was misjudged
  // zero-TCR (the timeout path never measured the worktree) → self-heal swapped
  // the agent and orphaned completed work. The teardown must count the worktree's
  // REAL tcr commits before the terminal row, and the measured count must reach
  // the caller (result.state.ctx) so the zero-TCR gate sees truth, not "unknown→0".
  it("FIX-1244 watchdog breach AFTER real tcr commits: teardown measures the detached worktree — tcr_count recorded, ctx carries it", async () => {
    const { repo } = makeFixture("fix1244");
    const rt = tmp("fix1244-rt");
    const cycleId = "20260713-154751-25482";
    const p = paths(rt, cycleId);
    const fc = fixedClock(1_000_000);

    // Same shape as the kill-mid-execute test: the shim lands ONE real `tcr:`
    // commit in the detached worktree, then the clock jumps past the timeout so
    // the watchdog breaches on the next step.
    const hangingAgent: AgentSpawn = async (agent, opts) => {
      fc.set(1_000_000 + 4000); // > CYCLE_TIMEOUT_SEC (2700)
      return shimAgentTcr(agent, opts);
    };

    const base = nodePorts({
      repoCwd: repo,
      paths: p,
      skillBody: "deliver",
      routeDeps,
      clock: fc.clock,
    });
    const ports: Ports = { ...base, agentSpawn: hangingAgent, github: fakeGithub(0) };

    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
      timeoutSec: 2700,
    });

    expect(result.ran).toBe(true);
    expect(result.terminal).toBe("blocked");

    // The worktree REALLY has the shim's tcr commit on its detached HEAD — prove
    // the fixture premise directly (no mock: real git, real detached worktree).
    expect(gitSucceeds(p.worktreePath, ["rev-parse", "--verify", "HEAD"])).toBe(true);
    const realTcr = git(p.worktreePath, ["log", "--oneline", "origin/main..HEAD"])
      .split("\n")
      .filter((l) => l.includes(" tcr:")).length;
    expect(realTcr).toBe(1);

    // The runs row records the MEASURED count, not the hardcoded 0 that
    // misjudged the incident cycle as zero-TCR.
    const rows = readFileSync(p.runsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { cycle_id?: string; tcr_count?: number });
    const row = rows.find((r) => r.cycle_id === cycleId);
    expect(row?.tcr_count).toBe(1);

    // And the caller (loop-run-once's zero-TCR gate) sees the measured count.
    expect(result.state?.ctx?.tcrCount).toBe(1);
  });

  // CI has observed this real-timer watchdog case flake at the default 30s budget.
  // The wall-time assertion below is the regression gate: the no-progress watchdog
  // must return well before the original 30s window would hang the suite. The
  // 60s Vitest timeout is only a last-resort harness guard, not the behavior check.
  it("FIX-907 hung builder (no-progress timeout): agent killed mid-spawn → blocked, lock released, branch PRESERVED, cycle:timeout recorded", async () => {
    const { repo } = makeFixture("hang907");
    const rt = tmp("hang907-rt");
    const cycleId = "20260622-090000-9907";
    const branch = `loop/cycle-${cycleId}`;
    const p = paths(rt, cycleId);
    const fc = fixedClock(3_000_000);

    // Pin SHORT real-poll + small idle window via env so the per-cycle watchdog
    // (FIX-907) trips in real wall-time inside the test. The builder NEVER commits
    // and NEVER emits — the exact FIX-390 silent-hang shape.
    const savedPoll = process.env["ROLL_TIMEOUT_POLL_MS"];
    const savedNp = process.env["ROLL_CYCLE_NO_PROGRESS_SEC"];
    const savedWall = process.env["ROLL_CYCLE_WALL_TIMEOUT_SEC"];
    process.env["ROLL_TIMEOUT_POLL_MS"] = "20";
    process.env["ROLL_CYCLE_NO_PROGRESS_SEC"] = "10"; // 10 fake-seconds of idle
    process.env["ROLL_CYCLE_WALL_TIMEOUT_SEC"] = "100000"; // wall far away — only idle trips

    // A hanging builder: it advances the FAKE clock past the idle window (so the
    // watchdog's pure verdict trips on the next real tick), then blocks until the
    // watchdog records cycle:timeout, then returns as if killed. No commit, no
    // onChunk → no progress signal at all.
    const hungBuilder: AgentSpawn = async () => {
      fc.set(3_000_000 + 11); // now-lastProgress = 11 > 10 → no-progress breach
      // Wait (bounded) for the real-timer watchdog to fire + record the event.
      const deadline = Date.now() + 3000;
      // eslint-disable-next-line no-constant-condition
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
        if (existsSync(p.eventsPath) && readFileSync(p.eventsPath, "utf8").includes('"cycle:timeout"')) break;
      }
      return { stdout: "", stderr: "", exitCode: 137, timedOut: false };
    };

    try {
      const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps, clock: fc.clock });
      const ports: Ports = { ...base, agentSpawn: hungBuilder, github: fakeGithub(0) };
      const startedWallMs = Date.now();
      const result = await runCycleOnce({
        ports,
        ctx: { cycleId, branch, loop: "ci" as never },
      });
      const elapsedWallMs = Date.now() - startedWallMs;

      expect(result.ran).toBe(true);
      // AC1: the no-progress hard timeout drove the cycle to a blocked terminal.
      expect(result.terminal).toBe("blocked");
      expect(elapsedWallMs).toBeLessThan(35_000);

      const events = readFileSync(p.eventsPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { type: string; outcome?: string; reason?: string; cycleId?: string });

      // AC4: a cycle:timeout event was recorded with the cycleId + reason.
      const timeout = events.find((e) => e.type === "cycle:timeout");
      expect(timeout).toBeDefined();
      expect(timeout?.reason).toBe("no-progress");
      expect(timeout?.cycleId).toBe(cycleId);

      // I8 / AC1: a terminal cycle:end (blocked) is still written.
      const end = events.find((e) => e.type === "cycle:end");
      expect(end?.outcome).toBe("blocked");

      // AC2: the inflight lock is RELEASED (a fresh cycle can take over).
      expect(existsSync(p.lockPath)).toBe(false);

      // AC3: work not discarded — timeout teardown never cleans the worktree.
      // US-LOOP-094: the cycle worktree is DETACHED (no local branch), so the
      // preservation invariant is the WORKTREE itself surviving (any commits are
      // on its detached HEAD; unpushed-work bundle safety net is US-LOOP-095).
      expect(existsSync(p.worktreePath)).toBe(true);
    } finally {
      const restore = (k: string, v: string | undefined): void => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("ROLL_TIMEOUT_POLL_MS", savedPoll);
      restore("ROLL_CYCLE_NO_PROGRESS_SEC", savedNp);
      restore("ROLL_CYCLE_WALL_TIMEOUT_SEC", savedWall);
    }
  }, 120_000);

  it("FIX-1474 lost builder child (killed out-of-band, spawn never settles): liveness probe → aborted terminal + durable run row, lock released, bounded", async () => {
    const { repo } = makeFixture("lost1474");
    const rt = tmp("lost1474-rt");
    const cycleId = "20260720-101010-1474";
    const branch = `loop/cycle-${cycleId}`;
    const p = paths(rt, cycleId);
    const fc = fixedClock(4_000_000);

    // Pin a short REAL poll cadence so the liveness probe trips in real
    // wall-time inside the test (same seam style as ROLL_TIMEOUT_POLL_MS).
    const savedPoll = process.env["ROLL_LIVENESS_POLL_MS"];
    process.env["ROLL_LIVENESS_POLL_MS"] = "20";

    // REAL process-death fixture: spawn a real sleeper as the "builder", report
    // its pid through the onSpawn seam, then SIGKILL it OUT-OF-BAND (not via
    // any runner watchdog) and NEVER settle the spawn promise — the lost
    // exit-delivery shape the in-band watchdogs cannot see. Without FIX-1474
    // this hangs the cycle forever.
    const lostChild: AgentSpawn = (_agent, opts) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      opts.onChunk?.(Buffer.from("builder started\n"));
      opts.onSpawn?.(child);
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 50).unref();
      return new Promise<AgentSpawnResult>(() => {}); // never settles
    };

    try {
      const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps, clock: fc.clock });
      const ports: Ports = { ...base, agentSpawn: lostChild, github: fakeGithub(0) };
      const startedWallMs = Date.now();
      const result = await runCycleOnce({
        ports,
        ctx: { cycleId, branch, loop: "ci" as never },
      });
      const elapsedWallMs = Date.now() - startedWallMs;

      expect(result.ran).toBe(true);
      // AC1: bounded detection — the cycle CONVERGED (did not hang)…
      expect(result.terminal).toBe("aborted");
      expect(elapsedWallMs).toBeLessThan(35_000);

      const events = readFileSync(p.eventsPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { type: string; outcome?: string; cycleId?: string; status?: string });

      // AC2: the auditable death event was recorded BEFORE the terminal.
      const lost = events.find((e) => e.type === "cycle:agent_lost");
      expect(lost).toBeDefined();
      expect(lost?.cycleId).toBe(cycleId);

      // AC2: explicit `aborted` terminal — a durable cycle:end…
      const end = events.find((e) => e.type === "cycle:end");
      expect(end?.outcome).toBe("aborted_no_delivery");

      // AC2: …and a durable runs row with the aborted status.
      const rows = readFileSync(p.runsPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { cycle_id?: string; status?: string });
      const row = rows.find((r) => r.cycle_id === cycleId);
      expect(row?.status).toBe("aborted");

      // AC1: the inflight lock is RELEASED (the loop never wedges).
      expect(existsSync(p.lockPath)).toBe(false);
    } finally {
      if (savedPoll === undefined) delete process.env["ROLL_LIVENESS_POLL_MS"];
      else process.env["ROLL_LIVENESS_POLL_MS"] = savedPoll;
    }
  }, 120_000);

  it("lock contention: a second concurrent cycle is skipped (ran=false)", async () => {
    const { repo } = makeFixture("lock");
    const rt = tmp("lock-rt");
    const cycleId = "20260605-333333-4444";
    const p = paths(rt, cycleId);

    // Pre-take the lock with THIS live pid so isLockHeld sees it as held.
    mkdirSync(rt, { recursive: true });
    writeFileSync(p.lockPath, `${process.pid}:${Math.floor(Date.now() / 1000)}\n`, "utf8");

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shimAgentTcr, github: fakeGithub(0) };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });
    expect(result.ran).toBe(false);
    expect(result.heldByPid).toBe(process.pid);
  });

  it("no-story backlog → idle terminal, worktree cleaned, lock released", async () => {
    const remote = tmp("idle-remote");
    git(remote, ["init", "-q", "--bare", "-b", "main"]);
    const seed = tmp("idle-seed");
    git(seed, ["clone", "-q", remote, "."]);
    mkdirSync(join(seed, ".roll"), { recursive: true });
    // Backlog with the one story already Done → nothing pickable.
    writeFileSync(
      join(seed, ".roll", "backlog.md"),
      "| ID | Description | Status |\n|--|--|--|\n| US-RUN-001 | done already | ✅ Done |\n",
      "utf8",
    );
    git(seed, [...GIT_ID, "add", "-A"]);
    git(seed, [...GIT_ID, "commit", "-q", "-m", "seed"]);
    git(seed, ["push", "-q", "origin", "main"]);
    const repo = tmp("idle-repo");
    git(repo, ["clone", "-q", remote, "."]);
    git(repo, ["fetch", "-q", "origin"]);

    const rt = tmp("idle-rt");
    const cycleId = "20260605-444444-5555";
    const p = paths(rt, cycleId);
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shimAgentTcr, github: fakeGithub(0) };

    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });
    // idle folds to the `built` spec outcome but the v2 terminal status is idle.
    expect(result.terminal).toBe("idle");
    expect(existsSync(p.lockPath)).toBe(false);
    const events = readFileSync(p.eventsPath, "utf8");
    expect(events).toContain('"cycle:end"');
    // US-LOOP-079d2: runs row carries status="idle" + outcome="idle_no_work"
    // so the dashboard and US-LOOP-079h2 dormant hook can read the idle signal.
    const runsRaw = readFileSync(p.runsPath, "utf8").trim();
    expect(runsRaw).toBeTruthy();
    const runsLines = runsRaw.split("\n").filter((l) => l.trim() !== "");
    expect(runsLines.length).toBeGreaterThanOrEqual(1);
    const lastRun = JSON.parse(runsLines[runsLines.length - 1] ?? "{}");
    expect(lastRun.status).toBe("idle");
    expect(lastRun.outcome).toBe("idle_no_work");
  });
});

/**
 * FIX-198 — the OWNER-OBSERVED scenario, end to end on the ORDINARY project
 * layout (`.roll/` GITIGNORED, never checked out into worktrees):
 *   1. pick must read the MAIN checkout's backlog (a worktree read sees no
 *      .roll at all and idles forever),
 *   2. 🔨 In Progress must land on the MAIN backlog the moment the story is
 *      claimed (anti duplicate-pick, visible to `roll backlog`/brief),
 *   3. ✅ Done must land deterministically at the done terminal — never an
 *      agent-discipline hope (the "嘴上 Done" lesson),
 *   4. a dead claim left by a killed cycle is recycled to 📋 Todo at the next
 *      cycle's preflight (the inner lock guarantees single-flight).
 */
function makeGitignoredFixture(tag: string): { repo: string; remote: string } {
  const remote = tmp(`${tag}-remote`);
  git(remote, ["init", "-q", "--bare", "-b", "main"]);
  const seed = tmp(`${tag}-seed`);
  git(seed, ["clone", "-q", remote, "."]);
  writeFileSync(join(seed, ".gitignore"), ".roll/\n", "utf8");
  writeFileSync(join(seed, "app.txt"), "app\n", "utf8");
  git(seed, [...GIT_ID, "add", "-A"]);
  git(seed, [...GIT_ID, "commit", "-q", "-m", "seed app (.roll gitignored)"]);
  git(seed, ["push", "-q", "origin", "main"]);
  const repo = tmp(`${tag}-repo`);
  git(repo, ["clone", "-q", remote, "."]);
  // .roll exists ONLY in the main checkout — exactly the SoloGo layout.
  mkdirSync(join(repo, ".roll"), { recursive: true });
  writeFileSync(join(repo, ".roll", "backlog.md"), BACKLOG, "utf8");
  seedFeatureCard(repo, "US-RUN-001");
  // Soft gates (9212553a fixture shape — see makeFixture) so the no-real-attest
  // fixture env reaches the honest publish path instead of a gate-blocked
  // needs_review/manualMerge terminal. The waiver lets the roll-meta commit
  // carry the seeded proof.png against the local (visibility-undetermined)
  // bare remote — the fixture remote stands in for a private one.
  writeFileSync(join(repo, ".roll", "policy.yaml"), "loop_safety:\n  attest_gate: soft\n  peer_gate: soft\n", "utf8");
  writeFileSync(join(repo, ".roll", "local.yaml"), "evidence_public_waiver: true\n", "utf8");
  initRollMetaOrigin(repo, tag);
  // The honest publish path (9212553a fixture shape) commits .roll evidence +
  // metadata with AMBIENT git identity; CI runners carry no global identity, so
  // pin a persistent one in the repo AND the nested roll-meta repo (worktrees
  // share the repo config) — same rationale as the US-LOOP-098 test.
  for (const dir of [repo, join(repo, ".roll")]) {
    git(dir, ["config", "user.email", "t@t"]);
    git(dir, ["config", "user.name", "t"]);
  }
  return { repo, remote };
}

/**
 * FIX-206 — the PARTIAL-fossil layout. `.roll/` is gitignored, yet a few stray
 * paths were force-committed before the ignore rule landed (the roll-meta
 * migration leak: `.roll/ops/release.sh` et al.). `git worktree add` checks
 * those fossils out, materializing a REAL `.roll/ops/` dir that shadows the
 * gitignored, main-only backlog the loop must read — the link guard saw `dst`
 * exist and skipped, so the worktree never saw the backlog (production blind
 * spot of FIX-204C, observed on the first v3 cycle).
 */
function makePartialFossilFixture(tag: string): { repo: string } {
  const remote = tmp(`${tag}-remote`);
  git(remote, ["init", "-q", "--bare", "-b", "main"]);
  const seed = tmp(`${tag}-seed`);
  git(seed, ["clone", "-q", remote, "."]);
  writeFileSync(join(seed, ".gitignore"), ".roll/\n", "utf8");
  writeFileSync(join(seed, "app.txt"), "app\n", "utf8");
  // The fossil: force-added past the ignore rule, exactly like the leaked
  // `.roll/ops/release.sh` the real repo still tracked.
  mkdirSync(join(seed, ".roll", "ops"), { recursive: true });
  writeFileSync(join(seed, ".roll", "ops", "release.sh"), "#!/bin/sh\n", "utf8");
  git(seed, [...GIT_ID, "add", "app.txt", ".gitignore"]);
  git(seed, [...GIT_ID, "add", "-f", ".roll/ops/release.sh"]);
  git(seed, [...GIT_ID, "commit", "-q", "-m", "seed app + fossil .roll/ops/release.sh"]);
  git(seed, ["push", "-q", "origin", "main"]);
  const repo = tmp(`${tag}-repo`);
  git(repo, ["clone", "-q", remote, "."]);
  // The real backlog lives ONLY in the main checkout (gitignored, main-only) —
  // alongside the checked-out fossil. The worktree will materialize the fossil
  // but never this backlog.
  writeFileSync(join(repo, ".roll", "backlog.md"), BACKLOG, "utf8");
  seedFeatureCard(repo, "US-RUN-001");
  // Soft gates + evidence waiver (9212553a fixture shape — see makeFixture /
  // makeGitignoredFixture). No initRollMetaOrigin here: the fossil layout's
  // .roll is not its own git repo.
  writeFileSync(join(repo, ".roll", "policy.yaml"), "loop_safety:\n  attest_gate: soft\n  peer_gate: soft\n", "utf8");
  writeFileSync(join(repo, ".roll", "local.yaml"), "evidence_public_waiver: true\n", "utf8");
  return { repo };
}

describe("FIX-206 — a partial-fossil .roll is relinked so the backlog is visible", () => {
  it("replaces the fossil dir with the symlink; agent reads the main-only backlog", async () => {
    const { repo } = makePartialFossilFixture("fossil");
    const rt = tmp("fossil-rt");
    const cycleId = "20260606-032000-3203";
    const p = paths(rt, cycleId);
    let isLink: boolean | null = null;
    let backlogViaWorktree = "";
    const shim: AgentSpawn = async (agent, opts) => {
      isLink = lstatSync(join(opts.cwd, ".roll"), { throwIfNoEntry: false })?.isSymbolicLink() === true;
      backlogViaWorktree = existsSync(join(opts.cwd, ".roll", "backlog.md"))
        ? readFileSync(join(opts.cwd, ".roll", "backlog.md"), "utf8")
        : "";
      return shimAgentTcr(agent, opts);
    };
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    // This test's intent is the fossil-relink mechanics, not the publish path.
    // Its `.roll` is NEITHER a nested roll-meta repo NOR tracked (beyond the
    // fossil file), so the honest remote-publish ladder cannot run here: the
    // in-repo evidence commit (commitInRepoEvidence) dies on `git add` beyond
    // the worktree's .roll SYMLINK (git refuses paths through a symlink). The
    // github fake therefore simulates the FIX-245 agent-self-published world it
    // always ran in (a pre-existing MERGED PR at publish time → the runner
    // adopts the registration, status 0). 9212553a: that world no longer earns
    // terminal Done credit (no ctx.prUrl) — this test asserts no Done flip.
    const selfPublishedGithub: Ports["github"] = {
      async repoSlug() {
        return "fixture/runner";
      },
      async runPublishPlan() {
        return { status: 0 as const, prUrl: "", ok: true };
      },
      async prState() {
        return "MERGED"; // the agent opened (and merged) its own PR mid-cycle
      },
      async prMergeInfo() {
        return { state: "MERGED", mergedAt: "2026-06-21T00:00:00Z", mergeCommit: "abc123def456" };
      },
      async openPrTitles() {
        return [];
      },
    };
    const ports: Ports = { ...base, agentSpawn: shim, github: selfPublishedGithub };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    // Before the fix: the materialized fossil dir blocked the link (real dir,
    // backlog shadowed). After: the guard replaces it with the link.
    expect(isLink).toBe(true);
    expect(backlogViaWorktree).toContain("US-RUN-001");
    // MAIN .roll untouched — the fossil's contents survive at the source.
    expect(readFileSync(join(repo, ".roll", "ops", "release.sh"), "utf8")).toContain("#!/bin/sh");
  });
});

describe("FIX-198 status flips on the gitignored-.roll layout", () => {

  it("pick from main · In-Progress mid-cycle · Done at terminal", async () => {
    const { repo } = makeGitignoredFixture("ord");
    const rt = tmp("ord-rt");
    const cycleId = "20260606-000000-2001";
    const p = paths(rt, cycleId);
    const backlogPath = join(repo, ".roll", "backlog.md");

    let inProgressDuringRun = "";
    let worktreeRollIsLink: boolean | null = null;
    const shim: AgentSpawn = async (agent, opts) => {
      inProgressDuringRun = readFileSync(backlogPath, "utf8");
      // FIX-204C: the worktree now SEES .roll — as a symlink to the main one.
      worktreeRollIsLink = lstatSync(join(opts.cwd, ".roll"), { throwIfNoEntry: false })?.isSymbolicLink() === true;
      return shimAgentTcr(agent, opts);
    };

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    expect(worktreeRollIsLink).toBe(true); // FIX-204C: linked, not checked out
    expect(inProgressDuringRun).toContain("🔨 In Progress"); // claimed on MAIN, mid-cycle
    expect(readFileSync(backlogPath, "utf8")).toContain("✅ Done"); // flipped at terminal
    expect(readFileSync(backlogPath, "utf8")).not.toContain("🔨 In Progress");
  });

  it("dead claim (🔨 left by a killed cycle) is recycled at the next preflight", async () => {
    const { repo } = makeGitignoredFixture("orphan");
    const backlogPath = join(repo, ".roll", "backlog.md");
    writeFileSync(backlogPath, readFileSync(backlogPath, "utf8").replace("📋 Todo", "🔨 In Progress"), "utf8");

    const rt = tmp("orphan-rt");
    const cycleId = "20260606-000000-2002";
    const p = paths(rt, cycleId);
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shimAgentTcr, github: fakeGithub(0) };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending // recycled → re-picked → delivered
    expect(readFileSync(backlogPath, "utf8")).toContain("✅ Done");
  });
});

describe("FIX-211 — Done ≡ merged: no publish-time 抢跑 on the gitignored layout", () => {
  // v2 对拍: in v2 the cycle writes ✅ Done into the WORKTREE backlog, which rides
  // the PR diff and only reaches main when the PR MERGES — main is never flipped
  // at publish. For roll-self (FIX-198 anchors Done to main directly) the same
  // invariant must hold: an OPENED-but-unmerged PR leaves the row at 🔨, and a
  // MERGED PR flips ✅ Done. These two cases assert exactly that parity.

  it("AC1: a published-but-OPEN delivery rests at 🔨, never premature ✅ Done", async () => {
    const { repo } = makeGitignoredFixture("fix211-open");
    const rt = tmp("fix211-open-rt");
    const cycleId = "20260606-051000-5101";
    const p = paths(rt, cycleId);
    const backlogPath = join(repo, ".roll", "backlog.md");

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    // Publish succeeds (status 0) but the PR is still OPEN (CI pending — the
    // real shape right after `gh pr create --auto`). Merge is handed off.
    const ports: Ports = { ...base, agentSpawn: shimAgentTcr, github: fakeGithub(0, "OPEN") };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    // Cycle still lands `done` (published, handed to the async PR loop) and the
    // runs row keeps that for dashboard/v2 parity …
    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    const backlog = readFileSync(backlogPath, "utf8");
    // … but the MAIN backlog row must NOT have flipped Done — it rests at 🔨.
    expect(backlog).toContain("🔨 In Progress");
    expect(backlog).not.toContain("✅ Done");
  });

  it("AC2: a MERGED PR deterministically flips ✅ Done", async () => {
    const { repo } = makeGitignoredFixture("fix211-merged");
    const rt = tmp("fix211-merged-rt");
    const cycleId = "20260606-051000-5102";
    const p = paths(rt, cycleId);
    const backlogPath = join(repo, ".roll", "backlog.md");

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shimAgentTcr, github: fakeGithub(0, "MERGED") };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    expect(result.state.ctx.publishConfirmed).toBe(true);
    const backlog = readFileSync(backlogPath, "utf8");
    expect(backlog).toContain("✅ Done");
    expect(backlog).not.toContain("🔨 In Progress");
  });
});

describe("FIX-304 — enforce done ≡ merged: a non-merged cycle leaves no premature Done", () => {
  // The live bug (FIX-284 / FIX-285): the roll-build skill tells the agent to
  // mark its card ✅ Done in .roll/backlog.md, which FIX-204C symlinks into the
  // cycle worktree — so the agent's flip lands in the REAL backlog. If the
  // cycle does NOT merge, that premature Done persists with NO commit on main.
  // A shim agent that flips Done (through the worktree's symlinked .roll, like
  // the real agent) reproduces it; the terminal must revert the false-Done.

  /** A shim that delivers (commits) AND prematurely flips the backlog ✅ Done
   *  via the worktree's symlinked .roll — exactly the roll-build instruction. */
  const shimFlipsDone: AgentSpawn = async (agent, opts) => {
    const res = await shimAgentTcr(agent, opts);
    const wtBacklog = join(opts.cwd, ".roll", "backlog.md");
    writeFileSync(wtBacklog, readFileSync(wtBacklog, "utf8").replace("🔨 In Progress", "✅ Done"), "utf8");
    return res;
  };

  it("a published-but-OPEN cycle whose agent pre-flipped ✅ Done is reverted to 📋 Todo (no false-Done)", async () => {
    const { repo } = makeGitignoredFixture("fix304-open");
    const rt = tmp("fix304-open-rt");
    const cycleId = "20260606-052000-5301";
    const p = paths(rt, cycleId);
    const backlogPath = join(repo, ".roll", "backlog.md");

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    // PR opened (status 0) but still OPEN — not merged. The agent already
    // flipped the symlinked backlog ✅ Done; the terminal must undo it.
    const ports: Ports = { ...base, agentSpawn: shimFlipsDone, github: fakeGithub(0, "OPEN") };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published");
    const backlog = readFileSync(backlogPath, "utf8");
    // done ≡ merged: an unmerged delivery is never Done. The premature flip is
    // reverted to the pre-cycle status (Todo), re-pickable until the PR merges.
    expect(backlog).not.toContain("✅ Done");
    expect(backlog).toContain("📋 Todo");
  });

  it("a MERGED cycle whose agent flipped ✅ Done KEEPS Done (true delivery)", async () => {
    const { repo } = makeGitignoredFixture("fix304-merged");
    const rt = tmp("fix304-merged-rt");
    const cycleId = "20260606-052000-5303";
    const p = paths(rt, cycleId);
    const backlogPath = join(repo, ".roll", "backlog.md");

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shimFlipsDone, github: fakeGithub(0, "MERGED") };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published");
    const backlog = readFileSync(backlogPath, "utf8");
    expect(backlog).toContain("✅ Done"); // merged → Done is the truth
    expect(backlog).not.toContain("🔨 In Progress");
  });
});

describe("FIX-211 — preflight reconcile 补翻: async PR-loop merge flips a stuck 🔨", () => {
  // The async case from the card: a PRIOR cycle published US-PRIOR (rests at 🔨
  // + open PR), the dedicated PR loop merged it between cycles. The NEXT cycle's
  // preflight must flip ✅ Done on the merge evidence — and must NOT reset a
  // still-OPEN claim (that would re-pick + duplicate) nor a dead claim's revert.
  const PRIOR_BACKLOG = [
    "| ID | Description | Status |",
    "|----|-------------|--------|",
    "| US-PRIOR | a delivered-and-since-merged story | 🔨 In Progress |",
    "| US-RUN-001 | Runner adapter smoke story est_min:5 | 📋 Todo |",
    "",
  ].join("\n");

  /** A github fake that maps cycle branch → PR state (branch-aware), so a prior
   *  delivery's branch and the current cycle's branch can report differently.
   *
   *  v2 honest-publish shape (9212553a): `liveBranch` (this cycle's branch) must
   *  report NO PR before this cycle's runPublishPlan — a pre-existing OPEN/MERGED
   *  state would trip the FIX-245 adoption short-circuit, which never threads
   *  `ctx.prUrl` into the terminal MERGED-credit gate. Prior-cycle branches carry
   *  their PR state from the start (the preflight claim reconcile probes them).
   *  The prUrl parses under prNumberFromUrl so `delivery:published` is emitted. */
  function branchAwareGithub(byBranch: Record<string, string>, liveBranch: string): Ports["github"] {
    let livePublished = false;
    return {
      async repoSlug() {
        return "fixture/runner";
      },
      async runPublishPlan() {
        livePublished = true;
        return { status: 0, prUrl: "https://github.com/fixture/runner/pull/1", ok: true };
      },
      async prState(_repoCwd, branch) {
        if (branch === liveBranch && !livePublished) return "UNKNOWN";
        return byBranch[branch] ?? "OPEN";
      },
      async prMergeInfo(_repoCwd, branch) {
        const state = byBranch[branch] ?? "OPEN";
        return state === "MERGED"
          ? { state: "MERGED", mergedAt: "2026-06-21T00:00:00Z", mergeCommit: "abc123def456" }
          : { state };
      },
      async openPrTitles() {
        return [];
      },
    };
  }

  function seedPriorRun(runsPath: string, storyId: string, cycleId: string): void {
    writeFileSync(
      runsPath,
      `${JSON.stringify({ run_id: cycleId, status: "done", story_id: storyId, cycle_id: cycleId, built: [storyId] })}\n`,
      "utf8",
    );
  }

  it("MERGED prior PR → preflight flips US-PRIOR ✅ Done; current publish-OPEN stays 🔨", async () => {
    const { repo } = makeGitignoredFixture("fix211-async-merged");
    const rt = tmp("fix211-async-merged-rt");
    const backlogPath = join(repo, ".roll", "backlog.md");
    writeFileSync(backlogPath, PRIOR_BACKLOG, "utf8");
    seedFeatureCard(repo, "US-PRIOR", "a delivered-and-since-merged story");
    const cycleId = "20260606-052000-5201";
    const p = paths(rt, cycleId);
    seedPriorRun(p.runsPath, "US-PRIOR", "c-prior");

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = {
      ...base,
      agentSpawn: shimAgentTcr,
      github: branchAwareGithub(
        {
          "loop/cycle-c-prior": "MERGED", // the async PR loop merged it
          [`loop/cycle-${cycleId}`]: "OPEN", // this cycle's own PR not yet merged
        },
        `loop/cycle-${cycleId}`,
      ),
    };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    const backlog = readFileSync(backlogPath, "utf8");
    // 补翻: the merged prior delivery flipped ✅ Done.
    expect(backlog).toMatch(/US-PRIOR \|.*✅ Done/);
    // this cycle's own delivery published-but-OPEN → rests at 🔨, not Done.
    expect(backlog).toMatch(/US-RUN-001 \|.*🔨 In Progress/);
  });

  it("OPEN prior PR → preflight keeps US-PRIOR at 🔨 (no re-pick, no premature Done)", async () => {
    const { repo } = makeGitignoredFixture("fix211-async-open");
    const rt = tmp("fix211-async-open-rt");
    const backlogPath = join(repo, ".roll", "backlog.md");
    writeFileSync(backlogPath, PRIOR_BACKLOG, "utf8");
    seedFeatureCard(repo, "US-PRIOR", "a delivered-and-since-merged story");
    const cycleId = "20260606-052000-5202";
    const p = paths(rt, cycleId);
    seedPriorRun(p.runsPath, "US-PRIOR", "c-prior");

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = {
      ...base,
      agentSpawn: shimAgentTcr,
      github: branchAwareGithub(
        { "loop/cycle-c-prior": "OPEN", [`loop/cycle-${cycleId}`]: "MERGED" },
        `loop/cycle-${cycleId}`,
      ),
    };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    const backlog = readFileSync(backlogPath, "utf8");
    // prior delivery still pending merge → stays 🔨 (not reverted, not Done).
    expect(backlog).toMatch(/US-PRIOR \|.*🔨 In Progress/);
  });

  it("dead claim (🔨 with NO delivering cycle in runs) → preflight reverts to 📋 Todo", async () => {
    const { repo } = makeGitignoredFixture("fix211-deadclaim");
    const rt = tmp("fix211-deadclaim-rt");
    const backlogPath = join(repo, ".roll", "backlog.md");
    writeFileSync(backlogPath, PRIOR_BACKLOG, "utf8");
    seedFeatureCard(repo, "US-PRIOR", "a delivered-and-since-merged story");
    const cycleId = "20260606-052000-5203";
    const p = paths(rt, cycleId);
    // No runs.jsonl seeded → US-PRIOR has no delivering cycle → dead claim.

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    // This cycle's own PR merges, so a re-picked-and-delivered story reaches Done.
    const ports: Ports = {
      ...base,
      agentSpawn: shimAgentTcr,
      github: branchAwareGithub({ [`loop/cycle-${cycleId}`]: "MERGED" }, `loop/cycle-${cycleId}`),
    };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    // The dead claim (no PR ever opened) was recycled to 📋 Todo at preflight —
    // FIX-112 orphan-recovery preserved — so US-PRIOR (highest priority) was
    // re-picked, delivered, and merged this cycle → ✅ Done, while US-RUN-001
    // waits its turn. Had the revert NOT fired, US-PRIOR would still read 🔨 and
    // US-RUN-001 would be the one delivered instead.
    const backlog = readFileSync(backlogPath, "utf8");
    expect(backlog).toMatch(/US-PRIOR \|.*✅ Done/);
    expect(backlog).toMatch(/US-RUN-001 \|.*📋 Todo/);
  });
});

describe("US-PORT-011 — live.log streams the agent transcript", () => {
  it("happy path leaves the shim output in .roll-side live.log (header + chunks)", async () => {
    const { repo } = makeFixture("live");
    const rt = tmp("live-rt");
    const cycleId = "20260606-030000-3001";
    const p = paths(rt, cycleId);
    // The shim honours the real-spawn contract: feed stdout through onChunk.
    const streamingShim: AgentSpawn = async (agent, opts) => {
      const r = await shimAgentTcr(agent, opts);
      opts.onChunk?.(Buffer.from(r.stdout));
      return r;
    };
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: streamingShim, github: fakeGithub(0) };
    const result = await runCycleOnce({ ports, ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never } });
    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    const live = readFileSync(join(rt, "live.log"), "utf8");
    expect(live).toContain(`── cycle ${cycleId}`);
    expect(live).toContain("claude-opus-4-8"); // shim stream-json chunk streamed through
  });
});

describe("FIX-204B — the executor pins the picked story into the agent spawn", () => {
  it("agentSpawn receives storyId === the story pick_story claimed", async () => {
    const { repo } = makeFixture("pin");
    const rt = tmp("pin-rt");
    const cycleId = "20260606-031500-3101";
    const p = paths(rt, cycleId);
    // Capture the storyId from the BUILDER spawn. FIX-312: the peer gate may fire
    // a second (peer-review) spawn that legitimately carries NO storyId — record
    // the first spawn that actually pins one so the later peer spawn can't clobber
    // the assertion (only the builder spawn pins; the peer-review spawn never does).
    let seenStoryId: string | undefined;
    const pinProbe: AgentSpawn = async (agent, opts) => {
      if (opts.storyId !== undefined && seenStoryId === undefined) seenStoryId = opts.storyId;
      return shimAgentTcr(agent, opts);
    };
    // FIX-312: pin a deterministic single-vendor pool so the peer gate's
    // hetero-availability decision is independent of the CI host's installed
    // agents (heteroAvailable=false → self-review allowed → no extra peer spawn);
    // this keeps the test focused on builder-spawn storyId pinning, portably.
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: pinProbe, github: fakeGithub(0), installedAgents: () => ["claude"] };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });
    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    expect(seenStoryId).toBe("US-RUN-001");
  });
});

describe("FIX-204C — worktree sees the main .roll via symlink", () => {
  it("links on create, agent reads backlog through it, commit stays clean, cleanup spares the target", async () => {
    const { repo } = makeGitignoredFixture("link");
    const rt = tmp("link-rt");
    const cycleId = "20260606-032000-3201";
    const p = paths(rt, cycleId);

    let linkTarget = "";
    let backlogViaWorktree = "";
    let wtStatus = "";
    let committed = "";
    const shim: AgentSpawn = async (agent, opts) => {
      linkTarget = readlinkSync(join(opts.cwd, ".roll"));
      backlogViaWorktree = readFileSync(join(opts.cwd, ".roll", "backlog.md"), "utf8");
      const r = await shimAgentTcr(agent, opts);
      // AFTER the shim's `git add -A` + commit: the symlink must NOT be tracked
      // (info/exclude guard — `.gitignore`'s dir-only `.roll/` misses links).
      wtStatus = git(opts.cwd, ["status", "--porcelain"]);
      committed = git(opts.cwd, ["show", "--name-only", "--format=", "HEAD"]);
      return r;
    };

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    expect(linkTarget).toBe(join(repo, ".roll"));
    expect(backlogViaWorktree).toContain("US-RUN-001");
    expect(wtStatus).not.toContain(".roll");
    // the delivered commit carries the work, never the link
    expect(committed).toContain("delivered.txt");
    expect(committed).not.toContain(".roll");
    // The `.roll` link remains with the preserved managed checkout while the PR
    // is pending; the persistent main `.roll` is still the source of truth.
    expect(existsSync(p.worktreePath)).toBe(true);
    expect(readFileSync(join(repo, ".roll", "backlog.md"), "utf8")).toContain("✅ Done");
  });

  it("a project that TRACKS .roll keeps its real checked-out dir (no link, no exclude line)", async () => {
    const { repo } = makeFixture("tracked");
    const rt = tmp("tracked-rt");
    const cycleId = "20260606-032000-3202";
    const p = paths(rt, cycleId);
    let isLink: boolean | null = null;
    const shim: AgentSpawn = async (agent, opts) => {
      isLink = lstatSync(join(opts.cwd, ".roll")).isSymbolicLink();
      return shimAgentTcr(agent, opts);
    };
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });
    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    expect(isLink).toBe(false);
    expect(existsSync(join(repo, ".git", "info", "exclude")) ? readFileSync(join(repo, ".git", "info", "exclude"), "utf8") : "").not.toMatch(/^\.roll$/m);
  });
});

describe("FIX-209 — cycle baseline freshness: preflight fetches the remote merge", () => {
  it("a commit merged to the remote AFTER clone is visible in the worktree baseline", async () => {
    const { repo, remote } = makeFixture("freshness");
    const rt = tmp("freshness-rt");
    const cycleId = "20260606-050000-2090";
    const p = paths(rt, cycleId);

    // A PR lands on the remote AFTER `repo` was cloned+fetched: advance the bare
    // remote's main via a throwaway clone. `repo`'s local `origin/main` ref is
    // now STALE — without the preflight fetch the worktree would branch off the
    // pre-merge baseline (the exact conflict/rework risk FIX-209 fixes).
    const advance = tmp("freshness-advance");
    git(advance, ["clone", "-q", remote, "."]);
    writeFileSync(join(advance, "merged-on-remote.txt"), "landed via PR after clone\n", "utf8");
    git(advance, [...GIT_ID, "add", "-A"]);
    git(advance, [...GIT_ID, "commit", "-q", "-m", "remote: merge PR #999"]);
    git(advance, ["push", "-q", "origin", "main"]);

    // Capture, at execute time, whether the worktree baseline carries the merge.
    let mergeVisibleInWorktree = false;
    const shim: AgentSpawn = async (agent, opts) => {
      mergeVisibleInWorktree = existsSync(join(opts.cwd, "merged-on-remote.txt"));
      return shimAgentTcr(agent, opts);
    };

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published"); // FIX-244: publish-ok = PR open, merge pending
    // The crown assertion: the worktree branched off the FRESH baseline.
    expect(mergeVisibleInWorktree).toBe(true);
  });
});

describe("FIX-284 — RESUME-PRIOR-WORK engages POST-pick (the storyId-timing wiring fix)", () => {
  it("a picked story with an un-merged clean prior cycle branch RE-POINTS the worktree to it (the agent resumes prior product code, not origin/main)", async () => {
    const { repo, remote } = makeFixture("resume-e2e");
    const rt = tmp("resume-e2e-rt");
    const cycleId = "20260615-090000-3284";
    const p = paths(rt, cycleId);

    // A PRIOR cycle left an UN-MERGED branch on the remote that carries product
    // code (the FIX-284 stranded-work shape: git-hooks.ts + cast work). It is NOT
    // merged into main and rebases cleanly. Build it on the remote via a throwaway
    // clone branched off main.
    const priorCycleId = "20260614-195600-25595";
    const priorBranch = `loop/cycle-${priorCycleId}`;
    const prior = tmp("resume-e2e-prior");
    git(prior, ["clone", "-q", remote, "."]);
    git(prior, ["checkout", "-q", "-b", priorBranch, "origin/main"]);
    writeFileSync(join(prior, "git-hooks.ts"), "export const installHooks = () => {/* FIX-284 prior work */};\n", "utf8");
    git(prior, [...GIT_ID, "add", "-A"]);
    git(prior, [...GIT_ID, "commit", "-q", "-m", "tcr: FIX-284 prior cycle stranded work (git-hooks + casting)"]);
    git(prior, ["push", "-q", "origin", priorBranch]);

    // The runs ledger links the picked story → that prior cycle branch (the
    // story_id↔cycle_id link resumeCandidateBranches reads). This is the only
    // signal resolveResumeBase keys on, uniform for every agent.
    writeFileSync(
      p.runsPath,
      JSON.stringify({ story_id: "US-RUN-001", cycle_id: priorCycleId, status: "orphan" }) + "\n",
      "utf8",
    );

    // Capture, AT execute time (before the done-path worktree cleanup), whether
    // the prior product file is present in the worktree's TRACKED tree. Pre-fix
    // it was always absent (worktree on origin/main, resume never engaged).
    let priorWorkVisibleInWorktree = false;
    const shim: AgentSpawn = async (agent, opts) => {
      priorWorkVisibleInWorktree = existsSync(join(opts.cwd, "git-hooks.ts"));
      return shimAgentTcr(agent, opts);
    };

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.ran).toBe(true);
    // The crown assertion: the agent ran on the RESUMED tree — the prior cycle's
    // git-hooks.ts is present in the worktree (resume engaged post-pick).
    expect(priorWorkVisibleInWorktree).toBe(true);
    // The resume ALERT was emitted (operator sees the resume happened).
    const alerts = existsSync(p.alertsPath) ? readFileSync(p.alertsPath, "utf8") : "";
    expect(alerts).toContain("resume-prior-work");
    expect(alerts).toContain(`resumes un-merged branch ${priorBranch}`);
  });

  it("a picked story with NO recorded prior branch bases the worktree on origin/main (fresh-context default, no resume)", async () => {
    const { repo } = makeFixture("resume-e2e-none");
    const rt = tmp("resume-e2e-none-rt");
    const cycleId = "20260615-091000-3285";
    const p = paths(rt, cycleId);
    // No runs.jsonl prior link → no resume candidate.

    let strayResumeFile = false;
    const shim: AgentSpawn = async (agent, opts) => {
      strayResumeFile = existsSync(join(opts.cwd, "git-hooks.ts"));
      return shimAgentTcr(agent, opts);
    };

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.ran).toBe(true);
    expect(strayResumeFile).toBe(false); // pure fresh-context — nothing resumed
    const alerts = existsSync(p.alertsPath) ? readFileSync(p.alertsPath, "utf8") : "";
    expect(alerts).not.toContain("resume-prior-work");
  });
});

// ── US-CYCLE-013 — durable build/tail handoff (matrix #2/#11/#12/#13/#15) ────
import { EventBus, projectCycleHandoff, projectHandoffCapacity } from "@roll/core";
import type { CycleHandoffEvent, HandoffIdentity, ManagedWorkspaceSet, RollEvent } from "@roll/spec";
import { runTailOnce } from "../src/runner/run-cycle.js";
import { createPinRef, verifyRebaseTemp, checkoutPin } from "../src/runner/node-ports.js";
import { makeFreshnessCheck } from "../src/commands/loop-run-once.js";

describe("US-CYCLE-013 — durable build handoff (ROLL_CYCLE_HANDOFF_V1=1)", () => {
  it("a built cycle stops at a NON-terminal builder_ready: no cycle:end, lock released, workspace retained", async () => {
    const { repo } = makeFixture("handoff");
    const rt = tmp("handoff-rt");
    const cycleId = "20260620-000000-1313";
    const p = paths(rt, cycleId);

    const shim: AgentSpawn = async (agent, opts) => shimAgentTcr(agent, opts);
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };

    const result = await runCycleOnce({
      ports,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
      handoff: true,
    });

    expect(result.ran).toBe(true);
    expect(result.handedOff).toBe(true); // durable handoff, NOT a terminal
    expect(result.terminal).toBeUndefined();
    // No cycle:end — a build handoff is never evidence of a terminal.
    const eventsText = readFileSync(p.eventsPath, "utf8");
    expect(eventsText).not.toContain('"type":"cycle:end"');
    // The durable facts exist: admitted (fenced) + builder_ready.
    expect(eventsText).toContain('"type":"cycle:admitted"');
    expect(eventsText).toContain('"type":"cycle:builder_ready"');
    // Lock released; the retained workspace is NOT cleaned by the handoff.
    expect(existsSync(p.lockPath)).toBe(false);
    expect(existsSync(p.worktreePath)).toBe(true);

    // The projection reads the handoff back from the event stream.
    const view = projectCycleHandoff(new EventBus().readEvents(p.eventsPath), cycleId);
    expect(view?.state).toBe("builder_validated_waiting_for_tail");
    expect(view?.readyKey).toContain("ready:");
  });

  it("resumes the retained tail to a terminal (publish → cleanup), never rebuilding", async () => {
    const { repo } = makeFixture("tail");
    const rt = tmp("tail-rt");
    const cycleId = "20260620-111111-4242";
    const p = paths(rt, cycleId);

    // Phase 1: build to the durable handoff.
    const shim: AgentSpawn = async (agent, opts) => shimAgentTcr(agent, opts);
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const buildPorts: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const built = await runCycleOnce({
      ports: buildPorts,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
      handoff: true,
    });
    expect(built.handedOff).toBe(true);

    // Phase 2: promote the ready holder under the mutex, then resume the tail.
    const events = new EventBus().readEvents(p.eventsPath);
    const view = projectCycleHandoff(events, cycleId);
    expect(view?.identity).toBeDefined();
    const identity = view!.identity!;
    const bus = new EventBus();
    bus.appendEventSynced(p.eventsPath, {
      type: "cycle:builder_handoff",
      eventId: "ev-promote",
      idempotencyKey: `handoff:${identity.storyId}:${identity.attempt}:${identity.fence}`,
      identity,
      previousReadyKey: view!.readyKey!,
      next: "evaluate_or_test",
      ts: Date.now(),
    });

    const resumePorts: Ports = { ...base, github: fakeGithub(0) };
    const tail = await runTailOnce({
      ports: resumePorts,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
      identity,
      checkFreshness: async () => undefined, // no predecessor merge in the fixture
    });

    expect(tail.ran).toBe(true);
    expect(tail.resumedTail).toBe(true);
    expect(tail.terminal).toBe("published");
    const tailEvents = readFileSync(p.eventsPath, "utf8");
    expect(tailEvents).toContain('"type":"cycle:tail_started"');
    expect(tailEvents).toContain('"type":"cycle:tail_completed"');
    expect(tailEvents).toContain('"type":"cycle:end"');
    // The tail never re-ran Builder: no second cycle:start for this cycle.
    const starts = tailEvents.split("\n").filter((l) => l.includes('"type":"cycle:start"'));
    expect(starts.length).toBeLessThanOrEqual(1);
  });

  it("a freshness conflict routes the resumed tail to serial_recovery with leases retained (matrix #13)", async () => {
    const { repo } = makeFixture("fresh-conflict");
    const rt = tmp("fresh-conflict-rt");
    const cycleId = "20260620-222222-7777";
    const p = paths(rt, cycleId);

    const shim: AgentSpawn = async (agent, opts) => shimAgentTcr(agent, opts);
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const buildPorts: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const built = await runCycleOnce({ ports: buildPorts, ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never }, handoff: true });
    expect(built.handedOff).toBe(true);

    const events = new EventBus().readEvents(p.eventsPath);
    const view = projectCycleHandoff(events, cycleId);
    const identity = view!.identity!;
    const bus = new EventBus();
    bus.appendEventSynced(p.eventsPath, {
      type: "cycle:builder_handoff",
      eventId: "ev-promote",
      idempotencyKey: `handoff:${identity.storyId}:${identity.attempt}:${identity.fence}`,
      identity,
      previousReadyKey: view!.readyKey!,
      next: "evaluate_or_test",
      ts: Date.now(),
    });

    const tail = await runTailOnce({
      ports: base,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
      identity,
      checkFreshness: async () => ({
        verdict: "conflict",
        predecessorMergeSha: "m1",
        recordedBaseSha: identity.baseSha,
        builderHead: identity.builderHead,
      }),
    });

    expect(tail.recoveryRecorded).toBe(true);
    expect(tail.terminal).toBeUndefined();
    const tailEvents = readFileSync(p.eventsPath, "utf8");
    expect(tailEvents).toContain('"type":"cycle:main_freshness"');
    expect(tailEvents).toContain('"type":"cycle:tail_cancelled"');
    expect(tailEvents).toContain('"type":"cycle:serial_recovery"');
    // Leases retained: no cleanup_completed, no worktree deletion.
    expect(tailEvents).not.toContain('"type":"cycle:cleanup_completed"');
    expect(tailEvents).not.toContain('"type":"cycle:end"');
    expect(existsSync(p.worktreePath)).toBe(true);
    // The projection agrees: the cycle is blocked (serial recovery).
    const after = projectCycleHandoff(new EventBus().readEvents(p.eventsPath), cycleId);
    expect(after?.state).toBe("serial_recovery");
  });
});

// ── US-CYCLE-013 repair (delta-58f2373d) — F1 admission enforcement + F2 real probe ──

function handoffWorkspace(cycleId: string, storyId: string): ManagedWorkspaceSet {
  return {
    schema: 1,
    runId: cycleId,
    storyId,
    kind: "cycle",
    topology: "solo",
    members: [{
      repositoryId: "repo-id",
      workspaceKey: `cycle-${cycleId}`,
      relativeLocator: `cycle-${cycleId}`,
      checkoutRef: { kind: "detached", head: "base-sha" },
      publishRef: `refs/heads/loop/cycle-${cycleId}`,
    }],
  };
}

function handoffIdentity(cycleId: string, storyId: string, fence = "fence"): HandoffIdentity {
  return {
    schema: "cycle-handoff/v1",
    cycleId,
    storyId,
    workspace: handoffWorkspace(cycleId, storyId),
    branch: `loop/cycle-${cycleId}`,
    builderHead: "head-sha",
    baseSha: "base-sha",
    builderEvidenceRefs: [],
    builderValidationRef: `builder-validation:${cycleId}:1`,
    profile: "standard",
    attempt: 1,
    fence,
  };
}

function appendEvents(eventsPath: string, events: RollEvent[]): void {
  const bus = new EventBus();
  for (const ev of events) bus.appendEvent(eventsPath, ev);
}

/** A small real git repo for the F2 probe: main M0 → B1 on top of M0 → M1.
 *  B1 always ADDS `builder.txt` (a new path); the clean case has M1 only touch
 *  `base.txt`, the `conflict` case has M1 ALSO add `builder.txt` (add/add ⇒ a
 *  rebase conflict that is unambiguous across git versions). */
function makeProbeRepo(tag: string, opts: { conflict?: boolean } = {}): { repo: string; base: string; head: string; onto: string } {
  const repo = tmp(`${tag}-repo`);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base line\n");
  git(repo, [...GIT_ID, "add", "-A"]);
  git(repo, [...GIT_ID, "commit", "-qm", "M0"]);
  const base = git(repo, ["rev-parse", "HEAD"]).trim();
  // B1 — the recorded builderHead (on top of M0): adds a NEW path.
  git(repo, ["checkout", "-qb", "b1"]);
  writeFileSync(join(repo, "builder.txt"), "builder work\n");
  git(repo, [...GIT_ID, "add", "-A"]);
  git(repo, [...GIT_ID, "commit", "-qm", "B1"]);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  // main advances to M1 — the predecessor merge.
  git(repo, ["checkout", "-q", "main"]);
  if (opts.conflict === true) {
    writeFileSync(join(repo, "builder.txt"), "predecessor took the same path\n");
  } else {
    writeFileSync(join(repo, "base.txt"), "base line modified on main\n");
  }
  git(repo, [...GIT_ID, "add", "-A"]);
  git(repo, [...GIT_ID, "commit", "-qm", "M1"]);
  const onto = git(repo, ["rev-parse", "HEAD"]).trim();
  return { repo, base, head, onto };
}

describe("US-CYCLE-013 repair F1 — execution-enforced admission (matrix #3/#4)", () => {
  it("runCycleOnce refuses a SECOND admission under the scheduler mutex: admissionBlocked=build_slot_full, NO Builder spawn, one build holder", async () => {
    const { repo } = makeFixture("f1-second");
    const rt = tmp("f1-second-rt");
    const cycleA = "20260620-010000-3001";
    const cycleB = "20260620-010100-3002";
    const pA = paths(rt, cycleA);
    // Seed A as an admitted+ready build holder on the SHARED event stream.
    const A = handoffIdentity(cycleA, "US-RUN-001");
    appendEvents(pA.eventsPath, [
      { type: "worktree:allocated", workspace: handoffWorkspace(cycleA, "US-RUN-001"), ts: 1 },
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
      { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-RUN-001:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
    ]);

    let spawnCalls = 0;
    const shim: AgentSpawn = async (agent, opts) => {
      spawnCalls += 1;
      return shimAgentTcr(agent, opts);
    };
    const pB = paths(rt, cycleB);
    const base = nodePorts({ repoCwd: repo, paths: pB, skillBody: "deliver", routeDeps });
    const ports: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const result = await runCycleOnce({
      ports,
      ctx: { cycleId: cycleB, branch: `loop/cycle-${cycleB}`, loop: "ci" as never },
      handoff: true,
    });

    expect(result.ran).toBe(true);
    expect(result.admissionBlocked).toBe("build_slot_full");
    // The Builder NEVER spawned (admission is a precondition for the spawn).
    expect(spawnCalls).toBe(0);
    // NO durable cycle:admitted for B; the projection still shows ONE build holder.
    const events = new EventBus().readEvents(pA.eventsPath);
    expect(events.some((ev) => ev.type === "cycle:admitted" && "identity" in ev && ev.identity?.cycleId === cycleB)).toBe(false);
    const cap = projectHandoffCapacity(events);
    expect(cap.buildHolderCycleId).toBe(cycleA);
    expect(cap.readyHolderCycleId).toBe(cycleA);
  });

  it("runTailOnce refuses to promote into an OCCUPIED tail: refused=tail_occupied, no builder_handoff appended, holder stays ready", async () => {
    const repo = tmp("f1-tail-repo");
    const rt = tmp("f1-tail-rt");
    const cycleA = "20260620-020000-3003";
    const cycleB = "20260620-020100-3004";
    const p = paths(rt, cycleA);
    const A = handoffIdentity(cycleA, "US-A");
    const B = handoffIdentity(cycleB, "US-B");
    // A owns the live tail; B is the validated ready holder waiting for capacity.
    appendEvents(p.eventsPath, [
      { type: "worktree:allocated", workspace: handoffWorkspace(cycleA, "US-A"), ts: 1 },
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
      { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-A:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
      { type: "cycle:builder_handoff", eventId: "e3", idempotencyKey: "handoff:US-A:1:fence", identity: A, previousReadyKey: "ready:US-A:1:fence", next: "evaluate_or_test", ts: 4 },
      { type: "cycle:tail_started", eventId: "e4", idempotencyKey: "tail_started:cA:1:fence", cycleId: cycleA, attempt: 1, fence: "fence", ts: 5 },
      { type: "worktree:allocated", workspace: handoffWorkspace(cycleB, "US-B"), ts: 6 },
      { type: "cycle:admitted", eventId: "e5", idempotencyKey: "admit:cB:1", identity: B, queueSequence: 2, ts: 7 },
      { type: "cycle:builder_ready", eventId: "e6", idempotencyKey: "ready:US-B:1:fence", identity: B, reason: "tail_capacity_full", ts: 8 },
    ]);

    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const result = await runTailOnce({
      ports: base,
      ctx: { cycleId: cycleB, branch: `loop/cycle-${cycleB}`, loop: "ci" as never },
      identity: B,
    });

    expect(result.ran).toBe(false);
    expect(result.refused).toBe("tail_occupied");
    // No new builder_handoff was appended (only A's original promotion exists).
    const events = new EventBus().readEvents(p.eventsPath);
    const handoffs = events.filter((ev) => ev.type === "cycle:builder_handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ type: "cycle:builder_handoff" });
    if ("identity" in handoffs[0]!) {
      expect((handoffs[0] as { identity?: { cycleId?: string } }).identity?.cycleId).toBe(cycleA);
    }
    // B stays builder_validated_waiting_for_tail — no mutation, no ALERT spam.
    const viewB = projectCycleHandoff(events, cycleB);
    expect(viewB?.state).toBe("builder_validated_waiting_for_tail");
  });
});

describe("US-CYCLE-013 repair F2 — the REAL probe against a fixture repo (matrix #5/#6/#7)", () => {
  it("continue: a clean rebase + passing testCmd returns the rebased head; createPinRef pins it; checkoutPin checks it out; the temp worktree is removed", async () => {
    const { repo, base, head, onto } = makeProbeRepo("probe-continue");
    const rt = tmp("probe-continue-rt");
    const verify = join(rt, "verify-wt");

    const result = await verifyRebaseTemp(repo, base, head, onto, verify, ["true"]);
    expect(result.verdict).toBe("continue");
    expect(result.evidenceRefs).toHaveLength(1);
    const rebasedHead = result.evidenceRefs[0]!;
    expect(rebasedHead).not.toBe(head); // the rebased commit is a NEW head
    // The temporary verify worktree is always removed afterwards.
    expect(existsSync(verify)).toBe(false);

    // The durable, immutable pin.
    const ref = "refs/roll/rebase-candidates/c1/1";
    expect((await createPinRef(repo, ref, rebasedHead)).code).toBe(0);
    expect(git(repo, ["rev-parse", ref]).trim()).toBe(rebasedHead);
    // A second createPinRef on the SAME ref is refused (immutable by construction).
    expect((await createPinRef(repo, ref, head)).code).not.toBe(0);

    // checkoutPin moves an owned worktree onto the pinned candidate.
    const owned = join(rt, "owned-wt");
    git(repo, ["worktree", "add", "--detach", owned, onto]);
    try {
      expect((await checkoutPin(owned, ref)).code).toBe(0);
      expect(git(owned, ["rev-parse", "HEAD"]).trim()).toBe(rebasedHead);
    } finally {
      git(repo, ["worktree", "remove", "--force", owned]);
    }
  });

  it("conflict: B1 and M1 edit the same line ⇒ verdict conflict, no pin, temp worktree removed", async () => {
    const { repo, base, head, onto } = makeProbeRepo("probe-conflict", { conflict: true });
    const rt = tmp("probe-conflict-rt");
    const verify = join(rt, "verify-wt");
    const result = await verifyRebaseTemp(repo, base, head, onto, verify, ["true"]);
    expect(result.verdict).toBe("conflict");
    expect(result.evidenceRefs).toEqual([]);
    expect(existsSync(verify)).toBe(false);
  });

  it("test_failed on a failing testCmd; timeout on a slow testCmd bounded by timeoutMs", async () => {
    const { repo, base, head, onto } = makeProbeRepo("probe-testfail");
    const rt = tmp("probe-testfail-rt");
    const failed = await verifyRebaseTemp(repo, base, head, onto, join(rt, "v1"), ["false"]);
    expect(failed.verdict).toBe("test_failed");
    expect(failed.evidenceRefs).toEqual([]);
    expect(existsSync(join(rt, "v1"))).toBe(false);

    const timedOut = await verifyRebaseTemp(repo, base, head, onto, join(rt, "v2"), ["sleep 2"], 100);
    expect(timedOut.verdict).toBe("timeout");
    expect(existsSync(join(rt, "v2"))).toBe(false);
  });

  it("makeFreshnessCheck passes the allowlist-filtered deliverable_cmd, pins the rebased head, and carries candidateHead (matrix #8)", async () => {
    const { repo, base, head, onto } = makeProbeRepo("freshness-wire");
    const rt = tmp("freshness-wire-rt");
    const cycleId = "20260620-030000-3005";
    const storyId = "US-FRESH";
    const p = paths(rt, cycleId);
    // The recorded workspace carries the card spec with `deliverable_cmd: roll test`.
    const specDir = join(rt, "worktrees", `cycle-${cycleId}`, ".roll", "features", "uncategorized", storyId);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "spec.md"),
      `---\nid: ${storyId}\ndeliverable_cmd: roll test\n---\n\n# ${storyId}\n`,
      "utf8",
    );
    const identity: HandoffIdentity = {
      schema: "cycle-handoff/v1",
      cycleId,
      storyId,
      workspace: handoffWorkspace(cycleId, storyId),
      branch: `loop/cycle-${cycleId}`,
      builderHead: head,
      baseSha: base,
      builderEvidenceRefs: [],
      builderValidationRef: `builder-validation:${cycleId}:1`,
      profile: "standard",
      attempt: 1,
      fence: "fence-fresh",
    };
    // A predecessor merge landed after the admission.
    appendEvents(p.eventsPath, [
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cB:1", identity, queueSequence: 1, ts: 100 },
      { type: "delivery:merge_confirmed", cycleId: "cP", storyId: "US-P", branch: "loop/cycle-cP", signal: "merge_commit", mergeCommit: onto, ts: 200 },
    ]);

    const base2 = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    let captured: string[] | undefined;
    const ports: Ports = {
      ...base2,
      git: {
        ...base2.git,
        verifyRebaseTemp: async (rc, b, h, o, wp, testCmd) => {
          captured = testCmd;
          // Delegate to the REAL probe with a no-op command: the recorded
          // `roll test` needs a built roll on PATH — the assertion is that the
          // allowlist-filtered recorded command is what WOULD run.
          return base2.git.verifyRebaseTemp!(rc, b, h, o, wp, ["true"]);
        },
      },
    };
    const result = await makeFreshnessCheck(ports, p.eventsPath, rt)(identity);
    expect(captured).toEqual(["roll test"]);
    expect(result?.verdict).toBe("continue");
    expect(result?.candidateHead).toBe(result?.evidenceRefs?.[0]);
    expect(result?.candidateHead).not.toBe(head);
    // The durable pin exists at the rebased head.
    const ref = `refs/roll/rebase-candidates/${cycleId}/1`;
    expect(git(repo, ["rev-parse", ref]).trim()).toBe(result?.candidateHead);
  });

  it("the resumed tail runs the REAL probe end-to-end: continue pins the rebased head → main_freshness{continue} + rebased_attempt_planned (true R1) + serial_recovery (matrix #9)", async () => {
    const { repo } = makeFixture("f9-continue");
    const rt = tmp("f9-continue-rt");
    const cycleId = "20260620-040000-3006";
    const p = paths(rt, cycleId);

    // Phase 1: build to the durable handoff (records the real baseSha + builderHead).
    const shim: AgentSpawn = async (agent, opts) => shimAgentTcr(agent, opts);
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const buildPorts: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const built = await runCycleOnce({ ports: buildPorts, ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never }, handoff: true });
    expect(built.handedOff).toBe(true);

    const events1 = new EventBus().readEvents(p.eventsPath);
    const view = projectCycleHandoff(events1, cycleId);
    expect(view?.identity).toBeDefined();
    const identity = view!.identity!;
    const builderHead = identity.builderHead;
    const admitted = events1.find((ev) => ev.type === "cycle:admitted" && "identity" in ev && ev.identity?.cycleId === cycleId);

    // The predecessor merge lands on main AFTER the build (non-conflicting).
    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "merged-on-main.txt"), "predecessor merge\n");
    git(repo, [...GIT_ID, "add", "-A"]);
    git(repo, [...GIT_ID, "commit", "-qm", "M1 predecessor merge"]);
    const mergeSha = git(repo, ["rev-parse", "HEAD"]).trim();

    // Record the predecessor merge fact + promote the ready holder.
    appendEvents(p.eventsPath, [
      { type: "delivery:merge_confirmed", cycleId: "cP", storyId: "US-P", branch: "loop/cycle-cP", signal: "merge_commit", mergeCommit: mergeSha, ts: (admitted?.ts ?? 0) + 1000 },
      { type: "cycle:builder_handoff", eventId: "ev-promote", idempotencyKey: `handoff:${identity.storyId}:${identity.attempt}:${identity.fence}`, identity, previousReadyKey: view!.readyKey!, next: "evaluate_or_test", ts: Date.now() },
    ]);

    const resumePorts: Ports = { ...base, github: fakeGithub(0) };
    const tail = await runTailOnce({
      ports: resumePorts,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
      identity,
      checkFreshness: makeFreshnessCheck(resumePorts, p.eventsPath, rt),
    });

    expect(tail.recoveryRecorded).toBe(true);
    expect(tail.terminal).toBeUndefined();
    const tailEvents = new EventBus().readEvents(p.eventsPath);
    const freshness = tailEvents.find((ev) => ev.type === "cycle:main_freshness");
    expect(freshness).toBeDefined();
    expect(freshness).toMatchObject({ verdict: "continue", predecessorMergeSha: mergeSha, builderHead });
    const planned = tailEvents.find((ev) => ev.type === "cycle:rebased_attempt_planned");
    expect(planned).toBeDefined();
    if (planned !== undefined && "candidateHead" in planned) {
      // The planned attempt carries the TRUE rebased head (≠ the old builderHead).
      expect(planned.candidateHead).not.toBe(builderHead);
      expect(git(repo, ["rev-parse", `refs/roll/rebase-candidates/${cycleId}/1`]).trim()).toBe(planned.candidateHead);
    }
    expect(tailEvents.some((ev) => ev.type === "cycle:serial_recovery")).toBe(true);
    // Leases + retained workspace: no cleanup, no worktree deletion.
    expect(tailEvents.some((ev) => ev.type === "cycle:cleanup_completed")).toBe(false);
    expect(existsSync(p.worktreePath)).toBe(true);
  });

  it("the resumed tail runs the REAL probe end-to-end: a rebase conflict → main_freshness{conflict} + tail_cancelled + serial_recovery, no pin (matrix #9)", async () => {
    const { repo } = makeFixture("f9-conflict");
    const rt = tmp("f9-conflict-rt");
    const cycleId = "20260620-040100-3007";
    const p = paths(rt, cycleId);

    const shim: AgentSpawn = async (agent, opts) => shimAgentTcr(agent, opts);
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const buildPorts: Ports = { ...base, agentSpawn: shim, github: fakeGithub(0) };
    const built = await runCycleOnce({ ports: buildPorts, ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never }, handoff: true });
    expect(built.handedOff).toBe(true);

    const events1 = new EventBus().readEvents(p.eventsPath);
    const view = projectCycleHandoff(events1, cycleId);
    const identity = view!.identity!;
    const admitted = events1.find((ev) => ev.type === "cycle:admitted" && "identity" in ev && ev.identity?.cycleId === cycleId);

    // The predecessor merge writes the SAME path the builder shipped → conflict.
    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "delivered.txt"), "predecessor wrote the same path\n");
    git(repo, [...GIT_ID, "add", "-A"]);
    git(repo, [...GIT_ID, "commit", "-qm", "M1 same-path merge"]);
    const mergeSha = git(repo, ["rev-parse", "HEAD"]).trim();

    appendEvents(p.eventsPath, [
      { type: "delivery:merge_confirmed", cycleId: "cP", storyId: "US-P", branch: "loop/cycle-cP", signal: "merge_commit", mergeCommit: mergeSha, ts: (admitted?.ts ?? 0) + 1000 },
      { type: "cycle:builder_handoff", eventId: "ev-promote", idempotencyKey: `handoff:${identity.storyId}:${identity.attempt}:${identity.fence}`, identity, previousReadyKey: view!.readyKey!, next: "evaluate_or_test", ts: Date.now() },
    ]);

    const resumePorts: Ports = { ...base, github: fakeGithub(0) };
    const tail = await runTailOnce({
      ports: resumePorts,
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
      identity,
      checkFreshness: makeFreshnessCheck(resumePorts, p.eventsPath, rt),
    });

    expect(tail.recoveryRecorded).toBe(true);
    const tailEvents = new EventBus().readEvents(p.eventsPath);
    expect(tailEvents.find((ev) => ev.type === "cycle:main_freshness")).toMatchObject({ verdict: "conflict" });
    expect(tailEvents.some((ev) => ev.type === "cycle:tail_cancelled")).toBe(true);
    expect(tailEvents.some((ev) => ev.type === "cycle:serial_recovery")).toBe(true);
    // No planned rebase, no pin.
    expect(tailEvents.some((ev) => ev.type === "cycle:rebased_attempt_planned")).toBe(false);
    expect(gitSucceeds(repo, ["rev-parse", "--verify", `refs/roll/rebase-candidates/${cycleId}/1`])).toBe(false);
    expect(existsSync(p.worktreePath)).toBe(true);
  });
});
