import { describe, expect, it } from "vitest";
import { resolveWorkspaceTarget, type WorkspaceTargetInput } from "../src/index.js";

describe("Workspace target golden path", () => {
  it("binds one mutation to the same immutable Workspace across every injected source", () => {
    const facts: WorkspaceTargetInput = {
      operation: "mutation",
      explicit: { kind: "path", absolutePath: "/workspace-link", canonicalPath: "/workspaces/product" },
      environment: { kind: "id", workspaceId: "ws-product" },
      registry: [
        {
          workspaceId: "ws-product",
          root: "/workspace-link",
          canonicalRoot: "/workspaces/product",
          manifestWorkspaceId: "ws-product",
          pathState: "valid",
          lifecycle: "active",
        },
      ],
      context: {
        cwdManifest: {
          workspaceId: "ws-product",
          root: "/workspace-link",
          canonicalRoot: "/workspaces/product",
          containment: "safe",
        },
        issueManifest: {
          workspaceId: "ws-product",
          root: "/workspace-link",
          canonicalRoot: "/workspaces/product",
          containment: "safe",
        },
      },
    };

    expect(resolveWorkspaceTarget(facts)).toEqual({
      ok: true,
      source: "explicit",
      target: {
        kind: "workspace",
        workspaceId: "ws-product",
        root: "/workspace-link",
        canonicalRoot: "/workspaces/product",
      },
    });
  });
});
