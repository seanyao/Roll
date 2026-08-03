import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditWorktrees,
  type WorkspaceWorktreeOwnership,
} from "../src/commands/worktree-audit.js";
import {
  auditWorkspaceWorktrees,
  workspaceWorktreeAuditCommand,
} from "../src/commands/workspace-worktree-lifecycle.js";
import {
  ISSUE_MANIFEST_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  type IssueManifest,
  type WorkspaceManifest,
} from "@roll/spec";

const HEAD = "a".repeat(40);

function captureStdout(run: () => number): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => (stdout += String(chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (stderr += String(chunk), true)) as typeof process.stderr.write;
  try {
    return { status: run(), stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe("US-WS-011a Workspace worktree audit", () => {
  it("projects registry-bound Workspace identity and delivery proof onto an owned worktree", () => {
    const path = "/workspaces/alpha/issues/US-WS-900/primary";
    const ownership: WorkspaceWorktreeOwnership = {
      workspaceId: "ws-alpha",
      storyId: "US-WS-900",
      repoId: "repo-shared",
      repositoryAlias: "primary",
      cachePath: "/roll-home/repos/repo-shared.git",
      expectedBranch: "roll/ws-alpha/US-WS-900",
      active: false,
      deliveryProof: "delivered",
    };

    const output = auditWorktrees({
      repoRoot: ownership.cachePath,
      home: "/home/test",
      integrationBranch: "origin/main",
      workspaceOwnership: new Map([[path, ownership]]),
      git: (args) => {
        const command = args.join(" ");
        if (command === "worktree list --porcelain") {
          return `worktree ${path}\nHEAD ${HEAD}\nbranch refs/heads/${ownership.expectedBranch}\n`;
        }
        if (command.startsWith("status --porcelain")) return "";
        if (command === "rev-parse HEAD" || command === "merge-base HEAD origin/main") return HEAD;
        if (command === "rev-list --count origin/main..HEAD") return "0";
        if (command === "branch --format=%(refname:short)") return "loop/cycle-shared";
        if (command === "branch --merged origin/main") return ownership.expectedBranch;
        return "";
      },
      readDir: () => [],
      nowISO: () => "2026-07-22T00:00:00.000Z",
    });

    expect(output.records).toEqual([
      expect.objectContaining({
        owner: "workspace",
        workspaceId: "ws-alpha",
        storyId: "US-WS-900",
        repoId: "repo-shared",
        repositoryAlias: "primary",
        cachePath: ownership.cachePath,
        path,
        branch: `refs/heads/${ownership.expectedBranch}`,
        head: HEAD,
        active: false,
        deliveryProof: "delivered",
        disposition: "disposable_candidate",
      }),
    ]);
    expect(output.ephemeralBranches).toEqual(["loop/cycle-shared"]);
  });

  it("discovers two Workspaces through one shared cache without double counting cache branches or unrelated worktrees", () => {
    const cachePath = "/roll-home/repos/repo-shared.git";
    const binding = {
      schema: REPOSITORY_BINDING_V1,
      repoId: "repo-shared",
      alias: "primary",
      remote: "https://example.test/shared.git",
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    } as const;
    const workspaces = new Map<string, WorkspaceManifest>([
      ["/workspaces/alpha", {
        schema: WORKSPACE_MANIFEST_V1,
        workspaceId: "ws-alpha",
        displayName: "Alpha",
        requirements: [],
        repositories: [binding],
      }],
      ["/workspaces/beta", {
        schema: WORKSPACE_MANIFEST_V1,
        workspaceId: "ws-beta",
        displayName: "Beta",
        requirements: [],
        repositories: [binding],
      }],
    ]);
    const issues = new Map<string, IssueManifest>([
      ["/workspaces/alpha/issues/US-A/manifest.json", {
        schema: ISSUE_MANIFEST_V1,
        workspaceId: "ws-alpha",
        storyId: "US-A",
        requirements: [],
        repositories: [{
          repoId: "repo-shared",
          alias: "primary",
          access: "write",
          requiredDelivery: true,
          noChangePolicy: "changes_required",
        }],
      }],
      ["/workspaces/beta/issues/US-B/manifest.json", {
        schema: ISSUE_MANIFEST_V1,
        workspaceId: "ws-beta",
        storyId: "US-B",
        requirements: [],
        repositories: [{
          repoId: "repo-shared",
          alias: "primary",
          access: "write",
          requiredDelivery: true,
          noChangePolicy: "changes_required",
        }],
      }],
    ]);
    const alphaPath = "/workspaces/alpha/issues/US-A/primary";
    const betaPath = "/workspaces/beta/issues/US-B/primary";
    let cacheAudits = 0;

    const output = auditWorkspaceWorktrees({
      selectedWorkspaceId: "ws-alpha",
      selectedWorkspaceRoot: "/workspaces/alpha",
      rollHome: "/roll-home",
    }, {
      inspectWorkspaces: () => [
        { workspaceId: "ws-alpha", root: "/workspaces/alpha", canonicalRoot: "/workspaces/alpha", consistency: "consistent" },
        { workspaceId: "ws-beta", root: "/workspaces/beta", canonicalRoot: "/workspaces/beta", consistency: "consistent" },
      ],
      readWorkspace: (root) => workspaces.get(root) as WorkspaceManifest,
      listIssueIds: (root) => root.endsWith("alpha") ? ["US-A"] : ["US-B"],
      readIssueManifest: (issueRoot) => issues.get(`${issueRoot}/manifest.json`) as IssueManifest,
      readRepositoryBoundFacts: (issueRoot) => new Map([["primary", {
        workspaceId: issueRoot.includes("alpha") ? "ws-alpha" : "ws-beta",
        storyId: issueRoot.includes("alpha") ? "US-A" : "US-B",
        repoId: "repo-shared",
        baseSha: HEAD,
        access: "write",
        path: issueRoot.includes("alpha") ? alphaPath : betaPath,
        workBranch: issueRoot.includes("alpha") ? "roll/ws-alpha/US-A" : "roll/ws-beta/US-B",
      }]]),
      readIssueCompletionEvidence: (issueRoot) => issueRoot.includes("alpha") ? {
        repositoryFacts: [{
          authority: "provider",
          workspaceId: "ws-alpha",
          storyId: "US-A",
          repoId: "repo-shared",
          cycleId: "cycle-a",
          recordedAt: 1,
          prState: "MERGED",
          ci: "green",
          mergeCommit: HEAD,
        }],
        integrationAcceptances: [{
          workspaceId: "ws-alpha",
          storyId: "US-A",
          inputMergeCommits: { "repo-shared": HEAD },
          commandDigest: "c".repeat(64),
          profile: "workspace-integration/v1",
          verdict: "pass",
          artifactPath: "evidence/integration.txt",
          recordedAt: 2,
        }],
      } : { repositoryFacts: [], integrationAcceptances: [] },
      storyActive: () => false,
      resolveCache: () => ({ repoId: "repo-shared", cachePath, integrationBranch: "main" }),
      auditRepository: (deps) => {
        cacheAudits += 1;
        return auditWorktrees({
          ...deps,
          readDir: () => [],
          git: (args, cwd) => {
            const command = args.join(" ");
            if (command === "worktree list --porcelain") {
              return [
                `worktree ${cachePath}`,
                `HEAD ${HEAD}`,
                "bare",
                "",
                `worktree ${alphaPath}`,
                `HEAD ${HEAD}`,
                "branch refs/heads/roll/ws-alpha/US-A",
                "",
                `worktree ${betaPath}`,
                `HEAD ${HEAD}`,
                "branch refs/heads/roll/ws-beta/US-B",
                "",
                "worktree /tmp/unrelated-worktree",
                `HEAD ${HEAD}`,
                "branch refs/heads/manual/unrelated",
                "",
              ].join("\n");
            }
            if (command.startsWith("status --porcelain")) return cwd === betaPath ? "?? scratch.txt" : "";
            if (command === "rev-parse HEAD" || command === "merge-base HEAD origin/main") return HEAD;
            if (command === "branch --format=%(refname:short)") return "loop/cycle-shared\nmain";
            if (command === "branch --merged origin/main") return "main";
            return "";
          },
        });
      },
      nowISO: () => "2026-07-22T00:00:00.000Z",
    });

    expect(cacheAudits).toBe(1);
    expect(output.records).toHaveLength(2);
    expect(output.records.map((record) => [record.workspaceId, record.deliveryProof, record.disposition])).toEqual([
      ["ws-alpha", "delivered", "disposable_candidate"],
      ["ws-beta", "incomplete", "preserved_dirty_no_tcr"],
    ]);
    expect(output.ephemeralBranches).toEqual([{
      repoId: "repo-shared",
      cachePath,
      branch: "loop/cycle-shared",
    }]);
    expect(output.summary).toMatchObject({ worktrees: 2, ephemeralBranches: 1, canaryTotal: 3 });
  });

  it("rejects an Issue repository leg whose canonical path escapes through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "roll-workspace-audit-root-"));
    const outside = mkdtempSync(join(tmpdir(), "roll-workspace-audit-outside-"));
    const issueRoot = join(root, "issues", "US-A");
    mkdirSync(issueRoot, { recursive: true });
    symlinkSync(outside, join(issueRoot, "primary"));
    const binding = {
      schema: REPOSITORY_BINDING_V1,
      repoId: "repo-shared",
      alias: "primary",
      remote: "https://example.test/shared.git",
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    } as const;
    const workspace: WorkspaceManifest = {
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId: "ws-alpha",
      displayName: "Alpha",
      requirements: [],
      repositories: [binding],
    };
    const issue: IssueManifest = {
      schema: ISSUE_MANIFEST_V1,
      workspaceId: "ws-alpha",
      storyId: "US-A",
      requirements: [],
      repositories: [{
        repoId: "repo-shared",
        alias: "primary",
        access: "write",
        requiredDelivery: true,
        noChangePolicy: "changes_required",
      }],
    };
    try {
      expect(() => auditWorkspaceWorktrees({
        selectedWorkspaceId: "ws-alpha",
        selectedWorkspaceRoot: root,
        rollHome: "/roll-home",
      }, {
        inspectWorkspaces: () => [{
          workspaceId: "ws-alpha",
          root,
          canonicalRoot: root,
          consistency: "consistent",
        }],
        readWorkspace: () => workspace,
        listIssueIds: () => ["US-A"],
        readIssueManifest: () => issue,
        readRepositoryBoundFacts: () => new Map([["primary", {
          workspaceId: "ws-alpha",
          storyId: "US-A",
          repoId: "repo-shared",
          baseSha: HEAD,
          access: "write",
          path: join(issueRoot, "primary"),
          workBranch: "roll/ws-alpha/US-A",
        }]]),
        readIssueCompletionEvidence: () => ({ repositoryFacts: [], integrationAcceptances: [] }),
        storyActive: () => false,
        resolveCache: () => ({ repoId: "repo-shared", cachePath: "/roll-home/repos/repo-shared.git", integrationBranch: "main" }),
        auditRepository: () => { throw new Error("audit must not reach an escaped path"); },
        nowISO: () => "2026-07-22T00:00:00.000Z",
      })).toThrow("workspace_worktree_path_mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("exposes the registry-resolved Workspace audit through the CLI without falling back to repo-local layout", () => {
    const audit = {
      schema: 1 as const,
      generatedAt: "2026-07-22T00:00:00.000Z",
      selectedWorkspaceId: "ws-alpha",
      records: [{
        path: "/workspaces/alpha/issues/US-A/primary",
        branch: "refs/heads/roll/ws-alpha/US-A",
        head: HEAD,
        owner: "workspace" as const,
        workspaceId: "ws-alpha",
        storyId: "US-A",
        repoId: "repo-shared",
        repositoryAlias: "primary",
        cachePath: "/roll-home/repos/repo-shared.git",
        deliveryProof: "delivered" as const,
        ownershipState: "verified" as const,
        dirtyTracked: false as const,
        dirtyUntracked: false as const,
        ahead: 0,
        mergeEvidence: { kind: "ancestor" as const },
        active: false,
        disposition: "disposable_candidate" as const,
        reason: "delivered",
      }],
      ephemeralBranches: [],
      repositories: [{ repoId: "repo-shared", cachePath: "/roll-home/repos/repo-shared.git", integrationBranch: "main" }],
      summary: { worktrees: 1, active: 0, disposableCandidates: 1, preserved: 0, ephemeralBranches: 0, canaryTotal: 1 },
    };
    const result = captureStdout(() => workspaceWorktreeAuditCommand(["--workspace", "ws-alpha", "--json"], {
      resolveTarget: () => ({
        ok: true,
        workspaceId: "ws-alpha",
        workspaceRoot: "/workspaces/alpha",
        canonicalRoot: "/workspaces/alpha",
        backlogPath: "/workspaces/alpha/backlog/index.md",
        storyRoot: "/workspaces/alpha/backlog",
        runtimeRoot: "/workspaces/alpha/runtime",
        configPath: "/workspaces/alpha/runtime/backlog-sync.yaml",
      }),
      rollHome: () => "/roll-home",
      auditWorkspace: () => audit,
    }));

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(audit);
  });
});
