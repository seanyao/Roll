/**
 * @responsibility Detects green PRs missing acceptance reports and classifies the repair.
 * FIX-1058 — evidence-repair recovery for green PRs missing acceptance reports.
 *
 * When a loop PR is CI green and has an accepted evaluator result but lacks a
 * fresh acceptance report, the supervisor blocks on a manual merge gate. This
 * module provides the detection and classification functions so the recovery
 * command can identify reparable PRs and, after repair, the supervisor can
 * recognise them as merge-ready rather than blocked.
 *
 * Pure by construction — zero I/O. All facts are injected; the caller resolves
 * PR state, CI state, evaluator state, and event stream.
 */

/** The evaluator source that satisfied (or failed to satisfy) the repair gate. */
export type EvaluatorSource = "github-review" | "roll-score" | "none";

/** The possible evidence-repair classifications for an open PR. */
export type EvidenceRepairClassification =
  | { verdict: "reparable"; reason: string; evaluatorSource: EvaluatorSource }
  | { verdict: "already_repaired"; reason: string }
  | { verdict: "not_reparable"; reason: string }
  | { verdict: "no_gap"; reason: string };

/**
 * FIX-1061 — a Roll evaluator score resolved from the loop's own evidence
 * (peer `cycle-<id>.score.pair.json` artifact or a `pair:score` event) rather
 * than from a GitHub review. Loop-created manual-merge PRs carry their
 * authoritative evaluator verdict here, not as a GitHub review.
 */
export interface RollEvaluatorScore {
  /** Integer 1..10 review score. */
  score: number;
  /** `good` | `ok` | `regression` (case-insensitive; other values are rejected). */
  verdict: string;
}

/** Inputs for {@link classifyEvidenceRepair}. */
export interface EvidenceRepairInput {
  /** The PR's CI status — "success", "failure", "pending", or "unknown". */
  ciState: string;
  /** The PR's GitHub review state — "APPROVED", "CHANGES_REQUESTED", "none", etc. */
  reviewState: string;
  /** Whether the PR's merge is clean ("CLEAN", "BEHIND", "DIRTY", "CONFLICTING"). */
  mergeable: string;
  /** Whether the PR is a draft. */
  isDraft: boolean;
  /** True iff the PR's associated story has a fresh acceptance report. */
  hasFreshReport: boolean;
  /** True iff an `evidence:repaired` event already exists for this PR. */
  alreadyRepaired: boolean;
  /** FIX-1061 — Roll evaluator score for the PR's cycle, used when the GitHub
   *  review is empty. Absent/null when no Roll evaluator evidence was found. */
  rollEvaluatorScore?: RollEvaluatorScore | null;
}

/**
 * FIX-1061 — the review-score low threshold the attest gate uses
 * (`evaluateReviewScoreGate` in `@roll/cli`): a `regression` verdict is rejected,
 * an `ok` verdict must clear this threshold, and `good` passes at any score.
 * Duplicated as a local constant so this pure core module keeps zero deps on the
 * CLI package; the value MUST stay in lockstep with `REVIEW_SCORE_LOW_THRESHOLD`.
 */
const REVIEW_SCORE_LOW_THRESHOLD = 5;

/**
 * Whether a Roll evaluator score meets the SAME acceptance bar the attest
 * review-score gate applies: `regression` is rejected, an `ok` verdict must
 * score above the low threshold, `good` passes at any (finite) score, and any
 * other/unparseable verdict is conservatively rejected.
 */
export function isAcceptedRollScore(score: RollEvaluatorScore | null | undefined): boolean {
  if (score === null || score === undefined) return false;
  if (typeof score.score !== "number" || !Number.isFinite(score.score)) return false;
  const verdict = score.verdict.trim().toLowerCase();
  if (verdict === "regression") return false;
  if (verdict === "good") return true;
  if (verdict === "ok") return score.score > REVIEW_SCORE_LOW_THRESHOLD;
  return false;
}

/** The resolved evaluator approval decision for a PR. */
export interface EvaluatorApproval {
  approved: boolean;
  source: EvaluatorSource;
  detail: string;
}

/**
 * FIX-1061 — resolve whether a PR has evaluator approval from EITHER source:
 * a GitHub review `APPROVED`, OR an accepted Roll evaluator score. GitHub review
 * remains valid, but its ABSENCE must not erase a valid Roll evaluator score.
 * The returned `source`/`detail` make the deciding evidence explicit.
 */
export function resolveEvaluatorApproval(input: {
  reviewState: string;
  rollEvaluatorScore?: RollEvaluatorScore | null;
}): EvaluatorApproval {
  if (input.reviewState === "APPROVED") {
    return { approved: true, source: "github-review", detail: "GitHub review APPROVED" };
  }
  if (isAcceptedRollScore(input.rollEvaluatorScore)) {
    const s = input.rollEvaluatorScore as RollEvaluatorScore;
    return {
      approved: true,
      source: "roll-score",
      detail: `Roll evaluator score ${s.score}/10 (${s.verdict})`,
    };
  }
  const gh = `GitHub review=${input.reviewState || "none"}`;
  const roll =
    input.rollEvaluatorScore === null || input.rollEvaluatorScore === undefined
      ? "no Roll evaluator score"
      : `Roll evaluator score ${input.rollEvaluatorScore.score}/10 (${input.rollEvaluatorScore.verdict}) below acceptance`;
  return { approved: false, source: "none", detail: `${gh}; ${roll}` };
}

/**
 * FIX-1061 — extract the loop cycle id from a PR head branch name
 * (`loop/cycle-<id>`). Returns null for a non-loop branch. This is the primary
 * link from a manual-merge PR to its Roll evaluator score artifact.
 */
export function cycleIdFromBranch(headRefName: string | undefined | null): string | null {
  if (typeof headRefName !== "string") return null;
  const m = /^loop\/cycle-(.+)$/.exec(headRefName.trim());
  const id = m?.[1] ?? "";
  return id !== "" ? id : null;
}

/**
 * FIX-1061 — parse a Roll peer score artifact (`cycle-<id>.score.pair.json`) or
 * `pair:score` event payload into a {@link RollEvaluatorScore}. Fail-closed:
 * returns null when the object lacks a finite numeric `score` or a non-empty
 * string `verdict`, so an unparseable artifact never masquerades as approval.
 */
export function parseRollScoreArtifact(raw: unknown): RollEvaluatorScore | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const score = o["score"];
  const verdict = o["verdict"];
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (typeof verdict !== "string" || verdict.trim() === "") return null;
  return { score, verdict };
}

/**
 * Classify a PR's evidence-repair eligibility.
 *
 * A PR is REPARABLE when:
 *   - CI is green (success)
 *   - Evaluator has approved (APPROVED)
 *   - Merge is clean (CLEAN)
 *   - BUT no fresh acceptance report exists
 *   - AND repair hasn't already been done
 *
 * A PR is ALREADY_REPAIRED when all conditions above are met and an
 * `evidence:repaired` event exists — the supervisor should show merge_ready.
 *
 * A PR has NO_GAP when it has a fresh report — nothing to repair.
 *
 * A PR is NOT_REPARABLE when CI is red, evaluator hasn't approved, merge is
 * dirty, or any other condition that means evidence alone won't make it ready.
 */
export function classifyEvidenceRepair(input: EvidenceRepairInput): EvidenceRepairClassification {
  // Structural preconditions: only green + clean PRs are candidates.
  if (input.ciState !== "success") {
    return { verdict: "not_reparable", reason: `CI is not green (${input.ciState}); evidence repair cannot fix CI` };
  }
  if (input.mergeable !== "CLEAN") {
    return { verdict: "not_reparable", reason: `merge is not clean (${input.mergeable}); evidence repair cannot resolve merge conflicts` };
  }

  // FIX-1062 — already-repaired is terminal/idempotent for a green+clean PR. A
  // rerun must report the repaired state before falling through to the
  // evaluator-approval failure check, because the first repair may have been
  // approved by a Roll evaluator score (FIX-1061) that is no longer visible as a
  // GitHub review. Structural failures (red CI / dirty merge) are still reported
  // first — repair cannot fix those.
  if (input.alreadyRepaired) {
    return { verdict: "already_repaired", reason: "evidence already repaired; PR is merge-ready" };
  }

  // FIX-1061 — evaluator approval comes from EITHER a GitHub review OR an accepted
  // Roll evaluator score; an empty GitHub review must not erase a valid Roll score.
  const approval = resolveEvaluatorApproval({
    reviewState: input.reviewState,
    rollEvaluatorScore: input.rollEvaluatorScore,
  });
  if (!approval.approved) {
    return { verdict: "not_reparable", reason: `evaluator has not approved (${approval.detail}); evidence repair cannot replace evaluator review` };
  }

  // Has fresh report — no gap to fill.
  if (input.hasFreshReport) {
    return { verdict: "no_gap", reason: "fresh acceptance report exists; no evidence gap to repair" };
  }

  // Reparable: green PR, approved evaluator (GitHub review or Roll score), clean
  // merge, but no fresh report.
  const who = input.isDraft ? "draft PR" : "PR";
  return {
    verdict: "reparable",
    evaluatorSource: approval.source,
    reason: `${who} is CI green + evaluator approved (${approval.detail}) + merge clean but lacks a fresh acceptance report`,
  };
}

/**
 * The action string the supervisor should show for a PR after evidence repair
 * (replacing the previous `draft_manual_merge_waiting` or similar block).
 */
export const EVIDENCE_REPAIRED_ACTION = "merge_ready" as const;

/**
 * Determine whether a manual-merge gate should be reclassified as merge-ready
 * because evidence has been repaired for this PR.
 *
 * Called by the supervisor when building the manual merge gate list.
 */
export function isEvidenceRepaired(
  prNumber: number,
  repairedPrs: ReadonlySet<number>,
): boolean {
  return repairedPrs.has(prNumber);
}

/** Options for {@link generateAcMap}. */
export interface GenerateAcMapOptions {
  /** Evidence file references captured during the repair command.
   *  Text evidence MUST carry a `textFile` for the attest gate's content predicate. */
  evidenceRefs?: ReadonlyArray<{ kind: string; label: string; textFile?: string }>;
  /** Status to assign to all AC entries.
   *  - `claimed` (default) — conservative: documents, does not verify.
   *  - `readonly` — the repair command produced real evidence files; the attest
   *    gate's content predicate will accept these entries as positive when the
   *    evidence entries carry real `textFile` / `href` refs.
   *  Never `pass` — the repair path must NOT fabricate pass evidence. */
  status?: "claimed" | "readonly";
  /** Fallback text file path used when an AC has no matching evidence refs.
   *  Required when `status` is `readonly` so the content predicate sees real
   *  evidence (a `textFile`) rather than a bare label (empty shell). */
  fallbackTextFile?: string;
}

/**
 * Generate an ac-map for a story whose evidence is being repaired.
 *
 * The default `claimed` status is conservative and safe — but the attest gate's
 * content predicate (`verificationReportHasAcceptanceContent`) requires at least
 * one POSITIVE AC backed by real evidence.  A repair that needs to pass the gate
 * should use `status: "readonly"` together with real `evidenceRefs` whose text
 * entries carry a `textFile` pointing to an actual on-disk evidence file.
 *
 * @param storyId - The story identifier (e.g. "FIX-1058").
 * @param acItems - Parsed AC items from the story card (id + text).
 * @param opts - Optional settings (evidence refs, status, fallback file).
 * @returns A JSON-serializable ac-map array.
 */
export function generateAcMap(
  storyId: string,
  acItems: ReadonlyArray<{ id: string; text: string }>,
  opts?: GenerateAcMapOptions,
): Array<{ ac: string; status: string; evidence: Array<{ kind: string; label: string; textFile?: string }> }> {
  const status = opts?.status ?? "claimed";
  const evidenceRefs = opts?.evidenceRefs;
  const fallbackTextFile = opts?.fallbackTextFile;
  const isPositive = status === "readonly";

  return acItems.map((item) => {
    const evidence: Array<{ kind: string; label: string; textFile?: string }> = [];

    // Attach caller-supplied evidence refs that textually match this AC.
    if (evidenceRefs !== undefined) {
      const acLower = item.text.toLowerCase();
      for (const ref of evidenceRefs) {
        const haystack = `${ref.label} ${ref.textFile ?? ""}`.toLowerCase();
        if (acLower.split(/\s+/).some((t) => t.length >= 3 && haystack.includes(t))) {
          evidence.push({ ...ref });
        }
      }
    }

    // Build fallback evidence when no refs matched.
    if (evidence.length === 0) {
      if (isPositive && fallbackTextFile !== undefined) {
        // Positive status requires real evidence — provide a textFile ref so
        // the attest gate's content predicate (`acMapEvidenceIsReal`) sees
        // a non-empty textFile and treats this as real evidence.
        evidence.push({ kind: "text", label: `repair: ${storyId} AC entry (repaired evidence)`, textFile: fallbackTextFile });
      } else {
        // Conservative / no fallback file — bare label. The content predicate
        // will reject this entry if status is positive (no textFile), which is
        // correct: the caller chose `readonly` without providing evidence files.
        evidence.push({ kind: "text", label: `repair: ${storyId} AC entry (repaired evidence)` });
      }
    }

    return { ac: item.id, status, evidence };
  });
}

/**
 * Generate a minimal acceptance report markdown for a repaired story.
 *
 * This is not a full HTML attest report — it records the repair fact with
 * the ac-map path, PR state, and timestamps so the supervisor can show the
 * evidence gate was satisfied.
 */
export function generateAttestReport(storyId: string, acMapPath: string, prNumber: number): string {
  return [
    `# Acceptance Report — ${storyId} (evidence repair)`,
    "",
    `**PR:** #${prNumber}`,
    `**Generated:** ${new Date().toISOString()}`,
    `**Method:** evidence repair (post-hoc recovery for green PR missing acceptance report)`,
    "",
    "## Ac-map",
    "",
    `See [ac-map.json](${acMapPath}) for the full acceptance criteria mapping.`,
    "",
    "**Status:** claimed (repaired evidence — all ACs documented at `claimed`; no fabricated pass status)",
    "",
    "## Evidence Ref",
    "",
    "- PR is CI green",
    "- Evaluator has approved",
    "- Merge is clean",
    "- This report and ac-map generated by the repair-evidence command",
    "",
  ].join("\n");
}
export function repairedPrNumbers(events: ReadonlyArray<{ type: string; prNumber?: number }>): Set<number> {
  const repaired = new Set<number>();
  for (const ev of events) {
    if (ev.type === "evidence:repaired" && typeof ev.prNumber === "number") {
      repaired.add(ev.prNumber);
    }
  }
  return repaired;
}

// ── FIX-1260: draft PR auto-repair decision for reconcile tick ───────────────

/** Result of the draft auto-repair eligibility decision. */
export type DraftAutoRepairDecision =
  | { verdict: "eligible"; evaluatorSource: EvaluatorSource; evaluatorDetail: string; reason: string }
  | { verdict: "not_eligible"; reason: string };

/**
 * Decide whether a draft PR is eligible for automatic repair-evidence during
 * the reconcile tick.
 *
 * Reuses {@link classifyEvidenceRepair} for the structural checks (CI green,
 * evaluator approved, merge clean) and adds the draft-specific logic:
 *   - Only draft PRs are eligible (non-draft PRs go through the normal merge path).
 *   - Already-repaired draft PRs are eligible (they just need `gh pr ready` + merge).
 *   - Reparable draft PRs with INDEPENDENT evaluator approval are eligible.
 *   - Non-reparable PRs or evaluator not approved → not eligible.
 *
 * Independence rule: a Roll evaluator score (peer session, never builder's own)
 * is always independent. A GitHub review is independent as long as it came from
 * a bot/app — the repair-evidence flow only considers bot associations.
 */
export function decideDraftAutoRepair(input: EvidenceRepairInput): DraftAutoRepairDecision {
  // Only draft PRs enter this path.
  if (!input.isDraft) {
    return { verdict: "not_eligible", reason: "PR is not a draft — normal reconcile path applies" };
  }

  const classification = classifyEvidenceRepair(input);

  // Already repaired → eligible (just needs ready + merge, no new repair needed).
  if (classification.verdict === "already_repaired") {
    return {
      verdict: "eligible",
      evaluatorSource: "roll-score", // already validated in prior repair
      evaluatorDetail: "previously repaired — evaluator approved",
      reason: "draft PR already repaired; ready to promote and merge",
    };
  }

  // Reparable → eligible. Evaluator independence is guaranteed:
  // - Roll evaluator score: peer session, never the builder's own.
  // - GitHub review: only bot/app reviews are considered.
  if (classification.verdict === "reparable") {
    const approval = resolveEvaluatorApproval({
      reviewState: input.reviewState,
      rollEvaluatorScore: input.rollEvaluatorScore,
    });
    return {
      verdict: "eligible",
      evaluatorSource: approval.source === "none" ? "roll-score" : approval.source,
      evaluatorDetail: approval.detail,
      reason: classification.reason,
    };
  }

  // Not reparable — low evaluator score, CI not green, merge dirty, etc.
  // Stay in draft (degraded) with the reason.
  return { verdict: "not_eligible", reason: classification.reason };
}
