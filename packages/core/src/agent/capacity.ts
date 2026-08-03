import type {
  AgentName,
  AgentScopeConfig,
  NormalizedAgentCapacityPolicy,
} from "@roll/spec";

export const DEFAULT_CAPACITY_HEARTBEAT_SECONDS = 30;
export const DEFAULT_CAPACITY_STALE_AFTER_SECONDS = 120;

/** Derive broker limits from machine authority without persisting defaults. */
export function normalizeAgentCapacityPolicy(
  machine: AgentScopeConfig,
): NormalizedAgentCapacityPolicy {
  const enabled = Object.values(machine.agents)
    .filter((agent) => agent !== undefined && agent.disabled !== true)
    .map((agent) => agent.id)
    .sort();
  const configured = machine.capacity;
  const defaultPerAgent = configured?.defaultPerAgent ?? 1;
  const perAgent: Partial<Record<AgentName, number>> = {};
  for (const agent of enabled) {
    perAgent[agent] = configured?.agents[agent] ?? defaultPerAgent;
  }
  const sum = Object.values(perAgent).reduce((total, limit) => total + (limit ?? 0), 0);
  return {
    global: configured?.global === undefined || configured.global === "auto" ? sum : configured.global,
    perAgent,
    heartbeatSeconds: configured?.heartbeatSeconds ?? DEFAULT_CAPACITY_HEARTBEAT_SECONDS,
    staleAfterSeconds: configured?.staleAfterSeconds ?? DEFAULT_CAPACITY_STALE_AFTER_SECONDS,
  };
}
