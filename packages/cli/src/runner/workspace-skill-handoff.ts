import { resolveWorkspaceExecutionContextScope } from "@roll/core";
import type {
  WorkspaceContextScope,
  WorkspaceExecutionContextV1,
} from "@roll/spec";

export type WorkspaceSkillHandoffResult =
  | {
      readonly ok: true;
      readonly context: WorkspaceExecutionContextV1;
      readonly contextJson: string;
      readonly skillBody: string;
    }
  | { readonly ok: false; readonly code: string };

/** One canonical JSON transport for both prompt and child-process env. */
export function workspaceExecutionContextJson(context: WorkspaceExecutionContextV1): string {
  return JSON.stringify(context);
}

/** Render the audited host-to-skill authority handoff before the skill body. */
export function prepareWorkspaceSkillHandoff(input: {
  readonly skillName: string;
  readonly scope: WorkspaceContextScope;
  readonly context: WorkspaceExecutionContextV1 | undefined;
  readonly skillBody: string;
}): WorkspaceSkillHandoffResult {
  const scoped = resolveWorkspaceExecutionContextScope({
    scope: input.scope,
    context: input.context,
  });
  if (!scoped.ok || scoped.context === undefined || input.context === undefined) {
    return {
      ok: false,
      code: scoped.ok ? "missing_execution_context" : scoped.error.code,
    };
  }
  const contextJson = workspaceExecutionContextJson(input.context);
  const block = [
    "[Roll Workspace skill handoff]",
    `skill: ${input.skillName}`,
    `scope: ${input.scope}`,
    `Workspace: ${input.context.workspace.workspaceId}`,
    `Story: ${input.context.issue?.storyId ?? "none"}`,
    `authorities: ${JSON.stringify(input.context.authorities)}`,
    "This frozen WorkspaceExecutionContextV1 is the only Workspace/Issue authority for this run.",
    "Do not rediscover or replace Workspace/Issue authority from cwd; do not scan for another Workspace.",
    "Use authority paths from this context for backlog, features, design, evidence, runtime, and locks.",
    "Repository operations require an explicit repository selector; never choose the first repository.",
    `context-json: ${contextJson}`,
    "[/Roll Workspace skill handoff]",
  ].join("\n");
  return {
    ok: true,
    context: input.context,
    contextJson,
    skillBody: `${block}\n\n${input.skillBody}`,
  };
}
