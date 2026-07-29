/**
 * Unit tests for ReconcileEngine (US-CORE-008): merge-evidence backfill (I4:
 * built ≠ merged) + 进行中 TTL detection (loop_unstick mirror).
 */
import { describe, expect, it } from "vitest";
import {
  type MergeEvidence,
  type ReconcileRunRow,
  type UnstickEvent,
  applyStuckReverts,
  cycleEndForPick,
  decideClaimReconcile,
  detectStuckStories,
  hasMergedDelivery,
  inProgressStories,
  latestDeliveringCycle,
  reconcileBranchName,
  reconcileMergeEvidence,
  reconcileStuckBacklog,
  resumeCandidateBranches,
  reconcileExpiredClaims,
  runRowHasPublishedPr,
  runRowPrNumber,
} from "../src/index.js";

const HOUR = 3_600_000;

describe("reconcileMergeEvidence — built ≠ merged (I4)", () => {
  const lookup = (table: Record<string, MergeEvidence>) => (branch: string) => table[branch];

  it("credits a built row only on real MERGED evidence", () => {
    const rows: ReconcileRunRow[] = [{ status: "built", cycle_id: "c1", story_type: "US" }];
    const res = reconcileMergeEvidence(
      rows,
      lookup({ [reconcileBranchName("c1")]: { state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", mergeCommit: "abc" } }),
    );
    expect(res.rows[0]).toMatchObject({ status: "merged", merged_at: "2026-01-01T00:00:00Z", merge_commit: "abc" });
    expect(res.rows[0]?.story_type).toBe("US"); // other fields preserved
    expect(res.credited).toEqual([{ cycleId: "c1", mergedAt: "2026-01-01T00:00:00Z", mergeCommit: "abc" }]);
  });

  it("leaves a built row untouched when PR not MERGED (Done ≠ merged)", () => {
    const rows: ReconcileRunRow[] = [{ status: "built", cycle_id: "c1" }];
    const res = reconcileMergeEvidence(rows, lookup({ [reconcileBranchName("c1")]: { state: "OPEN" } }));
    expect(res.rows[0]).toEqual({ status: "built", cycle_id: "c1" });
    expect(res.credited).toHaveLength(0);
  });

  it("passes through non-built rows and empty cycle ids verbatim", () => {
    const rows: ReconcileRunRow[] = [
      { status: "merged", cycle_id: "c0" },
      { status: "built", cycle_id: "" },
      { status: "idle" },
    ];
    const res = reconcileMergeEvidence(rows, lookup({}));
    expect(res.rows).toEqual(rows);
    expect(res.credited).toHaveLength(0);
  });

  it("missing evidence (unknown branch) leaves the row built", () => {
    const rows: ReconcileRunRow[] = [{ status: "built", cycle_id: "c9" }];
    const res = reconcileMergeEvidence(rows, lookup({}));
    expect(res.rows[0]?.status).toBe("built");
  });

  // FIX-243/244 — the backfill credits ALL claim-shaped statuses, not just
  // v2's "built": "published" (publish-ok, merge pending) and "failed" (the
  // phantom-failure rows observed 2026-06-10 — cycle judged failed, its PR
  // merged minutes later). Crediting also corrects `outcome` so dashboards
  // stop reading a merged delivery as failed.
  it("FIX-244: credits a published row on MERGED evidence (status merged + outcome delivered)", () => {
    const rows: ReconcileRunRow[] = [{ status: "published", cycle_id: "c2", outcome: "delivered" }];
    const res = reconcileMergeEvidence(
      rows,
      lookup({ [reconcileBranchName("c2")]: { state: "MERGED", mergedAt: "2026-06-11T00:00:00Z", mergeCommit: "def" } }),
    );
    expect(res.rows[0]).toMatchObject({ status: "merged", outcome: "delivered", merged_at: "2026-06-11T00:00:00Z" });
    expect(res.credited).toHaveLength(1);
  });

  it("FIX-243: heals a phantom-failed row whose PR really merged (failed → merged, outcome → delivered)", () => {
    const rows: ReconcileRunRow[] = [{ status: "failed", cycle_id: "c3", outcome: "failed", story_id: "FIX-9" }];
    const res = reconcileMergeEvidence(
      rows,
      lookup({ [reconcileBranchName("c3")]: { state: "MERGED", mergedAt: "2026-06-11T01:00:00Z", mergeCommit: "ghi" } }),
    );
    expect(res.rows[0]).toMatchObject({ status: "merged", outcome: "delivered", merge_commit: "ghi" });
    expect(res.rows[0]?.story_id).toBe("FIX-9"); // other fields preserved
  });

  it("a failed row with no PR / unmerged PR stays failed (no generosity without evidence)", () => {
    const rows: ReconcileRunRow[] = [
      { status: "failed", cycle_id: "c4", outcome: "failed" },
      { status: "failed", cycle_id: "c5", outcome: "failed" },
    ];
    const res = reconcileMergeEvidence(rows, lookup({ [reconcileBranchName("c5")]: { state: "CLOSED" } }));
    expect(res.rows).toEqual(rows);
    expect(res.credited).toHaveLength(0);
  });

  // FIX-389b: prNumber + prUrl stamped onto credited rows for the projection engine.
  it("FIX-389b: stamps pr_number + pr_url on credited rows when MergeEvidence carries them", () => {
    const rows: ReconcileRunRow[] = [{ status: "built", cycle_id: "c1" }];
    const res = reconcileMergeEvidence(
      rows,
      lookup({
        [reconcileBranchName("c1")]: {
          state: "MERGED",
          mergedAt: "2026-06-21T00:00:00Z",
          mergeCommit: "abc123",
          prNumber: 891,
          prUrl: "https://github.com/o/r/pull/891",
        },
      }),
    );
    expect(res.rows[0]).toMatchObject({
      status: "merged",
      outcome: "delivered",
      pr_number: 891,
      pr_url: "https://github.com/o/r/pull/891",
    });
    expect(res.credited).toEqual([{
      cycleId: "c1",
      mergedAt: "2026-06-21T00:00:00Z",
      mergeCommit: "abc123",
      prNumber: 891,
      prUrl: "https://github.com/o/r/pull/891",
    }]);
  });

  it("FIX-389b: omits pr_number + pr_url from credited rows when MergeEvidence lacks them (backward compat)", () => {
    const rows: ReconcileRunRow[] = [{ status: "built", cycle_id: "c2" }];
    const res = reconcileMergeEvidence(
      rows,
      lookup({
        [reconcileBranchName("c2")]: { state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", mergeCommit: "def" },
      }),
    );
    expect(res.rows[0]).toMatchObject({ status: "merged", merged_at: "2026-01-01T00:00:00Z" });
    expect(res.rows[0]).not.toHaveProperty("pr_number");
    expect(res.rows[0]).not.toHaveProperty("pr_url");
    expect(res.credited[0]).toMatchObject({ cycleId: "c2" });
    expect(res.credited[0]).not.toHaveProperty("prNumber");
  });

  // ── FIX-1032a: delivery gate integration ────────────────────────────────

  it("FIX-1032a AC2: CI red after merge → outcome ci_red_after_merge, not delivered", () => {
    const rows: ReconcileRunRow[] = [{ status: "built", cycle_id: "c10" }];
    const res = reconcileMergeEvidence(
      rows,
      lookup({
        [reconcileBranchName("c10")]: {
          state: "MERGED",
          mergedAt: "2026-06-30T00:00:00Z",
          mergeCommit: "ci-red",
          mainCiStatus: "red",
          ciRunUrl: "https://ci.example.com/run/fail-1",
        },
      }),
    );
    expect(res.rows[0]).toMatchObject({
      status: "merged",
      outcome: "ci_red_after_merge",
      merged_at: "2026-06-30T00:00:00Z",
      ci_run_url: "https://ci.example.com/run/fail-1",
    });
    expect(res.credited).toHaveLength(1);
  });

  it("FIX-1032a AC2: CI unknown → outcome delivered (non-red passes)", () => {
    const rows: ReconcileRunRow[] = [{ status: "built", cycle_id: "c11" }];
    const res = reconcileMergeEvidence(
      rows,
      lookup({
        [reconcileBranchName("c11")]: {
          state: "MERGED",
          mergedAt: "2026-06-30T01:00:00Z",
          mergeCommit: "ci-unknown",
          mainCiStatus: "unknown",
        },
      }),
    );
    expect(res.rows[0]).toMatchObject({ status: "merged", outcome: "delivered" });
  });

  it("FIX-1032a AC2: CI pending → outcome delivered (non-red passes)", () => {
    const rows: ReconcileRunRow[] = [{ status: "built", cycle_id: "c12" }];
    const res = reconcileMergeEvidence(
      rows,
      lookup({
        [reconcileBranchName("c12")]: {
          state: "MERGED",
          mergedAt: "2026-06-30T02:00:00Z",
          mergeCommit: "ci-pending",
          mainCiStatus: "pending",
        },
      }),
    );
    expect(res.rows[0]).toMatchObject({ status: "merged", outcome: "delivered" });
  });

  it("FIX-1032a AC2: CI green → outcome delivered (regression guard)", () => {
    const rows: ReconcileRunRow[] = [{ status: "built", cycle_id: "c13" }];
    const res = reconcileMergeEvidence(
      rows,
      lookup({
        [reconcileBranchName("c13")]: {
          state: "MERGED",
          mergedAt: "2026-06-30T03:00:00Z",
          mergeCommit: "ci-green",
          mainCiStatus: "green",
        },
      }),
    );
    expect(res.rows[0]).toMatchObject({ status: "merged", outcome: "delivered" });
  });
});

describe("cycleEndForPick — latest pick → its cycle_end", () => {
  it("pairs the latest pick to the first cycle_end whose label ends with the pick label", () => {
    const events: UnstickEvent[] = [
      { stage: "pick_todo", detail: "US-1", label: "cyc-a", ts: 1 },
      { stage: "cycle_end", label: "cyc-a", outcome: "failed", ts: 2 },
    ];
    expect(cycleEndForPick(events, "US-1")).toEqual({ endTs: 2, outcome: "failed" });
  });

  it("returns null when the story was never picked", () => {
    expect(cycleEndForPick([{ stage: "pick_todo", detail: "US-2", label: "x", ts: 1 }], "US-1")).toBeNull();
  });

  it("returns null when the picked cycle is still running (no cycle_end)", () => {
    expect(cycleEndForPick([{ stage: "pick_todo", detail: "US-1", label: "x", ts: 1 }], "US-1")).toBeNull();
  });

  it("uses the LATEST pick when a story was picked twice", () => {
    const events: UnstickEvent[] = [
      { stage: "pick_todo", detail: "US-1", label: "old", ts: 1 },
      { stage: "cycle_end", label: "old", outcome: "failed", ts: 2 },
      { stage: "pick_todo", detail: "US-1", label: "new", ts: 3 },
      { stage: "cycle_end", label: "new", outcome: "aborted", ts: 4 },
    ];
    expect(cycleEndForPick(events, "US-1")).toEqual({ endTs: 4, outcome: "aborted" });
  });
});

describe("detectStuckStories — conservative TTL gate", () => {
  const events = (outcome: string, endTsHoursAgo: number, now: number): UnstickEvent[] => [
    { stage: "pick_todo", detail: "US-1", label: "c", ts: now - endTsHoursAgo * HOUR - 1 },
    { stage: "cycle_end", label: "c", outcome, ts: now - endTsHoursAgo * HOUR },
  ];

  it("reverts a stuck-and-stale failed story (> TTL)", () => {
    const now = 1_000 * HOUR;
    const reverts = detectStuckStories({ inProgress: [{ id: "US-1" }], events: events("failed", 6, now), now });
    expect(reverts).toHaveLength(1);
    expect(reverts[0]).toMatchObject({ storyId: "US-1", outcome: "failed" });
    expect(reverts[0]?.ageHours).toBeCloseTo(6, 5);
  });

  it("leaves a stuck-but-fresh failure alone (< TTL)", () => {
    const now = 1_000 * HOUR;
    expect(detectStuckStories({ inProgress: [{ id: "US-1" }], events: events("failed", 2, now), now })).toHaveLength(0);
  });

  it("ignores a non-failed latest cycle", () => {
    const now = 1_000 * HOUR;
    expect(detectStuckStories({ inProgress: [{ id: "US-1" }], events: events("delivered", 6, now), now })).toHaveLength(0);
  });

  it("ignores a story with no cycle record", () => {
    const now = 1_000 * HOUR;
    expect(detectStuckStories({ inProgress: [{ id: "US-1" }], events: [], now })).toHaveLength(0);
  });

  it("honours a custom ttlHours", () => {
    const now = 1_000 * HOUR;
    expect(detectStuckStories({ inProgress: [{ id: "US-1" }], events: events("blocked", 6, now), now, ttlHours: 8 })).toHaveLength(0);
    expect(detectStuckStories({ inProgress: [{ id: "US-1" }], events: events("blocked", 6, now), now, ttlHours: 4 })).toHaveLength(1);
  });
});

describe("inProgressStories + applyStuckReverts", () => {
  it("scans only 🔨 In Progress rows with an id", () => {
    const backlog = [
      "| US-1 | a | 🔨 In Progress |",
      "| US-2 | b | 📋 Todo |",
      "| no-id | c | 🔨 In Progress |",
      "",
    ].join("\n");
    expect(inProgressStories(backlog).map((s) => s.id)).toEqual(["US-1"]);
  });

  it("flips only reverted rows' marker, preserving the rest byte-for-byte", () => {
    const backlog = ["| US-1 | a | 🔨 In Progress |", "| US-2 | b | 🔨 In Progress |", ""].join("\n");
    const out = applyStuckReverts(backlog, [{ storyId: "US-1", outcome: "failed", ageHours: 6 }]);
    expect(out).toBe(["| US-1 | a | 📋 Todo |", "| US-2 | b | 🔨 In Progress |", ""].join("\n"));
  });

  it("reconcileStuckBacklog wires scan → gate end to end", () => {
    const now = 1_000 * HOUR;
    const backlog = "| US-1 | a | 🔨 In Progress |\n";
    const events: UnstickEvent[] = [
      { stage: "pick_todo", detail: "US-1", label: "c", ts: now - 6 * HOUR - 1 },
      { stage: "cycle_end", label: "c", outcome: "failed", ts: now - 6 * HOUR },
    ];
    expect(reconcileStuckBacklog(backlog, events, now).map((r) => r.storyId)).toEqual(["US-1"]);
  });

  it("FIX-1475: identity is the FULL id, not the UNSTICK_ID_RE-truncated capture (US-WS-011a ≠ US-WS-011)", () => {
    const backlog = [
      "| [US-WS-011](.roll/features/ws/US-WS-011/spec.md) | parent | 🔨 In Progress |",
      "| [US-WS-011a](.roll/features/ws/US-WS-011a/spec.md) | suffixed child | 🔨 In Progress |",
      "",
    ].join("\n");
    // The regex capture truncates both to US-WS-011; identity must be the full cell.
    expect(inProgressStories(backlog).map((s) => s.id)).toEqual(["US-WS-011", "US-WS-011a"]);
    // Reverting the suffixed child must NOT touch the parent row (and vice-versa).
    const out = applyStuckReverts(backlog, [{ storyId: "US-WS-011a", outcome: "failed", ageHours: 6 }]);
    expect(out).toContain("| [US-WS-011](.roll/features/ws/US-WS-011/spec.md) | parent | 🔨 In Progress |");
    expect(out).toContain("| [US-WS-011a](.roll/features/ws/US-WS-011a/spec.md) | suffixed child | 📋 Todo |");
  });
});

describe("decideClaimReconcile — FIX-211: Done ≡ merged (no publish-time抢跑)", () => {
  it("flips ✅ Done only on MERGED evidence", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: true, prState: "MERGED" })).toBe("done");
  });

  it("leaves an OPEN (delivered, pending merge) claim at 🔨", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: true, prState: "OPEN" })).toBe("keep");
  });

  it("treats unknown/unprobed PR state as pending — keep, never premature Done", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: true })).toBe("keep");
    expect(decideClaimReconcile({ hasDeliveringCycle: true, prState: "UNKNOWN" })).toBe("keep");
  });

  it("reverts a CLOSED (abandoned, unmerged) claim to 📋 Todo for re-pick", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: true, prState: "CLOSED" })).toBe("todo");
  });

  it("reverts a dead claim with no delivering cycle to 📋 Todo (orphan recovery)", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: false })).toBe("todo");
    expect(decideClaimReconcile({ hasDeliveringCycle: false, prState: "MERGED" })).toBe("todo");
  });

  // FIX-397 AC2: reconcile robust when gh probe fails
  it("AC2: keeps when hasPublishedPr=true + gh EOF (prState=undefined) — never re-pick in-flight", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: true, hasPublishedPr: true })).toBe("keep");
  });

  it("AC2: keeps when hasPublishedPr=true + gh returns UNKNOWN — published evidence > probe gap", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: true, hasPublishedPr: true, prState: "UNKNOWN" })).toBe("keep");
  });

  it("AC2: keeps when hasPublishedPr=true + gh returns OPEN — already in-flight", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: true, hasPublishedPr: true, prState: "OPEN" })).toBe("keep");
  });

  it("AC2: still flips to done when MERGED (even with hasPublishedPr=true)", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: true, hasPublishedPr: true, prState: "MERGED" })).toBe("done");
  });

  it("AC2: still reverts to todo when CLOSED (even with hasPublishedPr=true — abandoned)", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: true, hasPublishedPr: true, prState: "CLOSED" })).toBe("todo");
  });

  it("AC2: without hasPublishedPr, unknown prState still keeps (existing safety net)", () => {
    expect(decideClaimReconcile({ hasDeliveringCycle: true, hasPublishedPr: false })).toBe("keep");
  });
});

describe("runRowPrNumber / runRowHasPublishedPr — FIX-397 AC3", () => {
  const rows: ReconcileRunRow[] = [
    { story_id: "US-1", cycle_id: "c1", status: "failed" },
    { story_id: "US-1", cycle_id: "c2", status: "published", pr_number: 890, pr_url: "https://github.com/o/r/pull/890" },
    { story_id: "US-2", cycle_id: "c3", status: "published" },
    { story_id: "US-3", cycle_id: "c4", status: "built", pr_number: 0, pr_url: "" },
    { story_id: "US-4", cycle_id: "c5", status: "done", pr_number: 891 },
  ];

  it("AC3: runRowPrNumber returns pr_number from latest delivering row", () => {
    expect(runRowPrNumber(rows, "US-1")).toBe(890);
    expect(runRowPrNumber(rows, "US-4")).toBe(891);
  });

  it("AC3: runRowPrNumber returns undefined when no delivering row", () => {
    expect(runRowPrNumber(rows, "US-404")).toBeUndefined();
  });

  it("AC3: runRowPrNumber returns undefined for published row WITHOUT pr_number (legacy)", () => {
    expect(runRowPrNumber(rows, "US-2")).toBeUndefined();
  });

  it("AC3: runRowPrNumber returns undefined when pr_number is 0 / empty (falsy guard)", () => {
    expect(runRowPrNumber(rows, "US-3")).toBeUndefined();
  });

  it("AC3: runRowHasPublishedPr returns true when a published row has a real pr_number", () => {
    expect(runRowHasPublishedPr(rows, "US-1")).toBe(true);
  });

  it("AC3: runRowHasPublishedPr returns false for legacy row without pr_number", () => {
    expect(runRowHasPublishedPr(rows, "US-2")).toBe(false);
  });

  it("AC3: runRowHasPublishedPr returns false for unknown story", () => {
    expect(runRowHasPublishedPr(rows, "US-404")).toBe(false);
  });

  it("AC3: runRowHasPublishedPr returns false when no rows at all", () => {
    expect(runRowHasPublishedPr([], "US-1")).toBe(false);
  });
});

describe("latestDeliveringCycle — map a 🔨 story to the cycle that delivered it", () => {
  const rows: ReconcileRunRow[] = [
    { story_id: "US-1", cycle_id: "c-early", status: "failed" },
    { story_id: "US-1", cycle_id: "c-built", status: "built" },
    { story_id: "US-2", cycle_id: "c-other", status: "done" },
    { story_id: "US-1", cycle_id: "c-done", status: "done" },
  ];

  it("returns the newest delivering (done|built|merged) cycle for the story", () => {
    expect(latestDeliveringCycle(rows, "US-1")).toBe("c-done");
    expect(latestDeliveringCycle(rows, "US-2")).toBe("c-other");
  });

  it("ignores non-delivering rows (failed/aborted) — undefined when none deliver", () => {
    expect(latestDeliveringCycle([{ story_id: "US-9", cycle_id: "c", status: "failed" }], "US-9")).toBeUndefined();
  });

  it("returns undefined for a story with no runs row (dead claim, no PR)", () => {
    expect(latestDeliveringCycle(rows, "US-404")).toBeUndefined();
  });

  it("FIX-322: a `published` cycle (PR open, merge pending) IS a delivering cycle (not a dead claim)", () => {
    // Before FIX-322 this returned undefined → preflight flipped 🔨→Todo → the
    // card was re-picked and re-delivered (duplicate) before merge-backfill.
    expect(latestDeliveringCycle([{ story_id: "US-7", cycle_id: "c-pub", status: "published" }], "US-7")).toBe("c-pub");
  });
});

describe("hasMergedDelivery — FIX-323 zombie re-pick guard signal", () => {
  it("true when a row is status=merged (backfill stamped the landed PR)", () => {
    const rows: ReconcileRunRow[] = [
      { story_id: "FIX-284", cycle_id: "c1", status: "published" },
      { story_id: "FIX-284", cycle_id: "c2", status: "merged", outcome: "delivered" },
    ];
    expect(hasMergedDelivery(rows, "FIX-284")).toBe(true);
  });

  it("true on the legacy outcome=delivered even without status=merged", () => {
    expect(hasMergedDelivery([{ story_id: "US-1", cycle_id: "c", status: "done", outcome: "delivered" }], "US-1")).toBe(true);
  });

  it("STRICTER than latestDeliveringCycle: a still-open `published` cycle is NOT a merged delivery", () => {
    const rows: ReconcileRunRow[] = [{ story_id: "US-7", cycle_id: "c-pub", status: "published" }];
    expect(latestDeliveringCycle(rows, "US-7")).toBe("c-pub"); // delivering…
    expect(hasMergedDelivery(rows, "US-7")).toBe(false); // …but not merged
  });

  it("false for built / failed / gave_up rows and for an unknown story", () => {
    const rows: ReconcileRunRow[] = [
      { story_id: "US-1", cycle_id: "c1", status: "built" },
      { story_id: "US-1", cycle_id: "c2", status: "gave_up" },
      { story_id: "US-1", cycle_id: "c3", status: "failed" },
    ];
    expect(hasMergedDelivery(rows, "US-1")).toBe(false);
    expect(hasMergedDelivery(rows, "US-404")).toBe(false);
  });
});

describe("resumeCandidateBranches — map a card to its un-merged cycle branches", () => {
  it("returns branch-pushing terminals most-recent-first (orphan/failed/built/published/done)", () => {
    const rows: ReconcileRunRow[] = [
      { story_id: "FIX-284", cycle_id: "20260614-195600-25595", status: "orphan" },
      { story_id: "FIX-285", cycle_id: "other", status: "orphan" },
      { story_id: "FIX-284", cycle_id: "20260614-204221-43478", status: "failed" },
    ];
    expect(resumeCandidateBranches(rows, "FIX-284")).toEqual([
      reconcileBranchName("20260614-204221-43478"),
      reconcileBranchName("20260614-195600-25595"),
    ]);
  });

  it("excludes idle / blocked / aborted (no branch with new work was pushed)", () => {
    const rows: ReconcileRunRow[] = [
      { story_id: "US-1", cycle_id: "c-idle", status: "idle" },
      { story_id: "US-1", cycle_id: "c-blocked", status: "blocked" },
      { story_id: "US-1", cycle_id: "c-aborted", status: "aborted" },
    ];
    expect(resumeCandidateBranches(rows, "US-1")).toEqual([]);
  });

  it("dedupes repeated cycle_id rows and keeps only the picked story", () => {
    const rows: ReconcileRunRow[] = [
      { story_id: "US-1", cycle_id: "c1", status: "built" }, // first row for c1
      { story_id: "US-2", cycle_id: "c2", status: "orphan" }, // different story
      { story_id: "US-1", cycle_id: "c1", status: "published" }, // upsert of same c1
    ];
    expect(resumeCandidateBranches(rows, "US-1")).toEqual([reconcileBranchName("c1")]);
  });

  it("returns [] for a story with no recorded cycles", () => {
    expect(resumeCandidateBranches([], "US-404")).toEqual([]);
  });
});

// ─── FIX-1211: reconcileExpiredClaims — 24h soft lease expiry ──────────────

describe("reconcileExpiredClaims (FIX-1211)", () => {
  const NOW = 1_700_000_000_000;

  it("returns empty when there are no in-progress stories", () => {
    const result = reconcileExpiredClaims({ inProgress: [], leases: {}, now: NOW });
    expect(result).toEqual([]);
  });

  it("skips stories with no lease entry (conservative)", () => {
    const inProgress = [{ id: "FIX-1" }, { id: "US-1" }];
    const result = reconcileExpiredClaims({ inProgress, leases: {}, now: NOW });
    expect(result).toEqual([]);
  });

  it("skips cycle-claimed stories (handled by detectStuckStories)", () => {
    const inProgress = [{ id: "FIX-1" }];
    const leases = { "FIX-1": { pid: 12345, claimedAt: NOW - 48 * 3600_000, source: "cycle" as const } };
    const result = reconcileExpiredClaims({ inProgress, leases, now: NOW });
    expect(result).toEqual([]);
  });

  it("returns expired human-claimed stories older than 24h", () => {
    const inProgress = [{ id: "FIX-1" }];
    const leases = { "FIX-1": { claimedAt: NOW - 25 * 3600_000, source: "human" as const } };
    const result = reconcileExpiredClaims({ inProgress, leases, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-1");
    expect(result[0].ageHours).toBeGreaterThan(24);
  });

  it("does NOT return human-claimed stories under 24h", () => {
    const inProgress = [{ id: "FIX-1" }];
    const leases = { "FIX-1": { claimedAt: NOW - 12 * 3600_000, source: "human" as const } };
    const result = reconcileExpiredClaims({ inProgress, leases, now: NOW });
    expect(result).toEqual([]);
  });

  it("handles supervisor-claimed stories (treated as non-cycle)", () => {
    const inProgress = [{ id: "FIX-1" }];
    const leases = { "FIX-1": { claimedAt: NOW - 48 * 3600_000, source: "supervisor" as const } };
    const result = reconcileExpiredClaims({ inProgress, leases, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-1");
  });

  it("mixed: only returns expired non-cycle claims", () => {
    const inProgress = [
      { id: "FIX-1" }, // cycle claim, 48h old -> skip
      { id: "FIX-2" }, // human claim, 12h old -> skip
      { id: "FIX-3" }, // human claim, 48h old -> expired
      { id: "FIX-4" }, // no lease -> skip
    ];
    const leases = {
      "FIX-1": { pid: 12345, claimedAt: NOW - 48 * 3600_000, source: "cycle" as const },
      "FIX-2": { claimedAt: NOW - 12 * 3600_000, source: "human" as const },
      "FIX-3": { claimedAt: NOW - 48 * 3600_000, source: "human" as const },
    };
    const result = reconcileExpiredClaims({ inProgress, leases, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("FIX-3");
  });
});
