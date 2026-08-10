import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MinimalFs, ToolDeps, ToolInvocation, ToolPolicy } from "@roll/spec";
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
  const dir = mkdtempSync(join(tmpdir(), "roll-fs-tool-"));
  dirs.push(dir);
  return dir;
}

const policy = (sandbox: ToolPolicy["sandbox"] = {}): ToolPolicy => ({
  enabled: true,
  timeoutMs: 1000,
  sandbox,
});

function invocation<I>(toolId: FsToolId, input: I, sandbox: ToolPolicy["sandbox"] = {}): ToolInvocation<I> {
  return {
    invocationId: `inv-${toolId}`,
    toolId: toolId as ToolInvocation<I>["toolId"],
    input,
    caller: { cycleId: "cycle-1", storyId: "US-TOOL-008", agent: "codex" },
    policy: policy(sandbox),
    ts: 100,
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
    const tools = fsTools("/repo");

    expect(tools.map((tool) => tool.declaration.id)).toEqual(["filesystem.stat", "filesystem.read", "filesystem.write"]);
    expect(tools.every((tool) => tool.declaration.kind === "filesystem")).toBe(true);
  });

  it("stats existing and missing files", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "exists.txt"), "hello");
    const tool = new FsTool("filesystem.stat", root);

    const exists = await tool.execute(invocation<FsStatInput>("filesystem.stat", { path: "exists.txt" }, { allowedPaths: [root] }), deps());
    const missing = await tool.execute(invocation<FsStatInput>("filesystem.stat", { path: "missing.txt" }, { allowedPaths: [root] }), deps());

    expect(exists.ok && (exists.output as FsStatOutput)).toEqual({ exists: true, size: 5 });
    expect(missing.ok && (missing.output as FsStatOutput)).toEqual({ exists: false, size: 0 });
  });

  it("reads files inside allowedPaths and supports offset plus limit", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "data.txt"), "line1\nline2\nline3\n");
    const result = await new FsTool("filesystem.read", root).execute(
      invocation<FsReadInput>("filesystem.read", { path: "data.txt", offset: 6, limit: 5 }, { allowedPaths: [root] }),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output as FsReadOutput).toEqual({ content: "line2", totalLines: 3 });
  });

  it("rejects reads and writes outside allowedPaths", async () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    writeFileSync(join(outside, "secret.txt"), "nope");

    const read = await new FsTool("filesystem.read", root).execute(
      invocation<FsReadInput>("filesystem.read", { path: join(outside, "secret.txt") }, { allowedPaths: [root] }),
      deps(),
    );
    const write = await new FsTool("filesystem.write", root).execute(
      invocation<FsWriteInput>("filesystem.write", { path: join(outside, "secret.txt"), content: "nope" }, { allowedPaths: [root] }),
      deps(),
    );

    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("policy_denied");
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe("policy_denied");
  });

  it("writes redacted content under allowedPaths and reports bytes written", async () => {
    const root = tmpRoot();
    const result = await new FsTool("filesystem.write", root).execute(
      invocation<FsWriteInput>("filesystem.write", { path: "out/result.txt", content: "hello SECRET" }, { allowedPaths: [root] }),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output as FsWriteOutput).toEqual({ bytesWritten: 16 });
    expect(readFileSync(join(root, "out", "result.txt"), "utf8")).toBe("hello [REDACTED]");
  });

  it("redacts read output and reports total lines before truncation", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "secret.txt"), "a SECRET\nb\nc\n");
    const result = await new FsTool("filesystem.read", root).execute(
      invocation<FsReadInput>("filesystem.read", { path: "secret.txt", limit: 12 }, { allowedPaths: [root] }),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output as FsReadOutput).toEqual({ content: "a [REDACTED]", totalLines: 3 });
  });

  it("init and dispose are no-ops", async () => {
    const tool = new FsTool("filesystem.stat", tmpRoot());
    const d = deps();

    await expect(tool.init(d)).resolves.toBeUndefined();
    await expect(tool.dispose(d)).resolves.toBeUndefined();
  });
});
