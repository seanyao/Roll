import { describe, expect, it } from "vitest";
import { normalizeAgentScopeConfig } from "../src/agent/scope-config.js";
import { resolveAgentScopeRole, type AgentScopeResolveLayer } from "../src/agent/scope-resolver.js";

function cfg(text: string, path: string): AgentScopeResolveLayer {
  const { config, errors } = normalizeAgentScopeConfig(text);
  expect(errors).toEqual([]);
  expect(config).not.toBeNull();
  return { config: config!, path };
}

const MACHINE = cfg(`schema: roll-agents/v1
scope: machine
agents:
  codex:
    capabilities: [supervise, execute]
  kimi:
    capabilities: [execute, evaluate]
  pi:
    capabilities: [evaluate]
roles:
  supervise:
    kind: fixed
    agent: codex
  execute:
    kind: fixed
    agent: codex
`, "~/.roll/agents.yaml");

const PROJECT = cfg(`schema: roll-agents/v1
scope: project
inherits: machine
roles:
  supervise:
    kind: inherit
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [codex, kimi]
        require: [execute]
        strategy: first-available
  skill:
    roles:
      evaluate:
        kind: fixed
        agent: pi
`, ".roll/agents.yaml");

const WORKSPACE = cfg(`schema: roll-agents/v1
scope: workspace
inherits: machine
roles:
  supervise:
    kind: inherit
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [kimi, codex]
        strategy: first-available
  skill:
    roles:
      evaluate:
        kind: fixed
        agent: pi
`, "/workspaces/payments/agents.yaml");

describe("resolveAgentScopeRole — US-V4-016", () => {
  it("resolves machine -> workspace -> story -> skill and excludes project policy", () => {
    const project = cfg(`schema: roll-agents/v1
scope: project
roles:
  supervise:
    kind: fixed
    agent: kimi
defaults:
  story:
    roles:
      execute:
        kind: fixed
        agent: codex
`, ".roll/agents.yaml");

    const supervise = resolveAgentScopeRole({
      scope: "workspace",
      role: "supervise",
      layers: [MACHINE, project, WORKSPACE],
    });
    expect(supervise.ok).toBe(true);
    if (supervise.ok) {
      expect(supervise.resolved.agent).toBe("codex");
      expect(supervise.resolved.trace).toEqual([
        { source: "/workspaces/payments/agents.yaml:roles.supervise", bindingKind: "inherit", action: "inherit" },
        { source: "~/.roll/agents.yaml:roles.supervise", bindingKind: "fixed", action: "resolve" },
      ]);
    }

    const story = resolveAgentScopeRole({
      scope: "story",
      role: "execute",
      layers: [MACHINE, project, WORKSPACE],
    });
    expect(story.ok).toBe(true);
    if (story.ok) {
      expect(story.resolved.agent).toBe("kimi");
      expect(story.resolved.source).toBe("/workspaces/payments/agents.yaml:defaults.story.roles.execute");
      expect(story.resolved.candidates).toEqual(["kimi", "codex"]);
    }

    const skill = resolveAgentScopeRole({
      scope: "skill",
      role: "evaluate",
      layers: [MACHINE, project, WORKSPACE],
    });
    expect(skill.ok).toBe(true);
    if (skill.ok) expect(skill.resolved.source).toBe("/workspaces/payments/agents.yaml:defaults.skill.roles.evaluate");
  });

  it("fails workspace fixed bindings that are absent or inapplicable in machine scope", () => {
    const machine = cfg(`schema: roll-agents/v1
scope: machine
agents:
  codex:
    capabilities: [execute]
    models: [gpt-5.5]
`, "~/.roll/agents.yaml");
    const undeclared = cfg(`schema: roll-agents/v1
scope: workspace
inherits: machine
roles:
  execute: { use: kimi }
`, "/workspaces/payments/agents.yaml");
    const wrongCapability = cfg(`schema: roll-agents/v1
scope: workspace
inherits: machine
roles:
  evaluate: { use: codex }
`, "/workspaces/payments/agents.yaml");
    const wrongModel = cfg(`schema: roll-agents/v1
scope: workspace
inherits: machine
roles:
  execute:
    kind: fixed
    agent: codex
    model: gpt-6
`, "/workspaces/payments/agents.yaml");

    for (const [role, layer, error] of [
      ["execute", undeclared, "fixed agent 'kimi' is not declared in machine scope"],
      ["evaluate", wrongCapability, "fixed agent 'codex' lacks role capability 'evaluate'"],
      ["execute", wrongModel, "fixed model 'gpt-6' is not declared for machine agent 'codex'"],
    ] as const) {
      const resolved = resolveAgentScopeRole({ scope: "workspace", role, layers: [machine, layer] });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.failure.errors[0]).toContain(error);
    }
  });

  it("keeps undeclared and role-incompatible workspace select candidates visible as skipped", () => {
    const machine = cfg(`schema: roll-agents/v1
scope: machine
agents:
  codex:
    capabilities: [execute]
  pi:
    capabilities: [evaluate]
`, "~/.roll/agents.yaml");
    const workspace = cfg(`schema: roll-agents/v1
scope: workspace
inherits: machine
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [kimi, pi, codex]
`, "/workspaces/payments/agents.yaml");
    const resolved = resolveAgentScopeRole({ scope: "story", role: "execute", layers: [machine, workspace] });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved.agent).toBe("codex");
      expect(resolved.resolved.skipped).toEqual([
        { agent: "kimi", reason: "not-declared-in-machine" },
        { agent: "pi", reason: "missing-role-capability: execute" },
      ]);
    }
  });
  it("resolves machine -> project inheritance and direct story override", () => {
    const projectSupervise = resolveAgentScopeRole({
      scope: "project",
      role: "supervise",
      layers: [MACHINE, PROJECT],
    });
    expect(projectSupervise).toEqual({
      ok: true,
      resolved: {
        scope: "project",
        role: "supervise",
        agent: "codex",
        binding: { kind: "fixed", agent: "codex" },
        source: "~/.roll/agents.yaml:roles.supervise",
        selectedStrategy: "fixed",
        candidates: ["codex"],
        skipped: [],
        trace: [
          { source: ".roll/agents.yaml:roles.supervise", bindingKind: "inherit", action: "inherit" },
          { source: "~/.roll/agents.yaml:roles.supervise", bindingKind: "fixed", action: "resolve" },
        ],
      },
    });

    const story = cfg(`schema: roll-agents/v1
scope: story
roles:
  execute:
    kind: fixed
    agent: kimi
`, ".roll/story/US-1/agents.yaml");
    const storyExecute = resolveAgentScopeRole({ scope: "story", role: "execute", layers: [MACHINE, PROJECT, story] });
    expect(storyExecute.ok).toBe(true);
    if (storyExecute.ok) {
      expect(storyExecute.resolved.agent).toBe("kimi");
      expect(storyExecute.resolved.source).toBe(".roll/story/US-1/agents.yaml:roles.execute");
    }
  });

  it("resolves full machine -> project -> story -> skill recursive inheritance", () => {
    const machine = cfg(`schema: roll-agents/v1
scope: machine
roles:
  execute:
    kind: fixed
    agent: codex
`, "~/.roll/agents.yaml");
    const project = cfg(`schema: roll-agents/v1
scope: project
roles:
  execute:
    kind: inherit
`, ".roll/agents.yaml");
    const story = cfg(`schema: roll-agents/v1
scope: story
roles:
  execute:
    kind: inherit
`, ".roll/story/US-1/agents.yaml");
    const skill = cfg(`schema: roll-agents/v1
scope: skill
roles:
  execute:
    kind: inherit
`, ".roll/skills/build/agents.yaml");
    const resolved = resolveAgentScopeRole({ scope: "skill", role: "execute", layers: [machine, project, story, skill] });
    expect(resolved).toEqual({
      ok: true,
      resolved: {
        scope: "skill",
        role: "execute",
        agent: "codex",
        binding: { kind: "fixed", agent: "codex" },
        source: "~/.roll/agents.yaml:roles.execute",
        selectedStrategy: "fixed",
        candidates: ["codex"],
        skipped: [],
        trace: [
          { source: ".roll/skills/build/agents.yaml:roles.execute", bindingKind: "inherit", action: "inherit" },
          { source: ".roll/story/US-1/agents.yaml:roles.execute", bindingKind: "inherit", action: "inherit" },
          { source: ".roll/agents.yaml:roles.execute", bindingKind: "inherit", action: "inherit" },
          { source: "~/.roll/agents.yaml:roles.execute", bindingKind: "fixed", action: "resolve" },
        ],
      },
    });
  });

  it("uses project defaults for story and skill scopes", () => {
    const storyExecute = resolveAgentScopeRole({ scope: "story", role: "execute", layers: [MACHINE, PROJECT] });
    expect(storyExecute.ok).toBe(true);
    if (storyExecute.ok) {
      expect(storyExecute.resolved.agent).toBe("codex");
      expect(storyExecute.resolved.source).toBe(".roll/agents.yaml:defaults.story.roles.execute");
      expect(storyExecute.resolved.selectedStrategy).toBe("first-available");
      expect(storyExecute.resolved.candidates).toEqual(["codex", "kimi"]);
    }

    const skillEvaluate = resolveAgentScopeRole({ scope: "skill", role: "evaluate", layers: [MACHINE, PROJECT] });
    expect(skillEvaluate.ok).toBe(true);
    if (skillEvaluate.ok) {
      expect(skillEvaluate.resolved.agent).toBe("pi");
      expect(skillEvaluate.resolved.source).toBe(".roll/agents.yaml:defaults.skill.roles.evaluate");
    }
  });

  it("includes optional model in the resolved fixed-binding audit", () => {
    const machine = cfg(`schema: roll-agents/v1
scope: machine
roles:
  supervise:
    kind: fixed
    agent: codex
    model: gpt-5.5
`, "~/.roll/agents.yaml");
    const resolved = resolveAgentScopeRole({ scope: "machine", role: "supervise", layers: [machine] });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved).toEqual({
        scope: "machine",
        role: "supervise",
        agent: "codex",
        model: "gpt-5.5",
        binding: { kind: "fixed", agent: "codex", model: "gpt-5.5" },
        source: "~/.roll/agents.yaml:roles.supervise",
        selectedStrategy: "fixed",
        candidates: ["codex"],
        skipped: [],
        trace: [{ source: "~/.roll/agents.yaml:roles.supervise", bindingKind: "fixed", action: "resolve" }],
      });
    }
  });

  it("skips temporarily unavailable candidates without mutating config", () => {
    const before = JSON.stringify(PROJECT.config);
    const resolved = resolveAgentScopeRole({
      scope: "story",
      role: "execute",
      layers: [MACHINE, PROJECT],
      runtimeHealth: { codex: { available: false, reason: "auth" } },
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved.agent).toBe("kimi");
      expect(resolved.resolved.skipped).toEqual([{ agent: "codex", reason: "unavailable: auth" }]);
      expect(resolved.resolved.candidates).toEqual(["codex", "kimi"]);
    }
    expect(JSON.stringify(PROJECT.config)).toBe(before);
  });

  it("avoid-current-role skips the agent already assigned to that role", () => {
    const project = cfg(`schema: roll-agents/v1
scope: project
agents:
  codex:
    capabilities: [execute, evaluate]
  pi:
    capabilities: [evaluate]
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [codex, pi]
        require: [evaluate]
        avoid: [execute]
`, ".roll/agents.yaml");
    const resolved = resolveAgentScopeRole({
      scope: "story",
      role: "evaluate",
      layers: [project],
      assignedRoles: { execute: "codex" },
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved.agent).toBe("pi");
      expect(resolved.resolved.skipped).toEqual([{ agent: "codex", reason: "assigned-to-avoided-role: execute" }]);
    }
  });

  it("FIX-1047: avoid:[supervise] excludes only the assigned Prime, not every supervise-capable agent", () => {
    // claude, agy, and codex all DECLARE supervise capability; only codex is the
    // assigned Prime. avoid must skip codex by identity and keep claude/agy eligible.
    const project = cfg(`schema: roll-agents/v1
scope: project
agents:
  claude:
    capabilities: [supervise, execute, evaluate]
  agy:
    capabilities: [supervise, execute, evaluate]
  codex:
    capabilities: [supervise, execute, evaluate]
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [claude, agy, codex]
        require: [execute]
        avoid: [supervise]
        strategy: first-available
`, ".roll/agents.yaml");
    const resolved = resolveAgentScopeRole({
      scope: "story",
      role: "execute",
      layers: [project],
      assignedRoles: { supervise: "codex" },
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      // claude is first-available and supervise-capable but NOT the Prime → eligible.
      expect(resolved.resolved.agent).toBe("claude");
      expect(resolved.resolved.candidates).toEqual(["claude", "agy", "codex"]);
      // Only the assigned Prime (codex) is skipped, and by assignment not capability.
      expect(resolved.resolved.skipped).toEqual([
        { agent: "codex", reason: "assigned-to-avoided-role: supervise" },
      ]);
    }
  });

  it("FIX-1047: with no supervise assignment, avoid:[supervise] is a no-op and the Prime-capable agent is eligible", () => {
    const project = cfg(`schema: roll-agents/v1
scope: project
agents:
  codex:
    capabilities: [supervise, execute, evaluate]
  pi:
    capabilities: [supervise, execute, evaluate]
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [codex, pi]
        require: [execute]
        avoid: [supervise]
        strategy: first-available
`, ".roll/agents.yaml");
    const resolved = resolveAgentScopeRole({ scope: "story", role: "execute", layers: [project] });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved.agent).toBe("codex");
      expect(resolved.resolved.skipped).toEqual([]);
    }
  });

  it("select without from uses the declared agent pool", () => {
    const project = cfg(`schema: roll-agents/v1
scope: project
agents:
  codex:
    capabilities: [evaluate]
  pi:
    capabilities: [evaluate]
defaults:
  story:
    roles:
      evaluate:
        kind: select
        require: [evaluate]
`, ".roll/agents.yaml");
    const resolved = resolveAgentScopeRole({ scope: "story", role: "evaluate", layers: [project] });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved.agent).toBe("codex");
      expect(resolved.resolved.candidates).toEqual(["codex", "pi"]);
    }
  });

  it("select.require skips candidates lacking required capabilities", () => {
    const project = cfg(`schema: roll-agents/v1
scope: project
agents:
  codex:
    capabilities: [execute]
  pi:
    capabilities: [evaluate]
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [codex, pi]
        require: [evaluate]
`, ".roll/agents.yaml");
    const resolved = resolveAgentScopeRole({ scope: "story", role: "evaluate", layers: [project] });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved.agent).toBe("pi");
      expect(resolved.resolved.skipped).toEqual([{ agent: "codex", reason: "missing-required-capability: evaluate" }]);
    }
  });

  it("supports least-recent and deterministic seeded-random selection", () => {
    const project = cfg(`schema: roll-agents/v1
scope: project
agents:
  codex:
    capabilities: [evaluate]
  kimi:
    capabilities: [evaluate]
  pi:
    capabilities: [evaluate]
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [codex, kimi, pi]
        require: [evaluate]
        strategy: least-recent
`, ".roll/agents.yaml");
    const leastRecent = resolveAgentScopeRole({
      scope: "story",
      role: "evaluate",
      layers: [project],
      recentUse: { codex: 30, kimi: 10, pi: 20 },
    });
    expect(leastRecent.ok).toBe(true);
    if (leastRecent.ok) expect(leastRecent.resolved.agent).toBe("kimi");

    const seededProject = cfg(`schema: roll-agents/v1
scope: project
agents:
  codex:
    capabilities: [evaluate]
  kimi:
    capabilities: [evaluate]
  pi:
    capabilities: [evaluate]
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [codex, kimi, pi]
        require: [evaluate]
        strategy: seeded-random
`, ".roll/agents.yaml");
    const a = resolveAgentScopeRole({ scope: "story", role: "evaluate", layers: [seededProject], seed: "US-123" });
    const b = resolveAgentScopeRole({ scope: "story", role: "evaluate", layers: [seededProject], seed: "US-123" });
    const c = resolveAgentScopeRole({ scope: "story", role: "evaluate", layers: [seededProject], seed: "US-124" });
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    expect(c.ok).toBe(true);
    if (a.ok && c.ok) {
      expect(a.resolved.agent).toBe("kimi");
      expect(c.resolved.agent).toBe("pi");
    }
  });

  it("fails loud for unavailable fixed bindings instead of silently falling back", () => {
    const resolved = resolveAgentScopeRole({
      scope: "machine",
      role: "execute",
      layers: [MACHINE],
      runtimeHealth: { codex: { available: false, reason: "vpn" } },
    });
    expect(resolved).toEqual({
      ok: false,
      failure: {
        scope: "machine",
        role: "execute",
        source: "~/.roll/agents.yaml:roles.execute",
        errors: ["~/.roll/agents.yaml:roles.execute: fixed agent 'codex' unavailable: vpn"],
        candidates: ["codex"],
        skipped: [{ agent: "codex", reason: "unavailable: vpn" }],
        trace: [{ source: "~/.roll/agents.yaml:roles.execute", bindingKind: "fixed", action: "fail" }],
      },
    });
  });

  it("fails loud when selection has no available candidates", () => {
    const resolved = resolveAgentScopeRole({
      scope: "story",
      role: "execute",
      layers: [MACHINE, PROJECT],
      runtimeHealth: {
        codex: { available: false, reason: "auth" },
        kimi: { available: false, reason: "rate-limit" },
      },
    });
    expect(resolved).toEqual({
      ok: false,
      failure: {
        scope: "story",
        role: "execute",
        source: ".roll/agents.yaml:defaults.story.roles.execute",
        errors: [".roll/agents.yaml:defaults.story.roles.execute: no candidates available"],
        candidates: ["codex", "kimi"],
        skipped: [
          { agent: "codex", reason: "unavailable: auth" },
          { agent: "kimi", reason: "unavailable: rate-limit" },
        ],
        trace: [{ source: ".roll/agents.yaml:defaults.story.roles.execute", bindingKind: "select", action: "fail" }],
      },
    });
  });

  it("fails loud when selection has a literally empty candidate pool", () => {
    const project = cfg(`schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: select
`, ".roll/agents.yaml");
    const resolved = resolveAgentScopeRole({ scope: "story", role: "evaluate", layers: [project] });
    expect(resolved).toEqual({
      ok: false,
      failure: {
        scope: "story",
        role: "evaluate",
        source: ".roll/agents.yaml:defaults.story.roles.evaluate",
        errors: [".roll/agents.yaml:defaults.story.roles.evaluate: no candidates available"],
        candidates: [],
        skipped: [],
        trace: [{ source: ".roll/agents.yaml:defaults.story.roles.evaluate", bindingKind: "select", action: "fail" }],
      },
    });
  });

  it("US-AGENT-049: health-aware strategy ranks healthy candidates before auth-degraded least-recent candidates", () => {
    const project = cfg(`schema: roll-agents/v1
scope: project
agents:
  agy:
    capabilities: [execute]
  kimi:
    capabilities: [execute]
  reasonix:
    capabilities: [execute]
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [agy, kimi, reasonix]
        require: [execute]
        strategy: health-aware
`, ".roll/agents.yaml");
    const resolved = resolveAgentScopeRole({
      scope: "story",
      role: "execute",
      layers: [project],
      recentUse: { kimi: 20, reasonix: 10 },
      healthSignals: [
        { agent: "agy", source: "cycle", status: "degraded", reason: "auth", observedAt: "2026-07-01T00:00:00Z" },
        { agent: "kimi", source: "cycle", status: "healthy", observedAt: "2026-07-01T00:01:00Z" },
        { agent: "reasonix", source: "cycle", status: "healthy", observedAt: "2026-07-01T00:02:00Z" },
      ],
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved.agent).toBe("reasonix");
      expect(resolved.resolved.selectedStrategy).toBe("health-aware");
      expect(resolved.resolved.candidates).toEqual(["agy", "kimi", "reasonix"]);
      expect(resolved.resolved.skipped).toEqual([]);
    }
  });

  it("US-AGENT-049: health-blocked candidates remain visible as skipped and are not selected", () => {
    const project = cfg(`schema: roll-agents/v1
scope: project
agents:
  agy:
    capabilities: [execute]
  kimi:
    capabilities: [execute]
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [agy, kimi]
        require: [execute]
        strategy: health-aware
`, ".roll/agents.yaml");
    const resolved = resolveAgentScopeRole({
      scope: "story",
      role: "execute",
      layers: [project],
      healthSignals: [
        { agent: "agy", source: "probe", status: "blocked", reason: "auth", observedAt: "2026-07-01T00:00:00Z" },
        { agent: "kimi", source: "cycle", status: "healthy", observedAt: "2026-07-01T00:01:00Z" },
      ],
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved.agent).toBe("kimi");
      expect(resolved.resolved.skipped).toEqual([{ agent: "agy", reason: "health-blocked: auth" }]);
    }
  });

  describe("FIX-1267 — excludeAgents (no-consecutive-repeat rotation)", () => {
    const POOL = cfg(`schema: roll-agents/v1
scope: project
agents:
  agy:
    capabilities: [execute]
  kimi:
    capabilities: [execute]
  pi:
    capabilities: [execute]
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [agy, kimi, pi]
        require: [execute]
        strategy: first-available
`, ".roll/agents.yaml");

    it("hard-skips an excluded agent with reason no-consecutive-repeat and selects a different one", () => {
      const resolved = resolveAgentScopeRole({
        scope: "story",
        role: "execute",
        layers: [POOL],
        excludeAgents: ["agy"],
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.resolved.agent).not.toBe("agy");
        expect(resolved.resolved.agent).toBe("kimi");
        expect(resolved.resolved.skipped).toContainEqual({ agent: "agy", reason: "no-consecutive-repeat" });
        expect(resolved.resolved.candidates).toEqual(["agy", "kimi", "pi"]);
      }
    });

    it("fails loud with an actionable message when the exclusion empties the pool", () => {
      const single = cfg(`schema: roll-agents/v1
scope: project
agents:
  agy:
    capabilities: [execute]
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [agy]
        require: [execute]
        strategy: first-available
`, ".roll/agents.yaml");
      const resolved = resolveAgentScopeRole({
        scope: "story",
        role: "execute",
        layers: [single],
        excludeAgents: ["agy"],
      });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.failure.skipped).toEqual([{ agent: "agy", reason: "no-consecutive-repeat" }]);
        expect(resolved.failure.errors[0]).toContain("no-consecutive-repeat");
        expect(resolved.failure.errors[0]).toContain("only the previous builder");
      }
    });

    it("a fixed owner binding ignores excludeAgents (an explicit pin is never overridden)", () => {
      const fixed = cfg(`schema: roll-agents/v1
scope: project
agents:
  agy:
    capabilities: [execute]
roles:
  execute:
    kind: fixed
    agent: agy
`, ".roll/agents.yaml");
      const resolved = resolveAgentScopeRole({
        scope: "project",
        role: "execute",
        layers: [fixed],
        excludeAgents: ["agy"],
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.resolved.agent).toBe("agy");
    });
  });
});
