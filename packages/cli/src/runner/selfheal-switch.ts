/**
 * @responsibility Decides and actuates the zero-TCR agent switch.
 */
/**
 * FIX-930 — the zero-TCR agent-switch decision + actuation, factored out of the
 * loop-run-once driver so it is unit-testable with injected ports (no real spawn,
 * no real clock; the budget store is an injected runtime dir).
 *
 * When a cycle gives up with zero TCR (the routed agent ran but produced nothing,
 * or stalled), the loop should try the NEXT untried agent in the tier chain
 * before treating it as a failure. {@link maybeSwitchAgent} is the decision: it
 * returns `true` ONLY when it has committed a swap (recorded the failed agent,
 * re-marked the story Todo, emitted `agent:retry`). The caller then returns 0
 * WITHOUT ticking the consecutive-failure counter — a self-heal is not a systemic
 * failure. It returns `false` when the per-story budget is spent OR the roster is
 * exhausted (every routable agent already tried), so the caller escalates
 * (FIX-931 split / PAUSE).
 *
 * The next cycle's route resolution (executor route port) re-applies the SAME
 * exclusion via resolveRouteExcluding(triedAgents), so the re-picked story routes
 * the fresh agent deterministically — the decision here and the actuation there
 * agree by construction.
 */
import { classifyComplexity, resolveRouteExcluding, type RouteDeps } from "@roll/core";
import type { RollEvent } from "@roll/spec";
import { readSelfHeal, recordSelfHealAttempt, type SelfHealEntry } from "./selfheal-budget.js";

export interface SwitchAgentDeps {
  /** MAIN-project runtime dir holding selfheal-cards.json. */
  runtimeDir: string;
  storyId: string;
  /** The agent that just gave up zero-TCR (excluded from the next route). */
  failedAgent: string;
  reason: "stall" | "zero-tcr";
  /** The story's est_min (for tier classification); undefined ⇒ default tier. */
  estMin: number | undefined;
  routeDeps: RouteDeps;
  /** Max agent swaps per story (SELFHEAL_AGENT_BUDGET / env override). */
  budget: number;
  cycleId: string;
  /** Epoch seconds (injected for deterministic tests). */
  now: () => number;
  /** Append the agent:retry event (best-effort). */
  emit: (ev: RollEvent) => void;
  /** Re-mark the story `📋 Todo` so the next cycle re-picks it. */
  remarkTodo: (storyId: string) => void;
  /** Seams for tests; default to the real store. */
  readEntry?: (rt: string, storyId: string) => SelfHealEntry;
  recordAttempt?: (rt: string, storyId: string, failedAgent: string, reason: string) => SelfHealEntry;
}

export function maybeSwitchAgent(deps: SwitchAgentDeps): boolean {
  if (deps.storyId === "" || deps.failedAgent === "") return false;
  const read = deps.readEntry ?? readSelfHeal;
  const record = deps.recordAttempt ?? recordSelfHealAttempt;

  const entry = read(deps.runtimeDir, deps.storyId);
  if (entry.attempts >= deps.budget) return false; // budget spent → escalate

  const tier = classifyComplexity(deps.estMin);
  const next = resolveRouteExcluding(tier, deps.routeDeps, [...entry.triedAgents, deps.failedAgent]);
  if (next === null) return false; // every routable agent already tried → escalate

  const updated = record(deps.runtimeDir, deps.storyId, deps.failedAgent, deps.reason);
  deps.remarkTodo(deps.storyId);
  deps.emit({
    type: "agent:retry",
    cycleId: deps.cycleId,
    storyId: deps.storyId,
    fromAgent: deps.failedAgent,
    toAgent: next.agent,
    attempt: updated.attempts,
    reason: deps.reason,
    ts: deps.now(),
  });
  return true;
}
