import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ISSUE_MANIFEST_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  repositoryIdFromRemote,
} from "@roll/spec";
import { WorkspaceRegistry, loadWorkspaceExecutionContext } from "../src/index.js";

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("Workspace execution context golden path", () => {
  it("loads a real repository HEAD without consulting the host cwd", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "roll-workspace-context-e2e-")));
    sandboxes.push(base);
    const rollHome = join(base, "home");
    const root = join(base, "workspace");
    const storyId = "US-WS-031";
    const issueRoot = join(root, "issues", storyId);
    const worktree = join(issueRoot, "product");
    for (const path of [
      join(root, "backlog"),
      join(root, "features"),
      join(root, "design"),
      join(root, "requirements"),
      join(root, "evidence"),
      join(root, "runtime", "tool-dumps"),
      join(root, "runtime", "events"),
      join(root, "runtime", "locks"),
      worktree,
    ]) mkdirSync(path, { recursive: true });
    const remote = "https://example.test/acme/product.git";
    const id = repositoryIdFromRemote(remote);
    if (!id.ok) throw new Error("invalid fixture remote");
    writeFileSync(join(root, "backlog", "index.md"), "# Backlog\n", "utf8");
    writeFileSync(join(root, "policy.yaml"), "{}\n", "utf8");
    writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId: "ws-demo",
      displayName: "Demo",
      requirements: [],
      repositories: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: id.value,
        alias: "product",
        remote,
        integrationBranch: "idea-074-workspace",
        provider: "generic",
        workflow: {
          branchPattern: "roll/{workspace_id}/{story_id}/{repo_alias}",
          requiredChecks: ["test"],
        },
      }],
    }, null, 2)}\n`, "utf8");
    writeFileSync(join(issueRoot, "manifest.json"), `${JSON.stringify({
      schema: ISSUE_MANIFEST_V1,
      workspaceId: "ws-demo",
      storyId,
      requirements: [],
      repositories: [{
        repoId: id.value,
        alias: "product",
        access: "write",
        requiredDelivery: true,
        noChangePolicy: "changes_required",
      }],
      integrationAcceptance: { command: ["pnpm", "test:integration"] },
    }, null, 2)}\n`, "utf8");
    git(worktree, ["init", "-q"]);
    git(worktree, ["config", "user.name", "Roll Test"]);
    git(worktree, ["config", "user.email", "roll@example.test"]);
    writeFileSync(join(worktree, "README.md"), "context fixture\n", "utf8");
    git(worktree, ["add", "README.md"]);
    git(worktree, ["commit", "-qm", "fixture"]);
    const head = git(worktree, ["rev-parse", "HEAD"]);
    writeFileSync(join(issueRoot, "events.jsonl"), `${JSON.stringify({
      type: "issue:repository_bound",
      workspaceId: "ws-demo",
      storyId,
      alias: "product",
      repoId: id.value,
      access: "write",
      baseSha: head,
      worktreePath: realpathSync(worktree),
      workBranch: "roll/ws-demo/US-WS-031/product",
      ts: 1,
    })}\n`, "utf8");
    const registry = new WorkspaceRegistry({ rollHome });
    registry.register({ workspaceId: "ws-demo", root });
    registry.activate("ws-demo");
    const canonicalRoot = realpathSync(root);

    const context = loadWorkspaceExecutionContext({
      rollHome,
      target: {
        kind: "workspace",
        workspaceId: "ws-demo",
        root: canonicalRoot,
        canonicalRoot,
      },
      source: "explicit",
      scope: "repository_required",
      storyId,
      evidence: [],
    });

    expect(context?.issue?.execution.repositories[id.value]).toMatchObject({
      worktreePath: realpathSync(worktree),
      baseSha: head,
      headSha: head,
      commands: { test: [], integration: ["pnpm", "test:integration"] },
    });
  });
});
