/**
 * US-CYCLE-001 — shared run-watchdog: git-state liveness for ANY subagent run,
 * observed on the run's OWN working directory (its worktree), not the main
 * checkout. FIX-1477 put "git state = progress" into the loop runner's
 * spawn-observer, but the goal/supervisor + subagent path bypassed it entirely;
 * a builder that works inside a cycle worktree while the watchdog observes the
 * (static) main checkout would look like "no progress" forever → systematic
 * mis-kill. This is the single implementation both paths reuse.
 *
 * Pure orchestration: all observation (`progressSignals`) and effects
 * (`onTimeout`, `kill`) are injected. The verdict is {@link cycleTimeoutVerdict}
 * — the same decision the loop already used — so behavior is unchanged, only the
 * home and the cwd-binding contract are new.
 */
import { cycleTimeoutVerdict } from "../loop/orchestrator.js";

/** A window the watchdog itself trips on. These flow through `onTimeout`. */
export type RunWindowReason = "wall" | "no-progress" | "no-state-change";
/** Every structured kill reason. `external` is recorded via `stop({external})`
 *  when the run was terminated by something OTHER than this watchdog — it never
 *  flows through `onTimeout`. */
export type RunKillReason = RunWindowReason | "external";

export interface RunWatchThresholds {
  /** Absolute wall-clock ceiling (seconds). <= 0 disables. */
  wallSec: number;
  /** True-silence window: seconds with no progress signal at all. <= 0 disables. */
  noProgressSec: number;
  /** No-git-state-change window: seconds with no new commit / dirty change. <= 0 disables. */
  noStateChangeSec: number;
}

/**
 * Progress signals. `watchRun` calls each with `opts.cwd` — the run's OWN
 * working directory — so the observed directory is chosen by the watchdog, NOT
 * baked into the closure. A caller therefore CANNOT silently observe the main
 * checkout: whatever `cwd` the watchdog is given is the directory the probe is
 * handed. This is the structural guarantee behind US-CYCLE-001's scorer focus.
 */
export interface RunProgressSignals {
  /** commits-ahead count on the branch checked out at `cwd`. A rise is progress. */
  commitCount: (cwd: string) => Promise<number>;
  /** dirty-state fingerprint of `cwd` (e.g. `git status --porcelain`). A CHANGE
   *  is progress. Omit to track commits only. A thrown probe is a blip — skipped,
   *  never progress, never a kill. */
  stateSignature?: (cwd: string) => Promise<string>;
}

export interface RunTimeoutInfo {
  reason: RunWindowReason;
  elapsedSec: number;
  idleSec: number;
  /** The run cwd the signals observed — for the record. */
  cwd: string;
}

export interface WatchRunOptions {
  /** The run's OWN working directory. The signals MUST observe THIS path. */
  cwd: string;
  /** Epoch SECONDS (injected clock). */
  clock: () => number;
  thresholds: RunWatchThresholds;
  progressSignals: RunProgressSignals;
  /** Called once when the watchdog trips, BEFORE the kill (so the trip is
   *  durable even if the kill races the process exiting). Best-effort. */
  onTimeout: (info: RunTimeoutInfo) => void;
  /** US-CYCLE-002 — called when a GIT-STATE bump (a new commit, or a worktree
   *  dirty-state signature change) renews the liveness clocks. `idleSec` is how
   *  long the run had been idle before this renewal. Fires ONLY on git-state
   *  progress (never on `markProgress`/stdout), so a caller can surface a legible
   *  "still working" signal without flooding on every output chunk. Best-effort;
   *  omit to ignore renewals. */
  onRenew?: (info: { signal: "commit" | "dirty"; idleSec: number }) => void;
  /** Kill the in-flight process tree; returns count signalled. */
  kill: () => number;
  /** Poll cadence (ms). */
  pollMs: number;
}

export interface RunWatchHandle {
  /** Reset ONLY the true-silence fuse (proof of liveness, not of work). */
  markProgress(): void;
  /** Stop the watchdog; returns why it fired (null = never tripped). Pass
   *  `{ external: true }` when the run was terminated by something OTHER than
   *  this watchdog (orchestrator abort, the process exiting on its own) so the
   *  structured reason is recorded as `"external"` rather than null. A window
   *  the watchdog already tripped on wins — external never overwrites it. */
  stop(opts?: { external?: boolean }): { firedReason: RunKillReason | null };
}

/**
 * Start a run-watchdog. Renews on progress, interrupts after the no-progress /
 * no-state-change / wall windows, and returns a structured kill reason. All
 * git-state observation happens on `opts.cwd` via the injected signals.
 */
export function watchRun(opts: WatchRunOptions): RunWatchHandle {
  const { cwd, clock, thresholds, progressSignals, onTimeout, onRenew, kill, pollMs } = opts;
  const { commitCount, stateSignature } = progressSignals;
  // All criteria disabled → an inert handle (no timer). It never trips a window,
  // but STILL records an external termination so accounting stays complete.
  if (thresholds.wallSec <= 0 && thresholds.noProgressSec <= 0 && thresholds.noStateChangeSec <= 0) {
    return {
      markProgress: () => {},
      stop: (o) => ({ firedReason: o?.external === true ? "external" : null }),
    };
  }
  const startSec = clock();
  let lastProgressSec = startSec;
  let lastStateSec = startSec;
  let lastCommitCount = -1;
  let lastSignature: string | undefined;
  let firedReason: RunKillReason | null = null;
  let running = false;

  const markProgress = (): void => {
    // stdout feeds ONLY the true-silence fuse — it is proof of liveness, not of
    // work; the git-state clock (lastStateSec) is untouched.
    lastProgressSec = clock();
  };

  const tick = async (): Promise<void> => {
    if (running || firedReason !== null) return; // don't stack ticks / re-fire
    running = true;
    try {
      // A NEW commit on the worktree branch is GIT-STATE progress — bumps BOTH clocks.
      // The probe is handed `cwd` (the run's worktree) — it cannot observe elsewhere.
      try {
        const n = await commitCount(cwd);
        if (n > lastCommitCount) {
          const now = clock();
          // A new commit past the seeded baseline is a genuine renewal (the
          // baseline seed sets lastCommitCount >= 0, so this fires only on real
          // forward progress). Surface it before bumping the clocks.
          if (lastCommitCount >= 0 && onRenew !== undefined) onRenew({ signal: "commit", idleSec: now - lastStateSec });
          lastCommitCount = n;
          lastProgressSec = now;
          lastStateSec = now;
        }
      } catch {
        /* a git-probe blip is NOT progress and NOT a reason to kill — skip */
      }
      // A dirty-state signature CHANGE is also git-state progress (bumps BOTH).
      // The first observation only establishes the baseline (never a bump).
      if (stateSignature !== undefined) {
        try {
          const sig = await stateSignature(cwd);
          if (lastSignature !== undefined && sig !== lastSignature) {
            const now = clock();
            if (onRenew !== undefined) onRenew({ signal: "dirty", idleSec: now - lastStateSec });
            lastProgressSec = now;
            lastStateSec = now;
          }
          lastSignature = sig;
        } catch {
          /* a signature-probe blip is NOT progress and NOT a kill — skip */
        }
      }
      const now = clock();
      const verdict = cycleTimeoutVerdict({
        elapsedSec: now - startSec,
        idleSec: now - lastProgressSec,
        stateIdleSec: now - lastStateSec,
        wallLimitSec: thresholds.wallSec,
        noProgressLimitSec: thresholds.noProgressSec,
        noStateChangeLimitSec: thresholds.noStateChangeSec,
      });
      if (verdict.timedOut && verdict.reason !== null) {
        firedReason = verdict.reason;
        clearInterval(timer);
        try {
          onTimeout({ reason: verdict.reason, elapsedSec: verdict.elapsedSec, idleSec: verdict.idleSec, cwd });
        } catch {
          /* onTimeout is best-effort; the kill below is the point */
        }
        try {
          kill();
        } catch {
          /* the spawn's exit handler still settles the promise */
        }
      }
    } finally {
      running = false;
    }
  };
  // Seed the baselines once up front so the first real change counts.
  void (async () => {
    try {
      lastCommitCount = await commitCount(cwd);
    } catch {
      /* baseline best-effort */
    }
    if (stateSignature !== undefined) {
      try {
        lastSignature = await stateSignature(cwd);
      } catch {
        /* baseline best-effort */
      }
    }
  })();
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();
  return {
    markProgress,
    stop: (o) => {
      clearInterval(timer);
      // An external termination is recorded ONLY if no window already tripped —
      // a real wall/stale kill is the truer reason and must not be overwritten.
      if (o?.external === true && firedReason === null) firedReason = "external";
      return { firedReason };
    },
  };
}
