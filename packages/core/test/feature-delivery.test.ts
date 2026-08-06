import { describe, expect, it } from "vitest";
import { buildFeatureDeliveryView, type ObservedFact } from "../src/index.js";
import type { RollEvent } from "@roll/spec";

const fact = (event: RollEvent, line: number): ObservedFact => ({ event, observedAtMs: event.ts, source: { ledgerUri: "/fixed/events.ndjson", line, rawSha256: String(line).padStart(64, "0") } });
const input = (facts: ObservedFact[], truth = facts) => ({ subject: { kind: "card" as const, id: "US-X", title: "X" }, cards: [{ id: "US-X", title: "X" }], facts, currentTruthFacts: truth, diagnostics: [], window: { basis: "observed_fact_time" as const, inclusive: true as const } });

describe("buildFeatureDeliveryView", () => {
  it("keeps loop and Delta as separate attempts while delivery is counted once", () => {
    const loop = fact({ type: "cycle:start", cycleId: "c1", storyId: "US-X", agent: "codex", model: "m", ts: 10 }, 1);
    const delta = fact({ type: "delta:prepared", delegationId: "d1", runId: "r1", storyId: "US-X", cycleId: "c1", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "p", presetSha256: "", hostId: "h", ts: 20 }, 2);
    const merged = fact({ type: "delivery:merge_confirmed", cycleId: "c1", storyId: "US-X", branch: "x", signal: "ancestor", ts: 30 }, 3);
    const view = buildFeatureDeliveryView(input([loop, delta, merged]));
    expect(view.cards[0]?.finalState).toBe("delivered");
    expect(view.cards[0]?.attempts.map((a) => a.attemptId)).toEqual(["loop:c1", "delta:d1"]);
    expect(view.summary.states.delivered).toBe(1);
  });

  it("never promotes backlog-less handoff to delivered", () => {
    const prepared = fact({ type: "delta:prepared", delegationId: "d1", runId: "r1", storyId: "US-X", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "p", presetSha256: "", hostId: "h", ts: 10 }, 1);
    const terminal = fact({ type: "delta:terminal", delegationId: "d1", storyId: "US-X", outcome: "handoff_ready", terminalBinding: "handoff_only", ts: 20 }, 2);
    expect(buildFeatureDeliveryView(input([prepared, terminal])).cards[0]?.finalState).toBe("handoff_ready");
  });

  it("preserves current truth when the process window is empty", () => {
    const start = fact({ type: "cycle:start", cycleId: "c1", storyId: "US-X", agent: "codex", model: "m", ts: 10 }, 1);
    const merged = fact({ type: "delivery:merge_confirmed", cycleId: "c1", storyId: "US-X", branch: "x", signal: "ancestor", ts: 30 }, 2);
    const view = buildFeatureDeliveryView(input([], [start, merged]));
    expect(view.cards[0]?.finalState).toBe("delivered");
    expect(view.summary.attempts).toBe(0);
  });

  it("preserves a current Delta handoff when its process facts are outside the window", () => {
    const prepared = fact({ type: "delta:prepared", delegationId: "d1", runId: "r1", storyId: "US-X", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "p", presetSha256: "", hostId: "h", ts: 10 }, 1);
    const terminal = fact({ type: "delta:terminal", delegationId: "d1", storyId: "US-X", outcome: "handoff_ready", terminalBinding: "handoff_only", ts: 20 }, 2);
    const view = buildFeatureDeliveryView(input([], [prepared, terminal]));
    expect(view.cards[0]?.finalState).toBe("handoff_ready");
    expect(view.summary.attempts).toBe(0);
  });

  it("excludes distinct rows with the same logical admission key", () => {
    const start = fact({ type: "cycle:start", cycleId: "c1", storyId: "US-X", agent: "codex", model: "m", ts: 10 }, 1);
    const startAgain = fact({ type: "cycle:start", cycleId: "c1", storyId: "US-X", agent: "kimi", model: "k3", ts: 11 }, 2);
    const view = buildFeatureDeliveryView(input([start, startAgain]));
    expect(view.cards[0]?.attempts).toHaveLength(0);
    expect(view.cards[0]?.codes).toContain("ambiguous_duplicate_observation:attempt:loop:c1:start");
  });

  it("promotes exact host-delta attestation and records an unbound one", () => {
    const start = fact({ type: "cycle:start", cycleId: "c1", storyId: "US-X", agent: "codex", model: "m", ts: 10 }, 1);
    const prepared = fact({ type: "delta:prepared", delegationId: "d1", runId: "r1", storyId: "US-X", cycleId: "c1", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "p", presetSha256: "", hostId: "h", ts: 20 }, 2);
    const merged = fact({ type: "delivery:merge_confirmed", cycleId: "c1", storyId: "US-X", branch: "x", signal: "ancestor", ts: 30 }, 3);
    const attest = fact({ type: "attest:host_delta", cycleId: "c1", storyId: "US-X", delegationId: "d1", reportPath: "r", ts: 40 }, 4);
    const view = buildFeatureDeliveryView(input([], [start, prepared, merged, attest]));
    expect(view.cards[0]?.finalState).toBe("attested");

    const wrong = fact({ type: "attest:host_delta", cycleId: "c1", storyId: "US-X", delegationId: "d2", reportPath: "r", ts: 41 }, 5);
    const unbound = buildFeatureDeliveryView(input([], [start, prepared, merged, wrong]));
    expect(unbound.cards[0]?.finalState).toBe("delivered");
    expect(unbound.cards[0]?.codes).toContain("unbound_host_delta_attestation");
  });

  it("treats an outcome without a terminal as unknown, not active", () => {
    const prepared = fact({ type: "delta:prepared", delegationId: "d1", runId: "r1", storyId: "US-X", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "p", presetSha256: "", hostId: "h", ts: 10 }, 1);
    const outcome = fact({ type: "delta:attempt_outcome", delegationId: "d1", storyId: "US-X", cause: "unknown", evidenceRef: "e", terminalFact: "handoff_ready", ts: 20 }, 2);
    const view = buildFeatureDeliveryView(input([prepared, outcome]));
    expect(view.cards[0]?.attempts[0]?.outcome).toBe("unknown");
    expect(view.cards[0]?.attempts[0]?.codes).toContain("missing_delta_terminal");
  });

  it("maps abandoned Delta terminal to a failed attempt, not a card block", () => {
    const prepared = fact({ type: "delta:prepared", delegationId: "d1", runId: "r1", storyId: "US-X", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "p", presetSha256: "", hostId: "h", ts: 10 }, 1);
    const terminal = fact({ type: "delta:terminal", delegationId: "d1", storyId: "US-X", outcome: "abandoned", terminalBinding: "handoff_only", ts: 20 }, 2);
    const view = buildFeatureDeliveryView(input([prepared, terminal]));
    expect(view.cards[0]?.attempts[0]?.outcome).toBe("failed");
    expect(view.cards[0]?.finalState).toBe("active");
  });

  it("does not borrow a duration boundary outside the query window", () => {
    const start = fact({ type: "cycle:start", cycleId: "c1", storyId: "US-X", agent: "codex", model: "m", ts: 10 }, 1);
    const end = fact({ type: "cycle:end", cycleId: "c1", storyId: "US-X", ts: 20 }, 2);
    const base = input([start, end], [start, end]);
    const view = buildFeatureDeliveryView({ ...base, window: { basis: "observed_fact_time", inclusive: true, fromMs: 0, toMs: 15 } });
    expect(view.cards[0]?.attempts[0]?.timing.elapsedMs).toBeNull();
    expect(view.cards[0]?.attempts[0]?.timing.codes).toContain("boundary_outside_query_window");
  });

  it("never counts an ambiguous TCR round as green", () => {
    const prepared = fact({ type: "delta:prepared", delegationId: "d1", runId: "r1", storyId: "US-X", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "p", presetSha256: "", hostId: "h", ts: 10 }, 1);
    const round = fact({ type: "tcr:round_started", v: 1, storyId: "US-X", delegationId: "d1", roundId: "r1", role: "builder", hostId: "h", modelId: "m", headSha: "abc", ts: 20 }, 2);
    const finishA = fact({ type: "tcr:test_finished", v: 1, storyId: "US-X", delegationId: "d1", roundId: "r1", command: "test", affectedScope: "x", exitCode: 0, wallMs: 1, outputSha256: "a".repeat(64), ts: 21 }, 3);
    const finishB = fact({ type: "tcr:test_finished", v: 1, storyId: "US-X", delegationId: "d1", roundId: "r1", command: "test", affectedScope: "x", exitCode: 1, wallMs: 1, outputSha256: "b".repeat(64), ts: 22 }, 4);
    const committed = fact({ type: "tcr:committed", v: 1, storyId: "US-X", delegationId: "d1", roundId: "r1", commitSha: "abc", proofAgeMs: 1, ts: 23 }, 5);
    const view = buildFeatureDeliveryView(input([prepared, round, finishA, finishB, committed]));
    expect(view.cards[0]?.attempts[0]?.tcr.green).toBe(0);
    expect(view.cards[0]?.attempts[0]?.tcr.red).toBe(0);
    expect(view.cards[0]?.attempts[0]?.tcr.incompleteAttempts).toBe(1);
  });

  it("keeps pr:merge as an unproven manual note, not delivery", () => {
    const merged = fact({ type: "pr:merge", prNumber: 1, storyId: "US-X", ts: 10 }, 1);
    const view = buildFeatureDeliveryView(input([merged]));
    expect(view.cards[0]?.finalState).toBe("unknown");
    expect(view.cards[0]?.codes).toContain("manual_merge_unproven");
  });

  it("reports rework attempts after the first attempt", () => {
    const first = fact({ type: "delta:prepared", delegationId: "d1", runId: "r1", storyId: "US-X", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "p", presetSha256: "", hostId: "h", ts: 10 }, 1);
    const second = fact({ type: "delta:prepared", delegationId: "d2", runId: "r2", storyId: "US-X", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "p", presetSha256: "", hostId: "h", ts: 20 }, 2);
    const view = buildFeatureDeliveryView(input([first, second]));
    expect(view.summary.rework.attemptsAfterFirst).toBe(1);
  });
});
