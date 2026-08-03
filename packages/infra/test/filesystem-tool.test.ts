import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deriveWorkspaceExecutionAuthorities } from "@roll/core";
import type { MinimalFs, ToolDeps, ToolInvocation, ToolPolicy } from "@roll/spec";
import { REPOSITORY_BINDING_V1, WORKSPACE_EXECUTION_CONTEXT_V1 } from "@roll/spec";
import { afterAll, describe, expect, it } from "vitest";
import {
  FsTool,
  fsTools,
  type FsReadInput,
  type FsReadOutput,
  type FsStatInput,
  type FsStatOutput,
  type FsToolId,
  type FsWriteInput,
  type FsWriteOutput,
} from "../src/index.js";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "roll-fs-tool-")));
  const repoRoot = join(workspaceRoot, "issues", "US-TOOL-008", "repo");
  mkdirSync(repoRoot, { recursive: true });
  dirs.push(workspaceRoot);
  return repoRoot;
}

const policy = (sandbox: ToolPolicy["sandbox"] = {}): ToolPolicy => ({
  enabled: true,
  timeoutMs: 1000,
  sandbox,
});

function invocation<I>(toolId: FsToolId, input: I, root: string, sandbox: ToolPolicy["sandbox"] = {}): ToolInvocation<I> {
  const issueRoot = dirname(root);
  const workspaceRoot = resolve(root, "../../..");
  return {
    invocationId: `inv-${toolId}`,
    toolId: toolId as ToolInvocation<I>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-TOOL-008", agent: "codex" },
    policy: policy(sandbox),
    ts: 100,
    context: {
      schema: WORKSPACE_EXECUTION_CONTEXT_V1,
      workspace: { workspaceId: "roll", root: workspaceRoot, canonicalRoot: workspaceRoot, lifecycle: "active" },
      resolution: { source: "explicit", evidence: [] },
      bindings: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: "repo",
        alias: "repo",
        remote: "git@github.com:example/repo.git",
        integrationBranch: "main",
        provider: "github",
        workflow: { branchPattern: "story/{storyId}", requiredChecks: [] },
      }],
      issue: {
        storyId: "US-TOOL-008",
        manifestPath: join(issueRoot, "manifest.json"),
        execution: {
          workspaceId: "roll",
          issueRoot,
          repositories: {
            repo: {
              repoId: "repo",
              alias: "repo",
              access: "write",
              requiredDelivery: true,
              noChangePolicy: "changes_required",
              workBranch: "roll/roll/US-TOOL-005",
              worktreePath: root,
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              commands: { test: [], integration: [] },
            },
          },
        },
      },
      authorities: deriveWorkspaceExecutionAuthorities(workspaceRoot),
    },
    repoId: "repo",
  };
}

function deps(): ToolDeps {
  const fs: MinimalFs = {
    readFile: async (path, encoding = "utf8") => readFileSync(path, encoding),
    writeFile: async (path, data, encoding = "utf8") => {
      writeFileSync(path, data, encoding);
    },
    mkdir: async (path, opts) => {
      mkdirSync(path, opts);
    },
  };
  return {
    fs,
    now: () => 100,
    execFile: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    redact: (value) => value.replaceAll("SECRET", "[REDACTED]"),
  };
}

describe("US-TOOL-008 FsTool", () => {
  it("exposes stat, read, and write declarations", () => {
    const tools = fsTools({ root: "/repo", access: "write" });

    expect(tools.map((tool) => tool.declaration.id)).toEqual(["filesystem.stat", "filesystem.read", "filesystem.write"]);
    expect(tools.every((tool) => tool.declaration.kind === "filesystem")).toBe(true);
  });

  it("stats existing and missing files", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "exists.txt"), "hello");
    const tool = new FsTool("filesystem.stat", { root, access: "write" });

    const exists = await tool.execute(invocation<FsStatInput>("filesystem.stat", { path: "exists.txt" }, root, { allowedPaths: [root] }), deps());
    const missing = await tool.execute(invocation<FsStatInput>("filesystem.stat", { path: "missing.txt" }, root, { allowedPaths: [root] }), deps());

    expect(exists.ok && (exists.output as FsStatOutput)).toEqual({ exists: true, size: 5 });
    expect(missing.ok && (missing.output as FsStatOutput)).toEqual({ exists: false, size: 0 });
  });

  it("reads files inside allowedPaths and supports offset plus limit", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "data.txt"), "line1\nline2\nline3\n");
    const result = await new FsTool("filesystem.read", { root, access: "read" }).execute(
      invocation<FsReadInput>("filesystem.read", { path: "data.txt", offset: 6, limit: 5 }, root, { allowedPaths: [root] }),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output as FsReadOutput).toEqual({ content: "line2", totalLines: 3 });
  });

  it("rejects reads and writes outside allowedPaths", async () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    writeFileSync(join(outside, "secret.txt"), "nope");

    const read = await new FsTool("filesystem.read", { root, access: "read" }).execute(
      invocation<FsReadInput>("filesystem.read", { path: join(outside, "secret.txt") }, root, { allowedPaths: [root] }),
      deps(),
    );
    const write = await new FsTool("filesystem.write", { root, access: "write" }).execute(
      invocation<FsWriteInput>("filesystem.write", { path: join(outside, "secret.txt"), content: "nope" }, root, { allowedPaths: [root] }),
      deps(),
    );

    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("invalid_execution_context");
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe("invalid_execution_context");
  });

  it("writes redacted content under allowedPaths and reports bytes written", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "out"), { recursive: true });
    writeFileSync(join(root, "out", "result.txt"), "before");
    const result = await new FsTool("filesystem.write", { root, access: "write" }).execute(
      invocation<FsWriteInput>("filesystem.write", { path: "out/result.txt", content: "hello SECRET" }, root, { allowedPaths: [root] }),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output as FsWriteOutput).toEqual({ bytesWritten: 16 });
    expect(readFileSync(join(root, "out", "result.txt"), "utf8")).toBe("hello [REDACTED]");
  });

  it("redacts read output and reports total lines before truncation", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "secret.txt"), "a SECRET\nb\nc\n");
    const result = await new FsTool("filesystem.read", { root, access: "read" }).execute(
      invocation<FsReadInput>("filesystem.read", { path: "secret.txt", limit: 12 }, root, { allowedPaths: [root] }),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output as FsReadOutput).toEqual({ content: "a [REDACTED]", totalLines: 3 });
  });

  it("init and dispose are no-ops", async () => {
    const root = tmpRoot();
    const tool = new FsTool("filesystem.stat", { root, access: "read" });
    const d = deps();

    await expect(tool.init(d)).resolves.toBeUndefined();
    await expect(tool.dispose(d)).resolves.toBeUndefined();
  });
});
