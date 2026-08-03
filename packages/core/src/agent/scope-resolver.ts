/**
 * US-V4-016 — pure resolver for recursive Agent Scope / Role bindings.
 *
 * The resolver does not spawn agents and does not mutate config. Runtime health
 * is an input to the current resolution only.
 */
import {
  type AgentName,
  type AgentScopeConfig,
  type AgentScopeKind,
  type AgentScopeResolutionFailure,
  type AgentScopeResolutionTrace,
  type AgentScopeRole,
  type AgentScopeRoleBinding,
  type AgentScopeRoleResolution,
  type AgentScopeSkippedCandidate,
  type AgentHealthSignal,
} from "@roll/spec";

export interface AgentScopeResolveLayer {
  readonly config: AgentScopeConfig;
  readonly path: string;
}

export interface AgentScopeRuntimeHealth {
  readonly available: boolean;
  readonly reason?: string;
}

export interface ResolveAgentScopeRoleInput {
  readonly scope: AgentScopeKind;
  readonly role: AgentScopeRole;
  readonly layers: readonly AgentScopeResolveLayer[];
  readonly runtimeHealth?: Readonly<Partial<Record<AgentName, AgentScopeRuntimeHealth>>>;
  /** Larger means more recently used. Missing means never used. */
  readonly recentUse?: Readonly<Partial<Record<AgentName, number>>>;
  readonly healthSignals?: readonly AgentHealthSignal[];
  /** Already-resolved role assignments used by `avoid`. */
  readonly assignedRoles?: Readonly<Partial<Record<AgentScopeRole, AgentName>>>;
  /** FIX-1267 — agents to HARD-exclude from a `select` pool this resolution
   *  (e.g. the previous cycle's Builder, enforcing the no-consecutive-repeat
   *  rotation). A `select` role skips them with reason `no-consecutive-repeat`;
   *  if the exclusion empties the pool the resolution fails loud (never repeats
   *  the excluded agent silently). Ignored by `fixed` bindings (a fixed agent is
   *  an explicit owner override, not a rotation pool). */
  readonly excludeAgents?: readonly AgentName[];
  readonly seed?: string;
}

interface BindingCandidate {
  readonly scope: AgentScopeKind;
  readonly source: string;
  readonly binding: AgentScopeRoleBinding;
}

const PROJECT_RESOLUTION_SCOPES: readonly AgentScopeKind[] = ["machine", "project", "story", "skill"];
const WORKSPACE_RESOLUTION_SCOPES: readonly AgentScopeKind[] = ["machine", "workspace", "story", "skill"];

function workspaceMode(input: ResolveAgentScopeRoleInput): boolean {
  return input.scope === "workspace" || input.layers.some((layer) => layer.config.scope === "workspace");
}

function resolutionScopes(input: ResolveAgentScopeRoleInput): readonly AgentScopeKind[] {
  return workspaceMode(input) ? WORKSPACE_RESOLUTION_SCOPES : PROJECT_RESOLUTION_SCOPES;
}

function scopeRank(scope: AgentScopeKind, scopes: readonly AgentScopeKind[]): number {
  const i = scopes.indexOf(scope);
  return i >= 0 ? i : scopes.length;
}

function layerFor(layers: readonly AgentScopeResolveLayer[], scope: AgentScopeKind): AgentScopeResolveLayer | undefined {
  return [...layers].reverse().find((layer) => layer.config.scope === scope);
}

function bindingChain(input: ResolveAgentScopeRoleInput): BindingCandidate[] {
  const scopes = resolutionScopes(input);
  const targetRank = scopeRank(input.scope, scopes);
  const chain: BindingCandidate[] = [];
  for (let i = targetRank; i >= 0; i -= 1) {
    const scope = scopes[i];
    if (scope === undefined) continue;
    const layer = layerFor(input.layers, scope);
    if (layer === undefined) continue;
    if (scope === input.scope) {
      const binding = layer.config.roles[input.role];
      if (binding !== undefined) chain.push({ scope, source: `${layer.path}:roles.${input.role}`, binding });
      continue;
    }

    const scopedDefault = layer.config.defaults[input.scope]?.roles[input.role];
    if (scopedDefault !== undefined) {
      chain.push({ scope, source: `${layer.path}:defaults.${input.scope}.roles.${input.role}`, binding: scopedDefault });
    }
    const inherited = layer.config.roles[input.role];
    if (inherited !== undefined) chain.push({ scope, source: `${layer.path}:roles.${input.role}`, binding: inherited });
  }
  return chain;
}

function capabilityLayers(input: ResolveAgentScopeRoleInput): readonly AgentScopeResolveLayer[] {
  if (!workspaceMode(input)) return input.layers;
  return input.layers.filter((layer) => layer.config.scope === "machine");
}

function agentDeclarations(input: ResolveAgentScopeRoleInput): Map<AgentName, readonly AgentScopeRole[]> {
  const out = new Map<AgentName, readonly AgentScopeRole[]>();
  for (const layer of capabilityLayers(input)) {
    for (const [agent, spec] of Object.entries(layer.config.agents) as [AgentName, NonNullable<AgentScopeConfig["agents"][AgentName]>][]) {
      out.set(agent, spec.capabilities);
    }
  }
  return out;
}

/** US-AGENT-050 — check whether an agent is disabled in ANY config layer.
 *  Project-layer disable overrides machine-layer enable (project is more
 *  specific). An agent not declared anywhere is treated as not disabled. */
function isAgentDisabled(input: ResolveAgentScopeRoleInput, agent: AgentName): boolean {
  for (const layer of [...capabilityLayers(input)].reverse()) {
    const spec = layer.config.agents[agent];
    if (spec?.disabled === true) return true;
  }
  return false;
}

function declaredAgents(input: ResolveAgentScopeRoleInput): AgentName[] {
  const out: AgentName[] = [];
  for (const layer of capabilityLayers(input)) {
    for (const agent of Object.keys(layer.config.agents) as AgentName[]) {
      if (!out.includes(agent)) out.push(agent);
    }
  }
  return out;
}

function unavailableReason(input: ResolveAgentScopeRoleInput, agent: AgentName): string | null {
  const health = input.runtimeHealth?.[agent];
  if (health === undefined || health.available) return null;
  return `unavailable: ${health.reason ?? "runtime-health"}`;
}

function latestHealthSignal(input: ResolveAgentScopeRoleInput, agent: AgentName): AgentHealthSignal | undefined {
  let latest: AgentHealthSignal | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  const now = Date.now();
  for (const signal of input.healthSignals ?? []) {
    if (signal.agent !== agent) continue;
    if (signal.expiresAt !== undefined) {
      const expires = Date.parse(signal.expiresAt);
      if (!Number.isNaN(expires) && expires < now) continue;
    }
    const observed = Date.parse(signal.observedAt);
    const score = Number.isNaN(observed) ? 0 : observed;
    if (latest === undefined || score >= latestMs) {
      latest = signal;
      latestMs = score;
    }
  }
  return latest;
}

function healthAwareSkip(input: ResolveAgentScopeRoleInput, agent: AgentName): string | null {
  const signal = latestHealthSignal(input, agent);
  if (signal?.status !== "blocked") return null;
  return `health-blocked: ${signal.reason ?? "blocked"}`;
}

function healthRank(input: ResolveAgentScopeRoleInput, agent: AgentName): number {
  const signal = latestHealthSignal(input, agent);
  if (signal === undefined || signal.status === "unknown") return 10;
  if (signal.status === "healthy") return 40;
  if (signal.status === "degraded") return 0;
  return -100;
}

function hash(seed: string, agent: AgentName): number {
  let h = 2166136261;
  const text = `${seed}:${agent}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function orderedAvailable(binding: Extract<AgentScopeRoleBinding, { kind: "select" }>, available: readonly AgentName[], input: ResolveAgentScopeRoleInput): AgentName[] {
  const withIndex = available.map((agent, index) => ({ agent, index }));
  if (binding.strategy === "least-recent") {
    return withIndex
      .sort((a, b) => (input.recentUse?.[a.agent] ?? Number.NEGATIVE_INFINITY) - (input.recentUse?.[b.agent] ?? Number.NEGATIVE_INFINITY) || a.index - b.index)
      .map((x) => x.agent);
  }
  if (binding.strategy === "seeded-random") {
    const seed = input.seed ?? `${input.scope}:${input.role}`;
    return withIndex
      .sort((a, b) => hash(seed, a.agent) - hash(seed, b.agent) || a.index - b.index)
      .map((x) => x.agent);
  }
  if (binding.strategy === "health-aware") {
    return withIndex
      .sort((a, b) => {
        const health = healthRank(input, b.agent) - healthRank(input, a.agent);
        if (health !== 0) return health;
        const recent = (input.recentUse?.[a.agent] ?? Number.NEGATIVE_INFINITY) - (input.recentUse?.[b.agent] ?? Number.NEGATIVE_INFINITY);
        return recent !== 0 ? recent : a.index - b.index;
      })
      .map((x) => x.agent);
  }
  return available.slice();
}

function failure(input: ResolveAgentScopeRoleInput, fields: Omit<AgentScopeResolutionFailure, "scope" | "role">): AgentScopeRoleResolution {
  return {
    ok: false,
    failure: {
      scope: input.scope,
      role: input.role,
      ...fields,
    },
  };
}

function resolveFixed(input: ResolveAgentScopeRoleInput, candidate: BindingCandidate, trace: readonly AgentScopeResolutionTrace[]): AgentScopeRoleResolution {
  const binding = candidate.binding;
  if (binding.kind !== "fixed") throw new Error("resolveFixed called with non-fixed binding");
  if (workspaceMode(input)) {
    const machine = agentDeclarations(input);
    const capabilities = machine.get(binding.agent);
    if (capabilities === undefined) {
      return failure(input, {
        source: candidate.source,
        errors: [`${candidate.source}: fixed agent '${binding.agent}' is not declared in machine scope`],
        candidates: [binding.agent],
        skipped: [{ agent: binding.agent, reason: "not-declared-in-machine" }],
        trace: [...trace, { source: candidate.source, bindingKind: "fixed", action: "fail" }],
      });
    }
    if (!capabilities.includes(input.role)) {
      return failure(input, {
        source: candidate.source,
        errors: [`${candidate.source}: fixed agent '${binding.agent}' lacks role capability '${input.role}'`],
        candidates: [binding.agent],
        skipped: [{ agent: binding.agent, reason: `missing-role-capability: ${input.role}` }],
        trace: [...trace, { source: candidate.source, bindingKind: "fixed", action: "fail" }],
      });
    }
    if (binding.model !== undefined) {
      const machineAgent = capabilityLayers(input)
        .flatMap((layer) => [layer.config.agents[binding.agent]])
        .find((agent) => agent !== undefined);
      if (machineAgent?.models?.includes(binding.model) !== true) {
        return failure(input, {
          source: candidate.source,
          errors: [`${candidate.source}: fixed model '${binding.model}' is not declared for machine agent '${binding.agent}'`],
          candidates: [binding.agent],
          skipped: [{ agent: binding.agent, reason: `model-not-declared-for-machine-agent: ${binding.model}` }],
          trace: [...trace, { source: candidate.source, bindingKind: "fixed", action: "fail" }],
        });
      }
    }
  }
  // US-AGENT-050 — a disabled agent cannot be resolved even for fixed bindings.
  if (isAgentDisabled(input, binding.agent)) {
    return failure(input, {
      source: candidate.source,
      errors: [`${candidate.source}: fixed agent '${binding.agent}' is disabled`],
      candidates: [binding.agent],
      skipped: [{ agent: binding.agent, reason: "disabled" }],
      trace: [...trace, { source: candidate.source, bindingKind: "fixed", action: "fail" }],
    });
  }
  const unavailable = unavailableReason(input, binding.agent);
  if (unavailable !== null) {
    return failure(input, {
      source: candidate.source,
      errors: [`${candidate.source}: fixed agent '${binding.agent}' unavailable: ${unavailable.replace(/^unavailable: /, "")}`],
      candidates: [binding.agent],
      skipped: [{ agent: binding.agent, reason: unavailable }],
      trace: [...trace, { source: candidate.source, bindingKind: "fixed", action: "fail" }],
    });
  }
  return {
    ok: true,
    resolved: {
      scope: input.scope,
      role: input.role,
      agent: binding.agent,
      ...(binding.model !== undefined ? { model: binding.model } : {}),
      binding,
      source: candidate.source,
      selectedStrategy: "fixed",
      candidates: [binding.agent],
      skipped: [],
      trace: [...trace, { source: candidate.source, bindingKind: "fixed", action: "resolve" }],
    },
  };
}

function skipForAgent(
  agent: AgentName,
  binding: Extract<AgentScopeRoleBinding, { kind: "select" }>,
  declarations: ReadonlyMap<AgentName, readonly AgentScopeRole[]>,
  input: ResolveAgentScopeRoleInput,
): string | null {
  // US-AGENT-050 — owner-disabled agents are hard-excluded from ALL pools.
  if (workspaceMode(input) && !declarations.has(agent)) return "not-declared-in-machine";
  if (isAgentDisabled(input, agent)) return "disabled";
  // FIX-1267 — the no-consecutive-repeat rotation exclusion is a hard skip,
  // reported first so the audit trail names it explicitly (a previous builder is
  // excluded because it just built, not because it lacks a capability).
  if (input.excludeAgents !== undefined && input.excludeAgents.includes(agent)) return "no-consecutive-repeat";
  for (const avoidedRole of binding.avoid ?? []) {
    if (input.assignedRoles?.[avoidedRole] === agent) return `assigned-to-avoided-role: ${avoidedRole}`;
  }
  const caps = declarations.get(agent) ?? [];
  if (workspaceMode(input) && !caps.includes(input.role)) return `missing-role-capability: ${input.role}`;
  for (const required of binding.require ?? []) {
    if (!caps.includes(required)) return `missing-required-capability: ${required}`;
  }
  const healthBlocked = healthAwareSkip(input, agent);
  if (healthBlocked !== null) return healthBlocked;
  return unavailableReason(input, agent);
}

function resolveSelect(input: ResolveAgentScopeRoleInput, candidate: BindingCandidate, trace: readonly AgentScopeResolutionTrace[]): AgentScopeRoleResolution {
  const binding = candidate.binding;
  if (binding.kind !== "select") throw new Error("resolveSelect called with non-select binding");
  const declarations = agentDeclarations(input);
  const candidates = binding.from !== undefined && binding.from.length > 0 ? [...binding.from] : declaredAgents(input);
  const skipped: AgentScopeSkippedCandidate[] = [];
  const available: AgentName[] = [];
  for (const agent of candidates) {
    const reason = skipForAgent(agent, binding, declarations, input);
    if (reason !== null) skipped.push({ agent, reason });
    else available.push(agent);
  }

  if (available.length === 0) {
    // FIX-1267 — distinguish a pool emptied SOLELY by the no-consecutive-repeat
    // exclusion so the caller can fail loud with an actionable message (add
    // another execute-capable agent, or disable the rotation) instead of the
    // generic "no candidates" error.
    const rotationExhausted = skipped.length > 0 && skipped.every((s) => s.reason === "no-consecutive-repeat");
    const errors = rotationExhausted
      ? [`${candidate.source}: no candidate after no-consecutive-repeat exclusion (only the previous builder was available)`]
      : [`${candidate.source}: no candidates available`];
    return failure(input, {
      source: candidate.source,
      errors,
      candidates,
      skipped,
      trace: [...trace, { source: candidate.source, bindingKind: "select", action: "fail" }],
    });
  }

  const [agent] = orderedAvailable(binding, available, input);
  return {
    ok: true,
    resolved: {
      scope: input.scope,
      role: input.role,
      agent: agent as AgentName,
      binding,
      source: candidate.source,
      selectedStrategy: binding.strategy,
      candidates,
      skipped,
      trace: [...trace, { source: candidate.source, bindingKind: "select", action: "select" }],
    },
  };
}

/** Resolve one Scope + Role to an auditable Agent assignment. Pure + total. */
export function resolveAgentScopeRole(input: ResolveAgentScopeRoleInput): AgentScopeRoleResolution {
  const chain = bindingChain(input);
  const scopes = resolutionScopes(input);
  const trace: AgentScopeResolutionTrace[] = [];
  let index = 0;
  while (index < chain.length) {
    const candidate = chain[index] as BindingCandidate;
    const binding = candidate.binding;
    if (binding.kind === "inherit") {
      trace.push({ source: candidate.source, bindingKind: "inherit", action: "inherit" });
      if (binding.from !== undefined) {
        const target = scopeRank(binding.from as AgentScopeKind, scopes);
        const next = chain.findIndex((c, i) => i > index && scopeRank(c.scope, scopes) <= target);
        index = next >= 0 ? next : chain.length;
      } else {
        index += 1;
      }
      continue;
    }
    if (binding.kind === "fixed") return resolveFixed(input, candidate, trace);
    if (binding.kind === "select") return resolveSelect(input, candidate, trace);
    index += 1;
  }
  return failure(input, {
    errors: [`${input.scope}.${input.role}: no binding found`],
    candidates: [],
    skipped: [],
    trace,
  });
}
