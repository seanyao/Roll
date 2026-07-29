/**
 * US-DELIV-001 — delivery:published event emission tests (terminal executor).
 *
 * AC2 (goal 2): a successful publish appends `delivery:published` — the fact
 * that moves the cycle into awaiting_merge and releases the loop (no
 * merge-wait). A failed publish appends nothing: no awaiting_merge without a PR.
 */
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CycleContext } from "@roll/core";
import type { RollEvent } from "@roll/spec";
import { landLocalDelivery, submoduleWorktreePath, worktreeAddInSubmodule } from "@roll/infra";
import type { Ports } from "../src/runner/ports.js";
import { executeCommand } from "../src/runner/executor.js";

function makeCtx(): CycleContext {
  return {
    cycleId: "20260712-000000-1",
    branch: "loop/cycle-20260712-000000-1",
    loop: "ci" as never,
    storyId: "US-DELIV-001",
    agent: "claude",
    model: "",
    startSec: 1,
    cost: { cycleId: "20260712-000000-1", agent: "claude", model: "", tokensIn: 0, tokensOut: 0, estimatedCost: 0, revertCount: 0, effectiveCost: 0 },
  } as CycleContext;
}

function git(cwd: string, ...args: string[]): void {
  const env = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  execFileSync("git", args, { cwd, env });
}

function initRepoWithEvidence(): { root: string; runtimeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "roll-deliv-pub-"));
  const cardDir = join(root, ".roll", "features", "delivery-reconciler", "US-DELIV-001");
  const runDir = join(cardDir, "20260712-000000-1");
  mkdirSync(join(runDir, "latest"), { recursive: true });
  writeFileSync(join(cardDir, "ac-map.json"), JSON.stringify([{ ac: "US-DELIV-001:AC1", status: "pass" }]));
  // US-DELIV-004: the push-time evidence gate requires an attest report too.
  mkdirSync(join(cardDir, "latest"), { recursive: true });
  writeFileSync(join(cardDir, "latest", "US-DELIV-001-report.html"), "<html>report</html>\n");
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

function makePorts(runtimeDir: string, repoCwd: string, publishPlan: () => Promise<{ status: 0 | 1; prUrl: string; ok: boolean }>): { ports: Ports; events: RollEvent[] } {
  mkdirSync(runtimeDir, { recursive: true });
  const events: RollEvent[] = [];
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
    // (a fresh mode:"full" proof matching the delivered tree). The publish-path
    // assertions here predate that gate; other gate reasons still enforce.
    fullVerify: { proofBody: () => '{"ts":42,"tree":"T","mode":"full"}', deliveredTree: () => "T" },
    skillBody: "work",
    github: {
      repoSlug: vi.fn(async () => "o/r"),
      runPublishPlan: vi.fn(publishPlan),
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
      // E3: the real infra landing over the real temp repo/worktree, wrapped in a
      // spy so tests can assert it was (or was not) called.
      landLocalDelivery: vi.fn(async (r: string, wt: string, ib?: string) => landLocalDelivery(r, wt, ib)),
    },
    events: {
      ensureEventFiles: vi.fn(),
      appendEvent: vi.fn((_path: string, ev: RollEvent) => events.push(ev)),
      upsertRun: vi.fn(),
      appendAlert: vi.fn(),
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
    evidence: { openFrame: vi.fn(() => join(repoCwd, ".roll", "features", "delivery-reconciler", "US-DELIV-001", "20260712-000000-1")) },
    capture: { fromMarker: vi.fn(async () => ({ kind: "web", out: "", taken: false })) },
    attest: { render: vi.fn(async () => 0) },
    agentSpawn: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false })),
    installedAgents: () => [],
  } as unknown as Ports;
  return { ports, events };
}

async function withCleanGitEnv<T>(fn: () => Promise<T>): Promise<T> {
  const oldGitDir = process.env["GIT_DIR"];
  const oldGitWorkTree = process.env["GIT_WORK_TREE"];
  delete process.env["GIT_DIR"];
  delete process.env["GIT_WORK_TREE"];
  try {
    return await fn();
  } finally {
    if (oldGitDir === undefined) delete process.env["GIT_DIR"];
    else process.env["GIT_DIR"] = oldGitDir;
    if (oldGitWorkTree === undefined) delete process.env["GIT_WORK_TREE"];
    else process.env["GIT_WORK_TREE"] = oldGitWorkTree;
  }
}

describe("US-DELIV-001 — delivery:published emission", () => {
  it("successful publish appends delivery:published{prNumber,prUrl} (→ awaiting_merge)", async () => {
    const { root, runtimeDir } = initRepoWithEvidence();
    try {
      await withCleanGitEnv(async () => {
        const { ports, events } = makePorts(runtimeDir, root, async () => ({ status: 0 as const, prUrl: "https://github.com/o/r/pull/42", ok: true }));
        const r = await executeCommand({ kind: "publish_pr", branch: "loop/cycle-20260712-000000-1", docOnly: false }, ports, makeCtx());
        expect(r.event).toMatchObject({ type: "published", result: { status: 0 } });

        const published = events.filter((e) => e.type === "delivery:published");
        expect(published).toHaveLength(1);
        expect(published[0]).toMatchObject({
          type: "delivery:published",
          cycleId: "20260712-000000-1",
          storyId: "US-DELIV-001",
          branch: "loop/cycle-20260712-000000-1",
          prNumber: 42,
          prUrl: "https://github.com/o/r/pull/42",
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("failed publish appends NO delivery:published (no awaiting_merge without a PR)", async () => {
    const { root, runtimeDir } = initRepoWithEvidence();
    try {
      await withCleanGitEnv(async () => {
        const { ports, events } = makePorts(runtimeDir, root, async () => ({ status: 1 as const, prUrl: "", ok: false }));
        const r = await executeCommand({ kind: "publish_pr", branch: "loop/cycle-20260712-000000-1", docOnly: false }, ports, makeCtx());
        expect(r.event).toMatchObject({ type: "published", result: { status: 1 } });
        expect(events.filter((e) => e.type === "delivery:published")).toHaveLength(0);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── E3: local-only delivery mode (publish_mode: local) ──────────────────────

/** Set publish_mode in the repo's project config. */
function setPublishMode(root: string, mode: string): void {
  mkdirSync(join(root, ".roll"), { recursive: true });
  writeFileSync(join(root, ".roll", "local.yaml"), `publish_mode: ${mode}\n`);
}

/** Create a REAL detached cycle worktree at <root>/wt with one cycle commit,
 *  branched off main. Returns the cycle HEAD sha. */
function makeCycleWorktree(root: string): string {
  const wt = join(root, "wt");
  git(root, "worktree", "add", "--detach", wt, "main");
  writeFileSync(join(wt, "feature.txt"), "cycle work\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "tcr: cycle work");
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
}

describe("US-E3 — local-only delivery (publish_mode: local)", () => {
  it("gate passes → lands locally, emits delivery:reconciled{delivered_local}, NO push / NO gh, status 0", async () => {
    const { root, runtimeDir } = initRepoWithEvidence();
    try {
      await withCleanGitEnv(async () => {
        setPublishMode(root, "local");
        const cycleSha = makeCycleWorktree(root);
        const mainBefore = execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: root, encoding: "utf8" }).trim();
        expect(mainBefore).not.toBe(cycleSha);

        const { ports, events } = makePorts(runtimeDir, root, async () => {
          throw new Error("runPublishPlan must not run in local mode");
        });
        const r = await executeCommand({ kind: "publish_pr", branch: "loop/cycle-20260712-000000-1", docOnly: false }, ports, makeCtx());

        // cycle success
        expect(r.event).toMatchObject({ type: "published", result: { status: 0 } });

        // NO remote work
        expect(ports.git.push).not.toHaveBeenCalled();
        expect(ports.github.runPublishPlan).not.toHaveBeenCalled();
        expect(ports.github.repoSlug).not.toHaveBeenCalled();
        // NO awaiting_merge (that is the REMOTE fact) — no PR was opened
        expect(events.filter((e) => e.type === "delivery:published")).toHaveLength(0);

        // the local integration branch now contains the cycle commit
        const mainAfter = execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: root, encoding: "utf8" }).trim();
        expect(mainAfter).toBe(cycleSha);
        expect(ports.git.landLocalDelivery).toHaveBeenCalledTimes(1);

        // delivery:reconciled{delivered_local} with the landing sha
        const reconciled = events.filter((e) => e.type === "delivery:reconciled");
        expect(reconciled).toHaveLength(1);
        expect(reconciled[0]).toMatchObject({
          type: "delivery:reconciled",
          cycleId: "20260712-000000-1",
          storyId: "US-DELIV-001",
          state: "delivered_local",
          mergedBy: "runner",
          mergeCommit: cycleSha,
        });

        // the evidence gate STILL ran (earned)
        const gate = events.filter((e) => e.type === "delivery:evidence_gate");
        expect(gate).toHaveLength(1);
        expect(gate[0]).toMatchObject({ verdict: "earned" });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gate FAILS → blocked_no_evidence, NO push, NO local landing", async () => {
    const { root, runtimeDir } = initRepoWithEvidence();
    try {
      await withCleanGitEnv(async () => {
        setPublishMode(root, "local");
        makeCycleWorktree(root);
        // remove ALL acceptance evidence so the evidence gate blocks (report +
        // ac-map both gone → attestReportPresent:false, acMapPresent:false).
        // initRepoWithEvidence commits .roll, so the detached worktree carries a
        // copy too — clear the card from BOTH evidence roots (worktree + repo).
        for (const base of [root, join(root, "wt")]) {
          rmSync(join(base, ".roll", "features", "delivery-reconciler", "US-DELIV-001"), { recursive: true, force: true });
        }

        const { ports, events } = makePorts(runtimeDir, root, async () => {
          throw new Error("runPublishPlan must not run in local mode");
        });
        const r = await executeCommand({ kind: "publish_pr", branch: "loop/cycle-20260712-000000-1", docOnly: false }, ports, makeCtx());

        // blocked: status 1 + gateBlocked (same as remote gate-block)
        expect(r.event).toMatchObject({ type: "published", result: { status: 1, gateBlocked: true } });
        // no landing, no push, no reconciled credit
        expect(ports.git.landLocalDelivery).not.toHaveBeenCalled();
        expect(ports.git.push).not.toHaveBeenCalled();
        expect(events.filter((e) => e.type === "delivery:reconciled")).toHaveLength(0);
        const gate = events.filter((e) => e.type === "delivery:evidence_gate");
        expect(gate).toHaveLength(1);
        expect(gate[0]).toMatchObject({ verdict: "blocked" });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publish_mode remote (default) still opens a PR — zero regression", async () => {
    const { root, runtimeDir } = initRepoWithEvidence();
    try {
      await withCleanGitEnv(async () => {
        // no publish_mode config → default remote
        const { ports, events } = makePorts(runtimeDir, root, async () => ({ status: 0 as const, prUrl: "https://github.com/o/r/pull/42", ok: true }));
        const r = await executeCommand({ kind: "publish_pr", branch: "loop/cycle-20260712-000000-1", docOnly: false }, ports, makeCtx());
        expect(r.event).toMatchObject({ type: "published", result: { status: 0 } });
        expect(ports.github.runPublishPlan).toHaveBeenCalledTimes(1);
        expect(ports.git.landLocalDelivery).not.toHaveBeenCalled();
        expect(events.filter((e) => e.type === "delivery:published")).toHaveLength(1);
        expect(events.filter((e) => e.type === "delivery:reconciled")).toHaveLength(0);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── E2: submodule-aware local delivery (target_submodule + publish_mode:local) ─

/**
 * Build a superproject (with acceptance evidence + publish_mode:local) that
 * embeds a real git submodule `sub` on a local integration branch
 * `feat/contractor2.0`. Returns the pieces the e2e assertion needs.
 */
function initSuperprojectWithSubmoduleCycle(): {
  root: string;
  runtimeDir: string;
  submoduleName: string;
  submodulePath: string;
  cycleWtRoot: string;
} {
  const subUpstream = mkdtempSync(join(tmpdir(), "roll-e2-subup-"));
  git(subUpstream, "init", "-b", "main");
  git(subUpstream, "config", "user.email", "roll-test@example.test");
  git(subUpstream, "config", "user.name", "Roll Test");
  git(subUpstream, "config", "core.hooksPath", "");
  writeFileSync(join(subUpstream, "sub-file.txt"), "sub base\n");
  git(subUpstream, "add", "-A");
  git(subUpstream, "commit", "-m", "sub base");
  git(subUpstream, "branch", "feat/contractor2.0");

  const { root, runtimeDir } = initRepoWithEvidence();
  setPublishMode(root, "local");
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", subUpstream, "sub"], { cwd: root });
  const submoduleName = "sub";
  const submodulePath = join(root, submoduleName);
  git(submodulePath, "config", "user.email", "roll-test@example.test");
  git(submodulePath, "config", "user.name", "Roll Test");
  git(submodulePath, "branch", "feat/contractor2.0", "origin/feat/contractor2.0");
  // The submodule's OWN integration branch (E1 config on the SUBMODULE tree).
  mkdirSync(join(submodulePath, ".roll"), { recursive: true });
  writeFileSync(join(submodulePath, ".roll", "local.yaml"), "integration_branch: feat/contractor2.0\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "add submodule sub");

  const cycleWtRoot = join(mkdtempSync(join(tmpdir(), "roll-e2-cyc-")), "cycle");
  return { root, runtimeDir, submoduleName, submodulePath, cycleWtRoot };
}

describe("US-E2 — submodule-aware local delivery", () => {
  it("lands on the SUBMODULE's local integration branch; the real submodule checkout sees it advance; no push", async () => {
    const { root, runtimeDir, submoduleName, submodulePath, cycleWtRoot } = initSuperprojectWithSubmoduleCycle();
    try {
      await withCleanGitEnv(async () => {
        // Build the submodule cycle worktree via the E2 infra primitive.
        const add = await worktreeAddInSubmodule(root, submoduleName, cycleWtRoot, "feat/contractor2.0");
        expect(add.code).toBe(0);
        const subWt = submoduleWorktreePath(cycleWtRoot, submoduleName);
        writeFileSync(join(subWt, "cycle-work.txt"), "cycle in submodule\n");
        git(subWt, "add", "-A");
        git(subWt, "commit", "-m", "tcr: cycle work in submodule");
        const cycleSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: subWt, encoding: "utf8" }).trim();

        const branchBefore = execFileSync("git", ["rev-parse", "refs/heads/feat/contractor2.0"], { cwd: submodulePath, encoding: "utf8" }).trim();
        expect(branchBefore).not.toBe(cycleSha);

        // Ports: repoCwd is the SUPERPROJECT; worktreePath is the canonical cycle
        // path. Delivery redirects into the submodule from ctx.targetSubmodule.
        const { ports, events } = makePorts(runtimeDir, root, async () => {
          throw new Error("runPublishPlan must not run in local mode");
        });
        (ports as { paths: { worktreePath: string } }).paths.worktreePath = cycleWtRoot;

        const ctx = { ...makeCtx(), targetSubmodule: submoduleName } as CycleContext;
        const r = await executeCommand(
          { kind: "publish_pr", branch: "loop/cycle-20260712-000000-1", docOnly: false },
          ports,
          ctx,
        );

        expect(r.event).toMatchObject({ type: "published", result: { status: 0 } });
        expect(ports.git.push).not.toHaveBeenCalled();
        expect(ports.github.runPublishPlan).not.toHaveBeenCalled();

        // The SUBMODULE's local integration branch advanced to the cycle commit —
        // the user's REAL submodule checkout (git -C <super>/<sub>) sees it.
        const branchAfter = execFileSync("git", ["rev-parse", "refs/heads/feat/contractor2.0"], { cwd: submodulePath, encoding: "utf8" }).trim();
        expect(branchAfter).toBe(cycleSha);

        const reconciled = events.filter((e) => e.type === "delivery:reconciled");
        expect(reconciled).toHaveLength(1);
        expect(reconciled[0]).toMatchObject({
          type: "delivery:reconciled",
          state: "delivered_local",
          mergeCommit: cycleSha,
        });
        const gate = events.filter((e) => e.type === "delivery:evidence_gate");
        expect(gate).toHaveLength(1);
        expect(gate[0]).toMatchObject({ verdict: "earned" });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cycleWtRoot, { recursive: true, force: true });
    }
  });
});
