/**
 * US-EVID-033 — card-level delivery-time CI truth (PURE classification).
 *
 * The legacy `ci` lane in an evidence manifest is `gh run list --limit 1` — the
 * repository's most recent workflow run, related to the card only by accident.
 * That made a card's CI evidence unownable: a card whose attest never ran (a
 * supervised/manual delivery, or an attest bug like FIX-1483) had NO honest way
 * to ever earn evidence, because re-running the test command later proves
 * nothing about the delivery (with an unchanged tree `roll test --affected`
 * matches zero tests and "passes" in seconds).
 *
 * The delivery-time truth is already recorded: THIS card's PR ran the required
 * checks at a specific head sha before it merged. This module classifies that
 * fact and nothing else. Three honest states, no fourth:
 *   - `verified` — every check on the PR's head sha concluded successfully;
 *   - `red`      — at least one check failed (NEVER downgraded to unknown);
 *   - `unknown`  — with a recorded reason (no delivery record, no gh, checks
 *                  unavailable, no checks, checks still running).
 * Nothing is ever synthesized: a missing fact stays missing.
 */

/** One check run's conclusion as reported by the forge. */
export interface DeliveryCheckRun {
  name: string;
  /** GitHub conclusion: success|failure|neutral|cancelled|skipped|timed_out|action_required|startup_failure|"" (still running). */
  conclusion: string;
}

/** The card's delivery record, projected from the delivery ledger. */
export interface DeliveryCiRecord {
  prNumber?: number | undefined;
  mergeCommit?: string | undefined;
  headSha?: string | undefined;
  /** Epoch ms the PR merged, when known. */
  mergedAtMs?: number | undefined;
}

export interface DeliveryCiFact {
  state: "verified" | "red" | "unknown";
  /** Why the state is not `verified` — always present for red/unknown. */
  reason?: string;
  prNumber?: number;
  headSha?: string;
  mergeCommit?: string;
  /** ISO merge time when known. */
  mergedAt?: string;
  /** ISO time this fact was collected. */
  collectedAt: string;
  /**
   * True when the fact was collected AFTER the card merged — i.e. the report is
   * a post-hoc reconstruction of delivery-time truth, not cycle-time evidence.
   * Labeled honestly rather than hidden.
   */
  postHoc: boolean;
  checks: DeliveryCheckRun[];
}

/** Conclusions that count as a passing check. */
const PASSING = new Set(["success", "neutral", "skipped"]);
/** Conclusions that are unambiguously a failure. */
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export interface ResolveDeliveryCiInput {
  record?: DeliveryCiRecord | undefined;
  /** `undefined` means the query itself could not be made (never "no checks"). */
  checks?: readonly DeliveryCheckRun[] | undefined;
  ghAvailable: boolean;
  /** ISO timestamp of this collection. */
  collectedAt: string;
}

export function resolveDeliveryCi(input: ResolveDeliveryCiInput): DeliveryCiFact {
  const rec = input.record;
  const mergedAtMs = rec?.mergedAtMs;
  const collectedMs = Date.parse(input.collectedAt);
  const base: DeliveryCiFact = {
    state: "unknown",
    collectedAt: input.collectedAt,
    postHoc:
      mergedAtMs !== undefined && Number.isFinite(mergedAtMs) && Number.isFinite(collectedMs)
        ? collectedMs > mergedAtMs
        : false,
    checks: [],
    ...(rec?.prNumber !== undefined ? { prNumber: rec.prNumber } : {}),
    ...(rec?.headSha !== undefined && rec.headSha !== "" ? { headSha: rec.headSha } : {}),
    ...(rec?.mergeCommit !== undefined && rec.mergeCommit !== "" ? { mergeCommit: rec.mergeCommit } : {}),
    ...(mergedAtMs !== undefined && Number.isFinite(mergedAtMs)
      ? { mergedAt: new Date(mergedAtMs).toISOString() }
      : {}),
  };

  if (rec === undefined || rec.prNumber === undefined) {
    return { ...base, reason: "no_delivery_record" };
  }
  if (!input.ghAvailable) {
    return { ...base, reason: "gh_unavailable" };
  }
  if (input.checks === undefined) {
    return { ...base, reason: "checks_unavailable" };
  }
  const checks = [...input.checks];
  if (checks.length === 0) {
    return { ...base, reason: "no_checks_on_head_sha", checks };
  }

  // A failure is terminal: it is reported as `red` even when other checks are
  // still running — a red check must never hide behind "incomplete".
  const failed = checks.filter((c) => FAILING.has(c.conclusion));
  if (failed.length > 0) {
    return { ...base, state: "red", reason: `checks_failed:${failed.map((c) => c.name).join(",")}`, checks };
  }
  const incomplete = checks.filter((c) => !PASSING.has(c.conclusion));
  if (incomplete.length > 0) {
    return { ...base, reason: `checks_incomplete:${incomplete.map((c) => c.name).join(",")}`, checks };
  }
  return { ...base, state: "verified", checks };
}

/** One-line human summary for the report/terminal (bilingual callers wrap it). */
export function deliveryCiSummary(fact: DeliveryCiFact): string {
  const pr = fact.prNumber !== undefined ? `#${fact.prNumber}` : "no PR";
  const sha = fact.headSha !== undefined ? fact.headSha.slice(0, 8) : "no sha";
  const names = fact.checks.map((c) => `${c.name}=${c.conclusion || "running"}`).join(" ");
  return `${fact.state} ${pr}@${sha}${fact.reason !== undefined ? ` (${fact.reason})` : ""}${names !== "" ? ` — ${names}` : ""}`;
}
