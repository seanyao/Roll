/**
 * @responsibility Polls pending PRs into an updated local operator view.
 * FIX-1052 — Pending PR polling reconciler.
 *
 * After a cycle records `published_pending_merge` with a PR number, the local
 * operator view stays stale until someone manually fetches origin/main and
 * re-runs the view. This module provides a bounded, provider-portable polling
 * reconciler that polls the cloud PR state, fetches origin/main when the PR
 * merges, and rebuilds/appends delivery truth so `roll cycles`, `roll loop watch`,
 * and `roll truth query` show the reconciled state without manual intervention.
 *
 * Architecture:
 *   - Core is pure: decision logic + state schema, no network/fs/clock.
 *   - {@link PrStatusProvider} is the provider-specific adapter boundary.
 *   - {@link PendingPrReconciler} owns the bounded polling loop and the decision
 *     of what to do next (wait / mark delivered / mark not delivered / surface
 *     unknown).
 *   - {@link reconcilePendingPrs} is the high-level orchestration entry: given a
 *     list of pending delivery records, it polls each and produces a report of
 *     updates to apply (delivered records, reasons, errors).
 *
 * Idempotency: the reconciler only appends a new `done` delivery record when the
 * cloud state transitions to merged. Repeated polls for an already-merged PR see
 * the existing `done` record and short-circuit.
 */
import type { DeliveryRecord, LifecycleState } from "@roll/spec";
import type { CheckConclusion } from "./required-check.js";
import { present, absent } from "@roll/spec";

// ── Cloud PR state (data contract from FIX-1052 spec) ─────────────────────────

/** CI conclusion rolled up to the three states the reconcile policy cares about. */
export type PrCiState = "pending" | "green" | "red" | "unknown";

/** US-DELIV-010: gh mergeable rollup — the single vocabulary shared by the
 *  provider adapter, the reconcile facts, and the gh json parser. */
export type PrMergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** The PR's current cloud state as reported by a provider adapter. */
export type PrCloudState =
  | {
      kind: "open";
      ci: PrCiState;
      /** US-DELIV-010: draft PRs are not mergeable by policy. */
      draft?: boolean;
      /** US-DELIV-010: gh mergeable rollup (CONFLICTING = merge conflict). */
      mergeable?: PrMergeableState;
      /** FIX-1487: the head sha the CI verdict was computed from — pinned at merge. */
      headSha?: string;
      /**
       * FIX-1489: per-check name+conclusion on that same sha. Merge permission is a
       * NAMED judgment over this list, not the `ci` aggregate — the aggregate counts
       * SKIPPED as green, so a skipped `test-ts` used to merge untested.
       */
      checks?: readonly CheckConclusion[];
      checkedAt: string;
    }
  | { kind: "merged"; mergeCommit: string; mergedAt: string; checkedAt: string }
  | { kind: "closed_unmerged"; closedAt: string; checkedAt: string }
  | { kind: "unreachable"; reason: "offline" | "auth" | "provider_error" | "not_found"; checkedAt: string };

// ── Reconcile decision (data contract from FIX-1052 spec) ─────────────────────

/** The next action the reconciler decides for one pending PR. */
export type PendingPrReconcileDecision =
  | { action: "wait"; state: Extract<PrCloudState, { kind: "open" }>; nextPollAt: string }
  // E1: `fetchRef` is the integration branch to fetch after the merge lands —
  // configurable (default origin/main), so no longer a `"origin/main"` literal.
  | { action: "mark_delivered"; mergeCommit: string; mergedAt: string; fetchRef: string }
  | { action: "mark_not_delivered"; reason: "closed_unmerged" | "ci_red" }
  | { action: "surface_unknown"; state: Extract<PrCloudState, { kind: "unreachable" }>; retryable: boolean };

// ── Provider adapter boundary ─────────────────────────────────────────────────

/**
 * Provider-specific PR status adapter. GitHub is ONE implementation; the core
 * policy consumes only this interface.
 */
export interface PrStatusProvider {
  /** Human-readable provider name (for logs/observability). */
  readonly name: string;
  /**
   * Poll the cloud state of a single PR.
   *
   * @param slug - The `owner/repo` slug.
   * @param prNumber - The PR number.
   * @returns The current {@link PrCloudState}.
   */
  pollPrStatus(slug: string, prNumber: number): Promise<PrCloudState>;
}

// ── Polling options ───────────────────────────────────────────────────────────

/** Options controlling the bounded polling loop. */
export interface PendingPrReconcileOptions {
  /** E1: the integration branch fetched after a merge lands (default origin/main). */
  integrationBranch?: string;
  /** Maximum number of polls to attempt before giving up (default 20). */
  maxPolls?: number;
  /** Seconds to wait between polls (default 30). */
  pollIntervalSec?: number;
  /**
   * Absolute cutoff: if the reconcile loop would poll past this ISO timestamp,
   * it stops and returns `surface_unknown` with reason `timeout`. Default no
   * absolute cutoff.
   */
  deadlineIso?: string;
  /**
   * Injected clock for tests. Returns an ISO timestamp string.
   */
  nowIso?: () => string;
}

// ── Pure decision: map one PrCloudState → a reconcile decision ────────────────

/**
 * Map a single PR cloud-state observation to the next reconcile decision.
 * Pure: no clock, no history, no side effects.
 */
export function decidePendingPrReconcile(
  state: PrCloudState,
  opts: { pollIntervalSec?: number; nowIso?: () => string; integrationBranch?: string } = {},
): PendingPrReconcileDecision {
  const now = opts.nowIso ?? defaultNowIso;
  const intervalSec = opts.pollIntervalSec ?? 30;
  // E1: after a merge lands, the ref to fetch is the integration branch
  // (default origin/main → unchanged when unset).
  const fetchRef = opts.integrationBranch ?? "origin/main";

  switch (state.kind) {
    case "merged":
      return {
        action: "mark_delivered",
        mergeCommit: state.mergeCommit,
        mergedAt: state.mergedAt,
        fetchRef,
      };
    case "closed_unmerged":
      return { action: "mark_not_delivered", reason: "closed_unmerged" };
    case "open": {
      if (state.ci === "red") {
        return { action: "mark_not_delivered", reason: "ci_red" };
      }
      const nextAt = new Date(Date.parse(now()) + intervalSec * 1000).toISOString();
      return { action: "wait", state, nextPollAt: nextAt };
    }
    case "unreachable": {
      const retryable = state.reason === "offline" || state.reason === "provider_error";
      return { action: "surface_unknown", state, retryable };
    }
    default: {
      // Exhaustiveness guard: unreachable if a new kind is added.
      const _exhaustive: never = state;
      throw new Error(`unexpected PrCloudState kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function defaultNowIso(): string {
  return new Date().toISOString();
}

// ── Bounded polling loop ──────────────────────────────────────────────────────

/** Result of one reconcile attempt for a single pending PR. */
export interface PendingPrReconcileResult {
  /** The final decision reached (or the last decision if the loop timed out). */
  decision: PendingPrReconcileDecision;
  /** Number of polls actually performed. */
  polls: number;
  /** True when the loop reached a terminal decision on its own. */
  terminal: boolean;
}

/**
 * Run the bounded polling loop for one pending PR until it reaches a terminal
 * state or exhausts its budget. The `sleep` callback is injected so tests run
 * instantly and production can await real delays.
 */
export async function runPendingPrReconcile(
  provider: PrStatusProvider,
  slug: string,
  prNumber: number,
  opts: PendingPrReconcileOptions & { sleep?: (ms: number) => Promise<void> } = {},
): Promise<PendingPrReconcileResult> {
  const maxPolls = opts.maxPolls ?? 20;
  const intervalSec = opts.pollIntervalSec ?? 30;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const nowIso = opts.nowIso ?? defaultNowIso;

  let polls = 0;
  while (polls < maxPolls) {
    polls += 1;
    const state = await provider.pollPrStatus(slug, prNumber);
    const decision = decidePendingPrReconcile(state, { pollIntervalSec: intervalSec, nowIso, integrationBranch: opts.integrationBranch });

    if (decision.action !== "wait") {
      return { decision, polls, terminal: true };
    }

    // Absolute deadline check before sleeping.
    if (opts.deadlineIso !== undefined && nowIso() >= opts.deadlineIso) {
      const timeoutState: PrCloudState = {
        kind: "unreachable",
        reason: "offline",
        checkedAt: nowIso(),
      };
      return {
        decision: { action: "surface_unknown", state: timeoutState, retryable: true },
        polls,
        terminal: false,
      };
    }

    await sleep(intervalSec * 1000);
  }

  // Budget exhausted without a terminal state.
  const timeoutState: PrCloudState = {
    kind: "unreachable",
    reason: "offline",
    checkedAt: nowIso(),
  };
  return {
    decision: { action: "surface_unknown", state: timeoutState, retryable: true },
    polls,
    terminal: false,
  };
}

// ── Delivery-record helpers ───────────────────────────────────────────────────

/**
 * Build a `done` {@link DeliveryRecord} from merge evidence. This is the record
 * that gets appended to `deliveries.jsonl` when a pending PR merges.
 */
export function buildMergedDeliveryRecord(
  pending: DeliveryRecord,
  mergeCommit: string,
  mergedAtIso: string,
  recordedAt: number,
): DeliveryRecord {
  const mergedAtMs = Date.parse(mergedAtIso);
  return {
    storyId: pending.storyId,
    cycleId: pending.cycleId,
    lifecycleState: "done",
    prNumber: pending.prNumber.present ? pending.prNumber : absent("no_publish_attempted"),
    prUrl: pending.prUrl,
    mergedAt: Number.isFinite(mergedAtMs) ? present(mergedAtMs) : absent("not_recorded"),
    mergeCommit: present(mergeCommit),
    recordedAt,
  };
}

/**
 * Build a non-delivered {@link DeliveryRecord} that surfaces the reason without
 * claiming delivery. Used for closed-unmerged / CI-red outcomes.
 */
export function buildNotDeliveredRecord(
  pending: DeliveryRecord,
  lifecycle: LifecycleState,
  reason: string,
  recordedAt: number,
): DeliveryRecord {
  return {
    storyId: pending.storyId,
    cycleId: pending.cycleId,
    lifecycleState: lifecycle,
    prNumber: pending.prNumber.present ? pending.prNumber : absent("no_publish_attempted"),
    prUrl: pending.prUrl,
    mergedAt: absent("not_recorded"),
    mergeCommit: absent("not_recorded"),
    recordedAt,
  };
}

// ── Batch reconcile entry ─────────────────────────────────────────────────────

/** Input for {@link reconcilePendingPrs}: one pending record to poll. */
export interface PendingPrReconcileItem {
  /** The delivery record currently in `pending_merge` (or `ci_red`). */
  record: DeliveryRecord;
  /** The `owner/repo` slug for the provider. */
  slug: string;
  /** The PR number to poll. */
  prNumber: number;
}

/** Result for one item from {@link reconcilePendingPrs}. */
export interface PendingPrReconcileItemResult {
  record: DeliveryRecord;
  prNumber: number;
  result: PendingPrReconcileResult;
  /** When the decision is `mark_delivered`, the new record to append. */
  newRecord?: DeliveryRecord;
  /** Human-readable reason for non-delivered / unknown outcomes. */
  reason?: string;
}

/** Batch reconcile a list of pending PRs. Each PR is polled independently. */
export async function reconcilePendingPrs(
  provider: PrStatusProvider,
  items: readonly PendingPrReconcileItem[],
  opts: PendingPrReconcileOptions & { sleep?: (ms: number) => Promise<void> } = {},
): Promise<PendingPrReconcileItemResult[]> {
  const now = Date.now();
  const out: PendingPrReconcileItemResult[] = [];

  for (const item of items) {
    const r = await runPendingPrReconcile(provider, item.slug, item.prNumber, opts);
    const res: PendingPrReconcileItemResult = { record: item.record, prNumber: item.prNumber, result: r };

    if (r.decision.action === "mark_delivered") {
      res.newRecord = buildMergedDeliveryRecord(
        item.record,
        r.decision.mergeCommit,
        r.decision.mergedAt,
        now,
      );
    } else if (r.decision.action === "mark_not_delivered") {
      res.reason = r.decision.reason;
      res.newRecord = buildNotDeliveredRecord(
        item.record,
        r.decision.reason === "ci_red" ? "ci_red" : "abandoned",
        r.decision.reason,
        now,
      );
    } else if (r.decision.action === "surface_unknown") {
      res.reason = r.decision.state.reason;
    }

    out.push(res);
  }

  return out;
}
