import { describe, expect, it } from "vitest";
import type { WorkspaceRegistryCandidate } from "@roll/core";
import { resolveBacklogTarget } from "../src/commands/backlog-target.js";

function candidate(root: string, workspaceId: string): WorkspaceRegistryCandidate {
  return {
    workspaceId,
    root,
    canonicalRoot: root,
    manifestWorkspaceId: workspaceId,
    pathState: "valid",
    lifecycle: "active",
  };
}

describe("resolveBacklogTarget", () => {
  it("returns Workspace-owned planning runtime and config paths", () => {
    expect(resolveBacklogTarget({
      operation: "read",
      registry: [candidate("/workspaces/ws-a", "ws-a")],
      explicitWorkspace: "ws-a",
    })).toEqual({
      ok: true,
      workspaceId: "ws-a",
      workspaceRoot: "/workspaces/ws-a",
      canonicalRoot: "/workspaces/ws-a",
      backlogPath: "/workspaces/ws-a/backlog/index.md",
      storyRoot: "/workspaces/ws-a/backlog",
      runtimeRoot: "/workspaces/ws-a/runtime",
      configPath: "/workspaces/ws-a/runtime/backlog-sync.yaml",
    });
  });

  it("rejects every aggregate mutation before returning paths", () => {
    expect(resolveBacklogTarget({
      operation: "mutation",
      registry: [candidate("/workspaces/ws-a", "ws-a")],
      all: true,
    })).toMatchObject({ ok: false, code: "all_requires_readonly", candidates: [{ workspaceId: "ws-a" }] });
  });

  it("returns an exact migration diagnostic without adopting the legacy backlog", () => {
    expect(resolveBacklogTarget({
      operation: "mutation",
      registry: [],
      legacyProject: {
        repositoryRoot: "/tmp/legacy repo",
        backlogPath: "/tmp/legacy repo/.roll/backlog.md",
      },
      hasReachableWorkspaceManifest: false,
    })).toEqual({
      ok: false,
      code: "migration_required",
      migrationCheckCommand: "roll workspace migrate --from '/tmp/legacy repo' --check",
      candidates: [],
    });
  });
});
