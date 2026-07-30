/**
 * US-DELIV-014 — merging without GitHub's auto-merge.
 *
 * The product repo moved to an org whose plan cannot give a private repo branch
 * protection, and GitHub's auto-merge requires it. `roll release` therefore has
 * to merge the release PR itself — which means it also has to re-create, in
 * code, the two things branch protection used to guarantee:
 *
 *   1. NEVER merge unless every check concluded successfully. There is no
 *      server-side gate behind this anymore; a bug here merges red code.
 *   2. Pin the sha. `git ls-remote` is the real tip — the PR API's head lags,
 *      and an unpinned squash merge has landed a stale head in this repo before.
 */
import { describe, expect, it } from "vitest";

import { autoMergeUnavailable, selfDrivenMerge } from "../src/commands/release.js";

const TIP = "a".repeat(40);

/** gh seam: canned check-run conclusions, and a recorder for the merge call. */
function ghWith(conclusions: string[], merged = "true", calls: string[][] = []) {
  return {
    calls,
    gh: (args: string[]) => {
      calls.push(args);
      if (args.some((a) => a.includes("check-runs"))) return { code: 0, stdout: `${conclusions.join("\n")}\n`, stderr: "" };
      return { code: 0, stdout: `${merged}\n`, stderr: "" };
    },
  };
}

const base = { slug: "BIPOSVC/ape-roll", prNum: "42", branch: "release/v1.2.3" };
const lsRemote = () => `${TIP}\trefs/heads/release/v1.2.3\n`;

describe("US-DELIV-014 — self-driven merge refuses anything but green", () => {
  it("merges when every check succeeded, pinning the real tip sha", () => {
    const { gh, calls } = ghWith(["success", "skipped"]);
    const res = selfDrivenMerge({ ...base, lsRemote, gh });
    expect(res).toEqual({ merged: true, reason: "merged" });
    const merge = calls.find((c) => c.includes("--method"));
    expect(merge, "no merge call recorded").toBeDefined();
    expect(merge).toContain(`sha=${TIP}`);
    expect(merge).toContain("merge_method=squash");
  });

  it("does NOT merge while a check is still running", () => {
    const { gh, calls } = ghWith(["success", "null"]);
    expect(selfDrivenMerge({ ...base, lsRemote, gh })).toEqual({ merged: false, reason: "pending" });
    expect(calls.some((c) => c.includes("--method")), "merged while a check was pending").toBe(false);
  });

  it("does NOT merge when a check failed — and says which", () => {
    const { gh, calls } = ghWith(["success", "failure"]);
    const res = selfDrivenMerge({ ...base, lsRemote, gh });
    expect(res.merged).toBe(false);
    expect(res.reason).toBe("checks-failed");
    expect(res.detail).toContain("failure");
    expect(calls.some((c) => c.includes("--method")), "merged over a failed check").toBe(false);
  });

  it("does NOT merge when no checks exist at all", () => {
    const { gh, calls } = ghWith([]);
    expect(selfDrivenMerge({ ...base, lsRemote, gh }).reason).toBe("no-checks");
    expect(calls.some((c) => c.includes("--method"))).toBe(false);
  });

  it("does NOT merge when the branch tip cannot be resolved", () => {
    const { gh, calls } = ghWith(["success"]);
    const res = selfDrivenMerge({ ...base, lsRemote: () => "", gh });
    expect(res).toMatchObject({ merged: false, reason: "no-tip" });
    expect(calls.length, "asked GitHub anything without a tip").toBe(0);
  });

  it("reports a rejected merge instead of claiming success", () => {
    const gh = (args: string[]) =>
      args.some((a) => a.includes("check-runs"))
        ? { code: 0, stdout: "success\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "422 Base branch was modified\n" };
    const res = selfDrivenMerge({ ...base, lsRemote, gh });
    expect(res.merged).toBe(false);
    expect(res.reason).toBe("merge-rejected");
    expect(res.detail).toContain("422");
  });
});

describe("US-DELIV-014 — capability detection picks the mode", () => {
  it("recognises the refusals that mean this repo has no auto-merge", () => {
    for (const msg of [
      'auto-merge is not enabled on this repo. Enable "Allow auto-merge" …',
      "Allow auto-merge must be enabled",
      "Upgrade to GitHub Pro or make this repository public to enable this feature.",
      "protected branch rules are required",
    ]) {
      expect(autoMergeUnavailable(msg), msg).toBe(true);
    }
  });

  it("does not mistake an unrelated failure for a missing capability", () => {
    // A network/API error must still abort the release, not silently switch modes.
    for (const msg of ["could not arm auto-merge on PR 42: EOF", "GraphQL: something went wrong"]) {
      expect(autoMergeUnavailable(msg), msg).toBe(false);
    }
  });
});
