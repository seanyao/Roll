/**
 * US-DELIV-004 / RL-DELIV-010 — push-time evidence gate (fail-loud).
 *
 * Design .roll/features/delivery-reconciler/delivery-reconciler-design.md
 * §3.2/§4/§8: BEFORE the cycle branch is pushed, verify the acceptance
 * evidence (attest report + ac-map) was actually produced this cycle.
 * Missing evidence ⇒ `{ ok:false, reasons }` ⇒ the cycle is
 * `blocked_no_evidence` and the branch is NEVER pushed — "pushed a branch
 * but opened no PR" (裸分支无 PR) stops being a normal outcome and becomes a
 * fault state, handled like the zero-TCR class.
 *
 * This gate moves the CHECKPOINT earlier (push time instead of after-the-fact
 * attest); it does NOT change the attest judgement itself (FIX-329: attest is
 * earned at delivery, never backfilled). The CLI resolves the two facts from
 * disk (report/ac-map existence in either evidence root) and injects them;
 * the verdict is pure + total so it is exhaustively unit-testable.
 *
 * FIX-1256: the evidence gate must share the SAME "does this story owe an
 * acceptance report?" decision as the attest gate. A card with no `**AC:**`
 * block is exempt from both report and ac-map requirements; the caller injects
 * that via `acceptanceReportRequired`.
 */

import { acForStory } from "../attest/ac-parser.js";
import { EvidenceClassifier } from "../attest/evidence-classifier.js";
import type { EvidenceClassifierInput } from "@roll/spec";

/** Pure inputs for {@link evidenceGateBeforePush} — all injectable. */
export interface EvidenceGateFacts {
  /** True iff an acceptance report (`<ID>-report.html`) exists in an evidence root. */
  readonly attestReportPresent: boolean;
  /** True iff `ac-map.json` exists for the story in an evidence root. */
  readonly acMapPresent: boolean;
  /**
   * FIX-1256 — false when the story has no `**AC:**` block, so neither an
   * attest report nor an ac-map is owed. Defaults to true (fail-closed) for
   * callers that do not inject the fact.
   */
  readonly acceptanceReportRequired?: boolean;
  /** Artifacts offered to discharge visual ACs, when the caller has them. */
  readonly visualEvidence?: readonly EvidenceClassifierInput[];
}

/** The gate verdict: push allowed, or blocked with one reason per missing artifact. */
export type EvidenceGateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Classify artifacts offered as visual acceptance evidence.  This is the
 * delivery boundary: diagnostic screenshots never become visual proof merely
 * because they are image-shaped, while a verified physical capture may.
 */
export function visualEvidenceGate(artifacts: readonly EvidenceClassifierInput[]): EvidenceGateVerdict {
  const classifier = new EvidenceClassifier();
  const reasons: string[] = [];
  for (const artifact of artifacts) {
    const visual = classifier.validateVisualEvidence(artifact);
    if (visual.verdict !== "valid") reasons.push(`${artifact.artifactId}: ${visual.reason}`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * FIX-1256 — shared, spec-text-based decision for whether a story owes an
 * acceptance report. Exported so the attest gate and the push-time evidence
 * gate draw the same conclusion from the same source.
 */
export function acBlockPresentInSpec(specText: string, storyId: string): boolean {
  return acForStory(specText, storyId, { fileOwned: true }).length > 0;
}

/**
 * Pure push-time evidence gate. Deterministic reason order (attest report
 * first, then ac-map) so alerts and tests are stable.
 */
export function evidenceGateBeforePush(facts: EvidenceGateFacts): EvidenceGateVerdict {
  if (facts.acceptanceReportRequired === false) {
    return { ok: true };
  }
  const reasons: string[] = [];
  if (!facts.attestReportPresent) {
    reasons.push("attest report missing (no acceptance report produced this cycle)");
  }
  if (!facts.acMapPresent) {
    reasons.push("ac-map.json missing");
  }
  if (facts.visualEvidence !== undefined) {
    const visual = visualEvidenceGate(facts.visualEvidence);
    if (!visual.ok) reasons.push(...visual.reasons);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
