import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBacklog } from "@roll/core";
import { describe, expect, it } from "vitest";
import { ideaCommand } from "../src/commands/idea.js";

/** Run ideaCommand against a throwaway project with the given backlog. */
function run(
  args: string[],
  backlog: string,
): { status: number; stdout: string; stderr: string; backlog: string | null } {
  const proj = mkdtempSync(join(tmpdir(), "roll-idea-proj-"));
  mkdirSync(join(proj, ".roll"), { recursive: true });
  // Pre-create features dir so index refresh has somewhere to land.
  mkdirSync(join(proj, ".roll", "features"), { recursive: true });
  const path = join(proj, ".roll", "backlog.md");
  writeFileSync(path, backlog, "utf8");
  const save = { NO_COLOR: process.env["NO_COLOR"], ROLL_LANG: process.env["ROLL_LANG"] };
  process.env["NO_COLOR"] = "1";
  process.env["ROLL_LANG"] = "en";
  const saveCwd = process.cwd();
  process.chdir(proj);
  const outC: string[] = [];
  const errC: string[] = [];
  const rOut = process.stdout.write.bind(process.stdout);
  const rErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (x: string | Uint8Array): boolean => (outC.push(String(x)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (x: string | Uint8Array): boolean => (errC.push(String(x)), true);
  let status: number;
  let after: string | null = null;
  try {
    status = ideaCommand(args);
    after = readFileSync(path, "utf8");
  } finally {
    process.stdout.write = rOut;
    process.stderr.write = rErr;
    process.chdir(saveCwd);
    rmSync(proj, { recursive: true, force: true });
    if (save.NO_COLOR === undefined) delete process.env["NO_COLOR"];
    else process.env["NO_COLOR"] = save.NO_COLOR;
    if (save.ROLL_LANG === undefined) delete process.env["ROLL_LANG"];
    else process.env["ROLL_LANG"] = save.ROLL_LANG;
  }
  return { status, stdout: outC.join(""), stderr: errC.join(""), backlog: after };
}

/** Like run() but also returns the project path so callers can inspect the card folder. */
function runWithProj(
  args: string[],
  backlog: string,
): { status: number; stdout: string; stderr: string; backlog: string | null; proj: string } {
  return runWithProjSetup(args, backlog);
}

function runWithProjSetup(
  args: string[],
  backlog: string,
  setup?: (proj: string) => void,
): { status: number; stdout: string; stderr: string; backlog: string | null; proj: string } {
  const proj = mkdtempSync(join(tmpdir(), "roll-idea-proj-"));
  mkdirSync(join(proj, ".roll"), { recursive: true });
  mkdirSync(join(proj, ".roll", "features"), { recursive: true });
  setup?.(proj);
  const path = join(proj, ".roll", "backlog.md");
  writeFileSync(path, backlog, "utf8");
  const save = { NO_COLOR: process.env["NO_COLOR"], ROLL_LANG: process.env["ROLL_LANG"] };
  process.env["NO_COLOR"] = "1";
  process.env["ROLL_LANG"] = "en";
  const saveCwd = process.cwd();
  process.chdir(proj);
  const outC: string[] = [];
  const errC: string[] = [];
  const rOut = process.stdout.write.bind(process.stdout);
  const rErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (x: string | Uint8Array): boolean => (outC.push(String(x)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (x: string | Uint8Array): boolean => (errC.push(String(x)), true);
  let status: number;
  let after: string | null = null;
  try {
    status = ideaCommand(args);
    after = readFileSync(path, "utf8");
  } finally {
    process.stdout.write = rOut;
    process.stderr.write = rErr;
    process.chdir(saveCwd);
    // Don't clean up — caller inspects then tears down.
    if (save.NO_COLOR === undefined) delete process.env["NO_COLOR"];
    else process.env["NO_COLOR"] = save.NO_COLOR;
    if (save.ROLL_LANG === undefined) delete process.env["ROLL_LANG"];
    else process.env["ROLL_LANG"] = save.ROLL_LANG;
  }
  return { status, stdout: outC.join(""), stderr: errC.join(""), backlog: after, proj };
}

const EMPTY = ["# Backlog", "", "intro line", ""].join("\n");

/** run() with an injected remoteBacklogIds seam (FIX-1481). */
function runWithDeps(
  args: string[],
  backlog: string,
  remoteBacklogIds: (projectPath: string, opts?: { fetch?: boolean }) => string[],
): { status: number; stdout: string; stderr: string; backlog: string | null } {
  const proj = mkdtempSync(join(tmpdir(), "roll-idea-proj-"));
  mkdirSync(join(proj, ".roll", "features"), { recursive: true });
  const path = join(proj, ".roll", "backlog.md");
  writeFileSync(path, backlog, "utf8");
  const save = { NO_COLOR: process.env["NO_COLOR"], ROLL_LANG: process.env["ROLL_LANG"] };
  process.env["NO_COLOR"] = "1";
  process.env["ROLL_LANG"] = "en";
  const saveCwd = process.cwd();
  process.chdir(proj);
  const outC: string[] = [];
  const errC: string[] = [];
  const rOut = process.stdout.write.bind(process.stdout);
  const rErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (x: string | Uint8Array): boolean => (outC.push(String(x)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (x: string | Uint8Array): boolean => (errC.push(String(x)), true);
  let status: number;
  let after: string | null = null;
  try {
    status = ideaCommand(args, { remoteBacklogIds });
    after = readFileSync(path, "utf8");
  } finally {
    process.stdout.write = rOut;
    process.stderr.write = rErr;
    process.chdir(saveCwd);
    rmSync(proj, { recursive: true, force: true });
    if (save.NO_COLOR === undefined) delete process.env["NO_COLOR"];
    else process.env["NO_COLOR"] = save.NO_COLOR;
    if (save.ROLL_LANG === undefined) delete process.env["ROLL_LANG"];
    else process.env["ROLL_LANG"] = save.ROLL_LANG;
  }
  return { status, stdout: outC.join(""), stderr: errC.join(""), backlog: after };
}

describe("FIX-1481 — id allocation folds in the remote authoritative backlog", () => {
  const LOCAL = ["## 🐛 Bug Fixes", "", "| ID | Description | Status |", "|----|----|----|", "| FIX-001 | local only | ✅ Done |", ""].join("\n");

  it("AC1: allocates past a remote id this checkout has not synced (no collision)", () => {
    // Local max is FIX-001 → local-only would mint FIX-002; the remote already
    // holds FIX-005, so the new id must jump past it.
    const r = runWithDeps(["another", "crash", "to", "fix"], LOCAL, () => ["FIX-001", "FIX-005"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("FIX-006");
    expect(r.stdout).not.toContain("FIX-002");
  });

  it("AC2: fails loud when the chosen id was taken on the remote after allocation", () => {
    // 1st call = allocation pool: sees only FIX-001 → mints FIX-002. 2nd call =
    // pre-write re-check: a concurrent site has now pushed FIX-002. The re-check
    // MUST fetch fresh (fetch:true) — a stale read would miss it.
    const fetchFlags: Array<boolean | undefined> = [];
    let call = 0;
    const r = runWithDeps(["a", "racing", "bug"], LOCAL, (_p, opts) => {
      fetchFlags.push(opts?.fetch);
      return call++ === 0 ? ["FIX-001"] : ["FIX-001", "FIX-002"];
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FIX-002");
    // Nothing was written — the collision was refused, not silently duplicated.
    expect(r.backlog).toBe(LOCAL);
    // The pre-write re-check requested a FRESH fetch (not a stale local read).
    expect(fetchFlags[1]).toBe(true);
  });

  it("AC3: degrades to local (with a visible hint) when the remote is unreachable", () => {
    const r = runWithDeps(["a", "crash", "to", "fix", "offline"], LOCAL, () => []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("FIX-002"); // local max+1
    expect(r.stderr.toLowerCase()).toContain("remote backlog unreachable");
  });
});

describe("ideaCommand (E2E golden path)", () => {
  it("captures an idea: classifies, numbers, appends a parseable Todo row (exit 0)", () => {
    const r = run(["add", "a", "dark", "mode", "toggle"], EMPTY);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("IDEA-001");
    expect(r.stdout).toContain("idea");
    // The row is appended and parses back through the SAME backlog reader.
    const items = parseBacklog(r.backlog ?? "");
    const added = items.find((i) => i.id === "IDEA-001");
    expect(added?.status).toBe("📋 Todo");
    expect(added?.desc).toBe("add a dark mode toggle");
  });

  it("captures a bug under the FIX family", () => {
    const r = run(["the", "export", "button", "is", "broken"], EMPTY);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("FIX-001");
    const items = parseBacklog(r.backlog ?? "");
    expect(items.find((i) => i.id === "FIX-001")).toBeDefined();
  });

  it("auto-numbers from the existing max in the family", () => {
    const backlog = [
      "## 🐛 Bug Fixes",
      "",
      "| ID | Description | Status |",
      "|----|-------------|--------|",
      "| FIX-204 | old bug | ✅ Done |",
      "| FIX-215 | another | ✅ Done |",
      "",
    ].join("\n");
    const r = run(["a", "new", "crash", "on", "startup"], backlog);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("FIX-216");
  });

  it("refuses a description that fails lint and writes nothing", () => {
    const r = run(["use", "the", "`module`", "in", "src/app.ts"], EMPTY);
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("lint");
    // Backlog is byte-unchanged — no bad card landed.
    expect(r.backlog).toBe(EMPTY);
  });

  it("rejects empty input with usage (exit 1)", () => {
    const r = run([], EMPTY);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("roll idea");
    expect(r.backlog).toBe(EMPTY);
  });

  it("--help prints usage and exits 0 without writing", () => {
    const r = run(["--help"], EMPTY);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("roll idea");
    expect(r.backlog).toBe(EMPTY);
  });

  it("English output carries no CJK (single-language contract)", () => {
    const r = run(["add", "offline", "support"], EMPTY);
    expect(r.stdout).not.toMatch(/[一-鿿]/);
  });

  // REFACTOR-050: `roll idea` now creates the full card folder.
  it("creates a full story card folder (spec.md + index.html) — AC1", () => {
    const r = runWithProj(["add", "a", "loop", "runner", "for", "testing"], EMPTY);
    expect(r.status).toBe(0);
    // Epic inferred from "loop" keyword → "loop-engine"
    const specPath = join(r.proj, ".roll", "features", "loop-engine", "IDEA-001", "spec.md");
    expect(existsSync(specPath)).toBe(true);
    const spec = readFileSync(specPath, "utf8");
    expect(spec).toContain("id: IDEA-001");
    expect(spec).toContain("title: add a loop runner for testing");
    const pagePath = join(r.proj, ".roll", "features", "loop-engine", "IDEA-001", "index.html");
    expect(existsSync(pagePath)).toBe(true);
    // Cleanup.
    rmSync(r.proj, { recursive: true, force: true });
  });

  it("falls back to uncategorized epic when no keyword matches — AC3", () => {
    const r = runWithProj(["do", "something", "generic"], EMPTY);
    expect(r.status).toBe(0);
    const specPath = join(r.proj, ".roll", "features", "uncategorized", "IDEA-001", "spec.md");
    expect(existsSync(specPath)).toBe(true);
    rmSync(r.proj, { recursive: true, force: true });
  });

  it("infers epic from keywords — AC3 examples", () => {
    const cases: [string[], string][] = [
      [["the", "CLI", "usage", "is", "broken"], "cli-simplification"],
      [["add", "doc", "guide", "for", "new", "users"], "documentation"],
      [["ship", "a", "release", "script"], "release-management"],
      [["pair", "review", "with", "another", "agent"], "cross-agent-pairing"],
      [["improve", "backlog", "card", "lifecycle"], "backlog-lifecycle"],
    ];
    for (const [args, expectedEpic] of cases) {
      const r = runWithProj(args, EMPTY);
      expect(r.status).toBe(0);
      // The captured ID might be FIX-001 (bug keyword) or IDEA-001 (idea).
      // We just verify the card lands in the right epic folder.
      const featuresDir = join(r.proj, ".roll", "features", expectedEpic);
      expect(existsSync(featuresDir)).toBe(true);
      rmSync(r.proj, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing spec.md (born-once guard) — AC1", () => {
    const r = runWithProj(["add", "a", "loop", "cycle", "viewer"], EMPTY);
    expect(r.status).toBe(0);
    const specPath = join(r.proj, ".roll", "features", "loop-engine", "IDEA-001", "spec.md");
    expect(existsSync(specPath)).toBe(true);
    // Record the first mtime.
    const firstMtime = readFileSync(specPath, "utf8");
    // Run again with the same description. The card folder already exists —
    // it should NOT be overwritten, but a NEW backlog row (IDEA-002) is added.
    const r2 = runWithProj(["add", "a", "loop", "cycle", "viewer"], r.backlog ?? "");
    expect(r2.status).toBe(0);
    // IDEA-002 should be in the backlog.
    expect(r2.stdout).toContain("IDEA-002");
    // The original spec.md must still be the same.
    expect(readFileSync(specPath, "utf8")).toBe(firstMtime);
    // IDEA-002 got its own card folder.
    const spec2Path = join(r2.proj, ".roll", "features", "loop-engine", "IDEA-002", "spec.md");
    expect(existsSync(spec2Path)).toBe(true);
    rmSync(r.proj, { recursive: true, force: true });
    rmSync(r2.proj, { recursive: true, force: true });
  });

  it("allocates around existing card folders that are absent from backlog — FIX-1222", () => {
    const r = runWithProjSetup(["bug", "hidden", "folder", "collision"], EMPTY, (proj) => {
      const hiddenCard = join(proj, ".roll", "features", "loop-engine", "FIX-001");
      mkdirSync(hiddenCard, { recursive: true });
      writeFileSync(
        join(hiddenCard, "spec.md"),
        [
          "---",
          "id: FIX-001",
          "title: hidden existing card",
          "type: fix",
          "epic: loop-engine",
          "---",
          "",
        ].join("\n"),
        "utf8",
      );
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("FIX-002");
    const items = parseBacklog(r.backlog ?? "");
    expect(items.find((i) => i.id === "FIX-001")).toBeUndefined();
    expect(items.find((i) => i.id === "FIX-002")).toBeDefined();
    expect(existsSync(join(r.proj, ".roll", "features", "uncategorized", "FIX-002", "spec.md"))).toBe(true);
    rmSync(r.proj, { recursive: true, force: true });
  });
});
