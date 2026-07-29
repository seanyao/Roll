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
  loopPauseCommand,
  loopResumeCommand,
  resolveLoopRunState,
  type LoopSchedDeps,
  type LoopRunState,
} from "../src/commands/loop-state.js";
import { recordRootCauseFailure } from "../src/runner/failure-attribution.js";
import { GOAL_GUIDED_ENV } from "../src/lib/goal-progress.js";
import { parseGoalYaml } from "@roll/spec";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

function tmp(tag: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `roll-sched-${tag}-`)));
  dirs.push(d);
  return d;
}

/**
 * Deps fake. US-LOOP-117: LoopSchedDeps carries ONE seam now (identity) — the
 * Scheduler seam, launchd dir, shared root and uid went with the plist layer. The
 * flaky-mount fake is gone too: there is no mount to retry.
 */
function fakeDeps(proj: string, _shared: string, _launchdDir: string): {
  deps: LoopSchedDeps;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    deps: { identity: () => Promise.resolve({ path: proj, slug: "proj-abc123" }) },
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








describe("loop pause/resume (marker file)", () => {
  it("pause writes PAUSE-<slug> under .roll/loop, resume removes it", async () => {
    const proj = tmp("proj3");
    const { deps } = fakeDeps(proj, tmp("sh3"), tmp("ld3"));
    const marker = join(proj, ".roll", "loop", "PAUSE-proj-abc123");

    const p = await captureStdout(() => loopPauseCommand([], deps));
    expect(p.code).toBe(0);
    // US-LOOP-112/116: no guided/autonomous mode and no scheduler to describe —
    // pause stops autonomous card selection by a driving session.
    expect(p.out).toContain("no card will be picked autonomously");
    expect(p.out).toContain("stop at the next cycle boundary");
    expect(p.out).not.toContain("scheduler");
    expect(existsSync(marker)).toBe(true);

    const p2 = await captureStdout(() => loopPauseCommand([], deps));
    expect(p2.code).toBe(0); // idempotent

    const r = await captureStdout(() => loopResumeCommand([], deps));
    expect(r.code).toBe(0);
    expect(r.out).toContain("autonomous card selection re-enabled");
    expect(r.out).toContain("roll loop go");
    expect(r.out).not.toContain("mode: autonomous");
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





// ─── US-LOOP-115: DORMANT retired ──────────────────────────────────────────
// The marker/resolver describes and the `loop on during DORMANT` lightweight-wake
// describes are gone with the machinery. `resolveLoopRunState` is now two-valued;
// dormancy-retired.test.ts covers it and pins the inert-leftover-marker behaviour.

/**
 * US-LOOP-119 — PAUSE means "stop AUTONOMOUS progress", not "stop the timer".
 *
 * The marker predates this epic, when it stopped a launchd lane from picking cards.
 * With no lane, the meaning it actually has is the one that survived: autonomous
 * selection stops, while an explicitly-scoped guided one-shot still runs (FIX-1472).
 * Both halves are asserted here from the resolver's side; the gate that enforces the
 * guided bypass is covered end-to-end in loop-run-once.test.ts and loop-go.test.ts.
 */
describe("US-LOOP-119 — PAUSE semantics", () => {
  it("PAUSED comes from the marker alone, and is per-slug", () => {
    const project = tmp("l119-pause");
    const rt = join(project, ".roll", "loop");
    mkdirSync(rt, { recursive: true });
    expect(resolveLoopRunState(project, "slug-a")).toBe("ACTIVE");

    writeFileSync(join(rt, "PAUSE-slug-a"), "paused by owner\n");
    expect(resolveLoopRunState(project, "slug-a")).toBe("PAUSED");
    // Another project's pause never pauses this one.
    expect(resolveLoopRunState(project, "slug-b")).toBe("ACTIVE");
  });

  it("a leftover DORMANT marker does not pause anything (US-LOOP-115 inertness)", () => {
    const project = tmp("l119-dormant");
    const rt = join(project, ".roll", "loop");
    mkdirSync(rt, { recursive: true });
    writeFileSync(join(rt, "DORMANT-slug-a"), "idle 6h\n");
    expect(resolveLoopRunState(project, "slug-a")).toBe("ACTIVE");
  });

  it("FIX-1472 stays reachable: the gate reads the guided env, not the run state", () => {
    // The guided bypass cannot be expressed as a run-state value — PAUSED is PAUSED.
    // What makes `--cards` work is the explicit guided flag the go driver sets, so
    // the resolver must NOT be the thing consulted for that decision. Assert the
    // seam exists and is env-based, so a future "resolver decides" refactor fails here.
    expect(GOAL_GUIDED_ENV).toBe("ROLL_LOOP_GO_GUIDED");
  });
});

// ─── US-LOOP-116: the fallback CLI surface is gone ──────────────────────────
// Its describes and the fake-backend helper went with the machinery; the
// no-second-daemon tripwire now guards against it returning.

// ─── US-LOOP-109: recovery from macOS launchd scheduler failure fault matrix ──

