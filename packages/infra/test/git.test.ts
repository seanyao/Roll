/**
 * Tests for the git module — real temp git repos. Covers the worktree
 * lifecycle, the FIX-114 branch-collision case, the raw wrappers
 * (branch/commit/push/currentBranch/mergeBase/isAncestor/lsRemote), and
 * canonicalProjectPath / projectIdentity (the latter cross-checked against the
 * @roll/spec slug contract in git.difftest.test.ts).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  branchCleanlyRebasesOntoMain,
  branchCreate,
  branchMergedIntoMain,
  canonicalProjectPath,
  commit,
  currentBranch,
  fetchRemoteBranch,
  isAncestor,
  isCommitReachableFromIntegrationBranch,
  landLocalDelivery,
  lsRemote,
  mergeBase,
  projectIdentity,
  resolveIntegrationBranch,
  resolvePublishMode,
  submoduleWorktreePath,
  worktreeAdd,
  worktreeAddInSubmodule,
  worktreeRemove,
  worktreeResetHard,
} from "../src/index.js";
import { projectSlug } from "@roll/spec";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execFileSync("rm", ["-rf", d]);
});
function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `roll-infra-git-${tag}-`));
  dirs.push(d);
  return realpathSync(d);
}
/** Init a repo with one commit on `main`. */
function initRepo(tag: string): string {
  const d = tmp(tag);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
  // Repo-local identity: CI runners have no global git config, and the
  // wrappers under test deliberately don't inject one (AGENTS: identity
  // comes from git config, never hardcoded).
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: d });
  execFileSync("git", ["config", "user.name", "t"], { cwd: d });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: d });
  return d;
}

describe("worktree lifecycle", () => {
  it("US-LOOP-094: worktreeAdd creates a DETACHED worktree — no local branch", async () => {
    const repo = initRepo("wt");
    const wtParent = tmp("wtside");
    const wt = join(wtParent, "wt");
    const add = await worktreeAdd(repo, wt, "loop/cycle-x", "main");
    expect(add.code).toBe(0);
    expect(existsSync(wt)).toBe(true);
    // Detached: no branch is checked out; abbrev-ref HEAD reads "HEAD".
    expect(await currentBranch(wt)).toBe("HEAD");
    // The intended remote-ref name never becomes a LOCAL branch.
    const refs = execFileSync("git", ["branch", "--list", "loop/cycle-x"], { cwd: repo, encoding: "utf8" });
    expect(refs.trim()).toBe("");

    const rm = await worktreeRemove(repo, wt, "loop/cycle-x");
    expect(rm.code).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  it("US-LOOP-094: detached add does NOT clobber an existing same-named branch", async () => {
    const repo = initRepo("nostomp");
    // A branch with the SAME name exists (e.g. a resumable prior-cycle ref).
    expect((await branchCreate(repo, "feat-stale", "main")).code).toBe(0);
    const wt = join(tmp("nostompwt"), "wt");
    const add = await worktreeAdd(repo, wt, "feat-stale", "main");
    expect(add.code).toBe(0);
    expect(await currentBranch(wt)).toBe("HEAD"); // detached, not on feat-stale
    // The pre-existing branch is untouched (old FIX-114 deleted it; detached must not).
    const refs = execFileSync("git", ["branch", "--list", "feat-stale"], { cwd: repo, encoding: "utf8" });
    expect(refs).toContain("feat-stale");
    await worktreeRemove(repo, wt, "feat-stale");
  });

  it("worktreeAdd is idempotent over a leftover path", async () => {
    const repo = initRepo("idem");
    const wt = join(tmp("idemwt"), "wt");
    expect((await worktreeAdd(repo, wt, "b1", "main")).code).toBe(0);
    // Second add to the SAME path: the existing worktree is removed first, so
    // this still succeeds (now detached).
    expect((await worktreeAdd(repo, wt, "b2", "main")).code).toBe(0);
    expect(await currentBranch(wt)).toBe("HEAD");
    await worktreeRemove(repo, wt, "b2");
  });

  it("US-LOOP-095: worktreeRemove bundles UNPUSHED detached work before teardown", async () => {
    const repo = initRepo("bundle");
    const wt = join(tmp("bundlewt"), "wt");
    expect((await worktreeAdd(repo, wt, "loop/cycle-b", "main")).code).toBe(0);
    // Commit on the detached HEAD → work no remote holds (initRepo has none).
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "cycle work"], { cwd: wt });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();

    const rm = await worktreeRemove(repo, wt, "loop/cycle-b"); // bundleUnpushed defaults true
    expect(rm.code).toBe(0);
    expect(existsSync(wt)).toBe(false);
    const bundle = join(repo, ".roll", "loop", "quarantine", "leaked-loop-cycle-b.bundle");
    expect(existsSync(bundle)).toBe(true);
    expect(execFileSync("git", ["bundle", "list-heads", bundle], { cwd: repo, encoding: "utf8" })).toContain(head);
  });

  it("US-LOOP-095: the quarantine bundle is RECOVERABLE (verify + fetch into a fresh repo)", async () => {
    const repo = initRepo("recover");
    const wt = join(tmp("recoverwt"), "wt");
    expect((await worktreeAdd(repo, wt, "loop/cycle-r", "main")).code).toBe(0);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "unpushed work"], { cwd: wt });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
    await worktreeRemove(repo, wt, "loop/cycle-r");
    const bundle = join(repo, ".roll", "loop", "quarantine", "leaked-loop-cycle-r.bundle");

    // (a) the bundle is structurally valid.
    expect(() => execFileSync("git", ["bundle", "verify", bundle], { cwd: repo, stdio: "pipe" })).not.toThrow();
    // (b) the unpushed commit is actually recoverable into a PRISTINE repo
    //     (AC2: not just "recorded" — fetchable back to the exact object).
    const fresh = initRepo("recover-dst");
    execFileSync("git", ["fetch", bundle, "HEAD:refs/heads/recovered"], { cwd: fresh });
    const recovered = execFileSync("git", ["rev-parse", "refs/heads/recovered"], { cwd: fresh, encoding: "utf8" }).trim();
    expect(recovered).toBe(head);
  });

  it("US-LOOP-095: worktreeRemove(bundleUnpushed=false) skips the bundle (work already on remote)", async () => {
    const repo = initRepo("nobundle");
    const wt = join(tmp("nobundlewt"), "wt");
    expect((await worktreeAdd(repo, wt, "loop/cycle-n", "main")).code).toBe(0);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "cycle work"], { cwd: wt });
    await worktreeRemove(repo, wt, "loop/cycle-n", false);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(repo, ".roll", "loop", "quarantine", "leaked-loop-cycle-n.bundle"))).toBe(false);
  });
});

describe("raw wrappers", () => {
  it("commit / currentBranch / mergeBase / isAncestor", async () => {
    const repo = initRepo("raw");
    expect(await currentBranch(repo)).toBe("main");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    expect((await branchCreate(repo, "topic", "main")).code).toBe(0);
    execFileSync("git", ["checkout", "-q", "topic"], { cwd: repo });
    const c = await commit(repo, "second", { allowEmpty: true });
    expect(c.code).toBe(0);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    expect(await mergeBase(repo, "main", "topic")).toBe(base);
    expect(await isAncestor(repo, base, head)).toBe(true);
    expect(await isAncestor(repo, head, base)).toBe(false);
  });

  it("lsRemote parses sha/ref rows against a local 'remote' repo", async () => {
    const origin = initRepo("origin");
    const clone = tmp("clone");
    execFileSync("git", ["clone", "-q", origin, clone], { cwd: tmp("clonebase") });
    const refs = await lsRemote(clone, "origin", ["HEAD"]);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(refs.some((r) => r.ref === "HEAD")).toBe(true);
  });

  it("US-WS-014 binds reachability to the configured integration branch and exact commit", async () => {
    const repo = initRepo("integration-reachability");
    const common = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-q", "-b", "release"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "release-only"], { cwd: repo });
    const release = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    expect(await isCommitReachableFromIntegrationBranch(repo, common, "main")).toBe(true);
    expect(await isCommitReachableFromIntegrationBranch(repo, common, "release")).toBe(true);
    expect(await isCommitReachableFromIntegrationBranch(repo, release, "release")).toBe(true);
    expect(await isCommitReachableFromIntegrationBranch(repo, release, "main")).toBe(false);
    expect(await isCommitReachableFromIntegrationBranch(repo, "main", "release")).toBeUndefined();
  });
});

describe("RESUME-PRIOR-WORK probes (un-merged audit-branch reuse)", () => {
  const W = (p: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd: p, encoding: "utf8" }).trim();
  /** Build an origin repo with main + a `loop/cycle-<tag>` branch holding work,
   *  then a clone whose origin/* tracking refs the probes read. The cycle branch
   *  ALWAYS branches off the same main commit so it is un-merged by construction;
   *  `mainExtra` files (added on main AFTER the branch point) drive the rebase
   *  clean-vs-conflict outcome. */
  function setup(tag: string, opts: { branchFile: string; mainExtra?: { file: string; body: string } | undefined; cycleBody: string }): { clone: string; cycleBranch: string } {
    const origin = initRepo(`origin-${tag}`);
    const cycleBranch = `loop/cycle-${tag}`;
    // Branch the cycle off main, add the prior work, push it back to origin.
    W(origin, "checkout", "-q", "-b", cycleBranch);
    execFileSync("bash", ["-c", `printf '%s' '${opts.cycleBody}' > ${opts.branchFile}`], { cwd: origin });
    W(origin, "add", "-A");
    W(origin, "commit", "-q", "-m", "prior cycle work");
    W(origin, "checkout", "-q", "main");
    if (opts.mainExtra !== undefined) {
      execFileSync("bash", ["-c", `printf '%s' '${opts.mainExtra.body}' > ${opts.mainExtra.file}`], { cwd: origin });
      W(origin, "add", "-A");
      W(origin, "commit", "-q", "-m", "main moved on");
    }
    const clone = tmp(`clone-${tag}`);
    execFileSync("git", ["clone", "-q", origin, clone], { cwd: tmp(`clonebase-${tag}`) });
    return { clone, cycleBranch };
  }

  it("fetchRemoteBranch reports true for an existing branch, false for a missing one", async () => {
    const { clone, cycleBranch } = setup("fetch", { branchFile: "feat.txt", cycleBody: "work" });
    expect((await fetchRemoteBranch(clone, cycleBranch)).fetched).toBe(true);
    expect((await fetchRemoteBranch(clone, "loop/cycle-does-not-exist")).fetched).toBe(false);
  });

  it("branchMergedIntoMain: false for an un-merged branch, true once it lands on main", async () => {
    const { clone, cycleBranch } = setup("merged", { branchFile: "feat.txt", cycleBody: "work" });
    await fetchRemoteBranch(clone, cycleBranch);
    // Un-merged: the cycle branch's tip is not an ancestor of origin/main.
    expect(await branchMergedIntoMain(clone, cycleBranch)).toBe(false);
    // Merge it into the origin's main and re-fetch → now it IS on main.
    const originPath = W(clone, "remote", "get-url", "origin");
    W(originPath, "merge", "-q", "--no-ff", cycleBranch, "-m", "merge cycle");
    W(clone, "fetch", "-q", "origin", "main");
    expect(await branchMergedIntoMain(clone, cycleBranch)).toBe(true);
  });

  it("branchCleanlyRebasesOntoMain: true when no overlap, false on a conflicting file", async () => {
    // Clean: the cycle touches feat.txt; main moves on a DIFFERENT file.
    const clean = setup("clean", {
      branchFile: "feat.txt",
      cycleBody: "feat work",
      mainExtra: { file: "other.txt", body: "unrelated main change" },
    });
    await fetchRemoteBranch(clean.clone, clean.cycleBranch);
    expect(await branchCleanlyRebasesOntoMain(clean.clone, clean.cycleBranch)).toBe(true);

    // Conflict: both the cycle branch and main edit the SAME file divergently.
    const conflict = setup("conflict", {
      branchFile: "shared.txt",
      cycleBody: "cycle version",
      mainExtra: { file: "shared.txt", body: "main version" },
    });
    await fetchRemoteBranch(conflict.clone, conflict.cycleBranch);
    expect(await branchCleanlyRebasesOntoMain(conflict.clone, conflict.cycleBranch)).toBe(false);
  });

  it("worktreeResetHard fetches + reset --hard onto the resume ref so the prior work appears in the tree", async () => {
    // The clone is on main (no feat.txt); the resume ref carries it. After the
    // re-point, the tracked tree carries the prior cycle's file.
    const { clone, cycleBranch } = setup("reset", { branchFile: "git-hooks.ts", cycleBody: "prior work" });
    expect(existsSync(join(clone, "git-hooks.ts"))).toBe(false);
    const r = await worktreeResetHard(clone, `origin/${cycleBranch}`, cycleBranch);
    expect(r.code).toBe(0);
    expect(existsSync(join(clone, "git-hooks.ts"))).toBe(true);
    expect(W(clone, "show", "-s", "--format=%s", "HEAD")).toBe("prior cycle work");
  });

  it("worktreeResetHard returns a non-zero code for an unfetchable branch (caller stays fresh)", async () => {
    const { clone } = setup("reset-miss", { branchFile: "x.txt", cycleBody: "x" });
    const r = await worktreeResetHard(clone, "origin/loop/cycle-missing", "loop/cycle-missing");
    expect(r.code).not.toBe(0);
  });

  it("branchMergedIntoMain honors a custom integrationBranch (default stays origin/main)", async () => {
    // origin has two integration branches: main (unchanged) and release, into
    // which the cycle branch is merged. The probe must consult whichever
    // integration branch it is told, defaulting to origin/main.
    const { clone, cycleBranch } = setup("custom-merged", { branchFile: "feat.txt", cycleBody: "work" });
    const originPath = W(clone, "remote", "get-url", "origin");
    W(originPath, "branch", "release", "main");
    W(originPath, "checkout", "-q", "release");
    W(originPath, "merge", "-q", "--no-ff", cycleBranch, "-m", "merge into release");
    W(originPath, "checkout", "-q", "main");
    W(clone, "fetch", "-q", "origin");
    await fetchRemoteBranch(clone, cycleBranch);
    // Default (origin/main): NOT merged there.
    expect(await branchMergedIntoMain(clone, cycleBranch)).toBe(false);
    // Custom integration branch origin/release: IS merged there.
    expect(await branchMergedIntoMain(clone, cycleBranch, "origin/release")).toBe(true);
  });

  it("branchCleanlyRebasesOntoMain honors a custom integrationBranch", async () => {
    // A clean branch rebases onto whichever integration branch is named.
    const clean = setup("custom-rebase", {
      branchFile: "feat.txt",
      cycleBody: "feat work",
      mainExtra: { file: "other.txt", body: "unrelated main change" },
    });
    const originPath = W(clean.clone, "remote", "get-url", "origin");
    W(originPath, "branch", "release", "main");
    W(clean.clone, "fetch", "-q", "origin");
    await fetchRemoteBranch(clean.clone, clean.cycleBranch);
    expect(await branchCleanlyRebasesOntoMain(clean.clone, clean.cycleBranch, "origin/release")).toBe(true);
  });
});

describe("resolveIntegrationBranch", () => {
  it("defaults to origin/main when no config file exists", () => {
    const d = tmp("rib-default");
    expect(resolveIntegrationBranch(d)).toBe("origin/main");
  });
  it("returns the configured integration_branch from .roll/local.yaml", () => {
    const d = tmp("rib-config");
    mkdirSync(join(d, ".roll"), { recursive: true });
    writeFileSync(join(d, ".roll", "local.yaml"), "integration_branch: origin/dev\n", "utf8");
    expect(resolveIntegrationBranch(d)).toBe("origin/dev");
  });
});

// E6-A: smart submodule-aware defaults for integration_branch. Unset config in a
// submodule CONTEXT (superproject with .gitmodules, OR a submodule checkout) on a
// branch → default to that current branch. Normal repos are untouched.
describe("resolveIntegrationBranch — E6 submodule smart default", () => {
  it("normal repo (no .gitmodules, not a submodule) still defaults to origin/main — ZERO regression", () => {
    // initRepo makes a plain repo on `main` with no submodule context.
    const d = initRepo("rib-plain");
    expect(resolveIntegrationBranch(d)).toBe("origin/main");
  });

  it("submodule SUPERPROJECT (has .gitmodules) on a branch → defaults to the current branch", () => {
    const { superproject } = superprojectWithSubmodule("rib-super");
    g(superproject, "checkout", "-q", "-b", "contractor2.0");
    expect(resolveIntegrationBranch(superproject)).toBe("contractor2.0");
  });

  it("a SUBMODULE checkout (--show-superproject-working-tree non-empty) on a branch → its current branch", () => {
    const { superproject, submoduleName } = superprojectWithSubmodule("rib-sub");
    const submodulePath = join(superproject, submoduleName);
    // The real user checkout of the submodule sits on its integration branch.
    g(submodulePath, "checkout", "-q", "feat/contractor2.0");
    expect(resolveIntegrationBranch(submodulePath)).toBe("feat/contractor2.0");
  });

  it("submodule superproject in DETACHED HEAD → falls back to origin/main (no branch to adopt)", () => {
    const { superproject } = superprojectWithSubmodule("rib-detached");
    g(superproject, "checkout", "-q", "--detach");
    expect(resolveIntegrationBranch(superproject)).toBe("origin/main");
  });

  it("explicit integration_branch config still WINS over the submodule smart default (precedence intact)", () => {
    const { superproject } = superprojectWithSubmodule("rib-explicit");
    g(superproject, "checkout", "-q", "-b", "contractor2.0");
    mkdirSync(join(superproject, ".roll"), { recursive: true });
    writeFileSync(join(superproject, ".roll", "local.yaml"), "integration_branch: origin/release\n", "utf8");
    expect(resolveIntegrationBranch(superproject)).toBe("origin/release");
  });
});

describe("resolvePublishMode — E3", () => {
  it("defaults to remote when no config file exists (zero regression)", () => {
    const d = tmp("pm-default");
    expect(resolvePublishMode(d)).toBe("remote");
  });
  it("returns local when publish_mode: local is set", () => {
    const d = tmp("pm-local");
    mkdirSync(join(d, ".roll"), { recursive: true });
    writeFileSync(join(d, ".roll", "local.yaml"), "publish_mode: local\n", "utf8");
    expect(resolvePublishMode(d)).toBe("local");
  });
  it("falls back to remote for any unrecognized value (never silently disables remote)", () => {
    const d = tmp("pm-garbage");
    mkdirSync(join(d, ".roll"), { recursive: true });
    writeFileSync(join(d, ".roll", "local.yaml"), "publish_mode: offline\n", "utf8");
    expect(resolvePublishMode(d)).toBe("remote");
  });
});

// E6-A: submodule superproject with UNSET publish_mode → local (remote submodule
// delivery is not implemented; local is the only working mode). Normal repos and
// explicit config are untouched.
describe("resolvePublishMode — E6 submodule smart default", () => {
  it("normal repo (no .gitmodules) still defaults to remote — ZERO regression", () => {
    const d = initRepo("pm-plain");
    expect(resolvePublishMode(d)).toBe("remote");
  });

  it("submodule SUPERPROJECT (has .gitmodules) → defaults to local", () => {
    const { superproject } = superprojectWithSubmodule("pm-super");
    expect(resolvePublishMode(superproject)).toBe("local");
  });

  it("explicit publish_mode: remote config still WINS over the submodule smart default", () => {
    const { superproject } = superprojectWithSubmodule("pm-explicit");
    mkdirSync(join(superproject, ".roll"), { recursive: true });
    writeFileSync(join(superproject, ".roll", "local.yaml"), "publish_mode: remote\n", "utf8");
    expect(resolvePublishMode(superproject)).toBe("remote");
  });
});

describe("canonicalProjectPath", () => {
  it("resolves a worktree to its OWN toplevel (FIX-201; supersedes FIX-034)", async () => {
    // FIX-034's main-tree canonicalization hijacked sibling dev worktrees onto
    // the frozen v2 checkout — identity is now the current worktree's toplevel.
    const main = initRepo("canonmain");
    const wt = join(tmp("canonwt"), "wt");
    execFileSync("git", ["worktree", "add", "-q", wt, "-b", "side"], { cwd: main });
    const canon = await canonicalProjectPath(wt);
    expect(canon).toBe(realpathSync(wt));
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: main });
  });

  it("leaves a plain main-tree path canonical (modulo realpath)", async () => {
    const main = initRepo("canonplain");
    expect(await canonicalProjectPath(main)).toBe(main);
  });
});

describe("projectIdentity", () => {
  it("slug matches @roll/spec projectSlug for a remote-backed repo", async () => {
    const repo = initRepo("identity");
    execFileSync("git", ["remote", "add", "origin", "https://github.com/SeanYao/Some.Project.git"], { cwd: repo });
    const id = await projectIdentity(repo);
    expect(id.path).toBe(repo);
    expect(id.slug).toBe(projectSlug({ path: repo, remoteUrl: "https://github.com/SeanYao/Some.Project.git" }));
  });

  it("no-remote repo → path-based slug", async () => {
    const repo = initRepo("identity-noremote");
    const id = await projectIdentity(repo);
    expect(id.slug).toBe(projectSlug({ path: repo, remoteUrl: undefined }));
  });

  it("ROLL_MAIN_SLUG override short-circuits", async () => {
    const repo = initRepo("identity-override");
    const save = process.env["ROLL_MAIN_SLUG"];
    process.env["ROLL_MAIN_SLUG"] = "main-deadbe";
    try {
      const id = await projectIdentity(repo);
      expect(id.slug).toBe("main-deadbe");
    } finally {
      if (save === undefined) delete process.env["ROLL_MAIN_SLUG"];
      else process.env["ROLL_MAIN_SLUG"] = save;
    }
  });
});

// ─── E3: landLocalDelivery — local-only landing onto the integration branch ───

/** git helper for the tests (repo-local identity, no global config). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function sha(cwd: string, ref = "HEAD"): string {
  return g(cwd, "rev-parse", ref);
}
function branchSha(repo: string, branch: string): string {
  return g(repo, "rev-parse", `refs/heads/${branch}`);
}

/**
 * Build a repo with `main` + a DETACHED cycle worktree branched off it, then
 * add a cycle commit in the worktree. Returns the repo + worktree paths and the
 * base SHA of `main`.
 */
async function repoWithCycleWorktree(tag: string): Promise<{ repo: string; wt: string; baseSha: string }> {
  const repo = initRepo(tag);
  writeFileSync(join(repo, "README.md"), "# base\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "base");
  const baseSha = sha(repo);
  const wtParent = tmp(`${tag}-wtside`);
  const wt = join(wtParent, "wt");
  const add = await worktreeAdd(repo, wt, `loop/cycle-${tag}`, "main");
  expect(add.code).toBe(0);
  // one cycle commit in the (detached) worktree
  writeFileSync(join(wt, "feature.txt"), "cycle work\n");
  g(wt, "add", "-A");
  g(wt, "commit", "-q", "-m", "tcr: cycle work");
  return { repo, wt, baseSha };
}

describe("landLocalDelivery — E3 local-only landing", () => {
  it("fast-forwards the LOCAL integration branch to the cycle HEAD (strips origin/)", async () => {
    const { repo, wt } = await repoWithCycleWorktree("land-ff");
    const cycleSha = sha(wt);
    // integration branch expressed as origin/main → local landing branch is `main`
    const r = await landLocalDelivery(repo, wt, "origin/main");
    expect(r.code).toBe(0);
    expect(r.landedBranch).toBe("main");
    expect(r.method).toBe("fast_forward");
    expect(r.sha).toBe(cycleSha);
    // the LOCAL main now points at the cycle commit — no push, ref moved locally
    expect(branchSha(repo, "main")).toBe(cycleSha);
  });

  it("creates the local integration branch when it does not exist yet", async () => {
    const { repo, wt } = await repoWithCycleWorktree("land-create");
    const cycleSha = sha(wt);
    const r = await landLocalDelivery(repo, wt, "integration");
    expect(r.code).toBe(0);
    expect(r.landedBranch).toBe("integration");
    expect(r.method).toBe("created");
    expect(branchSha(repo, "integration")).toBe(cycleSha);
  });

  it("merges (merge commit) when the local integration branch has diverged", async () => {
    const { repo, wt } = await repoWithCycleWorktree("land-merge");
    const cycleSha = sha(wt);
    // advance LOCAL main independently so it is NOT an ancestor of the cycle HEAD
    writeFileSync(join(repo, "other.txt"), "divergent main work\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "divergent main");
    const mainBefore = branchSha(repo, "main");

    const r = await landLocalDelivery(repo, wt, "origin/main");
    expect(r.code).toBe(0);
    expect(r.landedBranch).toBe("main");
    expect(r.method).toBe("merge");
    // a NEW merge commit whose parents include both the diverged main and the cycle HEAD
    const mainAfter = branchSha(repo, "main");
    expect(mainAfter).not.toBe(mainBefore);
    expect(mainAfter).not.toBe(cycleSha);
    const parents = g(repo, "rev-list", "--parents", "-n", "1", mainAfter).split(" ").slice(1);
    expect(parents).toContain(mainBefore);
    expect(parents).toContain(cycleSha);
    // both the divergent main file and the cycle file are present in the merged tree
    expect(g(repo, "cat-file", "-t", `${mainAfter}:other.txt`)).toBe("blob");
    expect(g(repo, "cat-file", "-t", `${mainAfter}:feature.txt`)).toBe("blob");
  });

  it("reports a non-zero code when the worktree HEAD cannot be resolved", async () => {
    const repo = initRepo("land-bad");
    // point at a non-worktree dir → rev-parse HEAD fails
    const r = await landLocalDelivery(repo, join(repo, "does-not-exist"), "origin/main");
    expect(r.code).not.toBe(0);
  });
});

// ─── E2: submodule-aware worktree (worktree OF a git submodule) ───────────────

/**
 * Build a superproject that embeds a real git submodule.
 *   - `submodule` repo: standalone repo with a `feat/contractor2.0` branch.
 *   - `superproject` repo: embeds it at path `sub` via `git submodule add`,
 *     then commits the `.gitmodules` + gitlink.
 * Returns the superproject path and the submodule NAME (its path in .gitmodules).
 */
function superprojectWithSubmodule(tag: string): { superproject: string; submoduleName: string; subUpstream: string } {
  // The upstream the submodule is cloned from (a bare-ish local origin).
  const subUpstream = initRepo(`${tag}-subupstream`);
  writeFileSync(join(subUpstream, "sub-file.txt"), "sub base\n");
  g(subUpstream, "add", "-A");
  g(subUpstream, "commit", "-q", "-m", "sub base");
  // Give the submodule an integration branch to land onto (feat/contractor2.0).
  g(subUpstream, "branch", "feat/contractor2.0");

  const superproject = initRepo(`${tag}-super`);
  // `git submodule add` needs a file:// URL or path; use the local path.
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", subUpstream, "sub"], {
    cwd: superproject,
  });
  // A real initialized submodule that the user is developing on has its
  // integration branch as a LOCAL branch. A fresh `submodule add` only tracks it
  // as origin/feat/contractor2.0, so materialize the local branch (mirrors the
  // user's real dukang-service-online checkout on feat/contractor2.0).
  const submoduleClone = join(superproject, "sub");
  g(submoduleClone, "config", "user.email", "t@t");
  g(submoduleClone, "config", "user.name", "t");
  g(submoduleClone, "branch", "feat/contractor2.0", "origin/feat/contractor2.0");
  g(superproject, "add", "-A");
  g(superproject, "commit", "-q", "-m", "add submodule sub");
  return { superproject, submoduleName: "sub", subUpstream };
}

describe("submoduleWorktreePath — E2 path derivation", () => {
  // E5 (real-pilot fix): the submodule cycle worktree must NOT live UNDER the
  // superproject cycle worktree — `<cycle>/<sub>` is exactly the superproject
  // worktree's own submodule mount point, so `git worktree add` there collides.
  // The path moves to a SIBLING: `<cycle>.submodules/<sub>`.
  it("places the submodule worktree in a SIBLING dir, not under the cycle worktree (E5)", () => {
    const cycle = "/tmp/loop/worktrees/cycle-x";
    const p = submoduleWorktreePath(cycle, "dukang-service-online");
    // Not a descendant of the superproject cycle worktree (no path collision).
    expect(p.startsWith(`${cycle}/`)).toBe(false);
    expect(p).not.toBe(join(cycle, "dukang-service-online"));
    // Deterministic sibling formula: <cycle>.submodules/<sub>.
    expect(p).toBe(join("/tmp/loop/worktrees", "cycle-x.submodules", "dukang-service-online"));
  });

  it("is deterministic — same inputs derive the same path (create/land/exec share it)", () => {
    const cycle = "/tmp/loop/worktrees/cycle-42";
    const a = submoduleWorktreePath(cycle, "sub");
    const b = submoduleWorktreePath(cycle, "sub");
    expect(a).toBe(b);
  });
});

describe("worktreeAddInSubmodule — E2 worktree of a submodule", () => {
  it("creates a DETACHED worktree ON the submodule repo, sharing its object store", async () => {
    const { superproject, submoduleName } = superprojectWithSubmodule("subwt");
    const wtParent = tmp("subwt-side");
    const cycleWt = join(wtParent, "cycle");

    const r = await worktreeAddInSubmodule(superproject, submoduleName, cycleWt, "feat/contractor2.0");
    expect(r.code).toBe(0);

    // The worktree lives at <cycleWt>/<submoduleName> and is a real checkout.
    const subWt = submoduleWorktreePath(cycleWt, submoduleName);
    expect(existsSync(join(subWt, "sub-file.txt"))).toBe(true);

    // Shared object store proof: a commit made in the worktree is visible to the
    // ACTUAL submodule checkout (git -C <super>/<sub> rev-parse) — the whole
    // point of a worktree-of-submodule vs a sibling clone.
    writeFileSync(join(subWt, "cycle-work.txt"), "cycle\n");
    g(subWt, "add", "-A");
    g(subWt, "commit", "-q", "-m", "tcr: cycle work in submodule");
    const cycleSha = sha(subWt);
    const submodulePath = join(superproject, submoduleName);
    expect(g(submodulePath, "cat-file", "-t", cycleSha)).toBe("commit");
  });

  it("fails loud when the submodule is not declared in .gitmodules", async () => {
    const repo = initRepo("subwt-missing");
    const wt = join(tmp("subwt-missing-side"), "cycle");
    const r = await worktreeAddInSubmodule(repo, "nonexistent-sub", wt, "main");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/submodule/i);
  });

  it("fails loud when the submodule is declared but not initialized (no gitdir)", async () => {
    const { superproject, submoduleName } = superprojectWithSubmodule("subwt-uninit");
    // De-init the submodule so its working tree/gitdir is gone but .gitmodules
    // still declares it.
    execFileSync("git", ["submodule", "deinit", "-f", submoduleName], { cwd: superproject });
    execFileSync("rm", ["-rf", join(superproject, submoduleName)]);
    const wt = join(tmp("subwt-uninit-side"), "cycle");
    const r = await worktreeAddInSubmodule(superproject, submoduleName, wt, "feat/contractor2.0");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/initiali[sz]ed|not.*init/i);
  });
});
