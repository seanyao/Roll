/**
 * @responsibility Enforces the per-story self-heal agent-rotation budget.
 */
/**
 * FIX-930 — per-story self-heal agent-rotation budget (the anti-oscillation
 * backbone).
 *
 * When a cycle gives up with ZERO TCR (the agent ran but produced nothing), the
 * loop does NOT immediately PAUSE — it swaps to the next untried agent
 * ({@link resolveRouteExcluding}) and re-marks the story `📋 Todo` so the next
 * cycle re-picks it with a fresh agent. This store is what makes that bounded and
 * non-oscillating: it remembers WHICH agents were already tried on a story (so
 * the swap excludes them) and HOW MANY swaps have happened (so it stops after
 * {@link SELFHEAL_AGENT_BUDGET}).
 *
 * It MUST survive ACROSS cycles (a per-cycle counter would reset every pick and
 * the loop would ping-pong kimi↔pi↔reasonix forever) and clear ONLY on genuine
 * delivery (done/published/local) — {@link clearSelfHeal} is called alongside
 * `clearCardFailure`. Runtime-only: `.roll/loop/selfheal-cards.json`, gitignored
 * like skip-cards.json / consecutive-fails; it NEVER mutates backlog truth.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Max agent SWAPS per story before escalating (split/PAUSE). 2 swaps ⇒ up to 3
 *  rigs tried (the roster is kimi/pi/reasonix), then the roster naturally
 *  exhausts. Overridable via ROLL_LOOP_AGENT_RETRY_MAX. */
export const SELFHEAL_AGENT_BUDGET = 2;

/** Resolve the swap budget: env override (ROLL_LOOP_AGENT_RETRY_MAX) → default. */
export function selfHealBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env["ROLL_LOOP_AGENT_RETRY_MAX"] ?? "").trim();
  if (raw === "") return SELFHEAL_AGENT_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : SELFHEAL_AGENT_BUDGET;
}

/**
 * FIX-932 — the master kill-switch for the whole self-heal chain (detect →
 * switch → split). `ROLL_LOOP_NO_AUTO_RECOVER=1` disables agent-switching AND
 * auto-split, restoring the pre-FIX-928 fail-fast behaviour: a zero-TCR / stalled
 * cycle goes straight to the skip-list / consecutive-fail PAUSE path. Lets an
 * operator opt out (debugging a flaky rig, or wanting hard failures surfaced
 * immediately) without reverting code.
 */
export function autoRecoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["ROLL_LOOP_NO_AUTO_RECOVER"] ?? "").trim() !== "1";
}

export interface SelfHealEntry {
  /** Number of agent swaps performed so far for this story. */
  attempts: number;
  /** Agents already tried (and failed zero-TCR) — the exclude-set for the swap. */
  triedAgents: string[];
  /** The most recent swap reason (zero-tcr | stall), for observability. */
  lastReason: string;
}

interface SelfHealState {
  stories: Record<string, SelfHealEntry>;
}

const EMPTY: SelfHealEntry = { attempts: 0, triedAgents: [], lastReason: "" };

function stateFile(runtimeDir: string): string {
  return join(runtimeDir, "selfheal-cards.json");
}

function read(runtimeDir: string): SelfHealState {
  try {
    const p = stateFile(runtimeDir);
    if (!existsSync(p)) return { stories: {} };
    const o = JSON.parse(readFileSync(p, "utf8")) as Partial<SelfHealState>;
    return { stories: o.stories !== undefined && typeof o.stories === "object" ? o.stories : {} };
  } catch {
    return { stories: {} };
  }
}

function write(runtimeDir: string, s: SelfHealState): void {
  try {
    writeFileSync(stateFile(runtimeDir), JSON.stringify(s, null, 2), "utf8");
  } catch {
    /* best-effort — a write miss just re-attempts the same agent next cycle */
  }
}

/** Read a story's self-heal entry (a fresh zero-attempt entry when absent). */
export function readSelfHeal(runtimeDir: string, storyId: string): SelfHealEntry {
  if (storyId === "") return { ...EMPTY };
  const e = read(runtimeDir).stories[storyId];
  return e !== undefined
    ? { attempts: e.attempts ?? 0, triedAgents: Array.isArray(e.triedAgents) ? e.triedAgents : [], lastReason: e.lastReason ?? "" }
    : { ...EMPTY };
}

/**
 * Record one self-heal swap: add `failedAgent` to the tried-set (deduped),
 * bump `attempts`, stamp `lastReason`. Returns the updated entry. Empty
 * storyId/agent is a no-op that still returns the (unchanged) entry.
 */
export function recordSelfHealAttempt(
  runtimeDir: string,
  storyId: string,
  failedAgent: string,
  reason: string,
): SelfHealEntry {
  if (storyId === "") return { ...EMPTY };
  const s = read(runtimeDir);
  const prev = s.stories[storyId] ?? { ...EMPTY };
  const tried = new Set(prev.triedAgents);
  if (failedAgent !== "") tried.add(failedAgent);
  const next: SelfHealEntry = {
    attempts: prev.attempts + 1,
    triedAgents: [...tried],
    lastReason: reason,
  };
  s.stories[storyId] = next;
  write(runtimeDir, s);
  return next;
}

/** Drop a story's self-heal budget — called on its genuine delivery (done/
 *  published/local) alongside clearCardFailure, so a re-opened card starts fresh. */
export function clearSelfHeal(runtimeDir: string, storyId: string): void {
  if (storyId === "") return;
  const s = read(runtimeDir);
  if (s.stories[storyId] === undefined) return;
  delete s.stories[storyId];
  write(runtimeDir, s);
}
