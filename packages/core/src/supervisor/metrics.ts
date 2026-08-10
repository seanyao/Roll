/**
 * @responsibility Projects supervisor flow metrics as a read-only event projection.
 * US-LOOP-130 — Supervisor flow metrics are a read-only event projection.
 *
 * A missing boundary is never turned into zero elapsed time or a delivery
 * claim.  In particular, a Delta handoff is only a handoff: main evidence and
 * an attestation fact must be observed independently before a card is shown as
 * delivered and consistent.
 */
import { eventTsMs, type RollEvent } from "@roll/spec";

export const SUPERVISOR_METRICS_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_METRICS_PERCENTILE_ALGORITHM = "nearest-rank" as const;

export interface SupervisorMetricBacklogCard {
  readonly id: string;
  readonly status: string;
  readonly dependsOn: readonly string[];
}

export interface SupervisorMetricSample {
  readonly sampleSize: number;
  readonly totalMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

export interface SupervisorCardMetrics {
  readonly storyId: string;
  readonly queueWaitMs: number | null;
  readonly dependencyWaitMs: number | null;
  readonly firstActionLatencyMs: number | null;
  readonly dispatchToMergeLeadMs: number | null;
  readonly prCiTailMs: number | null;
  readonly reconciliationLagMs: number | null;
  readonly dependencyState: "not_applicable" | "blocked_by_not_done" | "not_yet_dispatched" | "unknown";
  readonly handoffReady: boolean;
  readonly delivery: "delivered" | "not_delivered";
  readonly truth: {
    readonly recordedMainMerge: "confirmed" | "unavailable";
    readonly backlog: "done" | "not_done" | "unavailable";
    readonly attestation: "recorded" | "unavailable";
    readonly consistency: "consistent" | "inconsistent" | "incomplete";
  };
  /** Every null metric and unavailable source is named rather than silently omitted. */
  readonly incompleteFacts: readonly string[];
}

export interface SupervisorMetrics {
  readonly schema: "roll.supervisor.metrics.v1";
  readonly schemaVersion: 1;
  readonly windowBasis: "observed_event_time";
  readonly observationWindow: { readonly fromTs: number | null; readonly toTs: number | null };
  readonly percentileAlgorithm: "nearest-rank";
  readonly cards: readonly SupervisorCardMetrics[];
  readonly sampleSize: number;
  readonly aggregates: {
    readonly queueWait: SupervisorMetricSample;
    readonly dependencyWait: SupervisorMetricSample;
    readonly firstActionLatency: SupervisorMetricSample;
    readonly dispatchToMergeLead: SupervisorMetricSample;
    readonly prCiTail: SupervisorMetricSample;
    readonly reconciliationLag: SupervisorMetricSample;
  };
  readonly dependencyStates: Readonly<Record<"blocked_by_not_done" | "not_yet_dispatched" | "unknown", number>>;
  readonly truthConsistency: { readonly checked: number; readonly consistent: number; readonly inconsistent: number; readonly incomplete: number };
  readonly incomplete: boolean;
  readonly diagnostics: readonly string[];
}

export interface ProjectSupervisorMetricsInput {
  readonly events: readonly RollEvent[];
  readonly backlog: readonly SupervisorMetricBacklogCard[];
  readonly sourceDiagnostics?: readonly string[];
}

interface Boundaries {
  dispatch?: number;
  firstAction?: number;
  queueObserved?: number;
  dependencyObserved?: number;
  prOpened?: number;
  ciObserved?: number;
  mainMerged?: number;
  reconciled?: number;
  attested?: number;
  handoffReady: boolean;
}

function first<T>(current: T | undefined, candidate: T): T {
  return current === undefined ? candidate : current;
}

function last(current: number | undefined, candidate: number): number {
  return current === undefined || candidate > current ? candidate : current;
}

function observedTs(event: RollEvent): number | undefined {
  return typeof event.ts === "number" && Number.isFinite(event.ts) ? eventTsMs(event.ts) : undefined;
}

function duration(start: number | undefined, end: number | undefined): number | null {
  if (start === undefined || end === undefined || end < start) return null;
  return end - start;
}

function sample(values: readonly number[]): SupervisorMetricSample {
  if (values.length === 0) return { sampleSize: 0, totalMs: null, p50Ms: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number): number => sorted[Math.ceil(p * sorted.length) - 1]!;
  return { sampleSize: values.length, totalMs: values.reduce((sum, value) => sum + value, 0), p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

function backlogDone(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized.startsWith("✅") || normalized.startsWith("done");
}

function eventStoryId(event: RollEvent, cycleStories: ReadonlyMap<string, string>, delegationStories: ReadonlyMap<string, string>, prStories: ReadonlyMap<number, string>): string | undefined {
  if ("storyId" in event && typeof event.storyId === "string") return event.storyId;
  if ("cycleId" in event && typeof event.cycleId === "string") return cycleStories.get(event.cycleId);
  if ("delegationId" in event && typeof event.delegationId === "string") return delegationStories.get(event.delegationId);
  if ("prNumber" in event && typeof event.prNumber === "number") return prStories.get(event.prNumber);
  return undefined;
}

/** Project per-card and aggregate operational lag from immutable observations. */
export function projectSupervisorMetrics(input: ProjectSupervisorMetricsInput): SupervisorMetrics {
  const diagnostics = [...(input.sourceDiagnostics ?? [])];
  const cycleStories = new Map<string, string>();
  const delegationStories = new Map<string, string>();
  const prStories = new Map<number, string>();
  const observationTimes: number[] = [];
  for (const event of input.events) {
    const ts = observedTs(event);
    if (ts !== undefined) observationTimes.push(ts);
    if (event.type === "cycle:start") cycleStories.set(event.cycleId, event.storyId);
    if (event.type === "delta:prepared") delegationStories.set(event.delegationId, event.storyId);
    if (event.type === "pr:open" || event.type === "pr:merge") prStories.set(event.prNumber, event.storyId);
    if (event.type === "delivery:published") prStories.set(event.prNumber, event.storyId);
  }

  const boundaries = new Map<string, Boundaries>();
  const forStory = (storyId: string): Boundaries => {
    const prior = boundaries.get(storyId);
    if (prior !== undefined) return prior;
    const created: Boundaries = { handoffReady: false };
    boundaries.set(storyId, created);
    return created;
  };
  for (const event of input.events) {
    const ts = observedTs(event);
    if (ts === undefined) {
      diagnostics.push(`event ${event.type} has invalid observation timestamp`);
      continue;
    }
    const storyId = eventStoryId(event, cycleStories, delegationStories, prStories);
    if (storyId === undefined) continue;
    const row = forStory(storyId);
    if (event.type === "cycle:start" || event.type === "delta:prepared") row.dispatch = first(row.dispatch, ts);
    if (event.type === "cycle:first_edit" || event.type === "delta:role_started" && event.role === "builder") row.firstAction = first(row.firstAction, ts);
    if (event.type === "pick:ranked" && event.ranking.some((candidate) => candidate.id === storyId)) row.queueObserved = first(row.queueObserved, ts);
    if ((event.type === "pick:blocked" || event.type === "pick:skipped") && event.storyId === storyId) row.dependencyObserved = first(row.dependencyObserved, ts);
    if (event.type === "pr:open" || event.type === "delivery:published") row.prOpened = first(row.prOpened, ts);
    if (event.type === "ci:pass" || event.type === "ci:fail" || event.type === "ci:rerun") row.ciObserved = last(row.ciObserved, ts);
    if (event.type === "delivery:merge_confirmed" || event.type === "delivery:reconciled" && event.state !== "superseded") row.mainMerged = first(row.mainMerged, ts);
    if (event.type === "delivery:reconciled" && event.state !== "superseded") row.reconciled = first(row.reconciled, ts);
    if (event.type === "attest:host_delta" || event.type === "attest:gate" && event.verdict === "produced") row.attested = first(row.attested, ts);
    if (event.type === "delta:terminal" && event.outcome === "handoff_ready") row.handoffReady = true;
  }

  const backlogById = new Map(input.backlog.map((card) => [card.id, card]));
  const ids = [...new Set([...backlogById.keys(), ...boundaries.keys()])].sort((a, b) => a.localeCompare(b));
  const cards: SupervisorCardMetrics[] = [];
  const queueWait: number[] = [];
  const dependencyWait: number[] = [];
  const firstActionLatency: number[] = [];
  const dispatchToMergeLead: number[] = [];
  const prCiTail: number[] = [];
  const reconciliationLag: number[] = [];
  const dependencyStates = { blocked_by_not_done: 0, not_yet_dispatched: 0, unknown: 0 };
  let consistent = 0;
  let inconsistent = 0;
  let incompleteTruth = 0;

  for (const storyId of ids) {
    const card = backlogById.get(storyId);
    const row = boundaries.get(storyId) ?? { handoffReady: false };
    const incompleteFacts: string[] = [];
    const queue = duration(row.queueObserved, row.dispatch);
    const firstAction = duration(row.dispatch, row.firstAction);
    const lead = duration(row.dispatch, row.mainMerged);
    const tail = duration(row.prOpened, row.ciObserved ?? row.mainMerged);
    const reconciliation = duration(row.mainMerged, row.reconciled);
    if (queue === null) incompleteFacts.push("queue wait unavailable: missing ranked-ready or dispatch observation");
    if (firstAction === null) incompleteFacts.push("first-action latency unavailable: missing dispatch or first-action observation");
    if (lead === null) incompleteFacts.push("dispatch-to-merge lead unavailable: missing dispatch or recorded main merge evidence");
    if (tail === null) incompleteFacts.push("PR/CI tail unavailable: missing PR-open and CI-or-main observation");
    if (reconciliation === null) incompleteFacts.push("reconciliation lag unavailable: missing main merge or reconciliation observation");

    const dependencies = card?.dependsOn ?? [];
    let dependencyState: SupervisorCardMetrics["dependencyState"] = "not_applicable";
    let dependency = null as number | null;
    if (card === undefined) {
      dependencyState = "unknown";
      incompleteFacts.push("backlog card unavailable: dependency state unknown");
    } else if (dependencies.length > 0) {
      const knownDependencies = dependencies.map((id) => ({ id, card: backlogById.get(id), boundaries: boundaries.get(id) }));
      const missingDependencyTimestamp = knownDependencies.some(({ card: dep, boundaries: depRow }) => dep === undefined || !backlogDone(dep.status) && depRow?.mainMerged === undefined);
      const notDone = knownDependencies.some(({ card: dep }) => dep === undefined || !backlogDone(dep.status));
      if (row.dependencyObserved === undefined) {
        dependencyState = "unknown";
        incompleteFacts.push("dependency wait unavailable: missing dependency-block observation timestamp");
      } else if (notDone) {
        dependencyState = "blocked_by_not_done";
        dependency = duration(row.dependencyObserved, row.dispatch);
        dependencyStates.blocked_by_not_done++;
        if (dependency === null) incompleteFacts.push("dependency wait incomplete: blocked-by-not-Done has no later dispatch observation");
      } else if (missingDependencyTimestamp || row.dispatch === undefined) {
        dependencyState = "not_yet_dispatched";
        dependencyStates.not_yet_dispatched++;
        incompleteFacts.push("dependency wait incomplete: dependencies are Done but dispatch boundary is unavailable");
      } else {
        dependency = duration(row.dependencyObserved, row.dispatch);
        if (dependency === null) {
          dependencyState = "unknown";
          incompleteFacts.push("dependency wait unavailable: timestamp inversion");
        }
      }
    }
    if (dependencyState === "unknown") dependencyStates.unknown++;

    const mainMerge = row.mainMerged === undefined ? "unavailable" : "confirmed";
    const backlog = card === undefined ? "unavailable" : backlogDone(card.status) ? "done" : "not_done";
    const attestation = row.attested === undefined ? "unavailable" : "recorded";
    const truthConsistency = mainMerge === "confirmed"
      ? backlog === "done" && attestation === "recorded" ? "consistent" : "inconsistent"
      : backlog === "done" || attestation === "recorded" ? "inconsistent" : "incomplete";
    if (truthConsistency === "consistent") consistent++;
    else if (truthConsistency === "inconsistent") inconsistent++;
    else incompleteTruth++;
    if (mainMerge === "unavailable") incompleteFacts.push("recorded main merge evidence unavailable");
    if (backlog === "unavailable") incompleteFacts.push("backlog status unavailable");
    if (attestation === "unavailable") incompleteFacts.push("attestation state unavailable");
    if (row.handoffReady) incompleteFacts.push("handoff_ready observed: not a main merge, attestation verdict, or Delivered claim");

    if (queue !== null) queueWait.push(queue);
    if (dependency !== null) dependencyWait.push(dependency);
    if (firstAction !== null) firstActionLatency.push(firstAction);
    if (lead !== null) dispatchToMergeLead.push(lead);
    if (tail !== null) prCiTail.push(tail);
    if (reconciliation !== null) reconciliationLag.push(reconciliation);
    cards.push({
      storyId, queueWaitMs: queue, dependencyWaitMs: dependency, firstActionLatencyMs: firstAction,
      dispatchToMergeLeadMs: lead, prCiTailMs: tail, reconciliationLagMs: reconciliation,
      dependencyState, handoffReady: row.handoffReady, delivery: mainMerge === "confirmed" ? "delivered" : "not_delivered",
      truth: { recordedMainMerge: mainMerge, backlog, attestation, consistency: truthConsistency }, incompleteFacts,
    });
  }
  const window = observationTimes.length === 0 ? { fromTs: null, toTs: null } : { fromTs: Math.min(...observationTimes), toTs: Math.max(...observationTimes) };
  return {
    schema: "roll.supervisor.metrics.v1", schemaVersion: SUPERVISOR_METRICS_SCHEMA_VERSION,
    windowBasis: "observed_event_time", observationWindow: window, percentileAlgorithm: SUPERVISOR_METRICS_PERCENTILE_ALGORITHM,
    cards, sampleSize: cards.length,
    aggregates: {
      queueWait: sample(queueWait), dependencyWait: sample(dependencyWait), firstActionLatency: sample(firstActionLatency),
      dispatchToMergeLead: sample(dispatchToMergeLead), prCiTail: sample(prCiTail), reconciliationLag: sample(reconciliationLag),
    },
    dependencyStates, truthConsistency: { checked: consistent + inconsistent, consistent, inconsistent, incomplete: incompleteTruth },
    incomplete: diagnostics.length > 0 || cards.some((card) => card.incompleteFacts.length > 0), diagnostics,
  };
}
