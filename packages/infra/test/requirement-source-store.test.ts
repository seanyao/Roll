import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_REQUIREMENT_CONTEXT_BYTES, MAX_REQUIREMENT_CONTEXT_FILES } from "@roll/core";
import { acquireLock, releaseLock } from "../src/process.js";
import {
  captureRequirementSource,
  inspectRequirementProjection,
  repairRequirementProjection,
  requirementCaptureLockPath,
  resolveRequirementSourcesForStoryOnDisk,
} from "../src/requirement-source-store.js";
import { withWorkspaceAuthorityLockSync, workspaceAuthorityLockPath } from "../src/workspace-authority-lock.js";

const roots: string[] = [];

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-requirement-store-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  write(join(workspace, "workspace.yaml"), `${JSON.stringify({
    schema: "roll.workspace/v1",
    workspaceId: "ws-demo",
    displayName: "Demo",
    requirements: [
      { provider: "JIRA", ref: "sot-15499" },
      { provider: "github-issue", ref: "Owner/Repo#12" },
    ],
    repositories: [{
      schema: "roll.repository-binding/v1",
      repoId: "repo-ff7a87ddbb2b",
      alias: "product",
      remote: "https://example.test/owner/product",
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  }, null, 2)}\n`);
  for (const storyId of ["US-WS-007", "US-WS-008", "US-WS-009"]) {
    write(join(workspace, "backlog", "epic", storyId, "spec.md"), `# ${storyId}\n`);
  }
  const body = join(root, "requirement.md");
  write(body, "# Jira requirement\n\nShip the Workspace source archive.\n");
  const contextRoot = join(root, "context-source");
  write(join(contextRoot, "domain.md"), "domain context\n");
  write(join(contextRoot, "brief", "acceptance.md"), "acceptance context\n");
  return { root, workspace, body, contextRoot };
}

function request(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return {
    rollHome: f.root,
    workspaceRoot: f.workspace,
    provider: "jira",
    ref: "SOT-15499",
    revision: "42",
    capturedAt: "2026-07-20T16:00:00.000Z",
    bodyFile: f.body,
    contextRoot: f.contextRoot,
    contextPaths: ["domain.md", "brief/acceptance.md"],
    storyIds: ["US-WS-008", "US-WS-007"],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-WS-007 RequirementSourceStore", () => {
  it("commits immutable revisions, keeps identical captures at zero writes and extends Story links separately", () => {
    const f = fixture();
    const renames: string[] = [];
    let observedOrderedLocks = false;
    const lockOrder: string[] = [];
    const deps = {
      renameFile: (from: string, to: string) => { renames.push(to); renameSync(from, to); },
      onLockAcquired: (lock: "authority" | "requirement") => lockOrder.push(lock),
      beforeProjection: () => {
        expect(existsSync(workspaceAuthorityLockPath(f.root, "ws-demo"))).toBe(true);
        expect(existsSync(requirementCaptureLockPath(f.workspace, "req-c78ccf14ea21"))).toBe(true);
        observedOrderedLocks = true;
      },
    };
    const first = captureRequirementSource(request(f), deps);
    expect(observedOrderedLocks).toBe(true);
    expect(first).toMatchObject({
      outcome: "created",
      workspaceId: "ws-demo",
      manifest: { provider: "jira", ref: "SOT-15499", revision: "42", stories: ["US-WS-007", "US-WS-008"] },
      contextCount: 2,
    });
    expect(lockOrder.slice(0, 2)).toEqual(["authority", "requirement"]);
    expect(first.requirementPath).toMatch(/requirements\/jira\/req-c78ccf14ea21$/u);
    const revisionKey = "rev-" + "73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049";
    const revision = join(first.requirementPath, "revisions", revisionKey);
    expect(readFileSync(join(revision, "requirement.md"), "utf8")).toContain("Jira requirement");
    expect(readFileSync(join(revision, "context", "brief", "acceptance.md"), "utf8")).toBe("acceptance context\n");
    expect(readFileSync(join(first.requirementPath, "attest.md"), "utf8")).toContain("Generated pending projection");
    expect(lstatSync(revision).isDirectory()).toBe(true);

    const writesAfterFirst = renames.length;
    const reused = captureRequirementSource(request(f, { capturedAt: "2030-01-01T00:00:00.000Z" }), deps);
    expect(reused.outcome).toBe("reused");
    expect(renames).toHaveLength(writesAfterFirst);

    const projectedBodyBeforeLink = lstatSync(join(first.requirementPath, "requirement.md"));
    const projectedContextBeforeLink = lstatSync(join(first.requirementPath, "context", "domain.md"));
    const linked = captureRequirementSource(request(f, { storyIds: ["US-WS-009"] }), deps);
    expect(linked).toMatchObject({ outcome: "linked", manifest: { stories: ["US-WS-007", "US-WS-008", "US-WS-009"] } });
    expect(readdirSync(join(first.requirementPath, "revisions"))).toEqual([revisionKey]);
    expect(lstatSync(join(first.requirementPath, "requirement.md")).ino).toBe(projectedBodyBeforeLink.ino);
    expect(lstatSync(join(first.requirementPath, "context", "domain.md")).ino).toBe(projectedContextBeforeLink.ino);

    writeFileSync(f.body, "# Jira requirement\n\nRevision 43.\n", "utf8");
    const updated = captureRequirementSource(request(f, {
      revision: "43",
      capturedAt: "2026-07-20T17:00:00.000Z",
      storyIds: ["US-WS-009"],
      contextPaths: [],
    }), deps);
    expect(updated).toMatchObject({ outcome: "updated", manifest: { revision: "43", previousRevisions: [{ revision: "42" }] } });
    expect(readFileSync(join(revision, "requirement.md"), "utf8")).toContain("Ship the Workspace source archive");
    expect(readFileSync(join(updated.requirementPath, "requirement.md"), "utf8")).toContain("Revision 43");
    expect(readdirSync(join(updated.requirementPath, "revisions"))).toHaveLength(2);
  });

  it("strictly parses the full source.yaml on disk after create/link/update and matches it field-for-field against the returned manifest contract", () => {
    const f = fixture();
    const created = captureRequirementSource(request(f));
    const createdOnDisk = JSON.parse(readFileSync(join(created.requirementPath, "source.yaml"), "utf8"));
    expect(createdOnDisk).toEqual(created.manifest);

    const linked = captureRequirementSource(request(f, { storyIds: ["US-WS-009"] }));
    const linkedOnDisk = JSON.parse(readFileSync(join(linked.requirementPath, "source.yaml"), "utf8"));
    expect(linkedOnDisk).toEqual(linked.manifest);

    writeFileSync(f.body, "# Jira requirement\n\nRevision 43.\n", "utf8");
    const updated = captureRequirementSource(request(f, {
      revision: "43",
      capturedAt: "2026-07-20T17:00:00.000Z",
      storyIds: ["US-WS-009"],
      contextPaths: [],
    }));
    const updatedOnDisk = JSON.parse(readFileSync(join(updated.requirementPath, "source.yaml"), "utf8"));
    expect(updatedOnDisk).toEqual(updated.manifest);
    expect(updatedOnDisk.schema).toBe("roll.requirement-source/v1");
    expect(updatedOnDisk.requirementId).toBe(created.manifest.requirementId);
    expect(updatedOnDisk.previousRevisions).toEqual([{ revision: "42", capturedAt: "2026-07-20T16:00:00.000Z" }]);
    expect(updatedOnDisk.attest).toEqual({
      schema: "roll.requirement-attest-projection/v1",
      mode: "generated_aggregate",
      evidenceAuthority: "issue",
    });
  });

  it("rejects a ref not declared in workspace.yaml", () => {
    const f = fixture();
    expect(() => captureRequirementSource(request(f, { ref: "SOT-99999" }))).toThrowError(
      expect.objectContaining({ code: "source_not_declared" }),
    );
  });

  it("rejects a Story ID that does not resolve inside the Workspace backlog", () => {
    const f = fixture();
    expect(() => captureRequirementSource(request(f, { storyIds: ["US-MISSING"] }))).toThrowError(
      expect.objectContaining({ code: "story_not_found" }),
    );
  });

  it("rejects a context path using .. traversal to escape its declared root", () => {
    const f = fixture();
    expect(() => captureRequirementSource(request(f, { contextPaths: ["../requirement.md"] }))).toThrowError(
      expect.objectContaining({ code: "unsafe_context" }),
    );
  });

  it("rejects a context path whose leaf entry is itself a symlink, independent of any ancestor-directory symlink case", () => {
    const f = fixture();
    symlinkSync(join(f.contextRoot, "domain.md"), join(f.contextRoot, "linked.md"));
    expect(() => captureRequirementSource(request(f, { contextPaths: ["linked.md"] }))).toThrowError(
      expect.objectContaining({ code: "unsafe_context" }),
    );
  });

  it("rejects a context path that names a directory instead of a regular file", () => {
    const f = fixture();
    expect(() => captureRequirementSource(request(f, { contextPaths: ["brief"] }))).toThrowError(
      expect.objectContaining({ code: "unsafe_context" }),
    );
  });

  it("rejects an oversized single context file without reading its content past the limit check", () => {
    const f = fixture();
    write(join(f.contextRoot, "huge.bin"), "x".repeat(1024 * 1024 + 1));
    expect(() => captureRequirementSource(request(f, { contextPaths: ["huge.bin"] }))).toThrowError(
      expect.objectContaining({ code: "context_limit" }),
    );
    const reads: string[] = [];
    expect(() => captureRequirementSource(request(f, { contextPaths: ["huge.bin"] }), {
      afterReadFile: (path) => reads.push(path),
    })).toThrowError(expect.objectContaining({ code: "context_limit" }));
    expect(reads).not.toContain(join(f.contextRoot, "huge.bin"));
  });

  it("proves an identical reuse capture makes truly zero filesystem mutations across the whole Workspace tree", () => {
    const f = fixture();
    captureRequirementSource(request(f));

    function snapshotTree(root: string): ReadonlyMap<string, string> {
      const entries = new Map<string, string>();
      const walk = (dir: string, relativeDir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
          const path = join(dir, entry.name);
          const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
          const stat = lstatSync(path);
          const digest = stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "";
          entries.set(relativePath, JSON.stringify({
            type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file",
            ino: stat.ino,
            dev: stat.dev,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            digest,
          }));
          if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, relativePath);
        }
      };
      walk(root, "");
      return entries;
    }

    const evidenceRoot = join(f.workspace, "requirements");
    const before = snapshotTree(evidenceRoot);
    const reused = captureRequirementSource(request(f, { capturedAt: "2030-01-01T00:00:00.000Z" }));
    expect(reused.outcome).toBe("reused");
    const after = snapshotTree(evidenceRoot);

    expect(before.size).toBeGreaterThan(0);
    expect(Array.from(after.keys()).sort()).toEqual(Array.from(before.keys()).sort());
    for (const [path, beforeEntry] of before) {
      expect(after.get(path), `entry changed at ${path}`).toBe(beforeEntry);
    }
  });

  it("rejects a symlink nested inside a legitimate context subdirectory, not only at the top level", () => {
    const f = fixture();
    const outside = join(f.root, "outside-nested.txt");
    write(outside, "nested escape target\n");
    symlinkSync(outside, join(f.contextRoot, "brief", "nested-link.md"));
    expect(() => captureRequirementSource(request(f, { contextPaths: ["brief/nested-link.md"] }))).toThrowError(
      expect.objectContaining({ code: "unsafe_context" }),
    );
    expect(existsSync(join(f.workspace, "requirements"))).toBe(false);
  });

  it("rejects a context path whose immediate ancestor directory is itself a symlink to an outside real directory", () => {
    const f = fixture();
    const outsideDir = join(f.root, "outside-ancestor-dir");
    mkdirSync(outsideDir);
    write(join(outsideDir, "file.md"), "outside ancestor content\n");
    rmSync(join(f.contextRoot, "brief"), { recursive: true, force: true });
    symlinkSync(outsideDir, join(f.contextRoot, "brief"));

    expect(() => captureRequirementSource(request(f, { contextPaths: ["brief/file.md"] }))).toThrowError(
      expect.objectContaining({ code: "unsafe_context" }),
    );
    expect(existsSync(join(f.workspace, "requirements"))).toBe(false);
  });

  it("accepts the exact context depth boundary and rejects the next segment", () => {
    const allowed = fixture();
    const allowedRelative = [...Array.from({ length: 31 }, (_, index) => `d${index}`), "allowed.md"].join("/");
    write(join(allowed.contextRoot, allowedRelative), "at depth boundary\n");
    expect(captureRequirementSource(request(allowed, { contextPaths: [allowedRelative] })).contextCount).toBe(1);

    const rejected = fixture();
    const rejectedRelative = [...Array.from({ length: 32 }, (_, index) => `d${index}`), "rejected.md"].join("/");
    write(join(rejected.contextRoot, rejectedRelative), "past depth boundary\n");
    expect(() => captureRequirementSource(request(rejected, { contextPaths: [rejectedRelative] }))).toThrowError(
      expect.objectContaining({ code: "unsafe_context" }),
    );
    expect(existsSync(join(rejected.workspace, "requirements"))).toBe(false);
  });

  it("accepts exactly MAX_REQUIREMENT_CONTEXT_FILES files and exactly MAX_REQUIREMENT_CONTEXT_BYTES total bytes", () => {
    const f = fixture();
    const perFileBytes = Math.floor(MAX_REQUIREMENT_CONTEXT_BYTES / MAX_REQUIREMENT_CONTEXT_FILES);
    const contextPaths: string[] = [];
    let used = 0;
    for (let index = 0; index < MAX_REQUIREMENT_CONTEXT_FILES; index += 1) {
      const isLast = index === MAX_REQUIREMENT_CONTEXT_FILES - 1;
      const bytes = isLast ? MAX_REQUIREMENT_CONTEXT_BYTES - used : perFileBytes;
      write(join(f.contextRoot, `bulk-${index}.md`), "x".repeat(bytes));
      contextPaths.push(`bulk-${index}.md`);
      used += bytes;
    }
    expect(used).toBe(MAX_REQUIREMENT_CONTEXT_BYTES);

    const result = captureRequirementSource(request(f, { contextPaths }));
    expect(result.contextCount).toBe(MAX_REQUIREMENT_CONTEXT_FILES);
  });

  it("rejects MAX_REQUIREMENT_CONTEXT_FILES plus one before any immutable write", () => {
    const f = fixture();
    const contextPaths = Array.from({ length: MAX_REQUIREMENT_CONTEXT_FILES + 1 }, (_, index) => `count-${index}.md`);
    for (const relativePath of contextPaths) write(join(f.contextRoot, relativePath), "x");

    expect(() => captureRequirementSource(request(f, { contextPaths }))).toThrowError(
      expect.objectContaining({ code: "context_limit" }),
    );
    expect(existsSync(join(f.workspace, "requirements"))).toBe(false);
  });

  it("rejects a multi-file context set whose aggregate exceeds the byte limit even though every single file is under it", () => {
    const f = fixture();
    const perFileBytes = Math.floor(MAX_REQUIREMENT_CONTEXT_BYTES / 4);
    const contextPaths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      write(join(f.contextRoot, `agg-${index}.md`), "x".repeat(perFileBytes));
      contextPaths.push(`agg-${index}.md`);
    }
    expect(() => captureRequirementSource(request(f, { contextPaths }))).toThrowError(
      expect.objectContaining({ code: "context_limit" }),
    );
    expect(existsSync(join(f.workspace, "requirements"))).toBe(false);
  });

  it("bounds context by public file count rather than internal directory-entry count", () => {
    const f = fixture();
    const contextPaths: string[] = [];
    for (let index = 0; index < MAX_REQUIREMENT_CONTEXT_FILES; index += 1) {
      const relativePath = `d${index}/file.md`;
      write(join(f.contextRoot, relativePath), "x");
      contextPaths.push(relativePath);
    }
    expect(contextPaths).toHaveLength(MAX_REQUIREMENT_CONTEXT_FILES);

    const captured = captureRequirementSource(request(f, { contextPaths }));
    expect(captured.contextCount).toBe(MAX_REQUIREMENT_CONTEXT_FILES);
    expect(existsSync(join(captured.requirementPath, "revisions"))).toBe(true);
  });

  it.each([
    ["leading .. traversal", "../escape.md"],
    ["absolute path", "/etc/passwd"],
    ["Windows-style backslash traversal", "..\\escape.md"],
    ["inner .. traversal past root via a subdirectory", "a/../../escape.md"],
  ] as const)("writes nothing to disk when the declared context path is invalid: %s (%s)", (_label, contextPath) => {
    const f = fixture();
    expect(() => captureRequirementSource(request(f, {
      contextPaths: [contextPath],
    }))).toThrowError(expect.objectContaining({ code: "unsafe_context" }));
    expect(existsSync(join(f.workspace, "requirements"))).toBe(false);
  });

  it("rejects a context root that is itself a symlink to an external location", () => {
    const f = fixture();
    const outsideContext = join(f.root, "outside-context");
    mkdirSync(outsideContext);
    write(join(outsideContext, "domain.md"), "external context\n");
    const linkedRoot = join(f.root, "linked-context-root");
    symlinkSync(outsideContext, linkedRoot);

    expect(() => captureRequirementSource(request(f, { contextRoot: linkedRoot, contextPaths: ["domain.md"] }))).toThrowError(
      expect.objectContaining({ code: "unsafe_context" }),
    );
  });

  it("copies context as independent evidence so later source edits never reach the archived revision", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const revisionKey = "rev-" + "73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049";
    const archivedContext = join(first.requirementPath, "revisions", revisionKey, "context", "domain.md");
    expect(lstatSync(archivedContext).isSymbolicLink()).toBe(false);
    const before = readFileSync(archivedContext, "utf8");

    writeFileSync(join(f.contextRoot, "domain.md"), "mutated after capture\n", "utf8");
    expect(readFileSync(archivedContext, "utf8")).toBe(before);
    expect(readFileSync(join(first.requirementPath, "context", "domain.md"), "utf8")).toBe(before);
  });

  it("rejects Workspace output symlinks before committing any evidence", () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(f.workspace, "requirements"));

    expect(() => captureRequirementSource(request(f))).toThrowError(
      expect.objectContaining({ code: "unsafe_context" }),
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it("fails closed on source mutation, revision rename failure and a concurrent writer", () => {
    const f = fixture();
    let mutated = false;
    expect(() => captureRequirementSource(request(f), {
      afterReadFile: (path) => {
        if (!mutated && path === f.body) {
          mutated = true;
          writeFileSync(path, "changed during capture\n", "utf8");
        }
      },
    })).toThrowError(expect.objectContaining({ code: "source_changed" }));

    writeFileSync(f.body, "stable again\n", "utf8");
    expect(() => captureRequirementSource(request(f), {
      renameFile: (from, to) => {
        if (to.includes("/revisions/")) throw new Error("rename failure");
        renameSync(from, to);
      },
    })).toThrowError(expect.objectContaining({ code: "io_failure" }));
    expect(existsSync(join(f.workspace, "requirements", "jira", "req-c78ccf14ea21", "source.yaml"))).toBe(false);

    const lockPath = requirementCaptureLockPath(f.workspace, "req-c78ccf14ea21");
    const lock = acquireLock(lockPath, process.pid, { cycleId: "test-holder", unparseableIsHeld: true });
    expect(lock.acquired).toBe(true);
    try {
      expect(() => captureRequirementSource(request(f))).toThrowError(expect.objectContaining({ code: "concurrent_capture" }));
    } finally {
      releaseLock(lockPath);
    }
  });

  it("fails loud when a context file changes while it is being captured", () => {
    const f = fixture();
    const contextPath = join(f.contextRoot, "domain.md");
    let mutated = false;

    expect(() => captureRequirementSource(request(f), {
      afterReadFile: (path) => {
        if (!path.endsWith("/domain.md") || mutated) return;
        mutated = true;
        writeFileSync(path, "changed during capture\n", "utf8");
      },
    })).toThrowError(expect.objectContaining({ code: "source_changed" }));
    expect(mutated).toBe(true);
    expect(existsSync(join(f.workspace, "requirements"))).toBe(false);
  });

  it("commits source authority before projections but requires an explicit repair after interruption", () => {
    const f = fixture();
    expect(() => captureRequirementSource(request(f), { beforeProjection: () => { throw new Error("projection failed"); } }))
      .toThrowError(expect.objectContaining({ code: "projection_repair_required" }));
    const requirementPath = join(f.workspace, "requirements", "jira", "req-c78ccf14ea21");
    expect(JSON.parse(readFileSync(join(requirementPath, "source.yaml"), "utf8"))).toMatchObject({ revision: "42" });
    expect(existsSync(join(requirementPath, "projection.pending.json"))).toBe(true);

    expect(() => captureRequirementSource(request(f, { capturedAt: "2030-01-01T00:00:00.000Z" })))
      .toThrowError(expect.objectContaining({ code: "projection_repair_required" }));
    expect(existsSync(join(requirementPath, "projection.pending.json"))).toBe(true);
    expect(existsSync(join(requirementPath, "requirement.md"))).toBe(false);
  });

  it("reports a pre-authority projection journal failure as I/O failure", () => {
    const f = fixture();
    expect(() => captureRequirementSource(request(f), {
      renameFile: (from, to) => {
        if (to.endsWith("projection.pending.json")) throw new Error("journal unavailable");
        renameSync(from, to);
      },
    })).toThrowError(expect.objectContaining({ code: "io_failure" }));
    const requirementPath = join(f.workspace, "requirements", "jira", "req-c78ccf14ea21");
    expect(existsSync(join(requirementPath, "source.yaml"))).toBe(false);
  });

  it("fails loudly on a corrupted current projection without repairing it during capture", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    writeFileSync(join(first.requirementPath, "attest.md"), "corrupted projection\n", "utf8");

    expect(() => captureRequirementSource(request(f, { capturedAt: "2030-01-01T00:00:00.000Z" })))
      .toThrowError(expect.objectContaining({ code: "projection_repair_required" }));
    expect(readFileSync(join(first.requirementPath, "attest.md"), "utf8")).toBe("corrupted projection\n");
  });

  it("fails loudly when an immutable revision is missing or tampered before reuse", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const revision = join(first.requirementPath, "revisions", "rev-73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049");
    writeFileSync(join(revision, "requirement.md"), "tampered evidence\n", "utf8");
    expect(() => captureRequirementSource(request(f))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );

    rmSync(revision, { recursive: true });
    expect(() => captureRequirementSource(request(f))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );
  });

  it("fails loudly when an archived context file's content is tampered independently of the body", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const revision = join(first.requirementPath, "revisions", "rev-73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049");
    writeFileSync(join(revision, "context", "domain.md"), "tampered context content\n", "utf8");
    expect(() => captureRequirementSource(request(f))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );
  });

  it("fails loudly when capture.yaml's requirementId is tampered away from the manifest identity", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const revision = join(first.requirementPath, "revisions", "rev-73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049");
    const capture = JSON.parse(readFileSync(join(revision, "capture.yaml"), "utf8"));
    capture.requirementId = "req-000000000000";
    writeFileSync(join(revision, "capture.yaml"), `${JSON.stringify(capture, null, 2)}\n`, "utf8");
    expect(() => captureRequirementSource(request(f))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );
  });

  it("fails loudly when capture.yaml's recorded requirement digest is tampered away from the actual body", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const revision = join(first.requirementPath, "revisions", "rev-73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049");
    const capture = JSON.parse(readFileSync(join(revision, "capture.yaml"), "utf8"));
    capture.requirement.sha256 = "f".repeat(64);
    writeFileSync(join(revision, "capture.yaml"), `${JSON.stringify(capture, null, 2)}\n`, "utf8");
    expect(() => captureRequirementSource(request(f))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );
  });

  it("fails loudly when capture.yaml's recorded context descriptor is tampered away from the actual archived context", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const revision = join(first.requirementPath, "revisions", "rev-73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049");
    const capture = JSON.parse(readFileSync(join(revision, "capture.yaml"), "utf8"));
    capture.context[0].sha256 = "e".repeat(64);
    writeFileSync(join(revision, "capture.yaml"), `${JSON.stringify(capture, null, 2)}\n`, "utf8");
    expect(() => captureRequirementSource(request(f))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );
  });

  it("does not rescan historical revision metadata during a current-revision reuse", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const firstRevisionKey = "rev-73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049";
    writeFileSync(f.body, "# Jira requirement\n\nRevision 43.\n", "utf8");
    captureRequirementSource(request(f, { revision: "43", capturedAt: "2026-07-20T17:00:00.000Z" }));
    const capture = JSON.parse(readFileSync(join(first.requirementPath, "revisions", firstRevisionKey, "capture.yaml"), "utf8"));
    capture.capturedAt = "2099-01-01T00:00:00.000Z";
    writeFileSync(join(first.requirementPath, "revisions", firstRevisionKey, "capture.yaml"), `${JSON.stringify(capture, null, 2)}\n`, "utf8");
    expect(captureRequirementSource(request(f, { revision: "43" })).outcome).toBe("reused");
  });

  it("fails loudly when the CURRENT revision's own capture.yaml capturedAt is tampered away from source authority, on reuse", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const firstRevisionKey = "rev-73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049";
    const capturePath = join(first.requirementPath, "revisions", firstRevisionKey, "capture.yaml");
    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    expect(capture.capturedAt).toBe("2026-07-20T16:00:00.000Z");
    capture.capturedAt = "2099-01-01T00:00:00.000Z";
    writeFileSync(capturePath, `${JSON.stringify(capture, null, 2)}\n`, "utf8");

    const before = snapshotRequirementsTree(join(f.workspace, "requirements"));
    expect(() => captureRequirementSource(request(f))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );
    const after = snapshotRequirementsTree(join(f.workspace, "requirements"));
    expectNoTreeChange(before, after);
  });

  it("fails loudly when the CURRENT revision's own capture.yaml previousRevisions is tampered away from source authority, on update", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    writeFileSync(f.body, "# Jira requirement\n\nRevision 43.\n", "utf8");
    captureRequirementSource(request(f, { revision: "43", capturedAt: "2026-07-20T17:00:00.000Z" }));
    const secondRevisionKey = "rev-" + createHash("sha256").update("43").digest("hex");
    const capturePath = join(first.requirementPath, "revisions", secondRevisionKey, "capture.yaml");
    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    expect(capture.previousRevisions).toEqual([{ revision: "42", capturedAt: "2026-07-20T16:00:00.000Z" }]);
    capture.previousRevisions = [];
    writeFileSync(capturePath, `${JSON.stringify(capture, null, 2)}\n`, "utf8");

    const before = snapshotRequirementsTree(join(f.workspace, "requirements"));
    writeFileSync(f.body, "# Jira requirement\n\nRevision 44.\n", "utf8");
    expect(() => captureRequirementSource(request(f, { revision: "44", capturedAt: "2026-07-20T18:00:00.000Z" }))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );
    const after = snapshotRequirementsTree(join(f.workspace, "requirements"));
    expectNoTreeChange(before, after);

    const newRevisionKey = "rev-" + createHash("sha256").update("44").digest("hex");
    expect(existsSync(join(first.requirementPath, "revisions", newRevisionKey))).toBe(false);
  });

  function snapshotRequirementsTree(root: string): ReadonlyMap<string, string> {
    const entries = new Map<string, string>();
    const walk = (dir: string, relativeDir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const path = join(dir, entry.name);
        const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
        const stat = lstatSync(path);
        const digest = stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "";
        entries.set(relativePath, JSON.stringify({
          type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file",
          ino: stat.ino,
          dev: stat.dev,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          digest,
        }));
        if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, relativePath);
      }
    };
    if (existsSync(root)) walk(root, "");
    return entries;
  }

  function expectNoTreeChange(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): void {
    expect(Array.from(after.keys()).sort()).toEqual(Array.from(before.keys()).sort());
    for (const [path, beforeEntry] of before) {
      expect(after.get(path), `entry changed at ${path}`).toBe(beforeEntry);
    }
  }

  it("rejects an update when the existing revision's archived context was tampered, leaving zero orphan revision on disk", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const firstRevisionKey = "rev-73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049";
    writeFileSync(join(first.requirementPath, "revisions", firstRevisionKey, "context", "domain.md"), "tampered\n", "utf8");

    const requirementsRoot = join(f.workspace, "requirements");
    const before = snapshotRequirementsTree(requirementsRoot);
    writeFileSync(f.body, "# Jira requirement\n\nRevision 43.\n", "utf8");
    expect(() => captureRequirementSource(request(f, { revision: "43", capturedAt: "2026-07-20T17:00:00.000Z" }))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );
    const after = snapshotRequirementsTree(requirementsRoot);
    expectNoTreeChange(before, after);

    const secondRevisionKey = "rev-" + createHash("sha256").update("43").digest("hex");
    expect(existsSync(join(first.requirementPath, "revisions", secondRevisionKey))).toBe(false);
  });

  it("rejects an update when the existing revision's capture.yaml metadata was tampered, leaving zero orphan revision on disk", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const firstRevisionKey = "rev-73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049";
    const capture = JSON.parse(readFileSync(join(first.requirementPath, "revisions", firstRevisionKey, "capture.yaml"), "utf8"));
    capture.requirement.sha256 = "f".repeat(64);
    writeFileSync(join(first.requirementPath, "revisions", firstRevisionKey, "capture.yaml"), `${JSON.stringify(capture, null, 2)}\n`, "utf8");

    const requirementsRoot = join(f.workspace, "requirements");
    const before = snapshotRequirementsTree(requirementsRoot);
    writeFileSync(f.body, "# Jira requirement\n\nRevision 43.\n", "utf8");
    expect(() => captureRequirementSource(request(f, { revision: "43", capturedAt: "2026-07-20T17:00:00.000Z" }))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );
    const after = snapshotRequirementsTree(requirementsRoot);
    expectNoTreeChange(before, after);

    const secondRevisionKey = "rev-" + createHash("sha256").update("43").digest("hex");
    expect(existsSync(join(first.requirementPath, "revisions", secondRevisionKey))).toBe(false);
  });

  it("rejects an update when the existing source.yaml's previousRevisions history was tampered, leaving zero orphan revision on disk", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    writeFileSync(f.body, "# Jira requirement\n\nRevision 43.\n", "utf8");
    captureRequirementSource(request(f, { revision: "43", capturedAt: "2026-07-20T17:00:00.000Z" }));
    const sourcePath = join(first.requirementPath, "source.yaml");
    const source = JSON.parse(readFileSync(sourcePath, "utf8"));
    source.previousRevisions = [];
    writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`, "utf8");

    const requirementsRoot = join(f.workspace, "requirements");
    const before = snapshotRequirementsTree(requirementsRoot);
    writeFileSync(f.body, "# Jira requirement\n\nRevision 44.\n", "utf8");
    expect(() => captureRequirementSource(request(f, { revision: "44", capturedAt: "2026-07-20T18:00:00.000Z" }))).toThrowError(
      expect.objectContaining({ code: "revision_conflict" }),
    );
    const after = snapshotRequirementsTree(requirementsRoot);
    expectNoTreeChange(before, after);

    const newRevisionKey = "rev-" + createHash("sha256").update("44").digest("hex");
    expect(existsSync(join(first.requirementPath, "revisions", newRevisionKey))).toBe(false);
  });

  it("resolves a Story back to its Requirement sources by reading source.yaml from disk in a fresh call, not an in-memory cache", () => {
    const f = fixture();
    captureRequirementSource(request(f));
    captureRequirementSource(request(f, { provider: "github-issue", ref: "Owner/Repo#12", storyIds: ["US-WS-009"] }));

    const forWs007 = resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007");
    expect(forWs007.map((manifest) => manifest.ref)).toEqual(["SOT-15499"]);

    const forWs009 = resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-009");
    expect(forWs009.map((manifest) => manifest.ref)).toEqual(["owner/repo#12"]);

    expect(resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-UNKNOWN")).toEqual([]);
  });

  it("reflects an updated revision in the on-disk Story reverse lookup without any in-process state carried over", () => {
    const f = fixture();
    captureRequirementSource(request(f));
    writeFileSync(f.body, "# Jira requirement\n\nRevision 43.\n", "utf8");
    captureRequirementSource(request(f, { revision: "43", capturedAt: "2026-07-20T17:00:00.000Z" }));

    const resolved = resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.revision).toBe("43");
  });

  it("excludes a source.yaml whose physical provider directory does not match the manifest's own provider field", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const misplacedDir = join(f.workspace, "requirements", "github_issue", "req-c78ccf14ea21");
    mkdirSync(misplacedDir, { recursive: true });
    writeFileSync(join(misplacedDir, "source.yaml"), readFileSync(join(first.requirementPath, "source.yaml")));

    const resolved = resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.ref).toBe("SOT-15499");
  });

  it("excludes a source.yaml whose physical requirementId directory does not match the manifest's derived identity", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    const misplacedDir = join(f.workspace, "requirements", "jira", "req-000000000000");
    mkdirSync(misplacedDir, { recursive: true });
    writeFileSync(join(misplacedDir, "source.yaml"), readFileSync(join(first.requirementPath, "source.yaml")));

    const resolved = resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007");
    expect(resolved).toHaveLength(1);
  });

  it("excludes a source.yaml whose provider/ref is not declared in workspace.yaml", () => {
    const f = fixture();
    captureRequirementSource(request(f));
    const undeclaredRequirementId = `req-${createHash("sha256").update("user_input\0undeclared-brief").digest("hex").slice(0, 12)}`;
    const undeclaredManifest = {
      schema: "roll.requirement-source/v1",
      requirementId: undeclaredRequirementId,
      provider: "user_input",
      ref: "undeclared-brief",
      revision: "1",
      capturedAt: "2026-07-20T16:00:00.000Z",
      previousRevisions: [],
      requirement: { bytes: 1, sha256: "a".repeat(64) },
      context: [],
      stories: ["US-WS-007"],
      attest: { schema: "roll.requirement-attest-projection/v1", mode: "generated_aggregate", evidenceAuthority: "issue" },
    };
    const undeclaredDir = join(f.workspace, "requirements", "user_input", undeclaredRequirementId);
    mkdirSync(undeclaredDir, { recursive: true });
    writeFileSync(join(undeclaredDir, "source.yaml"), `${JSON.stringify(undeclaredManifest, null, 2)}\n`);

    const resolved = resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007");
    expect(resolved.map((manifest) => manifest.ref)).toEqual(["SOT-15499"]);
  });

  it("fails loudly when a canonical declared requirement directory's source.yaml is missing, rather than silently omitting the Story from lookup", () => {
    const f = fixture();
    captureRequirementSource(request(f));
    rmSync(join(f.workspace, "requirements", "jira", "req-c78ccf14ea21", "source.yaml"));

    expect(() => resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007")).toThrowError(
      expect.objectContaining({ code: "io_failure" }),
    );
  });

  it("fails loudly when a canonical declared requirement directory's source.yaml is corrupt JSON, rather than silently omitting the Story from lookup", () => {
    const f = fixture();
    captureRequirementSource(request(f));
    writeFileSync(join(f.workspace, "requirements", "jira", "req-c78ccf14ea21", "source.yaml"), "{ not valid json", "utf8");

    expect(() => resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007")).toThrowError(
      expect.objectContaining({ code: "io_failure" }),
    );
  });

  it("fails loudly when a canonical declared requirement directory's source.yaml fails schema parsing, rather than silently omitting the Story from lookup", () => {
    const f = fixture();
    captureRequirementSource(request(f));
    writeFileSync(join(f.workspace, "requirements", "jira", "req-c78ccf14ea21", "source.yaml"), `${JSON.stringify({ schema: "roll.requirement-source/v2" }, null, 2)}\n`, "utf8");

    expect(() => resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007")).toThrowError(
      expect.objectContaining({ code: "io_failure" }),
    );
  });

  it("still silently skips a misc, non-canonical or undeclared directory even when it has no valid source.yaml", () => {
    const f = fixture();
    captureRequirementSource(request(f));
    const miscDir = join(f.workspace, "requirements", "jira", "not-a-canonical-id");
    mkdirSync(miscDir, { recursive: true });
    writeFileSync(join(miscDir, "notes.txt"), "scratch notes, not a requirement archive\n", "utf8");

    const resolved = resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007");
    expect(resolved.map((manifest) => manifest.ref)).toEqual(["SOT-15499"]);
  });

  it("treats a declared requirement that was never captured (canonical path absent) as a normal empty result, not an error", () => {
    const f = fixture();
    expect(resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007")).toEqual([]);
  });

  it("deduplicates when the same requirementId is legitimately reachable more than once", () => {
    const f = fixture();
    captureRequirementSource(request(f));
    const resolved = resolveRequirementSourcesForStoryOnDisk(f.workspace, "US-WS-007");
    const ids = resolved.map((manifest) => manifest.requirementId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps Issue-owned evidence outside capture and renders every linked Story as pending", () => {
    const f = fixture();
    const evidencePath = join(f.workspace, "issues", "US-WS-007", "evidence", "vitest.txt");
    write(evidencePath, "US-WS-007 issue evidence: 12 passed\n");
    const evidenceBefore = { stat: lstatSync(evidencePath), digest: createHash("sha256").update(readFileSync(evidencePath)).digest("hex") };

    const first = captureRequirementSource(request(f));
    const attest = readFileSync(join(first.requirementPath, "attest.md"), "utf8");
    expect(attest).toContain("Issue-owned evidence remains authoritative");
    expect(attest).toContain("US-WS-007: no evidence captured yet");
    expect(attest).toContain("US-WS-008: no evidence captured yet");
    expect(attest).not.toContain("issues/US-WS-007/evidence");
    expect(attest).not.toContain("12 passed");

    captureRequirementSource(request(f, { storyIds: ["US-WS-009"] }));
    writeFileSync(f.body, "# Jira requirement\n\nRevision 43.\n", "utf8");
    captureRequirementSource(request(f, { revision: "43", capturedAt: "2026-07-20T17:00:00.000Z" }));

    const evidenceAfter = { stat: lstatSync(evidencePath), digest: createHash("sha256").update(readFileSync(evidencePath)).digest("hex") };
    expect(evidenceAfter.stat.ino).toBe(evidenceBefore.stat.ino);
    expect(evidenceAfter.stat.mtimeMs).toBe(evidenceBefore.stat.mtimeMs);
    expect(evidenceAfter.digest).toBe(evidenceBefore.digest);
    expect(readFileSync(evidencePath, "utf8")).toBe("US-WS-007 issue evidence: 12 passed\n");
  });

  it("does not inspect the Issue evidence tree during Requirement capture", async () => {
    const f = fixture();
    write(join(f.workspace, "issues", "US-WS-007", "evidence", "vitest.txt"), "Issue-owned evidence\n");
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
          const normalized = String(args[0]).replaceAll("\\", "/");
          if (normalized.includes("/issues/")) throw new Error(`Issue evidence access trap: ${normalized}`);
          return actual.lstatSync(...args);
        },
      };
    });
    try {
      const isolated = await import("../src/requirement-source-store.js");
      const captured = isolated.captureRequirementSource(request(f));
      expect(captured.outcome).toBe("created");
      expect(readFileSync(join(captured.requirementPath, "attest.md"), "utf8")).toContain("US-WS-007: no evidence captured yet");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("reports all missing current projection files without recreating them during capture", () => {
    const f = fixture();
    const first = captureRequirementSource(request(f));
    writeFileSync(join(first.requirementPath, "requirement.md"), "corrupted body\n", "utf8");
    rmSync(join(first.requirementPath, "context"), { recursive: true, force: true });
    rmSync(join(first.requirementPath, "attest.md"), { force: true });

    expect(() => captureRequirementSource(request(f, { capturedAt: "2030-01-01T00:00:00.000Z" })))
      .toThrowError(expect.objectContaining({ code: "projection_repair_required" }));
    expect(readFileSync(join(first.requirementPath, "requirement.md"), "utf8")).toBe("corrupted body\n");
    expect(existsSync(join(first.requirementPath, "context"))).toBe(false);
    expect(existsSync(join(first.requirementPath, "attest.md"))).toBe(false);
  });

  it("repairs only the mutable projection from a healthy immutable revision and converges", () => {
    const f = fixture();
    const captured = captureRequirementSource(request(f));
    const revision = join(captured.requirementPath, "revisions", readdirSync(join(captured.requirementPath, "revisions"))[0] ?? "missing");
    const immutableBefore = createHash("sha256").update(readFileSync(join(revision, "requirement.md"))).digest("hex");
    writeFileSync(join(captured.requirementPath, "requirement.md"), "projection drift\n", "utf8");

    expect(inspectRequirementProjection({
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: captured.manifest.requirementId,
    }).state).toBe("drift");
    const repairLockOrder: string[] = [];
    expect(repairRequirementProjection({
      rollHome: f.root,
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: captured.manifest.requirementId,
    }, {
      onLockAcquired: (lock) => repairLockOrder.push(lock),
    }).outcome).toBe("repaired");
    expect(repairLockOrder).toEqual(["authority", "requirement"]);
    expect(readFileSync(join(captured.requirementPath, "requirement.md"), "utf8")).toContain("Jira requirement");
    expect(createHash("sha256").update(readFileSync(join(revision, "requirement.md"))).digest("hex")).toBe(immutableBefore);
    expect(repairRequirementProjection({
      rollHome: f.root,
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: captured.manifest.requirementId,
    }).outcome).toBe("reused");
  });

  it("rejects Requirement projection repair while another writer owns Workspace authority", () => {
    const f = fixture();
    const captured = captureRequirementSource(request(f));
    writeFileSync(join(captured.requirementPath, "requirement.md"), "projection drift\n", "utf8");

    withWorkspaceAuthorityLockSync({
      rollHome: f.root,
      workspaceId: "ws-demo",
      operation: "metadata-edit",
    }, () => {
      expect(() => repairRequirementProjection({
        rollHome: f.root,
        workspaceRoot: f.workspace,
        provider: "jira",
        requirementId: captured.manifest.requirementId,
      })).toThrowError(expect.objectContaining<Partial<RequirementSourceStoreError>>({ code: "concurrent_capture" }));
    });
    expect(readFileSync(join(captured.requirementPath, "requirement.md"), "utf8")).toBe("projection drift\n");
  });
});
