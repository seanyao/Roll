/**
 * @responsibility Provides the read-only adapter for `roll supervisor delivery`.
 */
/** Read-only adapter for `roll supervisor delivery`.  All aggregation belongs in core. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildFeatureDeliveryView, observedEventMs, parseBacklog, type FeatureDeliveryInput, type FeatureDeliveryView, type ObservedFact, type ReadDiagnostic, type ResolvedBacklogCard } from "@roll/core";
import { parseEventLine, parseTcrObservationEvent, resolveLang, type RollEvent } from "@roll/spec";

export type DeliveryCommandResult = { readonly ok: true; readonly view: FeatureDeliveryView } | { readonly ok: false; readonly code: string; readonly message: string };
export interface DeliveryArgs { readonly subject?: string; readonly fromMs?: number; readonly toMs?: number; readonly json: boolean; }

export function parseDeliveryArgs(args: readonly string[]): DeliveryArgs | { readonly error: string } {
  const rest = args.filter((a) => a !== "delivery" && a !== "--json");
  let subject: string | undefined; let fromMs: number | undefined; let toMs: number | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? "";
    if (token === "--from" || token === "--to") {
      const value = rest[++i]; if (value === undefined || value.startsWith("-")) return { error: `missing_${token.slice(2)}` };
      const ms = parseInstant(value); if (ms === undefined) return { error: `invalid_${token.slice(2)}` };
      if (token === "--from") { if (fromMs !== undefined) return { error: "duplicate_from" }; fromMs = ms; } else { if (toMs !== undefined) return { error: "duplicate_to" }; toMs = ms; }
    } else if (token.startsWith("-")) return { error: "unknown_argument" };
    else if (subject === undefined) subject = token;
    else return { error: "duplicate_subject" };
  }
  if (subject === undefined) return { error: "missing_subject" };
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) return { error: "reversed_window" };
  return { subject, fromMs, toMs, json: args.includes("--json") };
}

function parseInstant(value: string): number | undefined {
  // Date.parse accepts non-ISO spellings; the public contract does not.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const ms = Date.parse(value); return Number.isFinite(ms) ? ms : undefined;
}
const sha = (raw: string): string => createHash("sha256").update(raw, "utf8").digest("hex");
function eventRows(path: string, fromMs: number | undefined, toMs: number | undefined): { facts: ObservedFact[]; truth: ObservedFact[]; diagnostics: ReadDiagnostic[] } {
  if (!existsSync(path)) return { facts: [], truth: [], diagnostics: [{ code: "missing_ledger", source: { ledgerUri: path, line: 0 }, detail: "ledger unavailable" }] };
  const facts: ObservedFact[] = [], truth: ObservedFact[] = [], diagnostics: ReadDiagnostic[] = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ""; if (raw.trim() === "") continue;
    const source = { ledgerUri: path, line: index + 1, rawSha256: sha(raw) };
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(raw) as unknown; } catch { diagnostics.push({ code: "malformed_json", source, detail: "JSON parse failed" }); continue; }
    const event = parseEventLine(raw);
    if (event === null) { diagnostics.push({ code: "invalid_event", source, detail: "not a valid Roll event" }); continue; }
    if (event.type.startsWith("tcr:") && parseTcrObservationEvent(event) === null) { diagnostics.push({ code: "invalid_tcr_v1", source, detail: "invalid versioned TCR observation" }); continue; }
    void parsedJson;
    const observedAtMs = observedEventMs(event); const fact = { event, observedAtMs, source } as ObservedFact;
    const truthType = event.type === "cycle:start" || event.type === "delta:prepared" || event.type === "delta:terminal" || event.type === "delta:attempt_outcome" || event.type === "pr:merge" || event.type.startsWith("delivery:") || event.type.startsWith("attest:");
    if (truthType) truth.push(fact);
    if ((fromMs === undefined || observedAtMs >= fromMs) && (toMs === undefined || observedAtMs <= toMs)) facts.push(fact);
  }
  return { facts, truth, diagnostics };
}
function resolveScope(projectPath: string, subject: string): { cards: ResolvedBacklogCard[]; kind: "card" | "feature"; title: string } | { error: string } {
  const backlogPath = join(projectPath, ".roll", "backlog.md");
  if (!existsSync(backlogPath)) return { error: "missing_backlog" };
  const parsed = parseBacklog(readFileSync(backlogPath, "utf8"));
  const duplicate = parsed.filter((c) => c.id === subject); if (duplicate.length > 1) return { error: "duplicate_card_id" };
  const card = duplicate[0]; if (card !== undefined) return { cards: [{ id: card.id, title: card.desc, status: card.status }], kind: "card", title: card.desc };
  const indexPath = join(projectPath, ".roll", "index.json"); let features = new Set<string>();
  try { const index = JSON.parse(readFileSync(indexPath, "utf8")) as { stories?: Record<string, string> }; features = new Set(Object.values(index.stories ?? {})); } catch { /* registry absent means no feature match */ }
  if (!features.has(subject)) return { error: "subject_not_found" };
  // Backlog's table intentionally stores no epic column.  Registry membership is the authoritative current feature mapping.
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as { stories?: Record<string, string> };
  const ids = new Set(Object.entries(index.stories ?? {}).filter(([, epic]) => epic === subject).map(([id]) => id));
  return { cards: parsed.filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, title: c.desc, status: c.status, epic: subject })), kind: "feature", title: subject };
}

export function readFeatureDelivery(projectPath: string, args: DeliveryArgs): DeliveryCommandResult {
  const scope = resolveScope(projectPath, args.subject ?? ""); if ("error" in scope) return { ok: false, code: scope.error, message: scope.error };
  const canonical = (path: string): string => resolve(path);
  const paths = [canonical(join(projectPath, ".roll", "events.ndjson")), canonical(join(projectPath, ".roll", "loop", "events.ndjson"))];
  const rows = paths.map((path) => eventRows(path, args.fromMs, args.toMs));
  const input: FeatureDeliveryInput = { subject: { kind: scope.kind, id: args.subject!, title: scope.title }, cards: scope.cards, facts: rows.flatMap((r) => r.facts), currentTruthFacts: rows.flatMap((r) => r.truth), diagnostics: rows.flatMap((r) => r.diagnostics), window: { ...(args.fromMs === undefined ? {} : { fromMs: args.fromMs }), ...(args.toMs === undefined ? {} : { toMs: args.toMs }), basis: "observed_fact_time", inclusive: true } };
  return { ok: true, view: buildFeatureDeliveryView(input) };
}

const pct = (v: number | null): string => v === null ? "n/a" : `${Math.round(v * 100)}%`;
const duration = (v: number | null): string => v === null ? "n/a" : `${v}ms`;
export function renderFeatureDelivery(view: FeatureDeliveryView): string {
  const zh = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] }) === "zh";
  const lines = zh ? [`交付视图：${view.subject.id}`, `卡片 ${view.summary.cards} · 尝试 ${view.summary.attempts}`] : [`Delivery view: ${view.subject.id}`, `Cards ${view.summary.cards} · attempts ${view.summary.attempts}`];
  for (const card of view.cards) { lines.push(zh ? `- ${card.id}：${card.finalState}` : `- ${card.id}: ${card.finalState}`); for (const attempt of card.attempts) lines.push(zh ? `  ${attempt.attemptId} · ${attempt.outcome} · 耗时 ${duration(attempt.timing.elapsedMs)}` : `  ${attempt.attemptId} · ${attempt.outcome} · elapsed ${duration(attempt.timing.elapsedMs)}`); }
  const rate = view.summary.firstPassDeliveryRate;
  lines.push(zh ? `首轮交付 ${rate.numerator}/${rate.denominator} (${pct(rate.value)}；排除不完整 ${rate.excludedIncomplete})` : `First-pass ${rate.numerator}/${rate.denominator} (${pct(rate.value)}; ${rate.excludedIncomplete} incomplete excluded)`);
  lines.push(zh ? `返工后尝试 ${view.summary.rework.attemptsAfterFirst}` : `Rework attempts after first ${view.summary.rework.attemptsAfterFirst}`);
  lines.push(zh ? `耗时样本 ${view.summary.elapsed.sampleSize} · P50 ${duration(view.summary.elapsed.p50Ms)} · P95 ${duration(view.summary.elapsed.p95Ms)}` : `Elapsed samples ${view.summary.elapsed.sampleSize} · P50 ${duration(view.summary.elapsed.p50Ms)} · P95 ${duration(view.summary.elapsed.p95Ms)}`);
  if (view.codes.length > 0) lines.push(zh ? `不完整：${view.codes.join(", ")}` : `Incomplete: ${view.codes.join(", ")}`);
  return "\n" + lines.join("\n") + "\n";
}
