import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import { expectNoAdjacentBilingualPairs } from "./helpers.js";

const dirs: string[] = [];
const ENV_KEYS = ["HOME", "ROLL_HOME", "ROLL_LANG", "NO_COLOR", "LC_ALL", "LANG"];

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(argv: string[], lang: "en" | "zh"): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), "roll-cli-lang-"));
  dirs.push(home);
  mkdirSync(join(home, ".roll"), { recursive: true });
  const save: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    save[key] = process.env[key];
    delete process.env[key];
  }
  process.env["HOME"] = home;
  process.env["ROLL_HOME"] = join(home, ".roll");
  process.env["ROLL_LANG"] = lang;
  process.env["NO_COLOR"] = "1";
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += String(chunk);
    return true;
  };
  // @ts-expect-error capture-only
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += String(chunk);
    return true;
  };
  try {
    const result = await dispatch(argv, async () => ({ ok: true }));
    return {
      status: result.status,
      stdout: stdout.replaceAll(home, "<HOME>"),
      stderr: stderr.replaceAll(home, "<HOME>"),
    };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const key of ENV_KEYS) {
      const value = save[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterAll(() => {
  for (const dir of dirs) execSync(`rm -rf '${dir}'`);
});

beforeEach(() => {
  registerAll();
});

describe("US-LANG-003 CLI language surface", () => {
  it("shared detector fails on adjacent English/Chinese translation pairs with offending lines", () => {
    expect(() => expectNoAdjacentBilingualPairs("Processing...\n处理中...\n")).toThrow(/1: Processing\.\.\.\n2: 处理中/);
  });

  it("doctor --help is locale-pinned and single-language", async () => {
    const en = await runCli(["doctor", "--help"], "en");
    const zh = await runCli(["doctor", "--help"], "zh");
    expect(en.status).toBe(0);
    expect(zh.status).toBe(0);
    expectNoAdjacentBilingualPairs(en.stdout);
    expectNoAdjacentBilingualPairs(zh.stdout);
    expect({ en: en.stdout, zh: zh.stdout }).toMatchSnapshot();
  });

  it("loop --help is locale-pinned and single-language", async () => {
    const en = await runCli(["loop", "--help"], "en");
    const zh = await runCli(["loop", "--help"], "zh");
    expect(en.status).toBe(0);
    expect(zh.status).toBe(0);
    expectNoAdjacentBilingualPairs(en.stdout);
    expectNoAdjacentBilingualPairs(zh.stdout);
    expect({ en: en.stdout, zh: zh.stdout }).toMatchSnapshot();
  });

  it("config lang error output follows the selected locale", async () => {
    const en = await runCli(["config", "lang", "bogus"], "en");
    const zh = await runCli(["config", "lang", "bogus"], "zh");
    expect(en.status).toBe(2);
    expect(zh.status).toBe(2);
    expectNoAdjacentBilingualPairs(en.stderr + en.stdout);
    expectNoAdjacentBilingualPairs(zh.stderr + zh.stdout);
    expect({ en, zh }).toMatchSnapshot();
  });

  it("config success output follows the selected locale without adjacent translations", async () => {
    const en = {
      write: await runCli(["config", "loop_dream_hour", "5", "--global"], "en"),
      lang: await runCli(["config", "lang", "zh"], "en"),
      inactive: await runCli(["config", "dream-time", "03:20"], "en"),
    };
    const zh = {
      write: await runCli(["config", "loop_dream_hour", "5", "--global"], "zh"),
      lang: await runCli(["config", "lang", "en"], "zh"),
      inactive: await runCli(["config", "dream-time", "03:20"], "zh"),
    };
    for (const result of [...Object.values(en), ...Object.values(zh)]) {
      expect(result.status).toBe(0);
      expectNoAdjacentBilingualPairs(result.stdout + result.stderr);
    }
    expect({ en, zh }).toMatchSnapshot();
  });
});
