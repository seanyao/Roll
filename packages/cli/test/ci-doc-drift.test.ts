import { describe, expect, it } from "vitest";
import { parseRulesRegistry } from "@roll/spec";
import {
  requiredChecksForDocDriftGate,
  requiredChecksFromRulesRegistry,
  runCiDocDriftCheck,
} from "../src/lib/ci-doc-drift.js";

const registry = (mode: "soft" | "hard") => parseRulesRegistry(`version: 1
gates:
  doc_drift: ${mode}
rules:
  - id: RL-TEST-001
    kind: redline
    statement: test
    enforcement:
      - point: packages/cli/src/lib/ci-doc-drift.ts
        marker: RL-TEST-001
    verification:
      test: packages/cli/test/ci-doc-drift.test.ts
      marker: RL-TEST-001
    trigger_report: ALERT
doc_surfaces:
  - id: DS-CLI
    paths:
      - packages/cli/src/commands/**
    docs:
      - guide/en/testing.md
`);

const BASE = "b".repeat(40);

describe("US-RULE-004c — named CI doc-drift check", () => {
  it("fails closed when merge-base HEAD origin/main is unavailable", () => {
    const result = runCiDocDriftCheck("/repo", {
      git: () => { throw new Error("missing base"); },
      registry: () => registry("soft"),
      stdout: () => {},
    });
    expect(result).toMatchObject({ exitCode: 1, mode: "unresolved" });
    expect(result.diagnostic).toContain("baseline unavailable");
    expect(result.diagnostic).toContain("origin/main");
  });

  it("annotates a soft hit, exits 0, and has no event-writing seam", () => {
    const warnings: string[] = [];
    const result = runCiDocDriftCheck("/repo", {
      git: (args) => args[0] === "merge-base" ? `${BASE}\n` : "packages/cli/src/commands/release.ts\0",
      registry: () => registry("soft"),
      warning: (message) => warnings.push(message),
      stdout: () => {},
    });
    expect(result).toMatchObject({ exitCode: 0, mode: "hit", baseline: BASE });
    expect(result.diagnostic).toContain("doc-drift soft hit");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DS-CLI");
  });

  it("succeeds when the declared documentation changes with its surface", () => {
    const result = runCiDocDriftCheck("/repo", {
      git: (args) => args[0] === "merge-base"
        ? `${BASE}\n`
        : "packages/cli/src/commands/release.ts\0guide/en/testing.md\0",
      registry: () => registry("soft"),
      stdout: () => {},
    });
    expect(result).toEqual({ exitCode: 0, mode: "clean", baseline: BASE, diagnostic: `clean against ${BASE}` });
  });

  it("projects gates.doc_drift onto the exact named merge set", () => {
    expect(requiredChecksForDocDriftGate("soft")).toEqual(["test-ts"]);
    expect(requiredChecksForDocDriftGate("hard")).toEqual(["test-ts", "doc-drift"]);
    expect(requiredChecksFromRulesRegistry(registry("hard"))).toEqual(["test-ts", "doc-drift"]);
  });
});
