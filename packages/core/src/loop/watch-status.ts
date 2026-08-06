/**
 * @responsibility Projects watch status summaries with durable cycle lookup fallback.
 */
import { parseEventLine, type RollEvent } from "@roll/spec";
import { analyzeCycleActivity, type CycleActivityAnalysis } from "./cycle-activity.js";

/** FIX-382: durable cycle→story/agent lookup from runs.jsonl, used as fallback
 *  when the in-window events don't contain a cycle:start. */
export type DurableCycleLookup = Record<string, { storyId: string; agent: string }>;

export interface WatchStatusSummary {
  cycleId?: string;
  storyId?: string;
  agent?: string;
  phase?: string;
  tcrCount: number;
  lastSignal?: string;
  lastSignalAt?: number;
  acceptedScore?: { peer: string; score: number; verdict: string };
  attest?: { verdict: string; scoreReason?: string };
  lastPr?: { type: string; prNumber: number };
  outcome?: string;
  hasEnd: boolean;
  /** US-OBS-042: active / silent / ended classification derived from recent events. */
  classification?: CycleActivityAnalysis["classification"];
  /** US-OBS-042: parsed bounded micro-step plan, if emitted by the builder. */
  microStep?: CycleActivityAnalysis["microStep"];
  /** US-OBS-042: last detected test:red or test:green transition. */
  testTransition?: CycleActivityAnalysis["testTransition"];
  /** US-OBS-042: advisory green-without-commit state. */
  greenUncommitted?: CycleActivityAnalysis["greenUncommitted"];
  /** US-OBS-042: advisory oversized-action state. */
  oversizedAction?: CycleActivityAnalysis["oversizedAction"];
}

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function clean(input: string): string {
  return input.replace(ANSI_PATTERN, "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

function shortCycle(cycleId: string): string {
  return cycleId.length > 14 ? cycleId.slice(0, 14) : cycleId;
}

function shortHash(hash: string): string {
  return hash.slice(0, 9);
}

function signalLabel(ev: RollEvent): string | undefined {
  switch (ev.type) {
    case "cycle:start":
      return "cycle start";
    case "cycle:phase":
      return `phase ${ev.phase}`;
    case "cycle:stdout": {
      const data = clean(ev.data);
      return data.startsWith("heartbeat:") ? clean(data.replace(/^heartbeat:\s*/, "")) : undefined;
    }
    case "cycle:tcr":
      return `tcr ${shortHash(ev.commitHash)} ${clean(ev.message)}`;
    case "cycle:first_edit":
      return `first edit ${shortHash(ev.commitHash)}`;
    case "cycle:end":
      return `cycle ${ev.outcome}`;
    case "cycle:terminal":
      return `cycle ${ev.outcome}`;
    case "visual:gate":
      return `visual ${ev.verdict}`;
    case "evidence:frame-opened":
      return "evidence frame";
    case "peer:gate":
      return `peer ${ev.verdict}`;
    case "attest:gate":
      return `attest ${ev.verdict}`;
    case "pr:open":
    case "pr:merge":
      return `${ev.type} #${ev.prNumber}`;
    case "pr:close":
    case "pr:rebase":
      return `${ev.type} #${ev.prNumber}`;
    case "ci:pass":
    case "ci:fail":
    case "ci:rerun":
      return `${ev.type} #${ev.prNumber}`;
    case "alert:notify":
      return `alert ${clean(ev.message)}`;
    // ── FIX-934: pair:* signal labels ─────────────────────────────────────
    case "pair:selected": {
      // FIX-1054: show attempt/reason so a fallback selection is distinguishable
      // from the first ranked pick in the operator view.
      const tag = ev.attempt !== undefined && ev.attempt > 1 ? ` [attempt ${ev.attempt}${ev.reason !== undefined ? `: ${clean(ev.reason)}` : ""}]` : "";
      return `pair ${clean(ev.workingAgent)} → ${clean(ev.peer)} (${clean(ev.stage)})${tag}`;
    }
    // FIX-1054: serial-dispatch policy signals — skipped candidates are a POLICY
    // decision (a reviewer/scorer was accepted), and fan-out is an explicit,
    // bounded, reasoned escalation.
    case "pair:skipped":
      return `pair skipped ${ev.peers.map(clean).join(",")} (${clean(ev.reason)})`;
    case "pair:fanout":
      return `pair fanout ${clean(ev.stage)} ${clean(ev.reason)} limit=${ev.limit}`;
    case "pair:verdict":
      return `pair ${clean(ev.peer)} ${ev.verdict} (${ev.findings} finding${ev.findings === 1 ? "" : "s"})`;
    case "pair:score":
      return `pair ${clean(ev.peer)} ${ev.score} ${ev.verdict}`;
    case "pair:consult": {
      const durSec = (ev.durationMs / 1000).toFixed(1);
      const causeTag = ev.cause !== undefined ? ` (${ev.cause})` : "";
      return `pair ${clean(ev.peer)} ${ev.outcome} ${durSec}s${causeTag}`;
    }
    case "pair:none-available":
      return `pair ${clean(ev.stage)} none-available`;
    case "pair:score-failure":
      return `pair ${clean(ev.peer)} ${ev.cause}`;
    case "pair:excluded":
      return `pair ${clean(ev.agent)} excluded ${ev.cause} (${ev.failures})`;
    case "agent:retry":
      return `retry ${clean(ev.fromAgent)} → ${clean(ev.toAgent)} (${clean(ev.reason)})`;
    case "goal:gate_tripped":
      return `paused ${clean(ev.reason)} (${ev.gate})`;
    case "goal:state":
      return `goal ${clean(ev.to)} ${clean(ev.reason)}`;
    default:
      return undefined;
  }
}

function scoreReason(reasons: readonly string[]): string | undefined {
  return reasons.find((r) => /score/i.test(r));
}

export function summarizeWatchEvents(lines: readonly string[], durableLookup?: DurableCycleLookup, nowMs?: number): WatchStatusSummary | null {
  const summary: WatchStatusSummary = { tcrCount: 0, hasEnd: false };
  const events: RollEvent[] = [];
  let seen = false;
  const resetCycleScope = (cycleId: string): void => {
    if (summary.cycleId === cycleId) return;
    summary.cycleId = cycleId;
    summary.storyId = undefined;
    summary.agent = undefined;
    summary.phase = undefined;
    summary.tcrCount = 0;
    summary.outcome = undefined;
    summary.hasEnd = false;
    summary.acceptedScore = undefined;
    summary.attest = undefined;
    summary.lastPr = undefined;
  };
  for (const line of lines) {
    const ev = parseEventLine(line);
    if (ev === null) continue;
    events.push(ev);
    seen = true;
    if (ev.type === "cycle:start") {
      resetCycleScope(ev.cycleId);
      summary.storyId = ev.storyId;
      summary.agent = ev.agent;
    } else if (ev.type === "cycle:phase") {
      resetCycleScope(ev.cycleId);
      summary.phase = ev.phase;
    } else if (ev.type === "cycle:tcr") {
      resetCycleScope(ev.cycleId);
      summary.tcrCount += 1;
    } else if (ev.type === "cycle:end") {
      resetCycleScope(ev.cycleId);
      summary.outcome = ev.outcome;
      summary.hasEnd = true;
    } else if (ev.type === "cycle:terminal") {
      resetCycleScope(ev.cycleId);
      summary.storyId = ev.storyId;
      summary.agent = ev.agent;
      summary.outcome = ev.outcome;
      summary.hasEnd = true;
      summary.tcrCount = ev.tcr.present ? ev.tcr.value : 0;
    }

    if (ev.type === "pair:score") {
      summary.acceptedScore = { peer: ev.peer, score: ev.score, verdict: ev.verdict };
    } else if (ev.type === "attest:gate") {
      summary.attest = { verdict: ev.verdict, scoreReason: scoreReason(ev.reasons) };
    } else if (ev.type === "pr:open" || ev.type === "pr:merge" || ev.type === "pr:close" || ev.type === "pr:rebase") {
      summary.lastPr = { type: ev.type, prNumber: ev.prNumber };
    }

    // US-OBS-045: accepted evaluator score and attest gate are surfaced as
    // dedicated summary segments; don't let them overwrite the latest
    // non-accepted signal (e.g. a later pair:consult or pr:open).
    const label = signalLabel(ev);
    if (label !== undefined && ev.type !== "pair:score" && ev.type !== "attest:gate") {
      summary.lastSignal = label;
      summary.lastSignalAt = ev.ts;
    }
  }
  // FIX-382: when cycle:start is outside the event window, fall back to the
  // durable runs.jsonl lookup by cycleId to resolve storyId/agent.
  if (seen && summary.cycleId !== undefined) {
    if ((summary.storyId === undefined || summary.storyId === "") && durableLookup !== undefined) {
      const dur = durableLookup[summary.cycleId];
      if (dur !== undefined) summary.storyId = dur.storyId;
    }
    if ((summary.agent === undefined || summary.agent === "") && durableLookup !== undefined) {
      const dur = durableLookup[summary.cycleId];
      if (dur !== undefined) summary.agent = dur.agent;
    }
  }
  // US-OBS-042: enrich with the activity analyzer when a timestamp is supplied.
  if (seen && summary.cycleId !== undefined && nowMs !== undefined) {
    const analysis = analyzeCycleActivity(events, summary.cycleId, nowMs);
    summary.classification = analysis.classification;
    if (analysis.microStep !== undefined) summary.microStep = analysis.microStep;
    if (analysis.testTransition !== undefined) summary.testTransition = analysis.testTransition;
    if (analysis.greenUncommitted !== undefined) summary.greenUncommitted = analysis.greenUncommitted;
    if (analysis.oversizedAction !== undefined) summary.oversizedAction = analysis.oversizedAction;
  }
  return seen ? summary : null;
}

function toMs(ts: number): number {
  return ts > 9_999_999_999 ? ts : ts * 1000;
}

function quietText(summary: WatchStatusSummary, nowMs: number): string {
  if (summary.lastSignalAt === undefined) return "quiet unknown";
  const quietMs = Math.max(0, nowMs - toMs(summary.lastSignalAt));
  const min = Math.floor(quietMs / 60_000);
  if (min < 1) return "quiet <1m";
  return `quiet ${min}m`;
}

function prStateLabel(type: string): string {
  switch (type) {
    case "pr:open":
      return "open";
    case "pr:merge":
      return "merged";
    case "pr:close":
      return "closed";
    case "pr:rebase":
      return "rebase";
    default:
      return type;
  }
}

export function renderWatchStatusSummary(summary: WatchStatusSummary, nowMs: number): string {
  const cycle = summary.cycleId !== undefined ? `cycle ${shortCycle(summary.cycleId)}` : "cycle unknown";
  const story = summary.storyId !== undefined && summary.storyId !== "" ? summary.storyId : "story unknown";
  const agent = summary.agent !== undefined && summary.agent !== "" ? summary.agent : "agent unknown";
  const phase = summary.phase !== undefined ? `phase ${summary.phase}` : "phase unknown";
  const classification = summary.classification !== undefined ? summary.classification : summary.hasEnd ? "ended" : "active";
  const tcr = `${summary.tcrCount} TCR`;

  const parts: string[] = [`status  ${phase}`, classification, quietText(summary, nowMs), story, agent, cycle];

  if (summary.microStep !== undefined) {
    parts.push(`action ${summary.microStep.actionId} ${summary.microStep.summary}`);
  }
  if (summary.testTransition !== undefined) {
    parts.push(`test:${summary.testTransition.state}`);
  }

  parts.push(tcr);

  if (summary.greenUncommitted !== undefined) {
    const min = Math.floor(summary.greenUncommitted.durationSec / 60);
    const duration = min < 1 ? "<1m" : `${min}m`;
    parts.push(`green-uncommitted ${duration}`);
  }
  if (summary.oversizedAction !== undefined) {
    parts.push(
      `action oversized · ${summary.oversizedAction.filesTouched} files / ${summary.oversizedAction.contractAreas} areas`,
    );
  }

  if (summary.acceptedScore !== undefined) {
    parts.push(`score ${clean(summary.acceptedScore.peer)} ${summary.acceptedScore.score}/${summary.acceptedScore.verdict}`);
  }
  if (summary.attest !== undefined) {
    const attest = `attest ${summary.attest.verdict}`;
    parts.push(summary.attest.scoreReason !== undefined ? `${attest} · ${summary.attest.scoreReason}` : attest);
  }

  if (summary.lastSignal !== undefined) {
    parts.push(`last ${clean(summary.lastSignal)}`);
  }

  if (summary.hasEnd) {
    const outcome = `outcome ${summary.outcome ?? "unknown"}`;
    if (summary.lastPr !== undefined) {
      parts.push(`${outcome} · PR #${summary.lastPr.prNumber} ${prStateLabel(summary.lastPr.type)}`);
    } else {
      parts.push(outcome);
    }
  } else {
    parts.push("outcome unknown/no end event");
  }

  return parts.join(" · ");
}

export function renderWatchStatusFromEventLines(lines: readonly string[], nowMs: number, durableLookup?: DurableCycleLookup): string | null {
  const summary = summarizeWatchEvents(lines, durableLookup, nowMs);
  return summary === null ? null : renderWatchStatusSummary(summary, nowMs);
}

// ════════════════════════════════════════════════════════════════════════════
// US-OBS-044 — narrated story transition blocks in live loop watch.
// ════════════════════════════════════════════════════════════════════════════

/** Optional context for richer story handoffs. All resolvers are pure lookups;
 *  when a fact is missing the renderer degrades to an explicit unavailable reason. */
export interface StoryTransitionContext {
  /** One-line backlog description or spec summary for a story id. */
  storyBrief?: (storyId: string) => string | undefined;
  /** Selected Builder + route reason for the new story. */
  routeReason?: (storyId: string) => { agent: string; reason: string } | undefined;
  /** Concise expected action list, if one has been planned. */
  actionPlan?: (storyId: string) => string | undefined;
}

/** A real transition is when the active cycle or story changed. The first status
 *  snapshot (no previous) never prints a transition block. */
export function shouldRenderStoryTransition(
  previous: WatchStatusSummary | null | undefined,
  current: WatchStatusSummary,
): boolean {
  if (previous === null || previous === undefined) return false;
  if (current.cycleId !== undefined && previous.cycleId !== current.cycleId) return true;
  if (current.storyId !== undefined && previous.storyId !== current.storyId) return true;
  return false;
}

const TRANSITION_WIDTH = 56;

function transitionFrame(): string {
  return "─".repeat(TRANSITION_WIDTH);
}

function previousTransitionLine(previous: WatchStatusSummary): string {
  const parts: string[] = [];
  if (previous.storyId !== undefined && previous.storyId !== "") {
    parts.push(previous.storyId);
  }
  if (previous.hasEnd) {
    parts.push(previous.outcome ?? "unknown");
  } else {
    parts.push("no end event recorded");
  }
  parts.push(`${previous.tcrCount} TCR`);
  if (previous.agent !== undefined && previous.agent !== "") {
    parts.push(`builder ${previous.agent}`);
  }
  if (previous.lastPr !== undefined) {
    parts.push(`PR #${previous.lastPr.prNumber} ${prStateLabel(previous.lastPr.type)}`);
  }
  return `  previous: ${parts.join(" · ")}`;
}

function nextTransitionLine(current: WatchStatusSummary, ctx?: StoryTransitionContext): string {
  if (current.storyId === undefined || current.storyId === "") {
    const outcome = current.hasEnd ? current.outcome ?? "unknown" : "no active story";
    return `  next:     no runnable work · ${outcome}`;
  }
  const story = current.storyId !== undefined && current.storyId !== "" ? current.storyId : "story unknown";
  const brief =
    current.storyId !== undefined && current.storyId !== ""
      ? (ctx?.storyBrief?.(current.storyId) ?? "brief unavailable")
      : "brief unavailable";
  return `  next:     ${story} · ${brief}`;
}

function builderTransitionLine(current: WatchStatusSummary, ctx?: StoryTransitionContext): string {
  if (current.storyId === undefined || current.storyId === "") {
    return "  builder:  none · no story/agent selected";
  }
  const route =
    current.storyId !== undefined && current.storyId !== ""
      ? ctx?.routeReason?.(current.storyId)
      : undefined;
  if (route !== undefined) {
    return `  builder:  ${route.agent} · selected by ${route.reason}`;
  }
  const agent = current.agent !== undefined && current.agent !== "" ? current.agent : "agent unknown";
  return `  builder:  ${agent} · route reason unavailable`;
}

function planTransitionLine(current: WatchStatusSummary, ctx?: StoryTransitionContext): string {
  const plan =
    current.storyId !== undefined && current.storyId !== ""
      ? (ctx?.actionPlan?.(current.storyId) ?? "pending")
      : "pending";
  return `  plan:     ${plan}`;
}

/** Render a visually separated transition block, or `null` when there is no
 *  real story/cycle change. Missing facts degrade to explicit unavailable reasons
 *  rather than guesses. */
export function renderStoryTransition(
  previous: WatchStatusSummary,
  current: WatchStatusSummary,
  ctx?: StoryTransitionContext,
): string | null {
  if (!shouldRenderStoryTransition(previous, current)) return null;
  const frame = transitionFrame();
  return [
    frame,
    "↳ story transition",
    previousTransitionLine(previous),
    nextTransitionLine(current, ctx),
    builderTransitionLine(current, ctx),
    planTransitionLine(current, ctx),
    frame,
  ].join("\n");
}
