import {
  parseWorkspaceExecutionContext,
  resolveWorkspaceExecutionContextScope,
  type ToolInvokeRequest,
} from "@roll/core";
import type { WorkspaceExecutionContextV1 } from "@roll/spec";

export interface WorkspaceToolCycleContext {
  cycleId: string;
  storyId: string;
  workspace: unknown;
  agent?: string;
  segment?: string;
}

export interface WorkspaceToolInvocationInput<I> {
  invocationId: string;
  input: I;
  repoId?: string;
}

export interface WorkspaceToolInvocationFactory {
  readonly context: WorkspaceExecutionContextV1;
  request<I>(input: WorkspaceToolInvocationInput<I>): ToolInvokeRequest<I>;
}

/**
 * Freeze one validated Workspace execution context at the runner cycle
 * boundary, then reuse that immutable snapshot for every local tool request.
 */
export function createWorkspaceToolInvocationFactory(input: WorkspaceToolCycleContext): WorkspaceToolInvocationFactory {
  const parsed = parseWorkspaceExecutionContext(input.workspace);
  if (!parsed.ok) throw invalid("runner Workspace execution context is invalid");
  const scoped = resolveWorkspaceExecutionContextScope({ scope: "issue_required", context: parsed.value });
  if (!scoped.ok || scoped.context === undefined) {
    throw invalid("runner Workspace execution context is invalid");
  }
  const cloned = structuredClone(scoped.context);
  const issue = cloned.issue;
  if (
    input.cycleId.trim() === "" ||
    input.storyId.trim() === "" ||
    issue === undefined ||
    issue.storyId !== input.storyId ||
    issue.execution.workspaceId !== cloned.workspace.workspaceId
  ) {
    throw invalid("runner cycle identity does not match the Issue execution context");
  }
  const context = deepFreeze(cloned);

  return {
    context,
    request<I>(request: WorkspaceToolInvocationInput<I>): ToolInvokeRequest<I> {
      return {
        invocationId: request.invocationId,
        input: request.input,
        caller: {
          cycleId: input.cycleId,
          storyId: input.storyId,
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(input.segment === undefined ? {} : { segment: input.segment }),
        },
        context,
        ...(request.repoId === undefined ? {} : { repoId: request.repoId }),
      };
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function invalid(message: string): Error {
  return new Error(`invalid_execution_context: ${message}`);
}
