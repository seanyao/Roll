import { describe, expect, it } from "vitest";
import { projectDeltaMetrics } from "../src/delta-team/metrics.js";
import type { RollEvent } from "@roll/spec";

const sha = "a".repeat(64);

function completeAttempt(id = "d-1", storyId = "US-METRIC-1"): RollEvent[] {
  return [
    { type: "delta:prepared", delegationId: id, runId: `delta-${id}`, storyId, trigger: "host-guided", topology: "delta-team", qualityProfile: "verified", presetId: "mixed", presetSha256: sha, hostId: "codex", ts: 1000 },
    { type: "delta:role_resolved", delegationId: id, storyId, role: "builder", roleInstanceId: `${id}-b`, hostId: "codex", modelId: "gpt", source: "preset", reasons: [], inventorySha256: sha, inventoryObservedAt: "2026-01-01T00:00:00Z", ts: 1010 },
    { type: "delta:role_resolved", delegationId: id, storyId, role: "evaluator", roleInstanceId: `${id}-e`, hostId: "kimi", modelId: "k3", source: "preset", reasons: [], inventorySha256: sha, inventoryObservedAt: "2026-01-01T00:00:00Z", ts: 1010 },
    { type: "delta:role_started", delegationId: id, storyId, role: "builder", sessionId: `${id}-bs`, roleInstanceId: `${id}-b`, hostId: "codex", modelId: "gpt", identityProvenance: "host-attested", worktreeAccess: "builder-write", ts: 1100 },
    { type: "tcr:round_started", v: 1, storyId, delegationId: id, roundId: `${id}-r1`, role: "builder", hostId: "codex", modelId: "gpt", headSha: "head", ts: 1200 },
    { type: "tcr:test_finished", v: 1, storyId, delegationId: id, roundId: `${id}-r1`, command: "roll test affected", affectedScope: "packages/core", exitCode: 0, wallMs: 50, outputSha256: sha, ts: 1300 },
    { type: "tcr:committed", v: 1, storyId, delegationId: id, roundId: `${id}-r1`, commitSha: "commit", proofAgeMs: 100, ts: 1400 },
    { type: "delta:artifact_published", delegationId: id, storyId, role: "builder", path: "builder", sha256: sha, manifestPath: "manifest", sessionId: `${id}-bs`, roleInstanceId: `${id}-b`, identityProvenance: "host-attested", ts: 5100 },
    { type: "delta:role_started", delegationId: id, storyId, role: "evaluator", sessionId: `${id}-es`, roleInstanceId: `${id}-e`, hostId: "kimi", modelId: "k3", identityProvenance: "host-attested", worktreeAccess: "read-only", ts: 5200 },
    { type: "delta:artifact_published", delegationId: id, storyId, role: "evaluator", path: "evaluation", sha256: sha, manifestPath: "manifest", sessionId: `${id}-es`, roleInstanceId: `${id}-e`, identityProvenance: "host-attested", ts: 7200 },
    { type: "delta:attempt_outcome", v: 1, delegationId: id, storyId, cause: "unknown", evidenceRef: "event:terminal", terminalFact: "handoff_ready", ts: 8000 },
    { type: "delta:terminal", delegationId: id, storyId, runId: `delta-${id}`, outcome: "handoff_ready", terminalBinding: "handoff_only", deliveryDisposition: "owner_continue", ts: 8000 },
  ];
}

describe("US-DELTA-013 — immutable Delta metrics projection", () => {
  it("projects exact rates, phase samples, TCR facts, and heterogeneous rig facts", () => {
    const report = projectDeltaMetrics({
      events: completeAttempt(),
      deliveries: [{ storyId: "US-METRIC-1", lifecycleState: "done", mergedAtMs: 10_000 }],
    });
    expect(report).toMatchObject({
      schema: "roll.delta.metrics.v1",
      windowBasis: "observed_event_time",
      cards: 1,
      attempts: 1,
      mergedCards: 1,
      firstPassMergeRate: { numerator: 1, denominator: 1, value: 1 },
      redelegateRate: { numerator: 0, denominator: 1, value: 0 },
      phaseWallMs: { builder: 4100, evaluator: 2100, mergeTail: 2000 },
      tcr: { rounds: 1, green: 1, red: 0, testWallMs: 50, completeRounds: 1, incompleteRounds: 0 },
      outcomeCauses: { unknown: 1 },
      incomplete: false,
    });
    expect(report.phaseSamples.builder).toEqual({ sampleSize: 1, totalMs: 4100, p50Ms: 4100, p95Ms: 4100 });
    expect(report.rigs).toEqual([expect.objectContaining({ builder: "gpt", evaluator: "k3", providerDiverse: true, modelDiverse: true, attempts: 1 })]);
  });

  it("does not fabricate zeros or success from a legacy/incomplete stream", () => {
    const report = projectDeltaMetrics({
      events: [{ type: "delta:prepared", delegationId: "legacy", runId: "delta-legacy", storyId: "US-LEGACY", trigger: "host-guided", topology: "delta-team", qualityProfile: "verified", presetId: "mixed", presetSha256: sha, hostId: "codex", ts: 1000 }],
      sourceDiagnostics: ["invalid event ledger line fixture:2 (metrics incomplete)"],
    });
    expect(report.mergedCards).toBe(0);
    expect(report.firstPassMergeRate).toEqual({ numerator: 0, denominator: 0, value: null, reason: "no_eligible_sample" });
    expect(report.phaseWallMs).toEqual({ builder: null, evaluator: null, mergeTail: null });
    expect(report.tcr.rounds).toBeNull();
    expect(report.incomplete).toBe(true);
    expect(report.diagnostics.join("\n")).toMatch(/no TCR rounds observed/);
  });

  it("counts a redelegated card once and keeps it out of first-pass merge", () => {
    const old = completeAttempt("d-old", "US-REPAIRED").map((event) => event.type === "delta:terminal"
      ? { ...event, deliveryDisposition: "owner_redelegate" as const }
      : event);
    const report = projectDeltaMetrics({
      events: [...old, ...completeAttempt("d-new", "US-REPAIRED")],
      deliveries: [{ storyId: "US-REPAIRED", mergedAtMs: 12_000 }],
    });
    expect(report).toMatchObject({ cards: 1, attempts: 2, mergedCards: 1 });
    expect(report.redelegateRate).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(report.firstPassMergeRate).toEqual({ numerator: 0, denominator: 1, value: 0 });
  });

  it("filters attempts by observed event-time and declares the percentile algorithm", () => {
    const report = projectDeltaMetrics({
      events: completeAttempt(),
      window: { fromTs: 50_000, toTs: 60_000 },
    });
    expect(report).toMatchObject({ cards: 0, attempts: 0, percentileAlgorithm: "nearest-rank" });
    expect(report.redelegateRate.value).toBeNull();
  });

  it("keeps same-provider and blocked attempts visible instead of relabeling them as success", () => {
    const blocked = completeAttempt("d-blocked", "US-BLOCKED").map((event) => {
      if (event.type === "delta:role_resolved" && event.role === "evaluator") return { ...event, hostId: "codex", modelId: "gpt" };
      if (event.type === "delta:role_started" && event.role === "evaluator") return { ...event, hostId: "codex", modelId: "gpt" };
      if (event.type === "delta:terminal") return { ...event, outcome: "blocked" as const, deliveryDisposition: undefined };
      return event;
    });
    const report = projectDeltaMetrics({ events: blocked });
    expect(report.mergedCards).toBe(0);
    expect(report.rigs).toEqual([expect.objectContaining({ modelDiverse: false, providerDiverse: false })]);
    expect(report.firstPassMergeRate.value).toBeNull();
  });
});
