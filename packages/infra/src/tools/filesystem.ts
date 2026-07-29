import { constants } from "node:fs";
import { lstat, open, stat as nodeStat } from "node:fs/promises";
import type { ToolDeclaration, ToolDeps, ToolInvocation, ToolMeta, ToolResult } from "@roll/spec";
import { fsReadInputSchema, fsReadOutputSchema, fsStatInputSchema, fsStatOutputSchema, fsWriteInputSchema, fsWriteOutputSchema } from "./schema-contracts.js";
import { isCanonicalPathContained, resolveContainedPath, resolveWorkspaceLocalRepository } from "./workspace-local-context.js";

export type FsToolId = "filesystem.stat" | "filesystem.read" | "filesystem.write";

export interface FsStatInput {
  path: string;
}

export interface FsStatOutput {
  exists: boolean;
  size: number;
}

export interface FsReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface FsReadOutput {
  content: string;
  totalLines: number;
}

export interface FsWriteInput {
  path: string;
  content: string;
}

export interface FsWriteOutput {
  bytesWritten: number;
}

export interface FsToolFactoryContext {
  root: string;
  access: "read" | "write";
}

type FsInput = FsStatInput | FsReadInput | FsWriteInput;
type FsOutput = FsStatOutput | FsReadOutput | FsWriteOutput;

const TITLES: Record<FsToolId, string> = {
  "filesystem.stat": "Filesystem Stat",
  "filesystem.read": "Filesystem Read",
  "filesystem.write": "Filesystem Write",
};

export class FsTool {
  readonly declaration: ToolDeclaration;

  constructor(
    private readonly id: FsToolId,
    private readonly factoryContext?: FsToolFactoryContext,
  ) {
    this.declaration = {
      id: id as ToolDeclaration["id"],
      kind: "filesystem",
      title: TITLES[id],
      description: "Run governed filesystem operations through the Tool interface.",
      defaults: {
        enabled: true,
        timeoutMs: 30_000,
      },
      inputSchema: fsInputSchema(id),
      outputSchema: fsOutputSchema(id),
    };
  }

  async init(_deps: ToolDeps): Promise<void> {
    return undefined;
  }

  async dispose(_deps: ToolDeps): Promise<void> {
    return undefined;
  }

  async execute(invocation: ToolInvocation<FsInput>, deps: ToolDeps): Promise<ToolResult<FsOutput>> {
    const startedAt = deps.now();
    const access = this.id === "filesystem.write" ? "write" : "read";
    const repository = resolveWorkspaceLocalRepository(invocation, access);
    if (!repository.ok) return failure(invocation, startedAt, deps.now(), repository.code, repository.message, false);
    const boundInvocation = invocation.repoId === undefined
      ? { ...invocation, repoId: repository.repository.repoId }
      : invocation;
    if (!factoryAllows(this.factoryContext, repository.canonicalWorktreePath, access)) {
      return failure(boundInvocation, startedAt, deps.now(), "invalid_execution_context", "filesystem factory capability does not match the selected Issue repository", false);
    }
    const target = resolveContainedPath(repository.canonicalWorktreePath, invocation.input.path, this.id !== "filesystem.read");
    if (target === undefined) {
      return failure(boundInvocation, startedAt, deps.now(), "invalid_execution_context", "filesystem path is outside the selected Issue repository", false);
    }
    if (!isAllowed(target, repository.canonicalWorktreePath, invocation.policy.sandbox?.allowedPaths)) {
      return failure(boundInvocation, startedAt, deps.now(), "policy_denied", "filesystem path is outside allowedPaths", false);
    }

    try {
      if (this.id === "filesystem.stat") {
        return ok(boundInvocation, startedAt, deps.now(), await statOutput(target));
      }
      if (this.id === "filesystem.read") {
        return ok(boundInvocation, startedAt, deps.now(), await readOutput(target, invocation.input as FsReadInput, deps));
      }
      const output = await writeOutput(
        target,
        invocation.input as FsWriteInput,
        repository.canonicalWorktreePath,
        deps,
      );
      return output === undefined
        ? failure(boundInvocation, startedAt, deps.now(), "invalid_execution_context", "filesystem write target must remain an existing regular file", false)
        : ok(boundInvocation, startedAt, deps.now(), output);
    } catch {
      return failure(boundInvocation, startedAt, deps.now(), "adapter_error", "filesystem operation failed", true);
    }
  }
}

function fsInputSchema(id: FsToolId): ToolDeclaration["inputSchema"] {
  if (id === "filesystem.stat") return fsStatInputSchema;
  if (id === "filesystem.read") return fsReadInputSchema;
  return fsWriteInputSchema;
}

function fsOutputSchema(id: FsToolId): ToolDeclaration["outputSchema"] {
  if (id === "filesystem.stat") return fsStatOutputSchema;
  if (id === "filesystem.read") return fsReadOutputSchema;
  return fsWriteOutputSchema;
}

export function fsTools(context?: FsToolFactoryContext): FsTool[] {
  return [new FsTool("filesystem.stat", context), new FsTool("filesystem.read", context), new FsTool("filesystem.write", context)];
}

function factoryAllows(context: FsToolFactoryContext | undefined, repositoryRoot: string, access: "read" | "write"): boolean {
  if (context === undefined) return true;
  const root = resolveContainedPath(repositoryRoot, context.root, false);
  if (root !== repositoryRoot) return false;
  return access === "read" || context.access === "write";
}

function isAllowed(target: string, repositoryRoot: string, allowedPaths: readonly string[] | undefined): boolean {
  if (allowedPaths === undefined || allowedPaths.length === 0) return true;
  return allowedPaths.some((path) => {
    const root = resolveContainedPath(repositoryRoot, path, true);
    return root !== undefined && isCanonicalPathContained(root, target);
  });
}

async function statOutput(path: string): Promise<FsStatOutput> {
  try {
    const stats = await nodeStat(path);
    return { exists: true, size: stats.size };
  } catch (cause) {
    if (isNotFound(cause)) return { exists: false, size: 0 };
    throw cause;
  }
}

async function readOutput(path: string, input: FsReadInput, deps: ToolDeps): Promise<FsReadOutput> {
  const redacted = deps.redact(await deps.fs.readFile(path, "utf8"));
  const offset = Math.max(0, input.offset ?? 0);
  const limit = input.limit;
  const content = limit === undefined ? redacted.slice(offset) : redacted.slice(offset, offset + Math.max(0, limit));
  return {
    content,
    totalLines: countLines(redacted),
  };
}

async function writeOutput(
  path: string,
  input: FsWriteInput,
  repositoryRoot: string,
  deps: ToolDeps,
): Promise<FsWriteOutput | undefined> {
  const content = deps.redact(input.content);
  const revalidated = resolveContainedPath(repositoryRoot, path, true);
  if (revalidated !== path) return undefined;
  return writeAnchoredFile(path, content, repositoryRoot);
}

async function writeAnchoredFile(
  path: string,
  content: string,
  repositoryRoot: string,
): Promise<FsWriteOutput | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
    const descriptorStat = await handle.stat();
    const pathStat = await lstat(path);
    const contained = resolveContainedPath(repositoryRoot, path, true) === path;
    if (
      !contained || !descriptorStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile() ||
      descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino ||
      descriptorStat.nlink !== 1 || pathStat.nlink !== 1
    ) {
      return undefined;
    }
    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
    return { bytesWritten: Buffer.byteLength(content, "utf8") };
  } finally {
    await handle?.close();
  }
}

function countLines(content: string): number {
  if (content === "") return 0;
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (normalized === "") return 0;
  return normalized.split("\n").length;
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: unknown }).code === "ENOENT";
}

function ok(invocation: ToolInvocation<FsInput>, startedAt: number, endedAt: number, output: FsOutput): ToolResult<FsOutput> {
  return {
    ok: true,
    output,
    meta: meta(invocation, startedAt, endedAt),
  };
}

function failure(
  invocation: ToolInvocation<FsInput>,
  startedAt: number,
  endedAt: number,
  code: "policy_denied" | "adapter_error" | "missing_execution_context" | "invalid_execution_context",
  message: string,
  retryable: boolean,
  detail?: unknown,
): ToolResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      detail,
    },
    meta: meta(invocation, startedAt, endedAt),
  };
}

function meta(invocation: ToolInvocation<FsInput>, startedAt: number, endedAt: number): ToolMeta {
  return {
    invocationId: invocation.invocationId,
    toolId: invocation.toolId,
    caller: invocation.caller,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    correlation: invocation.context === undefined
      ? undefined
      : {
          workspaceId: invocation.context.workspace.workspaceId,
          ...(invocation.context.issue?.storyId === undefined ? {} : { storyId: invocation.context.issue.storyId }),
          ...(invocation.repoId === undefined ? {} : { repoId: invocation.repoId }),
        },
  };
}
