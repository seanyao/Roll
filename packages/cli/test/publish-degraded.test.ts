/**
 * FIX-1214 — degraded publish hand-off tests (terminal executor layer).
 */
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CycleContext } from "@roll/core";
import type { Ports } from "../src/runner/ports.js";
import { executeCommand } from "../src/runner/executor.js";
import { pendingPrCreatePath, readPendingPrCreates } from "../src/runner/pending-pr-create.js";

function makeCtx(overrides: Partial<CycleContext> = {}): CycleContext {
  return {
    cycleId: "20260605-000000-1",
    branch: "loop/cycle-20260605-000000-1",
    loop: "ci" as never,
    storyId: "FIX-1214",
    agent: "claude",
    model: "",
    startSec: 1,
    cost: { cycleId: "20260605-000000-1", agent: "claude", model: "", tokensIn: 0, tokensOut: 0, estimatedCost: 0, revertCount: 0, effectiveCost: 0 },
    ...overrides,
  } as CycleContext;
}

function git(cwd: string, ...args: string[]): void {
  const env = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  execFileSync("git", args, { cwd, env });
}

function initRepoWithEvidence(): { root: string; runtimeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "roll-pub-degraded-"));
  const cardDir = join(root, ".roll", "features", "uncategorized", "FIX-1214");
  const runDir = join(cardDir, "20260605-000000-1");
  mkdirSync(join(runDir, "latest"), { recursive: true });
  writeFileSync(join(cardDir, "ac-map.json"), JSON.stringify([{ ac: "FIX-1214:AC1", status: "pass" }]));
  // US-DELIV-004: the push-time evidence gate requires an attest report too.
  mkdirSync(join(cardDir, "latest"), { recursive: true });
  writeFileSync(join(cardDir, "latest", "FIX-1214-report.html"), "<html>report</html>\n");
  writeFileSync(join(runDir, "latest", "evidence.json"), "{}\n");

  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "roll-test@example.test");
  git(root, "config", "user.name", "Roll Test");
  git(root, "config", "core.hooksPath", "");
  writeFileSync(join(root, "README.md"), "# test\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "init");

  const runtimeDir = join(root, ".roll", "loop");
  return { root, runtimeDir };
}

function makePorts(runtimeDir: string, repoCwd: string): { ports: Ports; events: unknown[]; alerts: string[] } {
  mkdirSync(runtimeDir, { recursive: true });
  const events: unknown[] = [];
  const alerts: string[] = [];
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
    // so the degraded-publish hand-off assertion (which predates it) still runs.
    fullVerify: { proofBody: () => '{"ts":42,"tree":"T","mode":"full"}', deliveredTree: () => "T" },
    skillBody: "work",
    github: {
      repoSlug: vi.fn(async () => "o/r"),
      runPublishPlan: vi.fn(async () => ({
        status: 0 as const,
        prUrl: "",
        ok: false,
        degraded: true,
        rootCauseKey: "env:gh_api",
      })),
      prState: vi.fn(async () => "UNKNOWN"),
      prMergeInfo: vi.fn(async () => undefined),
      openPrTitles: vi.fn(async () => []),
    },
    git: {
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
    },
    events: {
      ensureEventFiles: vi.fn(),
      appendEvent: vi.fn((_path, ev) => events.push(ev)),
      upsertRun: vi.fn(),
      appendAlert: vi.fn((_path, msg) => alerts.push(msg)),
    },
    process: {
      acquireLock: vi.fn(() => ({ acquired: true, heldByPid: undefined })),
      releaseLock: vi.fn(),
      writeHeartbeat: vi.fn(),
    },
    backlog: { read: vi.fn(() => []) },
    metadata: {
      commit: vi.fn(async () => ({ committed: false, pushed: false, nothingToCommit: true })),
    },
    route: { resolve: vi.fn(() => ({ agent: "claude", model: "" })) },
    evidence: { openFrame: vi.fn(() => join(repoCwd, ".roll", "features", "uncategorized", "FIX-1214", "20260605-000000-1")) },
    capture: { fromMarker: vi.fn(async () => ({ kind: "web", out: "", taken: false })) },
    attest: { render: vi.fn(async () => 0) },
    agentSpawn: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false })),
    installedAgents: () => [],
  } as unknown as Ports;
  return { ports, events, alerts };
}

describe("FIX-1214 publish degraded hand-off", () => {
  it("terminal executor queues a pending-pr-create entry on degraded publish", async () => {
    const { root, runtimeDir } = initRepoWithEvidence();
    const { ports, events, alerts } = makePorts(runtimeDir, root);

    const oldGitDir = process.env["GIT_DIR"];
    const oldGitWorkTree = process.env["GIT_WORK_TREE"];
    delete process.env["GIT_DIR"];
    delete process.env["GIT_WORK_TREE"];
    try {
      const r = await executeCommand({ kind: "publish_pr", branch: "loop/cycle-x", docOnly: false }, ports, makeCtx());

      expect(r.event).toMatchObject({
        type: "published",
        result: { status: 0, degraded: true, rootCauseKey: "env:gh_api" },
      });

      const queued = readPendingPrCreates(runtimeDir);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ branch: "loop/cycle-x", slug: "o/r", storyId: "FIX-1214", cycleId: "20260605-000000-1" });

      expect(alerts.some((a) => a.includes("FIX-1214") && a.includes("queued for reconciler retry"))).toBe(true);
      expect(events.some((e) => (e as { type: string }).type === "alert:notify" && (e as { channel: string }).channel === "publish-degraded")).toBe(true);

      const deliveriesPath = join(runtimeDir, "deliveries.jsonl");
      expect(existsSync(deliveriesPath)).toBe(true);
      const record = JSON.parse(readFileSync(deliveriesPath, "utf8").trim().split("\n")[0] ?? "{}") as {
        lifecycleState: string;
        prNumber: { present: boolean };
        prUrl: { present: boolean };
      };
      expect(record.lifecycleState).toBe("pending_merge");
      expect(record.prNumber.present).toBe(false);
      expect(record.prUrl.present).toBe(false);
    } finally {
      if (oldGitDir === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = oldGitDir;
      if (oldGitWorkTree === undefined) delete process.env["GIT_WORK_TREE"];
      else process.env["GIT_WORK_TREE"] = oldGitWorkTree;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
