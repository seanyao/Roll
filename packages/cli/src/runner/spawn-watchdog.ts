/**
 * US-CYCLE-002 — per-role sub-agent spawn watchdog. A supervisor delegates to
 * sequential heterogeneous subagents (designer / evaluator / adversarial builder
 * / pick-ranking); each of those spawns is wrapped by {@link spawnWatched} so it
 * runs under the shared US-CYCLE-001 watchdog with a config-driven per-role cap.
 * A productive run survives on git-state renewal in its OWN cwd; a silent stall
 * dies on schedule with a terminal-visible, durably-recorded `spawn:kill`.
 *
 * Extracted from spawn-observers.ts (REFACTOR-060 module-size guard).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CycleContext,
  type RunKillReason,
  type RunWatchThresholds,
  type WatchdogRole,
  ROLE_TIMEOUT_SCAFFOLD,
  formatSpawnKillLine,
  roleTimeoutGuidance,
  watchRun,
} from "@roll/core";
import type { RollEvent } from "@roll/spec";
import { killLiveAgents } from "./agent-spawn.js";
import type { Ports } from "./ports.js";
import { epochMs } from "./runner-time.js";
import { recordSpawnRound } from "./round-journal-emit.js";

/** Poll cadence for a sub-agent watchdog (ms). Overridable via
 *  ROLL_TIMEOUT_POLL_MS for tests. */
const SPAWN_POLL_MS = 5_000;

/** A spawn's fine-grained purpose, mapped to a capped {@link WatchdogRole}. */
export type WatchdogSpawnPurpose =
  | "builder"
  | "designer"
  | "evaluator"
  | "scorer"
  | "peer"
  | "test_author"
  | "implementer"
  | "attacker"
  | "pick_ranking";

/** Map a spawn purpose to its watchdog role: code-writing roles → builder;
 *  review/score/rank roles → evaluator; designer → designer. */
export function watchdogRoleFor(purpose: WatchdogSpawnPurpose): WatchdogRole {
  switch (purpose) {
    case "designer":
      return "designer";
    case "evaluator":
    case "scorer":
    case "peer":
    case "pick_ranking":
      return "evaluator";
    default:
      return "builder"; // builder / test_author / implementer / attacker
  }
}

/** One-per-process guard so the loud FIX-1249 guidance is not repeated every spawn. */
const notifiedMissingRoleTimeout = new Set<WatchdogRole>();

/** Test-only: clear the one-shot notice guard so a test can re-observe the loud
 *  fallback. Not used in production. */
export function resetRoleTimeoutNotices(): void {
  notifiedMissingRoleTimeout.clear();
}

/**
 * US-CYCLE-002 — resolve per-role watchdog thresholds (seconds). Resolution
 * order, per role and per field:
 *   1. Env overrides (`ROLL_ROLE_WALL_MIN_<ROLE>` etc.) — tests / operators pin
 *      a value without editing config;
 *   2. `.roll/agents.yaml` `watchdog.role_timeouts.<role>` (the config home);
 *   3. the SCAFFOLD SEED ({@link ROLE_TIMEOUT_SCAFFOLD}) — used ONLY with a LOUD
 *      one-time {@link roleTimeoutGuidance} notice (FIX-1249: announced +
 *      materializable, never a silent `?? HARDCODED` mask). The cap is never
 *      omittable, but a missing config is guided, not a cycle-toppling throw.
 */
export function readRoleTimeouts(repoCwd: string): Record<WatchdogRole, RunWatchThresholds> {
  const envNum = (key: string): number | undefined => {
    const raw = (process.env[key] ?? "").trim();
    if (raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  let configured: Record<string, { wall_min?: number; no_progress_min?: number; no_state_change_min?: number }> = {};
  try {
    const p = join(repoCwd, ".roll", "agents.yaml");
    if (existsSync(p)) {
      const parsed = parseWatchdogRoleTimeouts(readFileSync(p, "utf8"));
      if (parsed !== undefined) configured = parsed;
    }
  } catch {
    /* unreadable agents.yaml → the scaffold-seed fallback (with notice) below */
  }
  const out = {} as Record<WatchdogRole, RunWatchThresholds>;
  for (const role of Object.keys(ROLE_TIMEOUT_SCAFFOLD) as WatchdogRole[]) {
    const seed = ROLE_TIMEOUT_SCAFFOLD[role];
    const cfg = configured[role];
    const roleUpper = role.toUpperCase();
    // `wall_min` is the MANDATORY cap. It is loud whenever unresolved — including
    // a PARTIAL config block that sets only no_progress/no_state_change but omits
    // wall_min (codex r1: gating on `cfg === undefined` let that silently fall
    // back to the seed, violating FIX-1249's loud fallback for the wall cap).
    const wallMin = envNum(`ROLL_ROLE_WALL_MIN_${roleUpper}`) ?? cfg?.wall_min;
    if (wallMin === undefined && !notifiedMissingRoleTimeout.has(role)) {
      notifiedMissingRoleTimeout.add(role);
      process.stderr.write(roleTimeoutGuidance(role) + "\n");
    }
    const noProgMin = envNum(`ROLL_ROLE_NO_PROGRESS_MIN_${roleUpper}`) ?? cfg?.no_progress_min ?? seed.noProgressMin;
    const noStateMin = envNum(`ROLL_ROLE_NO_STATE_CHANGE_MIN_${roleUpper}`) ?? cfg?.no_state_change_min ?? seed.noStateChangeMin;
    out[role] = {
      wallSec: (wallMin ?? seed.wallMin) * 60,
      noProgressSec: noProgMin * 60,
      noStateChangeSec: noStateMin * 60,
    };
  }
  return out;
}

/** Minimal, dependency-free reader for the `watchdog.role_timeouts` block of
 *  agents.yaml. Tolerant: only the keys it recognizes are extracted; anything
 *  malformed yields `undefined` (→ scaffold-seed fallback with notice). */
function parseWatchdogRoleTimeouts(
  yamlText: string,
): Record<string, { wall_min?: number; no_progress_min?: number; no_state_change_min?: number }> | undefined {
  const lines = yamlText.split("\n");
  let inWatchdog = false;
  let inRoleTimeouts = false;
  const out: Record<string, { wall_min?: number; no_progress_min?: number; no_state_change_min?: number }> = {};
  const numFrom = (s: string, key: string): number | undefined => {
    const m = new RegExp(`${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)`).exec(s);
    return m ? Number(m[1]) : undefined;
  };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (/^watchdog\s*:/.test(line)) {
      inWatchdog = true;
      inRoleTimeouts = false;
      continue;
    }
    if (inWatchdog && /^\S/.test(line)) break; // dedent out of the watchdog block
    if (inWatchdog && /^\s+role_timeouts\s*:/.test(line)) {
      inRoleTimeouts = true;
      continue;
    }
    if (inRoleTimeouts) {
      const m = /^\s+([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
      if (m) {
        const role = m[1] as string;
        const rest = m[2] as string;
        const entry: { wall_min?: number; no_progress_min?: number; no_state_change_min?: number } = {};
        const w = numFrom(rest, "wall_min");
        const np = numFrom(rest, "no_progress_min");
        const ns = numFrom(rest, "no_state_change_min");
        if (w !== undefined) entry.wall_min = w;
        if (np !== undefined) entry.no_progress_min = np;
        if (ns !== undefined) entry.no_state_change_min = ns;
        out[role] = entry;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * US-CYCLE-002 — wrap a SUB-agent spawn with the shared run-watchdog. The caller
 * supplies its OWN spawn call as `run` (so each site keeps its purpose / env /
 * writable-roots / Promise.race), and gains, uniformly and with NO bypass:
 *   - a per-role timeout cap ({@link readRoleTimeouts}, config-driven / FIX-1249);
 *   - liveness renewal on git-state progress observed in the run's OWN cwd
 *     (US-CYCLE-001) — a long PRODUCTIVE subagent is never mis-killed;
 *   - a durable `spawn:kill` event (role/agent/model/reason/duration — the
 *     terminal-visible accounting) emitted BEFORE the kill, plus `spawn:renew`
 *     events on progress;
 *   - per-role failure accounting into the round-journal (US-CYCLE-012 consumes
 *     `kill:<reason>` outcomes).
 * `run` receives `markProgress` so a caller with a stdout stream can feed the
 * true-silence fuse. Returns the spawn result (with `timedOut` folded true on a
 * kill) and the structured `firedReason`.
 */
export async function spawnWatched<T>(opts: {
  ports: Ports;
  ctx: CycleContext;
  purpose: WatchdogSpawnPurpose;
  agent: string;
  model?: string;
  /** The run's OWN work dir — handed to the git probes (US-CYCLE-001). */
  observeCwd: string;
  /** Integration base for commits-ahead (defaults to the port's own base). */
  observeBase?: string;
  run: (markProgress: () => void) => Promise<T>;
}): Promise<{ result: T; firedReason: RunKillReason | null }> {
  const { ports, ctx, purpose, agent, observeCwd, observeBase, run } = opts;
  const role = watchdogRoleFor(purpose);
  const model = opts.model ?? (ctx.model !== undefined && ctx.model !== "" ? ctx.model : undefined);
  const thresholds = readRoleTimeouts(ports.repoCwd)[role];
  const cycleId = ctx.cycleId ?? "";
  const clock = ports.clock;
  const startSec = clock();
  const pollMs = Number((process.env["ROLL_TIMEOUT_POLL_MS"] ?? "").trim()) || SPAWN_POLL_MS;
  const statusSig = ports.git.worktreeStatusSignature;
  const appendEvent = (ev: RollEvent): void => {
    try {
      ports.events.appendEvent(ports.paths.eventsPath, ev);
    } catch {
      /* event append is best-effort observability */
    }
  };
  const handle = watchRun({
    cwd: observeCwd,
    clock,
    thresholds,
    progressSignals: {
      commitCount: (cwd) => ports.git.commitsAhead(cwd, observeBase),
      ...(statusSig !== undefined ? { stateSignature: (cwd: string) => statusSig(cwd) } : {}),
    },
    onTimeout: (info) => {
      // Record FIRST (durable), then the watchdog kills — the trip is observable
      // even if the kill races the subagent exiting on its own.
      const durationSec = Math.max(0, Math.round(clock() - startSec));
      appendEvent({
        type: "spawn:kill",
        cycleId,
        role,
        agent,
        ...(model !== undefined ? { model } : {}),
        reason: info.reason,
        durationSec,
        ts: epochMs(clock()),
      });
      // Terminal-visible: role/model/reason/duration at a glance (the stale-kill
      // screenshot line). Best-effort — never let a write topple the cycle.
      try {
        process.stderr.write(formatSpawnKillLine({ role, agent, ...(model !== undefined ? { model } : {}), reason: info.reason, durationSec }) + "\n");
      } catch {
        /* stderr write is best-effort */
      }
    },
    onRenew: (info) => {
      appendEvent({ type: "spawn:renew", cycleId, role, agent, signal: info.signal, idleSec: info.idleSec, ts: epochMs(clock()) });
    },
    kill: () => killLiveAgents("SIGKILL"),
    pollMs,
  });
  let result: T;
  let firedReason: RunKillReason | null = null;
  try {
    result = await run(handle.markProgress);
  } catch (e) {
    // The spawn died before settling (a crash / out-of-band kill). Record it as
    // an external termination for accounting, then let the caller handle it.
    handle.stop({ external: true });
    throw e;
  }
  // Clean settle — the watchdog fired only if a window actually tripped (else null).
  firedReason = handle.stop().firedReason;
  const durMs = Math.max(0, Math.round((clock() - startSec) * 1000));
  const timedOut = (result as { timedOut?: boolean } | null | undefined)?.timedOut === true;
  const outcome =
    firedReason !== null && firedReason !== "external" ? `kill:${firedReason}` : timedOut ? "timeout" : "delivered";
  recordSpawnRound(ports, ctx, { role, ...(model !== undefined ? { model } : {}), start: epochMs(startSec), durMs, outcome });
  // Fold a watchdog kill into `timedOut` — only when the result is an object
  // (a caller whose own race resolved `null` keeps that null sentinel).
  if (firedReason !== null && firedReason !== "external" && result !== null && typeof result === "object") {
    result = { ...(result as object), timedOut: true } as T;
  }
  return { result, firedReason };
}
