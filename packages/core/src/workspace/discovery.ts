import type {
  IssueManifest,
  RequirementHintV1,
  WorkspaceDiscoveryDecisionV1,
  WorkspaceDiscoveryDiagnosticV1,
  WorkspaceManifest,
  WorkspaceMatchCandidateV1,
  WorkspaceRequirementMatchEvidence,
  WorkspaceIntentV1,
} from "@roll/spec";
import { normalizeRequirementHint } from "./requirement-hint.js";
import { matchWorkspaceRequirement } from "./requirement-match.js";
import type { WorkspaceRegistryCandidate } from "./target.js";

export interface WorkspaceDiscoveryFactsV1 {
  readonly candidate: WorkspaceRegistryCandidate;
  readonly manifest: WorkspaceManifest;
  readonly issues: readonly Pick<IssueManifest, "storyId" | "workspaceId" | "requirements">[];
}

export type ResolvedTargetRequirementValidation =
  | {
      readonly ok: true;
      readonly state: "matched" | "matched_ambiguous" | "unbound";
      readonly evidence: readonly WorkspaceRequirementMatchEvidence[];
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly state: "confirmation_required" | "rejected";
      readonly code: "requirement_workspace_conflict";
      readonly conflicts: readonly WorkspaceMatchCandidateV1[];
    };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidate(left: WorkspaceMatchCandidateV1, right: WorkspaceMatchCandidateV1): number {
  return Number(right.hardMatch) - Number(left.hardMatch) ||
    right.score - left.score ||
    compareText(left.workspaceId, right.workspaceId) ||
    compareText(left.root, right.root);
}

function compareDiagnostic(left: WorkspaceDiscoveryDiagnosticV1, right: WorkspaceDiscoveryDiagnosticV1): number {
  return compareText(left.workspaceId, right.workspaceId) ||
    compareText(left.authorityPath, right.authorityPath) ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message);
}

function candidateFor(
  facts: WorkspaceDiscoveryFactsV1,
  requirement: RequirementHintV1,
): WorkspaceMatchCandidateV1 {
  const match = matchWorkspaceRequirement({
    requirement,
    facts: {
      issues: facts.issues.map((issue) => ({
        storyId: issue.storyId,
        requirements: issue.requirements,
      })),
      requirementSources: facts.manifest.requirements,
      repositories: facts.manifest.repositories.map((repository) => ({
        remote: repository.remote,
        repositoryId: repository.repoId,
      })),
      roots: [facts.candidate.canonicalRoot],
      semanticTerms: [facts.manifest.displayName, facts.manifest.workspaceId],
    },
  });
  return {
    workspaceId: facts.candidate.workspaceId,
    root: facts.candidate.canonicalRoot,
    lifecycle: facts.candidate.lifecycle,
    evidence: match.evidence,
    hardMatch: match.hardMatch,
    score: match.score,
  };
}

function normalizedCandidates(
  workspaces: readonly WorkspaceDiscoveryFactsV1[],
  requirement: RequirementHintV1,
): readonly WorkspaceMatchCandidateV1[] {
  return workspaces
    .filter((facts) => facts.candidate.lifecycle !== "archived")
    .map((facts) => candidateFor(facts, requirement))
    .sort(compareCandidate);
}

function conflictDecision(
  code: "ambiguous_requirement_match" | "invalid_requirement_hint" | "workspace_discovery_incomplete",
  candidates: readonly WorkspaceMatchCandidateV1[],
  diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[],
): WorkspaceDiscoveryDecisionV1 {
  return { ok: false, kind: "conflict", code, candidates, diagnostics };
}

export function discoverWorkspaceForIntent(input: {
  readonly intent: WorkspaceIntentV1;
  readonly workspaces: readonly WorkspaceDiscoveryFactsV1[];
  readonly diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[];
}): WorkspaceDiscoveryDecisionV1 {
  const diagnostics = input.diagnostics.slice().sort(compareDiagnostic);
  const normalized = normalizeRequirementHint(input.intent.requirement);
  if (!normalized.ok) return conflictDecision("invalid_requirement_hint", [], diagnostics);

  const candidates = normalizedCandidates(input.workspaces, normalized.value);
  if (diagnostics.length > 0) {
    return conflictDecision("workspace_discovery_incomplete", candidates, diagnostics);
  }

  const hardMatches = candidates.filter((candidate) => candidate.hardMatch);
  if (hardMatches.length > 1) {
    return conflictDecision("ambiguous_requirement_match", hardMatches, diagnostics);
  }
  const hardMatch = hardMatches[0];
  if (hardMatch !== undefined) {
    if (hardMatch.lifecycle === "active") {
      return { ok: true, kind: "selected", target: hardMatch, diagnostics };
    }
    return {
      ok: false,
      kind: "activation_required",
      code: "workspace_activation_required",
      candidates: [hardMatch],
      diagnostics,
    };
  }
  if (candidates.length === 0) {
    return { ok: false, kind: "create_required", code: "create_required", candidates, diagnostics };
  }
  return {
    ok: false,
    kind: "choice_required",
    code: "requirement_match_required",
    candidates,
    diagnostics,
  };
}

export function validateResolvedTargetRequirement(input: {
  readonly target: WorkspaceDiscoveryFactsV1;
  readonly allWorkspaces: readonly WorkspaceDiscoveryFactsV1[];
  readonly requirement: RequirementHintV1;
  readonly operation: "read" | "mutation";
}): ResolvedTargetRequirementValidation {
  const normalized = normalizeRequirementHint(input.requirement);
  if (!normalized.ok) {
    return {
      ok: false,
      state: input.operation === "read" ? "confirmation_required" : "rejected",
      code: "requirement_workspace_conflict",
      conflicts: [],
    };
  }
  const target = candidateFor(input.target, normalized.value);
  const others = normalizedCandidates(
    input.allWorkspaces.filter((facts) => facts.candidate.workspaceId !== input.target.candidate.workspaceId),
    normalized.value,
  ).filter((candidate) => candidate.hardMatch);

  if (target.hardMatch) {
    if (others.length > 0) {
      return {
        ok: true,
        state: "matched_ambiguous",
        evidence: target.evidence,
        warnings: ["Requirement has duplicate hard ownership; explicit target remains selected"],
      };
    }
    return { ok: true, state: "matched", evidence: target.evidence, warnings: [] };
  }
  if (others.length > 0) {
    return {
      ok: false,
      state: input.operation === "read" ? "confirmation_required" : "rejected",
      code: "requirement_workspace_conflict",
      conflicts: others,
    };
  }
  return {
    ok: true,
    state: "unbound",
    evidence: target.evidence,
    warnings: ["Requirement has no hard Workspace ownership match"],
  };
}
