import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLoopRunnerScript,
  LOOP_ON_USAGE,
  loopOnCommand,
  loopPauseCommand,
  loopResumeCommand,
  loopWorkspaceStatusCommand,
  writeDormantMarker,
  type LoopSchedDeps,
} from "../src/commands/loop-sched.js";
import type { BacklogTargetDecision } from "../src/commands/backlog-target.js";
import { loopGoCommand, planGoTmuxCommands, type LoopGoDeps, type StartTmuxInput } from "../src/commands/loop-go.js";
import { loopRunOnceCommand, workspaceBranchCanaryTrips } from "../src/commands/loop-run-once.js";
import type { WorkspaceWorktreeAuditOutput } from "../src/commands/workspace-worktree-lifecycle.js";
import { backlogClaimCommand } from "../src/commands/backlog-mgmt.js";
import { nodePorts, type RunnerPaths } from "../src/runner/index.js";
import type { AgentSpawn } from "../src/runner/agent-spawn.js";
import { executeSetupCommand } from "../src/runner/setup-handlers.js";
import { WorkspaceRegistry } from "@roll/infra";
import type { RouteDeps } from "@roll/core";
import { REPOSITORY_BINDING_V1, WORKSPACE_MANIFEST_V1, repositoryIdFromRemote } from "@roll/spec";
import { workspaceSchedulerPaths } from "../src/lib/operating-mode.js";

const dirs: string[] = [];

function leaseRecordPath(leaseDir: string, storyId: string): string {
  return join(leaseDir, `${storyId}.lease`);
}

function workspaceRoot(id: string): string {
  const root = mkdtempSync(join(tmpdir(), `roll-${id}-`));
  dirs.push(root);
  return root;
}

function workspaceManifest(root: string, workspaceId: string): void {
  const remote = `https://example.test/workspaces/${workspaceId}.git`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must be valid");
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId,
    displayName: workspaceId,
    requirements: [],
    repositories: [{
      schema: REPOSITORY_BINDING_V1,
      repoId: repoId.value,
      alias: "primary",
      remote,
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  })}\n`);
}

function workspaceIssue(root: string, workspaceId: string, storyId: string): { readonly issueRoot: string } {
  const remote = `https://example.test/workspaces/${workspaceId}.git`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must be valid");
  const issueRoot = join(root, "issues", storyId);
  const worktreePath = join(issueRoot, "primary");
  mkdirSync(worktreePath, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.email", "roll-test@example.invalid"], { cwd: worktreePath });
  writeFileSync(join(worktreePath, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: worktreePath });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: worktreePath });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
  writeFileSync(join(issueRoot, "manifest.json"), `${JSON.stringify({
    schema: "roll.issue/v1",
    workspaceId,
    storyId,
    requirements: [],
    repositories: [{
      repoId: repoId.value,
      alias: "primary",
      access: "write",
      requiredDelivery: true,
      noChangePolicy: "changes_required",
    }],
  }, null, 2)}\n`);
  writeFileSync(join(issueRoot, "events.jsonl"), `${JSON.stringify({
    type: "issue:repository_bound",
    workspaceId,
    storyId,
    alias: "primary",
    repoId: repoId.value,
    access: "write",
    baseSha: headSha,
    worktreePath,
    workBranch: `roll/${workspaceId}/${storyId}`,
    ts: 1,
  })}\n`);
  return { issueRoot };
}

function target(workspaceId: string, workspaceRoot: string): BacklogTargetDecision {
  return {
    ok: true,
    workspaceId,
    workspaceRoot,
    canonicalRoot: workspaceRoot,
    backlogPath: join(workspaceRoot, "backlog", "index.md"),
    storyRoot: join(workspaceRoot, "backlog"),
    runtimeRoot: join(workspaceRoot, "runtime"),
    configPath: join(workspaceRoot, "runtime", "backlog-sync.yaml"),
  };
}

function schedulerDeps(
  roots: Readonly<Record<string, string>>,
  resolveTarget: (args: readonly string[], operation: "read" | "mutation") => BacklogTargetDecision,
  armed: (label: string) => boolean = () => true,
): { readonly deps: LoopSchedDeps; readonly calls: string[]; readonly shared: string; readonly launchd: string } {
  const shared = workspaceRoot("shared");
  const launchd = workspaceRoot("launchd");
  const calls: string[] = [];
  return {
    shared,
    launchd,
    calls,
    deps: {
      identity: () => Promise.reject(new Error("legacy identity must not be used")),
      uid: () => 501,
      sharedRoot: () => shared,
      launchdDir: () => launchd,
      resolveTarget,
      scheduler: {
        wake: (label, plist) => (calls.push(`wake ${label} ${plist}`), Promise.resolve(true)),
        dormant: (label) => (calls.push(`dormant ${label}`), Promise.resolve(true)),
        isArmed: (label) => (calls.push(`isArmed ${label}`), Promise.resolve(armed(label))),
      },
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("US-WS-016 Workspace scheduler contract", () => {
  it("pauses a Workspace loop when aggregate branch pressure exceeds the canary threshold", () => {
    const root = workspaceRoot("workspace-canary");
    const runtimeRoot = join(root, "runtime");
    const alertsPath = join(runtimeRoot, "ALERT-ws-alpha.md");
    const audit: WorkspaceWorktreeAuditOutput = {
      schema: 1,
      generatedAt: "2026-07-22T00:00:00.000Z",
      selectedWorkspaceId: "ws-alpha",
      records: [],
      ephemeralBranches: [
        { repoId: "repo-a", cachePath: "/cache/repo-a.git", branch: "loop/cycle-a" },
        { repoId: "repo-b", cachePath: "/cache/repo-b.git", branch: "loop/cycle-b" },
      ],
      repositories: [
        { repoId: "repo-a", cachePath: "/cache/repo-a.git", integrationBranch: "main" },
        { repoId: "repo-b", cachePath: "/cache/repo-b.git", integrationBranch: "main" },
      ],
      summary: {
        worktrees: 0,
        active: 0,
        disposableCandidates: 0,
        preserved: 0,
        ephemeralBranches: 2,
        canaryTotal: 2,
      },
    };
    const previous = process.env["ROLL_BRANCH_CANARY_MAX"];
    process.env["ROLL_BRANCH_CANARY_MAX"] = "1";
    try {
      expect(workspaceBranchCanaryTrips({
        workspaceId: "ws-alpha",
        workspaceRoot: root,
        runtimeRoot,
        alertsPath,
      }, () => audit)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["ROLL_BRANCH_CANARY_MAX"];
      else process.env["ROLL_BRANCH_CANARY_MAX"] = previous;
    }

    const pause = readFileSync(join(runtimeRoot, "PAUSE-ws-alpha"), "utf8");
    expect(pause).toContain("repo-a:loop/cycle-a");
    expect(pause).toContain("repo-b:loop/cycle-b");
    expect(pause).toContain("roll worktree cleanup --workspace ws-alpha --dry-run");
    expect(readFileSync(alertsPath, "utf8")).toContain("Leak count**: 2");
  });

  it("binds the production backlog port to the Workspace backlog and leaves legacy repo-local state untouched", () => {
    const root = workspaceRoot("backlog-port");
    workspaceManifest(root, "ws-alpha");
    const backlogPath = join(root, "backlog", "index.md");
    const legacyBacklogPath = join(root, ".roll", "backlog.md");
    mkdirSync(join(root, "backlog"), { recursive: true });
    mkdirSync(join(root, ".roll"), { recursive: true });
    writeFileSync(
      backlogPath,
      "| Story | Description | Status |\n|---|---|---|\n| US-WS-016 | Workspace story | 📋 Todo |\n",
    );
    writeFileSync(
      legacyBacklogPath,
      "| Story | Description | Status |\n|---|---|---|\n| LEGACY-1 | Legacy decoy | 📋 Todo |\n",
    );
    const runtimeRoot = join(root, "runtime");
    const paths: RunnerPaths = {
      eventsPath: join(runtimeRoot, "events.ndjson"),
      runsPath: join(runtimeRoot, "runs.jsonl"),
      alertsPath: join(runtimeRoot, "alerts.log"),
      lockPath: join(runtimeRoot, "inner.lock"),
      heartbeatPath: join(runtimeRoot, "heartbeat"),
      worktreePath: join(runtimeRoot, "worktrees", "cycle-test"),
    };
    const routeDeps: RouteDeps = {
      readSlot: () => ({ agent: "claude" }),
      firstInstalled: () => "claude",
    };
    const ports = nodePorts({ repoCwd: root, paths, skillBody: "BUILD STORY", routeDeps });

    expect(ports.backlog.read(root)).toEqual([
      expect.objectContaining({ id: "US-WS-016", status: "📋 Todo" }),
    ]);
    ports.backlog.markStatus?.(root, "US-WS-016", "🔨 In Progress");

    expect(readFileSync(backlogPath, "utf8")).toContain("US-WS-016 | Workspace story | 🔨 In Progress");
    expect(readFileSync(legacyBacklogPath, "utf8")).toContain("LEGACY-1 | Legacy decoy | 📋 Todo");
  });

  it("keeps a human backlog claim authoritative when the visible status drifts back to Todo", async () => {
    const root = workspaceRoot("human-lease");
    const storyId = "US-WS-016";
    workspaceManifest(root, "ws-alpha");
    workspaceIssue(root, "ws-alpha", storyId);
    const backlogPath = join(root, "backlog", "index.md");
    const runtimeRoot = join(root, "runtime");
    const leasePath = join(runtimeRoot, "locks", "leases");
    mkdirSync(join(root, "backlog"), { recursive: true });
    writeFileSync(
      backlogPath,
      `| Story | Description | Status |\n|---|---|---|\n| ${storyId} | Human-owned story | 📋 Todo |\n`,
    );
    const claimedAt = Date.now();
    expect(backlogClaimCommand([storyId, "--workspace", "ws-alpha"], {
      nowMs: () => claimedAt,
      resolveTarget: () => target("ws-alpha", root),
    })).toBe(0);
    writeFileSync(backlogPath, readFileSync(backlogPath, "utf8").replace("🔨 In Progress", "📋 Todo"));
    const paths: RunnerPaths = {
      eventsPath: join(runtimeRoot, "events.ndjson"),
      runsPath: join(runtimeRoot, "runs.jsonl"),
      alertsPath: join(runtimeRoot, "alerts.log"),
      lockPath: join(runtimeRoot, "inner.lock"),
      heartbeatPath: join(runtimeRoot, "heartbeat"),
      storyLeasePath: leasePath,
      worktreePath: join(runtimeRoot, "worktrees", "cycle-human-lease"),
    };
    const agentSpawn: AgentSpawn = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const ports = nodePorts({
      repoCwd: root,
      paths,
      skillBody: "BUILD STORY",
      routeDeps: { readSlot: () => ({ agent: "claude" }), firstInstalled: () => "claude" },
      agentSpawn,
      backlogPath,
    });

    const result = await executeSetupCommand({ kind: "pick_story" }, ports, {
      cycleId: "cycle-human-lease",
      branch: "cycle-human-lease",
      loop: "ci",
    });

    expect(result.event).toEqual({ type: "no_story" });
    expect(JSON.parse(readFileSync(leaseRecordPath(leasePath, storyId), "utf8"))).toEqual({
      source: "human",
      claimedAt,
    });
    expect(existsSync(join(runtimeRoot, "story-leases.json"))).toBe(false);
  });

  it("renders loop on help before target resolution or scheduler mutation", async () => {
    const fixture = schedulerDeps({}, () => {
      throw new Error("help must not resolve a target");
    });
    let stdout = "";
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error capture-only
    process.stdout.write = (chunk: string | Uint8Array): boolean => (stdout += String(chunk), true);
    try {
      expect(await loopOnCommand(["--help"], fixture.deps)).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(stdout).toBe(`${LOOP_ON_USAGE}\n`);
    expect(stdout).toContain("--workspace <id|path>");
  });

  it("derives disjoint runtime, event, lock and pause paths from immutable Workspace identity", () => {
    const alpha = workspaceSchedulerPaths({ workspaceId: "ws-alpha", workspaceRoot: workspaceRoot("alpha") });
    const beta = workspaceSchedulerPaths({ workspaceId: "ws-beta", workspaceRoot: workspaceRoot("beta") });

    expect(alpha).toMatchObject({
      workspaceId: "ws-alpha",
      runtimeRoot: join(alpha.workspaceRoot, "runtime"),
      eventsPath: join(alpha.workspaceRoot, "runtime", "events.ndjson"),
      runsPath: join(alpha.workspaceRoot, "runtime", "runs.jsonl"),
      cycleLockPath: join(alpha.workspaceRoot, "runtime", "locks", "cycle.lock"),
      pauseMarkerPath: join(alpha.workspaceRoot, "runtime", "PAUSE-ws-alpha"),
    });
    const betaValues = new Set(Object.values(beta));
    expect(Object.values(alpha).some((value) => betaValues.has(value))).toBe(false);
  });

  it("generates a Workspace runner that binds run-once to one target and never writes repo-local .roll state", () => {
    const root = workspaceRoot("runner");
    const script = buildLoopRunnerScript({
      projectPath: root,
      slug: "ws-alpha",
      workspaceId: "ws-alpha",
      runtimeRoot: join(root, "runtime"),
      activeStart: 0,
      activeEnd: 24,
      rollBin: "/tmp/roll",
    });

    expect(script).toContain(`PROJECT='${root}'`);
    expect(script).toContain(`RT='${join(root, "runtime")}'`);
    expect(script).toContain("export ROLL_WORKSPACE='ws-alpha'");
    expect(script).toContain(`export ROLL_PROJECT_RUNTIME_DIR='${join(root, "runtime")}'`);
    expect(script).toContain(`export ROLL_WORKSPACE_BACKLOG_PATH='${join(root, "backlog", "index.md")}'`);
    expect(script).toContain("loop run-once --workspace 'ws-alpha'");
    expect(script).not.toContain(`${root}/.roll/loop`);
  });

  it("quotes adversarial Workspace and runtime paths without executing shell syntax", () => {
    const root = workspaceRoot("runner-shell-safe");
    const project = join(root, "workspace-$(touch project-dollar)-`touch project-tick`-'\"");
    const runtime = join(root, "runtime-$(touch runtime-dollar)-`touch runtime-tick`-'\"");
    mkdirSync(project, { recursive: true });
    const runner = join(root, "runner.sh");
    writeFileSync(runner, buildLoopRunnerScript({
      projectPath: project,
      slug: "ws-alpha",
      workspaceId: "ws-alpha",
      runtimeRoot: runtime,
      activeStart: 0,
      activeEnd: 24,
      rollBin: "/usr/bin/true",
    }));

    execFileSync("/bin/bash", [runner], {
      cwd: root,
      env: { ...process.env, ROLL_LOOP_FORCE: "1", ROLL_TMUX_BIN: "/usr/bin/false" },
    });

    expect(existsSync(join(runtime, "cron.log"))).toBe(true);
    expect(existsSync(join(root, "project-dollar"))).toBe(false);
    expect(existsSync(join(root, "project-tick"))).toBe(false);
    expect(existsSync(join(root, "runtime-dollar"))).toBe(false);
    expect(existsSync(join(root, "runtime-tick"))).toBe(false);
  });

  it("installs independent scheduler identities and only mutates the selected Workspace", async () => {
    const alpha = workspaceRoot("alpha-on");
    const beta = workspaceRoot("beta-on");
    const roots = { "ws-alpha": alpha, "ws-beta": beta };
    const fixture = schedulerDeps(roots, (args) => {
      const id = args[args.indexOf("--workspace") + 1] ?? "";
      return target(id, roots[id as keyof typeof roots] ?? "");
    });

    expect(await loopOnCommand(["--workspace", "ws-alpha"], fixture.deps)).toBe(0);
    expect(await loopOnCommand(["--workspace", "ws-beta"], fixture.deps)).toBe(0);

    expect(fixture.calls).toContainEqual(expect.stringContaining("com.roll.loop.ws-alpha"));
    expect(fixture.calls).toContainEqual(expect.stringContaining("com.roll.loop.ws-beta"));
    expect(readFileSync(join(fixture.shared, "loop", "run-ws-alpha.sh"), "utf8")).toContain(
      `ROLL_PROJECT_RUNTIME_DIR='${join(alpha, "runtime")}'`,
    );
    expect(readFileSync(join(fixture.shared, "loop", "run-ws-beta.sh"), "utf8")).toContain(
      `ROLL_PROJECT_RUNTIME_DIR='${join(beta, "runtime")}'`,
    );
  });

  it("atomically wakes a dormant Workspace without leaving an armed dormant marker", async () => {
    const root = workspaceRoot("dormant-on");
    const paths = workspaceSchedulerPaths({ workspaceId: "ws-alpha", workspaceRoot: root });
    mkdirSync(paths.runtimeRoot, { recursive: true });
    writeDormantMarker(paths.dormantMarkerPath, { since: "2026-07-21T00:00:00Z", reason: "idle" });
    const fixture = schedulerDeps({ "ws-alpha": root }, () => target("ws-alpha", root));

    expect(await loopOnCommand(["--workspace", "ws-alpha"], fixture.deps)).toBe(0);

    expect(existsSync(paths.dormantMarkerPath)).toBe(false);
    expect(existsSync(join(paths.runtimeRoot, ".waking-ws-alpha"))).toBe(false);
    expect(readFileSync(paths.eventsPath, "utf8")).toContain('"type":"loop:woke"');
    expect(fixture.calls).toContain("isArmed com.roll.loop.ws-alpha");
  });

  it("recovers an orphan Workspace wake claim and records the wake before cleanup", async () => {
    const root = workspaceRoot("orphan-waking-on");
    const paths = workspaceSchedulerPaths({ workspaceId: "ws-alpha", workspaceRoot: root });
    mkdirSync(paths.runtimeRoot, { recursive: true });
    writeFileSync(join(paths.runtimeRoot, ".waking-ws-alpha"), "orphan\n");
    const fixture = schedulerDeps({ "ws-alpha": root }, () => target("ws-alpha", root));

    expect(await loopOnCommand(["--workspace", "ws-alpha"], fixture.deps)).toBe(0);

    expect(existsSync(join(paths.runtimeRoot, ".waking-ws-alpha"))).toBe(false);
    expect(readFileSync(paths.eventsPath, "utf8")).toContain('"type":"loop:woke"');
  });

  it("restores Workspace dormancy when scheduler wake fails", async () => {
    const root = workspaceRoot("dormant-on-fail");
    const paths = workspaceSchedulerPaths({ workspaceId: "ws-alpha", workspaceRoot: root });
    mkdirSync(paths.runtimeRoot, { recursive: true });
    writeDormantMarker(paths.dormantMarkerPath, { since: "2026-07-21T00:00:00Z", reason: "idle" });
    const fixture = schedulerDeps({ "ws-alpha": root }, () => target("ws-alpha", root), () => false);
    fixture.deps.scheduler.wake = () => Promise.resolve(false);

    expect(await loopOnCommand(["--workspace", "ws-alpha"], fixture.deps)).toBe(1);

    expect(existsSync(paths.dormantMarkerPath)).toBe(true);
    expect(existsSync(join(paths.runtimeRoot, ".waking-ws-alpha"))).toBe(false);
    expect(existsSync(paths.eventsPath)).toBe(false);
  });

  it("pauses and resumes one Workspace without changing another Workspace runtime", async () => {
    const alpha = workspaceRoot("alpha-pause");
    const beta = workspaceRoot("beta-pause");
    const roots = { "ws-alpha": alpha, "ws-beta": beta };
    const fixture = schedulerDeps(roots, (args) => {
      const id = args[args.indexOf("--workspace") + 1] ?? "";
      return target(id, roots[id as keyof typeof roots] ?? "");
    });
    const alphaPaths = workspaceSchedulerPaths({ workspaceId: "ws-alpha", workspaceRoot: alpha });
    const betaPaths = workspaceSchedulerPaths({ workspaceId: "ws-beta", workspaceRoot: beta });
    mkdirSync(betaPaths.runtimeRoot, { recursive: true });
    writeFileSync(betaPaths.pauseMarkerPath, "unchanged\n", { flag: "a" });

    expect(await loopPauseCommand(["--workspace", "ws-alpha"], fixture.deps)).toBe(0);
    expect(existsSync(alphaPaths.pauseMarkerPath)).toBe(true);
    expect(readFileSync(betaPaths.pauseMarkerPath, "utf8")).toBe("unchanged\n");

    writeFileSync(join(alphaPaths.runtimeRoot, "consecutive-fails"), "3", { flag: "a" });
    expect(await loopResumeCommand(["--workspace", "ws-alpha"], fixture.deps)).toBe(0);
    expect(existsSync(alphaPaths.pauseMarkerPath)).toBe(false);
    expect(readFileSync(join(alphaPaths.runtimeRoot, "consecutive-fails"), "utf8")).toBe("0");
    expect(readFileSync(betaPaths.pauseMarkerPath, "utf8")).toBe("unchanged\n");
  });

  it("renders --all as a read-only aggregate over isolated Workspace state", async () => {
    const alpha = workspaceRoot("alpha-status");
    const beta = workspaceRoot("beta-status");
    const alphaPaths = workspaceSchedulerPaths({ workspaceId: "ws-alpha", workspaceRoot: alpha });
    const betaPaths = workspaceSchedulerPaths({ workspaceId: "ws-beta", workspaceRoot: beta });
    mkdirSync(alphaPaths.runtimeRoot, { recursive: true });
    mkdirSync(betaPaths.runtimeRoot, { recursive: true });
    writeFileSync(alphaPaths.pauseMarkerPath, "paused\n", { flag: "a" });
    writeFileSync(
      join(alphaPaths.runtimeRoot, "events.ndjson"),
      `${JSON.stringify({ type: "workspace:waiting_capacity", workspaceId: "ws-alpha", storyId: "US-A", cycleId: "cycle-a", spawnId: "spawn-a", agent: "codex", model: "gpt", retryAt: 1_800_000_000_000, contenders: ["codex"], suspect: false, ts: 1 })}\n`,
    );
    writeFileSync(
      join(betaPaths.runtimeRoot, "events.ndjson"),
      `${JSON.stringify({ type: "workspace:capacity_acquired", workspaceId: "ws-beta", storyId: "US-B", cycleId: "cycle-b", spawnId: "spawn-b", agent: "claude", model: "sonnet", ts: 1 })}\n`,
    );
    const fixture = schedulerDeps({ "ws-alpha": alpha, "ws-beta": beta }, (_args, operation) => {
      expect(operation).toBe("read");
      return {
        ok: true,
        aggregate: [
          { workspaceId: "ws-alpha", workspaceRoot: alpha, canonicalRoot: alpha, backlogPath: join(alpha, "backlog", "index.md") },
          { workspaceId: "ws-beta", workspaceRoot: beta, canonicalRoot: beta, backlogPath: join(beta, "backlog", "index.md") },
        ],
      };
    }, (label) => !label.includes("beta"));
    let stdout = "";
    const previousLang = process.env["ROLL_LANG"];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error capture-only
    process.stdout.write = (chunk: string | Uint8Array): boolean => (stdout += String(chunk), true);
    try {
      process.env["ROLL_LANG"] = "en";
      expect(await loopWorkspaceStatusCommand(["--all"], fixture.deps)).toBe(0);
      expect(stdout).toContain(`ws-alpha  paused  armed  ${alphaPaths.runtimeRoot}  capacity=waiting agent=codex model=gpt retry=2027-01-15T08:00:00.000Z`);
      expect(stdout).toContain(`ws-beta  active  unarmed  ${betaPaths.runtimeRoot}  capacity=acquired agent=claude model=sonnet`);

      stdout = "";
      process.env["ROLL_LANG"] = "zh";
      expect(await loopWorkspaceStatusCommand(["--all"], fixture.deps)).toBe(0);
      expect(stdout).toContain(`ws-alpha  paused  armed  ${alphaPaths.runtimeRoot}  容量=等待 agent=codex model=gpt retry=2027-01-15T08:00:00.000Z`);
      expect(stdout).toContain(`ws-beta  active  unarmed  ${betaPaths.runtimeRoot}  容量=已获取 agent=claude model=sonnet`);
    } finally {
      process.stdout.write = original;
      if (previousLang === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = previousLang;
    }

    expect(fixture.calls).toEqual([
      "isArmed com.roll.loop.ws-alpha",
      "isArmed com.roll.loop.ws-beta",
      "isArmed com.roll.loop.ws-alpha",
      "isArmed com.roll.loop.ws-beta",
    ]);
  });

  it("binds loop go and its tmux worker to the selected Workspace runtime and backlog", async () => {
    const root = workspaceRoot("go");
    mkdirSync(join(root, "backlog"), { recursive: true });
    writeFileSync(
      join(root, "backlog", "index.md"),
      "| Story | Description | Status |\n|---|---|---|\n| US-1 | one | 📋 Todo |\n",
    );
    let started: StartTmuxInput | undefined;
    const deps: LoopGoDeps = {
      identity: () => Promise.reject(new Error("legacy identity must not be used")),
      resolveTarget: () => target("ws-alpha", root),
      pid: () => 1,
      nowSec: () => 1,
      nowIso: () => "2026-07-21T00:00:00Z",
      hasTmux: () => true,
      startTmux: (input) => (started = input, true),
      runOnce: () => Promise.resolve(0),
    };

    expect(await loopGoCommand(["--workspace", "ws-alpha"], deps)).toBe(0);
    expect(started).toMatchObject({
      projectPath: root,
      slug: "ws-alpha",
      workspaceId: "ws-alpha",
      runtimeRoot: join(root, "runtime"),
      backlogPath: join(root, "backlog", "index.md"),
    });
    const commands = planGoTmuxCommands(started!, { sessionExists: false, watchWindowExists: false });
    const worker = commands.at(-1)?.at(-1) ?? "";
    expect(worker).toContain("ROLL_WORKSPACE='ws-alpha'");
    expect(worker).toContain(`ROLL_PROJECT_RUNTIME_DIR='${join(root, "runtime")}'`);
    expect(worker).toContain(`ROLL_WORKSPACE_BACKLOG_PATH='${join(root, "backlog", "index.md")}'`);
  });

  it("resolves run-once dry-run from Workspace identity without requiring a repository-local Roll root", async () => {
    const root = workspaceRoot("run-once");
    const rollHome = workspaceRoot("run-once-home");
    workspaceManifest(root, "ws-alpha");
    mkdirSync(join(root, "backlog"), { recursive: true });
    writeFileSync(join(root, "backlog", "index.md"), "| Story | Description | Status |\n|---|---|---|\n");
    const registry = new WorkspaceRegistry({ rollHome, now: () => 1 });
    registry.register({ workspaceId: "ws-alpha", root });
    registry.activate("ws-alpha");
    const savedRollHome = process.env["ROLL_HOME"];
    const savedWorkspace = process.env["ROLL_WORKSPACE"];
    const savedMainProject = process.env["ROLL_MAIN_PROJECT"];
    const savedRuntime = process.env["ROLL_PROJECT_RUNTIME_DIR"];
    let stdout = "";
    const original = process.stdout.write.bind(process.stdout);
    process.env["ROLL_HOME"] = rollHome;
    delete process.env["ROLL_WORKSPACE"];
    delete process.env["ROLL_MAIN_PROJECT"];
    delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
    // @ts-expect-error capture-only
    process.stdout.write = (chunk: string | Uint8Array): boolean => (stdout += String(chunk), true);
    try {
      expect(await loopRunOnceCommand(["--dry-run", "--workspace", "ws-alpha"])).toBe(0);
    } finally {
      process.stdout.write = original;
      if (savedRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = savedRollHome;
      if (savedWorkspace === undefined) delete process.env["ROLL_WORKSPACE"];
      else process.env["ROLL_WORKSPACE"] = savedWorkspace;
      if (savedMainProject === undefined) delete process.env["ROLL_MAIN_PROJECT"];
      else process.env["ROLL_MAIN_PROJECT"] = savedMainProject;
      if (savedRuntime === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
      else process.env["ROLL_PROJECT_RUNTIME_DIR"] = savedRuntime;
      delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
      delete process.env["ROLL_WORKSPACE_BACKLOG_PATH"];
    }
    expect(stdout).toContain("# project: ws-alpha");
    expect(existsSync(join(root, ".roll"))).toBe(false);
    expect(existsSync(join(root, "runtime"))).toBe(false);
  });

  it("runs one production Workspace Story without invoking any root repository preflight", async () => {
    const root = workspaceRoot("run-once-production");
    const rollHome = workspaceRoot("run-once-production-home");
    const storyId = "US-WS-016";
    workspaceManifest(root, "ws-alpha");
    const issue = workspaceIssue(root, "ws-alpha", storyId);
    const backlogPath = join(root, "backlog", "index.md");
    const legacyBacklogPath = join(root, ".roll", "backlog.md");
    mkdirSync(join(root, "backlog"), { recursive: true });
    mkdirSync(join(root, ".roll"), { recursive: true });
    writeFileSync(
      backlogPath,
      `| Story | Description | Status |\n|---|---|---|\n| ${storyId} | Workspace production story | 📋 Todo |\n`,
    );
    writeFileSync(
      legacyBacklogPath,
      "| Story | Description | Status |\n|---|---|---|\n| LEGACY-1 | Legacy decoy | 📋 Todo |\n",
    );
    writeFileSync(join(root, ".roll", "policy.yaml"), "loop_safety:\n  skip_network_check: true\n");
    const registry = new WorkspaceRegistry({ rollHome, now: () => 1 });
    registry.register({ workspaceId: "ws-alpha", root });
    registry.activate("ws-alpha");

    let builderSpawned = false;
    let leaseObserved = false;
    const humanClaimedAt = Date.now();
    const agentSpawn: AgentSpawn = vi.fn(async (_agent, options) => {
      if (options.purpose === "builder") {
        builderSpawned = true;
        expect(options.cwd).toBe(realpathSync(issue.issueRoot));
        expect(readFileSync(backlogPath, "utf8")).toContain(
          `${storyId} | Workspace production story | 🔨 In Progress`,
        );
        const leasePath = join(root, "runtime", "locks", "leases");
        const recordPath = leaseRecordPath(leasePath, storyId);
        leaseObserved = existsSync(recordPath) && JSON.parse(readFileSync(recordPath, "utf8")).source === "cycle";
        mkdirSync(leasePath, { recursive: true });
        writeFileSync(recordPath, `${JSON.stringify({ source: "human", claimedAt: humanClaimedAt }, null, 2)}\n`);
      }
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    });
    agentSpawn.supportedPurposes = ["builder", "test_author", "implementer", "attacker"];
    const repoPushable = vi.fn(() => ({ ok: true as const, reason: "ok" as const, detail: "" }));
    const branchCanary = vi.fn(() => false);
    const workspaceBranchCanary = vi.fn(() => false);
    const reconcile = vi.fn(async () => undefined);
    const backfill = vi.fn(async () => []);
    const saved = new Map<string, string | undefined>();
    const envKeys = [
      "ROLL_HOME",
      "ROLL_WORKSPACE",
      "ROLL_MAIN_PROJECT",
      "ROLL_PROJECT_RUNTIME_DIR",
      "ROLL_WORKSPACE_BACKLOG_PATH",
      "ROLL_LOOP_NO_AUTO_RECOVER",
    ] as const;
    for (const key of envKeys) saved.set(key, process.env[key]);
    process.env["ROLL_HOME"] = rollHome;
    process.env["ROLL_LOOP_NO_AUTO_RECOVER"] = "1";
    delete process.env["ROLL_WORKSPACE"];
    delete process.env["ROLL_MAIN_PROJECT"];
    delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
    delete process.env["ROLL_WORKSPACE_BACKLOG_PATH"];
    try {
      expect(await loopRunOnceCommand(["--workspace", "ws-alpha"], {
        requireNetwork: async () => ({ ok: true, recovered: false }),
        checkRepoPushable: repoPushable,
        readSkillBody: () => "BUILD STORY",
        buildRouteDeps: () => ({ readSlot: () => ({ agent: "claude" }), firstInstalled: () => "claude" }),
        agentSpawn,
        warnIfBinaryStale: async () => undefined,
        branchCanaryTrips: branchCanary,
        workspaceBranchCanaryTrips: workspaceBranchCanary,
        runReconcileTick: reconcile,
        backfillMergedRuns: backfill,
      })).toBe(1);
    } finally {
      for (const key of envKeys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(builderSpawned).toBe(true);
    expect(leaseObserved).toBe(true);
    expect(existsSync(join(issue.issueRoot, "evidence"))).toBe(true);
    expect(existsSync(join(root, ".roll", "features", "workspace-orchestration", storyId))).toBe(false);
    expect(JSON.parse(readFileSync(leaseRecordPath(join(root, "runtime", "locks", "leases"), storyId), "utf8"))).toEqual({
      source: "human",
      claimedAt: humanClaimedAt,
    });
    expect(existsSync(join(root, "runtime", "story-leases.json"))).toBe(false);
    expect(existsSync(join(root, ".roll", "loop", "story-leases.json"))).toBe(false);
    expect(readFileSync(legacyBacklogPath, "utf8")).toContain("LEGACY-1 | Legacy decoy | 📋 Todo");
    expect(workspaceBranchCanary).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-alpha", workspaceRoot: root }),
    );
    for (const rootGit of [repoPushable, branchCanary, reconcile, backfill]) {
      expect(rootGit).not.toHaveBeenCalled();
    }
  });

  it("rejects an implicit repository-local run-once cwd with migration_required", async () => {
    const legacy = workspaceRoot("legacy-run-once");
    const rollHome = workspaceRoot("legacy-home");
    execFileSync("git", ["init", "--quiet"], { cwd: legacy });
    mkdirSync(join(legacy, ".roll"));
    writeFileSync(join(legacy, ".roll", "backlog.md"), "legacy\n");
    const savedCwd = process.cwd();
    const savedRollHome = process.env["ROLL_HOME"];
    const savedWorkspace = process.env["ROLL_WORKSPACE"];
    let stderr = "";
    const original = process.stderr.write.bind(process.stderr);
    process.chdir(legacy);
    process.env["ROLL_HOME"] = rollHome;
    delete process.env["ROLL_WORKSPACE"];
    // @ts-expect-error capture-only
    process.stderr.write = (chunk: string | Uint8Array): boolean => (stderr += String(chunk), true);
    try {
      expect(await loopRunOnceCommand(["--dry-run"])).toBe(1);
    } finally {
      process.stderr.write = original;
      process.chdir(savedCwd);
      if (savedRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = savedRollHome;
      if (savedWorkspace === undefined) delete process.env["ROLL_WORKSPACE"];
      else process.env["ROLL_WORKSPACE"] = savedWorkspace;
    }
    expect(stderr).toContain("migration_required");
    expect(stderr).toContain("roll workspace migrate --from");
  });
});
