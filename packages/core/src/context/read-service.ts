import { join } from "node:path";
import {
  CONTEXT_READ_RESULT_V1,
  parseContextRef,
  type ContextDiagnosticV1,
  type ContextProviderExecutionPlanV1,
  type ContextProviderRegistryV1,
  type ContextReadFileV1,
  type ContextReadProviderSnapshotV1,
  type ContextReadRequestV1,
  type ContextReadResultV1,
} from "@roll/spec";
import { compileContextProviderExecutionPlans } from "./execution-plan.js";
import { evaluateContextScope, normalizeContextScopeRequest } from "./scope-policy.js";
import { computeContextSnapshotDigest, contextSnapshotId } from "./snapshot.js";

export interface ContextProviderRevisionV1 {
  readonly providerId: string;
  readonly remoteIdentity: string;
  readonly branch: string;
  readonly fetchedAt: string;
  readonly revision: string;
}

export interface ContextProviderReadSuccessV1 {
  readonly ok: true;
  readonly revision: ContextProviderRevisionV1;
  readonly files: readonly ContextReadFileV1[];
  readonly warnings: readonly ContextDiagnosticV1[];
}

export interface ContextProviderReadFailureV1 {
  readonly ok: false;
  readonly diagnostic: ContextDiagnosticV1;
}

export type ContextProviderReadOutcomeV1 = ContextProviderReadSuccessV1 | ContextProviderReadFailureV1;

export interface ContextProviderReadInputV1 {
  readonly plan: ContextProviderExecutionPlanV1;
  readonly request: ContextReadRequestV1;
  readonly paths: readonly string[];
  readonly refs: readonly string[];
}

export interface ContextProviderReadAdapter {
  read(input: ContextProviderReadInputV1): Promise<ContextProviderReadOutcomeV1>;
}

export interface ContextReadService {
  read(request: ContextReadRequestV1): Promise<ContextReadResultV1>;
}

export interface CreateContextReadServiceOptions {
  readonly registry: ContextProviderRegistryV1;
  readonly adapter: ContextProviderReadAdapter;
  readonly now?: () => number;
  readonly authorizeRestrictedReference?: (
    request: ContextReadRequestV1,
    file: ContextReadFileV1,
  ) => boolean;
}

interface ProviderExecutionResult {
  readonly snapshot?: ContextReadProviderSnapshotV1;
  readonly gap?: ContextDiagnosticV1;
}

const SAFE_SCOPE_DIMENSIONS = new Set([
  "workspace_ids",
  "repository_ids",
  "environment_ids",
  "story_ids",
  "stages",
]);

function severityFor(plan: ContextProviderExecutionPlanV1): ContextDiagnosticV1["severity"] {
  return plan.binding.required ? "blocking" : "gap";
}

function providerDiagnostic(
  plan: ContextProviderExecutionPlanV1,
  diagnostic: ContextDiagnosticV1,
): ContextDiagnosticV1 {
  const parsedRef = diagnostic.ref === undefined ? undefined : parseContextRef(diagnostic.ref);
  const safeRef = parsedRef?.ok === true && parsedRef.value.providerId === plan.provider.id
    ? parsedRef.value.ref
    : undefined;
  const mismatchedDimensions = diagnostic.mismatchedDimensions?.filter((dimension) => SAFE_SCOPE_DIMENSIONS.has(dimension));
  return {
    code: diagnostic.code,
    severity: severityFor(plan),
    providerId: plan.provider.id,
    ...(safeRef === undefined ? {} : { ref: safeRef }),
    message: `Context Provider read failed (${diagnostic.code})`,
    ...(mismatchedDimensions === undefined || mismatchedDimensions.length === 0 ? {} : { mismatchedDimensions }),
  };
}

function providerWarning(
  plan: ContextProviderExecutionPlanV1,
  diagnostic: ContextDiagnosticV1,
): ContextDiagnosticV1 {
  const parsedRef = diagnostic.ref === undefined ? undefined : parseContextRef(diagnostic.ref);
  const safeRef = parsedRef?.ok === true && parsedRef.value.providerId === plan.provider.id
    ? parsedRef.value.ref
    : undefined;
  const mismatchedDimensions = diagnostic.mismatchedDimensions?.filter((dimension) => SAFE_SCOPE_DIMENSIONS.has(dimension));
  return {
    code: diagnostic.code,
    severity: "warning",
    providerId: plan.provider.id,
    ...(safeRef === undefined ? {} : { ref: safeRef }),
    message: `Context Provider warning (${diagnostic.code})`,
    ...(mismatchedDimensions === undefined || mismatchedDimensions.length === 0 ? {} : { mismatchedDimensions }),
  };
}

function genericProviderFailure(plan: ContextProviderExecutionPlanV1): ContextDiagnosticV1 {
  return {
    code: "fetch_failed",
    severity: severityFor(plan),
    providerId: plan.provider.id,
    message: "Context Provider read failed",
  };
}

function requestScope(request: ContextReadRequestV1): ContextReadResultV1["requestScope"] {
  const normalized = normalizeContextScopeRequest(request);
  const repositoryIds = normalized.value.repository_ids ?? [];
  const environmentIds = normalized.value.environment_ids ?? [];
  const storyId = normalized.value.story_ids?.[0];
  return {
    workspaceId: request.workspace.workspace.workspaceId,
    ...(storyId === undefined ? {} : { storyId }),
    repositoryIds,
    environmentIds,
    stage: request.stage,
  };
}

function artifactResult(
  request: ContextReadRequestV1,
  outcome: ContextReadResultV1["outcome"],
  providers: readonly ContextReadProviderSnapshotV1[],
  gaps: readonly ContextDiagnosticV1[],
  now: () => number,
): ContextReadResultV1 {
  const createdAt = new Date(now()).toISOString();
  const scope = requestScope(request);
  const payload = {
    schema: CONTEXT_READ_RESULT_V1,
    createdAt,
    outcome,
    requestScope: scope,
    providers,
    gaps,
  };
  const provisional: ContextReadResultV1 = {
    ...payload,
    snapshotId: "pending",
    snapshotDigest: "0".repeat(64),
    artifactPath: "pending",
  };
  const snapshotDigest = computeContextSnapshotDigest(provisional);
  const snapshotId = contextSnapshotId(createdAt, snapshotDigest);
  if (snapshotId === undefined) throw new TypeError("Context Snapshot timestamp is invalid");
  const scopeFolder = scope.storyId ?? "_workspace";
  return {
    ...payload,
    snapshotId,
    snapshotDigest,
    artifactPath: join(request.workspace.authorities.runtime, "context", scopeFolder, `${snapshotId}.json`),
  };
}

function invalidRequestScope(request: ContextReadRequestV1): ContextDiagnosticV1 | undefined {
  const normalized = normalizeContextScopeRequest(request);
  if (normalized.invalidDimensions.length === 0) return undefined;
  return {
    code: "scope_mismatch",
    severity: "blocking",
    message: "Context request scope is invalid",
    mismatchedDimensions: normalized.invalidDimensions,
  };
}

function explicitPaths(request: ContextReadRequestV1, providerId: string): readonly string[] {
  return request.refs.flatMap((ref) => {
    const parsed = parseContextRef(ref);
    return parsed.ok && parsed.value.providerId === providerId ? [parsed.value.path] : [];
  });
}

function processProviderFiles(
  plan: ContextProviderExecutionPlanV1,
  request: ContextReadRequestV1,
  files: readonly ContextReadFileV1[],
  authorizeRestrictedReference: CreateContextReadServiceOptions["authorizeRestrictedReference"],
): { readonly files?: readonly ContextReadFileV1[]; readonly warnings: readonly ContextDiagnosticV1[]; readonly gap?: ContextDiagnosticV1 } {
  const explicitRefs = new Set(request.refs);
  const output: ContextReadFileV1[] = [];
  const warnings: ContextDiagnosticV1[] = [];
  for (const file of files) {
    if (file.page === undefined) {
      output.push(file);
      continue;
    }
    if (file.page.status !== "active" && request.includeNonActive !== true) {
      warnings.push({
        code: "scope_mismatch",
        severity: "warning",
        providerId: plan.provider.id,
        ref: file.ref,
        message: "Non-active Context page was omitted",
      });
      continue;
    }
    if (file.page.sensitivity === "restricted_reference") {
      const explicit = explicitRefs.has(file.ref);
      const authorized = explicit && request.includeRestrictedReferences === true &&
        authorizeRestrictedReference?.(request, file) === true;
      if (!authorized) {
        if (!explicit) {
          warnings.push({
            code: "restricted_context_denied",
            severity: "warning",
            providerId: plan.provider.id,
            ref: file.ref,
            message: "Implicit restricted Context page was omitted",
          });
          continue;
        }
        return {
          warnings,
          gap: providerDiagnostic(plan, {
            code: "restricted_context_denied",
            severity: "blocking",
            providerId: plan.provider.id,
            ref: file.ref,
            message: "Restricted Context reference is not authorized",
          }),
        };
      }
    }
    const verdict = evaluateContextScope(file.page.scope, request);
    if (!verdict.allowed) {
      return {
        warnings,
        gap: providerDiagnostic(plan, {
          code: "scope_mismatch",
          severity: "blocking",
          providerId: plan.provider.id,
          ref: file.ref,
          message: "Context page scope does not match the request",
          mismatchedDimensions: verdict.mismatchedDimensions,
        }),
      };
    }
    output.push({ ...file, matchedScope: verdict.matchedScope });
  }
  return { files: output, warnings };
}

async function executeProvider(
  options: CreateContextReadServiceOptions,
  plan: ContextProviderExecutionPlanV1,
  request: ContextReadRequestV1,
): Promise<ProviderExecutionResult> {
  const refs = explicitPaths(request, plan.provider.id);
  let read: ContextProviderReadOutcomeV1;
  try {
    read = await options.adapter.read({ plan, request, paths: plan.paths, refs });
  } catch {
    return { gap: genericProviderFailure(plan) };
  }
  if (!read.ok) return { gap: providerDiagnostic(plan, read.diagnostic) };
  const processed = processProviderFiles(plan, request, read.files, options.authorizeRestrictedReference);
  if (processed.gap !== undefined || processed.files === undefined) return { gap: processed.gap ?? genericProviderFailure(plan) };
  return {
    snapshot: {
      providerId: read.revision.providerId,
      remoteIdentity: read.revision.remoteIdentity,
      branch: read.revision.branch,
      fetchedAt: read.revision.fetchedAt,
      revision: read.revision.revision,
      providerConfigDigest: plan.providerConfigDigest,
      bindingDigest: plan.bindingDigest,
      files: processed.files,
      warnings: [...read.warnings.map((warning) => providerWarning(plan, warning)), ...processed.warnings],
    },
  };
}

export function createContextReadService(options: CreateContextReadServiceOptions): ContextReadService {
  const now = options.now ?? Date.now;
  return {
    async read(request: ContextReadRequestV1): Promise<ContextReadResultV1> {
      const compilation = compileContextProviderExecutionPlans({
        registry: options.registry,
        workspace: request.workspace,
        refs: request.refs,
      });
      if (compilation.outcome === "disabled") {
        return artifactResult(request, "disabled", [], compilation.diagnostics, now);
      }
      if (compilation.outcome === "blocked") {
        return artifactResult(request, "blocked", [], compilation.diagnostics, now);
      }
      const invalidScope = invalidRequestScope(request);
      if (invalidScope !== undefined) return artifactResult(request, "blocked", [], [invalidScope], now);

      const execution = await Promise.all(compilation.plans.map((plan) => executeProvider(options, plan, request)));
      const providers = execution.flatMap((entry) => entry.snapshot === undefined ? [] : [entry.snapshot]);
      const gaps = [
        ...compilation.diagnostics,
        ...execution.flatMap((entry) => entry.gap === undefined ? [] : [entry.gap]),
      ];
      const outcome: ContextReadResultV1["outcome"] = gaps.some((gap) => gap.severity === "blocking")
        ? "blocked"
        : gaps.some((gap) => gap.severity === "gap") ? "partial" : "completed";
      return artifactResult(request, outcome, providers, gaps, now);
    },
  };
}
