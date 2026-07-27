import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractUsage, getAgentSpec, toCycleCost, type AgentInternalFailure, type CycleCommand, type CycleContext, type RunKillReason } from "@roll/core";
import type { CycleCost } from "@roll/spec";
import { agentSpawnEnvironment } from "./agent-spawn.js";
import { classifyBlockSignature, suspendRig } from "./agent-liveness.js";
import { applyMainCheckoutWriteProtection, releaseMainCheckoutWriteProtection, repairCoreWorktreeContamination, worktreeGitEnv } from "./main-checkout-guard.js";
import { recoverKimiUsage, recoverPiUsage } from "./usage-recovery.js";
import { blockIfAgentCredentialsMissing, detectAgyInternalFailure } from "./agent-routing.js";
import { buildLowScoreFixForwardPrompt, maybeInjectProjectMap } from "./project-map.js";
import { buildRepairRoundBriefing } from "./repair-briefing-handler.js";
import { readProjectMapEnabled } from "./runner-policy.js";
import { appendWriteProtectionEvent, quarantineMainCheckoutForCycle, startMainCheckoutLeakWatchdog } from "./sandbox-boundary.js";
import { ActivitySignalRecorder, createCaptureMarkerSink, readCycleTimeoutThresholds, readStallThreshold, startBuilderLivenessProbe, startCycleObserver, startSpawnTimeoutWatchdog, startStallDetector } from "./spawn-observers.js";
import { persistWorktreeAlerts, submoduleAgentWritableRoots } from "./worktree-bootstrap.js";
import { runDesignerStage } from "./execution-profile.js";
import { eventTs, guardRuntimeDir } from "./runner-time.js";
import { readSkillBody } from "./skill-body.js";
import { resolveExecutionCwd, resolveExecutionRepoCwd } from "./submodule-worktree.js";
import { resolveIntegrationBranch } from "@roll/infra";
import { readGateMode, recordSpawnRound } from "./round-journal-emit.js";
import type { ExecuteResult, Ports } from "./ports.js";

type SpawnAgentCommand = Extract<CycleCommand, { kind: "spawn_agent" }>;

function executionSkillBody(ports: Ports, storyId: string | undefined): string {
  if (!ports.skillBody.startsWith("# Roll Loop")) return ports.skillBody;
  const skillName = storyId?.startsWith("FIX-") || storyId?.startsWith("BUG-") ? "roll-fix" : "roll-build";
  return readSkillBody(ports.repoCwd, { skillName }) ?? ports.skillBody;
}

export async function executeSpawnAgentCommand(
  cmd: SpawnAgentCommand,
  ports: Ports,
  ctx: CycleContext,
): Promise<ExecuteResult> {
  switch (cmd.kind) {
    case "spawn_agent": {
      // FIX-343 (step ①): mint the BUILDER's unique session id ONCE, here at the
      // working-agent spawn, and reuse it across retries (a non-empty
      // ctx.builderSessionId means a prior attempt already minted it). The attest
      // gate later compares the SCORER's session id against this so "an
      // independent fresh session (NOT a sub-agent sharing the builder's context)
      // scored this delivery" is a CHECKED invariant. Recorded on the cycle
      // context (ctxPatch below) and in the agent log header for audit.
      const builderSessionId =
        ctx.builderSessionId !== undefined && ctx.builderSessionId !== ""
          ? ctx.builderSessionId
          : `${ctx.cycleId ?? "cycle"}:build:${cmd.agent}:${ports.clock()}`;
      // E4: a submodule cycle runs the BUILDER (and everything that observes it —
      // the cycle observer, the timeout watchdog's commit probe, the git env, the
      // post-spawn alert scoop, the session-store usage recovery) INSIDE the
      // submodule cycle worktree, where its edits/build/test/commits land and E2's
      // landing reads the HEAD. No targetSubmodule ⇒ ports.paths.worktreePath
      // (execRepoCwd ⇒ ports.repoCwd), byte-identical to today.
      const execCwd = resolveExecutionCwd(ports, ctx);
      const execRepoCwd = resolveExecutionRepoCwd(ports, ctx);
      // E8: the cycle observer and the timeout watchdog's commit probe count the
      // builder's commits against the EXECUTION repo's integration branch (the
      // submodule's own working branch), NOT the hardwired origin/main. A submodule
      // cycle worktree is detached off the submodule's integration branch and has
      // no origin/main, so `origin/main..HEAD` fataled → the observer saw zero
      // commits (no cycle:tcr events) and the watchdog's commitCount read 0. The
      // baseline is resolved from execRepoCwd, never the detached worktree. No
      // targetSubmodule ⇒ resolveIntegrationBranch(repoCwd) → origin/main default.
      const observeBase = resolveIntegrationBranch(execRepoCwd);
      await quarantineMainCheckoutForCycle(ports, ctx, "pre-spawn");
      const credentialBlock = blockIfAgentCredentialsMissing(cmd.agent, "build", ports, ctx);
      if (credentialBlock !== null) {
        const suspended = suspendRig(guardRuntimeDir(ports), cmd.agent, "auth", credentialBlock, eventTs(ports));
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "rig:suspended",
          cycleId: ctx.cycleId,
          agent: cmd.agent,
          cause: "auth",
          detail: credentialBlock,
          nextProbeAt: suspended.nextProbeAt ?? eventTs(ports),
          ts: eventTs(ports),
        });
        return {
          event: { type: "agent_exited", exit: 1, timedOut: false },
          ctxPatch: { builderSessionId },
        };
      }
      // US-V4-006 / US-DELTA-006: for a `designed` cycle, cast the Designer
      // INDEPENDENTLY (its own agent identity + session, resolved via the scoped
      // `design` role — NEVER the Builder's agent) and run it BEFORE the Builder.
      // FAIL CLOSED — the Builder never starts — when no valid `design` binding
      // resolves OR the Designer publishes no valid contract. No-op for
      // standard/verified.
      if (ctx.selectedProfile === "designed") {
        const design = await runDesignerStage(ports, ctx);
        if (!design.ok) {
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `designer stage failed closed for ${ctx.storyId ?? "?"}: ${design.reasons.join("; ")} — Builder not started (cycle ${ctx.cycleId ?? "?"})`,
          );
          return { event: { type: "agent_exited", exit: 1, timedOut: false }, ctxPatch: { builderSessionId } };
        }
      }
      // US-PORT-011: the live observation file — one stable path per project,
      // truncated at each agent start, fed every chunk in real time. The popup
      // (runner template) and any `tail -f` watcher read THIS, not buffers.
      const livePath = join(dirname(ports.paths.eventsPath), "live.log");
      const liveBanner = `── cycle ${ctx.cycleId ?? "?"} · ${ctx.storyId ?? "?"} · agent ${cmd.agent} · build-session ${builderSessionId} ──`;
      try {
        writeFileSync(livePath, `${liveBanner}\n`);
      } catch {
        /* observation is best-effort */
      }
      const signalRecorder = new ActivitySignalRecorder(
        join(dirname(ports.paths.eventsPath), `cycle-${ctx.cycleId ?? "unknown"}.signals.jsonl`),
        cmd.agent,
        liveBanner,
        () => eventTs(ports),
      );
      const captureSink =
        ctx.evidenceRunDir !== undefined && ctx.evidenceRunDir !== ""
          ? createCaptureMarkerSink(ctx.evidenceRunDir, ports.capture)
          : undefined;
      // US-LOOP-076 (folds in FIX-310) — the BLACK-BOX KILLER. The agent run
      // below blocks for the WHOLE build/TCR phase (37 min observed). Before this
      // the runner emitted ZERO structured events in that window for every agent,
      // and the only "key node" extraction parsed claude stream-json (codex/kimi/
      // pi build phases invisible — a core-thesis violation). The poller fixes it
      // ONE agent-agnostic way: it observes the runner's OWN view of the cycle —
      // git commits on the worktree branch + the wall clock — and DERIVES standard
      // cycle:tcr / cycle:phase / build-heartbeat events into events.ndjson. It
      // never parses the agent's stdout, so a single path serves EVERY agent.
      const observer = await startCycleObserver(ports, ctx.cycleId ?? "", execCwd, observeBase);
      // FIX-907 — the HUNG-BUILDER KILLER. The agentSpawn below is a single
      // blocking await, so the orchestrator's between-step watchdog can NEVER
      // fire while a builder hangs (process alive, 0% CPU, no commits/output) —
      // it just holds the inflight lock and blocks the whole loop (实证: FIX-390
      // hung 46min). This poller races the spawn. FIX-1477 redefines "progress"
      // as GIT STATE CHANGE, agent-agnostic: a NEW commit OR a worktree
      // dirty-state signature change (`git status --porcelain` diff) resets BOTH
      // idle clocks (this is what saves stdout-buffering agents like pi that
      // write files long before committing); a stdout chunk now feeds ONLY the
      // true-silence fuse. A wall-clock overrun, a truly silent idle window, OR
      // a no-state-change window (thrash: tokens flowing, zero git progress)
      // kills the agent tree + records cycle:timeout. On a kill the spawn
      // resolves and we fold `timedOut` so the orchestrator's existing
      // abort_timeout teardown frees the lock and PRESERVES the worktree branch.
      // FIX-929 — the STALL DETECTOR. Fires a SOFT `agent:stall` signal when
      // the agent has produced zero output for ≥ threshold after startup grace.
      // Does NOT kill — it alerts the recovery layer (FIX-930) before the hard
      // timeout watchdog (below) kills the process. Threshold from env
      // ROLL_LOOP_STALL_THRESHOLD_MIN (default 10 min).
      const stallDetector = startStallDetector({
        cycleId: ctx.cycleId ?? "",
        agent: cmd.agent,
        clock: ports.clock,
        appendEvent: (ev) => ports.events.appendEvent(ports.paths.eventsPath, ev),
        thresholdSec: readStallThreshold(ports.repoCwd).thresholdSec,
      });
      // FIX-1477: the dirty-state probe rides the same git port (optional — a
      // port without it runs the state fuse on commits only).
      const statusSignature = ports.git.worktreeStatusSignature;
      const timeoutWatchdog = startSpawnTimeoutWatchdog({
        cycleId: ctx.cycleId ?? "",
        thresholds: readCycleTimeoutThresholds(ports.repoCwd),
        clock: ports.clock,
        // US-CYCLE-001: observe the run's OWN work dir (worktree/submodule),
        // not the main checkout. observeCwd=execCwd is LOAD-BEARING — the
        // watchdog hands it to the probes, which observe exactly that cwd.
        observeCwd: execCwd,
        commitCount: (cwd) => ports.git.commitsAhead(cwd, observeBase),
        ...(statusSignature !== undefined ? { stateSignature: (cwd) => statusSignature(cwd) } : {}),
        appendEvent: (ev) => ports.events.appendEvent(ports.paths.eventsPath, ev),
      });
      // FIX-338 (Phase B 杠杆2): when `loop_safety.project_map: true`, PREPEND a
      // concise, bounded project map into the working agent's initial context so it
      // doesn't burn execute time on sed/rg exploration. Agent-agnostic (one prompt
      // body all shapes consume) + bounded (hard char cap). DEFAULT-OFF — a no-op
      // until flipped on, in which case `ports.skillBody` is sent unchanged.
      const skillBodyForSpawn = maybeInjectProjectMap(
        executionSkillBody(ports, ctx.storyId),
        // E4: map the tree the builder actually works in (the submodule for a
        // submodule cycle), not the superproject shell.
        execCwd,
        readProjectMapEnabled(ports.repoCwd),
        ctx.storyId,
      );
      // FIX-386: when the story was re-picked after a low peer review score,
      // inject the reviewer's findings as a fix-forward task so the builder
      // fixes on the same resumed branch instead of starting fresh.
      const lowScoreFeedback = ctx.storyId !== undefined && ctx.storyId !== ""
        ? buildLowScoreFixForwardPrompt(ports.repoCwd, ctx.storyId)
        : "";
      // US-CYCLE-007: a non-empty lowScoreFeedback means THIS is a REPAIR round
      // (a re-dispatch after evaluator findings). Package the repair inputs as a
      // checksummed BRIEFING artifact (findings + git diff --stat + involved
      // files:lines + design-contract refs) and LEAD the skill body with it — the
      // fresh session's SOLE context entry point, prefixed with "start from these
      // findings; do NOT re-explore the whole repository". The briefing SUPERSEDES
      // the plain fix-forward prompt (it already carries the findings + the
      // branch-discipline instructions), so we never prepend both (no context
      // bloat). GUARDRAIL: this whole block only runs on a repair round — a
      // first/normal cycle has lowScoreFeedback === "" and finalSkillBody stays
      // byte-identical to skillBodyForSpawn.
      let repairBriefingLead = "";
      if (lowScoreFeedback !== "") {
        try {
          const briefing = await buildRepairRoundBriefing(ports, ctx, execCwd, execRepoCwd);
          if (briefing !== null && briefing.leadText !== "") repairBriefingLead = briefing.leadText;
        } catch {
          /* briefing is a warm-start AID — never fail the spawn; fall back below */
        }
      }
      const finalSkillBody =
        repairBriefingLead !== ""
          ? `${repairBriefingLead}\n\n${skillBodyForSpawn}`
          : lowScoreFeedback !== ""
            ? `${lowScoreFeedback}\n\n${skillBodyForSpawn}`
            : skillBodyForSpawn;
      // lever-4 (cross-card warm-context): after the pool was narrowed to
      // 国产/开源 agents (kimi/pi/reasonix), NO current engine declares a
      // warm-reuse capability — every cycle runs COLD. The resume-resolution +
      // session-capture wiring (formerly codex `exec resume`) was removed with
      // codex; the cold spawn below is the only path. A future resumable engine
      // re-introduces this as registry-driven, agent-agnostic logic.
      let res: Awaited<ReturnType<typeof ports.agentSpawn>>;
      let timeoutFired: RunKillReason | null = null;
      let activeMainLeak: { detected: boolean; files: string[] } = { detected: false, files: [] };
      let mainLeakWatchdog: ReturnType<typeof startMainCheckoutLeakWatchdog> | undefined;
      // FIX-1474 — the LOST-CHILD probe. The watchdogs above cover a child that
      // is ALIVE (hung / silent / thrashing); they cannot see a child that DIED
      // out-of-band while this spawn await never settles (external SIGKILL of a
      // process-tree member, PTY leader death, lost exit delivery) — the shape
      // that hung supervised cycles forever with no terminal state. The probe
      // polls the child's pid (reported via the onSpawn seam) and, on two
      // consecutive dead observations, records cycle:agent_lost, reaps the
      // tree, and resolves the race below so the cycle converges to the
      // explicit `aborted` terminal (no retry, no silent hang).
      let spawnedPid: number | undefined;
      let spawnSettled = false;
      let agentLost = false;
      let resolveLostRace: (() => void) | undefined;
      const lostRace = new Promise<Awaited<ReturnType<typeof ports.agentSpawn>>>((resolve) => {
        resolveLostRace = () => resolve({ stdout: "", stderr: "", exitCode: 137, timedOut: false });
      });
      const livenessProbe = startBuilderLivenessProbe({
        cycleId: ctx.cycleId ?? "",
        agent: cmd.agent,
        pid: () => spawnedPid,
        spawnPending: () => !spawnSettled,
        appendEvent: (ev) => ports.events.appendEvent(ports.paths.eventsPath, ev),
        onLost: () => {
          agentLost = true;
          resolveLostRace?.();
        },
      });
      // US-CYCLE-004: wall-clock start for the round-journal builder turn.
      const roundStart = Date.now();
      try {
        appendWriteProtectionEvent(
          ports,
          applyMainCheckoutWriteProtection({
            repoCwd: ports.repoCwd,
            runtimeDir: guardRuntimeDir(ports),
            cycleId: ctx.cycleId ?? "",
            nowMs: () => eventTs(ports),
          }),
        );
        mainLeakWatchdog = startMainCheckoutLeakWatchdog(ports, ctx);
        res = await Promise.race([
          ports.agentSpawn(cmd.agent, {
          purpose: "builder",
          // E4: the builder runs in the submodule cycle worktree for a submodule
          // story (execCwd); its git env + writable roots target the submodule's
          // own repo/object store so its commits actually land there.
          cwd: execCwd,
          skillBody: finalSkillBody,
          ...(ctx.evidenceRunDir !== undefined ? { runDir: ctx.evidenceRunDir } : {}),
          writableRoots: submoduleAgentWritableRoots(ports.repoCwd, execRepoCwd, ports.paths.alertsPath),
          ...(ctx.model !== undefined && ctx.model !== "" ? { model: ctx.model } : {}),
          env: {
            ...process.env,
            ROLL_LOOP_ALERT: ports.paths.alertsPath,
            ...worktreeGitEnv(execCwd, ports.repoCwd),
            ...agentSpawnEnvironment(cmd.agent),
          },
          // FIX-204B: pin the executor-picked story into the agent prompt — the
          // claim (pick_story → 🔨) and the work must be the same story.
          ...(ctx.storyId !== undefined && ctx.storyId !== "" ? { storyId: ctx.storyId } : {}),
          onChunk: (d: Buffer) => {
            // FIX-907/FIX-1477: any stdout chunk is LIVENESS — resets only the
            // true-silence (no-progress) clock, NOT the git-state clock, so a
            // thrashing agent burning tokens with zero git progress is still
            // caught by the no-state-change fuse.
            timeoutWatchdog.markProgress();
            // FIX-929: bump the stall-detector's progress clock — same signal,
            // separate detector with its own (lower) threshold.
            stallDetector.markProgress();
            captureSink?.onChunk(d);
            try {
              appendFileSync(livePath, d);
            } catch {
              /* best-effort */
            }
            signalRecorder.accept(d);
          },
          // FIX-1474: hand the live child to the liveness probe so an
          // out-of-band death is detected within a bounded window.
          onSpawn: (child) => {
            spawnedPid = child.pid;
          },
          }),
          lostRace,
        ]);
      } finally {
        // FIX-1474: the spawn await settled (either side of the race) — the
        // liveness probe stands down BEFORE the other observers stop.
        spawnSettled = true;
        livenessProbe.stop();
        if (mainLeakWatchdog !== undefined) {
          activeMainLeak = await mainLeakWatchdog.stop();
        }
        appendWriteProtectionEvent(
          ports,
          releaseMainCheckoutWriteProtection({
            repoCwd: ports.repoCwd,
            runtimeDir: guardRuntimeDir(ports),
            cycleId: ctx.cycleId ?? "",
            nowMs: () => eventTs(ports),
          }),
        );
        signalRecorder.flush();
        // Stop the timer AND take one final synchronous-await snapshot so the LAST
        // TCR commits (landed between the last tick and agent exit) are not lost.
        await observer.stop();
        timeoutFired = timeoutWatchdog.stop().firedReason;
        // FIX-929: stop the stall detector and capture whether it fired.
        stallDetector.stop();
      }
      // FIX-907: fold a watchdog kill into `timedOut` so the orchestrator runs
      // its clean abort_timeout teardown (kill + cycle:end blocked + lock release;
      // worktree PRESERVED). The cycle:timeout event was already emitted at the
      // breach moment (auditable reason: wall/no-progress/no-state-change).
      if (timeoutFired !== null) res = { ...res, timedOut: true };
      await captureSink?.flush();
      // E4: scoop ALERT*.md the builder dropped in its OWN cwd (the submodule
      // cycle worktree for a submodule story).
      persistWorktreeAlerts(execCwd, ports.paths.alertsPath, ports.events);
      if (activeMainLeak.detected) {
        await quarantineMainCheckoutForCycle(ports, ctx, "active-spawn");
        res = { ...res, exitCode: res.exitCode === 0 ? 1 : res.exitCode, timedOut: true };
      } else {
        await quarantineMainCheckoutForCycle(ports, ctx, "post-spawn");
      }

      // US-CYCLE-004: record this builder turn in the per-card round-journal.
      // Best-effort + guaranteed non-blocking (recordSpawnRound never throws) —
      // this is the auto-write for the spawn path, no manual step.
      // US-CYCLE-011: tag the turn with the gate SCOPE its last `roll test` ran at
      // (from the worktree proof) so the round-journal buckets gate time
      // --changed vs full. Best-effort; undefined ⇒ untagged.
      const builderGateMode = readGateMode(ports.paths.worktreePath);
      recordSpawnRound(ports, ctx, {
        role: "builder",
        start: roundStart,
        durMs: Date.now() - roundStart,
        outcome: res.timedOut ? "timeout" : res.exitCode === 0 ? "delivered" : "failed",
        ...(builderGateMode !== undefined ? { gateMode: builderGateMode } : {}),
      });

      // FIX-1237: heal-at-every-boundary — repair core.worktree contamination
      // immediately after EVERY agent spawn completes, not just at pre-init
      // and terminal.  Catches any poisoning the agent did during its run so
      // sibling worktrees never see a poisoned config before the next step.
      {
        const repair = repairCoreWorktreeContamination(ports.repoCwd);
        if (repair.healed) {
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "cycle:cleanup",
            cycleId: ctx.cycleId ?? "",
            rule: "core.worktree",
            path: repair.detail,
            ok: true,
            ts: eventTs(ports),
          });
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `FIX-1237: cycle ${ctx.cycleId ?? "?"} — core.worktree was pointing to "${repair.detail}" — auto-unset at post-spawn boundary`,
          );
        }
        const metaRepair = repairCoreWorktreeContamination(join(ports.repoCwd, ".roll"));
        if (metaRepair.healed) {
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "cycle:cleanup",
            cycleId: ctx.cycleId ?? "",
            rule: "roll-meta.core-worktree",
            path: metaRepair.detail,
            ok: true,
            ts: eventTs(ports),
          });
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `FIX-1237: cycle ${ctx.cycleId ?? "?"} — roll-meta core.worktree was pointing to "${metaRepair.detail}" — auto-unset at post-spawn boundary`,
          );
        }
      }

      // FIX-366 — BUILDER auth/network fast-fail (extends FIX-363's taxonomy from
      // reviewer/scorer to the main working agent). An UNAUTHENTICATED builder does
      // not silently burn the whole cycle: it prints a 403 / "Please run /login" in
      // its first seconds and exits. We signature-match the output we ALREADY have
      // (zero cost — NO precheck layer, NO per-tick probe, NO TTL cache) with the
      // SAME `classifyBlockSignature`, and on auth/network emit the SAME
      // `agent:blocked` event with `stage: "build"`. loop-run-once's existing
      // `readExternalBlock`/`writeReviewerBlockedAlert` then ISOLATES it from the
      // consecutive-CODE-failure counter and acts on the cause — auth PAUSES the
      // loop (re-login then `roll loop resume`), network breathes (self-heals on
      // reconnect). One block taxonomy for builder/reviewer/scorer; a healthy
      // logged-in builder never matches, so the normal cycle is unchanged.
      //
      // FIX-401: only classify a builder block after a real failure signal.
      // Successful long-session summaries can legitimately mention login,
      // credentials, or auth features; scanning exit-0 output caused false
      // auth blocks and global PAUSEs after real deliveries.
      const builderBlock =
        res.exitCode !== 0 || res.timedOut ? classifyBlockSignature(`${res.stdout}\n${res.stderr}`) : null;
      if (builderBlock === "quota" || builderBlock === "auth" || builderBlock === "network") {
        const detail = (`${res.stdout}\n${res.stderr}`.split("\n").find((l) => l.trim() !== "") ?? "").slice(0, 200);
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "agent:blocked",
          cycleId: ctx.cycleId ?? "",
          agent: cmd.agent,
          cause: builderBlock,
          stage: "build",
          detail,
          ts: eventTs(ports),
        });
        const suspended = suspendRig(guardRuntimeDir(ports), cmd.agent, builderBlock, detail, eventTs(ports));
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "rig:suspended",
          cycleId: ctx.cycleId,
          agent: cmd.agent,
          cause: builderBlock,
          detail,
          nextProbeAt: suspended.nextProbeAt ?? eventTs(ports),
          ts: eventTs(ports),
        });
      } else if (activeMainLeak.detected) {
        // E7: the leak watchdog SIGKILL'd the agent for writing into the main
        // checkout. That kill folds into `res.timedOut` for teardown (above),
        // but it is NOT a timeout — report the accurate death cause so on-call
        // is not misdirected to a no-progress hunt. detail lists the leaked
        // (newDirty) paths for immediate diagnosis.
        const detail = `agent wrote outside its sandbox into the main checkout: ${activeMainLeak.files.join(", ")}`.slice(0, 200);
        const suspended = suspendRig(guardRuntimeDir(ports), cmd.agent, "main_checkout_leak", detail, eventTs(ports));
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "rig:suspended",
          cycleId: ctx.cycleId,
          agent: cmd.agent,
          cause: "main_checkout_leak",
          detail,
          nextProbeAt: suspended.nextProbeAt ?? eventTs(ports),
          ts: eventTs(ports),
        });
      } else if (res.timedOut) {
        const detail = "agent timed out with no progress";
        const suspended = suspendRig(guardRuntimeDir(ports), cmd.agent, "agent_stall", detail, eventTs(ports));
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "rig:suspended",
          cycleId: ctx.cycleId,
          agent: cmd.agent,
          cause: "agent_stall",
          detail,
          nextProbeAt: suspended.nextProbeAt ?? eventTs(ports),
          ts: eventTs(ports),
        });
      }
      // lever-4 (cross-card warm-context) capture: removed with codex from the
      // pool. No current engine (kimi/pi/reasonix) declares a warm-reuse
      // capability, so there is no resumable session id to capture here — every
      // cycle is cold-origin. A future resumable engine re-introduces capture as
      // registry-driven, agent-agnostic logic.
      // F4 lesson (信号成对/可观测不归零): persist the agent's full output as a
      // per-cycle log next to events/runs — v2 keeps cycle logs; without this
      // an agent that "ran but delivered nothing" is undiagnosable.
      try {
        const logDir = join(dirname(ports.paths.eventsPath), "cycle-logs");
        mkdirSync(logDir, { recursive: true });
        writeFileSync(
          join(logDir, `${ctx.cycleId ?? "cycle"}.agent.log`),
          // FIX-343 (step ①): the builder session id is part of the auditable
          // header — the attest gate's scorer≠builder-session invariant is then
          // traceable to a recorded build-session id, not asserted.
          `# exit=${res.exitCode} timedOut=${res.timedOut} lost=${agentLost} build-session=${builderSessionId}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`,
        );
      } catch {
        /* logging must never fail the cycle */
      }
      // FIX-208/FIX-249/FIX-303: fold the agent's real usage into a per-cycle
      // cost via a per-agent normalization layer onto ONE 4-component model
      // (input/output/cache-read/cache-write — the roll thesis). Lanes:
      //   1. claude stream-json (per-turn usage + final total_cost_usd);
      //   2. AUTHORITATIVE session-store recovery for the agents whose `-p`
      //      stdout carries no parseable usage — each writes real per-turn
      //      usage to its own store, scoped here to this cycle's worktree + start:
      //        pi    → ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl
      //        kimi  → ~/.kimi-code/sessions/wd_<wt>_*/.../wire.jsonl
      //   3. generic stdout-scrape footer agents (kimi REGISTRY) — the lossy
      //      2-component legacy fallback, tried LAST so a session recovery's full
      //      4-component split always wins when present.
      // Best-effort: a miss on every lane leaves cost absent (n/a, never a fake
      // zero) — usage accounting must never fail the cycle.
      let costPatch: CycleCost | undefined;
      const agentName = ctx.agent ?? cmd.agent;
      try {
        const lines = res.stdout.split("\n");
        const usageSpec = getAgentSpec(agentName)?.usage;
        let usage = usageSpec?.stdoutExtractor === "claude-stream" ? extractUsage(agentName, lines) : null;
        if (usage === null && usageSpec?.sessionRecovery === "pi") {
          const rootOverride = (process.env["ROLL_PI_SESSIONS_ROOT"] ?? "").trim();
          // E4: pi/kimi key their session store by the agent's CWD, so recover
          // from execCwd (where the builder actually ran) for a submodule cycle.
          usage = recoverPiUsage(
            execCwd,
            ctx.startSec,
            ...(rootOverride !== "" ? [rootOverride] : []),
          );
        }
        if (usage === null && usageSpec?.sessionRecovery === "kimi") {
          const rootOverride = (process.env["ROLL_KIMI_SESSIONS_DIR"] ?? "").trim();
          usage = recoverKimiUsage(
            execCwd,
            ctx.startSec,
            ...(rootOverride !== "" ? [rootOverride] : []),
          );
        }
        // Stdout-scrape fallback (LAST): only when no authoritative stream or
        // session usage was found, so a 2-component footer never overrides a
        // recovered 4-component split.
        if (usage === null) usage = extractUsage(agentName, lines);
        if (usage !== null) {
          costPatch = toCycleCost(usage, {
            cycleId: ctx.cycleId,
            agent: agentName,
            // TCR reverts are not tracked at this layer yet; nominal == effective.
            revertCount: 0,
            // FIX-1259: backfill a usage whose adapter could not read the model
            // (e.g. the reasonix footer) with the SPAWN model — the same value
            // cycle:start records — so runs.jsonl agrees with cycle:start.
            ...(ctx.model !== undefined && ctx.model !== "" ? { spawnModel: ctx.model } : {}),
          });
        }
      } catch {
        /* usage parse is best-effort */
      }
      // FIX-1050: when usage is genuinely absent, record an agent-specific reason
      // so debug/detail output can distinguish parser failure from agents whose
      // stdout simply carries no usage (agy/gemini). The terminal event keeps the
      // closed `no_parseable_usage` reason; the runs row carries the finer-grained
      // diagnostic.
      const usageUnknownReason: string | undefined =
        costPatch === undefined
          ? agentName === "agy"
            ? "agy_stdout_no_usage"
            : agentName === "reasonix"
              ? "reasonix_footer_unmatched"
              : "no_parseable_usage"
          : undefined;
      // FIX-1051: when agy exits 0 with no parseable usage and effectively empty
      // stdout, scan the native antigravity CLI log for the real internal error
      // (e.g. GREP_SEARCH timeout → zero trajectory) instead of collapsing the
      // cycle into a generic gave_up.
      const agentInternalFailure: AgentInternalFailure | undefined =
        agentName === "agy" &&
        costPatch === undefined &&
        res.exitCode === 0 &&
        !res.timedOut
          ? detectAgyInternalFailure({
              agent: agentName,
              stdout: res.stdout,
              stderr: res.stderr,
              exitCode: res.exitCode,
              cycleStartSec: ctx.startSec,
            }) ?? undefined
          : undefined;
      return {
        // FIX-1474: a lost child converges the cycle to the explicit `aborted`
        // terminal in the orchestrator (no retry, no blocked) — the death was
        // environmental, recorded fail-loud via cycle:agent_lost.
        event: { type: "agent_exited", exit: res.exitCode, timedOut: res.timedOut, ...(agentLost ? { lost: true } : {}) },
        // FIX-343 (step ①): persist the builder session id on the cycle context so
        // it survives to the attest gate (the scorer≠builder-session invariant is then
        // traceable to a recorded build-session id, not asserted).
        ctxPatch: {
          builderSessionId,
          ...(costPatch !== undefined ? { cost: costPatch } : {}),
          ...(usageUnknownReason !== undefined ? { usageUnknownReason } : {}),
          ...(agentInternalFailure !== undefined ? { agentInternalFailure } : {}),
        },
      };
    }

  }
}
