import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  repositoryIdFromRemote,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  type CycleRepositoryExecutionContext,
  type RepositoryExecutionContext,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import {
  BUILD_HEARTBEAT_GAP_MS,
  claimStoryLease,
  cycleStep,
  deriveWorkspaceExecutionAuthorities,
  initialCycleState,
  nodeExecPort,
  readLeases,
  type RouteDeps,
} from "@roll/core";
import {
  REPOSITORY_CONTEXT_MAX_CHARS,
  buildRepositoryContextMap,
} from "../src/runner/project-map.js";
import {
  nodePorts,
  type RunnerPaths,
} from "../src/runner/index.js";
import { createRepositoryPorts } from "../src/runner/node-ports.js";
import type { AgentSpawn } from "../src/runner/agent-spawn.js";
import type { RepositoryPortAdapters } from "../src/runner/ports.js";
import { applyRepositoryBuilderContext } from "../src/runner/spawn-agent-handler.js";
import { executeTerminalCommand } from "../src/runner/terminal-handlers.js";
import { executeCaptureFactsCommand } from "../src/runner/capture-facts-handler.js";
import {
  observeWritableRepositories,
  observeWritableRepositoryCommitCount,
} from "../src/runner/repository-observation.js";
import { startRepositoryCycleObserver } from "../src/runner/spawn-observers.js";
import { runCycleOnce } from "../src/runner/run-cycle.js";

function repository(
  repoId: string,
  alias: string,
  access: "read" | "write",
): RepositoryExecutionContext {
  return {
    repoId,
    alias,
    access,
    requiredDelivery: access === "write",
    worktreePath: `/workspace/issues/US-WS-010/${alias}`,
    baseSha: `${alias}-base`,
    headSha: `${alias}-head`,
    commands: {
      test: [`pnpm --dir ${alias} test`],
      integration: [`pnpm --dir ${alias} test:integration`],
    },
  };
}

const writable = repository("repo-111111111111", "sot1", "write");
const readonly = repository("repo-222222222222", "reference", "read");
const secondary = repository("repo-333333333333", "sot2", "write");
const execution: CycleRepositoryExecutionContext = {
  workspaceId: "ws-20260717001",
  issueRoot: "/workspace/issues/US-WS-010",
  repositories: {
    [writable.repoId]: writable,
    [readonly.repoId]: readonly,
  },
};

const paths: RunnerPaths = {
  eventsPath: "/runtime/events.ndjson",
  runsPath: "/runtime/runs.jsonl",
  alertsPath: "/runtime/alerts.log",
  lockPath: "/runtime/lock",
  heartbeatPath: "/runtime/heartbeat",
  worktreePath: "/legacy/single-repo-worktree",
};
const routeDeps: RouteDeps = {
  readSlot: () => ({ agent: "claude" }),
  firstInstalled: () => "claude",
};

function fakeSpawn(): AgentSpawn {
  const spawn: AgentSpawn = vi.fn(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  }));
  spawn.supportedPurposes = ["builder", "test_author", "implementer", "attacker"];
  return spawn;
}

function productionWorkspaceFixture(): { root: string; storyId: string; repoId: string; headSha: string } {
  const root = mkdtempSync(join(tmpdir(), "roll-us-ws-010-context-"));
  const storyId = "US-WS-010";
  const remote = "https://github.com/example/sot1.git";
  const parsedRepoId = repositoryIdFromRemote(remote);
  if (!parsedRepoId.ok) throw new Error("fixture remote must be canonicalizable");
  const repoId = parsedRepoId.value;
  const issueRoot = join(root, "issues", storyId);
  const worktreePath = join(issueRoot, "sot1");
  mkdirSync(worktreePath, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.email", "roll-test@example.invalid"], { cwd: worktreePath });
  writeFileSync(join(worktreePath, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: worktreePath });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: worktreePath });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: "roll.workspace/v1",
    workspaceId: "ws-20260717001",
    displayName: "US-WS-010 fixture",
    requirements: [],
    repositories: [{
      schema: "roll.repository-binding/v1",
      repoId,
      alias: "sot1",
      remote,
      integrationBranch: "main",
      provider: "github",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  }, null, 2)}\n`);
  writeFileSync(join(issueRoot, "manifest.json"), `${JSON.stringify({
    schema: "roll.issue/v1",
    workspaceId: "ws-20260717001",
    storyId,
    requirements: [],
    repositories: [{
      repoId,
      alias: "sot1",
      access: "write",
      requiredDelivery: true,
      noChangePolicy: "changes_required",
    }],
  }, null, 2)}\n`);
  writeFileSync(join(issueRoot, "events.jsonl"), `${JSON.stringify({
    type: "issue:repository_bound",
    workspaceId: "ws-20260717001",
    storyId,
    alias: "sot1",
    repoId,
    access: "write",
    baseSha: headSha,
    worktreePath,
    workBranch: "story/US-WS-010",
    ts: 1,
  })}\n`);
  return { root, storyId, repoId, headSha };
}

function productionMultiWorkspaceFixture(): {
  root: string;
  issueRoot: string;
  storyId: string;
  repositories: readonly { repoId: string; alias: string; path: string; baseSha: string }[];
} {
  const root = mkdtempSync(join(tmpdir(), "roll-us-ws-010-production-chain-"));
  const storyId = "US-WS-010";
  const issueRoot = join(root, "issues", storyId);
  mkdirSync(issueRoot, { recursive: true });
  const repositories = ["sot1", "sot2"].map((alias) => {
    const remote = `https://github.com/example/${alias}.git`;
    const parsedRepoId = repositoryIdFromRemote(remote);
    if (!parsedRepoId.ok) throw new Error("fixture remote must be canonicalizable");
    const path = join(issueRoot, alias);
    mkdirSync(path, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: path });
    execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: path });
    execFileSync("git", ["config", "user.email", "roll-test@example.invalid"], { cwd: path });
    writeFileSync(join(path, "README.md"), `${alias}\n`);
    execFileSync("git", ["add", "README.md"], { cwd: path });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: path });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
    return { repoId: parsedRepoId.value, alias, path, baseSha, remote };
  });
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: "roll.workspace/v1",
    workspaceId: "ws-production-chain",
    displayName: "US-WS-010 production chain",
    requirements: [],
    repositories: repositories.map((repo) => ({
      schema: "roll.repository-binding/v1",
      repoId: repo.repoId,
      alias: repo.alias,
      remote: repo.remote,
      integrationBranch: "main",
      provider: "github",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    })),
  }, null, 2)}\n`);
  writeFileSync(join(issueRoot, "manifest.json"), `${JSON.stringify({
    schema: "roll.issue/v1",
    workspaceId: "ws-production-chain",
    storyId,
    requirements: [],
    repositories: repositories.map((repo) => ({
      repoId: repo.repoId,
      alias: repo.alias,
      access: "write",
      requiredDelivery: true,
      noChangePolicy: "changes_required",
    })),
  }, null, 2)}\n`);
  writeFileSync(join(issueRoot, "events.jsonl"), repositories.map((repo) => JSON.stringify({
    type: "issue:repository_bound",
    workspaceId: "ws-production-chain",
    storyId,
    alias: repo.alias,
    repoId: repo.repoId,
    access: "write",
    baseSha: repo.baseSha,
    worktreePath: repo.path,
    workBranch: `story/${storyId}/${repo.alias}`,
    ts: 1,
  })).join("\n") + "\n");
  return { root, issueRoot, storyId, repositories };
}

function workspaceExecutionFor(root: string): WorkspaceExecutionContextV1 {
  const canonicalRoot = realpathSync(root);
  const manifest = JSON.parse(readFileSync(join(canonicalRoot, "workspace.yaml"), "utf8")) as {
    workspaceId: string;
    repositories: WorkspaceExecutionContextV1["bindings"];
  };
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: {
      workspaceId: manifest.workspaceId,
      root: canonicalRoot,
      canonicalRoot,
      lifecycle: "active",
    },
    resolution: { source: "explicit", evidence: [] },
    bindings: manifest.repositories,
    authorities: deriveWorkspaceExecutionAuthorities(canonicalRoot),
  };
}

describe("US-WS-010 repository Builder context", () => {
  it("resolves the production Workspace Issue only after the Story identity is known", async () => {
    const fixture = productionWorkspaceFixture();
    const fixturePaths: RunnerPaths = {
      eventsPath: join(fixture.root, "runtime", "events.ndjson"),
      runsPath: join(fixture.root, "runtime", "runs.jsonl"),
      alertsPath: join(fixture.root, "runtime", "alerts.log"),
      lockPath: join(fixture.root, "runtime", "lock"),
      heartbeatPath: join(fixture.root, "runtime", "heartbeat"),
      worktreePath: join(fixture.root, "legacy-worktree"),
    };
    const ports = nodePorts({
      repoCwd: fixture.root,
      paths: fixturePaths,
      skillBody: "BUILD STORY",
      routeDeps,
      agentSpawn: fakeSpawn(),
    });

    const resolved = await ports.repositories?.resolve(fixture.storyId);

    expect(resolved).toMatchObject({
      workspaceId: "ws-20260717001",
      issueRoot: realpathSync(join(fixture.root, "issues", fixture.storyId)),
      repositories: {
        [fixture.repoId]: {
          repoId: fixture.repoId,
          alias: "sot1",
          access: "write",
          baseSha: fixture.headSha,
          headSha: fixture.headSha,
          commands: { test: [], integration: [] },
        },
      },
    });
    const start = initialCycleState({ cycleId: "cycle-fixture", branch: "cycle-fixture", loop: "ci" });
    const ready = { ...start, phase: "pick" as const, worktreeReady: true };
    const stepped = cycleStep(ready, {
      type: "story_picked",
      storyId: fixture.storyId,
      repositoryExecution: resolved,
    });
    expect(stepped.state.ctx.repositoryExecution).toEqual(resolved);
  });

  it("routes production repository verification and push through the frozen Workspace tool context", async () => {
    const fixture = productionWorkspaceFixture();
    const fixturePaths: RunnerPaths = {
      eventsPath: join(fixture.root, "runtime", "events.ndjson"),
      runsPath: join(fixture.root, "runtime", "runs.jsonl"),
      alertsPath: join(fixture.root, "runtime", "alerts.log"),
      lockPath: join(fixture.root, "runtime", "lock"),
      heartbeatPath: join(fixture.root, "runtime", "heartbeat"),
      worktreePath: join(fixture.root, "legacy-worktree"),
    };
    const ports = nodePorts({
      repoCwd: fixture.root,
      paths: fixturePaths,
      skillBody: "BUILD STORY",
      routeDeps,
      agentSpawn: fakeSpawn(),
    });
    const resolved = await ports.repositories?.resolve(fixture.storyId);
    expect(resolved).toBeDefined();
    const ctx = {
      cycleId: "cycle-tool-runtime",
      branch: "story/US-WS-010",
      loop: "ci",
      storyId: fixture.storyId,
      agent: "codex" as const,
      repositoryExecution: resolved,
    };

    const repositories = ports.repositories?.bind(ctx);
    expect(await repositories?.git.commitsAhead(fixture.repoId)).toBe(0);
    expect(await repositories?.git.tcrCount(fixture.repoId)).toBe(0);
    expect(await repositories?.git.recentCommits(fixture.repoId)).toEqual([]);
    expect(await repositories?.git.headSha(fixture.repoId)).toBe(fixture.headSha);
    const verificationScript = join(resolved?.repositories[fixture.repoId]?.worktreePath ?? "", "verify.mjs");
    writeFileSync(verificationScript, "process.stdout.write('verified')\n", "utf8");
    const verification = await repositories?.verification.runRepository(
      fixture.repoId,
      ["node", "verify.mjs"],
      { TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz" },
    );
    const push = await repositories?.git.push(fixture.repoId, "story/US-WS-010");

    expect(verification).toEqual({ exitCode: 0, stdout: "verified", stderr: "" });
    expect(push?.code).not.toBe(0);
    const toolEventsPath = join(fixture.root, "runtime", "events", "tools.ndjson");
    const events = readFileSync(toolEventsPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const invocations = events.filter((event) => event["type"] === "tool:invoke");
    expect(invocations.filter((event) => (
      event["invocation"] as Record<string, unknown> | undefined
    )?.["toolId"] === "runner.git.query")).toHaveLength(4);
    expect(invocations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool:invoke",
        cycleId: ctx.cycleId,
        invocation: expect.objectContaining({
          toolId: "bash",
          repoId: fixture.repoId,
          context: expect.objectContaining({
            workspace: expect.objectContaining({ workspaceId: resolved?.workspaceId }),
            issue: expect.objectContaining({ storyId: fixture.storyId }),
          }),
        }),
      }),
      expect.objectContaining({
        type: "tool:invoke",
        cycleId: ctx.cycleId,
        invocation: expect.objectContaining({ toolId: "git.push", repoId: fixture.repoId }),
      }),
    ]));
    expect(readFileSync(toolEventsPath, "utf8")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });

  it("reuses the persisted Story integration command when resolving a later Cycle", async () => {
    const fixture = productionWorkspaceFixture();
    const manifestPath = join(fixture.root, "issues", fixture.storyId, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({
      ...manifest,
      integrationAcceptance: { command: ["./verify-sot-contract.sh"] },
    }, null, 2)}\n`);
    const ports = nodePorts({
      repoCwd: fixture.root,
      paths: {
        eventsPath: join(fixture.root, "runtime", "events.ndjson"),
        runsPath: join(fixture.root, "runtime", "runs.jsonl"),
        alertsPath: join(fixture.root, "runtime", "alerts.log"),
        lockPath: join(fixture.root, "runtime", "lock"),
        heartbeatPath: join(fixture.root, "runtime", "heartbeat"),
        worktreePath: join(fixture.root, "legacy-worktree"),
      },
      skillBody: "BUILD STORY",
      routeDeps,
      agentSpawn: fakeSpawn(),
    });

    const resolved = await ports.repositories?.resolve(fixture.storyId);

    expect(resolved?.repositories[fixture.repoId]?.commands.integration).toEqual(["./verify-sot-contract.sh"]);
  });

  it("renders one bounded prompt map with access, worktree and verification commands", () => {
    const rendered = buildRepositoryContextMap(execution);

    expect(rendered.length).toBeLessThanOrEqual(REPOSITORY_CONTEXT_MAX_CHARS);
    expect(rendered).toContain("ws-20260717001");
    expect(rendered).toContain("/workspace/issues/US-WS-010");
    expect(rendered).toContain('"repoId": "repo-111111111111"');
    expect(rendered).toContain('"access": "read"');
    expect(rendered).toContain("pnpm --dir sot1 test");
    expect(rendered).toContain("pnpm --dir reference test:integration");
    expect(rendered).toContain("read-only repositories are context-only");
  });

  it("fails loud instead of truncating an oversized repository contract", () => {
    const oversized: CycleRepositoryExecutionContext = {
      ...execution,
      repositories: {
        [writable.repoId]: {
          ...writable,
          commands: { test: ["x".repeat(REPOSITORY_CONTEXT_MAX_CHARS)], integration: [] },
        },
      },
    };

    expect(() => buildRepositoryContextMap(oversized)).toThrow("repository_context_too_large");
  });

  it("rejects a repository map that is not bound to a Workspace execution context", () => {
    expect(() => applyRepositoryBuilderContext({
      cycleId: "cycle-fixture",
      branch: "cycle-fixture",
      loop: "ci",
      repositoryExecution: execution,
      workspaceContextScope: "legacy_migration_only",
    }, {
      purpose: "builder",
      cwd: paths.worktreePath,
      skillBody: "BUILD STORY",
    })).toThrow("missing_execution_context");
  });

  it("binds Git/provider adapters by repoId and rejects read-only publish before the adapter runs", async () => {
    const commitsAhead = vi.fn(async (_repository: RepositoryExecutionContext) => 2);
    const push = vi.fn(async (_repository: RepositoryExecutionContext, _branch: string) => ({ code: 0 }));
    const repoSlug = vi.fn(async (_repository: RepositoryExecutionContext) => "owner/sot1");
    const adapters: RepositoryPortAdapters = {
      git: {
        commitsAhead,
        tcrCount: vi.fn(async () => 1),
        recentCommits: vi.fn(async () => []),
        dirty: vi.fn(async () => false),
        push,
      },
      provider: {
        repoSlug,
        prState: vi.fn(async () => "OPEN"),
        prMergeInfo: vi.fn(async () => undefined),
      },
    };
    const repositories = createRepositoryPorts({
      cycleId: "cycle-adapters",
      branch: "cycle-adapters",
      loop: "ci",
      storyId: "US-WS-010",
      repositoryExecution: execution,
    }, adapters);

    expect(await repositories.git.commitsAhead(writable.repoId)).toBe(2);
    expect(commitsAhead).toHaveBeenCalledWith(writable);
    expect(await repositories.provider.repoSlug(writable.repoId)).toBe("owner/sot1");
    expect(repoSlug).toHaveBeenCalledWith(writable);
    await expect(repositories.git.push(readonly.repoId, "story-branch")).rejects.toThrow(
      "read_only_repository",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("aggregates strict observations from writable repoIds only", async () => {
    const ctx = {
      cycleId: "cycle-observe",
      branch: "cycle-observe",
      loop: "ci" as const,
      storyId: "US-WS-010",
      repositoryExecution: {
        ...execution,
        repositories: {
          [secondary.repoId]: secondary,
          [readonly.repoId]: readonly,
          [writable.repoId]: writable,
        },
      },
    };
    const adapters: RepositoryPortAdapters = {
      git: {
        commitsAhead: vi.fn(async (repo) => repo.repoId === writable.repoId ? 1 : 2),
        tcrCount: vi.fn(async () => 1),
        recentCommits: vi.fn(async () => []),
        dirty: vi.fn(async (repo) => repo.repoId === secondary.repoId),
        headSha: vi.fn(async (repo) => repo.repoId === writable.repoId ? "a".repeat(40) : "b".repeat(40)),
        push: vi.fn(async () => ({ code: 0 })),
      },
      verification: {
        runRepository: vi.fn(async () => ({ exitCode: 0, stdout: "1 passed", stderr: "" })),
        runIntegration: vi.fn(async () => ({ exitCode: 0, stdout: "integration passed", stderr: "" })),
      },
      provider: {
        repoSlug: vi.fn(async () => undefined),
        prState: vi.fn(async () => "UNKNOWN"),
        prMergeInfo: vi.fn(async () => undefined),
      },
    };

    const observed = await observeWritableRepositories(ctx, createRepositoryPorts(ctx, adapters));

    expect(observed).toEqual({
      legs: [
        { repoId: writable.repoId, commitsAhead: 1, tcrCount: 1, worktreeDirty: false },
        { repoId: secondary.repoId, commitsAhead: 2, tcrCount: 1, worktreeDirty: true },
      ],
      commitsAhead: 3,
      tcrCount: 2,
      worktreeDirty: true,
    });
    expect(adapters.git.commitsAhead).toHaveBeenCalledTimes(2);
    expect(adapters.git.commitsAhead).not.toHaveBeenCalledWith(readonly);
  });

  it("fails loud when any writable repository observation is unknown", async () => {
    const ctx = {
      cycleId: "cycle-observe-fail",
      branch: "cycle-observe-fail",
      loop: "ci" as const,
      storyId: "US-WS-010",
      repositoryExecution: execution,
    };
    const adapters: RepositoryPortAdapters = {
      git: {
        commitsAhead: vi.fn(async () => 1),
        tcrCount: vi.fn(async () => { throw new Error("missing base"); }),
        recentCommits: vi.fn(async () => []),
        dirty: vi.fn(async () => false),
        push: vi.fn(async () => ({ code: 0 })),
      },
      provider: {
        repoSlug: vi.fn(async () => undefined),
        prState: vi.fn(async () => "UNKNOWN"),
        prMergeInfo: vi.fn(async () => undefined),
      },
    };

    await expect(
      observeWritableRepositories(ctx, createRepositoryPorts(ctx, adapters)),
    ).rejects.toThrow(`repository_observation_failed: ${writable.repoId}: tcr_count`);
  });

  it("observes writable repository commits without treating the Issue root as a Git repository", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const root = mkdtempSync(join(tmpdir(), "roll-us-ws-010-observer-"));
    const issueRoot = join(root, "issues", "US-WS-010");
    const runtimeRoot = join(root, "runtime");
    mkdirSync(issueRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    const ctx = {
      cycleId: "cycle-observer",
      branch: "cycle-observer",
      loop: "ci" as const,
      storyId: "US-WS-010",
      repositoryExecution: {
        workspaceId: execution.workspaceId,
        issueRoot,
        repositories: {
          [secondary.repoId]: secondary,
          [readonly.repoId]: readonly,
          [writable.repoId]: writable,
        },
      },
    };
    let changed = false;
    const recentCommits = vi.fn(async (repo: RepositoryExecutionContext) => changed
      ? [{ hash: `${repo.repoId}-commit`, message: "tcr: observed", tsSec: 2 }]
      : []);
    const adapters: RepositoryPortAdapters = {
      git: {
        commitsAhead: vi.fn(async () => changed ? 1 : 0),
        tcrCount: vi.fn(async () => changed ? 1 : 0),
        recentCommits,
        dirty: vi.fn(async () => false),
        push: vi.fn(async () => ({ code: 0 })),
      },
      provider: {
        repoSlug: vi.fn(async () => undefined),
        prState: vi.fn(async () => "UNKNOWN"),
        prMergeInfo: vi.fn(async () => undefined),
      },
    };
    const fixturePaths: RunnerPaths = {
      eventsPath: join(runtimeRoot, "events.ndjson"),
      runsPath: join(runtimeRoot, "runs.jsonl"),
      alertsPath: join(runtimeRoot, "alerts.log"),
      lockPath: join(runtimeRoot, "lock"),
      heartbeatPath: join(runtimeRoot, "heartbeat"),
      worktreePath: join(root, "legacy-worktree"),
    };
    const basePorts = nodePorts({
      repoCwd: root,
      paths: fixturePaths,
      skillBody: "BUILD STORY",
      routeDeps,
      agentSpawn: fakeSpawn(),
    });
    const bound = createRepositoryPorts(ctx, adapters);
    try {
      const observer = await startRepositoryCycleObserver({
        ...basePorts,
        repositories: { resolve: async () => ctx.repositoryExecution, bind: () => bound },
      }, ctx);

      changed = true;
      expect(await observeWritableRepositoryCommitCount(ctx, bound)).toBe(2);
      now.mockReturnValue(1_000 + BUILD_HEARTBEAT_GAP_MS);
      await observer.stop();
    } finally {
      now.mockRestore();
    }

    expect(recentCommits).toHaveBeenCalledTimes(4);
    expect(recentCommits).not.toHaveBeenCalledWith(readonly);
    const issueEvents = readFileSync(join(issueRoot, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(issueEvents.filter((event) => event["type"] === "cycle:tcr")).toEqual([
      expect.objectContaining({
        workspaceId: execution.workspaceId,
        storyId: ctx.storyId,
        cycleId: ctx.cycleId,
        repoId: writable.repoId,
        commitHash: `${writable.repoId}-commit`,
      }),
      expect.objectContaining({
        workspaceId: execution.workspaceId,
        storyId: ctx.storyId,
        cycleId: ctx.cycleId,
        repoId: secondary.repoId,
        commitHash: `${secondary.repoId}-commit`,
      }),
    ]);
    const storyEvents = readFileSync(fixturePaths.eventsPath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(storyEvents.filter((event) => event["type"] === "cycle:phase")).toHaveLength(1);
    expect(storyEvents.filter((event) => event["type"] === "cycle:first_edit")).toEqual([
      expect.objectContaining({
        cycleId: ctx.cycleId,
        commitHash: `${writable.repoId}-commit`,
      }),
    ]);
    expect(storyEvents.filter((event) => event["type"] === "cycle:tcr")).toHaveLength(0);
    expect(storyEvents.filter((event) => event["type"] === "cycle:stdout")).toHaveLength(0);
    expect(existsSync(join(issueRoot, ".git"))).toBe(false);
  });

  it("captures strict aggregate facts without probing the Issue root as Git", async () => {
    const root = mkdtempSync(join(tmpdir(), "roll-us-ws-010-capture-"));
    const issueRoot = join(root, "issues", "US-WS-010");
    const runtimeRoot = join(root, "runtime");
    mkdirSync(issueRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    const ctx = {
      cycleId: "cycle-capture",
      branch: "cycle-capture",
      loop: "ci" as const,
      storyId: "US-WS-010",
      agent: "claude",
      repositoryExecution: {
        workspaceId: execution.workspaceId,
        issueRoot,
        repositories: {
          [secondary.repoId]: secondary,
          [readonly.repoId]: readonly,
          [writable.repoId]: writable,
        },
      },
    };
    const adapters: RepositoryPortAdapters = {
      git: {
        commitsAhead: vi.fn(async (repo) => repo.repoId === writable.repoId ? 1 : 2),
        tcrCount: vi.fn(async () => 1),
        recentCommits: vi.fn(async () => []),
        dirty: vi.fn(async (repo) => repo.repoId === secondary.repoId),
        headSha: vi.fn(async (repo) => repo.repoId === writable.repoId ? "a".repeat(40) : "b".repeat(40)),
        push: vi.fn(async () => ({ code: 0 })),
      },
      verification: {
        runRepository: vi.fn(async () => ({ exitCode: 0, stdout: "1 passed", stderr: "" })),
        runIntegration: vi.fn(async () => ({ exitCode: 0, stdout: "integration passed", stderr: "" })),
      },
      provider: {
        repoSlug: vi.fn(async () => undefined),
        prState: vi.fn(async () => "UNKNOWN"),
        prMergeInfo: vi.fn(async () => undefined),
      },
    };
    const fixturePaths: RunnerPaths = {
      eventsPath: join(runtimeRoot, "events.ndjson"),
      runsPath: join(runtimeRoot, "runs.jsonl"),
      alertsPath: join(runtimeRoot, "alerts.log"),
      lockPath: join(runtimeRoot, "lock"),
      heartbeatPath: join(runtimeRoot, "heartbeat"),
      worktreePath: join(root, "legacy-worktree"),
    };
    const basePorts = nodePorts({
      repoCwd: root,
      paths: fixturePaths,
      skillBody: "BUILD STORY",
      routeDeps,
      agentSpawn: fakeSpawn(),
    });
    const bound = createRepositoryPorts(ctx, adapters);
    const ports = {
      ...basePorts,
      repositories: { resolve: async () => ctx.repositoryExecution, bind: () => bound },
    };

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, ports, ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({
        commitsAhead: 3,
        worktreeDirty: true,
        repositoryVerificationPending: true,
      }),
    });
    expect(result.ctxPatch).toMatchObject({
      tcrCount: 2,
      failureClass: "harness",
      rootCauseKey: "harness:repository_verification_failed",
    });
    expect(adapters.git.commitsAhead).not.toHaveBeenCalledWith(readonly);
    const issueEvents = readFileSync(join(issueRoot, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(issueEvents.filter((event) => event["type"] === "repository:capture_observed")).toEqual([
      expect.objectContaining({ repoId: writable.repoId, commitsAhead: 1, tcrCount: 1, worktreeDirty: false }),
      expect.objectContaining({ repoId: secondary.repoId, commitsAhead: 2, tcrCount: 1, worktreeDirty: true }),
    ]);
    expect(issueEvents.filter((event) => event["type"] === "repository:verification")).toHaveLength(2);
    expect(existsSync(join(issueRoot, ".git"))).toBe(false);
  });

  it("runs the production pick, spawn, capture and blocked terminal as one Workspace Story", async () => {
    const fixture = productionMultiWorkspaceFixture();
    const runtimeRoot = join(fixture.root, "runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const fixturePaths: RunnerPaths = {
      eventsPath: join(runtimeRoot, "events.ndjson"),
      runsPath: join(runtimeRoot, "runs.jsonl"),
      alertsPath: join(runtimeRoot, "alerts.log"),
      lockPath: join(runtimeRoot, "lock"),
      heartbeatPath: join(runtimeRoot, "heartbeat"),
      worktreePath: fixture.root,
    };
    writeFileSync(fixturePaths.runsPath, [
      { story_id: fixture.storyId, cycle_id: "prior-built", status: "built" },
      { story_id: fixture.storyId, cycle_id: "prior-orphan", status: "orphan" },
      { story_id: fixture.storyId, cycle_id: "prior-failed", status: "failed" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const spawn = fakeSpawn();
    vi.mocked(spawn).mockImplementation(async (_agent, options) => {
      const selected = fixture.repositories[0];
      if (selected === undefined) throw new Error("missing selected fixture repository");
      expect(options.cwd).toBe(realpathSync(selected.path));
      expect(options.skillBody).toContain(`Selected repository: ${selected.repoId} (${selected.alias})`);
      expect(options.env).toMatchObject({
        ROLL_REPOSITORY_ID: selected.repoId,
        ROLL_REPOSITORY_ALIAS: selected.alias,
      });
      const promptContext = JSON.parse(
        /context-json: (\{.*\})/u.exec(options.skillBody)?.[1] ?? "null",
      ) as WorkspaceExecutionContextV1 | null;
      expect(promptContext).toEqual(options.workspaceExecution);
      expect(options.skillBody).toContain(fixture.repositories[0]?.repoId ?? "missing-repo");
      expect(options.skillBody).toContain(fixture.repositories[1]?.repoId ?? "missing-repo");
      expect(options.writableRoots).toEqual(expect.arrayContaining([
        realpathSync(join(fixture.issueRoot, "artifacts")),
        realpathSync(join(fixture.issueRoot, "evidence")),
        realpathSync(join(fixture.issueRoot, "runtime")),
        realpathSync(fixture.repositories[0]?.path ?? ""),
      ]));
      expect(options.writableRoots).not.toContain(realpathSync(fixture.repositories[1]?.path ?? ""));
      expect(options.writableRoots).not.toContain(realpathSync(fixture.issueRoot));
      for (const repo of fixture.repositories) {
        writeFileSync(join(repo.path, "delivery.txt"), `${repo.alias} delivered\n`);
        execFileSync("git", ["add", "delivery.txt"], { cwd: repo.path });
        execFileSync("git", ["commit", "-qm", `tcr: deliver ${repo.alias}`], { cwd: repo.path });
      }
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    });
    const basePorts = nodePorts({
      repoCwd: fixture.root,
      paths: fixturePaths,
      skillBody: "BUILD STORY",
      routeDeps,
      agentSpawn: spawn,
      clock: () => 100,
    });
    const globalGit = {
      fetchOrigin: vi.spyOn(basePorts.git, "fetchOrigin"),
      worktreeAdd: vi.spyOn(basePorts.git, "worktreeAdd"),
      worktreeAddInSubmodule: vi.spyOn(basePorts.git, "worktreeAddInSubmodule"),
      worktreeRemoveInSubmodule: vi.spyOn(basePorts.git, "worktreeRemoveInSubmodule"),
      worktreeSubmoduleInit: vi.spyOn(basePorts.git, "worktreeSubmoduleInit"),
      commitsAhead: vi.spyOn(basePorts.git, "commitsAhead"),
      tcrCount: vi.spyOn(basePorts.git, "tcrCount"),
      recentCommits: vi.spyOn(basePorts.git, "recentCommits"),
      mainAhead: vi.spyOn(basePorts.git, "mainAhead"),
      rescueLeaked: vi.spyOn(basePorts.git, "rescueLeaked"),
      push: vi.spyOn(basePorts.git, "push"),
      worktreeRemove: vi.spyOn(basePorts.git, "worktreeRemove"),
      fetchRemoteBranch: vi.spyOn(basePorts.git, "fetchRemoteBranch"),
      branchMergedIntoMain: vi.spyOn(basePorts.git, "branchMergedIntoMain"),
      branchCleanlyRebasesOntoMain: vi.spyOn(basePorts.git, "branchCleanlyRebasesOntoMain"),
      resetWorktreeHard: vi.spyOn(basePorts.git, "resetWorktreeHard"),
      landLocalDelivery: vi.spyOn(basePorts.git, "landLocalDelivery"),
    };
    const globalProvider = {
      openPrTitles: vi.spyOn(basePorts.github, "openPrTitles").mockResolvedValue([]),
      repoSlug: vi.spyOn(basePorts.github, "repoSlug"),
      prState: vi.spyOn(basePorts.github, "prState"),
      prMergeInfo: vi.spyOn(basePorts.github, "prMergeInfo"),
    };
    const markStatus = vi.fn();
    const ports = {
      ...basePorts,
      backlog: {
        read: () => [{ id: fixture.storyId, desc: "Workspace production chain", status: "📋 Todo" }],
        markStatus,
      },
    };
    const baseCtx = {
      cycleId: "cycle-production-chain",
      branch: "cycle-production-chain",
      loop: "ci",
      workspaceExecution: workspaceExecutionFor(fixture.root),
      workspaceContextScope: "issue_required" as const,
      repositorySelector: fixture.repositories[0]?.repoId,
    };
    const rootModeBefore = statSync(fixture.root).mode & 0o777;
    const nodeExec = vi.spyOn(nodeExecPort, "run");
    const result = await runCycleOnce({ ports, ctx: baseCtx });
    const nodeExecCalls = [...nodeExec.mock.calls];
    nodeExec.mockRestore();

    expect(result.terminal).toBe("blocked");
    expect(result.state?.ctx.repositoryExecution).toMatchObject({
      workspaceId: "ws-production-chain",
      issueRoot: realpathSync(fixture.issueRoot),
    });

    const storyEvents = readFileSync(fixturePaths.eventsPath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(storyEvents.filter((event) => event["type"] === "cycle:end")).toHaveLength(1);
    const runs = readFileSync(fixturePaths.runsPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(runs).toHaveLength(4);
    expect(runs.find((row) => row["cycle_id"] === baseCtx.cycleId)).toMatchObject({
      story_id: fixture.storyId,
      cycle_id: baseCtx.cycleId,
      status: "blocked",
      tcr_count: 2,
    });
    expect(existsSync(join(runtimeRoot, "story-leases.json"))).toBe(false);
    expect(existsSync(fixturePaths.lockPath)).toBe(false);
    expect(markStatus).toHaveBeenCalledWith(fixture.root, fixture.storyId, expect.any(String));
    expect(statSync(fixture.root).mode & 0o777).toBe(rootModeBefore);
    for (const spy of [...Object.values(globalGit), ...Object.values(globalProvider)]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(nodeExecCalls).toHaveLength(0);
    const issueEvents = readFileSync(join(fixture.issueRoot, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(issueEvents.filter((event) => event["type"] === "repository:capture_observed")).toHaveLength(2);
    expect(existsSync(join(fixture.issueRoot, ".git"))).toBe(false);
  });

  it("writes repository events through one identity-enforcing Issue writer", async () => {
    const fixture = productionWorkspaceFixture();
    const fixturePaths: RunnerPaths = {
      eventsPath: join(fixture.root, "runtime", "events.ndjson"),
      runsPath: join(fixture.root, "runtime", "runs.jsonl"),
      alertsPath: join(fixture.root, "runtime", "alerts.log"),
      lockPath: join(fixture.root, "runtime", "lock"),
      heartbeatPath: join(fixture.root, "runtime", "heartbeat"),
      worktreePath: join(fixture.root, "legacy-worktree"),
    };
    const ports = nodePorts({
      repoCwd: fixture.root,
      paths: fixturePaths,
      skillBody: "BUILD STORY",
      routeDeps,
      agentSpawn: fakeSpawn(),
    });
    const resolved = await ports.repositories?.resolve(fixture.storyId);
    if (resolved === undefined) throw new Error("fixture repository context must resolve");
    const bound = ports.repositories?.bind({
      cycleId: "cycle-event",
      branch: "cycle-event",
      loop: "ci",
      storyId: fixture.storyId,
      repositoryExecution: resolved,
    });

    bound?.events.append(fixture.repoId, {
      type: "repository:test_observed",
      status: "green",
      ts: 2,
    });

    const events = readFileSync(join(resolved.issueRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({
      type: "repository:test_observed",
      workspaceId: resolved.workspaceId,
      storyId: fixture.storyId,
      cycleId: "cycle-event",
      repoId: fixture.repoId,
      status: "green",
    });
  });

  it("fails closed when no Workspace context is supplied", () => {
    const input = {
      purpose: "builder",
      cwd: paths.worktreePath,
      skillBody: "BUILD STORY",
    } as const;
    expect(() => applyRepositoryBuilderContext({
      cycleId: "cycle-legacy",
      branch: "cycle-legacy",
      loop: "ci",
      workspaceContextScope: "legacy_migration_only",
    }, input)).toThrow("missing_execution_context");
  });

  it("does not let nodePorts construction statically rewrite a Builder call", async () => {
    const spawn = fakeSpawn();
    const ports = nodePorts({
      repoCwd: "/project",
      paths,
      skillBody: "BUILD STORY",
      routeDeps,
      agentSpawn: spawn,
    });

    await ports.agentSpawn("claude", {
      purpose: "builder",
      cwd: paths.worktreePath,
      skillBody: "BUILD STORY",
    });

    expect(spawn).toHaveBeenCalledWith("claude", {
      purpose: "builder",
      cwd: paths.worktreePath,
      skillBody: "BUILD STORY",
    });
  });

  it("does not rewrite non-Builder agent calls", async () => {
    const spawn = fakeSpawn();
    const ports = nodePorts({
      repoCwd: "/project",
      paths,
      skillBody: "REVIEW",
      routeDeps,
      agentSpawn: spawn,
    });

    await ports.agentSpawn("claude", {
      purpose: "pick_ranking",
      cwd: "/ranking-cwd",
      skillBody: "RANK",
    });

    expect(spawn).toHaveBeenCalledWith("claude", {
      purpose: "pick_ranking",
      cwd: "/ranking-cwd",
      skillBody: "RANK",
    });
  });

  it("fails closed before any legacy terminal Git/provider path can bypass repository identity", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "roll-us-ws-010-terminal-"));
    const scopedPaths: RunnerPaths = {
      ...paths,
      eventsPath: join(runtimeRoot, "events.ndjson"),
      runsPath: join(runtimeRoot, "runs.jsonl"),
      alertsPath: join(runtimeRoot, "alerts.log"),
    };
    const leasePath = join(runtimeRoot, "leases");
    expect(claimStoryLease(leasePath, "US-WS-010", {
      pid: process.pid,
      claimedAt: 1,
      source: "cycle",
    })).toMatchObject({ status: "claimed" });
    const ports = nodePorts({
      repoCwd: "/project",
      paths: scopedPaths,
      skillBody: "BUILD STORY",
      routeDeps,
      agentSpawn: fakeSpawn(),
    });
    const gitPush = vi.spyOn(ports.git, "push");
    const worktreeRemove = vi.spyOn(ports.git, "worktreeRemove");
    const repoSlug = vi.spyOn(ports.github, "repoSlug");
    const prMergeInfo = vi.spyOn(ports.github, "prMergeInfo");
    const upsertRun = vi.spyOn(ports.events, "upsertRun");
    const appendAlert = vi.spyOn(ports.events, "appendAlert").mockImplementation(() => undefined);
    const ctx = {
      cycleId: "cycle-terminal",
      branch: "cycle-terminal",
      loop: "ci" as const,
      storyId: "US-WS-010",
      repositoryExecution: execution,
    };

    await expect(executeTerminalCommand({
      kind: "publish_pr",
      branch: "cycle-terminal",
      docOnly: false,
    }, ports, ctx)).rejects.toThrow("workspace_repository_scope_required");
    await expect(executeTerminalCommand({
      kind: "cleanup_worktree",
      branch: "cycle-terminal",
    }, ports, ctx)).resolves.toEqual({});
    await expect(executeTerminalCommand({
      kind: "append_run",
      status: "published",
      outcome: "awaiting_merge",
      cycleId: "cycle-terminal",
    }, ports, ctx)).resolves.toEqual({});

    expect(gitPush).not.toHaveBeenCalled();
    expect(worktreeRemove).not.toHaveBeenCalled();
    expect(repoSlug).not.toHaveBeenCalled();
    expect(prMergeInfo).not.toHaveBeenCalled();
    expect(upsertRun).toHaveBeenCalledOnce();
    expect(readFileSync(scopedPaths.runsPath, "utf8")).toContain(
      '"story_id":"US-WS-010","cycle_id":"cycle-terminal"',
    );
    expect(readLeases(leasePath)["US-WS-010"]).toBeUndefined();
    expect(appendAlert).toHaveBeenCalledWith(
      scopedPaths.alertsPath,
      expect.stringContaining("workspace_repository_scope_required: cleanup_worktree"),
    );
  });
});
