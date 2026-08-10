/**
 * @responsibility Runs the `roll loop recover` subcommand, the supervised recovery path out of a no-progress stop.
 */
/**
 * `roll loop recover [<story-id>] [--reason "..."] [--actor <who>] [--json]`
 *
 * FIX-1049 — the supervised recovery path out of a no-progress STOP. When the
 * dead-loop breaker stops a goal (`no_progress_breaker` / `no_progress_on_all_cards`),
 * the persisted `progress` block traps the card: the next `roll loop go`
 * re-trips the breaker before the routed NEXT eligible Builder ever runs. This
 * command lets the supervisor (a human/agent on the loop), AFTER inspecting the
 * failure, explicitly clear the stall for ONE more attempt by a DIFFERENT
 * Builder — without hand-deleting `.roll/loop/goal.yaml` or editing private state.
 *
 * Default (no flags / observe): print the auditable stall facts — blocked card,
 * zero-delivery streak, last failed Builder, next eligible Builder, the bounded
 * handoff reference to inspect — and the exact command to retry. This is the
 * supervisor-facing observability surface (AC1) and a dry preview of the action.
 *
 * `--apply`: perform the recovery. ALLOWED only when a different eligible Builder
 * exists to rotate to; otherwise DENIED with a clear reason (AC: never a blind
 * retry of the failed Builder; clearly explained when no next Builder). Either
 * way it records a `goal:recovery` event stating who resumed, which Builder last
 * failed, which is selected next, and why — the breaker stays auditable and is
 * never silently bypassed.
 *
 * Resolves the project via ROLL_MAIN_PROJECT || cwd, mirroring the other
 * cycle-worktree-safe loop write commands.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventBus } from "@roll/core";
import {
  parseGoalYaml,
  renderGoalYaml,
  transitionGoal,
  type GoalTransitionActor,
  type RollEvent,
  type RollGoal,
} from "@roll/spec";
import {
  clearStallForRecovery,
  detectNoProgressStall,
  planNoProgressRecovery,
  type NoProgressStall,
  type RecoveryDecision,
} from "../lib/goal-recovery.js";
import { resolveScopedStoryExecute } from "../runner/scoped-route.js";

/** Side-effects the command injects (real by default; faked in tests). */
export interface RecoverDeps {
  /** Epoch-ms clock for the event timestamp. */
  now: () => number;
  /**
   * Resolve the next eligible Builder for the project, or undefined when no
   * Builder can be resolved (none installed / no scoped layer / unresolved).
   * Real impl: the scoped `story.execute` route's selected agent.
   */
  nextEligibleBuilder: (projectPath: string) => string | undefined;
}

export function realRecoverDeps(): RecoverDeps {
  return {
    now: () => Date.now(),
    nextEligibleBuilder: (projectPath) => {
      const route = resolveScopedStoryExecute(projectPath);
      if (route === null) return undefined;
      return route.resolution.ok ? route.resolution.resolved.agent : undefined;
    },
  };
}

interface ParsedArgs {
  storyId?: string;
  reason: string;
  actor: GoalTransitionActor;
  apply: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let storyId: string | undefined;
  let reason = "";
  let actor: GoalTransitionActor = "owner";
  let apply = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    if (a === "--apply") apply = true;
    else if (a === "--json") json = true;
    else if (a === "--reason") reason = (argv[++i] ?? "").trim();
    else if (a.startsWith("--reason=")) reason = a.slice("--reason=".length).trim();
    else if (a === "--actor") actor = normalizeActor(argv[++i]);
    else if (a.startsWith("--actor=")) actor = normalizeActor(a.slice("--actor=".length));
    else if (!a.startsWith("-")) storyId = a.trim();
  }
  return { ...(storyId !== undefined && storyId !== "" ? { storyId } : {}), reason, actor, apply, json };
}

function normalizeActor(raw: string | undefined): GoalTransitionActor {
  const v = (raw ?? "").trim();
  const allowed: GoalTransitionActor[] = ["owner", "system", "adjudicator", "worker", "agent"];
  return (allowed as string[]).includes(v) ? (v as GoalTransitionActor) : "owner";
}

function goalPath(projectPath: string): string {
  return join(projectPath, ".roll", "loop", "goal.yaml");
}

function eventsPath(projectPath: string): string {
  const rt = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim() || join(projectPath, ".roll", "loop");
  return join(rt, "events.ndjson");
}

function readGoal(path: string): RollGoal | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseGoalYaml(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeGoal(path: string, goal: RollGoal): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, renderGoalYaml(goal), "utf8");
  renameSync(tmp, path);
}

function readEvents(path: string): RollEvent[] {
  try {
    if (existsSync(path)) return new EventBus().readEvents(path);
  } catch {
    return [];
  }
  return [];
}

function fmtStall(stall: NoProgressStall, nextBuilder: string | undefined, storyHint: string | undefined): string {
  const streaks = Object.entries(stall.zeroStreaks);
  const streakLine =
    streaks.length === 0 ? "none recorded" : streaks.map(([id, n]) => `${id}=${n}`).join(", ");
  const lines = [
    "",
    "  Supervised recovery — no-progress stop",
    "",
    `    stopped by: ${stall.reason}`,
    `    blocked cards: ${stall.blockedCards.length === 0 ? "(none — whole-goal breaker)" : stall.blockedCards.join(", ")}`,
    `    zero-delivery streak: ${streakLine}`,
    `    whole-goal no-progress cycles: ${stall.noProgressCycles}`,
    `    last failed Builder: ${stall.lastBuilder ?? "(unknown)"}`,
    `    next eligible Builder: ${nextBuilder ?? "(none available)"}`,
  ];
  if (stall.handoff !== undefined) {
    lines.push(
      `    handoff: cycle ${stall.handoff.cycleId} — ${stall.handoff.detail}`,
      `      kind: ${stall.handoff.kind}`,
      `      worktree: ${stall.handoff.worktreePath}`,
      `      inspect: roll loop log ${stall.handoff.cycleId}`,
    );
  }
  const target = storyHint ?? stall.blockedCards[0];
  lines.push(
    "",
    `    to retry with the next Builder: roll loop recover ${target ?? "<story-id>"} --apply --reason "<why>"`,
    `    (then: roll loop go --cards ${target ?? "<story-id>"} --max-cycles 1)`,
    "",
  );
  return lines.join("\n") + "\n";
}

export function loopRecoverCommand(argv: string[], deps: RecoverDeps = realRecoverDeps()): number {
  const opts = parseArgs(argv);
  const projectPath = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
  const gPath = goalPath(projectPath);
  const goal = readGoal(gPath);
  const events = readEvents(eventsPath(projectPath));
  const stall = detectNoProgressStall(goal, events);

  if (stall === undefined) {
    const msg = "roll loop recover: no goal stopped by no-progress (nothing to recover)";
    if (opts.json) process.stdout.write(JSON.stringify({ recoverable: false, reason: msg }, null, 2) + "\n");
    else process.stdout.write(`\n  ${msg}\n\n`);
    return 0;
  }

  const nextBuilder = deps.nextEligibleBuilder(projectPath);

  // Observe / dry preview (no --apply): surface the auditable stall facts.
  if (!opts.apply) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { recoverable: true, stall, nextEligibleBuilder: nextBuilder ?? null, targetStoryId: opts.storyId ?? null },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(fmtStall(stall, nextBuilder, opts.storyId));
    }
    return 0;
  }

  const decision = planNoProgressRecovery({
    stall,
    ...(opts.storyId !== undefined ? { targetStoryId: opts.storyId } : {}),
    ...(nextBuilder !== undefined ? { nextEligibleBuilder: nextBuilder } : {}),
  });

  const reason = opts.reason !== "" ? opts.reason : "supervised recovery after no-progress stop";
  return opts.json
    ? applyDecisionJson(projectPath, gPath, goal!, stall, decision, opts.actor, reason, deps)
    : applyDecision(projectPath, gPath, goal!, stall, decision, opts.actor, reason, deps);
}

function recoveryEvent(
  decision: RecoveryDecision,
  stall: NoProgressStall,
  actor: GoalTransitionActor,
  reason: string,
  ts: number,
): Extract<RollEvent, { type: "goal:recovery" }> {
  return {
    type: "goal:recovery",
    decision: decision.decision,
    actor,
    ...(decision.storyId !== undefined ? { storyId: decision.storyId } : {}),
    reason: decision.decision === "denied" ? decision.reason : reason,
    ...(stall.lastBuilder !== undefined ? { lastBuilder: stall.lastBuilder } : {}),
    ...(decision.decision === "allowed" ? { nextBuilder: decision.nextBuilder } : {}),
    ...(decision.decision === "allowed" && decision.skippedBuilders.length > 0
      ? { skippedBuilders: [...decision.skippedBuilders] }
      : {}),
    noProgressCycles: stall.noProgressCycles,
    ...(stall.handoff !== undefined ? { handoff: { ...stall.handoff } } : {}),
    ts,
  };
}

function applyDecision(
  projectPath: string,
  gPath: string,
  goal: RollGoal,
  stall: NoProgressStall,
  decision: RecoveryDecision,
  actor: GoalTransitionActor,
  reason: string,
  deps: RecoverDeps,
): number {
  const ts = deps.now();
  const bus = new EventBus();

  if (decision.decision === "denied") {
    bus.appendEvent(eventsPath(projectPath), recoveryEvent(decision, stall, actor, reason, ts));
    process.stdout.write(`\n  roll loop recover: DENIED — ${decision.reason}\n  the no-progress breaker still holds; inspect the card or split/hold it.\n\n`);
    return 1;
  }

  // ALLOWED: clear the stall for ONE more attempt, re-activate, record the event.
  const at = new Date(ts).toISOString();
  const clearedProgress = clearStallForRecovery(goal.progress, decision.storyId);
  const reactivated = transitionGoal(goalAfterRecovery(goal, clearedProgress), "active", { actor, reason, at });
  const next: RollGoal = clearedProgress === undefined ? stripProgress(reactivated) : reactivated;
  writeGoal(gPath, next);
  bus.appendEvent(eventsPath(projectPath), recoveryEvent(decision, stall, actor, reason, ts));
  process.stdout.write(
    `\n  roll loop recover: ALLOWED — ${decision.storyId} re-armed for the next Builder\n` +
      `    last Builder: ${decision.lastBuilder ?? "(unknown)"} → next Builder: ${decision.nextBuilder}\n` +
      `    why: ${reason}\n` +
      `    next: roll loop go --cards ${decision.storyId} --max-cycles 1\n\n`,
  );
  return 0;
}

function applyDecisionJson(
  projectPath: string,
  gPath: string,
  goal: RollGoal,
  stall: NoProgressStall,
  decision: RecoveryDecision,
  actor: GoalTransitionActor,
  reason: string,
  deps: RecoverDeps,
): number {
  const ts = deps.now();
  const bus = new EventBus();
  const event = recoveryEvent(decision, stall, actor, reason, ts);

  if (decision.decision === "allowed") {
    const at = new Date(ts).toISOString();
    const clearedProgress = clearStallForRecovery(goal.progress, decision.storyId);
    const reactivated = transitionGoal(goalAfterRecovery(goal, clearedProgress), "active", { actor, reason, at });
    writeGoal(gPath, clearedProgress === undefined ? stripProgress(reactivated) : reactivated);
  }
  bus.appendEvent(eventsPath(projectPath), event);
  process.stdout.write(JSON.stringify({ decision: decision.decision, event }, null, 2) + "\n");
  return decision.decision === "allowed" ? 0 : 1;
}

function stripProgress(goal: RollGoal): RollGoal {
  const { progress: _drop, ...rest } = goal;
  return rest;
}

function goalAfterRecovery(goal: RollGoal, progress: RollGoal["progress"]): RollGoal {
  if (goal.safety?.lastGate !== "progress") return { ...goal, progress };
  const { safety: _resolvedProgressGate, ...rest } = goal;
  return { ...rest, progress };
}
