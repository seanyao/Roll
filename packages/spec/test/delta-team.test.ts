/**
 * US-DELTA-001 — Delta Team type guards and event parsing tests.
 */
import { describe, expect, it } from "vitest";
import {
  isValidDeliveryShape,
  DELEGATION_TRIGGERS,
  DELIVERY_TOPOLOGIES,
  QUALITY_PROFILES,
  DELTA_ROLES,
  DELTA_BLOCK_REASONS,
  VISIBLE_DELIVERY_MODES,
  type DeliveryShape,
  type DeltaBlockReason,
  RETIRED_DELEGATION_TRIGGERS,
  RETIRED_VISIBLE_DELIVERY_MODES,
  RETIRED_DELTA_BLOCK_REASONS,
  isKnownHistoricalTrigger,
  isKnownHistoricalVisibleMode,
  isKnownHistoricalBlockReason,
} from "../src/index.js";
import { parseEventLine } from "../src/types/events.js";

describe("US-DELTA-001 AC1 — DelegationTrigger, DeliveryTopology, and QualityProfile are distinct typed values", () => {
  it("the trigger axis is a single live value (US-LOOP-110)", () => {
    expect(DELEGATION_TRIGGERS).toEqual(["host-guided"]);
  });

  it("recognises the retired trigger on the READ side without admitting it", () => {
    expect(RETIRED_DELEGATION_TRIGGERS).toEqual(["loop-autonomous"]);
    // Historical artifacts stay readable…
    expect(isKnownHistoricalTrigger("loop-autonomous")).toBe(true);
    expect(isKnownHistoricalTrigger("host-guided")).toBe(true);
    // …but the retired literal is NOT a live value.
    expect((DELEGATION_TRIGGERS as readonly string[]).includes("loop-autonomous")).toBe(false);
    expect(isKnownHistoricalTrigger("made-up")).toBe(false);
    expect(isKnownHistoricalTrigger(42)).toBe(false);
  });

  it("all topology literals are valid", () => {
    expect(DELIVERY_TOPOLOGIES).toEqual(["solo", "delta-team", "full-delta-team"]);
  });

  it("all quality profile literals are valid", () => {
    expect(QUALITY_PROFILES).toEqual(["standard", "verified", "designed"]);
  });

  it("all visible delivery modes are defined", () => {
    expect(VISIBLE_DELIVERY_MODES).toEqual([
      "full-delta-team",
      "delta-team",
      "solo-skill",
    ]);
  });

  it("recognises the retired visible mode on the READ side only (US-LOOP-110)", () => {
    expect(RETIRED_VISIBLE_DELIVERY_MODES).toEqual(["autonomous-loop"]);
    expect(isKnownHistoricalVisibleMode("autonomous-loop")).toBe(true);
    expect(isKnownHistoricalVisibleMode("solo-skill")).toBe(true);
    expect((VISIBLE_DELIVERY_MODES as readonly string[]).includes("autonomous-loop")).toBe(false);
  });

  it("all delta roles are defined", () => {
    expect(DELTA_ROLES).toEqual(["designer", "builder", "evaluator", "peer"]);
  });

  it("all block reasons are defined", () => {
    expect(DELTA_BLOCK_REASONS).toContain("identity_collision");
    expect(DELTA_BLOCK_REASONS).toContain("host_attestation_invalid");
  });

  it("host_supervisor_required is unreachable but still parseable (US-LOOP-110)", () => {
    // The premise it guarded (a loop has no host session) was wrong; the trigger
    // it blocked is gone, so the reason can no longer be emitted.
    expect((DELTA_BLOCK_REASONS as readonly string[]).includes("host_supervisor_required")).toBe(false);
    expect(RETIRED_DELTA_BLOCK_REASONS).toEqual(["host_supervisor_required"]);
    expect(isKnownHistoricalBlockReason("host_supervisor_required")).toBe(true);
    expect(isKnownHistoricalBlockReason("identity_collision")).toBe(true);
    expect(isKnownHistoricalBlockReason("invented_reason")).toBe(false);
  });
});

describe("US-DELTA-001 AC3 — DeliveryShape type guards validate orthogonal composition", () => {
  it("accepts a valid host-guided delta-team shape", () => {
    const shape: DeliveryShape = {
      trigger: "host-guided",
      topology: "delta-team",
      qualityProfile: "verified",
    };
    expect(isValidDeliveryShape(shape)).toBe(true);
  });

  it("REJECTS the retired loop-autonomous shape as a live shape (US-LOOP-110)", () => {
    // The shape guard admits LIVE shapes only. A historical manifest carrying the
    // retired trigger is still recognisable via isKnownHistoricalTrigger — but it
    // must never pass as a shape a new delegation may be prepared with.
    expect(
      isValidDeliveryShape({
        trigger: "loop-autonomous",
        topology: "solo",
        qualityProfile: "standard",
      }),
    ).toBe(false);
    expect(isKnownHistoricalTrigger("loop-autonomous")).toBe(true);
  });

  it("accepts host-guided full-delta-team shape", () => {
    expect(
      isValidDeliveryShape({
        trigger: "host-guided",
        topology: "full-delta-team",
        qualityProfile: "designed",
      }),
    ).toBe(true);
  });

  it("rejects null/undefined", () => {
    expect(isValidDeliveryShape(null)).toBe(false);
    expect(isValidDeliveryShape(undefined)).toBe(false);
  });

  it("rejects invalid trigger", () => {
    expect(isValidDeliveryShape({ trigger: "invalid", topology: "solo", qualityProfile: "standard" })).toBe(false);
  });

  it("rejects invalid topology", () => {
    expect(isValidDeliveryShape({ trigger: "host-guided", topology: "bad", qualityProfile: "standard" })).toBe(false);
  });

  it("rejects invalid quality profile", () => {
    expect(isValidDeliveryShape({ trigger: "host-guided", topology: "solo", qualityProfile: "gold" })).toBe(false);
  });

  it("rejects object with missing keys", () => {
    expect(isValidDeliveryShape({ trigger: "host-guided" })).toBe(false);
    expect(isValidDeliveryShape({})).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isValidDeliveryShape("string")).toBe(false);
    expect(isValidDeliveryShape(42)).toBe(false);
    expect(isValidDeliveryShape([])).toBe(false);
  });
});

describe("US-DELTA-001 — Delta events parse correctly", () => {
  it("parses delta:prepared event", () => {
    const e = parseEventLine(JSON.stringify({
      type: "delta:prepared",
      delegationId: "d1",
      runId: "delta-d1",
      storyId: "US-1",
      trigger: "host-guided",
      topology: "delta-team",
      qualityProfile: "verified",
      presetId: "pi-balanced-v1",
      presetSha256: "abc123",
      hostId: "pi",
      ts: 1,
    }));
    expect(e).not.toBeNull();
    expect(e?.type).toBe("delta:prepared");
  });

  it("parses delta:role_resolved event", () => {
    const e = parseEventLine(JSON.stringify({
      type: "delta:role_resolved",
      delegationId: "d1",
      storyId: "US-1",
      role: "designer",
      roleInstanceId: "ri-1",
      hostId: "pi",
      modelId: "model-test-1",
      source: "preset-preference",
      reasons: ["preferred", "reasoning"],
      inventorySha256: "def456",
      ts: 2,
    }));
    expect(e).not.toBeNull();
    expect(e?.type).toBe("delta:role_resolved");
    // Audit: modelId must be a stable opaque ID, not a real model alias
    expect((e as Record<string, unknown>)?.modelId).toBe("model-test-1");
  });

  it("parses delta:role_started event", () => {
    const e = parseEventLine(JSON.stringify({
      type: "delta:role_started",
      delegationId: "d1",
      storyId: "US-1",
      role: "builder",
      sessionId: "s1",
      roleInstanceId: "ri-2",
      hostId: "pi",
      modelId: "model-test-2",
      identityProvenance: "host-attested",
      worktreeAccess: "builder-write",
      ts: 3,
    }));
    expect(e).not.toBeNull();
    expect(e?.type).toBe("delta:role_started");
    // Audit: modelId must be a stable opaque ID, not a real model alias
    expect((e as Record<string, unknown>)?.modelId).toBe("model-test-2");
  });

  it("parses delta:artifact_published event", () => {
    const e = parseEventLine(JSON.stringify({
      type: "delta:artifact_published",
      delegationId: "d1",
      storyId: "US-1",
      role: "designer",
      path: "design-contract.md",
      sha256: "ghi789",
      manifestPath: "artifact-manifest.json",
      sessionId: "s1",
      roleInstanceId: "ri-1",
      identityProvenance: "host-attested",
      ts: 4,
    }));
    expect(e).not.toBeNull();
    expect(e?.type).toBe("delta:artifact_published");
  });

  it("parses delta:terminal(handoff_ready) event", () => {
    const e = parseEventLine(JSON.stringify({
      type: "delta:terminal",
      delegationId: "d1",
      storyId: "US-1",
      outcome: "handoff_ready",
      terminalBinding: "handoff_only",
      deliveryDisposition: "owner_continue",
      ts: 5,
    }));
    expect(e).not.toBeNull();
    expect(e?.type).toBe("delta:terminal");
  });

  it("parses delta:blocked event", () => {
    const e = parseEventLine(JSON.stringify({
      type: "delta:blocked",
      delegationId: "d1",
      storyId: "US-1",
      role: "builder",
      reason: "host_supervisor_required",
      detail: "loop-autonomous + delta-team requires a host Supervisor",
      ts: 6,
    }));
    expect(e).not.toBeNull();
    expect(e?.type).toBe("delta:blocked");
  });
});
