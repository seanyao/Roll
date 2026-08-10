import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SCRIPT = join(ROOT, "scripts/gen-rule-projections.mjs");
/** The generator imports parseRulesV2 from the built @roll/spec dist. */
const SPEC_DIST = join(ROOT, "packages/spec/dist/index.js");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Minimal docs with the four sentinel marker pairs + placeholder rows. */
function verificationDoc(): string {
  return `# 质量体系

## L1 · 混沌测试

对 12 条不变量（I1–I12）的每一条，主动注入故障。

<!-- ROLL-INVARIANTS:verification:start -->
| # | placeholder |
<!-- ROLL-INVARIANTS:verification:end -->

## L2 · Evals
`;
}

function architectureDoc(): string {
  return `# 系统设计

## 行为合同

以下 12 条不变量定义了系统的可靠性边界。

<!-- ROLL-INVARIANTS:architecture:start -->
| # | placeholder |
<!-- ROLL-INVARIANTS:architecture:end -->

## 事实来源
`;
}

/** Fixture: real tracked registry text + minimal docs with the marker pairs. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-rule-projections-"));
  dirs.push(root);
  mkdirSync(join(root, "policy"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "policy/rules.yaml"), readFileSync(join(ROOT, "policy/rules.yaml"), "utf8"));
  writeFileSync(join(root, "docs/verification.md"), verificationDoc());
  writeFileSync(join(root, "docs/architecture.md"), architectureDoc());
  return root;
}

interface SpawnResult {
  ok: boolean;
  status: number;
  output: string;
}

function spawn(root: string, args: string[], env: Record<string, string> = {}): SpawnResult {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, "--root", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ROLL_SPEC_DIST: SPEC_DIST, ...env },
    });
    return { ok: true, status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { ok: false, status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

function runWrite(root: string): SpawnResult {
  return spawn(root, []);
}

function runCheck(root: string): SpawnResult {
  return spawn(root, ["--check"]);
}

function registry(root: string): string {
  return readFileSync(join(root, "policy/rules.yaml"), "utf8");
}

/** Remove the whole `  - id: <id>` entry block from a registry yaml copy. */
function removeInvariant(yaml: string, id: string): string {
  const start = yaml.indexOf(`  - id: ${id}\n`);
  const next = yaml.indexOf("\n  - id: ", start + 1);
  if (start < 0 || next < 0) throw new Error(`cannot locate ${id} block in fixture registry`);
  return yaml.slice(0, start) + yaml.slice(next + 1);
}

const I13_ENTRY = `  - id: I13
    kind: invariant
    statement: "A thirteenth invariant beyond the locked twelve."
    owner_domain: orchestration
    severity: alert
    enforcement:
      - path: packages/spec/src/rules.ts
        marker: "I13"
    verification:
      - path: packages/spec/test/rules.test.ts
        marker: "I13"
    docs:
      - path: docs/architecture.md
        marker: "I13"
    projection:
      about:
        en: "Extra invariant beyond the twelve."
        zh: "第十二条之外的额外不变量。"
      verification:
        fault_zh: "额外不变量"
        expected_zh: "额外不变量"
      architecture:
        zh: "第十二条之外的额外不变量。"
`;

/** Insert a full extra invariant entry before pipeline_stages. */
function addInvariant(yaml: string, entry: string): string {
  const anchor = "\npipeline_stages:";
  const index = yaml.indexOf(anchor);
  if (index < 0) throw new Error("cannot locate pipeline_stages in fixture registry");
  return `${yaml.slice(0, index)}\n${entry}${yaml.slice(index)}`;
}

function bytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of [
    "docs/generated/verification-invariants.md",
    "docs/generated/architecture-invariants.md",
    "docs/generated/README.md",
    "packages/spec/src/generated/invariants.ts",
    "docs/verification.md",
    "docs/architecture.md",
  ]) {
    const full = join(root, file);
    if (existsSync(full)) out[file] = readFileSync(full, "utf8");
  }
  return out;
}

function mtimes(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of [
    "docs/generated/verification-invariants.md",
    "docs/generated/architecture-invariants.md",
    "docs/generated/README.md",
    "packages/spec/src/generated/invariants.ts",
    "docs/verification.md",
    "docs/architecture.md",
  ]) {
    const full = join(root, file);
    if (existsSync(full)) out[file] = statSync(full).mtimeMs;
  }
  return out;
}

describe("US-RULE-013 — generated rule projections", () => {
  it("write mode emits every output: fragments, doc regions, typed module; check ok after", () => {
    const root = fixtureRoot();

    const write = runWrite(root);
    expect(write.ok).toBe(true);
    expect(write.output).toContain("generated rule projections: 12 invariants");

    for (const fragment of ["verification-invariants.md", "architecture-invariants.md", "README.md"]) {
      const content = readFileSync(join(root, `docs/generated/${fragment}`), "utf8");
      expect(content).toContain("<!-- GENERATED by scripts/gen-rule-projections.mjs; DO NOT EDIT. -->");
    }
    const verification = readFileSync(join(root, "docs/generated/verification-invariants.md"), "utf8");
    expect(verification).toContain("| I1 |");
    expect(verification).toContain("| I12 |");
    const architecture = readFileSync(join(root, "docs/generated/architecture-invariants.md"), "utf8");
    expect(architecture).toContain("| I1 |");
    expect(architecture).toContain("| I12 |");

    // Doc regions are byte-identical to the fragments.
    expect(readFileSync(join(root, "docs/verification.md"), "utf8")).toContain(verification);
    expect(readFileSync(join(root, "docs/architecture.md"), "utf8")).toContain(architecture);

    const module = readFileSync(join(root, "packages/spec/src/generated/invariants.ts"), "utf8");
    expect(module).toContain("export const GENERATED_INVARIANTS");
    expect(module).toContain("export const GENERATED_INVARIANT_IDS");
    expect(module).toContain("A running cycle writes a heartbeat at least every 60s");

    expect(runCheck(root).ok).toBe(true);
    expect(runCheck(root).output).toContain("rule projections ok: 12 invariants fresh");
  });

  it("exact twelve-ID — a missing invariant fails loud in write mode and writes nothing", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "policy/rules.yaml"), removeInvariant(registry(root), "I7"));

    const write = runWrite(root);
    expect(write.ok).toBe(false);
    expect(write.output).toContain("invariant set: missing invariant I7");
    // Nothing written — no docs/generated, no module, no sentinel replacement.
    expect(existsSync(join(root, "docs/generated"))).toBe(false);
    expect(existsSync(join(root, "packages/spec/src/generated/invariants.ts"))).toBe(false);
    expect(readFileSync(join(root, "docs/verification.md"), "utf8")).toBe(verificationDoc());
  });

  it("exact twelve-ID — an extra invariant id fails loud", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "policy/rules.yaml"), addInvariant(registry(root), I13_ENTRY));

    const write = runWrite(root);
    expect(write.ok).toBe(false);
    expect(write.output).toContain("invariant set: extra invariant I13");
    expect(existsSync(join(root, "docs/generated"))).toBe(false);
  });

  it("--json write-mode failure still emits the single JSON line (ok:false)", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "policy/rules.yaml"), removeInvariant(registry(root), "I7"));

    const result = spawn(root, ["--json"]);
    expect(result.ok).toBe(false);
    const json = JSON.parse(result.output) as { ok: boolean; findings: Array<{ kind: string; message: string }>; invariants: unknown[] };
    expect(json.ok).toBe(false);
    expect(json.findings).toEqual([{ kind: "invariant set", message: "missing invariant I7" }]);
    expect(json.invariants).toEqual([]);
  });

  it("exact twelve-ID — a duplicate invariant id is surfaced from parseRulesV2", () => {
    const root = fixtureRoot();
    const yaml = registry(root);
    const start = yaml.indexOf("  - id: I5\n");
    const end = yaml.indexOf("  - id: I6\n");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    // Duplicate the ENTIRE I5 entry block so parseRulesV2 sees two full I5
    // records and rejects with its own duplicate-rule-id error.
    const duplicated = `${yaml.slice(0, end)}${yaml.slice(start, end)}${yaml.slice(end)}`;
    writeFileSync(join(root, "policy/rules.yaml"), duplicated);

    const write = runWrite(root);
    expect(write.ok).toBe(false);
    expect(write.output).toContain("parse:");
    expect(write.output).toContain('duplicate rule id "I5"');
    expect(existsSync(join(root, "docs/generated"))).toBe(false);
  });

  it("sentinel — a missing :start line fails loud in write AND check modes", () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, "docs/verification.md"),
      readFileSync(join(root, "docs/verification.md"), "utf8").replace("<!-- ROLL-INVARIANTS:verification:start -->\n", ""),
    );

    const write = runWrite(root);
    expect(write.ok).toBe(false);
    expect(write.output).toContain("sentinel: missing sentinel: docs/verification.md (verification)");
    expect(existsSync(join(root, "docs/generated"))).toBe(false);

    const check = runCheck(root);
    expect(check.ok).toBe(false);
    expect(check.output).toContain("sentinel: missing sentinel: docs/verification.md (verification)");
  });

  it("sentinel — a duplicated :start line fails loud with duplicate sentinel", () => {
    const root = fixtureRoot();
    const doc = readFileSync(join(root, "docs/architecture.md"), "utf8");
    writeFileSync(
      join(root, "docs/architecture.md"),
      doc.replace("<!-- ROLL-INVARIANTS:architecture:start -->\n", "<!-- ROLL-INVARIANTS:architecture:start -->\n<!-- ROLL-INVARIANTS:architecture:start -->\n"),
    );

    const write = runWrite(root);
    expect(write.ok).toBe(false);
    expect(write.output).toContain("sentinel: duplicate sentinel: docs/architecture.md (architecture)");
    expect(existsSync(join(root, "docs/generated"))).toBe(false);
  });

  it("deterministic — write twice is byte-identical; --check --json twice is byte-identical", () => {
    const root = fixtureRoot();
    expect(runWrite(root).ok).toBe(true);
    const first = bytes(root);
    expect(runWrite(root).ok).toBe(true);
    const second = bytes(root);
    expect(second).toEqual(first);

    const checkA = spawn(root, ["--check", "--json"]);
    const checkB = spawn(root, ["--check", "--json"]);
    expect(checkA.ok).toBe(true);
    expect(checkA.output).toBe(checkB.output);
    const json = JSON.parse(checkA.output) as { ok: boolean; findings: Array<{ kind: string; message: string }>; invariants: Array<{ id: string; n: number }> };
    expect(json.ok).toBe(true);
    expect(json.findings).toEqual([]);
    expect(json.invariants).toHaveLength(12);
    expect(json.invariants.map((inv) => inv.id)).toEqual(["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10", "I11", "I12"]);
    expect(json.invariants.map((inv) => inv.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("projection mutation → --check fails stale; write repairs fragment, doc region and module", () => {
    const root = fixtureRoot();
    expect(runWrite(root).ok).toBe(true);
    // Derive the mutation target from the generated module so the test stays
    // correct if the authored I1 prose ever changes.
    const modulePath = join(root, "packages/spec/src/generated/invariants.ts");
    const i1Fault = /faultZh: "([^"]+)"/.exec(readFileSync(modulePath, "utf8"))?.[1];
    expect(i1Fault).toBeTruthy();
    const mutated = `${i1Fault}（已修改）`;
    writeFileSync(join(root, "policy/rules.yaml"), registry(root).replace(i1Fault!, mutated));

    const check = runCheck(root);
    expect(check.ok).toBe(false);
    expect(check.output).toContain("stale:");

    expect(runWrite(root).ok).toBe(true);
    const fragment = readFileSync(join(root, "docs/generated/verification-invariants.md"), "utf8");
    expect(fragment).toContain(mutated);
    expect(readFileSync(join(root, "docs/verification.md"), "utf8")).toContain(mutated);
    expect(readFileSync(modulePath, "utf8")).toContain(mutated);
    expect(runCheck(root).ok).toBe(true);
  });

  it("hand-edited doc region → --check fails; write restores the exact fragment bytes", () => {
    const root = fixtureRoot();
    expect(runWrite(root).ok).toBe(true);
    const original = readFileSync(join(root, "docs/verification.md"), "utf8");
    const fragment = readFileSync(join(root, "docs/generated/verification-invariants.md"), "utf8");
    const i1Row = fragment.split("\n").find((line) => line.startsWith("| I1 |"));
    expect(i1Row).toBeTruthy();
    const doc = original.replace(i1Row!, "| I1 | HAND EDIT |");
    writeFileSync(join(root, "docs/verification.md"), doc);

    const check = runCheck(root);
    expect(check.ok).toBe(false);
    expect(check.output).toContain("stale: stale region: docs/verification.md (verification)");

    expect(runWrite(root).ok).toBe(true);
    expect(readFileSync(join(root, "docs/verification.md"), "utf8")).toBe(original);
  });

  it("--check never writes: mtimes and bytes of every output are unchanged after a failing check", () => {
    const root = fixtureRoot();
    expect(runWrite(root).ok).toBe(true);
    const modulePath = join(root, "packages/spec/src/generated/invariants.ts");
    const i1Fault = /faultZh: "([^"]+)"/.exec(readFileSync(modulePath, "utf8"))?.[1];
    expect(i1Fault).toBeTruthy();
    writeFileSync(join(root, "policy/rules.yaml"), registry(root).replace(i1Fault!, `${i1Fault}（已修改）`));
    const beforeMtimes = mtimes(root);
    const beforeBytes = bytes(root);

    const check = runCheck(root);
    expect(check.ok).toBe(false);
    expect(mtimes(root)).toEqual(beforeMtimes);
    expect(bytes(root)).toEqual(beforeBytes);
  });

  it("orphan prune — --check flags a stray docs/generated/*.md; write deletes it", () => {
    const root = fixtureRoot();
    expect(runWrite(root).ok).toBe(true);
    mkdirSync(join(root, "docs/generated"), { recursive: true });
    writeFileSync(join(root, "docs/generated/hand.md"), "# hand-maintained\n");

    const check = runCheck(root);
    expect(check.ok).toBe(false);
    expect(check.output).toContain("stale: orphan output: docs/generated/hand.md");

    expect(runWrite(root).ok).toBe(true);
    expect(existsSync(join(root, "docs/generated/hand.md"))).toBe(false);
    expect(existsSync(join(root, "docs/generated/verification-invariants.md"))).toBe(true);
    expect(runCheck(root).ok).toBe(true);
  });

  it("spec not built → build-first message and exit 1", () => {
    const root = fixtureRoot();
    const result = spawn(root, ["--check"], { ROLL_SPEC_DIST: join(root, "packages/spec/dist/index.js") });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("@roll/spec not built — run `pnpm -r build` first");
  });

  it("write mode repairs a stale module byte-exactly (hand-edited invariants.ts)", () => {
    const root = fixtureRoot();
    expect(runWrite(root).ok).toBe(true);
    const modulePath = join(root, "packages/spec/src/generated/invariants.ts");
    const original = readFileSync(modulePath, "utf8");
    writeFileSync(modulePath, original.replace("A running cycle writes a heartbeat at least every 60s", "hand-edited text"));

    const check = runCheck(root);
    expect(check.ok).toBe(false);
    expect(check.output).toContain("stale: stale module: packages/spec/src/generated/invariants.ts");

    expect(runWrite(root).ok).toBe(true);
    expect(readFileSync(modulePath, "utf8")).toBe(original);
    expect(runCheck(root).ok).toBe(true);
  });
});
