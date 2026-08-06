/**
 * @responsibility Pure projection of the durable cycle-handoff/v1 event family.
 * US-CYCLE-013 — a completed build becomes a durable, resumable handoff instead
 * of burning its review/test/publish/merge tail inside the same run.
 *
 * This module is PURE: no fs, no clock, no spawn. It folds the already-parsed
 * RollEvent stream (events.ndjson) into per-cycle handoff state
 * ({@link projectCycleHandoff}), the project-wide capacity graph
 * ({@link projectHandoffCapacity}), and the per-cycle event slice
 * ({@link handoffEventForCycle}).
 *
 * Fold rules (pinned by the design contract §3):
 *   - Events fold in FILE order (equal `ts` does not order events).
 *   - Terminal facts are sticky; `cleanup_completed` and `abandoned` are
 *     terminal.
 *   - A HandoffIdentity is live only when exactly one matching
 *     `worktree:allocated` precedes its `admitted`, the stored member
 *     identities agree, and no terminal follows.
 *   - Invalid payloads, out-of-order events, a terminal before ready/handoff,
 *     conflicting heads, duplicate non-identical ready/handoff facts fold to
 *     `serial_recovery` with all leases retained — they NEVER free a
 *     reservation, delete a worktree, publish, or invent a merge.
 *   - A repeated event with the same idempotency key is a no-op; the same key
 *     with a different payload is `handoff:conflict` (blocks that cycle).
 *
 * Capacity invariants (checked by the scheduler, not enforced here):
 * exactly one waiting tail + exactly one build-slot holder (building OR ready);
 * a third card is FIFO-queued.
 */
import {
  CYCLE_HANDOFF_EVENT_TYPES,
  parseCycleHandoffEvent,
  type CycleHandoffEvent,
  type CycleQueueEvent,
  type HandoffIdentity,
} from "@roll/spec";
import type { RollEvent } from "@roll/spec";

export type HandoffCycleState =
  | "building"
  | "builder_validated_waiting_for_tail"
  | "waiting_for_evaluation_or_test"
  | "evaluating_or_testing"
  | "publish_or_merge_wait"
  | "serial_recovery"
  | "terminal";

export interface HandoffCycleView {
  cycleId: string;
  storyId: string;
  state: HandoffCycleState;
  /** Present once admitted (the LAST identity-bearing fact wins). */
  identity?: HandoffIdentity;
  /** `ready:<storyId>:<attempt>:<fence>` — set once builder_ready was folded. */
  readyKey?: string;
  /** The FIFO queue sequence allocated under the scheduler mutex. */
  queueSequence?: number;
  /** Human-readable reason when `state === "serial_recovery"`. */
  recoveryReason?: string;
  /** Terminal disposition when `state === "terminal"`. */
  terminal?: "cleaned" | "abandoned";
}

export interface HandoffCapacity {
  /** The one waiting/evaluating/publish tail cycle. */
  tailCycleId?: string;
  /** building OR builder_validated_waiting_for_tail (the build-slot holder). */
  buildHolderCycleId?: string;
  /** subset of the build holder: builder validated, awaiting tail capacity. */
  readyHolderCycleId?: string;
  /** FIFO queue (ordered by (queueSequence, storyId)); only the head may admit. */
  queue: Array<{ storyId: string; cycleId: string; queueSequence: number; reason: string }>;
  /** cycles in serial_recovery / with a recovery_required record (fail closed). */
  blockedCycleIds: string[];
}

/** Is `ev` a member of the cycle-handoff/v1 family? (lenient: type-name only). */
export function isCycleHandoffEvent(ev: RollEvent): ev is CycleHandoffEvent {
  return (CYCLE_HANDOFF_EVENT_TYPES as readonly string[]).includes(ev.type);
}

/** The cycleId an event belongs to, across all three carrier fields. */
export function cycleIdOf(ev: CycleHandoffEvent): string {
  if ("identity" in ev && ev.identity !== undefined && typeof ev.identity.cycleId === "string" && ev.identity.cycleId !== "") return ev.identity.cycleId;
  if ("cycleId" in ev && typeof ev.cycleId === "string") return ev.cycleId;
  if ("requestedByCycleId" in ev && ev.requestedByCycleId !== "") return ev.requestedByCycleId;
  return "";
}

/** The deterministic ready key `ready:<storyId>:<attempt>:<fence>`. */
export function handoffReadyKey(identity: HandoffIdentity): string {
  return `ready:${identity.storyId}:${identity.attempt}:${identity.fence}`;
}

/** The deterministic admission key `admit:<cycleId>:<attempt>`. */
export function handoffAdmitKey(identity: HandoffIdentity): string {
  return `admit:${identity.cycleId}:${identity.attempt}`;
}

/** Events for one cycle in the handoff family, in file order. */
export function handoffEventForCycle(events: readonly RollEvent[], cycleId: string): CycleHandoffEvent[] {
  const out: CycleHandoffEvent[] = [];
  for (const ev of events) {
    if (!isCycleHandoffEvent(ev)) continue;
    if (cycleIdOf(ev) === cycleId) out.push(ev);
  }
  return out;
}

/** Payload identity for idempotency: the semantic payload minus ts/eventId. */
function payloadOf(ev: CycleHandoffEvent): string {
  const { ts: _ts, eventId: _eventId, ...rest } = ev as unknown as Record<string, unknown>;
  return JSON.stringify(rest);
}

interface Folded {
  view: HandoffCycleView;
  seenKeys: Map<string, string>;
}

function invalidFold(cycleId: string, storyId: string, reason: string): Folded {
  return {
    view: {
      cycleId,
      storyId,
      state: "serial_recovery",
      recoveryReason: reason,
    },
    seenKeys: new Map(),
  };
}

/**
 * Fold ONE cycle's handoff stream (in file order) into its current view.
 * Returns `undefined` for a cycle with NO handoff facts (never admitted /
 * never queued — the serial lifecycle projection owns those cycles).
 */
export function projectCycleHandoff(events: readonly RollEvent[], cycleId: string): HandoffCycleView | undefined {
  const cycleEvents = handoffEventForCycle(events, cycleId);
  if (cycleEvents.length === 0) return undefined;
  return foldHandoffEvents(events, cycleId).view;
}

function foldHandoffEvents(events: readonly RollEvent[], cycleId: string): Folded {
  const seenKeys = new Map<string, string>();
  let view: HandoffCycleView = { cycleId, storyId: "", state: "building" };
  let allocationCount = 0;
  let knownStoryId = "";

  const toRecovery = (reason: string): Folded => {
    const folded = invalidFold(cycleId, view.storyId, reason);
    return folded;
  };

  for (const raw of events) {
    // Track matching worktree:allocated facts IN FILE ORDER — a HandoffIdentity
    // is live only when exactly one matching allocation PRECEDES its admitted
    // (a fresh attempt after recovery legitimately allocates a second workspace,
    // which must not invalidate the new admission).
    if (raw.type === "worktree:allocated") {
      const ws = raw.workspace;
      if (ws.runId === cycleId || (knownStoryId !== "" && ws.storyId === knownStoryId)) {
        allocationCount += 1;
      }
      continue;
    }
    // A terminal cycle:end releases the build slot for a cycle that was admitted
    // but never reached builder_ready (failed/aborted/blocked → abandoned), and
    // is the handoff path's OWN terminal when the tail reached
    // publish_or_merge_wait (cleanup follows). A cycle:end while the handoff is
    // still live (ready/waiting/evaluating) is a serial duplicate — fail closed.
    if (raw.type === "cycle:end" && raw.cycleId === cycleId) {
      if (view.identity === undefined) continue; // no handoff facts — not ours
      if (view.state === "building") {
        view = { ...view, state: "terminal", terminal: "abandoned" };
      } else if (view.state !== "publish_or_merge_wait" && view.state !== "terminal" && view.state !== "serial_recovery") {
        return toRecovery("serial_duplicate_terminal");
      }
      continue;
    }
    if (!isCycleHandoffEvent(raw)) continue;
    if (cycleIdOf(raw) !== cycleId) continue;
    const ev = raw;
    // Strict per-type validation: an invalid family payload folds to serial
    // recovery with all leases retained (never a guessed transition).
    const parsed = parseCycleHandoffEvent(ev);
    if (parsed === null) return toRecovery(`invalid_payload:${ev.type}`);
    const event = parsed;
    if (knownStoryId === "" && "identity" in event && event.identity !== undefined) knownStoryId = event.identity.storyId;
    if (knownStoryId === "" && "storyId" in event && typeof event.storyId === "string") knownStoryId = event.storyId;

    // Idempotency: same key + same payload = no-op; same key + different
    // payload = handoff:conflict (blocks the cycle).
    const key = event.idempotencyKey;
    const payload = payloadOf(event);
    const prior = seenKeys.get(key);
    if (prior !== undefined) {
      if (prior === payload) continue; // replay — no state change
      return toRecovery("handoff:conflict");
    }
    seenKeys.set(key, payload);

    // Terminal facts are sticky — nothing after terminal changes the view.
    if (view.state === "terminal") return { view, seenKeys };

    switch (event.type) {
      case "cycle:queued":
      case "cycle:queue_rejected": {
        const queueEvent = event as CycleQueueEvent;
        view = { ...view, storyId: view.storyId !== "" ? view.storyId : queueEvent.storyId, queueSequence: queueEvent.queueSequence };
        if (view.state === "building" && view.identity === undefined) {
          // A queue marker alone is not admission; keep the pre-admission view
          // invisible to the capacity graph (handled below via admitted).
        }
        continue;
      }
      case "cycle:admitted": {
        // Legal only from none (first admission) or serial_recovery (a new
        // owned attempt after recovery). A second live admission = conflict.
        if (view.identity !== undefined && view.state !== "serial_recovery") {
          return toRecovery("duplicate_admission");
        }
        const identity = event.identity;
        // Exactly one matching worktree:allocated must precede this admitted.
        // (The counter resets here so a FRESH attempt after recovery counts only
        // its own new allocation — a prior attempt's workspace is not a second
        // match for the new admission.)
        if (allocationCount !== 1) return toRecovery("workspace_allocation_mismatch");
        allocationCount = 0;
        view = {
          cycleId: identity.cycleId,
          storyId: identity.storyId,
          state: "building",
          identity,
          ...(view.queueSequence !== undefined ? { queueSequence: view.queueSequence } : {}),
        };
        continue;
      }
      case "cycle:builder_ready": {
        if (view.state !== "building" || view.identity === undefined) {
          return toRecovery("ready_out_of_order");
        }
        // The ready fact INTRODUCES the verified builderHead (base → committed
        // head); only the stable admission triplet (cycle, attempt, fence) and
        // the workspace identity must agree with the admitted fact.
        if (!identityMatchesExceptHead(view.identity, event.identity)) return toRecovery("ready_identity_mismatch");
        view = { ...view, identity: event.identity, state: "builder_validated_waiting_for_tail", readyKey: handoffReadyKey(event.identity) };
        continue;
      }
      case "cycle:builder_handoff": {
        if (view.state !== "builder_validated_waiting_for_tail" || view.identity === undefined) {
          return toRecovery("handoff_out_of_order");
        }
        if (event.previousReadyKey !== view.readyKey) return toRecovery("handoff_key_mismatch");
        if (!identityMatches(view.identity, event.identity)) return toRecovery("handoff_identity_mismatch");
        // Atomic promotion: release build + acquire tail in one fold.
        view = { ...view, identity: event.identity, state: "waiting_for_evaluation_or_test" };
        continue;
      }
      case "cycle:tail_started": {
        // Idempotent replay: the same fenced tail_started is a no-op when the
        // tail already moved past waiting (evaluating, or completed to
        // publish_or_merge_wait on a crash between the start and completion).
        if (view.identity !== undefined && event.fence === view.identity.fence &&
            (view.state === "evaluating_or_testing" || view.state === "publish_or_merge_wait")) {
          continue;
        }
        if (view.state !== "waiting_for_evaluation_or_test" || view.identity === undefined) {
          return toRecovery("tail_start_out_of_order");
        }
        if (event.cycleId !== view.identity.cycleId || event.attempt !== view.identity.attempt || event.fence !== view.identity.fence) {
          return toRecovery("tail_start_fence_mismatch");
        }
        view = { ...view, state: "evaluating_or_testing" };
        continue;
      }
      case "cycle:tail_completed": {
        // Idempotent replay: already completed (crash before cleanup).
        if (view.state === "publish_or_merge_wait" && view.identity !== undefined && event.fence === view.identity.fence) {
          continue;
        }
        if (view.state !== "evaluating_or_testing" || view.identity === undefined) {
          return toRecovery("tail_complete_out_of_order");
        }
        if (event.fence !== view.identity.fence) return toRecovery("tail_complete_fence_mismatch");
        view = { ...view, state: "publish_or_merge_wait" };
        continue;
      }
      case "cycle:tail_cancelled": {
        // Cancellation routes to serial_recovery with all leases retained
        // (build released by the durable recovery transition).
        if (view.state === "serial_recovery") continue;
        if (view.identity === undefined) return toRecovery("cancel_without_identity");
        if (event.fence !== view.identity.fence && event.reason !== "stale_fence") {
          return toRecovery("cancel_fence_mismatch");
        }
        view = { ...view, state: "serial_recovery", recoveryReason: event.reason ?? "tail_cancelled" };
        continue;
      }
      case "cycle:serial_recovery": {
        if (view.identity === undefined) return toRecovery("recovery_without_identity");
        if (event.fence !== view.identity.fence) continue; // stale recovery — inert
        view = { ...view, state: "serial_recovery", recoveryReason: event.reason ?? "serial_recovery" };
        continue;
      }
      case "cycle:main_freshness": {
        // Any freshness verdict routes the tail to serial_recovery: `continue`
        // pins a new owned attempt, the failure verdicts cancel the tail. The
        // old handoff/evaluation authority is invalidated either way.
        if (view.identity === undefined) return toRecovery("freshness_without_identity");
        if (event.fence !== view.identity.fence) continue; // stale probe — inert
        view = { ...view, state: "serial_recovery", recoveryReason: `freshness_${event.verdict}` };
        continue;
      }
      case "cycle:rebased_attempt_planned": {
        if (view.identity === undefined) return toRecovery("rebase_without_identity");
        if (event.sourceFence !== view.identity.fence) continue; // stale plan — inert
        // Tail released atomically; story + old workspace retained; old head
        // cannot publish.
        view = { ...view, state: "serial_recovery", recoveryReason: "rebased_attempt_planned" };
        continue;
      }
      case "cycle:rebased_attempt_validated": {
        // Informational confirmation of the new owned attempt; the fold keeps
        // the current state until the fresh admitted/builder_ready arrives.
        continue;
      }
      case "cycle:cleanup_started": {
        // Informational; only cleanup_completed is a terminal fact.
        continue;
      }
      case "cycle:cleanup_completed": {
        if (view.identity === undefined) return toRecovery("cleanup_without_identity");
        if (event.fence !== view.identity.fence) return toRecovery("cleanup_fence_mismatch");
        const legalFrom = [
          "publish_or_merge_wait",
          "evaluating_or_testing",
          "waiting_for_evaluation_or_test",
          // A cleanup retry with the SAME identity/fence succeeds after a
          // cleanup failure (serial_recovery) — the only fact that releases the
          // workspace + story lease for the handoff path.
          "serial_recovery",
        ];
        if (!legalFrom.includes(view.state)) return toRecovery("cleanup_out_of_order");
        view = { ...view, state: "terminal", terminal: "cleaned" };
        continue;
      }
      default: {
        const _exhaustive: never = event;
        return toRecovery(`unknown_event:${String((_exhaustive as { type?: string }).type)}`);
      }
    }
  }
  return { view, seenKeys };
}

/** Do two workspace sets carry the same member identities (repo/locator/head)? */
function workspacesAgree(a: HandoffIdentity["workspace"], b: HandoffIdentity["workspace"]): boolean {
  if (a.members.length !== b.members.length) return false;
  const byLocator = new Map(a.members.map((m) => [m.relativeLocator, m]));
  for (const member of b.members) {
    const other = byLocator.get(member.relativeLocator);
    if (other === undefined) return false;
    if (other.repositoryId !== member.repositoryId) return false;
    if (other.checkoutRef.head !== member.checkoutRef.head) return false;
  }
  return true;
}

/** Do two identities carry the same (cycleId, attempt, fence, workspace, head)? */
function identityMatches(a: HandoffIdentity, b: HandoffIdentity): boolean {
  return (
    a.cycleId === b.cycleId &&
    a.attempt === b.attempt &&
    a.fence === b.fence &&
    a.builderHead === b.builderHead &&
    workspacesAgree(a.workspace, b.workspace)
  );
}

/**
 * Same as {@link identityMatches} but the builderHead may differ — used when the
 * READY fact first records the verified committed head (the admitted fact can
 * only carry the allocation base). Cycle/attempt/fence + workspace must still
 * agree exactly.
 */
function identityMatchesExceptHead(a: HandoffIdentity, b: HandoffIdentity): boolean {
  return (
    a.cycleId === b.cycleId &&
    a.attempt === b.attempt &&
    a.fence === b.fence &&
    workspacesAgree(a.workspace, b.workspace)
  );
}

/**
 * Project the project-wide capacity graph from the full event stream: the one
 * tail, the one build-slot holder (building or ready), the FIFO queue, and the
 * blocked cycles. Reads ONLY the event stream — no directory scan, no
 * in-memory promise, no backlog edit can grant capacity.
 */
export function projectHandoffCapacity(events: readonly RollEvent[]): HandoffCapacity {
  const capacity: HandoffCapacity = { queue: [], blockedCycleIds: [] };
  const cycleIds = new Set<string>();
  const queueEntries: Array<{ storyId: string; cycleId: string; queueSequence: number; reason: string }> = [];
  const admittedCycleIds = new Set<string>();

  for (const ev of events) {
    if (!isCycleHandoffEvent(ev)) continue;
    const cid = cycleIdOf(ev);
    if (cid === "") continue;
    cycleIds.add(cid);
    if (ev.type === "cycle:queued" || ev.type === "cycle:queue_rejected") {
      queueEntries.push({ storyId: ev.storyId, cycleId: ev.requestedByCycleId, queueSequence: ev.queueSequence, reason: ev.reason });
    }
  }

  for (const cid of cycleIds) {
    const view = projectCycleHandoff(events, cid);
    if (view === undefined) continue;
    if (view.identity !== undefined) admittedCycleIds.add(cid);
    switch (view.state) {
      case "building":
        // A queued-only card (cycle:queued, no admitted) is NOT a build holder —
        // only an admitted identity occupies the build slot.
        if (view.identity === undefined) break;
        if (capacity.buildHolderCycleId === undefined) capacity.buildHolderCycleId = cid;
        else capacity.blockedCycleIds.push(cid); // second build holder — fail closed
        break;
      case "builder_validated_waiting_for_tail":
        if (capacity.buildHolderCycleId === undefined) capacity.buildHolderCycleId = cid;
        else capacity.blockedCycleIds.push(cid);
        if (capacity.readyHolderCycleId === undefined) capacity.readyHolderCycleId = cid;
        break;
      case "waiting_for_evaluation_or_test":
      case "evaluating_or_testing":
      case "publish_or_merge_wait":
        if (capacity.tailCycleId === undefined) capacity.tailCycleId = cid;
        else capacity.blockedCycleIds.push(cid); // second tail — fail closed
        break;
      case "serial_recovery":
        capacity.blockedCycleIds.push(cid);
        break;
      case "terminal":
        break;
    }
  }

  // FIFO queue: dedupe by storyId (a card is queued once; the LAST queued fact
  // wins), drop entries whose cycle is already admitted/terminal, sort by
  // (queueSequence, storyId). Only the head may be admitted.
  const byStory = new Map<string, { storyId: string; cycleId: string; queueSequence: number; reason: string }>();
  for (const entry of queueEntries) {
    if (admittedCycleIds.has(entry.cycleId)) continue;
    byStory.set(entry.storyId, entry);
  }
  capacity.queue = [...byStory.values()].sort((a, b) =>
    a.queueSequence !== b.queueSequence ? a.queueSequence - b.queueSequence : a.storyId < b.storyId ? -1 : 1,
  );

  // Blocked also includes cycles with an explicit worktree:recovery_required
  // record — never cleaned/reallocated automatically.
  for (const ev of events) {
    if (ev.type === "worktree:recovery_required" && !capacity.blockedCycleIds.includes(ev.runId)) {
      capacity.blockedCycleIds.push(ev.runId);
    }
  }
  capacity.blockedCycleIds = [...new Set(capacity.blockedCycleIds)];
  return capacity;
}
