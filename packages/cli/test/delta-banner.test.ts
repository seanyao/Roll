import { describe, expect, it } from "vitest";
import { renderDeltaBanner, renderDeltaPhaseBanner } from "../src/lib/delta-banner.js";

const copy = {
  title: "Delta Team assembling",
  story: "story",
  diversity: "diversity",
  diversityDistinct: "{builder} ≠ {evaluator}  ✓",
  diversityUndeclared: "undeclared heterogeneity",
  frame: "frame",
  leaseHeld: "lease held",
};

describe("US-DELTA-009 — Delta Team assembly banner", () => {
  it("renders persisted roles and never claims diversity for a shared host and model", () => {
    const output = renderDeltaBanner({
      storyId: "US-DELTA-BANNER",
      roles: [
        {
          role: "builder",
          roleInstanceId: "ri-builder",
          hostId: "codex",
          modelId: "gpt-5.6-terra",
          source: "availability-fallback",
          reasons: [],
        },
        {
          role: "evaluator",
          roleInstanceId: "ri-evaluator",
          hostId: "codex",
          modelId: "gpt-5.6-terra",
          source: "preset-preference",
          reasons: [],
        },
      ],
      frameDir: "delta-123",
    }, copy);

    expect(output).toMatchSnapshot();
    expect(output).toContain("⚠ availability-fallback");
    expect(output).toContain("undeclared heterogeneity");
    expect(output).not.toContain("✓");
  });

  it("US-DELTA-010: renders every lifecycle phase with one aligned field layout", () => {
    const output = [
      renderDeltaBanner({
        storyId: "US-DELTA-PHASE",
        roles: [
          { role: "builder", roleInstanceId: "ri-builder", hostId: "codex", modelId: "gpt-5.6-terra", source: "user-pin", reasons: [] },
          { role: "evaluator", roleInstanceId: "ri-evaluator", hostId: "cursor", modelId: "cursor-grok", source: "user-pin", reasons: [] },
        ],
        frameDir: "delta-456",
      }, copy),
      renderDeltaPhaseBanner({
        title: "Delta Team validating",
        fields: [
          { label: "delegation", value: "delta-456" },
          { label: "stage", value: "builder" },
          { label: "verdict", value: "allowed" },
        ],
      }),
      renderDeltaPhaseBanner({
        title: "Delta Team concluded",
        fields: [
          { label: "story", value: "US-DELTA-PHASE" },
          { label: "outcome", value: "handoff_ready (handoff_only)" },
          { label: "disposition", value: "owner_continue" },
        ],
      }),
    ].join("\n\n");

    expect(output).toMatchSnapshot();
  });
});
