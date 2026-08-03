import { describe, expect, it } from "vitest";
import {
  classifyRequirementArchiveIntegrity,
  type RequirementArchiveIntegrityFacts,
} from "../src/workspace/requirement-archive-integrity.js";

describe("US-WS-007a Requirement archive integrity classification", () => {
  it("returns a versioned healthy audit for a complete revision graph", () => {
    expect(classifyRequirementArchiveIntegrity({
      requirementId: "req-c78ccf14ea21",
      checkedRevisions: ["7", "6"],
      findings: [],
    })).toEqual({
      schema: "roll.requirement-archive-audit/v1",
      requirementId: "req-c78ccf14ea21",
      status: "healthy",
      checkedRevisions: ["7", "6"],
      findings: [],
    });
  });

  it("maps missing or mismatched immutable evidence to corrupt deterministically", () => {
    const facts: RequirementArchiveIntegrityFacts = {
      requirementId: "req-c78ccf14ea21",
      checkedRevisions: ["7", "6"],
      findings: [
        { code: "context_digest_mismatch", revision: "6", evidencePath: "revisions/6/context/api.md" },
        { code: "revision_missing", revision: "7", evidencePath: "revisions/7" },
        { code: "content_digest_mismatch", revision: "6", evidencePath: "revisions/6/requirement.md" },
      ],
    };

    expect(classifyRequirementArchiveIntegrity(facts)).toMatchObject({
      status: "corrupt",
      findings: [
        { code: "revision_missing", revision: "7", evidencePath: "revisions/7" },
        { code: "content_digest_mismatch", revision: "6", evidencePath: "revisions/6/requirement.md" },
        { code: "context_digest_mismatch", revision: "6", evidencePath: "revisions/6/context/api.md" },
      ],
    });
  });

  it("lets manifest, unsafe-path, and read-race findings dominate as untrusted", () => {
    const result = classifyRequirementArchiveIntegrity({
      requirementId: "req-c78ccf14ea21",
      checkedRevisions: ["7"],
      findings: [
        { code: "content_digest_mismatch", revision: "7", evidencePath: "revisions/7/requirement.md" },
        { code: "archive_changed_during_read", revision: "7", evidencePath: "revisions/7/capture.yaml" },
        { code: "manifest_invalid", evidencePath: "source.yaml" },
      ],
    });

    expect(result.status).toBe("untrusted");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "manifest_invalid",
      "archive_changed_during_read",
      "content_digest_mismatch",
    ]);
  });

  it("is idempotent and does not mutate its input facts", () => {
    const finding = Object.freeze({
      code: "revision_metadata_mismatch" as const,
      revision: "6",
      evidencePath: "revisions/6/capture.yaml",
    });
    const facts = Object.freeze({
      requirementId: "req-c78ccf14ea21",
      checkedRevisions: Object.freeze(["7", "6"]),
      findings: Object.freeze([finding]),
    });

    const first = classifyRequirementArchiveIntegrity(facts);
    const second = classifyRequirementArchiveIntegrity(facts);

    expect(second).toEqual(first);
    expect(facts).toEqual({
      requirementId: "req-c78ccf14ea21",
      checkedRevisions: ["7", "6"],
      findings: [finding],
    });
  });
});
