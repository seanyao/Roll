/**
 * US-CYCLE-001 — the shared run-watchdog. FIX-1477 taught the loop runner that
 * "git state = progress", but it did so INSIDE the loop's spawn-observer; the
 * goal/supervisor + subagent path had no such liveness and observed the (static)
 * MAIN checkout, so a builder working inside its own worktree looked frozen and
 * got mis-killed. `watchRun` is the single implementation both paths reuse, and
 * its contract is that ALL git-state observation happens through the injected
 * signals bound to the run's OWN cwd (its worktree) — never the main checkout.
 *
 * These tests pin exactly that worktree-BLINDNESS: identical wall time, opposite
 * outcomes depending only on which directory the signals observe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchRun, type RunTimeoutInfo, type WatchRunOptions } from "../src/watch/run-watchdog.js";

const POLL_MS = 10;

/** A controllable rig: an injected epoch-seconds clock the test advances in
 *  lockstep with fake timers, plus recorded onTimeout/kill effects. */
function rig(over: Partial<WatchRunOptions> & { commitCount: (cwd: string) => Promise<number> }) {
  let nowSec = 0;
  const timeouts: RunTimeoutInfo[] = [];
  const order: string[] = [];
  let kills = 0;
  const opts: WatchRunOptions = {
    cwd: "/wt/run",
    clock: () => nowSec,
    thresholds: { wallSec: 100, noProgressSec: 30, noStateChangeSec: 30 },
    progressSignals: { commitCount: over.commitCount },
    onTimeout: (info) => {
      order.push("onTimeout");
      timeouts.push(info);
    },
    kill: () => {
      order.push("kill");
      kills += 1;
      return 1;
    },
    pollMs: POLL_MS,
    ...over,
  };
  const handle = watchRun(opts);
  // One poll tick at the given elapsed second. The clock is read fresh inside
  // each tick, so setting nowSec first makes the tick perceive that elapsed.
  const tickAt = async (sec: number): Promise<void> => {
    nowSec = sec;
    await vi.advanceTimersByTimeAsync(POLL_MS);
  };
  return { handle, tickAt, get timeouts() { return timeouts; }, get kills() { return kills; }, order };
}

describe("watchRun — shared run-watchdog (US-CYCLE-001)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands the run's cwd to EVERY probe — the observation point is the worktree, never the main checkout", async () => {
    // The scorer focus: liveness MUST be observed on the run's cwd. Prove the
    // watchdog itself supplies that cwd to the probes (so a caller cannot
    // silently bind them to the static main checkout).
    const seenCommit: string[] = [];
    const seenState: string[] = [];
    const r = rig({
      cwd: "/wt/run-42",
      commitCount: (cwd) => {
        seenCommit.push(cwd);
        return Promise.resolve(0);
      },
      progressSignals: {
        commitCount: (cwd) => {
          seenCommit.push(cwd);
          return Promise.resolve(0);
        },
        stateSignature: (cwd) => {
          seenState.push(cwd);
          return Promise.resolve("x");
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0); // seed
    await r.tickAt(5);
    r.handle.stop();
    expect(seenCommit.length).toBeGreaterThan(0);
    expect(seenState.length).toBeGreaterThan(0);
    expect(new Set(seenCommit)).toEqual(new Set(["/wt/run-42"]));
    expect(new Set(seenState)).toEqual(new Set(["/wt/run-42"]));
  });

  it("worktree-blind: progress observed in the run cwd (static main) is NEVER killed, past every window", async () => {
    // The probe returns RISING commits only when handed the worktree cwd; if it
    // were pointed at the (static) main checkout it would return 0 forever. The
    // watchdog hands it the worktree cwd → productive run must never trip.
    let commits = 0;
    const worktreeAwareCommitCount = (cwd: string): Promise<number> => {
      commits += 1;
      return Promise.resolve(cwd === "/wt/run" ? commits : 0); // main = frozen
    };
    const r = rig({ cwd: "/wt/run", commitCount: worktreeAwareCommitCount });
    await vi.advanceTimersByTimeAsync(0); // flush baseline seed
    for (let sec = 10; sec <= 90; sec += 10) await r.tickAt(sec);
    expect(r.timeouts).toHaveLength(0);
    expect(r.kills).toBe(0);
    expect(r.handle.stop().firedReason).toBeNull();
  });

  it("worktree-blind reverse: the SAME probe pointed at a static main checkout IS killed on schedule", async () => {
    // Identical probe, but cwd is the main checkout → it returns 0 forever →
    // the run correctly looks frozen and is killed. This is the failure the card
    // exists to prevent when the wiring is wrong: same code, wrong cwd = mis-kill.
    let commits = 0;
    const worktreeAwareCommitCount = (cwd: string): Promise<number> => {
      commits += 1;
      return Promise.resolve(cwd === "/wt/run" ? commits : 0);
    };
    const r = rig({
      cwd: "/main/checkout", // WRONG observation point
      commitCount: worktreeAwareCommitCount,
      thresholds: { wallSec: 1000, noProgressSec: 1000, noStateChangeSec: 30 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await r.tickAt(20);
    expect(r.timeouts).toHaveLength(0);
    await r.tickAt(31);
    expect(r.timeouts[0]?.reason).toBe("no-state-change");
    expect(r.kills).toBe(1);
  });

  it("reverse: a static run cwd (no commit, no dirty change) trips no-state-change and kills", async () => {
    // Same wall time as above, but the observed cwd never changes → mis-kill is
    // now the CORRECT kill: the run really is doing nothing.
    const r = rig({
      commitCount: () => Promise.resolve(3), // constant → no progress
      thresholds: { wallSec: 1000, noProgressSec: 1000, noStateChangeSec: 30 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await r.tickAt(20); // within window
    expect(r.timeouts).toHaveLength(0);
    await r.tickAt(31); // past no-state-change window
    expect(r.timeouts).toHaveLength(1);
    expect(r.timeouts[0]?.reason).toBe("no-state-change");
    expect(r.timeouts[0]?.cwd).toBe("/wt/run");
    expect(r.kills).toBe(1);
  });

  it("dirty-state change in the worktree renews the state clock (files written before any commit)", async () => {
    // pi-style: writes files (dirty signature changes) long before it commits.
    let sig = "a";
    const r = rig({
      commitCount: () => Promise.resolve(0),
      progressSignals: {
        commitCount: () => Promise.resolve(0),
        stateSignature: () => Promise.resolve(sig),
      },
      thresholds: { wallSec: 1000, noProgressSec: 1000, noStateChangeSec: 30 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await r.tickAt(20);
    sig = "b"; // wrote a file
    await r.tickAt(25); // renews state clock
    await r.tickAt(50); // 25s since renewal < 30 → still alive
    expect(r.timeouts).toHaveLength(0);
    await r.tickAt(60); // 35s since renewal → trip
    expect(r.timeouts[0]?.reason).toBe("no-state-change");
  });

  it("wall-clock cap fires even while the run keeps making progress", async () => {
    let commits = 0;
    const r = rig({
      commitCount: () => Promise.resolve(commits),
      thresholds: { wallSec: 50, noProgressSec: 1000, noStateChangeSec: 1000 },
    });
    await vi.advanceTimersByTimeAsync(0);
    commits = 1;
    await r.tickAt(40);
    expect(r.timeouts).toHaveLength(0);
    commits = 2;
    await r.tickAt(51); // past wall despite fresh commit
    expect(r.timeouts[0]?.reason).toBe("wall");
    expect(r.kills).toBe(1);
  });

  it("markProgress renews ONLY the silence fuse, not the git-state fuse (thrashing agent)", async () => {
    // An agent that streams tokens (markProgress) but produces zero git state is
    // still killed by no-state-change — stdout is liveness, not work.
    const r = rig({
      commitCount: () => Promise.resolve(0),
      thresholds: { wallSec: 1000, noProgressSec: 30, noStateChangeSec: 30 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await r.tickAt(20);
    r.handle.markProgress(); // stdout chunk — resets silence fuse only
    await r.tickAt(45); // silence fuse renewed, but state clock hit 45 > 30
    expect(r.timeouts).toHaveLength(1);
    expect(r.timeouts[0]?.reason).toBe("no-state-change");
  });

  it("records onTimeout BEFORE kill so the trip is durable even if the kill races exit", async () => {
    const r = rig({
      commitCount: () => Promise.resolve(0),
      thresholds: { wallSec: 40, noProgressSec: 1000, noStateChangeSec: 1000 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await r.tickAt(41);
    expect(r.order).toEqual(["onTimeout", "kill"]);
  });

  it("does not re-fire or double-kill after the first trip", async () => {
    const r = rig({
      commitCount: () => Promise.resolve(0),
      thresholds: { wallSec: 40, noProgressSec: 1000, noStateChangeSec: 1000 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await r.tickAt(41);
    await r.tickAt(60);
    await r.tickAt(90);
    expect(r.timeouts).toHaveLength(1);
    expect(r.kills).toBe(1);
    expect(r.handle.stop().firedReason).toBe("wall");
  });

  it("a probe blip (thrown signal) is neither progress nor a kill — the tick is skipped", async () => {
    let calls = 0;
    const r = rig({
      commitCount: () => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("git blip"));
        return Promise.resolve(0);
      },
      thresholds: { wallSec: 1000, noProgressSec: 1000, noStateChangeSec: 30 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await r.tickAt(10); // throws inside — must not crash, must not renew
    await r.tickAt(35); // past no-state-change → still trips normally
    expect(r.timeouts[0]?.reason).toBe("no-state-change");
  });

  it("all thresholds <= 0 → an inert handle that never fires", async () => {
    const r = rig({
      commitCount: () => Promise.resolve(0),
      thresholds: { wallSec: 0, noProgressSec: 0, noStateChangeSec: 0 },
    });
    await r.tickAt(10_000);
    expect(r.timeouts).toHaveLength(0);
    expect(r.kills).toBe(0);
    expect(r.handle.stop().firedReason).toBeNull();
  });

  it("stop({external:true}) records the structured 'external' reason when no window tripped", async () => {
    // The run was killed by something OTHER than the watchdog (orchestrator
    // abort / the process exiting) — the taxonomy captures it, not null.
    const r = rig({ commitCount: () => Promise.resolve(0) });
    await vi.advanceTimersByTimeAsync(0);
    await r.tickAt(5); // still alive
    expect(r.handle.stop({ external: true }).firedReason).toBe("external");
    // The watchdog itself never issued a kill for an external termination.
    expect(r.kills).toBe(0);
  });

  it("external never overwrites a real window trip — the truer reason wins", async () => {
    const r = rig({
      commitCount: () => Promise.resolve(0),
      thresholds: { wallSec: 40, noProgressSec: 1000, noStateChangeSec: 1000 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await r.tickAt(41); // wall trip
    expect(r.handle.stop({ external: true }).firedReason).toBe("wall");
  });

  it("inert handle still records an external termination", async () => {
    const r = rig({
      commitCount: () => Promise.resolve(0),
      thresholds: { wallSec: 0, noProgressSec: 0, noStateChangeSec: 0 },
    });
    expect(r.handle.stop({ external: true }).firedReason).toBe("external");
  });
});
