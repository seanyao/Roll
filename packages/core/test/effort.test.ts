/**
 * US-PAIR-013 — the effort table. One table expresses both axes: which gates run
 * (review strength) and how far each gate's reviewer must be (isolation).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_EFFORT, enabledEffortGates, parseEffort } from "../src/agent/effort.js";

describe("US-PAIR-013 — defaults never silently disable review", () => {
  it("absent effort → standard (both gates, heterogeneous)", () => {
    expect(parseEffort(undefined).effort).toEqual({ code: "vendor", score: "vendor" });
    expect(parseEffort(null).effort).toEqual(DEFAULT_EFFORT);
  });

  it("turning review off must be typed out explicitly", () => {
    // The failure mode this guards: a typo'd key or an omitted section quietly
    // meaning "no review at all".
    expect(parseEffort({ code: "banana" }).effort.code).toBe("vendor");
    expect(parseEffort({ code: "banana" }).errors[0]).toContain('invalid tier "banana"');
    expect(parseEffort("off").effort).toEqual({ code: "off", score: "off" });
  });
});

describe("US-PAIR-013 — presets and per-gate config", () => {
  it("expands the three presets", () => {
    expect(parseEffort("standard").effort).toEqual({ code: "vendor", score: "vendor" });
    expect(parseEffort("light").effort).toEqual({ code: "vendor", score: "off" });
    expect(parseEffort("off").effort).toEqual({ code: "off", score: "off" });
  });

  it("accepts a per-gate map", () => {
    expect(parseEffort({ code: "vendor", score: "model" }).effort).toEqual({ code: "vendor", score: "model" });
  });

  it("a per-gate entry overrides the preset it sits on", () => {
    const { effort, errors } = parseEffort({ preset: "light", score: "model" });
    expect(errors).toEqual([]);
    expect(effort).toEqual({ code: "vendor", score: "model" });
  });

  it("rejects an unknown preset without falling to off", () => {
    const { effort, errors } = parseEffort("thorough");
    expect(errors[0]).toContain('unknown preset "thorough"');
    expect(effort).toEqual(DEFAULT_EFFORT);
  });
});

describe("US-PAIR-013 — gates that have no production path are rejected", () => {
  it("configuring design/test/cycle is a loud error, not a silent no-op", () => {
    // These are PairingStage members with no live path: the scoped config
    // hardcodes ["code","score"]. Accepting them would let someone believe a gate
    // is enabled while it never runs.
    for (const gate of ["design", "test", "cycle"]) {
      const { errors } = parseEffort({ [gate]: "vendor" });
      expect(errors.join(" "), gate).toContain("has no production path");
    }
  });

  it("rejects a plainly unknown gate name", () => {
    expect(parseEffort({ nonsense: "vendor" }).errors[0]).toContain("unknown gate");
  });

  it("rejects a non-map, non-string node", () => {
    expect(parseEffort([1, 2]).errors[0]).toContain("expected a preset name or a map");
  });
});

describe("US-PAIR-013 — review strength is derived, not a separate dial", () => {
  it("enabled gates are exactly the non-off ones", () => {
    expect(enabledEffortGates({ code: "vendor", score: "vendor" })).toEqual(["code", "score"]);
    expect(enabledEffortGates({ code: "vendor", score: "off" })).toEqual(["code"]);
    expect(enabledEffortGates({ code: "off", score: "off" })).toEqual([]);
  });
});

describe("US-PAIR-013 — effort reaches the real agents.yaml parse", () => {
  it("an absent effort section normalizes to standard", async () => {
    const { normalizeAgentConfig } = await import("../src/agent/config-v4.js");
    const { config, errors } = normalizeAgentConfig("schema: roll-agents/v1\nscope: project\n");
    expect(errors).toEqual([]);
    expect(config.effort).toEqual({ code: "vendor", score: "vendor" });
  });

  it("a preset in the file is expanded", async () => {
    const { normalizeAgentConfig } = await import("../src/agent/config-v4.js");
    const { config } = normalizeAgentConfig("schema: roll-agents/v1\neffort: light\n");
    expect(config.effort).toEqual({ code: "vendor", score: "off" });
  });

  it("a bad effort value is a fail-loud error, not a silent 'off'", async () => {
    const { normalizeAgentConfig } = await import("../src/agent/config-v4.js");
    const { config, errors } = normalizeAgentConfig("schema: roll-agents/v1\neffort: thorough\n");
    expect(errors.join(" ")).toContain('unknown preset "thorough"');
    expect(config.effort, "must not degrade to off").toEqual({ code: "vendor", score: "vendor" });
  });
});
