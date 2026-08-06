/**
 * US-DELTA-020 — pure, current-truth feature delivery projection.
 *
 * This module deliberately accepts already-read observations. It joins
 * observations into attempts, keeps current final truth separate from
 * windowed process facts, and never writes, routes, merges, or guesses a
 * missing boundary.
 */
import { eventTsMs, type RollEvent, type TcrObservationEvent } from "@roll/spec";
import { projectDeliveryRunTruth, projectDeliveryState } from "../delivery/state.js";

export interface SourceRef { readonly ledgerUri: string; readonly line: number; readonly rawSha256: string; }
export interface ObservedFact { readonly event: RollEvent | TcrObservationEvent; readonly observedAtMs: number; readonly source: SourceRef; }
export interface ReadDiagnostic { readonly code: "malformed_json" | "invalid_event" | "invalid_tcr_v1" | "missing_ledger"; readonly source: Pick<SourceRef, "ledgerUri" | "line">; readonly detail: string; }
export interface QueryWindow { readonly fromMs?: number; readonly toMs?: number; readonly basis: "observed_fact_time"; readonly inclusive: true; }
export interface ResolvedBacklogCard { readonly id: string; readonly title: string; readonly status?: string; readonly epic?: string; }
export interface FeatureDeliveryInput {
  readonly subject: { readonly kind: "feature" | "card"; readonly id: string; readonly title: string };
  readonly cards: readonly ResolvedBacklogCard[];
  /** Valid in-window process observations. */
  readonly facts: readonly ObservedFact[];
  /** Unwindowed admission, delivery and attestation observations. */
  readonly currentTruthFacts: readonly ObservedFact[];
  readonly diagnostics: readonly ReadDiagnostic[];
  readonly window: QueryWindow;
}
export type FinalState = "not_started" | "active" | "blocked" | "handoff_ready" | "delivered" | "attested" | "unknown";
export interface Completeness { readonly incomplete: boolean; readonly codes: readonly string[]; readonly sourceRefs: readonly SourceRef[]; }
export interface StageTiming { readonly designMs: number | null; readonly buildMs: number | null; readonly evaluateMs: number | null; readonly mergeTailMs: number | null; readonly elapsedMs: number | null; readonly codes: readonly string[]; }
export interface TcrSummary { readonly green: number; readonly red: number; readonly incompleteAttempts: number; readonly unattributed: number; }
export interface DeliveryAttempt extends Completeness {
  readonly attemptId: string; readonly kind: "loop" | "delta"; readonly cardId: string; readonly observedAtMs: number;
  readonly outcome: "active" | "blocked" | "handoff_ready" | "failed" | "delivered" | "unknown";
  readonly timing: StageTiming; readonly tcr: TcrSummary;
}
export interface FeatureDeliveryCard extends Completeness { readonly id: string; readonly title: string; readonly finalState: FinalState; readonly attempts: readonly DeliveryAttempt[]; readonly unattributedTcr: number; readonly finalTruth: { readonly main: boolean; readonly backlog: boolean; readonly attestation: boolean; readonly bindingIds: readonly string[]; readonly conflict: boolean; }; }
export interface Rate { readonly numerator: number; readonly denominator: number; readonly value: number | null; readonly excludedIncomplete: number; }
export interface FeatureDeliveryView extends Completeness {
  readonly schemaVersion: 2; readonly subject: FeatureDeliveryInput["subject"]; readonly window: QueryWindow;
  readonly cards: readonly FeatureDeliveryCard[]; readonly diagnostics: readonly ReadDiagnostic[];
  readonly summary: { readonly cards: number; readonly attempts: number; readonly states: Readonly<Record<FinalState, number>>; readonly firstPassDeliveryRate: Rate; readonly redelegateRate: Rate; readonly rework: { readonly attemptsAfterFirst: number }; readonly tcr: TcrSummary; readonly elapsed: { readonly totalMs: number; readonly p50Ms: number | null; readonly p95Ms: number | null; readonly sampleSize: number; }; };
}

type Fact = ObservedFact;
const sourceKey = (f: Fact): string => `${f.source.ledgerUri}:${f.source.line}`;
const order = (a: Fact, b: Fact): number => a.observedAtMs - b.observedAtMs || a.source.ledgerUri.localeCompare(b.source.ledgerUri) || a.source.line - b.source.line;
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const uniqueRefs = (refs: readonly SourceRef[]): SourceRef[] => {
  const byKey = new Map<string, SourceRef>();
  for (const ref of refs) byKey.set(`${ref.ledgerUri}:${ref.line}`, ref);
  return [...byKey.values()];
};
const is = <T extends RollEvent["type"]>(f: Fact, type: T): f is Fact & { readonly event: Extract<RollEvent, { type: T }> } => f.event.type === type;
const id = (f: Fact): string | undefined => "storyId" in f.event ? f.event.storyId : undefined;
const inScope = (f: Fact, cardId: string): boolean => id(f) === cardId;
const inside = (window: QueryWindow, f: Fact): boolean => (window.fromMs === undefined || f.observedAtMs >= window.fromMs) && (window.toMs === undefined || f.observedAtMs <= window.toMs);
const duration = (start: Fact | undefined, end: Fact | undefined, missingStart: string, missingEnd: string, inverted: string, window: QueryWindow): { value: number | null; codes: string[] } => {
  if (start === undefined) return { value: null, codes: [missingStart] };
  if (end === undefined) return { value: null, codes: [missingEnd] };
  if (!inside(window, start) || !inside(window, end)) return { value: null, codes: ["boundary_outside_query_window"] };
  if (end.observedAtMs < start.observedAtMs) return { value: null, codes: [inverted] };
  return { value: end.observedAtMs - start.observedAtMs, codes: [] };
};
function first(facts: readonly Fact[]): Fact | undefined { return [...facts].sort(order)[0]; }
function last(facts: readonly Fact[]): Fact | undefined { return [...facts].sort(order).at(-1); }
function percentile(samples: readonly number[], p: number): number | null { if (samples.length === 0) return null; const sorted = [...samples].sort((a, b) => a - b); return sorted[Math.ceil(p * sorted.length) - 1] ?? null; }
function after(start: Fact | undefined, candidates: readonly Fact[]): Fact | undefined {
  if (start === undefined) return undefined;
  return first(candidates.filter((f) => order(f, start) >= 0));
}
function logicalKey(f: Fact): string | undefined {
  const e = f.event as { readonly type: string };
  if (e.type === "cycle:start") {
    const ev = f.event as Extract<RollEvent, { type: "cycle:start" }>; return `attempt:loop:${ev.cycleId}:start`;
  }
  if (e.type === "delta:prepared") {
    const ev = f.event as Extract<RollEvent, { type: "delta:prepared" }>; return `attempt:delta:${ev.delegationId}:start`;
  }
  if (e.type === "delta:role_started" || e.type === "delta:artifact_published") {
    const ev = f.event as Extract<RollEvent, { type: "delta:role_started" | "delta:artifact_published" }>; return `role:${ev.delegationId}:${ev.role}:${e.type}`;
  }
  if (e.type === "delta:terminal") {
    const ev = f.event as Extract<RollEvent, { type: "delta:terminal" }>; return `terminal:${ev.delegationId}:${e.type}`;
  }
  if (e.type === "delta:attempt_outcome") {
    const ev = f.event as Extract<RollEvent, { type: "delta:attempt_outcome" }>; return `outcome:${ev.delegationId}:${e.type}`;
  }
  if (e.type === "tcr:round_started" || e.type === "tcr:test_finished" || e.type === "tcr:committed") {
    const ev = f.event as TcrObservationEvent; return `tcr:${ev.delegationId ?? ""}:${ev.roundId}:${e.type}`;
  }
  if (e.type === "cycle:tcr") {
    const ev = f.event as Extract<RollEvent, { type: "cycle:tcr" }>; return `cycle-tcr:${ev.cycleId}:${ev.commitHash}`;
  }
  if (e.type === "delivery:merge_confirmed" || e.type === "delivery:reconciled") {
    const ev = f.event as Extract<RollEvent, { type: "delivery:merge_confirmed" | "delivery:reconciled" }>; const stable = "mergeCommit" in ev ? ev.mergeCommit : "state" in ev ? ev.state : ev.cycleId; return `delivery:${ev.cycleId}:${e.type}:${String(stable ?? "")}`;
  }
  if (e.type === "delivery:published" || e.type === "delivery:abandoned") {
    const ev = f.event as Extract<RollEvent, { type: "delivery:published" | "delivery:abandoned" }>; return `delivery:${ev.cycleId}:${e.type}:${"prNumber" in ev ? ev.prNumber : "branch" in ev ? ev.branch : ""}`;
  }
  return undefined;
}
function ambiguousKeys(facts: readonly Fact[]): Set<string> {
  const counts = new Map<string, number>();
  for (const f of facts) { const key = logicalKey(f); if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1); }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}
function ambiguousCodes(keys: Set<string>): string[] { return [...keys].map((key) => `ambiguous_duplicate_observation:${key}`).sort(); }

/** Build a view without I/O, clocks, locale, or argument parsing. */
export function buildFeatureDeliveryView(input: FeatureDeliveryInput): FeatureDeliveryView {
  const cardIds = new Set(input.cards.map((c) => c.id));
  const facts = dedupeRows(input.facts).filter((f) => id(f) === undefined || cardIds.has(id(f)!));
  const truth = dedupeRows(input.currentTruthFacts).filter((f) => id(f) === undefined || cardIds.has(id(f)!));
  const cards = input.cards.map((card) => projectCard(card, facts, truth, input.window));
  const allAttempts = cards.flatMap((c) => c.attempts);
  const states: Record<FinalState, number> = { not_started: 0, active: 0, blocked: 0, handoff_ready: 0, delivered: 0, attested: 0, unknown: 0 };
  for (const card of cards) states[card.finalState] += 1;
  const delivered = cards.filter((c) => c.finalState === "delivered" || c.finalState === "attested");
  const firstPassDenominator = delivered.filter((c) => c.attempts.length > 0 && !c.incomplete);
  const firstPassNumerator = firstPassDenominator.filter((c) => c.attempts[0]?.outcome === "delivered").length;
  const deltaCards = cards.filter((c) => c.attempts.some((a) => a.kind === "delta"));
  const redelegated = deltaCards.filter((c) => c.attempts.filter((a) => a.kind === "delta").length >= 2).length;
  const elapsed = allAttempts.map((a) => a.timing.elapsedMs).filter((v): v is number => v !== null);
  const tcr = allAttempts.reduce<TcrSummary>((acc, a) => ({ green: acc.green + a.tcr.green, red: acc.red + a.tcr.red, incompleteAttempts: acc.incompleteAttempts + a.tcr.incompleteAttempts, unattributed: acc.unattributed + a.tcr.unattributed }), { green: 0, red: 0, incompleteAttempts: 0, unattributed: 0 });
  const reworkAttemptsAfterFirst = cards.reduce((sum, c) => sum + (c.attempts.length > 1 ? c.attempts.length - 1 : 0), 0);
  const codes = unique([...input.diagnostics.map((d) => d.code), ...cards.flatMap((c) => c.codes)]).sort();
  return {
    schemaVersion: 2, subject: input.subject, window: input.window, cards, diagnostics: input.diagnostics,
    incomplete: codes.length > 0 || cards.some((c) => c.incomplete), codes,
    sourceRefs: uniqueRefs([...facts, ...truth].map((f) => f.source)).sort((a, b) => a.ledgerUri.localeCompare(b.ledgerUri) || a.line - b.line),
    summary: { cards: cards.length, attempts: allAttempts.length, states,
      firstPassDeliveryRate: rate(firstPassNumerator, firstPassDenominator.length, delivered.length - firstPassDenominator.length),
      redelegateRate: rate(redelegated, deltaCards.length, 0), rework: { attemptsAfterFirst: reworkAttemptsAfterFirst }, tcr,
      elapsed: { totalMs: elapsed.reduce((a, b) => a + b, 0), p50Ms: percentile(elapsed, .5), p95Ms: percentile(elapsed, .95), sampleSize: elapsed.length },
    },
  };
}
function rate(numerator: number, denominator: number, excludedIncomplete: number): Rate { return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator, excludedIncomplete }; }
function dedupeRows(facts: readonly Fact[]): Fact[] { const seen = new Set<string>(); return facts.filter((f) => { const key = sourceKey(f); if (seen.has(key)) return false; seen.add(key); return true; }); }

function projectCard(card: ResolvedBacklogCard, facts: readonly Fact[], truth: readonly Fact[], window: QueryWindow): FeatureDeliveryCard {
  const cardFacts = facts.filter((f) => inScope(f, card.id));
  const cardTruth = truth.filter((f) => inScope(f, card.id));
  const combined = dedupeRows([...cardFacts, ...cardTruth]);
  const ambiguous = ambiguousKeys(combined);
  const cleanFacts = cardFacts.filter((f) => !ambiguous.has(logicalKey(f) ?? ""));
  const cleanTruth = cardTruth.filter((f) => !ambiguous.has(logicalKey(f) ?? ""));
  const admissions = cleanFacts.filter((f) => is(f, "cycle:start") || is(f, "delta:prepared"));
  const attempts: DeliveryAttempt[] = [];
  for (const start of admissions.sort(order)) {
    if (is(start, "cycle:start")) attempts.push(projectLoop(start, cleanFacts, cleanTruth, window));
    else attempts.push(projectDelta(start, cleanFacts, cleanTruth, window));
  }
  const currentAdmissions = cleanTruth.filter((f) => is(f, "cycle:start") || is(f, "delta:prepared"));
  const unattributed = countUnattributedTcr(cardFacts, cleanTruth);
  const truthResult = finalTruth(card, cleanTruth, attempts, currentAdmissions);
  const codes = unique([...attempts.flatMap((a) => a.codes), ...ambiguousCodes(ambiguous), ...(unattributed > 0 ? ["tcr_unattributable_without_binding"] : []), ...truthResult.codes]).sort();
  const refs = uniqueRefs([...cardFacts, ...cardTruth].map((f) => f.source));
  return { id: card.id, title: card.title, finalState: truthResult.state, attempts: attempts.sort((a, b) => a.observedAtMs - b.observedAtMs || a.attemptId.localeCompare(b.attemptId)), unattributedTcr: unattributed, incomplete: codes.length > 0, codes, sourceRefs: refs, finalTruth: truthResult.truth };
}
function countUnattributedTcr(cardFacts: readonly Fact[], truth: readonly Fact[]): number {
  const admittedDelta = new Set(truth.filter((f) => is(f, "delta:prepared")).map((f) => (f.event as Extract<RollEvent, { type: "delta:prepared" }>).delegationId));
  return cardFacts.filter((f) => {
    if (!f.event.type.startsWith("tcr:")) return false;
    if (!("delegationId" in f.event) || f.event.delegationId === undefined) return true;
    return !admittedDelta.has(f.event.delegationId);
  }).length;
}
function projectLoop(start: Fact & { readonly event: Extract<RollEvent, { type: "cycle:start" }> }, facts: readonly Fact[], truth: readonly Fact[], window: QueryWindow): DeliveryAttempt {
  const cycleId = start.event.cycleId;
  const related = facts.filter((f) => "cycleId" in f.event && f.event.cycleId === cycleId);
  const truthRelated = truth.filter((f) => "cycleId" in f.event && f.event.cycleId === cycleId);
  const build = duration(first(related.filter((f) => is(f, "cycle:first_edit"))), last(related.filter((f) => is(f, "cycle:tcr"))), "missing_loop_build_start", "missing_loop_build_end", "inverted_loop_build", window);
  const end = first(related.filter((f) => is(f, "cycle:end"))) ?? first(related.filter((f) => is(f, "delivery:merge_confirmed") || is(f, "delivery:reconciled")));
  const elapsed = duration(start, end, "missing_attempt_terminal", "missing_attempt_terminal", "inverted_attempt_elapsed", window);
  const publish = first(related.filter((f) => is(f, "delivery:published")));
  const main = first(related.filter((f) => is(f, "delivery:merge_confirmed") || is(f, "delivery:reconciled")));
  const merge = duration(publish, main, "missing_merge_publish", "missing_merge_main_proof", "inverted_merge_tail", window);
  const state = projectDeliveryState(truthRelated.map((f) => f.event as RollEvent), cycleId);
  const outcome: DeliveryAttempt["outcome"] = state.startsWith("delivered") ? "delivered" : state === "blocked_no_evidence" ? "blocked" : state === "abandoned" ? "failed" : "active";
  const tcr = { green: 0, red: 0, incompleteAttempts: 0, unattributed: 0 };
  const codes = unique([...build.codes, ...elapsed.codes, ...merge.codes, "unsupported_loop_stage_boundary"]);
  return { attemptId: `loop:${cycleId}`, kind: "loop", cardId: start.event.storyId, observedAtMs: start.observedAtMs, outcome, timing: { designMs: null, buildMs: build.value, evaluateMs: null, mergeTailMs: merge.value, elapsedMs: elapsed.value, codes }, tcr, incomplete: codes.length > 0, codes, sourceRefs: related.map((f) => f.source) };
}
function projectDelta(start: Fact & { readonly event: Extract<RollEvent, { type: "delta:prepared" }> }, facts: readonly Fact[], truth: readonly Fact[], window: QueryWindow): DeliveryAttempt {
  const did = start.event.delegationId;
  const related = facts.filter((f) => "delegationId" in f.event && f.event.delegationId === did);
  const truthRelated = truth.filter((f) => "delegationId" in f.event && f.event.delegationId === did);
  const roleStage = (role: "designer" | "builder" | "evaluator") => {
    const roleStart = first(related.filter((f) => is(f, "delta:role_started") && f.event.role === role));
    const roleArtifact = after(roleStart, related.filter((f) => is(f, "delta:artifact_published") && f.event.role === role));
    return duration(roleStart, roleArtifact, `missing_${role}_start`, `missing_${role}_artifact`, `inverted_${role}_stage`, window);
  };
  const design = roleStage("designer"), build = roleStage("builder"), evaluate = roleStage("evaluator");
  const terminal = first(related.filter((f) => is(f, "delta:terminal"))) as (Fact & { readonly event: Extract<RollEvent, { type: "delta:terminal" }> }) | undefined;
  const outcomes = related.filter((f) => is(f, "delta:attempt_outcome")) as Array<Fact & { readonly event: Extract<RollEvent, { type: "delta:attempt_outcome" }> }>;
  const elapsed = duration(start, terminal, "missing_attempt_terminal", "missing_attempt_terminal", "inverted_attempt_elapsed", window);
  let outcome: DeliveryAttempt["outcome"];
  const outcomeCodes: string[] = [];
  if (terminal === undefined && outcomes.length > 0) { outcome = "unknown"; outcomeCodes.push("missing_delta_terminal"); }
  else if (terminal !== undefined && outcomes.length > 1) { outcome = "unknown"; outcomeCodes.push("delta_outcome_terminal_conflict"); }
  else if (terminal !== undefined && outcomes.length === 1 && outcomes[0]?.event.terminalFact !== terminal.event.outcome) { outcome = "unknown"; outcomeCodes.push("delta_outcome_terminal_conflict"); }
  else if (terminal !== undefined) outcome = terminal.event.outcome === "blocked" ? "blocked" : terminal.event.outcome === "handoff_ready" ? "handoff_ready" : "failed";
  else outcome = "active";
  const cycleId = start.event.cycleId;
  const deltaDelivery = cycleId === undefined ? [] : facts.filter((f) => "cycleId" in f.event && f.event.cycleId === cycleId);
  const mergePublish = first(deltaDelivery.filter((f) => is(f, "delivery:published")));
  const mergeMain = first(deltaDelivery.filter((f) => is(f, "delivery:merge_confirmed") || is(f, "delivery:reconciled")));
  const merge = cycleId === undefined ? { value: null, codes: ["unbound_delta_delivery"] } : duration(mergePublish, mergeMain, "missing_delta_delivery_publish", "missing_delta_delivery_main_proof", "inverted_delta_merge_tail", window);
  const tcr = projectDeltaTcr(related);
  const codes = unique([...design.codes, ...build.codes, ...evaluate.codes, ...elapsed.codes, ...merge.codes, ...outcomeCodes]);
  void truthRelated;
  return { attemptId: `delta:${did}`, kind: "delta", cardId: start.event.storyId, observedAtMs: start.observedAtMs, outcome, timing: { designMs: design.value, buildMs: build.value, evaluateMs: evaluate.value, mergeTailMs: merge.value, elapsedMs: elapsed.value, codes }, tcr, incomplete: codes.length > 0, codes, sourceRefs: related.map((f) => f.source) };
}
function projectDeltaTcr(related: readonly Fact[]): TcrSummary {
  const rounds = new Map<string, Fact[]>();
  for (const f of related) {
    if (!f.event.type.startsWith("tcr:")) continue;
    const ev = f.event as TcrObservationEvent;
    rounds.set(ev.roundId, [...(rounds.get(ev.roundId) ?? []), f]);
  }
  let green = 0, red = 0, incompleteAttempts = 0;
  for (const fs of rounds.values()) {
    const types = new Set(fs.map((f) => f.event.type));
    const finished = fs.filter((f) => f.event.type === "tcr:test_finished");
    if (!(types.has("tcr:round_started") && types.has("tcr:test_finished") && types.has("tcr:committed")) || finished.length !== 1) { incompleteAttempts += 1; continue; }
    const test = finished[0]?.event as Extract<TcrObservationEvent, { type: "tcr:test_finished" }>;
    if (test !== undefined && test.exitCode === 0) green += 1; else red += 1;
  }
  return { green, red, incompleteAttempts, unattributed: 0 };
}
function finalTruth(card: ResolvedBacklogCard, truth: readonly Fact[], visibleAttempts: readonly DeliveryAttempt[], currentAdmissions: readonly Fact[]): { state: FinalState; codes: string[]; truth: FeatureDeliveryCard["finalTruth"] } {
  const events = truth.map((f) => f.event as RollEvent);
  const loopAdmissions = currentAdmissions.filter((f) => is(f, "cycle:start")) as Array<Fact & { readonly event: Extract<RollEvent, { type: "cycle:start" }> }>;
  const deltaAdmissions = currentAdmissions.filter((f) => is(f, "delta:prepared")) as Array<Fact & { readonly event: Extract<RollEvent, { type: "delta:prepared" }> }>;
  const cycleIds = unique([
    ...visibleAttempts.filter((a) => a.kind === "loop").map((a) => a.attemptId.slice(5)),
    ...loopAdmissions.map((f) => f.event.cycleId),
    ...deltaAdmissions.map((f) => f.event.cycleId).filter((v): v is string => v !== undefined),
  ]);
  const deltaByCycle = new Map<string, string[]>();
  for (const d of deltaAdmissions) { if (d.event.cycleId === undefined) continue; const list = deltaByCycle.get(d.event.cycleId) ?? []; list.push(d.event.delegationId); deltaByCycle.set(d.event.cycleId, list); }
  let main = false, attestation = false, conflict = false, block = false, handoff = false;
  const codes: string[] = [];
  for (const cycle of cycleIds) {
    const run = projectDeliveryRunTruth(events, cycle);
    if (!run.factsAgree) conflict = true;
    if (run.merge === "merged") {
      main = true;
      const hostDelta = truth.some((f) => is(f, "attest:host_delta") && f.event.cycleId === cycle && f.event.storyId === card.id && (deltaByCycle.get(cycle) ?? []).includes(f.event.delegationId));
      if (run.evidence === "accepted" || hostDelta) attestation = true;
    }
    if (projectDeliveryState(events, cycle) === "blocked_no_evidence") block = true;
  }
  const hostDeltaEvents = truth.filter((f) => is(f, "attest:host_delta") && f.event.storyId === card.id);
  for (const f of hostDeltaEvents) {
    const ev = f.event as Extract<RollEvent, { type: "attest:host_delta" }>;
    const valid = cycleIds.includes(ev.cycleId) && (deltaByCycle.get(ev.cycleId) ?? []).includes(ev.delegationId);
    if (!valid) codes.push("unbound_host_delta_attestation");
  }
  for (const a of visibleAttempts) { if (a.outcome === "blocked") block = true; if (a.outcome === "handoff_ready") handoff = true; }
  const admittedDelta = new Set(deltaAdmissions.map((f) => f.event.delegationId));
  for (const terminal of truth.filter((f) => is(f, "delta:terminal") && f.event.storyId === card.id)) {
    const ev = terminal.event as Extract<RollEvent, { type: "delta:terminal" }>;
    if (!admittedDelta.has(ev.delegationId)) continue;
    if (ev.outcome === "blocked") block = true;
    if (ev.outcome === "handoff_ready") handoff = true;
  }
  const manualMerge = truth.some((f) => is(f, "pr:merge") && f.event.storyId === card.id);
  if (manualMerge && !main) codes.push("manual_merge_unproven");
  if (conflict && main) codes.push("conflicting_delivery_truth");
  const backlog = /done/i.test(card.status ?? "");
  const bindingIds = unique([...loopAdmissions.map((f) => `loop:${f.event.cycleId}`), ...deltaAdmissions.map((f) => `delta:${f.event.delegationId}`)]);
  const state: FinalState = conflict && main ? "unknown" : main && attestation ? "attested" : main ? "delivered" : manualMerge ? "unknown" : block ? "blocked" : handoff ? "handoff_ready" : currentAdmissions.length > 0 ? "active" : backlog ? "unknown" : "not_started";
  if (backlog && !main) codes.push("backlog_done_unproven");
  return { state, codes, truth: { main, backlog, attestation, bindingIds, conflict } };
}

/** Exposed for adapters which need the canonical timestamp normalization. */
export function observedEventMs(event: RollEvent | TcrObservationEvent): number { return eventTsMs(event.ts); }
