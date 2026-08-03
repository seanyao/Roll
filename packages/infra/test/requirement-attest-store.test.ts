import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { integrationAcceptanceCommandDigest } from "@roll/spec";
import {
  appendIssueIntegrationAcceptanceEvidence,
  appendRepositoryMergeEvidence,
} from "../src/issue-completion-store.js";
import { captureRequirementSource } from "../src/requirement-source-store.js";
import {
  rebuildRequirementAttest,
  removeRequirementAttestProjection,
  RequirementAttestStoreError,
} from "../src/requirement-attest-store.js";

const roots: string[] = [];
const WORKSPACE = "ws-demo";
const REPO = "repo-ff7a87ddbb2b";
const MERGES = { "US-A": "a".repeat(40), "US-B": "b".repeat(40) } as const;

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fixture(): { readonly workspace: string; readonly requirementPath: string; readonly requirementId: string } {
  const root = mkdtempSync(join(tmpdir(), "roll-requirement-attest-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  write(join(workspace, "workspace.yaml"), `${JSON.stringify({
    schema: "roll.workspace/v1",
    workspaceId: WORKSPACE,
    displayName: "Demo",
    requirements: [{ provider: "jira", ref: "SOT-15499" }],
    repositories: [{
      schema: "roll.repository-binding/v1",
      repoId: REPO,
      alias: "product",
      remote: "https://example.test/owner/product",
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  }, null, 2)}\n`);
  for (const storyId of ["US-A", "US-B"]) {
    write(join(workspace, "backlog", "epic", storyId, "spec.md"), `# ${storyId}\n`);
  }
  const body = join(root, "requirement.md");
  write(body, "# Requirement\n");
  const captured = captureRequirementSource({
    rollHome: root,
    workspaceRoot: workspace,
    provider: "jira",
    ref: "SOT-15499",
    revision: "42",
    capturedAt: "2026-07-20T16:00:00.000Z",
    bodyFile: body,
    contextPaths: [],
    storyIds: ["US-A", "US-B"],
  });
  return { workspace, requirementPath: captured.requirementPath, requirementId: captured.manifest.requirementId };
}

function deliver(workspace: string, storyId: keyof typeof MERGES): string {
  const issueRoot = join(workspace, "issues", storyId);
  write(join(issueRoot, "manifest.json"), `${JSON.stringify({
    schema: "roll.issue/v1",
    workspaceId: WORKSPACE,
    storyId,
    requirements: [{ provider: "jira", ref: "SOT-15499" }],
    repositories: [{
      repoId: REPO,
      alias: "product",
      access: "write",
      requiredDelivery: true,
      noChangePolicy: "changes_required",
    }],
    integrationAcceptance: { command: ["pnpm", "test:integration"] },
  }, null, 2)}\n`);
  write(join(issueRoot, "evidence", "repositories", "merge.json"), `${MERGES[storyId]}\n`);
  write(join(issueRoot, "evidence", "integration", "result.txt"), "PASS\n");
  appendRepositoryMergeEvidence(issueRoot, {
    workspaceId: WORKSPACE,
    storyId,
    repoId: REPO,
    cycleId: `cycle-${storyId}`,
    authority: "provider",
    prState: "MERGED",
    ci: "green",
    mergeCommit: MERGES[storyId],
    recordedAt: 1,
  });
  appendIssueIntegrationAcceptanceEvidence(issueRoot, {
    workspaceId: WORKSPACE,
    storyId,
    inputMergeCommits: { [REPO]: MERGES[storyId] },
    commandDigest: integrationAcceptanceCommandDigest(["pnpm", "test:integration"]),
    profile: "workspace-integration/v1",
    verdict: "pass",
    artifactPath: "evidence/integration/result.txt",
    recordedAt: 2,
  });
  return issueRoot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-WS-014 Requirement attest store", () => {
  it("rebuilds deterministically from exact-SHA Issue truth and deletion never mutates Issue events", () => {
    const f = fixture();
    const issues = [deliver(f.workspace, "US-A"), deliver(f.workspace, "US-B")];
    const eventsBefore = issues.map((issue) => readFileSync(join(issue, "events.jsonl"), "utf8"));

    const first = rebuildRequirementAttest({
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: f.requirementId,
    });
    expect(first.status).toBe("pass");
    expect(first.content).toContain(`${REPO}@${MERGES["US-A"]}`);
    expect(first.content).toContain("../../../issues/US-B/evidence/integration/result.txt");

    removeRequirementAttestProjection({
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: f.requirementId,
    });
    expect(existsSync(join(f.requirementPath, "attest.md"))).toBe(false);
    const rebuilt = rebuildRequirementAttest({
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: f.requirementId,
    });
    expect(rebuilt.content).toBe(first.content);
    expect(issues.map((issue) => readFileSync(join(issue, "events.jsonl"), "utf8"))).toEqual(eventsBefore);
  });

  it("keeps missing Issue evidence visible as pending instead of silently omitting its Story", () => {
    const f = fixture();
    deliver(f.workspace, "US-A");

    const result = rebuildRequirementAttest({
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: f.requirementId,
    });

    expect(result.status).toBe("partial");
    expect(result.content).toContain("US-B: pending (Issue state/evidence missing)");
  });

  it("rejects symlink escapes during Issue evidence discovery without replacing the prior projection", () => {
    const f = fixture();
    const issue = deliver(f.workspace, "US-A");
    deliver(f.workspace, "US-B");
    const before = readFileSync(join(f.requirementPath, "attest.md"), "utf8");
    const outside = join(dirname(f.workspace), "outside.txt");
    write(outside, "secret\n");
    symlinkSync(outside, join(issue, "evidence", "escape.txt"));

    expect(() => rebuildRequirementAttest({
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: f.requirementId,
    })).toThrowError(expect.objectContaining<Partial<RequirementAttestStoreError>>({ code: "unsafe_issue_evidence" }));
    expect(readFileSync(join(f.requirementPath, "attest.md"), "utf8")).toBe(before);
  });

  it("rejects evidence filenames that could escape the generated Markdown link", () => {
    const f = fixture();
    const issue = deliver(f.workspace, "US-A");
    deliver(f.workspace, "US-B");
    write(join(issue, "evidence", "bad](https:", "payload.txt"), "unsafe\n");

    expect(() => rebuildRequirementAttest({
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: f.requirementId,
    })).toThrowError(expect.objectContaining<Partial<RequirementAttestStoreError>>({ code: "unsafe_issue_evidence" }));
  });

  it("rejects a contained Issue whose manifest and events belong to another Workspace", () => {
    const f = fixture();
    const issue = deliver(f.workspace, "US-A");
    deliver(f.workspace, "US-B");
    writeFileSync(
      join(issue, "manifest.json"),
      readFileSync(join(issue, "manifest.json"), "utf8").replaceAll(WORKSPACE, "ws-foreign"),
      "utf8",
    );
    writeFileSync(
      join(issue, "events.jsonl"),
      readFileSync(join(issue, "events.jsonl"), "utf8").replaceAll(WORKSPACE, "ws-foreign"),
      "utf8",
    );

    expect(() => rebuildRequirementAttest({
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: f.requirementId,
    })).toThrowError(expect.objectContaining<Partial<RequirementAttestStoreError>>({ code: "invalid_issue_evidence" }));
  });

  it("refuses a stale projection when Issue completion truth changes during rebuild", () => {
    const f = fixture();
    const issue = deliver(f.workspace, "US-A");
    deliver(f.workspace, "US-B");
    const before = readFileSync(join(f.requirementPath, "attest.md"), "utf8");

    expect(() => rebuildRequirementAttest({
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: f.requirementId,
    }, {
      beforeIssueRevalidation: () => appendRepositoryMergeEvidence(issue, {
        workspaceId: WORKSPACE,
        storyId: "US-A",
        repoId: REPO,
        cycleId: "cycle-US-A-new-merge",
        authority: "provider",
        prState: "MERGED",
        ci: "green",
        mergeCommit: "d".repeat(40),
        recordedAt: 3,
      }),
    })).toThrowError(expect.objectContaining<Partial<RequirementAttestStoreError>>({ code: "concurrent_rebuild" }));
    expect(readFileSync(join(f.requirementPath, "attest.md"), "utf8")).toBe(before);
  });

  it("refuses final PASS when archive audit is corrupt and names the original blocking finding", () => {
    const f = fixture();
    deliver(f.workspace, "US-A");
    deliver(f.workspace, "US-B");
    const revision = readdirSync(join(f.requirementPath, "revisions"))[0]!;
    writeFileSync(join(f.requirementPath, "revisions", revision, "requirement.md"), "tampered\n", "utf8");

    const result = rebuildRequirementAttest({
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: f.requirementId,
    });

    expect(result.status).toBe("blocked");
    expect(result.content).toContain("content_digest_mismatch");
    expect(result.content).not.toContain("Final verdict: PASS");
  });
});
