import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  repositoryIdFromRemote,
} from "@roll/spec";
import { WorkspaceRegistry, workspaceRegistryPath } from "../src/workspace-registry.js";

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(root: string, workspaceId: string): string {
  mkdirSync(root, { recursive: true });
  const remote = `https://example.test/workspaces/${workspaceId}.git`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("test remote must be valid");
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId,
    displayName: workspaceId,
    requirements: [],
    repositories: [{
      schema: REPOSITORY_BINDING_V1,
      repoId: repoId.value,
      alias: "primary",
      remote,
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  })}\n`, "utf8");
  return root;
}

describe("Workspace registry golden path", () => {
  it("reopens two concurrent active Workspaces, preserves a move, and surfaces later path staleness", () => {
    const rollHome = mkdtempSync(join(tmpdir(), "roll-workspace-registry-e2e-"));
    sandboxes.push(rollHome);
    const alphaOld = workspace(join(rollHome, "roots", "alpha-old"), "ws-alpha");
    const alphaNew = workspace(join(rollHome, "roots", "alpha-new"), "ws-alpha");
    const beta = workspace(join(rollHome, "roots", "beta"), "ws-beta");
    const store = new WorkspaceRegistry({ rollHome, now: (() => {
      let ts = 0;
      return () => ++ts;
    })() });

    store.register({ workspaceId: "ws-alpha", root: alphaOld });
    store.register({ workspaceId: "ws-beta", root: beta });
    store.activate("ws-alpha");
    store.activate("ws-beta");
    store.move({ workspaceId: "ws-alpha", oldRoot: alphaOld, newRoot: alphaNew });
    store.pause("ws-beta");
    rmSync(alphaNew, { recursive: true });

    const reopened = new WorkspaceRegistry({ rollHome });
    expect(reopened.list().map(({ workspaceId, root, pathState, lifecycle }) => ({
      workspaceId,
      root,
      pathState,
      lifecycle,
    }))).toEqual([
      { workspaceId: "ws-alpha", root: alphaNew, pathState: "stale", lifecycle: "active" },
      { workspaceId: "ws-beta", root: beta, pathState: "valid", lifecycle: "paused" },
    ]);
    const persisted = JSON.parse(readFileSync(workspaceRegistryPath(rollHome), "utf8")) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("activeWorkspaceId");
    expect(persisted).not.toHaveProperty("lifecycle");
  });
});
