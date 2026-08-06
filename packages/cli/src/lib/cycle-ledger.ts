/**
 * @responsibility Builds the cycle ledger view model with one row per loop cycle.
 */
/**
 * US-DOSSIER-013 — the cycle ledger view model: every loop cycle as one row
 * (verdict dot · cycle no · story · model · tokens · cost · duration) that
 * expands into a seven-segment trace tape (cycle→story→build→peer→ci→pr→end)
 * with whatever evidence is honestly knowable from runs.jsonl + events.ndjson.
 * Failures are first-class: failed = failed + reverted + blocked, never
 * swallowed (the FIX-248 lesson, same vocabulary as the CLI).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentBuilderLabel, cycleActivitySignalsFromEvents, normalizeModelLabel, type ActivitySignal, type ReconcileResult } from "@roll/core";
import type { DeliveryState, ToolCost } from "@roll/spec";
import { parseEventLine, type RollEvent } from "@roll/spec";
import { collectToolEvidence, formatToolCostSummary, type ToolTimelineRow } from "./tool-display.js";

export type CycleLedgerVerdict =
  | "delivered"
  // US-DELIV-012: a delivery MERGED by a hand/supervisor (not the runner's own
  // self-merge). Distinguished so the external-merge rate is visible; still a
  // real delivery (green), never a failure.
  | "delivered_external"
  | "pending_merge"
  // US-DELIV-012: an awaiting_merge cycle the reconcile engine judged DEGRADED
  // (US-DELIV-010: draft / merge conflict / CI long-red / no permission) — stuck
  // but not dead, carries a reason for triage. NEVER a delivered.
  | "degraded"
  | "unpublished"
  | "superseded"
  | "reverted"
  | "failed"
  | "blocked"
  | "agent_internal_failure"
  | "idle"
  | "unknown";

/** The full bucket order (AC2): every verdict the ledger can carry, in a stable
 *  display order. `bucketCounts` keys on this so a summary line can enumerate
 *  ALL non-zero buckets and GUARANTEE total === sum(buckets). */
export const CYCLE_VERDICTS: readonly CycleLedgerVerdict[] = [
  "delivered",
  "delivered_external",
  "pending_merge",
  "degraded",
  "unpublished",
  "superseded",
  "failed",
  "blocked",
  "reverted",
  "agent_internal_failure",
  "idle",
  "unknown",
];

export interface CycleTapeSegment {
  key: "cycle" | "story" | "build" | "peer" | "ci" | "pr" | "end";
  /** Honest summary, "—" when nothing is knowable. */
  detail: string;
  /** pass | fail | idle | unknown — drives the segment color. */
  state: "pass" | "fail" | "idle" | "unknown";
}

export interface CycleLedgerRow {
  cycleId: string;
  /** Epoch seconds (0 when the row carries no ts — filtered as ancient). */
  tsSec: number;
  verdict: CycleLedgerVerdict;
  storyId: string;
  agent: string;
  model: string;
  tokens: string;
  cost: string;
  toolSummary: string;
  toolCosts: ToolCost[];
  toolTimeline: ToolTimelineRow[];
  duration: string;
  tape: CycleTapeSegment[];
  /** Standard ActivitySignal stream for this cycle, shared by web/report/ledger surfaces. */
  signals?: ActivitySignal[];
  /** Evidence links (label → href), relative to features/index.html. */
  evidence: Array<{ label: string; href: string }>;
  /** FIX-348: the PR number this cycle opened, recorded on its `cycle:terminal`
   *  twin (`pr.value.url` / `pr.value.number`). The render-time merge-truth
   *  reconcile uses it to detect a merged delivery whose squash commit carries
   *  `(#N)` but does NOT name the story-id (e.g. FIX-287 / PR #773). undefined
   *  when the cycle never opened a PR or predates the terminal-event twin. */
  prNumber?: number;
  /** US-DELIV-008: the cycle's branch from its `delivery:published` event
   *  (e.g. `loop/<cycleId>`), so the unified reconcile engine can compute the
   *  branch's patch-id against main. undefined when the cycle never published. */
  branch?: string;
  /** FIX-1050: agent-specific reason why usage is unknown (e.g.
   *  `agy_stdout_no_usage`), surfaced in --json / debug output. */
  usageUnknownReason?: string;
  /** FIX-1051: agent-internal failure diagnostics surfaced in detail output. */
  agentInternalFailure?: { class: string; summary: string; nativeLogPath: string; conversationId?: string };
  /** REFACTOR-070: failure attribution class (env|harness|card|unknown). */
  failureClass?: string;
  /** REFACTOR-070: deterministic root-cause key. */
  rootCauseKey?: string;
  /** US-DELIV-012: epoch ms the cycle entered `awaiting_merge` (its
   *  `delivery:published` event ts), the dwell anchor for the awaiting_merge
   *  滞留时长 metric. undefined when the cycle never published. */
  awaitingSinceMs?: number;
  /** US-DELIV-012: why a `degraded` cycle is stuck (US-DELIV-010 reason:
   *  ci_stuck / merge_conflict / draft / no_permission), surfaced in --json /
   *  detail output. undefined unless the verdict is `degraded`. */
  degradedReason?: string;
}

/**
 * FIX-1067 — the SINGLE operator-facing Builder identity formatter shared by
 * `roll cycles` and `roll cycle <id>`, so the two surfaces can never drift. It
 * normalizes the RAW ledger facts (internal agent key + raw provider model) to
 * the runnable agent surface + a canonical display model: internal `kimi` plus
 * raw `kimi-code/kimi-for-coding` render as `kimi-code / kimi-2.7`, while
 * `reasonix / deepseek-flash` and any unknown agent pass through unchanged. When
 * the model is unknown it renders `<label> / —`. Raw agent/model are preserved
 * verbatim in machine-readable output (this touches display only).
 */
export function formatBuilderIdentity(agent: string, model: string): string {
  const label = agentBuilderLabel(agent);
  const displayModel = normalizeModelLabel(model, agent);
  return displayModel !== "" ? `${label} / ${displayModel}` : `${label} / —`;
}

/** The CLI's verdict vocabulary (AC4): delivered / reverted / failed / blocked. */
export function ledgerVerdict(status: string, outcome: string): CycleLedgerVerdict {
  if (status === "reverted") return "reverted";
  // FIX-322: delivered ≡ MERGED only (done≡merged). The merge-backfill stamps
  // status=merged / outcome=delivered on a gh-confirmed merge; until then a cycle
  // that opened a PR is IN-FLIGHT (pending_merge), NOT delivered. Labeling
  // published as delivered made an open, unmerged PR count as a delivery — and
  // showed two "delivered" rows for one card re-delivered across the merge window.
  if (status === "merged" || outcome === "delivered") return "delivered";
  if (
    outcome === "published_pending_merge" ||
    status === "published" ||
    status === "built" ||
    status === "done"
  ) {
    return "pending_merge";
  }
  // FIX-351: a `built` (gates-passed) cycle whose publish could not complete and
  // whose work stayed local is `unpublished` — a NEUTRAL verdict, NOT a failure.
  // It is distinct from `failed` (a gate genuinely failed / errored) and from
  // `pending_merge` (a PR is open, merge pending). Mapped BEFORE the failed
  // cluster so it never lands in red. Genuine gate-failures classify `failed`
  // upstream (orchestrator.classifyCaptured), never `local`, so this can never
  // hide a real failure.
  if (outcome === "unpublished" || status === "local") return "unpublished";
  if (outcome === "blocked" || status === "blocked") return "blocked";
  // FIX-1051: agent-internal failure is a failed-class terminal but carries its
  // own verdict so `roll cycles` can surface the native failure class in detail
  // output instead of hiding it behind generic `failed`.
  if (outcome === "agent_internal_failure" || status === "agent_internal") return "agent_internal_failure";
  if (outcome === "idle_no_work" || status === "idle") return "idle";
  if (
    outcome === "failed" ||
    outcome === "aborted_no_delivery" ||
    outcome === "aborted_with_delivery" ||
    outcome === "orphan_timeout" ||
    status === "failed" ||
    status === "aborted" ||
    // FIX-324: `gave_up` is the productivity-floor terminal — an agent that ran
    // but left no commit / no delivery (orchestrator.classifyCaptured). It is a
    // failure-to-deliver, so it belongs in the failed cluster; before this it
    // fell through to "unknown" and `roll cycles` showed a dirty/illegible
    // status for every gave_up cycle. The precise mode stays in runs.jsonl.
    status === "gave_up" ||
    outcome === "gave_up"
  ) {
    return "failed";
  }
  return "unknown";
}

function isAgentInternalAttribution(row: Record<string, unknown>): boolean {
  return typeof row["failure_class"] === "string" &&
    row["root_cause_key"] === "harness:agent_internal";
}

/** failed = failed + reverted + blocked + agent_internal_failure (never swallowed). */
export function ledgerFailedCount(rows: readonly CycleLedgerRow[]): number {
  return rows.filter(
    (r) =>
      r.verdict === "failed" ||
      r.verdict === "reverted" ||
      r.verdict === "blocked" ||
      r.verdict === "agent_internal_failure",
  ).length;
}

/**
 * US-DELIV-008 — the cycle ledger's render-time delivery backfill through the
 * SINGLE reconcile truth engine. The old subject-match probe
 * ({@link reconcilePendingMergeVerdicts} + `cycleMergeTruth`) was a PARALLEL
 * second criterion that could disagree with `roll loop reconcile`; this
 * replaces it with a per-row `decide` that production wires to
 * `cycleReconcileDecision` (offline L1 + patch-id L2 → the pure
 * `reconcileDelivery` of US-DELIV-002) — the SAME engine the command runs, so
 * the read path and the command can never diverge on "is this delivered".
 *
 * Eligible rows: `pending_merge` AND `unpublished` (an awaiting OR
 * unpublished cycle is judged by the same engine — the story's parity
 * contract). `delivered` promotes the row (verdict + end/pr tape segments,
 * same rendering as the retired probe); every other result
 * (wait/merge_now/ci_failed/superseded) leaves the row untouched — the read
 * path never merges and never invents a failure from the absence of a merge.
 * A row with no story AND no PR number has nothing to match on and `decide`
 * is not consulted (it would only burn git spawns).
 *
 * Pure: rows in, rows out; the IO lives behind the injected `decide`.
 */
export function reconcileCyclesWithDelivery(
  rows: readonly CycleLedgerRow[],
  decide: (row: CycleLedgerRow) => ReconcileResult,
): CycleLedgerRow[] {
  return rows.map((r) => {
    if (r.verdict !== "pending_merge" && r.verdict !== "unpublished") return r;
    if (r.storyId === "" && r.prNumber === undefined) return r;
    const d = decide(r);
    // US-DELIV-012: a DEGRADED verdict (US-DELIV-010: draft / merge conflict /
    // CI long-red / no permission) is surfaced with its reason — stuck but not
    // dead, NEVER a delivered. The end tape shows the degraded reason so a
    // day-old red PR reads as stuck, not as an in-flight check.
    if (d.kind === "degraded") {
      return {
        ...r,
        verdict: "degraded",
        degradedReason: d.reason,
        tape: r.tape.map((seg) =>
          seg.key === "end" ? { ...seg, detail: `degraded: ${d.reason}`, state: "fail" } : seg,
        ),
      };
    }
    if (d.kind !== "delivered") return r;
    // The OFFLINE decision cannot tell a runner self-merge from a hand merge
    // (reconcileDelivery stamps via=external for any MERGED/patch-id hit), so it
    // stays the conservative `delivered`. The runner-vs-external distinction is
    // event-authoritative — `reconcileDeliveryStateProjection` promotes it to
    // `delivered_external` from the `delivery:reconciled{mergedBy}` truth.
    return {
      ...r,
      verdict: "delivered",
      tape: r.tape.map((seg) => {
        if (seg.key === "end") return { ...seg, detail: "delivered", state: "pass" };
        // The pr segment showed "#N open" (idle) at cycle-end; the engine now
        // proves the delivery landed — promote it without claiming a PR number
        // we did not observe (same rendering the retired probe used).
        if (seg.key === "pr") {
          const merged = /#(\d+)\s+open/.exec(seg.detail);
          if (merged !== null) return { ...seg, detail: `#${merged[1]} merged`, state: "pass" };
        }
        return seg;
      }),
    };
  });
}

/**
 * FIX-1046 — reconcile `unpublished` cycles whose story was later delivered.
 * A cycle that ended `unpublished` (status `local` / outcome `unpublished` — gates
 * passed, work committed locally, publish didn't land) whose story was later
 * delivered shows as `delivered`, not a stale `unpublished`. The cycle's work DID
 * ship (the story is Done ≡ merged), so the cycle ledger must reflect that.
 *
 * Same pattern as {@link reconcileCyclesWithDelivery}: pure function with the
 * is-story-delivered probe injected. Only `unpublished` rows are eligible;
 * genuinely unmerged unpublished rows (story not delivered) stay `unpublished`.
 *
 * FIX-1064: also accepts {@link deliveringCycles} — a Set of cycle IDs that have
 * a `done` delivery record. An unpublished cycle is marked as delivered ONLY
 * when its own cycle ID is in this set, preventing older failed/unpublished
 * cycles from retroactively showing as delivered when a later cycle ships the
 * same story.
 *
 * AC: delivered-truth override is deterministic and scoped — a story that was
 * NOT delivered keeps its `unpublished` verdict. A cycle whose story delivered
 * elsewhere via a DIFFERENT cycle keeps its `unpublished` verdict (per-cycle
 * faithfulness, FIX-1064).
 */
export function reconcileDeliveredUnpublishedVerdicts(
  rows: readonly CycleLedgerRow[],
  isStoryDelivered: (storyId: string) => boolean,
  deliveringCycles?: Set<string>,
): CycleLedgerRow[] {
  return rows.map((r) => {
    if (r.verdict !== "unpublished") return r;
    if (r.storyId === "" || !isStoryDelivered(r.storyId)) return r;
    // FIX-1064: only mark as delivered when THIS cycle is a known delivering
    // cycle. Without the cycle-level check, an old unpublished cycle whose story
    // was later delivered by a different cycle would retroactively show as
    // delivered — a projection bug.
    if (deliveringCycles !== undefined && !deliveringCycles.has(r.cycleId)) return r;
    return {
      ...r,
      verdict: "delivered",
      tape: r.tape.map((seg) => {
        if (seg.key === "end") return { ...seg, detail: "delivered", state: "pass" };
        return seg;
      }),
    };
  });
}

/**
 * FIX-337 (AC3) — reconcile cycles whose story was delivered ELSEWHERE (manually,
 * or by another PR/cycle) against the canonical ledger at RENDER time. A
 * `failed`/`blocked`/`reverted`/`pending_merge` cycle whose story is ALREADY
 * backlog-Done OR carries merge evidence is NOT a live failure — the card landed,
 * just not via THIS cycle. Re-labeling it `superseded` stops a manually-delivered
 * card's old failed cycles from inflating the failed count (the FIX-286 lesson:
 * the cycle ledger is loop-cycle-centric and didn't reflect loop-external
 * delivery, so a Done card looked like an all-failure pile).
 *
 * Mirrors {@link reconcileCyclesWithDelivery}: a PURE function (rows in, rows
 * out) with the story-superseded probe INJECTED by the caller (which wires it to
 * backlog-Done + offline git merge-truth). The end-segment is rewritten to the
 * neutral `superseded` state (idle-class grey) so a superseded cycle is visually
 * distinct from a live `failed` (red) and a real `delivered` (green).
 *
 * Boundary: a real `delivered` row is already terminal and is never touched; an
 * `idle`/`unpublished`/`unknown` row is not a failure-to-count, so it is left
 * alone too. ONLY the failure cluster + pending_merge are eligible, and only when
 * the story has a non-empty id (an empty id has nothing to match on).
 */
export function reconcileSupersededVerdicts(
  rows: readonly CycleLedgerRow[],
  isStorySuperseded: (storyId: string) => boolean,
): CycleLedgerRow[] {
  const ELIGIBLE = new Set<CycleLedgerVerdict>(["failed", "blocked", "reverted", "pending_merge"]);
  return rows.map((r) => {
    if (!ELIGIBLE.has(r.verdict)) return r;
    if (r.storyId === "" || !isStorySuperseded(r.storyId)) return r;
    return {
      ...r,
      verdict: "superseded",
      tape: r.tape.map((seg) => (seg.key === "end" ? { ...seg, detail: "superseded", state: "idle" } : seg)),
    };
  });
}

/**
 * US-DELIV-012 — reconcile the ledger against the EVENT-AUTHORITATIVE delivery
 * state projection (`projectDeliveryState`, US-DELIV-001). The offline decision
 * engine (`reconcileCyclesWithDelivery`) cannot tell a runner self-merge from a
 * hand/supervisor merge — it stamps every merge `delivered`. The event stream
 * CAN: a `delivery:reconciled{state, mergedBy}` event records which, so a cycle
 * whose projection is `delivered_external` is promoted to the
 * `delivered_external` verdict (external-merge rate becomes visible). Read-only:
 * a state the projection does NOT carry leaves the row untouched.
 *
 * Also attaches `awaitingSinceMs` (from the `delivery:published` event ts, via
 * the injected `awaitingSince`) to every row still `awaiting_merge` — the dwell
 * anchor the awaiting_merge 滞留时长 metric averages over.
 *
 * Pure: rows + injected projections in, rows out. The event IO lives behind the
 * two injected lookups (production wires them to a single fold of events.ndjson;
 * see cycles.ts `reconciledLedger`).
 *
 * @param rows - the reconciled ledger rows.
 * @param stateFor - cycleId → its projected {@link DeliveryState} (undefined =
 *   no delivery events for that cycle; the row keeps its verdict).
 * @param awaitingSince - cycleId → epoch ms it entered awaiting_merge
 *   (`delivery:published` ts), for the dwell anchor.
 */
export function reconcileDeliveryStateProjection(
  rows: readonly CycleLedgerRow[],
  stateFor: (cycleId: string) => DeliveryState | undefined,
  awaitingSince: (cycleId: string) => number | undefined,
): CycleLedgerRow[] {
  return rows.map((r) => {
    const since = awaitingSince(r.cycleId);
    const withAnchor = since !== undefined ? { ...r, awaitingSinceMs: since } : r;
    // Only the externally-merged terminal state carries information the offline
    // decision could not: promote it. `delivered` (runner) already matches the
    // conservative verdict; every other projected state is left to the existing
    // verdict pipeline (awaiting_merge ≡ pending_merge, ci_failed, superseded…).
    if (stateFor(r.cycleId) === "delivered_external") {
      return {
        ...withAnchor,
        verdict: "delivered_external",
        tape: withAnchor.tape.map((seg) =>
          seg.key === "end" ? { ...seg, detail: "delivered (external)", state: "pass" } : seg,
        ),
      };
    }
    return withAnchor;
  });
}

/**
 * US-DELIV-012 — the delivery observability metrics (design §9), a PURE
 * derivation over the reconciled ledger rows so `roll cycles`, `--json`, and the
 * dashboard all read the SAME numbers. Read-only: metrics never change a verdict.
 *
 *  - `externalMergeRate` — the supervisor/hand-merge share of all deliveries:
 *    delivered_external / (delivered + delivered_external). null when there are
 *    no deliveries in the window (a rate over zero is meaningless, not 0%).
 *  - `awaitingDwellMsAvg` — the mean time cycles have sat in awaiting_merge
 *    (now − `delivery:published` ts). null when nothing is awaiting or no cycle
 *    carries a dwell anchor.
 *  - `fanoutWasteCycles` — cycles whose card landed elsewhere (`superseded`):
 *    duplicated effort the one-card-one-lease rule (US-DELIV-005) exists to kill.
 */
export interface DeliveryMetrics {
  delivered: number;
  deliveredExternal: number;
  externalMergeRate: number | null;
  awaitingCount: number;
  awaitingDwellMsAvg: number | null;
  degraded: number;
  fanoutWasteCycles: number;
}

export function deliveryMetrics(rows: readonly CycleLedgerRow[], nowMs: number): DeliveryMetrics {
  let delivered = 0;
  let deliveredExternal = 0;
  let awaitingCount = 0;
  let degraded = 0;
  let fanoutWasteCycles = 0;
  let dwellSum = 0;
  let dwellN = 0;
  for (const r of rows) {
    switch (r.verdict) {
      case "delivered":
        delivered += 1;
        break;
      case "delivered_external":
        deliveredExternal += 1;
        break;
      case "pending_merge":
        awaitingCount += 1;
        if (r.awaitingSinceMs !== undefined) {
          dwellSum += Math.max(0, nowMs - r.awaitingSinceMs);
          dwellN += 1;
        }
        break;
      case "degraded":
        degraded += 1;
        break;
      case "superseded":
        fanoutWasteCycles += 1;
        break;
      default:
        break;
    }
  }
  const totalDeliveries = delivered + deliveredExternal;
  return {
    delivered,
    deliveredExternal,
    externalMergeRate: totalDeliveries > 0 ? deliveredExternal / totalDeliveries : null,
    awaitingCount,
    awaitingDwellMsAvg: dwellN > 0 ? dwellSum / dwellN : null,
    degraded,
    fanoutWasteCycles,
  };
}

/**
 * FIX-337 (AC2) — count every verdict bucket so a summary line can enumerate ALL
 * non-zero buckets and GUARANTEE total === sum(buckets). Keyed on the full
 * {@link CYCLE_VERDICTS} order; an unseen verdict is 0 (never absent), and an
 * unrecognized verdict is folded into `unknown` so the sum can never under-count
 * the rows. Pure: rows in, a count-per-bucket record out.
 */
export function bucketCounts(rows: readonly CycleLedgerRow[]): Record<CycleLedgerVerdict, number> {
  const out = Object.fromEntries(CYCLE_VERDICTS.map((v) => [v, 0])) as Record<CycleLedgerVerdict, number>;
  for (const r of rows) {
    if (r.verdict in out) out[r.verdict] += 1;
    else out.unknown += 1;
  }
  return out;
}

/**
 * FIX-297: idle heartbeats are NOT cycles. The scheduled loop lane wakes on its
 * interval, finds no eligible Todo, writes an idle row (no story picked, no work
 * attempted) and sleeps. Those rows stay in runs.jsonl as loop-liveness data,
 * but the cycle ledger must list ONLY real cycles — a story was picked and work
 * was attempted. We drop a row only when it is genuinely a no-op heartbeat:
 * idle verdict (outcome `idle_no_work` or status `idle`) AND no story AND no
 * work (no tcr commits, nothing built). Failures/blocked/aborted carry a story
 * or work and so remain first-class.
 */
function isIdleHeartbeat(row: Record<string, unknown>, verdict: CycleLedgerVerdict): boolean {
  if (verdict !== "idle") return false;
  const storyId = typeof row["story_id"] === "string" ? (row["story_id"] as string) : "";
  if (storyId !== "") return false;
  const tcr = typeof row["tcr_count"] === "number" ? (row["tcr_count"] as number) : 0;
  if (tcr > 0) return false;
  const built = row["built"];
  if (Array.isArray(built) && built.length > 0) return false;
  return true;
}

/** FIX-290 AC3: "?" when usage could not be read (UNKNOWN, model+duration still
 *  present), "—" only when there is genuinely nothing to show; a real value
 *  otherwise. A TRUE-0 (parsed usage that summed to 0) is never confused with
 *  the unreadable-credentials case (which sets `usage_unknown`). */
function fmtTokens(tin: unknown, tout: unknown, usageUnknown: boolean): string {
  if (usageUnknown) return "?";
  const a = typeof tin === "number" ? tin : 0;
  const b = typeof tout === "number" ? tout : 0;
  if (a + b === 0) return "—";
  const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return `${k(a)}/${k(b)}`;
}

function fmtDuration(sec: unknown): string {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  return `${Math.floor(sec / 60)}m${Math.round(sec % 60).toString().padStart(2, "0")}s`;
}

interface CycleEventFacts {
  peer?: string;
  pairVerdicts: string[];
  attest?: string;
  acceptedScore?: { peer: string; score: number; verdict: string };
}

function readEventFacts(projectPath: string): { events: RollEvent[]; byCycle: Map<string, CycleEventFacts>; prMergedBy: Map<string, number>; prOpenBy: Map<string, number>; prByCycle: Map<string, number>; branchByCycle: Map<string, string> } {
  const events: RollEvent[] = [];
  const byCycle = new Map<string, CycleEventFacts>();
  const prMergedBy = new Map<string, number>();
  const prOpenBy = new Map<string, number>();
  // FIX-348: cycleId → the PR number the cycle opened (from its cycle:terminal
  // twin), so the merge-truth reconcile can match by PR number when the merge
  // commit does NOT name the story-id.
  const prByCycle = new Map<string, number>();
  // US-DELIV-008: cycleId → the branch the cycle published (delivery:published),
  // so the unified reconcile engine can patch-id the branch against main.
  const branchByCycle = new Map<string, string>();
  const path = join(projectPath, ".roll", "loop", "events.ndjson");
  if (!existsSync(path)) return { events, byCycle, prMergedBy, prOpenBy, prByCycle, branchByCycle };
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { events, byCycle, prMergedBy, prOpenBy, prByCycle, branchByCycle };
  }
  const facts = (id: string): CycleEventFacts => {
    let f = byCycle.get(id);
    if (f === undefined) {
      f = { pairVerdicts: [] };
      byCycle.set(id, f);
    }
    return f;
  };
  for (const line of content.split("\n")) {
    const e: RollEvent | null = parseEventLine(line);
    if (e === null) continue;
    events.push(e);
    if (e.type === "peer:gate") facts(e.cycleId).peer = e.verdict;
    else if (e.type === "pair:verdict") facts(e.cycleId).pairVerdicts.push(e.verdict);
    else if (e.type === "pair:score") facts(e.cycleId).acceptedScore = { peer: e.peer, score: e.score, verdict: e.verdict };
    else if (e.type === "attest:gate") facts(e.cycleId).attest = e.verdict;
    else if (e.type === "pr:merge") prMergedBy.set(e.storyId, e.prNumber);
    else if (e.type === "pr:open") prOpenBy.set(e.storyId, e.prNumber);
    else if (e.type === "cycle:terminal" && e.pr.present) {
      const n = terminalPrNumber(e.pr.value);
      if (n !== undefined) prByCycle.set(e.cycleId, n);
    } else if (e.type === "delivery:published") {
      branchByCycle.set(e.cycleId, e.branch);
    }
  }
  return { events, byCycle, prMergedBy, prOpenBy, prByCycle, branchByCycle };
}

function scopedCycleEvents(events: readonly RollEvent[], cycleId: string, storyId: string, prNumber: number | undefined): RollEvent[] {
  const prSet = new Set<number>();
  if (prNumber !== undefined) prSet.add(prNumber);
  if (storyId !== "") {
    for (const ev of events) {
      if ((ev.type === "pr:open" || ev.type === "pr:merge") && ev.storyId === storyId) prSet.add(ev.prNumber);
    }
  }
  return events.filter((ev) => {
    if ("cycleId" in ev && typeof (ev as { cycleId?: unknown }).cycleId === "string") {
      return (ev as { cycleId: string }).cycleId === cycleId;
    }
    if (ev.type === "pr:open" || ev.type === "pr:merge") return storyId !== "" && ev.storyId === storyId;
    if (ev.type === "pr:rebase" || ev.type === "pr:close" || ev.type === "ci:pass" || ev.type === "ci:fail" || ev.type === "ci:rerun") {
      return prSet.has(ev.prNumber);
    }
    return false;
  });
}

/** FIX-348: the PR number from a `cycle:terminal` pr fact — the explicit
 *  `number` when present, otherwise parsed from the recorded `.../pull/<n>` url. */
function terminalPrNumber(pr: { url: string; state: string; number?: number }): number | undefined {
  if (typeof pr.number === "number" && Number.isInteger(pr.number) && pr.number > 0) return pr.number;
  const m = /\/pull\/(\d+)/.exec(pr.url);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function rowTape(row: Record<string, unknown>, verdict: CycleLedgerVerdict, ev: CycleEventFacts | undefined, prNumber: number | undefined, prOpen: number | undefined): CycleTapeSegment[] {
  const storyId = typeof row["story_id"] === "string" ? (row["story_id"] as string) : "";
  const tcr = typeof row["tcr_count"] === "number" ? (row["tcr_count"] as number) : 0;
  const seg = (key: CycleTapeSegment["key"], detail: string, state: CycleTapeSegment["state"]): CycleTapeSegment => ({ key, detail, state });
  // `cycle`/`story` segments record FACTS that already happened (the cycle ran,
  // a story was picked) — they stay green even on a failed row; the failure
  // shows where it actually bit (build/peer/ci/pr/end). kimi pair-review noted
  // the ambiguity; this is the intended reading of the trace tape.
  // FIX-351: `unpublished` (gates passed, work local, publish didn't land) is a
  // NEUTRAL end — never red. It renders as an `idle`-class (grey) end segment,
  // the same neutral color the verdict dot/badge use, so a sound-but-unpublished
  // cycle is visually distinct from a real `failed` (red).
  const endState =
    verdict === "delivered"
      ? "pass"
      : verdict === "idle" || verdict === "unpublished"
        ? "idle"
        : verdict === "unknown"
          ? "unknown"
          : "fail";
  return [
    seg("cycle", typeof row["ts"] === "string" ? (row["ts"] as string).replace("T", " ").replace(/:\d{2}Z$/, "Z") : "—", "pass"),
    seg("story", storyId !== "" ? storyId : "—", storyId !== "" ? "pass" : "idle"),
    seg("build", tcr > 0 ? `${tcr} commits` : "—", tcr > 0 ? "pass" : verdict === "idle" ? "idle" : "unknown"),
    seg(
      "peer",
      (() => {
        const parts: string[] = [];
        if (ev?.acceptedScore !== undefined) {
          parts.push(`score ${ev.acceptedScore.peer} ${ev.acceptedScore.score}/${ev.acceptedScore.verdict}`);
        }
        if (ev?.pairVerdicts.length) {
          parts.push(ev.pairVerdicts.join("/"));
        }
        if (parts.length === 0) {
          return ev?.peer === "consulted" ? "consulted" : ev?.peer === "skipped" ? "skipped" : "—";
        }
        return parts.join(" · ");
      })(),
      // US-OBS-045: an accepted score is a peer outcome; show it as pass unless
      // a code-stage verdict objected. A skipped peer gate is idle, not unknown.
      ev?.pairVerdicts.includes("object")
        ? "fail"
        : ev?.pairVerdicts.length || ev?.acceptedScore !== undefined || ev?.peer === "consulted"
          ? "pass"
          : ev?.peer === "skipped"
            ? "idle"
            : "unknown",
    ),
    seg("ci", ev?.attest === "produced" ? "attest ✓" : ev?.attest === "skipped" ? "attest skipped" : "—", ev?.attest === "produced" ? "pass" : ev?.attest === "skipped" ? "fail" : "unknown"),
    seg(
      "pr",
      prNumber !== undefined ? `#${prNumber} merged` : prOpen !== undefined ? `#${prOpen} open` : typeof row["merge_commit"] === "string" && row["merge_commit"] !== "" ? "merged" : "—",
      prNumber !== undefined || (typeof row["merge_commit"] === "string" && row["merge_commit"] !== "") ? "pass" : prOpen !== undefined ? "idle" : "unknown",
    ),
    seg("end", verdict, endState),
  ];
}

/** Collect the full ledger (newest first); range filtering happens client-side. */
export function collectCycleLedger(projectPath: string): CycleLedgerRow[] {
  const runsPath = join(projectPath, ".roll", "loop", "runs.jsonl");
  if (!existsSync(runsPath)) return [];
  let content = "";
  try {
    content = readFileSync(runsPath, "utf8");
  } catch {
    return [];
  }
  const { events, byCycle, prMergedBy, prOpenBy, prByCycle, branchByCycle } = readEventFacts(projectPath);
  const toolEvidence = collectToolEvidence(projectPath);
  const rows: CycleLedgerRow[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const cycleId = String(row["cycle_id"] ?? row["run_id"] ?? "");
    if (cycleId === "") continue;
    const status = String(row["status"] ?? "");
    const outcome = String(row["outcome"] ?? "");
    const verdict = isAgentInternalAttribution(row) ? "agent_internal_failure" : ledgerVerdict(status, outcome);
    // FIX-297: idle no-op heartbeats are loop liveness, not cycles — exclude them
    // from the ledger here at the collection point (they stay in runs.jsonl).
    if (isIdleHeartbeat(row, verdict)) continue;
    const storyId = typeof row["story_id"] === "string" ? (row["story_id"] as string) : "";
    // ts may be ISO or epoch (kimi pair-review).
    const rawTs = row["ts"];
    const ts = typeof rawTs === "string" ? Date.parse(rawTs) : typeof rawTs === "number" ? (rawTs > 10_000_000_000 ? rawTs : rawTs * 1000) : Number.NaN;
    const cost = typeof row["cost_effective_usd"] === "number" ? (row["cost_effective_usd"] as number) : typeof row["cost_usd"] === "number" ? (row["cost_usd"] as number) : undefined;
    // FIX-361: native currency from the runs row (v3 heart writes it). v2 rows
    // lack it — fall back to USD (the only currency they ever recorded).
    const currency = typeof row["cost_currency"] === "string" ? (row["cost_currency"] as string) : "USD";
    const curSymbol = currency === "CNY" ? "\u00A5" : "$";
    // FIX-290 AC3: a cycle whose usage was unreadable (usage_credentials_missing)
    // carries `usage_unknown:true` — its tokens/cost are UNKNOWN ("?"), not 0/—.
    const usageUnknown = row["usage_unknown"] === true;
    const usageUnknownReason = typeof row["usage_unknown_reason"] === "string" ? (row["usage_unknown_reason"] as string) : undefined;
    const agentInternalFailure =
      row["agent_internal_failure"] === true || isAgentInternalAttribution(row)
        ? {
            class: typeof row["agent_internal_class"] === "string" ? (row["agent_internal_class"] as string) : "harness:agent_internal",
            summary: typeof row["agent_internal_summary"] === "string" ? (row["agent_internal_summary"] as string) : String(row["root_cause_key"] ?? ""),
            nativeLogPath: typeof row["agent_internal_log_path"] === "string" ? (row["agent_internal_log_path"] as string) : "",
            conversationId:
              typeof row["agent_internal_conversation_id"] === "string"
                ? (row["agent_internal_conversation_id"] as string)
                : undefined,
          }
        : undefined;
    // REFACTOR-070: read failure_class/root_cause_key from runs row for ledger
    // diagnostic rendering (verdict detail enrichment, empty-bucket prevention).
    const failureClass =
      typeof row["failure_class"] === "string" && row["failure_class"] !== ""
        ? (row["failure_class"] as string)
        : undefined;
    const rootCauseKey =
      typeof row["root_cause_key"] === "string" && row["root_cause_key"] !== ""
        ? (row["root_cause_key"] as string)
        : undefined;
    const ev = byCycle.get(cycleId);
    const toolCosts = toolEvidence.costsByCycle.get(cycleId) ?? [];
    const prNumber = storyId !== "" ? prMergedBy.get(storyId) : undefined;
    const prOpen = storyId !== "" ? prOpenBy.get(storyId) : undefined;
    const ownPrNumber = prByCycle.get(cycleId) ?? prNumber ?? prOpen;
    const signals = cycleActivitySignalsFromEvents(scopedCycleEvents(events, cycleId, storyId, ownPrNumber), cycleId);
    const evidence: CycleLedgerRow["evidence"] = [];
    if (storyId !== "") evidence.push({ label: storyId, href: `#backlog` });
    rows.push({
      cycleId,
      tsSec: Number.isFinite(ts) ? Math.floor(ts / 1000) : 0,
      verdict,
      storyId,
      agent: String(row["agent"] ?? ""),
      model: typeof row["model"] === "string" && row["model"] !== "" ? (row["model"] as string) : "",
      tokens: fmtTokens(row["tokens_in"], row["tokens_out"], usageUnknown),
      cost: cost !== undefined ? `${curSymbol}${cost.toFixed(2)}` : usageUnknown ? "?" : "—",
      toolSummary: formatToolCostSummary(toolCosts),
      toolCosts,
      toolTimeline: toolEvidence.timelineByCycle.get(cycleId) ?? [],
      duration: fmtDuration(row["duration_sec"]),
      tape: rowTape(row, verdict, ev, prNumber, prOpen),
      signals,
      evidence,
      // FIX-348: the cycle's own PR number (cycle:terminal twin), falling back to
      // the merged/open PR event keyed by story when the terminal twin is absent.
      prNumber: ownPrNumber,
      // US-DELIV-008: the published branch, for the unified reconcile engine's
      // patch-id check (falls back to the loop/<cycleId> convention downstream).
      ...(branchByCycle.get(cycleId) !== undefined ? { branch: branchByCycle.get(cycleId) } : {}),
      // FIX-1050: agent-specific diagnostic reason for unknown usage.
      ...(usageUnknownReason !== undefined ? { usageUnknownReason } : {}),
      // FIX-1051: agent-internal failure diagnostics for detail output.
      ...(agentInternalFailure !== undefined ? { agentInternalFailure } : {}),
      // REFACTOR-070: failure attribution fields for diagnostic rendering.
      ...(failureClass !== undefined ? { failureClass } : {}),
      ...(rootCauseKey !== undefined ? { rootCauseKey } : {}),
    });
  }
  // De-dupe duplicate cycle ids (kimi pair-review): the LAST row wins — runs.jsonl
  // is append-only, so the newest record is the corrected truth.
  const byId = new Map<string, CycleLedgerRow>();
  for (const r of rows) byId.set(r.cycleId, r);
  const out = [...byId.values()];
  out.sort((a, b) => b.tsSec - a.tsSec);
  return out;
}
