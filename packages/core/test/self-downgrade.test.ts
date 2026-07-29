/**
 * US-AGENT-042 — self-downgrade pure decision core: chain-depth cap, child
 * dependency inheritance (never the umbrella parent), the backlog transform,
 * the audit event, and open-PR discovery.
 */
import { describe, expect, it } from "vitest";
import type { RollEvent } from "@roll/spec";
import {
  CHAIN_DEPTH_CAP,
  applySelfDowngradeToBacklog,
  buildStorySplitEvent,
  openPrForStory,
  parseChainDepth,
  planSelfDowngrade,
  wasSelfDowngraded,
} from "../src/loop/self-downgrade.js";

describe("parseChainDepth", () => {
  it("reads a chain_depth tag (desc or spec form), default 0", () => {
    expect(parseChainDepth("big card chain_depth:2 depends-on:US-1")).toBe(2);
    expect(parseChainDepth("- chain_depth: 1")).toBe(1);
    expect(parseChainDepth("no tag here")).toBe(0);
    expect(parseChainDepth("chain-depth:3")).toBe(3);
    expect(parseChainDepth("chain_depth:-1")).toBe(0);
  });
});

describe("planSelfDowngrade — chain_depth cap (US-AGENT-009)", () => {
  it("splits at depth 0 with ≥2 sub-ids; children carry depth+1", () => {
    const plan = planSelfDowngrade({
      parentId: "US-X",
      parentChainDepth: 0,
      parentDependsOn: [],
      subIds: ["US-X-a", "US-X-b"],
    });
    expect(plan.kind).toBe("split");
    if (plan.kind !== "split") throw new Error("expected split");
    expect(plan.children.map((c) => c.id)).toEqual(["US-X-a", "US-X-b"]);
    expect(plan.children.every((c) => c.chainDepth === 1)).toBe(true);
  });

  it("splits at depth 1 → children depth 2 (still under the cap)", () => {
    const plan = planSelfDowngrade({
      parentId: "US-X-a",
      parentChainDepth: 1,
      parentDependsOn: [],
      subIds: ["US-X-a-1", "US-X-a-2"],
    });
    expect(plan.kind).toBe("split");
    if (plan.kind !== "split") throw new Error("expected split");
    expect(plan.children.every((c) => c.chainDepth === 2)).toBe(true);
  });

  it("REFUSES the 3rd split: a chain_depth==2 card is cap-hit even with sub-ids", () => {
    const plan = planSelfDowngrade({
      parentId: "US-X-a-1",
      parentChainDepth: CHAIN_DEPTH_CAP,
      parentDependsOn: [],
      subIds: ["US-X-a-1-i", "US-X-a-1-ii"],
    });
    expect(plan.kind).toBe("cap-hit");
    if (plan.kind !== "cap-hit") throw new Error("expected cap-hit");
    expect(plan.capReason).toBe("chain-cap");
  });

  it("treats <2 usable sub-ids as irreducible → cap-hit (US-AGENT-008 fallback)", () => {
    const plan = planSelfDowngrade({
      parentId: "US-X",
      parentChainDepth: 0,
      parentDependsOn: [],
      subIds: ["US-X-only"],
    });
    expect(plan.kind).toBe("cap-hit");
    if (plan.kind !== "cap-hit") throw new Error("expected cap-hit");
    expect(plan.capReason).toBe("irreducible");
  });
});

describe("planSelfDowngrade — child dependency hygiene (no umbrella deadlock)", () => {
  it("children inherit the parent's ORIGINAL inbound deps, NEVER the parent", () => {
    const plan = planSelfDowngrade({
      parentId: "FIX-356",
      parentChainDepth: 0,
      parentDependsOn: ["US-AGENT-041"],
      subIds: ["FIX-356a", "FIX-356b"],
    });
    if (plan.kind !== "split") throw new Error("expected split");
    for (const c of plan.children) {
      expect(c.dependsOn).toEqual(["US-AGENT-041"]);
      expect(c.dependsOn).not.toContain("FIX-356");
    }
  });

  it("drops a blank / self-referential sub-id before counting", () => {
    const plan = planSelfDowngrade({
      parentId: "US-X",
      parentChainDepth: 0,
      parentDependsOn: [],
      subIds: ["US-X", "", "US-X-a", "US-X-b", "US-X-a"],
    });
    if (plan.kind !== "split") throw new Error("expected split");
    expect(plan.children.map((c) => c.id)).toEqual(["US-X-a", "US-X-b"]);
  });
});

describe("applySelfDowngradeToBacklog", () => {
  const BASE = [
    "| ID | Description | Status |",
    "|----|----|----|",
    "| [US-X](.roll/features/ep/US-X/spec.md) | big story depends-on:US-1 | 🔨 In Progress |",
    "",
  ].join("\n");

  it("parks the parent at 🚫 Hold and appends children as Todo with deps+depth tags", () => {
    const out = applySelfDowngradeToBacklog(BASE, "US-X", [
      { id: "US-X-a", title: "part a", epic: "ep", dependsOn: ["US-1"], chainDepth: 1 },
      { id: "US-X-b", title: "part b", epic: "ep", dependsOn: ["US-1"], chainDepth: 1 },
    ]);
    expect(out).toContain("| [US-X](.roll/features/ep/US-X/spec.md) | big story depends-on:US-1 | 🚫 Hold |");
    expect(out).toContain("| [US-X-a](.roll/features/ep/US-X-a/spec.md) | part a chain_depth:1 depends-on:US-1 | 📋 Todo |");
    expect(out).toContain("| [US-X-b](.roll/features/ep/US-X-b/spec.md) | part b chain_depth:1 depends-on:US-1 | 📋 Todo |");
  });

  it("cap-hit (no children) only parks the parent", () => {
    const out = applySelfDowngradeToBacklog(BASE, "US-X", []);
    expect(out).toContain("| big story depends-on:US-1 | 🚫 Hold |");
    expect(out).not.toContain("📋 Todo");
  });

  it("FIX-1475: parks ONLY the exact parent — a pre-existing `<id>-` descendant is untouched", () => {
    const withSibling = [
      "| ID | Description | Status |",
      "|----|----|----|",
      "| [US-X](.roll/features/ep/US-X/spec.md) | big story | 🔨 In Progress |",
      "| [US-X-legacy](.roll/features/ep/US-X-legacy/spec.md) | unrelated descendant | 📋 Todo |",
      "",
    ].join("\n");
    const out = applySelfDowngradeToBacklog(withSibling, "US-X", []);
    // The exact parent is parked …
    expect(out).toContain("| [US-X](.roll/features/ep/US-X/spec.md) | big story | 🚫 Hold |");
    // … but the descendant row keeps its status (prefix markStatus would have
    // wrongly flipped it to Hold too).
    expect(out).toContain("| [US-X-legacy](.roll/features/ep/US-X-legacy/spec.md) | unrelated descendant | 📋 Todo |");
  });
});

describe("buildStorySplitEvent", () => {
  it("encodes a real split", () => {
    const plan = planSelfDowngrade({
      parentId: "US-X",
      parentChainDepth: 0,
      parentDependsOn: [],
      subIds: ["US-X-a", "US-X-b"],
    });
    const ev = buildStorySplitEvent(plan, "too big: 3 surfaces", 123);
    expect(ev).toEqual({
      type: "story:split",
      parentStoryId: "US-X",
      childStoryIds: ["US-X-a", "US-X-b"],
      reason: "too big: 3 surfaces",
      chainDepth: 0,
      capped: false,
      ts: 123,
    });
  });

  it("encodes a capped refusal with no children", () => {
    const plan = planSelfDowngrade({
      parentId: "US-X",
      parentChainDepth: CHAIN_DEPTH_CAP,
      parentDependsOn: [],
      subIds: ["a", "b"],
    });
    const ev = buildStorySplitEvent(plan, "chain cap", 9);
    if (ev.type !== "story:split") throw new Error("type");
    expect(ev.capped).toBe(true);
    expect(ev.childStoryIds).toEqual([]);
  });
});

describe("openPrForStory", () => {
  const ev = (e: RollEvent): RollEvent => e;
  it("returns the open PR for the story, ignoring merged/closed", () => {
    const events: RollEvent[] = [
      ev({ type: "pr:open", prNumber: 5, storyId: "US-X", ts: 1 }),
      ev({ type: "pr:close", prNumber: 5, reason: "x", ts: 2 }),
      ev({ type: "pr:open", prNumber: 7, storyId: "US-X", ts: 3 }),
    ];
    expect(openPrForStory(events, "US-X")).toBe(7);
  });

  it("null when the only PR merged, or for a different story", () => {
    const events: RollEvent[] = [
      ev({ type: "pr:open", prNumber: 9, storyId: "US-X", ts: 1 }),
      ev({ type: "pr:merge", prNumber: 9, storyId: "US-X", ts: 2 }),
    ];
    expect(openPrForStory(events, "US-X")).toBeNull();
    expect(openPrForStory(events, "US-Y")).toBeNull();
  });
});

describe("wasSelfDowngraded", () => {
  it("detects a deliberate park (split or capped) for the story since a ts", () => {
    const events: RollEvent[] = [
      { type: "story:split", parentStoryId: "US-X", childStoryIds: ["a", "b"], reason: "r", chainDepth: 0, capped: false, ts: 100 },
    ];
    expect(wasSelfDowngraded(events, "US-X", 50)).toBe(true);
    expect(wasSelfDowngraded(events, "US-X", 200)).toBe(false); // before window
    expect(wasSelfDowngraded(events, "US-Y", 50)).toBe(false);
  });
});
