/**
 * FIX-1502 — a redelegated reservation picked up via `prepare --continuation-run`
 * must be attributed to the NEW delta run on the Supervisor delivery board.
 * The old redelegated run stays as history; the successor name is never a run.
 */
import { describe, expect, it } from "vitest";
import type { ManagedWorkspaceSet, RollEvent } from "@roll/spec";
import { buildSupervisorDeliveryRunBoard } from "../src/index.js";

function workspace(runId: string, storyId: string, delegationId: string): ManagedWorkspaceSet {
  return {
    schema: 1,
    runId,
    storyId,
    kind: "host_delta",
    topology: "delta-team",
    delegationId,
    members: [{
      repositoryId: "github.com/acme/roll",
      workspaceKey: runId,
      relativeLocator: runId,
      checkoutRef: { kind: "detached", head: "a".repeat(40) },
    }],
  };
}

describe("FIX-1502 — delivery board attributes a picked-up continuation to the new run", () => {
  const storyId = "FIX-1502-BOARD";
  const oldDelegation = "old-delegation";
  const oldRun = "delta-old-delegation";
  const newDelegation = "new-delegation";
  const newRun = "delta-new-delegation";
  const successorName = "successor-alice";

  const events: RollEvent[] = [
    { type: "worktree:allocated", workspace: workspace(oldRun, storyId, oldDelegation), operationId: "old:alloc", ts: 1 },
    {
      type: "delta:prepared", delegationId: oldDelegation, runId: oldRun, storyId,
      trigger: "host-guided", topology: "delta-team", qualityProfile: "standard",
      presetId: "p", presetSha256: "x", hostId: "kimi", workspaceSchema: 2, ts: 2,
    },
    {
      type: "delta:terminal", delegationId: oldDelegation, storyId, runId: oldRun,
      outcome: "handoff_ready", terminalBinding: "handoff_only",
      deliveryDisposition: "owner_redelegate", reservationSource: "delivery-reservation",
      continuationRunId: successorName, ts: 3,
    },
    { type: "worktree:allocated", workspace: workspace(newRun, storyId, newDelegation), operationId: "new:alloc", ts: 4 },
    {
      type: "delta:prepared", delegationId: newDelegation, runId: newRun, storyId,
      trigger: "host-guided", topology: "delta-team", qualityProfile: "standard",
      presetId: "p", presetSha256: "x", hostId: "kimi", workspaceSchema: 2,
      continuation: { fromDelegationId: oldDelegation, fromRunId: oldRun, continuationRunId: successorName },
      ts: 5,
    },
  ];

  it("shows the new run as the story's current delivery and keeps the old run as history", () => {
    const board = buildSupervisorDeliveryRunBoard(events);
    const rows = board.rows.filter((row) => row.storyId === storyId);

    const newRow = rows.find((row) => row.runId === newRun);
    expect(newRow).toBeDefined();
    expect(newRow?.lifecycle).toBe("active");
    expect(newRow?.deltaStatus).not.toBe("handoff_ready");

    // The old redelegated run remains a handoff_ready historical row; it is
    // not reported as the current delivery of the story.
    const oldRow = rows.find((row) => row.runId === oldRun);
    expect(oldRow).toBeDefined();
    expect(oldRow?.lifecycle).toBe("handoff_ready");

    // The continuation name only verifies the pickup; it never becomes a run.
    expect(rows.some((row) => row.runId === successorName)).toBe(false);
    expect(rows.some((row) => row.workspaceMembers.some((member) => member === successorName))).toBe(false);
  });
});
