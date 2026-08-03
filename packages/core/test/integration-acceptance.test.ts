import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IntegrationAcceptanceError,
  runIntegrationAcceptance,
  type IntegrationAcceptanceInput,
} from "../src/delivery/integration-acceptance.js";

const WORKSPACE = "ws-1";
const STORY = "US-WS-014";
const API = "repo-aaaaaaaaaaaa";
const WEB = "repo-bbbbbbbbbbbb";
const API_MERGE = "a".repeat(40);
const WEB_MERGE = "b".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(branch: "main" | "release"): { readonly path: string; readonly mergeCommit: string } {
  const path = mkdtempSync(join(tmpdir(), "roll-integration-acceptance-"));
  roots.push(path);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: path });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "base"], { cwd: path });
  if (branch === "release") execFileSync("git", ["checkout", "-q", "-b", "release"], { cwd: path });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", `${branch}-merge`], { cwd: path });
  return {
    path,
    mergeCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim(),
  };
}

function input(overrides: Partial<IntegrationAcceptanceInput> = {}): IntegrationAcceptanceInput {
  return {
    workspaceId: WORKSPACE,
    storyId: STORY,
    repositories: [
      {
        repoId: API,
        repositoryPath: "/workspace/issues/US-WS-014/api",
        integrationBranch: "main",
        authority: "provider",
        status: "merged",
        mergeCommit: API_MERGE,
      },
      {
        repoId: WEB,
        repositoryPath: "/workspace/issues/US-WS-014/web",
        integrationBranch: "release",
        authority: "integration_branch",
        status: "merged",
        mergeCommit: WEB_MERGE,
      },
    ],
    command: ["pnpm", "test:integration"],
    profile: "workspace-integration/v1",
    artifactPath: "evidence/integration/result.txt",
    recordedAt: 100,
    ...overrides,
  };
}

describe("US-WS-014 exact-SHA integration acceptance", () => {
  it("does not execute before every required repository has a strong immutable merge", async () => {
    const isReachable = vi.fn();
    const execute = vi.fn();

    const result = await runIntegrationAcceptance(input({
      repositories: [
        input().repositories[0]!,
        { ...input().repositories[1]!, status: "awaiting_merge", mergeCommit: undefined },
      ],
    }), { isReachable, execute });

    expect(result).toEqual({
      status: "pending",
      message: `integration acceptance pending: ${WEB} has no strongly proven merge commit`,
    });
    expect(isReachable).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unsafe integration refs before diagnostics can echo credential-like input", async () => {
    const secret = "https://token@example.invalid/repository";
    const isReachable = vi.fn();

    await expect(runIntegrationAcceptance(input({
      repositories: [{ ...input().repositories[0]!, integrationBranch: secret }],
    }), { isReachable, execute: vi.fn() })).rejects.toSatisfy((error: unknown) =>
      error instanceof IntegrationAcceptanceError && !error.message.includes(secret)
    );
    expect(isReachable).not.toHaveBeenCalled();
  });

  it("blocks on an exact-SHA reachability mismatch without inventing command evidence", async () => {
    const isReachable = vi.fn(async (repository: { readonly repoId: string }) => repository.repoId === API);
    const execute = vi.fn();

    const result = await runIntegrationAcceptance(input(), { isReachable, execute });

    expect(result).toEqual({
      status: "blocked",
      message: `integration acceptance blocked: ${WEB}@${WEB_MERGE} is not reachable from integration branch release`,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes once with the exact merge map and persists command/profile identity", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, artifactPath: "evidence/integration/result.txt" }));

    const result = await runIntegrationAcceptance(input(), {
      isReachable: vi.fn(async () => true),
      execute,
    });

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.evidence).toEqual({
      workspaceId: WORKSPACE,
      storyId: STORY,
      inputMergeCommits: { [API]: API_MERGE, [WEB]: WEB_MERGE },
      commandDigest: result.evidence.commandDigest,
      profile: "workspace-integration/v1",
      verdict: "pass",
      artifactPath: "evidence/integration/result.txt",
      recordedAt: 100,
    });
    expect(execute).toHaveBeenCalledWith({
      command: ["pnpm", "test:integration"],
      commandDigest: result.evidence.commandDigest,
      profile: "workspace-integration/v1",
      inputMergeCommits: { [API]: API_MERGE, [WEB]: WEB_MERGE },
      artifactPath: "evidence/integration/result.txt",
    });
  });

  it("records command failure against the same exact merge inputs", async () => {
    const result = await runIntegrationAcceptance(input(), {
      isReachable: vi.fn(async () => true),
      execute: vi.fn(async () => ({ exitCode: 7, artifactPath: "evidence/integration/result.txt" })),
    });

    expect(result).toMatchObject({
      status: "recorded",
      evidence: { verdict: "fail", inputMergeCommits: { [API]: API_MERGE, [WEB]: WEB_MERGE } },
      message: "integration acceptance command failed with exit code 7",
    });
  });

  it("refuses to persist command output under a different artifact identity", async () => {
    await expect(runIntegrationAcceptance(input(), {
      isReachable: vi.fn(async () => true),
      execute: vi.fn(async () => ({ exitCode: 0, artifactPath: "evidence/integration/other.txt" })),
    })).rejects.toThrow(IntegrationAcceptanceError);
  });

  it("runs against real local repositories and their distinct configured integration branches", async () => {
    const api = repository("main");
    const web = repository("release");
    const actual = input({
      repositories: [
        { ...input().repositories[0]!, repositoryPath: api.path, mergeCommit: api.mergeCommit },
        { ...input().repositories[1]!, repositoryPath: web.path, mergeCommit: web.mergeCommit },
      ],
    });
    const isReachable = async (candidate: {
      readonly repositoryPath: string;
      readonly mergeCommit: string;
      readonly integrationBranch: string;
    }): Promise<boolean | undefined> => {
      const result = spawnSync(
        "git",
        ["merge-base", "--is-ancestor", candidate.mergeCommit, candidate.integrationBranch],
        { cwd: candidate.repositoryPath, stdio: "ignore" },
      );
      return result.status === 0 ? true : result.status === 1 ? false : undefined;
    };

    await expect(runIntegrationAcceptance(actual, {
      isReachable,
      execute: vi.fn(async () => ({ exitCode: 0, artifactPath: "evidence/integration/result.txt" })),
    })).resolves.toMatchObject({ status: "recorded", evidence: { verdict: "pass" } });
    await expect(runIntegrationAcceptance({
      ...actual,
      repositories: [actual.repositories[0]!, { ...actual.repositories[1]!, integrationBranch: "main" }],
    }, {
      isReachable,
      execute: vi.fn(async () => ({ exitCode: 0, artifactPath: "evidence/integration/result.txt" })),
    })).resolves.toMatchObject({
      status: "blocked",
      message: `integration acceptance blocked: ${WEB}@${web.mergeCommit} is not reachable from integration branch main`,
    });
  });
});
