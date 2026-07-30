/**
 * FIX-930 — per-story agent-rotation budget + the zero-TCR auto-switch decision.
 * The budget store uses an injected tmp runtime dir (real fs, isolated); the
 * switch decision uses a stub RouteDeps + captured emit/remarkTodo (no real
 * spawn, no real clock).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RouteDeps } from "@roll/core";
import type { RollEvent } from "@roll/spec";
import {
  SELFHEAL_AGENT_BUDGET,
  autoRecoverEnabled,
  clearSelfHeal,
  readSelfHeal,
  recordSelfHealAttempt,
  selfHealBudget,
} from "../src/runner/selfheal-budget.js";
import { maybeSwitchAgent } from "../src/runner/selfheal-switch.js";

let rt: string;
beforeEach(() => {
  rt = mkdtempSync(join(tmpdir(), "roll-selfheal-"));
});
afterEach(() => {
  rmSync(rt, { recursive: true, force: true });
});

/** Stub RouteDeps with the narrowed kimi/pi/reasonix roster (hard→pi, default→kimi, fallback→reasonix). */
function roster(): RouteDeps {
  const slots: Record<string, string> = { hard: "pi", default: "kimi", fallback: "reasonix" };
  return { readSlot: (s) => (slots[s] !== undefined ? { agent: slots[s]! } : undefined), firstInstalled: () => "pi" };
}

describe("FIX-930 selfheal-budget store", () => {
  it("an absent story reads a fresh zero-attempt entry", () => {
    expect(readSelfHeal(rt, "FIX-X")).toEqual({ attempts: 0, triedAgents: [], lastReason: "" });
  });

  it("recordSelfHealAttempt bumps attempts, dedupes the tried-set, stamps reason, persists", () => {
    const a = recordSelfHealAttempt(rt, "FIX-X", "pi", "zero-tcr");
    expect(a).toEqual({ attempts: 1, triedAgents: ["pi"], lastReason: "zero-tcr" });
    const b = recordSelfHealAttempt(rt, "FIX-X", "kimi", "stall");
    expect(b).toEqual({ attempts: 2, triedAgents: ["pi", "kimi"], lastReason: "stall" });
    // re-recording the same agent dedupes the tried-set but still counts the attempt.
    const c = recordSelfHealAttempt(rt, "FIX-X", "pi", "zero-tcr");
    expect(c.triedAgents).toEqual(["pi", "kimi"]);
    expect(c.attempts).toBe(3);
    // a fresh read sees the persisted state.
    expect(readSelfHeal(rt, "FIX-X").attempts).toBe(3);
  });

  it("clearSelfHeal drops the story (genuine delivery resets the budget)", () => {
    recordSelfHealAttempt(rt, "FIX-X", "pi", "zero-tcr");
    clearSelfHeal(rt, "FIX-X");
    expect(readSelfHeal(rt, "FIX-X")).toEqual({ attempts: 0, triedAgents: [], lastReason: "" });
  });

  it("selfHealBudget defaults to SELFHEAL_AGENT_BUDGET, honours ROLL_LOOP_AGENT_RETRY_MAX", () => {
    expect(selfHealBudget({})).toBe(SELFHEAL_AGENT_BUDGET);
    expect(selfHealBudget({ ROLL_LOOP_AGENT_RETRY_MAX: "4" })).toBe(4);
    expect(selfHealBudget({ ROLL_LOOP_AGENT_RETRY_MAX: "0" })).toBe(0);
    expect(selfHealBudget({ ROLL_LOOP_AGENT_RETRY_MAX: "junk" })).toBe(SELFHEAL_AGENT_BUDGET);
  });

  it("FIX-932: autoRecoverEnabled defaults on; ROLL_LOOP_NO_AUTO_RECOVER=1 disables the chain", () => {
    expect(autoRecoverEnabled({})).toBe(true);
    expect(autoRecoverEnabled({ ROLL_LOOP_NO_AUTO_RECOVER: "1" })).toBe(false);
    expect(autoRecoverEnabled({ ROLL_LOOP_NO_AUTO_RECOVER: "0" })).toBe(true);
    expect(autoRecoverEnabled({ ROLL_LOOP_NO_AUTO_RECOVER: "" })).toBe(true);
  });
});

describe("FIX-930 maybeSwitchAgent — zero-TCR auto-switch decision", () => {
  function run(over: Partial<Parameters<typeof maybeSwitchAgent>[0]> = {}): {
    swapped: boolean;
    events: RollEvent[];
    remarked: string[];
  } {
    const events: RollEvent[] = [];
    const remarked: string[] = [];
    const swapped = maybeSwitchAgent({
      runtimeDir: rt,
      storyId: "FIX-930",
      failedAgent: "pi",
      reason: "zero-tcr",
      estMin: 25, // hard tier
      routeDeps: roster(),
      budget: 2,
      cycleId: "c1",
      now: () => 1_700_000_000,
      emit: (ev) => events.push(ev),
      remarkTodo: (s) => remarked.push(s),
      ...over,
    });
    return { swapped, events, remarked };
  }

  it("budget remaining + fresh agent → records attempt, re-marks Todo, emits agent:retry, returns true", () => {
    const { swapped, events, remarked } = run();
    expect(swapped).toBe(true);
    expect(remarked).toEqual(["FIX-930"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent:retry",
      cycleId: "c1",
      storyId: "FIX-930",
      fromAgent: "pi",
      toAgent: "kimi", // hard tier, pi excluded → default slot kimi
      attempt: 1,
      reason: "zero-tcr",
    });
    expect(readSelfHeal(rt, "FIX-930").triedAgents).toContain("pi");
  });

  it("second swap excludes both pi + kimi → routes reasonix (fallback slot)", () => {
    recordSelfHealAttempt(rt, "FIX-930", "pi", "zero-tcr"); // pi already tried
    const { swapped, events } = run({ failedAgent: "kimi" });
    expect(swapped).toBe(true);
    expect(events[0]).toMatchObject({ toAgent: "reasonix", attempt: 2 });
  });

  it("budget exhausted (attempts >= budget) → no swap, no event", () => {
    recordSelfHealAttempt(rt, "FIX-930", "pi", "zero-tcr");
    recordSelfHealAttempt(rt, "FIX-930", "kimi", "zero-tcr"); // attempts now 2 == budget
    const { swapped, events, remarked } = run({ failedAgent: "reasonix" });
    expect(swapped).toBe(false);
    expect(events).toHaveLength(0);
    expect(remarked).toHaveLength(0);
  });

  it("roster exhausted (every agent tried) → no swap even with budget left", () => {
    // budget 5 but the 3-rig roster is fully excluded → graceful stop, no ping-pong.
    recordSelfHealAttempt(rt, "FIX-930", "pi", "zero-tcr");
    recordSelfHealAttempt(rt, "FIX-930", "kimi", "zero-tcr");
    const { swapped } = run({ failedAgent: "reasonix", budget: 5 });
    expect(swapped).toBe(false);
  });

  it("empty storyId / failedAgent → no-op false", () => {
    expect(run({ storyId: "" }).swapped).toBe(false);
    expect(run({ failedAgent: "" }).swapped).toBe(false);
  });

  it("stall reason is threaded onto the event", () => {
    const { events } = run({ reason: "stall" });
    expect(events[0]).toMatchObject({ reason: "stall" });
  });
});
