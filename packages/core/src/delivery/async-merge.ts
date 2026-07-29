/**
 * US-CYCLE-009 — async delivery: take PR merge + reconcile OFF the critical path.
 *
 * The cycle runner, after opening a PR, ATTACHES auto-merge and RETURNS
 * immediately (it never blocks on CI). GitHub merges the PR when its checks go
 * green; a later `git fetch` / `git ls-remote` observation confirms the merge on
 * the GIT PLANE, and THAT confirmation — never a `gh` stdout grep — drives the
 * reconcile write-back (backlog flip + evidence + roll-meta push).
 *
 * This module holds the PURE decisions of that flow (no filesystem, no network,
 * no clock, no side effects — exhaustively unit-testable):
 *   - {@link planAutoMergeAttachArgv} / {@link matchHeadCommitSha} — the
 *     head-sha-pinned `gh pr merge --auto --squash` attach argv (AC1).
 *   - {@link confirmMergeFromGitPlane} — merge truth ONLY from git-plane facts
 *     (branch tip is an ancestor of main, or the branch net patch-id is on
 *     main). NEVER a `gh` stdout grep (AC2).
 *   - {@link mayDeleteSourceBranch} — the source branch is deletable ONLY after a
 *     verified merge (AC3).
 *   - {@link nextWritebackRetry} — bounded retry schedule for the write-back
 *     (AC3).
 *   - {@link shouldWriteBackOnMergeConfirmed} — idempotency: a duplicate
 *     merge-confirmed observation must NOT double-flip (AC4).
 */

import type { RollEvent } from "@roll/spec";
import { shouldAppendDeliveredCredit } from "./reconcile-guards.js";

// ── AC1: head-sha-pinned auto-merge attach ─────────────────────────────────────

/**
 * The argv for `gh pr merge <ref> --auto --squash --delete-branch
 * [--match-head-commit <sha>]` — the auto-merge ATTACH the runner arms after
 * opening a PR. `--auto` does NOT block: GitHub merges when required checks pass;
 * the runner returns immediately.
 *
 * head-sha-pinning (`--match-head-commit`) is the fix for the PR-API-head-lag
 * trap (memory-grounded): the PR API's reported head can lag the real branch
 * tip, so the pin MUST come from the git plane (the sha we just pushed / a
 * `git ls-remote` read), never the PR view. When `headSha` is omitted the pin is
 * dropped (backwards-compatible with callers that cannot resolve a tip).
 */
export function planAutoMergeAttachArgv(
  slug: string,
  ref: string,
  headSha?: string,
): string[] {
  const argv = ["-R", slug, "pr", "merge", ref, "--auto", "--squash", "--delete-branch"];
  if (headSha !== undefined && headSha !== "") argv.push("--match-head-commit", headSha);
  return argv;
}

/** Extract the `--match-head-commit <sha>` pin from a merge argv, or undefined. */
export function matchHeadCommitSha(argv: readonly string[]): string | undefined {
  const i = argv.indexOf("--match-head-commit");
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// ── AC2: merge confirmation from the git plane ONLY ────────────────────────────

/**
 * Git-plane facts about a cycle branch — gathered from `git fetch` /
 * `git ls-remote` / `git merge-base` / `git patch-id`, NEVER from `gh` stdout.
 */
export interface GitPlaneMergeFacts {
  /**
   * `git merge-base --is-ancestor origin/<branch> origin/main` exit 0 — the
   * branch tip is reachable from main (a fast-forward / merge-commit merge).
   * Undefined when the branch ref could not be resolved.
   */
  branchTipIsAncestorOfMain?: boolean;
  /** `git patch-id(diff origin/main...origin/<branch>)` — the branch's net diff. */
  branchNetPatchId?: string;
  /** patch-ids of main's commits not on the branch (squash/rebase-safe match). */
  mainPatchIds: ReadonlySet<string>;
  /**
   * Is `origin/<branch>` still present on the remote? A squash merge with
   * `--delete-branch` removes it. Absence ALONE never proves a merge (a branch
   * can be deleted unmerged), so this is corroborating context, not a signal.
   */
  branchPresentOnOrigin: boolean;
  /**
   * Is the PR's merge commit reachable on main? Derived from MAIN'S GIT LOG (a
   * `(#N)` squash commit for the recorded PR, or a story-named commit for a
   * PR-less legacy cycle — the offline-L1 evidence, `offlineMergeEvidence`).
   * This is STILL the git plane (main's commit log, never `gh` stdout) and is the
   * ONLY signal that survives a squash merge with `--delete-branch` — the common
   * post-merge state where the branch is gone so ancestor/patch-id cannot fire.
   */
  mergeCommitOnMain?: boolean;
}

/** Which git-plane fact confirmed the merge. */
export type MergeConfirmSignal = "ancestor" | "patch_id" | "merge_commit" | "none";

/** The result of a git-plane merge check. `merged:false` ⇒ signal `"none"`. */
export interface MergeConfirmation {
  merged: boolean;
  signal: MergeConfirmSignal;
}

/**
 * Confirm a merge from GIT-PLANE facts ONLY (AC2). A merge is confirmed iff:
 *   - the branch tip is an ancestor of main (`ancestor`), OR
 *   - the branch's net patch-id is present on main (`patch_id`, squash-safe), OR
 *   - the PR's merge commit is reachable on main (`merge_commit` — main's git
 *     log; the only signal that survives a squash merge with `--delete-branch`).
 * The ancestor signal is checked first (most direct); patch-id next (branch still
 * present); merge_commit last (branch deleted). Branch absence on the remote is
 * NEVER sufficient on its own — a branch can be deleted without merging.
 *
 * Pure and deterministic. It NEVER inspects a `gh` result: the false-positive
 * history of grepping `gh` stdout is precisely why merge truth lives on the git
 * plane. (`merge_commit` reads MAIN'S commit log — git, not gh.)
 */
export function confirmMergeFromGitPlane(facts: GitPlaneMergeFacts): MergeConfirmation {
  if (facts.branchTipIsAncestorOfMain === true) {
    return { merged: true, signal: "ancestor" };
  }
  if (
    facts.branchNetPatchId !== undefined &&
    facts.mainPatchIds.has(facts.branchNetPatchId)
  ) {
    return { merged: true, signal: "patch_id" };
  }
  if (facts.mergeCommitOnMain === true) {
    return { merged: true, signal: "merge_commit" };
  }
  return { merged: false, signal: "none" };
}

// ── AC3: source-branch delete gate ─────────────────────────────────────────────

/**
 * The source branch may be deleted ONLY after the merge is verified on the git
 * plane (AC3). Deleting an un-merged branch would discard un-landed work — so a
 * non-`merged` confirmation is a hard no.
 */
export function mayDeleteSourceBranch(confirmation: MergeConfirmation): boolean {
  return confirmation.merged;
}

// ── AC3: bounded write-back retry ──────────────────────────────────────────────

/** One step of the bounded write-back retry schedule. */
export interface RetryDecision {
  /** Should the caller retry after this attempt? */
  retry: boolean;
  /** Backoff before the next attempt (ms). 0 when `retry` is false. */
  delayMs: number;
  /** The 0-based attempt index this decision is for. */
  attempt: number;
}

/** Default bound: 3 attempts total (the first + 2 retries). */
export const DEFAULT_WRITEBACK_MAX_ATTEMPTS = 3;
/** Default base backoff (ms) — doubles each retry (250 / 500). */
export const DEFAULT_WRITEBACK_BASE_DELAY_MS = 250;

/**
 * Decide whether to retry the reconcile write-back after a failed `attempt`
 * (0-based), with an exponential backoff. Bounded: once `attempt` reaches
 * `maxAttempts - 1` (the last allowed try), `retry` is false and the caller must
 * ALERT on exhaustion (AC3). Pure — the caller owns the clock/sleep.
 */
export function nextWritebackRetry(
  attempt: number,
  opts: { maxAttempts?: number; baseDelayMs?: number } = {},
): RetryDecision {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_WRITEBACK_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_WRITEBACK_BASE_DELAY_MS;
  const willRetry = attempt < maxAttempts - 1;
  return {
    retry: willRetry,
    delayMs: willRetry ? baseDelayMs * 2 ** attempt : 0,
    attempt,
  };
}

// ── AC4: idempotency ───────────────────────────────────────────────────────────

/**
 * Whether the reconcile write-back should run for this cycle given the current
 * event stream (AC4). A cycle that already carries a credited
 * `delivery:reconciled` event must NOT be flipped again — a duplicate
 * merge-confirmed observation is a no-op. Delegates to the shared reconcile
 * idempotency guard so the async path and the polling path converge on the SAME
 * single-credit invariant.
 */
export function shouldWriteBackOnMergeConfirmed(
  events: readonly RollEvent[],
  cycleId: string,
): boolean {
  return shouldAppendDeliveredCredit(events, cycleId);
}
