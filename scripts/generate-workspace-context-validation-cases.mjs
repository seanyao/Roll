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
  return {
    id: `operation:${policyKey}`,
    policyKey,
    surface: row.surface,
    testFile: operationTestFiles[row.surface],
    testName: operationTestName(row, policyKey),
  };
});

const crossCuttingCases = [
  {
    id: "matrix.registry-closure",
    testFile: "packages/cli/test/workspace-surface-inventory.test.ts",
    testName: "closes the registered inventory and matches the stable machine artifact",
  },
  {
    id: "boundary.alias-equivalence",
    testFile: "packages/cli/test/workspace-context.critical.e2e.test.ts",
    testName: "keeps full command and selector aliases byte-equivalent from a poisoned arbitrary cwd",
  },
  {
    id: "boundary.fail-closed",
    testFile: "packages/cli/test/workspace-context.critical.e2e.test.ts",
    testName: "fails closed on duplicate/missing selectors and retired init without mutation",
  },
  {
    id: "selector.complete-tree",
    testFile: "packages/cli/test/workspace-alias.difftest.test.ts",
    testName: "canonicalizes every representative workspace subtree through one handler",
  },
  {
    id: "workspace.discovery-clarify",
    testFile: "packages/cli/test/workspace-interaction.e2e.test.ts",
    testName: "US-WS-030 direct Workspace clarification",
  },
  {
    id: "workspace.create-authorization",
    testFile: "packages/cli/test/workspace-create.e2e.test.ts",
    testName: "previews, applies, and reuses one complete Workspace through the built CLI",
  },
  {
    id: "workspace.edit-transaction",
    testFile: "packages/cli/test/workspace-edit.e2e.test.ts",
    testName: "rejects a stale preview without overwriting the concurrent manifest",
  },
  {
    id: "tool.authority-isolation",
    testFile: "packages/cli/test/tool-context-invocation.e2e.test.ts",
    testName: "freezes the cycle context and carries correlation through ToolRegistry into bash",
  },
  {
    id: "mapping.semantic-closure",
    testFile: "packages/cli/test/workspace-context-case-map.test.ts",
    testName: "binds every detailed design AC to Story ACs and concrete executable cases",
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
