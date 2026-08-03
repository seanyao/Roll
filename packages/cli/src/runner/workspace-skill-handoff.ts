import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceExecutionContextScope } from "@roll/core";
import type {
  RepositoryExecutionContext,
  WorkspaceContextAccess,
  WorkspaceContextEffectTarget,
  WorkspaceContextPolicy,
  WorkspaceRepositorySelectorPolicy,
  WorkspaceContextScope,
  WorkspaceExecutionContextV1,
} from "@roll/spec";
import { skillContextPoliciesFromManifest } from "../lib/workspace-context-policy.js";
import { injectRepositoryContext } from "./project-map.js";
import { resolveWorkspaceCycleRepository } from "./scoped-route.js";

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

/** Stable prompt-adjacent environment for one frozen Workspace handoff. */
export function workspaceSkillHandoffEnvironment(
  context: WorkspaceExecutionContextV1 | undefined,
): NodeJS.ProcessEnv {
  if (context === undefined) return {};
  return {
    ROLL_WORKSPACE_EXECUTION_CONTEXT: workspaceExecutionContextJson(context),
    ROLL_WORKSPACE: context.workspace.workspaceId,
    ROLL_WORKSPACE_LOCK: context.workspace.workspaceId,
    ...(context.issue === undefined ? {} : { ROLL_STORY_ID: context.issue.storyId }),
  };
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
    "The task is locked to this Workspace. `roll workspace create` is forbidden until a new host handoff replaces this context.",
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

export type RegisteredWorkspaceSkillPolicy = WorkspaceContextPolicy & {
  readonly effectTarget: WorkspaceContextEffectTarget;
  readonly access: WorkspaceContextAccess;
  readonly repositorySelector: WorkspaceRepositorySelectorPolicy;
};

export type RegisteredWorkspaceSkillHandoffResult =
  | {
      readonly ok: true;
      readonly policy: RegisteredWorkspaceSkillPolicy;
      readonly context?: WorkspaceExecutionContextV1;
      readonly contextJson?: string;
      readonly skillBody: string;
      readonly env: NodeJS.ProcessEnv;
      readonly cwd: string;
      readonly selectedRepository?: RepositoryExecutionContext;
    }
  | { readonly ok: false; readonly code: string };

function registeredSkillPolicy(
  manifest: unknown,
  skillName: string,
  operation: string,
): RegisteredWorkspaceSkillPolicy | { readonly code: string } {
  let policies: WorkspaceContextPolicy[];
  try {
    policies = skillContextPoliciesFromManifest(manifest);
  } catch {
    return { code: "invalid_skill_policy" };
  }
  const keys = new Set<string>();
  for (const policy of policies) {
    const key = `${policy.id}:${policy.operation}`;
    if (keys.has(key)) return { code: "duplicate_skill_policy" };
    keys.add(key);
    if (policy.effectTarget === undefined || policy.access === undefined || policy.repositorySelector === undefined) {
      return { code: "missing_skill_execution_policy" };
    }
    if (
      (policy.scope === "machine_only" || policy.scope === "legacy_migration_only")
      && (policy.rationale ?? "").trim() === ""
    ) {
      return { code: "invalid_skill_execution_policy" };
    }
    if (policy.scope === "machine_only" && policy.repositorySelector !== "forbidden") {
      return { code: "invalid_skill_execution_policy" };
    }
    if (policy.access === "none" && policy.scope !== "machine_only" && policy.scope !== "legacy_migration_only") {
      return { code: "invalid_skill_execution_policy" };
    }
    if (
      policy.access === "mutation"
      && (
        policy.scope === "workspace_optional_read"
        || policy.scope === "workspace_required_read"
      )
    ) {
      return { code: "invalid_skill_execution_policy" };
    }
  }
  const matches = policies.filter((policy) => policy.id === skillName && policy.operation === operation);
  if (matches.length === 0) return { code: "missing_skill_policy" };
  if (matches[0] === undefined) return { code: "missing_skill_policy" };
  const policy = matches[0];
  return policy as RegisteredWorkspaceSkillPolicy;
}

export type ResolveRegisteredWorkspaceSkillPolicyResult =
  | { readonly ok: true; readonly policy: RegisteredWorkspaceSkillPolicy }
  | { readonly ok: false; readonly code: string };

/** Resolve the shipped policy before the command chooses Workspace/Issue scope. */
export function resolveRegisteredWorkspaceSkillPolicy(
  skillName: string,
  operation: string,
): ResolveRegisteredWorkspaceSkillPolicyResult {
  let manifest: unknown;
  try {
    manifest = loadShippedWorkspaceSkillPolicyManifest();
  } catch {
    return { ok: false, code: "skill_policy_registry_unavailable" };
  }
  const resolved = registeredSkillPolicy(manifest, skillName, operation);
  return "code" in resolved
    ? { ok: false, code: resolved.code }
    : { ok: true, policy: resolved };
}

function machineOnlyBlock(skillName: string, operation: string): string {
  return [
    "[Roll machine-only skill handoff]",
    `skill: ${skillName}`,
    `operation: ${operation}`,
    "No Workspace or repository authority is attached to this invocation.",
    "Do not discover a Workspace from cwd, environment, registry ordering, or a single active Workspace.",
    "Operate only on the explicitly named machine target for this operation.",
    "[/Roll machine-only skill handoff]",
  ].join("\n");
}

function legacyMigrationBlock(skillName: string, operation: string, legacyProjectRoot: string): string {
  return [
    "[Roll legacy-migration skill handoff]",
    `skill: ${skillName}`,
    `operation: ${operation}`,
    `legacyProjectRoot: ${legacyProjectRoot}`,
    "No Workspace authority exists for this invocation; cwd is not a selector.",
    "Read or mutate only this explicitly selected legacy project and never dual-write a Workspace authority.",
    "The only canonical continuation is to preview `roll workspace create --config <workspace.yaml>` after migration output is complete.",
    "[/Roll legacy-migration skill handoff]",
  ].join("\n");
}

/** Load the policy registry bundled with this exact Roll package. */
export function loadShippedWorkspaceSkillPolicyManifest(): unknown {
  let root = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10 && !existsSync(join(root, "conventions")); depth += 1) {
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  if (!existsSync(join(root, "conventions"))) {
    throw new Error("workspace-skill-handoff: cannot locate shipped package root");
  }
  const path = join(root, "skills", "route-cases", "skills.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

interface RegisteredWorkspaceSkillHandoffInput {
  readonly skillName: string;
  readonly operation: string;
  readonly context: WorkspaceExecutionContextV1 | undefined;
  readonly expectedWorkspaceId?: string;
  readonly expectedStoryId?: string;
  readonly repositorySelector?: string;
  readonly machineCwd?: string;
  readonly legacyProjectRoot?: string;
  readonly skillBody: string;
}

function prepareRegisteredWorkspaceSkillHandoffWithManifest(
  manifest: unknown,
  input: RegisteredWorkspaceSkillHandoffInput,
): RegisteredWorkspaceSkillHandoffResult {
  const policy = registeredSkillPolicy(manifest, input.skillName, input.operation);
  if ("code" in policy) return { ok: false, code: policy.code };

  if (policy.scope === "machine_only" || policy.scope === "legacy_migration_only") {
    if (input.context !== undefined) return { ok: false, code: "workspace_context_forbidden" };
    if (input.repositorySelector !== undefined) return { ok: false, code: "repository_selector_forbidden" };
    if (policy.scope === "machine_only") {
      const cwd = (input.machineCwd ?? "").trim();
      if (cwd === "") return { ok: false, code: "machine_cwd_required" };
      return {
        ok: true,
        policy,
        skillBody: `${machineOnlyBlock(input.skillName, input.operation)}\n\n${input.skillBody}`,
        env: {},
        cwd,
      };
    }
    const legacyProjectRoot = (input.legacyProjectRoot ?? "").trim();
    if (legacyProjectRoot === "") return { ok: false, code: "legacy_project_root_required" };
    return {
      ok: true,
      policy,
      skillBody: `${legacyMigrationBlock(input.skillName, input.operation, legacyProjectRoot)}\n\n${input.skillBody}`,
      env: {},
      cwd: legacyProjectRoot,
    };
  }

  if ((input.expectedWorkspaceId ?? "").trim() === "") {
    return { ok: false, code: "missing_expected_workspace_identity" };
  }

  const base = prepareWorkspaceSkillHandoff({
    skillName: input.skillName,
    scope: policy.scope,
    context: input.context,
    skillBody: input.skillBody,
  });
  if (!base.ok) return base;
  if (base.context.workspace.workspaceId !== input.expectedWorkspaceId) {
    return { ok: false, code: "workspace_context_conflict" };
  }
  const storyRequired = policy.scope === "issue_required" || policy.scope === "repository_required";
  if (storyRequired && (input.expectedStoryId ?? "").trim() === "") {
    return { ok: false, code: "missing_expected_story_identity" };
  }
  if (input.expectedStoryId !== undefined && base.context.issue?.storyId !== input.expectedStoryId) {
    return { ok: false, code: "story_identity_mismatch" };
  }

  let selectedRepository: RepositoryExecutionContext | undefined;
  if (policy.repositorySelector === "required") {
    const selected = resolveRegisteredRepository(base.context, input.repositorySelector);
    if (!selected.ok) return selected;
    selectedRepository = selected.repository;
  } else if (input.repositorySelector !== undefined) {
    return { ok: false, code: "repository_selector_forbidden" };
  }
  if (
    policy.access === "mutation"
    && policy.repositorySelector === "required"
    && selectedRepository?.access !== "write"
  ) {
    return { ok: false, code: "repository_write_forbidden" };
  }

  const repositoryBody = base.context.issue === undefined
    ? input.skillBody
    : injectRepositoryContext(input.skillBody, base.context.issue.execution);
  const selectedBody = selectedRepository === undefined
    ? repositoryBody
    : `${selectedRepositoryBlock(selectedRepository)}\n\n${repositoryBody}`;
  const prepared = prepareWorkspaceSkillHandoff({
    skillName: input.skillName,
    scope: policy.scope,
    context: base.context,
    skillBody: selectedBody,
  });
  if (!prepared.ok) return prepared;
  const env = {
    ...workspaceSkillHandoffEnvironment(prepared.context),
    ...(selectedRepository === undefined ? {} : {
      ROLL_REPOSITORY_ID: selectedRepository.repoId,
      ROLL_REPOSITORY_ALIAS: selectedRepository.alias,
    }),
  };
  return {
    ok: true,
    policy,
    context: prepared.context,
    contextJson: prepared.contextJson,
    skillBody: prepared.skillBody,
    env,
    cwd: selectedRepository?.worktreePath
      ?? prepared.context.issue?.execution.issueRoot
      ?? prepared.context.workspace.canonicalRoot,
    ...(selectedRepository === undefined ? {} : { selectedRepository }),
  };
}

function selectedRepositoryBlock(repository: RepositoryExecutionContext): string {
  return [
    "[Selected Workspace repository]",
    `Selected repository: ${repository.repoId} (${repository.alias})`,
    "Use this exact repoId for repository-scoped commands; do not infer another repository from cwd or ordering.",
    "[/Selected Workspace repository]",
  ].join("\n");
}

function resolveRegisteredRepository(
  context: WorkspaceExecutionContextV1,
  selector: string | undefined,
): ReturnType<typeof resolveWorkspaceCycleRepository> {
  const requested = (selector ?? "").trim();
  if (requested === "") return { ok: false, code: "repository_selector_required" };
  const repositories = Object.values(context.issue?.execution.repositories ?? {});
  const matches = repositories.filter((repository) => repository.repoId === requested || repository.alias === requested);
  if (matches.length > 1) return { ok: false, code: "ambiguous_repository_selector" };
  return resolveWorkspaceCycleRepository(context, requested);
}

/**
 * Resolve a supporting skill from the shipped policy registry, then compose one
 * prompt/env/cwd handoff. Callers cannot self-declare scope or context consumer.
 */
export function prepareRegisteredWorkspaceSkillHandoff(input: {
  readonly skillName: string;
  readonly operation: string;
  readonly context: WorkspaceExecutionContextV1 | undefined;
  readonly expectedWorkspaceId?: string;
  readonly expectedStoryId?: string;
  readonly repositorySelector?: string;
  readonly machineCwd?: string;
  readonly legacyProjectRoot?: string;
  readonly skillBody: string;
}): RegisteredWorkspaceSkillHandoffResult {
  let manifest: unknown;
  try {
    manifest = loadShippedWorkspaceSkillPolicyManifest();
  } catch {
    return { ok: false, code: "skill_policy_registry_unavailable" };
  }
  return prepareRegisteredWorkspaceSkillHandoffWithManifest(manifest, input);
}

/** @internal Test-only injection seam; production callers must use the shipped registry loader above. */
export function prepareRegisteredWorkspaceSkillHandoffForTest(
  input: RegisteredWorkspaceSkillHandoffInput & { readonly manifest: unknown },
): RegisteredWorkspaceSkillHandoffResult {
  const { manifest, ...handoff } = input;
  return prepareRegisteredWorkspaceSkillHandoffWithManifest(manifest, handoff);
}
