import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@roll/core";
import type { MinimalFs, ToolDeps, ToolInvocation, ToolPolicy } from "@roll/spec";
import { describe, expect, it } from "vitest";
import {
  BashTool,
  browserTools,
  builtinToolDeclarations,
  fsTools,
  gitTools,
  githubTools,
  mcpTools,
  networkTools,
} from "../src/index.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const validation = JSON.parse(readFileSync(join(root, "docs", "generated", "workspace-context-validation-cases.json"), "utf8")) as {
  operationCases: Array<{ id: string; policyKey: string; surface: string; testFile: string; testName: string }>;
};
const adapters = [
  new BashTool(),
  ...browserTools(),
  ...fsTools(),
  ...gitTools(),
  ...githubTools(),
  ...mcpTools(),
  ...networkTools(),
].map((tool) => tool as unknown as Tool<unknown, unknown>);

const fs: MinimalFs = {
  readFile: async () => "",
  writeFile: async () => undefined,
  mkdir: async () => undefined,
};
const deps: ToolDeps = {
  fs,
  now: () => 100,
  execFile: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
  redact: (value) => value,
};
const policy: ToolPolicy = { enabled: true, timeoutMs: 1000, sandbox: {} };

const toolCases = adapters.map((adapter) => {
  const operation = String(adapter.declaration.id);
  const id = operation.split(".")[0] ?? operation;
  const key = `tool:${id}:${operation}`;
  return {
    testName: `rejects missing execution context before adapter effects for ${key}`,
    key,
    adapter,
  };
});

describe("US-WS-040 executable built-in tool operation evidence", () => {
  it("constructs every live built-in adapter exactly once", () => {
    expect(adapters.map((adapter) => String(adapter.declaration.id)).sort()).toEqual(
      builtinToolDeclarations().map((declaration) => String(declaration.id)).sort(),
    );
  });

  it.each(toolCases)("$testName", async ({ key, adapter }) => {
    const operation = String(adapter.declaration.id);
    const invocation = {
      invocationId: `probe-${operation}`,
      toolId: adapter.declaration.id,
      input: {},
      caller: { cycleId: "cycle-operation-probe", storyId: "US-WS-040", agent: "vitest" },
      policy,
      ts: 100,
    } as ToolInvocation<unknown>;

    const result = await adapter.execute(invocation, deps);
    expect(result, key).toMatchObject({ ok: false, error: { code: "missing_execution_context" } });
    expect(validation.operationCases.filter((entry) => entry.policyKey === key)).toEqual([{
      id: `operation:${key}`,
      policyKey: key,
      surface: "tool",
      testFile: "packages/infra/test/workspace-context-operation-evidence.test.ts",
      testName: `rejects missing execution context before adapter effects for ${key}`,
    }]);
  });
});
