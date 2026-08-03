import { describe, expect, it } from "vitest";
import { normalizeAgentConfig } from "../src/agent/config-v4.js";
import { normalizeAgentCapacityPolicy } from "../src/agent/capacity.js";
import { normalizeAgentScopeConfig } from "../src/agent/scope-config.js";

const MACHINE = `schema: roll-agents/v1
scope: machine

agents:
  codex:
    adapter: codex
    home: ~/.codex
    convention: AGENTS.md
    capabilities: [supervise, execute, evaluate]
    models: [gpt-5.5]
  reasonix:
    adapter: reasonix
    capabilities: [execute, evaluate]

models:
  gpt-5.5:
    provider: openai
    context_tokens: 200000
    cost_class: high

roles:
  supervise:
    kind: fixed
    agent: codex
`;

const PROJECT = `schema: roll-agents/v1
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
        from: [reasonix, kimi]
        require: [execute]
        strategy: least-recent
      evaluate:
        select:
          from: [pi, kimi, codex]
          require: [evaluate]
          avoid: [execute]
          strategy: seeded-random
  skill:
    roles:
      evaluate:
        kind: fixed
        agent: codex
        model: gpt-5.5
`;

describe("normalizeAgentScopeConfig — roll-agents/v1", () => {
  it("parses the closed machine capacity policy", () => {
    const { config, errors } = normalizeAgentScopeConfig(`${MACHINE}
capacity:
  global: auto
  default_per_agent: 2
  agents:
    codex: 3
    reasonix: 1
  heartbeat_seconds: 20
  stale_after_seconds: 90
`);

    expect(errors).toEqual([]);
    expect(config?.capacity).toEqual({
      global: "auto",
      defaultPerAgent: 2,
      agents: { codex: 3, reasonix: 1 },
      heartbeatSeconds: 20,
      staleAfterSeconds: 90,
    });
  });

  it("derives one slot per enabled machine agent when capacity is absent", () => {
    const { config, errors } = normalizeAgentScopeConfig(`${MACHINE}
agents:
  codex:
    adapter: codex
    capabilities: [execute]
  reasonix:
    adapter: reasonix
    capabilities: [execute]
    disabled: true
  kimi:
    adapter: kimi
    capabilities: [execute]
`);

    expect(errors).toEqual([]);
    expect(config).not.toBeNull();
    expect(normalizeAgentCapacityPolicy(config!)).toEqual({
      global: 2,
      perAgent: { codex: 1, kimi: 1 },
      heartbeatSeconds: 30,
      staleAfterSeconds: 120,
    });
  });

  it("rejects capacity outside machine scope and invalid closed policy values", () => {
    const lower = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: workspace
inherits: machine
capacity:
  global: 1
`);
    expect(lower.errors).toContain("workspace: key 'capacity' is not allowed");

    const invalid = normalizeAgentScopeConfig(`${MACHINE}
capacity:
  global: 1
  default_per_agent: 0
  agents:
    codex: 2
    openai: 1
    unknown: 1
  heartbeat_seconds: 60
  stale_after_seconds: 30
  surprise: true
`);
    expect(invalid.errors).toEqual([
      "capacity.surprise: unknown key",
      "capacity.default_per_agent: expected a positive integer",
      "capacity.agents.openai: duplicate canonical agent 'codex' (already declared as 'codex')",
      "capacity.agents.unknown: unknown agent",
      "capacity.stale_after_seconds: must be greater than heartbeat_seconds",
      "capacity.global: must be at least the largest per-agent limit (2)",
    ]);
  });

  it("parses machine scope agents, models, and supervise binding", () => {
    const { config, errors } = normalizeAgentScopeConfig(MACHINE);
    expect(errors).toEqual([]);
    expect(config).toEqual({
      schema: "roll-agents/v1",
      scope: "machine",
      agents: {
        codex: {
          id: "codex",
          adapter: "codex",
          home: "~/.codex",
          convention: "AGENTS.md",
          capabilities: ["supervise", "execute", "evaluate"],
          models: ["gpt-5.5"],
        },
        reasonix: {
          id: "reasonix",
          adapter: "reasonix",
          capabilities: ["execute", "evaluate"],
        },
      },
      models: {
        "gpt-5.5": { id: "gpt-5.5", provider: "openai", contextTokens: 200000, costClass: "high" },
      },
      roles: {
        supervise: { kind: "fixed", agent: "codex" },
      },
      defaults: {},
    });
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });

  it("parses project inheritance, story defaults, and skill defaults", () => {
    const { config, errors } = normalizeAgentScopeConfig(PROJECT);
    expect(errors).toEqual([]);
    expect(config?.scope).toBe("project");
    expect(config?.inherits).toBe("machine");
    expect(config?.roles.supervise).toEqual({ kind: "inherit" });
    expect(config?.defaults.story.roles.execute).toEqual({
      kind: "select",
      from: ["reasonix", "kimi"],
      require: ["execute"],
      avoid: [],
      strategy: "least-recent",
    });
    expect(config?.defaults.story.roles.evaluate).toEqual({
      kind: "select",
      from: ["pi", "kimi", "codex"],
      require: ["evaluate"],
      avoid: ["execute"],
      strategy: "seeded-random",
    });
    expect(config?.defaults.skill.roles.evaluate).toEqual({
      kind: "fixed",
      agent: "codex",
      model: "gpt-5.5",
    });
  });

  it("normalizes agent aliases to canonical ids", () => {
    const { config, errors } = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: project
roles:
  execute:
    kind: fixed
    agent: openai
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [openai, pi]
`);
    expect(errors).toEqual([]);
    expect(config?.roles.execute).toEqual({ kind: "fixed", agent: "codex" });
    expect(config?.defaults.story.roles.evaluate).toEqual({
      kind: "select",
      from: ["codex", "pi"],
      require: [],
      avoid: [],
      strategy: "first-available",
    });
  });

  it("returns null config for non roll-agents schema", () => {
    const { config, errors } = normalizeAgentScopeConfig("schema: v3\n");
    expect(config).toBeNull();
    expect(errors).toEqual(["schema: expected 'roll-agents/v1'"]);
  });

  it("leaves legacy v3 agents.yaml parsing on the existing route normalizer", () => {
    const legacy = "schema: v3\ndefault: { agent: codex, model: gpt-5 }\nhard: { agent: kimi }\n";
    expect(normalizeAgentScopeConfig(legacy)).toEqual({
      config: null,
      errors: ["schema: expected 'roll-agents/v1'"],
    });

    const { config, errors } = normalizeAgentConfig(legacy);
    expect(errors).toEqual([]);
    expect(config.schema).toBe("v3");
    expect(config.routing.default).toEqual({ rig: { agent: "codex", model: "gpt-5" } });
    expect(config.routing.hard).toEqual({ rig: { agent: "kimi" } });
  });

  it("reports unknown roles and agents", () => {
    const { config, errors } = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: project
agents:
  qwen: { adapter: qwen, capabilities: [execute] }
roles:
  dispatch: { use: codex }
  execute: { use: qwen }
`);
    expect(config?.agents).toEqual({});
    expect(errors).toEqual([
      "agents.qwen: unknown agent",
      "roles.dispatch: unknown role",
      "roles.execute: unknown agent 'qwen'",
    ]);
  });

  it("reports duplicate canonical agent declarations", () => {
    const { errors } = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: machine
agents:
  codex: { adapter: codex, capabilities: [execute] }
  openai: { adapter: codex, capabilities: [execute] }
`);
    expect(errors).toEqual(["agents.openai: duplicate canonical agent 'codex' (already declared as 'codex')"]);
  });

  it("reports malformed bindings and unknown strategies", () => {
    const { config, errors } = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [reasonix]
        strategy: health-aware
      evaluate: nope
`);
    expect(config?.defaults.story.roles.execute).toEqual({
      kind: "select",
      from: ["reasonix"],
      require: [],
      avoid: [],
      strategy: "health-aware",
    });
    expect(errors).toEqual(["defaults.story.roles.evaluate: malformed binding (expected a map)"]);
  });

  it("reports unknown strategies after accepting health-aware", () => {
    const { config, errors } = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [reasonix]
        strategy: roulette
`);
    expect(config?.defaults.story.roles.execute).toEqual({
      kind: "select",
      from: ["reasonix"],
      require: [],
      avoid: [],
      strategy: "first-available",
    });
    expect(errors).toEqual(["defaults.story.roles.execute: unknown strategy 'roulette'"]);
  });

  it("parses the closed workspace casting schema", () => {
    const { config, errors } = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: workspace
inherits: machine
roles:
  supervise:
    kind: fixed
    agent: codex
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [codex, kimi]
        require: [execute]
  skill:
    roles:
      evaluate:
        kind: fixed
        agent: kimi
`);

    expect(errors).toEqual([]);
    expect(config).toEqual({
      schema: "roll-agents/v1",
      scope: "workspace",
      inherits: "machine",
      agents: {},
      models: {},
      roles: { supervise: { kind: "fixed", agent: "codex" } },
      defaults: {
        story: {
          roles: {
            execute: {
              kind: "select",
              from: ["codex", "kimi"],
              require: ["execute"],
              avoid: [],
              strategy: "first-available",
            },
          },
        },
        skill: { roles: { evaluate: { kind: "fixed", agent: "kimi" } } },
      },
    });
  });

  it("rejects workspace declarations, machine policy, and unknown top-level fields", () => {
    const { config, errors } = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: workspace
inherits: machine
agents:
  codex:
    capabilities: [execute]
models:
  gpt-5.5:
    provider: openai
disabled: [kimi]
capacity: 2
repositories: [app]
`);

    expect(config?.scope).toBe("workspace");
    expect(config?.agents).toEqual({});
    expect(config?.models).toEqual({});
    expect(errors).toEqual([
      "workspace: key 'agents' is not allowed",
      "workspace: key 'models' is not allowed",
      "workspace: key 'disabled' is not allowed",
      "workspace: key 'capacity' is not allowed",
      "workspace: key 'repositories' is not allowed",
    ]);
  });

  it("requires machine inheritance and only story or skill workspace defaults", () => {
    const { errors } = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: workspace
inherits: project
defaults:
  workspace:
    roles:
      execute: { use: codex }
  project:
    roles:
      execute: { use: kimi }
  story:
    roles: {}
    agents: {}
`);

    expect(errors).toEqual([
      "workspace.inherits: expected 'machine'",
      "workspace.defaults.workspace: unknown default scope",
      "workspace.defaults.project: unknown default scope",
      "workspace.defaults.story.agents: unknown key",
    ]);
  });

  it("fails loud for malformed workspace defaults containers", () => {
    expect(normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: workspace
inherits: machine
defaults: nope
`).errors).toEqual(["workspace.defaults: malformed defaults block (expected a map)"]);

    expect(normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: workspace
inherits: machine
defaults:
  story: nope
`).errors).toEqual(["workspace.defaults.story: malformed default block (expected a map)"]);
  });
});
