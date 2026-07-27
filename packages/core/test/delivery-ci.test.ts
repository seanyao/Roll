/**
 * US-EVID-033 — card-level delivery-time CI truth: three honest states, no
 * synthesis, and a red check that can never hide behind "incomplete".
 */
import { describe, expect, it } from "vitest";
import { deliveryCiSummary, resolveDeliveryCi } from "../src/delivery/delivery-ci.js";

const MERGED_MS = Date.parse("2026-07-20T10:00:00Z");
const AFTER = "2026-07-27T09:00:00Z";
const BEFORE = "2026-07-20T09:00:00Z";
const record = { prNumber: 1490, mergeCommit: "32195061fb3e", headSha: "deadbeefcafe", mergedAtMs: MERGED_MS };

describe("resolveDeliveryCi — verified", () => {
  it("all checks successful ⇒ verified, with the card's own PR/sha bound", () => {
    const f = resolveDeliveryCi({
      record,
      checks: [
        { name: "test-ts", conclusion: "success" },
        { name: "lint", conclusion: "skipped" },
      ],
      ghAvailable: true,
      collectedAt: AFTER,
    });
    expect(f.state).toBe("verified");
    expect(f.reason).toBeUndefined();
    expect(f.prNumber).toBe(1490);
    expect(f.headSha).toBe("deadbeefcafe");
    expect(f.mergeCommit).toBe("32195061fb3e");
    expect(f.mergedAt).toBe("2026-07-20T10:00:00.000Z");
    expect(f.checks).toHaveLength(2);
  });

  it("labels a collection after the merge as post-hoc, before it as cycle-time", () => {
    const checks = [{ name: "test-ts", conclusion: "success" }];
    expect(resolveDeliveryCi({ record, checks, ghAvailable: true, collectedAt: AFTER }).postHoc).toBe(true);
    expect(resolveDeliveryCi({ record, checks, ghAvailable: true, collectedAt: BEFORE }).postHoc).toBe(false);
    // No merge time recorded ⇒ we cannot claim post-hoc; stays false.
    expect(
      resolveDeliveryCi({ record: { prNumber: 7 }, checks, ghAvailable: true, collectedAt: AFTER }).postHoc,
    ).toBe(false);
  });
});

describe("resolveDeliveryCi — red is terminal", () => {
  it("a failing check ⇒ red, naming the check", () => {
    const f = resolveDeliveryCi({
      record,
      checks: [
        { name: "test-ts", conclusion: "failure" },
        { name: "lint", conclusion: "success" },
      ],
      ghAvailable: true,
      collectedAt: AFTER,
    });
    expect(f.state).toBe("red");
    expect(f.reason).toBe("checks_failed:test-ts");
  });

  it("NEVER hides a failure behind an in-flight check", () => {
    const f = resolveDeliveryCi({
      record,
      checks: [
        { name: "slow", conclusion: "" },
        { name: "test-ts", conclusion: "timed_out" },
      ],
      ghAvailable: true,
      collectedAt: AFTER,
    });
    expect(f.state).toBe("red");
    expect(f.reason).toContain("test-ts");
  });

  it("treats cancelled / action_required / startup_failure as red", () => {
    for (const conclusion of ["cancelled", "action_required", "startup_failure"]) {
      const f = resolveDeliveryCi({
        record,
        checks: [{ name: "c", conclusion }],
        ghAvailable: true,
        collectedAt: AFTER,
      });
      expect(f.state, conclusion).toBe("red");
    }
  });
});

describe("resolveDeliveryCi — unknown carries its reason and never a pass", () => {
  it("no delivery record", () => {
    const f = resolveDeliveryCi({ ghAvailable: true, collectedAt: AFTER });
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("no_delivery_record");
    expect(f.checks).toEqual([]);
  });

  it("record without a PR number (merge sha only)", () => {
    const f = resolveDeliveryCi({ record: { mergeCommit: "abc1234" }, ghAvailable: true, collectedAt: AFTER });
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("no_delivery_record");
    expect(f.mergeCommit).toBe("abc1234");
  });

  it("gh unavailable (offline host) — not a failure, not a pass", () => {
    const f = resolveDeliveryCi({ record, ghAvailable: false, collectedAt: AFTER });
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("gh_unavailable");
  });

  it("the checks query could not be made (undefined) vs. no checks exist (empty)", () => {
    const unqueried = resolveDeliveryCi({ record, ghAvailable: true, collectedAt: AFTER });
    expect(unqueried.reason).toBe("checks_unavailable");
    const none = resolveDeliveryCi({ record, checks: [], ghAvailable: true, collectedAt: AFTER });
    expect(none.state).toBe("unknown");
    expect(none.reason).toBe("no_checks_on_head_sha");
  });

  it("checks still running ⇒ unknown, listing them", () => {
    const f = resolveDeliveryCi({
      record,
      checks: [{ name: "test-ts", conclusion: "" }],
      ghAvailable: true,
      collectedAt: AFTER,
    });
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("checks_incomplete:test-ts");
  });
});

describe("deliveryCiSummary", () => {
  it("is a one-line, machine-parseable digest", () => {
    const f = resolveDeliveryCi({
      record,
      checks: [{ name: "test-ts", conclusion: "success" }],
      ghAvailable: true,
      collectedAt: AFTER,
    });
    expect(deliveryCiSummary(f)).toBe("verified #1490@deadbeef — test-ts=success");
    const unknown = resolveDeliveryCi({ ghAvailable: false, collectedAt: AFTER });
    expect(deliveryCiSummary(unknown)).toBe("unknown no PR@no sha (no_delivery_record)");
  });
});
