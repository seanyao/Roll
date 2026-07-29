/**
 * REFACTOR-056 — the command-surface truth source contract.
 *
 * Proves the typed registry and the `roll --help` projection agree: the public
 * list is exactly the approved set, it drives help (not ported-command
 * enumeration), and the registry itself is internally consistent + fails loud on
 * malformed decisions. Behavior migration is explicitly out of scope here — these
 * tests guard the truth source and the help list only.
 */
import { describe, expect, it } from "vitest";
import {
  COMMAND_SURFACE,
  commandDecision,
  publicCommands,
  validateCommandSurface,
  type CommandSurfaceDecision,
} from "../src/lib/command-surface.js";
import { dispatch, isPorted, usage } from "../src/bridge.js";
import { registerAll } from "../src/index.js";

/** AC2: the approved public top-level command set, in display order. */
const APPROVED_PUBLIC = [
  "agent", "backlog", "config", "delivery", "design", "doctor", "help", "idea",
  "init", "loop", "next", "north", "release", "setup", "status", "test", "workspace", "update",
];

describe("REFACTOR-056 — command-surface registry truth source", () => {
  it("AC1: classifies every command into public / nested / internal / remove", () => {
    const dispositions = new Set(COMMAND_SURFACE.map((d) => d.disposition));
    for (const d of ["public", "nested", "internal", "remove"]) {
      expect(dispositions, `registry must include a '${d}' decision`).toContain(d);
    }
  });

  it("AC2: the public list is exactly the approved top-level set, in order", () => {
    expect(publicCommands()).toEqual(APPROVED_PUBLIC);
  });

  it("registry order is the display order (public block leads)", () => {
    const publicIndices = COMMAND_SURFACE
      .map((d, i) => ({ d, i }))
      .filter((x) => x.d.disposition === "public")
      .map((x) => x.i);
    // public decisions occupy a contiguous leading block
    expect(publicIndices).toEqual(publicIndices.map((_, i) => i));
  });

  it("public decisions own themselves and target a human audience", () => {
    for (const d of COMMAND_SURFACE.filter((x) => x.disposition === "public")) {
      expect(d.owner, `${d.current} owner`).toBe(d.current);
      expect(d.audience, `${d.current} audience`).toBe("human");
      expect(d.target, `${d.current} should not redirect`).toBeUndefined();
    }
  });

  it("nested decisions declare a target under a different owner", () => {
    for (const d of COMMAND_SURFACE.filter((x) => x.disposition === "nested")) {
      expect(d.target, `${d.current} target`).toBeTruthy();
      expect(d.owner, `${d.current} owner`).not.toBe(d.current);
      // the owner is itself an approved public command
      expect(APPROVED_PUBLIC, `${d.current} owner must be public`).toContain(d.owner);
    }
  });

  it("every owner is one of the approved public commands", () => {
    for (const d of COMMAND_SURFACE) {
      expect(APPROVED_PUBLIC, `${d.current} owner '${d.owner}'`).toContain(d.owner);
    }
  });

  it("has no duplicate `current` surfaces", () => {
    const names = COMMAND_SURFACE.map((d) => d.current);
    expect(new Set(names).size).toBe(names.length);
  });

  it("commandDecision looks up by current surface", () => {
    expect(commandDecision("prices")?.disposition).toBe("nested");
    expect(commandDecision("prices")?.target).toBe("config prices");
    expect(commandDecision("nope")).toBeUndefined();
  });
});

describe("REFACTOR-056 — validateCommandSurface fails loud", () => {
  const base: CommandSurfaceDecision = {
    current: "x", owner: "status", audience: "human", disposition: "nested",
    target: "status x", rationale: "t",
  };

  it("rejects duplicate current names", () => {
    expect(() => validateCommandSurface([base, { ...base }])).toThrow(/duplicate/);
  });

  it("rejects a public command that does not own itself", () => {
    expect(() =>
      validateCommandSurface([{ current: "status", owner: "loop", audience: "human", disposition: "public", rationale: "t" }]),
    ).toThrow(/own itself/);
  });

  it("rejects a nested command with no target", () => {
    expect(() =>
      validateCommandSurface([{ current: "x", owner: "status", audience: "human", disposition: "nested", rationale: "t" }]),
    ).toThrow(/must declare a target/);
  });

  it("rejects an alias that collides with any canonical command", () => {
    expect(() => validateCommandSurface([
      { current: "workspace", aliases: ["ws"], owner: "workspace", audience: "human", disposition: "public", rationale: "t" },
      { current: "ws", owner: "status", audience: "human", disposition: "nested", target: "status ws", rationale: "t" },
    ])).toThrow(/duplicate alias/);
  });

  it("accepts the shipped registry", () => {
    expect(() => validateCommandSurface(COMMAND_SURFACE)).not.toThrow();
  });
});

describe("REFACTOR-056 — registry ↔ `roll --help` agree", () => {
  it("AC2/AC3: help lists exactly the public set, generated from the registry", () => {
    const listed = (usage().split("Commands:")[1] ?? "").split("\n")[0]?.trim() ?? "";
    expect(listed).toBe(APPROVED_PUBLIC.join(", "));
  });

  it("AC4: every public command appears in help; no non-public command leaks in", () => {
    const listed = usage().split("Commands:")[1] ?? "";
    for (const c of publicCommands()) {
      expect(listed, `public ${c} must be in help`).toMatch(new RegExp(`\\b${c}\\b`));
    }
    for (const d of COMMAND_SURFACE.filter((x) => x.disposition !== "public")) {
      expect(listed, `non-public ${d.current} must NOT leak into help`).not.toMatch(new RegExp(`\\b${d.current}\\b`));
    }
  });

  it("every public command (besides the bridge-special `help`) is actually implemented", () => {
    // "unimplemented decisions must fail loud": a public decision with no live
    // handler is a contradiction. `help` is handled centrally by the bridge
    // (not a ported handler), so it is the sole exemption.
    registerAll();
    for (const c of publicCommands()) {
      if (c === "help") continue;
      expect(isPorted(c), `public command ${c} must be registered`).toBe(true);
    }
  });

  it("REFACTOR-058: removed top-level aliases no longer execute old behavior", async () => {
    registerAll();
    for (const c of ["prices", "cast", "tool", "pulse", "cycles", "tune", "showcase", "offboard"]) {
      expect(isPorted(c), `${c} retired stub is registered for drift detection`).toBe(true);
      const res = await dispatch([c, "--help"]);
      expect(res.status, `${c} should return normal unknown behavior`).toBe(1);
    }
  });
});
