/**
 * US-LOOP-112 — the operating-mode view after the guided/autonomous binary died.
 *
 * That binary's only judge was whether a launchd plist existed and was loaded, so
 * "autonomous" meant "a timer is installed" — never "Roll drives itself". With the
 * daemon lanes retired there is exactly one mode: the agent session drives, and it
 * is the Supervisor. What remains real is PAUSE.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectOperatingSlug, resolveOperatingMode } from "../src/lib/operating-mode.js";

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Write a PAUSE marker for `slug` inside `project`. */
function pause(project: string, slug: string): void {
  const rt = join(project, ".roll", "loop");
  mkdirSync(rt, { recursive: true });
  writeFileSync(join(rt, `PAUSE-${slug}`), "paused by owner\n");
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

describe("operating mode", () => {
  it("honors the explicit project slug override", () => {
    setEnv("ROLL_MAIN_SLUG", "proj-abc123");
    expect(projectOperatingSlug(tmp("roll-mode-proj-"))).toBe("proj-abc123");
  });

  it("is always session-driven — there is no second mode (US-LOOP-112)", () => {
    setEnv("ROLL_MAIN_SLUG", "proj-abc123");
    const mode = resolveOperatingMode(tmp("roll-mode-project-"));
    expect(mode.mode).toBe("session-driven");
    expect(mode.runState).toBe("active");
    expect(mode.reason).toContain("this agent session");
    // The owner is pointed at the session, never at installing a scheduler.
    expect(mode.ownerAction).toContain("roll loop go");
    expect(mode.ownerAction).not.toContain("roll loop on");
  });

  it("reports PAUSED when the pause marker is present", () => {
    setEnv("ROLL_MAIN_SLUG", "proj-abc123");
    const project = tmp("roll-mode-paused-");
    pause(project, "proj-abc123");
    const mode = resolveOperatingMode(project);
    expect(mode.mode).toBe("session-driven");
    expect(mode.runState).toBe("paused");
    expect(mode.reason).toContain("pause marker");
    // FIX-1472: a guided one-shot still runs while paused, so the action says so.
    expect(mode.ownerAction).toContain("--cards");
    expect(mode.schedulerAction).toContain("no card will be picked");
  });

  it("a pause marker for ANOTHER slug does not pause this project", () => {
    setEnv("ROLL_MAIN_SLUG", "proj-abc123");
    const project = tmp("roll-mode-otherslug-");
    pause(project, "proj-zzz999");
    expect(resolveOperatingMode(project).runState).toBe("active");
  });

  it("no longer consults launchd at all (US-LOOP-112)", () => {
    setEnv("ROLL_MAIN_SLUG", "proj-abc123");
    const project = tmp("roll-mode-nolaunchd-");
    const probed: string[] = [];
    const mode = resolveOperatingMode(project, {
      probe: (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(mode.mode).toBe("session-driven");
    // The ONLY path probed is the pause marker — no LaunchAgents, no plist.
    expect(probed).toHaveLength(1);
    expect(probed[0]).toContain("PAUSE-proj-abc123");
    expect(probed.some((p) => p.includes("LaunchAgents") || p.endsWith(".plist"))).toBe(false);
  });

  it("carries no install-state axis — a plist can no longer change the verdict", () => {
    setEnv("ROLL_MAIN_SLUG", "proj-abc123");
    const view = resolveOperatingMode(tmp("roll-mode-noinstall-")) as unknown as Record<string, unknown>;
    expect(view["installState"]).toBeUndefined();
    expect(Object.keys(view).sort()).toEqual(
      ["mode", "ownerAction", "reason", "runState", "schedulerAction", "slug"].sort(),
    );
  });
});
