import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWorkspaceBacklogStoryContract,
  resolveWorkspaceBacklogStorySpec,
} from "../src/issue-story-contract.js";

const sandboxes: string[] = [];
afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-issue-story-contract-"));
  sandboxes.push(root);
  return root;
}

function writeSpec(path: string, storyId: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "spec.md"), `---
id: ${storyId}
repositories:
  - alias: sot
    access: write
    required_delivery: true
---

# ${storyId} fixture
`, "utf8");
}

describe("resolveWorkspaceBacklogStoryContract", () => {
  it("returns the exact Workspace-owned Story spec text for acceptance consumers", () => {
    const workspaceRoot = sandbox();
    writeSpec(join(workspaceRoot, "backlog", "workspace-orchestration", "US-XX1"), "US-XX1");
    const result = resolveWorkspaceBacklogStorySpec(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected Workspace story spec");
    expect(result.path).toBe(join(workspaceRoot, "backlog", "workspace-orchestration", "US-XX1", "spec.md"));
    expect(result.text).toContain("# US-XX1 fixture");
  });

  it("resolves a Story Contract found inside the Workspace backlog tree, at any depth", () => {
    const workspaceRoot = sandbox();
    writeSpec(join(workspaceRoot, "backlog", "workspace-orchestration", "US-XX1"), "US-XX1");
    const result = resolveWorkspaceBacklogStoryContract(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: true, value: { storyId: "US-XX1" } });
  });

  it("resolves the canonical Story spec minted under the Workspace features tree", () => {
    const workspaceRoot = sandbox();
    writeSpec(join(workspaceRoot, "features", "workspace-orchestration", "US-XX1"), "US-XX1");
    const result = resolveWorkspaceBacklogStorySpec(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected Workspace story spec");
    expect(result.path).toBe(join(workspaceRoot, "features", "workspace-orchestration", "US-XX1", "spec.md"));
  });

  it("fails loud when the same Story exists in both legacy backlog and canonical features", () => {
    const workspaceRoot = sandbox();
    writeSpec(join(workspaceRoot, "backlog", "workspace-orchestration", "US-XX1"), "US-XX1");
    writeSpec(join(workspaceRoot, "features", "workspace-orchestration", "US-XX1"), "US-XX1");
    const result = resolveWorkspaceBacklogStoryContract(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: false, code: "duplicate_story" });
    if (result.ok) throw new Error("expected duplicate_story");
    expect(result.matches).toHaveLength(2);
  });

  it("does NOT resolve a Story Contract from the caller's cwd .roll/features tree", () => {
    const workspaceRoot = sandbox();
    // Deliberately place the spec OUTSIDE the Workspace backlog tree, in a
    // .roll/features layout — this must be invisible to the Workspace-scoped resolver.
    writeSpec(join(workspaceRoot, ".roll", "features", "workspace-orchestration", "US-XX1"), "US-XX1");
    const result = resolveWorkspaceBacklogStoryContract(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: false, code: "story_not_found" });
  });

  it("fails loud when a story id resolves to more than one spec in the backlog tree", () => {
    const workspaceRoot = sandbox();
    writeSpec(join(workspaceRoot, "backlog", "epic-a", "US-XX1"), "US-XX1");
    writeSpec(join(workspaceRoot, "backlog", "epic-b", "US-XX1"), "US-XX1");
    const result = resolveWorkspaceBacklogStoryContract(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: false, code: "duplicate_story" });
    if (result.ok) throw new Error("expected duplicate_story");
    expect(result.matches).toHaveLength(2);
  });

  it("reports story_not_found when no spec exists anywhere in the backlog tree", () => {
    const workspaceRoot = sandbox();
    mkdirSync(join(workspaceRoot, "backlog"), { recursive: true });
    const result = resolveWorkspaceBacklogStoryContract(workspaceRoot, "US-NOPE");
    expect(result).toMatchObject({ ok: false, code: "story_not_found" });
  });

  it("reports story_not_found when the Workspace has no backlog directory at all", () => {
    const workspaceRoot = sandbox();
    const result = resolveWorkspaceBacklogStoryContract(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: false, code: "story_not_found" });
  });

  it("refuses a symlinked spec.md pointing outside the Workspace, fail-loud rather than reading through it", () => {
    const workspaceRoot = sandbox();
    const outside = sandbox();
    writeFileSync(join(outside, "external-spec.md"), `---
id: US-XX1
repositories:
  - alias: sot
    access: write
    required_delivery: true
---

# planted outside the Workspace — must never be read
`, "utf8");
    const storyDir = join(workspaceRoot, "backlog", "workspace-orchestration", "US-XX1");
    mkdirSync(storyDir, { recursive: true });
    symlinkSync(join(outside, "external-spec.md"), join(storyDir, "spec.md"));

    const result = resolveWorkspaceBacklogStoryContract(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: false, code: "symlink_escape" });
  });

  it("refuses a symlinked backlog ROOT itself escaping the Workspace, fail-loud rather than reporting story_not_found", () => {
    const workspaceRoot = sandbox();
    const outside = sandbox();
    writeSpec(join(outside, "workspace-orchestration", "US-XX1"), "US-XX1");
    // `backlog` itself (not just something inside it) is a symlink.
    symlinkSync(outside, join(workspaceRoot, "backlog"));

    const result = resolveWorkspaceBacklogStoryContract(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: false, code: "symlink_escape" });
  });

  it("refuses a symlinked features ROOT escaping the Workspace", () => {
    const workspaceRoot = sandbox();
    const outside = sandbox();
    writeSpec(join(outside, "workspace-orchestration", "US-XX1"), "US-XX1");
    symlinkSync(outside, join(workspaceRoot, "features"));

    const result = resolveWorkspaceBacklogStoryContract(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: false, code: "symlink_escape" });
  });

  it("refuses a spec.md reached through a symlinked ANCESTOR directory escaping the Workspace", () => {
    const workspaceRoot = sandbox();
    const outside = sandbox();
    writeSpec(join(outside, "US-XX1"), "US-XX1");
    mkdirSync(join(workspaceRoot, "backlog"), { recursive: true });
    // The story directory ITSELF is a symlink to somewhere outside the Workspace.
    symlinkSync(join(outside, "US-XX1"), join(workspaceRoot, "backlog", "US-XX1"));

    const result = resolveWorkspaceBacklogStoryContract(workspaceRoot, "US-XX1");
    expect(result).toMatchObject({ ok: false, code: "symlink_escape" });
  });
});
