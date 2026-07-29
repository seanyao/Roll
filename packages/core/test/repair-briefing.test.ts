/**
 * US-CYCLE-007 — repair-round warm-start briefing.
 *
 * Covers the ACs of the pure packaging builder:
 *  - AC1: the briefing contains the evaluator findings + git diff --stat +
 *    involved files:lines + design-contract references, and its sha256 matches the
 *    v2 artifact-protocol digest scheme (validated via `validateDeltaManifest`).
 *  - AC2: the briefing LEADS with the explicit "start from these findings; do NOT
 *    re-explore the whole repository" instruction.
 *  - AC3: a context-budget cap TRUNCATES over-budget content with an EXPLICIT,
 *    traceable strategy declared in the header (what was cut + where the full text
 *    lives); the briefing never exceeds the budget.
 *  - AC4: fixture — one round of findings → briefing generated → content + sha
 *    asserted; budget truncation explicit + traceable when over budget.
 */
import { describe, expect, it } from "vitest";
import {
  buildRepairBriefing,
  buildRepairBriefingManifest,
  DEFAULT_REPAIR_BRIEFING_MAX_CHARS,
  MIN_REPAIR_BRIEFING_MAX_CHARS,
  parseInvolvedFilesFromDiff,
  REPAIR_BRIEFING_INSTRUCTION,
  repairBriefingArtifactRef,
  type RepairBriefingInput,
} from "../src/cycle/repair-briefing.js";
import { computeArtifactSha256, validateDeltaManifest } from "../src/delta-team/artifact-protocol.js";

const FINDINGS = [
  "## Inputs checked",
  "- eval-report.md, ac-map.json",
  "",
  "## Rationale",
  "AC2 has no regression test for the truncation path; the digest is computed but never asserted.",
].join("\n");

const DIFF_STAT = [
  " packages/core/src/cycle/repair-briefing.ts | 120 +++++++++",
  " packages/core/test/repair-briefing.test.ts |  40 +++",
  " 2 files changed, 160 insertions(+)",
].join("\n");

const BASE_INPUT: RepairBriefingInput = {
  storyId: "US-CYCLE-007",
  round: 1,
  findings: FINDINGS,
  diffStat: DIFF_STAT,
  involvedFiles: [
    { path: "packages/core/src/cycle/repair-briefing.ts", lines: [12, "40-52"] },
    { path: "packages/core/test/repair-briefing.test.ts", lines: [1] },
  ],
  contractRefs: [
    ".roll/features/cycle-efficiency/US-CYCLE-007/spec.md",
    ".roll/features/cycle-efficiency/cycle-efficiency-plan.md",
  ],
  fullFindingsPath: "/evidence/role-artifacts/evaluator/eval-report.md",
};

describe("buildRepairBriefing — content (AC1/AC2)", () => {
  it("leads with the explicit warm-start instruction (AC2)", () => {
    const b = buildRepairBriefing(BASE_INPUT);
    // Header line, then a blank line, then the instruction — it precedes all sections.
    expect(b.content).toContain(REPAIR_BRIEFING_INSTRUCTION);
    expect(b.content.indexOf(REPAIR_BRIEFING_INSTRUCTION)).toBeLessThan(b.content.indexOf("## Evaluator findings"));
    expect(REPAIR_BRIEFING_INSTRUCTION.toLowerCase()).toContain("do not re-explore");
  });

  it("packs findings + diff-stat + files:lines + contract refs (AC1)", () => {
    const b = buildRepairBriefing(BASE_INPUT);
    // Findings full text.
    expect(b.content).toContain("AC2 has no regression test for the truncation path");
    // git diff --stat.
    expect(b.content).toContain("2 files changed, 160 insertions(+)");
    // Involved files WITH line numbers.
    expect(b.content).toContain("- packages/core/src/cycle/repair-briefing.ts:12,40-52");
    expect(b.content).toContain("- packages/core/test/repair-briefing.test.ts:1");
    // Design-contract references.
    expect(b.content).toContain("- .roll/features/cycle-efficiency/US-CYCLE-007/spec.md");
    expect(b.content).toContain("- .roll/features/cycle-efficiency/cycle-efficiency-plan.md");
  });

  it("sha256 matches the content digest and is not truncated when in budget", () => {
    const b = buildRepairBriefing(BASE_INPUT);
    expect(b.truncated).toBe(false);
    expect(b.truncation).toBeUndefined();
    expect(b.sha256).toBe(computeArtifactSha256(b.content));
    expect(b.bytes).toBe(Buffer.byteLength(b.content, "utf8"));
  });

  it("is deterministic (same input → same content + sha)", () => {
    const a = buildRepairBriefing(BASE_INPUT);
    const b = buildRepairBriefing(BASE_INPUT);
    expect(a.content).toBe(b.content);
    expect(a.sha256).toBe(b.sha256);
  });
});

describe("buildRepairBriefing — context budget (AC3)", () => {
  it("truncates findings over budget with an explicit, traceable header declaration", () => {
    const huge = "X".repeat(5000);
    const input: RepairBriefingInput = { ...BASE_INPUT, findings: `${FINDINGS}\n${huge}` };
    // Budget large enough for the fixed frame + some findings, but far below the
    // full 5KB findings → the findings section is the truncation target.
    const budget = { maxChars: 2500 };
    const b = buildRepairBriefing(input, budget);

    // Never exceeds the budget — the briefing can't become a context-bloat source.
    expect(b.content.length).toBeLessThanOrEqual(budget.maxChars);
    // Truncation is EXPLICIT + traceable.
    expect(b.truncated).toBe(true);
    expect(b.truncation).toBeDefined();
    expect(b.truncation?.section).toBe("findings");
    expect(b.truncation?.totalChars).toBe(input.findings.length);
    expect(b.truncation?.keptChars).toBeLessThan(input.findings.length);
    expect(b.truncation?.fullTextPath).toBe(input.fullFindingsPath);
    // Declared IN THE HEADER: what was cut + where the full text lives.
    expect(b.content).toContain("CONTEXT-BUDGET TRUNCATION");
    expect(b.content).toContain(input.fullFindingsPath);
    // The in-body marker also points to the full source.
    expect(b.content).toContain(`full text at ${input.fullFindingsPath}`);
    // The head of the findings is still present (it's a warm-start, not a wipe).
    expect(b.content).toContain("## Inputs checked");
    // sha still matches the (truncated) content.
    expect(b.sha256).toBe(computeArtifactSha256(b.content));
  });

  it("hard-caps the BODY (never the header) when the fixed frame exceeds the budget", () => {
    // At the floor budget the header (instruction + declaration) fits but the fixed
    // diff-stat/files/contract frame does not → the BODY is hard-capped.
    const b = buildRepairBriefing(BASE_INPUT, { maxChars: MIN_REPAIR_BRIEFING_MAX_CHARS });
    expect(b.content.length).toBeLessThanOrEqual(MIN_REPAIR_BRIEFING_MAX_CHARS);
    expect(b.truncated).toBe(true);
    expect(b.truncation?.section).toBe("whole");
    // The truncation declaration (with the full-text path) survives in the header.
    expect(b.content).toContain("CONTEXT-BUDGET TRUNCATION");
    expect(b.content).toContain(BASE_INPUT.fullFindingsPath);
    // The header (title + instruction + declaration) is intact and leads the content.
    expect(b.content.startsWith(`# Repair briefing — ${BASE_INPUT.storyId}`)).toBe(true);
    expect(b.content).toContain(REPAIR_BRIEFING_INSTRUCTION);
    // Body was truncated with a pointer to the full findings.
    expect(b.content).toContain(`full findings at ${BASE_INPUT.fullFindingsPath}`);
    expect(b.sha256).toBe(computeArtifactSha256(b.content));
  });

  it("boundary: tiny/zero maxChars keeps the header + declaration intact (never a sliced header)", () => {
    for (const maxChars of [0, 1, 50, 300]) {
      const b = buildRepairBriefing(BASE_INPUT, { maxChars });
      // Clamped UP to the floor — a valid header-bearing briefing, never a fragment.
      expect(b.truncated).toBe(true);
      expect(b.content.length).toBeLessThanOrEqual(MIN_REPAIR_BRIEFING_MAX_CHARS);
      // Header invariant: title + instruction + explicit traceable declaration all present.
      expect(b.content.startsWith(`# Repair briefing — ${BASE_INPUT.storyId}`)).toBe(true);
      expect(b.content).toContain(REPAIR_BRIEFING_INSTRUCTION);
      expect(b.content).toContain("CONTEXT-BUDGET TRUNCATION");
      expect(b.content).toContain(BASE_INPUT.fullFindingsPath);
      // The declaration must appear WITHIN the surviving content, not be sliced off.
      const declIdx = b.content.indexOf("CONTEXT-BUDGET TRUNCATION");
      expect(declIdx).toBeGreaterThan(0);
      expect(b.content.slice(declIdx)).toContain(BASE_INPUT.fullFindingsPath);
      expect(b.sha256).toBe(computeArtifactSha256(b.content));
    }
  });

  it("uses the default budget when none is supplied", () => {
    const b = buildRepairBriefing(BASE_INPUT);
    expect(b.content.length).toBeLessThanOrEqual(DEFAULT_REPAIR_BRIEFING_MAX_CHARS);
  });
});

describe("buildRepairBriefingManifest — v2 digest discipline (AC1)", () => {
  it("records the briefing as a v2 manifest output whose sha256 the protocol validates", () => {
    const briefing = buildRepairBriefing(BASE_INPUT);
    const artifactPath = "role-artifacts/repair-briefing/briefing.md";
    const manifest = buildRepairBriefingManifest({
      storyId: "US-CYCLE-007",
      cycleId: "cycle-1",
      delegationId: "cycle-1",
      hostId: "host-a",
      roleInstanceId: "cycle-1:repair-briefing:pi",
      modelId: "glm-5.2",
      sessionId: "cycle-1:repair-briefing:1000",
      adapter: "pi",
      qualityProfile: "verified",
      artifactPath,
      briefing,
      createdAt: "2026-07-24T00:00:00Z",
    });

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.outputs).toHaveLength(1);
    expect(manifest.outputs[0]?.sha256).toBe(briefing.sha256);
    expect(manifest.outputs[0]?.sha256).toBe(computeArtifactSha256(briefing.content));

    // The SAME v2 protocol machinery validates it (no parallel digest scheme).
    const res = validateDeltaManifest(manifest, {
      contains: () => true,
      readBytes: (p) => (p === artifactPath ? briefing.content : null),
    });
    expect(res.ok).toBe(true);
  });

  it("a tampered briefing body fails the protocol digest check", () => {
    const briefing = buildRepairBriefing(BASE_INPUT);
    const artifactPath = "role-artifacts/repair-briefing/briefing.md";
    const manifest = buildRepairBriefingManifest({
      storyId: "US-CYCLE-007",
      delegationId: "cycle-1",
      hostId: "host-a",
      roleInstanceId: "cycle-1:repair-briefing:pi",
      modelId: "glm-5.2",
      sessionId: "cycle-1:repair-briefing:1000",
      adapter: "pi",
      qualityProfile: "verified",
      artifactPath,
      briefing,
      createdAt: "2026-07-24T00:00:00Z",
    });
    const res = validateDeltaManifest(manifest, {
      contains: () => true,
      readBytes: () => `${briefing.content} tampered`,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("artifact_invalid");
  });

  it("repairBriefingArtifactRef carries the report kind + sha", () => {
    const briefing = buildRepairBriefing(BASE_INPUT);
    const ref = repairBriefingArtifactRef("x/briefing.md", briefing);
    expect(ref).toEqual({ path: "x/briefing.md", sha256: briefing.sha256, kind: "report" });
  });
});

describe("parseInvolvedFilesFromDiff", () => {
  it("extracts new-side line ranges per file from unified diff hunk headers", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,0 +11,3 @@",
      "+added",
      "@@ -40,2 +43 @@",
      "+one",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1,2 @@",
      "+new file",
    ].join("\n");
    expect(parseInvolvedFilesFromDiff(diff)).toEqual([
      { path: "src/a.ts", lines: ["11-13", "43"] },
      { path: "src/b.ts", lines: ["1-2"] },
    ]);
  });

  it("ignores deleted files (+++ /dev/null) and tolerates empty diffs", () => {
    expect(parseInvolvedFilesFromDiff("")).toEqual([]);
    const diff = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,3 +0,0 @@"].join("\n");
    expect(parseInvolvedFilesFromDiff(diff)).toEqual([]);
  });
});
