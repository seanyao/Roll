import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceAuthorityLockError,
  withWorkspaceAuthorityLock,
  withWorkspaceAuthorityLockSync,
  workspaceAuthorityLockPath,
} from "../src/workspace-authority-lock.js";
import { applyWorkspaceEditPlan, WorkspaceEditTransactionError } from "../src/workspace-edit-transaction.js";
import { applyIssueInit, IssueInitializationError } from "../src/issue-worktrees.js";
import { captureRequirementSource, RequirementSourceStoreError } from "../src/requirement-source-store.js";
import { applyHistoricalWorkspaceMigration, HistoricalWorkspaceMigrationError } from "../src/workspace/migration.js";
import type { IssueStoryContract } from "@roll/core";
import type { HistoricalMigrationPlan, WorkspaceEditPlan, WorkspaceManifest } from "@roll/spec";

const roots: string[] = [];

function rollHome(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-workspace-authority-lock-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-WS-026 Workspace authority lock", () => {
  it("uses one machine-scoped lock path and releases it after a synchronous writer", () => {
    const home = rollHome();
    const path = workspaceAuthorityLockPath(home, "ws-demo");

    expect(path).toBe(join(home, "locks", "workspace-authority", "ws-demo.lock"));
    expect(withWorkspaceAuthorityLockSync({ rollHome: home, workspaceId: "ws-demo", operation: "metadata-edit" }, () => {
      expect(existsSync(path)).toBe(true);
      return "applied";
    })).toBe("applied");
    expect(existsSync(path)).toBe(false);
  });

  it("fails loud when another writer already owns the Workspace authority", async () => {
    const home = rollHome();
    let release: (() => void) | undefined;
    const held = withWorkspaceAuthorityLock({ rollHome: home, workspaceId: "ws-demo", operation: "issue-init" }, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });

    await expect(new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
      withWorkspaceAuthorityLock({ rollHome: home, workspaceId: "ws-demo", operation: "migration" }, async () => undefined)
    )).rejects.toEqual(expect.objectContaining<Partial<WorkspaceAuthorityLockError>>({ code: "authority_locked" }));

    release?.();
    await held;
  });

  it("is the first lock acquired by metadata edit, Issue init, Requirement capture/archive, and migration", async () => {
    const home = rollHome();
    const workspaceRoot = join(home, "workspace");
    const manifest: WorkspaceManifest = {
      schema: "roll.workspace/v1",
      workspaceId: "ws-demo",
      displayName: "Demo",
      requirements: [{ provider: "jira", ref: "SOT-1" }],
      repositories: [{
        schema: "roll.repository-binding/v1",
        repoId: "repo-ff7a87ddbb2b",
        alias: "product",
        remote: "https://example.test/owner/product",
        integrationBranch: "main",
        provider: "generic",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      }],
    };
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, "workspace.yaml"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const editPlan: WorkspaceEditPlan = {
      schema: "roll.workspace-edit-plan/v1",
      outcome: "ready",
      workspaceId: "ws-demo",
      manifestPath: join(workspaceRoot, "workspace.yaml"),
      beforeSha256: "a".repeat(64),
      afterSha256: "b".repeat(64),
      referenceIndexSha256: "c".repeat(64),
      beforeManifest: manifest,
      afterManifest: { ...manifest, displayName: "Renamed" },
      changes: [],
      blockers: [],
      warnings: [],
      nextAction: { kind: "apply" },
    };
    const issueContract: IssueStoryContract = { storyId: "US-1", repositories: [] };
    const migrationPlan: HistoricalMigrationPlan = {
      schema: "roll.workspace-migration-plan/v1",
      planId: "d".repeat(64),
      verdict: "ready",
      workspaceId: "ws-demo",
      workspaceRoot: "workspaces/ws-demo",
      repository: {
        alias: "primary",
        repoId: "repo-ff7a87ddbb2b",
        integrationBranch: "main",
        cachePath: "repos/repo-ff7a87ddbb2b.git",
      },
      mappings: [],
      findings: [],
    };

    await withWorkspaceAuthorityLock({ rollHome: home, workspaceId: "ws-demo", operation: "metadata-edit" }, async () => {
      await expect(applyWorkspaceEditPlan({
        rollHome: home,
        plan: editPlan,
        reloadCurrent: () => { throw new Error("must not read inside a losing authority race"); },
        rebuildPlan: () => { throw new Error("must not rebuild inside a losing authority race"); },
      })).rejects.toEqual(expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "concurrent_edit" }));

      await expect(applyIssueInit({
        workspaceId: "ws-demo",
        rollHome: home,
        workspaceRoot,
        issueRoot: join(workspaceRoot, "issues", "US-1"),
        contract: issueContract,
        bindings: [],
        requirementManifests: [],
      })).rejects.toEqual(expect.objectContaining<Partial<IssueInitializationError>>({ code: "apply_failed" }));

      expect(() => captureRequirementSource({
        rollHome: home,
        workspaceRoot,
        provider: "jira",
        ref: "SOT-1",
        revision: "1",
        capturedAt: "2026-07-24T00:00:00.000Z",
        bodyFile: join(home, "missing.md"),
        contextPaths: [],
        storyIds: [],
      })).toThrowError(expect.objectContaining<Partial<RequirementSourceStoreError>>({ code: "concurrent_capture" }));

      await expect(applyHistoricalWorkspaceMigration({
        sourceRoot: join(home, "source"),
        rollHome: home,
        plan: migrationPlan,
      })).rejects.toEqual(expect.objectContaining<Partial<HistoricalWorkspaceMigrationError>>({ code: "concurrent_migration" }));
    });

    expect(existsSync(join(workspaceRoot, "issues", "US-1"))).toBe(false);
    expect(existsSync(join(workspaceRoot, "requirements"))).toBe(false);
    expect(existsSync(join(home, "workspace-migrations"))).toBe(false);
  });
});
