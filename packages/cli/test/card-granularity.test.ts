/**
 * US-CYCLE-005 — design-time granularity lint. Pins each violation dimension +
 * the pass path + the self-scoping (legacy cards without est_min are untouched).
 */
import { describe, expect, it } from "vitest";
import {
  GRANULARITY_CUTOVER_DATE,
  GRANULARITY_LIMITS,
  isNewRegimeCard,
  lintCardGranularity,
  renderGranularityViolations,
} from "../src/lib/card-granularity.js";

const fm = (extra: string): string => `---\nid: US-X-1\ntype: us\n${extra}\ncreated: 2026-07-24\n---\n`;

/** A well-formed new-regime card that PASSES the lint. */
const GOOD =
  fm("est_min: 15\nrisk_tier: low") +
  "# US-X-1\n\n## AC\n- [ ] one\n- [ ] two\n\n## Evaluation contract\n\n**Expected evidence:**\n- `test` — unit\n- `command` — roll test\n\n**Scorer focus:** it works\n";

describe("isNewRegimeCard — self-scoping by created date (not a dodgeable field)", () => {
  it("true for a card created on/after the cutover — even if it OMITS est_min (codex r1: no bypass)", () => {
    expect(isNewRegimeCard(GOOD)).toBe(true);
    // A new card that omits est_min/risk_tier is STILL new-regime (cannot dodge).
    expect(isNewRegimeCard(`---\nid: US-N\ntype: us\ncreated: ${GRANULARITY_CUTOVER_DATE}\n---\n# n\n`)).toBe(true);
  });
  it("true for a hand-authored card with a granularity field but NO created (partial-contract intent)", () => {
    expect(isNewRegimeCard("---\nid: US-HAND\ntype: us\nrisk_tier: low\n---\n# hand\n")).toBe(true);
    expect(isNewRegimeCard("---\nid: US-HAND2\ntype: us\nest_min: 12\n---\n# hand\n")).toBe(true);
  });
  it("false for legacy (created before cutover / bare spec) and for IDEA-*", () => {
    expect(isNewRegimeCard("---\nid: US-OLD\ntype: us\ncreated: 2026-01-01\n---\n# old\n")).toBe(false);
    // bare spec: no created AND no granularity field ⇒ indistinguishable from legacy.
    expect(isNewRegimeCard("---\nid: US-NODATE\ntype: us\n---\n# nodate\n")).toBe(false);
    expect(isNewRegimeCard(`---\nid: IDEA-9\ntype: idea\ncreated: ${GRANULARITY_CUTOVER_DATE}\nest_min: 5\n---\n# idea\n`, "IDEA-9")).toBe(false);
  });
});

describe("lintCardGranularity — pass path", () => {
  it("a small, well-formed card passes with no violations", () => {
    const r = lintCardGranularity(GOOD);
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
    expect(renderGranularityViolations("US-X-1", r)).toContain("granularity ok");
  });
});

describe("lintCardGranularity — each violation dimension", () => {
  it("missing Evaluation contract", () => {
    const spec = fm("est_min: 10\nrisk_tier: low") + "# t\n\n## AC\n- [ ] a\n";
    const r = lintCardGranularity(spec);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("evaluation_contract");
  });

  it("expected_evidence > 3", () => {
    const spec =
      fm("est_min: 10\nrisk_tier: low") +
      "# t\n\n## AC\n- [ ] a\n\n## Evaluation contract\n\n**Expected evidence:**\n- `test` — a\n- `command` — b\n- `screenshot` — c\n- `negative` — d\n\n**Scorer focus:** x\n";
    const r = lintCardGranularity(spec);
    const ev = r.violations.find((v) => v.code === "expected_evidence");
    expect(ev).toBeDefined();
    expect(ev?.message).toContain(`> ${GRANULARITY_LIMITS.maxEvidence}`);
  });

  it("AC count > 6", () => {
    const acs = Array.from({ length: 7 }, (_, i) => `- [ ] ac ${i}`).join("\n");
    const spec = fm("est_min: 10\nrisk_tier: low") + `# t\n\n## AC\n${acs}\n\n## Evaluation contract\n\n**Expected evidence:**\n- \`test\` — a\n\n**Scorer focus:** x\n`;
    const r = lintCardGranularity(spec);
    expect(r.violations.map((v) => v.code)).toContain("ac_count");
  });

  it("est_min > 25", () => {
    const spec = fm("est_min: 40\nrisk_tier: low") + "# t\n\n## AC\n- [ ] a\n\n## Evaluation contract\n\n**Expected evidence:**\n- `test` — a\n\n**Scorer focus:** x\n";
    const r = lintCardGranularity(spec);
    const est = r.violations.find((v) => v.code === "est_min");
    expect(est?.message).toContain("40");
    expect(est?.fix).toContain("split");
  });

  it("risk_tier missing and risk_tier invalid", () => {
    const missing = lintCardGranularity(fm("est_min: 10") + "# t\n\n## AC\n- [ ] a\n\n## Evaluation contract\n\n**Expected evidence:**\n- `test` — a\n\n**Scorer focus:** x\n");
    expect(missing.violations.map((v) => v.code)).toContain("risk_tier");
    const bad = lintCardGranularity(fm("est_min: 10\nrisk_tier: medium") + "# t\n\n## AC\n- [ ] a\n\n## Evaluation contract\n\n**Expected evidence:**\n- `test` — a\n\n**Scorer focus:** x\n");
    const rt = bad.violations.find((v) => v.code === "risk_tier");
    expect(rt?.message).toContain("medium");
  });
});

describe("renderGranularityViolations — actionable output", () => {
  it("lists each violation with a fix (怎么拆)", () => {
    const r = lintCardGranularity(fm("est_min: 99\nrisk_tier: low") + "# t\n");
    const out = renderGranularityViolations("US-X-1", r);
    expect(out).toContain("granularity FAIL");
    expect(out).toContain("↳"); // fix guidance present
    expect(out).toContain("est_min = 99");
  });
});
