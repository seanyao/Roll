/**
 * US-DOSSIER-011 — loop heartbeat collection for the Truth Console overview.
 *
 * Best-effort, injected-fs. A collection miss yields an honest empty/partial
 * lane — never a throw (the console must render with whatever is knowable).
 *
 * US-LOOP-118: this used to report each launchd lane as `running` when its plist
 * existed, read a period out of that plist, and add it to the last run stamp to
 * PREDICT `nextAt`. All three claims died with resident scheduling: a plist drives
 * nothing, so its `StartInterval` describes nobody's schedule and no fire is
 * coming. Lanes are now derived from what actually happened — the go session, and
 * recent runs — while a plist still on disk is reported as leftover debris with
 * `running: false` and no predicted next fire.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEFTOVER_LANE_STATUS, parseEventLine, parseGoalYaml, type GoalScope, type GoalStatus, type TruthSnapshotLoop, type TruthSnapshotLoopLane } from "@roll/spec";
import { resolveLoopRunState } from "../commands/loop-state.js";

export interface HeartbeatDeps {
  /**
   * Is a `com.roll.<svc>.<slug>` plist still on disk for this lane?
   *
   * US-LOOP-118: was `plistText`, because the period had to be parsed out of the
   * XML. Nothing reads the period any more, so the only question is existence —
   * and a `true` here means leftover debris, not a running lane.
   */
  laneLeftover: (svc: string) => boolean;
  /** latest run stamp for a lane (ISO) or null. */
  lastRunAt: (svc: string) => string | null;
  /** current .roll/loop/goal.yaml text, or null when no go goal exists. */
  goalText?: () => string | null;
  /** .roll/loop/events.ndjson text for goal session reconstruction. */
  eventsText?: () => string | null;
  /**
   * Is a cycle streaming right now, and when did it last write?
   *
   * codex r11: a goal lane only exists for `roll loop go`; a bare `roll loop
   * run-once` writes no goal event, so a running cycle was invisible here. `running`
   * and `at` come from the SAME observation (live.log's mtime) so a live stream can
   * never be read as stale.
   */
  liveStream?: () => { running: boolean; at?: string };
  /**
   * US-LOOP-115: resolved loop run-state (ACTIVE / PAUSED).
   * Injected so the snapshot carries it and the dossier render stays pure.
   * Absent → snapshot omits runState and the renderer falls back to ACTIVE.
   */
  runState?: () => { state: "ACTIVE" | "PAUSED"; since?: string; reason?: string };
}

/**
 * Every resident lane Roll has ever installed. They appear ONLY when a plist is
 * still on disk, and then as leftovers to remove — never as something that will
 * fire (US-LOOP-118).
 *
 * `pr` is here because it must be (codex r1): the PR lane was retired earlier, by
 * US-DELIV-006, so a machine upgraded across both retirements can still hold a
 * `com.roll.pr.<slug>.plist`. Omitting it made that plist INVISIBLE — the one
 * leftover nothing else would ever mention.
 */
/** Freshness window for "a cycle is streaming" (mirrors collectLoopLiveFeed). */
const LIVE_FRESH_SEC = 300;

const RETIRED_LANES: Array<{ svc: string; name: string; mode: string }> = [
  { svc: "loop", name: "backlog loop (leftover lane)", mode: "backlog" },
  { svc: "pr", name: "PR loop (leftover lane)", mode: "pr" },
  { svc: "dream", name: "Dream loop (leftover lane)", mode: "dream" },
];

/**
 * The loop runtime dir for a project.
 *
 * codex r12: `ROLL_PROJECT_RUNTIME_DIR` is the established override — run-once,
 * the live-feed collector, alerts and the scoped route all honour it. This module
 * hardcoded `<project>/.roll/loop`, so with an overridden runtime dir the UI could
 * show a live stream while the heartbeat reported no running session.
 */
function loopRuntimeDir(projectPath: string): string {
  return (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim() || join(projectPath, ".roll", "loop");
}

/**
 * @param nowSec The SHARED render clock (renderNowSec / the selector's nowSec).
 *   codex r13: freshness used `Date.now()`, so under `ROLL_RENDER_NOW` the live-feed
 *   panel and the heartbeat could judge the SAME live.log against different clocks
 *   and disagree — one showing a live stream, the other no session.
 */
export function defaultHeartbeatDeps(
  projectPath: string,
  slug: string,
  launchAgentsDir: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): HeartbeatDeps {
  const lastRunAt = (svc: string): string | null => {
    // codex r6: the FILE and the FORMAT must be chosen together. `dream` reads a
    // bracketed text log; everything else reads JSONL rows with a `ts` field.
    // Keying the format on `svc === "loop"` while keying the file on
    // `svc === "dream"` left `pr` reading runs.jsonl through the dream regex, so a
    // real PR leftover could never keep its lastAt.
    const dreamLog = svc === "dream";
    const path = join(loopRuntimeDir(projectPath), dreamLog ? "dream.log" : "runs.jsonl");
    try {
      const lines = readFileSync(path, "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] ?? "";
        if (line.trim() === "") continue;
        if (dreamLog) {
          const m = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{4})\]/.exec(line);
          if (m?.[1] !== undefined && m[2] !== undefined) {
            const tz = `${m[2].slice(0, 3)}:${m[2].slice(3)}`;
            return new Date(`${m[1]}${tz}`).toISOString().replace(/\.\d{3}Z$/, "Z");
          }
        } else {
          const row = JSON.parse(line) as { ts?: string };
          if (typeof row.ts === "string" && row.ts !== "") return row.ts;
        }
      }
    } catch {
      /* no lane run yet */
    }
    return null;
  };
  return {
    laneLeftover: (svc) => {
      try {
        return existsSync(join(launchAgentsDir, `com.roll.${svc}.${slug}.plist`));
      } catch {
        return false;
      }
    },
    lastRunAt,
    goalText: () => {
      try {
        return readFileSync(join(loopRuntimeDir(projectPath), "goal.yaml"), "utf8");
      } catch {
        return null;
      }
    },
    eventsText: () => {
      try {
        return readFileSync(join(loopRuntimeDir(projectPath), "events.ndjson"), "utf8");
      } catch {
        return null;
      }
    },
    liveStream: () => {
      // Same rule and window collectLoopLiveFeed applies: live.log is never
      // deleted, so only a RECENT write means a cycle is streaming.
      try {
        const st = statSync(join(loopRuntimeDir(projectPath), "live.log"));
        const at = new Date(st.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
        const fresh = nowSec - Math.floor(st.mtimeMs / 1000) <= LIVE_FRESH_SEC;
        return fresh ? { running: true, at } : { running: false };
      } catch {
        return { running: false };
      }
    },
    // US-LOOP-115: two states (ACTIVE / PAUSED) resolved from the PAUSE marker.
    runState: () => ({ state: resolveLoopRunState(projectPath, slug) }),
  };
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
  const live = deps.liveStream?.() ?? { running: false };
  // codex r11: a streaming cycle counts even with no goal at all (`run-once`
  // writes none), so the lane exists whenever ANY of the three signals is present.
  if (text === null && !session.open && !live.running) return undefined;
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
  // A live stream is proof of running on its own; when it is streaming, the last
  // activity is its OWN write time, so `running` and `lastAt` agree (codex r10).
  const running = live.running || (session.open && status === "active");
  const lastAt = live.running ? live.at : session.lastAt;
  return {
    name: "go session",
    source: "goal",
    running,
    mode: "go",
    status,
    scope,
    ...(lastAt !== undefined ? { lastAt } : {}),
  };
}

/**
 * Collect the heartbeat lanes.
 *
 * US-LOOP-118: a lane appears only when there is something real to say about it —
 * a leftover plist, or a go session. The old contract listed both retired lanes
 * unconditionally so the console could print "0/2 lanes armed", which invited the
 * reading that two lanes were missing and ought to be installed.
 */
export function collectLoopHeartbeat(deps: HeartbeatDeps): TruthSnapshotLoop {
  const lanes: TruthSnapshotLoopLane[] = [];
  // US-LOOP-118: a retired lane is listed only if its plist is still on disk, and
  // then as debris. `running: false` unconditionally — a plist drives nothing — and
  // never a `nextAt`, because no fire is coming. `lastAt` stays: it is a real
  // timestamp of work that really happened.
  for (const { svc, name, mode } of RETIRED_LANES) {
    if (!deps.laneLeftover(svc)) continue;
    const last = deps.lastRunAt(svc);
    const lane: TruthSnapshotLoopLane = {
      name,
      source: "launchd",
      running: false,
      mode,
      status: LEFTOVER_LANE_STATUS,
    };
    if (last !== null) lane.lastAt = last;
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
