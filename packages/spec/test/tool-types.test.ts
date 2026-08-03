import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CycleCost,
  ExecOpts,
  ExecResult,
  MinimalFs,
  ToolCaller,
  ToolCost,
  ToolDeclaration,
  ToolDefaults,
  ToolDeps,
  ToolError,
  ToolErrorCode,
  ToolEvent,
  ToolId,
  ToolInvocation,
  ToolKind,
  ToolMeta,
  ToolPolicy,
  ToolReadiness,
  ToolRequirement,
  ToolRequirementResolution,
  ToolResult,
  ToolSandbox,
} from "../src/index.js";

describe("US-TOOL-001 tool type contracts", () => {
  it("includes closed execution-context failure codes", () => {
    const codes: ToolErrorCode[] = ["missing_execution_context", "invalid_execution_context"];
    expect(codes).toEqual(["missing_execution_context", "invalid_execution_context"]);
  });

  it("exports the complete tool type surface", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/types/tool.ts"), "utf8");
    const exports = [...source.matchAll(/^export type (\w+)/gm)].map((match) => match[1]).sort();

    expect(exports).toMatchSnapshot();
  });

  it("re-exports tool contracts from the types barrel", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/types/index.ts"), "utf8");

    expect(source).toContain('export * from "./tool.js";');
  });

  it("types declarations, invocation, result, policy, deps, events, and costs", () => {
    const id: ToolId = "bash.exec";
    const kind: ToolKind = "bash";
    const defaults: ToolDefaults = {
      timeoutMs: 1_000,
      retry: { attempts: 2, backoffMs: 10 },
      sandbox: { allowedPaths: ["/tmp"], blockedCommands: ["rm"], hardTimeoutSec: 1, maxOutputBytes: 4096 },
      maxInvocationsPerCycle: 3,
    };
    const requirement: ToolRequirement = { kind: "executable", name: "bash", optional: false };
    const requirementResolution: ToolRequirementResolution = {
      requirement,
      status: "missing",
      detail: "bash is not on PATH.",
      repair: { command: "brew install bash" },
    };
    const readiness: ToolReadiness = {
      toolId: id,
      status: "unavailable",
      requirements: [requirementResolution],
      detail: requirementResolution.detail,
      repairCommands: ["brew install bash"],
    };
    const declaration: ToolDeclaration = { id, kind, title: "Bash", description: "Execute argv", defaults, requirements: [requirement] };
    const caller: ToolCaller = { cycleId: "cycle-1", storyId: "US-TOOL-001", agent: "codex" };
    const sandbox: ToolSandbox = { allowedOrigins: ["http://localhost"], headlessOnly: true };
    const policy: ToolPolicy = { enabled: true, timeoutMs: 2_000, maxInvocationsPerCycle: 4, sandbox };
    const invocation: ToolInvocation<{ command: string }> = {
      invocationId: "inv-1",
      toolId: id,
      input: { command: "pwd" },
      caller,
      policy,
      ts: 1,
    };
    const meta: ToolMeta = { invocationId: "inv-1", toolId: id, caller, startedAt: 1, endedAt: 2, durationMs: 1 };
    const code: ToolErrorCode = "policy_denied";
    const error: ToolError = { code, message: "denied", retryable: false };
    const ok: ToolResult<{ stdout: string }> = { ok: true, output: { stdout: "x" }, meta };
    const failed: ToolResult<never> = { ok: false, error, meta };
    const cost: ToolCost = { toolId: id, invocations: 1, durationMs: 12, failures: 0, estimatedCost: 0, currency: "USD" };
    const cycleCost: CycleCost = {
      cycleId: "cycle-1",
      agent: "codex",
      model: "gpt-5",
      tokensIn: 1,
      tokensOut: 1,
      estimatedCost: 0,
      revertCount: 0,
      effectiveCost: 0,
      currency: "USD",
      toolCosts: [cost],
    };
    const invokeEvent: ToolEvent = { type: "tool:invoke", cycleId: "cycle-1", invocation, declaration, ts: 1 };
    const resultEvent: ToolEvent = { type: "tool:result", cycleId: "cycle-1", invocationId: "inv-1", toolId: id, result: ok, ts: 2 };
    const fs: MinimalFs = {
      readFile: async () => "x",
      writeFile: async () => undefined,
      mkdir: async () => undefined,
    };
    const execOpts: ExecOpts = { cwd: "/tmp", env: { A: "B" }, timeoutMs: 1_000, maxOutputBytes: 100 };
    const execResult: ExecResult = { exitCode: 0, stdout: "x", stderr: "", timedOut: false };
    const deps: ToolDeps = {
      fs,
      now: () => 1,
      execFile: async () => execResult,
      redact: (value) => value,
    };

    expect({
      declaration,
      failed,
      invokeEvent,
      readiness,
      requirementResolution,
      resultEvent,
      cycleCost,
      deps,
      execOpts,
    }).toBeTruthy();
  });
});
