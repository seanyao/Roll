/**
 * @responsibility Declares and runs the filesystem tool adapter.
 */
import { stat as nodeStat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDeclaration, ToolDeps, ToolInvocation, ToolMeta, ToolResult } from "@roll/spec";
import { fsReadInputSchema, fsReadOutputSchema, fsStatInputSchema, fsStatOutputSchema, fsWriteInputSchema, fsWriteOutputSchema } from "./schema-contracts.js";

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
    private readonly projectRoot = process.cwd(),
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
    const target = resolveTarget(this.projectRoot, invocation.input.path);
    if (!isAllowed(target, this.projectRoot, invocation.policy.sandbox?.allowedPaths)) {
      return failure(invocation, startedAt, deps.now(), "policy_denied", `path is outside allowedPaths: ${target}`, false);
    }

    try {
      if (this.id === "filesystem.stat") {
        return ok(invocation, startedAt, deps.now(), await statOutput(target));
      }
      if (this.id === "filesystem.read") {
        return ok(invocation, startedAt, deps.now(), await readOutput(target, invocation.input as FsReadInput, deps));
      }
      return ok(invocation, startedAt, deps.now(), await writeOutput(target, invocation.input as FsWriteInput, deps));
    } catch (cause) {
      return failure(invocation, startedAt, deps.now(), "adapter_error", "filesystem operation failed", true, cause);
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

export function fsTools(projectRoot = process.cwd()): FsTool[] {
  return [new FsTool("filesystem.stat", projectRoot), new FsTool("filesystem.read", projectRoot), new FsTool("filesystem.write", projectRoot)];
}

function resolveTarget(projectRoot: string, path: string): string {
  return resolve(projectRoot, path);
}

function isAllowed(target: string, projectRoot: string, allowedPaths: readonly string[] | undefined): boolean {
  if (allowedPaths === undefined || allowedPaths.length === 0) return true;
  return allowedPaths.some((path) => {
    const root = resolve(projectRoot, path);
    return target === root || target.startsWith(`${root}/`);
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

async function writeOutput(path: string, input: FsWriteInput, deps: ToolDeps): Promise<FsWriteOutput> {
  const content = deps.redact(input.content);
  await deps.fs.mkdir(dirname(path), { recursive: true });
  await deps.fs.writeFile(path, content, "utf8");
  return { bytesWritten: Buffer.byteLength(content, "utf8") };
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
  code: "policy_denied" | "adapter_error",
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
  };
}
