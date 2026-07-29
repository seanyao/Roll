/**
 * FIX-234 (zombie lanes) + FIX-247 (stranded gate-killed work).
 *
 * 234: three retired launchd jobs (ci/alert/brief) pointed at an old repo +
 *      deleted engine for weeks — `loop off` now sweeps EVERY com.roll.*.<slug>
 *      lane, and `roll doctor` lists every lane with its target + load state.
 * 247: a gate-killed cycle with real commits (e8ad8c0, cycle 233535) was
 *      stranded in a local worktree — now the branch is pushed for audit and
 *      the alert names it; reuse is deliberately NOT automatic (I12 fresh
 *      context — rescue is a human decision on an auditable branch).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cycleStep, initialCycleState, type CycleContext, type CycleEvent } from "@roll/core";
import { lanesSection } from "../src/commands/doctor.js";
import { launchAgentsDir, listRollLaneLabels } from "../src/commands/loop-state.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});
function tmp(tag: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `roll-lanes-${tag}-`)));
  dirs.push(d);
  return d;
}

function plist(dir: string, label: string, wd: string): void {
  writeFileSync(
    join(dir, `${label}.plist`),
    `<plist><dict><key>WorkingDirectory</key>\n<string>${wd}</string>\n</dict></plist>`,
  );
}

describe("FIX-234 — lane inventory", () => {
  it("listRollLaneLabels finds every com.roll.*.<slug> plist (zombie shapes included)", () => {
    const d = tmp("la");
    const prev = process.env["_LAUNCHD_DIR"];
    process.env["_LAUNCHD_DIR"] = d;
    try {
      plist(d, "com.roll.loop.proj-abc", "/x");
      plist(d, "com.roll.ci.proj-abc", "/old/deleted/repo"); // the zombie shape
      plist(d, "com.roll.loop.OTHER-slug", "/y"); // another project — untouched
      expect(launchAgentsDir()).toBe(d);
      expect(listRollLaneLabels("proj-abc")).toEqual(["com.roll.ci.proj-abc", "com.roll.loop.proj-abc"]);
    } finally {
      if (prev === undefined) delete process.env["_LAUNCHD_DIR"];
      else process.env["_LAUNCHD_DIR"] = prev;
    }
  });

  it("doctor lanes section lists every lane with target + load state; stale lanes red ✗", () => {
    if (process.platform !== "darwin") return;
    const d = tmp("doc");
    const live = tmp("live-wd");
    const prev = process.env["_LAUNCHD_DIR"];
    process.env["_LAUNCHD_DIR"] = d;
    plist(d, "com.roll.loop.s1", live);
    plist(d, "com.roll.brief.s1", "/gone/forever");
    let lines: string[];
    try {
      lines = lanesSection("en", { lastExit: (label) => (label.includes("brief") ? null : 0) });
    } finally {
      if (prev === undefined) delete process.env["_LAUNCHD_DIR"];
      else process.env["_LAUNCHD_DIR"] = prev;
    }
    const text = lines.join("\n");
    expect(text).toContain("com.roll.loop.s1");
    expect(text).toContain("last exit 0");
    expect(text).toMatch(/✗ com\.roll\.brief\.s1.*not loaded/);
    expect(text).toContain("STALE lane");
  });
});

describe("FIX-247 — gate-killed work is pushed, listed, and deliberately not auto-reused", () => {
  const CTX: CycleContext = { cycleId: "C-247", branch: "loop/cycle-C-247", loop: "ci" as never, storyId: "FIX-X", agent: "pi" };

  function walkToCapture(commitsAhead: number): { kinds: string[]; alerts: string[] } {
    let state = initialCycleState(CTX);
    const kinds: string[] = [];
    const alerts: string[] = [];
    const events: CycleEvent[] = [
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "FIX-X" },
      { type: "route_resolved", agent: "pi", model: "" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead } },
    ];
    for (const e of events) {
      const r = cycleStep(state, e);
      state = r.state;
      for (const c of r.commands) {
        kinds.push(c.kind);
        if (c.kind === "append_alert") alerts.push(c.message);
      }
    }
    return { kinds, alerts };
  }

  it("non-zero exit WITH commits → built → publish_pr (not push_orphan)", () => {
    // Agent exits ≠0 but produced real work → built → enters publish ladder.
    const { kinds } = walkToCapture(3);
    expect(kinds).toContain("publish_pr");
    expect(kinds).not.toContain("push_orphan");
  });

  it("non-zero exit with ZERO commits → failed, pushes nothing", () => {
    const { kinds } = walkToCapture(0);
    expect(kinds).not.toContain("push_orphan");
    expect(kinds).not.toContain("publish_pr");
  });
});
