import { createHash } from "node:crypto";
import {
  cpSync,
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
import { afterEach, describe, expect, it } from "vitest";
import { requirementRevisionKey } from "@roll/core";
import { auditRequirementArchive } from "../src/requirement-archive-audit.js";
import { captureRequirementSource } from "../src/requirement-source-store.js";

const roots: string[] = [];

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-requirement-audit-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  write(join(workspace, "workspace.yaml"), `${JSON.stringify({
    schema: "roll.workspace/v1",
    workspaceId: "ws-audit",
    displayName: "Audit",
    requirements: [{ provider: "jira", ref: "SOT-15499" }],
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
  write(join(workspace, "backlog", "epic", "US-WS-007a", "spec.md"), "# US-WS-007a\n");
  write(join(workspace, "backlog", "epic", "US-WS-LINKED", "spec.md"), "# US-WS-LINKED\n");
  const body = join(root, "requirement.md");
  const contextRoot = join(root, "context-source");
  write(body, "revision 6 body\n");
  write(join(contextRoot, "api.md"), "revision 6 context\n");
  write(join(contextRoot, "brief", "nested", "rules.md"), "revision 6 rules\n");
  const first = captureRequirementSource({
    rollHome: root,
    workspaceRoot: workspace,
    provider: "jira",
    ref: "SOT-15499",
    revision: "6",
    capturedAt: "2026-07-20T16:00:00.000Z",
    bodyFile: body,
    contextRoot,
    contextPaths: ["api.md", "brief/nested/rules.md"],
    storyIds: ["US-WS-007a"],
  });
  write(body, "revision 7 body\n");
  write(join(contextRoot, "api.md"), "revision 7 context\n");
  write(join(contextRoot, "brief", "nested", "rules.md"), "revision 7 rules\n");
  const current = captureRequirementSource({
    rollHome: root,
    workspaceRoot: workspace,
    provider: "jira",
    ref: "SOT-15499",
    revision: "7",
    capturedAt: "2026-07-20T17:00:00.000Z",
    bodyFile: body,
    contextRoot,
    contextPaths: ["api.md", "brief/nested/rules.md"],
    storyIds: ["US-WS-007a"],
  });
  return {
    root,
    workspace,
    body,
    contextRoot,
    requirementPath: current.requirementPath,
    auditInput: { workspaceRoot: workspace, provider: "jira", requirementId: current.manifest.requirementId },
  };
}

function snapshotTree(root: string): ReadonlyMap<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const stat = lstatSync(path);
      const digest = stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "";
      snapshot.set(relativePath, JSON.stringify({
        type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        digest,
      }));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, relativePath);
    }
  };
  walk(root, "");
  return snapshot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-WS-007a Requirement archive v1 declared-consistency audit", () => {
  it("accepts a public create-to-linked flow without requiring immutable capture stories to be rewritten", () => {
    const f = fixture();

    const linked = captureRequirementSource({
      rollHome: f.root,
      workspaceRoot: f.workspace,
      provider: "jira",
      ref: "SOT-15499",
      revision: "7",
      capturedAt: "2030-01-01T00:00:00.000Z",
      bodyFile: f.body,
      contextRoot: f.contextRoot,
      contextPaths: ["api.md", "brief/nested/rules.md"],
      storyIds: ["US-WS-LINKED"],
    });

    expect(linked.outcome).toBe("linked");
    expect(linked.manifest.stories).toEqual(["US-WS-007a", "US-WS-LINKED"]);
    expect(auditRequirementArchive(f.auditInput)).toMatchObject({
      status: "healthy",
      checkedRevisions: ["7", "6"],
      findings: [],
    });

    // source.yaml.stories is mutable Story-link authority. The archived copy is
    // historical projection data, not an immutable trust anchor for the archive.
    const sourcePath = join(f.requirementPath, "source.yaml");
    const source = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    source["stories"] = ["US-WS-RELINKED"];
    writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
    expect(auditRequirementArchive(f.auditInput)).toMatchObject({
      status: "healthy",
      checkedRevisions: ["7", "6"],
      findings: [],
    });
  });

  it("validates the complete immutable revision graph without reading projections or Issue evidence", () => {
    const f = fixture();
    writeFileSync(join(f.requirementPath, "requirement.md"), "drifted projection\n", "utf8");
    write(join(f.workspace, "issues", "US-WS-007a", "evidence", "repositories", "secret.txt"), "not archive authority\n");
    const before = snapshotTree(f.workspace);

    const first = auditRequirementArchive(f.auditInput);
    const second = auditRequirementArchive(f.auditInput);

    expect(first).toEqual({
      schema: "roll.requirement-archive-audit/v1",
      requirementId: "req-c78ccf14ea21",
      status: "healthy",
      checkedRevisions: ["7", "6"],
      findings: [],
    });
    expect(second).toEqual(first);
    expect(snapshotTree(f.workspace)).toEqual(before);
  });

  it("ignores undeclared archive entries because trust is driven only by manifest descriptors", () => {
    const f = fixture();
    const outside = join(f.root, "outside-undeclared");
    write(join(outside, "secret.md"), "undeclared outside content\n");
    symlinkSync(
      join(outside, "secret.md"),
      join(f.requirementPath, "revisions", requirementRevisionKey("6"), "context", "undeclared.md"),
    );
    symlinkSync(outside, join(f.requirementPath, "revisions", "rev-undeclared"));

    // Neither path is declared by source.yaml or an immutable capture descriptor,
    // so the archive auditor must not enumerate or follow either one.
    expect(auditRequirementArchive(f.auditInput)).toMatchObject({
      status: "healthy",
      checkedRevisions: ["7", "6"],
      findings: [],
    });
  });

  it.each([
    {
      name: "missing revision directory",
      mutate: (f: ReturnType<typeof fixture>) => rmSync(join(f.requirementPath, "revisions", requirementRevisionKey("6")), { recursive: true }),
      expected: { code: "revision_missing", revision: "6", suffix: `revisions/${requirementRevisionKey("6")}` },
    },
    {
      name: "body digest mismatch",
      mutate: (f: ReturnType<typeof fixture>) => writeFileSync(join(f.requirementPath, "revisions", requirementRevisionKey("6"), "requirement.md"), "tampered body\n"),
      expected: { code: "content_digest_mismatch", revision: "6", suffix: `revisions/${requirementRevisionKey("6")}/requirement.md` },
    },
    {
      name: "context digest mismatch",
      mutate: (f: ReturnType<typeof fixture>) => writeFileSync(join(f.requirementPath, "revisions", requirementRevisionKey("6"), "context", "api.md"), "tampered context\n"),
      expected: { code: "context_digest_mismatch", revision: "6", suffix: `revisions/${requirementRevisionKey("6")}/context/api.md` },
    },
    {
      name: "capture metadata mismatch",
      mutate: (f: ReturnType<typeof fixture>) => {
        const path = join(f.requirementPath, "revisions", requirementRevisionKey("6"), "capture.yaml");
        const capture = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        capture["capturedAt"] = "2099-01-01T00:00:00.000Z";
        writeFileSync(path, `${JSON.stringify(capture, null, 2)}\n`);
      },
      expected: { code: "revision_metadata_mismatch", revision: "6", suffix: `revisions/${requirementRevisionKey("6")}/capture.yaml` },
    },
  ])("reports $name with its revision and relative evidence path", ({ mutate, expected }) => {
    const f = fixture();
    mutate(f);

    const result = auditRequirementArchive(f.auditInput);

    expect(result.status).toBe("corrupt");
    expect(result.checkedRevisions).toEqual(["7", "6"]);
    expect(result.findings).toContainEqual({
      code: expected.code,
      revision: expected.revision,
      evidencePath: expected.suffix,
    });
  });

  it.each([
    ["unsupported capture schema", (capture: Record<string, unknown>) => { capture["schema"] = "roll.requirement-source/v2"; }],
    ["invalid capture identity", (capture: Record<string, unknown>) => { capture["requirementId"] = "req-000000000000"; }],
  ])("maps %s to an untrusted manifest finding", (_name, mutate) => {
    const f = fixture();
    const evidencePath = `revisions/${requirementRevisionKey("6")}/capture.yaml`;
    const capturePath = join(f.requirementPath, evidencePath);
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
    mutate(capture);
    writeFileSync(capturePath, `${JSON.stringify(capture, null, 2)}\n`);

    expect(auditRequirementArchive(f.auditInput)).toMatchObject({
      status: "untrusted",
      findings: [{
        code: "manifest_invalid",
        revision: "6",
        evidencePath,
      }],
    });
  });

  it.each([
    {
      name: "Requirement root",
      plant: (f: ReturnType<typeof fixture>, outside: string) => {
        const parked = `${f.requirementPath}.parked`;
        renameSync(f.requirementPath, parked);
        symlinkSync(outside, f.requirementPath);
      },
      evidencePath: ".",
    },
    {
      name: "revision directory",
      plant: (f: ReturnType<typeof fixture>, outside: string) => {
        const revision = join(f.requirementPath, "revisions", requirementRevisionKey("6"));
        rmSync(revision, { recursive: true });
        symlinkSync(outside, revision);
      },
      evidencePath: `revisions/${requirementRevisionKey("6")}`,
    },
    {
      name: "nested context entry",
      plant: (f: ReturnType<typeof fixture>, outside: string) => {
        const target = join(f.requirementPath, "revisions", requirementRevisionKey("6"), "context", "api.md");
        rmSync(target);
        symlinkSync(join(outside, "secret.md"), target);
      },
      evidencePath: `revisions/${requirementRevisionKey("6")}/context/api.md`,
    },
  ])("never follows a symlink planted at the $name", ({ plant, evidencePath }) => {
    const f = fixture();
    const outside = join(f.root, "outside");
    write(join(outside, "secret.md"), "outside secret\n");
    plant(f, outside);

    const result = auditRequirementArchive(f.auditInput);

    expect(result.status).toBe("untrusted");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "unsafe_archive_path",
      evidencePath,
    }));
  });

  it("emits one revision-qualified finding for an expected revision path that becomes unsafe", () => {
    const f = fixture();
    const revisionPath = join(f.requirementPath, "revisions", requirementRevisionKey("6"));
    const outside = join(f.root, "outside-revision");
    mkdirSync(outside);
    rmSync(revisionPath, { recursive: true });
    symlinkSync(outside, revisionPath);

    const result = auditRequirementArchive(f.auditInput);

    expect(result.findings.filter((finding) => finding.evidencePath === `revisions/${requirementRevisionKey("6")}`)).toEqual([{
      code: "unsafe_archive_path",
      revision: "6",
      evidencePath: `revisions/${requirementRevisionKey("6")}`,
    }]);
  });

  it.each([
    ["revision count", { maxRevisions: 1 }, "source.yaml"],
    ["revision directory entries", { maxRevisionEntries: 1 }, "revisions"],
    ["context file count", { maxContextFiles: 1 }, expect.stringContaining("/context")],
    ["context directory entries", { maxContextEntries: 1 }, expect.stringContaining("/context")],
    ["context bytes", { maxContextBytes: 5 }, expect.stringContaining("/context/")],
    ["body bytes", { maxBodyBytes: 5 }, expect.stringContaining("/requirement.md")],
    ["context depth", { maxDepth: 1 }, expect.stringContaining("/context/brief/nested")],
  ])("stops at the declared %s bound", (_name, limits, evidencePath) => {
    const f = fixture();

    const result = auditRequirementArchive({ ...f.auditInput, limits });

    expect(result.status).toBe("untrusted");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "unsafe_archive_path",
      evidencePath,
    }));
  });

  it("rejects an in-place same-size archive overwrite during a no-follow read", () => {
    const f = fixture();
    const target = join(f.requirementPath, "revisions", requirementRevisionKey("6"), "context", "api.md");
    const size = readFileSync(target).byteLength;
    let raced = false;

    const result = auditRequirementArchive(f.auditInput, {
      afterReadFile: (path) => {
        if (path !== target || raced) return;
        raced = true;
        writeFileSync(path, `${"x".repeat(size - 1)}\n`);
      },
    });

    expect(raced).toBe(true);
    expect(result.status).toBe("untrusted");
    expect(result.findings).toContainEqual({
      code: "archive_changed_during_read",
      revision: "6",
      evidencePath: `revisions/${requirementRevisionKey("6")}/context/api.md`,
    });
  });

  it("stops a file that grows beyond its byte budget after fstat without completing the read", () => {
    const f = fixture();
    const target = join(f.requirementPath, "revisions", requirementRevisionKey("6"), "requirement.md");
    const completedReads: string[] = [];
    let grew = false;

    const result = auditRequirementArchive({ ...f.auditInput, limits: { maxBodyBytes: 32 } }, {
      afterStatFile: (path) => {
        if (path !== target || grew) return;
        grew = true;
        writeFileSync(path, "x".repeat(33));
      },
      afterReadFile: (path) => completedReads.push(path),
    });

    expect(grew).toBe(true);
    expect(completedReads).not.toContain(target);
    expect(result.status).toBe("untrusted");
    expect(result.findings).toContainEqual({
      code: "unsafe_archive_path",
      revision: "6",
      evidencePath: `revisions/${requirementRevisionKey("6")}/requirement.md`,
    });
  });

  it("rejects a stale fd when its pathname is swapped for an outside symlink", () => {
    const f = fixture();
    const target = join(f.requirementPath, "revisions", requirementRevisionKey("6"), "requirement.md");
    const outside = join(f.root, "outside-body.md");
    write(outside, "outside secret\n");
    let swapped = false;

    const result = auditRequirementArchive(f.auditInput, {
      afterReadFile: (path) => {
        if (path !== target || swapped) return;
        swapped = true;
        renameSync(target, `${target}.parked`);
        symlinkSync(outside, target);
      },
    });

    expect(swapped).toBe(true);
    expect(result.status).toBe("untrusted");
    expect(result.findings).toContainEqual({
      code: "archive_changed_during_read",
      revision: "6",
      evidencePath: `revisions/${requirementRevisionKey("6")}/requirement.md`,
    });
  });

  it("does not follow a directory swapped to an outside symlink between lstat and anchored open", () => {
    const f = fixture();
    const relative = `revisions/${requirementRevisionKey("6")}/context/brief/nested`;
    const target = join(f.requirementPath, relative);
    const parked = `${target}.parked`;
    const outside = join(f.root, "outside-directory-race");
    write(join(outside, "secret.md"), "outside secret must not be enumerated\n");
    let swapped = false;

    const result = auditRequirementArchive(f.auditInput, {
      beforeOpenDirectory: (path) => {
        if (path !== target || swapped) return;
        swapped = true;
        renameSync(target, parked);
        symlinkSync(outside, target);
      },
    });

    expect(swapped).toBe(true);
    expect(result.status).toBe("untrusted");
    expect(result.findings).toContainEqual({
      code: "archive_changed_during_read",
      revision: "6",
      evidencePath: relative,
    });
  });

  it("rejects source.yaml changing after the revision scan starts", () => {
    const f = fixture();
    const sourcePath = join(f.requirementPath, "source.yaml");
    const trigger = join(f.requirementPath, "revisions", requirementRevisionKey("7"), "requirement.md");
    let changed = false;

    const result = auditRequirementArchive(f.auditInput, {
      afterReadFile: (path) => {
        if (path !== trigger || changed) return;
        changed = true;
        const source = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
        source["stories"] = ["US-WS-007a", "US-WS-RACE"];
        writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
      },
    });

    expect(changed).toBe(true);
    expect(result.status).toBe("untrusted");
    expect(result.findings).toContainEqual({
      code: "archive_changed_during_read",
      evidencePath: "source.yaml",
    });
  });

  it.each([
    ["revision", "", `revisions/${requirementRevisionKey("7")}`],
    ["context root", "context", `revisions/${requirementRevisionKey("7")}/context`],
    ["context ancestor", "context/brief", `revisions/${requirementRevisionKey("7")}/context/brief`],
  ])("rejects a declared %s atomically replaced after its files were read", (_name, suffix, evidencePath) => {
    const f = fixture();
    const revision = "7";
    const target = join(f.requirementPath, "revisions", requirementRevisionKey(revision), suffix);
    const replacement = join(f.root, "replacement-directory");
    cpSync(target, replacement, { recursive: true });
    const trigger = join(f.requirementPath, "revisions", requirementRevisionKey("6"), "capture.yaml");
    let replaced = false;

    const result = auditRequirementArchive(f.auditInput, {
      afterReadFile: (path) => {
        if (path !== trigger || replaced) return;
        replaced = true;
        renameSync(target, `${target}.parked`);
        renameSync(replacement, target);
      },
    });

    expect(replaced).toBe(true);
    expect(result.status).toBe("untrusted");
    expect(result.findings).toContainEqual({
      code: "archive_changed_during_read",
      revision,
      evidencePath,
    });
  });

  it.each([
    ["unsupported schema", (source: Record<string, unknown>) => { source["schema"] = "roll.requirement-source/v2"; }],
    ["identity mismatch", (source: Record<string, unknown>) => { source["requirementId"] = "req-000000000000"; }],
  ])("treats %s as an untrusted manifest", (_name, mutate) => {
    const f = fixture();
    const sourcePath = join(f.requirementPath, "source.yaml");
    const source = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    mutate(source);
    writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);

    expect(auditRequirementArchive(f.auditInput)).toMatchObject({
      status: "untrusted",
      checkedRevisions: [],
      findings: [{ code: "manifest_invalid", evidencePath: "source.yaml" }],
    });
  });

  it("fails closed on invalid bounds instead of silently replacing caller policy with defaults", () => {
    const f = fixture();

    expect(auditRequirementArchive({ ...f.auditInput, limits: { maxDepth: 0 } })).toMatchObject({
      status: "untrusted",
      findings: [{ code: "unsafe_archive_path", evidencePath: "." }],
    });
  });

  it("returns a typed untrusted audit when the Workspace root cannot be anchored", () => {
    const f = fixture();
    const missingWorkspace = join(f.root, "missing-workspace");

    expect(auditRequirementArchive({ ...f.auditInput, workspaceRoot: missingWorkspace })).toMatchObject({
      status: "untrusted",
      findings: [{ code: "unsafe_archive_path", evidencePath: "." }],
    });
  });
});
