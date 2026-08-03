import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CycleContext, RouteDeps } from "@roll/core";
import type { RepositoryExecutionContext } from "@roll/spec";
import { executeCaptureFactsCommand } from "../src/runner/capture-facts-handler.js";
import { createRepositoryPorts, nodePorts } from "../src/runner/node-ports.js";
import type { AgentSpawn } from "../src/runner/agent-spawn.js";
import type { RepositoryPortAdapters, RunnerPaths } from "../src/runner/ports.js";

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

function repository(
  root: string,
  repoId: string,
  alias: string,
  options: {
    readonly integration?: readonly string[];
    readonly dependsOnRepo?: string;
    readonly test?: readonly string[];
    readonly noChangeAllowed?: boolean;
  } = {},
): RepositoryExecutionContext {
  const worktreePath = join(root, alias);
  mkdirSync(worktreePath, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.email", "roll-test@example.invalid"], { cwd: worktreePath });
  writeFileSync(join(worktreePath, "base.txt"), `${alias} base\n`);
  execFileSync("git", ["add", "base.txt"], { cwd: worktreePath });
  execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: worktreePath });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
  if (options.noChangeAllowed !== true) {
    writeFileSync(join(worktreePath, "delivery.txt"), `${alias} delivery\n`);
    execFileSync("git", ["add", "delivery.txt"], { cwd: worktreePath });
    execFileSync("git", ["commit", "--quiet", "-m", "tcr: delivery"], { cwd: worktreePath });
  }
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
  return {
    repoId,
    alias,
    access: "write",
    requiredDelivery: true,
    noChangePolicy: options.noChangeAllowed === true ? "no_change_allowed" : "changes_required",
    workBranch: `campaign/${alias}`,
    ...(options.dependsOnRepo === undefined ? {} : { dependsOnRepo: options.dependsOnRepo }),
    worktreePath,
    baseSha,
    headSha,
    commands: {
      test: options.test ?? ["npm", "test"],
      integration: options.integration ?? [],
    },
  };
}

function fixture(options: {
  readonly integration?: readonly string[];
  readonly secondTestExit?: number;
  readonly secondNoTests?: boolean;
  readonly single?: boolean;
  readonly backstopToolchains?: boolean;
  readonly firstCommitsAhead?: number;
  readonly ownerExemptsFirst?: boolean;
  readonly firstNoChangeAllowed?: boolean;
  readonly secondCommandThrows?: boolean;
  readonly integrationThrows?: boolean;
  readonly secondHeadThrows?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "roll-us-ws-012-capture-"));
  writeFileSync(join(root, "workspace.yaml"), "schema: roll-workspace/v1\nworkspace_id: ws-1\n");
  const storySpecDir = join(root, "backlog", "workspace-orchestration", "US-WS-012");
  mkdirSync(storySpecDir, { recursive: true });
  writeFileSync(join(storySpecDir, "spec.md"), `---
id: US-WS-012
repositories:
  - alias: api
    access: write
    required_delivery: true
  - alias: web
    access: write
    required_delivery: true
---

# US-WS-012 Workspace delivery

**AC:**
- [ ] API and Web changes satisfy the shared contract.
- [ ] Cross-repository integration passes against the exact delivered heads.

**Evaluation contract:**
- expected_evidence:
  - kind: test
    target: repository verification
    proves: both repository legs pass
- scorer_focus:
  - Judge the shared contract and exact-head integration.
`);
  mkdirSync(join(root, ".roll"), { recursive: true });
  const issueRoot = join(root, "issues", "US-WS-012");
  const runtimeRoot = join(root, "runtime");
  mkdirSync(issueRoot, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const first = repository(issueRoot, "repo-aaaaaaaaaaaa", "api", {
    integration: options.integration,
    noChangeAllowed: options.firstNoChangeAllowed,
    ...(options.backstopToolchains ? { test: [] } : {}),
  });
  const second = repository(issueRoot, "repo-bbbbbbbbbbbb", "web", {
    integration: options.integration,
    dependsOnRepo: first.alias,
    ...(options.backstopToolchains ? { test: [] } : {}),
  });
  if (options.backstopToolchains) {
    writeFileSync(join(first.worktreePath, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    mkdirSync(join(first.worktreePath, "node_modules", "vitest"), { recursive: true });
    writeFileSync(join(first.worktreePath, "node_modules", "vitest", "package.json"), JSON.stringify({ version: "3.2.7" }));
    writeFileSync(join(second.worktreePath, "package.json"), JSON.stringify({ scripts: { test: "jest --ci" } }));
  }
  const repositories = options.single ? { [first.repoId]: first } : {
    [first.repoId]: first,
    [second.repoId]: second,
  };
  const ctx: CycleContext = {
    cycleId: "cycle-us-ws-012",
    branch: "roll/ws-1/US-WS-012",
    loop: "ci",
    storyId: "US-WS-012",
    agent: "claude",
    repositoryExecution: {
      workspaceId: "ws-1",
      issueRoot,
      repositories,
      ...(options.integration === undefined || options.integration.length === 0
        ? {}
        : { integrationAcceptance: { command: options.integration, cwdRepoId: first.repoId } }),
    },
  };
  if (options.ownerExemptsFirst) {
    writeFileSync(join(issueRoot, "events.jsonl"), `${JSON.stringify({
      type: "issue:repository_no_change_exempted",
      workspaceId: "ws-1",
      storyId: "US-WS-012",
      cycleId: "cycle-us-ws-012",
      repoId: first.repoId,
      approved: true,
      ts: 1,
    })}\n`);
  }
  const testRuns: Array<{ repoId: string; command: readonly string[] }> = [];
  const integrationRuns: Array<{
    cwdRepoId: string;
    command: readonly string[];
    env: Readonly<Record<string, string>>;
  }> = [];
  const adapters: RepositoryPortAdapters = {
    git: {
      commitsAhead: vi.fn(async (repo) => repo.repoId === first.repoId ? (options.firstCommitsAhead ?? 1) : 1),
      tcrCount: vi.fn(async () => 1),
      recentCommits: vi.fn(async () => []),
      dirty: vi.fn(async () => false),
      headSha: vi.fn(async (repo) => {
        if (repo.repoId === second.repoId && options.secondHeadThrows) throw new Error("head unavailable");
        return repo.repoId === first.repoId ? "a".repeat(40) : "b".repeat(40);
      }),
      push: vi.fn(async () => ({ code: 0 })),
    },
    verification: {
      runRepository: vi.fn(async (repo, command) => {
        testRuns.push({ repoId: repo.repoId, command });
        if (repo.repoId === second.repoId && options.secondCommandThrows) throw new Error("spawn ENOENT");
        return {
          exitCode: repo.repoId === second.repoId ? (options.secondTestExit ?? 0) : 0,
          stdout: repo.repoId === second.repoId && options.secondNoTests
            ? "No test files found, exiting with code 0"
            : "Test Files 1 passed (1)",
          stderr: "",
        };
      }),
      runIntegration: vi.fn(async (_execution, cwdRepoId, command, env) => {
        integrationRuns.push({ cwdRepoId, command, env });
        if (options.integrationThrows) throw new Error("spawn integration ENOENT");
        return { exitCode: 0, stdout: "integration passed", stderr: "" };
      }),
    },
    provider: {
      repoSlug: vi.fn(async () => undefined),
      prState: vi.fn(async () => "UNKNOWN"),
      prMergeInfo: vi.fn(async () => undefined),
    },
  };
  const paths: RunnerPaths = {
    eventsPath: join(runtimeRoot, "events.ndjson"),
    runsPath: join(runtimeRoot, "runs.jsonl"),
    alertsPath: join(runtimeRoot, "alerts.log"),
    lockPath: join(runtimeRoot, "lock"),
    heartbeatPath: join(runtimeRoot, "heartbeat"),
    worktreePath: join(root, "legacy-worktree"),
  };
  const base = nodePorts({
    repoCwd: root,
    paths,
    skillBody: "BUILD STORY",
    routeDeps,
    agentSpawn: fakeSpawn(),
    clock: () => 123,
  });
  const bound = createRepositoryPorts(ctx, adapters);
  return {
    ctx,
    ports: {
      ...base,
      repositories: { resolve: async () => ctx.repositoryExecution, bind: () => bound },
    },
    issueRoot,
    first,
    second,
    testRuns,
    integrationRuns,
    root,
  };
}

function issueEvents(issueRoot: string): Array<Record<string, unknown>> {
  return readFileSync(join(issueRoot, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("US-WS-012 repository capture verification", () => {
  it("verifies each changed repository, pins integration to current heads, and records dependency-ordered publish plans", async () => {
    const f = fixture({ integration: ["./verify-sot-contract.sh"] });

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ commitsAhead: 2 }),
    });
    expect(result.event?.type === "facts_captured" && result.event.facts).not.toHaveProperty("repositoryVerificationPending");
    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ repositoryPublishPending: true }),
    });
    expect(result.ctxPatch).toEqual({ tcrCount: 2 });
    expect(f.testRuns).toEqual([
      { repoId: f.first.repoId, command: ["npm", "test"] },
      { repoId: f.second.repoId, command: ["npm", "test"] },
    ]);
    expect(f.integrationRuns).toEqual([{
      cwdRepoId: f.first.repoId,
      command: ["./verify-sot-contract.sh"],
      env: {
        ROLL_INTEGRATION_INPUTS: JSON.stringify({
          [f.first.repoId]: "a".repeat(40),
          [f.second.repoId]: "b".repeat(40),
        }),
      },
    }]);
    const events = issueEvents(f.issueRoot);
    expect(events.filter((event) => event["type"] === "repository:verification")).toEqual([
      expect.objectContaining({ repoId: f.first.repoId, status: "pass", headSha: "a".repeat(40) }),
      expect.objectContaining({ repoId: f.second.repoId, status: "pass", headSha: "b".repeat(40) }),
    ]);
    expect(events.find((event) => event["type"] === "issue:integration_acceptance_recorded")).toEqual(
      expect.objectContaining({
        status: "pass",
        inputHeads: {
          [f.first.repoId]: "a".repeat(40),
          [f.second.repoId]: "b".repeat(40),
        },
      }),
    );
    expect(events.filter((event) => event["type"] === "repository:publish_planned")).toEqual([
      expect.objectContaining({ repoId: f.first.repoId, branch: "campaign/api", dependsOn: [] }),
      expect.objectContaining({ repoId: f.second.repoId, branch: "campaign/web", dependsOn: [f.first.repoId] }),
    ]);
  });

  it("blocks the Story when one repository test fails and preserves the failing leg evidence", async () => {
    const f = fixture({ integration: ["./verify-sot-contract.sh"], secondTestExit: 1 });

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({
        commitsAhead: 2,
        repositoryVerificationPending: true,
      }),
    });
    expect(result.ctxPatch).toMatchObject({
      tcrCount: 2,
      failureClass: "harness",
      rootCauseKey: "harness:repository_verification_failed",
    });
    const events = issueEvents(f.issueRoot);
    expect(events.find((event) => event["type"] === "repository:verification" && event["repoId"] === f.second.repoId)).toEqual(
      expect.objectContaining({ status: "fail", exitCode: 1 }),
    );
    expect(events.filter((event) => event["type"] === "repository:publish_planned")).toHaveLength(0);
  });

  it("preserves the one-repository projection without requiring a cross-repo command", async () => {
    const f = fixture({ single: true });

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(result.event?.type === "facts_captured" && result.event.facts).not.toHaveProperty("repositoryVerificationPending");
    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ repositoryPublishPending: true }),
    });
    expect(f.testRuns).toEqual([{ repoId: f.first.repoId, command: ["npm", "test"] }]);
    expect(f.integrationRuns).toEqual([]);
    expect(issueEvents(f.issueRoot).filter((event) => event["type"] === "repository:publish_planned")).toHaveLength(1);
  });

  it("resolves each repository test gate from its own toolchain and uses a conservative full suite when needed", async () => {
    const f = fixture({ integration: ["./verify-sot-contract.sh"], backstopToolchains: true });

    await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(f.testRuns).toEqual([
      { repoId: f.first.repoId, command: ["npm", "test", "--", "--changed"] },
      { repoId: f.second.repoId, command: ["npm", "test"] },
    ]);
  });

  it("does not mint a green repository verdict from a zero-test exit 0", async () => {
    const f = fixture({ integration: ["./verify-sot-contract.sh"], secondNoTests: true });

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ repositoryVerificationPending: true }),
    });
    expect(issueEvents(f.issueRoot).find(
      (event) => event["type"] === "repository:verification" && event["repoId"] === f.second.repoId,
    )).toEqual(expect.objectContaining({ status: "fail", diagnostic: "zero_tests" }));
  });

  it("accepts an unchanged repository only when the current Issue Cycle records an explicit owner exemption", async () => {
    const f = fixture({
      integration: ["./verify-sot-contract.sh"],
      firstCommitsAhead: 0,
      ownerExemptsFirst: true,
    });

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(result.event?.type === "facts_captured" && result.event.facts).not.toHaveProperty("repositoryVerificationPending");
    expect(issueEvents(f.issueRoot).filter((event) => event["type"] === "repository:publish_planned")).toEqual([
      expect.objectContaining({ repoId: f.second.repoId }),
    ]);
  });

  it("attests a declared no-change leg without requiring an owner exemption", async () => {
    const f = fixture({
      single: true,
      firstCommitsAhead: 0,
      firstNoChangeAllowed: true,
    });

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.not.objectContaining({ gateBlocked: true }),
    });
    expect(readFileSync(join(f.issueRoot, "evidence", "cycle-us-ws-012", "ac-map.json"), "utf8"))
      .toContain("API and Web changes satisfy the shared contract.");
  });

  it("blocks instead of synthesizing repository-shaped ACs when the Workspace Story has no acceptance criteria", async () => {
    const f = fixture({ single: true });
    writeFileSync(join(f.root, "backlog", "workspace-orchestration", "US-WS-012", "spec.md"), `---
id: US-WS-012
repositories:
  - alias: api
    access: write
    required_delivery: true
---

# US-WS-012 missing acceptance contract
`);

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ gateBlocked: true }),
    });
    const runtimeEvents = readFileSync(f.ports.paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      type: "attest:gate",
      verdict: "skipped",
      reasons: ["workspace_acceptance_criteria_missing"],
    }));
    expect(existsSync(join(f.issueRoot, "evidence", "cycle-us-ws-012", "ac-map.json"))).toBe(false);
  });

  it("blocks before scoring when any repository diff cannot be collected", async () => {
    const f = fixture({ single: true });
    rmSync(f.first.worktreePath, { recursive: true, force: true });
    const scoreSpawn = vi.fn(async () => ({
      stdout: "SCORE: 9\nVERDICT: good\nRATIONALE: should never run",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    })) as unknown as AgentSpawn;
    scoreSpawn.supportedPurposes = ["builder", "test_author", "implementer", "attacker"];
    const ports = { ...f.ports, agentSpawn: scoreSpawn, installedAgents: () => ["claude", "pi"] };

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, ports, f.ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ gateBlocked: true }),
    });
    expect(scoreSpawn).not.toHaveBeenCalled();
    expect(readFileSync(ports.paths.alertsPath, "utf8")).toContain("workspace_diff_unavailable:api");
  });

  it("records command launch failures as blocked leg evidence instead of aborting capture", async () => {
    const f = fixture({ integration: ["./verify-sot-contract.sh"], secondCommandThrows: true });

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ repositoryVerificationPending: true }),
    });
    expect(issueEvents(f.issueRoot).find(
      (event) => event["type"] === "repository:verification" && event["repoId"] === f.second.repoId,
    )).toEqual(expect.objectContaining({ status: "fail", diagnostic: "command_execution_failed" }));
  });

  it("records integration launch failures against the pinned input map and blocks publish planning", async () => {
    const f = fixture({ integration: ["./verify-sot-contract.sh"], integrationThrows: true });

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ repositoryVerificationPending: true }),
    });
    expect(issueEvents(f.issueRoot).find((event) => event["type"] === "issue:integration_acceptance_recorded")).toEqual(
      expect.objectContaining({ status: "fail", diagnostic: "command_execution_failed" }),
    );
  });

  it("fails loud with per-leg evidence when an exact repository head cannot be observed", async () => {
    const f = fixture({ integration: ["./verify-sot-contract.sh"], secondHeadThrows: true });

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, f.ports, f.ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ repositoryVerificationPending: true }),
    });
    expect(issueEvents(f.issueRoot).find(
      (event) => event["type"] === "repository:verification" && event["repoId"] === f.second.repoId,
    )).toEqual(expect.objectContaining({ status: "fail", diagnostic: "head_observation_failed" }));
    expect(f.integrationRuns).toEqual([]);
  });

  it("runs Workspace evaluation with the Workspace evaluate casting after repository verification", async () => {
    const f = fixture({ integration: ["./verify-sot-contract.sh"] });
    writeFileSync(join(f.root, "agents.yaml"), `schema: roll-agents/v1
scope: workspace
inherits: machine
roles: {}
defaults:
  story:
    roles:
      evaluate:
        kind: fixed
        agent: pi
`);
    const machineHome = join(f.root, "machine-home");
    mkdirSync(machineHome, { recursive: true });
    writeFileSync(join(machineHome, "agents.yaml"), `schema: roll-agents/v1
scope: machine
agents:
  claude:
    capabilities: [execute]
  pi:
    capabilities: [evaluate]
  reasonix:
    capabilities: [evaluate]
roles: {}
`);
    writeFileSync(join(f.root, ".roll", "agents.yaml"), `schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: fixed
        agent: reasonix
`);
    rmSync(join(f.root, ".roll"), { recursive: true, force: true });
    const spawned: string[] = [];
    const scorePrompts: string[] = [];
    const agentSpawn: AgentSpawn = vi.fn(async (agent, options) => {
      spawned.push(agent);
      if (options.skillBody.includes("SCORE:")) scorePrompts.push(options.skillBody);
      if (options.readOnly === true && options.runDir !== undefined) {
        writeFileSync(
          join(options.runDir, "eval-report.md"),
          "# Evaluation\n\n## Inputs checked\n\n- repository verification\n- acceptance report\n\n## Rationale\n\nThe exact repository heads and shared contract evidence are sufficient.\n",
        );
      }
      return options.skillBody.includes("SCORE:")
        ? { stdout: "SCORE: 9\nVERDICT: good\nRATIONALE: repository-scoped verification is complete", stderr: "", exitCode: 0, timedOut: false }
        : { stdout: "VERDICT: agree", stderr: "", exitCode: 0, timedOut: false };
    });
    agentSpawn.supportedPurposes = ["builder", "test_author", "implementer", "attacker"];
    const ports = {
      ...f.ports,
      agentSpawn,
      installedAgents: () => ["claude", "pi", "reasonix"],
    };
    const evidenceRunDir = join(f.issueRoot, "evidence", "cycle-us-ws-012");
    mkdirSync(evidenceRunDir, { recursive: true });
    const ctx: CycleContext = {
      ...f.ctx,
      selectedProfile: "verified",
      evidenceRunDir,
      builderSessionId: "cycle-us-ws-012:build:claude:a1",
    };

    const previousRollHome = process.env["ROLL_HOME"];
    let result: Awaited<ReturnType<typeof executeCaptureFactsCommand>>;
    try {
      process.env["ROLL_HOME"] = machineHome;
      result = await executeCaptureFactsCommand({ kind: "capture_facts" }, ports, ctx);
    } finally {
      if (previousRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = previousRollHome;
    }

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ repositoryPublishPending: true }),
    });
    expect(spawned).toContain("pi");
    expect(spawned).not.toContain("reasonix");
    const runtimeEvents = readFileSync(ports.paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(runtimeEvents).toContainEqual(expect.objectContaining({ type: "pair:score", peer: "pi", score: 9 }));
    expect(runtimeEvents).toContainEqual(expect.objectContaining({ type: "attest:gate", verdict: "produced" }));
    expect(existsSync(join(evidenceRunDir, "ac-map.json"))).toBe(true);
    expect(existsSync(join(evidenceRunDir, "US-WS-012-report.html"))).toBe(true);
    expect(JSON.parse(readFileSync(join(evidenceRunDir, "ac-map.json"), "utf8"))).toEqual([
      expect.objectContaining({ ac: "API and Web changes satisfy the shared contract.", status: "partial" }),
      expect.objectContaining({
        ac: "Cross-repository integration passes against the exact delivered heads.",
        status: "partial",
      }),
    ]);
    expect(scorePrompts.join("\n")).toContain("API and Web changes satisfy the shared contract.");
    expect(scorePrompts.join("\n")).toContain("Judge the shared contract and exact-head integration.");
    expect(readFileSync(join(evidenceRunDir, "role-artifacts", "evaluator", "eval-report.md"), "utf8"))
      .toContain("The exact repository heads and shared contract evidence are sufficient.");
    expect(result.event?.type === "facts_captured" && result.event.facts).not.toHaveProperty("gateBlocked");
  });

  it.each([
    { score: 4, verdict: "ok", reason: "low review-score ok 4/10" },
    { score: 9, verdict: "regression", reason: "review-score regression 9/10" },
  ])("blocks Workspace delivery on $verdict evaluator quality", async ({ score, verdict, reason }) => {
    const f = fixture({ single: true });
    writeFileSync(join(f.root, "agents.yaml"), `schema: roll-agents/v1
scope: workspace
inherits: machine
roles: {}
defaults:
  story:
    roles:
      evaluate:
        kind: fixed
        agent: pi
`);
    const agentSpawn: AgentSpawn = vi.fn(async (_agent, options) => options.skillBody.includes("SCORE:")
      ? { stdout: `SCORE: ${score}\nVERDICT: ${verdict}\nRATIONALE: quality finding`, stderr: "", exitCode: 0, timedOut: false }
      : { stdout: "VERDICT: agree", stderr: "", exitCode: 0, timedOut: false });
    agentSpawn.supportedPurposes = ["builder", "test_author", "implementer", "attacker"];
    const evidenceRunDir = join(f.issueRoot, "evidence", "cycle-us-ws-012");
    mkdirSync(evidenceRunDir, { recursive: true });
    const ctx: CycleContext = {
      ...f.ctx,
      selectedProfile: "verified",
      evidenceRunDir,
      builderSessionId: "cycle-us-ws-012:build:claude:a1",
    };

    const result = await executeCaptureFactsCommand({ kind: "capture_facts" }, {
      ...f.ports,
      agentSpawn,
      installedAgents: () => ["claude", "pi"],
    }, ctx);

    expect(result.event).toEqual({
      type: "facts_captured",
      facts: expect.objectContaining({ gateBlocked: true }),
    });
    const runtimeEvents = readFileSync(f.ports.paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      type: "attest:gate",
      verdict: "skipped",
      reasons: expect.arrayContaining([expect.stringContaining(reason)]),
    }));
  });
});
