import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const artifactPath = join(root, "docs", "generated", "workspace-context-validation-cases.json");

interface ValidationArtifact {
  readonly schema: string;
  readonly cases: ReadonlyArray<{ readonly id: string; readonly testFile: string; readonly marker: string }>;
  readonly operations: ReadonlyArray<{ readonly policyKey: string; readonly cases: readonly string[] }>;
}

describe("US-WS-040 operation validation case closure", () => {
  it("maps every compatibility row bidirectionally to executable evidence", () => {
    expect(existsSync(artifactPath), "generate workspace-context-validation-cases.json").toBe(true);
    const matrix = JSON.parse(readFileSync(join(root, "docs", "generated", "workspace-context-compatibility-matrix.json"), "utf8")) as {
      rows: Array<{ surface: string; id: string; operation: string }>;
    };
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as ValidationArtifact;
    expect(artifact.schema).toBe("roll.workspace-context-validation-cases/v1");
    expect(artifact.operations.map((entry) => entry.policyKey).sort()).toEqual(
      matrix.rows.map((row) => `${row.surface}:${row.id}:${row.operation}`).sort(),
    );
    const caseIds = new Set(artifact.cases.map((entry) => entry.id));
    for (const operation of artifact.operations) {
      expect(operation.cases.length, `${operation.policyKey} has no validation case`).toBeGreaterThan(0);
      for (const caseId of operation.cases) expect(caseIds.has(caseId), `${operation.policyKey} -> ${caseId}`).toBe(true);
    }
    for (const testCase of artifact.cases) {
      const testPath = join(root, testCase.testFile);
      expect(existsSync(testPath), `${testCase.id} test file`).toBe(true);
      expect(readFileSync(testPath, "utf8"), `${testCase.id} marker`).toContain(testCase.marker);
      expect(artifact.operations.some((operation) => operation.cases.includes(testCase.id)), `${testCase.id} is unused`).toBe(true);
    }
  });

  it("maps all fifteen detailed design ACs to Story ACs and executable evidence", () => {
    const mapping = readFileSync(join(root, "packages", "cli", "test", "fixtures", "workspace-context", "design-ac-mapping.md"), "utf8");
    for (let index = 1; index <= 15; index += 1) {
      const id = `D15-${String(index).padStart(2, "0")}`;
      expect(mapping, id).toContain(`| ${id} |`);
    }
    expect(mapping).not.toContain("TBD");
  });
});
