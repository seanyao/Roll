import { describe, expect, it } from "vitest";
import {
  authorizesLegacyWorkspaceContextOperation,
  auditWorkspaceContextPolicies,
  buildWorkspaceContextCompatibilityMatrix,
  type WorkspaceContextSurfaceInventoryItem,
} from "../src/workspace/context-policy.js";
import { validateWorkspaceContextPolicy, type WorkspaceContextPolicy } from "@roll/spec";

const inventory: readonly WorkspaceContextSurfaceInventoryItem[] = [
  { surface: "cli", id: "backlog", operation: "read", supportsWorkspaceSelector: true },
  { surface: "skill", id: "roll-build", operation: "build" },
  { surface: "tool", id: "filesystem", operation: "read" },
  { surface: "tool", id: "filesystem", operation: "write" },
];

const policies: readonly WorkspaceContextPolicy[] = [
  {
    surface: "cli", id: "backlog", operation: "read",
    scope: "workspace_required_read", contextConsumer: "workspace",
    allowsAmbientCwd: false, allowsLegacyRollPath: false, acceptsWorkspaceSelector: true,
  },
  {
    surface: "skill", id: "roll-build", operation: "build",
    scope: "issue_required", contextConsumer: "issue",
    allowsAmbientCwd: false, allowsLegacyRollPath: false,
  },
  {
    surface: "tool", id: "filesystem", operation: "read",
    scope: "repository_required", contextConsumer: "repository",
    allowsAmbientCwd: false, allowsLegacyRollPath: false,
  },
  {
    surface: "tool", id: "filesystem", operation: "write",
    scope: "repository_required", contextConsumer: "repository",
    allowsAmbientCwd: false, allowsLegacyRollPath: false,
  },
];

describe("US-WS-032 Workspace context policy", () => {
  it("authorizes legacy context only for exact lifecycle operation provenance", () => {
    expect(authorizesLegacyWorkspaceContextOperation({ surface: "cli", id: "workspace", operation: "migrate" })).toBe(true);
    expect(authorizesLegacyWorkspaceContextOperation({ surface: "cli", id: "init", operation: "onboard" })).toBe(true);
    expect(authorizesLegacyWorkspaceContextOperation({ surface: "cli", id: "setup", operation: "offboard" })).toBe(true);
    expect(authorizesLegacyWorkspaceContextOperation(undefined)).toBe(false);
    expect(authorizesLegacyWorkspaceContextOperation(null as never)).toBe(false);
    expect(authorizesLegacyWorkspaceContextOperation({ surface: "cli", id: "loop", operation: "run-once" })).toBe(false);
    expect(authorizesLegacyWorkspaceContextOperation({
      surface: "cli",
      id: "workspace",
      operation: "migrate",
      forged: true,
    } as never)).toBe(false);
  });

  it("closes the registry over every actual surface operation", () => {
    expect(auditWorkspaceContextPolicies({ inventory, policies })).toEqual([]);
  });

  it("fails closed for missing, orphaned, and duplicate policy keys", () => {
    const findings = auditWorkspaceContextPolicies({
      inventory,
      policies: [policies[0]!, policies[0]!, policies[1]!, policies[2]!, {
        ...policies[3]!, id: "unknown",
      }],
    });
    expect(findings.map((finding) => finding.code)).toEqual([
      "duplicate_policy_key",
      "missing_policy",
      "orphan_policy",
    ]);
  });

  it("rejects invalid scope consumers and ambient or legacy fallbacks without a rationale", () => {
    const findings = auditWorkspaceContextPolicies({
      inventory: inventory.slice(0, 3),
      policies: [
        { ...policies[0]!, contextConsumer: "issue" },
        {
          surface: "skill", id: "roll-build", operation: "build", scope: "machine_only",
          allowsAmbientCwd: true, allowsLegacyRollPath: false,
        },
        {
          surface: "tool", id: "filesystem", operation: "read", scope: "legacy_migration_only",
          allowsAmbientCwd: false, allowsLegacyRollPath: true, rationale: "  ",
        },
      ],
    });
    expect(findings.map((finding) => finding.code)).toEqual([
      "invalid_scope_consumer",
      "missing_fallback_rationale",
      "missing_fallback_rationale",
    ]);
  });

  it.each([
    ["unknown scope", { ...policies[0]!, scope: "future_scope" }, "invalid_scope"],
    ["wrong selector type", { ...policies[0]!, acceptsWorkspaceSelector: "yes" }, "invalid_type"],
    ["unknown access", { ...policies[1]!, access: "admin" }, "invalid_value"],
    ["unknown repository selector policy", { ...policies[1]!, repositorySelector: "optional" }, "invalid_value"],
    ["extra field", { ...policies[0]!, undocumented: true }, "unknown_key"],
    ["empty id", { ...policies[0]!, id: "" }, "invalid_value"],
    ["unknown consumer", { ...policies[0]!, contextConsumer: "project" }, "invalid_consumer"],
  ] as const)("rejects closed-schema violation: %s", (_name, policy, code) => {
    expect(validateWorkspaceContextPolicy(policy).map((issue) => issue.code)).toContain(code);
    expect(auditWorkspaceContextPolicies({
      inventory: inventory.slice(0, 1),
      policies: [policy as unknown as WorkspaceContextPolicy],
    }).map((finding) => finding.code)).toContain("invalid_policy_schema");
  });

  it("accepts the supporting-skill access and repository-selector execution contract", () => {
    expect(validateWorkspaceContextPolicy({
      ...policies[1]!,
      access: "read",
      repositorySelector: "required",
    })).toEqual([]);
  });

  it("rejects fallback permissions outside machine or migration scopes", () => {
    const findings = auditWorkspaceContextPolicies({
      inventory: inventory.slice(0, 1),
      policies: [{ ...policies[0]!, allowsAmbientCwd: true, rationale: "old project lookup" }],
    });
    expect(findings.map((finding) => finding.code)).toEqual(["invalid_fallback_scope"]);
  });

  it("rejects selector declarations that disagree with the registered handler capability", () => {
    const findings = auditWorkspaceContextPolicies({
      inventory: [
        { surface: "cli", id: "backlog", operation: "read", supportsWorkspaceSelector: false },
        { surface: "tool", id: "filesystem", operation: "read", supportsWorkspaceSelector: true },
      ],
      policies: [policies[0]!, { ...policies[2]!, acceptsWorkspaceSelector: true }],
    });
    expect(findings.map((finding) => finding.code)).toEqual([
      "selector_capability_mismatch",
      "selector_capability_mismatch",
    ]);
  });

  it("emits a stable operation-level machine matrix", () => {
    const matrix = buildWorkspaceContextCompatibilityMatrix({
      inventory: [...inventory].reverse(),
      policies: [...policies].reverse(),
    });
    expect(matrix.schema).toBe("roll.workspace-context-compatibility-matrix/v1");
    expect(matrix.summary).toEqual({
      cliFamilies: 1,
      cliOperations: 1,
      skillFamilies: 1,
      skillOperations: 1,
      toolAdapters: 1,
      toolOperations: 2,
    });
    expect(matrix.rows.map((row) => `${row.surface}:${row.id}:${row.operation}`)).toEqual([
      "cli:backlog:read",
      "skill:roll-build:build",
      "tool:filesystem:read",
      "tool:filesystem:write",
    ]);
  });
});
