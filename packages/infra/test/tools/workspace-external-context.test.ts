import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveWorkspaceExecutionAuthorities } from "@roll/core";
import {
  REPOSITORY_BINDING_V1,
  ROLL_CAPTURE_PROTOCOL_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  type MinimalFs,
  type ToolDeps,
  type ToolInvocation,
  type ToolPolicy,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { describe, expect, it } from "vitest";
import {
  BrowserTool,
  GitHubTool,
  McpTool,
  NetworkTool,
  type BrowserScreenshotInput,
  type McpConnection,
  type McpInput,
} from "../../src/index.js";

const root = "/workspaces/alpha";
const storyId = "US-WS-036";
const repoId = "repo-product";

function context(workspaceId = "alpha", rootOverride?: string): WorkspaceExecutionContextV1 {
  const canonicalRoot = rootOverride ?? (workspaceId === "alpha" ? root : `/workspaces/${workspaceId}`);
  const issueRoot = join(canonicalRoot, "issues", storyId);
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: {
      workspaceId,
      root: canonicalRoot,
      canonicalRoot,
      lifecycle: "active",
    },
    resolution: { source: "explicit", evidence: [] },
    bindings: [{
      schema: REPOSITORY_BINDING_V1,
      repoId,
      alias: "product",
      remote: "git@github.com:example/product.git",
      integrationBranch: "idea-074-workspace",
      provider: "github",
      workflow: { branchPattern: "story/{storyId}", requiredChecks: [] },
    }],
    issue: {
      storyId,
      manifestPath: join(issueRoot, "manifest.json"),
      execution: {
        workspaceId,
        issueRoot,
        repositories: {
          [repoId]: {
            repoId,
            alias: "product",
            access: "write",
            requiredDelivery: true,
            noChangePolicy: "changes_required",
            workBranch: `roll/${workspaceId}/${storyId}`,
            worktreePath: join(issueRoot, "product"),
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            commands: { test: [], integration: [] },
          },
        },
      },
    },
    authorities: deriveWorkspaceExecutionAuthorities(canonicalRoot),
  };
}

const policy = (overrides: Partial<ToolPolicy> = {}): ToolPolicy => ({
  enabled: true,
  timeoutMs: 1000,
  sandbox: { headlessOnly: true },
  ...overrides,
});

function invocation<I>(
  toolId: string,
  input: I,
  executionContext: WorkspaceExecutionContextV1 | null = context(),
): ToolInvocation<I> {
  return {
    invocationId: `inv-${toolId}`,
    toolId: toolId as ToolInvocation<I>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId, agent: "codex" },
    policy: policy(),
    ts: 100,
    ...(executionContext === null ? {} : { context: executionContext, repoId }),
  };
}

function deps(files: Record<string, string> = {}): ToolDeps & {
  calls: Array<{ command: string; args: readonly string[] }>;
  writes: Map<string, string>;
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const writes = new Map<string, string>();
  const fs: MinimalFs = {
    readFile: async (path) => {
      const value = files[path];
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    writeFile: async (path, data) => {
      writes.set(path, data);
    },
    mkdir: async () => undefined,
  };
  return {
    calls,
    writes,
    fs,
    now: () => 100,
    execFile: async (command, args) => {
      calls.push({ command, args });
      return command === "npx"
        ? { exitCode: 0, stdout: JSON.stringify({ finalUrl: "https://example.test", statusCode: 200, png: "PNG" }), stderr: "", timedOut: false }
        : { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
    redact: (value) => value.replaceAll("SECRET", "[REDACTED]"),
  };
}

describe("US-WS-036 external tools consume frozen Workspace authority", () => {
  it("fails before browser execution when Issue context is missing", async () => {
    const dependencies = deps();
    const result = await new BrowserTool("browser.screenshot").execute(
      invocation<BrowserScreenshotInput>("browser.screenshot", { url: "https://example.test" }, null),
      dependencies,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "missing_execution_context" } });
    expect(dependencies.calls).toHaveLength(0);
  });

  it("writes default browser evidence beneath the frozen toolDumps authority", async () => {
    const dependencies = deps();
    const result = await new BrowserTool("browser.screenshot").execute(
      invocation<BrowserScreenshotInput>("browser.screenshot", { url: "https://example.test" }),
      dependencies,
    );

    const expected = join(root, "runtime", "tool-dumps", "inv-browser.screenshot.png");
    expect(result).toMatchObject({
      ok: true,
      output: { screenshotPath: expected },
      meta: { correlation: { workspaceId: "alpha", storyId, repoId } },
    });
    expect(dependencies.writes.get(expected)).toBe("PNG");
  });

  it("rejects an explicit browser screenshot path outside Workspace authorities", async () => {
    const dependencies = deps();
    const result = await new BrowserTool("browser.screenshot").execute(
      invocation<BrowserScreenshotInput>("browser.screenshot", {
        url: "https://example.test",
        screenshotPath: "/tmp/outside-workspace.png",
      }),
      dependencies,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "sandbox_denied" } });
    expect(dependencies.calls).toHaveLength(0);
    expect(dependencies.writes.size).toBe(0);
  });

  it("rejects a browser artifact path that escapes through an authority symlink", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "roll-tool-artifact-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "roll-tool-artifact-outside-"));
    const executionContext = context("symlink", workspaceRoot);
    const escape = join(executionContext.authorities.toolDumps, "escape");
    mkdirSync(executionContext.authorities.toolDumps, { recursive: true });
    symlinkSync(outside, escape);
    const dependencies = deps();

    try {
      const result = await new BrowserTool("browser.screenshot").execute(
        invocation<BrowserScreenshotInput>("browser.screenshot", {
          url: "https://example.test",
          screenshotPath: join(escape, "outside.png"),
        }, executionContext),
        dependencies,
      );

      expect(result).toMatchObject({ ok: false, error: { code: "sandbox_denied" } });
      expect(dependencies.calls).toHaveLength(0);
      expect(dependencies.writes.size).toBe(0);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a physical capture path outside Workspace authorities before provider mutation", async () => {
    let wroteRequest = false;
    const tool = new BrowserTool("physical.screenshot", undefined, {
      writeRequest: async () => {
        wroteRequest = true;
        return "/tmp/request.json";
      },
      waitForResponse: async () => ({ status: "timeout", reason: "not expected" }),
    });
    const result = await tool.execute(invocation("physical.screenshot", {
      protocol: ROLL_CAPTURE_PROTOCOL_V1,
      requestId: "outside-physical",
      storyId,
      kind: "physical_terminal",
      target: { type: "window", appName: "Terminal" },
      out: "/tmp/outside-physical.png",
      timeoutMs: 1000,
      createdAt: "2026-07-24T00:00:00.000Z",
    }), deps());

    expect(result).toMatchObject({ ok: false, error: { code: "sandbox_denied" } });
    expect(wroteRequest).toBe(false);
  });

  it("rejects a physical capture request attributed to another Story", async () => {
    const executionContext = context();
    let wroteRequest = false;
    const tool = new BrowserTool("physical.screenshot", undefined, {
      writeRequest: async () => {
        wroteRequest = true;
        return "/tmp/request.json";
      },
      waitForResponse: async () => ({ status: "timeout", reason: "not expected" }),
    });
    const result = await tool.execute(invocation("physical.screenshot", {
      protocol: ROLL_CAPTURE_PROTOCOL_V1,
      requestId: "wrong-story-physical",
      storyId: "US-OTHER",
      kind: "physical_terminal",
      target: { type: "window", appName: "Terminal" },
      out: join(executionContext.authorities.evidence, "wrong-story.png"),
      timeoutMs: 1000,
      createdAt: "2026-07-24T00:00:00.000Z",
    }, executionContext), deps());

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_execution_context" } });
    expect(wroteRequest).toBe(false);
  });

  it.each([
    ["github", new GitHubTool("github.ci"), { action: "status", slug: "example/product", commit: "a".repeat(40) }],
    ["network", new NetworkTool(), { url: "https://example.test" }],
  ] as const)("fails closed for %s before an external call without context", async (_name, tool, input) => {
    const dependencies = deps();
    const result = await tool.execute(invocation(tool.declaration.id, input, null) as never, dependencies);

    expect(result).toMatchObject({ ok: false, error: { code: "missing_execution_context" } });
    expect(dependencies.calls).toHaveLength(0);
  });

  it("reads MCP servers from Workspace policy authority instead of cwd project state", async () => {
    const executionContext = context();
    const policyPath = executionContext.authorities.policy;
    const connection: McpConnection = {
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => undefined,
    };
    const connected: string[] = [];
    const tool = new McpTool({
      projectRoot: "/unrelated-cwd",
      connect: async (config) => {
        connected.push(config.command);
        return connection;
      },
    });
    const input: McpInput = { serverName: "jira", toolName: "issue.get" };
    const result = await tool.execute(invocation("mcp.call", input, executionContext), deps({
      [policyPath]: [
        "tools:",
        "  mcp:",
        "    servers:",
        "      jira:",
        "        command: workspace-jira-mcp",
      ].join("\n"),
      [join("/unrelated-cwd", ".roll", "mcp-servers.json")]: JSON.stringify({
        servers: { jira: { command: "cwd-jira-mcp" } },
      }),
    }));

    expect(result.ok).toBe(true);
    expect(connected).toEqual(["workspace-jira-mcp"]);
  });

  it("does not reuse an MCP connection across Workspace contexts with the same server name", async () => {
    const alpha = context("alpha");
    const beta = context("beta");
    const connected: string[] = [];
    const tool = new McpTool({
      connect: async (config) => {
        connected.push(config.command);
        return {
          callTool: async () => ({ content: [{ type: "text", text: config.command }] }),
          close: async () => undefined,
        };
      },
    });
    const dependencies = deps({
      [alpha.authorities.policy]: [
        "tools:",
        "  mcp:",
        "    servers:",
        "      shared:",
        "        command: alpha-mcp",
      ].join("\n"),
      [beta.authorities.policy]: [
        "tools:",
        "  mcp:",
        "    servers:",
        "      shared:",
        "        command: beta-mcp",
      ].join("\n"),
    });
    const input: McpInput = { serverName: "shared", toolName: "read" };

    const alphaResult = await tool.execute(invocation("mcp.call", input, alpha), dependencies);
    const betaResult = await tool.execute(invocation("mcp.call", input, beta), dependencies);

    expect(connected).toEqual(["alpha-mcp", "beta-mcp"]);
    expect(alphaResult).toMatchObject({ ok: true, output: { content: [{ text: "alpha-mcp" }] } });
    expect(betaResult).toMatchObject({ ok: true, output: { content: [{ text: "beta-mcp" }] } });
  });
});
