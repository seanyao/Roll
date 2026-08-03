import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_EDIT_CONFIG_V1,
  buildWorkspaceEditPlan,
  parseWorkspaceEditConfig,
  serializeWorkspaceMetadataReferenceIndex,
  serializeWorkspaceManifest,
  type WorkspaceMetadataReferenceIndex,
} from "../src/workspace/edit-plan.js";
import { normalizeRequirementSourceReference } from "../src/workspace/requirement-source.js";
import { repositoryIdFromRemote, type WorkspaceManifest } from "@roll/spec";

const current: WorkspaceManifest = {
  schema: "roll.workspace/v1",
  workspaceId: "ws-demo",
  displayName: "Demo",
  createdAt: "2026-07-20T00:00:00.000Z",
  requirements: [{ provider: "jira", ref: "SOT-15499" }],
  repositories: [{
    schema: "roll.repository-binding/v1",
    repoId: "repo-ff7a87ddbb2b",
    alias: "product",
    remote: "https://example.test/owner/product",
    integrationBranch: "main",
    provider: "github",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: ["test"] },
  }],
};

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function references(overrides: Partial<WorkspaceMetadataReferenceIndex> = {}): WorkspaceMetadataReferenceIndex {
  return {
    schema: "roll.workspace-metadata-reference-index/v1",
    workspaceId: "ws-demo",
    issues: [],
    requirementArchives: [],
    additionalFacts: [],
    ...overrides,
  };
}

function configText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: WORKSPACE_EDIT_CONFIG_V1,
    workspace_id: "ws-demo",
    expected_manifest_sha256: digest(serializeWorkspaceManifest(current)),
    display_name: "Renamed Demo",
    requirements: [{ provider: "jira", ref: "sot-15499" }],
    repositories: [{
      alias: "product",
      remote: "https://example.test/owner/product.git",
      provider: "github",
      integration_branch: "main",
      branch_pattern: "roll/{workspace_id}/{story_id}",
      required_checks: ["test"],
    }],
    ...overrides,
  });
}

describe("US-WS-025 Workspace metadata edit plan", () => {
  it("parses the closed desired-state schema and builds a byte-stable display-name preview", () => {
    const parsed = parseWorkspaceEditConfig(configText(), { workspaceId: "ws-demo" });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        schema: WORKSPACE_EDIT_CONFIG_V1,
        workspaceId: "ws-demo",
        displayName: "Renamed Demo",
        requirements: [{ provider: "jira", ref: "SOT-15499" }],
        repositories: [{
          alias: "product",
          remote: "https://example.test/owner/product",
        }],
      },
    });
    if (!parsed.ok) throw new Error("fixture must parse");
    expect(Object.keys(parsed.value.repositories[0] ?? {}).sort()).toEqual([
      "alias",
      "branchPattern",
      "integrationBranch",
      "provider",
      "remote",
      "requiredChecks",
    ]);

    const first = buildWorkspaceEditPlan({
      config: parsed.value,
      current,
      references: references(),
      manifestPath: "/workspace/workspace.yaml",
    });
    const second = buildWorkspaceEditPlan({
      config: parsed.value,
      current,
      references: references(),
      manifestPath: "/workspace/workspace.yaml",
    });

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      schema: "roll.workspace-edit-plan/v1",
      outcome: "ready",
      workspaceId: "ws-demo",
      manifestPath: "/workspace/workspace.yaml",
      beforeSha256: digest(serializeWorkspaceManifest(current)),
      referenceIndexSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      afterManifest: {
        workspaceId: "ws-demo",
        displayName: "Renamed Demo",
        createdAt: current.createdAt,
      },
      changes: [{
        kind: "display_name",
        path: "displayName",
        operation: "updated",
        before: "Demo",
        after: "Renamed Demo",
        safety: "safe",
      }],
      blockers: [],
    });
    expect(first.afterSha256).toBe(digest(serializeWorkspaceManifest(first.afterManifest)));
  });

  it("accepts the documented block-style YAML and shell-quotes a complete apply action", () => {
    const yaml = `
schema: roll.workspace-edit/v1
workspace_id: ws-demo
expected_manifest_sha256: ${digest(serializeWorkspaceManifest(current))}
display_name: Renamed Demo
requirements:
  - provider: jira
    ref: sot-15499
repositories:
  - alias: product
    remote: https://example.test/owner/product.git
    provider: github
    integration_branch: main
    branch_pattern: roll/{workspace_id}/{story_id}
    required_checks:
      - test
`;
    const parsed = parseWorkspaceEditConfig(yaml, { workspaceId: "ws-demo" });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));

    expect(buildWorkspaceEditPlan({
      config: parsed.value,
      current,
      references: references(),
      manifestPath: "/workspace/workspace.yaml",
      configPath: "/tmp/edit configs/ws.yaml",
    }).nextAction).toEqual({
      kind: "apply",
      command: "roll workspace edit ws-demo --config '/tmp/edit configs/ws.yaml' --json",
    });
  });

  it.each([
    ["unknown authority field", { root: "/escape" }, "unknown_field"],
    ["Workspace identity mismatch", { workspace_id: "other" }, "identity_mismatch"],
    ["unsafe repository path", { repositories: [{
      alias: "product",
      remote: "file:///tmp/../escape.git",
      provider: "generic",
      integration_branch: "main",
      branch_pattern: "roll/{workspace_id}/{story_id}",
      required_checks: [],
    }] }, "unsafe_remote"],
    ["duplicate binding", { repositories: [
      {
        alias: "product",
        remote: "https://example.test/owner/product",
        provider: "github",
        integration_branch: "main",
        branch_pattern: "roll/{workspace_id}/{story_id}",
        required_checks: [],
      },
      {
        alias: "product",
        remote: "https://example.test/owner/other",
        provider: "github",
        integration_branch: "main",
        branch_pattern: "roll/{workspace_id}/{story_id}",
        required_checks: [],
      },
    ] }, "duplicate_identity"],
  ])("rejects %s before plan construction", (_name, override, code) => {
    expect(parseWorkspaceEditConfig(configText(override), { workspaceId: "ws-demo" })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });

  it("blocks referenced Requirement removal and repository identity/workflow edits without rewriting Issue facts", () => {
    const parsed = parseWorkspaceEditConfig(configText({
      requirements: [],
      repositories: [{
        alias: "renamed-product",
        remote: "https://example.test/owner/product",
        provider: "github",
        integration_branch: "release",
        branch_pattern: "feature/{workspace_id}/{story_id}",
        required_checks: ["lint"],
      }],
    }), { workspaceId: "ws-demo" });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const issue = {
      storyId: "US-EXISTING-1",
      manifestSha256: "a".repeat(64),
      requirementKeys: [{ provider: "jira", ref: "SOT-15499" }],
      repoIds: ["repo-ff7a87ddbb2b"],
    };

    const plan = buildWorkspaceEditPlan({
      config: parsed.value,
      current,
      references: references({ issues: [issue] }),
      manifestPath: "/workspace/workspace.yaml",
    });

    expect(plan.outcome).toBe("blocked");
    expect(plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "metadata_referenced", path: "requirements[jira:SOT-15499]" }),
      expect.objectContaining({ code: "metadata_referenced", path: "repositories[repo-ff7a87ddbb2b].alias" }),
      expect.objectContaining({ code: "metadata_referenced", path: "repositories[repo-ff7a87ddbb2b].integrationBranch" }),
      expect.objectContaining({ code: "metadata_referenced", path: "repositories[repo-ff7a87ddbb2b].branchPattern" }),
      expect.objectContaining({ code: "metadata_referenced", path: "repositories[repo-ff7a87ddbb2b].requiredChecks" }),
    ]));
    expect(plan.blockers.every((blocker) => blocker.references.some((entry) => entry.storyId === "US-EXISTING-1"))).toBe(true);
    expect(issue).toEqual({
      storyId: "US-EXISTING-1",
      manifestSha256: "a".repeat(64),
      requirementKeys: [{ provider: "jira", ref: "SOT-15499" }],
      repoIds: ["repo-ff7a87ddbb2b"],
    });
  });

  it("pins referenceIndexSha256 to the deterministic serialized reference inventory", () => {
    const parsed = parseWorkspaceEditConfig(configText(), { workspaceId: "ws-demo" });
    if (!parsed.ok) throw new Error("fixture must parse");
    const index = references({
      additionalFacts: [{
        kind: "event",
        authorityPath: "runtime/events.ndjson",
        sha256: "e".repeat(64),
        requirementKeys: [{ provider: "jira", ref: "SOT-15499" }],
        repoIds: ["repo-ff7a87ddbb2b"],
      }],
    });
    const plan = buildWorkspaceEditPlan({ config: parsed.value, current, references: index, manifestPath: "/workspace/workspace.yaml" });
    expect(plan.referenceIndexSha256).toBe(digest(serializeWorkspaceMetadataReferenceIndex(index)));
  });

  it("blocks Requirement deletion when immutable archive history references its normalized identity", () => {
    const parsed = parseWorkspaceEditConfig(configText({ requirements: [] }), { workspaceId: "ws-demo" });
    if (!parsed.ok) throw new Error("fixture must parse");
    const plan = buildWorkspaceEditPlan({
      config: parsed.value,
      current,
      references: references({
        requirementArchives: [{
          requirementId: "req-c78ccf14ea21",
          source: { provider: "jira", ref: "sot-15499" },
          manifestSha256: "a".repeat(64),
        }],
      }),
      manifestPath: "/workspace/workspace.yaml",
      configPath: "/tmp/edit.json",
    });
    expect(plan).toMatchObject({
      outcome: "blocked",
      beforeManifest: { requirements: [{ provider: "jira", ref: "SOT-15499" }] },
      afterManifest: { requirements: [] },
      blockers: [expect.objectContaining({
        code: "metadata_referenced",
        references: [expect.objectContaining({ kind: "requirement_archive", requirementId: "req-c78ccf14ea21" })],
      })],
      nextAction: {
        kind: "blocked",
        command: "roll workspace edit ws-demo --config /tmp/edit.json --check --json",
      },
    });
  });

  it("canonicalizes an aliased Requirement addition while preserving referenced identity semantics", () => {
    const added = normalizeRequirementSourceReference("github-issue", "Owner/Repo#12");
    const removed = normalizeRequirementSourceReference("JIRA", "sot-15499");
    if (!added.ok || !removed.ok) throw new Error("fixture Requirement identities must normalize");
    const parsed = parseWorkspaceEditConfig(configText({
      requirements: [{ provider: "github-issue", ref: "Owner/Repo#12" }],
    }), { workspaceId: "ws-demo" });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const plan = buildWorkspaceEditPlan({
      config: parsed.value,
      current,
      references: references({ issues: [{
        storyId: "US-REQUIREMENT",
        manifestSha256: "a".repeat(64),
        requirementKeys: [{ provider: "JIRA", ref: "sot-15499" }],
        repoIds: [],
      }] }),
      manifestPath: "/workspace/workspace.yaml",
    });

    expect(added.value.requirementId).toBe("req-1aed8113153b");
    expect(removed.value.requirementId).toBe("req-c78ccf14ea21");
    expect(plan.afterManifest.requirements).toEqual([{
      provider: added.value.provider,
      ref: added.value.ref,
    }]);
    expect(plan.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "requirements[github_issue:owner/repo#12]", operation: "added", safety: "safe" }),
      expect.objectContaining({ path: "requirements[jira:SOT-15499]", operation: "removed", safety: "blocked" }),
    ]));
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "metadata_referenced",
      path: "requirements[jira:SOT-15499]",
      references: [expect.objectContaining({
        kind: "issue_requirement",
        authorityPath: "issues/US-REQUIREMENT/manifest.json",
      })],
    }));
    expect(plan.warnings).toEqual([]);
  });

  it.each(["delivery", "runtime", "event", "migration"] as const)(
    "blocks Requirement deletion referenced by an additional %s authority",
    (kind) => {
      const parsed = parseWorkspaceEditConfig(configText({ requirements: [] }), { workspaceId: "ws-demo" });
      if (!parsed.ok) throw new Error("fixture must parse");
      const plan = buildWorkspaceEditPlan({
        config: parsed.value,
        current,
        references: references({
          additionalFacts: [{
            kind,
            authorityPath: `${kind}/authority.json`,
            sha256: kind.charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
            requirementKeys: [{ provider: "jira", ref: "sot-15499" }],
            repoIds: [],
          }],
        }),
        manifestPath: "/workspace/workspace.yaml",
      });
      expect(plan.blockers).toContainEqual(expect.objectContaining({
        code: "metadata_referenced",
        path: "requirements[jira:SOT-15499]",
        references: [expect.objectContaining({ kind: "additional_fact", authorityPath: `${kind}/authority.json` })],
      }));
    },
  );

  it("treats a remote change as a repoId identity replacement and blocks the referenced old identity", () => {
    const parsed = parseWorkspaceEditConfig(configText({
      repositories: [{
        alias: "product",
        remote: "https://example.test/owner/replacement",
        provider: "github",
        integration_branch: "main",
        branch_pattern: "roll/{workspace_id}/{story_id}",
        required_checks: ["test"],
      }],
    }), { workspaceId: "ws-demo" });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const plan = buildWorkspaceEditPlan({
      config: parsed.value,
      current,
      references: references({ issues: [{
        storyId: "US-IDENTITY",
        manifestSha256: "a".repeat(64),
        requirementKeys: [],
        repoIds: ["repo-ff7a87ddbb2b"],
      }] }),
      manifestPath: "/workspace/workspace.yaml",
    });
    const replacement = repositoryIdFromRemote("https://example.test/owner/replacement");
    if (!replacement.ok) throw new Error("fixture replacement remote must normalize");
    expect(plan.afterManifest.repositories[0]?.repoId).toBe(replacement.value);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "metadata_referenced",
      path: "repositories[repo-ff7a87ddbb2b].remote",
    }));
  });

  it.each([
    ["integrationBranch", { integration_branch: "release" }],
    ["branchPattern", { branch_pattern: "feature/{workspace_id}/{story_id}" }],
    ["requiredChecks", { required_checks: ["lint"] }],
  ] as const)("blocks the referenced repository %s field independently", (field, override) => {
    const parsed = parseWorkspaceEditConfig(configText({
      repositories: [{
        alias: "product",
        remote: "https://example.test/owner/product",
        provider: "github",
        integration_branch: "main",
        branch_pattern: "roll/{workspace_id}/{story_id}",
        required_checks: ["test"],
        ...override,
      }],
    }), { workspaceId: "ws-demo" });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const plan = buildWorkspaceEditPlan({
      config: parsed.value,
      current,
      references: references({ issues: [{
        storyId: "US-WORKFLOW",
        manifestSha256: "b".repeat(64),
        requirementKeys: [],
        repoIds: ["repo-ff7a87ddbb2b"],
      }] }),
      manifestPath: "/workspace/workspace.yaml",
    });
    expect(plan.changes).toContainEqual(expect.objectContaining({
      kind: "repository_workflow",
      path: `repositories[repo-ff7a87ddbb2b].${field}`,
      safety: "blocked",
    }));
    expect(plan.blockers).toContainEqual(expect.objectContaining({ path: `repositories[repo-ff7a87ddbb2b].${field}` }));
  });

  it.each(["delivery", "runtime", "event", "migration"] as const)("blocks repository identity changes referenced by %s facts", (kind) => {
    const parsed = parseWorkspaceEditConfig(configText({ repositories: [{
      alias: "product",
      remote: "https://example.test/owner/replacement",
      provider: "github",
      integration_branch: "main",
      branch_pattern: "roll/{workspace_id}/{story_id}",
      required_checks: ["test"],
    }] }), { workspaceId: "ws-demo" });
    if (!parsed.ok) throw new Error("fixture must parse");
    const plan = buildWorkspaceEditPlan({
      config: parsed.value,
      current,
      references: references({ additionalFacts: [{
        kind,
        authorityPath: `${kind}/authority.json`,
        sha256: "c".repeat(64),
        requirementKeys: [],
        repoIds: ["repo-ff7a87ddbb2b"],
      }] }),
      manifestPath: "/workspace/workspace.yaml",
    });
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      path: "repositories[repo-ff7a87ddbb2b].remote",
      references: [expect.objectContaining({ authorityPath: `${kind}/authority.json` })],
    }));
  });

  it("rejects nested unknown fields and duplicate canonical repository identities", () => {
    expect(parseWorkspaceEditConfig(configText({ repositories: [{
      alias: "product",
      remote: "https://example.test/owner/product",
      provider: "github",
      integration_branch: "main",
      branch_pattern: "roll/{workspace_id}/{story_id}",
      required_checks: ["test"],
      root: "/escape",
    }] }), { workspaceId: "ws-demo" })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "unknown_field", path: "repositories[0].root" })]),
    });
    expect(parseWorkspaceEditConfig(configText({ repositories: [
      {
        alias: "product",
        remote: "https://example.test/owner/product.git",
        provider: "github",
        integration_branch: "main",
        branch_pattern: "roll/{workspace_id}/{story_id}",
        required_checks: [],
      },
      {
        alias: "mirror",
        remote: "https://example.test/owner/product",
        provider: "github",
        integration_branch: "main",
        branch_pattern: "roll/{workspace_id}/{story_id}",
        required_checks: [],
      },
    ] }), { workspaceId: "ws-demo" })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "duplicate_identity", path: "repositories" })]),
    });
  });

  it("reports an unsupported config schema as exactly unknown_version", () => {
    expect(parseWorkspaceEditConfig(configText({ schema: "roll.workspace-edit/v2" }), { workspaceId: "ws-demo" })).toEqual({
      ok: false,
      errors: [{
        code: "unknown_version",
        path: "schema",
        message: `expected ${WORKSPACE_EDIT_CONFIG_V1}`,
      }],
    });
  });

  it("fails loud when the expected manifest digest or reference identity is not trustworthy", () => {
    const stale = parseWorkspaceEditConfig(configText({ expected_manifest_sha256: "0".repeat(64) }), { workspaceId: "ws-demo" });
    if (!stale.ok) throw new Error("fixture must parse");
    expect(buildWorkspaceEditPlan({
      config: stale.value,
      current,
      references: references(),
      manifestPath: "/workspace/workspace.yaml",
    })).toMatchObject({ outcome: "blocked", blockers: [expect.objectContaining({ code: "manifest_changed" })] });

    const invalidCurrent = { ...current, requirements: [{ provider: "unknown", ref: "opaque" }] };
    const parsed = parseWorkspaceEditConfig(configText({
      expected_manifest_sha256: digest(serializeWorkspaceManifest(invalidCurrent)),
    }), { workspaceId: "ws-demo" });
    if (!parsed.ok) throw new Error("fixture must parse");
    expect(buildWorkspaceEditPlan({
      config: parsed.value,
      current: invalidCurrent,
      references: references(),
      manifestPath: "/workspace/workspace.yaml",
    })).toMatchObject({ outcome: "blocked", blockers: [expect.objectContaining({ code: "normalization_failed" })] });
  });
});
