/**
 * US-CYCLE-009 — pure async-merge decision tests.
 */
import { describe, expect, it } from "vitest";
import type { RollEvent } from "@roll/spec";
import {
  planAutoMergeAttachArgv,
  matchHeadCommitSha,
  confirmMergeFromGitPlane,
  mayDeleteSourceBranch,
  nextWritebackRetry,
  shouldWriteBackOnMergeConfirmed,
  DEFAULT_WRITEBACK_MAX_ATTEMPTS,
  type GitPlaneMergeFacts,
} from "../src/index.js";

describe("US-CYCLE-009 planAutoMergeAttachArgv (AC1)", () => {
  it("head-sha-pins the auto-merge squash attach when a tip is given", () => {
    expect(planAutoMergeAttachArgv("o/r", "loop/cycle-x", "deadbeef")).toEqual([
      "-R", "o/r", "pr", "merge", "loop/cycle-x",
      "--auto", "--squash", "--delete-branch",
      "--match-head-commit", "deadbeef",
    ]);
  });

  it("drops the pin when the tip is unknown (backwards-compatible)", () => {
    const argv = planAutoMergeAttachArgv("o/r", "loop/cycle-x");
    expect(argv).not.toContain("--match-head-commit");
    expect(argv).toContain("--auto");
    expect(argv).toContain("--squash");
  });

  it("round-trips the pinned sha through matchHeadCommitSha", () => {
    const argv = planAutoMergeAttachArgv("o/r", "b", "cafe1234");
    expect(matchHeadCommitSha(argv)).toBe("cafe1234");
    expect(matchHeadCommitSha(planAutoMergeAttachArgv("o/r", "b"))).toBeUndefined();
  });
});

describe("US-CYCLE-009 confirmMergeFromGitPlane (AC2 — git plane only)", () => {
  const base: GitPlaneMergeFacts = {
    mainPatchIds: new Set(),
    branchPresentOnOrigin: true,
  };

  it("confirms via ancestor (branch tip reachable from main)", () => {
    expect(confirmMergeFromGitPlane({ ...base, branchTipIsAncestorOfMain: true })).toEqual({
      merged: true,
      signal: "ancestor",
    });
  });

  it("confirms via patch-id equivalence (squash-safe)", () => {
    expect(
      confirmMergeFromGitPlane({
        ...base,
        branchNetPatchId: "pid-1",
        mainPatchIds: new Set(["pid-1"]),
      }),
    ).toEqual({ merged: true, signal: "patch_id" });
  });

  it("ancestor wins over patch-id when both present", () => {
    expect(
      confirmMergeFromGitPlane({
        branchTipIsAncestorOfMain: true,
        branchNetPatchId: "pid-1",
        mainPatchIds: new Set(["pid-1"]),
        branchPresentOnOrigin: false,
      }).signal,
    ).toBe("ancestor");
  });

  it("confirms via merge_commit on main (squash + --delete-branch, branch gone)", () => {
    // The common post-merge state: branch deleted, so ancestor/patch-id cannot
    // fire — only the (#N) merge commit on main (git log) proves the delivery.
    expect(
      confirmMergeFromGitPlane({ ...base, branchPresentOnOrigin: false, mergeCommitOnMain: true }),
    ).toEqual({ merged: true, signal: "merge_commit" });
  });

  it("branch absence alone is NOT a merge (a branch can be deleted unmerged)", () => {
    expect(
      confirmMergeFromGitPlane({ ...base, branchPresentOnOrigin: false }),
    ).toEqual({ merged: false, signal: "none" });
    // deleted branch, no merge commit on main either → still not merged.
    expect(
      confirmMergeFromGitPlane({ ...base, branchPresentOnOrigin: false, mergeCommitOnMain: false }),
    ).toEqual({ merged: false, signal: "none" });
  });

  it("no git-plane evidence => not merged (never fabricate)", () => {
    expect(confirmMergeFromGitPlane(base)).toEqual({ merged: false, signal: "none" });
    expect(
      confirmMergeFromGitPlane({ ...base, branchNetPatchId: "pid-x", mainPatchIds: new Set(["other"]) }),
    ).toEqual({ merged: false, signal: "none" });
  });
});

describe("US-CYCLE-009 mayDeleteSourceBranch (AC3 delete gate)", () => {
  it("permits delete only after a verified merge", () => {
    expect(mayDeleteSourceBranch({ merged: true, signal: "ancestor" })).toBe(true);
    expect(mayDeleteSourceBranch({ merged: false, signal: "none" })).toBe(false);
  });
});

describe("US-CYCLE-009 nextWritebackRetry (AC3 bounded retry)", () => {
  it("retries with exponential backoff up to the bound then stops", () => {
    expect(nextWritebackRetry(0, { maxAttempts: 3, baseDelayMs: 250 })).toEqual({ retry: true, delayMs: 250, attempt: 0 });
    expect(nextWritebackRetry(1, { maxAttempts: 3, baseDelayMs: 250 })).toEqual({ retry: true, delayMs: 500, attempt: 1 });
    // attempt 2 is the last allowed try (maxAttempts-1) → no further retry.
    expect(nextWritebackRetry(2, { maxAttempts: 3, baseDelayMs: 250 })).toEqual({ retry: false, delayMs: 0, attempt: 2 });
  });

  it("defaults are bounded (never retries forever)", () => {
    const last = nextWritebackRetry(DEFAULT_WRITEBACK_MAX_ATTEMPTS - 1);
    expect(last.retry).toBe(false);
  });
});

describe("US-CYCLE-009 shouldWriteBackOnMergeConfirmed (AC4 idempotency)", () => {
  it("blocks a duplicate write-back once a delivered credit exists", () => {
    const credited: RollEvent[] = [
      { type: "delivery:published", cycleId: "c1", storyId: "US-1", branch: "loop/c1", prNumber: 5, prUrl: "u", ts: 1 },
      { type: "delivery:reconciled", cycleId: "c1", storyId: "US-1", state: "delivered_external", mergedBy: "external", mergeCommit: "sha", signal: "patch_id", ts: 2 },
    ];
    expect(shouldWriteBackOnMergeConfirmed(credited, "c1")).toBe(false);
    // A fresh cycle with no credit yet is still writable.
    expect(shouldWriteBackOnMergeConfirmed(credited, "c2")).toBe(true);
  });
});
