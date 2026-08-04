/**
 * US-V4-017 — migration planner from legacy agent config to `roll-agents/v1`.
 *
 * Pure planner only: callers decide whether to write the returned target files.
 * Legacy source files are never deleted or modified by this module.
 */
import {
  AGENT_SCOPE_SCHEMA,
  type AgentName,
  type AgentScopeAgent,
  type AgentScopeConfig,
  type AgentScopeRoleBinding,
} from "@roll/spec";
import { normalizeAgentConfig, parseBlockYaml } from "./config-v4.js";
import { normalizeAgentScopeConfig } from "./scope-config.js";
import { agentIsKnown, canonicalAgentName } from "./registry.js";
import { parsePairingConfig, PairingConfigError } from "./pairing.js";

export interface AgentScopeMigrationInput {
  readonly globalConfigText?: string;
  readonly machineAgentsText?: string;
  readonly projectAgentsText?: string;
  readonly pairingText?: string;
  readonly projectLocalText?: string;
  readonly globalConfigPath?: string;
  readonly machineTargetPath: string;
  readonly projectTargetPath: string;
  readonly projectLegacyAgentsPath?: string;
  readonly pairingPath?: string;
  readonly projectLocalPath?: string;
  readonly machineSuperviseAgent?: AgentName;
}

export interface AgentScopeMigrationTarget {
  readonly path: string;
  readonly text: string;
  readonly changed: boolean;
}

export interface AgentScopeMigrationPlan {
  readonly machine: AgentScopeMigrationTarget;
  readonly project: AgentScopeMigrationTarget;
  readonly sources: readonly string[];
  readonly targets: readonly string[];
  readonly summary: readonly string[];
  readonly warnings: readonly string[];
}

function scalar(root: Record<string, unknown>, key: string): string | undefined {
  const v = root[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function canonicalKnown(raw: string | undefined): AgentName | null {
  if (raw === undefined || raw.trim() === "") return null;
  const name = canonicalAgentName(raw.trim());
  return agentIsKnown(name) ? (name as AgentName) : null;
}

function emptyMachine(): AgentScopeConfig {
  return { schema: AGENT_SCOPE_SCHEMA, scope: "machine", agents: {}, models: {}, roles: {}, defaults: {} };
}

function emptyProject(): AgentScopeConfig {
  return { schema: AGENT_SCOPE_SCHEMA, scope: "project", inherits: "machine", agents: {}, models: {}, roles: {}, defaults: {} };
}

function parseExisting(text: string | undefined, fallback: AgentScopeConfig): AgentScopeConfig {
  if (text === undefined || text.trim() === "") return fallback;
  const parsed = normalizeAgentScopeConfig(text);
  return parsed.config ?? fallback;
}

function ensureStoryDefaults(config: AgentScopeConfig): Record<string, { roles: Partial<Record<string, AgentScopeRoleBinding>> }> {
  const defaults: Record<string, { roles: Partial<Record<string, AgentScopeRoleBinding>> }> = {};
  for (const [name, value] of Object.entries(config.defaults)) defaults[name] = { roles: { ...value.roles } };
  defaults["story"] = defaults["story"] ?? { roles: {} };
  return defaults;
}

function capabilities(): readonly ["supervise", "execute", "evaluate"] {
  return ["supervise", "execute", "evaluate"];
}

function legacyAiEntries(globalConfigText: string | undefined): Partial<Record<AgentName, AgentScopeAgent>> {
  const out: Partial<Record<AgentName, AgentScopeAgent>> = {};
  if (globalConfigText === undefined) return out;
  const root = parseBlockYaml(globalConfigText);
  for (const [key, value] of Object.entries(root)) {
    if (!key.startsWith("ai_") || typeof value !== "string") continue;
    const rawName = key.slice("ai_".length).replace(/_code$/, "");
    const agent = canonicalKnown(rawName);
    if (agent === null || out[agent] !== undefined) continue;
    const [home, convention] = value.split("|");
    out[agent] = {
      id: agent,
      adapter: agent,
      ...(home !== undefined && home.trim() !== "" ? { home: home.trim() } : {}),
      ...(convention !== undefined && convention.trim() !== "" ? { convention: convention.trim() } : {}),
      capabilities: capabilities(),
    };
  }
  return out;
}

function primaryAgent(globalConfigText: string | undefined): AgentName | null {
  if (globalConfigText === undefined) return null;
  return canonicalKnown(scalar(parseBlockYaml(globalConfigText), "primary_agent"));
}

function uniqueAgents(agents: readonly (AgentName | undefined)[]): AgentName[] {
  const out: AgentName[] = [];
  for (const agent of agents) {
    if (agent === undefined || out.includes(agent)) continue;
    out.push(agent);
  }
  return out;
}

function legacyRouteAgents(projectAgentsText: string | undefined): AgentName[] {
  if (projectAgentsText === undefined || projectAgentsText.trim() === "") return [];
  if (normalizeAgentScopeConfig(projectAgentsText).config !== null) return [];
  const parsed = normalizeAgentConfig(projectAgentsText);
  const ordered = ["default", "easy", "hard", "fallback"] as const;
  return uniqueAgents(ordered.map((slot) => parsed.config.routing[slot]?.rig.agent as AgentName | undefined));
}

function legacyCodePairingAgents(pairingText: string | undefined, warnings: string[]): AgentName[] {
  if (pairingText === undefined || pairingText.trim() === "") return [];
  try {
    const cfg = parsePairingConfig(pairingText);
    if (!cfg.enabled || !cfg.stages.includes("code")) return [];
    const agents = Object.entries(cfg.capability)
      .filter(([, stages]) => stages.includes("code"))
      .map(([agent]) => canonicalKnown(agent))
      .filter((agent): agent is AgentName => agent !== null);
    return uniqueAgents(agents);
  } catch (e) {
    if (e instanceof PairingConfigError) warnings.push(`pairing config ignored: ${e.message}`);
    else warnings.push(`pairing config ignored: ${String(e)}`);
    return [];
  }
}

function localAgent(projectLocalText: string | undefined): AgentName | null {
  if (projectLocalText === undefined || projectLocalText.trim() === "") return null;
  return canonicalKnown(scalar(parseBlockYaml(projectLocalText), "agent"));
}

function renderBinding(binding: AgentScopeRoleBinding, indent: string): string[] {
  if (binding.kind === "inherit") return [`${indent}kind: inherit`, ...(binding.from !== undefined ? [`${indent}from: ${binding.from}`] : [])];
  if (binding.kind === "fixed") return [`${indent}kind: fixed`, `${indent}agent: ${binding.agent}`, ...(binding.model !== undefined ? [`${indent}model: ${binding.model}`] : [])];
  return [
    `${indent}kind: select`,
    ...(binding.from !== undefined ? [`${indent}from: [${binding.from.join(", ")}]`] : []),
    ...(binding.require !== undefined && binding.require.length > 0 ? [`${indent}require: [${binding.require.join(", ")}]`] : []),
    ...(binding.avoid !== undefined && binding.avoid.length > 0 ? [`${indent}avoid: [${binding.avoid.join(", ")}]`] : []),
    `${indent}strategy: ${binding.strategy}`,
  ];
}

function renderConfig(config: AgentScopeConfig): string {
  const out: string[] = [`schema: ${AGENT_SCOPE_SCHEMA}`, `scope: ${config.scope}`];
  if (config.inherits !== undefined) out.push(`inherits: ${config.inherits}`);

  const agents = Object.values(config.agents).filter((a): a is AgentScopeAgent => a !== undefined).sort((a, b) => a.id.localeCompare(b.id));
  if (agents.length > 0) {
    out.push("", "agents:");
    for (const agent of agents) {
      out.push(`  ${agent.id}:`, `    adapter: ${agent.adapter}`);
      if (agent.home !== undefined) out.push(`    home: ${agent.home}`);
      if (agent.convention !== undefined) out.push(`    convention: ${agent.convention}`);
      out.push(`    capabilities: [${agent.capabilities.join(", ")}]`);
      if (agent.models !== undefined && agent.models.length > 0) out.push(`    models: [${agent.models.join(", ")}]`);
    }
  }

  const roleEntries = Object.entries(config.roles) as [string, AgentScopeRoleBinding][];
  if (roleEntries.length > 0) {
    out.push("", "roles:");
    for (const [role, binding] of roleEntries.sort(([a], [b]) => a.localeCompare(b))) {
      out.push(`  ${role}:`, ...renderBinding(binding, "    "));
    }
  }

  const defaultEntries = Object.entries(config.defaults).filter(([, value]) => Object.keys(value.roles).length > 0);
  if (defaultEntries.length > 0) {
    out.push("", "defaults:");
    for (const [name, value] of defaultEntries.sort(([a], [b]) => a.localeCompare(b))) {
      out.push(`  ${name}:`, "    roles:");
      for (const [role, binding] of (Object.entries(value.roles) as [string, AgentScopeRoleBinding][]).sort(([a], [b]) => a.localeCompare(b))) {
        out.push(`      ${role}:`, ...renderBinding(binding, "        "));
      }
    }
  }
  return `${out.join("\n")}\n`;
}

function sameText(a: string | undefined, b: string): boolean {
  return (a ?? "") === b;
}

export function planAgentScopeMigration(input: AgentScopeMigrationInput): AgentScopeMigrationPlan {
  const globalConfigPath = input.globalConfigPath ?? "~/.roll/config.yaml";
  const projectLegacyAgentsPath = input.projectLegacyAgentsPath ?? ".roll/agents.yaml";
  const pairingPath = input.pairingPath ?? ".roll/pairing.yaml";
  const projectLocalPath = input.projectLocalPath ?? ".roll/local.yaml";
  const sources: string[] = [];
  const summary: string[] = [];
  const warnings: string[] = [];

  const machine = parseExisting(input.machineAgentsText, emptyMachine());
  const project = parseExisting(input.projectAgentsText, emptyProject());
  const machineAgents = { ...machine.agents };
  const machineRoles = { ...machine.roles };
  const projectDefaults = ensureStoryDefaults(project);

  if (input.globalConfigText !== undefined) sources.push(globalConfigPath);
  if (input.projectAgentsText !== undefined) sources.push(projectLegacyAgentsPath);
  if (input.pairingText !== undefined) sources.push(pairingPath);
  if (input.projectLocalText !== undefined) sources.push(projectLocalPath);

  for (const [agent, spec] of Object.entries(legacyAiEntries(input.globalConfigText)) as [AgentName, AgentScopeAgent][]) {
    if (machineAgents[agent] === undefined) {
      machineAgents[agent] = spec;
      summary.push(`${globalConfigPath} ai_${agent} -> ${input.machineTargetPath} agents.${agent}`);
    }
  }

  const supervise = input.machineSuperviseAgent ?? primaryAgent(input.globalConfigText);
  if (supervise !== null && supervise !== undefined && machineRoles.supervise === undefined) {
    machineRoles.supervise = { kind: "fixed", agent: supervise };
    summary.push(
      input.machineSuperviseAgent !== undefined
        ? `Machine Scope selection -> ${input.machineTargetPath} roles.supervise = fixed ${supervise}`
        : `${globalConfigPath} primary_agent -> ${input.machineTargetPath} roles.supervise = fixed ${supervise}`,
    );
  }

  const routeAgents = legacyRouteAgents(input.projectAgentsText);
  if (routeAgents.length > 0 && project.roles.execute === undefined && projectDefaults.story?.roles.execute === undefined) {
    projectDefaults.story = projectDefaults.story ?? { roles: {} };
    projectDefaults.story.roles.execute = {
      kind: "select",
      from: routeAgents,
      require: ["execute"],
      strategy: "first-available",
    };
    summary.push(`${projectLegacyAgentsPath} v3 routes -> ${input.projectTargetPath} defaults.story.roles.execute = select [${routeAgents.join(", ")}]`);
  }

  const codePairingAgents = legacyCodePairingAgents(input.pairingText, warnings);
  if (codePairingAgents.length > 0 && project.roles.evaluate === undefined && projectDefaults.story?.roles.evaluate === undefined) {
    projectDefaults.story = projectDefaults.story ?? { roles: {} };
    projectDefaults.story.roles.evaluate = {
      kind: "select",
      from: codePairingAgents,
      require: ["evaluate"],
      strategy: "health-aware",
    };
    summary.push(`${pairingPath} code capability -> ${input.projectTargetPath} defaults.story.roles.evaluate = select [${codePairingAgents.join(", ")}]`);
  }

  const local = localAgent(input.projectLocalText);
  if (local !== null) {
    if (project.roles.execute === undefined && projectDefaults.story?.roles.execute === undefined) {
      projectDefaults.story = projectDefaults.story ?? { roles: {} };
      projectDefaults.story.roles.execute = { kind: "fixed", agent: local };
      summary.push(`${projectLocalPath} agent -> ${input.projectTargetPath} defaults.story.roles.execute = fixed ${local} (legacy source)`);
    } else {
      summary.push(`${projectLocalPath} agent ignored (project execute binding already exists; legacy source preserved)`);
    }
  }

  const machineConfig: AgentScopeConfig = { ...machine, scope: "machine", agents: machineAgents, roles: machineRoles };
  const projectConfig: AgentScopeConfig = { ...project, scope: "project", inherits: project.inherits ?? "machine", defaults: projectDefaults };
  const machineText = renderConfig(machineConfig);
  const projectText = renderConfig(projectConfig);
  return {
    machine: { path: input.machineTargetPath, text: machineText, changed: !sameText(input.machineAgentsText, machineText) },
    project: { path: input.projectTargetPath, text: projectText, changed: !sameText(input.projectAgentsText, projectText) },
    sources,
    targets: [input.machineTargetPath, input.projectTargetPath],
    summary,
    warnings,
  };
}
