import { CONTEXT_READ_RESULT_V1, type ContextReadResultV1 } from "@roll/spec";
import { describe, expect, it } from "vitest";
import { contextSnapshotReference } from "../../src/context/snapshot.js";
import { compareContextRevisions, decideContextRevision } from "../../src/context/revision-comparator.js";

function snapshot(revision: string, files: Readonly<Record<string, string>>): ContextReadResultV1 {
  return {
    schema: CONTEXT_READ_RESULT_V1,
    snapshotId: `ctx_${revision}`,
    snapshotDigest: "a".repeat(64),
    createdAt: "2026-07-24T06:00:00.000Z",
    artifactPath: `/runtime/${revision}.json`,
    outcome: "completed",
    requestScope: { workspaceId: "roll", repositoryIds: [], environmentIds: [], stage: "qa" },
    providers: [{
      providerId: "wiki",
      remoteIdentity: "https://github.com/example/wiki",
      branch: "main",
      fetchedAt: "2026-07-24T06:00:00.000Z",
      revision,
      providerConfigDigest: "b".repeat(64),
      bindingDigest: "c".repeat(64),
      files: Object.entries(files).map(([ref, sha256]) => ({ ref, path: ref.slice("context://wiki/".length), sha256, bytes: 1, content: ref })),
      warnings: [],
    }],
    gaps: [],
  };
}

describe("Context revision reconciliation", () => {
  it("reports unchanged revisions deterministically", () => {
    const handoff = snapshot("1".repeat(40), { "context://wiki/wiki/index.md": "a".repeat(64) });
    const comparison = compareContextRevisions(handoff, structuredClone(handoff));
    expect(comparison).toEqual({
      status: "unchanged",
      handoffSnapshot: contextSnapshotReference(handoff),
      freshSnapshot: contextSnapshotReference(handoff),
      providers: [{ providerId: "wiki", fromRevision: "1".repeat(40), toRevision: "1".repeat(40), changedRefs: [] }],
    });
    expect(decideContextRevision(comparison)).toEqual({
      accepted: true,
      record: {
        decision: "continue_with_handoff_snapshot",
        handoffSnapshot: contextSnapshotReference(handoff),
        freshSnapshot: contextSnapshotReference(handoff),
      },
      useSnapshot: "handoff",
    });
  });

  it("lists added, removed and modified refs and blocks a missing decision", () => {
    const handoff = snapshot("1".repeat(40), {
      "context://wiki/wiki/index.md": "a".repeat(64),
      "context://wiki/wiki/removed.md": "b".repeat(64),
    });
    const fresh = snapshot("2".repeat(40), {
      "context://wiki/wiki/index.md": "c".repeat(64),
      "context://wiki/wiki/added.md": "d".repeat(64),
    });
    const comparison = compareContextRevisions(handoff, fresh);
    expect(comparison).toEqual({
      status: "changed",
      handoffSnapshot: contextSnapshotReference(handoff),
      freshSnapshot: contextSnapshotReference(fresh),
      providers: [{
        providerId: "wiki",
        fromRevision: "1".repeat(40),
        toRevision: "2".repeat(40),
        changedRefs: [
          "context://wiki/wiki/added.md",
          "context://wiki/wiki/index.md",
          "context://wiki/wiki/removed.md",
        ],
      }],
    });
    expect(decideContextRevision(comparison)).toMatchObject({
      accepted: false,
      diagnostic: { code: "context_revision_changed", severity: "blocking" },
    });
    expect(decideContextRevision(comparison, "adopt_new_snapshot")).toEqual({
      accepted: true,
      record: {
        decision: "adopt_new_snapshot",
        handoffSnapshot: contextSnapshotReference(handoff),
        freshSnapshot: contextSnapshotReference(fresh),
      },
      useSnapshot: "new",
    });
    expect(decideContextRevision(comparison, "needs_reconciliation")).toEqual({
      accepted: true,
      record: {
        decision: "needs_reconciliation",
        handoffSnapshot: contextSnapshotReference(handoff),
        freshSnapshot: contextSnapshotReference(fresh),
      },
      useSnapshot: "none",
    });
  });
});
