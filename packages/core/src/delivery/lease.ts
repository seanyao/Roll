/**
 * @responsibility Consults the one-card-one-lease delivery claim before dispatch.
 * US-DELIV-005 — one-card-one-lease: the picker's delivery-lease consult.
 *
 * Root cause addressed: same-card fan-out waste (the ir-pipeline failure — 3
 * agents racing one card, only one merge lands, the rest is discarded work).
 * Quality redundancy comes from the adversarial pair INSIDE one cycle
 * (US-LOOP-100..106), NOT from parallel duplicate builds.
 *
 * Model (design §4):
 *   - A lease is DERIVED from the event stream, never hand-written: each
 *     cycle's DeliveryState projection (projectDeliveryState) maps to a
 *     story-level DeliveryLeaseState. Terminal superseded/abandoned holds no
 *     lease; an ENDED cycle without a terminal delivery state releases its
 *     in_flight lease — a legal fix-forward retry of the same card is NOT
 *     parallel fan-out and must stay pickable.
 *   - `deliveryLease(storyId, leases)` is the pure pre-pick consult: a card
 *     held in any lease state → pick:false with reason + heldBy. `--race` is
 *     the explicit opt-in for parallel racing.
 *   - `siblingCancelEvents` is the race resolution: on the FIRST merge, every
 *     remaining sibling lease on that story is atomically superseded (one
 *     batch of delivery:reconciled events appended by the caller).
 *
 * Pure: no filesystem, no clock, no side effects. Idempotent.
 */
import type { DeliveryLease, DeliveryLeaseState, DeliveryState, RollEvent } from "@roll/spec";
import { projectDeliveryState } from "./state.js";

/**
 * Map a cycle's delivery projection to its story-level lease state.
 *
 * @param state - The cycle's DeliveryState (from projectDeliveryState).
 * @param cycleEnded - True when the cycle has a `cycle:end` event. Only an
 *   in_flight hold is released on cycle end — awaiting_merge / ci_red /
 *   delivered are durable holds independent of the cycle process (the loop was
 *   released at publish; the PR still awaits merge; fix-forward runs through
 *   `roll loop pr-heal`, not a fresh pick).
 * @returns The lease state, or undefined when the cycle holds no lease.
 */
export function leaseStateFor(state: DeliveryState, cycleEnded: boolean): DeliveryLeaseState | undefined {
  switch (state) {
    case "building":
    case "blocked_no_evidence":
      return cycleEnded ? undefined : "in_flight";
    case "awaiting_merge":
      return "awaiting_merge";
    case "ci_failed":
      return "ci_red";
    case "delivered":
    case "delivered_external":
      return "delivered";
    case "superseded":
    case "abandoned":
      return undefined;
  }
}

/**
 * Fold the event stream into the set of ACTIVE story leases — one per cycle
 * whose projection still holds its card. Pure + total.
 */
export function projectDeliveryLeases(events: readonly RollEvent[]): DeliveryLease[] {
  const byCycle = new Map<string, RollEvent[]>();
  for (const ev of events) {
    if (!("cycleId" in ev) || typeof ev.cycleId !== "string") continue;
    const slice = byCycle.get(ev.cycleId);
    if (slice === undefined) byCycle.set(ev.cycleId, [ev]);
    else slice.push(ev);
  }
  const leases: DeliveryLease[] = [];
  for (const [cycleId, slice] of byCycle) {
    // Only a cycle that actually STARTED can hold a card — incidental events
    // that merely mention a cycleId (pick:skipped, alerts) never create a
    // lease holder.
    if (!slice.some((ev) => ev.type === "cycle:start")) continue;
    const storyEvent = slice.find((ev): ev is RollEvent & { storyId: string } => "storyId" in ev);
    const storyId = storyEvent?.storyId;
    if (storyId === undefined) continue;
    const ended = slice.some((ev) => ev.type === "cycle:end");
    const state = leaseStateFor(projectDeliveryState(slice, cycleId), ended);
    if (state !== undefined) leases.push({ storyId, cycleId, state });
  }
  return leases;
}

/** The picker's lease consult result. */
export interface DeliveryLeaseVerdict {
  /** True when the card may be picked (free, or --race opt-in). */
  pick: boolean;
  /** Why the pick is blocked (or why a race pick was allowed). */
  reason?: string;
  /** The cycle holding the card, when any. */
  heldBy?: string;
}

/**
 * The pre-pick consult (design §4). Default is strict one-card-one-lease:
 * any active lease on the story blocks the pick. `race: true` is the explicit
 * opt-in for parallel racing — the caller stamps the cost-budget discipline.
 *
 * Pure: same inputs → same verdict.
 */
export function deliveryLease(
  storyId: string,
  leases: readonly DeliveryLease[],
  opts: { race?: boolean } = {},
): DeliveryLeaseVerdict {
  const holders = leases.filter((l) => l.storyId === storyId);
  if (holders.length === 0) return { pick: true };
  const holder = holders[0]!;
  if (opts.race === true) {
    return { pick: true, reason: `race opt-in: parallel allowed (held: ${holder.state})`, heldBy: holder.cycleId };
  }
  return { pick: false, reason: `card held: ${holder.state}`, heldBy: holder.cycleId };
}

/**
 * Picker-predicate adapter over {@link deliveryLease}: returns the skip reason
 * (with heldBy) when the card is lease-blocked, undefined when it is pickable.
 * Slots directly into `PickOptions.deliveryLeaseBlock`.
 */
export function leaseBlockReason(
  storyId: string,
  leases: readonly DeliveryLease[],
  opts: { race?: boolean } = {},
): string | undefined {
  const v = deliveryLease(storyId, leases, opts);
  if (v.pick) return undefined;
  return v.heldBy !== undefined ? `${v.reason} (${v.heldBy})` : v.reason;
}

/** Identity of the cycle that merged first (the race winner). */
export interface RaceWinner {
  cycleId: string;
  mergeCommit: string;
  signal: "pr_state" | "patch_id" | "backlog_attest";
  mergedBy: "runner" | "external";
}

/**
 * The race resolution: on the FIRST merge, build the supersede events for
 * every remaining sibling lease on the story. The caller appends the winner's
 * delivered event and these payloads in ONE batch — the atomic cancel.
 *
 * Terminal siblings hold no lease (projectDeliveryLeases already excluded
 * them), so re-running is idempotent: a superseded sibling never re-appears.
 */
export function siblingCancelEvents(
  storyId: string,
  winner: RaceWinner,
  leases: readonly DeliveryLease[],
  now: number,
): Array<{
  type: "delivery:reconciled";
  cycleId: string;
  storyId: string;
  state: "superseded";
  mergedBy: "runner" | "external";
  mergeCommit: string;
  signal: "pr_state" | "patch_id" | "backlog_attest";
  ts: number;
}> {
  return leases
    .filter((l) => l.storyId === storyId && l.cycleId !== winner.cycleId)
    .map((l) => ({
      type: "delivery:reconciled" as const,
      cycleId: l.cycleId,
      storyId,
      state: "superseded" as const,
      mergedBy: winner.mergedBy,
      mergeCommit: winner.mergeCommit,
      signal: winner.signal,
      ts: now,
    }));
}
