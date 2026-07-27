/**
 * FIX-1274 — integration coverage for the compatibility-aware per-commit test
 * gate in `roll test`.
 *
 * Each scenario fabricates an APE-PR-shaped target project (real git repo,
 * package.json test script, an installed-vitest version marker) plus a PATH
 * `npm` shim that faithfully models the runner's flag behaviour — Vitest 3.2.x
 * rejects `--affected`, accepts `--changed`, and exits 0 when `--changed`
 * matches no tests. The tests assert that:
 *   - roll never forwards `--affected` to raw Vitest;
 *   - a supported `--changed` mode is preferred, else the full suite runs;
 *   - a proof is minted ONLY after a supported command actually returns zero;
 *   - a zero-test `--changed` selection falls back to the (stricter) full suite
 *     and never fabricates a green proof;
 *   - proof metadata (tree/command/mode/ts) is preserved and keeps the tcr
 *     freshness/tree-match guard effective;
 *   - resolution is deterministic and unresolvable projects fail loud.
 *
 * A single focused subprocess also proves the underlying premise against the
 * REAL installed Vitest: its CLI rejects `--affected` as an unknown option.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { freshnessVerdict, parseTestPassProof } from "@roll/core";
import { testCommand } from "../src/commands/test.js";
import { seedUpdateCheckCache } from "./helpers.js";

const require = createRequire(import.meta.url);
const dirs: string[] = [];
let home = "";
let pkgDir = "";

function ensureHome(): void {
  if (home !== "") return;
  home = realpathSync(mkdtempSync(join(tmpdir(), "roll-gate-home-")));
  dirs.push(home);
  mkdirSync(join(home, ".roll"), { recursive: true });
  seedUpdateCheckCache(join(home, ".roll"));
  pkgDir = realpathSync(mkdtempSync(join(tmpdir(), "roll-gate-pkg-")));
  dirs.push(pkgDir);
  mkdirSync(join(pkgDir, "skills", "roll-onboard"), { recursive: true });
  writeFileSync(join(pkgDir, "skills", "roll-onboard", "SKILL.md"), "# roll-onboard\n");
}

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

interface Fixture {
  proj: string;
  shimDir: string;
  npmLog: string;
}

/** Build a git-backed target project + a PATH shim dir carrying the npm shim. */
function fixture(opts: {
  testScript?: string;
  vitestVersion?: string;
  npmShim: string; // body after the shebang line
  files?: Record<string, string>;
}): Fixture {
  ensureHome();
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-gate-proj-")));
  dirs.push(proj);
  mkdirSync(join(proj, ".roll"), { recursive: true });
  writeFileSync(join(proj, ".roll", "local.yaml"), "test_isolation:\n  type: none\n");
  const pkg: { name: string; scripts?: Record<string, string> } = { name: "target-fixture" };
  if (opts.testScript !== undefined) pkg.scripts = { test: opts.testScript };
  writeFileSync(join(proj, "package.json"), JSON.stringify(pkg, null, 2));
  if (opts.vitestVersion !== undefined) {
    mkdirSync(join(proj, "node_modules", "vitest"), { recursive: true });
    writeFileSync(
      join(proj, "node_modules", "vitest", "package.json"),
      JSON.stringify({ name: "vitest", version: opts.vitestVersion }),
    );
  }
  for (const [rel, body] of Object.entries(opts.files ?? {})) {
    const abs = join(proj, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  // Real git repo so writeTestProof can bind a tree hash.
  const git = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: proj, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline", "--no-verify"]);

  const shimDir = realpathSync(mkdtempSync(join(tmpdir(), "roll-gate-bin-")));
  dirs.push(shimDir);
  const npmLog = join(shimDir, "npm-args.log");
  writeFileSync(
    join(shimDir, "npm"),
    ["#!/bin/sh", `echo "$*" >> "${npmLog}"`, opts.npmShim, ""].join("\n"),
    { mode: 0o755 },
  );
  return { proj, shimDir, npmLog };
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

const ENV_KEYS = ["PATH", "HOME", "ROLL_HOME", "NO_COLOR", "ROLL_LANG", "LC_ALL", "LANG", "PWD", "ROLL_PKG_DIR", "ROLL_RUN_DIR"];

function runRollTest(fx: Fixture, args: string[] = []): Run {
  const target: Record<string, string> = {
    PATH: `${fx.shimDir}:/usr/bin:/bin`,
    HOME: home,
    ROLL_HOME: join(home, ".roll"),
    NO_COLOR: "1",
    ROLL_LANG: "en",
    ROLL_PKG_DIR: pkgDir,
    PWD: fx.proj,
  };
  const save: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) save[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(target)) process.env[k] = v;
  const saveCwd = process.cwd();
  process.chdir(fx.proj);
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (out.push(String(c)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (c: string | Uint8Array): boolean => (err.push(String(c)), true);
  let status: number;
  try {
    status = testCommand(args);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.chdir(saveCwd);
    for (const k of ENV_KEYS) {
      const v = save[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { status, stdout: out.join(""), stderr: err.join("") };
}

function proofPath(proj: string): string {
  return join(proj, ".roll", "last-test-pass");
}
function readProof(proj: string): { ts?: number; tree?: string; mode?: string; command?: string; scope?: string } {
  return JSON.parse(readFileSync(proofPath(proj), "utf8"));
}
function gitTree(proj: string): string {
  return spawnSync("git", ["write-tree"], { cwd: proj, encoding: "utf8" }).stdout.trim();
}

// A vitest-3.2.x-flavoured npm shim: reject --affected, run on --changed / full.
const VITEST_SHIM = [
  'case "$*" in',
  '  *--affected*) echo "CACError: Unknown option \\`--affected\\`" >&2; exit 1 ;;',
  '  *--changed*) echo "Test Files  1 passed (1)"; echo "Tests  3 passed (3)"; exit 0 ;;',
  '  *) echo "Test Files  9 passed (9)"; exit 0 ;;',
  "esac",
].join("\n");

describe("FIX-1274 roll test gate — Vitest 3.2.x compatibility", () => {
  it("prefers --changed, never forwards --affected, and mints a real proof", () => {
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: VITEST_SHIM });
    const r = runRollTest(fx);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("3 passed"); // real changed-test output surfaced
    const npmArgs = readFileSync(fx.npmLog, "utf8");
    expect(npmArgs).toContain("test -- --changed");
    expect(npmArgs).not.toContain("--affected"); // the unsupported flag is never sent

    const proof = readProof(fx.proj);
    expect(proof.mode).toBe("changed");
    expect(proof.command).toBe("npm test -- --changed");
    expect(proof.tree).toBe(gitTree(fx.proj));
    expect(typeof proof.ts).toBe("number");
  });

  it("keeps the tcr freshness/tree-match guard effective on the written proof", () => {
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: VITEST_SHIM });
    runRollTest(fx);
    const body = readFileSync(proofPath(fx.proj), "utf8");
    const parsed = parseTestPassProof(body);
    expect(parsed).toBeDefined();
    if (!parsed) throw new Error("proof unparseable");

    // Fresh + matching tree → allowed.
    const okVerdict = freshnessVerdict({
      stagedFiles: ["src/app.ts"],
      proofBody: body,
      now: parsed.ts + 1,
      currentTree: parsed.tree,
    });
    expect(okVerdict.allowed).toBe(true);

    // A changed tree → blocked (guard still bites).
    const blocked = freshnessVerdict({
      stagedFiles: ["src/app.ts"],
      proofBody: body,
      now: parsed.ts + 1,
      currentTree: "0000000000000000000000000000000000000000",
    });
    expect(blocked).toEqual({ allowed: false, reason: "tree-changed" });
  });

  it("is deterministic: three runs pick the same mode/command/tree", () => {
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: VITEST_SHIM });
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = runRollTest(fx);
      expect(r.status).toBe(0);
      const p = readProof(fx.proj); // each run overwrites the proof
      seen.add(`${p.mode}|${p.command}|${p.tree}`);
    }
    expect(seen.size).toBe(1);
    expect(readProof(fx.proj).mode).toBe("changed");
  });
});

describe("FIX-1274 roll test gate — conservative full fallback", () => {
  it("falls back to the full suite when the Vitest version is undetectable", () => {
    const fx = fixture({ testScript: "vitest run", npmShim: VITEST_SHIM }); // no vitestVersion
    const r = runRollTest(fx);
    expect(r.status).toBe(0);
    const npmArgs = readFileSync(fx.npmLog, "utf8").trim();
    expect(npmArgs).toBe("test"); // full suite, no changed/affected flag
    expect(readProof(fx.proj).mode).toBe("full");
  });

  it("a --changed selection matching 0 tests falls back to the full suite (never a fabricated green)", () => {
    const shim = [
      'case "$*" in',
      '  *--changed*) echo "No test files found, exiting with code 0"; exit 0 ;;',
      '  *) echo "Test Files  9 passed (9)"; exit 0 ;;',
      "esac",
    ].join("\n");
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: shim });
    const r = runRollTest(fx);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("changed-test mode matched 0 tests");
    const npmArgs = readFileSync(fx.npmLog, "utf8");
    expect(npmArgs).toContain("test -- --changed");
    expect(npmArgs).toContain("test\n"); // full suite run as fallback
    const proof = readProof(fx.proj);
    expect(proof.mode).toBe("full"); // proof reflects the command that actually ran tests
    expect(proof.command).toBe("npm test");
  });

  it("runs the project's full command unchanged for a non-vitest runner", () => {
    const shim = ["case \"$*\" in", "  *--affected*|*--changed*) echo unexpected-flag >&2; exit 3 ;;", "  *) echo jest-ok; exit 0 ;;", "esac"].join("\n");
    const fx = fixture({ testScript: "jest", npmShim: shim });
    const r = runRollTest(fx);
    expect(r.status).toBe(0);
    expect(readFileSync(fx.npmLog, "utf8").trim()).toBe("test");
    expect(readProof(fx.proj).mode).toBe("full");
  });
});

describe("FIX-1274 roll test gate — no proof without a real green", () => {
  it("a failing test command cannot mint a proof", () => {
    const shim = 'echo "FAIL src/x.test.ts" >&2; exit 1';
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: shim });
    const r = runRollTest(fx);
    expect(r.status).toBe(1);
    expect(existsSync(proofPath(fx.proj))).toBe(false);
  });

  it("a zero-test changed AND zero-test full both fail → no proof (no fabricated green)", () => {
    const shim = [
      'case "$*" in',
      '  *--changed*) echo "No test files found, exiting with code 0"; exit 0 ;;',
      '  *) echo "No test files found, exiting with code 1" >&2; exit 1 ;;',
      "esac",
    ].join("\n");
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: shim });
    const r = runRollTest(fx);
    expect(r.status).toBe(1);
    expect(existsSync(proofPath(fx.proj))).toBe(false);
  });

  it("a full run that reports zero test files cannot mint a proof even when it exits 0", () => {
    // Models `vitest run --passWithNoTests` with no tests at all: exit 0 but
    // nothing was verified. roll must fail loud, not fabricate a green.
    const shim = 'echo "No test files found, exiting with code 0"; exit 0';
    const fx = fixture({ testScript: "vitest run --passWithNoTests", npmShim: shim }); // undetected version → full
    const r = runRollTest(fx);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no test files");
    expect(existsSync(proofPath(fx.proj))).toBe(false);
  });

  it("an unknown-option failure cannot mint a proof", () => {
    const shim = 'echo "CACError: Unknown option \\`--bogus\\`" >&2; exit 1';
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: shim });
    const r = runRollTest(fx);
    expect(r.status).toBe(1);
    expect(existsSync(proofPath(fx.proj))).toBe(false);
  });
});

describe("FIX-1274 roll test gate — wrapper parity + diagnostics", () => {
  it("roll's own wrapper keeps --affected and roll does not double-write the proof", () => {
    const shim = 'case "$*" in *--affected*) echo "wrapper ran"; exit 0 ;; *) echo unexpected >&2; exit 4 ;; esac';
    const fx = fixture({ testScript: "bash scripts/test-ts.sh", npmShim: shim });
    const r = runRollTest(fx);
    expect(r.status).toBe(0);
    expect(readFileSync(fx.npmLog, "utf8")).toContain("test -- --affected");
    // The wrapper (shimmed away here) owns the proof; roll must not write one.
    expect(existsSync(proofPath(fx.proj))).toBe(false);
  });

  it("FIX-1454: the --affected wrapper reporting zero changed tests stays green (loop worktree)", () => {
    // Roll's wrapper runs `vitest --changed --passWithNoTests`. In a cycle
    // worktree the builder's change is already committed, so `--changed` matches
    // 0 tests and the wrapper prints "No test files found" yet exits 0 (honest
    // green — CI's full suite is the real gate). The zero-test hard-fail (FIX-1274)
    // must NOT apply to the wrapper's `affected` mode, or every loop delivery's
    // attest capture-command (`roll test`) fails with exit 3 and nothing publishes.
    const shim = 'case "$*" in *--affected*) echo "No test files found, exiting with code 0"; echo "TS suites green (scope: affected)"; exit 0 ;; *) exit 4 ;; esac';
    const fx = fixture({ testScript: "bash scripts/test-ts.sh", npmShim: shim });
    const r = runRollTest(fx);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("nothing was verified");
  });

  it("a package.json with no test script fails loud with a structured diagnostic", () => {
    const fx = fixture({ npmShim: "echo should-not-run; exit 0" }); // no testScript
    const r = runRollTest(fx);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no test command could be resolved");
    expect(r.stderr).toContain("attempted: npm test");
    expect(r.stderr).toMatch(/next step:/);
    expect(existsSync(fx.npmLog)).toBe(false); // npm never invoked
    expect(existsSync(proofPath(fx.proj))).toBe(false);
  });

  it("explicit `-- <args>` forwards verbatim (no resolution, no roll-minted proof)", () => {
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: "echo forwarded; exit 0" });
    const r = runRollTest(fx, ["--", "tests/unit"]);
    expect(r.status).toBe(0);
    expect(readFileSync(fx.npmLog, "utf8").trim()).toBe("test -- tests/unit");
    expect(existsSync(proofPath(fx.proj))).toBe(false);
  });
});

describe("US-CYCLE-011 roll test --full — round-tail full verify", () => {
  it("runs the WHOLE suite (no --changed/--affected) and mints a mode:full proof", () => {
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: VITEST_SHIM });
    const r = runRollTest(fx, ["--full"]);

    expect(r.status).toBe(0);
    const npmArgs = readFileSync(fx.npmLog, "utf8");
    expect(npmArgs).not.toContain("--changed"); // full scope, not the per-commit subset
    expect(npmArgs).not.toContain("--affected");

    const proof = readProof(fx.proj);
    expect(proof.mode).toBe("full"); // the stamp the delivery full-verify gate requires
    expect(proof.command).toBe("npm test");
    expect(proof.tree).toBe(gitTree(fx.proj));
  });

  it("`--full` is stripped from the passthrough and never leaks to npm", () => {
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: VITEST_SHIM });
    runRollTest(fx, ["--full"]);
    expect(readFileSync(fx.npmLog, "utf8")).not.toContain("--full");
  });

  it("the per-commit gate still mints mode:changed (full is opt-in, AC1 unbroken)", () => {
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: VITEST_SHIM });
    runRollTest(fx); // no --full
    expect(readProof(fx.proj).mode).toBe("changed");
  });

  it("`--full` combined with a `-- <args>` passthrough is REJECTED (footgun guard)", () => {
    const fx = fixture({ testScript: "vitest run", vitestVersion: "3.2.7", npmShim: VITEST_SHIM });
    const r = runRollTest(fx, ["--full", "--", "--affected"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot be combined with");
    expect(existsSync(proofPath(fx.proj))).toBe(false); // no proof minted from the rejected run
    expect(existsSync(fx.npmLog)).toBe(false); // npm never invoked
  });
});

describe("FIX-1274 premise — the real installed Vitest rejects --affected", () => {
  it("`vitest run --affected` errors with an unknown-option before running tests", () => {
    const vitestBin = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "roll-gate-vitest-")));
    dirs.push(scratch);
    const r = spawnSync(process.execPath, [vitestBin, "run", "--affected", "--root", scratch], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/Unknown option/i);
  });
});
