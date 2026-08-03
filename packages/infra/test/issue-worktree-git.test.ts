import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReadOnlyWorktreeSymlinkError,
  checkWorktreeCompatibility,
  issueWorktreeAdd,
  issueWorktreeIdentity,
  issueWorktreeRemove,
  protectReadOnlyWorktree,
  unprotectReadOnlyWorktree,
} from "../src/issue-worktree-git.js";

const sandboxes: string[] = [];
afterEach(() => {
  for (const root of sandboxes.splice(0)) {
    unprotectReadOnlyWorktree(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-issue-worktree-git-"));
  sandboxes.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Roll Test", "-c", "user.email=roll@example.test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** A real bare cache with one commit on main, mirroring ensureRepositoryCache's output shape. */
function bareCache(root: string): { readonly cachePath: string; readonly baseSha: string } {
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.email", "roll@example.test"]);
  git(source, ["config", "user.name", "Roll Test"]);
  writeFileSync(join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "fixture"]);
  const cachePath = join(root, "cache.git");
  git(root, ["clone", "-q", "--bare", source, cachePath]);
  const baseSha = git(source, ["rev-parse", "HEAD"]);
  return { cachePath, baseSha };
}

describe("issueWorktreeAdd", () => {
  it("creates a real detached git worktree for a read target (no branch)", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "docs");
    const result = await issueWorktreeAdd(cachePath, path, baseSha, null);
    expect(existsSync(join(path, ".git"))).toBe(true);
    const head = git(path, ["rev-parse", "HEAD"]);
    expect(head).toBe(baseSha);
    // detached HEAD: `git symbolic-ref` exits non-zero (no branch ref to report)
    expect(() => git(path, ["symbolic-ref", "-q", "HEAD"])).toThrow();
    // No branch at all for a read target — never "created" or "reused".
    expect(result.branchCreatedThisRun).toBe(false);
  });

  it("creates a real git worktree on a NEW named branch for a write target, reporting the branch as created THIS run", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    const result = await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch).toBe("roll/ws-demo/US-XX1/sot");
    const head = git(path, ["rev-parse", "HEAD"]);
    expect(head).toBe(baseSha);
    expect(result.branchCreatedThisRun).toBe(true);
  });

  it("never force-removes a pre-existing path — it fails loud instead", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "keep-me.txt"), "pre-existing content");
    await expect(issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot")).rejects.toThrow();
    expect(existsSync(join(path, "keep-me.txt"))).toBe(true);
  });

  it("re-adds at the same path after its directory was deleted by hand (stale worktree admin metadata), by pruning first", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "docs");
    await issueWorktreeAdd(cachePath, path, baseSha, null);
    // Simulate an operator deleting the worktree directory directly, NOT via
    // `git worktree remove` — git's own admin metadata still references it.
    rmSync(path, { recursive: true, force: true });
    await issueWorktreeAdd(cachePath, path, baseSha, null);
    expect(existsSync(join(path, ".git"))).toBe(true);
  });

  it("recovers an ORPHAN governed branch (real: created by an interrupted prior run, path now absent) whose tip has the pinned base as an ancestor", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    const branch = "roll/ws-demo/US-XX1/sot";
    // Real orphan: an earlier interrupted run created the governed branch
    // and a worktree, then the worktree directory was deleted by hand
    // (leaving the branch — and git's stale worktree admin metadata —
    // behind) without the branch itself ever being cleaned up.
    await issueWorktreeAdd(cachePath, path, baseSha, branch);
    rmSync(path, { recursive: true, force: true });

    // This target is a REPAIR of an existing pin (isPinned=true) — orphan
    // recovery is allowed.
    const result = await issueWorktreeAdd(cachePath, path, baseSha, branch, { allowOrphanRecovery: true });
    expect(existsSync(join(path, ".git"))).toBe(true);
    expect(git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branch);
    expect(git(path, ["rev-parse", "HEAD"])).toBe(baseSha);
    // The branch was REUSED (recovered), not created this run.
    expect(result.branchCreatedThisRun).toBe(false);
  });

  it("recovers an ORPHAN governed branch that has LATER real story commits (pinned base is an ancestor, not equal)", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    const branch = "roll/ws-demo/US-XX1/sot";
    await issueWorktreeAdd(cachePath, path, baseSha, branch);
    writeFileSync(join(path, "story-work.txt"), "real story commit\n", "utf8");
    git(path, ["add", "story-work.txt"]);
    git(path, ["commit", "-q", "-m", "real story commit"]);
    const advancedHead = git(path, ["rev-parse", "HEAD"]);
    rmSync(path, { recursive: true, force: true });

    const result = await issueWorktreeAdd(cachePath, path, baseSha, branch, { allowOrphanRecovery: true });
    expect(git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branch);
    // Recovery checks out the branch's REAL current tip — the real story
    // commit is preserved, never reset back to the base.
    expect(git(path, ["rev-parse", "HEAD"])).toBe(advancedHead);
    expect(existsSync(join(path, "story-work.txt"))).toBe(true);
    expect(result.branchCreatedThisRun).toBe(false);
  });

  it("REFUSES to recover an orphan branch whose history DIVERGED from the pinned base (base is not an ancestor)", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    const branch = "roll/ws-demo/US-XX1/sot";
    await issueWorktreeAdd(cachePath, path, baseSha, branch);
    // Real divergence: reset the branch onto an unrelated orphan history.
    git(path, ["checkout", "--orphan", "unrelated-history"]);
    git(path, ["rm", "-rf", "."]);
    writeFileSync(join(path, "unrelated.txt"), "unrelated root commit\n", "utf8");
    git(path, ["add", "unrelated.txt"]);
    git(path, ["commit", "-q", "-m", "unrelated root commit"]);
    git(path, ["branch", "-f", branch, "unrelated-history"]);
    rmSync(path, { recursive: true, force: true });

    await expect(issueWorktreeAdd(cachePath, path, baseSha, branch, { allowOrphanRecovery: true })).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("REFUSES to recover an orphan branch that is ALREADY checked out in ANOTHER real worktree", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    const branch = "roll/ws-demo/US-XX1/sot";
    await issueWorktreeAdd(cachePath, path, baseSha, branch);
    // Real orphan admin metadata: the branch is registered as checked out
    // at `path`, but `path` itself never got deleted here — instead, a
    // SECOND real worktree independently tries to claim the SAME branch,
    // which git itself must refuse since one branch = one live worktree.
    const otherPath = join(root, "issues", "US-XX1", "sot-elsewhere");
    await expect(issueWorktreeAdd(cachePath, otherPath, baseSha, branch, { allowOrphanRecovery: true })).rejects.toThrow();
    expect(existsSync(otherPath)).toBe(false);
    // The original worktree is completely unaffected.
    expect(existsSync(join(path, ".git"))).toBe(true);
  });

  it("REFUSES to silently adopt a pre-existing branch for a BRAND-NEW unpinned target — fails loud instead of reusing it", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    const branch = "roll/ws-demo/US-XX1/sot";
    // A branch of this exact name already exists in the cache for some
    // unrelated reason (e.g. name collision with another Issue/Workspace,
    // or leftover from manual git use) — but THIS target has never been
    // pinned (no journal/event fact), so it must never silently adopt it.
    await issueWorktreeAdd(cachePath, path, baseSha, branch);
    rmSync(path, { recursive: true, force: true });

    await expect(issueWorktreeAdd(cachePath, path, baseSha, branch, { allowOrphanRecovery: false }))
      .rejects.toThrow(/orphan|already exists|pinned/i);
    expect(existsSync(path)).toBe(false);
  });
});

describe("issueWorktreeIdentity", () => {
  it("reports absent for a path that does not exist", async () => {
    const root = sandbox();
    const identity = await issueWorktreeIdentity(join(root, "nope"), join(root, "cache.git"));
    expect(identity.state).toBe("absent");
  });

  it("reports conflict for an ordinary directory that is not a git worktree", async () => {
    const root = sandbox();
    const path = join(root, "not-a-worktree");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "file.txt"), "hi");
    const identity = await issueWorktreeIdentity(path, join(root, "cache.git"));
    expect(identity.state).toBe("conflict");
  });

  it("reports conflict when the worktree belongs to a DIFFERENT repository cache", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const otherRoot = sandbox();
    const other = bareCache(otherRoot);
    const path = join(root, "issues", "US-XX1", "sot");
    await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    const identity = await issueWorktreeIdentity(path, other.cachePath);
    expect(identity.state).toBe("conflict");
  });

  it("reports compatible for a clean real worktree matching its cache and branch", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    const identity = await issueWorktreeIdentity(path, cachePath);
    expect(identity).toMatchObject({ state: "compatible", dirty: false, branch: "roll/ws-demo/US-XX1/sot", baseSha });
  });

  it("reports dirty:true for a worktree with uncommitted changes, without treating it as conflict", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    writeFileSync(join(path, "scratch.txt"), "uncommitted work");
    const identity = await issueWorktreeIdentity(path, cachePath);
    expect(identity).toMatchObject({ state: "compatible", dirty: true });
  });
});

describe("issueWorktreeRemove", () => {
  it("removes a clean worktree via git worktree remove, never a blind rm -rf", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    await issueWorktreeRemove(cachePath, path);
    expect(existsSync(path)).toBe(false);
    // The cache's worktree admin no longer lists it.
    const list = git(cachePath, ["worktree", "list", "--porcelain"]);
    expect(list).not.toContain(path);
  });

  it("refuses to remove a dirty worktree", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    writeFileSync(join(path, "scratch.txt"), "uncommitted work");
    await expect(issueWorktreeRemove(cachePath, path)).rejects.toThrow();
    expect(existsSync(join(path, "scratch.txt"))).toBe(true);
  });

  it("re-protects a preserved READ target when git worktree remove genuinely fails (a real lock, not dirty)", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "docs");
    await issueWorktreeAdd(cachePath, path, baseSha, null);
    protectReadOnlyWorktree(path);
    // A real, unmocked removal failure independent of dirty state: git
    // itself refuses to remove a LOCKED worktree.
    git(cachePath, ["worktree", "lock", path]);

    await expect(issueWorktreeRemove(cachePath, path, { readOnly: true })).rejects.toThrow();

    // The preserved target must remain non-writable — removal failed, so
    // unprotecting it first must not be left as a permanent side effect.
    expect(existsSync(path)).toBe(true);
    expect(() => writeFileSync(join(path, "README.md"), "mutated\n", { flag: "r+" })).toThrow(/EACCES|EPERM/);
    expect(() => writeFileSync(join(path, "new-file.txt"), "new\n")).toThrow(/EACCES|EPERM/);

    git(cachePath, ["worktree", "unlock", path]);
  });
});

describe("protectReadOnlyWorktree / unprotectReadOnlyWorktree", () => {
  it("denies writes to real product files and blocks new-file creation in a checkout with no symlinks", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "docs");
    await issueWorktreeAdd(cachePath, path, baseSha, null);
    protectReadOnlyWorktree(path);

    expect(() => writeFileSync(join(path, "README.md"), "mutated\n", { flag: "r+" })).toThrow(/EACCES|EPERM/);
    expect(() => writeFileSync(join(path, "new-file.txt"), "new\n")).toThrow(/EACCES|EPERM/);

    unprotectReadOnlyWorktree(path);
    writeFileSync(join(path, "README.md"), "restored\n", { flag: "r+" });
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("restored\n");
  });

  it("REFUSES to protect (and never chmods anything, including the EXTERNAL target) a checkout containing a tracked symlink", async () => {
    const root = sandbox();
    const outsidePath = join(root, "outside-the-worktree.txt");
    writeFileSync(outsidePath, "external content, never owned by any worktree\n", "utf8");
    const outsideModeBefore = statSync(outsidePath).mode & 0o777;

    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    git(source, ["init", "-q", "-b", "main"]);
    git(source, ["config", "user.email", "roll@example.test"]);
    git(source, ["config", "user.name", "Roll Test"]);
    writeFileSync(join(source, "README.md"), "fixture\n", "utf8");
    // A real git-tracked symlink whose target lives OUTSIDE this worktree
    // entirely (an absolute path escaping the repo) — chmod can never make
    // this symlink itself deny writes (it follows to the target), so
    // protection must refuse the whole checkout rather than expose a
    // write-through hole.
    symlinkSync(outsidePath, join(source, "escape-link.txt"));
    git(source, ["add", "README.md", "escape-link.txt"]);
    git(source, ["commit", "-q", "-m", "fixture with an escaping symlink"]);
    const cachePath = join(root, "cache.git");
    git(root, ["clone", "-q", "--bare", source, cachePath]);
    const baseSha = git(source, ["rev-parse", "HEAD"]);

    const path = join(root, "issues", "US-XX1", "docs");
    await issueWorktreeAdd(cachePath, path, baseSha, null);
    expect(() => protectReadOnlyWorktree(path)).toThrow(ReadOnlyWorktreeSymlinkError);

    // Nothing was chmod'd at all — the real product file stays writable...
    writeFileSync(join(path, "README.md"), "still writable\n", { flag: "r+" });
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("still writable\n");
    // ...the symlink is untouched...
    expect(lstatSync(join(path, "escape-link.txt")).isSymbolicLink()).toBe(true);
    // ...and its EXTERNAL target's permissions/content are completely
    // untouched (protection threw before reaching ANY chmod, not just this one).
    expect(statSync(outsidePath).mode & 0o777).toBe(outsideModeBefore);
    expect(readFileSync(outsidePath, "utf8")).toBe("external content, never owned by any worktree\n");
  });
});

describe("checkWorktreeCompatibility", () => {
  it("is compatible for a READ target whose detached HEAD equals the pinned base exactly", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "docs");
    await issueWorktreeAdd(cachePath, path, baseSha, null);
    const identity = await issueWorktreeIdentity(path, cachePath);
    const ok = await checkWorktreeCompatibility(identity, cachePath, { access: "read", workBranch: null, baseSha });
    expect(ok).toBe(true);
  });

  it("is a conflict for a READ target detached at a DIFFERENT commit than the pinned base", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "docs");
    await issueWorktreeAdd(cachePath, path, baseSha, null);
    // Real drift: move the detached HEAD to a different real commit.
    writeFileSync(join(path, "extra.txt"), "drift\n", "utf8");
    git(path, ["add", "extra.txt"]);
    git(path, ["commit", "-q", "-m", "drift"]);
    git(path, ["checkout", "--detach", "HEAD"]);
    const identity = await issueWorktreeIdentity(path, cachePath);
    const ok = await checkWorktreeCompatibility(identity, cachePath, { access: "read", workBranch: null, baseSha });
    expect(ok).toBe(false);
  });

  it("is compatible for a WRITE target on the exact governed branch, pinned base equal to HEAD", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    const identity = await issueWorktreeIdentity(path, cachePath);
    const ok = await checkWorktreeCompatibility(identity, cachePath, { access: "write", workBranch: "roll/ws-demo/US-XX1/sot", baseSha });
    expect(ok).toBe(true);
  });

  it("is compatible for a WRITE target with LATER real commits on the exact governed branch (pinned base is an ancestor)", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    writeFileSync(join(path, "story-work.txt"), "real story commit\n", "utf8");
    git(path, ["add", "story-work.txt"]);
    git(path, ["commit", "-q", "-m", "real story commit"]);
    const identity = await issueWorktreeIdentity(path, cachePath);
    const ok = await checkWorktreeCompatibility(identity, cachePath, { access: "write", workBranch: "roll/ws-demo/US-XX1/sot", baseSha });
    expect(ok).toBe(true);
  });

  it("is a conflict for a WRITE target on the WRONG branch name entirely", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    git(path, ["switch", "-c", "wrong-branch"]);
    const identity = await issueWorktreeIdentity(path, cachePath);
    const ok = await checkWorktreeCompatibility(identity, cachePath, { access: "write", workBranch: "roll/ws-demo/US-XX1/sot", baseSha });
    expect(ok).toBe(false);
  });

  it("is a conflict for a WRITE target with DIVERGED history (pinned base is NOT an ancestor of HEAD)", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    // Real divergence: reset the governed branch onto an unrelated history
    // (an orphan commit sharing no ancestry with the pinned base) rather
    // than committing forward from it.
    git(path, ["checkout", "--orphan", "unrelated-history"]);
    git(path, ["rm", "-rf", "."]);
    writeFileSync(join(path, "unrelated.txt"), "unrelated root commit\n", "utf8");
    git(path, ["add", "unrelated.txt"]);
    git(path, ["commit", "-q", "-m", "unrelated root commit"]);
    git(path, ["branch", "-f", "roll/ws-demo/US-XX1/sot", "unrelated-history"]);
    git(path, ["checkout", "roll/ws-demo/US-XX1/sot"]);
    const identity = await issueWorktreeIdentity(path, cachePath);
    const ok = await checkWorktreeCompatibility(identity, cachePath, { access: "write", workBranch: "roll/ws-demo/US-XX1/sot", baseSha });
    expect(ok).toBe(false);
  });

  it("is never compatible when the expected pinned base itself is unavailable (null)", async () => {
    const root = sandbox();
    const { cachePath, baseSha } = bareCache(root);
    const path = join(root, "issues", "US-XX1", "sot");
    await issueWorktreeAdd(cachePath, path, baseSha, "roll/ws-demo/US-XX1/sot");
    const identity = await issueWorktreeIdentity(path, cachePath);
    const ok = await checkWorktreeCompatibility(identity, cachePath, { access: "write", workBranch: "roll/ws-demo/US-XX1/sot", baseSha: null });
    expect(ok).toBe(false);
  });
});
