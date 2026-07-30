/**
 * FIX-1487 — "the gate didn't run" is not "the gate is green".
 *
 * With no server-side branch protection (private repo, Free plan), roll's own
 * self-driven merge is the ONLY thing that can refuse a red PR. Both merge
 * paths judged CI by "no failure among the conclusions", which lets two things
 * through:
 *
 *   - a REQUIRED check that was skipped — and `ci.yml` already carries an `if:`
 *     that can skip the whole `test-ts` job, so this is reachable today;
 *   - a required check that never appeared at all.
 *
 * `skipped` stays acceptable for OTHER checks — an unrelated job that opts out
 * is normal. What tightens is the required check itself.
 */
import { describe, expect, it } from "vitest";

import { requiredCheckVerdict } from "../src/delivery/required-check.js";

const REQUIRED = "test-ts";

describe("FIX-1487 — the required check must have run AND passed", () => {
  it("passes when the required check succeeded", () => {
    const v = requiredCheckVerdict([{ name: REQUIRED, conclusion: "success" }], REQUIRED);
    expect(v).toEqual({ ok: true, reason: "passed" });
  });

  it("refuses when the required check is ABSENT — distinct from failure", () => {
    const v = requiredCheckVerdict([{ name: "lint", conclusion: "success" }], REQUIRED);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("required-check-absent");
    // The message must not read as a failure — the fix is to make it run.
    expect(v.detail).toContain(REQUIRED);
  });

  it("refuses when the required check was SKIPPED (the reachable bypass)", () => {
    for (const conclusion of ["skipped", "neutral"]) {
      const v = requiredCheckVerdict([{ name: REQUIRED, conclusion }], REQUIRED);
      expect(v.ok, `${conclusion} must not count as green`).toBe(false);
      expect(v.reason).toBe("required-check-not-successful");
    }
  });

  it("refuses when the required check failed", () => {
    const v = requiredCheckVerdict([{ name: REQUIRED, conclusion: "failure" }], REQUIRED);
    expect(v).toMatchObject({ ok: false, reason: "required-check-not-successful" });
  });

  it("waits while the required check is still running", () => {
    const v = requiredCheckVerdict([{ name: REQUIRED, conclusion: null }], REQUIRED);
    expect(v).toMatchObject({ ok: false, reason: "pending" });
  });

  it("still tolerates skipped/neutral on OTHER checks", () => {
    const v = requiredCheckVerdict(
      [
        { name: REQUIRED, conclusion: "success" },
        { name: "browser-live", conclusion: "skipped" },
        { name: "codeql", conclusion: "neutral" },
      ],
      REQUIRED,
    );
    expect(v.ok).toBe(true);
  });

  it("refuses when ANY other check failed, even with the required one green", () => {
    const v = requiredCheckVerdict(
      [
        { name: REQUIRED, conclusion: "success" },
        { name: "lint", conclusion: "failure" },
      ],
      REQUIRED,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("other-check-failed");
    expect(v.detail).toContain("lint");
  });

  it("refuses an empty check list rather than treating it as nothing-wrong", () => {
    expect(requiredCheckVerdict([], REQUIRED)).toMatchObject({ ok: false, reason: "required-check-absent" });
  });
});

describe("FIX-1488 — the required gate is a SET, not a name", () => {
  it("requires EVERY name in the set to have run and passed", () => {
    const both = [
      { name: "test-ts", conclusion: "success" },
      { name: "doc-drift", conclusion: "success" },
    ];
    expect(requiredCheckVerdict(both, ["test-ts", "doc-drift"]).ok).toBe(true);
  });

  it("refuses when one member of the set never ran — names which", () => {
    const v = requiredCheckVerdict([{ name: "test-ts", conclusion: "success" }], ["test-ts", "doc-drift"]);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("required-check-absent");
    expect(v.detail).toContain("doc-drift");
    expect(v.detail, "must not blame the check that did run").not.toContain('"test-ts"');
  });

  it("refuses when one member of the set was skipped", () => {
    const v = requiredCheckVerdict(
      [
        { name: "test-ts", conclusion: "success" },
        { name: "doc-drift", conclusion: "skipped" },
      ],
      ["test-ts", "doc-drift"],
    );
    expect(v).toMatchObject({ ok: false, reason: "required-check-not-successful" });
    expect(v.detail).toContain("doc-drift=skipped");
  });

  it("waits when one member of the set is still running", () => {
    const v = requiredCheckVerdict(
      [
        { name: "test-ts", conclusion: "success" },
        { name: "doc-drift", conclusion: null },
      ],
      ["test-ts", "doc-drift"],
    );
    expect(v.reason).toBe("pending");
  });

  it("refuses an empty set rather than merging on no gate at all", () => {
    expect(requiredCheckVerdict([{ name: "test-ts", conclusion: "success" }], [])).toMatchObject({
      ok: false,
      reason: "required-check-absent",
    });
  });

  it("keeps the single-name form working (soft period has one gate)", () => {
    expect(requiredCheckVerdict([{ name: "test-ts", conclusion: "success" }], "test-ts").ok).toBe(true);
  });
});
