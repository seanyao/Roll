#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrix = JSON.parse(fs.readFileSync(path.join(root, "docs", "generated", "workspace-context-compatibility-matrix.json"), "utf8"));

const operationTestFiles = {
  cli: "packages/cli/test/workspace-context-operation-evidence.test.ts",
  skill: "packages/cli/test/workspace-context-operation-evidence.test.ts",
  tool: "packages/infra/test/workspace-context-operation-evidence.test.ts",
};

function operationTestName(row, policyKey) {
  if (row.surface === "cli") return `executes registered CLI probe for ${policyKey}`;
  if (row.surface === "skill") return `validates shipped Skill manifest policy for ${policyKey}`;
  return `rejects missing execution context before adapter effects for ${policyKey}`;
}

const operationCases = matrix.rows.map((row) => {
  const policyKey = `${row.surface}:${row.id}:${row.operation}`;
  const proves = row.surface === "cli"
    ? ["operation_policy", "cli_registration_probe"]
    : row.surface === "skill"
      ? ["operation_policy", "skill_manifest_policy"]
      : ["operation_policy", "tool_adapter_context_boundary"];
  return {
    id: `operation:${policyKey}`,
    policyKey,
    surface: row.surface,
    testFile: operationTestFiles[row.surface],
    testName: operationTestName(row, policyKey),
    proves,
  };
});

const crossCuttingCases = [
  {
    id: "matrix.registry-closure",
    testFile: "packages/cli/test/workspace-surface-inventory.test.ts",
    testName: "closes the registered inventory and matches the stable machine artifact",
    proves: ["matrix_registry_closure", "operation_policy"],
  },
  {
    id: "boundary.alias-equivalence",
    testFile: "packages/cli/test/workspace-context.critical.e2e.test.ts",
    testName: "keeps full command and selector aliases byte-equivalent from a poisoned arbitrary cwd",
    proves: ["alias_equivalence", "arbitrary_cwd", "isolated_no_external_authority"],
  },
  {
    id: "boundary.fail-closed",
    testFile: "packages/cli/test/workspace-context.critical.e2e.test.ts",
    testName: "fails closed on duplicate/missing selectors and removed init without mutation",
    proves: ["create_only", "selector_fail_closed", "zero_mutation"],
  },
  {
    id: "selector.complete-tree",
    testFile: "packages/cli/test/workspace-alias.difftest.test.ts",
    testName: "canonicalizes every representative workspace subtree through one handler",
    proves: ["workspace_alias_complete_tree"],
  },
  {
    id: "workspace.discovery-clarify",
    testFile: "packages/cli/test/workspace-interaction.e2e.test.ts",
    testName: "US-WS-030 direct Workspace clarification",
    proves: ["requirement_match_guard", "clarify_select_or_create", "clarify_no_mutation", "direct_agent_clarification"],
  },
  {
    id: "workspace.create-authorization",
    testFile: "packages/cli/test/workspace-create.e2e.test.ts",
    testName: "previews, applies, and reuses one complete Workspace through the built CLI",
    proves: ["create_preview_authorization", "legacy_pending_recovery"],
  },
  {
    id: "workspace.edit-transaction",
    testFile: "packages/cli/test/workspace-edit.e2e.test.ts",
    testName: "rejects a stale preview without overwriting the concurrent manifest",
    proves: ["edit_transaction", "issue_byte_preservation"],
  },
  {
    id: "tool.authority-isolation",
    testFile: "packages/cli/test/tool-context-invocation.e2e.test.ts",
    testName: "freezes the cycle context and carries correlation through ToolRegistry into bash",
    proves: ["cycle_repository_identity", "authority_isolation"],
  },
  {
    id: "operation.executable-closure",
    testFile: "packages/cli/test/workspace-context-case-map.test.ts",
    testName: "maps every compatibility row bidirectionally to one operation-specific executable case",
    proves: ["all_operation_executable_evidence"],
  },
  {
    id: "ci.operation-evidence-gate",
    testFile: "packages/cli/test/workspace-context-case-map.test.ts",
    testName: "gates generated operation evidence in CI",
    proves: ["compatibility_matrix_ci_gate"],
  },
  {
    id: "source.design-contract",
    testFile: "packages/cli/test/workspace-context-case-map.test.ts",
    testName: "verifies the external design and documentation source contract",
    proves: ["idea_product_decisions_source", "documentation_refresh_dependency", "design_source_contract"],
  },
];

const artifact = {
  schema: "roll.workspace-context-validation-cases/v2",
  sourceMatrix: "docs/generated/workspace-context-compatibility-matrix.json",
  operationCases,
  operations: operationCases.map((testCase) => ({ policyKey: testCase.policyKey, caseId: testCase.id })),
  crossCuttingCases,
};
const output = path.join(root, "docs", "generated", "workspace-context-validation-cases.json");
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
