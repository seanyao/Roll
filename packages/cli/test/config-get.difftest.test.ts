/**
 * Frozen-expectation test: TS `roll config` read surface.
 *
 * `configGetCommand` was proven byte-equal to the bash oracle `bin/roll config`
 * under diff-test (fixture project + global yaml). Per US-PORT-009c the oracle is
 * retired: the `bin/roll config` spawn is dropped and each case freezes the TS
 * `{status, stdout, stderr}` as an inline snapshot (zero engine spawn). Inputs
 * are fixed yaml content + fixed keys → values (help / list / resolved keys /
 * bilingual error) are deterministic; the global-config source annotation echoes
 * the absolute ROLL_HOME path, which is scrubbed to `<HOME>` so the frozen value
 * stays portable across machines (macOS `/var/folders` vs Linux CI `/tmp`).
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configGetCommand } from "../src/commands/config-get.js";
import { seedUpdateCheckCache } from "./helpers.js";

const dirs: string[] = [];
let home = "";
let proj = "";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "roll-cfg-home-"));
  proj = mkdtempSync(join(tmpdir(), "roll-cfg-proj-"));
  dirs.push(home, proj);
  mkdirSync(join(home, ".roll"), { recursive: true });
  seedUpdateCheckCache(join(home, ".roll"));
  writeFileSync(join(home, ".roll", "config.yaml"), "loop_dream_hour: 5   # comment\n");
  mkdirSync(join(proj, ".roll"), { recursive: true });
  writeFileSync(
    join(proj, ".roll", "local.yaml"),
    ["loop_schedule:", "  loop_active_start: 9", "  period_minutes: 30", ""].join("\n"),
  );
});

afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

function tsCfg(args: string[]): { status: number; stdout: string; stderr: string } {
  const save = { HOME: process.env["HOME"], ROLL_HOME: process.env["ROLL_HOME"], NO_COLOR: process.env["NO_COLOR"] };
  process.env["HOME"] = home;
  process.env["ROLL_HOME"] = join(home, ".roll");
  process.env["NO_COLOR"] = "1";
  const saveCwd = process.cwd();
  process.chdir(proj);
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
    status = configGetCommand(args);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.chdir(saveCwd);
    for (const [k, v] of Object.entries(save)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  // The global-config source annotation echoes the absolute ROLL_HOME path
  // (random tmp dir, `/var/folders` on macOS vs `/tmp` on Linux CI) → scrub it
  // to a placeholder so the frozen value stays portable.
  const scrub = (s: string): string => s.split(home).join("<HOME>");
  return { status, stdout: scrub(outChunks.join("")), stderr: scrub(errChunks.join("")) };
}

// Unrolled (inline snapshots are keyed by call site — a loop can't hold distinct
// per-case frozen values).
describe("frozen: roll config (read) render", () => {
  it("config --help", () => {
    expect(tsCfg(["--help"])).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "Usage: roll config <key>                 print current value + source
             roll config --list                list all config keys
             roll config <key> <value> [--global|--project]   set a value
                                                                        配置读写
      Read / list / set config keys without hand-editing yaml.
      Default write scope is --project (.roll/local.yaml); --global writes
      ~/.roll/config.yaml. Legacy dream-time keys are INACTIVE — reads, writes, and
      --list disclose that nothing reads them.
      读 / 列 / 写配置 key，免去手工编辑 yaml。默认写 --project
      （.roll/local.yaml）；--global 写 ~/.roll/config.yaml。历史 dream 时刻 key
      已**失效**：读、写、--list 都会说明没有任何东西读它们。

      Legacy inactive keys (range):
        loop_dream_hour                0-23    (inactive) stored hour, unread
        loop_dream_minute              0-59    (inactive) stored minute, unread

      Run "roll dream run-once" when you want a scan.

      Language (REFACTOR-049: roll lang → roll config lang):
        roll config lang                          show current language + source
        roll config lang zh                       set language to zh
        roll config lang en                       set language to en
        roll config lang --reset                  clear preference (follow locale)

      Examples:
        roll config integration_branch
        roll config --list
        roll config publish_mode local
      ",
      }
    `);
  });
  it("config --list", () => {
    expect(tsCfg(["--list"])).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "  loop_dream_hour                = 5        (<HOME>/.roll/config.yaml)  [inactive]
        loop_dream_minute              = -        (default)  [inactive]
        integration_branch             = origin/main (default)
        publish_mode                   = remote   (default)
        default_submodule              =          (default)
      ",
      }
    `);
  });
  it("config loop_dream_hour (global flat, comment strip)", () => {
    expect(tsCfg(["loop_dream_hour"])).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "loop_dream_hour = 5  (from <HOME>/.roll/config.yaml)
      note: this key is inactive — nothing reads it
      ",
      }
    `);
  });
  it("config loop_dream_minute (global flat, '-' default)", () => {
    expect(tsCfg(["loop_dream_minute"])).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "loop_dream_minute = -  (from default)
      note: this key is inactive — nothing reads it
      ",
      }
    `);
  });
  it("config integration_branch (project flat string, origin/main default)", () => {
    expect(tsCfg(["integration_branch"])).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "integration_branch = origin/main  (from default)
      ",
      }
    `);
  });
  it("config no_such_key (unknown → bilingual stderr + exit 2)", () => {
    expect(tsCfg(["no_such_key"])).toMatchInlineSnapshot(`
      {
        "status": 2,
        "stderr": "[roll] config: unknown key 'no_such_key'
      [roll] config：未知 key 'no_such_key'
      [roll] Try: roll config --list
      ",
        "stdout": "",
      }
    `);
  });
});
