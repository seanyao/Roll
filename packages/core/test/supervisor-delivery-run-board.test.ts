import { describe, expect, it } from "vitest";
import type { ManagedWorkspaceSet, RollEvent } from "@roll/spec";
import { buildSupervisorDeliveryRunBoard } from "../src/index.js";

function workspace(runId: string, storyId: string, kind: "cycle" | "host_delta" | "skill_dispatch", topology: "solo" | "delta-team" | "full-delta-team", delegationId?: string): ManagedWorkspaceSet {
  return {
    schema: 1,
    runId,
    storyId,
    kind,
    topology,
    ...(delegationId === undefined ? {} : { delegationId }),
    members: [{
      repositoryId: "github.com/acme/roll",
      workspaceKey: runId,
      relativeLocator: runId,
      checkoutRef: { kind: "detached", head: "a".repeat(40) },
    }],
  };
}

describe("US-LOOP-128 — shared Supervisor DeliveryRun board", () => {
  it("projects the complete DeliveryRun state matrix from shared truth and concrete inspections", () => {
    const handoff = workspace("delta-handoff", "US-HANDOFF", "host_delta", "delta-team", "handoff");
    const full = workspace("cycle-full", "US-FULL", "cycle", "full-delta-team");
    const skill = workspace("dispatch-skill", "US-SKILL", "skill_dispatch", "solo");
    const delivered = workspace("cycle-delivered", "US-DONE", "cycle", "solo");
    const stale = workspace("cycle-stale", "US-STALE", "cycle", "solo");
    const events: RollEvent[] = [
      { type: "worktree:allocated", workspace: handoff, operationId: "h:alloc", ts: 1 },
      { type: "delta:prepared", delegationId: "handoff", runId: "delta-handoff", storyId: "US-HANDOFF", trigger: "host-guided", topology: "delta-team", qualityProfile: "verified", presetId: "p", presetSha256: "x", hostId: "codex", workspaceSchema: 2, ts: 2 },
      { type: "delta:terminal", delegationId: "handoff", storyId: "US-HANDOFF", runId: "delta-handoff", outcome: "handoff_ready", terminalBinding: "handoff_only", deliveryDisposition: "owner_continue", reservationSource: "delivery-reservation", ts: 3 },
      { type: "worktree:allocated", workspace: full, operationId: "f:alloc", ts: 4 },
      { type: "delta:prepared", delegationId: "full", runId: "cycle-full", cycleId: "cycle-full", storyId: "US-FULL", trigger: "host-guided", topology: "full-delta-team", qualityProfile: "designed", presetId: "p", presetSha256: "x", hostId: "codex", workspaceSchema: 2, ts: 5 },
      { type: "worktree:allocated", workspace: skill, operationId: "s:alloc", ts: 6 },
      { type: "worktree:recovery_required", runId: "dispatch-skill", relativeLocator: "dispatch-skill", reason: "unregistered_workspace", ts: 7 },
      { type: "worktree:allocated", workspace: delivered, operationId: "d:alloc", ts: 8 },
      { type: "delivery:merge_confirmed", cycleId: "cycle-delivered", storyId: "US-DONE", branch: "us/done", signal: "ancestor", mergeCommit: "b".repeat(40), ts: 9 },
      { type: "attest:gate", cycleId: "cycle-delivered", verdict: "produced", reasons: [], ts: 10 },
      { type: "worktree:release_requested", runId: "cycle-delivered", reason: "delivered", operationId: "d:release", expectedHeads: [{ relativeLocator: "cycle-delivered", head: "a".repeat(40) }], ts: 11 },
      { type: "worktree:allocated", workspace: stale, operationId: "stale:alloc", ts: 12 },
      { type: "worktree:activity_observed", runId: "cycle-stale", source: "runner", ts: 13 },
      { type: "cycle:start", cycleId: "cycle-legacy", storyId: "US-LEGACY", agent: "codex", model: "m", ts: 15 },
    ];

    expect(buildSupervisorDeliveryRunBoard(events, {
      now: 20,
      staleAfterMs: 5,
      inspections: [
        { runId: "cycle-delivered", owner: "loop", relativeLocator: "cycle-delivered", registration: "registered", activity: "inactive", head: "expected", cleanliness: "clean" },
        { runId: "cycle-stale", owner: "loop", relativeLocator: "cycle-stale", registration: "missing", activity: "inactive", head: "unknown", cleanliness: "unknown" },
        { owner: "manual", storyId: "US-MANUAL", relativeLocator: "manual-wt", registration: "unknown", activity: "inactive", head: "unknown", cleanliness: "unknown" },
        { owner: "external", storyId: "US-EXTERNAL", relativeLocator: "external-wt", registration: "foreign", activity: "inactive", head: "unknown", cleanliness: "unknown" },
      ],
    })).toMatchSnapshot();
  });
});
