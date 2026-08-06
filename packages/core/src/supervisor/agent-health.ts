/**
 * @responsibility Classifies agent toolchain health issues with recommended actions.
 * US-V4-022 — Supervisor agent toolchain health classification.
 *
 * Pure functions that turn observed agent signals (warnings, auth/network blocks,
 * polluted skill roots, stale setup sync, worktree permission failures) into
 * classified health issues with a recommended action and routing target.
 *
 * The Supervisor coordinates and diagnoses; it does not perform cleanup itself.
 */
import type {
  AgentHealthAction,
  AgentHealthIssue,
  AgentId,
  AgentToolchainClassification,
  AgentToolchainSignal,
  RollEvent,
} from "@roll/spec";

function lowerMessage(s: AgentToolchainSignal): string {
  return s.message.toLowerCase();
}

function hasAny(s: AgentToolchainSignal, keywords: readonly string[]): boolean {
  const m = lowerMessage(s);
  return keywords.some((k) => m.includes(k.toLowerCase()));
}

function looksLikeAuth(s: AgentToolchainSignal): boolean {
  const m = lowerMessage(s);
  const authWords = /\b(auth|authentication|authorized|unauthorized|forbidden)\b/;
  const loginPhrases = /\b(please run \/login|not logged in|login required)\b/;
  return authWords.test(m) || loginPhrases.test(m) || m.includes("403");
}

function looksLikeNetwork(s: AgentToolchainSignal): boolean {
  return hasAny(s, [
    "econnrefused",
    "etimedout",
    "enotfound",
    "network",
    "timeout",
    "dns",
    "cannot reach",
  ]);
}

function looksLikeWorktreePermission(s: AgentToolchainSignal): boolean {
  if (s.context?.worktreePath === undefined) return false;
  return hasAny(s, ["eacces", "permission denied", "eperm"]);
}

function looksLikeSkillRootPollution(s: AgentToolchainSignal): boolean {
  const m = lowerMessage(s);
  const inAuxiliaryDir =
    s.context?.skillRoot !== undefined &&
    /\/(?:\.reasonix|\.codex|\.cursor|\.kimi|\.claude|\.roll)\//i.test(s.context.skillRoot);
  const hasSkillWarning =
    m.includes("skill") && (m.includes("no description") || m.includes("auxiliary") || m.includes("polluted"));
  return inAuxiliaryDir || hasSkillWarning;
}

export interface AgentToolchainClassificationResult {
  readonly classification: AgentToolchainClassification;
  readonly severity: "warning" | "error";
}

/**
 * Classify a single agent toolchain signal.
 *
 * The Reasonix auxiliary-directory warning is the canonical fixture for
 * setup/skill-root pollution (US-V4-022 builder note).
 */
export function classifyAgentToolchainSignal(
  signal: AgentToolchainSignal,
): AgentToolchainClassificationResult {
  if (looksLikeAuth(signal)) return { classification: "auth_block", severity: signal.severity ?? "error" };
  if (looksLikeNetwork(signal)) return { classification: "network_block", severity: signal.severity ?? "error" };
  if (looksLikeWorktreePermission(signal))
    return { classification: "worktree_permission_failure", severity: signal.severity ?? "error" };
  if (looksLikeSkillRootPollution(signal))
    return { classification: "setup_skill_root_pollution", severity: signal.severity ?? "warning" };
  return { classification: "unknown_warning", severity: signal.severity ?? "warning" };
}

export interface AgentHealthRecommendation {
  readonly action: AgentHealthAction;
  readonly routing: "delivery_team" | "owner" | "none";
}

/**
 * Recommend an operational action class for a classified issue.
 *
 * - setup/skill-root pollution → create a FIX for the delta team (do not label auth).
 * - auth_block / worktree_permission_failure → pause for owner intervention.
 * - network_block → continue (transient; the loop will retry or breathe).
 * - unknown_warning → continue (monitor).
 */
export function recommendAgentHealthAction(
  classification: AgentToolchainClassification,
): AgentHealthRecommendation {
  switch (classification) {
    case "setup_skill_root_pollution":
      return { action: "create_fix", routing: "delivery_team" };
    case "auth_block":
    case "worktree_permission_failure":
      return { action: "pause_for_owner", routing: "owner" };
    case "network_block":
      return { action: "continue", routing: "none" };
    case "unknown_warning":
      return { action: "continue", routing: "none" };
  }
}

function eventToSignal(ev: RollEvent): AgentToolchainSignal | null {
  if (ev.type === "agent:toolchain_issue") {
    return {
      agent: ev.agent,
      message: ev.detail,
      source: ev.source,
      severity: ev.severity,
    };
  }
  if (ev.type === "agent:blocked") {
    return {
      agent: ev.agent,
      message: ev.detail,
      source: `${ev.type}/${ev.stage}`,
      severity: "error",
    };
  }
  return null;
}

/**
 * Build a flat list of classified agent health issues from the durable event stream.
 */
export function gatherAgentToolchainIssues(events: readonly RollEvent[]): AgentHealthIssue[] {
  const issues: AgentHealthIssue[] = [];
  for (const ev of events) {
    const sig = eventToSignal(ev);
    if (sig === null) continue;
    const { classification, severity } = classifyAgentToolchainSignal(sig);
    const { action, routing } = recommendAgentHealthAction(classification);
    issues.push({
      agent: sig.agent,
      classification,
      severity,
      action,
      reason: `${classification.replace(/_/g, " ")} on ${sig.agent}`,
      detail: sig.message,
      source: sig.source,
      routing,
    });
  }
  return issues;
}

/**
 * Summarise a list of issues into a single human-readable sentence.
 */
export function summarizeAgentHealthIssues(issues: readonly AgentHealthIssue[]): string {
  if (issues.length === 0) return "agent toolchain health: clean";
  const byAgent = new Map<AgentId, number>();
  for (const i of issues) byAgent.set(i.agent, (byAgent.get(i.agent) ?? 0) + 1);
  const parts = [...byAgent.entries()].map(([agent, n]) => `${agent}(${n})`);
  return `agent toolchain issues: ${parts.join(", ")}`;
}
