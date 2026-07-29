import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverWorkspaceForIntent } from "@roll/core";
import {
  REQUIREMENT_HINT_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  repositoryIdFromRemote,
} from "@roll/spec";
import { WorkspaceRegistry, loadWorkspaceDiscovery } from "../src/index.js";

const roots: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(root: string, workspaceId: string, requirementRef: string): string {
  mkdirSync(root, { recursive: true });
  const remote = `https://example.test/${workspaceId}/product.git`;
  const identity = repositoryIdFromRemote(remote);
  if (!identity.ok) throw new Error("fixture remote must be valid");
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId,
    displayName: workspaceId,
    requirements: [{ provider: "jira", ref: requirementRef }],
    repositories: [{
      schema: REPOSITORY_BINDING_V1,
      repoId: identity.value,
      alias: "product",
      remote,
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  }, null, 2)}\n`, "utf8");
  return root;
}

describe("US-WS-028 arbitrary-cwd requirement-first discovery", () => {
  it("does not route APE-234 to the only active roll Workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "roll-workspace-discovery-e2e-"));
    roots.push(root);
    const rollHome = join(root, "home");
    const roll = workspace(join(root, "workspaces", "roll"), "roll", "IDEA-074");
    const fields = workspace(join(root, "workspaces", "fields"), "fields", "APE-234");
    const registry = new WorkspaceRegistry({ rollHome });
    registry.register({ workspaceId: "roll", root: roll });
    registry.activate("roll");
    registry.register({ workspaceId: "fields", root: fields });
    process.chdir("/tmp");

    const loaded = loadWorkspaceDiscovery({ rollHome });
    const decision = discoverWorkspaceForIntent({
      intent: {
        schema: "roll.workspace-intent/v1",
        operation: "mutation",
        interaction: "non_interactive",
        scope: "workspace_required_mutation",
        cwd: process.cwd(),
        requirement: {
          schema: REQUIREMENT_HINT_V1,
          sources: [{ key: { provider: "jira", ref: "APE-234" }, provenance: "deterministic_extraction" }],
          storyIds: [],
          repositoryRemotes: [],
          paths: [],
        },
      },
      workspaces: loaded.workspaces,
      diagnostics: loaded.diagnostics,
    });

    if (process.env["ROLL_CAPTURE_TRANSCRIPT"] === "1") {
      console.log(JSON.stringify({
        requestedCwd: "/tmp",
        actualCwd: process.cwd(),
        requirement: "jira:APE-234",
        onlyActiveWorkspace: "roll",
        decision: decision.ok ? decision : {
          ok: decision.ok,
          kind: decision.kind,
          code: decision.code,
          candidates: decision.candidates.map((candidate) => ({
            workspaceId: candidate.workspaceId,
            lifecycle: candidate.lifecycle,
            hardMatch: candidate.hardMatch,
          })),
          diagnostics: decision.diagnostics,
        },
      }, null, 2));
    }
    expect(decision).toMatchObject({
      ok: false,
      kind: "activation_required",
      code: "workspace_activation_required",
      candidates: [{ workspaceId: "fields", lifecycle: "registered", hardMatch: true }],
    });
    expect(decision).not.toMatchObject({ target: { workspaceId: "roll" } });
  });
});
