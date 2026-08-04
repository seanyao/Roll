/**
 * US-DELTA-013 — immutable Delta delivery metrics.
 *
 * This is intentionally a read model: callers supply the event ledger and the
 * separately collected delivery facts.  It never writes a cache, changes a
 * route, or turns an absence into a successful delivery.
 */
import { eventTsMs, type AttemptCause, type DeliveryRecord, type RollEvent } from "@roll/spec";
import { projectTcrTelemetry } from "../delivery/tcr-observation.js";

export const DELTA_METRICS_SCHEMA_VERSION = 1 as const;
export const DELTA_METRICS_PERCENTILE_ALGORITHM = "nearest-rank" as const;

export interface DeltaMetricsWindow {
  readonly fromTs?: number;
  readonly toTs?: number;
}

/** A delivery fact collected from the PR/reconciliation plane. */
export interface DeltaDeliveryFact {
  readonly storyId: string;
  readonly lifecycleState?: string;
  readonly mergedAtMs?: number;
  /** An explicit CI observation; omitted means that fact was not supplied. */
  readonly ci?: "passed" | "failed" | "unknown";
  /** An explicit attest observation; omitted means that fact was not supplied. */
  readonly attest?: "accepted" | "rejected" | "unknown";
}

export interface DeltaMetricSample {
  readonly sampleSize: number;
  readonly totalMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

export interface DeltaMetricRate {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
  readonly reason?: "no_eligible_sample";
}

export interface DeltaMetricsRig {
  readonly builder: string;
  readonly evaluator: string;
  readonly builderProvider: string;
  readonly evaluatorProvider: string;
  readonly modelDiverse: boolean | null;
  readonly providerDiverse: boolean | null;
  readonly attempts: number;
  readonly builderWallMs: number | null;
}

export interface DeltaMetrics {
  readonly schema: "roll.delta.metrics.v1";
  readonly schemaVersion: 1;
  /** Filter is always expressed as observed event time, never Git author time. */
  readonly windowBasis: "observed_event_time";
  readonly window: DeltaMetricsWindow;
  readonly percentileAlgorithm: "nearest-rank";
  readonly cards: number;
  readonly attempts: number;
  readonly mergedCards: number;
  readonly firstPassMergeRate: DeltaMetricRate;
  readonly redelegateRate: DeltaMetricRate;
  /** Sum is null where no honest wall-clock sample exists. */
  readonly phaseWallMs: {
    readonly builder: number | null;
    readonly evaluator: number | null;
    readonly mergeTail: number | null;
  };
  readonly phaseSamples: {
    readonly builder: DeltaMetricSample;
    readonly evaluator: DeltaMetricSample;
    readonly mergeTail: DeltaMetricSample;
  };
  readonly tcr: {
    readonly rounds: number | null;
    readonly green: number | null;
    readonly red: number | null;
    readonly testWallMs: number | null;
    readonly completeRounds: number;
    readonly incompleteRounds: number;
    readonly incompleteAttempts: number;
  };
  readonly outcomeCauses: Readonly<Partial<Record<AttemptCause, number>>>;
  readonly rigs: readonly DeltaMetricsRig[];
  /** Missing, malformed, duplicate, and time-inverted facts stay visible here. */
  readonly incomplete: boolean;
  readonly diagnostics: readonly string[];
}

export interface ProjectDeltaMetricsInput {
  readonly events: readonly RollEvent[];
  readonly deliveries?: readonly (DeltaDeliveryFact | DeliveryRecord)[];
  readonly window?: DeltaMetricsWindow;
  /** Reader-level findings, for example a partial NDJSON line that could not be parsed. */
  readonly sourceDiagnostics?: readonly string[];
}

interface Attempt {
  readonly delegationId: string;
  readonly storyId: string;
  readonly events: readonly RollEvent[];
  readonly preparedTs: number;
}

interface RoleIdentity {
  readonly provider: string;
  readonly model: string;
}

function isFiniteTs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function observedTs(event: RollEvent): number | undefined {
  return isFiniteTs(event.ts) ? eventTsMs(event.ts) : undefined;
}

function inWindow(ts: number, window: DeltaMetricsWindow): boolean {
  return (window.fromTs === undefined || ts >= window.fromTs) && (window.toTs === undefined || ts <= window.toTs);
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(percentileValue * sorted.length) - 1] ?? null;
}

function sample(values: readonly number[]): DeltaMetricSample {
  if (values.length === 0) return { sampleSize: 0, totalMs: null, p50Ms: null, p95Ms: null };
  return {
    sampleSize: values.length,
    totalMs: values.reduce((total, value) => total + value, 0),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

function rate(numerator: number, denominator: number): DeltaMetricRate {
  return denominator === 0
    ? { numerator, denominator, value: null, reason: "no_eligible_sample" }
    : { numerator, denominator, value: numerator / denominator };
}

function deliveryFact(value: DeltaDeliveryFact | DeliveryRecord): DeltaDeliveryFact {
  if (!("mergedAt" in value)) return value;
  return {
    storyId: value.storyId,
    lifecycleState: value.lifecycleState,
    ...(value.mergedAt.present ? { mergedAtMs: value.mergedAt.value } : {}),
  };
}

function roleIdentity(events: readonly RollEvent[], role: "builder" | "evaluator"): RoleIdentity | undefined {
  for (const event of events) {
    if (event.type === "delta:role_resolved" && event.role === role) {
      return { provider: event.hostId, model: event.modelId };
    }
  }
  return undefined;
}

function firstTs(events: readonly RollEvent[], predicate: (event: RollEvent) => boolean): number | undefined {
  for (const event of events) {
    if (!predicate(event)) continue;
    const ts = observedTs(event);
    if (ts !== undefined) return ts;
  }
  return undefined;
}

function phaseDuration(
  diagnostics: string[],
  attempt: Attempt,
  phase: "builder" | "evaluator" | "mergeTail",
  start: number | undefined,
  end: number | undefined,
): number | undefined {
  if (start === undefined || end === undefined) {
    diagnostics.push(`${phase} wall time incomplete for ${attempt.delegationId}: missing boundary fact`);
    return undefined;
  }
  const duration = end - start;
  if (duration < 0) {
    diagnostics.push(`${phase} wall time incomplete for ${attempt.delegationId}: timestamp inversion`);
    return undefined;
  }
  return duration;
}

function terminalRedelegated(events: readonly RollEvent[]): boolean {
  return events.some((event) => event.type === "delta:terminal" && event.deliveryDisposition === "owner_redelegate");
}

/** A host-Delta reconciliation is a stronger, delegation-bound merge fact than a loose story record. */
function reconciledMergeTs(events: readonly RollEvent[]): number | undefined {
  return firstTs(events, (event) =>
    event.type === "delivery:reconciled" && (event.state === "delivered" || event.state === "delivered_external" || event.state === "delivered_local"),
  );
}

function ciRepairStories(events: readonly RollEvent[]): Set<string> {
  const storyByPr = new Map<number, string>();
  for (const event of events) {
    if (event.type === "pr:open" || event.type === "pr:merge") storyByPr.set(event.prNumber, event.storyId);
  }
  const repaired = new Set<string>();
  for (const event of events) {
    if (event.type !== "ci:fail" && event.type !== "ci:rerun") continue;
    const storyId = storyByPr.get(event.prNumber);
    if (storyId !== undefined) repaired.add(storyId);
  }
  return repaired;
}

/**
 * Deterministically projects Delta telemetry from immutable observations.
 * The input list is never reordered or mutated. A malformed source row is
 * expected to be reported by the caller in sourceDiagnostics because RollEvent
 * parsing deliberately skips malformed NDJSON rows for rebuild availability.
 */
export function projectDeltaMetrics(input: ProjectDeltaMetricsInput): DeltaMetrics {
  const window = input.window ?? {};
  const diagnostics = [...(input.sourceDiagnostics ?? [])];
  if (window.fromTs !== undefined && !Number.isFinite(window.fromTs)) diagnostics.push("window fromTs is invalid");
  if (window.toTs !== undefined && !Number.isFinite(window.toTs)) diagnostics.push("window toTs is invalid");
  if (window.fromTs !== undefined && window.toTs !== undefined && window.fromTs > window.toTs) {
    diagnostics.push("window is inverted: fromTs is after toTs");
  }

  const allByDelegation = new Map<string, RollEvent[]>();
  for (const event of input.events) {
    if (!("delegationId" in event) || typeof event.delegationId !== "string") continue;
    if (
      !event.type.startsWith("delta:")
      && !event.type.startsWith("tcr:")
      && event.type !== "delivery:reconciled"
      && event.type !== "attest:host_delta"
    ) continue;
    const rows = allByDelegation.get(event.delegationId) ?? [];
    rows.push(event);
    allByDelegation.set(event.delegationId, rows);
  }

  const attempts: Attempt[] = [];
  for (const [delegationId, events] of allByDelegation) {
    const prepared = events.filter((event): event is Extract<RollEvent, { type: "delta:prepared" }> => event.type === "delta:prepared");
    const selected = events.some((event) => {
      const ts = observedTs(event);
      return ts !== undefined && inWindow(ts, window);
    });
    if (!selected) continue;
    if (prepared.length === 0) {
      diagnostics.push(`orphan Delta observations for ${delegationId}: missing delta:prepared fact`);
      continue;
    }
    if (prepared.length > 1) diagnostics.push(`duplicate delta:prepared facts for ${delegationId}: kept first occurrence`);
    const first = prepared[0]!;
    const preparedTs = observedTs(first);
    if (preparedTs === undefined) {
      diagnostics.push(`Delta attempt ${delegationId} has invalid prepared timestamp`);
      continue;
    }
    attempts.push({ delegationId, storyId: first.storyId, events, preparedTs });
  }

  const byStory = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const storyAttempts = byStory.get(attempt.storyId) ?? [];
    storyAttempts.push(attempt);
    byStory.set(attempt.storyId, storyAttempts);
  }

  const deliveryByStory = new Map<string, DeltaDeliveryFact>();
  for (const raw of input.deliveries ?? []) {
    const fact = deliveryFact(raw);
    if (fact.storyId === "") continue;
    const prior = deliveryByStory.get(fact.storyId);
    const priorTs = prior?.mergedAtMs ?? -Infinity;
    const candidateTs = fact.mergedAtMs ?? -Infinity;
    if (prior === undefined || candidateTs >= priorTs) deliveryByStory.set(fact.storyId, fact);
  }

  const builderWall: number[] = [];
  const evaluatorWall: number[] = [];
  const mergeTail: number[] = [];
  const causeCounts: Partial<Record<AttemptCause, number>> = {};
  const rigCounts = new Map<string, { builder: RoleIdentity | undefined; evaluator: RoleIdentity | undefined; attempts: number; builderWall: number[] }>();
  let tcrRows = 0;
  let tcrGreen = 0;
  let tcrRed = 0;
  let tcrWall = 0;
  let tcrComplete = 0;
  let tcrIncomplete = 0;
  let tcrIncompleteAttempts = 0;
  let hasTcrObservations = false;
  const ciRepairedStories = ciRepairStories(input.events);
  const mergedByStory = new Map<string, number>();

  for (const attempt of attempts) {
    // `prepared` is the durable Builder-phase boundary. Role-started is a
    // validation observation and is absent in older but otherwise valid Delta
    // attempts, so using it would make historical timing silently disappear.
    const builderStart = attempt.preparedTs;
    const builderEnd = firstTs(attempt.events, (event) => event.type === "delta:artifact_published" && event.role === "builder");
    const builderDuration = phaseDuration(diagnostics, attempt, "builder", builderStart, builderEnd);
    if (builderDuration !== undefined) builderWall.push(builderDuration);

    // A validated Builder artifact is the stable evaluator-phase handoff.
    const evaluatorStart = builderEnd;
    const evaluatorEnd = firstTs(attempt.events, (event) => event.type === "delta:artifact_published" && event.role === "evaluator");
    const evaluatorDuration = phaseDuration(diagnostics, attempt, "evaluator", evaluatorStart, evaluatorEnd);
    if (evaluatorDuration !== undefined) evaluatorWall.push(evaluatorDuration);

    const handoffTs = firstTs(attempt.events, (event) => event.type === "delta:terminal" && event.outcome === "handoff_ready");
    const mergedAt = reconciledMergeTs(attempt.events) ?? deliveryByStory.get(attempt.storyId)?.mergedAtMs;
    if (mergedAt !== undefined) {
      const prior = mergedByStory.get(attempt.storyId);
      if (prior === undefined || mergedAt > prior) mergedByStory.set(attempt.storyId, mergedAt);
    }
    const mergeDuration = phaseDuration(diagnostics, attempt, "mergeTail", handoffTs, mergedAt);
    if (mergeDuration !== undefined) mergeTail.push(mergeDuration);

    const outcomes = attempt.events.filter((event): event is Extract<RollEvent, { type: "delta:attempt_outcome" }> => event.type === "delta:attempt_outcome");
    if (outcomes.length > 1) diagnostics.push(`duplicate Delta attempt outcomes for ${attempt.delegationId}: kept first occurrence`);
    const outcome = outcomes[0];
    if (outcome === undefined) diagnostics.push(`Delta attempt ${attempt.delegationId} has no explicit attempt outcome fact`);
    else causeCounts[outcome.cause] = (causeCounts[outcome.cause] ?? 0) + 1;

    const tcr = projectTcrTelemetry(attempt.events);
    diagnostics.push(...tcr.diagnostics.map((diagnostic) => `${attempt.delegationId}: ${diagnostic}`));
    if (tcr.rounds.length === 0) {
      tcrIncompleteAttempts++;
      diagnostics.push(`TCR metrics incomplete for ${attempt.delegationId}: no TCR rounds observed`);
    } else {
      hasTcrObservations = true;
      for (const round of tcr.rounds) {
        tcrRows++;
        if (round.status === "complete") tcrComplete++;
        else tcrIncomplete++;
        if (round.testWallMs !== undefined) {
          tcrWall += round.testWallMs;
          if (round.green) tcrGreen++;
          else tcrRed++;
        } else {
          tcrIncomplete++;
        }
        diagnostics.push(...round.diagnostics.map((diagnostic) => `${attempt.delegationId}/${round.roundId}: ${diagnostic}`));
      }
    }

    const builder = roleIdentity(attempt.events, "builder");
    const evaluator = roleIdentity(attempt.events, "evaluator");
    if (builder === undefined || evaluator === undefined) diagnostics.push(`rig identity incomplete for ${attempt.delegationId}`);
    const key = `${builder?.provider ?? "unknown"}\t${builder?.model ?? "unknown"}\t${evaluator?.provider ?? "unknown"}\t${evaluator?.model ?? "unknown"}`;
    const rig = rigCounts.get(key) ?? { builder, evaluator, attempts: 0, builderWall: [] };
    rig.attempts++;
    if (builderDuration !== undefined) rig.builderWall.push(builderDuration);
    rigCounts.set(key, rig);
  }

  const mergedStories = new Set(mergedByStory.keys());
  for (const storyId of byStory.keys()) {
    const fact = deliveryByStory.get(storyId);
    if (fact?.mergedAtMs !== undefined) mergedStories.add(storyId);
  }
  const firstPassEligible = [...byStory.entries()].filter(([storyId]) => mergedStories.has(storyId));
  const firstPassMerged = firstPassEligible.filter(([storyId, storyAttempts]) =>
    storyAttempts.length === 1 && !terminalRedelegated(storyAttempts[0]!.events) && !ciRepairedStories.has(storyId),
  ).length;
  const redelegatedCards = [...byStory.values()].filter((storyAttempts) => storyAttempts.some((attempt) => terminalRedelegated(attempt.events))).length;

  const builderSample = sample(builderWall);
  const evaluatorSample = sample(evaluatorWall);
  const mergeSample = sample(mergeTail);
  const rigs = [...rigCounts.values()]
    .map((rig): DeltaMetricsRig => ({
      builder: rig.builder?.model ?? "unknown",
      evaluator: rig.evaluator?.model ?? "unknown",
      builderProvider: rig.builder?.provider ?? "unknown",
      evaluatorProvider: rig.evaluator?.provider ?? "unknown",
      modelDiverse: rig.builder === undefined || rig.evaluator === undefined ? null : rig.builder.model !== rig.evaluator.model,
      providerDiverse: rig.builder === undefined || rig.evaluator === undefined ? null : rig.builder.provider !== rig.evaluator.provider,
      attempts: rig.attempts,
      builderWallMs: sample(rig.builderWall).totalMs,
    }))
    .sort((a, b) => `${a.builderProvider}/${a.builder}/${a.evaluatorProvider}/${a.evaluator}`.localeCompare(`${b.builderProvider}/${b.builder}/${b.evaluatorProvider}/${b.evaluator}`));

  return {
    schema: "roll.delta.metrics.v1",
    schemaVersion: DELTA_METRICS_SCHEMA_VERSION,
    windowBasis: "observed_event_time",
    window,
    percentileAlgorithm: DELTA_METRICS_PERCENTILE_ALGORITHM,
    cards: byStory.size,
    attempts: attempts.length,
    mergedCards: mergedStories.size,
    firstPassMergeRate: rate(firstPassMerged, firstPassEligible.length),
    redelegateRate: rate(redelegatedCards, byStory.size),
    phaseWallMs: { builder: builderSample.totalMs, evaluator: evaluatorSample.totalMs, mergeTail: mergeSample.totalMs },
    phaseSamples: { builder: builderSample, evaluator: evaluatorSample, mergeTail: mergeSample },
    tcr: hasTcrObservations
      ? { rounds: tcrRows, green: tcrGreen, red: tcrRed, testWallMs: tcrWall, completeRounds: tcrComplete, incompleteRounds: tcrIncomplete, incompleteAttempts: tcrIncompleteAttempts }
      : { rounds: null, green: null, red: null, testWallMs: null, completeRounds: 0, incompleteRounds: 0, incompleteAttempts: tcrIncompleteAttempts },
    outcomeCauses: causeCounts,
    rigs,
    incomplete: diagnostics.length > 0,
    diagnostics,
  };
}
