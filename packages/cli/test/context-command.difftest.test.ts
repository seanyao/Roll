import { join } from "node:path";
import {
  CONTEXT_PROVIDER_REGISTRY_V1,
  CONTEXT_READ_RESULT_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  type ContextProviderRegistryV1,
  type ContextReadResultV1,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { createContextReadService } from "@roll/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  contextCommand,
  type ContextCommandAuditEventV1,
  type ContextCommandDeps,
  type ContextReadServiceFactoryInput,
} from "../src/commands/context.js";

interface CapturedRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function workspace(): WorkspaceExecutionContextV1 {
  const root = "/workspaces/roll";
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: { workspaceId: "roll", root, canonicalRoot: root, lifecycle: "active" },
    resolution: { source: "explicit", evidence: [] },
    bindings: [{
      schema: REPOSITORY_BINDING_V1,
      repoId: "repo-roll",
      alias: "primary",
      remote: "https://github.com/seanyao/roll.git",
      integrationBranch: "main",
      provider: "github",
      workflow: { branchPattern: "roll/{workspaceId}/{storyId}", requiredChecks: [] },
    }],
    contexts: {
      enabled: true,
      bindings: [{ providerId: "enterprise-wiki", enabled: true, required: true, entrypoints: ["wiki/index.md"] }],
    },
    authorities: {
      backlog: join(root, "backlog", "index.md"),
      features: join(root, "features"),
      design: join(root, "design"),
      requirements: join(root, "requirements"),
      policy: join(root, "policy.yaml"),
      evidence: join(root, "evidence"),
      toolDumps: join(root, "artifacts", "tool-dumps"),
      events: join(root, "runtime", "events.ndjson"),
      runtime: join(root, "runtime"),
      locks: join(root, "runtime", "locks"),
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
      remote: "https://example.test/company/context.git",
      branch: "main",
      fetch_timeout_seconds: 30,
    }],
  };
}

function result(outcome: ContextReadResultV1["outcome"] = "completed"): ContextReadResultV1 {
  return {
    schema: CONTEXT_READ_RESULT_V1,
    snapshotId: "ctx_20260724T060000000Z_aaaaaaaaaaaa",
    snapshotDigest: "a".repeat(64),
    createdAt: "2026-07-24T06:00:00.000Z",
    artifactPath: "/workspaces/roll/runtime/context/US-CONTEXT-007/ctx_20260724T060000000Z_aaaaaaaaaaaa.json",
    outcome,
    requestScope: {
      workspaceId: "roll",
      storyId: "US-CONTEXT-007",
      repositoryIds: ["https://github.com/seanyao/roll"],
      environmentIds: ["sit"],
      stage: "qa",
    },
    providers: outcome === "disabled" || outcome === "blocked" ? [] : [{
      providerId: "enterprise-wiki",
      remoteIdentity: "https://example.test/company/context",
      branch: "main",
      fetchedAt: "2026-07-24T05:59:59.000Z",
      revision: "1".repeat(40),
      providerConfigDigest: "b".repeat(64),
      bindingDigest: "c".repeat(64),
      files: [{
        ref: "context://enterprise-wiki/wiki/index.md",
        path: "wiki/index.md",
        sha256: "d".repeat(64),
        bytes: 30,
        content: "# SECRET BODY MUST NOT REACH PLAIN OUTPUT\n",
      }],
      warnings: [],
    }],
    gaps: outcome === "partial"
      ? [{ code: "fetch_failed", severity: "gap", providerId: "optional-wiki", message: "Context Provider read failed" }]
      : outcome === "blocked"
        ? [{
            code: "restricted_context_denied",
            severity: "blocking",
            providerId: "enterprise-wiki",
            ref: "context://enterprise-wiki/wiki/accounts/test.md",
            message: "Restricted Context reference is not authorized",
          }]
        : [],
  };
}

function deps(overrides: Partial<ContextCommandDeps> = {}): ContextCommandDeps {
  return {
    resolveTarget: vi.fn(async () => ({ workspace: workspace() })),
    readRegistry: vi.fn(() => registry()),
    readLatestSnapshot: vi.fn(() => result()),
    createReadService: vi.fn(() => ({ read: vi.fn(async () => result()) })),
    authorizeRestrictedReference: vi.fn(() => false),
    writeSnapshot: vi.fn(),
    recordAudit: vi.fn(),
    now: () => Date.parse("2026-07-24T06:00:01.000Z"),
    ...overrides,
  };
}

function restrictedReadFactory(): ContextCommandDeps["createReadService"] {
  return (input) => createContextReadService({
    registry: input.registry,
    adapter: {
      read: vi.fn(async () => ({
        ok: true as const,
        revision: {
          providerId: "enterprise-wiki",
          remoteIdentity: "https://example.test/company/context",
          branch: "main",
          fetchedAt: "2026-07-24T05:59:59.000Z",
          revision: "1".repeat(40),
        },
        files: [{
          ref: "context://enterprise-wiki/wiki/accounts/test.md",
          path: "wiki/accounts/test.md",
          sha256: "d".repeat(64),
          bytes: 32,
          page: {
            schema: "roll.context-page/v1" as const,
            title: "Test account",
            page_type: "account_reference",
            status: "active" as const,
            confidence: "approved" as const,
            updated_at: "2026-07-24",
            scope: {},
            sources: ["secret://accounts/test"],
            sensitivity: "restricted_reference" as const,
          },
          content: "credential_ref: secret://accounts/test\n",
        }],
        warnings: [],
      })),
    },
    authorizeRestrictedReference: (_request, file) => input.authorizeRestrictedReference(file),
    now: () => Date.parse("2026-07-24T06:00:00.000Z"),
  });
}

async function capture(args: string[], commandDeps: ContextCommandDeps): Promise<CapturedRun> {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture seam
  process.stdout.write = (chunk: string | Uint8Array): boolean => { stdout += String(chunk); return true; };
  // @ts-expect-error test capture seam
  process.stderr.write = (chunk: string | Uint8Array): boolean => { stderr += String(chunk); return true; };
  try {
    return { status: await contextCommand(args, commandDeps), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

beforeEach(() => {
  process.env["NO_COLOR"] = "1";
  process.env["ROLL_LANG"] = "en";
});

describe("US-CONTEXT-007 context command snapshots", () => {
  it("renders localized command and subcommand help without resolving Workspace or reading Context", async () => {
    const commandDeps = deps();
    const en = await capture(["--help"], commandDeps);
    const statusEn = await capture(["status", "--help"], commandDeps);
    const readEn = await capture(["read", "--help"], commandDeps);
    process.env["ROLL_LANG"] = "zh";
    const zh = await capture(["--help"], commandDeps);
    const statusZh = await capture(["status", "--help"], commandDeps);
    const readZh = await capture(["read", "--help"], commandDeps);

    expect(en).toMatchSnapshot("help-en");
    expect(statusEn).toMatchSnapshot("status-help-en");
    expect(readEn).toMatchSnapshot("read-help-en");
    expect(zh).toMatchSnapshot("help-zh");
    expect(statusZh).toMatchSnapshot("status-help-zh");
    expect(readZh).toMatchSnapshot("read-help-zh");
    expect(statusEn.stdout).not.toContain("--allow-restricted");
    expect(readEn.stdout).toContain("--allow-restricted");
    expect(readEn.stdout).toContain("Exit codes: 0=completed/disabled, 3=partial, 2=blocked/error");
    expect(commandDeps.resolveTarget).not.toHaveBeenCalled();
    expect(commandDeps.createReadService).not.toHaveBeenCalled();
  });

  it("status is local-only, names the freshness limitation and never creates a read service", async () => {
    const commandDeps = deps();
    const plain = await capture(["status", "--workspace", "roll"], commandDeps);
    const json = await capture(["status", "--workspace", "roll", "--json"], commandDeps);

    expect(plain).toMatchSnapshot("status-plain-en");
    expect(json).toMatchSnapshot("status-json");
    expect(commandDeps.createReadService).not.toHaveBeenCalled();
    expect(commandDeps.writeSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", 0],
    ["disabled", 0],
    ["partial", 3],
    ["blocked", 2],
  ] as const)("maps %s to exit %i and keeps plain page bodies off stdout", async (outcome, exit) => {
    const commandDeps = deps({
      createReadService: vi.fn(() => ({ read: vi.fn(async () => result(outcome)) })),
    });
    const run = await capture([
      "read", "--workspace", "roll", "--story", "US-CONTEXT-007", "--stage", "qa",
      "--environment", "sit", "--ref", "context://enterprise-wiki/wiki/index.md",
    ], commandDeps);

    expect(run.status).toBe(exit);
    expect(run.stdout).not.toContain("SECRET BODY");
    expect(run).toMatchSnapshot(`read-${outcome}-plain-en`);
  });

  it("prints the complete versioned result on JSON stdout without human progress on stderr", async () => {
    const run = await capture([
      "read", "--workspace", "roll", "--story", "US-CONTEXT-007", "--stage", "qa",
      "--environment", "sit", "--ref", "context://enterprise-wiki/wiki/index.md", "--json",
    ], deps());

    expect(JSON.parse(run.stdout)).toMatchObject({
      schema: CONTEXT_READ_RESULT_V1,
      providers: [{ files: [{ content: expect.stringContaining("SECRET BODY") }] }],
    });
    expect(run.stderr).not.toContain("SECRET BODY");
    expect(run).toMatchSnapshot("read-completed-json");
  });

  it.each([
    { name: "explicit intent plus policy authorization", allow: true, policy: true, exit: 0, outcome: "completed", calls: 1 },
    { name: "explicit intent without policy authorization", allow: true, policy: false, exit: 2, outcome: "blocked", calls: 1 },
    { name: "policy authorization without explicit intent", allow: false, policy: true, exit: 2, outcome: "blocked", calls: 0 },
  ])("enforces the restricted-reference three-gate contract: $name", async ({ allow, policy, exit, outcome, calls }) => {
    const authorizeRestrictedReference = vi.fn(() => policy);
    const commandDeps = deps({
      createReadService: restrictedReadFactory(),
      authorizeRestrictedReference,
    });
    const args = [
      "read", "--workspace", "roll", "--story", "US-CONTEXT-007", "--stage", "qa",
      "--ref", "context://enterprise-wiki/wiki/accounts/test.md", "--json",
      ...(allow ? ["--allow-restricted"] : []),
    ];

    const run = await capture(args, commandDeps);

    expect(run.status).toBe(exit);
    expect(JSON.parse(run.stdout)).toMatchObject({ outcome });
    expect(authorizeRestrictedReference).toHaveBeenCalledTimes(calls);
  });

  it("creates a fresh service per read invocation and emits metadata-only audit events", async () => {
    const audits: ContextCommandAuditEventV1[] = [];
    const factory = vi.fn(() => ({ read: vi.fn(async () => result()) }));
    const commandDeps = deps({ createReadService: factory, recordAudit: (event) => { audits.push(event); } });
    const args = ["read", "--workspace", "roll", "--story", "US-CONTEXT-007", "--stage", "qa"];

    expect((await capture(args, commandDeps)).status).toBe(0);
    expect((await capture(args, commandDeps)).status).toBe(0);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      type: "context:read",
      workspaceId: "roll",
      providerId: "enterprise-wiki",
      branch: "main",
      fetchOutcome: "completed",
      revision: "1".repeat(40),
      bytes: 30,
      diagnosticCodes: [],
    });
    expect(JSON.stringify(audits)).not.toMatch(/SECRET BODY|accounts\/test|credential|token/u);
  });

  it("retains transport revision and bytes when post-fetch policy blocks the Provider", async () => {
    const audits: ContextCommandAuditEventV1[] = [];
    const commandDeps = deps({
      createReadService: vi.fn((input) => ({
        read: vi.fn(async () => {
          input.audit({
            type: "context:git-llm-wiki-read",
            providerId: "enterprise-wiki",
            remoteIdentity: "https://example.test/company/context",
            branch: "main",
            startedAt: "2026-07-24T05:59:59.000Z",
            finishedAt: "2026-07-24T06:00:00.000Z",
            durationMs: 1_000,
            outcome: "completed",
            revision: "1".repeat(40),
            bytes: 30,
          } as Parameters<ContextReadServiceFactoryInput["audit"]>[0] & { readonly bytes: number });
          return result("blocked");
        }),
      })),
      recordAudit: (event) => { audits.push(event); },
    });

    const run = await capture([
      "read", "--workspace", "roll", "--story", "US-CONTEXT-007", "--stage", "qa", "--allow-restricted",
    ], commandDeps);

    expect(run.status).toBe(2);
    expect(audits).toEqual([expect.objectContaining({
      providerId: "enterprise-wiki",
      fetchOutcome: "completed",
      revision: "1".repeat(40),
      bytes: 30,
      diagnosticCodes: ["restricted_context_denied"],
    })]);
    expect(JSON.stringify(audits)).not.toMatch(/SECRET BODY|accounts\/test|credential|token/u);
  });

  it("keeps JSON runtime errors independently parseable on stderr", async () => {
    const run = await capture([
      "read", "--workspace", "roll", "--story", "US-CONTEXT-007", "--stage", "qa", "--json",
    ], deps({ createReadService: vi.fn(() => ({ read: vi.fn(async () => { throw new Error("secret failure"); }) })) }));

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(JSON.parse(run.stderr)).toMatchObject({ schema: "roll.context-command-error/v1", code: "read_failure" });
    expect(run.stderr).not.toMatch(/fetching fresh|secret failure/u);
  });

  it("puts versioned usage and target errors on stderr with exit 2", async () => {
    const invalid = await capture(["read", "--workspace", "roll"], deps());
    const target = await capture(["status", "--workspace", "missing", "--json"], deps({
      resolveTarget: vi.fn(async () => ({ error: { code: "target_missing" } })),
    }));

    expect(invalid).toMatchSnapshot("invalid-arguments-en");
    expect(target).toMatchSnapshot("target-error-json");
    expect(invalid.status).toBe(2);
    expect(target.status).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(target.stdout).toBe("");
  });
});
