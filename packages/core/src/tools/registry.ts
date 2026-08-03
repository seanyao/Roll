import type {
  ToolCost,
  ToolContextCorrelation,
  ToolDeclaration,
  ToolDeps,
  ToolError,
  ToolEvent,
  ToolId,
  ToolInvocation,
  ToolMeta,
  ToolPolicy,
  ToolRequirement,
  ToolRequirementResolution,
  ToolResult,
  WorkspaceExecutionContextV1,
} from "@roll/spec";
import { deriveToolReadiness, type ToolRequirementResolver } from "./readiness.js";
import { validateJsonSchemaValue } from "./schema.js";

export interface Tool<I = unknown, O = unknown> {
  readonly declaration: ToolDeclaration;
  init(deps: ToolDeps): Promise<void>;
  execute(invocation: ToolInvocation<I>, deps: ToolDeps): Promise<ToolResult<O>>;
  dispose(deps: ToolDeps): Promise<void>;
}

export interface ToolRegistryPolicyEngine {
  resolve(toolId: ToolId, defaults: ToolDeclaration["defaults"]): Promise<ToolPolicy> | ToolPolicy;
}

export interface ToolRegistryEventSink {
  emit(event: ToolEvent): Promise<void> | void;
}

export interface ToolInvokeRequest<I = unknown> {
  invocationId: string;
  input: I;
  caller: Omit<ToolInvocation<I>["caller"], "cycleId"> & { cycleId?: string };
  context?: WorkspaceExecutionContextV1;
  repoId?: string;
}

export interface ToolRegistryOptions {
  deps: ToolDeps;
  policyEngine: ToolRegistryPolicyEngine;
  requirementResolver?: ToolRequirementResolver;
  events?: ToolRegistryEventSink;
  currency?: string;
}

type ToolState = {
  tool: Tool<unknown, unknown>;
  initPromise?: Promise<void>;
  initialized: boolean;
  disposed: boolean;
};

type SanitizedToolResult =
  | { ok: true; meta: ToolMeta }
  | { ok: false; errorCode: ToolError["code"]; meta: ToolMeta };

function error(code: ToolError["code"], message: string, retryable = false, detail?: unknown): ToolError {
  return { code, message, retryable, detail };
}

function correlation(request: Pick<ToolInvokeRequest, "context" | "repoId">): ToolContextCorrelation | undefined {
  if (request.context === undefined) return undefined;
  return {
    workspaceId: request.context.workspace.workspaceId,
    ...(request.context.issue?.storyId === undefined ? {} : { storyId: request.context.issue.storyId }),
    ...(request.repoId === undefined ? {} : { repoId: request.repoId }),
  };
}

function meta(toolId: ToolId, request: ToolInvokeRequest, startedAt: number, endedAt: number, attempt?: number): ToolMeta {
  return {
    invocationId: request.invocationId,
    toolId,
    caller: request.caller as ToolMeta["caller"],
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    attempt,
    correlation: correlation(request),
  };
}

function failed(toolId: ToolId, request: ToolInvokeRequest, err: ToolError, startedAt: number, endedAt = startedAt): ToolResult<never> {
  return { ok: false, error: err, meta: meta(toolId, request, startedAt, endedAt) };
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ToolRegistry {
  private readonly tools = new Map<ToolId, ToolState>();
  private readonly budgetCounts = new Map<string, number>();
  private readonly costs = new Map<string, ToolCost>();
  private shutdownStarted = false;

  constructor(private readonly options: ToolRegistryOptions) {}

  register(tool: Tool<unknown, unknown>): void {
    if (this.tools.has(tool.declaration.id)) return;
    this.tools.set(tool.declaration.id, {
      tool,
      initialized: false,
      disposed: false,
    });
  }

  async invoke<I = unknown, O = unknown>(toolId: ToolId, request: ToolInvokeRequest<I>): Promise<ToolResult<O>> {
    const startedAt = this.options.deps.now();
    const state = this.tools.get(toolId);
    if (state === undefined) {
      return failed(toolId, request, error("not_found", `tool not found: ${toolId}`), startedAt) as ToolResult<O>;
    }

    let policy: ToolPolicy;
    try {
      policy = await this.options.policyEngine.resolve(toolId, state.tool.declaration.defaults);
    } catch (cause) {
      return failed(toolId, request, error("policy_denied", "tool policy resolution failed", false, cause), startedAt, this.options.deps.now()) as ToolResult<O>;
    }

    if (!policy.enabled) {
      return failed(toolId, request, error("policy_denied", `tool disabled by policy: ${toolId}`), startedAt, this.options.deps.now()) as ToolResult<O>;
    }

    const readiness = this.requirementReadiness(state.tool.declaration);
    if (readiness?.status === "unavailable") {
      const detail = readiness.detail === undefined ? "" : `: ${readiness.detail}`;
      const fix = readiness.repairCommands?.length ? ` fix: ${readiness.repairCommands.join("; ")}` : "";
      return failed(
        toolId,
        request,
        error("policy_denied", `missing required tool requirement for ${toolId}${detail}${fix}`),
        startedAt,
        this.options.deps.now(),
      ) as ToolResult<O>;
    }
    const requirementWarnings =
      readiness?.status === "degraded"
        ? readiness.requirements.filter((resolution) => resolution.requirement.optional === true && resolution.status !== "ok").map(formatOptionalRequirementWarning)
        : [];

    const inputValidation = validateJsonSchemaValue(state.tool.declaration.inputSchema, request.input);
    if (!inputValidation.ok) {
      return failed(
        toolId,
        request,
        error("invalid_input", `invalid input for ${toolId}: ${inputValidation.errors.join("; ")}`, false, inputValidation.errors),
        startedAt,
        this.options.deps.now(),
      ) as ToolResult<O>;
    }

    const initResult = await this.ensureInitialized(state);
    if (!initResult.ok) {
      return failed(toolId, request, initResult.error, startedAt, this.options.deps.now()) as ToolResult<O>;
    }

    if (!this.reserveBudget(toolId, policy, request)) {
      return failed(toolId, request, error("budget_exhausted", `tool invocation budget exhausted: ${toolId}`), startedAt, this.options.deps.now()) as ToolResult<O>;
    }

    const invocation: ToolInvocation<I> = {
      invocationId: request.invocationId,
      toolId,
      input: request.input,
      caller: request.caller as ToolInvocation<I>["caller"],
      policy,
      ts: startedAt,
      context: request.context,
      repoId: request.repoId,
    };

    const emitEvents = state.tool.declaration.emitsEvents !== false;
    if (emitEvents) {
      await this.emit({
        type: "tool:invoke",
        cycleId: request.caller.cycleId,
        invocation: sanitizeInvocation(invocation, this.options.deps.redact),
        declaration: state.tool.declaration,
        ts: startedAt,
      } as ToolEvent);
    }

    const result = withCorrelation(await this.executeWithRetry<I, O>(state.tool, invocation, request, policy), request);
    const resultWithWarnings = appendWarnings(result, requirementWarnings);
    if (emitEvents || !result.ok) {
      await this.emit({
        type: "tool:result",
        cycleId: request.caller.cycleId,
        invocationId: request.invocationId,
        toolId,
        result: sanitizeResult(resultWithWarnings),
        ts: this.options.deps.now(),
      } as ToolEvent);
    }
    this.accumulateCost(toolId, request.input, resultWithWarnings);
    return resultWithWarnings;
  }

  snapshotCosts(): ToolCost[] {
    return [...this.costs.values()].map((cost) => ({ ...cost }));
  }

  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    await Promise.all(
      [...this.tools.values()].map(async (state) => {
        if (!state.initialized || state.disposed) return;
        try {
          await state.tool.dispose(this.options.deps);
        } catch {
          // ToolRegistry never throws; dispose failures are best-effort cleanup.
        } finally {
          state.disposed = true;
        }
      }),
    );
  }

  private async ensureInitialized(state: ToolState): Promise<{ ok: true } | { ok: false; error: ToolError }> {
    if (state.initialized) return { ok: true };
    if (state.initPromise === undefined) {
      state.initPromise = state.tool
        .init(this.options.deps)
        .then(() => {
          state.initialized = true;
        })
        .finally(() => {
          state.initPromise = undefined;
        });
    }
    try {
      await state.initPromise;
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: error("init_failed", "tool init failed", true, cause) };
    }
  }

  private requirementReadiness(declaration: ToolDeclaration): ReturnType<typeof deriveToolReadiness> | undefined {
    if (this.options.requirementResolver === undefined) return undefined;
    return deriveToolReadiness(declaration, this.options.requirementResolver);
  }

  private reserveBudget(toolId: ToolId, policy: ToolPolicy, request: ToolInvokeRequest): boolean {
    const max = policy.maxInvocationsPerCycle;
    if (max === undefined) return true;
    const key = toolInvocationScopeKey(toolId, request);
    const current = this.budgetCounts.get(key) ?? 0;
    if (current >= max) return false;
    this.budgetCounts.set(key, current + 1);
    return true;
  }

  private async executeWithRetry<I, O>(
    tool: Tool<unknown, unknown>,
    invocation: ToolInvocation<I>,
    request: ToolInvokeRequest<I>,
    policy: ToolPolicy,
  ): Promise<ToolResult<O>> {
    const attempts = Math.max(1, policy.retry?.attempts ?? 1);
    const backoffMs = policy.retry?.backoffMs ?? 0;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const attemptStartedAt = this.options.deps.now();
      try {
        const result = (await tool.execute(invocation, this.options.deps)) as ToolResult<O>;
        if (result.ok || !result.error.retryable || attempt === attempts) return result;
        await delay(backoffMs);
      } catch (cause) {
        lastError = cause;
        if (attempt < attempts) await delay(backoffMs);
        else {
          return failed(
            invocation.toolId,
            request,
            error("adapter_error", "tool adapter threw", attempt < attempts, lastError),
            attemptStartedAt,
            this.options.deps.now(),
          ) as ToolResult<O>;
        }
      }
    }
    return failed(invocation.toolId, request, error("adapter_error", "tool adapter failed", false, lastError), this.options.deps.now()) as ToolResult<O>;
  }

  private async emit(event: ToolEvent): Promise<void> {
    try {
      await this.options.events?.emit(event);
    } catch {
      // Event emission must not make tool invocation throw.
    }
  }

  private accumulateCost(toolId: ToolId, input: unknown, result: ToolResult<unknown>): void {
    if (result.meta.caller.cycleId === undefined || result.meta.caller.cycleId === "") return;
    const costCorrelation = result.meta.correlation;
    const costKey = toolCostKey(toolId, costCorrelation);
    const current = this.costs.get(costKey) ?? {
      toolId,
      ...(costCorrelation === undefined ? {} : { correlation: costCorrelation }),
      invocations: 0,
      durationMs: 0,
      failures: 0,
      estimatedCost: 0,
      currency: this.options.currency ?? "USD",
      inputBytes: 0,
      outputBytes: 0,
    };
    const output = result.ok ? result.output : result.error;
    this.costs.set(costKey, {
      ...current,
      invocations: current.invocations + 1,
      durationMs: (current.durationMs ?? 0) + result.meta.durationMs,
      failures: (current.failures ?? 0) + (result.ok ? 0 : 1),
      inputBytes: (current.inputBytes ?? 0) + jsonBytes(input),
      outputBytes: (current.outputBytes ?? 0) + jsonBytes(output),
    });
  }
}

function toolCostKey(toolId: ToolId, value: ToolContextCorrelation | undefined): string {
  if (value === undefined) return String(toolId);
  return [toolId, value.workspaceId, value.storyId ?? "", value.repoId ?? ""].join("\u0000");
}

function toolInvocationScopeKey(toolId: ToolId, request: ToolInvokeRequest): string {
  const value = correlation(request);
  return [
    toolId,
    request.caller.cycleId ?? "",
    value?.workspaceId ?? "",
    value?.storyId ?? "",
    value?.repoId ?? "",
  ].join("\u0000");
}

function sanitizeResult(result: ToolResult<unknown>): SanitizedToolResult {
  if (result.ok) return { ok: true, meta: result.meta };
  return { ok: false, errorCode: result.error.code, meta: result.meta };
}

function sanitizeInvocation<I>(invocation: ToolInvocation<I>, redact: ToolDeps["redact"]): ToolInvocation<I> {
  return {
    ...invocation,
    input: sanitizeInvocationValue(invocation.input, redact, undefined, new WeakSet<object>()) as I,
  };
}

function sanitizeInvocationValue(value: unknown, redact: ToolDeps["redact"], key: string | undefined, seen: WeakSet<object>): unknown {
  if (key !== undefined && sensitiveInvocationKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeInvocationValue(entry, redact, undefined, seen));
  return Object.fromEntries(
    Object.entries(value).map(([childKey, entry]) => [childKey, sanitizeInvocationValue(entry, redact, childKey, seen)]),
  );
}

function sensitiveInvocationKey(key: string): boolean {
  const segments = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase().split(/[_-]+/u);
  return segments.some((segment) => ["authorization", "cookie", "credential", "password", "passwd", "secret", "token"].includes(segment)) ||
    segments.some((segment, index) => ["api", "private"].includes(segment) && segments[index + 1] === "key");
}

function formatRequirement(requirement: ToolRequirement): string {
  if (requirement.kind === "env") return `${requirement.name} (env)`;
  if (requirement.kind === "service") return `${requirement.name} (service)`;
  return requirement.name;
}

function formatOptionalRequirementWarning(resolution: ToolRequirementResolution): string {
  const fix = resolution.repair?.command === undefined ? "" : ` fix: ${resolution.repair.command}`;
  return `optional requirement ${formatRequirement(resolution.requirement)} is ${resolution.status}: ${resolution.detail}${fix}`;
}

function appendWarnings<T>(result: ToolResult<T>, warnings: readonly string[]): ToolResult<T> {
  if (warnings.length === 0) return result;
  return {
    ...result,
    warnings: [...(result.warnings ?? []), ...warnings],
  };
}

function withCorrelation<T>(result: ToolResult<T>, request: Pick<ToolInvokeRequest, "context" | "repoId">): ToolResult<T> {
  const value = correlation(request);
  if (value === undefined) return result;
  return {
    ...result,
    meta: {
      ...result.meta,
      correlation: { ...result.meta.correlation, ...value },
    },
  };
}
