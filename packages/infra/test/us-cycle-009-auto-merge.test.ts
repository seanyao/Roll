/**
 * US-CYCLE-009 — infra: auto-merge attach graceful-degrade + sha-pinned REST
 * merge fallback.
 */
import { describe, expect, it } from "vitest";
import {
  isAutoMergeUnavailable,
  isTransientGhError,
  runPublishPlan,
  type GhResult,
  type PublishStepLike,
  type RunStep,
} from "../src/github.js";

describe("US-CYCLE-009 isAutoMergeUnavailable (AC1 graceful degrade)", () => {
  it("recognizes repo-level auto-merge-disabled messages", () => {
    expect(isAutoMergeUnavailable("Auto-merge is not allowed for this repository")).toBe(true);
    expect(isAutoMergeUnavailable("auto-merge is not enabled")).toBe(true);
    expect(isAutoMergeUnavailable("This repository does not allow auto-merge")).toBe(true);
  });

  it("does not flag a transient EOF or an unrelated error as auto-merge-unavailable", () => {
    expect(isAutoMergeUnavailable(`Post "https://api.github.com/graphql": EOF`)).toBe(false);
    expect(isAutoMergeUnavailable("no admin permission")).toBe(false);
    // and the transient detector still owns the EOF.
    expect(isTransientGhError(`Post "https://api.github.com/graphql": EOF`)).toBe(true);
  });
});

function planWithPinnedAutoMerge(sha: string): PublishStepLike[] {
  return [
    { tool: "gh", kind: "gh-pr-view", argv: ["-R", "o/r", "pr", "view", "loop/cycle-x", "--json", "url", "-q", ".url"] },
    { tool: "gh", kind: "gh-pr-create", argv: ["-R", "o/r", "pr", "create", "--base", "main", "--head", "loop/cycle-x", "--title", "t", "--body", "b"] },
    {
      tool: "gh",
      kind: "gh-pr-merge-auto",
      argv: ["-R", "o/r", "pr", "merge", "loop/cycle-x", "--auto", "--squash", "--delete-branch", "--match-head-commit", sha],
    },
  ];
}

describe("US-CYCLE-009 runPublishPlan (AC1)", () => {
  it("head-sha-pins the REST merge fallback when the auto-merge attach EOFs", async () => {
    const restCalls: string[][] = [];
    const run: RunStep = async (tool, argv) => {
      if (argv.includes("pr") && argv.includes("view")) return { code: 1, stdout: "", stderr: "" };
      if (argv.includes("pr") && argv.includes("create")) {
        return { code: 0, stdout: "https://github.com/o/r/pull/9\n", stderr: "" };
      }
      if (argv.includes("pr") && argv.includes("merge")) {
        return { code: 1, stdout: "", stderr: `Post "https://api.github.com/graphql": EOF` };
      }
      if (argv.includes("api")) {
        restCalls.push([...argv]);
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const res = await runPublishPlan(planWithPinnedAutoMerge("cafef00d"), {
      ghAvailable: async () => true,
      run,
      sleep: async () => {},
      retries: 1,
    });
    expect(res.status).toBe(0);
    expect(res.prUrl).toBe("https://github.com/o/r/pull/9");
    // The REST fallback merged by NUMBER and PINNED the head sha.
    expect(restCalls).toHaveLength(1);
    const rest = restCalls[0]!;
    expect(rest).toContain("repos/o/r/pulls/9/merge");
    expect(rest).toContain("sha=cafef00d");
    expect(rest).toContain("merge_method=squash");
  });

  it("surfaces autoMergeUnavailable (non-fatal) when the repo forbids auto-merge", async () => {
    const run: RunStep = async (tool, argv) => {
      if (argv.includes("pr") && argv.includes("view")) return { code: 1, stdout: "", stderr: "" };
      if (argv.includes("pr") && argv.includes("create")) {
        return { code: 0, stdout: "https://github.com/o/r/pull/10\n", stderr: "" };
      }
      if (argv.includes("pr") && argv.includes("merge")) {
        return { code: 1, stdout: "", stderr: "Auto-merge is not allowed for this repository" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const res = await runPublishPlan(planWithPinnedAutoMerge("abc123"), {
      ghAvailable: async () => true,
      run,
      sleep: async () => {},
      retries: 1,
    });
    // Publish still succeeds (PR open); the flag lets the caller alert + let
    // reconcile self-merge once CI is green.
    expect(res.status).toBe(0);
    expect(res.ok).toBe(true);
    expect(res.prUrl).toBe("https://github.com/o/r/pull/10");
    expect(res.autoMergeUnavailable).toBe(true);
  });
});
