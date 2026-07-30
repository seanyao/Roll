/**
 * FIX-1052 — GitHub PR status provider adapter.
 *
 * Implements the {@link PrStatusProvider} interface from `@roll/core` using the
 * existing `gh` CLI wrappers (US-INFRA-003). The core policy is provider-agnostic;
 * this module is the GitHub-specific implementation and can be replaced by a
 * Gitea/Bitbucket adapter without touching the reconcile logic.
 *
 * The adapter maps `gh pr view --json state,mergedAt,mergeCommit,number,url`
 * plus the union of `gh run list` (Actions runs) and
 * `gh pr view --json statusCheckRollup` (check-runs + commit statuses,
 * FIX-1248) for CI state onto the {@link PrCloudState} vocabulary.
 */
import type { PrCloudState, PrCiState, PrStatusProvider } from "@roll/core";
import { runList, prViewMergeInfo, prViewStatusCheckRollup, type StatusCheckRollupEntry } from "./github.js";

/** Build a slug from an `owner/repo` string; defensive trim. */
function normalizeSlug(slug: string): string {
  return slug.trim();
}

/**
 * Reduce a `gh run list` result to one of the three CI states the reconciler
 * cares about. Mirrors the `reduceCiRollup` semantics in `@roll/core/loop/pr-loop`
 * but over the `gh run list --json conclusion` shape.
 */
export function reduceRunConclusions(conclusions: (string | null | undefined)[]): PrCiState {
  if (conclusions.length === 0) return "unknown";
  if (conclusions.some((c) => c === "failure" || c === "FAILURE")) return "red";
  if (conclusions.every((c) => c === "success" || c === "SKIPPED" || c === null || c === undefined)) {
    // All success/skipped → green. Null/undefined entries mean some runs haven't
    // reported yet, so treat as pending instead of green.
    return conclusions.some((c) => c === null || c === undefined) ? "pending" : "green";
  }
  return "pending";
}

/** Check-run conclusions that count as green. */
const GREEN_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * FIX-1248 — reduce one `statusCheckRollup` entry (check-run OR status context)
 * to a per-check state: "red" | "pending" | "green". Conservative: any
 * completed non-success conclusion and any FAILURE/ERROR context is red;
 * anything not finished yet is pending.
 */
function reduceRollupEntry(e: StatusCheckRollupEntry): "red" | "pending" | "green" {
  if (e.__typename === "StatusContext") {
    const state = e.state ?? "";
    if (state === "FAILURE" || state === "ERROR") return "red";
    if (state === "SUCCESS") return "green";
    return "pending"; // PENDING or anything unrecognized → not finished
  }
  // CheckRun (Actions or third-party Checks API).
  if (e.status !== "COMPLETED") return "pending";
  const conclusion = e.conclusion;
  if (conclusion == null) return "pending";
  return GREEN_CONCLUSIONS.has(conclusion) ? "green" : "red";
}

/**
 * FIX-1248 — reduce `gh pr view --json statusCheckRollup` (the authoritative
 * union of check-runs + commit statuses) to a {@link PrCiState}. Empty rollup
 * → unknown; any red → red; any pending → pending; otherwise green.
 */
export function reduceStatusCheckRollup(entries: StatusCheckRollupEntry[]): PrCiState {
  if (entries.length === 0) return "unknown";
  const states = entries.map(reduceRollupEntry);
  if (states.some((s) => s === "red")) return "red";
  if (states.some((s) => s === "pending")) return "pending";
  return "green";
}

/**
 * FIX-1248 — merge the CI states of the two detection sources (Actions runs +
 * statusCheckRollup) conservatively: any red → red; else any pending → pending;
 * else both unknown → unknown; otherwise at least one source is fully green →
 * green. Green is never widened: a source with no checks (unknown) cannot
 * override the other source's red/pending.
 */
export function mergeCiStates(a: PrCiState, b: PrCiState): PrCiState {
  if (a === "red" || b === "red") return "red";
  if (a === "pending" || b === "pending") return "pending";
  if (a === "unknown" && b === "unknown") return "unknown";
  return "green";
}

/**
 * GitHub-specific {@link PrStatusProvider}. Polls via the `gh` CLI and maps the
 * response to the provider-agnostic {@link PrCloudState}.
 */
export class GitHubPrStatusProvider implements PrStatusProvider {
  readonly name = "github";

  /**
   * Poll one PR's cloud state.
   *
   * @param slug - `owner/repo`.
   * @param prNumber - PR number.
   * @returns {@link PrCloudState}.
   */
  async pollPrStatus(slug: string, prNumber: number): Promise<PrCloudState> {
    const s = normalizeSlug(slug);
    const info = await prViewMergeInfo(s, String(prNumber));
    const checkedAt = new Date().toISOString();

    if (info === undefined) {
      return { kind: "unreachable", reason: "not_found", checkedAt };
    }

    const state = info.state;

    if (state === "MERGED") {
      return {
        kind: "merged",
        mergeCommit: info.mergeCommit ?? "",
        mergedAt: info.mergedAt ?? checkedAt,
        checkedAt,
      };
    }

    if (state === "CLOSED") {
      return { kind: "closed_unmerged", closedAt: info.mergedAt ?? checkedAt, checkedAt };
    }

    if (state === "OPEN") {
      // FIX-1248: CI state is the union of BOTH GitHub check kinds — Actions
      // workflow runs (`gh run list`) AND commit statuses / non-Actions
      // check-runs (`statusCheckRollup`). Reading only runs misjudged a
      // status-only green PR as unknown → never merged.
      // FIX-1258: query runs by the PR's current head commit SHA instead of
      // branch name so force-pushed old-head failures don't suppress new-head
      // green runs. Falls back to branch-based query if headRefOid is missing.
      const [runs, rollup] = await Promise.all([
        info.headRefOid !== undefined
          ? runList(s, "conclusion", { commit: info.headRefOid })
          : info.headRefName !== undefined
            ? runList(s, "conclusion", { branch: info.headRefName })
            : Promise.resolve([]),
        prViewStatusCheckRollup(s, String(prNumber)),
      ]);
      const ci = mergeCiStates(
        reduceRunConclusions(runs.map((r) => r.conclusion)),
        reduceStatusCheckRollup(rollup),
      );
      // FIX-1487: surface the sha the CI verdict was computed FROM, so the
      // merge can pin it and never land something pushed after the check.
      return { kind: "open", ci, draft: info.isDraft, mergeable: info.mergeable, checkedAt, headSha: info.headRefOid };
    }

    // UNKNOWN or any unexpected string → treat as unreachable provider_error so
    // the bounded loop retries rather than giving up.
    return { kind: "unreachable", reason: "provider_error", checkedAt };
  }
}

/** Default singleton for callers that do not need to inject a custom provider. */
export const githubPrStatusProvider = new GitHubPrStatusProvider();
