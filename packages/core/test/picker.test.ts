/**
 * Unit tests for StoryPicker: status skip rules, depends-on chains
 * (multi-dep / missing dep / done dep), open-PR skip, type priority, and
 * first-in-file-order selection.
 */
import { describe, expect, it } from "vitest";
import { AWAITING_REVIEW_STATUS_MARKER } from "@roll/spec";
import {
  assessBacklog,
  buildHasOpenPr,
  openPrBlockReason,
  parseDependsOn,
  parseTargetSubmodule,
  pickStory,
  prTitleReferences,
  type BacklogItem,
} from "../src/index.js";

/** Terse fixture row builder. */
function item(id: string, status: string, desc = ""): BacklogItem {
  return { id, status, desc };
}

const TODO = "📋 Todo";
const DONE = "✅ Done";

describe("parseDependsOn", () => {
  it("returns [] when no tag is present", () => {
    expect(parseDependsOn("a plain description")).toEqual([]);
  });
  it("splits a multi-id tag, trimming each", () => {
    expect(parseDependsOn("x `depends-on:US-A,US-B,FIX-3`")).toEqual(["US-A", "US-B", "FIX-3"]);
  });
  it("captures lettered sub-story ids (FIX-167)", () => {
    expect(parseDependsOn("depends-on:US-LOOP-062c")).toEqual(["US-LOOP-062c"]);
  });
});

describe("parseTargetSubmodule — E2 per-story submodule tag", () => {
  it("returns undefined when no tag is present", () => {
    expect(parseTargetSubmodule("a plain description")).toBeUndefined();
  });
  it("extracts the submodule path from a target-submodule: tag", () => {
    expect(parseTargetSubmodule("ship it `target-submodule:dukang-service-online`")).toBe(
      "dukang-service-online",
    );
  });
  it("coexists with a depends-on tag (independent extraction)", () => {
    const desc = "work `depends-on:US-A` `target-submodule:dukang-service-online`";
    expect(parseDependsOn(desc)).toEqual(["US-A"]);
    expect(parseTargetSubmodule(desc)).toBe("dukang-service-online");
  });
  it("takes the first occurrence only", () => {
    expect(parseTargetSubmodule("target-submodule:one target-submodule:two")).toBe("one");
  });
});

describe("pickStory — status skip rules", () => {
  it("recovery candidate alone may retry an In Progress card whose prior delivery already merged", () => {
    const items = [item("US-RECOVER", "🔨 In Progress"), item("US-NEXT", TODO)];
    const merged = (id: string): boolean => id === "US-RECOVER";

    expect(pickStory(items, { hasMergedDelivery: merged })?.id).toBe("US-NEXT");
    expect(
      pickStory(items, {
        hasMergedDelivery: merged,
        isRecoveryCandidate: (id) => id === "US-RECOVER",
      })?.id,
    ).toBe("US-RECOVER");
  });

  it("recovery candidate does not reopen a different merged card", () => {
    const items = [item("US-OTHER", "🔨 In Progress"), item("US-RECOVER", "🔨 In Progress")];
    const merged = (): boolean => true;

    expect(
      pickStory(items, {
        hasMergedDelivery: merged,
        isRecoveryCandidate: (id) => id === "US-RECOVER",
      })?.id,
    ).toBe("US-RECOVER");
  });

  it("reports work when the only actionable row is an explicit merged-delivery recovery candidate", () => {
    const items = [item("US-RECOVER", "🔨 In Progress")];
    const assessment = assessBacklog(items, {
      hasMergedDelivery: () => true,
      isRecoveryCandidate: (id) => id === "US-RECOVER",
    });

    expect(assessment).toMatchObject({ hasWork: true, reason: "has_work" });
  });

  it("skips 🚫 Hold / 🔒 Blocked / ⏸ Deferred / In Progress / Done, takes first Todo", () => {
    const items = [
      item("US-1", "🚫 Hold"),
      item("US-2", "🔒 Blocked"),
      item("US-3", "⏸ Deferred"),
      item("US-4", "🔨 In Progress"),
      item("US-5", DONE),
      item("US-6", TODO),
    ];
    expect(pickStory(items)?.id).toBe("US-6");
  });

  it("returns undefined when nothing is Todo", () => {
    expect(pickStory([item("US-1", DONE), item("FIX-1", "🚫 Hold")])).toBeUndefined();
  });

  it("FIX-909: picks ⏳ 待复评 rows for conservative resume", () => {
    const items = [item("FIX-909", AWAITING_REVIEW_STATUS_MARKER), item("FIX-910", TODO)];
    expect(pickStory(items)?.id).toBe("FIX-909");
  });

  it("FIX-363: skips a poison-pill card on the runtime skip-list, takes the next Todo", () => {
    const items = [item("FIX-1", TODO), item("FIX-2", TODO)];
    // FIX-1 failed K times → skip-listed; the loop must keep delivering FIX-2
    // rather than re-picking the poison pill (which previously halted the loop).
    const skip = new Set(["FIX-1"]);
    expect(pickStory(items, { shouldSkip: (id) => skip.has(id) })?.id).toBe("FIX-2");
    // the skipped card stays a valid Todo — only the runtime overlay hides it,
    // so clearing the skip-list re-arms it (backlog truth never changed).
    expect(pickStory(items)?.id).toBe("FIX-1");
  });

  it("FIX-363: when the ONLY Todo is skip-listed, the loop idles (no_story) rather than re-burning it", () => {
    const items = [item("FIX-1", TODO), item("US-1", DONE)];
    expect(pickStory(items, { shouldSkip: (id) => id === "FIX-1" })).toBeUndefined();
  });

  it("FIX-1018+FIX-1212: skips a story with pending unpublished local work ONLY when an open PR also exists", () => {
    const items = [item("US-1", TODO), item("US-2", TODO)];
    const pending = new Set(["US-1"]);
    const hasOpenPr = buildHasOpenPr(["FIX-1212 work for US-1"]);
    // With pending-publish + open PR → blocked by combined gate; US-2 gets picked.
    expect(pickStory(items, { hasPendingPublish: (id) => pending.has(id), hasOpenPr })?.id).toBe("US-2");
    // Without open PR → marker is stale (FIX-1212); US-1 is pickable.
    expect(pickStory(items, { hasPendingPublish: (id) => pending.has(id) })?.id).toBe("US-1");
  });

  it("FIX-1212: pending-publish without open PR does NOT block — stale marker", () => {
    const items = [item("FIX-1", TODO), item("FIX-2", TODO)];
    const pending = new Set(["FIX-1"]);
    // Without an open PR, the pending-publish marker is stale → card IS pickable.
    expect(pickStory(items, { hasPendingPublish: (id) => pending.has(id) })?.id).toBe("FIX-1");
  });

  it("FIX-1212: pending-publish WITH open PR blocks (stale marker detection)", () => {
    const items = [item("FIX-1", TODO), item("FIX-2", TODO)];
    const pending = new Set(["FIX-1"]);
    const hasOpenPr = buildHasOpenPr(["PR for FIX-1"]);
    // With an open PR, pending-publish blocks the card → picks FIX-2 instead.
    expect(pickStory(items, { hasPendingPublish: (id) => pending.has(id), hasOpenPr })?.id).toBe("FIX-2");
  });

  it("FIX-1018+FIX-1212: when every Todo is pending-publish WITH open PR, assessBacklog reports all_awaiting_merge (open PR gate fires first)", () => {
    const items = [item("US-1", TODO), item("US-2", TODO)];
    const pending = new Set(["US-1", "US-2"]);
    const hasOpenPr = buildHasOpenPr(["US-1 PR", "US-2 PR"]);
    expect(pickStory(items, { hasPendingPublish: (id) => pending.has(id), hasOpenPr })).toBeUndefined();
    const assessment = assessBacklog(items, { hasPendingPublish: (id) => pending.has(id), hasOpenPr });
    // FIX-1212: cards with both pending-publish AND open PR are caught by the
    // open PR gate first (priority chain: deps > PR > merged > skip > pending).
    expect(assessment).toMatchObject({
      hasWork: false,
      reason: "all_awaiting_merge",
    });
  });

  it("FIX-1212: pending-publish without open PR, assessBacklog reports has_work (not idle)", () => {
    const items = [item("US-1", TODO), item("US-2", TODO)];
    const pending = new Set(["US-1"]);
    // Without open PR, all markers are stale → there IS work.
    expect(assessBacklog(items, { hasPendingPublish: (id) => pending.has(id) })).toMatchObject({
      hasWork: true,
      reason: "has_work",
    });
  });

  // ─── FIX-1215: gh query failure resilience + idle output observability ───

  it("FIX-1215 AC1: pending-publish + no open PR + empty PR list (simulating gh failure) → card IS pickable", () => {
    // Simulate gh pr list returning [] (network failure fail-open).
    const items = [item("FIX-4", TODO), item("FIX-5", TODO), item("REFACTOR-1", TODO)];
    const pending = new Set(["FIX-4", "FIX-5", "REFACTOR-1"]);
    // hasOpenPr built from empty list → returns false for everything.
    const hasOpenPr = buildHasOpenPr([]);
    // All three should be pickable — pending-publish without open PR is stale.
    expect(pickStory(items, { hasPendingPublish: (id) => pending.has(id), hasOpenPr })?.id).toBe("FIX-4");
  });

  it("FIX-1215 AC1: assessBacklog reports has_work when gh returns empty (fail-open)", () => {
    const items = [item("FIX-4", TODO), item("FIX-5", TODO)];
    const pending = new Set(["FIX-4", "FIX-5"]);
    const hasOpenPr = buildHasOpenPr([]); // gh failure → empty list
    const assessment = assessBacklog(items, { hasPendingPublish: (id) => pending.has(id), hasOpenPr });
    expect(assessment).toMatchObject({ hasWork: true, reason: "has_work" });
  });

  it("FIX-1215 AC2: blockedCards lists each blocked card with reason", () => {
    const items = [item("US-1", TODO), item("US-2", TODO)];
    const hasOpenPr = buildHasOpenPr(["US-1 PR", "US-2 PR"]);
    const assessment = assessBacklog(items, { hasOpenPr });
    expect(assessment.hasWork).toBe(false);
    expect(assessment.reason).toBe("all_awaiting_merge");
    expect(assessment.blockedCards).toBeDefined();
    expect(assessment.blockedCards!.length).toBe(2);
    expect(assessment.blockedCards![0].id).toBe("US-1");
    expect(assessment.blockedCards![0].reason).toContain("PR");
    expect(assessment.blockedCards![1].id).toBe("US-2");
  });

  it("FIX-1215 AC2: blockedCards lists unmet dependency reason", () => {
    const items = [item("US-1", TODO, "depends-on:US-DEP"), item("US-2", TODO)];
    // US-DEP is not done → US-1 blocked by deps.
    const assessment = assessBacklog(items, { hasOpenPr: buildHasOpenPr([]) });
    expect(assessment).toMatchObject({ hasWork: true, reason: "has_work" }); // US-2 is pickable
    // But we can check blockedCards if hasWork is false with only US-1
    const singleItem = [item("US-1", TODO, "depends-on:US-DEP")];
    const singleAssessment = assessBacklog(singleItem, { hasOpenPr: buildHasOpenPr([]) });
    expect(singleAssessment).toMatchObject({ hasWork: false, reason: "all_blocked_by_deps" });
    expect(singleAssessment.blockedCards).toBeDefined();
    expect(singleAssessment.blockedCards![0].reason).toContain("US-DEP");
  });

  it("FIX-1215 AC3: open PR still blocks re-dispatch (regression guard)", () => {
    // Cards with pending-publish AND open PR must still be blocked.
    const items = [item("FIX-1", TODO), item("FIX-2", TODO)];
    const pending = new Set(["FIX-1"]);
    const hasOpenPr = buildHasOpenPr(["PR for FIX-1"]);
    // FIX-1 has pending-publish + open PR → blocked. FIX-2 picked instead.
    expect(pickStory(items, { hasPendingPublish: (id) => pending.has(id), hasOpenPr })?.id).toBe("FIX-2");
  });

  it("FIX-1215 AC3: assessBacklog reports all_awaiting_merge when all cards have pending-publish + open PR", () => {
    const items = [item("US-1", TODO), item("US-2", TODO)];
    const pending = new Set(["US-1", "US-2"]);
    const hasOpenPr = buildHasOpenPr(["US-1 PR", "US-2 PR"]);
    const assessment = assessBacklog(items, { hasPendingPublish: (id) => pending.has(id), hasOpenPr });
    expect(assessment).toMatchObject({ hasWork: false, reason: "all_awaiting_merge" });
    // Blocked cards should include both with PR reasons
    expect(assessment.blockedCards!.length).toBe(2);
    expect(assessment.blockedCards!.every((bc) => bc.reason.includes("PR"))).toBe(true);
  });
});

describe("pickStory — type priority and file order", () => {
  it("prefers FIX over US over REFACTOR regardless of file order", () => {
    const items = [
      item("REFACTOR-1", TODO),
      item("US-1", TODO),
      item("FIX-1", TODO),
    ];
    expect(pickStory(items)?.id).toBe("FIX-1");
  });

  it("within a prefix takes the first eligible in file order", () => {
    const items = [item("US-1", DONE), item("US-2", TODO), item("US-3", TODO)];
    expect(pickStory(items)?.id).toBe("US-2");
  });

  it("falls through to US then REFACTOR when no FIX is eligible", () => {
    const items = [item("FIX-1", "🚫 Hold"), item("REFACTOR-1", TODO), item("US-1", TODO)];
    expect(pickStory(items)?.id).toBe("US-1");
  });

  it("uses advisory semantic ranking before deterministic prefix/file order when provided", () => {
    const items = [item("FIX-1", TODO), item("US-1", TODO), item("US-2", TODO)];
    expect(
      pickStory(items, {
        ranking: [
          { id: "US-2", score: 95, reason: "unblocks more follow-up work" },
          { id: "FIX-1", score: 20, reason: "less urgent" },
        ],
      })?.id,
    ).toBe("US-2");
  });

  it("still applies eligibility gates after advisory ranking", () => {
    const items = [item("US-HOLD", "🚫 Hold"), item("US-BLOCKED", TODO, "depends-on:US-MISSING"), item("FIX-1", TODO)];
    expect(
      pickStory(items, {
        ranking: [
          { id: "US-HOLD", score: 100, reason: "owner hold must still win" },
          { id: "US-BLOCKED", score: 99, reason: "blocked must still wait" },
        ],
      })?.id,
    ).toBe("FIX-1");
  });
});

describe("pickStory — depends-on chains", () => {
  it("skips a story whose single dep is not Done", () => {
    const items = [item("US-X", TODO, "x `depends-on:US-A`"), item("US-A", TODO)];
    expect(pickStory(items)?.id).toBe("US-A"); // US-X skipped, US-A itself eligible
  });

  it("picks a story whose single dep IS Done", () => {
    const items = [item("US-A", DONE), item("US-X", TODO, "x `depends-on:US-A`")];
    expect(pickStory(items)?.id).toBe("US-X");
  });

  it("multi-dep: all Done → eligible (US-X is the only Todo)", () => {
    const items = [
      item("US-A", DONE),
      item("US-B", DONE),
      item("US-X", TODO, "x `depends-on:US-A,US-B`"),
    ];
    expect(pickStory(items)?.id).toBe("US-X");
  });

  it("multi-dep: one missing → skipped", () => {
    const items = [
      item("US-A", DONE),
      item("US-X", TODO, "x `depends-on:US-A,US-MISSING`"),
    ];
    expect(pickStory(items)).toBeUndefined();
  });

  it("a depends-on mention in a sibling's description never gets re-picked as the dep owner", () => {
    // US-TODO merely mentions US-DONE; US-DONE is the real (Done) row (FIX-161).
    const items = [item("US-DONE", DONE), item("US-TODO", TODO, "mentions US-DONE here")];
    expect(pickStory(items)?.id).toBe("US-TODO");
  });
});

describe("pickStory — open-PR skip (injected predicate, FIX-141)", () => {
  it("skips a story that already has an open PR and takes the next", () => {
    const items = [item("US-1", TODO), item("US-2", TODO)];
    const pick = pickStory(items, { hasOpenPr: (id) => id === "US-1" });
    expect(pick?.id).toBe("US-2");
  });

  it("defaults to no open PRs when the predicate is omitted", () => {
    expect(pickStory([item("US-1", TODO)])?.id).toBe("US-1");
  });
});

describe("pickStory — merged-delivery skip (injected predicate, FIX-323)", () => {
  it("skips a 📋 Todo card whose deliverable already MERGED (zombie re-pick guard)", () => {
    // FIX-284 case: a prior gave_up reset the merged card to Todo; without the
    // guard the picker re-picks it forever. With the guard it takes the next.
    const items = [item("FIX-284", TODO), item("FIX-285", TODO)];
    const pick = pickStory(items, { hasMergedDelivery: (id) => id === "FIX-284" });
    expect(pick?.id).toBe("FIX-285");
  });

  it("returns undefined when the only Todo card has a merged delivery", () => {
    const pick = pickStory([item("FIX-284", TODO)], { hasMergedDelivery: (id) => id === "FIX-284" });
    expect(pick).toBeUndefined();
  });

  it("defaults to no merged deliveries when the predicate is omitted", () => {
    expect(pickStory([item("FIX-284", TODO)])?.id).toBe("FIX-284");
  });
});

describe("pickStory — annotated Todo gate is tolerant (FIX-301)", () => {
  it("picks an annotated Todo (marker + parenthetical text), not just a bare marker", () => {
    // FIX-284/285 carried `📋 Todo (...)`; an exact `=== "📋 Todo"` check dropped
    // them and idled the loop. The classifier recognizes the Todo marker regardless.
    expect(pickStory([item("FIX-1", "📋 Todo (rebased onto main)")])?.id).toBe("FIX-1");
  });

  it("still picks a bare Todo marker", () => {
    expect(pickStory([item("FIX-1", TODO)])?.id).toBe("FIX-1");
  });

  it("does not pick a non-Todo even when annotated", () => {
    expect(pickStory([item("FIX-1", "🚫 Hold (waiting on owner)")])).toBeUndefined();
  });

  it("when every Todo carries an annotation, still yields the first workable card", () => {
    // Priority (FIX > US > REFACTOR) and file order survive: every row is an
    // annotated Todo, so the first FIX in file order wins (the picker takes the
    // first eligible row top-to-bottom, not the lowest-numbered id).
    const items = [
      item("REFACTOR-1", "📋 Todo (low priority)"),
      item("US-1", "📋 Todo (needs design)"),
      item("FIX-2", "📋 Todo (cleanup)"),
      item("FIX-1", "📋 Todo (urgent)"),
    ];
    expect(pickStory(items)?.id).toBe("FIX-2");
  });

  it("an annotated Todo whose dep is Done is still gated by depends-on", () => {
    const items = [
      item("US-A", "✅ Done"),
      item("US-X", "📋 Todo (blocked earlier)", "x `depends-on:US-A`"),
    ];
    expect(pickStory(items)?.id).toBe("US-X");
  });
});

// ── prTitleReferences (US-LOOP-079c) ────────────────────────────────────────

describe("prTitleReferences — token-bounded id matching", () => {
  it("matches an exact id in the title", () => {
    expect(prTitleReferences("US-1", "US-1: wire hasOpenPr")).toBe(true);
  });

  it("does not match an id preceded by a letter", () => {
    expect(prTitleReferences("US-1", "abUS-1x")).toBe(false);
  });

  it("still matches when the id starts after punctuation", () => {
    expect(prTitleReferences("US-1", "fix: US-1")).toBe(true);
  });

  it("matches at the end of the title", () => {
    expect(prTitleReferences("FIX-42", "fix: parse FIX-42")).toBe(true);
  });

  it("does not match a substring (FIX-1 in FIX-10)", () => {
    expect(prTitleReferences("FIX-1", "FIX-10: big fix")).toBe(false);
  });

  it("does not match an id followed by a letter", () => {
    expect(prTitleReferences("US-A", "US-AB: adjacent")).toBe(false);
  });

  it("does not match when id is absent", () => {
    expect(prTitleReferences("US-1", "some other title")).toBe(false);
  });

  it("matches hyphen-separated ids", () => {
    expect(prTitleReferences("US-LOOP-079c", "cycle US-LOOP-079c published")).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(prTitleReferences("us-1", "US-1: lower vs upper")).toBe(false);
  });

  it("matches across multi-word titles", () => {
    expect(prTitleReferences("FIX-300", "[FIX-300] classifyStatus tolerance for legacy markers")).toBe(true);
  });
});

// ── buildHasOpenPr (US-LOOP-079c) ───────────────────────────────────────────

describe("buildHasOpenPr — predicate from open PR titles", () => {
  it("returns true when id matches a PR title", () => {
    const hasOpenPr = buildHasOpenPr(["US-1: wire hasOpenPr", "FIX-42: cleanup"]);
    expect(hasOpenPr("US-1")).toBe(true);
  });

  it("returns false when id matches no PR title", () => {
    const hasOpenPr = buildHasOpenPr(["US-1: wire hasOpenPr"]);
    expect(hasOpenPr("US-2")).toBe(false);
  });

  it("returns false for empty title list", () => {
    const hasOpenPr = buildHasOpenPr([]);
    expect(hasOpenPr("US-1")).toBe(false);
  });

  it("returns false when id is a substring of another id in the title", () => {
    // FIX-1 should NOT match a PR titled "FIX-10: ..."
    const hasOpenPr = buildHasOpenPr(["FIX-10: big fix"]);
    expect(hasOpenPr("FIX-1")).toBe(false);
  });

  it("matching is token-bounded — id followed by non-alphanumeric", () => {
    const hasOpenPr = buildHasOpenPr(["[US-1] some work"]);
    expect(hasOpenPr("US-1")).toBe(true);
  });

  it("FIX-1205 AC1: published-pending card is skipped and the next scoped Todo is picked", () => {
    const items = [
      item("US-CAPTURE-006", "📋 Todo"),
      item("US-CAPTURE-007", "📋 Todo"),
    ];
    const hasOpenPr = buildHasOpenPr([
      {
        number: 6,
        title: "loop cycle cycle-21303",
        headRefName: "loop/cycle-21303",
        body: "Roll-Evidence: US-CAPTURE-006 roll-meta@abcdef1 features/capture/ac-map.json\n",
      },
    ]);
    expect(pickStory(items, { hasOpenPr })?.id).toBe("US-CAPTURE-007");
    expect(openPrBlockReason("US-CAPTURE-006", hasOpenPr)).toBe("awaiting merge of PR #6");
  });

  it("FIX-1205 AC2: the only scoped card pending merge idles with an awaiting-merge reason", () => {
    const items = [item("US-CAPTURE-006", "📋 Todo")];
    const hasOpenPr = buildHasOpenPr([
      {
        number: 6,
        title: "loop cycle cycle-21303",
        headRefName: "loop/cycle-21303",
        body: "Roll-Evidence: US-CAPTURE-006 roll-meta@abcdef1 features/capture/ac-map.json\n",
      },
    ]);
    expect(pickStory(items, { hasOpenPr })).toBeUndefined();
    expect(assessBacklog(items, { hasOpenPr })).toMatchObject({ hasWork: false, reason: "all_awaiting_merge" });
    expect(openPrBlockReason("US-CAPTURE-006", hasOpenPr)).toBe("awaiting merge of PR #6");
  });

  it("FIX-1205 AC3: loop-named PRs without card ids in title or branch match body trailers", () => {
    const hasOpenPr = buildHasOpenPr([
      {
        number: 6,
        title: "loop cycle cycle-21303",
        headRefName: "loop/cycle-21303",
        body: "Roll-Evidence: US-CAPTURE-006 roll-meta@abcdef1 features/capture/ac-map.json\n",
      },
    ]);
    expect(hasOpenPr("US-CAPTURE-006")).toBe(true);
    expect(hasOpenPr("US-CAPTURE-007")).toBe(false);
  });

  it("FIX-1205: ignores unrelated body mentions and matches only the Roll-Evidence trailer id", () => {
    const hasOpenPr = buildHasOpenPr([
      {
        number: 6,
        title: "loop cycle cycle-21303",
        headRefName: "loop/cycle-21303",
        body: "blocked by US-CAPTURE-006\n\nRoll-Evidence: US-CAPTURE-007 roll-meta@abcdef1 features/capture/ac-map.json\n",
      },
    ]);
    expect(hasOpenPr("US-CAPTURE-006")).toBe(false);
    expect(hasOpenPr("US-CAPTURE-007")).toBe(true);
  });

  it("FIX-1205: ignores Roll-Evidence trailers whose captured token is not a story id", () => {
    const hasOpenPr = buildHasOpenPr([
      {
        number: 6,
        title: "loop cycle cycle-21303",
        headRefName: "loop/cycle-21303",
        body: "Roll-Evidence: comment e.g. US-CAPTURE-006 is referenced in prose\n",
      },
    ]);
    expect(hasOpenPr("comment")).toBe(false);
    expect(hasOpenPr("US-CAPTURE-006")).toBe(false);
  });

  // AC3 fixture: all todos have open PRs → assessBacklog reason=all_awaiting_merge
  it("AC3: all todos blocked by open PR → all_awaiting_merge in assessBacklog", () => {
    const items = [
      item("US-1", "📋 Todo"),
      item("US-2", "📋 Todo"),
    ];
    const hasOpenPr = buildHasOpenPr([
      "US-1: fix parser",
      "US-2: add feature",
    ]);
    const result = assessBacklog(items, { hasOpenPr });
    expect(result).toMatchObject({ hasWork: false, reason: "all_awaiting_merge" });
  });

  // AC4: cards without open PR → pickStory unchanged
  it("AC4: no open PR titles → pickStory unchanged (regression)", () => {
    const items = [item("US-1", "📋 Todo"), item("FIX-42", "📋 Todo")];
    const hasOpenPr = buildHasOpenPr([]);
    // No open PRs → FIX has priority, FIX-42 picked
    expect(pickStory(items, { hasOpenPr })?.id).toBe("FIX-42");
  });

  it("FIX-1205 AC4: Todo cards with no matching PR remain pickable", () => {
    const items = [item("US-CAPTURE-007", "📋 Todo")];
    const hasOpenPr = buildHasOpenPr([
      {
        number: 6,
        title: "loop cycle cycle-21303",
        headRefName: "loop/cycle-21303",
        body: "storyId: US-CAPTURE-006",
      },
    ]);
    expect(pickStory(items, { hasOpenPr })?.id).toBe("US-CAPTURE-007");
  });
});

// ─── US-LOOP-079k AC1: dormancy suppression ────────────────────────────────

// US-LOOP-115: shouldSuppressDormancy and DORMANCY_SUPPRESSED_REASONS are deleted.
// They existed only to decide whether the dormancy path should fire; with dormancy
// gone they had no consumer, so keeping them would have been dead code carrying a
// comment about a caller that no longer exists (codex review r1).

// ─── US-DELIV-005: one-card-one-lease picker gate ──────────────────────────

describe("US-DELIV-005 — delivery lease gate", () => {
  it("skips a card held by an active delivery lease, picks the next free card", () => {
    const items = [item("US-1", TODO), item("US-2", TODO)];
    const deliveryLeaseBlock = (id: string): string | undefined =>
      id === "US-1" ? "card held: awaiting_merge" : undefined;
    expect(pickStory(items, { deliveryLeaseBlock })?.id).toBe("US-2");
  });

  it("no lease predicate wired → default is free (back-compat)", () => {
    expect(pickStory([item("US-1", TODO)])?.id).toBe("US-1");
  });

  it("all todo cards leased → no pick", () => {
    const items = [item("US-1", TODO), item("US-2", TODO)];
    expect(pickStory(items, { deliveryLeaseBlock: () => "card held: in_flight" })).toBeUndefined();
  });
});


describe("FIX-1268 — screen-lock physical-surface gate", () => {
  it("skips physical-surface cards while screen is locked", () => {
    const items = [
      item("FIX-1", TODO), // physical surface
      item("FIX-2", TODO), // no physical surface
    ];
    const requiresPhysicalSurface = (id: string): boolean => id === "FIX-1";
    expect(
      pickStory(items, { isScreenLocked: true, requiresPhysicalSurface })?.id,
    ).toBe("FIX-2");
  });

  it("does not skip physical-surface cards when screen is unlocked", () => {
    const items = [
      item("FIX-1", TODO),
      item("FIX-2", TODO),
    ];
    const requiresPhysicalSurface = (id: string): boolean => id === "FIX-1";
    expect(
      pickStory(items, { isScreenLocked: false, requiresPhysicalSurface })?.id,
    ).toBe("FIX-1");
  });

  it("picks a non-physical card even when a physical one is earlier in file order", () => {
    const items = [
      item("US-1", TODO), // physical
      item("FIX-1", TODO), // physical
      item("US-2", TODO), // not physical
    ];
    const requiresPhysicalSurface = (id: string): boolean => id.startsWith("US-1") || id === "FIX-1";
    expect(
      pickStory(items, { isScreenLocked: true, requiresPhysicalSurface })?.id,
    ).toBe("US-2");
  });

  it("assessBacklog reports screen_locked when all Todo cards are physical-surface", () => {
    const items = [item("US-1", TODO), item("FIX-1", TODO)];
    const requiresPhysicalSurface = (): boolean => true;
    const assessment = assessBacklog(items, { isScreenLocked: true, requiresPhysicalSurface });
    expect(assessment).toMatchObject({
      hasWork: false,
      reason: "screen_locked",
      blockedCards: [
        { id: "US-1", reason: "screen locked — physical surface unavailable" },
        { id: "FIX-1", reason: "screen locked — physical surface unavailable" },
      ],
    });
  });

  it("screen lock does not block when at least one non-physical card is pickable", () => {
    const items = [item("US-1", TODO), item("US-2", TODO)];
    const requiresPhysicalSurface = (id: string): boolean => id === "US-1";
    expect(pickStory(items, { isScreenLocked: true, requiresPhysicalSurface })?.id).toBe("US-2");
    expect(assessBacklog(items, { isScreenLocked: true, requiresPhysicalSurface })).toMatchObject({
      hasWork: true,
      reason: "has_work",
    });
  });

  it("physical-surface gate is checked after durable gates (lease > screen lock)", () => {
    const items = [item("US-1", TODO)];
    const assessment = assessBacklog(items, {
      isScreenLocked: true,
      requiresPhysicalSurface: () => true,
      deliveryLeaseBlock: () => "in_flight",
    });
    expect(assessment.reason).toBe("all_leased");
  });
});
