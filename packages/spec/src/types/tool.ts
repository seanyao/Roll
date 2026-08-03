/** Tool contracts (Tool Use capability layer). */
import type { JsonSchema } from "./json-schema.js";
import type { WorkspaceExecutionContextV1 } from "./workspace.js";
export type ToolId = string & { readonly __brand?: "ToolId" };

export type ToolKind =
  | "bash"
  | "browser"
  | "filesystem"
  | "git"
  | "github"
  | "mcp"
  | "network"
  | (string & {});

export type ToolRequirement =
  | { kind: "executable"; name: string; optional?: boolean }
  | { kind: "env"; name: string; optional?: boolean }
  | { kind: "service"; name: string; optional?: boolean };

export type ToolRequirementStatus = "ok" | "missing" | "permission-missing" | "stale";

export type ToolRequirementRepair = {
  command: string;
  description?: string;
};

export type ToolRequirementAuthorization = {
  command: string;
  description: string;
};

export type ToolRequirementResolution = {
  requirement: ToolRequirement;
  status: ToolRequirementStatus;
  detail: string;
  repair?: ToolRequirementRepair;
  authorize?: ToolRequirementAuthorization;
};

export type ToolReadinessStatus = "available" | "degraded" | "unavailable";

export type ToolReadiness = {
  toolId: ToolId;
  status: ToolReadinessStatus;
  requirements: readonly ToolRequirementResolution[];
  detail?: string;
  repairCommands?: readonly string[];
};

export type ToolSandbox = {
  allowedPaths?: readonly string[];
  blockedCommands?: readonly string[];
  hardTimeoutSec?: number;
  maxOutputBytes?: number;
  allowedOrigins?: readonly string[];
  headlessOnly?: boolean;
  network?: "inherit" | "blocked" | "restricted";
};

export type ToolRetry = {
  attempts: number;
  backoffMs: number;
};

export type ToolDefaults = {
  enabled?: boolean;
  timeoutMs?: number;
  retry?: ToolRetry;
  sandbox?: ToolSandbox;
  maxInvocationsPerCycle?: number;
};

export type ToolDeclaration = {
  id: ToolId;
  kind: ToolKind;
  title: string;
  description?: string;
  provider?: string;
  protocol?: string;
  platform?: NodeJS.Platform;
  emitsEvents?: boolean;
  defaults?: ToolDefaults;
  requirements?: readonly ToolRequirement[];
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
};

export type ToolCaller = {
  cycleId: string;
  storyId?: string;
  agent?: string;
  segment?: string;
};

export type ToolPolicy = {
  enabled: boolean;
  timeoutMs?: number;
  retry?: ToolRetry;
  sandbox?: ToolSandbox;
  maxInvocationsPerCycle?: number;
};

export type ToolContextCorrelation = {
  workspaceId: string;
  storyId?: string;
  repoId?: string;
};

export type ToolInvocation<I = unknown> = {
  invocationId: string;
  toolId: ToolId;
  input: I;
  caller: ToolCaller;
  policy: ToolPolicy;
  ts: number;
  context?: WorkspaceExecutionContextV1;
  repoId?: string;
};

export type ToolErrorCode =
  | "not_found"
  | "init_failed"
  | "policy_denied"
  | "budget_exhausted"
  | "sandbox_denied"
  | "timeout"
  | "adapter_error"
  | "invalid_input"
  | "missing_execution_context"
  | "invalid_execution_context"
  | "unknown";

export type ToolError = {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  detail?: unknown;
};

export type ToolMeta = {
  invocationId: string;
  toolId: ToolId;
  caller: ToolCaller;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  attempt?: number;
  correlation?: ToolContextCorrelation;
};

export type ToolResult<O = unknown> =
  | { ok: true; output: O; meta: ToolMeta; warnings?: readonly string[] }
  | { ok: false; error: ToolError; meta: ToolMeta; warnings?: readonly string[] };

export type ToolCost = {
  toolId: ToolId;
  correlation?: ToolContextCorrelation;
  invocations: number;
  durationMs?: number;
  failures?: number;
  estimatedCost: number;
  currency: string;
  inputBytes?: number;
  outputBytes?: number;
};

export type ToolEvent =
  | {
      type: "tool:invoke";
      cycleId: string;
      invocation: ToolInvocation;
      declaration: ToolDeclaration;
      ts: number;
    }
  | {
      type: "tool:result";
      cycleId: string;
      invocationId: string;
      toolId: ToolId;
      result: ToolResult;
      ts: number;
    };

export type ExecOpts = {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal?: string;
};

export type MinimalFs = {
  readFile(path: string, encoding?: BufferEncoding): Promise<string>;
  writeFile(path: string, data: string, encoding?: BufferEncoding): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
};

export type ToolDeps = {
  fs: MinimalFs;
  now(): number;
  execFile(command: string, args: readonly string[], opts?: ExecOpts): Promise<ExecResult>;
  redact(value: string): string;
};
