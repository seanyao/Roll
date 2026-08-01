import { describe, expect, it } from "vitest";
import { createSkillDispatchPlan, skillDispatchAuthority, type SkillDispatchParent } from "../src/index.js";

const parent: SkillDispatchParent = {
  reservation: { storyId: "US-LOOP-127", runId: "dispatch-run-127" },
  workspace: {
    schema: 1,
    runId: "dispatch-run-127",
    storyId: "US-LOOP-127",
    kind: "skill_dispatch",
    topology: "solo",
    members: [{
      repositoryId: "github.com/acme/roll",
      workspaceKey: "dispatch-run-127",
      relativeLocator: "dispatch-run-127",
      checkoutRef: { kind: "detached", head: "a".repeat(40) },
    }],
  },
};

describe("US-LOOP-127 — parent-owned Skill dispatch", () => {
  it("creates stable detached children only for pairwise-disjoint normalized scopes", () => {
    const result = createSkillDispatchPlan(parent, [
      { actionId: "docs", declaredFileScope: ["docs/guide.md"] },
      { actionId: "runtime", declaredFileScope: ["packages/cli/src/runner"] },
    ]);

    expect(result).toEqual({
      ok: true,
      value: {
        parent,
        children: [
          { actionId: "docs", relativeLocator: "dispatch-run-127.children/docs", declaredFileScope: ["docs/guide.md"] },
          { actionId: "runtime", relativeLocator: "dispatch-run-127.children/runtime", declaredFileScope: ["packages/cli/src/runner"] },
        ],
      },
    });
  });

  it.each([
    [[{ actionId: "same", declaredFileScope: ["docs"] }, { actionId: "same", declaredFileScope: ["packages/core"] }]],
    [[{ actionId: "one", declaredFileScope: ["packages/cli"] }, { actionId: "two", declaredFileScope: ["packages/cli/src"] }]],
    [[{ actionId: "unknown", declaredFileScope: [] }]],
    [[{ actionId: "escape", declaredFileScope: ["../outside"] }]],
  ])("refuses ambiguous action declarations", (actions) => {
    expect(createSkillDispatchPlan(parent, actions).ok).toBe(false);
  });

  it("refuses a parent without the matching Story reservation", () => {
    expect(createSkillDispatchPlan({
      ...parent,
      reservation: { storyId: "US-OTHER", runId: "dispatch-run-127" },
    }, [{ actionId: "docs", declaredFileScope: ["docs"] }])).toEqual({ ok: false, reason: "parent_reservation_missing" });
  });

  it("keeps PR, attest, Story closure, and reservation release parent-only", () => {
    expect(skillDispatchAuthority("child", "publish_pr")).toEqual({ ok: false, reason: "parent_required" });
    expect(skillDispatchAuthority("child", "attest")).toEqual({ ok: false, reason: "parent_required" });
    expect(skillDispatchAuthority("child", "close_story")).toEqual({ ok: false, reason: "parent_required" });
    expect(skillDispatchAuthority("child", "release_reservation")).toEqual({ ok: false, reason: "parent_required" });
    expect(skillDispatchAuthority("parent", "publish_pr")).toEqual({ ok: true });
  });
});
