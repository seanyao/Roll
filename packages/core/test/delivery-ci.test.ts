/**
 * US-EVID-033 — card-level delivery-time CI truth: three honest states, no
 * synthesis, a red that can never hide, and (codex review r1) a `verified` that
 * requires a MERGED PR whose merge sha agrees with the ledger, a COMPLETE check
 * list, and real `success` executions — nothing weaker.
 */
import { describe, expect, it } from "vitest";
import {
  collapseLatestChecks,
  deliveryCiSummary,
  isValidCiTarget,
  resolveDeliveryCi,
  shaAgrees,
  type ResolveDeliveryCiInput,
} from "../src/delivery/delivery-ci.js";

const MERGE_SHA = "32195061fb3ec0f31a26ced91c4c375168ec2dfb";
const MERGED_MS = Date.parse("2026-07-20T10:00:00Z");
const AFTER = "2026-07-27T09:00:00Z";
const BEFORE = "2026-07-20T09:00:00Z";

const record = { prNumber: 1490, mergeCommit: "32195061" };
const pr = { merged: true, mergeCommitSha: MERGE_SHA, headSha: "deadbeefcafe1234", mergedAtMs: MERGED_MS };
const PRE_MERGE_MS = Date.parse("2026-07-20T09:50:00Z"); // 10 min before the merge
const green = [{ name: "test-ts", conclusion: "success", completedAtMs: PRE_MERGE_MS }];
const REQUIRED = [{ context: "test-ts" }];

/** A fully verifiable input; each test perturbs exactly one dimension. */
function ok(over: Partial<ResolveDeliveryCiInput> = {}): ResolveDeliveryCiInput {
  return {
    record,
    pr,
    checks: green,
    checksComplete: true,
    requiredChecks: REQUIRED,
    requiredChecksKnown: true,
    ghAvailable: true,
    targetValid: true,
    collectedAt: AFTER,
    ...over,
  };
}

describe("resolveDeliveryCi — verified requires every guard to hold", () => {
  it("merged PR + agreeing merge sha + complete list + all success ⇒ verified", () => {
    const f = resolveDeliveryCi(ok());
    expect(f.state).toBe("verified");
    expect(f.reason).toBeUndefined();
    expect(f.prNumber).toBe(1490);
    expect(f.headSha).toBe("deadbeefcafe1234");
    expect(f.mergeCommit).toBe("32195061");
    expect(f.mergedAt).toBe("2026-07-20T10:00:00.000Z");
    expect(f.checks).toEqual(green);
  });

  it("post-hoc is a tri-state: after merge yes, before merge no, unknowable unknown", () => {
    expect(resolveDeliveryCi(ok()).postHoc).toBe("yes");
    expect(resolveDeliveryCi(ok({ collectedAt: BEFORE })).postHoc).toBe("no");
    // No merge time anywhere ⇒ we must NOT claim cycle-time, AND (codex r2) there
    // is no boundary between delivery-time evidence and a later rerun, so the
    // fact cannot be verified at all.
    const noTime = resolveDeliveryCi(ok({ pr: { merged: true, mergeCommitSha: MERGE_SHA, headSha: "abc1234" } }));
    expect(noTime.postHoc).toBe("unknown");
    expect(noTime.state).toBe("unknown");
    expect(noTime.reason).toBe("merge_time_unknown");
  });
});

describe("resolveDeliveryCi — red is terminal", () => {
  it("a failing check ⇒ red, naming the check", () => {
    const f = resolveDeliveryCi(
      ok({ checks: [{ name: "test-ts", conclusion: "failure", completedAtMs: PRE_MERGE_MS }] }),
    );
    expect(f.state).toBe("red");
    expect(f.reason).toBe("checks_failed:test-ts");
  });

  it("NEVER hides a failure behind an in-flight check", () => {
    const f = resolveDeliveryCi(
      ok({
        checks: [
          { name: "slow", conclusion: "" },
          { name: "test-ts", conclusion: "timed_out", completedAtMs: PRE_MERGE_MS },
        ],
      }),
    );
    expect(f.state).toBe("red");
    expect(f.reason).toContain("test-ts");
  });

  it("treats cancelled / action_required / startup_failure as red", () => {
    for (const conclusion of ["cancelled", "action_required", "startup_failure"]) {
      expect(
        resolveDeliveryCi(ok({ checks: [{ name: "c", conclusion, completedAtMs: PRE_MERGE_MS }] })).state,
        conclusion,
      ).toBe("red");
    }
  });

  it("a red commit STATUS folded in as a failure conclusion is still red", () => {
    const f = resolveDeliveryCi(
      ok({ checks: [...green, { name: "legacy/status", conclusion: "failure", completedAtMs: PRE_MERGE_MS }] }),
    );
    expect(f.state).toBe("red");
    expect(f.reason).toContain("legacy/status");
  });
});

describe("resolveDeliveryCi — only a real success verifies", () => {
  it("neutral and skipped are NOT green executions ⇒ unknown, not verified", () => {
    for (const conclusion of ["neutral", "skipped"]) {
      const f = resolveDeliveryCi(
        ok({ checks: [{ name: "c", conclusion, completedAtMs: PRE_MERGE_MS }], requiredChecks: [{ context: "c" }] }),
      );
      expect(f.state, conclusion).toBe("unknown");
      expect(f.reason, conclusion).toContain("required_missing");
    }
  });

  it("a still-running check leaves the delivery unproven", () => {
    const f = resolveDeliveryCi(ok({ checks: [{ name: "test-ts", conclusion: "", completedAtMs: PRE_MERGE_MS }] }));
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("required_missing:test-ts");
  });

  it("an unrecognised conclusion is unproven, never assumed green", () => {
    // No required set declared ⇒ every observed check must be a real success.
    const f = resolveDeliveryCi(
      ok({
        checks: [{ name: "c", conclusion: "something_new", completedAtMs: PRE_MERGE_MS }],
        requiredChecks: [],
      }),
    );
    expect(f.state).toBe("unknown");
    expect(f.reason).toContain("something_new");
  });
});

describe("resolveDeliveryCi — every doubt resolves to unknown with a reason", () => {
  const cases: Array<[string, Partial<ResolveDeliveryCiInput>, string]> = [
    ["no delivery record at all", { record: undefined }, "no_delivery_record"],
    ["record without a PR number", { record: { mergeCommit: "abc1234" } }, "no_delivery_record"],
    ["record without a merge commit (in-flight claim)", { record: { prNumber: 7 } }, "no_merge_commit"],
    ["gh unavailable (offline host)", { ghAvailable: false }, "gh_unavailable"],
    ["invalid API target", { targetValid: false }, "invalid_target"],
    ["PR could not be read", { pr: undefined }, "pr_unavailable"],
    ["PR is still open", { pr: { ...pr, merged: false } }, "pr_not_merged"],
    ["forge merge sha disagrees with the ledger", { pr: { ...pr, mergeCommitSha: "ffff0000" } }, "merge_sha_mismatch"],
    ["forge reports no merge sha", { pr: { merged: true, headSha: "abc1234" } }, "merge_sha_mismatch"],
    ["checks query could not be made", { checks: undefined }, "checks_unavailable"],
    ["check list is not known complete (pagination)", { checksComplete: false }, "checks_list_incomplete"],
    ["no checks exist on the sha", { checks: [] }, "no_checks_on_head_sha"],
  ];
  for (const [name, over, reason] of cases) {
    it(name, () => {
      const f = resolveDeliveryCi(ok(over));
      expect(f.state).toBe("unknown");
      expect(f.reason).toBe(reason);
    });
  }

  it("an incomplete list still surfaces what was read (for the human reader)", () => {
    const f = resolveDeliveryCi(ok({ checksComplete: false }));
    expect(f.checks).toEqual(green);
  });
});

describe("target + sha guards", () => {
  it("isValidCiTarget rejects malformed slug / PR / sha", () => {
    expect(isValidCiTarget({ repoSlug: "seanyao/roll", prNumber: 1, sha: "abc1234" })).toBe(true);
    expect(isValidCiTarget({ repoSlug: "seanyao/roll/../other" })).toBe(false);
    expect(isValidCiTarget({ repoSlug: "no-slash" })).toBe(false);
    expect(isValidCiTarget({ prNumber: 0 })).toBe(false);
    expect(isValidCiTarget({ prNumber: -3 })).toBe(false);
    expect(isValidCiTarget({ prNumber: 1.5 })).toBe(false);
    expect(isValidCiTarget({ sha: "zzz" })).toBe(false);
    expect(isValidCiTarget({ sha: "abc" })).toBe(false); // too short
    expect(isValidCiTarget({ sha: "a".repeat(41) })).toBe(false);
  });

  it("shaAgrees is prefix-tolerant (ledger shorts) but never matches on emptiness", () => {
    expect(shaAgrees(MERGE_SHA, "32195061")).toBe(true);
    expect(shaAgrees("32195061", MERGE_SHA)).toBe(true);
    expect(shaAgrees(MERGE_SHA, "3219506")).toBe(true);
    expect(shaAgrees(MERGE_SHA, "ffff0000")).toBe(false);
    expect(shaAgrees(undefined, "32195061")).toBe(false);
    expect(shaAgrees("", "")).toBe(false);
  });
});

describe("deliveryCiSummary", () => {
  it("is a one-line, machine-parseable digest", () => {
    expect(deliveryCiSummary(resolveDeliveryCi(ok()))).toBe("verified #1490@deadbeef — test-ts=success");
    expect(deliveryCiSummary(resolveDeliveryCi(ok({ record: undefined })))).toBe(
      "unknown no PR@deadbeef (no_delivery_record)",
    );
  });
});

// Codex review r2 — the two remaining ways a `verified` could have been wrong.
describe("resolveDeliveryCi — a green must be a DELIVERY-TIME green (codex r2)", () => {
  it("a check that finished AFTER the merge is a rerun, not delivery evidence", () => {
    const rerun = Date.parse("2026-07-25T00:00:00Z"); // days after the merge
    const f = resolveDeliveryCi(ok({ checks: [{ name: "test-ts", conclusion: "success", completedAtMs: rerun }] }));
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("checks_after_merge:test-ts");
  });

  it("a check with no finish time cannot be placed before the merge ⇒ unknown", () => {
    const f = resolveDeliveryCi(ok({ checks: [{ name: "test-ts", conclusion: "success" }] }));
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("check_time_unknown:test-ts");
  });

  it("a green that finished exactly at the merge instant still counts", () => {
    const f = resolveDeliveryCi(ok({ checks: [{ name: "test-ts", conclusion: "success", completedAtMs: MERGED_MS }] }));
    expect(f.state).toBe("verified");
  });
});

describe("resolveDeliveryCi — the BRANCH decides what green means (codex r2)", () => {
  it("an absent REQUIRED check cannot be papered over by an optional green", () => {
    const f = resolveDeliveryCi(
      ok({
        checks: [{ name: "optional-lint", conclusion: "success", completedAtMs: PRE_MERGE_MS }],
        requiredChecks: [{ context: "test-ts" }],
      }),
    );
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("required_missing:test-ts");
  });

  it("every required check must be present and successful", () => {
    const f = resolveDeliveryCi(
      ok({
        checks: [
          { name: "test-ts", conclusion: "success", completedAtMs: PRE_MERGE_MS },
          { name: "build", conclusion: "neutral", completedAtMs: PRE_MERGE_MS },
        ],
        requiredChecks: [{ context: "test-ts" }, { context: "build" }],
      }),
    );
    expect(f.reason).toBe("required_missing:build");
  });

  it("an unreadable protection config leaves 'green' undefined ⇒ unknown", () => {
    const f = resolveDeliveryCi(ok({ requiredChecksKnown: false }));
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("required_checks_unknown");
  });

  it("an unprotected branch (known, empty) verifies on every observed check", () => {
    const f = resolveDeliveryCi(ok({ requiredChecks: [], requiredChecksKnown: true }));
    expect(f.state).toBe("verified");
    // …but a single non-success among them still blocks it.
    const blocked = resolveDeliveryCi(
      ok({
        requiredChecks: [],
        checks: [...green, { name: "extra", conclusion: "skipped", completedAtMs: PRE_MERGE_MS }],
      }),
    );
    expect(blocked.state).toBe("unknown");
    expect(blocked.reason).toContain("extra=skipped");
  });

  it("an extra red is still red even when every required check is green", () => {
    const f = resolveDeliveryCi(
      ok({ checks: [...green, { name: "extra", conclusion: "failure", completedAtMs: PRE_MERGE_MS }] }),
    );
    expect(f.state).toBe("red");
    expect(f.reason).toBe("checks_failed:extra");
  });
});

// Codex review r3 — an observed red outranks incompleteness; App-pinned identity;
// provenance is recorded on every verdict.
describe("resolveDeliveryCi — r3 integrity", () => {
  it("a red already READ is reported red even when the list is incomplete", () => {
    const f = resolveDeliveryCi(
      ok({
        checks: [{ name: "test-ts", conclusion: "failure", completedAtMs: PRE_MERGE_MS }],
        checksComplete: false,
      }),
    );
    expect(f.state).toBe("red");
    expect(f.reason).toBe("checks_failed:test-ts");
  });

  it("an app-pinned required context is NOT satisfied by another App's same-named check", () => {
    const pinned = [{ context: "test-ts", appId: 15368 }];
    const wrongApp = resolveDeliveryCi(
      ok({
        requiredChecks: pinned,
        checks: [{ name: "test-ts", conclusion: "success", completedAtMs: PRE_MERGE_MS, appId: 99 }],
      }),
    );
    expect(wrongApp.state).toBe("unknown");
    expect(wrongApp.reason).toBe("required_missing:test-ts@app15368");
    const rightApp = resolveDeliveryCi(
      ok({
        requiredChecks: pinned,
        checks: [{ name: "test-ts", conclusion: "success", completedAtMs: PRE_MERGE_MS, appId: 15368 }],
      }),
    );
    expect(rightApp.state).toBe("verified");
  });

  it("records WHICH surface declared the requirements (never claiming it is historical)", () => {
    expect(resolveDeliveryCi(ok({ requiredChecksSource: "protection" })).requiredChecksSource).toBe("protection");
    expect(resolveDeliveryCi(ok({ requiredChecksSource: "ruleset" })).requiredChecksSource).toBe("ruleset");
    expect(
      resolveDeliveryCi(ok({ requiredChecks: [], requiredChecksSource: "none_declared" })).requiredChecksSource,
    ).toBe("none_declared");
    const unknown = resolveDeliveryCi(ok({ requiredChecksKnown: false }));
    expect(unknown.requiredChecksSource).toBe("unknown");
    expect(unknown.state).toBe("unknown");
  });

  it("carries the measured requirement set into the fact for audit", () => {
    const f = resolveDeliveryCi(ok());
    expect(f.requiredChecks).toEqual([{ context: "test-ts" }]);
  });
});

// Codex r4 — a merge-queue delivery's required checks ran on the merge-group sha,
// so this PR head's checks are not the delivery's checks.
describe("resolveDeliveryCi — merge-queue deliveries are refused (codex r4)", () => {
  it("a queue-merged PR resolves to unknown even with a green pre-merge head check", () => {
    const f = resolveDeliveryCi(ok({ mergedByQueue: true }));
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("merge_queue_delivery");
  });

  it("a normally-merged PR is unaffected", () => {
    expect(resolveDeliveryCi(ok({ mergedByQueue: false })).state).toBe("verified");
  });
});

// Codex r5 — the statuses endpoint returns the full HISTORY per context (newest
// first). An older success must never satisfy a requirement whose current state is
// pending or red.
describe("resolveDeliveryCi — history collapses to the latest state (codex r5)", () => {
  it("a newer PENDING status beats an older success for the same context", () => {
    const f = resolveDeliveryCi(
      ok({
        checks: [
          { name: "test-ts", conclusion: "", completedAtMs: PRE_MERGE_MS }, // newest
          { name: "test-ts", conclusion: "success", completedAtMs: PRE_MERGE_MS - 60_000 },
        ],
      }),
    );
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("required_missing:test-ts");
  });

  it("a newer FAILURE beats an older success (still red)", () => {
    const f = resolveDeliveryCi(
      ok({
        checks: [
          { name: "test-ts", conclusion: "failure", completedAtMs: PRE_MERGE_MS },
          { name: "test-ts", conclusion: "success", completedAtMs: PRE_MERGE_MS - 60_000 },
        ],
      }),
    );
    expect(f.state).toBe("red");
  });

  it("an older pending does NOT override a newer success", () => {
    const f = resolveDeliveryCi(
      ok({
        checks: [
          { name: "test-ts", conclusion: "success", completedAtMs: PRE_MERGE_MS },
          { name: "test-ts", conclusion: "", completedAtMs: PRE_MERGE_MS - 60_000 },
        ],
      }),
    );
    expect(f.state).toBe("verified");
  });

  it("with no timestamps the forge's newest-first order is honoured", () => {
    const f = resolveDeliveryCi(
      ok({
        checks: [
          { name: "test-ts", conclusion: "" }, // newest per the forge's ordering
          { name: "test-ts", conclusion: "success" },
        ],
      }),
    );
    expect(f.state).toBe("unknown");
    expect(f.reason).toBe("required_missing:test-ts");
  });

  it("distinct Apps reporting the same context stay distinct identities", () => {
    const collapsed = collapseLatestChecks([
      { name: "ctx", conclusion: "success", appId: 1, completedAtMs: 10 },
      { name: "ctx", conclusion: "failure", appId: 2, completedAtMs: 20 },
    ]);
    expect(collapsed).toHaveLength(2);
  });
});
