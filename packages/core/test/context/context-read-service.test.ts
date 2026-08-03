import {
  CONTEXT_PAGE_V1,
  CONTEXT_PROVIDER_REGISTRY_V1,
  CONTEXT_READ_REQUEST_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  type ContextPageMetadataV1,
  type ContextProviderRegistryV1,
  type ContextReadFileV1,
  type ContextReadRequestV1,
  type RepositoryBinding,
  type WorkspaceContextBindingV1,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { describe, expect, it, vi } from "vitest";
import {
  createContextReadService,
  type ContextProviderReadAdapter,
  type ContextProviderReadSuccessV1,
} from "../../src/context/read-service.js";
import { LLM_WIKI_MAX_PAGES } from "../../src/context/llm-wiki-validator.js";

function repository(remote: string, index = 0): RepositoryBinding {
  return {
    schema: REPOSITORY_BINDING_V1,
    repoId: `repo-${index}`,
    alias: `repo-${index}`,
    remote,
    integrationBranch: "main",
    provider: "github",
    workflow: { branchPattern: "roll/{workspaceId}/{storyId}", requiredChecks: [] },
  };
}

function contextBinding(overrides: Partial<WorkspaceContextBindingV1> = {}): WorkspaceContextBindingV1 {
  return {
    providerId: "enterprise-wiki",
    enabled: true,
    required: true,
    entrypoints: ["wiki/index.md", "wiki/overview.md"],
    ...overrides,
  };
}

function workspace(bindings: readonly WorkspaceContextBindingV1[] = [contextBinding()]): WorkspaceExecutionContextV1 {
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: {
      workspaceId: "roll",
      root: "/workspace/roll",
      canonicalRoot: "/workspace/roll",
      lifecycle: "active",
    },
    resolution: { source: "explicit", evidence: [] },
    bindings: [repository("https://github.com/seanyao/roll.git")],
    contexts: { enabled: true, bindings },
    authorities: {
      backlog: "/workspace/roll/backlog",
      features: "/workspace/roll/features",
      design: "/workspace/roll/design",
      requirements: "/workspace/roll/requirements",
      policy: "/workspace/roll/policy.yaml",
      evidence: "/workspace/roll/evidence",
      toolDumps: "/workspace/roll/tool-dumps",
      events: "/workspace/roll/events",
      runtime: "/workspace/roll/runtime",
      locks: "/workspace/roll/locks",
    },
  };
}

function registry(): ContextProviderRegistryV1 {
  return {
    schema: CONTEXT_PROVIDER_REGISTRY_V1,
    enabled: true,
    providers: [{
      id: "enterprise-wiki",
      type: "git_llm_wiki",
      enabled: true,
      remote: "https://github.com/bipo/context-wiki.git",
      branch: "main",
      fetch_timeout_seconds: 30,
    }],
  };
}

function providerConfig(id: string) {
  return {
    id,
    type: "git_llm_wiki" as const,
    enabled: true,
    remote: `https://example.test/team/${id}`,
    branch: "main",
    fetch_timeout_seconds: 30,
  };
}

function request(overrides: Partial<ContextReadRequestV1> = {}): ContextReadRequestV1 {
  return {
    schema: CONTEXT_READ_REQUEST_V1,
    workspace: workspace(),
    storyId: "US-CONTEXT-005",
    stage: "build",
    environmentIds: ["sit"],
    refs: ["context://enterprise-wiki/wiki/systems/axis.md"],
    ...overrides,
  };
}

function metadata(overrides: Partial<ContextPageMetadataV1> = {}): ContextPageMetadataV1 {
  return {
    schema: CONTEXT_PAGE_V1,
    title: "Axis system",
    page_type: "system_runbook",
    status: "active",
    confidence: "approved",
    updated_at: "2026-07-24",
    scope: { workspace_ids: ["roll"], environment_ids: ["sit"], stages: ["build"] },
    sources: ["raw/sources/axis.md"],
    sensitivity: "internal",
    ...overrides,
  };
}

function file(path: string, page?: ContextPageMetadataV1): ContextReadFileV1 {
  const content = page === undefined ? `# ${path}\n` : `---\nschema: ${CONTEXT_PAGE_V1}\n---\n# ${path}\n`;
  return {
    ref: `context://enterprise-wiki/${path}`,
    path,
    sha256: "a".repeat(64),
    bytes: Buffer.byteLength(content),
    ...(page === undefined ? {} : { page }),
    content,
  };
}

function success(paths: readonly string[]): ContextProviderReadSuccessV1 {
  return {
    ok: true,
    revision: {
      providerId: "enterprise-wiki",
      remoteIdentity: "https://github.com/bipo/context-wiki",
      branch: "main",
      fetchedAt: "2026-07-24T05:00:00.000Z",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
    files: paths.map((path) => file(path, path === "wiki/overview.md" || path === "wiki/systems/axis.md" ? metadata() : undefined)),
    warnings: [],
  };
}

function providerSuccess(providerId: string, paths: readonly string[], page?: ContextPageMetadataV1): ContextProviderReadSuccessV1 {
  return {
    ok: true,
    revision: {
      providerId,
      remoteIdentity: `https://example.test/team/${providerId}`,
      branch: "main",
      fetchedAt: "2026-07-24T05:00:00.000Z",
      revision: providerId === "required-wiki"
        ? "1111111111111111111111111111111111111111"
        : "2222222222222222222222222222222222222222",
    },
    files: paths.map((path) => ({
      ...file(path, path.startsWith("wiki/systems/") ? page : undefined),
      ref: `context://${providerId}/${path}`,
    })),
    warnings: [],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ContextReadService", () => {
  it("compiles every plan before effects and blocks all Provider reads on one invalid explicit ref", async () => {
    const adapter: ContextProviderReadAdapter = { read: vi.fn() };
    const service = createContextReadService({ registry: registry(), adapter });

    const result = await service.read(request({ refs: ["not-a-context-ref"] }));

    expect(result).toMatchObject({ outcome: "blocked", providers: [] });
    expect(result.gaps).toEqual([expect.objectContaining({ code: "invalid_context_ref", severity: "blocking" })]);
    expect(adapter.read).not.toHaveBeenCalled();
  });

  it("reads reserved pages, current entrypoints and explicit refs once at one revision", async () => {
    const paths = [
      "purpose.md",
      "schema.md",
      "wiki/index.md",
      "wiki/log.md",
      "wiki/overview.md",
      "wiki/systems/axis.md",
    ];
    const adapter: ContextProviderReadAdapter = {
      read: vi.fn(async (input) => {
        expect(input.paths).toEqual(paths);
        return success(paths);
      }),
    };
    const service = createContextReadService({
      registry: registry(),
      adapter,
      now: () => Date.parse("2026-07-24T05:01:02.003Z"),
      authorizeRestrictedReference: () => true,
    });

    const result = await service.read(request());

    expect(adapter.read).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("completed");
    expect(result.requestScope).toEqual({
      workspaceId: "roll",
      storyId: "US-CONTEXT-005",
      repositoryIds: ["https://github.com/seanyao/roll"],
      environmentIds: ["sit"],
      stage: "build",
    });
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({
      providerId: "enterprise-wiki",
      remoteIdentity: "https://github.com/bipo/context-wiki",
      revision: "0123456789abcdef0123456789abcdef01234567",
      files: paths.map((path) => expect.objectContaining({ path })),
    });
    expect(result.providers[0]?.files.at(-1)).toMatchObject({
      page: metadata(),
      matchedScope: { workspace_ids: ["roll"], environment_ids: ["sit"], stages: ["build"] },
    });
    expect(result.snapshotDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.snapshotId).toMatch(/^ctx_20260724T050102003Z_[0-9a-f]{12}$/u);
    expect(result.artifactPath).toBe(`/workspace/roll/runtime/context/US-CONTEXT-005/${result.snapshotId}.json`);
  });

  it("returns disabled without Provider effects when machine or Workspace Context is disabled", async () => {
    const adapter: ContextProviderReadAdapter = { read: vi.fn() };
    const machineDisabled = createContextReadService({ registry: { ...registry(), enabled: false }, adapter });
    const workspaceDisabled = createContextReadService({ registry: registry(), adapter });

    await expect(machineDisabled.read(request())).resolves.toMatchObject({ outcome: "disabled", providers: [] });
    await expect(workspaceDisabled.read(request({
      workspace: { ...workspace(), contexts: { enabled: false, bindings: [] } },
    }))).resolves.toMatchObject({ outcome: "disabled", providers: [] });
    expect(adapter.read).not.toHaveBeenCalled();
  });

  it("reads required layout and entrypoints without explicit refs and stays deterministic for a fixed clock", async () => {
    const expectedPaths = ["purpose.md", "schema.md", "wiki/index.md", "wiki/log.md", "wiki/overview.md"];
    const adapter: ContextProviderReadAdapter = {
      read: vi.fn(async (input) => {
        expect(input.refs).toEqual([]);
        expect(input.paths).toEqual(expectedPaths);
        return success(expectedPaths);
      }),
    };
    const service = createContextReadService({
      registry: registry(),
      adapter,
      now: () => Date.parse("2026-07-24T05:01:02.003Z"),
    });
    const noRefs = request({ refs: [] });

    const first = await service.read(noRefs);
    const second = await service.read(noRefs);

    expect(adapter.read).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });

  it("runs Providers concurrently but preserves execution-plan order in snapshots", async () => {
    const bindings = [
      contextBinding({ providerId: "required-wiki", entrypoints: ["wiki/index.md"] }),
      contextBinding({ providerId: "optional-wiki", required: false, entrypoints: ["wiki/index.md"] }),
    ];
    let active = 0;
    let maxActive = 0;
    const adapter: ContextProviderReadAdapter = {
      read: vi.fn(async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(input.plan.provider.id === "required-wiki" ? 20 : 5);
        active -= 1;
        return providerSuccess(input.plan.provider.id, input.paths);
      }),
    };
    const service = createContextReadService({
      registry: {
        schema: CONTEXT_PROVIDER_REGISTRY_V1,
        enabled: true,
        providers: [providerConfig("optional-wiki"), providerConfig("required-wiki")],
      },
      adapter,
    });

    const result = await service.read(request({ workspace: workspace(bindings), refs: [] }));

    expect(maxActive).toBe(2);
    expect(result.outcome).toBe("completed");
    expect(result.providers.map((provider) => provider.providerId)).toEqual(["required-wiki", "optional-wiki"]);
  });

  it("blocks every Provider before effects when one required plan exceeds the page budget", async () => {
    const adapter: ContextProviderReadAdapter = { read: vi.fn() };
    const refs = Array.from(
      { length: LLM_WIKI_MAX_PAGES - 3 },
      (_, index) => `context://required-wiki/wiki/pages/page-${index}.md`,
    );
    const bindings = [
      contextBinding({ providerId: "healthy-wiki", entrypoints: ["wiki/index.md"] }),
      contextBinding({ providerId: "required-wiki", entrypoints: ["wiki/index.md"] }),
    ];
    const service = createContextReadService({
      registry: {
        schema: CONTEXT_PROVIDER_REGISTRY_V1,
        enabled: true,
        providers: [providerConfig("healthy-wiki"), providerConfig("required-wiki")],
      },
      adapter,
    });

    const result = await service.read(request({ workspace: workspace(bindings), refs }));

    expect(result).toMatchObject({
      outcome: "blocked",
      providers: [],
      gaps: [expect.objectContaining({
        code: "context_budget_exceeded",
        severity: "blocking",
        providerId: "required-wiki",
      })],
    });
    expect(adapter.read).not.toHaveBeenCalled();
  });

  it("skips an optional over-budget plan while reading healthy Providers", async () => {
    const refs = Array.from(
      { length: LLM_WIKI_MAX_PAGES - 3 },
      (_, index) => `context://optional-wiki/wiki/pages/page-${index}.md`,
    );
    const bindings = [
      contextBinding({ providerId: "required-wiki", entrypoints: ["wiki/index.md"] }),
      contextBinding({ providerId: "optional-wiki", required: false, entrypoints: ["wiki/index.md"] }),
    ];
    const adapter: ContextProviderReadAdapter = {
      read: vi.fn(async (input) => providerSuccess(input.plan.provider.id, input.paths)),
    };
    const service = createContextReadService({
      registry: {
        schema: CONTEXT_PROVIDER_REGISTRY_V1,
        enabled: true,
        providers: [providerConfig("required-wiki"), providerConfig("optional-wiki")],
      },
      adapter,
    });

    const result = await service.read(request({ workspace: workspace(bindings), refs }));

    expect(result).toMatchObject({
      outcome: "partial",
      providers: [{ providerId: "required-wiki" }],
      gaps: [expect.objectContaining({
        code: "context_budget_exceeded",
        severity: "gap",
        providerId: "optional-wiki",
      })],
    });
    expect(adapter.read).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adapter.read).mock.calls[0]?.[0].plan.provider.id).toBe("required-wiki");
  });

  it("blocks required failures, degrades optional failures and redacts adapter details", async () => {
    const bindings = [
      contextBinding({ providerId: "required-wiki", entrypoints: ["wiki/index.md"] }),
      contextBinding({ providerId: "optional-wiki", required: false, entrypoints: ["wiki/index.md"] }),
    ];
    const registryValue: ContextProviderRegistryV1 = {
      schema: CONTEXT_PROVIDER_REGISTRY_V1,
      enabled: true,
      providers: [providerConfig("required-wiki"), providerConfig("optional-wiki")],
    };
    const optionalFailure: ContextProviderReadAdapter = {
      read: vi.fn(async (input) => input.plan.provider.id === "required-wiki"
        ? providerSuccess(input.plan.provider.id, input.paths)
        : {
            ok: false as const,
            diagnostic: {
              code: "fetch_failed" as const,
              severity: "blocking" as const,
              providerId: "optional-wiki",
              ref: "https://secret-token@example.test/private",
              message: "fatal token=secret-token",
            },
          }),
    };
    const partial = await createContextReadService({ registry: registryValue, adapter: optionalFailure })
      .read(request({ workspace: workspace(bindings), refs: [] }));
    expect(partial).toMatchObject({
      outcome: "partial",
      providers: [{ providerId: "required-wiki" }],
      gaps: [expect.objectContaining({ code: "fetch_failed", severity: "gap", providerId: "optional-wiki" })],
    });
    expect(JSON.stringify(partial)).not.toContain("secret-token");

    const requiredFailure: ContextProviderReadAdapter = {
      read: vi.fn(async () => ({
        ok: false,
        diagnostic: { code: "context_budget_exceeded", severity: "blocking", message: "budget" },
      })),
    };
    const blocked = await createContextReadService({ registry: registry(), adapter: requiredFailure }).read(request({ refs: [] }));
    expect(blocked).toMatchObject({
      outcome: "blocked",
      providers: [],
      gaps: [expect.objectContaining({ code: "context_budget_exceeded", severity: "blocking" })],
    });
  });

  it("redacts adapter warning details before publishing a Provider snapshot", async () => {
    const adapter: ContextProviderReadAdapter = {
      read: vi.fn(async (input) => ({
        ...providerSuccess(input.plan.provider.id, input.paths),
        warnings: [{
          code: "scope_mismatch",
          severity: "warning",
          providerId: input.plan.provider.id,
          ref: "https://secret-token@example.test/private",
          message: "warning token=secret-token",
          mismatchedDimensions: ["environment_ids", "secret-token"],
        }],
      })),
    };

    const result = await createContextReadService({ registry: registry(), adapter }).read(request({ refs: [] }));

    expect(result).toMatchObject({
      outcome: "completed",
      providers: [{
        warnings: [{
          code: "scope_mismatch",
          severity: "warning",
          providerId: "enterprise-wiki",
          message: "Context Provider warning (scope_mismatch)",
          mismatchedDimensions: ["environment_ids"],
        }],
      }],
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("blocks scope mismatch without retaining the Provider files", async () => {
    const paths = ["purpose.md", "schema.md", "wiki/index.md", "wiki/log.md", "wiki/systems/axis.md"];
    const adapter: ContextProviderReadAdapter = {
      read: vi.fn(async () => ({
        ...success(paths),
        files: paths.map((path) => file(
          path,
          path.endsWith("axis.md") ? metadata({ scope: { environment_ids: ["prod"] } }) : undefined,
        )),
      })),
    };
    const result = await createContextReadService({ registry: registry(), adapter }).read(request({
      workspace: workspace([contextBinding({ entrypoints: ["wiki/index.md"] })]),
    }));
    expect(result).toMatchObject({
      outcome: "blocked",
      providers: [],
      gaps: [expect.objectContaining({ code: "scope_mismatch", mismatchedDimensions: ["environment_ids"] })],
    });
    expect(JSON.stringify(result)).not.toContain("# wiki/systems/axis.md");
  });

  it("requires explicit flag and operation authorization for restricted references", async () => {
    const paths = ["purpose.md", "schema.md", "wiki/index.md", "wiki/log.md", "wiki/systems/axis.md"];
    const restricted = metadata({ sensitivity: "restricted_reference" });
    const adapter: ContextProviderReadAdapter = {
      read: vi.fn(async () => ({
        ...success(paths),
        files: paths.map((path) => file(path, path.endsWith("axis.md") ? restricted : undefined)),
      })),
    };
    const denied = await createContextReadService({ registry: registry(), adapter }).read(request({
      workspace: workspace([contextBinding({ entrypoints: ["wiki/index.md"] })]),
    }));
    expect(denied).toMatchObject({ outcome: "blocked", providers: [], gaps: [expect.objectContaining({ code: "restricted_context_denied" })] });
    expect(JSON.stringify(denied)).not.toContain("# wiki/systems/axis.md");

    const allowed = await createContextReadService({
      registry: registry(),
      adapter,
      authorizeRestrictedReference: () => true,
    }).read(request({
      workspace: workspace([contextBinding({ entrypoints: ["wiki/index.md"] })]),
      includeRestrictedReferences: true,
    }));
    expect(allowed).toMatchObject({
      outcome: "completed",
      providers: [{ files: expect.arrayContaining([expect.objectContaining({ path: "wiki/systems/axis.md", page: restricted })]) }],
    });
  });
});
