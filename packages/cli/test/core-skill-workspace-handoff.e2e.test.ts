import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIREMENT_HINT_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  repositoryIdFromRemote,
  type RequirementHintV1,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { WorkspaceRegistry } from "@roll/infra";
import { designCommand, type DesignCommandDeps } from "../src/commands/design.js";
import { loadWorkspaceExecutionContext } from "../src/commands/workspace-execution-context.js";
import { workspaceExecutionEnvironment } from "../src/runner/agent-spawn.js";
import {
  prepareWorkspaceSkillHandoff,
  workspaceExecutionContextJson,
} from "../src/runner/workspace-skill-handoff.js";
import {
  freezeWorkspaceCycleContext,
  resolveWorkspaceCycleRepository,
} from "../src/runner/scoped-route.js";
import { prepareWorkspaceBuilderSkillBody } from "../src/runner/spawn-agent-handler.js";

const REPO = resolve(__dirname, "../../..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function binding(alias: string, remote: string) {
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must be canonical");
  return {
    schema: REPOSITORY_BINDING_V1,
    repoId: repoId.value,
    alias,
    remote,
    integrationBranch: "main",
    provider: "github" as const,
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  };
}

function writeWorkspace(
  root: string,
  workspaceId: string,
  requirementRef: string,
  repositories = [binding("product", `git@github.com:acme/${workspaceId}.git`)],
): void {
  for (const path of ["backlog", "features", "design", "runtime", "issues"]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  writeFileSync(join(root, "backlog", "index.md"), "# Backlog\n", "utf8");
  writeFileSync(join(root, "index.json"), '{"stories":{}}\n', "utf8");
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId,
    displayName: workspaceId,
    requirements: [{ provider: "jira", ref: requirementRef }],
    repositories,
  }, null, 2)}\n`, "utf8");
}

function fixture(): {
  readonly rollHome: string;
  readonly arbitraryCwd: string;
  readonly inputFile: string;
  readonly workspaceRoot: string;
  readonly productRepoId: string;
  readonly skillsRepoId: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roll-ws-037-")));
  roots.push(root);
  const rollHome = join(root, "home");
  const arbitraryCwd = join(root, "arbitrary");
  const workspaceRoot = join(root, "workspace-roll");
  const decoyRoot = join(root, "workspace-decoy");
  const inputFile = join(arbitraryCwd, "brief.md");
  mkdirSync(rollHome);
  mkdirSync(arbitraryCwd);
  mkdirSync(workspaceRoot);
  mkdirSync(decoyRoot);
  writeFileSync(inputFile, "# APE-234 design brief\n", "utf8");
  const product = binding("product", "git@github.com:acme/product.git");
  const skills = binding("skills", "git@github.com:acme/skills.git");
  writeWorkspace(workspaceRoot, "roll", "APE-234", [product, skills]);
  writeWorkspace(decoyRoot, "decoy", "APE-999");
  const registry = new WorkspaceRegistry({ rollHome, now: () => 1 });
  registry.register({ workspaceId: "roll", root: workspaceRoot });
  registry.activate("roll");
  registry.register({ workspaceId: "decoy", root: decoyRoot });
  registry.activate("decoy");
  return {
    rollHome,
    arbitraryCwd,
    inputFile,
    workspaceRoot: realpathSync(workspaceRoot),
    productRepoId: product.repoId,
    skillsRepoId: skills.repoId,
  };
}

function jiraRequirement(ref: string): RequirementHintV1 {
  return {
    schema: REQUIREMENT_HINT_V1,
    sources: [{ key: { provider: "jira", ref }, provenance: "deterministic_extraction" }],
    storyIds: [],
    repositoryRemotes: [],
    paths: [],
  };
}

function makeAgent(binDir: string): void {
  const path = join(binDir, "claude");
  writeFileSync(path, "#!/bin/sh\necho ok\n", "utf8");
  chmodSync(path, 0o755);
}

describe("US-WS-037 core skill Workspace handoff", () => {
  it("runs design from an arbitrary cwd with an explicit Workspace and byte-identical prompt/env context", () => {
    const f = fixture();
    const loaded = loadWorkspaceExecutionContext({
      rollHome: f.rollHome,
      cwd: f.arbitraryCwd,
      explicitWorkspace: "roll",
      operation: "mutation",
      scope: "workspace_required_mutation",
      requirement: jiraRequirement("APE-234"),
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const binDir = join(f.arbitraryCwd, "bin");
    mkdirSync(binDir);
    makeAgent(binDir);
    const calls: Array<{ readonly prompt: string; readonly cwd: string; readonly env: NodeJS.ProcessEnv }> = [];
    const deps: DesignCommandDeps = {
      cwd: f.workspaceRoot,
      invocationCwd: f.arbitraryCwd,
      workspaceExecution: loaded.context,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
        ROLL_PKG_DIR: REPO,
        ROLL_DESIGN_AGENT: "claude",
      },
      readLine: () => null,
      spawn: (_bin, args, opts) => {
        calls.push({ prompt: args[0] ?? "", cwd: String(opts.cwd ?? ""), env: opts.env ?? {} });
        return { status: 0, signal: null };
      },
      runLoopGo: () => 0,
      now: () => 1,
      heartbeatMs: 60_000,
    };

    expect(designCommand(["--from-file", "brief.md"], deps)).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) return;
    const json = workspaceExecutionContextJson(loaded.context);
    expect(call.cwd).toBe(f.workspaceRoot);
    expect(call.env["ROLL_WORKSPACE_EXECUTION_CONTEXT"]).toBe(json);
    expect(call.prompt.startsWith("[Roll Workspace skill handoff]\n")).toBe(true);
    expect(call.prompt).toContain("scope: workspace_required_mutation");
    expect(call.prompt).toContain("Workspace: roll");
    expect(call.prompt).toContain("Story: none");
    expect(call.prompt).toContain(`authorities: ${JSON.stringify(loaded.context.authorities)}`);
    expect(call.prompt).toContain("Do not rediscover or replace Workspace/Issue authority from cwd");
    expect(call.prompt).toContain(`context-json: ${json}`);
    expect(call.prompt.indexOf("[Roll Workspace skill handoff]")).toBeLessThan(call.prompt.indexOf("Run the $roll-design skill"));
    expect(call.prompt).toContain(`Use this product brief file as the design input: ${f.inputFile}`);
  });

  it("fails closed on missing context or a requirement conflict before agent spawn", () => {
    const f = fixture();
    expect(loadWorkspaceExecutionContext({
      rollHome: f.rollHome,
      cwd: f.arbitraryCwd,
      operation: "mutation",
      scope: "workspace_required_mutation",
      requirement: jiraRequirement("APE-234"),
    })).toMatchObject({ ok: false, code: "target_missing" });
    expect(loadWorkspaceExecutionContext({
      rollHome: f.rollHome,
      cwd: f.arbitraryCwd,
      explicitWorkspace: "roll",
      operation: "mutation",
      scope: "workspace_required_mutation",
      requirement: jiraRequirement("APE-999"),
    })).toMatchObject({ ok: false, code: "requirement_workspace_conflict" });
  });

  it("uses the same canonical renderer for build/fix and preserves identity across cwd changes and retry", () => {
    const f = fixture();
    const loaded = loadWorkspaceExecutionContext({
      rollHome: f.rollHome,
      cwd: f.arbitraryCwd,
      explicitWorkspace: "roll",
      operation: "mutation",
      scope: "workspace_required_mutation",
      requirement: jiraRequirement("APE-234"),
    });
    if (!loaded.ok) throw new Error(loaded.code);
    const storyId = "US-WS-037";
    const issueRoot = join(f.workspaceRoot, "issues", storyId);
    mkdirSync(issueRoot, { recursive: true });
    const execution = {
      workspaceId: "roll",
      issueRoot,
      repositories: {
        [f.productRepoId]: {
          repoId: f.productRepoId,
          alias: "product",
          access: "write" as const,
          requiredDelivery: true,
          noChangePolicy: "changes_required" as const,
          worktreePath: join(issueRoot, "product"),
          baseSha: "1".repeat(40),
          headSha: "2".repeat(40),
          commands: { test: [], integration: [] },
        },
        [f.skillsRepoId]: {
          repoId: f.skillsRepoId,
          alias: "skills",
          access: "read" as const,
          requiredDelivery: false,
          worktreePath: join(issueRoot, "skills"),
          baseSha: "3".repeat(40),
          headSha: "4".repeat(40),
          commands: { test: [], integration: [] },
        },
      },
    };
    const frozen = freezeWorkspaceCycleContext({ workspace: loaded.context, storyId, execution });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;

    const first = prepareWorkspaceSkillHandoff({
      skillName: "roll-build",
      scope: "issue_required",
      context: frozen.context,
      skillBody: "# Roll Build",
    });
    const retry = prepareWorkspaceSkillHandoff({
      skillName: "roll-fix",
      scope: "issue_required",
      context: frozen.context,
      skillBody: "# Roll Fix",
    });
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(first.contextJson).toBe(retry.contextJson);
    expect(first.context).toBe(frozen.context);
    expect(retry.context).toBe(frozen.context);
    expect(workspaceExecutionEnvironment(frozen.context)["ROLL_WORKSPACE_EXECUTION_CONTEXT"]).toBe(first.contextJson);
    expect(first.skillBody).toContain("Workspace: roll");
    expect(first.skillBody).toContain(`Story: ${storyId}`);
    expect(first.skillBody.startsWith("[Roll Workspace skill handoff]\n")).toBe(true);

    const spawned = prepareWorkspaceBuilderSkillBody({
      cycleId: "cycle-ws-037",
      branch: "loop/cycle-ws-037",
      loop: "ci",
      storyId,
      workspaceExecution: frozen.context,
      repositoryExecution: execution,
    }, "# Roll Build");
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    expect(spawned.skillBody.startsWith("[Roll Workspace skill handoff]\n")).toBe(true);
    expect(spawned.skillBody.indexOf("[Workspace repository execution context]")).toBeGreaterThan(0);
    expect(spawned.skillBody.indexOf("# Roll Build")).toBeGreaterThan(
      spawned.skillBody.indexOf("[Workspace repository execution context]"),
    );
    expect(spawned.contextJson).toBe(first.contextJson);
  });

  it("does not select the first repository in a multi-repo Issue without an explicit selector", () => {
    const f = fixture();
    const loaded = loadWorkspaceExecutionContext({
      rollHome: f.rollHome,
      cwd: f.arbitraryCwd,
      explicitWorkspace: "roll",
      operation: "mutation",
      scope: "workspace_required_mutation",
      requirement: jiraRequirement("APE-234"),
    });
    if (!loaded.ok) throw new Error(loaded.code);
    const context = {
      ...loaded.context,
      issue: {
        storyId: "US-WS-037",
        manifestPath: join(f.workspaceRoot, "issues", "US-WS-037", "manifest.json"),
        execution: {
          workspaceId: "roll",
          issueRoot: join(f.workspaceRoot, "issues", "US-WS-037"),
          repositories: {
            [f.productRepoId]: {
              repoId: f.productRepoId,
              alias: "product",
              access: "write" as const,
              requiredDelivery: true,
              noChangePolicy: "changes_required" as const,
              worktreePath: join(f.workspaceRoot, "issues", "US-WS-037", "product"),
              baseSha: "1".repeat(40),
              headSha: "2".repeat(40),
              commands: { test: [], integration: [] },
            },
            [f.skillsRepoId]: {
              repoId: f.skillsRepoId,
              alias: "skills",
              access: "read" as const,
              requiredDelivery: false,
              worktreePath: join(f.workspaceRoot, "issues", "US-WS-037", "skills"),
              baseSha: "3".repeat(40),
              headSha: "4".repeat(40),
              commands: { test: [], integration: [] },
            },
          },
        },
      },
    } as WorkspaceExecutionContextV1;
    expect(resolveWorkspaceCycleRepository(context)).toEqual({ ok: false, code: "missing_execution_context" });
    expect(resolveWorkspaceCycleRepository(context, f.skillsRepoId)).toMatchObject({
      ok: true,
      repository: { repoId: f.skillsRepoId, alias: "skills" },
    });
  });
});
