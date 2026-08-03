/**
 * Scoped `story.execute` (Builder) routing keeps the Supervisor assignment
 * visible and exposes an auditable route trace.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  freezeWorkspaceCycleContext,
  mostRecentBuilder,
  persistWorkspaceCycleContext,
  renderScopedExecuteRoute,
  resolveRequirementMatchedWorkspace,
  resolveWorkspaceCycleRepository,
  resolveScopedCastRole,
  resolveScopedStoryExecute,
  roleToScopeRole,
  restoreWorkspaceCycleContext,
  restorePersistedWorkspaceCycleContext,
  scopedExecuteRouteTrace,
  workspaceCycleContextPath,
} from "../src/runner/scoped-route.js";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  repositoryIdFromRemote,
  type CycleRepositoryExecutionContext,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const cliRequire = createRequire(join(import.meta.dirname, "..", "package.json"));
const tsxPackageDir = dirname(cliRequire.resolve("tsx/package.json"));
const tsxBin = join(tsxPackageDir, "dist", "cli.mjs");

async function waitUntilReady(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error("workspace context persistence workers did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function persistInChild(input: {
  readonly runtimeDir: string;
  readonly cycleId: string;
  readonly contextPath: string;
  readonly barrierPath: string;
  readonly readyPath: string;
}): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      tsxBin,
      join(import.meta.dirname, "workspace-cycle-context-persist-worker.ts"),
      input.runtimeDir,
      input.cycleId,
      input.contextPath,
      input.barrierPath,
      input.readyPath,
    ], { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const MACHINE = `schema: roll-agents/v1
scope: machine
agents:
  claude:
    capabilities: [supervise, execute, evaluate]
  agy:
    capabilities: [supervise, execute, evaluate]
  kimi:
    capabilities: [supervise, execute, evaluate]
  pi:
    capabilities: [supervise, execute, evaluate]
  reasonix:
    capabilities: [supervise, execute, evaluate]
  codex:
    capabilities: [supervise, execute, evaluate]
roles:
  supervise:
    kind: fixed
    agent: codex
`;

const PROJECT = `schema: roll-agents/v1
scope: project
inherits: machine
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [claude, agy, kimi, pi, reasonix, codex]
        require: [execute]
        strategy: least-recent
`;

const PROJECT_HEALTH_AWARE = `schema: roll-agents/v1
scope: project
inherits: machine
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [agy, kimi, reasonix, codex]
        require: [execute]
        strategy: health-aware
      evaluate:
        kind: select
        from: [agy, kimi, reasonix, codex]
        require: [evaluate]
        strategy: health-aware
`;

const WORKSPACE = `schema: roll-agents/v1
scope: workspace
inherits: machine
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [kimi, claude]
        require: [execute]
        strategy: first-available
`;

/** Build a {rollHome, repoCwd} pair seeded with the machine + project layers. */
function fixture(): { rollHome: string; repoCwd: string } {
  const rollHome = mkdtempSync(join(tmpdir(), "roll-home-"));
  const repoCwd = mkdtempSync(join(tmpdir(), "roll-proj-"));
  dirs.push(rollHome, repoCwd);
  writeFileSync(join(rollHome, "agents.yaml"), MACHINE);
  mkdirSync(join(repoCwd, ".roll"), { recursive: true });
  writeFileSync(join(repoCwd, ".roll", "agents.yaml"), PROJECT);
  return { rollHome, repoCwd };
}

function healthAwareFixture(): { rollHome: string; repoCwd: string } {
  const fx = fixture();
  writeFileSync(join(fx.repoCwd, ".roll", "agents.yaml"), PROJECT_HEALTH_AWARE);
  return fx;
}

function workspaceFixture(): { rollHome: string; workspaceRoot: string } {
  const rollHome = mkdtempSync(join(tmpdir(), "roll-ws-home-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "roll-workspace-"));
  dirs.push(rollHome, workspaceRoot);
  writeFileSync(join(rollHome, "agents.yaml"), MACHINE);
  writeFileSync(join(workspaceRoot, "workspace.yaml"), "{}\n");
  writeFileSync(join(workspaceRoot, "agents.yaml"), WORKSPACE);
  mkdirSync(join(workspaceRoot, ".roll"), { recursive: true });
  writeFileSync(join(workspaceRoot, ".roll", "agents.yaml"), `schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      execute: { use: codex }
`);
  return { rollHome, workspaceRoot };
}

const ALL_INSTALLED = new Set(["claude", "agy", "kimi", "pi", "reasonix", "codex"]);

describe("resolveScopedStoryExecute", () => {
  it("US-WS-017a: workspace runtime loads root casting and ignores project fallback", () => {
    const { rollHome, workspaceRoot } = workspaceFixture();
    const route = resolveScopedStoryExecute(workspaceRoot, {
      rollHome,
      workspaceRoot,
      installed: ALL_INSTALLED,
      recentUse: {},
      builderNoConsecutiveRepeat: false,
    });

    expect(route).not.toBeNull();
    expect(route?.resolution.ok).toBe(true);
    if (route?.resolution.ok) {
      expect(route.resolution.resolved.agent).toBe("kimi");
      expect(route.resolution.resolved.source).toBe(`${workspaceRoot}/agents.yaml:defaults.story.roles.execute`);
    }
  });

  it("US-WS-017a: invalid workspace casting fails loud instead of falling back", () => {
    const { rollHome, workspaceRoot } = workspaceFixture();
    writeFileSync(join(workspaceRoot, "agents.yaml"), `schema: roll-agents/v1
scope: workspace
inherits: machine
agents:
  codex:
    capabilities: [execute]
`);

    expect(() => resolveScopedStoryExecute(workspaceRoot, {
      rollHome,
      workspaceRoot,
      installed: ALL_INSTALLED,
    })).toThrow("invalid workspace agent scope");
  });

  it("US-WS-017a: repository cardinality does not create an agent scope", () => {
    const { rollHome, workspaceRoot } = workspaceFixture();
    const resolve = () => resolveScopedStoryExecute(workspaceRoot, {
      rollHome,
      workspaceRoot,
      installed: ALL_INSTALLED,
      recentUse: {},
      builderNoConsecutiveRepeat: false,
    });
    writeFileSync(join(workspaceRoot, "workspace.yaml"), JSON.stringify({ repositories: [{ repoId: "app" }] }));
    const oneRepository = resolve();
    writeFileSync(join(workspaceRoot, "workspace.yaml"), JSON.stringify({ repositories: [{ repoId: "app" }, { repoId: "api" }] }));
    const multiRepository = resolve();

    expect(multiRepository).toEqual(oneRepository);
  });
  it("keeps the assigned Supervisor visible without excluding it from the Builder pool by default", () => {
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedStoryExecute(repoCwd, { rollHome, installed: ALL_INSTALLED, recentUse: {} });
    expect(route).not.toBeNull();
    expect(route!.superviseAgent).toBe("codex");
    expect(route!.resolution.ok).toBe(true);
    if (route!.resolution.ok) {
      // Fresh-session independence is the isolation boundary; same agent brand
      // remains eligible unless the owner explicitly configures a strict rule.
      expect(route!.resolution.resolved.agent).toBe("claude");
      expect(route!.resolution.resolved.skipped).toEqual([]);
    }
  });

  it("rotates fairly: a recently-used Builder yields to a never-used candidate", () => {
    const { rollHome, repoCwd } = fixture();
    // claude built most recently; pi/agy/etc never used → least-recent skips claude.
    const route = resolveScopedStoryExecute(repoCwd, {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { claude: 1000, agy: 2000, kimi: 3000 },
    });
    expect(route!.resolution.ok).toBe(true);
    if (route!.resolution.ok) {
      // pi/reasonix/codex were never used; first declared never-used wins: pi.
      expect(route!.resolution.resolved.agent).toBe("pi");
    }
  });

  it("all supervise-capable agents stay eligible in the open pool", () => {
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedStoryExecute(repoCwd, { rollHome, installed: ALL_INSTALLED, recentUse: {} });
    const trace = scopedExecuteRouteTrace(route!);
    expect(trace.skipped).toEqual([]);
    expect(trace.candidates).toEqual(["claude", "agy", "kimi", "pi", "reasonix", "codex"]);
    expect(trace.supervise).toBe("codex");
  });

  it("returns null when no scoped agents.yaml is present", () => {
    const repoCwd = mkdtempSync(join(tmpdir(), "roll-bare-"));
    dirs.push(repoCwd);
    const route = resolveScopedStoryExecute(repoCwd, { rollHome: repoCwd, installed: ALL_INSTALLED });
    expect(route).toBeNull();
  });

  it("renders an auditable trace with candidates, skipped reasons, and selection", () => {
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedStoryExecute(repoCwd, { rollHome, installed: ALL_INSTALLED, recentUse: {} });
    const text = renderScopedExecuteRoute(scopedExecuteRouteTrace(route!));
    expect(text).toContain("builder route — story.execute");
    expect(text).toContain("Supervisor (supervise): codex");
    expect(text).toContain("strategy: least-recent");
    expect(text).toContain("ranked:");
    expect(text).toContain("skipped: (none)");
    expect(text).toContain("selected: claude");
  });

  it("US-AGENT-049: health-aware route keeps auth-degraded AGY visible but selects a healthy Builder", () => {
    const { rollHome, repoCwd } = healthAwareFixture();
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { kimi: 20, reasonix: 10 },
      healthSignals: [
        { agent: "agy", source: "cycle", status: "degraded", reason: "auth", observedAt: "2026-07-01T00:00:00Z" },
        { agent: "kimi", source: "cycle", status: "healthy", observedAt: "2026-07-01T00:01:00Z" },
        { agent: "reasonix", source: "cycle", status: "healthy", observedAt: "2026-07-01T00:02:00Z" },
      ],
    });
    expect(route).not.toBeNull();
    const trace = scopedExecuteRouteTrace(route!);
    expect(trace.candidates).toEqual(["agy", "kimi", "reasonix", "codex"]);
    expect(trace.ranked.map((r) => r.agent)).toContain("agy");
    expect(trace.ranked.find((r) => r.agent === "agy")?.warnings).toContain("health degraded:auth");
    expect(trace.ranked.find((r) => r.agent === "codex")?.eligible).toBe(true);
    expect(trace.selected).toBe("reasonix");
  });

  it("US-AGENT-049: evaluator route uses the same open pool with session-based execute avoidance", () => {
    const { rollHome, repoCwd } = healthAwareFixture();
    const route = resolveScopedCastRole(repoCwd, "evaluator", {
      rollHome,
      installed: ALL_INSTALLED,
      healthSignals: [
        { agent: "kimi", source: "score", status: "blocked", reason: "parser", observedAt: "2026-07-01T00:00:00Z" },
        { agent: "reasonix", source: "score", status: "healthy", observedAt: "2026-07-01T00:01:00Z" },
      ],
    });
    expect(route).not.toBeNull();
    const trace = scopedExecuteRouteTrace(route!);
    expect(trace.role).toBe("evaluate");
    expect(trace.castRole).toBe("evaluator");
    expect(trace.candidates).toEqual(["agy", "kimi", "reasonix", "codex"]);
    expect(trace.skipped).toContainEqual({ agent: "kimi", reason: "health-blocked: parser" });
    expect(trace.ranked.find((r) => r.agent === "kimi")?.eligible).toBe(false);
  });
});

describe("FIX-1267 — builder no-consecutive-repeat rotation", () => {
  it("mostRecentBuilder picks the largest-ts agent (deterministic on ties)", () => {
    expect(mostRecentBuilder({})).toBeNull();
    expect(mostRecentBuilder({ claude: 1000, agy: 3000, kimi: 2000 })).toBe("agy");
    // Tie on ts → deterministic by agent name (lexicographically smallest).
    expect(mostRecentBuilder({ pi: 5000, agy: 5000 })).toBe("agy");
  });

  it("excludes the previous builder (most-recent) and selects a different agent", () => {
    const { rollHome, repoCwd } = fixture();
    // agy built most recently → excluded; least-recent among the rest wins.
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { claude: 100, agy: 9000, kimi: 200 },
    });
    expect(route).not.toBeNull();
    expect(route!.previousBuilder).toBe("agy");
    expect(route!.resolution.ok).toBe(true);
    if (route!.resolution.ok) {
      expect(route!.resolution.resolved.agent).not.toBe("agy");
      expect(route!.resolution.resolved.skipped).toContainEqual({ agent: "agy", reason: "no-consecutive-repeat" });
    }
    // The audit trace surfaces the excluded previous builder.
    const trace = scopedExecuteRouteTrace(route!);
    expect(trace.previousBuilder).toBe("agy");
    expect(renderScopedExecuteRoute(trace)).toContain("previous builder (excluded — no-consecutive-repeat): agy");
  });

  it("retry / self-heal: an explicitly-supplied previous builder is excluded", () => {
    const { rollHome, repoCwd } = fixture();
    // Self-heal re-pick: the prior attempt's builder is passed in and excluded so
    // the swap actually changes who builds.
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: {},
      previousBuilder: "claude",
    });
    expect(route!.previousBuilder).toBe("claude");
    if (route!.resolution.ok) {
      expect(route!.resolution.resolved.agent).not.toBe("claude");
      expect(route!.resolution.resolved.skipped).toContainEqual({ agent: "claude", reason: "no-consecutive-repeat" });
    }
  });

  it("cross-goal-session boundary: the previous builder is derived from persisted runtime runs, not a session var", () => {
    const { rollHome, repoCwd } = fixture();
    // recentUse stands in for runs.jsonl, which persists across goal sessions —
    // a new goal session still excludes the last builder recorded on disk.
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { pi: 12345 },
    });
    expect(route!.previousBuilder).toBe("pi");
    if (route!.resolution.ok) expect(route!.resolution.resolved.agent).not.toBe("pi");
  });

  it("fails loud when the pool reduces to only the previous builder", () => {
    const { rollHome } = fixture();
    const repoCwd = mkdtempSync(join(tmpdir(), "roll-solo-"));
    dirs.push(repoCwd);
    mkdirSync(join(repoCwd, ".roll"), { recursive: true });
    // A single-agent execute pool whose only member just built.
    writeFileSync(
      join(repoCwd, ".roll", "agents.yaml"),
      `schema: roll-agents/v1
scope: project
inherits: machine
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [claude]
        require: [execute]
        strategy: least-recent
`,
    );
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: new Set(["claude"]),
      recentUse: { claude: 500 },
    });
    expect(route!.previousBuilder).toBe("claude");
    expect(route!.resolution.ok).toBe(false);
    if (!route!.resolution.ok) {
      expect(route!.resolution.failure.errors[0]).toContain("no-consecutive-repeat");
    }
  });

  it("config off: builder_no_consecutive_repeat=false disables the exclusion", () => {
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { claude: 100, agy: 9000 },
      builderNoConsecutiveRepeat: false,
    });
    expect(route!.previousBuilder).toBeNull();
    if (route!.resolution.ok) {
      // No exclusion → nothing skipped for rotation.
      expect(route!.resolution.resolved.skipped).toEqual([]);
    }
  });

  it("the rotation does NOT apply to the evaluator role", () => {
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedCastRole(repoCwd, "evaluator", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { claude: 100, agy: 9000 },
    });
    expect(route!.previousBuilder).toBeNull();
  });
});

// US-DELTA-006 — the Designer is a first-class `design` scope role, not a
// Builder alias, and a missing `design` binding fails closed (no fallback).
describe("US-DELTA-006 — roleToScopeRole mapping", () => {
  it("maps each cast role to its distinct scope role", () => {
    expect(roleToScopeRole("designer")).toBe("design");
    expect(roleToScopeRole("builder")).toBe("execute");
    expect(roleToScopeRole("evaluator")).toBe("evaluate");
    expect(roleToScopeRole("peer_reviewer")).toBe("evaluate");
  });

  it("NEVER maps the designer to execute (no quiet Builder-alias fallback)", () => {
    expect(roleToScopeRole("designer")).not.toBe("execute");
  });
});

const PROJECT_WITH_DESIGN = `schema: roll-agents/v1
scope: project
inherits: machine
defaults:
  story:
    roles:
      design:
        kind: select
        from: [claude, agy, kimi]
        require: [design]
        strategy: first-available
      execute:
        kind: select
        from: [claude, agy, kimi, pi, reasonix, codex]
        require: [execute]
        strategy: least-recent
`;

const MACHINE_WITH_DESIGN = `schema: roll-agents/v1
scope: machine
agents:
  claude:
    capabilities: [supervise, design, execute, evaluate]
  agy:
    capabilities: [supervise, design, execute, evaluate]
  kimi:
    capabilities: [supervise, design, execute, evaluate]
  pi:
    capabilities: [supervise, execute, evaluate]
  reasonix:
    capabilities: [supervise, execute, evaluate]
  codex:
    capabilities: [supervise, execute, evaluate]
roles:
  supervise:
    kind: fixed
    agent: codex
`;

describe("US-DELTA-006 — resolveScopedCastRole('designer') → design role", () => {
  it("resolves the designer to the `design` scope role (independent of execute)", () => {
    const rollHome = mkdtempSync(join(tmpdir(), "roll-home-des-"));
    const repoCwd = mkdtempSync(join(tmpdir(), "roll-proj-des-"));
    dirs.push(rollHome, repoCwd);
    writeFileSync(join(rollHome, "agents.yaml"), MACHINE_WITH_DESIGN);
    mkdirSync(join(repoCwd, ".roll"), { recursive: true });
    writeFileSync(join(repoCwd, ".roll", "agents.yaml"), PROJECT_WITH_DESIGN);

    const route = resolveScopedCastRole(repoCwd, "designer", { rollHome, installed: ALL_INSTALLED, recentUse: {} });
    expect(route).not.toBeNull();
    expect(route!.castRole).toBe("designer");
    expect(route!.scopeRole).toBe("design");
    expect(route!.resolution.ok).toBe(true);
    if (route!.resolution.ok) {
      // A design-capable agent — NOT forced to the builder's execute pool.
      expect(["claude", "agy", "kimi"]).toContain(route!.resolution.resolved.agent);
    }
  });

  it("FAILS CLOSED when no `design` binding exists — no fallback to execute", () => {
    // The default PROJECT fixture declares only an execute binding.
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedCastRole(repoCwd, "designer", { rollHome, installed: ALL_INSTALLED, recentUse: {} });
    expect(route).not.toBeNull();
    expect(route!.scopeRole).toBe("design");
    // No design binding → the resolution FAILS (the caller fails Full Delta
    // before the Builder), rather than quietly resolving an execute agent.
    expect(route!.resolution.ok).toBe(false);
    if (!route!.resolution.ok) {
      expect(route!.resolution.failure.errors.join(" ")).toContain("design");
    }
  });
});

function workspaceExecutionFixture(): {
  readonly context: WorkspaceExecutionContextV1;
  readonly execution: CycleRepositoryExecutionContext;
} {
  const root = "/workspace/roll";
  const storyId = "US-WS-033";
  const issueRoot = `${root}/issues/${storyId}`;
  const remote = "git@github.com:seanyao/roll.git";
  const parsedRepoId = repositoryIdFromRemote(remote);
  if (!parsedRepoId.ok) throw new Error("fixture remote must be canonicalizable");
  const binding = {
    schema: REPOSITORY_BINDING_V1,
    repoId: parsedRepoId.value,
    alias: "product",
    remote,
    integrationBranch: "idea-074-workspace",
    provider: "github",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  } as const;
  const context: WorkspaceExecutionContextV1 = {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: {
      workspaceId: "roll",
      root,
      canonicalRoot: root,
      lifecycle: "active",
    },
    resolution: { source: "requirement_discovery", evidence: [] },
    bindings: [binding],
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
    repositories: {
      [binding.repoId]: {
        repoId: binding.repoId,
        alias: binding.alias,
        access: "write",
        requiredDelivery: true,
        noChangePolicy: "changes_required",
        workBranch: "roll/roll/US-WS-033",
        worktreePath: `${issueRoot}/${binding.alias}`,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        commands: { test: ["pnpm test"], integration: [] },
      },
    },
  };
  return { context, execution };
}

describe("US-WS-033 — frozen Workspace cycle route", () => {
  it("selects only one exact requirement match and never the sole active Workspace", () => {
    const decision = resolveRequirementMatchedWorkspace({
      storyIds: ["US-WS-033"],
      workspaces: [
        {
          candidate: {
            workspaceId: "wrong-active",
            root: "/workspace/wrong-active",
            canonicalRoot: "/workspace/wrong-active",
            manifestWorkspaceId: "wrong-active",
            pathState: "valid",
            lifecycle: "active",
          },
          manifest: {
            schema: "roll.workspace/v1",
            workspaceId: "wrong-active",
            displayName: "Wrong active",
            requirements: [],
            repositories: workspaceExecutionFixture().context.bindings,
          },
          issues: [],
        },
        {
          candidate: {
            workspaceId: "roll",
            root: "/workspace/roll",
            canonicalRoot: "/workspace/roll",
            manifestWorkspaceId: "roll",
            pathState: "valid",
            lifecycle: "registered",
          },
          manifest: {
            schema: "roll.workspace/v1",
            workspaceId: "roll",
            displayName: "Roll",
            requirements: [],
            repositories: workspaceExecutionFixture().context.bindings,
          },
          issues: [{
            storyId: "US-WS-033",
            workspaceId: "roll",
            requirements: [],
          }],
        },
      ],
      diagnostics: [],
      cwd: "/tmp",
      operation: "mutation",
    });

    expect(decision).toMatchObject({ ok: false, code: "workspace_activation_required" });
    if (!decision.ok) expect(decision.candidates.map((candidate) => candidate.workspaceId)).toEqual(["roll"]);
  });

  it("freezes one serializable Workspace/Issue context and restores the same authority after cwd changes", () => {
    const { context, execution } = workspaceExecutionFixture();
    const frozen = freezeWorkspaceCycleContext({ workspace: context, storyId: "US-WS-033", execution });
    expect(frozen.ok ? "ok" : frozen.code).toBe("ok");
    if (!frozen.ok) return;

    expect(Object.isFrozen(frozen.context)).toBe(true);
    expect(Object.isFrozen(frozen.context.issue?.execution.repositories)).toBe(true);
    const replayed = restoreWorkspaceCycleContext(JSON.stringify(frozen.context));
    expect(replayed).toEqual(frozen);
    if (!replayed.ok) return;
    expect(replayed.context.workspace.workspaceId).toBe("roll");
    expect(replayed.context.issue?.storyId).toBe("US-WS-033");
    expect(replayed.context.authorities.backlog).toBe("/workspace/roll/backlog/index.md");
  });

  it("persists one immutable cycle snapshot and restores it after process-local context is gone", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "roll-ws-033-cycle-context-"));
    dirs.push(runtimeDir);
    const { context, execution } = workspaceExecutionFixture();
    const frozen = freezeWorkspaceCycleContext({ workspace: context, storyId: "US-WS-033", execution });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;

    const persisted = persistWorkspaceCycleContext(runtimeDir, "cycle-033", frozen.context);
    expect(persisted).toEqual(frozen);
    expect(workspaceCycleContextPath(runtimeDir, "cycle-033")).toContain("cycle-contexts");

    const restored = restorePersistedWorkspaceCycleContext(runtimeDir, "cycle-033");
    expect(restored).toEqual(frozen);
    if (!restored.ok) return;
    expect(Object.isFrozen(restored.context)).toBe(true);
    expect(restored.context.workspace.workspaceId).toBe("roll");
    expect(restored.context.issue?.storyId).toBe("US-WS-033");
  });

  it("fails closed instead of replacing an existing cycle authority snapshot", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "roll-ws-033-cycle-conflict-"));
    dirs.push(runtimeDir);
    const { context, execution } = workspaceExecutionFixture();
    const frozen = freezeWorkspaceCycleContext({ workspace: context, storyId: "US-WS-033", execution });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(persistWorkspaceCycleContext(runtimeDir, "cycle-conflict", frozen.context)).toMatchObject({ ok: true });

    const redirected = {
      ...frozen.context,
      resolution: { ...frozen.context.resolution, source: "explicit" as const },
    };
    expect(persistWorkspaceCycleContext(runtimeDir, "cycle-conflict", redirected)).toEqual({
      ok: false,
      code: "execution_context_conflict",
    });
    expect(restorePersistedWorkspaceCycleContext(runtimeDir, "cycle-conflict")).toEqual(frozen);
  });

  it("atomically fails closed when different snapshots race to create one cycle context", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "roll-ws-033-cycle-race-"));
    dirs.push(runtimeDir);
    const { context, execution } = workspaceExecutionFixture();
    const frozen = freezeWorkspaceCycleContext({ workspace: context, storyId: "US-WS-033", execution });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;

    const largeDetail = "x".repeat(16 * 1024 * 1024);
    const first = {
      ...frozen.context,
      resolution: {
        source: "requirement_discovery" as const,
        evidence: [{
          kind: "issue_exact" as const,
          value: "US-WS-033",
          hard: true,
          score: 100,
          source: "first",
          provenance: "explicit_user" as const,
          detail: largeDetail,
        }],
      },
    };
    const second = {
      ...first,
      resolution: {
        ...first.resolution,
        source: "explicit" as const,
        evidence: [{ ...first.resolution.evidence[0]!, source: "second" }],
      },
    };
    const firstPath = join(runtimeDir, "first.json");
    const secondPath = join(runtimeDir, "second.json");
    const barrierPath = join(runtimeDir, "barrier");
    const readyPaths = [join(runtimeDir, "ready-first"), join(runtimeDir, "ready-second")];
    writeFileSync(firstPath, JSON.stringify(first), "utf8");
    writeFileSync(secondPath, JSON.stringify(second), "utf8");
    writeFileSync(barrierPath, "wait", "utf8");

    const children = [
      persistInChild({ runtimeDir, cycleId: "cycle-race", contextPath: firstPath, barrierPath, readyPath: readyPaths[0]! }),
      persistInChild({ runtimeDir, cycleId: "cycle-race", contextPath: secondPath, barrierPath, readyPath: readyPaths[1]! }),
    ];
    await waitUntilReady(readyPaths);
    writeFileSync(barrierPath, "go", "utf8");
    const results = await Promise.all(children);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    const persisted = results.map((result) => JSON.parse(result.stdout.trim()) as
      | { readonly ok: true; readonly resolutionSource: string; readonly evidenceSource: string | undefined }
      | { readonly ok: false; readonly code: string });
    expect(persisted.filter((result) => result.ok)).toHaveLength(1);
    expect(persisted.find((result) => !result.ok)).toEqual({ ok: false, code: "execution_context_conflict" });

    const restored = restorePersistedWorkspaceCycleContext(runtimeDir, "cycle-race");
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const winner = persisted.find((result) => result.ok);
    expect(winner?.ok).toBe(true);
    if (!winner?.ok) return;
    expect(restored.context.resolution.source).toBe(winner.resolutionSource);
    expect(restored.context.resolution.evidence[0]?.source).toBe(winner.evidenceSource);
  }, 30_000);

  it("requires an explicit repository for repository-required actions", () => {
    const { context, execution } = workspaceExecutionFixture();
    const frozen = freezeWorkspaceCycleContext({ workspace: context, storyId: "US-WS-033", execution });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;

    expect(resolveWorkspaceCycleRepository(frozen.context)).toMatchObject({
      ok: true,
      repoId: frozen.context.bindings[0]?.repoId,
      repository: { alias: "product" },
    });
    expect(resolveWorkspaceCycleRepository(frozen.context, frozen.context.bindings[0]?.repoId)).toMatchObject({
      ok: true,
      repository: { alias: "product" },
    });
  });
});
