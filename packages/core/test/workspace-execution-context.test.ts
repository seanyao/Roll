import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ISSUE_MANIFEST_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  WORKSPACE_MANIFEST_V1,
  type CycleRepositoryExecutionContext,
  type IssueManifest,
  type RepositoryBinding,
  type WorkspaceExecutionAuthorityPaths,
  type WorkspaceExecutionContextV1,
  type WorkspaceMatchEvidence,
} from "@roll/spec";
import {
  buildWorkspaceExecutionContext,
  deriveWorkspaceExecutionAuthorities,
  resolveWorkspaceExecutionContextScope,
  type WorkspaceExecutionContextFactsV1,
  type WorkspaceRegistryCandidate,
} from "../src/index.js";

const sha = (value: string): string => value.repeat(40).slice(0, 40);

function binding(alias = "product", repoId = "repo-product"): RepositoryBinding {
  return {
    schema: REPOSITORY_BINDING_V1,
    repoId,
    alias,
    remote: `ssh://github.test/acme/${alias}`,
    integrationBranch: "idea-074-workspace",
    provider: "github",
    workflow: {
      branchPattern: "roll/{workspace_id}/{story_id}/{repo_alias}",
      requiredChecks: ["test", "lint"],
    },
  };
}

function issueManifest(bindings: readonly RepositoryBinding[]): IssueManifest {
  return {
    schema: ISSUE_MANIFEST_V1,
    workspaceId: "ws-demo",
    storyId: "US-WS-031",
    requirements: [],
    repositories: bindings.map((entry, index) => index === 0
      ? {
          repoId: entry.repoId,
          alias: entry.alias,
          access: "write" as const,
          requiredDelivery: true,
          noChangePolicy: "changes_required" as const,
          workBranch: `roll/ws-demo/US-WS-031/${entry.alias}`,
        }
      : {
          repoId: entry.repoId,
          alias: entry.alias,
          access: "read" as const,
          requiredDelivery: false,
        }),
    integrationAcceptance: { command: ["pnpm", "test:integration"], cwd: bindings[0]?.alias ?? "product" },
  };
}

function execution(root: string, manifest: IssueManifest): CycleRepositoryExecutionContext {
  const issueRoot = join(root, "issues", manifest.storyId);
  return {
    workspaceId: manifest.workspaceId,
    issueRoot,
    repositories: Object.fromEntries(manifest.repositories.map((target, index) => [
      target.repoId,
      {
        repoId: target.repoId,
        alias: target.alias,
        access: target.access,
        requiredDelivery: target.requiredDelivery,
        ...(target.access === "write" ? { noChangePolicy: target.noChangePolicy, workBranch: target.workBranch } : {}),
        ...(target.dependsOnRepo === undefined ? {} : { dependsOnRepo: target.dependsOnRepo }),
        worktreePath: join(issueRoot, target.alias),
        baseSha: sha(String(index + 1)),
        headSha: sha(String(index + 2)),
        commands: { test: ["pnpm", "test"], integration: ["pnpm", "test:integration"] },
      },
    ])),
    ...(manifest.integrationAcceptance === undefined ? {} : {
      integrationAcceptance: {
        command: manifest.integrationAcceptance.command,
        cwdRepoId: manifest.repositories.find((target) => target.alias === manifest.integrationAcceptance?.cwd)?.repoId ?? "",
      },
    }),
  };
}

function facts(options: {
  readonly bindings?: readonly RepositoryBinding[];
  readonly lifecycle?: WorkspaceRegistryCandidate["lifecycle"];
  readonly includeIssue?: boolean;
  readonly authorities?: WorkspaceExecutionAuthorityPaths;
} = {}): WorkspaceExecutionContextFactsV1 {
  const root = "/authority/workspaces/ws-demo";
  const bindings = options.bindings ?? [binding()];
  const manifest = issueManifest(bindings);
  return {
    candidate: {
      workspaceId: "ws-demo",
      root,
      canonicalRoot: root,
      manifestWorkspaceId: "ws-demo",
      pathState: "valid",
      lifecycle: options.lifecycle ?? "active",
    },
    manifest: {
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId: "ws-demo",
      displayName: "Demo",
      requirements: [],
      repositories: bindings,
    },
    authorities: options.authorities ?? deriveWorkspaceExecutionAuthorities(root),
    ...(options.includeIssue === false ? {} : {
      issue: {
        manifest,
        manifestPath: join(root, "issues", manifest.storyId, "manifest.json"),
        execution: execution(root, manifest),
      },
    }),
  };
}

const evidence: readonly WorkspaceMatchEvidence[] = [{
  kind: "requirement_source_exact",
  value: "jira:APE-234",
  hard: true,
  score: 100,
  source: "jira:APE-234",
  provenance: "explicit_user",
  detail: "exact",
}];

type JsonRecord = Record<string, unknown>;

function externalContext(): JsonRecord {
  const built = buildWorkspaceExecutionContext({ facts: facts(), source: "explicit", evidence });
  if (!built.ok) throw new Error("fixture failed");
  return JSON.parse(JSON.stringify(built.context)) as JsonRecord;
}

function jsonRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture path is not a record");
  return value as JsonRecord;
}

function repositoryRecord(context: JsonRecord): { readonly repositories: JsonRecord; readonly repoId: string; readonly repository: JsonRecord } {
  const issue = jsonRecord(context["issue"]);
  const executionContext = jsonRecord(issue["execution"]);
  const repositories = jsonRecord(executionContext["repositories"]);
  const repoId = Object.keys(repositories)[0];
  if (repoId === undefined) throw new Error("fixture repository missing");
  return { repositories, repoId, repository: jsonRecord(repositories[repoId]) };
}

function externalBuildInput(): JsonRecord {
  return JSON.parse(JSON.stringify({ facts: facts(), source: "explicit", evidence })) as JsonRecord;
}

function buildFactsRecord(input: JsonRecord): JsonRecord {
  return jsonRecord(input["facts"]);
}

function buildIssueRecord(input: JsonRecord): JsonRecord {
  return jsonRecord(buildFactsRecord(input)["issue"]);
}

function buildRepositoryRecord(input: JsonRecord): { readonly repositories: JsonRecord; readonly repoId: string; readonly repository: JsonRecord } {
  const executionContext = jsonRecord(buildIssueRecord(input)["execution"]);
  const repositories = jsonRecord(executionContext["repositories"]);
  const repoId = Object.keys(repositories)[0];
  if (repoId === undefined) throw new Error("fixture repository missing");
  return { repositories, repoId, repository: jsonRecord(repositories[repoId]) };
}

describe("buildWorkspaceExecutionContext", () => {
  it("accepts a valid Workspace context-provider binding in manifest facts", () => {
    const input = facts({ includeIssue: false });
    const result = buildWorkspaceExecutionContext({
      facts: {
        ...input,
        manifest: {
          ...input.manifest,
          contexts: {
            enabled: true,
            bindings: [{
              providerId: "ape-context",
              enabled: true,
              required: true,
              entrypoints: ["wiki/index.md"],
            }],
          },
        },
      },
      source: "explicit",
      evidence,
    });

    expect(result).toMatchObject({ ok: true, context: { workspace: { workspaceId: "ws-demo" } } });
  });

  it("builds one frozen serializable authority snapshot without retaining mutable inputs", () => {
    const input = facts();
    const result = buildWorkspaceExecutionContext({ facts: input, source: "explicit", evidence });

    expect(result).toMatchObject({ ok: true, context: { schema: WORKSPACE_EXECUTION_CONTEXT_V1 } });
    if (!result.ok) throw new Error(result.error.code);
    const serialized = JSON.stringify(result.context);
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Object.isFrozen(result.context.authorities)).toBe(true);
    expect(Object.isFrozen(result.context.issue?.execution.repositories)).toBe(true);
    expect(result.context.bindings[0]?.workflow.requiredChecks).toEqual(["test", "lint"]);

    (input.manifest.repositories[0]?.workflow.requiredChecks as string[]).push("changed-after-build");
    expect(JSON.stringify(result.context)).toBe(serialized);
  });

  it("does not consult or follow host cwd while deriving authority", () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/unrelated/launch-directory");
    const result = buildWorkspaceExecutionContext({ facts: facts(), source: "explicit", evidence });
    const cwdCalls = cwd.mock.calls.length;
    cwd.mockRestore();

    expect(result).toMatchObject({
      ok: true,
      context: { authorities: { backlog: "/authority/workspaces/ws-demo/backlog/index.md" } },
    });
    expect(cwdCalls).toBe(0);
  });

  it("preserves the complete multi-repository execution contract", () => {
    const result = buildWorkspaceExecutionContext({
      facts: facts({ bindings: [binding("product", "repo-product"), binding("skills", "repo-skills")] }),
      source: "requirement_discovery",
      evidence,
    });

    expect(result).toMatchObject({
      ok: true,
      context: {
        bindings: [
          { repoId: "repo-product", workflow: { requiredChecks: ["test", "lint"] } },
          { repoId: "repo-skills", workflow: { requiredChecks: ["test", "lint"] } },
        ],
        issue: {
          execution: {
            repositories: {
              "repo-product": {
                access: "write",
                requiredDelivery: true,
                noChangePolicy: "changes_required",
                baseSha: sha("1"),
                headSha: sha("2"),
                commands: { test: ["pnpm", "test"], integration: ["pnpm", "test:integration"] },
              },
              "repo-skills": {
                access: "read",
                requiredDelivery: false,
                baseSha: sha("2"),
                headSha: sha("3"),
              },
            },
          },
        },
      },
    });
  });

  it.each([
    ["manifest identity", () => ({ ...facts(), manifest: { ...facts().manifest, workspaceId: "other" } }), "workspace_identity_mismatch"],
    ["Issue identity", () => {
      const value = facts();
      return { ...value, issue: value.issue === undefined ? undefined : { ...value.issue, manifest: { ...value.issue.manifest, workspaceId: "other" } } };
    }, "issue_identity_mismatch"],
    ["authority path", () => ({ ...facts(), authorities: { ...facts().authorities, backlog: "/tmp/backlog.md" } }), "authority_path_mismatch"],
  ])("fails closed on %s mismatch", (_name, makeFacts, code) => {
    expect(buildWorkspaceExecutionContext({ facts: makeFacts(), source: "explicit", evidence })).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it.each([
    ["candidate missing", (input: JsonRecord) => { delete buildFactsRecord(input)["candidate"]; }],
    ["candidate null", (input: JsonRecord) => { buildFactsRecord(input)["candidate"] = null; }],
    ["candidate open", (input: JsonRecord) => { jsonRecord(buildFactsRecord(input)["candidate"])["extra"] = true; }],
    ["manifest missing", (input: JsonRecord) => { delete buildFactsRecord(input)["manifest"]; }],
    ["manifest null", (input: JsonRecord) => { buildFactsRecord(input)["manifest"] = null; }],
    ["manifest open", (input: JsonRecord) => { jsonRecord(buildFactsRecord(input)["manifest"])["extra"] = true; }],
    ["authorities missing", (input: JsonRecord) => { delete buildFactsRecord(input)["authorities"]; }],
    ["authorities null", (input: JsonRecord) => { buildFactsRecord(input)["authorities"] = null; }],
    ["authorities open", (input: JsonRecord) => { jsonRecord(buildFactsRecord(input)["authorities"])["extra"] = "/tmp"; }],
    ["Issue facts null", (input: JsonRecord) => { buildFactsRecord(input)["issue"] = null; }],
    ["Issue manifest missing", (input: JsonRecord) => { delete buildIssueRecord(input)["manifest"]; }],
    ["Issue manifest null", (input: JsonRecord) => { buildIssueRecord(input)["manifest"] = null; }],
    ["Issue manifest open", (input: JsonRecord) => { jsonRecord(buildIssueRecord(input)["manifest"])["extra"] = true; }],
    ["Issue execution missing", (input: JsonRecord) => { delete buildIssueRecord(input)["execution"]; }],
    ["Issue execution null", (input: JsonRecord) => { buildIssueRecord(input)["execution"] = null; }],
    ["repository commands missing", (input: JsonRecord) => { delete buildRepositoryRecord(input).repository["commands"]; }],
    ["repository commands null", (input: JsonRecord) => { buildRepositoryRecord(input).repository["commands"] = null; }],
    ["binding workflow missing", (input: JsonRecord) => {
      const bindings = jsonRecord(buildFactsRecord(input)["manifest"])["repositories"] as unknown[];
      delete jsonRecord(bindings[0])["workflow"];
    }],
    ["requiredDelivery wrong type", (input: JsonRecord) => { buildRepositoryRecord(input).repository["requiredDelivery"] = "yes"; }],
  ])("fails closed without throwing for malformed runtime facts: %s", (_name, mutate) => {
    const input = externalBuildInput();
    mutate(input);

    let result: ReturnType<typeof buildWorkspaceExecutionContext> | undefined;
    expect(() => {
      result = buildWorkspaceExecutionContext(input as unknown as Parameters<typeof buildWorkspaceExecutionContext>[0]);
    }).not.toThrow();
    expect(result).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/^(invalid_execution_context|workspace_identity_mismatch|authority_path_mismatch|issue_identity_mismatch|repository_context_mismatch)$/u) },
    });
  });
});

describe("resolveWorkspaceExecutionContextScope", () => {
  it("keeps machine, optional read, and legacy migration explicitly context-free", () => {
    for (const scope of ["machine_only", "workspace_optional_read", "legacy_migration_only"] as const) {
      expect(resolveWorkspaceExecutionContextScope({ scope, context: undefined })).toEqual({
        ok: true,
        context: undefined,
      });
    }
    for (const scope of [
      "workspace_required_read",
      "workspace_required_mutation",
      "issue_required",
      "repository_required",
    ] as const) {
      expect(resolveWorkspaceExecutionContextScope({ scope, context: undefined })).toMatchObject({
        ok: false,
        error: { code: "missing_execution_context" },
      });
    }
  });

  it("revalidates an externally supplied context before applying scope policy", () => {
    const built = buildWorkspaceExecutionContext({ facts: facts(), source: "explicit", evidence });
    if (!built.ok) throw new Error("fixture failed");
    const forgedSchema = { ...built.context, schema: "roll.workspace-execution-context/v0" } as unknown as typeof built.context;
    const forgedAuthority = {
      ...built.context,
      authorities: { ...built.context.authorities, policy: "/tmp/policy.yaml" },
    };

    expect(resolveWorkspaceExecutionContextScope({ scope: "workspace_required_read", context: forgedSchema })).toMatchObject({
      ok: false,
      error: { code: "invalid_execution_context" },
    });
    expect(resolveWorkspaceExecutionContextScope({ scope: "workspace_required_read", context: forgedAuthority })).toMatchObject({
      ok: false,
      error: { code: "authority_path_mismatch" },
    });
  });

  it.each([
    ["commands missing", (context: JsonRecord) => { delete repositoryRecord(context).repository["commands"]; }],
    ["commands null", (context: JsonRecord) => { repositoryRecord(context).repository["commands"] = null; }],
    ["commands array", (context: JsonRecord) => { repositoryRecord(context).repository["commands"] = []; }],
    ["test missing", (context: JsonRecord) => { delete jsonRecord(repositoryRecord(context).repository["commands"])["test"]; }],
    ["test scalar", (context: JsonRecord) => { jsonRecord(repositoryRecord(context).repository["commands"])["test"] = "pnpm test"; }],
    ["test non-string item", (context: JsonRecord) => { jsonRecord(repositoryRecord(context).repository["commands"])["test"] = [1]; }],
    ["integration missing", (context: JsonRecord) => { delete jsonRecord(repositoryRecord(context).repository["commands"])["integration"]; }],
    ["integration scalar", (context: JsonRecord) => { jsonRecord(repositoryRecord(context).repository["commands"])["integration"] = "pnpm integration"; }],
    ["integration non-string item", (context: JsonRecord) => { jsonRecord(repositoryRecord(context).repository["commands"])["integration"] = [false]; }],
    ["repository null", (context: JsonRecord) => {
      const repository = repositoryRecord(context);
      repository.repositories[repository.repoId] = null;
    }],
    ["repository array", (context: JsonRecord) => {
      const repository = repositoryRecord(context);
      repository.repositories[repository.repoId] = [];
    }],
    ["requiredDelivery wrong type", (context: JsonRecord) => { repositoryRecord(context).repository["requiredDelivery"] = "yes"; }],
    ["bindings null", (context: JsonRecord) => { context["bindings"] = null; }],
    ["binding malformed", (context: JsonRecord) => { context["bindings"] = [{}]; }],
    ["binding workflow missing", (context: JsonRecord) => {
      const bindings = context["bindings"] as unknown[];
      delete jsonRecord(bindings[0])["workflow"];
    }],
    ["binding duplicate", (context: JsonRecord) => {
      const bindings = context["bindings"] as unknown[];
      bindings.push(JSON.parse(JSON.stringify(bindings[0])) as unknown);
    }],
    ["workspace missing", (context: JsonRecord) => { delete context["workspace"]; }],
    ["workspace null", (context: JsonRecord) => { context["workspace"] = null; }],
    ["workspace open", (context: JsonRecord) => { jsonRecord(context["workspace"])["extra"] = true; }],
    ["resolution missing", (context: JsonRecord) => { delete context["resolution"]; }],
    ["resolution null", (context: JsonRecord) => { context["resolution"] = null; }],
    ["resolution open", (context: JsonRecord) => { jsonRecord(context["resolution"])["extra"] = true; }],
    ["authorities missing", (context: JsonRecord) => { delete context["authorities"]; }],
    ["authorities null", (context: JsonRecord) => { context["authorities"] = null; }],
    ["authorities open", (context: JsonRecord) => { jsonRecord(context["authorities"])["extra"] = "/tmp"; }],
    ["issue null", (context: JsonRecord) => { context["issue"] = null; }],
    ["issue open", (context: JsonRecord) => { jsonRecord(context["issue"])["extra"] = true; }],
    ["execution missing", (context: JsonRecord) => { delete jsonRecord(context["issue"])["execution"]; }],
    ["execution null", (context: JsonRecord) => { jsonRecord(context["issue"])["execution"] = null; }],
    ["execution open", (context: JsonRecord) => { jsonRecord(jsonRecord(context["issue"])["execution"])["extra"] = true; }],
    ["unknown schema", (context: JsonRecord) => { context["schema"] = "roll.workspace-execution-context/v0"; }],
    ["unknown lifecycle", (context: JsonRecord) => { jsonRecord(context["workspace"])["lifecycle"] = "retired"; }],
    ["unknown resolution source", (context: JsonRecord) => { jsonRecord(context["resolution"])["source"] = "ambient_cwd"; }],
    ["top-level open", (context: JsonRecord) => { context["extra"] = true; }],
  ])("fails closed without throwing for malformed external context: %s", (_name, mutate) => {
    const context = externalContext();
    mutate(context);

    let result: ReturnType<typeof resolveWorkspaceExecutionContextScope> | undefined;
    expect(() => {
      result = resolveWorkspaceExecutionContextScope({
        scope: "repository_required",
        context: context as unknown as WorkspaceExecutionContextV1,
      });
    }).not.toThrow();
    expect(result).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/^(invalid_execution_context|repository_context_mismatch|authority_path_mismatch|issue_identity_mismatch)$/u) },
    });
  });

  it("enforces lifecycle and Issue/repository requirements without fabricating empty objects", () => {
    const paused = buildWorkspaceExecutionContext({ facts: facts({ lifecycle: "paused" }), source: "explicit", evidence });
    const noIssue = buildWorkspaceExecutionContext({ facts: facts({ includeIssue: false }), source: "explicit", evidence });
    if (!paused.ok || !noIssue.ok) throw new Error("fixture failed");

    expect(resolveWorkspaceExecutionContextScope({ scope: "workspace_required_read", context: paused.context })).toMatchObject({ ok: true });
    expect(resolveWorkspaceExecutionContextScope({ scope: "workspace_required_mutation", context: paused.context })).toMatchObject({
      ok: false,
      error: { code: "workspace_lifecycle_forbidden" },
    });
    expect(resolveWorkspaceExecutionContextScope({ scope: "issue_required", context: noIssue.context })).toMatchObject({
      ok: false,
      error: { code: "missing_issue_context" },
    });
    expect(resolveWorkspaceExecutionContextScope({ scope: "repository_required", context: noIssue.context })).toMatchObject({
      ok: false,
      error: { code: "missing_repository_context" },
    });
  });
});
