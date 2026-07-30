/**
 * FIX-1487 — the one judgement both self-driven merge paths use.
 *
 * roll merges its own PRs in two places (`release.ts` for the release PR,
 * `loop-reconcile.ts` for story PRs). Since the product repo moved to a private
 * repo on a plan without branch protection, those are the ONLY gates that can
 * refuse a red merge — GitHub will happily merge anything.
 *
 * Both used to ask "is there any failure among the conclusions?", which treats
 * a check that never ran as a check that passed. `ci.yml` already carries an
 * `if:` that can skip the entire `test-ts` job, so "skipped therefore green"
 * was reachable, not theoretical.
 *
 * The rule here is narrower and harder: the REQUIRED check must be present on
 * this exact sha and must have concluded `success`. Other checks may still be
 * skipped or neutral — an unrelated job opting out is normal — but any other
 * check that outright FAILED still blocks.
 */

/** One check-run conclusion as GitHub reports it (null while still running). */
export interface CheckConclusion {
  name: string;
  /** `success` | `failure` | `skipped` | `neutral` | … ; null/undefined = not finished. */
  conclusion?: string | null;
}

export interface RequiredCheckVerdict {
  ok: boolean;
  reason: "passed" | "pending" | "required-check-absent" | "required-check-not-successful" | "other-check-failed";
  detail?: string;
}

/** Conclusions that are acceptable for a NON-required check. */
const TOLERATED_FOR_OTHERS = new Set(["success", "skipped", "neutral"]);

/**
 * Decide whether `checks` (all of them for one commit) permit a merge.
 *
 * Ordering matters: "still running" is reported before any refusal that the
 * caller might act on permanently, so a poller waits instead of giving up.
 */
export function requiredCheckVerdict(checks: readonly CheckConclusion[], requiredName: string): RequiredCheckVerdict {
  const required = checks.filter((c) => c.name === requiredName);
  if (required.length === 0) {
    return {
      ok: false,
      reason: "required-check-absent",
      detail: `required check "${requiredName}" did not run on this commit — a gate that never ran is not a gate that passed`,
    };
  }
  if (required.some((c) => c.conclusion == null)) return { ok: false, reason: "pending" };

  const notSuccess = required.filter((c) => c.conclusion !== "success");
  if (notSuccess.length > 0) {
    return {
      ok: false,
      reason: "required-check-not-successful",
      detail: `required check "${requiredName}" concluded ${notSuccess.map((c) => c.conclusion).join(", ")}`,
    };
  }

  // Other checks: still running → wait; outright failure → block; skipped/neutral → fine.
  const others = checks.filter((c) => c.name !== requiredName);
  if (others.some((c) => c.conclusion == null)) return { ok: false, reason: "pending" };
  const failed = others.filter((c) => !TOLERATED_FOR_OTHERS.has(String(c.conclusion)));
  if (failed.length > 0) {
    return {
      ok: false,
      reason: "other-check-failed",
      detail: failed.map((c) => `${c.name}=${c.conclusion}`).join(", "),
    };
  }
  return { ok: true, reason: "passed" };
}

/** The check every roll repo gates on; overridable per repo via config later. */
export const DEFAULT_REQUIRED_CHECK = "test-ts";
