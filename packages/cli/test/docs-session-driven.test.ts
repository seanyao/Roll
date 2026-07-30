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
  // codex r8: the skills submodule is a doc surface too — an owner reads SKILL.md
  // as instructions. It carried the same session-ends-stops overclaim and this gate
  // never looked at it. Absent (a slim checkout without submodules) is not a failure;
  // `walk` already tolerates a missing tree.
  walk(join(ROOT, "skills"));
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
  // codex r6: this overclaim propagated into every file the delegated sweeps
  // touched, because the brief I gave them carried it. Match the shapes, not one
  // sentence.
  /close(ing)? (the|your) (session|window|terminal)[^.]{0,40}(stops|停)/i,
  /when (the|that) session ends[^.]{0,40}stops/i,
  /session ends, (work|progress|delivery) stops/i,
  /when it ends, progress stops/i,
  /(关掉|关闭|结束)(会话|窗口|终端)[^。]{0,20}(就停|停止|会停)/,
  /会话(一)?(关|结束)[,，]?\s*(推进|交付|工作)就停/,
  // codex r7: session-FIRST orderings, which the closing-first shapes above miss.
  /(session|window|terminal) (ends?|closes?)[^.]{0,60}(stops?|halts?|no (further )?progress)/i,
  // The `不再` alternative was too greedy: it fired on a CORRECT sentence
  // ("窗口关掉之后它仍在跑,你只是不再看着它"). Drop it — the stop/halt words below
  // carry the meaning, and a false positive on accurate text pushes the author
  // toward worse wording, which is the opposite of the point.
  /(会话|窗口|终端)(一旦|一)?(结束|关闭|关掉)[^。]{0,30}(就停|停下|没有(进展|推进))/,
  /no agent session means no progress/i,
  /没有 ?agent ?会话就没有(进展|推进)/,
  // codex r7 round two: four more phrasings the shapes above still missed —
  // "会话一关", "close the workshop", "advances only while ... session open",
  // and the bare "会话结束,推进就停". Each is the same overclaim in new clothes,
  // which is why this list matches shapes and keeps growing rather than being
  // replaced.
  /会话(一)?关[,，]?\s*(loop|推进|交付|工作)?\s*就停/,
  /close the workshop and the work waits/i,
  /关门[,，]?\s*活儿就在那儿等着/,
  /(advances|moves forward) only while[^.]{0,60}session (open|running)/i,
  /会话结束[,，]\s*推进就停/,
  // codex r9: three more — "only advances while you are sitting in front of it",
  // "只在你盯着它的时候前进", "只在 owner 开着 … 的期间前进".
  /(only )?advances only while|advances while you are sitting/i,
  /交付只在[^。]{0,40}(的时候|期间)(前进|推进)/,
  /没有会话就没有推进/,
  /budget (runs out|in force)/i,
  /预算(用尽|生效)/,
];

describe("US-LOOP-120 — docs teach only the session-driven loop", () => {
  it("no doc teaches a retired roll loop subcommand", () => {
    const offenders: string[] = [];
    for (const f of docFiles()) {
      const text = readFileSync(f, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        if (!RETIRED_COMMAND.test(line)) continue;
        // A changelog EXAMPLE quoting a past entry is history, not instruction —
        // the skills changelog contract shows one verbatim (codex r8).
        if (/^- \*\*(Fixed|Added|Changed|Removed)\*\*/.test(line.trim())) continue;
        offenders.push(`${relative(ROOT, f)}:${i + 1}`);
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

  /**
   * codex r7: scanning ONE LINE AT A TIME let every wrapped claim through — prose
   * wraps at ~80 columns, so "closing the session\nstops work" never matched. Scan a
   * flattened copy (newlines collapsed to spaces) and map the hit back to a line by
   * counting newlines before the match offset.
   */
  function flatten(text: string): { flat: string; lineOf: (offset: number) => number } {
    // Build the flattened text and a PER-CHARACTER line map together, so an offset
    // in `flat` maps back exactly. Deriving the map separately (my first attempt)
    // skewed every report by a few lines.
    let flat = "";
    const lineAt: number[] = [];
    let line = 1;
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\n") {
        // Collapse "<spaces>\n<spaces>" into a single space.
        line++;
        i++;
        while (i < text.length && /[ \t]/.test(text[i]!)) i++;
        if (flat.length > 0 && !flat.endsWith(" ")) {
          flat += " ";
          lineAt.push(line);
        }
        continue;
      }
      flat += ch;
      lineAt.push(line);
      i++;
    }
    return { flat, lineOf: (offset) => lineAt[Math.min(offset, lineAt.length - 1)] ?? 1 };
  }

  it("no doc promises progress without a session driving", () => {
    const offenders: string[] = [];
    for (const f of docFiles()) {
      const text = readFileSync(f, "utf8");
      const { flat, lineOf } = flatten(text);
      for (const claim of UNATTENDED_CLAIM) {
        for (const m of flat.matchAll(new RegExp(claim.source, `${claim.flags.replace("g", "")}g`))) {
          const at = m.index ?? 0;
          // Enum citations are exempt — check the surrounding window, not one line.
          if (ENUM_CITATION.test(flat.slice(Math.max(0, at - 120), at + 120))) continue;
          offenders.push(`${relative(ROOT, f)}:${lineOf(at)} — ${claim.source}`);
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

  /**
   * The CHANGELOG is deliberately NOT swept as a whole: released sections are
   * history, and a v3 entry that says a scan ran nightly is a true statement about
   * v3. Only the Unreleased section describes the product as it is now, so that is
   * the part held to the same rules as the guides (codex r8).
   */
  it("the Unreleased CHANGELOG section itself makes no retired claim", () => {
    const log = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const unreleased = log.slice(log.indexOf("## Unreleased"), log.indexOf("## v4."));
    for (const claim of UNATTENDED_CLAIM) {
      // A changelog MUST name what it is removing, so the retired command names are
      // expected here — only the behavioural overclaims are forbidden.
      if (/roll loop|autonomous 模式|guided 模式/.test(claim.source)) continue;
      expect(unreleased, `Unreleased section carries: ${claim.source}`).not.toMatch(claim);
    }
  });

  it("the CHANGELOG records this as a breaking change with the replacement", () => {
    const log = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const unreleased = log.slice(log.indexOf("## Unreleased"), log.indexOf("## v4."));
    expect(unreleased).toContain("破坏性变更");
    // Names what disappeared AND what to do instead — a breaking note without a
    // replacement just strands the reader.
    expect(unreleased).toContain("roll loop on");
    expect(unreleased).toContain("roll loop go");
    // And states the boundary plainly — checked by SUBSTANCE, not by one sentence,
    // so rewording the entry (e.g. into the repo's bullet convention) does not have
    // to chase this assertion.
    expect(unreleased).toMatch(/不会有你没启动过的运行/);
    expect(unreleased).toMatch(/两次运行之间/);
    // The detached-tmux reality must be stated too — omitting it is how the earlier
    // draft ended up overclaiming the boundary.
    expect(unreleased).toMatch(/detached tmux/);
  });
});
