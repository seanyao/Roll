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
 *   - `verified` — the PR is MERGED, its merge sha agrees with the ledger, the
 *     check list is COMPLETE, and every check concluded `success`;
 *   - `red`      — at least one check failed (terminal: never downgraded, never
 *                  hidden behind a still-running or missing check);
 *   - `unknown`  — anything else, always with a recorded reason.
 * Nothing is ever synthesized, and every doubt resolves to `unknown` — the one
 * state that cannot be mistaken for acceptance.
 *
 * Codex review r1 closed five ways a `verified` could have been wrong: an
 * unpaginated check list hiding a red beyond page 1, an open/other PR, `neutral`
 * and `skipped` counted as green executions, a defeatable post-hoc label, and an
 * unvalidated API target able to misattribute another repo's checks.
 */

/** One check run's conclusion as reported by the forge (check-runs + statuses). */
export interface DeliveryCheckRun {
  name: string;
  /** `success` | `failure` | `neutral` | `cancelled` | `skipped` | `timed_out` | `action_required` | `startup_failure` | "" (still running). */
  conclusion: string;
}

/** The card's delivery record, projected from the delivery ledger. */
export interface DeliveryCiRecord {
  prNumber?: number | undefined;
  /** The merge commit the LEDGER claims for this card (short or full sha). */
  mergeCommit?: string | undefined;
  headSha?: string | undefined;
  /** Epoch ms the PR merged, when known. */
  mergedAtMs?: number | undefined;
}

/** PR-level facts read from the forge. `undefined` ⇒ never successfully read. */
export interface DeliveryPrFacts {
  merged: boolean;
  /** The forge's merge commit sha — must agree with the ledger's claim. */
  mergeCommitSha?: string | undefined;
  headSha?: string | undefined;
  mergedAtMs?: number | undefined;
}

/** Tri-state: a timing we cannot establish is stated as `unknown`, never as `no`. */
export type PostHocState = "yes" | "no" | "unknown";

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
   * Whether the fact was collected AFTER the card merged — i.e. whether the
   * report is a post-hoc reconstruction of delivery-time truth rather than
   * cycle-time evidence. `unknown` when the merge time could not be established
   * (never silently rendered as cycle-time).
   */
  postHoc: PostHocState;
  checks: DeliveryCheckRun[];
}

/**
 * ONLY a real successful execution verifies. `neutral` / `skipped` are not green
 * executions (codex r1) — they resolve to `unknown`, never to acceptance.
 */
const PASSING = new Set(["success"]);
/** Conclusions that are unambiguously a failure. */
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/** Guard the API target so a malformed ledger value cannot reroute the query. */
export function isValidCiTarget(target: { repoSlug?: string; prNumber?: number; sha?: string }): boolean {
  if (target.repoSlug !== undefined && !SLUG_RE.test(target.repoSlug)) return false;
  if (target.prNumber !== undefined && (!Number.isInteger(target.prNumber) || target.prNumber <= 0)) return false;
  if (target.sha !== undefined && !SHA_RE.test(target.sha)) return false;
  return true;
}

/** Two sha claims agree when one is a prefix of the other (ledger may be short). */
export function shaAgrees(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === "" || b === "") return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

export interface ResolveDeliveryCiInput {
  record?: DeliveryCiRecord | undefined;
  /** PR facts from the forge; `undefined` ⇒ the PR could not be read. */
  pr?: DeliveryPrFacts | undefined;
  /** `undefined` ⇒ the checks query itself could not be made (never "no checks"). */
  checks?: readonly DeliveryCheckRun[] | undefined;
  /**
   * Whether the check list is known COMPLETE (every page + the legacy commit
   * statuses read). `false` ⇒ a red could be hiding outside the window, so the
   * fact degrades to `unknown` (codex r1).
   */
  checksComplete?: boolean | undefined;
  ghAvailable: boolean;
  /** Caller-side validation of slug/pr/sha; `false` ⇒ refuse to attribute. */
  targetValid?: boolean | undefined;
  /** ISO timestamp of this collection. */
  collectedAt: string;
}

export function resolveDeliveryCi(input: ResolveDeliveryCiInput): DeliveryCiFact {
  const rec = input.record;
  const mergedAtMs = input.pr?.mergedAtMs ?? rec?.mergedAtMs;
  const collectedMs = Date.parse(input.collectedAt);
  const headSha = input.pr?.headSha ?? rec?.headSha;
  const postHoc: PostHocState =
    mergedAtMs !== undefined && Number.isFinite(mergedAtMs) && Number.isFinite(collectedMs)
      ? collectedMs > mergedAtMs
        ? "yes"
        : "no"
      : "unknown";
  const base: DeliveryCiFact = {
    state: "unknown",
    collectedAt: input.collectedAt,
    postHoc,
    checks: [],
    ...(rec?.prNumber !== undefined ? { prNumber: rec.prNumber } : {}),
    ...(headSha !== undefined && headSha !== "" ? { headSha } : {}),
    ...(rec?.mergeCommit !== undefined && rec.mergeCommit !== "" ? { mergeCommit: rec.mergeCommit } : {}),
    ...(mergedAtMs !== undefined && Number.isFinite(mergedAtMs)
      ? { mergedAt: new Date(mergedAtMs).toISOString() }
      : {}),
  };

  if (rec === undefined || rec.prNumber === undefined) return { ...base, reason: "no_delivery_record" };
  // A card that claims delivery without a merge commit has nothing to bind the
  // PR's checks to — refuse rather than trust the PR number alone.
  if (rec.mergeCommit === undefined || rec.mergeCommit === "") return { ...base, reason: "no_merge_commit" };
  if (!input.ghAvailable) return { ...base, reason: "gh_unavailable" };
  if (input.targetValid === false) return { ...base, reason: "invalid_target" };
  if (input.pr === undefined) return { ...base, reason: "pr_unavailable" };
  if (!input.pr.merged) return { ...base, reason: "pr_not_merged" };
  // The forge's merge sha must be the one the ledger credits to this card;
  // otherwise these checks belong to some other delivery.
  if (!shaAgrees(input.pr.mergeCommitSha, rec.mergeCommit)) return { ...base, reason: "merge_sha_mismatch" };
  if (input.checks === undefined) return { ...base, reason: "checks_unavailable" };
  if (input.checksComplete === false) return { ...base, reason: "checks_list_incomplete", checks: [...input.checks] };

  const checks = [...input.checks];
  if (checks.length === 0) return { ...base, reason: "no_checks_on_head_sha", checks };

  // A failure is terminal: reported as `red` even when other checks are still
  // running or the list is otherwise imperfect — a red must never hide.
  const failed = checks.filter((c) => FAILING.has(c.conclusion));
  if (failed.length > 0) {
    return { ...base, state: "red", reason: `checks_failed:${failed.map((c) => c.name).join(",")}`, checks };
  }
  // Anything that is not a real success (still running, neutral, skipped, an
  // unrecognised conclusion) leaves the delivery unproven.
  const unproven = checks.filter((c) => !PASSING.has(c.conclusion));
  if (unproven.length > 0) {
    return {
      ...base,
      reason: `checks_inconclusive:${unproven.map((c) => `${c.name}=${c.conclusion === "" ? "running" : c.conclusion}`).join(",")}`,
      checks,
    };
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
