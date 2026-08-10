import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditV2Anchors,
  auditV2SurfacesAndStages,
  isDiscoverableVerificationPath,
  isProductionSourcePath,
  normalizeSurfacePattern,
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
  "RL-EXEC-010",
  "RL-DELIV-010",
  "RL-REL-010",
];
const RULE_010_BATCH_IDS = ["RL-EXEC-010", "RL-DELIV-010", "RL-REL-010"];

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

/** Real-tree adapter that additionally answers directory queries — the
 * `auditV2SurfacesAndStages` glob-base existence check needs it. */
const realSurfaceFs: RulesAnchorFs & { isDirectory: (path: string) => boolean } = {
  ...realAnchorFs,
  isDirectory: (path) => {
    const full = resolve(REPO_ROOT, path);
    return existsSync(full) && statSync(full).isDirectory();
  },
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

  it("registers the US-RULE-010 execution, delivery, and release batch without weakening gates", () => {
    const registry = trackedV2();
    const byId = new Map(registry.rules.map((rule) => [rule.id, rule]));

    expect(byId.get("RL-EXEC-010")).toMatchObject({
      kind: "redline",
      ownerDomain: "orchestration",
      severity: "block",
      enforcement: [
        { path: "packages/core/src/loop/skill-dispatch.ts", marker: "RL-EXEC-010" },
        { path: "packages/cli/src/runner/skill-dispatch-workspace.ts", marker: "RL-EXEC-010" },
      ],
      verification: [
        { path: "packages/core/test/skill-dispatch.test.ts", marker: "RL-EXEC-010" },
        { path: "packages/cli/test/skill-dispatch-workspace.test.ts", marker: "RL-EXEC-010" },
      ],
    });
    expect(byId.get("RL-DELIV-010")).toMatchObject({
      kind: "redline",
      ownerDomain: "evals",
      severity: "block",
      enforcement: [
        { path: "packages/core/src/delivery/evidence-gate.ts", marker: "RL-DELIV-010" },
        { path: "packages/cli/src/runner/local-publish.ts", marker: "RL-DELIV-010" },
        { path: "packages/cli/src/runner/terminal-handlers.ts", marker: "RL-DELIV-010" },
      ],
      verification: [
        { path: "packages/core/test/evidence-gate.test.ts", marker: "RL-DELIV-010" },
        { path: "packages/cli/test/evidence-gate-full-verify-us-cycle-011.test.ts", marker: "RL-DELIV-010" },
        { path: "packages/cli/test/runner-executor.test.ts", marker: "RL-DELIV-010" },
      ],
    });
    expect(byId.get("RL-REL-010")).toMatchObject({
      kind: "redline",
      ownerDomain: "guardrails",
      severity: "block",
      enforcement: [
        { path: "packages/core/src/release/flow.ts", marker: "RL-REL-010" },
        { path: "packages/cli/src/commands/release.ts", marker: "RL-REL-010" },
      ],
      verification: [
        { path: "packages/core/test/release-flow.test.ts", marker: "RL-REL-010" },
        { path: "packages/cli/test/release.test.ts", marker: "RL-REL-010" },
      ],
    });
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

  it("records the US-RULE-010 batch as reviewed registered candidates", () => {
    const inventory = ok(parseRulesInventory(TRACKED_INVENTORY));
    const candidates = inventory.candidates.filter((candidate) => candidate.reviewedBy === "US-RULE-010" && candidate.classification === "registered");
    expect(new Set(candidates.map((candidate) => candidate.ruleId))).toEqual(new Set(RULE_010_BATCH_IDS));
    for (const ruleId of RULE_010_BATCH_IDS) {
      expect(candidates.filter((candidate) => candidate.ruleId === ruleId).length).toBeGreaterThanOrEqual(1);
      expect(candidates.filter((candidate) => candidate.ruleId === ruleId).every((candidate) => candidate.classification === "registered")).toBe(true);
    }
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

/* US-RULE-014 — doc-surface + pipeline-stage declarations: parser
 * normalization/validation and the fail-closed surfaces+stages audit. */

const MINIMAL_RULE = `  - id: I1
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

const EXPECTED_STAGE_IDS = [
  "STAGE-ATTEST-GATE",
  "STAGE-EVIDENCE-GATE",
  "STAGE-CONTRACT-SNAPSHOT",
  "STAGE-RECONCILE",
  "STAGE-RELEASE",
  "STAGE-EVAL-TIER",
];

function v2TextWithDocSurfaces(surfacesYaml: string, stagesYaml = "pipeline_stages: []\n"): string {
  return `version: 2
gates: { doc_drift: soft }
rules:
${MINIMAL_RULE}${stagesYaml}doc_surfaces:
${surfacesYaml}`;
}

function surfaceBlock(id: string, paths: readonly string[], docs: readonly string[]): string {
  const quotedPaths = paths.map((p) => JSON.stringify(p)).join(", ");
  const quotedDocs = docs.map((d) => JSON.stringify(d)).join(", ");
  return `  - id: ${id}
    paths: [${quotedPaths}]
    docs: [${quotedDocs}]
`;
}

function stageBlock(id: string, consumerPath: string, marker = "RL-EVID-004"): string {
  return `  - id: ${id}
    inputs: [in]
    outputs: [out]
    exit: fail
    consumer: { path: ${JSON.stringify(consumerPath)}, marker: ${marker} }
`;
}

const allExistsFs: RulesAnchorFs & { isDirectory: (path: string) => boolean } = {
  isFile: () => true,
  read: () => "marker present",
  isDirectory: () => true,
};

describe("US-RULE-014 — the tracked v2 doc-surface and pipeline-stage declarations", () => {
  it("registers the full 13-surface doc-surface set including DS-ATTEST", () => {
    const registry = trackedV2();
    expect(registry.docSurfaces.map((s) => s.id)).toEqual([
      "DS-ATTEST",
      "DS-EVIDENCE-DELIVERY",
      "DS-RECONCILE",
      "DS-LOOP",
      "DS-EVENTS",
      "DS-COST",
      "DS-AGENT",
      "DS-BACKLOG",
      "DS-RELEASE",
      "DS-CLI-COMMANDS",
      "DS-CLI-RUNNER",
      "DS-CLI-LIB",
      "DS-SPEC",
    ]);
    expect(registry.docSurfaces.some((s) => s.id === "DS-ATTEST")).toBe(true);
  });

  it("registers exactly the six verified pipeline stages, each with a production consumer", () => {
    const registry = trackedV2();
    expect(registry.pipelineStages.map((s) => s.id)).toEqual(EXPECTED_STAGE_IDS);
    for (const stage of registry.pipelineStages) {
      expect(isProductionSourcePath(stage.consumer.path)).toBe(true);
    }
  });

  it("audits every surface pattern, doc target, and stage consumer against the live tree", () => {
    expect(auditV2SurfacesAndStages(trackedV2(), realSurfaceFs)).toEqual([]);
    expect(auditV2Anchors(trackedV2(), realAnchorFs)).toEqual([]);
  });

  it("normalizes ./ prefixes, backslashes, whitespace and duplicate slashes in surface patterns", () => {
    const text = v2TextWithDocSurfaces(
      surfaceBlock("DS-NORM", ["./packages\\core\\src\\attest\\**", "  packages/core//src/attest/report.ts  "], ["docs/verification.md"]),
    );
    const registry = ok(parseRulesV2(text));
    expect(registry.docSurfaces[0]?.paths).toEqual([
      "packages/core/src/attest/**",
      "packages/core/src/attest/report.ts",
    ]);
  });
});

describe("US-RULE-014 — parser rejects unsafe, broad, and dead surface/stage config", () => {
  it.each([
    ["bare ** on the paths side", ["**"], /out-of-vocabulary|unsupported glob syntax/],
    ["one-segment glob base packages/**", ["packages/**"], /broad pattern/],
    ["doc-alignment root docs/**", ["docs/**"], /doc-alignment root/],
    ["doc-alignment root guide/en/**", ["guide/en/**"], /doc-alignment root/],
    ["doc-alignment root policy/**", ["policy/**"], /doc-alignment root/],
    ["mid-star a/*.ts", ["a/*.ts"], /out-of-vocabulary|unsupported glob syntax/],
    [".. segment", ["../x.ts"], /\.\. segments/],
  ] as const)("rejects %s", (_label, paths, message) => {
    const result = parseRulesV2(v2TextWithDocSurfaces(surfaceBlock("DS-X", paths, ["docs/verification.md"])));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(message);
  });

  it("rejects a docs entry that is not an exact file path", () => {
    const result = parseRulesV2(
      v2TextWithDocSurfaces(surfaceBlock("DS-X", ["packages/core/src/attest/**"], ["docs/verification.md/**"])),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/docs must be exact file paths/);
  });

  it("rejects a duplicate stage id", () => {
    const text = v2TextWithDocSurfaces(
      surfaceBlock("DS-X", ["packages/core/src/attest/**"], ["docs/verification.md"]),
      `pipeline_stages:\n${stageBlock("STAGE-DUP", "packages/cli/src/runner/done-guard.ts")}${stageBlock("STAGE-DUP", "packages/cli/src/runner/local-publish.ts", "RL-DELIV-010")}`,
    );
    const result = parseRulesV2(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/invalid or duplicate stage id/);
  });

  it("rejects a duplicate normalized pattern within one surface", () => {
    const text = v2TextWithDocSurfaces(
      surfaceBlock("DS-X", ["packages/core/src/attest/**", "./packages/core/src/attest/**"], ["docs/verification.md"]),
    );
    const result = parseRulesV2(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/duplicate pattern/);
  });

  it("rejects a duplicate normalized doc target within one surface", () => {
    const text = v2TextWithDocSurfaces(
      surfaceBlock("DS-X", ["packages/core/src/attest/**"], ["docs/verification.md", "docs/verification.md"]),
    );
    const result = parseRulesV2(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/duplicate pattern/);
  });

  it.each([
    ["a test path", "packages/cli/test/x.test.ts"],
    ["a docs path", "docs/a.md"],
    ["a generated dist path", "packages/spec/dist/index.js"],
    ["the registry itself", "policy/rules.yaml"],
  ] as const)("rejects a consumer anchor in %s", (_label, consumerPath) => {
    const text = v2TextWithDocSurfaces(
      surfaceBlock("DS-X", ["packages/core/src/attest/**"], ["docs/verification.md"]),
      `pipeline_stages:\n${stageBlock("STAGE-X", consumerPath)}`,
    );
    const result = parseRulesV2(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/consumer\.path: must name production source/);
  });
});

describe("US-RULE-014 — audit rejects dangling surfaces, doc targets, and stage consumers", () => {
  it("flags a missing exact doc target", () => {
    const fs = { ...allExistsFs, isFile: (p: string) => p !== "docs/maps/attest.md" };
    const findings = auditV2SurfacesAndStages(trackedV2(), fs);
    expect(findings).toContain("[DS-ATTEST] missing doc target: docs/maps/attest.md");
  });

  it("flags a missing glob base directory", () => {
    const fs = { ...allExistsFs, isDirectory: (p: string) => p !== "packages/core/src/attest" };
    const findings = auditV2SurfacesAndStages(trackedV2(), fs);
    expect(findings).toContain("[DS-ATTEST] missing surface path / glob base: packages/core/src/attest");
  });

  it("flags a missing stage consumer file", () => {
    const fs = { ...allExistsFs, isFile: (p: string) => p !== "packages/cli/src/runner/done-guard.ts" };
    const findings = auditV2SurfacesAndStages(trackedV2(), fs);
    expect(findings).toContain("[STAGE-ATTEST-GATE] missing consumer anchor: packages/cli/src/runner/done-guard.ts");
  });

  it("flags a stage consumer whose marker drifted out of the file", () => {
    const fs = {
      ...allExistsFs,
      read: (p: string) => (p === "packages/cli/src/runner/done-guard.ts" ? "no marker here" : "marker present"),
    };
    const findings = auditV2SurfacesAndStages(trackedV2(), fs);
    expect(findings).toContain(
      '[STAGE-ATTEST-GATE] consumer anchor packages/cli/src/runner/done-guard.ts does not contain marker "RL-EVID-004"',
    );
  });
});

describe("normalizeSurfacePattern + isProductionSourcePath — exported unit contract", () => {
  it("normalizes a trailing /** glob and an exact path", () => {
    expect(normalizeSurfacePattern("packages/core/src/attest/**", "paths", "ctx")).toBe("packages/core/src/attest/**");
    expect(normalizeSurfacePattern("packages/cli/src/runner/attest-gate.ts", "paths", "ctx")).toBe("packages/cli/src/runner/attest-gate.ts");
    expect(normalizeSurfacePattern("docs/verification.md", "docs", "ctx")).toBe("docs/verification.md");
  });

  it("throws on unsafe, unsupported, and broad paths-side patterns", () => {
    expect(() => normalizeSurfacePattern("**", "paths", "ctx")).toThrow(/out-of-vocabulary/);
    expect(() => normalizeSurfacePattern("packages/**", "paths", "ctx")).toThrow(/broad pattern/);
    expect(() => normalizeSurfacePattern("docs/**", "paths", "ctx")).toThrow(/doc-alignment root/);
    expect(() => normalizeSurfacePattern("a/*.ts", "paths", "ctx")).toThrow(/out-of-vocabulary|unsupported glob syntax/);
    expect(() => normalizeSurfacePattern("../x.ts", "paths", "ctx")).toThrow(/\.\. segments/);
    expect(() => normalizeSurfacePattern("packages/core/src/dist/**", "paths", "ctx")).toThrow(/test\|generated segment/);
  });

  it("rejects glob syntax on the docs side", () => {
    expect(() => normalizeSurfacePattern("docs/verification.md/**", "docs", "ctx")).toThrow(/docs must be exact file paths/);
  });

  it("isProductionSourcePath gates on the src/ prefix and generated segments", () => {
    expect(isProductionSourcePath("packages/cli/src/runner/done-guard.ts")).toBe(true);
    expect(isProductionSourcePath("packages/core/src/delivery/evidence-gate.ts")).toBe(true);
    expect(isProductionSourcePath("packages/infra/src/fs.ts")).toBe(true);
    expect(isProductionSourcePath("packages/spec/src/rules.ts")).toBe(true);
    expect(isProductionSourcePath("packages/cli/test/x.test.ts")).toBe(false);
    expect(isProductionSourcePath("docs/a.md")).toBe(false);
    expect(isProductionSourcePath("packages/spec/dist/index.js")).toBe(false);
    expect(isProductionSourcePath("policy/rules.yaml")).toBe(false);
    expect(isProductionSourcePath("packages/cli/src/coverage/x.ts")).toBe(false);
  });
});
