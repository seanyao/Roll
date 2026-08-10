/**
 * @responsibility Declares the structured delivery record and lifecycle state types.
 */
/**
 * US-TRUTH-013 — Structured Delivery Record + Lifecycle State enumeration.
 *
 * This is the foundation of the structured-truth-review epic: the machine-managed
 * delivery truth lives as a strong-schema record, NOT parsed from markdown prose.
 *
 * Two orthogonal dimensions (pi clarified in the 3-agent review):
 *   - LifecycleState: WHERE the card is in the delivery pipeline (machine-derived).
 *   - TruthState (truth.ts selectors): the VERDICT on whether a claim matches
 *     the facts (truth/warn/fail/unknown/grandfathered).
 *
 * These are independent fields that must NOT be conflated — a card can be
 * `in_flight` (lifecycle) AND `warn` (verdict, because its claim lagged).
 *
 * Lifecycle is DERIVED from TerminalOutcome + PR state via lifecycleFromFacts(),
 * never hand-set — no second vocabulary.
 */
import type { HistoricalTerminalOutcome } from "./terminal.js";
import type { FactOr } from "./terminal.js";

// ── DeliveryState (US-DELIV-001) ─────────────────────────────────────────────

/**
 * Cycle-level DELIVERY dimension vocabulary (delivery-reconciler design §3.1).
 *
 * Orthogonal to {@link LifecycleState} (story-level, derived from
 * TerminalOutcome + PR facts): DeliveryState tracks ONE CYCLE's delivery
 * lifecycle and is projected PURELY from the event stream — see
 * `projectDeliveryState` in @roll/core. No path may hand-write a terminal
 * delivery state without appending the event that carries it.
 *
 * `awaiting_merge` is a genuine SUSPENSION: the branch+PR exist and the loop
 * is released to pick the next card; the state advances only when a later
 * `delivery:reconciled` / `delivery:merge_attempt` event lands — never by
 * blocking on the merge.
 *
 * `delivered_local` (E3, local-only delivery mode) is a TERMINAL success that
 * NEVER passed through `awaiting_merge`: a `publish_mode: local` project lands
 * the cycle onto its LOCAL integration branch and skips push→PR→CI→merge
 * entirely. The evidence gate still runs (a gate-block still routes to
 * `blocked_no_evidence`, exactly as remote); on success the cycle reconciles
 * straight to `delivered_local` with the local landing commit SHA. It is
 * sticky like the other delivered terminals — a later delivery event can never
 * regress it.
 */
export const DELIVERY_STATES = [
  "building",
  "blocked_no_evidence",
  "awaiting_merge",
  "ci_failed",
  "delivered",
  "delivered_external",
  "delivered_local",
  "superseded",
  "abandoned",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

// ── DeliveryLease (US-DELIV-005) ─────────────────────────────────────────────

/**
 * Story-level LEASE vocabulary (delivery-reconciler design §4). One card, one
 * lease: the picker consults `deliveryLease(storyId, leases)` before picking;
 * a card held in ANY of these states is skipped (default: no same-card
 * fan-out). `--race` is the explicit opt-in for parallel racing.
 *
 * Derived from the cycle-level {@link DeliveryState} projection, never
 * hand-set:
 *   building / blocked_no_evidence → in_flight   (a live cycle holds the card)
 *   awaiting_merge                 → awaiting_merge
 *   ci_failed                      → ci_red
 *   delivered / delivered_external → delivered
 *   superseded / abandoned         → (no lease — released)
 */
export const DELIVERY_LEASE_STATES = ["in_flight", "awaiting_merge", "ci_red", "delivered"] as const;
export type DeliveryLeaseState = (typeof DELIVERY_LEASE_STATES)[number];

/** A story lease: one cycle holding one card in a lease state. */
export interface DeliveryLease {
  /** Story identifier (US-XXX / FIX-XXX / REFACTOR-XXX). */
  storyId: string;
  /** The cycle that holds the card. */
  cycleId: string;
  /** Derived lease state — see DELIVERY_LEASE_STATES. */
  state: DeliveryLeaseState;
}

// ── LifecycleState (AC2) ─────────────────────────────────────────────────────

/**
 * Closed lifecycle state vocabulary. These represent WHERE a story is in the
 * delivery pipeline, machine-derived from TerminalOutcome + PR facts.
 *
 * @remarks
 * **Orthogonal to {@link TruthState}** (truth/warn/fail/unknown/grandfathered).
 * TruthState is the VERDICT of a claim-vs-facts audit; LifecycleState is the
 * current pipeline position. They are ALWAYS both present as independent fields
 * — never conflate them. Example: a card with an open PR whose backlog row
 * still reads 📋 Todo has lifecycle `in_flight` (the PR proves work is in
 * flight) and TruthState `warn` (the claim lags).
 */
export const LIFECYCLE_STATES = [
  "todo",
  "building",
  "pending_merge",
  "ci_red",
  "blocked",
  "on_hold",
  "done",
  "failed",
  "abandoned",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/**
 * PR-level state, used as input to lifecycleFromFacts. The `ci_red` lifecycle
 * state is derived when a story is in_flight AND the PR has a CI-red signal.
 */
export type PrState = "none" | "open" | "open_ci_red" | "merged" | "closed" | "unknown";

// ── DeliveryRecord (AC1) ─────────────────────────────────────────────────────

/**
 * A machine-managed structured delivery record — the authoritative truth about
 * one story's delivery lifecycle. Built ON TerminalOutcome (no parallel truth
 * type). Every field uses FactOr<T> so a missing value carries an explicit
 * reason, never a silent zero/null.
 */
export interface DeliveryRecord {
  /** Story identifier (US-XXX / FIX-XXX / REFACTOR-XXX). */
  storyId: string;
  /** The cycle that produced this delivery. */
  cycleId: string;
  /** Machine-derived lifecycle state — computed, never hand-set. */
  lifecycleState: LifecycleState;
  /** GitHub PR number, when one exists. */
  prNumber: FactOr<number>;
  /** GitHub PR URL, when one exists. */
  prUrl: FactOr<string>;
  /** When the PR merged (epoch ms), when applicable. */
  mergedAt: FactOr<number>;
  /** The merge commit SHA on main, when the PR merged. */
  mergeCommit: FactOr<string>;
  /** When this record was written (epoch ms). */
  recordedAt: number;
}

// ── lifecycleFromFacts (AC3) ─────────────────────────────────────────────────

/**
 * AC5 — CI-red sub-state annotation. When the story lifecycle is `in_flight`
 * and the PR CI is red, this flag is set on the record so consumers can
 * distinguish "PR open, waiting for CI" (normal in_flight) from
 * "CI red, needs fix-forward" (in_flight with ciRed sub-marker).
 *
 * The story is still `in_flight` — the author pushes a fix, CI re-runs, and
 * the story stays `in_flight` (NOT state-flipped to a transient "ci_red").
 * The ci_red LIFECYCLE_STATE value above is the STATES-MATRIX definition;
 * it IS a LifecycleState for consumers that prefer a flat state, but its
 * semantics are "in_flight + sub:ci_red".
 */
export interface CiRedSubState {
  /** True when the PR's CI check is failing. */
  ciRed: true;
}

/**
 * Pure function: derive a card's lifecycle state from two machine facts —
 * the terminal outcome (what the cycle produced) and the PR state (what
 * GitHub confirms).
 *
 * @param terminalOutcome - The cycle's TerminalOutcome (US-TRUTH-001 vocabulary).
 * @param prState - The PR's current state on GitHub.
 * @returns The derived LifecycleState — never hand-set.
 */
export function lifecycleFromFacts(
  terminalOutcome: HistoricalTerminalOutcome,
  prState: PrState,
): LifecycleState {
  // A red main CI is a structural block and intentionally outranks merge
  // evidence until the owner fixes or reverts the broken merge.
  if (terminalOutcome === "ci_red_after_merge") return "ci_red";

  // ── Done: PR merged → done ──────────────────────────────────────────
  if (prState === "merged") return "done";

  // ── In-flight cluster ──────────────────────────────────────────────
  // published_pending_merge + PR open → in_flight (the classic case)
  if (terminalOutcome === "published_pending_merge") {
    if (prState === "open") return "pending_merge";
    if (prState === "open_ci_red") return "ci_red";
    // PR closed without merge → abandoned (work was pushed, PR got closed)
    if (prState === "closed") return "abandoned";
    // PR unknown → still in_flight (we published, assume PR is open)
    return "pending_merge";
  }

  // delivered (already merged or will be) — if not merged yet, it's in_flight
  if (terminalOutcome === "delivered") {
    if (prState === "open") return "pending_merge";
    if (prState === "open_ci_red") return "ci_red";
    return "done"; // prState === "merged" handled above; fallback for backfilled
  }

  // unpublished: gates passed, publish didn't land — the work exists locally
  if (terminalOutcome === "unpublished") return "building";

  // ── Failed cluster ─────────────────────────────────────────────────
  if (terminalOutcome === "failed") return "failed";
  if (terminalOutcome === "agent_internal_failure") return "failed";
  if (terminalOutcome === "blocked") return "blocked";

  // ── Aborted cluster ────────────────────────────────────────────────
  if (terminalOutcome === "aborted_no_delivery") return "failed";
  if (terminalOutcome === "aborted_with_delivery") {
    if (prState === "open") return "pending_merge";
    if (prState === "open_ci_red") return "ci_red";
    return "failed";
  }

  // ── Idle / gave_up / handoff_without_tcr / orphan ────────────────────
  if (terminalOutcome === "idle_no_work") return "todo";
  if (terminalOutcome === "gave_up") return "failed";
  // FIX-1039: a builder left worktree changes without TCR — the cycle did not
  // deliver, so it's failed (recoverable but not done). The preserved worktree
  // gives the owner a recovery path; the backlog story stays retryable.
  if (terminalOutcome === "handoff_without_tcr") return "failed";
  if (terminalOutcome === "orphan_timeout") return "blocked";

  // ── Unknown ────────────────────────────────────────────────────────
  // A cycle that started but has no known outcome → building (best guess)
  return "building";
}
