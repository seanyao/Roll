/**
 * US-LOOP-009 — `roll loop on|off|pause|resume` (TS scheduling surface) and the
 * v3 runner template that replaces the v2 bash inner as the cycle heart.
 *
 * DELIBERATE v2 DIVERGENCE (whitelisted, see AGENTS.md bridge table): the v2
 * outer/inner pair (tmux popup, baked agent argv, engine sourcing) is replaced
 * by a self-contained wrapper that delegates the whole cycle to
 * `roll loop run-once`. No difftest applies — these tests pin the NEW contract:
 *   - runner template: self-contained (no bash-engine function calls — the
 *     FIX-197 family bug), honors PAUSE marker, active window, ROLL_LOOP_FORCE,
 *     logs to .roll/loop/cron.log, delegates to `loop run-once`.
 *   - off: plist uninstall via injected launchd ops (no real
 *     launchctl in tests); dream IS generated too (US-PORT-008) — same self-
 *     contained shape, daily schedule, delegating to `roll dream run-once`.
 *   - pause/resume: PAUSE-<slug> marker file under <project>/.roll/loop/.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildLoopRunnerScript,
  buildLoopTestRunnerScript,
  buildDreamRunnerScript,
  deriveMinute,
  parseLoopPeriodMinutes,
  loopOnCommand,
  loopOffCommand,
  loopPauseCommand,
  loopResumeCommand,
  loopHelperPidsToTerminate,
  loopFallbackCommand,
  loopStatusCommand,
  decideBackend,
  renderBackendStatusLines,
  resolveSchedulerBackend,
  readFallbackHealthSync,
  readFallbackHealthForProject,
  resolveFallbackConfig,
  resolveLoopRunState,
  type LoopSchedDeps,
  type LoopFallbackDeps,
  type FallbackBackend,
  type LoopRunState,
} from "../src/commands/loop-sched.js";
import { recordRootCauseFailure } from "../src/runner/failure-attribution.js";
import { ProcessFallbackScheduler, type LaunchctlResult, type ProcessFallbackStartResult, type ProcessFallbackChild } from "@roll/infra";
import { parseGoalYaml, type FallbackHealth } from "@roll/spec";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

function tmp(tag: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `roll-sched-${tag}-`)));
  dirs.push(d);
  return d;
}

/** Deps fake: records scheduler ops, pins identity/paths to a sandbox. */
function fakeDeps(proj: string, shared: string, launchdDir: string): {
  deps: LoopSchedDeps;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      identity: () => Promise.resolve({ path: proj, slug: "proj-abc123" }),
      uid: () => 501,
      sharedRoot: () => shared,
      launchdDir: () => launchdDir,
      scheduler: {
        wake: (label, plist) => {
          calls.push(`wake ${label} ${plist}`);
          return Promise.resolve(true);
        },
        dormant: (label) => {
          calls.push(`dormant ${label}`);
          return Promise.resolve(true);
        },
        isArmed: (label) => {
          calls.push(`isArmed ${label}`);
          return Promise.resolve(true);
        },
      },
    },
  };
}

/**
 * FIX-212 fake: wake fails for the first `failBefore[label]` attempts, and
 * `isArmed` reports armed only once that label has been woken past its
 * failing attempts. Mirrors the bootout+bootstrap race (FIX-027/098) where the
 * job silently does not mount.
 */
function fakeFlakyDeps(
  proj: string,
  shared: string,
  launchdDir: string,
  failBefore: Record<string, number>,
): { deps: LoopSchedDeps; attempts: Record<string, number> } {
  const attempts: Record<string, number> = {};
  return {
    attempts,
    deps: {
      identity: () => Promise.resolve({ path: proj, slug: "proj-abc123" }),
      uid: () => 501,
      sharedRoot: () => shared,
      launchdDir: () => launchdDir,
      scheduler: {
        wake: (_label) => {
          const label = _label;
          attempts[label] = (attempts[label] ?? 0) + 1;
          const fails = (failBefore[label] ?? 0) >= attempts[label];
          return Promise.resolve(!fails);
        },
        dormant: () => Promise.resolve(true),
        isArmed: (_label) =>
          Promise.resolve((attempts[_label] ?? 0) > (failBefore[_label] ?? 0)),
      },
    },
  };
}

function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (chunks.push(String(c)), true);
  return fn()
    .then((code) => ({ code, out: chunks.join("") }))
    .finally(() => {
      process.stdout.write = real;
    });
}

function captureBoth(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (out.push(String(c)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (c: string | Uint8Array): boolean => (err.push(String(c)), true);
  return fn()
    .then((code) => ({ code, out: out.join(""), err: err.join("") }))
    .finally(() => {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    });
}

describe("v3 loop runner template", () => {
  const script = buildLoopRunnerScript({
    projectPath: "/Users/u/proj",
    slug: "proj-abc123",
    activeStart: 0,
    activeEnd: 24,
  });

  it("delegates the cycle to `roll loop run-once` (the v3 heart)", () => {
    expect(script).toContain("loop run-once");
    expect(script).toContain('cd "/Users/u/proj"');
  });

  it("is self-contained — calls NO bash-engine functions (FIX-197 family)", () => {
    expect(script).not.toMatch(/_loop_migrate|_agents_migrate|_loop_runtime_dir|_loop_cycle_agent_cmd/);
    expect(script).not.toContain("source ");
  });

  it("honors the PAUSE marker before any work", () => {
    expect(script).toContain("PAUSE-proj-abc123");
    const pauseIdx = script.indexOf("PAUSE-proj-abc123");
    const runIdx = script.indexOf('"$ROLL_BIN" loop run-once'); // the invocation, not the comment
    expect(pauseIdx).toBeGreaterThan(-1);
    expect(pauseIdx).toBeLessThan(runIdx);
  });

  it("lets launchd ticks yield while a go session holds the session lock", () => {
    expect(script).toContain("go.lock");
    expect(script).toContain("goal:tick_skipped");
    const lockIdx = script.indexOf("go.lock");
    const runIdx = script.indexOf('"$ROLL_BIN" loop run-once');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(runIdx);
  });

  it("enforces the active window but lets ROLL_LOOP_FORCE bypass it", () => {
    expect(script).toContain("ROLL_LOOP_FORCE");
    const s = buildLoopRunnerScript({ projectPath: "/p", slug: "s", activeStart: 9, activeEnd: 18 });
    expect(s).toContain("-lt 9");
    expect(s).toContain("-ge 18");
  });

  it("logs to the project-local cron.log and keeps the box awake", () => {
    expect(script).toContain('RT="/Users/u/proj/.roll/loop"');
    expect(script).toContain('LOG="$RT/cron.log"');
    expect(script).toContain("caffeinate");
  });

  it("FIX-1209: exports ROLL_MAIN_SLUG as identity fuse", () => {
    expect(script).toContain('export ROLL_MAIN_SLUG="proj-abc123"');
  });

  it("resolves the roll binary from PATH with a brew fallback", () => {
    expect(script).toMatch(/command -v roll/);
  });

  it("FIX-230: the tmux cycle window inherits the CALLER's proxy env, not the session's frozen snapshot", () => {
    // The new-window command must inline the caller's proxy family at window
    // creation time (`VAR='${VAR:-}'` expands in the runner's shell, outside
    // tmux) — a stale session created under a now-dead proxy must not leak its
    // HTTP(S)_PROXY/ALL_PROXY into the cycle (agents would time out with
    // "Connection error", the reproduced incident).
    const win = script.split("\n").find((l) => l.includes("new-window") && l.includes("ROLL_TMUX_WRAPPED=1"));
    expect(win).toBeDefined();
    for (const v of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      expect(win).toContain(`${v}='\${${v}:-}'`);
    }
  });

  it("FIX-403: the tmux cycle window forwards agent API key env names without writing values", () => {
    const win = script.split("\n").find((l) => l.includes("new-window") && l.includes("ROLL_TMUX_WRAPPED=1"));
    expect(win).toBeDefined();
    expect(win).toContain("DEEPSEEK_API_KEY='${DEEPSEEK_API_KEY:-}'");
    expect(script).not.toContain("test-secret-value");
  });

  it("FIX-230: cycle start logs the effective proxy env (observability for env drift)", () => {
    expect(script).toMatch(/env: HTTP_PROXY=.*HTTPS_PROXY=.*ALL_PROXY=/);
  });

  // ─── FIX-393: cycle inflight guard + headless capture ──────────────────────

  it("FIX-393 AC1: guards against overlapping cycles with cycle-inflight.lock (mirrors go.lock pattern)", () => {
    expect(script).toContain("cycle-inflight.lock");
    expect(script).toContain("cycle:tick_skipped");
    expect(script).toContain("cycle_inflight");
    // Guard check is before run-once invocation.
    const guardIdx = script.indexOf("cycle-inflight.lock");
    const runIdx = script.indexOf('"$ROLL_BIN" loop run-once');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(runIdx);
  });

  it("FIX-393 AC2: staleness threshold is 5400s (90min)", () => {
    expect(script).toContain("-lt 5400");
  });

  it("FIX-393 AC3: go.lock check comes BEFORE cycle-inflight check (independent, coexisting)", () => {
    const goIdx = script.indexOf("go.lock");
    const cycleIdx = script.indexOf("cycle-inflight.lock");
    expect(goIdx).toBeGreaterThan(-1);
    expect(cycleIdx).toBeGreaterThan(-1);
    expect(goIdx).toBeLessThan(cycleIdx);
  });

  it("FIX-393 AC6: disables physical screenshot popups for unattended loop without enabling headless evidence", () => {
    expect(script).not.toContain("ROLL_ATTEST_HEADLESS");
    expect(script).toContain('export ROLL_ATTEST_NO_TERMINAL="${ROLL_ATTEST_NO_TERMINAL:-1}"');
    const terminalIdx = script.indexOf("ROLL_ATTEST_NO_TERMINAL");
    const runIdx = script.indexOf('"$ROLL_BIN" loop run-once');
    expect(terminalIdx).toBeGreaterThan(-1);
    expect(terminalIdx).toBeLessThan(runIdx);
  });

  it("FIX-1022: exports ROLL_NO_SCREENCAP=1 BEFORE run-once so the screencapture probe skips (isTTY is unreliable under the PTY-wrapped loop)", () => {
    expect(script).toContain('export ROLL_NO_SCREENCAP="${ROLL_NO_SCREENCAP:-1}"');
    const noScreencapIdx = script.indexOf("ROLL_NO_SCREENCAP");
    const runIdx = script.indexOf('"$ROLL_BIN" loop run-once');
    expect(noScreencapIdx).toBeGreaterThan(-1);
    expect(noScreencapIdx).toBeLessThan(runIdx);
  });

  it("FIX-393: acquires the cycle inflight lock and sets trap EXIT before caffeinate", () => {
    const acquireIdx = script.indexOf("printf '%s:%s");
    const trapIdx = script.indexOf("trap 'rm -f");
    const caffIdx = script.indexOf("caffeinate");
    const runIdx = script.indexOf('"$ROLL_BIN" loop run-once');
    expect(acquireIdx).toBeGreaterThan(-1);
    expect(trapIdx).toBeGreaterThan(-1);
    // Acquire + trap must come BEFORE the cycle starts (caffeinate / run-once).
    expect(acquireIdx).toBeLessThan(caffIdx);
    expect(trapIdx).toBeLessThan(caffIdx);
    expect(acquireIdx).toBeLessThan(runIdx);
  });

  it("FIX-393: env var defaults can be overridden by caller", () => {
    // The :- syntax in ${VAR:-1} lets the caller override.
    expect(script).toContain("${ROLL_ATTEST_NO_TERMINAL:-1}");
    expect(script).toContain("${ROLL_NO_SCREENCAP:-1}");
  });
});

describe("v3 loop runner — EXECUTION in a sandbox (the contract that matters)", () => {
  /** Build a shim dir: fake `roll` records argv; `date` reports a fixed hour. */
  function shimDir(hour: string): { dir: string; argvLog: string } {
    const dir = tmp("shim");
    const argvLog = join(dir, "roll-argv.log");
    writeFileSync(join(dir, "roll"), `#!/bin/sh\necho "$@" >> "${argvLog}"\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(dir, "date"), `#!/bin/sh\ncase "$1" in +%H) echo ${hour} ;; *) /bin/date "$@" ;; esac\n`, {
      mode: 0o755,
    });
    return { dir, argvLog };
  }

  function runScript(proj: string, slug: string, hour: string, opts: { start?: number; end?: number; force?: string } = {}): {
    status: number;
    argvLog: string;
  } {
    const { dir, argvLog } = shimDir(hour);
    const script = buildLoopRunnerScript({
      projectPath: proj,
      slug,
      activeStart: opts.start ?? 0,
      activeEnd: opts.end ?? 24,
    });
    const sp = join(dir, "runner.sh");
    writeFileSync(sp, script, { mode: 0o755 });
    const env: Record<string, string> = {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: proj,
      // The template's PATH bootstrap prepends brew dirs, which would shadow
      // the shim with a REAL installed roll — pin via the ROLL_BIN override
      // (a supported contract: launchd env / operators may set it too).
      ROLL_BIN: join(dir, "roll"),
      // These cases assert the DIRECT-run contract — pin the FIX-204E opt-out
      // so a tmux on the host PATH can't hijack the sandbox.
      ROLL_LOOP_NO_TMUX: "1",
      ...(opts.force !== undefined ? { ROLL_LOOP_FORCE: opts.force } : {}),
    };
    const r = execSync(`bash '${sp}'; echo rc=$?`, { env, encoding: "utf8" });
    return { status: Number(/rc=(\d+)/.exec(r)?.[1] ?? "1"), argvLog };
  }

  it("really invokes `roll loop run-once` and logs the cycle", () => {
    const proj = tmp("exec1");
    const { status, argvLog } = runScript(proj, "s1", "12");
    expect(status).toBe(0);
    expect(readFileSync(argvLog, "utf8").trim()).toBe("loop run-once");
    const log = readFileSync(join(proj, ".roll", "loop", "cron.log"), "utf8");
    expect(log).toContain("cycle start (v3 run-once)");
    expect(log).toContain("cycle end rc=0");
  });

  it("really skips run-once and records an event when go.lock is held", () => {
    const proj = tmp("go-lock");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    writeFileSync(join(proj, ".roll", "loop", "go.lock"), `${process.pid}:${Math.floor(Date.now() / 1000)}\n`);
    const { status, argvLog } = runScript(proj, "s1", "12");
    expect(status).toBe(0);
    expect(existsSync(argvLog)).toBe(false);
    const events = readFileSync(join(proj, ".roll", "loop", "events.ndjson"), "utf8");
    expect(events).toContain('"type":"goal:tick_skipped"');
    expect(events).toContain('"reason":"go_session_lock"');
  });

  it("FIX-1040: directory go.lock from loop go also makes scheduled ticks yield", () => {
    const proj = tmp("go-lock-dir");
    const lockDir = join(proj, ".roll", "loop", "go.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "meta.json"),
      `${JSON.stringify({
        pid: process.pid,
        hostname: "",
        startedAt: Math.floor(Date.now() / 1000),
        cycleId: "goal-20260629151450-69149",
      })}\n`,
    );

    const { status, argvLog } = runScript(proj, "s1", "12");

    expect(status).toBe(0);
    expect(existsSync(argvLog)).toBe(false);
    const events = readFileSync(join(proj, ".roll", "loop", "events.ndjson"), "utf8");
    expect(events).toContain('"type":"goal:tick_skipped"');
    expect(events).toContain('"reason":"go_session_lock"');
    const log = readFileSync(join(proj, ".roll", "loop", "cron.log"), "utf8");
    expect(log).toContain("goal go session lock held by pid");
  });

  // ─── FIX-393: cycle inflight lock execution tests ─────────────────────────

  it("FIX-393 AC1: live cycle-inflight.lock → tick yields with event, no run-once", () => {
    const proj = tmp("cycle-live");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    // Simulate a live cycle-inflight.lock held by this process.
    writeFileSync(join(proj, ".roll", "loop", "cycle-inflight.lock"), `${process.pid}:${Math.floor(Date.now() / 1000)}\n`);
    const { status, argvLog } = runScript(proj, "s1", "12");
    expect(status).toBe(0);
    // run-once must NOT have been called.
    expect(existsSync(argvLog)).toBe(false);
    // Event must record the yield.
    const events = readFileSync(join(proj, ".roll", "loop", "events.ndjson"), "utf8");
    expect(events).toContain('"type":"cycle:tick_skipped"');
    expect(events).toContain('"reason":"cycle_inflight"');
    // Log must mention the inflight lock.
    const log = readFileSync(join(proj, ".roll", "loop", "cron.log"), "utf8");
    expect(log).toContain("cycle inflight lock held by pid");
  });

  it("FIX-393 AC2: stale cycle-inflight.lock (dead PID) → cleaned, cycle runs", () => {
    const proj = tmp("cycle-stale");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    // Simulate a lock held by a PID that does not exist.
    writeFileSync(join(proj, ".roll", "loop", "cycle-inflight.lock"), `99999:${Math.floor(Date.now() / 1000)}\n`);
    const { status, argvLog } = runScript(proj, "s1", "12");
    expect(status).toBe(0);
    // run-once MUST have been called (stale lock cleaned, cycle ran).
    expect(existsSync(argvLog)).toBe(true);
    expect(readFileSync(argvLog, "utf8").trim()).toBe("loop run-once");
  });

  it("FIX-393 AC2: stale cycle-inflight.lock (old timestamp beyond 90min) → cleaned, cycle runs", () => {
    const proj = tmp("cycle-old");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    // Simulate a lock with a timestamp > 90min ago but held by a live PID.
    const oldTs = Math.floor(Date.now() / 1000) - 5500; // 91+ min ago
    writeFileSync(join(proj, ".roll", "loop", "cycle-inflight.lock"), `${process.pid}:${oldTs}\n`);
    const { argvLog } = runScript(proj, "s1", "12");
    // Even though PID is alive, the lock is stale (>5400s) → cleaned, cycle runs.
    expect(existsSync(argvLog)).toBe(true);
  });

  it("FIX-393 AC3: go.lock takes priority — when BOTH locks are held, go.lock yields first", () => {
    const proj = tmp("cycle-both");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    // Both locks held by live PIDs.
    writeFileSync(join(proj, ".roll", "loop", "go.lock"), `${process.pid}:${Math.floor(Date.now() / 1000)}\n`);
    writeFileSync(join(proj, ".roll", "loop", "cycle-inflight.lock"), `${process.pid}:${Math.floor(Date.now() / 1000)}\n`);
    const { argvLog } = runScript(proj, "s1", "12");
    // go.lock is checked FIRST → goal:tick_skipped, no run-once.
    expect(existsSync(argvLog)).toBe(false);
    const events = readFileSync(join(proj, ".roll", "loop", "events.ndjson"), "utf8");
    expect(events).toContain('"reason":"go_session_lock"');
  });

  it("FIX-393: the cycle inflight lock is released when the cycle completes", () => {
    const proj = tmp("cycle-release");
    const { status, argvLog } = runScript(proj, "s1", "12");
    expect(status).toBe(0);
    expect(existsSync(argvLog)).toBe(true);
    // After the cycle completes, the lock file must be gone.
    const lockPath = join(proj, ".roll", "loop", "cycle-inflight.lock");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("PAUSE marker short-circuits before any invocation", () => {
    const proj = tmp("exec2");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    writeFileSync(join(proj, ".roll", "loop", "PAUSE-s2"), "paused\n");
    const { status, argvLog } = runScript(proj, "s2", "12");
    expect(status).toBe(0);
    expect(existsSync(argvLog)).toBe(false);
  });

  it("hour 08 inside an [8,9) window RUNS — the v2 octal printf bug is fixed", () => {
    const proj = tmp("exec3");
    const { argvLog } = runScript(proj, "s3", "08", { start: 8, end: 9 });
    expect(existsSync(argvLog)).toBe(true); // v2's printf %d "08" → 0 → wrongly skipped
  });

  it("outside the window exits silently; ROLL_LOOP_FORCE bypasses", () => {
    const proj = tmp("exec4");
    const a = runScript(proj, "s4", "20", { start: 9, end: 18 });
    expect(existsSync(a.argvLog)).toBe(false);
    const b = runScript(proj, "s4", "20", { start: 9, end: 18, force: "1" });
    expect(existsSync(b.argvLog)).toBe(true);
  });
});

describe("v3 dream runner template (US-PORT-008)", () => {
  const script = buildDreamRunnerScript({
    projectPath: "/Users/u/proj",
    slug: "proj-abc123",
    rollBin: "/opt/homebrew/bin/roll",
  });

  it("delegates the scan to `roll dream run-once` (the v3 heart)", () => {
    expect(script).toContain('"$ROLL_BIN" dream run-once');
    expect(script).toContain('cd "/Users/u/proj"');
    expect(script).toContain('RT="/Users/u/proj/.roll/dream"'); // project-local log dir (FIX-139)
    expect(script).toContain('LOG="$RT/cron.log"');
  });

  it("FIX-1022: exports ROLL_NO_SCREENCAP=1 before the scan (dream run-once hits the same probe)", () => {
    expect(script).toContain('export ROLL_NO_SCREENCAP="${ROLL_NO_SCREENCAP:-1}"');
    expect(script.indexOf("ROLL_NO_SCREENCAP")).toBeLessThan(script.indexOf('"$ROLL_BIN" dream run-once'));
  });

  it("is self-contained — calls NO bash-engine functions, no source, no tmux", () => {
    expect(script).not.toMatch(/_loop_migrate|_agent_skill_cmd|_loop_runtime_dir|_write_runner_script/);
    expect(script).not.toContain("source ");
    expect(script).not.toContain("tmux"); // dream is non-interactive — no observation window
  });

  it("honors the shared PAUSE marker before running the scan", () => {
    expect(script).toContain("PAUSE-proj-abc123");
    const pauseIdx = script.indexOf("PAUSE-proj-abc123");
    const runIdx = script.indexOf('"$ROLL_BIN" dream run-once');
    expect(pauseIdx).toBeGreaterThan(-1);
    expect(pauseIdx).toBeLessThan(runIdx);
  });

  it("defaults ROLL_BIN to command -v roll when no override given", () => {
    const s = buildDreamRunnerScript({ projectPath: "/Users/u/proj", slug: "s" });
    expect(s).toContain("command -v roll");
  });
});

describe("deriveMinute (ports _loop_derive_minute)", () => {
  it("is a stable md5-derived minute in [1,55]", () => {
    const m = deriveMinute("/Users/u/proj");
    expect(m).toBeGreaterThanOrEqual(1);
    expect(m).toBeLessThanOrEqual(55);
    expect(deriveMinute("/Users/u/proj")).toBe(m); // deterministic
  });

  it("matches the bash formula (md5 hex[0:6] + offset) % 55 + 1", () => {
    const p = "/some/project/path";
    const dec = parseInt(createHash("md5").update(p).digest("hex").slice(0, 6), 16);
    expect(deriveMinute(p, 2)).toBe(((dec + 2) % 55) + 1);
  });
});

describe("parseLoopPeriodMinutes", () => {
  it("reads loop_schedule.period_minutes from local.yaml text", () => {
    expect(parseLoopPeriodMinutes("loop_schedule:\n  period_minutes: 30\n  offset_minute: 7\n")).toBe(30);
  });
  it("falls back to 30 on missing/malformed", () => {
    expect(parseLoopPeriodMinutes("")).toBe(30);
    expect(parseLoopPeriodMinutes("loop_schedule:\n  period_minutes: abc\n")).toBe(30);
    expect(parseLoopPeriodMinutes("agent: kimi\n")).toBe(30);
  });
});

describe("loop on/off (injected launchd)", () => {
  it("on: writes loop+dream runners & plists, reinstalls all two labels", async () => {
    const proj = tmp("proj");
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "local.yaml"), "loop_schedule:\n  period_minutes: 30\n");
    const shared = tmp("shared");
    const ld = tmp("launchd");
    const { deps, calls } = fakeDeps(proj, shared, ld);

    const { code, out } = await captureStdout(() => loopOnCommand([], deps));
    expect(code).toBe(0);

    const loopRunner = join(shared, "loop", "run-proj-abc123.sh");
    const dreamRunner = join(shared, "dream", "run-proj-abc123.sh");
    expect(existsSync(loopRunner)).toBe(true);
    expect(existsSync(dreamRunner)).toBe(true);
    expect(readFileSync(loopRunner, "utf8")).toContain("loop run-once");
    expect(readFileSync(dreamRunner, "utf8")).toContain("dream run-once"); // US-PORT-008
    expect(existsSync(join(ld, "com.roll.loop.proj-abc123.plist"))).toBe(true);
    expect(existsSync(join(ld, "com.roll.dream.proj-abc123.plist"))).toBe(true);
    const plist = readFileSync(join(ld, "com.roll.loop.proj-abc123.plist"), "utf8");
    expect(plist).toContain("<integer>1800</integer>"); // 30min × 60
    // dream default daily path = StartInterval 86400 (FIX-105), no calendar.
    const dreamPlist = readFileSync(join(ld, "com.roll.dream.proj-abc123.plist"), "utf8");
    expect(dreamPlist).toContain("<integer>86400</integer>");

    expect(calls.some((c) => c.startsWith("wake com.roll.loop.proj-abc123"))).toBe(true);
    expect(calls.some((c) => c.startsWith("wake com.roll.dream.proj-abc123"))).toBe(true); // US-PORT-008

    expect(out).toContain("Loop enabled");
    expect(out).toContain("run-once"); // the new heart is stated
    expect(out).toContain("mode: autonomous");
    expect(out).toContain("pause/budget/route/evidence/Evaluator/release gates");
  });

  it("off: boots out loop+dream labels and removes their plists", async () => {
    const proj = tmp("proj2");
    const ld = tmp("ld2");
    const prev = process.env["_LAUNCHD_DIR"];
    process.env["_LAUNCHD_DIR"] = ld;
    const labels = ["com.roll.loop.proj-abc123", "com.roll.dream.proj-abc123"];
    for (const label of labels) writeFileSync(join(ld, `${label}.plist`), "<plist />\n");
    try {
      const { deps, calls } = fakeDeps(proj, tmp("sh2"), ld);
      const { code, out } = await captureStdout(() => loopOffCommand([], deps));
      expect(code).toBe(0);
      expect(calls).toContain("dormant com.roll.loop.proj-abc123");
      expect(calls).toContain("dormant com.roll.dream.proj-abc123");
      for (const label of labels) expect(existsSync(join(ld, `${label}.plist`))).toBe(false);
      expect(out).toContain("mode: guided");
    } finally {
      if (prev === undefined) delete process.env["_LAUNCHD_DIR"];
      else process.env["_LAUNCHD_DIR"] = prev;
    }
  });

  it("off --all: boots out every Roll launchd label without project identity", async () => {
    const ld = tmp("ld-all");
    const prev = process.env["_LAUNCHD_DIR"];
    process.env["_LAUNCHD_DIR"] = ld;
    const labels = [
      "com.roll.loop.alpha-111111",
      "com.roll.dream.alpha-111111",
      "com.roll.pr.beta-222222",
      "com.roll.legacy.gamma-333333",
    ];
    for (const label of labels) writeFileSync(join(ld, `${label}.plist`), "<plist />\n");
    writeFileSync(join(ld, "com.apple.not-roll.plist"), "<plist />\n");
    try {
      const { deps, calls } = fakeDeps(tmp("proj-all"), tmp("sh-all"), ld);
      deps.identity = () => {
        throw new Error("off --all must not need project identity");
      };

      const { code, out } = await captureStdout(() => loopOffCommand(["--all"], deps));
      expect(code).toBe(0);
      const sortedLabels = [...labels].sort();
      expect(calls).toEqual(sortedLabels.map((label) => `dormant ${label}`));
      for (const label of labels) expect(existsSync(join(ld, `${label}.plist`))).toBe(false);
      expect(existsSync(join(ld, "com.apple.not-roll.plist"))).toBe(true);
      expect(out).toContain("Loop disabled for all projects (4 Roll launchd job(s) removed)");
      expect(out).toContain("mode: guided");
    } finally {
      if (prev === undefined) delete process.env["_LAUNCHD_DIR"];
      else process.env["_LAUNCHD_DIR"] = prev;
    }
  });

  it("FIX-1225: off terminates repo-scoped helper processes after unloading lanes", async () => {
    const proj = tmp("proj2-off-cleanup");
    const killed: Array<{ projectPath: string; slug: string }> = [];
    const { deps, calls } = fakeDeps(proj, tmp("sh2-off-cleanup"), tmp("ld2-off-cleanup"));
    deps.cleanupHelpers = (projectPath, slug) => {
      killed.push({ projectPath, slug });
      return { processCount: 3, tmuxSessionKilled: true };
    };

    const { code, out } = await captureStdout(() => loopOffCommand([], deps));
    expect(code).toBe(0);
    expect(calls).toContain("dormant com.roll.loop.proj-abc123");
    expect(calls).toContain("dormant com.roll.dream.proj-abc123");
    expect(killed).toEqual([{ projectPath: proj, slug: "proj-abc123" }]);
    expect(out).toContain("stopped tmux session roll-loop-proj-abc123 and 3 helper process(es)");
  });

  it("FIX-1225: helper cleanup is scoped by cwd/project path/session slug", () => {
    const proj = tmp("proj2-helper-scope");
    const other = tmp("proj2-helper-other");
    const pids = loopHelperPidsToTerminate(
      proj,
      "proj-abc123",
      [
        { pid: 101, command: "node /bin/roll loop watch --since all", cwd: proj },
        { pid: 102, command: "node /bin/roll loop run-once", cwd: join(proj, "packages", "cli") },
        { pid: 103, command: `tmux new-session -s roll-loop-proj-abc123 roll loop go --attach` },
        { pid: 105, command: "node /bin/roll loop watch --since all", cwd: other },
        { pid: 106, command: "node /bin/roll loop off", cwd: proj },
        { pid: 107, command: "node /bin/roll loop status", cwd: proj },
      ],
      104,
    );

    expect(pids).toEqual([101, 102, 103]);
  });
});

describe("FIX-212 — loop on verifies the mount & fails loud", () => {
  function project(): { proj: string; shared: string; ld: string } {
    const proj = tmp("f212");
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "local.yaml"), "loop_schedule:\n  period_minutes: 30\n");
    return { proj, shared: tmp("f212sh"), ld: tmp("f212ld") };
  }

  it("AC1: bootstrap failing persistently → non-zero exit naming the failed label", async () => {
    const { proj, shared, ld } = project();
    // loop label never mounts (race never resolves); pr mounts fine.
    const { deps } = fakeFlakyDeps(proj, shared, ld, { "com.roll.loop.proj-abc123": 99 });
    const previousLang = process.env["ROLL_LANG"];
    process.env["ROLL_LANG"] = "en";
    try {
      const { code, err } = await captureBoth(() => loopOnCommand([], deps));
      expect(code).not.toBe(0);
      expect(err).toContain("domain: gui/501");
      expect(err).toContain("label: com.roll.loop.proj-abc123");
      expect(err).toContain(`plist: ${join(ld, "com.roll.loop.proj-abc123.plist")}`);
      expect(err).toContain("launchctl bootout gui/501/com.roll.loop.proj-abc123");
      expect(err).toContain(`launchctl bootstrap gui/501 ${join(ld, "com.roll.loop.proj-abc123.plist")}`);
      expect(err).not.toContain("挂载");
    } finally {
      if (previousLang === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = previousLang;
    }
  });

  it("FIX-1246: zh failure diagnostics stay single-language and actionable", async () => {
    const { proj, shared, ld } = project();
    const { deps } = fakeFlakyDeps(proj, shared, ld, { "com.roll.loop.proj-abc123": 99 });
    const previousLang = process.env["ROLL_LANG"];
    process.env["ROLL_LANG"] = "zh";
    try {
      const { code, err } = await captureBoth(() => loopOnCommand([], deps));
      expect(code).not.toBe(0);
      expect(err).toContain("launchd 任务挂载失败");
      expect(err).toContain("域: gui/501");
      expect(err).toContain("标签: com.roll.loop.proj-abc123");
      expect(err).toContain(`plist: ${join(ld, "com.roll.loop.proj-abc123.plist")}`);
      expect(err).not.toContain("scheduling NOT active");
    } finally {
      if (previousLang === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = previousLang;
    }
  });

  it("AC3: a transient bootstrap failure recovers on the single retry → exit 0", async () => {
    const { proj, shared, ld } = project();
    // both labels fail their first attempt, succeed on the retry.
    const { deps, attempts } = fakeFlakyDeps(proj, shared, ld, {
      "com.roll.loop.proj-abc123": 1,
    });
    const { code } = await captureBoth(() => loopOnCommand([], deps));
    expect(code).toBe(0);
    expect(attempts["com.roll.loop.proj-abc123"]).toBe(2); // one retry, no more
  });

  it("does NOT retry more than once — a third attempt is never made", async () => {
    const { proj, shared, ld } = project();
    const { deps, attempts } = fakeFlakyDeps(proj, shared, ld, { "com.roll.loop.proj-abc123": 99 });
    await captureBoth(() => loopOnCommand([], deps));
    expect(attempts["com.roll.loop.proj-abc123"]).toBe(2); // initial + 1 retry, capped
  });

  it("AC2: success path output carries the verified-mount evidence for both labels", async () => {
    const proj = tmp("f212ok");
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "local.yaml"), "loop_schedule:\n  period_minutes: 30\n");
    const { deps, calls } = fakeDeps(proj, tmp("f212oksh"), tmp("f212okld"));
    const { code, out } = await captureBoth(() => loopOnCommand([], deps));
    expect(code).toBe(0);
    // evidence line (bilingual) + the two verified labels
    expect(out).toContain("已验证挂载");
    expect(out.toLowerCase()).toContain("verified");
    expect(out).toContain("com.roll.loop.proj-abc123");
    // the mount was actually probed, not assumed
    expect(calls.some((c) => c.startsWith("isArmed com.roll.loop.proj-abc123"))).toBe(true);
  });
});

describe("loop pause/resume (marker file)", () => {
  it("pause writes PAUSE-<slug> under .roll/loop, resume removes it", async () => {
    const proj = tmp("proj3");
    const { deps } = fakeDeps(proj, tmp("sh3"), tmp("ld3"));
    const marker = join(proj, ".roll", "loop", "PAUSE-proj-abc123");

    const p = await captureStdout(() => loopPauseCommand([], deps));
    expect(p.code).toBe(0);
    expect(p.out).toContain("mode: guided");
    expect(existsSync(marker)).toBe(true);

    const p2 = await captureStdout(() => loopPauseCommand([], deps));
    expect(p2.code).toBe(0); // idempotent

    const r = await captureStdout(() => loopResumeCommand([], deps));
    expect(r.code).toBe(0);
    expect(r.out).toContain("mode: autonomous");
    expect(existsSync(marker)).toBe(false);

    const r2 = await captureStdout(() => loopResumeCommand([], deps));
    expect(r2.code).toBe(0); // idempotent
  });

  it("FIX-1239: resume refuses autonomous scheduling when the repo-local roll package is newer than the runner", async () => {
    const proj = tmp("proj-resume-stale");
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "@seanyao/roll", version: "99.0.0" }) + "\n");
    const { deps } = fakeDeps(proj, tmp("sh-resume-stale"), tmp("ld-resume-stale"));
    const marker = join(proj, ".roll", "loop", "PAUSE-proj-abc123");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    writeFileSync(marker, "2026-06-11T10:00:00Z\n");

    const r = await captureBoth(() => loopResumeCommand([], deps));

    expect(r.code).toBe(1);
    expect(r.err).toContain("runner_stale_for_repo");
    expect(existsSync(marker)).toBe(true);
  });

  // FIX-251: resume must clear the consecutive-failure counter, heal counters,
  // and emit a loop:resumed event so the post-resume cycle does not immediately
  // re-trip the auto-pause.
  it("resume resets consecutive-fails counter and heal state", async () => {
    const proj = tmp("proj-fix251");
    const { deps } = fakeDeps(proj, tmp("sh-fix251"), tmp("ld-fix251"));
    const rt = join(proj, ".roll", "loop");
    const marker = join(rt, "PAUSE-proj-abc123");
    mkdirSync(rt, { recursive: true });

    // Simulate a paused state with accumulated failure counters.
    writeFileSync(marker, "2026-06-11T10:00:00Z\n");
    writeFileSync(join(rt, "consecutive-fails"), "3");
    const stateFile = join(rt, "state-proj-abc123.yaml");
    writeFileSync(stateFile, "status: paused\nheal_count_head_abcd1234: 2\nlast_run: '...'\n");

    const r = await captureStdout(() => loopResumeCommand([], deps));
    expect(r.code).toBe(0);

    // PAUSE marker removed.
    expect(existsSync(marker)).toBe(false);
    // consecutive-fails reset to 0.
    expect(existsSync(join(rt, "consecutive-fails"))).toBe(true);
    expect(readFileSync(join(rt, "consecutive-fails"), "utf8").trim()).toBe("0");
    // heal_count_head_* entries cleared from state file.
    const stateAfter = readFileSync(stateFile, "utf8");
    expect(stateAfter).not.toContain("heal_count_head_");
    expect(stateAfter).toContain("status: paused"); // non-heal lines preserved
  });

  it("resume clears the root-cause counter that triggered the PAUSE marker", async () => {
    const proj = tmp("proj-root-cause-resume");
    const { deps } = fakeDeps(proj, tmp("sh-root-cause-resume"), tmp("ld-root-cause-resume"));
    const rt = join(proj, ".roll", "loop");
    const marker = join(rt, "PAUSE-proj-abc123");
    mkdirSync(rt, { recursive: true });

    writeFileSync(
      marker,
      "# ALERT — loop auto-paused on env failure\n\n**Root cause**: env:main_dirty\n**Count**: 3\n",
      "utf8",
    );
    writeFileSync(
      join(rt, "failure-attribution.json"),
      JSON.stringify(
        {
          causes: {
            "env:main_dirty": {
              timestamps: [1, 2, 3],
              lastCycleId: "cycle-3",
              failureClass: "env",
            },
            "harness:score_parse": {
              timestamps: [4],
              lastCycleId: "cycle-4",
              failureClass: "harness",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const r = await captureStdout(() => loopResumeCommand([], deps));
    expect(r.code).toBe(0);

    const stateAfter = JSON.parse(readFileSync(join(rt, "failure-attribution.json"), "utf8")) as {
      causes: Record<string, unknown>;
    };
    expect(stateAfter.causes["env:main_dirty"]).toBeUndefined();
    expect(stateAfter.causes["harness:score_parse"]).toBeDefined();

    const postResume = recordRootCauseFailure(
      rt,
      "cycle-after-resume",
      { failureClass: "env", rootCauseKey: "env:main_dirty", confidence: "envelope" },
      [],
      3,
      { nowMs: 5 },
    );
    expect(postResume).toMatchObject({ count: 1, paused: false, rootCauseKey: "env:main_dirty" });
  });

  // US-LOOP-079h1 AC4: resume must clear the consecutive-idle counter.
  it("resume resets consecutive-idle counter (US-LOOP-079h1 AC4)", async () => {
    const proj = tmp("proj-idle1");
    const { deps } = fakeDeps(proj, tmp("sh-idle1"), tmp("ld-idle1"));
    const rt = join(proj, ".roll", "loop");
    const marker = join(rt, "PAUSE-proj-abc123");
    mkdirSync(rt, { recursive: true });

    // Simulate a paused state with an accumulated idle counter.
    writeFileSync(marker, "2026-06-11T10:00:00Z\n");
    writeFileSync(join(rt, "consecutive-idle-proj-abc123"), "5");

    const r = await captureStdout(() => loopResumeCommand([], deps));
    expect(r.code).toBe(0);

    // consecutive-idle-<slug> reset to 0.
    expect(existsSync(join(rt, "consecutive-idle-proj-abc123"))).toBe(true);
    expect(readFileSync(join(rt, "consecutive-idle-proj-abc123"), "utf8").trim()).toBe("0");
  });

  // US-LOOP-079h1 AC4: resume without a prior idle counter file is safe (no-op).
  it("resume does not fail when consecutive-idle file does not exist", async () => {
    const proj = tmp("proj-idle2");
    const { deps } = fakeDeps(proj, tmp("sh-idle2"), tmp("ld-idle2"));
    const rt = join(proj, ".roll", "loop");
    const marker = join(rt, "PAUSE-proj-abc123");
    mkdirSync(rt, { recursive: true });
    writeFileSync(marker, "2026-06-11T10:00:00Z\n");

    const r = await captureStdout(() => loopResumeCommand([], deps));
    expect(r.code).toBe(0);
  });

  it("resume emits loop:resumed event when a PAUSE marker was present", async () => {
    const proj = tmp("proj-fix251b");
    const { deps } = fakeDeps(proj, tmp("sh-fix251b"), tmp("ld-fix251b"));
    const rt = join(proj, ".roll", "loop");
    const marker = join(rt, "PAUSE-proj-abc123");
    mkdirSync(rt, { recursive: true });
    writeFileSync(marker, "2026-06-11T10:00:00Z\n");

    const r = await captureStdout(() => loopResumeCommand([], deps));
    expect(r.code).toBe(0);

    // events.ndjson should contain a loop:resumed event.
    const eventsPath = join(rt, "events.ndjson");
    expect(existsSync(eventsPath)).toBe(true);
    const eventsText = readFileSync(eventsPath, "utf8");
    expect(eventsText).toContain('"type":"loop:resumed"');
    expect(eventsText).toContain('"loop":"ci"');
  });

  it("resume without a PAUSE marker does not emit loop:resumed (was not paused)", async () => {
    const proj = tmp("proj-fix251c");
    const { deps } = fakeDeps(proj, tmp("sh-fix251c"), tmp("ld-fix251c"));
    const rt = join(proj, ".roll", "loop");
    mkdirSync(rt, { recursive: true });

    const r = await captureStdout(() => loopResumeCommand([], deps));
    expect(r.code).toBe(0);

    // No events.ndjson should have been created (nothing to emit).
    const eventsPath = join(rt, "events.ndjson");
    expect(existsSync(eventsPath)).toBe(false);
  });

  it("pause marks an active goal paused without killing the current cycle", async () => {
    const proj = tmp("goal-pause");
    const { deps } = fakeDeps(proj, tmp("shared"), tmp("ld"));
    const rt = join(proj, ".roll", "loop");
    mkdirSync(rt, { recursive: true });
    writeFileSync(
      join(rt, "goal.yaml"),
      `schema: goal.v1
scope:
  kind: all
status: active
usage:
  cycles: 1
  costUsd: 0.5
createdAt: 2026-06-11T08:00:00Z
updatedAt: 2026-06-11T08:00:00Z
`,
    );

    const r = await captureStdout(() => loopPauseCommand([], deps));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(rt, "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("loop_pause");
    const events = readFileSync(join(rt, "events.ndjson"), "utf8");
    expect(events).toContain('"type":"goal:state"');
    expect(events).toContain('"to":"paused"');
  });
});

describe("FIX-197 — loop now legacy self-heal", async () => {
  const { isLegacyRunner, loopNowCommand } = await import("../src/commands/loop-sched.js");

  it("isLegacyRunner: bare-engine calls, non-run-once wrappers AND tmux-less v3 runners are legacy", () => {
    expect(isLegacyRunner('#!/bin/bash -l\n_loop_migrate_legacy_paths "x"\n')).toBe(true);
    expect(isLegacyRunner("#!/bin/bash\nsomething else entirely\n")).toBe(true);
    // FIX-204E: a pre-observation-window v3 runner regenerates too
    expect(isLegacyRunner('#!/bin/bash -l\n"$ROLL_BIN" loop run-once >> "$LOG" 2>&1\n')).toBe(true);
    expect(isLegacyRunner(buildLoopRunnerScript({ projectPath: "/p", slug: "x", activeStart: 0, activeEnd: 24 }))).toBe(false);
  });

  it("legacy runner → regenerated via loop on, then executed with the v3 template", async () => {
    const proj = tmp("nowproj");
    const shared = tmp("nowshared");
    const ld = tmp("nowld");
    const { deps, calls } = fakeDeps(proj, shared, ld);
    const execed: string[] = [];
    deps.execRunner = (p): Promise<number> => {
      execed.push(readFileSync(p, "utf8").includes("loop run-once") ? "v3" : "legacy");
      return Promise.resolve(0);
    };
    const runner = join(shared, "loop", "run-proj-abc123.sh");
    mkdirSync(join(shared, "loop"), { recursive: true });
    writeFileSync(runner, '#!/bin/bash -l\n_loop_migrate_legacy_paths "proj-abc123"\n', { mode: 0o755 });

    const { code, out } = await captureStdout(() => loopNowCommand([], deps));
    expect(code).toBe(0);
    expect(out).toContain("FIX-197");
    expect(execed).toEqual(["v3"]); // regenerated BEFORE execution
    expect(calls.some((c) => c.startsWith("wake com.roll.loop"))).toBe(true);
  });

  it("fresh v3 runner → no regeneration, straight exec; rc propagates", async () => {
    const proj = tmp("nowproj2");
    const shared = tmp("nowshared2");
    const { deps, calls } = fakeDeps(proj, shared, tmp("nowld2"));
    deps.execRunner = (): Promise<number> => Promise.resolve(7);
    const runner = join(shared, "loop", "run-proj-abc123.sh");
    mkdirSync(join(shared, "loop"), { recursive: true });
    writeFileSync(runner, buildLoopRunnerScript({ projectPath: proj, slug: "proj-abc123", activeStart: 0, activeEnd: 24 }), { mode: 0o755 });

    const { code, out } = await captureStdout(() => loopNowCommand([], deps));
    expect(code).toBe(7);
    expect(out).not.toContain("FIX-197");
    expect(calls).toHaveLength(0);
  });

  it("FIX-1239: forwards --cards to the one-shot runner as an allow-list", async () => {
    const proj = tmp("nowproj3");
    const shared = tmp("nowshared3");
    const { deps } = fakeDeps(proj, shared, tmp("nowld3"));
    const seen: Array<string[] | undefined> = [];
    deps.execRunner = (_runner, opts): Promise<number> => {
      seen.push(opts?.allowedCards);
      return Promise.resolve(0);
    };
    const runner = join(shared, "loop", "run-proj-abc123.sh");
    mkdirSync(join(shared, "loop"), { recursive: true });
    writeFileSync(runner, buildLoopRunnerScript({ projectPath: proj, slug: "proj-abc123", activeStart: 0, activeEnd: 24 }), { mode: 0o755 });

    const { code, out } = await captureStdout(() => loopNowCommand(["--cards", "FIX-1235,FIX-1239"], deps));

    expect(code).toBe(0);
    expect(out).toContain("scope: cards FIX-1235, FIX-1239");
    expect(seen).toEqual([["FIX-1235", "FIX-1239"]]);
  });

  it("FIX-1239: loop now refuses to execute a stale runner for this repo", async () => {
    const proj = tmp("nowproj-stale");
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "@seanyao/roll", version: "99.0.0" }) + "\n");
    const shared = tmp("nowshared-stale");
    const { deps } = fakeDeps(proj, shared, tmp("nowld-stale"));
    let calls = 0;
    deps.execRunner = (): Promise<number> => {
      calls += 1;
      return Promise.resolve(0);
    };
    const runner = join(shared, "loop", "run-proj-abc123.sh");
    mkdirSync(join(shared, "loop"), { recursive: true });
    writeFileSync(runner, buildLoopRunnerScript({ projectPath: proj, slug: "proj-abc123", activeStart: 0, activeEnd: 24 }), { mode: 0o755 });

    const r = await captureBoth(() => loopNowCommand(["--cards", "FIX-1235"], deps));

    expect(r.code).toBe(1);
    expect(r.err).toContain("runner_stale_for_repo");
    expect(calls).toBe(0);
  });
});

describe("FIX-204E — tmux observation window in the runner template", () => {
  const s = buildLoopRunnerScript({ projectPath: "/p", slug: "s9", activeStart: 0, activeEnd: 24 });

  it("wraps the cycle into tmux session roll-loop-<slug> with a live.log watch window", () => {
    expect(s).toContain('_sess="roll-loop-s9"');
    expect(s).toContain('"$TMUX_BIN" has-session');
    expect(s).toContain('"$TMUX_BIN" new-session -d -s');
    expect(s).toContain("-x 200 -y 50"); // v2 oracle geometry
    expect(s).toContain("'$ROLL_BIN' loop watch");
    expect(s).not.toContain("tail -n +1 -F '$RT/live.log' | '$ROLL_BIN' loop fmt");
    expect(s).toContain('"$TMUX_BIN" new-window -d');
    expect(s).toContain("ROLL_TMUX_WRAPPED=1");
  });

  it("US-LOOP-047: routes the watch window through `roll loop watch`", () => {
    // The unified watch entrypoint owns default status, event modes, and
    // live.log following; the scheduler should not hand-roll tail|fmt.
    expect(s).toMatch(/'\$ROLL_BIN' loop watch/);
    expect(s).not.toMatch(/tail -n \+1 -F '\$RT\/live\.log' \| '\$ROLL_BIN' loop fmt/);
  });

  it("the wrap precedes caffeinate AND the cycle invocation; guards allow opt-out + re-entry", () => {
    expect(s.indexOf("new-window")).toBeLessThan(s.indexOf("caffeinate"));
    expect(s.indexOf("new-window")).toBeLessThan(s.indexOf('loop run-once >>'));
    expect(s).toContain('[ -z "$ROLL_TMUX_WRAPPED" ]');
    expect(s).toContain('[ -z "$ROLL_LOOP_NO_TMUX" ]');
    expect(s).toContain('command -v "$TMUX_BIN"');
    // PAUSE short-circuits BEFORE any tmux session is spawned
    expect(s.indexOf("PAUSE-s9")).toBeLessThan(s.indexOf("has-session"));
  });

  it("generation-time rollBin override is baked verbatim", () => {
    const o = buildLoopRunnerScript({ projectPath: "/p", slug: "s9", activeStart: 0, activeEnd: 24, rollBin: "/dev/roll-cli.js" });
    expect(o).toContain('ROLL_BIN="${ROLL_BIN:-/dev/roll-cli.js}"');
  });

  it("US-LOOP-047: the smoke runner tmux watch window also uses `roll loop watch`", () => {
    const smoke = buildLoopTestRunnerScript({ projectPath: "/p", slug: "s9", cmd: "echo ok" });
    expect(smoke).toContain("'$ROLL_BIN' loop watch --since all");
    expect(smoke).not.toContain("tail -n +1 -F '$RT/live.log' | '$ROLL_BIN' loop fmt");
  });

  it("FIX-403: the smoke runner tmux window also forwards agent API key env names", () => {
    const smoke = buildLoopTestRunnerScript({ projectPath: "/p", slug: "s9", cmd: "echo ok" });
    const win = smoke.split("\n").find((l) => l.includes("new-window") && l.includes("ROLL_TMUX_WRAPPED=1"));
    expect(win).toBeDefined();
    expect(win).toContain("DEEPSEEK_API_KEY='${DEEPSEEK_API_KEY:-}'");
  });
});

describe("FIX-204E — tmux path EXECUTION in a sandbox", () => {
  function tmuxSandbox(opts: { hasSession?: boolean } = {}): {
    dir: string;
    rollArgv: string;
    tmuxArgv: string;
  } {
    const dir = tmp("tmuxsb");
    const rollArgv = join(dir, "roll-argv.log");
    const tmuxArgv = join(dir, "tmux-argv.log");
    writeFileSync(join(dir, "roll"), `#!/bin/sh\necho "$@" >> "${rollArgv}"\nexit 0\n`, { mode: 0o755 });
    // fake tmux: records argv; has-session reflects the fixture's wish
    writeFileSync(
      join(dir, "tmux"),
      `#!/bin/sh\necho "$@" >> "${tmuxArgv}"\ncase "$1" in has-session) exit ${opts.hasSession === true ? 0 : 1} ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    return { dir, rollArgv, tmuxArgv };
  }

  function runOuter(
    proj: string,
    slug: string,
    sb: { dir: string },
    env: Record<string, string> = {},
  ): number {
    const script = buildLoopRunnerScript({ projectPath: proj, slug, activeStart: 0, activeEnd: 24 });
    const sp = join(sb.dir, "runner.sh");
    writeFileSync(sp, script, { mode: 0o755 });
    const r = execSync(`bash '${sp}'; echo rc=$?`, {
      // ROLL_TMUX_BIN pins the SHIM — the template's PATH bootstrap prepends
      // brew dirs, which would shadow the sandbox with the real tmux.
      env: {
        PATH: `${sb.dir}:/usr/bin:/bin`,
        HOME: proj,
        ROLL_BIN: join(sb.dir, "roll"),
        ROLL_TMUX_BIN: join(sb.dir, "tmux"),
        ...env,
      },
      encoding: "utf8",
    });
    return Number(/rc=(\d+)/.exec(r)?.[1] ?? "1");
  }

  it("outer invocation dispatches into tmux (session + window) and does NOT run the cycle itself", () => {
    const proj = tmp("tmux1");
    const sb = tmuxSandbox();
    const rc = runOuter(proj, "t1", sb);
    expect(rc).toBe(0);
    expect(existsSync(sb.rollArgv)).toBe(false); // no direct run
    const calls = readFileSync(sb.tmuxArgv, "utf8");
    expect(calls).toContain("has-session");
    expect(calls).toContain("new-session -d -s roll-loop-t1");
    expect(calls).toContain("new-window -d -t roll-loop-t1");
    expect(calls).toContain("ROLL_TMUX_WRAPPED=1");
    expect(calls).toContain("DEEPSEEK_API_KEY=''");
    // the cycle log stays untouched — the WRAPPED run owns it
    expect(existsSync(join(proj, ".roll", "loop", "cron.log"))).toBe(false);
  });

  it("existing session → no second new-session, still a new cycle window", () => {
    const proj = tmp("tmux2");
    const sb = tmuxSandbox({ hasSession: true });
    runOuter(proj, "t2", sb);
    const calls = readFileSync(sb.tmuxArgv, "utf8");
    expect(calls).not.toContain("new-session");
    expect(calls).toContain("new-window -d -t roll-loop-t2");
  });

  it("ROLL_TMUX_WRAPPED=1 (inside the window) runs the cycle directly", () => {
    const proj = tmp("tmux3");
    const sb = tmuxSandbox();
    const rc = runOuter(proj, "t3", sb, { ROLL_TMUX_WRAPPED: "1" });
    expect(rc).toBe(0);
    expect(readFileSync(sb.rollArgv, "utf8").trim()).toBe("loop run-once");
    expect(readFileSync(join(proj, ".roll", "loop", "cron.log"), "utf8")).toContain("cycle end rc=0");
    expect(existsSync(sb.tmuxArgv)).toBe(false); // no tmux calls in the wrapped run
  });

  it("ROLL_LOOP_NO_TMUX=1 opts out — direct run even with tmux present", () => {
    const proj = tmp("tmux4");
    const sb = tmuxSandbox();
    const rc = runOuter(proj, "t4", sb, { ROLL_LOOP_NO_TMUX: "1" });
    expect(rc).toBe(0);
    expect(readFileSync(sb.rollArgv, "utf8").trim()).toBe("loop run-once");
    expect(existsSync(sb.tmuxArgv)).toBe(false);
  });
});

describe("FIX-204E — loop now UX branches (injected deps)", () => {
  async function nowWith(hasTmux: boolean, observeSpy: { called: number }): Promise<{ code: number; out: string }> {
    // FIX-204E hermeticity: a caller may set ROLL_LOOP_NO_TMUX=1 in the outer
    // environment, but this test asserts the deps-controlled tmux branch.
    const previousNoTmux = process.env["ROLL_LOOP_NO_TMUX"];
    process.env["ROLL_LOOP_NO_TMUX"] = "";
    const proj = tmp("nowux");
    const shared = tmp("nowuxsh");
    const { deps } = fakeDeps(proj, shared, tmp("nowuxld"));
    deps.execRunner = (): Promise<number> => Promise.resolve(0);
    deps.hasTmux = (): boolean => hasTmux;
    deps.observe = (): Promise<void> => {
      observeSpy.called += 1;
      return Promise.resolve();
    };
    const runner = join(shared, "loop", "run-proj-abc123.sh");
    mkdirSync(join(shared, "loop"), { recursive: true });
    writeFileSync(runner, buildLoopRunnerScript({ projectPath: proj, slug: "proj-abc123", activeStart: 0, activeEnd: 24 }), { mode: 0o755 });
    const { loopNowCommand } = await import("../src/commands/loop-sched.js");
    try {
      return await captureStdout(() => loopNowCommand([], deps));
    } finally {
      if (previousNoTmux === undefined) delete process.env["ROLL_LOOP_NO_TMUX"];
      else process.env["ROLL_LOOP_NO_TMUX"] = previousNoTmux;
    }
  }

  it("tmux available: prints the attach hint and observes until the cycle ends", async () => {
    const spy = { called: 0 };
    const { code, out } = await nowWith(true, spy);
    expect(code).toBe(0);
    expect(out).toContain("tmux attach -t roll-loop-proj-abc123");
    expect(out).toContain("Ctrl-C");
    expect(spy.called).toBe(1);
    expect(out).toContain("cycle finished");
  });

  it("no tmux: inline message, no observation pass", async () => {
    const spy = { called: 0 };
    const { code, out } = await nowWith(false, spy);
    expect(code).toBe(0);
    expect(out).toContain("no tmux");
    expect(spy.called).toBe(0);
  });
});

// ─── US-LOOP-115: DORMANT retired ──────────────────────────────────────────
// The marker/resolver describes and the `loop on during DORMANT` lightweight-wake
// describes are gone with the machinery. `resolveLoopRunState` is now two-valued;
// dormancy-retired.test.ts covers it and pins the inert-leftover-marker behaviour.

// ─── US-LOOP-108: owner-confirmed process fallback CLI surface ───────────────

/** Fake FallbackBackend + deps — no real process is ever spawned. */
function fakeFallbackDeps(opts: {
  launchdArmed?: boolean;
  health?: FallbackHealth;
  startResult?: ProcessFallbackStartResult;
  stopResult?: boolean;
  slug?: string;
  path?: string;
} = {}): { deps: LoopFallbackDeps; calls: string[]; healthRef: { current: FallbackHealth } } {
  const calls: string[] = [];
  const healthRef = {
    current: opts.health ?? ({ status: "unknown", reason: "no fallback lease", lease: null, alive: false } as FallbackHealth),
  };
  const backend: FallbackBackend = {
    start: (_c, intent) => {
      calls.push(`start ownerConfirmed=${intent.ownerConfirmed === true}`);
      return Promise.resolve(opts.startResult ?? { started: true, reason: "owner-confirmed fallback runner started", pid: 4242 });
    },
    stop: (_c) => {
      calls.push("stop");
      return Promise.resolve(opts.stopResult ?? true);
    },
    health: (_c) => {
      calls.push("health");
      return Promise.resolve(healthRef.current);
    },
  };
  return {
    calls,
    healthRef,
    deps: {
      identity: () => Promise.resolve({ path: opts.path ?? "/tmp/us108", slug: opts.slug ?? "proj-abc123" }),
      resolveConfig: (path, slug) => ({ projectPath: path, slug, periodMinutes: 30, rollBin: "roll" }),
      launchdArmed: () => {
        calls.push("launchdArmed");
        return Promise.resolve(opts.launchdArmed ?? false);
      },
      backend,
    },
  };
}

/** Scrub volatile PID / ISO-time / tmp-path values so snapshots are portable. */
function scrub(s: string): string {
  return s
    .replace(/pid: ?\d+/g, "pid: <PID>")
    .replace(/pid \d+/g, "pid <PID>")
    .replace(/PID \d+/g, "PID <PID>")
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.Z+-]+/g, "<TS>")
    .replace(/\/tmp\/[^\s)]+/g, "<PATH>");
}

const ARMED_LEASE: FallbackHealth = {
  status: "armed",
  reason: "PID 4242 live, heartbeat fresh (3s)",
  alive: true,
  lease: {
    pid: 4242,
    commandDigest: "deadbeef",
    ownerConfirmedAt: "2026-07-15T10:00:00Z",
    startedAt: "2026-07-15T10:00:00Z",
    heartbeatAt: "2026-07-15T10:00:03Z",
    runnerToken: "tok",
  },
};

const STALE_LEASE: FallbackHealth = {
  status: "stale",
  reason: "PID 4242 is not alive",
  alive: false,
  lease: {
    pid: 4242,
    commandDigest: "deadbeef",
    ownerConfirmedAt: "2026-07-15T10:00:00Z",
    startedAt: "2026-07-15T10:00:00Z",
    heartbeatAt: "2026-07-15T10:00:03Z",
    runnerToken: "tok",
  },
};

describe("US-LOOP-108: loop on launchd failure ends unarmed + offers fallback", () => {
  it("AC1: launchd bootstrap failure prints unarmed + explicit fallback command, exit 1", async () => {
    const proj = tmp("f108");
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "local.yaml"), "loop_schedule:\n  period_minutes: 30\n");
    const { deps } = fakeFlakyDeps(proj, tmp("f108sh"), tmp("f108ld"), { "com.roll.loop.proj-abc123": 99 });
    const previousLang = process.env["ROLL_LANG"];
    process.env["ROLL_LANG"] = "en";
    try {
      const { code, err } = await captureBoth(() => loopOnCommand([], deps));
      expect(code).toBe(1);
      expect(err).toContain("scheduler: unarmed");
      expect(err).toContain("roll loop fallback start --confirm");
      // AC1: it must NOT auto-start a fallback — no lease dir is created.
      expect(existsSync(join(proj, ".roll", "loop", "fallback-lease-proj-abc123"))).toBe(false);
    } finally {
      if (previousLang === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = previousLang;
    }
  });
});

describe("US-LOOP-108: roll loop fallback start/stop/status", () => {
  it("AC2: start WITHOUT --confirm refuses and never calls backend.start", async () => {
    const { deps, calls } = fakeFallbackDeps();
    const { code, err } = await captureBoth(() => loopFallbackCommand(["start"], deps));
    expect(code).toBe(1);
    expect(err).toContain("owner confirmation required");
    expect(err).toContain("roll loop fallback start --confirm");
    expect(calls.some((c) => c.startsWith("start"))).toBe(false);
  });

  it("AC2: start --confirm reaches the backend with ownerConfirmed=true and reports armed", async () => {
    const { deps, calls, healthRef } = fakeFallbackDeps();
    healthRef.current = ARMED_LEASE; // health() after start reads the live lease
    const { code, out } = await captureStdout(() => loopFallbackCommand(["start", "--confirm"], deps));
    expect(code).toBe(0);
    expect(calls).toContain("start ownerConfirmed=true");
    expect(out).toContain("Process fallback armed (owner-confirmed)");
    expect(out).toContain("not a launchd replacement");
  });

  it("AC2: start --confirm surfaces a live holder PID when the backend refuses", async () => {
    const { deps } = fakeFallbackDeps({
      startResult: { started: false, reason: "fallback runner PID 4242 is still alive; owner action is required", pid: 4242 },
    });
    const { code, err } = await captureBoth(() => loopFallbackCommand(["start", "--confirm"], deps));
    expect(code).toBe(1);
    expect(scrub(err)).toContain("holder pid: <PID>");
    expect(err).toContain("still alive");
  });

  it("AC3: status renders launchd|process-fallback|none, PID, heartbeat, limitation (armed)", async () => {
    const { deps } = fakeFallbackDeps({ health: ARMED_LEASE });
    const { code, out } = await captureStdout(() => loopStatusCommand([], deps));
    expect(code).toBe(0);
    expect(scrub(out)).toBe(
      [
        "scheduler backend: process-fallback",
        "  launchd: unarmed",
        "  process-fallback: armed (owner-confirmed)",
        "    pid: <PID>  heartbeat: <TS>",
        "    owner-confirmed: <TS>",
        "    limitation: not a launchd replacement — does not survive reboot/login",
        "",
      ].join("\n"),
    );
  });

  it("AC3: a stale/dead fallback is reported STALE and NEVER as an active backend", async () => {
    const { deps } = fakeFallbackDeps({ health: STALE_LEASE });
    const view = await resolveSchedulerBackend(deps);
    expect(view.backend).toBe("none"); // stale lease is not process-fallback
    const rendered = scrub(renderBackendStatusLines(view, "en").join("\n"));
    expect(rendered).toContain("process-fallback: stale — NOT active");
    expect(rendered).not.toContain("process-fallback: armed");
    expect(rendered).toContain("scheduler: unarmed");
  });

  it("AC3: launchd armed wins as the backend even with no fallback lease", async () => {
    const { deps } = fakeFallbackDeps({ launchdArmed: true });
    const view = await resolveSchedulerBackend(deps);
    expect(view.backend).toBe("launchd");
    expect(scrub(renderBackendStatusLines(view, "en").join("\n"))).toContain("launchd: armed");
  });

  it("AC2: stop signals the backend and reports the runner shutting down", async () => {
    const { deps, calls } = fakeFallbackDeps({ health: ARMED_LEASE, stopResult: true });
    const { code, out } = await captureStdout(() => loopFallbackCommand(["stop"], deps));
    expect(code).toBe(0);
    expect(calls).toContain("stop");
    expect(out).toContain("stop signaled");
    expect(out).toContain("no further tick will run");
  });

  it("AC2: stop with no lease is a clean no-op", async () => {
    const { deps, calls } = fakeFallbackDeps(); // health = no lease
    const { code, out } = await captureStdout(() => loopFallbackCommand(["stop"], deps));
    expect(code).toBe(0);
    expect(out).toContain("nothing to stop");
    expect(calls.includes("stop")).toBe(false);
  });

  it("decideBackend gates process-fallback on liveness, never on a dead lease", () => {
    expect(decideBackend(true, STALE_LEASE)).toBe("launchd");
    expect(decideBackend(false, ARMED_LEASE)).toBe("process-fallback");
    expect(decideBackend(false, STALE_LEASE)).toBe("none");
  });
});

describe("US-LOOP-108: real ProcessFallbackScheduler wiring (not cosmetic)", () => {
  it("start --confirm writes a real US-LOOP-107 lease; status reads it back; stop clears it", async () => {
    const proj = tmp("f108real");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    // A fake detached child: pid = this test process (a REAL, live pid) so the
    // sync status reader's real `systemPidAlive` sees it as alive. kill() fires
    // the scheduler's exit callback so lease cleanup runs — exactly as a real
    // runner exit would. No real process is spawned or signalled.
    let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
    const scheduler = new ProcessFallbackScheduler({
      spawnRunner: () => ({
        pid: process.pid,
        kill: () => {
          const cb = exitCb;
          exitCb = null;
          if (cb) cb(0, null);
          return true;
        },
        once: (event, listener) => {
          if (event === "exit") exitCb = listener;
          return undefined;
        },
        unref: () => undefined,
      }),
    });
    const deps: LoopFallbackDeps = {
      identity: () => Promise.resolve({ path: proj, slug: "proj-abc123" }),
      resolveConfig: resolveFallbackConfig,
      launchdArmed: () => Promise.resolve(false),
      backend: {
        start: (c, i) => scheduler.start(c, i),
        stop: (c) => scheduler.stop(c),
        health: (c) => scheduler.health(c),
      },
    };

    const start = await captureStdout(() => loopFallbackCommand(["start", "--confirm"], deps));
    expect(start.code).toBe(0);
    // The real lease file exists — the CLI reached the US-LOOP-107 backend.
    const leaseFile = join(proj, ".roll", "loop", "fallback-lease-proj-abc123", "lease.json");
    expect(existsSync(leaseFile)).toBe(true);

    const found = readFallbackHealthForProject(proj);
    expect(found?.slug).toBe("proj-abc123");
    expect(found?.health.alive).toBe(true);

    const status = await captureStdout(() => loopStatusCommand([], deps));
    expect(status.out).toContain("scheduler backend: process-fallback");

    const stop = await captureStdout(() => loopFallbackCommand(["stop"], deps));
    expect(stop.code).toBe(0);
    // The lease is gone after the child "exit" — cleanup ran via kill().
    const afterStop = readFallbackHealthSync(proj, "proj-abc123");
    expect(afterStop.alive).toBe(false);
  });
});

// ─── US-LOOP-109: recovery from macOS launchd scheduler failure fault matrix ──

describe("US-LOOP-109: recovery from launchd scheduler failure fault matrix", () => {
  function project() {
    const proj = tmp("f109");
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "local.yaml"), "loop_schedule:\n  period_minutes: 30\n");
    return proj;
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
      } as unknown as ProcessFallbackChild,
      exit: (code = 0, signal: NodeJS.Signals | null = null) => onExit?.(code, signal),
    };
  }

  function realFallbackDeps(proj: string, scheduler: ProcessFallbackScheduler): LoopFallbackDeps {
    return {
      identity: () => Promise.resolve({ path: proj, slug: "proj-abc123" }),
      resolveConfig: resolveFallbackConfig,
      backend: {
        start: (c, i) => scheduler.start(c, i),
        stop: (c) => scheduler.stop(c),
        health: (c) => scheduler.health(c),
      },
      launchdArmed: () => Promise.resolve(false),
    };
  }

  it("launchd bootstrap failure leaves scheduling unarmed and names the fallback command", async () => {
    const proj = project();
    const { deps } = fakeFlakyDeps(proj, tmp("f109sh-fail"), tmp("f109ld-fail"), {
      "com.roll.loop.proj-abc123": 99,
    });
    const previousLang = process.env["ROLL_LANG"];
    process.env["ROLL_LANG"] = "en";
    try {
      const { code, err } = await captureBoth(() => loopOnCommand([], deps));
      expect(code).toBe(1);
      expect(err).toContain("scheduler: unarmed");
      expect(err).toContain("roll loop fallback start --confirm");
      // No false-active state: a failed bootstrap never writes a fallback lease.
      expect(existsSync(join(proj, ".roll", "loop", "fallback-lease-proj-abc123"))).toBe(false);
    } finally {
      if (previousLang === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = previousLang;
    }
  });

  it("roll loop status reports none — never launchd — after a launchd failure with no fallback", async () => {
    const proj = project();
    const deps: LoopFallbackDeps = {
      identity: () => Promise.resolve({ path: proj, slug: "proj-abc123" }),
      resolveConfig: resolveFallbackConfig,
      backend: {
        start: () => Promise.resolve({ started: false, reason: "not requested" }),
        stop: () => Promise.resolve(false),
        health: () =>
          Promise.resolve({ status: "unknown", reason: "no fallback lease", lease: null, alive: false }),
      },
      launchdArmed: () => Promise.resolve(false),
    };
    const { code, out } = await captureStdout(() => loopStatusCommand([], deps));
    expect(code).toBe(0);
    expect(out).toContain("scheduler backend: none");
    expect(out).not.toContain("launchd: armed");
    expect(out).toContain("scheduler: unarmed");
  });

  it("fallback start requires an explicit --confirm", async () => {
    const { deps, calls } = fakeFallbackDeps();
    const { code, err } = await captureBoth(() => loopFallbackCommand(["start"], deps));
    expect(code).toBe(1);
    expect(err).toContain("owner confirmation required");
    expect(calls.some((c) => c.startsWith("start"))).toBe(false);
  });

  it("owner-confirmed fallback emits a heartbeat tick and reports the live backend", async () => {
    const proj = tmp("f109-heartbeat");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    const fake = fakeFallbackChild(process.pid);
    const scheduler = new ProcessFallbackScheduler({ spawnRunner: () => fake.child });
    const deps = realFallbackDeps(proj, scheduler);

    const { code, out } = await captureStdout(() => loopFallbackCommand(["start", "--confirm"], deps));

    expect(code).toBe(0);
    expect(out).toContain("Process fallback armed");
    expect(existsSync(join(proj, ".roll", "loop", "fallback-lease-proj-abc123", "lease.json"))).toBe(true);
    expect(existsSync(join(proj, ".roll", "loop", "fallback-heartbeat-proj-abc123"))).toBe(true);

    const status = await captureStdout(() => loopStatusCommand([], deps));
    expect(status.out).toContain("scheduler backend: process-fallback");
    expect(status.out).not.toContain("launchd: armed");
  });

  it("stop tears down the runner and prevents further ticks", async () => {
    const proj = tmp("f109-stop");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    const fake = fakeFallbackChild(process.pid);
    const scheduler = new ProcessFallbackScheduler({ spawnRunner: () => fake.child });
    const deps = realFallbackDeps(proj, scheduler);

    const start = await captureStdout(() => loopFallbackCommand(["start", "--confirm"], deps));
    expect(start.code).toBe(0);

    const stop = await captureStdout(() => loopFallbackCommand(["stop"], deps));
    expect(stop.code).toBe(0);

    // Simulate the runner process exiting after SIGTERM.
    fake.exit(0, null);

    const leaseFile = join(proj, ".roll", "loop", "fallback-lease-proj-abc123", "lease.json");
    expect(existsSync(leaseFile)).toBe(false);

    const status = await captureStdout(() => loopStatusCommand([], deps));
    expect(status.out).toContain("scheduler backend: none");
  });

  it("stale lease recovery reclaims a dead PID and blocks duplicate starts", async () => {
    const proj = tmp("f109-stale");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    const fresh = fakeFallbackChild(process.pid);
    const spawnRunner = vi.fn().mockReturnValue(fresh.child);
    const scheduler = new ProcessFallbackScheduler({ spawnRunner, pidAlive: (pid) => pid === process.pid });
    const deps = realFallbackDeps(proj, scheduler);

    // Simulate a leftover lease from a crashed runner whose PID is no longer alive.
    const leaseDir = join(proj, ".roll", "loop", "fallback-lease-proj-abc123");
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(
      join(leaseDir, "lease.json"),
      JSON.stringify({
        pid: 99999,
        commandDigest: "deadbeef",
        ownerConfirmedAt: "2026-07-15T10:00:00Z",
        startedAt: "2026-07-15T10:00:00Z",
        heartbeatAt: "2026-07-15T10:00:03Z",
        runnerToken: "stale-token",
      }),
    );

    const first = await captureStdout(() => loopFallbackCommand(["start", "--confirm"], deps));
    expect(first.code).toBe(0);
    expect(spawnRunner).toHaveBeenCalledTimes(1);

    // A second owner-confirmed start while the fresh runner holds the lease is refused.
    const second = await captureBoth(() => loopFallbackCommand(["start", "--confirm"], deps));
    expect(second.code).not.toBe(0);
    expect(second.err).toContain("still alive");
    expect(spawnRunner).toHaveBeenCalledTimes(1);
  });
});
