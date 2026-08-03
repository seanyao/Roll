import { describe, expect, it } from "vitest";
import type { RequirementArchiveAudit, RequirementSourceManifest } from "@roll/spec";
import {
  renderFinalRequirementAttest,
  type RequirementAttestStory,
} from "../src/workspace/requirement-attest.js";

const API = "repo-aaaaaaaaaaaa";
const WEB = "repo-bbbbbbbbbbbb";
const API_MERGE = "a".repeat(40);
const WEB_MERGE = "b".repeat(40);

function manifest(): RequirementSourceManifest {
  return {
    schema: "roll.requirement-source/v1",
    requirementId: "req-c78ccf14ea21",
    provider: "jira",
    ref: "SOT-15499",
    revision: "42",
    capturedAt: "2026-07-20T16:00:00.000Z",
    previousRevisions: [],
    requirement: { bytes: 1, sha256: "a".repeat(64) },
    context: [],
    stories: ["US-B", "US-A"],
    attest: {
      schema: "roll.requirement-attest-projection/v1",
      mode: "generated_aggregate",
      evidenceAuthority: "issue",
    },
  };
}

function audit(overrides: Partial<RequirementArchiveAudit> = {}): RequirementArchiveAudit {
  return {
    schema: "roll.requirement-archive-audit/v1",
    requirementId: "req-c78ccf14ea21",
    status: "healthy",
    checkedRevisions: ["42"],
    findings: [],
    ...overrides,
  };
}

function delivered(storyId: string, mergeCommit: string): RequirementAttestStory {
  return {
    storyId,
    state: "delivered",
    mergeCommits: storyId === "US-A" ? { [API]: mergeCommit } : { [WEB]: mergeCommit },
    evidencePaths: ["evidence/integration/result.txt", "evidence/repositories/merge.json"],
  };
}

describe("US-WS-014 Requirement exact-SHA attestation projection", () => {
  it("deterministically passes only when every linked Story is delivered with Issue-owned evidence", () => {
    const result = renderFinalRequirementAttest({
      manifest: manifest(),
      archiveAudit: audit(),
      stories: [delivered("US-A", API_MERGE), delivered("US-B", WEB_MERGE)],
    });

    expect(result.status).toBe("pass");
    expect(result.content).toMatchSnapshot();
    expect(result.content.indexOf("US-A")).toBeLessThan(result.content.indexOf("US-B"));
    expect(result.content).toContain(`${API}@${API_MERGE}`);
    expect(result.content).toContain("../../../issues/US-A/evidence/integration/result.txt");
  });

  it("stays partial and names linked Stories with missing completion or evidence instead of omitting them", () => {
    const result = renderFinalRequirementAttest({
      manifest: manifest(),
      archiveAudit: audit(),
      stories: [
        { storyId: "US-A", state: "integration_pending", mergeCommits: { [API]: API_MERGE }, evidencePaths: [] },
      ],
    });

    expect(result.status).toBe("partial");
    expect(result.content).toContain("US-A: pending (integration_pending; Issue evidence missing)");
    expect(result.content).toContain("US-B: pending (Issue state/evidence missing)");
    expect(result.content).not.toContain("Final verdict: PASS");
  });

  it("blocks final attestation on a corrupt or untrusted archive and preserves the exact finding", () => {
    const result = renderFinalRequirementAttest({
      manifest: manifest(),
      archiveAudit: audit({
        status: "corrupt",
        findings: [{ code: "content_digest_mismatch", revision: "42", evidencePath: "revisions/rev-42/requirement.md" }],
      }),
      stories: [delivered("US-A", API_MERGE), delivered("US-B", WEB_MERGE)],
    });

    expect(result.status).toBe("blocked");
    expect(result.content).toContain("content_digest_mismatch");
    expect(result.content).toContain("revisions/rev-42/requirement.md");
    expect(result.content).not.toContain("Final verdict: PASS");
  });
});
