import { describe, expect, it } from "vitest";
import { detectLegacyProject } from "../src/workspace/migration-detection.js";

describe("detectLegacyProject", () => {
  it("returns the exact migration preflight command for a legacy repository", () => {
    expect(detectLegacyProject({
      hasBacklogMd: true,
      hasWorkspaceManifest: false,
      repositoryRoot: "/tmp/legacy repo",
    })).toEqual({
      legacy: true,
      repositoryRoot: "/tmp/legacy repo",
      migrationCheckCommand: "roll workspace migrate --from '/tmp/legacy repo' --check",
    });
  });

  it("does not classify a repository with a reachable Workspace manifest as legacy", () => {
    expect(detectLegacyProject({
      hasBacklogMd: true,
      hasWorkspaceManifest: true,
      repositoryRoot: "/tmp/project",
    })).toEqual({ legacy: false });
  });
});
