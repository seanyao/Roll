import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueStoryContract } from "@roll/core";
import {
  WorkspaceRegistry,
  appendIssueIntegrationAcceptanceEvidence,
  appendRepositoryMergeEvidence,
  applyIssueInit,
} from "@roll/infra";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  integrationAcceptanceCommandDigest,
  repositoryIdFromRemote,
  type RepositoryBinding,
} from "@roll/spec";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyWorkspaceWorktreeCleanup,
  auditWorkspaceWorktrees,
  planWorkspaceWorktreeCleanup,
  workspaceWorktreeAuditCommand,
  workspaceWorktreeCleanupCommand,
} from "../src/commands/workspace-worktree-lifecycle.js";

const sandboxes: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function materializeRemote(root: string): string {
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.email", "roll@example.test"]);
  git(source, ["config", "user.name", "Roll Test"]);
  writeFileSync(join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "fixture"]);
  const remote = join(root, "shared.git");
  git(root, ["clone", "-q", "--bare", source, remote]);
  return remote;
}

function repository(remotePath: string): RepositoryBinding {
  const remote = `file://${remotePath}`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must produce a repository id");
  return {
    schema: REPOSITORY_BINDING_V1,
    repoId: repoId.value,
    alias: "primary",
    remote,
    integrationBranch: "main",
    provider: "generic",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  };
}

function writeWorkspace(root: string, workspaceId: string, binding: RepositoryBinding): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId,
    displayName: workspaceId,
    requirements: [],
    repositories: [binding],
  }, null, 2)}\n`, "utf8");
}

async function initializeIssue(
  rollHome: string,
  workspaceRoot: string,
  workspaceId: string,
  storyId: string,
  binding: RepositoryBinding,
): Promise<string> {
  const contract: IssueStoryContract = {
    storyId,
    repositories: [{ alias: "primary", access: "write", requiredDelivery: true }],
    integrationAcceptance: {
      command: ["pnpm", "test:integration"],
      cwd: "primary",
    },
  };
  const issueRoot = join(workspaceRoot, "issues", storyId);
  await applyIssueInit({
    workspaceId,
    rollHome,
    workspaceRoot,
    issueRoot,
    contract,
    bindings: [binding],
    requirementManifests: [],
  });
  return issueRoot;
}

async function capture(run: () => number | Promise<number>): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
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

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-WS-011a Workspace worktree lifecycle terminal fixture", () => {
  it("audits one shared cache, preserves the dirty leg, refuses cross-Workspace identity, and removes only the delivered leg", async () => {
    const root = mkdtempSync(join(tmpdir(), "roll-workspace-worktree-e2e-"));
    sandboxes.push(root);
    const rollHome = join(root, "roll-home");
    const alphaRoot = join(root, "alpha");
    const betaRoot = join(root, "beta");
    const binding = repository(materializeRemote(root));
    writeWorkspace(alphaRoot, "ws-alpha", binding);
    writeWorkspace(betaRoot, "ws-beta", binding);
    const registry = new WorkspaceRegistry({ rollHome, now: () => 1 });
    registry.register({ workspaceId: "ws-alpha", root: alphaRoot });
    registry.register({ workspaceId: "ws-beta", root: betaRoot });
    registry.activate("ws-alpha");

    const alphaIssue = await initializeIssue(rollHome, alphaRoot, "ws-alpha", "US-A", binding);
    const betaIssue = await initializeIssue(rollHome, betaRoot, "ws-beta", "US-B", binding);
    const alphaLeg = join(alphaIssue, "primary");
    const betaLeg = join(betaIssue, "primary");
    const alphaLegCanonical = realpathSync(alphaLeg);
    const betaLegCanonical = realpathSync(betaLeg);
    const alphaHead = git(alphaLeg, ["rev-parse", "HEAD"]);
    appendRepositoryMergeEvidence(alphaIssue, {
      authority: "provider",
      workspaceId: "ws-alpha",
      storyId: "US-A",
      repoId: binding.repoId,
      cycleId: "cycle-alpha",
      recordedAt: 2,
      prState: "MERGED",
      ci: "green",
      mergeCommit: alphaHead,
    });
    mkdirSync(join(alphaIssue, "evidence"), { recursive: true });
    writeFileSync(join(alphaIssue, "evidence", "integration.txt"), "PASS\n", "utf8");
    appendIssueIntegrationAcceptanceEvidence(alphaIssue, {
      workspaceId: "ws-alpha",
      storyId: "US-A",
      inputMergeCommits: { [binding.repoId]: alphaHead },
      commandDigest: integrationAcceptanceCommandDigest(["pnpm", "test:integration"]),
      profile: "workspace-integration/v1",
      verdict: "pass",
      artifactPath: "evidence/integration.txt",
      recordedAt: 3,
    });
    writeFileSync(join(betaLeg, "scratch.txt"), "dirty\n", "utf8");

    const previousRollHome = process.env["ROLL_HOME"];
    const previousThreshold = process.env["ROLL_BRANCH_CANARY_MAX"];
    process.env["ROLL_HOME"] = rollHome;
    process.env["ROLL_BRANCH_CANARY_MAX"] = "1";
    try {
      const input = { selectedWorkspaceId: "ws-alpha", selectedWorkspaceRoot: alphaRoot, rollHome };
      const audit = auditWorkspaceWorktrees(input);
      expect(audit.repositories).toHaveLength(1);
      expect(audit.records.map((record) => [record.workspaceId, record.disposition])).toEqual([
        ["ws-alpha", "disposable_candidate"],
        ["ws-beta", "preserved_dirty_no_tcr"],
      ]);

      const plan = planWorkspaceWorktreeCleanup(audit, 1);
      expect(plan.candidates).toEqual([expect.objectContaining({ workspaceId: "ws-alpha", path: alphaLegCanonical })]);
      expect(plan.preserved).toEqual([expect.objectContaining({ path: betaLegCanonical, disposition: "preserved_dirty_no_tcr" })]);
      const forgedPlan = {
        ...plan,
        candidates: plan.candidates.map((candidate) => ({ ...candidate, workspaceId: "ws-beta" })),
      };
      const crossWorkspace = await applyWorkspaceWorktreeCleanup(forgedPlan, {
        selectedWorkspaceId: "ws-alpha",
        auditWorkspace: () => auditWorkspaceWorktrees(input),
        withRepositoryLock: async () => { throw new Error("cross-Workspace candidate must be refused before locking"); },
      });
      expect(crossWorkspace.refused).toEqual([expect.objectContaining({
        path: alphaLegCanonical,
        reason: expect.stringContaining("outside the selected Workspace"),
      })]);

      const auditOutput = await capture(() => workspaceWorktreeAuditCommand(["--workspace", "ws-alpha"]));
      const dryRunOutput = await capture(() => workspaceWorktreeCleanupCommand(["--workspace", "ws-alpha", "--dry-run"]));
      const applyOutput = await capture(() => workspaceWorktreeCleanupCommand(["--workspace", "ws-alpha", "--apply", "--json"]));
      expect(auditOutput).toMatchObject({ status: 0, stderr: "" });
      expect(auditOutput.stdout).toContain("ws-alpha/US-A");
      expect(auditOutput.stdout).toContain("ws-beta/US-B");
      expect(auditOutput.stdout).toContain("preserved_dirty_no_tcr");
      expect(dryRunOutput).toMatchObject({ status: 0, stderr: "" });
      expect(dryRunOutput.stdout).toContain("counted Workspace Issue worktrees");
      expect(dryRunOutput.stdout).toContain(alphaLegCanonical);
      expect(JSON.parse(applyOutput.stdout)).toEqual(expect.objectContaining({
        removed: [expect.objectContaining({ workspaceId: "ws-alpha", path: alphaLegCanonical })],
        refused: [],
      }));
      expect(existsSync(alphaLeg)).toBe(false);
      expect(existsSync(betaLeg)).toBe(true);
      expect(readFileSync(join(betaLeg, "scratch.txt"), "utf8")).toBe("dirty\n");

      if (process.env["ROLL_CAPTURE_EVIDENCE"] === "1") {
        console.log("=== Workspace audit ===\n" + auditOutput.stdout.trimEnd());
        console.log("=== Workspace cleanup dry-run ===\n" + dryRunOutput.stdout.trimEnd());
        console.log("=== Cross-Workspace refusal ===\n" + JSON.stringify(crossWorkspace, null, 2));
        console.log("=== Workspace cleanup apply ===\n" + JSON.stringify(JSON.parse(applyOutput.stdout), null, 2));
      }
    } finally {
      if (previousRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = previousRollHome;
      if (previousThreshold === undefined) delete process.env["ROLL_BRANCH_CANARY_MAX"];
      else process.env["ROLL_BRANCH_CANARY_MAX"] = previousThreshold;
    }
  });
});
