/**
 * Runner adapter — the executable glue that lets the pure {@link cycleStep}
 * orchestrator actually drive a cycle (prerequisite for US-LOOP-006 v2-vs-v3
 * parallel verification).
 *
 * ── Architectural home (the card asked me to pick + justify) ─────────────────
 * The card suggests `packages/infra/src/runner/executor.ts` ("command EXECUTION
 * is infra"). I place it in `packages/cli/src/runner/` instead. Justification —
 * the established package arrow is strictly one-directional:
 *     @roll/spec  ←  @roll/core
 *     @roll/spec  ←  @roll/infra
 *     @roll/core + @roll/infra  ←  @roll/cli
 * `@roll/infra`'s package.json depends ONLY on `@roll/spec` (verified), and the
 * git/github/process modules document that the arrow into core stays
 * one-directional ("core already depends on no infra; keeping the arrow
 * one-directional", github.ts:531). The dispatcher MUST import BOTH the
 * orchestrator's {@link CycleCommand} vocabulary (lives in @roll/core) AND the
 * infra executors. Putting it in infra would force `@roll/infra → @roll/core`,
 * inverting the layer arrow and creating a core↔infra coupling the whole port
 * was designed to avoid. The cli is the one package that already sees both, so
 * the adapter belongs here. The CLI command handler stays a thin one-liner
 * (commands/index.ts) that delegates to {@link runCycleOnce}; all logic is in
 * this module — "cli stays thin" is honoured at the command layer.
 *
 * ── What this module is ──────────────────────────────────────────────────────
 * {@link executeCommand} is the 1:1 dispatcher: every {@link CycleCommand} the
 * orchestrator emits maps onto an existing infra call / core plan, via an
 * injectable {@link Ports} bundle (git / github / process / events / agentSpawn /
 * clock) so tests fake every execution layer (PATH shims + file:// remotes; no
 * real network / agent / PR side effects). `*_run`-style commands return a
 * {@link CycleEvent} to feed back into the next {@link cycleStep}.
 */
import { parseClaimedIdsFromBacklog, resolveFallback, type CycleCommand, type CycleContext } from "@roll/core";
import type { ExecuteResult, Ports } from "./ports.js";
import { executeSetupCommand } from "./setup-handlers.js";
import { executeSpawnAgentCommand } from "./spawn-agent-handler.js";
import { executeSpawnRoleCommand } from "./spawn-role-handler.js";
import { executeCaptureFactsCommand } from "./capture-facts-handler.js";
import { executeTerminalCommand } from "./terminal-handlers.js";
import { resolveExecutionCwd, resolveExecutionRepoCwd } from "./submodule-worktree.js";
import { resolveIntegrationBranch } from "@roll/infra";

export { checkMainDirty } from "./main-checkout-guard.js";
export { buildRunRow, buildTerminalRecord } from "./run-records.js";
export {
  DEFAULT_ADVERSARIAL_CFG,
  parseEstMin,
  parseEstMinFromSpec,
  planAdversarial,
  recordExecutionProfile,
  routerEstMin,
  runDesignerStage,
  runEvaluatorStage,
} from "./execution-profile.js";
export {
  RESUME_DISABLED_ENV,
  cleanStaleEvidence,
  isParkedAtHold,
  resetSpecTruthText,
  resolveResumeBase,
  revertPrematureDone,
} from "./resume-truth.js";
export { nodePorts } from "./node-ports.js";
export {
  publishBodyWithEvidenceTrailer,
  runVisualEvidencePreflight,
  storyRequiresManualMerge,
} from "./publish-lifecycle.js";
export {
  DEPS_BOOTSTRAP_TIMEOUT_MS,
  PREBUILD_TIMEOUT_MS,
  SKILLS_BOOTSTRAP_TIMEOUT_MS,
  agentWritableRoots,
  bootstrapWorktreeDeps,
  bootstrapWorktreePrebuild,
  bootstrapWorktreeSkills,
  commitRollMetadataRepo,
  linkRollIntoWorktree,
  persistWorktreeAlerts,
  readPrebuildDistEnabled,
} from "./worktree-bootstrap.js";
export {
  readProjectMapEnabled,
  readResumeScope,
  readSessionReuseEnabled,
} from "./runner-policy.js";
export {
  appendWarmSession,
  consumeWarmSession,
  readWarmSessions,
  warmSessionsLedgerPath,
} from "./warm-sessions.js";
export {
  PROJECT_MAP_MAX_CHARS,
  buildLowScoreFixForwardPrompt,
  buildProjectMap,
  maybeInjectProjectMap,
} from "./project-map.js";
export {
  ActivitySignalRecorder,
  createCaptureMarkerSink,
  readCycleTimeoutThresholds,
  readStallThreshold,
  startBuilderLivenessProbe,
  startCycleObserver,
  startSpawnTimeoutWatchdog,
  startStallDetector,
} from "./spawn-observers.js";
export {
  appendCleanupEvent,
  appendWriteProtectionEvent,
  cleanupGuardResult,
  quarantineMainCheckoutForCycle,
  recordCleanupFailures,
  rescueLeakedMain,
} from "./sandbox-boundary.js";
export {
  blockIfAgentCredentialsMissing,
  detectAgyInternalFailure,
  projectAllowedAgents,
} from "./agent-routing.js";
export type { DepsExec, EventsPort, ExecuteResult, GitPort, GithubPort, MetadataCommitResult, Ports, ProcessClock, RunnerPaths } from "./ports.js";




/**
 * Dispatch ONE {@link CycleCommand} to the matching infra call / core plan via
 * {@link Ports}. The mapping table (command → executor) is documented inline.
 * Commands whose result the orchestrator consumes return a {@link CycleEvent};
 * pure side-effect commands return `{}`.
 *
 * `ctx` is the live cycle context (branch/agent/model/storyId) the orchestrator
 * threads; the executor reads it to parameterize publish/spawn calls.
 */
export async function executeCommand(
  cmd: CycleCommand,
  ports: Ports,
  ctx: CycleContext,
): Promise<ExecuteResult> {
  switch (cmd.kind) {
    // recovery.ts preflightPlan + orphan recovery. The pure plan is consulted by
    // the driver before the loop; here we just acknowledge readiness (the driver
    // already healed orphan state / verified hooks). Feeds back preflight_done.
    case "preflight":
    case "create_worktree":
    case "pick_story":
    case "resume_worktree":
    case "resolve_route":
      return executeSetupCommand(cmd, ports, ctx);
    case "acquire_capacity": {
      const result = ports.capacity.acquire(cmd.pending, ctx);
      if (result.kind === "waiting") {
        return {
          event: {
            type: "waiting_capacity",
            spawnId: cmd.pending.spawnId,
            retryAtMs: result.retryAtMs,
            contenders: result.contenders,
            suspect: result.suspect,
          },
        };
      }
      return {
        event: {
          type: "capacity_acquired",
          spawnId: cmd.pending.spawnId,
          lease: result.lease,
        },
      };
    }
    case "spawn_agent":
      return executeSpawnAgentCommand(cmd, ports, ctx);
    // US-LOOP-102: adversarial role spawn (test_author/implementer/attacker).
    case "spawn_role":
      return executeSpawnRoleCommand(cmd, ports, ctx);
    case "release_capacity": {
      const released = ports.capacity.release(cmd.leaseId, cmd.ownerToken);
      if (released.kind === "ownership_lost") {
        throw new Error(`agent_capacity_ownership_lost:${released.reason}`);
      }
      return { capacityReleased: true };
    }
    // layer). No feedback event (the orchestrator already transitioned).
    case "kill_agent":
      return {};

    // retry backoff (the adapter sleeps). Honour the schedule via the clock-free
    // setTimeout; the orchestrator already advanced attempt, so re-spawn follows.
    case "sleep_backoff":
      await sleep(cmd.seconds * 1000);
      return {};

    // capture facts: git rev-list/log count (bin/roll:9127-9157). worktree used
    // (we created it), agent exit (carried by the prior agent_exited — the driver
    // tracks it), commits ahead from git. timedOut is false here (timeout path
    // short-circuits before capture).
    case "capture_facts": {
      return executeCaptureFactsCommand(cmd, ports, ctx);
    }

    // FIX-1244: timeout teardown's lightweight probe — count the PRESERVED
    // worktree's real `tcr:` commits so a builder killed AFTER landing work is
    // not misjudged zero-TCR. No gates, no peer consults — one git call. When
    // the count is UNDETERMINABLE (git error) patch nothing: unknown stays
    // unknown so the zero-TCR gate stays conservative (never discards work).
    case "measure_worktree": {
      // E4: a submodule cycle's TCR commits landed in the SUBMODULE worktree, so
      // count them there (resolveExecutionCwd = the same sibling submodule worktree
      // the delivery lands from). No targetSubmodule ⇒ ports.paths.worktreePath.
      // E8: count against the EXECUTION repo's integration branch (execRepoCwd —
      // the submodule's own working branch), NOT the hardwired origin/main the
      // detached submodule cycle worktree lacks. No targetSubmodule ⇒
      // resolveIntegrationBranch(repoCwd) → origin/main default (zero regression).
      const measured = await ports.git
        .tcrCount(resolveExecutionCwd(ports, ctx), resolveIntegrationBranch(resolveExecutionRepoCwd(ports, ctx)))
        .catch(() => undefined);
      return measured === undefined ? {} : { ctxPatch: { tcrCount: measured } };
    }

    // delivery/pr + terminal side effects live in the publish/terminal handler.
    case "publish_pr":
    case "merge_back":
    case "push_orphan":
    case "rescue_leaked":
    case "wait_merge":
    case "reconcile":
    case "cleanup_environment":
    case "cleanup_worktree":
    case "emit_event":
    case "append_run":
    case "append_alert":
    case "release_lock":
      return executeTerminalCommand(cmd, ports, ctx);

    default: {
      // Exhaustiveness guard — an unmapped command is a hard error (report, don't
      // silently swallow). If a new CycleCommand kind appears, this throws.
      const _exhaustive: never = cmd;
      throw new Error(`executeCommand: unmapped command ${JSON.stringify(_exhaustive)}`);
    }
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}







// ── Node-backed Ports wiring (real infra) ─────────────────────────────────────

// Keep these referenced so resolveFallback / parseClaimedIds are not stripped by
// a too-eager tree-shaker in the test bundle (they document the available
// execution surface; nodePorts wires the common path).
export const _availableCoreSurface = {
  resolveFallback,
  parseClaimedIdsFromBacklog,
} as const;
