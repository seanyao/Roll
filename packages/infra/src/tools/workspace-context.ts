import { resolveWorkspaceExecutionContextScope } from "@roll/core";
import type {
  ToolError,
  ToolInvocation,
  ToolMeta,
  WorkspaceContextScope,
  WorkspaceExecutionContextV1,
} from "@roll/spec";

export type ResolvedToolExecutionContext =
  | { readonly ok: true; readonly context: WorkspaceExecutionContextV1 }
  | {
      readonly ok: false;
      readonly error: ToolError & {
        readonly code: "missing_execution_context" | "invalid_execution_context";
      };
    };

/** Validate and freeze one invocation context at the adapter boundary. */
export function resolveToolExecutionContext(
  invocation: ToolInvocation<unknown>,
  scope: WorkspaceContextScope,
): ResolvedToolExecutionContext {
  const resolved = resolveWorkspaceExecutionContextScope({ scope, context: invocation.context });
  if (!resolved.ok) {
    return {
      ok: false,
      error: {
        code: resolved.error.code.startsWith("missing_")
          ? "missing_execution_context"
          : "invalid_execution_context",
        message: resolved.error.message,
        retryable: false,
      },
    };
  }
  if (resolved.context === undefined) {
    return {
      ok: false,
      error: {
        code: "missing_execution_context",
        message: `Scope ${scope} requires a Workspace execution context`,
        retryable: false,
      },
    };
  }
  const issue = resolved.context.issue;
  if (invocation.caller.storyId !== undefined && issue?.storyId !== invocation.caller.storyId) {
    return {
      ok: false,
      error: {
        code: "invalid_execution_context",
        message: "Tool caller Story does not match the frozen Workspace execution context",
        retryable: false,
      },
    };
  }
  if (
    invocation.repoId !== undefined &&
    issue?.execution.repositories[invocation.repoId] === undefined
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_execution_context",
        message: "Tool repository selector is not present in the frozen Issue execution context",
        retryable: false,
      },
    };
  }
  return { ok: true, context: resolved.context };
}

export function toolCorrelation(
  invocation: ToolInvocation<unknown>,
): ToolMeta["correlation"] | undefined {
  const workspaceId = invocation.context?.workspace.workspaceId;
  if (workspaceId === undefined) return undefined;
  const storyId = invocation.context?.issue?.storyId;
  return {
    workspaceId,
    ...(storyId === undefined ? {} : { storyId }),
    ...(invocation.repoId === undefined ? {} : { repoId: invocation.repoId }),
  };
}
