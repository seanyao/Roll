import { describe, expect, it } from "vitest";
import {
  ISSUE_MANIFEST_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  parseIssueManifest,
  parseWorkspaceManifest,
  repositoryIdFromRemote,
} from "../src/index.js";

describe("Workspace contract golden path", () => {
  it("binds one immutable Issue to the repositories declared by its Workspace", () => {
    const remote = "https://github.com/Owner/Product.git";
    const repoId = repositoryIdFromRemote(remote);
    expect(repoId.ok).toBe(true);
    if (!repoId.ok) return;

    const workspace = parseWorkspaceManifest({
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId: "ws-product",
      displayName: "Product delivery",
      requirements: [{ provider: "jira", ref: "PRODUCT-1" }],
      repositories: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: repoId.value,
        alias: "product",
        remote,
        integrationBranch: "main",
        provider: "github",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: ["test"] },
      }],
    }, { workspaceId: "ws-product" });
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    const declaredRepository = workspace.value.repositories[0];
    expect(declaredRepository).toBeDefined();
    if (declaredRepository === undefined) return;

    const issue = parseIssueManifest({
      schema: ISSUE_MANIFEST_V1,
      workspaceId: "ws-product",
      storyId: "US-WS-001",
      requirements: [{ provider: "jira", ref: "PRODUCT-1" }],
      repositories: [{
        repoId: declaredRepository.repoId,
        alias: declaredRepository.alias,
        access: "write",
        requiredDelivery: true,
        noChangePolicy: "changes_required",
        pathScope: ["packages/spec"],
      }],
    }, { workspaceId: "ws-product", storyId: "US-WS-001" });
    expect(issue).toMatchObject({
      ok: true,
      value: { workspaceId: "ws-product", storyId: "US-WS-001", repositories: [{ repoId: declaredRepository.repoId }] },
    });
  });
});
