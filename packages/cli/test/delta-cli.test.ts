/**
 * US-DELTA-003 — CLI unit tests: help, parser, flag/enum validation, snapshots.
 *
 * RED phase: tests are demanding enough that they fail on the stub.
 */
import { describe, expect, it } from "vitest";
import { deltaCommand } from "../src/commands/delta.js";
import { renderState } from "../src/render.js";
import { auditImportClosure } from "./delta-import-audit.js";

// ── tsRun helper ─────────────────────────────────────────────────────────────

function tsRun(argv: string[]): { stdout: string; stderr: string; code: number } {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only override
  process.stdout.write = (c: string | Uint8Array): boolean => {
    out.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  };
  // @ts-expect-error capture-only override
  process.stderr.write = (c: string | Uint8Array): boolean => {
    err.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  };
  let code: number;
  try {
    code = deltaCommand(argv);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    renderState.useColor = true;
  }
  return { stdout: out.join(""), stderr: err.join(""), code };
}

// ── Scrubbing ────────────────────────────────────────────────────────────────

function scrub(output: string): string {
  return output
    // delta- prefixed UUIDs → delta-<DELEGATION_ID>
    .replace(/delta-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, "delta-<DELEGATION_ID>")
    // Generic path segments with delta- prefix and dash-suffix
    .replace(/\/[^\s:"']*\/delta-[a-f0-9-]+/g, "<PROJECT>/delta-<DELEGATION_ID>")
    // Plain UUIDs = remaining random IDs only
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, "<UUID>")
    .replace(/[a-f0-9]{64}/gi, "<SHA256>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TS>")
    .replace(/\b\d{13}\b/g, "<TS>")
    .replace(/\/tmp\/[^\s:"')\]]*/g, "<TMP>")
    .replace(/\/var\/folders\/[^\s:"')\]]*/g, "<TMP>")
    .replace(/\/private\/tmp\/[^\s:"')\]]*/g, "<TMP>");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("US-DELTA-003 — delta CLI parser and help", () => {
  it("roll delta help prints EN usage with all subcommands and exits 0", () => {
    const r = tsRun(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("prepare");
    expect(r.stdout).toContain("validate");
    expect(r.stdout).toContain("conclude");
    expect(r.stdout).toContain("status");
    expect(r.stdout).toContain("help");
    expect(r.stderr).toBe("");
    expect(scrub(r.stdout)).toMatchSnapshot();
  });

  it("roll delta help is localized to zh when ROLL_LANG=zh", () => {
    const prev = process.env["ROLL_LANG"];
    try {
      process.env["ROLL_LANG"] = "zh";
      const r = tsRun(["help"]);
      expect(r.code).toBe(0);
      // Chinese output contains CJK characters
      expect(r.stdout).not.toBe("");
      expect(/[\u4e00-\u9fff]/.test(r.stdout)).toBe(true);
      expect(scrub(r.stdout)).toMatchSnapshot();
    } finally {
      if (prev !== undefined) process.env["ROLL_LANG"] = prev;
      else delete process.env["ROLL_LANG"];
    }
  });

  it("roll delta with no subcommand prints usage (same as help)", () => {
    const r = tsRun([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("prepare");
    expect(r.stdout).toContain("validate");
  });

  it("roll delta unknown subcommand exits 1 with structured error", () => {
    const r = tsRun(["unknown-cmd"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown");
    expect(r.stderr).toContain("unknown-cmd");
    // Should suggest valid subcommands
    expect(r.stderr).toContain("prepare");
  });

  it("roll delta prepare rejects unknown flag", () => {
    const r = tsRun(["prepare", "US-TEST", "--nonexistent"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
  });

  it("roll delta prepare with --cycle rejected (host-guided has no cycle)", () => {
    const r = tsRun([
      "prepare", "US-TEST",
      "--trigger", "host-guided",
      "--topology", "delta-team",
      "--profile", "standard",
      "--preset", "local-preset",
      "--resolution", "/nonexistent.json",
      "--cycle", "some-cycle",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cycle");
  });

  it("roll delta prepare missing required flag returns error", () => {
    const r = tsRun(["prepare", "US-TEST"]);
    // Missing --trigger/--topology/--profile/--preset/--resolution
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
  });

  it("roll delta validate rejects unknown stage", () => {
    const r = tsRun(["validate", "--delegation", "d-123", "--stage", "nonexistent"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
  });

  it("roll delta conclude rejects unknown disposition", () => {
    const r = tsRun(["conclude", "--delegation", "d-123", "--delivery-disposition", "bad_value"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
  });

  it("roll delta status without --story or --delegation shows error", () => {
    const r = tsRun(["status"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
  });

  it("roll delta validate missing --delegation returns error", () => {
    const r = tsRun(["validate", "--stage", "designer"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
  });

  it("roll delta conclude missing --delegation returns error", () => {
    const r = tsRun(["conclude", "--delivery-disposition", "owner_continue"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
  });

  it("roll delta --json error format is precise {ok:false,error,detail} on stderr, stdout empty", () => {
    const r = tsRun(["prepare", "US-TEST", "--json"]);
    expect(r.code).toBe(1);
    // stdout must be empty under --json error
    expect(r.stdout).toBe("");
    // stderr must be valid JSON envelope { ok: false, error, detail }
    expect(() => JSON.parse(r.stderr)).not.toThrow();
    const err = JSON.parse(r.stderr);
    expect(err.ok).toBe(false);
    expect(typeof err.error).toBe("string");
    expect(typeof err.detail).toBe("string");
    expect(err.error.length).toBeGreaterThan(0);
    expect(err.detail.length).toBeGreaterThan(0);
  });

  // ─── Fix #6: CLI parser consistency — duplicate, unexpected positional, missing value ──

  it("prepare rejects duplicate --trigger flag", () => {
    const r = tsRun(["prepare", "US-TEST", "--trigger", "host-guided", "--trigger", "loop-autonomous"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("duplicate");
    expect(r.stdout).toBe("");
  });

  it("validate rejects duplicate --stage flag", () => {
    const r = tsRun(["validate", "--delegation", "d-123", "--stage", "designer", "--stage", "builder"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("duplicate");
  });

  it("status rejects duplicate --story flag", () => {
    const r = tsRun(["status", "--story", "US-X", "--story", "US-Y"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
    expect(r.stderr).toContain("duplicate");
  });

  it("prepare rejects missing value for --trigger (flag set to true)", () => {
    const r = tsRun(["prepare", "US-TEST", "--trigger", "--topology", "delta-team"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
  });

  it("validate rejects missing value for --stage (flag set to true)", () => {
    const r = tsRun(["validate", "--delegation", "d-123", "--stage", "--json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
  });

  it("conclude rejects unexpected positional arg", () => {
    const r = tsRun(["conclude", "extra-arg", "--delegation", "d-123"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
    expect(r.stderr).toContain("unexpected");
  });

  it("validate rejects unexpected positional arg", () => {
    const r = tsRun(["validate", "extra-arg", "--delegation", "d-123", "--stage", "designer"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
    expect(r.stderr).toContain("unexpected");
  });

  it("status rejects unexpected positional arg", () => {
    const r = tsRun(["status", "extra-arg", "--story", "US-X"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
    expect(r.stderr).toContain("unexpected");
  });

  it("prepare rejects unexpected positional arg beyond story-id", () => {
    const r = tsRun(["prepare", "US-TEST", "extra"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toBe("");
    expect(r.stderr).toContain("unexpected");
  });

  it("status --story + --delegation is allowed (delegation priority per Architecture adjudication)", () => {
    // This test verifies that the command does NOT reject the combination.
    // It will likely fail to find the delegation (no frame exists), but it must NOT be a parser error.
    const r = tsRun(["status", "--story", "US-X", "--delegation", "d-Y", "--json"]);
    // Must NOT be a parser/flag-combination error (which would produce error on stderr)
    // It may be 0 with a note or >0 with a delegation_not_found, but never a flag-rejection.
    const stderr = r.stderr;
    expect(stderr).not.toContain("status_selector");
    expect(stderr).not.toContain("unknown_flag");
    expect(stderr).not.toContain("duplicate");
  });

  it("status with unknown flag rejects", () => {
    const r = tsRun(["status", "--story", "US-X", "--unknown-flag"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown");
  });

  it("validate with unknown flag rejects", () => {
    const r = tsRun(["validate", "--delegation", "d-123", "--stage", "designer", "--unknown-flag"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown");
  });
});

// ── Import closure audit helper fixture tests ────────────────────────────────

describe("US-DELTA-003 — import closure audit helper (fixture-based)", () => {
  const path = require("node:path") as typeof import("node:path");
  const fixturesDir = path.resolve(__dirname, "fixtures");

  it("traverses side-effect imports (import '...')", () => {
    const entry = path.join(fixturesDir, "import-audit-side-effect", "main.ts");
    const result = auditImportClosure(entry, { rejectDynamicImport: false, rejectNonNodeRequire: false });
    const names = result.files.map((f) => path.basename(f));
    // Must include both main.ts (entry) and side-effect.ts (traversed via import "...")
    expect(names).toContain("main.ts");
    expect(names).toContain("side-effect.ts");
    expect(result.violations).toEqual([]);
  });

  it("traverses export * from re-exports", () => {
    const entry = path.join(fixturesDir, "import-audit-export-star", "main.ts");
    const result = auditImportClosure(entry, { rejectDynamicImport: false, rejectNonNodeRequire: false });
    const names = result.files.map((f) => path.basename(f));
    // Must include both main.ts (entry) and reexported.ts (traversed via export * from)
    expect(names).toContain("main.ts");
    expect(names).toContain("reexported.ts");
    expect(result.violations).toEqual([]);
  });

  it("resolves directory/index.ts", () => {
    const entry = path.join(fixturesDir, "import-audit-index-dir", "main.ts");
    const result = auditImportClosure(entry, { rejectDynamicImport: false, rejectNonNodeRequire: false });
    const names = result.files.map((f) => path.basename(f));
    // Must include main.ts and the resolved index.ts from the ./bar directory
    expect(names).toContain("main.ts");
    expect(names).toContain("index.ts");
    expect(result.violations).toEqual([]);
  });

  it("fail-closed on dynamic import()", () => {
    const entry = path.join(fixturesDir, "import-audit-dynamic-import", "main.ts");
    expect(() => auditImportClosure(entry)).toThrow(/dynamic import\(\)/);
  });

  it("fail-closed on non-node: require()", () => {
    const entry = path.join(fixturesDir, "import-audit-require", "main.ts");
    expect(() => auditImportClosure(entry)).toThrow(/require\(\)/);
  });

  it("fail-closed on unresolvable local import", () => {
    // Create a temp file that imports a nonexistent module
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const tmpDir = path.join(fixturesDir, "import-audit-tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, "broken-import.ts");
    try {
      fs.writeFileSync(tmpFile, 'import "./nonexistent-file.js";\n', "utf8");
      expect(() => auditImportClosure(tmpFile, { rejectDynamicImport: false, rejectNonNodeRequire: false }))
        .toThrow(/cannot resolve/i);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });
});

// ── Architectural negative guard (unified helper) ────────────────────────────

describe("US-DELTA-003 — import closure audit (unified helper on real source)", () => {
  it("recursive import closure from commands/index.ts: no forbidden patterns, fail-closed", () => {
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");

    // Entry: commands/index.ts (the dispatch registration point)
    const entryFile = path.resolve(__dirname, "..", "src", "commands", "index.ts");

    // Verify index.ts registers delta
    if (!fs.existsSync(entryFile)) {
      throw new Error(`Audit FAIL-CLOSED: commands/index.ts missing`);
    }
    const indexContent = fs.readFileSync(entryFile, "utf8");
    if (!indexContent.includes("deltaCommand") || !indexContent.includes('registerPorted("delta"')) {
      throw new Error("Audit FAIL-CLOSED: commands/index.ts must import and register deltaCommand");
    }

    // Use the unified helper from delta.ts as primary entry (index.ts re-exports it)
    const deltaEntry = path.resolve(__dirname, "..", "src", "commands", "delta.ts");
    const result = auditImportClosure(deltaEntry, {
      forbiddenTokens: [
        "agentSpawn", "@anthropic", "openai",
        "cycleAllocator", "allocCycle",
        "runs.jsonl", "createPR", "DeliveryRecord", "cycle:terminal", "upsertRun",
        "artifact-protocol", "attestation", "role-access", "manifest-v2",
      ],
    });

    // Must traverse at least delta.ts, delta-allocation.ts, delta-artifacts.ts
    const allocFile = path.resolve(__dirname, "..", "src", "lib", "delta-allocation.ts");
    const artifactsFile = path.resolve(__dirname, "..", "src", "lib", "delta-artifacts.ts");

    expect(result.files).toContain(deltaEntry);
    expect(result.files).toContain(allocFile);
    expect(result.files).toContain(artifactsFile);
    expect(result.violations).toEqual([]);
  });
});
