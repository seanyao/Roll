import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MinimalFs, ToolDeps, ToolInvocation, ToolPolicy } from "@roll/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NetworkTool,
  networkTools,
  type NetworkInput,
  type NetworkOutput,
} from "../src/index.js";
import { TOOL_TEST_REPO_ID, toolWorkspaceContext } from "./tool-workspace-context.js";

const originalEnv = { ...process.env };
const servers: Server[] = [];
const localTcpAvailable = await canListenOnLocalhost();
const tcpIt = localTcpAvailable ? it : it.skip;

beforeEach(() => {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[key];
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind to TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function canListenOnLocalhost(): Promise<boolean> {
  const server = createServer();
  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function deps(): ToolDeps {
  const fs: MinimalFs = {
    readFile: async () => "",
    writeFile: async () => undefined,
    mkdir: async () => undefined,
  };
  return {
    fs,
    now: () => Date.now(),
    execFile: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    redact: (value) => value.replaceAll("SECRET", "[REDACTED]"),
  };
}

const policy = (overrides: Partial<ToolPolicy> = {}): ToolPolicy => ({
  enabled: true,
  timeoutMs: 1000,
  sandbox: {},
  ...overrides,
});

function invocation(input: NetworkInput, overrides: Partial<ToolPolicy> = {}): ToolInvocation<NetworkInput> {
  return {
    invocationId: "inv-network",
    toolId: "network.fetch" as ToolInvocation<NetworkInput>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-TOOL-009", agent: "codex" },
    policy: policy(overrides),
    ts: 100,
    context: toolWorkspaceContext("US-TOOL-009"),
    repoId: TOOL_TEST_REPO_ID,
  };
}

describe("US-TOOL-009 NetworkTool", () => {
  it("exposes the network.fetch declaration", () => {
    const tools = networkTools();

    expect(tools.map((tool) => tool.declaration.id)).toEqual(["network.fetch"]);
    expect(tools[0]?.declaration.kind).toBe("network");
  });

  tcpIt("fetches GET 200 responses with headers and body", async () => {
    const base = await serve((_req, res) => {
      res.setHeader("x-roll", "ok");
      res.end("hello SECRET");
    });

    const result = await new NetworkTool().execute(invocation({ url: `${base}/ok` }), deps());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.output as NetworkOutput;
      expect(output.statusCode).toBe(200);
      expect(output.headers["x-roll"]).toBe("ok");
      expect(output.body).toBe("hello [REDACTED]");
      expect(output.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  tcpIt("returns ok:true for GET 404 with the status code in output", async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 404;
      res.end("missing");
    });

    const result = await new NetworkTool().execute(invocation({ url: `${base}/missing` }), deps());

    expect(result).toMatchObject({ ok: true, output: { statusCode: 404, body: "missing" } });
  });

  tcpIt("times out and retries according to policy", async () => {
    let calls = 0;
    const base = await serve((_req, res) => {
      calls += 1;
      setTimeout(() => res.end("late"), 80);
    });

    const result = await new NetworkTool().execute(
      invocation({ url: `${base}/slow`, timeoutMs: 20 }, { retry: { attempts: 2, backoffMs: 0 } }),
      deps(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
    expect(calls).toBe(2);
  });

  tcpIt("rejects hosts outside allowedOrigins", async () => {
    const base = await serve((_req, res) => res.end("blocked"));

    const result = await new NetworkTool().execute(
      invocation({ url: `${base}/blocked` }, { sandbox: { allowedOrigins: ["https://example.com"] } }),
      deps(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("policy_denied");
  });

  it("rejects requests when sandbox network is blocked", async () => {
    const result = await new NetworkTool().execute(
      invocation({ url: "http://127.0.0.1:9/nope" }, { sandbox: { network: "blocked" } }),
      deps(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("policy_denied");
  });

  tcpIt("follows redirects", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/start") {
        res.statusCode = 302;
        res.setHeader("location", "/end");
        res.end();
        return;
      }
      res.end("redirected");
    });

    const result = await new NetworkTool().execute(invocation({ url: `${base}/start` }), deps());

    expect(result).toMatchObject({ ok: true, output: { statusCode: 200, body: "redirected" } });
  });

  tcpIt("uses HTTP_PROXY for http targets", async () => {
    let proxySawFullUrl = "";
    const target = await serve((_req, res) => res.end("direct"));
    const proxy = await serve((req, res) => {
      proxySawFullUrl = req.url ?? "";
      res.end("proxied");
    });
    process.env["HTTP_PROXY"] = proxy;

    const result = await new NetworkTool().execute(invocation({ url: `${target}/via-proxy` }), deps());

    expect(result).toMatchObject({ ok: true, output: { statusCode: 200, body: "proxied" } });
    expect(proxySawFullUrl).toBe(`${target}/via-proxy`);
  });

  it("init and dispose are no-ops", async () => {
    const tool = new NetworkTool();
    const d = deps();

    await expect(tool.init(d)).resolves.toBeUndefined();
    await expect(tool.dispose(d)).resolves.toBeUndefined();
  });
});
