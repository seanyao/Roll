import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyMainCheckoutWriteProtection,
  captureMainHeadBaseline,
  checkMainDirty,
  detectMainCheckoutWriteProtectionResidue,
  quarantineMainCheckout,
  readMainDirtyBaseline,
  readMainHeadBaseline,
  recoverMainCheckoutWriteProtectionResidue,
  releaseMainCheckoutWriteProtection,
  repairCoreWorktreeContamination,
  resolveMainCheckoutGitPaths,
  withMainCheckoutWriteProtection,
  worktreeGitDiscoveryEnv,
  writeMainDirtyBaseline,
} from "../src/runner/main-checkout-guard.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sh(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function gitPath(repo: string, rel: string): string {
  return sh(repo, ["rev-parse", "--path-format=absolute", "--git-path", rel]);
}

function currentBranchRef(repo: string): string {
  return sh(repo, ["symbolic-ref", "HEAD"]);
}

function cleanRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.test"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n", "utf8");
  mkdirSync(join(repo, ".roll", "loop"), { recursive: true });
  mkdirSync(join(repo, "skills"), { recursive: true });
  writeFileSync(join(repo, "skills", "README.md"), "skill scratch\n", "utf8");
  git(repo, ["add", "tracked.txt", "skills/README.md"]);
  git(repo, ["commit", "-q", "-m", "seed"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return repo;
}

function cleanRepoWithSkillsGitlink(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.test"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-q", "-m", "seed"]);
  const gitlinkSha = sh(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-index", "--add", "--cacheinfo", "160000", gitlinkSha, "skills"]);
  git(repo, ["commit", "-q", "-m", "add skills gitlink"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return repo;
}

function worktreeFrom(repo: string): string {
  const wt = `${repo}-wt`;
  dirs.push(wt);
  git(repo, ["worktree", "add", "-q", "-b", "cycle/test", wt, "origin/main"]);
  return wt;
}

describe("main checkout guard — US-LOOP-089", () => {
  it("physically rejects builder writes to main while the cycle worktree remains writable", async () => {
    const repo = cleanRepo("roll-main-guard-");
    const wt = worktreeFrom(repo);
    const runtimeDir = join(repo, ".roll", "loop");

    const events = await withMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-phys", nowMs: () => 1000 }, async () => {
      const blocked = spawnSync(
        process.execPath,
        [
          "-e",
          [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(join(repo, "leak.txt"))}, 'blocked\\n');`,
          ].join(""),
        ],
        { encoding: "utf8" },
      );
      writeFileSync(join(wt, "worktree.txt"), "ok\n", "utf8");
      git(wt, ["add", "worktree.txt"]);
      git(wt, ["commit", "-q", "-m", "tcr: protected worktree commit"]);
      return { blockedStatus: blocked.status, blockedStderr: blocked.stderr };
    });

    expect(events.value.blockedStatus).not.toBe(0);
    expect(events.value.blockedStderr).toMatch(/EACCES|EPERM|permission denied/i);
    expect(existsSync(join(repo, "leak.txt"))).toBe(false);
    expect(readFileSync(join(wt, "worktree.txt"), "utf8")).toBe("ok\n");
    expect(sh(wt, ["log", "-1", "--format=%s"])).toBe("tcr: protected worktree commit");
    expect(events.events.map((e) => e.status)).toEqual(["applied", "released"]);
    expect(sh(repo, ["status", "--short"])).toBe("");
  });

  it("recovers a stale write-protection marker on the next cycle", async () => {
    const repo = cleanRepo("roll-main-guard-stale-");
    const runtimeDir = join(repo, ".roll", "loop");
    const protectedFile = join(repo, "tracked.txt");
    const originalMode = statSync(protectedFile).mode & 0o777;

    const applied = applyMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-crash", nowMs: () => 1000 });
    expect(applied.status).toBe("applied");
    expect(() => writeFileSync(protectedFile, "blocked\n", "utf8")).toThrow();

    const recovered = applyMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-next", nowMs: () => 2000 });
    expect(recovered.status).toBe("recovered");
    releaseMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-next", nowMs: () => 3000 });

    writeFileSync(protectedFile, "restored\n", "utf8");
    expect(readFileSync(protectedFile, "utf8")).toBe("restored\n");
    expect(statSync(protectedFile).mode & 0o777).toBe(originalMode);
  });

  it("protects git-visible files and skips gitignored directories", async () => {
    const repo = cleanRepo("roll-main-guard-ignored-");
    const runtimeDir = join(repo, ".roll", "loop");
    writeFileSync(join(repo, ".gitignore"), "ignored-build/\n", "utf8");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-q", "-m", "ignore build output"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "new file.ts"), "export const value = 1;\n", "utf8");
    mkdirSync(join(repo, "ignored-build", "deep"), { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      writeFileSync(join(repo, "ignored-build", "deep", `artifact-${i}.txt`), "ignored\n", "utf8");
    }

    try {
      applyMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-ignore", nowMs: () => 1000 });
      const marker = JSON.parse(readFileSync(join(runtimeDir, "main-checkout-protection.json"), "utf8"));
      const protectedRels = (marker.entries as Array<{ path: string }>).map((entry) => (entry.path === repo ? "." : entry.path.slice(repo.length + 1)));

      expect(protectedRels).toContain(".");
      expect(protectedRels).toContain(".gitignore");
      expect(protectedRels).toContain("tracked.txt");
      expect(protectedRels).toContain("src");
      expect(protectedRels).toContain("src/new file.ts");
      expect(protectedRels.some((rel) => rel === "ignored-build" || rel.startsWith("ignored-build/"))).toBe(false);
      writeFileSync(join(repo, "ignored-build", "deep", "still-writable.txt"), "cache\n", "utf8");
    } finally {
      releaseMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-ignore", nowMs: () => 2000 });
    }
  });

  it("quarantines dirty product files into a rescue ref, leaves .roll/skills alone, and restores clean main", async () => {
    const repo = cleanRepo("roll-main-quarantine-dirty-");
    const runtimeDir = join(repo, ".roll", "loop");
    writeFileSync(join(repo, "tracked.txt"), "leaked tracked\n", "utf8");
    writeFileSync(join(repo, "untracked.txt"), "leaked untracked\n", "utf8");
    writeFileSync(join(repo, ".roll", "loop", "events.ndjson"), "owner runtime\n", "utf8");
    writeFileSync(join(repo, "skills", "scratch.txt"), "skill scratch\n", "utf8");

    const results = await quarantineMainCheckout({
      repoCwd: repo,
      runtimeDir,
      cycleId: "C-dirty",
      storyId: "US-LOOP-089",
      phase: "pre-spawn",
      nowMs: () => 1_000,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ reason: "dirty", cycleId: "C-dirty" });
    expect(results[0]?.files).toEqual(["tracked.txt", "untracked.txt"]);
    expect(sh(repo, ["status", "--porcelain", "--", "tracked.txt", "untracked.txt"])).toBe("");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(repo, ".roll", "loop", "events.ndjson"), "utf8")).toBe("owner runtime\n");
    expect(readFileSync(join(repo, "skills", "scratch.txt"), "utf8")).toBe("skill scratch\n");
    expect(sh(repo, ["rev-parse", results[0]!.ref])).toMatch(/^[0-9a-f]{40}$/);
    const manifest = JSON.parse(readFileSync(results[0]!.manifestPath, "utf8"));
    expect(manifest.restoreCommand).toContain(`git stash apply ${results[0]!.ref}`);
    expect(manifest.files).toEqual(["tracked.txt", "untracked.txt"]);
  });

  it("FIX-1228: restores private agent timestamp state without quarantining the story", async () => {
    const repo = cleanRepo("roll-main-private-state-");
    const runtimeDir = join(repo, ".roll", "loop");
    mkdirSync(join(repo, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".pi", "workflows", "index.json"), JSON.stringify({ schemaVersion: 1, updatedAt: "2026-07-05T16:06:15.979Z", runs: [] }, null, 2) + "\n");
    git(repo, ["add", ".pi/workflows/index.json"]);
    git(repo, ["commit", "-q", "-m", "seed pi state"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    writeFileSync(join(repo, ".pi", "workflows", "index.json"), JSON.stringify({ schemaVersion: 1, updatedAt: "2026-07-06T14:59:22.574Z", runs: [] }, null, 2) + "\n");

    const results = await quarantineMainCheckout({
      repoCwd: repo,
      runtimeDir,
      cycleId: "C-private-state",
      storyId: "US-LOOP-091",
      phase: "pre-spawn",
      nowMs: () => 1_500,
    });

    expect(results).toEqual([]);
    expect(sh(repo, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(repo, ".pi", "workflows", "index.json"), "utf8")).toContain("2026-07-05T16:06:15.979Z");
  });

  it("FIX-1228: still quarantines real product dirt after restoring private agent timestamp state", async () => {
    const repo = cleanRepo("roll-main-private-plus-product-");
    const runtimeDir = join(repo, ".roll", "loop");
    mkdirSync(join(repo, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".pi", "workflows", "index.json"), JSON.stringify({ schemaVersion: 1, updatedAt: "2026-07-05T16:06:15.979Z", runs: [] }, null, 2) + "\n");
    git(repo, ["add", ".pi/workflows/index.json"]);
    git(repo, ["commit", "-q", "-m", "seed pi state"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    writeFileSync(join(repo, ".pi", "workflows", "index.json"), JSON.stringify({ schemaVersion: 1, updatedAt: "2026-07-06T14:59:22.574Z", runs: [] }, null, 2) + "\n");
    writeFileSync(join(repo, "tracked.txt"), "real leak\n", "utf8");

    const results = await quarantineMainCheckout({
      repoCwd: repo,
      runtimeDir,
      cycleId: "C-private-plus-product",
      storyId: "US-LOOP-091",
      phase: "pre-spawn",
      nowMs: () => 1_600,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.files).toEqual(["tracked.txt"]);
    expect(sh(repo, ["status", "--porcelain", "--", "tracked.txt", ".pi/workflows/index.json"])).toBe("");
    expect(readFileSync(join(repo, ".pi", "workflows", "index.json"), "utf8")).toContain("2026-07-05T16:06:15.979Z");
  });

  it("FIX-1475: a mid-cycle ahead LEAK (no pre-spawn baseline) is bookmarked + reported, but main is NEVER reset", async () => {
    const repo = cleanRepo("roll-main-quarantine-ahead-");
    const runtimeDir = join(repo, ".roll", "loop");
    const originHead = sh(repo, ["rev-parse", "origin/main"]);
    writeFileSync(join(repo, "tracked.txt"), "ahead commit\n", "utf8");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-q", "-m", "leaked main commit"]);
    const leakedHead = sh(repo, ["rev-parse", "HEAD"]);

    const results = await quarantineMainCheckout({
      repoCwd: repo,
      runtimeDir,
      cycleId: "C-ahead",
      storyId: "US-LOOP-089",
      phase: "post-cycle",
      nowMs: () => 2_000,
    });

    // Detection + audit trail are unchanged: quarantine event, bookmark ref, manifest.
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ reason: "ahead", files: ["<commit>:leaked main commit"] });
    expect(sh(repo, ["rev-parse", results[0]!.ref])).toBe(leakedHead);
    const manifest = JSON.parse(readFileSync(results[0]!.manifestPath, "utf8"));
    expect(manifest.restoreCommand).toContain("main was NOT moved");
    // FIX-1475: the shared main ref did NOT move — HEAD stays on the ahead
    // commit (byte-identical), NOT back on origin/main.
    expect(sh(repo, ["rev-parse", "HEAD"])).toBe(leakedHead);
    expect(sh(repo, ["rev-parse", "HEAD"])).not.toBe(originHead);
  });

  it("FIX-1475: pre-existing ahead commits matching the pre-spawn baseline are left byte-identically alone (no event, no ref, no reset)", async () => {
    const repo = cleanRepo("roll-main-quarantine-ahead-pre-");
    const runtimeDir = join(repo, ".roll", "loop");
    writeFileSync(join(repo, "tracked.txt"), "owner wip\n", "utf8");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-q", "-m", "owner local WIP (unpushed)"]);
    const aheadHead = sh(repo, ["rev-parse", "HEAD"]);
    // The cycle's pre-spawn hook froze THIS head as the baseline.
    captureMainHeadBaseline(repo, runtimeDir, "C-pre-ahead");

    const results = await quarantineMainCheckout({
      repoCwd: repo,
      runtimeDir,
      cycleId: "C-pre-ahead",
      storyId: "FIX-1475",
      phase: "pre-spawn",
      nowMs: () => 2_500,
    });

    expect(results).toEqual([]);
    expect(sh(repo, ["rev-parse", "HEAD"])).toBe(aheadHead);
    expect(sh(repo, ["rev-parse", "main"])).toBe(aheadHead);
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("owner wip\n");
    expect(sh(repo, ["branch", "--list", "rescue/*"])).toBe("");
  });

  it("FIX-1473: does not quarantine the configured integration branch baseline", async () => {
    const repo = cleanRepo("roll-main-configured-baseline-");
    const runtimeDir = join(repo, ".roll", "loop");
    writeFileSync(join(repo, ".roll", "local.yaml"), "integration_branch: origin/dev\n", "utf8");
    writeFileSync(join(repo, "tracked.txt"), "workspace baseline\n", "utf8");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-q", "-m", "workspace integration baseline"]);
    git(repo, ["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    const baselineHead = sh(repo, ["rev-parse", "HEAD"]);

    const results = await quarantineMainCheckout({
      repoCwd: repo,
      runtimeDir,
      cycleId: "C-configured-baseline",
      storyId: "FIX-1473",
      phase: "pre-spawn",
      nowMs: () => 2_100,
    });

    expect(results).toEqual([]);
    expect(sh(repo, ["rev-parse", "HEAD"])).toBe(baselineHead);
  });

  it("FIX-1473: quarantines only commits added after the configured integration branch", async () => {
    const repo = cleanRepo("roll-main-configured-ahead-");
    const runtimeDir = join(repo, ".roll", "loop");
    writeFileSync(join(repo, ".roll", "local.yaml"), "integration_branch: origin/dev\n", "utf8");
    writeFileSync(join(repo, "tracked.txt"), "workspace baseline\n", "utf8");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-q", "-m", "workspace integration baseline"]);
    git(repo, ["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    const baselineHead = sh(repo, ["rev-parse", "origin/dev"]);
    writeFileSync(join(repo, "tracked.txt"), "leaked after baseline\n", "utf8");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-q", "-m", "leaked configured checkout commit"]);
    const leakedHead = sh(repo, ["rev-parse", "HEAD"]);

    const results = await quarantineMainCheckout({
      repoCwd: repo,
      runtimeDir,
      cycleId: "C-configured-ahead",
      storyId: "FIX-1473",
      phase: "post-cycle",
      nowMs: () => 2_200,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      reason: "ahead",
      files: ["<commit>:leaked configured checkout commit"],
    });
    // FIX-1475: quarantine records the leaked commits but must never move the
    // shared checkout. The operator can inspect the bookmark and decide how to
    // reconcile the branch explicitly.
    expect(sh(repo, ["rev-parse", "HEAD"])).toBe(leakedHead);
    expect(sh(repo, ["rev-parse", results[0]!.ref])).toBe(leakedHead);
    expect(results[0]!.restoreCommand).toContain("main was NOT moved");
    expect(results[0]!.restoreCommand).toContain("git reset --hard origin/dev");
  });

  it("checkMainDirty ignores .roll runtime and skills submodule dirt", async () => {
    const repo = cleanRepo("roll-main-dirty-scope-");
    writeFileSync(join(repo, ".roll", "loop", "events.ndjson"), "runtime\n", "utf8");
    writeFileSync(join(repo, "skills", "scratch.txt"), "skill scratch\n", "utf8");
    writeFileSync(join(repo, "product.ts"), "leak\n", "utf8");

    await expect(checkMainDirty(repo)).resolves.toEqual(["product.ts"]);
  });

  // FIX-1218: staged (index-layer) changes in protected paths ARE included
  // because someone explicitly staged them — they must be visible in the
  // diagnostic file list and count toward the dirty boolean.
  it("FIX-1218: checkMainDirty includes staged changes in skills/ or .roll/", async () => {
    const repo = cleanRepo("roll-main-dirty-staged-");
    // Staged deletion of skills submodule gitlink (simulated by git rm --cached)
    git(repo, ["rm", "--cached", "-q", "skills/README.md"]);
    // Also a regular working-tree change to a product file
    writeFileSync(join(repo, "product.ts"), "leak\n", "utf8");

    const files = await checkMainDirty(repo);
    // Staged deletion "skills/README.md" MUST be in the list
    expect(files).toContain("skills/README.md");
    // Product file still included
    expect(files).toContain("product.ts");
    // Non-staged working-tree changes in .roll/ are still excluded
    writeFileSync(join(repo, ".roll", "scratch.txt"), "runtime\n", "utf8");
    const files2 = await checkMainDirty(repo);
    expect(files2).not.toContain(".roll/scratch.txt");
  });

  it("FIX-1218: checkMainDirty includes staged skills gitlink deletion", async () => {
    const repo = cleanRepoWithSkillsGitlink("roll-main-dirty-gitlink-");
    git(repo, ["rm", "--cached", "-q", "skills"]);

    await expect(checkMainDirty(repo)).resolves.toContain("skills");
  });

  it("pins spawned worktree git discovery below the main checkout parent", () => {
    const repo = cleanRepo("roll-main-gitenv-ceiling-");
    // Nested (non-sibling) worktree layout: dirname(wt) !== dirname(repo), so this
    // proves the ceiling pins to the MAIN checkout's parent, not the worktree's own
    // parent — a sibling layout cannot distinguish the two (kimi review finding).
    const nest = join(repo, "nested");
    mkdirSync(nest, { recursive: true });
    const wt = join(nest, "cycle-wt");
    git(repo, ["worktree", "add", "-q", "-b", "cycle/nested-test", wt, "origin/main"]);

    const env = worktreeGitDiscoveryEnv(wt);
    expect(env).toEqual({ GIT_CEILING_DIRECTORIES: dirname(wt) });
    expect(env).not.toHaveProperty("GIT_DIR");
    expect(env).not.toHaveProperty("GIT_WORK_TREE");
  });

  it("does not fabricate GIT_DIR when git cannot resolve the worktree", () => {
    const repo = cleanRepo("roll-main-gitenv-fail-");
    const missing = join(repo, "missing-worktree");

    expect(worktreeGitDiscoveryEnv(missing)).toEqual({ GIT_CEILING_DIRECTORIES: dirname(missing) });
  });
});

// ─── FIX-1210: core.worktree repair + config-write blocking ──────────────────

describe("FIX-1210 — core.worktree contamination repair", () => {
  it("detects and heals core.worktree contamination on the shared config", () => {
    const repo = cleanRepo("roll-fix1210-repair-");

    // Simulate contamination: write core.worktree pointing to a cycle worktree
    git(repo, ["config", "--local", "core.worktree", "/tmp/fake-cycle-worktree"]);

    // Verify contamination is present
    expect(sh(repo, ["config", "--local", "--get", "core.worktree"])).toBe("/tmp/fake-cycle-worktree");

    // Repair
    const result = repairCoreWorktreeContamination(repo);
    expect(result.healed).toBe(true);
    expect(result.detail).toBe("/tmp/fake-cycle-worktree");

    // Verify contamination is gone
    const after = spawnSync("git", ["config", "--local", "--get", "core.worktree"], { cwd: repo, encoding: "utf8" });
    expect(after.status).not.toBe(0); // config key no longer exists
  });

  it("no-ops when core.worktree is not set", () => {
    const repo = cleanRepo("roll-fix1210-clean-");

    // No contamination — should report clean
    const result = repairCoreWorktreeContamination(repo);
    expect(result.healed).toBe(false);
    expect(result.detail).toBe("");
  });

  it("repairs contamination even with GIT_DIR/GIT_WORK_TREE inherited in env", () => {
    const repo = cleanRepo("roll-fix1210-inherit-");

    // Simulate contamination
    git(repo, ["config", "--local", "core.worktree", "/tmp/poisoned-worktree"]);

    // Craft an env that mimics the cycle worktree injection
    const env: NodeJS.ProcessEnv = { ...process.env };
    env["GIT_DIR"] = join(repo, ".git");
    env["GIT_WORK_TREE"] = "/some/fake/worktree";

    // The repair function builds its own clean env, so it should still heal
    const result = repairCoreWorktreeContamination(repo);
    expect(result.healed).toBe(true);
    expect(result.detail).toBe("/tmp/poisoned-worktree");

    // Verify contamination is gone
    const after = spawnSync("git", ["config", "--local", "--get", "core.worktree"], { cwd: repo, encoding: "utf8" });
    expect(after.status).not.toBe(0);
  });
});

describe("FIX-1210 — config.lock sentinel blocks nested git init writes", () => {
  it("places a read-only .git/config.lock when write protection is applied", () => {
    const repo = cleanRepo("roll-fix1210-lock-");
    const runtimeDir = join(repo, ".roll", "loop");
    const lockPath = join(repo, ".git", "config.lock");

    // Guard should not exist before protection
    expect(existsSync(lockPath)).toBe(false);

    applyMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-lock", nowMs: () => 1000 });

    // Guard should exist after protection
    expect(existsSync(lockPath)).toBe(true);
    // Should be read-only
    const mode = statSync(lockPath).mode & 0o777;
    expect(mode & 0o222).toBe(0); // no write bits set

    releaseMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-lock", nowMs: () => 2000 });

    // Guard should be removed after release
    expect(existsSync(lockPath)).toBe(false);
  });

  it("prevents git init from writing core.worktree to shared config", () => {
    const repo = cleanRepo("roll-fix1210-init-");
    const runtimeDir = join(repo, ".roll", "loop");

    // Apply protection (which includes the config.lock sentinel)
    applyMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-init", nowMs: () => 1000 });

    // Simulate the harness's spawn env injection — set GIT_DIR/GIT_WORK_TREE
    // to point at the main checkout. A nested `git init` running under these
    // vars would normally write core.worktree into the main checkout's config.
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    spawnEnv["GIT_DIR"] = join(repo, ".git");
    spawnEnv["GIT_WORK_TREE"] = repo;

    // Run `git init` in a temp dir — this is what the harness does when
    // creating fixture repos inside the agent sandbox
    const tmpInit = mkdtempSync(join(tmpdir(), "roll-fix1210-init-nested-"));
    dirs.push(tmpInit);
    try {
      const r = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tmpInit, env: spawnEnv, encoding: "utf8" });
      // git init may succeed (it creates a new repo in tmpInit) or fail
      // (config lock blocked it) — either way, core.worktree must NOT leak
      // into the shared config
      const check = spawnSync("git", ["config", "--local", "--get", "core.worktree"], {
        cwd: repo,
        encoding: "utf8",
      });
      // core.worktree must NOT be set on the main checkout's config
      expect(check.status).not.toBe(0);
    } finally {
      releaseMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-init", nowMs: () => 2000 });
    }
  });

  it("withMainCheckoutWriteProtection includes config.lock in apply/release cycle", async () => {
    const repo = cleanRepo("roll-fix1210-with-");
    const runtimeDir = join(repo, ".roll", "loop");
    const lockPath = join(repo, ".git", "config.lock");

    let lockDuringFn: boolean | undefined;
    const events = await withMainCheckoutWriteProtection(
      { repoCwd: repo, runtimeDir, cycleId: "C-with", nowMs: () => 1000 },
      () => {
        lockDuringFn = existsSync(lockPath);
        return 42;
      },
    );

    expect(lockDuringFn).toBe(true);
    expect(events.value).toBe(42);
    expect(existsSync(lockPath)).toBe(false); // released
  });

  it("releases config.lock even when the protected function throws", async () => {
    const repo = cleanRepo("roll-fix1210-throw-");
    const runtimeDir = join(repo, ".roll", "loop");
    const lockPath = join(repo, ".git", "config.lock");

    await expect(
      withMainCheckoutWriteProtection(
        { repoCwd: repo, runtimeDir, cycleId: "C-throw", nowMs: () => 1000 },
        () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    // config.lock must be cleaned up even after throw
    expect(existsSync(lockPath)).toBe(false);
  });

  it("replaces a stale zero-byte config.lock at the next cycle boundary", () => {
    const repo = cleanRepo("roll-fix1210-stale-lock-");
    const runtimeDir = join(repo, ".roll", "loop");
    const lockPath = join(repo, ".git", "config.lock");
    writeFileSync(lockPath, "", "utf8");
    expect(statSync(lockPath).size).toBe(0);

    applyMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-stale-lock", nowMs: () => 1000 });
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(lockPath).size).toBeGreaterThan(0);

    releaseMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-stale-lock", nowMs: () => 2000 });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims an orphaned roll sentinel (non-zero, crash residue) at the next cycle boundary", () => {
    const repo = cleanRepo("roll-fix1210-orphan-sentinel-");
    const runtimeDir = join(repo, ".roll", "loop");
    const lockPath = join(repo, ".git", "config.lock");
    // Simulate a hard-killed prior cycle: sentinel written, release never ran.
    writeFileSync(lockPath, "roll main-checkout config lock sentinel\n", "utf8");
    chmodSync(lockPath, 0o444);

    applyMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-orphan", nowMs: () => 1000 });
    expect(existsSync(lockPath)).toBe(true);

    releaseMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-orphan", nowMs: () => 2000 });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("leaves a live foreign config.lock alone on apply and release", () => {
    const repo = cleanRepo("roll-fix1210-foreign-lock-");
    const runtimeDir = join(repo, ".roll", "loop");
    const lockPath = join(repo, ".git", "config.lock");
    writeFileSync(lockPath, "ref: some in-flight git config transaction\n", "utf8");

    applyMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-foreign", nowMs: () => 1000 });
    expect(readFileSync(lockPath, "utf8")).toBe("ref: some in-flight git config transaction\n");

    releaseMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: "C-foreign", nowMs: () => 2000 });
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("ref: some in-flight git config transaction\n");
  });

  it("recovers stale write-protection marker and orphaned Roll config.lock", () => {
    const repo = cleanRepo("roll-fix1210-recover-residue-");
    const runtimeDir = join(repo, ".roll", "loop");
    const markerPath = join(runtimeDir, "main-checkout-protection.json");
    const tracked = join(repo, "tracked.txt");
    const lockPath = join(repo, ".git", "config.lock");
    chmodSync(tracked, 0o444);
    writeFileSync(
      markerPath,
      JSON.stringify({ repoCwd: repo, cycleId: "C-residue", entries: [{ path: tracked, mode: 0o644 }] }, null, 2),
      "utf8",
    );
    writeFileSync(lockPath, "roll main-checkout config lock sentinel\n", "utf8");
    chmodSync(lockPath, 0o444);

    const before = detectMainCheckoutWriteProtectionResidue(repo, runtimeDir);
    expect(before.markerPresent).toBe(true);
    expect(before.reclaimableConfigLock).toBe(true);

    const recovered = recoverMainCheckoutWriteProtectionResidue(repo, runtimeDir);
    expect(recovered.restoredPaths).toBe(1);
    expect(recovered.markerRemoved).toBe(true);
    expect(recovered.configLockRemoved).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(statSync(tracked).mode & 0o200).toBe(0o200);
  });

  it("leaves foreign config.lock untouched during residue recovery", () => {
    const repo = cleanRepo("roll-fix1210-recover-foreign-");
    const runtimeDir = join(repo, ".roll", "loop");
    const markerPath = join(runtimeDir, "main-checkout-protection.json");
    const lockPath = join(repo, ".git", "config.lock");
    writeFileSync(markerPath, JSON.stringify({ repoCwd: repo, cycleId: "C-foreign", entries: [] }, null, 2), "utf8");
    writeFileSync(lockPath, "foreign git config transaction\n", "utf8");

    const recovered = recoverMainCheckoutWriteProtectionResidue(repo, runtimeDir);
    expect(recovered.markerRemoved).toBe(true);
    expect(recovered.configLockRemoved).toBe(false);
    expect(recovered.foreignConfigLock).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("foreign git config transaction\n");
  });

  it.each(["primary", "linked"] as const)("FIX-1473: resolves and guards real Git paths for a %s worktree", (kind) => {
    const primary = cleanRepo(`roll-fix1473-${kind}-`);
    const repo = kind === "primary" ? primary : worktreeFrom(primary);
    const runtimeDir = join(primary, ".roll", "loop", `guard-${kind}`);
    const protectedTargets = [
      gitPath(repo, "config"),
      gitPath(repo, "index"),
      gitPath(repo, "HEAD"),
      gitPath(repo, currentBranchRef(repo)),
    ];
    const lockPaths = protectedTargets.map((path) => `${path}.lock`);
    const resolved = resolveMainCheckoutGitPaths(repo);

    expect(resolved).toBeDefined();
    expect(resolved?.config).toBe(protectedTargets[0]);
    expect(resolved?.index).toBe(protectedTargets[1]);
    expect(resolved?.head).toBe(protectedTargets[2]);
    expect(resolved?.branchRef).toBe(protectedTargets[3]);
    if (kind === "linked") expect(resolved?.gitDir).not.toBe(resolved?.commonDir);
    else expect(resolved?.gitDir).toBe(resolved?.commonDir);

    applyMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: `C-${kind}`, nowMs: () => 1000 });
    try {
      for (const lockPath of lockPaths) {
        expect(existsSync(lockPath), lockPath).toBe(true);
        expect(readFileSync(lockPath, "utf8"), lockPath).toBe("roll main-checkout git lock sentinel\n");
      }
      expect(() => sh(repo, ["status", "--porcelain"])).not.toThrow();
    } finally {
      releaseMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir, cycleId: `C-${kind}`, nowMs: () => 2000 });
    }

    for (const lockPath of lockPaths) expect(existsSync(lockPath), lockPath).toBe(false);
  });
});

describe("E10 — persisted pre-spawn main-dirty baseline", () => {
  it("writeMainDirtyBaseline persists the dirt set to <runtimeDir>/<cycleId>.main-baseline.json and readMainDirtyBaseline round-trips it", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-e10-baseline-"));
    dirs.push(dir);
    const files = ["dukang-service-online", "service-online-webui-monorepo", "wt-fix-004/"];

    writeMainDirtyBaseline(dir, "C-baseline", files);

    const path = join(dir, "C-baseline.main-baseline.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(files);
    expect(readMainDirtyBaseline(dir, "C-baseline")).toEqual(files);
  });

  it("readMainDirtyBaseline returns [] when the baseline file is absent (zero-regression fallback = absolute dirt)", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-e10-absent-"));
    dirs.push(dir);
    expect(readMainDirtyBaseline(dir, "C-none")).toEqual([]);
  });

  it("readMainDirtyBaseline returns [] on malformed JSON (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-e10-malformed-"));
    dirs.push(dir);
    writeFileSync(join(dir, "C-bad.main-baseline.json"), "{ not an array", "utf8");
    expect(readMainDirtyBaseline(dir, "C-bad")).toEqual([]);
  });

  it("writeMainDirtyBaseline creates the runtime dir when missing", () => {
    const root = mkdtempSync(join(tmpdir(), "roll-e10-mkdir-"));
    dirs.push(root);
    const nested = join(root, "does", "not", "exist");
    writeMainDirtyBaseline(nested, "C-mkdir", ["a.ts"]);
    expect(readMainDirtyBaseline(nested, "C-mkdir")).toEqual(["a.ts"]);
  });
});


// ─── FIX-1475: persisted pre-spawn main-HEAD baseline ────────────────────────

describe("FIX-1475 — persisted pre-spawn main-HEAD baseline", () => {
  it("captureMainHeadBaseline persists the current HEAD sha and readMainHeadBaseline round-trips it", () => {
    const repo = cleanRepo("roll-fix1475-head-baseline-");
    const runtimeDir = join(repo, ".roll", "loop");
    const head = sh(repo, ["rev-parse", "HEAD"]);

    captureMainHeadBaseline(repo, runtimeDir, "C-head");

    expect(readFileSync(join(runtimeDir, "C-head.main-head-baseline"), "utf8")).toBe(`${head}\n`);
    expect(readMainHeadBaseline(runtimeDir, "C-head")).toBe(head);
  });

  it("readMainHeadBaseline returns '' when the baseline file is absent (legacy absolute-ahead fallback)", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-fix1475-head-absent-"));
    dirs.push(dir);
    expect(readMainHeadBaseline(dir, "C-none")).toBe("");
  });

  it("readMainHeadBaseline returns '' on malformed content (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-fix1475-head-malformed-"));
    dirs.push(dir);
    writeFileSync(join(dir, "C-bad.main-head-baseline"), "not a sha\n", "utf8");
    expect(readMainHeadBaseline(dir, "C-bad")).toBe("");
  });

  it("captureMainHeadBaseline is a clean no-op outside a git repo (best-effort)", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-fix1475-head-nogit-"));
    dirs.push(dir);
    captureMainHeadBaseline(dir, dir, "C-nogit");
    expect(readMainHeadBaseline(dir, "C-nogit")).toBe("");
  });
});
