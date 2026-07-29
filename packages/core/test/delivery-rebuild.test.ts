/**
 * FIX-389a — rebuildDeliveriesFromFacts tests (projection engine).
 *
 * AC1: Deterministic + idempotent.
 * AC2: Delete deliveries.jsonl → rebuild → same result.
 * AC4: Backfill = rebuild from existing runs+git.
 * AC7: No false positives (truly todo cards stay todo).
 */
import { describe, expect, it } from "vitest";
import {
  extractRunFact,
  nodeExecPort,
  parseMergeCommitLog,
  parseMergeCommitMessages,
  parseStoryIdsFromSubject,
  rebuildDeliveriesFromFacts,
  collectRunFacts,
  ensureDeliveriesFresh,
  mergeProvenance,
  unattributedSubjectOnlyMerges,
  isNonDeliverySubject,
  type RunFact,
  type MergeFact,
  type FreshnessPort,
} from "../src/index.js";
import { queryStoryDelivery } from "../src/truth/query.js";
import type { ExecPort, ExecResult } from "../src/delivery/infra-default.js";

// ── extractRunFact ───────────────────────────────────────────────────────────

describe("extractRunFact", () => {
  it("extracts a basic built row", () => {
    const row: Record<string, unknown> = {
      story_id: "US-TEST-001",
      cycle_id: "cycle-20260621-0001",
      status: "built",
      outcome: "published_pending_merge",
      pr_number: 42,
      ts: "2026-06-21T10:00:00Z",
    };
    const f = extractRunFact(row);
    expect(f).not.toBeNull();
    expect(f!.storyId).toBe("US-TEST-001");
    expect(f!.cycleId).toBe("cycle-20260621-0001");
    expect(f!.status).toBe("built");
    expect(f!.outcome).toBe("published_pending_merge");
    expect(f!.prNumber).toBe(42);
    expect(f!.mergeCommit).toBeUndefined();
    expect(f!.mergedAt).toBeUndefined();
    expect(f!.recordedAt).toBeGreaterThan(0);
  });

  it("extracts a merged row with backfill stamps", () => {
    const row: Record<string, unknown> = {
      story_id: "US-DONE-001",
      cycle_id: "cycle-merge",
      status: "merged",
      outcome: "delivered",
      pr_number: 99,
      merge_commit: "abc123def456",
      merged_at: 1719000000000,
      ts: "2026-06-21T12:00:00Z",
    };
    const f = extractRunFact(row);
    expect(f).not.toBeNull();
    expect(f!.storyId).toBe("US-DONE-001");
    expect(f!.mergeCommit).toBe("abc123def456");
    expect(f!.mergedAt).toBe(1719000000000);
    expect(f!.prNumber).toBe(99);
  });

  it("reads routed_story as fallback for story_id", () => {
    const row: Record<string, unknown> = {
      routed_story: "US-ALT",
      cycle_id: "c1",
      status: "published",
      ts: "2026-01-01T00:00:00Z",
    };
    const f = extractRunFact(row);
    expect(f).not.toBeNull();
    expect(f!.storyId).toBe("US-ALT");
  });

  it("returns null when storyId is missing", () => {
    const row: Record<string, unknown> = {
      cycle_id: "c1",
      status: "built",
    };
    expect(extractRunFact(row)).toBeNull();
  });

  it("returns null when cycleId is missing", () => {
    const row: Record<string, unknown> = {
      story_id: "US-NO-CYCLE",
      status: "built",
    };
    expect(extractRunFact(row)).toBeNull();
  });

  it("parses merged_at as string timestamp", () => {
    const row: Record<string, unknown> = {
      story_id: "US-STRMERGED",
      cycle_id: "c1",
      status: "merged",
      outcome: "delivered",
      merge_commit: "abc123",
      merged_at: "2026-06-20T18:07:32Z",
      ts: "2026-06-21T10:00:00Z",
    };
    const f = extractRunFact(row);
    expect(f).not.toBeNull();
    expect(f!.mergedAt).toBe(1781978852000);
    expect(f!.mergeCommit).toBe("abc123");
  });

  it("parses merged_at as number", () => {
    const row: Record<string, unknown> = {
      story_id: "US-NUMMERGED",
      cycle_id: "c1",
      status: "merged",
      outcome: "delivered",
      merged_at: 1718885252000,
      ts: "2026-06-21T10:00:00Z",
    };
    const f = extractRunFact(row);
    expect(f).not.toBeNull();
    expect(f!.mergedAt).toBe(1718885252000);
  });

  it("handles numeric ts as recordedAt", () => {
    const row: Record<string, unknown> = {
      story_id: "US-NUMTS",
      cycle_id: "c1",
      status: "built",
      ts: 1719000000000,
    };
    const f = extractRunFact(row);
    expect(f).not.toBeNull();
    expect(f!.recordedAt).toBe(1719000000000);
  });

  it("uses recordedAt when ts is absent", () => {
    const row: Record<string, unknown> = {
      story_id: "US-RECAT",
      cycle_id: "c1",
      status: "built",
      recordedAt: 1700000000000,
    };
    const f = extractRunFact(row);
    expect(f).not.toBeNull();
    expect(f!.recordedAt).toBe(1700000000000);
  });
});

// ── parseMergeCommitMessages ─────────────────────────────────────────────────

describe("parseMergeCommitMessages", () => {
  it("parses 'Merge pull request #N' lines", () => {
    // git log is newest-first, so line 1 is newer
    const lines = [
      "def456 1719000100 Merge pull request #99 from other/fix",
      "abc123 1719000000 Merge pull request #42 from branch/feature",
    ];
    const facts = parseMergeCommitMessages(lines);
    expect(facts).toHaveLength(2);
    expect(facts[0].prNumber).toBe(99); // first occurrence wins (reverse-chron)
    expect(facts[0].mergeCommit).toBe("def456");
    expect(facts[1].prNumber).toBe(42);
    expect(facts[1].mergeCommit).toBe("abc123");
  });

  it("parses squash-merge '(#N)' in subject", () => {
    const lines = [
      "ghi789 1719000200 feat: add projection engine (#55)",
    ];
    const facts = parseMergeCommitMessages(lines);
    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(55);
    expect(facts[0].mergeCommit).toBe("ghi789");
  });

  it("FIX-1457: last '(#N)' wins when the subject embeds an issue ref before the PR number", () => {
    // GitHub squash appends the PR number as the LAST "(#N)"; a "Closes #issue"
    // echoed into the PR title lands earlier. The PR identity must be the PR,
    // not the issue.
    const lines = [
      "mno345 1719000250 Fix FIX-1456: recover merged standalone loop branches (#1454) (#1456)",
    ];
    const facts = parseMergeCommitMessages(lines);
    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(1456);
    expect(facts[0].storyIds).toEqual(["FIX-1456"]);
  });

  it("skips non-merge lines", () => {
    const lines = [
      "jkl012 1719000300 regular commit without PR",
    ];
    const facts = parseMergeCommitMessages(lines);
    expect(facts).toHaveLength(0);
  });

  it("first occurrence wins for duplicate PR numbers", () => {
    // git log is newest-first, so the newer merge appears first
    const lines = [
      "bbb222 1719000500 Merge pull request #10 from second",
      "aaa111 1719000400 Merge pull request #10 from first",
    ];
    const facts = parseMergeCommitMessages(lines);
    expect(facts).toHaveLength(1);
    expect(facts[0].mergeCommit).toBe("bbb222"); // newer, first in reversed output
  });

  it("handles empty input", () => {
    expect(parseMergeCommitMessages([])).toHaveLength(0);
  });
});

// ── rebuildDeliveriesFromFacts (AC1, AC4, AC7) ───────────────────────────────

function makeRun(overrides: Partial<RunFact> = {}): RunFact {
  return {
    storyId: "US-TEST",
    cycleId: "cycle-default",
    status: "built",
    outcome: "published_pending_merge",
    prNumber: 42,
    recordedAt: 1000,
    ...overrides,
  };
}

function makeMerge(overrides: Partial<MergeFact> = {}): MergeFact {
  return {
    prNumber: 42,
    mergeCommit: "abc123def456",
    mergedAt: 2000,
    storyIds: [],
    touchesProductCode: true,
    ...overrides,
  };
}

describe("rebuildDeliveriesFromFacts — AC1: done when PR merged", () => {
  it("emits done record when a run's PR matches a git merge", () => {
    const runs = [makeRun({ storyId: "US-DONE", prNumber: 42 })];
    const merges = [makeMerge({ prNumber: 42 })];
    const result = rebuildDeliveriesFromFacts(runs, merges);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-DONE");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].prNumber).toEqual({ present: true, value: 42 });
    expect(result[0].mergeCommit).toEqual({ present: true, value: "abc123def456" });
  });

  it("emits done when run already has backfill merge stamps", () => {
    const runs = [makeRun({
      storyId: "US-BACKFILLED",
      mergeCommit: "deadbeef",
      mergedAt: 3000000,
      prNumber: 10,
    })];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].mergeCommit).toEqual({ present: true, value: "deadbeef" });
  });

  it("includes repoSlug in prUrl when provided", () => {
    const runs = [makeRun({ storyId: "US-SLUG", prNumber: 42 })];
    const merges = [makeMerge({ prNumber: 42 })];
    const result = rebuildDeliveriesFromFacts(runs, merges, "owner/repo");
    expect(result[0].prUrl).toEqual({
      present: true,
      value: "https://github.com/owner/repo/pull/42",
    });
  });

  it("prUrl absent when repoSlug not provided", () => {
    const runs = [makeRun({ storyId: "US-NOSLUG", prNumber: 42 })];
    const merges = [makeMerge({ prNumber: 42 })];
    const result = rebuildDeliveriesFromFacts(runs, merges);
    expect(result[0].prUrl).toEqual({ present: false, reason: "not_recorded" });
  });
});

describe("rebuildDeliveriesFromFacts — AC1: in_flight when published not merged", () => {
  it("emits in_flight for published_pending_merge with no matching merge", () => {
    const runs = [makeRun({
      storyId: "US-FLIGHT",
      outcome: "published_pending_merge",
      prNumber: 42,
    })];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("pending_merge");
    expect(result[0].prNumber).toEqual({ present: true, value: 42 });
    expect(result[0].mergeCommit).toEqual({ present: false, reason: "not_recorded" });
  });

  it("emits in_flight with prUrl when repoSlug provided", () => {
    const runs = [makeRun({
      storyId: "US-FLIGHT2",
      outcome: "published_pending_merge",
      prNumber: 88,
    })];
    const result = rebuildDeliveriesFromFacts(runs, [], "o/r");
    expect(result[0].prUrl).toEqual({
      present: true,
      value: "https://github.com/o/r/pull/88",
    });
  });
});

describe("rebuildDeliveriesFromFacts — AC1: other outcomes", () => {
  it("failed outcome → failed lifecycle", () => {
    const runs = [makeRun({
      storyId: "US-FAIL",
      outcome: "failed",
      prNumber: undefined,
    })];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("failed");
  });

  it("blocked outcome → blocked lifecycle", () => {
    const runs = [makeRun({
      storyId: "US-BLOCK",
      outcome: "blocked",
      prNumber: undefined,
    })];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("blocked");
  });

  it("US-DELIV-013: retired failure attribution no longer blocks reconciliation", () => {
    const runs = [makeRun({
      storyId: "US-NOGUARD-NEW",
      outcome: "published_pending_merge",
      prNumber: 81,
      recordedAt: 200,
      failureClass: "env",
      rootCauseKey: "env:pr_loop",
    })];
    const result = rebuildDeliveriesFromFacts(runs, [], "o/r");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      storyId: "US-NOGUARD-NEW",
      lifecycleState: "pending_merge",
      prNumber: { present: true, value: 81 },
      prUrl: { present: true, value: "https://github.com/o/r/pull/81" },
    });
  });

  it("FIX-1032b: ci_red_after_merge without merge evidence stays ci_red", () => {
    const runs = [makeRun({
      storyId: "US-RED-NOMERGE",
      outcome: "ci_red_after_merge",
      prNumber: 80,
      recordedAt: 200,
    })];
    const result = rebuildDeliveriesFromFacts(runs, [], "o/r");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      storyId: "US-RED-NOMERGE",
      lifecycleState: "ci_red",
      prNumber: { present: true, value: 80 },
      prUrl: { present: true, value: "https://github.com/o/r/pull/80" },
      mergeCommit: { present: false, reason: "not_recorded" },
    });
  });

  it("idle_no_work → no record (todo)", () => {
    const runs = [makeRun({
      storyId: "US-IDLE",
      outcome: "idle_no_work",
    })];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(0);
  });

  it("gave_up → failed lifecycle", () => {
    const runs = [makeRun({
      storyId: "US-GAVEUP",
      outcome: "gave_up",
      prNumber: undefined,
    })];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("failed");
  });

  it("aborted_with_delivery → in_flight", () => {
    const runs = [makeRun({
      storyId: "US-ABORTED",
      outcome: "aborted_with_delivery",
      prNumber: 77,
    })];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("pending_merge");
  });
});

describe("rebuildDeliveriesFromFacts — AC7: no false positives", () => {
  it("truly todo story (no runs, no merges) → empty result", () => {
    const result = rebuildDeliveriesFromFacts([], []);
    expect(result).toHaveLength(0);
  });

  it("unknown outcome → no record", () => {
    const runs = [makeRun({
      storyId: "US-UNKNOWN",
      outcome: "unknown",
    })];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(0);
  });

  it("run with no outcome and no merge → no record", () => {
    const runs = [makeRun({
      storyId: "US-NOOUT",
      outcome: "",
    })];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(0);
  });
});

describe("rebuildDeliveriesFromFacts — constraints", () => {
  it("deterministic: same input → same output", () => {
    const runs = [
      makeRun({ storyId: "US-DET", prNumber: 1, recordedAt: 100 }),
      makeRun({ storyId: "US-DET", prNumber: 1, outcome: "published_pending_merge", recordedAt: 200 }),
    ];
    const merges = [makeMerge({ prNumber: 1 })];
    const r1 = rebuildDeliveriesFromFacts(runs, merges);
    const r2 = rebuildDeliveriesFromFacts(runs, merges);
    expect(r1).toEqual(r2);
  });

  it("idempotent: rebuild twice yields same result", () => {
    const runs = [
      makeRun({ storyId: "US-IDEM", prNumber: 5, recordedAt: 100 }),
    ];
    const merges = [makeMerge({ prNumber: 5 })];
    const first = rebuildDeliveriesFromFacts(runs, merges);
    const second = rebuildDeliveriesFromFacts(runs, merges);
    expect(first).toEqual(second);
  });

  it("latest-wins: later run overrides earlier for same story", () => {
    const runs = [
      makeRun({ storyId: "US-LW", outcome: "failed", prNumber: undefined, recordedAt: 100 }),
      makeRun({ storyId: "US-LW", outcome: "published_pending_merge", prNumber: 42, recordedAt: 200 }),
    ];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("pending_merge");
  });

  it("merged beats in_flight: even if latest run is in_flight, merge wins", () => {
    const runs = [
      makeRun({ storyId: "US-MB", outcome: "published_pending_merge", prNumber: 99, recordedAt: 100 }),
      makeRun({ storyId: "US-MB", outcome: "published_pending_merge", prNumber: 99, recordedAt: 200 }),
    ];
    const merges = [makeMerge({ prNumber: 99 })];
    const result = rebuildDeliveriesFromFacts(runs, merges);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("done");
  });

  it("FIX-1032b: ci_red_after_merge is not rebuilt as done even with merge evidence", () => {
    const runs = [
      makeRun({ storyId: "US-CIRED", outcome: "ci_red_after_merge", prNumber: 77, recordedAt: 200 }),
    ];
    const merges = [makeMerge({ prNumber: 77, mergeCommit: "red123", mergedAt: 3000 })];
    const result = rebuildDeliveriesFromFacts(runs, merges, "o/r");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      storyId: "US-CIRED",
      lifecycleState: "ci_red",
      prNumber: { present: true, value: 77 },
      prUrl: { present: true, value: "https://github.com/o/r/pull/77" },
      mergeCommit: { present: true, value: "red123" },
    });
  });

  it("US-DELIV-013: historical retired outcome yields to merge evidence", () => {
    const runs = [
      makeRun({ storyId: "US-NOPRLOOP", outcome: "pr_loop_unavailable", prNumber: 78, recordedAt: 200 }),
    ];
    const merges = [makeMerge({ prNumber: 78, mergeCommit: "noguard123", mergedAt: 3000 })];
    const result = rebuildDeliveriesFromFacts(runs, merges, "o/r");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      storyId: "US-NOPRLOOP",
      lifecycleState: "done",
      prNumber: { present: true, value: 78 },
      prUrl: { present: true, value: "https://github.com/o/r/pull/78" },
      mergeCommit: { present: true, value: "noguard123" },
    });
  });

  it("AC2: delete deliveries → rebuild → same result (simulated)", () => {
    // Rebuilding from the same facts always produces the same deliveries.
    // This simulates the "delete the file and rebuild" scenario.
    const runs = [
      makeRun({ storyId: "US-AC2A", prNumber: 10, recordedAt: 100 }),
      makeRun({ storyId: "US-AC2B", outcome: "published_pending_merge", prNumber: 20, recordedAt: 200 }),
    ];
    const merges = [
      makeMerge({ prNumber: 10 }),
    ];
    // First "build"
    const d1 = rebuildDeliveriesFromFacts(runs, merges, "o/r");
    // Delete + rebuild = same result
    const d2 = rebuildDeliveriesFromFacts(runs, merges, "o/r");
    expect(d2).toEqual(d1);
    // US-AC2A should be done
    const doneRec = d2.find((r) => r.storyId === "US-AC2A");
    expect(doneRec).toBeDefined();
    expect(doneRec!.lifecycleState).toBe("done");

    // US-AC2B should be in_flight
    const flightRec = d2.find((r) => r.storyId === "US-AC2B");
    expect(flightRec).toBeDefined();
    expect(flightRec!.lifecycleState).toBe("pending_merge");
  });

  it("AC4: backfill = rebuild — no separate script needed", () => {
    // Simulate multiple stories that were delivered before deliveries.jsonl existed.
    // These should all be reconstructed from runs + git facts.
    const runs: RunFact[] = [
      { storyId: "US-OLD1", cycleId: "c1", status: "merged", outcome: "delivered", prNumber: 1, recordedAt: 10 },
      { storyId: "US-OLD2", cycleId: "c2", status: "built", outcome: "published_pending_merge", prNumber: 2, recordedAt: 20 },
      { storyId: "US-OLD3", cycleId: "c3", status: "built", outcome: "published_pending_merge", prNumber: 3, recordedAt: 30 },
      { storyId: "US-OLD4", cycleId: "c4", status: "failed", outcome: "failed", recordedAt: 40 },
    ];
    const merges: MergeFact[] = [
      { prNumber: 1, mergeCommit: "aaa", mergedAt: 15, storyIds: [] },
      { prNumber: 3, mergeCommit: "ccc", mergedAt: 35, storyIds: [] },
    ];

    const deliveries = rebuildDeliveriesFromFacts(runs, merges);

    // US-OLD1: merged in runs + git → done
    const d1 = deliveries.find((d) => d.storyId === "US-OLD1");
    expect(d1!.lifecycleState).toBe("done");

    // US-OLD2: published but not merged → in_flight
    const d2 = deliveries.find((d) => d.storyId === "US-OLD2");
    expect(d2!.lifecycleState).toBe("pending_merge");

    // US-OLD3: published AND merged (via git) → done
    const d3 = deliveries.find((d) => d.storyId === "US-OLD3");
    expect(d3!.lifecycleState).toBe("done");
    expect(d3!.mergeCommit).toEqual({ present: true, value: "ccc" });

    // US-OLD4: failed → no record (failure emits but in failed state)
    const d4 = deliveries.find((d) => d.storyId === "US-OLD4");
    expect(d4!.lifecycleState).toBe("failed");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("rebuildDeliveriesFromFacts — backfill mergeCommit without prNumber", () => {
  it("emits done when backfill has mergeCommit but no prNumber", () => {
    const runs = [makeRun({
      storyId: "US-NOPR",
      prNumber: undefined,
      mergeCommit: "nopr-sha",
      mergedAt: 5000000,
    })];
    const result = rebuildDeliveriesFromFacts(runs, []);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].mergeCommit).toEqual({ present: true, value: "nopr-sha" });
    // prNumber absent when not available
    expect(result[0].prNumber.present).toBe(false);
  });

  it("cross-references git merges by SHA to find missing prNumber", () => {
    const runs = [makeRun({
      storyId: "US-SHALOOKUP",
      prNumber: undefined,
      mergeCommit: "abc123sha",
      mergedAt: 5000000,
    })];
    const merges = [
      { prNumber: 883, mergeCommit: "abc123sha", mergedAt: 2000, storyIds: [] },
    ];
    const result = rebuildDeliveriesFromFacts(runs, merges);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].prNumber).toEqual({ present: true, value: 883 });
    expect(result[0].mergeCommit).toEqual({ present: true, value: "abc123sha" });
  });

  it("prefers backfill prNumber over git SHA lookup", () => {
    const runs = [makeRun({
      storyId: "US-PREFER",
      prNumber: 42,
      mergeCommit: "shared-sha",
      mergedAt: 5000000,
    })];
    const merges = [
      { prNumber: 883, mergeCommit: "shared-sha", mergedAt: 2000, storyIds: [] },
    ];
    const result = rebuildDeliveriesFromFacts(runs, merges);
    expect(result).toHaveLength(1);
    // Backfill prNumber wins
    expect(result[0].prNumber).toEqual({ present: true, value: 42 });
  });

  it("AC4: US-TRUTH-016 scenario — mergeCommit present, prNumber from git, done", () => {
    // Simulates the real US-TRUTH-016 row: mergeCommit=9efd807, no pr_number
    const runs: RunFact[] = [{
      storyId: "US-TRUTH-016",
      cycleId: "20260621-014644-46091",
      status: "merged",
      outcome: "delivered",
      prNumber: undefined,
      mergeCommit: "9efd807189ca538ccde38bfb55f461b2a5e614c9",
      mergedAt: 1718885252000,
      recordedAt: 1718885176000,
    }];
    const merges: MergeFact[] = [{
      prNumber: 883,
      mergeCommit: "9efd807189ca538ccde38bfb55f461b2a5e614c9",
      mergedAt: 1718885251,
      storyIds: [],
    }];
    const result = rebuildDeliveriesFromFacts(runs, merges, "seanyao/roll");
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-TRUTH-016");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].prNumber).toEqual({ present: true, value: 883 });
    expect(result[0].mergeCommit).toEqual({ present: true, value: "9efd807189ca538ccde38bfb55f461b2a5e614c9" });
    expect(result[0].prUrl).toEqual({ present: true, value: "https://github.com/seanyao/roll/pull/883" });
  });
});

describe("rebuildDeliveriesFromFacts — edge cases", () => {
  it("multiple runs for same story, merge found via first run's PR", () => {
    const runs = [
      makeRun({ storyId: "US-EDGE", cycleId: "c1", prNumber: 55, recordedAt: 100 }),
      makeRun({ storyId: "US-EDGE", cycleId: "c2", prNumber: undefined, outcome: "failed", recordedAt: 200 }),
    ];
    const merges = [makeMerge({ prNumber: 55 })];
    const result = rebuildDeliveriesFromFacts(runs, merges);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("done");
  });

  it("story with backfill merge data and git merge → uses backfill data", () => {
    const runs = [makeRun({
      storyId: "US-BF",
      mergeCommit: "backfill-sha",
      mergedAt: 5000000,
      prNumber: 7,
      recordedAt: 100,
    })];
    const merges = [makeMerge({ prNumber: 7, mergeCommit: "git-sha" })];
    const result = rebuildDeliveriesFromFacts(runs, merges);
    expect(result).toHaveLength(1);
    // Backfill data wins (checked first)
    expect(result[0].mergeCommit).toEqual({ present: true, value: "backfill-sha" });
  });

  it("empty runs → empty result", () => {
    const result = rebuildDeliveriesFromFacts([], [makeMerge({ prNumber: 1 })]);
    expect(result).toHaveLength(0);
  });
});

// ── FIX-904: git-subject story-id is the authoritative done signal ───────────

describe("parseStoryIdsFromSubject (FIX-904)", () => {
  it("extracts a single story-id", () => {
    expect(parseStoryIdsFromSubject("FIX-204: heartbeat fix (#421)")).toEqual(["FIX-204"]);
  });

  it("extracts compound-epic ids (US-TRUTH-016)", () => {
    expect(parseStoryIdsFromSubject("tcr: US-TRUTH-016 — CLI truth query (#883)")).toEqual(["US-TRUTH-016"]);
  });

  it("expands FIX-389a/b/c shorthand into three ids", () => {
    expect(parseStoryIdsFromSubject("FIX-389a/b/c — salvage delivery (#893)")).toEqual([
      "FIX-389a",
      "FIX-389b",
      "FIX-389c",
    ]);
  });

  it("returns [] for subjects with no story-id (loop cycle commit)", () => {
    expect(parseStoryIdsFromSubject("loop cycle cycle-20260621-014644 (#892)")).toEqual([]);
  });

  it("de-duplicates repeated ids", () => {
    expect(parseStoryIdsFromSubject("FIX-1 and FIX-1 again (#5)")).toEqual(["FIX-1"]);
  });

  it("handles multiple distinct ids in one subject", () => {
    expect(parseStoryIdsFromSubject("US-A-1 plus FIX-2 (#9)")).toEqual(["US-A-1", "FIX-2"]);
  });

  it("does not over-expand a plain numeric id (no letter suffix)", () => {
    // FIX-389 (no suffix) followed by "/b" must NOT consume the slash run.
    expect(parseStoryIdsFromSubject("FIX-389/cleanup (#1)")).toEqual(["FIX-389"]);
  });
});

describe("parseMergeCommitMessages — FIX-904 storyIds", () => {
  it("attaches expanded story-ids to the MergeFact", () => {
    const facts = parseMergeCommitMessages([
      "abc1234 1719000000 FIX-389a/b/c … (#893)",
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(893);
    expect(facts[0].storyIds).toEqual(["FIX-389a", "FIX-389b", "FIX-389c"]);
  });

  it("loop-cycle subject yields empty storyIds (no false positive)", () => {
    const facts = parseMergeCommitMessages([
      "def5678 1719000100 loop cycle cycle-20260621-014644 (#892)",
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(892);
    expect(facts[0].storyIds).toEqual([]);
  });
});

describe("parseMergeCommitLog — FIX-923 full commit messages", () => {
  const rs = "\x1e";
  const fs = "\x1f";

  it("extracts story-ids from a GitHub merge commit body", () => {
    const text = [
      rs,
      "79101a83683ef341f0326b9b080298ee4abdefbe",
      fs,
      "1782233269",
      fs,
      "Merge pull request #922 from seanyao/fix/remove-deepseek-phantom-agent\n\n",
      "FIX-399: remove phantom deepseek agent\n\n",
      "Remove the phantom DeepSeek agent from Roll's selectable agent registry.",
    ].join("");

    const facts = parseMergeCommitLog(text);

    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(922);
    expect(facts[0].mergeCommit).toBe("79101a83683ef341f0326b9b080298ee4abdefbe");
    expect(facts[0].storyIds).toEqual(["FIX-399"]);
  });

  it("does not use a body-only '(#N)' reference as PR identity", () => {
    const text = [
      rs,
      "abc123",
      fs,
      "1782233269",
      fs,
      "docs: mention issue reference\n\n",
      "This body mentions (#922), but the subject is not a PR merge.",
    ].join("");

    expect(parseMergeCommitLog(text)).toHaveLength(0);
  });

  it("accepts a story-id merge commit with no PR identity", () => {
    const text = [
      rs,
      "10a4ff247301927a82635ca4341d683d5f3a9f57",
      fs,
      "1782234189",
      fs,
      "FIX-923: parse merge commit bodies for delivery truth\n\n",
      "Parse full merge commit messages.",
    ].join("");

    const facts = parseMergeCommitLog(text);

    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(0);
    expect(facts[0].storyIds).toEqual(["FIX-923"]);
  });

  it("keeps multiple story-id merge commits with no PR identity", () => {
    const text = [
      rs,
      "newsha043",
      fs,
      "1782240570",
      fs,
      "US-AGENT-043: limit agent roster to six\n\n",
      rs,
      "oldsha923",
      fs,
      "1782234189",
      fs,
      "FIX-923: parse merge commit bodies for delivery truth\n\n",
    ].join("");

    const facts = parseMergeCommitLog(text);

    expect(facts.map((fact) => fact.mergeCommit)).toEqual(["newsha043", "oldsha923"]);
    expect(facts.flatMap((fact) => fact.storyIds)).toEqual(["US-AGENT-043", "FIX-923"]);
  });

  it("FIX-1046: recovers PR number from body when subject has story-id but no (#N)", () => {
    // Simulates a squash-merge whose subject names FIX-1044 but whose PR
    // reference (#1103) only appears in the body narrative.
    const text = [
      rs,
      "7cf70efa56802f49deef01b1c244b379e51bff87",
      fs,
      "1782235000",
      fs,
      "FIX-1044: delivered truth overrides stale unpublished cycles\n\n",
      "(#1103)",
    ].join("");

    const facts = parseMergeCommitLog(text);

    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(1103); // recovered from body
    expect(facts[0].mergeCommit).toBe("7cf70efa56802f49deef01b1c244b379e51bff87");
    expect(facts[0].storyIds).toEqual(["FIX-1044"]);
  });

  it("FIX-1046: body (#N) is NOT used when subject already has (#N)", () => {
    // When subject has (#1111) and body has (#2222), the subject wins.
    const text = [
      rs,
      "abc123",
      fs,
      "1782235000",
      fs,
      "Fix: some story (#1111)\n\n",
      "See also (#2222)",
    ].join("");

    const facts = parseMergeCommitLog(text);

    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(1111); // subject wins, not body
  });
});

// ── FIX-1024: squash commits only parse subject, not body ───────────────────

describe("parseMergeCommitLog — FIX-1024 squash subject-only attribution", () => {
  const rs = "\x1e";
  const fs = "\x1f";

  it("AC1: squash commit — subject id only; body narrative ignored", () => {
    // Real squash for #1028: subject names FIX-1022, body narrates FIX-1019/1020/1021.
    const text = [
      rs,
      "7c3aad550b3e01c42b92629d2b7f9c15c1234567",
      fs,
      "1782235000",
      fs,
      "Fix: FIX-1022 change log group unquote (#1028)\n\n",
      "补 FIX-1019 RepositoryCanPush 预检、FIX-1020 先建仓再 init、",
      "FIX-1021 roll init 总结/确认/--auto。",
    ].join("");

    const facts = parseMergeCommitLog(text);

    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(1028);
    expect(facts[0].storyIds).toEqual(["FIX-1022"]);
  });

  it("AC1: squash commit body narrative with card-ids does NOT leak", () => {
    const text = [
      rs,
      "abc4567",
      fs,
      "1782235100",
      fs,
      "feat: US-SOME-001 add feature (#500)\n\n",
      "This also cleaned up FIX-999 which was a longstanding bug",
      "and incidentally US-OTHER-002 test fixtures.",
    ].join("");

    const facts = parseMergeCommitLog(text);

    expect(facts).toHaveLength(1);
    expect(facts[0].storyIds).toEqual(["US-SOME-001"]);
  });

  it("AC2: merge-button commit still reads body story-ids (FIX-923 regression)", () => {
    const text = [
      rs,
      "79101a83683ef341f0326b9b080298ee4abdefbe",
      fs,
      "1782233269",
      fs,
      "Merge pull request #922 from seanyao/fix/remove-deepseek-phantom-agent\n\n",
      "FIX-399: remove phantom deepseek agent\n\n",
      "Remove the phantom DeepSeek agent from Roll's selectable agent registry.",
    ].join("");

    const facts = parseMergeCommitLog(text);

    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(922);
    expect(facts[0].storyIds).toEqual(["FIX-399"]);
  });

  it("non-PR commit with story-id in subject → parsed from subject only", () => {
    const text = [
      rs,
      "10a4ff247301927a82635ca4341d683d5f3a9f57",
      fs,
      "1782234189",
      fs,
      "FIX-923: parse merge commit bodies for delivery truth\n\n",
      "Also touched US-OTHER in some analysis.",
    ].join("");

    const facts = parseMergeCommitLog(text);

    expect(facts).toHaveLength(1);
    expect(facts[0].prNumber).toBe(0);
    expect(facts[0].storyIds).toEqual(["FIX-923"]);
  });
});

describe("rebuildDeliveriesFromFacts — FIX-904: merge subject = authoritative done", () => {
  it("FIX-389a/b/c subject with no matching runs → three done records", () => {
    // The real #893 salvage: merge names FIX-389a/b/c but no loop run carried
    // pr_number 893, and the FIX-389a run was failed.
    const runs = [makeRun({ storyId: "FIX-389a", outcome: "failed", prNumber: undefined, recordedAt: 100 })];
    const merges = parseMergeCommitMessages([
      "deadbee1234567 1719000000 FIX-389a/b/c — salvage delivery (#893)",
    ]);
    const result = rebuildDeliveriesFromFacts(runs, merges, "seanyao/roll");

    const a = result.find((r) => r.storyId === "FIX-389a");
    const b = result.find((r) => r.storyId === "FIX-389b");
    const c = result.find((r) => r.storyId === "FIX-389c");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    // FIX-389a had a run → done via story loop (merge beats failed run).
    expect(a!.lifecycleState).toBe("done");
    // FIX-389b/c had no run → done via merge-only pass with sentinel cycleId.
    expect(b!.lifecycleState).toBe("done");
    expect(c!.lifecycleState).toBe("done");
    expect(b!.cycleId).toBe("merge:deadbee");
    expect(c!.cycleId).toBe("merge:deadbee");
    // All carry the merge commit + PR.
    expect(a!.mergeCommit).toEqual({ present: true, value: "deadbee1234567" });
    expect(b!.mergeCommit).toEqual({ present: true, value: "deadbee1234567" });
    expect(b!.prNumber).toEqual({ present: true, value: 893 });
    expect(b!.prUrl).toEqual({ present: true, value: "https://github.com/seanyao/roll/pull/893" });
  });

  it("failed run + merge subject referencing the story → done (merge wins)", () => {
    const runs = [makeRun({ storyId: "FIX-500", outcome: "failed", prNumber: undefined, recordedAt: 100 })];
    const merges = parseMergeCommitMessages([
      "cafe1234567890 1719000000 FIX-500: fix the thing (#777)",
    ]);
    const result = rebuildDeliveriesFromFacts(runs, merges, "seanyao/roll");
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-500");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].mergeCommit).toEqual({ present: true, value: "cafe1234567890" });
    expect(result[0].prNumber).toEqual({ present: true, value: 777 });
    // run loop path keeps the run's cycleId, not the sentinel
    expect(result[0].cycleId).toBe("cycle-default");
  });

  it("loop-cycle merge subject does NOT mark any story done", () => {
    const runs = [makeRun({ storyId: "US-INFLIGHT", outcome: "published_pending_merge", prNumber: 1, recordedAt: 100 })];
    const merges = parseMergeCommitMessages([
      "beef1234567890 1719000000 loop cycle cycle-20260621-014644 (#892)",
    ]);
    const result = rebuildDeliveriesFromFacts(runs, merges, "seanyao/roll");
    // Only the in-flight story, no merge-derived done records.
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-INFLIGHT");
    expect(result[0].lifecycleState).toBe("pending_merge");
  });

  it("does not double-emit when a story has both a run AND a merge subject", () => {
    const runs = [makeRun({ storyId: "FIX-600", outcome: "failed", prNumber: undefined, recordedAt: 100 })];
    const merges = parseMergeCommitMessages([
      "abcd1234567890 1719000000 FIX-600: done (#601)",
    ]);
    const result = rebuildDeliveriesFromFacts(runs, merges);
    // Exactly one record for FIX-600 (run loop handled it; merge-only pass skips).
    expect(result.filter((r) => r.storyId === "FIX-600")).toHaveLength(1);
  });

  it("failed run + GitHub merge body referencing the story → done (merge wins)", () => {
    const runs = [makeRun({ storyId: "FIX-399", outcome: "failed", prNumber: undefined, recordedAt: 100 })];
    const merges = parseMergeCommitLog([
      "\x1e",
      "79101a83683ef341f0326b9b080298ee4abdefbe",
      "\x1f",
      "1782233269",
      "\x1f",
      "Merge pull request #922 from seanyao/fix/remove-deepseek-phantom-agent\n\n",
      "FIX-399: remove phantom deepseek agent",
    ].join(""));
    const result = rebuildDeliveriesFromFacts(runs, merges, "seanyao/roll");

    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-399");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].mergeCommit).toEqual({
      present: true,
      value: "79101a83683ef341f0326b9b080298ee4abdefbe",
    });
    expect(result[0].prNumber).toEqual({ present: true, value: 922 });
    expect(result[0].prUrl).toEqual({ present: true, value: "https://github.com/seanyao/roll/pull/922" });
  });

  it("FIX-1266 (#1034): subject-only merge with no PR link does NOT mark the story done", () => {
    // A commit whose subject names a story but carries no (#N) PR reference is
    // a subject-only mention (direct-to-main / tcr micro-commit), NOT a
    // delivery. Under FIX-904 this used to become `done`; FIX-1266 closes that.
    const merges = parseMergeCommitLog([
      "\x1e",
      "10a4ff247301927a82635ca4341d683d5f3a9f57",
      "\x1f",
      "1782234189",
      "\x1f",
      "FIX-923: parse merge commit bodies for delivery truth",
    ].join(""));
    const result = rebuildDeliveriesFromFacts([], merges, "seanyao/roll");

    // No delivery record at all → the card stays Todo/pickable.
    expect(result).toHaveLength(0);
  });

  it("oldest merge wins when two subjects name the same story (FIX-1206)", () => {
    const merges = parseMergeCommitMessages([
      "newsha1234567 1719000200 FIX-700: redo (#702)",  // newer merge
      "oldsha1234567 1719000100 FIX-700: first (#701)", // older, original code PR
    ]);
    const result = rebuildDeliveriesFromFacts([], merges);
    expect(result).toHaveLength(1);
    // oldest merge should win — original code delivery, not a later mention
    expect(result[0].mergeCommit).toEqual({ present: true, value: "oldsha1234567" });
    expect(result[0].prNumber).toEqual({ present: true, value: 701 });
  });

  it("changelog PR does not override code PR delivery attribution (FIX-1206)", () => {
    // Realistic scenario: code PR first (older), changelog PR later (newer)
    const merges = parseMergeCommitMessages([
      "abCdef1234 1719000300 Changelog: update docs for FIX-1206 (#703)",
      "9a8b7c6d5e 1719000200 FIX-1206: fix delivery projection (#702)",
    ]);
    const result = rebuildDeliveriesFromFacts([], merges);
    expect(result).toHaveLength(1);
    // The code PR (older) should be the delivery projection, not the changelog PR
    expect(result[0].mergeCommit).toEqual({ present: true, value: "9a8b7c6d5e" });
    expect(result[0].prNumber).toEqual({ present: true, value: 702 });
    expect(result[0].storyId).toBe("FIX-1206");
  });

  it("merge-only done records are deterministic", () => {
    const merges = parseMergeCommitMessages([
      "sha11234567890 1719000000 FIX-389a/b/c … (#893)",
    ]);
    const r1 = rebuildDeliveriesFromFacts([], merges, "o/r");
    const r2 = rebuildDeliveriesFromFacts([], merges, "o/r");
    expect(r1).toEqual(r2);
  });
});

// ── FIX-1208: in-repo .roll-only commits must not falsely deliver ────────────

describe("rebuildDeliveriesFromFacts — FIX-1208: meta-only subject attribution", () => {
  it("does NOT mark a story done when the merge only touches .roll paths", () => {
    // Simulates an in-repo .roll project where creating the card produced a
    // commit whose subject mentions the story-id but changed only meta files.
    const merges = [makeMerge({
      prNumber: 0,
      mergeCommit: "rollonlysha1234",
      mergedAt: 3000,
      storyIds: ["FIX-1208"],
      touchesProductCode: false,
    })];
    const result = rebuildDeliveriesFromFacts([], merges);
    // No record at all: the .roll-only commit is not authoritative delivery
    // evidence, and there is no run for FIX-1208 either.
    expect(result).toHaveLength(0);
  });

  it("still marks a story done when the merge touches product code (PR-linked)", () => {
    // FIX-1266: a product-code delivery must ALSO carry a PR link. The original
    // FIX-1208 fixture used prNumber:0 to isolate the touchesProductCode gate;
    // a realistic product-code delivery is squash-merged with a (#N), so it is
    // PR-linked here.
    const merges = [makeMerge({
      prNumber: 1208,
      mergeCommit: "codesha12345678",
      mergedAt: 3000,
      storyIds: ["FIX-1208"],
      touchesProductCode: true,
    })];
    const result = rebuildDeliveriesFromFacts([], merges, "seanyao/roll");
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-1208");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].mergeCommit).toEqual({
      present: true,
      value: "codesha12345678",
    });
  });

  it("defaults to product-code attribution when touchesProductCode is omitted (PR-linked)", () => {
    const merges: MergeFact[] = [{
      prNumber: 1209,
      mergeCommit: "legacysha123456",
      mergedAt: 3000,
      storyIds: ["FIX-1208"],
      // touchesProductCode intentionally omitted
    }];
    const result = rebuildDeliveriesFromFacts([], merges);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-1208");
    expect(result[0].lifecycleState).toBe("done");
  });

  it("keeps PR-based merge matching even when the merge is meta-only", () => {
    // A real loop run published a PR and that PR merged. Even if the merge
    // commit's diff is somehow classified as meta-only, the run-based PR match
    // should still win because the run recorded the actual delivery intent.
    const runs = [makeRun({
      storyId: "FIX-1208",
      outcome: "published_pending_merge",
      prNumber: 1000,
      recordedAt: 100,
    })];
    const merges = [makeMerge({
      prNumber: 1000,
      mergeCommit: "prmerge12345678",
      mergedAt: 3000,
      storyIds: ["FIX-1208"],
      touchesProductCode: false,
    })];
    const result = rebuildDeliveriesFromFacts(runs, merges);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-1208");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].prNumber).toEqual({ present: true, value: 1000 });
  });
});

// ── FIX-1266 (#1034): subject-only mention is not a delivery ──────────────────

describe("mergeProvenance (FIX-1266)", () => {
  it("classifies a PR-linked merge", () => {
    expect(mergeProvenance(makeMerge({ prNumber: 42 }))).toBe("pr_linked");
  });

  it("classifies a subject-only merge (no PR reference)", () => {
    expect(mergeProvenance(makeMerge({ prNumber: 0, storyIds: ["FIX-1266"] }))).toBe(
      "subject_only",
    );
  });

  it("parseMergeCommitLog yields subject_only for a no-(#N) subject", () => {
    const [m] = parseMergeCommitMessages(["deadbeef123 1719000000 FIX-1266: fix the thing"]);
    expect(m).toBeDefined();
    expect(mergeProvenance(m!)).toBe("subject_only");
  });
});

describe("unattributedSubjectOnlyMerges (FIX-1266)", () => {
  it("surfaces product-code subject-only merges as diagnostics", () => {
    const merges = [
      makeMerge({ prNumber: 0, mergeCommit: "sha1", storyIds: ["FIX-1266"], touchesProductCode: true }),
    ];
    expect(unattributedSubjectOnlyMerges(merges)).toEqual([
      { storyId: "FIX-1266", mergeCommit: "sha1", mergedAt: 2000 },
    ]);
  });

  it("excludes PR-linked merges", () => {
    const merges = [makeMerge({ prNumber: 7, mergeCommit: "sha2", storyIds: ["FIX-1266"] })];
    expect(unattributedSubjectOnlyMerges(merges)).toEqual([]);
  });

  it("excludes .roll-only (meta) subject-only merges (FIX-1208)", () => {
    const merges = [
      makeMerge({ prNumber: 0, mergeCommit: "sha3", storyIds: ["FIX-1266"], touchesProductCode: false }),
    ];
    expect(unattributedSubjectOnlyMerges(merges)).toEqual([]);
  });

  it("de-duplicates repeated story/sha pairs", () => {
    const merges = [
      makeMerge({ prNumber: 0, mergeCommit: "sha4", storyIds: ["FIX-1266", "FIX-1266"], touchesProductCode: true }),
    ];
    expect(unattributedSubjectOnlyMerges(merges)).toHaveLength(1);
  });
});

describe("rebuildDeliveriesFromFacts — FIX-1266: subject-only cannot complete a card", () => {
  it("product-code subject-only merge with no run does NOT create done", () => {
    // The Issue #1034 signature: a product-code commit on main whose message
    // mentions a card but has no PR/publish/run evidence.
    const merges = [makeMerge({
      prNumber: 0,
      mergeCommit: "phantomsha1234",
      mergedAt: 3000,
      storyIds: ["FIX-1266"],
      touchesProductCode: true,
    })];
    const result = rebuildDeliveriesFromFacts([], merges, "seanyao/roll");
    expect(result).toHaveLength(0);
  });

  it("subject-only merge cannot promote a failed run to done", () => {
    // A subject-only mention CORROBORATES nothing — it must not flip a failed
    // run into a delivery. The card stays failed (its latest real outcome).
    const runs = [makeRun({ storyId: "FIX-1266", outcome: "failed", prNumber: undefined, recordedAt: 100 })];
    const merges = [makeMerge({
      prNumber: 0,
      mergeCommit: "phantomsha5678",
      mergedAt: 3000,
      storyIds: ["FIX-1266"],
      touchesProductCode: true,
    })];
    const result = rebuildDeliveriesFromFacts(runs, merges);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-1266");
    expect(result[0].lifecycleState).toBe("failed");
  });

  it("PR-linked squash merge is still a delivery (preserved)", () => {
    const merges = parseMergeCommitMessages([
      "prlinkedsha123 1719000000 FIX-1266: require delivery evidence (#1300)",
    ]);
    const result = rebuildDeliveriesFromFacts([], merges, "seanyao/roll");
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-1266");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].prNumber).toEqual({ present: true, value: 1300 });
  });

  it("run/ledger-correlated manual merge is still a delivery (preserved)", () => {
    // No PR number, but a run recorded the actual merge commit SHA (manual /
    // external salvage). The run-correlation path — not subject attribution —
    // authorizes the done. The subject-only merge merely corroborates it.
    const runs = [makeRun({
      storyId: "FIX-1266",
      outcome: "delivered",
      prNumber: undefined,
      mergeCommit: "manualsha9999",
      mergedAt: 3000000,
      recordedAt: 100,
    })];
    const merges = [makeMerge({
      prNumber: 0,
      mergeCommit: "manualsha9999",
      mergedAt: 3000,
      storyIds: ["FIX-1266"],
      touchesProductCode: true,
    })];
    const result = rebuildDeliveriesFromFacts(runs, merges);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].mergeCommit).toEqual({ present: true, value: "manualsha9999" });
  });

  it("metadata-only subject-only merge does NOT create done (FIX-1208 preserved)", () => {
    const merges = [makeMerge({
      prNumber: 0,
      mergeCommit: "metasha0000",
      mergedAt: 3000,
      storyIds: ["FIX-1266"],
      touchesProductCode: false,
    })];
    expect(rebuildDeliveriesFromFacts([], merges)).toHaveLength(0);
  });

  it("idempotent replay: phantom subject-only merge stays non-delivered", () => {
    const merges = [makeMerge({
      prNumber: 0,
      mergeCommit: "phantomidem",
      mergedAt: 3000,
      storyIds: ["FIX-1266"],
      touchesProductCode: true,
    })];
    const r1 = rebuildDeliveriesFromFacts([], merges, "o/r");
    const r2 = rebuildDeliveriesFromFacts([], merges, "o/r");
    expect(r1).toEqual(r2);
    expect(r1).toHaveLength(0);
  });

  it("picker/truth projection: a phantom record cannot mark the card delivered", () => {
    // Integration across rebuild → queryStoryDelivery (what the picker's
    // hasMergedDelivery guard consults). A subject-only phantom must leave
    // delivered=false so the unbuilt card stays in the backlog candidate set.
    const merges = [makeMerge({
      prNumber: 0,
      mergeCommit: "phantompick",
      mergedAt: 3000,
      storyIds: ["FIX-1266"],
      touchesProductCode: true,
    })];
    const records = rebuildDeliveriesFromFacts([], merges, "seanyao/roll");
    const truth = queryStoryDelivery("FIX-1266", records);
    expect(truth.delivered).toBe(false);
    expect(truth.lifecycleState).toBe("todo");
  });

  it("picker/truth projection: a real PR-linked delivery IS marked delivered", () => {
    const merges = parseMergeCommitMessages([
      "realpicksha 1719000000 FIX-1266: real delivery (#1301)",
    ]);
    const records = rebuildDeliveriesFromFacts([], merges, "seanyao/roll");
    const truth = queryStoryDelivery("FIX-1266", records);
    expect(truth.delivered).toBe(true);
  });
});

// ── FIX-1270: docs/chore PR title-mention is not a delivery ──────────────────

describe("isNonDeliverySubject (FIX-1270)", () => {
  it("flags docs: and chore: subjects", () => {
    expect(isNonDeliverySubject("docs: CHANGELOG sweep — FIX-1259..1267 (#1398)")).toBe(true);
    expect(isNonDeliverySubject("chore: bump deps (#12)")).toBe(true);
    expect(isNonDeliverySubject("docs(loop): tidy runbook")).toBe(true);
    expect(isNonDeliverySubject("chore!: drop legacy path")).toBe(true);
    expect(isNonDeliverySubject("  DOCS: leading space, upper")).toBe(true);
  });

  it("does NOT flag delivery-type subjects", () => {
    expect(isNonDeliverySubject("Fix: FIX-1270 real delivery (#1400)")).toBe(false);
    expect(isNonDeliverySubject("Story 7: US-LOOP-107 (#1388)")).toBe(false);
    expect(isNonDeliverySubject("tcr: US-X wire it (#9)")).toBe(false);
    expect(isNonDeliverySubject("US-LOOP-107a: split child (#1388)")).toBe(false);
    // "documentation" is not the docs: type prefix
    expect(isNonDeliverySubject("Refactor: documentation helper (#3)")).toBe(false);
  });
});

describe("rebuildDeliveriesFromFacts — FIX-1270: sweep-PR misattribution", () => {
  // The exact 2026-07-16 signature: a squash-merged CHANGELOG sweep whose
  // title lists many card-ids. It is PR-linked (#1398) and touches product
  // code (CHANGELOG.md), so neither the subject_only nor the FIX-1208 gate
  // catches it.
  const SWEEP_LOG = [
    "\x1e",
    "b1cbd4ef00000000000000000000000000000000",
    "\x1f",
    "1784178000",
    "\x1f",
    "docs: CHANGELOG sweep — FIX-1259..1267, US-LOOP-107..109, US-BROW-017..023 (#1398)",
  ].join("");

  it("a docs sweep PR does not write ANY card's delivery projection", () => {
    const merges = parseMergeCommitLog(SWEEP_LOG);
    // Sanity: the parser recognises it as a non-delivery merge.
    expect(merges).toHaveLength(1);
    expect(merges[0].nonDelivery).toBe(true);
    expect(merges[0].prNumber).toBe(1398);

    const result = rebuildDeliveriesFromFacts([], merges, "seanyao/roll");
    // None of the mentioned cards become a delivery on the sweep's account.
    expect(result).toHaveLength(0);
    for (const id of ["US-LOOP-107", "FIX-1259", "US-BROW-017"]) {
      expect(queryStoryDelivery(id, result).delivered).toBe(false);
    }
  });

  it("sweep PR does not override the card's real (older) delivery PR", () => {
    // US-LOOP-107 really shipped via a split child's code PR; the later docs
    // sweep merely mentions the parent id. The real code PR must remain the
    // attribution and the sweep must not add a phantom parent record.
    const merges = parseMergeCommitMessages([
      // newer: the docs sweep (reverse-chronological input → first)
      "b1cbd4ef000 1784178000 docs: CHANGELOG sweep — US-LOOP-107..109 (#1398)",
      // older: the genuine code delivery for the parent id
      "codesha00000 1784100000 Story: US-LOOP-107 core change (#1388)",
    ]);
    const result = rebuildDeliveriesFromFacts([], merges, "seanyao/roll");
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-LOOP-107");
    expect(result[0].prNumber).toEqual({ present: true, value: 1388 });
    expect(result[0].mergeCommit).toEqual({ present: true, value: "codesha00000" });
  });

  it("a genuine doc-update STORY still attributes through its run (run-path untouched)", () => {
    // A closing doc-update story delivered by a loop cycle records its PR in a
    // run. That run/PR-correlation — not subject attribution — authorises done,
    // so the docs: prefix does not suppress a real doc-story delivery.
    const runs = [makeRun({
      storyId: "US-DOC-1",
      outcome: "published_pending_merge",
      prNumber: 1500,
      recordedAt: 100,
    })];
    const merges = parseMergeCommitMessages([
      "docstorysha0 1784178000 docs: US-DOC-1 refresh guide (#1500)",
    ]);
    const result = rebuildDeliveriesFromFacts(runs, merges, "seanyao/roll");
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-DOC-1");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].prNumber).toEqual({ present: true, value: 1500 });
  });

  it("sanctioned correction path: rebuild recomputes a polluted projection clean", () => {
    // deliveries.jsonl is a rebuildable cache; `roll loop reconcile` overwrites
    // it via ensureDeliveriesFresh → rebuildDeliveriesFromFacts. Simulate a
    // previously-polluted world (before the fix a sweep produced a phantom
    // US-LOOP-107 record) by rebuilding from the corrected facts: the phantom
    // is gone, and replay is idempotent.
    const merges = parseMergeCommitLog(SWEEP_LOG);
    const r1 = rebuildDeliveriesFromFacts([], merges, "seanyao/roll");
    const r2 = rebuildDeliveriesFromFacts([], merges, "seanyao/roll");
    expect(r1).toEqual(r2);
    expect(r1.some((d) => d.storyId === "US-LOOP-107")).toBe(false);
  });

  it("docs sweep is excluded from unattributed diagnostics too", () => {
    const merges = [makeMerge({
      prNumber: 0,
      mergeCommit: "sweepsubjectonly",
      storyIds: ["US-LOOP-107"],
      touchesProductCode: true,
      nonDelivery: true,
    })];
    expect(unattributedSubjectOnlyMerges(merges)).toEqual([]);
  });
});

// ── collectRunFacts ──────────────────────────────────────────────────────────

describe("collectRunFacts", () => {
  it("parses valid JSONL into RunFacts", () => {
    const text = [
      JSON.stringify({ story_id: "US-A", cycle_id: "c1", status: "built", ts: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ story_id: "US-B", cycle_id: "c2", status: "merged", outcome: "delivered", pr_number: 42, ts: "2026-01-02T00:00:00Z" }),
    ].join("\n");
    const facts = collectRunFacts(text);
    expect(facts).toHaveLength(2);
    expect(facts[0].storyId).toBe("US-A");
    expect(facts[1].storyId).toBe("US-B");
    expect(facts[1].prNumber).toBe(42);
  });

  it("skips empty lines", () => {
    const text = "\n\n" + JSON.stringify({ story_id: "US-X", cycle_id: "c1", status: "built", ts: "2026-01-01T00:00:00Z" }) + "\n\n";
    const facts = collectRunFacts(text);
    expect(facts).toHaveLength(1);
  });

  it("skips unparseable JSON lines", () => {
    const text = [
      "not json",
      JSON.stringify({ story_id: "US-V", cycle_id: "c1", status: "built", ts: "2026-01-01T00:00:00Z" }),
      "{broken",
    ].join("\n");
    const facts = collectRunFacts(text);
    expect(facts).toHaveLength(1);
    expect(facts[0].storyId).toBe("US-V");
  });

  it("skips rows without story_id", () => {
    const text = JSON.stringify({ cycle_id: "c1", status: "built" });
    const facts = collectRunFacts(text);
    expect(facts).toHaveLength(0);
  });

  it("skips rows without cycle_id", () => {
    const text = JSON.stringify({ story_id: "US-NO", status: "built" });
    const facts = collectRunFacts(text);
    expect(facts).toHaveLength(0);
  });

  it("handles empty input", () => {
    expect(collectRunFacts("")).toHaveLength(0);
  });
});

// ── ensureDeliveriesFresh ────────────────────────────────────────────────────

/** File entry for the fake FreshnessPort. */
interface FakeFileEntry {
  text: string;
  mtime: number;
}

/** In-memory FreshnessPort for testing. */
function fakeFreshnessPort(initial: Record<string, FakeFileEntry> = {}): FreshnessPort & { _files: Map<string, FakeFileEntry> } {
  const files = new Map<string, FakeFileEntry>();
  for (const [k, v] of Object.entries(initial)) {
    files.set(k, v);
  }
  return {
    _files: files,
    mtimeMs(absPath: string): number | undefined {
      const f = files.get(absPath);
      return f?.mtime;
    },
    readText(absPath: string): string {
      const f = files.get(absPath);
      return f?.text ?? "";
    },
    writeText(absPath: string, text: string): void {
      files.set(absPath, { text, mtime: Date.now() });
    },
  };
}

/** Fake ExecPort that returns canned responses per argv. */
function fakeExecPort(
  responses: Record<string, ExecResult> = {},
): ExecPort {
  return {
    run(_tool: string, argv: readonly string[]): ExecResult {
      const key = argv.join(" ");
      if (key in responses) return responses[key]!;
      const legacyKey = key.replace("--format=%x1e%H%x1f%ct%x1f%B", "--format=%H %ct %s");
      if (legacyKey in responses) return responses[legacyKey]!;
      // Default: command not found / error
      return { stdout: "", code: 128 };
    },
  };
}

describe("ensureDeliveriesFresh", () => {
  const PROJ = "/fake/project";
  const RUNS = `${PROJ}/.roll/loop/runs.jsonl`;
  const DEL = `${PROJ}/.roll/loop/deliveries.jsonl`;

  it("returns cached deliveries when fresh (del mtime ≥ runs mtime)", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: JSON.stringify({ story_id: "US-OLD", cycle_id: "c1", status: "built", ts: "2026-01-01T00:00:00Z" }), mtime: 1000 },
      [DEL]: { text: JSON.stringify({ storyId: "US-CACHED", cycleId: "c1", lifecycleState: "done", recordedAt: 2000 }), mtime: 2000 },
    });
    const exec = fakeExecPort();

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    // Fresh → should read from cache without rebuilding
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-CACHED");
    expect(result[0].lifecycleState).toBe("done");
  });

  it("reads a canonical Workspace runtime authority when explicitly supplied", () => {
    const runtimeRoot = `${PROJ}/runtime`;
    const runsPath = `${runtimeRoot}/runs.jsonl`;
    const deliveriesPath = `${runtimeRoot}/deliveries.jsonl`;
    const freshness = fakeFreshnessPort({
      [runsPath]: { text: "", mtime: 1000 },
      [deliveriesPath]: {
        text: JSON.stringify({ storyId: "US-WORKSPACE", cycleId: "c1", lifecycleState: "done", recordedAt: 2000 }),
        mtime: 2000,
      },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, fakeExecPort(), undefined, runtimeRoot);

    expect(result).toHaveLength(1);
    expect(result[0]?.storyId).toBe("US-WORKSPACE");
    expect(freshness._files.has(`${PROJ}/.roll/loop/deliveries.jsonl`)).toBe(false);
  });

  it("rebuilds when deliveries is missing", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-NEW", cycle_id: "c1", status: "built", outcome: "published_pending_merge", pr_number: 42, ts: "2026-01-01T00:00:00Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "", code: 128 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-NEW");
    expect(result[0].lifecycleState).toBe("pending_merge");
    // Cache should have been written
    expect(freshness._files.has(DEL)).toBe(true);
  });

  it("rebuilds when runs is newer than deliveries", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-STALE", cycle_id: "c2", status: "built", outcome: "published_pending_merge", pr_number: 99, ts: "2026-01-02T00:00:00Z" }),
      ].join("\n"), mtime: 5000 },
      [DEL]: { text: JSON.stringify({ storyId: "US-STALE", cycleId: "c1", lifecycleState: "todo", recordedAt: 1000 }), mtime: 1000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "", code: 128 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("pending_merge");
    expect(result[0].prNumber).toEqual({ present: true, value: 99 });
  });

  it("uses git merge evidence to mark stories as done", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-MERGED", cycle_id: "c1", status: "built", outcome: "published_pending_merge", pr_number: 883, ts: "2026-01-01T00:00:00Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: {
        stdout: "9efd807189ca538ccde38bfb55f461b2a5e614c9 1718885251 Merge pull request #883 from branch/fix",
        code: 0,
      },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "git@github.com:seanyao/roll.git", code: 0 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].prNumber).toEqual({ present: true, value: 883 });
    expect(result[0].mergeCommit).toEqual({ present: true, value: "9efd807189ca538ccde38bfb55f461b2a5e614c9" });
    expect(result[0].prUrl).toEqual({ present: true, value: "https://github.com/seanyao/roll/pull/883" });
  });

  it("AC2: rebuild is deterministic (same input → same output)", () => {
    const freshness1 = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-DET", cycle_id: "c1", status: "built", outcome: "published_pending_merge", pr_number: 1, ts: "2026-01-01T00:00:00Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const freshness2 = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-DET", cycle_id: "c1", status: "built", outcome: "published_pending_merge", pr_number: 1, ts: "2026-01-01T00:00:00Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "", code: 128 },
    });

    const r1 = ensureDeliveriesFresh(PROJ, freshness1, exec);
    const r2 = ensureDeliveriesFresh(PROJ, freshness2, exec);
    expect(r1).toEqual(r2);
  });

  it("handles missing runs.jsonl gracefully", () => {
    const freshness = fakeFreshnessPort({
      [DEL]: { text: JSON.stringify({ storyId: "US-ONLY", cycleId: "c1", lifecycleState: "done", recordedAt: 2000 }), mtime: 2000 },
    });
    const exec = fakeExecPort();

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    // Fresh cache (no runs to compare against) → returns cached
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-ONLY");
  });

  it("handles git failure gracefully (rebuilds from runs alone)", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-NOGIT", cycle_id: "c1", status: "built", outcome: "failed", ts: "2026-01-01T00:00:00Z" }),
      ].join("\n"), mtime: 2000 },
    });
    // Git always fails
    const exec = fakeExecPort();

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("failed");
  });

  it("skips rows with unparseable JSON in runs", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        "not valid json",
        JSON.stringify({ story_id: "US-GOOD", cycle_id: "c1", status: "built", outcome: "published_pending_merge", ts: "2026-01-01T00:00:00Z" }),
        "{also bad",
      ].join("\n"), mtime: 2000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "", code: 128 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-GOOD");
  });

  it("detects squash-merges with (#N) in subject", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-SQUASH", cycle_id: "c1", status: "built", outcome: "published_pending_merge", ts: "2026-01-01T00:00:00Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const exec = fakeExecPort({
      // No standard merge commits
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: { stdout: "", code: 0 },
      // But a squash-merge with (#883) in the subject
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: {
        stdout: "9efd807189ca538ccde38bfb55f461b2a5e614c9 1718885251 tcr: US-TRUTH-016 — CLI truth query command + alignment tests (#883)",
        code: 0,
      },
      [`-C ${PROJ} diff-tree --no-commit-id --name-only -r 9efd807189ca538ccde38bfb55f461b2a5e614c9`]: {
        stdout: "packages/core/src/delivery/rebuild.ts",
        code: 0,
      },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "git@github.com:seanyao/roll.git", code: 0 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    // The squash-merge pass collects PR #883 AND parses its story-id
    // (US-TRUTH-016) from the subject. Under FIX-904 that subject is the
    // authoritative `done` signal even though no run carries pr_number 883.
    // The unrelated in-flight US-SQUASH run stays pending_merge.
    expect(result).toHaveLength(2);
    const squash = result.find((r) => r.storyId === "US-SQUASH");
    const truth = result.find((r) => r.storyId === "US-TRUTH-016");
    expect(squash!.lifecycleState).toBe("pending_merge");
    expect(truth!.lifecycleState).toBe("done");
    expect(truth!.prNumber).toEqual({ present: true, value: 883 });
    expect(truth!.mergeCommit).toEqual({ present: true, value: "9efd807189ca538ccde38bfb55f461b2a5e614c9" });
    // No run for US-TRUTH-016 → sentinel cycleId.
    expect(truth!.cycleId).toBe("merge:9efd807");
  });

  it("FIX-1208: ignores squash merge whose subject names a card but only touches .roll paths", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: "", mtime: 2000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: {
        stdout: "rollonlysha00000000000000000000000000000000 1719000000 docs: create FIX-1208 card (#1000)",
        code: 0,
      },
      [`-C ${PROJ} diff-tree --no-commit-id --name-only -r rollonlysha00000000000000000000000000000000`]: {
        stdout: ".roll/features/loop-engine/FIX-1208/spec.md",
        code: 0,
      },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "", code: 128 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    // The commit's subject names FIX-1208, but it only touched a `.roll/`
    // path (card creation). No delivery record should be emitted.
    expect(result).toHaveLength(0);
  });

  it("FIX-1208: keeps real delivery when squash merge touches product code", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: "", mtime: 2000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: {
        stdout: "codesha0000000000000000000000000000000000 1719000000 fix: repair projection for FIX-1208 (#1001)",
        code: 0,
      },
      [`-C ${PROJ} diff-tree --no-commit-id --name-only -r codesha0000000000000000000000000000000000`]: {
        stdout: "packages/core/src/delivery/rebuild.ts\n.roll/backlog.md",
        code: 0,
      },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "", code: 128 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-1208");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].prNumber).toEqual({ present: true, value: 1001 });
  });

  it("FIX-1266: product-code commit naming a card with no (#N) PR does NOT deliver (stale cache rebuild)", () => {
    // The Issue #1034 signature end-to-end: a product-code commit on main whose
    // subject mentions FIX-1266 but carries no PR reference and has no run.
    // Rebuild from stale cache must leave it unattributed → card stays Todo.
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: "", mtime: 2000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: {
        stdout: "phantomsha000000000000000000000000000000 1719000000 tcr: FIX-1266 — tweak projection",
        code: 0,
      },
      [`-C ${PROJ} diff-tree --no-commit-id --name-only -r phantomsha000000000000000000000000000000`]: {
        stdout: "packages/core/src/delivery/rebuild.ts",
        code: 0,
      },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "", code: 128 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(0);
  });

  it("squash-merge + run with backfill mergeCommit → done", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-TRUTH-016", cycle_id: "c1", status: "merged", outcome: "delivered", merge_commit: "9efd807189ca538ccde38bfb55f461b2a5e614c9", merged_at: 1718885252000, ts: "2026-06-20T18:06:16Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: {
        stdout: "9efd807189ca538ccde38bfb55f461b2a5e614c9 1718885251 tcr: US-TRUTH-016 — CLI truth query (#883)",
        code: 0,
      },
      [`-C ${PROJ} diff-tree --no-commit-id --name-only -r 9efd807189ca538ccde38bfb55f461b2a5e614c9`]: {
        stdout: "packages/core/src/delivery/rebuild.ts",
        code: 0,
      },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "git@github.com:seanyao/roll.git", code: 0 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-TRUTH-016");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].mergeCommit).toEqual({ present: true, value: "9efd807189ca538ccde38bfb55f461b2a5e614c9" });
    expect(result[0].prNumber).toEqual({ present: true, value: 883 });
    expect(result[0].prUrl).toEqual({ present: true, value: "https://github.com/seanyao/roll/pull/883" });
  });
});

// ── REFACTOR-070: failure_class/root_cause_key projection ─────────────────

describe("rebuildDeliveriesFromFacts — REFACTOR-070: failure attribution projection", () => {
  it("published_pending_merge ignores retired environment attribution", () => {
    const runs = [makeRun({
      storyId: "US-NOPRLOOP",
      outcome: "published_pending_merge",
      prNumber: 99,
      failureClass: "env",
      rootCauseKey: "env:pr_loop",
      recordedAt: 200,
    })];
    const result = rebuildDeliveriesFromFacts(runs, [], "o/r");
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("pending_merge");
    expect(result[0].prNumber).toEqual({ present: true, value: 99 });
  });

  it("published_pending_merge + failure_class=card → stays pending_merge", () => {
    const runs = [makeRun({
      storyId: "US-CARDFAIL",
      outcome: "published_pending_merge",
      prNumber: 100,
      failureClass: "card",
      rootCauseKey: "card:agent_after_build",
      recordedAt: 200,
    })];
    const result = rebuildDeliveriesFromFacts(runs, [], "o/r");
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("pending_merge");
  });

  it("published_pending_merge without failure_class stays pending_merge (back-compat)", () => {
    const runs = [makeRun({
      storyId: "US-OLDROW",
      outcome: "published_pending_merge",
      prNumber: 101,
      recordedAt: 200,
    })];
    const result = rebuildDeliveriesFromFacts(runs, [], "o/r");
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("pending_merge");
  });

  it("published_pending_merge + failure_class=env + non-pr_loop root → pending_merge", () => {
    const runs = [makeRun({
      storyId: "US-ENVAUTH",
      outcome: "published_pending_merge",
      prNumber: 102,
      failureClass: "env",
      rootCauseKey: "env:auth",
      recordedAt: 200,
    })];
    const result = rebuildDeliveriesFromFacts(runs, [], "o/r");
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("pending_merge");
  });
});

describe("extractRunFact — REFACTOR-070: reads failure_class/root_cause_key", () => {
  it("extracts failure_class and root_cause_key from runs row", () => {
    const row: Record<string, unknown> = {
      story_id: "US-ATTR",
      cycle_id: "c1",
      status: "published",
      outcome: "published_pending_merge",
      failure_class: "env",
      root_cause_key: "env:pr_loop",
      ts: "2026-01-01T00:00:00Z",
    };
    const f = extractRunFact(row);
    expect(f).not.toBeNull();
    expect(f!.failureClass).toBe("env");
    expect(f!.rootCauseKey).toBe("env:pr_loop");
  });

  it("failure_class/root_cause_key absent → undefined (back-compat)", () => {
    const row: Record<string, unknown> = {
      story_id: "US-NOATTR",
      cycle_id: "c1",
      status: "built",
      ts: "2026-01-01T00:00:00Z",
    };
    const f = extractRunFact(row);
    expect(f).not.toBeNull();
    expect(f!.failureClass).toBeUndefined();
    expect(f!.rootCauseKey).toBeUndefined();
  });
});

describe("nodeExecPort", () => {
  it("captures command output larger than Node's default execFileSync buffer", () => {
    const bytes = 2 * 1024 * 1024;
    const result = nodeExecPort.run(process.execPath, [
      "-e",
      `process.stdout.write("x".repeat(${bytes}))`,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(bytes);
  });
});

// ── FIX-905: rebuild reads origin/main (authoritative remote) ────────────────

describe("ensureDeliveriesFresh — FIX-905: origin/main is authoritative", () => {
  const PROJ = "/fake/project";
  const RUNS = `${PROJ}/.roll/loop/runs.jsonl`;
  const DEL = `${PROJ}/.roll/loop/deliveries.jsonl`;
  const HEAD = `${PROJ}/.roll/loop/deliveries.head`;

  const ORIGIN_SHA = "cfaaa3300000000000000000000000000000abcd";
  const LOCAL_SHA = "f8156ed0000000000000000000000000000f00ba";

  it("reads merges from origin/main when it resolves (local main lags)", () => {
    // The bug scenario: a card merged on origin/main but local `main` is stale
    // and does NOT contain the merge. rebuild must read origin/main and see done.
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "FIX-903", cycle_id: "c1", status: "built", outcome: "published_pending_merge", pr_number: 898, ts: "2026-06-21T10:00:00Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const exec = fakeExecPort({
      // origin/main resolves → it is the authoritative ref
      [`-C ${PROJ} rev-parse --verify --quiet origin/main`]: { stdout: ORIGIN_SHA, code: 0 },
      // origin/main's log carries the merge for FIX-903 / PR #898
      [`-C ${PROJ} log --first-parent origin/main --merges --format=%H %ct %s`]: {
        stdout: "cfaaa33 1718885251 Merge pull request #898 from branch/fix-903",
        code: 0,
      },
      [`-C ${PROJ} log --first-parent origin/main --format=%H %ct %s`]: { stdout: "", code: 0 },
      // local main log would be EMPTY (lags) — must NOT be consulted for the verdict
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "git@github.com:seanyao/roll.git", code: 0 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-903");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].prNumber).toEqual({ present: true, value: 898 });
    // The rebuilt origin/main SHA is recorded in the sidecar.
    expect(freshness._files.get(HEAD)?.text.trim()).toBe(ORIGIN_SHA);
  });

  it("E1: reads merges from a configured integration branch (fetch + rev-parse + log all target it)", () => {
    const seen: string[] = [];
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "FIX-903", cycle_id: "c1", status: "built", outcome: "published_pending_merge", pr_number: 898, ts: "2026-06-21T10:00:00Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const responses: Record<string, ExecResult> = {
      // The integration branch is origin/dev, not origin/main.
      [`-C ${PROJ} rev-parse --verify --quiet origin/dev`]: { stdout: ORIGIN_SHA, code: 0 },
      [`-C ${PROJ} log --first-parent origin/dev --merges --format=%H %ct %s`]: {
        stdout: "cfaaa33 1718885251 Merge pull request #898 from branch/fix-903",
        code: 0,
      },
      [`-C ${PROJ} log --first-parent origin/dev --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "git@github.com:seanyao/roll.git", code: 0 },
    };
    const exec: ExecPort = {
      run(_tool, argv) {
        const key = argv.join(" ");
        seen.push(key);
        if (key in responses) return responses[key]!;
        const legacyKey = key.replace("--format=%x1e%H%x1f%ct%x1f%B", "--format=%H %ct %s");
        if (legacyKey in responses) return responses[legacyKey]!;
        return { stdout: "", code: 128 };
      },
    };

    const result = ensureDeliveriesFresh(PROJ, freshness, exec, "origin/dev");
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-903");
    expect(result[0].lifecycleState).toBe("done");
    // The preflight fetch derives remote+branch from the integration branch.
    expect(seen).toContain(`-C ${PROJ} fetch origin dev --quiet`);
    // The rev-parse verify targets the configured branch, never origin/main.
    expect(seen).toContain(`-C ${PROJ} rev-parse --verify --quiet origin/dev`);
    expect(seen.some((s) => s.includes("origin/main"))).toBe(false);
  });

  it("FIX-925/FIX-1266: two prNumber=0 story-only merges are collected, but neither completes a card", () => {
    // FIX-925 regression: pass (a) can parse a no-PR story-only merge and record
    // its key; pass (b) must still keep later no-PR story commits by SHA, not
    // skip every prNumber=0 fact as if it were the same PR (sha-keying — covered
    // at the parse level too). The collection must not crash or drop the story.
    //
    // FIX-1266 (#1034): BUT a subject-only merge (no PR link) can no longer
    // complete a card. US-AGENT-045 has only a FAILED run plus a subject-only
    // merge → it stays `failed`, and FIX-OLD-001 (subject-only, no run) yields
    // no record at all. This is the exact behavior change that closes the
    // product-code subject-only attribution path.
    const rs = "\x1e";
    const fs = "\x1f";
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-AGENT-045", cycle_id: "c045", status: "failed", outcome: "failed", ts: "2026-06-23T19:28:57Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} rev-parse --verify --quiet origin/main`]: { stdout: ORIGIN_SHA, code: 0 },
      [`-C ${PROJ} log --first-parent origin/main --merges --format=%x1e%H%x1f%ct%x1f%B`]: {
        stdout: [
          rs,
          "oldzero0000000000000000000000000000000000",
          fs,
          "1782240000",
          fs,
          "FIX-OLD-001: old story-only merge without PR marker",
        ].join(""),
        code: 0,
      },
      [`-C ${PROJ} log --first-parent origin/main --format=%x1e%H%x1f%ct%x1f%B`]: {
        stdout: [
          rs,
          "dcbf2b3fee6571c723be6349d675e9641cf88bf7",
          fs,
          "1782243394",
          fs,
          "US-AGENT-045: migrate removed agent config compatibility\n\n",
          "Co-authored-by: Roll Test <test@example.com>",
        ].join(""),
        code: 0,
      },
      [`-C ${PROJ} diff-tree --no-commit-id --name-only -r oldzero0000000000000000000000000000000000`]: {
        stdout: "packages/core/src/agent/config.ts",
        code: 0,
      },
      [`-C ${PROJ} diff-tree --no-commit-id --name-only -r dcbf2b3fee6571c723be6349d675e9641cf88bf7`]: {
        stdout: "packages/core/src/agent/roster.ts",
        code: 0,
      },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "git@github.com:seanyao/roll.git", code: 0 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);

    // FIX-1266: the subject-only merge cannot promote the failed run to done.
    const story = result.find((r) => r.storyId === "US-AGENT-045");
    expect(story).toBeDefined();
    expect(story!.lifecycleState).toBe("failed");
    // FIX-OLD-001 is subject-only with no run → no delivery record.
    expect(result.find((r) => r.storyId === "FIX-OLD-001")).toBeUndefined();
  });

  it("SHA gate forces rebuild when origin/main advanced even if mtimes look fresh", () => {
    // deliveries.jsonl is NEWER than runs.jsonl (mtime gate alone → fresh),
    // but origin/main advanced past the recorded SHA → must rebuild and see done.
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "FIX-903", cycle_id: "c1", status: "built", outcome: "published_pending_merge", pr_number: 898, ts: "2026-06-21T10:00:00Z" }),
      ].join("\n"), mtime: 1000 },
      // Stale cache says FIX-903 is still in-flight…
      [DEL]: { text: JSON.stringify({ storyId: "FIX-903", cycleId: "c1", lifecycleState: "pending_merge", recordedAt: 2000 }), mtime: 5000 },
      // …and was built from an OLDER origin/main SHA.
      [HEAD]: { text: LOCAL_SHA + "\n", mtime: 5000 },
    });
    const exec = fakeExecPort({
      [`-C ${PROJ} rev-parse --verify --quiet origin/main`]: { stdout: ORIGIN_SHA, code: 0 },
      [`-C ${PROJ} log --first-parent origin/main --merges --format=%H %ct %s`]: {
        stdout: "cfaaa33 1718885251 Merge pull request #898 from branch/fix-903",
        code: 0,
      },
      [`-C ${PROJ} log --first-parent origin/main --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "git@github.com:seanyao/roll.git", code: 0 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].lifecycleState).toBe("done");
    // Sidecar now records the current origin/main SHA.
    expect(freshness._files.get(HEAD)?.text.trim()).toBe(ORIGIN_SHA);
  });

  it("does NOT rebuild when origin/main SHA is unchanged and cache is mtime-fresh", () => {
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: JSON.stringify({ story_id: "FIX-903", cycle_id: "c1", status: "built", outcome: "published_pending_merge", ts: "2026-06-21T10:00:00Z" }), mtime: 1000 },
      [DEL]: { text: JSON.stringify({ storyId: "FIX-903", cycleId: "c1", lifecycleState: "done", recordedAt: 2000 }), mtime: 5000 },
      [HEAD]: { text: ORIGIN_SHA + "\n", mtime: 5000 },
    });
    // Any git log call would throw the assertion off — only rev-parse + fetch run.
    const exec = fakeExecPort({
      [`-C ${PROJ} rev-parse --verify --quiet origin/main`]: { stdout: ORIGIN_SHA, code: 0 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    // Served from cache untouched (lifecycleState stays the cached "done").
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-903");
    expect(result[0].lifecycleState).toBe("done");
  });

  it("falls back to local main when origin/main does not resolve (offline / no remote)", () => {
    // rev-parse origin/main FAILS → resolveMainRef falls back to local `main`,
    // local main log is consulted, and nothing crashes. No sidecar is written
    // (we still have local main's SHA though, so it IS recorded).
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-OFFLINE", cycle_id: "c1", status: "built", outcome: "published_pending_merge", pr_number: 50, ts: "2026-06-21T10:00:00Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const exec = fakeExecPort({
      // origin/main rev-parse fails (no remote ref locally)
      [`-C ${PROJ} rev-parse --verify --quiet origin/main`]: { stdout: "", code: 128 },
      // local main rev-parse succeeds
      [`-C ${PROJ} rev-parse --verify --quiet main`]: { stdout: LOCAL_SHA, code: 0 },
      // local main log carries the merge
      [`-C ${PROJ} log --first-parent main --merges --format=%H %ct %s`]: {
        stdout: "f8156ed 1718885251 Merge pull request #50 from branch/x",
        code: 0,
      },
      [`-C ${PROJ} log --first-parent main --format=%H %ct %s`]: { stdout: "", code: 0 },
      [`-C ${PROJ} remote get-url origin`]: { stdout: "git@github.com:seanyao/roll.git", code: 0 },
    });

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-OFFLINE");
    expect(result[0].lifecycleState).toBe("done");
    expect(result[0].prNumber).toEqual({ present: true, value: 50 });
    // Local main SHA recorded in sidecar (best-effort).
    expect(freshness._files.get(HEAD)?.text.trim()).toBe(LOCAL_SHA);
  });

  it("does not crash when BOTH origin/main and local main fail to resolve", () => {
    // Fully detached fixture: no refs resolve, all git fails. Rebuild from runs
    // alone, no sidecar written, no throw.
    const freshness = fakeFreshnessPort({
      [RUNS]: { text: [
        JSON.stringify({ story_id: "US-NOREF", cycle_id: "c1", status: "built", outcome: "failed", ts: "2026-06-21T10:00:00Z" }),
      ].join("\n"), mtime: 2000 },
    });
    const exec = fakeExecPort(); // everything returns code 128

    const result = ensureDeliveriesFresh(PROJ, freshness, exec);
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-NOREF");
    expect(result[0].lifecycleState).toBe("failed");
    // No SHA available → no sidecar written.
    expect(freshness._files.has(HEAD)).toBe(false);
  });
});
