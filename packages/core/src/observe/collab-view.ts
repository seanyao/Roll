/**
 * @responsibility Derives handoff, escalation and supervisor stance from one cycle's facts.
 * US-OBS-038 — Collab projection base (collab-view.v1).
 *
 * Derives handoffs, escalations, and supervisor stance from a single cycle's
 * CycleRoleSummary plus the raw RollEvent stream.  This is a pure projection;
 * it never writes events and never guesses when data is missing.
 */

import {
  type CollabCycleView,
  type CollabEscalation,
  type CollabHandoff,
  type CollabStreamView,
  type CollabTerminus,
  type CycleRoleSummary,
  type EventSource,
  type RollEvent,
  type SupervisorStance,
} from "@roll/spec";

// ── Public API ───────────────────────────────────────────────────────────────

export function projectCollabCycle(
  summary: CycleRoleSummary,
  events: readonly RollEvent[],
  supervisorAgent = "codex",
): CollabCycleView {
  const cycleId = summary.cycleId;
  const storyId = summary.storyId;
  const cycleEvents = events.filter((e) => {
    if ("cycleId" in e && (e as { cycleId: string }).cycleId === cycleId) return true;
    // story:split is a planning event tied to a parent story, not a cycle.
    if (e.type === "story:split" && (e as { parentStoryId: string }).parentStoryId === storyId) {
      return true;
    }
    return false;
  });

  const cast = buildCast(summary, supervisorAgent);
  const handoffs: CollabHandoff[] = [];
  let escalation: CollabEscalation | undefined;
  let stance: SupervisorStance | undefined;
  let terminus: CollabTerminus = "";

  // Split detected anywhere in the stream → terminus=split, stance=plan.
  const splitEvent = cycleEvents.find((e) => e.type === "story:split") as
    | {
        type: "story:split";
        parentStoryId: string;
        childStoryIds: string[];
        reason: string;
        ts: number;
      }
    | undefined;

  // Assign handoff: execution:profile + cycle:start.
  const startEvent = cycleEvents.find((e) => e.type === "cycle:start") as
    | { type: "cycle:start"; storyId: string; agent: string; ts: number }
    | undefined;

  if (startEvent) {
    handoffs.push({
      fromRole: "supervise",
      toRole: "build",
      agent: startEvent.agent,
      atMs: startEvent.ts,
      kind: "assign",
    });
  }

  // Build handoff: fold cycle:first_edit / cycle:tcr into a single build bar.
  const tcrCount = cycleEvents.filter((e) => e.type === "cycle:tcr").length;
  const firstEdit = cycleEvents.find((e) => e.type === "cycle:first_edit") as
    | { type: "cycle:first_edit"; ts: number }
    | undefined;
  const firstTcr = cycleEvents.find((e) => e.type === "cycle:tcr") as
    | { type: "cycle:tcr"; ts: number }
    | undefined;
  if (firstEdit || firstTcr) {
    handoffs.push({
      fromRole: "build",
      toRole: "build",
      agent: cast.build ?? null,
      atMs: firstTcr?.ts ?? firstEdit!.ts,
      kind: "build",
      folded: tcrCount || 1,
    });
  }

  // Review handoff: pair:*(code) + peer:gate verdict.
  const peerGateEvent = cycleEvents.find((e) => e.type === "peer:gate") as
    | { type: "peer:gate"; verdict: string; ts: number }
    | undefined;
  const lastReviewVerdict = cycleEvents
    .filter((e) => e.type === "pair:verdict" && isReviewStage((e as { stage?: string }).stage))
    .sort((a, b) => a.ts - b.ts)
    .at(-1) as
    | { type: "pair:verdict"; peer: string; verdict: string; ts: number }
    | undefined;

  if (peerGateEvent && lastReviewVerdict) {
    handoffs.push({
      fromRole: "build",
      toRole: "review",
      agent: lastReviewVerdict.peer,
      atMs: peerGateEvent.ts,
      kind: "review",
      verdict: `${lastReviewVerdict.verdict}`,
    });
  }

  // Score handoff: pair:*(score) + pair:score.
  const acceptedScore = cycleEvents
    .filter((e) => e.type === "pair:score")
    .sort((a, b) => a.ts - b.ts)
    .at(-1) as
    | { type: "pair:score"; peer: string; verdict: string; score: number; ts: number }
    | undefined;

  if (acceptedScore) {
    handoffs.push({
      fromRole: "review",
      toRole: "score",
      agent: acceptedScore.peer,
      atMs: acceptedScore.ts,
      kind: "score",
      verdict: `${acceptedScore.verdict}/${acceptedScore.score}`,
    });
  }

  // Gate handoff: attest:gate (+ cycle:terminal).
  const attestGateEvent = cycleEvents.find((e) => e.type === "attest:gate") as
    | { type: "attest:gate"; verdict: string; ts: number }
    | undefined;
  const terminalEvent = cycleEvents.find((e) => e.type === "cycle:terminal") as
    | { type: "cycle:terminal"; outcome: string; ts: number }
    | undefined;

  if (attestGateEvent) {
    handoffs.push({
      fromRole: "score",
      toRole: "gate",
      agent: null,
      atMs: attestGateEvent.ts,
      kind: "gate",
      verdict: attestGateEvent.verdict,
    });
  }

  // Escalation derivation.
  const stallEvent = cycleEvents.find((e) => e.type === "agent:stall") as
    | { type: "agent:stall"; agent: string; idleSec: number; ts: number }
    | undefined;
  const endEvent = cycleEvents.find((e) => e.type === "cycle:end") as
    | { type: "cycle:end"; outcome: string; ts: number }
    | undefined;
  const gateTrippedEvent = cycleEvents.find((e) => e.type === "goal:gate_tripped") as
    | { type: "goal:gate_tripped"; gate: string; action: string; reason: string; ts: number }
    | undefined;

  const hasEscalation =
    stallEvent !== undefined ||
    (endEvent !== undefined && isTerminalEscalation(endEvent.outcome)) ||
    gateTrippedEvent !== undefined;

  const hasSupervisorFix =
    cast.build !== undefined && cast.build === supervisorAgent && (firstEdit !== undefined || firstTcr !== undefined);

  const hasWalkedFull = attestGateEvent !== undefined && terminalEvent !== undefined;

  if (hasEscalation) {
    escalation = deriveEscalation({
      stallEvent,
      endEvent,
      gateTrippedEvent,
      cast,
      supervisorAgent,
    });
    terminus = "escalated";
  } else if (hasSupervisorFix) {
    terminus = "supervisor_fix";
    stance = { level: "build", note: "supervisor took over as builder" };
  } else if (splitEvent) {
    terminus = "split";
    stance = { level: "plan", note: splitEvent.reason };
  } else if (hasWalkedFull) {
    terminus = "walked_full";
  }

  // Stance defaults when not otherwise set.
  if (!stance) {
    stance = { level: "supervise" };
  }

  return {
    schema: "collab-view.v1",
    cycleId,
    storyId: summary.storyId,
    startedAtMs: startEvent?.ts ?? 0,
    cast,
    handoffs,
    escalation,
    terminus,
    stance,
  };
}

export function projectCollabStream(
  cycleIds: readonly string[],
  src: EventSource,
): CollabStreamView {
  const allEvents = src.readEvents();
  const supervisor = src.supervisor?.() ?? "codex";
  const goalScope = src.goalScope?.() ?? "unknown";

  const cycles = cycleIds.map((cycleId) => {
    let summary = src.readSummary(cycleId);
    if (!summary) {
      summary = src.rebuildSummary(cycleId);
    }
    if (!summary) {
      return missingCycleView(cycleId);
    }
    return projectCollabCycle(summary, allEvents, supervisor);
  });

  return {
    schema: "collab-stream.v1",
    goalScope,
    supervisor,
    cycles,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildCast(summary: CycleRoleSummary, supervisorAgent: string): CollabCycleView["cast"] {
  const builder = summary.roles.find((r) => r.role === "builder");
  const peerReviewers = uniqueStrings(
    summary.roles
      .filter((r) => r.role === "peer_reviewer" && r.agent && r.state !== "failed")
      .map((r) => r.agent!),
  );
  const acceptedScorer = summary.roles.find(
    (r) => r.role === "evaluator" && r.state === "accepted" && r.agent,
  );

  return {
    supervise: supervisorAgent,
    build: builder?.agent ?? undefined,
    peers: peerReviewers,
    scorer: acceptedScorer?.agent ?? undefined,
  };
}

function isReviewStage(stage: string | undefined): boolean {
  return stage === undefined || stage === "review" || stage === "code";
}

function isTerminalEscalation(outcome: string): boolean {
  return outcome === "aborted" || outcome === "gave_up";
}

interface DeriveEscalationInput {
  stallEvent?: { type: "agent:stall"; agent: string; idleSec: number; ts: number };
  endEvent?: { type: "cycle:end"; outcome: string; ts: number };
  gateTrippedEvent?: { type: "goal:gate_tripped"; gate: string; action: string; reason: string; ts: number };
  cast: CollabCycleView["cast"];
  supervisorAgent: string;
}

function deriveEscalation(input: DeriveEscalationInput): CollabEscalation {
  const { stallEvent, endEvent, gateTrippedEvent, cast, supervisorAgent } = input;

  // Priority: explicit gate trip > stall > terminal outcome.
  if (gateTrippedEvent) {
    return {
      fromRole: currentRole(cast),
      atMs: gateTrippedEvent.ts,
      trigger: "gate_tripped",
      supervisorAction: gateTrippedEvent.action === "paused" ? "park" : "diagnose",
      inferred: true,
      detail: gateTrippedEvent.reason,
    };
  }

  if (stallEvent) {
    return {
      fromRole: "build",
      atMs: stallEvent.ts,
      trigger: "stall",
      supervisorAction: cast.build === supervisorAgent ? "self_build" : "reroute",
      inferred: true,
      detail: `${stallEvent.agent} stalled for ${stallEvent.idleSec}s`,
    };
  }

  const outcome = endEvent!.outcome;
  const trigger: CollabEscalation["trigger"] = outcome === "aborted" ? "aborted" : "gave_up";
  return {
    fromRole: currentRole(cast),
    atMs: endEvent!.ts,
    trigger,
    supervisorAction: "diagnose",
    inferred: true,
    detail: `cycle ended with outcome=${outcome}`,
  };
}

function currentRole(cast: CollabCycleView["cast"]): string {
  if (cast.scorer) return "score";
  if (cast.peers.length > 0) return "review";
  if (cast.build) return "build";
  return "supervise";
}

function missingCycleView(cycleId: string): CollabCycleView {
  return {
    schema: "collab-view.v1",
    cycleId,
    storyId: "unknown",
    startedAtMs: 0,
    cast: { supervise: "unknown", peers: [] },
    handoffs: [],
    terminus: "",
    stance: { level: "supervise", note: "协同摘要不可用" },
  };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
