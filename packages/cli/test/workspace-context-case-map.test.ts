import { createHash } from "node:crypto";
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
  readonly proves: readonly string[];
}

interface EvidenceCase {
  readonly id: string;
  readonly testFile: string;
  readonly testName: string;
  readonly proves: readonly string[];
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

function expectedEvidence(row: MatrixRow): OperationCase {
  const policyKey = key(row);
  const testFile = row.surface === "tool"
    ? "packages/infra/test/workspace-context-operation-evidence.test.ts"
    : "packages/cli/test/workspace-context-operation-evidence.test.ts";
  const testName = row.surface === "cli"
    ? `executes registered CLI probe for ${policyKey}`
    : row.surface === "skill"
      ? `validates shipped Skill manifest policy for ${policyKey}`
      : `rejects missing execution context before adapter effects for ${policyKey}`;
  const proves = row.surface === "cli"
    ? ["operation_policy", "cli_registration_probe"]
    : row.surface === "skill"
      ? ["operation_policy", "skill_manifest_policy"]
      : ["operation_policy", "tool_adapter_context_boundary"];
  return { id: `operation:${policyKey}`, policyKey, surface: row.surface, testFile, testName, proves };
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

    const orphanMapping = structuredClone(artifact) as { operations: Array<{ policyKey: string; caseId: string }> } & ValidationArtifact;
    orphanMapping.operations.push({ policyKey: "tool:future:future.call", caseId: "operation:tool:future:future.call" });
    expect(validationIssues(matrix.rows, orphanMapping)).toContain("orphan mapping tool:future:future.call");

    const orphanCase = structuredClone(artifact) as { operationCases: OperationCase[] } & ValidationArtifact;
    orphanCase.operationCases.push({
      id: "operation:tool:future:future.call",
      policyKey: "tool:future:future.call",
      surface: "tool",
      testFile: "packages/infra/test/workspace-context-operation-evidence.test.ts",
      testName: "future operation",
      proves: ["operation_policy", "tool_adapter_context_boundary"],
    });
    expect(validationIssues(matrix.rows, orphanCase)).toContain("orphan case tool:future:future.call");
  });

  it("verifies the external design and documentation source contract", () => {
    const mapping = JSON.parse(readFileSync(join(root, "packages", "cli", "test", "fixtures", "workspace-context", "design-ac-mapping.json"), "utf8")) as {
      sourceContract: { repository: string; commit: string; path: string; sourceSha256: string; snapshot: string };
    };
    const source = JSON.parse(readFileSync(join(root, mapping.sourceContract.snapshot), "utf8")) as {
      schema: string;
      sourceSha256: string;
      designAcceptanceCriteria: Array<{ id: string; statement: string }>;
      storyAcceptanceCriteria: Array<{ id: string; statement: string }>;
      documentationStory: { id: string; dependsOn: string[]; acceptanceCriteria: Array<{ id: string; statement: string }> };
    };
    const payload = {
      designAcceptanceCriteria: source.designAcceptanceCriteria,
      storyAcceptanceCriteria: source.storyAcceptanceCriteria,
      documentationStory: source.documentationStory,
    };
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    expect(source.schema).toBe("roll.workspace-context-design-source/v1");
    expect(mapping.sourceContract).toMatchObject({
      repository: "roll-meta",
      commit: "8f69dcc6c0329dd0cab696ac67106edaffa39800",
      path: "features/workspace-orchestration/US-WS-040/design-ac-source-contract.json",
    });
    expect(digest).toBe(source.sourceSha256);
    expect(digest).toBe(mapping.sourceContract.sourceSha256);
    expect(source.designAcceptanceCriteria).toHaveLength(15);
    expect(source.storyAcceptanceCriteria).toHaveLength(10);
    expect(source.documentationStory.id).toBe("US-WS-041");
    expect(source.documentationStory.dependsOn).toContain("US-WS-040");
    expect(source.documentationStory.acceptanceCriteria.map((entry) => entry.statement).join("\n"))
      .toMatch(/README.*guide.*help.*completion.*skill docs/su);
  });

  it("gates generated operation evidence in CI", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toContain("node scripts/generate-workspace-context-validation-cases.mjs");
    expect(workflow).toContain("git diff --exit-code -- docs/generated/workspace-context-validation-cases.json");
    expect(workflow).toContain("test/workspace-context-operation-evidence.test.ts");
    expect(workflow).toContain("pnpm --filter @roll/infra exec vitest run test/workspace-context-operation-evidence.test.ts");
  });

  it("binds every detailed design AC to Story ACs and concrete executable cases", () => {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as ValidationArtifact;
    const mapping = JSON.parse(readFileSync(join(root, "packages", "cli", "test", "fixtures", "workspace-context", "design-ac-mapping.json"), "utf8")) as {
      schema: string;
      sourceContract: { snapshot: string };
      story: { id: string };
      designAcceptanceCriteria: Array<{ id: string; topic: string; storyAcceptance: string[]; requiredCapabilities: string[]; evidenceCaseIds: string[] }>;
    };
    const source = JSON.parse(readFileSync(join(root, mapping.sourceContract.snapshot), "utf8")) as {
      designAcceptanceCriteria: Array<{ id: string; statement: string }>;
      storyAcceptanceCriteria: Array<{ id: string; statement: string }>;
    };
    expect(mapping.schema).toBe("roll.workspace-context-design-ac-mapping/v2");
    expect(mapping.story.id).toBe("US-WS-040");
    expect(mapping.designAcceptanceCriteria.map((entry) => entry.id)).toEqual(source.designAcceptanceCriteria.map((entry) => entry.id));

    const storyAcIds = new Set(source.storyAcceptanceCriteria.map((entry) => entry.id));
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
      const capabilities = new Set(design.evidenceCaseIds.flatMap((caseId) => evidenceCases.get(caseId)?.proves ?? []));
      for (const capability of design.requiredCapabilities) {
        expect(capabilities.has(capability), `${design.id} missing capability ${capability}`).toBe(true);
      }
    }
    expect([...usedStoryAcs].sort()).toEqual([...storyAcIds].sort());

    const sourceStatements = new Map(source.designAcceptanceCriteria.map((entry) => [entry.id, entry.statement]));
    const d15_01 = mapping.designAcceptanceCriteria.find((entry) => entry.id === "D15-01")!;
    expect(sourceStatements.get("D15-01")).toMatch(/IDEA-075\.\.079/u);
    expect(d15_01.evidenceCaseIds).not.toContain("mapping.semantic-closure");
    expect(d15_01.requiredCapabilities).toEqual(expect.arrayContaining([
      "workspace_alias_complete_tree", "create_only", "edit_transaction", "requirement_match_guard", "clarify_select_or_create",
    ]));
    const d15_10 = mapping.designAcceptanceCriteria.find((entry) => entry.id === "D15-10")!;
    expect(sourceStatements.get("D15-10")).toMatch(/文档刷新.*help\/completion\/skill.*兼容矩阵/u);
    expect(d15_10.evidenceCaseIds).not.toContain("mapping.semantic-closure");
    expect(d15_10.requiredCapabilities).toEqual(expect.arrayContaining([
      "documentation_refresh_dependency", "compatibility_matrix_ci_gate", "matrix_registry_closure",
    ]));
  });
});
