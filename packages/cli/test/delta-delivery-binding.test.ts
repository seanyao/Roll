import { describe, expect, it } from "vitest";
import { hostDeltaDeliveryBinding } from "../src/lib/delta-delivery-binding.js";

describe("hostDeltaDeliveryBinding", () => {
  it("binds a real delivery writer only to its own terminal host run", () => {
    const events: Record<string, unknown>[] = [
      { type: "delivery:reconciled", storyId: "US-LOOP-126", cycleId: "old", state: "delivered", ts: 1 },
      { type: "delta:terminal", storyId: "US-LOOP-126", delegationId: "deleg-current", runId: "delta-current", reservationSource: "delivery-reservation", ts: 2 },
    ];
    expect(hostDeltaDeliveryBinding(events, "US-LOOP-126", "delta-current"))
      .toEqual({ delegationId: "deleg-current", runId: "delta-current" });
    // A historical Story event and another delivery run cannot inherit the
    // current reservation's authority.
    expect(hostDeltaDeliveryBinding(events, "US-LOOP-126", "old")).toBeUndefined();
    expect(hostDeltaDeliveryBinding(events, "US-LOOP-126", "delta-other")).toBeUndefined();
  });
});
