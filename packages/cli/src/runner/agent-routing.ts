import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_REGISTRY_NAMES, type AgentInternalFailure, type CycleContext } from "@roll/core";
import type { AgentName, AgentScopeConfig, AgentScopeRole, AgentScopeRoleBinding } from "@roll/spec";
import type { RollEvent } from "@roll/spec";
import { agentCredentialReadiness } from "./agent-spawn.js";
import type { Ports } from "./ports.js";
import { readScopedAgentLayer } from "./scoped-route.js";
import { eventTs } from "./runner-time.js";

/** FIX-1051 — scan agy's native CLI log for internal tool errors.
 *
 * Triggered only when agy exits 0 with effectively empty stdout (control chars /
 * whitespace only) and no parseable usage. This distinguishes a genuine internal
 * tool failure from a plain gave_up/no-output cycle.
 *
 * Returns `null` when:
 *   - the agent is not agy,
 *   - the exit code is non-zero (a crash is already `failed`),
 *   - stdout carried printable content (the agent did produce output),
 *   - no native log matches the cycle window, or
 *   - the log contains none of the known internal-error patterns. */
export function detectAgyInternalFailure(opts: {
  agent: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cycleStartSec?: number;
  /** Test seam: override the native log directory. */
  logDir?: string;
}): AgentInternalFailure | null {
  if (opts.agent !== "agy") return null;
  if (opts.exitCode !== 0) return null;
  // Empty/control-only stdout: strip ASCII control chars + whitespace; anything
  // printable means the agent produced real output.
  const printable = opts.stdout.replace(/[\s\x00-\x1F\x7F]/g, "");
  if (printable.length > 0) return null;

  const logDir = opts.logDir ?? join(homedir(), ".gemini", "antigravity-cli", "log");
  let files: string[];
  try {
    files = readdirSync(logDir)
      .filter((f) => f.startsWith("cli-") && f.endsWith(".log"))
      .map((f) => join(logDir, f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  // Sort newest-first by mtime.
  files.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });

  // Prefer the most recent log modified at or after cycle start (with a 60s
  // slack in case the native log clock trails Roll's clock slightly).
  const startMs = opts.cycleStartSec !== undefined ? opts.cycleStartSec * 1000 : undefined;
  const candidates =
    startMs !== undefined
      ? files.filter((f) => {
          try {
            return statSync(f).mtimeMs >= startMs - 60_000;
          } catch {
            return false;
          }
        })
      : files;
  const logPath = candidates[0] ?? files[0];
  if (logPath === undefined) return null;

  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return null;
  }

  const hasGrepTimeout = /Grep command timed out due to the size of the codebase/i.test(text);
  const hasZeroTrajectory = /trajectory converted to zero chat messages/i.test(text);
  const hasAgentExecutorError = /agent executor error:/i.test(text);

  if (!hasGrepTimeout && !hasZeroTrajectory && !hasAgentExecutorError) return null;

  let className: string;
  let summary: string;
  if (hasGrepTimeout && hasZeroTrajectory) {
    className = "agy_grep_timeout_zero_trajectory";
    summary = "GREP_SEARCH timed out and trajectory collapsed to zero messages";
  } else if (hasGrepTimeout) {
    className = "agy_grep_timeout";
    summary = "GREP_SEARCH timed out due to codebase size";
  } else if (hasZeroTrajectory) {
    className = "agy_zero_trajectory";
    summary = "Trajectory converted to zero chat messages";
  } else {
    className = "agy_agent_executor_error";
    summary = "Agent executor error in native CLI";
  }

  const convMatch = /conversation[_-]?id[:=\s]+([a-zA-Z0-9_-]+)/i.exec(text);
  const conversationId = convMatch?.[1];

  return {
    class: className,
    summary,
    nativeLogPath: logPath,
    ...(conversationId !== undefined ? { conversationId } : {}),
  };
}

function scopedCandidateAgents(
  binding: AgentScopeRoleBinding,
  layers: readonly { config: AgentScopeConfig; path: string }[],
): AgentName[] | null {
  if (binding.kind === "inherit") return null;
  if (binding.kind === "fixed") return [binding.agent];
  const declared = new Map<AgentName, readonly AgentScopeRole[]>();
  for (const layer of layers) {
    for (const [agent, spec] of Object.entries(layer.config.agents) as [AgentName, NonNullable<AgentScopeConfig["agents"][AgentName]>][]) {
      declared.set(agent, spec.capabilities);
    }
  }
  const registryAgents = AGENT_REGISTRY_NAMES as readonly AgentName[];
  const pool: readonly AgentName[] =
    binding.from !== undefined && binding.from.length > 0 ? binding.from : registryAgents.filter((agent) => declared.has(agent));
  const required = binding.require ?? [];
  return pool.filter((agent) => {
    const caps = declared.get(agent) ?? [];
    return required.every((role) => caps.includes(role));
  });
}

function scopedEvaluateAllowedAgents(layers: readonly { config: AgentScopeConfig; path: string }[]): AgentName[] | null {
  for (const layer of [...layers].reverse()) {
    const binding = layer.config.defaults["story"]?.roles.evaluate ?? layer.config.roles.evaluate;
    if (binding === undefined) continue;
    const agents = scopedCandidateAgents(binding, layers);
    if (agents !== null) return agents;
  }
  return null;
}

/**
 * Project-config allowed agents from `.roll/agents.yaml`.
 * `roll-agents/v1` story.evaluate bindings are the sole project allowlist.
 */
export function projectAllowedAgents(repoCwd: string): Set<string> | undefined {
  const path = scopedAgentPolicyPath(repoCwd);
  const machinePath = join(process.env["ROLL_HOME"] ?? join(homedir(), ".roll"), "agents.yaml");
  const scopedLayers = [readScopedAgentLayer(machinePath), readScopedAgentLayer(path)].filter(
    (layer): layer is { config: AgentScopeConfig; path: string } => layer !== null,
  );
  if (scopedLayers.length > 0) {
    const agents = scopedEvaluateAllowedAgents(scopedLayers);
    return agents !== null ? new Set(agents) : undefined;
  }

  return undefined;
}

/** Workspace runtime policy is owned by `<workspace>/agents.yaml`; repository-
 * local project policy is migration input only and must never become a fallback. */
export function scopedAgentPolicyPath(root: string): string {
  return existsSync(join(root, "workspace.yaml"))
    ? join(root, "agents.yaml")
    : join(root, ".roll", "agents.yaml");
}

type AgentBlockedStage = Extract<RollEvent, { type: "agent:blocked" }>["stage"];

function missingCredentialDetail(agent: string, missingEnv: readonly string[]): string {
  return `missing required credential env for ${agent}: ${missingEnv.join(", ")} (set env or the agent profile dotfile before running unattended loop)`;
}

export function blockIfAgentCredentialsMissing(agent: string, stage: AgentBlockedStage, ports: Ports, ctx: CycleContext): string | null {
  const readiness = agentCredentialReadiness(agent, ports.agentCredentialEnv ?? process.env, ports.agentEnvHome);
  if (readiness.ok) return null;
  const detail = missingCredentialDetail(readiness.agent, readiness.missingEnv);
  ports.events.appendEvent(ports.paths.eventsPath, {
    type: "agent:blocked",
    cycleId: ctx.cycleId ?? "",
    agent: readiness.agent,
    cause: "auth",
    stage,
    detail,
    ts: eventTs(ports),
  });
  ports.events.appendAlert(
    ports.paths.alertsPath,
    `agent credential readiness: ${stage} agent ${readiness.agent} missing ${readiness.missingEnv.join(", ")}; set env or the agent profile dotfile, then resume the loop`,
  );
  return detail;
}
