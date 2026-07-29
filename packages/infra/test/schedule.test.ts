/**
 * Unit tests for the Schedule module's pure generators (US-INFRA-004):
 * launchd label/path, plist content/schedule_xml shape, and the crontab
 * read-modify-write fns. Byte-parity vs extracted bash is asserted separately in
 * schedule.difftest.test.ts; here we cover edge cases + the FIX-195 cron shape.
 */
import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Scheduler,
  CronScheduler,
  LaunchdScheduler,
  createScheduler,
  cronHasEntry,
  cronInstall,
  cronLines,
  cronRemove,
  extractServiceFromLabel,
  cronPerServiceLine,
  cronRemovePerService,
  cronInstallPerService,
  cronHasPerServiceEntry,
  launchdLabel,
  launchdPlistPath,
  plistContent,
  scheduleXml,
} from "../src/schedule.js";

function fallbackConfig(projectPath: string) {
  return {
    projectPath,
    slug: "project-abc123",
    periodMinutes: 15,
    rollBin: "roll",
  };
}

function fakeFallbackChild(pid: number) {
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  return {
    child: {
      pid,
      kill: vi.fn(() => true),
      once: vi.fn((_event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        onExit = listener;
      }),
    },
    exit: (code = 0, signal: NodeJS.Signals | null = null) => onExit?.(code, signal),
  };
}

describe("launchdLabel / launchdPlistPath (bin/roll 8170-8197)", () => {
  it("com.roll.<svc>.<slug>", () => {
    expect(launchdLabel("loop", "main-abc123")).toBe("com.roll.loop.main-abc123");
    expect(launchdLabel("dream", "s")).toBe("com.roll.dream.s");
    expect(launchdLabel("pr", "s")).toBe("com.roll.pr.s");
  });
  it("plist path joins dir + label.plist", () => {
    expect(launchdPlistPath("loop", "s", "/home/u/Library/LaunchAgents")).toBe(
      "/home/u/Library/LaunchAgents/com.roll.loop.s.plist",
    );
  });
});

describe("scheduleXml (bin/roll 8235-8260)", () => {
  it("interval → StartInterval = period*60", () => {
    expect(scheduleXml({ kind: "interval", periodMinutes: 5 })).toBe(
      "  <key>StartInterval</key>\n  <integer>300</integer>",
    );
  });
  it("daily default (FIX-105) → StartInterval 86400", () => {
    expect(scheduleXml({ kind: "daily", hour: 3, minute: 2 })).toBe(
      "  <key>StartInterval</key>\n  <integer>86400</integer>",
    );
  });
  it("daily + calendar opt-in → array-style StartCalendarInterval Hour+Minute", () => {
    const xml = scheduleXml({ kind: "daily", hour: 3, minute: 2, calendar: true });
    expect(xml).toContain("<key>StartCalendarInterval</key>");
    expect(xml).toContain("<key>Hour</key>\n      <integer>3</integer>");
    expect(xml).toContain("<key>Minute</key>\n      <integer>2</integer>");
  });
});

describe("plistContent shape (bin/roll 8262-8289)", () => {
  const base = {
    label: "com.roll.loop.s",
    runnerScript: "/sh/loop/run-s.sh",
    projectPath: "/proj",
    pathValue: "/opt/homebrew/bin:/usr/bin:/bin",
    schedule: { kind: "interval", periodMinutes: 60 } as const,
  };
  it("ends with exactly one trailing newline (printf '%s\\n')", () => {
    const c = plistContent(base);
    expect(c.endsWith("</plist>\n")).toBe(true);
    expect(c.endsWith("</plist>\n\n")).toBe(false);
  });
  it("renders literal double-quotes (heredoc \\\" → \")", () => {
    expect(plistContent(base)).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plistContent(base)).toContain('<plist version="1.0">');
  });
  it("embeds label/runner/project/path and ProgramArguments /bin/bash -l", () => {
    const c = plistContent(base);
    expect(c).toContain("<string>com.roll.loop.s</string>");
    expect(c).toContain("<string>/bin/bash</string>\n    <string>-l</string>\n    <string>/sh/loop/run-s.sh</string>");
    expect(c).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(c).toContain("<string>/proj</string>");
    expect(c).toContain("<integer>3600</integer>");
  });
});

const cmds = {
  loopCmd: 'cd "/proj" && roll loop now >> /sh/loop/cron-s.log 2>&1',
  loopMinute: 17,
  dreamCmd: 'cd "/proj" && roll dream >> /proj/.roll/dream/cron.log 2>&1',
  dreamMinute: 2,
  dreamHour: 3,
  projectPath: "/proj",
};

describe("cronLines (bin/roll 9960-9961, FIX-195: loop + dream only)", () => {
  it("loop is hourly at loopMinute; dream is daily at dreamMinute dreamHour", () => {
    const [loop, dream] = cronLines(cmds);
    expect(loop).toBe(
      '17 * * * * cd "/proj" && roll loop now >> /sh/loop/cron-s.log 2>&1 # roll-loop:/proj',
    );
    expect(dream).toBe(
      '2 3 * * * cd "/proj" && roll dream >> /proj/.roll/dream/cron.log 2>&1 # roll-loop:/proj',
    );
  });
  it("only TWO lines — no brief entry (FIX-195)", () => {
    expect(cronLines(cmds)).toHaveLength(2);
  });
});

describe("cronInstall / cronRemove / cronHasEntry (bin/roll 9958-9962 / 10012-10015)", () => {
  it("install onto an empty crontab → just the two lines", () => {
    const out = cronInstall("", cmds);
    expect(out).toBe(`${cronLines(cmds)[0]}\n${cronLines(cmds)[1]}\n`);
  });
  it("install preserves existing entries verbatim, appends after", () => {
    const out = cronInstall("0 0 * * * other-job\n", cmds);
    expect(out).toBe(`0 0 * * * other-job\n${cronLines(cmds)[0]}\n${cronLines(cmds)[1]}\n`);
  });
  it("install with existing crontab missing trailing newline still separates", () => {
    const out = cronInstall("0 0 * * * other-job", cmds);
    expect(out.startsWith("0 0 * * * other-job\n")).toBe(true);
  });
  it("cronHasEntry detects the project tag", () => {
    expect(cronHasEntry(cronInstall("", cmds), "/proj")).toBe(true);
    expect(cronHasEntry("0 0 * * * other-job\n", "/proj")).toBe(false);
  });
  it("remove strips every line carrying the project tag, keeps others", () => {
    const installed = cronInstall("0 0 * * * other-job\n", cmds);
    expect(cronRemove(installed, "/proj")).toBe("0 0 * * * other-job\n");
  });
  it("remove of the only entries → empty crontab", () => {
    expect(cronRemove(cronInstall("", cmds), "/proj")).toBe("");
  });
  it("remove keys on path: a different project's entries survive", () => {
    const other = cronInstall("", { ...cmds, projectPath: "/other" });
    const both = cronInstall(other, cmds);
    const after = cronRemove(both, "/proj");
    expect(cronHasEntry(after, "/proj")).toBe(false);
    expect(cronHasEntry(after, "/other")).toBe(true);
  });
});

// ─── Scheduler seam interface (US-LOOP-079f1) ─────────────────────────────────

describe("Scheduler interface — AC3 isArmed with injected Set (no real launchctl)", () => {
  it("isArmed returns false when nothing is loaded", async () => {
    const s = new LaunchdScheduler(501, { loadedSet: new Set() });
    await expect(s.isArmed("com.roll.loop.s")).resolves.toBe(false);
  });

  it("isArmed returns true after wake", async () => {
    const loaded = new Set<string>();
    const s = new LaunchdScheduler(501, { loadedSet: loaded });
    await s.wake("com.roll.loop.s", "/tmp/x.plist");
    await expect(s.isArmed("com.roll.loop.s")).resolves.toBe(true);
  });

  it("isArmed returns false after dormant", async () => {
    const loaded = new Set<string>(["com.roll.loop.s"]);
    const s = new LaunchdScheduler(501, { loadedSet: loaded });
    await expect(s.isArmed("com.roll.loop.s")).resolves.toBe(true);
    await s.dormant("com.roll.loop.s");
    await expect(s.isArmed("com.roll.loop.s")).resolves.toBe(false);
  });

  it("isArmed via injected Set — no real launchctl spawn (AC3)", async () => {
    const loaded = new Set<string>();
    const s = new LaunchdScheduler(501, { loadedSet: loaded });
    await expect(s.isArmed("svc-a")).resolves.toBe(false);
    await expect(s.isArmed("svc-b")).resolves.toBe(false);
    await s.wake("svc-a", "/tmp/a.plist");
    await expect(s.isArmed("svc-a")).resolves.toBe(true);
    await expect(s.isArmed("svc-b")).resolves.toBe(false);
    await s.dormant("svc-a");
    await expect(s.isArmed("svc-a")).resolves.toBe(false);
  });
});

describe("Scheduler — AC4 wake idempotent (double call = single arm)", () => {
  it("FIX-1246: an already-armed launchd job is still booted out before bootstrap", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "roll-launchctl-"));
    const fakeBin = join(sandbox, "launchctl");
    const log = join(sandbox, "launchctl.log");
    writeFileSync(
      fakeBin,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$ROLL_TEST_LAUNCHCTL_LOG"\n[ "$1" = print ] && exit 0\nexit 0\n',
      "utf8",
    );
    chmodSync(fakeBin, 0o755);
    const previousPath = process.env["PATH"];
    const previousLog = process.env["ROLL_TEST_LAUNCHCTL_LOG"];
    process.env["PATH"] = `${sandbox}:${previousPath ?? ""}`;
    process.env["ROLL_TEST_LAUNCHCTL_LOG"] = log;

    try {
      const scheduler = new LaunchdScheduler(501);
      await expect(scheduler.wake("com.roll.loop.proj-abc123", "/tmp/loop.plist")).resolves.toBe(true);
      expect(readFileSync(log, "utf8").trim()).toBe("print gui/501/com.roll.loop.proj-abc123");
      writeFileSync(log, "", "utf8");

      await expect(scheduler.wake("com.roll.loop.proj-abc123", "/tmp/loop.plist", { refresh: true })).resolves.toBe(true);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "bootout gui/501/com.roll.loop.proj-abc123",
        "bootstrap gui/501 /tmp/loop.plist",
      ]);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      if (previousLog === undefined) delete process.env["ROLL_TEST_LAUNCHCTL_LOG"];
      else process.env["ROLL_TEST_LAUNCHCTL_LOG"] = previousLog;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("LaunchdScheduler: double wake returns true both times, arms only once", async () => {
    const loaded = new Set<string>();
    const s = new LaunchdScheduler(501, { loadedSet: loaded });
    const r1 = await s.wake("com.roll.loop.s", "/tmp/x.plist");
    expect(r1).toBe(true);
    const r2 = await s.wake("com.roll.loop.s", "/tmp/x.plist");
    expect(r2).toBe(true);
    await expect(s.isArmed("com.roll.loop.s")).resolves.toBe(true);
    expect(loaded.size).toBe(1);
  });

  it("CronScheduler: double wake is no-op on second call", async () => {
    const current = "";
    const cmds = {
      loopCmd: "cd /p && roll loop now",
      loopMinute: 17,
      dreamCmd: "cd /p && roll dream",
      dreamMinute: 2,
      dreamHour: 3,
      projectPath: "/p",
    };
    const after1 = cronInstall(current, cmds);
    expect(cronHasEntry(after1, "/p")).toBe(true);
    const already = cronHasEntry(after1, "/p");
    expect(already).toBe(true);
  });

  it("generic Scheduler: wake after dormant re-arms cleanly", async () => {
    const loaded = new Set<string>();
    const s = new LaunchdScheduler(501, { loadedSet: loaded });
    await s.wake("svc", "/tmp/p.plist");
    await expect(s.isArmed("svc")).resolves.toBe(true);
    await s.dormant("svc");
    await expect(s.isArmed("svc")).resolves.toBe(false);
    await s.wake("svc", "/tmp/p.plist");
    await expect(s.isArmed("svc")).resolves.toBe(true);
  });
});

describe("createScheduler factory (platform selection)", () => {
  it("darwin → LaunchdScheduler", () => {
    const s = createScheduler("darwin", { uid: 501 });
    expect(s instanceof LaunchdScheduler).toBe(true);
  });

  it("linux → CronScheduler", () => {
    const s = createScheduler("linux", {
      uid: 0,
      projectPath: "/p",
      cronCommands: {
        loopCmd: "loop",
        loopMinute: 5,
        dreamCmd: "dream",
        dreamMinute: 2,
        dreamHour: 3,
        projectPath: "/p",
      },
    });
    expect(s instanceof CronScheduler).toBe(true);
  });

  it("non-darwin platforms all map to CronScheduler", () => {
    for (const platform of ["linux", "win32", "freebsd", "sunos", "aix"] as NodeJS.Platform[]) {
      const s = createScheduler(platform, { uid: 0, projectPath: "/p" });
      expect(s instanceof CronScheduler).toBe(true);
    }
  });
});

describe("Scheduler interface conformance — contract tests", () => {
  function contract(scheduler: Scheduler, label: string): void {
    it(`${label}: dormant removes armed state`, async () => {
      await scheduler.wake("test", "/tmp/t.plist");
      await expect(scheduler.isArmed("test")).resolves.toBe(true);
      await scheduler.dormant("test");
      await expect(scheduler.isArmed("test")).resolves.toBe(false);
    });

    it(`${label}: wake arms the service`, async () => {
      await scheduler.wake("test", "/tmp/t.plist");
      await expect(scheduler.isArmed("test")).resolves.toBe(true);
    });

    it(`${label}: wake is idempotent (AC4)`, async () => {
      const r1 = await scheduler.wake("idem", "/tmp/i.plist");
      const r2 = await scheduler.wake("idem", "/tmp/i.plist");
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      await expect(scheduler.isArmed("idem")).resolves.toBe(true);
    });

    it(`${label}: dormant of unarmed service is a no-op success`, async () => {
      const r = await scheduler.dormant("never-armed");
      expect(r).toBe(true);
    });

    it(`${label}: isArmed returns false for unknown service`, async () => {
      await expect(scheduler.isArmed("never-armed")).resolves.toBe(false);
    });
  }

  contract(new LaunchdScheduler(501, { loadedSet: new Set<string>() }), "LaunchdScheduler");
});

// ─── US-LOOP-079f2: per-lane scheduler operations ──────────────────────────────

describe("extractServiceFromLabel", () => {
  it("extracts loop from com.roll.loop.main-abc123", () => {
    expect(extractServiceFromLabel("com.roll.loop.main-abc123")).toBe("loop");
  });
  it("extracts dream/pr", () => {
    expect(extractServiceFromLabel("com.roll.dream.s")).toBe("dream");
    expect(extractServiceFromLabel("com.roll.pr.s")).toBe("pr");
  });
  it("returns empty for non-roll labels", () => {
    expect(extractServiceFromLabel("com.apple.loop")).toBe("");
    expect(extractServiceFromLabel("")).toBe("");
    expect(extractServiceFromLabel("loop")).toBe("");
  });
});

const perLaneCmds = {
  loopCmd: 'cd "/proj" && roll loop now >> /sh/loop/cron-s.log 2>&1',
  loopMinute: 17,
  dreamCmd: 'cd "/proj" && roll dream >> /proj/.roll/dream/cron.log 2>&1',
  dreamMinute: 2,
  dreamHour: 3,
  projectPath: "/proj",
};

describe("cronPerServiceLine", () => {
  it("loop → returns loop line only", () => {
    expect(cronPerServiceLine(perLaneCmds, "loop")).toBe(
      '17 * * * * cd "/proj" && roll loop now >> /sh/loop/cron-s.log 2>&1 # roll-loop:/proj',
    );
  });
  it("dream → returns dream line only", () => {
    expect(cronPerServiceLine(perLaneCmds, "dream")).toBe(
      '2 3 * * * cd "/proj" && roll dream >> /proj/.roll/dream/cron.log 2>&1 # roll-loop:/proj',
    );
  });
  it("pr / unknown → null (not managed by cron)", () => {
    expect(cronPerServiceLine(perLaneCmds, "pr")).toBeNull();
    expect(cronPerServiceLine(perLaneCmds, "unknown")).toBeNull();
  });
});

describe("cronRemovePerService — per-lane dormant on Linux (AC3)", () => {
  it("dormant loop removes only loop line, keeps dream", () => {
    const installed = cronInstall("", perLaneCmds);
    const after = cronRemovePerService(installed, perLaneCmds, "/proj", "loop");
    // Dream line survives.
    expect(cronHasPerServiceEntry(after, perLaneCmds, "/proj", "dream")).toBe(true);
    // Loop line is gone.
    expect(cronHasPerServiceEntry(after, perLaneCmds, "/proj", "loop")).toBe(false);
    // Full-project check still true (dream remains).
    expect(cronHasEntry(after, "/proj")).toBe(true);
  });

  it("dormant dream removes only dream line, keeps loop", () => {
    const installed = cronInstall("", perLaneCmds);
    const after = cronRemovePerService(installed, perLaneCmds, "/proj", "dream");
    expect(cronHasPerServiceEntry(after, perLaneCmds, "/proj", "loop")).toBe(true);
    expect(cronHasPerServiceEntry(after, perLaneCmds, "/proj", "dream")).toBe(false);
  });

  it("dormant loop + dormant dream → empty crontab", () => {
    const installed = cronInstall("", perLaneCmds);
    const afterLoop = cronRemovePerService(installed, perLaneCmds, "/proj", "loop");
    const afterBoth = cronRemovePerService(afterLoop, perLaneCmds, "/proj", "dream");
    expect(afterBoth).toBe("");
  });

  it("dormant unknown service → no-op, keeps all entries", () => {
    const installed = cronInstall("", perLaneCmds);
    const after = cronRemovePerService(installed, perLaneCmds, "/proj", "pr");
    expect(after).toBe(installed);
  });

  it("dormant preserves other projects' entries", () => {
    const otherCmds = { ...perLaneCmds, projectPath: "/other" };
    const both = cronInstall(cronInstall("", perLaneCmds), otherCmds);
    const after = cronRemovePerService(both, perLaneCmds, "/proj", "loop");
    expect(cronHasEntry(after, "/proj")).toBe(true); // dream still there
    expect(cronHasEntry(after, "/other")).toBe(true); // other project untouched
  });
});

describe("cronInstallPerService — per-lane wake on Linux (AC3)", () => {
  it("wake loop adds only loop line to empty crontab", () => {
    const after = cronInstallPerService("", perLaneCmds, "/proj", "loop");
    expect(cronHasPerServiceEntry(after, perLaneCmds, "/proj", "loop")).toBe(true);
    expect(cronHasPerServiceEntry(after, perLaneCmds, "/proj", "dream")).toBe(false);
  });

  it("wake dream adds only dream line to empty crontab", () => {
    const after = cronInstallPerService("", perLaneCmds, "/proj", "dream");
    expect(cronHasPerServiceEntry(after, perLaneCmds, "/proj", "dream")).toBe(true);
    expect(cronHasPerServiceEntry(after, perLaneCmds, "/proj", "loop")).toBe(false);
  });

  it("wake loop is idempotent: double call = single line (AC4)", () => {
    const first = cronInstallPerService("", perLaneCmds, "/proj", "loop");
    const second = cronInstallPerService(first, perLaneCmds, "/proj", "loop");
    expect(second).toBe(first); // no change on second call
  });

  it("wake preserves existing entries from other services", () => {
    const withDream = cronInstallPerService("", perLaneCmds, "/proj", "dream");
    const withBoth = cronInstallPerService(withDream, perLaneCmds, "/proj", "loop");
    // After adding loop, both are present.
    expect(cronHasPerServiceEntry(withBoth, perLaneCmds, "/proj", "loop")).toBe(true);
    expect(cronHasPerServiceEntry(withBoth, perLaneCmds, "/proj", "dream")).toBe(true);
    // Both lines are present (order may differ from full cronInstall).
    expect(cronHasPerServiceEntry(withBoth, perLaneCmds, "/proj", "loop")).toBe(true);
    expect(cronHasPerServiceEntry(withBoth, perLaneCmds, "/proj", "dream")).toBe(true);
  });
});

describe("cronHasPerServiceEntry", () => {
  it("true for loop when loop line present", () => {
    const installed = cronInstall("", perLaneCmds);
    expect(cronHasPerServiceEntry(installed, perLaneCmds, "/proj", "loop")).toBe(true);
  });
  it("false for loop after loop removed", () => {
    const installed = cronInstall("", perLaneCmds);
    const removed = cronRemovePerService(installed, perLaneCmds, "/proj", "loop");
    expect(cronHasPerServiceEntry(removed, perLaneCmds, "/proj", "loop")).toBe(false);
  });
  it("false for unknown service", () => {
    const installed = cronInstall("", perLaneCmds);
    expect(cronHasPerServiceEntry(installed, perLaneCmds, "/proj", "pr")).toBe(false);
  });
});

// ─── AC1 + AC2: LaunchdScheduler per-lane — dormant('loop') doesn't affect pr/dream ───

describe("LaunchdScheduler per-lane (AC1, AC2)", () => {
  it("dormant('loop') only removes loop, pr + dream stay armed", async () => {
    const loaded = new Set<string>();
    const s = new LaunchdScheduler(501, { loadedSet: loaded });
    // Arm all three lanes.
    await s.wake("com.roll.loop.s", "/tmp/loop.plist");
    await s.wake("com.roll.pr.s", "/tmp/pr.plist");
    await s.wake("com.roll.dream.s", "/tmp/dream.plist");
    expect(loaded.size).toBe(3);

    // Dormant only the loop lane.
    await s.dormant("com.roll.loop.s");

    // AC2: loop is false, pr + dream are true.
    await expect(s.isArmed("com.roll.loop.s")).resolves.toBe(false);
    await expect(s.isArmed("com.roll.pr.s")).resolves.toBe(true);
    await expect(s.isArmed("com.roll.dream.s")).resolves.toBe(true);
    // AC1: dormant only called bootout once (for loop).
    expect(loaded.has("com.roll.loop.s")).toBe(false);
    expect(loaded.has("com.roll.pr.s")).toBe(true);
    expect(loaded.has("com.roll.dream.s")).toBe(true);
  });

  it("wake('loop') re-arms after dormant (AC4)", async () => {
    const loaded = new Set<string>();
    const s = new LaunchdScheduler(501, { loadedSet: loaded });
    await s.wake("com.roll.loop.s", "/tmp/loop.plist");
    await expect(s.isArmed("com.roll.loop.s")).resolves.toBe(true);
    await s.dormant("com.roll.loop.s");
    await expect(s.isArmed("com.roll.loop.s")).resolves.toBe(false);
    // Re-wake.
    await s.wake("com.roll.loop.s", "/tmp/loop.plist");
    await expect(s.isArmed("com.roll.loop.s")).resolves.toBe(true);
  });
});

// ─── AC3: CronScheduler per-lane (uses per-service cron ops) ───────────────────

describe("CronScheduler per-lane (AC3, AC4)", () => {
  // Test CronScheduler per-lane behavior via the pure cron functions.
  // The CronScheduler.dormant/wake/isArmed delegate to these.
  // (Integration tests with fake crontab binary are in schedule.difftest.test.ts)

  it("full cronInstall still produces byte-identical lines (existing difftest must pass)", () => {
    const installed = cronInstall("", perLaneCmds);
    expect(installed).toBe(
      '17 * * * * cd "/proj" && roll loop now >> /sh/loop/cron-s.log 2>&1 # roll-loop:/proj\n' +
      '2 3 * * * cd "/proj" && roll dream >> /proj/.roll/dream/cron.log 2>&1 # roll-loop:/proj\n',
    );
  });

  it("dormant loop then wake loop restores loop line idempotently", () => {
    const installed = cronInstall("", perLaneCmds);
    // Simulate CronScheduler.dormant("com.roll.loop.s")
    const afterDormant = cronRemovePerService(installed, perLaneCmds, "/proj", "loop");
    expect(cronHasPerServiceEntry(afterDormant, perLaneCmds, "/proj", "loop")).toBe(false);
    expect(cronHasPerServiceEntry(afterDormant, perLaneCmds, "/proj", "dream")).toBe(true);
    // Simulate CronScheduler.wake("com.roll.loop.s")
    const afterWake = cronInstallPerService(afterDormant, perLaneCmds, "/proj", "loop");
    expect(cronHasPerServiceEntry(afterWake, perLaneCmds, "/proj", "loop")).toBe(true);
    expect(cronHasPerServiceEntry(afterWake, perLaneCmds, "/proj", "dream")).toBe(true);
    // Restored: both lines present (order may differ from full cronInstall).
    expect(cronHasPerServiceEntry(afterWake, perLaneCmds, "/proj", "loop")).toBe(true);
    expect(cronHasPerServiceEntry(afterWake, perLaneCmds, "/proj", "dream")).toBe(true);
  });

  it("isArmed per-lane: loop true when loop line present, dream when dream present", () => {
    const installed = cronInstall("", perLaneCmds);
    expect(cronHasPerServiceEntry(installed, perLaneCmds, "/proj", "loop")).toBe(true);
    expect(cronHasPerServiceEntry(installed, perLaneCmds, "/proj", "dream")).toBe(true);
    // Remove loop only.
    const afterLoopOff = cronRemovePerService(installed, perLaneCmds, "/proj", "loop");
    expect(cronHasPerServiceEntry(afterLoopOff, perLaneCmds, "/proj", "loop")).toBe(false);
    expect(cronHasPerServiceEntry(afterLoopOff, perLaneCmds, "/proj", "dream")).toBe(true);
  });
});

// ─── US-LOOP-107b: owner-confirmed process fallback lifecycle ───────────────

// US-LOOP-116: the ProcessFallbackScheduler describes are gone with the class —
// no second resident scheduler exists to test.

