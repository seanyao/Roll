import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  detectLegacyProject,
  resolveWorkspaceTarget,
  type WorkspaceContextCandidate,
  type WorkspaceRegistryCandidate,
  type WorkspaceTargetFailureCode,
} from "@roll/core";
import { WorkspaceRegistry, type InspectedWorkspace } from "@roll/infra";
import { resolveLang, t, v3Catalog } from "@roll/spec";
import {
  inspectWorkspaceCwd,
  workspaceRegistryCandidates,
  workspaceRollHome,
  workspaceTargetSelector,
  type LegacyWorkspaceProject,
} from "./workspace-target.js";
import { isCanonicalWorkspaceSelectorToken } from "../lib/workspace-selector.js";

export type BacklogOperation = "read" | "mutation";

export interface BacklogTargetInput {
  readonly operation: BacklogOperation;
  readonly registry: readonly WorkspaceRegistryCandidate[];
  readonly all?: boolean;
  readonly explicitWorkspace?: string;
  readonly environmentWorkspace?: string;
  readonly cwdManifest?: WorkspaceContextCandidate;
  readonly legacyProject?: LegacyWorkspaceProject;
  readonly hasReachableWorkspaceManifest?: boolean;
}

export interface BacklogAggregateEntry {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly backlogPath: string;
}

export interface ResolvedBacklogTarget {
  readonly ok: true;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly backlogPath: string;
  readonly storyRoot: string;
  readonly runtimeRoot: string;
  readonly configPath: string;
}

export type BacklogTargetDecision =
  | ResolvedBacklogTarget
  | { readonly ok: true; readonly aggregate: readonly BacklogAggregateEntry[] }
  | { readonly ok: false; readonly code: "migration_required"; readonly migrationCheckCommand: string; readonly candidates: readonly BacklogAggregateEntry[] }
  | { readonly ok: false; readonly code: WorkspaceTargetFailureCode; readonly candidates: readonly BacklogAggregateEntry[] };

function resolvedTarget(workspaceId: string, workspaceRoot: string, canonicalRoot: string): ResolvedBacklogTarget {
  return {
    ok: true,
    workspaceId,
    workspaceRoot,
    canonicalRoot,
    backlogPath: join(workspaceRoot, "backlog", "index.md"),
    storyRoot: join(workspaceRoot, "backlog"),
    runtimeRoot: join(workspaceRoot, "runtime"),
    configPath: join(workspaceRoot, "runtime", "backlog-sync.yaml"),
  };
}

export function resolveBacklogTarget(input: BacklogTargetInput): BacklogTargetDecision {
  const decision = resolveWorkspaceTarget({
    operation: input.operation,
    registry: input.registry,
    ...(input.all === undefined ? {} : { all: input.all }),
    ...(input.explicitWorkspace === undefined ? {} : { explicit: workspaceTargetSelector(input.explicitWorkspace) }),
    ...(input.environmentWorkspace === undefined ? {} : { environment: workspaceTargetSelector(input.environmentWorkspace) }),
    context: { ...(input.cwdManifest === undefined ? {} : { cwdManifest: input.cwdManifest }) },
  });

  if (!decision.ok && decision.error.code === "target_missing" && input.legacyProject !== undefined) {
    const legacy = detectLegacyProject({
      hasBacklogMd: true,
      hasWorkspaceManifest: input.hasReachableWorkspaceManifest === true,
      repositoryRoot: input.legacyProject.repositoryRoot,
    });
    if (legacy.legacy) {
      return { ok: false, code: "migration_required", migrationCheckCommand: legacy.migrationCheckCommand, candidates: [] };
    }
  }

  if (!decision.ok) {
    return {
      ok: false,
      code: decision.error.code,
      candidates: decision.error.candidates.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        workspaceRoot: workspace.root,
        canonicalRoot: workspace.canonicalRoot,
        backlogPath: join(workspace.root, "backlog", "index.md"),
      })),
    };
  }
  if (decision.target.kind === "all") {
    return {
      ok: true,
      aggregate: decision.target.workspaces.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        workspaceRoot: workspace.root,
        canonicalRoot: workspace.canonicalRoot,
        backlogPath: join(workspace.root, "backlog", "index.md"),
      })),
    };
  }
  return resolvedTarget(decision.target.workspaceId, decision.target.root, decision.target.canonicalRoot);
}

export interface BacklogCommandTargetDeps {
  readonly cwd: () => string;
  readonly environmentWorkspace: () => string | undefined;
  readonly inspectRegistry: () => readonly InspectedWorkspace[];
}

export type BacklogTargetResolver = (
  args: readonly string[],
  operation: BacklogOperation,
) => BacklogTargetDecision;

export type BacklogScopedArgs =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false };

export function stripBacklogScopeArgs(args: readonly string[]): BacklogScopedArgs {
  const remaining: string[] = [];
  let workspaceSeen = false;
  let allSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (isCanonicalWorkspaceSelectorToken(arg)) {
      if (workspaceSeen || args[index + 1] === undefined) return { ok: false };
      workspaceSeen = true;
      index += 1;
      continue;
    }
    if (arg === "--all") {
      if (allSeen) return { ok: false };
      allSeen = true;
      continue;
    }
    if (arg !== undefined) remaining.push(arg);
  }
  return { ok: true, args: remaining };
}

function backlogMessage(key: string, ...args: ReadonlyArray<string | number>): string {
  const language = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
  return t(v3Catalog, language, key, ...args);
}

export function emitBacklogTargetError(
  decision: Extract<BacklogTargetDecision, { readonly ok: false }>,
): number {
  process.stderr.write(
    `${backlogMessage("backlog.error.line", decision.code, backlogMessage(`workspace.error.${decision.code}`))}\n`,
  );
  if (decision.candidates.length > 0) {
    const candidates = decision.candidates
      .map((entry) => `${entry.workspaceId}=${entry.workspaceRoot}`)
      .join(", ");
    process.stderr.write(`${backlogMessage("backlog.error.candidates", candidates)}\n`);
  }
  if ("migrationCheckCommand" in decision) {
    process.stderr.write(
      `${backlogMessage("backlog.error.migration_command", decision.migrationCheckCommand)}\n`,
    );
  }
  return 1;
}

export function emitBacklogTarget(target: ResolvedBacklogTarget): void {
  process.stdout.write(
    `${backlogMessage("backlog.title", target.workspaceId, target.canonicalRoot)}\n`,
  );
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Validate an existing target or its nearest existing ancestor against the canonical Workspace root. */
export function workspaceOwnsPath(canonicalRoot: string, targetPath: string): boolean {
  let probe = targetPath;
  while (true) {
    try {
      lstatSync(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
  try {
    return contained(realpathSync(canonicalRoot), realpathSync(probe));
  } catch {
    return false;
  }
}

function realCommandTargetDeps(): BacklogCommandTargetDeps {
  return {
    cwd: () => process.cwd(),
    environmentWorkspace: () => process.env["ROLL_WORKSPACE"],
    inspectRegistry: () => new WorkspaceRegistry({ rollHome: workspaceRollHome() }).inspect(),
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function resolveBacklogCommandTarget(
  args: readonly string[],
  operation: BacklogOperation,
  deps: BacklogCommandTargetDeps = realCommandTargetDeps(),
): BacklogTargetDecision {
  let entries: readonly InspectedWorkspace[];
  try {
    entries = deps.inspectRegistry();
  } catch {
    return { ok: false, code: "invalid_target", candidates: [] };
  }
  const cwdInspection = inspectWorkspaceCwd(deps.cwd(), entries);
  const explicitWorkspace = flagValue(args, "--workspace");
  const environmentWorkspace = deps.environmentWorkspace();
  return resolveBacklogTarget({
    operation,
    registry: workspaceRegistryCandidates(entries),
    all: args.includes("--all"),
    ...(explicitWorkspace === undefined ? {} : { explicitWorkspace }),
    ...(environmentWorkspace === undefined || environmentWorkspace === "" ? {} : { environmentWorkspace }),
    ...(cwdInspection.cwdManifest === undefined ? {} : { cwdManifest: cwdInspection.cwdManifest }),
    ...(cwdInspection.legacyProject === undefined ? {} : { legacyProject: cwdInspection.legacyProject }),
    hasReachableWorkspaceManifest: cwdInspection.hasReachableWorkspaceManifest,
  });
}
