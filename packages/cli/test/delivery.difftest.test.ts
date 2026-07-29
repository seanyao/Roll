import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISSUE_MANIFEST_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  integrationAcceptanceCommandDigest,
  repositoryIdFromRemote,
} from "@roll/spec";
import {
  WorkspaceRegistry,
  appendIssueIntegrationAcceptanceEvidence,
  appendRepositoryMergeEvidence,
  captureRequirementSource,
} from "@roll/infra";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import { expectNoAdjacentBilingualPairs } from "./helpers.js";

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Fixture {
  readonly home: string;
  readonly rollHome: string;
}

interface WorkspaceFixture {
  readonly root: string;
  readonly workspaceId: string;
  readonly apiRepoId: string;
  readonly webRepoId: string;
}

const roots: string[] = [];
const ENV_KEYS = ["HOME", "ROLL_HOME", "ROLL_LANG", "NO_COLOR", "ROLL_WORKSPACE"] as const;
const API_SHA = "a".repeat(40);
const WEB_SHA = "b".repeat(40);
const ACCEPTANCE_COMMAND = ["pnpm", "test:integration"] as const;

function fixture(): Fixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "roll-delivery-cli-")));
  roots.push(home);
  const rollHome = join(home, ".roll");
  mkdirSync(rollHome, { recursive: true });
  return { home, rollHome };
}

function repoId(remote: string): string {
  const result = repositoryIdFromRemote(remote);
  if (!result.ok) throw new Error("fixture remote must be valid");
  return result.value;
}

function createWorkspace(f: Fixture, workspaceId: string): WorkspaceFixture {
  const root = join(f.home, workspaceId);
  mkdirSync(root, { recursive: true });
  const apiRemote = `https://example.test/${workspaceId}/api.git`;
  const webRemote = `https://example.test/${workspaceId}/web.git`;
  const apiRepoId = repoId(apiRemote);
  const webRepoId = repoId(webRemote);
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId,
    displayName: workspaceId,
    requirements: [],
    repositories: [
      {
        schema: REPOSITORY_BINDING_V1,
        repoId: apiRepoId,
        alias: "api",
        remote: apiRemote,
        integrationBranch: "main",
        provider: "generic",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      },
      {
        schema: REPOSITORY_BINDING_V1,
        repoId: webRepoId,
        alias: "web",
        remote: webRemote,
        integrationBranch: "main",
        provider: "generic",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      },
    ],
  }, null, 2)}\n`, "utf8");
  const registry = new WorkspaceRegistry({ rollHome: f.rollHome });
  registry.register({ workspaceId, root });
  registry.activate(workspaceId);
  return { root, workspaceId, apiRepoId, webRepoId };
}

function writeIssueManifest(workspace: WorkspaceFixture, storyId: string): string {
  const issueRoot = join(workspace.root, "issues", storyId);
  mkdirSync(join(issueRoot, "evidence"), { recursive: true });
  writeFileSync(join(issueRoot, "manifest.json"), `${JSON.stringify({
    schema: ISSUE_MANIFEST_V1,
    workspaceId: workspace.workspaceId,
    storyId,
    requirements: [],
    repositories: [
      { repoId: workspace.apiRepoId, alias: "api", access: "write", requiredDelivery: true, noChangePolicy: "changes_required" },
      { repoId: workspace.webRepoId, alias: "web", access: "write", requiredDelivery: true, noChangePolicy: "changes_required" },
    ],
    integrationAcceptance: { command: ACCEPTANCE_COMMAND },
  }, null, 2)}\n`, "utf8");
  return issueRoot;
}

function providerFact(
  workspace: WorkspaceFixture,
  storyId: string,
  repoIdValue: string,
  recordedAt: number,
  input: {
    readonly prNumber: number;
    readonly prState: "OPEN" | "MERGED";
    readonly ci: "green" | "pending";
    readonly mergeCommit?: string;
  },
): void {
  appendRepositoryMergeEvidence(join(workspace.root, "issues", storyId), {
    workspaceId: workspace.workspaceId,
    storyId,
    repoId: repoIdValue,
    cycleId: `cycle-${storyId}-${input.prNumber}`,
    authority: "provider",
    prNumber: input.prNumber,
    prState: input.prState,
    ci: input.ci,
    ...(input.mergeCommit === undefined ? {} : { mergeCommit: input.mergeCommit }),
    recordedAt,
  });
}

function createPartialIssue(workspace: WorkspaceFixture, storyId: string): void {
  writeIssueManifest(workspace, storyId);
  providerFact(workspace, storyId, workspace.apiRepoId, 10, {
    prNumber: 101,
    prState: "MERGED",
    ci: "green",
    mergeCommit: API_SHA,
  });
  providerFact(workspace, storyId, workspace.webRepoId, 11, {
    prNumber: 102,
    prState: "OPEN",
    ci: "pending",
  });
}

function createIntegrationPendingIssue(workspace: WorkspaceFixture, storyId: string): void {
  writeIssueManifest(workspace, storyId);
  providerFact(workspace, storyId, workspace.apiRepoId, 20, {
    prNumber: 201,
    prState: "MERGED",
    ci: "green",
    mergeCommit: API_SHA,
  });
  providerFact(workspace, storyId, workspace.webRepoId, 21, {
    prNumber: 202,
    prState: "MERGED",
    ci: "green",
    mergeCommit: WEB_SHA,
  });
}

function createDeliveredIssue(workspace: WorkspaceFixture, storyId: string): void {
  createIntegrationPendingIssue(workspace, storyId);
  const issueRoot = join(workspace.root, "issues", storyId);
  writeFileSync(join(issueRoot, "evidence", "integration.txt"), "integration passed\n", "utf8");
  appendIssueIntegrationAcceptanceEvidence(issueRoot, {
    workspaceId: workspace.workspaceId,
    storyId,
    inputMergeCommits: {
      [workspace.apiRepoId]: API_SHA,
      [workspace.webRepoId]: WEB_SHA,
    },
    commandDigest: integrationAcceptanceCommandDigest(ACCEPTANCE_COMMAND),
    profile: "local-multi-repo",
    verdict: "pass",
    artifactPath: "evidence/integration.txt",
    recordedAt: 22,
  });
}

function captureRequirement(rollHome: string, workspace: WorkspaceFixture, storyId: string, ref: string): string {
  const manifestPath = join(workspace.root, "workspace.yaml");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest["requirements"] = [{ provider: "jira", ref }];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const backlogPath = join(workspace.root, "backlog", "index.md");
  mkdirSync(join(workspace.root, "backlog"), { recursive: true });
  writeFileSync(backlogPath, `| ${storyId} | requirement-linked delivery | 📋 Todo |\n`, "utf8");
  mkdirSync(join(workspace.root, "backlog", storyId), { recursive: true });
  writeFileSync(join(workspace.root, "backlog", storyId, "spec.md"), `# ${storyId}\n`, "utf8");
  const bodyFile = join(workspace.root, `${storyId}.md`);
  writeFileSync(bodyFile, `# ${storyId}\n`, "utf8");
  return captureRequirementSource({
    rollHome,
    workspaceRoot: workspace.root,
    provider: "jira",
    ref,
    revision: "1",
    capturedAt: "2026-07-23T00:00:00.000Z",
    bodyFile,
    contextPaths: [],
    storyIds: [storyId],
  }).requirementPath;
}

async function runCli(argv: string[], f: Fixture, language: "en" | "zh" = "en"): Promise<Run> {
  const saved: Partial<Record<typeof ENV_KEYS[number], string>> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) saved[key] = value;
    delete process.env[key];
  }
  process.env["HOME"] = f.home;
  process.env["ROLL_HOME"] = f.rollHome;
  process.env["ROLL_LANG"] = language;
  process.env["NO_COLOR"] = "1";
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const originalCwd = process.cwd();
  // @ts-expect-error capture for deterministic CLI tests
  process.stdout.write = (chunk: string | Uint8Array): boolean => ((stdout += String(chunk)), true);
  // @ts-expect-error capture for deterministic CLI tests
  process.stderr.write = (chunk: string | Uint8Array): boolean => ((stderr += String(chunk)), true);
  try {
    process.chdir(f.home);
    const result = await dispatch(argv, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function scrub(run: Run, workspaceRoots: readonly string[]): Run {
  const replace = (value: string): string => workspaceRoots.reduce((text, root, index) => {
    const canonical = realpathSync(root);
    return text.replaceAll(canonical, `<WS_${index + 1}>`).replaceAll(root, `<WS_${index + 1}>`);
  }, value).replace(/("discoveryFactsSha256":\s*")[0-9a-f]{64}(")/g, "$1<SHA256>$2");
  return { ...run, stdout: replace(run.stdout), stderr: replace(run.stderr) };
}

beforeEach(() => registerAll());

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-WS-015 roll delivery surface", () => {
  it("freezes locale-specific help without adjacent bilingual output", async () => {
    const f = fixture();
    const en = await runCli(["delivery", "--help"], f, "en");
    const zh = await runCli(["delivery", "--help"], f, "zh");
    const loopEn = await runCli(["loop", "reconcile", "--help"], f, "en");
    const loopZh = await runCli(["loop", "reconcile", "--help"], f, "zh");
    expect(en.status).toBe(0);
    expect(zh.status).toBe(0);
    expect(loopEn.status).toBe(0);
    expect(loopZh.status).toBe(0);
    expectNoAdjacentBilingualPairs(en.stdout);
    expectNoAdjacentBilingualPairs(zh.stdout);
    expectNoAdjacentBilingualPairs(loopEn.stdout);
    expectNoAdjacentBilingualPairs(loopZh.stdout);
    expect(loopEn.stdout).toContain("roll loop reconcile");
    expect(loopZh.stdout).toContain("roll loop reconcile");
    expect({ en: en.stdout, zh: zh.stdout, loopEn: loopEn.stdout, loopZh: loopZh.stdout }).toMatchSnapshot();
  });

  it("freezes stable list/show JSON with every required repository fact and exact-SHA acceptance", async () => {
    const f = fixture();
    const alpha = createWorkspace(f, "ws-alpha");
    createPartialIssue(alpha, "US-PARTIAL");
    createIntegrationPendingIssue(alpha, "US-INTEGRATION");
    createDeliveredIssue(alpha, "US-DELIVERED");

    const list = scrub(await runCli(["delivery", "list", "--workspace", "ws-alpha", "--json"], f), [alpha.root]);
    const show = await runCli(["delivery", "show", "US-DELIVERED", "--workspace", "ws-alpha", "--json"], f);
    expect(list.status, list.stderr).toBe(0);
    expect(show.status, show.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({
      schema: "roll.delivery-list/v1",
      workspaces: [{
        workspaceId: "ws-alpha",
        issues: [
          { storyId: "US-DELIVERED", state: "delivered" },
          { storyId: "US-INTEGRATION", state: "integration_pending" },
          { storyId: "US-PARTIAL", state: "partial_delivery" },
        ],
      }],
    });
    expect(JSON.parse(show.stdout)).toMatchObject({
      schema: "roll.delivery-view/v1",
      issue: {
        workspaceId: "ws-alpha",
        storyId: "US-DELIVERED",
        state: "delivered",
        repositories: [
          { alias: "api", status: "merged", facts: [{ authority: "provider", prNumber: 201, prState: "MERGED", ci: "green", mergeCommit: API_SHA }] },
          { alias: "web", status: "merged", facts: [{ authority: "provider", prNumber: 202, prState: "MERGED", ci: "green", mergeCommit: WEB_SHA }] },
        ],
        integrationAcceptance: {
          status: "pass",
          inputMergeCommits: { [alpha.apiRepoId]: API_SHA, [alpha.webRepoId]: WEB_SHA },
          artifactPath: "evidence/integration.txt",
        },
        outstandingGates: [],
      },
    });
    expect({ list: JSON.parse(list.stdout), show: JSON.parse(show.stdout) }).toMatchSnapshot();
  });

  it("names partial, integration-pending and delivered gates in each locale", async () => {
    const enFixture = fixture();
    const enWorkspace = createWorkspace(enFixture, "ws-en");
    createPartialIssue(enWorkspace, "US-PARTIAL");
    createIntegrationPendingIssue(enWorkspace, "US-INTEGRATION");
    createDeliveredIssue(enWorkspace, "US-DELIVERED");
    const zhFixture = fixture();
    const zhWorkspace = createWorkspace(zhFixture, "ws-zh");
    createPartialIssue(zhWorkspace, "US-PARTIAL");
    createIntegrationPendingIssue(zhWorkspace, "US-INTEGRATION");
    createDeliveredIssue(zhWorkspace, "US-DELIVERED");

    const en = await runCli(["delivery", "list", "--workspace", "ws-en"], enFixture, "en");
    const zh = await runCli(["delivery", "list", "--workspace", "ws-zh"], zhFixture, "zh");
    expect(en.status).toBe(0);
    expect(zh.status).toBe(0);
    expect(en.stdout).toContain("partial_delivery");
    expect(en.stdout).toContain("integration_pending");
    expect(en.stdout).toContain("delivered");
    expect(en.stdout).toContain(`repository:${enWorkspace.webRepoId}:awaiting_merge`);
    expect(en.stdout).toContain("integration_acceptance:missing");
    expectNoAdjacentBilingualPairs(en.stdout);
    expectNoAdjacentBilingualPairs(zh.stdout);
    expect({ en: en.stdout, zh: zh.stdout }).toMatchSnapshot();
  });

  it("aggregates --all read-only and fails loud for ambiguity, mutation --all and missing Issue", async () => {
    const f = fixture();
    const alpha = createWorkspace(f, "ws-alpha");
    const beta = createWorkspace(f, "ws-beta");
    createPartialIssue(alpha, "US-A");
    createDeliveredIssue(beta, "US-B");

    const all = scrub(await runCli(["delivery", "list", "--all", "--json"], f), [alpha.root, beta.root]);
    const ambiguous = scrub(await runCli(["delivery", "list", "--json"], f), [alpha.root, beta.root]);
    const mutationAll = await runCli(["delivery", "reconcile", "--all", "--json"], f);
    const missing = await runCli(["delivery", "show", "US-MISSING", "--workspace", "ws-alpha", "--json"], f);
    expect(all.status).toBe(0);
    expect(JSON.parse(all.stdout).workspaces.map((workspace: { workspaceId: string }) => workspace.workspaceId)).toEqual(["ws-alpha", "ws-beta"]);
    expect([ambiguous.status, mutationAll.status, missing.status]).toEqual([1, 1, 1]);
    expect(JSON.parse(ambiguous.stderr).error.code).toBe("target_missing");
    expect(JSON.parse(mutationAll.stderr).error.code).toBe("all_requires_readonly");
    expect(JSON.parse(missing.stderr).error.code).toBe("story_not_found");
    expect({ all: JSON.parse(all.stdout), ambiguous, mutationAll, missing }).toMatchSnapshot();
  });

  it("rejects missing values and duplicate flags before target resolution", async () => {
    const f = fixture();
    const workspace = createWorkspace(f, "ws-alpha");
    createPartialIssue(workspace, "US-PARTIAL");

    const malformed = [
      await runCli(["delivery", "list", "--workspace", "--json"], f),
      await runCli([
        "delivery", "show", "US-PARTIAL",
        "--workspace", "ws-alpha",
        "--workspace", "ws-alpha",
        "--json",
      ], f),
      await runCli([
        "delivery", "reconcile", "US-PARTIAL",
        "--workspace", "ws-alpha",
        "--json", "--json",
      ], f),
    ];

    expect(malformed.map((result) => result.status)).toEqual([1, 1, 1]);
    expect(malformed.map((result) => JSON.parse(result.stderr).error.code)).toEqual([
      "workspace_selector_missing_value",
      "duplicate_workspace_selector",
      "invalid_arguments",
    ]);
  });

  it("fails before any projection write when a declared Requirement manifest is missing, corrupt or schema-invalid", async () => {
    const cases = ["missing", "corrupt", "schema-invalid"] as const;
    for (const [index, mode] of cases.entries()) {
      const f = fixture();
      const workspace = createWorkspace(f, `ws-requirement-${index}`);
      const storyId = `US-REQ-${index}`;
      createDeliveredIssue(workspace, storyId);
      const requirementPath = captureRequirement(f.rollHome, workspace, storyId, `WS-${index + 1}`);
      const sourcePath = join(requirementPath, "source.yaml");
      const attestPath = join(requirementPath, "attest.md");
      const backlogPath = join(workspace.root, "backlog", "index.md");
      const before = {
        backlog: readFileSync(backlogPath, "utf8"),
        attest: readFileSync(attestPath, "utf8"),
      };
      if (mode === "missing") unlinkSync(sourcePath);
      if (mode === "corrupt") writeFileSync(sourcePath, "{not-json", "utf8");
      if (mode === "schema-invalid") writeFileSync(sourcePath, `${JSON.stringify({ schema: "wrong" })}\n`, "utf8");

      const result = await runCli([
        "delivery", "reconcile", storyId,
        "--workspace", workspace.workspaceId,
        "--json",
      ], f);

      expect(result.status, mode).toBe(1);
      expect(JSON.parse(result.stderr).error.code, mode).toBe("invalid_requirement");
      expect(readFileSync(backlogPath, "utf8"), mode).toBe(before.backlog);
      expect(readFileSync(attestPath, "utf8"), mode).toBe(before.attest);
    }
  });

  it("fails before projection when a declared Requirement canonical directory is absent", async () => {
    const f = fixture();
    const workspace = createWorkspace(f, "ws-requirement-directory-missing");
    const storyId = "US-REQ-DIR";
    createDeliveredIssue(workspace, storyId);
    const requirementPath = captureRequirement(f.rollHome, workspace, storyId, "WS-88");
    const backlogPath = join(workspace.root, "backlog", "index.md");
    const backlogBefore = readFileSync(backlogPath, "utf8");
    rmSync(requirementPath, { recursive: true, force: true });

    const result = await runCli([
      "delivery", "reconcile", storyId,
      "--workspace", workspace.workspaceId,
      "--json",
    ], f);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_requirement");
    expect(readFileSync(backlogPath, "utf8")).toBe(backlogBefore);
  });

  it("ignores a valid declared Requirement that is not linked to the reconciled Story", async () => {
    const f = fixture();
    const workspace = createWorkspace(f, "ws-unlinked-requirement");
    const targetStory = "US-TARGET";
    const otherStory = "US-OTHER";
    createDeliveredIssue(workspace, targetStory);
    const requirementPath = captureRequirement(f.rollHome, workspace, otherStory, "WS-99");
    const attestPath = join(requirementPath, "attest.md");
    const attestBefore = readFileSync(attestPath, "utf8");
    const undeclared = join(workspace.root, "requirements", "jira", "misc-directory");
    mkdirSync(undeclared, { recursive: true });
    writeFileSync(join(undeclared, "source.yaml"), "{not-json", "utf8");
    writeFileSync(
      join(workspace.root, "backlog", "index.md"),
      `| ${targetStory} | target delivery | 📋 Todo |\n| ${otherStory} | unrelated requirement | 📋 Todo |\n`,
      "utf8",
    );

    const result = await runCli([
      "delivery", "reconcile", targetStory,
      "--workspace", workspace.workspaceId,
      "--json",
    ], f);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(attestPath, "utf8")).toBe(attestBefore);
    expect(readFileSync(join(workspace.root, "backlog", "index.md"), "utf8"))
      .toContain(`| ${targetStory} | target delivery | ✅ Done |`);
  });
});
