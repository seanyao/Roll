/**
 * US-CYCLE-008 — evaluation risk-tier resolution.
 *
 * A card's `risk_tier` (declared in its design-contract/spec frontmatter, added
 * and lint-validated by US-CYCLE-005) decides evaluation DEPTH at cycle time:
 *   • `low`  → a single evaluator (the existing serial score/pairing gate — the
 *              DEFAULT path, byte-unchanged);
 *   • `high` → a parallel adversarial PANEL (auth / data-integrity / state-machine
 *              / shared-state-harness risk). The panel REUSES the existing bounded
 *              fan-out primitive (pairing-gate `PairFanoutReason` /
 *              `parallel-first-valid`); this module never spawns anything itself.
 *
 * Anti-Goodhart (AC3): the tier is read ONLY from the card's own lint-validated
 * contract. There is NO override parameter, env var, config key, or supervisor
 * entry point that can DOWNGRADE a high card to low. `resolveEvaluationTier`
 * takes exactly the spec text (+ id for the regime check) and nothing else, so a
 * downgrade path is STRUCTURALLY ABSENT — you cannot pass one in.
 *
 * Fail-loud (AC5): a NEW-REGIME card (one subject to the US-CYCLE-005 granularity
 * contract) whose spec has no valid `risk_tier: low|high` resolves to `missing`,
 * which the caller turns into a hard block — NOT a silent default to `low`. A
 * LEGACY card (never subject to the contract, 存量卡不追溯) resolves to `legacy`,
 * which the caller treats as the default serial path (byte-compatible).
 */
import { isNewRegimeCard } from "./card-granularity.js";
import type { PairFanoutReason } from "../runner/pairing-gate.js";

export type EvaluationTier = "low" | "high";

/**
 * The tier decision for a card at evaluation time.
 *   - `tier`    — a valid `risk_tier: low|high` was declared; route accordingly.
 *   - `legacy`  — no valid tier AND the card is not new-regime; the contract does
 *                 not apply, so the caller runs the default serial evaluator.
 *   - `missing` — the card IS new-regime (subject to the granularity contract)
 *                 but declares no valid `risk_tier`; the caller FAILS LOUD.
 */
export type TierDecision =
  | { kind: "tier"; tier: EvaluationTier }
  | { kind: "legacy" }
  | { kind: "missing" };

/** Extract the frontmatter block (between the first two `---` fences), or "". */
function frontmatter(spec: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(spec);
  return m ? (m[1] ?? "") : "";
}

/** The raw `risk_tier:` frontmatter scalar, trimmed, or undefined. */
function riskTierValue(spec: string): string | undefined {
  const m = /^\s*risk_tier\s*:\s*(.+?)\s*$/m.exec(frontmatter(spec));
  return m ? (m[1] ?? "").trim() : undefined;
}

/**
 * Resolve the evaluation tier from a card's spec. The ONLY inputs are the spec
 * text and (optionally) the card id — there is deliberately NO override channel.
 *
 * A value is accepted ONLY if it is exactly `low` or `high` (the same validation
 * the granularity lint applies); anything else is treated as absent. An invalid
 * value on a card that already declares the granularity contract therefore falls
 * through to `missing` (fail-loud), matching the lint's rejection of a malformed
 * `risk_tier`.
 */
export function resolveEvaluationTier(spec: string, id?: string): TierDecision {
  const raw = riskTierValue(spec);
  if (raw === "low" || raw === "high") return { kind: "tier", tier: raw };
  // No valid tier. New-regime cards MUST declare one → fail loud; legacy cards
  // are never retroactively gated → default serial path.
  return isNewRegimeCard(spec, id) ? { kind: "missing" } : { kind: "legacy" };
}

/**
 * Map a resolved tier to the fan-out reason the evaluation stage passes to the
 * pairing primitive. `high` → the tier-driven panel; `low`/legacy/undefined →
 * undefined (the serial single-evaluator default is untouched). This is the sole
 * bridge from tier to the parallel primitive — it can only ESCALATE (low never
 * produces a fan-out), never downgrade.
 */
export function tierFanoutReason(tier: EvaluationTier | undefined): PairFanoutReason | undefined {
  return tier === "high" ? "high_risk_tier_card" : undefined;
}
