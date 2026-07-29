import {
  buildWorkspaceClarificationHandoff,
  resolveWorkspaceClarificationAnswer,
  type WorkspaceDiscoveryFactsV1,
} from "@roll/core";
import type {
  WorkspaceClarificationAnswerV1,
  WorkspaceClarificationHandoffV1,
  WorkspaceClarificationReason,
  WorkspaceDiscoveryDiagnosticV1,
  WorkspaceIntentV1,
  WorkspaceMatchCandidateV1,
} from "@roll/spec";

export interface AgentWorkspaceDiscoverySnapshot {
  readonly registryRevision: number;
  readonly discoveryFactsSha256: string;
  readonly workspaces: readonly WorkspaceDiscoveryFactsV1[];
}

export interface AgentWorkspaceClarificationQuestionV1 {
  readonly route: "workspace_target";
  readonly stopped: true;
  readonly handoff: WorkspaceClarificationHandoffV1;
  readonly prompt: string;
}

function requirementText(handoff: WorkspaceClarificationHandoffV1): string {
  const sources = handoff.requirementSummary.sources.map((source) => `${source.provider}:${source.ref}`);
  const facts = [...sources, ...handoff.requirementSummary.storyIds];
  if (facts.length > 0) return facts.join(", ");
  return handoff.requirementSummary.hasSemanticOnlyEvidence ? "semantic-only requirement evidence" : "the current requirement";
}

function candidateText(candidate: WorkspaceClarificationHandoffV1["candidates"][number]): string {
  const evidence = candidate.evidence.length === 0
    ? "no hard requirement evidence"
    : candidate.evidence.map((entry) => `${entry.kind} ${entry.value} (${entry.provenance})`).join(", ");
  const diagnostics = candidate.diagnostics.length === 0
    ? "none"
    : candidate.diagnostics.map((entry) => `${entry.code} at ${entry.authorityPath}`).join(", ");
  return `- ${candidate.workspaceId} (${candidate.lifecycle}): ${evidence}; diagnostics: ${diagnostics}`;
}

export function renderAgentWorkspaceClarification(handoff: WorkspaceClarificationHandoffV1): string {
  const candidates = handoff.candidates.length === 0
    ? "- none"
    : handoff.candidates.map(candidateText).join("\n");
  return [
    `Workspace requirement ${requirementText(handoff)} needs clarification because ${handoff.reason}.`,
    "No Workspace is selected by candidate order, and this clarification step performs no mutation.",
    "",
    "Candidates:",
    candidates,
    "",
    `Choose one allowed action (${handoff.allowedActions.join(", ")})?`,
  ].join("\n");
}

export function beginAgentWorkspaceClarification(input: {
  readonly intent: WorkspaceIntentV1;
  readonly reason: WorkspaceClarificationReason;
  readonly candidates: readonly WorkspaceMatchCandidateV1[];
  readonly diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[];
  readonly discovery: AgentWorkspaceDiscoverySnapshot;
}): AgentWorkspaceClarificationQuestionV1 {
  const handoff = buildWorkspaceClarificationHandoff({
    intent: input.intent,
    reason: input.reason,
    candidates: input.candidates,
    diagnostics: input.diagnostics,
    facts: input.discovery.workspaces,
    registryRevision: input.discovery.registryRevision,
    discoveryFactsSha256: input.discovery.discoveryFactsSha256,
  });
  return {
    route: "workspace_target",
    stopped: true,
    handoff,
    prompt: renderAgentWorkspaceClarification(handoff),
  };
}

export type AgentWorkspaceClarificationContinuation<T> =
  | {
      readonly kind: "resolution_retried";
      readonly stopped: true;
      readonly canonicalSelector: string;
      readonly result: T;
    }
  | {
      readonly kind: "collect_create_input";
      readonly stopped: true;
      readonly requestedWorkspaceId?: string;
      readonly previewCommand: "roll workspace create <ID> --config <path> --check";
      readonly applyAuthorized: false;
    }
  | {
      readonly kind: "repair_actions";
      readonly stopped: true;
      readonly commands: readonly string[];
    }
  | {
      readonly kind: "reload_required";
      readonly stopped: true;
      readonly code: "invalid_workspace_clarification";
    };

export function continueAgentWorkspaceClarification<T>(input: {
  readonly handoff: WorkspaceClarificationHandoffV1;
  readonly answer: WorkspaceClarificationAnswerV1 | unknown;
  readonly currentDiscovery: Pick<AgentWorkspaceDiscoverySnapshot, "registryRevision" | "discoveryFactsSha256">;
  readonly rerunResolver: (selector: { readonly kind: "id"; readonly workspaceId: string }) => T;
}): AgentWorkspaceClarificationContinuation<T> {
  const resolved = resolveWorkspaceClarificationAnswer({
    handoff: input.handoff,
    answer: input.answer,
    currentRegistryRevision: input.currentDiscovery.registryRevision,
    currentDiscoveryFactsSha256: input.currentDiscovery.discoveryFactsSha256,
  });
  if (!resolved.ok) {
    return { kind: "reload_required", stopped: true, code: resolved.code };
  }
  switch (resolved.action) {
    case "retry_resolution":
      return {
        kind: "resolution_retried",
        stopped: true,
        canonicalSelector: resolved.canonicalSelector,
        result: input.rerunResolver(resolved.explicitSelector),
      };
    case "start_create_preview":
      return {
        kind: "collect_create_input",
        stopped: true,
        ...(resolved.requestedWorkspaceId === undefined ? {} : { requestedWorkspaceId: resolved.requestedWorkspaceId }),
        previewCommand: "roll workspace create <ID> --config <path> --check",
        applyAuthorized: false,
      };
    case "show_repair_actions":
      return {
        kind: "repair_actions",
        stopped: true,
        commands: resolved.commands,
      };
  }
}
