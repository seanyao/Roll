import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import { designCommand, designRequirementHint, type DesignCommandDeps } from "../src/commands/design.js";
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

registerAll();

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
  writeFileSync(join(rollHome, "config.yaml"), "ai_claude: ~/.claude\n", "utf8");
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
  writeFileSync(path, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const out = process.env.ROLL_TEST_SPAWN_LOG;",
    "if (out) fs.writeFileSync(out, JSON.stringify({",
    "  argv: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    "  context: process.env.ROLL_WORKSPACE_EXECUTION_CONTEXT,",
    "}));",
    'process.stdout.write("ok\\n");',
    "",
  ].join("\n"), "utf8");
  chmodSync(path, 0o755);
}

async function runPublicDesign(
  f: ReturnType<typeof fixture>,
  args: string[],
  logName: string,
): Promise<{ readonly status: number; readonly stderr: string; readonly spawn?: { argv: string[]; cwd: string; context?: string } }> {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const binDir = join(f.arbitraryCwd, `bin-${logName}`);
  const logPath = join(f.arbitraryCwd, `${logName}.json`);
  mkdirSync(binDir);
  makeAgent(binDir);
  let stderr = "";
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    process.chdir(f.arbitraryCwd);
    process.env["ROLL_HOME"] = f.rollHome;
    process.env["ROLL_PKG_DIR"] = REPO;
    process.env["ROLL_DESIGN_AGENT"] = "claude";
    process.env["ROLL_LANG"] = "en";
    process.env["PATH"] = `${binDir}:${previousEnv["PATH"] ?? ""}`;
    process.env["ROLL_TEST_SPAWN_LOG"] = logPath;
    const result = await dispatch(["design", ...args], async () => ({ ok: true }));
    return {
      status: result.status,
      stderr,
      ...(existsSync(logPath)
        ? { spawn: JSON.parse(readFileSync(logPath, "utf8")) as { argv: string[]; cwd: string; context?: string } }
        : {}),
    };
  } finally {
    process.stderr.write = write;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
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
      workspaceContextScope: "workspace_required_mutation",
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
    })).toMatchObject({
      ok: true,
      context: { workspace: { workspaceId: "roll" }, resolution: { source: "requirement_discovery" } },
    });
    expect(loadWorkspaceExecutionContext({
      rollHome: f.rollHome,
      cwd: f.arbitraryCwd,
      explicitWorkspace: "roll",
      operation: "mutation",
      scope: "workspace_required_mutation",
      requirement: jiraRequirement("APE-999"),
    })).toMatchObject({ ok: false, code: "requirement_workspace_conflict" });
  });

  it("extracts path and deterministic identities from --from-file content", () => {
    const f = fixture();
    const hint = designRequirementHint(["--from-file", f.inputFile]);
    expect(hint.paths).toEqual([{ path: f.inputFile, provenance: "cli_argument" }]);
    expect(hint.sources).toEqual([{
      key: { provider: "jira", ref: "APE-234" },
      provenance: "deterministic_extraction",
    }]);
  });

  it("dispatches public design from arbitrary cwd through requirement discovery and Workspace authorities", async () => {
    const f = fixture();
    const result = await runPublicDesign(f, ["--from-file", "brief.md"], "requirement-match");
    expect(result.status, JSON.stringify(result)).toBe(0);
    expect(result.spawn?.cwd).toBe(f.workspaceRoot);
    const context = JSON.parse(result.spawn?.context ?? "null") as WorkspaceExecutionContextV1 | null;
    expect(context).toMatchObject({
      workspace: { workspaceId: "roll" },
      resolution: { source: "requirement_discovery" },
    });
    expect(result.spawn?.argv[0]).toContain(`Use this product brief file as the design input: ${f.inputFile}`);
    expect(existsSync(join(f.workspaceRoot, "runtime", "design"))).toBe(true);
  });

  it("stops public design at workspace_target on missing or conflicting requirement identity", async () => {
    const f = fixture();
    const missingFile = join(f.arbitraryCwd, "missing.md");
    writeFileSync(missingFile, "# APE-777 brief\n", "utf8");
    const missing = await runPublicDesign(f, ["--from-file", "missing.md"], "missing-requirement");
    expect(missing.status).toBe(1);
    expect(missing.spawn).toBeUndefined();
    expect(missing.stderr).toContain("workspace_target:requirement_match_required");

    const mismatchFile = join(f.arbitraryCwd, "mismatch.md");
    writeFileSync(mismatchFile, "# APE-999 brief\n", "utf8");
    const mismatch = await runPublicDesign(
      f,
      ["--workspace", "roll", "--from-file", "mismatch.md"],
      "mismatch-requirement",
    );
    expect(mismatch.status).toBe(1);
    expect(mismatch.spawn).toBeUndefined();
    expect(mismatch.stderr).toContain("workspace_target:requirement_workspace_conflict");
  });

  it("keeps --workspace and --ws public design handoffs equivalent", async () => {
    const f = fixture();
    const canonical = await runPublicDesign(
      f,
      ["--workspace", "roll", "--from-file", "brief.md"],
      "canonical-selector",
    );
    const alias = await runPublicDesign(
      f,
      ["--ws", "roll", "--from-file", "brief.md"],
      "alias-selector",
    );
    expect(alias.status, JSON.stringify(alias)).toBe(0);
    expect(alias.spawn).toEqual(canonical.spawn);
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
