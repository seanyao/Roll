import { discoverWorkspaceForIntent } from "@roll/core";
import { loadWorkspaceDiscovery } from "@roll/infra";
import { WORKSPACE_INTENT_V1 } from "@roll/spec";
import {
  buildRepositoryWorkspaceExecutionContext,
  resolveRepositoryExecutionContext,
} from "../runner/repository-context.js";
import { designRequirementHint } from "./design.js";
import { loadWorkspaceExecutionContext } from "./workspace-execution-context.js";
import { canonicalWorkspaceSelectorValue, containsCanonicalWorkspaceSelector, isCanonicalWorkspaceSelectorToken } from "../lib/workspace-selector.js";
import { beginAgentWorkspaceClarification } from "../runner/workspace-clarification.js";
import {
  prepareRegisteredWorkspaceSkillHandoff,
  resolveRegisteredWorkspaceSkillPolicy,
} from "../runner/workspace-skill-handoff.js";
import { workspaceRollHome } from "./workspace-target.js";

const WORKSPACE_SKILL_BOOTSTRAP_V1 = "roll.workspace-skill-bootstrap/v1" as const;

interface ParsedHandoffArgs {
  readonly skill: string;
  readonly operation: string;
  readonly requirement: string;
  readonly workspace?: string;
  readonly story?: string;
  readonly repository?: string;
  readonly machineCwd?: string;
  readonly legacyProjectRoot?: string;
  readonly json: boolean;
}

function parseArgs(args: readonly string[]): ParsedHandoffArgs | undefined {
  let skill: string | undefined;
  let operation: string | undefined;
  let requirement: string | undefined;
  let story: string | undefined;
  let repository: string | undefined;
  let machineCwd: string | undefined;
  let legacyProjectRoot: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (isCanonicalWorkspaceSelectorToken(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      index += 1;
      continue;
    }
    if (
      arg === "--skill" || arg === "--operation" || arg === "--requirement" ||
      arg === "--story" || arg === "--repository" || arg === "--machine-cwd" ||
      arg === "--legacy-project-root"
    ) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      if (arg === "--skill") {
        if (skill !== undefined) return undefined;
        skill = value;
      } else if (arg === "--operation") {
        if (operation !== undefined) return undefined;
        operation = value;
      } else {
        if (arg === "--requirement") {
          if (requirement !== undefined) return undefined;
          requirement = value;
        } else if (arg === "--story") {
          if (story !== undefined) return undefined;
          story = value;
        } else if (arg === "--repository") {
          if (repository !== undefined) return undefined;
          repository = value;
        } else if (arg === "--machine-cwd") {
          if (machineCwd !== undefined) return undefined;
          machineCwd = value;
        } else {
          if (legacyProjectRoot !== undefined) return undefined;
          legacyProjectRoot = value;
        }
      }
      index += 1;
      continue;
    }
    return undefined;
  }
  if (
    skill === undefined || skill.trim() === "" ||
    operation === undefined || operation.trim() === "" ||
    requirement === undefined ||
    (containsCanonicalWorkspaceSelector(args) && canonicalWorkspaceSelectorValue(args) === undefined)
  ) return undefined;
  const workspace = canonicalWorkspaceSelectorValue(args);
  return {
    skill,
    operation,
    requirement,
    ...(workspace === undefined ? {} : { workspace }),
    ...(story === undefined ? {} : { story }),
    ...(repository === undefined ? {} : { repository }),
    ...(machineCwd === undefined ? {} : { machineCwd }),
    ...(legacyProjectRoot === undefined ? {} : { legacyProjectRoot }),
    json,
  };
}

function emit(value: unknown, json: boolean, text: string): number {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
  return 0;
}

function emitError(code: string, json: boolean): number {
  const value = {
    schema: WORKSPACE_SKILL_BOOTSTRAP_V1,
    route: "error",
    stopped: true,
    error: { code },
  };
  if (json) process.stderr.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stderr.write(`roll workspace handoff: ${code}\n`);
  return 1;
}

/**
 * Read-only bootstrap for a directly invoked Roll skill. It either returns the
 * same paired context transport used by spawned agents or a closed
 * workspace_target question. It never selects, activates, creates, or mutates a
 * Workspace.
 */
export async function workspaceSkillHandoffCommand(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args);
  const json = args.includes("--json");
  if (parsed === undefined) return emitError("invalid_arguments", json);

  const resolvedPolicy = resolveRegisteredWorkspaceSkillPolicy(parsed.skill, parsed.operation);
  if (!resolvedPolicy.ok) return emitError(resolvedPolicy.code, parsed.json);
  const policy = resolvedPolicy.policy;

  const cwd = process.cwd();
  const rollHome = workspaceRollHome();
  const requirement = designRequirementHint([parsed.requirement], cwd);
  if (policy.scope === "machine_only" || policy.scope === "legacy_migration_only") {
    const prepared = prepareRegisteredWorkspaceSkillHandoff({
      skillName: parsed.skill,
      operation: parsed.operation,
      context: undefined,
      ...(parsed.machineCwd === undefined ? {} : { machineCwd: parsed.machineCwd }),
      ...(parsed.legacyProjectRoot === undefined ? {} : { legacyProjectRoot: parsed.legacyProjectRoot }),
      skillBody: "",
    });
    if (!prepared.ok) return emitError(prepared.code, parsed.json);
    return emit({
      schema: WORKSPACE_SKILL_BOOTSTRAP_V1,
      route: "context",
      stopped: false,
      skill: parsed.skill,
      operation: parsed.operation,
      promptBlock: prepared.skillBody.trimEnd(),
      cwd: prepared.cwd,
    }, parsed.json, prepared.skillBody.trimEnd());
  }

  const issueScoped = policy.scope === "issue_required" || policy.scope === "repository_required";
  const baseScope = issueScoped
    ? (policy.access === "read" ? "workspace_required_read" : "workspace_required_mutation")
    : policy.scope;
  const loaded = loadWorkspaceExecutionContext({
    cwd,
    rollHome,
    operation: policy.access === "read" ? "read" : "mutation",
    scope: baseScope,
    ...(parsed.workspace === undefined ? {} : { explicitWorkspace: parsed.workspace }),
    requirement,
  });

  if (loaded.ok) {
    let context = loaded.context;
    if (issueScoped) {
      if (parsed.story === undefined) return emitError("story_id_required", parsed.json);
      try {
        const execution = await resolveRepositoryExecutionContext(
          loaded.context.workspace.canonicalRoot,
          parsed.story,
        );
        if (execution === undefined) return emitError("issue_not_initialized", parsed.json);
        context = buildRepositoryWorkspaceExecutionContext(
          loaded.context.workspace.canonicalRoot,
          parsed.story,
          execution,
        );
      } catch {
        return emitError("issue_not_initialized", parsed.json);
      }
    }
    const prepared = prepareRegisteredWorkspaceSkillHandoff({
      skillName: parsed.skill,
      operation: parsed.operation,
      context,
      expectedWorkspaceId: context.workspace.workspaceId,
      ...(parsed.story === undefined ? {} : { expectedStoryId: parsed.story }),
      ...(parsed.repository === undefined ? {} : { repositorySelector: parsed.repository }),
      skillBody: "",
    });
    if (!prepared.ok) return emitError(prepared.code, parsed.json);
    const environmentContext = prepared.env.ROLL_WORKSPACE_EXECUTION_CONTEXT;
    if (environmentContext === undefined) return emitError("missing_execution_context", parsed.json);
    return emit({
      schema: WORKSPACE_SKILL_BOOTSTRAP_V1,
      route: "context",
      stopped: false,
      skill: parsed.skill,
      operation: parsed.operation,
      promptContext: environmentContext,
      environmentContext,
      promptBlock: prepared.skillBody.trimEnd(),
      context: prepared.context,
      cwd: prepared.cwd,
      ...(prepared.selectedRepository === undefined ? {} : { selectedRepository: prepared.selectedRepository }),
    }, parsed.json, prepared.skillBody.trimEnd());
  }

  if (loaded.route !== "workspace_target" && loaded.code !== "workspace_discovery_incomplete") {
    return emitError(loaded.code, parsed.json);
  }
  const discovery = loadWorkspaceDiscovery({ rollHome });
  const intent = {
    schema: WORKSPACE_INTENT_V1,
    operation: policy.access === "read" ? "read" as const : "mutation" as const,
    interaction: "interactive" as const,
    scope: baseScope,
    cwd,
    requirement,
  };
  const decision = discoverWorkspaceForIntent({
    intent,
    workspaces: discovery.workspaces,
    diagnostics: discovery.diagnostics,
  });
  if (decision.ok || decision.code === "invalid_requirement_hint") {
    return emitError(loaded.code, parsed.json);
  }
  const question = beginAgentWorkspaceClarification({
    intent,
    reason: decision.code,
    candidates: decision.candidates,
    diagnostics: decision.diagnostics,
    discovery,
  });
  return emit({
    schema: WORKSPACE_SKILL_BOOTSTRAP_V1,
    route: "workspace_target",
    stopped: true,
    code: decision.code,
    question,
  }, parsed.json, question.prompt);
}
