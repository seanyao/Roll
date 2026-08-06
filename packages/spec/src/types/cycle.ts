/**
 * @responsibility Declares the cycle contract types.
 */
/** Cycle contracts (BC2/BC8, I11/I12). */
import type { ToolCost } from "./tool.js";

export type CyclePhase =
  | "pick"
  | "route"
  | "worktree"
  | "execute"
  | "publish"
  | "merge-wait"
  | "reconcile"
  | "cleanup"
  | "stalled";

/** @deprecated Legacy v2/read-side outcome vocabulary. New writes use TerminalOutcome. */
export type LegacyCycleOutcome = "delivered" | "built" | "failed" | "blocked" | "aborted" | "reverted";

/** @deprecated Use TerminalOutcome; keep only for legacy read-side callers. */
export type CycleOutcome = LegacyCycleOutcome;

export interface CycleCost {
  cycleId: string;
  agent: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** FIX-249: cache token split (pi/claude report it) — absent = adapter had none. */
  cacheRead?: number;
  cacheWrite?: number;
  /** Cost estimate from real price table in native currency; missing prices stay explicit n/a upstream. */
  estimatedCost: number;
  /** TCR revert count this cycle. */
  revertCount: number;
  /** Cost including reverts — budget guardrails gate on this, not nominal (I11). */
  effectiveCost: number;
  /** FIX-361: native currency code (USD/CNY/etc) from the model's price config. */
  currency: string;
  /** US-TOOL-001: per-tool cost rows accumulated during this cycle. */
  toolCosts?: ToolCost[];
}
