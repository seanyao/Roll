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
  const save = { HOME: process.env["HOME"], ROLL_HOME: process.env["ROLL_HOME"], NO_COLOR: process.env["NO_COLOR"] };
  process.env["HOME"] = sb.home;
  process.env["ROLL_HOME"] = join(sb.home, ".roll");
  process.env["NO_COLOR"] = "1";
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
  { name: "nested project write (default scope)", args: ["loop_schedule.period_minutes", "30"], file: "project" },
  { name: "nested project write (explicit --project)", args: ["loop_active_start", "9", "--project"], file: "project" },
  { name: "loop-window facade", args: ["loop-window", "9-18"], file: "project" },
  { name: "loop-schedule facade with offset", args: ["loop-schedule", "45/7"], file: "project" },
  { name: "loop-schedule facade no offset", args: ["loop-schedule", "30"], file: "project" },
  { name: "dream-time facade", args: ["dream-time", "03:20"], file: "global" },
  { name: "loop-window read default", args: ["loop-window"] },
  { name: "loop-schedule read default", args: ["loop-schedule"] },
  { name: "dream-time read default", args: ["dream-time"] },
  { name: "above max", args: ["loop_dream_hour", "99", "--global"] },
  { name: "non-integer", args: ["loop_dream_hour", "abc", "--global"] },
  { name: "below min", args: ["loop_active_end", "0"] },
  { name: "unknown key write", args: ["nope", "5"] },
  { name: "too many args", args: ["loop_dream_hour", "5", "6"] },
  { name: "loop-window bad format", args: ["loop-window", "9to18"] },
  { name: "loop-window start>=end", args: ["loop-window", "18-9"] },
  { name: "loop-window start out of range", args: ["loop-window", "25-26"] },
  { name: "loop-schedule offset out of range", args: ["loop-schedule", "30/99"] },
  { name: "dream-time bad format", args: ["dream-time", "0320"] },
  { name: "dream-time hour out of range", args: ["dream-time", "25:00"] },
];

/** Frozen oracle outputs captured while tests were green. */
function frozen(c: Case): { status: number; stdout: string; stderr: string; fileContent: string | null } {
  switch (c.name) {
    case "flat global write":
      return { status: 0, stdout: "[roll] ✓ set loop_dream_hour = 5 in <HOME>/.roll/config.yaml\n", stderr: "", fileContent: "loop_dream_hour: 5\n" };
    case "nested project write (default scope)":
      return { status: 0, stdout: "[roll] ✓ set loop_schedule.period_minutes = 30 in .roll/local.yaml\n", stderr: "", fileContent: "loop_schedule:\n  period_minutes: 30\n" };
    case "nested project write (explicit --project)":
      return { status: 0, stdout: "[roll] ✓ set loop_active_start = 9 in .roll/local.yaml\n", stderr: "", fileContent: "loop_schedule:\n  loop_active_start: 9\n" };
    case "loop-window facade":
      return { status: 0, stdout: "[roll] ✓ set loop-window = 9-18 in .roll/local.yaml\nnote: nothing reads this — a session drives delivery, so you choose when to run `roll loop go`\n说明:这个值没人读 —— 交付由会话驱动,什么时候跑 `roll loop go` 由你决定\n", stderr: "", fileContent: "loop_schedule:\n  loop_active_start: 9\n  loop_active_end: 18\n" };
    case "loop-schedule facade with offset":
      return { status: 0, stdout: "[roll] ✓ set loop-schedule = 45/7 in .roll/local.yaml\nnote: nothing reads this — there is no scheduler; run `roll loop go` when you want cycles\n说明:这个值没人读 —— 没有调度器;想跑 cycle 就跑 `roll loop go`\n", stderr: "", fileContent: "loop_schedule:\n  period_minutes: 45\n  offset_minute: 7\n" };
    case "loop-schedule facade no offset":
      return { status: 0, stdout: "[roll] ✓ set loop-schedule = 30 in .roll/local.yaml\nnote: nothing reads this — there is no scheduler; run `roll loop go` when you want cycles\n说明:这个值没人读 —— 没有调度器;想跑 cycle 就跑 `roll loop go`\n", stderr: "", fileContent: "loop_schedule:\n  period_minutes: 30\n" };
    case "dream-time facade":
      return { status: 0, stdout: "[roll] ✓ set dream-time = 03:20 in <HOME>/.roll/config.yaml\nnote: nothing reads this — run `roll dream run-once` when you want a scan\n说明:这个值没人读 —— 想扫就跑 `roll dream run-once`\n", stderr: "", fileContent: "loop_dream_hour: 3\nloop_dream_minute: 20\n" };
    case "loop-window read default":
      return { status: 0, stdout: "loop-window: 0-24 (from default)\n", stderr: "", fileContent: null };
    case "loop-schedule read default":
      return { status: 0, stdout: "loop-schedule: every 60min (offset :0) (from default)\n", stderr: "", fileContent: null };
    case "dream-time read default":
      return { status: 0, stdout: "dream-time: 03:00 (from default)\n", stderr: "", fileContent: null };
    case "above max":
      return { status: 2, stdout: "", stderr: "[roll] config: 'loop_dream_hour' must be <= 23 (got 99)\n[roll] config：'loop_dream_hour' 必须 <= 23（收到 99）\n", fileContent: null };
    case "non-integer":
      return { status: 2, stdout: "", stderr: "[roll] config: 'loop_dream_hour' expects an integer, got 'abc'\n[roll] config：'loop_dream_hour' 需要整数，收到 'abc'\n", fileContent: null };
    case "below min":
      return { status: 2, stdout: "", stderr: "[roll] config: 'loop_active_end' must be >= 1 (got 0)\n[roll] config：'loop_active_end' 必须 >= 1（收到 0）\n", fileContent: null };
    case "unknown key write":
      return { status: 2, stdout: "", stderr: "[roll] config: unknown key 'nope'\n[roll] config：未知 key 'nope'\n[roll] Try: roll config --list\n", fileContent: null };
    case "too many args":
      return { status: 2, stdout: "", stderr: "[roll] config: unexpected argument '6'\n[roll] config：多余参数 '6'\n", fileContent: null };
    case "loop-window bad format":
      return { status: 2, stdout: "", stderr: "[roll] config: loop-window expects <start>-<end>, got '9to18'\n[roll] config：loop-window 需要 <start>-<end> 格式，收到 '9to18'\n", fileContent: null };
    case "loop-window start>=end":
      return { status: 2, stdout: "", stderr: "[roll] config: loop-window start must be < end (got 18-9)\n[roll] config：loop-window 开始时间必须 < 结束时间（收到 18-9）\n", fileContent: null };
    case "loop-window start out of range":
      return { status: 2, stdout: "", stderr: "[roll] config: loop-window start must be in [0,24]\n[roll] config：loop-window 开始时间必须在 [0,24]\n", fileContent: null };
    case "loop-schedule offset out of range":
      return { status: 2, stdout: "", stderr: "[roll] config: loop-schedule offset must be in [0, period-1] (period 30)\n[roll] config：loop-schedule 偏移必须在 [0, period-1]（周期 30）\n", fileContent: null };
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
