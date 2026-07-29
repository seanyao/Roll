/**
 * US-CYCLE-012 — repeated-failure attribution → model-swap candidate →
 * heterogeneous consensus. Pins: per-role×model streak counting (kill/failed/
 * refuted count, success resets), threshold candidate, consensus routing (all
 * agree ⇒ record; disagree/none ⇒ escalate), and the full chain with an injected
 * (deterministic) adjudicator. No auto-swap anywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRoundEntry } from "@roll/core";
import {
  CONSECUTIVE_FAIL_THRESHOLD,
  decideSwap,
  isFailureOutcome,
  isSuccessOutcome,
  perRoleModelStreaks,
  recordSwapDecision,
  swapCandidates,
  type SwapCandidate,
  type SwapVerdict,
} from "../src/lib/model-swap.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uscycle012-"));
});
afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function card(): string {
  const d = join(tmp, "card");
  mkdirSync(d, { recursive: true });
  return d;
}
function add(dir: string, role: string, model: string, outcome: string, cyc: string): void {
  appendRoundEntry(dir, { card: "US-T", role, model, start: 1, durMs: 1, outcome, cycleId: cyc });
}

describe("outcome classification", () => {
  it("failures count, successes reset", () => {
    for (const o of ["kill:no-state-change", "failed", "refuted", "timeout", "blocked"]) expect(isFailureOutcome(o)).toBe(true);
    for (const o of ["delivered", "passed"]) expect(isSuccessOutcome(o)).toBe(true);
    expect(isFailureOutcome("delivered")).toBe(false);
  });
});

describe("perRoleModelStreaks", () => {
  it("counts consecutive per-role×model failures; a success resets", () => {
    const d = card();
    add(d, "builder", "glm-5.2", "failed", "c1");
    add(d, "builder", "glm-5.2", "refuted", "c2");
    const s1 = perRoleModelStreaks(d).find((s) => s.model === "glm-5.2");
    expect(s1?.streak).toBe(2);
    // A success clears it.
    add(d, "builder", "glm-5.2", "delivered", "c3");
    const s2 = perRoleModelStreaks(d).find((s) => s.model === "glm-5.2");
    expect(s2?.streak).toBe(0);
    expect(s2?.recentOutcomes).toEqual([]);
  });
  it("keeps distinct (role×model) streaks separate", () => {
    const d = card();
    add(d, "builder", "A", "failed", "c1");
    add(d, "evaluator", "B", "failed", "c1");
    add(d, "builder", "A", "failed", "c2");
    const streaks = perRoleModelStreaks(d);
    expect(streaks.find((s) => s.model === "A")?.streak).toBe(2);
    expect(streaks.find((s) => s.model === "B")?.streak).toBe(1);
  });
});

describe("swapCandidates — threshold", () => {
  it("no candidate below threshold, candidate at/above", () => {
    const d = card();
    add(d, "builder", "A", "failed", "c1");
    expect(swapCandidates(d, "US-T")).toHaveLength(0);
    add(d, "builder", "A", "kill:wall", "c2");
    const cands = swapCandidates(d, "US-T");
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ role: "builder", model: "A", streak: CONSECUTIVE_FAIL_THRESHOLD });
  });
});

describe("decideSwap — consensus routing (no auto-swap)", () => {
  const cand: SwapCandidate = { card: "US-T", role: "builder", model: "A", streak: 2, recentOutcomes: ["failed", "failed"] };
  it("unanimous agree ⇒ agree", () => {
    const v: SwapVerdict[] = [{ agent: "kimi", verdict: "agree" }, { agent: "pi", verdict: "agree" }];
    expect(decideSwap(v).decision).toBe("agree");
  });
  it("any disagreement ⇒ escalate", () => {
    const v: SwapVerdict[] = [{ agent: "kimi", verdict: "agree" }, { agent: "pi", verdict: "disagree" }];
    expect(decideSwap(v).decision).toBe("escalate");
  });
  it("any errored/unparseable selected voter ⇒ escalate (not a silent abstention)", () => {
    expect(decideSwap([{ agent: "kimi", verdict: "error" }]).decision).toBe("escalate");
    // one agree + one broken voter is NOT a consensus.
    expect(decideSwap([{ agent: "kimi", verdict: "agree" }, { agent: "x", verdict: "error" }]).decision).toBe("escalate");
  });
  it("fewer than the minimum distinct voters ⇒ escalate (one voter is not consensus)", () => {
    expect(decideSwap([{ agent: "kimi", verdict: "agree" }]).decision).toBe("escalate");
    // same agent twice is still one distinct voter.
    expect(decideSwap([{ agent: "kimi", verdict: "agree" }, { agent: "kimi", verdict: "agree" }]).decision).toBe("escalate");
  });
  void cand;
});

describe("recordSwapDecision — auditable, never mutates config", () => {
  it("writes the decision record + a card note (agree)", () => {
    const d = card();
    const cand: SwapCandidate = { card: "US-T", role: "builder", model: "A", streak: 2, recentOutcomes: ["failed", "failed"] };
    const decision = decideSwap([{ agent: "kimi", verdict: "agree" }, { agent: "pi", verdict: "agree" }]);
    const { decisionPath, notePath } = recordSwapDecision(d, cand, decision);
    expect(existsSync(decisionPath)).toBe(true);
    expect(readFileSync(decisionPath, "utf8")).toContain("Decision: **agree**");
    expect(readFileSync(notePath, "utf8")).toContain("model-swap agree for builder × A");
    // Idempotent note: recording the same decision twice does not duplicate the line.
    recordSwapDecision(d, cand, decision);
    const notes = readFileSync(notePath, "utf8");
    expect(notes.match(/model-swap agree for builder × A/g)).toHaveLength(1);
  });
});

describe("full chain (US-CYCLE-012 fixture): 2 fails → candidate → consensus agree → recorded", () => {
  it("drives the whole flow with an injected deterministic adjudicator", async () => {
    const d = card();
    add(d, "builder", "glm-5.2", "failed", "c1");
    add(d, "builder", "glm-5.2", "refuted", "c2");
    const cands = swapCandidates(d, "US-T");
    expect(cands).toHaveLength(1);
    // Injected heterogeneous consensus — unanimous agree.
    const adjudicator = async (): Promise<SwapVerdict[]> => [
      { agent: "kimi", verdict: "agree" },
      { agent: "pi", verdict: "agree" },
    ];
    const verdicts = await adjudicator();
    const decision = decideSwap(verdicts);
    expect(decision.decision).toBe("agree");
    const { decisionPath, notePath } = recordSwapDecision(d, cands[0]!, decision);
    expect(readFileSync(decisionPath, "utf8")).toContain("Decision: **agree**");
    expect(readFileSync(decisionPath, "utf8")).toContain("2 distinct");
    expect(readFileSync(notePath, "utf8")).toContain("model-swap agree");
    // No agents.yaml is ever written by this flow.
    expect(existsSync(join(tmp, ".roll", "agents.yaml"))).toBe(false);
  });
});
