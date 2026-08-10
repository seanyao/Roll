/**
 * @responsibility Tracks daily north-star metrics against targets.
 */
export type Trend = "up" | "down" | "flat";
export type TargetOp = ">=" | "<" | "=";

export interface NorthStarDay {
  key: string;
  startMs: number;
  endMs: number;
}

export interface NorthStarRun {
  runId?: string;
  cycleId?: string;
  status?: string;
  outcome?: string;
  ts?: string | number;
  storyId?: string;
  built?: string[];
  failureClass?: string;
  rootCauseKey?: string;
}

export interface NorthStarEvent {
  type?: string;
  ts?: string | number;
  storyId?: string;
  cycleId?: string;
  actor?: string;
  failureClass?: string;
}

export interface NorthStarCardMeta {
  id: string;
  type?: "us" | "fix" | "refactor" | "idea" | string;
  epic?: string;
  created?: string;
  rootCauseKey?: string;
}

export interface NorthStarBacklogEntry {
  id: string;
  status: string;
}

export interface NorthStarDelivery {
  storyId: string;
  lifecycleState?: string;
  recordedAt?: number;
  mergedAt?: { present?: boolean; value?: number };
}

export interface NorthStarMetric<C = Record<string, unknown>> {
  current: number | null;
  target: { op: TargetOp; value: number; unit?: string };
  daily: Array<{ day: string; value: number | null; reason?: string; exempt?: boolean }>;
  trend: Trend;
  met: boolean;
  reason?: string;
  context: C;
}

export interface NorthStarReport {
  schema: "roll.north.v1";
  generatedAt: string;
  windowDays: 14;
  window: { startDay: string; endDay: string };
  metrics: {
    autonomy: NorthStarMetric<AutonomyContext>;
    deliveryRate: NorthStarMetric<DeliveryContext>;
    fixTax: NorthStarMetric<FixTaxContext>;
    attributionErrors: NorthStarMetric<AttributionContext>;
  };
}

export interface AutonomyContext {
  bestHours: number | null;
  segmentHours: number | null;
  sinceMs: number | null;
  /** True owner/safety disruptions. Owner goal:recovery counts even when denied because the owner intervened. */
  disruptions: number;
  /** Segment reset boundaries, including deduplicated loop:resumed events. */
  segmentBoundaries: number;
  ineffectiveDays: string[];
  backlogEmptyExemptDays: string[];
}

export interface DeliveryContext {
  nonIdleCycles: number;
  deliveredCycles: number;
  skipRate: number | null;
  blockedRate: number | null;
  reopenCount: number;
  cardAgeDays: { min: number | null; p50: number | null; max: number | null };
  cardTypes: Record<string, number>;
}

export interface FixTaxContext {
  newFixCards: number;
  productDeliveries: number;
  refactorDeliveries: number;
  byClass: Record<"harness" | "product" | "docsTest", number>;
  duplicateRootCauseCount: number;
  repeatedRootCauses: Array<{ key: string; count: number }>;
}

export interface AttributionContext {
  failedCycles: number;
  unknownFailureClass: number;
  envHarnessCardLedgerSkips: number;
}

export interface BuildNorthStarInput {
  nowMs: number;
  days: NorthStarDay[];
  runs: NorthStarRun[];
  events: NorthStarEvent[];
  cards: NorthStarCardMeta[];
  backlog: NorthStarBacklogEntry[];
  deliveries: NorthStarDelivery[];
}

const REQUIRED_NON_IDLE_ATTEMPTS = 6;

export function normalizeEventTimestampMs(ts: string | number | undefined): number | null {
  if (typeof ts === "number") {
    if (!Number.isFinite(ts)) return null;
    return ts < 1e12 ? Math.trunc(ts * 1000) : Math.trunc(ts);
  }
  if (typeof ts !== "string" || ts.trim() === "") return null;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRunTimestampMs(ts: string | number | undefined): number | null {
  return normalizeEventTimestampMs(ts);
}

function inWindow(ms: number, days: readonly NorthStarDay[]): boolean {
  const first = days[0];
  const last = days[days.length - 1];
  return first !== undefined && last !== undefined && ms >= first.startMs && ms < last.endMs;
}

function dayForMs(ms: number, days: readonly NorthStarDay[]): NorthStarDay | null {
  return days.find((d) => ms >= d.startMs && ms < d.endMs) ?? null;
}

function dayValuesTrend(daily: ReadonlyArray<{ value: number | null }>): Trend {
  const nums = (items: ReadonlyArray<{ value: number | null }>): number[] =>
    items.flatMap((d) => (typeof d.value === "number" ? [d.value] : []));
  const first = nums(daily.slice(0, 7));
  const second = nums(daily.slice(7));
  if (first.length === 0 || second.length === 0) return "flat";
  const avg = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const delta = avg(second) - avg(first);
  if (Math.abs(delta) < 1e-9) return "flat";
  return delta > 0 ? "up" : "down";
}

function noHistoryMetric<C>(
  target: NorthStarMetric<C>["target"],
  days: readonly NorthStarDay[],
  context: C,
): NorthStarMetric<C> {
  return {
    current: null,
    target,
    daily: days.map((d) => ({ day: d.key, value: null, reason: "no_history" })),
    trend: "flat",
    met: false,
    reason: "no_history",
    context,
  };
}

function nonIdle(run: NorthStarRun): boolean {
  return (run.status ?? "") !== "idle";
}

function delivered(run: NorthStarRun): boolean {
  const status = run.status ?? "";
  return run.outcome === "delivered" || status === "merged" || status === "done" || status === "published";
}

function blocked(run: NorthStarRun): boolean {
  const status = run.status ?? "";
  return status === "blocked" || run.outcome === "blocked";
}

function failed(run: NorthStarRun): boolean {
  const status = run.status ?? "";
  const outcome = run.outcome ?? "";
  return status === "failed" || status === "blocked" || status === "aborted" || outcome === "failed" || outcome === "blocked";
}

function storyType(storyId: string | undefined, cardsById: ReadonlyMap<string, NorthStarCardMeta>): string {
  if (storyId === undefined || storyId === "") return "unknown";
  const explicit = cardsById.get(storyId)?.type;
  if (typeof explicit === "string" && explicit !== "") return explicit.toLowerCase();
  const prefix = storyId.split("-")[0]?.toLowerCase();
  return prefix === undefined || prefix === "" ? "unknown" : prefix;
}

function isUsStory(storyId: string | undefined): boolean {
  return storyId !== undefined && /^US-/i.test(storyId);
}

function isRefactorStory(storyId: string | undefined): boolean {
  return storyId !== undefined && /^REFACTOR-/i.test(storyId);
}

function metricMet(current: number | null, op: TargetOp, target: number): boolean {
  if (current === null) return false;
  if (op === ">=") return current >= target;
  if (op === "<") return current < target;
  return current === target;
}

const INTERRUPTION_TYPES = new Set([
  "policy:safety_pause",
  "correction:circuit_breaker",
  "cycle:rescue",
  "sandbox:quarantined",
]);

function isDisruption(event: NorthStarEvent): boolean {
  if (event.type === "goal:recovery") return event.actor === "owner";
  return event.type !== undefined && INTERRUPTION_TYPES.has(event.type);
}

function isSegmentBoundary(event: NorthStarEvent): boolean {
  return event.type === "loop:resumed" || isDisruption(event);
}

function buildAutonomy(input: BuildNorthStarInput, windowRuns: Array<{ run: NorthStarRun; tsMs: number }>): NorthStarMetric<AutonomyContext> {
  const target = { op: ">=" as const, value: 72, unit: "hours" };
  const disruptions = input.events
    .map((event) => ({ event, tsMs: normalizeEventTimestampMs(event.ts) }))
    .filter((item): item is { event: NorthStarEvent; tsMs: number } => item.tsMs !== null && isDisruption(item.event))
    .sort((a, b) => a.tsMs - b.tsMs);
  const segmentBoundaries = input.events
    .map((event) => ({ event, tsMs: normalizeEventTimestampMs(event.ts) }))
    .filter((item): item is { event: NorthStarEvent; tsMs: number } => item.tsMs !== null && isSegmentBoundary(item.event))
    .sort((a, b) => a.tsMs - b.tsMs);
  const first = input.days[0];
  const last = input.days[input.days.length - 1];
  if (first === undefined || last === undefined || (windowRuns.length === 0 && segmentBoundaries.length === 0)) {
    return noHistoryMetric(target, input.days, {
      bestHours: null,
      segmentHours: null,
      sinceMs: null,
      disruptions: 0,
      segmentBoundaries: 0,
      ineffectiveDays: [],
      backlogEmptyExemptDays: [],
    });
  }

  const nonIdleByDay = new Map<string, number>();
  for (const { run, tsMs } of windowRuns) {
    if (!nonIdle(run)) continue;
    const day = dayForMs(tsMs, input.days);
    if (day !== null) nonIdleByDay.set(day.key, (nonIdleByDay.get(day.key) ?? 0) + 1);
  }
  const backlogEmpty = input.backlog.every((entry) => !/todo|in progress|📋|🔨/i.test(entry.status));
  const effectiveDays = new Set<string>();
  const ineffectiveDays: string[] = [];
  const exemptDays: string[] = [];
  for (const d of input.days) {
    const attempts = nonIdleByDay.get(d.key) ?? 0;
    if (attempts >= REQUIRED_NON_IDLE_ATTEMPTS) {
      effectiveDays.add(d.key);
    } else if (backlogEmpty) {
      exemptDays.push(d.key);
    } else {
      ineffectiveDays.push(d.key);
    }
  }

  const boundaryTimes: number[] = [];
  let previousWasResume = false;
  for (const boundary of segmentBoundaries) {
    if (boundary.event.type === "loop:resumed") {
      if (previousWasResume) continue;
      previousWasResume = true;
    } else {
      previousWasResume = false;
    }
    boundaryTimes.push(boundary.tsMs);
  }
  const latestBoundary = boundaryTimes.filter((ts) => ts <= input.nowMs).at(-1) ?? first.startMs;
  const effectiveHoursBetween = (startMs: number, endMs: number): number => {
    let total = 0;
    for (const d of input.days) {
      if (!effectiveDays.has(d.key)) continue;
      const start = Math.max(startMs, d.startMs);
      const end = Math.min(endMs, d.endMs);
      if (end > start) total += (end - start) / hourMs();
    }
    return Math.round(total * 100) / 100;
  };
  const segmentHours = effectiveHoursBetween(latestBoundary, input.nowMs);
  const segmentBounds = [first.startMs, ...boundaryTimes.filter((ts) => inWindow(ts, input.days)), Math.min(input.nowMs, last.endMs)];
  let best = 0;
  for (let i = 0; i < segmentBounds.length - 1; i++) {
    best = Math.max(best, effectiveHoursBetween(segmentBounds[i] ?? first.startMs, segmentBounds[i + 1] ?? input.nowMs));
  }
  const daily = input.days.map((d) => {
    if (!effectiveDays.has(d.key)) {
      return {
        day: d.key,
        value: 0,
        ...(exemptDays.includes(d.key) ? { exempt: true } : {}),
      };
    }
    const latestBeforeDayEnd = boundaryTimes.filter((ts) => ts <= d.endMs).at(-1) ?? first.startMs;
    const startMs = Math.max(d.startMs, latestBeforeDayEnd);
    const endMs = Math.min(d.endMs, input.nowMs);
    const value = endMs > startMs ? effectiveHoursBetween(startMs, endMs) : 0;
    return { day: d.key, value };
  });
  const current = Math.round(daily.reduce((sum, d) => sum + d.value, 0) * 100) / 100;
  return {
    current,
    target,
    daily,
    trend: dayValuesTrend(daily),
    met: metricMet(current, target.op, target.value),
    context: {
      bestHours: Math.round(best * 100) / 100,
      segmentHours,
      sinceMs: latestBoundary,
      disruptions: disruptions.length,
      segmentBoundaries: boundaryTimes.filter((ts) => inWindow(ts, input.days)).length,
      ineffectiveDays,
      backlogEmptyExemptDays: exemptDays,
    },
  };
}

function hourMs(): number {
  return 3600 * 1000;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? null;
}

function buildDeliveryRate(
  input: BuildNorthStarInput,
  windowRuns: Array<{ run: NorthStarRun; tsMs: number }>,
  cardsById: ReadonlyMap<string, NorthStarCardMeta>,
): NorthStarMetric<DeliveryContext> {
  const target = { op: ">=" as const, value: 0.6, unit: "ratio" };
  if (windowRuns.length === 0) {
    return noHistoryMetric(target, input.days, {
      nonIdleCycles: 0,
      deliveredCycles: 0,
      skipRate: null,
      blockedRate: null,
      reopenCount: 0,
      cardAgeDays: { min: null, p50: null, max: null },
      cardTypes: {},
    });
  }
  const nonIdleRuns = windowRuns.filter(({ run }) => nonIdle(run));
  const deliveredRuns = nonIdleRuns.filter(({ run }) => delivered(run));
  const skipEvents = input.events.filter((e) => e.type === "goal:card_skipped" && normalizeEventTimestampMs(e.ts) !== null && inWindow(normalizeEventTimestampMs(e.ts) ?? 0, input.days));
  const blockedRuns = nonIdleRuns.filter(({ run }) => blocked(run));
  const cardTypes: Record<string, number> = {};
  const ages: number[] = [];
  for (const { run, tsMs } of nonIdleRuns) {
    const type = storyType(run.storyId, cardsById);
    cardTypes[type] = (cardTypes[type] ?? 0) + 1;
    const created = run.storyId !== undefined ? cardsById.get(run.storyId)?.created : undefined;
    if (created !== undefined) {
      const createdMs = Date.parse(created);
      if (Number.isFinite(createdMs)) ages.push(Math.max(0, Math.floor((tsMs - createdMs) / (24 * hourMs()))));
    }
  }
  ages.sort((a, b) => a - b);
  const backlogById = new Map(input.backlog.map((entry) => [entry.id, entry.status] as const));
  const doneDeliveries = new Set(input.deliveries.filter((d) => d.lifecycleState === "done").map((d) => d.storyId));
  let reopenCount = 0;
  for (const storyId of doneDeliveries) {
    const status = backlogById.get(storyId);
    if (status !== undefined && /todo|in progress|📋|🔨/i.test(status)) reopenCount += 1;
  }
  const current = nonIdleRuns.length === 0 ? null : deliveredRuns.length / nonIdleRuns.length;
  const daily = input.days.map((d) => {
    const rows = windowRuns.filter(({ tsMs, run }) => tsMs >= d.startMs && tsMs < d.endMs && nonIdle(run));
    const value = rows.length === 0 ? 0 : rows.filter(({ run }) => delivered(run)).length / rows.length;
    return { day: d.key, value };
  });
  return {
    current,
    target,
    daily,
    trend: dayValuesTrend(daily),
    met: metricMet(current, target.op, target.value),
    context: {
      nonIdleCycles: nonIdleRuns.length,
      deliveredCycles: deliveredRuns.length,
      skipRate: nonIdleRuns.length === 0 ? null : skipEvents.length / nonIdleRuns.length,
      blockedRate: nonIdleRuns.length === 0 ? null : blockedRuns.length / nonIdleRuns.length,
      reopenCount,
      cardAgeDays: { min: ages[0] ?? null, p50: percentile(ages, 0.5), max: ages.at(-1) ?? null },
      cardTypes,
    },
  };
}

function classifyFix(card: NorthStarCardMeta): "harness" | "product" | "docsTest" {
  const epic = (card.epic ?? "").toLowerCase();
  if (/doc|test|qa/.test(epic)) return "docsTest";
  if (/product|web|site|ui/.test(epic)) return "product";
  return "harness";
}

function buildFixTax(
  input: BuildNorthStarInput,
  windowRuns: Array<{ run: NorthStarRun; tsMs: number }>,
): NorthStarMetric<FixTaxContext> {
  const target = { op: "<" as const, value: 1, unit: "ratio" };
  if (windowRuns.length === 0 && input.cards.length === 0) {
    return noHistoryMetric(target, input.days, {
      newFixCards: 0,
      productDeliveries: 0,
      refactorDeliveries: 0,
      byClass: { harness: 0, product: 0, docsTest: 0 },
      duplicateRootCauseCount: 0,
      repeatedRootCauses: [],
    });
  }
  const fixCards = input.cards.filter((card) => /^FIX-/i.test(card.id) && card.created !== undefined && inWindow(Date.parse(card.created), input.days));
  const byClass: Record<"harness" | "product" | "docsTest", number> = { harness: 0, product: 0, docsTest: 0 };
  for (const card of fixCards) byClass[classifyFix(card)] += 1;
  const productDeliveries = windowRuns.filter(({ run }) => delivered(run) && isUsStory(run.storyId)).length;
  const refactorDeliveries = windowRuns.filter(({ run }) => delivered(run) && isRefactorStory(run.storyId)).length;
  const rootCounts = new Map<string, number>();
  for (const { run } of windowRuns) {
    if (!/^FIX-/i.test(run.storyId ?? "")) continue;
    const key = run.rootCauseKey;
    if (key !== undefined && key !== "") rootCounts.set(key, (rootCounts.get(key) ?? 0) + 1);
  }
  const repeatedRootCauses = [...rootCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const duplicateRootCauseCount = repeatedRootCauses.reduce((sum, item) => sum + item.count, 0);
  const current = productDeliveries === 0 ? null : fixCards.length / productDeliveries;
  const daily = input.days.map((d) => {
    const fixCount = fixCards.filter((card) => {
      const createdMs = Date.parse(card.created ?? "");
      return createdMs >= d.startMs && createdMs < d.endMs;
    }).length;
    const productCount = windowRuns.filter(({ run, tsMs }) => tsMs >= d.startMs && tsMs < d.endMs && delivered(run) && isUsStory(run.storyId)).length;
    return { day: d.key, value: productCount === 0 ? null : fixCount / productCount };
  });
  return {
    current,
    target,
    daily,
    trend: dayValuesTrend(daily),
    met: metricMet(current, target.op, target.value),
    ...(current === null ? { reason: "no_product_deliveries" } : {}),
    context: {
      newFixCards: fixCards.length,
      productDeliveries,
      refactorDeliveries,
      byClass,
      duplicateRootCauseCount,
      repeatedRootCauses,
    },
  };
}

function buildAttribution(
  input: BuildNorthStarInput,
  windowRuns: Array<{ run: NorthStarRun; tsMs: number }>,
): NorthStarMetric<AttributionContext> {
  const target = { op: "=" as const, value: 0, unit: "count" };
  if (windowRuns.length === 0) {
    return noHistoryMetric(target, input.days, {
      failedCycles: 0,
      unknownFailureClass: 0,
      envHarnessCardLedgerSkips: 0,
    });
  }
  const failedRuns = windowRuns.filter(({ run }) => failed(run));
  const unknown = failedRuns.filter(({ run }) => run.failureClass === undefined || run.failureClass === "").length;
  const attributionSkips = input.events.filter((event) => {
    const ts = normalizeEventTimestampMs(event.ts);
    return event.type === "goal:card_skipped" && ts !== null && inWindow(ts, input.days) && (event.failureClass === "env" || event.failureClass === "harness");
  }).length;
  const daily = input.days.map((d) => {
    const dayEvents = input.events.filter((event) => {
      const ts = normalizeEventTimestampMs(event.ts);
      return event.type === "goal:card_skipped" && ts !== null && ts >= d.startMs && ts < d.endMs && (event.failureClass === "env" || event.failureClass === "harness");
    });
    return { day: d.key, value: dayEvents.length };
  });
  return {
    current: attributionSkips,
    target,
    daily,
    trend: dayValuesTrend(daily),
    met: metricMet(attributionSkips, target.op, target.value),
    context: {
      failedCycles: failedRuns.length,
      unknownFailureClass: unknown,
      envHarnessCardLedgerSkips: attributionSkips,
    },
  };
}

export function buildNorthStarReport(input: BuildNorthStarInput): NorthStarReport {
  const days = input.days.slice(-14);
  const first = days[0];
  const last = days[days.length - 1];
  const cardsById = new Map(input.cards.map((card) => [card.id, card] as const));
  const windowRuns = input.runs
    .map((run) => ({ run, tsMs: parseRunTimestampMs(run.ts) }))
    .filter((item): item is { run: NorthStarRun; tsMs: number } => item.tsMs !== null && inWindow(item.tsMs, days));

  return {
    schema: "roll.north.v1",
    generatedAt: new Date(input.nowMs).toISOString(),
    windowDays: 14,
    window: { startDay: first?.key ?? "", endDay: last?.key ?? "" },
    metrics: {
      autonomy: buildAutonomy({ ...input, days }, windowRuns),
      deliveryRate: buildDeliveryRate({ ...input, days }, windowRuns, cardsById),
      fixTax: buildFixTax({ ...input, days }, windowRuns),
      attributionErrors: buildAttribution({ ...input, days }, windowRuns),
    },
  };
}

export function isNorthStarReport(value: unknown): value is NorthStarReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<NorthStarReport>;
  if (typeof report.schema !== "string" || !report.schema.startsWith("roll.north.")) return false;
  const metrics = report.metrics;
  if (metrics === undefined || typeof metrics !== "object") return false;
  const required = ["autonomy", "deliveryRate", "fixTax", "attributionErrors"] as const;
  return required.every((key) => {
    const metric = (metrics as Record<string, unknown>)[key];
    if (metric === null || typeof metric !== "object" || Array.isArray(metric)) return false;
    const row = metric as Partial<NorthStarMetric>;
    return (
      (typeof row.current === "number" || row.current === null) &&
      row.target !== undefined &&
      Array.isArray(row.daily) &&
      (row.trend === "up" || row.trend === "down" || row.trend === "flat") &&
      typeof row.met === "boolean" &&
      row.context !== undefined
    );
  });
}
