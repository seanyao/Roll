import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_PROVIDER_REGISTRY_V1,
  CONTEXT_READ_REQUEST_V1,
  CONTEXT_READ_RESULT_V1,
  ISSUE_MANIFEST_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  repositoryIdFromRemote,
  type ContextReadRequestV1,
  type ContextReadResultV1,
} from "@roll/spec";
import { createContextReadService } from "@roll/core";
import { WorkspaceRegistry, writeContextSnapshot } from "@roll/infra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contextCommand,
  createContextCommandDeps,
  type ContextCommandAuditEventV1,
  type ContextCommandDeps,
} from "../src/commands/context.js";

const sandboxes: string[] = [];
let originalWorkspace: string | undefined;

interface Fixture {
  readonly home: string;
  readonly rollHome: string;
  readonly workspace: string;
  readonly outside: string;
  readonly repoId: string;
}

interface CapturedRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "roll-context-command-e2e-"));
  sandboxes.push(home);
  const rollHome = join(home, ".roll");
  const workspace = join(home, "workspace");
  const outside = join(home, "outside");
  mkdirSync(rollHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const remote = "https://example.test/acme/product.git";
  const id = repositoryIdFromRemote(remote);
  if (!id.ok) throw new Error("fixture remote must be valid");
  writeFileSync(join(workspace, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId: "ws-context",
    displayName: "Context Workspace",
    requirements: [],
    repositories: [{
      schema: REPOSITORY_BINDING_V1,
      repoId: id.value,
      alias: "primary",
      remote,
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
    contexts: {
      enabled: true,
      bindings: [{ providerId: "enterprise-wiki", enabled: true, required: true, entrypoints: ["wiki/index.md"] }],
    },
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(rollHome, "context-providers.yaml"), [
    "schema: roll.context-providers/v1",
    "enabled: true",
    "providers:",
    "  - id: enterprise-wiki",
    "    type: git_llm_wiki",
    "    enabled: true",
    "    remote: https://example.test/acme/context.git",
    "    branch: main",
    "    fetch_timeout_seconds: 30",
    "",
  ].join("\n"), "utf8");
  const registry = new WorkspaceRegistry({ rollHome });
  registry.register({ workspaceId: "ws-context", root: workspace });
  registry.activate("ws-context");
  return { home, rollHome, workspace, outside, repoId: id.value };
}

function result(request: ContextReadRequestV1, ordinal: number): ContextReadResultV1 {
  const snapshotId = `ctx_20260724T06000${ordinal}000Z_${String(ordinal).repeat(12)}`;
  return {
    schema: CONTEXT_READ_RESULT_V1,
    snapshotId,
    snapshotDigest: String(ordinal).repeat(64),
    createdAt: `2026-07-24T06:00:0${ordinal}.000Z`,
    artifactPath: join(request.workspace.authorities.runtime, "context", request.storyId ?? "_workspace", `${snapshotId}.json`),
    outcome: "completed",
    requestScope: {
      workspaceId: request.workspace.workspace.workspaceId,
      ...(request.storyId === undefined ? {} : { storyId: request.storyId }),
      repositoryIds: request.workspace.bindings.map((binding) => binding.remote),
      environmentIds: request.environmentIds ?? [],
      stage: request.stage,
    },
    providers: [{
      providerId: "enterprise-wiki",
      remoteIdentity: "https://example.test/acme/context",
      branch: "main",
      fetchedAt: `2026-07-24T06:00:0${ordinal}.000Z`,
      revision: "1".repeat(40),
      providerConfigDigest: "a".repeat(64),
      bindingDigest: "b".repeat(64),
      files: [{
        ref: "context://enterprise-wiki/wiki/index.md",
        path: "wiki/index.md",
        sha256: "c".repeat(64),
        bytes: 31,
        content: "# PRIVATE CONTEXT BODY FOR JSON ONLY\n",
      }],
      warnings: [],
    }],
    gaps: [],
  };
}

async function capture(args: string[], deps: ContextCommandDeps): Promise<CapturedRun> {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture seam
  process.stdout.write = (chunk: string | Uint8Array): boolean => { stdout += String(chunk); return true; };
  // @ts-expect-error test capture seam
  process.stderr.write = (chunk: string | Uint8Array): boolean => { stderr += String(chunk); return true; };
  try {
    return { status: await contextCommand(args, deps), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

beforeEach(() => {
  originalWorkspace = process.env["ROLL_WORKSPACE"];
  delete process.env["ROLL_WORKSPACE"];
  process.env["ROLL_LANG"] = "en";
  process.env["NO_COLOR"] = "1";
});

afterEach(() => {
  if (originalWorkspace === undefined) delete process.env["ROLL_WORKSPACE"];
  else process.env["ROLL_WORKSPACE"] = originalWorkspace;
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-CONTEXT-007 context command E2E", () => {
  it("defaults the production operation-policy seam to deny and honors explicit authorization", async () => {
    const f = fixture();
    const defaultDeps = createContextCommandDeps({ rollHome: f.rollHome, cwd: () => f.outside });
    const target = await defaultDeps.resolveTarget("ws-context");
    if ("error" in target) throw new Error(target.error.code);
    const request: ContextReadRequestV1 = {
      schema: CONTEXT_READ_REQUEST_V1,
      workspace: target.workspace,
      storyId: "US-CONTEXT-007",
      stage: "qa",
      refs: ["context://enterprise-wiki/wiki/index.md"],
    };
    const file = result(request, 1).providers[0]!.files[0]!;
    const policy = vi.fn(() => true);
    const allowedDeps = createContextCommandDeps({
      rollHome: f.rollHome,
      cwd: () => f.outside,
      authorizeRestrictedReference: policy,
    });

    expect(defaultDeps.authorizeRestrictedReference(request, file)).toBe(false);
    expect(allowedDeps.authorizeRestrictedReference(request, file)).toBe(true);
    expect(policy).toHaveBeenCalledWith(request, file);
  });

  it("status reads an immutable local snapshot reference without fetching", async () => {
    const f = fixture();
    const deps = createContextCommandDeps({ rollHome: f.rollHome, cwd: () => f.outside });
    const target = await deps.resolveTarget("ws-context");
    if ("error" in target) throw new Error(target.error.code);
    const registry = {
      schema: CONTEXT_PROVIDER_REGISTRY_V1,
      enabled: true,
      providers: [{
        id: "enterprise-wiki",
        type: "git_llm_wiki" as const,
        enabled: true,
        remote: "https://example.test/acme/context.git",
        branch: "main",
        fetch_timeout_seconds: 30,
      }],
    };
    const adapterRead = vi.fn(async () => ({
      ok: true as const,
      revision: {
        providerId: "enterprise-wiki",
        remoteIdentity: "https://example.test/acme/context",
        branch: "main",
        fetchedAt: "2026-07-24T06:00:00.000Z",
        revision: "1".repeat(40),
      },
      files: [{
        ref: "context://enterprise-wiki/wiki/index.md",
        path: "wiki/index.md",
        sha256: "c".repeat(64),
        bytes: 31,
        content: "# LOCAL SNAPSHOT BODY MUST STAY HIDDEN\n",
      }],
      warnings: [],
    }));
    const service = createContextReadService({
      registry,
      adapter: { read: adapterRead },
      now: () => Date.parse("2026-07-24T06:00:00.000Z"),
    });
    const snapshot = await service.read({
      schema: CONTEXT_READ_REQUEST_V1,
      workspace: target.workspace,
      storyId: "US-CONTEXT-007",
      stage: "qa",
      environmentIds: ["sit"],
      refs: ["context://enterprise-wiki/wiki/index.md"],
    });
    writeContextSnapshot(target.workspace, snapshot);
    adapterRead.mockClear();

    const plain = await capture(["status", "--workspace", "ws-context"], deps);
    const json = await capture(["status", "--workspace", "ws-context", "--json"], deps);

    expect(plain.status).toBe(0);
    expect(plain.stderr).toBe("");
    expect(plain.stdout).toContain("not remote freshness proof (no fetch)");
    expect(plain.stdout).toContain(snapshot.snapshotId);
    expect(plain.stdout).not.toContain("LOCAL SNAPSHOT BODY");
    expect(JSON.parse(json.stdout)).toMatchObject({
      schema: "roll.context-status/v1",
      freshness: { source: "local_only", fetched: false, remoteFreshnessProof: false },
      latestSnapshot: {
        snapshotId: snapshot.snapshotId,
        providers: [{ providerId: "enterprise-wiki", revision: "1".repeat(40), bytes: 31 }],
      },
    });
    expect(JSON.stringify(JSON.parse(json.stdout))).not.toContain("LOCAL SNAPSHOT BODY");
    expect(adapterRead).not.toHaveBeenCalled();
  });

  it("reads from an arbitrary cwd through the real Workspace resolver without cwd pollution", async () => {
    const f = fixture();
    const audits: ContextCommandAuditEventV1[] = [];
    let ordinal = 0;
    const factory = vi.fn(() => ({
      read: vi.fn(async (request: ContextReadRequestV1) => result(request, ++ordinal)),
    }));
    let clock = Date.parse("2026-07-24T06:00:00.000Z");
    const deps = createContextCommandDeps({
      rollHome: f.rollHome,
      cwd: () => f.outside,
      now: () => clock++,
      createReadService: factory,
      writeSnapshot: vi.fn(),
      recordAudit: (event) => { audits.push(event); },
    });
    const args = [
      "read", "--workspace", "ws-context", "--story", "US-CONTEXT-007", "--stage", "qa",
      "--environment", "sit", "--ref", "context://enterprise-wiki/wiki/index.md",
    ];

    const first = await capture(args, deps);
    const second = await capture(args, deps);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toContain("Provider: enterprise-wiki · branch main · revision");
    expect(first.stdout).toContain("Snapshot: ctx_20260724T060001000Z_111111111111");
    expect(second.stdout).toContain("Snapshot: ctx_20260724T060002000Z_222222222222");
    expect(first.stdout).toContain("workspace=ws-context story=US-CONTEXT-007 stage=qa environments=sit");
    expect(first.stdout).not.toContain("PRIVATE CONTEXT BODY");
    expect(first.stderr).toBe("context: fetching fresh Provider content...\n");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      workspaceId: "ws-context",
      storyId: "US-CONTEXT-007",
      providerId: "enterprise-wiki",
      branch: "main",
      revision: "1".repeat(40),
      bytes: 31,
      diagnosticCodes: [],
    });
    expect(JSON.stringify(audits)).not.toMatch(/PRIVATE CONTEXT BODY|context:\/\/|credential|token/u);
    expect(existsSync(join(f.outside, ".roll"))).toBe(false);
  });

  it("fails loud when --story conflicts with the Issue discovered from cwd", async () => {
    const f = fixture();
    const issueRoot = join(f.workspace, "issues", "US-CONTEXT-007");
    const issueCwd = join(issueRoot, "primary", "src");
    mkdirSync(issueCwd, { recursive: true });
    writeFileSync(join(issueRoot, "manifest.json"), `${JSON.stringify({
      schema: ISSUE_MANIFEST_V1,
      workspaceId: "ws-context",
      storyId: "US-CONTEXT-007",
      requirements: [],
      repositories: [{
        repoId: f.repoId,
        alias: "primary",
        access: "write",
        requiredDelivery: true,
        noChangePolicy: "changes_required",
      }],
    }, null, 2)}\n`, "utf8");
    let ordinal = 0;
    const factory = vi.fn(() => ({ read: vi.fn(async (request: ContextReadRequestV1) => result(request, ++ordinal)) }));
    const deps = createContextCommandDeps({
      rollHome: f.rollHome,
      cwd: () => issueCwd,
      createReadService: factory,
      writeSnapshot: vi.fn(),
      recordAudit: vi.fn(),
    });
    expect(await deps.resolveTarget("ws-context")).toMatchObject({ issueStoryId: "US-CONTEXT-007" });

    const equivalent = await capture([
      "read", "--workspace", "ws-context", "--story", "us-context-007", "--stage", "qa", "--json",
    ], deps);
    const run = await capture([
      "read", "--workspace", "ws-context", "--story", "US-CONTEXT-999", "--stage", "qa", "--json",
    ], deps);
    const invalid = await capture([
      "read", "--workspace", "ws-context", "--story", "../US-CONTEXT-007", "--stage", "qa", "--json",
    ], deps);

    expect(equivalent.status).toBe(0);
    expect(JSON.parse(equivalent.stdout)).toMatchObject({ requestScope: { storyId: "US-CONTEXT-007" } });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(JSON.parse(run.stderr)).toMatchObject({
      schema: "roll.context-command-error/v1",
      code: "story_conflict",
    });
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ code: "invalid_arguments" });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(existsSync(join(issueCwd, ".roll"))).toBe(false);
  });
});
