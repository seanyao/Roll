/**
 * @responsibility Runs the `roll loop runner-readout` subcommand, reading the runner version readout.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventBus, projectCycleHandoff, projectHandoffCapacity, type HandoffCapacity } from "@roll/core";
import { CYCLE_HANDOFF_EVENT_TYPES, t, v3Catalog, type Lang } from "@roll/spec";
import { isRollPackageName } from "@roll/core";
import { isOlderThan } from "../runner/binary-staleness.js";
import { rollVersion } from "./version.js";

export interface LoopControlRunnerReadout {
  bin: string;
  runningVersion: string;
  projectVersion: string;
  projectNewer: boolean;
}

export function rollBin(): string {
  return (process.env["ROLL_BIN"] ?? "").trim() || process.argv[1] || "roll";
}

export function loopControlRunnerReadout(projectPath: string): LoopControlRunnerReadout {
  const runningVersion = rollVersion() || "unknown";
  const projectVersion = projectRollPackageVersion(projectPath);
  return {
    bin: rollBin(),
    runningVersion,
    projectVersion,
    projectNewer: projectVersion !== "" && isOlderThan(runningVersion, projectVersion),
  };
}

export function staleLoopRunnerMessage(command: string, readout: LoopControlRunnerReadout): string {
  return (
    `${command}: runner_stale_for_repo — running v${readout.runningVersion}, repo-local roll is v${readout.projectVersion}. ` +
    "Install/publish the repo-local build before starting autonomous work.\n"
  );
}

// ── US-CYCLE-013 — cycle-handoff/v1 compatibility gate + status projection ───

/** The project's durable event stream (`<project>/.roll/loop/events.ndjson`). */
export function projectEventsPath(projectPath: string): string {
  return join(projectPath, ".roll", "loop", "events.ndjson");
}

/** Does the project's event stream carry ANY cycle-handoff/v1 events? */
export function projectHasCycleHandoffEvents(projectPath: string): boolean {
  try {
    return new EventBus()
      .readEvents(projectEventsPath(projectPath))
      .some((ev) => (CYCLE_HANDOFF_EVENT_TYPES as readonly string[]).includes(ev.type));
  } catch {
    return false;
  }
}

/**
 * US-CYCLE-013 — old-reader gate: when the RUNNING roll refuses the v1 handoff
 * path (ROLL_CYCLE_HANDOFF_V1 unset/≠1) but the project's events carry
 * cycle-handoff/v1 facts, an affected cycle must be reported `upgrade_required`
 * and refused — never run/recovered as a serial duplicate. Returns the affected
 * cycle ids (empty ⇒ the stream is safe for the serial reader).
 */
export function handoffUpgradeRequired(projectPath: string): { required: boolean; cycleIds: string[] } {
  const events = new EventBus().readEvents(projectEventsPath(projectPath));
  const cycleIds = [...new Set(
    events
      .filter((ev) => (CYCLE_HANDOFF_EVENT_TYPES as readonly string[]).includes(ev.type))
      .map((ev) => {
        if ("identity" in ev && ev.identity !== undefined && typeof ev.identity.cycleId === "string") return ev.identity.cycleId;
        if ("cycleId" in ev && typeof ev.cycleId === "string") return ev.cycleId;
        if ("requestedByCycleId" in ev && typeof ev.requestedByCycleId === "string") return ev.requestedByCycleId;
        return "";
      })
      .filter((id) => id !== ""),
  )];
  return { required: cycleIds.length > 0, cycleIds };
}

/** The user-facing `upgrade_required` line (bilingual via the v3 catalog). */
export function handoffUpgradeMessage(lang: Lang): string {
  return t(v3Catalog, lang, "handoff.upgrade_required");
}

/**
 * US-CYCLE-013 §8 — render the CLI truth projection for `roll loop go` /
 * run-once output: the literal handoff states (never inferred from publish /
 * merge-wait / reconcile / cleanup phases), the ready holder ABOVE the queue,
 * and the queue rows with queuePosition/queueSequence/reason/next action. A
 * ready holder is never rendered as a queue member.
 */
export function renderHandoffStatus(eventsPath: string, lang: Lang): string[] {
  const events = new EventBus().readEvents(eventsPath);
  const capacity = projectHandoffCapacity(events);
  const lines: string[] = [];
  const stateLine = (cycleId: string): string => {
    const view = projectCycleHandoff(events, cycleId);
    if (view === undefined) return "";
    const identity = view.identity;
    const workspace = identity?.workspace.members[0]?.workspaceKey ?? "";
    const fence = identity?.fence ?? "";
    switch (view.state) {
      case "building":
        return `${t(v3Catalog, lang, "handoff.state.building")} — Builder owns ${workspace} / ${fence}`;
      case "builder_validated_waiting_for_tail":
        return `${t(v3Catalog, lang, "handoff.state.ready_tail_full")} — committed head retained; wait for current tail ${capacity.tailCycleId ?? "?"} or recover`;
      case "waiting_for_evaluation_or_test":
      case "evaluating_or_testing":
      case "publish_or_merge_wait":
        return `${t(v3Catalog, lang, "handoff.state.waiting_tail")} — owns the tail; evaluator may start (${cycleId} / ${workspace} / ${fence})`;
      case "serial_recovery":
        return `${t(v3Catalog, lang, "handoff.state.serial_recovery")} — ${view.recoveryReason ?? "unknown"}; explicit next action; no automatic deletion`;
      case "terminal":
        return `terminal — ${view.terminal ?? "cleaned"}`;
    }
  };
  if (capacity.tailCycleId !== undefined) lines.push(`tail: ${stateLine(capacity.tailCycleId)}`);
  if (capacity.readyHolderCycleId !== undefined) lines.push(`ready: ${stateLine(capacity.readyHolderCycleId)}`);
  else if (capacity.buildHolderCycleId !== undefined) lines.push(`build: ${stateLine(capacity.buildHolderCycleId)}`);
  capacity.queue.forEach((entry, index) => {
    lines.push(
      `queue[${index + 1}] seq=${entry.queueSequence} ${entry.storyId} (${entry.cycleId}) — ${t(v3Catalog, lang, "handoff.queue.awaiting_capacity")} (${entry.reason}); next: admit when a slot frees`,
    );
  });
  for (const blocked of capacity.blockedCycleIds) {
    lines.push(`blocked: ${stateLine(blocked)}`);
  }
  return lines;
}

function projectRollPackageVersion(projectPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    // US-INSTALL-007: either published name is roll.
    if (typeof pkg.name !== "string" || !isRollPackageName(pkg.name)) return "";
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}
