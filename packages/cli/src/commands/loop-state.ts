/**
 * `roll loop pause|resume` — the PAUSE gate, and the run-state read that goes with it.
 *
 * US-LOOP-119: renamed from `loop-sched.ts`. The old name described what the file
 * no longer does — scheduling — and the rename waited until last so that a
 * path change could not hide the behaviour changes in cards 110-118.
 *
 * US-LOOP-117: this file used to be the scheduling surface — it generated the shell
 * runner a launchd lane invoked, wrote the plist, mounted and verified the lane, and
 * reaped what the lane spawned. All of that is gone: Roll installs no timers, and
 * delivery runs in the agent session that drives `roll loop go`.
 *
 * What remains is the part that was never about scheduling:
 *   - PAUSE marker : <project>/.roll/loop/PAUSE-<slug> — stops autonomous card
 *     selection; an explicit `roll loop go --cards <id>` still runs (FIX-1472).
 *   - run state    : ACTIVE | PAUSED, resolved from that marker alone.
 *   - leftover lane inventory: READ-ONLY discovery of `com.roll.*` plists an older
 *     install left behind, so `roll doctor` can tell the owner how to remove them.
 *     Nothing here ever writes to LaunchAgents.
 */
import {
  configResolve,
  projectIdentity,
} from "@roll/infra";
import { EventBus } from "@roll/core";
import { GOAL_SCHEMA_VERSION, parseGoalYaml, renderGoalYaml, resolveLang, t, transitionGoal, v3Catalog } from "@roll/spec";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentSecretEnvNames } from "../runner/agent-spawn.js";
import { clearRootCauseFailure } from "../runner/failure-attribution.js";
import {
  emitBacklogTargetError,
  resolveBacklogCommandTarget,
  stripBacklogScopeArgs,
  type BacklogOperation,
  type BacklogTargetDecision,
  type BacklogTargetResolver,
  type ResolvedBacklogTarget,
} from "./backlog-target.js";
import { loopControlRunnerReadout, staleLoopRunnerMessage } from "./loop-runner-readout.js";

// ─── injectable deps ────────────────────────────────────────────────────────
// US-LOOP-117: this interface used to carry a Scheduler seam, a launchd dir, a
// generated-runner exec hook, tmux probes and helper cleanup — everything `loop
// on/off/now/test` needed. Only Workspace-aware state, `pause`, and `resume`
// remain. The optional resolver keeps unit seams that exercise repo-local
// compatibility independent from the installed Workspace registry.
export interface LoopSchedDeps {
  identity: () => Promise<{ path: string; slug: string }>;
  resolveTarget?: BacklogTargetResolver;
}

function realDeps(): LoopSchedDeps {
  return {
    identity: () => projectIdentity(),
    resolveTarget: resolveBacklogCommandTarget,
  };
}

// US-LOOP-117: the loop-helper reaper (pid discovery, cwd matching, tmux kill)
// existed so `loop off` could stop what a lane had spawned. There is no lane and
// no `loop off`; a session's own children go with the session.


// ─── US-LOOP-117: runner-script templates + schedule math are gone ──────────
// These generated the shell runner a launchd lane invoked, plus its period/minute
// math (`deriveMinute`, `dreamScheduleFor`, `parseLoopPeriodMinutes`). Roll
// installs no lane, so nothing generates or schedules a runner.

// ─── helpers ──────────────────────────────────────────────────────────────────

function pathValue(): string {
  // The plist EnvironmentVariables PATH — brew/local dirs first, system after
  // (mirrors the live v2-generated plist; the runner self-repairs PATH anyway).
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    `${home}/.local/bin`,
    `${home}/.kimi-code/bin`,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o755 });
}

function pauseMarkerPath(projectPath: string, slug: string): string {
  return join(projectPath, ".roll", "loop", `PAUSE-${slug}`);
}

function workspacePauseMarkerPath(target: ResolvedBacklogTarget): string {
  return join(target.runtimeRoot, `PAUSE-${target.workspaceId}`);
}

function invalidWorkspaceTarget(): Extract<BacklogTargetDecision, { readonly ok: false }> {
  return { ok: false, code: "invalid_target", candidates: [] };
}

function resolveWorkspaceStateTarget(
  args: readonly string[],
  operation: BacklogOperation,
  deps: LoopSchedDeps,
): BacklogTargetDecision | null {
  if (deps.resolveTarget === undefined) return null;
  const scoped = stripBacklogScopeArgs(args);
  if (!scoped.ok || scoped.args.length > 0) return invalidWorkspaceTarget();
  return deps.resolveTarget(args, operation);
}

function singleWorkspaceTarget(decision: BacklogTargetDecision): ResolvedBacklogTarget | null {
  if (!decision.ok || "aggregate" in decision) return null;
  return decision;
}

// ─── loop run state ─────────────────────────────────────────────────────────

/**
 * The loop's run state resolved from on-disk markers.
 *
 * US-LOOP-115: DORMANT is gone. It meant "the backlog drained, so the launchd lane
 * unloaded itself and stopped writing idle records" — a state that only makes sense
 * for a timer that wakes on its own. A session-driven loop cannot idle-spin, so the
 * only real state left is whether the owner (or a tripped correction breaker) has
 * PAUSED autonomous progress.
 *
 * A leftover `DORMANT-<slug>` file on disk is an inert artifact: never read, never
 * an error, never auto-deleted (`roll loop gc` may clean it).
 */
export type LoopRunState = "PAUSED" | "ACTIVE";

export function resolveLoopRunState(projectPath: string, slug: string): LoopRunState {
  return existsSync(pauseMarkerPath(projectPath, slug)) ? "PAUSED" : "ACTIVE";
}

function syncGoalPaused(projectPath: string, reason: string): void {
  const rt = join(projectPath, ".roll", "loop");
  const path = join(rt, "goal.yaml");
  if (!existsSync(path)) return;
  try {
    const before = parseGoalYaml(readFileSync(path, "utf8"));
    if (before.status === "paused" || before.status === "complete") return;
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const after = transitionGoal(before, "paused", { actor: "system", reason, at });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, renderGoalYaml(after), "utf8");
    renameSync(tmp, path);
    new EventBus().appendEvent(join(rt, "events.ndjson"), {
      type: "goal:state",
      schema: GOAL_SCHEMA_VERSION,
      from: before.status,
      to: after.status,
      actor: "system",
      reason,
      ts: Math.floor(Date.now() / 1000),
    });
  } catch {
    // `roll loop pause` must still pause the scheduler marker even if goal.yaml
    // is temporarily malformed; `roll loop goal` remains the fail-loud reader.
  }
}

// ─── commands ─────────────────────────────────────────────────────────────────

type WorkspaceCapacityReadout =
  | { state: "acquired"; agent: string; model: string }
  | { state: "waiting"; agent: string; model: string; retryAt: number; suspect: boolean };

function workspaceCapacityReadout(runtimeRoot: string): WorkspaceCapacityReadout | null {
  const path = join(runtimeRoot, "events.ndjson");
  if (!existsSync(path)) return null;
  try {
    const rows = readFileSync(path, "utf8").trimEnd().split("\n").reverse();
    for (const row of rows) {
      if (row.trim() === "") continue;
      const event = JSON.parse(row) as Record<string, unknown>;
      const type = event["type"];
      if (type === "workspace:capacity_released") return null;
      if (type === "workspace:capacity_acquired" || type === "workspace:capacity_heartbeat") {
        return {
          state: "acquired",
          agent: String(event["agent"] ?? ""),
          model: String(event["model"] ?? ""),
        };
      }
      if (type === "workspace:waiting_capacity") {
        return {
          state: "waiting",
          agent: String(event["agent"] ?? ""),
          model: String(event["model"] ?? ""),
          retryAt: Number(event["retryAt"] ?? 0),
          suspect: event["suspect"] === true,
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function renderWorkspaceCapacity(readout: WorkspaceCapacityReadout | null, lang: "en" | "zh"): string {
  if (readout === null) return "";
  const model = readout.model === "" ? "default" : readout.model;
  if (readout.state === "acquired") {
    return lang === "zh"
      ? `  容量=已获取 agent=${readout.agent} model=${model}`
      : `  capacity=acquired agent=${readout.agent} model=${model}`;
  }
  const retry = Number.isFinite(readout.retryAt) && readout.retryAt > 0
    ? new Date(readout.retryAt).toISOString()
    : "unknown";
  return lang === "zh"
    ? `  容量=等待 agent=${readout.agent} model=${model} retry=${retry}${readout.suspect ? " suspect=true" : ""}`
    : `  capacity=waiting agent=${readout.agent} model=${model} retry=${retry}${readout.suspect ? " suspect=true" : ""}`;
}

/** Read Workspace run state without reviving scheduler/backend concepts. */
export async function loopWorkspaceStatusCommand(
  args: string[],
  deps: LoopSchedDeps = realDeps(),
): Promise<number> {
  const decision = resolveWorkspaceStateTarget(args, "read", deps);
  if (decision === null) return 1;
  if (!decision.ok) return emitBacklogTargetError(decision);
  const targets = "aggregate" in decision ? decision.aggregate : [decision];
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  }) === "zh" ? "zh" : "en";
  const rows = targets.map((target) => {
    const runtimeRoot = join(target.workspaceRoot, "runtime");
    const marker = join(runtimeRoot, `PAUSE-${target.workspaceId}`);
    const state = existsSync(marker) ? "paused" : "active";
    const capacity = renderWorkspaceCapacity(workspaceCapacityReadout(runtimeRoot), lang);
    return `${target.workspaceId}  ${state}  session-driven  ${runtimeRoot}${capacity}`;
  });
  process.stdout.write(rows.join("\n") + (rows.length === 0 ? "" : "\n"));
  return 0;
}

function workspacePause(target: ResolvedBacklogTarget): number {
  mkdirSync(target.runtimeRoot, { recursive: true });
  const marker = workspacePauseMarkerPath(target);
  const already = existsSync(marker);
  if (!already) writeFileSync(marker, `${new Date().toISOString()}\n`);
  process.stdout.write(
    `${already ? "Workspace loop already paused" : "Workspace loop paused"}: ${target.workspaceId} (${target.canonicalRoot})\n` +
      `  runtime: ${target.runtimeRoot}\n`,
  );
  return 0;
}


/**
 * FIX-212 — (re)install a service plist and PROVE it mounted.
 *
 * The bootout+bootstrap dance (FIX-027/098) races: `launchctl bootstrap` can
 * return non-zero, OR return 0 while the job silently never mounts. Either way
 * the old `loop on` reported success and the scheduler died quietly for hours.
 * So we treat "mounted" as the authoritative signal (`isArmed` via the
 * Scheduler seam), reinstall once more if the first pass did not land it, and
 * surface the launchctl stderr on failure.
 *
 * Returns `{ ok, detail }` — `detail` is "loaded" on success, else the
 * failure reason.
 */
// US-LOOP-117: mountService / mountFailureMessage / restoreDormantClaim were the
// install-and-verify path for a launchd lane. Their only callers were `loop on`
// (deleted in US-LOOP-116), so they are unreachable.

export function launchAgentsDir(): string {
  return process.env["_LAUNCHD_DIR"] ?? join(homedir(), "Library", "LaunchAgents");
}

/**
 * Every `com.roll.*` launchd lane label on this machine, optionally scoped to a
 * project slug.
 *
 * US-LOOP-116: Roll installs no lanes, so any hit is a LEFTOVER from an older
 * install. These stay as read-side inventory — `roll doctor` lists them and prints
 * the disarm command; nothing here ever writes to LaunchAgents.
 */
function listRollLaneLabelsByFilter(filter: (name: string) => boolean): string[] {
  try {
    return readdirSync(launchAgentsDir())
      .filter((n) => n.startsWith("com.roll.") && n.endsWith(".plist"))
      .filter(filter)
      .map((n) => n.replace(/\.plist$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/** Leftover lane labels belonging to one project slug. */
export function listRollLaneLabels(slug: string): string[] {
  return listRollLaneLabelsByFilter((n) => n.endsWith(`.${slug}.plist`));
}

// US-LOOP-119: `listAllRollLaneLabels()` (every com.roll.* label on the machine,
// regardless of project) is deleted — nothing referenced it, in src or in tests.
// `roll doctor` does its own machine-wide scan of the LaunchAgents dir; this was a
// second, unused way to ask the same question.

// ─── US-LOOP-116: `loop on` / `loop off` are gone ───────────────────────────
// Their entry points were cut in US-LOOP-113 and nothing routes to them, so the
// implementations were dead code. `loop off` in particular still printed
// "verified: no further scheduler tick is possible" — a claim it could no longer
// substantiate once the fallback it also stopped was deleted (codex review r1).

// ─── US-LOOP-116: the process fallback is gone ──────────────────────────────
// US-LOOP-107 added a `detached` self-running process as a fallback for when
// launchd bootstrap failed. It was a SECOND resident scheduler: deleting the plist
// layer alone would have left it running under a different name. With no resident
// scheduling at all there is no backend to choose, so SchedulerBackendName,
// the lease/heartbeat/liveness probes and `roll loop fallback` are all deleted.

export async function loopPauseCommand(args: string[], deps: LoopSchedDeps = realDeps()): Promise<number> {
  const workspaceDecision = resolveWorkspaceStateTarget(args, "mutation", deps);
  if (workspaceDecision !== null) {
    if (!workspaceDecision.ok) return emitBacklogTargetError(workspaceDecision);
    const target = singleWorkspaceTarget(workspaceDecision);
    return target === null ? emitBacklogTargetError(invalidWorkspaceTarget()) : workspacePause(target);
  }
  const id = await deps.identity();
  const marker = pauseMarkerPath(id.path, id.slug);
  mkdirSync(dirname(marker), { recursive: true });
  const already = existsSync(marker);
  if (!already) writeFileSync(marker, `${new Date().toISOString()}\n`);
  syncGoalPaused(id.path, "loop_pause");
  process.stdout.write(
    already
      ? `Loop already paused\nLoop 已处于暂停\n`
      : `Loop paused — no card will be picked autonomously\nLoop 已暂停 — 不再自动摘取卡片\n`,
  );
  // US-LOOP-116 (codex review r2): there is no scheduler to describe. Pause stops
  // AUTONOMOUS card selection by the session; it does not stop a session that names
  // its card explicitly (below).
  process.stdout.write(
    "a session driving `roll loop go` will stop at the next cycle boundary until `roll loop resume`\n",
  );
  // FIX-1472: pause stops AUTONOMOUS scheduling only. A supervisor can still run
  // one explicitly-scoped card without resuming (which would re-enable
  // autonomous selection of any eligible Todo).
  process.stdout.write(
    "  supervisor one-shot: `roll loop go --cards <ids> --max-cycles 1` runs exactly those cards while staying paused (no autonomous scheduling).\n",
  );
  return 0;
}

/** `roll loop resume` — remove the PAUSE marker, reset failure/heal counters. */
export async function loopResumeCommand(args: string[], deps: LoopSchedDeps = realDeps()): Promise<number> {
  const workspaceDecision = resolveWorkspaceStateTarget(args, "mutation", deps);
  if (workspaceDecision !== null) {
    if (!workspaceDecision.ok) return emitBacklogTargetError(workspaceDecision);
    const target = singleWorkspaceTarget(workspaceDecision);
    if (target === null) return emitBacklogTargetError(invalidWorkspaceTarget());
    const marker = workspacePauseMarkerPath(target);
    const existed = existsSync(marker);
    const pauseBody = existed ? readPauseMarker(marker) : "";
    rmSync(marker, { force: true });
    for (const counter of [
      join(target.runtimeRoot, "consecutive-fails"),
      join(target.runtimeRoot, `consecutive-idle-${target.workspaceId}`),
    ]) {
      if (existsSync(counter)) writeFileSync(counter, "0", "utf8");
    }
    const rootCauseKey = rootCauseKeyFromPauseMarker(pauseBody);
    if (rootCauseKey !== null) clearRootCauseFailure(target.runtimeRoot, rootCauseKey);
    const stateFile = join(target.runtimeRoot, `state-${target.workspaceId}.yaml`);
    if (existsSync(stateFile)) {
      const lines = readFileSync(stateFile, "utf8").split("\n").filter((line) => !line.startsWith("heal_count_head_"));
      writeFileSync(stateFile, lines.join("\n"), "utf8");
    }
    rmSync(join(target.runtimeRoot, "heal"), { recursive: true, force: true });
    if (existed) {
      new EventBus().appendEvent(join(target.runtimeRoot, "events.ndjson"), {
        type: "loop:resumed",
        loop: "ci",
        ts: Math.floor(Date.now() / 1000),
      });
    }
    process.stdout.write(
      `${existed ? "Workspace loop resumed" : "Workspace loop was not paused"}: ${target.workspaceId} (${target.canonicalRoot})\n` +
        `  runtime: ${target.runtimeRoot}\n`,
    );
    return 0;
  }
  const id = await deps.identity();
  const runner = loopControlRunnerReadout(id.path);
  process.stdout.write(`roll loop resume: runner ${runner.bin} v${runner.runningVersion}\n`);
  if (runner.projectNewer) {
    process.stderr.write(staleLoopRunnerMessage("roll loop resume", runner));
    return 1;
  }
  const marker = pauseMarkerPath(id.path, id.slug);
  const existed = existsSync(marker);
  const pauseBody = existed ? readPauseMarker(marker) : "";
  rmSync(marker, { force: true });

  // FIX-251: resume must clear the consecutive-failure counter so the first
  // post-resume cycle failure does not immediately re-trip the auto-pause.
  // US-LOOP-079h1 AC4: also clear the consecutive-idle counter.
  const rt = join(id.path, ".roll", "loop");
  const counterFile = join(rt, "consecutive-fails");
  if (existsSync(counterFile)) {
    try {
      writeFileSync(counterFile, "0", "utf8");
    } catch {
      /* best-effort */
    }
  }
  const idleCounterFile = join(rt, `consecutive-idle-${id.slug}`);
  if (existsSync(idleCounterFile)) {
    try {
      writeFileSync(idleCounterFile, "0", "utf8");
    } catch {
      /* best-effort */
    }
  }

  const rootCauseKey = rootCauseKeyFromPauseMarker(pauseBody);
  if (rootCauseKey !== null) {
    clearRootCauseFailure(rt, rootCauseKey);
  }

  // Clear per-HEAD heal counters from the state file (heal_count_head_*).
  const stateFile = join(rt, `state-${id.slug}.yaml`);
  if (existsSync(stateFile)) {
    try {
      const body = readFileSync(stateFile, "utf8");
      const lines = body.split("\n").filter((l) => /^(?!heal_count_head_)/.test(l));
      writeFileSync(stateFile, lines.join("\n"), "utf8");
    } catch {
      /* best-effort */
    }
  }

  // Clear the heal dir (removes per-HEAD CI heal budget files).
  const healDir = join(
    (process.env["ROLL_LOOP_DIR"] ?? "").trim() || join(homedir(), ".shared", "roll", "loop"),
    "heal",
  );
  try {
    rmSync(healDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }

  // Emit a loop:resumed event so dashboards/monitors see the reset and the
  // correction circuit (events-based) can observe the boundary.
  if (existed) {
    try {
      const eventsPath = join(rt, "events.ndjson");
      mkdirSync(rt, { recursive: true });
      new EventBus().appendEvent(eventsPath, {
        type: "loop:resumed",
        loop: "ci",
        ts: Math.floor(Date.now() / 1000),
      });
    } catch {
      /* event log is best-effort; the counter/file resets above are canonical */
    }
  }

  process.stdout.write(
    existed
      ? `Loop resumed — autonomous card selection re-enabled\nLoop 已恢复 — 重新允许自动摘取卡片\n`
      : `Loop was not paused\nLoop 本就未暂停\n`,
  );
  // US-LOOP-116: nothing starts on its own. Resume only clears the gate; a session
  // still has to drive, and every other gate still applies.
  process.stdout.write(
    "`roll loop go` can now pick eligible Todo within route/evidence/Evaluator/release gates\n",
  );
  return 0;
}

function rootCauseKeyFromPauseMarker(body: string): string | null {
  const match = /^\*\*Root cause\*\*:\s*(\S+)\s*$/m.exec(body);
  return match?.[1] ?? null;
}

function readPauseMarker(marker: string): string {
  try {
    return readFileSync(marker, "utf8");
  } catch {
    return "";
  }
}

// ─── US-LOOP-116: `loop now` and its legacy self-heal are gone ──────────────
// `now` meant "fire what the timer would fire". There is no timer, the entry
// point was cut in US-LOOP-113, and nothing routed here.
