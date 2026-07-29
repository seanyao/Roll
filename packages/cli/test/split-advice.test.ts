/**
 * US-CYCLE-006 — run-time mis-sizing signal: a card that needed > threshold
 * repair rounds gets an automatic split-advice.md (from round-journal FACTS),
 * signal-only and idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRoundEntry } from "@roll/core";
import {
  REPAIR_ROUNDS_THRESHOLD,
  analyzeRepairRounds,
  listPendingSplitAdvice,
  renderSplitAdviceMd,
  writeSplitAdvice,
} from "../src/lib/split-advice.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uscycle006-"));
});
afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** A card dir whose round-journal has `rounds` distinct cycles (2 roles each). */
function cardWithRounds(rounds: number): string {
  const cardDir = join(tmp, "card");
  mkdirSync(cardDir, { recursive: true });
  for (let r = 1; r <= rounds; r++) {
    appendRoundEntry(cardDir, { card: "US-T", role: "builder", start: r * 1000, durMs: 100, outcome: "delivered", cycleId: `cyc-${r}` });
    appendRoundEntry(cardDir, { card: "US-T", role: "evaluator", start: r * 1000 + 1, durMs: 50, outcome: r === rounds ? "passed" : "refuted", cycleId: `cyc-${r}` });
  }
  return cardDir;
}

describe("analyzeRepairRounds — threshold", () => {
  it("returns null at/under the threshold (2 rounds ⇒ no advice)", () => {
    expect(analyzeRepairRounds(cardWithRounds(2), "US-T")).toBeNull();
  });
  it("returns advice above the threshold (3 rounds ⇒ advice from journal facts)", () => {
    const a = analyzeRepairRounds(cardWithRounds(3), "US-T");
    expect(a).not.toBeNull();
    expect(a?.roundCount).toBe(3);
    expect(a?.rounds).toHaveLength(3);
    // Facts, not model guess: the last round's evaluator outcome is 'passed'.
    expect(a?.rounds[2]?.roles.map((x) => x.outcome)).toContain("passed");
    expect(a?.rounds[0]?.roles.map((x) => x.outcome)).toContain("refuted");
  });
  it("empty journal ⇒ null", () => {
    const d = join(tmp, "empty");
    mkdirSync(d, { recursive: true });
    expect(analyzeRepairRounds(d, "US-T")).toBeNull();
  });
});

describe("renderSplitAdviceMd — facts-derived, deterministic", () => {
  it("names the round count, per-round outcomes, and a split suggestion", () => {
    const a = analyzeRepairRounds(cardWithRounds(3), "US-T")!;
    const md = renderSplitAdviceMd(a);
    expect(md).toContain("Split advice — US-T");
    expect(md).toContain("ran **3 rounds**");
    expect(md).toContain("round 1: builder→delivered, evaluator→refuted");
    expect(md).toContain("Suggested split");
    // Deterministic: same input → identical bytes.
    expect(renderSplitAdviceMd(a)).toBe(md);
  });
});

describe("writeSplitAdvice — idempotent (重跑不重复)", () => {
  it("writes once, then leaves the file untouched on re-run", () => {
    const cardDir = cardWithRounds(3);
    const a = analyzeRepairRounds(cardDir, "US-T")!;
    const first = writeSplitAdvice(cardDir, a);
    expect(first.written).toBe(true);
    expect(existsSync(first.path)).toBe(true);
    const bytes = readFileSync(first.path, "utf8");
    const second = writeSplitAdvice(cardDir, a);
    expect(second.written).toBe(false); // idempotent — no duplicate
    expect(readFileSync(second.path, "utf8")).toBe(bytes); // unchanged
  });

  it("rewrites when the journal grew (round count changed)", () => {
    const cardDir = cardWithRounds(3);
    writeSplitAdvice(cardDir, analyzeRepairRounds(cardDir, "US-T")!);
    // A 4th round lands → content changes → rewrite.
    appendRoundEntry(cardDir, { card: "US-T", role: "builder", start: 5000, durMs: 100, outcome: "delivered", cycleId: "cyc-4" });
    const a2 = analyzeRepairRounds(cardDir, "US-T")!;
    expect(a2.roundCount).toBe(4);
    expect(writeSplitAdvice(cardDir, a2).written).toBe(true);
  });
});

describe("listPendingSplitAdvice — signal-only readout", () => {
  it("lists cards carrying a split-advice.md under .roll/features", () => {
    const repo = tmp;
    const cardDir = join(repo, ".roll", "features", "eff", "US-P");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "split-advice.md"), "# Split advice — US-P\n");
    const pending = listPendingSplitAdvice(repo);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.card).toBe("US-P");
    expect(pending[0]?.epic).toBe("eff");
    expect(pending[0]?.path).toContain("split-advice.md");
  });
  it("empty when no advice files exist", () => {
    expect(listPendingSplitAdvice(tmp)).toHaveLength(0);
  });
});

describe("threshold constant", () => {
  it("is 2 (a 3-round card trips it)", () => {
    expect(REPAIR_ROUNDS_THRESHOLD).toBe(2);
  });
});
