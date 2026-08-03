import type {
  RequirementSourceKey,
  WorkspaceClarificationAnswerV1,
  WorkspaceClarificationAction,
  WorkspaceClarificationCandidateV1,
  WorkspaceClarificationHandoffV1,
  WorkspaceClarificationReason,
  WorkspaceDiscoveryDiagnosticV1,
  WorkspaceIntentV1,
  WorkspaceMatchCandidateV1,
} from "@roll/spec";
import { REQUIREMENT_HINT_PROVENANCES, WORKSPACE_CLARIFICATION_V1 } from "@roll/spec";
import type { WorkspaceDiscoveryFactsV1 } from "./discovery.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

const CLARIFICATION_REASONS = [
  "requirement_match_required",
  "ambiguous_requirement_match",
  "requirement_workspace_conflict",
  "workspace_activation_required",
  "create_required",
  "workspace_discovery_incomplete",
] as const;
const CLARIFICATION_ACTIONS = ["select_existing", "create_new", "repair_discovery"] as const;
const EVIDENCE_KINDS = [
  "issue_exact",
  "requirement_source_exact",
  "repository_exact",
  "path_contained",
  "semantic_supported",
] as const;
const DIAGNOSTIC_CODES = [
  "stale_registry",
  "identity_mismatch",
  "invalid_workspace_manifest",
  "invalid_issue_manifest",
  "symlink_escape",
  "discovery_io_failure",
] as const;

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function sourceToken(source: RequirementSourceKey): string {
  return `${source.provider}\u0000${source.ref}`;
}

function requirementSources(intent: WorkspaceIntentV1): readonly RequirementSourceKey[] {
  const sources = new Map<string, RequirementSourceKey>();
  for (const source of intent.requirement.sources) sources.set(sourceToken(source.key), source.key);
  return [...sources.values()].sort((left, right) => compareText(sourceToken(left), sourceToken(right)));
}

export function workspaceClarificationAllowedActions(input: {
  readonly reason: WorkspaceClarificationReason;
  readonly operation: "read" | "mutation";
  readonly candidateCount: number;
}): readonly WorkspaceClarificationAction[] {
  switch (input.reason) {
    case "requirement_match_required":
      return input.candidateCount > 0 ? ["select_existing", "create_new"] : ["create_new"];
    case "ambiguous_requirement_match":
    case "requirement_workspace_conflict":
    case "workspace_activation_required":
      return ["select_existing"];
    case "create_required":
      return ["create_new"];
    case "workspace_discovery_incomplete":
      return input.operation === "read" ? ["select_existing", "repair_discovery"] : ["repair_discovery"];
  }
}

function clarificationCandidate(input: {
  readonly candidate: WorkspaceMatchCandidateV1;
  readonly facts: WorkspaceDiscoveryFactsV1;
  readonly diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[];
}): WorkspaceClarificationCandidateV1 {
  if (input.candidate.lifecycle === "archived") {
    throw new Error("invalid_workspace_clarification: archived Workspace cannot be a clarification candidate");
  }
  if (input.facts.candidate.workspaceId !== input.candidate.workspaceId) {
    throw new Error("invalid_workspace_clarification: candidate facts do not match Workspace identity");
  }
  return {
    workspaceId: input.candidate.workspaceId,
    displayName: input.facts.manifest.displayName,
    lifecycle: input.candidate.lifecycle,
    evidence: input.candidate.evidence,
    diagnostics: input.diagnostics.filter((entry) => entry.workspaceId === input.candidate.workspaceId),
    canonicalSelector: `--workspace ${input.candidate.workspaceId}`,
  };
}

function repairCommands(diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[]): readonly string[] {
  return uniqueSorted(diagnostics
    .map((entry) => entry.workspaceId)
    .filter((workspaceId) => workspaceId !== "" && workspaceId !== "<registry>")
    .map((workspaceId) => `roll workspace doctor ${workspaceId} --json`));
}

export function buildWorkspaceClarificationHandoff(input: {
  readonly intent: WorkspaceIntentV1;
  readonly reason: WorkspaceClarificationReason;
  readonly candidates: readonly WorkspaceMatchCandidateV1[];
  readonly diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[];
  readonly facts: readonly WorkspaceDiscoveryFactsV1[];
  readonly registryRevision: number;
  readonly discoveryFactsSha256: string;
}): WorkspaceClarificationHandoffV1 {
  if (!Number.isSafeInteger(input.registryRevision) || input.registryRevision < 0) {
    throw new Error("invalid_workspace_clarification: registry revision is invalid");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.discoveryFactsSha256)) {
    throw new Error("invalid_workspace_clarification: discovery facts digest is invalid");
  }
  const factsById = new Map(input.facts.map((facts) => [facts.candidate.workspaceId, facts]));
  const candidates = input.candidates.map((candidate) => {
    const facts = factsById.get(candidate.workspaceId);
    if (facts === undefined) {
      throw new Error(`invalid_workspace_clarification: missing facts for ${candidate.workspaceId}`);
    }
    return clarificationCandidate({ candidate, facts, diagnostics: input.diagnostics });
  });
  const sources = requirementSources(input.intent);
  const storyIds = uniqueSorted(input.intent.requirement.storyIds.map((entry) => entry.storyId));
  const hasStructuredEvidence = sources.length > 0 || storyIds.length > 0 ||
    input.intent.requirement.repositoryRemotes.length > 0 || input.intent.requirement.paths.length > 0;
  const allowedActions = workspaceClarificationAllowedActions({
    reason: input.reason,
    operation: input.intent.operation,
    candidateCount: candidates.length,
  });
  const canonicalRepairCommands = repairCommands(input.diagnostics);
  if (allowedActions.includes("repair_discovery") && canonicalRepairCommands.length === 0) {
    throw new Error("invalid_workspace_clarification: repair action has no canonical command");
  }

  return {
    schema: WORKSPACE_CLARIFICATION_V1,
    registryRevision: input.registryRevision,
    discoveryFactsSha256: input.discoveryFactsSha256,
    reason: input.reason,
    operation: input.intent.operation,
    requirementSummary: {
      sources,
      storyIds,
      hasSemanticOnlyEvidence: !hasStructuredEvidence && (input.intent.requirement.semanticTerms?.length ?? 0) > 0,
    },
    candidates,
    allowedActions,
    canonicalCreateCommand: "roll workspace create",
    canonicalRepairCommands,
  };
}

export type WorkspaceClarificationResolutionV1 =
  | {
      readonly ok: true;
      readonly action: "retry_resolution";
      readonly explicitSelector: { readonly kind: "id"; readonly workspaceId: string };
      readonly canonicalSelector: string;
    }
  | {
      readonly ok: true;
      readonly action: "start_create_preview";
      readonly requestedWorkspaceId?: string;
      readonly canonicalCommand: "roll workspace create";
      readonly applyAuthorized: false;
    }
  | {
      readonly ok: true;
      readonly action: "show_repair_actions";
      readonly commands: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: "invalid_workspace_clarification";
      readonly reload: true;
    };

function invalidClarification(): WorkspaceClarificationResolutionV1 {
  return { ok: false, code: "invalid_workspace_clarification", reload: true };
}

function sameActions(
  actual: readonly WorkspaceClarificationAction[],
  expected: readonly WorkspaceClarificationAction[],
): boolean {
  return actual.length === expected.length && actual.every((action, index) => action === expected[index]);
}

const HANDOFF_KEYS = [
  "schema",
  "registryRevision",
  "discoveryFactsSha256",
  "reason",
  "operation",
  "requirementSummary",
  "candidates",
  "allowedActions",
  "canonicalCreateCommand",
  "canonicalRepairCommands",
] as const;

function closedRequirementSummary(summary: WorkspaceClarificationHandoffV1["requirementSummary"]): boolean {
  if (!isRecord(summary) || !exactKeys(summary, ["sources", "storyIds", "hasSemanticOnlyEvidence"])) return false;
  if (typeof summary.hasSemanticOnlyEvidence !== "boolean") return false;
  if (!Array.isArray(summary.sources) || !summary.sources.every((source) =>
    isRecord(source) && exactKeys(source, ["provider", "ref"]) &&
    isOneOf(source.provider, ["jira", "github_issue", "local_file", "user_input"] as const) &&
    typeof source.ref === "string"
  )) return false;
  return Array.isArray(summary.storyIds) && summary.storyIds.every((storyId) => typeof storyId === "string");
}

function closedEvidence(evidence: unknown): boolean {
  return isRecord(evidence) && exactKeys(evidence, [
    "kind",
    "value",
    "hard",
    "score",
    "source",
    "provenance",
    "detail",
  ]) && isOneOf(evidence["kind"], EVIDENCE_KINDS) && typeof evidence["value"] === "string" &&
    typeof evidence["hard"] === "boolean" && typeof evidence["score"] === "number" &&
    Number.isFinite(evidence["score"]) && typeof evidence["source"] === "string" &&
    isOneOf(evidence["provenance"], REQUIREMENT_HINT_PROVENANCES) && typeof evidence["detail"] === "string";
}

function closedDiagnostic(diagnostic: unknown): boolean {
  return isRecord(diagnostic) &&
    exactKeys(diagnostic, ["workspaceId", "root", "code", "authorityPath", "message"]) &&
    typeof diagnostic["workspaceId"] === "string" && typeof diagnostic["root"] === "string" &&
    isOneOf(diagnostic["code"], DIAGNOSTIC_CODES) && typeof diagnostic["authorityPath"] === "string" &&
    typeof diagnostic["message"] === "string";
}

function closedCandidate(candidate: WorkspaceClarificationCandidateV1): boolean {
  return isRecord(candidate) && exactKeys(candidate, [
    "workspaceId",
    "displayName",
    "lifecycle",
    "evidence",
    "diagnostics",
    "canonicalSelector",
  ]) && typeof candidate.displayName === "string" &&
    Array.isArray(candidate.evidence) && candidate.evidence.every(closedEvidence) &&
    Array.isArray(candidate.diagnostics) && candidate.diagnostics.every(closedDiagnostic);
}

function trustedHandoff(handoff: WorkspaceClarificationHandoffV1): boolean {
  if (
    !isRecord(handoff) || !exactKeys(handoff, HANDOFF_KEYS) ||
    handoff.schema !== WORKSPACE_CLARIFICATION_V1 ||
    !Number.isSafeInteger(handoff.registryRevision) || handoff.registryRevision < 0 ||
    !/^[0-9a-f]{64}$/u.test(handoff.discoveryFactsSha256) ||
    !isOneOf(handoff.reason, CLARIFICATION_REASONS) ||
    !isOneOf(handoff.operation, ["read", "mutation"] as const) ||
    handoff.canonicalCreateCommand !== "roll workspace create" ||
    !closedRequirementSummary(handoff.requirementSummary) ||
    !Array.isArray(handoff.candidates) || !Array.isArray(handoff.allowedActions) ||
    !Array.isArray(handoff.canonicalRepairCommands)
  ) return false;
  if (!handoff.allowedActions.every((action) => isOneOf(action, CLARIFICATION_ACTIONS))) return false;
  const expectedActions = workspaceClarificationAllowedActions({
    reason: handoff.reason,
    operation: handoff.operation,
    candidateCount: handoff.candidates.length,
  });
  if (!sameActions(handoff.allowedActions, expectedActions)) return false;
  const ids = new Set<string>();
  for (const candidate of handoff.candidates) {
    if (
      !closedCandidate(candidate) || !safeWorkspaceId(candidate.workspaceId) || ids.has(candidate.workspaceId) ||
      candidate.canonicalSelector !== `--workspace ${candidate.workspaceId}` ||
      !["registered", "active", "paused"].includes(candidate.lifecycle as string)
    ) return false;
    ids.add(candidate.workspaceId);
  }
  if (handoff.allowedActions.includes("repair_discovery")) {
    if (handoff.canonicalRepairCommands.length === 0) return false;
    if (!handoff.canonicalRepairCommands.every((command) =>
      /^roll workspace doctor [A-Za-z0-9][A-Za-z0-9._-]* --json$/u.test(command)
    )) return false;
  } else if (handoff.canonicalRepairCommands.length > 0) {
    return false;
  }
  return true;
}

function parseClarificationAnswer(value: unknown): WorkspaceClarificationAnswerV1 | undefined {
  if (!isRecord(value) || typeof value["action"] !== "string") return undefined;
  switch (value["action"]) {
    case "select_existing":
      if (!exactKeys(value, ["action", "workspaceId"]) || !safeWorkspaceId(value["workspaceId"])) return undefined;
      return { action: "select_existing", workspaceId: value["workspaceId"] };
    case "create_new":
      if (exactKeys(value, ["action"])) return { action: "create_new" };
      if (!exactKeys(value, ["action", "workspaceId"]) || !safeWorkspaceId(value["workspaceId"])) return undefined;
      return { action: "create_new", workspaceId: value["workspaceId"] };
    case "repair_discovery":
      return exactKeys(value, ["action"]) ? { action: "repair_discovery" } : undefined;
    default:
      return undefined;
  }
}

export function resolveWorkspaceClarificationAnswer(input: {
  readonly handoff: WorkspaceClarificationHandoffV1;
  readonly answer: unknown;
  readonly currentRegistryRevision: number;
  readonly currentDiscoveryFactsSha256: string;
}): WorkspaceClarificationResolutionV1 {
  if (
    !trustedHandoff(input.handoff) ||
    input.currentRegistryRevision !== input.handoff.registryRevision ||
    input.currentDiscoveryFactsSha256 !== input.handoff.discoveryFactsSha256
  ) return invalidClarification();
  const answer = parseClarificationAnswer(input.answer);
  if (answer === undefined || !input.handoff.allowedActions.includes(answer.action)) return invalidClarification();

  switch (answer.action) {
    case "select_existing": {
      const selected = input.handoff.candidates.find((candidate) => candidate.workspaceId === answer.workspaceId);
      if (selected === undefined) return invalidClarification();
      return {
        ok: true,
        action: "retry_resolution",
        explicitSelector: { kind: "id", workspaceId: answer.workspaceId },
        canonicalSelector: `--workspace ${answer.workspaceId}`,
      };
    }
    case "create_new":
      return {
        ok: true,
        action: "start_create_preview",
        ...(answer.workspaceId === undefined ? {} : { requestedWorkspaceId: answer.workspaceId }),
        canonicalCommand: "roll workspace create",
        applyAuthorized: false,
      };
    case "repair_discovery":
      return {
        ok: true,
        action: "show_repair_actions",
        commands: input.handoff.canonicalRepairCommands,
      };
  }
}
