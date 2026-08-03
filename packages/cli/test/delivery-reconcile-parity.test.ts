import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ISSUE_MANIFEST_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  integrationAcceptanceCommandDigest,
  repositoryIdFromRemote,
} from "@roll/spec";
import {
  appendIssueIntegrationAcceptanceEvidence,
  appendRepositoryMergeEvidence,
} from "@roll/infra";
import {
  deliveryCommand,
  type DeliveryCommandDeps,
} from "../src/commands/delivery.js";
import { loopDeliveryReconcileCommand } from "../src/commands/loop-reconcile.js";
import type { BacklogTargetResolver, ResolvedBacklogTarget } from "../src/commands/backlog-target.js";

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const roots: string[] = [];
const API = "repo-aaaaaaaaaaaa";
const WEB = "repo-bbbbbbbbbbbb";
const API_SHA = "a".repeat(40);
const WEB_SHA = "b".repeat(40);
const COMMAND = ["pnpm", "test:integration"] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { readonly root: string; readonly target: ResolvedBacklogTarget } {
  const root = mkdtempSync(join(tmpdir(), "roll-delivery-parity-"));
  const remote = "https://example.test/ws-parity/api.git";
  const parsedRepoId = repositoryIdFromRemote(remote);
  if (!parsedRepoId.ok) throw new Error("fixture remote must be valid");
  roots.push(root);
  mkdirSync(join(root, "backlog"), { recursive: true });
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId: "ws-parity",
    displayName: "ws-parity",
    requirements: [],
    repositories: [{
      schema: REPOSITORY_BINDING_V1,
      repoId: parsedRepoId.value,
      alias: "api",
      remote,
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "backlog", "index.md"), "| US-FAKE | false completion truth | ✅ Done |\n", "utf8");
  return {
    root,
    target: {
      ok: true,
      workspaceId: "ws-parity",
      workspaceRoot: root,
      canonicalRoot: root,
      backlogPath: join(root, "backlog", "index.md"),
      storyRoot: join(root, "backlog"),
      runtimeRoot: join(root, "runtime"),
      configPath: join(root, "runtime", "backlog-sync.yaml"),
    },
  };
}

function resolver(target: ResolvedBacklogTarget): BacklogTargetResolver {
  return (): ResolvedBacklogTarget => target;
}

function writeIssue(
  root: string,
  storyId: string,
  repositories: ReadonlyArray<{ readonly repoId: string; readonly alias: string }>,
): string {
  const issueRoot = join(root, "issues", storyId);
  mkdirSync(join(issueRoot, "evidence"), { recursive: true });
  writeFileSync(join(issueRoot, "manifest.json"), `${JSON.stringify({
    schema: ISSUE_MANIFEST_V1,
    workspaceId: "ws-parity",
    storyId,
    requirements: [],
    repositories: repositories.map((repository) => ({
      ...repository,
      access: "write",
      requiredDelivery: true,
      noChangePolicy: "changes_required",
    })),
    integrationAcceptance: { command: COMMAND },
  }, null, 2)}\n`, "utf8");
  return issueRoot;
}

function merged(issueRoot: string, storyId: string, repoId: string, prNumber: number, sha: string, recordedAt: number): void {
  appendRepositoryMergeEvidence(issueRoot, {
    workspaceId: "ws-parity",
    storyId,
    repoId,
    cycleId: `cycle-${storyId}-${repoId}`,
    authority: "provider",
    prNumber,
    prState: "MERGED",
    ci: "green",
    mergeCommit: sha,
    recordedAt,
  });
}

function open(issueRoot: string, storyId: string, repoId: string, prNumber: number, recordedAt: number): void {
  appendRepositoryMergeEvidence(issueRoot, {
    workspaceId: "ws-parity",
    storyId,
    repoId,
    cycleId: `cycle-${storyId}-${repoId}`,
    authority: "provider",
    prNumber,
    prState: "OPEN",
    ci: "pending",
    recordedAt,
  });
}

function accept(issueRoot: string, storyId: string, inputMergeCommits: Readonly<Record<string, string>>): void {
  writeFileSync(join(issueRoot, "evidence", "integration.txt"), "pass\n", "utf8");
  appendIssueIntegrationAcceptanceEvidence(issueRoot, {
    workspaceId: "ws-parity",
    storyId,
    inputMergeCommits,
    commandDigest: integrationAcceptanceCommandDigest(COMMAND),
    profile: "parity",
    verdict: "pass",
    artifactPath: "evidence/integration.txt",
    recordedAt: 30,
  });
}

function capture(run: () => number): Run {
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error deterministic command capture
  process.stdout.write = (chunk: string | Uint8Array): boolean => ((stdout += String(chunk)), true);
  // @ts-expect-error deterministic command capture
  process.stderr.write = (chunk: string | Uint8Array): boolean => ((stderr += String(chunk)), true);
  try {
    return { status: run(), stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function commands(target: ResolvedBacklogTarget, storyId: string): { readonly delivery: Run; readonly loop: Run } {
  const deps: DeliveryCommandDeps = { resolveTarget: resolver(target) };
  const args = [storyId, "--workspace", target.workspaceId, "--json"];
  return {
    delivery: capture(() => deliveryCommand(["reconcile", ...args], deps)),
    loop: capture(() => loopDeliveryReconcileCommand(args, deps)),
  };
}

describe("US-WS-015 delivery reconcile parity", () => {
  it("returns the identical delivered verdict for a one-repository Issue", () => {
    const f = workspace();
    const storyId = "US-ONE";
    const issueRoot = writeIssue(f.root, storyId, [{ repoId: API, alias: "api" }]);
    merged(issueRoot, storyId, API, 101, API_SHA, 10);
    accept(issueRoot, storyId, { [API]: API_SHA });

    const result = commands(f.target, storyId);
    expect(result.delivery.status).toBe(0);
    expect(result.loop).toEqual(result.delivery);
    expect(JSON.parse(result.delivery.stdout).issues[0]).toMatchObject({ storyId, state: "delivered" });
  });

  it("returns the identical partial verdict for a two-repository Issue and ignores backlog Done claims", () => {
    const f = workspace();
    const storyId = "US-MULTI";
    writeFileSync(f.target.backlogPath, `| ${storyId} | false completion truth | ✅ Done |\n`, "utf8");
    const issueRoot = writeIssue(f.root, storyId, [
      { repoId: API, alias: "api" },
      { repoId: WEB, alias: "web" },
    ]);
    merged(issueRoot, storyId, API, 201, API_SHA, 20);
    open(issueRoot, storyId, WEB, 202, 21);
    const backlogBefore = readFileSync(f.target.backlogPath, "utf8");
    const eventsBefore = readFileSync(join(issueRoot, "events.jsonl"), "utf8");

    const result = commands(f.target, storyId);
    expect(result.delivery.status).toBe(0);
    expect(result.loop.status).toBe(0);
    const deliveryResult = JSON.parse(result.delivery.stdout) as { changed: boolean; issues: readonly unknown[] };
    const loopResult = JSON.parse(result.loop.stdout) as { changed: boolean; issues: readonly unknown[] };
    expect(loopResult.issues).toEqual(deliveryResult.issues);
    expect([deliveryResult.changed, loopResult.changed]).toEqual([true, false]);
    expect(deliveryResult.issues[0]).toMatchObject({
      storyId,
      state: "partial_delivery",
      outstandingGates: [{ kind: "repository", repoId: WEB, status: "awaiting_merge" }],
    });
    expect(backlogBefore).toContain("✅ Done");
    expect(readFileSync(f.target.backlogPath, "utf8")).toContain("📋 Todo");
    expect(readFileSync(join(issueRoot, "events.jsonl"), "utf8")).toBe(eventsBefore);
  });

  it("requires an explicit Workspace on the loop alias", () => {
    const f = workspace();
    const deps: DeliveryCommandDeps = { resolveTarget: resolver(f.target) };
    const result = capture(() => loopDeliveryReconcileCommand(["--json"], deps));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_arguments");
  });
});
