import { describe, expect, it } from "vitest";
import {
  deriveIssueCompletion,
  type IssueCompletionInput,
  type RepositoryMergeEvidence,
} from "../src/delivery/issue-completion.js";

const WS = "ws-1";
const STORY = "US-WS-013";
const API = "repo-aaaaaaaaaaaa";
const WEB = "repo-bbbbbbbbbbbb";
const API_MERGE = "a".repeat(40);
const WEB_MERGE = "b".repeat(40);

function provider(
  repoId: string,
  prState: "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN",
  options: { readonly mergeCommit?: string; readonly ci?: "green" | "red" | "pending" | "unknown"; readonly at?: number } = {},
): RepositoryMergeEvidence {
  return {
    workspaceId: WS,
    storyId: STORY,
    repoId,
    cycleId: `cycle-${repoId}`,
    authority: "provider",
    prNumber: repoId === API ? 101 : 202,
    prUrl: `https://example.invalid/${repoId}/pull/1`,
    prState,
    ci: options.ci ?? "green",
    ...(options.mergeCommit === undefined ? {} : { mergeCommit: options.mergeCommit }),
    recordedAt: options.at ?? 1,
  } as RepositoryMergeEvidence;
}

function input(overrides: Partial<IssueCompletionInput> = {}): IssueCompletionInput {
  return {
    workspaceId: WS,
    storyId: STORY,
    repositories: [
      { repoId: API, required: true },
      { repoId: WEB, required: true },
    ],
    repositoryFacts: [],
    integrationAcceptances: [],
    backlogDone: false,
    ...overrides,
  };
}

describe("US-WS-013 Issue completion state matrix", () => {
  it.each([
    ["planned", [], "planned"],
    ["building", [{ workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c1", authority: "projection", state: "building", recordedAt: 1 }], "building"],
    ["awaiting merges", [provider(API, "OPEN"), provider(WEB, "OPEN")], "awaiting_repo_merges"],
    ["partial delivery", [provider(API, "MERGED", { mergeCommit: API_MERGE }), provider(WEB, "OPEN", { ci: "red" })], "partial_delivery"],
    ["integration pending", [provider(API, "MERGED", { mergeCommit: API_MERGE }), provider(WEB, "MERGED", { mergeCommit: WEB_MERGE })], "integration_pending"],
    ["blocked", [provider(API, "OPEN", { ci: "red" })], "blocked"],
    ["abandoned", [provider(API, "CLOSED")], "abandoned"],
  ] as const)("derives %s", (_label, repositoryFacts, state) => {
    expect(deriveIssueCompletion(input({ repositoryFacts }))).toMatchObject({ state });
  });

  it("delivers only when acceptance passes against every exact immutable merge commit", () => {
    const repositoryFacts = [
      provider(API, "MERGED", { mergeCommit: API_MERGE }),
      provider(WEB, "MERGED", { mergeCommit: WEB_MERGE }),
    ];
    expect(deriveIssueCompletion(input({
      repositoryFacts,
      integrationAcceptances: [{
        workspaceId: WS,
        storyId: STORY,
        inputMergeCommits: { [API]: API_MERGE, [WEB]: WEB_MERGE },
        commandDigest: "c".repeat(64),
        profile: "workspace-integration/v1",
        verdict: "pass",
        artifactPath: "evidence/integration.txt",
        recordedAt: 3,
      }],
    }))).toMatchObject({ state: "delivered", mergeCommits: { [API]: API_MERGE, [WEB]: WEB_MERGE } });
  });

  it("blocks a stale or failing integration acceptance instead of reusing pre-merge heads", () => {
    const repositoryFacts = [
      provider(API, "MERGED", { mergeCommit: API_MERGE }),
      provider(WEB, "MERGED", { mergeCommit: WEB_MERGE }),
    ];
    for (const acceptance of [
      { inputMergeCommits: { [API]: API_MERGE, [WEB]: "c".repeat(40) }, verdict: "pass" as const },
      { inputMergeCommits: { [API]: API_MERGE, [WEB]: WEB_MERGE }, verdict: "fail" as const },
    ]) {
      expect(deriveIssueCompletion(input({
        repositoryFacts,
        integrationAcceptances: [{
          workspaceId: WS,
          storyId: STORY,
          ...acceptance,
          commandDigest: "c".repeat(64),
          profile: "workspace-integration/v1",
          artifactPath: "evidence/integration.txt",
          recordedAt: 3,
        }],
      }))).toMatchObject({ state: "blocked" });
    }
  });

  it("never lets backlog Done or one merged leg produce delivered", () => {
    expect(deriveIssueCompletion(input({
      backlogDone: true,
      repositoryFacts: [provider(API, "MERGED", { mergeCommit: API_MERGE })],
    }))).toMatchObject({ state: "partial_delivery" });
  });

  it("never lets a generated merged projection plus backlog Done and acceptance produce delivered", () => {
    expect(deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      backlogDone: true,
      repositoryFacts: [{
        workspaceId: WS,
        storyId: STORY,
        repoId: API,
        cycleId: "c1",
        authority: "projection",
        state: "merged",
        mergeCommit: API_MERGE,
        recordedAt: 1,
      }],
      integrationAcceptances: [{
        workspaceId: WS,
        storyId: STORY,
        inputMergeCommits: { [API]: API_MERGE },
        commandDigest: "c".repeat(64),
        profile: "workspace-integration/v1",
        verdict: "pass",
        artifactPath: "generated-only.txt",
        recordedAt: 2,
      }],
    }))).toMatchObject({ state: "integration_pending" });
  });

  it("rejects a ref-like provider merge value even when acceptance repeats the same mutable value", () => {
    expect(deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      repositoryFacts: [provider(API, "MERGED", { mergeCommit: "main" })],
      integrationAcceptances: [{
        workspaceId: WS,
        storyId: STORY,
        inputMergeCommits: { [API]: "main" },
        commandDigest: "c".repeat(64),
        profile: "workspace-integration/v1",
        verdict: "pass",
        artifactPath: "evidence/invalid-ref.txt",
        recordedAt: 2,
      }],
    }))).toMatchObject({ state: "blocked", conflicts: [{ repoId: API, code: "invalid_merge_evidence" }] });
  });
});

describe("US-WS-013 repository fact authority and rebuild", () => {
  it("uses provider over integration-branch reachability and reachability over projection", () => {
    const projection = { workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c1", authority: "projection" as const, state: "building" as const, recordedAt: 1 };
    const reachable = { workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c1", authority: "integration_branch" as const, reachable: true as const, mergeCommit: API_MERGE, recordedAt: 2 };
    expect(deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      repositoryFacts: [projection, reachable],
    }))).toMatchObject({ state: "integration_pending", repositories: [{ repoId: API, authority: "integration_branch" }] });
    expect(deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      repositoryFacts: [projection, reachable, provider(API, "MERGED", { mergeCommit: API_MERGE, at: 3 })],
    }))).toMatchObject({ repositories: [{ repoId: API, authority: "provider" }] });
  });

  it("fails loud with repo identity when strong authorities contradict", () => {
    const result = deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      repositoryFacts: [
        { workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c1", authority: "integration_branch", reachable: true, mergeCommit: API_MERGE, recordedAt: 1 },
        provider(API, "OPEN", { at: 2 }),
      ],
    }));
    expect(result).toMatchObject({ state: "blocked", conflicts: [{ repoId: API }] });
  });

  it("falls back from provider UNKNOWN to integration-branch reachability", () => {
    expect(deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      repositoryFacts: [
        provider(API, "UNKNOWN", { at: 2 }),
        { workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c1", authority: "integration_branch", reachable: true, mergeCommit: API_MERGE, recordedAt: 1 },
      ],
    }))).toMatchObject({ state: "integration_pending", repositories: [{ authority: "integration_branch" }] });
  });

  it("keeps an immutable provider merge authoritative when a later poll is UNKNOWN", () => {
    expect(deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      repositoryFacts: [
        provider(API, "MERGED", { mergeCommit: API_MERGE, at: 1 }),
        provider(API, "UNKNOWN", { at: 2 }),
      ],
    }))).toMatchObject({
      state: "integration_pending",
      repositories: [{ status: "merged", authority: "provider", mergeCommit: API_MERGE }],
    });
  });

  it("fails loud when reachable integration-branch evidence omits the immutable merge commit", () => {
    expect(deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      repositoryFacts: [
        { workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c1", authority: "integration_branch", reachable: true, recordedAt: 1 },
      ],
    }))).toMatchObject({ state: "blocked", conflicts: [{ repoId: API, code: "invalid_merge_evidence" }] });
  });

  it("fails loud when a later integration-branch observation retracts prior reachability", () => {
    expect(deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      repositoryFacts: [
        { workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c1", authority: "integration_branch", reachable: true, mergeCommit: API_MERGE, recordedAt: 1 },
        { workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c2", authority: "integration_branch", reachable: false, recordedAt: 2 },
      ],
    }))).toMatchObject({ state: "blocked", conflicts: [{ repoId: API, code: "strong_fact_conflict" }] });
  });

  it("fails loud when integration-branch facts disagree on the immutable merge commit", () => {
    expect(deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      repositoryFacts: [
        { workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c1", authority: "integration_branch", reachable: true, mergeCommit: API_MERGE, recordedAt: 1 },
        { workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c2", authority: "integration_branch", reachable: true, mergeCommit: WEB_MERGE, recordedAt: 2 },
      ],
    }))).toMatchObject({ state: "blocked", conflicts: [{ repoId: API, code: "conflicting_merge_commit" }] });
  });

  it("is idempotent under duplicate facts and rebuilds identically without generated projections", () => {
    const strong = provider(API, "MERGED", { mergeCommit: API_MERGE });
    const projection = { workspaceId: WS, storyId: STORY, repoId: API, cycleId: "c1", authority: "projection" as const, state: "building" as const, recordedAt: 2 };
    const base = input({ repositories: [{ repoId: API, required: true }], repositoryFacts: [strong] });
    expect(deriveIssueCompletion({ ...base, repositoryFacts: [strong, strong, projection] })).toEqual(deriveIssueCompletion(base));
  });

  it("folds a one-repository Issue through the same exact-merge acceptance path", () => {
    expect(deriveIssueCompletion(input({
      repositories: [{ repoId: API, required: true }],
      repositoryFacts: [provider(API, "MERGED", { mergeCommit: API_MERGE })],
      integrationAcceptances: [{
        workspaceId: WS,
        storyId: STORY,
        inputMergeCommits: { [API]: API_MERGE },
        commandDigest: "c".repeat(64),
        profile: "workspace-integration/v1",
        verdict: "pass",
        artifactPath: "evidence/one-repo.txt",
        recordedAt: 2,
      }],
    }))).toMatchObject({ state: "delivered" });
  });
});
