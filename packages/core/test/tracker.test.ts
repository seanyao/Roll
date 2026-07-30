/**
 * Unit tests for the CostTracker pure folding logic that has no bash/py oracle:
 * `toCycleCost` (CycleCost record per spec cycle.ts, effectiveCost includes
 * reverts) and `aggregateSessions` (the SUM loop + zero-token "n/a, not fake
 * zero" rule).
 */
import { describe, expect, it } from "vitest";
import { AGENT_SPECS, type UsageExtractorKind } from "../src/agent/specs.js";
import {
  REGISTRY,
  type AgentUsage,
  type SessionAgg,
  aggregateSessions,
  cycleCurrency,
  extractUsage,
  sumClaudeStream,
  toCycleCost,
} from "../src/index.js";

describe("US-PAIR-014 — every declared extractor kind must actually exist", () => {
  // codex declares `stdoutExtractor: "openai"` in AGENT_SPECS, but REGISTRY had
  // no "openai" entry — so extractUsage("codex", …) hit `undefined` and returned
  // null on every call, making codex's cost STRUCTURALLY always 0. The loose
  // `Record<string, Extractor>` type meant the compiler could not see the hole.
  it("registers an extractor for every kind an agent declares", () => {
    const declared = new Set<UsageExtractorKind>();
    for (const spec of Object.values(AGENT_SPECS)) {
      const kind = spec.usage.stdoutExtractor;
      if (kind !== undefined) declared.add(kind);
    }
    const missing = [...declared].filter((kind) => REGISTRY[kind] === undefined);
    expect(missing, `declared but unimplemented extractor kinds: ${missing.join(", ")}`).toEqual([]);
  });

  it("extracts codex usage instead of silently returning null", () => {
    // TOTAL_RE_OPENAI matches codex's "tokens used:" line.
    const usage = extractUsage("codex", ["model: gpt-5.3-codex", "input tokens: 1,200", "output tokens: 340"]);
    expect(usage, "codex usage must parse — a null here is how cost became 0").not.toBeNull();
    expect(usage?.input_tokens).toBe(1200);
    expect(usage?.output_tokens).toBe(340);
  });
});

describe("toCycleCost", () => {
  const usage: AgentUsage = {
    model: "gpt-4o",
    input_tokens: 100,
    output_tokens: 50,
    cost_list_usd: 0.2,
    duration_ms: null,
  };

  it("zero reverts → effectiveCost == estimatedCost", () => {
    const c = toCycleCost(usage, { cycleId: "cyc-1", agent: "openai", revertCount: 0 });
    expect(c.estimatedCost).toBe(0.2);
    expect(c.effectiveCost).toBe(0.2);
    expect(c.tokensIn).toBe(100);
    expect(c.tokensOut).toBe(50);
    expect(c.model).toBe("gpt-4o");
    expect(c.agent).toBe("openai");
    expect(c.cycleId).toBe("cyc-1");
    expect(c.revertCount).toBe(0);
  });

  it("reverts inflate effectiveCost = estimated × (reverts + 1)", () => {
    const c = toCycleCost(usage, { cycleId: "cyc-2", agent: "openai", revertCount: 3 });
    expect(c.estimatedCost).toBe(0.2);
    expect(c.effectiveCost).toBeCloseTo(0.8, 6);
    expect(c.revertCount).toBe(3);
  });

  it("negative revertCount is clamped to 0", () => {
    const c = toCycleCost(usage, { cycleId: "c", agent: "a", revertCount: -5 });
    expect(c.revertCount).toBe(0);
    expect(c.effectiveCost).toBe(0.2);
  });

  // FIX-249: cache token split must survive into the CycleCost record — the
  // runs row writes it; without it the dashboard can't show real usage and the
  // budget ledger under-counts cache-heavy cycles.
  it("FIX-249: cache read/write tokens ride into CycleCost", () => {
    const withCache: AgentUsage = {
      model: "deepseek-v4-pro",
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 3000,
      cache_creation_tokens: 400,
    };
    const c = toCycleCost(withCache, { cycleId: "c", agent: "pi", revertCount: 0 });
    expect(c.cacheRead).toBe(3000);
    expect(c.cacheWrite).toBe(400);
  });

  it("FIX-249: no cache fields in usage → cache fields absent (not fake zeros)", () => {
    const c = toCycleCost(usage, { cycleId: "c", agent: "openai", revertCount: 0 });
    expect(c.cacheRead).toBeUndefined();
    expect(c.cacheWrite).toBeUndefined();
  });

  it("computes cost from tokens when adapter gave no cost_list_usd", () => {
    const noCost: AgentUsage = { model: "gpt-4o", input_tokens: 1_000_000, output_tokens: 0 };
    const c = toCycleCost(noCost, { cycleId: "c", agent: "openai", revertCount: 0 });
    // gpt-4o is unknown in the frozen snapshots → default-model fallback; just
    // assert a finite non-negative number and effective == estimated (0 reverts).
    expect(Number.isFinite(c.estimatedCost)).toBe(true);
    expect(c.estimatedCost).toBeGreaterThanOrEqual(0);
    expect(c.effectiveCost).toBe(c.estimatedCost);
  });

  // FIX-1259: a usage whose adapter could not read the model (empty) is
  // backfilled from the SPAWN model — the same value cycle:start records — so
  // runs.jsonl agrees with cycle:start instead of a source-baked guess.
  it("FIX-1259: empty usage model is backfilled from facts.spawnModel", () => {
    const reasonix: AgentUsage = {
      model: "", // reasonix footer carries no model
      input_tokens: 165_907,
      output_tokens: 697,
      cost_list_usd: 0.0049,
      currency: "CNY",
    };
    const c = toCycleCost(reasonix, {
      cycleId: "cyc",
      agent: "reasonix",
      revertCount: 0,
      spawnModel: "deepseek-v4-pro",
    });
    expect(c.model).toBe("deepseek-v4-pro");
    expect(c.currency).toBe("CNY"); // adapter-parsed currency still wins
    expect(c.estimatedCost).toBeCloseTo(0.0049, 6);
  });

  it("FIX-1259: a parsed model is NOT overridden by the spawn model", () => {
    const c = toCycleCost(usage, {
      cycleId: "cyc",
      agent: "openai",
      revertCount: 0,
      spawnModel: "some-other-model",
    });
    expect(c.model).toBe("gpt-4o");
  });

  it("FIX-1259: empty model with no spawn model stays empty (never a source-baked default)", () => {
    const c = toCycleCost(
      { model: "", input_tokens: 10, output_tokens: 5, cost_list_usd: 0.01 },
      { cycleId: "cyc", agent: "reasonix", revertCount: 0 },
    );
    expect(c.model).toBe("");
  });

  it("FIX-1259: the backfilled spawn model prices the cost when the adapter gave none", () => {
    // No cost_list_usd + empty adapter model → cost is priced from the spawn
    // model via the price table (deepseek is CNY-billed at ¥3/M input).
    const c = toCycleCost(
      { model: "", input_tokens: 1_000_000, output_tokens: 0 },
      { cycleId: "cyc", agent: "pi", revertCount: 0, spawnModel: "deepseek-v4-pro" },
    );
    expect(c.model).toBe("deepseek-v4-pro");
    expect(c.currency).toBe("CNY");
    expect(c.estimatedCost).toBeCloseTo(3, 4);
  });
});

describe("aggregateSessions", () => {
  const a: SessionAgg = {
    model: "deepseek-v4-pro",
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_tokens: 10,
    cache_read_tokens: 5,
    cost_reported: 0.1,
  };
  const b: SessionAgg = {
    model: "other",
    input_tokens: 200,
    output_tokens: 80,
    cache_creation_tokens: 0,
    cache_read_tokens: 20,
    cost_reported: 0.3,
  };

  it("sums tokens, first non-null model wins, cost_reported sums", () => {
    const agg = aggregateSessions([a, b], "fallback");
    expect(agg).not.toBeNull();
    expect(agg?.model).toBe("deepseek-v4-pro");
    expect(agg?.input_tokens).toBe(300);
    expect(agg?.output_tokens).toBe(130);
    expect(agg?.cache_creation_tokens).toBe(10);
    expect(agg?.cache_read_tokens).toBe(25);
    expect(agg?.cost_reported).toBeCloseTo(0.4, 6);
  });

  it("all-null → null", () => {
    expect(aggregateSessions([null, null], "fb")).toBeNull();
  });

  it("zero tokens across all files → null (n/a, not fake zero)", () => {
    const zero: SessionAgg = {
      model: "m",
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cost_reported: 0,
    };
    expect(aggregateSessions([zero], "fb")).toBeNull();
  });

  it("fills a still-null model with the default on success", () => {
    const noModel: SessionAgg = { ...a, model: null };
    const agg = aggregateSessions([noModel], "the-default");
    expect(agg?.model).toBe("the-default");
  });
});

describe("sumClaudeStream — claude stream-json usage accumulation", () => {
  // Mirror the real claude --output-format stream-json wire shape: assistant
  // `message.usage` per turn (result.usage is last-turn only, so loop-fmt
  // accumulates across turns) + a final `result` carrying total_cost_usd.
  const lines = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 200,
        },
      },
    }),
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.1234, duration_ms: 9000 }),
  ];

  it("accumulates tokens across every assistant turn (not just the last)", () => {
    const u = sumClaudeStream(lines);
    expect(u).not.toBeNull();
    expect(u?.input_tokens).toBe(150);
    expect(u?.output_tokens).toBe(60);
    expect(u?.cache_creation_tokens).toBe(10);
    expect(u?.cache_read_tokens).toBe(205);
    expect(u?.model).toBe("claude-opus-4-8");
    // claude's self-reported cost is carried for audit (price-table cost is the
    // authoritative number toCycleCost computes downstream).
    expect(u?.cost_reported).toBeCloseTo(0.1234, 6);
  });

  it("feeds toCycleCost to a numeric, finite estimatedCost", () => {
    const u = sumClaudeStream(lines);
    expect(u).not.toBeNull();
    const c = toCycleCost(u as AgentUsage, { cycleId: "cyc-claude", agent: "claude", revertCount: 0 });
    expect(Number.isFinite(c.estimatedCost)).toBe(true);
    expect(c.tokensIn).toBe(150);
    expect(c.tokensOut).toBe(60);
    expect(c.model).toBe("claude-opus-4-8");
  });

  it("no assistant usage block → null (n/a, never fake zero)", () => {
    expect(sumClaudeStream([JSON.stringify({ type: "result", total_cost_usd: 0 })])).toBeNull();
    expect(sumClaudeStream([])).toBeNull();
    expect(sumClaudeStream(["not json", ""])).toBeNull();
  });
});


describe("FIX-303: cost computed in each agent's native currency", () => {
  it("codex (gpt-5.5) prices in USD, kimi (kimi-k2.6) prices in CNY", () => {
    // Same component split, different agent → different unit price AND currency.
    const codex: AgentUsage = {
      model: "gpt-5.5",
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
    const kimi: AgentUsage = {
      model: "kimi-k2.6",
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
    const cCodex = toCycleCost(codex, { cycleId: "x", agent: "codex", revertCount: 0 });
    const cKimi = toCycleCost(kimi, { cycleId: "y", agent: "kimi", revertCount: 0 });
    expect(cCodex.estimatedCost).toBeCloseTo(5, 4); // $5/M input
    expect(cKimi.estimatedCost).toBeCloseTo(6.5, 4); // ¥6.5/M input
    expect(cycleCurrency(cCodex.model)).toBe("USD");
    expect(cycleCurrency(cKimi.model)).toBe("CNY");
  });

  it("the cache-read component is priced separately from cache-miss input", () => {
    // gpt-5.5: input $5/M, cache_read $0.50/M → 1M cache-read = $0.50, not $5.
    const cacheHeavy: AgentUsage = {
      model: "gpt-5.5",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 1_000_000,
      cache_creation_tokens: 0,
    };
    const c = toCycleCost(cacheHeavy, { cycleId: "z", agent: "codex", revertCount: 0 });
    expect(c.estimatedCost).toBeCloseTo(0.5, 4);
  });
});

describe("FIX-361: currency threaded through CycleCost", () => {
  it("a CNY-billed model (deepseek) carries currency=CNY", () => {
    const usage: AgentUsage = {
      model: "deepseek-v4-pro",
      input_tokens: 246_000,
      output_tokens: 0,
    };
    const c = toCycleCost(usage, { cycleId: "cny-test", agent: "pi", revertCount: 0 });
    expect(c.currency).toBe("CNY");
    // estimatedCost ≈ 246000/1e6 * 3 = 0.738 (¥)
    expect(c.estimatedCost).toBeCloseTo(0.738, 3);
  });

  it("a USD-billed model (claude) carries currency=USD", () => {
    const usage: AgentUsage = {
      model: "claude-sonnet-4-20250514",
      input_tokens: 100_000,
      output_tokens: 0,
    };
    const c = toCycleCost(usage, { cycleId: "usd-test", agent: "claude", revertCount: 0 });
    expect(c.currency).toBe("USD");
  });

  it("effectiveCost includes revert multiplier and same currency", () => {
    const usage: AgentUsage = {
      model: "kimi-k2.6",
      input_tokens: 1_000_000,
      output_tokens: 0,
    };
    const c = toCycleCost(usage, { cycleId: "revert-test", agent: "kimi", revertCount: 2 });
    expect(c.currency).toBe("CNY");
    expect(c.revertCount).toBe(2);
    // estimated × (reverts + 1) = 6.5 × 3 = 19.5
    expect(c.effectiveCost).toBeCloseTo(19.5, 4);
  });
});
