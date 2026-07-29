import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryIdFromRemote } from "@roll/spec";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }
const roots: string[] = [];
const ENV_KEYS = ["HOME", "ROLL_HOME", "ROLL_LANG", "NO_COLOR"] as const;

/** Restore owner write permission across an entire fixture root before test
 *  cleanup — a read-only Issue worktree (real filesystem write-denial, not
 *  just a detached HEAD) would otherwise make `rmSync(recursive)` fail with
 *  EACCES on its protected files/directories. */
function restoreWritePermissions(root: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(root);
  } catch {
    return;
  }
  chmodSync(root, stat.mode | 0o200);
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(root)) restoreWritePermissions(join(root, name));
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function materializeRemote(source: string, remote: string): void {
  mkdirSync(source, { recursive: true });
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.email", "roll@example.test"]);
  git(source, ["config", "user.name", "Roll Test"]);
  writeFileSync(join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "fixture"]);
  mkdirSync(dirname(remote), { recursive: true });
  git(dirname(remote), ["clone", "-q", "--bare", source, remote]);
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-issue-cli-"));
  roots.push(home);
  const rollHome = join(home, ".roll");
  const workspace = join(home, "workspace");
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });

  const sotRemote = join(home, "sot.git");
  const readRemote = join(home, "read.git");
  materializeRemote(join(home, "sot-source"), sotRemote);
  materializeRemote(join(home, "read-source"), readRemote);
  const sotUrl = `file://${sotRemote}`;
  const readUrl = `file://${readRemote}`;
  const sotRepoId = repositoryIdFromRemote(sotUrl);
  const readRepoId = repositoryIdFromRemote(readUrl);
  if (!sotRepoId.ok || !readRepoId.ok) throw new Error("fixture remotes must be valid");

  const config = join(home, "workspace-create.yaml");
  writeFileSync(config, `
schema: roll.workspace-create/v1
id: ws-demo
root: ${workspace}
display_name: Demo Workspace
repositories:
  - alias: sot
    source: ${sotUrl}
    integration_branch: main
  - alias: docs
    source: ${readUrl}
    integration_branch: main
`, "utf8");

  return { home, rollHome, workspace, config, cwd, sotRepoId: sotRepoId.value, readRepoId: readRepoId.value };
}

/** Write the Story Contract INSIDE the Workspace's own backlog tree
 *  (`backlog/**\/<story-id>/spec.md`) — its only valid runtime home. Called
 *  after `workspace create` so it never collides with the fresh-workspace plan. */
function writeBacklogStorySpec(f: ReturnType<typeof fixture>, storyId = "US-XX1"): void {
  const backlogStoryDir = join(f.workspace, "backlog", "workspace-orchestration", storyId);
  mkdirSync(backlogStoryDir, { recursive: true });
  writeFileSync(join(backlogStoryDir, "spec.md"), `---
id: ${storyId}
repositories:
  - alias: sot
    access: write
    required_delivery: true
  - alias: docs
    access: read
---

# ${storyId} fixture story
`, "utf8");
}

async function run(args: string[], f: ReturnType<typeof fixture>, opts: { lang?: "en" | "zh" } = {}): Promise<Run> {
  const saved: Partial<Record<typeof ENV_KEYS[number], string>> = {};
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) saved[key] = process.env[key];
  }
  process.env["HOME"] = f.home;
  process.env["ROLL_HOME"] = f.rollHome;
  process.env["ROLL_LANG"] = opts.lang ?? "en";
  process.env["NO_COLOR"] = "1";
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const savedCwd = process.cwd();
  // @ts-expect-error capture seam
  process.stdout.write = (chunk: string | Uint8Array): boolean => { stdout += String(chunk); return true; };
  // @ts-expect-error capture seam
  process.stderr.write = (chunk: string | Uint8Array): boolean => { stderr += String(chunk); return true; };
  process.chdir(f.cwd);
  try {
    const result = await dispatch(args, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    process.chdir(savedCwd);
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

beforeEach(() => registerAll());
afterEach(() => {
  for (const root of roots.splice(0)) {
    restoreWritePermissions(root);
    rmSync(root, { recursive: true, force: true });
  }
});

async function initWorkspace(f: ReturnType<typeof fixture>): Promise<void> {
  const result = await run(["workspace", "create", "ws-demo", "--config", f.config, "--json"], f);
  expect(result.status, result.stderr).toBe(0);
}

/** Scrub every volatile (host path, git SHA, timestamp) fragment from a
 *  captured JSON contract so the frozen snapshot is stable across machines
 *  and runs. */
function scrub(text: string, f: ReturnType<typeof fixture>): string {
  return text
    .replaceAll(realpathSync(f.home), "<HOME>")
    .replaceAll(f.home, "<HOME>")
    .replace(/"repoId":\s*"repo-[0-9a-f]{12}"/g, '"repoId": "<REPO_ID>"')
    .replace(/"baseSha":\s*"[0-9a-f]{40}"/g, '"baseSha": "<SHA>"')
    .replace(/"ts":\s*\d+/g, '"ts": "<TS>"')
    .replace(/repo-[0-9a-f]{12}\.git/g, "<REPO_ID>.git");
}

describe("US-WS-008 roll workspace issue init", () => {
  it("resolves the Story contract and creates real worktrees across two repositories, then reuses them idempotently", async () => {
    const f = fixture();
    await initWorkspace(f);
    writeBacklogStorySpec(f);

    const check = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--check", "--json"], f);
    expect(check.status, check.stderr).toBe(0);
    const checkView = JSON.parse(check.stdout) as { report: { manifest: { state: string }; targets: Record<string, { decision: string; access: string; workBranch: string | null }> } };
    expect(checkView.report.manifest.state).toBe("absent");
    expect(checkView.report.targets["sot"]).toMatchObject({ decision: "created", access: "write" });
    expect(checkView.report.targets["docs"]).toMatchObject({ decision: "created", access: "read", workBranch: null });
    expect(existsSync(join(f.workspace, "issues", "US-XX1"))).toBe(false);

    const apply = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(apply.status, apply.stderr).toBe(0);
    const applyView = JSON.parse(apply.stdout) as { outcome: string; manifest: { schema: string; repositories: readonly unknown[] } };
    expect(applyView.outcome).toBe("created");
    expect(applyView.manifest).toMatchObject({ schema: "roll.issue/v1", workspaceId: "ws-demo", storyId: "US-XX1" });
    const issueRoot = join(f.workspace, "issues", "US-XX1");
    expect(existsSync(join(issueRoot, "sot", ".git"))).toBe(true);
    expect(existsSync(join(issueRoot, "docs", ".git"))).toBe(true);
    expect(existsSync(join(issueRoot, "manifest.json"))).toBe(true);
    expect(existsSync(join(issueRoot, "events.jsonl"))).toBe(true);
    const events = readFileSync(join(issueRoot, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).toMatchObject({ type: "issue:repository_bound", storyId: "US-XX1" });

    const reused = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(reused.status, reused.stderr).toBe(0);
    expect(JSON.parse(reused.stdout)).toMatchObject({ outcome: "reused" });

    const recheck = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--check", "--json"], f);
    expect(recheck.status, recheck.stderr).toBe(0);
    const recheckView = JSON.parse(recheck.stdout) as { report: { manifest: { state: string }; targets: Record<string, { decision: string }> } };
    expect(recheckView.report.manifest.state).toBe("compatible");
    expect(recheckView.report.targets["sot"]).toMatchObject({ decision: "reused" });
    expect(recheckView.report.targets["docs"]).toMatchObject({ decision: "reused" });
  });

  it("denies filesystem writes to the read-only target's product files as a normal process, while the write target stays writable", async () => {
    const f = fixture();
    await initWorkspace(f);
    writeBacklogStorySpec(f);

    const apply = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(apply.status, apply.stderr).toBe(0);
    const issueRoot = join(f.workspace, "issues", "US-XX1");
    const readCheckoutPath = join(issueRoot, "docs");
    const writeCheckoutPath = join(issueRoot, "sot");

    // Real product file already checked out by `git worktree add` — attempting
    // to modify it as a NORMAL process (no git plumbing involved) must be
    // denied at the filesystem level, not merely blocked from being committed.
    const existingProductFile = join(readCheckoutPath, "README.md");
    expect(existsSync(existingProductFile)).toBe(true);
    expect(() => writeFileSync(existingProductFile, "mutated\n", { flag: "r+" })).toThrow(/EACCES|EPERM/);

    // Creating a NEW product file inside the read-only checkout must also be denied.
    const newProductFile = join(readCheckoutPath, "new-file.txt");
    expect(() => writeFileSync(newProductFile, "new\n")).toThrow(/EACCES|EPERM/);
    expect(existsSync(newProductFile)).toBe(false);

    // The WRITE target's checkout is unaffected — both an existing-file edit
    // and a new-file creation succeed normally.
    const writeProductFile = join(writeCheckoutPath, "README.md");
    writeFileSync(writeProductFile, "mutated\n", { flag: "r+" });
    expect(readFileSync(writeProductFile, "utf8")).toBe("mutated\n");
    const newWriteFile = join(writeCheckoutPath, "new-file.txt");
    writeFileSync(newWriteFile, "new\n");
    expect(existsSync(newWriteFile)).toBe(true);

    // Restore permissions before the fixture's own teardown so a re-run or a
    // Roll cleanup pass can still remove the read-only checkout cleanly.
    restoreWritePermissions(readCheckoutPath);
    const reused = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(reused.status, reused.stderr).toBe(0);
  });

  it("re-applies write-denial to a reused read-only target whose permissions were restored/tampered with", async () => {
    const f = fixture();
    await initWorkspace(f);
    writeBacklogStorySpec(f);

    const apply = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(apply.status, apply.stderr).toBe(0);
    const issueRoot = join(f.workspace, "issues", "US-XX1");
    const readCheckoutPath = join(issueRoot, "docs");

    // Tamper: restore write permissions as if an external process had done so.
    restoreWritePermissions(readCheckoutPath);
    const existingProductFile = join(readCheckoutPath, "README.md");
    writeFileSync(existingProductFile, "tampered write while unprotected\n", "utf8");
    expect(readFileSync(existingProductFile, "utf8")).toBe("tampered write while unprotected\n");

    // Re-running `issue init` against the SAME Story must detect this target
    // as "reused" (its worktree already exists compatibly) and STILL
    // re-apply the real filesystem write-denial — protection must not depend
    // on the target having been freshly created in the current run.
    const reused = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(reused.status, reused.stderr).toBe(0);
    expect(JSON.parse(reused.stdout)).toMatchObject({ outcome: "reused" });

    expect(() => writeFileSync(existingProductFile, "mutated again\n", { flag: "r+" })).toThrow(/EACCES|EPERM/);
    const newProductFile = join(readCheckoutPath, "new-file-after-reprotect.txt");
    expect(() => writeFileSync(newProductFile, "new\n")).toThrow(/EACCES|EPERM/);
    expect(existsSync(newProductFile)).toBe(false);

    restoreWritePermissions(readCheckoutPath);
  });

  it("resolves no target and creates nothing when the second repository's remote is unreachable at cache-resolution time", async () => {
    const f = fixture();
    await initWorkspace(f);
    writeBacklogStorySpec(f);

    // Fault injection: destroy the SECOND repository's source remote entirely
    // (a real, unmocked failure). ALL targets' caches must resolve before the
    // Issue root is created or mutated, so this must leave zero trace.
    rmSync(join(f.home, "read.git"), { recursive: true, force: true });

    const failed = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stderr)).toMatchObject({ error: { code: "apply_failed" } });
    expect(existsSync(join(f.workspace, "issues", "US-XX1"))).toBe(false);

    // Repair: restore the remote and re-run — the same CLI contract converges.
    // The Issue root itself was never created, but the READ target's
    // repository cache was left interrupted mid-resolution, so the overall
    // outcome is honestly "repaired" (a cache-level repair), not "created".
    execFileSync("git", ["clone", "-q", "--bare", join(f.home, "read-source"), join(f.home, "read.git")], { stdio: "ignore" });
    const repaired = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ outcome: "repaired" });
    const issueRoot = join(f.workspace, "issues", "US-XX1");
    expect(existsSync(join(issueRoot, "sot", ".git"))).toBe(true);
    expect(existsSync(join(issueRoot, "docs", ".git"))).toBe(true);
  });

  it("rejects a SECOND target's pre-existing governed branch before creating the first target", async () => {
    const f = fixture();
    await initWorkspace(f);
    // This fault needs the SECOND target to be a WRITE target too, so its
    // governed branch can genuinely collide with an already-existing branch
    // during the complete preflight. `docs`
    // is declared write-access ONLY for this one story id; every other test
    // in this file keeps it read-access.
    const storyId = "US-FAULT1";
    const backlogStoryDir = join(f.workspace, "backlog", "workspace-orchestration", storyId);
    mkdirSync(backlogStoryDir, { recursive: true });
    writeFileSync(join(backlogStoryDir, "spec.md"), `---
id: ${storyId}
repositories:
  - alias: sot
    access: write
    required_delivery: true
  - alias: docs
    access: write
    required_delivery: true
---

# ${storyId} fixture story
`, "utf8");

    // Warm docs's real machine cache through a SEPARATE throwaway Story/apply
    // — leaves that throwaway Issue/worktree completely untouched; its only
    // purpose is to make docs's bare cache exist on disk before we simulate
    // an independent external process below.
    const throwawayStoryId = "US-FAULT1-WARMUP";
    const throwawayDir = join(f.workspace, "backlog", "workspace-orchestration", throwawayStoryId);
    mkdirSync(throwawayDir, { recursive: true });
    writeFileSync(join(throwawayDir, "spec.md"), `---
id: ${throwawayStoryId}
repositories:
  - alias: docs
    access: write
    required_delivery: true
---

# ${throwawayStoryId} cache-warmup fixture story (left untouched)
`, "utf8");
    const warmup = await run(["workspace", "issue", "init", throwawayStoryId, "--workspace", "ws-demo", "--json"], f);
    expect(warmup.status, warmup.stderr).toBe(0);
    const throwawayIssueRoot = join(f.workspace, "issues", throwawayStoryId);

    // Simulate an INDEPENDENT external process creating the TARGET story's
    // governed branch directly in docs's real bare cache — a real, unmocked
    // pre-existing fact with zero deletion of any Issue/worktree/manifest/
    // event state anywhere. Its history is made to DIVERGE from the pinned
    // base (an unrelated orphan root commit) so this is a genuinely
    // non-recoverable collision, not an orphan branch recovery could
    // legitimately reuse: orphan governed branch recovery (US-WS-008) only
    // ever reuses a same-named branch when the pinned base is confirmed an
    // ANCESTOR of its tip, so this branch's diverged history must make the
    // preflight itself fail loud before any target is mutated.
    const docsCachePath = join(f.rollHome, "repos", `${f.readRepoId}.git`);
    const targetBranch = `roll/ws-demo/${storyId}/docs`;
    const scratchDir = join(f.home, "docs-branch-scratch");
    execFileSync("git", ["clone", "-q", docsCachePath, scratchDir], { cwd: f.home, stdio: "ignore" });
    execFileSync("git", ["checkout", "-q", "--orphan", targetBranch], { cwd: scratchDir, stdio: "ignore" });
    execFileSync("git", ["reset", "-q", "--hard"], { cwd: scratchDir, stdio: "ignore" });
    execFileSync("rm", ["-rf", join(scratchDir, "README.md")], { stdio: "ignore" });
    writeFileSync(join(scratchDir, "unrelated.txt"), "unrelated root commit\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: scratchDir, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=roll@example.test", "-c", "user.name=Roll Test", "commit", "-q", "-m", "unrelated root commit"], { cwd: scratchDir, stdio: "ignore" });
    execFileSync("git", ["push", docsCachePath, `${targetBranch}:${targetBranch}`], { cwd: scratchDir, stdio: "ignore" });

    // The complete multi-target preflight sees docs's conflict before any
    // Issue mutation. In particular, the earlier sot target must never be
    // created merely because it appears first in the Story contract.
    const failed = await run(["workspace", "issue", "init", storyId, "--workspace", "ws-demo", "--json"], f);
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stderr)).toMatchObject({ error: { code: "rejected" } });
    // Freeze the COMPLETE rejection payload for a later-target preflight
    // conflict — not just a MatchObject subset — so any
    // unintended shape drift (a dropped field, an added one, a changed
    // message) is caught even where the subset check above would stay green.
    expect(scrub(failed.stderr, f)).toMatchSnapshot("later-target-preflight-rejected-json");

    const issueRoot = join(f.workspace, "issues", storyId);
    expect(existsSync(issueRoot)).toBe(false);

    // The throwaway warmup Issue and its real worktree are completely
    // unaffected by the rejected target Story's preflight.
    expect(existsSync(join(throwawayIssueRoot, "docs", ".git"))).toBe(true);

    // Repair: delete only the deliberately-injected colliding branch, then
    // re-run — the same CLI contract converges.
    execFileSync("git", ["branch", "-D", targetBranch], { cwd: docsCachePath, stdio: "ignore" });
    const repaired = await run(["workspace", "issue", "init", storyId, "--workspace", "ws-demo", "--json"], f);
    expect(repaired.status, repaired.stderr).toBe(0);
    // The rejected preflight left no Issue state to repair, so this remains
    // a fresh creation after the external conflict is removed.
    expect(JSON.parse(repaired.stdout)).toMatchObject({ outcome: "created" });
    expect(existsSync(join(issueRoot, "sot", ".git"))).toBe(true);
    expect(existsSync(join(issueRoot, "docs", ".git"))).toBe(true);
    expect(existsSync(join(issueRoot, "issue-init.pending.json"))).toBe(false);
  });

  it("rejects invalid arguments and an unknown story id without any writes", async () => {
    const f = fixture();
    await initWorkspace(f);
    writeBacklogStorySpec(f);
    const invalid = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--unknown", "--json"], f);
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ error: { code: "invalid_arguments" } });

    const missing = await run(["workspace", "issue", "init", "US-NOPE", "--workspace", "ws-demo", "--json"], f);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({ error: { code: "story_not_found" } });
    expect(existsSync(join(f.workspace, "issues", "US-NOPE"))).toBe(false);
  });

  it("rejects a symlinked Issue root (workspace/issues/<story>) escaping the Workspace, with zero writes for both check and apply", async () => {
    const f = fixture();
    await initWorkspace(f);
    writeBacklogStorySpec(f);
    const outsideTarget = join(f.home, "outside-issue-escape");
    mkdirSync(outsideTarget, { recursive: true });
    symlinkSync(outsideTarget, join(f.workspace, "issues", "US-XX1"));

    const check = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--check", "--json"], f);
    expect(check.status, check.stderr).toBe(0);
    expect(JSON.parse(check.stdout).report.manifest.state).toBe("conflict");
    expect(existsSync(join(outsideTarget, "manifest.json"))).toBe(false);

    const apply = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(apply.status).toBe(1);
    expect(JSON.parse(apply.stderr)).toMatchObject({ error: { code: "symlink_escape" } });
    expect(existsSync(join(outsideTarget, "manifest.json"))).toBe(false);
    expect(existsSync(join(outsideTarget, "sot"))).toBe(false);
  });

  it("rejects a symlinked backlog spec.md escaping the Workspace, fail-loud with zero writes", async () => {
    const f = fixture();
    await initWorkspace(f);
    const outsideSpec = join(f.home, "outside-spec.md");
    writeFileSync(outsideSpec, `---
id: US-XX1
repositories:
  - alias: sot
    access: write
    required_delivery: true
---

# planted outside the Workspace — must never be read
`, "utf8");
    const storyDir = join(f.workspace, "backlog", "workspace-orchestration", "US-XX1");
    mkdirSync(storyDir, { recursive: true });
    symlinkSync(outsideSpec, join(storyDir, "spec.md"));

    const result = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "symlink_escape" } });
    expect(existsSync(join(f.workspace, "issues", "US-XX1"))).toBe(false);
  });

  it("never resolves a Story Contract from the caller cwd's .roll/features tree, only from the Workspace's own backlog tree", async () => {
    const f = fixture();
    await initWorkspace(f);
    // Deliberately place a spec in the CALLER cwd's .roll/features layout —
    // this must be completely invisible to the Workspace-scoped resolver.
    const cwdEpicDir = join(f.cwd, ".roll", "features", "workspace-orchestration", "US-XX1");
    mkdirSync(cwdEpicDir, { recursive: true });
    writeFileSync(join(cwdEpicDir, "spec.md"), `---
id: US-XX1
repositories:
  - alias: sot
    access: write
    required_delivery: true
  - alias: docs
    access: read
---

# US-XX1 fixture story (cwd — must be ignored)
`, "utf8");

    const result = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "story_not_found" } });
    expect(existsSync(join(f.workspace, "issues", "US-XX1"))).toBe(false);
  });

  it.each([
    ["dot", "."],
    ["dot-dot", ".."],
    ["traversal", "../../etc/passwd"],
    ["embedded traversal", "US-../../XX1"],
    ["contains slash", "US-XX/1"],
  ])("rejects a %s story id as unsafe before any path use, with zero writes", async (_name, storyId) => {
    const f = fixture();
    await initWorkspace(f);
    const before = readFileSync(f.config, "utf8"); // sentinel: config untouched proves no writes escaped
    const result = await run(["workspace", "issue", "init", storyId, "--workspace", "ws-demo", "--json"], f);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "invalid_story_id" } });
    // The pre-existing empty issues/ dir (from workspace create) must gain no new entries.
    expect(existsSync(join(f.workspace, "issues"))).toBe(true);
    expect(readFileSync(f.config, "utf8")).toBe(before);
    expect(readdirSync(join(f.workspace, "issues"))).toEqual([]);
  });

  it("freezes EN/ZH --help", async () => {
    const workspaceHelp = await run(["workspace", "--help"], fixture(), { lang: "en" });
    expect(workspaceHelp.stdout).toContain("issue init");

    const en = await run(["workspace", "issue", "--help"], fixture(), { lang: "en" });
    expect(en).toMatchObject({ status: 0, stderr: "" });
    expect(en.stdout).toMatchSnapshot("help-en");

    const zh = await run(["workspace", "issue", "--help"], fixture(), { lang: "zh" });
    expect(zh).toMatchObject({ status: 0, stderr: "" });
    expect(zh.stdout).toMatchSnapshot("help-zh");
  });

  it("freezes governed-branch conflict and stale-registration repair check output", async () => {
    const conflictFixture = fixture();
    await initWorkspace(conflictFixture);
    writeBacklogStorySpec(conflictFixture);
    const conflictCache = join(conflictFixture.rollHome, "repos", `${conflictFixture.sotRepoId}.git`);
    git(conflictCache, ["branch", "roll/ws-demo/US-XX1/sot", "refs/remotes/origin/main"]);

    const conflict = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--check", "--json"], conflictFixture);
    expect(conflict).toMatchObject({ status: 0, stderr: "" });
    expect(scrub(conflict.stdout, conflictFixture)).toMatchSnapshot("governed-branch-conflict-json");

    const repairFixture = fixture();
    await initWorkspace(repairFixture);
    writeBacklogStorySpec(repairFixture);
    const created = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], repairFixture);
    expect(created).toMatchObject({ status: 0, stderr: "" });
    const repairCache = join(repairFixture.rollHome, "repos", `${repairFixture.sotRepoId}.git`);
    rmSync(join(repairFixture.workspace, "issues", "US-XX1", "sot"), { recursive: true, force: true });
    expect(git(repairCache, ["worktree", "list", "--porcelain"])).toContain("prunable");

    const repaired = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--check", "--json"], repairFixture);
    expect(repaired).toMatchObject({ status: 0, stderr: "" });
    expect(scrub(repaired.stdout, repairFixture)).toMatchSnapshot("stale-registration-repaired-json");
    expect(git(repairCache, ["worktree", "list", "--porcelain"])).toContain("prunable");
  });

  it("freezes the scrubbed full JSON contract for check/create/reuse/failure", async () => {
    const f = fixture();
    await initWorkspace(f);
    writeBacklogStorySpec(f);

    const check = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--check", "--json"], f);
    expect(check).toMatchObject({ status: 0, stderr: "" });
    expect(scrub(check.stdout, f)).toMatchSnapshot("check-json");

    const created = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(created).toMatchObject({ status: 0, stderr: "" });
    expect(scrub(created.stdout, f)).toMatchSnapshot("created-json");

    const reused = await run(["workspace", "issue", "init", "US-XX1", "--workspace", "ws-demo", "--json"], f);
    expect(reused).toMatchObject({ status: 0, stderr: "" });
    expect(scrub(reused.stdout, f)).toMatchSnapshot("reused-json");

    const failure = await run(["workspace", "issue", "init", "US-NOPE", "--workspace", "ws-demo", "--json"], f);
    expect(failure.status).toBe(1);
    expect(scrub(failure.stderr, f)).toMatchSnapshot("failure-json");
  });
});
