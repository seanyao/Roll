/**
 * US-PAIR-012 — isolation distance is computed over the RESOLVED MODEL, not the
 * agent name. The regression cases below use this repo's REAL config, not
 * constructed examples: pi and reasonix are both pinned to deepseek-v4-pro, and
 * cursor really can run either an anthropic or an openai model.
 */
import { describe, expect, it } from "vitest";
import { isolationBetween, tierAtLeast, vendorOfModel, type RigIdentity } from "../src/agent/isolation.js";

const rig = (agentEntry: string, modelId: string, sessionId = `s-${agentEntry}`): RigIdentity => ({
  agentEntry,
  modelId,
  sessionId,
});

describe("US-PAIR-012 — the live over-counting bug", () => {
  it("pi vs reasonix are NOT a vendor split — both rigs pin deepseek-v4-pro", () => {
    const v = isolationBetween(rig("reasonix", "deepseek-v4-pro"), rig("pi", "deepseek-v4-pro"));
    expect(v.tier, v.reason).toBe("session");
    expect(v.reason).toContain("deepseek-v4-pro");
  });

  it("cursor running claude is NOT a vendor split from claude", () => {
    // cursor --list-models really offers claude-opus-5-thinking-high.
    const v = isolationBetween(rig("claude", "claude-opus-5"), rig("cursor", "claude-opus-5-thinking-high"));
    expect(v.tier).toBe("model");
    expect(v.reason).toContain("same vendor anthropic");
  });

  it("cursor running a gpt model IS a vendor split from claude", () => {
    const v = isolationBetween(rig("claude", "claude-opus-5"), rig("cursor", "gpt-5.3-codex"));
    expect(v.tier).toBe("vendor");
    expect(v.reason).toBe("anthropic → openai");
  });
});

describe("US-PAIR-012 — unknown vendors must not fake a split", () => {
  it("two unrecognised models degrade to model, never vendor", () => {
    // The trap: treating each unknown model as its own vendor re-creates exactly
    // the bug this card fixes.
    const v = isolationBetween(rig("a", "mystery-one"), rig("b", "mystery-two"));
    expect(v.tier).toBe("model");
    expect(v.reason).toContain("vendor unknown");
  });

  it("one known + one unknown still cannot prove a vendor split", () => {
    const v = isolationBetween(rig("claude", "claude-opus-5"), rig("x", "mystery-two"));
    expect(v.tier).toBe("model");
    expect(v.reason).toContain("mystery-two");
  });

  it("vendorOfModel returns empty for unknown, not a synthetic vendor", () => {
    expect(vendorOfModel("mystery-one")).toBe("");
    expect(vendorOfModel("")).toBe("");
    expect(vendorOfModel("claude-opus-5")).toBe("anthropic");
    expect(vendorOfModel("gpt-5.3-codex")).toBe("openai");
    expect(vendorOfModel("o3-mini")).toBe("openai");
    expect(vendorOfModel("deepseek-v4-pro")).toBe("deepseek");
    expect(vendorOfModel("kimi-k2")).toBe("moonshot");
  });
});

describe("US-PAIR-012 — the weak end of the ladder", () => {
  it("same model, same session → off (self-review)", () => {
    const v = isolationBetween(rig("kimi", "kimi-k2", "same"), rig("kimi", "kimi-k2", "same"));
    expect(v.tier).toBe("off");
    expect(v.reason).toContain("self-review");
  });

  it("same model, different session → session", () => {
    const v = isolationBetween(rig("kimi", "kimi-k2", "s1"), rig("kimi", "kimi-k2", "s2"));
    expect(v.tier).toBe("session");
  });

  it("a missing session identity cannot prove even a session split", () => {
    // Matches US-PAIR-017: an absent builder identity must not read as isolated.
    const v = isolationBetween(rig("kimi", "kimi-k2", ""), rig("kimi", "kimi-k2", "s2"));
    expect(v.tier).toBe("off");
    expect(v.reason).toContain("session identity is missing");
  });

  it("a missing model claim falls back to the session axis only", () => {
    const v = isolationBetween(rig("kimi", "", "s1"), rig("codex", "", "s2"));
    expect(v.tier).toBe("session");
    expect(v.reason).toContain("no model claim");
  });
});

describe("US-PAIR-012 — tierAtLeast ordering", () => {
  it("ranks vendor strongest and off weakest", () => {
    expect(tierAtLeast("vendor", "model")).toBe(true);
    expect(tierAtLeast("model", "vendor")).toBe(false);
    expect(tierAtLeast("session", "off")).toBe(true);
    expect(tierAtLeast("off", "session")).toBe(false);
    expect(tierAtLeast("model", "model")).toBe(true);
  });
});

describe("US-PAIR-015 — the ladder as the selection predicate", () => {
  // This repo's real rig table.
  const models: Record<string, string> = {
    claude: "claude-opus-5",
    codex: "gpt-5.3-codex",
    kimi: "kimi-k2",
    pi: "deepseek-v4-pro",
    reasonix: "deepseek-v4-pro",
  };
  const resolve = (a: string): string => models[a] ?? "";

  it("pi and reasonix are NOT a heterogeneous pair (the live bug)", async () => {
    const { heterogeneousByModel } = await import("../src/agent/isolation.js");
    expect(heterogeneousByModel("pi", "reasonix", resolve)).toBe(false);
    expect(heterogeneousByModel("reasonix", "pi", resolve)).toBe(false);
  });

  it("still recognises genuinely different vendors", async () => {
    const { heterogeneousByModel } = await import("../src/agent/isolation.js");
    expect(heterogeneousByModel("claude", "codex", resolve)).toBe(true);
    expect(heterogeneousByModel("claude", "kimi", resolve)).toBe(true);
  });

  it("a pool that all resolves to ONE model is not hetero availability", async () => {
    const { heteroAvailableByModel } = await import("../src/agent/isolation.js");
    expect(heteroAvailableByModel(["pi", "reasonix"], "pi", resolve)).toBe(false);
    expect(heteroAvailableByModel(["pi", "reasonix", "codex"], "pi", resolve)).toBe(true);
  });

  it("an unresolvable model never fakes availability", async () => {
    const { heteroAvailableByModel } = await import("../src/agent/isolation.js");
    expect(heteroAvailableByModel(["unknown-a", "unknown-b"], "unknown-a", resolve)).toBe(false);
  });

  it("respects the allow-list", async () => {
    const { heteroAvailableByModel } = await import("../src/agent/isolation.js");
    expect(heteroAvailableByModel(["codex", "kimi"], "claude", resolve, ["kimi"])).toBe(true);
    expect(heteroAvailableByModel(["codex"], "claude", resolve, ["kimi"])).toBe(false);
  });
});

describe("US-PAIR-018 — observation reconciles, it never re-decides", () => {
  it("no observation is silent, not a mismatch", async () => {
    const { reconcileObservedModel } = await import("../src/agent/isolation.js");
    // pi/agy extractors are deliberate stubs — honest silence must not look like a fault.
    expect(reconcileObservedModel("deepseek-v4-pro", "").kind).toBe("not_observed");
    expect(reconcileObservedModel("deepseek-v4-pro", "   ").kind).toBe("not_observed");
  });

  it("no configured model is also silent", async () => {
    const { reconcileObservedModel } = await import("../src/agent/isolation.js");
    expect(reconcileObservedModel("", "kimi-k2").kind).toBe("not_observed");
  });

  it("agreement is a match", async () => {
    const { reconcileObservedModel } = await import("../src/agent/isolation.js");
    expect(reconcileObservedModel("kimi-k2", "kimi-k2").kind).toBe("match");
  });

  it("a cross-vendor mismatch says the recorded tier may OVERSTATE the separation", async () => {
    const { reconcileObservedModel } = await import("../src/agent/isolation.js");
    const v = reconcileObservedModel("gpt-5.3-codex", "claude-opus-5");
    expect(v.kind).toBe("mismatch");
    if (v.kind === "mismatch") {
      expect(v.message).toContain("overstate");
      expect(v.message).toContain("openai");
      expect(v.message).toContain("anthropic");
    }
  });

  it("a same-vendor mismatch is reported without the overstatement warning", async () => {
    const { reconcileObservedModel } = await import("../src/agent/isolation.js");
    const v = reconcileObservedModel("claude-opus-5", "claude-opus-4-8");
    expect(v.kind).toBe("mismatch");
    if (v.kind === "mismatch") {
      expect(v.message).toContain("same vendor anthropic");
      expect(v.message).not.toContain("overstate");
    }
  });

  it("reconciliation is not a tier function — it cannot downgrade anything", async () => {
    const { reconcileObservedModel, isolationBetween } = await import("../src/agent/isolation.js");
    // The tier was computed from the CONFIGURED identity and stays put; the
    // reconciler only returns a verdict about the observation.
    const tier = isolationBetween(
      { agentEntry: "claude", modelId: "claude-opus-5", sessionId: "a" },
      { agentEntry: "codex", modelId: "gpt-5.3-codex", sessionId: "b" },
    ).tier;
    expect(tier).toBe("vendor");
    expect(reconcileObservedModel("gpt-5.3-codex", "")).toEqual({ kind: "not_observed" });
    expect(tier, "unchanged by reconciliation").toBe("vendor");
  });
});
