import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPOSITORY_BINDING_V1,
  repositoryIdFromRemote,
  type RepositoryBinding,
} from "@roll/spec";
import { afterAll, describe, expect, it } from "vitest";
import { ensureRepositoryCache } from "../src/repository-cache.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-repository-cache-e2e-"));
  roots.push(root);
  return root;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repositoryBinding(remote: string): RepositoryBinding {
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must be valid");
  return {
    schema: REPOSITORY_BINDING_V1,
    repoId: repoId.value,
    alias: "product",
    remote,
    integrationBranch: "integration/release",
    provider: "generic",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  };
}

describe("RepositoryCache golden path", () => {
  it("creates and refreshes a shared bare cache from an explicit integration-branch refspec", async () => {
    const fixture = tempRoot();
    const source = join(fixture, "source");
    const bare = join(fixture, "upstream.git");
    const rollHome = join(fixture, "roll-home");
    mkdirSync(source, { recursive: true });
    runGit(source, ["init", "-q", "-b", "integration/release"]);
    runGit(source, ["config", "user.email", "roll@example.test"]);
    runGit(source, ["config", "user.name", "Roll Test"]);
    writeFileSync(join(source, "product.txt"), "v1\n", "utf8");
    runGit(source, ["add", "product.txt"]);
    runGit(source, ["commit", "-q", "-m", "v1"]);
    runGit(fixture, ["clone", "-q", "--bare", source, bare]);
    const remote = `file://${bare}`;
    const binding = repositoryBinding(remote);
    const refspec = "+refs/heads/integration/release:refs/remotes/origin/integration/release";

    const created = await ensureRepositoryCache({ rollHome, binding, integrationRefspec: refspec });
    expect(created.action).toBe("created");
    expect(created.baseSha).toBe(runGit(source, ["rev-parse", "HEAD"]));
    const immutableFirstBase = created.baseSha;

    writeFileSync(join(source, "product.txt"), "v2\n", "utf8");
    runGit(source, ["add", "product.txt"]);
    runGit(source, ["commit", "-q", "-m", "v2"]);
    runGit(source, ["push", "-q", remote, "HEAD:refs/heads/integration/release"]);
    const refreshed = await ensureRepositoryCache({ rollHome, binding, integrationRefspec: refspec });

    expect(refreshed.action).toBe("reused");
    expect(refreshed.cachePath).toBe(created.cachePath);
    expect(refreshed.baseSha).toBe(runGit(source, ["rev-parse", "HEAD"]));
    expect(refreshed.baseSha).not.toBe(immutableFirstBase);
    expect(runGit(refreshed.cachePath, ["cat-file", "-t", `${immutableFirstBase}^{commit}`])).toBe("commit");
    expect(runGit(refreshed.cachePath, ["rev-parse", "refs/remotes/origin/integration/release"]))
      .toBe(refreshed.baseSha);
  });
});
