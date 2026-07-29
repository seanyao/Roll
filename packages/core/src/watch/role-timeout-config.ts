/**
 * US-CYCLE-002 — per-role spawn-watchdog timeout caps, CONFIG-DRIVEN (FIX-1249).
 *
 * A supervisor delegates to sequential heterogeneous subagents (designer,
 * evaluator, adversarial builder roles, pick-ranking). Each spawn is wrapped by
 * the shared run-watchdog (US-CYCLE-001) with a per-role cap so a 156-minute
 * PRODUCTIVE builder survives while a silent evaluator stall dies in 20 minutes.
 *
 * The caps live in `.roll/agents.yaml` (`watchdog.role_timeouts`), NOT as a
 * source-baked runtime default. This module is PURE (no I/O): it holds the
 * SCAFFOLD SEED (the starting values written into config) and the loud guidance
 * shown when config is absent. Two rules, mirroring model-config.ts:
 *   1. A configured cap reaches the watchdog thresholds.
 *   2. When a role's cap is unconfigured, the caller emits {@link roleTimeoutGuidance}
 *      (a LOUD notice) and falls back to the scaffold seed — the value is announced
 *      and materializable into config, never a silent `?? HARDCODED` mask.
 * The watchdog must never TOPPLE a cycle by failing to read config, so the
 * fallback proceeds; "fail-loud" here means the notice, not a throw.
 */

/** The three roles that carry a per-role spawn-watchdog cap. */
export const WATCHDOG_ROLES = ["builder", "evaluator", "designer"] as const;
export type WatchdogRole = (typeof WATCHDOG_ROLES)[number];

/** A role's caps expressed in MINUTES (the config unit). */
export interface RoleTimeoutMinutes {
  /** Absolute wall-clock ceiling. Mandatory per role. */
  readonly wallMin: number;
  /** True-silence window (no commit / no file change / no stdout). */
  readonly noProgressMin: number;
  /** No-git-state-change window (no commit AND no dirty change, even if noisy). */
  readonly noStateChangeMin: number;
}

/**
 * The SCAFFOLD SEED per role — the recommended starting caps the spec names
 * (builder 120min / evaluator 20min / designer 20min). Used ONLY to (a) write an
 * initial `watchdog.role_timeouts` block into agents.yaml and (b) back the loud
 * fallback when config is absent. NEVER a silent runtime default.
 */
export const ROLE_TIMEOUT_SCAFFOLD: Readonly<Record<WatchdogRole, RoleTimeoutMinutes>> = {
  builder: { wallMin: 120, noProgressMin: 30, noStateChangeMin: 40 },
  evaluator: { wallMin: 20, noProgressMin: 10, noStateChangeMin: 15 },
  designer: { wallMin: 20, noProgressMin: 10, noStateChangeMin: 15 },
};

/** The YAML block to seed into `.roll/agents.yaml` (onboarding / doctor / the
 *  guidance body). Deterministic — no interpolation of runtime values. */
export function roleTimeoutScaffoldYaml(): string {
  const line = (r: WatchdogRole): string => {
    const t = ROLE_TIMEOUT_SCAFFOLD[r];
    return `    ${r}:${" ".repeat(Math.max(1, 10 - r.length))}{ wall_min: ${t.wallMin}, no_progress_min: ${t.noProgressMin}, no_state_change_min: ${t.noStateChangeMin} }`;
  };
  return ["watchdog:", "  role_timeouts:", line("builder"), line("evaluator"), line("designer"), ""].join("\n");
}

/**
 * US-CYCLE-002 — the terminal-visible one-line summary of a killed sub-agent
 * spawn. Renders role / model / reason / duration so a supervisor reads WHAT
 * died and WHY at a glance (the screenshot-evidence line for a stale kill).
 */
export function formatSpawnKillLine(info: {
  role: string;
  agent: string;
  model?: string;
  reason: string;
  durationSec: number;
}): string {
  const model = info.model !== undefined && info.model !== "" ? info.model : "-";
  return `[roll] spawn:kill role=${info.role} agent=${info.agent} model=${model} reason=${info.reason} duration=${info.durationSec}s`;
}

/**
 * The LOUD guidance shown once when a role's cap is unconfigured. Names the file,
 * the exact keys, and a ready-to-paste block — so the default is announced and
 * materializable, never silently hardcoded (FIX-1249).
 */
export function roleTimeoutGuidance(role: WatchdogRole): string {
  return [
    `[roll] watchdog: no per-role spawn timeout configured for role "${role}".`,
    `Watchdog caps are config-driven — the source ships no silent runtime default (FIX-1249).`,
    `Falling back to the recommended cap this run; add the block to .roll/agents.yaml to pin it (no rebuild):`,
    "",
    roleTimeoutScaffoldYaml(),
  ].join("\n");
}
