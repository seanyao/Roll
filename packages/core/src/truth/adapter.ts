/**
 * @responsibility Adapts persisted fact rows into truth selectors as the one read path.
 * US-TRUTH-004 — the ONE adapter between persisted fact rows and the truth
 * selectors (US-TRUTH-003). dashboard / status / dossier consume THESE
 * functions instead of each re-parsing runs rows with their own literals —
 * the per-consumer guessing is exactly what drifted (FIX-248's 0-vs-14,
 * the dossier's triple-check, the agents line's `built`-only success).
 *
 * Contract (AC5): any NEW consumer of cycle/story/evidence facts goes through
 * this module; adding a parallel parser is the regression this epic closes.
 * The adapter is read-side only — it never writes (selectors are not a
 * fact source).
 */
import type { AuditPrEvidence } from "../consistency/audit.js";
import {
  deriveCycleTruth,
  deriveEvidenceTruth,
  deriveStoryTruth,
  type CycleTruth,
  type EvidenceTruth,
  type StoryTruth,
  type TruthState,
} from "./selectors.js";
import type { StoryDeliveryTruth } from "./query.js";
import {
  TERMINAL_SCHEMA_EPOCH_SEC,
  type BrowserOperationEvent,
  type BrowserOperationsTimeline,
  type BrowserOperationsTruth,
  type BrowserTimelineRow,
  type CaptureBridgeLink,
  type TerminalOutcome,
} from "@roll/spec";

/** US-TRUTH-001 schema epoch — single home in @roll/spec (terminal.ts). */
export const TRUTH_SCHEMA_EPOCH_SEC = TERMINAL_SCHEMA_EPOCH_SEC;

/** Grace for read-side convergence judgments (anchor default). */
const GRACE_SEC = 3600;

/** A lenient runs row — the adapter owns the field-name knowledge. */
export type TruthRunRow = Record<string, unknown>;
export type DeliveryGateDiagnosticKind = "ci_red_after_merge";

export interface DeliveryGateDiagnostic {
  kind: DeliveryGateDiagnosticKind;
  cycleId: string;
  storyId: string;
  prUrl?: string;
  ciRunUrl?: string;
}

function str(row: TruthRunRow, k: string): string {
  const v = row[k];
  return typeof v === "string" ? v : "";
}

function tsSec(row: TruthRunRow): number | null {
  const ts = str(row, "ts");
  if (ts === "") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * Derive one cycle's truth from its runs row (+ optionally the cycle's
 * terminal-twin outcome from the event stream). No GitHub probes here — the
 * interactive panel must not fan out; merge corrections arrive via the
 * backfill (FIX-243) and surface as `hasMergeStamp`.
 */
export function cycleTruthFromRow(
  row: TruthRunRow,
  opts: { terminalOutcome?: TerminalOutcome; branchEvidence?: AuditPrEvidence; nowSec: number },
): CycleTruth {
  return deriveCycleTruth({
    cycleId: str(row, "cycle_id") !== "" ? str(row, "cycle_id") : str(row, "run_id"),
    runStatus: str(row, "status"),
    runOutcome: str(row, "outcome"),
    hasMergeStamp: str(row, "merge_commit") !== "",
    hasCost: typeof row["cost_usd"] === "number",
    ...(opts.terminalOutcome !== undefined ? { terminalOutcome: opts.terminalOutcome } : {}),
    ...(opts.branchEvidence !== undefined ? { branchEvidence: opts.branchEvidence } : {}),
    tsSec: tsSec(row),
    nowSec: opts.nowSec,
    graceSec: GRACE_SEC,
    schemaEpochSec: TRUTH_SCHEMA_EPOCH_SEC,
  });
}

/** Did this runs row really deliver? The selector-backed replacement for the
 *  open-coded `status==="done"||"merged"||outcome==="delivered"` triple-check
 *  (story-dossier, morning report, …). */
export function rowDelivered(row: TruthRunRow, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  const t = cycleTruthFromRow(row, { nowSec });
  return t.outcome === "delivered" || t.outcome === "published_pending_merge";
}

function rowList(rows: Record<string, TruthRunRow> | Iterable<TruthRunRow>): TruthRunRow[] {
  return Symbol.iterator in Object(rows) ? [...(rows as Iterable<TruthRunRow>)] : Object.values(rows as Record<string, TruthRunRow>);
}

function gateKind(outcome: CycleTruth["outcome"]): DeliveryGateDiagnosticKind | null {
  return outcome === "ci_red_after_merge" ? outcome : null;
}

export function deliveryGateDiagnosticsFromRows(
  rows: Record<string, TruthRunRow> | Iterable<TruthRunRow>,
  opts: { nowSec?: number; maxAgeSec?: number; limit?: number } = {},
): DeliveryGateDiagnostic[] {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAgeSec = opts.maxAgeSec ?? 86_400;
  const limit = opts.limit ?? 3;
  const out: DeliveryGateDiagnostic[] = [];
  for (const row of rowList(rows)) {
    const rowTs = tsSec(row);
    if (rowTs !== null && nowSec - rowTs > maxAgeSec) continue;
    const truth = cycleTruthFromRow(row, { nowSec });
    const kind = gateKind(truth.outcome);
    if (kind === null) continue;
    const cycleId = str(row, "cycle_id") || str(row, "run_id") || truth.cycleId;
    const storyId = str(row, "story_id") || str(row, "storyId") || cycleId;
    const diagnostic: DeliveryGateDiagnostic = { kind, cycleId, storyId };
    const prUrl = str(row, "pr_url") || str(row, "prUrl");
    const ciRunUrl = str(row, "ci_run_url") || str(row, "ciRunUrl");
    if (prUrl !== "") diagnostic.prUrl = prUrl;
    if (ciRunUrl !== "") diagnostic.ciRunUrl = ciRunUrl;
    out.push(diagnostic);
    if (out.length >= limit) break;
  }
  return out;
}

/** Story truth for presentation consumers. The caller owns evidence gathering;
 *  absence stays unknown/grandfathered per the selector, never guessed here.
 *
 *  US-TRUTH-017: {@link deliveryTruth} is the structured input — when provided
 *  it replaces backlogStatus string parsing (AC1). Callers SHOULD pass it when
 *  they have access to deliveries; the selector falls back to the deprecated
 *  string parse path only for legacy rows that predate the structured store. */
export function storyTruthFromBacklog(
  storyId: string,
  backlogStatus: string,
  opts: { prEvidence?: AuditPrEvidence; nowSec?: number; deliveryTruth?: StoryDeliveryTruth } = {},
): StoryTruth {
  return deriveStoryTruth({
    storyId,
    backlogStatus,
    ...(opts.deliveryTruth !== undefined ? { deliveryTruth: opts.deliveryTruth } : {}),
    ...(opts.prEvidence !== undefined ? { prEvidence: opts.prEvidence } : {}),
    deliveringCycles: [],
    nowSec: opts.nowSec ?? Math.floor(Date.now() / 1000),
    graceSec: GRACE_SEC,
    schemaEpochSec: TRUTH_SCHEMA_EPOCH_SEC,
  });
}

/** Evidence truth for a story straight from artifact probes (delegates). */
export function evidenceTruth(storyId: string, report: boolean, acMap: boolean, delivered: boolean): EvidenceTruth {
  return deriveEvidenceTruth({ storyId, report, acMap, delivered });
}

/** Fold a TerminalOutcome onto the dashboard's classification vocabulary.
 *  `unknown` STAYS unknown — AC4: never silently rendered as success. */
export function outcomeToPanel(outcome: CycleTruth["outcome"], state: TruthState): string {
  if (state === "unknown" && outcome === "unknown") return "unknown";
  switch (outcome) {
    case "delivered":
    case "published_pending_merge":
      return "done";
    case "idle_no_work":
    case "dormant_entered":
      return "idle";
    // FIX-351: gates passed but publish did not land (work committed locally) —
    // a NEUTRAL state, NOT a failure. Classified `idle`-side so the panel/tally
    // never counts a sound-but-unpublished cycle as a fail (it is not red).
    case "unpublished":
      return "idle";
    // FIX-908: real work committed but a required acceptance artifact is missing —
    // the work is preserved on the branch awaiting review, NOT a failure. Bucket
    // it neutrally (idle-side, like unpublished) so the panel/tally never paints a
    // sound-but-unreviewed cycle red.
    case "needs_review":
      return "idle";
    case "failed":
    case "blocked":
    case "aborted_no_delivery":
    case "aborted_with_delivery":
    case "orphan_timeout":
      return "fail";
    default:
      return "unknown";
  }
}

/** A live lease lock fact read by infra; the adapter never probes or mutates it. */
export interface BrowserActiveLeaseFact {
  leaseId: string;
  storyId?: string;
  expiresAt: string;
}

/** Declared browser-operation inputs. Gathering IO belongs to the caller. */
export interface BrowserOperationsTruthFacts {
  events: readonly BrowserOperationEvent[];
  activeLease?: BrowserActiveLeaseFact | null;
  captureLinks?: readonly CaptureBridgeLink[];
  nowMs: number;
  storyId?: string;
  cycleId?: string;
  collectedAt?: string;
}

/** Extract the durable CaptureBridge facts from browser-operation ledger events. */
export function captureLinksFromBrowserEvents(events: readonly BrowserOperationEvent[]): CaptureBridgeLink[] {
  return events.flatMap((event) => event.type === "browser:capture-linked" ? [event.link] : []);
}

function matchesScope(value: string | undefined, scope: string | undefined): boolean {
  return scope === undefined || scope === "" || value === scope;
}

function requestedRunIds(facts: BrowserOperationsTruthFacts, lane?: "managed" | "interactive"): Set<string> {
  const runIds = new Set<string>();
  for (const event of facts.events) {
    if (event.type !== "browser:operation-requested") continue;
    if (lane !== undefined && event.request.lane !== lane) continue;
    if (!matchesScope(event.request.storyId, facts.storyId)) continue;
    if (!matchesScope(event.request.cycleId, facts.cycleId)) continue;
    runIds.add(event.runId);
  }
  return runIds;
}

function managedTruth(facts: BrowserOperationsTruthFacts): BrowserOperationsTruth["managed"] {
  const runIds = requestedRunIds(facts, "managed");
  if (runIds.size === 0) return { status: "unknown", unavailableReason: "no managed operation facts" };

  const completed = new Map<string, "ok" | "bad">();
  for (const event of facts.events) {
    if (!("runId" in event) || !runIds.has(event.runId)) continue;
    if (event.type === "browser:operation-finished") {
      completed.set(event.runId, event.result.status === "ok" ? "ok" : "bad");
    }
    if (event.type === "browser:operation-denied") completed.set(event.runId, "bad");
  }
  if ([...completed.values()].includes("bad")) {
    return { status: "degraded", unavailableReason: "managed operation failed" };
  }
  if (completed.size !== runIds.size) {
    return { status: "unknown", unavailableReason: "managed operation has no terminal fact" };
  }
  return { status: "ready" };
}

function leaseTruth(facts: BrowserOperationsTruthFacts): BrowserOperationsTruth["lease"] {
  const active = facts.activeLease ?? null;
  if (active !== null && matchesScope(active.storyId, facts.storyId)) {
    const expiryMs = Date.parse(active.expiresAt);
    if (!Number.isFinite(expiryMs)) {
      return { status: "unknown", expiresAt: active.expiresAt, unavailableReason: "owner lease expiry is unparseable" };
    }
    if (expiryMs <= facts.nowMs) {
      return { status: "expired", expiresAt: active.expiresAt, unavailableReason: "owner lease expired" };
    }
    return { status: "ready", expiresAt: active.expiresAt };
  }

  const grants = facts.events.flatMap((event, index) =>
    event.type === "browser:lease-granted" && matchesScope(event.storyId, facts.storyId) ? [{ event, index }] : [],
  );
  const grant = grants.at(-1);
  const rejected = facts.events.flatMap((event, index) =>
    event.type === "browser:lease-rejected" && matchesScope(event.storyId, facts.storyId) ? [{ event, index }] : [],
  ).at(-1);
  if (grant === undefined) {
    if (rejected !== undefined) return { status: "degraded", unavailableReason: rejected.event.reason.message };
    return { status: "unknown", unavailableReason: "no owner lease facts" };
  }
  if (rejected !== undefined && rejected.index > grant.index) {
    return { status: "degraded", unavailableReason: rejected.event.reason.message };
  }

  const terminalEvents = facts.events.slice(grant.index + 1).filter(
    (event): event is Extract<BrowserOperationEvent, { type: "browser:lease-orphaned" | "browser:lease-expired" | "browser:lease-released" }> =>
      (event.type === "browser:lease-orphaned" || event.type === "browser:lease-expired" || event.type === "browser:lease-released") &&
      event.leaseId === grant.event.leaseId,
  );
  if (terminalEvents.some((event) => event.type === "browser:lease-orphaned")) {
    return { status: "degraded", expiresAt: grant.event.expiresAt, unavailableReason: "owner lease holder was orphaned" };
  }
  if (terminalEvents.some((event) => event.type === "browser:lease-expired")) {
    return { status: "expired", expiresAt: grant.event.expiresAt, unavailableReason: "owner lease expired" };
  }
  if (terminalEvents.some((event) => event.type === "browser:lease-released")) {
    return { status: "unknown", expiresAt: grant.event.expiresAt, unavailableReason: "owner lease was released" };
  }
  if (Date.parse(grant.event.expiresAt) <= facts.nowMs) {
    return { status: "expired", expiresAt: grant.event.expiresAt, unavailableReason: "owner lease expired" };
  }
  return { status: "ready", expiresAt: grant.event.expiresAt };
}

function captureTruth(facts: BrowserOperationsTruthFacts): BrowserOperationsTruth["capture"] {
  const scopedRunIds = facts.cycleId === undefined || facts.cycleId === "" ? undefined : requestedRunIds(facts);
  const links = (facts.captureLinks ?? []).filter(
    (link) => matchesScope(link.storyId, facts.storyId) && (scopedRunIds === undefined || scopedRunIds.has(link.runId)),
  );
  if (links.length === 0) return { status: "unknown", unavailableReason: "no physical capture facts" };
  if (links.some((link) => link.canSatisfyVisualAc)) return { status: "ready" };
  if (links.some((link) => link.captureResponse === undefined)) {
    return { status: "unknown", unavailableReason: "physical capture has no terminal fact" };
  }
  return { status: "degraded", unavailableReason: links[0]?.reason ?? "physical capture cannot satisfy visual AC" };
}

/**
 * Project run, lease, and capture status from their declared sources only.
 * This read-side adapter deliberately has no filesystem, network, or mutation
 * capability so downstream surfaces cannot grow parallel raw-event parsers.
 */
export function browserOperationsTruth(facts: BrowserOperationsTruthFacts): BrowserOperationsTruth {
  return {
    managed: managedTruth(facts),
    lease: leaseTruth(facts),
    capture: captureTruth(facts),
    collectedAt: facts.collectedAt ?? new Date(facts.nowMs).toISOString(),
  };
}

const TIMELINE_ABSENCE_KINDS = [
  "operation-start",
  "operation-finish",
  "lease-grant",
  "lease-expiry",
  "lease-release",
  "physical-capture",
] as const satisfies readonly BrowserTimelineRow["kind"][];

const TIMELINE_ABSENCE_REASONS: Record<(typeof TIMELINE_ABSENCE_KINDS)[number], string> = {
  "operation-start": "no browser operation start fact",
  "operation-finish": "no browser operation finish fact",
  "lease-grant": "no owner lease grant fact",
  "lease-expiry": "no owner lease expiry fact",
  "lease-release": "no owner lease release fact",
  "physical-capture": "no physical capture fact",
};

function scopedTimelineEvents(facts: BrowserOperationsTruthFacts): BrowserOperationEvent[] {
  const runIds = requestedRunIds(facts);
  const scoped: BrowserOperationEvent[] = [];
  for (const event of facts.events) {
    if (event.type === "browser:lease-granted" || event.type === "browser:lease-rejected") {
      if (!matchesScope(event.storyId, facts.storyId)) continue;
      scoped.push(event);
      continue;
    }
    if (event.type === "browser:lease-expired" || event.type === "browser:lease-released" || event.type === "browser:lease-orphaned") {
      // Lease terminal events carry leaseId only; include when story scope is unset
      // or a lease-grant for the same lease already matched the story.
      const grant = facts.events.find(
        (candidate): candidate is Extract<BrowserOperationEvent, { type: "browser:lease-granted" }> =>
          candidate.type === "browser:lease-granted" && candidate.leaseId === event.leaseId,
      );
      if (grant !== undefined && !matchesScope(grant.storyId, facts.storyId)) continue;
      if (grant === undefined && facts.storyId !== undefined && facts.storyId !== "") continue;
      scoped.push(event);
      continue;
    }
    if (!("runId" in event)) continue;
    if (runIds.size > 0) {
      if (!runIds.has(event.runId)) continue;
    } else if (facts.storyId !== undefined && facts.storyId !== "") {
      continue;
    }
    scoped.push(event);
  }
  return scoped;
}

function presentTimelineRows(facts: BrowserOperationsTruthFacts): BrowserTimelineRow[] {
  const rows: BrowserTimelineRow[] = [];
  for (const event of scopedTimelineEvents(facts)) {
    if (event.type === "browser:operation-started") {
      rows.push({
        kind: "operation-start",
        presence: "present",
        ts: event.ts,
        label: "operation start",
        runId: event.runId,
      });
      continue;
    }
    if (event.type === "browser:operation-finished") {
      const diagnostic = event.result.diagnosticRefs[0];
      rows.push({
        kind: "operation-finish",
        presence: "present",
        ts: event.ts,
        label: "operation finish",
        detail: event.result.status,
        runId: event.runId,
        artifact:
          diagnostic === undefined
            ? undefined
            : {
                kind: "diagnostic",
                id: diagnostic.artifactId,
                label: diagnostic.kind,
              },
      });
      continue;
    }
    if (event.type === "browser:lease-granted") {
      rows.push({
        kind: "lease-grant",
        presence: "present",
        ts: event.ts,
        label: "lease grant",
        detail: `expires ${event.expiresAt}`,
        leaseId: event.leaseId,
      });
      continue;
    }
    if (event.type === "browser:lease-expired") {
      rows.push({
        kind: "lease-expiry",
        presence: "present",
        ts: event.ts,
        label: "lease expiry",
        leaseId: event.leaseId,
      });
      continue;
    }
    if (event.type === "browser:lease-released") {
      rows.push({
        kind: "lease-release",
        presence: "present",
        ts: event.ts,
        label: "lease release",
        leaseId: event.leaseId,
      });
    }
  }

  const scopedRunIds = facts.cycleId === undefined || facts.cycleId === "" ? undefined : requestedRunIds(facts);
  for (const link of facts.captureLinks ?? []) {
    if (!matchesScope(link.storyId, facts.storyId)) continue;
    if (scopedRunIds !== undefined && !scopedRunIds.has(link.runId)) continue;
    const status = link.captureResponse?.status;
    const screenshotPath = link.captureResponse?.screenshotPath;
    rows.push({
      kind: "physical-capture",
      presence: "present",
      ts: link.linkedAt,
      label: "physical capture",
      detail: status === undefined
        ? link.reason
        : link.canSatisfyVisualAc
          ? `${status}`
          : `${status} — ${link.reason}`,
      runId: link.runId,
      artifact:
        screenshotPath === undefined || screenshotPath === ""
          ? {
              kind: "physical-capture",
              id: link.captureRequestId,
              label: "capture",
            }
          : {
              kind: "physical-capture",
              id: screenshotPath,
              label: "capture",
            },
    });
  }

  return rows.sort((a, b) => {
    const at = a.ts ?? "";
    const bt = b.ts ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.kind.localeCompare(b.kind);
  });
}

function timelineAbsences(present: readonly BrowserTimelineRow[]): BrowserTimelineRow[] {
  const seen = new Set(present.map((row) => row.kind));
  return TIMELINE_ABSENCE_KINDS.filter((kind) => !seen.has(kind)).map((kind) => ({
    kind,
    presence: "absent" as const,
    label: kind.replaceAll("-", " "),
    detail: TIMELINE_ABSENCE_REASONS[kind],
  }));
}

/**
 * Project a compact browser-operations timeline from declared facts only.
 * Present rows keep declared timestamps and ordering; missing categories are
 * reported as absences with reasons — never an invented stamp or verdict.
 */
export function browserOperationsTimeline(facts: BrowserOperationsTruthFacts): BrowserOperationsTimeline {
  const rows = presentTimelineRows(facts);
  return {
    rows,
    absences: timelineAbsences(rows),
    hasFacts: rows.length > 0,
    collectedAt: facts.collectedAt ?? new Date(facts.nowMs).toISOString(),
  };
}
