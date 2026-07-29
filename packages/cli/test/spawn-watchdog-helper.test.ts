/**
 * US-CYCLE-002 — the sub-agent spawn watchdog wrapper. A supervisor delegates to
 * sequential heterogeneous subagents (designer / evaluator / adversarial builder
 * / pick-ranking); every one of those spawns is wrapped by `spawnWatched` so a
 * PRODUCTIVE run survives on git-state renewal while a silent stall dies on its
 * per-role cap — with a terminal-visible, durably-recorded `spawn:kill`.
 *
 * These tests pin: per-role cap resolution (config-driven, FIX-1249 loud
 * fallback), the role mapping, the delivered path (no kill), and the NEGATIVE
 * stale-kill fixture (role/model/reason/duration on the event AND the terminal
 * line, `timedOut` folded, per-role accounting outcome).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RollEvent } from "@roll/spec";
import { formatSpawnKillLine } from "@roll/core";
import { readRoleTimeouts, resetRoleTimeoutNotices, spawnWatched, watchdogRoleFor } from "../src/runner/spawn-watchdog.js";

const POLL_ENV = "ROLL_TIMEOUT_POLL_MS";

/** Minimal Ports/ctx stubs — spawnWatched only touches repoCwd, clock, git,
 *  events, paths. A story-less ctx makes recordSpawnRound a no-op (no disk). */
function stubPorts(over: {
  repoCwd: string;
  clock: () => number;
  commitCount?: (cwd: string) => Promise<number>;
  stateSignature?: (cwd: string) => Promise<string>;
  events: RollEvent[];
}) {
  return {
    repoCwd: over.repoCwd,
    clock: over.clock,
    git: {
      commitsAhead: over.commitCount ?? (async () => 0),
      ...(over.stateSignature !== undefined ? { worktreeStatusSignature: over.stateSignature } : {}),
    },
    events: { appendEvent: (_p: string, ev: RollEvent) => over.events.push(ev) },
    paths: { eventsPath: join(over.repoCwd, "events.ndjson") },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
const STORYLESS = { cycleId: "cyc-1", storyId: "", model: "m-x" } as unknown as Parameters<typeof spawnWatched>[0]["ctx"];

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uscycle002-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env[POLL_ENV];
  for (const k of Object.keys(process.env)) if (k.startsWith("ROLL_ROLE_")) delete process.env[k];
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("no spawn path bypasses the watchdog (scorer focus)", () => {
  // Structural guard: every delta/subagent spawn site routes its ports.agentSpawn
  // through spawnWatched. If a site adds a raw agentSpawn call without wrapping it,
  // the wrapped-count invariant breaks and this test fails.
  const runnerDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "runner");
  const SITES = [
    "execution-profile.ts", // designer
    "spawn-role-handler.ts", // adversarial builder roles
    "capture-peer-helpers.ts", // peer
    "capture-facts-handler.ts", // scorer
    "pick-ranking.ts", // pick-ranking
  ];
  for (const file of SITES) {
    it(`${file}: every ports.agentSpawn( is wrapped by spawnWatched`, () => {
      const src = readFileSync(join(runnerDir, file), "utf8");
      const spawns = (src.match(/ports\.agentSpawn\(/g) ?? []).length;
      const wrapped = (src.match(/spawnWatched\(/g) ?? []).length;
      expect(spawns).toBeGreaterThan(0); // the site does spawn a subagent
      expect(wrapped).toBeGreaterThanOrEqual(spawns); // …and every spawn is watched
    });
  }
});

describe("watchdogRoleFor — purpose → capped role", () => {
  it("maps code-writing roles to builder, review/score/rank to evaluator, designer to designer", () => {
    expect(watchdogRoleFor("builder")).toBe("builder");
    expect(watchdogRoleFor("test_author")).toBe("builder");
    expect(watchdogRoleFor("implementer")).toBe("builder");
    expect(watchdogRoleFor("attacker")).toBe("builder");
    expect(watchdogRoleFor("designer")).toBe("designer");
    expect(watchdogRoleFor("evaluator")).toBe("evaluator");
    expect(watchdogRoleFor("scorer")).toBe("evaluator");
    expect(watchdogRoleFor("peer")).toBe("evaluator");
    expect(watchdogRoleFor("pick_ranking")).toBe("evaluator");
  });
});

describe("readRoleTimeouts — config-driven caps (FIX-1249)", () => {
  it("uses the recommended scaffold caps when nothing is configured (builder 120 / evaluator 20 / designer 20)", () => {
    const t = readRoleTimeouts(tmp);
    expect(t.builder.wallSec).toBe(120 * 60);
    expect(t.evaluator.wallSec).toBe(20 * 60);
    expect(t.designer.wallSec).toBe(20 * 60);
  });

  it("reads .roll/agents.yaml watchdog.role_timeouts when present", () => {
    mkdirSync(join(tmp, ".roll"), { recursive: true });
    writeFileSync(
      join(tmp, ".roll", "agents.yaml"),
      ["watchdog:", "  role_timeouts:", "    builder:   { wall_min: 90, no_progress_min: 25, no_state_change_min: 35 }", ""].join("\n"),
    );
    const t = readRoleTimeouts(tmp);
    expect(t.builder.wallSec).toBe(90 * 60);
    expect(t.builder.noProgressSec).toBe(25 * 60);
    expect(t.builder.noStateChangeSec).toBe(35 * 60);
    // evaluator/designer still fall back to the scaffold seed.
    expect(t.evaluator.wallSec).toBe(20 * 60);
  });

  it("env override wins over config and scaffold", () => {
    process.env["ROLL_ROLE_WALL_MIN_EVALUATOR"] = "7";
    const t = readRoleTimeouts(tmp);
    expect(t.evaluator.wallSec).toBe(7 * 60);
  });

  it("a PARTIAL config that omits the mandatory wall_min is LOUD, not a silent seed fallback (codex r1)", () => {
    resetRoleTimeoutNotices();
    mkdirSync(join(tmp, ".roll"), { recursive: true });
    writeFileSync(
      join(tmp, ".roll", "agents.yaml"),
      // builder block present but wall_min OMITTED — only no_progress set.
      ["watchdog:", "  role_timeouts:", "    builder:   { no_progress_min: 22 }", ""].join("\n"),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const t = readRoleTimeouts(tmp);
    // wall falls back to the seed…
    expect(t.builder.wallSec).toBe(120 * 60);
    // …the configured no_progress is honored…
    expect(t.builder.noProgressSec).toBe(22 * 60);
    // …and the fallback was announced (loud), not silent.
    const wrote = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(wrote).toContain('role "builder"');
    expect(wrote).toContain("FIX-1249");
  });

  it("the missing-config guidance is loud and actionable (names FIX-1249 + the exact YAML)", () => {
    // (Pure content check — the runtime notice is one-shot per process.)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { roleTimeoutGuidance } = require("@roll/core");
    const g = roleTimeoutGuidance("builder") as string;
    expect(g).toContain("FIX-1249");
    expect(g).toContain("watchdog:");
    expect(g).toContain("role_timeouts:");
    expect(g).toContain("wall_min: 120");
  });
});

describe("formatSpawnKillLine — terminal-visible summary", () => {
  it("renders role/agent/model/reason/duration", () => {
    expect(formatSpawnKillLine({ role: "evaluator", agent: "kimi", model: "glm-5.2", reason: "no-state-change", durationSec: 930 })).toBe(
      "[roll] spawn:kill role=evaluator agent=kimi model=glm-5.2 reason=no-state-change duration=930s",
    );
    expect(formatSpawnKillLine({ role: "designer", agent: "pi", reason: "wall", durationSec: 1200 })).toContain("model=-");
  });
});

describe("spawnWatched — delivered path", () => {
  it("a fast productive spawn is never killed; no spawn:kill event, firedReason null", async () => {
    process.env[POLL_ENV] = "10";
    let now = 0;
    const events: RollEvent[] = [];
    const ports = stubPorts({ repoCwd: tmp, clock: () => now, events });
    const { result, firedReason } = await spawnWatched({
      ports,
      ctx: STORYLESS,
      purpose: "designer",
      agent: "pi",
      observeCwd: "/wt/run",
      run: async () => ({ timedOut: false, exitCode: 0, stdout: "ok", stderr: "" }),
    });
    expect(firedReason).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(events.find((e) => e.type === "spawn:kill")).toBeUndefined();
  });
});

describe("spawnWatched — NEGATIVE stale-kill fixture", () => {
  it("a silent subagent with static git-state is killed on its per-role cap: spawn:kill(role/model/reason/duration) + terminal line + timedOut folded", async () => {
    vi.useFakeTimers();
    // Pin the evaluator caps so the trip is deterministic: no_state_change at
    // 15min, no_progress/wall pushed out — only the state fuse can fire.
    process.env[POLL_ENV] = "10";
    process.env["ROLL_ROLE_NO_STATE_CHANGE_MIN_EVALUATOR"] = "15";
    process.env["ROLL_ROLE_NO_PROGRESS_MIN_EVALUATOR"] = "600"; // 10h — inert
    process.env["ROLL_ROLE_WALL_MIN_EVALUATOR"] = "600"; // 10h — inert
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let now = 0;
    const events: RollEvent[] = [];
    const ports = stubPorts({
      repoCwd: tmp,
      clock: () => now,
      commitCount: async () => 0, // never commits
      stateSignature: async () => "static", // never dirties
      events,
    });
    let resolveSpawn!: (v: { timedOut: boolean; exitCode: number; stdout: string; stderr: string }) => void;
    const p = spawnWatched({
      ports,
      ctx: STORYLESS,
      purpose: "evaluator",
      agent: "kimi",
      model: "glm-5.2",
      observeCwd: "/wt/run",
      run: () => new Promise((r) => (resolveSpawn = r)),
    });
    await vi.advanceTimersByTimeAsync(0); // seed baselines
    now = 16 * 60; // past the 15min no-state-change window
    await vi.advanceTimersByTimeAsync(20); // fire a tick → watchdog trips
    const kill = events.find((e) => e.type === "spawn:kill") as
      | (RollEvent & { type: "spawn:kill" })
      | undefined;
    expect(kill).toBeDefined();
    expect(kill?.role).toBe("evaluator");
    expect(kill?.agent).toBe("kimi");
    expect(kill?.model).toBe("glm-5.2");
    expect(kill?.reason).toBe("no-state-change");
    expect(kill?.durationSec).toBe(16 * 60);
    // Terminal-visible line (screenshot evidence).
    const wrote = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(wrote).toContain("spawn:kill role=evaluator");
    expect(wrote).toContain("reason=no-state-change");
    // The subagent finally exits after being killed; result carries timedOut.
    resolveSpawn({ timedOut: false, exitCode: 137, stdout: "", stderr: "" });
    const { result, firedReason } = await p;
    expect(firedReason).toBe("no-state-change");
    expect((result as { timedOut?: boolean }).timedOut).toBe(true);
  });
});

describe("spawnWatched — renewal on git-state progress", () => {
  it("emits spawn:renew when the observed cwd commits, and never kills a progressing run", async () => {
    vi.useFakeTimers();
    process.env[POLL_ENV] = "10";
    process.env["ROLL_ROLE_NO_STATE_CHANGE_MIN_BUILDER"] = "15";
    process.env["ROLL_ROLE_NO_PROGRESS_MIN_BUILDER"] = "15";
    process.env["ROLL_ROLE_WALL_MIN_BUILDER"] = "600";
    let now = 0;
    let commits = 0;
    const events: RollEvent[] = [];
    const ports = stubPorts({ repoCwd: tmp, clock: () => now, commitCount: async () => commits, events });
    let resolveSpawn!: (v: { timedOut: boolean; exitCode: number; stdout: string; stderr: string }) => void;
    const p = spawnWatched({
      ports,
      ctx: STORYLESS,
      purpose: "implementer", // builder cap
      agent: "pi",
      observeCwd: "/wt/run",
      run: () => new Promise((r) => (resolveSpawn = r)),
    });
    await vi.advanceTimersByTimeAsync(0); // seed (commits=0 baseline)
    now = 10 * 60;
    commits = 1; // a commit lands within the window → renewal
    await vi.advanceTimersByTimeAsync(20);
    now = 20 * 60;
    commits = 2; // another commit → renews again, still under the 15min fuse from last bump
    await vi.advanceTimersByTimeAsync(20);
    now = 28 * 60; // 8min since last renewal < 15 → still alive
    await vi.advanceTimersByTimeAsync(20);
    const renews = events.filter((e) => e.type === "spawn:renew");
    expect(renews.length).toBeGreaterThanOrEqual(2);
    expect((renews[0] as RollEvent & { type: "spawn:renew" }).signal).toBe("commit");
    expect(events.find((e) => e.type === "spawn:kill")).toBeUndefined();
    resolveSpawn({ timedOut: false, exitCode: 0, stdout: "done", stderr: "" });
    const { firedReason } = await p;
    expect(firedReason).toBeNull();
  });
});
