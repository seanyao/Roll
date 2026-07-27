/**
 * US-CYCLE-004 — round-journal: append-only per-card ledger + readout.
 * Covers the "8 questions" durability contract: concurrent-safe append, bad-line
 * tolerance, schema-version tolerance, aggregation correctness, and .md derived
 * from jsonl (jsonl is the source of truth).
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROUND_JOURNAL_SCHEMA_VERSION,
  aggregateRounds,
  appendRoundEntry,
  appendRoundEntryAsync,
  deriveRounds,
  formatRoundReadout,
  readRoundEntries,
  renderRoundJournalMd,
  type RoundJournalInput,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function cardDir(): string {
  const d = mkdtempSync(join(tmpdir(), "roll-roundj-"));
  dirs.push(d);
  return d;
}
function entry(over: Partial<RoundJournalInput> = {}): RoundJournalInput {
  return { card: "US-X-1", round: 1, role: "builder", start: 1_000, durMs: 60_000, outcome: "delivered", ...over };
}

describe("appendRoundEntry / readRoundEntries", () => {
  it("appends a jsonl line stamped with the schema version and reads it back", () => {
    const dir = cardDir();
    expect(appendRoundEntry(dir, entry({ model: "glm", gateTimeMs: 5_000, era: "e1" }))).toBe(true);
    const { entries, skipped } = readRoundEntries(dir);
    expect(skipped).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.schemaVersion).toBe(ROUND_JOURNAL_SCHEMA_VERSION);
    expect(entries[0]).toMatchObject({ role: "builder", model: "glm", gateTimeMs: 5_000, era: "e1", outcome: "delivered" });
  });

  it("is append-only — many entries accumulate as distinct lines", () => {
    const dir = cardDir();
    for (let i = 1; i <= 5; i++) appendRoundEntry(dir, entry({ round: i, durMs: i * 1_000 }));
    const { entries } = readRoundEntries(dir);
    expect(entries.map((e) => e.round)).toEqual([1, 2, 3, 4, 5]);
    // Raw jsonl really has one line per entry (concurrency contract).
    const raw = readFileSync(join(dir, "round-journal.jsonl"), "utf8").trim().split("\n");
    expect(raw).toHaveLength(5);
  });

  it("tolerates malformed / half-written lines (skips + counts them)", () => {
    const dir = cardDir();
    appendRoundEntry(dir, entry({ round: 1 }));
    // Simulate a corrupt row + a half-written trailing line.
    appendFileSync(join(dir, "round-journal.jsonl"), "{not json}\n", "utf8");
    appendFileSync(join(dir, "round-journal.jsonl"), '{"card":"US-X-1","round":2', "utf8");
    appendRoundEntry(dir, entry({ round: 3 }));
    const { entries, skipped } = readRoundEntries(dir);
    expect(entries.map((e) => e.round).sort()).toEqual([1, 3]);
    expect(skipped).toBe(2);
  });

  it("tolerant reader keeps rows with an unknown/newer schemaVersion + extra fields", () => {
    const dir = cardDir();
    appendFileSync(
      join(dir, "round-journal.jsonl"),
      JSON.stringify({ schemaVersion: 999, card: "US-X-1", round: 1, role: "designer", start: 1, durMs: 42, outcome: "passed", futureField: "x" }) + "\n",
      "utf8",
    );
    const { entries, skipped } = readRoundEntries(dir);
    expect(skipped).toBe(0);
    expect(entries[0]?.role).toBe("designer");
    expect((entries[0] as Record<string, unknown>)["futureField"]).toBe("x");
  });

  it("never throws on an unwritable dir — returns false (best-effort, non-blocking)", () => {
    // A path whose parent is a file, not a dir → mkdir/append fail.
    const dir = cardDir();
    const filePath = join(dir, "afile");
    appendFileSync(filePath, "x", "utf8");
    expect(appendRoundEntry(join(filePath, "nested"), entry())).toBe(false);
  });

  it("append does NOT re-render .md on the hot path (non-blocking); render is on-demand", () => {
    const dir = cardDir();
    appendRoundEntry(dir, entry({ role: "evaluator", outcome: "passed", era: "e2" }));
    // Append keeps the hot path O(1): no .md rewrite.
    expect(existsSync(join(dir, "round-journal.md"))).toBe(false);
    // The readout regenerates it on demand from the jsonl source of truth.
    renderRoundJournalMd(dir, readRoundEntries(dir).entries);
    const md = readFileSync(join(dir, "round-journal.md"), "utf8");
    expect(md).toContain("| round | role |");
    expect(md).toContain("evaluator");
    expect(md).toContain("passed");
  });

  it("normalizes a corrupt shared field (e.g. era:number) so aggregation never crashes", () => {
    const dir = cardDir();
    appendFileSync(
      join(dir, "round-journal.jsonl"),
      JSON.stringify({ schemaVersion: 1, card: "US-X-1", round: 1, role: "builder", start: 1, durMs: 42, outcome: "delivered", era: 1 }) + "\n",
      "utf8",
    );
    const { entries } = readRoundEntries(dir);
    expect(entries[0]?.era).toBeUndefined(); // non-string era dropped
    // aggregate + readout must not throw on the corrupt row (era → "unknown" window).
    expect(() => formatRoundReadout(aggregateRounds(dir))).not.toThrow();
    expect(aggregateRounds(dir).byEra[0]?.era).toBe("unknown");
  });

  it("US-CYCLE-011: keeps a canonical gateMode and drops a corrupt one", () => {
    const dir = cardDir();
    const row = (gateMode: unknown): string =>
      JSON.stringify({ schemaVersion: 1, card: "US-X-1", role: "builder", start: 1, durMs: 5, outcome: "delivered", gateTimeMs: 10, gateMode }) + "\n";
    appendFileSync(join(dir, "round-journal.jsonl"), row("full") + row("changed") + row("bogus"), "utf8");
    const { entries } = readRoundEntries(dir);
    expect(entries.map((e) => e.gateMode)).toEqual(["full", "changed", undefined]);
  });
});

describe("appendRoundEntryAsync (non-blocking hot-path append) + deriveRounds", () => {
  it("appends asynchronously; round is DERIVED from cycleId (no stored round, no race)", async () => {
    const dir = cardDir();
    // Hot-path inputs carry NO round (recordSpawnRound omits it to avoid a racy
    // read-modify-write). Two cycles → two rounds; both c2 turns share c2's round.
    const noRound = (cycleId: string, role: string): RoundJournalInput => ({
      card: "US-X-1", role, start: 1_000, durMs: 60_000, outcome: "delivered", cycleId,
    });
    expect(await appendRoundEntryAsync(dir, noRound("c1", "builder"))).toBe(true);
    expect(await appendRoundEntryAsync(dir, noRound("c2", "builder"))).toBe(true);
    expect(await appendRoundEntryAsync(dir, noRound("c2", "evaluator"))).toBe(true);
    const { entries } = readRoundEntries(dir);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.round === undefined)).toBe(true);
    // The readout derives it: c1→1, c2→2 (both c2 turns share round 2).
    expect(deriveRounds(entries).map((e) => e.round)).toEqual([1, 2, 2]);
  });

  it("async half-line guard prevents a crash-truncated tail from corrupting the next row", async () => {
    const dir = cardDir();
    await appendRoundEntryAsync(dir, entry({ cycleId: "c1" }));
    appendFileSync(join(dir, "round-journal.jsonl"), '{"card":"US-X-1","cycleId":"c2"', "utf8"); // half line, no newline
    await appendRoundEntryAsync(dir, entry({ cycleId: "c3" }));
    const { entries, skipped } = readRoundEntries(dir);
    expect(entries.map((e) => e.cycleId)).toEqual(["c1", "c3"]);
    expect(skipped).toBe(1); // only the half line is lost
  });
});

describe("aggregateRounds", () => {
  it("computes median/mean/p90 and gate-share, split by era", () => {
    const dir = cardDir();
    // era e1: durs 10s,20s,30s,40s,50s (gate 5s each)
    for (let i = 1; i <= 5; i++) appendRoundEntry(dir, entry({ round: i, durMs: i * 10_000, gateTimeMs: 5_000, era: "e1", role: "builder" }));
    // era e2: one 100s turn, no gate
    appendRoundEntry(dir, entry({ round: 6, durMs: 100_000, era: "e2" }));
    const agg = aggregateRounds(dir);
    expect(agg.overall.count).toBe(6);
    const e1 = agg.byEra.find((e) => e.era === "e1");
    expect(e1?.count).toBe(5);
    expect(e1?.medianMs).toBe(30_000); // nearest-rank median of 10..50k
    expect(e1?.meanMs).toBe(30_000);
    expect(e1?.p90Ms).toBe(50_000);
    // gate share = 25s / 150s ≈ 0.1667
    expect(e1?.gateShare).toBeCloseTo(25 / 150, 3);
    const e2 = agg.byEra.find((e) => e.era === "e2");
    expect(e2?.gateShare).toBe(0);
    // byEra sorted by label
    expect(agg.byEra.map((e) => e.era)).toEqual(["e1", "e2"]);
  });

  it("entries without an era fall into the 'unknown' window", () => {
    const dir = cardDir();
    appendRoundEntry(dir, entry());
    const agg = aggregateRounds(dir);
    expect(agg.byEra[0]?.era).toBe("unknown");
  });

  it("formatRoundReadout surfaces overall + per-era + skipped count", () => {
    const dir = cardDir();
    appendRoundEntry(dir, entry({ era: "e1" }));
    appendFileSync(join(dir, "round-journal.jsonl"), "garbage\n", "utf8");
    const out = formatRoundReadout(aggregateRounds(dir));
    expect(out).toContain("overall:");
    expect(out).toContain("era e1:");
    expect(out).toContain("malformed");
  });

  it("empty card → zeroed stats, no throw", () => {
    const agg = aggregateRounds(cardDir());
    expect(agg.overall).toMatchObject({ count: 0, medianMs: 0, meanMs: 0, p90Ms: 0, gateShare: 0 });
    expect(agg.byEra).toEqual([]);
  });
});

describe("US-CYCLE-008 — tier + panel audit fields", () => {
  it("round-trips a declared tier + actual panel composition", () => {
    const dir = cardDir();
    expect(
      appendRoundEntry(dir, entry({ role: "evaluator", outcome: "scored", tier: "high", panel: ["kimi", "pi", "reasonix"] })),
    ).toBe(true);
    const { entries } = readRoundEntries(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tier).toBe("high");
    expect(entries[0]?.panel).toEqual(["kimi", "pi", "reasonix"]);
  });

  it("a low-tier evaluator records tier=low + its single panel member", () => {
    const dir = cardDir();
    appendRoundEntry(dir, entry({ role: "evaluator", outcome: "scored", tier: "low", panel: ["kimi"] }));
    const { entries } = readRoundEntries(dir);
    expect(entries[0]?.tier).toBe("low");
    expect(entries[0]?.panel).toEqual(["kimi"]);
  });

  it("forward-tolerant: a corrupt tier or non-string-array panel is dropped, the row survives", () => {
    const dir = cardDir();
    // Hand-write rows with corrupted tier/panel values (a forward-schema hazard).
    appendFileSync(
      join(dir, "round-journal.jsonl"),
      JSON.stringify({ schemaVersion: 1, card: "US-X-1", role: "evaluator", start: 1, durMs: 5, outcome: "scored", tier: "medium", panel: [1, 2] }) + "\n",
      "utf8",
    );
    appendFileSync(
      join(dir, "round-journal.jsonl"),
      JSON.stringify({ schemaVersion: 1, card: "US-X-1", role: "evaluator", start: 1, durMs: 5, outcome: "scored", tier: 3, panel: "kimi" }) + "\n",
      "utf8",
    );
    const { entries, skipped } = readRoundEntries(dir);
    expect(skipped).toBe(0); // rows are valid (role + durMs) — only the bad fields drop
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.tier).toBeUndefined();
      expect(e.panel).toBeUndefined();
    }
  });

  it("legacy rows without tier/panel read back unchanged (older schema tolerance)", () => {
    const dir = cardDir();
    appendRoundEntry(dir, entry({ role: "builder", outcome: "delivered" }));
    const { entries } = readRoundEntries(dir);
    expect(entries[0]?.tier).toBeUndefined();
    expect(entries[0]?.panel).toBeUndefined();
  });
});
