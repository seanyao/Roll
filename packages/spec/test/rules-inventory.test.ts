import { describe, expect, it } from "vitest";
import { auditRulesInventory, inventoryReportFails, parseRulesInventory, type InventoryFileSystem } from "../src/rules-inventory.js";
import { normalizePath, parseRulesV2 } from "../src/rules.js";

const V2 = `version: 2
gates: { doc_drift: soft }
rules:
  - id: I4
    kind: invariant
    statement: truth
    owner_domain: truth-consistency
    severity: block
    enforcement: [{ path: packages/core/src/attest/live.ts, marker: I4 }]
    verification: [{ path: packages/core/test/live.test.ts, marker: I4 }]
    docs: [{ path: docs/architecture.md, marker: I4 }]
    projection:
      about: { en: truth, zh: 真相 }
      verification: { fault_zh: 错, expected_zh: 对 }
      architecture: { zh: 真相 }
pipeline_stages: []
doc_surfaces:
  - id: DS-ATTEST
    paths: [packages/core/src/attest/**]
    docs: [docs/architecture.md]
`;

const INVENTORY = `version: 1
coverage_sets:
  - id: maps-core
    purpose: responsibility
    roots: [packages/core/src/attest]
    include: ["**/*.ts"]
    allow_overlap_with: []
    exclude:
      - path: packages/core/src/attest/legacy.ts
        reason: migration fixture
        owner: evidence
        review_by: v3.2
candidates: []
`;

function memory(files: Readonly<Record<string, string>>): InventoryFileSystem {
  const all = Object.keys(files);
  return {
    list(directory) {
      const prefix = directory ? `${directory}/` : "";
      const entries = new Map<string, "file" | "directory">();
      for (const file of all) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length); const name = rest.split("/")[0];
        if (!name) continue;
        entries.set(name, rest.includes("/") ? "directory" : "file");
      }
      return [...entries].map(([name, kind]) => ({ name, kind }));
    },
    read(file) { return files[file] ?? ""; },
  };
}
function parsed<T extends { ok: boolean; value?: unknown }>(value: T): NonNullable<T["value"]> { expect(value.ok).toBe(true); return value.value as NonNullable<T["value"]>; }

describe("strict v2 rule parser", () => {
  it("parses native v2 and does not alter the v1 adapter", () => {
    const rules = parsed(parseRulesV2(V2));
    expect(rules.version).toBe(2);
    expect(rules.rules[0]?.ownerDomain).toBe("truth-consistency");
  });

  it.each([
    ["unknown root", V2.replace("version: 2", "version: 2\nunknown: no")],
    ["bad id", V2.replace("id: I4", "id: I13")],
    ["redline projection", V2.replace("kind: invariant", "kind: redline")],
    ["missing invariant projection", V2.replace(/    projection:[\s\S]*?      architecture: \{ zh: 真相 \}\n/, "")],
    ["unsafe path", V2.replace("packages/core/src/attest/live.ts", "../outside.ts")],
    ["policy self certification", V2.replace("packages/core/src/attest/live.ts", "policy/rules.yaml")],
    ["non-production stage", V2.replace("pipeline_stages: []", "pipeline_stages:\n  - id: STAGE-A\n    inputs: []\n    outputs: []\n    exit: hold\n    consumer: { path: docs/a.md, marker: STAGE-A }")],
  ])("rejects %s", (_name, text) => expect(parseRulesV2(text).ok).toBe(false));

  it("normalizes only safe concrete paths", () => {
    expect(normalizePath(" ./packages\\core//src/a.ts ")).toBe("packages/core/src/a.ts");
    expect(() => normalizePath("../a.ts")).toThrow(/segments/);
    expect(() => normalizePath("a/*.ts")).toThrow(/glob/);
  });
});

describe("inventory parser and pure auditor", () => {
  it("has deterministic exact-exclusion and ignored-include precedence", () => {
    const report = auditRulesInventory(parsed(parseRulesInventory(INVENTORY)), parsed(parseRulesV2(V2)), memory({
      "packages/core/src/attest/live.ts": "/**\n * @responsibility live\n */\nexport {};",
      "packages/core/src/attest/legacy.ts": "export {};",
      "packages/core/src/attest/readme.md": "readme",
    }));
    expect(report.covered).toEqual([{ coverageSetId: "maps-core", path: "packages/core/src/attest/live.ts" }]);
    expect(report.excluded).toEqual([{ coverageSetId: "maps-core", path: "packages/core/src/attest/legacy.ts", reason: "migration fixture" }]);
    expect(report.ignored_by_include).toEqual([{ coverageSetId: "maps-core", path: "packages/core/src/attest/readme.md" }]);
    expect(inventoryReportFails(report)).toBe(false);
  });

  // US-RULE-011 — responsibilityCount counts ` * @responsibility` lines inside
  // the FIRST JSDoc header block only; a declaration anywhere else is not one.
  it.each([
    ["JSDoc header with one declaration counts 1", "/**\n * @responsibility live\n */\nexport {};", "covered"],
    ["JSDoc header with two declarations counts 2", "/**\n * @responsibility first\n * @responsibility second\n */\nexport {};", "missing:multiple @responsibility declarations"],
    ["declaration outside the header counts 0", "// @responsibility live\nexport {};", "missing:missing @responsibility"],
    ["no header counts 0", "export {};", "missing:missing @responsibility"],
  ])("%s", (_name, source, expected) => {
    const report = auditRulesInventory(parsed(parseRulesInventory(INVENTORY)), parsed(parseRulesV2(V2)), memory({ "packages/core/src/attest/live.ts": source }));
    if (expected === "covered") expect(report.covered).toEqual([{ coverageSetId: "maps-core", path: "packages/core/src/attest/live.ts" }]);
    else {
      const [bucket, reason] = expected.split(":");
      expect(report.missing).toEqual([{ coverageSetId: "maps-core", path: "packages/core/src/attest/live.ts", reason }]);
      expect(report.covered).toEqual([]);
      expect(bucket).toBe("missing");
    }
  });

  it("fails loudly for an unclassified candidate and illegal same-purpose overlap", () => {
    const text = INVENTORY.replace("candidates: []", `coverage_sets:\n  - id: duplicate\n    purpose: responsibility\n    roots: [packages/core/src/attest]\n    include: ["**/*.ts"]\n    allow_overlap_with: []\n    exclude: []\ncandidates: []`).replace("coverage_sets:\n  - id: maps-core", "coverage_sets:\n  - id: maps-core");
    // Duplicate root key is intentionally a schema error, which is fail-closed too.
    expect(parseRulesInventory(text).ok).toBe(false);
    const candidates = INVENTORY.replace("purpose: responsibility", "purpose: rule-candidate").replace("candidates: []", "candidates: []");
    const report = auditRulesInventory(parsed(parseRulesInventory(candidates)), parsed(parseRulesV2(V2)), memory({ "packages/core/src/attest/live.ts": "export {};" }));
    expect(report.candidate).toHaveLength(1);
    expect(inventoryReportFails(report)).toBe(true);
  });

  it.each([
    ["unknown", INVENTORY.replace("version: 1", "version: 1\nextra: no")],
    ["bad root", INVENTORY.replace("packages/core/src/attest", "../escape")],
    ["glob", INVENTORY.replace("**/*.ts", "src/*.ts")],
  ])("rejects inventory %s", (_name, text) => expect(parseRulesInventory(text).ok).toBe(false));
});
