import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MinimalFs, ToolDeps, ToolInvocation, ToolPolicy } from "@roll/spec";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  GitHubTool,
  githubTools,
  type GitHubCiInput,
  type GitHubCiOutput,
  type GitHubPrCreateOutput,
  type GitHubPrInput,
  type GitHubPrStatusOutput,
  type GitHubToolId,
} from "../src/index.js";
import { TOOL_TEST_REPO_ID, toolWorkspaceContext } from "./tool-workspace-context.js";

const dirs: string[] = [];
const originalPath = process.env["PATH"];

afterEach(() => {
  if (originalPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = originalPath;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fakeGh(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "roll-infra-gh-tool-"));
  dirs.push(dir);
  const gh = join(dir, "gh");
  writeFileSync(gh, script);
  chmodSync(gh, 0o755);
  process.env["PATH"] = `${dir}:${originalPath ?? ""}`;
}

const policy = (): ToolPolicy => ({ enabled: true, timeoutMs: 1000, sandbox: {} });

function invocation<I>(toolId: GitHubToolId, input: I): ToolInvocation<I> {
  return {
    invocationId: `inv-${toolId}`,
    toolId: toolId as ToolInvocation<I>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-TOOL-007", agent: "codex" },
    policy: policy(),
    ts: 100,
    context: toolWorkspaceContext("US-TOOL-007"),
    repoId: TOOL_TEST_REPO_ID,
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

const ghScript = `#!/bin/sh
args="$*"
case "$args" in
  *"pr create"*) echo "https://github.com/o/r/pull/42"; exit 0 ;;
  *"pr view 42 --json state -q .state"*) echo "OPEN"; exit 0 ;;
  *"pr merge 42"*) echo "merged"; exit 0 ;;
  *"run list --commit pass-sha"*) echo '[{"status":"completed","conclusion":"success"}]'; exit 0 ;;
  *"run list --commit fail-sha"*) echo '[{"status":"completed","conclusion":"failure"}]'; exit 0 ;;
  *"run list --commit pending-sha"*) echo '[{"status":"in_progress","conclusion":null}]'; exit 0 ;;
  *"run rerun 99"*) echo "rerun"; exit 0 ;;
  *"rate-limit"*) echo "API rate limit exceeded" >&2; exit 1 ;;
  *) echo "unexpected: $args" >&2; exit 2 ;;
esac
`;

describe("US-TOOL-007 GitHubTool", () => {
  it("exposes GitHub PR and CI tool declarations", () => {
    const tools = githubTools();
    expect(tools.map((tool) => tool.declaration.id)).toEqual(["github.pr", "github.ci"]);
    expect(tools.every((tool) => tool.declaration.kind === "github")).toBe(true);
  });

  it("creates a PR and returns its URL and number", async () => {
    fakeGh(ghScript);
    const result = await new GitHubTool("github.pr").execute(
      invocation<GitHubPrInput>("github.pr", {
        action: "create",
        slug: "o/r",
        head: "topic",
        base: "main",
        title: "Title",
        body: "Body",
      }),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output as GitHubPrCreateOutput).toEqual({ prUrl: "https://github.com/o/r/pull/42", prNumber: "42" });
  });

  it("reads PR status and merges through existing gh wrappers", async () => {
    fakeGh(ghScript);
    const tool = new GitHubTool("github.pr");

    const status = await tool.execute(invocation<GitHubPrInput>("github.pr", { action: "status", slug: "o/r", ref: "42" }), deps());
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.output as GitHubPrStatusOutput).toEqual({ state: "OPEN" });

    const merge = await tool.execute(invocation<GitHubPrInput>("github.pr", { action: "merge", slug: "o/r", ref: "42", mode: "plain" }), deps());
    expect(merge).toMatchObject({ ok: true, output: { code: 0 } });
  });

  it("summarizes CI status as pass, fail, or pending", async () => {
    fakeGh(ghScript);
    const tool = new GitHubTool("github.ci");

    const pass = await tool.execute(invocation<GitHubCiInput>("github.ci", { action: "status", slug: "o/r", commit: "pass-sha" }), deps());
    const fail = await tool.execute(invocation<GitHubCiInput>("github.ci", { action: "status", slug: "o/r", commit: "fail-sha" }), deps());
    const pending = await tool.execute(invocation<GitHubCiInput>("github.ci", { action: "status", slug: "o/r", commit: "pending-sha" }), deps());

    expect(pass.ok && (pass.output as GitHubCiOutput).state).toBe("pass");
    expect(fail.ok && (fail.output as GitHubCiOutput).state).toBe("fail");
    expect(pending.ok && (pending.output as GitHubCiOutput).state).toBe("pending");
  });

  it("reruns a CI run", async () => {
    fakeGh(ghScript);
    const result = await new GitHubTool("github.ci").execute(
      invocation<GitHubCiInput>("github.ci", { action: "rerun", slug: "o/r", runId: "99" }),
      deps(),
    );

    expect(result).toMatchObject({ ok: true, output: { code: 0 } });
  });

  it("surfaces rate-limit errors as retryable adapter errors", async () => {
    fakeGh(ghScript);
    const result = await new GitHubTool("github.pr").execute(
      invocation<GitHubPrInput>("github.pr", { action: "status", slug: "o/r", ref: "rate-limit" }),
      deps(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("adapter_error");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("rate limit");
    }
  });

  it("init and dispose are no-ops", async () => {
    const tool = new GitHubTool("github.pr");
    const d = deps();

    await expect(tool.init(d)).resolves.toBeUndefined();
    await expect(tool.dispose(d)).resolves.toBeUndefined();
  });
});
