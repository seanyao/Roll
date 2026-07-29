/**
 * US-LOOP-115 — DORMANT is retired on the WRITE side, readable forever.
 *
 * DORMANT existed because a launchd lane woke every 30 minutes and had to unload
 * itself once the backlog drained, so it would stop writing idle records. A
 * session-driven loop cannot idle-spin — `roll loop go` simply finishes when
 * nothing is pickable — and there is no lane to unload.
 *
 * Roll's ledgers are append-only, so historical `loop:dormant` events and
 * `dormant_entered` run rows must stay fully readable.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventLine, TERMINAL_OUTCOMES } from "@roll/spec";
import { resolveLoopRunState } from "../src/commands/loop-state.js";

function project(): string {
  const d = mkdtempSync(join(tmpdir(), "roll-l115-"));
  mkdirSync(join(d, ".roll", "loop"), { recursive: true });
  return d;
}

describe("US-LOOP-115 — the run state is two-valued", () => {
  it("resolves ACTIVE with no markers and PAUSED with a pause marker", () => {
    const d = project();
    try {
      expect(resolveLoopRunState(d, "slug-1")).toBe("ACTIVE");
      writeFileSync(join(d, ".roll", "loop", "PAUSE-slug-1"), "paused\n");
      expect(resolveLoopRunState(d, "slug-1")).toBe("PAUSED");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("a leftover DORMANT marker is INERT — never read, never an error, never deleted", () => {
    const d = project();
    try {
      const marker = join(d, ".roll", "loop", "DORMANT-slug-2");
      writeFileSync(marker, JSON.stringify({ since: "2026-01-01T00:00:00Z", reason: "all_done" }));
      // It does not change the verdict…
      expect(resolveLoopRunState(d, "slug-2")).toBe("ACTIVE");
      // …and resolving does not clean it up behind the owner's back.
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("the source declares exactly two states — no third value survives", () => {
    // codex review r1: a `@ts-expect-error` here proves nothing. Vitest transpiles
    // without typechecking and `tsc` excludes `test/`, so the assertion silently
    // degraded to `"DORMANT" === "DORMANT"`. Read the declaration instead: this
    // fails loudly if anyone widens the union again.
    const src = readFileSync(new URL("../src/commands/loop-state.ts", import.meta.url), "utf8");
    const decl = /export type LoopRunState = ([^;]+);/.exec(src);
    expect(decl, "LoopRunState declaration must exist").not.toBeNull();
    const values = (decl?.[1] ?? "")
      .split("|")
      .map((v) => v.trim().replace(/^"|"$/g, ""))
      .filter((v) => v !== "");
    expect(values.sort()).toEqual(["ACTIVE", "PAUSED"]);
    expect(values).not.toContain("DORMANT");
  });
});

describe("US-LOOP-115 — history stays readable", () => {
  it("parses a historical loop:dormant event", () => {
    const e = parseEventLine(
      JSON.stringify({ type: "loop:dormant", loop: "ci", ts: 100, reason: "all_done", since: 100 }),
    );
    expect(e).not.toBeNull();
    expect(e?.type).toBe("loop:dormant");
  });

  it("parses a historical loop:woke event", () => {
    const e = parseEventLine(
      JSON.stringify({ type: "loop:woke", loop: "ci", ts: 200, trigger: "roll-cmd", wakeEpoch: 200 }),
    );
    expect(e).not.toBeNull();
    expect(e?.type).toBe("loop:woke");
  });

  it("keeps dormant_entered in the terminal vocabulary for historical rows", () => {
    expect(TERMINAL_OUTCOMES as readonly string[]).toContain("dormant_entered");
  });
});
