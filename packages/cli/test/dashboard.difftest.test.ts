/**
 * Frozen-expectation test: TS `roll loop status` (US-PORT-009e).
 *
 * Previously diff-tested against python lib/roll-loop-status.py; the oracle is
 * now retired. Fixture render (deterministic) + live render in a fabricated
 * runtime dir freeze their TS stdout as inline snapshots. The title-row timestamp
 * (minute-resolution) is scrubbed to `<NOW>` so the snapshot stays stable across
 * runs. Zero engine spawn.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dashboardCommand } from "../src/commands/dashboard.js";
import { renderState } from "../src/render.js";

const REPO = resolve(__dirname, "../../..");
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

/** Run the TS dashboard in-process with env/cwd, capturing stdout.
 *  Scrubs the real-time title timestamp so snapshots are stable. */
function tsRun(env: Record<string, string | undefined>, argv: string[], cwd?: string): string {
  const saveEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saveEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const saveCwd = process.cwd();
  if (cwd !== undefined) process.chdir(cwd);
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // @ts-expect-error — capture-only override
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    dashboardCommand(argv);
  } finally {
    process.stdout.write = realWrite;
    renderState.useColor = true; // reset module state for the next case
    process.chdir(saveCwd);
    for (const [k, v] of Object.entries(saveEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  // Scrub the title-row timestamp: "YYYY-MM-DD HH:MM" (minute-resolution).
  return chunks.join("").replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, "<NOW>");
}

/** Pinned clocks (ROLL_RENDER_NOW) so snapshots never drift with wall time/TZ.
 *  Fixture: 2026-06-06 21:00 UTC = 05:00 UTC+8 on 06-07 — the fixture generates
 *  UTC-day cycles whose last one (20:48 UTC) is 04:48 next +8 day, so an
 *  early-morning +8 pin keeps every generated cycle in the past.
 *  Live: the synthetic events' own base instant. */
const FIXTURE_NOW = "2026-06-06T21:00:00Z";
const LIVE_NOW = "2026-06-07T03:18:30Z";

/** A sandbox that neutralizes all host-dependent eyebrow probes. */
function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "roll-dash-home-"));
  const rt = mkdtempSync(join(tmpdir(), "roll-dash-rt-"));
  const shared = mkdtempSync(join(tmpdir(), "roll-dash-shared-"));
  const notes = mkdtempSync(join(tmpdir(), "roll-dash-notes-"));
  dirs.push(home, rt, shared, notes);
  return {
    HOME: home,
    ROLL_PROJECT_RUNTIME_DIR: rt,
    ROLL_SHARED_ROOT: shared,
    ROLL_NOTES_DIR: notes,
    ROLL_FEATURES_DIR: join(notes, "features-empty"),
    ROLL_MAIN_SLUG: "test-abc123",
    _LAUNCHD_DIR: join(home, "la"),
    ...extra,
  };
}

function installLaunchctlShim(env: Record<string, string>): void {
  const bin = mkdtempSync(join(tmpdir(), "roll-dash-bin-"));
  dirs.push(bin);
  writeFileSync(join(bin, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
}

function writeLoopPlist(env: Record<string, string>, body: string): void {
  const la = env["_LAUNCHD_DIR"] as string;
  const slug = env["ROLL_MAIN_SLUG"] as string;
  mkdirSync(la, { recursive: true });
  writeFileSync(
    join(la, `com.roll.loop.${slug}.plist`),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '<key>Label</key>',
      `<string>com.roll.loop.${slug}</string>`,
      '<key>WorkingDirectory</key>',
      '<string>/tmp/roll-test</string>',
      body,
      '</dict>',
      '</plist>',
      '',
    ].join("\n"),
  );
}

/** Pad a number to 2 digits. */
const p2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
/** ISO UTC string with +00:00 suffix (matches the writer format). */
function iso(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}+00:00`
  );
}
/** Cycle label YYYYMMDD-HHMMSS-PID in UTC. */
function label(d: Date): string {
  return (
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-` +
    `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}-99999`
  );
}

describe("frozen: roll loop status (fixture)", () => {
  it("fixture --no-color", () => {
    const env = sandboxEnv({ ROLL_RENDER_FIXTURE: "1", ROLL_RENDER_NOW: FIXTURE_NOW });
    const ts = tsRun(env, ["--no-color"], REPO);
    expect(ts).toMatchInlineSnapshot(`
      "roll loop  ·  health                                              <NOW> · 12 cycles / 72h

      ◆ session-driven   run roll loop go in this session  last ✓ 04:48  FIX-040  8/12 tests failed → bail
        会话驱动 · 在本会话运行 roll loop go

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        ROLLUP  ·  近 3 天                                             ↑ today vs yesterday · 今日 vs 昨日

                      Today                 Yesterday −2d     
                      今日                  昨日      前天    
        cycles               1  ▼ −3        4         4       
        merged PRs           0  —           0         0       
        failed               0  —           0         1       
        duration           17m  ▼ −31m      48m       48m     
        input tokens         —  —           —         —       
        cache writes         —  —           —         —       
        cache reads          —  —           —         —       
        output tokens        —  —           —         —       
        cost             $0.00  —           $0.00     $0.00   

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        RECENT  ·  最近 12 个 cycle     t · time   Δ · duration   tok · tokens   $/¥ · cost   id · backlog

        ─ Today · 今日 · 2026-06-07 · Sun · 周日 ────────────────────  1 cycles · 0 failed  ·  in progress
        ✓  04:48    17m  —/—                         —                 —   FIX-040 #61 …

        ─ Yesterday · 昨日 · 2026-06-06 · Sat · 周六 ────────────────────────────────  4 cycles · 0 failed
        ✓  08:48     9m  —/—                         —                 —   FIX-048 #57 …
        ✓  13:48    11m  —/—                         —                 —   US-112 #58 …
        ✓  18:48    13m  —/—                         —                 —   FIX-047 #59 …
        ✓  23:48    15m  —/—                         —                 —   REFACT-9 #60 …

        ─ −2 days · 前 2 天 · 2026-06-05 · Fri · 周五 ───────────────────────────────  4 cycles · 1 failed
        ✓  08:48     9m  —/—                         —                 —   FIX-048 #53 …
        ✓  13:48    11m  —/—                         —                 —   US-112 #54 …
        ✗  18:48    13m  —/—                         —                 —   FIX-047
        ✓  23:48    15m  —/—                         —                 —   REFACT-9 #56 …

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        drill   roll loop runs --detail <cycle>       watch   tmux attach -t roll-loop-<slug>       more   roll loop status --days 7
      "
    `);
  });

  it("fixture --no-color --en", () => {
    const env = sandboxEnv({ ROLL_RENDER_FIXTURE: "1", ROLL_RENDER_NOW: FIXTURE_NOW });
    const ts = tsRun(env, ["--no-color", "--en"], REPO);
    expect(ts).toMatchInlineSnapshot(`
      "roll loop  ·  health                                              <NOW> · 12 cycles / 72h

      ◆ session-driven   run roll loop go in this session  last ✓ 04:48  FIX-040  8/12 tests failed → bail

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        ROLLUP  ·  近 3 天                                             ↑ today vs yesterday · 今日 vs 昨日

                      Today                 Yesterday −2d     
        cycles               1  ▼ −3        4         4       
        merged PRs           0  —           0         0       
        failed               0  —           0         1       
        duration           17m  ▼ −31m      48m       48m     
        input tokens         —  —           —         —       
        cache writes         —  —           —         —       
        cache reads          —  —           —         —       
        output tokens        —  —           —         —       
        cost             $0.00  —           $0.00     $0.00   

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        RECENT  ·  最近 12 个 cycle     t · time   Δ · duration   tok · tokens   $/¥ · cost   id · backlog

        ─ Today · 今日 · 2026-06-07 · Sun · 周日 ────────────────────  1 cycles · 0 failed  ·  in progress
        ✓  04:48    17m  —/—                         —                 —   FIX-040 #61 …

        ─ Yesterday · 昨日 · 2026-06-06 · Sat · 周六 ────────────────────────────────  4 cycles · 0 failed
        ✓  08:48     9m  —/—                         —                 —   FIX-048 #57 …
        ✓  13:48    11m  —/—                         —                 —   US-112 #58 …
        ✓  18:48    13m  —/—                         —                 —   FIX-047 #59 …
        ✓  23:48    15m  —/—                         —                 —   REFACT-9 #60 …

        ─ −2 days · 前 2 天 · 2026-06-05 · Fri · 周五 ───────────────────────────────  4 cycles · 1 failed
        ✓  08:48     9m  —/—                         —                 —   FIX-048 #53 …
        ✓  13:48    11m  —/—                         —                 —   US-112 #54 …
        ✗  18:48    13m  —/—                         —                 —   FIX-047
        ✓  23:48    15m  —/—                         —                 —   REFACT-9 #56 …

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        drill   roll loop runs --detail <cycle>       watch   tmux attach -t roll-loop-<slug>       more   roll loop status --days 7
      "
    `);
  });

  it("fixture --no-color --zh", () => {
    const env = sandboxEnv({ ROLL_RENDER_FIXTURE: "1", ROLL_RENDER_NOW: FIXTURE_NOW });
    const ts = tsRun(env, ["--no-color", "--zh"], REPO);
    expect(ts).toMatchInlineSnapshot(`
      "roll loop  ·  health                                              <NOW> · 12 cycles / 72h

      ◆ session-driven   run roll loop go in this session  last ✓ 04:48  FIX-040  8/12 tests failed → bail
        会话驱动 · 在本会话运行 roll loop go

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        ROLLUP  ·  近 3 天                                             ↑ today vs yesterday · 今日 vs 昨日

                      今日                  昨日      前天    
        cycles               1  ▼ −3        4         4       
        merged PRs           0  —           0         0       
        failed               0  —           0         1       
        duration           17m  ▼ −31m      48m       48m     
        input tokens         —  —           —         —       
        cache writes         —  —           —         —       
        cache reads          —  —           —         —       
        output tokens        —  —           —         —       
        cost             $0.00  —           $0.00     $0.00   

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        RECENT  ·  最近 12 个 cycle     t · time   Δ · duration   tok · tokens   $/¥ · cost   id · backlog

        ─ Today · 今日 · 2026-06-07 · Sun · 周日 ────────────────────  1 cycles · 0 failed  ·  in progress
        ✓  04:48    17m  —/—                         —                 —   FIX-040 #61 …

        ─ Yesterday · 昨日 · 2026-06-06 · Sat · 周六 ────────────────────────────────  4 cycles · 0 failed
        ✓  08:48     9m  —/—                         —                 —   FIX-048 #57 …
        ✓  13:48    11m  —/—                         —                 —   US-112 #58 …
        ✓  18:48    13m  —/—                         —                 —   FIX-047 #59 …
        ✓  23:48    15m  —/—                         —                 —   REFACT-9 #60 …

        ─ −2 days · 前 2 天 · 2026-06-05 · Fri · 周五 ───────────────────────────────  4 cycles · 1 failed
        ✓  08:48     9m  —/—                         —                 —   FIX-048 #53 …
        ✓  13:48    11m  —/—                         —                 —   US-112 #54 …
        ✗  18:48    13m  —/—                         —                 —   FIX-047
        ✓  23:48    15m  —/—                         —                 —   REFACT-9 #56 …

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        drill   roll loop runs --detail <cycle>       watch   tmux attach -t roll-loop-<slug>       more   roll loop status --days 7
      "
    `);
  });

  it("fixture --no-color --days 7", () => {
    const env = sandboxEnv({ ROLL_RENDER_FIXTURE: "1", ROLL_RENDER_NOW: FIXTURE_NOW });
    const ts = tsRun(env, ["--no-color", "--days", "7"], REPO);
    expect(ts).toMatchInlineSnapshot(`
      "roll loop  ·  health                                             <NOW> · 12 cycles / 168h

      ◆ session-driven   run roll loop go in this session  last ✓ 04:48  FIX-040  8/12 tests failed → bail
        会话驱动 · 在本会话运行 roll loop go

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        ROLLUP  ·  近 7 天                                             ↑ today vs yesterday · 今日 vs 昨日

                      Today                 Yesterday −2d     
                      今日                  昨日      前天    
        cycles               1  ▼ −3        4         4       
        merged PRs           0  —           0         0       
        failed               0  —           0         1       
        duration           17m  ▼ −31m      48m       48m     
        input tokens         —  —           —         —       
        cache writes         —  —           —         —       
        cache reads          —  —           —         —       
        output tokens        —  —           —         —       
        cost             $0.00  —           $0.00     $0.00   

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        RECENT  ·  最近 12 个 cycle     t · time   Δ · duration   tok · tokens   $/¥ · cost   id · backlog

        ─ Today · 今日 · 2026-06-07 · Sun · 周日 ────────────────────  1 cycles · 0 failed  ·  in progress
        ✓  04:48    17m  —/—                         —                 —   FIX-040 #61 …

        ─ Yesterday · 昨日 · 2026-06-06 · Sat · 周六 ────────────────────────────────  4 cycles · 0 failed
        ✓  08:48     9m  —/—                         —                 —   FIX-048 #57 …
        ✓  13:48    11m  —/—                         —                 —   US-112 #58 …
        ✓  18:48    13m  —/—                         —                 —   FIX-047 #59 …
        ✓  23:48    15m  —/—                         —                 —   REFACT-9 #60 …

        ─ −2 days · 前 2 天 · 2026-06-05 · Fri · 周五 ───────────────────────────────  4 cycles · 1 failed
        ✓  08:48     9m  —/—                         —                 —   FIX-048 #53 …
        ✓  13:48    11m  —/—                         —                 —   US-112 #54 …
        ✗  18:48    13m  —/—                         —                 —   FIX-047
        ✓  23:48    15m  —/—                         —                 —   REFACT-9 #56 …

        ─ −3 days · 前 3 天 · 2026-06-04 · Thu · 周四 ───────────────────────────────  3 cycles · 0 failed
        ✓  08:48     9m  —/—                         —                 —   FIX-048 #50 …
        ✓  13:48    11m  —/—                         —                 —   US-112 #51 …
        ✓  18:48    13m  —/—                         —                 —   FIX-047 #52 …

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        drill   roll loop runs --detail <cycle>       watch   tmux attach -t roll-loop-<slug>       more   roll loop status --days 7
      "
    `);
  });

  it("--eval fixture view", () => {
    const env = sandboxEnv({ ROLL_RENDER_FIXTURE: "1", ROLL_RENDER_NOW: FIXTURE_NOW });
    const ts = tsRun(env, ["--eval", "--no-color"], REPO);
    expect(ts).toMatchInlineSnapshot(`
      "Loop result-eval — last 14 cycles
      循环结果评分 — 最近 14 轮

      no scored cycles yet (need result_eval in runs.jsonl)
      尚无评分 cycle（runs.jsonl 需含 result_eval）
      "
    `);
  });

  it("--eval 5 (numeric arg, fixture)", () => {
    const env = sandboxEnv({ ROLL_RENDER_FIXTURE: "1", ROLL_RENDER_NOW: FIXTURE_NOW });
    const ts = tsRun(env, ["--eval", "5", "--no-color"], REPO);
    expect(ts).toMatchInlineSnapshot(`
      "Loop result-eval — last 5 cycles
      循环结果评分 — 最近 5 轮

      no scored cycles yet (need result_eval in runs.jsonl)
      尚无评分 cycle（runs.jsonl 需含 result_eval）
      "
    `);
  });

  it("unknown flag errors with exit 2", () => {
    const env = sandboxEnv({ ROLL_RENDER_FIXTURE: "1", ROLL_RENDER_NOW: FIXTURE_NOW });
    const realErr = process.stderr.write.bind(process.stderr);
    let tsErr = "";
    // @ts-expect-error — capture-only override
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      tsErr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    };
    let tsCode: number;
    try {
      tsCode = dashboardCommand(["--bogus"]);
    } finally {
      process.stderr.write = realErr;
    }
    expect({ status: tsCode, stderr: tsErr }).toMatchInlineSnapshot(`
      {
        "status": 2,
        "stderr": "usage: roll-loop-status.py [-h] [--days DAYS] [--no-color] [--en] [--zh]
                                 [--eval [N]]
      roll-loop-status.py: error: unrecognized arguments: --bogus
      ",
      }
    `);
  });
});

describe("frozen: roll loop status (live)", () => {
  /**
   * US-LOOP-118 — what FIX-254 was defending is now structurally impossible.
   *
   * FIX-254 stopped `roll loop status` from INVENTING a next-run time: with an
   * interval plist it estimated from the latest real launchd fire, and on a
   * calendar/fire mismatch it printed "?" rather than a made-up clock time. Both
   * behaviours are gone because the thing they described is gone — no lane fires,
   * so there is no next run to estimate correctly or incorrectly.
   *
   * These two cases replace them: whatever a leftover plist says, the banner must
   * never print a next run, and must say a session drives instead.
   */
  it("US-LOOP-118: an interval plist yields NO next-run promise", () => {
    const env = sandboxEnv({ ROLL_RENDER_NOW: "2026-06-07T03:00:00Z" });
    installLaunchctlShim(env);
    writeLoopPlist(env, ["<key>StartInterval</key>", "<integer>1800</integer>"].join("\n"));
    writeFileSync(
      join(env["ROLL_PROJECT_RUNTIME_DIR"] as string, "cron.log"),
      "[2026-06-07T10:52:00+0800] cycle start (v3 run-once)\n",
    );
    const proj = mkdtempSync(join(tmpdir(), "roll-dash-proj-l118-interval-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });

    const ts = tsRun(env, ["--no-color"], proj);
    expect(ts).not.toContain("next run");
    expect(ts).not.toContain("enabled");
    // A 30-minute StartInterval used to make this read "in 22m 00s".
    expect(ts).not.toMatch(/in \d+m/);
    expect(ts).toContain("session-driven");
    // The plist is still on disk, so it is named as debris to remove.
    expect(ts).toContain("leftover plist");
  });

  /**
   * US-LOOP-118 (codex r2) — one tripwire for the whole class.
   *
   * Two separate prediction sites shipped in this file's history: the loop banner
   * ("next run 14:30 · in 12m") and a dream line one row below it ("dream: 03:00
   * (next fire in 5h 12m)"). I removed the first and codex found the second. So
   * assert the PROPERTY rather than each site: with plists for every retired lane
   * present, roll loop status must not name a future time at all.
   */
  it("US-LOOP-118: no lane's plist can produce a future-time promise anywhere", () => {
    const env = sandboxEnv({ ROLL_RENDER_NOW: "2026-06-07T03:00:00Z" });
    installLaunchctlShim(env);
    writeLoopPlist(env, ["<key>StartInterval</key>", "<integer>1800</integer>"].join("\n"));
    // A dream plist with a calendar entry — the shape that produced "next fire in".
    const la = env["_LAUNCHD_DIR"] as string;
    writeFileSync(
      join(la, `com.roll.dream.${env["ROLL_MAIN_SLUG"] as string}.plist`),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<plist version=\"1.0\"><dict>",
        "<key>StartCalendarInterval</key>",
        "<dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>",
        "</dict></plist>",
        "",
      ].join("\n"),
    );
    const proj = mkdtempSync(join(tmpdir(), "roll-dash-proj-l118-nofire-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });

    const ts = tsRun(env, ["--no-color"], proj);
    expect(ts).not.toContain("next fire");
    expect(ts).not.toContain("next run");
    // No "in 5h 12m" / "in 22m 00s" style countdown from any lane.
    expect(ts).not.toMatch(/in \d+h \d+m/);
    expect(ts).not.toMatch(/in \d+m \d+s/);
    // And the dream plist is not silently ignored: it is debris to remove.
    expect(ts).toContain("session-driven");
    expect(ts).toContain("leftover plist");
  });

  /**
   * codex r3: the tripwire above always writes a LOOP plist, which masked a real
   * gap — the leftover check only looked at the loop lane, and the dream line that
   * used to mention a dream plist was deleted in this same card. So a dream-only
   * leftover would have been silent everywhere. Test each lane ALONE.
   */
  it("US-LOOP-118: a dream-only leftover is reported, with no loop plist present", () => {
    const env = sandboxEnv({ ROLL_RENDER_NOW: "2026-06-07T03:00:00Z" });
    installLaunchctlShim(env);
    const la = env["_LAUNCHD_DIR"] as string;
    const slug = env["ROLL_MAIN_SLUG"] as string;
    // writeLoopPlist() normally creates this dir; these cases skip it on purpose.
    mkdirSync(la, { recursive: true });
    writeFileSync(
      join(la, `com.roll.dream.${slug}.plist`),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict></dict></plist>\n',
    );
    // Deliberately NO loop plist — that is the case the old predicate missed.
    expect(existsSync(join(la, `com.roll.loop.${slug}.plist`))).toBe(false);
    const proj = mkdtempSync(join(tmpdir(), "roll-dash-proj-l118-dreamonly-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });

    const ts = tsRun(env, ["--no-color"], proj);
    expect(ts).toContain("leftover plist");
    expect(ts).not.toContain("next fire");
  });

  it("US-LOOP-118: a pr-only leftover is reported too (retired by US-DELIV-006)", () => {
    const env = sandboxEnv({ ROLL_RENDER_NOW: "2026-06-07T03:00:00Z" });
    installLaunchctlShim(env);
    const la = env["_LAUNCHD_DIR"] as string;
    mkdirSync(la, { recursive: true });
    writeFileSync(
      join(la, `com.roll.pr.${env["ROLL_MAIN_SLUG"] as string}.plist`),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict></dict></plist>\n',
    );
    const proj = mkdtempSync(join(tmpdir(), "roll-dash-proj-l118-pronly-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });

    expect(tsRun(env, ["--no-color"], proj)).toContain("leftover plist");
  });

  /**
   * codex r7 — debris is a fact about the MACHINE, not about this cycle.
   *
   * The leftover note was nested inside the idle/session-driven branch, so a real
   * plist stayed hidden while a cycle was RUNNING or the project was PAUSED — the
   * two states an owner is most likely to be staring at.
   */
  it("US-LOOP-118: a leftover lane is reported even while PAUSED", () => {
    const env = sandboxEnv({ ROLL_RENDER_NOW: "2026-06-07T03:00:00Z" });
    installLaunchctlShim(env);
    const la = env["_LAUNCHD_DIR"] as string;
    mkdirSync(la, { recursive: true });
    writeFileSync(join(la, `com.roll.loop.${env["ROLL_MAIN_SLUG"] as string}.plist`), "<plist/>\n");
    const proj = mkdtempSync(join(tmpdir(), "roll-dash-proj-l118-paused-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });
    // Pause the project so the idle branch — which used to OWN the leftover note —
    // is skipped. The marker is resolved under the PROJECT path (resolveLoopRunState),
    // not the runtime dir.
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    writeFileSync(join(proj, ".roll", "loop", `PAUSE-${env["ROLL_MAIN_SLUG"] as string}`), "paused by owner\n");

    // resolveProjectPath needs ROLL_MAIN_PROJECT for the marker to be found.
    const ts = tsRun({ ...env, ROLL_MAIN_PROJECT: proj }, ["--no-color"], proj);
    expect(ts).toContain("leftover plist");
    // And the pause is still reported — the note is additive, not a replacement.
    expect(ts.toLowerCase()).toContain("paused");
  });

  it("US-LOOP-118: a clean machine says nothing about leftovers", () => {
    const env = sandboxEnv({ ROLL_RENDER_NOW: "2026-06-07T03:00:00Z" });
    installLaunchctlShim(env);
    const proj = mkdtempSync(join(tmpdir(), "roll-dash-proj-l118-clean-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });

    const ts = tsRun(env, ["--no-color"], proj);
    expect(ts).toContain("session-driven");
    expect(ts).not.toContain("leftover plist");
  });

  it("US-LOOP-118: a calendar plist yields NO next-run promise either", () => {
    const env = sandboxEnv({ ROLL_RENDER_NOW: "2026-06-07T03:00:00Z" });
    installLaunchctlShim(env);
    writeLoopPlist(
      env,
      [
        "<key>StartCalendarInterval</key>",
        "<array>",
        "<dict><key>Minute</key><integer>22</integer></dict>",
        "<dict><key>Minute</key><integer>52</integer></dict>",
        "</array>",
      ].join("\n"),
    );
    writeFileSync(
      join(env["ROLL_PROJECT_RUNTIME_DIR"] as string, "cron.log"),
      "[2026-06-07T10:07:00+0800] cycle start (v3 run-once)\n",
    );
    const proj = mkdtempSync(join(tmpdir(), "roll-dash-proj-l118-calendar-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });

    const ts = tsRun(env, ["--no-color"], proj);
    // Not even the honest "?" survives: there is no next-run field at all.
    expect(ts).not.toContain("next run");
    expect(ts).toContain("session-driven");
    expect(ts).toContain("leftover plist");
  });

  it("synthetic events + runs render", () => {
    const env = sandboxEnv({ ROLL_RENDER_NOW: LIVE_NOW });
    const rt = env["ROLL_PROJECT_RUNTIME_DIR"] as string;
    const slug = env["ROLL_MAIN_SLUG"] as string;

    const base = new Date(LIVE_NOW);
    const start1 = new Date(base.getTime() - 30 * 60 * 1000);
    const end1 = new Date(start1.getTime() + 600 * 1000);
    const start2 = new Date(base.getTime() - 90 * 60 * 1000);
    const end2 = new Date(start2.getTime() + 480 * 1000);
    const lab1 = label(start1);
    const lab2 = label(start2);

    const usage = {
      model: "claude-opus-4-7-20251001",
      input_tokens: 12000,
      output_tokens: 3400,
      cache_creation_tokens: 50000,
      cache_read_tokens: 800000,
      cost_list_usd: 1.23,
      cost_currency: "USD",
      duration_ms: 600000,
    };
    const events = [
      { ts: iso(start1), stage: "cycle_start", label: lab1, detail: "", outcome: "" },
      { ts: iso(start1), stage: "pick_todo", label: lab1, detail: "US-CLI-006 picked", outcome: "ok" },
      { ts: iso(end1), stage: "usage", label: lab1, detail: usage, outcome: "ok" },
      {
        ts: iso(end1),
        stage: "pr",
        label: lab1,
        detail: "https://github.com/x/y/pull/777",
        outcome: "merged",
      },
      { ts: iso(end1), stage: "cycle_end", label: lab1, detail: "", outcome: "done" },
      { ts: iso(start2), stage: "cycle_start", label: lab2, detail: "", outcome: "" },
      { ts: iso(start2), stage: "pick_todo", label: lab2, detail: "FIX-200 picked", outcome: "ok" },
      { ts: iso(end2), stage: "test", label: lab2, detail: "3/9 tests failed", outcome: "fail" },
      { ts: iso(end2), stage: "cycle_end", label: lab2, detail: "", outcome: "fail" },
    ];
    writeFileSync(
      join(rt, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const runs = [
      {
        project: slug,
        run_id: "r1",
        ts: iso(new Date(end1.getTime() + 5000)),
        tcr_count: 2,
        built: ["US-CLI-006"],
        status: "built",
        agent: "claude",
        duration_sec: 600,
        result_eval: { version: 1, score: 8, dims: { outcome: 1.0, correctness: 1.0, quality: 0.0 } },
      },
      {
        project: slug,
        run_id: "r2",
        ts: iso(new Date(end2.getTime() + 5000)),
        tcr_count: 0,
        built: [],
        status: "interrupted",
        agent: "pi",
        result_eval: { version: 1, score: 5, dims: { outcome: 0.0, scope_fidelity: 1.0 } },
      },
    ];
    writeFileSync(join(rt, "runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const proj = mkdtempSync(join(tmpdir(), "roll-dash-proj-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "backlog.md"),
      [
        "| ID | Description | Status |",
        "|----|----|----|",
        "| US-CLI-006 | Port loop-status dashboard to TS | Done |",
        "| FIX-200 | Some bugfix description | Todo |",
        "",
      ].join("\n"),
    );

    const ts = tsRun(env, ["--no-color"], proj);
    expect(ts).toMatchInlineSnapshot(`
      "roll loop  ·  health                                               <NOW> · 2 cycles / 72h

      ◆ session-driven   run roll loop go in this session                       last ✓ 10:48  US-CLI-006${"  "}
        会话驱动 · 在本会话运行 roll loop go

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        ROLLUP  ·  近 3 天                                             ↑ today vs yesterday · 今日 vs 昨日

                      Today                 Yesterday −2d     
                      今日                  昨日      前天    
        cycles               2  ▲ new       0         0       
        merged PRs           1  ▲ new       0         0       
        failed               1  ▲ new       0         0       
        duration           18m  ▲ new       0m        0m      
        input tokens       12K  ▲ new       —         —       
        cache writes       50K  ▲ new       —         —       
        cache reads       800K  ▲ new       —         —       
        output tokens     3.4K  ▲ new       —         —       
        cost             $1.23  ▲ new       $0.00     $0.00   
        agents: pi 0/1 (n/a) · claude 1/1 (n/a)
        result-eval: (n/a) — 2 sample(s), need 3 (last 14)

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        RECENT  ·  最近 2 个 cycle      t · time   Δ · duration   tok · tokens   $/¥ · cost   id · backlog

        ─ Today · 今日 · 2026-06-07 · Sun · 周日 ────────────────────────────────────  2 cycles · 1 failed
        ✗  09:48     8m  —/—                         —                 —   FIX-200
              → roll loop runs --detail 20260607-014830-99999
        ✓  10:48    10m  12K/50K↑ 800K↓/3.4K         opus-4-7      $1.23   US-CLI-006 #777 ✓

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        drill   roll loop runs --detail <cycle>       watch   tmux attach -t roll-loop-<slug>       more   roll loop status --days 7
      "
    `);
  });

  it("paused state + CNY cost + populated eval/review-score render", () => {
    const env = sandboxEnv({ ROLL_RENDER_NOW: LIVE_NOW });
    const rt = env["ROLL_PROJECT_RUNTIME_DIR"] as string;
    const slug = env["ROLL_MAIN_SLUG"] as string;

    writeFileSync(
      join(rt, "state.yaml"),
      ['status: "paused"', 'paused_at: "2026-06-04T10:00:00Z"', 'paused_reason: "manual hold"', ""].join("\n"),
    );

    const base = new Date(LIVE_NOW);
    const start1 = new Date(base.getTime() - 40 * 60 * 1000);
    const end1 = new Date(start1.getTime() + 420 * 1000);
    const lab1 = label(start1);

    const usage = {
      model: "deepseek-v4-pro",
      input_tokens: 9000,
      output_tokens: 2000,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cost_list_usd: 0.42,
      cost_currency: "CNY",
      duration_ms: 420000,
    };
    const events = [
      { ts: iso(start1), stage: "cycle_start", label: lab1, detail: "", outcome: "" },
      { ts: iso(start1), stage: "pick_todo", label: lab1, detail: "FIX-300 picked", outcome: "ok" },
      { ts: iso(end1), stage: "agent_used", label: lab1, detail: "pi", outcome: "ok" },
      { ts: iso(end1), stage: "usage", label: lab1, detail: usage, outcome: "ok" },
      { ts: iso(end1), stage: "cycle_end", label: lab1, detail: "", outcome: "done" },
    ];
    writeFileSync(join(rt, "events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const runs = [0, 1, 2, 3].map((k) => ({
      project: slug,
      run_id: `e${k}`,
      ts: iso(new Date(end1.getTime() - (3 - k) * 1000)),
      tcr_count: 1,
      built: ["FIX-300"],
      status: "built",
      agent: "pi",
      result_eval: {
        version: 1,
        score: 6 + k,
        dims: { outcome: k % 2, correctness: 1.0, scope_fidelity: 1.0, quality: 0.0, efficiency: "unknown" },
      },
    }));
    writeFileSync(join(rt, "runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const proj = mkdtempSync(join(tmpdir(), "roll-dash-proj2-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll", "notes"), { recursive: true });
    for (const [i, [s, v]] of [
      ["8", "ok"],
      ["5", "ok"],
      ["7", "regression"],
    ].entries()) {
      writeFileSync(join(proj, ".roll", "notes", `2026-06-0${i + 1}.md`), `score: ${s}\nverdict: ${v}\n`);
    }
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "backlog.md"),
      ["| FIX-300 | A CNY-billed bugfix | Done |", ""].join("\n"),
    );

    const ts = tsRun(env, ["--no-color"], proj);
    expect(ts).toMatchInlineSnapshot(`
      "roll loop  ·  health                                               <NOW> · 1 cycles / 72h

      ⏸ PAUSED   since 2026-06-04T10:00:00Z · manual hold       last ✓ 10:38  FIX-300  A CNY-billed bugfix
        已暂停 · run: roll loop resume

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        ROLLUP  ·  近 3 天                                             ↑ today vs yesterday · 今日 vs 昨日

                      Today                 Yesterday −2d     
                      今日                  昨日      前天    
        cycles               1  ▲ new       0         0       
        merged PRs           0  —           0         0       
        failed               0  —           0         0       
        duration            7m  ▲ new       0m        0m      
        input tokens        9K  ▲ new       —         —       
        cache writes         —  —           —         —       
        cache reads          —  —           —         —       
        output tokens       2K  ▲ new       —         —       
        cost             ¥0.42  ▲ new       ¥0.00     ¥0.00   
        agents: pi 1/1 (n/a)
        result-eval: mean 7.5↑ / min 6 / out 50% ci 100% scope 100% qual 0% (last 14)

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        RECENT  ·  最近 1 个 cycle      t · time   Δ · duration   tok · tokens   $/¥ · cost   id · backlog

        ─ Today · 今日 · 2026-06-07 · Sun · 周日 ────────────────────────────────────  1 cycles · 0 failed
        ✓  10:38     7m  9K/2K                       deepseek-v4-pro   ¥0.42   FIX-300

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        drill   roll loop runs --detail <cycle>       watch   tmux attach -t roll-loop-<slug>       more   roll loop status --days 7
      "
    `);
  });

  // US-LOOP-115: DORMANT is retired. This case asserted the dormant RENDER; it now
  // asserts the inverse — a leftover marker is inert and never renders a state.
  it("a leftover DORMANT marker renders nothing (US-LOOP-115)", () => {
    const proj = mkdtempSync(join(tmpdir(), "roll-dash-dorm-"));
    dirs.push(proj);
    const env = sandboxEnv({ ROLL_RENDER_NOW: LIVE_NOW, ROLL_MAIN_PROJECT: proj });
    const rt = env["ROLL_PROJECT_RUNTIME_DIR"] as string;
    const slug = env["ROLL_MAIN_SLUG"] as string;

    writeFileSync(join(rt, "state.yaml"), ['status: "idle"', ""].join("\n"));

    const loopDir = join(proj, ".roll", "loop");
    mkdirSync(loopDir, { recursive: true });
    const dormantBody = JSON.stringify({ since: "2026-06-25T04:00:00Z", reason: "idle for 6h — no Todo items" });
    writeFileSync(join(loopDir, `DORMANT-${slug}`), dormantBody + "\n");

    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "backlog.md"), "");

    const ts = tsRun(env, ["--no-color"], proj);
    expect(ts).not.toContain("DORMANT");
    expect(ts).not.toContain("休眠");
    // The marker's contents never reach the screen.
    expect(ts).not.toContain("2026-06-25T04:00:00Z");
    expect(ts).not.toContain("idle for 6h");
  });
});
