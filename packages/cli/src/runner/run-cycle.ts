/**
 * runCycleOnce — the driver that walks the pure {@link cycleStep} state machine
 * to a terminal state, executing each emitted {@link CycleCommand} through the
 * {@link Ports} bundle and feeding the result back. This is the executable heart
 * of the runner adapter (prerequisite for US-LOOP-006 v2-vs-v3 verification).
 *
 * Honours (the card's hard list):
 *   - LOCK acquire/release (infra/process). Acquire the inner lock before the
 *     walk; release UNCONDITIONALLY on every exit path (try/finally).
 *   - HEARTBEAT cadence: written at cycle start and refreshed on each step while
 *     executing, so a monitor reading the heartbeat file sees liveness during a
 *     long agent run.
 *   - WATCHDOG timeout: the elapsed-time breach is checked before each step via
 *     the pure {@link watchdogVerdict}; a breach injects a synthetic timed-out
 *     `agent_exited` so the orchestrator runs its clean teardown path
 *     (timeoutTeardownCommands) — terminal event + lock release included.
 *   - TERMINAL event UNCONDITIONAL (I8): the orchestrator's terminate() always
 *     emits cycle:end + a runs row; the driver additionally guarantees, in a
 *     finally block, that if NO terminal command was observed (e.g. an exception
 *     mid-walk), a fallback `aborted` cycle:end + runs row are still written —
 *     so a terminal event exists on EVERY exit path, and the next runCycleOnce
 *     takes over cleanly (I2).
 *   - events/runs bookkeeping: ensureEventFiles up front; cycle:start/:end +
 *     runs upsert flow through the executor's emit_event / append_run commands.
 */
import {
  type CycleCommand,
  type CycleContext,
  type CycleEvent,
  type CycleState,
  type V2CycleStatus,
  cycleEndEvent,
  cycleStep,
  foldCycleAdversarial,
  initialCycleState,
  mapV2Status,
  releaseStoryLease,
  watchdogVerdict,
} from "@roll/core";
import { CYCLE_TIMEOUT_SEC } from "@roll/core";
import { AGENT_CAPACITY_LEASE_SCHEMA } from "@roll/spec";
import { dirname } from "node:path";
import { type Ports, type ProcessClock, executeCommand, buildRunRow, revertPrematureDone } from "./executor.js";
import { readCycleAttributionFromEvents } from "../lib/cycle-attribution.js";
import { classifyCycleFailure, readCycleEvents } from "./failure-attribution.js";
import { killLiveAgents } from "./agent-spawn.js";
import {
  restorePersistedWorkspaceCycleContext,
  restorePersistedWorkspaceCycleRepositorySelector,
} from "./scoped-route.js";
import { resolveStoryLeasePath } from "./story-lease-path.js";

/** Inputs for one cycle run. */
export interface RunCycleOptions {
  ports: Ports;
  /** The cycle context (cycleId/branch/loop). agent/model/storyId filled by walk. */
  ctx: CycleContext;
  /** Hard cycle timeout in seconds (watchdog). Defaults to v2 {@link CYCLE_TIMEOUT_SEC}. */
  timeoutSec?: number;
  /** Inner lock staleness; defaults to infra INNER_LOCK_STALE_SEC via acquireLock. */
  lockStaleSec?: number;
  /** Max steps before bailing (loop-safety; a terminal is normally reached fast). */
  maxSteps?: number;
  /** Test seam for fail-loud capacity ownership loss; production kills live agent trees. */
  killAgents?: () => number;
}

/** What a finished cycle reports back. */
export interface RunCycleResult {
  /** The terminal v2 status the cycle landed on (undefined ⇒ never reached one). */
  terminal: V2CycleStatus | undefined;
  /** True iff we acquired the lock and ran the walk (false ⇒ another cycle held it). */
  ran: boolean;
  /** When `ran` is false, the live owner's pid. */
  heldByPid?: number;
  /** The final orchestrator state (for assertions / dashboards). */
  state?: CycleState;
}

/**
 * Drive ONE cycle to terminal. Acquires the inner lock; on contention returns
 * `{ ran: false }` (mirrors v2's skip-when-held, bin/roll:8412-8425). Otherwise
 * walks the state machine, executing each command and feeding the result back,
 * with the watchdog + heartbeat woven in, and releases the lock + guarantees a
 * terminal event in `finally`.
 */
export async function runCycleOnce(opts: RunCycleOptions): Promise<RunCycleResult> {
  const { ports } = opts;
  let ctx = opts.ctx;
  if (
    ctx.repositorySelector === undefined &&
    ctx.workspaceExecution?.issue !== undefined
  ) {
    const restoredRepository = restorePersistedWorkspaceCycleRepositorySelector(
      dirname(ports.paths.eventsPath),
      ctx.cycleId,
      ctx.workspaceExecution,
    );
    if (restoredRepository.ok) {
      ctx = { ...ctx, repositorySelector: restoredRepository.repoId };
    }
  }
  const timeoutSec = opts.timeoutSec ?? CYCLE_TIMEOUT_SEC;
  const maxSteps = opts.maxSteps ?? 1000;
  const killAgents = opts.killAgents ?? ((): number => killLiveAgents("SIGKILL"));

  // Lock: single-flight re-entry guard. Skip if another live cycle holds it.
  const acq = ports.process.acquireLock(ports.paths.lockPath, { staleSec: opts.lockStaleSec, cycleId: ctx.cycleId });
  if (!acq.acquired) {
    return { ran: false, terminal: undefined, heldByPid: acq.heldByPid };
  }

  // Files + first heartbeat up front (FIX-157 self-heal + liveness).
  ports.events.ensureEventFiles(ports.paths.eventsPath, ports.paths.runsPath);
  ports.process.writeHeartbeat(ports.paths.heartbeatPath);

  const startSec = ports.clock();
  let state: CycleState = initialCycleState(ctx);
  let lockReleased = false;
  let terminalEmitted = false;
  let liveCapacity: import("@roll/spec").AgentCapacityLease | undefined;
  // Stamp the cycle start onto the live context so the attest gate (FIX-207) in
  // capture_facts can tell a report written THIS cycle from a stale one.
  let liveCtx: CycleContext = { ...ctx, startSec };

  /** Mark whether the orchestrator already wrote the terminal event for I8. */
  const noteTerminal = (cmds: CycleCommand[]): void => {
    if (cmds.some((c) => c.kind === "emit_event" && c.event.type === "cycle:end")) {
      terminalEmitted = true;
    }
    if (cmds.some((c) => c.kind === "release_lock")) lockReleased = true;
  };

  try {
    // Kick the machine: `start` → preflight.
    let pending: CycleEvent | undefined = { type: "start", ctx };
    let steps = 0;

    while (pending !== undefined && steps < maxSteps) {
      steps += 1;

      // Watchdog: before stepping, if we're executing and the budget is breached,
      // inject a timed-out agent_exited so the orchestrator runs clean teardown.
      if (state.phase === "execute" && !state.done) {
        const elapsed = ports.clock() - startSec;
        const verdict = watchdogVerdict(elapsed, timeoutSec);
        if (verdict.breached) {
          pending = { type: "agent_exited", exit: 143, timedOut: true };
        }
      }

      const { state: next, commands } = cycleStep(state, pending);
      state = next;
      liveCtx = mergeCtx(liveCtx, next.ctx);
      noteTerminal(commands);
      if (commands.some((c) => c.kind === "emit_event" && c.event.type === "cycle:end")) {
        liveCtx = attachFailureAttribution(liveCtx, state.terminal, ports);
        // US-LOOP-104: fold this cycle's adversarial:* events into the runs-row
        // summary at terminal (the events are already written). A standard cycle
        // folds to null → the row omits the field (no behaviour change).
        liveCtx = attachAdversarialRun(liveCtx, ports);
      }

      // Refresh heartbeat each step (liveness during a long execute phase).
      ports.process.writeHeartbeat(ports.paths.heartbeatPath);

      // Execute the commands in order; the LAST feedback event (if any) becomes
      // the next `pending`. Commands are 1:1 with infra calls (executeCommand).
      let nextEvent: CycleEvent | undefined;
      for (const cmd of commands) {
        if ((cmd.kind === "spawn_agent" || cmd.kind === "spawn_role") && liveCapacity !== undefined) {
          const heartbeat = ports.capacity.heartbeat(
            liveCapacity.owner.leaseId,
            liveCapacity.owner.ownerToken,
          );
          if (heartbeat.kind === "ownership_lost") {
            throw new Error(`agent_capacity_ownership_lost:${heartbeat.reason}`);
          }
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "workspace:capacity_heartbeat",
            workspaceId: liveCapacity.owner.workspaceId,
            storyId: liveCapacity.owner.storyId,
            cycleId: liveCapacity.owner.cycleId,
            spawnId: liveCapacity.owner.spawnId,
            agent: liveCapacity.key.agent,
            model: liveCapacity.key.model,
            ts: ports.clock() * 1_000,
          });
        }
        let ownershipLostReason: string | undefined;
        const stopUnleasedExecution = (reason: string): void => {
          if (ownershipLostReason !== undefined) return;
          ownershipLostReason = reason;
          try {
            ports.events.appendAlert(
              ports.paths.alertsPath,
              `cycle ${liveCtx.cycleId}: agent capacity ownership lost (${reason}); killed live agent process`,
            );
          } catch {
            /* the thrown ownership-loss terminal remains authoritative */
          }
          killAgents();
        };
        const heartbeatTimer = (cmd.kind === "spawn_agent" || cmd.kind === "spawn_role") && liveCapacity !== undefined
          ? setInterval(() => {
              if (liveCapacity === undefined || ownershipLostReason !== undefined) return;
              try {
                const heartbeat = ports.capacity.heartbeat(
                  liveCapacity.owner.leaseId,
                  liveCapacity.owner.ownerToken,
                );
                if (heartbeat.kind === "ownership_lost") {
                  stopUnleasedExecution(heartbeat.reason);
                  return;
                }
                ports.events.appendEvent(ports.paths.eventsPath, {
                  type: "workspace:capacity_heartbeat",
                  workspaceId: liveCapacity.owner.workspaceId,
                  storyId: liveCapacity.owner.storyId,
                  cycleId: liveCapacity.owner.cycleId,
                  spawnId: liveCapacity.owner.spawnId,
                  agent: liveCapacity.key.agent,
                  model: liveCapacity.key.model,
                  ts: ports.clock() * 1_000,
                });
              } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                stopUnleasedExecution(`heartbeat_error:${reason}`);
              }
            }, ports.capacity.heartbeatIntervalMs)
          : undefined;
        let res;
        try {
          res = await executeCommand(cmd, ports, liveCtx);
        } finally {
          if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
        }
        if (ownershipLostReason !== undefined) {
          throw new Error(`agent_capacity_ownership_lost:${ownershipLostReason}`);
        }
        if (res.lockReleased === true) lockReleased = true;
        if (res.event !== undefined) {
          nextEvent = res.event;
          if (res.event.type === "capacity_acquired") liveCapacity = res.event.lease;
        }
        if (res.capacityReleased === true) liveCapacity = undefined;
        // FIX-208: fold executor-captured truth (real tcr count, parsed cost)
        // into the live context so the later append_run / cycle:end commands —
        // which read liveCtx — carry it. The orchestrator never owns these (it
        // is pure), so this is the only place they merge.
        if (res.ctxPatch !== undefined) liveCtx = { ...liveCtx, ...res.ctxPatch };
      }

      // Terminal? stop the walk once a status is stamped and no feedback remains.
      if (state.done && nextEvent === undefined) {
        pending = undefined;
      } else {
        pending = nextEvent;
      }
    }
  } finally {
    if (liveCapacity !== undefined) {
      const released = ports.capacity.release(
        liveCapacity.owner.leaseId,
        liveCapacity.owner.ownerToken,
      );
      if (released.kind === "ownership_lost") {
        try {
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `cycle ${liveCtx.cycleId}: residual agent capacity ownership lost (${released.reason})`,
          );
        } catch {
          /* terminal fallback below remains best-effort */
        }
      }
      liveCapacity = undefined;
    }
    // I8: a terminal cycle:end + runs row MUST exist on every exit path. If the
    // walk threw / bailed before the orchestrator emitted one, write a fallback
    // `aborted` terminal directly (idempotent — the bus upsert dedupes the row).
    if (!terminalEmitted) {
      const status: V2CycleStatus = "aborted";
      liveCtx = attachFailureAttribution(liveCtx, status, ports);
      liveCtx = attachAdversarialRun(liveCtx, ports); // US-LOOP-104: aborted adversarial cycles record their summary too
      // FIX-1060: if the live context was lost (e.g. exception before the
      // orchestrator propagated story/agent), recover the best-known attribution
      // from events the cycle already wrote.
      const attr = readCycleAttributionFromEvents(ports.paths.eventsPath, liveCtx.cycleId);
      const restored = liveCtx.workspaceExecution?.issue === undefined
        ? restorePersistedWorkspaceCycleContext(dirname(ports.paths.eventsPath), liveCtx.cycleId)
        : undefined;
      const workspaceExecution = restored?.ok ? restored.context : liveCtx.workspaceExecution;
      const storyId = liveCtx.storyId ?? workspaceExecution?.issue?.storyId ?? attr.storyId ?? "";
      const agent = liveCtx.agent ?? attr.agent ?? "";
      const tctx = {
        cycleId: liveCtx.cycleId,
        branch: liveCtx.branch,
        agent,
        model: liveCtx.model ?? "",
        failureClass: liveCtx.failureClass,
        rootCauseKey: liveCtx.rootCauseKey,
      };
      try {
        const terminalSec = ports.clock();
        ports.events.appendEvent(
          ports.paths.eventsPath,
          { ...cycleEndEvent(tctx, status), ts: terminalSec * 1000 },
        );
        const fakeAppend: Extract<CycleCommand, { kind: "append_run" }> = {
          kind: "append_run",
          status,
          outcome: mapV2Status(status),
          cycleId: liveCtx.cycleId,
        };
        const rowCtx: CycleContext = {
          ...liveCtx,
          storyId,
          agent,
          ...(workspaceExecution === undefined ? {} : { workspaceExecution }),
        };
        const row = buildRunRow(fakeAppend, rowCtx, terminalSec);
        if (agent === "" && storyId !== "") {
          row["agent_unknown_reason"] = "aborted_before_agent_routed";
        }
        ports.events.upsertRun(
          ports.paths.runsPath,
          { storyId, cycleId: liveCtx.cycleId },
          row,
        );
        // FIX-304: this aborted fallback never reached the executor's append_run,
        // so undo a premature ✅ Done HERE too. An aborted cycle did NOT merge —
        // if the agent had already flipped the claimed story Done in the
        // symlinked .roll backlog (FIX-204C), the false-Done would otherwise
        // persist (the next preflight reconcile only inspects 🔨 claims). Revert
        // it to the pre-cycle status so done ≡ merged holds on every exit path.
        if (storyId !== "") {
          revertPrematureDone(ports, storyId, liveCtx.preCycleStatus);
        }
      } catch {
        /* best-effort terminal write; never mask the original failure */
      }
      if (storyId !== "") {
        try {
          releaseStoryLease(resolveStoryLeasePath(ports.paths), storyId, { source: "cycle", pid: process.pid });
        } catch {
          /* lease cleanup must never mask the original cycle failure */
        }
      }
      if (state.done) state = { ...state, terminal: status };
    }

    // Lock release UNCONDITIONAL (mirrors the EXIT trap, bin/roll:8770). The
    // orchestrator's timeout/terminal paths may already have released it; this
    // is the belt-and-braces final release (idempotent rm -f).
    if (!lockReleased) ports.process.releaseLock(ports.paths.lockPath);
  }

  // FIX-1244: hand the caller the FULL truth — executor-captured facts (real
  // tcr count, parsed cost, prUrl) live in liveCtx, orchestrator-owned fields
  // (agentExitCode) live in state.ctx. mergeCtx keeps the overlapping fields
  // (storyId/agent/model/…) synced into liveCtx each step, so liveCtx wins on
  // shared keys and state.ctx contributes what only the orchestrator knows.
  // Without this, loop-run-once's zero-TCR gate read an UNMEASURED tcrCount as
  // 0 and misjudged real work as zero-TCR (cycle-20260713-154751).
  return { ran: true, terminal: state.terminal, state: { ...state, ctx: { ...state.ctx, ...liveCtx } } };
}

/** US-LOOP-104: patch the adversarial-run summary onto the live ctx from the
 *  cycle's already-written adversarial:* events (null → standard cycle, no-op). */
function attachAdversarialRun(ctx: CycleContext, ports: Ports): CycleContext {
  const summary = foldCycleAdversarial(readCycleEvents(ports.paths.eventsPath, ctx.cycleId), ctx.cycleId);
  return summary === null ? ctx : { ...ctx, adversarialRun: summary };
}

function attachFailureAttribution(ctx: CycleContext, terminal: V2CycleStatus | undefined, ports: Ports): CycleContext {
  // REFACTOR-070: expand coverage to ALL failure-class terminals, not just the
  // original four. agent_internal must also carry failure_class/root_cause_key
  // into TerminalEvent + runs rows.
  if (
    terminal !== "failed" &&
    terminal !== "blocked" &&
    terminal !== "gave_up" &&
    terminal !== "aborted" &&
    terminal !== "agent_internal"
  ) {
    return ctx;
  }
  if (ctx.failureClass !== undefined && ctx.rootCauseKey !== undefined) return ctx;

  const attribution = classifyCycleFailure({
    cycleId: ctx.cycleId,
    terminal,
    tcrCount: ctx.tcrCount,
    tokensIn: ctx.cost?.tokensIn,
    tokensOut: ctx.cost?.tokensOut,
    agentExecuted: (ctx.agent ?? "") !== "",
    mainDirty: ctx.mainDirty,
    agentInternalFailure: ctx.agentInternalFailure !== undefined,
    agentTimedOut: ctx.agentTimedOut,
    events: readCycleEvents(ports.paths.eventsPath, ctx.cycleId),
  });
  return { ...ctx, failureClass: attribution.failureClass, rootCauseKey: attribution.rootCauseKey };
}

/** Merge orchestrator-updated ctx fields (agent/model/storyId) into the live ctx. */
function mergeCtx(live: CycleContext, next: CycleContext): CycleContext {
  return {
    ...live,
    storyId: next.storyId ?? live.storyId,
    agent: next.agent ?? live.agent,
    model: next.model ?? live.model,
    evidenceRunDir: next.evidenceRunDir ?? live.evidenceRunDir,
    failureClass: next.failureClass ?? live.failureClass,
    rootCauseKey: next.rootCauseKey ?? live.rootCauseKey,
    agentTimedOut: next.agentTimedOut ?? live.agentTimedOut,
    publishConfirmed: next.publishConfirmed ?? live.publishConfirmed,
    repositoryExecution: next.repositoryExecution ?? live.repositoryExecution,
    workspaceExecution: next.workspaceExecution ?? live.workspaceExecution,
    workspaceContextScope: next.workspaceContextScope ?? live.workspaceContextScope,
    workspaceContextOperationProvenance: next.workspaceContextOperationProvenance ?? live.workspaceContextOperationProvenance,
    repositorySelector: next.repositorySelector ?? live.repositorySelector,
  };
}

// ── Dry-run plan rendering (the parallel-verification protocol's preview) ─────

/**
 * Render the command PLAN the cycle WOULD execute, without running anything.
 * Drives the pure {@link cycleStep} with a SCRIPTED happy-path event sequence
 * (preflight→worktree→pick→route→execute(accept)→capture(built)→publish→
 * done), collecting every command. No ports, no I/O — purely the orchestrator's
 * command vocabulary, so `roll loop run-once --dry-run` shows the executor map.
 */
export function dryRunPlan(ctx: CycleContext): string[] {
  const scripted: CycleEvent[] = [
    { type: "start", ctx },
    { type: "preflight_done" },
    { type: "worktree_created" },
    { type: "story_picked", storyId: ctx.storyId ?? "US-EXAMPLE" },
    { type: "route_resolved", agent: ctx.agent ?? "claude", model: ctx.model ?? "" },
    { type: "agent_exited", exit: 0, timedOut: false },
    {
      type: "facts_captured",
      facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 1 },
    },
    { type: "published", result: { status: 0 } },
  ];
  const out: string[] = [];
  let state: CycleState = initialCycleState(ctx);
  for (const ev of scripted) {
    const { state: next, commands } = cycleStep(state, ev);
    state = next;
    for (const cmd of commands) out.push(describeCommand(cmd));
    if (commands.some((command) => command.kind === "acquire_capacity") && state.pendingSpawn !== undefined) {
      const pending = state.pendingSpawn;
      const acquired = cycleStep(state, {
        type: "capacity_acquired",
        spawnId: pending.spawnId,
        lease: {
          schema: AGENT_CAPACITY_LEASE_SCHEMA,
          key: pending.key,
          owner: {
            leaseId: `dry:${pending.spawnId}`,
            ownerToken: "dry-run",
            workspaceId: state.ctx.repositoryExecution?.workspaceId ?? "dry-run",
            storyId: state.ctx.storyId ?? "",
            cycleId: state.ctx.cycleId,
            spawnId: pending.spawnId,
            host: "dry-run",
            pid: 0,
            processStartedAtMs: 0,
          },
          acquiredAtMs: 0,
          heartbeatAtMs: 0,
        },
      });
      state = acquired.state;
      for (const cmd of acquired.commands) out.push(describeCommand(cmd));
    }
    if (state.done) break;
  }
  return out;
}

/** One-line human description of a command (command → executor mapping). */
function describeCommand(cmd: CycleCommand): string {
  switch (cmd.kind) {
    case "preflight":
      return "preflight            → recovery.preflightPlan + orphan heal";
    case "create_worktree":
      return `create_worktree      → git.worktreeAdd(${cmd.branch})`;
    case "pick_story":
      return "pick_story           → picker.pickStory(.roll/backlog.md)";
    case "resume_worktree":
      return `resume_worktree      → resolveResumeBase(${cmd.storyId}) + git.resetWorktreeHard`;
    case "resolve_route":
      return `resolve_route        → router.resolveRoute(${cmd.storyId})`;
    case "acquire_capacity":
      return `acquire_capacity     → machine broker (${cmd.pending.key.agent}/${cmd.pending.key.model})`;
    case "spawn_agent":
      return `spawn_agent          → agentSpawn(${cmd.agent}, attempt ${cmd.attempt})`;
    case "spawn_role":
      return `spawn_role           → agentSpawn(${cmd.agent} as ${cmd.role}, round ${cmd.round})`;
    case "release_capacity":
      return `release_capacity     → machine broker (${cmd.leaseId})`;
    case "kill_agent":
      return `kill_agent           → SIGKILL (grace ${cmd.graceSec}s)`;
    case "sleep_backoff":
      return `sleep_backoff        → sleep ${cmd.seconds}s`;
    case "capture_facts":
      return "capture_facts        → git rev-list --count origin/main..HEAD";
    case "measure_worktree":
      return "measure_worktree     → git.tcrCount(worktree) — FIX-1244 timeout teardown probe";
    case "publish_pr":
      return `publish_pr           → planPublishPr + github.runPublishPlan(${cmd.branch})`;
    case "merge_back":
      return `merge_back           → git.push(${cmd.branch}) ff fallback`;
    case "push_orphan":
      return `push_orphan          → git.push(${cmd.branch}) audit safety net`;
    case "rescue_leaked":
      return `rescue_leaked        → git.rescueLeaked(rescue/leaked-${cmd.cycleId})`;
    case "wait_merge":
      return `wait_merge           → github.prState(${cmd.branch}) poll`;
    case "reconcile":
      return "reconcile            → reconcile.reconcileMergeEvidence";
    case "cleanup_environment":
      return "cleanup_environment  → env.cleanupCycleArtifacts()";
    case "cleanup_worktree":
      return `cleanup_worktree     → git.worktreeRemove(${cmd.branch})`;
    case "emit_event":
      return `emit_event           → events.appendEvent(${cmd.event.type})`;
    case "append_run":
      return `append_run           → events.upsertRun(status=${cmd.status})`;
    case "append_alert":
      return `append_alert         → events.appendAlert`;
    case "release_lock":
      return "release_lock         → process.releaseLock";
    default: {
      const _x: never = cmd;
      return `unknown(${JSON.stringify(_x)})`;
    }
  }
}
