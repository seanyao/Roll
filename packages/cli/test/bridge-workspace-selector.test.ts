import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalizeWorkspaceAliasTokens,
  dispatch,
  parseCanonicalWorkspaceSelectorArgs,
  registerPorted,
  registeredCliOperations,
} from "../src/bridge.js";
import {
  aliasHelpDecision,
  cliMatchedOperation,
  validateWorkspaceSelectorOperations,
  workspaceSelectorOperation,
  workspaceSelectorOperations,
} from "../src/lib/command-surface.js";
import { policyWorkspaceSelectorOperations } from "../src/lib/workspace-context-policy.js";
import { registerAll } from "../src/commands/index.js";

registerAll();
const LIVE_CLI_OPERATIONS = registeredCliOperations();
const WORKSPACE_SELECTOR_OPERATIONS = workspaceSelectorOperations(LIVE_CLI_OPERATIONS);
const POLICY_WORKSPACE_SELECTOR_OPERATIONS = policyWorkspaceSelectorOperations(LIVE_CLI_OPERATIONS);

async function captureDispatch(argv: string[]): Promise<{
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  try {
    // @ts-expect-error test capture
    process.stdout.write = (chunk: string | Uint8Array): boolean => ((stdout += String(chunk)), true);
    // @ts-expect-error test capture
    process.stderr.write = (chunk: string | Uint8Array): boolean => ((stderr += String(chunk)), true);
    const result = await dispatch(argv, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

describe("US-WS-022 bridge Workspace selector normalization", () => {
  let calls: string[][];
  let englishHome: string;
  let savedRollHome: string | undefined;
  let savedRollLang: string | undefined;
  let savedRollWs: string | undefined;
  let savedRollWorkspace: string | undefined;
  let savedNoColor: string | undefined;

  beforeEach(() => {
    savedRollHome = process.env["ROLL_HOME"];
    savedRollLang = process.env["ROLL_LANG"];
    savedRollWs = process.env["ROLL_WS"];
    savedRollWorkspace = process.env["ROLL_WORKSPACE"];
    savedNoColor = process.env["NO_COLOR"];
    englishHome = mkdtempSync(join(tmpdir(), "roll-workspace-selector-en-"));
    const rollHome = join(englishHome, ".roll");
    mkdirSync(rollHome, { recursive: true });
    writeFileSync(join(rollHome, "config.yaml"), "lang: en\n");
    process.env["ROLL_HOME"] = rollHome;
    process.env["ROLL_LANG"] = "en";
    process.env["NO_COLOR"] = "1";
    delete process.env["ROLL_WS"];
    delete process.env["ROLL_WORKSPACE"];
    calls = [];
    registerPorted("backlog", (args) => {
      calls.push(args);
      return 0;
    });
  });

  afterEach(() => {
    if (savedRollHome === undefined) delete process.env["ROLL_HOME"];
    else process.env["ROLL_HOME"] = savedRollHome;
    if (savedRollLang === undefined) delete process.env["ROLL_LANG"];
    else process.env["ROLL_LANG"] = savedRollLang;
    if (savedRollWs === undefined) delete process.env["ROLL_WS"];
    else process.env["ROLL_WS"] = savedRollWs;
    if (savedRollWorkspace === undefined) delete process.env["ROLL_WORKSPACE"];
    else process.env["ROLL_WORKSPACE"] = savedRollWorkspace;
    if (savedNoColor === undefined) delete process.env["NO_COLOR"];
    else process.env["NO_COLOR"] = savedNoColor;
    rmSync(englishHome, { recursive: true, force: true });
  });

  it("normalizes the full argv before a family dispatcher without reordering", async () => {
    const result = await captureDispatch(["backlog", "show", "US-WS-022", "--ws", "roll", "--no-color"]);

    expect(result.status).toBe(0);
    expect(calls).toEqual([["show", "US-WS-022", "--workspace", "roll", "--no-color"]]);
  });

  it("is idempotent and leaves exact --ws tokens after -- untouched", () => {
    const once = canonicalizeWorkspaceAliasTokens(["show", "US-WS-022", "--ws", "roll", "--", "--ws"]);
    const twice = canonicalizeWorkspaceAliasTokens(once.args);

    expect(once).toEqual({
      args: ["show", "US-WS-022", "--workspace", "roll", "--", "--ws"],
      aliasUsed: true,
    });
    expect(twice).toEqual({ args: once.args, aliasUsed: false });
  });

  it("rejects duplicate canonical/alias selectors before the handler runs", async () => {
    const result = await captureDispatch([
      "backlog", "--workspace", "roll", "--ws", "roll", "--json",
    ]);

    expect(result.status).toBe(1);
    expect(calls).toEqual([]);
    expect(JSON.parse(result.stderr)).toEqual({
      schema: "roll.workspace-selector-error/v1",
      error: {
        code: "duplicate_workspace_selector",
        message: "Provide exactly one --workspace <id|path>.",
        command: "roll backlog",
        nextAction: "Remove the duplicate and use --workspace <id|path> once.",
      },
    });
    expect(result.stderr).not.toContain('"--ws"');
  });

  it("rejects a missing selector value without consuming the next flag", async () => {
    const result = await captureDispatch(["backlog", "--ws", "--no-color"]);

    expect(result.status).toBe(1);
    expect(calls).toEqual([]);
    expect(result.stderr).toContain("workspace_selector_missing_value");
    expect(result.stderr).toContain("--workspace <id|path>");
    expect(result.stderr).not.toMatch(/(^|\s)--ws(?=\s|$)/u);
  });

  it("treats the option sentinel as a missing value for either selector spelling", async () => {
    for (const selector of ["--workspace", "--ws"] as const) {
      calls = [];
      const result = await captureDispatch(["backlog", selector, "--", "--json"]);

      expect(result.status, selector).toBe(1);
      expect(calls, selector).toEqual([]);
      expect(result.stderr, selector).toContain("workspace_selector_missing_value");
      expect(result.stderr, selector).toContain("--workspace <id|path>");
      expect(result.stderr, selector).not.toMatch(/(^|\s)--ws(?=\s|$)/u);
      expect(() => JSON.parse(result.stderr), selector).toThrow();
    }
  });

  it("keeps bare workspace and delivery usage handlers reachable through the guard", async () => {
    const workspace = await captureDispatch(["workspace"]);
    const delivery = await captureDispatch(["delivery"]);
    expect(workspace).toMatchObject({ status: 0, stderr: "" });
    expect(workspace.stdout).toContain("Usage: roll workspace");
    expect(delivery).toMatchObject({ status: 0, stderr: "" });
    expect(delivery.stdout).toContain("Usage: roll delivery");
  });

  it.each(["--workspace", "--ws"])("rejects unsupported selector %s before the handler runs", async (selector) => {
    const unsupportedCalls: string[][] = [];
    registerPorted("status", (args) => {
      unsupportedCalls.push(args);
      return 9;
    });

    const result = await captureDispatch(["status", selector, "roll"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not accept --workspace");
    expect(unsupportedCalls).toEqual([]);
  });

  it("does not treat a post-sentinel --workspace literal as a selector capability", async () => {
    const unsupportedCalls: string[][] = [];
    registerPorted("status", (args) => {
      unsupportedCalls.push(args);
      return 9;
    });
    const result = await captureDispatch(["status", "--", "--workspace", "roll"]);
    expect(result.status).toBe(9);
    expect(unsupportedCalls).toEqual([["--", "--workspace", "roll"]]);
  });

  it.each(["monitor", "attach", "branches", "test-quality-check"])(
    "rejects retired loop route %s without counting it as a live operation",
    async (route) => {
      registerAll();
      const operations = registeredCliOperations().filter((entry) => entry.command === "loop");
      let handlerRuns = 0;
      registerPorted("loop", () => {
        handlerRuns += 1;
        return 9;
      }, { operations });

      const result = await captureDispatch(["loop", route]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`[roll] unknown loop subcommand: ${route}`);
      expect(result.stderr).toContain("Usage: roll loop");
      expect(handlerRuns).toBe(0);
    },
  );

  it.each([
    {
      name: "issue help canonical duplicate",
      args: ["issue", "--help", "--workspace", "roll", "--workspace", "other"],
      code: "duplicate_workspace_selector",
    },
    {
      name: "issue help alias combination",
      args: ["issue", "--help", "--ws", "roll", "--workspace", "other"],
      code: "duplicate_workspace_selector",
    },
    {
      name: "issue help missing alias value",
      args: ["issue", "--help", "--ws", "--json"],
      code: "workspace_selector_missing_value",
    },
    {
      name: "requirement help alias duplicate",
      args: ["requirement", "--help", "--workspace", "roll", "--ws", "other"],
      code: "duplicate_workspace_selector",
    },
    {
      name: "requirement help missing canonical value",
      args: ["requirement", "--help", "--workspace", "--json"],
      code: "workspace_selector_missing_value",
    },
  ])("validates $name from the uniquely matched selector operation", async ({ args, code }) => {
    registerAll();
    const operations = registeredCliOperations().filter((entry) => entry.command === "workspace");
    const calls: string[][] = [];
    registerPorted("workspace", (handlerArgs) => {
      calls.push(handlerArgs);
      return 91;
    }, { operations });

    const result = await captureDispatch(["workspace", ...args]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(code);
    expect(calls).toEqual([]);
  });

  it("passes post-sentinel selector literals to a uniquely matched selector operation", async () => {
    registerAll();
    const operations = registeredCliOperations().filter((entry) => entry.command === "workspace");
    const calls: string[][] = [];
    registerPorted("workspace", (args) => {
      calls.push(args);
      return 91;
    }, { operations });

    const result = await captureDispatch(["workspace", "issue", "--help", "--", "--ws", "literal"]);
    expect(result).toMatchObject({ status: 91, stderr: "" });
    expect(calls).toEqual([["issue", "--help", "--", "--ws", "literal"]]);
  });

  it("fails closed before an unsupported public handler can consume canonical --workspace", async () => {
    registerAll();

    const result = await captureDispatch(["config", "--ws"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown or unregistered route '--workspace'");
    expect(result.stderr).not.toMatch(/--ws(?=['"\s]|$)/u);
  });

  it("does not rewrite lookalike options or introduce a ROLL_WS environment alias", async () => {
    const observations: Array<{
      readonly args: readonly string[];
      readonly rollWs?: string;
      readonly rollWorkspace?: string;
    }> = [];
    registerPorted("backlog", (args) => {
      observations.push({
        args: [...args],
        ...(process.env["ROLL_WS"] === undefined ? {} : { rollWs: process.env["ROLL_WS"] }),
        ...(process.env["ROLL_WORKSPACE"] === undefined ? {} : { rollWorkspace: process.env["ROLL_WORKSPACE"] }),
      });
      process.stdout.write(`${JSON.stringify(args)}\n`);
      return 0;
    });

    const lookalikes = await captureDispatch(["backlog", "--ws=roll", "--wsx", "--json"]);
    process.env["ROLL_WORKSPACE"] = "canonical-workspace";
    const withoutEnvAlias = await captureDispatch(["backlog", "--json"]);
    process.env["ROLL_WS"] = "must-not-select-anything";
    const withEnvAlias = await captureDispatch(["backlog", "--json"]);

    expect(JSON.parse(lookalikes.stdout)).toEqual(["--ws=roll", "--wsx", "--json"]);
    expect(withEnvAlias).toEqual(withoutEnvAlias);
    expect(JSON.parse(withEnvAlias.stdout)).toEqual(["--json"]);
    expect(observations).toEqual([
      { args: ["--ws=roll", "--wsx", "--json"] },
      { args: ["--json"], rollWorkspace: "canonical-workspace" },
      { args: ["--json"], rollWs: "must-not-select-anything", rollWorkspace: "canonical-workspace" },
    ]);
  });

  it("parses one canonical selector without treating post-sentinel literals as flags", () => {
    expect(parseCanonicalWorkspaceSelectorArgs([
      "show", "US-WS-022", "--workspace", "roll", "--", "--workspace", "literal",
    ])).toEqual({
      ok: true,
      selector: "roll",
      remaining: ["show", "US-WS-022", "--", "--workspace", "literal"],
    });
  });

  it("validates every declared selector capability and its exact alias mapping", () => {
    expect(() => validateWorkspaceSelectorOperations(WORKSPACE_SELECTOR_OPERATIONS)).not.toThrow();
    expect(POLICY_WORKSPACE_SELECTOR_OPERATIONS).toEqual(WORKSPACE_SELECTOR_OPERATIONS);

    for (const operation of POLICY_WORKSPACE_SELECTOR_OPERATIONS) {
      expect(operation.acceptsWorkspaceSelector, operation.id).toBe(true);
      expect(workspaceSelectorOperation(operation.command, operation.exampleArgs, LIVE_CLI_OPERATIONS), operation.id).toEqual(operation);
      const aliasArgs = operation.exampleArgs.map((arg) => arg === "--workspace" ? "--ws" : arg);
      expect(canonicalizeWorkspaceAliasTokens(aliasArgs).args, operation.id).toEqual(operation.exampleArgs);
      expect(parseCanonicalWorkspaceSelectorArgs(operation.exampleArgs), operation.id).toMatchObject({
        ok: true,
        selector: "roll",
      });
    }
  });

  it("dispatches canonical and alias selectors identically for every declared capability", async () => {
    for (const operation of POLICY_WORKSPACE_SELECTOR_OPERATIONS) {
      const operationCalls: string[][] = [];
      registerPorted(operation.command, (args) => {
        operationCalls.push(args);
        process.stdout.write(`${JSON.stringify({ command: operation.command, args })}\n`);
        return 23;
      });
      const aliasArgs = operation.exampleArgs.map((arg) => arg === "--workspace" ? "--ws" : arg);

      const canonical = await captureDispatch([operation.command, ...operation.exampleArgs]);
      const alias = await captureDispatch([operation.command, ...aliasArgs]);
      const canonicalWithSentinel = await captureDispatch([
        operation.command, ...operation.exampleArgs, "--", "--ws", "literal",
      ]);
      const aliasWithSentinel = await captureDispatch([
        operation.command, ...aliasArgs, "--", "--ws", "literal",
      ]);

      expect(alias, operation.id).toEqual(canonical);
      expect(canonical.status, operation.id).toBe(23);
      expect(aliasWithSentinel, `${operation.id} sentinel`).toEqual(canonicalWithSentinel);
      expect(operationCalls, operation.id).toEqual([
        [...operation.exampleArgs],
        [...operation.exampleArgs],
        [...operation.exampleArgs, "--", "--ws", "literal"],
        [...operation.exampleArgs, "--", "--ws", "literal"],
      ]);
    }
  });

  it("generates every duplicate-selector matrix from bridge-owned canonical errors", async () => {
    const duplicateCases = [
      { name: "canonical+alias", first: "--workspace", second: "--ws" },
      { name: "alias+alias", first: "--ws", second: "--ws" },
      { name: "canonical+canonical", first: "--workspace", second: "--workspace" },
    ] as const;

    for (const operation of POLICY_WORKSPACE_SELECTOR_OPERATIONS) {
      for (const duplicate of duplicateCases) {
        let handlerRuns = 0;
        registerPorted(operation.command, () => {
          handlerRuns += 1;
          return 0;
        });
        const selectorIndex = operation.exampleArgs.indexOf("--workspace");
        const args = [...operation.exampleArgs];
        args[selectorIndex] = duplicate.first;
        args.push(duplicate.second, "other", "--json");

        const result = await captureDispatch([operation.command, ...args]);

        expect(result.status, `${operation.id} ${duplicate.name}`).toBe(1);
        expect(handlerRuns, `${operation.id} ${duplicate.name}`).toBe(0);
        expect(JSON.parse(result.stderr), `${operation.id} ${duplicate.name}`).toEqual({
          schema: "roll.workspace-selector-error/v1",
          error: {
            code: "duplicate_workspace_selector",
            message: "Provide exactly one --workspace <id|path>.",
            command: operation.canonicalCommand,
            nextAction: "Remove the duplicate and use --workspace <id|path> once.",
          },
        });
        expect(result.stderr, `${operation.id} ${duplicate.name}`).not.toContain('"--ws"');
      }
    }
  });

  it("generates missing-value failures for both spellings without running handlers", async () => {
    for (const operation of POLICY_WORKSPACE_SELECTOR_OPERATIONS) {
      for (const selector of ["--workspace", "--ws"] as const) {
        let handlerRuns = 0;
        registerPorted(operation.command, () => {
          handlerRuns += 1;
          return 0;
        });
        const selectorIndex = operation.exampleArgs.indexOf("--workspace");
        const args = [
          ...operation.exampleArgs.slice(0, selectorIndex),
          selector,
          "--json",
          ...operation.exampleArgs.slice(selectorIndex + 2),
        ];

        const result = await captureDispatch([operation.command, ...args]);

        expect(result.status, `${operation.id} ${selector}`).toBe(1);
        expect(handlerRuns, `${operation.id} ${selector}`).toBe(0);
        expect(JSON.parse(result.stderr), `${operation.id} ${selector}`).toEqual({
          schema: "roll.workspace-selector-error/v1",
          error: {
            code: "workspace_selector_missing_value",
            message: "--workspace requires <id|path>; another flag is not a selector value.",
            command: operation.canonicalCommand,
            nextAction: "Provide a value with --workspace <id|path>.",
          },
        });
        expect(result.stderr, `${operation.id} ${selector}`).not.toContain('"--ws"');
      }
    }
  });

  it("derives help aliases from the command and selector capability registries", () => {
    expect(aliasHelpDecision("workspace", LIVE_CLI_OPERATIONS)).toEqual({
      canonicalCommand: "workspace",
      commandAliases: ["ws"],
      workspaceSelectorAliases: ["--ws"],
    });
    expect(aliasHelpDecision("backlog", LIVE_CLI_OPERATIONS)).toEqual({
      canonicalCommand: "backlog",
      commandAliases: [],
      workspaceSelectorAliases: ["--ws"],
    });
    expect(aliasHelpDecision("status", LIVE_CLI_OPERATIONS)).toBeUndefined();
  });

  it("rejects an unsupported selector alias before dispatch and canonicalizes ws to workspace", async () => {
    registerAll();
    const observed: string[][] = [];
    registerPorted("status", (args) => {
      observed.push(args);
      return 0;
    });
    const normalized = await captureDispatch(["status", "--ws", "roll"]);
    expect(normalized.status).toBe(1);
    expect(normalized.stderr).toContain("does not accept --workspace");
    expect(normalized.stderr).not.toMatch(/--ws(?=['"\s]|$)/u);
    expect(observed).toEqual([]);

    const workspaceCalls: string[][] = [];
    registerPorted("workspace", (args) => {
      workspaceCalls.push(args);
      return 0;
    });
    const alias = await captureDispatch(["ws", "create", "demo", "--config", "demo.yaml"]);
    expect(alias.status).toBe(0);
    expect(workspaceCalls).toEqual([["create", "demo", "--config", "demo.yaml"]]);
  });

  it("keeps bare agent view callable but rejects the nonexistent agent view route", async () => {
    registerAll();
    const operations = registeredCliOperations().filter((entry) => entry.command === "agent");
    const calls: string[][] = [];
    registerPorted("agent", (args) => {
      calls.push(args);
      return 44;
    }, { operations });

    await expect(dispatch(["agent"])).resolves.toEqual({ status: 44 });
    await expect(dispatch(["agent", "view"])).resolves.toEqual({ status: 1 });
    expect(calls).toEqual([[]]);
  });

  it("fails closed before runtime dispatch when operation matchers are ambiguous", async () => {
    let handlerRuns = 0;
    registerPorted("status", () => {
      handlerRuns += 1;
      return 45;
    }, {
      operations: [
        cliMatchedOperation("status", "one", [], [], () => true),
        cliMatchedOperation("status", "two", [], [], () => true),
      ],
    });
    await expect(dispatch(["status"])).resolves.toEqual({ status: 1 });
    expect(handlerRuns).toBe(0);
  });
});
