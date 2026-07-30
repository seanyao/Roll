import {
  correctionCircuitVerdict,
  parsePolicy,
  serializeEvent,
  type CorrectionCircuitVerdict,
  type LoopSafetyConfig,
} from "@roll/core";
import { parseEventLine, type RollEvent } from "@roll/spec";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyCorrectionFailure, playbookForFailure } from "./failure-attribution.js";

export type CorrectionCircuitApplyResult =
  | { status: "continue" }
  | { status: "already_tripped"; verdict: Exclude<CorrectionCircuitVerdict, { action: "continue" }> }
  | { status: "paused"; pauseWritten: boolean; verdict: Exclude<CorrectionCircuitVerdict, { action: "continue" }> };

function readLoopSafety(projectPath: string): LoopSafetyConfig {
  try {
    const path = join(projectPath, ".roll", "policy.yaml");
    if (!existsSync(path)) return parsePolicy("").loopSafety;
    return parsePolicy(readFileSync(path, "utf8")).loopSafety;
  } catch {
    return parsePolicy("").loopSafety;
  }
}

function readEvents(eventsPath: string): RollEvent[] {
  try {
    return readFileSync(eventsPath, "utf8")
      .split("\n")
      .map(parseEventLine)
      .filter((ev): ev is RollEvent => ev !== null);
  } catch {
    return [];
  }
}

function alreadyTripped(events: readonly RollEvent[], verdict: Exclude<CorrectionCircuitVerdict, { action: "continue" }>): boolean {
  return events.some(
    (ev) =>
      ev.type === "correction:circuit_breaker" &&
      ev.signal === verdict.signal &&
      ev.threshold === verdict.threshold &&
      (ev.storyId ?? "") === (verdict.storyId ?? ""),
  );
}

function appendEvent(eventsPath: string, event: RollEvent): void {
  mkdirSync(dirname(eventsPath), { recursive: true });
  // FIX-1490: go through serializeEvent so `ts` lands on the epoch-ms contract.
  // This writer used to JSON.stringify directly with a SECONDS clock, which is
  // one of the three paths that bypassed the bus and produced seconds on disk.
  appendFileSync(eventsPath, serializeEvent(event), "utf8");
}

export function applyCorrectionCircuitBreaker(
  projectPath: string,
  slug: string,
  eventsPath: string,
  alertsPath: string,
  nowSec = Math.floor(Date.now() / 1000),
): CorrectionCircuitApplyResult {
  const safety = readLoopSafety(projectPath);
  const events = readEvents(eventsPath);
  const verdict = correctionCircuitVerdict(events, safety, nowSec);
  if (verdict.action === "continue") return { status: "continue" };
  if (alreadyTripped(events, verdict)) return { status: "already_tripped", verdict };

  const failure = classifyCorrectionFailure(verdict.signal);
  const playbook = playbookForFailure(failure.failureClass, failure.rootCauseKey);
  const pauseMarker = join(projectPath, ".roll", "loop", `PAUSE-${slug}`);
  const pauseWritten = !existsSync(pauseMarker);
  const alertMsg =
    `# ALERT — correction circuit breaker tripped\n\n` +
    `**Reason**: ${verdict.reason}\n` +
    `**Signal**: ${verdict.signal}\n` +
    `**Failure class**: ${failure.failureClass}\n` +
    `**Root cause**: ${failure.rootCauseKey}\n` +
    `**Count**: ${verdict.count}/${verdict.threshold}\n` +
    (verdict.storyId !== undefined ? `**Story**: ${verdict.storyId}\n` : "") +
    `**Playbook**: ${playbook}\n` +
    `**Action**: loop paused to prevent unattended correction oscillation. Resume manually with \`roll loop resume\`.\n`;
  try {
    mkdirSync(dirname(pauseMarker), { recursive: true });
    if (pauseWritten) writeFileSync(pauseMarker, alertMsg, "utf8");
    mkdirSync(dirname(alertsPath), { recursive: true });
    appendFileSync(alertsPath, `${alertMsg}\n`, "utf8");
    appendEvent(eventsPath, {
      type: "correction:circuit_breaker",
      ...(verdict.storyId !== undefined ? { storyId: verdict.storyId } : {}),
      signal: verdict.signal,
      count: verdict.count,
      threshold: verdict.threshold,
      reason: verdict.reason,
      failureClass: failure.failureClass,
      rootCauseKey: failure.rootCauseKey,
      ts: nowSec,
    });
    appendEvent(eventsPath, { type: "policy:safety_pause", loop: "ci", reason: verdict.reason, ts: nowSec });
    appendEvent(eventsPath, { type: "alert:notify", channel: "correction-circuit", message: verdict.reason, ts: nowSec });
  } catch {
    /* best-effort safety signal; caller still gets the decision */
  }
  return { status: "paused", pauseWritten, verdict };
}
