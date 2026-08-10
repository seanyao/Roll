import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserTransportRegistry } from "@roll/core";
import type { MinimalFs, ToolDeps, ToolInvocation, ToolPolicy } from "@roll/spec";
import { describe, expect, it } from "vitest";
import {
  McpTool,
  mcpTools,
  type McpConnection,
  type McpInput,
  type McpOutput,
  type McpServerConfig,
} from "../src/index.js";

const policy = (overrides: Partial<ToolPolicy> = {}): ToolPolicy => ({
  enabled: true,
  timeoutMs: 1000,
  sandbox: {},
  ...overrides,
});

function invocation(input: McpInput, overrides: Partial<ToolPolicy> = {}): ToolInvocation<McpInput> {
  return {
    invocationId: "inv-mcp",
    toolId: "mcp.call" as ToolInvocation<McpInput>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-TOOL-010", agent: "codex" },
    policy: policy(overrides),
    ts: 100,
  };
}

function deps(files: Record<string, string> = {}): ToolDeps {
  const fs: MinimalFs = {
    readFile: async (path) => {
      const value = files[path];
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    writeFile: async () => undefined,
    mkdir: async () => undefined,
  };
  return {
    fs,
    now: () => 100,
    execFile: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    redact: (value) => value.replaceAll("SECRET", "[REDACTED]"),
  };
}

function connection(output: McpOutput): McpConnection & { calls: Array<{ toolName: string; args: Record<string, unknown> }>; closed: number } {
  return {
    calls: [],
    closed: 0,
    async callTool(toolName, args) {
      this.calls.push({ toolName, args });
      return output;
    },
    async close() {
      this.closed += 1;
    },
  };
}

describe("US-TOOL-010 McpTool", () => {
  it("exposes the mcp.call declaration", () => {
    const tools = mcpTools();

    expect(tools.map((tool) => tool.declaration.id)).toEqual(["mcp.call"]);
    expect(tools[0]?.declaration.kind).toBe("mcp");
  });

  it("invokes a mock MCP server tool and reuses the lazy connection", async () => {
    const root = "/repo";
    const configPath = join(root, ".roll", "mcp-servers.json");
    const conn = connection({ content: [{ type: "text", text: "ok [REDACTED]" }] });
    const connected: McpServerConfig[] = [];
    const tool = new McpTool({
      projectRoot: root,
      connect: async (config) => {
        connected.push(config);
        return conn;
      },
    });

    const input: McpInput = { serverName: "jira", toolName: "issue.get", arguments: { id: "SECRET" } };
    const first = await tool.execute(invocation(input), deps({
      [configPath]: JSON.stringify({ servers: { jira: { command: "jira-mcp", args: ["--stdio"] } } }),
    }));
    const second = await tool.execute(invocation(input), deps({
      [configPath]: JSON.stringify({ servers: { jira: { command: "jira-mcp", args: ["--stdio"] } } }),
    }));

    expect(first).toMatchObject({ ok: true, output: { content: [{ type: "text", text: "ok [REDACTED]" }] } });
    expect(second.ok).toBe(true);
    expect(connected).toEqual([{ command: "jira-mcp", args: ["--stdio"] }]);
    expect(conn.calls).toEqual([
      { toolName: "issue.get", args: { id: "[REDACTED]" } },
      { toolName: "issue.get", args: { id: "[REDACTED]" } },
    ]);
  });

  it("reads server config from policy.yaml tools.mcp.servers when json config is absent", async () => {
    const root = "/repo";
    const conn = connection({ content: [{ type: "text", text: "from policy" }] });
    const connected: McpServerConfig[] = [];
    const tool = new McpTool({
      projectRoot: root,
      connect: async (config) => {
        connected.push(config);
        return conn;
      },
    });

    const result = await tool.execute(
      invocation({ serverName: "db", toolName: "query" }),
      deps({
        [join(root, ".roll", "policy.yaml")]: [
          "tools:",
          "  mcp:",
          "    servers:",
          "      db:",
          "        command: db-mcp",
          "        args: [--stdio, --readonly]",
        ].join("\n"),
      }),
    );

    expect(result.ok).toBe(true);
    expect(connected).toEqual([{ command: "db-mcp", args: ["--stdio", "--readonly"] }]);
  });

  it("returns BINARY_NOT_FOUND when the transport binary is unavailable", async () => {
    const root = "/repo";
    const tool = new McpTool({
      projectRoot: root,
      connect: async () => {
        throw Object.assign(new Error("spawn missing"), { code: "ENOENT" });
      },
    });

    const result = await tool.execute(
      invocation({ serverName: "missing", toolName: "ping" }),
      deps({ [join(root, ".roll", "mcp-servers.json")]: JSON.stringify({ servers: { missing: { command: "missing-mcp" } } }) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("adapter_error");
      expect(result.error.message).toContain("BINARY_NOT_FOUND");
    }
  });

  it("returns NETWORK_UNAVAILABLE when the connection cannot be established", async () => {
    const root = "/repo";
    const tool = new McpTool({
      projectRoot: root,
      connect: async () => {
        throw new Error("connection refused");
      },
    });

    const result = await tool.execute(
      invocation({ serverName: "remote", toolName: "ping" }),
      deps({ [join(root, ".roll", "mcp-servers.json")]: JSON.stringify({ servers: { remote: { command: "remote-mcp" } } }) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("NETWORK_UNAVAILABLE");
  });

  it("rejects direct invocations when policy disabled", async () => {
    const result = await new McpTool({ projectRoot: "/repo" }).execute(
      invocation({ serverName: "jira", toolName: "issue.get" }, { enabled: false }),
      deps(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("policy_denied");
  });

  it("fails closed before config resolution or spawn when generic MCP targets the reserved DevTools server", async () => {
    const root = "/repo";
    const events: unknown[] = [];
    const registry = new BrowserTransportRegistry();
    let connected = 0;
    const tool = new McpTool({
      projectRoot: root,
      browserTransportRegistry: registry,
      recordBrowserEvent: (event) => events.push(event),
      connect: async () => {
        connected += 1;
        return connection({ content: [] });
      },
    });

    const result = await tool.execute(
      invocation({ serverName: "chrome-devtools", toolName: "navigate", arguments: { url: "https://example.test" } }),
      deps({
        [join(root, ".roll", "mcp-servers.json")]: JSON.stringify({
          servers: { "chrome-devtools": { command: "owner-controlled-command", args: ["--latest"] } },
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("policy_denied");
      expect(result.error.message).toContain("reserved for Browser Operations");
    }
    expect(connected).toBe(0);
    expect(events).toMatchObject([{ type: "browser:mcp-bypass-denied", reason: { code: "generic_mcp_bypass_denied" } }]);
  });

  it("persists the bypass-denied event through the Browser Operations ledger by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "roll-mcp-bypass-"));
    try {
      const result = await new McpTool({ projectRoot: root }).execute(
        invocation({ serverName: "chrome-devtools", toolName: "navigate" }),
        deps(),
      );

      expect(result.ok).toBe(false);
      const { BrowserOperationLedger } = await import("@roll/core");
      expect(new BrowserOperationLedger().read(join(root, ".roll", "browser-operations", "events.ndjson"))).toMatchObject([
        { type: "browser:mcp-bypass-denied", reason: { code: "generic_mcp_bypass_denied" } },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps non-reserved project MCP servers compatible when the Browser transport registry is installed", async () => {
    const root = "/repo";
    const conn = connection({ content: [{ type: "text", text: "still available" }] });
    const tool = new McpTool({
      projectRoot: root,
      browserTransportRegistry: new BrowserTransportRegistry(),
      connect: async () => conn,
    });

    const result = await tool.execute(
      invocation({ serverName: "jira", toolName: "issue.get", arguments: { id: "ROLL-2" } }),
      deps({ [join(root, ".roll", "mcp-servers.json")]: JSON.stringify({ servers: { jira: { command: "jira-mcp" } } }) }),
    );

    expect(result).toMatchObject({ ok: true, output: { content: [{ text: "still available" }] } });
    expect(conn.calls).toEqual([{ toolName: "issue.get", args: { id: "ROLL-2" } }]);
  });

  it("validates arguments as a record", async () => {
    const result = await new McpTool({ projectRoot: "/repo" }).execute(
      invocation({ serverName: "jira", toolName: "issue.get", arguments: ["bad"] as unknown as Record<string, unknown> }),
      deps(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");
  });

  it("dispose disconnects initialized server connections", async () => {
    const root = "/repo";
    const configPath = join(root, ".roll", "mcp-servers.json");
    const conn = connection({ content: [{ type: "text", text: "ok" }] });
    const tool = new McpTool({ projectRoot: root, connect: async () => conn });

    await tool.execute(
      invocation({ serverName: "jira", toolName: "issue.get" }),
      deps({ [configPath]: JSON.stringify({ servers: { jira: { command: "jira-mcp" } } }) }),
    );
    await tool.dispose(deps());

    expect(conn.closed).toBe(1);
  });
});
