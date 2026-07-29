import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import { serializeWorkspaceMetadataReferenceIndex } from "@roll/core";
import { repositoryIdFromRemote } from "@roll/spec";
import {
  WorkspaceReferenceIndexError,
  collectWorkspaceMetadataReferenceIndex,
} from "../src/workspace-reference-index.js";

const roots: string[] = [];

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-workspace-reference-index-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const repo = repositoryIdFromRemote("https://example.test/owner/product");
  if (!repo.ok) throw new Error("fixture remote must normalize");
  const manifest = {
    schema: "roll.workspace/v1",
    workspaceId: "ws-demo",
    displayName: "Demo",
    requirements: [{ provider: "jira", ref: "SOT-15499" }],
    repositories: [{
      schema: "roll.repository-binding/v1",
      repoId: repo.value,
      alias: "product",
      remote: "https://example.test/owner/product",
      integrationBranch: "main",
      provider: "github",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: ["test"] },
    }],
  };
  write(join(workspace, "workspace.yaml"), manifest);
  const issue = (storyId: string, requirementRef: string) => ({
    schema: "roll.issue/v1",
    workspaceId: "ws-demo",
    storyId,
    requirements: [{ provider: "jira", ref: requirementRef }],
    repositories: [{
      repoId: repo.value,
      alias: "product",
      access: "write",
      requiredDelivery: true,
      noChangePolicy: "changes_required",
    }],
  });
  write(join(workspace, "issues", "US-B", "manifest.json"), issue("US-B", "SOT-15499"));
  write(join(workspace, "issues", "US-A", "manifest.json"), issue("US-A", "sot-15499"));
  const source = {
    schema: "roll.requirement-source/v1",
    requirementId: "req-c78ccf14ea21",
    provider: "jira",
    ref: "SOT-15499",
    revision: "7",
    capturedAt: "2026-07-24T00:00:00.000Z",
    previousRevisions: [],
    requirement: { bytes: 4, sha256: digest("body") },
    context: [],
    stories: ["US-A", "US-B"],
    attest: {
      schema: "roll.requirement-attest-projection/v1",
      mode: "generated_aggregate",
      evidenceAuthority: "issue",
    },
  };
  write(join(workspace, "requirements", "jira", source.requirementId, "source.yaml"), source);
  return { root, workspace, repoId: repo.value, source };
}

function snapshot(root: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const stat = lstatSync(path);
      result.set(relative, JSON.stringify({
        kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        digest: stat.isFile() ? digest(readFileSync(path, "utf8")) : "",
      }));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, relative);
    }
  };
  walk(root, "");
  return result;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-WS-025 Workspace metadata reference index", () => {
  it("collects every Issue and Requirement archive deterministically with zero writes", () => {
    const f = fixture();
    const before = snapshot(f.workspace);

    const first = collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace });
    const second = collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace });

    expect(first).toEqual(second);
    expect(serializeWorkspaceMetadataReferenceIndex(first)).toBe(serializeWorkspaceMetadataReferenceIndex(second));
    expect(first).toEqual({
      schema: "roll.workspace-metadata-reference-index/v1",
      workspaceId: "ws-demo",
      issues: [
        {
          storyId: "US-A",
          manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          requirementKeys: [{ provider: "jira", ref: "SOT-15499" }],
          repoIds: [f.repoId],
        },
        {
          storyId: "US-B",
          manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          requirementKeys: [{ provider: "jira", ref: "SOT-15499" }],
          repoIds: [f.repoId],
        },
      ],
      requirementArchives: [{
        requirementId: f.source.requirementId,
        source: { provider: "jira", ref: "SOT-15499" },
        manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }],
      additionalFacts: [],
    });
    expect(snapshot(f.workspace)).toEqual(before);
  });

  it("indexes delivery, runtime, event and migration authorities with deterministic references and digests", () => {
    const f = fixture();
    const delivery = {
      type: "issue:repository_merge_evidence_recorded",
      workspaceId: "ws-demo",
      storyId: "US-A",
      repoId: f.repoId,
      provider: "jira",
      ref: "sot-15499",
    };
    const event = {
      type: "issue:repository_bound",
      workspaceId: "ws-demo",
      storyId: "US-A",
      repoId: f.repoId,
      requirement: { provider: "jira", ref: "SOT-15499" },
    };
    writeText(join(f.workspace, "issues", "US-A", "events.jsonl"), `${JSON.stringify(delivery)}\n${JSON.stringify(event)}\n`);
    const runtime = { runs: [{ storyId: "US-A", repoId: f.repoId, requirement: { provider: "jira", ref: "SOT-15499" } }] };
    write(join(f.workspace, "runtime", "runs.json"), runtime);
    const migration = {
      schema: "roll.workspace-migration-manifest/v1",
      planId: "plan-1",
      sourceRoot: "/redacted/source",
      workspaceId: "ws-demo",
      repoId: f.repoId,
      ownership: "ordinary",
      state: "active",
      mappings: [],
      manualHandoffRequired: false,
    };
    write(join(f.workspace, "migration-manifest.json"), migration);

    const index = collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace });

    expect(index.additionalFacts).toEqual([
      {
        kind: "delivery",
        authorityPath: "issues/US-A/events.jsonl",
        sha256: digest(`${JSON.stringify(delivery)}\n`),
        requirementKeys: [{ provider: "jira", ref: "SOT-15499" }],
        repoIds: [f.repoId],
      },
      {
        kind: "event",
        authorityPath: "issues/US-A/events.jsonl",
        sha256: digest(`${JSON.stringify(event)}\n`),
        requirementKeys: [{ provider: "jira", ref: "SOT-15499" }],
        repoIds: [f.repoId],
      },
      {
        kind: "migration",
        authorityPath: "migration-manifest.json",
        sha256: digest(`${JSON.stringify(migration, null, 2)}\n`),
        requirementKeys: [],
        repoIds: [f.repoId],
      },
      {
        kind: "runtime",
        authorityPath: "runtime/runs.json",
        sha256: digest(`${JSON.stringify(runtime, null, 2)}\n`),
        requirementKeys: [{ provider: "jira", ref: "SOT-15499" }],
        repoIds: [f.repoId],
      },
    ]);
    const serialized = serializeWorkspaceMetadataReferenceIndex(index);
    expect(serialized).toBe(serializeWorkspaceMetadataReferenceIndex(collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace })));
    expect(digest(serialized)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ["delivery", "runtime/deliveries.jsonl"],
    ["runtime", "runtime/runs.jsonl"],
    ["event", "runtime/events.ndjson"],
    ["migration", "migration-manifest.json"],
  ])("fails closed when a %s authority is corrupt", (_kind, relativePath) => {
    const f = fixture();
    writeText(join(f.workspace, relativePath), "{not-json}\n");
    expect(() => collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace }))
      .toThrowError(expect.objectContaining({ code: "invalid_additional_fact" }));
  });

  it.each([
    ["delivery", "runtime/deliveries.jsonl"],
    ["runtime", "runtime/runs.jsonl"],
    ["event", "runtime/events.ndjson"],
    ["migration", "migration-manifest.json"],
  ])("rejects a symlinked %s authority without following the file", (_kind, relativePath) => {
    const f = fixture();
    const outside = join(f.root, `${_kind}.json`);
    writeText(outside, "{}\n");
    const target = join(f.workspace, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(outside, target);
    expect(() => collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace }))
      .toThrowError(expect.objectContaining({ code: "unsafe_authority_path" }));
  });

  it("rejects an oversized additional authority instead of returning a partial index", () => {
    const f = fixture();
    writeText(join(f.workspace, "runtime", "runs.jsonl"), "x".repeat(4 * 1024 * 1024 + 1));
    expect(() => collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace }))
      .toThrowError(expect.objectContaining({ code: "authority_too_large" }));
  });

  it.each([
    ["missing Issue manifest", (f: ReturnType<typeof fixture>) => rmSync(join(f.workspace, "issues", "US-A", "manifest.json")), "invalid_issue"],
    ["corrupt Requirement archive", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.workspace, "requirements", "jira", f.source.requirementId, "source.yaml"), "{}\n"), "invalid_requirement_archive"],
  ])("fails loud for %s instead of returning a partial safe-looking index", (_name, mutate, code) => {
    const f = fixture();
    mutate(f);
    expect(() => collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace })).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it.each([
    ["provider directory", (f: ReturnType<typeof fixture>) => {
      const target = join(f.workspace, "requirements", "jira");
      const outside = join(f.root, "outside-provider");
      renameSync(target, outside);
      symlinkSync(outside, target, "dir");
    }],
    ["Requirement directory", (f: ReturnType<typeof fixture>) => {
      const target = join(f.workspace, "requirements", "jira", f.source.requirementId);
      const outside = join(f.root, "outside-requirement");
      renameSync(target, outside);
      symlinkSync(outside, target, "dir");
    }],
    ["source.yaml", (f: ReturnType<typeof fixture>) => {
      const target = join(f.workspace, "requirements", "jira", f.source.requirementId, "source.yaml");
      const outside = join(f.root, "outside-source.yaml");
      renameSync(target, outside);
      symlinkSync(outside, target, "file");
    }],
  ] as const)("rejects a symlinked Requirement archive %s without following it", (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() => collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace }))
      .toThrowError(expect.objectContaining({ code: "unsafe_authority_path" }));
  });

  it("rejects a symlinked authority path without following it", () => {
    const f = fixture();
    const outside = join(f.root, "outside.json");
    write(outside, {
      schema: "roll.issue/v1",
      workspaceId: "ws-demo",
      storyId: "US-EVIL",
      requirements: [],
      repositories: [],
    });
    symlinkSync(outside, join(f.workspace, "issues", "US-EVIL"));

    let error: unknown;
    try {
      collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspaceReferenceIndexError);
    expect(error).toMatchObject({ code: "unsafe_authority_path" });
  });

  it("rejects an authority file that changes during the bounded read", () => {
    const f = fixture();
    let changed = false;
    expect(() => collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspace }, {
      afterRead: (path) => {
        if (path.endsWith("/issues/US-A/manifest.json") && !changed) {
          changed = true;
          writeFileSync(path, `${readFileSync(path, "utf8")} `, "utf8");
        }
      },
    })).toThrowError(expect.objectContaining({ code: "authority_changed_during_read" }));
  });
});
