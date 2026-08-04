import {
  AGENT_REGISTRY_NAMES,
  AgentRegistry,
  canonicalAgentName,
  normalizeAgentScopeConfig,
  normalizeAgentConfig,
  planAgentScopeMigration,
  readAgentDisabledFromText,
  setAgentDisabledInText,
  type AgentEnv,
  type FileStore,
} from "@roll/core";
import type { AgentName, AgentScopeConfig, AgentScopeRole, AgentScopeRoleBinding } from "@roll/spec";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { t, v2Catalog, v3Catalog } from "@roll/spec";
import { agentListCommand, currentLang, realAgentEnv } from "./agent-list.js";
import { AGY_AUTH_CONTEXT_ENV, agyAuthContext } from "../runner/agent-spawn.js";

export interface AgentCommandDeps {
  env?: AgentEnv;
  fileExists?: (path: string) => boolean;
  readText?: (path: string) => string;
  writeText?: (path: string, text: string) => void;
  writeFileAtomic?: (path: string, text: string) => void;
  mkdirp?: (path: string) => void;
  removeFile?: (path: string) => void;
  readLine?: () => string | undefined;
  listCommand?: (args: string[]) => number;
  /** US-V4-002 — seam for the GLOBAL machine default (`~/.roll/config.yaml`). */
  readDefaultAgent?: () => string | null;
  writeDefaultAgent?: (name: string) => void;
}

function pal(): { RED: string; GREEN: string; YELLOW: string; NC: string } {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  return {
    RED: noColor ? "" : "\x1b[0;31m",
    GREEN: noColor ? "" : "\x1b[0;32m",
    YELLOW: noColor ? "" : "\x1b[0;33m",
    NC: noColor ? "" : "\x1b[0m",
  };
}

function err(line: string): void {
  const { RED, NC } = pal();
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}

function m(key: string, ...args: string[]): string {
  if (v3Catalog[key] !== undefined) return t(v3Catalog, currentLang(), key, ...args);
  return t(v2Catalog, currentLang(), key, ...args);
}

function depsWithDefaults(
  deps: AgentCommandDeps,
): Required<Omit<AgentCommandDeps, "readLine" | "readDefaultAgent" | "writeDefaultAgent">> &
  Pick<AgentCommandDeps, "readLine" | "readDefaultAgent" | "writeDefaultAgent"> {
  return {
    env: deps.env ?? realAgentEnv(),
    fileExists: deps.fileExists ?? existsSync,
    readText: deps.readText ?? ((path) => readFileSync(path, "utf8")),
    writeText: deps.writeText ?? ((path, text) => writeFileSync(path, text, "utf8")),
    writeFileAtomic:
      deps.writeFileAtomic ??
      ((path, text) => {
        const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
        writeFileSync(tmp, text, "utf8");
        renameSync(tmp, path);
      }),
    mkdirp: deps.mkdirp ?? ((path) => mkdirSync(path, { recursive: true })),
    removeFile: deps.removeFile ?? ((path) => rmSync(path, { force: true })),
    readLine: deps.readLine,
    listCommand: deps.listCommand ?? agentListCommand,
    readDefaultAgent: deps.readDefaultAgent,
    writeDefaultAgent: deps.writeDefaultAgent,
  };
}

function registry(deps: AgentCommandDeps): { reg: AgentRegistry; d: ReturnType<typeof depsWithDefaults> } {
  const d = depsWithDefaults(deps);
  const fs: FileStore = {
    readText: d.readText,
    writeFileAtomic: d.writeFileAtomic,
  };
  return { reg: new AgentRegistry(d.env, fs), d };
}

/** `roll agent default` is retired. Machine roles now live in `~/.roll/agents.yaml`. */
function defaultCommand(args: string[], deps: AgentCommandDeps): number {
  return retiredRouteCommand("default", args, deps);
}

function retiredRouteCommand(_subcommand: string, _args: string[], _deps: AgentCommandDeps): number {
  err(m("agent.use_retired"));
  return 1;
}

/** The legacy use subcommand is retired with the same scoped-config guidance. */
function useCommand(args: string[], deps: AgentCommandDeps): number {
  return retiredRouteCommand("use", args, deps);
}

/** The legacy set subcommand is retired. Project roles now live in `.roll/agents.yaml`. */
function setCommand(args: string[], deps: AgentCommandDeps): number {
  return retiredRouteCommand("set", args, deps);
}

function viewCommand(deps: AgentCommandDeps): number {
  const { reg, d } = registry(deps);
  const rollHome = process.env["ROLL_HOME"] ?? join(d.env.home, ".roll");
  const machine = loadScopeFile(d, join(rollHome, "agents.yaml"));
  const project = loadScopeFile(d, ".roll/agents.yaml");
  const out: string[] = [
    "",
    "  Agent Scope View",
    "",
    ...renderScopeBlock("Machine Scope", machine),
    "",
    ...renderProjectScopeBlock(project, machine),
    "",
    ...renderAgentPool(reg),
  ];
  out.push(
    "",
    "  Role bindings are authored in ~/.roll/agents.yaml and .roll/agents.yaml.",
    "  roll agent migrate [--dry-run]  — convert legacy defaults/routes and enabled code reviewer pools; score/design/test/cycle pairing settings are retired",
    "  roll agent list                 — show installed agents",
    "",
  );
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

function readIfExists(d: ReturnType<typeof depsWithDefaults>, path: string): string | undefined {
  return d.fileExists(path) ? d.readText(path) : undefined;
}

type ScopeLoad =
  | { kind: "missing"; path: string }
  | { kind: "legacy"; path: string; text: string }
  | { kind: "invalid"; path: string; text: string; errors: readonly string[] }
  | { kind: "valid"; path: string; text: string; config: AgentScopeConfig };

function loadScopeFile(d: ReturnType<typeof depsWithDefaults>, path: string): ScopeLoad {
  if (!d.fileExists(path)) return { kind: "missing", path };
  const text = d.readText(path);
  if (!text.includes("roll-agents/v1")) return { kind: "legacy", path, text };
  const parsed = normalizeAgentScopeConfig(text);
  if (parsed.config === null || parsed.errors.length > 0) {
    return { kind: "invalid", path, text, errors: parsed.errors };
  }
  return { kind: "valid", path, text, config: parsed.config };
}

function renderScopeBlock(title: string, load: ScopeLoad): string[] {
  const out = [`  ${title}`, "", `    file: ${load.path}`];
  if (load.kind === "missing") {
    out.push("    status: missing");
  } else if (load.kind === "legacy") {
    out.push("    status: legacy config (run `roll agent migrate` to convert)");
  } else if (load.kind === "invalid") {
    out.push("    status: invalid roll-agents/v1");
    for (const errorLine of load.errors) out.push(`    error: ${errorLine}`);
  } else {
    const agents = Object.keys(load.config.agents);
    const models = Object.keys(load.config.models);
    out.push("    status: roll-agents/v1");
    out.push(`    agents: ${agents.length > 0 ? agents.join(", ") : "-"}`);
    out.push(`    models: ${models.length > 0 ? models.join(", ") : "-"}`);
  }
  return out;
}

function routeModelBindings(load: ScopeLoad): { agent: string; model: string }[] {
  if (load.kind !== "valid") return [];
  const parsed = normalizeAgentConfig(load.text);
  return Object.values(parsed.config.rigs)
    .flatMap((rig) => (rig.model === undefined ? [] : [{ agent: rig.agent, model: rig.model }]));
}

function renderProjectScopeBlock(project: ScopeLoad, machine: ScopeLoad): string[] {
  const out = renderScopeBlock("Project Scope", project);
  if (project.kind !== "valid") return out;
  const inheritedMachine = project.config.inherits === "machine" && machine.kind === "valid" ? machine : null;

  const effectiveAgents = [
    ...(inheritedMachine === null ? [] : Object.keys(inheritedMachine.config.agents)),
    ...Object.keys(project.config.agents),
  ].filter((agent, index, all) => all.indexOf(agent) === index);
  const effectiveModels = [
    ...(inheritedMachine === null ? [] : Object.keys(inheritedMachine.config.models)),
    ...Object.keys(project.config.models),
    ...(inheritedMachine === null ? [] : routeModelBindings(inheritedMachine).map((binding) => binding.model)),
    ...routeModelBindings(project).map((binding) => binding.model),
  ].filter((model, index, all) => all.indexOf(model) === index);
  const projectRouteModels = routeModelBindings(project).map((binding) => `${binding.agent}=${binding.model}`);
  out.push(`    effective agents: ${effectiveAgents.length > 0 ? effectiveAgents.join(", ") : "-"}`);
  out.push(`    effective models: ${effectiveModels.length > 0 ? effectiveModels.join(", ") : "-"}`);
  if (projectRouteModels.length > 0) out.push(`    route models: ${projectRouteModels.join(", ")}`);
  return out;
}

function renderAgentPool(reg: AgentRegistry): string[] {
  const out = [
    "  Agent pool",
    "",
    "    agent       status        note",
  ];
  for (const agent of AGENT_REGISTRY_NAMES) {
    const installed = reg.isInstalled(agent);
    out.push(`    ${agent.padEnd(11)} ${(installed ? "installed" : "not found").padEnd(13)} runtime auth/network/account checked at spawn`);
  }
  return out;
}

function renderMigrationPlan(plan: ReturnType<typeof planAgentScopeMigration>, dryRun: boolean): string {
  const out: string[] = ["", "  Agent config migration", "", "  Sources:"];
  if (plan.sources.length === 0) out.push("    - none found");
  else for (const source of plan.sources) out.push(`    - ${source}`);
  out.push("", "  Targets:");
  for (const target of plan.targets) out.push(`    - ${target}`);
  out.push("", "  Bindings:");
  if (plan.summary.length === 0) out.push("    - no legacy bindings to migrate");
  else for (const line of plan.summary) out.push(`    - ${line}`);
  if (plan.warnings.length > 0) {
    out.push("", "  Warnings:");
    for (const warning of plan.warnings) out.push(`    - ${warning}`);
  }
  out.push("", dryRun ? "  Dry run: no files written" : "  Migration written", "");
  return `${out.join("\n")}\n`;
}

function migrateCommand(args: string[], deps: AgentCommandDeps): number {
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    err(`Unknown option for migrate: ${unknown[0]}`);
    return 1;
  }
  const d = depsWithDefaults(deps);
  const rollHome = process.env["ROLL_HOME"] ?? join(d.env.home, ".roll");
  const globalConfigPath = join(rollHome, "config.yaml");
  const machineTargetPath = join(rollHome, "agents.yaml");
  const projectTargetPath = ".roll/agents.yaml";
  const pairingPath = ".roll/pairing.yaml";
  const localPath = ".roll/local.yaml";
  const plan = planAgentScopeMigration({
    globalConfigText: readIfExists(d, globalConfigPath),
    machineAgentsText: readIfExists(d, machineTargetPath),
    projectAgentsText: readIfExists(d, projectTargetPath),
    pairingText: readIfExists(d, pairingPath),
    projectLocalText: readIfExists(d, localPath),
    globalConfigPath,
    machineTargetPath,
    projectTargetPath,
    projectLegacyAgentsPath: projectTargetPath,
    pairingPath,
    projectLocalPath: localPath,
  });

  process.stdout.write(renderMigrationPlan(plan, dryRun));
  if (dryRun) return 0;

  try {
    d.mkdirp(dirname(machineTargetPath));
    d.mkdirp(dirname(projectTargetPath));
    if (plan.machine.changed) d.writeFileAtomic(machineTargetPath, plan.machine.text);
    if (plan.project.changed) d.writeFileAtomic(projectTargetPath, plan.project.text);
  } catch (e) {
    err(`agent migration failed: ${String(e)}`);
    return 1;
  }
  return 0;
}

/**
 * FIX-1056 — `roll agent readiness [agent]`. Probes an agent's HEADLESS auth
 * context through the SAME spawn envelope the loop's peer/evaluator spawn uses
 * (agent-spawn's agyAuthContext / AGY_CONFIG_DIR), so a once-authenticated agy
 * can be verified for unattended cycles without an interactive prompt. When the
 * context is missing it reports the actionable boundary (which dir / which env
 * vars) instead of silently excluding the agent. Only NAMES/PATHS are printed —
 * credential VALUES are never read or surfaced.
 */
function readinessCommand(args: string[], deps: AgentCommandDeps): number {
  const d = depsWithDefaults(deps);
  const requested = (args[0] ?? "").trim();
  const target = requested === "" ? "agy" : canonicalAgentName(requested);
  if (target !== "agy") {
    // Only agy has an explicit headless auth-context probe today; the other
    // agents resolve auth at spawn time (no separate readiness contract).
    process.stdout.write(`  readiness: no headless auth-context probe for '${target}' (auth resolved at spawn time)\n`);
    return 0;
  }
  const ctx = agyAuthContext(d.env.home);
  const lines: string[] = [
    "",
    "  Agent readiness — agy (headless auth context)",
    "",
    `  spawn env:        ${AGY_AUTH_CONTEXT_ENV}=${ctx.configDir}`,
    `  auth-context dir: ${ctx.configDir} ${ctx.configDirExists ? "(present)" : "(missing)"}`,
    `  auth env present: ${ctx.authEnvPresent.length > 0 ? ctx.authEnvPresent.join(", ") : "(none)"}`,
    "",
  ];
  if (ctx.ok) {
    lines.push("  ✓ readiness agy ok · same envelope as peer/score spawn", "");
    process.stdout.write(lines.join("\n"));
    return 0;
  }
  lines.push(`  ✗ readiness agy auth-blocked · ${ctx.missingBoundary}`, "");
  process.stdout.write(lines.join("\n"));
  return 1;
}

/**
 * US-AGENT-050 — check if disabling `agentName` would empty any role's pool
 * across the given scope layers. Returns the first role that would become
 * empty, or `null` if all roles still have at least one available agent.
 */
function wouldEmptyPool(
  targetPath: string,
  targetText: string,
  agentName: AgentName,
  d: ReturnType<typeof depsWithDefaults>,
): string | null {
  // Parse the target file's config for role bindings
  const targetParsed = normalizeAgentScopeConfig(targetText);
  if (targetParsed.config === null) return null;

  // Collect all disabled agents from target config (including the one being disabled)
  const disabledAgents = new Set<AgentName>();
  for (const [name, spec] of Object.entries(targetParsed.config.agents) as [AgentName, NonNullable<AgentScopeConfig["agents"][AgentName]>][]) {
    if (spec.disabled === true || name === agentName) disabledAgents.add(name);
  }
  disabledAgents.add(agentName);

  // Check roles in the target config
  for (const [role, binding] of Object.entries(targetParsed.config.roles) as [AgentScopeRole, AgentScopeRoleBinding][]) {
    if (wouldRoleBeEmpty(role, binding, targetParsed.config.agents, disabledAgents)) {
      return role;
    }
  }
  return null;
}

function wouldRoleBeEmpty(
  role: AgentScopeRole,
  binding: AgentScopeRoleBinding,
  agents: NonNullable<AgentScopeConfig["agents"]>,
  disabledAgents: ReadonlySet<AgentName>,
): boolean {
  if (binding.kind === "inherit") return false;
  if (binding.kind === "fixed") {
    return disabledAgents.has(binding.agent);
  }
  // select binding
  const candidates = binding.from !== undefined && binding.from.length > 0
    ? binding.from
    : (Object.keys(agents) as AgentName[]);
  return candidates.every((a) => disabledAgents.has(a));
}

/**
 * US-AGENT-050 — `roll agent disable <name> [--machine] [--force]`.
 * Writes `disabled: true` in the agent's block in agents.yaml. Project scope
 * by default; `--machine` targets ~/.roll/agents.yaml.
 */
function disableCommand(args: string[], deps: AgentCommandDeps): number {
  const d = depsWithDefaults(deps);
  const machine = args.includes("--machine");
  const force = args.includes("--force");
  const rest = args.filter((a) => a !== "--machine" && a !== "--force");
  const rawName = (rest[0] ?? "").trim();
  if (rawName === "") {
    err("agent disable: missing agent name");
    return 1;
  }
  const agent = canonicalAgentName(rawName) as AgentName;
  if (!AGENT_REGISTRY_NAMES.includes(agent as string)) {
    err(`agent disable: unknown agent '${rawName}'`);
    return 1;
  }

  const rollHome = process.env["ROLL_HOME"] ?? join(d.env.home, ".roll");
  const targetPath = machine ? join(rollHome, "agents.yaml") : ".roll/agents.yaml";

  if (!d.fileExists(targetPath)) {
    err(`agent disable: ${targetPath} not found — agent '${agent}' is not configured in this scope`);
    return 1;
  }

  let text = d.readText(targetPath);
  const current = readAgentDisabledFromText(text, agent);

  // Check agent exists in the config
  if (!text.includes(`roll-agents/v1`)) {
    err(`agent disable: ${targetPath} is not a roll-agents/v1 file`);
    return 1;
  }

  // Verify agent is declared in the agents block
  const parsed = normalizeAgentScopeConfig(text);
  if (parsed.config === null || parsed.config.agents[agent] === undefined) {
    err(`agent disable: agent '${agent}' is not declared in ${targetPath}`);
    return 1;
  }

  if (current.disabled) {
    process.stdout.write(`  agent '${agent}' is already disabled in ${targetPath}\n`);
    return 0;
  }

  if (!force) {
    const emptyRole = wouldEmptyPool(targetPath, text, agent, d);
    if (emptyRole !== null) {
      err(`agent disable: disabling '${agent}' would leave role '${emptyRole}' with no available agents`);
      err("  use --force to override this protection");
      return 1;
    }
  }

  const newText = setAgentDisabledInText(text, agent, true);
  try {
    d.mkdirp(dirname(targetPath));
    d.writeFileAtomic(targetPath, newText);
  } catch (e) {
    err(`agent disable: failed to write ${targetPath}: ${String(e)}`);
    return 1;
  }
  process.stdout.write(`  agent '${agent}' disabled in ${targetPath}\n`);
  return 0;
}

/**
 * US-AGENT-050 — `roll agent enable <name> [--machine]`.
 * Removes `disabled: true` from the agent's block in agents.yaml. Project
 * scope by default; `--machine` targets ~/.roll/agents.yaml.
 */
function enableCommand(args: string[], deps: AgentCommandDeps): number {
  const d = depsWithDefaults(deps);
  const machine = args.includes("--machine");
  const rest = args.filter((a) => a !== "--machine");
  const rawName = (rest[0] ?? "").trim();
  if (rawName === "") {
    err("agent enable: missing agent name");
    return 1;
  }
  const agent = canonicalAgentName(rawName) as AgentName;
  if (!AGENT_REGISTRY_NAMES.includes(agent as string)) {
    err(`agent enable: unknown agent '${rawName}'`);
    return 1;
  }

  const rollHome = process.env["ROLL_HOME"] ?? join(d.env.home, ".roll");
  const targetPath = machine ? join(rollHome, "agents.yaml") : ".roll/agents.yaml";

  if (!d.fileExists(targetPath)) {
    process.stdout.write(`  agent '${agent}' is not disabled in ${targetPath} (file not found)\n`);
    return 0;
  }

  const text = d.readText(targetPath);
  const current = readAgentDisabledFromText(text, agent);

  if (!current.disabled) {
    process.stdout.write(`  agent '${agent}' is already enabled in ${targetPath}\n`);
    return 0;
  }

  // Verify agent is declared
  const parsed = normalizeAgentScopeConfig(text);
  if (parsed.config === null || parsed.config.agents[agent] === undefined) {
    err(`agent enable: agent '${agent}' is not declared in ${targetPath}`);
    return 1;
  }

  const newText = setAgentDisabledInText(text, agent, false);
  try {
    d.writeFileAtomic(targetPath, newText);
  } catch (e) {
    err(`agent enable: failed to write ${targetPath}: ${String(e)}`);
    return 1;
  }
  process.stdout.write(`  agent '${agent}' enabled in ${targetPath}\n`);
  return 0;
}

export function agentCommand(args: string[], deps: AgentCommandDeps = {}): number {
  const [sub, ...rest] = args;
  if (sub === "list") return (deps.listCommand ?? agentListCommand)(rest);
  if (sub === "readiness") return readinessCommand(rest, deps);
  if (sub === "disable") return disableCommand(rest, deps);
  if (sub === "enable") return enableCommand(rest, deps);
  if (sub === "default") return defaultCommand(rest, deps);
  if (sub === "set") return setCommand(rest, deps);
  if (sub === "migrate") return migrateCommand(rest, deps);
  if (sub === "use") return useCommand(rest, deps); // retired — fails loud with migration guidance
  if (sub === undefined || sub === "") return viewCommand(deps);
  err(`Unknown subcommand: ${sub}`);
  process.stdout.write("Usage: roll agent [migrate [--dry-run]|list|readiness [agent]|disable <name> [--machine] [--force]|enable <name> [--machine]]\n");
  return 1;
}
