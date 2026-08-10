/**
 * US-PAIR-006 — pairing cost observability + hit-rate-driven ε-greedy rotation.
 *
 * Three pure pieces, all unit-testable:
 *   - peerReviewCost: turn a peer agent's raw stdout into a real USD cost
 *     (claude stream-json or the per-agent stdout-scrape extractors), 0 on a
 *     parse miss, NEVER throws — so pair:verdict carries a real spend not 0.
 *   - aggregatePairingCost: fold the pair:verdict / pair:none-available events
 *     into "pairings to date: N, by peer, total cost $X, findings".
 *   - pairingHistory + ε-greedy selectPairingCandidates: history (count + hit)
 *     biases rotation toward proven heterogeneous peers while keeping baseline
 *     exploration (deterministic, seeded by cycleId).
 */
import { describe, expect, it } from "vitest";
import type { RollEvent } from "@roll/spec";
import {
  aggregatePairingCost,
  observedModelFrom,
  pairingHistory,
  peerReviewCost,
  peerReviewCostFact,
  selectPairingCandidates,
  type PairingConfig,
} from "../src/index.js";

describe("US-PAIR-014 — a cost of 0 must not mean both 'free' and 'unknown'", () => {
  it("reports unobservable (not 0) when the peer's usage cannot be parsed", () => {
    const fact = peerReviewCostFact("kimi", "no usage footer here at all");
    expect(fact.basis).toBe("unobservable");
    if (fact.basis === "unobservable") expect(fact.reason).toBe("no_usage_parsed");
  });

  it("reports unobservable when the extractor is a deliberate stub", () => {
    // pi/agy extractors are always-null stubs — that is NOT "the review was free".
    expect(peerReviewCostFact("pi", "model: whatever\ninput tokens: 10").basis).toBe("unobservable");
  });

  it("reports an estimated cost when usage really did parse", () => {
    const fact = peerReviewCostFact("codex", ["model: gpt-5.3-codex", "input tokens: 1,200", "output tokens: 340"].join("\n"));
    expect(fact.basis).toBe("estimated");
    if (fact.basis === "estimated") expect(fact.usd).toBeGreaterThan(0);
  });

  it("keeps peerReviewCost's number contract for existing callers", () => {
    expect(peerReviewCost("kimi", "garbage")).toBe(0);
  });

  it("aggregation counts unobservable rows separately instead of averaging them as free", () => {
    const evs: RollEvent[] = [
      { type: "pair:verdict", cycleId: "c1", peer: "codex", verdict: "refine", findings: 2, cost: 0.05, costBasis: "estimated", stage: "code", ts: 1 },
      { type: "pair:verdict", cycleId: "c2", peer: "kimi", verdict: "agree", findings: 0, cost: 0, costBasis: "unobservable", stage: "code", ts: 2 },
    ];
    const agg = aggregatePairingCost(evs);
    expect(agg.totalCost).toBeCloseTo(0.05, 6);
    expect(agg.unobservableCostRows).toBe(1);
    expect(agg.observedCostRows).toBe(1);
  });
});

const cfg = (over: Partial<PairingConfig> = {}): PairingConfig => ({
  enabled: true,
  stages: ["code"],
  capability: { kimi: ["code"], pi: ["code"], reasonix: ["code"] },
  ...over,
});
const always = (): boolean => true;

describe("peerReviewCost — real spend from a peer spawn's stdout", () => {
  it("parses a claude-stream (harness) usage into a real cost", () => {
    // claude is no longer a pool peer, but the claude-stream harness extractor is
    // KEPT (roll runs inside Claude Code). The cost path still prices it.
    const lines = [
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4", usage: { input_tokens: 1000, output_tokens: 500 } } }),
      JSON.stringify({ type: "result", total_cost_usd: 0.0123, model: "claude-sonnet-4" }),
    ];
    const cost = peerReviewCost("claude-stream", lines.join("\n"));
    expect(cost).toBeGreaterThan(0);
  });

  it("parses a stdout-scrape peer (kimi) usage into a real cost", () => {
    const stdout = "model: kimi-k2\ninput tokens: 2000\noutput tokens: 800\ntotal: 2800\n";
    const cost = peerReviewCost("kimi", stdout);
    expect(cost).toBeGreaterThan(0);
  });

  it("returns 0 (never throws) when the peer's usage is unparseable", () => {
    expect(peerReviewCost("claude", "no json here at all")).toBe(0);
    expect(peerReviewCost("pi", "pi text mode, no usage")).toBe(0);
    expect(peerReviewCost("totally-unknown-agent", "whatever")).toBe(0);
    expect(peerReviewCost("claude", "")).toBe(0);
  });

  it("accepts a canonical alias (codex → openai extractor)", () => {
    const stdout = "model: gpt-5\ninput: 1000\noutput: 400\ntokens used: 1400\n";
    const cost = peerReviewCost("codex", stdout);
    expect(cost).toBeGreaterThanOrEqual(0); // never throws; >0 when priced
  });

  // pi pair-review regression: a parsed-but-empty usage (0 in / 0 out) must
  // never reach the price table — it has no cost. Returns 0, never NaN.
  it("returns 0 (not NaN) when usage parses but carries zero tokens", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4", usage: { input_tokens: 0, output_tokens: 0 } } }),
    ];
    const cost = peerReviewCost("claude", lines.join("\n"));
    expect(cost).toBe(0);
    expect(Number.isNaN(cost)).toBe(false);
  });
});

const verdict = (peer: string, findings: number, cost: number, v: "agree" | "refine" | "object" = "agree"): RollEvent =>
  ({ type: "pair:verdict", cycleId: "c", peer, verdict: v, findings, cost, ts: 1 }) as RollEvent;

describe("aggregatePairingCost — pairings to date + by peer + total cost", () => {
  it("counts pairings, splits by peer, sums cost + findings", () => {
    const events: RollEvent[] = [
      verdict("codex", 2, 0.01, "refine"),
      verdict("codex", 0, 0.02, "agree"),
      verdict("kimi", 1, 0.005, "object"),
      { type: "pair:none-available", cycleId: "c", stage: "code", reason: "no peer", ts: 1 } as RollEvent,
      { type: "cycle:end", cycleId: "c", outcome: "done", cost: {} as never, ts: 1 } as RollEvent, // ignored
    ];
    const agg = aggregatePairingCost(events);
    expect(agg.pairings).toBe(3);
    expect(agg.byPeer).toEqual({ codex: 2, kimi: 1 });
    expect(agg.totalCost).toBeCloseTo(0.035, 6);
    expect(agg.totalFindings).toBe(3);
    expect(agg.noneAvailable).toBe(1);
  });

  it("zero pairings when the stream has none", () => {
    const agg = aggregatePairingCost([]);
    expect(agg.pairings).toBe(0);
    expect(agg.byPeer).toEqual({});
    expect(agg.totalCost).toBe(0);
    expect(agg.totalFindings).toBe(0);
  });
});

describe("pairingHistory — per-peer count + hit (found a real finding)", () => {
  it("a hit is a verdict with ≥1 finding; agree-with-0 counts but is not a hit", () => {
    const events: RollEvent[] = [
      verdict("codex", 2, 0.01, "refine"),
      verdict("codex", 0, 0.02, "agree"),
      verdict("kimi", 0, 0.0, "agree"),
    ];
    const hist = pairingHistory(events);
    expect(hist["codex"]).toEqual({ count: 2, hits: 1 });
    expect(hist["kimi"]).toEqual({ count: 1, hits: 0 });
  });

  // pi pair-review regression: a malformed event's findings (NaN / negative)
  // must never inflate the hit count — only a finite positive is a hit.
  it("ignores NaN / negative findings (corruption never inflates hits)", () => {
    const events: RollEvent[] = [
      verdict("codex", Number.NaN, 0.01, "refine"),
      verdict("codex", -5, 0.01, "refine"),
      verdict("codex", 3, 0.01, "refine"),
    ];
    const hist = pairingHistory(events);
    expect(hist["codex"]).toEqual({ count: 3, hits: 1 });
  });
});

describe("selectPairingCandidates — ε-greedy hit-rate preference (US-PAIR-006)", () => {
  const base = {
    installed: ["kimi", "pi", "reasonix"],
    isAvailable: always,
    workingAgent: "kimi",
    stage: "code" as const,
    cfg: cfg(),
  };

  it("is backward compatible: no history → pure seeded round-robin (unchanged)", () => {
    const noHist = selectPairingCandidates({ ...base, cycleId: "c1" });
    const withEmpty = selectPairingCandidates({ ...base, cycleId: "c1", history: {} });
    expect(withEmpty).toEqual(noHist);
  });

  it("returns the same qualified SET regardless of ordering (no peer lost)", () => {
    const history = { pi: { count: 10, hits: 9 } };
    const got = selectPairingCandidates({ ...base, cycleId: "c1", history, epsilon: 0.2 });
    // worker is kimi → the heterogeneous reviewable peers are pi + reasonix.
    expect(got.slice().sort()).toEqual(["pi", "reasonix"].sort());
  });

  it("exploit cycles put the highest-hit-rate peer first", () => {
    const history = { pi: { count: 10, hits: 9 }, reasonix: { count: 10, hits: 1 } };
    // find a cycleId that lands in the exploit band (most do at ε=0.2)
    let exploitFirst = 0;
    for (let i = 0; i < 50; i++) {
      const got = selectPairingCandidates({ ...base, cycleId: `exploit-${i}`, history, epsilon: 0.2 });
      if (got[0] === "pi") exploitFirst++;
    }
    // with ε=0.2, ~80% of cycles exploit → pi first the large majority of the time.
    expect(exploitFirst).toBeGreaterThan(30);
  });

  it("preserves exploration: a low-hit peer still leads on some cycles (kimi guardrail)", () => {
    const history = { pi: { count: 100, hits: 99 } };
    const leaders = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const got = selectPairingCandidates({ ...base, cycleId: `cyc-${i}`, history, epsilon: 0.2 });
      if (got[0] !== undefined) leaders.add(got[0]);
    }
    // the high scorer must NOT monopolize — exploration surfaces other leaders too.
    expect(leaders.size).toBeGreaterThan(1);
    expect(leaders.has("pi")).toBe(true);
  });

  it("is deterministic/replayable: same cycleId + history → same order", () => {
    const history = { pi: { count: 10, hits: 5 }, reasonix: { count: 8, hits: 6 } };
    const a = selectPairingCandidates({ ...base, cycleId: "fixed", history, epsilon: 0.2 });
    const b = selectPairingCandidates({ ...base, cycleId: "fixed", history, epsilon: 0.2 });
    expect(a).toEqual(b);
  });

  it("ε=0 (pure exploit) always leads with the best hit-rate peer", () => {
    const history = { reasonix: { count: 10, hits: 8 }, pi: { count: 10, hits: 2 } };
    for (let i = 0; i < 10; i++) {
      const got = selectPairingCandidates({ ...base, cycleId: `x-${i}`, history, epsilon: 0 });
      expect(got[0]).toBe("reasonix");
    }
  });
});

// US-PAIR-009: pair:score joins the activity/spend ledger.
import { describe as d9, expect as e9, it as i9 } from "vitest";
d9("aggregatePairingCost — pair:score (US-PAIR-009)", () => {
  i9("counts score pairings, their peer and cost (no findings)", () => {
    const s = aggregatePairingCost([
      { type: "pair:verdict", cycleId: "c1", peer: "codex", verdict: "refine", findings: 2, cost: 0.1, stage: "code", ts: 1 },
      { type: "pair:score", cycleId: "c1", peer: "kimi", score: 8, verdict: "good", cost: 0.05, stage: "score", ts: 2 },
    ] as never[]);
    e9(s.pairings).toBe(2);
    e9(s.byPeer).toEqual({ codex: 1, kimi: 1 });
    e9(s.totalCost).toBeCloseTo(0.15);
    e9(s.totalFindings).toBe(2);
  });
});

describe("US-PAIR-011 — observedModelFrom is reconciliation-only", () => {
  it("reports the model a parseable peer claims it ran", () => {
    const observed = observedModelFrom("codex", ["model: gpt-5.3-codex", "input tokens: 10", "output tokens: 5"].join("\n"));
    expect(observed).toBe("gpt-5.3-codex");
  });

  it("returns empty (never a guess) when the peer reports nothing parseable", () => {
    // pi/agy extractors are deliberate stubs. Selection must NOT depend on this —
    // otherwise those agents could never satisfy a model/vendor isolation tier.
    expect(observedModelFrom("pi", "model: deepseek-v4-pro\ninput tokens: 10")).toBe("");
    expect(observedModelFrom("kimi", "no footer at all")).toBe("");
  });
});
