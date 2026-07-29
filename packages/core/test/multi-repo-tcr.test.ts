import { describe, expect, it } from "vitest";
import {
  legVerdict,
  planRepositoryPublish,
  storyVerification,
  type RepositoryLegFacts,
} from "../src/delivery/multi-repo-tcr.js";

/** A green, changed, required leg — the baseline every case perturbs. */
function leg(overrides: Partial<RepositoryLegFacts> = {}): RepositoryLegFacts {
  return {
    repoId: "repo-aaaaaaaaaaaa",
    alias: "sot1",
    access: "write",
    requiredDelivery: true,
    changed: true,
    dirty: false,
    tcrCount: 2,
    testResult: "pass",
    noChangeAllowed: false,
    ownerExemption: false,
    ...overrides,
  };
}

describe("US-WS-012 legVerdict — repository-scoped evidence matrix", () => {
  it("passes a changed required leg with green tests and ≥1 tcr commit", () => {
    expect(legVerdict(leg())).toEqual({ ok: true, repoId: "repo-aaaaaaaaaaaa", reason: "verified" });
  });

  it("fails a changed leg with zero tcr commits — another repo's evidence cannot satisfy it", () => {
    const verdict = legVerdict(leg({ tcrCount: 0 }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("missing_tcr");
      expect(verdict.repoId).toBe("repo-aaaaaaaaaaaa");
    }
  });

  it("fails a changed leg whose repo-scoped tests failed", () => {
    const verdict = legVerdict(leg({ testResult: "fail" }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("tests_failed");
  });

  it("fails a changed leg whose tests never ran — a skipped gate is not green", () => {
    const verdict = legVerdict(leg({ testResult: "not_run" }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("tests_not_run");
  });

  it("fails an unchanged writable required leg without a declared no-change rule (AC4)", () => {
    const verdict = legVerdict(leg({ changed: false, tcrCount: 0, testResult: "not_run" }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("undeclared_no_change");
  });

  it("passes an unchanged writable leg with a designed no_change_allowed rule", () => {
    expect(legVerdict(leg({ changed: false, tcrCount: 0, testResult: "not_run", noChangeAllowed: true }))).toEqual({
      ok: true,
      repoId: "repo-aaaaaaaaaaaa",
      reason: "no_change_allowed",
    });
  });

  it("passes an unchanged writable leg with an explicit owner exemption", () => {
    expect(legVerdict(leg({ changed: false, tcrCount: 0, testResult: "not_run", ownerExemption: true }))).toEqual({
      ok: true,
      repoId: "repo-aaaaaaaaaaaa",
      reason: "owner_exemption",
    });
  });

  it("fails a leg left dirty — uncommitted work is an incomplete handoff, not evidence", () => {
    const verdict = legVerdict(leg({ dirty: true }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("dirty_worktree");
  });

  it("read-only legs are never verified and never block", () => {
    expect(legVerdict(leg({ access: "read", changed: false, tcrCount: 0, testResult: "not_run" }))).toEqual({
      ok: true,
      repoId: "repo-aaaaaaaaaaaa",
      reason: "read_only",
    });
  });
});

describe("US-WS-012 storyVerification — no aggregate boolean hides a leg", () => {
  const green = [leg(), leg({ repoId: "repo-bbbbbbbbbbbb", alias: "sot2" })];

  it("passes when every leg passes and integration passed against pinned heads", () => {
    const verdict = storyVerification(green, {
      ran: true,
      exitCode: 0,
      inputHeads: { "repo-aaaaaaaaaaaa": "a".repeat(40), "repo-bbbbbbbbbbbb": "b".repeat(40) },
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.integrationInputs).toEqual({
        "repo-aaaaaaaaaaaa": "a".repeat(40),
        "repo-bbbbbbbbbbbb": "b".repeat(40),
      });
    }
  });

  it("reports exactly which legs failed — one green repo cannot cover another (AC2)", () => {
    const verdict = storyVerification(
      [leg(), leg({ repoId: "repo-bbbbbbbbbbbb", alias: "sot2", tcrCount: 0 })],
      { ran: true, exitCode: 0, inputHeads: { "repo-aaaaaaaaaaaa": "a".repeat(40), "repo-bbbbbbbbbbbb": "b".repeat(40) } },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("leg_failed");
      expect(verdict.failedLegs).toEqual([{ repoId: "repo-bbbbbbbbbbbb", code: "missing_tcr" }]);
    }
  });

  it("fails when the cross-repo integration command failed (AC7)", () => {
    const verdict = storyVerification(green, {
      ran: true,
      exitCode: 1,
      inputHeads: { "repo-aaaaaaaaaaaa": "a".repeat(40), "repo-bbbbbbbbbbbb": "b".repeat(40) },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("integration_failed");
  });

  it("fails when integration ran without a pinned head for every writable leg (AC5)", () => {
    const verdict = storyVerification(green, {
      ran: true,
      exitCode: 0,
      inputHeads: { "repo-aaaaaaaaaaaa": "a".repeat(40) },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("integration_inputs_incomplete");
  });

  it("fails when a required integration command never ran", () => {
    const verdict = storyVerification(green, { ran: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("integration_not_run");
  });

  it("a single-writable-leg story without a declared integration command passes on leg evidence alone (AC8)", () => {
    const verdict = storyVerification([leg()], { ran: false }, { integrationDeclared: false });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.integrationInputs).toEqual({});
  });

  it("a multi-writable-leg story cannot skip integration even when undeclared — cross-repo acceptance is the point", () => {
    const verdict = storyVerification(green, { ran: false }, { integrationDeclared: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("integration_not_run");
  });

  it("a declared integration command must run even for a single-leg story", () => {
    const verdict = storyVerification([leg()], { ran: false }, { integrationDeclared: true });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("integration_not_run");
  });

  it("a story with only a read-only extra leg needs pinned heads only for writable legs", () => {
    const legs = [leg(), leg({ repoId: "repo-cccccccccccc", alias: "sot3", access: "read", changed: false, tcrCount: 0, testResult: "not_run" })];
    const verdict = storyVerification(legs, {
      ran: true,
      exitCode: 0,
      inputHeads: { "repo-aaaaaaaaaaaa": "a".repeat(40) },
    });
    expect(verdict.ok).toBe(true);
  });

  it("single-leg projection: one writable repo flows the same path (AC8)", () => {
    const verdict = storyVerification([leg()], {
      ran: true,
      exitCode: 0,
      inputHeads: { "repo-aaaaaaaaaaaa": "a".repeat(40) },
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("US-WS-012 planRepositoryPublish — one plan per changed repo, dependency ordered (AC6)", () => {
  it("plans only changed writable legs, ordered by declared dependency", () => {
    const plan = planRepositoryPublish(
      [
        { repoId: "repo-front", alias: "front", changed: true, workBranch: "campaign/front", dependsOnRepo: "repo-back" },
        { repoId: "repo-back", alias: "back", changed: true, workBranch: "campaign/back" },
        { repoId: "repo-doc", alias: "doc", changed: false, workBranch: "campaign/doc" },
      ],
    );
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.entries.map((entry) => entry.repoId)).toEqual(["repo-back", "repo-front"]);
      expect(plan.entries.map((entry) => entry.branch)).toEqual(["campaign/back", "campaign/front"]);
      expect(plan.entries[1]?.dependsOn).toEqual(["repo-back"]);
    }
  });

  it("rejects a dependency cycle loudly instead of guessing an order", () => {
    const plan = planRepositoryPublish(
      [
        { repoId: "repo-a", alias: "a", changed: true, workBranch: "campaign/a", dependsOnRepo: "repo-b" },
        { repoId: "repo-b", alias: "b", changed: true, workBranch: "campaign/b", dependsOnRepo: "repo-a" },
      ],
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("dependency_cycle");
  });

  it("rejects a dependency on an unknown repo", () => {
    const plan = planRepositoryPublish(
      [{ repoId: "repo-a", alias: "a", changed: true, workBranch: "campaign/a", dependsOnRepo: "repo-ghost" }],
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("unknown_dependency");
  });
});
