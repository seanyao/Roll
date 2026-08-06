/**
 * @responsibility Declares the policy contract types.
 */
/** Policy contracts (BC6) — human intent, read and obeyed by loops. */
import type { AgentId, ModelId } from "./agent.js";

export interface RoutingRule {
  match: { level?: string; type?: string };
  agent: AgentId;
  model: ModelId;
  /** Availability fallback slot (pre-spawn only — never a failure-retry chain, I6). */
  fallback?: { agent: AgentId; model: ModelId };
  rationale?: string;
}

export interface LoopSafetyPolicy {
  /** Consecutive failures before PAUSE + ALERT + human decision (I6). */
  maxConsecutiveFailures: number;
}
