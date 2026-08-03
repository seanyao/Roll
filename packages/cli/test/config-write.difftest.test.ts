/**
 * diff-test: TS `roll config` write surface + compact facades — frozen v2 oracle.
 *
 * Per US-PORT-009d the bash oracle spawn is dropped; values below were captured
 * while tests were green (TS == oracle) and then frozen.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configCommand } from "../src/commands/config.js";
import { seedUpdateCheckCache } from "./helpers.js";

const REPO = resolve(__dirname, "../../..");
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) execFileSync("rm", ["-rf", d]);
});

interface Sandbox {
  home: string;
  proj: string;
}

function freshSandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "roll-cfgw-home-"));
  const proj = mkdtempSync(join(tmpdir(), "roll-cfgw-proj-"));
  dirs.push(home, proj);
  mkdirSync(join(home, ".roll"), { recursive: true });
  seedUpdateCheckCache(join(home, ".roll"));
  writeFileSync(join(home, ".roll", "config.yaml"), "");
  mkdirSync(join(proj, ".roll"), { recursive: true });
  return { home, proj };
}

function tsCfg(sb: Sandbox, args: string[]): { status: number; stdout: string; stderr: string } {
  const save = {
    HOME: process.env["HOME"],
    ROLL_HOME: process.env["ROLL_HOME"],
    NO_COLOR: process.env["NO_COLOR"],
    ROLL_LANG: process.env["ROLL_LANG"],
  };
  process.env["HOME"] = sb.home;
  process.env["ROLL_HOME"] = join(sb.home, ".roll");
  process.env["NO_COLOR"] = "1";
  // US-LOOP-120: the inactive-key notes follow the locale, so a frozen value is only
  // portable with the language PINNED — otherwise this passes on an en box and fails
  // under ROLL_LANG=zh or in CI. Same class of trap this repo hit with TZ. The
  // `finally` below restores every key in `save`, so adding it here is enough.
  process.env["ROLL_LANG"] = "en";
  const saveCwd = process.cwd();
  process.chdir(sb.proj);
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (outChunks.push(String(c)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (c: string | Uint8Array): boolean => (errChunks.push(String(c)), true);
  let status: number;
  try {
    status = configCommand(args);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.chdir(saveCwd);
    for (const [k, v] of Object.entries(save)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { status, stdout: outChunks.join(""), stderr: errChunks.join("") };
}

function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

interface Case {
  name: string;
  args: string[];
  file?: "project" | "global";
}

const CASES: Case[] = [
  { name: "flat global write", args: ["loop_dream_hour", "5", "--global"], file: "global" },
  { name: "retired loop-window is rejected before project config creation", args: ["loop-window", "9-18"], file: "project" },
  { name: "retired loop-schedule is rejected before project config creation", args: ["loop-schedule", "45/7"], file: "project" },
  { name: "retired raw scheduler key is rejected before project config creation", args: ["loop_schedule.period_minutes", "30"], file: "project" },
  { name: "dream-time facade", args: ["dream-time", "03:20"], file: "global" },
  { name: "dream-time read default", args: ["dream-time"] },
  { name: "above max", args: ["loop_dream_hour", "99", "--global"] },
  { name: "non-integer", args: ["loop_dream_hour", "abc", "--global"] },
  { name: "unknown key write", args: ["nope", "5"] },
  { name: "too many args", args: ["loop_dream_hour", "5", "6"] },
  { name: "dream-time bad format", args: ["dream-time", "0320"] },
  { name: "dream-time hour out of range", args: ["dream-time", "25:00"] },
];

/** Frozen oracle outputs captured while tests were green. */
function frozen(c: Case): { status: number; stdout: string; stderr: string; fileContent: string | null } {
  switch (c.name) {
    case "flat global write":
      return { status: 0, stdout: "[roll] ✓ set loop_dream_hour = 5 in <HOME>/.roll/config.yaml\nnote: this key is inactive — nothing reads it\n", stderr: "", fileContent: "loop_dream_hour: 5\n" };
    case "retired loop-window is rejected before project config creation":
      return { status: 2, stdout: "", stderr: "[roll] config: 'loop-window' is retired; run 'roll loop go' when needed\n[roll] config：'loop-window' 已退役；需要时请运行 'roll loop go'\n", fileContent: null };
    case "retired loop-schedule is rejected before project config creation":
      return { status: 2, stdout: "", stderr: "[roll] config: 'loop-schedule' is retired; run 'roll loop go' when needed\n[roll] config：'loop-schedule' 已退役；需要时请运行 'roll loop go'\n", fileContent: null };
    case "retired raw scheduler key is rejected before project config creation":
      return { status: 2, stdout: "", stderr: "[roll] config: 'loop_schedule.period_minutes' is retired; run 'roll loop go' when needed\n[roll] config：'loop_schedule.period_minutes' 已退役；需要时请运行 'roll loop go'\n", fileContent: null };
    case "dream-time facade":
      return { status: 0, stdout: "[roll] ✓ set dream-time = 03:20 in <HOME>/.roll/config.yaml\nnote: nothing reads this — run `roll dream run-once` when you want a scan\n", stderr: "", fileContent: "loop_dream_hour: 3\nloop_dream_minute: 20\n" };
    case "dream-time read default":
      return { status: 0, stdout: "dream-time: 03:00 (from default) — inactive, nothing reads this\n", stderr: "", fileContent: null };
    case "above max":
      return { status: 2, stdout: "", stderr: "[roll] config: 'loop_dream_hour' must be <= 23 (got 99)\n[roll] config：'loop_dream_hour' 必须 <= 23（收到 99）\n", fileContent: null };
    case "non-integer":
      return { status: 2, stdout: "", stderr: "[roll] config: 'loop_dream_hour' expects an integer, got 'abc'\n[roll] config：'loop_dream_hour' 需要整数，收到 'abc'\n", fileContent: null };
    case "unknown key write":
      return { status: 2, stdout: "", stderr: "[roll] config: unknown key 'nope'\n[roll] config：未知 key 'nope'\n[roll] Try: roll config --list\n", fileContent: null };
    case "too many args":
      return { status: 2, stdout: "", stderr: "[roll] config: unexpected argument '6'\n[roll] config：多余参数 '6'\n", fileContent: null };
    case "dream-time bad format":
      return { status: 2, stdout: "", stderr: "[roll] config: dream-time expects <HH:MM>, got '0320'\n[roll] config：dream-time 需要 <HH:MM> 格式，收到 '0320'\n", fileContent: null };
    case "dream-time hour out of range":
      return { status: 2, stdout: "", stderr: "[roll] config: dream-time hour must be in [0,23]\n[roll] config：dream-time 小时必须在 [0,23]\n", fileContent: null };
    default:
      throw new Error("Unknown case: " + c.name);
  }
}

describe("frozen: roll config (write + facades)", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const sb = freshSandbox();
      const rel = c.file === "global" ? join(".roll", "config.yaml") : join(".roll", "local.yaml");
      const filePath = c.file === "global" ? join(sb.home, rel) : join(sb.proj, rel);
      const f = frozen(c);
      const t = tsCfg(sb, c.args);
      const tf = c.file !== undefined ? readIfExists(filePath) : null;

      // Global writes embed the absolute home path; scrub before compare.
      const tsStdout = t.stdout.replace(new RegExp(sb.home, "g"), "<HOME>");
      expect(t.status, "exit code").toBe(f.status);
      expect(tsStdout, "stdout").toBe(f.stdout);
      expect(t.stderr, "stderr").toBe(f.stderr);
      if (c.file !== undefined) expect(tf, "written yaml file").toBe(f.fileContent);
    });
  }
});
