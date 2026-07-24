import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const artifactPath = join(root, "docs", "generated", "workspace-context-validation-cases.json");

interface MatrixRow {
  readonly surface: "cli" | "skill" | "tool";
  readonly id: string;
  readonly operation: string;
}

interface OperationCase {
  readonly id: string;
  readonly policyKey: string;
  readonly surface: MatrixRow["surface"];
  readonly testFile: string;
  readonly testName: string;
}

interface EvidenceCase {
  readonly id: string;
  readonly testFile: string;
  readonly testName: string;
}

interface ValidationArtifact {
  readonly schema: string;
  readonly operationCases: readonly OperationCase[];
  readonly operations: ReadonlyArray<{ readonly policyKey: string; readonly caseId: string }>;
  readonly crossCuttingCases: readonly EvidenceCase[];
}

function key(row: MatrixRow): string {
  return `${row.surface}:${row.id}:${row.operation}`;
}

function expectedEvidence(row: MatrixRow): Pick<OperationCase, "id" | "policyKey" | "surface" | "testFile" | "testName"> {
  const policyKey = key(row);
  const testFile = row.surface === "tool"
    ? "packages/infra/test/workspace-context-operation-evidence.test.ts"
    : "packages/cli/test/workspace-context-operation-evidence.test.ts";
  const testName = row.surface === "cli"
    ? `executes registered CLI probe for ${policyKey}`
    : row.surface === "skill"
      ? `validates shipped Skill manifest policy for ${policyKey}`
      : `rejects missing execution context before adapter effects for ${policyKey}`;
  return { id: `operation:${policyKey}`, policyKey, surface: row.surface, testFile, testName };
}

function validationIssues(rows: readonly MatrixRow[], artifact: ValidationArtifact): string[] {
  const issues: string[] = [];
  if (artifact.schema !== "roll.workspace-context-validation-cases/v2") issues.push("schema");

  const matrixKeys = rows.map(key);
  const operationKeys = artifact.operations.map((entry) => entry.policyKey);
  const caseKeys = artifact.operationCases.map((entry) => entry.policyKey);
  if (new Set(matrixKeys).size !== matrixKeys.length) issues.push("duplicate matrix policyKey");
  if (new Set(operationKeys).size !== operationKeys.length) issues.push("duplicate operation policyKey");
  if (new Set(caseKeys).size !== caseKeys.length) issues.push("duplicate case policyKey");
  if (new Set(artifact.operationCases.map((entry) => entry.id)).size !== artifact.operationCases.length) issues.push("duplicate case id");

  for (const row of rows) {
    const policyKey = key(row);
    const expected = expectedEvidence(row);
    const mappings = artifact.operations.filter((entry) => entry.policyKey === policyKey);
    const cases = artifact.operationCases.filter((entry) => entry.policyKey === policyKey);
    if (mappings.length !== 1) issues.push(`mapping count ${policyKey}`);
    if (cases.length !== 1) issues.push(`case count ${policyKey}`);
    if (mappings[0]?.caseId !== expected.id) issues.push(`mapping case ${policyKey}`);
    if (JSON.stringify(cases[0]) !== JSON.stringify(expected)) issues.push(`case evidence ${policyKey}`);
  }

  for (const policyKey of operationKeys) if (!matrixKeys.includes(policyKey)) issues.push(`orphan mapping ${policyKey}`);
  for (const policyKey of caseKeys) if (!matrixKeys.includes(policyKey)) issues.push(`orphan case ${policyKey}`);
  return issues;
}

const expectedDesignSemantics: Record<string, { topic: string; storyAcceptance: string[]; evidenceCaseIds: string[] }> = {
  "D15-01": { topic: "idea_product_decisions", storyAcceptance: ["AC10"], evidenceCaseIds: ["mapping.semantic-closure"] },
  "D15-02": { topic: "complete_ws_tree_and_selector_alias", storyAcceptance: ["AC2"], evidenceCaseIds: ["selector.complete-tree", "boundary.alias-equivalence"] },
  "D15-03": { topic: "create_only_retired_init", storyAcceptance: ["AC3"], evidenceCaseIds: ["workspace.create-authorization", "boundary.fail-closed"] },
  "D15-04": { topic: "single_active_requirement_mismatch", storyAcceptance: ["AC5"], evidenceCaseIds: ["workspace.discovery-clarify"] },
  "D15-05": { topic: "deterministic_and_semantic_requirement_evidence", storyAcceptance: ["AC5"], evidenceCaseIds: ["workspace.discovery-clarify"] },
  "D15-06": { topic: "edit_preview_lock_digest_atomic_recovery", storyAcceptance: ["AC4"], evidenceCaseIds: ["workspace.edit-transaction"] },
  "D15-07": { topic: "existing_issue_byte_preservation", storyAcceptance: ["AC4"], evidenceCaseIds: ["workspace.edit-transaction"] },
  "D15-08": { topic: "all_cli_skill_tool_operations_have_policy", storyAcceptance: ["AC1", "AC6", "AC8"], evidenceCaseIds: ["matrix.registry-closure", "operation:cli:workspace:create", "operation:skill:roll-build:build", "operation:tool:github:github.pr", "operation:tool:mcp:mcp.call"] },
  "D15-09": { topic: "noninteractive_mutation_fail_closed", storyAcceptance: ["AC7"], evidenceCaseIds: ["boundary.fail-closed"] },
  "D15-10": { topic: "doc_refresh_and_compatibility_matrix_gate", storyAcceptance: ["AC1", "AC9", "AC10"], evidenceCaseIds: ["matrix.registry-closure", "mapping.semantic-closure"] },
  "D15-11": { topic: "legacy_pending_recovery_without_init", storyAcceptance: ["AC3"], evidenceCaseIds: ["workspace.create-authorization", "boundary.fail-closed"] },
  "D15-12": { topic: "existing_requirement_and_cycle_repository_identity", storyAcceptance: ["AC6"], evidenceCaseIds: ["tool.authority-isolation"] },
  "D15-13": { topic: "agent_clarify_stops_before_mutation", storyAcceptance: ["AC5", "AC7"], evidenceCaseIds: ["workspace.discovery-clarify", "boundary.fail-closed"] },
  "D15-14": { topic: "direct_and_agent_shared_clarification_contract", storyAcceptance: ["AC5", "AC7"], evidenceCaseIds: ["workspace.discovery-clarify"] },
  "D15-15": { topic: "create_intent_is_not_apply_authorization", storyAcceptance: ["AC3", "AC5"], evidenceCaseIds: ["workspace.create-authorization", "workspace.discovery-clarify"] },
};

describe("US-WS-040 operation validation case closure", () => {
  it("maps every compatibility row bidirectionally to one operation-specific executable case", () => {
    expect(existsSync(artifactPath), "generate workspace-context-validation-cases.json").toBe(true);
    const matrix = JSON.parse(readFileSync(join(root, "docs", "generated", "workspace-context-compatibility-matrix.json"), "utf8")) as { rows: MatrixRow[] };
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as ValidationArtifact;
    expect(validationIssues(matrix.rows, artifact)).toEqual([]);
  });

  it("rejects missing, orphaned, reused, and mismatched operation evidence", () => {
    const matrix = JSON.parse(readFileSync(join(root, "docs", "generated", "workspace-context-compatibility-matrix.json"), "utf8")) as { rows: MatrixRow[] };
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as ValidationArtifact;
    const first = matrix.rows[0]!;
    const second = matrix.rows[1]!;

    const missing = structuredClone(artifact) as { operationCases: OperationCase[]; operations: Array<{ policyKey: string; caseId: string }> } & ValidationArtifact;
    missing.operationCases = missing.operationCases.filter((entry) => entry.policyKey !== key(first));
    missing.operations = missing.operations.filter((entry) => entry.policyKey !== key(first));
    expect(validationIssues(matrix.rows, missing)).toContain(`mapping count ${key(first)}`);

    const newRow = { surface: "tool" as const, id: "future", operation: "future.call" };
    expect(validationIssues([...matrix.rows, newRow], artifact)).toContain(`mapping count ${key(newRow)}`);

    const reused = structuredClone(artifact) as { operations: Array<{ policyKey: string; caseId: string }> } & ValidationArtifact;
    reused.operations.find((entry) => entry.policyKey === key(second))!.caseId = `operation:${key(first)}`;
    expect(validationIssues(matrix.rows, reused)).toContain(`mapping case ${key(second)}`);

    const mismatched = structuredClone(artifact) as { operationCases: OperationCase[] } & ValidationArtifact;
    mismatched.operationCases.find((entry) => entry.policyKey === key(second))!.testName = "generic green marker";
    expect(validationIssues(matrix.rows, mismatched)).toContain(`case evidence ${key(second)}`);
  });

  it("binds every detailed design AC to Story ACs and concrete executable cases", () => {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as ValidationArtifact;
    const mapping = JSON.parse(readFileSync(join(root, "packages", "cli", "test", "fixtures", "workspace-context", "design-ac-mapping.json"), "utf8")) as {
      schema: string;
      story: { id: string; acceptanceCriteria: Array<{ id: string; topic: string }> };
      designAcceptanceCriteria: Array<{ id: string; topic: string; storyAcceptance: string[]; evidenceCaseIds: string[] }>;
    };
    expect(mapping.schema).toBe("roll.workspace-context-design-ac-mapping/v1");
    expect(mapping.story.id).toBe("US-WS-040");
    expect(mapping.story.acceptanceCriteria.map((entry) => entry.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `AC${index + 1}`),
    );
    expect(Object.fromEntries(mapping.designAcceptanceCriteria.map((entry) => [entry.id, {
      topic: entry.topic,
      storyAcceptance: entry.storyAcceptance,
      evidenceCaseIds: entry.evidenceCaseIds,
    }]))).toEqual(expectedDesignSemantics);

    const storyAcIds = new Set(mapping.story.acceptanceCriteria.map((entry) => entry.id));
    const evidenceCases = new Map([
      ...artifact.operationCases.map((entry) => [entry.id, entry] as const),
      ...artifact.crossCuttingCases.map((entry) => [entry.id, entry] as const),
    ]);
    const usedStoryAcs = new Set<string>();
    for (const design of mapping.designAcceptanceCriteria) {
      for (const storyAc of design.storyAcceptance) {
        expect(storyAcIds.has(storyAc), `${design.id} -> ${storyAc}`).toBe(true);
        usedStoryAcs.add(storyAc);
      }
      for (const caseId of design.evidenceCaseIds) {
        const evidence = evidenceCases.get(caseId);
        expect(evidence, `${design.id} -> ${caseId}`).toBeDefined();
        expect(existsSync(join(root, evidence!.testFile)), `${caseId} test file`).toBe(true);
        expect(evidence!.testName.trim(), `${caseId} concrete test name`).not.toBe("");
      }
    }
    expect([...usedStoryAcs].sort()).toEqual([...storyAcIds].sort());
  });
});
