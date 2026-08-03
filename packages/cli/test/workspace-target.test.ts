import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPOSITORY_BINDING_V1, WORKSPACE_MANIFEST_V1, repositoryIdFromRemote } from "@roll/spec";
import type { InspectedWorkspace } from "@roll/infra";
import { inspectWorkspaceCwd } from "../src/commands/workspace-target.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(root: string, workspaceId: string): InspectedWorkspace {
  mkdirSync(root, { recursive: true });
  const remote = `git@github.com:acme/${workspaceId}.git`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must be valid");
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
  })}\n`);
  return {
    workspaceId,
    root,
    canonicalRoot: realpathSync(root),
    pathState: "valid",
    lifecycle: "active",
    manifestWorkspaceId: workspaceId,
    consistency: "consistent",
  };
}

describe("inspectWorkspaceCwd", () => {
  it("uses one upward walk for a nested Issue cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "roll-cwd-workspace-"));
    dirs.push(root);
    const entry = workspace(root, "ws-alpha");
    const cwd = join(root, "issues", "US-1", "repo-a", "src");
    mkdirSync(cwd, { recursive: true });

    expect(inspectWorkspaceCwd(cwd, [entry])).toEqual({
      cwdManifest: {
        workspaceId: "ws-alpha",
        root,
        canonicalRoot: realpathSync(root),
        containment: "safe",
      },
      hasReachableWorkspaceManifest: true,
    });
  });

  it("finds a legacy repository root without treating its backlog as a target", () => {
    const root = mkdtempSync(join(tmpdir(), "roll-cwd-legacy-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".roll"));
    writeFileSync(join(root, ".roll", "backlog.md"), "legacy\n");
    const cwd = join(root, "src", "nested");
    mkdirSync(cwd, { recursive: true });

    expect(inspectWorkspaceCwd(cwd, [])).toEqual({
      hasReachableWorkspaceManifest: false,
      legacyProject: {
        repositoryRoot: realpathSync(root),
        backlogPath: realpathSync(join(root, ".roll", "backlog.md")),
      },
    });
  });

  it("does not classify a repository as legacy when a reachable manifest exists", () => {
    const root = mkdtempSync(join(tmpdir(), "roll-cwd-manifest-"));
    dirs.push(root);
    const entry = workspace(root, "ws-alpha");
    mkdirSync(join(root, ".roll"));
    writeFileSync(join(root, ".roll", "backlog.md"), "legacy-looking\n");
    expect(inspectWorkspaceCwd(root, [entry]).legacyProject).toBeUndefined();
  });
});
