/**
 * US-V4-015 — pure normalizer for `roll-agents/v1`.
 *
 * This is the new Agent-domain schema, separate from the legacy route-profile
 * normalizer in config-v4.ts. It does not alter loop routing yet.
 */
import {
  AGENT_BINDING_STRATEGIES,
  AGENT_SCOPE_KINDS,
  AGENT_SCOPE_ROLES,
  AGENT_SCOPE_SCHEMA,
  type AgentBindingStrategy,
  type AgentCapacityPolicy,
  type AgentName,
  type AgentScopeAgent,
  type AgentScopeConfig,
  type AgentScopeConfigParse,
  type AgentScopeDefaults,
  type AgentScopeModel,
  type AgentScopeRole,
  type AgentScopeRoleBinding,
  type ModelId,
} from "@roll/spec";
import { agentIsKnown, canonicalAgentName } from "./registry.js";
import { parseBlockYaml, type YamlMap } from "./config-v4.js";

type YamlValue = string | number | boolean | null | YamlMap;

function isMap(v: unknown): v is YamlMap {
  return typeof v === "object" && v !== null;
}

function stringValue(v: YamlValue | undefined): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function positiveInteger(v: YamlValue | undefined, where: string, errors: string[]): number | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  errors.push(`${where}: expected a positive integer`);
  return undefined;
}

function asStringList(v: YamlValue | undefined): string[] {
  if (typeof v !== "string") return [];
  const t = v.trim();
  if (t === "") return [];
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => s.trim()).filter((s) => s !== "");
  }
  return [t];
}

function parseRoleList(v: YamlValue | undefined, where: string, errors: string[]): AgentScopeRole[] {
  const out: AgentScopeRole[] = [];
  for (const raw of asStringList(v)) {
    if ((AGENT_SCOPE_ROLES as readonly string[]).includes(raw)) out.push(raw as AgentScopeRole);
    else errors.push(`${where}: unknown role '${raw}'`);
  }
  return out;
}

function parseAgentList(v: YamlValue | undefined, where: string, errors: string[]): AgentName[] {
  const out: AgentName[] = [];
  for (const raw of asStringList(v)) {
    const canon = canonicalAgentName(raw);
    if (!agentIsKnown(canon)) {
      errors.push(`${where}: unknown agent '${raw}'`);
      continue;
    }
    out.push(canon as AgentName);
  }
  return out;
}

function parseBinding(node: YamlValue | undefined, where: string, errors: string[]): AgentScopeRoleBinding | null {
  if (!isMap(node)) {
    errors.push(`${where}: malformed binding (expected a map)`);
    return null;
  }

  if (node["inherit"] === true || node["kind"] === "inherit") {
    const from = stringValue(node["from"]);
    return from !== undefined ? { kind: "inherit", from } : { kind: "inherit" };
  }

  const use = stringValue(node["use"]);
  const kind = stringValue(node["kind"]);
  if (use !== undefined || kind === "fixed") {
    const rawAgent = use ?? stringValue(node["agent"]);
    if (rawAgent === undefined) {
      errors.push(`${where}: fixed binding missing agent`);
      return null;
    }
    const agent = canonicalAgentName(rawAgent);
    if (!agentIsKnown(agent)) {
      errors.push(`${where}: unknown agent '${rawAgent}'`);
      return null;
    }
    const model = stringValue(node["model"]);
    return model !== undefined ? { kind: "fixed", agent: agent as AgentName, model } : { kind: "fixed", agent: agent as AgentName };
  }

  const selectNode = isMap(node["select"]) ? (node["select"] as YamlMap) : kind === "select" ? node : null;
  if (selectNode !== null) {
    const rawStrategy = stringValue(selectNode["strategy"]) ?? "first-available";
    const strategy = (AGENT_BINDING_STRATEGIES as readonly string[]).includes(rawStrategy)
      ? (rawStrategy as AgentBindingStrategy)
      : null;
    if (strategy === null) errors.push(`${where}: unknown strategy '${rawStrategy}'`);
    return {
      kind: "select",
      from: parseAgentList(selectNode["from"], `${where}.from`, errors),
      require: parseRoleList(selectNode["require"], `${where}.require`, errors),
      avoid: parseRoleList(selectNode["avoid"], `${where}.avoid`, errors),
      strategy: strategy ?? "first-available",
    };
  }

  errors.push(`${where}: malformed binding (need inherit|fixed|select)`);
  return null;
}

function parseRoles(node: YamlValue | undefined, where: string, errors: string[]): Partial<Record<AgentScopeRole, AgentScopeRoleBinding>> {
  const roles: Partial<Record<AgentScopeRole, AgentScopeRoleBinding>> = {};
  if (node === undefined || node === null) return roles;
  if (!isMap(node)) {
    errors.push(`${where}: malformed roles block (expected a map)`);
    return roles;
  }
  for (const [rawRole, bindingNode] of Object.entries(node)) {
    if (!(AGENT_SCOPE_ROLES as readonly string[]).includes(rawRole)) {
      errors.push(`${where}.${rawRole}: unknown role`);
      continue;
    }
    const binding = parseBinding(bindingNode, `${where}.${rawRole}`, errors);
    if (binding !== null) roles[rawRole as AgentScopeRole] = binding;
  }
  return roles;
}

function parseAgents(node: YamlValue | undefined, errors: string[]): Partial<Record<AgentName, AgentScopeAgent>> {
  const agents: Partial<Record<AgentName, AgentScopeAgent>> = {};
  const seen = new Map<string, string>();
  if (node === undefined || node === null) return {};
  if (!isMap(node)) {
    errors.push("agents: malformed agents block (expected a map)");
    return {};
  }
  for (const [rawId, rawNode] of Object.entries(node)) {
    const id = canonicalAgentName(rawId);
    if (!agentIsKnown(id)) {
      errors.push(`agents.${rawId}: unknown agent`);
      continue;
    }
    const prior = seen.get(id);
    if (prior !== undefined) {
      errors.push(`agents.${rawId}: duplicate canonical agent '${id}' (already declared as '${prior}')`);
      continue;
    }
    seen.set(id, rawId);
    const m = isMap(rawNode) ? rawNode : {};
    const adapterRaw = stringValue(m["adapter"]) ?? id;
    const adapter = canonicalAgentName(adapterRaw);
    if (!agentIsKnown(adapter)) {
      errors.push(`agents.${rawId}.adapter: unknown agent '${adapterRaw}'`);
      continue;
    }
    agents[id as AgentName] = {
      id: id as AgentName,
      adapter: adapter as AgentName,
      ...(stringValue(m["home"]) !== undefined ? { home: stringValue(m["home"]) as string } : {}),
      ...(stringValue(m["convention"]) !== undefined ? { convention: stringValue(m["convention"]) as string } : {}),
      capabilities: parseRoleList(m["capabilities"], `agents.${rawId}.capabilities`, errors),
      ...(asStringList(m["models"]).length > 0 ? { models: asStringList(m["models"]) } : {}),
      ...(m["disabled"] === true ? { disabled: true } : {}),
    };
  }
  return agents;
}

function parseModels(node: YamlValue | undefined): Record<ModelId, AgentScopeModel> {
  const models: Record<ModelId, AgentScopeModel> = {};
  if (!isMap(node)) return models;
  for (const [id, rawNode] of Object.entries(node)) {
    const m = isMap(rawNode) ? rawNode : {};
    models[id] = {
      id,
      ...(stringValue(m["provider"]) !== undefined ? { provider: stringValue(m["provider"]) as string } : {}),
      ...(asStringList(m["capabilities"]).length > 0 ? { capabilities: asStringList(m["capabilities"]) } : {}),
      ...(typeof m["context_tokens"] === "number" ? { contextTokens: m["context_tokens"] as number } : {}),
      ...(m["cost_class"] === "low" || m["cost_class"] === "medium" || m["cost_class"] === "high" ? { costClass: m["cost_class"] } : {}),
    };
  }
  return models;
}

const WORKSPACE_TOP_LEVEL_KEYS = new Set(["schema", "scope", "inherits", "roles", "defaults"]);
const WORKSPACE_DEFAULT_SCOPES = new Set(["story", "skill"]);

/** Canonical closed Workspace casting scope used by every Workspace creator. */
export function renderDefaultWorkspaceAgentScope(): string {
  return `schema: ${AGENT_SCOPE_SCHEMA}\nscope: workspace\ninherits: machine\n\nroles: {}\n`;
}

function validateWorkspaceTopLevel(root: YamlMap, errors: string[]): void {
  for (const key of Object.keys(root)) {
    if (!WORKSPACE_TOP_LEVEL_KEYS.has(key)) errors.push(`workspace: key '${key}' is not allowed`);
  }
  if (stringValue(root["inherits"]) !== "machine") errors.push("workspace.inherits: expected 'machine'");
}

function parseDefaults(node: YamlValue | undefined, errors: string[], workspace = false): Record<string, AgentScopeDefaults> {
  const defaults: Record<string, AgentScopeDefaults> = {};
  if (!isMap(node)) {
    if (workspace && node !== undefined && node !== null) {
      errors.push("workspace.defaults: malformed defaults block (expected a map)");
    }
    return defaults;
  }
  for (const [scopeName, rawNode] of Object.entries(node)) {
    if (workspace && !WORKSPACE_DEFAULT_SCOPES.has(scopeName)) {
      errors.push(`workspace.defaults.${scopeName}: unknown default scope`);
      continue;
    }
    if (workspace && !isMap(rawNode)) {
      errors.push(`workspace.defaults.${scopeName}: malformed default block (expected a map)`);
      continue;
    }
    const m = isMap(rawNode) ? rawNode : {};
    if (workspace) {
      for (const key of Object.keys(m)) {
        if (key !== "roles") errors.push(`workspace.defaults.${scopeName}.${key}: unknown key`);
      }
    }
    defaults[scopeName] = { roles: parseRoles(m["roles"], `defaults.${scopeName}.roles`, errors) };
  }
  return defaults;
}

const CAPACITY_KEYS = new Set([
  "global",
  "default_per_agent",
  "agents",
  "heartbeat_seconds",
  "stale_after_seconds",
]);

function parseCapacity(node: YamlValue | undefined, errors: string[]): AgentCapacityPolicy | undefined {
  if (node === undefined || node === null) return undefined;
  if (!isMap(node)) {
    errors.push("capacity: malformed capacity block (expected a map)");
    return undefined;
  }
  for (const key of Object.keys(node)) {
    if (!CAPACITY_KEYS.has(key)) errors.push(`capacity.${key}: unknown key`);
  }

  const rawGlobal = node["global"];
  let global: number | "auto" | undefined;
  if (rawGlobal === "auto") global = "auto";
  else global = positiveInteger(rawGlobal, "capacity.global", errors);

  const defaultPerAgent = positiveInteger(
    node["default_per_agent"],
    "capacity.default_per_agent",
    errors,
  );
  const heartbeatSeconds = positiveInteger(
    node["heartbeat_seconds"],
    "capacity.heartbeat_seconds",
    errors,
  );
  const staleAfterSeconds = positiveInteger(
    node["stale_after_seconds"],
    "capacity.stale_after_seconds",
    errors,
  );

  const agents: Partial<Record<AgentName, number>> = {};
  const seen = new Map<string, string>();
  const rawAgents = node["agents"];
  if (!isMap(rawAgents)) {
    errors.push("capacity.agents: malformed agents block (expected a map)");
  } else {
    for (const [rawAgent, rawLimit] of Object.entries(rawAgents)) {
      const agent = canonicalAgentName(rawAgent);
      if (!agentIsKnown(agent)) {
        errors.push(`capacity.agents.${rawAgent}: unknown agent`);
        continue;
      }
      const prior = seen.get(agent);
      if (prior !== undefined) {
        errors.push(`capacity.agents.${rawAgent}: duplicate canonical agent '${agent}' (already declared as '${prior}')`);
        continue;
      }
      seen.set(agent, rawAgent);
      const limit = positiveInteger(rawLimit, `capacity.agents.${rawAgent}`, errors);
      if (limit !== undefined) agents[agent as AgentName] = limit;
    }
  }

  if (
    heartbeatSeconds !== undefined &&
    staleAfterSeconds !== undefined &&
    staleAfterSeconds <= heartbeatSeconds
  ) {
    errors.push("capacity.stale_after_seconds: must be greater than heartbeat_seconds");
  }
  const largest = Math.max(0, ...Object.values(agents));
  if (typeof global === "number" && largest > global) {
    errors.push(`capacity.global: must be at least the largest per-agent limit (${largest})`);
  }

  if (
    global === undefined ||
    defaultPerAgent === undefined ||
    heartbeatSeconds === undefined ||
    staleAfterSeconds === undefined
  ) return undefined;
  return { global, defaultPerAgent, agents, heartbeatSeconds, staleAfterSeconds };
}

/** Normalize a `roll-agents/v1` file into a typed Scope config. Pure + total. */
export function normalizeAgentScopeConfig(text: string): AgentScopeConfigParse {
  const errors: string[] = [];
  const root = parseBlockYaml(text ?? "");
  if (root["schema"] !== AGENT_SCOPE_SCHEMA) {
    return { config: null, errors: [`schema: expected '${AGENT_SCOPE_SCHEMA}'`] };
  }
  const rawScope = stringValue(root["scope"]);
  const scope = rawScope !== undefined && (AGENT_SCOPE_KINDS as readonly string[]).includes(rawScope)
    ? rawScope
    : null;
  if (scope === null) errors.push(`scope: unknown or missing scope '${rawScope ?? ""}'`);
  const workspace = scope === "workspace";
  if (workspace) validateWorkspaceTopLevel(root, errors);
  if (scope !== null && scope !== "machine" && scope !== "workspace" && root["capacity"] !== undefined) {
    errors.push(`${scope}.capacity: capacity is machine-only`);
  }
  const capacity = scope === "machine" ? parseCapacity(root["capacity"], errors) : undefined;

  const config: AgentScopeConfig = {
    schema: AGENT_SCOPE_SCHEMA,
    scope: (scope ?? "project") as AgentScopeConfig["scope"],
    ...(stringValue(root["inherits"]) !== undefined ? { inherits: stringValue(root["inherits"]) as string } : {}),
    agents: workspace ? {} : parseAgents(root["agents"], errors),
    models: workspace ? {} : parseModels(root["models"]),
    roles: parseRoles(root["roles"], "roles", errors),
    defaults: parseDefaults(root["defaults"], errors, workspace),
    ...(capacity !== undefined ? { capacity } : {}),
  };
  return { config, errors };
}
