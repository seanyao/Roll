#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrix = JSON.parse(fs.readFileSync(path.join(root, "docs", "generated", "workspace-context-compatibility-matrix.json"), "utf8"));

const cases = [
  { id: "registry.policy-closure", testFile: "packages/cli/test/workspace-surface-inventory.test.ts", marker: "closes the registered inventory and matches the stable machine artifact" },
  { id: "cli.public-boundary", testFile: "packages/cli/test/workspace-context.critical.e2e.test.ts", marker: "US-WS-040 public Workspace context boundary" },
  { id: "selector.alias-equivalence", testFile: "packages/cli/test/workspace-alias.difftest.test.ts", marker: "canonicalizes every representative workspace subtree through one handler" },
  { id: "workspace.discovery-clarify", testFile: "packages/cli/test/workspace-interaction.e2e.test.ts", marker: "US-WS-030 direct Workspace clarification" },
  { id: "workspace.create-recovery", testFile: "packages/cli/test/workspace-create.e2e.test.ts", marker: "previews, applies, and reuses one complete Workspace through the built CLI" },
  { id: "workspace.edit-transaction", testFile: "packages/cli/test/workspace-edit.e2e.test.ts", marker: "rejects a stale preview without overwriting the concurrent manifest" },
  { id: "skill.handoff-authority", testFile: "skills/scripts/test-audit-skills.mjs", marker: "workspaceContextPolicies" },
  { id: "tool.context-envelope", testFile: "packages/cli/test/tool-context-invocation.e2e.test.ts", marker: "carries correlation through ToolRegistry into bash" },
  { id: "legacy.explicit-boundary", testFile: "packages/cli/test/workspace-create-recovery.e2e.test.ts", marker: "legacy" },
];

const operations = matrix.rows.map((row) => {
  const mapped = ["registry.policy-closure"];
  if (row.surface === "cli") mapped.push("cli.public-boundary");
  if (row.acceptsWorkspaceSelector === true) mapped.push("selector.alias-equivalence");
  if (row.surface === "skill") mapped.push("skill.handoff-authority");
  if (row.surface === "tool") mapped.push("tool.context-envelope");
  if (String(row.scope).startsWith("workspace_") || row.scope === "issue_required" || row.scope === "repository_required") {
    mapped.push("workspace.discovery-clarify");
  }
  if (row.surface === "cli" && row.id === "workspace" && row.operation === "create") mapped.push("workspace.create-recovery");
  if (row.surface === "cli" && row.id === "workspace" && row.operation === "edit") mapped.push("workspace.edit-transaction");
  if (row.scope === "legacy_migration_only") mapped.push("legacy.explicit-boundary");
  return { policyKey: `${row.surface}:${row.id}:${row.operation}`, cases: [...new Set(mapped)].sort() };
});

const artifact = {
  schema: "roll.workspace-context-validation-cases/v1",
  sourceMatrix: "docs/generated/workspace-context-compatibility-matrix.json",
  cases,
  operations,
};
const output = path.join(root, "docs", "generated", "workspace-context-validation-cases.json");
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
