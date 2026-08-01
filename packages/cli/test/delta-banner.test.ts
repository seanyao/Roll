import { describe, expect, it } from "vitest";
import { renderDeltaBanner } from "../src/lib/delta-banner.js";

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
});
