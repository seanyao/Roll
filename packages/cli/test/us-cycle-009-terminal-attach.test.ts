/**
 * US-CYCLE-009 (codex #3) — the auto-merge attach is HEAD-SHA-PINNED, and when
 * the real branch tip cannot be resolved via ls-remote the runner REFUSES to arm
 * an unpinned merge (an unpinned squash could merge a stale head): it strips the
 * merge step, opens the PR anyway, and alerts (reconcile self-merges later).
 */
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CycleContext } from "@roll/core";
import type { RollEvent } from "@roll/spec";
import type { Ports } from "../src/runner/ports.js";
import { executeCommand } from "../src/runner/executor.js";

function makeCtx(): CycleContext {
  return {
    cycleId: "20260723-000000-1",
    branch: "loop/cycle-20260723-000000-1",
    loop: "ci" as never,
    storyId: "US-CYCLE-009",
    agent: "claude",
    model: "",
    startSec: 1,
    cost: { cycleId: "20260723-000000-1", agent: "claude", model: "", tokensIn: 0, tokensOut: 0, estimatedCost: 0, revertCount: 0, effectiveCost: 0 },
  } as CycleContext;
}

function git(cwd: string, ...args: string[]): void {
  const env = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  execFileSync("git", args, { cwd, env });
}

function initRepoWithEvidence(): { root: string; runtimeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "roll-uscycle009-term-"));
  const cardDir = join(root, ".roll", "features", "cycle-efficiency", "US-CYCLE-009");
  const runDir = join(cardDir, "20260723-000000-1");
  mkdirSync(join(runDir, "latest"), { recursive: true });
  writeFileSync(join(cardDir, "ac-map.json"), JSON.stringify([{ ac: "US-CYCLE-009:AC1", status: "pass" }]));
  mkdirSync(join(cardDir, "latest"), { recursive: true });
  writeFileSync(join(cardDir, "latest", "US-CYCLE-009-report.html"), "<html>report</html>\n");
  writeFileSync(join(runDir, "latest", "evidence.json"), "{}\n");

  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "roll-test@example.test");
  git(root, "config", "user.name", "Roll Test");
  git(root, "config", "core.hooksPath", "");
  writeFileSync(join(root, "README.md"), "# test\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "init");

  return { root, runtimeDir: join(root, ".roll", "loop") };
}

interface CapturedPlan {
  plan: ReadonlyArray<{ kind: string; tool: string; argv: string[] }>;
}

function makePorts(
  runtimeDir: string,
  repoCwd: string,
  remoteBranchTip: (() => Promise<string | undefined>) | undefined,
  captured: CapturedPlan[],
): { ports: Ports; alerts: string[]; events: RollEvent[] } {
  mkdirSync(runtimeDir, { recursive: true });
  const events: RollEvent[] = [];
  const alerts: string[] = [];
  const gitPort: Record<string, unknown> = {
    fetchOrigin: vi.fn(async () => ({ fetched: true })),
    worktreeAdd: vi.fn(async () => ({ code: 0 })),
    worktreeSubmoduleInit: vi.fn(async () => ({ code: 0 })),
    worktreeRemove: vi.fn(async () => ({ code: 0 })),
    push: vi.fn(async () => ({ code: 0 })),
    commitsAhead: vi.fn(async () => 1),
    mainAhead: vi.fn(async () => 0),
    rescueLeaked: vi.fn(async () => ({ code: 0, rescuedSha: "" })),
    tcrCount: vi.fn(async () => 0),
    recentCommits: vi.fn(async () => []),
    fetchRemoteBranch: vi.fn(async () => ({ fetched: true })),
    branchMergedIntoMain: vi.fn(async () => false),
    branchCleanlyRebasesOntoMain: vi.fn(async () => true),
    resetWorktreeHard: vi.fn(async () => ({ code: 0 })),
    landLocalDelivery: vi.fn(async () => ({ code: 0, sha: "x", landedBranch: "main", method: "fast_forward" as const, stderr: "" })),
  };
  if (remoteBranchTip !== undefined) gitPort["remoteBranchTip"] = vi.fn(remoteBranchTip);

  const ports = {
    repoCwd,
    paths: {
      eventsPath: join(runtimeDir, "events.ndjson"),
      runsPath: join(runtimeDir, "runs.jsonl"),
      alertsPath: join(runtimeDir, "ALERT.md"),
      lockPath: join(runtimeDir, "inner.lock"),
      heartbeatPath: join(runtimeDir, "heartbeat"),
      worktreePath: join(repoCwd, "wt"),
    },
    clock: () => 42,
    // US-CYCLE-011: satisfy the round-tail full-verify half of the evidence gate
    // so these auto-merge-attach assertions (which predate it) still publish.
    fullVerify: { proofBody: () => '{"ts":42,"tree":"T","mode":"full"}', deliveredTree: () => "T" },
    skillBody: "work",
    github: {
      repoSlug: vi.fn(async () => "o/r"),
      runPublishPlan: vi.fn(async (plan: ReadonlyArray<{ kind: string; tool: string; argv: string[] }>) => {
        captured.push({ plan });
        return { status: 0 as const, prUrl: "https://github.com/o/r/pull/77", ok: true };
      }),
      prState: vi.fn(async () => "UNKNOWN"),
      prMergeInfo: vi.fn(async () => undefined),
      openPrTitles: vi.fn(async () => []),
    },
    git: gitPort,
    events: {
      ensureEventFiles: vi.fn(),
      appendEvent: vi.fn((_path: string, ev: RollEvent) => events.push(ev)),
      upsertRun: vi.fn(),
      appendAlert: vi.fn((_path: string, msg: string) => alerts.push(msg)),
    },
    process: {
      acquireLock: vi.fn(() => ({ acquired: true, heldByPid: undefined })),
      releaseLock: vi.fn(),
      writeHeartbeat: vi.fn(),
    },
    backlog: { read: vi.fn(() => []) },
    metadata: { commit: vi.fn(async () => ({ committed: false, pushed: false, nothingToCommit: true })) },
    route: { resolve: vi.fn(() => ({ agent: "claude", model: "" })) },
    evidence: { openFrame: vi.fn(() => join(repoCwd, ".roll", "features", "cycle-efficiency", "US-CYCLE-009", "20260723-000000-1")) },
    capture: { fromMarker: vi.fn(async () => ({ kind: "web", out: "", taken: false })) },
    attest: { render: vi.fn(async () => 0) },
    agentSpawn: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false })),
    installedAgents: () => [],
  } as unknown as Ports;
  return { ports, alerts, events };
}

async function withCleanGitEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  const vars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
  for (const k of vars) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    return await fn();
  } finally {
    for (const k of vars) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function mergeStep(cap: CapturedPlan): { kind: string; tool: string; argv: string[] } | undefined {
  return cap.plan.find((s) => s.kind === "gh-pr-merge-auto" || s.kind === "gh-pr-merge-admin");
}

describe("US-CYCLE-009 (codex #3) — auto-merge attach sha-pin / ls-remote-fail guard", () => {
  it("resolvable tip → auto-merge armed with --match-head-commit <sha>", async () => {
    const { root, runtimeDir } = initRepoWithEvidence();
    try {
      await withCleanGitEnv(async () => {
        const captured: CapturedPlan[] = [];
        const { ports } = makePorts(runtimeDir, root, async () => "beeff00d", captured);
        await executeCommand({ kind: "publish_pr", branch: "loop/cycle-20260723-000000-1", docOnly: false }, ports, makeCtx());
        expect(captured).toHaveLength(1);
        const m = mergeStep(captured[0]!);
        expect(m).toBeDefined();
        expect(m!.argv).toContain("--auto");
        expect(m!.argv).toContain("--match-head-commit");
        expect(m!.argv).toContain("beeff00d");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ls-remote fail (tip unresolved) → NO auto-merge step armed + alert; PR still opens", async () => {
    const { root, runtimeDir } = initRepoWithEvidence();
    try {
      await withCleanGitEnv(async () => {
        const captured: CapturedPlan[] = [];
        // remoteBranchTip resolves to undefined (ls-remote failed).
        const { ports, alerts, events } = makePorts(runtimeDir, root, async () => undefined, captured);
        const r = await executeCommand({ kind: "publish_pr", branch: "loop/cycle-20260723-000000-1", docOnly: false }, ports, makeCtx());
        // PR still opened (publish succeeded).
        expect(r.event).toMatchObject({ type: "published", result: { status: 0 } });
        expect(events.filter((e) => e.type === "delivery:published")).toHaveLength(1);
        // NO unpinned merge armed.
        expect(captured).toHaveLength(1);
        expect(mergeStep(captured[0]!)).toBeUndefined();
        // Alert makes the deferral visible.
        expect(alerts.some((a) => a.includes("auto-merge NOT armed") && a.includes("unpinned"))).toBe(true);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
