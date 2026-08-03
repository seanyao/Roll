import { createHash } from "node:crypto";
import type { JsonSchema } from "./json-schema.js";
import {
  parseWorkspaceContexts,
  workspaceContextsV1Schema,
  type WorkspaceContextsV1,
} from "./context-binding.js";

export const WORKSPACE_MANIFEST_V1 = "roll.workspace/v1" as const;
export const WORKSPACE_EXECUTION_CONTEXT_V1 = "roll.workspace-execution-context/v1" as const;
export const REPOSITORY_BINDING_V1 = "roll.repository-binding/v1" as const;
export const ISSUE_MANIFEST_V1 = "roll.issue/v1" as const;
export const REQUIREMENT_SOURCE_V1 = "roll.requirement-source/v1" as const;
export const REQUIREMENT_ATTEST_PROJECTION_V1 = "roll.requirement-attest-projection/v1" as const;
export const REQUIREMENT_ARCHIVE_AUDIT_V1 = "roll.requirement-archive-audit/v1" as const;
export const REQUIREMENT_HINT_V1 = "roll.requirement-hint/v1" as const;
export const WORKSPACE_INTENT_V1 = "roll.workspace-intent/v1" as const;
export const WORKSPACE_MIGRATION_FACTS_V1 = "roll.workspace-migration-facts/v1" as const;
export const WORKSPACE_MIGRATION_PLAN_V1 = "roll.workspace-migration-plan/v1" as const;
export const WORKSPACE_EDIT_CONFIG_V1 = "roll.workspace-edit/v1" as const;
export const WORKSPACE_METADATA_REFERENCE_INDEX_V1 = "roll.workspace-metadata-reference-index/v1" as const;
export const WORKSPACE_EDIT_PLAN_V1 = "roll.workspace-edit-plan/v1" as const;
export const WORKSPACE_CREATE_APPLY_AUTHORIZATION_V1 = "roll.workspace-create-apply-authorization/v1" as const;
export const WORKSPACE_CLARIFICATION_V1 = "roll.workspace-clarification/v1" as const;

export const REQUIREMENT_HINT_PROVENANCES = [
  "explicit_user",
  "cli_argument",
  "issue_manifest",
  "cwd_repository",
  "deterministic_extraction",
  "semantic_inference",
] as const;

export type Sha256Digest = string;

export interface WorkspaceCreateApplyAuthorizationV1 {
  readonly schema: typeof WORKSPACE_CREATE_APPLY_AUTHORIZATION_V1;
  readonly workspaceId: string;
  readonly configSha256: Sha256Digest;
  readonly planSha256: Sha256Digest;
  readonly source: "direct_cli_apply" | "owner_after_preview";
}

export type HistoricalRemoteTruth =
  | {
      readonly kind: "verified";
      readonly normalizedRemote: string;
      readonly defaultBranch: string;
      readonly defaultTip: string;
      readonly headReachable: true;
      readonly defaultTipPresentLocally: true;
    }
  | {
      readonly kind: "blocked";
      readonly code: "remote_missing" | "remote_default_ambiguous" | "remote_truth_unverifiable" | "head_unpushed";
      readonly normalizedRemote?: string;
      readonly defaultBranch?: string;
      readonly defaultTip?: string;
    };

export interface ProductGitSafetyFacts {
  readonly head: string;
  readonly state: "clean" | "dirty" | "in_flight";
  readonly dirtyPaths: readonly string[];
  readonly operation: "none" | "merge" | "rebase" | "cherry_pick" | "bisect";
  readonly remote: HistoricalRemoteTruth;
}

export interface LinkedWorktreeSafetyFacts {
  readonly pathToken: string;
  readonly head: string;
  readonly state: "clean" | "dirty" | "missing" | "prunable";
}

export interface SubmoduleSafetyFacts {
  readonly path: string;
  readonly head: string | null;
  readonly state: "clean" | "dirty" | "uninitialized" | "conflicted" | "missing";
  readonly remote: HistoricalRemoteTruth | null;
}

export interface HistoricalRuntimeFacts {
  readonly activeCycleIds: readonly string[];
  readonly activeStoryLeases: readonly string[];
}

export type HistoricalRollOwnership =
  | { readonly kind: "ordinary" }
  | { readonly kind: "product_tracked"; readonly trackedPaths: readonly string[] }
  | {
      readonly kind: "independent_git";
      readonly gitdirToken: string;
      readonly topLevelToken: string;
      readonly state: "clean" | "dirty" | "in_flight";
      readonly head: string;
      readonly branch: string | null;
      readonly upstream: string | null;
      readonly normalizedRemote: string | null;
    };

export type HistoricalRollSourceClass =
  | "backlog"
  | "story_contract"
  | "story_evidence"
  | "design"
  | "requirement"
  | "runtime"
  | "projection"
  | "unknown"
  | "rebuildable";

interface HistoricalRollFileBase {
  readonly kind: "file";
  readonly path: string;
  readonly digest: Sha256Digest;
  readonly bytes: number;
}

export type HistoricalRollEntry =
  | (HistoricalRollFileBase & {
      readonly sourceClass: "story_contract" | "story_evidence";
      readonly storyId: string;
    })
  | (HistoricalRollFileBase & {
      readonly sourceClass: Exclude<HistoricalRollSourceClass, "story_contract" | "story_evidence">;
      readonly storyId?: never;
    })
  | {
      readonly kind: "symlink";
      readonly path: string;
      readonly target: string;
    };

export interface RepositoryCacheFacts {
  readonly status: "absent" | "matching" | "conflict";
  readonly repoId: string;
  readonly cachePath: string;
}

export interface WorkspaceRegistryFacts {
  readonly status: "available" | "same_workspace" | "id_conflict" | "repo_conflict";
  readonly workspaceId: string;
}

export interface HistoricalMigrationFacts {
  readonly schema: typeof WORKSPACE_MIGRATION_FACTS_V1;
  readonly sourceRoot: string;
  readonly repoId: string;
  readonly requestedWorkspaceId?: string;
  readonly git: ProductGitSafetyFacts;
  readonly linkedWorktrees: readonly LinkedWorktreeSafetyFacts[];
  readonly submodules: readonly SubmoduleSafetyFacts[];
  readonly runtime: HistoricalRuntimeFacts;
  readonly rollOwnership: HistoricalRollOwnership;
  readonly rollInventory: readonly HistoricalRollEntry[];
  readonly cache: RepositoryCacheFacts;
  readonly registry: WorkspaceRegistryFacts;
}

export type HistoricalMigrationMapping =
  | {
      readonly action: "move_preserve" | "copy_preserve" | "import_inactive" | "archive_regenerate" | "quarantine_unclassified";
      readonly source: string;
      readonly destination: string;
      readonly digest: Sha256Digest;
      readonly reason: string;
    }
  | {
      readonly action: "discard_rebuildable";
      readonly source: string;
      readonly destination: null;
      readonly digest: Sha256Digest;
      readonly reason: string;
    };

export type HistoricalMigrationInfoFinding = {
  readonly severity: "info";
  readonly code: "workspace_id_defaulted" | "cache_create_planned";
  readonly path?: string;
};

export type HistoricalMigrationErrorFinding = {
  readonly severity: "error";
  readonly code:
    | "product_dirty"
    | "product_operation_in_flight"
    | "head_unpushed"
    | "remote_missing"
    | "remote_default_ambiguous"
    | "remote_truth_unverifiable"
    | "linked_worktree_unsafe"
    | "submodule_unsafe"
    | "active_runtime"
    | "roll_symlink_unsupported"
    | "cache_conflict"
    | "workspace_conflict";
  readonly path?: string;
};

export type HistoricalMigrationFinding = HistoricalMigrationInfoFinding | HistoricalMigrationErrorFinding;

export interface RollMetaHandoffFacts {
  readonly gitdirToken: string;
  readonly topLevelToken: string;
  readonly state: "clean" | "dirty" | "in_flight";
  readonly head: string;
  readonly branch: string | null;
  readonly upstream: string | null;
  readonly normalizedRemote: string | null;
}

export interface RepositoryCutoverEntry {
  readonly path: string;
  readonly digest: Sha256Digest;
}

export interface RepositoryCutoverPlan {
  readonly sourceHead: string;
  readonly trackedEntries: readonly RepositoryCutoverEntry[];
  readonly requiredAction: "remove_product_tracking_through_existing_tcr_pr_push_flow";
}

interface HistoricalMigrationPlanBase {
  readonly schema: typeof WORKSPACE_MIGRATION_PLAN_V1;
  readonly planId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly repository: {
    readonly alias: "primary";
    readonly repoId: string;
    readonly integrationBranch?: string;
    readonly cachePath: string;
  };
  readonly mappings: readonly HistoricalMigrationMapping[];
  readonly findings: readonly HistoricalMigrationFinding[];
}

export type HistoricalMigrationPlan =
  | (HistoricalMigrationPlanBase & {
      readonly verdict: "ready";
      readonly repository: HistoricalMigrationPlanBase["repository"] & { readonly integrationBranch: string };
    })
  | (HistoricalMigrationPlanBase & {
      readonly verdict: "migration_blocked";
      readonly findings: readonly [HistoricalMigrationErrorFinding, ...HistoricalMigrationFinding[]];
    })
  | (HistoricalMigrationPlanBase & {
      readonly verdict: "repository_cutover_required";
      readonly repository: HistoricalMigrationPlanBase["repository"] & { readonly integrationBranch: string };
      readonly repositoryCutover: RepositoryCutoverPlan;
    })
  | (HistoricalMigrationPlanBase & {
      readonly verdict: "manual_metadata_handoff";
      readonly repository: HistoricalMigrationPlanBase["repository"] & { readonly integrationBranch: string };
      readonly manualHandoff: RollMetaHandoffFacts;
    });

export type ContractErrorCode =
  | "invalid_type"
  | "unknown_version"
  | "unknown_field"
  | "invalid_value"
  | "identity_mismatch"
  | "duplicate_identity"
  | "unsafe_remote"
  | "repo_id_mismatch";

export interface ContractError {
  readonly code: ContractErrorCode;
  readonly path: string;
  readonly message: string;
}

export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly ContractError[] };

export interface RequirementSourceReference {
  readonly provider: string;
  readonly ref: string;
}

export type RequirementProvider = "jira" | "github_issue" | "local_file" | "user_input";

export type RequirementHintProvenance = typeof REQUIREMENT_HINT_PROVENANCES[number];
export type StructuredRequirementProvenance = Exclude<
  RequirementHintProvenance,
  "cwd_repository" | "semantic_inference"
>;
export type RepositoryHintProvenance = Exclude<RequirementHintProvenance, "semantic_inference">;

export interface RequirementSourceKey {
  readonly provider: RequirementProvider;
  readonly ref: string;
}

export interface RequirementHintV1 {
  readonly schema: typeof REQUIREMENT_HINT_V1;
  readonly sources: readonly {
    readonly key: RequirementSourceKey;
    readonly provenance: StructuredRequirementProvenance;
  }[];
  readonly storyIds: readonly {
    readonly storyId: string;
    readonly provenance: StructuredRequirementProvenance;
  }[];
  readonly repositoryRemotes: readonly {
    readonly remote: string;
    readonly provenance: RepositoryHintProvenance;
  }[];
  readonly paths: readonly {
    readonly path: string;
    readonly provenance: RepositoryHintProvenance;
  }[];
  readonly semanticTerms?: readonly string[];
}

export type WorkspaceMatchEvidenceKind =
  | "issue_exact"
  | "requirement_source_exact"
  | "repository_exact"
  | "path_contained"
  | "semantic_supported";

export interface WorkspaceMatchEvidence {
  readonly kind: WorkspaceMatchEvidenceKind;
  readonly value: string;
  readonly hard: boolean;
  readonly score: number;
  readonly source: string;
  readonly provenance: RequirementHintProvenance;
  readonly detail: string;
}

/** Backward-compatible name retained for requirement matching consumers. */
export type WorkspaceRequirementMatchEvidenceKind = WorkspaceMatchEvidenceKind;
export type WorkspaceRequirementMatchEvidence = WorkspaceMatchEvidence;

export type WorkspaceContextScope =
  | "machine_only"
  | "workspace_optional_read"
  | "workspace_required_read"
  | "workspace_required_mutation"
  | "issue_required"
  | "repository_required"
  | "legacy_migration_only";

export type WorkspaceContextPolicySurface = "cli" | "skill" | "tool";

/** Closed identity of the public operation that was allowed to enter a
 * Workspace context fallback scope. The scope alone is never authorization. */
export interface WorkspaceContextOperationProvenance {
  readonly surface: WorkspaceContextPolicySurface;
  readonly id: string;
  readonly operation: string;
}

export type WorkspaceContextConsumer = "workspace" | "issue" | "repository";
export type WorkspaceContextAccess = "none" | "read" | "mutation";
export type WorkspaceRepositorySelectorPolicy = "not_applicable" | "required" | "forbidden";
export type WorkspaceContextEffectTarget = "none" | "workspace" | "issue" | "repository" | "machine" | "legacy_project";

export const WORKSPACE_CONTEXT_POLICY_SURFACES = ["cli", "skill", "tool"] as const;
export const WORKSPACE_CONTEXT_POLICY_SCOPES = [
  "machine_only",
  "workspace_optional_read",
  "workspace_required_read",
  "workspace_required_mutation",
  "issue_required",
  "repository_required",
  "legacy_migration_only",
] as const;
export const WORKSPACE_CONTEXT_POLICY_CONSUMERS = ["workspace", "issue", "repository"] as const;
export const WORKSPACE_CONTEXT_POLICY_ACCESS = ["none", "read", "mutation"] as const;
export const WORKSPACE_REPOSITORY_SELECTOR_POLICIES = ["not_applicable", "required", "forbidden"] as const;
export const WORKSPACE_CONTEXT_EFFECT_TARGETS = ["none", "workspace", "issue", "repository", "machine", "legacy_project"] as const;

const WORKSPACE_CONTEXT_POLICY_KEYS = new Set([
  "surface",
  "id",
  "operation",
  "scope",
  "allowsAmbientCwd",
  "allowsLegacyRollPath",
  "acceptsWorkspaceSelector",
  "contextConsumer",
  "effectTarget",
  "access",
  "repositorySelector",
  "rationale",
]);

const WORKSPACE_CONTEXT_POLICY_REQUIRED_KEYS = [
  "surface",
  "id",
  "operation",
  "scope",
  "allowsAmbientCwd",
  "allowsLegacyRollPath",
] as const;

const WORKSPACE_CONTEXT_EXPECTED_CONSUMER: Readonly<Partial<Record<WorkspaceContextScope, WorkspaceContextConsumer>>> = {
  workspace_optional_read: "workspace",
  workspace_required_read: "workspace",
  workspace_required_mutation: "workspace",
  issue_required: "issue",
  repository_required: "repository",
};

export type WorkspaceContextPolicyValidationCode =
  | "invalid_type"
  | "missing_key"
  | "unknown_key"
  | "invalid_surface"
  | "invalid_scope"
  | "invalid_consumer"
  | "invalid_scope_consumer"
  | "invalid_value";

export interface WorkspaceContextPolicyValidationIssue {
  readonly code: WorkspaceContextPolicyValidationCode;
  readonly path: string;
  readonly message: string;
}

/** Closed, operation-level declaration for every public Workspace-aware surface. */
export interface WorkspaceContextPolicy {
  readonly surface: WorkspaceContextPolicySurface;
  readonly id: string;
  readonly operation: string;
  readonly scope: WorkspaceContextScope;
  readonly allowsAmbientCwd: boolean;
  readonly allowsLegacyRollPath: boolean;
  readonly acceptsWorkspaceSelector?: boolean;
  readonly contextConsumer?: WorkspaceContextConsumer;
  readonly effectTarget?: WorkspaceContextEffectTarget;
  readonly access?: WorkspaceContextAccess;
  readonly repositorySelector?: WorkspaceRepositorySelectorPolicy;
  readonly rationale?: string;
}

/** Strict runtime validator for the closed WorkspaceContextPolicy schema. */
export function validateWorkspaceContextPolicy(value: unknown): WorkspaceContextPolicyValidationIssue[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ code: "invalid_type", path: "$", message: "policy must be an object" }];
  }
  const item = value as Record<string, unknown>;
  const issues: WorkspaceContextPolicyValidationIssue[] = [];
  for (const key of Object.keys(item).sort()) {
    if (!WORKSPACE_CONTEXT_POLICY_KEYS.has(key)) {
      issues.push({ code: "unknown_key", path: key, message: `unknown policy key '${key}'` });
    }
  }
  for (const key of WORKSPACE_CONTEXT_POLICY_REQUIRED_KEYS) {
    if (!Object.hasOwn(item, key)) {
      issues.push({ code: "missing_key", path: key, message: `missing required policy key '${key}'` });
    }
  }
  if (typeof item["surface"] !== "string") {
    issues.push({ code: "invalid_type", path: "surface", message: "surface must be a string" });
  } else if (!(WORKSPACE_CONTEXT_POLICY_SURFACES as readonly string[]).includes(item["surface"])) {
    issues.push({ code: "invalid_surface", path: "surface", message: `unknown policy surface '${item["surface"]}'` });
  }
  for (const key of ["id", "operation"] as const) {
    const field = item[key];
    if (typeof field !== "string") {
      issues.push({ code: "invalid_type", path: key, message: `${key} must be a string` });
    } else if (field.trim() === "") {
      issues.push({ code: "invalid_value", path: key, message: `${key} must not be empty` });
    }
  }
  const scope = item["scope"];
  const validScope = typeof scope === "string"
    && (WORKSPACE_CONTEXT_POLICY_SCOPES as readonly string[]).includes(scope);
  if (typeof scope !== "string") {
    issues.push({ code: "invalid_type", path: "scope", message: "scope must be a string" });
  } else if (!validScope) {
    issues.push({ code: "invalid_scope", path: "scope", message: `unknown policy scope '${scope}'` });
  }
  for (const key of ["allowsAmbientCwd", "allowsLegacyRollPath"] as const) {
    if (typeof item[key] !== "boolean") {
      issues.push({ code: "invalid_type", path: key, message: `${key} must be a boolean` });
    }
  }
  if (Object.hasOwn(item, "acceptsWorkspaceSelector") && typeof item["acceptsWorkspaceSelector"] !== "boolean") {
    issues.push({ code: "invalid_type", path: "acceptsWorkspaceSelector", message: "acceptsWorkspaceSelector must be a boolean" });
  }
  const consumer = item["contextConsumer"];
  const hasConsumer = Object.hasOwn(item, "contextConsumer");
  const validConsumer = typeof consumer === "string"
    && (WORKSPACE_CONTEXT_POLICY_CONSUMERS as readonly string[]).includes(consumer);
  if (hasConsumer && typeof consumer !== "string") {
    issues.push({ code: "invalid_type", path: "contextConsumer", message: "contextConsumer must be a string" });
  } else if (hasConsumer && !validConsumer) {
    issues.push({ code: "invalid_consumer", path: "contextConsumer", message: `unknown context consumer '${String(consumer)}'` });
  }
  if (Object.hasOwn(item, "access")) {
    const access = item["access"];
    if (typeof access !== "string") {
      issues.push({ code: "invalid_type", path: "access", message: "access must be a string" });
    } else if (!(WORKSPACE_CONTEXT_POLICY_ACCESS as readonly string[]).includes(access)) {
      issues.push({ code: "invalid_value", path: "access", message: `unknown policy access '${access}'` });
    }
  }
  if (Object.hasOwn(item, "effectTarget")) {
    const target = item["effectTarget"];
    if (typeof target !== "string") {
      issues.push({ code: "invalid_type", path: "effectTarget", message: "effectTarget must be a string" });
    } else if (!(WORKSPACE_CONTEXT_EFFECT_TARGETS as readonly string[]).includes(target)) {
      issues.push({ code: "invalid_value", path: "effectTarget", message: `unknown effect target '${target}'` });
    }
  }
  if (Object.hasOwn(item, "repositorySelector")) {
    const selector = item["repositorySelector"];
    if (typeof selector !== "string") {
      issues.push({ code: "invalid_type", path: "repositorySelector", message: "repositorySelector must be a string" });
    } else if (!(WORKSPACE_REPOSITORY_SELECTOR_POLICIES as readonly string[]).includes(selector)) {
      issues.push({ code: "invalid_value", path: "repositorySelector", message: `unknown repository selector policy '${selector}'` });
    }
  }
  if (Object.hasOwn(item, "rationale") && typeof item["rationale"] !== "string") {
    issues.push({ code: "invalid_type", path: "rationale", message: "rationale must be a string" });
  }
  if (validScope && (!hasConsumer || validConsumer)) {
    const expected = WORKSPACE_CONTEXT_EXPECTED_CONSUMER[scope as WorkspaceContextScope];
    const actual = hasConsumer ? consumer as WorkspaceContextConsumer : undefined;
    if (actual !== expected) {
      issues.push({
        code: "invalid_scope_consumer",
        path: "contextConsumer",
        message: `scope '${scope}' requires contextConsumer '${expected ?? "none"}'`,
      });
    }
  }
  return issues;
}

export type WorkspaceExecutionContextResolutionSource =
  | "explicit"
  | "environment"
  | "cwd_manifest"
  | "issue_manifest"
  | "requirement_discovery";

export interface WorkspaceExecutionAuthorityPaths {
  readonly backlog: string;
  readonly features: string;
  readonly design: string;
  readonly requirements: string;
  readonly policy: string;
  readonly evidence: string;
  readonly toolDumps: string;
  readonly events: string;
  readonly runtime: string;
  readonly locks: string;
}

export interface WorkspaceExecutionContextV1 {
  readonly schema: typeof WORKSPACE_EXECUTION_CONTEXT_V1;
  readonly workspace: {
    readonly workspaceId: string;
    readonly root: string;
    readonly canonicalRoot: string;
    readonly lifecycle: WorkspaceLifecycle;
  };
  readonly resolution: {
    readonly source: WorkspaceExecutionContextResolutionSource;
    readonly evidence: readonly WorkspaceMatchEvidence[];
  };
  readonly bindings: readonly RepositoryBinding[];
  readonly contexts?: WorkspaceContextsV1;
  readonly issue?: {
    readonly storyId: string;
    readonly manifestPath: string;
    readonly execution: CycleRepositoryExecutionContext;
  };
  readonly authorities: WorkspaceExecutionAuthorityPaths;
}

export interface WorkspaceIntentV1 {
  readonly schema: typeof WORKSPACE_INTENT_V1;
  readonly operation: "read" | "mutation";
  readonly interaction: "interactive" | "non_interactive";
  readonly scope: WorkspaceContextScope;
  readonly cwd: string;
  readonly explicitSelector?: {
    readonly workspaceId?: string;
    readonly path?: string;
  };
  readonly requirement: RequirementHintV1;
}

export interface WorkspaceMatchCandidateV1 {
  readonly workspaceId: string;
  readonly root: string;
  readonly lifecycle: WorkspaceLifecycle;
  readonly evidence: readonly WorkspaceRequirementMatchEvidence[];
  readonly hardMatch: boolean;
  readonly score: number;
}

export type WorkspaceDiscoveryDiagnosticCode =
  | "stale_registry"
  | "identity_mismatch"
  | "invalid_workspace_manifest"
  | "invalid_issue_manifest"
  | "symlink_escape"
  | "discovery_io_failure";

export interface WorkspaceDiscoveryDiagnosticV1 {
  readonly workspaceId: string;
  readonly root: string;
  readonly code: WorkspaceDiscoveryDiagnosticCode;
  readonly authorityPath: string;
  readonly message: string;
}

export type WorkspaceDiscoveryDecisionV1 = (
  | {
      readonly ok: true;
      readonly kind: "selected";
      readonly target: WorkspaceMatchCandidateV1;
    }
  | {
      readonly ok: false;
      readonly kind: "choice_required";
      readonly code: "requirement_match_required";
      readonly candidates: readonly WorkspaceMatchCandidateV1[];
    }
  | {
      readonly ok: false;
      readonly kind: "create_required";
      readonly code: "create_required";
      readonly candidates: readonly WorkspaceMatchCandidateV1[];
    }
  | {
      readonly ok: false;
      readonly kind: "activation_required";
      readonly code: "workspace_activation_required";
      readonly candidates: readonly WorkspaceMatchCandidateV1[];
    }
  | {
      readonly ok: false;
      readonly kind: "conflict";
      readonly code:
        | "ambiguous_requirement_match"
        | "invalid_requirement_hint"
        | "workspace_discovery_incomplete";
      readonly candidates: readonly WorkspaceMatchCandidateV1[];
    }
) & { readonly diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[] };

export type WorkspaceClarificationReason =
  | "requirement_match_required"
  | "ambiguous_requirement_match"
  | "requirement_workspace_conflict"
  | "workspace_activation_required"
  | "create_required"
  | "workspace_discovery_incomplete";

export type WorkspaceClarificationAction =
  | "select_existing"
  | "create_new"
  | "repair_discovery";

export interface WorkspaceClarificationCandidateV1 {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly lifecycle: Exclude<WorkspaceLifecycle, "archived">;
  readonly evidence: readonly WorkspaceMatchEvidence[];
  readonly diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[];
  readonly canonicalSelector: string;
}

export interface WorkspaceClarificationHandoffV1 {
  readonly schema: typeof WORKSPACE_CLARIFICATION_V1;
  readonly registryRevision: number;
  readonly discoveryFactsSha256: Sha256Digest;
  readonly reason: WorkspaceClarificationReason;
  readonly operation: "read" | "mutation";
  readonly requirementSummary: {
    readonly sources: readonly RequirementSourceKey[];
    readonly storyIds: readonly string[];
    readonly hasSemanticOnlyEvidence: boolean;
  };
  readonly candidates: readonly WorkspaceClarificationCandidateV1[];
  readonly allowedActions: readonly WorkspaceClarificationAction[];
  readonly canonicalCreateCommand: "roll workspace create";
  readonly canonicalRepairCommands: readonly string[];
}

export type WorkspaceClarificationAnswerV1 =
  | {
      readonly action: "select_existing";
      readonly workspaceId: string;
    }
  | {
      readonly action: "create_new";
      readonly workspaceId?: string;
    }
  | {
      readonly action: "repair_discovery";
    };

export interface RequirementEvidenceDescriptor {
  readonly bytes: number;
  readonly sha256: string;
}

export interface RequirementContextDescriptor extends RequirementEvidenceDescriptor {
  readonly path: string;
}

export interface RequirementPreviousRevision {
  readonly revision: string;
  readonly capturedAt: string;
}

export interface RequirementAttestProjectionContract {
  readonly schema: typeof REQUIREMENT_ATTEST_PROJECTION_V1;
  readonly mode: "generated_aggregate";
  readonly evidenceAuthority: "issue";
}

export interface CampaignDeliveryTarget {
  readonly terminal: "campaign_branch";
  readonly branch: string;
  readonly mainMerge: "forbidden";
}

export interface RequirementSourceManifest {
  readonly schema: typeof REQUIREMENT_SOURCE_V1;
  readonly requirementId: string;
  readonly provider: RequirementProvider;
  readonly ref: string;
  readonly revision: string;
  readonly capturedAt: string;
  readonly previousRevisions: readonly RequirementPreviousRevision[];
  readonly requirement: RequirementEvidenceDescriptor;
  readonly context: readonly RequirementContextDescriptor[];
  readonly stories: readonly string[];
  readonly attest: RequirementAttestProjectionContract;
  readonly deliveryTarget?: CampaignDeliveryTarget;
}

export type RequirementArchiveFindingCode =
  | "manifest_invalid"
  | "revision_missing"
  | "revision_metadata_mismatch"
  | "content_digest_mismatch"
  | "context_digest_mismatch"
  | "unsafe_archive_path"
  | "archive_changed_during_read";

export interface RequirementArchiveFinding {
  readonly code: RequirementArchiveFindingCode;
  readonly revision?: string;
  readonly evidencePath: string;
}

/**
 * V1 consistency result for the source revision graph and its declared evidence digests.
 * It is not cryptographic proof against a coordinated rewrite of both authority and evidence.
 */
export interface RequirementArchiveAudit {
  readonly schema: typeof REQUIREMENT_ARCHIVE_AUDIT_V1;
  readonly requirementId: string;
  readonly status: "healthy" | "corrupt" | "untrusted";
  readonly checkedRevisions: readonly string[];
  readonly findings: readonly RequirementArchiveFinding[];
}

export interface RepositoryWorkflowMetadata {
  readonly branchPattern: string;
  readonly requiredChecks: readonly string[];
}

export interface RepositoryBinding {
  readonly schema: typeof REPOSITORY_BINDING_V1;
  readonly repoId: string;
  readonly alias: string;
  readonly remote: string;
  readonly integrationBranch: string;
  readonly provider: string;
  readonly workflow: RepositoryWorkflowMetadata;
}

export interface WorkspaceManifest {
  readonly schema: typeof WORKSPACE_MANIFEST_V1;
  readonly workspaceId: string;
  readonly displayName: string;
  readonly createdAt?: string;
  readonly requirements: readonly RequirementSourceReference[];
  readonly repositories: readonly RepositoryBinding[];
  readonly contexts?: WorkspaceContextsV1;
}

export interface WorkspaceEditRepositoryInput {
  readonly alias: string;
  readonly remote: string;
  readonly provider: string;
  readonly integrationBranch: string;
  readonly branchPattern: string;
  readonly requiredChecks: readonly string[];
}

export interface WorkspaceEditConfigV1 {
  readonly schema: typeof WORKSPACE_EDIT_CONFIG_V1;
  readonly workspaceId: string;
  readonly expectedManifestSha256: Sha256Digest;
  readonly displayName: string;
  readonly requirements: readonly RequirementSourceReference[];
  readonly repositories: readonly WorkspaceEditRepositoryInput[];
}

export interface WorkspaceMetadataIssueReference {
  readonly storyId: string;
  readonly manifestSha256: Sha256Digest;
  readonly requirementKeys: readonly RequirementSourceReference[];
  readonly repoIds: readonly string[];
}

export interface WorkspaceMetadataRequirementArchiveReference {
  readonly requirementId: string;
  readonly source: RequirementSourceReference;
  readonly manifestSha256: Sha256Digest;
}

export interface WorkspaceMetadataAdditionalFact {
  readonly kind: "delivery" | "runtime" | "event" | "migration";
  readonly authorityPath: string;
  readonly sha256: Sha256Digest;
  readonly requirementKeys: readonly RequirementSourceReference[];
  readonly repoIds: readonly string[];
}

export interface WorkspaceMetadataReferenceIndex {
  readonly schema: typeof WORKSPACE_METADATA_REFERENCE_INDEX_V1;
  readonly workspaceId: string;
  readonly issues: readonly WorkspaceMetadataIssueReference[];
  readonly requirementArchives: readonly WorkspaceMetadataRequirementArchiveReference[];
  readonly additionalFacts: readonly WorkspaceMetadataAdditionalFact[];
}

export type WorkspaceEditChangeKind =
  | "display_name"
  | "requirement"
  | "repository_identity"
  | "repository_workflow"
  | "repository";

export interface WorkspaceEditChange {
  readonly kind: WorkspaceEditChangeKind;
  readonly path: string;
  readonly operation: "added" | "removed" | "updated";
  readonly before?: unknown;
  readonly after?: unknown;
  readonly safety: "safe" | "blocked";
}

export interface WorkspaceEditReference {
  readonly kind: "issue_requirement" | "issue_repository" | "requirement_archive" | "additional_fact";
  readonly authorityPath: string;
  readonly storyId?: string;
  readonly requirementId?: string;
  readonly repoId?: string;
}

export type WorkspaceEditBlockerCode =
  | "manifest_changed"
  | "metadata_referenced"
  | "normalization_failed"
  | "reference_index_invalid";

export interface WorkspaceEditBlocker {
  readonly code: WorkspaceEditBlockerCode;
  readonly path: string;
  readonly message: string;
  readonly references: readonly WorkspaceEditReference[];
}

export interface WorkspaceEditWarning {
  readonly code: "requirement_capture_pending";
  readonly path: string;
  readonly message: string;
}

export interface WorkspaceEditPlan {
  readonly schema: typeof WORKSPACE_EDIT_PLAN_V1;
  readonly outcome: "ready" | "blocked";
  readonly workspaceId: string;
  readonly manifestPath: string;
  readonly beforeSha256: Sha256Digest;
  readonly afterSha256: Sha256Digest;
  readonly referenceIndexSha256: Sha256Digest;
  readonly beforeManifest: WorkspaceManifest;
  readonly afterManifest: WorkspaceManifest;
  readonly changes: readonly WorkspaceEditChange[];
  readonly blockers: readonly WorkspaceEditBlocker[];
  readonly warnings: readonly WorkspaceEditWarning[];
  readonly nextAction: {
    readonly kind: "apply" | "blocked";
    readonly command?: string;
  };
}

export interface WorkspaceManifestExpectations {
  workspaceId?: string;
}

export interface WorkspaceIdentity {
  readonly workspaceId: string;
}

export const WORKSPACE_EVENT_V1 = "roll.workspace-event/v1" as const;

export type WorkspaceLifecycle = "registered" | "active" | "paused" | "archived";

interface WorkspaceEventBase extends WorkspaceIdentity {
  readonly schema: typeof WORKSPACE_EVENT_V1;
  readonly ts: number;
}

export type WorkspaceLifecycleEvent =
  | (WorkspaceEventBase & { readonly type: "workspace:registered" })
  | (WorkspaceEventBase & { readonly type: "workspace:activated" })
  | (WorkspaceEventBase & { readonly type: "workspace:paused" })
  | (WorkspaceEventBase & { readonly type: "workspace:archived" })
  | (WorkspaceEventBase & {
      readonly type: "workspace:path_updated";
      readonly oldRoot: string;
      readonly newRoot: string;
    });

export interface IssueIdentity extends WorkspaceIdentity {
  readonly storyId: string;
}

export interface RepositoryIssueIdentity extends IssueIdentity {
  readonly repoId: string;
}

export type RepositoryAccess = "read" | "write";
export type NoChangePolicy = "changes_required" | "no_change_allowed";

interface IssueRepositoryTargetBase {
  readonly repoId: string;
  readonly alias: string;
  /** Exact remote branch or tag ref used only for this Issue's first base pin. */
  readonly baseRef?: string;
  readonly pathScope?: readonly string[];
  readonly dependsOnRepo?: string;
}

export interface ReadIssueRepositoryTarget extends IssueRepositoryTargetBase {
  readonly access: "read";
  readonly requiredDelivery: false;
  readonly noChangePolicy?: never;
}

export interface WriteIssueRepositoryTarget extends IssueRepositoryTargetBase {
  readonly access: "write";
  readonly requiredDelivery: boolean;
  readonly noChangePolicy: NoChangePolicy;
  /** Immutable governed branch resolved when the Issue is initialized. */
  readonly workBranch?: string;
}

export type IssueRepositoryTarget = ReadIssueRepositoryTarget | WriteIssueRepositoryTarget;

/** Commands declared by one repository leg for the Builder and later
 * repository-scoped verification gates. Commands are data only; the pure
 * orchestrator never executes or infers them from agent output. */
export interface RepositoryExecutionCommands {
  readonly test: readonly string[];
  readonly integration: readonly string[];
}

/** Resolved execution facts for one repository bound to an Issue Cycle. */
export interface RepositoryExecutionContext {
  readonly repoId: string;
  readonly alias: string;
  readonly access: RepositoryAccess;
  readonly requiredDelivery: boolean;
  readonly noChangePolicy?: NoChangePolicy;
  readonly workBranch?: string;
  readonly dependsOnRepo?: string;
  readonly baseRef?: string;
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly commands: RepositoryExecutionCommands;
}

/** The sole repository carrier for a Cycle. Keys are stable repoId values;
 * cardinality one and many intentionally share this exact contract. */
export type RepositoryExecutionMap = Readonly<Record<string, RepositoryExecutionContext>>;

/** Workspace/Issue-root execution boundary carried by one Story Cycle. */
export interface CycleRepositoryExecutionContext extends WorkspaceIdentity {
  readonly issueRoot: string;
  readonly repositories: RepositoryExecutionMap;
  readonly integrationAcceptance?: {
    readonly command: readonly string[];
    readonly cwdRepoId: string;
  };
}

export interface IssueManifest {
  readonly schema: typeof ISSUE_MANIFEST_V1;
  readonly workspaceId: string;
  readonly storyId: string;
  readonly requirements: readonly RequirementSourceReference[];
  readonly repositories: readonly IssueRepositoryTarget[];
  readonly integrationAcceptance?: {
    readonly command: readonly string[];
    readonly cwd?: string;
  };
  readonly deliveryTarget?: CampaignDeliveryTarget;
}

export interface IssueManifestExpectations {
  workspaceId?: string;
  storyId?: string;
}

const stringSchema: JsonSchema = { type: "string", minLength: 1 };
const requirementSourceSchema = objectSchema(
  { provider: stringSchema, ref: stringSchema },
  ["provider", "ref"],
);

function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export const repositoryBindingV1Schema: JsonSchema = objectSchema(
  {
    schema: { const: REPOSITORY_BINDING_V1 },
    repoId: stringSchema,
    alias: stringSchema,
    remote: stringSchema,
    integrationBranch: stringSchema,
    provider: stringSchema,
    workflow: objectSchema(
      {
        branchPattern: stringSchema,
        requiredChecks: { type: "array", items: stringSchema },
      },
      ["branchPattern", "requiredChecks"],
    ),
  },
  ["schema", "repoId", "alias", "remote", "integrationBranch", "provider", "workflow"],
);

const workspaceStringArraySchema: JsonSchema = { type: "array", items: stringSchema };
const workspaceRepositoryExecutionCommandsSchema = objectSchema(
  { test: workspaceStringArraySchema, integration: workspaceStringArraySchema },
  ["test", "integration"],
);
const workspaceRepositoryExecutionContextSchema = objectSchema(
  {
    repoId: stringSchema,
    alias: stringSchema,
    access: { type: "string", enum: ["read", "write"] },
    requiredDelivery: { type: "boolean" },
    noChangePolicy: { type: "string", enum: ["changes_required", "no_change_allowed"] },
    workBranch: stringSchema,
    dependsOnRepo: stringSchema,
    baseRef: stringSchema,
    worktreePath: stringSchema,
    baseSha: stringSchema,
    headSha: stringSchema,
    commands: workspaceRepositoryExecutionCommandsSchema,
  },
  ["repoId", "alias", "access", "requiredDelivery", "worktreePath", "baseSha", "headSha", "commands"],
);
const workspaceCycleExecutionContextSchema = objectSchema(
  {
    workspaceId: stringSchema,
    issueRoot: stringSchema,
    repositories: { type: "object", additionalProperties: workspaceRepositoryExecutionContextSchema },
    integrationAcceptance: objectSchema(
      {
        command: { type: "array", items: stringSchema, minItems: 1 },
        cwdRepoId: stringSchema,
      },
      ["command", "cwdRepoId"],
    ),
  },
  ["workspaceId", "issueRoot", "repositories"],
);
const workspaceMatchEvidenceSchema = objectSchema(
  {
    kind: {
      type: "string",
      enum: ["issue_exact", "requirement_source_exact", "repository_exact", "path_contained", "semantic_supported"],
    },
    value: stringSchema,
    hard: { type: "boolean" },
    score: { type: "number" },
    source: stringSchema,
    provenance: {
      type: "string",
      enum: ["explicit_user", "cli_argument", "issue_manifest", "cwd_repository", "deterministic_extraction", "semantic_inference"],
    },
    detail: stringSchema,
  },
  ["kind", "value", "hard", "score", "source", "provenance", "detail"],
);
const workspaceAuthoritiesV1Schema = objectSchema(
  {
    backlog: stringSchema,
    features: stringSchema,
    design: stringSchema,
    requirements: stringSchema,
    policy: stringSchema,
    evidence: stringSchema,
    toolDumps: stringSchema,
    events: stringSchema,
    runtime: stringSchema,
    locks: stringSchema,
  },
  ["backlog", "features", "design", "requirements", "policy", "evidence", "toolDumps", "events", "runtime", "locks"],
);

export const workspaceExecutionContextV1Schema: JsonSchema = objectSchema(
  {
    schema: { const: WORKSPACE_EXECUTION_CONTEXT_V1 },
    workspace: objectSchema(
      {
        workspaceId: stringSchema,
        root: stringSchema,
        canonicalRoot: stringSchema,
        lifecycle: { type: "string", enum: ["registered", "active", "paused", "archived"] },
      },
      ["workspaceId", "root", "canonicalRoot", "lifecycle"],
    ),
    resolution: objectSchema(
      {
        source: {
          type: "string",
          enum: ["explicit", "environment", "cwd_manifest", "issue_manifest", "requirement_discovery"],
        },
        evidence: { type: "array", items: workspaceMatchEvidenceSchema },
      },
      ["source", "evidence"],
    ),
    bindings: { type: "array", items: repositoryBindingV1Schema },
    contexts: workspaceContextsV1Schema,
    issue: objectSchema(
      {
        storyId: stringSchema,
        manifestPath: stringSchema,
        execution: workspaceCycleExecutionContextSchema,
      },
      ["storyId", "manifestPath", "execution"],
    ),
    authorities: workspaceAuthoritiesV1Schema,
  },
  ["schema", "workspace", "resolution", "bindings", "authorities"],
);

export const workspaceManifestV1Schema: JsonSchema = objectSchema(
  {
    schema: { const: WORKSPACE_MANIFEST_V1 },
    workspaceId: stringSchema,
    displayName: stringSchema,
    createdAt: stringSchema,
    requirements: { type: "array", items: requirementSourceSchema },
    repositories: { type: "array", items: repositoryBindingV1Schema, minItems: 1 },
    contexts: workspaceContextsV1Schema,
  },
  ["schema", "workspaceId", "displayName", "requirements", "repositories"],
);

const issueTargetCommonProperties = {
  repoId: stringSchema,
  alias: stringSchema,
  requiredDelivery: { type: "boolean" },
  baseRef: stringSchema,
  pathScope: { type: "array", items: stringSchema },
  dependsOnRepo: stringSchema,
} satisfies Readonly<Record<string, JsonSchema>>;

const issueRepositoryTargetSchema: JsonSchema = {
  oneOf: [
    objectSchema(
      { ...issueTargetCommonProperties, access: { const: "read" }, requiredDelivery: { const: false } },
      ["repoId", "alias", "access", "requiredDelivery"],
    ),
    objectSchema(
      {
        ...issueTargetCommonProperties,
        access: { const: "write" },
        noChangePolicy: { type: "string", enum: ["changes_required", "no_change_allowed"] },
        workBranch: stringSchema,
      },
      ["repoId", "alias", "access", "requiredDelivery", "noChangePolicy"],
    ),
  ],
};

export const issueManifestV1Schema: JsonSchema = objectSchema(
  {
    schema: { const: ISSUE_MANIFEST_V1 },
    workspaceId: stringSchema,
    storyId: stringSchema,
    requirements: { type: "array", items: requirementSourceSchema },
    repositories: { type: "array", items: issueRepositoryTargetSchema, minItems: 1 },
    integrationAcceptance: objectSchema(
      { command: { type: "array", items: stringSchema, minItems: 1 }, cwd: stringSchema },
      ["command"],
    ),
    deliveryTarget: objectSchema(
      { terminal: { const: "campaign_branch" }, branch: stringSchema, mainMerge: { const: "forbidden" } },
      ["terminal", "branch", "mainMerge"],
    ),
  },
    ["schema", "workspaceId", "storyId", "requirements", "repositories"],
);

const requirementEvidenceSchema = objectSchema(
  { bytes: { type: "integer", minimum: 0 }, sha256: { type: "string", minLength: 64 } },
  ["bytes", "sha256"],
);

export const requirementSourceV1Schema: JsonSchema = objectSchema(
  {
    schema: { const: REQUIREMENT_SOURCE_V1 },
    requirementId: stringSchema,
    provider: { type: "string", enum: ["jira", "github_issue", "local_file", "user_input"] },
    ref: stringSchema,
    revision: stringSchema,
    capturedAt: stringSchema,
    previousRevisions: {
      type: "array",
      items: objectSchema({ revision: stringSchema, capturedAt: stringSchema }, ["revision", "capturedAt"]),
    },
    requirement: requirementEvidenceSchema,
    context: {
      type: "array",
      items: objectSchema(
        { path: stringSchema, bytes: { type: "integer", minimum: 0 }, sha256: { type: "string", minLength: 64 } },
        ["path", "bytes", "sha256"],
      ),
    },
    stories: { type: "array", items: stringSchema },
    attest: objectSchema(
      {
        schema: { const: REQUIREMENT_ATTEST_PROJECTION_V1 },
        mode: { const: "generated_aggregate" },
        evidenceAuthority: { const: "issue" },
      },
      ["schema", "mode", "evidenceAuthority"],
    ),
    deliveryTarget: objectSchema(
      { terminal: { const: "campaign_branch" }, branch: stringSchema, mainMerge: { const: "forbidden" } },
      ["terminal", "branch", "mainMerge"],
    ),
  },
  [
    "schema",
    "requirementId",
    "provider",
    "ref",
    "revision",
    "capturedAt",
    "previousRevisions",
    "requirement",
    "context",
    "stories",
    "attest",
  ],
);

function fail<T>(code: ContractErrorCode, path: string, message: string): ContractResult<T> {
  return { ok: false, errors: [{ code, path, message }] };
}

function remoteFailure(message: string): ContractResult<string> {
  return fail("unsafe_remote", "remote", message);
}

function hasUnsafeRemoteSyntax(value: string): boolean {
  if (
    /[\x00-\x20\x7f]/u.test(value) || value.includes("\\") || value.includes("%") ||
    value.includes("?") || value.includes("#")
  ) {
    return true;
  }
  const pathPart = value.startsWith("file://")
    ? value.slice("file://".length)
    : value.replace(/^[^:]+:\/\//u, "").replace(/^[^:]+:/u, "");
  return pathPart.split("/").some((segment) => segment === "." || segment === "..");
}

function trimRepositorySuffix(pathname: string): string | null {
  let trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (trimmed.endsWith(".git")) trimmed = trimmed.slice(0, -4);
  if (trimmed === "" || trimmed === "/" || trimmed.endsWith("/")) return null;
  const segments = trimmed.startsWith("/") ? trimmed.slice(1).split("/") : trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return trimmed;
}

const networkHostPattern = "(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\\[[0-9A-Fa-f:.]+\\])";
const httpsRemotePattern = new RegExp(`^https://(${networkHostPattern})(?::443)?/(.+)$`, "u");
const sshRemotePattern = new RegExp(`^ssh://[A-Za-z0-9._~-]+@(${networkHostPattern})(?::22)?/(.+)$`, "u");

function normalizeNetworkHost(host: string): string | null {
  if (!host.startsWith("[") && !host.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
  )) {
    return null;
  }
  try {
    return new URL(`https://${host}/`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeNetworkRemote(value: string): ContractResult<string> {
  const https = httpsRemotePattern.exec(value);
  const ssh = sshRemotePattern.exec(value);
  const match = https ?? ssh;
  if (match === null) {
    return remoteFailure("repository remote is not a supported network URL shape");
  }
  const host = match[1];
  const rawPath = match[2];
  if (host === undefined || rawPath === undefined) {
    return remoteFailure("repository remote must contain a host and safe repository path");
  }
  const canonicalHost = normalizeNetworkHost(host);
  if (canonicalHost === null) return remoteFailure("repository remote contains an invalid host");
  const path = trimRepositorySuffix(`/${rawPath}`);
  if (path === null || path.slice(1).split("/").length < 2) {
    return remoteFailure("network repository remote must contain an owner and repository path");
  }
  return { ok: true, value: `${https === null ? "ssh" : "https"}://${canonicalHost}${path}` };
}

function normalizeUrlRemote(value: string): ContractResult<string> {
  const file = /^file:\/\/(\/.+)$/u.exec(value);
  if (file !== null) {
    const rawPath = file[1];
    if (rawPath === undefined) {
      return remoteFailure("file repository remote must contain a safe absolute path");
    }
    const path = trimRepositorySuffix(rawPath);
    if (path === null || !path.startsWith("/") || /^\/[A-Za-z]:\//u.test(path)) {
      return remoteFailure("file repository remote must contain a safe absolute path");
    }
    return { ok: true, value: `file://${path}` };
  }
  return normalizeNetworkRemote(value);
}

/** Normalize only the closed roll.repository-binding/v1 remote families. */
export function normalizeRepositoryRemote(value: unknown): ContractResult<string> {
  if (typeof value !== "string" || value.trim() === "") {
    return fail("invalid_type", "remote", "repository remote must be a non-empty string");
  }
  if (value !== value.trim() || hasUnsafeRemoteSyntax(value)) {
    return remoteFailure("repository remote contains ambiguous or unsafe syntax");
  }

  const scp = new RegExp(`^([A-Za-z0-9._~-]+)@(${networkHostPattern}):(.+)$`, "u").exec(value);
  if (scp !== null) {
    const host = scp[2];
    const rawPath = scp[3];
    if (host === undefined || rawPath === undefined) {
      return remoteFailure("repository remote is not a supported SCP-style remote");
    }
    const canonicalHost = normalizeNetworkHost(host);
    if (canonicalHost === null) return remoteFailure("repository remote contains an invalid host");
    const path = trimRepositorySuffix(`/${rawPath}`);
    if (path === null || path.slice(1).split("/").length < 2) {
      return remoteFailure("repository remote must contain an owner and repository path");
    }
    return { ok: true, value: `ssh://${canonicalHost}${path}` };
  }
  return normalizeUrlRemote(value);
}

export function repositoryIdFromRemote(value: unknown): ContractResult<string> {
  const normalized = normalizeRepositoryRemote(value);
  if (!normalized.ok) return normalized;
  return { ok: true, value: repositoryIdFromCanonicalRemote(normalized.value) };
}

function repositoryIdFromCanonicalRemote(canonicalRemote: string): string {
  const digest = createHash("sha256").update(canonicalRemote).digest("hex").slice(0, 12);
  return `repo-${digest}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownFieldErrors(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): ContractError[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .map((key) => ({
      code: "unknown_field" as const,
      path: path === "" ? key : `${path}.${key}`,
      message: "contract contains an unknown field",
    }));
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  errors: ContractError[],
): string | undefined {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    errors.push({ code: "invalid_type", path: `${path}${key}`, message: "field must be a non-empty string" });
    return undefined;
  }
  return candidate;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  errors: ContractError[],
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    errors.push({ code: "invalid_type", path: `${path}${key}`, message: "field must be a non-empty string" });
    return undefined;
  }
  return candidate;
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function isSafeAlias(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/u.test(value);
}

export function isSafeGitRef(value: string): boolean {
  if (
    value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") ||
    value === "@" || value === "HEAD"
  ) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (/[\x00-\x20\x7f~^:?*\\[]/u.test(value)) return false;
  return value.split("/").every((component) =>
    component !== "" && !component.startsWith(".") && !component.endsWith(".lock")
  );
}

/** Closed remote source ref accepted for an Issue-local base override. */
export function isSafeRepositoryBaseRef(value: string): boolean {
  const prefix = value.startsWith("refs/heads/")
    ? "refs/heads/"
    : value.startsWith("refs/tags/") ? "refs/tags/" : undefined;
  if (prefix === undefined) return false;
  const suffix = value.slice(prefix.length);
  return suffix !== "" && isSafeGitRef(suffix);
}

const WORKFLOW_TOKENS = [
  "{workspace_id}",
  "{story_id}",
  "{repo_alias}",
] as const;

function isSafeBranchPattern(value: string): boolean {
  const components = value.split("/");
  if (!components.includes("{workspace_id}") || !components.includes("{story_id}")) return false;
  let concrete = value;
  for (const token of WORKFLOW_TOKENS) concrete = concrete.replaceAll(token, "id");
  if (concrete.includes("{") || concrete.includes("}")) return false;
  return isSafeGitRef(concrete);
}

function parseStringArray(value: unknown, path: string, errors: ContractError[]): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    errors.push({ code: "invalid_type", path, message: "field must be an array of non-empty strings" });
    return undefined;
  }
  return [...value];
}

function parseWorkflow(value: unknown, errors: ContractError[]): RepositoryWorkflowMetadata | undefined {
  if (!isRecord(value)) {
    errors.push({ code: "invalid_type", path: "workflow", message: "workflow must be an object" });
    return undefined;
  }
  errors.push(...unknownFieldErrors(value, ["branchPattern", "requiredChecks"], "workflow"));
  const branchPattern = requiredString(value, "branchPattern", "workflow.", errors);
  const requiredChecks = parseStringArray(value["requiredChecks"], "workflow.requiredChecks", errors);
  if (branchPattern !== undefined && !isSafeBranchPattern(branchPattern)) {
    errors.push({ code: "invalid_value", path: "workflow.branchPattern", message: "branch pattern is not a safe Git ref template" });
  }
  if (branchPattern === undefined || requiredChecks === undefined) return undefined;
  return { branchPattern, requiredChecks };
}

function parseRequirementSource(value: unknown, path: string, errors: ContractError[]): RequirementSourceReference | undefined {
  if (!isRecord(value)) {
    errors.push({ code: "invalid_type", path, message: "requirement source must be an object" });
    return undefined;
  }
  errors.push(...unknownFieldErrors(value, ["provider", "ref"], path));
  const provider = requiredString(value, "provider", `${path}.`, errors);
  const ref = requiredString(value, "ref", `${path}.`, errors);
  return provider === undefined || ref === undefined ? undefined : { provider, ref };
}

function parseRequirementSources(value: unknown, path: string, errors: ContractError[]): readonly RequirementSourceReference[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ code: "invalid_type", path, message: "requirements must be an array" });
    return undefined;
  }
  const parsed = value.map((entry, index) => parseRequirementSource(entry, `${path}[${index}]`, errors));
  return parsed.every((entry) => entry !== undefined)
    ? (parsed as readonly RequirementSourceReference[])
    : undefined;
}

function parseRequirementEvidence(
  value: unknown,
  path: string,
  errors: ContractError[],
): RequirementEvidenceDescriptor | undefined {
  if (!isRecord(value)) {
    errors.push({ code: "invalid_type", path, message: "evidence descriptor must be an object" });
    return undefined;
  }
  errors.push(...unknownFieldErrors(value, ["bytes", "sha256"], path));
  const bytes = value["bytes"];
  const sha256 = value["sha256"];
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) {
    errors.push({ code: "invalid_value", path: `${path}.bytes`, message: "evidence bytes must be a non-negative safe integer" });
  }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) {
    errors.push({ code: "invalid_value", path: `${path}.sha256`, message: "evidence digest must be lowercase SHA-256" });
  }
  return Number.isSafeInteger(bytes) && (bytes as number) >= 0 && typeof sha256 === "string" && /^[0-9a-f]{64}$/u.test(sha256)
    ? { bytes: bytes as number, sha256 }
    : undefined;
}

function parseRequirementContext(
  value: unknown,
  errors: ContractError[],
): readonly RequirementContextDescriptor[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ code: "invalid_type", path: "context", message: "context must be an array" });
    return undefined;
  }
  const entries: RequirementContextDescriptor[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `context[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ code: "invalid_type", path, message: "context entry must be an object" });
      continue;
    }
    errors.push(...unknownFieldErrors(entry, ["path", "bytes", "sha256"], path));
    const relativePath = requiredString(entry, "path", `${path}.`, errors);
    const evidence = parseRequirementEvidence({ bytes: entry["bytes"], sha256: entry["sha256"] }, path, errors);
    if (relativePath !== undefined && !isSafeRelativeTargetPath(relativePath)) {
      errors.push({ code: "invalid_value", path: `${path}.path`, message: "context path must be safe and relative" });
    }
    if (relativePath !== undefined && isSafeRelativeTargetPath(relativePath) && evidence !== undefined) {
      entries.push({ path: relativePath, ...evidence });
    }
  }
  return entries.length === value.length ? entries : undefined;
}

function parsePreviousRevisions(
  value: unknown,
  errors: ContractError[],
): readonly RequirementPreviousRevision[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ code: "invalid_type", path: "previousRevisions", message: "previous revisions must be an array" });
    return undefined;
  }
  const revisions: RequirementPreviousRevision[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `previousRevisions[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ code: "invalid_type", path, message: "previous revision must be an object" });
      continue;
    }
    errors.push(...unknownFieldErrors(entry, ["revision", "capturedAt"], path));
    const revision = requiredString(entry, "revision", `${path}.`, errors);
    const capturedAt = requiredString(entry, "capturedAt", `${path}.`, errors);
    if (revision !== undefined && capturedAt !== undefined) revisions.push({ revision, capturedAt });
  }
  return revisions.length === value.length ? revisions : undefined;
}

function parseRequirementAttest(
  value: unknown,
  errors: ContractError[],
): RequirementAttestProjectionContract | undefined {
  if (!isRecord(value)) {
    errors.push({ code: "invalid_type", path: "attest", message: "attest contract must be an object" });
    return undefined;
  }
  errors.push(...unknownFieldErrors(value, ["schema", "mode", "evidenceAuthority"], "attest"));
  if (value["schema"] !== REQUIREMENT_ATTEST_PROJECTION_V1) {
    errors.push({ code: "unknown_version", path: "attest.schema", message: `expected ${REQUIREMENT_ATTEST_PROJECTION_V1}` });
  }
  if (value["mode"] !== "generated_aggregate") {
    errors.push({ code: "invalid_value", path: "attest.mode", message: "Requirement attest must remain a generated aggregate" });
  }
  if (value["evidenceAuthority"] !== "issue") {
    errors.push({ code: "invalid_value", path: "attest.evidenceAuthority", message: "Issue evidence must remain authoritative" });
  }
  return value["schema"] === REQUIREMENT_ATTEST_PROJECTION_V1 &&
      value["mode"] === "generated_aggregate" && value["evidenceAuthority"] === "issue"
    ? { schema: REQUIREMENT_ATTEST_PROJECTION_V1, mode: "generated_aggregate", evidenceAuthority: "issue" }
    : undefined;
}

function parseCampaignDeliveryTarget(
  value: unknown,
  path: string,
  errors: ContractError[],
): CampaignDeliveryTarget | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push({ code: "invalid_type", path, message: "campaign delivery target must be an object" });
    return undefined;
  }
  errors.push(...unknownFieldErrors(value, ["terminal", "branch", "mainMerge"], path));
  const branch = requiredString(value, "branch", `${path}.`, errors);
  if (value["terminal"] !== "campaign_branch") {
    errors.push({ code: "invalid_value", path: `${path}.terminal`, message: "campaign delivery terminal must be campaign_branch" });
  }
  if (value["mainMerge"] !== "forbidden") {
    errors.push({ code: "invalid_value", path: `${path}.mainMerge`, message: "campaign delivery must explicitly forbid main merge" });
  }
  if (branch !== undefined && !isSafeGitRef(branch)) {
    errors.push({ code: "invalid_value", path: `${path}.branch`, message: "campaign branch is not a safe Git ref" });
  }
  return branch !== undefined && isSafeGitRef(branch) &&
      value["terminal"] === "campaign_branch" && value["mainMerge"] === "forbidden"
    ? { terminal: "campaign_branch", branch, mainMerge: "forbidden" }
    : undefined;
}

function safeRequirementReference(value: string): boolean {
  return value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value) && !/:\/\//u.test(value) &&
    !/(?:^|[?&;#\s_-])(?:access|api)?[_-]?(?:token|key)=/iu.test(value) &&
    !/(?:^|[?&;#\s_-])(?:authorization|credential|password|secret)=?/iu.test(value);
}

function requirementSourceId(provider: RequirementProvider, ref: string): string {
  return `req-${createHash("sha256").update(`${provider}\0${ref}`).digest("hex").slice(0, 12)}`;
}

export function parseRequirementSourceManifest(value: unknown): ContractResult<RequirementSourceManifest> {
  if (!isRecord(value)) return fail("invalid_type", "requirement", "Requirement source manifest must be an object");
  const errors = unknownFieldErrors(value, [
    "schema",
    "requirementId",
    "provider",
    "ref",
    "revision",
    "capturedAt",
    "previousRevisions",
    "requirement",
    "context",
    "stories",
    "attest",
    "deliveryTarget",
  ], "");
  if (value["schema"] !== REQUIREMENT_SOURCE_V1) {
    errors.push({ code: "unknown_version", path: "schema", message: `expected ${REQUIREMENT_SOURCE_V1}` });
  }
  const requirementId = requiredString(value, "requirementId", "", errors);
  const ref = requiredString(value, "ref", "", errors);
  const revision = requiredString(value, "revision", "", errors);
  const capturedAt = requiredString(value, "capturedAt", "", errors);
  const provider = value["provider"];
  if (provider !== "jira" && provider !== "github_issue" && provider !== "local_file" && provider !== "user_input") {
    errors.push({ code: "invalid_value", path: "provider", message: "unsupported Requirement source provider" });
  }
  if (ref !== undefined && !safeRequirementReference(ref)) {
    errors.push({ code: "invalid_value", path: "ref", message: "Requirement source reference is unsafe" });
  }
  if (revision !== undefined && !isSafeIdentifier(revision)) {
    errors.push({ code: "invalid_value", path: "revision", message: "Requirement source revision is invalid" });
  }
  if (requirementId !== undefined && !/^req-[0-9a-f]{12}$/u.test(requirementId)) {
    errors.push({ code: "invalid_value", path: "requirementId", message: "Requirement identity is invalid" });
  }
  if (
    requirementId !== undefined && ref !== undefined &&
    (provider === "jira" || provider === "github_issue" || provider === "local_file" || provider === "user_input") &&
    requirementId !== requirementSourceId(provider, ref)
  ) {
    errors.push({ code: "identity_mismatch", path: "requirementId", message: "Requirement identity does not match provider and reference" });
  }
  const previousRevisions = parsePreviousRevisions(value["previousRevisions"], errors);
  const requirement = parseRequirementEvidence(value["requirement"], "requirement", errors);
  const context = parseRequirementContext(value["context"], errors);
  const stories = parseStringArray(value["stories"], "stories", errors);
  if (stories !== undefined && stories.some((storyId) => !isSafeIdentifier(storyId))) {
    errors.push({ code: "invalid_value", path: "stories", message: "Story IDs must use safe identifiers" });
  }
  const attest = parseRequirementAttest(value["attest"], errors);
  const deliveryTarget = parseCampaignDeliveryTarget(value["deliveryTarget"], "deliveryTarget", errors);
  if (
    errors.length > 0 || requirementId === undefined || ref === undefined || revision === undefined ||
    capturedAt === undefined || (provider !== "jira" && provider !== "github_issue" && provider !== "local_file" && provider !== "user_input") ||
    previousRevisions === undefined || requirement === undefined || context === undefined || stories === undefined || attest === undefined
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schema: REQUIREMENT_SOURCE_V1,
      requirementId,
      provider,
      ref,
      revision,
      capturedAt,
      previousRevisions,
      requirement,
      context,
      stories,
      attest,
      ...(deliveryTarget === undefined ? {} : { deliveryTarget }),
    },
  };
}

export function parseRepositoryBinding(value: unknown): ContractResult<RepositoryBinding> {
  if (!isRecord(value)) return fail("invalid_type", "repository", "repository binding must be an object");
  const errors = unknownFieldErrors(
    value,
    ["schema", "repoId", "alias", "remote", "integrationBranch", "provider", "workflow"],
    "",
  );
  if (value["schema"] !== REPOSITORY_BINDING_V1) {
    errors.push({ code: "unknown_version", path: "schema", message: `expected ${REPOSITORY_BINDING_V1}` });
  }
  const repoId = requiredString(value, "repoId", "", errors);
  const alias = requiredString(value, "alias", "", errors);
  const integrationBranch = requiredString(value, "integrationBranch", "", errors);
  const provider = requiredString(value, "provider", "", errors);
  const workflow = parseWorkflow(value["workflow"], errors);
  const normalized = normalizeRepositoryRemote(value["remote"]);
  if (!normalized.ok) errors.push(...normalized.errors);

  if (alias !== undefined && !isSafeAlias(alias)) {
    errors.push({ code: "invalid_value", path: "alias", message: "repository alias must use lowercase letters, digits and hyphens" });
  }
  if (integrationBranch !== undefined && !isSafeGitRef(integrationBranch)) {
    errors.push({ code: "invalid_value", path: "integrationBranch", message: "integration branch is not a safe Git ref" });
  }
  if (normalized.ok && repoId !== undefined) {
    if (repoId !== repositoryIdFromCanonicalRemote(normalized.value)) {
      errors.push({ code: "repo_id_mismatch", path: "repoId", message: "repoId does not match the canonical remote" });
    }
  }

  if (
    errors.length > 0 || repoId === undefined || alias === undefined || integrationBranch === undefined ||
    provider === undefined || workflow === undefined || !normalized.ok
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schema: REPOSITORY_BINDING_V1,
      repoId,
      alias,
      remote: normalized.value,
      integrationBranch,
      provider,
      workflow,
    },
  };
}

function prefixErrors(errors: readonly ContractError[], prefix: string): ContractError[] {
  return errors.map((error) => ({ ...error, path: `${prefix}.${error.path}` }));
}

function duplicateErrors(repositories: readonly RepositoryBinding[]): ContractError[] {
  const errors: ContractError[] = [];
  const seenAliases = new Set<string>();
  const seenIds = new Set<string>();
  const seenRemotes = new Set<string>();
  for (const repository of repositories) {
    const duplicates: Array<[string, Set<string>, string]> = [
      [repository.alias, seenAliases, "alias"],
      [repository.repoId, seenIds, "repoId"],
      [repository.remote, seenRemotes, "remote"],
    ];
    for (const [identity, seen, field] of duplicates) {
      if (seen.has(identity)) {
        errors.push({ code: "duplicate_identity", path: `repositories.${field}`, message: `duplicate repository ${field}` });
      }
      seen.add(identity);
    }
  }
  return errors;
}

export function parseWorkspaceManifest(
  value: unknown,
  expectations: WorkspaceManifestExpectations = {},
): ContractResult<WorkspaceManifest> {
  if (!isRecord(value)) return fail("invalid_type", "workspace", "Workspace manifest must be an object");
  const errors = unknownFieldErrors(
    value,
    ["schema", "workspaceId", "displayName", "createdAt", "requirements", "repositories", "contexts"],
    "",
  );
  if (value["schema"] !== WORKSPACE_MANIFEST_V1) {
    errors.push({ code: "unknown_version", path: "schema", message: `expected ${WORKSPACE_MANIFEST_V1}` });
  }
  const workspaceId = requiredString(value, "workspaceId", "", errors);
  const displayName = requiredString(value, "displayName", "", errors);
  const createdAt = optionalString(value, "createdAt", "", errors);
  const requirements = parseRequirementSources(value["requirements"], "requirements", errors);
  const rawRepositories = value["repositories"];
  const repositories: RepositoryBinding[] = [];
  if (!Array.isArray(rawRepositories) || rawRepositories.length === 0) {
    errors.push({ code: "invalid_type", path: "repositories", message: "repositories must be a non-empty array" });
  } else {
    for (const [index, raw] of rawRepositories.entries()) {
      const parsed = parseRepositoryBinding(raw);
      if (parsed.ok) repositories.push(parsed.value);
      else errors.push(...prefixErrors(parsed.errors, `repositories[${index}]`));
    }
  }
  errors.push(...duplicateErrors(repositories));
  const parsedContexts = value["contexts"] === undefined
    ? undefined
    : parseWorkspaceContexts(value["contexts"]);
  if (parsedContexts !== undefined && !parsedContexts.ok) errors.push(...parsedContexts.errors);

  if (workspaceId !== undefined && !isSafeIdentifier(workspaceId)) {
    errors.push({ code: "invalid_value", path: "workspaceId", message: "Workspace ID contains unsafe characters" });
  }
  if (workspaceId !== undefined && expectations.workspaceId !== undefined && workspaceId !== expectations.workspaceId) {
    errors.push({ code: "identity_mismatch", path: "workspaceId", message: "Workspace ID does not match the expected identity" });
  }
  if (errors.length > 0 || workspaceId === undefined || displayName === undefined || requirements === undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId,
      displayName,
      ...(createdAt !== undefined ? { createdAt } : {}),
      requirements,
      repositories,
      ...(parsedContexts?.ok === true ? { contexts: parsedContexts.value } : {}),
    },
  };
}

function parseBoolean(
  value: Record<string, unknown>,
  key: string,
  path: string,
  errors: ContractError[],
): boolean | undefined {
  const candidate = value[key];
  if (typeof candidate !== "boolean") {
    errors.push({ code: "invalid_type", path: `${path}${key}`, message: "field must be a boolean" });
    return undefined;
  }
  return candidate;
}

function isSafeRelativeTargetPath(value: string): boolean {
  if (
    value === "" || value.startsWith("/") || value.startsWith("~") || value.includes("\\") ||
    /[\x00-\x1f\x7f]/u.test(value) || /^[A-Za-z]:/u.test(value)
  ) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function parseIssueTarget(value: unknown, index: number, errors: ContractError[]): IssueRepositoryTarget | undefined {
  const path = `repositories[${index}]`;
  if (!isRecord(value)) {
    errors.push({ code: "invalid_type", path, message: "repository target must be an object" });
    return undefined;
  }
  errors.push(...unknownFieldErrors(
    value,
    ["repoId", "alias", "access", "requiredDelivery", "noChangePolicy", "workBranch", "baseRef", "pathScope", "dependsOnRepo"],
    path,
  ));
  const repoId = requiredString(value, "repoId", `${path}.`, errors);
  const alias = requiredString(value, "alias", `${path}.`, errors);
  const requiredDelivery = parseBoolean(value, "requiredDelivery", `${path}.`, errors);
  const access = value["access"];
  if (access !== "read" && access !== "write") {
    errors.push({ code: "invalid_value", path: `${path}.access`, message: "access must be read or write" });
  }

  const noChangePolicy = value["noChangePolicy"];
  const workBranch = value["workBranch"];
  const baseRef = optionalString(value, "baseRef", `${path}.`, errors);
  if (baseRef !== undefined && !isSafeRepositoryBaseRef(baseRef)) {
    errors.push({ code: "invalid_value", path: `${path}.baseRef`, message: "base ref must be an exact refs/heads/* or refs/tags/* remote ref" });
  }
  if (access === "write" && noChangePolicy !== "changes_required" && noChangePolicy !== "no_change_allowed") {
    errors.push({ code: "invalid_value", path: `${path}.noChangePolicy`, message: "write target requires an explicit no-change policy" });
  }
  if (access === "read" && noChangePolicy !== undefined) {
    errors.push({ code: "invalid_value", path: `${path}.noChangePolicy`, message: "read target must not declare a no-change policy" });
  }
  if (access === "read" && workBranch !== undefined) {
    errors.push({ code: "invalid_value", path: `${path}.workBranch`, message: "read target must not declare a work branch" });
  }
  if (access === "write" && workBranch !== undefined && (typeof workBranch !== "string" || !isSafeGitRef(workBranch))) {
    errors.push({ code: "invalid_value", path: `${path}.workBranch`, message: "work branch must be a safe governed Git ref" });
  }
  if (access === "read" && requiredDelivery === true) {
    errors.push({ code: "invalid_value", path: `${path}.requiredDelivery`, message: "read target cannot require delivery" });
  }

  const rawPathScope = value["pathScope"];
  let pathScope: readonly string[] | undefined;
  if (rawPathScope !== undefined) {
    pathScope = parseStringArray(rawPathScope, `${path}.pathScope`, errors);
    if (pathScope !== undefined && pathScope.some((entry) => !isSafeRelativeTargetPath(entry))) {
      errors.push({ code: "invalid_value", path: `${path}.pathScope`, message: "path scope must contain safe relative paths" });
    }
  }
  const dependsOnRepo = optionalString(value, "dependsOnRepo", `${path}.`, errors);
  if (repoId !== undefined && !/^repo-[0-9a-f]{12}$/u.test(repoId)) {
    errors.push({ code: "invalid_value", path: `${path}.repoId`, message: "repository target has an invalid repoId" });
  }
  if (alias !== undefined && !isSafeAlias(alias)) {
    errors.push({ code: "invalid_value", path: `${path}.alias`, message: "repository target has an invalid alias" });
  }
  if (
    repoId === undefined || alias === undefined || requiredDelivery === undefined ||
    (access !== "read" && access !== "write")
  ) {
    return undefined;
  }
  const optionalFields = {
    ...(baseRef !== undefined && isSafeRepositoryBaseRef(baseRef) ? { baseRef } : {}),
    ...(pathScope !== undefined ? { pathScope } : {}),
    ...(dependsOnRepo !== undefined ? { dependsOnRepo } : {}),
  };
  if (access === "read") {
    if (requiredDelivery !== false) return undefined;
    return { repoId, alias, access, requiredDelivery, ...optionalFields };
  }
  if (noChangePolicy !== "changes_required" && noChangePolicy !== "no_change_allowed") return undefined;
  return {
    repoId,
    alias,
    access,
    requiredDelivery,
    noChangePolicy,
    ...(typeof workBranch === "string" ? { workBranch } : {}),
    ...optionalFields,
  };
}

function duplicateTargetErrors(targets: readonly IssueRepositoryTarget[]): ContractError[] {
  const errors: ContractError[] = [];
  const aliases = new Set<string>();
  const repoIds = new Set<string>();
  for (const target of targets) {
    if (aliases.has(target.alias)) {
      errors.push({ code: "duplicate_identity", path: "repositories.alias", message: "duplicate repository target alias" });
    }
    if (repoIds.has(target.repoId)) {
      errors.push({ code: "duplicate_identity", path: "repositories.repoId", message: "duplicate repository target repoId" });
    }
    aliases.add(target.alias);
    repoIds.add(target.repoId);
  }
  return errors;
}

function dependencyCycleErrors(
  targets: readonly IssueRepositoryTarget[],
  sourceIndexes: readonly number[],
): ContractError[] {
  const indexByAlias = new Map(targets.map((target, index) => [target.alias, index]));
  const dependencyIndexes = targets.map((target) =>
    target.dependsOnRepo === undefined ? undefined : indexByAlias.get(target.dependsOnRepo)
  );
  const incoming = targets.map(() => 0);
  for (const dependencyIndex of dependencyIndexes) {
    if (dependencyIndex !== undefined) {
      incoming[dependencyIndex] = (incoming[dependencyIndex] ?? 0) + 1;
    }
  }

  const queue = incoming.flatMap((count, index) => count === 0 ? [index] : []);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    if (index === undefined) continue;
    const dependencyIndex = dependencyIndexes[index];
    if (dependencyIndex === undefined) continue;
    const nextIncoming = (incoming[dependencyIndex] ?? 0) - 1;
    incoming[dependencyIndex] = nextIncoming;
    if (nextIncoming === 0) queue.push(dependencyIndex);
  }

  return targets.flatMap((_target, index) =>
    (incoming[index] ?? 0) > 0
      ? [{
          code: "invalid_value" as const,
          path: `repositories[${sourceIndexes[index] ?? index}].dependsOnRepo`,
          message: "repository dependency graph contains a cycle",
        }]
      : []
  );
}

export function parseIssueManifest(
  value: unknown,
  expectations: IssueManifestExpectations = {},
): ContractResult<IssueManifest> {
  if (!isRecord(value)) return fail("invalid_type", "issue", "Issue manifest must be an object");
  const errors = unknownFieldErrors(
    value,
    ["schema", "workspaceId", "storyId", "requirements", "repositories", "integrationAcceptance", "deliveryTarget"],
    "",
  );
  if (value["schema"] !== ISSUE_MANIFEST_V1) {
    errors.push({ code: "unknown_version", path: "schema", message: `expected ${ISSUE_MANIFEST_V1}` });
  }
  const workspaceId = requiredString(value, "workspaceId", "", errors);
  const storyId = requiredString(value, "storyId", "", errors);
  const requirements = parseRequirementSources(value["requirements"], "requirements", errors);
  const rawTargets = value["repositories"];
  const targets: IssueRepositoryTarget[] = [];
  const targetIndexes: number[] = [];
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    errors.push({ code: "invalid_type", path: "repositories", message: "repository targets must be a non-empty array" });
  } else {
    for (const [index, raw] of rawTargets.entries()) {
      const target = parseIssueTarget(raw, index, errors);
      if (target !== undefined) {
        targets.push(target);
        targetIndexes.push(index);
      }
    }
  }
  errors.push(...duplicateTargetErrors(targets));
  const targetsByAlias = new Map(targets.map((target) => [target.alias, target]));
  for (const [index, target] of targets.entries()) {
    if (target.dependsOnRepo === undefined) continue;
    const dependency = targetsByAlias.get(target.dependsOnRepo);
    if (dependency === undefined || target.dependsOnRepo === target.alias) {
      errors.push({
        code: "invalid_value",
        path: `repositories[${targetIndexes[index] ?? index}].dependsOnRepo`,
        message: "dependency must name a different declared repository alias",
      });
      continue;
    }
    if (target.access !== "write" || dependency.access !== "write") {
      errors.push({
        code: "invalid_value",
        path: `repositories[${targetIndexes[index] ?? index}].dependsOnRepo`,
        message: "publish dependencies require writable repository targets",
      });
    }
  }
  errors.push(...dependencyCycleErrors(targets, targetIndexes));
  let integrationAcceptance: IssueManifest["integrationAcceptance"];
  const rawIntegration = value["integrationAcceptance"];
  if (rawIntegration !== undefined) {
    if (!isRecord(rawIntegration)) {
      errors.push({ code: "invalid_type", path: "integrationAcceptance", message: "integration acceptance must be an object" });
    } else {
      errors.push(...unknownFieldErrors(rawIntegration, ["command", "cwd"], "integrationAcceptance"));
      const command = parseStringArray(rawIntegration["command"], "integrationAcceptance.command", errors);
      const cwd = optionalString(rawIntegration, "cwd", "integrationAcceptance.", errors);
      if (command !== undefined) {
        if (command.length === 0) {
          errors.push({ code: "invalid_value", path: "integrationAcceptance.command", message: "integration command must not be empty" });
        } else if (cwd === undefined || isSafeAlias(cwd)) {
          integrationAcceptance = { command, ...(cwd === undefined ? {} : { cwd }) };
        }
      }
      if (cwd !== undefined && !isSafeAlias(cwd)) {
        errors.push({ code: "invalid_value", path: "integrationAcceptance.cwd", message: "integration cwd must name a safe repository alias" });
      }
    }
  }
  if (integrationAcceptance?.cwd !== undefined) {
    const cwdTarget = targetsByAlias.get(integrationAcceptance.cwd);
    if (cwdTarget === undefined || cwdTarget.access !== "write") {
      errors.push({ code: "invalid_value", path: "integrationAcceptance.cwd", message: "integration cwd must name a writable Issue repository" });
    }
  }
  const deliveryTarget = parseCampaignDeliveryTarget(value["deliveryTarget"], "deliveryTarget", errors);

  if (workspaceId !== undefined && !isSafeIdentifier(workspaceId)) {
    errors.push({ code: "invalid_value", path: "workspaceId", message: "Workspace ID contains unsafe characters" });
  }
  if (storyId !== undefined && !isSafeIdentifier(storyId)) {
    errors.push({ code: "invalid_value", path: "storyId", message: "Story ID contains unsafe characters" });
  }
  if (workspaceId !== undefined && expectations.workspaceId !== undefined && workspaceId !== expectations.workspaceId) {
    errors.push({ code: "identity_mismatch", path: "workspaceId", message: "Workspace ID does not match the expected identity" });
  }
  if (storyId !== undefined && expectations.storyId !== undefined && storyId !== expectations.storyId) {
    errors.push({ code: "identity_mismatch", path: "storyId", message: "Story ID does not match the expected identity" });
  }
  if (errors.length > 0 || workspaceId === undefined || storyId === undefined || requirements === undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schema: ISSUE_MANIFEST_V1,
      workspaceId,
      storyId,
      requirements,
      repositories: targets,
      ...(integrationAcceptance === undefined ? {} : { integrationAcceptance }),
      ...(deliveryTarget === undefined ? {} : { deliveryTarget }),
    },
  };
}

const MIGRATION_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const MIGRATION_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function migrationRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
  errors: ContractError[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    errors.push({ code: "invalid_type", path, message: "field must be an object" });
    return undefined;
  }
  errors.push(...unknownFieldErrors(value, allowed, path));
  return value;
}

function migrationString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  errors: ContractError[],
): string | undefined {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    errors.push({ code: "invalid_type", path: `${path}.${key}`, message: "field must be a non-empty string" });
    return undefined;
  }
  return candidate;
}

function migrationNullableString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  errors: ContractError[],
): string | null | undefined {
  const candidate = value[key];
  if (candidate === null) return null;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    errors.push({ code: "invalid_type", path: `${path}.${key}`, message: "field must be null or a non-empty string" });
    return undefined;
  }
  return candidate;
}

function migrationOptionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  errors: ContractError[],
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    errors.push({ code: "invalid_type", path: `${path}.${key}`, message: "field must be a non-empty string when present" });
    return undefined;
  }
  return candidate;
}

function migrationEnum<T extends string>(
  value: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
  errors: ContractError[],
): T | undefined {
  const candidate = value[key];
  if (typeof candidate !== "string" || !allowed.includes(candidate as T)) {
    errors.push({ code: "invalid_value", path: `${path}.${key}`, message: `expected one of: ${allowed.join(", ")}` });
    return undefined;
  }
  return candidate as T;
}

function migrationStringArray(
  value: unknown,
  path: string,
  errors: ContractError[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ code: "invalid_type", path, message: "field must be an array" });
    return undefined;
  }
  const entries: string[] = [];
  for (const [index, candidate] of value.entries()) {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      errors.push({ code: "invalid_type", path: `${path}[${index}]`, message: "entry must be a non-empty string" });
      continue;
    }
    entries.push(candidate);
  }
  return entries.length === value.length ? entries : undefined;
}

function migrationSafeRelative(value: string, path: string, errors: ContractError[]): boolean {
  if (isSafeRelativeTargetPath(value)) return true;
  errors.push({ code: "invalid_value", path, message: "path must be safe and relative" });
  return false;
}

function migrationSha(value: string | null, path: string, errors: ContractError[]): boolean {
  if (value === null || MIGRATION_SHA_PATTERN.test(value)) return true;
  errors.push({ code: "invalid_value", path, message: "Git object id must be lowercase hexadecimal" });
  return false;
}

function migrationNormalizedRemote(value: string, path: string, errors: ContractError[]): boolean {
  if (
    value === value.trim() && !/[\x00-\x20\x7f@?#%]/u.test(value) &&
    (/^(?:https|ssh):\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])\/[A-Za-z0-9._~/-]+$/u.test(value) || /^file:\/\/\/[A-Za-z0-9._~/-]+$/u.test(value))
  ) {
    return true;
  }
  errors.push({ code: "unsafe_remote", path, message: "remote must be normalized and credential-free" });
  return false;
}

function parseHistoricalRemoteTruth(
  value: unknown,
  path: string,
  errors: ContractError[],
): HistoricalRemoteTruth | undefined {
  const record = migrationRecord(
    value,
    path,
    ["kind", "code", "normalizedRemote", "defaultBranch", "defaultTip", "headReachable", "defaultTipPresentLocally"],
    errors,
  );
  if (record === undefined) return undefined;
  const kind = migrationEnum(record, "kind", path, ["verified", "blocked"] as const, errors);
  if (kind === "verified") {
    const normalizedRemote = migrationString(record, "normalizedRemote", path, errors);
    const defaultBranch = migrationString(record, "defaultBranch", path, errors);
    const defaultTip = migrationString(record, "defaultTip", path, errors);
    if (record["code"] !== undefined) {
      errors.push({ code: "unknown_field", path: `${path}.code`, message: "verified remote cannot contain a blocked code" });
    }
    if (record["headReachable"] !== true) {
      errors.push({ code: "invalid_value", path: `${path}.headReachable`, message: "verified remote must prove HEAD reachability" });
    }
    if (record["defaultTipPresentLocally"] !== true) {
      errors.push({ code: "invalid_value", path: `${path}.defaultTipPresentLocally`, message: "verified remote tip must be present locally" });
    }
    if (defaultBranch !== undefined && !isSafeGitRef(defaultBranch)) {
      errors.push({ code: "invalid_value", path: `${path}.defaultBranch`, message: "default branch is not a safe Git ref" });
    }
    if (normalizedRemote !== undefined) migrationNormalizedRemote(normalizedRemote, `${path}.normalizedRemote`, errors);
    if (defaultTip !== undefined) migrationSha(defaultTip, `${path}.defaultTip`, errors);
    return normalizedRemote !== undefined && defaultBranch !== undefined && defaultTip !== undefined &&
        record["headReachable"] === true && record["defaultTipPresentLocally"] === true
      ? { kind, normalizedRemote, defaultBranch, defaultTip, headReachable: true, defaultTipPresentLocally: true }
      : undefined;
  }
  if (kind === "blocked") {
    const code = migrationEnum(
      record,
      "code",
      path,
      ["remote_missing", "remote_default_ambiguous", "remote_truth_unverifiable", "head_unpushed"] as const,
      errors,
    );
    const normalizedRemote = migrationOptionalString(record, "normalizedRemote", path, errors);
    const defaultBranch = migrationOptionalString(record, "defaultBranch", path, errors);
    const defaultTip = migrationOptionalString(record, "defaultTip", path, errors);
    if (record["headReachable"] !== undefined) {
      errors.push({ code: "unknown_field", path: `${path}.headReachable`, message: "blocked remote cannot claim reachability" });
    }
    if (record["defaultTipPresentLocally"] !== undefined) {
      errors.push({ code: "unknown_field", path: `${path}.defaultTipPresentLocally`, message: "blocked remote cannot claim a local tip" });
    }
    if (defaultBranch !== undefined && !isSafeGitRef(defaultBranch)) {
      errors.push({ code: "invalid_value", path: `${path}.defaultBranch`, message: "default branch is not a safe Git ref" });
    }
    if (normalizedRemote !== undefined) migrationNormalizedRemote(normalizedRemote, `${path}.normalizedRemote`, errors);
    if (defaultTip !== undefined) migrationSha(defaultTip, `${path}.defaultTip`, errors);
    return code === undefined ? undefined : {
      kind,
      code,
      ...(normalizedRemote === undefined ? {} : { normalizedRemote }),
      ...(defaultBranch === undefined ? {} : { defaultBranch }),
      ...(defaultTip === undefined ? {} : { defaultTip }),
    };
  }
  return undefined;
}

function parseProductGitFacts(value: unknown, errors: ContractError[]): ProductGitSafetyFacts | undefined {
  const path = "git";
  const record = migrationRecord(value, path, ["head", "state", "dirtyPaths", "operation", "remote"], errors);
  if (record === undefined) return undefined;
  const head = migrationString(record, "head", path, errors);
  const state = migrationEnum(record, "state", path, ["clean", "dirty", "in_flight"] as const, errors);
  const dirtyPaths = migrationStringArray(record["dirtyPaths"], `${path}.dirtyPaths`, errors);
  const operation = migrationEnum(record, "operation", path, ["none", "merge", "rebase", "cherry_pick", "bisect"] as const, errors);
  const remote = parseHistoricalRemoteTruth(record["remote"], `${path}.remote`, errors);
  if (head !== undefined) migrationSha(head, `${path}.head`, errors);
  if (dirtyPaths !== undefined) {
    dirtyPaths.forEach((entry, index) => migrationSafeRelative(entry, `${path}.dirtyPaths[${index}]`, errors));
  }
  return head === undefined || state === undefined || dirtyPaths === undefined || operation === undefined || remote === undefined
    ? undefined
    : { head, state, dirtyPaths, operation, remote };
}

function parseLinkedWorktrees(value: unknown, errors: ContractError[]): readonly LinkedWorktreeSafetyFacts[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ code: "invalid_type", path: "linkedWorktrees", message: "field must be an array" });
    return undefined;
  }
  const entries: LinkedWorktreeSafetyFacts[] = [];
  for (const [index, raw] of value.entries()) {
    const path = `linkedWorktrees[${index}]`;
    const record = migrationRecord(raw, path, ["pathToken", "head", "state"], errors);
    if (record === undefined) continue;
    const pathToken = migrationString(record, "pathToken", path, errors);
    const head = migrationString(record, "head", path, errors);
    const state = migrationEnum(record, "state", path, ["clean", "dirty", "missing", "prunable"] as const, errors);
    if (head !== undefined) migrationSha(head, `${path}.head`, errors);
    if (pathToken !== undefined && (pathToken.includes("..") || /[\x00-\x1f\x7f]/u.test(pathToken))) {
      errors.push({ code: "invalid_value", path: `${path}.pathToken`, message: "worktree token is unsafe" });
    }
    if (pathToken !== undefined && head !== undefined && state !== undefined) entries.push({ pathToken, head, state });
  }
  return entries.length === value.length ? entries : undefined;
}

function parseSubmodules(value: unknown, errors: ContractError[]): readonly SubmoduleSafetyFacts[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ code: "invalid_type", path: "submodules", message: "field must be an array" });
    return undefined;
  }
  const entries: SubmoduleSafetyFacts[] = [];
  for (const [index, raw] of value.entries()) {
    const path = `submodules[${index}]`;
    const record = migrationRecord(raw, path, ["path", "head", "state", "remote"], errors);
    if (record === undefined) continue;
    const modulePath = migrationString(record, "path", path, errors);
    const rawHead = record["head"];
    const head = rawHead === null ? null : migrationString(record, "head", path, errors);
    const state = migrationEnum(record, "state", path, ["clean", "dirty", "uninitialized", "conflicted", "missing"] as const, errors);
    const remote = record["remote"] === null ? null : parseHistoricalRemoteTruth(record["remote"], `${path}.remote`, errors);
    if (modulePath !== undefined) migrationSafeRelative(modulePath, `${path}.path`, errors);
    if (head !== undefined) migrationSha(head, `${path}.head`, errors);
    if (modulePath !== undefined && head !== undefined && state !== undefined && remote !== undefined) {
      entries.push({ path: modulePath, head, state, remote });
    }
  }
  return entries.length === value.length ? entries : undefined;
}

function parseHistoricalRuntime(value: unknown, errors: ContractError[]): HistoricalRuntimeFacts | undefined {
  const path = "runtime";
  const record = migrationRecord(value, path, ["activeCycleIds", "activeStoryLeases"], errors);
  if (record === undefined) return undefined;
  const activeCycleIds = migrationStringArray(record["activeCycleIds"], `${path}.activeCycleIds`, errors);
  const activeStoryLeases = migrationStringArray(record["activeStoryLeases"], `${path}.activeStoryLeases`, errors);
  if (activeCycleIds !== undefined) {
    activeCycleIds.forEach((id, index) => {
      if (!isSafeIdentifier(id)) errors.push({ code: "invalid_value", path: `${path}.activeCycleIds[${index}]`, message: "Cycle ID is unsafe" });
    });
  }
  if (activeStoryLeases !== undefined) {
    activeStoryLeases.forEach((id, index) => {
      if (!isSafeIdentifier(id)) errors.push({ code: "invalid_value", path: `${path}.activeStoryLeases[${index}]`, message: "Story ID is unsafe" });
    });
  }
  return activeCycleIds === undefined || activeStoryLeases === undefined ? undefined : { activeCycleIds, activeStoryLeases };
}

function parseHistoricalRollOwnership(value: unknown, errors: ContractError[]): HistoricalRollOwnership | undefined {
  const path = "rollOwnership";
  const record = migrationRecord(
    value,
    path,
    ["kind", "trackedPaths", "gitdirToken", "topLevelToken", "state", "head", "branch", "upstream", "normalizedRemote"],
    errors,
  );
  if (record === undefined) return undefined;
  const kind = migrationEnum(record, "kind", path, ["ordinary", "product_tracked", "independent_git"] as const, errors);
  const allowedByKind: Readonly<Record<NonNullable<typeof kind>, readonly string[]>> = {
    ordinary: ["kind"],
    product_tracked: ["kind", "trackedPaths"],
    independent_git: ["kind", "gitdirToken", "topLevelToken", "state", "head", "branch", "upstream", "normalizedRemote"],
  };
  if (kind !== undefined) errors.push(...unknownFieldErrors(record, allowedByKind[kind], path));
  if (kind === "ordinary") return { kind };
  if (kind === "product_tracked") {
    const trackedPaths = migrationStringArray(record["trackedPaths"], `${path}.trackedPaths`, errors);
    if (trackedPaths !== undefined) {
      trackedPaths.forEach((entry, index) => migrationSafeRelative(entry, `${path}.trackedPaths[${index}]`, errors));
      if (new Set(trackedPaths).size !== trackedPaths.length) {
        errors.push({ code: "duplicate_identity", path: `${path}.trackedPaths`, message: "tracked paths must be unique" });
      }
    }
    return trackedPaths === undefined ? undefined : { kind, trackedPaths };
  }
  if (kind === "independent_git") {
    const gitdirToken = migrationString(record, "gitdirToken", path, errors);
    const topLevelToken = migrationString(record, "topLevelToken", path, errors);
    const state = migrationEnum(record, "state", path, ["clean", "dirty", "in_flight"] as const, errors);
    const head = migrationString(record, "head", path, errors);
    const branch = migrationNullableString(record, "branch", path, errors);
    const upstream = migrationNullableString(record, "upstream", path, errors);
    const normalizedRemote = migrationNullableString(record, "normalizedRemote", path, errors);
    if (head !== undefined) migrationSha(head, `${path}.head`, errors);
    if (branch !== undefined && branch !== null && !isSafeGitRef(branch)) {
      errors.push({ code: "invalid_value", path: `${path}.branch`, message: "branch is not a safe Git ref" });
    }
    if (upstream !== undefined && upstream !== null && !isSafeGitRef(upstream)) {
      errors.push({ code: "invalid_value", path: `${path}.upstream`, message: "upstream is not a safe Git ref" });
    }
    if (normalizedRemote !== undefined && normalizedRemote !== null) {
      migrationNormalizedRemote(normalizedRemote, `${path}.normalizedRemote`, errors);
    }
    return gitdirToken === undefined || topLevelToken === undefined || state === undefined || head === undefined ||
        branch === undefined || upstream === undefined || normalizedRemote === undefined
      ? undefined
      : { kind, gitdirToken, topLevelToken, state, head, branch, upstream, normalizedRemote };
  }
  return undefined;
}

function parseHistoricalRollInventory(value: unknown, errors: ContractError[]): readonly HistoricalRollEntry[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ code: "invalid_type", path: "rollInventory", message: "field must be an array" });
    return undefined;
  }
  const entries: HistoricalRollEntry[] = [];
  for (const [index, raw] of value.entries()) {
    const path = `rollInventory[${index}]`;
    const record = migrationRecord(raw, path, ["kind", "path", "digest", "bytes", "sourceClass", "storyId", "target"], errors);
    if (record === undefined) continue;
    const kind = migrationEnum(record, "kind", path, ["file", "symlink"] as const, errors);
    const entryPath = migrationString(record, "path", path, errors);
    if (entryPath !== undefined) migrationSafeRelative(entryPath, `${path}.path`, errors);
    if (kind === "symlink") {
      errors.push(...unknownFieldErrors(record, ["kind", "path", "target"], path));
      const target = migrationString(record, "target", path, errors);
      if (entryPath !== undefined && target !== undefined) entries.push({ kind, path: entryPath, target });
      continue;
    }
    if (kind === "file") {
      errors.push(...unknownFieldErrors(record, ["kind", "path", "digest", "bytes", "sourceClass", "storyId"], path));
      const digest = migrationString(record, "digest", path, errors);
      const bytes = record["bytes"];
      const sourceClass = migrationEnum(
        record,
        "sourceClass",
        path,
        ["backlog", "story_contract", "story_evidence", "design", "requirement", "runtime", "projection", "unknown", "rebuildable"] as const,
        errors,
      );
      const storyId = migrationOptionalString(record, "storyId", path, errors);
      if (digest !== undefined && !MIGRATION_DIGEST_PATTERN.test(digest)) {
        errors.push({ code: "invalid_value", path: `${path}.digest`, message: "digest must be lowercase SHA-256" });
      }
      if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) {
        errors.push({ code: "invalid_value", path: `${path}.bytes`, message: "bytes must be a non-negative safe integer" });
      }
      const storyClass = sourceClass === "story_contract" || sourceClass === "story_evidence";
      if (storyClass && (storyId === undefined || !isSafeIdentifier(storyId))) {
        errors.push({ code: "invalid_value", path: `${path}.storyId`, message: "Story inventory entries require a safe Story ID" });
      }
      if (!storyClass && storyId !== undefined) {
        errors.push({ code: "invalid_value", path: `${path}.storyId`, message: "only Story inventory entries may declare a Story ID" });
      }
      if (entryPath !== undefined && digest !== undefined && Number.isSafeInteger(bytes) && (bytes as number) >= 0) {
        if ((sourceClass === "story_contract" || sourceClass === "story_evidence") && storyId !== undefined) {
          entries.push({ kind, path: entryPath, digest, bytes: bytes as number, sourceClass, storyId });
        } else if (
          sourceClass !== undefined && sourceClass !== "story_contract" && sourceClass !== "story_evidence" &&
          storyId === undefined
        ) {
          entries.push({ kind, path: entryPath, digest, bytes: bytes as number, sourceClass });
        }
      }
    }
  }
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    errors.push({ code: "duplicate_identity", path: "rollInventory", message: "inventory paths must be unique" });
  }
  return entries.length === value.length ? entries : undefined;
}

function parseRepositoryCacheFacts(value: unknown, errors: ContractError[]): RepositoryCacheFacts | undefined {
  const path = "cache";
  const record = migrationRecord(value, path, ["status", "repoId", "cachePath"], errors);
  if (record === undefined) return undefined;
  const status = migrationEnum(record, "status", path, ["absent", "matching", "conflict"] as const, errors);
  const repoId = migrationString(record, "repoId", path, errors);
  const cachePath = migrationString(record, "cachePath", path, errors);
  if (repoId !== undefined && !/^repo-[0-9a-f]{12}$/u.test(repoId)) {
    errors.push({ code: "invalid_value", path: `${path}.repoId`, message: "repository ID is invalid" });
  }
  if (cachePath !== undefined) migrationSafeRelative(cachePath, `${path}.cachePath`, errors);
  return status === undefined || repoId === undefined || cachePath === undefined ? undefined : { status, repoId, cachePath };
}

function parseWorkspaceRegistryFacts(value: unknown, errors: ContractError[]): WorkspaceRegistryFacts | undefined {
  const path = "registry";
  const record = migrationRecord(value, path, ["status", "workspaceId"], errors);
  if (record === undefined) return undefined;
  const status = migrationEnum(record, "status", path, ["available", "same_workspace", "id_conflict", "repo_conflict"] as const, errors);
  const workspaceId = migrationString(record, "workspaceId", path, errors);
  if (workspaceId !== undefined && !isSafeIdentifier(workspaceId)) {
    errors.push({ code: "invalid_value", path: `${path}.workspaceId`, message: "Workspace ID is unsafe" });
  }
  return status === undefined || workspaceId === undefined ? undefined : { status, workspaceId };
}

/** Parse the complete read-only adapter output before the pure migration planner runs. */
export function parseHistoricalMigrationFacts(value: unknown): ContractResult<HistoricalMigrationFacts> {
  if (!isRecord(value)) return fail("invalid_type", "migration", "historical migration facts must be an object");
  const errors = unknownFieldErrors(value, [
    "schema",
    "sourceRoot",
    "repoId",
    "requestedWorkspaceId",
    "git",
    "linkedWorktrees",
    "submodules",
    "runtime",
    "rollOwnership",
    "rollInventory",
    "cache",
    "registry",
  ], "");
  if (value["schema"] !== WORKSPACE_MIGRATION_FACTS_V1) {
    errors.push({ code: "unknown_version", path: "schema", message: `expected ${WORKSPACE_MIGRATION_FACTS_V1}` });
  }
  const sourceRoot = migrationString(value, "sourceRoot", "migration", errors);
  const repoId = migrationString(value, "repoId", "migration", errors);
  const requestedWorkspaceId = migrationOptionalString(value, "requestedWorkspaceId", "migration", errors);
  if (repoId !== undefined && !/^repo-[0-9a-f]{12}$/u.test(repoId)) {
    errors.push({ code: "invalid_value", path: "repoId", message: "repository ID is invalid" });
  }
  if (requestedWorkspaceId !== undefined && !isSafeIdentifier(requestedWorkspaceId)) {
    errors.push({ code: "invalid_value", path: "requestedWorkspaceId", message: "Workspace ID is unsafe" });
  }
  const git = parseProductGitFacts(value["git"], errors);
  const linkedWorktrees = parseLinkedWorktrees(value["linkedWorktrees"], errors);
  const submodules = parseSubmodules(value["submodules"], errors);
  const runtime = parseHistoricalRuntime(value["runtime"], errors);
  const rollOwnership = parseHistoricalRollOwnership(value["rollOwnership"], errors);
  const rollInventory = parseHistoricalRollInventory(value["rollInventory"], errors);
  const cache = parseRepositoryCacheFacts(value["cache"], errors);
  const registry = parseWorkspaceRegistryFacts(value["registry"], errors);
  if (rollOwnership?.kind === "product_tracked" && rollInventory !== undefined) {
    const files = new Set(rollInventory.filter((entry) => entry.kind === "file").map((entry) => entry.path));
    rollOwnership.trackedPaths.forEach((path, index) => {
      if (!files.has(path)) {
        errors.push({
          code: "invalid_value",
          path: `rollOwnership.trackedPaths[${index}]`,
          message: "tracked ownership path must name a digest-backed inventory file",
        });
      }
    });
  }
  if (rollOwnership?.kind === "independent_git" && rollInventory !== undefined) {
    rollInventory.forEach((entry, index) => {
      if (entry.path === ".git" || entry.path.startsWith(".git/")) {
        errors.push({
          code: "invalid_value",
          path: `rollInventory[${index}].path`,
          message: "independent roll-meta object database is not surface inventory",
        });
      }
    });
  }
  if (
    errors.length > 0 || value["schema"] !== WORKSPACE_MIGRATION_FACTS_V1 || sourceRoot === undefined ||
    repoId === undefined || git === undefined || linkedWorktrees === undefined || submodules === undefined ||
    runtime === undefined || rollOwnership === undefined || rollInventory === undefined || cache === undefined || registry === undefined
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schema: WORKSPACE_MIGRATION_FACTS_V1,
      sourceRoot,
      repoId,
      ...(requestedWorkspaceId === undefined ? {} : { requestedWorkspaceId }),
      git,
      linkedWorktrees,
      submodules,
      runtime,
      rollOwnership,
      rollInventory,
      cache,
      registry,
    },
  };
}
