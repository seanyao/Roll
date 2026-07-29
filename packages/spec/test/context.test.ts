import { describe, expect, expectTypeOf, it } from "vitest";
import * as publicSpec from "../src/index.js";
import {
  CONTEXT_PROVIDER_REGISTRY_V1,
  CONTEXT_DIAGNOSTIC_CODES,
  CONTEXT_READ_REQUEST_V1,
  CONTEXT_READ_RESULT_V1,
  contextProviderRegistryV1Schema,
  contextDiagnosticV1Schema,
  contextProviderExecutionPlanV1Schema,
  contextReadRequestV1Schema,
  contextReadResultV1Schema,
  parseContextProviderRegistry,
  parseContextRef,
  parseWorkspaceContexts,
  workspaceContextsV1Schema,
  workspaceExecutionContextV1Schema,
} from "../src/types/context.js";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
} from "../src/types/workspace.js";
import type {
  ContextDiagnosticV1,
  ContextProviderExecutionPlanV1,
  ContextReadRequestV1,
  ContextReadResultV1,
  GitLlmWikiProviderConfigV1,
  RepositoryExecutionMap,
  WorkspaceContextBindingV1,
  WorkspaceExecutionContextV1,
} from "../src/index.js";

type SchemaView = {
  type?: string;
  additionalProperties?: boolean | SchemaView;
  properties?: Record<string, SchemaView>;
  items?: SchemaView;
  required?: readonly string[];
  maxLength?: number;
  pattern?: string;
  maximum?: number;
};

function registry() {
  return {
    schema: CONTEXT_PROVIDER_REGISTRY_V1,
    enabled: true,
    providers: [{
      id: "bipo-enterprise",
      type: "git_llm_wiki",
      enabled: true,
      remote: "git@GitHub.com:Bipo/company-context.git",
      branch: "main",
      fetch_timeout_seconds: 30,
    }],
  };
}

function contexts() {
  return {
    enabled: true,
    bindings: [{
      providerId: "bipo-enterprise",
      enabled: true,
      required: true,
      entrypoints: ["wiki/index.md"],
    }],
  };
}

describe("Context v1 contracts", () => {
  it("exports the complete closed v1 contract from @roll/spec", () => {
    expect(CONTEXT_PROVIDER_REGISTRY_V1).toBe("roll.context-providers/v1");
    expect(CONTEXT_READ_REQUEST_V1).toBe("roll.context-read-request/v1");
    expect(CONTEXT_READ_RESULT_V1).toBe("roll.context-read-result/v1");
    expect(publicSpec).toMatchObject({
      parseContextProviderRegistry: expect.any(Function),
      parseWorkspaceContexts: expect.any(Function),
      parseContextRef: expect.any(Function),
      contextProviderRegistryV1Schema: expect.any(Object),
      workspaceContextsV1Schema: expect.any(Object),
      contextReadRequestV1Schema: expect.any(Object),
      contextReadResultV1Schema: expect.any(Object),
      contextDiagnosticV1Schema: expect.any(Object),
      contextProviderExecutionPlanV1Schema: expect.any(Object),
      workspaceExecutionContextV1Schema: expect.any(Object),
      WORKSPACE_EXECUTION_CONTEXT_V1: "roll.workspace-execution-context/v1",
    });
  });

  it("keeps diagnostic codes in one closed persisted vocabulary", () => {
    expect(CONTEXT_DIAGNOSTIC_CODES).toEqual([
      "context_disabled", "provider_not_found", "provider_not_bound", "invalid_context_binding",
      "provider_disabled", "invalid_provider_config", "unsupported_git_transport", "remote_identity_mismatch",
      "fetch_failed", "fetch_timeout", "branch_not_found", "revision_missing", "invalid_wiki_layout",
      "invalid_context_ref", "context_file_missing", "context_symlink_rejected", "context_file_too_large",
      "context_budget_exceeded", "invalid_page_frontmatter", "scope_mismatch", "restricted_context_denied",
      "context_revision_changed", "invalid_context_snapshot", "context_lock_timeout",
    ]);
  });

  it("publishes closed schemas and keeps provider type limited to git_llm_wiki", () => {
    expect(contextProviderRegistryV1Schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        providers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { type: { const: "git_llm_wiki" } },
          },
        },
      },
    });
    expect(workspaceContextsV1Schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(contextReadRequestV1Schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(contextReadResultV1Schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("publishes deeply closed request, result, diagnostic and execution-plan schemas", () => {
    const request = contextReadRequestV1Schema as SchemaView;
    const workspace = workspaceExecutionContextV1Schema as SchemaView;
    const result = contextReadResultV1Schema as SchemaView;
    const diagnostic = contextDiagnosticV1Schema as SchemaView;
    const plan = contextProviderExecutionPlanV1Schema as SchemaView;

    expect(request.properties?.workspace).toBe(workspaceExecutionContextV1Schema);
    expect(workspace).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspace.properties?.workspace).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspace.properties?.resolution).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspace.properties?.resolution?.properties?.evidence?.items).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspace.properties?.bindings?.items).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspace.properties?.issue).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspace.properties?.issue?.properties?.execution).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspace.properties?.authorities).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspace.properties?.contexts).toBe(workspaceContextsV1Schema);

    expect(result.properties?.requestScope).toMatchObject({ type: "object", additionalProperties: false });
    expect(result.properties?.providers?.items).toMatchObject({ type: "object", additionalProperties: false });
    expect(result.properties?.providers?.items?.properties?.files?.items).toMatchObject({ type: "object", additionalProperties: false });
    expect(result.properties?.providers?.items?.properties?.files?.items?.properties?.page).toMatchObject({ type: "object", additionalProperties: false });
    expect(result.properties?.providers?.items?.properties?.warnings?.items).toBe(contextDiagnosticV1Schema);
    expect(result.properties?.gaps?.items).toBe(contextDiagnosticV1Schema);
    expect(diagnostic).toMatchObject({ type: "object", additionalProperties: false });
    expect(plan).toMatchObject({ type: "object", additionalProperties: false });
    expect(plan.properties?.provider).toMatchObject({ type: "object", additionalProperties: false });
    expect(plan.properties?.binding).toMatchObject({ type: "object", additionalProperties: false });
    for (const digestSchema of [
      result.properties?.snapshotDigest,
      result.properties?.providers?.items?.properties?.providerConfigDigest,
      result.properties?.providers?.items?.properties?.bindingDigest,
      result.properties?.providers?.items?.properties?.files?.items?.properties?.sha256,
      plan.properties?.providerConfigDigest,
      plan.properties?.bindingDigest,
    ]) {
      expect(digestSchema).toMatchObject({ type: "string", maxLength: 64, pattern: "^[0-9a-f]{64}$" });
    }
    expect((contextProviderRegistryV1Schema as SchemaView).properties?.providers?.items?.properties?.fetch_timeout_seconds)
      .toMatchObject({ maximum: 300 });
  });

  it("binds Context requests to the complete versioned Workspace authority contract", () => {
    const execution: WorkspaceExecutionContextV1 = {
      schema: WORKSPACE_EXECUTION_CONTEXT_V1,
      workspace: {
        workspaceId: "roll",
        root: "/workspaces/roll",
        canonicalRoot: "/real/workspaces/roll",
        lifecycle: "active",
      },
      resolution: {
        source: "requirement_discovery",
        evidence: [{ kind: "requirement_source_exact", value: "jira:APE-234", hard: true, score: 100 }],
      },
      bindings: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: "repo-8d325f3875d5",
        alias: "product",
        remote: "https://github.com/Owner/Repo",
        integrationBranch: "main",
        provider: "github",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: ["test"] },
      }],
      contexts: contexts(),
      issue: {
        storyId: "US-CONTEXT-001",
        manifestPath: "/workspaces/roll/issues/US-CONTEXT-001/manifest.json",
        execution: {
          workspaceId: "roll",
          issueRoot: "/workspaces/roll/issues/US-CONTEXT-001",
          repositories: {
            "repo-8d325f3875d5": {
              repoId: "repo-8d325f3875d5",
              alias: "product",
              access: "write",
              requiredDelivery: true,
              noChangePolicy: "changes_required",
              worktreePath: "/workspaces/roll/issues/US-CONTEXT-001/product",
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              commands: { test: ["pnpm test"], integration: ["pnpm test:e2e"] },
            },
          },
        },
      },
      authorities: {
        backlog: "/workspaces/roll/backlog",
        features: "/workspaces/roll/features",
        design: "/workspaces/roll/design",
        requirements: "/workspaces/roll/requirements",
        policy: "/workspaces/roll/policy",
        evidence: "/workspaces/roll/evidence",
        toolDumps: "/workspaces/roll/tool-dumps",
        events: "/workspaces/roll/events",
        runtime: "/workspaces/roll/runtime",
        locks: "/workspaces/roll/locks",
      },
    };
    const request: ContextReadRequestV1 = {
      schema: CONTEXT_READ_REQUEST_V1,
      workspace: execution,
      stage: "build",
      refs: [],
    };
    expectTypeOf(request.workspace).toEqualTypeOf<WorkspaceExecutionContextV1>();
    expectTypeOf(request.workspace.issue?.execution.repositories).toEqualTypeOf<RepositoryExecutionMap | undefined>();
    expectTypeOf<ContextReadResultV1["gaps"][number]>().toEqualTypeOf<ContextDiagnosticV1>();
    expectTypeOf<ContextProviderExecutionPlanV1["provider"]>().toEqualTypeOf<GitLlmWikiProviderConfigV1>();
    expectTypeOf<ContextProviderExecutionPlanV1["binding"]>().toEqualTypeOf<WorkspaceContextBindingV1>();
    expect(request.workspace.contexts).toEqual(contexts());
    expect(request.workspace.authorities.runtime).toBe("/workspaces/roll/runtime");
  });

  it("parses a registry and preserves a validated SSH fetch endpoint", () => {
    expect(parseContextProviderRegistry(registry())).toEqual({
      ok: true,
      value: {
        ...registry(),
        providers: [{ ...registry().providers[0], remote: "ssh://git@github.com/Bipo/company-context" }],
      },
    });
  });

  it.each([
    ["provider type", { ...registry().providers[0], type: "mcp" }, "providers[0].type"],
    ["provider id", { ...registry().providers[0], id: "Bipo_Context" }, "providers[0].id"],
    ["short timeout", { ...registry().providers[0], fetch_timeout_seconds: 4 }, "providers[0].fetch_timeout_seconds"],
    ["long timeout", { ...registry().providers[0], fetch_timeout_seconds: 301 }, "providers[0].fetch_timeout_seconds"],
    ["option branch", { ...registry().providers[0], branch: "--upload-pack=evil" }, "providers[0].branch"],
    ["refspec branch", { ...registry().providers[0], branch: "refs/heads/main:refs/heads/x" }, "providers[0].branch"],
    ["uppercase SHA-1 branch", { ...registry().providers[0], branch: "A".repeat(40) }, "providers[0].branch"],
    ["SHA-256 branch", { ...registry().providers[0], branch: "b".repeat(64) }, "providers[0].branch"],
  ])("rejects invalid %s", (_label, provider, path) => {
    const parsed = parseContextProviderRegistry({ ...registry(), providers: [provider] });
    expect(parsed).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path })]),
    });
  });

  it("normalizes disabled registries and Workspace contexts without validating dormant values", () => {
    expect(parseContextProviderRegistry({
      ...registry(),
      enabled: false,
      providers: [{ ...registry().providers[0], remote: "file:///stale", branch: "A".repeat(40) }],
    })).toEqual({
      ok: true,
      value: { schema: CONTEXT_PROVIDER_REGISTRY_V1, enabled: false, providers: [] },
    });
    expect(parseWorkspaceContexts({
      enabled: false,
      bindings: [{ providerId: "OLD", enabled: false, required: true, entrypoints: ["../stale"] }],
    })).toEqual({ ok: true, value: { enabled: false, bindings: [] } });
  });

  it("keeps disabled configuration closed and rejects dormant secret fields without echoing values", () => {
    const registryResult = parseContextProviderRegistry({
      ...registry(),
      enabled: false,
      providers: [{ ...registry().providers[0], credential: "disabled-secret-sentinel" }],
    });
    const contextsResult = parseWorkspaceContexts({
      enabled: false,
      bindings: [{ ...contexts().bindings[0], cachePath: "disabled-secret-sentinel" }],
    });
    expect(registryResult).toMatchObject({ ok: false, errors: [expect.objectContaining({ path: "providers[0].credential" })] });
    expect(contextsResult).toMatchObject({ ok: false, errors: [expect.objectContaining({ path: "contexts.bindings[0].cachePath" })] });
    expect(JSON.stringify([registryResult, contextsResult])).not.toContain("disabled-secret-sentinel");
  });

  it.each([
    "https://token@example.com/Bipo/company-context.git",
    "http://example.com/Bipo/company-context.git",
    "git://example.com/Bipo/company-context.git",
    "file:///tmp/company-context.git",
    "../company-context.git",
    "ext::sh -c evil",
    "helper::company-context",
    "https://example..com/Bipo/company-context.git",
    "https://-example.com/Bipo/company-context.git",
  ])("rejects unsupported or credential-bearing provider remotes without echoing them: %s", (remote) => {
    const parsed = parseContextProviderRegistry({
      ...registry(),
      providers: [{ ...registry().providers[0], remote }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_value", path: "providers[0].remote" }),
    ]));
    expect(JSON.stringify(parsed.errors)).not.toContain(remote);
    expect(JSON.stringify(parsed.errors)).not.toContain("token");
  });

  it("rejects duplicate provider ids without merging configs", () => {
    const parsed = parseContextProviderRegistry({
      ...registry(),
      providers: [registry().providers[0], { ...registry().providers[0], branch: "release" }],
    });
    expect(parsed).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_identity", path: "providers[1].id" }),
      ]),
    });
  });

  it("parses Workspace bindings without machine credentials or cache paths", () => {
    expect(parseWorkspaceContexts(contexts())).toEqual({ ok: true, value: contexts() });
    expect(parseWorkspaceContexts({ ...contexts(), credential: "secret" })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "unknown_field", path: "contexts.credential" })]),
    });
    expect(parseWorkspaceContexts({
      ...contexts(),
      bindings: [{ ...contexts().bindings[0], cachePath: "/tmp/cache" }],
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "unknown_field", path: "contexts.bindings[0].cachePath" }),
      ]),
    });
  });

  it.each([
    ["required disabled", [{ ...contexts().bindings[0], enabled: false }], "contexts.bindings[0]"],
    ["unsafe entrypoint", [{ ...contexts().bindings[0], entrypoints: ["../wiki/index.md"] }], "contexts.bindings[0].entrypoints[0]"],
    ["hidden entrypoint", [{ ...contexts().bindings[0], entrypoints: ["wiki/.private.md"] }], "contexts.bindings[0].entrypoints[0]"],
    ["reserved root", [{ ...contexts().bindings[0], entrypoints: ["purpose.md"] }], "contexts.bindings[0].entrypoints[0]"],
    ["duplicate binding", [contexts().bindings[0], { ...contexts().bindings[0], required: false }], "contexts.bindings[1].providerId"],
  ])("rejects invalid Context binding: %s", (_label, bindings, path) => {
    expect(parseWorkspaceContexts({ enabled: true, bindings })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_value", path }),
      ]),
    });
  });

  it("deduplicates normalized entrypoints while preserving first occurrence order", () => {
    expect(parseWorkspaceContexts({
      enabled: true,
      bindings: [{
        ...contexts().bindings[0],
        entrypoints: ["wiki/index.md", "wiki/systems/axis.md", "wiki/index.md"],
      }],
    })).toMatchObject({
      ok: true,
      value: {
        bindings: [{ entrypoints: ["wiki/index.md", "wiki/systems/axis.md"] }],
      },
    });
  });
});

describe("Canonical Context refs", () => {
  it.each([
    ["context://bipo-enterprise/wiki/systems/axis.md", "bipo-enterprise", "wiki/systems/axis.md"],
  ])("parses %s", (ref, providerId, path) => {
    expect(parseContextRef(ref)).toEqual({ ok: true, value: { ref, providerId, path } });
  });

  it.each([
    "ape-context:wiki/index.md",
    "context://Bipo/wiki/index.md",
    "context://bipo-enterprise/../wiki/index.md",
    "context://bipo-enterprise/wiki//index.md",
    "context://bipo-enterprise/wiki/.private.md",
    "context://bipo-enterprise/.git/config",
    "context://bipo-enterprise/.llm-wiki/state.json",
    "context://bipo-enterprise/.obsidian/config",
    "context://bipo-enterprise/raw/sources/source.md",
    "context://bipo-enterprise/-danger",
    "context://bipo-enterprise/wiki/index.md?ref=main",
    "context://bipo-enterprise/wiki/%2e%2e/secrets.md",
    "context://bipo-enterprise/purpose.md",
    "context://bipo-enterprise/schema.md",
  ])("rejects unsafe or non-canonical ref %s", (ref) => {
    expect(parseContextRef(ref)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "invalid_value", path: "ref" })]),
    });
  });
});
