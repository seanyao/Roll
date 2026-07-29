import type { ExecOpts, ExecResult, MinimalFs, RollCaptureRequestV1, RollCaptureResponseV1, ToolDeps, ToolInvocation, ToolPolicy } from "@roll/spec";
import { ROLL_CAPTURE_PROTOCOL_V1 } from "@roll/spec";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrowserTool,
  RollCaptureProvider,
  browserTools,
  type BrowserConsoleOutput,
  type BrowserDomQueryOutput,
  type PhysicalScreenshotOutput,
  type BrowserScreenshotOutput,
  type BrowserToolId,
} from "../src/index.js";
import { TOOL_TEST_REPO_ID, toolWorkspaceContext } from "./tool-workspace-context.js";

const policy = (sandbox: ToolPolicy["sandbox"] = {}): ToolPolicy => ({
  enabled: true,
  timeoutMs: 1000,
  sandbox,
});

function invocation<I>(toolId: BrowserToolId, input: I, sandbox: ToolPolicy["sandbox"] = {}): ToolInvocation<I> {
  return {
    invocationId: `inv-${toolId}`,
    toolId: toolId as ToolInvocation<I>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-TOOL-005", agent: "codex" },
    policy: policy(sandbox),
    ts: 100,
    context: toolWorkspaceContext("US-TOOL-005"),
    repoId: TOOL_TEST_REPO_ID,
  };
}

function workspaceArtifact(name: string, authority: "toolDumps" | "evidence" = "toolDumps"): string {
  return join(toolWorkspaceContext("US-TOOL-005").authorities[authority], name);
}

type Call = { command: string; args: readonly string[]; opts?: ExecOpts };

function fakeDeps(handler: (command: string, args: readonly string[], opts?: ExecOpts) => ExecResult | Promise<ExecResult>): ToolDeps & {
  calls: Call[];
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const calls: Call[] = [];
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
      return handler(command, args, opts);
    },
    redact: (value) => value.replaceAll("SECRET", "[REDACTED]"),
  };
}

describe("US-TOOL-005 BrowserTool", () => {
  it("exposes browser and physical screenshot tool declarations from one adapter family", () => {
    expect(browserTools().map((tool) => tool.declaration.id)).toEqual([
      "browser.screenshot",
      "browser.console",
      "browser.dom-query",
      "physical.screenshot",
    ]);
    expect(browserTools().map((tool) => [tool.declaration.id, tool.declaration.kind])).toEqual([
      ["browser.screenshot", "browser"],
      ["browser.console", "browser"],
      ["browser.dom-query", "browser"],
      ["physical.screenshot", "physical"],
    ]);
  });

  it("takes a headless screenshot and writes non-empty output", async () => {
    const screenshotPath = workspaceArtifact("out.png");
    const deps = fakeDeps((command, args) => {
      if (command === "npx" && args.includes("screenshot")) {
        return { exitCode: 0, stdout: JSON.stringify({ finalUrl: "https://example.com/app", statusCode: 200, png: "PNGDATA" }), stderr: "", timedOut: false };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
    });
    const result = await new BrowserTool("browser.screenshot").execute(
      invocation(
        "browser.screenshot",
        { url: "https://example.com/app", screenshotPath, viewport: { width: 800, height: 600 }, waitFor: "#app" },
        { headlessOnly: true },
      ),
      deps,
    );

    expect(result).toMatchObject({ ok: true, output: { screenshotPath, finalUrl: "https://example.com/app", statusCode: 200 } });
    expect(deps.files.get(screenshotPath)).toBe("PNGDATA");
    expect(deps.calls[0]).toMatchObject({ command: "npx" });
    if (result.ok) expect((result.output as BrowserScreenshotOutput).screenshotPath).toBe(screenshotPath);
  });

  it("captures console logs through the headless lane", async () => {
    const deps = fakeDeps(() => ({
      exitCode: 0,
      stdout: JSON.stringify({
        finalUrl: "https://example.com/app",
        statusCode: 200,
        consoleLogs: [{ level: "log", text: "ready", ts: 123 }],
      }),
      stderr: "",
      timedOut: false,
    }));

    const result = await new BrowserTool("browser.console").execute(
      invocation("browser.console", { url: "https://example.com/app", waitFor: "#app" }, { headlessOnly: true }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.output as BrowserConsoleOutput).consoleLogs).toEqual([{ level: "log", text: "ready", ts: 123 }]);
  });

  it("returns DOM query matches through the headless lane", async () => {
    const deps = fakeDeps(() => ({
      exitCode: 0,
      stdout: JSON.stringify({
        finalUrl: "https://example.com/app",
        statusCode: 200,
        domResults: ["Hello", "World"],
      }),
      stderr: "",
      timedOut: false,
    }));

    const result = await new BrowserTool("browser.dom-query").execute(
      invocation("browser.dom-query", { url: "https://example.com/app", selector: "h1" }, { headlessOnly: true }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.output as BrowserDomQueryOutput).domResults).toEqual(["Hello", "World"]);
  });

  it("rejects URLs outside allowedOrigins before browser execution", async () => {
    const deps = fakeDeps(() => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    const result = await new BrowserTool("browser.console").execute(
      invocation("browser.console", { url: "https://evil.test/app" }, { allowedOrigins: ["https://example.com"] }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("sandbox_denied");
    expect(deps.calls).toHaveLength(0);
  });

  it("honestly skips when the headless lane is unavailable", async () => {
    const deps = fakeDeps(() => ({ exitCode: 127, stdout: "", stderr: "npx missing", timedOut: false }));
    const result = await new BrowserTool("browser.console").execute(
      invocation("browser.console", { url: "https://example.com/app" }, { headlessOnly: true }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("adapter_error");
      expect(result.error.message).toContain("headless browser unavailable");
    }
  });

  it("uses the macOS GUI screenshot lane when Aqua is available and headlessOnly is false", async () => {
    const screenshotPath = workspaceArtifact("gui.png");
    const originalCi = process.env.CI;
    delete process.env.CI;
    const deps = fakeDeps((command) => {
      if (command === "launchctl") return { exitCode: 0, stdout: "Aqua\n", stderr: "", timedOut: false };
      if (command === "osascript") return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      if (command === "screencapture") return { exitCode: 0, stdout: "PNGDATA", stderr: "", timedOut: false };
      return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
    });

    const result = await new BrowserTool("browser.screenshot").execute(
      invocation("browser.screenshot", { url: "https://example.com/app", screenshotPath }, { headlessOnly: false }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.calls.map((call) => call.command)).toEqual(["launchctl", "osascript", "screencapture"]);
    expect(deps.files.get(screenshotPath)).toBe("PNGDATA");
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  });

  it("physical.screenshot writes a Roll Capture request and never falls back to browser lanes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-physical-tool-"));
    const screenshotPath = workspaceArtifact("physical.png", "evidence");
    let now = 0;
    let responseWritten = false;
    const provider = new RollCaptureProvider({
      root: dir,
      defaultPollIntervalMs: 1,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        if (!responseWritten) {
          mkdirSync(join(dir, "responses"), { recursive: true });
          writeFileSync(join(dir, "responses", `response-${request.requestId}.json`), JSON.stringify(response), "utf8");
          responseWritten = true;
        }
      },
    });
    const request: RollCaptureRequestV1 = {
      protocol: ROLL_CAPTURE_PROTOCOL_V1,
      requestId: "US-TOOL-005-physical-terminal",
      storyId: "US-TOOL-005",
      kind: "physical_terminal",
      target: { type: "window", appName: "Terminal", windowTitle: "roll attest US-TOOL-005" },
      out: screenshotPath,
      timeoutMs: 1000,
      createdAt: "2026-07-03T11:35:00.000+08:00",
    };
    const response: RollCaptureResponseV1 = {
      protocol: ROLL_CAPTURE_PROTOCOL_V1,
      requestId: request.requestId,
      status: "taken",
      screenshotPath,
      responsePath: join(dir, "responses", `response-${request.requestId}.json`),
      host: { appName: "Roll Capture.app", bundleId: "com.seanyao.roll.capture", version: "0.1.0" },
      startedAt: "2026-07-03T11:35:01.100+08:00",
      finishedAt: "2026-07-03T11:35:01.820+08:00",
    };
    const deps = fakeDeps((command) => {
      return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
    });

    try {
      const result = await new BrowserTool("physical.screenshot", undefined, provider).execute(
        invocation("physical.screenshot", request, { headlessOnly: true }),
        deps,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect((result.output as PhysicalScreenshotOutput)).toMatchObject({ status: "taken", path: screenshotPath });
      expect(JSON.parse(readFileSync(join(dir, "inbox", `request-${request.requestId}.json`), "utf8"))).toEqual(request);
      expect(deps.calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the headless lane when Aqua is unavailable and honestly skips if headless is also unavailable", async () => {
    const screenshotPath = workspaceArtifact("gui-unavailable.png");
    const originalCi = process.env.CI;
    delete process.env.CI;
    const deps = fakeDeps((command) => {
      if (command === "launchctl") return { exitCode: 0, stdout: "Background\n", stderr: "", timedOut: false };
      if (command === "npx") return { exitCode: 127, stdout: "", stderr: "npx missing", timedOut: false };
      return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
    });
    const result = await new BrowserTool("browser.screenshot").execute(
      invocation("browser.screenshot", { url: "https://example.com/app", screenshotPath }, { headlessOnly: false }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("headless browser unavailable");
    expect(deps.calls.map((call) => call.command)).toEqual(["launchctl", "npx"]);
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  });

  it("queues concurrent invocations through one shared browser state", async () => {
    const observed: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const deps = fakeDeps(async (_command, args) => {
      const url = args.at(-1) ?? "";
      observed.push(`start:${url}`);
      if (url.includes("first")) await firstBlocked;
      observed.push(`end:${url}`);
      return { exitCode: 0, stdout: JSON.stringify({ finalUrl: url, statusCode: 200, consoleLogs: [] }), stderr: "", timedOut: false };
    });
    const shared = browserTools();

    const first = shared[1]!.execute(invocation("browser.console", { url: "https://example.com/first" }, { headlessOnly: true }), deps);
    const second = shared[1]!.execute(invocation("browser.console", { url: "https://example.com/second" }, { headlessOnly: true }), deps);

    await Promise.resolve();
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(observed).toEqual([
      "start:https://example.com/first",
      "end:https://example.com/first",
      "start:https://example.com/second",
      "end:https://example.com/second",
    ]);
  });
});
