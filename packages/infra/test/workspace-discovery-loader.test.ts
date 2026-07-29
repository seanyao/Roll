import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ISSUE_MANIFEST_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  repositoryIdFromRemote,
} from "@roll/spec";
import {
  WorkspaceRegistry,
  loadExplicitWorkspaceDiscovery,
  loadWorkspaceDiscovery,
  workspaceDiscoveryIndexPath,
} from "../src/index.js";

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-workspace-discovery-"));
  sandboxes.push(root);
  return root;
}

function remote(workspaceId: string): string {
  return `https://example.test/${workspaceId}/product.git`;
}

function repoId(workspaceId: string): string {
  const result = repositoryIdFromRemote(remote(workspaceId));
  if (!result.ok) throw new Error("fixture remote must be valid");
  return result.value;
}

function createWorkspace(root: string, workspaceId: string, requirements: readonly string[] = []): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId,
    displayName: workspaceId,
    requirements: requirements.map((ref) => ({ provider: "jira", ref })),
    repositories: [{
      schema: REPOSITORY_BINDING_V1,
      repoId: repoId(workspaceId),
      alias: "product",
      remote: remote(workspaceId),
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  }, null, 2)}\n`, "utf8");
  return root;
}

function createIssue(root: string, workspaceId: string, storyId: string, requirements: readonly string[] = []): string {
  const issueRoot = join(root, "issues", storyId);
  mkdirSync(issueRoot, { recursive: true });
  const path = join(issueRoot, "manifest.json");
  writeFileSync(path, `${JSON.stringify({
    schema: ISSUE_MANIFEST_V1,
    workspaceId,
    storyId,
    requirements: requirements.map((ref) => ({ provider: "jira", ref })),
    repositories: [{
      repoId: repoId(workspaceId),
      alias: "product",
      access: "write",
      requiredDelivery: true,
      noChangePolicy: "changes_required",
    }],
  }, null, 2)}\n`, "utf8");
  return path;
}

function register(rollHome: string, root: string, workspaceId: string, lifecycle: "registered" | "active" | "paused" | "archived" = "active"): void {
  const registry = new WorkspaceRegistry({ rollHome });
  registry.register({ workspaceId, root });
  if (lifecycle === "active") registry.activate(workspaceId);
  if (lifecycle === "paused") {
    registry.activate(workspaceId);
    registry.pause(workspaceId);
  }
  if (lifecycle === "archived") registry.archive(workspaceId);
}

describe("US-WS-028 registry-bound Workspace discovery loader", () => {
  it("loads manifest and bounded Issue facts only from registered canonical roots", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const fields = createWorkspace(join(base, "registered", "fields"), "fields", ["APE-234"]);
    createIssue(fields, "fields", "US-FIELDS-001", ["APE-234"]);
    createWorkspace(join(base, "unregistered", "rogue"), "rogue", ["APE-234"]);
    register(rollHome, fields, "fields");
    const reads: string[] = [];
    const canonicalFields = realpathSync(fields);

    const result = loadWorkspaceDiscovery({ rollHome }, { afterAuthorityRead: (path) => reads.push(path) });

    expect(result.registryRevision).toBe(1);
    expect(result.workspaces).toEqual([
      expect.objectContaining({
        candidate: expect.objectContaining({ workspaceId: "fields", lifecycle: "active" }),
        manifest: expect.objectContaining({ workspaceId: "fields" }),
        issues: [{ storyId: "US-FIELDS-001", workspaceId: "fields", requirements: [{ provider: "jira", ref: "APE-234" }] }],
      }),
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(reads).toEqual([
      join(canonicalFields, "workspace.yaml"),
      join(canonicalFields, "issues", "US-FIELDS-001", "manifest.json"),
    ]);
    expect(reads.every((path) => path.startsWith(`${canonicalFields}/`))).toBe(true);
  });

  it("turns invalid Issue authority into a diagnostic instead of a partial candidate", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const fields = createWorkspace(join(base, "fields"), "fields");
    const issuePath = createIssue(fields, "fields", "US-FIELDS-001");
    writeFileSync(issuePath, "{not-json}\n", "utf8");
    register(rollHome, fields, "fields");

    expect(loadWorkspaceDiscovery({ rollHome })).toMatchObject({
      workspaces: [],
      diagnostics: [{
        workspaceId: "fields",
        code: "invalid_issue_manifest",
        authorityPath: join(realpathSync(fields), "issues", "US-FIELDS-001", "manifest.json"),
      }],
    });
  });

  it("classifies a missing registered workspace manifest as invalid authority", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const fields = createWorkspace(join(base, "fields"), "fields");
    register(rollHome, fields, "fields");
    const manifestPath = join(realpathSync(fields), "workspace.yaml");
    rmSync(manifestPath);

    expect(loadWorkspaceDiscovery({ rollHome })).toMatchObject({
      workspaces: [],
      diagnostics: [{
        workspaceId: "fields",
        code: "invalid_workspace_manifest",
        authorityPath: manifestPath,
      }],
    });
  });

  it("reports symlink escape and stale identity without following either authority", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const symlinked = createWorkspace(join(base, "symlinked"), "symlinked");
    const outside = join(base, "outside-manifest.json");
    writeFileSync(outside, "{}\n", "utf8");
    const issueRoot = join(symlinked, "issues", "US-LINK-001");
    mkdirSync(issueRoot, { recursive: true });
    symlinkSync(outside, join(issueRoot, "manifest.json"));
    register(rollHome, symlinked, "symlinked");

    const mismatch = createWorkspace(join(base, "mismatch"), "mismatch");
    register(rollHome, mismatch, "mismatch");
    createWorkspace(mismatch, "other");

    expect(loadWorkspaceDiscovery({ rollHome })).toMatchObject({
      workspaces: [],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ workspaceId: "symlinked", code: "symlink_escape" }),
        expect.objectContaining({ workspaceId: "mismatch", code: "identity_mismatch" }),
      ]),
    });
  });

  it("detects an authority file replaced by a symlink during the bounded read", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const fields = createWorkspace(join(base, "fields"), "fields");
    register(rollHome, fields, "fields");
    const manifestPath = join(realpathSync(fields), "workspace.yaml");
    const movedPath = join(realpathSync(fields), "workspace-before.yaml");
    let replaced = false;

    const result = loadWorkspaceDiscovery({ rollHome }, {
      afterAuthorityRead: (path) => {
        if (path !== manifestPath || replaced) return;
        replaced = true;
        renameSync(path, movedPath);
        symlinkSync(movedPath, path);
      },
    });

    expect(result.workspaces).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ workspaceId: "fields", code: "symlink_escape", authorityPath: manifestPath }),
    ]);
  });

  it("rejects an Issue manifest replaced by a symlink after its bounded read", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const fields = createWorkspace(join(base, "fields"), "fields");
    createIssue(fields, "fields", "US-FIELDS-001", ["APE-234"]);
    register(rollHome, fields, "fields");
    const canonicalIssuePath = join(realpathSync(fields), "issues", "US-FIELDS-001", "manifest.json");
    const movedPath = join(realpathSync(fields), "issues", "US-FIELDS-001", "manifest-before.json");
    let replaced = false;

    const result = loadWorkspaceDiscovery({ rollHome }, {
      afterAuthorityRead: (path) => {
        if (path !== canonicalIssuePath || replaced) return;
        replaced = true;
        renameSync(path, movedPath);
        symlinkSync(movedPath, path);
      },
    });

    expect(result.workspaces).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ workspaceId: "fields", code: "symlink_escape", authorityPath: canonicalIssuePath }),
    ]);
  });

  it.each(["workspace", "issue"] as const)(
    "rejects a %s authority file replaced by changed regular content after read",
    (authority) => {
      const base = sandbox();
      const rollHome = join(base, "home");
      const fields = createWorkspace(join(base, "fields"), "fields", ["APE-234"]);
      createIssue(fields, "fields", "US-FIELDS-001", ["APE-234"]);
      register(rollHome, fields, "fields");
      const canonicalRoot = realpathSync(fields);
      const authorityPath = authority === "workspace"
        ? join(canonicalRoot, "workspace.yaml")
        : join(canonicalRoot, "issues", "US-FIELDS-001", "manifest.json");
      const beforePath = `${authorityPath}.before`;
      const changed = JSON.parse(readFileSync(authorityPath, "utf8")) as Record<string, unknown>;
      if (authority === "workspace") changed["displayName"] = "changed-fields";
      else changed["requirements"] = [{ provider: "jira", ref: "APE-999" }];
      let replaced = false;

      const result = loadWorkspaceDiscovery({ rollHome }, {
        afterAuthorityRead: (path) => {
          if (path !== authorityPath || replaced) return;
          replaced = true;
          renameSync(path, beforePath);
          writeFileSync(path, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
        },
      });

      expect(result.workspaces).toEqual([]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          workspaceId: "fields",
          code: "discovery_io_failure",
          authorityPath,
        }),
      ]);
    },
  );

  it("ignores archived authority unless a separate explicit-read path loads it", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const archived = createWorkspace(join(base, "archived"), "archived");
    register(rollHome, archived, "archived", "archived");
    writeFileSync(join(archived, "workspace.yaml"), "broken\n", "utf8");

    expect(loadWorkspaceDiscovery({ rollHome })).toEqual({
      schema: "roll.workspace-discovery-load/v1",
      registryRevision: 1,
      discoveryFactsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      workspaces: [],
      diagnostics: [],
    });
  });

  it("loads exactly one archived canonical root through the public explicit-read surface", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const active = createWorkspace(join(base, "active"), "active", ["IDEA-074"]);
    const archived = createWorkspace(join(base, "archived"), "archived", ["APE-234"]);
    createIssue(archived, "archived", "US-FIELDS-001", ["APE-234"]);
    register(rollHome, active, "active", "active");
    register(rollHome, archived, "archived", "archived");
    const reads: string[] = [];

    const result = loadExplicitWorkspaceDiscovery(
      { rollHome, workspaceId: "archived" },
      { afterAuthorityRead: (path) => reads.push(path) },
    );

    expect(result.workspaces).toEqual([
      expect.objectContaining({
        candidate: expect.objectContaining({ workspaceId: "archived", lifecycle: "archived" }),
        issues: [expect.objectContaining({ storyId: "US-FIELDS-001" })],
      }),
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(reads).toEqual([
      join(realpathSync(archived), "workspace.yaml"),
      join(realpathSync(archived), "issues", "US-FIELDS-001", "manifest.json"),
    ]);
    expect(reads.some((path) => path.startsWith(`${realpathSync(active)}/`))).toBe(false);
  });

  it("rebuilds the derived index from authority when cached content or digest is stale", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const fields = createWorkspace(join(base, "fields"), "fields", ["APE-234"]);
    createIssue(fields, "fields", "US-FIELDS-001", ["APE-234"]);
    register(rollHome, fields, "fields");
    const first = loadWorkspaceDiscovery({ rollHome });
    const indexPath = workspaceDiscoveryIndexPath(rollHome, "fields");
    const firstIndex = JSON.parse(readFileSync(indexPath, "utf8")) as { authoritySha256: string };
    writeFileSync(indexPath, `${JSON.stringify({
      schema: "roll.workspace-discovery-index/v1",
      workspaceId: "fields",
      authoritySha256: "0".repeat(64),
      forgedSelection: "roll",
    })}\n`, "utf8");
    createIssue(fields, "fields", "US-FIELDS-002", ["APE-999"]);

    const second = loadWorkspaceDiscovery({ rollHome });
    const rebuilt = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>;
    expect(second.workspaces[0]?.issues.map((issue) => issue.storyId)).toEqual(["US-FIELDS-001", "US-FIELDS-002"]);
    expect(second.discoveryFactsSha256).not.toBe(first.discoveryFactsSha256);
    expect(rebuilt).toEqual({
      schema: "roll.workspace-discovery-index/v1",
      workspaceId: "fields",
      authoritySha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      issueCount: 2,
    });
    expect(rebuilt["authoritySha256"]).not.toBe(firstIndex.authoritySha256);
    expect(rebuilt).not.toHaveProperty("forgedSelection");
  });

  it("treats the derived index as disposable and never follows a cache-directory symlink", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const fields = createWorkspace(join(base, "fields"), "fields", ["APE-234"]);
    register(rollHome, fields, "fields");
    const outside = join(base, "outside-cache");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(rollHome, "cache"));

    const result = loadWorkspaceDiscovery({ rollHome });

    expect(result.workspaces).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(existsSync(join(outside, "workspace-discovery", "fields.json"))).toBe(false);
  });

  it("reports bounded-directory I/O failures instead of degrading to an empty candidate", () => {
    const base = sandbox();
    const rollHome = join(base, "home");
    const fields = createWorkspace(join(base, "fields"), "fields");
    writeFileSync(join(fields, "issues"), "not-a-directory\n", "utf8");
    register(rollHome, fields, "fields");

    expect(loadWorkspaceDiscovery({ rollHome })).toMatchObject({
      workspaces: [],
      diagnostics: [{ workspaceId: "fields", code: "discovery_io_failure" }],
    });
  });
});
