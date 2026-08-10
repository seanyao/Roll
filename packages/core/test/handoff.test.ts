/**
 * US-CYCLE-013 — pure projection tests for the durable cycle-handoff/v1 family
 * (packages/core/src/loop/handoff.ts). Fixture event logs only — no fs, no
 * clock, no agent. Covers the design matrix rows 2–10 and 12–16: normal
 * handoff, replay/idempotency, ready-while-tail-occupied, promotion ordering,
 * cancellation, crash prefixes, scheduler races, capacity, freshness verdicts,
 * evaluation repair, cleanup, and the historic/flag-off/old-reader surface.
 */
import { describe, expect, it } from "vitest";
import type { CycleHandoffEvent, HandoffIdentity, ManagedWorkspaceSet, RollEvent } from "@roll/spec";
import {
  handoffEventForCycle,
  handoffReadyKey,
  isCycleHandoffEvent,
  projectCycleHandoff,
  projectHandoffCapacity,
  type HandoffCapacity,
  type HandoffCycleView,
} from "../src/index.js";

/** One immutable fixture workspace set per cycle (the allocator's identity). */
function workspaceFor(cycleId: string, storyId: string, baseSha = "base-sha"): ManagedWorkspaceSet {
  return {
    schema: 1,
    runId: cycleId,
    storyId,
    kind: "cycle",
    topology: "solo",
    members: [{
      repositoryId: "repo-id",
      workspaceKey: `cycle-${cycleId}`,
      relativeLocator: `cycle-${cycleId}`,
      checkoutRef: { kind: "detached", head: baseSha },
      publishRef: `refs/heads/loop/cycle-${cycleId}`,
    }],
  };
}

function identityFor(cycleId: string, storyId: string, attempt = 1, fence = "fence", head = "head-sha", base = "base-sha"): HandoffIdentity {
  return {
    schema: "cycle-handoff/v1",
    cycleId,
    storyId,
    workspace: workspaceFor(cycleId, storyId, base),
    branch: `loop/cycle-${cycleId}`,
    builderHead: head,
    baseSha: base,
    builderEvidenceRefs: [`ev-${cycleId}`],
    builderValidationRef: `builder-validation:${cycleId}:${attempt}`,
    profile: "standard",
    attempt,
    fence,
  };
}

/** The `worktree:allocated` fact the allocator emits BEFORE the admitted. */
function allocatedFor(cycleId: string, storyId: string): RollEvent {
  return { type: "worktree:allocated", workspace: workspaceFor(cycleId, storyId), ts: 0 };
}

function admitted(identity: HandoffIdentity, queueSequence = 1): CycleHandoffEvent {
  return { type: "cycle:admitted", eventId: `ev-admit-${identity.cycleId}`, idempotencyKey: `admit:${identity.cycleId}:${identity.attempt}`, identity, queueSequence, ts: 1 };
}

function ready(identity: HandoffIdentity, reason: "tail_capacity_full" | "promotion_pending" = "promotion_pending"): CycleHandoffEvent {
  return { type: "cycle:builder_ready", eventId: `ev-ready-${identity.cycleId}`, idempotencyKey: handoffReadyKey(identity), identity, reason, ts: 2 };
}

function handoff(identity: HandoffIdentity): CycleHandoffEvent {
  return {
    type: "cycle:builder_handoff",
    eventId: `ev-handoff-${identity.cycleId}`,
    idempotencyKey: `handoff:${identity.storyId}:${identity.attempt}:${identity.fence}`,
    identity,
    previousReadyKey: handoffReadyKey(identity),
    next: "evaluate_or_test",
    ts: 3,
  };
}

function tailStarted(identity: HandoffIdentity): CycleHandoffEvent {
  return { type: "cycle:tail_started", eventId: `ev-ts-${identity.cycleId}`, idempotencyKey: `tail_started:${identity.cycleId}:${identity.attempt}:${identity.fence}`, cycleId: identity.cycleId, attempt: identity.attempt, fence: identity.fence, ts: 4 };
}

function tailCompleted(identity: HandoffIdentity): CycleHandoffEvent {
  return { type: "cycle:tail_completed", eventId: `ev-tc-${identity.cycleId}`, idempotencyKey: `tail_completed:${identity.cycleId}:${identity.attempt}:${identity.fence}`, cycleId: identity.cycleId, attempt: identity.attempt, fence: identity.fence, evidenceRefs: ["ev"], ts: 5 };
}

function cleanupCompleted(identity: HandoffIdentity): CycleHandoffEvent {
  return { type: "cycle:cleanup_completed", eventId: `ev-cc-${identity.cycleId}`, idempotencyKey: `cleanup_completed:${identity.cycleId}:${identity.attempt}:${identity.fence}`, cycleId: identity.cycleId, attempt: identity.attempt, fence: identity.fence, releasedWorkspace: true, ts: 6 };
}

function serialRecovery(identity: HandoffIdentity, reason = "repair_required"): CycleHandoffEvent {
  return { type: "cycle:serial_recovery", eventId: `ev-sr-${identity.cycleId}`, idempotencyKey: `recovery:${identity.cycleId}:${identity.attempt}:${identity.fence}:${reason}`, cycleId: identity.cycleId, attempt: identity.attempt, fence: identity.fence, reason, ts: 6 };
}

function freshness(identity: HandoffIdentity, verdict: "continue" | "conflict" | "test_failed" | "unknown" | "timeout"): CycleHandoffEvent {
  return {
    type: "cycle:main_freshness",
    eventId: `ev-fr-${identity.cycleId}`,
    idempotencyKey: `freshness:${identity.cycleId}:${identity.fence}`,
    cycleId: identity.cycleId,
    fence: identity.fence,
    predecessorMergeSha: "m1",
    recordedBaseSha: identity.baseSha,
    builderHead: identity.builderHead,
    verdict,
    evidenceRefs: [],
    ts: 4,
  };
}

function rebasedPlanned(identity: HandoffIdentity): CycleHandoffEvent {
  return {
    type: "cycle:rebased_attempt_planned",
    eventId: `ev-rp-${identity.cycleId}`,
    idempotencyKey: `rebased_planned:${identity.cycleId}:${identity.attempt}`,
    cycleId: identity.cycleId,
    sourceAttempt: identity.attempt,
    sourceFence: identity.fence,
    candidateRef: `refs/roll/rebase-candidates/${identity.cycleId}/${identity.attempt}`,
    candidateHead: "r1",
    predecessorMergeSha: "m1",
    evidenceRefs: [],
    ts: 4,
  };
}

function viewOf(events: readonly RollEvent[], cycleId: string): HandoffCycleView | undefined {
  return projectCycleHandoff(events, cycleId);
}

describe("US-CYCLE-013 — normal handoff (matrix #2)", () => {
  const A = identityFor("cA", "US-A");
  const events: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A)];

  it("folds to waiting_for_evaluation_or_test with the identity + readyKey retained", () => {
    const view = viewOf(events, "cA");
    expect(view?.state).toBe("waiting_for_evaluation_or_test");
    expect(view?.identity?.cycleId).toBe("cA");
    expect(view?.readyKey).toBe(handoffReadyKey(A));
    expect(view?.identity?.workspace.members[0]?.workspaceKey).toBe("cycle-cA");
  });

  it("reports the capacity graph: one tail, zero build holders, empty queue", () => {
    const cap = projectHandoffCapacity(events);
    expect(cap.tailCycleId).toBe("cA");
    expect(cap.buildHolderCycleId).toBeUndefined();
    expect(cap.readyHolderCycleId).toBeUndefined();
    expect(cap.queue).toEqual([]);
    expect(cap.blockedCycleIds).toEqual([]);
  });

  it("handoffEventForCycle returns the cycle's events in file order", () => {
    const slice = handoffEventForCycle(events, "cA");
    expect(slice.map((e) => e.type)).toEqual(["cycle:admitted", "cycle:builder_ready", "cycle:builder_handoff"]);
    expect(isCycleHandoffEvent(events[1]!)).toBe(true);
  });

  it("terminal: publish → tail_completed → cleanup_completed is sticky terminal", () => {
    const full: RollEvent[] = [...events, tailStarted(A), tailCompleted(A), cleanupCompleted(A)];
    const view = viewOf(full, "cA");
    expect(view?.state).toBe("terminal");
    expect(view?.terminal).toBe("cleaned");
    // Terminal facts are sticky: a late ready/handoff after cleanup is inert.
    const replayed = [...full, ready(A), handoff(A)];
    expect(viewOf(replayed, "cA")?.state).toBe("terminal");
  });
});

describe("US-CYCLE-013 — duplicate / replayed handoff (matrix #3)", () => {
  it("replaying the same key+payload is a no-op (same view, no second promotion)", () => {
    const A = identityFor("cA", "US-A");
    const base: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A)];
    const replay: RollEvent[] = [...base, { ...admitted(A), ts: 99 }, { ...ready(A), ts: 99 }, { ...handoff(A), ts: 99 }];
    expect(viewOf(replay, "cA")?.state).toBe("waiting_for_evaluation_or_test");
    const cap = projectHandoffCapacity(replay);
    expect(cap.tailCycleId).toBe("cA");
    expect(cap.blockedCycleIds).toEqual([]);
  });

  it("same key + DIFFERENT payload is handoff:conflict → serial_recovery (blocked)", () => {
    const A = identityFor("cA", "US-A");
    const altered = { ...ready(A), identity: identityFor("cA", "US-A", 1, "other-fence", "other-head") };
    const events: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A), ready(A), altered];
    const view = viewOf(events, "cA");
    expect(view?.state).toBe("serial_recovery");
    expect(view?.recoveryReason).toBe("handoff:conflict");
    expect(projectHandoffCapacity(events).blockedCycleIds).toContain("cA");
  });
});

describe("US-CYCLE-013 — B completes while A owns the tail (matrix #4)", () => {
  it("B appends exactly one fenced builder_ready and retains the build slot; C cannot be admitted", () => {
    const A = identityFor("cA", "US-A");
    const B = identityFor("cB", "US-B");
    const C = identityFor("cC", "US-C");
    const events: RollEvent[] = [
      allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A), tailStarted(A),
      allocatedFor("cB", "US-B"), admitted(B),
      ready(B, "tail_capacity_full"),
      { type: "cycle:queued", eventId: "ev-q-cC", idempotencyKey: "queue:US-C:3", storyId: "US-C", requestedByCycleId: "cC", queueSequence: 3, reason: "build_slot_full", ts: 9 },
    ];
    const viewB = viewOf(events, "cB");
    expect(viewB?.state).toBe("builder_validated_waiting_for_tail");
    expect(viewB?.identity?.fence).toBe(B.fence);
    expect(viewB?.readyKey).toBe(handoffReadyKey(B));
    const cap = projectHandoffCapacity(events);
    expect(cap.tailCycleId).toBe("cA");
    expect(cap.buildHolderCycleId).toBe("cB"); // ready holder still owns the build slot
    expect(cap.readyHolderCycleId).toBe("cB");
    expect(cap.queue.map((q) => q.storyId)).toEqual(["US-C"]);
    expect(cap.queue[0]).toMatchObject({ cycleId: "cC", queueSequence: 3, reason: "build_slot_full" });
  });
});

describe("US-CYCLE-013 — promotion ordering (matrix #5, #6)", () => {
  it("A frees the tail before B completes → B is promoted; ≤ one build holder throughout", () => {
    const A = identityFor("cA", "US-A");
    const B = identityFor("cB", "US-B");
    const events: RollEvent[] = [
      allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A), tailStarted(A), tailCompleted(A), cleanupCompleted(A),
      allocatedFor("cB", "US-B"), admitted(B), ready(B, "promotion_pending"), handoff(B),
    ];
    const cap = projectHandoffCapacity(events);
    expect(cap.tailCycleId).toBe("cB");
    expect(cap.buildHolderCycleId).toBeUndefined();
    expect(cap.queue).toEqual([]);
  });

  it("B completes before A frees the tail → ready survives; A release promotes B before any C admission", () => {
    const A = identityFor("cA", "US-A");
    const B = identityFor("cB", "US-B");
    const C = identityFor("cC", "US-C");
    const beforeRelease: RollEvent[] = [
      allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A), tailStarted(A),
      allocatedFor("cB", "US-B"), admitted(B), ready(B, "tail_capacity_full"),
    ];
    // B still ready — C queued.
    const cap1 = projectHandoffCapacity([...beforeRelease, { type: "cycle:queued", eventId: "ev-q", idempotencyKey: "queue:US-C:3", storyId: "US-C", requestedByCycleId: "cC", queueSequence: 3, reason: "build_slot_full", ts: 9 }]);
    expect(cap1.readyHolderCycleId).toBe("cB");
    // A's tail completes + cleanup → tail frees → B promoted (before C can admit).
    const afterRelease: RollEvent[] = [...beforeRelease, tailCompleted(A), cleanupCompleted(A), handoff(B)];
    const cap2 = projectHandoffCapacity(afterRelease);
    expect(cap2.tailCycleId).toBe("cB");
    expect(cap2.buildHolderCycleId).toBeUndefined();
    expect(viewOf(afterRelease, "cB")?.state).toBe("waiting_for_evaluation_or_test");
  });
});

describe("US-CYCLE-013 — repeated ready / promotion / cancellation (matrix #7)", () => {
  it("duplicate ready keys are no-ops; altered fence fails closed", () => {
    const A = identityFor("cA", "US-A");
    const duplicate: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A), ready(A), ready(A)];
    expect(viewOf(duplicate, "cA")?.state).toBe("builder_validated_waiting_for_tail");
    const stalePromotion: RollEvent[] = [...duplicate, { ...handoff(A), previousReadyKey: "ready:US-A:1:WRONG" }];
    const view = viewOf(stalePromotion, "cA");
    expect(view?.state).toBe("serial_recovery");
    expect(view?.recoveryReason).toBe("handoff_key_mismatch");
  });

  it("a current cancellation routes to serial_recovery without losing the evidence/identity", () => {
    const A = identityFor("cA", "US-A");
    const events: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A), tailStarted(A), {
      type: "cycle:tail_cancelled",
      eventId: "ev-cancel",
      idempotencyKey: `tail_cancelled:${A.cycleId}:${A.attempt}:${A.fence}:repair_required`,
      cycleId: A.cycleId,
      attempt: A.attempt,
      fence: A.fence,
      reason: "repair_required",
      ts: 7,
    }];
    const view = viewOf(events, "cA");
    expect(view?.state).toBe("serial_recovery");
    expect(view?.recoveryReason).toBe("repair_required");
    // The identity (evidence/workspace) is retained for the recovery.
    expect(view?.identity?.builderEvidenceRefs).toEqual(["ev-cA"]);
    expect(view?.identity?.workspace.members[0]?.workspaceKey).toBe("cycle-cA");
    const cap = projectHandoffCapacity(events);
    expect(cap.tailCycleId).toBeUndefined();
    expect(cap.blockedCycleIds).toContain("cA");
  });
});

describe("US-CYCLE-013 — crash prefixes (matrix #8)", () => {
  it("before ready → building (builder not assumed complete)", () => {
    const A = identityFor("cA", "US-A");
    const events: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A)];
    const view = viewOf(events, "cA");
    expect(view?.state).toBe("building");
    expect(projectHandoffCapacity(events).buildHolderCycleId).toBe("cA");
  });

  it("after ready, before promotion → ready holder retained (no rebuild, no capacity theft)", () => {
    const A = identityFor("cA", "US-A");
    const events: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A), ready(A)];
    const view = viewOf(events, "cA");
    expect(view?.state).toBe("builder_validated_waiting_for_tail");
    const cap = projectHandoffCapacity(events);
    expect(cap.readyHolderCycleId).toBe("cA");
    expect(cap.buildHolderCycleId).toBe("cA");
    expect(cap.tailCycleId).toBeUndefined();
  });

  it("after promotion, before the in-memory build-slot release → projection already released build + acquired tail", () => {
    const A = identityFor("cA", "US-A");
    const events: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A)];
    const cap = projectHandoffCapacity(events);
    expect(cap.tailCycleId).toBe("cA");
    expect(cap.buildHolderCycleId).toBeUndefined();
  });

  it("after admission, before Builder spawn → building with a fence but no worker receipt (recovery, no second Builder)", () => {
    const A = identityFor("cA", "US-A");
    const events: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A)];
    expect(viewOf(events, "cA")?.identity?.fence).toBe(A.fence);
    // Replaying the same admission is a no-op — a second Builder cannot start.
    expect(viewOf([...events, admitted(A)], "cA")?.state).toBe("building");
  });
});

describe("US-CYCLE-013 — scheduler races + capacity (matrix #9, #10)", () => {
  it("two admission facts for one slot: the loser is durably queued with its reason/sequence", () => {
    const A = identityFor("cA", "US-A");
    const B = identityFor("cB", "US-B");
    const events: RollEvent[] = [
      allocatedFor("cA", "US-A"), admitted(A),
      { type: "cycle:queued", eventId: "ev-q1", idempotencyKey: "queue:US-B:2", storyId: "US-B", requestedByCycleId: "cB", queueSequence: 2, reason: "build_slot_full", ts: 3 },
      { type: "cycle:queued", eventId: "ev-q2", idempotencyKey: "queue:US-C:3", storyId: "US-C", requestedByCycleId: "cC", queueSequence: 3, reason: "tail_slot_full", ts: 4 },
    ];
    const cap = projectHandoffCapacity(events);
    expect(cap.buildHolderCycleId).toBe("cA");
    // FIFO order by (queueSequence, storyId) — only the head may be admitted.
    expect(cap.queue.map((q) => q.storyId)).toEqual(["US-B", "US-C"]);
    expect(cap.queue[0]).toMatchObject({ queueSequence: 2, reason: "build_slot_full" });
    expect(cap.queue[1]).toMatchObject({ queueSequence: 3, reason: "tail_slot_full" });
  });

  it("capacity full: one tail + one building allowed; a third card is queued (not a second tail)", () => {
    const A = identityFor("cA", "US-A");
    const B = identityFor("cB", "US-B");
    const C = identityFor("cC", "US-C");
    const events: RollEvent[] = [
      allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A), tailStarted(A),
      allocatedFor("cB", "US-B"), admitted(B),
      { type: "cycle:queued", eventId: "ev-q3", idempotencyKey: "queue:US-C:3", storyId: "US-C", requestedByCycleId: "cC", queueSequence: 3, reason: "build_slot_full", ts: 5 },
    ];
    const cap = projectHandoffCapacity(events);
    expect(cap.tailCycleId).toBe("cA");
    expect(cap.buildHolderCycleId).toBe("cB");
    expect(cap.queue.map((q) => q.storyId)).toEqual(["US-C"]);
    // A queued entry whose cycle later gets admitted drops out of the queue.
    const admittedC: RollEvent[] = [...events, allocatedFor("cC", "US-C"), admitted(C)];
    const cap2 = projectHandoffCapacity(admittedC);
    expect(cap2.queue).toEqual([]);
    expect(cap2.buildHolderCycleId).toBe("cB");
  });
});

describe("US-CYCLE-013 — freshness (matrix #12, #13)", () => {
  const A = identityFor("cA", "US-A");
  const tailPrefix: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A)];

  it("continue pins a new owned attempt → serial_recovery (old head cannot publish)", () => {
    const events: RollEvent[] = [...tailPrefix, freshness(A, "continue"), rebasedPlanned(A)];
    const view = viewOf(events, "cA");
    expect(view?.state).toBe("serial_recovery");
    // The planned rebase supersedes the continue verdict (both fold to recovery).
    expect(view?.recoveryReason).toBe("rebased_attempt_planned");
    expect(projectHandoffCapacity(events).tailCycleId).toBeUndefined();
    // A fresh admitted (new attempt/fence) re-enters building after recovery.
    const rebasedAdmission = identityFor("cA", "US-A", 2, "fence-2", "r1", "m1");
    const reAdmitted: RollEvent[] = [...events, allocatedFor("cA", "US-A", "m1"), admitted(rebasedAdmission, 4)];
    const view2 = viewOf(reAdmitted, "cA");
    expect(view2?.state).toBe("building");
    expect(view2?.identity?.attempt).toBe(2);
  });

  it.each(["conflict", "test_failed", "unknown", "timeout"] as const)("verdict %s → serial_recovery with leases retained", (verdict) => {
    const events: RollEvent[] = [...tailPrefix, freshness(A, verdict)];
    const view = viewOf(events, "cA");
    expect(view?.state).toBe("serial_recovery");
    expect(view?.recoveryReason).toBe(`freshness_${verdict}`);
    expect(view?.identity?.workspace.members[0]?.workspaceKey).toBe("cycle-cA");
    expect(projectHandoffCapacity(events).blockedCycleIds).toContain("cA");
  });

  it("a stale probe (wrong fence) is inert", () => {
    const stale = { ...freshness(A, "conflict"), fence: "WRONG-FENCE" };
    const events: RollEvent[] = [...tailPrefix, stale];
    expect(viewOf(events, "cA")?.state).toBe("waiting_for_evaluation_or_test");
  });
});

describe("US-CYCLE-013 — evaluation repair + cleanup (matrix #14, #15)", () => {
  it("evaluation repair invalidates the old handoff; the old evidence cannot publish", () => {
    const A = identityFor("cA", "US-A");
    const events: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A), tailStarted(A), serialRecovery(A, "repair_required")];
    const view = viewOf(events, "cA");
    expect(view?.state).toBe("serial_recovery");
    expect(view?.recoveryReason).toBe("repair_required");
    // The old handoff authority is gone: a late tail_completed with the OLD
    // fence after recovery is a fence mismatch → serial_recovery, never publish.
    const lateComplete = { ...tailCompleted(A), ts: 99 };
    expect(viewOf([...events, lateComplete], "cA")?.state).toBe("serial_recovery");
  });

  it("cleanup failure retains the workspace; a successful same-identity retry releases it", () => {
    const A = identityFor("cA", "US-A");
    const failed: RollEvent[] = [
      allocatedFor("cA", "US-A"), admitted(A), ready(A), handoff(A), tailStarted(A), tailCompleted(A),
      serialRecovery(A, "cleanup_failed"),
    ];
    const view = viewOf(failed, "cA");
    expect(view?.state).toBe("serial_recovery");
    expect(view?.recoveryReason).toBe("cleanup_failed");
    expect(view?.identity?.workspace.members[0]?.workspaceKey).toBe("cycle-cA");
    const cap = projectHandoffCapacity(failed);
    expect(cap.blockedCycleIds).toContain("cA");
    // Successful retry with the SAME identity/fence: cleanup_completed terminal.
    const retried: RollEvent[] = [...failed, { ...cleanupCompleted(A), ts: 99 }];
    expect(viewOf(retried, "cA")?.state).toBe("terminal");
  });
});

describe("US-CYCLE-013 — historic stream / flag-off surface (matrix #16)", () => {
  it("a stream with NO v1 events projects an empty capacity graph", () => {
    const legacy: RollEvent[] = [
      { type: "cycle:start", cycleId: "c-old", storyId: "US-OLD", agent: "a", model: "m", ts: 1 },
      { type: "cycle:phase", cycleId: "c-old", phase: "publish", ts: 2 },
      { type: "cycle:end", cycleId: "c-old", outcome: "delivered", cost: { cycleId: "c-old", agent: "a", model: "m", tokensIn: 0, tokensOut: 0, estimatedCost: 0, revertCount: 0, effectiveCost: 0, currency: "USD" }, ts: 3 },
    ];
    expect(projectHandoffCapacity(legacy).queue).toEqual([]);
    expect(projectHandoffCapacity(legacy).tailCycleId).toBeUndefined();
    expect(projectCycleHandoff(legacy, "c-old")).toBeUndefined();
  });

  it("invalid family payloads (e.g. a v0-shaped ready) fold to serial_recovery — fail closed", () => {
    const A = identityFor("cA", "US-A");
    const v0 = { ...ready(A), identity: { ...A, schema: "cycle-handoff/v0" } };
    const events: RollEvent[] = [allocatedFor("cA", "US-A"), admitted(A), v0];
    const view = viewOf(events, "cA");
    expect(view?.state).toBe("serial_recovery");
    expect(view?.recoveryReason).toContain("invalid_payload");
  });

  it("a worktree:recovery_required record marks the cycle blocked (never auto-cleaned)", () => {
    const A = identityFor("cA", "US-A");
    const events: RollEvent[] = [
      allocatedFor("cA", "US-A"), admitted(A),
      { type: "worktree:recovery_required", runId: "cA", relativeLocator: "cycle-cA", reason: "allocation_started", ts: 2 },
    ];
    expect(projectHandoffCapacity(events).blockedCycleIds).toContain("cA");
  });
});

describe("US-CYCLE-013 — capacity helper invariants (exhaustive typing)", () => {
  it("exposes the HandoffCapacity shape used by the scheduler", () => {
    const cap: HandoffCapacity = { queue: [], blockedCycleIds: [] };
    expect(cap).toEqual({ queue: [], blockedCycleIds: [] });
  });
});

describe("US-CYCLE-013 — failed admitted build releases the slot (matrix #8 extension)", () => {
  it("a cycle:end (failed) after admission abandons the cycle — it is NOT a build holder", () => {
    const A = identityFor("cA", "US-A");
    const events: RollEvent[] = [
      allocatedFor("cA", "US-A"), admitted(A),
      { type: "cycle:end", cycleId: "cA", outcome: "failed", cost: { cycleId: "cA", agent: "a", model: "m", tokensIn: 0, tokensOut: 0, estimatedCost: 0, revertCount: 0, effectiveCost: 0, currency: "USD" }, ts: 9 },
    ];
    const view = viewOf(events, "cA");
    expect(view?.state).toBe("terminal");
    expect(view?.terminal).toBe("abandoned");
    const cap = projectHandoffCapacity(events);
    expect(cap.buildHolderCycleId).toBeUndefined();
    expect(cap.tailCycleId).toBeUndefined();
    // The slot is free: a new card can be admitted.
    expect(cap.queue).toEqual([]);
  });

  it("a cycle:end AFTER a durable ready is a serial-duplicate conflict → serial_recovery", () => {
    const A = identityFor("cA", "US-A");
    const events: RollEvent[] = [
      allocatedFor("cA", "US-A"), admitted(A), ready(A),
      { type: "cycle:end", cycleId: "cA", outcome: "published_pending_merge", cost: { cycleId: "cA", agent: "a", model: "m", tokensIn: 0, tokensOut: 0, estimatedCost: 0, revertCount: 0, effectiveCost: 0, currency: "USD" }, ts: 9 },
    ];
    expect(viewOf(events, "cA")?.state).toBe("serial_recovery");
    expect(projectHandoffCapacity(events).blockedCycleIds).toContain("cA");
  });
});

describe("US-CYCLE-013 — queued-only cards never claim the build slot (review fix)", () => {
  it("a card with only cycle:queued (no admitted) is NOT a build holder — the FIFO head stays admissible", () => {
    const events: RollEvent[] = [
      { type: "cycle:queued", eventId: "ev-q", idempotencyKey: "queue:US-Q:1", storyId: "US-Q", requestedByCycleId: "cq", queueSequence: 1, reason: "build_slot_full", ts: 1 },
    ];
    const view = viewOf(events, "cq");
    expect(view?.state).toBe("building"); // fold placeholder — no identity yet
    expect(view?.identity).toBeUndefined();
    const cap = projectHandoffCapacity(events);
    // The queued card stays in the QUEUE; it never occupies the build slot.
    expect(cap.buildHolderCycleId).toBeUndefined();
    expect(cap.readyHolderCycleId).toBeUndefined();
    expect(cap.tailCycleId).toBeUndefined();
    expect(cap.queue.map((q) => q.storyId)).toEqual(["US-Q"]);
  });
});
