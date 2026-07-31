import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SCRIPT = join(ROOT, "scripts/audit-rules.mjs");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "roll-audit-rules-"));
  dirs.push(dir);
  return dir;
}

const REGISTRY = `version: 1
gates:
  doc_drift: soft
rules:
  - id: RL-TCR-001
    kind: redline
    statement: fixture redline
    enforcement:
      - point: src/enforce.ts
        marker: "RL-TCR-001"
    verification:
      test: test/sample.test.ts
      marker: "RL-TCR-001"
    trigger_report: block
doc_surfaces: []
`;

function writeRegistry(root: string, text = REGISTRY) {
  mkdirSync(join(root, "policy"), { recursive: true });
  writeFileSync(join(root, "policy/rules.yaml"), text);
}

function writeEnforcementPoint(root: string, content = "// RL-TCR-001 enforced here\n") {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/enforce.ts"), content);
}

function writeVerificationTest(root: string, relPath = "test/sample.test.ts", content = "// RL-TCR-001 anchor\n") {
  mkdirSync(join(root, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(root, relPath), content);
}

function writeFullFixture(root: string) {
  writeRegistry(root);
  writeEnforcementPoint(root);
  writeVerificationTest(root);
}

function run(root: string): { ok: boolean; output: string } {
  try {
    return {
      ok: true,
      output: execFileSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (error) {
    const e = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("audit-rules fixture matrix", () => {
  it("passes on a fully wired registry", () => {
    const root = tmpRoot();
    writeFullFixture(root);

    const result = run(root);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("registered 1");
  });

  it("fails when the registry file is missing", () => {
    const root = tmpRoot();

    const result = run(root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("policy/rules.yaml not found");
  });

  it("fails when the registry is empty (zero rules)", () => {
    const root = tmpRoot();
    writeRegistry(root, "version: 1\ngates:\n  doc_drift: soft\nrules: []\ndoc_surfaces: []\n");

    const result = run(root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("failed to parse");
    expect(result.output).toMatch(/non-empty array/);
  });

  it("fails when an enforcement point file does not exist", () => {
    const root = tmpRoot();
    writeRegistry(root);
    writeVerificationTest(root);

    const result = run(root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("missing enforcement point: src/enforce.ts");
  });

  it("fails when an enforcement point exists but lacks its marker", () => {
    const root = tmpRoot();
    writeRegistry(root);
    writeEnforcementPoint(root, "// no marker here\n");
    writeVerificationTest(root);

    const result = run(root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain('does not contain marker "RL-TCR-001"');
  });

  it("fails when a verification test file does not exist", () => {
    const root = tmpRoot();
    writeRegistry(root);
    writeEnforcementPoint(root);

    const result = run(root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("missing verification test file: test/sample.test.ts");
  });

  it("fails when a verification test exists but lacks its marker", () => {
    const root = tmpRoot();
    writeRegistry(root);
    writeEnforcementPoint(root);
    writeVerificationTest(root, "test/sample.test.ts", "// no marker here\n");

    const result = run(root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("does not contain marker");
  });

  it("fails when verification.test points at a path vitest would never discover", () => {
    const root = tmpRoot();
    writeRegistry(
      root,
      REGISTRY.replace("test: test/sample.test.ts", "test: src/not-a-test-path.ts"),
    );
    writeEnforcementPoint(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/not-a-test-path.ts"), "// RL-TCR-001 anchor, wrong path shape\n");

    const result = run(root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("verification.test path is not discoverable by vitest");
  });

  it("fails on an unregistered RL- marker found in loose source", () => {
    const root = tmpRoot();
    writeFullFixture(root);
    mkdirSync(join(root, "src/other"), { recursive: true });
    writeFileSync(join(root, "src/other/loose.ts"), "// RL-ORPHAN-002 no registry entry\n");

    const result = run(root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("unregistered marker: RL-ORPHAN-002");
  });

  it("does not flag an RL- marker that lives inside a test directory", () => {
    const root = tmpRoot();
    writeFullFixture(root);
    writeFileSync(join(root, "test/other.test.ts"), "// RL-ORPHAN-003 referenced only in a test\n");

    const result = run(root);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("registered 1");
  });
});
