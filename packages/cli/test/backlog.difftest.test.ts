/**
 * Frozen-expectation test: TS `roll backlog` display.
 *
 * `backlogCommand` was proven byte-equal to the bash/python oracle `bin/roll
 * backlog` under diff-test (fixture backlogs over every group, reasons, CJK
 * truncation, error paths). Per US-PORT-009c the oracle is retired: the
 * `bin/roll backlog` spawn is dropped and each case freezes the TS
 * `{status, stdout, stderr}` as an inline snapshot (zero engine spawn). Fixture
 * backlog content is fixed strings → the rendered table (incl. CJK truncation)
 * and clear/empty messages are deterministic and path-free. The missing-file
 * error scrubs the random fixture path so the frozen value stays portable.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { backlogCommand } from "../src/commands/backlog.js";
import { seedUpdateCheckCache } from "./helpers.js";

const ROLL_HOME = join(mkdtempSync(join(tmpdir(), "roll-bl-home-")), ".roll");
seedUpdateCheckCache(ROLL_HOME);
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

function mkProj(backlogContent: string | null): string {
  const proj = mkdtempSync(join(tmpdir(), "roll-bl-proj-"));
  dirs.push(proj);
  if (backlogContent !== null) {
    mkdirSync(join(proj, "backlog"), { recursive: true });
    writeFileSync(join(proj, "backlog", "index.md"), backlogContent);
  }
  return proj;
}

function tsBacklog(proj: string): { status: number; stdout: string; stderr: string } {
  const save = { NO_COLOR: process.env["NO_COLOR"], ROLL_LANG: process.env["ROLL_LANG"] };
  process.env["NO_COLOR"] = "1";
  process.env["ROLL_LANG"] = "en";
  const saveCwd = process.cwd();
  process.chdir(proj);
  const outC: string[] = [];
  const errC: string[] = [];
  const rOut = process.stdout.write.bind(process.stdout);
  const rErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (x: string | Uint8Array): boolean => (outC.push(String(x)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (x: string | Uint8Array): boolean => (errC.push(String(x)), true);
  let status: number;
  try {
    status = backlogCommand([], {
      resolveTarget: () => ({
        ok: true,
        workspaceId: "ws-test",
        workspaceRoot: proj,
        canonicalRoot: realpathSync(proj),
        backlogPath: join(proj, "backlog", "index.md"),
        storyRoot: join(proj, "backlog"),
        runtimeRoot: join(proj, "runtime"),
        configPath: join(proj, "runtime", "backlog-sync.yaml"),
      }),
    });
  } finally {
    process.stdout.write = rOut;
    process.stderr.write = rErr;
    process.chdir(saveCwd);
    for (const [k, v] of Object.entries(save)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return {
    status,
    stdout: outC.join("").split(realpathSync(proj)).join("<WS>"),
    stderr: errC.join("").split(realpathSync(proj)).join("<WS>"),
  };
}

const RICH = `# Project Backlog

| Story | Description | Status |
|-------|-------------|--------|
| [FIX-001](.roll/x.md#a) | 修一个非常非常长的问题描述用来触发宽度截断逻辑——中日韩字符每个占两格所以这行一定会超过六十二格宽 | 📋 Todo |
| [US-100](.roll/x.md#b) | port roll status with bytes aligned | 📋 Todo |
| US-101 | bare id without link still parses | 📋 Todo |
| [REFACTOR-7](.roll/x.md#c) | tidy the renderer | 📋 Todo |
| [IDEA-3](.roll/x.md#d) | someday maybe | 📋 Todo |
| [US-200](.roll/x.md#e) | currently being built | 🔨 In Progress |
| [FIX-002](.roll/x.md#f) | waiting on upstream | 🔒 Blocked [needs api key] |
| [US-300](.roll/x.md#g) | parked for v3 | ⏸ Deferred [v2-freeze→v2-final] |
| [US-400](.roll/x.md#i) | parked pending owner ruling | 🚫 Hold (part 1 landed) |
| [DONE-1](.roll/x.md#h) | not an item type we list | ✅ Done |
`;

describe("frozen: roll backlog render", () => {
  it("rich backlog (all groups, reasons, CJK truncation)", () => {
    expect(tsBacklog(mkProj(RICH))).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "Backlog ws-test (<WS>)

        BACKLOG  ·  待处理任务                                                          6 Pending · 3 Hold

        ⏵ US-200  currently being built

        Bug Fixes  ·  缺陷修复  (1)
          FIX-001           修一个非常非常长的问题描述用来触发宽度截断逻辑——中日韩字符每…

        User Stories  ·  用户故事  (2)
          US-100            port roll status with bytes aligned
          US-101            bare id without link still parses

        Refactors  ·  重构  (1)
          REFACTOR-7        tidy the renderer

        Ideas  ·  创意  (1)
          IDEA-3            someday maybe

        Hold  ·  已阻塞  (3)
        🚫 FIX-002           waiting on upstream  (needs api key)
        🚫 US-300            parked for v3  (v2-freeze→v2-final)
        🚫 US-400            parked pending owner ruling

        triage: roll backlog block/defer/unblock <pattern> [reason]

      ",
      }
    `);
  });

  // REFACTOR-047 first regression case: the v2 renderer keyed on "Blocked" and
  // was BLIND to the 🚫 Hold marker the data actually uses, so the real backlog's
  // held cards silently vanished and only the Todo row showed. This pins the exact
  // reported scenario — Todo counted as Pending, every 🚫 Hold row surfaced.
  it("🚫 Hold rows surface (not silently dropped like the v2 renderer)", () => {
    const HOLD = `| Story | Description | Status |
| [FIX-9](a) | a pending fix | 📋 Todo |
| [US-PORT-016](b) | port slides to TS | 🚫 Hold (claude 直做并行) |
| [US-PORT-021](c) | retire bash engine | 🚫 Hold (待 owner 放行) |
`;
    expect(tsBacklog(mkProj(HOLD))).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "Backlog ws-test (<WS>)

        BACKLOG  ·  待处理任务                                                          1 Pending · 2 Hold

        Bug Fixes  ·  缺陷修复  (1)
          FIX-9             a pending fix

        Hold  ·  已阻塞  (2)
        🚫 US-PORT-016       port slides to TS
        🚫 US-PORT-021       retire bash engine

        triage: roll backlog block/defer/unblock <pattern> [reason]

      ",
      }
    `);
  });

  it("empty backlog → clear message", () => {
    expect(tsBacklog(mkProj("# Project Backlog\n\nno table rows here\n"))).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "Backlog ws-test (<WS>)

        BACKLOG  ·  待处理任务                                                                   0 Pending

        ✓ Nothing pending — backlog is clear  暂无待处理任务

        triage: roll backlog block/defer/unblock <pattern> [reason]

      ",
      }
    `);
  });

  it("only done items → clear message too", () => {
    expect(tsBacklog(mkProj("| [US-1](a) | done thing | ✅ Done |\n"))).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "Backlog ws-test (<WS>)

        BACKLOG  ·  待处理任务                                                                   0 Pending

        ✓ Nothing pending — backlog is clear  暂无待处理任务

        triage: roll backlog block/defer/unblock <pattern> [reason]

      ",
      }
    `);
  });

  it("missing backlog file → bilingual err + exit 1", () => {
    const proj = mkProj(null);
    const t = tsBacklog(proj);
    // stderr may embed the random fixture path → scrub to keep the frozen value
    // portable; status + the bilingual message shape are the contract.
    const stderr = t.stderr.split(proj).join("<PROJ>");
    expect({ status: t.status, stderr }).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "backlog: target_missing — Provide one registered Workspace ID or path
      ",
      }
    `);
  });
});
