import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  normalizeRepositoryRemote,
  repositoryIdFromRemote,
} from "@roll/spec";
import { afterEach, describe, expect, it } from "vitest";
import { rawGit, type GitResult } from "../src/git.js";
import {
  WORKSPACE_REGISTRY_V1,
  serializeWorkspaceRegistry,
} from "../src/workspace-registry.js";
import {
  collectHistoricalMigrationFacts,
  type HistoricalMigrationGitRunner,
} from "../src/workspace/migration-facts.js";

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-workspace-migration-"));
  sandboxes.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function seedRepository(root: string, trackedRoll = false): { repo: string; remote: string; author: string } {
  const author = join(root, "author");
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  mkdirSync(author, { recursive: true });
  git(author, ["init", "-q", "-b", "main"]);
  git(author, ["config", "user.email", "roll@example.test"]);
  git(author, ["config", "user.name", "Roll Test"]);
  writeFileSync(join(author, ".gitignore"), trackedRoll ? "" : ".roll/\n", "utf8");
  writeFileSync(join(author, "README.md"), "seed\n", "utf8");
  if (trackedRoll) {
    mkdirSync(join(author, ".roll"), { recursive: true });
    writeFileSync(join(author, ".roll", "backlog.md"), "# Backlog\n", "utf8");
  }
  git(author, ["add", "."]);
  git(author, ["commit", "-q", "-m", "seed"]);
  git(root, ["clone", "-q", "--bare", author, remote]);
  git(root, ["clone", "-q", `file://${remote}`, repo]);
  git(repo, ["config", "user.email", "roll@example.test"]);
  git(repo, ["config", "user.name", "Roll Test"]);
  return { repo, remote, author };
}

function digestTree(root: string): string {
  const hash = createHash("sha256");
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const token = relative(root, path).replaceAll("\\", "/");
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${token}\0${readlinkSync(path)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`dir\0${token}\0`);
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    hash.update(`file\0${token}\0`);
    hash.update(readFileSync(path));
    hash.update("\0");
  };
  visit(root);
  return hash.digest("hex");
}

function recordingRunner(calls: string[][]): HistoricalMigrationGitRunner {
  return async (args, cwd): Promise<GitResult> => {
    calls.push([...args]);
    return rawGit(args, cwd);
  };
}

describe("historical Workspace migration fact collection", () => {
  it("collects deterministic ready facts without changing source or ROLL_HOME bytes", async () => {
    const root = sandbox();
    const { repo } = seedRepository(root);
    const rollHome = join(root, "roll-home");
    mkdirSync(join(repo, ".roll", "features", "US-1"), { recursive: true });
    mkdirSync(join(repo, ".roll", "domain"), { recursive: true });
    mkdirSync(join(repo, ".roll", "loop"), { recursive: true });
    writeFileSync(join(repo, ".roll", "backlog.md"), "# Backlog\n", "utf8");
    writeFileSync(join(repo, ".roll", "features", "US-1", "spec.md"), "# Story\n", "utf8");
    writeFileSync(join(repo, ".roll", "features", "US-1", "evidence.json"), "{}\n", "utf8");
    writeFileSync(join(repo, ".roll", "domain", "context-map.md"), "# Context\n", "utf8");
    writeFileSync(join(repo, ".roll", "loop", "runs.jsonl"), "", "utf8");
    mkdirSync(rollHome, { recursive: true });
    const beforeSource = digestTree(repo);
    const beforeHome = digestTree(rollHome);
    const calls: string[][] = [];

    const first = await collectHistoricalMigrationFacts({
      sourceRoot: repo,
      rollHome,
      runGit: recordingRunner(calls),
    });
    const second = await collectHistoricalMigrationFacts({
      sourceRoot: repo,
      rollHome,
      runGit: recordingRunner(calls),
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: "roll.workspace-migration-facts/v1",
      sourceRoot: realpathSync(repo),
      git: { state: "clean", operation: "none", remote: { kind: "verified", defaultBranch: "main" } },
      linkedWorktrees: [],
      submodules: [],
      runtime: { activeCycleIds: [], activeStoryLeases: [] },
      rollOwnership: { kind: "ordinary" },
      cache: { status: "absent" },
      registry: { status: "available" },
    });
    expect(first.rollInventory.map((entry) => entry.kind === "file"
      ? [entry.path, entry.sourceClass, entry.storyId ?? null]
      : [entry.path, entry.kind, null])).toEqual([
      ["backlog.md", "backlog", null],
      ["domain/context-map.md", "design", null],
      ["features/US-1/evidence.json", "story_evidence", "US-1"],
      ["features/US-1/spec.md", "story_contract", "US-1"],
      ["loop/runs.jsonl", "runtime", null],
    ]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((args) => args[0] === "--no-optional-locks")).toBe(true);
    expect(calls.flat()).not.toContain("fetch");
    expect(calls.flat()).not.toContain("prune");
    expect(digestTree(repo)).toBe(beforeSource);
    expect(digestTree(rollHome)).toBe(beforeHome);
  });

  it("blocks when the authoritative remote tip is not present in the local object database", async () => {
    const root = sandbox();
    const { repo, remote, author } = seedRepository(root);
    const rollHome = join(root, "roll-home");
    mkdirSync(rollHome, { recursive: true });
    writeFileSync(join(author, "README.md"), "remote-only\n", "utf8");
    git(author, ["add", "README.md"]);
    git(author, ["commit", "-q", "-m", "remote only"]);
    git(author, ["push", "-q", remote, "HEAD:refs/heads/main"]);

    const beforeSource = digestTree(repo);
    const beforeHome = digestTree(rollHome);
    const facts = await collectHistoricalMigrationFacts({ sourceRoot: repo, rollHome });

    expect(facts.git.remote).toMatchObject({
      kind: "blocked",
      code: "remote_truth_unverifiable",
      defaultBranch: "main",
      defaultTip: git(author, ["rev-parse", "HEAD"]),
    });
    expect(digestTree(repo)).toBe(beforeSource);
    expect(digestTree(rollHome)).toBe(beforeHome);
  });

  it("inventories symlinks with lstat without following or hashing target content", async () => {
    const root = sandbox();
    const { repo } = seedRepository(root);
    const secret = join(root, "secret.txt");
    const rollHome = join(root, "roll-home");
    mkdirSync(join(repo, ".roll"), { recursive: true });
    mkdirSync(rollHome, { recursive: true });
    writeFileSync(secret, "must-not-be-read\n", "utf8");
    symlinkSync(secret, join(repo, ".roll", "external"));
    const beforeSource = digestTree(repo);
    const beforeHome = digestTree(rollHome);

    const facts = await collectHistoricalMigrationFacts({ sourceRoot: repo, rollHome });

    expect(facts.rollInventory).toEqual([{ kind: "symlink", path: "external", target: secret }]);
    expect(JSON.stringify(facts.rollInventory)).not.toContain(createHash("sha256").update("must-not-be-read\n").digest("hex"));
    expect(digestTree(repo)).toBe(beforeSource);
    expect(digestTree(rollHome)).toBe(beforeHome);
  });

  it("does not traverse a symlink used as the .roll root", async () => {
    const root = sandbox();
    const { repo } = seedRepository(root);
    const rollHome = join(root, "roll-home");
    const external = join(root, "external-roll");
    mkdirSync(join(external, ".git"), { recursive: true });
    mkdirSync(join(external, "loop", "locks"), { recursive: true });
    writeFileSync(join(external, "secret.txt"), "must-not-be-hashed\n", "utf8");
    writeFileSync(join(external, "loop", "inner.lock"), "cycle-secret owner\n", "utf8");
    writeFileSync(join(external, "loop", "locks", "story-leases.json"), `${JSON.stringify({
      "US-SECRET": { source: "cycle", pid: process.pid, claimedAt: 1 },
    })}\n`, "utf8");
    mkdirSync(rollHome, { recursive: true });
    symlinkSync(external, join(repo, ".roll"));
    const beforeSource = digestTree(repo);
    const beforeHome = digestTree(rollHome);

    const facts = await collectHistoricalMigrationFacts({ sourceRoot: repo, rollHome });

    expect(facts.rollOwnership).toEqual({ kind: "ordinary" });
    expect(facts.rollInventory).toEqual([{ kind: "symlink", path: ".", target: external }]);
    expect(facts.runtime).toEqual({ activeCycleIds: [], activeStoryLeases: [] });
    expect(JSON.stringify(facts)).not.toContain("cycle-secret");
    expect(JSON.stringify(facts)).not.toContain("US-SECRET");
    expect(JSON.stringify(facts)).not.toContain(createHash("sha256").update("must-not-be-hashed\n").digest("hex"));
    expect(digestTree(repo)).toBe(beforeSource);
    expect(digestTree(rollHome)).toBe(beforeHome);
  });

  it("reports a dangling .roll symlink instead of treating metadata as absent", async () => {
    const root = sandbox();
    const { repo } = seedRepository(root);
    const target = join(root, "missing-roll");
    const rollHome = join(root, "roll-home");
    mkdirSync(rollHome, { recursive: true });
    symlinkSync(target, join(repo, ".roll"));

    const facts = await collectHistoricalMigrationFacts({ sourceRoot: repo, rollHome });

    expect(facts.rollInventory).toEqual([{ kind: "symlink", path: ".", target }]);
  });

  it("distinguishes product-tracked metadata from an independent roll-meta repository", async () => {
    const root = sandbox();
    const tracked = seedRepository(join(root, "tracked"), true);
    const independent = seedRepository(join(root, "independent"));
    mkdirSync(join(independent.repo, ".roll"), { recursive: true });
    git(join(independent.repo, ".roll"), ["init", "-q", "-b", "main"]);
    git(join(independent.repo, ".roll"), ["config", "user.email", "roll@example.test"]);
    git(join(independent.repo, ".roll"), ["config", "user.name", "Roll Test"]);
    writeFileSync(join(independent.repo, ".roll", "backlog.md"), "# Backlog\n", "utf8");
    git(join(independent.repo, ".roll"), ["add", "backlog.md"]);
    git(join(independent.repo, ".roll"), ["commit", "-q", "-m", "meta"]);
    const metaRemote = join(root, "meta.git");
    git(root, ["init", "-q", "--bare", metaRemote]);
    git(join(independent.repo, ".roll"), ["remote", "add", "origin", `file://${metaRemote}`]);
    const trackedHome = join(root, "roll-home-tracked");
    const independentHome = join(root, "roll-home-independent");
    mkdirSync(trackedHome, { recursive: true });
    mkdirSync(independentHome, { recursive: true });
    const beforeTracked = digestTree(tracked.repo);
    const beforeIndependent = digestTree(independent.repo);
    const beforeTrackedHome = digestTree(trackedHome);
    const beforeIndependentHome = digestTree(independentHome);

    const trackedFacts = await collectHistoricalMigrationFacts({
      sourceRoot: tracked.repo,
      rollHome: trackedHome,
    });
    const independentCalls: Array<{ readonly args: readonly string[]; readonly cwd?: string }> = [];
    const independentFacts = await collectHistoricalMigrationFacts({
      sourceRoot: independent.repo,
      rollHome: independentHome,
      runGit: async (args, cwd) => {
        independentCalls.push({ args, ...(cwd === undefined ? {} : { cwd }) });
        return rawGit(args, cwd);
      },
    });

    expect(trackedFacts.rollOwnership).toEqual({ kind: "product_tracked", trackedPaths: ["backlog.md"] });
    expect(independentFacts.rollOwnership).toMatchObject({
      kind: "independent_git",
      state: "clean",
      branch: "main",
      upstream: null,
      normalizedRemote: normalizeRepositoryRemote(`file://${metaRemote}`).ok
        ? normalizeRepositoryRemote(`file://${metaRemote}`).value
        : null,
    });
    expect(independentFacts.rollInventory.map((entry) => entry.path)).toEqual(["backlog.md"]);
    expect(independentFacts.rollInventory.some((entry) => entry.path.startsWith(".git"))).toBe(false);
    expect(independentCalls.some((call) =>
      call.cwd === join(independent.repo, ".roll") && call.args.includes("ls-remote"))).toBe(false);
    expect(digestTree(tracked.repo)).toBe(beforeTracked);
    expect(digestTree(independent.repo)).toBe(beforeIndependent);
    expect(digestTree(trackedHome)).toBe(beforeTrackedHome);
    expect(digestTree(independentHome)).toBe(beforeIndependentHome);
  });

  it("collects linked worktree, recursive submodule, active runtime, cache and registry facts", async () => {
    const root = sandbox();
    const { repo, remote } = seedRepository(root);
    const moduleRoot = join(root, "module");
    const moduleRemote = join(root, "module.git");
    mkdirSync(moduleRoot, { recursive: true });
    git(moduleRoot, ["init", "-q", "-b", "main"]);
    git(moduleRoot, ["config", "user.email", "roll@example.test"]);
    git(moduleRoot, ["config", "user.name", "Roll Test"]);
    writeFileSync(join(moduleRoot, "module.txt"), "module\n", "utf8");
    git(moduleRoot, ["add", "module.txt"]);
    git(moduleRoot, ["commit", "-q", "-m", "module"]);
    git(root, ["clone", "-q", "--bare", moduleRoot, moduleRemote]);
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", `file://${moduleRemote}`, "modules/sample module"]);
    git(repo, ["commit", "-q", "-am", "add submodule"]);
    git(repo, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const linked = join(root, "linked");
    git(repo, ["worktree", "add", "-q", "-b", "topic", linked]);

    mkdirSync(join(repo, ".roll", "loop", "locks"), { recursive: true });
    mkdirSync(join(repo, ".roll", "loop", "inner.lock"), { recursive: true });
    writeFileSync(join(repo, ".roll", "loop", "inner.lock", "meta.json"), `${JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      startedAt: 1,
      cycleId: "cycle-live",
    })}\n`, "utf8");
    mkdirSync(join(repo, ".roll", "loop", "cycle.lock"), { recursive: true });
    writeFileSync(join(repo, ".roll", "loop", "cycle.lock", "meta.json"), `${JSON.stringify({
      pid: 999_999_999,
      hostname: hostname(),
      startedAt: 1,
      cycleId: "cycle-stale",
    })}\n`, "utf8");
    writeFileSync(join(repo, ".roll", "loop", "locks", "story-leases.json"), `${JSON.stringify({
      "US-LIVE": { source: "cycle", pid: process.pid, claimedAt: 1 },
      "US-DEAD": { source: "cycle", pid: 999_999_999, claimedAt: 1 },
    })}\n`, "utf8");

    const transportRemote = `file://${remote}`;
    const normalized = normalizeRepositoryRemote(transportRemote);
    const repositoryId = repositoryIdFromRemote(transportRemote);
    if (!normalized.ok || !repositoryId.ok) throw new Error("test remote must be valid");
    const rollHome = join(root, "roll-home");
    const cachePath = join(rollHome, "repos", `${repositoryId.value}.git`);
    mkdirSync(join(rollHome, "repos"), { recursive: true });
    git(join(rollHome, "repos"), ["clone", "-q", "--bare", transportRemote, cachePath]);
    writeFileSync(join(rollHome, "repos", `${repositoryId.value}.json`), `${JSON.stringify({
      schema: "roll.repository-cache-identity/v1",
      repoId: repositoryId.value,
      remote: normalized.value,
      cachePath,
    })}\n`, "utf8");
    const workspaceRoot = join(rollHome, "workspaces", "ws-existing");
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, "workspace.yaml"), `${JSON.stringify({
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId: "ws-existing",
      displayName: "Existing",
      requirements: [],
      repositories: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: repositoryId.value,
        alias: "primary",
        remote: normalized.value,
        integrationBranch: "main",
        provider: "generic",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      }],
    })}\n`, "utf8");
    writeFileSync(join(rollHome, "workspaces.json"), serializeWorkspaceRegistry({
      schema: WORKSPACE_REGISTRY_V1,
      revision: 1,
      entries: [{
        workspaceId: "ws-existing",
        root: workspaceRoot,
        canonicalRoot: realpathSync(workspaceRoot),
        pathState: "valid",
      }],
    }), "utf8");
    const beforeSource = digestTree(repo);
    const beforeHome = digestTree(rollHome);

    const facts = await collectHistoricalMigrationFacts({
      sourceRoot: repo,
      rollHome,
      requestedWorkspaceId: "ws-existing",
    });

    expect(facts.linkedWorktrees).toEqual([{
      pathToken: "branch-topic",
      head: git(linked, ["rev-parse", "HEAD"]),
      state: "clean",
    }]);
    expect(facts.submodules).toMatchObject([{
      path: "modules/sample module",
      head: git(join(repo, "modules", "sample module"), ["rev-parse", "HEAD"]),
      state: "clean",
      remote: { kind: "verified", defaultBranch: "main" },
    }]);
    expect(facts.runtime).toEqual({ activeCycleIds: ["cycle-live"], activeStoryLeases: ["US-LIVE"] });
    expect(facts.cache).toEqual({ status: "matching", repoId: repositoryId.value, cachePath: `repos/${repositoryId.value}.git` });
    expect(facts.registry).toEqual({ status: "same_workspace", workspaceId: "ws-existing" });
    expect(digestTree(repo)).toBe(beforeSource);
    expect(digestTree(rollHome)).toBe(beforeHome);
  });
});
