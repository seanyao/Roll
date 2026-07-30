/**
 * US-DOSSIER-035 — `roll status` verdict-first truth summary (design frame 1).
 *
 * Leads with a verdict line + four tab-aligned lines (LOOP/CYCLE/RELEASE/STORY)
 * in the web Now tab's name/order; the STORY line's attest coverage + counts
 * are read from the SAME snapshot the web reads (no recompute). EN/中 snapshots.
 */
import { describe, expect, it } from "vitest";
import { LEFTOVER_LANE_STATUS } from "@roll/spec";
import type { TruthSnapshot } from "@roll/spec";
import { renderTruthSummary, statusTruthJson } from "../src/commands/status.js";
import { attestCoverage, snapshotVerdict } from "../src/lib/truth-read.js";
import { stripAnsi } from "../src/render.js";

function snap(overrides: Partial<TruthSnapshot> = {}): TruthSnapshot {
  return {
    generatedAt: "2026-06-13T08:30:00Z",
    collectedAt: "2026-06-12T03:09:03Z",
    story: { total: 580, spectrum: { done: 366, wip: 0, hold: 0, todo: 7, fail: 0, unknown: 197 }, legacy: 366 },
    audit: { fail: 0, warn: 44, unknown: 78 },
    cycle: { cycles3d: 17, failed3d: 12, costUsd3d: 0.59 },
    release: { latestTag: "v3.611.2", verdict: "pass" },
    loop: {
      // US-LOOP-118: everyMin/nextAt are deliberately still here — this is an
      // OLD snapshot shape and it must keep parsing. They are simply not shown.
      lanes: [
        { name: "backlog loop (leftover lane)", source: "launchd", running: false, mode: "backlog", status: LEFTOVER_LANE_STATUS, everyMin: 30, nextAt: "2026-06-13T08:55:00Z" },
        { name: "go session", source: "goal", running: true, mode: "go", status: "active", scope: "all" },
      ],
    },
    stories: [
      { id: "A", epic: "e", ladder: "attested", evidence: { report: true, acMap: true, visualEvidence: true }, truthState: "done", legacy: false },
      { id: "B", epic: "e", ladder: "attested", evidence: { report: true, acMap: true, visualEvidence: true }, truthState: "done", legacy: false },
      { id: "C", epic: "e", ladder: "merged", evidence: { report: false, acMap: false, visualEvidence: false }, truthState: "done", legacy: false },
    ],
    ...overrides,
  };
}

const NOW = Date.parse("2026-06-13T08:32:00Z");
const sum = (s: TruthSnapshot | undefined, lang: "en" | "zh", stale = false): string =>
  stripAnsi(renderTruthSummary(s, stale, lang, NOW));

describe("roll status truth summary — US-DOSSIER-035", () => {
  it("AC3: verdict line first, with the exit-code intent", () => {
    const out = sum(snap(), "en");
    const first = out.trimStart().split("\n")[0] ?? "";
    expect(first).toContain("WARN"); // audit.warn>0 → WARN, same table as web
    expect(first).toContain("main reconciled vs backlog");
    expect(first).toContain("exit 1");
  });

  it("AC3: four tab-aligned lines in the web Now order LOOP→CYCLE→RELEASE→STORY", () => {
    const out = sum(snap(), "en");
    const iLoop = out.indexOf("LOOP");
    const iCycle = out.indexOf("CYCLE");
    const iRelease = out.indexOf("RELEASE");
    const iStory = out.indexOf("STORY");
    expect(iLoop).toBeGreaterThan(-1);
    expect(iLoop).toBeLessThan(iCycle);
    expect(iCycle).toBeLessThan(iRelease);
    expect(iRelease).toBeLessThan(iStory);
    // each line summarizes its snapshot fields
    // US-LOOP-118: the LOOP line no longer counts lanes or predicts a next fire —
    // it says whether a session is driving, and warns about leftover lanes.
    expect(out).toMatch(/LOOP\s+session-driven · go session open/);
    expect(out).toContain("1 leftover lane(s)");
    expect(out).not.toContain("loops ·");
    expect(out).toMatch(/CYCLE\s+17 \/ 3d   12 failed · \$0\.59/);
    expect(out).toMatch(/RELEASE\s+v3\.611\.2 staged   pass · f:0 w:44 \?:78/);
  });

  it("AC4: STORY line shows attest coverage % + fail + unknown from the snapshot (no recompute)", () => {
    const s = snap();
    const cov = attestCoverage(s); // 2 attested / 3 = 67%
    expect(cov.pct).toBe(67);
    const out = sum(s, "en");
    expect(out).toMatch(new RegExp(`STORY\\s+${cov.pct}% attest coverage`));
    expect(out).toContain(`fail ${s.story.spectrum.fail}`);
    expect(out).toContain(`unknown ${s.story.spectrum.unknown}`);
  });

  it("AC4: the verdict word table matches the web selector exactly", () => {
    expect(snapshotVerdict(snap({ audit: { fail: 0, warn: 0, unknown: 0 } }))).toBe("pass");
    expect(snapshotVerdict(snap({ audit: { fail: 1, warn: 9, unknown: 9 } }))).toBe("fail");
    expect(snapshotVerdict(snap({ audit: undefined }))).toBe("unknown");
  });

  it("AC2/AC3: a missing snapshot falls back honestly — no undefined, points at roll index", () => {
    const out = sum(undefined, "en");
    expect(out).toContain("no truth snapshot");
    expect(out).toContain("roll index");
    expect(out).not.toContain("undefined");
  });

  /**
   * US-LOOP-118 AC5 — a historical snapshot must not break the reader.
   *
   * Snapshots written before this epic carry things that are never written again:
   * `runState: "DORMANT"`, lanes with `running: true` for a launchd plist, and
   * `everyMin`/`nextAt`. `roll status` has to keep rendering all of it.
   */
  it("US-LOOP-118: an OLD snapshot's launchd lanes are not miscounted as leftovers", () => {
    // Caught by running `roll status` for real: the machine had NO com.roll.*
    // plists, yet the line said "3 leftover lane(s)". A pre-US-LOOP-118 snapshot
    // lists every retired lane whether or not a plist exists, so counting by
    // `source === "launchd"` invents debris. The count keys on the marker the new
    // collector writes instead.
    const oldShape = snap({
      loop: {
        lanes: [
          { name: "backlog loop", source: "launchd", running: false, mode: "backlog" },
          { name: "PR loop", source: "launchd", running: false, mode: "pr" },
          { name: "Dream loop", source: "launchd", running: false, mode: "dream" },
        ],
      },
    });
    expect(sum(oldShape, "en")).not.toContain("leftover lane");

    // A lane the NEW collector wrote carries the marker and IS counted.
    const fresh = snap({
      loop: {
        lanes: [
          { name: "backlog loop (leftover lane)", source: "launchd", running: false, mode: "backlog", status: LEFTOVER_LANE_STATUS },
        ],
      },
    });
    expect(sum(fresh, "en")).toContain("1 leftover lane(s)");
  });

  it("US-LOOP-118: a historical DORMANT snapshot still renders a LOOP line", () => {
    const historical = snap({
      loop: {
        runState: "DORMANT",
        stateSince: "2026-06-25T03:00:00Z",
        stateReason: "idle 6h, no Todo",
        lanes: [
          { name: "loop", source: "launchd", running: true, mode: "cron", everyMin: 30, nextAt: "2026-06-13T08:55:00Z" },
          { name: "dream", source: "launchd", running: false, mode: "nightly", everyMin: 1440 },
        ],
      },
    });
    const en = sum(historical, "en");
    // It renders, and does not crash or leak `undefined` into the line.
    expect(en).toMatch(/LOOP\s+\S/);
    expect(en).not.toContain("undefined");
    // DORMANT is not PAUSED, so the reader must not claim the owner paused it.
    expect(en).not.toContain("roll loop resume");
    // And those old lanes carry no leftover marker, so they are NOT counted as
    // debris — the snapshot listed them unconditionally, not because a plist
    // existed. (See the miscount regression above.)
    expect(en).not.toContain("leftover lane");
  });

  it("AC6: EN/中 snapshots (single-language per locale, color scrubbed)", () => {
    expect(sum(snap(), "en")).toMatchSnapshot();
    expect(sum(snap(), "zh")).toMatchSnapshot();
  });
});

// US-DOSSIER-036 --json (AC5/AC7): the machine view reads the SAME snapshot +
// selectors the human summary reads — a divergence is a 口径 bug.
describe("roll status --json — US-DOSSIER-036", () => {
  interface StatusJson {
    verdict: string; exit: number; snapshot: boolean; stale: boolean;
    loop: { sessionsDriving: number; leftoverLanes: number };
    cycle: { cycles3d: number; failed3d: number; costUsd3d: number } | null;
    release: { latestTag: string | null; verdict: string; fail: number | null; warn: number | null; unknown: number | null; merged: number; pending: number } | null;
    story: { attestCoveragePct: number; fail: number; done: number; unknown: number; todo: number };
  }

  it("AC7: --json verdict/exit/loop/cycle/release/story match the human summary", () => {
    const s = snap();
    const human = sum(s, "en");
    const j = statusTruthJson(s, false) as StatusJson;
    // Same verdict word + exit intent the human first line carries (WARN, exit 1).
    expect(j.verdict).toBe(snapshotVerdict(s));
    expect(j.exit).toBe(1);
    expect(human.trimStart().split("\n")[0]).toContain("exit 1");
    // LOOP/CYCLE/RELEASE numbers identical to the rendered lines.
    // US-LOOP-118 (codex r6): was `{ lanes: 2, running: 1 }` — a retired-lane count
    // in which an old snapshot's `running: true` launchd row inflated "running".
    // The machine view mirrors the human LOOP line: session driving + debris.
    expect(j.loop).toEqual({ sessionsDriving: 1, leftoverLanes: 1 });
    // 口径 parity: the human line says the same two things.
    expect(human).toContain("go session open");
    expect(human).toContain("1 leftover lane(s)");
    expect(j.cycle).toEqual({ cycles3d: 17, failed3d: 12, costUsd3d: 0.59 });
    expect(j.release?.fail).toBe(0);
    expect(j.release?.warn).toBe(44);
    expect(j.release?.unknown).toBe(78);
    expect(j.release?.merged).toBe(366);
    expect(j.release?.pending).toBe(580 - 366);
    // STORY attest coverage equals the same selector the human STORY line uses.
    expect(j.story.attestCoveragePct).toBe(attestCoverage(s).pct);
  });

  it("AC6: a missing snapshot reports unknown honestly, never fabricates a verdict", () => {
    const j = statusTruthJson(undefined, false) as StatusJson;
    expect(j.verdict).toBe("unknown");
    expect(j.snapshot).toBe(false);
  });
});
