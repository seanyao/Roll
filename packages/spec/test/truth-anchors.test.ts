/**
 * US-TRUTH-000 — Truth Source Declaration.
 *
 * The drift epidemic (FIX-243/244/248/249, the 6/10 all-cycles-dead day) is not
 * a read-side bug: multiple sources write AND interpret the same fact. Before
 * any selector/audit/gate exists, every persistent fact field must declare its
 * single authoritative source, writer, derived views, and how conflicts and
 * unknowns arbitrate. This test makes the declaration MECHANICAL — the matrix
 * lives in code (packages/spec/src/types/truth.ts), referenced by the epic doc
 * (.roll/features/feedback-truth-alignment/truth-anchors.md), so it cannot rot
 * as prose.
 */
import { describe, expect, it } from "vitest";
import {
  CROSS_REPO_ARBITRATION_ORDER,
  TRUTH_ANCHORS,
  truthAnchor,
  type TruthAnchor,
} from "../src/index.js";

/** AC1 — the fields the declaration must cover, by exact registry key. */
const REQUIRED_FIELDS = [
  "story_delivery",
  "cycle_outcome",
  "pr_merge",
  "tcr_evidence",
  "attest_evidence",
  "usage_cost",
  "dossier_freshness",
  "index_freshness",
  "release_verdict",
  "release_waiver",
  "goal_state",
] as const;

const EXPECTED_AGGREGATES = {
  story: ["story_delivery", "attest_evidence", "browser_run", "browser_lease", "browser_diagnostic", "browser_capture_link"],
  cycle: ["cycle_outcome", "pr_merge", "tcr_evidence", "usage_cost"],
  release: ["release_verdict", "release_waiver"],
  "view-meta": ["dossier_freshness", "index_freshness"],
  goal: ["goal_state"],
  delegation: ["delegation_lifecycle", "delegation_provenance"],
  execution: ["managed_workspace_lifecycle"],
} as const;

describe("US-TRUTH-000 AC1 — the matrix covers every drift-prone fact field", () => {
  it("declares all required fields (and only known shapes)", () => {
    const keys = TRUTH_ANCHORS.map((a) => a.field);
    for (const f of REQUIRED_FIELDS) expect(keys).toContain(f);
    expect(new Set(keys).size).toBe(keys.length); // one anchor per field — no double declaration
  });

  it("truthAnchor() resolves a field, throws on an undeclared one", () => {
    expect(truthAnchor("story_delivery").authoritativeSource).toBeTruthy();
    expect(() => truthAnchor("not_a_field")).toThrow(/undeclared/i);
  });
});

describe("US-TRUTH-007 — every anchor declares its owning aggregate", () => {
  it("uses only legal aggregate names; see .roll/domain/truth-model.md", () => {
    const legal = Object.keys(EXPECTED_AGGREGATES);
    for (const anchor of TRUTH_ANCHORS) {
      expect(legal, `${anchor.field}: aggregate must match .roll/domain/truth-model.md`).toContain(anchor.aggregate);
    }
  });

  it("matches the Story/Cycle/Release/view-meta ownership model", () => {
    for (const [aggregate, fields] of Object.entries(EXPECTED_AGGREGATES)) {
      const actual = TRUTH_ANCHORS.filter((a) => a.aggregate === aggregate).map((a) => a.field).sort();
      expect(actual, `${aggregate}: update .roll/domain/truth-model.md and truth-anchors.md when changing ownership`).toEqual(
        [...fields].sort(),
      );
    }
  });
});

describe("US-TRUTH-000 AC2 — every anchor carries the six declaration attributes", () => {
  for (const anchor of TRUTH_ANCHORS as readonly TruthAnchor[]) {
    it(`${anchor.field}: authoritative_source/writer/derived_views/conflict_policy/unknown_policy/rebuildability`, () => {
      expect(anchor.authoritativeSource.length).toBeGreaterThan(0);
      expect(anchor.writer.length).toBeGreaterThan(0);
      expect(Array.isArray(anchor.derivedViews)).toBe(true);
      expect(anchor.conflictPolicy.length).toBeGreaterThan(10); // a real rule, not a stub
      expect(anchor.unknownPolicy.length).toBeGreaterThan(10);
      expect(["rebuildable", "append-only", "external"]).toContain(anchor.rebuildability);
    });
  }
});

describe("US-TRUTH-000 AC3 — cross-repo arbitration order is declared", () => {
  it("GitHub PR merge evidence outranks product main, which outranks roll-meta views", () => {
    expect(CROSS_REPO_ARBITRATION_ORDER).toEqual(["github_pr_merge", "product_main", "roll_meta"]);
  });
});

describe("US-TRUTH-000 AC4 — temporal grace windows make 'unknown' legal, not fail", () => {
  it("anchors with async convergence declare a grace window in seconds", () => {
    for (const field of ["pr_merge", "story_delivery", "dossier_freshness", "usage_cost"]) {
      const a = truthAnchor(field);
      expect(a.graceWindowSec).toBeGreaterThan(0);
    }
  });
});

describe("US-TRUTH-000 AC5 — the real drift fixtures are part of the declaration", () => {
  it("ships ≥3 real drift cases with the violated anchor + expected verdict", () => {
    const fixtures = TRUTH_ANCHORS.flatMap((a) => a.driftFixtures ?? []);
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    for (const f of fixtures) {
      expect(f.observed).toMatch(/2026/); // anchored to a dated real incident
      expect(["fail", "warn", "unknown", "grandfathered"]).toContain(f.expectedVerdict);
    }
    // The canonical 2026-06-10 cases must be among them.
    const all = JSON.stringify(fixtures);
    expect(all).toContain("20260610-212711"); // failed cycle, PR #577 merged
    expect(all).toContain("20260610-222703"); // phantom failure → fake PAUSE
  });
});
