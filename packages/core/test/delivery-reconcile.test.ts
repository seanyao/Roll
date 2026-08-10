/**
 * US-DELIV-002 — layered reconcile-from-main: comprehensive test matrix.
 *
 * Evaluation contract expected_evidence:
 *   1. Layered determination matrix:
 *      - PR MERGED → delivered / pr_state (L1 strongest)
 *      - patch-id ∈ main → delivered_external / patch_id (L2 squash-safe)
 *      - Amend → L2 miss but L1 catches it (L1 authoritative)
 *      - L3 alone → NOT sufficient
 *      - All miss → wait (never fabricate delivered)
 *   2. Retroactive heal: existing unpublished branch with patch-id match
 *      → delivered_external
 *   3. CLI `roll loop reconcile --json` evidence (see CLI test file).
 *
 * RL-TRUTH-001: verification anchor for the registered redline
 * (policy/rules.yaml) — the layered matrix below (L3 alone never sufficient,
 * no signal → wait, never fabricate) proves the merged-truth decision is still
 * alive.
 */
import { describe, expect, it } from "vitest";
import { CI_STUCK_DWELL_MS, reconcileDelivery, reconciledEventPayload } from "../src/index.js";
import type { ReconcileCycle, ReconcileFacts } from "../src/index.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

const CYCLE: ReconcileCycle = {
  cycleId: "cycle-A",
  storyId: "US-X-001",
  branch: "loop/cycle-A",
  prNumber: 42,
  deliveryState: "awaiting_merge",
};

const CYCLE_NO_PR: ReconcileCycle = {
  cycleId: "cycle-B",
  storyId: "US-X-002",
  branch: "loop/cycle-B",
  deliveryState: "awaiting_merge",
};

function facts(overrides: Partial<ReconcileFacts> = {}): ReconcileFacts {
  return {
    mainPatchIds: new Set<string>(),
    backlogDone: false,
    attestPresent: false,
    ...overrides,
  };
}

// ── L1: PR state (strongest signal) ──────────────────────────────────────────

describe("reconcileDelivery — L1 PR state", () => {
  it("PR MERGED → delivered via pr_state", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "MERGED",
      prMergeCommit: "abc123",
    }));
    expect(result).toEqual({
      kind: "delivered",
      via: "external",
      signal: "pr_state",
      mergeCommit: "abc123",
    });
  });

  it("PR MERGED without mergeCommit → delivered (mergeCommit absent)", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "MERGED",
    }));
    expect(result).toEqual({
      kind: "delivered",
      via: "external",
      signal: "pr_state",
      mergeCommit: undefined,
    });
  });

  it("PR MERGED with patch-id also matching → L1 wins, L1 is authoritative", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "MERGED",
      prMergeCommit: "def456",
      branchNetPatchId: "pid-1",
      mainPatchIds: new Set(["pid-1"]),
    }));
    // L1 fires first, L2 is never reached — L1 is authoritative.
    expect(result).toEqual({
      kind: "delivered",
      via: "external",
      signal: "pr_state",
      mergeCommit: "def456",
    });
  });

  it("PR OPEN → does not trigger delivered (no L1)", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "OPEN",
    }));
    expect(result.kind).not.toBe("delivered");
    // With no CI info and no L2, falls to wait.
    expect(result.kind).toBe("wait");
  });

  it("PR CLOSED → does not trigger delivered (closed = not merged)", () => {
    // US-DELIV-010: closed-unmerged is now an explicit TERMINAL judgment
    // (was a bare wait) — see the degraded/terminal matrix below.
    const result = reconcileDelivery(CYCLE, facts({
      prState: "CLOSED",
    }));
    expect(result.kind).toBe("terminal");
    expect(result.kind).not.toBe("delivered");
  });

  it("PR state undefined (gh unavailable) → no L1, falls through to L2/wait", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: undefined,
    }));
    expect(result.kind).toBe("wait");
  });
});

// ── L2: patch-id equivalence ─────────────────────────────────────────────────

describe("reconcileDelivery — L2 patch-id equivalence", () => {
  it("branchNetPatchId ∈ mainPatchIds → delivered via patch_id", () => {
    const result = reconcileDelivery(CYCLE, facts({
      branchNetPatchId: "pid-xyz",
      mainPatchIds: new Set(["pid-abc", "pid-xyz", "pid-def"]),
    }));
    expect(result).toEqual({
      kind: "delivered",
      via: "external",
      signal: "patch_id",
    });
  });

  it("branchNetPatchId not in mainPatchIds → no L2 hit", () => {
    const result = reconcileDelivery(CYCLE, facts({
      branchNetPatchId: "pid-missing",
      mainPatchIds: new Set(["pid-abc", "pid-def"]),
    }));
    expect(result.kind).toBe("wait");
  });

  it("L2 works without PR (offline / no gh) — patch-id alone suffices", () => {
    const result = reconcileDelivery(CYCLE_NO_PR, facts({
      prState: undefined,
      branchNetPatchId: "pid-offline",
      mainPatchIds: new Set(["pid-offline"]),
    }));
    expect(result).toEqual({
      kind: "delivered",
      via: "external",
      signal: "patch_id",
    });
  });

  it("empty mainPatchIds → L2 never hits", () => {
    const result = reconcileDelivery(CYCLE, facts({
      branchNetPatchId: "pid-any",
      mainPatchIds: new Set(),
    }));
    expect(result.kind).toBe("wait");
  });

  it("branchNetPatchId undefined (branch deleted) → L2 cannot fire", () => {
    const result = reconcileDelivery(CYCLE, facts({
      branchNetPatchId: undefined,
      mainPatchIds: new Set(["pid-any"]),
    }));
    expect(result.kind).toBe("wait");
  });
});

// ── L1 + L2 interaction — amend scenario ─────────────────────────────────────

describe("reconcileDelivery — L1/L2 interaction (amend scenario)", () => {
  it("amend: L1 MERGED hits, L2 patch-id misses → delivered via L1 (authoritative)", () => {
    // Supervisor amends the merge (conflict resolution), so the net diff
    // on main differs from the cycle branch's net diff. L2 misses, but L1
    // still sees MERGED — delivered via L1.
    const result = reconcileDelivery(CYCLE, facts({
      prState: "MERGED",
      prMergeCommit: "amended-commit",
      branchNetPatchId: "pid-original", // original diff
      mainPatchIds: new Set(["pid-amended"]), // amended diff on main → L2 miss
    }));
    expect(result).toEqual({
      kind: "delivered",
      via: "external",
      signal: "pr_state",
      mergeCommit: "amended-commit",
    });
  });

  it("both L1 and L2 miss → wait (never fabricate)", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "OPEN",
      branchNetPatchId: "pid-original",
      mainPatchIds: new Set(["pid-other"]),
    }));
    // OPEN PR with no CI info and no L2 → wait
    expect(result.kind).toBe("wait");
  });
});

// ── CI-driven decisions ──────────────────────────────────────────────────────

describe("reconcileDelivery — CI-driven (merge_now / ci_failed)", () => {
  it("PR OPEN + CI green → merge_now", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "OPEN",
      ciGreen: true,
      // FIX-1489: "CI green" now means the NAMED required check passed on this sha.
      // The bare aggregate no longer licenses a merge — a skipped `test-ts` reduced
      // to "green" and merged untested, which is what this fix closes.
      checks: [{ name: "test-ts", conclusion: "success" }],
    }));
    expect(result).toEqual({ kind: "merge_now", method: "squash" });
  });

  it("PR OPEN + CI red → ci_failed", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "OPEN",
      ciGreen: false,
    }));
    expect(result).toEqual({ kind: "ci_failed" });
  });

  it("PR OPEN + CI unknown → wait (not green, not red)", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "OPEN",
      ciGreen: undefined,
    }));
    expect(result.kind).toBe("wait");
  });

  it("CI green without OPEN PR → wait (merge_now requires open PR)", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: undefined,
      ciGreen: true,
    }));
    expect(result.kind).toBe("wait");
  });
});

// ── L3: weak signals alone NEVER suffice ─────────────────────────────────────

describe("reconcileDelivery — L3 weak signals (never sufficient)", () => {
  it("L3 alone (backlog Done + attest) → wait, NOT delivered", () => {
    const result = reconcileDelivery(CYCLE, facts({
      backlogDone: true,
      attestPresent: true,
    }));
    // L3 is explicitly NOT sufficient (design §3.3, §8, FIX-304).
    expect(result.kind).toBe("wait");
    expect(result.kind).not.toBe("delivered");
  });

  it("L3 alone with everything else missing → wait", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: undefined,
      branchNetPatchId: undefined,
      mainPatchIds: new Set(),
      backlogDone: true,
      attestPresent: true,
    }));
    expect(result.kind).toBe("wait");
  });

  it("L3 + L1 merged → delivered (L1 strong enough alone)", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "MERGED",
      backlogDone: true,
      attestPresent: true,
    }));
    expect(result.kind).toBe("delivered");
  });
});

// ── All signals miss → wait ──────────────────────────────────────────────────

describe("reconcileDelivery — all miss → wait", () => {
  it("completely empty facts → wait", () => {
    const result = reconcileDelivery(CYCLE, facts());
    expect(result.kind).toBe("wait");
  });

  it("PR OPEN but no CI info + no L2 → wait", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "OPEN",
      ciGreen: undefined,
      branchNetPatchId: undefined,
    }));
    expect(result.kind).toBe("wait");
  });

  it("gh down (prState undefined) + branch gone (patchId undefined) → wait", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: undefined,
      branchNetPatchId: undefined,
    }));
    expect(result.kind).toBe("wait");
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("reconcileDelivery — idempotency", () => {
  it("same inputs produce same output (multiple calls)", () => {
    const f = facts({ prState: "MERGED", prMergeCommit: "abc" });
    const r1 = reconcileDelivery(CYCLE, f);
    const r2 = reconcileDelivery(CYCLE, f);
    const r3 = reconcileDelivery(CYCLE, f);
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
  });

  it("patch-id hit is idempotent", () => {
    const f = facts({
      branchNetPatchId: "pid",
      mainPatchIds: new Set(["pid"]),
    });
    expect(reconcileDelivery(CYCLE, f)).toEqual(reconcileDelivery(CYCLE, f));
  });

  it("wait is idempotent", () => {
    const f = facts();
    expect(reconcileDelivery(CYCLE, f)).toEqual(reconcileDelivery(CYCLE, f));
  });
});

// ── reconciledEventPayload ────────────────────────────────────────────────────

describe("reconciledEventPayload", () => {
  const TS = 1_750_000_000_000;

  it("builds a delivery:reconciled event from a delivered result", () => {
    const result = { kind: "delivered" as const, via: "external" as const, signal: "pr_state" as const, mergeCommit: "abc" };
    const payload = reconciledEventPayload(CYCLE, result, TS);
    expect(payload).toEqual({
      type: "delivery:reconciled",
      cycleId: "cycle-A",
      storyId: "US-X-001",
      state: "delivered_external",
      mergedBy: "external",
      mergeCommit: "abc",
      signal: "pr_state",
      ts: TS,
    });
  });

  it("runner via → state is delivered (not delivered_external)", () => {
    const result = { kind: "delivered" as const, via: "runner" as const, signal: "patch_id" as const, mergeCommit: "def" };
    const payload = reconciledEventPayload(CYCLE, result, TS);
    expect(payload.state).toBe("delivered");
    expect(payload.mergedBy).toBe("runner");
  });

  it("patch_id signal is passed through", () => {
    const result = { kind: "delivered" as const, via: "external" as const, signal: "patch_id" as const };
    const payload = reconciledEventPayload(CYCLE, result, TS);
    expect(payload.signal).toBe("patch_id");
    expect(payload.mergeCommit).toBe("unknown"); // no mergeCommit provided
  });

  it("mergeCommit defaults to 'unknown' when absent", () => {
    const result = { kind: "delivered" as const, via: "external" as const, signal: "patch_id" as const };
    const payload = reconciledEventPayload(CYCLE, result, TS);
    expect(payload.mergeCommit).toBe("unknown");
  });
});

// ── Retroactive heal scenario ─────────────────────────────────────────────────

describe("reconcileDelivery — retroactive heal (goal 4)", () => {
  it("existing unpublished cycle with patch-id match → delivered_external", () => {
    // A cycle that was published_pending_merge but never got reconciled.
    // The branch still exists (or its net diff is still reachable).
    // Its patch-id matches a main commit → retroactively delivered_external.
    const cyc: ReconcileCycle = {
      cycleId: "old-cycle-1",
      storyId: "US-OLD-001",
      branch: "loop/old-cycle-1",
      deliveryState: "awaiting_merge",
    };
    const result = reconcileDelivery(cyc, facts({
      branchNetPatchId: "pid-retro",
      mainPatchIds: new Set(["pid-retro", "pid-other"]),
    }));
    expect(result).toEqual({
      kind: "delivered",
      via: "external",
      signal: "patch_id",
    });
  });

  it("existing cycle with deleted branch + PR MERGED → delivered", () => {
    // Branch was deleted after merge, but PR still shows MERGED.
    const cyc: ReconcileCycle = {
      cycleId: "old-cycle-2",
      storyId: "US-OLD-002",
      branch: "loop/old-cycle-2",
      deliveryState: "awaiting_merge",
    };
    const result = reconcileDelivery(cyc, facts({
      prState: "MERGED",
      prMergeCommit: "merged-after-delete",
      branchNetPatchId: undefined, // branch gone
    }));
    expect(result).toEqual({
      kind: "delivered",
      via: "external",
      signal: "pr_state",
      mergeCommit: "merged-after-delete",
    });
  });

  it("existing cycle with no evidence at all → wait (stays awaiting_merge)", () => {
    const cyc: ReconcileCycle = {
      cycleId: "old-cycle-3",
      storyId: "US-OLD-003",
      branch: "loop/old-cycle-3",
      deliveryState: "awaiting_merge",
    };
    const result = reconcileDelivery(cyc, facts());
    expect(result.kind).toBe("wait");
  });
});

// ── US-DELIV-010: degraded/terminal judgment matrix ──────────────────────────
//
// Evaluation contract expected_evidence:
//   1. Judgment matrix — every stuck/terminal PR situation maps to a
//      deterministic verdict, and NONE fabricates delivered:
//      - CI long-red (≥ CI_STUCK_DWELL_MS) → degraded(ci_stuck)
//      - merge conflict → degraded(merge_conflict)
//      - PR closed unmerged → terminal(pr_closed_unmerged)
//      - draft PR → degraded(draft)
//      - missing permission (gh auth) → degraded(no_permission)
//      - branch deleted / force-push changed patch-id → L2 disabled →
//        rely on L1 or wait (never delivered)
//      - gh error (offline/provider_error/not_found) → wait
//      - mergeable UNKNOWN → wait (transient)
//      - squash title rewrite → L2 patch-id still matches → delivered
//   2. Every degraded/terminal verdict carries reason + dwell (readable).

const NOW = 1_790_000_000_000;
const PUBLISHED = NOW - CI_STUCK_DWELL_MS - 60_000; // stuck past the threshold

const CYCLE_DWELL: ReconcileCycle = { ...CYCLE, awaitingSinceMs: PUBLISHED };

describe("US-DELIV-010 — degraded/terminal 判定矩阵", () => {
  // ── terminal ─────────────────────────────────────────────────────────────
  it("PR closed unmerged → terminal(pr_closed_unmerged), never delivered", () => {
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      prState: "CLOSED",
      nowMs: NOW,
    }));
    expect(result).toEqual({
      kind: "terminal",
      reason: "pr_closed_unmerged",
      dwellMs: NOW - PUBLISHED,
    });
  });

  it("PR closed unmerged but patch-id on main (merged elsewhere) → delivered, L2 wins over terminal", () => {
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      prState: "CLOSED",
      branchNetPatchId: "pid-merged-elsewhere",
      mainPatchIds: new Set(["pid-merged-elsewhere"]),
      nowMs: NOW,
    }));
    expect(result.kind).toBe("delivered");
  });

  // ── degraded: ci_stuck ───────────────────────────────────────────────────
  it("CI red past the stuck threshold → degraded(ci_stuck) with dwell", () => {
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      prState: "OPEN",
      ciGreen: false,
      nowMs: NOW,
    }));
    expect(result).toEqual({
      kind: "degraded",
      reason: "ci_stuck",
      dwellMs: NOW - PUBLISHED,
    });
  });

  it("CI red under the threshold → ci_failed (not yet stuck)", () => {
    const fresh: ReconcileCycle = { ...CYCLE, awaitingSinceMs: NOW - 60_000 };
    const result = reconcileDelivery(fresh, facts({
      prState: "OPEN",
      ciGreen: false,
      nowMs: NOW,
    }));
    expect(result).toEqual({ kind: "ci_failed" });
  });

  it("CI red without dwell info → ci_failed (no clock, no degradation)", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "OPEN",
      ciGreen: false,
    }));
    expect(result).toEqual({ kind: "ci_failed" });
  });

  // ── degraded: merge_conflict ─────────────────────────────────────────────
  it("PR open with merge conflict → degraded(merge_conflict), no merge_now", () => {
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      prState: "OPEN",
      ciGreen: true,
      prMergeable: "CONFLICTING",
      nowMs: NOW,
    }));
    expect(result).toEqual({
      kind: "degraded",
      reason: "merge_conflict",
      dwellMs: NOW - PUBLISHED,
    });
  });

  it("mergeable CONFLICTING beats merge_now even when CI is green", () => {
    const result = reconcileDelivery(CYCLE, facts({
      prState: "OPEN",
      ciGreen: true,
      prMergeable: "CONFLICTING",
    }));
    expect(result.kind).toBe("degraded");
    expect(result.kind).not.toBe("merge_now");
  });

  // ── degraded: draft ──────────────────────────────────────────────────────
  it("draft PR → degraded(draft), never merge_now even with green CI", () => {
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      prState: "OPEN",
      ciGreen: true,
      prDraft: true,
      nowMs: NOW,
    }));
    expect(result).toEqual({
      kind: "degraded",
      reason: "draft",
      dwellMs: NOW - PUBLISHED,
    });
  });

  // ── degraded: no_permission ──────────────────────────────────────────────
  it("gh unreachable auth → degraded(no_permission), never delivered", () => {
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      prUnreachableReason: "auth",
      branchNetPatchId: "pid-nomatch",
      mainPatchIds: new Set(["pid-other"]),
      nowMs: NOW,
    }));
    expect(result).toEqual({
      kind: "degraded",
      reason: "no_permission",
      dwellMs: NOW - PUBLISHED,
    });
  });

  // ── gh error → wait (never degraded, never delivered) ────────────────────
  it.each(["offline", "provider_error", "not_found"] as const)(
    "gh unreachable %s → wait (transient, no verdict)",
    (reason) => {
      const result = reconcileDelivery(CYCLE_DWELL, facts({
        prUnreachableReason: reason,
        branchNetPatchId: "pid-nomatch",
        mainPatchIds: new Set(["pid-other"]),
        nowMs: NOW,
      }));
      expect(result.kind).toBe("wait");
    },
  );

  // ── mergeable UNKNOWN → wait (transient) ─────────────────────────────────
  it("mergeable UNKNOWN with unknown CI → wait (transient, no verdict)", () => {
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      prState: "OPEN",
      prMergeable: "UNKNOWN",
      ciGreen: undefined,
      nowMs: NOW,
    }));
    expect(result.kind).toBe("wait");
  });

  it("mergeable UNKNOWN with GREEN CI → wait, never merge_now (never merge blind)", () => {
    // GitHub hasn't finished computing mergeability — a green CI alone is NOT
    // license to squash. This pins the UNKNOWN guard on the merge_now path
    // (the ciGreen:undefined case above cannot catch a regression here).
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      prState: "OPEN",
      prMergeable: "UNKNOWN",
      ciGreen: true,
      nowMs: NOW,
    }));
    expect(result.kind).toBe("wait");
    expect(result.kind).not.toBe("merge_now");
  });

  // ── branch deleted / force-push → L2 disabled, L1-or-wait ────────────────
  it("branch deleted + gh silent → wait (L2 disabled, no L1, never delivered)", () => {
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      prState: undefined,
      branchNetPatchId: undefined, // branch gone
      nowMs: NOW,
    }));
    expect(result.kind).toBe("wait");
  });

  it("force-push changed patch-id (L2 miss) + gh silent → wait, never delivered", () => {
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      branchNetPatchId: "pid-after-force-push",
      mainPatchIds: new Set(["pid-before-force-push"]),
      nowMs: NOW,
    }));
    expect(result.kind).toBe("wait");
  });

  it("force-push changed patch-id but L1 MERGED → delivered via L1 (authoritative)", () => {
    const result = reconcileDelivery(CYCLE_DWELL, facts({
      prState: "MERGED",
      prMergeCommit: "merged-anyway",
      branchNetPatchId: "pid-after-force-push",
      mainPatchIds: new Set(["pid-before-force-push"]),
      nowMs: NOW,
    }));
    expect(result).toEqual({
      kind: "delivered",
      via: "external",
      signal: "pr_state",
      mergeCommit: "merged-anyway",
    });
  });

  // ── squash title rewrite → L2 unaffected (patch-id is diff content) ──────
  it("squash with rewritten title → patch-id still matches → delivered via patch_id", () => {
    // The squash merge rewrote the commit subject/body, but git patch-id is
    // computed from the DIFF content only — the rewrite is invisible to L2.
    const result = reconcileDelivery(CYCLE, facts({
      prState: undefined, // gh silent (e.g. offline)
      branchNetPatchId: "pid-same-diff",
      mainPatchIds: new Set(["pid-same-diff"]),
    }));
    expect(result).toEqual({
      kind: "delivered",
      via: "external",
      signal: "patch_id",
    });
  });

  // ── no fabrication: every degraded/terminal is never delivered ───────────
  it("no degraded/terminal input combination ever yields delivered", () => {
    const stuck = reconcileDelivery(CYCLE_DWELL, facts({ prState: "OPEN", ciGreen: false, nowMs: NOW }));
    const conflict = reconcileDelivery(CYCLE, facts({ prState: "OPEN", prMergeable: "CONFLICTING" }));
    const draft = reconcileDelivery(CYCLE, facts({ prState: "OPEN", prDraft: true }));
    const auth = reconcileDelivery(CYCLE, facts({ prUnreachableReason: "auth" }));
    const closed = reconcileDelivery(CYCLE, facts({ prState: "CLOSED" }));
    for (const r of [stuck, conflict, draft, auth, closed]) {
      expect(r.kind).not.toBe("delivered");
      expect(r.kind).not.toBe("merge_now");
    }
  });
});

// ── FIX-1489: the story-card merge path must use a NAMED check verdict ────────

describe("FIX-1489 — merge_now requires the named required check, not a rollup aggregate", () => {
  // FIX-1487 closed "a skipped check counts as green" for the RELEASE path only
  // (release.ts calls requiredCheckVerdict). The story-card path still decided on
  // facts.ciGreen, which comes from reduceStatusCheckRollup — and its
  // GREEN_CONCLUSIONS still contains SKIPPED/NEUTRAL. ci.yml has a real `if:` that
  // makes test-ts skipped, so "tests never ran" merged silently.
  const green = [{ name: "test-ts", conclusion: "success" }];

  it("named check success → merge_now", () => {
    const result = reconcileDelivery(CYCLE, facts({ prState: "OPEN", ciGreen: true, checks: green }));
    expect(result).toEqual({ kind: "merge_now", method: "squash" });
  });

  it("named check SKIPPED → never merges, even though the rollup says green", () => {
    const result = reconcileDelivery(
      CYCLE,
      facts({ prState: "OPEN", ciGreen: true, checks: [{ name: "test-ts", conclusion: "skipped" }] }),
    );
    expect(result.kind).not.toBe("merge_now");
  });

  it("named check ABSENT on this commit → never merges (a gate that never ran is not a gate that passed)", () => {
    const result = reconcileDelivery(
      CYCLE,
      facts({ prState: "OPEN", ciGreen: true, checks: [{ name: "some-other-job", conclusion: "success" }] }),
    );
    expect(result.kind).not.toBe("merge_now");
  });

  it("named check still running → waits rather than merging or failing", () => {
    const result = reconcileDelivery(
      CYCLE,
      facts({ prState: "OPEN", ciGreen: true, checks: [{ name: "test-ts", conclusion: null }] }),
    );
    expect(result.kind).toBe("wait");
  });

  it("no named checks available at all → fail-closed, does NOT fall back to the aggregate", () => {
    // This is the whole point: an absent named verdict must not be rescued by ciGreen.
    const result = reconcileDelivery(CYCLE, facts({ prState: "OPEN", ciGreen: true }));
    expect(result.kind).not.toBe("merge_now");
  });

  it("honours a multi-check required SET (the drift gate joins test-ts once hard)", () => {
    const both = facts({
      prState: "OPEN",
      ciGreen: true,
      requiredChecks: ["test-ts", "doc-drift"],
      checks: [{ name: "test-ts", conclusion: "success" }],
    });
    expect(reconcileDelivery(CYCLE, both).kind, "doc-drift never ran").not.toBe("merge_now");
  });

  it("a non-required check being skipped does not block the merge", () => {
    const result = reconcileDelivery(
      CYCLE,
      facts({
        prState: "OPEN",
        ciGreen: true,
        checks: [
          { name: "test-ts", conclusion: "success" },
          { name: "optional-lint", conclusion: "skipped" },
        ],
      }),
    );
    expect(result).toEqual({ kind: "merge_now", method: "squash" });
  });
});
