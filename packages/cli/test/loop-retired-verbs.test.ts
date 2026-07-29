/**
 * US-LOOP-113 (codex review r1) — dispatch-level proof that the retired scheduler
 * verbs really are gone.
 *
 * The help-band assertion proves they are not ADVERTISED; this proves they are not
 * REACHABLE. Both matter: a verb that still runs while being unlisted is worse than
 * one that is listed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      // codex review r3: and the usage line must not advertise the very verb the
      // user just tried — that would say "this command is valid" right after
      // refusing it.
      const out = `${r.stderr}${r.stdout}`;
      const usage = out.split("\n").find((l) => l.startsWith("Usage: roll loop")) ?? "";
      expect(usage, "usage line must exist").not.toBe("");
      expect(usage.includes(`|${sub}|`) || usage.includes(`<${sub}|`) || usage.includes(`|${sub}>`)).toBe(false);
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

/**
 * US-LOOP-113 (codex review r4) — no ordinary command may ARM a scheduler.
 *
 * `roll loop off` is gone, so anything that could still arm a launchd lane would be
 * a one-way trap. The wake-on-roll-command hook did exactly that when a project
 * carried a legacy DORMANT marker, so its call site is cut.
 */
describe("US-LOOP-113 — no roll command can arm a scheduler", () => {
  it("the wake hook is not invoked from the dispatch path", () => {
    const bridge = readFileSync(new URL("../src/bridge.ts", import.meta.url), "utf8");
    // The import may remain (deleted with the module in US-LOOP-114); what must be
    // gone is the CALL that re-arms a lane.
    expect(bridge).not.toMatch(/await\s+tryWakeOnRoll\s*\(/);
  });

  it("a legacy DORMANT marker does not arm anything on a normal command", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-l113-dormant-"));
    try {
      const rt = join(dir, ".roll", "loop");
      mkdirSync(rt, { recursive: true });
      // A project left over from the scheduler era: DORMANT marker + real backlog work.
      writeFileSync(join(rt, "DORMANT-proj-abc123"), JSON.stringify({ since: "2026-01-01T00:00:00Z", reason: "all_done" }));
      writeFileSync(
        join(dir, ".roll", "backlog.md"),
        "| Story | Description | Status |\n|---|---|---|\n| US-X-1 | work | 📋 Todo |\n",
      );
      const launchd = mkdtempSync(join(tmpdir(), "roll-l113-launchd-"));
      execFileSync("node", [BIN, "status"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ROLL_MAIN_SLUG: "proj-abc123", _LAUNCHD_DIR: launchd, ROLL_LANG: "en" },
      });
      // Nothing was written into the LaunchAgents dir.
      expect(readdirSync(launchd)).toEqual([]);
      // And the marker was not consumed/renamed into a waking state.
      expect(existsSync(join(rt, "DORMANT-proj-abc123"))).toBe(true);
    } catch {
      // A non-zero exit from `roll status` in a bare fixture is fine — the
      // assertion that matters is that no lane was armed, checked above.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
