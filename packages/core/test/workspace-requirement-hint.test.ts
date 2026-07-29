import { describe, expect, it } from "vitest";
import {
  REQUIREMENT_HINT_PROVENANCES,
  REQUIREMENT_HINT_V1,
  type RequirementHintV1,
} from "@roll/spec";
import {
  MAX_REQUIREMENT_HINT_ITEMS,
  MAX_REQUIREMENT_HINT_VALUE_LENGTH,
  MAX_REQUIREMENT_SEMANTIC_TERM_LENGTH,
  normalizeRequirementHint,
  parseRequirementSourceUrl,
} from "../src/index.js";

describe("US-WS-027 RequirementHintV1 normalization", () => {
  it("exports the closed hint and provenance contract", () => {
    expect(REQUIREMENT_HINT_V1).toBe("roll.requirement-hint/v1");
    expect(REQUIREMENT_HINT_PROVENANCES).toEqual([
      "explicit_user",
      "cli_argument",
      "issue_manifest",
      "cwd_repository",
      "deterministic_extraction",
      "semantic_inference",
    ]);

    const contract: RequirementHintV1 = {
      schema: REQUIREMENT_HINT_V1,
      sources: [],
      storyIds: [],
      repositoryRemotes: [],
      paths: [],
    };
    expect(contract.schema).toBe(REQUIREMENT_HINT_V1);
  });

  it("normalizes structured identities through the existing identity algorithms", () => {
    expect(normalizeRequirementHint({
      sources: [
        { key: { provider: "JIRA", ref: "ape-234" }, provenance: "explicit_user" },
        { key: { provider: "github-issue", ref: "Owner/Repo#12" }, provenance: "cli_argument" },
        { key: { provider: "local-file", ref: "PRD/Brief.md" }, provenance: "issue_manifest" },
      ],
      storyIds: [{ storyId: "US-WS-027", provenance: "deterministic_extraction" }],
      repositoryRemotes: [
        { remote: "git@GitHub.com:Owner/Repo.git", provenance: "cwd_repository" },
        { remote: "https://github.com/Owner/Repo", provenance: "explicit_user" },
      ],
      paths: [
        { path: "/tmp/workspace/../workspace/issues/US-WS-027", provenance: "explicit_user" },
      ],
      semanticTerms: ["  Workspace   Resolver ", "workspace resolver", "Hint"],
    })).toEqual({
      ok: true,
      value: {
        schema: "roll.requirement-hint/v1",
        sources: [
          { key: { provider: "github_issue", ref: "owner/repo#12" }, provenance: "cli_argument" },
          { key: { provider: "jira", ref: "APE-234" }, provenance: "explicit_user" },
          { key: { provider: "local_file", ref: "PRD/Brief.md" }, provenance: "issue_manifest" },
        ],
        storyIds: [{ storyId: "US-WS-027", provenance: "deterministic_extraction" }],
        repositoryRemotes: [
          { remote: "https://github.com/Owner/Repo", provenance: "explicit_user" },
          { remote: "ssh://github.com/Owner/Repo", provenance: "cwd_repository" },
        ],
        paths: [{ path: "/tmp/workspace/issues/US-WS-027", provenance: "explicit_user" }],
        semanticTerms: ["hint", "workspace resolver"],
      },
    });
  });

  it("is deterministic, idempotent and deduplicates exact normalized facts", () => {
    const first = normalizeRequirementHint({
      sources: [
        { key: { provider: "jira", ref: "APE-234" }, provenance: "explicit_user" },
        { key: { provider: "JIRA", ref: "ape-234" }, provenance: "explicit_user" },
      ],
      storyIds: [
        { storyId: "US-WS-027", provenance: "explicit_user" },
        { storyId: "US-WS-027", provenance: "explicit_user" },
      ],
      repositoryRemotes: [],
      paths: [],
      semanticTerms: ["Resolver", "resolver"],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(normalizeRequirementHint(first.value)).toEqual(first);
    expect(first.value.sources).toHaveLength(1);
    expect(first.value.storyIds).toHaveLength(1);
    expect(first.value.semanticTerms).toEqual(["resolver"]);
  });

  it("normalizes harmless surrounding whitespace before applying the existing Story ID validator", () => {
    expect(normalizeRequirementHint({
      storyIds: [{ storyId: "  US-WS-027  ", provenance: "explicit_user" }],
    })).toEqual({
      ok: true,
      value: {
        schema: REQUIREMENT_HINT_V1,
        sources: [],
        storyIds: [{ storyId: "US-WS-027", provenance: "explicit_user" }],
        repositoryRemotes: [],
        paths: [],
      },
    });
  });

  it.each([
    "us-ws-027",
    "US/WS-027",
    "../US-WS-027",
    "US-WS-027!",
  ])("rejects the non-canonical Story ID %s according to validateStoryId", (storyId) => {
    expect(normalizeRequirementHint({
      storyIds: [{ storyId, provenance: "explicit_user" }],
    })).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([expect.objectContaining({ code: "invalid_story_id", path: "storyIds[0].storyId" })]),
    });
  });

  it("preserves representative Story IDs already accepted by validateStoryId", () => {
    expect(normalizeRequirementHint({
      storyIds: [
        { storyId: "US-ONBOARD-NUDGE-004", provenance: "explicit_user" },
        { storyId: "REFACTOR-47a", provenance: "explicit_user" },
        { storyId: "FIX-204", provenance: "explicit_user" },
      ],
    })).toEqual({
      ok: true,
      value: {
        schema: REQUIREMENT_HINT_V1,
        sources: [],
        storyIds: [
          { storyId: "FIX-204", provenance: "explicit_user" },
          { storyId: "REFACTOR-47a", provenance: "explicit_user" },
          { storyId: "US-ONBOARD-NUDGE-004", provenance: "explicit_user" },
        ],
        repositoryRemotes: [],
        paths: [],
      },
    });
  });

  it("rejects cwd_repository provenance for a structured Story ID", () => {
    expect(normalizeRequirementHint({
      storyIds: [{ storyId: "US-WS-027", provenance: "cwd_repository" }],
    })).toMatchObject({
      ok: false,
      findings: [{ code: "invalid_provenance", path: "storyIds[0].provenance" }],
    });
  });

  it.each([
    ["provider URL", { sources: [{ key: { provider: "jira", ref: "https://example.atlassian.net/browse/APE-234" }, provenance: "explicit_user" }] }],
    ["incomplete Jira number", { sources: [{ key: { provider: "jira", ref: "234" }, provenance: "deterministic_extraction" }] }],
    ["unknown provider", { sources: [{ key: { provider: "linear", ref: "ENG-1" }, provenance: "explicit_user" }] }],
    ["semantic exact source", { sources: [{ key: { provider: "jira", ref: "APE-234" }, provenance: "semantic_inference" }] }],
    ["out-of-bounds local file", { sources: [{ key: { provider: "local_file", ref: "../PRD/Brief.md" }, provenance: "explicit_user" }] }],
    ["relative candidate path", { paths: [{ path: "issues/US-WS-027", provenance: "explicit_user" }] }],
    ["semantic repository", { repositoryRemotes: [{ remote: "https://github.com/Owner/Repo", provenance: "semantic_inference" }] }],
  ] as const)("rejects %s instead of guessing a structured identity", (_name, input) => {
    expect(normalizeRequirementHint(input)).toMatchObject({ ok: false, findings: expect.any(Array) });
  });

  it("fails loudly when raw item counts or string lengths exceed their bounds", () => {
    expect(normalizeRequirementHint({
      semanticTerms: Array.from({ length: MAX_REQUIREMENT_HINT_ITEMS + 1 }, (_, index) => `term-${index}`),
    })).toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ code: "item_limit", path: "semanticTerms" })],
    });
    expect(normalizeRequirementHint({
      semanticTerms: ["x".repeat(129)],
    })).toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ code: "value_too_long", path: "semanticTerms[0]" })],
    });
  });

  it.each([
    ["null", null, { code: "invalid_type", path: "$" }],
    ["array", [], { code: "invalid_type", path: "$" }],
    ["unknown top-level field", { extra: true }, { code: "unknown_field", path: "extra" }],
    ["unknown source field", {
      sources: [{ key: { provider: "jira", ref: "APE-234" }, provenance: "explicit_user", extra: true }],
    }, { code: "unknown_field", path: "sources[0].extra" }],
    ["unknown source-key field", {
      sources: [{ key: { provider: "jira", ref: "APE-234", extra: true }, provenance: "explicit_user" }],
    }, { code: "unknown_field", path: "sources[0].key.extra" }],
    ["unknown story field", {
      storyIds: [{ storyId: "US-WS-027", provenance: "cli_argument", extra: true }],
    }, { code: "unknown_field", path: "storyIds[0].extra" }],
    ["unknown repository field", {
      repositoryRemotes: [{ remote: "https://github.com/Owner/Repo", provenance: "cli_argument", extra: true }],
    }, { code: "unknown_field", path: "repositoryRemotes[0].extra" }],
    ["unknown path field", {
      paths: [{ path: "/work/ws", provenance: "cli_argument", extra: true }],
    }, { code: "unknown_field", path: "paths[0].extra" }],
    ["malformed source entry", { sources: [null] }, { code: "invalid_type", path: "sources[0]" }],
    ["malformed source key", {
      sources: [{ key: null, provenance: "explicit_user" }],
    }, { code: "invalid_type", path: "sources[0].key" }],
    ["unknown provenance", {
      storyIds: [{ storyId: "US-WS-027", provenance: "model_guess" }],
    }, { code: "invalid_provenance", path: "storyIds[0].provenance" }],
    ["wrong schema", { schema: "roll.requirement-hint/v2" }, { code: "invalid_schema", path: "schema" }],
  ] as const)("fails closed for %s", (_name, input, expected) => {
    expect(normalizeRequirementHint(input)).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([expect.objectContaining(expected)]),
    });
  });

  it.each([
    ["sources", { sources: Array.from({ length: MAX_REQUIREMENT_HINT_ITEMS + 1 }, () => (
      { key: { provider: "jira", ref: "APE-234" }, provenance: "explicit_user" }
    )) }],
    ["storyIds", { storyIds: Array.from({ length: MAX_REQUIREMENT_HINT_ITEMS + 1 }, () => (
      { storyId: "US-WS-027", provenance: "explicit_user" }
    )) }],
    ["repositoryRemotes", { repositoryRemotes: Array.from({ length: MAX_REQUIREMENT_HINT_ITEMS + 1 }, () => (
      { remote: "https://github.com/Owner/Repo", provenance: "cli_argument" }
    )) }],
    ["paths", { paths: Array.from({ length: MAX_REQUIREMENT_HINT_ITEMS + 1 }, () => (
      { path: "/work/ws", provenance: "cwd_repository" }
    )) }],
    ["semanticTerms", { semanticTerms: Array.from({ length: MAX_REQUIREMENT_HINT_ITEMS + 1 }, () => "resolver") }],
  ] as const)("enforces the %s count boundary with an exact finding path", (path, input) => {
    expect(normalizeRequirementHint(input)).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([expect.objectContaining({ code: "item_limit", path })]),
    });
  });

  it.each([
    ["sources[0].key.provider", {
      sources: [{ key: { provider: "x".repeat(MAX_REQUIREMENT_HINT_VALUE_LENGTH + 1), ref: "APE-234" }, provenance: "explicit_user" }],
    }],
    ["sources[0].key.ref", {
      sources: [{ key: { provider: "jira", ref: "x".repeat(MAX_REQUIREMENT_HINT_VALUE_LENGTH + 1) }, provenance: "explicit_user" }],
    }],
    ["storyIds[0].storyId", {
      storyIds: [{ storyId: "x".repeat(MAX_REQUIREMENT_HINT_VALUE_LENGTH + 1), provenance: "cli_argument" }],
    }],
    ["repositoryRemotes[0].remote", {
      repositoryRemotes: [{ remote: "x".repeat(MAX_REQUIREMENT_HINT_VALUE_LENGTH + 1), provenance: "cli_argument" }],
    }],
    ["paths[0].path", {
      paths: [{ path: `/${"x".repeat(MAX_REQUIREMENT_HINT_VALUE_LENGTH + 1)}`, provenance: "cwd_repository" }],
    }],
    ["semanticTerms[0]", { semanticTerms: ["x".repeat(MAX_REQUIREMENT_SEMANTIC_TERM_LENGTH + 1)] }],
  ] as const)("enforces the %s length boundary with an exact finding", (path, input) => {
    expect(normalizeRequirementHint(input)).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([expect.objectContaining({ code: "value_too_long", path })]),
    });
  });

  it.each([
    [
      "Jira",
      "https://example.atlassian.net/browse/ape-234?focusedCommentId=1#comment-1",
      { provider: "jira", ref: "APE-234", requirementId: "req-2e4314b10317" },
    ],
    [
      "GitHub issue",
      "https://github.com/Owner/Repo/issues/42?notification_referrer_id=1#issuecomment-2",
      { provider: "github_issue", ref: "owner/repo#42", requirementId: "req-f1aac6289d07" },
    ],
  ] as const)("extracts a canonical %s ref before applying the existing identity normalizer", (_name, url, expected) => {
    expect(parseRequirementSourceUrl(url)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["non-string", 42, "invalid_type"],
    ["HTTP URL", "http://example.atlassian.net/browse/APE-234", "invalid_url"],
    ["credential URL", "https://token@example.atlassian.net/browse/APE-234", "invalid_url"],
    ["custom port", "https://example.atlassian.net:8443/browse/APE-234", "invalid_url"],
    ["wrong Jira host", "https://jira.example.test/browse/APE-234", "unsupported_provider_host"],
    ["wrong GitHub host", "https://git.example.test/Owner/Repo/issues/42", "unsupported_provider_host"],
    ["incomplete Jira URL", "https://example.atlassian.net/browse/", "invalid_requirement_url"],
    ["extra Jira path", "https://example.atlassian.net/browse/APE-234/edit", "invalid_requirement_url"],
    ["incomplete GitHub URL", "https://github.com/Owner/Repo/issues/", "invalid_requirement_url"],
    ["non-issue GitHub URL", "https://github.com/Owner/Repo/pull/42", "invalid_requirement_url"],
  ] as const)("rejects %s without guessing a provider ref", (_name, input, code) => {
    expect(parseRequirementSourceUrl(input)).toMatchObject({ ok: false, findings: [{ code, path: "url" }] });
  });
});
