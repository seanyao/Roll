import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MinimalFs, ToolDeps, ToolInvocation, ToolPolicy } from "@roll/spec";
import { afterAll, describe, expect, it } from "vitest";
import {
  GitTool,
  gitTools,
  type GitCommitInput,
  type GitMergeInput,
  type GitPushInput,
  type GitStatusInput,
  type GitStatusOutput,
  type GitToolId,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `roll-infra-git-tool-${tag}-`));
  dirs.push(dir);
  return realpathSync(dir);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(tag: string): string {
  const dir = tmp(tag);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

const policy = (): ToolPolicy => ({ enabled: true, timeoutMs: 1000, sandbox: {} });

function invocation<I>(toolId: GitToolId, input: I): ToolInvocation<I> {
  return {
    invocationId: `inv-${toolId}`,
    toolId: toolId as ToolInvocation<I>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-TOOL-006", agent: "codex" },
    policy: policy(),
    ts: 100,
  };
}

function deps(): ToolDeps {
  const fs: MinimalFs = {
    readFile: async () => "",
    writeFile: async () => undefined,
    mkdir: async () => undefined,
  };
  return {
    fs,
    now: () => 100,
    execFile: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    redact: (value) => value,
  };
}

describe("US-TOOL-006 GitTool", () => {
  it("exposes four git tool declarations with status success events disabled", () => {
    const tools = gitTools();
    expect(tools.map((tool) => tool.declaration.id)).toEqual(["git.commit", "git.status", "git.push", "git.merge"]);
    expect(tools.every((tool) => tool.declaration.kind === "git")).toBe(true);
    expect(tools.find((tool) => tool.declaration.id === "git.status")?.declaration.emitsEvents).toBe(false);
  });

  it("commits staged changes through the existing git commit behavior", async () => {
    const repo = initRepo("commit");
    writeFileSync(join(repo, "file.txt"), "hello\n");
    git(repo, "add", "file.txt");

    const result = await new GitTool("git.commit").execute(
      invocation<GitCommitInput>("git.commit", { cwd: repo, message: "add file" }),
      deps(),
    );

    expect(result).toMatchObject({ ok: true, output: { code: 0 } });
    expect(git(repo, "show", "-s", "--format=%s", "HEAD")).toBe("add file");
  });

  it("reports clean and dirty status without changing output semantics", async () => {
    const repo = initRepo("status");
    const tool = new GitTool("git.status");

    const clean = await tool.execute(invocation<GitStatusInput>("git.status", { cwd: repo }), deps());
    expect(clean.ok).toBe(true);
    if (clean.ok) expect((clean.output as GitStatusOutput).clean).toBe(true);

    writeFileSync(join(repo, "dirty.txt"), "dirty\n");
    const dirty = await tool.execute(invocation<GitStatusInput>("git.status", { cwd: repo }), deps());
    expect(dirty.ok).toBe(true);
    if (dirty.ok) {
      expect((dirty.output as GitStatusOutput).clean).toBe(false);
      expect((dirty.output as GitStatusOutput).stdout).toContain("?? dirty.txt");
    }
  });

  it("pushes a branch to a configured remote", async () => {
    const origin = initRepo("push-origin");
    const repo = tmp("push-clone");
    git(tmp("push-base"), "clone", "-q", origin, repo);
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    git(repo, "checkout", "-q", "-b", "topic");
    writeFileSync(join(repo, "pushed.txt"), "pushed\n");
    git(repo, "add", "pushed.txt");
    git(repo, "commit", "-q", "-m", "pushed");

    const result = await new GitTool("git.push").execute(
      invocation<GitPushInput>("git.push", { cwd: repo, branch: "topic", setUpstream: true }),
      deps(),
    );

    expect(result).toMatchObject({ ok: true, output: { code: 0 } });
    expect(git(origin, "branch", "--list", "topic")).toContain("topic");
  });

  it("surfaces merge conflicts as ok:true with the git exit code and stderr", async () => {
    const repo = initRepo("merge");
    writeFileSync(join(repo, "shared.txt"), "base\n");
    git(repo, "add", "shared.txt");
    git(repo, "commit", "-q", "-m", "base file");
    git(repo, "checkout", "-q", "-b", "topic");
    writeFileSync(join(repo, "shared.txt"), "topic\n");
    git(repo, "commit", "-q", "-am", "topic edit");
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "shared.txt"), "main\n");
    git(repo, "commit", "-q", "-am", "main edit");

    const result = await new GitTool("git.merge").execute(
      invocation<GitMergeInput>("git.merge", { cwd: repo, ref: "topic" }),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.code).not.toBe(0);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  });

  it("init and dispose are no-ops", async () => {
    const tool = new GitTool("git.status");
    const d = deps();

    await expect(tool.init(d)).resolves.toBeUndefined();
    await expect(tool.dispose(d)).resolves.toBeUndefined();
  });
});
