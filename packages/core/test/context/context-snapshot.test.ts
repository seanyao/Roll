import { CONTEXT_READ_RESULT_V1, type ContextReadResultV1 } from "@roll/spec";
import { describe, expect, it } from "vitest";
import {
  computeContextSnapshotDigest,
  contextSnapshotId,
  contextSnapshotReference,
  verifyContextSnapshot,
} from "../../src/context/snapshot.js";

function snapshot(): ContextReadResultV1 {
  const value: ContextReadResultV1 = {
    schema: CONTEXT_READ_RESULT_V1,
    snapshotId: "ctx_example",
    snapshotDigest: "0".repeat(64),
    createdAt: "2026-07-24T06:00:00.000Z",
    artifactPath: "/workspace/runtime/context/US-CONTEXT-006/ctx_example.json",
    outcome: "completed",
    requestScope: {
      workspaceId: "roll",
      storyId: "US-CONTEXT-006",
      repositoryIds: ["https://github.com/seanyao/roll"],
      environmentIds: ["sit"],
      stage: "build",
    },
    providers: [{
      providerId: "wiki",
      remoteIdentity: "https://github.com/example/wiki",
      branch: "main",
      fetchedAt: "2026-07-24T05:59:59.000Z",
      revision: "a".repeat(40),
      providerConfigDigest: "b".repeat(64),
      bindingDigest: "c".repeat(64),
      files: [{
        ref: "context://wiki/wiki/index.md",
        path: "wiki/index.md",
        sha256: "d".repeat(64),
        bytes: 8,
        content: "# Index\n",
      }],
      warnings: [],
    }],
    gaps: [],
  };
  const snapshotDigest = computeContextSnapshotDigest(value);
  const snapshotId = contextSnapshotId(value.createdAt, snapshotDigest)!;
  return {
    ...value,
    snapshotId,
    snapshotDigest,
    artifactPath: `/workspace/runtime/context/US-CONTEXT-006/${snapshotId}.json`,
  };
}

describe("Context Snapshot canonical contract", () => {
  it("excludes self-referential fields and verifies the complete payload", () => {
    const original = snapshot();
    const moved = { ...original, artifactPath: "/other/path.json" };
    expect(computeContextSnapshotDigest(moved)).toBe(original.snapshotDigest);
    expect(verifyContextSnapshot(original)).toEqual({
      valid: true,
      snapshot: original,
      reference: contextSnapshotReference(original),
    });
  });

  it("rejects tampering, unknown fields and disabled pseudo-snapshots", () => {
    expect(verifyContextSnapshot({ ...snapshot(), providers: [] })).toMatchObject({
      valid: false,
      diagnostic: { code: "invalid_context_snapshot" },
    });
    expect(verifyContextSnapshot({ ...snapshot(), secret: "not-allowed" })).toMatchObject({ valid: false });
    expect(verifyContextSnapshot({ ...snapshot(), snapshotId: "ctx_moved" })).toMatchObject({ valid: false });
    const disabled = snapshot();
    expect(verifyContextSnapshot({
      ...disabled,
      outcome: "disabled",
      snapshotDigest: computeContextSnapshotDigest({ ...disabled, outcome: "disabled" }),
    })).toMatchObject({ valid: false });
  });
});
