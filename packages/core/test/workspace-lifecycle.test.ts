import { describe, expect, it } from "vitest";
import {
  WORKSPACE_EVENT_V1,
  WorkspaceLifecycleError,
  decideWorkspaceTransition,
  foldWorkspaceLifecycles,
  type WorkspaceLifecycleEvent,
} from "../src/workspace/lifecycle.js";

function event(
  type: WorkspaceLifecycleEvent["type"],
  workspaceId: string,
  ts: number,
): WorkspaceLifecycleEvent {
  return { schema: WORKSPACE_EVENT_V1, type, workspaceId, ts };
}

describe("foldWorkspaceLifecycles", () => {
  it("rebuilds multiple active Workspaces from append-only events", () => {
    const events: readonly WorkspaceLifecycleEvent[] = [
      event("workspace:registered", "ws-beta", 1),
      event("workspace:registered", "ws-alpha", 2),
      event("workspace:activated", "ws-beta", 3),
      event("workspace:activated", "ws-alpha", 4),
    ];
    expect(foldWorkspaceLifecycles(events)).toEqual([
      { workspaceId: "ws-alpha", lifecycle: "active", lastEventTs: 4 },
      { workspaceId: "ws-beta", lifecycle: "active", lastEventTs: 3 },
    ]);
  });

  it("changes only the Workspace named by pause and archive events", () => {
    const events: readonly WorkspaceLifecycleEvent[] = [
      event("workspace:registered", "ws-alpha", 1),
      event("workspace:activated", "ws-alpha", 2),
      event("workspace:registered", "ws-beta", 3),
      event("workspace:activated", "ws-beta", 4),
      event("workspace:paused", "ws-alpha", 5),
      event("workspace:archived", "ws-alpha", 6),
    ];
    expect(foldWorkspaceLifecycles(events)).toEqual([
      { workspaceId: "ws-alpha", lifecycle: "archived", lastEventTs: 6 },
      { workspaceId: "ws-beta", lifecycle: "active", lastEventTs: 4 },
    ]);
  });

  it("treats archive as reversible metadata and accepts later activation", () => {
    expect(foldWorkspaceLifecycles([
      event("workspace:registered", "ws-alpha", 1),
      event("workspace:archived", "ws-alpha", 2),
      event("workspace:activated", "ws-alpha", 3),
    ])).toEqual([{ workspaceId: "ws-alpha", lifecycle: "active", lastEventTs: 3 }]);
  });

  it("is deterministic, ignores path updates for lifecycle, and never mutates input", () => {
    const events: WorkspaceLifecycleEvent[] = [
      event("workspace:registered", "ws-z", 1),
      { schema: WORKSPACE_EVENT_V1, type: "workspace:path_updated", workspaceId: "ws-z", ts: 2, oldRoot: "/old", newRoot: "/new" },
      event("workspace:registered", "ws-ä", 3),
    ];
    const before = JSON.stringify(events);
    const first = foldWorkspaceLifecycles(events);
    expect(first).toEqual([
      { workspaceId: "ws-z", lifecycle: "registered", lastEventTs: 1 },
      { workspaceId: "ws-ä", lifecycle: "registered", lastEventTs: 3 },
    ]);
    expect(JSON.stringify(foldWorkspaceLifecycles(events))).toBe(JSON.stringify(first));
    expect(JSON.stringify(events)).toBe(before);
  });

  it("fails loud when a transition has no prior registration", () => {
    try {
      foldWorkspaceLifecycles([event("workspace:activated", "ws-missing", 1)]);
      throw new Error("expected lifecycle fold to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLifecycleError);
      expect(error).toMatchObject({ code: "transition_before_registration" });
    }
  });
});

describe("decideWorkspaceTransition", () => {
  it("keeps archive reversible only through an explicit activation", () => {
    expect(decideWorkspaceTransition("archived", "activate")).toEqual({
      ok: true,
      eventType: "workspace:activated",
    });
    expect(decideWorkspaceTransition("archived", "pause")).toEqual({
      ok: false,
      code: "archived_requires_activation",
    });
    expect(decideWorkspaceTransition("archived", "archive")).toEqual({
      ok: false,
      code: "already_archived",
    });
  });

  it("makes repeated active and paused transitions explicit no-ops", () => {
    expect(decideWorkspaceTransition("active", "activate")).toEqual({ ok: true, eventType: null });
    expect(decideWorkspaceTransition("paused", "pause")).toEqual({ ok: true, eventType: null });
    expect(decideWorkspaceTransition("registered", "archive")).toEqual({
      ok: true,
      eventType: "workspace:archived",
    });
  });
});
