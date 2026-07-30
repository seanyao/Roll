/**
 * US-DELIV-002 — layered reconcile-from-main: the heart of the delivery
 * reconciler epic. A PURE function that determines delivery truth from
 * layered signals (design §3.3, §4).
 *
 * Invariants:
 * - ≥1 strong signal (L1 PR-state | L2 patch-id) required to declare delivered.
 * - L3 alone (backlog Done + attest) is NEVER sufficient.
 * - When no signal hits, return `wait` — never fabricate a delivery.
 * - main is the single anchor; cycle ledger is a pure projection.
 *
 * Pure: no filesystem, no network, no clock, no side effects.
 * Idempotent: same inputs → same output.
 * Exhaustively unit-testable.
 */

import type { DeliveryState } from "@roll/spec";
import type { PrMergeableState } from "./pr-reconcile.js";
import { DEFAULT_REQUIRED_CHECK, requiredCheckVerdict, type CheckConclusion } from "./required-check.js";

// ── Input types ───────────────────────────────────────────────────────────────

/** A cycle's delivery-relevant facts, extracted from runs/events. */
export interface ReconcileCycle {
  cycleId: string;
  storyId: string;
  branch: string;
  prNumber?: number;
  /** Current deliveryState from the event projection (projectDeliveryState). */
  deliveryState: DeliveryState;
  /**
   * US-DELIV-010: epoch ms when the cycle entered `awaiting_merge`
   * (the `delivery:published` event ts). Combined with {@link ReconcileFacts.nowMs}
   * it yields the dwell time every degraded/terminal verdict carries.
   */
  awaitingSinceMs?: number;
}

/** External facts gathered by the IO adapter (gh / git). */
export interface ReconcileFacts {
  /** L1: PR state from gh (undefined = gh unavailable / PR not found). */
  prState?: "OPEN" | "MERGED" | "CLOSED";
  /** FIX-1487: head sha the CI verdict came from; pinned into the merge request. */
  headSha?: string;
  /** L1: merge commit SHA from the PR (only when prState is MERGED). */
  prMergeCommit?: string;
  /**
   * L2: git patch-id of the diff (origin/main...branch) — the net diff the
   * cycle branch introduced. Undefined when the branch cannot be resolved
   * (deleted / never pushed).
   */
  branchNetPatchId?: string;
  /**
   * L2: set of patch-ids from main's merge commits since the branch's fork
   * point. Each entry is git-patch-id(diff of one commit on main).
   * Empty when main has no commits past the branch base (should not happen
   * for a merged PR, but handled gracefully).
   */
  mainPatchIds: ReadonlySet<string>;
  /**
   * Aggregate CI status for the PR. FIX-1489: this is now only a WAIT/RED signal —
   * it can no longer license a merge on its own, because `reduceStatusCheckRollup`
   * counts SKIPPED/NEUTRAL as green and `ci.yml` has a real `if:` that makes
   * `test-ts` skipped. Merge permission comes from {@link checks} below.
   */
  ciGreen?: boolean;
  /**
   * FIX-1489: per-check name+conclusion on the CI verdict's head sha. Merge
   * permission is a NAMED judgment over this list (see {@link requiredChecks}).
   * Absent → fail-closed: the reconciler waits instead of falling back to
   * `ciGreen`. "A gate that never ran is not a gate that passed."
   */
  checks?: readonly CheckConclusion[];
  /**
   * FIX-1489/FIX-1488: the required-check SET. Every name must be present on the
   * head sha AND conclude `success`. Defaults to `[DEFAULT_REQUIRED_CHECK]`; the
   * doc-drift gate joins it when that flips hard (IDEA-084 US-RULE-004c).
   */
  requiredChecks?: readonly string[];
  /** L3 cross-check: does the backlog row say Done? */
  backlogDone: boolean;
  /** L3 cross-check: does an attest report exist? */
  attestPresent: boolean;
  /** US-DELIV-010: the PR is a draft (not mergeable by policy). */
  prDraft?: boolean;
  /** US-DELIV-010: gh mergeable rollup (CONFLICTING = merge conflict). */
  prMergeable?: PrMergeableState;
  /** US-DELIV-010: why gh could not answer (auth = missing permission). */
  prUnreachableReason?: "offline" | "auth" | "provider_error" | "not_found";
  /** US-DELIV-010: caller-injected clock (epoch ms) for dwell computation. */
  nowMs?: number;
}

// ── Output types ──────────────────────────────────────────────────────────────

/**
 * US-DELIV-010: why an awaiting_merge cycle is DEGRADED — stuck but not dead;
 * the PR still exists and a fix-forward (or human triage) can unblock it.
 * Every degraded verdict is observable (reason + dwell) for the US-DELIV-012
 * rendering and is NEVER a delivered.
 */
export type DegradedReason =
  | "ci_stuck"
  | "merge_conflict"
  | "draft"
  | "no_permission";

/**
 * US-DELIV-010: why an awaiting_merge cycle is TERMINAL — the PR is gone and
 * this cycle can never merge as-is. Still NEVER a delivered: termination is
 * an honest classification for human triage, not a credit.
 */
export type TerminalReason = "pr_closed_unmerged";

/**
 * US-DELIV-010: CI long-red threshold. A cycle that has dwelt in
 * awaiting_merge at least this long while its PR's CI is red is `ci_stuck`
 * (degraded) instead of a plain `ci_failed` — a day-old red is a stuck PR,
 * not a check in flight. (Dwell is anchored on `delivery:published`; the
 * engine does not know when CI itself turned red.)
 */
export const CI_STUCK_DWELL_MS = 24 * 60 * 60 * 1000;

export type ReconcileResult =
  | {
      kind: "delivered";
      via: "runner" | "external";
      signal: "pr_state" | "patch_id";
      mergeCommit?: string;
    }
  | { kind: "merge_now"; method: "squash" }
  | { kind: "ci_failed" }
  | { kind: "degraded"; reason: DegradedReason; dwellMs?: number }
  | { kind: "terminal"; reason: TerminalReason; dwellMs?: number }
  | { kind: "superseded"; reason: string }
  | { kind: "wait" };

// ── Pure decision function ────────────────────────────────────────────────────

/**
 * Determine delivery truth for one cycle from layered signals.
 *
 * Layered truth determination (design §3.3):
 *   L1 — PR state (MERGED, strongest signal, authoritative).
 *   L2 — patch-id equivalence (squash/rebase-safe, offline-capable).
 *   L3 — backlog Done + attest (weak, cross-check only; NEVER sufficient alone).
 *
 * Decision rules (priority order):
 *   1. PR MERGED → delivered (L1 authoritative; via=external unless the caller
 *      has runner context).
 *   2. branchNetPatchId ∈ mainPatchIds → delivered_external (L2, works offline).
 *      L1+L2 both hit: L1 wins, L2 is corroborating evidence.
 *   3. PR CLOSED (unmerged) → terminal(pr_closed_unmerged) — US-DELIV-010.
 *   4. PR OPEN: draft → degraded(draft); merge conflict →
 *      degraded(merge_conflict); CI green → merge_now; CI red past
 *      {@link CI_STUCK_DWELL_MS} → degraded(ci_stuck); CI red → ci_failed;
 *      mergeable UNKNOWN / CI unknown → wait (transient).
 *   5. gh unreachable auth → degraded(no_permission); other gh errors → wait.
 *   6. Nothing hits → wait (never fabricate delivered). L3 alone is never
 *      sufficient.
 *
 * Guardrails:
 *   - L1/L2 "conflict": L1 MERGED always wins. L2 miss on an amend is expected.
 *   - Uncertain → wait: when prState is undefined AND branchNetPatchId is
 *     undefined, no strong signal is possible → wait.
 *   - US-DELIV-010: degraded/terminal are honest classifications with reason +
 *     dwell for observability and human triage — NEVER delivered, and a
 *     closed/conflicting/draft PR is never merge_now.
 *
 * @param cyc - The cycle facts from the event projection.
 * @param facts - External facts gathered by the IO adapter.
 * @returns A {@link ReconcileResult} — pure, deterministic, idempotent.
 */
export function reconcileDelivery(
  cyc: ReconcileCycle,
  facts: ReconcileFacts,
): ReconcileResult {
  const dwellMs =
    cyc.awaitingSinceMs !== undefined && facts.nowMs !== undefined
      ? Math.max(0, facts.nowMs - cyc.awaitingSinceMs)
      : undefined;

  // ── L1: PR state is the strongest signal ──────────────────────────────────
  if (facts.prState === "MERGED") {
    return {
      kind: "delivered",
      // L1 alone does not distinguish runner vs external — the caller stamps
      // via from merge evidence context. Default to external since runner
      // self-merge is tracked via delivery:merge_attempt events.
      via: "external",
      signal: "pr_state",
      mergeCommit: facts.prMergeCommit,
    };
  }

  // ── L2: patch-id equivalence (squash/rebase safe) ─────────────────────────
  // Only triggers when L1 did NOT fire (PR not merged, or gh unavailable).
  // patch-id is computed from the DIFF content, so a squash merge that rewrote
  // the commit title/body still matches (US-DELIV-010 matrix).
  if (
    facts.branchNetPatchId !== undefined &&
    facts.mainPatchIds.has(facts.branchNetPatchId)
  ) {
    return {
      kind: "delivered",
      via: "external",
      signal: "patch_id",
    };
  }

  // ── US-DELIV-010: terminal — PR closed without merge ──────────────────────
  // L1/L2 both silent on a CLOSED PR means the cycle can never merge as-is.
  // Honest classification for human triage — NEVER a delivered.
  if (facts.prState === "CLOSED") {
    return { kind: "terminal", reason: "pr_closed_unmerged", dwellMs };
  }

  // ── L1 + L2 both silent: assess the OPEN PR (merge_now / degraded / ci) ───
  if (facts.prState === "OPEN") {
    // A draft PR is not mergeable by policy — classify, don't attempt merge.
    if (facts.prDraft === true) {
      return { kind: "degraded", reason: "draft", dwellMs };
    }
    // A merge conflict blocks any merge attempt — classify before merge_now.
    if (facts.prMergeable === "CONFLICTING") {
      return { kind: "degraded", reason: "merge_conflict", dwellMs };
    }
    if (facts.ciGreen === true) {
      // mergeable UNKNOWN is transient — GitHub hasn't confirmed mergeability;
      // a green CI alone is not license to squash → wait, never merge blind.
      if (facts.prMergeable === "UNKNOWN") {
        return { kind: "wait" };
      }
      // FIX-1489: the aggregate got us this far; the NAMED verdict decides.
      // Without this, a skipped `test-ts` reduced to "green" and merged untested —
      // the hole FIX-1487 closed for the release path but not for story cards.
      if (facts.checks === undefined) return { kind: "wait" };
      const verdict = requiredCheckVerdict(facts.checks, facts.requiredChecks ?? DEFAULT_REQUIRED_CHECK);
      if (!verdict.ok) {
        // pending → keep waiting; anything else (absent / skipped / failed) is a
        // refusal, never a merge.
        if (verdict.reason === "pending") return { kind: "wait" };
        return { kind: "ci_failed" };
      }
      return { kind: "merge_now", method: "squash" };
    }
    if (facts.ciGreen === false) {
      // CI long-red: the engine knows the CYCLE has dwelt in awaiting_merge
      // past the threshold with CI red (not how long CI itself has been red)
      // → degraded(ci_stuck) with dwell.
      if (dwellMs !== undefined && dwellMs >= CI_STUCK_DWELL_MS) {
        return { kind: "degraded", reason: "ci_stuck", dwellMs };
      }
      return { kind: "ci_failed" };
    }
    // mergeable UNKNOWN / CI unknown → transient; wait (no verdict).
  }

  // ── US-DELIV-010: gh unreachable — auth is durable, the rest is transient ──
  if (facts.prState === undefined && facts.prUnreachableReason === "auth") {
    return { kind: "degraded", reason: "no_permission", dwellMs };
  }

  // ── L3 alone: never sufficient ────────────────────────────────────────────
  // The design is explicit (§3.3, §8): L3 alone (backlog Done + attest) is NOT
  // sufficient to declare delivered. An agent can pre-write Done or symlink
  // attest (FIX-304). Only L1 or L2 (real merge evidence on main) credits
  // delivery.

  // ── All signals exhausted, no strong evidence → wait (never fabricate) ─────
  return { kind: "wait" };
}

/**
 * Build a `delivery:reconciled` event payload from a reconcile result.
 * The caller appends this event; the cycle ledger re-projects from it via
 * `projectDeliveryState`.
 *
 * Pure: result in, event payload out. No side effects.
 */
export function reconciledEventPayload(
  cyc: ReconcileCycle,
  result: Extract<ReconcileResult, { kind: "delivered" }>,
  now: number,
): {
  type: "delivery:reconciled";
  cycleId: string;
  storyId: string;
  state: "delivered" | "delivered_external";
  mergedBy: "runner" | "external";
  mergeCommit: string;
  signal: "pr_state" | "patch_id" | "backlog_attest";
  patchId?: string;
  ts: number;
} {
  return {
    type: "delivery:reconciled",
    cycleId: cyc.cycleId,
    storyId: cyc.storyId,
    state: result.via === "runner" ? "delivered" : "delivered_external",
    mergedBy: result.via,
    mergeCommit: result.mergeCommit ?? "unknown",
    signal: result.signal,
    ts: now,
  };
}
