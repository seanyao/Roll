/**
 * @responsibility Downgrades scope on the reviewer's independent too-big signal.
 * Review-triggered resize (US-AGENT-041) — the PURE decision core for the
 * reviewer-triggered self-downgrade. US-AGENT-008's downgrade only fired on the
 * BUILDER's own "too big" pre-flight; in practice the reliable "scope too large"
 * signal comes from the independent REVIEWER (it enumerates the uncovered AC /
 * coverage gaps after the builder self-declares done at ~80%). This module adds
 * that trigger EDGE — it does not build a new downgrade machine: the actual
 * re-split is performed by `roll loop self-downgrade` (US-AGENT-042) and the
 * chain-depth cap is US-AGENT-009's, both reused unchanged.
 *
 * The split PROPOSAL is gated by HETEROGENEOUS CONSENSUS instead of a
 * human-confirm: ≥2 different-vendor agents review it (reusing the existing
 * peer-review primitive) — ALL agree → auto-land; any objection → pause + alert
 * (human on the loop, not in it). See [[feedback_hetero_consensus_replaces_human_confirm]].
 *
 * Purity: parsing + decisions only; the command wires design (`$roll-design`),
 * the peer consult spawns, and the self-downgrade side-effects.
 */

/** A reviewer's "scope too large" signal: why, and the concrete uncovered gaps. */
export interface ResizeSignal {
  reason: string;
  gaps: string[];
}

/**
 * Score at/below this is "low" — the same floor the review-score gate uses
 * (REVIEW_SCORE_LOW_THRESHOLD). A resize only fires on a LOW score: a high score
 * with a stray RESIZE line is not a scope problem.
 */
export const RESIZE_SCORE_THRESHOLD = 5;

const RESIZE_RE = /^\s*RESIZE:\s*(.+?)\s*$/im;
const GAPS_RE = /^\s*GAPS:\s*(.+?)\s*$/im;

/**
 * Parse a reviewer's optional resize signal from its score reply. A scope-too-
 * large delivery adds:
 *   RESIZE: <one line — why the scope exceeds one cycle>
 *   GAPS: <gap one; gap two; gap three>
 * Returns null when there is no `RESIZE:` line (a pure quality problem, or a
 * clean delivery — neither triggers a re-split). Gaps split on `;` (or `,`),
 * blanks dropped; a RESIZE with no usable gaps still parses (the command then
 * treats it as irreducible via the cap path).
 */
export function parseResizeSignal(text: string): ResizeSignal | null {
  const rm = RESIZE_RE.exec(text);
  if (rm?.[1] === undefined) return null;
  const reason = rm[1].trim();
  if (reason === "") return null;
  const gm = GAPS_RE.exec(text);
  const gaps =
    gm?.[1] === undefined
      ? []
      : gm[1]
          .split(/[;,]/)
          .map((g) => g.trim())
          .filter((g) => g !== "");
  return { reason, gaps };
}

/**
 * Should a reviewed delivery trigger a re-split? Only when the reviewer emitted
 * a resize signal AND the score is LOW (≤ threshold). A scope signal on a
 * passing score is ignored — the resize is a "shipped at low confidence because
 * the scope didn't fit", not a nitpick.
 */
export function shouldResize(score: number, resize: ResizeSignal | null): boolean {
  return resize !== null && Number.isFinite(score) && score <= RESIZE_SCORE_THRESHOLD;
}

/** One consensus reviewer's verdict on the split proposal. */
export interface ConsensusVerdict {
  peer: string;
  agree: boolean;
  reason?: string;
}

/** The default minimum number of heterogeneous reviewers a split needs. */
export const RESIZE_CONSENSUS_MIN_PEERS = 2;

export interface ConsensusOutcome {
  /** Land the split? True iff ≥ minPeers verdicts AND every one agrees. */
  landed: boolean;
  agreeCount: number;
  total: number;
  /** Peers that objected (drives the alert when consensus fails). */
  dissenters: string[];
  /** Why consensus did not land (when `landed` is false). */
  reason?: string;
}

/**
 * Heterogeneous consensus over the split proposal: land ONLY when at least
 * `minPeers` independent reviewers all agree. A single objection — or too few
 * reviewers available — blocks the auto-land (the command then pauses + alerts
 * for human triage). This is the consensus replacement for human-confirm: all
 * agree → continue; disagree → escalate.
 */
export function resizeConsensus(
  verdicts: readonly ConsensusVerdict[],
  minPeers: number = RESIZE_CONSENSUS_MIN_PEERS,
): ConsensusOutcome {
  const total = verdicts.length;
  const agreeCount = verdicts.filter((v) => v.agree).length;
  const dissenters = verdicts.filter((v) => !v.agree).map((v) => v.peer);
  if (total < minPeers) {
    return {
      landed: false,
      agreeCount,
      total,
      dissenters,
      reason: `too few reviewers for consensus (${total} < ${minPeers})`,
    };
  }
  if (agreeCount !== total) {
    return {
      landed: false,
      agreeCount,
      total,
      dissenters,
      reason: `${dissenters.length} reviewer(s) objected: ${dissenters.join(", ")}`,
    };
  }
  return { landed: true, agreeCount, total, dissenters: [] };
}
