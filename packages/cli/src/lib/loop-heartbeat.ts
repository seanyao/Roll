/**
 * US-DOSSIER-011 — loop heartbeat collection for the Truth Console overview.
 *
 * Best-effort, injected-fs: for each roll lane on this machine (loop / pr / dream),
 * report whether it is scheduled (launchd plist present), its period, the last
 * cycle stamp from runs.jsonl, and the derived next fire. A collection miss
 * yields an honest empty/partial lane — never a throw (the console must render
 * with whatever is knowable).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEventLine, parseGoalYaml, type GoalScope, type GoalStatus, type TruthSnapshotLoop, type TruthSnapshotLoopLane } from "@roll/spec";
import { resolveLoopRunState } from "../commands/loop-sched.js";

export interface HeartbeatDeps {
  /** plist text for a lane, or null when not installed. */
  plistText: (svc: string) => string | null;
  /** latest run stamp for a lane (ISO) or null. */
  lastRunAt: (svc: string) => string | null;
  /** current .roll/loop/goal.yaml text, or null when no go goal exists. */
  goalText?: () => string | null;
  /** .roll/loop/events.ndjson text for goal session reconstruction. */
  eventsText?: () => string | null;
  /**
   * US-LOOP-115: resolved loop run-state (ACTIVE / PAUSED).
   * Injected so the snapshot carries it and the dossier render stays pure.
   * Absent → snapshot omits runState and the renderer falls back to ACTIVE.
   */
  runState?: () => { state: "ACTIVE" | "PAUSED"; since?: string; reason?: string };
}

const LAUNCHD_LANES: Array<{ svc: "loop" | "dream"; name: string; mode: string }> = [
  { svc: "loop", name: "backlog loop", mode: "backlog" },
  { svc: "dream", name: "Dream loop", mode: "dream" },
];

export function defaultHeartbeatDeps(projectPath: string, slug: string, launchAgentsDir: string): HeartbeatDeps {
  const lastRunAt = (svc: string): string | null => {
    const file = svc === "dream" ? "dream.log" : "runs.jsonl";
    const path = join(projectPath, ".roll", "loop", file);
    try {
      const lines = readFileSync(path, "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] ?? "";
        if (line.trim() === "") continue;
        if (svc === "loop") {
          const row = JSON.parse(line) as { ts?: string };
          if (typeof row.ts === "string" && row.ts !== "") return row.ts;
        } else {
          const m = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{4})\]/.exec(line);
          if (m?.[1] !== undefined && m[2] !== undefined) {
            const tz = `${m[2].slice(0, 3)}:${m[2].slice(3)}`;
            const iso = new Date(`${m[1]}${tz}`).toISOString().replace(/\.\d{3}Z$/, "Z");
            return iso;
          }
        }
      }
    } catch {
      /* no lane run yet */
    }
    return null;
  };
  return {
    plistText: (svc) => {
      const p = join(launchAgentsDir, `com.roll.${svc}.${slug}.plist`);
      try {
        return existsSync(p) ? readFileSync(p, "utf8") : null;
      } catch {
        return null;
      }
    },
    lastRunAt,
    goalText: () => {
      try {
        return readFileSync(join(projectPath, ".roll", "loop", "goal.yaml"), "utf8");
      } catch {
        return null;
      }
    },
    eventsText: () => {
      try {
        return readFileSync(join(projectPath, ".roll", "loop", "events.ndjson"), "utf8");
      } catch {
        return null;
      }
    },
    // US-LOOP-115: two states (ACTIVE / PAUSED) resolved from the PAUSE marker.
    runState: () => ({ state: resolveLoopRunState(projectPath, slug) }),
  };
}

function periodMinutes(plist: string): number | undefined {
  const m = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist);
  if (m?.[1] !== undefined) return Math.round(Number(m[1]) / 60);
  if (plist.includes("<key>StartCalendarInterval</key>")) return 24 * 60; // daily calendar lane
  return undefined;
}

function addMinutes(iso: string, min: number): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms + min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isoFromSec(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function scopeLabel(scope: GoalScope): string {
  if (scope.kind === "all") return "all";
  if (scope.kind === "epic") return `epic: ${scope.epic}`;
  return `cards: ${scope.cards.join(", ")}`;
}

function activeGoalSession(eventsText: string | null): { open: boolean; lastAt?: string } {
  if (eventsText === null) return { open: false };
  let openSession: string | undefined;
  let lastAt: string | undefined;
  for (const line of eventsText.split("\n")) {
    const ev = parseEventLine(line);
    if (ev === null) continue;
    if (ev.type === "goal:session_start") {
      openSession = ev.sessionId;
      lastAt = isoFromSec(ev.ts);
    } else if (ev.type === "goal:session_end" && ev.sessionId === openSession) {
      openSession = undefined;
      lastAt = isoFromSec(ev.ts);
    }
  }
  return openSession !== undefined ? { open: true, ...(lastAt !== undefined ? { lastAt } : {}) } : { open: false, ...(lastAt !== undefined ? { lastAt } : {}) };
}

function goalLane(deps: HeartbeatDeps): TruthSnapshotLoopLane | undefined {
  const text = deps.goalText?.() ?? null;
  const session = activeGoalSession(deps.eventsText?.() ?? null);
  if (text === null && !session.open) return undefined;
  let status: GoalStatus | "unknown" = "unknown";
  let scope = "unknown";
  if (text !== null) {
    try {
      const goal = parseGoalYaml(text);
      status = goal.status;
      scope = scopeLabel(goal.scope);
    } catch {
      status = "unknown";
    }
  }
  return {
    name: "go session",
    source: "goal",
    running: session.open && status === "active",
    mode: "go",
    status,
    scope,
    ...(session.lastAt !== undefined ? { lastAt: session.lastAt } : {}),
  };
}

/** Collect the heartbeat lanes; lanes that are off still appear (state off). */
export function collectLoopHeartbeat(deps: HeartbeatDeps): TruthSnapshotLoop {
  const lanes: TruthSnapshotLoopLane[] = [];
  for (const { svc, name, mode } of LAUNCHD_LANES) {
    const plist = deps.plistText(svc);
    const running = plist !== null;
    const everyMin = plist !== null ? periodMinutes(plist) : undefined;
    const last = deps.lastRunAt(svc);
    const lane: TruthSnapshotLoopLane = {
      name,
      source: "launchd",
      running,
      mode,
      ...(everyMin !== undefined ? { everyMin } : {}),
    };
    if (last !== null) {
      lane.lastAt = last;
      if (everyMin !== undefined) {
        const next = addMinutes(last, everyMin);
        if (next !== undefined) lane.nextAt = next;
      }
    }
    lanes.push(lane);
  }
  const go = goalLane(deps);
  if (go !== undefined) lanes.push(go);
  const snapshot: TruthSnapshotLoop = { lanes };
  // US-LOOP-079l: carry the resolved run-state so the dossier render is a pure
  // function of the snapshot (3-state header + deterministic tests).
  const rs = deps.runState?.();
  if (rs !== undefined) {
    snapshot.runState = rs.state;
    if (rs.since !== undefined) snapshot.stateSince = rs.since;
    if (rs.reason !== undefined) snapshot.stateReason = rs.reason;
  }
  return snapshot;
}
