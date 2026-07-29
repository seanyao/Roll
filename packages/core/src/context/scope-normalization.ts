import {
  normalizeRepositoryRemote,
  type ContextPageScopeV1,
  type ContextStage,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { validateStoryId } from "../workspace/issue-init-plan.js";

export const CONTEXT_SCOPE_DIMENSIONS = [
  "workspace_ids",
  "repository_ids",
  "environment_ids",
  "story_ids",
  "stages",
] as const;

export type ContextScopeDimension = (typeof CONTEXT_SCOPE_DIMENSIONS)[number];
export type NormalizedContextScope = Readonly<Partial<Record<ContextScopeDimension, readonly string[]>>>;

export interface ContextScopeRequestFacts {
  readonly workspace: WorkspaceExecutionContextV1;
  readonly storyId?: string;
  readonly stage: string;
  readonly environmentIds?: readonly string[];
}

export interface ContextScopeNormalizationResult {
  readonly value: NormalizedContextScope;
  readonly invalidDimensions: readonly ContextScopeDimension[];
}

const CONTEXT_STAGES = new Set<ContextStage>([
  "clarify",
  "design",
  "tasking",
  "build",
  "qa",
  "review",
  "fix",
  "operation",
]);

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

function normalizeValues(
  values: readonly string[],
  normalize: (value: string) => string | undefined,
): { readonly values: readonly string[]; readonly invalid: boolean } {
  const normalized: string[] = [];
  let invalid = false;
  for (const value of values) {
    if (typeof value !== "string") {
      invalid = true;
      continue;
    }
    const result = normalize(value);
    if (result === undefined) invalid = true;
    else normalized.push(result);
  }
  return { values: uniqueSorted(normalized), invalid };
}

function canonicalWorkspaceId(value: string): string | undefined {
  return value !== "" && value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
    ? value
    : undefined;
}

function canonicalRepositoryId(value: string): string | undefined {
  const result = normalizeRepositoryRemote(value);
  return result.ok ? result.value : undefined;
}

function canonicalEnvironmentId(value: string): string | undefined {
  return value !== "" && value === value.trim() && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value)
    ? value
    : undefined;
}

function canonicalStoryId(value: string): string | undefined {
  const normalized = value.trim().toUpperCase();
  const result = validateStoryId(normalized);
  return result.ok ? result.value : undefined;
}

function canonicalStage(value: string): string | undefined {
  return CONTEXT_STAGES.has(value as ContextStage) ? value : undefined;
}

function result(
  values: Readonly<Partial<Record<ContextScopeDimension, readonly string[]>>>,
  invalid: ReadonlySet<ContextScopeDimension>,
): ContextScopeNormalizationResult {
  const ordered: Partial<Record<ContextScopeDimension, readonly string[]>> = {};
  for (const dimension of CONTEXT_SCOPE_DIMENSIONS) {
    const entries = values[dimension];
    if (entries !== undefined) ordered[dimension] = entries;
  }
  return {
    value: ordered,
    invalidDimensions: CONTEXT_SCOPE_DIMENSIONS.filter((dimension) => invalid.has(dimension)),
  };
}

function addPageDimension(
  target: Partial<Record<ContextScopeDimension, readonly string[]>>,
  invalid: Set<ContextScopeDimension>,
  dimension: ContextScopeDimension,
  values: readonly string[] | undefined,
  normalize: (value: string) => string | undefined,
): void {
  if (values === undefined || values.length === 0) return;
  const normalized = normalizeValues(values, normalize);
  if (normalized.invalid) invalid.add(dimension);
  if (normalized.values.length > 0) target[dimension] = normalized.values;
}

export function normalizeContextPageScope(scope: ContextPageScopeV1): ContextScopeNormalizationResult {
  const values: Partial<Record<ContextScopeDimension, readonly string[]>> = {};
  const invalid = new Set<ContextScopeDimension>();
  addPageDimension(values, invalid, "workspace_ids", scope.workspace_ids, canonicalWorkspaceId);
  addPageDimension(values, invalid, "repository_ids", scope.repository_ids, canonicalRepositoryId);
  addPageDimension(values, invalid, "environment_ids", scope.environment_ids, canonicalEnvironmentId);
  addPageDimension(values, invalid, "story_ids", scope.story_ids, canonicalStoryId);
  addPageDimension(values, invalid, "stages", scope.stages, canonicalStage);
  return result(values, invalid);
}

export function normalizeContextScopeRequest(input: ContextScopeRequestFacts): ContextScopeNormalizationResult {
  const values: Partial<Record<ContextScopeDimension, readonly string[]>> = {};
  const invalid = new Set<ContextScopeDimension>();

  const workspace = normalizeValues([input.workspace.workspace.workspaceId], canonicalWorkspaceId);
  values.workspace_ids = workspace.values;
  if (workspace.invalid) invalid.add("workspace_ids");

  const repositories = normalizeValues(input.workspace.bindings.map((entry) => entry.remote), canonicalRepositoryId);
  values.repository_ids = repositories.values;
  if (repositories.invalid) invalid.add("repository_ids");

  if (input.environmentIds !== undefined) {
    const environments = normalizeValues(input.environmentIds, canonicalEnvironmentId);
    values.environment_ids = environments.values;
    if (environments.invalid) invalid.add("environment_ids");
  }

  if (input.storyId !== undefined) {
    const stories = normalizeValues([input.storyId], canonicalStoryId);
    values.story_ids = stories.values;
    if (stories.invalid) invalid.add("story_ids");
  }

  const stages = normalizeValues([input.stage], canonicalStage);
  values.stages = stages.values;
  if (stages.invalid) invalid.add("stages");

  return result(values, invalid);
}
