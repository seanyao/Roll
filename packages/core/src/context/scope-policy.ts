import type { ContextPageScopeV1 } from "@roll/spec";
import {
  CONTEXT_SCOPE_DIMENSIONS,
  normalizeContextPageScope,
  normalizeContextScopeRequest,
  type ContextScopeDimension,
  type ContextScopeRequestFacts,
  type NormalizedContextScope,
} from "./scope-normalization.js";

export {
  CONTEXT_SCOPE_DIMENSIONS,
  normalizeContextPageScope,
  normalizeContextScopeRequest,
  type ContextScopeDimension,
  type ContextScopeRequestFacts,
  type NormalizedContextScope,
} from "./scope-normalization.js";

export type ContextScopeVerdict =
  | {
      readonly allowed: true;
      readonly matchedScope: NormalizedContextScope;
    }
  | {
      readonly allowed: false;
      readonly code: "scope_mismatch";
      readonly mismatchedDimensions: readonly ContextScopeDimension[];
    };

function intersection(page: readonly string[], request: readonly string[]): readonly string[] {
  const requested = new Set(request);
  return page.filter((value) => requested.has(value));
}

/** Evaluate metadata-only scope facts. Page content is intentionally absent. */
export function evaluateContextScope(
  pageScope: ContextPageScopeV1,
  request: ContextScopeRequestFacts,
): ContextScopeVerdict {
  const page = normalizeContextPageScope(pageScope);
  const requested = normalizeContextScopeRequest(request);
  const invalid = new Set<ContextScopeDimension>([
    ...page.invalidDimensions,
    ...requested.invalidDimensions,
  ]);
  const mismatched: ContextScopeDimension[] = [];
  const matched: Partial<Record<ContextScopeDimension, readonly string[]>> = {};

  for (const dimension of CONTEXT_SCOPE_DIMENSIONS) {
    if (invalid.has(dimension)) {
      mismatched.push(dimension);
      continue;
    }
    const pageValues = page.value[dimension];
    if (pageValues === undefined || pageValues.length === 0) continue;
    const requestValues = requested.value[dimension];
    if (requestValues === undefined || requestValues.length === 0) {
      mismatched.push(dimension);
      continue;
    }
    const values = intersection(pageValues, requestValues);
    if (values.length === 0) mismatched.push(dimension);
    else matched[dimension] = values;
  }

  return mismatched.length > 0
    ? { allowed: false, code: "scope_mismatch", mismatchedDimensions: mismatched }
    : { allowed: true, matchedScope: matched };
}
