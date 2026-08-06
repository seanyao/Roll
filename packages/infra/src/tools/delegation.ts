/**
 * @responsibility Declares and runs the delegation tool adapter.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { validateJsonSchemaValue } from "@roll/core";
import type {
  ExecOpts,
  ExecResult,
  MinimalFs,
  ToolCaller,
  ToolDeclaration,
  ToolInvocation,
  ToolPolicy,
  ToolResult,
} from "@roll/spec";

const execFileAsync = promisify(nodeExecFile);

export interface InfraToolOptions<I, O> {
  declaration: ToolDeclaration;
  input: I;
  caller?: Partial<ToolCaller>;
  policy?: Partial<ToolPolicy>;
  run(invocation: ToolInvocation<I>): Promise<ToolResult<O>>;
}

export async function invokeInfraTool<I, O>(options: InfraToolOptions<I, O>): Promise<ToolResult<O>> {
  const caller = resolveCaller(options.caller);
  const invocation: ToolInvocation<I> = {
    invocationId: nextInvocationId(options.declaration.id),
    toolId: options.declaration.id,
    input: options.input,
    caller,
    policy: resolvePolicy(options.declaration, options.policy),
    ts: Date.now(),
  };
  const emitEvents = options.declaration.emitsEvents !== false;
  if (emitEvents) {
    await appendToolEvent({
      type: "tool:invoke",
      cycleId: caller.cycleId,
      invocation,
      declaration: options.declaration,
      ts: Date.now(),
    });
  }

  const inputValidation = validateJsonSchemaValue(options.declaration.inputSchema, options.input);
  if (!inputValidation.ok) {
    const result: ToolResult<never> = {
      ok: false,
      error: {
        code: "invalid_input",
        message: `invalid input for ${options.declaration.id}: ${inputValidation.errors.join("; ")}`,
        retryable: false,
        detail: inputValidation.errors,
      },
      meta: {
        invocationId: invocation.invocationId,
        toolId: invocation.toolId,
        caller: invocation.caller,
        startedAt: invocation.ts,
        endedAt: Date.now(),
        durationMs: Math.max(0, Date.now() - invocation.ts),
      },
    };
    if (emitEvents || !result.ok) {
      await appendToolEvent({
        type: "tool:result",
        cycleId: caller.cycleId,
        invocationId: invocation.invocationId,
        toolId: invocation.toolId,
        result: sanitizeResult(result),
        ts: Date.now(),
      });
    }
    return result;
  }

  const result = await options.run(invocation);
  if (emitEvents || !result.ok) {
    await appendToolEvent({
      type: "tool:result",
      cycleId: caller.cycleId,
      invocationId: invocation.invocationId,
      toolId: invocation.toolId,
      result: sanitizeResult(result),
      ts: Date.now(),
    });
  }
  return result;
}

export const infraToolFs: MinimalFs = {
  readFile: (path, encoding = "utf8") => readFile(path, encoding),
  writeFile: (path, data, encoding = "utf8") => writeFile(path, data, encoding),
  mkdir: (path, opts) => mkdir(path, opts).then(() => undefined),
};

export async function infraToolExecFile(command: string, args: readonly string[], opts: ExecOpts = {}): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd: opts.cwd,
      env: opts.env === undefined ? undefined : { ...process.env, ...opts.env },
      encoding: "utf8",
      maxBuffer: opts.maxOutputBytes ?? 64 * 1024 * 1024,
      timeout: opts.timeoutMs,
    });
    return { exitCode: 0, stdout, stderr, timedOut: false };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    if (typeof err.code === "number" || err.stdout !== undefined || err.stderr !== undefined) {
      return {
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        timedOut: err.killed === true && err.signal === "SIGTERM",
        ...(err.signal !== undefined ? { signal: err.signal } : {}),
      };
    }
    throw e;
  }
}

export function redactInfraToolValue(value: string): string {
  return value.replace(/(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, "[REDACTED]");
}

function resolveCaller(overrides: Partial<ToolCaller> | undefined): ToolCaller {
  const cycleId =
    overrides?.cycleId ??
    process.env["ROLL_TOOL_CYCLE_ID"] ??
    process.env["LOOP_CYCLE_ID"] ??
    process.env["ROLL_CYCLE_ID"] ??
    "manual";
  return {
    cycleId,
    ...(overrides?.storyId ?? process.env["ROLL_STORY_ID"] ? { storyId: overrides?.storyId ?? process.env["ROLL_STORY_ID"] } : {}),
    ...(overrides?.agent ?? process.env["ROLL_AGENT"] ? { agent: overrides?.agent ?? process.env["ROLL_AGENT"] } : {}),
    ...(overrides?.segment !== undefined ? { segment: overrides.segment } : {}),
  };
}

function resolvePolicy(declaration: ToolDeclaration, overrides: Partial<ToolPolicy> | undefined): ToolPolicy {
  return {
    enabled: overrides?.enabled ?? declaration.defaults?.enabled ?? true,
    ...(overrides?.timeoutMs ?? declaration.defaults?.timeoutMs ? { timeoutMs: overrides?.timeoutMs ?? declaration.defaults?.timeoutMs } : {}),
    ...(overrides?.retry ?? declaration.defaults?.retry ? { retry: overrides?.retry ?? declaration.defaults?.retry } : {}),
    ...(overrides?.sandbox ?? declaration.defaults?.sandbox ? { sandbox: overrides?.sandbox ?? declaration.defaults?.sandbox } : {}),
    ...(overrides?.maxInvocationsPerCycle ?? declaration.defaults?.maxInvocationsPerCycle
      ? { maxInvocationsPerCycle: overrides?.maxInvocationsPerCycle ?? declaration.defaults?.maxInvocationsPerCycle }
      : {}),
  };
}

function nextInvocationId(toolId: ToolDeclaration["id"]): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${String(toolId).replace(/[^a-z0-9._-]/gi, "-")}-${Date.now()}-${rand}`;
}

async function appendToolEvent(event: unknown): Promise<void> {
  const path = eventPath();
  if (path === undefined) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
}

function eventPath(): string | undefined {
  const direct = (process.env["ROLL_TOOL_EVENTS_PATH"] ?? "").trim();
  if (direct !== "") return direct;
  const runtime = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  if (runtime !== "") return join(runtime, "events.ndjson");
  return undefined;
}

type SanitizedToolResult =
  | { ok: true; meta: ToolResult<unknown>["meta"] }
  | { ok: false; errorCode: string; meta: ToolResult<unknown>["meta"] };

function sanitizeResult(result: ToolResult<unknown>): SanitizedToolResult {
  if (result.ok) return { ok: true, meta: result.meta };
  return { ok: false, errorCode: result.error.code, meta: result.meta };
}
