/**
 * US-CYCLE-005 — design-time granularity lint. The biggest lever on cycle-time
 * mean is story granularity: a card that is too big is split at RUN time (paying
 * the full price passively) instead of at DESIGN time. This lint rejects an
 * oversized card at the minting / validation boundary so "one builder session
 * per card" is enforced, not preached.
 *
 * Pure (no I/O): callers pass the spec text. It scopes itself to NEW-regime cards
 * via {@link hasGranularityContract} (a card that declares `est_min:`), so the
 * 900+ legacy cards are never retroactively failed ("存量卡不追溯").
 *
 * The five checks (all from the card's own spec):
 *   1. an `## Evaluation contract` section exists;
 *   2. `expected_evidence` ≤ 3 (the evidence bullets under "Expected evidence:");
 *   3. acceptance-criteria checkboxes ≤ 6;
 *   4. `est_min` present in frontmatter and ≤ 25;
 *   5. `risk_tier: low|high` present in frontmatter (paves US-CYCLE-008).
 */

export const GRANULARITY_LIMITS = {
  maxEvidence: 3,
  maxAc: 6,
  maxEstMin: 25,
} as const;

/**
 * The policy cutover (YYYY-MM-DD): cards CREATED on or after this date are the
 * "new regime" and must satisfy the granularity contract; cards created before
 * it are legacy and never retroactively gated (存量卡不追溯). Keyed on the
 * intrinsic `created:` date — NOT a dodgeable field like `est_min` presence — so
 * a new card cannot bypass the lint by omitting metadata, whatever minted it
 * (`story new`, `roll idea`, or hand-authored). This is the date the lint shipped.
 */
export const GRANULARITY_CUTOVER_DATE = "2026-07-24";

export interface GranularityViolation {
  /** Short machine-ish label, e.g. "est_min", "ac_count". */
  code: string;
  /** Human message (what is wrong). */
  message: string;
  /** Actionable fix ("怎么拆"). */
  fix: string;
}

export interface GranularityResult {
  ok: boolean;
  violations: GranularityViolation[];
}

/** Extract the frontmatter block (between the first two `---` fences), or "" . */
function frontmatter(spec: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(spec);
  return m ? (m[1] ?? "") : "";
}

/**
 * A NEW-regime card that MUST satisfy the granularity contract. Gated when EITHER
 *   (a) `created:` >= {@link GRANULARITY_CUTOVER_DATE} — the tool mint channels
 *       (`roll story new`, `roll idea`) always stamp `created:` today, so every
 *       tool-minted card is caught regardless of whether it filled est_min /
 *       risk_tier (this closes the omit-metadata dodge), OR
 *   (b) the card already declares any granularity field (`est_min` / `risk_tier`)
 *       — a partially-filled contract signals new-regime intent even on a
 *       hand-authored spec with no `created:`.
 * IDEA-* cards are exempt (a speculative seed, sized when promoted to a US).
 *
 * Residual (irreducible): a spec that has NO `created:` AND NO granularity field
 * is indistinguishable from a legacy card, so it is treated as legacy — there is
 * no signal that separates "brand-new bare hand-authored" from "old". The mint
 * channels never produce that shape; a human who hand-writes a spec bypassing all
 * tooling owns the granularity discipline manually.
 */
export function isNewRegimeCard(spec: string, id?: string): boolean {
  if (id !== undefined && /^IDEA-/i.test(id)) return false;
  const fm = frontmatter(spec);
  if (/^\s*est_min\s*:/m.test(fm) || /^\s*risk_tier\s*:/m.test(fm)) return true;
  const created = fmValue(spec, "created");
  if (created === undefined || !/^\d{4}-\d{2}-\d{2}/.test(created)) return false;
  return created.slice(0, 10) >= GRANULARITY_CUTOVER_DATE;
}

/** Count acceptance-criteria checkboxes (`- [ ]` / `- [x]`) anywhere in the body. */
function countAcCheckboxes(spec: string): number {
  const m = spec.match(/^\s*[-*]\s*\[[ xX]\]/gm);
  return m ? m.length : 0;
}

/** Count the evidence bullets under the "Expected evidence:" label — the bullets
 *  that run until the next bold label (`**…:**`) or a header (`##`). */
function countExpectedEvidence(spec: string): number {
  const lines = spec.split("\n");
  let inEvidence = false;
  let count = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/\*\*\s*Expected evidence\s*:?\s*\*\*/i.test(line) || /^Expected evidence\s*:/i.test(line.trim())) {
      inEvidence = true;
      continue;
    }
    if (inEvidence) {
      // A new bold label or a markdown header closes the evidence block.
      if (/^\s*\*\*.*:?\s*\*\*/.test(line) || /^#{1,6}\s/.test(line)) break;
      if (/^\s*[-*]\s+\S/.test(line)) count += 1;
    }
  }
  return count;
}

/** Read a frontmatter scalar (`key: value`), trimmed, or undefined. */
function fmValue(spec: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m").exec(frontmatter(spec));
  return m ? (m[1] ?? "").trim() : undefined;
}

/**
 * Lint a card spec for design-time granularity. Returns every violation with an
 * actionable fix. A caller decides whether to gate (validate) or advise (new).
 */
export function lintCardGranularity(spec: string): GranularityResult {
  const violations: GranularityViolation[] = [];

  if (!/^#{1,6}\s*Evaluation contract/im.test(spec)) {
    violations.push({
      code: "evaluation_contract",
      message: "no `## Evaluation contract` section",
      fix: "add an `## Evaluation contract` section declaring Expected evidence + Scorer focus.",
    });
  }

  const evidence = countExpectedEvidence(spec);
  if (evidence > GRANULARITY_LIMITS.maxEvidence) {
    violations.push({
      code: "expected_evidence",
      message: `expected_evidence = ${evidence} (> ${GRANULARITY_LIMITS.maxEvidence})`,
      fix: `trim to ≤ ${GRANULARITY_LIMITS.maxEvidence} evidence kinds, or split the card so each slice proves ≤ ${GRANULARITY_LIMITS.maxEvidence}.`,
    });
  }

  const ac = countAcCheckboxes(spec);
  if (ac > GRANULARITY_LIMITS.maxAc) {
    violations.push({
      code: "ac_count",
      message: `acceptance criteria = ${ac} (> ${GRANULARITY_LIMITS.maxAc})`,
      fix: `split into cards of ≤ ${GRANULARITY_LIMITS.maxAc} AC each — one builder session should satisfy all of them.`,
    });
  }

  const estRaw = fmValue(spec, "est_min");
  if (estRaw === undefined) {
    violations.push({
      code: "est_min",
      message: "no `est_min:` in frontmatter",
      fix: `add "est_min: <minutes>" (≤ ${GRANULARITY_LIMITS.maxEstMin}); if it cannot fit, split the card.`,
    });
  } else {
    const est = Number(estRaw);
    if (!Number.isFinite(est)) {
      violations.push({ code: "est_min", message: `est_min is not a number ("${estRaw}")`, fix: "set `est_min:` to a number of minutes." });
    } else if (est > GRANULARITY_LIMITS.maxEstMin) {
      violations.push({
        code: "est_min",
        message: `est_min = ${est} (> ${GRANULARITY_LIMITS.maxEstMin})`,
        fix: `split into slices each ≤ ${GRANULARITY_LIMITS.maxEstMin} min (one builder session).`,
      });
    }
  }

  const riskRaw = fmValue(spec, "risk_tier");
  if (riskRaw === undefined) {
    violations.push({
      code: "risk_tier",
      message: "no `risk_tier:` in frontmatter",
      fix: "add `risk_tier: low` or `risk_tier: high` (drives US-CYCLE-008 evaluation depth).",
    });
  } else if (riskRaw !== "low" && riskRaw !== "high") {
    violations.push({
      code: "risk_tier",
      message: `risk_tier = "${riskRaw}" (must be low|high)`,
      fix: "set `risk_tier:` to exactly `low` or `high`.",
    });
  }

  return { ok: violations.length === 0, violations };
}

/** Render violations as a fail-loud, actionable block (bilingual header). */
export function renderGranularityViolations(id: string, result: GranularityResult): string {
  if (result.ok) return `✓ granularity ok (${id})`;
  const lines = [`✗ granularity FAIL (${id}) — 卡太大/契约缺失,拆小或补齐后再入 backlog:`];
  for (const v of result.violations) {
    lines.push(`  • ${v.message}`);
    lines.push(`    ↳ ${v.fix}`);
  }
  return lines.join("\n");
}
