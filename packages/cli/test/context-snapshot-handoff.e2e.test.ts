import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_READ_RESULT_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  type ContextReadResultV1,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import {
  computeContextSnapshotDigest,
  contextSnapshotId,
  contextSnapshotReference,
  verifyContextSnapshot,
  type ContextSnapshotReferenceV1,
} from "@roll/core";
import { readCapturedContextFile, readContextSnapshot, writeContextSnapshot } from "@roll/infra";
import { describe, expect, it } from "vitest";

function fixture(): { workspace: WorkspaceExecutionContextV1; snapshot: ContextReadResultV1 } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roll-context-handoff-")));
  const runtime = join(root, "runtime");
  const workspace: WorkspaceExecutionContextV1 = {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: { workspaceId: "roll", root, canonicalRoot: root, lifecycle: "active" },
    resolution: { source: "explicit", evidence: [] },
    bindings: [],
    authorities: {
      backlog: join(root, "backlog"),
      features: join(root, "features"),
      design: join(root, "design"),
      requirements: join(root, "requirements"),
      policy: join(root, "policy"),
      evidence: join(root, "evidence"),
      toolDumps: join(root, "tool-dumps"),
      events: join(root, "events"),
      runtime,
      locks: join(runtime, "locks"),
    },
  };
  const snapshotId = "pending";
  const initial: ContextReadResultV1 = {
    schema: CONTEXT_READ_RESULT_V1,
    snapshotId,
    snapshotDigest: "0".repeat(64),
    createdAt: "2026-07-24T06:00:00.000Z",
    artifactPath: "pending",
    outcome: "completed",
    requestScope: { workspaceId: "roll", storyId: "US-CONTEXT-006", repositoryIds: [], environmentIds: [], stage: "design" },
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
  const snapshotDigest = computeContextSnapshotDigest(initial);
  const resolvedSnapshotId = contextSnapshotId(initial.createdAt, snapshotDigest)!;
  return {
    workspace,
    snapshot: {
      ...initial,
      snapshotId: resolvedSnapshotId,
      snapshotDigest,
      artifactPath: join(runtime, "context", "US-CONTEXT-006", `${resolvedSnapshotId}.json`),
    },
  };
}

describe("Context Snapshot stage handoff", () => {
  it("serializes design reference and lets build/QA verify and reuse the same captured bytes without fetch", () => {
    const { workspace, snapshot } = fixture();
    writeContextSnapshot(workspace, snapshot);

    const wire = JSON.stringify(contextSnapshotReference(snapshot));
    const buildReference = JSON.parse(wire) as ContextSnapshotReferenceV1;
    const buildSnapshot = readContextSnapshot(workspace, buildReference);
    expect(verifyContextSnapshot(buildSnapshot)).toMatchObject({
      valid: true,
      reference: buildReference,
    });

    const qaReference = JSON.parse(JSON.stringify(contextSnapshotReference(buildSnapshot))) as ContextSnapshotReferenceV1;
    const qaSnapshot = readContextSnapshot(workspace, qaReference);
    expect(readCapturedContextFile(qaSnapshot, "context://wiki/wiki/index.md").content).toBe("# Index\n");
    expect(qaSnapshot.snapshotDigest).toBe(snapshot.snapshotDigest);
    expect(existsSync(snapshot.artifactPath)).toBe(true);
    const storeSource = readFileSync(new URL("../../infra/src/context/snapshot-store.ts", import.meta.url), "utf8");
    expect(storeSource).not.toMatch(/git-llm-wiki|context-read-adapter|child_process|\bfetch\s*\(/u);
  });
});
