/**
 * US-PAIR-016 — `roll effort` CLI surface. Read-only, and honest about what it
 * cannot conclude.
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EFFORT_USAGE, effortCommand, renderEffortView } from "../src/commands/effort.js";

function project(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "roll-effort-"));
  const loop = join(root, ".roll", "loop");
  mkdirSync(loop, { recursive: true });
  writeFileSync(join(loop, "events.ndjson"), lines.map((l) => `${l}\n`).join(""), "utf8");
  return root;
}

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const sel = (cycle: string, peer: string, tier: string, degradedFrom?: string): string =>
  JSON.stringify({
    type: "pair:selected",
    cycleId: cycle,
    workingAgent: "kimi",
    peer,
    stage: "code",
    achievedTier: tier,
    ...(degradedFrom !== undefined ? { degradedFrom } : {}),
    ts: 1_780_000_000_000,
  });
const ver = (cycle: string, peer: string, findings: number, cost: number, basis: string): string =>
  JSON.stringify({
    type: "pair:verdict",
    cycleId: cycle,
    peer,
    verdict: findings > 0 ? "refine" : "agree",
    findings,
    cost,
    costBasis: basis,
    stage: "code",
    ts: 1_780_000_001_000,
  });

describe("roll effort — read-only and honest", () => {
  it("says so plainly when nothing carries a tier yet", () => {
    const root = project([ver("c1", "codex", 1, 0.01, "estimated")]);
    expect(effortCommand([], root)).toBe(0);
    const text = out.join("");
    expect(text).toContain("No dispatch carries an achieved isolation tier yet");
    // The untiered verdict is DISCLOSED, not silently dropped.
    expect(text).toContain("1 verdict(s) predate tier recording");
  });

  it("renders a cell but withholds the rate on a thin sample", () => {
    const root = project([sel("c1", "codex", "vendor"), ver("c1", "codex", 2, 0.02, "estimated")]);
    expect(effortCommand([], root)).toBe(0);
    const text = out.join("");
    expect(text).toContain("vendor");
    expect(text).toContain("n/a"); // no rate on 1 sample
    expect(text).toContain("Insufficient sample");
  });

  it("keeps unobservable spend visible instead of calling it free", () => {
    const root = project([sel("c1", "kimi", "vendor"), ver("c1", "kimi", 0, 0, "unobservable")]);
    effortCommand([], root);
    const text = out.join("");
    expect(text).toContain("NOT zero-cost");
  });

  it("--json emits the structured view", () => {
    const root = project([sel("c1", "codex", "vendor"), ver("c1", "codex", 1, 0.02, "estimated")]);
    expect(effortCommand(["--json"], root)).toBe(0);
    const parsed = JSON.parse(out.join("")) as { cells: { achievedTier: string; hitRate?: number }[] };
    expect(parsed.cells[0]?.achievedTier).toBe("vendor");
    expect(parsed.cells[0]?.hitRate, "1 sample must not get a rate").toBeUndefined();
  });

  it("--help prints usage and exits 0", () => {
    expect(effortCommand(["--help"], project([]))).toBe(0);
    expect(out.join("")).toBe(EFFORT_USAGE);
  });

  it("rejects an unknown argument", () => {
    expect(effortCommand(["--nope"], project([]))).toBe(2);
    expect(err.join("")).toContain("unknown argument");
  });

  it("writes nothing to the project (read-only)", () => {
    const root = project([sel("c1", "codex", "vendor"), ver("c1", "codex", 1, 0.02, "estimated")]);
    const before = readdirSync(join(root, ".roll", "loop")).sort();
    effortCommand([], root);
    effortCommand(["--json"], root);
    expect(readdirSync(join(root, ".roll", "loop")).sort()).toEqual(before);
  });

  it("renderEffortView is pure and handles the empty view", () => {
    const text = renderEffortView({ cells: [], insufficientCells: [], untieredSamples: 0 });
    expect(text).toContain("No dispatch carries an achieved isolation tier yet");
  });
});
