import type { ExecOpts, ExecResult, MinimalFs, ToolDeps, ToolInvocation, ToolPolicy } from "@roll/spec";
import { describe, expect, it } from "vitest";
import { BashTool, type BashInput, type BashOutput } from "../src/index.js";

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

    const result = await tool.execute(invocation({ command: "printf", args: ["hello"], cwd: "/repo" }), deps);

    expect(result).toMatchObject({ ok: true, output: { exitCode: 0, stdout: "hello\n", stderr: "", timedOut: false } });
    expect(deps.calls).toEqual([{ command: "printf", args: ["hello"], opts: { cwd: "/repo", env: undefined, timeoutMs: 1000, maxOutputBytes: undefined } }]);
    expect(deps.files.get("/repo/.roll/tool-dumps/inv-1.log")).toContain("stdout:\nhello\n");
  });

  it("treats non-zero exit as ok:true with the exitCode in output", async () => {
    const deps = fakeDeps({ exitCode: 2, stdout: "", stderr: "bad\n", timedOut: false });
    const result = await new BashTool().execute(invocation({ command: "false", cwd: "/repo" }), deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.output as BashOutput).exitCode).toBe(2);
  });

  it("returns timeout when exec reports timedOut", async () => {
    const deps = fakeDeps({ exitCode: 124, stdout: "partial", stderr: "", timedOut: true, signal: "SIGTERM" });
    const result = await new BashTool().execute(
      invocation({ command: "sleep", args: ["10"], cwd: "/repo" }, { hardTimeoutSec: 1 }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
    expect(deps.calls[0]?.opts?.timeoutMs).toBe(1000);
  });

  it("enforces cwd allowedPaths before execution", async () => {
    const deps = fakeDeps({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const result = await new BashTool().execute(
      invocation({ command: "pwd", cwd: "/secret" }, { allowedPaths: ["/repo"] }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("sandbox_denied");
    expect(deps.calls).toHaveLength(0);
  });

  it("caps stdout/stderr and dump content at maxOutputBytes", async () => {
    const deps = fakeDeps({ exitCode: 0, stdout: "abcdef", stderr: "uvwxyz", timedOut: false });
    const result = await new BashTool().execute(
      invocation({ command: "echo", cwd: "/repo" }, { maxOutputBytes: 3 }),
      deps,
    );

    expect(result).toMatchObject({ ok: true, output: { stdout: "abc", stderr: "uvw" } });
    expect(deps.files.get("/repo/.roll/tool-dumps/inv-1.log")).toContain("stdout:\nabc\n");
    expect(deps.files.get("/repo/.roll/tool-dumps/inv-1.log")).not.toContain("abcdef");
  });

  it("redacts command input before execution and dump persistence", async () => {
    const deps = fakeDeps({ exitCode: 0, stdout: "SECRET out", stderr: "", timedOut: false });
    const result = await new BashTool().execute(
      invocation({ command: "echo", args: ["SECRET"], cwd: "/repo", env: { TOKEN: "SECRET" } }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.calls[0]).toMatchObject({ command: "echo", args: ["[REDACTED]"] });
    expect(deps.calls[0]?.opts?.env).toEqual({ TOKEN: "[REDACTED]" });
    expect(deps.files.get("/repo/.roll/tool-dumps/inv-1.log")).not.toContain("SECRET");
  });

  it("blockedCommands are advisory warnings and do not block execution", async () => {
    const deps = fakeDeps({ exitCode: 0, stdout: "done", stderr: "", timedOut: false });
    const result = await new BashTool().execute(
      invocation({ command: "rm", args: ["-rf", "tmp"], cwd: "/repo" }, { blockedCommands: ["rm"] }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["blocked command advisory: rm"]);
    expect(deps.calls).toHaveLength(1);
  });

  it("init and dispose are no-ops", async () => {
    const tool = new BashTool();
    const deps = fakeDeps({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    await expect(tool.init(deps)).resolves.toBeUndefined();
    await expect(tool.dispose(deps)).resolves.toBeUndefined();
  });
});
