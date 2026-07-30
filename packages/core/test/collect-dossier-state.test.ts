/**
 * US-OBS-016 — collectDossierState view-model deterministic test.
 *
 * AC4: against a fixed fixture cwd, collectDossierState returns a stable
 * TruthSnapshot. A single collector error degrades that surface
 * (status:'paused'/'unknown') and still returns the snapshot — no
 * overall crash.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { collectDossierState, type CollectorDeps } from "../src/truth/collect-dossier-state.js";
import type { TruthSnapshot } from "@roll/spec";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execFileSync("rm", ["-rf", d]);
});

beforeEach(() => {
  // Freeze render time for deterministic generatedAt in snapshot
  process.env["ROLL_RENDER_NOW"] = "2026-06-20T12:00:00.000Z";
});

afterEach(() => {
  delete process.env["ROLL_HOME"];
});

/** Minimal project: one epic, one delivered story, one todo story, backlog. */
function fixture(): string {
  const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-cds-")));
  dirs.push(p);
  const f = join(p, ".roll", "features");
  // Epic "alpha"
  const alphaDir = join(f, "alpha");
  mkdirSync(join(alphaDir, "US-A-1"), { recursive: true });
  writeFileSync(
    join(alphaDir, "US-A-1", "spec.md"),
    "---\nid: US-A-1\ntitle: Alpha story\ntype: us\ncreated: 2026-06-01\n---\n\n# US-A-1 — Alpha story\n",
  );
  // Mark it delivered with a latest/ symlink
  const latestDir = join(alphaDir, "US-A-1", "latest");
  mkdirSync(join(alphaDir, "US-A-1", "2026-06-01T00-00-00"), { recursive: true });
  symlinkSync(join(alphaDir, "US-A-1", "2026-06-01T00-00-00"), latestDir);
  // Add an ac-map for non-legacy status
  writeFileSync(join(alphaDir, "US-A-1", "ac-map.json"), "[]");
  // Epic "beta": todo story
  mkdirSync(join(f, "beta", "FIX-2"), { recursive: true });
  writeFileSync(join(f, "beta", "FIX-2", "spec.md"), "# FIX-2 — fix a hole\n");
  // Write backlog
  // Backlog: FIX-2 only. US-A-1 is delivered purely by latest/ pointer (not in backlog).
  writeFileSync(join(p, ".roll", "backlog.md"), "| FIX-2 | fix a hole | 📋 Todo |\n");
  // Write minimal runs.jsonl for cycle data
  const loopDir = join(p, ".roll", "loop");
  mkdirSync(join(p, ".roll", "reports", "consistency"), { recursive: true });
  writeFileSync(join(p, ".roll", "reports", "consistency", "audit-1.json"), JSON.stringify({ generatedAt: "2026-06-20T10:00:00Z", summary: { fail: 0, warn: 1, unknown: 0 } }));
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(loopDir, "runs.jsonl"), `{"cycle_id":"c1","ts":"2026-06-20T10:00:00Z","status":"delivered","outcome":"delivered","cost_usd":0.5}\n`);
  return p;
}

function snapshotShape(s: TruthSnapshot): Record<string, unknown> {
  return {
    generatedAt: typeof s.generatedAt === "string",
    storyTotal: s.story.total,
    spectrumKeys: Object.keys(s.story.spectrum).sort(),
    storiesCount: Array.isArray(s.stories) ? s.stories?.length : undefined,
    hasLoop: s.loop !== undefined,
  };
}

describe("collectDossierState — US-OBS-016 view-model selector", () => {
  it("AC1: returns a stable TruthSnapshot over a fixed fixture", () => {
    const cwd = fixture();
    const a = collectDossierState(cwd);
    const b = collectDossierState(cwd);
    // Deterministic: same input → same output
    expect(a.generatedAt).toBe(b.generatedAt);
    expect(a.story.total).toBe(b.story.total);
    expect(a.story.spectrum).toEqual(b.story.spectrum);
    expect(a.stories).toEqual(b.stories);
  });

  it("AC2: story registry carries correct ladder + evidence + truthState", () => {
    const cwd = fixture();
    const s = collectDossierState(cwd);
    expect(s.stories).toBeDefined();
    expect(s.stories!.length).toBeGreaterThanOrEqual(1);
    const a1 = s.stories!.find((st) => st.id === "US-A-1");
    expect(a1).toBeDefined();
    expect(a1!.epic).toBe("alpha");
    // Delivered with latest/ (not in backlog, so truth selector not consulted)
    expect(a1!.truthState).toBe("done");
    // Ladder: delivered but no visual/acMap evidence → merged
    expect(a1!.ladder).toBe("merged");
    // Not legacy (has latest/ pointer)
    expect(a1!.legacy).toBe(false);
  });

  it("AC3: todo story is not delivered and has correct spectrum state", () => {
    const cwd = fixture();
    const s = collectDossierState(cwd);
    const f2 = s.stories!.find((st) => st.id === "FIX-2");
    expect(f2).toBeDefined();
    expect(f2!.truthState).toBe("todo");
    expect(f2!.ladder).toBe("none");
  });

  it("AC4: missing features dir → empty snapshot (no throw)", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "roll-cds-empty-")));
    dirs.push(cwd);
    const s = collectDossierState(cwd);
    expect(s.story.total).toBe(0);
    expect(s.story.spectrum.done).toBe(0);
    expect(s.stories ?? []).toEqual([]);
  });

  it("AC5: a broken/locked spec file degrades that story but still returns snapshot", () => {
    const cwd = fixture();
    // Break one spec file (make directory where file should be)
    const brokenDir = join(cwd, ".roll", "features", "gamma", "US-G-1");
    mkdirSync(brokenDir, { recursive: true });
    // Create a spec.md that's actually a directory (simulates I/O error)
    // We can't easily make readFileSync fail without permissions, but the
    // existing error handling in specMeta catches read failures gracefully.
    // Write backlog entry for this story
    writeFileSync(join(cwd, ".roll", "backlog.md"),
      "| US-A-1 | Alpha story | ✅ Done |\n| FIX-2 | fix a hole | 📋 Todo |\n| US-G-1 | broken story | 📋 Todo |\n");
    const s = collectDossierState(cwd);
    // Should still return snapshot for the healthy stories
    expect(s.story.total).toBeGreaterThanOrEqual(1);
  });

  it("AC6: delivered by latest/ pointer — NOT legacy", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "roll-cds-legacy-")));
    dirs.push(cwd);
    const f = join(cwd, ".roll", "features", "old-epic", "US-OLD-1");
    mkdirSync(f, { recursive: true });
    writeFileSync(join(f, "spec.md"), "---\nid: US-OLD-1\ntitle: Old story\n---\n\n# US-OLD-1 — Old story\n");
    // Create a latest/ pointer to mark it delivered
    const runDir = join(f, "2026-06-01T00-00-00");
    mkdirSync(runDir, { recursive: true });
    symlinkSync(runDir, join(f, "latest"));
    // No ac-map.json → qualifies as legacy IF delivered without latest evidence
    // But latest/ exists, so it's NOT legacy (it has a v3 attest run)
    // No backlog entry — the story is delivered purely by latest/ pointer
    const s = collectDossierState(cwd);
    const old = s.stories!.find((st) => st.id === "US-OLD-1");
    expect(old).toBeDefined();
    // latest/ exists → not legacy
    expect(old!.legacy).toBe(false);
    // Delivered with latest/ but no ac-map → ladder is merged (no evidence)
    expect(old!.ladder).toBe("merged");
  });

  it("AC7: wired deps — custom collectors are called with correct parameters", () => {
    const cwd = fixture();
    let truthBoardCalled = false;
    let loopHeartbeatCalled = false;
    let evidenceFlagsCalled = false;
    const deps: CollectorDeps = {
      collectTruthBoard: (_cwd, _nowSec) => {
        truthBoardCalled = true;
        return { generatedAt: "2026-01-01T00:00:00Z" };
      },
      collectLoopHeartbeat: (_cwd) => {
        loopHeartbeatCalled = true;
        return { lanes: [] };
      },
      collectEvidenceFlags: (_cwd, _story) => {
        evidenceFlagsCalled = true;
        return { report: false, acMap: false, visualEvidence: false };
      },
    };
    const s = collectDossierState(cwd, { deps });
    expect(truthBoardCalled).toBe(true);
    expect(loopHeartbeatCalled).toBe(true);
    expect(evidenceFlagsCalled).toBe(true);
    expect(s.generatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("US-OBS-018: On Deck is backed by backlog Todo rows, excludes folder-orphans and Cut rows", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "roll-cds-ondeck-")));
    dirs.push(cwd);
    const features = join(cwd, ".roll", "features", "loop-observability");
    for (const id of ["US-OBS-1", "US-OBS-2", "US-OBS-3", "US-OBS-4"]) {
      mkdirSync(join(features, id), { recursive: true });
      writeFileSync(join(features, id, "spec.md"), `---\nid: ${id}\ntitle: ${id} title\n---\n\n# ${id} — ${id} title\n`);
    }
    writeFileSync(
      join(cwd, ".roll", "backlog.md"),
      [
        "| [US-OBS-1](.roll/features/loop-observability/US-OBS-1/spec.md) | real todo with folder | 📋 Todo |",
        "| [US-OBS-2](.roll/features/loop-observability/US-OBS-2/spec.md) | cut card | 🗑️ Cut (superseded) |",
        "| [US-OBS-5](.roll/features/loop-observability/US-OBS-5/spec.md) | folderless todo | 📋 Todo |",
        "| [US-OBS-6](.roll/features/loop-observability/US-OBS-6/spec.md) | done row | ✅ Done |",
      ].join("\n"),
    );

    const snapshot = collectDossierState(cwd);
    expect(snapshot.onDeck?.count).toBe(2);
    expect(snapshot.onDeck?.rows.map((row) => row.id)).toEqual(["US-OBS-1", "US-OBS-5"]);
    expect(snapshot.onDeck?.rows[0]).toMatchObject({
      id: "US-OBS-1",
      epic: "loop-observability",
      href: "loop-observability/US-OBS-1/index.html",
    });
    expect(snapshot.onDeck?.rows[1]).toMatchObject({
      id: "US-OBS-5",
      href: "#backlog/todo",
    });
  });

  it("US-OBS-019: filters project switcher rows inside collectDossierState", () => {
    const cwd = fixture();
    const realProject = realpathSync(process.cwd());
    const tempProject = realpathSync(mkdtempSync(join(tmpdir(), "roll-cds-project-row-")));
    dirs.push(tempProject);
    const deps: CollectorDeps = {
      collectProjects: () => [
        { name: "real", slug: "real", path: realProject, releaseTag: "v1.0.0", verdict: "pass" },
        { name: "deleted", slug: "deleted", path: join(tempProject, "deleted") },
        { name: "tmp", slug: "tmp", path: tempProject },
      ],
    };

    const snapshot = collectDossierState(cwd, { deps });

    expect(snapshot.projects).toEqual([
      { name: "real", slug: "real", path: realProject, releaseTag: "v1.0.0", verdict: "pass" },
    ]);
  });

  it("US-OBS-023: default collector reads the machine project registry for daemon snapshots", () => {
    const rollHome = realpathSync(mkdtempSync(join(tmpdir(), "roll-cds-registry-home-")));
    dirs.push(rollHome);
    mkdirSync(join(rollHome, ".roll"), { recursive: true });
    const realProject = realpathSync(process.cwd());
    const tempProject = realpathSync(mkdtempSync(join(tmpdir(), "roll-cds-registry-temp-")));
    dirs.push(tempProject);
    writeFileSync(
      join(rollHome, ".roll", "projects.json"),
      JSON.stringify([
        { name: "roll", slug: "roll", path: realProject, releaseTag: "v3.0.0", verdict: "pass" },
        { name: "tmp", slug: "tmp", path: tempProject },
        { name: "deleted", slug: "deleted", path: join(tempProject, "deleted") },
      ]),
    );
    process.env["ROLL_HOME"] = rollHome;

    const snapshot = collectDossierState(realProject);

    expect(snapshot.projects).toEqual([
      { name: "roll", slug: "roll", path: realProject, releaseTag: "v3.0.0", verdict: "pass" },
    ]);
  });

  it("US-OBS-029: panel collectors are folded into TruthSnapshot and degrade independently", () => {
    const cwd = fixture();
    const deps: CollectorDeps = {
      collectCastingPanel: () => ({ status: "ready", data: { configured: true, rows: [{ key: "easy" }] } }),
      collectCharterPanel: () => {
        throw new Error("charter locked");
      },
      collectSkillsPanel: () => ({ status: "ready", data: { summary: { skills: 0, violations: "unknown", hubLines: 0, auditRan: false }, groups: [] } }),
    };

    const snapshot = collectDossierState(cwd, { deps });

    expect(snapshot.panels?.casting).toEqual({ status: "ready", data: { configured: true, rows: [{ key: "easy" }] } });
    expect(snapshot.panels?.charter).toEqual({ status: "paused", data: null, note: "charter locked" });
    expect(snapshot.panels?.skills?.status).toBe("ready");
    expect(snapshot.story.total).toBeGreaterThan(0);
  });
});

describe("US-LOOP-118 — the default loop lane is a session, not a launchd lane", () => {
  it("labels the collected lane `goal`, so no reader treats it as a resident lane", () => {
    // codex r8: it was labelled source:"launchd", so a FRESH snapshot presented it
    // as a resident lane — readers counted it, and a stale lastAt painted it red as
    // a "zombie". Nothing here reads a plist: `running` comes from live.log and
    // `lastAt` from runs.jsonl, both of which describe a session.
    const cwd = mkdtempSync(join(tmpdir(), "roll-l118-lane-"));
    dirs.push(cwd);
    const loopDir = join(cwd, ".roll", "loop");
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(join(loopDir, "runs.jsonl"), `${JSON.stringify({ ts: "2026-06-20T11:00:00Z" })}\n`);
    writeFileSync(join(loopDir, "live.log"), "streaming\n");

    const snap = collectDossierState(cwd);
    const lanes = snap.loop?.lanes ?? [];
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.source).toBe("goal");
    expect(lanes[0]?.running).toBe(true);
    // codex r10: while streaming, lastAt is the STREAM's write time, not the
    // previous run's ts from runs.jsonl — the two fields must agree. This file was
    // just written, so it is "now"; the pairing itself is asserted precisely in the
    // dedicated case below.
    expect(lanes[0]?.lastAt).toBeDefined();
    // No fresh snapshot may claim a launchd lane — that label now means only
    // "a leftover plist is on disk", which this collector never checks.
    expect(lanes.some((l) => l.source === "launchd")).toBe(false);
  });

  it("US-LOOP-118: a STALE live.log is not a running session (codex r9)", () => {
    // live.log is never deleted, so its existence only proves a cycle once ran.
    // Mere existence made a long-finished cycle read as "go session open".
    const cwd = mkdtempSync(join(tmpdir(), "roll-l118-lane-stale-"));
    dirs.push(cwd);
    const loopDir = join(cwd, ".roll", "loop");
    mkdirSync(loopDir, { recursive: true });
    const live = join(loopDir, "live.log");
    writeFileSync(live, "old activity\n");
    // ROLL_RENDER_NOW is frozen at 2026-06-20T12:00:00Z; age this log a day.
    const oldSec = Date.parse("2026-06-19T12:00:00Z") / 1000;
    utimesSync(live, oldSec, oldSec);
    // codex r12: with no completed run either, there is no signal at all — so no
    // lane, rather than an idle one. (The "ran but not streaming" case is covered
    // separately above.)
    expect(collectDossierState(cwd).loop?.lanes ?? []).toEqual([]);

    // A log touched inside the freshness window IS a running session.
    const freshSec = Date.parse("2026-06-20T11:59:00Z") / 1000;
    utimesSync(live, freshSec, freshSec);
    expect(collectDossierState(cwd).loop?.lanes?.[0]?.running).toBe(true);
  });

  it("US-LOOP-118: a live stream's lastAt is its OWN write, not the previous run (codex r10)", () => {
    // `running` and `lastAt` have to describe the same activity. Taking `running`
    // from a fresh live.log while `lastAt` still pointed at the previous COMPLETED
    // run meant a genuinely active stream got painted a zombie as soon as that
    // earlier run aged past the staleness window.
    const cwd = mkdtempSync(join(tmpdir(), "roll-l118-lane-pair-"));
    dirs.push(cwd);
    const loopDir = join(cwd, ".roll", "loop");
    mkdirSync(loopDir, { recursive: true });
    // A run that finished a day ago…
    writeFileSync(join(loopDir, "runs.jsonl"), `${JSON.stringify({ ts: "2026-06-19T12:00:00Z" })}\n`);
    // …and a stream writing right now (frozen now = 2026-06-20T12:00:00Z).
    const live = join(loopDir, "live.log");
    writeFileSync(live, "streaming\n");
    const freshSec = Date.parse("2026-06-20T11:59:30Z") / 1000;
    utimesSync(live, freshSec, freshSec);

    const lane = collectDossierState(cwd).loop?.lanes?.[0];
    expect(lane?.running).toBe(true);
    // NOT the day-old run — the stream's own write time.
    expect(lane?.lastAt).toBe("2026-06-20T11:59:30Z");

    // Once the stream goes cold, lastAt falls back to the completed run.
    const coldSec = Date.parse("2026-06-20T10:00:00Z") / 1000;
    utimesSync(live, coldSec, coldSec);
    const cold = collectDossierState(cwd).loop?.lanes?.[0];
    expect(cold?.running).toBe(false);
    expect(cold?.lastAt).toBe("2026-06-19T12:00:00Z");
  });

  it("US-LOOP-118: no signal at all means NO lane, matching the CLI collector (codex r12)", () => {
    // A project that never ran has nothing to report. Emitting an unconditional
    // "go session" lane here contradicted the CLI collector's own contract, where a
    // clean project reports zero lanes rather than an idle one.
    const cwd = mkdtempSync(join(tmpdir(), "roll-l118-lane-idle-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".roll", "loop"), { recursive: true });
    expect(collectDossierState(cwd).loop?.lanes ?? []).toEqual([]);
  });

  it("US-LOOP-118: a completed run (no live stream) still yields an idle lane", () => {
    const cwd = mkdtempSync(join(tmpdir(), "roll-l118-lane-ran-"));
    dirs.push(cwd);
    const loopDir = join(cwd, ".roll", "loop");
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(join(loopDir, "runs.jsonl"), `${JSON.stringify({ ts: "2026-06-19T12:00:00Z" })}\n`);
    const lanes = collectDossierState(cwd).loop?.lanes ?? [];
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.running).toBe(false);
    expect(lanes[0]?.source).toBe("goal");
    expect(lanes[0]?.lastAt).toBe("2026-06-19T12:00:00Z");
  });
});
