import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveWorkspaceExecutionAuthorities } from "@roll/core";
import type { ExecOpts, ExecResult, MinimalFs, ToolDeps, ToolInvocation, ToolPolicy } from "@roll/spec";
import { REPOSITORY_BINDING_V1, WORKSPACE_EXECUTION_CONTEXT_V1 } from "@roll/spec";
import { afterAll, describe, expect, it } from "vitest";
import { BashTool, type BashInput, type BashOutput } from "../src/index.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "roll-bash-tool-")));
const issueRoot = join(root, "issues", "US-TOOL-004");
const repo = join(issueRoot, "repo");
const outside = join(root, "outside");
mkdirSync(repo, { recursive: true });
mkdirSync(outside);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const policy = (sandbox: ToolPolicy["sandbox"] = {}): ToolPolicy => ({
  enabled: true,
  timeoutMs: 1000,
  sandbox,
});

function invocation(input: BashInput, sandbox: ToolPolicy["sandbox"] = {}): ToolInvocation<BashInput> {
  return {
    invocationId: "inv-1",
    toolId: "bash" as ToolInvocation<BashInput>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-TOOL-004", agent: "codex" },
    policy: policy(sandbox),
    ts: 100,
    context: {
      schema: WORKSPACE_EXECUTION_CONTEXT_V1,
      workspace: { workspaceId: "roll", root, canonicalRoot: root, lifecycle: "active" },
      resolution: { source: "explicit", evidence: [] },
      bindings: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: "repo",
        alias: "repo",
        remote: "git@github.com:example/repo.git",
        integrationBranch: "main",
        provider: "github",
        workflow: { branchPattern: "story/{storyId}", requiredChecks: [] },
      }],
      issue: {
        storyId: "US-TOOL-004",
        manifestPath: join(issueRoot, "manifest.json"),
        execution: {
          workspaceId: "roll",
          issueRoot,
          repositories: {
            repo: {
              repoId: "repo",
              alias: "repo",
              access: "write",
              requiredDelivery: true,
              noChangePolicy: "changes_required",
              workBranch: "roll/roll/US-TOOL-004",
              worktreePath: repo,
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              commands: { test: [], integration: [] },
            },
          },
        },
      },
      authorities: deriveWorkspaceExecutionAuthorities(root),
    },
    repoId: "repo",
  };
}

function fakeDeps(result: ExecResult): ToolDeps & { calls: Array<{ command: string; args: readonly string[]; opts?: ExecOpts }>; files: Map<string, string> } {
  const files = new Map<string, string>();
  const calls: Array<{ command: string; args: readonly string[]; opts?: ExecOpts }> = [];
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

describe("US-TOOL-004 BashTool", () => {
  it("executes argv-only commands successfully and writes a dump", async () => {
    const deps = fakeDeps({ exitCode: 0, stdout: "hello\n", stderr: "", timedOut: false });
    const tool = new BashTool();

    const result = await tool.execute(invocation({ command: "printf", args: ["hello"], cwd: repo }), deps);

    expect(result).toMatchObject({ ok: true, output: { exitCode: 0, stdout: "hello\n", stderr: "", timedOut: false } });
    expect(deps.calls).toEqual([{ command: "printf", args: ["hello"], opts: { cwd: repo, env: undefined, timeoutMs: 1000, maxOutputBytes: undefined } }]);
    expect(deps.files.get(join(root, "runtime", "tool-dumps", "inv-1.log"))).toContain("stdout:\nhello\n");
  });

  it("treats non-zero exit as ok:true with the exitCode in output", async () => {
    const deps = fakeDeps({ exitCode: 2, stdout: "", stderr: "bad\n", timedOut: false });
    const result = await new BashTool().execute(invocation({ command: "false", cwd: repo }), deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.output as BashOutput).exitCode).toBe(2);
  });

  it("returns timeout when exec reports timedOut", async () => {
    const deps = fakeDeps({ exitCode: 124, stdout: "partial", stderr: "", timedOut: true, signal: "SIGTERM" });
    const result = await new BashTool().execute(
      invocation({ command: "sleep", args: ["10"], cwd: repo }, { hardTimeoutSec: 1 }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
    expect(deps.calls[0]?.opts?.timeoutMs).toBe(1000);
  });

  it("enforces cwd allowedPaths before execution", async () => {
    const deps = fakeDeps({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const result = await new BashTool().execute(
      invocation({ command: "pwd", cwd: outside }, { allowedPaths: [repo] }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_execution_context");
    expect(deps.calls).toHaveLength(0);
  });

  it("caps stdout/stderr and dump content at maxOutputBytes", async () => {
    const deps = fakeDeps({ exitCode: 0, stdout: "abcdef", stderr: "uvwxyz", timedOut: false });
    const result = await new BashTool().execute(
      invocation({ command: "echo", cwd: repo }, { maxOutputBytes: 3 }),
      deps,
    );

    expect(result).toMatchObject({ ok: true, output: { stdout: "abc", stderr: "uvw" } });
    expect(deps.files.get(join(root, "runtime", "tool-dumps", "inv-1.log"))).toContain("stdout:\nabc\n");
    expect(deps.files.get(join(root, "runtime", "tool-dumps", "inv-1.log"))).not.toContain("abcdef");
  });

  it("redacts command input before execution and dump persistence", async () => {
    const deps = fakeDeps({ exitCode: 0, stdout: "SECRET out", stderr: "", timedOut: false });
    const result = await new BashTool().execute(
      invocation({ command: "echo", args: ["SECRET"], cwd: repo, env: { TOKEN: "SECRET" } }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.calls[0]).toMatchObject({ command: "echo", args: ["[REDACTED]"] });
    expect(deps.calls[0]?.opts?.env).toEqual({ TOKEN: "[REDACTED]" });
    expect(deps.files.get(join(root, "runtime", "tool-dumps", "inv-1.log"))).not.toContain("SECRET");
  });

  it("blockedCommands are advisory warnings and do not block execution", async () => {
    const deps = fakeDeps({ exitCode: 0, stdout: "done", stderr: "", timedOut: false });
    const result = await new BashTool().execute(
      invocation({ command: "rm", args: ["-rf", "tmp"], cwd: repo }, { blockedCommands: ["rm"] }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["blocked command advisory: rm"]);
    expect(deps.calls).toHaveLength(1);
  });

  it("rejects absolute and traversal argv paths that escape the selected Issue repository", async () => {
    for (const args of [[outside], ["../outside"], ["-C", outside]]) {
      const deps = fakeDeps({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
      const result = await new BashTool().execute(invocation({ command: "git", args, cwd: repo }), deps);

      expect(result).toMatchObject({ ok: false, error: { code: "sandbox_denied" } });
      expect(deps.calls).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(outside);
    }
  });

  it("rejects dynamic interpreter code and relative symlink paths before execution", async () => {
    const escape = join(repo, "escape");
    symlinkSync(outside, escape);
    for (const input of [
      { command: "sh", args: ["-c", "cat /etc/passwd"] },
      { command: "bash", args: ["-lc", "cat /etc/passwd"] },
      { command: "node", args: ["-e", "require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "node", args: ["--eval=require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "node", args: ["--input-type", "module", "-e", "import fs from 'node:fs'; fs.readFileSync('/etc/passwd')"] },
      { command: "node", args: ["--env-file", "package.json", "-e", "require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "node", args: ["--env-file-if-exists", ".env", "-e", "require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "node", args: ["--dns-result-order", "ipv4first", "-e", "require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "node", args: ["--trace-require-module", "all", "-e", "require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "node", args: ["--test-name-pattern", "smoke", "-e", "require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "node", args: ["--import=data:text/javascript,globalThis.compromised=true", "app.js"] },
      { command: "node", args: ["--experimental-loader", "data:text/javascript,export function load(){}", "app.js"] },
      { command: "node", args: ["--experimental_loader=data:text/javascript,export function load(){}", "app.js"] },
      { command: "node", args: ["--experimental_loader", "data:text/javascript,export function load(){}", "app.js"] },
      { command: "node", args: ["--import", "file:///etc/passwd", "app.js"] },
      { command: "node", args: ["--run", "unsafe-script"] },
      { command: "node", args: ["--print", "require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "/usr/bin/env", args: ["node", "-e", "require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "/usr/bin/env", args: ["-u", "NODE_OPTIONS", "node", "-e", "require('node:fs').readFileSync('/etc/passwd')"] },
      { command: "cat", args: ["escape/file.txt"] },
    ]) {
      const deps = fakeDeps({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
      const result = await new BashTool().execute(invocation({ ...input, cwd: repo }), deps);

      expect(result).toMatchObject({ ok: false, error: { code: "sandbox_denied" } });
      expect(deps.calls).toHaveLength(0);
    }
  });

  it("allows interpreter-like flags after the Node script boundary", async () => {
    const deps = fakeDeps({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    const result = await new BashTool().execute(
      invocation({ command: "node", args: ["app.js", "-e", "development"], cwd: repo }),
      deps,
    );

    expect(result).toMatchObject({ ok: true, output: { stdout: "ok" } });
    expect(deps.calls).toHaveLength(1);
  });

  it("init and dispose are no-ops", async () => {
    const tool = new BashTool();
    const deps = fakeDeps({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    await expect(tool.init(deps)).resolves.toBeUndefined();
    await expect(tool.dispose(deps)).resolves.toBeUndefined();
  });
});
