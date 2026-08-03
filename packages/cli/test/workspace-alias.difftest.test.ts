import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, registerPorted } from "../src/bridge.js";
import { cliSelectorOperation } from "../src/lib/command-surface.js";

const WORKSPACE_SUBTREE_CASES: ReadonlyArray<{
  readonly name: string;
  readonly args: readonly string[];
}> = [
  { name: "list", args: ["list", "--json"] },
  { name: "create passthrough", args: ["create", "demo", "--config", "demo.workspace.yaml", "--check", "--json"] },
  { name: "edit passthrough", args: ["edit", "demo", "--display-name", "Demo", "--check", "--json"] },
  { name: "doctor", args: ["doctor", "demo", "--json"] },
  { name: "issue", args: ["issue", "init", "US-WS-022", "--workspace", "roll", "--check", "--json"] },
  { name: "requirement", args: ["requirement", "add", "--workspace", "roll", "--provider", "file", "--ref", "REQ-1"] },
  { name: "migrate", args: ["migrate", "--from", "/tmp/repo", "--check", "--workspace", "roll", "--json"] },
  { name: "show", args: ["show", "demo", "--json"] },
  { name: "register", args: ["register", "demo", "/tmp/demo", "--json"] },
  { name: "activate", args: ["activate", "demo", "--json"] },
  { name: "pause", args: ["pause", "demo", "--json"] },
  { name: "archive", args: ["archive", "demo", "--json"] },
];

let englishHome = "";
let savedRollHome: string | undefined;
let savedRollLang: string | undefined;

beforeEach(() => {
  savedRollHome = process.env["ROLL_HOME"];
  savedRollLang = process.env["ROLL_LANG"];
  englishHome = mkdtempSync(join(tmpdir(), "roll-workspace-alias-en-"));
  const rollHome = join(englishHome, ".roll");
  mkdirSync(rollHome, { recursive: true });
  writeFileSync(join(rollHome, "config.yaml"), "lang: en\n");
  process.env["ROLL_HOME"] = rollHome;
  process.env["ROLL_LANG"] = "en";
});

afterEach(() => {
  if (savedRollHome === undefined) delete process.env["ROLL_HOME"];
  else process.env["ROLL_HOME"] = savedRollHome;
  if (savedRollLang === undefined) delete process.env["ROLL_LANG"];
  else process.env["ROLL_LANG"] = savedRollLang;
  rmSync(englishHome, { recursive: true, force: true });
});

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

describe("US-WS-022 workspace command alias", () => {
  it("does not treat case, suffix or assignment lookalikes as the exact top-level alias", async () => {
    let handlerRuns = 0;
    registerPorted("workspace", () => {
      handlerRuns += 1;
      return 0;
    });

    for (const token of ["WS", "wss", "ws=demo"]) {
      const result = await captureDispatch([token, "list"]);
      const commandList = result.stderr.split("\n").find((line) => line.startsWith("Commands:")) ?? "";

      expect(result.status, token).toBe(1);
      expect(result.stdout, token).toBe("");
      expect(result.stderr, token).toContain(`unknown command '${token}'`);
      expect(commandList, token).toContain("workspace");
      expect(commandList, token).not.toMatch(/\bws\b/u);
    }
    expect(handlerRuns).toBe(0);
  });

  it("canonicalizes every representative workspace subtree through one handler", async () => {
    for (const testCase of WORKSPACE_SUBTREE_CASES) {
      const calls: string[][] = [];
      registerPorted("workspace", (args) => {
        calls.push(args);
        process.stdout.write(`${JSON.stringify({ command: "workspace", args })}\n`);
        return 7;
      });

      const canonical = await captureDispatch(["workspace", ...testCase.args]);
      const alias = await captureDispatch(["ws", ...testCase.args]);

      expect(alias, testCase.name).toEqual(canonical);
      expect(alias.status, testCase.name).toBe(7);
      expect(calls, testCase.name).toEqual([[...testCase.args], [...testCase.args]]);
      expect(alias.stdout, testCase.name).toContain('"command":"workspace"');
      expect(alias.stdout, testCase.name).not.toContain('"command":"ws"');
    }
  });

  it("keeps canonical help primary and derives the visible alias note", async () => {
    registerPorted("workspace", () => 9, {
      help: "Usage: roll workspace <create|list> [--workspace <id|path>]",
      operations: [cliSelectorOperation("workspace", "show", ["show"], ["show", "--workspace", "roll"])],
    });

    const canonical = await captureDispatch(["workspace", "--help"]);
    const alias = await captureDispatch(["ws", "--help"]);

    expect(alias).toEqual(canonical);
    expect(canonical.status).toBe(0);
    expect(canonical.stdout).toContain("Usage: roll workspace");
    expect(canonical.stdout).toContain("Alias: roll ws ...");
    expect(canonical.stdout).toContain("Workspace selector alias: --ws <id|path>");
    expect(canonical.stdout).not.toContain("Usage: roll ws");
  });

  it("renders generated alias notes in the configured help language", async () => {
    const home = mkdtempSync(join(tmpdir(), "roll-workspace-alias-lang-"));
    const rollHome = join(home, ".roll");
    mkdirSync(rollHome, { recursive: true });
    writeFileSync(join(rollHome, "config.yaml"), "lang: zh\n");
    const saved = {
      rollHome: process.env["ROLL_HOME"],
      rollLang: process.env["ROLL_LANG"],
    };
    process.env["ROLL_HOME"] = rollHome;
    delete process.env["ROLL_LANG"];
    registerPorted("workspace", () => 9, {
      help: "用法：roll workspace <list>",
      operations: [cliSelectorOperation("workspace", "show", ["show"], ["show", "--workspace", "roll"])],
    });

    try {
      const result = await captureDispatch(["ws", "--help"]);
      expect(result.stdout).toContain("别名：roll ws ...");
      expect(result.stdout).toContain("Workspace selector 别名：--ws <ID|路径>");
      expect(result.stdout).not.toContain("Alias: roll ws");
    } finally {
      if (saved.rollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = saved.rollHome;
      if (saved.rollLang === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = saved.rollLang;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
