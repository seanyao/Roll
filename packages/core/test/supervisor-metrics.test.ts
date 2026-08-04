import { describe, expect, it } from "vitest";
import { projectSupervisorMetrics } from "../src/supervisor/metrics.js";
import type { RollEvent } from "@roll/spec";

const sha = "a".repeat(64);
const backlog = [
  { id: "US-BLOCKED", status: "📋 Todo", dependsOn: ["US-DEP"] },
  { id: "US-DEP", status: "📋 Todo", dependsOn: [] },
  { id: "US-HANDOFF", status: "📋 Todo", dependsOn: [] },
  { id: "US-MERGED", status: "✅ Done", dependsOn: [] },
  { id: "US-RECONCILED", status: "✅ Done", dependsOn: [] },
  { id: "US-PARTIAL", status: "📋 Todo", dependsOn: ["US-RECONCILED"] },
] as const;

function merged(storyId: string, cycleId: string, at: number): RollEvent[] {
  return [
    { type: "cycle:start", cycleId, storyId, agent: "codex", model: "gpt", ts: at },
    { type: "cycle:first_edit", cycleId, commitHash: `${cycleId}-edit`, ts: at + 10 },
    { type: "pr:open", prNumber: at, storyId, ts: at + 20 },
    { type: "ci:pass", prNumber: at, ts: at + 30 },
    { type: "delivery:merge_confirmed", cycleId, storyId, branch: `roll/${storyId}`, signal: "ancestor", ts: at + 40 },
  ];
}

describe("US-LOOP-130 — Supervisor metrics projection", () => {
  it("keeps zero cards as a truthful empty read model", () => {
    expect(projectSupervisorMetrics({ events: [], backlog: [] })).toMatchObject({
      schema: "roll.supervisor.metrics.v1",
      sampleSize: 0,
      observationWindow: { fromTs: null, toTs: null },
      truthConsistency: { checked: 0, consistent: 0, inconsistent: 0, incomplete: 0 },
      incomplete: false,
    });
  });

  it("separates dependency states and never inflates a missing dependency timestamp", () => {
    const report = projectSupervisorMetrics({
      backlog,
      events: [
        { type: "pick:ranked", cycleId: "blocked", picked: "US-BLOCKED", rank: 1, total: 1, reason: "ready", ranking: [{ id: "US-BLOCKED", score: 1, reason: "ready" }], source: "cache", ts: 90 },
        { type: "pick:blocked", cycleId: "blocked", storyId: "US-BLOCKED", reason: "waiting on US-DEP", ts: 100 },
        { type: "cycle:start", cycleId: "blocked", storyId: "US-BLOCKED", agent: "codex", model: "gpt", ts: 300 },
        { type: "delivery:merge_confirmed", cycleId: "reconciled", storyId: "US-RECONCILED", branch: "roll/reconciled", signal: "ancestor", ts: 150 },
        { type: "pick:blocked", cycleId: "partial", storyId: "US-PARTIAL", reason: "queued", ts: 200 },
      ],
    });
    expect(report.cards.find((card) => card.storyId === "US-BLOCKED")).toMatchObject({ queueWaitMs: 210, dependencyState: "blocked_by_not_done", dependencyWaitMs: 200 });
    expect(report.cards.find((card) => card.storyId === "US-PARTIAL")).toMatchObject({ dependencyState: "not_yet_dispatched", dependencyWaitMs: null });
    expect(report.cards.find((card) => card.storyId === "US-DEP")).toMatchObject({ dependencyState: "not_applicable" });
    expect(report.dependencyStates).toEqual({ blocked_by_not_done: 1, not_yet_dispatched: 1, unknown: 0 });
  });

  it("does not treat handoff_ready as a merge, attest verdict, or delivery", () => {
    const report = projectSupervisorMetrics({
      backlog,
      events: [
        { type: "delta:prepared", delegationId: "handoff", runId: "delta-handoff", storyId: "US-HANDOFF", trigger: "host-guided", topology: "delta-team", qualityProfile: "verified", presetId: "standard", presetSha256: sha, hostId: "codex", ts: 100 },
        { type: "delta:terminal", delegationId: "handoff", storyId: "US-HANDOFF", runId: "delta-handoff", outcome: "handoff_ready", terminalBinding: "handoff_only", ts: 200 },
      ],
    });
    expect(report.cards.find((card) => card.storyId === "US-HANDOFF")).toMatchObject({
      handoffReady: true,
      delivery: "not_delivered",
      truth: { recordedMainMerge: "unavailable", attestation: "unavailable", consistency: "incomplete" },
    });
  });

  it("calls merged-but-unattested inconsistent, but only accepts fully reconciled truth", () => {
    const report = projectSupervisorMetrics({
      backlog,
      events: [
        ...merged("US-MERGED", "merged", 100),
        ...merged("US-RECONCILED", "reconciled", 300),
        { type: "delivery:reconciled", cycleId: "reconciled", storyId: "US-RECONCILED", state: "delivered", mergedBy: "runner", mergeCommit: "c", signal: "pr_state", ts: 350 },
        { type: "attest:gate", cycleId: "reconciled", verdict: "produced", reasons: [], ts: 360 },
      ],
      sourceDiagnostics: ["legacy fixture line 9 unreadable"],
    });
    expect(report.cards.find((card) => card.storyId === "US-MERGED")?.truth.consistency).toBe("inconsistent");
    expect(report.cards.find((card) => card.storyId === "US-RECONCILED")).toMatchObject({
      dispatchToMergeLeadMs: 40,
      prCiTailMs: 10,
      reconciliationLagMs: 10,
      truth: { consistency: "consistent" },
    });
    expect(report).toMatchObject({ incomplete: true, truthConsistency: { checked: 2, consistent: 1, inconsistent: 1 } });
    expect(report.diagnostics).toEqual(["legacy fixture line 9 unreadable"]);
  });
});
