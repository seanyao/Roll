import { describe, expect, it } from "vitest";
import {
  REQUIREMENT_HINT_V1,
  repositoryIdFromRemote,
  type RepositoryHintProvenance,
  type RequirementHintV1,
} from "@roll/spec";
import {
  MAX_REQUIREMENT_MATCH_EVIDENCE,
  matchWorkspaceRequirement,
  normalizeRequirementHint,
  normalizeRequirementSourceReference,
} from "../src/index.js";

function requirementId(provider: string, ref: string): string {
  const normalized = normalizeRequirementSourceReference(provider, ref);
  if (!normalized.ok) throw new Error("fixture requirement must be valid");
  return normalized.value.requirementId;
}

function repoId(remote: string): string {
  const normalized = repositoryIdFromRemote(remote);
  if (!normalized.ok) throw new Error("fixture repository must be valid");
  return normalized.value;
}

describe("US-WS-027 workspace requirement evidence", () => {
  it.each([
    "explicit_user",
    "cli_argument",
    "issue_manifest",
    "deterministic_extraction",
  ] as const)("produces requirement_source_exact hard evidence for %s", (provenance) => {
    const hint = normalizeRequirementHint({
      sources: [{ key: { provider: "jira", ref: "APE-234" }, provenance }],
    });
    if (!hint.ok) throw new Error("fixture hint must be valid");
    expect(matchWorkspaceRequirement({
      requirement: hint.value,
      facts: {
        issues: [],
        requirementSources: [{ provider: "jira", ref: "APE-234", requirementId: "req-2e4314b10317" }],
        repositories: [],
        roots: [],
      },
    }).evidence).toEqual([
      expect.objectContaining({ kind: "requirement_source_exact", provenance, hard: true }),
    ]);
  });

  it.each([
    "explicit_user",
    "cli_argument",
    "issue_manifest",
    "deterministic_extraction",
  ] as const)("produces issue_exact hard evidence for %s", (provenance) => {
    const hint = normalizeRequirementHint({
      storyIds: [{ storyId: "US-WS-027", provenance }],
    });
    if (!hint.ok) throw new Error("fixture hint must be valid");
    expect(matchWorkspaceRequirement({
      requirement: hint.value,
      facts: {
        issues: [{ storyId: "US-WS-027", requirements: [] }],
        requirementSources: [],
        repositories: [],
        roots: [],
      },
    }).evidence).toEqual([
      expect.objectContaining({ kind: "issue_exact", provenance, hard: true }),
    ]);
  });

  it("turns only structured exact identities into hard evidence and retains audit detail", () => {
    const hint = normalizeRequirementHint({
      sources: [
        { key: { provider: "jira", ref: "APE-234" }, provenance: "explicit_user" },
        { key: { provider: "local-file", ref: "PRD/Brief.md" }, provenance: "deterministic_extraction" },
      ],
      storyIds: [{ storyId: "US-WS-027", provenance: "issue_manifest" }],
      repositoryRemotes: [{ remote: "https://github.com/Owner/Repo", provenance: "cwd_repository" }],
      paths: [{ path: "/work/ws/issues/US-WS-027", provenance: "cwd_repository" }],
      semanticTerms: ["workspace resolver"],
    });
    if (!hint.ok) throw new Error("fixture hint must be valid");

    const result = matchWorkspaceRequirement({
      requirement: hint.value,
      facts: {
        issues: [{
          storyId: "US-WS-027",
          requirements: [{
            provider: "local_file",
            ref: "PRD/Brief.md",
            requirementId: requirementId("local_file", "PRD/Brief.md"),
          }],
        }],
        requirementSources: [
          { provider: "jira", ref: "APE-234", requirementId: requirementId("jira", "APE-234") },
        ],
        repositories: [{ remote: "https://github.com/Owner/Repo.git", repositoryId: repoId("https://github.com/Owner/Repo") }],
        roots: ["/work/ws"],
        semanticTerms: ["Workspace Resolver", "unrelated"],
      },
    });

    expect(result.hardMatch).toBe(true);
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "issue_exact",
        hard: true,
        provenance: "issue_manifest",
        source: "issue:US-WS-027",
        detail: "Issue manifest storyId matched US-WS-027",
      }),
      expect.objectContaining({
        kind: "requirement_source_exact",
        hard: true,
        value: "jira:APE-234",
        provenance: "explicit_user",
        source: `requirement:jira/${requirementId("jira", "APE-234")}`,
      }),
      expect.objectContaining({
        kind: "requirement_source_exact",
        hard: true,
        value: "local_file:PRD/Brief.md",
        provenance: "deterministic_extraction",
      }),
      expect.objectContaining({ kind: "repository_exact", hard: false, provenance: "cwd_repository" }),
      expect.objectContaining({ kind: "path_contained", hard: false, provenance: "cwd_repository" }),
      expect.objectContaining({ kind: "semantic_supported", hard: false, provenance: "semantic_inference" }),
    ]));
    expect(result.evidence.filter((entry) => entry.hard).every((entry) => (
      entry.kind === "issue_exact" || entry.kind === "requirement_source_exact"
    ))).toBe(true);
  });

  it("never upgrades forged semantic or cwd identities into exact evidence", () => {
    const requirement = {
      schema: "roll.requirement-hint/v1",
      sources: [
        { key: { provider: "jira", ref: "APE-234" }, provenance: "semantic_inference" },
        { key: { provider: "jira", ref: "APE-234" }, provenance: "cwd_repository" },
      ],
      storyIds: [{ storyId: "US-WS-027", provenance: "semantic_inference" }],
      repositoryRemotes: [],
      paths: [],
      semanticTerms: ["APE-234"],
    } as unknown as RequirementHintV1;
    const result = matchWorkspaceRequirement({
      requirement,
      facts: {
        issues: [{ storyId: "US-WS-027", requirements: [] }],
        requirementSources: [{ provider: "jira", ref: "APE-234", requirementId: requirementId("jira", "APE-234") }],
        repositories: [],
        roots: [],
        semanticTerms: ["APE-234"],
      },
    });
    expect(result.hardMatch).toBe(false);
    expect(result.evidence).toEqual([
      expect.objectContaining({ kind: "semantic_supported", hard: false }),
    ]);
  });

  it("does not produce issue_exact from a forged cwd_repository Story hint", () => {
    const requirement = {
      schema: REQUIREMENT_HINT_V1,
      sources: [],
      storyIds: [{ storyId: "US-WS-027", provenance: "cwd_repository" }],
      repositoryRemotes: [],
      paths: [],
    } as unknown as RequirementHintV1;
    expect(matchWorkspaceRequirement({
      requirement,
      facts: {
        issues: [{ storyId: "US-WS-027", requirements: [] }],
        requirementSources: [],
        repositories: [],
        roots: [],
      },
    })).toEqual({ evidence: [], hardMatch: false, score: 0, findings: [] });
  });

  it("preserves persisted identity and emits migration findings instead of rewriting legacy refs", () => {
    const hint = normalizeRequirementHint({
      sources: [{ key: { provider: "jira", ref: "APE-234" }, provenance: "cli_argument" }],
    });
    if (!hint.ok) throw new Error("fixture hint must be valid");
    const valid = { provider: "jira", ref: "APE-234", requirementId: requirementId("jira", "APE-234") };
    const legacy = { provider: "jira", ref: "234", requirementId: "req-legacy000001" };
    const mismatch = { provider: "jira", ref: "APE-999", requirementId: "req-000000000000" };
    const before = structuredClone([valid, legacy, mismatch]);

    const result = matchWorkspaceRequirement({
      requirement: hint.value,
      facts: { issues: [], requirementSources: [mismatch, legacy, valid], repositories: [], roots: [] },
    });

    expect([valid, legacy, mismatch]).toEqual(before);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        kind: "requirement_source_exact",
        value: "jira:APE-234",
        source: `requirement:jira/${valid.requirementId}`,
      }),
    ]);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "requirement_identity_mismatch", source: "requirement:jira/req-000000000000" }),
      expect.objectContaining({ code: "legacy_requirement_ref_requires_migration", source: "requirement:jira/req-legacy000001" }),
    ]);
  });

  it("sorts and deduplicates evidence deterministically and applies a hard limit", () => {
    const semanticTerms = Array.from({ length: MAX_REQUIREMENT_MATCH_EVIDENCE + 8 }, (_, index) => `term-${String(index).padStart(3, "0")}`);
    const requirement = {
      schema: "roll.requirement-hint/v1",
      sources: [],
      storyIds: [],
      repositoryRemotes: [],
      paths: [],
      semanticTerms: [...semanticTerms].reverse(),
    } as const;
    const input = {
      requirement,
      facts: {
        issues: [],
        requirementSources: [],
        repositories: [],
        roots: [],
        semanticTerms: [...semanticTerms, semanticTerms[0] ?? ""],
      },
    };
    const before = structuredClone(input);
    const first = matchWorkspaceRequirement(input);
    const second = matchWorkspaceRequirement({ ...input, facts: { ...input.facts, semanticTerms: [...input.facts.semanticTerms].reverse() } });
    expect(input).toEqual(before);
    expect(first.evidence).toHaveLength(MAX_REQUIREMENT_MATCH_EVIDENCE);
    expect(second.evidence).toEqual(first.evidence);
    expect(new Set(first.evidence.map((entry) => `${entry.kind}:${entry.value}`)).size).toBe(first.evidence.length);
  });

  it("requires host-canonical absolute roots before path containment matching", () => {
    const hint = normalizeRequirementHint({
      paths: [{ path: "/work/ws/issues/US-WS-027", provenance: "cwd_repository" }],
    });
    if (!hint.ok) throw new Error("fixture hint must be valid");
    expect(matchWorkspaceRequirement({
      requirement: hint.value,
      facts: { issues: [], requirementSources: [], repositories: [], roots: ["work/ws"] },
    })).toMatchObject({
      evidence: [],
      hardMatch: false,
      findings: [{ code: "invalid_workspace_root", source: "workspace-root:work/ws" }],
    });
  });

  it("does not confuse a sibling path sharing the Workspace root string prefix with containment", () => {
    const hint = normalizeRequirementHint({
      paths: [{ path: "/work/ws-evil/issues/US-WS-027", provenance: "cwd_repository" }],
    });
    if (!hint.ok) throw new Error("fixture hint must be valid");
    expect(matchWorkspaceRequirement({
      requirement: hint.value,
      facts: { issues: [], requirementSources: [], repositories: [], roots: ["/work/ws"] },
    })).toEqual({ evidence: [], hardMatch: false, score: 0, findings: [] });
  });

  it("provides a pure normalization-to-match golden path without provider URL or text collection", () => {
    const normalized = normalizeRequirementHint({
      sources: [{ key: { provider: "github_issue", ref: "Owner/Repo#42" }, provenance: "deterministic_extraction" }],
      repositoryRemotes: [{ remote: "https://github.com/Owner/Repo.git", provenance: "cwd_repository" }],
    });
    if (!normalized.ok) throw new Error("fixture hint must be valid");
    const result = matchWorkspaceRequirement({
      requirement: normalized.value,
      facts: {
        issues: [],
        requirementSources: [{
          provider: "github_issue",
          ref: "owner/repo#42",
          requirementId: requirementId("github_issue", "owner/repo#42"),
        }],
        repositories: [{
          remote: "https://github.com/Owner/Repo",
          repositoryId: repoId("https://github.com/Owner/Repo"),
        }],
        roots: [],
      },
    });
    expect(result).toMatchObject({
      hardMatch: true,
      evidence: [
        expect.objectContaining({ kind: "requirement_source_exact", hard: true }),
        expect.objectContaining({ kind: "repository_exact", hard: false }),
      ],
      findings: [],
    });
  });

  it.each([
    "explicit_user",
    "cli_argument",
    "issue_manifest",
    "cwd_repository",
    "deterministic_extraction",
  ] as const)("keeps repository and path evidence soft for %s provenance", (provenance: RepositoryHintProvenance) => {
    const hint = normalizeRequirementHint({
      repositoryRemotes: [{ remote: "https://github.com/Owner/Repo", provenance }],
      paths: [{ path: "/work/ws/issues/US-WS-027", provenance }],
    });
    if (!hint.ok) throw new Error("fixture hint must be valid");
    const result = matchWorkspaceRequirement({
      requirement: hint.value,
      facts: {
        issues: [],
        requirementSources: [],
        repositories: [{ remote: "https://github.com/Owner/Repo", repositoryId: "repo-8d325f3875d5" }],
        roots: ["/work/ws"],
      },
    });
    expect(result.hardMatch).toBe(false);
    expect(result.evidence).toEqual([
      expect.objectContaining({ kind: "repository_exact", provenance, hard: false }),
      expect.objectContaining({ kind: "path_contained", provenance, hard: false }),
    ]);
  });

  it("makes CLI source/story matches hard while deduplicating mixed provenance by strongest audit source", () => {
    const requirement: RequirementHintV1 = {
      schema: REQUIREMENT_HINT_V1,
      sources: [
        { key: { provider: "jira", ref: "APE-234" }, provenance: "deterministic_extraction" },
        { key: { provider: "jira", ref: "APE-234" }, provenance: "cli_argument" },
        { key: { provider: "jira", ref: "APE-234" }, provenance: "explicit_user" },
      ],
      storyIds: [{ storyId: "US-WS-027", provenance: "cli_argument" }],
      repositoryRemotes: [
        { remote: "https://github.com/Owner/Repo", provenance: "cwd_repository" },
        { remote: "https://github.com/Owner/Repo", provenance: "cli_argument" },
      ],
      paths: [
        { path: "/work/ws/issues/US-WS-027", provenance: "cwd_repository" },
        { path: "/work/ws/issues/US-WS-027", provenance: "cli_argument" },
      ],
      semanticTerms: ["workspace resolver"],
    };
    const result = matchWorkspaceRequirement({
      requirement,
      facts: {
        issues: [{ storyId: "US-WS-027", requirements: [] }],
        requirementSources: [{ provider: "jira", ref: "APE-234", requirementId: "req-2e4314b10317" }],
        repositories: [{ remote: "https://github.com/Owner/Repo", repositoryId: "repo-8d325f3875d5" }],
        roots: ["/work/ws"],
        semanticTerms: ["Workspace Resolver"],
      },
    });
    expect(result).toEqual({
      evidence: [
        {
          kind: "issue_exact",
          value: "US-WS-027",
          hard: true,
          score: 100,
          source: "issue:US-WS-027",
          provenance: "cli_argument",
          detail: "Issue manifest storyId matched US-WS-027",
        },
        {
          kind: "requirement_source_exact",
          value: "jira:APE-234",
          hard: true,
          score: 90,
          source: "requirement:jira/req-2e4314b10317",
          provenance: "explicit_user",
          detail: "Requirement source identity matched req-2e4314b10317",
        },
        {
          kind: "repository_exact",
          value: "repo-8d325f3875d5",
          hard: false,
          score: 30,
          source: "repository:repo-8d325f3875d5",
          provenance: "cli_argument",
          detail: "Repository identity matched repo-8d325f3875d5",
        },
        {
          kind: "path_contained",
          value: "/work/ws/issues/US-WS-027",
          hard: false,
          score: 20,
          source: "workspace-root:/work/ws",
          provenance: "cli_argument",
          detail: "Candidate path is contained by Workspace root /work/ws",
        },
        {
          kind: "semantic_supported",
          value: "workspace resolver",
          hard: false,
          score: 10,
          source: "semantic-index:workspace resolver",
          provenance: "semantic_inference",
          detail: "Semantic term matched workspace resolver",
        },
      ],
      hardMatch: true,
      score: 250,
      findings: [],
    });
  });

  it("matches fixed historical identities without rewriting them and excludes legacy/mismatched rows", () => {
    const historical = [
      { provider: "jira", ref: "APE-234", requirementId: "req-2e4314b10317" },
      { provider: "github_issue", ref: "owner/repo#12", requirementId: "req-1aed8113153b" },
      { provider: "local_file", ref: "PRD/Brief.md", requirementId: "req-bcc74925c520" },
      { provider: "user_input", ref: "owner-brief", requirementId: "req-8803ac05d541" },
      { provider: "jira", ref: "234", requirementId: "req-legacy000001" },
      { provider: "github_issue", ref: "owner/repo#99", requirementId: "req-000000000000" },
    ];
    const before = structuredClone(historical);
    const hint = normalizeRequirementHint({
      sources: [
        { key: { provider: "jira", ref: "APE-234" }, provenance: "cli_argument" },
        { key: { provider: "github_issue", ref: "owner/repo#12" }, provenance: "cli_argument" },
        { key: { provider: "local_file", ref: "PRD/Brief.md" }, provenance: "cli_argument" },
        { key: { provider: "user_input", ref: "owner-brief" }, provenance: "cli_argument" },
      ],
    });
    if (!hint.ok) throw new Error("fixture hint must be valid");
    const result = matchWorkspaceRequirement({
      requirement: hint.value,
      facts: { issues: [], requirementSources: historical, repositories: [], roots: [] },
    });
    expect(historical).toEqual(before);
    expect(result.evidence.map(({ value, source }) => ({ value, source }))).toEqual([
      { value: "github_issue:owner/repo#12", source: "requirement:github_issue/req-1aed8113153b" },
      { value: "jira:APE-234", source: "requirement:jira/req-2e4314b10317" },
      { value: "local_file:PRD/Brief.md", source: "requirement:local_file/req-bcc74925c520" },
      { value: "user_input:owner-brief", source: "requirement:user_input/req-8803ac05d541" },
    ]);
    expect(result.evidence.some((entry) => entry.source.includes("legacy") || entry.source.includes("000000000000"))).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "requirement_identity_mismatch", source: "requirement:github_issue/req-000000000000" }),
      expect.objectContaining({ code: "legacy_requirement_ref_requires_migration", source: "requirement:jira/req-legacy000001" }),
    ]);
  });

  it("uses the fixed provenance priority for issue-manifest and deterministic repository/path duplicates", () => {
    const requirement: RequirementHintV1 = {
      schema: REQUIREMENT_HINT_V1,
      sources: [
        { key: { provider: "jira", ref: "APE-234" }, provenance: "deterministic_extraction" },
        { key: { provider: "jira", ref: "APE-234" }, provenance: "issue_manifest" },
      ],
      storyIds: [],
      repositoryRemotes: [
        { remote: "https://github.com/Owner/Repo", provenance: "cwd_repository" },
        { remote: "https://github.com/Owner/Repo", provenance: "deterministic_extraction" },
      ],
      paths: [
        { path: "/work/ws/issues/US-WS-027", provenance: "cwd_repository" },
        { path: "/work/ws/issues/US-WS-027", provenance: "deterministic_extraction" },
      ],
    };
    expect(matchWorkspaceRequirement({
      requirement,
      facts: {
        issues: [],
        requirementSources: [{ provider: "jira", ref: "APE-234", requirementId: "req-2e4314b10317" }],
        repositories: [{ remote: "https://github.com/Owner/Repo", repositoryId: "repo-8d325f3875d5" }],
        roots: ["/work/ws"],
      },
    })).toEqual({
      evidence: [
        {
          kind: "requirement_source_exact",
          value: "jira:APE-234",
          hard: true,
          score: 90,
          source: "requirement:jira/req-2e4314b10317",
          provenance: "issue_manifest",
          detail: "Requirement source identity matched req-2e4314b10317",
        },
        {
          kind: "repository_exact",
          value: "repo-8d325f3875d5",
          hard: false,
          score: 30,
          source: "repository:repo-8d325f3875d5",
          provenance: "deterministic_extraction",
          detail: "Repository identity matched repo-8d325f3875d5",
        },
        {
          kind: "path_contained",
          value: "/work/ws/issues/US-WS-027",
          hard: false,
          score: 20,
          source: "workspace-root:/work/ws",
          provenance: "deterministic_extraction",
          detail: "Candidate path is contained by Workspace root /work/ws",
        },
      ],
      hardMatch: true,
      score: 140,
      findings: [],
    });
  });

  it("deduplicates CLI, issue-manifest and deterministic source/Story evidence to CLI in complete order", () => {
    const requirement: RequirementHintV1 = {
      schema: REQUIREMENT_HINT_V1,
      sources: [
        { key: { provider: "jira", ref: "APE-234" }, provenance: "issue_manifest" },
        { key: { provider: "jira", ref: "APE-234" }, provenance: "deterministic_extraction" },
        { key: { provider: "jira", ref: "APE-234" }, provenance: "cli_argument" },
      ],
      storyIds: [
        { storyId: "US-WS-027", provenance: "issue_manifest" },
        { storyId: "US-WS-027", provenance: "deterministic_extraction" },
        { storyId: "US-WS-027", provenance: "cli_argument" },
      ],
      repositoryRemotes: [],
      paths: [],
    };
    expect(matchWorkspaceRequirement({
      requirement,
      facts: {
        issues: [{ storyId: "US-WS-027", requirements: [] }],
        requirementSources: [{ provider: "jira", ref: "APE-234", requirementId: "req-2e4314b10317" }],
        repositories: [],
        roots: [],
      },
    })).toEqual({
      evidence: [
        {
          kind: "issue_exact",
          value: "US-WS-027",
          hard: true,
          score: 100,
          source: "issue:US-WS-027",
          provenance: "cli_argument",
          detail: "Issue manifest storyId matched US-WS-027",
        },
        {
          kind: "requirement_source_exact",
          value: "jira:APE-234",
          hard: true,
          score: 90,
          source: "requirement:jira/req-2e4314b10317",
          provenance: "cli_argument",
          detail: "Requirement source identity matched req-2e4314b10317",
        },
      ],
      hardMatch: true,
      score: 190,
      findings: [],
    });
  });
});
