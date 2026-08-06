import { describe, expect, it } from "vitest";
import {
  normalizeManagedWorkspaceSet,
  parseEventLine,
  type ManagedWorkspaceSet,
  type RollEvent,
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
    publishRef: "refs/heads/roll/delta-d1",
  }],
};

describe("US-LOOP-122 — managed workspace boundary", () => {
  it("persists Skill children as members of their parent's workspace set", () => {
    expect(normalizeManagedWorkspaceSet({
      schema: 1,
      runId: "dispatch-r1",
      storyId: "US-LOOP-127",
      kind: "skill_dispatch",
      topology: "solo",
      members: [{
        repositoryId: "github.com/acme/roll",
        workspaceKey: "dispatch-r1",
        relativeLocator: "dispatch-r1",
        checkoutRef: { kind: "detached", head: "a".repeat(40) },
      }, {
        repositoryId: "github.com/acme/roll",
        workspaceKey: "dispatch-r1",
        relativeLocator: "dispatch-r1.children/docs",
        actionId: "docs",
        declaredFileScope: ["docs"],
        checkoutRef: { kind: "detached", head: "a".repeat(40) },
        publishRef: "refs/heads/dispatch-r1/docs",
      }],
    })).toMatchObject({ ok: true, value: { members: [
      expect.objectContaining({ relativeLocator: "dispatch-r1" }),
      expect.objectContaining({ actionId: "docs", declaredFileScope: ["docs"] }),
    ] } });
  });

  it("normalizes a primary and submodule member deterministically", () => {
    const result = normalizeManagedWorkspaceSet({
      ...workspace,
      members: [
        workspace.members[0]!,
        {
          repositoryId: "github.com/acme/submodule",
          workspaceKey: "delta-d1",
          relativeLocator: "delta-d1.submodules/packages/submodule",
          checkoutRef: { kind: "detached", head: "b".repeat(40) },
        },
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        ...workspace,
        members: [
          workspace.members[0],
          {
            repositoryId: "github.com/acme/submodule",
            workspaceKey: "delta-d1",
            relativeLocator: "delta-d1.submodules/packages/submodule",
            checkoutRef: { kind: "detached", head: "b".repeat(40) },
          },
        ],
      },
    });
  });

  it.each([
    "",
    "/tmp/absolute",
    "C:ambiguous",
    "../escape",
    "delta-d1/../escape",
    "delta-d1//double",
    "delta-d1/./ambiguous",
    "delta-d1/",
  ])("rejects malformed or ambiguous locators: %s", (relativeLocator) => {
    const result = normalizeManagedWorkspaceSet({
      ...workspace,
      members: [{ ...workspace.members[0]!, relativeLocator }],
    });
    expect(result.ok).toBe(false);
  });

  it("requires the primary direct-child locator and compatible run key", () => {
    expect(normalizeManagedWorkspaceSet({
      ...workspace,
      members: [{ ...workspace.members[0]!, relativeLocator: "delta-d1.submodules/x" }],
    }).ok).toBe(false);
    expect(normalizeManagedWorkspaceSet({
      ...workspace,
      members: [{ ...workspace.members[0]!, workspaceKey: "cycle-d1", relativeLocator: "cycle-d1" }],
    }).ok).toBe(false);
    expect(normalizeManagedWorkspaceSet({ ...workspace, topology: "full-delta-team" }).ok).toBe(false);
  });
});

describe("US-LOOP-122 — lifecycle events remain an append-only read contract", () => {
  it("types and parses all five workspace lifecycle events", () => {
    const events: RollEvent[] = [
      { type: "worktree:allocated", workspace, ts: 1 },
      { type: "worktree:activity_observed", runId: "delta-d1", source: "host_attested", ts: 2 },
      { type: "worktree:release_requested", runId: "delta-d1", reason: "delivered", operationId: "op-1", expectedHeads: [{ relativeLocator: "delta-d1", head: "a".repeat(40) }], ts: 3 },
      { type: "worktree:released", runId: "delta-d1", operationId: "op-1", expectedHeads: [{ relativeLocator: "delta-d1", head: "a".repeat(40) }], ts: 4 },
      { type: "worktree:recovery_required", runId: "delta-d1", relativeLocator: "delta-d1", reason: "append failed", ts: 5 },
    ];

    expect(events.map((event) => parseEventLine(JSON.stringify(event))?.type)).toEqual([
      "worktree:allocated",
      "worktree:activity_observed",
      "worktree:release_requested",
      "worktree:released",
      "worktree:recovery_required",
    ]);
  });

  it("continues to parse historical cycle and delta records without workspace facts", () => {
    expect(parseEventLine('{"type":"cycle:start","cycleId":"cycle-old","storyId":"US-OLD","agent":"pi","model":"m","ts":1}')?.type).toBe("cycle:start");
    expect(parseEventLine('{"type":"delta:prepared","delegationId":"old","runId":"delta-old","storyId":"US-OLD","trigger":"loop-autonomous","topology":"delta-team","qualityProfile":"verified","presetId":"p","presetSha256":"x","hostId":"host","ts":2}')?.type).toBe("delta:prepared");
  });
});

// ── US-CYCLE-013 — handoff identity workspace stays a valid ManagedWorkspaceSet
// (matrix #15: the retained workspace is only released by a same-identity
// successful cleanup; the set itself must survive a cycle-handoff identity).


describe("US-CYCLE-013 — handoff workspace identity (matrix #15)", () => {
  it("normalizes the exact allocated workspace carried inside a HandoffIdentity", () => {
    const workspace: ManagedWorkspaceSet = {
      schema: 1,
      runId: "c1",
      storyId: "US-1",
      kind: "cycle",
      topology: "solo",
      members: [{
        repositoryId: "repo-id",
        workspaceKey: "cycle-c1",
        relativeLocator: "cycle-c1",
        checkoutRef: { kind: "detached", head: "base-sha" },
        publishRef: "refs/heads/loop/cycle-c1",
      }],
    };
    const normalized = normalizeManagedWorkspaceSet(workspace);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.value.members[0]?.checkoutRef.head).toBe("base-sha");
      expect(normalized.value.members[0]?.publishRef).toBe("refs/heads/loop/cycle-c1");
    }
    // A broken member shape (missing detached head) is rejected — a handoff
    // identity can never carry an unallocatable workspace.
    const broken: ManagedWorkspaceSet = { ...workspace, members: [{ ...workspace.members[0]!, checkoutRef: { kind: "detached" } }] as unknown as [ManagedWorkspaceSet["members"][number]] };
    expect(normalizeManagedWorkspaceSet(broken).ok).toBe(false);
  });
});
