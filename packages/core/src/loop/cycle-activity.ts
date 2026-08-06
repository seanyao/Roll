/**
 * @responsibility Analyzes cycle activity segments from the event stream.
 */
import type { RollEvent, CycleActivityEvent } from "@roll/spec";
import type { ActivityKind, ActivitySignal, Segment } from "./activity-signal.js";
import { signalKindForMarker } from "./signals.js";
import { extractCycleSignals, type TimelineEntry } from "./transcript.js";

function toMs(ts: number): number {
  return ts >= 1e12 ? ts : ts * 1000;
}

function segmentForMarker(marker: string): Segment {
  if (marker === "cycle:start") return "cycle";
  if (marker === "cycle:end") return "end";
  if (marker.startsWith("phase:") || marker === "tcr" || marker === "first-edit" || marker === "build:heartbeat") return "build";
  if (marker.startsWith("peer") || marker.startsWith("pair:")) return "peer";
  if (marker.startsWith("ci:") || marker === "attest:gate" || marker === "visual:gate" || marker === "evidence:frame-opened") return "ci";
  if (marker.startsWith("pr:")) return "pr";
  if (marker === "alert") return "end";
  return "cycle";
}

function kindForMarker(marker: string): ActivityKind {
  if (marker === "tcr") return "tcr";
  if (marker === "build:heartbeat") return "heartbeat";
  if (marker.startsWith("pr:")) return "pr";
  if (marker.startsWith("ci:") || marker.endsWith(":gate") || marker.startsWith("pair:") || marker === "evidence:frame-opened") return "gate";
  if (marker === "alert") return "alert";
  return "lifecycle";
}

function resultForMarker(marker: string): ActivitySignal["result"] | undefined {
  if (marker.endsWith(":pass") || marker === "pr:merge") return "pass";
  if (marker.endsWith(":fail") || marker === "pr:close" || marker === "alert") return "fail";
  if (marker === "peer:gate" || marker === "attest:gate" || marker === "visual:gate") return "pending";
  if (marker === "pr:open" || marker === "pr:rebase") return "pending";
  return undefined;
}

function refForEntry(entry: TimelineEntry): string | undefined {
  const pr = /PR #(\d+)/.exec(entry.label);
  if (pr?.[1] !== undefined) return `#${pr[1]}`;
  const tcr = /^TCR\s+([0-9a-f]+)/i.exec(entry.label);
  if (tcr?.[1] !== undefined) return tcr[1];
  return undefined;
}

function timelineEntryToActivitySignal(cycleId: string, entry: TimelineEntry): ActivitySignal {
  const signalKind = signalKindForMarker(entry.marker) ?? undefined;
  return {
    ts: toMs(entry.ts),
    cycleId,
    seg: segmentForMarker(entry.marker),
    kind: kindForMarker(entry.marker),
    tier: entry.layer === "signal" ? "A" : "B",
    summary: entry.label,
    ...(resultForMarker(entry.marker) !== undefined ? { result: resultForMarker(entry.marker) } : {}),
    ...(refForEntry(entry) !== undefined ? { ref: refForEntry(entry) } : {}),
    ...(signalKind !== undefined ? { signalKind } : {}),
  };
}

export function cycleActivitySignalsFromEvents(events: RollEvent[], cycleId: string): ActivitySignal[] {
  return extractCycleSignals(events, cycleId).timeline.map((entry) => timelineEntryToActivitySignal(cycleId, entry));
}

// ════════════════════════════════════════════════════════════════════════════
// US-OBS-026 — standard CycleActivityEvent projection from durable events.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Pure projection: {@link RollEvent}[] → {@link CycleActivityEvent}[].
 *
 * AGENT-AGNOSTIC — uses ONLY the durable facts in events.ndjson (the runner's
 * own observations: cycle:phase, cycle:first_edit, cycle:tcr, cycle:stdout,
 * cycle:end, ci:*, pr:*, peer:gate, attest:gate, visual:gate). Does NOT
 * depend on any per-agent normalizer; claude / codex / kimi / pi / any future
 * agent all produce the same standard events.
 *
 * Events are filtered to the given `cycleId`; events without a `cycleId`
 * (pr:*, ci:*) are scoped by the caller. Unknown / malformed / torn events
 * are skipped without throwing — the stream is always rebuildable (I8).
 *
 * The output is a chronological, deterministic list; the same input always
 * produces the same output regardless of host locale or clock.
 */
export function cycleActivityFromEvents(
  events: readonly RollEvent[],
  cycleId: string,
): CycleActivityEvent[] {
  const out: CycleActivityEvent[] = [];

  // First pass: find the agent from cycle:start (so CI/PR events that don't
  // carry a cycleId still get the right agent regardless of input order).
  let agent = "";
  for (const ev of events) {
    if (ev.type === "cycle:start" && ev.cycleId === cycleId) {
      agent = ev.agent;
      break;
    }
  }

  for (const ev of events) {
    // Filter: keep events matching this cycleId, plus cycleId-less events
    // (pr:*, ci:*) that the caller has pre-scoped.
    if ("cycleId" in ev && typeof (ev as { cycleId?: unknown }).cycleId === "string") {
      if ((ev as { cycleId: string }).cycleId !== cycleId) continue;
    }

    // Cycle start.
    if (ev.type === "cycle:start") {
      out.push({
        kind: "lifecycle",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          event: "cycle:start",
          detail: ev.storyId !== "" ? ev.storyId : undefined,
        },
      });
      continue;
    }

    // Phase transitions.
    if (ev.type === "cycle:phase") {
      out.push({
        kind: "phase",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: { phase: ev.phase },
      });
      continue;
    }

    // TCR commits (the runner's observation).
    if (ev.type === "cycle:tcr") {
      out.push({
        kind: "tcr",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          commitHash: ev.commitHash,
          message: ev.message,
          ...(ev.commitTs !== undefined ? { commitTs: ev.commitTs } : {}),
          firstEdit: false,
        },
      });
      continue;
    }

    // First edit marker (cycle:first_edit).
    if (ev.type === "cycle:first_edit") {
      out.push({
        kind: "tcr",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          commitHash: ev.commitHash,
          message: "first edit",
          firstEdit: true,
        },
      });
      continue;
    }

    // Stdout lines (including heartbeats).
    if (ev.type === "cycle:stdout") {
      out.push({
        kind: "stdout",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: { data: ev.data },
      });
      continue;
    }

    // US-OBS-042: durable TCR rhythm facts for post-cycle evidence and watch.
    if (ev.type === "action:started") {
      out.push({
        kind: "state_change",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          from: "micro-step",
          to: "action:started",
          reason: `${ev.actionId} ${ev.summary} · evidence: ${ev.expectedEvidence} · scope: ${ev.fileAreaScope.join(", ")}`,
        },
      });
      continue;
    }
    if (ev.type === "test:red" || ev.type === "test:green") {
      out.push({
        kind: "state_change",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          from: ev.actionId ?? "action",
          to: ev.type,
          reason: ev.summary ?? ev.source,
        },
      });
      continue;
    }
    if (ev.type === "green-uncommitted") {
      out.push({
        kind: "state_change",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          from: ev.actionId ?? "action",
          to: "green-uncommitted",
          reason: `${ev.durationSec}s without TCR commit`,
        },
      });
      continue;
    }
    if (ev.type === "action:oversized") {
      out.push({
        kind: "state_change",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          from: ev.actionId ?? "action",
          to: "action:oversized",
          reason: `${ev.filesTouched} files / ${ev.contractAreas} areas`,
        },
      });
      continue;
    }

    // Cycle end.
    if (ev.type === "cycle:end") {
      out.push({
        kind: "lifecycle",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          event: "cycle:end",
          detail: ev.outcome,
        },
      });
      continue;
    }

    // Gate events.
    if (ev.type === "ci:pass") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: { gate: "ci", verdict: "pass", ref: `#${ev.prNumber}` },
      });
      continue;
    }
    if (ev.type === "ci:fail") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          gate: "ci",
          verdict: "fail",
          detail: ev.failSummary || undefined,
          ref: `#${ev.prNumber}`,
        },
      });
      continue;
    }
    if (ev.type === "ci:rerun") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: { gate: "ci", verdict: "rerun", ref: `#${ev.prNumber}` },
      });
      continue;
    }
    if (ev.type === "peer:gate") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          gate: "peer",
          verdict: ev.verdict,
          detail: ev.reasons.length > 0 ? ev.reasons.join("; ") : undefined,
        },
      });
      continue;
    }
    if (ev.type === "attest:gate") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          gate: "attest",
          verdict: ev.verdict,
          detail: ev.reasons.length > 0 ? ev.reasons.join("; ") : undefined,
        },
      });
      continue;
    }
    if (ev.type === "visual:gate") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: {
          gate: "visual",
          verdict: ev.verdict,
          detail: ev.code !== undefined ? ev.code : undefined,
          ...(ev.reasons !== undefined && ev.reasons.length > 0 ? { detail: ev.reasons.join("; ") } : {}),
        },
      });
      continue;
    }
    if (ev.type === "evidence:frame-opened") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: { gate: "evidence", verdict: "opened", detail: ev.runDir },
      });
      continue;
    }

    // PR events.
    if (ev.type === "pr:open") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: { gate: "pr", verdict: "open", ref: `#${ev.prNumber}` },
      });
      continue;
    }
    if (ev.type === "pr:merge") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: { gate: "pr", verdict: "merged", ref: `#${ev.prNumber}` },
      });
      continue;
    }
    if (ev.type === "pr:close") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: { gate: "pr", verdict: "closed", detail: ev.reason || undefined },
      });
      continue;
    }
    if (ev.type === "pr:rebase") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: { gate: "pr", verdict: "rebase", ref: `#${ev.prNumber}` },
      });
      continue;
    }

    // Alert events.
    if (ev.type === "alert:notify") {
      out.push({
        kind: "gate",
        cycle_id: cycleId,
        ts: ev.ts,
        agent,
        payload: { gate: "alert", verdict: "notify", detail: ev.message },
      });
      continue;
    }

    // State change: routing resolution.
    if (ev.type === "route:resolve") {
      out.push({
        kind: "state_change",
        cycle_id: cycleId,
        ts: ev.ts,
        agent: ev.agent,
        payload: {
          from: "picking",
          to: "routed",
          reason: `${ev.agent} ← ${ev.rule}`,
        },
      });
      continue;
    }

    // All other event types are skipped (loop:*, policy:*, goal:*, story:split,
    // pair:*, correction:*, etc.) — they are not part of the per-cycle activity
    // standard projection.
  }

  // Sort chronologically by ts, preserving original order for same-ts events.
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// US-OBS-042 — observable and gated TCR micro-step rhythm.
// ════════════════════════════════════════════════════════════════════════════

/** Default no-progress threshold (seconds). Mirrors CYCLE_NO_PROGRESS_SEC. */
export const DEFAULT_NO_PROGRESS_SEC = 900;

/** Default oversized-action thresholds. */
export const DEFAULT_OVERSIZED_THRESHOLDS = {
  files: 10,
  areas: 3,
};

/** Discovered bounded micro-step plan. */
export interface MicroStepPlan {
  /** Action identifier (e.g. "A1"). */
  actionId: string;
  /** Short description of what the action does. */
  summary: string;
  /** Expected evidence the action must produce. */
  expectedEvidence: string;
  /** File-area scope the action promised to touch. */
  fileAreaScope: string[];
}

/** Last detected test boundary transition. */
export interface TestTransition {
  state: "red" | "green";
  /** Epoch ms when the transition was observed. */
  at: number;
  /** Short source string for diagnostics. */
  source: string;
}

/** Advisory: tests went green but no TCR commit has landed yet. */
export interface GreenUncommittedState {
  /** Epoch ms when the green boundary was observed. */
  since: number;
  /** Seconds from green boundary to analysis time. */
  durationSec: number;
}

/** Advisory: a single action has grown beyond its declared scope. */
export interface OversizedActionState {
  filesTouched: number;
  contractAreas: number;
  thresholdFiles: number;
  thresholdAreas: number;
}

export interface FollowupDraft {
  title: string;
  sourceCycleId: string;
  sourceActionId?: string;
  reason: string;
  deferredScope: string;
  deliveredByCurrentCard: false;
}

export interface QueuedFollowup {
  id?: string;
  actionId?: string;
  title: string;
  reason: string;
}

export interface ActionSplitSuggestion {
  actionId?: string;
  advisory: true;
  effect: "advisory-only";
  reason: string;
  safeBoundary: string;
  followupDraft: FollowupDraft;
  ignoredSuggestionCount: number;
  evaluatorContext?: string;
}

export interface CycleActivityHistoryEntry {
  type: "action:started" | "test:red" | "test:green" | "green-uncommitted" | "action:oversized" | "split:suggested" | "followup:queued" | "cycle:tcr" | "sandbox:write_protected" | "sandbox:quarantined";
  at: number;
  actionId?: string;
  summary?: string;
}

export interface SandboxActivity {
  type: "write_protected" | "quarantined";
  at: number;
  summary: string;
}

/** Result of {@link analyzeCycleActivity}. Pure: derived from events + optional diff. */
export interface CycleActivityAnalysis {
  cycleId: string;
  /** active = recent stdout/signals/commits/test transitions; silent = nothing recent; ended = cycle terminal event seen. */
  classification: "active" | "silent" | "ended";
  /** Seconds since the last observed activity. */
  quietSec: number;
  /** Count of cycle:tcr events observed. */
  tcrCount: number;
  /** Epoch ms of the last observed activity. */
  lastActivityAt: number;
  /** Parsed bounded micro-step plan, if any. */
  microStep?: MicroStepPlan;
  /** Last detected test transition, if any. */
  testTransition?: TestTransition;
  /** Advisory green-without-commit state. */
  greenUncommitted?: GreenUncommittedState;
  /** Advisory oversized-action state. */
  oversizedAction?: OversizedActionState;
  /** Advisory dynamic split checkpoint for expanded action scope. */
  splitSuggestion?: ActionSplitSuggestion;
  /** Follow-up backlog card/action references accepted from a split suggestion. */
  queuedFollowups?: QueuedFollowup[];
  /** Main-checkout isolation/quarantine events visible to supervisor activity. */
  sandboxEvents?: SandboxActivity[];
  /** Durable rhythm history for post-cycle evaluator evidence. */
  history: CycleActivityHistoryEntry[];
}

/** Worktree diff snapshot supplied by the runner for oversized-action detection. */
export interface WorktreeDiffSnapshot {
  /** Relative paths changed since baseline. */
  files: readonly string[];
  /** Abstract contract/area tags (e.g. "parser", "ledger", "cli"). */
  areas: readonly string[];
  /** Epoch ms when the changed snapshot was observed. */
  changedAt?: number;
}

function isTerminal(ev: RollEvent): boolean {
  return ev.type === "cycle:end" || ev.type === "cycle:terminal";
}

function isActivityEvent(ev: RollEvent, cycleId: string): boolean {
  // Only facts scoped to this exact cycle count as builder activity. Global PR,
  // CI, alert, loop, or goal bookkeeping can be recent without proving that the
  // active builder made progress.
  if (ev.type.startsWith("loop:") || ev.type.startsWith("goal:")) return false;
  const id = (ev as { cycleId?: unknown }).cycleId;
  return typeof id === "string" && id === cycleId;
}

function parseMicroStepPlan(data: string): MicroStepPlan | undefined {
  // Explicit micro-step: "micro-step: A1 summary · evidence: ... · scope: a, b"
  let m = /(?:^|\b)micro-step\s*[:：]\s*(A\d+)\s+(.+?)(?:\s*·|\s*\|\s*evidence|\s*evidence)/i.exec(data);
  if (m) {
    const actionId = m[1]!;
    const rest = data.slice(m.index + m[0].length).replace(/^[：:\s]+/, "");
    const evidence = /evidence\s*[:：]\s*([^·|]+)/i.exec(data)?.[1]?.trim() ?? "";
    const scopeMatch = /scope\s*[:：]\s*([^·|]+)/i.exec(data);
    const fileAreaScope = scopeMatch !== undefined && scopeMatch !== null
      ? scopeMatch[1]!.split(/[,，;；]/).map((s) => s.trim()).filter((s) => s !== "")
      : [];
    return { actionId, summary: m[2]!.trim(), expectedEvidence: evidence, fileAreaScope };
  }
  // Fallback: "action A1: ..." or "action A1 summary ..."
  m = /(?:^|\b)action\s+(A\d+)(?:\s*[:：]\s*|\s+)(.+?)(?:\s*·|\s*\|\s*evidence|\s*evidence|$)/i.exec(data);
  if (m) {
    const actionId = m[1]!;
    const evidence = /evidence\s*[:：]\s*([^·|]+)/i.exec(data)?.[1]?.trim() ?? "";
    const scopeMatch = /scope\s*[:：]\s*([^·|]+)/i.exec(data);
    const fileAreaScope = scopeMatch !== undefined && scopeMatch !== null
      ? scopeMatch[1]!.split(/[,，;；]/).map((s) => s.trim()).filter((s) => s !== "")
      : [];
    return { actionId, summary: m[2]!.trim(), expectedEvidence: evidence, fileAreaScope };
  }
  return undefined;
}

function parseTestTransition(data: string, ts: number): TestTransition | undefined {
  const d = data.toLowerCase();
  // Explicit markers first.
  if (/\btest\s*[:：]\s*red\b/i.test(data)) return { state: "red", at: ts, source: "test:red" };
  if (/\btest\s*[:：]\s*green\b/i.test(data)) return { state: "green", at: ts, source: "test:green" };
  // Vitest / jest failure line: " FAIL  path".
  if (/\sFAIL\s+\S+/.test(data)) return { state: "red", at: ts, source: "vitest:fail" };
  // Vitest / jest pass line: leading checkmark / "PASS".
  if (/^\s*[✓✔✅]\s+\S+/.test(data) || /\bPASS\s+\S+/.test(data)) return { state: "green", at: ts, source: "vitest:pass" };
  // npm-style aggregate: "Tests: 1 failed" vs "Tests: 1 passed".
  if (/\btests?\b.*\b\d+\s+fail/.test(d)) return { state: "red", at: ts, source: "npm:fail" };
  if (/\btests?\b.*\b\d+\s+pass/.test(d)) return { state: "green", at: ts, source: "npm:pass" };
  return undefined;
}

function lastActivityAt(events: readonly RollEvent[], cycleId: string): number {
  let last = 0;
  for (const ev of events) {
    if (!isActivityEvent(ev, cycleId)) continue;
    if (ev.ts > last) last = ev.ts;
  }
  return last;
}

/**
 * Pure analyzer for US-OBS-042. Given a cycle's durable events and (optionally)
 * a worktree diff snapshot, produces the supervisor-facing activity state:
 *
 *   - active vs silent classification (0 TCR alone is NOT silent);
 *   - bounded micro-step plan parsed from stdout;
 *   - last test:red / test:green transition;
 *   - advisory green-uncommitted state;
 *   - advisory oversized-action state.
 *
 * The function is deterministic and agent-agnostic: it consumes only the
 * standard RollEvent stream the runner writes for every agent.
 */
export function analyzeCycleActivity(
  events: readonly RollEvent[],
  cycleId: string,
  nowMs: number,
  opts?: {
    noProgressSec?: number;
    worktreeDiff?: WorktreeDiffSnapshot;
    oversizedThresholds?: { files: number; areas: number };
    activitySignals?: readonly ActivitySignal[];
  },
): CycleActivityAnalysis {
  const noProgressSec = opts?.noProgressSec ?? DEFAULT_NO_PROGRESS_SEC;
  const thresholds = opts?.oversizedThresholds ?? DEFAULT_OVERSIZED_THRESHOLDS;

  let classification: CycleActivityAnalysis["classification"] = "silent";
  let tcrCount = 0;
  let microStep: MicroStepPlan | undefined;
  let testTransition: TestTransition | undefined;
  let lastGreenAt: number | undefined;
  let oversizedAction: OversizedActionState | undefined;
  let oversizedActionId: string | undefined;
  const history: CycleActivityHistoryEntry[] = [];
  const queuedFollowups: QueuedFollowup[] = [];
  const sandboxEvents: SandboxActivity[] = [];
  let splitSuggestedCount = 0;

  const hasEnd = events.some((ev) => isTerminal(ev) && (ev as { cycleId?: string }).cycleId === cycleId);

  for (const ev of events) {
    if ((ev as { cycleId?: string }).cycleId !== cycleId) continue;
    if (ev.type === "cycle:tcr") tcrCount += 1;
    if (ev.type === "cycle:tcr") {
      history.push({ type: "cycle:tcr", at: ev.ts, summary: ev.message });
    }
    if (ev.type === "cycle:stdout") {
      const data = ev.data;
      const plan = parseMicroStepPlan(data);
      if (plan !== undefined) microStep = plan;
      const tt = parseTestTransition(data, ev.ts);
      if (tt !== undefined) {
        testTransition = tt;
        if (tt.state === "green") lastGreenAt = tt.at;
      }
    }
    if (ev.type === "action:started") {
      microStep = {
        actionId: ev.actionId,
        summary: ev.summary,
        expectedEvidence: ev.expectedEvidence,
        fileAreaScope: ev.fileAreaScope,
      };
      history.push({ type: "action:started", at: ev.ts, actionId: ev.actionId, summary: ev.summary });
    } else if (ev.type === "test:red" || ev.type === "test:green") {
      const state = ev.type === "test:red" ? "red" : "green";
      testTransition = { state, at: ev.ts, source: ev.source };
      if (state === "green") lastGreenAt = ev.ts;
      history.push({ type: ev.type, at: ev.ts, ...(ev.actionId !== undefined ? { actionId: ev.actionId } : {}), ...(ev.summary !== undefined ? { summary: ev.summary } : {}) });
    } else if (ev.type === "green-uncommitted") {
      lastGreenAt = ev.since;
      history.push({ type: "green-uncommitted", at: ev.ts, ...(ev.actionId !== undefined ? { actionId: ev.actionId } : {}), summary: `${ev.durationSec}s` });
    } else if (ev.type === "action:oversized") {
      oversizedAction = {
        filesTouched: ev.filesTouched,
        contractAreas: ev.contractAreas,
        thresholdFiles: ev.thresholdFiles,
        thresholdAreas: ev.thresholdAreas,
      };
      oversizedActionId = ev.actionId;
      history.push({ type: "action:oversized", at: ev.ts, ...(ev.actionId !== undefined ? { actionId: ev.actionId } : {}), summary: `${ev.filesTouched} files / ${ev.contractAreas} areas` });
    } else if (ev.type === "split:suggested") {
      splitSuggestedCount += 1;
      history.push({ type: "split:suggested", at: ev.ts, ...(ev.actionId !== undefined ? { actionId: ev.actionId } : {}), summary: ev.reason });
    } else if (ev.type === "followup:queued") {
      queuedFollowups.push({
        ...(ev.followupId !== undefined ? { id: ev.followupId } : {}),
        ...(ev.actionId !== undefined ? { actionId: ev.actionId } : {}),
        title: ev.title,
        reason: ev.reason,
      });
      history.push({ type: "followup:queued", at: ev.ts, ...(ev.actionId !== undefined ? { actionId: ev.actionId } : {}), summary: ev.title });
    } else if (ev.type === "sandbox:write_protected") {
      const summary = `${ev.status} · ${ev.paths} path${ev.paths === 1 ? "" : "s"}`;
      sandboxEvents.push({ type: "write_protected", at: ev.ts, summary });
      history.push({ type: "sandbox:write_protected", at: ev.ts, summary });
    } else if (ev.type === "sandbox:quarantined") {
      const summary = `${ev.phase} · ${ev.reason} · ${ev.ref}`;
      sandboxEvents.push({ type: "quarantined", at: ev.ts, summary });
      history.push({ type: "sandbox:quarantined", at: ev.ts, summary });
    }
  }

  let lastAct = lastActivityAt(events, cycleId);
  for (const sig of opts?.activitySignals ?? []) {
    if (sig.cycleId === cycleId && sig.ts > lastAct) lastAct = sig.ts;
  }
  const diffChangedAt = opts?.worktreeDiff?.changedAt;
  if (diffChangedAt !== undefined && opts?.worktreeDiff !== undefined && opts.worktreeDiff.files.length > 0 && diffChangedAt > lastAct) {
    lastAct = diffChangedAt;
  }
  const quietSec = lastAct > 0 ? Math.max(0, Math.floor((nowMs - lastAct) / 1000)) : Math.floor(nowMs / 1000);

  if (hasEnd) {
    classification = "ended";
  } else if (lastAct > 0 && quietSec < noProgressSec) {
    classification = "active";
  } else if (events.some((ev) => (ev as { cycleId?: string }).cycleId === cycleId)) {
    // There were events, but nothing recent — silent hang.
    classification = "silent";
  }

  let greenUncommitted: GreenUncommittedState | undefined;
  if (
    testTransition?.state === "green" &&
    lastGreenAt !== undefined &&
    (tcrCount === 0 || events.every((ev) => ev.type !== "cycle:tcr" || ev.ts <= lastGreenAt))
  ) {
    greenUncommitted = { since: lastGreenAt, durationSec: Math.max(0, Math.floor((nowMs - lastGreenAt) / 1000)) };
  }

  const diff = opts?.worktreeDiff;
  if (diff !== undefined && microStep !== undefined) {
    const filesOver = diff.files.length > thresholds.files;
    const areasOver = diff.areas.length > thresholds.areas;
    if (filesOver || areasOver) {
      oversizedAction = {
        filesTouched: diff.files.length,
        contractAreas: diff.areas.length,
        thresholdFiles: thresholds.files,
        thresholdAreas: thresholds.areas,
      };
      oversizedActionId = microStep.actionId;
    }
  }

  let splitSuggestion: ActionSplitSuggestion | undefined;
  if (oversizedAction !== undefined) {
    const actionId = oversizedActionId ?? microStep?.actionId;
    const reason = `${oversizedAction.filesTouched} files / ${oversizedAction.contractAreas} areas exceeds ${oversizedAction.thresholdFiles} files / ${oversizedAction.thresholdAreas} areas`;
    const safeBoundary =
      greenUncommitted !== undefined
        ? "commit current green work, then continue or split discovered follow-up"
        : "continue to the next green boundary, then commit or split discovered follow-up";
    const ignoredSuggestionCount = Math.max(0, history.filter((h) => h.type === "action:oversized").length - splitSuggestedCount);
    const hasLargeTcrAfterExpansion = events.some((ev) => ev.type === "cycle:tcr" && ev.ts > Math.max(...history.filter((h) => h.type === "action:oversized").map((h) => h.at), 0));
    splitSuggestion = {
      ...(actionId !== undefined ? { actionId } : {}),
      advisory: true,
      effect: "advisory-only",
      reason,
      safeBoundary,
      followupDraft: {
        title: `Follow up ${actionId ?? "action"} expanded scope`,
        sourceCycleId: cycleId,
        ...(actionId !== undefined ? { sourceActionId: actionId } : {}),
        reason,
        deferredScope: "expanded file-area, contract-area, duration, or test-surface scope",
        deliveredByCurrentCard: false,
      },
      ignoredSuggestionCount,
      ...(hasLargeTcrAfterExpansion ? { evaluatorContext: "expansion history includes a large single TCR after split suggestion" } : {}),
    };
  }

  return {
    cycleId,
    classification,
    quietSec,
    tcrCount,
    lastActivityAt: lastAct,
    ...(microStep !== undefined ? { microStep } : {}),
    ...(testTransition !== undefined ? { testTransition } : {}),
    ...(greenUncommitted !== undefined ? { greenUncommitted } : {}),
    ...(oversizedAction !== undefined ? { oversizedAction } : {}),
    ...(splitSuggestion !== undefined ? { splitSuggestion } : {}),
    ...(queuedFollowups.length > 0 ? { queuedFollowups } : {}),
    ...(sandboxEvents.length > 0 ? { sandboxEvents } : {}),
    history,
  };
}
