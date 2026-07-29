/**
 * US-DELTA-001 — Visible-mode projection and delegation status view tests.
 */
import { describe, expect, it } from "vitest";
import {
  visibleMode,
  visibleModeFromShape,
  renderCost,
  HOST_UNOBSERVABLE_COST,
  projectDelegationStatus,
  buildStatusFixture,
} from "../src/delta-team/projection.js";
import type { RollEvent, DeliveryShape } from "@roll/spec";

describe("US-DELTA-001 AC2 — VisibleDeliveryMode projection", () => {
  it("the live trigger no longer discriminates — topology alone decides (US-LOOP-110)", () => {
    expect(visibleMode("host-guided", "solo")).toBe("solo-skill");
    expect(visibleMode("host-guided", "delta-team")).toBe("delta-team");
    expect(visibleMode("host-guided", "full-delta-team")).toBe("full-delta-team");
  });

  it("a HISTORICAL loop-autonomous record keeps its historical mode (codex r1)", () => {
    // Re-rendering it as solo-skill would silently rewrite what that delivery
    // actually was. Read-side compatibility means reading history, not restating it.
    const retired = "loop-autonomous" as unknown as "host-guided";
    expect(visibleMode(retired, "solo")).toBe("autonomous-loop");
    expect(visibleMode(retired, "full-delta-team")).toBe("autonomous-loop");
  });

  it("host-guided + solo → solo-skill", () => {
    expect(visibleMode("host-guided", "solo")).toBe("solo-skill");
  });

  it("host-guided + delta-team → delta-team", () => {
    expect(visibleMode("host-guided", "delta-team")).toBe("delta-team");
  });

  it("host-guided + full-delta-team → full-delta-team", () => {
    expect(visibleMode("host-guided", "full-delta-team")).toBe("full-delta-team");
  });

  it("visibleModeFromShape derives from DeliveryShape", () => {
    const shape: DeliveryShape = {
      trigger: "host-guided",
      topology: "delta-team",
      qualityProfile: "verified",
    };
    expect(visibleModeFromShape(shape)).toBe("delta-team");
  });

  it("three projection rules cover every live combo (US-LOOP-110)", () => {
    const results = new Set<string>();
    for (const trigger of ["host-guided"] as const) {
      for (const topology of ["solo", "delta-team", "full-delta-team"] as const) {
        results.add(visibleMode(trigger, topology));
      }
    }
    expect(results.size).toBe(3);
    expect([...results].sort()).toEqual([
      "delta-team",
      "full-delta-team",
      "solo-skill",
    ]);
    expect(results.has("autonomous-loop")).toBe(false);
  });
});

describe("US-DELTA-001 AC8 — Cost rendering", () => {
  it("host-attested cost is always ? (host_unobservable)", () => {
    expect(renderCost("host-attested")).toBe(HOST_UNOBSERVABLE_COST);
  });

  it("null provenance (unresolved role) renders host-unobservable", () => {
    expect(renderCost(null)).toBe(HOST_UNOBSERVABLE_COST);
  });

  it("adapter-observed cost renders usage_authority_unavailable in v1", () => {
    expect(renderCost("adapter-observed")).toBe("? (usage_authority_unavailable)");
  });

  it("HOST_UNOBSERVABLE_COST constant is exact string", () => {
    expect(HOST_UNOBSERVABLE_COST).toBe("? (host_unobservable)");
  });
});

describe("US-DELTA-001 AC9 — Deterministic status projection", () => {
  it("unknown delegation returns unknown status", () => {
    const view = projectDelegationStatus("d-none", []);
    expect(view.delegationId).toBe("d-none");
    expect(view.status).toBe("unknown");
    expect(view.visibleMode).toBeNull();
    expect(view.trigger).toBeNull();
    expect(view.roles).toEqual([]);
    expect(view.totalCost).toBe(HOST_UNOBSERVABLE_COST);
  });

  it("delta:prepared transitions to prepared status", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d1",
        runId: "delta-d1",
        storyId: "US-TEST-1",
        trigger: "host-guided",
        topology: "delta-team",
        qualityProfile: "verified",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "pi",
        ts: 1,
      },
    ];
    const view = projectDelegationStatus("d1", events);
    expect(view.status).toBe("prepared");
    expect(view.storyId).toBe("US-TEST-1");
    expect(view.visibleMode).toBe("delta-team");
    expect(view.trigger).toBe("host-guided");
    expect(view.topology).toBe("delta-team");
  });

  it("role_resolved transitions to in_progress", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d1",
        runId: "delta-d1",
        storyId: "US-TEST-1",
        trigger: "host-guided",
        topology: "solo",
        qualityProfile: "standard",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "pi",
        ts: 1,
      },
      {
        type: "delta:role_resolved",
        delegationId: "d1",
        storyId: "US-TEST-1",
        role: "builder",
        roleInstanceId: "ri-b1",
        hostId: "pi",
        modelId: "model-host-1",
        source: "preset-preference",
        reasons: ["coding"],
        inventorySha256: "def",
        ts: 2,
      },
    ];
    const view = projectDelegationStatus("d1", events);
    expect(view.status).toBe("in_progress");
    expect(view.roles).toHaveLength(1);
    expect(view.roles[0]).toMatchObject({
      role: "builder",
      status: "resolved",
      hostId: "pi",
      modelId: "model-host-1",
      cost: HOST_UNOBSERVABLE_COST,
    });
  });

  it("role_started updates role status and records provenance", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d1",
        runId: "delta-d1",
        storyId: "US-TEST-1",
        trigger: "host-guided",
        topology: "delta-team",
        qualityProfile: "verified",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "pi",
        ts: 1,
      },
      {
        type: "delta:role_resolved",
        delegationId: "d1",
        storyId: "US-TEST-1",
        role: "designer",
        roleInstanceId: "ri-d1",
        hostId: "pi",
        modelId: "model-host-2",
        source: "preset-preference",
        reasons: ["reasoning"],
        inventorySha256: "def",
        ts: 2,
      },
      {
        type: "delta:role_started",
        delegationId: "d1",
        storyId: "US-TEST-1",
        role: "designer",
        sessionId: "s1",
        roleInstanceId: "ri-d1",
        hostId: "pi",
        modelId: "model-host-2",
        identityProvenance: "host-attested",
        worktreeAccess: "read-only",
        ts: 3,
      },
    ];
    const view = projectDelegationStatus("d1", events);
    expect(view.status).toBe("in_progress");
    expect(view.roles[0]).toMatchObject({
      role: "designer",
      status: "started",
      identityProvenance: "host-attested",
      cost: HOST_UNOBSERVABLE_COST,
    });
  });

  it("artifact_published advances role to artifact_published", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d1",
        runId: "delta-d1",
        storyId: "US-TEST-1",
        trigger: "host-guided",
        topology: "solo",
        qualityProfile: "standard",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "pi",
        ts: 1,
      },
      {
        type: "delta:role_resolved",
        delegationId: "d1",
        storyId: "US-TEST-1",
        role: "builder",
        roleInstanceId: "ri-b1",
        hostId: "pi",
        modelId: "model-host-3",
        source: "preset-preference",
        reasons: ["coding"],
        inventorySha256: "def",
        ts: 2,
      },
      {
        type: "delta:artifact_published",
        delegationId: "d1",
        storyId: "US-TEST-1",
        role: "builder",
        path: "execute-evidence.md",
        sha256: "ghi",
        manifestPath: "artifact-manifest.json",
        sessionId: "s1",
        roleInstanceId: "ri-b1",
        identityProvenance: "host-attested",
        ts: 3,
      },
    ];
    const view = projectDelegationStatus("d1", events);
    expect(view.roles[0]).toMatchObject({
      role: "builder",
      status: "artifact_published",
      identityProvenance: "host-attested",
      cost: HOST_UNOBSERVABLE_COST,
    });
  });

  it("delta:terminal(handoff_ready) sets handoff_ready status", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d1",
        runId: "delta-d1",
        storyId: "US-TEST-1",
        trigger: "host-guided",
        topology: "solo",
        qualityProfile: "standard",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "pi",
        ts: 1,
      },
      {
        type: "delta:terminal",
        delegationId: "d1",
        storyId: "US-TEST-1",
        outcome: "handoff_ready",
        terminalBinding: "handoff_only",
        deliveryDisposition: "owner_continue",
        ts: 2,
      },
    ];
    const view = projectDelegationStatus("d1", events);
    expect(view.status).toBe("handoff_ready");
    expect(view.terminalBinding).toBe("handoff_only");
    expect(view.deliveryDisposition).toBe("owner_continue");
  });

  it("delta:terminal(abandoned) sets abandoned status", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d1",
        runId: "delta-d1",
        storyId: "US-TEST-1",
        trigger: "host-guided",
        topology: "solo",
        qualityProfile: "standard",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "pi",
        ts: 1,
      },
      {
        type: "delta:terminal",
        delegationId: "d1",
        storyId: "US-TEST-1",
        outcome: "abandoned",
        terminalBinding: "handoff_only",
        ts: 2,
      },
    ];
    const view = projectDelegationStatus("d1", events);
    expect(view.status).toBe("abandoned");
  });

  it("delta:blocked sets blocked status with reason and detail", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d1",
        runId: "delta-d1",
        storyId: "US-TEST-1",
        trigger: "host-guided",
        topology: "delta-team",
        qualityProfile: "verified",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "pi",
        ts: 1,
      },
      {
        type: "delta:blocked",
        delegationId: "d1",
        storyId: "US-TEST-1",
        role: "builder",
        reason: "host_attestation_invalid",
        detail: "host attestation missing for builder role",
        ts: 2,
      },
    ];
    const view = projectDelegationStatus("d1", events);
    expect(view.status).toBe("blocked");
    expect(view.blockReason).toBe("host_attestation_invalid");
    expect(view.blockDetail).toContain("host attestation");
  });

  it("ignores events for other delegations", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d1",
        runId: "delta-d1",
        storyId: "US-TEST-1",
        trigger: "host-guided",
        topology: "solo",
        qualityProfile: "standard",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "pi",
        ts: 1,
      },
      {
        type: "delta:prepared",
        delegationId: "d2",
        runId: "delta-d2",
        storyId: "US-TEST-2",
        trigger: "loop-autonomous", // historical value — read-side compat (US-LOOP-110)
        topology: "full-delta-team",
        qualityProfile: "designed",
        presetId: "p2",
        presetSha256: "xyz",
        hostId: "adapter",
        ts: 2,
      },
    ];
    // Only d1 events should be folded
    const view = projectDelegationStatus("d1", events);
    expect(view.storyId).toBe("US-TEST-1");
    expect(view.trigger).toBe("host-guided");
  });

  it("total cost is always host-unobservable", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d1",
        runId: "delta-d1",
        storyId: "US-TEST-1",
        trigger: "host-guided",
        topology: "full-delta-team",
        qualityProfile: "designed",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "pi",
        ts: 1,
      },
    ];
    const view = projectDelegationStatus("d1", events);
    expect(view.totalCost).toBe(HOST_UNOBSERVABLE_COST);
  });
});

describe("US-DELTA-001 AC9 — Status fixtures cover all modes", () => {
  it("unknown fixture", () => {
    const f = buildStatusFixture("unknown");
    expect(f.status).toBe("unknown");
    expect(f.visibleMode).toBeNull();
    expect(f.trigger).toBeNull();
  });

  it("no fixture can produce the retired autonomous-loop mode (US-LOOP-110)", () => {
    // Fixtures model NEW deliveries only; history is exercised in
    // delta-historical-compat.test.ts.
    // The `autonomous-loop` scenario is gone from the fixture builder entirely —
    // asking for it is a type error, and no surviving scenario yields that mode.
    const scenarios = ["full-delta-team", "delta-team", "solo-skill", "unknown", "blocked"] as const;
    for (const s of scenarios) {
      const f = buildStatusFixture(s);
      expect(f.visibleMode, s).not.toBe("autonomous-loop");
      expect(f.trigger, s).not.toBe("loop-autonomous");
    }
  });

  it("full-delta-team fixture", () => {
    const f = buildStatusFixture("full-delta-team");
    expect(f.status).toBe("handoff_ready");
    expect(f.visibleMode).toBe("full-delta-team");
    expect(f.terminalBinding).toBe("handoff_only");
    expect(f.deliveryDisposition).toBe("owner_continue");
    expect(f.roles).toHaveLength(3);
    expect(f.totalCost).toBe(HOST_UNOBSERVABLE_COST);
  });

  it("delta-team fixture", () => {
    const f = buildStatusFixture("delta-team");
    expect(f.status).toBe("in_progress");
    expect(f.visibleMode).toBe("delta-team");
    expect(f.trigger).toBe("host-guided");
    expect(f.topology).toBe("delta-team");
    expect(f.roles).toHaveLength(3);
    expect(f.totalCost).toBe(HOST_UNOBSERVABLE_COST);
  });

  it("solo-skill fixture", () => {
    const f = buildStatusFixture("solo-skill");
    expect(f.status).toBe("handoff_ready");
    expect(f.visibleMode).toBe("solo-skill");
    expect(f.terminalBinding).toBe("handoff_only");
    expect(f.roles).toHaveLength(1);
  });

  it("blocked fixture", () => {
    const f = buildStatusFixture("blocked");
    expect(f.status).toBe("blocked");
    expect(f.blockReason).toBe("host_attestation_invalid");
    expect(f.blockDetail).toContain("host attestation");
  });

  it("all six fixtures produce distinct statuses", () => {
    const scenarios = ["full-delta-team", "delta-team", "solo-skill", "unknown", "blocked"] as const;
    const fixtures = scenarios.map((s) => buildStatusFixture(s));
    const statuses = fixtures.map((f) => f.status);
    // Each fixture should have a distinct status or mode combination
    const distinctKeys = fixtures.map((f) => `${f.status}:${f.visibleMode}`);
    expect(new Set(distinctKeys).size).toBe(fixtures.length);
  });

  it("all fixtures use opaque model IDs, no real provider/model names", () => {
    const scenarios = ["full-delta-team", "delta-team", "solo-skill", "blocked"] as const;
    const realModelPatterns = /^(claude|sonnet|opus|gpt-4|gpt-3\.5|gemini|llama|mistral|openai|anthropic|google|meta|deepseek|command|nova|titan|inflection)/i;
    for (const scenario of scenarios) {
      const f = buildStatusFixture(scenario);
      for (const role of f.roles) {
        expect(role.modelId).not.toMatch(realModelPatterns);
      }
    }
  });

  it("direct event fixture projections use opaque model IDs", () => {
    const realModelPatterns = /^(claude|sonnet|opus|gpt-4|gpt-3\.5|gemini|llama|mistral|openai|anthropic|google|meta|deepseek|command|nova|titan|inflection)/i;
    const paths: RollEvent[][] = [
      [
        { type: "delta:prepared", delegationId: "d-a1", runId: "delta-a1", storyId: "US-TEST-1", trigger: "host-guided", topology: "solo", qualityProfile: "standard", presetId: "p1", presetSha256: "abc", hostId: "pi", ts: 1 },
        { type: "delta:role_resolved", delegationId: "d-a1", storyId: "US-TEST-1", role: "builder", roleInstanceId: "ri-b1", hostId: "pi", modelId: "model-host-1", source: "preset-preference", reasons: ["coding"], inventorySha256: "def", ts: 2 },
      ],
      [
        { type: "delta:prepared", delegationId: "d-a2", runId: "delta-a2", storyId: "US-TEST-2", trigger: "host-guided", topology: "delta-team", qualityProfile: "verified", presetId: "p1", presetSha256: "abc", hostId: "pi", ts: 1 },
        { type: "delta:role_resolved", delegationId: "d-a2", storyId: "US-TEST-2", role: "designer", roleInstanceId: "ri-d1", hostId: "pi", modelId: "model-host-2", source: "preset-preference", reasons: ["reasoning"], inventorySha256: "def", ts: 2 },
        { type: "delta:role_started", delegationId: "d-a2", storyId: "US-TEST-2", role: "designer", sessionId: "s1", roleInstanceId: "ri-d1", hostId: "pi", modelId: "model-host-2", identityProvenance: "host-attested", worktreeAccess: "read-only", ts: 3 },
      ],
      [
        { type: "delta:prepared", delegationId: "d-a3", runId: "delta-a3", storyId: "US-TEST-3", trigger: "host-guided", topology: "solo", qualityProfile: "standard", presetId: "p1", presetSha256: "abc", hostId: "pi", ts: 1 },
        { type: "delta:role_resolved", delegationId: "d-a3", storyId: "US-TEST-3", role: "builder", roleInstanceId: "ri-b1", hostId: "pi", modelId: "model-host-3", source: "preset-preference", reasons: ["coding"], inventorySha256: "def", ts: 2 },
        { type: "delta:artifact_published", delegationId: "d-a3", storyId: "US-TEST-3", role: "builder", path: "execute-evidence.md", sha256: "ghi", manifestPath: "artifact-manifest.json", sessionId: "s1", roleInstanceId: "ri-b1", identityProvenance: "host-attested", ts: 3 },
      ],
    ];
    for (const events of paths) {
      const view = projectDelegationStatus(events[0].delegationId, events);
      for (const role of view.roles) {
        expect(role.modelId).not.toMatch(realModelPatterns);
      }
    }
  });
});

// ── Idempotent replay ─────────────────────────────────────────────────────────

describe("US-DELTA-001 — Idempotent replay of projectDelegationStatus", () => {
  const fullSequence: RollEvent[] = [
    {
      type: "delta:prepared",
      delegationId: "d1",
      runId: "delta-d1",
      storyId: "US-REPLAY-1",
      trigger: "host-guided",
      topology: "full-delta-team",
      qualityProfile: "designed",
      presetId: "p1",
      presetSha256: "abc",
      hostId: "pi",
      ts: 1,
    },
    {
      type: "delta:role_resolved",
      delegationId: "d1",
      storyId: "US-REPLAY-1",
      role: "designer",
      roleInstanceId: "ri-d1",
      hostId: "pi",
      modelId: "model-host-1",
      source: "preset-preference",
      reasons: ["reasoning"],
      inventorySha256: "def",
      ts: 2,
    },
    {
      type: "delta:role_started",
      delegationId: "d1",
      storyId: "US-REPLAY-1",
      role: "designer",
      sessionId: "s1",
      roleInstanceId: "ri-d1",
      hostId: "pi",
      modelId: "model-host-1",
      identityProvenance: "host-attested",
      worktreeAccess: "read-only",
      ts: 3,
    },
    {
      type: "delta:artifact_published",
      delegationId: "d1",
      storyId: "US-REPLAY-1",
      role: "designer",
      path: "design.md",
      sha256: "ghi",
      manifestPath: "artifact-manifest.json",
      sessionId: "s1",
      roleInstanceId: "ri-d1",
      identityProvenance: "host-attested",
      ts: 4,
    },
    {
      type: "delta:terminal",
      delegationId: "d1",
      storyId: "US-REPLAY-1",
      outcome: "handoff_ready",
      terminalBinding: "handoff_only",
      deliveryDisposition: "owner_continue",
      ts: 5,
    },
  ];

  it("JSON serialization is stable across replays", () => {
    const view1 = projectDelegationStatus("d1", fullSequence);
    const view2 = projectDelegationStatus("d1", fullSequence);
    expect(JSON.stringify(view1)).toBe(JSON.stringify(view2));
  });

  it("repeating identical input does not change status, roles, or cost", () => {
    const view1 = projectDelegationStatus("d1", fullSequence);
    const view2 = projectDelegationStatus("d1", fullSequence);
    // Per-field assertions (not just structural deep-equal)
    expect(view2.status).toBe(view1.status);
    expect(view2.roles).toEqual(view1.roles);
    expect(view2.totalCost).toBe(view1.totalCost);
    // Full structural equality as final gate
    expect(view2).toEqual(view1);
  });

  it("doubled event sequence yields identical projection as single run", () => {
    const single = projectDelegationStatus("d1", fullSequence);
    const doubled = projectDelegationStatus("d1", [
      ...fullSequence,
      ...fullSequence,
    ]);
    expect(doubled.status).toBe(single.status);
    expect(doubled.roles).toEqual(single.roles);
    expect(doubled.totalCost).toBe(single.totalCost);
    expect(doubled).toEqual(single);
  });

  it("adapter-observed replay preserves usage_authority_unavailable cost label", () => {
    const adapterSequence: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d2",
        runId: "delta-d2",
        storyId: "US-LOOP-1",
        trigger: "loop-autonomous", // historical value — read-side compat (US-LOOP-110)
        topology: "solo",
        qualityProfile: "standard",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "adapter",
        ts: 1,
      },
      {
        type: "delta:role_resolved",
        delegationId: "d2",
        storyId: "US-LOOP-1",
        role: "builder",
        roleInstanceId: "ri-b1",
        hostId: "adapter",
        modelId: "model-adapter-1",
        source: "preset-preference",
        reasons: ["coding"],
        inventorySha256: "def",
        ts: 2,
      },
      {
        type: "delta:role_started",
        delegationId: "d2",
        storyId: "US-LOOP-1",
        role: "builder",
        sessionId: "s1",
        roleInstanceId: "ri-b1",
        hostId: "adapter",
        modelId: "model-adapter-1",
        identityProvenance: "adapter-observed",
        worktreeAccess: "read-only",
        ts: 3,
      },
    ];
    const v1 = projectDelegationStatus("d2", adapterSequence);
    const v2 = projectDelegationStatus("d2", adapterSequence);
    expect(v2.totalCost).toBe(v1.totalCost);
    expect(v2.totalCost).toBe("? (usage_authority_unavailable)");
    expect(v2).toEqual(v1);
  });
});

// ── Cost label consistency ────────────────────────────────────────────────────

describe("US-DELTA-001 — Cost label consistency", () => {
  it("host-guided event sequence totalCost is always ? (host_unobservable)", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d1",
        runId: "delta-d1",
        storyId: "US-COST-1",
        trigger: "host-guided",
        topology: "full-delta-team",
        qualityProfile: "designed",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "pi",
        ts: 1,
      },
      {
        type: "delta:role_resolved",
        delegationId: "d1",
        storyId: "US-COST-1",
        role: "designer",
        roleInstanceId: "ri-d1",
        hostId: "pi",
        modelId: "model-host-1",
        source: "preset-preference",
        reasons: ["reasoning"],
        inventorySha256: "def",
        ts: 2,
      },
      {
        type: "delta:role_started",
        delegationId: "d1",
        storyId: "US-COST-1",
        role: "designer",
        sessionId: "s1",
        roleInstanceId: "ri-d1",
        hostId: "pi",
        modelId: "model-host-1",
        identityProvenance: "host-attested",
        worktreeAccess: "read-only",
        ts: 3,
      },
      {
        type: "delta:terminal",
        delegationId: "d1",
        storyId: "US-COST-1",
        outcome: "handoff_ready",
        terminalBinding: "handoff_only",
        deliveryDisposition: "owner_continue",
        ts: 4,
      },
    ];
    const view = projectDelegationStatus("d1", events);
    // totalCost must be host_unobservable
    expect(view.totalCost).toBe("? (host_unobservable)");
    // Every host-attested role must also be host_unobservable
    for (const role of view.roles) {
      expect(role.cost).toBe("? (host_unobservable)");
    }
  });

  it("adapter-observed role cost is always ? (usage_authority_unavailable)", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d2",
        runId: "delta-d2",
        storyId: "US-COST-2",
        trigger: "loop-autonomous", // historical value — read-side compat (US-LOOP-110)
        topology: "solo",
        qualityProfile: "standard",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "adapter",
        ts: 1,
      },
      {
        type: "delta:role_resolved",
        delegationId: "d2",
        storyId: "US-COST-2",
        role: "builder",
        roleInstanceId: "ri-b1",
        hostId: "adapter",
        modelId: "model-adapter-1",
        source: "preset-preference",
        reasons: ["coding"],
        inventorySha256: "def",
        ts: 2,
      },
      {
        type: "delta:role_started",
        delegationId: "d2",
        storyId: "US-COST-2",
        role: "builder",
        sessionId: "s1",
        roleInstanceId: "ri-b1",
        hostId: "adapter",
        modelId: "model-adapter-1",
        identityProvenance: "adapter-observed",
        worktreeAccess: "read-only",
        ts: 3,
      },
    ];
    const view = projectDelegationStatus("d2", events);
    // Each adapter-observed role must show usage_authority_unavailable
    for (const role of view.roles) {
      expect(role.cost).toBe("? (usage_authority_unavailable)");
    }
    // totalCost must reflect adapter-observed roles
    expect(view.totalCost).toBe("? (usage_authority_unavailable)");
  });

  it("mixed host-attested + adapter-observed roles → totalCost is usage_authority_unavailable", () => {
    const events: RollEvent[] = [
      {
        type: "delta:prepared",
        delegationId: "d3",
        runId: "delta-d3",
        storyId: "US-COST-3",
        trigger: "loop-autonomous", // historical value — read-side compat (US-LOOP-110)
        topology: "full-delta-team",
        qualityProfile: "designed",
        presetId: "p1",
        presetSha256: "abc",
        hostId: "adapter",
        ts: 1,
      },
      {
        type: "delta:role_resolved",
        delegationId: "d3",
        storyId: "US-COST-3",
        role: "designer",
        roleInstanceId: "ri-d1",
        hostId: "pi",
        modelId: "model-host-1",
        source: "preset-preference",
        reasons: ["reasoning"],
        inventorySha256: "def",
        ts: 2,
      },
      {
        type: "delta:role_started",
        delegationId: "d3",
        storyId: "US-COST-3",
        role: "designer",
        sessionId: "s1",
        roleInstanceId: "ri-d1",
        hostId: "pi",
        modelId: "model-host-1",
        identityProvenance: "host-attested",
        worktreeAccess: "read-only",
        ts: 3,
      },
      {
        type: "delta:role_resolved",
        delegationId: "d3",
        storyId: "US-COST-3",
        role: "builder",
        roleInstanceId: "ri-b1",
        hostId: "adapter",
        modelId: "model-adapter-1",
        source: "preset-preference",
        reasons: ["coding"],
        inventorySha256: "ghi",
        ts: 4,
      },
      {
        type: "delta:role_started",
        delegationId: "d3",
        storyId: "US-COST-3",
        role: "builder",
        sessionId: "s2",
        roleInstanceId: "ri-b1",
        hostId: "adapter",
        modelId: "model-adapter-1",
        identityProvenance: "adapter-observed",
        worktreeAccess: "read-only",
        ts: 5,
      },
    ];
    const view = projectDelegationStatus("d3", events);
    // Host-attested role cost
    expect(view.roles[0].cost).toBe("? (host_unobservable)");
    // Adapter-observed role cost
    expect(view.roles[1].cost).toBe("? (usage_authority_unavailable)");
    // totalCost: any adapter-observed → usage_authority_unavailable
    expect(view.totalCost).toBe("? (usage_authority_unavailable)");
  });
});
