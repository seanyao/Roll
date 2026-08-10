/**
 * US-PAIR-016 — the effort view. The load-bearing behaviour is what it REFUSES to
 * report: a thin cell gets no rate, and unobservable cost never joins the sum.
 */
import { describe, expect, it } from "vitest";
import type { RollEvent } from "@roll/spec";
import { MIN_SAMPLES_FOR_RATE, effortView } from "../src/observe/effort-view.js";

const selected = (cycleId: string, peer: string, achievedTier: string, degradedFrom?: string): RollEvent =>
  ({
    type: "pair:selected",
    cycleId,
    workingAgent: "kimi",
    peer,
    stage: "code",
    achievedTier,
    ...(degradedFrom !== undefined ? { degradedFrom } : {}),
    ts: 1,
  }) as RollEvent;

const verdict = (
  cycleId: string,
  peer: string,
  findings: number,
  cost = 0,
  costBasis?: "estimated" | "unobservable",
  modelMismatch?: string,
): RollEvent =>
  ({
    type: "pair:verdict",
    cycleId,
    peer,
    verdict: findings > 0 ? "refine" : "agree",
    findings,
    cost,
    ...(costBasis !== undefined ? { costBasis } : {}),
    ...(modelMismatch !== undefined ? { modelMismatch } : {}),
    stage: "code",
    ts: 2,
  }) as RollEvent;

/** n paired selection+verdict events in one tier; `hits` of them find something. */
function run(tier: string, n: number, hits: number): RollEvent[] {
  const out: RollEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(selected(`c${tier}${i}`, "codex", tier));
    out.push(verdict(`c${tier}${i}`, "codex", i < hits ? 2 : 0, 0.01, "estimated"));
  }
  return out;
}

describe("US-PAIR-016 — a thin cell reports counts, never a rate", () => {
  it("withholds hitRate below the sample floor and names the cell", () => {
    const view = effortView(run("vendor", 3, 3));
    const cell = view.cells[0];
    expect(cell?.samples).toBe(3);
    expect(cell?.hits).toBe(3);
    expect(cell?.hitRate, "3 samples is not a trend").toBeUndefined();
    expect(view.insufficientCells).toEqual([{ gate: "code", achievedTier: "vendor", samples: 3 }]);
  });

  it("reports a rate once the floor is reached", () => {
    const view = effortView(run("vendor", MIN_SAMPLES_FOR_RATE, 5));
    expect(view.cells[0]?.hitRate).toBeCloseTo(0.5, 6);
    expect(view.insufficientCells).toEqual([]);
  });

  it("an empty stream yields no cells — not a 0% cell", () => {
    const view = effortView([]);
    expect(view.cells).toEqual([]);
    expect(view.insufficientCells).toEqual([]);
  });
});

describe("US-PAIR-016 — observable and unobservable cost stay separate", () => {
  it("only measured costs join the sum; the rest are counted", () => {
    const events: RollEvent[] = [
      selected("c1", "codex", "vendor"),
      verdict("c1", "codex", 1, 0.05, "estimated"),
      selected("c2", "kimi", "vendor"),
      verdict("c2", "kimi", 0, 0, "unobservable"),
      selected("c3", "pi", "vendor"),
      verdict("c3", "pi", 0, 0), // legacy row: no basis at all
    ];
    const cell = effortView(events).cells[0];
    expect(cell?.samples).toBe(3);
    expect(cell?.observedCostUsd).toBeCloseTo(0.05, 6);
    expect(cell?.unobservableCostRows, "legacy + explicit unobservable").toBe(2);
  });
});

describe("US-PAIR-016 — tiers are joined, never assumed", () => {
  it("splits cells by the ACHIEVED tier", () => {
    const view = effortView([...run("vendor", 2, 2), ...run("session", 3, 0)]);
    expect(view.cells.map((c) => [c.achievedTier, c.samples])).toEqual([
      ["session", 3],
      ["vendor", 2],
    ]);
  });

  it("a verdict with no recorded tier is counted apart, not bucketed", () => {
    // Pre-US-PAIR-020 history has no achievedTier — inventing one would fabricate
    // the very signal this view exists to measure.
    const view = effortView([verdict("orphan", "codex", 1, 0.01, "estimated")]);
    expect(view.cells).toEqual([]);
    expect(view.untieredSamples).toBe(1);
  });

  it("counts degradations and model mismatches per cell", () => {
    const events: RollEvent[] = [
      selected("d1", "reasonix", "session", "vendor"),
      verdict("d1", "reasonix", 0, 0, "unobservable", "configured X but observed Y"),
      selected("d2", "reasonix", "session", "vendor"),
      verdict("d2", "reasonix", 1, 0, "unobservable"),
    ];
    const cell = effortView(events).cells[0];
    expect(cell?.degraded).toBe(2);
    expect(cell?.modelMismatches).toBe(1);
  });
});
