import { describe, expect, it } from "vitest";
import { workspaceContextAuditReleaseGap } from "../src/consistency/audit.js";

describe("US-WS-039 Workspace context release gate", () => {
  it("passes only when the post-allowlist violation count is zero", () => {
    expect(workspaceContextAuditReleaseGap({ violations: 0, scannedSurfaces: 53, allowlisted: 9 })).toBeNull();
    expect(workspaceContextAuditReleaseGap({ violations: 2, scannedSurfaces: 53, allowlisted: 9 }))
      .toContain("2 violation(s)");
  });
});
