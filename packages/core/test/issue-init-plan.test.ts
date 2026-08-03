import { describe, expect, it } from "vitest";
import type { RepositoryBinding, RequirementSourceManifest } from "@roll/spec";
import {
  parseIssueStoryContract,
  renderBranchPattern,
  resolveIssueInitPlan,
  validateStoryId,
  type IssueInitProbe,
} from "../src/workspace/issue-init-plan.js";

const storySpec = `---
id: US-XX1
repositories:
  - alias: sot1
    access: write
    required_delivery: true
    base_ref: refs/tags/release-2026-08
  - alias: sot2
    access: write
    required_delivery: true
    depends_on_repo: sot1
  - alias: sot3
    access: read
integration_acceptance:
  command: [pnpm, test:integration]
  cwd: sot1
---

# US-XX1 body mentions repositories: should never be parsed
`;

const bindings: readonly RepositoryBinding[] = [
  {
    schema: "roll.repository-binding/v1",
    repoId: "repo-sot1",
    alias: "sot1",
    remote: "file:///tmp/remotes/sot1",
    integrationBranch: "main",
    provider: "generic",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  },
  {
    schema: "roll.repository-binding/v1",
    repoId: "repo-sot2",
    alias: "sot2",
    remote: "file:///tmp/remotes/sot2",
    integrationBranch: "main",
    provider: "generic",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  },
  {
    schema: "roll.repository-binding/v1",
    repoId: "repo-sot3",
    alias: "sot3",
    remote: "file:///tmp/remotes/sot3",
    integrationBranch: "main",
    provider: "generic",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  },
];

const requirementManifests: readonly RequirementSourceManifest[] = [
  {
    schema: "roll.requirement-source/v1",
    requirementId: "req-1",
    provider: "jira",
    ref: "SOT-15499",
    revision: "rev-1",
    capturedAt: "2026-07-20T00:00:00.000Z",
    previousRevisions: [],
    requirement: { bytes: 10, sha256: "a".repeat(64) },
    context: [],
    stories: ["US-XX1"],
    attest: { schema: "roll.requirement-attest-projection/v1", mode: "generated_aggregate", evidenceAuthority: "issue" },
    deliveryTarget: { terminal: "campaign_branch", branch: "idea-074-workspace", mainMerge: "forbidden" },
  },
];

function probe(overrides: Partial<IssueInitProbe> = {}): IssueInitProbe {
  return {
    manifest: { state: "absent" },
    worktrees: {},
    ...overrides,
  };
}

describe("validateStoryId", () => {
  it.each([
    "US-XX1",
    "FIX-204",
    "REFACTOR-47a",
    "IDEA-074",
    "BUG-12",
    "US-LOOP-079f1",
    "US-LOOP-079d2",
    "US-LOOP-079h1",
    "US-LOOP-079h2",
    "US-WS-019b",
    "US-BROW-008b",
    "US-BROW-009a",
    "US-META-002a",
    "US-META-002b",
    "US-META-002c",
    "US-ONBOARD-NUDGE-004",
    "US-DOC-GS-001",
  ])("accepts the closed story id syntax %s", (id) => {
    expect(validateStoryId(id)).toMatchObject({ ok: true });
  });

  it.each([
    ["empty string", ""],
    ["dot", "."],
    ["dot-dot", ".."],
    ["contains slash", "US-XX/1"],
    ["contains backslash", "US-XX\\1"],
    ["absolute path", "/etc/passwd"],
    ["traversal", "../../etc/passwd"],
    ["embedded traversal", "US-../../XX1"],
    ["null byte", "US-XX1\u0000"],
    ["whitespace", "US-XX1 "],
    ["lowercase prefix", "us-xx1"],
    ["no prefix", "XX1"],
    ["dot-prefixed hidden segment", ".US-XX1"],
    ["shell metacharacter semicolon", "US-XX1; rm -rf /"],
    ["shell metacharacter command substitution", "US-XX1$(whoami)"],
    ["embedded newline", "US-XX1\n"],
    ["embedded tab", "US-XX1\t"],
  ])("rejects %s", (_name, id) => {
    expect(validateStoryId(id)).toMatchObject({ ok: false });
  });
});

describe("renderBranchPattern", () => {
  it("substitutes workspace_id and story_id, and appends the repo alias for uniqueness when the pattern omits {repo_alias}", () => {
    expect(renderBranchPattern("roll/{workspace_id}/{story_id}", {
      workspaceId: "ws-demo",
      storyId: "US-XX1",
      repoAlias: "sot1",
    })).toBe("roll/ws-demo/US-XX1/sot1");
  });

  it("substitutes repo_alias in place when the pattern already declares it, without appending it again", () => {
    expect(renderBranchPattern("roll/{workspace_id}/{story_id}/{repo_alias}", {
      workspaceId: "ws-demo",
      storyId: "US-XX1",
      repoAlias: "sot1",
    })).toBe("roll/ws-demo/US-XX1/sot1");
  });
});

describe("parseIssueStoryContract", () => {
  it("reads only the frontmatter repositories block, ignoring prose mentions", () => {
    const parsed = parseIssueStoryContract(storySpec, { storyId: "US-XX1" });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        storyId: "US-XX1",
        repositories: [
          { alias: "sot1", access: "write", requiredDelivery: true, baseRef: "refs/tags/release-2026-08" },
          { alias: "sot2", access: "write", requiredDelivery: true, dependsOnRepo: "sot1" },
          { alias: "sot3", access: "read", requiredDelivery: false },
        ],
        integrationAcceptance: { command: ["pnpm", "test:integration"], cwd: "sot1" },
      },
    });
  });

  it.each([
    ["missing frontmatter", "# no frontmatter here", "invalid_config"],
    ["mismatched id", storySpec.replace("id: US-XX1", "id: US-OTHER"), "identity_mismatch"],
    ["empty repositories", storySpec.replace(/repositories:[\s\S]*?(?=\n---)/, "repositories: []\n"), "invalid_value"],
    ["unknown field", storySpec.replace("access: write", "access: write\n    weird_field: yes"), "unknown_field"],
    ["unsafe base ref", storySpec.replace("refs/tags/release-2026-08", "main"), "invalid_value"],
  ])("rejects %s", (_name, text, code) => {
    const parsed = parseIssueStoryContract(text, { storyId: "US-XX1" });
    expect(parsed).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code })]) });
  });
});

describe("resolveIssueInitPlan", () => {
  const contract = parseIssueStoryContract(storySpec, { storyId: "US-XX1" });
  if (!contract.ok) throw new Error("fixture must parse");

  it("resolves every declared alias against the Workspace bindings and requirement links", () => {
    const result = resolveIssueInitPlan({
      workspaceId: "ws-demo",
      contract: contract.value,
      bindings,
      requirementManifests,
    }, probe());
    expect(result).toMatchObject({
      ok: true,
      value: {
        manifest: {
          schema: "roll.issue/v1",
          workspaceId: "ws-demo",
          storyId: "US-XX1",
          requirements: [{ provider: "jira", ref: "SOT-15499" }],
          repositories: [
            { repoId: "repo-sot1", alias: "sot1", access: "write", baseRef: "refs/tags/release-2026-08", workBranch: "roll/ws-demo/US-XX1/sot1" },
            { repoId: "repo-sot2", alias: "sot2", access: "write", workBranch: "roll/ws-demo/US-XX1/sot2", dependsOnRepo: "sot1" },
            { repoId: "repo-sot3", alias: "sot3", access: "read" },
          ],
          integrationAcceptance: { command: ["pnpm", "test:integration"], cwd: "sot1" },
          deliveryTarget: { terminal: "campaign_branch", branch: "idea-074-workspace", mainMerge: "forbidden" },
        },
        outcome: "created",
        targets: [
          expect.objectContaining({ alias: "sot1", action: "created", access: "write", worktreePath: expect.stringContaining("sot1"), workBranch: "roll/ws-demo/US-XX1/sot1" }),
          expect.objectContaining({ alias: "sot2", action: "created", access: "write", worktreePath: expect.stringContaining("sot2"), workBranch: "roll/ws-demo/US-XX1/sot2" }),
          expect.objectContaining({ alias: "sot3", action: "created", access: "read", worktreePath: expect.stringContaining("sot3"), workBranch: null }),
        ],
      },
    });
  });

  it("gives every write target a unique work branch even when the binding's pattern has no {repo_alias}", () => {
    const result = resolveIssueInitPlan({
      workspaceId: "ws-demo",
      contract: contract.value,
      bindings,
      requirementManifests,
    }, probe());
    if (!result.ok) throw new Error("expected plan");
    const writeBranches = result.value.targets.filter((target) => target.access === "write").map((target) => target.workBranch);
    expect(new Set(writeBranches).size).toBe(writeBranches.length);
    expect(writeBranches.every((branch) => typeof branch === "string" && branch.length > 0)).toBe(true);
  });

  it("never assigns a work branch to a read target", () => {
    const result = resolveIssueInitPlan({
      workspaceId: "ws-demo",
      contract: contract.value,
      bindings,
      requirementManifests,
    }, probe());
    if (!result.ok) throw new Error("expected plan");
    const readTarget = result.value.targets.find((target) => target.alias === "sot3");
    expect(readTarget?.workBranch).toBeNull();
  });

  it("fails loud when linked Requirements disagree on the campaign terminal", () => {
    const conflicting = {
      ...requirementManifests[0]!,
      requirementId: "req-2",
      provider: "user_input" as const,
      ref: "owner-campaign",
      deliveryTarget: { terminal: "campaign_branch" as const, branch: "other-campaign", mainMerge: "forbidden" as const },
    };
    const result = resolveIssueInitPlan({
      workspaceId: "ws-demo",
      contract: contract.value,
      bindings,
      requirementManifests: [...requirementManifests, conflicting],
    }, probe());
    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: "requirements.deliveryTarget" })],
    });
  });

  it("fails loud when a declared alias has no matching Workspace binding", () => {
    const result = resolveIssueInitPlan({
      workspaceId: "ws-demo",
      contract: contract.value,
      bindings: bindings.filter((binding) => binding.alias !== "sot2"),
      requirementManifests,
    }, probe());
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "unknown_field", path: expect.stringContaining("sot2") })]),
    });
  });

  it("summarizes compatible per-target retries as reused or repaired, never silently created", () => {
    const reused = resolveIssueInitPlan({
      workspaceId: "ws-demo",
      contract: contract.value,
      bindings,
      requirementManifests,
    }, probe({
      manifest: { state: "compatible" },
      worktrees: { sot1: "compatible", sot2: "compatible", sot3: "compatible" },
    }));
    expect(reused).toMatchObject({ ok: true, value: { outcome: "reused" } });

    const repaired = resolveIssueInitPlan({
      workspaceId: "ws-demo",
      contract: contract.value,
      bindings,
      requirementManifests,
    }, probe({
      manifest: { state: "compatible" },
      worktrees: { sot1: "repairable", sot2: "compatible", sot3: "compatible" },
    }));
    expect(repaired).toMatchObject({ ok: true, value: { outcome: "repaired" } });
    if (!repaired.ok) throw new Error("expected repaired plan");
    expect(repaired.value.targets[0]).toMatchObject({ alias: "sot1", action: "repaired" });
  });

  it("orders rollback of newly-created targets in reverse, excluding conflicted/dirty ones", () => {
    const result = resolveIssueInitPlan({
      workspaceId: "ws-demo",
      contract: contract.value,
      bindings,
      requirementManifests,
    }, probe({
      worktrees: { sot1: "compatible", sot2: "absent", sot3: "absent" },
    }));
    expect(result).toMatchObject({
      ok: true,
      value: {
        targets: [
          expect.objectContaining({ alias: "sot1", action: "reused" }),
          expect.objectContaining({ alias: "sot2", action: "created" }),
          expect.objectContaining({ alias: "sot3", action: "created" }),
        ],
      },
    });
    if (!result.ok) throw new Error("expected plan");
    expect(result.value.rollbackOrder).toEqual(["sot3", "sot2"]);
  });

  it("rejects a conflicting worktree state instead of silently repairing it", () => {
    const result = resolveIssueInitPlan({
      workspaceId: "ws-demo",
      contract: contract.value,
      bindings,
      requirementManifests,
    }, probe({ worktrees: { sot1: "conflict", sot2: "absent", sot3: "absent" } }));
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: "invalid_value", path: "repositories[sot1]" })]) });
  });
});
