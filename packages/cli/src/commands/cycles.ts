/**
 * @responsibility Runs the `cycles` subcommand, rendering the cycle ledger as a first-class command.
 */
/**
 * US-CLI-012 — `roll cycles [--since 1d|3d|7d|all]`: the cycle ledger as a
 * first-class command. cycle is a first-class noun in the philosophy; now it
 * has a name on the command surface too. Same aggregation as the web ledger
 * (collectCycleLedger), same verdict vocabulary, and the summary line counts
 * failed = failed + reverted + blocked — never swallowed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLang, type DeliveryState, type Lang, type RollEvent, parseEventLine } from "@roll/spec";
import { extractCycleSignals, parseBacklog, projectDeliveryState, signalKindForMarker, type TimelineEntry, readDeliveries, nodeDeliveryStore } from "@roll/core";
import {
  bucketCounts,
  collectCycleLedger,
  deliveryMetrics,
  formatBuilderIdentity,
  CYCLE_VERDICTS,
  ledgerFailedCount,
  reconcileCyclesWithDelivery,
  reconcileDeliveredUnpublishedVerdicts,
  reconcileDeliveryStateProjection,
  reconcileSupersededVerdicts,
  type CycleLedgerRow,
  type CycleLedgerVerdict,
  type DeliveryMetrics,
} from "../lib/cycle-ledger.js";
import { cycleReconcileDecision } from "../lib/delivery-facts.js";
import { collectGitDossierFacts, storyHasMergeEvidence, type GitDossierFacts } from "../lib/story-dossier.js";
import { findCycle } from "./cycle.js";

/**
 * FIX-337 (AC3) — a story is SUPERSEDED (delivered elsewhere, so this cycle's old
 * failure must not inflate the failed count) when EITHER:
 *   (a) its `.roll/backlog.md` status cell is Done (carries ✅ or "Done"), OR
 *   (b) main carries merge evidence for it (a commit subject/`(#N)` names the id).
 * Built once per render from the backlog text + the SAME offline git facts the
 * pending-merge reconcile already uses (no gh call). Returns a pure predicate so
 * {@link reconcileSupersededVerdicts} stays injectable/testable.
 */
function buildIsStorySuperseded(cwd: string, git: GitDossierFacts | null): (storyId: string) => boolean {
  const done = new Set<string>();
  const backlogPath = `${cwd}/.roll/backlog.md`;
  if (existsSync(backlogPath)) {
    try {
      for (const item of parseBacklog(readFileSync(backlogPath, "utf8"))) {
        if (item.status.includes("✅") || /\bDone\b/i.test(item.status)) done.add(item.id);
      }
    } catch {
      /* unreadable backlog → backlog signal empty; merge-evidence still applies */
    }
  }
  return (storyId) => storyId !== "" && (done.has(storyId) || storyHasMergeEvidence(git, storyId));
}

/**
 * US-DELIV-008 — the cycle ledger's delivery backfill now runs through the
 * SINGLE reconcile truth engine: each pending_merge/unpublished row is judged
 * by `cycleReconcileDecision` (offline L1 + patch-id L2 → the pure
 * `reconcileDelivery` of US-DELIV-002), the SAME engine `roll loop reconcile`
 * runs. The retired subject-match probe (reconcilePendingMergeVerdicts +
 * cycleMergeTruth) was a parallel second criterion that could disagree with
 * the command — and was blind to squash merges whose subject names neither
 * the story nor the PR. One engine, two callers, no divergence.
 *
 * FIX-347/348/350 (history): the render-time merge-truth backfill and its
 * cycle-accuracy rule (a row WITH a recorded PR is judged SOLELY by that PR)
 * survive inside the engine — offlineMergeEvidence keeps the exact-number and
 * no-PR-fallback semantics; patch-id L2 adds the offline, gh-free path.
 *
 * FIX-337 (AC1/AC3) — THE single canonical ledger pipeline:
 *   collectCycleLedger → reconcileDeliveredUnpublishedVerdicts
 *   → reconcileCyclesWithDelivery → reconcileSupersededVerdicts.
 * Exported so `roll index` (the truth.json cycle panel) reuses the EXACT same
 * derivation, so `roll cycles` and `roll status` (which reads truth.json) can
 * never diverge. The superseded reconcile re-labels a failed/pending cycle whose
 * card landed elsewhere (backlog Done or merge evidence) so it stops inflating
 * the failed count.
 */
export function reconciledLedger(cwd: string): CycleLedgerRow[] {
  const git = collectGitDossierFacts(cwd);
  const collected = collectCycleLedger(cwd);
  // FIX-1064: read delivery records to build the set of cycle IDs that have a
  // `done` delivery record. Only these cycles should show as `delivered` in
  // the unpublished→delivered reconciliation — not cycles whose story merely
  // shipped via some other cycle.
  const deliveries = readDeliveries(nodeDeliveryStore, cwd);
  const deliveringCycles = new Set(
    deliveries.filter((d) => d.lifecycleState === "done").map((d) => d.cycleId),
  );
  const isSuperseded = buildIsStorySuperseded(cwd, git);
  const unpublishedDelivered = reconcileDeliveredUnpublishedVerdicts(collected, isSuperseded, deliveringCycles);
  // US-DELIV-008: the unified engine judges every remaining pending/unpublished
  // row from the SAME facts the reconcile command would gather.
  const merged = reconcileCyclesWithDelivery(unpublishedDelivered, (row) =>
    cycleReconcileDecision(cwd, git, {
      cycleId: row.cycleId,
      storyId: row.storyId,
      branch: row.branch,
      prNumber: row.prNumber,
    }),
  );
  // US-DELIV-012: fold the event stream once into the EVENT-AUTHORITATIVE
  // delivery projection so the ledger renders `delivered_external` (the
  // hand/supervisor-merge share the offline decision cannot see) and carries the
  // awaiting_merge dwell anchor for the delivery metrics. Read-only.
  const { stateFor, awaitingSince } = deliveryProjections(readAllEvents(cwd));
  const projected = reconcileDeliveryStateProjection(
    merged,
    (cid) => stateFor.get(cid),
    (cid) => awaitingSince.get(cid),
  );
  return reconcileSupersededVerdicts(projected, isSuperseded);
}

/**
 * US-DELIV-012 — fold the loop event stream ONCE into the two per-cycle
 * projections the ledger's delivery reconcile needs: the event-authoritative
 * {@link DeliveryState} (via the single `projectDeliveryState` writer) and the
 * `delivery:published` ts (the awaiting_merge dwell anchor). One pass — never
 * `projectDeliveryState` per cycle over the full stream (its docstring's O(n×m)
 * warning).
 */
function deliveryProjections(events: RollEvent[]): {
  stateFor: Map<string, DeliveryState>;
  awaitingSince: Map<string, number>;
} {
  const byCycle = new Map<string, RollEvent[]>();
  const awaitingSince = new Map<string, number>();
  for (const ev of events) {
    if (!("cycleId" in ev) || typeof (ev as { cycleId?: unknown }).cycleId !== "string") continue;
    const cid = (ev as { cycleId: string }).cycleId;
    let arr = byCycle.get(cid);
    if (arr === undefined) {
      arr = [];
      byCycle.set(cid, arr);
    }
    arr.push(ev);
    if (ev.type === "delivery:published" && !awaitingSince.has(cid)) awaitingSince.set(cid, ev.ts);
  }
  const stateFor = new Map<string, DeliveryState>();
  for (const [cid, evs] of byCycle) stateFor.set(cid, projectDeliveryState(evs, cid));
  return { stateFor, awaitingSince };
}
import { c, renderState, stripAnsi } from "../render.js";

export const CYCLES_USAGE =
  "Usage: roll cycles [--since 1d|3d|7d|all] [--detail <id>]\n" +
  "  The cycle ledger: one line per cycle, failures never swallowed (default --since 3d).\n" +
  "  --detail <id>  the per-cycle build-phase timeline (per-commit / heartbeat timing).\n" +
  "周期账本：每行一个 cycle，失败不被吞（默认 --since 3d）。\n" +
  "  --detail <id>  单个 cycle 的 build 阶段时间线（每提交/心跳计时）。";

const WINDOWS: Record<string, number> = { "1d": 1, "3d": 3, "7d": 7 };

/** Display handle: the trailing digit run (the mockup's #0312), falling back
 *  to the last 5 chars for ids without one. `roll cycle <handle>` resolves it. */
export function cycleNo(cycleId: string): string {
  const m = /(\d+)$/.exec(cycleId);
  return m?.[1] !== undefined ? m[1].slice(-5) : cycleId.slice(-5);
}

const VERDICT_COLOR: Record<string, string> = {
  delivered: "green",
  delivered_external: "green", // US-DELIV-012: hand/supervisor merge — a real delivery, green
  degraded: "yellow", // US-DELIV-012: awaiting_merge stuck (US-DELIV-010) — amber, needs triage
  pending_merge: "yellow", // FIX-322: opened a PR, merge pending — in-flight, NOT delivered (amber)
  unpublished: "blue", // FIX-351: gates passed, work local, publish didn't land — neutral, NOT red
  superseded: "blue", // FIX-337: card landed elsewhere (backlog Done / merge evidence) — neutral, NOT red
  reverted: "yellow",
  failed: "red",
  blocked: "purple",
  agent_internal_failure: "red", // FIX-1051: internal tool error — failed-class, red
  idle: "muted",
  unknown: "muted",
};

// FIX-337 (AC2): the summary buckets, in display order, with their bilingual
// labels. `failed/reverted/blocked` are GROUPED into one "failed/reverted/blocked"
// figure (the FIX-248 vocabulary), but every other non-zero bucket is shown so
// the displayed total === the sum of all buckets.
const BUCKET_LABEL: Record<CycleLedgerVerdict, { en: string; zh: string }> = {
  delivered: { en: "delivered", zh: "已交付" },
  // US-DELIV-012: the delivery-reconciler vocabulary (design §3.1) — a
  // hand/supervisor merge and a degraded awaiting_merge are first-class labels.
  delivered_external: { en: "delivered (external)", zh: "外部合并" },
  degraded: { en: "degraded", zh: "降级" },
  // US-DELIV-012: `pending_merge` IS the design's `awaiting_merge` suspension;
  // present the design vocabulary so the ledger no longer shows only old words.
  pending_merge: { en: "awaiting_merge", zh: "待合并" },
  unpublished: { en: "unpublished", zh: "未发布" },
  superseded: { en: "superseded", zh: "已被取代" },
  failed: { en: "failed/reverted/blocked", zh: "失败/回滚/阻塞" },
  blocked: { en: "blocked", zh: "阻塞" },
  reverted: { en: "reverted", zh: "回滚" },
  agent_internal_failure: { en: "agent_internal_failure", zh: "代理内部故障" },
  idle: { en: "idle", zh: "空转" },
  unknown: { en: "unknown", zh: "未知" },
};

/**
 * FIX-337 (AC2) — the summary buckets line: ALL non-zero buckets, with
 * `failed+reverted+blocked` folded into one `failed/reverted/blocked` figure
 * (FIX-248 vocabulary). The returned `total` is GUARANTEED to equal the sum of
 * the displayed bucket counts (the failed cluster contributes its full sum), so
 * the old `5 delivered · 20 failed → 25 ≠ 28` divergence is impossible. Pure:
 * windowed rows + lang → { total, parts (label+count+verdict), failedTotal }.
 */
export function summaryBuckets(rows: readonly CycleLedgerRow[]): {
  total: number;
  failedTotal: number;
  parts: Array<{ verdict: CycleLedgerVerdict; count: number }>;
} {
  const counts = bucketCounts(rows);
  const failedTotal = counts.failed + counts.reverted + counts.blocked;
  const parts: Array<{ verdict: CycleLedgerVerdict; count: number }> = [];
  // Render order = CYCLE_VERDICTS, but the failed cluster collapses onto `failed`.
  for (const v of CYCLE_VERDICTS) {
    if (v === "reverted" || v === "blocked") continue; // folded into the failed figure
    const count = v === "failed" ? failedTotal : counts[v];
    if (count > 0) parts.push({ verdict: v, count });
  }
  const total = rows.length;
  return { total, failedTotal, parts };
}

function pad(s: string, w: number): string {
  const len = stripAnsi(s).length;
  return len >= w ? s : s + " ".repeat(w - len);
}

function tokensTotal(tokens: string): string {
  // ledger carries "in/out" (e.g. 104k/16k) — the CLI column shows one figure.
  if (tokens === "—") return "—";
  // FIX-290 AC3: unreadable usage stays "?" (UNKNOWN), never collapses to 0.
  if (tokens === "?") return "?";
  const parts = tokens.split("/");
  const num = (p: string): number => (p.endsWith("k") ? Number(p.slice(0, -1)) * 1000 : Number(p));
  const total = parts.reduce((a, p) => a + (Number.isFinite(num(p)) ? num(p) : 0), 0);
  return total >= 1000 ? `${Math.round(total / 1000)}k` : String(total);
}

/** The window filter the human render applies — shared so --json is the SAME
 *  computation (AC5/AC7), never a second derivation. */
function windowRows(rows: CycleLedgerRow[], sinceLabel: string, nowSec: number): CycleLedgerRow[] {
  const horizonDays = WINDOWS[sinceLabel];
  return sinceLabel === "all"
    ? rows
    : rows.filter((r) => nowSec - r.tsSec <= (horizonDays ?? 3) * 86400 && r.tsSec > 0);
}

/**
 * US-DOSSIER-036 --json (AC5/AC7): the machine view of the ledger, built from
 * the SAME windowed rows + the SAME `delivered`/`failed`/`cost` aggregation the
 * human render computes — field-by-field parity, key/row order stable (recency).
 */
export function cyclesLedgerJson(rows: CycleLedgerRow[], sinceLabel: string, nowSec: number): unknown {
  const within = windowRows(rows, sinceLabel, nowSec);
  const delivered = within.filter((r) => r.verdict === "delivered").length;
  const failed = ledgerFailedCount(within);
  // FIX-337 (AC2): expose EVERY bucket so the machine view can verify
  // total === sum(buckets) just like the human summary line.
  const buckets = bucketCounts(within);
  // FIX-361: cost may be "$X.XX" or "¥X.XX". Aggregate per-currency (the shared
  // FIX-337 口径) so consumers never blindly sum across currencies.
  const costByCur = cyclesCostByCurrency(within);
  // US-DELIV-012: the delivery metrics (external-merge rate / awaiting dwell /
  // fan-out waste) from the SAME pure derivation the human line renders.
  const delivery = deliveryMetrics(within, nowSec * 1000);
  return {
    since: sinceLabel,
    cycles: within.length,
    delivered,
    failed,
    buckets,
    delivery,
    costByCurrency: costByCur,
    rows: within.map((r) => ({
      no: cycleNo(r.cycleId),
      cycleId: r.cycleId,
      verdict: r.verdict,
      storyId: r.storyId,
      agent: r.agent,
      model: r.model,
      tokens: tokensTotal(r.tokens),
      cost: r.cost,
      duration: r.duration,
      ...(r.usageUnknownReason !== undefined ? { usageUnknownReason: r.usageUnknownReason } : {}),
      ...(r.agentInternalFailure !== undefined ? { agentInternalFailure: r.agentInternalFailure } : {}),
    })),
  };
}

/** Per-currency cost total over a set of ledger rows — the SINGLE cost口径 the
 *  --json view, the human summary, AND the truth.json cycle aggregate all reuse
 *  (FIX-337 AC1), so no surface re-derives cost from raw runs rows. Only rows
 *  with a real presentable cost contribute ("?"/"—" carry no money). */
export function cyclesCostByCurrency(rows: readonly CycleLedgerRow[]): Record<string, number> {
  const byCur: Record<string, number> = {};
  for (const r of rows) {
    const { value, currency } = parseCostCell(r.cost);
    if (value !== null && currency !== null) byCur[currency] = (byCur[currency] ?? 0) + value;
  }
  return byCur;
}

/**
 * FIX-337 (AC1) — the truth.json `cycle` aggregate, derived from the SAME
 * canonical reconciled ledger `roll cycles` renders (not a second pass over raw
 * runs rows). Windowed to the default 3d horizon and summarized via
 * {@link summaryBuckets}, so `roll status` (which reads truth.json) and `roll
 * cycles --since 3d` can never show two different `cycles`/`failed`/`cost`
 * numbers. `failed3d` is the failed CLUSTER (failed+reverted+blocked), never
 * swallowed (FIX-248); cost is per-currency via {@link cyclesCostByCurrency}.
 */
export function cyclesCycleBoard(
  rows: CycleLedgerRow[],
  nowSec: number,
): { cycles3d: number; failed3d: number; costUsd3d: number; costByCurrency3d?: Record<string, number>; latestTsSec: number } {
  const within = windowRows(rows, "3d", nowSec);
  const { total, failedTotal } = summaryBuckets(within);
  const byCur = cyclesCostByCurrency(within);
  // costUsd3d historically named the single scalar the status line shows; keep it
  // as USD when present, else the sole currency present, else 0 (no money known).
  const usd = byCur["USD"];
  const sole = Object.values(byCur);
  const costUsd3d = usd ?? (sole.length === 1 ? (sole[0] as number) : 0);
  const latestTsSec = within.reduce((m, r) => Math.max(m, r.tsSec), 0);
  return {
    cycles3d: total,
    failed3d: failedTotal,
    costUsd3d: Number(costUsd3d.toFixed(4)),
    ...(Object.keys(byCur).length > 0 ? { costByCurrency3d: byCur } : {}),
    latestTsSec,
  };
}

/** FIX-361: parse the formatted cost string ("$0.74" / "¥0.74" / "?" / "—")
 *  into { value: number | null, currency: string | null }. A null value means
 *  the cost is unknown; a null currency means not presentable. */
function parseCostCell(cell: string): { value: number | null; currency: string | null } {
  if (cell === "?" || cell === "—") return { value: null, currency: null };
  const sym = cell[0] ?? "";
  const currency = sym === "\u00A5" ? "CNY" : sym === "$" ? "USD" : null;
  const n = Number(cell.slice(1));
  return { value: Number.isFinite(n) ? n : null, currency };
}

/** FIX-361: build the cost summary string, with per-currency breakdown when
 *  the window mixes ¥ and $. */
function costSummary(within: readonly CycleLedgerRow[], lang: Lang): string {
  const byCur = cyclesCostByCurrency(within);
  const entries = Object.entries(byCur);
  if (entries.length === 0) return lang === "zh" ? "花费 —" : "cost —";
  // Single currency: simple "$X.XX" or "¥X.XX".
  if (entries.length === 1) {
    const [cur, val] = entries[0] as [string, number];
    const sym = cur === "CNY" ? "\u00A5" : "$";
    return `${sym}${val.toFixed(2)}`;
  }
  // Mixed currencies: show each separately so they are never blindly summed.
  const parts = entries.map(([cur, val]) => {
    const sym = cur === "CNY" ? "\u00A5" : "$";
    return `${sym}${val.toFixed(2)}`;
  });
  return parts.join(" + ");
}

/**
 * US-DELIV-012 (design §9) — the delivery metrics line: external-merge rate,
 * awaiting_merge dwell, fan-out waste. One human-readable string from the SAME
 * pure {@link deliveryMetrics} the --json view emits, so the two never diverge.
 * Returns "" when there is nothing to report (no deliveries, none awaiting, no
 * waste) so a quiet window carries no noise line.
 */
export function deliveryMetricsLine(m: DeliveryMetrics, lang: Lang): string {
  const parts: string[] = [];
  if (m.delivered + m.deliveredExternal > 0 && m.externalMergeRate !== null) {
    const pct = Math.round(m.externalMergeRate * 100);
    parts.push(
      lang === "zh"
        ? `外部合并率 ${pct}%（${m.deliveredExternal}/${m.delivered + m.deliveredExternal}）`
        : `external-merge ${pct}% (${m.deliveredExternal}/${m.delivered + m.deliveredExternal})`,
    );
  }
  if (m.awaitingCount > 0) {
    const dwell = m.awaitingDwellMsAvg !== null ? humanDwell(m.awaitingDwellMsAvg) : "—";
    parts.push(
      lang === "zh"
        ? `等待合并 ${m.awaitingCount}（均滞留 ${dwell}）`
        : `awaiting_merge ${m.awaitingCount} (avg dwell ${dwell})`,
    );
  }
  if (m.degraded > 0) parts.push(lang === "zh" ? `降级 ${m.degraded}` : `degraded ${m.degraded}`);
  if (m.fanoutWasteCycles > 0) {
    parts.push(lang === "zh" ? `fan-out 浪费 ${m.fanoutWasteCycles}` : `fan-out waste ${m.fanoutWasteCycles}`);
  }
  if (parts.length === 0) return "";
  const label = lang === "zh" ? "交付" : "delivery";
  return `${label}: ${parts.join(" · ")}`;
}

/** Human dwell duration from epoch-ms delta ("3h" / "2d" / "45m" / "30s"). */
function humanDwell(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec >= 86400) return `${Math.round(sec / 86400)}d`;
  if (sec >= 3600) return `${Math.round(sec / 3600)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${sec}s`;
}

export function renderCyclesLedger(rows: CycleLedgerRow[], sinceLabel: string, lang: Lang, nowSec: number): string {
  const within = windowRows(rows, sinceLabel, nowSec);
  const lines: string[] = [];
  for (const r of within) {
    const color = VERDICT_COLOR[r.verdict] ?? "muted";
    // FIX-1066: always show Builder Agent and model together, never just model.
    // FIX-1067: normalize the RAW ledger facts to the operator-facing runnable
    // surface via the shared formatter (`kimi` + `kimi-code/kimi-for-coding` →
    // `kimi-code / kimi-2.7`), so this and `roll cycle <id>` cannot drift.
    const agentModel = formatBuilderIdentity(r.agent, r.model);
    lines.push(
      [
        pad(`#${cycleNo(r.cycleId)}`, 7),
        pad(c(color, r.verdict), 18), // US-DELIV-012: fits "delivered_external" (18)
        pad(r.storyId === "" ? "—" : r.storyId, 16),
        pad(agentModel, 26),
        pad(tokensTotal(r.tokens), 6),
        pad(r.cost, 7),
        r.duration,
      ].join(" "),
    );
  }
  // FIX-337 (AC2): the summary enumerates ALL non-zero buckets so the displayed
  // total === sum(buckets). `summaryBuckets` folds failed+reverted+blocked into
  // one `failed/reverted/blocked` figure (FIX-248 vocabulary) and guarantees the
  // total equals the sum of the parts — the old `5 delivered · 20 failed → 25 ≠
  // 28` divergence (an unpublished/superseded cycle hiding in neither figure) is
  // impossible. Each part wears its verdict color (the failed cluster is red
  // when non-zero, every other bucket its own VERDICT_COLOR).
  const { total, parts } = summaryBuckets(within);
  const costStr = costSummary(within, lang);
  const cycleWord = lang === "zh" ? `${total} 个周期` : `${total} cycles`;
  const partStrs = parts.map((part) => {
    const label = BUCKET_LABEL[part.verdict][lang === "zh" ? "zh" : "en"];
    const color = part.verdict === "failed" ? "red" : VERDICT_COLOR[part.verdict] ?? "muted";
    return `${c(color, String(part.count))} ${label}`;
  });
  const summary = [cycleWord, ...partStrs, costStr].join(" · ");
  // US-DELIV-012: the delivery metrics line (external-merge rate / awaiting_merge
  // dwell / fan-out waste), below the bucket summary. Omitted when empty.
  const metricsStr = deliveryMetricsLine(deliveryMetrics(within, nowSec * 1000), lang);
  const metricsLine = metricsStr === "" ? "" : `\n${c("muted", metricsStr)}`;
  const latest = within[0];
  // `roll cycle <handle>` is the spec'd companion (US-CLI-013, next card) —
  // the hint is the contract between the two surfaces, not a dead end.
  const hint = latest !== undefined ? `\n→ roll cycle ${cycleNo(latest.cycleId)}` : "";
  if (within.length === 0) {
    return lang === "zh" ? `窗口内没有周期（--since ${sinceLabel}）\n` : `no cycles in the window (--since ${sinceLabel})\n`;
  }
  return `${lines.join("\n")}\n\n${summary}${metricsLine}${hint}\n`;
}

/** Read + parse every event from the project's events.ndjson (empty on miss). */
function readAllEvents(projectPath: string): RollEvent[] {
  const path = join(projectPath, ".roll", "loop", "events.ndjson");
  if (!existsSync(path)) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: RollEvent[] = [];
  for (const line of text.split("\n")) {
    const ev = parseEventLine(line);
    if (ev !== null) out.push(ev);
  }
  return out;
}

/** mm:ss from whole seconds (the offset column). */
function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Human gap ("+3m" / "+45s") between two timeline entries. */
function gap(sec: number): string {
  if (sec <= 0) return "";
  return sec >= 90 ? `+${Math.round(sec / 60)}m` : `+${sec}s`;
}

const MARKER_COLOR: Record<string, string> = {
  tcr: "green",
  "build:heartbeat": "amber",
  "ci:fail": "red",
  "pr:merge": "green",
  alert: "red",
};

/**
 * US-LOOP-076 — the per-cycle build-phase timeline. Built from the SAME pure
 * {@link extractCycleSignals} reducer the acceptance report and web trace consume
 * (one 口径, zero agent special-casing), so a 37-min/2-commit anomaly is legible:
 * each turning point shows its mm:ss offset and the gap since the previous one.
 * The summary line surfaces the build span and TCR cadence at a glance.
 */
export function renderCycleDetail(
  events: RollEvent[],
  cycleId: string,
  lang: Lang,
  agentInternalFailure?: { class: string; summary: string; nativeLogPath: string; conversationId?: string },
): string {
  const { timeline } = extractCycleSignals(events, cycleId);
  if (timeline.length === 0 && agentInternalFailure === undefined) {
    return lang === "zh"
      ? `周期 ${cycleNo(cycleId)} 没有事件记录（build 阶段未观测到信号）\n`
      : `no events recorded for cycle ${cycleNo(cycleId)} (no build-phase signals observed)\n`;
  }
  const lines: string[] = [];
  lines.push(c("bold", `#${cycleNo(cycleId)} · ${cycleId}`));
  lines.push(lang === "zh" ? "build 阶段时间线 · build-phase timeline" : "build-phase timeline");
  lines.push("");
  let prevOffset = 0;
  for (const e of timeline) {
    const color = MARKER_COLOR[e.marker] ?? (signalKindForMarker(e.marker) !== null ? "blue" : "muted");
    const g = gap(e.offsetSec - prevOffset);
    prevOffset = e.offsetSec;
    const gapCol = g === "" ? "" : "  " + c("faint", g);
    lines.push(`${c("muted", clock(e.offsetSec))}  ${c(color, e.marker.padEnd(16))} ${e.label}${gapCol}`);
  }
  // Build-span + TCR cadence summary (the anomaly detector at a glance).
  const tcrs = timeline.filter((t) => t.marker === "tcr");
  const beats = timeline.filter((t) => t.marker === "build:heartbeat").length;
  const spanSec = (timeline[timeline.length - 1]?.offsetSec ?? 0) - (timeline[0]?.offsetSec ?? 0);
  lines.push("");
  lines.push(
    lang === "zh"
      ? `${clock(spanSec)} 总时长 · ${tcrs.length} 个 TCR 提交 · ${beats} 次心跳`
      : `${clock(spanSec)} span · ${tcrs.length} TCR commits · ${beats} heartbeats`,
  );
  if (agentInternalFailure !== undefined) {
    lines.push("");
    lines.push(c("red", lang === "zh" ? "代理内部故障 · agent internal failure" : "agent internal failure"));
    lines.push(`  class: ${agentInternalFailure.class}`);
    lines.push(`  summary: ${agentInternalFailure.summary}`);
    lines.push(`  log: ${agentInternalFailure.nativeLogPath}`);
    if (agentInternalFailure.conversationId !== undefined) {
      lines.push(`  conversation: ${agentInternalFailure.conversationId}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Machine view of the detail timeline — the SAME reducer, fields per entry. */
export function cycleDetailJson(
  events: RollEvent[],
  cycleId: string,
  agentInternalFailure?: { class: string; summary: string; nativeLogPath: string; conversationId?: string },
): unknown {
  const { timeline } = extractCycleSignals(events, cycleId);
  const tcrs = timeline.filter((t: TimelineEntry) => t.marker === "tcr");
  const beats = timeline.filter((t: TimelineEntry) => t.marker === "build:heartbeat").length;
  const spanSec = (timeline[timeline.length - 1]?.offsetSec ?? 0) - (timeline[0]?.offsetSec ?? 0);
  return {
    cycleId,
    no: cycleNo(cycleId),
    spanSec,
    tcrCount: tcrs.length,
    heartbeats: beats,
    timeline: timeline.map((t: TimelineEntry) => ({
      offsetSec: t.offsetSec,
      layer: t.layer,
      marker: t.marker,
      label: t.label,
    })),
    ...(agentInternalFailure !== undefined ? { agentInternalFailure } : {}),
  };
}

export function cyclesCommand(args: string[]): number {
  const noColor = args.includes("--no-color") || !process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "";
  renderState.useColor = !noColor;
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${CYCLES_USAGE}\n`);
    return 0;
  }
  const json = args.includes("--json");

  // US-LOOP-076 — `roll cycles --detail <id>`: the per-cycle build-phase timeline.
  // Resolves the handle against the ledger (same tolerance as `roll cycle <id>`),
  // then renders from the SAME pure extractCycleSignals reducer the report uses.
  const di = args.indexOf("--detail");
  if (di >= 0) {
    const handle = args[di + 1];
    if (handle === undefined || handle.startsWith("-")) {
      process.stderr.write(lang === "zh" ? `[roll] --detail 需要一个 cycle id\n` : `[roll] --detail needs a cycle id\n`);
      return 1;
    }
    const cwd = process.cwd();
    const ledger = collectCycleLedger(cwd);
    const matched = findCycle(ledger, handle);
    const cycleId = matched?.cycleId ?? handle;
    const agentInternalFailure = matched?.agentInternalFailure;
    const events = readAllEvents(cwd);
    if (json) {
      process.stdout.write(JSON.stringify(cycleDetailJson(events, cycleId, agentInternalFailure), null, 2) + "\n");
      return 0;
    }
    process.stdout.write(renderCycleDetail(events, cycleId, lang, agentInternalFailure));
    return 0;
  }

  let since = "3d";
  const i = args.indexOf("--since");
  if (i >= 0) {
    const v = args[i + 1];
    if (v === undefined || (v !== "all" && WINDOWS[v] === undefined)) {
      process.stderr.write(
        lang === "zh" ? `[roll] 非法 --since 值：${v ?? "(空)"}（可用 1d|3d|7d|all）\n` : `[roll] illegal --since value: ${v ?? "(empty)"} (use 1d|3d|7d|all)\n`,
      );
      return 1;
    }
    since = v;
  }
  const unknown = args.filter((a, idx) => a.startsWith("-") && a !== "--since" && a !== "--detail" && a !== "--no-color" && a !== "--json" && !(idx > 0 && (args[idx - 1] === "--since" || args[idx - 1] === "--detail")));
  if (unknown.length > 0) {
    process.stderr.write(`[roll] unknown flag: ${unknown[0]}\n${CYCLES_USAGE}\n`);
    return 1;
  }
  const rows = reconciledLedger(process.cwd());
  const nowSec = Math.floor(Date.now() / 1000);
  if (json) {
    process.stdout.write(JSON.stringify(cyclesLedgerJson(rows, since, nowSec), null, 2) + "\n");
    return 0;
  }
  process.stdout.write(renderCyclesLedger(rows, since, lang, nowSec));
  return 0;
}
