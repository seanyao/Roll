import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as publicSpec from "../src/index.js";
import {
  REPOSITORY_BINDING_V1,
  ISSUE_MANIFEST_V1,
  WORKSPACE_MANIFEST_V1,
  issueManifestV1Schema,
  normalizeRepositoryRemote,
  parseIssueManifest,
  parseRepositoryBinding,
  parseWorkspaceManifest,
  repositoryBindingV1Schema,
  repositoryIdFromRemote,
  workspaceManifestV1Schema,
} from "../src/types/workspace.js";

type SchemaView = {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, SchemaView>;
  items?: SchemaView;
  oneOf?: readonly SchemaView[];
};

function repository(remote = "https://github.com/Owner/Repo.git", alias = "product") {
  const id = repositoryIdFromRemote(remote);
  if (!id.ok) throw new Error("test remote must be valid");
  return {
    schema: REPOSITORY_BINDING_V1,
    repoId: id.value,
    alias,
    remote,
    integrationBranch: "main",
    provider: "github",
    workflow: {
      branchPattern: "roll/{workspace_id}/{story_id}",
      requiredChecks: ["unit", "integration"],
    },
  };
}

function workspace() {
  return {
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId: "ws-sot-platform",
    displayName: "SOT platform delivery",
    createdAt: "2026-07-20T00:00:00Z",
    requirements: [{ provider: "jira", ref: "SOT-15499" }],
    repositories: [repository()],
  };
}

function workspaceContexts() {
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

function issue() {
  const product = repository();
  const docs = repository("https://github.com/Owner/Docs.git", "docs");
  return {
    schema: ISSUE_MANIFEST_V1,
    workspaceId: "ws-sot-platform",
    storyId: "US-WS-001",
    requirements: [{ provider: "jira", ref: "SOT-15499" }],
    repositories: [
      {
        repoId: product.repoId,
        alias: product.alias,
        access: "write",
        requiredDelivery: true,
        noChangePolicy: "changes_required",
        pathScope: ["packages/spec"],
      },
      {
        repoId: docs.repoId,
        alias: docs.alias,
        access: "read",
        requiredDelivery: false,
      },
    ],
  };
}

describe("Workspace repository identity", () => {
  it("keeps the Workspace contract module inside the pure spec boundary", () => {
    const source = readFileSync(new URL("../src/types/workspace.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]+?\s+from\s+["']([^"']+)["'];$/gmu)]
      .map((match) => ({ kind: match[1] === undefined ? "value" : "type", source: match[2] }));
    expect(imports).toEqual([
      { kind: "value", source: "node:crypto" },
      { kind: "type", source: "./json-schema.js" },
      { kind: "value", source: "./context-binding.js" },
    ]);
    expect(source).not.toMatch(/\b(?:process|globalThis|fetch|console|Date|setTimeout|setInterval)\b/u);
  });

  it("exports the complete v1 contract from the public spec surface", () => {
    expect(WORKSPACE_MANIFEST_V1).toBe("roll.workspace/v1");
    expect(REPOSITORY_BINDING_V1).toBe("roll.repository-binding/v1");
    expect(ISSUE_MANIFEST_V1).toBe("roll.issue/v1");
    expect(publicSpec).toMatchObject({
      parseWorkspaceManifest: expect.any(Function),
      parseRepositoryBinding: expect.any(Function),
      parseIssueManifest: expect.any(Function),
      normalizeRepositoryRemote: expect.any(Function),
      repositoryIdFromRemote: expect.any(Function),
      workspaceManifestV1Schema: expect.any(Object),
      repositoryBindingV1Schema: expect.any(Object),
      issueManifestV1Schema: expect.any(Object),
    });
  });

  it.each([
    ["https://GitHub.com/Owner/Repo.git/", "https://github.com/Owner/Repo"],
    ["https://github.com:443/Owner/Repo", "https://github.com/Owner/Repo"],
    ["git@GitHub.com:Owner/Repo.git", "ssh://github.com/Owner/Repo"],
    ["ssh://deploy@GitHub.com:22/Owner/Repo.git/", "ssh://github.com/Owner/Repo"],
    ["file:///Users/Example/Repo.git/", "file:///Users/Example/Repo"],
  ])("canonicalizes the closed v1 remote table: %s", (input, expected) => {
    expect(normalizeRepositoryRemote(input)).toEqual({ ok: true, value: expected });
  });

  it("keeps SSH and HTTPS repository identities schemeful and unequal for Context scope", () => {
    const ssh = normalizeRepositoryRemote("git@gitee.com:bipo/dukang-axis.git");
    const https = normalizeRepositoryRemote("https://gitee.com/bipo/dukang-axis.git");
    expect(ssh).toEqual({ ok: true, value: "ssh://gitee.com/bipo/dukang-axis" });
    expect(https).toEqual({ ok: true, value: "https://gitee.com/bipo/dukang-axis" });
    expect(ssh).not.toEqual(https);
  });

  it.each([
    "http://example.com/Owner/Repo.git",
    "ftp://example.com/Owner/Repo.git",
    "git://example.com/Owner/Repo.git",
  ])("rejects protocols outside the closed v1 remote table: %s", (input) => {
    expect(normalizeRepositoryRemote(input)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "unsafe_remote", path: "remote" })],
    });
  });

  it("derives a stable repository ID from the canonical remote", () => {
    const https = repositoryIdFromRemote("https://GitHub.com/Owner/Repo.git");
    const canonical = repositoryIdFromRemote("https://github.com/Owner/Repo");
    expect(https).toEqual(canonical);
    expect(https).toEqual({ ok: true, value: "repo-8d325f3875d5" });
    expect(repositoryIdFromRemote("https://github.com/Owner/Other")).toEqual({
      ok: true,
      value: "repo-473d9ff14ae9",
    });
  });

  it.each([
    ["https://127.1/Owner/Repo.git", "https://127.0.0.1/Owner/Repo", "https://127.0.0.1/Owner/Repo"],
    ["https://0x7f000001/Owner/Repo.git", "https://127.0.0.1/Owner/Repo", "https://127.0.0.1/Owner/Repo"],
    ["ssh://git@[0:0:0:0:0:0:0:1]/Owner/Repo.git", "ssh://[::1]/Owner/Repo", "ssh://git@[::1]/Owner/Repo"],
  ])("canonicalizes equivalent IP host spellings: %s", (input, expected, equivalentInput) => {
    expect(normalizeRepositoryRemote(input)).toEqual({ ok: true, value: expected });
    expect(repositoryIdFromRemote(input)).toEqual(repositoryIdFromRemote(equivalentInput));
  });

  it.each([
    "https://token@example.com/Owner/Repo.git",
    "https://example.com:8443/Owner/Repo.git",
    "https://example.com/Owner/Repo.git?token=secret",
    "https://example.com/Owner/Repo.git#fragment",
    "ssh://git@example.com:2222/Owner/Repo.git",
    "../Owner/Repo.git",
    "C:\\Owner\\Repo.git",
    "file://server/share/Repo.git",
    "file:///Owner/../Repo.git",
    "https://example.com/Owner/%52epo.git",
    "https://example.com/Owner/My Repo.git",
    "https://@example.com/Owner/Repo.git",
    "HTTPS://@example.com/Owner/Repo.git",
    "https://example.com/Owner/Repo\n.git",
    "ssh://git@example.com/Owner/Repo\t.git",
    "file://localhost/Users/Example/Repo.git",
    "FILE://localhost/Users/Example/Repo.git",
    "file:///C:/Owner/Repo.git",
    "https:example.com/Owner/Repo.git",
    "https:/example.com/Owner/Repo.git",
    "https:///example.com/Owner/Repo.git",
    "ssh:/git@example.com/Owner/Repo.git",
    "file:/Users/Example/Repo.git",
    "https://example.com/Repo.git",
    "git@example.com:Repo.git",
    "ssh://git@example.com/Repo.git",
    "ssh://git@@example.com/Owner/Repo.git",
    "ssh://git@deploy@example.com/Owner/Repo.git",
    "ssh://git:@example.com/Owner/Repo.git",
    "https://example.com:/Owner/Repo.git",
    "ssh://git@example.com:/Owner/Repo.git",
    "https://example.com:0443/Owner/Repo.git",
    "ssh://git@example.com:022/Owner/Repo.git",
    "https://example..com/Owner/Repo.git",
    "https://example-.com/Owner/Repo.git",
  ])("rejects ambiguous or credential-bearing remote input without echoing it: %s", (input) => {
    const result = normalizeRepositoryRemote(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((error) => error.code === "unsafe_remote" && error.path === "remote")).toBe(true);
    expect(JSON.stringify(result.errors)).not.toContain(input);
  });

  it("redacts credential sentinels from remote validation errors", () => {
    const input = "https://credential-sentinel@example.com/Owner/Repo.git";
    const result = normalizeRepositoryRemote(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const rendered = JSON.stringify(result.errors);
    expect(rendered).not.toContain(input);
    expect(rendered).not.toContain("credential-sentinel");
  });

  it("keeps credential redaction through repository and Workspace parser errors", () => {
    const input = "https://credential-sentinel@example.com/Owner/Repo.git";
    const binding = { ...repository(), remote: input };
    const repositoryResult = parseRepositoryBinding(binding);
    const workspaceResult = parseWorkspaceManifest({ ...workspace(), repositories: [binding] }, {});
    expect(repositoryResult.ok).toBe(false);
    expect(workspaceResult.ok).toBe(false);
    if (repositoryResult.ok || workspaceResult.ok) return;
    expect(repositoryResult.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsafe_remote", path: "remote" }),
    ]));
    expect(workspaceResult.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsafe_remote", path: "repositories[0].remote" }),
    ]));
    expect(JSON.stringify(repositoryResult)).not.toContain("credential-sentinel");
    expect(JSON.stringify(workspaceResult)).not.toContain("credential-sentinel");
    expect(JSON.stringify(repositoryResult)).not.toContain(input);
    expect(JSON.stringify(workspaceResult)).not.toContain(input);
  });

  it("keeps parse entrypoints deterministic and input-immutable across environment and time changes", () => {
    const inputs = [repository(), workspace(), issue()] as const;
    const before = structuredClone(inputs);
    const previousWorkspace = process.env["ROLL_WORKSPACE"];
    vi.useFakeTimers();
    try {
      process.env["ROLL_WORKSPACE"] = "ws-environment-a";
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const first = [
        parseRepositoryBinding(inputs[0]),
        parseWorkspaceManifest(inputs[1], {}),
        parseIssueManifest(inputs[2], {}),
      ];
      process.env["ROLL_WORKSPACE"] = "ws-environment-b";
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      const second = [
        parseRepositoryBinding(inputs[0]),
        parseWorkspaceManifest(inputs[1], {}),
        parseIssueManifest(inputs[2], {}),
      ];
      expect(second).toEqual(first);
      expect(inputs).toEqual(before);
    } finally {
      vi.useRealTimers();
      if (previousWorkspace === undefined) delete process.env["ROLL_WORKSPACE"];
      else process.env["ROLL_WORKSPACE"] = previousWorkspace;
    }
  });
});

describe("RepositoryBinding and WorkspaceManifest", () => {
  it("publishes closed schemas at every object boundary", () => {
    const repositorySchema = repositoryBindingV1Schema as SchemaView;
    const workspaceSchema = workspaceManifestV1Schema as SchemaView;
    const issueSchema = issueManifestV1Schema as SchemaView;
    expect(repositorySchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(repositorySchema.properties?.workflow).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspaceSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspaceSchema.properties?.requirements?.items).toMatchObject({ type: "object", additionalProperties: false });
    expect(workspaceSchema.properties?.repositories).toMatchObject({ type: "array", minItems: 1 });
    expect(issueSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(issueSchema.properties?.requirements?.items).toMatchObject({ type: "object", additionalProperties: false });
    expect(issueSchema.properties?.repositories?.items?.oneOf).toHaveLength(2);
    expect(issueSchema.properties?.repositories?.items?.oneOf?.every((entry) => entry.additionalProperties === false)).toBe(true);
  });

  it("parses and canonicalizes a complete repository binding", () => {
    const parsed = parseRepositoryBinding(repository());
    expect(parsed).toEqual({
      ok: true,
      value: {
        schema: REPOSITORY_BINDING_V1,
        repoId: "repo-8d325f3875d5",
        alias: "product",
        remote: "https://github.com/Owner/Repo",
        integrationBranch: "main",
        provider: "github",
        workflow: {
          branchPattern: "roll/{workspace_id}/{story_id}",
          requiredChecks: ["unit", "integration"],
        },
      },
    });
  });

  it("round-trips a valid Workspace manifest and enforces expected identity", () => {
    const parsed = parseWorkspaceManifest(JSON.parse(JSON.stringify(workspace())), {
      workspaceId: "ws-sot-platform",
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        schema: WORKSPACE_MANIFEST_V1,
        workspaceId: "ws-sot-platform",
        displayName: "SOT platform delivery",
        createdAt: "2026-07-20T00:00:00Z",
        requirements: [{ provider: "jira", ref: "SOT-15499" }],
        repositories: [{ ...repository(), remote: "https://github.com/Owner/Repo" }],
      },
    });
  });

  it("keeps contexts optional and round-trips an explicitly authorized binding", () => {
    expect(parseWorkspaceManifest(workspace(), {})).toMatchObject({
      ok: true,
      value: expect.not.objectContaining({ contexts: expect.anything() }),
    });
    expect(parseWorkspaceManifest({ ...workspace(), contexts: workspaceContexts() }, {})).toMatchObject({
      ok: true,
      value: { contexts: workspaceContexts() },
    });
  });

  it("rejects invalid Workspace contexts at the Workspace contract boundary", () => {
    expect(parseWorkspaceManifest({
      ...workspace(),
      contexts: {
        enabled: true,
        bindings: [{ ...workspaceContexts().bindings[0], enabled: false }],
      },
    }, {})).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_value", path: "contexts.bindings[0]" }),
      ]),
    });
  });

  it.each([
    ["root secret", { ...workspaceContexts(), credential: "workspace-secret-sentinel" }, "contexts.credential"],
    [
      "binding cache path",
      { ...workspaceContexts(), bindings: [{ ...workspaceContexts().bindings[0], cachePath: "workspace-secret-sentinel" }] },
      "contexts.bindings[0].cachePath",
    ],
  ])("rejects %s through parseWorkspaceManifest without echoing secret values", (_label, contextsValue, path) => {
    const parsed = parseWorkspaceManifest({ ...workspace(), contexts: contextsValue }, {});
    expect(parsed).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "unknown_field", path })]),
    });
    expect(JSON.stringify(parsed)).not.toContain("workspace-secret-sentinel");
  });

  it.each([
    ["unknown version", { ...workspace(), schema: "roll.workspace/v2" }, "unknown_version", "schema", {}],
    ["unknown root", { ...workspace(), root: "/tmp/workspace" }, "unknown_field", "root", {}],
    ["mutable lifecycle", { ...workspace(), lifecycle: "active" }, "unknown_field", "lifecycle", {}],
    ["workspace mismatch", workspace(), "identity_mismatch", "workspaceId", { workspaceId: "ws-other" }],
  ])("rejects %s", (_label, value, code, path, expectations) => {
    const parsed = parseWorkspaceManifest(value, expectations);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code, path })]));
  });

  it("rejects repository ID mismatch, unsafe refs and unknown nested fields", () => {
    const invalid = repository();
    invalid.repoId = "repo-000000000000";
    invalid.integrationBranch = "main..release";
    const value = { ...invalid, token: "must-not-be-accepted" };
    const parsed = parseRepositoryBinding(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["unknown_field", "repo_id_mismatch", "invalid_value"]),
    );
    expect(parsed.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown_field", path: "token" }),
      expect.objectContaining({ code: "repo_id_mismatch", path: "repoId" }),
      expect.objectContaining({ code: "invalid_value", path: "integrationBranch" }),
    ]));
    expect(JSON.stringify(parsed.errors)).not.toContain("must-not-be-accepted");
  });

  it.each([".hidden", "feature/.hidden", "-danger", "feature.lock/child", "HEAD"])(
    "rejects Git refs forbidden by check-ref-format: %s",
    (integrationBranch) => {
      const parsed = parseRepositoryBinding({ ...repository(), integrationBranch });
      expect(parsed).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ code: "invalid_value", path: "integrationBranch" }),
        ]),
      });
    },
  );

  it.each([
    "roll/{workspace_id}/.hidden",
    "HEAD",
    "main",
    "roll/{workspace_id}/static",
    "roll/static/{story_id}",
    "roll/{workspace_id}{story_id}",
    "roll/{workspace_id}-{story_id}",
    "roll/{workspaceId}/{storyId}",
  ])(
    "rejects unsafe Git ref template %s after substituting supported identity tokens",
    (branchPattern) => {
      const parsed = parseRepositoryBinding({
        ...repository(),
        workflow: { ...repository().workflow, branchPattern },
      });
      expect(parsed).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ code: "invalid_value", path: "workflow.branchPattern" }),
        ]),
      });
    },
  );

  it("rejects unknown repository and nested Workspace fields with typed paths", () => {
    const bindingVersion = parseRepositoryBinding({ ...repository(), schema: "roll.repository-binding/v2" });
    expect(bindingVersion).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "unknown_version", path: "schema" })]),
    });
    const workflowField = parseWorkspaceManifest({
      ...workspace(),
      repositories: [{ ...repository(), workflow: { ...repository().workflow, credential: "forbidden" } }],
    }, {});
    expect(workflowField).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "unknown_field", path: "repositories[0].workflow.credential" }),
      ]),
    });
    const requirementField = parseWorkspaceManifest({
      ...workspace(),
      requirements: [{ provider: "jira", ref: "SOT-15499", status: "mutable" }],
    }, {});
    expect(requirementField).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "unknown_field", path: "requirements[0].status" }),
      ]),
    });
  });

  it.each([
    ["missing provider", { ref: "SOT-15499" }, "requirements[0].provider"],
    ["missing ref", { provider: "jira" }, "requirements[0].ref"],
    ["empty provider", { provider: "", ref: "SOT-15499" }, "requirements[0].provider"],
    ["empty ref", { provider: "jira", ref: "" }, "requirements[0].ref"],
    ["non-string provider", { provider: 42, ref: "SOT-15499" }, "requirements[0].provider"],
    ["non-string ref", { provider: "jira", ref: 42 }, "requirements[0].ref"],
  ])("rejects invalid Requirement Source %s", (_label, requirement, path) => {
    const results = [
      parseWorkspaceManifest({ ...workspace(), requirements: [requirement] }, {}),
      parseIssueManifest({ ...issue(), requirements: [requirement] }, {}),
    ];
    for (const parsed of results) {
      expect(parsed).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([expect.objectContaining({ code: "invalid_type", path })]),
      });
    }
  });

  it("rejects a duplicate repository alias at the alias path", () => {
    const repositories = [repository(), repository("https://github.com/Owner/Other.git")];
    const parsed = parseWorkspaceManifest({ ...workspace(), repositories }, {});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_identity", path: "repositories.alias" }),
    ]));
  });

  it("rejects duplicate canonical remote and its derived repository ID at both paths", () => {
    const repositories = [repository(), { ...repository("https://GITHUB.com/Owner/Repo"), alias: "other" }];
    const parsed = parseWorkspaceManifest({ ...workspace(), repositories }, {});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_identity", path: "repositories.repoId" }),
      expect.objectContaining({ code: "duplicate_identity", path: "repositories.remote" }),
    ]));
  });
});

describe("IssueManifest repository targets", () => {
  it("publishes a closed Issue schema", () => {
    expect(issueManifestV1Schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("keeps legacy v1 Issue manifests without workBranch or integration cwd readable", () => {
    const parsed = parseIssueManifest(issue(), {
      workspaceId: "ws-sot-platform",
      storyId: "US-WS-001",
    });
    expect(parsed).toEqual({ ok: true, value: issue() });
  });

  it("round-trips the persisted cross-repository integration command", () => {
    const manifest = {
      ...issue(),
      integrationAcceptance: { command: ["./verify-sot-contract.sh"] },
    };
    expect(parseIssueManifest(manifest, {})).toEqual({ ok: true, value: manifest });
  });

  it("round-trips new governed branches, explicit integration cwd, and campaign terminal", () => {
    const manifest = {
      ...issue(),
      repositories: [
        { ...issue().repositories[0], workBranch: "roll/ws-sot-platform/US-WS-001/product" },
        issue().repositories[1],
      ],
      integrationAcceptance: { command: ["pnpm", "test:integration"], cwd: "product" },
      deliveryTarget: { terminal: "campaign_branch", branch: "idea-074-workspace", mainMerge: "forbidden" },
    } as const;
    expect(parseIssueManifest(manifest, {})).toEqual({ ok: true, value: manifest });
  });

  it.each([
    ["read delivery", { repositories: [{ ...issue().repositories[1], requiredDelivery: true }] }, "repositories[0].requiredDelivery"],
    ["write policy", { repositories: [{ ...issue().repositories[0], noChangePolicy: undefined }] }, "repositories[0].noChangePolicy"],
    ["absolute path", { repositories: [{ ...issue().repositories[0], pathScope: ["/packages/spec"] }] }, "repositories[0].pathScope"],
    ["Windows absolute path", { repositories: [{ ...issue().repositories[0], pathScope: ["C:/packages/spec"] }] }, "repositories[0].pathScope"],
    ["traversal path", { repositories: [{ ...issue().repositories[0], pathScope: ["packages/../infra"] }] }, "repositories[0].pathScope"],
    ["backslash path", { repositories: [{ ...issue().repositories[0], pathScope: ["packages\\spec"] }] }, "repositories[0].pathScope"],
    ["drive-relative path", { repositories: [{ ...issue().repositories[0], pathScope: ["C:packages/spec"] }] }, "repositories[0].pathScope"],
    ["control path", { repositories: [{ ...issue().repositories[0], pathScope: ["packages/spec\n"] }] }, "repositories[0].pathScope"],
    ["unknown dependency", { repositories: [{ ...issue().repositories[0], dependsOnRepo: "missing" }] }, "repositories[0].dependsOnRepo"],
  ])("rejects malformed target semantics: %s", (_label, override, path) => {
    const parsed = parseIssueManifest({ ...issue(), ...override }, {});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_value", path })]));
  });

  it.each([
    ["access", { access: "admin" }, "invalid_value", "repositories[0].access"],
    ["no-change policy", { noChangePolicy: "best_effort" }, "invalid_value", "repositories[0].noChangePolicy"],
    ["delivery type", { requiredDelivery: "yes" }, "invalid_type", "repositories[0].requiredDelivery"],
    ["repo ID", { repoId: "repo-not-a-hash" }, "invalid_value", "repositories[0].repoId"],
    ["alias", { alias: "Unsafe_Alias" }, "invalid_value", "repositories[0].alias"],
    ["work branch", { workBranch: "../unsafe" }, "invalid_value", "repositories[0].workBranch"],
  ])("rejects malformed target field %s", (_label, targetOverride, code, path) => {
    const parsed = parseIssueManifest({
      ...issue(),
      repositories: [{ ...issue().repositories[0], ...targetOverride }],
    }, {});
    expect(parsed).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code, path })]),
    });
  });

  it("rejects repository dependency cycles", () => {
    const product = issue().repositories[0];
    const docs = {
      ...product,
      repoId: repository("https://github.com/Owner/Docs.git", "docs").repoId,
      alias: "credential-sentinel-b",
    };
    const parsed = parseIssueManifest({
      ...issue(),
      repositories: [
        { ...product, alias: "credential-sentinel-a", dependsOnRepo: "credential-sentinel-b" },
        { ...docs, dependsOnRepo: "credential-sentinel-a" },
      ],
    }, {});
    expect(parsed).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_value", path: "repositories[0].dependsOnRepo" }),
        expect.objectContaining({ code: "invalid_value", path: "repositories[1].dependsOnRepo" }),
      ]),
    });
    expect(JSON.stringify(parsed)).not.toContain("credential-sentinel");
  });

  it("reports dependency errors against original target indexes after malformed entries", () => {
    const parsed = parseIssueManifest({
      ...issue(),
      repositories: [
        { ...issue().repositories[0], access: "admin" },
        { ...issue().repositories[0], alias: "second", dependsOnRepo: "missing" },
      ],
    }, {});
    expect(parsed).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_value", path: "repositories[0].access" }),
        expect.objectContaining({ code: "invalid_value", path: "repositories[1].dependsOnRepo" }),
      ]),
    });
  });

  it("accepts an acyclic publish dependency between writable repository targets", () => {
    const product = issue().repositories[0];
    const docsRepository = repository("https://github.com/Owner/Docs.git", "docs");
    const docs = {
      repoId: docsRepository.repoId,
      alias: docsRepository.alias,
      access: "write" as const,
      requiredDelivery: false,
      noChangePolicy: "no_change_allowed" as const,
      dependsOnRepo: "product",
    };
    expect(parseIssueManifest({ ...issue(), repositories: [product, docs] }, {})).toMatchObject({
      ok: true,
      value: { repositories: [expect.objectContaining({ alias: "product" }), expect.objectContaining({ alias: "docs" })] },
    });
  });

  it("rejects publish dependencies from or to read-only repository targets", () => {
    const product = issue().repositories[0];
    const docs = issue().repositories[1];
    const readSource = parseIssueManifest({
      ...issue(),
      repositories: [product, { ...docs, dependsOnRepo: "product" }],
    }, {});
    expect(readSource).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_value", path: "repositories[1].dependsOnRepo" }),
      ]),
    });

    const writeToRead = parseIssueManifest({
      ...issue(),
      repositories: [{ ...product, dependsOnRepo: "docs" }, docs],
    }, {});
    expect(writeToRead).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_value", path: "repositories[0].dependsOnRepo" }),
      ]),
    });
  });

  it.each(["baseSha", "worktreePath", "branch", "status", "deliverySet"])(
    "rejects runtime or mutable Issue field %s",
    (field) => {
      const parsed = parseIssueManifest({ ...issue(), [field]: "forbidden" }, {});
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "unknown_field", path: field }),
      ]));
    },
  );

  it.each(["baseSha", "worktreePath", "branch", "delivery", "deliverySet"])(
    "rejects nested runtime or delivery target field %s",
    (field) => {
      const parsed = parseIssueManifest({
        ...issue(),
        repositories: [{ ...issue().repositories[0], [field]: { resolved: true } }],
      }, {});
      expect(parsed).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ code: "unknown_field", path: `repositories[0].${field}` }),
        ]),
      });
    },
  );

  it("rejects unknown Issue version and missing identities", () => {
    expect(parseIssueManifest({ ...issue(), schema: "roll.issue/v2" }, {})).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "unknown_version", path: "schema" })]),
    });
    const { workspaceId: _workspaceId, ...withoutWorkspace } = issue();
    const { storyId: _storyId, ...withoutStory } = issue();
    expect(parseIssueManifest(withoutWorkspace, {})).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "invalid_type", path: "workspaceId" })]),
    });
    expect(parseIssueManifest(withoutStory, {})).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "invalid_type", path: "storyId" })]),
    });
  });

  it("rejects duplicate target identity and expected ID mismatches", () => {
    const duplicate = issue().repositories[0];
    const parsed = parseIssueManifest(
      { ...issue(), repositories: [duplicate, { ...duplicate }] },
      { workspaceId: "ws-other", storyId: "US-OTHER-001" },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["duplicate_identity", "identity_mismatch"]),
    );
    expect(parsed.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_identity", path: "repositories.alias" }),
      expect.objectContaining({ code: "duplicate_identity", path: "repositories.repoId" }),
      expect.objectContaining({ code: "identity_mismatch", path: "workspaceId" }),
      expect.objectContaining({ code: "identity_mismatch", path: "storyId" }),
    ]));
  });

  it.each([
    ["workspaceId", { workspaceId: "ws-other" }, "workspaceId"],
    ["storyId", { storyId: "US-OTHER-001" }, "storyId"],
  ])("rejects expected %s mismatch at its exact path", (_label, expectations, path) => {
    const parsed = parseIssueManifest(issue(), expectations);
    expect(parsed).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "identity_mismatch", path })]),
    });
  });
});
