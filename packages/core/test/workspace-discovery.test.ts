import { describe, expect, it } from "vitest";
import {
  REQUIREMENT_HINT_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  type RequirementHintV1,
  type WorkspaceLifecycle,
} from "@roll/spec";
import {
  discoverWorkspaceForIntent,
  resolveWorkspaceTarget,
  validateResolvedTargetRequirement,
  type WorkspaceDiscoveryFactsV1,
} from "../src/index.js";

function requirement(source = "APE-234"): RequirementHintV1 {
  return {
    schema: REQUIREMENT_HINT_V1,
    sources: [{ key: { provider: "jira", ref: source }, provenance: "deterministic_extraction" }],
    storyIds: [],
    repositoryRemotes: [],
    paths: [],
  };
}

function facts(input: {
  readonly workspaceId: string;
  readonly lifecycle: WorkspaceLifecycle;
  readonly requirements?: readonly string[];
  readonly issues?: readonly string[];
  readonly remote?: string;
  readonly root?: string;
}): WorkspaceDiscoveryFactsV1 {
  const root = input.root ?? `/workspaces/${input.workspaceId}`;
  const remote = input.remote ?? `https://example.test/${input.workspaceId}/product.git`;
  return {
    candidate: {
      workspaceId: input.workspaceId,
      root,
      canonicalRoot: root,
      manifestWorkspaceId: input.workspaceId,
      pathState: "valid",
      lifecycle: input.lifecycle,
    },
    manifest: {
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId: input.workspaceId,
      displayName: input.workspaceId,
      requirements: (input.requirements ?? []).map((ref) => ({ provider: "jira", ref })),
      repositories: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: `repo-${input.workspaceId}`,
        alias: "product",
        remote,
        integrationBranch: "main",
        provider: "generic",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      }],
    },
    issues: (input.issues ?? []).map((storyId) => ({
      storyId,
      workspaceId: input.workspaceId,
      requirements: [],
    })),
  };
}

function intent(
  requirementHint: RequirementHintV1,
  operation: "read" | "mutation" = "mutation",
) {
  return {
    schema: "roll.workspace-intent/v1" as const,
    operation,
    interaction: "non_interactive" as const,
    scope: "workspace_required_mutation" as const,
    cwd: "/tmp",
    requirement: requirementHint,
  };
}

describe("US-WS-028 requirement-first Workspace discovery", () => {
  it("does not select the only active Workspace when it has no hard requirement match", () => {
    const roll = facts({ workspaceId: "roll", lifecycle: "active", requirements: ["IDEA-074"] });
    expect(discoverWorkspaceForIntent({
      intent: intent(requirement()),
      workspaces: [roll],
      diagnostics: [],
    })).toEqual({
      ok: false,
      kind: "choice_required",
      code: "requirement_match_required",
      candidates: [expect.objectContaining({ workspaceId: "roll", hardMatch: false })],
      diagnostics: [],
    });
  });

  it("selects only a unique active hard match and requires activation for registered or paused matches", () => {
    const active = facts({ workspaceId: "fields", lifecycle: "active", requirements: ["APE-234"] });
    expect(discoverWorkspaceForIntent({ intent: intent(requirement()), workspaces: [active], diagnostics: [] }))
      .toMatchObject({ ok: true, kind: "selected", target: { workspaceId: "fields", hardMatch: true } });

    for (const lifecycle of ["registered", "paused"] as const) {
      const inactive = facts({ workspaceId: `fields-${lifecycle}`, lifecycle, requirements: ["APE-234"] });
      expect(discoverWorkspaceForIntent({ intent: intent(requirement()), workspaces: [inactive], diagnostics: [] }))
        .toMatchObject({
          ok: false,
          kind: "activation_required",
          code: "workspace_activation_required",
          candidates: [{ workspaceId: `fields-${lifecycle}`, lifecycle, hardMatch: true }],
        });
    }
  });

  it("returns ambiguity for multiple hard matches without letting lifecycle or soft score break the tie", () => {
    const active = facts({
      workspaceId: "alpha",
      lifecycle: "active",
      requirements: ["APE-234"],
      root: "/tmp/alpha",
    });
    const registered = facts({ workspaceId: "beta", lifecycle: "registered", requirements: ["APE-234"] });
    const hinted = {
      ...requirement(),
      paths: [{ path: "/tmp/alpha/issues/APE-234", provenance: "cwd_repository" as const }],
      semanticTerms: ["alpha"],
    };
    expect(discoverWorkspaceForIntent({
      intent: intent(hinted),
      workspaces: [registered, active],
      diagnostics: [],
    })).toMatchObject({
      ok: false,
      kind: "conflict",
      code: "ambiguous_requirement_match",
      candidates: [
        { workspaceId: "alpha", hardMatch: true },
        { workspaceId: "beta", hardMatch: true },
      ],
    });
  });

  it("uses soft evidence only to rank choice candidates and creates only when no non-archived candidate exists", () => {
    const alpha = facts({ workspaceId: "alpha", lifecycle: "active", root: "/work/alpha" });
    const beta = facts({ workspaceId: "beta", lifecycle: "registered", root: "/work/beta" });
    const archived = facts({ workspaceId: "old", lifecycle: "archived", requirements: ["APE-234"] });
    const hinted = {
      ...requirement(),
      paths: [{ path: "/work/beta/repo", provenance: "cwd_repository" as const }],
    };
    expect(discoverWorkspaceForIntent({
      intent: intent(hinted),
      workspaces: [alpha, archived, beta],
      diagnostics: [],
    })).toMatchObject({
      ok: false,
      kind: "choice_required",
      code: "requirement_match_required",
      candidates: [
        { workspaceId: "beta", hardMatch: false },
        { workspaceId: "alpha", hardMatch: false },
      ],
    });
    expect(discoverWorkspaceForIntent({ intent: intent(requirement()), workspaces: [archived], diagnostics: [] }))
      .toEqual({ ok: false, kind: "create_required", code: "create_required", candidates: [], diagnostics: [] });
  });

  it("fails closed on incomplete non-archived discovery and never hides it behind create", () => {
    const diagnostic = {
      workspaceId: "fields",
      root: "/workspaces/fields",
      code: "invalid_workspace_manifest" as const,
      authorityPath: "/workspaces/fields/workspace.yaml",
      message: "invalid",
    };
    for (const operation of ["read", "mutation"] as const) {
      expect(discoverWorkspaceForIntent({
        intent: intent(requirement(), operation),
        workspaces: [],
        diagnostics: [diagnostic],
      })).toEqual({
        ok: false,
        kind: "conflict",
        code: "workspace_discovery_incomplete",
        candidates: [],
        diagnostics: [diagnostic],
      });
    }
  });

  it("rejects malformed hints and is deterministic for the same facts digest", () => {
    const malformed = { ...requirement(), sources: [{ key: { provider: "jira", ref: "234" }, provenance: "semantic_inference" }] } as unknown as RequirementHintV1;
    expect(discoverWorkspaceForIntent({ intent: intent(malformed), workspaces: [], diagnostics: [] }))
      .toMatchObject({ ok: false, kind: "conflict", code: "invalid_requirement_hint" });

    const input = {
      intent: intent(requirement()),
      workspaces: [
        facts({ workspaceId: "zeta", lifecycle: "active" }),
        facts({ workspaceId: "alpha", lifecycle: "registered" }),
      ],
      diagnostics: [],
    };
    expect(discoverWorkspaceForIntent(structuredClone(input))).toEqual(discoverWorkspaceForIntent(structuredClone(input)));
  });
});

describe("US-WS-028 resolved target requirement validation", () => {
  const fields = facts({ workspaceId: "fields", lifecycle: "active", requirements: ["APE-234"] });
  const roll = facts({ workspaceId: "roll", lifecycle: "active", requirements: ["IDEA-074"] });

  it("keeps an explicit hard match selected while warning about duplicate hard ownership", () => {
    const duplicate = facts({ workspaceId: "duplicate", lifecycle: "registered", requirements: ["APE-234"] });
    expect(validateResolvedTargetRequirement({
      target: fields,
      allWorkspaces: [duplicate, fields],
      requirement: requirement(),
      operation: "mutation",
    })).toMatchObject({ ok: true, state: "matched_ambiguous", evidence: expect.any(Array), warnings: [expect.any(String)] });
  });

  it("rejects explicit/env/cwd/Issue target conflicts for mutation and requires read confirmation", () => {
    expect(validateResolvedTargetRequirement({
      target: roll,
      allWorkspaces: [roll, fields],
      requirement: requirement(),
      operation: "mutation",
    })).toMatchObject({ ok: false, state: "rejected", code: "requirement_workspace_conflict", conflicts: [{ workspaceId: "fields" }] });
    expect(validateResolvedTargetRequirement({
      target: roll,
      allWorkspaces: [roll, fields],
      requirement: requirement(),
      operation: "read",
    })).toMatchObject({ ok: false, state: "confirmation_required", code: "requirement_workspace_conflict", conflicts: [{ workspaceId: "fields" }] });
  });

  it("permits an explicit target as unbound when no Workspace has exact ownership", () => {
    expect(validateResolvedTargetRequirement({
      target: roll,
      allWorkspaces: [roll],
      requirement: requirement(),
      operation: "mutation",
    })).toMatchObject({ ok: true, state: "unbound", evidence: [], warnings: [expect.any(String)] });
  });

  it.each([
    {
      source: "explicit" as const,
      targetInput: { explicit: { kind: "id" as const, workspaceId: "roll" } },
    },
    {
      source: "environment" as const,
      targetInput: { environment: { kind: "id" as const, workspaceId: "roll" } },
    },
    {
      source: "cwd_manifest" as const,
      targetInput: {
        context: {
          cwdManifest: {
            workspaceId: "roll",
            root: "/workspaces/roll",
            canonicalRoot: "/workspaces/roll",
            containment: "safe" as const,
          },
        },
      },
    },
    {
      source: "issue_manifest" as const,
      targetInput: {
        context: {
          issueManifest: {
            workspaceId: "roll",
            root: "/workspaces/roll",
            canonicalRoot: "/workspaces/roll",
            containment: "safe" as const,
          },
        },
      },
    },
  ])("routes a $source target through the same mutation/read requirement conflict validator", ({ source, targetInput }) => {
    const resolution = resolveWorkspaceTarget({
      operation: "mutation",
      registry: [roll.candidate, fields.candidate],
      ...targetInput,
    });
    expect(resolution).toMatchObject({ ok: true, source, target: { workspaceId: "roll" } });
    if (!resolution.ok || resolution.target.kind !== "workspace") return;
    const target = [roll, fields].find((candidate) => candidate.candidate.workspaceId === resolution.target.workspaceId);
    if (target === undefined) throw new Error("resolved target facts must exist");

    expect(validateResolvedTargetRequirement({
      target,
      allWorkspaces: [roll, fields],
      requirement: requirement(),
      operation: "mutation",
    })).toMatchObject({ ok: false, state: "rejected", code: "requirement_workspace_conflict" });
    expect(validateResolvedTargetRequirement({
      target,
      allWorkspaces: [roll, fields],
      requirement: requirement(),
      operation: "read",
    })).toMatchObject({ ok: false, state: "confirmation_required", code: "requirement_workspace_conflict" });
  });
});
