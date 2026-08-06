/**
 * @responsibility Emits runner-observed cycle signal facts during the build phase.
 * US-LOOP-076 (folds in FIX-310) — the RUNNER-OBSERVED cycle signal source.
 *
 * THE BLACK-BOX KILLER. Before this, a cycle's build/TCR phase emitted ZERO
 * structured events: the runner blocked on `await agentSpawn(...)` for the whole
 * agent run (live evidence: a 37-minute cycle with only `cycle:start` then
 * `peer:gate` in events.ndjson) and the only "key node extraction" parsed
 * claude's stream-json — so codex / kimi / pi build phases were invisible. That
 * is a core-thesis violation: a feature must work on a STANDARD model + a thin
 * per-agent normalization layer, and EVERYTHING downstream must be agent-agnostic.
 *
 * The fix here is the agent-agnostic source of truth: the runner OBSERVES the
 * cycle (git commits on the worktree branch, the wall clock) and DERIVES standard
 * {@link RollEvent}s from that observation — it never parses the agent's stdout.
 * One path for EVERY agent. claude's stream-json is no longer privileged; it
 * becomes just one more (optional) normalization source feeding the SAME standard
 * signals the report timeline & `roll cycles --detail` already consume.
 *
 * This module is the pure heart: it takes periodic git snapshots and tracks which
 * commits it has already turned into signals, so a poller can call it on a timer
 * and only the NEW turning points become events. No clock, no FS, no git here —
 * the caller (the runner adapter) supplies the snapshot and the timestamp, so the
 * logic is deterministic and table-testable.
 */
import type { RollEvent } from "@roll/spec";

/** One commit the runner observed on the cycle branch (git log --format). */
export interface ObservedCommit {
  /** Full or abbreviated commit hash (stable identity across snapshots). */
  hash: string;
  /** Commit subject line. */
  message: string;
  /** Author/commit epoch SECONDS (git %ct). */
  tsSec: number;
}

/**
 * Mutable observer state for ONE cycle's build phase. `seen` is the set of commit
 * hashes already baselined or turned into a `cycle:tcr` event (so old work is not
 * claimed by the current cycle and a re-poll never double-emits); the heartbeat
 * fields throttle the periodic "still building" liveness beat.
 */
export interface CycleObserverState {
  cycleId: string;
  /** Hashes already baselined or emitted as cycle:tcr. */
  seen: Set<string>;
  /** Whether the build-phase enter signal (cycle:phase execute) was emitted. */
  phaseEmitted: boolean;
  /** Whether the first-edit marker (cycle:first_edit, the agent's first observed
   *  TCR commit) was emitted — latched so only the FIRST commit triggers it. */
  firstEditEmitted: boolean;
  /** Epoch ms of the last heartbeat we emitted (0 = none yet). */
  lastHeartbeatMs: number;
  /** Count of build heartbeats emitted so far (shown in the beat detail). */
  heartbeatCount: number;
}

/** Default gap between build-phase heartbeats (ms) — long enough not to spam
 *  events.ndjson, short enough that a 37-minute silent phase shows ~12 beats. */
export const BUILD_HEARTBEAT_GAP_MS = 180_000;

function secToMs(tsSec: number): number {
  return tsSec * 1000;
}

export function newCycleObserverState(cycleId: string): CycleObserverState {
  return {
    cycleId,
    seen: new Set<string>(),
    phaseEmitted: false,
    firstEditEmitted: false,
    lastHeartbeatMs: 0,
    heartbeatCount: 0,
  };
}

/**
 * Mark commits already present when observation starts. Those commits belong to
 * previous branch state, not to fresh work in this cycle.
 */
export function baselineCommits(commits: readonly ObservedCommit[], st: CycleObserverState): void {
  for (const c of commits) {
    if (c.hash !== "") st.seen.add(c.hash);
  }
}

/**
 * The build-phase enter marker — emitted ONCE before the agent runs so the
 * timeline shows where the (previously invisible) build phase began. Standard
 * `cycle:phase` (execute) so the existing transcript reducer renders it with no
 * new vocabulary. Pure.
 */
export function observeBuildStart(st: CycleObserverState, nowMs: number): RollEvent[] {
  if (st.phaseEmitted) return [];
  st.phaseEmitted = true;
  st.lastHeartbeatMs = nowMs;
  return [{ type: "cycle:phase", cycleId: st.cycleId, phase: "execute", ts: nowMs }];
}

/**
 * Fold ONE git snapshot into the NEW standard signals. For every observed commit
 * not yet seen, emit a `cycle:tcr` (the runner's OWN observation of a TCR commit
 * landing — derived from git, not from the agent's stream). The event timestamp
 * is the runner observation time so the timeline cannot time-travel before
 * `cycle:start`; the git timestamp is preserved as `commitTs` for audit.
 *
 * Snapshots are cheap and idempotent: re-passing the same commits returns []
 * because `seen` already holds their hashes. The caller passes commits in
 * chronological (oldest-first) order; we preserve that so events append in order.
 *
 * Pure given (commits, state, nowMs) — no I/O.
 */
export function observeCommits(
  commits: readonly ObservedCommit[],
  st: CycleObserverState,
  nowMs: number,
): RollEvent[] {
  const out: RollEvent[] = [];
  for (const c of commits) {
    if (c.hash === "" || st.seen.has(c.hash)) continue;
    st.seen.add(c.hash);
    const commitTs = c.tsSec > 0 ? secToMs(c.tsSec) : undefined;
    // FIX-357: the FIRST observed TCR commit is the earliest signal the agent
    // produced a tracked change — emit cycle:first_edit ONCE (latched), ordered
    // BEFORE its cycle:tcr. ts is epoch milliseconds, matching cycle:phase and
    // every other events.ndjson timestamp so execute→first_edit math stays
    // unit-safe (FIX-352). This makes the cold-orientation prefix that
    // prebuild_dist/project_map target measurable; it was buried in the 180s beat.
    if (!st.firstEditEmitted) {
      st.firstEditEmitted = true;
      out.push({ type: "cycle:first_edit", cycleId: st.cycleId, commitHash: c.hash, ts: nowMs });
    }
    out.push({
      type: "cycle:tcr",
      cycleId: st.cycleId,
      commitHash: c.hash,
      message: c.message,
      ts: nowMs,
      ...(commitTs !== undefined ? { commitTs } : {}),
    });
    // A commit IS activity — reset the heartbeat baseline so we don't beat right
    // after one lands (the commit is itself the liveness signal).
    st.lastHeartbeatMs = nowMs;
  }
  return out;
}

/**
 * Emit a build-phase liveness heartbeat when the agent has been quiet (no new
 * commit) for longer than `gapMs`. Rendered as a `cycle:stdout` carrying a
 * machine-tagged "still building" line so NO new event type is needed and the
 * existing renderers can fold it. This is the "never looks frozen" guarantee for
 * the durable event stream (the watch window has its own live heartbeat; this is
 * the one that lands in events.ndjson so reports & web see liveness too).
 *
 * Pure given (state, nowMs, gapMs). Returns [] until the gap is exceeded.
 */
export function maybeBuildHeartbeat(
  st: CycleObserverState,
  nowMs: number,
  gapMs: number = BUILD_HEARTBEAT_GAP_MS,
): RollEvent[] {
  const base = st.lastHeartbeatMs > 0 ? st.lastHeartbeatMs : nowMs;
  if (nowMs - base < gapMs) return [];
  st.lastHeartbeatMs = nowMs;
  st.heartbeatCount += 1;
  const elapsedMin = Math.round((nowMs - base) / 60_000);
  return [
    {
      type: "cycle:stdout",
      cycleId: st.cycleId,
      data: `heartbeat: building · still working (${st.heartbeatCount}) · ${elapsedMin}m quiet · ${st.seen.size} tcr so far`,
      ts: nowMs,
    },
  ];
}
