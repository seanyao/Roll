import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export interface WorkspaceContextFixture {
  readonly home: string;
  readonly rollHome: string;
  readonly outside: string;
  readonly alpha: string;
  readonly beta: string;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function workspace(root: string, workspaceId: string, displayName: string, storyId: string): void {
  mkdirSync(root, { recursive: true });
  write(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: "roll.workspace/v1",
    workspaceId,
    displayName,
    requirements: [{ provider: "jira", ref: `${workspaceId.toUpperCase()}-1` }],
    repositories: [{
      schema: "roll.repository-binding/v1",
      repoId: workspaceId === "alpha" ? "repo-468d12a5194b" : "repo-dbed123c3298",
      alias: "product",
      remote: `https://example.test/${workspaceId}/product`,
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  }, null, 2)}\n`);
  write(join(root, "backlog", "index.md"), `# ${displayName}\n\n| Story | Description | Status |\n|---|---|---|\n| ${storyId} | ${workspaceId} story | 📋 Todo |\n`);
}

export function createWorkspaceContextFixture(): WorkspaceContextFixture {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-context-critical-"));
  const fixture = {
    home,
    rollHome: join(home, ".roll"),
    outside: join(home, "outside"),
    alpha: join(home, "workspaces", "alpha"),
    beta: join(home, "workspaces", "beta"),
  };
  mkdirSync(fixture.outside, { recursive: true });
  write(join(fixture.outside, ".roll", "backlog.md"), "POISON: cwd is not authority\n");
  workspace(fixture.alpha, "alpha", "Alpha", "US-SHARED-1");
  workspace(fixture.beta, "beta", "Beta", "US-SHARED-1");
  return fixture;
}

export function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      hash.update(path.slice(root.length));
      if (entry.isDirectory()) walk(path);
      else {
        hash.update(String(statSync(path).mode));
        hash.update(readFileSync(path));
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}
