import { isDeepStrictEqual } from "node:util";
import { resolveWorkspaceExecutionContextScope, type CycleContext } from "@roll/core";
import type { RepositoryExecutionContext } from "@roll/spec";
import type { AgentSpawnOptions } from "./agent-spawn.js";
import { injectRepositoryContext } from "./project-map.js";
import { resolveWorkspaceCycleRepository } from "./scoped-route.js";
import { prepareWorkspaceSkillHandoff } from "./workspace-skill-handoff.js";

export function applyRepositoryBuilderContext(
  ctx: CycleContext,
  options: AgentSpawnOptions,
): AgentSpawnOptions {
  const execution = ctx.repositoryExecution ?? ctx.workspaceExecution?.issue?.execution;
  const prepared = prepareWorkspaceBuilderSkillBody(ctx, options.skillBody);
  if (!prepared.ok) throw new Error(prepared.code);
  if (execution === undefined) return { ...options, skillBody: prepared.skillBody };
  return {
    ...options,
    cwd: execution.issueRoot,
    skillBody: prepared.skillBody,
  };
}

export type WorkspaceBuilderSkillBodyResult =
  | {
      readonly ok: true;
      readonly skillBody: string;
      readonly contextJson?: string;
      readonly selectedRepository?: RepositoryExecutionContext;
    }
  | { readonly ok: false; readonly code: string };

export type WorkspaceSpawnIdentityResult =
  | { readonly ok: true; readonly selectedRepository?: RepositoryExecutionContext }
  | { readonly ok: false; readonly code: string };

/** Validate the frozen Workspace/Issue/repository identity before any spawn side effect. */
export function resolveWorkspaceSpawnIdentity(ctx: CycleContext): WorkspaceSpawnIdentityResult {
  if (ctx.workspaceExecution === undefined) {
    return { ok: false, code: "missing_execution_context" };
  }
  const scoped = resolveWorkspaceExecutionContextScope({
    scope: "issue_required",
    context: ctx.workspaceExecution,
  });
  if (!scoped.ok || scoped.context?.issue === undefined) {
    return { ok: false, code: scoped.ok ? "missing_execution_context" : scoped.error.code };
  }
  if (ctx.storyId !== scoped.context.issue.storyId) {
    return { ok: false, code: "story_identity_mismatch" };
  }
  if (
    ctx.repositoryExecution !== undefined &&
    !isDeepStrictEqual(ctx.repositoryExecution, scoped.context.issue.execution)
  ) {
    return { ok: false, code: "repository_context_mismatch" };
  }
  const selected = resolveWorkspaceCycleRepository(scoped.context, ctx.repositorySelector);
  return selected.ok
    ? { ok: true, selectedRepository: selected.repository }
    : selected;
}

/** Compose repository details under the canonical Workspace handoff block. */
export function prepareWorkspaceBuilderSkillBody(
  ctx: CycleContext,
  skillBody: string,
): WorkspaceBuilderSkillBodyResult {
  const identity = resolveWorkspaceSpawnIdentity(ctx);
  if (!identity.ok) return identity;
  const execution = ctx.repositoryExecution ?? ctx.workspaceExecution?.issue?.execution;
  const repositoryBody = execution === undefined
    ? skillBody
    : injectRepositoryContext(skillBody, execution);
  if (ctx.workspaceExecution === undefined) return { ok: true, skillBody: repositoryBody };
  const selected = identity.selectedRepository;
  if (selected === undefined) return { ok: false, code: "missing_repository_context" };
  const selectedBody = [
    "[Selected Workspace repository]",
    `Selected repository: ${selected.repoId} (${selected.alias})`,
    "Use this exact repoId for repository-scoped commands; do not infer another repository from cwd or ordering.",
    "[/Selected Workspace repository]",
    "",
    repositoryBody,
  ].join("\n");
  const prepared = prepareWorkspaceSkillHandoff({
    skillName: ctx.storyId?.startsWith("FIX-") || ctx.storyId?.startsWith("BUG-")
      ? "roll-fix"
      : "roll-build",
    scope: "issue_required",
    context: ctx.workspaceExecution,
    skillBody: selectedBody,
  });
  return prepared.ok
    ? {
        ok: true,
        skillBody: prepared.skillBody,
        contextJson: prepared.contextJson,
        selectedRepository: selected,
      }
    : prepared;
}
