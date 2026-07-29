/**
 * US-PORT-021 prerequisite — the last `roll loop` cycle-gate subcommands ported
 * off bin/roll. Injected git/gh/notify/now seams keep them toolchain-free.
 */
import type { CiRunRow } from "@roll/core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EnforceTcrDeps,
  type HotfixDeps,
  type NotifyDeps,
  type PrecheckDeps,
  loopAgentRoutesCommand,
  loopEnforceTcrCommand,
  loopHotfixHeadContextCommand,
  loopNotifyCommand,
  loopPrecheckCiCommand,
  loopTestQualityCheckRetired,
  loopUnknownSubcommand,
  revertStoryDone,
  stateGet,
  stateUpsert,
} from "../src/commands/loop-cycle-gates.js";
import { stripAnsi } from "../src/render.js";

let cwd0: string;
let dir: string;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}
beforeEach(() => {
  cwd0 = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "loop-gates-"));
  process.chdir(dir);
  mkdirSync(join(".roll", "loop"), { recursive: true });
  setEnv("ROLL_MAIN_SLUG", "g-aaa111");
  setEnv("ROLL_LANG", "en");
  setEnv("NO_COLOR", "1");
  delete process.env["ROLL_LOOP_NO_HEAL"];
  delete process.env["ROLL_LOOP_HEAL_MAX"];
});
afterEach(() => {
  process.chdir(cwd0);
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

function capture(fn: () => number): { status: number; out: string; err: string } {
  const o: string[] = [];
  const e: string[] = [];
  const wo = process.stdout.write.bind(process.stdout);
  const we = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((x: string | Uint8Array) => (o.push(String(x)), true)) as typeof process.stdout.write;
  process.stderr.write = ((x: string | Uint8Array) => (e.push(String(x)), true)) as typeof process.stderr.write;
  try {
    const status = fn();
    return { status, out: stripAnsi(o.join("")), err: stripAnsi(e.join("")) };
  } finally {
    process.stdout.write = wo;
    process.stderr.write = we;
  }
}
const alert = (): string => readFileSync(join(".roll", "loop", "ALERT-g-aaa111.md"), "utf8");
const stateBody = (): string => readFileSync(join(".roll", "loop", "state-g-aaa111.yaml"), "utf8");

describe("pure helpers", () => {
  it("stateGet / stateUpsert flat key:value", () => {
    expect(stateGet("a: 1\nb: 2\n", "b")).toBe("2");
    expect(stateGet("a: 1\n", "z")).toBe("");
    expect(stateUpsert("a: 1\nb: 2\n", "b", 9)).toBe("a: 1\nb: 9\n");
    expect(stateUpsert("a: 1\n", "c", 3)).toBe("a: 1\nc: 3\n");
  });
  it("revertStoryDone flips only the matching row's Done→Todo", () => {
    const c = "| [US-1](x) | a | ✅ Done |\n| [US-2](x) | b | ✅ Done |\n";
    const out = revertStoryDone(c, "US-1");
    expect(out).toContain("| [US-1](x) | a | 📋 Todo |");
    expect(out).toContain("| [US-2](x) | b | ✅ Done |");
  });

  it("FIX-1475: reverts only the EXACT id-cell — a `<id>-` descendant and a row that merely LINKS to [id] are untouched", () => {
    const c = [
      "| [FIX-300-legacy](x) | descendant | ✅ Done |",
      "| [US-9](x) | supersedes [FIX-300](x) in its description | ✅ Done |",
      "| [FIX-300](x) | the real card | ✅ Done |",
      "",
    ].join("\n");
    const out = revertStoryDone(c, "FIX-300");
    // Only the exact FIX-300 row flips …
    expect(out).toContain("| [FIX-300](x) | the real card | 📋 Todo |");
    // … the descendant and the row that only links to [FIX-300] stay Done.
    expect(out).toContain("| [FIX-300-legacy](x) | descendant | ✅ Done |");
    expect(out).toContain("| [US-9](x) | supersedes [FIX-300](x) in its description | ✅ Done |");
  });
});

describe("loop notify", () => {
  function deps(over: Partial<NotifyDeps> = {}): { deps: NotifyDeps; sent: string[] } {
    const sent: string[] = [];
    return {
      sent,
      deps: {
        platform: () => "darwin",
        muted: () => false,
        osascript: (t, b) => sent.push(`${t}|${b}`),
        ...over,
      },
    };
  }
  it("sends on darwin when unmuted", () => {
    const { deps: d, sent } = deps();
    expect(loopNotifyCommand(["T", "B"], d)).toBe(0);
    expect(sent).toEqual(["T|B"]);
  });
  it("no-op when muted", () => {
    const { deps: d, sent } = deps({ muted: () => true });
    loopNotifyCommand(["T", "B"], d);
    expect(sent).toHaveLength(0);
  });
  it("no-op off darwin", () => {
    const { deps: d, sent } = deps({ platform: () => "linux" });
    loopNotifyCommand(["T", "B"], d);
    expect(sent).toHaveLength(0);
  });
});

describe("loop enforce-tcr", () => {
  const base: EnforceTcrDeps = {
    tcrCount: () => 0,
    notify: () => {},
    now: () => new Date("2026-06-09T12:00:00Z"),
  };
  it("no started_at → lenient pass, exit 0", () => {
    expect(capture(() => loopEnforceTcrCommand(["US-1"], base)).status).toBe(0);
  });
  it("tcr commits present → pass, exit 0, no ALERT", () => {
    const r = capture(() => loopEnforceTcrCommand(["US-1", "2026-06-09T10:00:00Z"], { ...base, tcrCount: () => 3 }));
    expect(r.status).toBe(0);
    expect(existsSync(join(".roll", "loop", "ALERT-g-aaa111.md"))).toBe(false);
  });
  it("zero tcr → revert Done→Todo + ALERT + notify, exit 1", () => {
    writeFileSync(join(".roll", "backlog.md"), "| [US-1](x) | a | ✅ Done |\n");
    const sent: string[] = [];
    const r = capture(() =>
      loopEnforceTcrCommand(["US-1", "2026-06-09T10:00:00Z"], { ...base, notify: (t) => sent.push(t) }),
    );
    expect(r.status).toBe(1);
    expect(readFileSync(join(".roll", "backlog.md"), "utf8")).toContain("| 📋 Todo |");
    expect(alert()).toContain("TCR check failed");
    expect(sent[0]).toContain("TCR Failed");
  });
});

describe("loop precheck-ci", () => {
  const green: CiRunRow[] = [{ status: "completed", conclusion: "success" }];
  const red: CiRunRow[] = [{ status: "completed", conclusion: "failure" }];
  const base: PrecheckDeps = {
    repoSlug: () => "acme/widgets",
    headCommit: () => "abcdef1234567890",
    runList: () => green,
    notify: () => {},
    now: () => new Date("2026-06-09T12:00:00Z"),
  };
  it("no slug → exit 0", () => {
    expect(capture(() => loopPrecheckCiCommand([], { ...base, repoSlug: () => undefined })).status).toBe(0);
  });
  it("green runs → exit 0", () => {
    expect(capture(() => loopPrecheckCiCommand([], base)).status).toBe(0);
  });
  it("red + heal available → exit 2, increments heal counter", () => {
    const r = capture(() => loopPrecheckCiCommand([], { ...base, runList: () => red }));
    expect(r.status).toBe(2);
    expect(stateBody()).toContain("heal_count_head_abcdef12: 1");
  });
  it("red + budget exhausted → exit 1, ALERT + notify", () => {
    setEnv("ROLL_LOOP_HEAL_MAX", "0"); // heal disabled
    const sent: string[] = [];
    const r = capture(() => loopPrecheckCiCommand([], { ...base, runList: () => red, notify: (t) => sent.push(t) }));
    expect(r.status).toBe(1);
    expect(alert()).toContain("Pre-run CI check failed");
    expect(alert()).toContain("failure");
    expect(sent[0]).toContain("CI red");
  });
});

describe("loop hotfix-head-context", () => {
  const base: HotfixDeps = {
    headCommit: () => "abcdef1234567890",
    repoSlug: () => "acme/widgets",
    gitLines: (a) => `git ${a.join(" ")} output`,
    failedRunLog: () => "FAILED LOG LINE",
    writeOut: (p, c) => writeFileSync(p, c),
  };
  it("writes the context file and prints its path", () => {
    const r = capture(() => loopHotfixHeadContextCommand([], base));
    expect(r.status).toBe(0);
    const path = r.out.trim();
    expect(path).toContain("roll-heal-head-abcdef12.log");
    const body = readFileSync(path, "utf8");
    expect(body).toContain("CI Hot-fix Context: HEAD abcdef12");
    expect(body).toContain("FAILED LOG LINE");
    rmSync(path, { force: true });
  });
  it("no commit → exit 1", () => {
    expect(capture(() => loopHotfixHeadContextCommand([], { ...base, headCommit: () => undefined })).status).toBe(1);
  });
});

describe("loop agent-routes (deprecated) + retired/unknown", () => {
  it("agent-routes path prints agents.yaml path, exit 0", () => {
    const r = capture(() => loopAgentRoutesCommand(["path"]));
    expect(r.status).toBe(0);
    expect(r.out).toContain(".roll/agents.yaml");
    expect(r.err).toContain("deprecated");
  });
  it("agent-routes lint is a deprecated no-op, exit 0", () => {
    expect(capture(() => loopAgentRoutesCommand(["lint"])).status).toBe(0);
  });
  it("agent-routes unknown sub → usage, exit 1", () => {
    expect(capture(() => loopAgentRoutesCommand(["bogus"])).status).toBe(1);
  });
  it("test-quality-check is retired, exit 0", () => {
    const r = capture(() => loopTestQualityCheckRetired());
    expect(r.status).toBe(0);
    expect(r.out).toContain("retired");
  });
  it("unknown loop subcommand → usage on stderr, exit 1", () => {
    const r = capture(() => loopUnknownSubcommand("frobnicate"));
    expect(r.status).toBe(1);
    expect(r.err).toContain("unknown loop subcommand: frobnicate");
  });
  it("bare/help → usage, exit 0", () => {
    expect(capture(() => loopUnknownSubcommand(undefined)).status).toBe(0);
    expect(capture(() => loopUnknownSubcommand("--help")).status).toBe(0);
  });
});
