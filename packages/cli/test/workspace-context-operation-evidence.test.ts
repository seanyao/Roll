import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceContextPolicy } from "@roll/spec";
import { describe, expect, it } from "vitest";
import { registeredCliOperations } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import { cliOperationForArgs } from "../src/lib/command-surface.js";
import {
  cliWorkspaceContextPolicies,
  skillContextInventoryFromManifest,
  skillContextPoliciesFromManifest,
} from "../src/lib/workspace-context-policy.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const skillsRoot = join(root, "skills");
const matrix = JSON.parse(readFileSync(join(root, "docs", "generated", "workspace-context-compatibility-matrix.json"), "utf8")) as {
  rows: WorkspaceContextPolicy[];
};
const validation = JSON.parse(readFileSync(join(root, "docs", "generated", "workspace-context-validation-cases.json"), "utf8")) as {
  operationCases: Array<{ id: string; policyKey: string; surface: string; testFile: string; testName: string; proves: string[] }>;
};
const manifest = JSON.parse(readFileSync(join(skillsRoot, "route-cases", "skills.json"), "utf8")) as unknown;

registerAll();
const registrations = registeredCliOperations();
const cliPolicies = cliWorkspaceContextPolicies(registrations);
const skillInventory = skillContextInventoryFromManifest(manifest);
const skillPolicies = skillContextPoliciesFromManifest(manifest);

function policyKey(surface: string, id: string, operation: string): string {
  return `${surface}:${id}:${operation}`;
}

function generatedOperationCase(key: string) {
  return validation.operationCases.filter((entry) => entry.policyKey === key);
}

const cliCases = registrations.map((registration) => {
  const key = policyKey("cli", registration.command, registration.operation);
  return {
    testName: `executes registered CLI probe for ${key}`,
    key,
    registration,
  };
});

const skillCases = skillInventory.map((inventory) => {
  const key = policyKey("skill", inventory.id, inventory.operation);
  return {
    testName: `validates shipped Skill manifest policy for ${key}`,
    key,
    inventory,
  };
});

describe("US-WS-040 executable operation evidence", () => {
  it.each(cliCases)("$testName", ({ key, registration }) => {
    const resolved = cliOperationForArgs(registration.command, registration.exampleArgs, registrations);
    expect(resolved, `${key} exampleArgs`).toBe(registration);

    const policy = cliPolicies.find((entry) => policyKey(entry.surface, entry.id, entry.operation) === key);
    const row = matrix.rows.find((entry) => policyKey(entry.surface, entry.id, entry.operation) === key);
    expect(policy, `${key} live policy`).toBeDefined();
    expect(row, `${key} matrix row`).toEqual(policy);
    expect(generatedOperationCase(key)).toEqual([{
      id: `operation:${key}`,
      policyKey: key,
      surface: "cli",
      testFile: "packages/cli/test/workspace-context-operation-evidence.test.ts",
      testName: `executes registered CLI probe for ${key}`,
      proves: ["operation_policy", "cli_registration_probe"],
    }]);
  });

  it.each(skillCases)("$testName", ({ key, inventory }) => {
    const policy = skillPolicies.find((entry) => policyKey(entry.surface, entry.id, entry.operation) === key);
    const row = matrix.rows.find((entry) => policyKey(entry.surface, entry.id, entry.operation) === key);
    expect(existsSync(join(skillsRoot, inventory.id, "SKILL.md")), `${key} shipped Skill.md`).toBe(true);
    expect(policy, `${key} manifest policy`).toBeDefined();
    expect(row, `${key} matrix row`).toEqual(policy);
    expect(generatedOperationCase(key)).toEqual([{
      id: `operation:${key}`,
      policyKey: key,
      surface: "skill",
      testFile: "packages/cli/test/workspace-context-operation-evidence.test.ts",
      testName: `validates shipped Skill manifest policy for ${key}`,
      proves: ["operation_policy", "skill_manifest_policy"],
    }]);
  });
});
