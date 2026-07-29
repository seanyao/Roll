import {
  buildWorkspaceExecutionContext,
  deriveWorkspaceExecutionAuthorities,
  discoverWorkspaceForIntent,
  resolveWorkspaceExecutionContextScope,
  resolveWorkspaceTarget,
  type WorkspaceDiscoveryFactsV1,
  validateResolvedTargetRequirement,
} from "@roll/core";
import { loadWorkspaceDiscovery, WorkspaceRegistry } from "@roll/infra";
import type {
  RequirementHintV1,
  WorkspaceContextScope,
  WorkspaceExecutionContextV1,
  WorkspaceMatchCandidateV1,
} from "@roll/spec";
import { WORKSPACE_INTENT_V1 } from "@roll/spec";
import {
  inspectWorkspaceCwd,
  workspaceRegistryCandidates,
  workspaceRollHome,
  workspaceTargetSelector,
} from "./workspace-target.js";

export type WorkspaceExecutionContextLoadResult =
  | { readonly ok: true; readonly context: WorkspaceExecutionContextV1 }
  | {
      readonly ok: false;
      readonly code: string;
      readonly route?: "workspace_target";
      readonly candidate?: WorkspaceMatchCandidateV1;
    };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function exactWorkspaceIdMention(
  text: string | undefined,
  workspaces: readonly WorkspaceDiscoveryFactsV1[],
): WorkspaceDiscoveryFactsV1 | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  const matches = workspaces
    .filter((facts) => facts.candidate.lifecycle !== "archived")
    .filter((facts) => {
      const id = escapeRegExp(facts.candidate.workspaceId);
      return new RegExp(`(^|[^A-Za-z0-9_-])${id}(?=$|[^A-Za-z0-9_-])`, "iu").test(text);
    });
  return matches.length === 1 ? matches[0] : undefined;
}

function workspaceIdMentionCandidate(facts: WorkspaceDiscoveryFactsV1): WorkspaceMatchCandidateV1 {
  const evidence = [{
    kind: "workspace_id_exact" as const,
    value: facts.candidate.workspaceId,
    hard: true,
    score: 110,
    source: `workspace:${facts.candidate.workspaceId}`,
    provenance: "explicit_user" as const,
    detail: `Owner text named registered Workspace ID ${facts.candidate.workspaceId}`,
  }];
  return {
    workspaceId: facts.candidate.workspaceId,
    root: facts.candidate.canonicalRoot,
    lifecycle: facts.candidate.lifecycle,
    evidence,
    hardMatch: true,
    score: 110,
  };
}

/** Resolve and freeze one Workspace context before a skill spawn. */
export function loadWorkspaceExecutionContext(input: {
  readonly cwd: string;
  readonly operation: "read" | "mutation";
  readonly scope: WorkspaceContextScope;
  readonly rollHome?: string;
  readonly explicitWorkspace?: string;
  readonly environmentWorkspace?: string;
  readonly requirement?: RequirementHintV1;
  /** Raw owner text is used only for an exact registered Workspace ID mention. */
  readonly requirementText?: string;
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
  const discovery = loadWorkspaceDiscovery({ rollHome });
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
  let source: WorkspaceExecutionContextV1["resolution"]["source"];
  let facts;
  let evidence = [] as WorkspaceExecutionContextV1["resolution"]["evidence"];
  if (target.ok && target.target.kind === "workspace") {
    const selected = target.target;
    facts = discovery.workspaces.find((candidate) => (
      candidate.candidate.workspaceId === selected.workspaceId &&
      candidate.candidate.canonicalRoot === selected.canonicalRoot
    ));
    source = input.explicitWorkspace !== undefined
      ? "explicit"
      : environmentWorkspace !== undefined && environmentWorkspace.trim() !== ""
        ? "environment"
        : "cwd_manifest";
  } else if (!target.ok && target.error.code === "target_missing") {
    const mentioned = exactWorkspaceIdMention(input.requirementText, discovery.workspaces);
    if (mentioned !== undefined) {
      const candidate = workspaceIdMentionCandidate(mentioned);
      if (mentioned.candidate.lifecycle !== "active") {
        return {
          ok: false,
          code: "workspace_activation_required",
          route: "workspace_target",
          candidate,
        };
      }
      facts = mentioned;
      source = "requirement_discovery";
      evidence = candidate.evidence;
    } else if (input.requirement !== undefined) {
      const decision = discoverWorkspaceForIntent({
        intent: {
          schema: WORKSPACE_INTENT_V1,
          operation: input.operation,
          interaction: "non_interactive",
          scope: input.scope,
          cwd: input.cwd,
          requirement: input.requirement,
        },
        workspaces: discovery.workspaces,
        diagnostics: discovery.diagnostics,
      });
      if (!decision.ok) return { ok: false, code: decision.code, route: "workspace_target" };
      facts = discovery.workspaces.find((candidate) => (
        candidate.candidate.workspaceId === decision.target.workspaceId &&
        candidate.candidate.canonicalRoot === decision.target.root
      ));
      source = "requirement_discovery";
      evidence = decision.target.evidence;
    } else {
      return { ok: false, code: target.error.code, route: "workspace_target" };
    }
  } else {
    return {
      ok: false,
      code: target.ok ? "invalid_target" : target.error.code,
      ...(!target.ok ? { route: "workspace_target" as const } : {}),
    };
  }
  if (facts === undefined || discovery.diagnostics.some((diagnostic) => (
    diagnostic.workspaceId === facts?.candidate.workspaceId
  ))) {
    return { ok: false, code: "workspace_discovery_incomplete", route: "workspace_target" };
  }

  if (input.requirement !== undefined) {
    const validated = validateResolvedTargetRequirement({
      target: facts,
      allWorkspaces: discovery.workspaces,
      requirement: input.requirement,
      operation: input.operation,
    });
    if (!validated.ok) return { ok: false, code: validated.code, route: "workspace_target" };
    evidence = [...evidence, ...validated.evidence];
  }
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
