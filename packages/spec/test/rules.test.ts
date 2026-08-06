import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditV2Anchors,
  isDiscoverableVerificationPath,
  parseRulesRegistry,
  parseRulesV2,
  type ParsedRulesV2,
  type RulesAnchorFs,
} from "../src/rules.js";
import {
  auditRulesInventory,
  inventoryReportFails,
  parseRulesInventory,
  type InventoryFileSystem,
} from "../src/rules-inventory.js";

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

/* US-RULE-009 — native v2 registry: cardinality, legacy projection, and
 * fail-closed anchor/inventory fixtures. */

const REPO_ROOT = resolve(__dirname, "../../..");
const TRACKED_RULES = readFileSync(resolve(REPO_ROOT, "policy/rules.yaml"), "utf8");
const TRACKED_INVENTORY = readFileSync(resolve(REPO_ROOT, "policy/rules-inventory.yaml"), "utf8");
const INVARIANT_IDS = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10", "I11", "I12"];
const REDLINE_IDS = [
  "RL-TCR-001",
  "RL-EVID-003",
  "RL-FAIL-007",
  "RL-EVID-004",
  "RL-EVID-005",
  "RL-ISO-002",
  "RL-TRUTH-001",
];

function trackedV2(): ParsedRulesV2 {
  return ok(parseRulesV2(TRACKED_RULES));
}

/** The cardinality contract: exactly the twelve invariants I1–I12, each once. */
function expectExactlyTwelveInvariants(registry: ParsedRulesV2): void {
  const ids = registry.rules.filter((rule) => rule.kind === "invariant").map((rule) => rule.id);
  expect([...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(INVARIANT_IDS);
}

const realAnchorFs: RulesAnchorFs = {
  isFile: (path) => {
    const full = resolve(REPO_ROOT, path);
    return existsSync(full) && statSync(full).isFile();
  },
  read: (path) => readFileSync(resolve(REPO_ROOT, path), "utf8"),
};

function memoryFs(files: Readonly<Record<string, string>>): InventoryFileSystem {
  const all = Object.keys(files);
  return {
    list(directory) {
      const prefix = directory ? `${directory}/` : "";
      const entries = new Map<string, "file" | "directory">();
      for (const file of all) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const name = rest.split("/")[0];
        if (!name) continue;
        entries.set(name, rest.includes("/") ? "directory" : "file");
      }
      return [...entries].map(([name, kind]) => ({ name, kind }));
    },
    read(file) {
      return files[file] ?? "";
    },
  };
}

function realInventoryFs(root: string): InventoryFileSystem {
  return {
    list(directory) {
      return readdirSync(directory).map((name) => {
        const stat = lstatSync(join(directory, name));
        return { name, kind: stat.isSymbolicLink() ? ("symlink" as const) : stat.isDirectory() ? ("directory" as const) : ("file" as const) };
      });
    },
    read(file) {
      return readFileSync(file, "utf8");
    },
    realpath(file) {
      return file;
    },
  };
}

describe("parseRulesV2 — the tracked v2 policy/rules.yaml", () => {
  it("registers exactly the twelve invariants I1–I12, each exactly once", () => {
    const registry = trackedV2();
    expect(registry.version).toBe(2);
    expect(registry.gates.docDrift).toBe("soft");
    expectExactlyTwelveInvariants(registry);
  });

  it("preserves every v1 redline 1:1 with its id, severity and anchors", () => {
    const registry = trackedV2();
    const redlines = registry.rules.filter((rule) => rule.kind === "redline");
    expect([...redlines.map((rule) => rule.id)].sort()).toEqual([...REDLINE_IDS].sort());
    expect(registry.rules.find((rule) => rule.id === "RL-TCR-001")).toMatchObject({
      severity: "block",
      since: "v3.0",
      enforcement: [{ path: "hooks/pre-commit", marker: "RL-TCR-001" }],
      verification: [{ path: "packages/core/test/tcr.test.ts", marker: "RL-TCR-001" }],
    });
    expect(registry.rules.find((rule) => rule.id === "RL-FAIL-007")?.severity).toBe("alert");
    expect(registry.rules.find((rule) => rule.id === "RL-ISO-002")?.enforcement).toHaveLength(2);
  });

  it("fully anchors every rule and gives each invariant a complete projection", () => {
    const registry = trackedV2();
    for (const rule of registry.rules) {
      expect(["redline", "invariant"]).toContain(rule.kind);
      expect(["block", "alert", "observe"]).toContain(rule.severity);
      expect(rule.statement.length).toBeGreaterThan(0);
      expect(rule.ownerDomain.length).toBeGreaterThan(0);
      expect(rule.enforcement.length).toBeGreaterThanOrEqual(1);
      expect(rule.verification.length).toBeGreaterThanOrEqual(1);
      expect(rule.docs.length).toBeGreaterThanOrEqual(1);
      if (rule.kind === "invariant") {
        const projection = rule.projection;
        expect(projection).toBeDefined();
        expect(projection?.about.en.length).toBeGreaterThan(0);
        expect(projection?.about.zh.length).toBeGreaterThan(0);
        expect(projection?.verification.faultZh.length).toBeGreaterThan(0);
        expect(projection?.verification.expectedZh.length).toBeGreaterThan(0);
        expect(projection?.architecture.zh.length).toBeGreaterThan(0);
      } else {
        expect(rule.projection).toBeUndefined();
      }
    }
  });
});

describe("parseRulesRegistry — v2 projects onto the legacy v1 shape", () => {
  it("parses the tracked v2 registry into the v1 redline catalog contract", () => {
    const registry = ok(parseRulesRegistry(TRACKED_RULES));
    expect(registry.version).toBe(2);
    expect(registry.gates).toEqual({ docDrift: "soft" });
    expect(registry.rules).toHaveLength(REDLINE_IDS.length);
    expect(registry.rules.every((rule) => rule.kind === "redline")).toBe(true);
    expect(registry.rules.find((rule) => rule.id === "RL-TCR-001")).toMatchObject({
      kind: "redline",
      enforcement: [{ point: "hooks/pre-commit", marker: "RL-TCR-001" }],
      verification: { test: "packages/core/test/tcr.test.ts", marker: "RL-TCR-001" },
      triggerReport: "block",
      since: "v3.0",
    });
    expect(registry.rules.find((rule) => rule.id === "RL-FAIL-007")?.triggerReport).toBe("ALERT");
    expect(registry.docSurfaces.some((surface) => surface.id === "DS-ATTEST")).toBe(true);
  });
});

describe("auditV2Anchors — the live tree", () => {
  it("verifies every enforcement/verification/docs anchor against the current tree", () => {
    expect(auditV2Anchors(trackedV2(), realAnchorFs)).toEqual([]);
  });

  it("keeps every verification anchor vitest-discoverable", () => {
    for (const rule of trackedV2().rules) {
      for (const anchor of rule.verification) {
        expect(isDiscoverableVerificationPath(anchor.path)).toBe(true);
      }
    }
  });
});

describe("rules inventory — the tracked policy/rules-inventory.yaml", () => {
  it("classifies every marker file under the rule-candidate roots with no failures", () => {
    const inventory = ok(parseRulesInventory(TRACKED_INVENTORY));
    const report = auditRulesInventory(inventory, trackedV2(), realInventoryFs(REPO_ROOT), REPO_ROOT);
    expect(inventoryReportFails(report)).toBe(false);
    expect(report.covered.length).toBeGreaterThanOrEqual(REDLINE_IDS.length + INVARIANT_IDS.length);
  });
});

describe("v2 fail-closed fixtures", () => {
  it("fails the cardinality check when an I-number is missing", () => {
    const registry = trackedV2();
    const missing: ParsedRulesV2 = { ...registry, rules: registry.rules.filter((rule) => rule.id !== "I12") };
    expect(() => expectExactlyTwelveInvariants(missing)).toThrow();
  });

  it("rejects a duplicate rule id", () => {
    const entry = (id: string) => `  - id: ${id}
    kind: invariant
    statement: dup
    owner_domain: orchestration
    severity: block
    enforcement: [{ path: packages/core/src/loop/recovery.ts, marker: I2 }]
    verification: [{ path: packages/core/test/orchestrator.test.ts, marker: I2 }]
    docs: [{ path: docs/architecture.md, marker: I2 }]
    projection:
      about: { en: dup, zh: 重复 }
      verification: { fault_zh: 错, expected_zh: 对 }
      architecture: { zh: 重复 }
`;
    const text = `version: 2
gates: { doc_drift: soft }
rules:
${entry("I1")}${entry("I1")}pipeline_stages: []
doc_surfaces: []
`;
    const result = parseRulesV2(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/duplicate rule id/);
  });

  it("flags a stale inventory reference to a removed rule as an orphan anchor", () => {
    const inventoryText = `version: 1
coverage_sets:
  - id: stale-candidates
    purpose: rule-candidate
    roots: [packages/core/src/attest]
    include: ["report.ts"]
    allow_overlap_with: []
    exclude: []
candidates:
  - path: packages/core/src/attest/report.ts
    marker: "RL-GONE-999"
    classification: registered
    rule_id: RL-GONE-999
    reason: "stale reference to a removed rule"
    reviewed_by: US-RULE-009-test
`;
    const inventory = ok(parseRulesInventory(inventoryText));
    const report = auditRulesInventory(
      inventory,
      trackedV2(),
      memoryFs({ "packages/core/src/attest/report.ts": "export {};" }),
    );
    expect(report.orphan_anchor).toHaveLength(1);
    expect(report.orphan_anchor[0]?.marker).toBe("RL-GONE-999");
    expect(inventoryReportFails(report)).toBe(true);
  });

  it("flags a removed anchor file as a finding", () => {
    const removedFs: RulesAnchorFs = {
      isFile: (path) => path !== "packages/core/src/delivery/tcr.ts",
      read: () => "",
    };
    const findings = auditV2Anchors(trackedV2(), removedFs);
    expect(findings).toContain("[I12] missing enforcement anchor: packages/core/src/delivery/tcr.ts");
  });

  it("flags an anchor whose marker drifted out of the file", () => {
    const driftedFs: RulesAnchorFs = { isFile: () => true, read: () => "no markers here" };
    const findings = auditV2Anchors(trackedV2(), driftedFs);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((finding) => finding.includes('does not contain marker "I12"'))).toBe(true);
  });
});
