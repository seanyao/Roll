/**
 * @responsibility Resolves the warm-context session-reuse adapter for a routed agent.
 * lever-4 — cross-card WARM-CONTEXT adapter port (agent-AGNOSTIC).
 *
 * Warm-context (reusing a routed agent's prior session on the NEXT same-agent
 * card) is treated as a STANDARD agent capability declared by an engine's spec
 * (`sessionReuse`). The cycle path resolves ONE adapter via
 * `sessionReuseFor(agent, spec)` and calls its ports — it never branches
 * per-agent. After the pool was narrowed to 国产/开源 agents (kimi/pi/reasonix),
 * NO current engine declares a warm-reuse kind, so every engine resolves to the
 * COLD no-op adapter (the universal default). The port shape is preserved so a
 * future resumable engine is a registry-only addition.
 *
 * This module is PURE + zero-IO: rollout evidence and the ledger are passed IN
 * (the CLI does the file read/write/consume around it), so capture and matching
 * policy are unit-testable in isolation.
 */
import type { AgentUsageSpec } from "./specs.js";

/** One captured warm-session, persisted by the CLI to the loop ledger. The
 *  adapter reads these but never writes — it is pure. */
export interface WarmSessionEntry {
  storyId: string;
  cycleId: string;
  agent: string;
  sessionId: string;
  worktreePath: string;
  capturedAtSec: number;
  cycleStartSec: number;
  rolloutPath?: string;
  spawnedWarm: boolean;
}

export type ResumeScope = "off" | "same-story" | "cross-card-experimental";

export interface ResumeDecision {
  mode: "cold" | "resume";
  reason:
    | "policy_off"
    | "agent_unsupported"
    | "no_prior_session"
    | "scope_mismatch"
    | "stale_session"
    | "selected";
  sessionId?: string;
  sourceCycleId?: string;
  sourceStoryId?: string;
}

export interface CaptureWarmSessionInput {
  storyId: string;
  cycleId: string;
  agent: string;
  sessionId: string;
  worktreePath: string;
  rolloutPath?: string;
  rolloutMtimeSec: number;
  cycleStartSec: number;
  capturedAtSec: number;
  spawnedWarm: boolean;
}

/**
 * The warm-context port the cycle path drives. Agent-agnostic by construction:
 * the cold adapter satisfies the same shape with no-ops, so downstream code is
 * branch-free.
 */
export interface SessionReuseAdapter {
  /** True only for an engine that can resume a prior session. Cold ⇒ false. */
  supportsReuse(): boolean;
  /**
   * Resolve the session id to resume for `priorStoryId` from the ledger, or null
   * when there is no match (the universal cold path). NEXT-CARD-ONLY: it matches
   * exactly the entry keyed by that storyId — no epic/retry widening. SINGLE-USE
   * is the CALLER's responsibility (consume the entry after a successful resolve).
   */
  resolvePriorSessionId(ledger: readonly WarmSessionEntry[], priorStoryId: string): string | null;
  /**
   * Return the spawn options with the resumable session id injected, without
   * mutating the input (pure). Cold ⇒ returns opts unchanged. Generic over the
   * caller's options shape; the codex adapter sets `codexSessionId`.
   */
  injectSessionId<T extends Record<string, unknown>>(opts: T, sessionId: string): T;
  /**
   * The cold-fallback options: the spawn options as-is, with NO resume injected.
   * The universal default + the silent fail-safe the caller uses on any error.
   * Pure — returns the input unchanged.
   */
  coldFallback<T extends Record<string, unknown>>(opts: T): T;
}

/** The COLD no-op adapter: never resumes, never injects — the universal default
 *  for every current pool engine (and the fail-safe target on any error). */
const COLD_ADAPTER: SessionReuseAdapter = {
  supportsReuse: () => false,
  resolvePriorSessionId: () => null,
  injectSessionId: (opts) => opts,
  coldFallback: (opts) => opts,
};

/**
 * Resolve the warm-context adapter for an agent from its spec capability. Agent
 * name is accepted for symmetry / future engines but the DECISION is the spec's
 * `sessionReuse` kind — so adding a resumable engine is registry-only, no code
 * change here. No current pool engine declares a reuse kind, so this always
 * resolves to the cold no-op adapter (absent / 'none' ⇒ cold).
 */
export function sessionReuseFor(_agent: string, _spec: AgentUsageSpec | undefined): SessionReuseAdapter {
  return COLD_ADAPTER;
}

/**
 * lever-4 DEPTH-1 CAP (harness-safety, FIX-355). A warm-session may be captured
 * into the ledger ONLY when the cycle that just ran spawned COLD. A cycle that
 * itself RESUMED a prior session must NOT re-seed: otherwise warm context chains
 * UNBOUNDEDLY across cards (cold A → B resumes A → B re-seeds → C resumes A+B →
 * …), so every later card inherits an ever-growing, anchoring context and
 * eventually ALL cards degrade — the systemic failure mode (a single mis-built
 * harness sinks every future card, not just one). Capturing on COLD origin only
 * bounds every chain to a SINGLE hop: cold seeds → next card resumes once → does
 * NOT re-seed → the following card runs cold again (pattern: cold→warm→cold→warm).
 * `spawnedWarm` = "this cycle injected a resume id". Pure; the CLI passes the
 * fact in. Orthogonal to single-use consume (which only stops re-using ONE entry
 * twice; it does NOT stop the chain from extending — this cap does). */
export function shouldCaptureWarmSession(spawnedWarm: boolean): boolean {
  return !spawnedWarm;
}

export function captureWarmSession(input: CaptureWarmSessionInput): WarmSessionEntry | null {
  if (!shouldCaptureWarmSession(input.spawnedWarm)) return null;
  if (input.rolloutMtimeSec < input.cycleStartSec) return null;
  if (input.storyId.trim() === "" || input.cycleId.trim() === "") return null;
  if (input.agent.trim() === "" || input.sessionId.trim() === "") return null;
  if (input.worktreePath.trim() === "") return null;
  return {
    storyId: input.storyId,
    cycleId: input.cycleId,
    agent: input.agent,
    sessionId: input.sessionId,
    worktreePath: input.worktreePath,
    capturedAtSec: input.capturedAtSec,
    cycleStartSec: input.cycleStartSec,
    ...(input.rolloutPath !== undefined && input.rolloutPath !== "" ? { rolloutPath: input.rolloutPath } : {}),
    spawnedWarm: input.spawnedWarm,
  };
}

/**
 * Decide whether THIS card resumes a prior warm session. After the pool was
 * narrowed to 国产/开源 agents (kimi/pi/reasonix), NO current engine declares a
 * warm-reuse capability, so the only non-`off` outcome is `agent_unsupported`:
 * every cycle runs COLD. The `resumeScope` / ledger inputs are retained for the
 * caller's signature stability and a future resumable engine; an explicit `off`
 * scope still reports `policy_off`.
 */
export function decideWarmResume(input: {
  agent: string;
  storyId: string;
  resumeScope: ResumeScope;
  ledger: readonly WarmSessionEntry[];
  nowSec: number;
}): ResumeDecision {
  if (input.resumeScope === "off") return { mode: "cold", reason: "policy_off" };
  return { mode: "cold", reason: "agent_unsupported" };
}

export function isWarmSessionEntry(value: unknown): value is WarmSessionEntry {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec["storyId"] === "string" &&
    rec["storyId"] !== "" &&
    typeof rec["cycleId"] === "string" &&
    rec["cycleId"] !== "" &&
    typeof rec["agent"] === "string" &&
    rec["agent"] !== "" &&
    typeof rec["sessionId"] === "string" &&
    rec["sessionId"] !== "" &&
    typeof rec["worktreePath"] === "string" &&
    rec["worktreePath"] !== "" &&
    typeof rec["capturedAtSec"] === "number" &&
    Number.isFinite(rec["capturedAtSec"]) &&
    typeof rec["cycleStartSec"] === "number" &&
    Number.isFinite(rec["cycleStartSec"]) &&
    typeof rec["spawnedWarm"] === "boolean" &&
    (rec["rolloutPath"] === undefined || typeof rec["rolloutPath"] === "string")
  );
}
