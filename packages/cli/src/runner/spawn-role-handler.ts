/**
 * @responsibility Executes the adversarial-pairing spawn_role command.
 */
/**
 * US-LOOP-102 — the adversarial-pairing `spawn_role` executor.
 *
 * The orchestrator (pure) sequences test_author → implementer → attack rounds
 * and emits a {@link CycleCommand} `spawn_role` per stage; this adapter runs the
 * role agent and feeds back a `role_exited` event the orchestrator consumes.
 *
 * This is deliberately a THIN sibling of {@link executeSpawnAgentCommand} — the
 * builder-only quarantine / watchdog / cost machinery is NOT duplicated here.
 * The full §7 degrade taxonomy (rig rotation, fail-closed alerts) is US-LOOP-103
 * and the observability append_run.adversarial aggregate is US-LOOP-104; this
 * story wires the sequence + the two signals the pure state machine needs:
 *   - a role's exit code / timeout (drives the never-deadlock fallback), and
 *   - for an ATTACKER round, whether it surfaced a new hole and which breaking
 *     test it added (collected into the Phase 6 Agent-4 audit input).
 *
 * The attacker reports its finding by writing a small JSON marker to the path
 * handed in `ROLL_ADVERSARIAL_MARKER` (`{ newHole: boolean, attackTest?: string }`).
 * No marker ⇒ the round was dry. Reading a written artifact (not parsing agent
 * stdout) keeps this agent-agnostic, consistent with the roll core thesis.
 *
 * SAFETY (US-LOOP-106): the code-writing roles (implementer/attacker) carry the
 * same main-checkout protection as the standard builder — US-LOOP-089 OS
 * write-protection around the spawn + an active leak watchdog + pre/post
 * quarantine — so a role that escapes its worktree cannot pollute the shared main
 * checkout (memory: builder git leak is the top failure mode). A detected leak
 * forces the role to a failure result, which the orchestrator maps through
 * `adversarialDegradeDecision` to a standard single builder (never silent, never
 * deadlock). A spawn-local `timeoutMs` hard-kill bounds a single hung role (the
 * between-step watchdog cannot interrupt an in-flight await). The FIX-929 stall
 * detector + rig-rotation degrade remain the standard builder's job (this handler
 * degrades TO that builder rather than re-implementing it).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CycleCommand, CycleContext } from "@roll/core";
import { adversarialRolePrompt, agentSpawnEnvironment } from "./agent-spawn.js";
import { applyMainCheckoutWriteProtection, releaseMainCheckoutWriteProtection, worktreeGitEnv } from "./main-checkout-guard.js";
import { appendWriteProtectionEvent, quarantineMainCheckoutForCycle, startMainCheckoutLeakWatchdog } from "./sandbox-boundary.js";
import { spawnWatched } from "./spawn-watchdog.js";
import { resolveIntegrationBranch } from "@roll/infra";
import { eventTs, guardRuntimeDir } from "./runner-time.js";
import { submoduleAgentWritableRoots } from "./worktree-bootstrap.js";
import { resolveExecutionCwd, resolveExecutionRepoCwd } from "./submodule-worktree.js";
import type { ExecuteResult, Ports } from "./ports.js";

type SpawnRoleCommand = Extract<CycleCommand, { kind: "spawn_role" }>;

/** The attacker's per-round finding marker. */
interface AttackMarker {
  newHole?: boolean;
  attackTest?: string;
}

/** Resolve the deterministic marker path for a cycle+round (also handed to the
 *  spawned agent via `ROLL_ADVERSARIAL_MARKER`). */
export function adversarialMarkerPath(ports: Ports, cycleId: string, round: number): string {
  return join(dirname(ports.paths.eventsPath), `adversarial-${cycleId || "cycle"}-round-${round}.json`);
}

function readAttackMarker(path: string): AttackMarker | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    const marker: AttackMarker = {};
    if (typeof rec["newHole"] === "boolean") marker.newHole = rec["newHole"];
    if (typeof rec["attackTest"] === "string") marker.attackTest = rec["attackTest"];
    return marker;
  } catch {
    return null;
  }
}

export async function executeSpawnRoleCommand(
  cmd: SpawnRoleCommand,
  ports: Ports,
  ctx: CycleContext,
): Promise<ExecuteResult> {
  const markerPath = adversarialMarkerPath(ports, ctx.cycleId ?? "", cmd.round);
  // Clear any stale marker from a prior spawn at the same round before running.
  try {
    rmSync(markerPath, { force: true });
  } catch {
    /* best-effort */
  }

  const startSec = ports.clock();
  const rolePrompt = adversarialRolePrompt(cmd.role);
  // US-LOOP-106: guard the shared main checkout for the role's whole lifetime,
  // exactly as the standard builder does — write-protect + watch for a leak,
  // quarantine any pollution pre/post. A detected active leak forces a failure
  // result so the orchestrator degrades to a standard builder.
  await quarantineMainCheckoutForCycle(ports, ctx, "pre-spawn");
  let res: Awaited<ReturnType<typeof ports.agentSpawn>>;
  let activeMainLeak: { detected: boolean; files: string[] } = { detected: false, files: [] };
  let mainLeakWatchdog: ReturnType<typeof startMainCheckoutLeakWatchdog> | undefined;
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
    // The adversarial writer has the same main-checkout boundary as the normal
    // builder: do not launch it until the watchdog's baseline is immutable.
    await mainLeakWatchdog.ready();
    // E4: an adversarial role (test_author/implementer/attacker) writes code +
    // tests just like the builder, so a submodule cycle runs it in the submodule
    // cycle worktree (execCwd) with the submodule's git env + writable roots. No
    // targetSubmodule ⇒ ports.paths.worktreePath / ports.repoCwd, unchanged.
    const execCwd = resolveExecutionCwd(ports, ctx);
    const execRepoCwd = resolveExecutionRepoCwd(ports, ctx);
    // US-CYCLE-002: the code-writing adversarial role (test_author/implementer/
    // attacker) goes through the shared run-watchdog with the BUILDER cap — the
    // in-await liveness belt the between-step orchestrator watchdog cannot be for
    // (FIX-907). Renews on git-state progress in execCwd; a silent role dies on
    // schedule with a structured spawn:kill. Replaces the old cycle-wall belt.
    res = (
      await spawnWatched({
        ports,
        ctx,
        purpose: cmd.role,
        agent: cmd.agent,
        observeCwd: execCwd,
        observeBase: resolveIntegrationBranch(execRepoCwd),
        run: () =>
          ports.agentSpawn(cmd.agent, {
            purpose: cmd.role,
            cwd: execCwd,
            skillBody: `${rolePrompt}\n\n${ports.skillBody}`,
            writableRoots: submoduleAgentWritableRoots(ports.repoCwd, execRepoCwd, ports.paths.alertsPath),
            ...(ctx.model !== undefined && ctx.model !== "" ? { model: ctx.model } : {}),
            ...(ctx.storyId !== undefined && ctx.storyId !== "" ? { storyId: ctx.storyId } : {}),
            ...(ctx.evidenceRunDir !== undefined ? { runDir: ctx.evidenceRunDir } : {}),
            env: {
              ...process.env,
              ROLL_LOOP_ALERT: ports.paths.alertsPath,
              ROLL_ADVERSARIAL_MARKER: markerPath,
              ...worktreeGitEnv(execCwd, ports.repoCwd),
              ...agentSpawnEnvironment(cmd.agent),
            },
          }),
      })
    ).result;
  } finally {
    if (mainLeakWatchdog !== undefined) activeMainLeak = await mainLeakWatchdog.stop();
    appendWriteProtectionEvent(
      ports,
      releaseMainCheckoutWriteProtection({
        repoCwd: ports.repoCwd,
        runtimeDir: guardRuntimeDir(ports),
        cycleId: ctx.cycleId ?? "",
        nowMs: () => eventTs(ports),
      }),
    );
  }
  if (activeMainLeak.detected) {
    await quarantineMainCheckoutForCycle(ports, ctx, "active-spawn");
    // Force a failure result → orchestrator degrades to a standard builder.
    res = { ...res, exitCode: res.exitCode === 0 ? 1 : res.exitCode, timedOut: true };
  } else {
    await quarantineMainCheckoutForCycle(ports, ctx, "post-spawn");
  }
  // CUMULATIVE elapsed (from cycle start when known) so the pure
  // adversarialNextStep `totalTimeoutSec` guard is a true subsequence-wide cap,
  // not a per-role duration. Falls back to this spawn's duration pre-cycle-start.
  const elapsedSec =
    ctx.startSec !== undefined && ctx.startSec > 0
      ? Math.max(0, ports.clock() - ctx.startSec)
      : Math.max(0, ports.clock() - startSec);

  // The attacker's newHole/attackTest come from the marker it wrote. For the
  // test_author / implementer roles there is no hole signal.
  let newHole: boolean | undefined;
  let attackTest: string | undefined;
  if (cmd.role === "attacker") {
    const marker = readAttackMarker(markerPath);
    newHole = marker?.newHole === true;
    if (newHole && typeof marker?.attackTest === "string" && marker.attackTest !== "") {
      attackTest = marker.attackTest;
    }
  }

  return {
    event: {
      type: "role_exited",
      role: cmd.role,
      exit: res.exitCode,
      timedOut: res.timedOut,
      elapsedSec,
      ...(newHole !== undefined ? { newHole } : {}),
      ...(attackTest !== undefined ? { attackTest } : {}),
    },
  };
}
