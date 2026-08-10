/**
 * @responsibility Maps correction signals to conservative or auto actuator actions.
 */
import type { RollEvent } from "@roll/spec";

export type CorrectionActuatorMode = "conservative" | "auto";
export type CorrectionAction = "alert_only" | "open_fix" | "return_story" | "route_adjust";

export interface CorrectionAttribution {
  source: "attest:gate" | "acceptance-report" | "review-score" | "ci" | "unknown";
  layer: "acceptance" | "retrospective" | "ci" | "unknown";
  summary: string;
  evidence: string[];
}

export interface CorrectionDecisionInput {
  storyId: string;
  cycleId?: string;
  reasons: readonly string[];
  mode: CorrectionActuatorMode;
  events?: readonly RollEvent[];
}

export interface CorrectionDecision {
  mode: CorrectionActuatorMode;
  action: CorrectionAction;
  plannedAction: CorrectionAction;
  storyId: string;
  cycleId?: string;
  signal: string;
  reason: string;
  source: CorrectionAttribution["source"];
  attribution: CorrectionAttribution;
  priorCorrections: number;
  /** FIX-386: remaining fix-forward retries before escalating. Present only when
   *  the signal supports bounded retry (review_score_regression). Absent ⇒ no
   *  retry budget applies (default signal path). */
  retryBudget?: number;
}

function compact(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function reasonText(reasons: readonly string[]): string {
  const text = compact(reasons.filter((r) => r.trim() !== "").join("; "));
  return text === "" ? "correction comparator failed without a reason" : text;
}

function classifyAttribution(storyId: string, reasons: readonly string[]): {
  signal: string;
  plannedAction: CorrectionAction;
  attribution: CorrectionAttribution;
} {
  const text = reasonText(reasons);
  const lower = text.toLowerCase();
  // FIX-386: match both "review-score regression" (regression verdict) and
  // "low review-score ok" (low-score ok verdict with partial + Discrepancy).
  if (/review[-\s]?score.*(?:regression|low|partial)/.test(lower)) {
    return {
      signal: "review_score_regression",
      // FIX-386: low review score → return_story so the story is re-pickable.
      // The executor injects reviewer findings into the agent context on resume,
      // and bounded retry (below) caps fix-forward cycles before escalating.
      plannedAction: "return_story",
      attribution: {
        source: "review-score",
        layer: "retrospective",
        summary: text,
        evidence: ["events.ndjson", "attest:gate skipped", `.roll/features/<epic>/${storyId}/notes/`],
      },
    };
  }
  if (/empty[-\s]?shell|no ac content|no ac-map|without ac-map/.test(lower)) {
    return {
      signal: "empty_acceptance_report",
      plannedAction: "open_fix",
      attribution: {
        source: "acceptance-report",
        layer: "acceptance",
        summary: text,
        evidence: [
          "events.ndjson",
          "attest:gate skipped",
          `.roll/features/<epic>/${storyId}/latest/${storyId}-report.html`,
          "ac-map.json",
        ],
      },
    };
  }
  if (/no fresh acceptance report|without a fresh acceptance report|missing acceptance report/.test(lower)) {
    return {
      signal: "missing_acceptance_report",
      plannedAction: "open_fix",
      attribution: {
        source: "attest:gate",
        layer: "acceptance",
        summary: text,
        evidence: [
          "events.ndjson",
          "attest:gate skipped",
          `.roll/features/<epic>/${storyId}/latest/${storyId}-report.html`,
          "ac-map.json",
        ],
      },
    };
  }
  if (/\bci\b.*fail|check.*fail|red ci/.test(lower)) {
    return {
      signal: "ci_failed",
      plannedAction: "open_fix",
      attribution: {
        source: "ci",
        layer: "ci",
        summary: text,
        evidence: ["events.ndjson: ci:fail", "runs.jsonl: cycle row"],
      },
    };
  }
  // FIX-1261: deterministic failure envelope — classify attest-gate skip reasons
  // that were previously collapsed to unknown_failure. Each has clear event evidence.
  if (/deliverable_cmd.*非白名单|deliverable_cmd.*outside.*allowlist/.test(lower)) {
    return {
      signal: "card:deliverable_cmd_denied",
      plannedAction: "open_fix",
      attribution: {
        source: "attest:gate",
        layer: "acceptance",
        summary: text,
        evidence: ["events.ndjson", "attest:gate skipped", "deliverable_cmd allowlist check"],
      },
    };
  }
  if (/surface capture missing|not all really captured|lack screenshot evidence|physical_terminal.*no.*capture/.test(lower)) {
    return {
      signal: "card:surface_not_captured",
      plannedAction: "open_fix",
      attribution: {
        source: "attest:gate",
        layer: "acceptance",
        summary: text,
        evidence: ["events.ndjson", "attest:gate skipped", "screenshot capture check"],
      },
    };
  }
  if (/attest render failed/.test(lower)) {
    return {
      signal: "card:ac_evidence_unmergeable",
      plannedAction: "open_fix",
      attribution: {
        source: "attest:gate",
        layer: "acceptance",
        summary: text,
        evidence: ["events.ndjson", "attest:gate skipped", "attest render exit code"],
      },
    };
  }
  return {
    signal: "unknown_failure",
    plannedAction: "alert_only",
    attribution: {
      source: "unknown",
      layer: "unknown",
      summary: text,
      evidence: ["events.ndjson"],
    },
  };
}

function priorCorrectionCount(events: readonly RollEvent[], storyId: string, signal: string): number {
  let n = 0;
  for (const ev of events) {
    if (ev.type !== "correction:action") continue;
    if (ev.storyId !== storyId) continue;
    if (ev.signal !== signal) continue;
    n += 1;
  }
  return n;
}

/** FIX-386: max fix-forward retries for a low review score before escalating.
 *  1 retry means: first low score → return_story (retry 1); second low score
 *  → escalate (route_adjust + Hold). */
const MAX_REVIEW_SCORE_RETRIES = 1;

export function decideCorrectionAction(input: CorrectionDecisionInput): CorrectionDecision {
  const classified = classifyAttribution(input.storyId, input.reasons);
  const priorCorrections = priorCorrectionCount(input.events ?? [], input.storyId, classified.signal);
  let plannedAction: CorrectionAction;
  let retryBudget: number | undefined;

  // FIX-386: review_score_regression has its own bounded-retry budget.
  // Allow up to MAX_REVIEW_SCORE_RETRIES retries; after that, escalate.
  if (classified.signal === "review_score_regression") {
    if (priorCorrections <= MAX_REVIEW_SCORE_RETRIES) {
      plannedAction = "return_story";
      retryBudget = MAX_REVIEW_SCORE_RETRIES - priorCorrections;
    } else {
      plannedAction = "route_adjust";
      retryBudget = 0;
    }
  } else {
    plannedAction =
      priorCorrections > 0 && classified.plannedAction !== "alert_only"
        ? "route_adjust"
        : classified.plannedAction;
    // FIX-332: a repeated empty-shell acceptance report for the same story means the
    // resume-evidence bridge (or the agent) failed to produce content twice. Stop
    // minting endless autofix cards and return the story to Todo so the loop's
    // cross-session dead-loop breaker can pause the goal instead of burning cycles.
    if (priorCorrections > 0 && classified.signal === "empty_acceptance_report") {
      plannedAction = "return_story";
    }
  }

  const action = input.mode === "conservative" ? "alert_only" : plannedAction;
  return {
    mode: input.mode,
    action,
    plannedAction,
    storyId: input.storyId,
    ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
    signal: classified.signal,
    reason: classified.attribution.summary,
    source: classified.attribution.source,
    attribution: classified.attribution,
    priorCorrections,
    ...(retryBudget !== undefined ? { retryBudget } : {}),
  };
}
