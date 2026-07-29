import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecOpts,
  ExecResult,
  MinimalFs,
  RepositoryExecutionContext,
  ToolDeps,
  ToolInvocation,
  ToolPolicy,
  WorkspaceExecutionContextV1,
} from "@roll/spec";
import { WORKSPACE_EXECUTION_CONTEXT_V1 } from "@roll/spec";
import { REPOSITORY_BINDING_V1 } from "@roll/spec";
import { deriveWorkspaceExecutionAuthorities } from "@roll/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  BashTool,
  FsTool,
  GitTool,
  type BashInput,
  type FsReadInput,
  type FsWriteInput,
  type GitCommitInput,
  type GitStatusInput,
} from "../../src/index.js";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(tag: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `roll-workspace-tool-${tag}-`)));
  dirs.push(dir);
  return dir;
}

function repository(repoId: string, worktreePath: string, access: "read" | "write" = "write"): RepositoryExecutionContext {
  return {
    repoId,
    alias: repoId,
    access,
    requiredDelivery: access === "write",
    ...(access === "write" ? {
      noChangePolicy: "changes_required" as const,
      workBranch: "roll/roll/US-WS-035",
    } : {}),
    worktreePath,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    commands: { test: [], integration: [] },
  };
}

function context(root: string, repositories: readonly RepositoryExecutionContext[]): WorkspaceExecutionContextV1 {
  const issueRoot = join(root, "issues", "US-WS-035");
  const byId = Object.fromEntries(repositories.map((repo) => [repo.repoId, repo]));
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: { workspaceId: "roll", root, canonicalRoot: root, lifecycle: "active" },
    resolution: { source: "explicit", evidence: [] },
    bindings: repositories.map((repo) => ({
      schema: REPOSITORY_BINDING_V1,
      repoId: repo.repoId,
      alias: repo.alias,
      remote: `git@github.com:example/${repo.repoId}.git`,
      integrationBranch: "main",
      provider: "github" as const,
      workflow: { branchPattern: "story/{storyId}", requiredChecks: [] },
    })),
    issue: {
      storyId: "US-WS-035",
      manifestPath: join(issueRoot, "manifest.json"),
      execution: { workspaceId: "roll", issueRoot, repositories: byId },
    },
    authorities: deriveWorkspaceExecutionAuthorities(root),
  };
}

const policy: ToolPolicy = { enabled: true, timeoutMs: 1_000, sandbox: {} };

function bashInvocation(input: BashInput, executionContext?: WorkspaceExecutionContextV1, repoId?: string): ToolInvocation<BashInput> {
  return {
    invocationId: `inv-${repoId ?? "none"}`,
    toolId: "bash" as ToolInvocation<BashInput>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-WS-035", agent: "codex" },
    policy,
    ts: 100,
    context: executionContext,
    repoId,
  };
}

function bashDeps(): ToolDeps & { calls: Array<{ command: string; args: readonly string[]; opts?: ExecOpts }>; files: Map<string, string> } {
  const calls: Array<{ command: string; args: readonly string[]; opts?: ExecOpts }> = [];
  const files = new Map<string, string>();
  const result: ExecResult = { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
  const fs: MinimalFs = {
    readFile: async (path) => files.get(path) ?? "",
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    mkdir: async (path) => {
      files.set(`${path}/`, "");
    },
  };
  return {
    calls,
    files,
    fs,
    now: () => 100,
    execFile: async (command, args, opts) => {
      calls.push({ command, args, opts });
      return result;
    },
    redact: (value) => value.replaceAll("SECRET", "[REDACTED]"),
  };
}

function fsDeps(): ToolDeps {
  return {
    fs: {
      readFile: async (path, encoding = "utf8") => readFileSync(path, encoding),
      writeFile: async (path, data, encoding = "utf8") => writeFileSync(path, data, encoding),
      mkdir: async (path, options) => mkdirSync(path, options),
    },
    now: () => 100,
    execFile: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    redact: (value) => value.replaceAll("SECRET", "[REDACTED]"),
  };
}

function fsInvocation<I>(
  toolId: "filesystem.read" | "filesystem.write",
  input: I,
  executionContext: WorkspaceExecutionContextV1,
  repoId?: string,
): ToolInvocation<I> {
  return {
    invocationId: `inv-${toolId}-${repoId ?? "none"}`,
    toolId: toolId as ToolInvocation<I>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-WS-035", agent: "codex" },
    policy,
    ts: 100,
    context: executionContext,
    repoId,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(tag: string, parent?: string): string {
  const repo = parent === undefined ? tmp(tag) : join(parent, tag);
  if (parent !== undefined) mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

function gitInvocation<I>(
  toolId: "git.status" | "git.commit",
  input: I,
  executionContext?: WorkspaceExecutionContextV1,
  repoId?: string,
): ToolInvocation<I> {
  return {
    invocationId: `inv-${toolId}-${repoId ?? "none"}`,
    toolId: toolId as ToolInvocation<I>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-WS-035", agent: "codex" },
    policy,
    ts: 100,
    context: executionContext,
    repoId,
  };
}

describe("US-WS-035 Workspace-local tool context", () => {
  it("runs bash without cwd only in the unique writable Issue repository", async () => {
    const root = tmp("bash-single");
    const repo = join(root, "issues", "US-WS-035", "product");
    mkdirSync(repo, { recursive: true });
    const executionContext = context(root, [repository("product", repo)]);
    const deps = bashDeps();

    const result = await new BashTool().execute(bashInvocation({ command: "pwd" }, executionContext), deps);

    expect(result).toMatchObject({
      ok: true,
      meta: { correlation: { workspaceId: "roll", storyId: "US-WS-035", repoId: "product" } },
    });
    expect(deps.calls[0]?.opts?.cwd).toBe(repo);
    expect(deps.files.get(join(root, "runtime", "tool-dumps", "inv-none.log"))).toContain("stdout:\nok\n");
  });

  it("rejects missing and ambiguous bash context instead of using ambient cwd or first repo", async () => {
    const root = tmp("bash-ambiguous");
    const first = join(root, "issues", "US-WS-035", "first");
    const second = join(root, "issues", "US-WS-035", "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const executionContext = context(root, [repository("first", first), repository("second", second)]);
    const deps = bashDeps();

    const missing = await new BashTool().execute(bashInvocation({ command: "pwd" }), deps);
    const ambiguous = await new BashTool().execute(bashInvocation({ command: "pwd" }, executionContext), deps);
    const selected = await new BashTool().execute(bashInvocation({ command: "pwd" }, executionContext, "second"), deps);

    expect(missing).toMatchObject({ ok: false, error: { code: "missing_execution_context" } });
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "missing_execution_context" } });
    expect(selected.ok).toBe(true);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]?.opts?.cwd).toBe(second);
  });

  it("rejects bash in a read-only repository without leaking its path", async () => {
    const root = tmp("bash-read-only");
    const repo = join(root, "issues", "US-WS-035", "reference");
    mkdirSync(repo, { recursive: true });
    const executionContext = context(root, [repository("reference", repo, "read")]);
    const deps = bashDeps();

    const result = await new BashTool().execute(bashInvocation({ command: "pwd", cwd: repo }, executionContext, "reference"), deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_execution_context" },
      meta: { correlation: { workspaceId: "roll", storyId: "US-WS-035", repoId: "reference" } },
    });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(deps.calls).toHaveLength(0);
  });

  it("rejects dynamic shell code and bare relative symlinks before process execution", async () => {
    const root = tmp("bash-argv-escape");
    const repo = join(root, "issues", "US-WS-035", "product");
    const outside = tmp("bash-argv-escape-outside");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    symlinkSync(join(outside, "secret.txt"), join(repo, "escape"));
    const executionContext = context(root, [repository("product", repo)]);

    for (const input of [
      { command: "sh", args: ["-c", "cat /etc/passwd"] },
      { command: "node", args: ["--dns-result-order", "ipv4first", "-e", "require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "cat", args: ["escape"] },
    ]) {
      const deps = bashDeps();
      const result = await new BashTool().execute(bashInvocation({ ...input, cwd: repo }, executionContext), deps);

      expect(result).toMatchObject({ ok: false, error: { code: "sandbox_denied" } });
      expect(deps.calls).toHaveLength(0);
    }
  });

  it("contains filesystem writes to the selected repository and never treats Workspace metadata as a generic root", async () => {
    const root = tmp("filesystem-write");
    const repo = join(root, "issues", "US-WS-035", "product");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "result.txt"), "before");
    const executionContext = context(root, [repository("product", repo)]);
    const tool = new FsTool("filesystem.write", { root: repo, access: "write" });

    const write = await tool.execute(
      fsInvocation<FsWriteInput>("filesystem.write", { path: "src/result.txt", content: "hello SECRET" }, executionContext),
      fsDeps(),
    );
    const traversal = await tool.execute(
      fsInvocation<FsWriteInput>("filesystem.write", { path: "../../workspace.json", content: "no" }, executionContext),
      fsDeps(),
    );
    const metadata = await tool.execute(
      fsInvocation<FsWriteInput>("filesystem.write", { path: join(root, "workspace.yaml"), content: "no" }, executionContext),
      fsDeps(),
    );

    expect(write).toMatchObject({
      ok: true,
      meta: { correlation: { workspaceId: "roll", storyId: "US-WS-035", repoId: "product" } },
    });
    expect(readFileSync(join(repo, "src", "result.txt"), "utf8")).toBe("hello [REDACTED]");
    expect(traversal).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(metadata).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
  });

  it("allows filesystem reads but rejects writes for a read-only repository", async () => {
    const root = tmp("filesystem-read-only");
    const repo = join(root, "issues", "US-WS-035", "reference");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "reference\n");
    const executionContext = context(root, [repository("reference", repo, "read")]);

    const read = await new FsTool("filesystem.read", { root: repo, access: "read" }).execute(
      fsInvocation<FsReadInput>("filesystem.read", { path: "README.md" }, executionContext, "reference"),
      fsDeps(),
    );
    const write = await new FsTool("filesystem.write", { root: repo, access: "write" }).execute(
      fsInvocation<FsWriteInput>("filesystem.write", { path: "README.md", content: "changed" }, executionContext, "reference"),
      fsDeps(),
    );

    expect(read).toMatchObject({ ok: true, output: { content: "reference\n" } });
    expect(write).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("reference\n");
  });

  it("fails filesystem closed without context and intersects invocation access with factory capability", async () => {
    const root = tmp("filesystem-capability");
    const repo = join(root, "issues", "US-WS-035", "product");
    mkdirSync(repo, { recursive: true });
    const executionContext = context(root, [repository("product", repo)]);
    const tool = new FsTool("filesystem.write", { root: repo, access: "read" });
    const invocation = fsInvocation<FsWriteInput>(
      "filesystem.write",
      { path: "result.txt", content: "no" },
      executionContext,
      "product",
    );

    const missing = await tool.execute({ ...invocation, context: undefined }, fsDeps());
    const denied = await tool.execute(invocation, fsDeps());

    expect(missing).toMatchObject({ ok: false, error: { code: "missing_execution_context" } });
    expect(denied).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
  });

  it("rejects filesystem symlink escapes before reading unauthorized content", async () => {
    const root = tmp("filesystem-symlink");
    const repo = join(root, "issues", "US-WS-035", "product");
    const outside = join(root, "outside");
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "SECRET outside\n");
    symlinkSync(outside, join(repo, "escape"));
    const executionContext = context(root, [repository("product", repo)]);

    const result = await new FsTool("filesystem.read", { root: repo, access: "read" }).execute(
      fsInvocation<FsReadInput>("filesystem.read", { path: "escape/secret.txt" }, executionContext),
      fsDeps(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("rejects a declared repository worktree that resolves outside the Issue root", async () => {
    const root = tmp("declared-worktree-symlink");
    const issueRoot = join(root, "issues", "US-WS-035");
    const outside = tmp("declared-worktree-outside");
    mkdirSync(issueRoot, { recursive: true });
    symlinkSync(outside, join(issueRoot, "product"));
    const executionContext = context(root, [repository("product", join(issueRoot, "product"))]);
    const deps = bashDeps();

    const result = await new BashTool().execute(
      bashInvocation({ command: "pwd" }, executionContext, "product"),
      deps,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(deps.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it("rejects a filesystem write through a symlink parent", async () => {
    const root = tmp("filesystem-parent-swap");
    const repo = join(root, "issues", "US-WS-035", "product");
    const outside = tmp("filesystem-parent-swap-outside");
    mkdirSync(repo, { recursive: true });
    const executionContext = context(root, [repository("product", repo)]);
    const targetParent = join(repo, "created");
    symlinkSync(outside, targetParent);

    const result = await new FsTool("filesystem.write", { root: repo, access: "write" }).execute(
      fsInvocation<FsWriteInput>("filesystem.write", { path: "created/result.txt", content: "blocked" }, executionContext, "product"),
      fsDeps(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(existsSync(join(outside, "result.txt"))).toBe(false);
  });

  it("does not delegate the final write through a swappable pathname callback", async () => {
    const root = tmp("filesystem-final-write-swap");
    const repo = join(root, "issues", "US-WS-035", "product");
    const outside = tmp("filesystem-final-write-swap-outside");
    mkdirSync(join(repo, "created"), { recursive: true });
    writeFileSync(join(repo, "created", "result.txt"), "before");
    const executionContext = context(root, [repository("product", repo)]);
    const deps: ToolDeps = {
      ...fsDeps(),
      fs: {
        readFile: async (path, encoding = "utf8") => readFileSync(path, encoding),
        mkdir: async () => undefined,
        writeFile: async () => {
          rmSync(join(repo, "created"), { recursive: true, force: true });
          symlinkSync(outside, join(repo, "created"));
          writeFileSync(join(outside, "result.txt"), "leaked");
        },
      },
    };

    const result = await new FsTool("filesystem.write", { root: repo, access: "write" }).execute(
      fsInvocation<FsWriteInput>("filesystem.write", { path: "created/result.txt", content: "safe" }, executionContext, "product"),
      deps,
    );

    expect(result).toMatchObject({ ok: true, output: { bytesWritten: 4 } });
    expect(readFileSync(join(repo, "created", "result.txt"), "utf8")).toBe("safe");
    expect(existsSync(join(outside, "result.txt"))).toBe(false);
  });

  it("fails closed for missing write targets instead of creating through a swappable parent pathname", async () => {
    const root = tmp("filesystem-new-file");
    const repo = join(root, "issues", "US-WS-035", "product");
    mkdirSync(join(repo, "created"), { recursive: true });
    const executionContext = context(root, [repository("product", repo)]);

    const result = await new FsTool("filesystem.write", { root: repo, access: "write" }).execute(
      fsInvocation<FsWriteInput>("filesystem.write", { path: "created/new.txt", content: "blocked" }, executionContext, "product"),
      fsDeps(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(existsSync(join(repo, "created", "new.txt"))).toBe(false);
  });

  it("rejects write targets whose inode has a Workspace-external hard-link alias", async () => {
    const root = tmp("filesystem-hard-link");
    const repo = join(root, "issues", "US-WS-035", "product");
    const outside = tmp("filesystem-hard-link-outside");
    mkdirSync(repo, { recursive: true });
    const outsideFile = join(outside, "shared.txt");
    writeFileSync(outsideFile, "outside");
    linkSync(outsideFile, join(repo, "target.txt"));
    const executionContext = context(root, [repository("product", repo)]);

    const result = await new FsTool("filesystem.write", { root: repo, access: "write" }).execute(
      fsInvocation<FsWriteInput>("filesystem.write", { path: "target.txt", content: "blocked" }, executionContext, "product"),
      fsDeps(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(readFileSync(outsideFile, "utf8")).toBe("outside");
  });

  it("requires git cwd to equal the explicitly selected Issue worktree and preserves dirty status", async () => {
    const root = tmp("git-workspace");
    const issueRoot = join(root, "issues", "US-WS-035");
    const first = initRepo("first", issueRoot);
    const second = initRepo("second", issueRoot);
    const executionContext = context(root, [repository("first", first), repository("second", second)]);
    writeFileSync(join(second, "dirty.txt"), "dirty\n");
    const tool = new GitTool("git.status");

    const ambiguous = await tool.execute(gitInvocation<GitStatusInput>("git.status", { cwd: first }, executionContext), fsDeps());
    const outside = await tool.execute(gitInvocation<GitStatusInput>("git.status", { cwd: first }, executionContext, "second"), fsDeps());
    const selected = await tool.execute(gitInvocation<GitStatusInput>("git.status", { cwd: second }, executionContext, "second"), fsDeps());

    expect(ambiguous).toMatchObject({ ok: false, error: { code: "missing_execution_context" } });
    expect(outside).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(selected).toMatchObject({
      ok: true,
      output: { clean: false },
      meta: { correlation: { workspaceId: "roll", storyId: "US-WS-035", repoId: "second" } },
    });
  });

  it("allows git status but rejects git writes for read-only repositories", async () => {
    const root = tmp("git-read-only-workspace");
    const repo = initRepo("reference", join(root, "issues", "US-WS-035"));
    const executionContext = context(root, [repository("reference", repo, "read")]);

    const status = await new GitTool("git.status").execute(
      gitInvocation<GitStatusInput>("git.status", { cwd: repo }, executionContext, "reference"),
      fsDeps(),
    );
    const commit = await new GitTool("git.commit").execute(
      gitInvocation<GitCommitInput>("git.commit", { cwd: repo, message: "forbidden" }, executionContext, "reference"),
      fsDeps(),
    );

    expect(status.ok).toBe(true);
    expect(commit).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(git(repo, "show", "-s", "--format=%s", "HEAD")).toBe("init");
  });

  it("rejects missing git context and symlink cwd escapes without exposing paths", async () => {
    const root = tmp("git-symlink-workspace");
    const repo = initRepo("product", join(root, "issues", "US-WS-035"));
    const outside = initRepo("git-outside");
    const escape = join(root, "escape");
    symlinkSync(outside, escape);
    const executionContext = context(root, [repository("product", repo)]);
    const tool = new GitTool("git.status");

    const missing = await tool.execute(gitInvocation<GitStatusInput>("git.status", { cwd: repo }), fsDeps());
    const escaped = await tool.execute(gitInvocation<GitStatusInput>("git.status", { cwd: escape }, executionContext, "product"), fsDeps());

    expect(missing).toMatchObject({ ok: false, error: { code: "missing_execution_context" } });
    expect(escaped).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(JSON.stringify(escaped)).not.toContain(root);
    expect(JSON.stringify(escaped)).not.toContain(outside);
  });

  it("keeps frozen repository roots stable across cwd changes and concurrent invocations", async () => {
    const firstRoot = tmp("concurrent-first-workspace");
    const secondRoot = tmp("concurrent-second-workspace");
    const ambient = tmp("concurrent-ambient");
    const firstRepo = join(firstRoot, "issues", "US-WS-035", "product");
    const secondRepo = join(secondRoot, "issues", "US-WS-035", "product");
    mkdirSync(firstRepo, { recursive: true });
    mkdirSync(secondRepo, { recursive: true });
    const firstContext = context(firstRoot, [repository("product", firstRepo)]);
    const secondContext = context(secondRoot, [repository("product", secondRepo)]);
    const deps = bashDeps();
    const originalCwd = process.cwd();

    try {
      process.chdir(ambient);
      const [first, second] = await Promise.all([
        new BashTool().execute(bashInvocation({ command: "pwd" }, firstContext), deps),
        new BashTool().execute(bashInvocation({ command: "pwd" }, secondContext), deps),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }

    expect(deps.calls.map((call) => call.opts?.cwd).sort()).toEqual([firstRepo, secondRepo].sort());
    expect(deps.calls.map((call) => call.opts?.cwd)).not.toContain(ambient);
  });
});
