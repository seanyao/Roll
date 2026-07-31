import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRulesRegistry } from "../src/rules.js";

const VALID = `
version: 1
gates:
  doc_drift: soft
rules:
  - id: RL-TCR-001
    kind: redline
    statement: commits need a fresh test-pass proof
    enforcement:
      - point: hooks/pre-commit
        marker: "RL-TCR-001"
    verification:
      test: packages/core/test/tcr.test.ts
      marker: "RL-TCR-001"
    trigger_report: block
    since: v3.0
doc_surfaces:
  - id: DS-ATTEST
    paths: ["packages/core/src/attest/**"]
    docs: ["docs/verification.md"]
`;

function ok<T>(result: { ok: boolean; value?: T }): T {
  expect(result.ok).toBe(true);
  return result.value as T;
}

describe("parseRulesRegistry — valid input", () => {
  it("parses a well-formed registry into the camelCase contract", () => {
    const result = parseRulesRegistry(VALID);
    const registry = ok(result);
    expect(registry.version).toBe(1);
    expect(registry.gates).toEqual({ docDrift: "soft" });
    expect(registry.rules).toHaveLength(1);
    expect(registry.rules[0]).toMatchObject({
      id: "RL-TCR-001",
      kind: "redline",
      enforcement: [{ point: "hooks/pre-commit", marker: "RL-TCR-001" }],
      verification: { test: "packages/core/test/tcr.test.ts", marker: "RL-TCR-001" },
      triggerReport: "block",
      since: "v3.0",
    });
    expect(registry.docSurfaces).toEqual([
      { id: "DS-ATTEST", paths: ["packages/core/src/attest/**"], docs: ["docs/verification.md"] },
    ]);
  });

  it("accepts a registry with an empty doc_surfaces array", () => {
    const text = VALID.replace(/doc_surfaces:[\s\S]*/, "doc_surfaces: []\n");
    const registry = ok(parseRulesRegistry(text));
    expect(registry.docSurfaces).toEqual([]);
  });
});

describe("parseRulesRegistry — the tracked policy/rules.yaml", () => {
  it("parses cleanly and registers at least one redline + DS-ATTEST surface", () => {
    const repoRoot = resolve(__dirname, "../../..");
    const text = readFileSync(resolve(repoRoot, "policy/rules.yaml"), "utf8");
    const registry = ok(parseRulesRegistry(text));
    expect(registry.gates.docDrift).toBe("soft");
    expect(registry.rules.length).toBeGreaterThanOrEqual(1);
    expect(registry.docSurfaces.some((s) => s.id === "DS-ATTEST")).toBe(true);
  });
});

describe("parseRulesRegistry — strict rejection", () => {
  it("rejects an unknown top-level field", () => {
    const text = VALID.replace("version: 1", "version: 1\nextra_field: nope");
    const result = parseRulesRegistry(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/unknown field "extra_field"/);
  });

  it("rejects an unknown field on a rule entry", () => {
    const text = VALID.replace("kind: redline", "kind: redline\n    bogus: 1");
    const result = parseRulesRegistry(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/unknown field "bogus"/);
  });

  it("rejects a duplicate rule id", () => {
    const text = VALID.replace(
      "doc_surfaces:",
      `  - id: RL-TCR-001
    kind: redline
    statement: duplicate
    enforcement:
      - point: hooks/pre-commit
        marker: "RL-TCR-001"
    verification:
      test: packages/core/test/tcr.test.ts
      marker: "RL-TCR-001"
    trigger_report: block
doc_surfaces:`,
    );
    const result = parseRulesRegistry(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/duplicate rule id "RL-TCR-001"/);
  });

  it("rejects an invalid gates.doc_drift enum value", () => {
    const text = VALID.replace("doc_drift: soft", "doc_drift: maybe");
    const result = parseRulesRegistry(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/doc_drift/);
  });

  it("rejects an invalid trigger_report enum value", () => {
    const text = VALID.replace("trigger_report: block", "trigger_report: warn");
    const result = parseRulesRegistry(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/trigger_report/);
  });

  it("rejects a rule id that does not match ^RL-[A-Z]+-\\d{3}$", () => {
    const text = VALID.replace("id: RL-TCR-001", "id: RL-tcr-1");
    const result = parseRulesRegistry(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/id must match/);
  });

  it("rejects an empty rules array", () => {
    const text = VALID.replace(/rules:[\s\S]*doc_surfaces:/, "rules: []\ndoc_surfaces:");
    const result = parseRulesRegistry(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/non-empty array/);
  });

  it("rejects an enforcement.point path under policy/**", () => {
    const text = VALID.replace("point: hooks/pre-commit", "point: policy/rules.yaml");
    const result = parseRulesRegistry(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/enforcement\.point must not point under policy/);
  });

  it("rejects a verification.test path under policy/**", () => {
    const text = VALID.replace("test: packages/core/test/tcr.test.ts", "test: policy/self-test.ts");
    const result = parseRulesRegistry(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/verification: test must not point under policy/);
  });

  it("rejects malformed YAML", () => {
    const result = parseRulesRegistry("version: 1\n  gates: [broken");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/invalid YAML/);
  });

  it("rejects a non-mapping root document", () => {
    const result = parseRulesRegistry("- just\n- a\n- list\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/root must be a mapping/);
  });
});
