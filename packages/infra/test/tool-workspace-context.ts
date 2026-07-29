import { join } from "node:path";
import { deriveWorkspaceExecutionAuthorities } from "@roll/core";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";

export const TOOL_TEST_REPO_ID = "repo-product";

export function toolWorkspaceContext(
  storyId: string,
  canonicalRoot = "/workspaces/tool-tests",
): WorkspaceExecutionContextV1 {
  const issueRoot = join(canonicalRoot, "issues", storyId);
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: {
      workspaceId: "tool-tests",
      root: canonicalRoot,
      canonicalRoot,
      lifecycle: "active",
    },
    resolution: { source: "explicit", evidence: [] },
    bindings: [{
      schema: REPOSITORY_BINDING_V1,
      repoId: TOOL_TEST_REPO_ID,
      alias: "product",
      remote: "git@github.com:example/product.git",
      integrationBranch: "idea-074-workspace",
      provider: "github",
      workflow: { branchPattern: "story/{storyId}", requiredChecks: [] },
    }],
    issue: {
      storyId,
      manifestPath: join(issueRoot, "manifest.json"),
      execution: {
        workspaceId: "tool-tests",
        issueRoot,
        repositories: {
          [TOOL_TEST_REPO_ID]: {
            repoId: TOOL_TEST_REPO_ID,
            alias: "product",
            access: "write",
            requiredDelivery: true,
            noChangePolicy: "changes_required",
            workBranch: `roll/tool-tests/${storyId}`,
            worktreePath: join(issueRoot, "product"),
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            commands: { test: [], integration: [] },
          },
        },
      },
    },
    authorities: deriveWorkspaceExecutionAuthorities(canonicalRoot),
  };
}
