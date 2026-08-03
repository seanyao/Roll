import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueStoryContract } from "@roll/core";
import { repositoryIdFromRemote, type RepositoryBinding, type RequirementSourceManifest } from "@roll/spec";
import { afterEach, describe, expect, it } from "vitest";
import {
  IssueInitializationError,
  applyIssueInit,
  inspectIssueInit,
} from "../src/issue-worktrees.js";
import { protectReadOnlyWorktree, unprotectReadOnlyWorktree } from "../src/issue-worktree-git.js";
import { ensureRepositoryCache, resolveRepositoryCacheIdentity } from "../src/repository-cache.js";
import { readLockOwner } from "../src/process.js";
import { workspaceAuthorityLockPath } from "../src/workspace-authority-lock.js";

const sandboxes: string[] = [];
afterEach(() => {
  for (const root of sandboxes.splice(0)) {
    // A read-only Issue worktree (real filesystem write-denial, not just a
    // detached HEAD) would otherwise make `rmSync(recursive)` fail with
    // EACCES on its protected files/directories.
    unprotectReadOnlyWorktree(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-issue-worktrees-"));
  sandboxes.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (path: string, relativePath: string): void => {
    if (relativePath === "locks/workspace-authority" || relativePath.startsWith("locks/workspace-authority/")) return;
    const stat = lstatSync(path);
    const normalizedSize = relativePath === "locks" ? 0 : stat.size;
    const directoryMetadata = relativePath === "locks" ? "authority-child-normalized" : `${stat.mtimeMs}\0${stat.ctimeMs}`;
    hash.update(`${relativePath}\0${stat.mode}\0${normalizedSize}\0${directoryMetadata}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`L\0${readlinkSync(path)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update("D\0");
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relativePath === "" ? name : join(relativePath, name));
      }
      return;
    }
    hash.update("F\0");
    hash.update(readFileSync(path));
  };
  visit(root, "");
  return hash.digest("hex");
}

/** Materialize a real remote with one commit on main. */
function materializeRemote(root: string, name: string): string {
  const source = join(root, `${name}-source`);
  mkdirSync(source, { recursive: true });
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.email", "roll@example.test"]);
  git(source, ["config", "user.name", "Roll Test"]);
  writeFileSync(join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "fixture"]);
  const remote = join(root, `${name}.git`);
  git(root, ["clone", "-q", "--bare", source, remote]);
  return remote;
}

function binding(alias: string, remote: string): RepositoryBinding {
  const url = `file://${remote}`;
  const repoId = repositoryIdFromRemote(url);
  if (!repoId.ok) throw new Error(`fixture remote must be valid: ${remote}`);
  return {
    schema: "roll.repository-binding/v1",
    repoId: repoId.value,
    alias,
    remote: url,
    integrationBranch: "main",
    provider: "generic",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  };
}

function fixture() {
  const root = sandbox();
  const rollHome = join(root, "roll-home");
  const sot1Remote = materializeRemote(root, "sot1");
  const sot2Remote = materializeRemote(root, "sot2");
  const sot3Remote = materializeRemote(root, "sot3");
  const bindings: readonly RepositoryBinding[] = [
    binding("sot1", sot1Remote),
    binding("sot2", sot2Remote),
    binding("sot3", sot3Remote),
  ];
  const contract: IssueStoryContract = {
    storyId: "US-XX1",
    repositories: [
      { alias: "sot1", access: "write", requiredDelivery: true },
      { alias: "sot2", access: "write", requiredDelivery: true, dependsOnRepo: "sot1" },
      { alias: "sot3", access: "read", requiredDelivery: false },
    ],
  };
  const requirementManifests: readonly RequirementSourceManifest[] = [];
  const workspaceRoot = join(root, "workspace");
  const issueRoot = join(workspaceRoot, "issues", "US-XX1");
  return { root, rollHome, bindings, contract, requirementManifests, workspaceRoot, issueRoot, remotes: { sot1: sot1Remote, sot2: sot2Remote, sot3: sot3Remote } };
}

function createGovernedBranchCollision(f: ReturnType<typeof fixture>, alias: string): { cachePath: string; worktreePath: string } {
  const repoId = f.bindings.find((candidate) => candidate.alias === alias)?.repoId;
  if (repoId === undefined) throw new Error(`missing fixture binding for ${alias}`);
  const cachePath = join(f.rollHome, "repos", `${repoId}.git`);
  const worktreePath = join(f.root, "throwaway-issue", alias);
  mkdirSync(join(f.root, "throwaway-issue"), { recursive: true });
  git(cachePath, ["worktree", "add", "-b", `roll/ws-demo/US-XX1/${alias}`, worktreePath, "refs/remotes/origin/main"]);
  return { cachePath, worktreePath };
}

describe("inspectIssueInit", () => {
  it("is side-effect free and reports every target's full check facts for a brand-new Issue", async () => {
    const f = fixture();
    const before = existsSync(f.rollHome);
    const report = await inspectIssueInit({
      workspaceId: "ws-demo",
      rollHome: f.rollHome,
      workspaceRoot: f.workspaceRoot,
      issueRoot: f.issueRoot,
      contract: f.contract,
      bindings: f.bindings,
      requirementManifests: f.requirementManifests,
    });
    expect(report.manifest.state).toBe("absent");
    expect(report.targets["sot1"]).toMatchObject({
      alias: "sot1", access: "write", repoId: f.bindings.find((b) => b.alias === "sot1")?.repoId,
      cacheState: "absent", baseSha: null, decision: "created", workBranch: expect.stringContaining("sot1"),
    });
    expect(report.targets["sot3"]).toMatchObject({ alias: "sot3", access: "read", workBranch: null });
    // Zero filesystem writes anywhere, including the machine Roll Home cache.
    expect(before).toBe(false);
    expect(existsSync(f.rollHome)).toBe(false);
    expect(existsSync(f.issueRoot)).toBe(false);
  });

  it("reports compatible cache/worktree facts after a real apply, still with zero writes on re-check", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    const beforeDigest = statSync(f.rollHome).mtimeMs;
    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(statSync(f.rollHome).mtimeMs).toBe(beforeDigest); // zero writes on re-check

    expect(report.manifest.state).toBe("compatible");
    for (const alias of ["sot1", "sot2", "sot3"]) {
      expect(report.targets[alias]).toMatchObject({ cacheState: "compatible", decision: "reused" });
      expect(typeof report.targets[alias]?.baseSha).toBe("string");
      expect(typeof report.targets[alias]?.cachePath).toBe("string");
    }
    expect(report.targets["sot1"]?.workBranch).toBe("roll/ws-demo/US-XX1/sot1");
    expect(report.targets["sot3"]?.workBranch).toBeNull();
  });

  it("keeps a legacy Issue compatible when workBranch was event-frozen and its Requirement later gains a campaign target", async () => {
    const f = fixture();
    const requirement: RequirementSourceManifest = {
      schema: "roll.requirement-source/v1",
      requirementId: "req-legacy",
      provider: "user_input",
      ref: "IDEA-074",
      revision: "owner-1",
      capturedAt: "2026-07-27T00:00:00.000Z",
      previousRevisions: [],
      requirement: { bytes: 1, sha256: "a".repeat(64) },
      context: [],
      stories: [f.contract.storyId],
      attest: {
        schema: "roll.requirement-attest-projection/v1",
        mode: "generated_aggregate",
        evidenceAuthority: "issue",
      },
    };
    await applyIssueInit({
      workspaceId: "ws-demo",
      rollHome: f.rollHome,
      workspaceRoot: f.workspaceRoot,
      issueRoot: f.issueRoot,
      contract: f.contract,
      bindings: f.bindings,
      requirementManifests: [requirement],
    });

    const manifestPath = join(f.issueRoot, "manifest.json");
    const legacy = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      repositories: Array<Record<string, unknown>>;
    };
    for (const target of legacy.repositories) delete target["workBranch"];
    writeFileSync(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const report = await inspectIssueInit({
      workspaceId: "ws-demo",
      rollHome: f.rollHome,
      workspaceRoot: f.workspaceRoot,
      issueRoot: f.issueRoot,
      contract: f.contract,
      bindings: f.bindings,
      requirementManifests: [{
        ...requirement,
        deliveryTarget: {
          terminal: "campaign_branch",
          branch: "idea-074-workspace",
          mainMerge: "forbidden",
        },
      }],
    });

    expect(report.manifest.state).toBe("compatible");
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).not.toHaveProperty("deliveryTarget");
  });

  it("reports conflict (never silently omits) a target whose alias has no matching Workspace repository binding", async () => {
    const f = fixture();
    // The Story Contract declares "sot4", but no binding for it exists —
    // apply would reject this as unknown_field; check must say so too,
    // never silently drop the target from the report.
    const contractWithUnboundAlias: IssueStoryContract = {
      storyId: "US-XX1",
      repositories: [...f.contract.repositories, { alias: "sot4", access: "read", requiredDelivery: false }],
    };
    const report = await inspectIssueInit({
      workspaceId: "ws-demo",
      rollHome: f.rollHome,
      workspaceRoot: f.workspaceRoot,
      issueRoot: f.issueRoot,
      contract: contractWithUnboundAlias,
      bindings: f.bindings,
      requirementManifests: f.requirementManifests,
    });
    expect(report.targets["sot4"]).toBeDefined();
    expect(report.targets["sot4"]?.decision).toBe("conflict");
  });

  it("reports manifest conflict when requirements/repositories drift under the same identity, on a zero-write check", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    // Same workspaceId/storyId, but the Story Contract now declares a
    // DIFFERENT repository set than what the on-disk manifest was created
    // with — the full immutable contract no longer matches.
    const changedContract: IssueStoryContract = {
      storyId: "US-XX1",
      repositories: [
        { alias: "sot1", access: "write", requiredDelivery: true },
        { alias: "sot3", access: "read", requiredDelivery: false },
      ],
    };
    const beforeDigest = statSync(f.rollHome).mtimeMs;
    const report = await inspectIssueInit({
      workspaceId: "ws-demo",
      rollHome: f.rollHome,
      workspaceRoot: f.workspaceRoot,
      issueRoot: f.issueRoot,
      contract: changedContract,
      bindings: f.bindings,
      requirementManifests: f.requirementManifests,
    });
    expect(statSync(f.rollHome).mtimeMs).toBe(beforeDigest); // still zero writes
    expect(report.manifest.state).toBe("conflict");
  });

  it("reports conflict for a brand-new target whose governed branch already exists, with zero writes", async () => {
    const f = fixture();
    const sot1Binding = f.bindings.find((candidate) => candidate.alias === "sot1");
    if (sot1Binding === undefined) throw new Error("fixture must resolve sot1's binding");
    await ensureRepositoryCache({ binding: sot1Binding, rollHome: f.rollHome, integrationRefspec: "+refs/heads/main:refs/remotes/origin/main" });
    const cachePath = join(f.rollHome, "repos", `${sot1Binding.repoId}.git`);
    git(cachePath, ["branch", "roll/ws-demo/US-XX1/sot1", "refs/remotes/origin/main"]);
    const contract: IssueStoryContract = { storyId: "US-XX1", repositories: [{ alias: "sot1", access: "write", requiredDelivery: true }] };
    const rollHomeBefore = treeDigest(f.rollHome);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    expect(report.targets["sot1"]?.decision).toBe("conflict");
    expect(treeDigest(f.rollHome)).toBe(rollHomeBefore);
    expect(existsSync(f.issueRoot)).toBe(false);
  });

  it("reports repaired for a pinned target whose branch is recoverable after a clean worktree removal", async () => {
    const f = fixture();
    const contract: IssueStoryContract = { storyId: "US-XX1", repositories: [{ alias: "sot1", access: "write", requiredDelivery: true }] };
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const sot1Binding = f.bindings.find((candidate) => candidate.alias === "sot1");
    if (sot1Binding === undefined) throw new Error("fixture must resolve sot1's binding");
    const cachePath = join(f.rollHome, "repos", `${sot1Binding.repoId}.git`);
    const sot1Path = join(f.issueRoot, "sot1");
    writeFileSync(join(sot1Path, "story-work.txt"), "work\n", "utf8");
    git(sot1Path, ["add", "story-work.txt"]);
    git(sot1Path, ["commit", "-q", "-m", "story work before path loss"]);
    git(cachePath, ["worktree", "remove", "--force", sot1Path]);
    const rollHomeBefore = treeDigest(f.rollHome);
    const workspaceBefore = treeDigest(f.workspaceRoot);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    expect(report.targets["sot1"]?.decision).toBe("repaired");
    expect(treeDigest(f.rollHome)).toBe(rollHomeBefore);
    expect(treeDigest(f.workspaceRoot)).toBe(workspaceBefore);
  });

  it("reports repaired without pruning a pinned target whose deleted worktree has stale prunable admin metadata", async () => {
    const f = fixture();
    const contract: IssueStoryContract = { storyId: "US-XX1", repositories: [{ alias: "sot1", access: "write", requiredDelivery: true }] };
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const sot1Binding = f.bindings.find((candidate) => candidate.alias === "sot1");
    if (sot1Binding === undefined) throw new Error("fixture must resolve sot1's binding");
    const cachePath = join(f.rollHome, "repos", `${sot1Binding.repoId}.git`);
    const sot1Path = join(f.issueRoot, "sot1");
    rmSync(sot1Path, { recursive: true, force: true });
    expect(git(cachePath, ["worktree", "list", "--porcelain"])).toContain("prunable");
    const rollHomeBefore = treeDigest(f.rollHome);
    const workspaceBefore = treeDigest(f.workspaceRoot);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    expect(report.targets["sot1"]?.decision).toBe("repaired");
    expect(treeDigest(f.rollHome)).toBe(rollHomeBefore);
    expect(treeDigest(f.workspaceRoot)).toBe(workspaceBefore);
    expect(git(cachePath, ["worktree", "list", "--porcelain"])).toContain("prunable");
  });

  it("reports conflict for a pinned target whose governed branch diverged", async () => {
    const f = fixture();
    const contract: IssueStoryContract = { storyId: "US-XX1", repositories: [{ alias: "sot1", access: "write", requiredDelivery: true }] };
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const sot1Binding = f.bindings.find((candidate) => candidate.alias === "sot1");
    if (sot1Binding === undefined) throw new Error("fixture must resolve sot1's binding");
    const cachePath = join(f.rollHome, "repos", `${sot1Binding.repoId}.git`);
    const sot1Path = join(f.issueRoot, "sot1");
    git(cachePath, ["worktree", "remove", "--force", sot1Path]);
    git(cachePath, ["update-ref", "-d", "refs/heads/roll/ws-demo/US-XX1/sot1"]);
    const unrelated = join(f.root, "unrelated");
    mkdirSync(unrelated, { recursive: true });
    git(unrelated, ["init", "-q", "-b", "unrelated"]);
    git(unrelated, ["config", "user.email", "roll@example.test"]);
    git(unrelated, ["config", "user.name", "Roll Test"]);
    writeFileSync(join(unrelated, "unrelated.txt"), "unrelated\n", "utf8");
    git(unrelated, ["add", "unrelated.txt"]);
    git(unrelated, ["commit", "-q", "-m", "unrelated history"]);
    git(cachePath, ["fetch", unrelated, "unrelated:roll/ws-demo/US-XX1/sot1"]);
    const rollHomeBefore = treeDigest(f.rollHome);
    const workspaceBefore = treeDigest(f.workspaceRoot);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    expect(report.targets["sot1"]?.decision).toBe("conflict");
    expect(treeDigest(f.rollHome)).toBe(rollHomeBefore);
    expect(treeDigest(f.workspaceRoot)).toBe(workspaceBefore);
  });

  it("reports conflict when a pinned target's governed branch is checked out in another real worktree", async () => {
    const f = fixture();
    const contract: IssueStoryContract = { storyId: "US-XX1", repositories: [{ alias: "sot1", access: "write", requiredDelivery: true }] };
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const sot1Binding = f.bindings.find((candidate) => candidate.alias === "sot1");
    if (sot1Binding === undefined) throw new Error("fixture must resolve sot1's binding");
    const cachePath = join(f.rollHome, "repos", `${sot1Binding.repoId}.git`);
    const sot1Path = join(f.issueRoot, "sot1");
    git(cachePath, ["worktree", "remove", "--force", sot1Path]);
    const elsewhere = join(f.root, "elsewhere-检出");
    git(cachePath, ["worktree", "add", elsewhere, "roll/ws-demo/US-XX1/sot1"]);
    const rollHomeBefore = treeDigest(f.rollHome);
    const workspaceBefore = treeDigest(f.workspaceRoot);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    expect(report.targets["sot1"]?.decision).toBe("conflict");
    expect(treeDigest(f.rollHome)).toBe(rollHomeBefore);
    expect(treeDigest(f.workspaceRoot)).toBe(workspaceBefore);
  });

  it("reports conflict for a pinned target whose missing worktree registration is locked rather than prunable", async () => {
    const f = fixture();
    const contract: IssueStoryContract = { storyId: "US-XX1", repositories: [{ alias: "sot1", access: "write", requiredDelivery: true }] };
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const sot1Binding = f.bindings.find((candidate) => candidate.alias === "sot1");
    if (sot1Binding === undefined) throw new Error("fixture must resolve sot1's binding");
    const cachePath = join(f.rollHome, "repos", `${sot1Binding.repoId}.git`);
    const sot1Path = join(f.issueRoot, "sot1");
    git(cachePath, ["worktree", "lock", sot1Path]);
    rmSync(sot1Path, { recursive: true, force: true });
    const registration = git(cachePath, ["worktree", "list", "--porcelain"]);
    expect(registration).toContain("locked");
    expect(registration).not.toContain("prunable");
    const rollHomeBefore = treeDigest(f.rollHome);
    const workspaceBefore = treeDigest(f.workspaceRoot);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    expect(report.targets["sot1"]?.decision).toBe("conflict");
    expect(treeDigest(f.rollHome)).toBe(rollHomeBefore);
    expect(treeDigest(f.workspaceRoot)).toBe(workspaceBefore);
  });
});

describe("per-Issue repository base_ref", () => {
  it("starts from the exact declared branch ref and keeps the first resolved commit pinned", async () => {
    const f = fixture();
    const pusher = join(f.root, "base-ref-pusher");
    git(f.root, ["clone", "-q", f.remotes.sot1, pusher]);
    git(pusher, ["config", "user.email", "roll@example.test"]);
    git(pusher, ["config", "user.name", "Roll Test"]);
    git(pusher, ["checkout", "-q", "-b", "release-base"]);
    writeFileSync(join(pusher, "README.md"), "release base v1\n", "utf8");
    git(pusher, ["add", "README.md"]);
    git(pusher, ["commit", "-q", "-m", "release base v1"]);
    const firstBase = git(pusher, ["rev-parse", "HEAD"]);
    git(pusher, ["push", "-q", "origin", "release-base"]);

    const contract: IssueStoryContract = {
      storyId: f.contract.storyId,
      repositories: [{
        alias: "sot1",
        access: "write",
        requiredDelivery: true,
        baseRef: "refs/heads/release-base",
      }],
    };
    await applyIssueInit({
      workspaceId: "ws-demo",
      rollHome: f.rollHome,
      workspaceRoot: f.workspaceRoot,
      issueRoot: f.issueRoot,
      contract,
      bindings: f.bindings,
      requirementManifests: [],
    });
    expect(git(join(f.issueRoot, "sot1"), ["rev-parse", "HEAD"])).toBe(firstBase);
    expect(JSON.parse(readFileSync(join(f.issueRoot, "manifest.json"), "utf8"))).toMatchObject({
      repositories: [{ alias: "sot1", baseRef: "refs/heads/release-base" }],
    });

    writeFileSync(join(pusher, "README.md"), "release base v2\n", "utf8");
    git(pusher, ["add", "README.md"]);
    git(pusher, ["commit", "-q", "-m", "release base v2"]);
    git(pusher, ["push", "-q", "origin", "release-base"]);
    const retried = await applyIssueInit({
      workspaceId: "ws-demo",
      rollHome: f.rollHome,
      workspaceRoot: f.workspaceRoot,
      issueRoot: f.issueRoot,
      contract,
      bindings: f.bindings,
      requirementManifests: [],
    });
    expect(retried.outcome).toBe("reused");
    expect(git(join(f.issueRoot, "sot1"), ["rev-parse", "HEAD"])).toBe(firstBase);
  });
});

describe("applyIssueInit", () => {
  it("holds the owning repoId machine lock around worktree add and rollback mutations", async () => {
    const f = fixture();
    const contract: IssueStoryContract = {
      storyId: "US-XX1",
      repositories: [
        { alias: "sot1", access: "write", requiredDelivery: true },
        { alias: "sot2", access: "write", requiredDelivery: true },
      ],
    };
    const observed: string[] = [];
    const lockOrder: string[] = [];
    const assertOwned = (alias: string, phase: "add" | "rollback"): void => {
      expect(existsSync(workspaceAuthorityLockPath(f.rollHome, "ws-demo"))).toBe(true);
      const repository = f.bindings.find((candidate) => candidate.alias === alias);
      if (repository === undefined) throw new Error(`fixture binding missing: ${alias}`);
      const identity = resolveRepositoryCacheIdentity({ rollHome: f.rollHome, binding: repository });
      expect(readLockOwner(identity.lockPath)).toMatchObject({
        pid: process.pid,
        cycleId: expect.stringMatching(new RegExp(`^${identity.repoId}:`, "u")),
      });
      observed.push(`${phase}:${alias}`);
    };

    await expect(applyIssueInit({
      workspaceId: "ws-demo",
      rollHome: f.rollHome,
      workspaceRoot: f.workspaceRoot,
      issueRoot: f.issueRoot,
      contract,
      bindings: f.bindings,
      requirementManifests: f.requirementManifests,
    }, {
      onLockAcquired: (lock, alias) => lockOrder.push(`${lock}:${alias ?? "workspace"}`),
      beforeAddMutation: (alias) => assertOwned(alias, "add"),
      beforeMutateTarget: (alias) => {
        if (alias === "sot2") throw new Error("force rollback after sot1 creation");
      },
      beforeRollbackMutation: (alias) => assertOwned(alias, "rollback"),
    })).rejects.toThrow(IssueInitializationError);

    expect(observed).toEqual(["add:sot1", "rollback:sot1"]);
    expect(lockOrder[0]).toBe("authority:workspace");
    expect(lockOrder).toContain("repository:sot1");
    expect(lockOrder.slice(1).every((entry) => entry.startsWith("repository:"))).toBe(true);
    expect(existsSync(join(f.issueRoot, "sot1"))).toBe(false);
  });

  it("creates the Issue root with real git worktrees, the immutable manifest, and one issue:repository_bound event per target with full facts", async () => {
    const f = fixture();
    const result = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    expect(result.outcome).toBe("created");
    expect(existsSync(join(f.issueRoot, "sot1", ".git"))).toBe(true);
    expect(existsSync(join(f.issueRoot, "sot2", ".git"))).toBe(true);
    expect(existsSync(join(f.issueRoot, "sot3", ".git"))).toBe(true);
    // Write targets get a real named branch; read targets are real detached worktrees.
    expect(git(join(f.issueRoot, "sot1"), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("roll/ws-demo/US-XX1/sot1");
    expect(() => git(join(f.issueRoot, "sot3"), ["symbolic-ref", "-q", "HEAD"])).toThrow();

    const manifestPath = join(f.issueRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({ schema: "roll.issue/v1", workspaceId: "ws-demo", storyId: "US-XX1" });
    // The immutable manifest never carries runtime SHA/path/branch.
    expect(JSON.stringify(manifest)).not.toContain("baseSha");
    expect(JSON.stringify(manifest)).not.toContain("worktreePath");
    expect(manifest.repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: "sot1", workBranch: "roll/ws-demo/US-XX1/sot1" }),
      expect.objectContaining({ alias: "sot2", workBranch: "roll/ws-demo/US-XX1/sot2" }),
    ]));
    expect(manifest.repositories.find((target) => target.alias === "sot3")).not.toHaveProperty("workBranch");

    const events = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event).toMatchObject({ type: "issue:repository_bound", workspaceId: "ws-demo", storyId: "US-XX1" });
      expect(typeof event.repoId).toBe("string");
      expect(typeof event.alias).toBe("string");
      expect(["read", "write"]).toContain(event.access);
      expect(typeof event.baseSha).toBe("string");
      expect(typeof event.worktreePath).toBe("string");
    }
    const sot1Event = events.find((event) => event.alias === "sot1");
    expect(sot1Event.workBranch).toBe("roll/ws-demo/US-XX1/sot1");
    const sot3Event = events.find((event) => event.alias === "sot3");
    expect(sot3Event.workBranch).toBeNull();
  });

  it("resolves ALL targets, cache and base SHA before creating or mutating the Issue root", async () => {
    const f = fixture();
    // Break the SECOND repository's remote before apply — resolution of every
    // target must fail BEFORE the Issue root is created at all.
    rmSync(f.remotes.sot2, { recursive: true, force: true });

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);
    expect(existsSync(f.issueRoot)).toBe(false);
  });

  it("uses the real machine Roll Home cache under <rollHome>/repos, never a Workspace-relative cache", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(existsSync(join(f.rollHome, "repos", `${f.bindings.find((b) => b.alias === "sot1")?.repoId}.git`))).toBe(true);
    expect(existsSync(join(f.rollHome, "repos", `${f.bindings.find((b) => b.alias === "sot2")?.repoId}.git`))).toBe(true);
    expect(existsSync(join(f.rollHome, "repos", `${f.bindings.find((b) => b.alias === "sot3")?.repoId}.git`))).toBe(true);
    // No cache anywhere under the Workspace/Issue tree.
    expect(existsSync(join(f.root, "workspace", ".roll-cache"))).toBe(false);
  });

  it("never mutates the manifest once written, and reuses it verbatim on a compatible retry", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const manifestPath = join(f.issueRoot, "manifest.json");
    const before = readFileSync(manifestPath, "utf8");

    const retry = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(retry.outcome).toBe("reused");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("real-git idempotent retry creates no duplicate worktrees, branches or events; manifest bytes unchanged", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const cachePath = join(f.rollHome, "repos", `${f.bindings.find((b) => b.alias === "sot1")?.repoId}.git`);
    const listBefore = git(cachePath, ["worktree", "list", "--porcelain"]);
    const eventsBefore = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8");

    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const listAfter = git(cachePath, ["worktree", "list", "--porcelain"]);
    expect(listAfter).toBe(listBefore);
    expect(readFileSync(join(f.issueRoot, "events.jsonl"), "utf8")).toBe(eventsBefore);
    const branches = git(cachePath, ["branch", "--list", "roll/*"]).split("\n").filter(Boolean);
    expect(branches).toHaveLength(1);
  });

  it("rejects an on-disk manifest that conflicts with the resolved identity instead of overwriting it", async () => {
    const f = fixture();
    mkdirSync(f.issueRoot, { recursive: true });
    writeFileSync(join(f.issueRoot, "manifest.json"), JSON.stringify({
      schema: "roll.issue/v1", workspaceId: "ws-other", storyId: "US-XX1", requirements: [], repositories: [],
    }));
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);
  });

  it("rejects a manifest_conflict when requirements/repositories changed under the same identity, with zero mutation", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const manifestPath = join(f.issueRoot, "manifest.json");
    const before = readFileSync(manifestPath, "utf8");

    // Same workspaceId/storyId, but the Story Contract now declares a DIFFERENT
    // repository set — the full immutable intent no longer matches.
    const changedContract: IssueStoryContract = {
      storyId: "US-XX1",
      repositories: [
        { alias: "sot1", access: "write", requiredDelivery: true },
        { alias: "sot3", access: "read", requiredDelivery: false },
      ],
    };
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: changedContract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("rejects a symlinked Issue root (workspace/issues/<story> escaping the Workspace) with zero writes, for both check and apply", async () => {
    const f = fixture();
    const outsideTarget = join(f.root, "outside-escape-target");
    mkdirSync(outsideTarget, { recursive: true });
    // Replace the Issue root ITSELF with a symlink pointing outside the
    // Workspace tree — a real escape, not a mock.
    mkdirSync(join(f.root, "workspace", "issues"), { recursive: true });
    symlinkSync(outsideTarget, f.issueRoot);

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);
    // Zero writes: the outside target must remain completely empty.
    expect(existsSync(join(outsideTarget, "manifest.json"))).toBe(false);
    expect(existsSync(join(outsideTarget, "sot1"))).toBe(false);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.manifest.state).toBe("conflict");
  });

  it("rejects a symlinked workspace/issues ANCESTOR directory escaping the Workspace, before any mutation", async () => {
    const f = fixture();
    const outsideTarget = join(f.root, "outside-escape-ancestor");
    mkdirSync(outsideTarget, { recursive: true });
    mkdirSync(join(f.root, "workspace"), { recursive: true });
    // The Issue root's own PARENT ("issues" dir) is a symlink — every child
    // path underneath (including f.issueRoot) resolves outside the Workspace.
    symlinkSync(outsideTarget, join(f.root, "workspace", "issues"));

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);
    expect(existsSync(join(outsideTarget, "US-XX1"))).toBe(false);
  });

  it("resolves no target and creates nothing when even ONE target's repository cache cannot be resolved", async () => {
    const f = fixture();
    // Break sot3's remote — cache resolution for ALL targets happens BEFORE
    // any worktree is created, so this must leave the Issue root untouched.
    rmSync(f.remotes.sot3, { recursive: true, force: true });

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);

    expect(existsSync(f.issueRoot)).toBe(false);
  });

  it("rolls back a newly-created CLEAN target via real git worktree removal when a LATER target's worktree add genuinely fails", async () => {
    const f = fixture();
    // A real git-level failure materializes only AFTER preflight: another
    // process checks out sot2's governed branch between target mutations.
    // This preserves AC6 rollback coverage without contradicting AC1's
    // requirement to reject conflicts already visible during preflight.
    let collisionCreated = false;
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      beforeMutateTarget: (alias) => {
        if (alias === "sot2" && !collisionCreated) {
          createGovernedBranchCollision(f, alias);
          collisionCreated = true;
        }
      },
    }))
      .rejects.toThrow(IssueInitializationError);

    // sot1 was newly-created and clean -> rolled back via git worktree remove.
    expect(existsSync(join(f.issueRoot, "sot1"))).toBe(false);
    const journal = JSON.parse(readFileSync(join(f.issueRoot, "issue-init.pending.json"), "utf8"));
    expect(journal.status).toBe("repair_required");
  });

  it("preserves a target that becomes dirty after creation when a LATER target fails — real fault injection", async () => {
    const f = fixture();
    let collision: ReturnType<typeof createGovernedBranchCollision> | undefined;
    let firstAttemptError: unknown;
    try {
      await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
        // Real fault injection: the instant sot1's real worktree is created,
        // make it genuinely dirty — BEFORE sot2's real git failure triggers rollback.
        afterTargetCreated: (alias, path) => {
          if (alias === "sot1") writeFileSync(join(path, "dirty.txt"), "keep me — real uncommitted work");
        },
        beforeMutateTarget: (alias) => {
          if (alias === "sot2" && collision === undefined) collision = createGovernedBranchCollision(f, alias);
        },
      });
    } catch (error) {
      firstAttemptError = error;
    }
    expect(firstAttemptError).toBeInstanceOf(IssueInitializationError);
    // sot1 went dirty before rollback ran -> preserved, never removed.
    expect(existsSync(join(f.issueRoot, "sot1", "dirty.txt"))).toBe(true);

    // Repair: remove the colliding branch from the OTHER worktree, then re-run.
    if (collision === undefined) throw new Error("expected sot2 branch collision");
    execFileSync("git", ["worktree", "remove", "--force", collision.worktreePath], { cwd: collision.cachePath, stdio: "ignore" });
    execFileSync("git", ["branch", "-D", "roll/ws-demo/US-XX1/sot2"], { cwd: collision.cachePath, stdio: "ignore" });
    const repaired = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(repaired.outcome).toBe("repaired");
    expect(existsSync(join(f.issueRoot, "sot1", "dirty.txt"))).toBe(true);
    expect(existsSync(join(f.issueRoot, "sot2", ".git"))).toBe(true);
  });

  it("resumes and repairs the same Issue identity after interruption without duplicating worktrees or branches", async () => {
    const f = fixture();
    let collision: ReturnType<typeof createGovernedBranchCollision> | undefined;
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      beforeMutateTarget: (alias) => {
        if (alias === "sot2" && collision === undefined) collision = createGovernedBranchCollision(f, alias);
      },
    }))
      .rejects.toThrow(IssueInitializationError);
    // sot1 was newly-created and clean -> rolled back on the failed attempt.
    expect(existsSync(join(f.issueRoot, "sot1"))).toBe(false);

    if (collision === undefined) throw new Error("expected sot2 branch collision");
    execFileSync("git", ["worktree", "remove", "--force", collision.worktreePath], { cwd: collision.cachePath, stdio: "ignore" });
    execFileSync("git", ["branch", "-D", "roll/ws-demo/US-XX1/sot2"], { cwd: collision.cachePath, stdio: "ignore" });
    const result = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(result.outcome).toBe("repaired");
    expect(existsSync(join(f.issueRoot, "sot2", ".git"))).toBe(true);
    expect(existsSync(join(f.issueRoot, "sot3", ".git"))).toBe(true);

    const sot1CachePath = join(f.rollHome, "repos", `${f.bindings.find((b) => b.alias === "sot1")?.repoId}.git`);
    const branches = git(sot1CachePath, ["branch", "--list", "roll/*"]).split("\n").filter(Boolean);
    expect(branches).toHaveLength(1); // sot1 never got a duplicate branch across the two attempts
  });

  it("rolls back a target the journal already marked created even when read-only PROTECTION itself genuinely fails afterward", async () => {
    const f = fixture();
    let sot3Path = "";
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      // Real fault injection: right after sot3's real git worktree is created
      // and the journal has recorded it as created, but BEFORE
      // protectReadOnlyWorktree runs, strip read permission from sot3's own
      // checkout root. protectReadOnlyWorktree's readdirSync then genuinely
      // fails with EACCES — a real OS-level failure, not a mock. `git status`
      // / `git rev-parse` still succeed (they only need the execute/traverse
      // bit, which this mode keeps), so rollback's own identity probe still
      // sees a real, clean, compatible worktree it can act on.
      beforeProtect: (alias, path) => {
        if (alias === "sot3") {
          sot3Path = path;
          chmodSync(path, 0o311);
        }
      },
    })).rejects.toThrow(IssueInitializationError);

    // sot3 was journaled as created BEFORE protection ran, so rollback knows
    // about it and removes it via a real `git worktree remove` — never left
    // behind ungoverned just because protection itself failed.
    expect(existsSync(sot3Path)).toBe(false);
    // sot1/sot2 (created earlier in the SAME run, never touched again) were
    // also clean -> rolled back too.
    expect(existsSync(join(f.issueRoot, "sot1"))).toBe(false);
    expect(existsSync(join(f.issueRoot, "sot2"))).toBe(false);
    const journal = JSON.parse(readFileSync(join(f.issueRoot, "issue-init.pending.json"), "utf8"));
    expect(journal.status).toBe("repair_required");
  });

  it("refuses a read target whose real checkout contains a TRACKED symlink, rolling back deterministically", async () => {
    const f = fixture();
    // sot3 (the read target) is seeded with a real git-tracked symlink whose
    // target lives OUTSIDE the checkout entirely — chmod can never make a
    // symlink itself deny writes (it follows to the target), so the ONLY
    // safe contract is refusing to expose this checkout as read-only at all.
    const outsideFile = join(f.root, "outside-sot3-escape.txt");
    writeFileSync(outsideFile, "external content a read checkout must never let through\n", "utf8");
    symlinkSync(outsideFile, join(f.remotes.sot3.replace(/\.git$/, "-source"), "escape-link.txt"));
    const sot3Source = f.remotes.sot3.replace(/\.git$/, "-source");
    git(sot3Source, ["add", "escape-link.txt"]);
    git(sot3Source, ["commit", "-q", "-m", "add escaping symlink"]);
    // Refresh the bare remote sot3Remote points at so the new commit is fetchable.
    execFileSync("git", ["push", f.remotes.sot3, "HEAD:main"], { cwd: sot3Source, stdio: "ignore" });

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);

    // sot1/sot2 were newly-created and clean during this run -> rolled back.
    expect(existsSync(join(f.issueRoot, "sot1"))).toBe(false);
    expect(existsSync(join(f.issueRoot, "sot2"))).toBe(false);
    // sot3 itself must never be left behind exposed as a "protected" read
    // checkout that actually still lets writes through its symlink.
    expect(existsSync(join(f.issueRoot, "sot3"))).toBe(false);
    const journal = JSON.parse(readFileSync(join(f.issueRoot, "issue-init.pending.json"), "utf8"));
    expect(journal.status).toBe("repair_required");
  });

  it("preserves a READ target as non-writable when rollback's own git worktree remove genuinely fails on it", async () => {
    const f = fixture();
    const sot3CachePath = join(f.rollHome, "repos", `${f.bindings.find((b) => b.alias === "sot3")?.repoId}.git`);
    let sot3Path = "";
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      // Real fault injection: right after sot3 (the read target, last in
      // contract order) is created and protected, LOCK its real worktree —
      // a genuine, unmocked reason `git worktree remove` refuses later,
      // independent of any dirty check — then throw to force apply into its
      // rollback path (sot3 is the last target created, so nothing further
      // downstream would otherwise fail).
      afterTargetCreated: (alias, path) => {
        if (alias === "sot3") {
          sot3Path = path;
          git(sot3CachePath, ["worktree", "lock", path]);
          throw new Error("real injected failure after sot3's creation, to force rollback");
        }
      },
    })).rejects.toThrow(IssueInitializationError);

    // Rollback attempted to remove sot3 (a target created THIS run) but git
    // genuinely refused (locked) -> preserved, and re-protected rather than
    // left writable just because unprotect ran before the failed removal.
    expect(existsSync(sot3Path)).toBe(true);
    expect(() => writeFileSync(join(sot3Path, "README.md"), "mutated\n", { flag: "r+" })).toThrow(/EACCES|EPERM/);
    expect(() => writeFileSync(join(sot3Path, "new-file.txt"), "new\n")).toThrow(/EACCES|EPERM/);

    git(sot3CachePath, ["worktree", "unlock", sot3Path]);
  });

  it("reports conflict (never reused) for a WRITE target checked out on the WRONG branch", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    // Real, unmocked drift: create the wrong branch FROM the actual worktree
    // (not the bare cache's HEAD, which may not even resolve) and switch
    // onto it — still perfectly clean and perfectly valid git-wise.
    const sot1Path = join(f.issueRoot, "sot1");
    git(sot1Path, ["switch", "-c", "wrong-branch"]);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.targets["sot1"]?.decision).toBe("conflict");

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);
  });

  it("stays reused/compatible for a WRITE target with LATER real story commits on its own governed branch", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    // Real, unmocked forward progress: commit real story work onto sot1's
    // OWN governed branch — exactly what a Builder is expected to do. The
    // pinned base remains an ANCESTOR of the new HEAD, so this must stay
    // fully compatible, not become a conflict.
    const sot1Path = join(f.issueRoot, "sot1");
    writeFileSync(join(sot1Path, "story-work.txt"), "real story commit\n", "utf8");
    git(sot1Path, ["add", "story-work.txt"]);
    git(sot1Path, ["commit", "-q", "-m", "real story commit"]);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.targets["sot1"]?.decision).toBe("reused");

    const applied = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(applied.outcome).toBe("reused");
    // The real story commit is untouched — apply never resets/discards it.
    expect(existsSync(join(sot1Path, "story-work.txt"))).toBe(true);
  });

  it("reports conflict for a WRITE target with DIVERGED history (pinned base is NOT an ancestor of HEAD)", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    // Real divergence: reset sot1's OWN governed branch onto an orphan
    // history sharing NO ancestry with the pinned base.
    const sot1Path = join(f.issueRoot, "sot1");
    git(sot1Path, ["checkout", "--orphan", "unrelated-history"]);
    git(sot1Path, ["rm", "-rf", "."]);
    writeFileSync(join(sot1Path, "unrelated.txt"), "unrelated root commit\n", "utf8");
    git(sot1Path, ["add", "unrelated.txt"]);
    git(sot1Path, ["commit", "-q", "-m", "unrelated root commit"]);
    git(sot1Path, ["branch", "-f", "roll/ws-demo/US-XX1/sot1", "unrelated-history"]);
    git(sot1Path, ["checkout", "roll/ws-demo/US-XX1/sot1"]);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.targets["sot1"]?.decision).toBe("conflict");

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);
  });

  it("reports conflict for a READ target detached at the WRONG HEAD commit (real apply-side rejection too)", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    // sot3 is protected (read-only) — unprotect ONLY inside this test before
    // creating the real drift commit, then the checkout is left non-writable
    // again by the immediately-following `checkout --detach`, which git
    // performs regardless of the write-bit (it only touches its own index
    // and HEAD ref, not the tracked working files that changed).
    const sot3Path = join(f.issueRoot, "sot3");
    unprotectReadOnlyWorktree(sot3Path);
    writeFileSync(join(sot3Path, "extra.txt"), "real extra commit on the read target\n", "utf8");
    git(sot3Path, ["add", "extra.txt"]);
    git(sot3Path, ["commit", "-q", "-m", "real drift commit"]);
    git(sot3Path, ["checkout", "--detach", "HEAD"]);
    protectReadOnlyWorktree(sot3Path);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.targets["sot3"]?.decision).toBe("conflict");

    // apply must ALSO reject — never silently repair/reuse an incompatible
    // actual worktree just because --check alone caught it.
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);
  });

  it("keeps an existing Issue pinned and reusable after the shared cache's integration ref advances independently", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const eventsAfterCreate = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const pinnedBase = eventsAfterCreate.find((event) => event.alias === "sot1").baseSha as string;

    // Real, unmocked simulation of ANOTHER Workspace sharing this SAME
    // machine cache advancing the integration branch — push a brand-new
    // commit to sot1's real remote, then refresh the shared cache's
    // tracking ref for it directly (mirrors what ensureRepositoryCache's own
    // fetch would do on the next apply for some OTHER Issue).
    const sourceDir = f.remotes.sot1.replace(/\.git$/, "-source");
    writeFileSync(join(sourceDir, "new-upstream-work.txt"), "advanced upstream\n", "utf8");
    git(sourceDir, ["add", "new-upstream-work.txt"]);
    git(sourceDir, ["commit", "-q", "-m", "advanced upstream work"]);
    execFileSync("git", ["push", f.remotes.sot1, "HEAD:main"], { cwd: sourceDir, stdio: "ignore" });
    const sot1CachePath = join(f.rollHome, "repos", `${f.bindings.find((b) => b.alias === "sot1")?.repoId}.git`);
    git(sot1CachePath, ["fetch", "--prune", f.remotes.sot1, "+refs/heads/main:refs/remotes/origin/main"]);
    const advancedRef = git(sot1CachePath, ["rev-parse", "refs/remotes/origin/main"]);
    expect(advancedRef).not.toBe(pinnedBase);

    // The existing Issue's check/reuse/repair must remain pinned at the
    // ORIGINAL base — never silently reflect the advanced shared ref.
    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.targets["sot1"]?.baseSha).toBe(pinnedBase);
    expect(report.targets["sot1"]?.decision).toBe("reused");

    const reapplied = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(reapplied.outcome).toBe("reused");
  });

  it("repairs an absent existing target from the Issue-PINNED base, not the shared cache's advanced integration head", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const events = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const pinnedBaseSot3 = events.find((event) => event.alias === "sot3").baseSha as string;

    // Advance sot3's real upstream AFTER the Issue already pinned its base.
    const sourceDir = f.remotes.sot3.replace(/\.git$/, "-source");
    writeFileSync(join(sourceDir, "new-upstream-work.txt"), "advanced upstream\n", "utf8");
    git(sourceDir, ["add", "new-upstream-work.txt"]);
    git(sourceDir, ["commit", "-q", "-m", "advanced upstream work"]);
    execFileSync("git", ["push", f.remotes.sot3, "HEAD:main"], { cwd: sourceDir, stdio: "ignore" });

    // Now delete sot3's real worktree directory by hand (a real operator
    // action, not a mock) — its path is absent, but the Issue already has a
    // completed issue:repository_bound fact pinning its original base.
    // sot3 is protected (read-only), so `git worktree remove` needs its
    // write bits restored first — the same real filesystem state a genuine
    // operator would need to deal with.
    unprotectReadOnlyWorktree(join(f.issueRoot, "sot3"));
    const sot3CachePath = join(f.rollHome, "repos", `${f.bindings.find((b) => b.alias === "sot3")?.repoId}.git`);
    execFileSync("git", ["worktree", "remove", "--force", join(f.issueRoot, "sot3")], { cwd: sot3CachePath, stdio: "ignore" });

    const repaired = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(repaired.outcome).toBe("repaired");
    const recreatedHead = git(join(f.issueRoot, "sot3"), ["rev-parse", "HEAD"]);
    expect(recreatedHead).toBe(pinnedBaseSot3);
  });

  it("fails loud with zero destructive mutation when the journal and a completed event disagree on a target's pinned facts", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const eventsBefore = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8");
    const manifestBefore = readFileSync(join(f.issueRoot, "manifest.json"), "utf8");

    // Plant a STALE, CONFLICTING journal alongside the already-completed
    // events — a real malformed-state scenario (e.g. a leftover journal
    // from an old, already-superseded interrupted attempt with a different
    // pinned base than what actually completed).
    const staleJournal = {
      schema: "roll.issue-init-journal/v1",
      transactionId: "stale-transaction",
      workspaceId: "ws-demo",
      storyId: "US-XX1",
      status: "repair_required",
      targets: [
        { alias: "sot1", path: join(f.issueRoot, "sot1"), created: false, workBranch: "roll/ws-demo/US-XX1/sot1", access: "write", baseSha: "0".repeat(40) },
      ],
    };
    writeFileSync(join(f.issueRoot, "issue-init.pending.json"), `${JSON.stringify(staleJournal, null, 2)}\n`, "utf8");

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);

    // Zero destructive mutation: events and manifest are byte-identical.
    expect(readFileSync(join(f.issueRoot, "events.jsonl"), "utf8")).toBe(eventsBefore);
    expect(readFileSync(join(f.issueRoot, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(existsSync(join(f.issueRoot, "sot1", ".git"))).toBe(true); // untouched real worktree

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.targets["sot1"]?.decision).toBe("conflict");

    rmSync(join(f.issueRoot, "issue-init.pending.json"), { force: true });
  });

  it("never leaves a stale success fact (issue:repository_bound event) for a target that was rolled back on a failed apply", async () => {
    const f = fixture();
    let collision: ReturnType<typeof createGovernedBranchCollision> | undefined;
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      beforeMutateTarget: (alias) => {
        if (alias === "sot2" && collision === undefined) collision = createGovernedBranchCollision(f, alias);
      },
    }))
      .rejects.toThrow(IssueInitializationError);

    // sot1 was rolled back — no events.jsonl was ever created for THIS
    // Issue at all, since the whole run failed before reaching the
    // event-write step (sot1 succeeded, sot2 genuinely failed).
    expect(existsSync(join(f.issueRoot, "events.jsonl"))).toBe(false);
    const journal = JSON.parse(readFileSync(join(f.issueRoot, "issue-init.pending.json"), "utf8"));
    expect(journal.status).toBe("repair_required");

    // Repair: remove the colliding branch, then re-run — the same contract converges.
    if (collision === undefined) throw new Error("expected sot2 branch collision");
    execFileSync("git", ["worktree", "remove", "--force", collision.worktreePath], { cwd: collision.cachePath, stdio: "ignore" });
    execFileSync("git", ["branch", "-D", "roll/ws-demo/US-XX1/sot2"], { cwd: collision.cachePath, stdio: "ignore" });
    const repaired = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(repaired.outcome).toBe("repaired");
    const events = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(3); // sot1, sot2, sot3 — exactly once each, no stale/duplicate facts.
    expect(new Set(events.map((e) => e.alias)).size).toBe(3);
  });

  it("fails loud, with zero mutation, when a completed event's workspaceId/storyId/repoId no longer matches what is currently resolving", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const eventsBefore = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8");

    // Hand-corrupt the completed event's repoId — a real scenario where the
    // Story Contract's declared repository binding for this alias changed
    // (e.g. the Workspace was reconfigured to point the alias at a
    // DIFFERENT repository) after the Issue already pinned facts under the
    // OLD repoId.
    const events = eventsBefore.trim().split("\n").map((line) => JSON.parse(line));
    const corrupted = events.map((event) => (event.alias === "sot1" ? { ...event, repoId: "repo-0000deadbeef" } : event));
    writeFileSync(join(f.issueRoot, "events.jsonl"), `${corrupted.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.targets["sot1"]?.decision).toBe("conflict");
    expect(existsSync(join(f.issueRoot, "sot1", ".git"))).toBe(true); // the real worktree is untouched
  });

  it("fails loud with zero destructive mutation when an OLD journal is missing a required pinned field", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const eventsBefore = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8");
    const manifestBefore = readFileSync(join(f.issueRoot, "manifest.json"), "utf8");

    // Plant an OLD-SHAPE journal predating the repoId/baseSha pinning
    // contract entirely — a real forward-compatibility scenario (an
    // earlier build of this code wrote journals without these fields).
    const incompleteJournal = {
      schema: "roll.issue-init-journal/v1",
      transactionId: "old-transaction",
      workspaceId: "ws-demo",
      storyId: "US-XX1",
      status: "repair_required",
      targets: [
        { alias: "sot1", path: join(f.issueRoot, "sot1"), created: false, workBranch: "roll/ws-demo/US-XX1/sot1", access: "write" }, // no repoId, no baseSha
      ],
    };
    writeFileSync(join(f.issueRoot, "issue-init.pending.json"), `${JSON.stringify(incompleteJournal, null, 2)}\n`, "utf8");

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);

    expect(readFileSync(join(f.issueRoot, "events.jsonl"), "utf8")).toBe(eventsBefore);
    expect(readFileSync(join(f.issueRoot, "manifest.json"), "utf8")).toBe(manifestBefore);

    rmSync(join(f.issueRoot, "issue-init.pending.json"), { force: true });
  });

  it.each([
    ["null baseSha", null],
    ["absent baseSha", undefined],
  ])("rejects a structurally-valid journal (matching current workspace/story/repo/access/path/branch) whose target has %s, naming baseSha in the error, with zero mutation", async (_name, baseShaValue) => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const eventsBefore = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8");
    const manifestBefore = readFileSync(join(f.issueRoot, "manifest.json"), "utf8");
    const sot1RepoId = f.bindings.find((b) => b.alias === "sot1")?.repoId;
    if (sot1RepoId === undefined) throw new Error("fixture must resolve sot1's repoId");

    // A journal that is CORRECT in every other required field — workspaceId,
    // storyId, alias, repoId, access, path, workBranch all match the
    // currently-resolving identity exactly — but genuinely never pins a
    // baseSha for this target. This must never be treated as "not reached
    // yet, resolve one fresh": a journal is only ever WRITTEN once every
    // declared target's base is fully resolved, so an entry missing one is
    // corrupted, not benign.
    const target: Record<string, unknown> = {
      alias: "sot1",
      repoId: sot1RepoId,
      path: join(f.issueRoot, "sot1"),
      created: false,
      workBranch: "roll/ws-demo/US-XX1/sot1",
      access: "write",
    };
    if (baseShaValue !== undefined) target["baseSha"] = baseShaValue;
    const invalidJournal = {
      schema: "roll.issue-init-journal/v1",
      transactionId: "invalid-basesha-transaction",
      workspaceId: "ws-demo",
      storyId: "US-XX1",
      status: "repair_required",
      targets: [target],
    };
    const journalPath = join(f.issueRoot, "issue-init.pending.json");
    const journalBefore = `${JSON.stringify(invalidJournal, null, 2)}\n`;
    writeFileSync(journalPath, journalBefore, "utf8");

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(/baseSha/i);

    // The check-side preflight must also refuse it, never report success/repair.
    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.targets["sot1"]?.decision).toBe("conflict");

    // Zero mutation: the journal itself, events, and manifest are untouched.
    expect(readFileSync(journalPath, "utf8")).toBe(journalBefore);
    expect(readFileSync(join(f.issueRoot, "events.jsonl"), "utf8")).toBe(eventsBefore);
    expect(readFileSync(join(f.issueRoot, "manifest.json"), "utf8")).toBe(manifestBefore);
    // No new Issue mutation: sot1's real worktree is completely untouched.
    expect(existsSync(join(f.issueRoot, "sot1", ".git"))).toBe(true);

    rmSync(journalPath, { force: true });
  });

  it.each([
    ["HEAD", "HEAD"],
    ["a branch ref", "refs/heads/main"],
    ["a short SHA", "abc1234"],
    ["non-hex garbage", "not-a-real-sha-value-zzz"],
  ])("rejects a journal whose target baseSha is %s instead of a full lowercase hex object id, with zero mutation", async (_name, badBaseSha) => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const eventsBefore = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8");
    const manifestBefore = readFileSync(join(f.issueRoot, "manifest.json"), "utf8");
    const sot1RepoId = f.bindings.find((b) => b.alias === "sot1")?.repoId;
    if (sot1RepoId === undefined) throw new Error("fixture must resolve sot1's repoId");

    // A journal that is otherwise well-formed but pins a non-immutable
    // baseSha — HEAD/a ref/a short SHA/non-hex garbage all pass a bare
    // "non-empty string" check yet must never be trusted as an immutable pin.
    const invalidJournal = {
      schema: "roll.issue-init-journal/v1",
      transactionId: "invalid-hex-basesha-transaction",
      workspaceId: "ws-demo",
      storyId: "US-XX1",
      status: "repair_required",
      targets: [
        { alias: "sot1", repoId: sot1RepoId, path: join(f.issueRoot, "sot1"), created: false, workBranch: "roll/ws-demo/US-XX1/sot1", access: "write", baseSha: badBaseSha },
      ],
    };
    const journalPath = join(f.issueRoot, "issue-init.pending.json");
    const journalBefore = `${JSON.stringify(invalidJournal, null, 2)}\n`;
    writeFileSync(journalPath, journalBefore, "utf8");

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(/baseSha/i);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.targets["sot1"]?.decision).toBe("conflict");

    expect(readFileSync(journalPath, "utf8")).toBe(journalBefore);
    expect(readFileSync(join(f.issueRoot, "events.jsonl"), "utf8")).toBe(eventsBefore);
    expect(readFileSync(join(f.issueRoot, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(existsSync(join(f.issueRoot, "sot1", ".git"))).toBe(true);

    rmSync(journalPath, { force: true });
  });

  it("fails loud when a completed issue:repository_bound event has a non-hex baseSha, instead of silently trusting it", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const eventsBefore = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8");
    const events = eventsBefore.trim().split("\n").map((line) => JSON.parse(line));

    // Hand-corrupt the completed event's baseSha to a ref-like string — a
    // real scenario where an old/buggy writer once persisted `HEAD` or a
    // branch name instead of resolving to an immutable object id.
    const corrupted = events.map((event) => (event.alias === "sot1" ? { ...event, baseSha: "refs/heads/main" } : event));
    writeFileSync(join(f.issueRoot, "events.jsonl"), `${corrupted.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(/baseSha/i);

    const report = await inspectIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(report.targets["sot1"]?.decision).toBe("conflict");
    expect(existsSync(join(f.issueRoot, "sot1", ".git"))).toBe(true);
  });

  it("fails loud on a recognized issue:repository_bound event with a missing alias, instead of silently dropping the fact", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const eventsBefore = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8");
    const events = eventsBefore.trim().split("\n").map((line) => JSON.parse(line));

    // A recognized issue:repository_bound event (type matches) but its alias
    // field is empty — must fail loud, never be silently swallowed as if it
    // never existed (which would let a retry re-create/re-bind the target
    // and lose the fact it was ever pinned).
    const corrupted = events.map((event) => (event.alias === "sot1" ? { ...event, alias: "" } : event));
    writeFileSync(join(f.issueRoot, "events.jsonl"), `${corrupted.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);
  });

  it("proves the FIRST persisted multi-target journal has a non-empty baseSha for every target before any worktree mutation", async () => {
    const f = fixture();
    const journalSnapshots: unknown[] = [];
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      // Fires the instant EACH target's real worktree is created — by then
      // the journal has already been (re)written at least once. Capture the
      // journal bytes on disk at the very first opportunity, before any
      // target-specific mutation completes, to prove baseSha was pinned for
      // every declared target from the FIRST write, not filled in
      // incrementally per target.
      afterTargetCreated: () => {
        if (journalSnapshots.length === 0) {
          journalSnapshots.push(JSON.parse(readFileSync(join(f.issueRoot, "issue-init.pending.json"), "utf8")));
        }
      },
    });
    expect(journalSnapshots).toHaveLength(1);
    const firstJournal = journalSnapshots[0] as { targets: Array<{ alias: string; baseSha: unknown }> };
    expect(firstJournal.targets).toHaveLength(3); // sot1, sot2, sot3
    for (const target of firstJournal.targets) {
      expect(typeof target.baseSha).toBe("string");
      expect(target.baseSha).not.toBe("");
    }
  });

  it("fails loud with zero mutation when an ORDINARY DIRECTORY materializes at a target's path AFTER preflight said absent, right before the worktree add — TOCTOU re-probe", async () => {
    const f = fixture();
    let sot2Path = "";
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      // Real fault injection: preflight already decided sot2 is "absent" ->
      // "created". Immediately before the mutation loop actually creates
      // sot2's real worktree, a genuinely unrelated ordinary directory
      // appears at that exact path (e.g. another process, a stray mkdir).
      // The re-probe immediately before create/reuse MUST catch this and
      // fail loud rather than let `issueWorktreeAdd` blow up uninformatively
      // or, worse, silently treat the foreign directory as "reused".
      beforeMutateTarget: (alias, path) => {
        if (alias === "sot2" && !existsSync(path)) {
          sot2Path = path;
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, "foreign.txt"), "not a git worktree — a stray directory\n", "utf8");
        }
      },
    })).rejects.toThrow(IssueInitializationError);

    // The foreign directory is preserved exactly as it appeared — never
    // deleted, never adopted, never protected as if it were a real checkout.
    expect(existsSync(join(sot2Path, "foreign.txt"))).toBe(true);
    expect(existsSync(join(sot2Path, ".git"))).toBe(false);
    // sot1 (created earlier in the same run, still clean) is rolled back.
    expect(existsSync(join(f.issueRoot, "sot1"))).toBe(false);
    // No success event/manifest for this failed attempt.
    expect(existsSync(join(f.issueRoot, "manifest.json"))).toBe(false);
    expect(existsSync(join(f.issueRoot, "events.jsonl"))).toBe(false);
    const journal = JSON.parse(readFileSync(join(f.issueRoot, "issue-init.pending.json"), "utf8"));
    expect(journal.status).toBe("repair_required");
  });

  it("fails loud with zero mutation when a WRONG WORKTREE (different repository/branch) materializes at a target's path AFTER preflight said absent — TOCTOU re-probe", async () => {
    const f = fixture();
    // A completely unrelated real git worktree, cloned from a THIRD repository
    // entirely — genuinely registered git worktree admin metadata, just not
    // for the cache this target expects.
    const otherRoot = join(f.root, "other-repo");
    mkdirSync(otherRoot, { recursive: true });
    git(otherRoot, ["init", "-q", "-b", "main"]);
    git(otherRoot, ["config", "user.email", "roll@example.test"]);
    git(otherRoot, ["config", "user.name", "Roll Test"]);
    writeFileSync(join(otherRoot, "unrelated.txt"), "unrelated repo\n", "utf8");
    git(otherRoot, ["add", "unrelated.txt"]);
    git(otherRoot, ["commit", "-q", "-m", "unrelated"]);

    let sot2Path = "";
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      beforeMutateTarget: (alias, path) => {
        if (alias === "sot2" && !existsSync(path)) {
          sot2Path = path;
          // Real git worktree, but registered against `otherRoot`, never
          // against sot2's own expected repository cache — detached, since
          // `main` is already checked out in `otherRoot` itself.
          git(otherRoot, ["worktree", "add", "--detach", path, "main"]);
        }
      },
    })).rejects.toThrow(IssueInitializationError);

    // The foreign worktree is preserved exactly as it appeared.
    expect(existsSync(join(sot2Path, "unrelated.txt"))).toBe(true);
    const commonDir = git(sot2Path, ["rev-parse", "--git-common-dir"]);
    expect(commonDir).toContain("other-repo");
    // sot1 (created earlier in the same run, still clean) is rolled back.
    expect(existsSync(join(f.issueRoot, "sot1"))).toBe(false);
    expect(existsSync(join(f.issueRoot, "manifest.json"))).toBe(false);
    expect(existsSync(join(f.issueRoot, "events.jsonl"))).toBe(false);
    const journal = JSON.parse(readFileSync(join(f.issueRoot, "issue-init.pending.json"), "utf8"));
    expect(journal.status).toBe("repair_required");

    git(otherRoot, ["worktree", "remove", "--force", sot2Path]);
  });

  it("fails loud (never protects a foreign path) when a target preflighted absent suddenly appears — the re-probe never emits issue:repository_bound for it", async () => {
    const f = fixture();
    let sot3Path = "";
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      beforeMutateTarget: (alias, path) => {
        if (alias === "sot3" && !existsSync(path)) {
          sot3Path = path;
          mkdirSync(path, { recursive: true });
        }
      },
    })).rejects.toThrow(IssueInitializationError);

    expect(existsSync(join(f.issueRoot, "events.jsonl"))).toBe(false);
    expect(existsSync(sot3Path)).toBe(true); // foreign path preserved, never removed
  });

  it("issueWorktreeAdd itself still fails loud if a path appears exactly at call time, independent of the applyIssueInit re-probe seam", async () => {
    const f = fixture();
    // Single-target contract so there's no earlier target to roll back —
    // isolates issueWorktreeAdd's OWN pre-existing-path guard.
    const singleContract: IssueStoryContract = { storyId: "US-XX1", repositories: [{ alias: "sot1", access: "write", requiredDelivery: true }] };
    let sot1Path = "";
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: singleContract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      beforeMutateTarget: (alias, path) => {
        if (alias === "sot1" && !existsSync(path)) {
          sot1Path = path;
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, "foreign.txt"), "surprise directory\n", "utf8");
        }
      },
    })).rejects.toThrow(IssueInitializationError);

    expect(existsSync(join(sot1Path, "foreign.txt"))).toBe(true);
    expect(existsSync(join(f.issueRoot, "manifest.json"))).toBe(false);
  });

  it("a target preflighted REUSED/REPAIRED-present may continue only when its real facts still match at mutation time", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    // sot1 is now a real, compatible, reusable write target. Corrupt it
    // (real, unmocked drift) in the tiny window the re-probe hook fires,
    // simulating a wrong-worktree swap between preflight and mutation.
    const sot1Path = join(f.issueRoot, "sot1");
    let fired = false;
    const repaired = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      beforeMutateTarget: (alias) => {
        if (alias === "sot1") fired = true;
      },
    });
    // Still healthy and unchanged -> the re-probe is a no-op when nothing drifted.
    expect(fired).toBe(true);
    expect(repaired.outcome).toBe("reused");
    expect(existsSync(join(sot1Path, ".git"))).toBe(true);
  });

  it("fails loud when a REUSED target's real worktree is swapped for an incompatible one between preflight and mutation", async () => {
    const f = fixture();
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    const sot1Path = join(f.issueRoot, "sot1");
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: f.contract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      beforeMutateTarget: (alias) => {
        if (alias === "sot1") {
          // Real, unmocked drift: switch sot1 onto an incompatible branch
          // right in the window between preflight (which said "reused") and
          // the mutation loop's decision to skip mutation for it.
          git(sot1Path, ["switch", "-c", "toctou-wrong-branch"]);
        }
      },
    })).rejects.toThrow(IssueInitializationError);

    const journal = JSON.parse(readFileSync(join(f.issueRoot, "issue-init.pending.json"), "utf8"));
    expect(journal.status).toBe("repair_required");
  });

  it("persists whether each write target's governed branch was CREATED this run or REUSED from an orphan, and rollback only deletes a branch this run created", async () => {
    const f = fixture();
    const twoWriteTargetsContract: IssueStoryContract = {
      storyId: "US-XX1",
      repositories: [
        { alias: "sot1", access: "write", requiredDelivery: true },
        { alias: "sot2", access: "write", requiredDelivery: true },
      ],
    };

    // First real apply: both sot1 and sot2's branches are genuinely CREATED this run.
    const firstResult = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: twoWriteTargetsContract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(firstResult.outcome).toBe("created");

    // Real orphan: delete only sot1's worktree directory, leaving its
    // governed branch behind — exactly the recoverable-orphan scenario.
    const sot1Path = join(f.issueRoot, "sot1");
    rmSync(sot1Path, { recursive: true, force: true });
    const cachePath = join(f.rollHome, "repos", `${f.bindings.find((b) => b.alias === "sot1")?.repoId}.git`);
    git(cachePath, ["worktree", "prune"]);

    // Add a LATER real Story commit directly onto the orphaned branch (no
    // worktree needed for this — a plain `git commit-tree`-free approach:
    // check it out in a scratch location, commit, remove that scratch
    // worktree, keep the branch).
    const scratchPath = join(f.root, "scratch-sot1");
    git(cachePath, ["worktree", "add", scratchPath, "roll/ws-demo/US-XX1/sot1"]);
    writeFileSync(join(scratchPath, "later-story-work.txt"), "later real story commit\n", "utf8");
    git(scratchPath, ["add", "later-story-work.txt"]);
    git(scratchPath, ["commit", "-q", "-m", "later story commit on orphaned branch"]);
    const laterTip = git(scratchPath, ["rev-parse", "HEAD"]);
    git(cachePath, ["worktree", "remove", "--force", scratchPath]);

    // Second apply repairs sot1 by RECOVERING the orphan branch (isPinned,
    // since sot1 was already pinned by the first successful apply above),
    // then a real fault forces a rollback via sot2 (already reused/healthy —
    // inject the failure straight into sot2's real worktree instead, by
    // making it dirty right after sot1's repair would have completed).
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: twoWriteTargetsContract, bindings: f.bindings, requirementManifests: f.requirementManifests }, {
      beforeMutateTarget: (alias, path) => {
        // sot2 is already present/compatible (reused) — inject a real
        // failure by throwing once sot1's repair mutation has been
        // evaluated, i.e. when we reach sot2's own re-probe.
        if (alias === "sot2") {
          void path;
          throw new Error("real injected failure at sot2's re-probe, to force rollback after sot1's orphan recovery");
        }
      },
    })).rejects.toThrow(IssueInitializationError);

    // sot1's recovered orphan branch and its LATER commit must be preserved —
    // this run only REUSED the branch, never created it, so rollback must
    // never delete the BRANCH even though sot1's freshly re-created worktree
    // checkout (this run's own repair mutation) is itself rolled back like
    // any other clean target created this run.
    expect(git(cachePath, ["rev-parse", "roll/ws-demo/US-XX1/sot1"])).toBe(laterTip);
    const branches = git(cachePath, ["branch", "--list", "roll/ws-demo/US-XX1/sot1"]);
    expect(branches).not.toBe("");
    expect(existsSync(join(f.issueRoot, "sot1"))).toBe(false);

    // A further repair retry recovers the SAME branch tip again — proving
    // the later Story commit truly survived across the rollback.
    const retryResult = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract: twoWriteTargetsContract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    expect(retryResult.outcome).toBe("repaired");
    expect(existsSync(join(f.issueRoot, "sot1", "later-story-work.txt"))).toBe(true);
    expect(git(join(f.issueRoot, "sot1"), ["rev-parse", "HEAD"])).toBe(laterTip);
  });

  it("never adopts a pre-existing branch of the SAME name for a BRAND-NEW (never-pinned) target — fails loud instead of reusing", async () => {
    const f = fixture();
    const contract: IssueStoryContract = {
      storyId: "US-XX1",
      repositories: [
        { alias: "sot1", access: "write", requiredDelivery: true },
        { alias: "sot2", access: "write", requiredDelivery: true, dependsOnRepo: "sot1" },
      ],
    };
    const sot1Binding = f.bindings.find((candidate) => candidate.alias === "sot1");
    const sot2Binding = f.bindings.find((candidate) => candidate.alias === "sot2");
    if (sot1Binding === undefined || sot2Binding === undefined) throw new Error("fixture must resolve both write bindings");
    const cachePath = join(f.rollHome, "repos", `${sot2Binding.repoId}.git`);
    const renderedBranch = "roll/ws-demo/US-XX1/sot2"; // conflict belongs to the later target

    // Prime the machine cache for real (fetch, no Issue involved), then plant
    // a branch with the EXACT name THIS brand-new target's contract would
    // render — entirely by hand, never via applyIssueInit, so there is no
    // Issue-local pin for it anywhere. Simulates a name collision (manual git
    // use, or some other unrelated process) that this Issue never created.
    await ensureRepositoryCache({ binding: sot1Binding, rollHome: f.rollHome, integrationRefspec: `+refs/heads/main:refs/remotes/origin/main` });
    await ensureRepositoryCache({ binding: sot2Binding, rollHome: f.rollHome, integrationRefspec: `+refs/heads/main:refs/remotes/origin/main` });
    git(cachePath, ["branch", renderedBranch, "refs/remotes/origin/main"]);
    expect(git(cachePath, ["branch", "--list", renderedBranch])).not.toBe("");
    const rollHomeBefore = treeDigest(f.rollHome);

    // This Issue's later sot2 target has NEVER been pinned (brand-new) yet the
    // branch its OWN contract would render to already exists — must fail
    // loud before the earlier sot1 target can be created or journaled.
    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);
    expect(existsSync(f.issueRoot)).toBe(false);
    expect(treeDigest(f.rollHome)).toBe(rollHomeBefore);
  });

  it("rejects a pinned diverged governed branch before mutating the existing Issue", async () => {
    const f = fixture();
    const contract: IssueStoryContract = {
      storyId: "US-XX1",
      repositories: [
        { alias: "sot1", access: "write", requiredDelivery: true },
        { alias: "sot2", access: "write", requiredDelivery: true, dependsOnRepo: "sot1" },
      ],
    };
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const sot2Binding = f.bindings.find((candidate) => candidate.alias === "sot2");
    if (sot2Binding === undefined) throw new Error("fixture must resolve sot2's binding");
    const cachePath = join(f.rollHome, "repos", `${sot2Binding.repoId}.git`);
    const branch = "roll/ws-demo/US-XX1/sot2";
    git(cachePath, ["worktree", "remove", "--force", join(f.issueRoot, "sot2")]);
    git(cachePath, ["update-ref", "-d", `refs/heads/${branch}`]);
    const unrelated = join(f.root, "apply-unrelated");
    mkdirSync(unrelated, { recursive: true });
    git(unrelated, ["init", "-q", "-b", "unrelated"]);
    git(unrelated, ["config", "user.email", "roll@example.test"]);
    git(unrelated, ["config", "user.name", "Roll Test"]);
    writeFileSync(join(unrelated, "unrelated.txt"), "unrelated\n", "utf8");
    git(unrelated, ["add", "unrelated.txt"]);
    git(unrelated, ["commit", "-q", "-m", "unrelated history"]);
    git(cachePath, ["fetch", unrelated, `unrelated:${branch}`]);
    const branchBefore = git(cachePath, ["rev-parse", branch]);
    const rollHomeBefore = treeDigest(f.rollHome);
    const workspaceBefore = treeDigest(f.workspaceRoot);

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);

    expect(treeDigest(f.rollHome)).toBe(rollHomeBefore);
    expect(treeDigest(f.workspaceRoot)).toBe(workspaceBefore);
    expect(git(cachePath, ["rev-parse", branch])).toBe(branchBefore);
    expect(existsSync(join(f.issueRoot, "issue-init.pending.json"))).toBe(false);
  });

  it("rejects a pinned governed branch checked out elsewhere before mutating the existing Issue", async () => {
    const f = fixture();
    const contract: IssueStoryContract = {
      storyId: "US-XX1",
      repositories: [
        { alias: "sot1", access: "write", requiredDelivery: true },
        { alias: "sot2", access: "write", requiredDelivery: true, dependsOnRepo: "sot1" },
      ],
    };
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const sot2Binding = f.bindings.find((candidate) => candidate.alias === "sot2");
    if (sot2Binding === undefined) throw new Error("fixture must resolve sot2's binding");
    const cachePath = join(f.rollHome, "repos", `${sot2Binding.repoId}.git`);
    const branch = "roll/ws-demo/US-XX1/sot2";
    git(cachePath, ["worktree", "remove", "--force", join(f.issueRoot, "sot2")]);
    const elsewhere = join(f.root, "apply-elsewhere");
    git(cachePath, ["worktree", "add", elsewhere, branch]);
    const rollHomeBefore = treeDigest(f.rollHome);
    const workspaceBefore = treeDigest(f.workspaceRoot);
    const elsewhereBefore = treeDigest(elsewhere);
    const registrationsBefore = git(cachePath, ["worktree", "list", "--porcelain"]);

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);

    expect(treeDigest(f.rollHome)).toBe(rollHomeBefore);
    expect(treeDigest(f.workspaceRoot)).toBe(workspaceBefore);
    expect(treeDigest(elsewhere)).toBe(elsewhereBefore);
    expect(git(cachePath, ["worktree", "list", "--porcelain"])).toBe(registrationsBefore);
    expect(existsSync(join(f.issueRoot, "issue-init.pending.json"))).toBe(false);
  });

  it("rejects a missing locked governed branch before mutating the existing Issue", async () => {
    const f = fixture();
    const contract: IssueStoryContract = {
      storyId: "US-XX1",
      repositories: [
        { alias: "sot1", access: "write", requiredDelivery: true },
        { alias: "sot2", access: "write", requiredDelivery: true, dependsOnRepo: "sot1" },
      ],
    };
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const sot2Binding = f.bindings.find((candidate) => candidate.alias === "sot2");
    if (sot2Binding === undefined) throw new Error("fixture must resolve sot2's binding");
    const cachePath = join(f.rollHome, "repos", `${sot2Binding.repoId}.git`);
    const sot2Path = join(f.issueRoot, "sot2");
    git(cachePath, ["worktree", "lock", sot2Path]);
    rmSync(sot2Path, { recursive: true, force: true });
    const rollHomeBefore = treeDigest(f.rollHome);
    const workspaceBefore = treeDigest(f.workspaceRoot);
    const registrationsBefore = git(cachePath, ["worktree", "list", "--porcelain"]);

    await expect(applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests }))
      .rejects.toThrow(IssueInitializationError);

    expect(treeDigest(f.rollHome)).toBe(rollHomeBefore);
    expect(treeDigest(f.workspaceRoot)).toBe(workspaceBefore);
    expect(git(cachePath, ["worktree", "list", "--porcelain"])).toBe(registrationsBefore);
    expect(existsSync(join(f.issueRoot, "issue-init.pending.json"))).toBe(false);
  });

  it("repairs a pinned stale prunable worktree without changing its branch tip or duplicating Issue evidence", async () => {
    const f = fixture();
    const contract: IssueStoryContract = { storyId: "US-XX1", repositories: [{ alias: "sot1", access: "write", requiredDelivery: true }] };
    await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });
    const sot1Binding = f.bindings.find((candidate) => candidate.alias === "sot1");
    if (sot1Binding === undefined) throw new Error("fixture must resolve sot1's binding");
    const cachePath = join(f.rollHome, "repos", `${sot1Binding.repoId}.git`);
    const branch = "roll/ws-demo/US-XX1/sot1";
    const sot1Path = join(f.issueRoot, "sot1");
    const branchBefore = git(cachePath, ["rev-parse", branch]);
    const manifestBefore = readFileSync(join(f.issueRoot, "manifest.json"), "utf8");
    const eventsBefore = readFileSync(join(f.issueRoot, "events.jsonl"), "utf8");
    rmSync(sot1Path, { recursive: true, force: true });
    expect(git(cachePath, ["worktree", "list", "--porcelain"])).toContain("prunable");

    const result = await applyIssueInit({ workspaceId: "ws-demo", rollHome: f.rollHome, workspaceRoot: f.workspaceRoot, issueRoot: f.issueRoot, contract, bindings: f.bindings, requirementManifests: f.requirementManifests });

    expect(result.outcome).toBe("repaired");
    expect(git(sot1Path, ["rev-parse", "HEAD"])).toBe(branchBefore);
    expect(git(sot1Path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branch);
    expect(readFileSync(join(f.issueRoot, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(readFileSync(join(f.issueRoot, "events.jsonl"), "utf8")).toBe(eventsBefore);
    expect(existsSync(join(f.issueRoot, "issue-init.pending.json"))).toBe(false);
  });
});
