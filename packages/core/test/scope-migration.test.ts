import { describe, expect, it } from "vitest";
import { normalizeAgentScopeConfig } from "../src/agent/scope-config.js";
import { planAgentScopeMigration } from "../src/agent/scope-migration.js";

describe("planAgentScopeMigration — US-V4-017", () => {
  it("migrates global primary_agent and ai_* entries into machine agents.yaml", () => {
    const plan = planAgentScopeMigration({
      globalConfigText: `ai_claude: ~/.claude|CLAUDE.md|CLAUDE.md
ai_codex: ~/.codex|AGENTS.md|AGENTS.md
primary_agent: codex
`,
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(plan.machine.changed).toBe(true);
    expect(plan.machine.text).toContain("schema: roll-agents/v1");
    expect(plan.machine.text).toContain("scope: machine");
    expect(plan.machine.text).toContain("codex:");
    expect(plan.machine.text).toContain("home: ~/.codex");
    expect(plan.machine.text).toContain("convention: AGENTS.md");
    expect(plan.machine.text).toContain("supervise:");
    expect(plan.machine.text).toContain("agent: codex");
    expect(plan.summary.some((s) => s.includes("~/.roll/config.yaml primary_agent -> ~/.roll/agents.yaml roles.supervise = fixed codex"))).toBe(true);

    const parsed = normalizeAgentScopeConfig(plan.machine.text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.roles.supervise).toEqual({ kind: "fixed", agent: "codex" });
  });

  it("migrates v3 project slots without exposing easy/default/hard in target schema", () => {
    const plan = planAgentScopeMigration({
      projectAgentsText: `schema: v3
easy: { agent: reasonix }
default: { agent: pi }
hard: { agent: kimi }
fallback: { agent: claude }
`,
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(plan.project.changed).toBe(true);
    expect(plan.project.text).toContain("scope: project");
    expect(plan.project.text).toContain("inherits: machine");
    expect(plan.project.text).toContain("execute:");
    expect(plan.project.text).toContain("from: [pi, reasonix, kimi, claude]");
    expect(plan.project.text).not.toContain("easy:");
    expect(plan.project.text).not.toContain("hard:");
    expect(plan.project.text).not.toContain("fallback:");
    expect(plan.summary.some((s) => s.includes(".roll/agents.yaml v3 routes -> .roll/agents.yaml defaults.story.roles.execute = select [pi, reasonix, kimi, claude]"))).toBe(true);

    const parsed = normalizeAgentScopeConfig(plan.project.text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.defaults.story.roles.execute).toEqual({
      kind: "select",
      from: ["pi", "reasonix", "kimi", "claude"],
      require: ["execute"],
      avoid: [],
      strategy: "first-available",
    });
  });

  it("migrates an enabled legacy code reviewer pool into the evaluation role binding", () => {
    const plan = planAgentScopeMigration({
      pairingText: `enabled: true
stages: [code]
capability:
  kimi: [code]
  pi: [score]
  codex: [code]
`,
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(plan.project.text).toContain("evaluate:");
    expect(plan.project.text).toContain("from: [kimi, codex]");
    expect(plan.project.text).not.toContain("avoid: [execute]");
    expect(plan.project.text).toContain("strategy: health-aware");
    expect(plan.summary.some((s) => s.includes(".roll/pairing.yaml code capability -> .roll/agents.yaml defaults.story.roles.evaluate = select [kimi, codex]"))).toBe(true);
  });

  it("retires a score-only legacy pairing pool instead of enabling code review", () => {
    const plan = planAgentScopeMigration({
      pairingText: `enabled: true
stages: [score]
capability:
  kimi: [score]
`,
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(plan.project.text).not.toContain("evaluate:");
    expect(plan.summary.some((s) => s.includes("pairing.yaml"))).toBe(false);
  });

  it("does not migrate code-capable agents when legacy code review was disabled", () => {
    const plan = planAgentScopeMigration({
      pairingText: `enabled: true
stages: [score]
capability:
  kimi: [code, score]
`,
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(plan.project.text).not.toContain("evaluate:");
  });

  it("does not migrate a code reviewer pool from a disabled legacy config", () => {
    const plan = planAgentScopeMigration({
      pairingText: `enabled: false
stages: [code]
capability:
  kimi: [code]
`,
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(plan.project.text).not.toContain("evaluate:");
  });

  it("migrates only code-capable candidates from a mixed legacy stage list", () => {
    const plan = planAgentScopeMigration({
      pairingText: `enabled: true
stages: [code, score]
capability:
  kimi: [code, score]
  pi: [score]
  codex: [code]
`,
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(plan.project.text).toContain("from: [kimi, codex]");
    expect(plan.project.text).not.toContain("from: [kimi, pi, codex]");
  });

  it("never overwrites an existing scoped evaluate binding with legacy code candidates", () => {
    const plan = planAgentScopeMigration({
      projectAgentsText: `schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: fixed
        agent: pi
`,
      pairingText: `enabled: true
stages: [code]
capability:
  kimi: [code]
`,
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(plan.project.text).toContain("agent: pi");
    expect(plan.project.text).not.toContain("from: [kimi]");
    expect(plan.summary.some((s) => s.includes("pairing.yaml code capability"))).toBe(false);

    const topLevel = planAgentScopeMigration({
      projectAgentsText: `schema: roll-agents/v1
scope: project
roles:
  evaluate:
    kind: fixed
    agent: codex
`,
      pairingText: `enabled: true
stages: [code]
capability:
  kimi: [code]
`,
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(topLevel.project.text).toContain("agent: codex");
    expect(topLevel.project.text).not.toContain("from: [kimi]");
  });

  it("retires legacy pairing stages that have no scoped evaluate-role equivalent", () => {
    const plan = planAgentScopeMigration({
      pairingText: `enabled: true
stages: [design, test, cycle]
capability:
  pi: [design, test, cycle]
`,
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(plan.project.text).not.toContain("evaluate:");
    expect(plan.summary.some((s) => s.includes("pairing.yaml capability"))).toBe(false);
  });

  it("uses .roll/local.yaml agent only when no project execute binding exists", () => {
    const fromLocal = planAgentScopeMigration({
      projectLocalText: "agent: reasonix\n",
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(fromLocal.project.text).toContain("agent: reasonix");
    expect(fromLocal.summary.some((s) => s.includes(".roll/local.yaml agent -> .roll/agents.yaml defaults.story.roles.execute = fixed reasonix"))).toBe(true);

    const preserved = planAgentScopeMigration({
      projectAgentsText: `schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      execute:
        kind: fixed
        agent: kimi
`,
      projectLocalText: "agent: reasonix\n",
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(preserved.project.text).toContain("agent: kimi");
    expect(preserved.project.text).not.toContain("agent: reasonix");
    expect(preserved.summary.some((s) => s.includes(".roll/local.yaml agent ignored"))).toBe(true);

    const topLevelPreserved = planAgentScopeMigration({
      projectAgentsText: `schema: roll-agents/v1
scope: project
roles:
  execute:
    kind: fixed
    agent: codex
`,
      projectLocalText: "agent: reasonix\n",
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(topLevelPreserved.project.text).toContain("agent: codex");
    expect(topLevelPreserved.project.text).not.toContain("agent: reasonix");
    expect(topLevelPreserved.summary.some((s) => s.includes(".roll/local.yaml agent ignored"))).toBe(true);
  });

  it("is idempotent against generated roll-agents/v1 targets", () => {
    const first = planAgentScopeMigration({
      globalConfigText: "primary_agent: codex\nai_codex: ~/.codex|AGENTS.md|AGENTS.md\n",
      projectAgentsText: "schema: v3\ndefault: { agent: pi }\n",
      pairingText: "enabled: true\nstages: [score]\ncapability:\n  kimi: [score]\n",
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    const second = planAgentScopeMigration({
      globalConfigText: "primary_agent: codex\nai_codex: ~/.codex|AGENTS.md|AGENTS.md\n",
      machineAgentsText: first.machine.text,
      projectAgentsText: first.project.text,
      pairingText: "enabled: true\nstages: [score]\ncapability:\n  kimi: [score]\n",
      machineTargetPath: "~/.roll/agents.yaml",
      projectTargetPath: ".roll/agents.yaml",
    });
    expect(second.machine.changed).toBe(false);
    expect(second.project.changed).toBe(false);
    expect(second.machine.text).toBe(first.machine.text);
    expect(second.project.text).toBe(first.project.text);
  });
});
