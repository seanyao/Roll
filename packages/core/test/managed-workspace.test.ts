import { describe, expect, it } from "vitest";
import type { ManagedWorkspaceSet, RollEvent } from "@roll/spec";
import {
  managedWorkspaceReleaseVerdict,
  projectManagedWorkspaceRuns,
} from "../src/index.js";

const workspace: ManagedWorkspaceSet = {
  schema: 1,
  runId: "delta-d1",
  storyId: "US-LOOP-122",
  kind: "host_delta",
  topology: "delta-team",
  delegationId: "d1",
  members: [{
    repositoryId: "github.com/acme/roll",
    workspaceKey: "delta-d1",
    relativeLocator: "delta-d1",
    checkoutRef: { kind: "detached", head: "a".repeat(40) },
  }],
};

const inspection = {
  relativeLocator: "delta-d1",
  registration: "registered" as const,
  activity: "inactive" as const,
  head: "expected" as const,
  cleanliness: "clean" as const,
};

describe("US-LOOP-122 — managed workspace projection", () => {
  it("projects allocation without activity as active_unstarted and host activity as stale deterministically", () => {
    const events: RollEvent[] = [
      { type: "worktree:allocated", workspace, ts: 100 },
      { type: "worktree:activity_observed", runId: "delta-d1", source: "host_attested", ts: 200 },
    ];
    expect(projectManagedWorkspaceRuns(events, { now: 299, staleAfterMs: 100 })).toMatchObject([{ runId: "delta-d1", state: "active" }]);
    expect(projectManagedWorkspaceRuns(events, { now: 300, staleAfterMs: 100 })).toMatchObject([{ runId: "delta-d1", state: "stale" }]);
    expect(projectManagedWorkspaceRuns([{ type: "worktree:allocated", workspace, ts: 100 }])).toMatchObject([{ runId: "delta-d1", state: "active_unstarted" }]);
  });

  it("adapts historical cycles and Delta records without inventing workspace facts", () => {
    const views = projectManagedWorkspaceRuns([
      { type: "cycle:start", cycleId: "cycle-old", storyId: "US-OLD", agent: "pi", model: "m", ts: 1 },
      { type: "delta:prepared", delegationId: "old", runId: "delta-old", storyId: "US-OLD-DELTA", trigger: "loop-autonomous", topology: "delta-team", qualityProfile: "verified", presetId: "p", presetSha256: "x", hostId: "host", ts: 2 },
    ]);
    expect(views).toEqual([
      expect.objectContaining({ runId: "cycle-old", kind: "cycle", state: "legacy_cycle" }),
      expect.objectContaining({ runId: "delta-old", kind: "host_delta", state: "unknown" }),
    ]);
    expect(views[0]).not.toHaveProperty("workspace");
    expect(views[1]).not.toHaveProperty("workspace");
  });

  it("does not turn a Delta handoff into a delivery verdict", () => {
    const view = projectManagedWorkspaceRuns([
      { type: "worktree:allocated", workspace, ts: 1 },
      { type: "delta:terminal", delegationId: "d1", storyId: "US-LOOP-122", outcome: "handoff_ready", terminalBinding: "handoff_only", deliveryDisposition: "owner_continue", ts: 2 },
    ])[0]!;
    expect(view.state).toBe("handoff_ready");
    expect("delivery" in view).toBe(false);
  });

  it("keeps a Git-created/event-missing allocation visible with its operation identity", () => {
    const view = projectManagedWorkspaceRuns([{
      type: "worktree:recovery_required",
      runId: "delta-d1",
      relativeLocator: "delta-d1",
      reason: "git_created_event_missing",
      workspace,
      operationId: "delta-d1:allocate",
      ts: 1,
    }])[0]!;
    expect(view).toMatchObject({
      runId: "delta-d1",
      state: "recovery_required",
      allocationOperationId: "delta-d1:allocate",
      recoveryReason: "git_created_event_missing",
    });
  });

  it("accepts an idempotent same-operation allocation but blocks a different operation", () => {
    const same = projectManagedWorkspaceRuns([
      { type: "worktree:allocated", workspace, operationId: "delta-d1:allocate", ts: 1 },
      { type: "worktree:allocated", workspace, operationId: "delta-d1:allocate", ts: 2 },
    ])[0]!;
    const different = projectManagedWorkspaceRuns([
      { type: "worktree:allocated", workspace, operationId: "delta-d1:allocate", ts: 1 },
      { type: "worktree:allocated", workspace, operationId: "other", ts: 2 },
    ])[0]!;
    expect(same.state).toBe("active_unstarted");
    expect(different).toMatchObject({ state: "recovery_required", recoveryReason: "duplicate_allocation" });
  });
});

describe("US-LOOP-122 — release verdict", () => {
  const base = {
    runState: "release_requested" as const,
    delivery: "merged" as const,
    attest: "accepted" as const,
    factsAgree: true,
    members: [inspection],
  };

  it.each([
    ["safe_to_release", base],
    ["preserve_active", { ...base, runState: "active_unstarted" as const }],
    ["preserve_unmerged", { ...base, delivery: "unmerged" as const }],
    ["preserve_pending_evidence", { ...base, attest: "missing" as const }],
    ["preserve_truth_disagreement", { ...base, factsAgree: false }],
    ["preserve_unknown", { ...base, members: [{ ...inspection, cleanliness: "unknown" as const }] }],
  ] as const)("returns only the named %s outcome", (verdict, input) => {
    expect(managedWorkspaceReleaseVerdict(input)).toEqual({ verdict });
  });

  it("requires confirmed merge, accepted attest, and every safe member", () => {
    expect(managedWorkspaceReleaseVerdict({ ...base, delivery: "unknown" })).toEqual({ verdict: "preserve_unknown" });
    expect(managedWorkspaceReleaseVerdict({ ...base, attest: "unknown" })).toEqual({ verdict: "preserve_unknown" });
    expect(managedWorkspaceReleaseVerdict({ ...base, members: [{ ...inspection, registration: "missing" }] })).toEqual({ verdict: "preserve_unknown" });
  });
});
