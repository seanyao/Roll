import {
  buildWorkspaceExecutionContext,
  deriveWorkspaceExecutionAuthorities,
  resolveWorkspaceExecutionContextScope,
  resolveWorkspaceTarget,
  validateResolvedTargetRequirement,
} from "@roll/core";
import { loadWorkspaceDiscovery, WorkspaceRegistry } from "@roll/infra";
import type {
  RequirementHintV1,
  WorkspaceContextScope,
  WorkspaceExecutionContextV1,
} from "@roll/spec";
import {
  inspectWorkspaceCwd,
  workspaceRegistryCandidates,
  workspaceRollHome,
  workspaceTargetSelector,
} from "./workspace-target.js";

export type WorkspaceExecutionContextLoadResult =
  | { readonly ok: true; readonly context: WorkspaceExecutionContextV1 }
  | { readonly ok: false; readonly code: string };

/** Resolve and freeze one Workspace context before a skill spawn. */
export function loadWorkspaceExecutionContext(input: {
  readonly cwd: string;
  readonly operation: "read" | "mutation";
  readonly scope: WorkspaceContextScope;
  readonly rollHome?: string;
  readonly explicitWorkspace?: string;
  readonly environmentWorkspace?: string;
  readonly requirement?: RequirementHintV1;
}): WorkspaceExecutionContextLoadResult {
  const rollHome = input.rollHome ?? workspaceRollHome();
  const registry = new WorkspaceRegistry({ rollHome });
  let entries;
  try {
    entries = registry.inspect();
  } catch {
    return { ok: false, code: "workspace_discovery_incomplete" };
  }
  let cwdInspection;
  try {
    cwdInspection = inspectWorkspaceCwd(input.cwd, entries);
  } catch {
    return { ok: false, code: "target_missing" };
  }
  const environmentWorkspace = input.environmentWorkspace ?? process.env["ROLL_WORKSPACE"];
  const target = resolveWorkspaceTarget({
    operation: input.operation,
    registry: workspaceRegistryCandidates(entries),
    ...(input.explicitWorkspace === undefined
      ? {}
      : { explicit: workspaceTargetSelector(input.explicitWorkspace) }),
    ...(environmentWorkspace === undefined || environmentWorkspace.trim() === ""
      ? {}
      : { environment: workspaceTargetSelector(environmentWorkspace) }),
    context: {
      ...(cwdInspection.cwdManifest === undefined ? {} : { cwdManifest: cwdInspection.cwdManifest }),
    },
  });
  if (!target.ok || target.target.kind !== "workspace") {
    return { ok: false, code: target.ok ? "invalid_target" : target.error.code };
  }
  const selected = target.target;

  const discovery = loadWorkspaceDiscovery({ rollHome });
  const facts = discovery.workspaces.find((candidate) => (
    candidate.candidate.workspaceId === selected.workspaceId &&
    candidate.candidate.canonicalRoot === selected.canonicalRoot
  ));
  if (facts === undefined || discovery.diagnostics.some((diagnostic) => (
    diagnostic.workspaceId === selected.workspaceId
  ))) {
    return { ok: false, code: "workspace_discovery_incomplete" };
  }

  let evidence = [] as WorkspaceExecutionContextV1["resolution"]["evidence"];
  if (input.requirement !== undefined) {
    const validated = validateResolvedTargetRequirement({
      target: facts,
      allWorkspaces: discovery.workspaces,
      requirement: input.requirement,
      operation: input.operation,
    });
    if (!validated.ok) return { ok: false, code: validated.code };
    evidence = validated.evidence;
  }
  const source = input.explicitWorkspace !== undefined
    ? "explicit"
    : environmentWorkspace !== undefined && environmentWorkspace.trim() !== ""
      ? "environment"
      : "cwd_manifest";
  const built = buildWorkspaceExecutionContext({
    facts: {
      candidate: facts.candidate,
      manifest: facts.manifest,
      authorities: deriveWorkspaceExecutionAuthorities(facts.candidate.canonicalRoot),
    },
    source,
    evidence,
  });
  if (!built.ok) return { ok: false, code: built.error.code };
  const scoped = resolveWorkspaceExecutionContextScope({ scope: input.scope, context: built.context });
  return scoped.ok && scoped.context !== undefined
    ? { ok: true, context: scoped.context }
    : { ok: false, code: scoped.ok ? "missing_execution_context" : scoped.error.code };
}
