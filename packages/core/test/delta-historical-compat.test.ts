/**
 * US-LOOP-110 — read-side compatibility for the retired `loop-autonomous` axis.
 *
 * The trigger binary, its block reason, and its visible mode are gone from the
 * LIVE model. Roll's ledgers are append-only, so every artifact and event written
 * under the old premise must stay fully readable. These tests are the contract:
 * if any of them fails, historical delta records have become unreadable.
 */
import { describe, expect, it } from "vitest";
import {
  isKnownHistoricalBlockReason,
  isKnownHistoricalTrigger,
  isKnownHistoricalVisibleMode,
  parseEventLine,
  DELEGATION_TRIGGERS,
  DELTA_BLOCK_REASONS,
  VISIBLE_DELIVERY_MODES,
} from "@roll/spec";
import { projectDelegationStatus } from "../src/delta-team/projection.js";

describe("historical delta events remain parseable", () => {
  it("parses a delta:prepared written with the retired trigger", () => {
    const e = parseEventLine(
      JSON.stringify({
        type: "delta:prepared",
        delegationId: "d-hist-1",
        runId: "r1",
        storyId: "US-OLD-1",
        trigger: "loop-autonomous",
        topology: "solo",
        qualityProfile: "standard",
        presetId: "p1",
        presetSha256: "a".repeat(64),
        hostId: "adapter",
        ts: 1,
      }),
    );
    expect(e).not.toBeNull();
    expect(e?.type).toBe("delta:prepared");
  });

  it("parses a delta:blocked written with the retired reason", () => {
    const e = parseEventLine(
      JSON.stringify({
        type: "delta:blocked",
        delegationId: "d-hist-2",
        storyId: "US-OLD-2",
        role: "builder",
        reason: "host_supervisor_required",
        detail: "historical block under the retired premise",
        ts: 2,
      }),
    );
    expect(e).not.toBeNull();
    expect(e?.type).toBe("delta:blocked");
  });

  it("folds a historical event stream into a status view without throwing", () => {
    const events = [
      {
        type: "delta:prepared",
        delegationId: "d-hist-3",
        runId: "r3",
        storyId: "US-OLD-3",
        trigger: "loop-autonomous",
        topology: "solo",
        qualityProfile: "standard",
        presetId: "p",
        presetSha256: "b".repeat(64),
        hostId: "adapter",
        ts: 10,
      },
      {
        type: "delta:blocked",
        delegationId: "d-hist-3",
        storyId: "US-OLD-3",
        role: "builder",
        reason: "host_supervisor_required",
        detail: "historical",
        ts: 11,
      },
    ] as unknown as Parameters<typeof projectDelegationStatus>[1];
    const view = projectDelegationStatus("d-hist-3", events);
    expect(view).not.toBeNull();
    // The retired trigger is READ back verbatim — never rewritten or dropped.
    expect(view.trigger).toBe("loop-autonomous");
    expect(view.storyId).toBe("US-OLD-3");
  });
});

describe("retired literals are recognisable but not live", () => {
  it("trigger", () => {
    expect(isKnownHistoricalTrigger("loop-autonomous")).toBe(true);
    expect((DELEGATION_TRIGGERS as readonly string[]).includes("loop-autonomous")).toBe(false);
  });

  it("block reason", () => {
    expect(isKnownHistoricalBlockReason("host_supervisor_required")).toBe(true);
    expect((DELTA_BLOCK_REASONS as readonly string[]).includes("host_supervisor_required")).toBe(false);
  });

  it("visible mode", () => {
    expect(isKnownHistoricalVisibleMode("autonomous-loop")).toBe(true);
    expect((VISIBLE_DELIVERY_MODES as readonly string[]).includes("autonomous-loop")).toBe(false);
  });

  it("an invented literal is neither live nor historical", () => {
    expect(isKnownHistoricalTrigger("cron-driven")).toBe(false);
    expect(isKnownHistoricalBlockReason("no_supervisor_found")).toBe(false);
    expect(isKnownHistoricalVisibleMode("timer-loop")).toBe(false);
  });
});

describe("the admission gate is gone", () => {
  it("no module exports an admit()/admitShape() judgement (US-LOOP-110)", async () => {
    const core = (await import("../src/index.js")) as Record<string, unknown>;
    expect(core["admit"]).toBeUndefined();
    expect(core["admitShape"]).toBeUndefined();
  });
});
