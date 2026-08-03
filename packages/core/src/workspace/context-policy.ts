import type {
  WorkspaceContextOperationProvenance,
  WorkspaceContextPolicy,
  WorkspaceContextPolicySurface,
} from "@roll/spec";
import { validateWorkspaceContextPolicy } from "@roll/spec";

export interface WorkspaceContextSurfaceInventoryItem {
  readonly surface: WorkspaceContextPolicySurface;
  readonly id: string;
  readonly operation: string;
  readonly supportsWorkspaceSelector?: boolean;
}

export type WorkspaceContextPolicyFindingCode =
  | "duplicate_inventory_key"
  | "duplicate_policy_key"
  | "invalid_policy_schema"
  | "missing_policy"
  | "orphan_policy"
  | "invalid_scope_consumer"
  | "invalid_fallback_scope"
  | "missing_fallback_rationale"
  | "selector_capability_mismatch";

export interface WorkspaceContextPolicyFinding {
  readonly code: WorkspaceContextPolicyFindingCode;
  readonly key: string;
  readonly message: string;
}

export interface WorkspaceContextCompatibilityMatrixV1 {
  readonly schema: "roll.workspace-context-compatibility-matrix/v1";
  readonly summary: {
    readonly cliFamilies: number;
    readonly cliOperations: number;
    readonly skillFamilies: number;
    readonly skillOperations: number;
    readonly toolAdapters: number;
    readonly toolOperations: number;
  };
  readonly rows: readonly WorkspaceContextPolicy[];
}

const LEGACY_WORKSPACE_CONTEXT_OPERATIONS = new Set([
  "cli:workspace:migrate",
  "cli:init:onboard",
  "cli:setup:offboard",
]);

/** Legacy authority is granted only by one of the three public lifecycle
 * operations whose audited policy explicitly owns that boundary. */
export function authorizesLegacyWorkspaceContextOperation(
  value: WorkspaceContextOperationProvenance | undefined,
): boolean {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || keys.some((key) => !["surface", "id", "operation"].includes(key))) return false;
  return LEGACY_WORKSPACE_CONTEXT_OPERATIONS.has(`${value.surface}:${value.id}:${value.operation}`);
}

function keyOf(item: Pick<WorkspaceContextSurfaceInventoryItem, "surface" | "id" | "operation">): string {
  return `${item.surface}:${item.id}:${item.operation}`;
}

function compareKeys(left: Pick<WorkspaceContextSurfaceInventoryItem, "surface" | "id" | "operation">, right: Pick<WorkspaceContextSurfaceInventoryItem, "surface" | "id" | "operation">): number {
  return keyOf(left).localeCompare(keyOf(right));
}

function duplicateKeys(items: readonly WorkspaceContextSurfaceInventoryItem[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates].sort();
}

function duplicatePolicyKeys(items: readonly WorkspaceContextPolicy[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates].sort();
}

export function auditWorkspaceContextPolicies(input: {
  readonly inventory: readonly WorkspaceContextSurfaceInventoryItem[];
  readonly policies: readonly WorkspaceContextPolicy[];
}): WorkspaceContextPolicyFinding[] {
  const findings: WorkspaceContextPolicyFinding[] = [];
  const inventoryByKey = new Map(input.inventory.map((item) => [keyOf(item), item]));
  const validPolicies: WorkspaceContextPolicy[] = [];
  const presentPolicyKeys = new Set<string>();
  for (const [index, policy] of input.policies.entries()) {
    const partial = policy as unknown as Record<string, unknown>;
    const hasIdentity = typeof partial === "object" && partial !== null
      && typeof partial["surface"] === "string"
      && typeof partial["id"] === "string"
      && typeof partial["operation"] === "string";
    const key = hasIdentity
      ? `${partial["surface"]}:${partial["id"]}:${partial["operation"]}`
      : `policy[${index}]`;
    if (hasIdentity) presentPolicyKeys.add(key);
    const issues = validateWorkspaceContextPolicy(policy);
    if (issues.length === 0) {
      validPolicies.push(policy);
      continue;
    }
    const schemaIssues = issues.filter((issue) => issue.code !== "invalid_scope_consumer");
    if (schemaIssues.length > 0) {
      findings.push({
        code: "invalid_policy_schema",
        key,
        message: `${key} invalid policy schema: ${schemaIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      });
    }
    for (const issue of issues.filter((candidate) => candidate.code === "invalid_scope_consumer")) {
      findings.push({ code: "invalid_scope_consumer", key, message: `${key} ${issue.message}` });
    }
  }
  const policyByKey = new Map(validPolicies.map((policy) => [keyOf(policy), policy]));

  for (const key of duplicateKeys(input.inventory)) {
    findings.push({ code: "duplicate_inventory_key", key, message: `duplicate inventory key: ${key}` });
  }
  for (const key of duplicatePolicyKeys(validPolicies)) {
    findings.push({ code: "duplicate_policy_key", key, message: `duplicate policy key: ${key}` });
  }
  for (const key of [...inventoryByKey.keys()].sort()) {
    if (!presentPolicyKeys.has(key)) findings.push({ code: "missing_policy", key, message: `missing policy: ${key}` });
  }
  for (const key of [...policyByKey.keys()].sort()) {
    if (!inventoryByKey.has(key)) findings.push({ code: "orphan_policy", key, message: `policy has no registered surface: ${key}` });
  }

  for (const policy of [...validPolicies].sort(compareKeys)) {
    const key = keyOf(policy);
    const allowsFallback = policy.allowsAmbientCwd || policy.allowsLegacyRollPath;
    if (allowsFallback && policy.scope !== "machine_only" && policy.scope !== "legacy_migration_only") {
      findings.push({
        code: "invalid_fallback_scope",
        key,
        message: `${key} may only allow ambient cwd or legacy paths in machine/migration scope`,
      });
    }
    if (allowsFallback && (policy.rationale ?? "").trim() === "") {
      findings.push({
        code: "missing_fallback_rationale",
        key,
        message: `${key} fallback permission requires a rationale`,
      });
    }
    const inventoryItem = inventoryByKey.get(key);
    const acceptsSelector = policy.acceptsWorkspaceSelector === true;
    const supportsSelector = policy.surface === "cli" && inventoryItem?.supportsWorkspaceSelector === true;
    if (acceptsSelector !== supportsSelector) {
      findings.push({
        code: "selector_capability_mismatch",
        key,
        message: `${key} selector policy (${acceptsSelector}) disagrees with handler capability (${supportsSelector})`,
      });
    }
  }

  return findings.sort((left, right) => {
    const key = left.key.localeCompare(right.key);
    return key !== 0 ? key : left.code.localeCompare(right.code);
  });
}

export function buildWorkspaceContextCompatibilityMatrix(input: {
  readonly inventory: readonly WorkspaceContextSurfaceInventoryItem[];
  readonly policies: readonly WorkspaceContextPolicy[];
}): WorkspaceContextCompatibilityMatrixV1 {
  const findings = auditWorkspaceContextPolicies(input);
  if (findings.length > 0) {
    throw new Error(`workspace-context-policy: ${findings.map((finding) => finding.message).join("; ")}`);
  }
  return {
    schema: "roll.workspace-context-compatibility-matrix/v1",
    summary: {
      cliFamilies: new Set(input.inventory.filter((item) => item.surface === "cli").map((item) => item.id)).size,
      cliOperations: input.inventory.filter((item) => item.surface === "cli").length,
      skillFamilies: new Set(input.inventory.filter((item) => item.surface === "skill").map((item) => item.id)).size,
      skillOperations: input.inventory.filter((item) => item.surface === "skill").length,
      toolAdapters: new Set(input.inventory.filter((item) => item.surface === "tool").map((item) => item.id)).size,
      toolOperations: input.inventory.filter((item) => item.surface === "tool").length,
    },
    rows: [...input.policies].sort(compareKeys),
  };
}
