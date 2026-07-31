/**
 * US-RULE-004a — the shared pure doc-drift verdict (`checkDocDrift`) and the
 * extraction contract: `assessDocGapFromFiles` moves to lib/doc-drift.ts and
 * attest.ts keeps its behavior by calling the SAME implementation (no second
 * copy of the rules).
 */
import { describe, expect, it } from "vitest";
import {
  assessDocGapFromFiles,
  checkDocDrift,
  docDriftHitId,
  isDocAlignmentFile,
  isUserVisibleSurfaceFile,
  recordDocDriftSoftHit,
  runDocDriftSoftCheck,
} from "../src/lib/doc-drift.js";
import { parseEventLine, type DocSurface } from "@roll/spec";
import type { EventStore } from "@roll/core";

/** In-memory EventStore fake — observe append discipline without touching disk. */
function memStore(initial?: Record<string, string>): EventStore & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    files,
    exists: (p) => files.has(p),
    ensureFile: (p) => {
      if (!files.has(p)) files.set(p, "");
    },
    readText: (p) => files.get(p) ?? "",
    appendLine: (p, line) => files.set(p, (files.get(p) ?? "") + line),
    writeText: (p, data) => files.set(p, data),
    size: (p) => (files.get(p) ?? "").length,
  };
}

const DS_ATTEST: DocSurface = {
  id: "DS-ATTEST",
  paths: ["packages/core/src/attest/**", "packages/cli/src/runner/attest-gate.ts"],
  docs: ["docs/verification.md", "guide/en/acceptance-evidence.md", "guide/zh/acceptance-evidence.md"],
};

const DS_CLI: DocSurface = {
  id: "DS-CLI",
  paths: ["packages/cli/src/commands/**"],
  docs: ["docs/cli.md"],
};

describe("checkDocDrift — normalization + dedupe", () => {
  it("normalizes backslashes, ./ prefixes and whitespace before matching", () => {
    const verdict = checkDocDrift({
      changedPaths: [" .\\packages\\core\\src\\attest\\report.ts "],
      surfaces: [DS_ATTEST],
    });
    expect(verdict.hits).toEqual([
      { surfaceId: "DS-ATTEST", matchedPaths: ["packages/core/src/attest/report.ts"] },
    ]);
  });

  it("ignores duplicate inputs (first normalized occurrence wins)", () => {
    const verdict = checkDocDrift({
      changedPaths: [
        "packages/core/src/attest/report.ts",
        "./packages/core/src/attest/report.ts",
        "packages/core/src/attest/report.ts",
      ],
      surfaces: [DS_ATTEST],
    });
    expect(verdict.changedPaths).toEqual(["packages/core/src/attest/report.ts"]);
    expect(verdict.hits[0]?.matchedPaths).toEqual(["packages/core/src/attest/report.ts"]);
  });

  it("drops empty entries after normalization", () => {
    const verdict = checkDocDrift({ changedPaths: ["", "  ", "./"], surfaces: [DS_ATTEST] });
    expect(verdict.changedPaths).toEqual([]);
    expect(verdict.hits).toEqual([]);
  });
});

describe("checkDocDrift — DS-ATTEST semantics", () => {
  it("hits when a declared source path changed without any declared doc", () => {
    const verdict = checkDocDrift({
      changedPaths: ["packages/core/src/attest/report.ts"],
      surfaces: [DS_ATTEST],
    });
    expect(verdict.hits.map((h) => h.surfaceId)).toEqual(["DS-ATTEST"]);
  });

  it("hits on an exact declared source path (no glob)", () => {
    const verdict = checkDocDrift({
      changedPaths: ["packages/cli/src/runner/attest-gate.ts"],
      surfaces: [DS_ATTEST],
    });
    expect(verdict.hits.map((h) => h.surfaceId)).toEqual(["DS-ATTEST"]);
  });

  it("clears the hit when any declared documentation path changed", () => {
    const verdict = checkDocDrift({
      changedPaths: ["packages/core/src/attest/report.ts", "guide/zh/acceptance-evidence.md"],
      surfaces: [DS_ATTEST],
    });
    expect(verdict.hits).toEqual([]);
  });

  it("does not hit on unrelated paths", () => {
    const verdict = checkDocDrift({
      changedPaths: ["site/index.html", "README.md"],
      surfaces: [DS_ATTEST],
    });
    expect(verdict.hits).toEqual([]);
  });

  it("a doc path alone never produces a hit", () => {
    const verdict = checkDocDrift({
      changedPaths: ["docs/verification.md"],
      surfaces: [DS_ATTEST],
    });
    expect(verdict.hits).toEqual([]);
  });
});

describe("checkDocDrift — multi-surface verdicts", () => {
  it("reports every matched surface, in surface declaration order", () => {
    const verdict = checkDocDrift({
      changedPaths: ["packages/cli/src/commands/status.ts", "packages/core/src/attest/report.ts"],
      surfaces: [DS_CLI, DS_ATTEST],
    });
    expect(verdict.hits).toEqual([
      { surfaceId: "DS-CLI", matchedPaths: ["packages/cli/src/commands/status.ts"] },
      { surfaceId: "DS-ATTEST", matchedPaths: ["packages/core/src/attest/report.ts"] },
    ]);
  });

  it("clears only the surface whose own docs changed", () => {
    const verdict = checkDocDrift({
      changedPaths: ["packages/cli/src/commands/status.ts", "packages/core/src/attest/report.ts", "docs/cli.md"],
      surfaces: [DS_CLI, DS_ATTEST],
    });
    expect(verdict.hits.map((h) => h.surfaceId)).toEqual(["DS-ATTEST"]);
  });
});

describe("extraction contract — attest doc-gap helpers come from the shared module", () => {
  it("assessDocGapFromFiles keeps its exact behavior in the shared home", () => {
    expect(assessDocGapFromFiles(["packages/cli/src/commands/status.ts"])).toEqual({
      changedFiles: ["packages/cli/src/commands/status.ts"],
      visibleFiles: ["packages/cli/src/commands/status.ts"],
    });
    expect(assessDocGapFromFiles(["packages/cli/src/commands/status.ts", "guide/en/status.md"])).toBeUndefined();
    expect(assessDocGapFromFiles(["packages/core/src/scoring/model.ts"])).toBeUndefined();
  });

  it("surface classifiers are exported from the shared home", () => {
    expect(isDocAlignmentFile("docs/verification.md")).toBe(true);
    expect(isUserVisibleSurfaceFile("packages/spec/src/i18n/catalog-v3.ts")).toBe(true);
  });
});

describe("docDriftHitId — stable identity", () => {
  const verdict = checkDocDrift({
    changedPaths: ["packages/core/src/attest/report.ts", "packages/cli/src/commands/status.ts"],
    surfaces: [DS_CLI, DS_ATTEST],
  });

  it("is deterministic for the same cycle/story/baseline/matched-surface set", () => {
    const a = docDriftHitId({ cycleId: "c1", storyId: "US-X", baseline: "abc123", verdict });
    const b = docDriftHitId({ cycleId: "c1", storyId: "US-X", baseline: "abc123", verdict });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when cycle, story, baseline, or the matched-surface set changes", () => {
    const base = docDriftHitId({ cycleId: "c1", storyId: "US-X", baseline: "abc123", verdict });
    expect(docDriftHitId({ cycleId: "c2", storyId: "US-X", baseline: "abc123", verdict })).not.toBe(base);
    expect(docDriftHitId({ cycleId: "c1", storyId: "US-Y", baseline: "abc123", verdict })).not.toBe(base);
    expect(docDriftHitId({ cycleId: "c1", storyId: "US-X", baseline: "def456", verdict })).not.toBe(base);
    const fewer = checkDocDrift({ changedPaths: ["packages/core/src/attest/report.ts"], surfaces: [DS_ATTEST] });
    expect(docDriftHitId({ cycleId: "c1", storyId: "US-X", baseline: "abc123", verdict: fewer })).not.toBe(base);
  });

  it("does not depend on surface declaration order in the verdict", () => {
    const reordered = checkDocDrift({
      changedPaths: ["packages/core/src/attest/report.ts", "packages/cli/src/commands/status.ts"],
      surfaces: [DS_ATTEST, DS_CLI],
    });
    expect(docDriftHitId({ cycleId: "c1", storyId: "US-X", baseline: "abc123", verdict: reordered })).toBe(
      docDriftHitId({ cycleId: "c1", storyId: "US-X", baseline: "abc123", verdict }),
    );
  });
});

describe("recordDocDriftSoftHit — auditable idempotent append", () => {
  const verdict = checkDocDrift({
    changedPaths: ["packages/core/src/attest/report.ts"],
    surfaces: [DS_ATTEST],
  });
  const key = { cycleId: "c1", storyId: "US-X", baseline: "abc123", verdict };

  it("appends one doc_drift_soft_hit event and returns its stable hitId", () => {
    const store = memStore();
    const r1 = recordDocDriftSoftHit({ eventsPath: "/ev.ndjson", ...key, ts: 1_700_000_000_000, store });
    expect(r1.appended).toBe(true);
    const lines = (store.files.get("/ev.ndjson") ?? "").trim().split("\n");
    expect(lines).toHaveLength(1);
    const ev = parseEventLine(lines[0] ?? "");
    expect(ev).toMatchObject({
      type: "doc_drift_soft_hit",
      hitId: r1.hitId,
      cycleId: "c1",
      storyId: "US-X",
      baseline: "abc123",
      surfaces: ["DS-ATTEST"],
    });
  });

  it("a retry for the same hit writes NO second record", () => {
    const store = memStore();
    const r1 = recordDocDriftSoftHit({ eventsPath: "/ev.ndjson", ...key, ts: 1_700_000_000_000, store });
    const r2 = recordDocDriftSoftHit({ eventsPath: "/ev.ndjson", ...key, ts: 1_700_000_999_999, store });
    expect(r2.hitId).toBe(r1.hitId);
    expect(r2.appended).toBe(false);
    const lines = (store.files.get("/ev.ndjson") ?? "").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("writes nothing when the verdict has no hits", () => {
    const store = memStore();
    const clean = checkDocDrift({ changedPaths: ["site/index.html"], surfaces: [DS_ATTEST] });
    const r = recordDocDriftSoftHit({ eventsPath: "/ev.ndjson", ...key, verdict: clean, ts: 1, store });
    expect(r.appended).toBe(false);
    expect(store.files.get("/ev.ndjson") ?? "").toBe("");
  });

  it("append failure propagates and leaves no partial duplicate record", () => {
    const base = memStore();
    const failing: EventStore = {
      ...base,
      appendLine: () => {
        throw new Error("disk full");
      },
    };
    expect(() =>
      recordDocDriftSoftHit({ eventsPath: "/ev.ndjson", ...key, ts: 1_700_000_000_000, store: failing }),
    ).toThrow("disk full");
    // no partial line was persisted
    expect(base.files.get("/ev.ndjson") ?? "").toBe("");
  });

  it("the recorded event carries NO actor / adjudication claim", () => {
    const store = memStore();
    recordDocDriftSoftHit({ eventsPath: "/ev.ndjson", ...key, ts: 1_700_000_000_000, store });
    const raw = JSON.parse((store.files.get("/ev.ndjson") ?? "").trim()) as Record<string, unknown>;
    expect(raw["type"]).toBe("doc_drift_soft_hit");
    expect(raw).not.toHaveProperty("actor");
    expect(raw).not.toHaveProperty("verdict");
    expect(raw["type"]).not.toBe("doc_drift_adjudicated");
  });
});

describe("runDocDriftSoftCheck — soft gate observable, exit 0 (snapshot)", () => {
  const changed = ["packages/core/src/attest/report.ts", "packages/cli/src/runner/attest-gate.ts"];

  it("soft hit: exit 0 + bilingual diagnostic + recorded hit (en)", () => {
    const store = memStore();
    const r = runDocDriftSoftCheck({
      changedPaths: changed,
      surfaces: [DS_ATTEST],
      eventsPath: "/ev.ndjson",
      cycleId: "c1",
      storyId: "US-X",
      baseline: "abc123",
      lang: "en",
      ts: 1_700_000_000_000,
      store,
    });
    expect(r.exitCode).toBe(0);
    expect(r.appended).toBe(true);
    expect(r.output).toMatchSnapshot();
  });

  it("soft hit: same diagnostic in zh (locale single-language, both catalogued)", () => {
    const store = memStore();
    const r = runDocDriftSoftCheck({
      changedPaths: changed,
      surfaces: [DS_ATTEST],
      eventsPath: "/ev.ndjson",
      cycleId: "c1",
      storyId: "US-X",
      baseline: "abc123",
      lang: "zh",
      ts: 1_700_000_000_000,
      store,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatchSnapshot();
  });

  it("clean verdict: exit 0, empty output, nothing recorded", () => {
    const store = memStore();
    const r = runDocDriftSoftCheck({
      changedPaths: ["packages/core/src/attest/report.ts", "docs/verification.md"],
      surfaces: [DS_ATTEST],
      eventsPath: "/ev.ndjson",
      cycleId: "c1",
      storyId: "US-X",
      baseline: "abc123",
      lang: "en",
      ts: 1_700_000_000_000,
      store,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("");
    expect(r.appended).toBe(false);
    expect(store.files.get("/ev.ndjson") ?? "").toBe("");
  });

  it("retry reports the already-recorded hit without a second append", () => {
    const store = memStore();
    const args = {
      changedPaths: changed,
      surfaces: [DS_ATTEST],
      eventsPath: "/ev.ndjson",
      cycleId: "c1",
      storyId: "US-X",
      baseline: "abc123",
      lang: "en" as const,
      ts: 1_700_000_000_000,
      store,
    };
    const r1 = runDocDriftSoftCheck(args);
    const r2 = runDocDriftSoftCheck(args);
    expect(r2.hitId).toBe(r1.hitId);
    expect(r2.appended).toBe(false);
    expect((store.files.get("/ev.ndjson") ?? "").trim().split("\n")).toHaveLength(1);
  });

  it("without an eventsPath the verdict is still observable (no record)", () => {
    const r = runDocDriftSoftCheck({
      changedPaths: changed,
      surfaces: [DS_ATTEST],
      cycleId: "c1",
      storyId: "US-X",
      baseline: "abc123",
      lang: "en",
      ts: 1_700_000_000_000,
      store: memStore(),
    });
    expect(r.exitCode).toBe(0);
    expect(r.appended).toBe(false);
    expect(r.output).not.toBe("");
  });
});
