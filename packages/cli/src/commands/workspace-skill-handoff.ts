import { discoverWorkspaceForIntent } from "@roll/core";
import { loadWorkspaceDiscovery } from "@roll/infra";
import { WORKSPACE_INTENT_V1 } from "@roll/spec";
import { designRequirementHint } from "./design.js";
import { loadWorkspaceExecutionContext } from "./workspace-execution-context.js";
import { canonicalWorkspaceSelectorValue, containsCanonicalWorkspaceSelector, isCanonicalWorkspaceSelectorToken } from "../lib/workspace-selector.js";
import { beginAgentWorkspaceClarification } from "../runner/workspace-clarification.js";
import {
  prepareWorkspaceSkillHandoff,
  workspaceSkillHandoffEnvironment,
} from "../runner/workspace-skill-handoff.js";
import { workspaceRollHome } from "./workspace-target.js";

const WORKSPACE_SKILL_BOOTSTRAP_V1 = "roll.workspace-skill-bootstrap/v1" as const;

interface ParsedHandoffArgs {
  readonly skill: "roll-design";
  readonly operation: "design";
  readonly requirement: string;
  readonly workspace?: string;
  readonly json: boolean;
}

function parseArgs(args: readonly string[]): ParsedHandoffArgs | undefined {
  let skill: string | undefined;
  let operation: string | undefined;
  let requirement: string | undefined;
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
    if (arg === "--skill" || arg === "--operation" || arg === "--requirement") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      if (arg === "--skill") {
        if (skill !== undefined) return undefined;
        skill = value;
      } else if (arg === "--operation") {
        if (operation !== undefined) return undefined;
        operation = value;
      } else {
        if (requirement !== undefined) return undefined;
        requirement = value;
      }
      index += 1;
      continue;
    }
    return undefined;
  }
  if (
    skill !== "roll-design" ||
    operation !== "design" ||
    requirement === undefined ||
    (containsCanonicalWorkspaceSelector(args) && canonicalWorkspaceSelectorValue(args) === undefined)
  ) return undefined;
  const workspace = canonicalWorkspaceSelectorValue(args);
  return {
    skill,
    operation,
    requirement,
    ...(workspace === undefined ? {} : { workspace }),
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
export function workspaceSkillHandoffCommand(args: readonly string[]): number {
  const parsed = parseArgs(args);
  const json = args.includes("--json");
  if (parsed === undefined) return emitError("invalid_arguments", json);

  const cwd = process.cwd();
  const rollHome = workspaceRollHome();
  const requirement = designRequirementHint([parsed.requirement], cwd);
  const loaded = loadWorkspaceExecutionContext({
    cwd,
    rollHome,
    operation: "mutation",
    scope: "workspace_required_mutation",
    ...(parsed.workspace === undefined ? {} : { explicitWorkspace: parsed.workspace }),
    requirement,
  });

  if (loaded.ok) {
    const prepared = prepareWorkspaceSkillHandoff({
      skillName: parsed.skill,
      scope: "workspace_required_mutation",
      context: loaded.context,
      skillBody: "",
    });
    if (!prepared.ok) return emitError(prepared.code, parsed.json);
    const environmentContext = workspaceSkillHandoffEnvironment(loaded.context)
      .ROLL_WORKSPACE_EXECUTION_CONTEXT;
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
      context: loaded.context,
    }, parsed.json, prepared.skillBody.trimEnd());
  }

  if (loaded.route !== "workspace_target" && loaded.code !== "workspace_discovery_incomplete") {
    return emitError(loaded.code, parsed.json);
  }
  const discovery = loadWorkspaceDiscovery({ rollHome });
  const intent = {
    schema: WORKSPACE_INTENT_V1,
    operation: "mutation" as const,
    interaction: "interactive" as const,
    scope: "workspace_required_mutation" as const,
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
