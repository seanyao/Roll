import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
} from "@roll/core";
import { describe, expect, it, vi } from "vitest";
import {
  readCapturedContextFile,
  readContextSnapshot,
  writeContextSnapshot,
} from "../../src/context/snapshot-store.js";

function fixture(): { workspace: WorkspaceExecutionContextV1; runtime: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roll-context-snapshot-")));
  const runtime = join(root, "runtime");
  return {
    runtime,
    workspace: {
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
    },
  };
}

function snapshot(runtime: string, storyId?: string): ContextReadResultV1 {
  const snapshotId = "pending";
  const artifactPath = "pending";
  const initial: ContextReadResultV1 = {
    schema: CONTEXT_READ_RESULT_V1,
    snapshotId,
    snapshotDigest: "0".repeat(64),
    createdAt: "2026-07-24T06:00:00.000Z",
    artifactPath,
    outcome: "completed",
    requestScope: {
      workspaceId: "roll",
      ...(storyId === undefined ? {} : { storyId }),
      repositoryIds: [],
      environmentIds: [],
      stage: "qa",
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
  const snapshotDigest = computeContextSnapshotDigest(initial);
  const resolvedSnapshotId = contextSnapshotId(initial.createdAt, snapshotDigest)!;
  return {
    ...initial,
    snapshotId: resolvedSnapshotId,
    snapshotDigest,
    artifactPath: join(runtime, "context", storyId ?? "_workspace", `${resolvedSnapshotId}.json`),
  };
}

function resign(runtime: string, value: ContextReadResultV1): ContextReadResultV1 {
  const snapshotDigest = computeContextSnapshotDigest(value);
  const snapshotId = contextSnapshotId(value.createdAt, snapshotDigest)!;
  return {
    ...value,
    snapshotId,
    snapshotDigest,
    artifactPath: join(runtime, "context", value.requestScope.storyId ?? "_workspace", `${snapshotId}.json`),
  };
}

describe("Context Snapshot store", () => {
  it("writes Story and Workspace snapshots create-exclusively and reads verified content", () => {
    for (const storyId of ["US-CONTEXT-006", undefined]) {
      const { workspace, runtime } = fixture();
      const value = snapshot(runtime, storyId);
      expect(writeContextSnapshot(workspace, value)).toBe(value.artifactPath);
      expect(readContextSnapshot(workspace, contextSnapshotReference(value))).toEqual(value);
      expect(readCapturedContextFile(value, "context://wiki/wiki/index.md").content).toBe("# Index\n");
      expect(() => writeContextSnapshot(workspace, value)).toThrowError();
      expect(readFileSync(value.artifactPath, "utf8")).toContain(value.snapshotDigest);
    }
  });

  it("persists blocked audit facts but rejects disabled results", () => {
    const { workspace, runtime } = fixture();
    const base = snapshot(runtime, "US-CONTEXT-006");
    const blockedInitial = { ...base, outcome: "blocked" as const, providers: [], gaps: [{ code: "fetch_failed" as const, severity: "blocking" as const, message: "fetch failed" }] };
    const blocked = resign(runtime, blockedInitial);
    expect(writeContextSnapshot(workspace, blocked)).toBe(blocked.artifactPath);

    const disabledInitial = { ...snapshot(runtime), outcome: "disabled" as const, providers: [] };
    const disabled = resign(runtime, disabledInitial);
    expect(() => writeContextSnapshot(workspace, disabled)).toThrowError();
  });

  it("rejects tampering, moved artifacts, symlinks and authority escape", () => {
    const { workspace, runtime } = fixture();
    const value = snapshot(runtime, "US-CONTEXT-006");
    writeContextSnapshot(workspace, value);
    writeFileSync(value.artifactPath, readFileSync(value.artifactPath, "utf8").replace("# Index", "# Tampered"));
    expect(() => readContextSnapshot(workspace, contextSnapshotReference(value))).toThrowError();

    const outside = join(realpathSync(mkdtempSync(join(tmpdir(), "roll-context-outside-"))), "snapshot.json");
    writeFileSync(outside, JSON.stringify(value));
    expect(() => readContextSnapshot(workspace, { ...contextSnapshotReference(value), artifactPath: outside })).toThrowError();

    const link = join(runtime, "linked.json");
    symlinkSync(outside, link);
    expect(() => readContextSnapshot(workspace, { ...contextSnapshotReference(value), artifactPath: link })).toThrowError();
    expect(() => writeContextSnapshot(workspace, { ...value, artifactPath: outside })).toThrowError();
  });

  it("never fetches or backfills a ref missing from the captured Snapshot", () => {
    const fetchCanary = vi.fn();
    const { runtime } = fixture();
    expect(() => readCapturedContextFile(snapshot(runtime), "context://wiki/wiki/new-page.md")).toThrowError();
    expect(fetchCanary).not.toHaveBeenCalled();
  });

  it("fails a concurrent snapshotId collision without publishing or removing the other writer lock", () => {
    const { workspace, runtime } = fixture();
    const value = snapshot(runtime, "US-CONTEXT-006");
    const lock = `${value.artifactPath}.write-lock`;
    mkdirSync(lock, { recursive: true });
    expect(() => writeContextSnapshot(workspace, value)).toThrowError();
    expect(() => readFileSync(value.artifactPath, "utf8")).toThrowError();
    expect(realpathSync(lock)).toBe(lock);
  });

  it("atomically refuses a target created after the temp write and preserves the winner bytes", () => {
    const { workspace, runtime } = fixture();
    const value = snapshot(runtime, "US-CONTEXT-006");
    expect(() => writeContextSnapshot(workspace, value, {
      beforePublish: () => writeFileSync(value.artifactPath, "winner\n", { flag: "wx" }),
    })).toThrowError();
    expect(readFileSync(value.artifactPath, "utf8")).toBe("winner\n");
  });

  it("binds reads to the complete handoff reference and embedded artifact path", () => {
    const { workspace, runtime } = fixture();
    const value = snapshot(runtime, "US-CONTEXT-006");
    writeContextSnapshot(workspace, value);
    const reference = contextSnapshotReference(value);
    expect(() => readContextSnapshot(workspace, { ...reference, snapshotDigest: "f".repeat(64) })).toThrowError();

    const embedded = JSON.parse(readFileSync(value.artifactPath, "utf8")) as ContextReadResultV1;
    writeFileSync(value.artifactPath, `${JSON.stringify({ ...embedded, artifactPath: "/attacker/rewritten.json" })}\n`);
    expect(() => readContextSnapshot(workspace, reference)).toThrowError();
  });
});
