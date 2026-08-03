import { describe, expect, it, vi } from "vitest";
import {
  applyWorktreeCleanup,
  isSafelyDisposable,
  planWorktreeCleanup,
  type CleanupBranchCandidate,
} from "../src/commands/worktree-cleanup.js";
import type { WorktreeAuditOutput, WorktreeAuditRecord } from "../src/commands/worktree-audit.js";
import {
  applyWorkspaceWorktreeCleanup,
  planWorkspaceWorktreeCleanup,
  workspaceWorktreeCleanupCommand,
  type WorkspaceWorktreeAuditOutput,
} from "../src/commands/workspace-worktree-lifecycle.js";

const HEAD = "b".repeat(40);

function record(overrides: Partial<WorktreeAuditRecord> = {}): WorktreeAuditRecord {
  return {
    path: "/workspaces/alpha/issues/US-A/primary",
    branch: "refs/heads/roll/ws-alpha/US-A",
    head: HEAD,
    owner: "workspace",
    workspaceId: "ws-alpha",
    storyId: "US-A",
    repoId: "repo-shared",
    repositoryAlias: "primary",
    cachePath: "/roll-home/repos/repo-shared.git",
    deliveryProof: "delivered",
    ownershipState: "verified",
    dirtyTracked: false,
    dirtyUntracked: false,
    ahead: 0,
    mergeEvidence: { kind: "ancestor" },
    active: false,
    disposition: "disposable_candidate",
    reason: "delivered",
    ...overrides,
  };
}

function audit(records: readonly WorktreeAuditRecord[]): WorktreeAuditOutput {
  return {
    schema: 1,
    generatedAt: "2026-07-22T00:00:00.000Z",
    repo: "workspace:ws-alpha",
    records: [...records],
    ephemeralBranches: [],
    summary: {
      total: records.length,
      loop: 0,
      workspace: records.length,
      manual: 0,
      external: 0,
      active: records.filter((item) => item.active).length,
      disposableCandidates: records.filter((item) => item.disposition === "disposable_candidate").length,
      preserved: records.filter((item) => item.disposition !== "disposable_candidate").length,
      ephemeralBranches: 0,
    },
  };
}

function workspaceAudit(records: readonly WorktreeAuditRecord[]): WorkspaceWorktreeAuditOutput {
  return {
    schema: 1,
    generatedAt: "2026-07-22T00:00:00.000Z",
    selectedWorkspaceId: "ws-alpha",
    records,
    ephemeralBranches: [],
    repositories: [{ repoId: "repo-shared", cachePath: "/roll-home/repos/repo-shared.git", integrationBranch: "main" }],
    summary: {
      worktrees: records.length,
      active: records.filter((item) => item.active).length,
      disposableCandidates: records.filter((item) => item.disposition === "disposable_candidate").length,
      preserved: records.filter((item) => item.disposition !== "disposable_candidate").length,
      ephemeralBranches: 0,
      canaryTotal: records.length,
    },
  };
}

async function captureOutput(run: () => Promise<number>): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => (stdout += String(chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (stderr += String(chunk), true)) as typeof process.stderr.write;
  try {
    return { status: await run(), stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe("US-WS-011a Workspace worktree cleanup", () => {
  it("selects only clean, inactive, proof-backed legs owned by the requested Workspace", () => {
    const dirty = record({
      path: "/workspaces/alpha/issues/US-DIRTY/primary",
      storyId: "US-DIRTY",
      dirtyUntracked: true,
      disposition: "preserved_dirty_no_tcr",
    });
    const otherWorkspace = record({
      path: "/workspaces/beta/issues/US-B/primary",
      workspaceId: "ws-beta",
      storyId: "US-B",
      branch: "refs/heads/roll/ws-beta/US-B",
    });
    const safe = record();

    expect(isSafelyDisposable(safe)).toBe(true);
    expect(isSafelyDisposable(dirty)).toBe(false);
    expect(isSafelyDisposable(record({ ownershipState: "mismatch" }))).toBe(false);

    const plan = planWorktreeCleanup(audit([safe, dirty, otherWorkspace]), 0, [], { workspaceId: "ws-alpha" });
    expect(plan.candidates).toEqual([
      expect.objectContaining({
        path: safe.path,
        workspaceId: "ws-alpha",
        repoId: "repo-shared",
        repositoryAlias: "primary",
        cachePath: safe.cachePath,
        expectedHead: HEAD,
      }),
    ]);
    expect(plan.preserved.map((item) => item.path)).toEqual([dirty.path, otherWorkspace.path]);
  });

  it("revalidates Workspace identity and refuses a cross-Workspace substitution before removal", async () => {
    const planned = record();
    const plan = planWorktreeCleanup(audit([planned]), 0, [], { workspaceId: "ws-alpha" });
    const removeWorktree = vi.fn(() => ({ ok: true, detail: "" }));
    const result = await applyWorktreeCleanup(plan, {
      repositoryRoot: planned.cachePath as string,
      dryRun: false,
      audit: () => audit([record({ workspaceId: "ws-beta" })]),
      removeWorktree,
    });

    expect(removeWorktree).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
    expect(result.refused).toEqual([
      expect.objectContaining({ path: planned.path, reason: expect.stringContaining("identity") }),
    ]);
  });

  it("acquires the machine repository lock before fresh audit, removal and prune", async () => {
    const safe = record();
    const plan = planWorkspaceWorktreeCleanup(workspaceAudit([safe]), 0);
    const calls: string[] = [];
    const result = await applyWorkspaceWorktreeCleanup(plan, {
      selectedWorkspaceId: "ws-alpha",
      auditWorkspace: () => (calls.push("audit"), workspaceAudit([safe])),
      withRepositoryLock: async (candidate, action) => {
        calls.push(`lock:${candidate.repoId}`);
        try {
          return await action();
        } finally {
          calls.push(`unlock:${candidate.repoId}`);
        }
      },
      removeWorktree: (_repoRoot, path) => (calls.push(`remove:${path}`), { ok: true, detail: "" }),
    });

    expect(result.refused).toEqual([]);
    expect(result.removed).toEqual([expect.objectContaining({ path: safe.path, workspaceId: "ws-alpha", repoId: "repo-shared" })]);
    expect(calls).toEqual([
      "lock:repo-shared",
      "audit",
      `remove:${safe.path}`,
      "unlock:repo-shared",
    ]);
  });

  it("exposes a Workspace-scoped dry-run plan without invoking mutation or a legacy repo layout", async () => {
    const safe = record();
    const lock = vi.fn(async <T>(_candidate: unknown, action: () => Promise<T>) => action());
    const result = await captureOutput(() => workspaceWorktreeCleanupCommand([
      "--workspace", "ws-alpha", "--dry-run", "--json",
    ], {
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
      threshold: () => 0,
      auditWorkspace: () => workspaceAudit([safe]),
      withRepositoryLock: lock,
    }));

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      canaryTotal: 1,
      projectedTotal: 0,
      candidates: [expect.objectContaining({ path: safe.path, workspaceId: "ws-alpha" })],
    }));
    expect(lock).not.toHaveBeenCalled();
  });

  it("labels Workspace Issue worktrees without changing the legacy cleanup renderer", async () => {
    const result = await captureOutput(() => workspaceWorktreeCleanupCommand([
      "--workspace", "ws-alpha", "--dry-run",
    ], {
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
      threshold: () => 0,
      auditWorkspace: () => workspaceAudit([record()]),
      resolveStandaloneBranches: () => [],
    }));

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("1 Workspace Issue worktree(s)");
    expect(result.stdout).toContain("counted Workspace Issue worktrees");
    expect(result.stdout).not.toContain("counted loop worktrees");
  });

  it("discovers qualified standalone branches for the Workspace cleanup plan", async () => {
    const branch: CleanupBranchCandidate = {
      branch: "loop/cycle-shared",
      expectedSha: HEAD,
      mergeKind: "patch_equivalent",
      workspaceId: "ws-alpha",
      repoId: "repo-shared",
      cachePath: "/roll-home/repos/repo-shared.git",
    };
    const aggregate: WorkspaceWorktreeAuditOutput = {
      ...workspaceAudit([]),
      ephemeralBranches: [{ repoId: "repo-shared", cachePath: branch.cachePath as string, branch: branch.branch }],
      summary: {
        worktrees: 0,
        active: 0,
        disposableCandidates: 0,
        preserved: 0,
        ephemeralBranches: 1,
        canaryTotal: 1,
      },
    };
    const resolveStandaloneBranches = vi.fn(() => [branch]);
    const result = await captureOutput(() => workspaceWorktreeCleanupCommand([
      "--workspace", "ws-alpha", "--dry-run", "--json",
    ], {
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
      threshold: () => 0,
      auditWorkspace: () => aggregate,
      resolveStandaloneBranches,
    }));

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(resolveStandaloneBranches).toHaveBeenCalledWith(aggregate);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      canaryTotal: 1,
      projectedTotal: 0,
      branchCandidates: [expect.objectContaining({ branch: branch.branch, repoId: "repo-shared" })],
    }));
  });

  it("keeps standalone branch patch/final-tree revalidation inside the same repository lock", async () => {
    const branch: CleanupBranchCandidate = {
      branch: "loop/cycle-shared",
      expectedSha: HEAD,
      mergeKind: "final_tree",
      workspaceId: "ws-alpha",
      repoId: "repo-shared",
      cachePath: "/roll-home/repos/repo-shared.git",
    };
    const aggregate: WorkspaceWorktreeAuditOutput = {
      ...workspaceAudit([]),
      ephemeralBranches: [{ repoId: "repo-shared", cachePath: branch.cachePath as string, branch: branch.branch }],
      summary: {
        worktrees: 0,
        active: 0,
        disposableCandidates: 0,
        preserved: 0,
        ephemeralBranches: 1,
        canaryTotal: 1,
      },
    };
    const plan = planWorkspaceWorktreeCleanup(aggregate, 0, [branch]);
    const calls: string[] = [];
    const result = await applyWorkspaceWorktreeCleanup(plan, {
      selectedWorkspaceId: "ws-alpha",
      auditWorkspace: () => aggregate,
      withRepositoryLock: async (candidate, action) => {
        calls.push(`lock:${candidate.repoId}`);
        try {
          return await action();
        } finally {
          calls.push(`unlock:${candidate.repoId}`);
        }
      },
      freshBranchDeps: () => ({
        attachedBranches: new Set(),
        currentBranch: null,
        refSha: () => (calls.push("ref"), HEAD),
        branchMerge: () => (calls.push("merge-proof"), "final_tree"),
      }),
      removeBranch: (_repoRoot, name, sha) => (calls.push(`delete:${name}:${sha}`), { ok: true, detail: "" }),
    });

    expect(result.refused).toEqual([]);
    expect(result.branchesRemoved).toEqual([expect.objectContaining({
      branch: branch.branch,
      mergeKind: "final_tree",
      repoId: "repo-shared",
    })]);
    expect(calls).toEqual([
      "lock:repo-shared",
      "ref",
      "merge-proof",
      `delete:${branch.branch}:${HEAD}`,
      "unlock:repo-shared",
    ]);
  });
});
