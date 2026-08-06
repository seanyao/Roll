/**
 * @responsibility Guards the expected agent roster and forbidden position tokens.
 */
import { AGENTS, REMOVED_AGENTS } from "./specs.js";

export const EXPECTED_AGENT_ROSTER = ["claude", "kimi", "codex", "pi", "agy", "reasonix", "cursor"] as const;
export const AGENT_POSITION_FORBIDDEN_TOKENS = [...REMOVED_AGENTS, "openai", "deepseek"] as const;

export interface AgentRosterSurface {
  name: string;
  agents: readonly string[];
}

export interface AgentPositionValue {
  surface: string;
  context: string;
  value: string;
  kind: "agent" | "model" | "provider";
}

export interface AgentRosterGateInput {
  surfaces: readonly AgentRosterSurface[];
  agentPositions: readonly AgentPositionValue[];
}

export interface AgentRosterGateResult {
  ok: boolean;
  gaps: string[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function sameRoster(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = [...actual].map(normalize).sort();
  const e = [...expected].map(normalize).sort();
  return a.every((value, index) => value === e[index]);
}

export function evaluateAgentRosterGate(input: AgentRosterGateInput): AgentRosterGateResult {
  const gaps: string[] = [];
  for (const surface of input.surfaces) {
    if (!sameRoster(surface.agents, EXPECTED_AGENT_ROSTER)) {
      gaps.push(`${surface.name} roster drift: expected ${EXPECTED_AGENT_ROSTER.join(", ")}, got ${surface.agents.join(", ")}`);
    }
  }

  const forbidden = new Set<string>(AGENT_POSITION_FORBIDDEN_TOKENS.map(normalize));
  for (const entry of input.agentPositions) {
    if (entry.kind !== "agent") continue;
    const value = normalize(entry.value);
    if (forbidden.has(value)) {
      gaps.push(`${entry.surface} has forbidden agent-position token ${entry.value} in ${entry.context}`);
    }
  }

  return { ok: gaps.length === 0, gaps };
}

export function liveAgentRosterGateInput(): AgentRosterGateInput {
  return {
    surfaces: [{ name: "AGENTS", agents: AGENTS.map((spec) => spec.name) }],
    agentPositions: AGENTS.map((spec) => ({ surface: "AGENTS", context: "AgentSpec.name", value: spec.name, kind: "agent" })),
  };
}
