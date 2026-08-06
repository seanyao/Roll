/**
 * @responsibility Normalizes the roll-agents/v1 agent scope schema.
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

function parseDefaults(node: YamlValue | undefined, errors: string[]): Record<string, AgentScopeDefaults> {
  const defaults: Record<string, AgentScopeDefaults> = {};
  if (!isMap(node)) return defaults;
  for (const [scopeName, rawNode] of Object.entries(node)) {
    const m = isMap(rawNode) ? rawNode : {};
    defaults[scopeName] = { roles: parseRoles(m["roles"], `defaults.${scopeName}.roles`, errors) };
  }
  return defaults;
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

  const config: AgentScopeConfig = {
    schema: AGENT_SCOPE_SCHEMA,
    scope: (scope ?? "project") as AgentScopeConfig["scope"],
    ...(stringValue(root["inherits"]) !== undefined ? { inherits: stringValue(root["inherits"]) as string } : {}),
    agents: parseAgents(root["agents"], errors),
    models: parseModels(root["models"]),
    roles: parseRoles(root["roles"], "roles", errors),
    defaults: parseDefaults(root["defaults"], errors),
  };
  return { config, errors };
}
