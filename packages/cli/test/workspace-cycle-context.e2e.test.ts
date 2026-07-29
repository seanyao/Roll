import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  repositoryIdFromRemote,
  type CycleRepositoryExecutionContext,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { cycleStep, initialCycleState } from "@roll/core";
import { WorkspaceRegistry } from "@roll/infra";
import { workspaceExecutionEnvironment } from "../src/runner/agent-spawn.js";
import { freezeWorkspaceCycleContext } from "../src/runner/scoped-route.js";
import { dispatch, registerAll } from "../src/index.js";
import { GOAL_ALLOWED_CARDS_ENV } from "../src/lib/goal-progress.js";

const initialCwd = process.cwd();
const initialEnv = {
  rollHome: process.env["ROLL_HOME"],
  workspace: process.env["ROLL_WORKSPACE"],
  mainProject: process.env["ROLL_MAIN_PROJECT"],
  runtime: process.env["ROLL_PROJECT_RUNTIME_DIR"],
  allowedCards: process.env[GOAL_ALLOWED_CARDS_ENV],
};

afterEach(() => {
  process.chdir(initialCwd);
  for (const [key, value] of Object.entries({
    ROLL_HOME: initialEnv.rollHome,
    ROLL_WORKSPACE: initialEnv.workspace,
    ROLL_MAIN_PROJECT: initialEnv.mainProject,
    ROLL_PROJECT_RUNTIME_DIR: initialEnv.runtime,
    [GOAL_ALLOWED_CARDS_ENV]: initialEnv.allowedCards,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture(): {
  readonly workspace: WorkspaceExecutionContextV1;
  readonly execution: CycleRepositoryExecutionContext;
} {
  const root = "/workspace/roll";
  const storyId = "US-WS-033";
  const issueRoot = `${root}/issues/${storyId}`;
  const productRemote = "git@github.com:seanyao/roll.git";
  const skillsRemote = "git@github.com:seanyao/roll-skills.git";
  const productRepoId = repositoryIdFromRemote(productRemote);
  const skillsRepoId = repositoryIdFromRemote(skillsRemote);
  if (!productRepoId.ok || !skillsRepoId.ok) throw new Error("fixture remotes must be canonical");
  const bindings = [
    {
      schema: REPOSITORY_BINDING_V1,
      repoId: productRepoId.value,
      alias: "product",
      remote: productRemote,
      integrationBranch: "idea-074-workspace",
      provider: "github",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    },
    {
      schema: REPOSITORY_BINDING_V1,
      repoId: skillsRepoId.value,
      alias: "skills",
      remote: skillsRemote,
      integrationBranch: "idea-074-workspace",
      provider: "github",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    },
  ] as const;
  const workspace: WorkspaceExecutionContextV1 = {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: { workspaceId: "roll", root, canonicalRoot: root, lifecycle: "active" },
    resolution: { source: "requirement_discovery", evidence: [] },
    bindings,
    authorities: {
      backlog: `${root}/backlog/index.md`,
      features: `${root}/features`,
      design: `${root}/design`,
      requirements: `${root}/requirements`,
      policy: `${root}/policy.yaml`,
      evidence: `${root}/evidence`,
      toolDumps: `${root}/runtime/tool-dumps`,
      events: `${root}/runtime/events`,
      runtime: `${root}/runtime`,
      locks: `${root}/runtime/locks`,
    },
  };
  const execution: CycleRepositoryExecutionContext = {
    workspaceId: "roll",
    issueRoot,
    repositories: Object.fromEntries(bindings.map((binding, index) => [binding.repoId, {
      repoId: binding.repoId,
      alias: binding.alias,
      access: index === 0 ? "write" : "read",
      requiredDelivery: index === 0,
      ...(index === 0 ? {
        noChangePolicy: "changes_required" as const,
        workBranch: `roll/roll/${storyId}/${binding.alias}`,
      } : {}),
      worktreePath: `${issueRoot}/${binding.alias}`,
      baseSha: `${index + 1}`.repeat(40),
      headSha: `${index + 3}`.repeat(40),
      commands: { test: [], integration: [] },
    }])),
  };
  return { workspace, execution };
}

describe("US-WS-033 — Workspace cycle context handoff", () => {
  it("US-WS-037: inherited legacy env cannot bypass exact Story Workspace resolution from /tmp", async () => {
    const rollHome = realpathSync(mkdtempSync(join(tmpdir(), "roll-ws-033-home-")));
    const arbitraryCwd = realpathSync(mkdtempSync(join(tmpdir(), "roll-ws-033-cwd-")));
    const target = realpathSync(mkdtempSync(join(tmpdir(), "roll-ws-033-target-")));
    const decoy = realpathSync(mkdtempSync(join(tmpdir(), "roll-ws-033-decoy-")));
    const binding = fixture().workspace.bindings[0];
    if (binding === undefined) throw new Error("missing fixture binding");
    for (const [root, workspaceId] of [[target, "roll"], [decoy, "decoy"]] as const) {
      mkdirSync(join(root, "backlog"), { recursive: true });
      mkdirSync(join(root, "runtime"), { recursive: true });
      mkdirSync(join(root, "issues"), { recursive: true });
      writeFileSync(join(root, "backlog", "index.md"), "# Backlog\n");
      writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
        schema: "roll.workspace/v1",
        workspaceId,
        displayName: workspaceId,
        requirements: [],
        repositories: [binding],
      })}\n`);
    }
    const issueRoot = join(target, "issues", "US-WS-033");
    mkdirSync(issueRoot, { recursive: true });
    writeFileSync(join(issueRoot, "manifest.json"), `${JSON.stringify({
      schema: "roll.issue/v1",
      workspaceId: "roll",
      storyId: "US-WS-033",
      requirements: [],
      repositories: [{
        repoId: binding.repoId,
        alias: binding.alias,
        access: "write",
        requiredDelivery: true,
        noChangePolicy: "changes_required",
      }],
    })}\n`);
    const registry = new WorkspaceRegistry({ rollHome });
    registry.register({ workspaceId: "roll", root: target });
    registry.activate("roll");
    registry.register({ workspaceId: "decoy", root: decoy });
    registry.activate("decoy");

    process.chdir(arbitraryCwd);
    process.env["ROLL_HOME"] = rollHome;
    delete process.env["ROLL_WORKSPACE"];
    process.env["ROLL_MAIN_PROJECT"] = arbitraryCwd;
    process.env["ROLL_PROJECT_RUNTIME_DIR"] = join(arbitraryCwd, "legacy-runtime");
    process.env[GOAL_ALLOWED_CARDS_ENV] = "US-WS-033";
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => (chunks.push(String(chunk)), true)) as typeof process.stdout.write;
    let code: number;
    try {
      registerAll();
      code = (await dispatch(["loop", "run-once", "--repository", binding.alias, "--dry-run"])).status;
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(code).toBe(0);
    expect(chunks.join("")).toContain("# workspace: roll");
    expect(chunks.join("")).toContain("# story:   US-WS-033");
    expect(chunks.join("")).toContain("# context-source: requirement_discovery");
    expect(chunks.join("")).toContain(`# repository: ${binding.repoId} (${binding.alias})`);
    expect(chunks.join("")).not.toContain("# workspace: decoy");
  });

  it("keeps one frozen context through cycle state, agent env, cwd changes, and replay", () => {
    const { workspace, execution } = fixture();
    const frozen = freezeWorkspaceCycleContext({ workspace, storyId: "US-WS-033", execution });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;

    const initial = initialCycleState({
      cycleId: "cycle-033",
      branch: "loop/cycle-033",
      loop: "ci",
      workspaceExecution: workspace,
    });
    const started = cycleStep(initial, { type: "start", ctx: initial.ctx });
    const preflight = cycleStep(started.state, { type: "preflight_done" });
    const worktree = cycleStep(preflight.state, { type: "worktree_created" });
    const picked = cycleStep(worktree.state, {
      type: "story_picked",
      storyId: "US-WS-033",
      repositoryExecution: execution,
      workspaceExecution: frozen.context,
    });

    expect(picked.state.ctx.workspaceExecution).toBe(frozen.context);
    expect(picked.state.ctx.repositoryExecution).toBe(execution);
    const env = workspaceExecutionEnvironment(picked.state.ctx.workspaceExecution);
    expect(env.ROLL_WORKSPACE).toBe("roll");
    expect(env.ROLL_STORY_ID).toBe("US-WS-033");
    expect(JSON.parse(env.ROLL_WORKSPACE_EXECUTION_CONTEXT ?? "null")).toEqual(frozen.context);
    expect(picked.state.ctx.workspaceExecution?.workspace.root).not.toBe("/tmp");
  });

  it("fails before spawn when the frozen context does not match the picked Story", () => {
    const { workspace, execution } = fixture();
    const mismatch = freezeWorkspaceCycleContext({ workspace, storyId: "US-OTHER-001", execution });
    expect(mismatch).toMatchObject({ ok: false, code: "missing_execution_context" });
  });
});
