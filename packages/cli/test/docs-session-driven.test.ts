/**
 * US-LOOP-120 — the docs describe a session-driven loop, and only that.
 *
 * Resident scheduling is gone from the product. The risk this guards is DRIFT: a
 * doc that still teaches `roll loop on`, or promises work "hourly" / "at 3am" /
 * "while you sleep", sends a reader to a command that errors and sells autonomy
 * that does not exist. A guide that lies is worse than a missing guide.
 *
 * Two rules, both asserted over every doc surface:
 *   1. No retired command appears as something to run.
 *   2. No copy promises unattended progress.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");

/** Every doc surface an owner reads: guides, docs, README, and the site. */
function docFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // absent tree (e.g. a slim checkout) is not a failure
    }
    for (const name of names) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(md|html|js)$/.test(name)) out.push(p);
    }
  };
  walk(join(ROOT, "guide"));
  walk(join(ROOT, "docs"));
  walk(join(ROOT, "site"));
  const readme = join(ROOT, "README.md");
  try {
    if (statSync(readme).isFile()) out.push(readme);
  } catch {
    /* no README */
  }
  return out;
}

/**
 * `roll loop <verb>` forms that no longer dispatch. Written as a regex over the
 * command SHAPE rather than the bare word, so prose like "on the loop" or a
 * `--cards` flag never false-positives.
 */
const RETIRED_COMMAND = /roll loop (on|off|now|fallback|test|test-quality-check)\b/;

/**
 * Copy that promises progress with nobody driving. Each of these shipped in the
 * guides or slides at some point and had to be rewritten.
 */
const UNATTENDED_CLAIM = [
  /never sleeps/i,
  /永不休眠/,
  /\bhourly\b/i,
  /每小时(扫描|执行)/,
  /runs? (automatically )?at 3am/i,
  /凌晨 ?3 ?点(触发|运行)/,
  /while you sleep/i,
  // codex r1: the first version was too narrow and let a whole slide deck plus
  // guide/en/ai-agents.md through. These are the other shapes the same promise
  // takes — a cadence, a clock, or a mode Roll no longer has.
  /\bnightly\b/i,
  /每晚|夜间(扫描|巡检|运行)/,
  /24\/7|24×7|24x7/,
  /(on|has) its own schedule/i,
  /next morning/i,
  /第二天早上|次日早上/,
  /hour by hour/i,
  /\bovernight\b/i,
  /通宵|整夜/,
  /runs? forever/i,
  /永远运行|一直跑下去/,
  // The guided/autonomous binary is gone; a doc that still offers it as a MODE
  // describes a choice the owner cannot make.
  /\bautonomous mode\b/i,
  /\bguided mode\b/i,
  /autonomous 模式|guided 模式/,
  // The same promise in marketing register — "you can walk away". Found in four
  // slide decks after the cadence sweep, so it is worth pinning by name.
  /babysitting/i,
  /无须看守|无人看守/,
  /runs? unattended|run it unattended/i,
  // NOT a bare /无人值守/: two legitimate uses exist — a lease in the managed
  // browser channel, and the adversarial engine's "must never hang when nobody is
  // watching THIS TURN". Both are about a turn with no human reading it, not about
  // a scheduler. Match only the marketing shape: "runs/works unattended".
  /无人值守(地)?(跑|运行|执行|交付)/,
  /executes? autonomously/i,
  // codex r4/r5: the OPPOSITE error — overstating the boundary. `go` detaches a
  // tmux worker, so "close the session and progress stops" is false, and a budget
  // gate no longer exists. Both shipped in my own first draft.
  /close the session and progress stops/i,
  /关掉会话[,，]?\s*推进就停/,
  /when it ends, progress stops/i,
  /budget (runs out|in force)/i,
  /预算(用尽|生效)/,
];

describe("US-LOOP-120 — docs teach only the session-driven loop", () => {
  it("no doc teaches a retired roll loop subcommand", () => {
    const offenders: string[] = [];
    for (const f of docFiles()) {
      const text = readFileSync(f, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        if (RETIRED_COMMAND.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1}`);
      }
    }
    expect(offenders, `retired commands still documented at: ${offenders.join(", ")}`).toEqual([]);
  });

  /**
   * `nightly` is also a LIVE enum value — the outward-smoke `environment` field is
   * typed `"ci" | "nightly" | "release"` (evaluation-contract.ts) and names which
   * external environment a smoke declaration targets. Documenting that literal is
   * correct; renaming it would desync the docs from the parser. So exempt lines
   * that are clearly citing the enum rather than promising a cadence.
   */
  const ENUM_CITATION = /environment|ci \| nightly \| release|ROLL_SMOKE_ENV|(Release|发版) ?\/ ?nightly/;

  it("no doc promises progress without a session driving", () => {
    const offenders: string[] = [];
    for (const f of docFiles()) {
      const text = readFileSync(f, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        if (ENUM_CITATION.test(line)) continue;
        for (const claim of UNATTENDED_CLAIM) {
          if (claim.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1} — ${claim.source}`);
        }
      }
    }
    expect(offenders, `unattended-autonomy copy at: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the capability boundary is stated where a reader will meet it", () => {
    // Not just "no lies" — the honest limit has to be SAID. A reader who only
    // sees `roll loop go` could still assume it keeps going after they close the
    // terminal, so the loop guide and the overview must say otherwise.
    const loopEn = readFileSync(join(ROOT, "guide/en/loop.md"), "utf8");
    expect(loopEn).toMatch(/nothing runs on a timer/i);
    // codex r4 caught my banner OVERSTATING this: `go` detaches a tmux worker, so a
    // run does outlive the terminal. The honest pair of claims is "no work between
    // runs" and "no run you did not start" — plus naming what actually ends a run.
    expect(loopEn).toMatch(/no work between runs/i);
    expect(loopEn).toMatch(/no run you did not start/i);
    expect(loopEn).toMatch(/detached tmux/i);
    expect(loopEn).not.toMatch(/when it ends, progress stops/i);

    // codex r5: the earlier wording here ("nothing advances while no session is
    // driving") was the same overstatement as the banner — a detached run keeps
    // going after your window closes. The accurate pair is between-runs quiet plus
    // no-unstarted-runs.
    const overviewEn = readFileSync(join(ROOT, "guide/en/overview.md"), "utf8");
    expect(overviewEn).toMatch(/nothing advances between runs/i);
    expect(overviewEn).toMatch(/no run starts that you did not start/i);

    const overviewZh = readFileSync(join(ROOT, "guide/zh/overview.md"), "utf8");
    expect(overviewZh).toContain("两次运行之间不会有任何推进");
  });

  it("the one-time launchd cleanup guide is present and actionable", () => {
    // A machine upgraded across this change still carries plists. The guide must
    // give the real commands, not just say "clean them up".
    const en = readFileSync(join(ROOT, "guide/en/loop.md"), "utf8");
    expect(en).toContain("launchctl bootout");
    expect(en).toContain("rm -f ~/Library/LaunchAgents/");
    // `;` not `&&`: bootout exits non-zero for an unloaded lane, and `&&` would
    // then leave the plist behind — the exact debris being removed.
    expect(en).toMatch(/launchctl bootout[^\n]*;\s*rm -f/);
    const zh = readFileSync(join(ROOT, "guide/zh/loop.md"), "utf8");
    expect(zh).toContain("launchctl bootout");
  });

  it("the CHANGELOG records this as a breaking change with the replacement", () => {
    const log = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const unreleased = log.slice(log.indexOf("## Unreleased"), log.indexOf("## v4."));
    expect(unreleased).toContain("破坏性变更");
    // Names what disappeared AND what to do instead — a breaking note without a
    // replacement just strands the reader.
    expect(unreleased).toContain("roll loop on");
    expect(unreleased).toContain("roll loop go");
    // And states the boundary plainly.
    expect(unreleased).toContain("不开会话,就什么都不会发生");
  });
});
