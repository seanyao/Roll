import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  blockedExternalCommands,
  createWorkspaceAcceptanceFixture,
  gitCommandLog,
  readIssue,
  rebuildCapturedRequirement,
  recordAcceptance,
  recordRepositoryFact,
  removeWorkspaceAcceptanceFixture,
  restoreBareRemote,
  runFakeAgentLeg,
  runRoll,
  writeStoryContract,
  type WorkspaceAcceptanceFixture,
} from "./fixtures/workspace/critical-flow.js";

const fixtures: WorkspaceAcceptanceFixture[] = [];

function fixture(): WorkspaceAcceptanceFixture {
  const created = createWorkspaceAcceptanceFixture();
  fixtures.push(created);
  return created;
}

function expectOk(result: ReturnType<typeof runRoll>): void {
  expect(result.status, result.stderr).toBe(0);
}

function initializeTwoWorkspaces(f: WorkspaceAcceptanceFixture): void {
  expectOk(runRoll(f, ["workspace", "create", "ws-alpha", "--config", f.alphaConfig, "--json"]));
  expectOk(runRoll(f, ["workspace", "create", "ws-beta", "--config", f.betaConfig, "--json"]));
  expectOk(runRoll(f, ["workspace", "activate", "ws-alpha", "--json"]));
  expectOk(runRoll(f, ["workspace", "activate", "ws-beta", "--json"]));
}

function deliveryState(f: WorkspaceAcceptanceFixture, storyId: string): Record<string, unknown> {
  const result = runRoll(f, ["delivery", "show", storyId, "--workspace", "ws-alpha", "--json"]);
  expectOk(result);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

afterEach(() => {
  for (const current of fixtures.splice(0)) removeWorkspaceAcceptanceFixture(current);
});

describe("US-WS-020 Workspace multi-repository critical flow", () => {
  it("proves create → requirement → two-repo TCR → partial → exact-SHA delivery → Requirement attest", () => {
    const f = fixture();
    initializeTwoWorkspaces(f);

    const caches = readdirSync(join(f.rollHome, "repos")).filter((name) => name.endsWith(".git"));
    expect(caches).toHaveLength(2);
    expect(existsSync(join(f.alphaRoot, ".git"))).toBe(false);
    expect(existsSync(join(f.betaRoot, ".git"))).toBe(false);
    expect(join(f.alphaRoot, "runtime", "locks")).not.toBe(join(f.betaRoot, "runtime", "locks"));

    const storyId = "US-MULTI-1";
    writeStoryContract(f.alphaRoot, storyId);
    const requirementBody = join(f.home, "requirement.md");
    writeFileSync(requirementBody, "Deliver one contract across API and Web.\n", "utf8");
    const captured = runRoll(f, [
      "workspace", "requirement", "add",
      "--workspace", "ws-alpha",
      "--provider", "file",
      "--ref", "REQ-1",
      "--revision", "1",
      "--body-file", requirementBody,
      "--story", storyId,
      "--json",
    ]);
    expectOk(captured);
    const requirementPath = (JSON.parse(captured.stdout) as { readonly path: string }).path;
    const requirementId = basename(requirementPath);
    const requirementProvider = basename(dirname(requirementPath));

    const initialized = runRoll(f, ["workspace", "issue", "init", storyId, "--workspace", "ws-alpha", "--json"]);
    expectOk(initialized);
    const issue = readIssue(f.alphaRoot, storyId);
    expect(issue.repositories.map((target) => target.alias)).toEqual(["api", "web"]);
    expect(issue.repositories.every((target) => target.worktreePath.startsWith(join(f.alphaRoot, "issues", storyId)))).toBe(true);

    const heads = Object.fromEntries(issue.repositories.map((target) => [target.repoId, runFakeAgentLeg(f.alphaRoot, storyId, target)]));
    const [api, web] = issue.repositories;
    if (api === undefined || web === undefined) throw new Error("critical fixture requires two repository targets");

    recordRepositoryFact({
      workspaceRoot: f.alphaRoot,
      workspaceId: "ws-alpha",
      storyId,
      repoId: api.repoId,
      cycleId: "cycle-api",
      recordedAt: 10,
      prNumber: 101,
      prState: "MERGED",
      ci: "green",
      mergeCommit: heads[api.repoId],
    });
    recordRepositoryFact({
      workspaceRoot: f.alphaRoot,
      workspaceId: "ws-alpha",
      storyId,
      repoId: web.repoId,
      cycleId: "cycle-web-open",
      recordedAt: 11,
      prNumber: 202,
      prState: "OPEN",
      ci: "pending",
    });
    expect(deliveryState(f, storyId)).toMatchObject({ issue: { state: "partial_delivery" } });
    expect(readFileSync(join(f.alphaRoot, "backlog", "index.md"), "utf8")).toContain("📋 Todo");

    recordRepositoryFact({
      workspaceRoot: f.alphaRoot,
      workspaceId: "ws-alpha",
      storyId,
      repoId: web.repoId,
      cycleId: "cycle-web-merged",
      recordedAt: 12,
      prNumber: 202,
      prState: "MERGED",
      ci: "green",
      mergeCommit: heads[web.repoId],
    });
    expect(deliveryState(f, storyId)).toMatchObject({ issue: { state: "integration_pending" } });

    recordAcceptance({
      workspaceRoot: f.alphaRoot,
      workspaceId: "ws-alpha",
      storyId,
      mergeCommits: { ...heads, [api.repoId]: "f".repeat(40) },
      recordedAt: 13,
    });
    expect(deliveryState(f, storyId)).toMatchObject({
      issue: { state: "blocked", integrationAcceptance: { status: "input_mismatch" } },
    });
    const pendingAttest = rebuildCapturedRequirement({ workspaceRoot: f.alphaRoot, provider: requirementProvider, requirementId });
    expect(pendingAttest.status).toBe("partial");

    recordAcceptance({
      workspaceRoot: f.alphaRoot,
      workspaceId: "ws-alpha",
      storyId,
      mergeCommits: heads,
      recordedAt: 14,
    });
    expect(deliveryState(f, storyId)).toMatchObject({
      issue: { state: "delivered", integrationAcceptance: { status: "pass" }, outstandingGates: [] },
    });
    const reconciled = runRoll(f, ["delivery", "reconcile", storyId, "--workspace", "ws-alpha", "--json"]);
    expectOk(reconciled);
    expect(JSON.parse(reconciled.stdout)).toMatchObject({ changed: true, issues: [{ storyId, state: "delivered" }] });
    expect(readFileSync(join(f.alphaRoot, "backlog", "index.md"), "utf8")).toContain("✅ Done");
    const finalAttest = readFileSync(join(requirementPath, "attest.md"), "utf8");
    expect(finalAttest).toContain("Final verdict: PASS");
    expect(finalAttest).toContain(`${api.repoId}@${heads[api.repoId]}`);
    expect(finalAttest).toContain(`${web.repoId}@${heads[web.repoId]}`);

    const issueCwd = join(f.alphaRoot, "issues", storyId, "api");
    const fromIssue = runRoll(f, ["backlog"], issueCwd);
    expectOk(fromIssue);
    expect(fromIssue.stdout).toContain("ws-alpha");
    const aggregateBacklog = runRoll(f, ["backlog", "--all"]);
    const aggregateDelivery = runRoll(f, ["delivery", "list", "--all", "--json"]);
    expectOk(aggregateBacklog);
    expectOk(aggregateDelivery);
    expect((JSON.parse(aggregateDelivery.stdout) as { workspaces: readonly unknown[] }).workspaces).toHaveLength(2);
    const aggregateMutation = runRoll(f, ["delivery", "reconcile", "--all", "--json"]);
    expect(aggregateMutation.status).toBe(1);
    expect(JSON.parse(aggregateMutation.stderr)).toMatchObject({ error: { code: "all_requires_readonly" } });

    expect(gitCommandLog(f).some((line) => /^push(?:\s|$)/u.test(line))).toBe(false);
    expect(blockedExternalCommands(f)).toBe("");
  });

  it("fails loud and converges after cache loss, second-repository init failure, stale registry path and one Workspace pause", () => {
    const f = fixture();
    initializeTwoWorkspaces(f);
    const storyId = "US-FAULT-1";
    writeStoryContract(f.alphaRoot, storyId);
    const requirementBody = join(f.home, "fault-requirement.md");
    writeFileSync(requirementBody, "Exercise recovery boundaries.\n", "utf8");
    expectOk(runRoll(f, [
      "workspace", "requirement", "add",
      "--workspace", "ws-alpha",
      "--provider", "file",
      "--ref", "REQ-1",
      "--revision", "1",
      "--body-file", requirementBody,
      "--story", storyId,
      "--json",
    ]));
    const manifest = JSON.parse(readFileSync(join(f.alphaRoot, "workspace.yaml"), "utf8")) as {
      readonly repositories: readonly { readonly alias: string; readonly repoId: string }[];
    };
    const webRepo = manifest.repositories.find((repository) => repository.alias === "web");
    if (webRepo === undefined) throw new Error("web repository missing");
    rmSync(join(f.rollHome, "repos", `${webRepo.repoId}.git`), { recursive: true, force: true });
    const diagnosis = runRoll(f, ["workspace", "doctor", "ws-alpha", "--json"]);
    expectOk(diagnosis);
    expect((JSON.parse(diagnosis.stdout) as { status: string }).status, diagnosis.stdout).toBe("repairable");
    const repaired = runRoll(f, ["workspace", "doctor", "ws-alpha", "--repair", `rebuild_cache:${webRepo.repoId}`, "--json"]);
    expectOk(repaired);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ outcome: "repaired", report: { status: "healthy" } });

    rmSync(f.webRemote, { recursive: true, force: true });
    const failedInit = runRoll(f, ["workspace", "issue", "init", storyId, "--workspace", "ws-alpha", "--json"]);
    expect(failedInit.status).toBe(1);
    expect(existsSync(join(f.alphaRoot, "issues", storyId))).toBe(false);
    restoreBareRemote(f.webSource, f.webRemote);
    expectOk(runRoll(f, ["workspace", "issue", "init", storyId, "--workspace", "ws-alpha", "--json"]));

    const movedBeta = join(f.home, "beta-moved");
    renameSync(f.betaRoot, movedBeta);
    const stale = runRoll(f, ["workspace", "doctor", "ws-beta", "--json"]);
    expectOk(stale);
    expect(JSON.parse(stale.stdout)).toMatchObject({ status: "repairable" });
    const pathRepair = runRoll(f, [
      "workspace", "doctor", "ws-beta", "--repair", "update_registry_path:ws-beta", "--path", movedBeta, "--json",
    ]);
    expectOk(pathRepair);
    expect(JSON.parse(pathRepair.stdout)).toMatchObject({ outcome: "repaired", report: { status: "healthy" } });

    expectOk(runRoll(f, ["workspace", "pause", "ws-alpha", "--json"]));
    const listed = runRoll(f, ["workspace", "list", "--json"]);
    expectOk(listed);
    expect((JSON.parse(listed.stdout) as { workspaces: readonly { workspaceId: string; lifecycle: string }[] }).workspaces).toEqual([
      expect.objectContaining({ workspaceId: "ws-alpha", lifecycle: "paused" }),
      expect.objectContaining({ workspaceId: "ws-beta", lifecycle: "active" }),
    ]);
  });

  it("wires every expensive boundary into the local-only critical E2E command", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const command = packageJson.scripts["test:e2e"] ?? "";
    for (const test of [
      "critical-flows.e2e.test.ts",
      "workspace-multirepo.critical.e2e.test.ts",
      "workspace-migrate-apply.critical.e2e.test.ts",
      "workspace-worktree-lifecycle.e2e.test.ts",
      "run-cycle.integration.test.ts",
    ]) expect(command).toContain(test);

    expect({
      capacityContention: "run-cycle.integration.test.ts > waiting_capacity",
      worktreeSafety: "workspace-worktree-lifecycle.e2e.test.ts > preserve dirty/foreign and reclaim delivered",
      migrationApply: "workspace-migrate-apply.critical.e2e.test.ts > standard Workspace without product checkout",
      migrationBlocks: "workspace-migrate-check.difftest.test.ts > dirty/unpushed/in-flight/product cutover/roll-meta",
      stdoutContracts: "workspace-*.difftest.test.ts snapshots",
    }).toMatchInlineSnapshot(`
      {
        "capacityContention": "run-cycle.integration.test.ts > waiting_capacity",
        "migrationApply": "workspace-migrate-apply.critical.e2e.test.ts > standard Workspace without product checkout",
        "migrationBlocks": "workspace-migrate-check.difftest.test.ts > dirty/unpushed/in-flight/product cutover/roll-meta",
        "stdoutContracts": "workspace-*.difftest.test.ts snapshots",
        "worktreeSafety": "workspace-worktree-lifecycle.e2e.test.ts > preserve dirty/foreign and reclaim delivered",
      }
    `);
  });
});
