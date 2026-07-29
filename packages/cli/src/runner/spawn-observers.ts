import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CYCLE_NO_PROGRESS_SEC,
  CYCLE_NO_STATE_CHANGE_SEC,
  CYCLE_STALL_THRESHOLD_SEC,
  CYCLE_WALL_TIMEOUT_SEC,
  STALL_STARTUP_GRACE_SEC,
  baselineCommits,
  maybeBuildHeartbeat,
  newCycleObserverState,
  newNormalizerState,
  normalizerFor,
  observeBuildStart,
  observeCommits,
  stallVerdict,
  type ActivitySignal,
  type AgentActivityNormalizer,
  type CycleContext,
  type CycleObserverState,
  type NormalizerState,
  type RunKillReason,
  watchRun,
} from "@roll/core";
import type { RollEvent } from "@roll/spec";
import { parseCaptureMarker, type CaptureMarker, type ScreenshotResult } from "@roll/infra";
import { killLiveAgents } from "./agent-spawn.js";
import type { CapturePort, Ports } from "./ports.js";
import { epochMs } from "./runner-time.js";
import { parsePolicy } from "@roll/core";
import {
  RepositoryObservationError,
  observeRepositoryRecentCommits,
  writableRepositoryIds,
} from "./repository-observation.js";

export class ActivitySignalRecorder {
  private buffered = "";
  private readonly normalizer: AgentActivityNormalizer;
  private readonly state: NormalizerState;

  constructor(
    private readonly signalPath: string,
    agent: string,
    banner: string,
    private readonly nowMs: () => number,
  ) {
    this.normalizer = normalizerFor(agent);
    this.state = newNormalizerState();
    try {
      mkdirSync(dirname(signalPath), { recursive: true });
      writeFileSync(signalPath, "", "utf8");
    } catch {
      /* best-effort projection */
    }
    this.recordLine(banner);
  }

  accept(chunk: Buffer): void {
    this.buffered += chunk.toString("utf8");
    const lines = this.buffered.split(/\r?\n/);
    this.buffered = lines.pop() ?? "";
    for (const line of lines) this.recordLine(line);
  }

  flush(): void {
    if (this.buffered.trim() !== "") this.recordLine(this.buffered);
    this.buffered = "";
  }

  private recordLine(line: string): void {
    const signals = this.normalizer.normalize(line, this.state, this.nowMs());
    if (signals.length === 0) return;
    this.append(signals);
  }

  private append(signals: readonly ActivitySignal[]): void {
    try {
      appendFileSync(this.signalPath, signals.map((sig) => JSON.stringify(sig)).join("\n") + "\n", "utf8");
    } catch {
      /* best-effort projection */
    }
  }
}

/** Default poll cadence for the runner's build-phase observation (ms). Frequent
 *  enough that a new TCR commit becomes an event within a few seconds; cheap (one
 *  `git log` per tick). Overridable via ROLL_OBSERVE_POLL_MS for tests. */
const OBSERVE_POLL_MS = 5_000;

/**
 * US-LOOP-076 — start the runner's agent-agnostic cycle observer for the build
 * phase. Emits the build-start phase marker immediately, then polls the worktree
 * git log on a timer, deriving standard {@link RollEvent}s (cycle:tcr per new
 * commit, a periodic build heartbeat) into events.ndjson. Returns a handle whose
 * `stop()` clears the timer AND takes one final await'd snapshot so the last
 * commits before agent exit are never dropped.
 *
 * All meaning lives in @roll/core's pure {@link observeCommits} /
 * {@link maybeBuildHeartbeat}; this is just the I/O loop (git read + event
 * append). Best-effort throughout: observation must NEVER fail the cycle.
 */
export async function startCycleObserver(
  ports: Ports,
  cycleId: string,
  // E4: the worktree the agent's commits actually land in. A submodule cycle
  // passes the submodule cycle worktree so the runner observes the RIGHT branch's
  // commits; omitted ⇒ ports.paths.worktreePath (the superproject worktree),
  // byte-identical to before.
  observeCwd: string = ports.paths.worktreePath,
  // E8: the integration-branch baseline the commits are counted ahead of. A
  // submodule cycle passes the submodule's integration branch (its worktree has
  // no origin/main, so the hardwired `origin/main..HEAD` fataled → the observer
  // saw zero commits and emitted no cycle:tcr events); omitted ⇒ origin/main,
  // byte-identical to before.
  baseRef?: string,
): Promise<{ stop(): Promise<void> }> {
  if (cycleId === "") return { stop: async () => {} };
  const st: CycleObserverState = newCycleObserverState(cycleId);
  const emit = (events: RollEvent[]): void => {
    for (const ev of events) {
      try {
        ports.events.appendEvent(ports.paths.eventsPath, ev);
      } catch {
        /* observation append is best-effort */
      }
    }
  };
  const pollGapMs = Number((process.env["ROLL_OBSERVE_POLL_MS"] ?? "").trim()) || OBSERVE_POLL_MS;
  try {
    baselineCommits(await ports.git.recentCommits(observeCwd, baseRef), st);
  } catch {
    /* baseline is best-effort; observation must not block the cycle */
  }
  emit(observeBuildStart(st, Date.now()));
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // a slow git read must not stack ticks
    running = true;
    try {
      const commits = await ports.git.recentCommits(observeCwd, baseRef);
      const now = Date.now();
      emit(observeCommits(commits, st, now));
      emit(maybeBuildHeartbeat(st, now));
    } catch {
      /* never let a probe blip topple the cycle */
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), pollGapMs);
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      // One final synchronous snapshot — captures the TCR commits that landed
      // between the last tick and the agent exiting.
      await tick();
    },
  };
}

/** Observe a Workspace cycle through repository-bound ports rather than treating
 * the Issue coordination root as a Git checkout. */
export async function startRepositoryCycleObserver(
  ports: Ports,
  ctx: CycleContext,
): Promise<{ stop(): Promise<void> }> {
  const cycleId = ctx.cycleId ?? "";
  if (cycleId === "") return { stop: async () => {} };
  const repositories = ports.repositories?.bind(ctx);
  if (repositories === undefined) throw new Error("missing_repository_ports");
  const repoIds = writableRepositoryIds(ctx);
  const states = new Map<string, CycleObserverState>();
  for (const repoId of repoIds) {
    const state = newCycleObserverState(cycleId);
    baselineCommits(await observeRepositoryRecentCommits(repoId, repositories), state);
    states.set(repoId, state);
  }

  const storyState = newCycleObserverState(cycleId);
  for (const event of observeBuildStart(storyState, Date.now())) {
    ports.events.appendEvent(ports.paths.eventsPath, event);
  }
  const reportedFailures = new Set<string>();
  const reportFailure = (error: unknown): void => {
    const failure = error instanceof RepositoryObservationError
      ? error
      : new RepositoryObservationError("unknown", "recent_commits", { cause: error });
    const key = `${failure.repoId}:${failure.operation}`;
    if (reportedFailures.has(key)) return;
    reportedFailures.add(key);
    try {
      repositories.events.append(failure.repoId, {
        type: "repository:observation_failed",
        operation: failure.operation,
        detail: failure.cause instanceof Error ? failure.cause.message : String(failure.cause ?? "unknown"),
        ts: Date.now(),
      });
    } catch {
      /* the global alert below remains the fail-loud projection */
    }
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `repository_observation_failed: ${failure.repoId}: ${failure.operation} (cycle ${cycleId})`,
    );
  };

  const pollGapMs = Number((process.env["ROLL_OBSERVE_POLL_MS"] ?? "").trim()) || OBSERVE_POLL_MS;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const nowMs = Date.now();
      for (const repoId of repoIds) {
        const state = states.get(repoId);
        if (state === undefined) throw new Error(`missing repository observer state: ${repoId}`);
        try {
          const commits = await observeRepositoryRecentCommits(repoId, repositories);
          for (const event of observeCommits(commits, state, nowMs)) {
            if (event.type !== "cycle:tcr" && event.type !== "cycle:first_edit") continue;
            repositories.events.append(repoId, event);
            if (event.type === "cycle:tcr") {
              const storyEvents = observeCommits([{
                hash: `${repoId}:${event.commitHash}`,
                message: event.message,
                tsSec: event.commitTs === undefined ? 0 : event.commitTs / 1_000,
              }], storyState, nowMs);
              for (const storyEvent of storyEvents) {
                if (storyEvent.type !== "cycle:first_edit") continue;
                ports.events.appendEvent(ports.paths.eventsPath, {
                  ...storyEvent,
                  commitHash: event.commitHash,
                });
              }
            }
          }
        } catch (error) {
          reportFailure(error);
        }
      }
      for (const event of maybeBuildHeartbeat(storyState, nowMs)) {
        ports.events.appendEvent(ports.paths.eventsPath, event);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), pollGapMs);
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      await tick();
    },
  };
}

// ── FIX-907: per-cycle HARD timeout watchdog (the hung-builder killer) ────────

/** Resolved per-cycle timeout thresholds (seconds). 0 / negative ⇒ DISABLED. */
export interface CycleTimeoutThresholds {
  wallSec: number;
  noProgressSec: number;
  /** FIX-1477 — the no-state-change window (no commit AND no dirty-state
   *  change ⇒ kill, even if stdout flows). */
  noStateChangeSec: number;
}

/** Poll cadence (ms) for the timeout watchdog. Frequent enough that a breach is
 *  acted on within a few seconds of crossing a threshold, cheap (one `git log`).
 *  Overridable via ROLL_TIMEOUT_POLL_MS for tests. */
const TIMEOUT_POLL_MS = 5_000;

/**
 * FIX-907 — resolve the per-cycle hard-timeout thresholds. Order:
 *   1. env override (ROLL_CYCLE_WALL_TIMEOUT_SEC / ROLL_CYCLE_NO_PROGRESS_SEC /
 *      ROLL_CYCLE_NO_STATE_CHANGE_SEC) — lets an operator (or a test) pin a
 *      value without editing policy.yaml;
 *   2. `<repoCwd>/.roll/policy.yaml` loop_safety.{cycle_wall_timeout_sec,
 *      cycle_no_progress_sec};
 *   3. the core defaults (45min wall / 15min no-progress / 25min no-state-change).
 * A 0 / negative value DISABLES that criterion. Best-effort: an unreadable /
 * unparseable policy degrades to defaults (the watchdog must never topple a cycle
 * by failing to read config).
 * FIX-1477: the no-state-change window deliberately has NO policy key (adding
 * one would require a loop_safety schema change) — env + core default only.
 */
export function readCycleTimeoutThresholds(repoCwd: string): CycleTimeoutThresholds {
  const envNum = (key: string): number | undefined => {
    const raw = (process.env[key] ?? "").trim();
    if (raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  let wallSec = CYCLE_WALL_TIMEOUT_SEC;
  let noProgressSec = CYCLE_NO_PROGRESS_SEC;
  try {
    const p = join(repoCwd, ".roll", "policy.yaml");
    if (existsSync(p)) {
      const ls = parsePolicy(readFileSync(p, "utf8")).loopSafety;
      wallSec = ls.cycleWallTimeoutSec;
      noProgressSec = ls.cycleNoProgressSec;
    }
  } catch {
    /* unreadable policy → core defaults */
  }
  return {
    wallSec: envNum("ROLL_CYCLE_WALL_TIMEOUT_SEC") ?? wallSec,
    noProgressSec: envNum("ROLL_CYCLE_NO_PROGRESS_SEC") ?? noProgressSec,
    noStateChangeSec: envNum("ROLL_CYCLE_NO_STATE_CHANGE_SEC") ?? CYCLE_NO_STATE_CHANGE_SEC,
  };
}

/** FIX-929 — resolved stall-detection threshold. */
export interface StallThresholdConfig {
  thresholdSec: number;
}

/**
 * FIX-929 — resolve the stall-detection threshold. Order:
 *   1. Env override (ROLL_LOOP_STALL_THRESHOLD_MIN) — operator/test can pin a
 *      value without editing policy.yaml;
 *   2. The core default ({@link CYCLE_STALL_THRESHOLD_SEC}, 600s = 10min).
 * 0 / negative ⇒ stall detection DISABLED.
 */
export function readStallThreshold(repoCwd: string): StallThresholdConfig {
  const envNum = (key: string): number | undefined => {
    const raw = (process.env[key] ?? "").trim();
    if (raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const thresholdSec = envNum("ROLL_LOOP_STALL_THRESHOLD_MIN");
  return { thresholdSec: thresholdSec ?? CYCLE_STALL_THRESHOLD_SEC };
}

/** A live timeout-watchdog handle. `markProgress()` resets the no-progress
 *  (true-silence) clock — and ONLY that clock (FIX-1477: stdout activity no
 *  longer counts as "working"); `stop()` clears the timer and returns whether
 *  the watchdog fired (so the caller can fold it into the spawn result's
 *  `timedOut`). */
export interface SpawnTimeoutWatchdog {
  markProgress(): void;
  stop(opts?: { external?: boolean }): { firedReason: RunKillReason | null };
}

/**
 * FIX-907 — start the per-cycle HARD-timeout watchdog around a blocking agent
 * spawn. The spawn is a single `await`, so the orchestrator's between-step
 * watchdog cannot fire while a builder hangs; this poller closes that hole.
 *
 * It wakes on a timer and asks the PURE {@link cycleTimeoutVerdict} whether the
 * cycle has breached any of THREE criteria:
 *   • WALL — `now - spawnStart >= wallSec`.
 *   • NO-PROGRESS (true silence) — `now - lastProgress >= noProgressSec`, where
 *     `lastProgress` is bumped by (a) a NEW commit observed on the worktree
 *     branch, (b) a worktree DIRTY-STATE signature change (FIX-1477), and
 *     (c) every stdout chunk (`markProgress`). Only a TRULY silent hang (no
 *     commit, no file change, no output) trips this fuse.
 *   • NO-STATE-CHANGE (FIX-1477) — `now - lastState >= noStateChangeSec`, where
 *     `lastState` is bumped ONLY by git state: a new commit OR a dirty-state
 *     signature change (`stateSignature` probe, e.g. `git status --porcelain`
 *     output). stdout does NOT reset this clock — a thrashing agent that keeps
 *     emitting tokens while producing zero git progress is killed here, ~20min
 *     ahead of the wall. The dirty-state half is what saves stdout-buffering
 *     agents (pi) that write files long before their first commit.
 *
 * On a breach it KILLS the agent process tree ({@link killLiveAgents} SIGKILL —
 * the same teardown FIX-204D uses, reaping the PTY-wrapped group), emits the
 * auditable `cycle:timeout` event (cycleId + reason + elapsed/idle), and records
 * the reason. The spawn's own `child.on("exit")` then resolves; the caller folds
 * `firedReason !== null` into `timedOut`, so the orchestrator runs its existing
 * clean teardown (`abort_timeout` → kill + cycle:end blocked + RELEASE LOCK; the
 * worktree branch is PRESERVED — timeoutTeardownCommands never cleans it).
 *
 * Best-effort throughout: a probe blip / append failure never crashes the
 * watchdog (a probe ERROR is neither progress nor a kill reason — the tick is
 * simply skipped). Injectable seams (`clock`, `commitCount`, `stateSignature`,
 * `appendEvent`, `kill`, `pollMs`) keep it unit-testable with NO real agent /
 * git / timer.
 */
export function startSpawnTimeoutWatchdog(opts: {
  cycleId: string;
  thresholds: CycleTimeoutThresholds;
  /** Epoch SECONDS (injected — the runner's ProcessClock). */
  clock: () => number;
  /** Observe commits-ahead on the branch at the observed cwd (progress signal).
   *  US-CYCLE-001: the watchdog HANDS this probe `observeCwd` — the run's
   *  worktree — so the observation point is chosen by the watchdog, never baked
   *  into the closure against the main checkout. */
  commitCount: (cwd: string) => Promise<number>;
  /** Surface commit-probe failures while preserving the shared watchdog's
   *  fail-soft behavior (the failed tick is still skipped). */
  onCommitProbeError?: (error: unknown) => void;
  /** FIX-1477 — fingerprint the DIRTY state of the observed cwd (e.g. raw
   *  `git status --porcelain` output); a CHANGE is progress. Optional: without
   *  it the state fuse tracks commits only. A thrown error is a blip — skipped,
   *  never progress, never a kill. Handed `observeCwd` like {@link commitCount}. */
  stateSignature?: (cwd: string) => Promise<string>;
  /** Append the cycle:timeout event (best-effort). */
  appendEvent: (ev: RollEvent) => void;
  /** Kill the in-flight agent process tree (returns count signalled). */
  kill?: () => number;
  /** Poll cadence ms (default {@link TIMEOUT_POLL_MS}; tests pin a small value). */
  pollMs?: number;
  /** US-CYCLE-001: the run's worktree cwd. LOAD-BEARING — the watchdog hands it
   *  to commitCount/stateSignature, so liveness is observed HERE, never on the
   *  main checkout. Defaults to "" (the process cwd) only for legacy callers. */
  observeCwd?: string;
}): SpawnTimeoutWatchdog {
  const { cycleId, thresholds, clock, commitCount, appendEvent } = opts;
  const stateSignature = opts.stateSignature;
  const kill = opts.kill ?? ((): number => killLiveAgents("SIGKILL"));
  const pollMs = opts.pollMs ?? (Number((process.env["ROLL_TIMEOUT_POLL_MS"] ?? "").trim()) || TIMEOUT_POLL_MS);
  // US-CYCLE-001: delegate to the shared @roll/core run-watchdog — ONE
  // implementation, observed on the run's worktree cwd. The loop runner binds
  // commitCount/stateSignature to the worktree (via ports); the goal/supervisor
  // + subagent path reuses the same watchRun with its own cwd-bound signals.
  const handle = watchRun({
    cwd: opts.observeCwd ?? "",
    clock,
    thresholds,
    progressSignals: {
      commitCount: async (cwd) => {
        try {
          return await commitCount(cwd);
        } catch (error) {
          opts.onCommitProbeError?.(error);
          throw error;
        }
      },
      ...(stateSignature !== undefined ? { stateSignature } : {}),
    },
    onTimeout: (info) => {
      // Record FIRST (durable), then kill — so the trip is observable even if
      // the kill races the process exiting on its own.
      appendEvent({
        type: "cycle:timeout",
        cycleId,
        reason: info.reason,
        elapsedSec: info.elapsedSec,
        idleSec: info.idleSec,
        ts: epochMs(clock()),
      });
    },
    kill,
    pollMs,
  });
  return { markProgress: handle.markProgress, stop: handle.stop };
}

/** FIX-929 — agent stall detector. Monitors agent output (stdout token stream)
 *  and emits a SOFT `agent:stall` signal when the agent has been completely
 *  silent for ≥ threshold seconds AFTER the startup grace period. Does NOT kill
 *  the agent — it signals the recovery layer (FIX-930) to switch agents before
 *  the hard timeout watchdog (FIX-907) kills the process.
 *
 *  Distinction from {@link startSpawnTimeoutWatchdog}:
 *    • Stall detector — SOFT signal at 10min (configurable); no kill; 2min grace.
 *    • Timeout watchdog — HARD kill at 15min no-progress (silence) / 25min
 *      no-state-change (FIX-1477) / 45min wall.
 */
export interface StallDetector {
  /** Bump the last-progress clock (called on every agent stdout chunk). */
  markProgress(): void;
  /** Stop the timer. Returns whether stall was detected. */
  stop(): { stalled: boolean };
}

/** FIX-929 — start the per-cycle stall detector. Emits `agent:stall` once when
 *  the agent is idle for ≥ the threshold after the startup grace. Best-effort;
 *  a probe blip never crashes the detector. Overridable via
 *  `ROLL_LOOP_STALL_THRESHOLD_MIN` env var. */
export function startStallDetector(opts: {
  cycleId: string;
  agent: string;
  /** Epoch SECONDS (injected — the runner's ProcessClock). */
  clock: () => number;
  /** Append the agent:stall event (best-effort). */
  appendEvent: (ev: RollEvent) => void;
  /** Stall threshold seconds (default {@link CYCLE_STALL_THRESHOLD_SEC}). */
  thresholdSec?: number;
  /** Startup grace seconds (default {@link STALL_STARTUP_GRACE_SEC}). */
  startupGraceSec?: number;
  /** Poll cadence ms (default 5s; tests pin a small value). */
  pollMs?: number;
}): StallDetector {
  const { cycleId, agent, clock, appendEvent } = opts;
  const thresholdSec = opts.thresholdSec ?? CYCLE_STALL_THRESHOLD_SEC;
  const startupGraceSec = opts.startupGraceSec ?? STALL_STARTUP_GRACE_SEC;
  const pollMs = opts.pollMs ?? (Number((process.env["ROLL_STALL_POLL_MS"] ?? "").trim()) || 5_000);
  // Disabled → inert handle (no timer, never fires).
  if (thresholdSec <= 0) {
    return { markProgress: () => {}, stop: () => ({ stalled: false }) };
  }
  const startSec = clock();
  let lastProgressSec = startSec;
  let fired = false;
  let running = false;

  const markProgress = (): void => {
    lastProgressSec = clock();
  };

  const tick = (): void => {
    if (running || fired) return;
    running = true;
    try {
      const now = clock();
      const verdict = stallVerdict({
        elapsedSec: now - startSec,
        idleSec: now - lastProgressSec,
        stallThresholdSec: thresholdSec,
        startupGraceSec,
        alreadyFired: fired,
      });
      if (verdict.stalled) {
        fired = true;
        clearInterval(timer);
        try {
          appendEvent({
            type: "agent:stall",
            cycleId,
            agent,
            idleSec: verdict.idleSec,
            thresholdSec: verdict.thresholdSec,
            ts: Date.now(),
          });
        } catch {
          /* event append is best-effort */
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  return {
    markProgress,
    stop: () => {
      clearInterval(timer);
      return { stalled: fired };
    },
  };
}

// ── FIX-1474: builder-child LIVENESS probe (the lost-child killer) ──────────

/** Default poll cadence (ms) for the builder-child liveness probe. Cheap (one
 *  `kill(pid, 0)` per tick). Overridable via ROLL_LIVENESS_POLL_MS for tests. */
const LIVENESS_POLL_MS = 5_000;

/** Consecutive DEAD observations required before a child is declared lost. One
 *  tick can race the OS reap/`close` handshake (a just-exited child can read
 *  as a zombie for a moment), so a single dead read is a blip, never a verdict. */
const LIVENESS_CONFIRM_TICKS = 2;

/** A live liveness-probe handle. `stop()` clears the timer and returns whether
 *  the probe declared the child lost (so the caller can fold it into the
 *  returned `agent_exited` event). */
export interface BuilderLivenessProbe {
  stop(): { lost: boolean };
}

/** Default liveness check: signal 0. ESRCH (no such process) ⇒ dead; EPERM
 *  means the process EXISTS but is owned by someone else ⇒ alive. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/**
 * FIX-1474 — start the bounded liveness probe around a blocking builder spawn.
 * The FIX-907 timeout watchdog covers a child that is ALIVE (hung / silent /
 * thrashing); it CANNOT see a child that DIED out-of-band while the spawn
 * await never settled (external SIGKILL of a process-tree member, PTY leader
 * death, lost exit delivery) — the exact shape that hung supervised cycles
 * forever with no terminal state.
 *
 * Each tick it reads the spawned child's pid (reported via the `onSpawn`
 * spawn seam; `undefined` until the spawn starts — nothing to accuse yet) and
 * asks the injected `isAlive`. After {@link LIVENESS_CONFIRM_TICKS} consecutive
 * dead observations it declares the child LOST:
 *   1. records the auditable `cycle:agent_lost` event FIRST (durable, so the
 *      death is observable even if the kill races),
 *   2. reaps the leftover process tree ({@link killLiveAgents} SIGKILL — a
 *      no-op when the tree is already gone),
 *   3. fires `onLost` so the caller can resolve its spawn race and converge
 *      the cycle to the explicit `aborted` terminal.
 *
 * The probe stands down the moment the spawn settles (`spawnPending()` false)
 * so a finished cycle is never accused. Best-effort throughout: a probe blip
 * (a throwing `isAlive`) reads as ALIVE — never a death verdict. Injectable
 * seams (`pid`, `spawnPending`, `isAlive`, `appendEvent`, `kill`, `onLost`,
 * `pollMs`, `confirmTicks`) keep it unit-testable with no real process/timer.
 */
export function startBuilderLivenessProbe(opts: {
  cycleId: string;
  agent: string;
  /** The spawned child's pid; `undefined` until the spawn reports it. */
  pid: () => number | undefined;
  /** True while the spawn await is unsettled; a settled spawn ⇒ inert probe. */
  spawnPending: () => boolean;
  /** Liveness check (default: `kill(pid, 0)`). A THROW is a blip ⇒ alive. */
  isAlive?: (pid: number) => boolean;
  /** Append the cycle:agent_lost event (best-effort). */
  appendEvent: (ev: RollEvent) => void;
  /** Reap the leftover agent process tree (returns count signalled). */
  kill?: () => number;
  /** Fired once when the child is declared lost (drives the spawn race). */
  onLost?: (info: { pid: number }) => void;
  /** Poll cadence ms (default {@link LIVENESS_POLL_MS}; tests pin a small value). */
  pollMs?: number;
  /** Consecutive dead observations before declaring lost (default
   *  {@link LIVENESS_CONFIRM_TICKS}). */
  confirmTicks?: number;
}): BuilderLivenessProbe {
  const { cycleId, agent, appendEvent } = opts;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const kill = opts.kill ?? ((): number => killLiveAgents("SIGKILL"));
  const pollMs = opts.pollMs ?? (Number((process.env["ROLL_LIVENESS_POLL_MS"] ?? "").trim()) || LIVENESS_POLL_MS);
  const confirmTicks = opts.confirmTicks ?? LIVENESS_CONFIRM_TICKS;
  let lost = false;
  let deadStreak = 0;

  const tick = (): void => {
    if (lost || !opts.spawnPending()) return;
    const pid = opts.pid();
    if (pid === undefined) {
      deadStreak = 0;
      return;
    }
    let alive = true;
    try {
      alive = isAlive(pid);
    } catch {
      /* a probe blip is NOT a death — skip */
    }
    if (alive) {
      deadStreak = 0;
      return;
    }
    deadStreak += 1;
    if (deadStreak < confirmTicks) return;
    lost = true;
    clearInterval(timer);
    // Record FIRST (durable), then reap + signal — the death must be
    // observable even if the kill races the cycle's own teardown.
    try {
      appendEvent({ type: "cycle:agent_lost", cycleId, agent, pid, ts: Date.now() });
    } catch {
      /* event append is best-effort */
    }
    try {
      kill();
    } catch {
      /* the tree may already be gone — the verdict stands */
    }
    try {
      opts.onLost?.({ pid });
    } catch {
      /* the caller's race resolve must never crash the probe */
    }
  };

  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      return { lost };
    },
  };
}

export function createCaptureMarkerSink(runDir: string, capture: CapturePort): { onChunk(chunk: Buffer): void; flush(): Promise<void> } {
  let buf = "";
  const pending: Promise<void>[] = [];
  const logPath = join(runDir, "evidence", "capture-markers.log");
  const record = (marker: CaptureMarker, result: ScreenshotResult): void => {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, JSON.stringify({ marker, result }) + "\n", "utf8");
    } catch {
      /* evidence logging is best-effort */
    }
  };
  const runMarker = (line: string): void => {
    const marker = parseCaptureMarker(line);
    if (marker === null) return;
    pending.push(
      capture
        .fromMarker(marker, runDir)
        .then((result) => record(marker, result))
        .catch((e: unknown) =>
          record(marker, {
            kind: marker.kind,
            out: join(runDir, "screenshots", `${marker.phase}-${marker.stem}.png`),
            taken: false,
            skipped: `capture errored: ${String(e)}`,
            failed: true,
            error: String(e),
          }),
        ),
    );
  };
  return {
    onChunk(chunk) {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) runMarker(line);
    },
    async flush() {
      if (buf.trim() !== "") runMarker(buf);
      buf = "";
      await Promise.allSettled(pending);
    },
  };
}
