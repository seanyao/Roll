import { describe, expect, it } from "vitest";
import {
  REQUIREMENT_HINT_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_INTENT_V1,
  WORKSPACE_MANIFEST_V1,
  type RequirementHintV1,
  type WorkspaceClarificationReason,
  type WorkspaceIntentV1,
  type WorkspaceLifecycle,
  type WorkspaceMatchCandidateV1,
} from "@roll/spec";
import {
  buildWorkspaceClarificationHandoff,
  resolveWorkspaceClarificationAnswer,
  type WorkspaceDiscoveryFactsV1,
} from "../src/index.js";

function requirement(): RequirementHintV1 {
  return {
    schema: REQUIREMENT_HINT_V1,
    sources: [{ key: { provider: "jira", ref: "APE-234" }, provenance: "deterministic_extraction" }],
    storyIds: [{ storyId: "US-FIELDS-1", provenance: "explicit_user" }],
    repositoryRemotes: [],
    paths: [],
    semanticTerms: ["fields"],
  };
}

function intent(operation: "read" | "mutation"): WorkspaceIntentV1 {
  return {
    schema: WORKSPACE_INTENT_V1,
    operation,
    interaction: "interactive",
    scope: operation === "read" ? "workspace_required_read" : "workspace_required_mutation",
    cwd: "/tmp",
    requirement: requirement(),
  };
}

function facts(workspaceId: string, lifecycle: WorkspaceLifecycle): WorkspaceDiscoveryFactsV1 {
  return {
    candidate: {
      workspaceId,
      root: `/workspaces/${workspaceId}`,
      canonicalRoot: `/workspaces/${workspaceId}`,
      manifestWorkspaceId: workspaceId,
      pathState: "valid",
      lifecycle,
    },
    manifest: {
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId,
      displayName: `${workspaceId} delivery`,
      requirements: [{ provider: "jira", ref: workspaceId === "fields" ? "APE-234" : "IDEA-074" }],
      repositories: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: `repo-${workspaceId}`,
        alias: "product",
        remote: `https://example.test/${workspaceId}/product.git`,
        integrationBranch: "main",
        provider: "generic",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      }],
    },
    issues: [],
  };
}

function candidate(workspaceId: string, lifecycle: WorkspaceLifecycle): WorkspaceMatchCandidateV1 {
  return {
    workspaceId,
    root: `/workspaces/${workspaceId}`,
    lifecycle,
    hardMatch: workspaceId === "fields",
    score: workspaceId === "fields" ? 100 : 0,
    evidence: workspaceId === "fields"
      ? [{
          kind: "requirement_source_exact",
          value: "jira:APE-234",
          hard: true,
          score: 100,
          source: "jira:APE-234",
          provenance: "deterministic_extraction",
          detail: "exact requirement source",
        }]
      : [],
  };
}

const SHA = "a".repeat(64);

function handoff(input: {
  readonly reason?: WorkspaceClarificationReason;
  readonly operation?: "read" | "mutation";
  readonly lifecycle?: WorkspaceLifecycle;
  readonly candidates?: readonly WorkspaceMatchCandidateV1[];
  readonly diagnostics?: readonly {
    readonly workspaceId: string;
    readonly root: string;
    readonly code: "invalid_workspace_manifest";
    readonly authorityPath: string;
    readonly message: string;
  }[];
} = {}) {
  const candidates = input.candidates ?? [candidate("fields", input.lifecycle ?? "active")];
  return buildWorkspaceClarificationHandoff({
    intent: intent(input.operation ?? "mutation"),
    reason: input.reason ?? "workspace_activation_required",
    candidates,
    diagnostics: input.diagnostics ?? [],
    facts: [facts("fields", input.lifecycle ?? "active"), facts("roll", "active")],
    registryRevision: 7,
    discoveryFactsSha256: SHA,
  });
}

const ACTION_MATRIX = [
  { reason: "requirement_match_required", operation: "read", candidates: [candidate("roll", "active")], expected: ["select_existing", "create_new"] },
  { reason: "requirement_match_required", operation: "read", candidates: [], expected: ["create_new"] },
  { reason: "requirement_match_required", operation: "mutation", candidates: [candidate("roll", "active")], expected: ["select_existing", "create_new"] },
  { reason: "requirement_match_required", operation: "mutation", candidates: [], expected: ["create_new"] },
  { reason: "ambiguous_requirement_match", operation: "read", candidates: [candidate("fields", "active")], expected: ["select_existing"] },
  { reason: "ambiguous_requirement_match", operation: "mutation", candidates: [candidate("fields", "active")], expected: ["select_existing"] },
  { reason: "requirement_workspace_conflict", operation: "read", candidates: [candidate("fields", "active")], expected: ["select_existing"] },
  { reason: "requirement_workspace_conflict", operation: "mutation", candidates: [candidate("fields", "active")], expected: ["select_existing"] },
  { reason: "workspace_activation_required", operation: "read", candidates: [candidate("fields", "registered")], expected: ["select_existing"] },
  { reason: "workspace_activation_required", operation: "mutation", candidates: [candidate("fields", "paused")], expected: ["select_existing"] },
  { reason: "create_required", operation: "read", candidates: [], expected: ["create_new"] },
  { reason: "create_required", operation: "mutation", candidates: [], expected: ["create_new"] },
  { reason: "workspace_discovery_incomplete", operation: "read", candidates: [candidate("fields", "registered")], expected: ["select_existing", "repair_discovery"] },
  { reason: "workspace_discovery_incomplete", operation: "mutation", candidates: [candidate("fields", "registered")], expected: ["repair_discovery"] },
] as const;

describe("US-WS-029 Workspace clarification handoff", () => {
  it("covers all fourteen reason, operation, and candidate-presence matrix cells", () => {
    expect(ACTION_MATRIX).toHaveLength(14);
  });

  it.each(ACTION_MATRIX)("narrows $reason for $operation", ({ reason, operation, candidates, expected }) => {
    const diagnostic = reason === "workspace_discovery_incomplete"
      ? [{
          workspaceId: "fields",
          root: "/workspaces/fields",
          code: "invalid_workspace_manifest" as const,
          authorityPath: "/workspaces/fields/workspace.yaml",
          message: "invalid manifest",
        }]
      : [];
    const handoff = buildWorkspaceClarificationHandoff({
      intent: intent(operation),
      reason: reason as WorkspaceClarificationReason,
      candidates,
      diagnostics: diagnostic,
      facts: [facts("fields", candidates[0]?.lifecycle ?? "active"), facts("roll", "active")],
      registryRevision: 7,
      discoveryFactsSha256: SHA,
    });

    expect(handoff).toMatchObject({
      schema: "roll.workspace-clarification/v1",
      registryRevision: 7,
      discoveryFactsSha256: SHA,
      reason,
      operation,
      requirementSummary: {
        sources: [{ provider: "jira", ref: "APE-234" }],
        storyIds: ["US-FIELDS-1"],
        hasSemanticOnlyEvidence: false,
      },
      allowedActions: expected,
      canonicalCreateCommand: "roll workspace create",
    });
    expect(handoff.candidates).toEqual(candidates.map((entry) => expect.objectContaining({
      workspaceId: entry.workspaceId,
      lifecycle: entry.lifecycle,
      canonicalSelector: `--workspace ${entry.workspaceId}`,
    })));
    expect(handoff.canonicalRepairCommands).toEqual(
      reason === "workspace_discovery_incomplete" ? ["roll workspace doctor fields --json"] : [],
    );
  });

  it("fails closed when repair is allowed but no safe canonical repair command exists", () => {
    expect(() => buildWorkspaceClarificationHandoff({
      intent: intent("mutation"),
      reason: "workspace_discovery_incomplete",
      candidates: [],
      diagnostics: [{
        workspaceId: "<registry>",
        root: "/roll-home",
        code: "discovery_io_failure",
        authorityPath: "/roll-home/workspaces.json",
        message: "registry unavailable",
      }],
      facts: [],
      registryRevision: 0,
      discoveryFactsSha256: SHA,
    })).toThrowError("invalid_workspace_clarification: repair action has no canonical command");
  });
});

describe("US-WS-029 Workspace clarification answer", () => {
  it.each(["registered", "paused"] as const)("turns a %s selection into explicit re-resolution only", (lifecycle) => {
    const input = handoff({ lifecycle });
    expect(resolveWorkspaceClarificationAnswer({
      handoff: input,
      answer: { action: "select_existing", workspaceId: "fields" },
      currentRegistryRevision: 7,
      currentDiscoveryFactsSha256: SHA,
    })).toEqual({
      ok: true,
      action: "retry_resolution",
      explicitSelector: { kind: "id", workspaceId: "fields" },
      canonicalSelector: "--workspace fields",
    });
  });

  it("starts create preview preparation without granting apply authorization", () => {
    const input = handoff({ reason: "create_required", candidates: [] });
    const first = resolveWorkspaceClarificationAnswer({
      handoff: input,
      answer: { action: "create_new", workspaceId: "ws-ape-234" },
      currentRegistryRevision: 7,
      currentDiscoveryFactsSha256: SHA,
    });
    expect(first).toEqual({
      ok: true,
      action: "start_create_preview",
      requestedWorkspaceId: "ws-ape-234",
      canonicalCommand: "roll workspace create",
      applyAuthorized: false,
    });
    expect(resolveWorkspaceClarificationAnswer({
      handoff: input,
      answer: { action: "create_new", workspaceId: "ws-ape-234" },
      currentRegistryRevision: 7,
      currentDiscoveryFactsSha256: SHA,
    })).toEqual(first);
  });

  it("returns only canonical repair commands", () => {
    const diagnostic = {
      workspaceId: "fields",
      root: "/workspaces/fields",
      code: "invalid_workspace_manifest" as const,
      authorityPath: "/workspaces/fields/workspace.yaml",
      message: "invalid manifest",
    };
    const input = handoff({
      reason: "workspace_discovery_incomplete",
      operation: "mutation",
      diagnostics: [diagnostic],
    });
    expect(resolveWorkspaceClarificationAnswer({
      handoff: input,
      answer: { action: "repair_discovery" },
      currentRegistryRevision: 7,
      currentDiscoveryFactsSha256: SHA,
    })).toEqual({
      ok: true,
      action: "show_repair_actions",
      commands: ["roll workspace doctor fields --json"],
    });
  });

  it.each([
    {
      name: "stale registry revision",
      answer: { action: "select_existing", workspaceId: "fields" },
      revision: 8,
      digest: SHA,
    },
    {
      name: "stale discovery digest",
      answer: { action: "select_existing", workspaceId: "fields" },
      revision: 7,
      digest: "b".repeat(64),
    },
    {
      name: "Workspace outside candidates",
      answer: { action: "select_existing", workspaceId: "roll" },
      revision: 7,
      digest: SHA,
    },
    {
      name: "action outside allowedActions",
      answer: { action: "create_new" },
      revision: 7,
      digest: SHA,
    },
    {
      name: "open answer shape",
      answer: { action: "select_existing", workspaceId: "fields", apply: true },
      revision: 7,
      digest: SHA,
    },
    {
      name: "unsafe requested Workspace ID",
      answer: { action: "create_new", workspaceId: "../escape" },
      revision: 7,
      digest: SHA,
      create: true,
    },
  ])("rejects $name and requires candidate reload", ({ answer, revision, digest, create }) => {
    const input = create === true
      ? handoff({ reason: "create_required", candidates: [] })
      : handoff();
    expect(resolveWorkspaceClarificationAnswer({
      handoff: input,
      answer: answer as never,
      currentRegistryRevision: revision,
      currentDiscoveryFactsSha256: digest,
    })).toEqual({
      ok: false,
      code: "invalid_workspace_clarification",
      reload: true,
    });
  });

  it("rejects an open handoff shape instead of trusting extra host fields", () => {
    const input = { ...handoff(), applyAuthorized: true };
    expect(resolveWorkspaceClarificationAnswer({
      handoff: input,
      answer: { action: "select_existing", workspaceId: "fields" },
      currentRegistryRevision: 7,
      currentDiscoveryFactsSha256: SHA,
    })).toEqual({ ok: false, code: "invalid_workspace_clarification", reload: true });

    const malformed = { ...handoff(), candidates: { fields: true } };
    expect(resolveWorkspaceClarificationAnswer({
      handoff: malformed as never,
      answer: { action: "select_existing", workspaceId: "fields" },
      currentRegistryRevision: 7,
      currentDiscoveryFactsSha256: SHA,
    })).toEqual({ ok: false, code: "invalid_workspace_clarification", reload: true });
  });

  it.each([
    { field: "reason", value: "unknown_reason" },
    { field: "operation", value: "delete" },
    { field: "allowedActions", value: ["activate"] },
    { field: "candidateLifecycle", value: "archived" },
    { field: "diagnosticCode", value: "unknown_diagnostic" },
    { field: "evidenceKind", value: "fuzzy_guess" },
    { field: "evidenceProvenance", value: "magic" },
  ])("rejects malformed $field enum without throwing", ({ field, value }) => {
    const original = handoff();
    const candidate = original.candidates[0]!;
    const evidence = candidate.evidence[0]!;
    const diagnostic = {
      workspaceId: "fields",
      root: "/workspaces/fields",
      code: "invalid_workspace_manifest",
      authorityPath: "/workspaces/fields/workspace.yaml",
      message: "invalid",
    };
    const malformed: Record<string, unknown> = structuredClone(original) as unknown as Record<string, unknown>;
    if (field === "reason" || field === "operation" || field === "allowedActions") malformed[field] = value;
    if (field === "candidateLifecycle") {
      malformed["candidates"] = [{ ...candidate, lifecycle: value }];
    }
    if (field === "diagnosticCode") {
      malformed["candidates"] = [{ ...candidate, diagnostics: [{ ...diagnostic, code: value }] }];
    }
    if (field === "evidenceKind") {
      malformed["candidates"] = [{ ...candidate, evidence: [{ ...evidence, kind: value }] }];
    }
    if (field === "evidenceProvenance") {
      malformed["candidates"] = [{ ...candidate, evidence: [{ ...evidence, provenance: value }] }];
    }

    expect(() => resolveWorkspaceClarificationAnswer({
      handoff: malformed as never,
      answer: { action: "select_existing", workspaceId: "fields" },
      currentRegistryRevision: 7,
      currentDiscoveryFactsSha256: SHA,
    })).not.toThrow();
    expect(resolveWorkspaceClarificationAnswer({
      handoff: malformed as never,
      answer: { action: "select_existing", workspaceId: "fields" },
      currentRegistryRevision: 7,
      currentDiscoveryFactsSha256: SHA,
    })).toEqual({ ok: false, code: "invalid_workspace_clarification", reload: true });
  });
});
