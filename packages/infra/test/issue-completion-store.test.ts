import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveIssueCompletion } from "@roll/core";
import {
  integrationAcceptanceCommandDigest,
  type IssueIntegrationAcceptanceEvidence,
  type RepositoryMergeEvidence,
} from "@roll/spec";
import {
  appendIssueIntegrationAcceptanceEvidence,
  appendRepositoryMergeEvidence,
  IssueCompletionEvidenceError,
  readIssueCompletionEvidence,
} from "../src/issue-completion-store.js";

const roots: string[] = [];
const WORKSPACE = "ws-1";
const STORY = "US-WS-013";
const REPO = "repo-aaaaaaaaaaaa";
const MERGE = "a".repeat(40);

function fixture(): string {
  const issueRoot = mkdtempSync(join(tmpdir(), "roll-issue-completion-"));
  roots.push(issueRoot);
  writeFileSync(join(issueRoot, "manifest.json"), `${JSON.stringify({
    schema: "roll.issue/v1",
    workspaceId: WORKSPACE,
    storyId: STORY,
    requirements: [],
    repositories: [{
      repoId: REPO,
      alias: "api",
      access: "write",
      requiredDelivery: true,
      noChangePolicy: "changes_required",
    }],
    integrationAcceptance: { command: ["pnpm", "test:integration"] },
  })}\n`, "utf8");
  mkdirSync(join(issueRoot, "evidence"), { recursive: true });
  writeFileSync(join(issueRoot, "evidence", "integration.txt"), "PASS\n", "utf8");
  return issueRoot;
}

function mergeEvidence(): RepositoryMergeEvidence {
  return {
    workspaceId: WORKSPACE,
    storyId: STORY,
    repoId: REPO,
    cycleId: "cycle-1",
    authority: "provider",
    prNumber: 101,
    prUrl: "https://example.invalid/pull/101",
    prState: "MERGED",
    ci: "green",
    mergeCommit: MERGE,
    mergedAt: 2,
    recordedAt: 3,
  };
}

function acceptance(): IssueIntegrationAcceptanceEvidence {
  return {
    workspaceId: WORKSPACE,
    storyId: STORY,
    inputMergeCommits: { [REPO]: MERGE },
    commandDigest: integrationAcceptanceCommandDigest(["pnpm", "test:integration"]),
    profile: "workspace-integration/v1",
    verdict: "pass",
    artifactPath: "evidence/integration.txt",
    recordedAt: 4,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-WS-013 Issue completion evidence store", () => {
  it("atomically appends Issue-owned facts and rebuilds completion without a delivery sub-aggregate", () => {
    const issueRoot = fixture();
    appendRepositoryMergeEvidence(issueRoot, mergeEvidence());
    appendRepositoryMergeEvidence(issueRoot, mergeEvidence());
    appendIssueIntegrationAcceptanceEvidence(issueRoot, acceptance());

    const lines = readFileSync(join(issueRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      expect.objectContaining({ type: "issue:repository_merge_evidence_recorded", workspaceId: WORKSPACE, storyId: STORY, repoId: REPO, cycleId: "cycle-1", ts: 3 }),
      expect.objectContaining({ type: "issue:repository_merge_evidence_recorded", workspaceId: WORKSPACE, storyId: STORY, repoId: REPO, cycleId: "cycle-1", ts: 3 }),
      expect.objectContaining({ type: "issue:integration_acceptance_evidence_recorded", workspaceId: WORKSPACE, storyId: STORY, ts: 4 }),
    ]);
    expect(existsSync(join(issueRoot, "delivery"))).toBe(false);

    const evidence = readIssueCompletionEvidence(issueRoot);
    expect(deriveIssueCompletion({
      workspaceId: WORKSPACE,
      storyId: STORY,
      repositories: [{ repoId: REPO, required: true }],
      repositoryFacts: evidence.repositoryFacts,
      integrationAcceptances: evidence.integrationAcceptances,
      backlogDone: false,
    })).toMatchObject({ state: "delivered", mergeCommits: { [REPO]: MERGE } });
  });

  it("fails loud on malformed recognized evidence instead of silently dropping completion truth", () => {
    const issueRoot = fixture();
    writeFileSync(join(issueRoot, "events.jsonl"), `${JSON.stringify({
      type: "issue:repository_merge_evidence_recorded",
      ...mergeEvidence(),
      mergeCommit: "main",
      ts: 3,
    })}\n`, "utf8");

    expect(() => readIssueCompletionEvidence(issueRoot)).toThrow(IssueCompletionEvidenceError);
  });

  it("rejects evidence bound to another Issue identity before writing any event", () => {
    const issueRoot = fixture();

    expect(() => appendRepositoryMergeEvidence(issueRoot, {
      ...mergeEvidence(),
      storyId: "US-WS-OTHER",
    })).toThrow(IssueCompletionEvidenceError);
    expect(existsSync(join(issueRoot, "events.jsonl"))).toBe(false);
  });

  it("rejects acceptance evidence without a stable command/profile identity or Issue-owned artifact path", () => {
    const issueRoot = fixture();

    expect(() => appendIssueIntegrationAcceptanceEvidence(issueRoot, {
      ...acceptance(),
      commandDigest: "not-a-digest",
    })).toThrow(IssueCompletionEvidenceError);
    expect(() => appendIssueIntegrationAcceptanceEvidence(issueRoot, {
      ...acceptance(),
      artifactPath: "../outside.txt",
    })).toThrow(IssueCompletionEvidenceError);
    expect(existsSync(join(issueRoot, "events.jsonl"))).toBe(false);
  });

  it("binds acceptance to the manifest command and exact required repository set", () => {
    const issueRoot = fixture();

    expect(() => appendIssueIntegrationAcceptanceEvidence(issueRoot, {
      ...acceptance(),
      commandDigest: "d".repeat(64),
    })).toThrow(IssueCompletionEvidenceError);
    expect(() => appendIssueIntegrationAcceptanceEvidence(issueRoot, {
      ...acceptance(),
      inputMergeCommits: { [REPO]: MERGE, "repo-foreign": "f".repeat(40) },
    })).toThrow(IssueCompletionEvidenceError);
    expect(existsSync(join(issueRoot, "events.jsonl"))).toBe(false);
  });

  it("requires the acceptance artifact to exist as an Issue-owned regular file at append time", () => {
    const issueRoot = fixture();
    rmSync(join(issueRoot, "evidence", "integration.txt"));

    expect(() => appendIssueIntegrationAcceptanceEvidence(issueRoot, acceptance()))
      .toThrow(IssueCompletionEvidenceError);
    expect(existsSync(join(issueRoot, "events.jsonl"))).toBe(false);
  });
});
