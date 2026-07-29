/**
 * US-LOOP-113 (codex review r1) — dispatch-level proof that the retired scheduler
 * verbs really are gone.
 *
 * The help-band assertion proves they are not ADVERTISED; this proves they are not
 * REACHABLE. Both matter: a verb that still runs while being unlisted is worse than
 * one that is listed.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/roll.js", import.meta.url));

function runLoop(sub: string): { code: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync("node", [BIN, "loop", sub], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ROLL_LANG: "en" },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("US-LOOP-113 — retired scheduler verbs are unreachable", () => {
  for (const sub of ["on", "off", "now", "fallback"]) {
    it(`roll loop ${sub} → unknown subcommand, non-zero`, () => {
      const r = runLoop(sub);
      expect(r.code).not.toBe(0);
      expect(`${r.stderr}${r.stdout}`.toLowerCase()).toContain("unknown loop subcommand");
      // No stub message: the owner ruled against tombstones, so the output must be
      // the generic unknown-subcommand path, not a bespoke "retired" notice.
      expect(`${r.stderr}${r.stdout}`.toLowerCase()).not.toContain("retired");
    });
  }

  // PAUSE is a live gate with an AUTOMATIC writer (the correction circuit breaker),
  // so these two must keep working — otherwise a paused project has no exit.
  for (const sub of ["pause", "resume"]) {
    it(`roll loop ${sub} is still reachable`, () => {
      const r = runLoop(sub);
      expect(`${r.stderr}${r.stdout}`.toLowerCase()).not.toContain("unknown loop subcommand");
    });
  }
});
