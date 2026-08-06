/**
 * @responsibility Drives the pure cycle state machine to a terminal state.
 */
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
  EventBus,
  classifyCaptured,
  classifyPublish,
  cycleEndEvent,
  cycleStep,
  foldCycleAdversarial,
  handoffReadyKey,
  initialCycleState,
  isCycleHandoffEvent,
  mapV2Status,
  projectCycleHandoff,
  projectHandoffCapacity,
  watchdogVerdict,
} from "@roll/core";
import { CYCLE_TIMEOUT_SEC } from "@roll/core";
import { type HandoffIdentity, type RollEvent } from "@roll/spec";
import { acquireLock, releaseLock } from "@roll/infra";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { type Ports, type ProcessClock, executeCommand, buildRunRow, revertPrematureDone } from "./executor.js";
import { readCycleAttributionFromEvents } from "../lib/cycle-attribution.js";
import { classifyCycleFailure, readCycleEvents } from "./failure-attribution.js";
import { eventTs } from "./runner-time.js";

/**
 * US-CYCLE-013 — the project-wide scheduler mutex (`.roll/loop/handoff.lock`,
 * distinct from the per-run `inner.lock`). The critical section: read +
 * validate the event projection, choose the FIFO queue head, append EXACTLY ONE
 * decision event (admitted / builder_handoff / queued) with an fsync, then
 * unlock. The append is the linearization point; if the lock cannot be acquired
 * (and the staleness proof does not clear it), emit NO decision and report
 * `admission_unknown` (fail closed). Mirrors INNER_LOCK_STALE_SEC.
 */
export const HANDOFF_LOCK_STALE_SEC = 14_400;

export function handoffLockPath(eventsPath: string): string {
  return join(dirname(eventsPath), "handoff.lock");
}

/** US-CYCLE-013 feature flag (default off ⇒ the serial runner is byte-identical). */
export function handoffEnabled(): boolean {
  return process.env["ROLL_CYCLE_HANDOFF_V1"] === "1";
}

/**
 * Run `fn` inside the scheduler mutex. Returns `ok: false` (with the holder
 * pid) when the lock is held and the staleness proof does not clear it — the
 * caller then emits NO decision (admission_unknown, fail closed).
 */
export function withHandoffMutex<T>(
  lockPath: string,
  fn: () => T,
): { ok: true; value: T } | { ok: false; heldByPid: number | undefined } {
  const acq = acquireLock(lockPath, process.pid, { staleSec: HANDOFF_LOCK_STALE_SEC });
  if (!acq.acquired) return { ok: false, heldByPid: acq.heldByPid };
  try {
    return { ok: true, value: fn() };
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Append one scheduler decision event (admitted / builder_ready / builder_handoff
 * / queued) with an explicit fsync under the mutex. Uses the injected
 * `ports.events.appendEventSynced` when present (test doubles), else the real
 * node EventBus (fsync via the node store). The append is the linearization
 * point — a crash after it replays the event prefix and cannot admit a second
 * Builder. When `assignQueueSequence` is set (admitted/queued), the monotonic
 * FIFO sequence is computed INSIDE the critical section (no TOCTOU).
 *
 * US-CYCLE-013 F1 — execution-enforced admission: the capacity preconditions
 * hold INSIDE the critical section (read-check-append is one mutex hold, so
 * there is no TOCTOU between the projection read and the append):
 *   - `cycle:admitted` is REFUSED (`build_slot_full`) while a build holder
 *     (building or ready) occupies the one build slot;
 *   - `cycle:builder_handoff` is REFUSED (`tail_occupied`) while the unique
 *     tail is occupied.
 * All other cycle-handoff/v1 events keep their current behavior — `builder_ready`
 * is always allowed (it retains the build slot by design). A stale/broken mutex
 * keeps the `admission_unknown` fail-closed path (no decision event).
 */
export function appendHandoffDecisionSynced(
  ports: Ports,
  event: RollEvent,
  opts: { assignQueueSequence?: boolean } = {},
): { written: boolean; refused?: "build_slot_full" | "tail_occupied"; heldByPid?: number } {
  const lockPath = handoffLockPath(ports.paths.eventsPath);
  const outcome = withHandoffMutex(lockPath, () => {
    // F1-1: the capacity precondition is checked under the same mutex hold as
    // the append — the mutex is the linearization point for admission.
    if (event.type === "cycle:admitted") {
      if (projectHandoffCapacity(readEvents(ports)).buildHolderCycleId !== undefined) {
        return { written: false, refused: "build_slot_full" as const };
      }
    }
    if (event.type === "cycle:builder_handoff") {
      if (projectHandoffCapacity(readEvents(ports)).tailCycleId !== undefined) {
        return { written: false, refused: "tail_occupied" as const };
      }
    }
    let withId = isCycleHandoffEvent(event) && event.eventId === "" ? { ...event, eventId: randomUUID() } : event;
    if (opts.assignQueueSequence === true && (withId.type === "cycle:admitted" || withId.type === "cycle:queued" || withId.type === "cycle:queue_rejected")) {
      withId = { ...withId, queueSequence: nextQueueSequence(ports) };
    }
    const stamped = { ...withId, ts: eventTs(ports) };
    if (ports.events.appendEventSynced !== undefined) {
      ports.events.appendEventSynced(ports.paths.eventsPath, stamped);
    } else {
      new EventBus().appendEventSynced(ports.paths.eventsPath, stamped);
    }
    return { written: true };
  });
  if (!outcome.ok) return { written: false, heldByPid: outcome.heldByPid };
  return outcome.value;
}

/** Read the durable event stream (via the injected port when present). */
function readEvents(ports: Ports): RollEvent[] {
  if (ports.events.readHandoffEvents !== undefined) return ports.events.readHandoffEvents(ports.paths.eventsPath);
  return new EventBus().readEvents(ports.paths.eventsPath);
}

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
  /**
   * US-CYCLE-013 — enable the durable build handoff (ROLL_CYCLE_HANDOFF_V1=1):
   * a `built` capture appends `cycle:admitted`/`cycle:builder_ready` under the
   * scheduler mutex and stops the walk at a non-terminal handoff instead of
   * running the publish tail inline. Off (default) ⇒ the serial runner is
   * byte-identical.
   */
  handoff?: boolean;
}

/** The durable latest-main check verdict fed to the resumed tail. */
export interface FreshnessCheckResult {
  verdict: "continue" | "conflict" | "test_failed" | "unknown" | "timeout";
  predecessorMergeSha: string;
  recordedBaseSha: string;
  builderHead: string;
  evidenceRefs?: readonly string[];
  /** US-CYCLE-013 F2 — on `continue`, the TRUE rebased head (the durable pin
   *  `refs/roll/rebase-candidates/<cycle>/<attempt>` points at it). The failure
   *  verdicts leave it unset (pass through unchanged). */
  candidateHead?: string;
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
  /** US-CYCLE-013 — the Builder stopped at a durable handoff (no terminal
   *  written, lock released, workspace + lease retained). */
  handedOff?: boolean;
  /** US-CYCLE-013 — a resumed tail ran to a terminal. */
  resumedTail?: boolean;
  /** US-CYCLE-013 — the walk stopped at a durable non-terminal
   *  `cycle:serial_recovery` (leases retained; explicit recovery required). */
  recoveryRecorded?: boolean;
  /** US-CYCLE-013 — the resume entry refused (no live handoff for the cycle). */
  refused?: string;
  /** US-CYCLE-013 F1 — the Builder stopped WITHOUT a durable admission (the
   *  walk never spawned): the scheduler refused `build_slot_full` (a build
   *  holder already occupies the slot) or the mutex was held (`admission_unknown`).
   *  The finally wrote the aborted terminal + runs row and released the lock. */
  admissionBlocked?: string;
}

/**
 * Drive ONE cycle to terminal. Acquires the inner lock; on contention returns
 * `{ ran: false }` (mirrors v2's skip-when-held, bin/roll:8412-8425). Otherwise
 * walks the state machine, executing each command and feeding the result back,
 * with the watchdog + heartbeat woven in, and releases the lock + guarantees a
 * terminal event in `finally`.
 */
export async function runCycleOnce(opts: RunCycleOptions): Promise<RunCycleResult> {
  const { ports, ctx } = opts;
  const timeoutSec = opts.timeoutSec ?? CYCLE_TIMEOUT_SEC;
  const maxSteps = opts.maxSteps ?? 1000;

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
  // Stamp the cycle start onto the live context so the attest gate (FIX-207) in
  // capture_facts can tell a report written THIS cycle from a stale one.
  let liveCtx: CycleContext = { ...ctx, startSec };

  // US-CYCLE-013 — durable build handoff state for this run.
  const handoffOn = opts.handoff === true;
  let admittedIdentity: HandoffIdentity | undefined;
  let handedOff = false;
  let recoveryRecorded = false;
  // US-CYCLE-013 F1 — durable admission is a hard precondition for the Builder:
  // when the scheduler refuses (or the mutex is held), the walk stops here and
  // the finally writes the aborted terminal — a Builder NEVER spawns without a
  // durable `cycle:admitted` on the event stream.
  let admissionBlocked: string | undefined;

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

    while (pending !== undefined && steps < maxSteps && admissionBlocked === undefined) {
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

      // US-CYCLE-013 — enrich a `built` capture with the durable handoff data so
      // the orchestrator stops at a non-terminal builder_ready instead of the
      // inline publish ladder. The identity reuses the admitted workspace/fence.
      if (handoffOn && pending.type === "facts_captured" && classifyCaptured(pending.facts) === "built") {
        const identity = await buildHandoffIdentity(ports, state, liveCtx, admittedIdentity);
        if (identity !== null) {
          const tailFree = projectHandoffCapacity(readEvents(ports)).tailCycleId === undefined;
          pending = { ...pending, handoff: { identity, readyKey: handoffReadyKey(identity), tailFree } };
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
      // US-CYCLE-013: handoff-family emit commands are scheduler decision
      // appends — fsynced under the mutex (never a plain append).
      let nextEvent: CycleEvent | undefined;
      let readyWritten = false;
      for (const cmd of commands) {
        let res: Awaited<ReturnType<typeof executeCommand>>;
        if (handoffOn && cmd.kind === "emit_event" && isCycleHandoffEvent(cmd.event)) {
          const written = appendHandoffDecisionSynced(ports, cmd.event);
          if (cmd.event.type === "cycle:builder_ready") {
            if (!written.written) {
              ports.events.appendAlert(
                ports.paths.alertsPath,
                `cycle ${state.ctx.cycleId}: builder_ready append FAILED (scheduler mutex held by pid ${written.heldByPid ?? "?"}) — admission_unknown; fail closed, no duplicate Builder`,
              );
            } else {
              readyWritten = true;
            }
          }
          res = {};
        } else {
          res = await executeCommand(cmd, ports, liveCtx);
        }
        if (res.lockReleased === true) lockReleased = true;
        if (res.event !== undefined) nextEvent = res.event;
        // FIX-208: fold executor-captured truth (real tcr count, parsed cost)
        // into the live context so the later append_run / cycle:end commands —
        // which read liveCtx — carry it. The orchestrator never owns these (it
        // is pure), so this is the only place they merge.
        if (res.ctxPatch !== undefined) liveCtx = { ...liveCtx, ...res.ctxPatch };
      }

      // US-CYCLE-013 — admission: once the worktree is durably allocated and the
      // story is known, append the fenced `cycle:admitted` under the mutex
      // BEFORE the builder spawns. A crash before spawn replays to `building`
      // and invokes recovery; it cannot admit another Builder.
      // US-CYCLE-013 F1 — execution-enforced: when the under-mutex precondition
      // refuses (`build_slot_full`) or the mutex is held (`admission_unknown`),
      // the walk STOPS — a Builder never spawns without a durable admission.
      // The finally then writes the aborted terminal + runs row and releases the
      // lock; the allocated worktree is cleaned by the standard abort path.
      if (
        handoffOn &&
        !state.done &&
        admissionBlocked === undefined &&
        admittedIdentity === undefined &&
        state.worktreeReady === true &&
        state.ctx.storyId !== undefined &&
        state.ctx.storyId !== ""
      ) {
        const identity = await buildHandoffIdentity(ports, state, liveCtx, undefined);
        if (identity !== null) {
          const written = appendHandoffDecisionSynced(ports, {
            type: "cycle:admitted",
            eventId: "",
            idempotencyKey: `admit:${identity.cycleId}:${identity.attempt}`,
            identity,
            queueSequence: 0,
            ts: 0,
          } as never, { assignQueueSequence: true });
          if (written.written) {
            admittedIdentity = identity;
          } else {
            admissionBlocked = written.refused ?? "admission_unknown";
            pending = undefined;
            ports.events.appendAlert(
              ports.paths.alertsPath,
              written.refused !== undefined
                ? `cycle ${state.ctx.cycleId}: admission refused (${written.refused}) — build slot occupied; no parallel build started`
                : `cycle ${state.ctx.cycleId}: admission append FAILED (scheduler mutex held by pid ${written.heldByPid ?? "?"}) — admission_unknown; fail closed`,
            );
          }
        }
      }

      // US-CYCLE-013 — a durable ready append is confirmed by feeding
      // `handoff_recorded`; both it and a durable serial_recovery STOP the walk
      // WITHOUT a terminal event (leases retained). If the ready append FAILED
      // (mutex held), there is NO durable handoff record — fail closed: the walk
      // stops without handedOff so the finally writes the aborted terminal and
      // the slot is released for recovery (never a phantom handoff).
      if (state.handedOff === true && readyWritten) {
        handedOff = true;
        pending = undefined;
      } else if (state.recoveryRecorded === true) {
        recoveryRecorded = true;
        pending = undefined;
      } else if (state.done && nextEvent === undefined) {
        pending = undefined;
      } else {
        if (readyWritten) nextEvent = { type: "handoff_recorded" };
        pending = nextEvent;
      }
    }
  } finally {
    // I8: a terminal cycle:end + runs row MUST exist on every exit path. If the
    // walk threw / bailed before the orchestrator emitted one, write a fallback
    // `aborted` terminal directly (idempotent — the bus upsert dedupes the row).
    // US-CYCLE-013: a durable handoff (builder_ready) or serial_recovery is a
    // NON-terminal record — never overwrite it with an `aborted` cycle:end.
    if (!terminalEmitted && !handedOff && !recoveryRecorded) {
      const status: V2CycleStatus = "aborted";
      liveCtx = attachFailureAttribution(liveCtx, status, ports);
      liveCtx = attachAdversarialRun(liveCtx, ports); // US-LOOP-104: aborted adversarial cycles record their summary too
      // FIX-1060: if the live context was lost (e.g. exception before the
      // orchestrator propagated story/agent), recover the best-known attribution
      // from events the cycle already wrote.
      const attr = readCycleAttributionFromEvents(ports.paths.eventsPath, liveCtx.cycleId);
      const storyId = liveCtx.storyId ?? attr.storyId ?? "";
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
        const rowCtx: CycleContext = { ...liveCtx, storyId, agent };
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
  return {
    ran: true,
    terminal: state.terminal,
    ...(admissionBlocked !== undefined ? { admissionBlocked } : {}),
    ...(handedOff ? { handedOff: true } : {}),
    ...(recoveryRecorded ? { recoveryRecorded: true } : {}),
    state: { ...state, ctx: { ...state.ctx, ...liveCtx } },
  };
}

// ── US-CYCLE-013 — durable handoff helpers ───────────────────────────────────

/** The next monotonic FIFO queue sequence (max existing + 1, 1 when empty). */
function nextQueueSequence(ports: Ports): number {
  let max = 0;
  for (const ev of readEvents(ports)) {
    if ((ev.type === "cycle:queued" || ev.type === "cycle:queue_rejected") && ev.queueSequence > max) {
      max = ev.queueSequence;
    }
    if (ev.type === "cycle:admitted" && ev.queueSequence > max) {
      max = ev.queueSequence;
    }
  }
  return max + 1;
}

/**
 * Build the HandoffIdentity for this cycle from the durable record: the
 * workspace/base come from the cycle's `worktree:allocated` fact, the fence from
 * the admitted identity (fresh at admission). `builderHead` is the verified
 * committed head (managedWorktreeInspect) when available, else the allocation
 * base — the projection's conflict checks only trigger on duplicate
 * non-identical ready/handoff facts, so an unverifiable head stays safe.
 */
async function buildHandoffIdentity(
  ports: Ports,
  state: CycleState,
  liveCtx: CycleContext,
  prior: HandoffIdentity | undefined,
): Promise<HandoffIdentity | null> {
  const cycleId = state.ctx.cycleId;
  const storyId = state.ctx.storyId ?? liveCtx.storyId ?? "";
  if (cycleId === "" || storyId === "") return null;
  const allocated = [...readEvents(ports)].reverse().find(
    (ev): ev is Extract<RollEvent, { type: "worktree:allocated" }> =>
      ev.type === "worktree:allocated" && (ev.workspace.runId === cycleId || ev.workspace.storyId === storyId),
  );
  if (allocated === undefined) return null;
  const primary = allocated.workspace.members[0];
  const workspace = allocated.workspace;
  const fence = prior?.fence ?? randomUUID();
  const attempt = prior?.attempt ?? 1;
  // At READY time (prior present) the builderHead is the REAL committed head the
  // Builder TCR-verified — read it from the retained worktree so the resumed
  // tail can verify HEAD(W) == builderHead(B). At ADMISSION time (no prior) it
  // is the allocation base (the head is unknown until the Builder commits).
  let builderHead = prior?.builderHead ?? primary.checkoutRef.head;
  if (prior !== undefined) {
    const inspect = ports.git.managedWorktreeInspect;
    if (inspect !== undefined) {
      try {
        const observed = await inspect(ports.repoCwd, ports.paths.worktreePath);
        if (observed !== undefined && observed.head !== "" && observed.head !== builderHead) builderHead = observed.head;
      } catch {
        /* keep the prior head — verification is best-effort at READY time */
      }
    }
  }
  return {
    schema: "cycle-handoff/v1",
    cycleId,
    storyId,
    workspace,
    branch: state.ctx.branch,
    builderHead,
    baseSha: primary.checkoutRef.head,
    builderEvidenceRefs: [],
    builderValidationRef: `builder-validation:${cycleId}:${attempt}`,
    profile: state.ctx.selectedProfile ?? "standard",
    attempt,
    fence,
  };
}

/** Inputs for one resumed-tail run (US-CYCLE-013). */
export interface RunTailOnceOptions {
  ports: Ports;
  /** The cycle context (cycleId/branch/loop). */
  ctx: CycleContext;
  /** The durable handoff identity (from the projection) to resume. */
  identity: HandoffIdentity;
  /** Hard cycle timeout in seconds (watchdog). */
  timeoutSec?: number;
  /** Inner lock staleness; defaults to infra INNER_LOCK_STALE_SEC. */
  lockStaleSec?: number;
  /** Max steps before bailing. */
  maxSteps?: number;
  /**
   * Optional executable latest-main check: return a verdict when a durable
   * predecessor merge (merge SHA known) is recorded; `undefined` ⇒ no check
   * needed. `continue` pins a rebased attempt; the failure verdicts cancel the
   * tail — either way the tail routes to serial_recovery with leases retained.
   */
  checkFreshness?: (identity: HandoffIdentity) => Promise<FreshnessCheckResult | undefined>;
}

/**
 * US-CYCLE-013 — resume ONE retained tail to its terminal. Replays the handoff
 * projection, promotes the ready holder when it is still waiting for capacity,
 * re-verifies the recorded workspace identity via managedWorktreeInspect
 * BEFORE `cycle:tail_started`, then walks the orchestrator's tail mode:
 * `tail_started → evaluation/test (publish gates) → tail_completed → publish →
 * merge-wait → cleanup`. Any mismatch / freshness failure routes to a durable
 * non-terminal `cycle:serial_recovery` with story + workspace retained.
 */
export async function runTailOnce(opts: RunTailOnceOptions): Promise<RunCycleResult> {
  const { ports, ctx } = opts;
  const timeoutSec = opts.timeoutSec ?? CYCLE_TIMEOUT_SEC;
  const maxSteps = opts.maxSteps ?? 1000;
  const identity = opts.identity;

  // 1. Replay the projection — the resume is driven by the event-backed record,
  // NEVER inferred from a directory name or branch.
  const events = readEvents(ports);
  let view = projectCycleHandoff(events, identity.cycleId);
  if (view === undefined || view.identity === undefined) {
    return { ran: false, terminal: undefined, refused: "no_handoff_record" };
  }
  if (view.state === "builder_validated_waiting_for_tail") {
    // 2. Promote the ready holder under the mutex before any queue admission.
    // F1-5: refuse BEFORE the promotion append when the unique tail is already
    // occupied — the under-mutex precondition in appendHandoffDecisionSynced
    // covers the append itself; this pre-check gives the caller a clean refusal
    // (no ALERT) instead of an under-mutex rejection.
    if (projectHandoffCapacity(readEvents(ports)).tailCycleId !== undefined) {
      return { ran: false, terminal: undefined, refused: "tail_occupied" };
    }
    const promotion = appendHandoffDecisionSynced(ports, {
      type: "cycle:builder_handoff",
      eventId: "",
      idempotencyKey: `handoff:${identity.storyId}:${identity.attempt}:${identity.fence}`,
      identity: view.identity,
      previousReadyKey: view.readyKey ?? handoffReadyKey(view.identity),
      next: "evaluate_or_test",
      ts: 0,
    } as never);
    if (!promotion.written) {
      if (promotion.refused !== undefined) {
        // F1-1/F1-5: the under-mutex precondition refused the promotion (the
        // tail was occupied between the pre-check and the append) — clean
        // refusal, no ALERT, no mutation.
        return { ran: false, terminal: undefined, refused: promotion.refused };
      }
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `cycle ${identity.cycleId}: promotion append FAILED (scheduler mutex held by pid ${promotion.heldByPid ?? "?"}) — admission_unknown; fail closed`,
      );
      return { ran: false, terminal: undefined, refused: "promotion_unknown" };
    }
    view = projectCycleHandoff(readEvents(ports), identity.cycleId);
    if (view?.state !== "waiting_for_evaluation_or_test") {
      return { ran: false, terminal: undefined, refused: `state:${view?.state ?? "missing"}` };
    }
  } else if (view.state !== "waiting_for_evaluation_or_test" && view.state !== "evaluating_or_testing" && view.state !== "publish_or_merge_wait") {
    return { ran: false, terminal: undefined, refused: `state:${view.state}` };
  }
  // `evaluating_or_testing` / `publish_or_merge_wait` are resumable: a crash
  // AFTER cycle:tail_started (or between tail_completed and cleanup) leaves the
  // fold there. The inner lock is the single-flight guard, the fold treats a
  // replayed tail_started/tail_completed as a no-op, and the walk resumes the
  // idempotent unfinished publish/cleanup — never a second Builder and never a
  // second tail.

  // 3. Re-verify the recorded workspace identity BEFORE tail_started: the
  // workspace must still be the RECORDED workspace (registered + repositoryId
  // match) and its primary head must equal the recorded builderHead (the commit
  // the Builder TCR-verified). A mismatch cancels the tail with an
  // identity_mismatch record — never a mutation of another cycle's workspace.
  const inspect = ports.git.managedWorktreeInspect;
  if (inspect !== undefined) {
    const primary = identity.workspace.members[0];
    const suffix = `${primary.workspaceKey}.submodules/`;
    const checks = await Promise.all(identity.workspace.members.map(async (member) => {
      const submodule = member.relativeLocator.startsWith(suffix) ? member.relativeLocator.slice(suffix.length) : undefined;
      const repoCwd = submodule === undefined ? ports.repoCwd : join(ports.repoCwd, submodule);
      const path = submodule === undefined ? ports.paths.worktreePath : join(ports.paths.worktreePath, ".submodules", submodule);
      const observed = await inspect(repoCwd, path).catch(() => undefined);
      if (observed === undefined || !observed.registered || observed.repositoryId !== member.repositoryId) return false;
      // Primary members must sit at the recorded builderHead; submodule members
      // at their recorded checkout head.
      const expectedHead = submodule === undefined ? identity.builderHead : member.checkoutRef.head;
      return observed.head === expectedHead;
    }));
    if (!checks.every(Boolean)) {
      const cancel = appendHandoffDecisionSynced(ports, {
        type: "cycle:tail_cancelled",
        eventId: "",
        idempotencyKey: `tail_cancelled:${identity.cycleId}:${identity.attempt}:${identity.fence}:identity_mismatch`,
        cycleId: identity.cycleId,
        attempt: identity.attempt,
        fence: identity.fence,
        reason: "identity_mismatch",
        ts: 0,
      } as never);
      if (cancel.written) {
        appendHandoffDecisionSynced(ports, {
          type: "cycle:serial_recovery",
          eventId: "",
          idempotencyKey: `recovery:${identity.cycleId}:${identity.attempt}:${identity.fence}:identity_mismatch`,
          cycleId: identity.cycleId,
          attempt: identity.attempt,
          fence: identity.fence,
          reason: "identity_mismatch",
          ts: 0,
        } as never);
      }
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `cycle ${identity.cycleId}: resumed-tail workspace identity mismatch — tail cancelled; workspace + story lease retained; serial recovery required`,
      );
      return { ran: true, terminal: undefined, recoveryRecorded: true };
    }
  }

  // 4. Single-flight re-entry guard (the inner lock).
  const acq = ports.process.acquireLock(ports.paths.lockPath, { staleSec: opts.lockStaleSec, cycleId: ctx.cycleId });
  if (!acq.acquired) {
    return { ran: false, terminal: undefined, heldByPid: acq.heldByPid };
  }

  ports.events.ensureEventFiles(ports.paths.eventsPath, ports.paths.runsPath);
  ports.process.writeHeartbeat(ports.paths.heartbeatPath);

  const startSec = ports.clock();
  let state: CycleState = { ...initialCycleState(ctx), phase: "publish", tailIdentity: identity, ctx: { ...ctx, startSec, storyId: identity.storyId, branch: identity.branch } };
  let lockReleased = false;
  let terminalEmitted = false;
  let recoveryRecorded = false;

  const noteTerminal = (cmds: CycleCommand[]): void => {
    if (cmds.some((c) => c.kind === "emit_event" && c.event.type === "cycle:end")) terminalEmitted = true;
    if (cmds.some((c) => c.kind === "release_lock")) lockReleased = true;
  };

  try {
    // 5. Executable latest-main check (when a predecessor merge is recorded):
    // a verdict routes the tail to serial_recovery BEFORE the tail starts.
    let pending: CycleEvent | undefined;
    if (view.state === "publish_or_merge_wait") {
      // Evaluation/tests already completed; only the terminal cleanup remains —
      // skip re-publishing (a second PR would be a duplicate delivery).
      pending = { type: "tail_event", kind: "tail_completed", status: "published" };
    } else {
      const freshness = opts.checkFreshness !== undefined ? await opts.checkFreshness(identity) : undefined;
      if (freshness !== undefined) {
        pending = {
          type: "freshness_result",
          verdict: freshness.verdict,
          predecessorMergeSha: freshness.predecessorMergeSha,
          recordedBaseSha: freshness.recordedBaseSha,
          builderHead: freshness.builderHead,
          ...(freshness.evidenceRefs !== undefined ? { evidenceRefs: freshness.evidenceRefs } : {}),
          ...(freshness.candidateHead !== undefined ? { candidateHead: freshness.candidateHead } : {}),
        };
      } else {
        pending = { type: "tail_resumed", identity };
      }
    }

    let steps = 0;
    while (pending !== undefined && steps < maxSteps) {
      steps += 1;
      if (state.phase === "execute" && !state.done) {
        const elapsed = ports.clock() - startSec;
        if (watchdogVerdict(elapsed, timeoutSec).breached) {
          pending = { type: "tail_event", kind: "tail_failed", reason: "child_failure" };
        }
      }

      const { state: next, commands } = cycleStep(state, pending);
      state = next;
      noteTerminal(commands);
      ports.process.writeHeartbeat(ports.paths.heartbeatPath);

      let nextEvent: CycleEvent | undefined;
      for (const cmd of commands) {
        let res: Awaited<ReturnType<typeof executeCommand>>;
        if (cmd.kind === "emit_event" && isCycleHandoffEvent(cmd.event)) {
          const written = appendHandoffDecisionSynced(ports, cmd.event);
          if (!written.written) {
            ports.events.appendAlert(
              ports.paths.alertsPath,
              `cycle ${identity.cycleId}: ${cmd.event.type} append FAILED (scheduler mutex held) — admission_unknown; fail closed`,
            );
          }
          res = {};
        } else {
          res = await executeCommand(cmd, ports, state.ctx);
        }
        if (res.lockReleased === true) lockReleased = true;
        if (res.event !== undefined) nextEvent = res.event;
        if (res.ctxPatch !== undefined) state = { ...state, ctx: { ...state.ctx, ...res.ctxPatch } };
      }

      // 6. In tail mode the publish result is converted to a tail_event: a
      // published/done/orphan ladder outcome completes the tail; anything else
      // cancels it into serial_recovery (leases retained).
      if (nextEvent !== undefined && nextEvent.type === "published" && state.tailIdentity !== undefined) {
        const status = classifyPublish(nextEvent.result);
        if (status === "published" || status === "done" || status === "orphan") {
          nextEvent = { type: "tail_event", kind: "tail_completed", status };
        } else {
          nextEvent = { type: "tail_event", kind: "tail_failed", reason: "repair_required" };
        }
      }

      if (state.recoveryRecorded === true) {
        recoveryRecorded = true;
        pending = undefined;
      } else if (state.done && nextEvent === undefined) {
        pending = undefined;
      } else {
        pending = nextEvent;
      }
    }
  } finally {
    if (!terminalEmitted && !recoveryRecorded) {
      ports.events.appendEvent(
        ports.paths.eventsPath,
        { ...cycleEndEvent({ cycleId: identity.cycleId, branch: identity.branch, agent: "", model: "" }, "aborted"), ts: eventTs(ports) },
      );
    }
    if (!lockReleased) ports.process.releaseLock(ports.paths.lockPath);
  }

  return {
    ran: true,
    terminal: state.terminal,
    resumedTail: true,
    ...(recoveryRecorded ? { recoveryRecorded: true } : {}),
    state,
  };
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
  };
}

// ── Dry-run plan rendering (the parallel-verification protocol's preview) ─────

/**
 * Render the command PLAN the cycle WOULD execute, without running anything.
 * Drives the pure {@link cycleStep} with a SCRIPTED happy-path event sequence
 * (preflight→pick/reserve→worktree→route→execute(accept)→capture(built)→publish→
 * done), collecting every command. No ports, no I/O — purely the orchestrator's
 * command vocabulary, so `roll loop run-once --dry-run` shows the executor map.
 */
export function dryRunPlan(ctx: CycleContext): string[] {
  const scripted: CycleEvent[] = [
    { type: "start", ctx },
    { type: "preflight_done" },
    { type: "story_picked", storyId: ctx.storyId ?? "US-EXAMPLE" },
    { type: "worktree_created" },
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
    case "spawn_agent":
      return `spawn_agent          → agentSpawn(${cmd.agent}, attempt ${cmd.attempt})`;
    case "spawn_role":
      return `spawn_role           → agentSpawn(${cmd.agent} as ${cmd.role}, round ${cmd.round})`;
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
