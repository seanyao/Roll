import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REQUIREMENT_ATTEST_PROJECTION_V1,
  REQUIREMENT_SOURCE_V1,
  parseRequirementSourceManifest,
  requirementSourceV1Schema,
} from "../src/index.js";

const digest = (char: string): string => char.repeat(64);

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: REQUIREMENT_SOURCE_V1,
    requirementId: `req-${createHash("sha256").update("jira\0SOT-15499").digest("hex").slice(0, 12)}`,
    provider: "jira",
    ref: "SOT-15499",
    revision: "42",
    capturedAt: "2026-07-20T16:00:00.000Z",
    previousRevisions: [],
    requirement: { bytes: 18, sha256: digest("a") },
    context: [],
    stories: ["US-WS-007"],
    attest: { schema: REQUIREMENT_ATTEST_PROJECTION_V1, mode: "generated_aggregate", evidenceAuthority: "issue" },
    ...overrides,
  };
}

describe("US-WS-007 RequirementSource spec contract (direct, package-boundary test)", () => {
  it("closes the schema to exactly the declared fields with no credential-shaped property allowed", () => {
    expect(requirementSourceV1Schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(JSON.stringify(requirementSourceV1Schema)).not.toMatch(/credential|password|token|secret/iu);
  });

  it.each([
    ["jira", { ...manifest(), requirementId: `req-${createHash("sha256").update("jira\0SOT-15499").digest("hex").slice(0, 12)}`, provider: "jira", ref: "SOT-15499" }],
    ["github_issue", { ...manifest(), requirementId: `req-${createHash("sha256").update("github_issue\0owner/repo#12").digest("hex").slice(0, 12)}`, provider: "github_issue", ref: "owner/repo#12" }],
    ["local_file", { ...manifest(), requirementId: `req-${createHash("sha256").update("local_file\0PRD/Brief.md").digest("hex").slice(0, 12)}`, provider: "local_file", ref: "PRD/Brief.md" }],
    ["user_input", { ...manifest(), requirementId: `req-${createHash("sha256").update("user_input\0owner-brief").digest("hex").slice(0, 12)}`, provider: "user_input", ref: "owner-brief" }],
  ] as const)("accepts the %s provider as a closed v1 contract", (provider, value) => {
    expect(parseRequirementSourceManifest(value)).toMatchObject({ ok: true, value: { provider, ref: value.ref } });
  });

  it("rejects an unsupported provider", () => {
    expect(parseRequirementSourceManifest(manifest({ provider: "confluence" }))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "invalid_value", path: "provider" })]),
    });
  });

  it("rejects an unknown schema version rather than silently accepting a future or past shape", () => {
    expect(parseRequirementSourceManifest(manifest({ schema: "roll.requirement-source/v2" }))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "unknown_version", path: "schema" })]),
    });
    expect(parseRequirementSourceManifest(manifest({ schema: "roll.requirement-source/v0" }))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "unknown_version", path: "schema" })]),
    });
  });

  it("rejects an unknown additional field rather than passing it through silently", () => {
    expect(parseRequirementSourceManifest({ ...manifest(), apiKey: "sentinel-value" })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "unknown_field", path: "apiKey" })]),
    });
  });

  it.each([
    ["scheme-embedded credential", "https://token:credential-sentinel@example.test/issue/1"],
    ["bare query-string token", "SOT-15499?token=credential-sentinel"],
    ["bare fragment token", "SOT-15499#token=credential-sentinel"],
    ["query-string access_token", "SOT-15499?access_token=credential-sentinel"],
    ["fragment api_key", "SOT-15499#api_key=credential-sentinel"],
    ["query-string password", "SOT-15499?password=credential-sentinel"],
  ] as const)("rejects a ref carrying a %s without echoing the secret", (_label, ref) => {
    const result = parseRequirementSourceManifest(manifest({ ref }));
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "ref" })]),
    });
    expect(JSON.stringify(result)).not.toContain("credential-sentinel");
  });

  it.each([
    ["jira-style project key", { ...manifest(), requirementId: `req-${createHash("sha256").update("jira\0KEY-123").digest("hex").slice(0, 12)}`, ref: "KEY-123" }],
    ["user-input token-shaped id", { ...manifest(), provider: "user_input", requirementId: `req-${createHash("sha256").update("user_input\0TOKEN-1").digest("hex").slice(0, 12)}`, ref: "TOKEN-1" }],
  ] as const)("accepts a legitimate %s reference without an assignment", (_label, value) => {
    expect(parseRequirementSourceManifest(value)).toMatchObject({ ok: true, value: { ref: value.ref } });
  });
});
