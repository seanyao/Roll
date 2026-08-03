import { describe, expect, it } from "vitest";
import {
  WORKSPACE_EVENT_V1,
  type WorkspaceLifecycle,
  type WorkspaceLifecycleEvent,
} from "../src/index.js";

describe("Workspace lifecycle wire contract", () => {
  it("exports one closed schema and event vocabulary", () => {
    const lifecycle: WorkspaceLifecycle = "active";
    const registered = {
      schema: WORKSPACE_EVENT_V1,
      type: "workspace:registered",
      workspaceId: "ws-alpha",
      ts: 1,
    } satisfies WorkspaceLifecycleEvent;
    const moved = {
      schema: WORKSPACE_EVENT_V1,
      type: "workspace:path_updated",
      workspaceId: "ws-alpha",
      ts: 2,
      oldRoot: "/old",
      newRoot: "/new",
    } satisfies WorkspaceLifecycleEvent;

    expect(WORKSPACE_EVENT_V1).toBe("roll.workspace-event/v1");
    expect([lifecycle, registered.type, moved.type]).toEqual([
      "active",
      "workspace:registered",
      "workspace:path_updated",
    ]);
  });
});
