import {
  buildWorkspaceContextCompatibilityMatrix,
  type WorkspaceContextCompatibilityMatrixV1,
  type WorkspaceContextSurfaceInventoryItem,
} from "@roll/core";
import { builtinToolDeclarations } from "@roll/infra";
import type {
  WorkspaceContextConsumer,
  WorkspaceContextPolicy,
  WorkspaceContextScope,
} from "@roll/spec";
import { validateWorkspaceContextPolicy } from "@roll/spec";
import {
  type CliCommandOperationRegistration,
  type WorkspaceSelectorOperationDecision,
} from "./command-surface.js";

interface PolicyShape {
  readonly scope: WorkspaceContextScope;
  readonly contextConsumer?: WorkspaceContextConsumer;
  readonly allowsAmbientCwd?: boolean;
  readonly allowsLegacyRollPath?: boolean;
  readonly rationale?: string;
}

const workspaceRead: PolicyShape = { scope: "workspace_required_read", contextConsumer: "workspace" };
const workspaceMutation: PolicyShape = { scope: "workspace_required_mutation", contextConsumer: "workspace" };
const workspaceOptional: PolicyShape = { scope: "workspace_optional_read", contextConsumer: "workspace" };
const issue: PolicyShape = { scope: "issue_required", contextConsumer: "issue" };
const repository: PolicyShape = { scope: "repository_required", contextConsumer: "repository" };
const machine: PolicyShape = { scope: "machine_only" };

const CLI_POLICY_SHAPES: Readonly<Record<string, PolicyShape>> = {
  "help:read": machine,
  "status:read": workspaceOptional, "status:ci": repository, "status:pulse": workspaceOptional,
  "workspace:usage": machine,
  "workspace:create": { ...machine, allowsAmbientCwd: true, rationale: "Creation starts from an explicit config before the target Workspace exists." },
  "workspace:handoff": workspaceMutation,
  "workspace:issue.init": workspaceMutation, "workspace:requirement.add": workspaceMutation,
  "workspace:doctor.read": workspaceRead, "workspace:doctor.repair": workspaceMutation,
  "workspace:migrate": { scope: "legacy_migration_only", allowsAmbientCwd: true, allowsLegacyRollPath: true, rationale: "Migration must inspect an explicitly selected legacy Roll project." },
  "workspace:edit": workspaceMutation, "workspace:list": machine, "workspace:show": workspaceRead,
  "workspace:register": { ...machine, allowsAmbientCwd: true, rationale: "Registration resolves an explicit existing Workspace path into the machine registry." },
  "workspace:activate": workspaceMutation, "workspace:pause": workspaceMutation, "workspace:archive": workspaceMutation,
  "context:usage": machine, "context:status": workspaceRead, "context:read": workspaceRead,
  "delivery:usage": machine, "delivery:list": workspaceRead, "delivery:show": workspaceRead, "delivery:reconcile": workspaceMutation,
  "agent:workspace": workspaceRead, "agent:view": machine, "agent:cast": workspaceOptional, "agent:list": machine,
  "agent:readiness": machine, "agent:disable": machine, "agent:enable": machine, "agent:migrate": machine,
  "agent:default": machine, "agent:set": machine, "agent:use": machine,
  "backlog:read": workspaceRead, "backlog:show": workspaceRead,
  "backlog:block": workspaceMutation, "backlog:defer": workspaceMutation, "backlog:unblock": workspaceMutation,
  "backlog:promote": workspaceMutation, "backlog:claim": workspaceMutation, "backlog:lint": workspaceRead,
  "backlog:unstick": workspaceMutation, "backlog:sync": workspaceMutation,
  "story:new": workspaceMutation, "story:validate": workspaceRead,
  "attest:audit": workspaceRead, "attest:render": workspaceMutation,
  "index:rebuild": workspaceMutation,
  "capture:status": workspaceRead, "capture:migrate": workspaceMutation, "capture:repair": workspaceMutation,
  "capture:local-window": workspaceMutation, "capture:refresh": machine,
  "truth:query": workspaceRead, "truth:audit": workspaceRead,
  "config:read": machine, "config:write": machine, "config:prices": machine, "config:tune": workspaceOptional,
  "release:release": workspaceMutation, "release:showcase": issue, "release:consistency": repository, "release:verify": repository,
  "design:design": workspaceMutation,
  "doctor:diagnose": machine, "doctor:skills": machine, "doctor:tools": machine, "doctor:language": machine, "doctor:pardon": machine,
  "doctor:repair-protection": repository,
  "idea:capture": workspaceMutation,
  "init:onboard": { scope: "legacy_migration_only", allowsAmbientCwd: true, allowsLegacyRollPath: true, rationale: "Onboarding inspects a legacy project before Workspace authority exists." },
  "next:read": workspaceRead, "north:read": workspaceOptional,
  "setup:setup": { ...machine, allowsAmbientCwd: true, rationale: "Machine setup must run before a Workspace is available." },
  "setup:skills": machine, "setup:offboard": { scope: "legacy_migration_only", allowsAmbientCwd: true, allowsLegacyRollPath: true, rationale: "Offboarding inspects an explicitly selected legacy project." },
  "test:run": repository,
  "update:apply": { ...machine, allowsAmbientCwd: true, rationale: "Machine-global updates are independent of Workspace selection." },
};

const LOOP_READ_OPERATIONS = new Set([
  "status", "eval", "story", "runs", "cycles", "cycle", "goal", "signals", "adversarial", "log", "events", "fmt", "watch",
  "fallback.status",
]);
function cliShape(command: string, operation: string): PolicyShape | undefined {
  if (command === "loop") {
    return LOOP_READ_OPERATIONS.has(operation) ? workspaceRead : workspaceMutation;
  }
  const shape = CLI_POLICY_SHAPES[`${command}:${operation}`];
  return shape;
}

function completePolicy(base: Pick<WorkspaceContextPolicy, "surface" | "id" | "operation">, shape: PolicyShape, acceptsWorkspaceSelector = false): WorkspaceContextPolicy {
  return {
    ...base,
    scope: shape.scope,
    allowsAmbientCwd: shape.allowsAmbientCwd ?? false,
    allowsLegacyRollPath: shape.allowsLegacyRollPath ?? false,
    ...(shape.contextConsumer === undefined ? {} : { contextConsumer: shape.contextConsumer }),
    ...(shape.rationale === undefined ? {} : { rationale: shape.rationale }),
    ...(acceptsWorkspaceSelector ? { acceptsWorkspaceSelector: true } : {}),
  };
}

export function cliWorkspaceContextPolicies(
  registrations: readonly CliCommandOperationRegistration[],
): WorkspaceContextPolicy[] {
  return registrations.flatMap((entry) => {
    const shape = cliShape(entry.command, entry.operation);
    return shape === undefined ? [] : [completePolicy(
      { surface: "cli", id: entry.command, operation: entry.operation },
      shape,
      entry.supportsWorkspaceSelector,
    )];
  });
}

/** US-WS-022 generated cases are projected from policy, not a second allowlist. */
export function policyWorkspaceSelectorOperations(
  registrations: readonly CliCommandOperationRegistration[],
): WorkspaceSelectorOperationDecision[] {
  return cliWorkspaceContextPolicies(registrations)
    .filter((policy) => policy.acceptsWorkspaceSelector === true)
    .map((policy) => {
      const registration = registrations.find((entry) =>
        entry.command === policy.id && entry.operation === policy.operation);
      if (registration === undefined) {
        throw new Error(`workspace-context-policy: selector policy lacks a registered route for ${policy.id}:${policy.operation}`);
      }
      return {
        id: `${registration.command}.${registration.operation}`,
        operation: registration.operation,
        command: registration.command,
        route: registration.route,
        canonicalCommand: registration.canonicalCommand,
        exampleArgs: registration.exampleArgs,
        acceptsWorkspaceSelector: true,
      };
    });
}

const TOOL_POLICY_SHAPES: Readonly<Record<string, PolicyShape>> = {
  bash: repository,
  "browser.screenshot": issue,
  "browser.console": issue,
  "browser.dom-query": issue,
  "physical.screenshot": issue,
  "filesystem.stat": repository,
  "filesystem.read": repository,
  "filesystem.write": repository,
  "git.commit": repository,
  "git.status": repository,
  "git.push": repository,
  "git.merge": repository,
  "github.pr": issue,
  "github.ci": issue,
  "network.fetch": issue,
  "mcp.call": issue,
};

export function builtinToolContextPolicies(): WorkspaceContextPolicy[] {
  return Object.entries(TOOL_POLICY_SHAPES).map(([operation, shape]) =>
    completePolicy({ surface: "tool", id: operation.split(".")[0] ?? operation, operation }, shape));
}

export function builtinToolContextInventory(): WorkspaceContextSurfaceInventoryItem[] {
  return builtinToolDeclarations().map((declaration) => ({
    surface: "tool",
    id: String(declaration.id).split(".")[0] ?? String(declaration.id),
    operation: String(declaration.id),
  }));
}

export function cliContextInventory(
  registrations: readonly CliCommandOperationRegistration[],
): WorkspaceContextSurfaceInventoryItem[] {
  return registrations.map((entry) => ({
    surface: "cli",
    id: entry.command,
    operation: entry.operation,
    supportsWorkspaceSelector: entry.supportsWorkspaceSelector,
  }));
}

export function skillContextPoliciesFromManifest(manifest: unknown): WorkspaceContextPolicy[] {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("workspace-context-policy: invalid skills manifest");
  }
  const policies = (manifest as Record<string, unknown>)["workspaceContextPolicies"];
  if (!Array.isArray(policies)) {
    throw new Error("workspace-context-policy: invalid skill policies");
  }
  return policies.map((policy, index) => {
    const issues = validateWorkspaceContextPolicy(policy);
    const surface = typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? (policy as Record<string, unknown>)["surface"]
      : undefined;
    if (issues.length > 0 || surface !== "skill") {
      const details = [
        ...issues.map((issue) => `${issue.path}: ${issue.message}`),
        ...(surface === "skill" ? [] : ["surface: skill manifest policies must use surface 'skill'"]),
      ];
      throw new Error(`workspace-context-policy: invalid skill policy at index ${index}: ${details.join("; ")}`);
    }
    return policy as WorkspaceContextPolicy;
  });
}

export function skillContextInventoryFromManifest(manifest: unknown): WorkspaceContextSurfaceInventoryItem[] {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("workspace-context-policy: invalid skills manifest");
  }
  const declarations = (manifest as Record<string, unknown>)["skillOperations"];
  if (!Array.isArray(declarations)) {
    throw new Error("workspace-context-policy: invalid skill operation declarations");
  }
  const seenIds = new Set<string>();
  const seenOperations = new Set<string>();
  return declarations.flatMap((declaration, index) => {
    if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
      throw new Error(`workspace-context-policy: invalid skill operation declaration at index ${index}`);
    }
    const record = declaration as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => key !== "id" && key !== "operations")) {
      throw new Error(`workspace-context-policy: invalid skill operation declaration at index ${index}: unknown field`);
    }
    const id = record["id"];
    const operations = record["operations"];
    if (typeof id !== "string" || id.trim() === "" || !Array.isArray(operations) || operations.length === 0) {
      throw new Error(`workspace-context-policy: invalid skill operation declaration at index ${index}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`workspace-context-policy: duplicate skill operation declaration for ${id}`);
    }
    seenIds.add(id);
    return operations.map((operation, operationIndex) => {
      if (typeof operation !== "string" || operation.trim() === "") {
        throw new Error(`workspace-context-policy: invalid skill operation at ${index}:${operationIndex}`);
      }
      const identity = `${id}:${operation}`;
      if (seenOperations.has(identity)) {
        throw new Error(`workspace-context-policy: duplicate skill operation ${identity}`);
      }
      seenOperations.add(identity);
      return { surface: "skill" as const, id, operation };
    });
  });
}

export function buildRegisteredWorkspaceContextMatrix(input: {
  readonly cliRegistrations: readonly CliCommandOperationRegistration[];
  readonly skillInventory: readonly WorkspaceContextSurfaceInventoryItem[];
  readonly skillPolicies: readonly WorkspaceContextPolicy[];
}): WorkspaceContextCompatibilityMatrixV1 {
  const inventory = [
    ...cliContextInventory(input.cliRegistrations),
    ...input.skillInventory,
    ...builtinToolContextInventory(),
  ];
  return buildWorkspaceContextCompatibilityMatrix({
    inventory,
    policies: [...cliWorkspaceContextPolicies(input.cliRegistrations), ...input.skillPolicies, ...builtinToolContextPolicies()],
  });
}
