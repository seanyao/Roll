/**
 * US-TRUTH-001 — Terminal Event Schema.
 *
 * Cycle terminal records used to mix failed/aborted/delivered/unknown and let
 * missing usage read as zero cost — every downstream consumer (dashboard,
 * reconcile, release gate) had to guess. The TerminalEvent closes that: a
 * versioned schema where every fact field is either PRESENT with a full value
 * or carries an enumerated absentReason. Silent 0 / "—" for "we don't know"
 * is structurally impossible.
 */
import { describe, expect, it } from "vitest";
import {
  TERMINAL_EVENT_SCHEMA_VERSION,
  LEGACY_TERMINAL_OUTCOMES,
  TERMINAL_OUTCOMES,
  absent,
  buildTerminalEvent,
  deriveOrphanVerdict,
  present,
  type TerminalEvent,
} from "../src/index.js";

const BASE = {
  cycleId: "20260611-120000-1",
  storyId: "US-X-001",
  agent: "pi",
  startedAt: 1781000000,
  endedAt: 1781000600,
} as const;

describe("US-TRUTH-001 AC1/AC2 — versioned schema, closed outcome enum", () => {
  it("carries schema version + identity fields", () => {
    const e = buildTerminalEvent({
      ...BASE,
      outcome: "delivered",
      pr: present({ url: "https://github.com/o/r/pull/1", state: "MERGED" }),
      branch: present("loop/cycle-20260611-120000-1"),
      commit: present("abc123"),
      tcr: present(3),
      attest: present({ reportPath: ".roll/features/e/US-X-001/latest/US-X-001-report.html", acMap: true }),
      usage: present({ model: "deepseek-v4-pro", tokensIn: 1000, tokensOut: 200 }),
      cost: present({ estimatedUsd: 0.02, effectiveUsd: 0.02 }),
    });
    expect(e.schema).toBe(TERMINAL_EVENT_SCHEMA_VERSION);
    expect(e.type).toBe("cycle:terminal");
    expect(e.cycleId).toBe(BASE.cycleId);
    expect(e.outcome).toBe("delivered");
    expect(e).toHaveProperty("failure_class", null);
    expect(e).toHaveProperty("root_cause_key", null);
  });

  it("failure attribution keys are part of every terminal-event shape", () => {
    const neutral = buildTerminalEvent({
      ...BASE,
      outcome: "published_pending_merge",
      pr: present({ url: "https://github.com/o/r/pull/1", state: "OPEN" }),
      branch: present("loop/cycle-x"),
      commit: present("abc123"),
      tcr: present(1),
      attest: present({ reportPath: "r.html", acMap: true }),
      usage: absent("no_parseable_usage"),
      cost: absent("no_parseable_usage"),
    });
    const attributed = buildTerminalEvent({
      ...BASE,
      outcome: "published_pending_merge",
      pr: present({ url: "https://github.com/o/r/pull/1", state: "OPEN" }),
      branch: present("loop/cycle-x"),
      commit: present("abc123"),
      tcr: present(1),
      attest: present({ reportPath: "r.html", acMap: true }),
      usage: absent("no_parseable_usage"),
      cost: absent("no_parseable_usage"),
      failure_class: "env",
      root_cause_key: "env:pr_loop",
    });
    expect(neutral.failure_class).toBeNull();
    expect(neutral.root_cause_key).toBeNull();
    expect(attributed.failure_class).toBe("env");
    expect(attributed.root_cause_key).toBe("env:pr_loop");
  });

  it("the outcome enum is closed and covers the required classes", () => {
    for (const o of [
      "delivered",
      "published_pending_merge",
      "failed",
      "blocked",
      "aborted_no_delivery",
      "aborted_with_delivery",
      "orphan_timeout",
      "idle_no_work",
      "gave_up",
      "unpublished",
      "needs_review",
      "ci_red_after_merge",
      "handoff_without_tcr",
      "dormant_entered",
      "unknown",
    ]) {
      expect(TERMINAL_OUTCOMES).toContain(o);
    }
    expect(TERMINAL_OUTCOMES).toHaveLength(15);
    expect(TERMINAL_OUTCOMES).not.toContain("pr_loop_unavailable");
    expect(TERMINAL_OUTCOMES).not.toContain("agent_internal_failure");
    expect(LEGACY_TERMINAL_OUTCOMES).toEqual(["agent_internal_failure"]);
  });
});

describe("US-TRUTH-001 AC3 — every fact field is present-or-reasoned, never silently empty", () => {
  it("absent fields carry an enumerated reason", () => {
    const e = buildTerminalEvent({
      ...BASE,
      outcome: "failed",
      pr: absent("no_publish_attempted"),
      branch: present("loop/cycle-x"),
      commit: absent("no_commits"),
      tcr: present(0),
      attest: absent("not_rendered"),
      usage: absent("no_parseable_usage"),
      cost: absent("no_parseable_usage"),
    });
    expect(e.usage).toEqual({ present: false, reason: "no_parseable_usage" });
    expect(e.attest).toEqual({ present: false, reason: "not_rendered" });
  });

  it("a zero-value usage is a PRESENT zero, distinguishable from unknown", () => {
    const withZero = present({ model: "m", tokensIn: 0, tokensOut: 0 });
    expect(withZero.present).toBe(true);
    const noIdea = absent("probe_failed");
    expect(noIdea.present).toBe(false);
  });
});

describe("FIX-294 — the terminal event carries the routed model even when usage is unknown", () => {
  it("FIX-352: normalizes terminal startedAt/endedAt/ts to epoch milliseconds", () => {
    const e = buildTerminalEvent({
      ...BASE,
      outcome: "failed",
      pr: absent("no_publish_attempted"),
      branch: present("loop/cycle-x"),
      commit: absent("no_commits"),
      tcr: present(0),
      attest: absent("not_rendered"),
      usage: absent("no_parseable_usage"),
      cost: absent("no_parseable_usage"),
    });
    expect(e.startedAt).toBe(1_781_000_000_000);
    expect(e.endedAt).toBe(1_781_000_600_000);
    expect(e.ts).toBe(1_781_000_600_000);
  });

  it("a failed cycle with unreadable usage still records WHICH model ran", () => {
    const e = buildTerminalEvent({
      ...BASE,
      model: "deepseek-v4-pro",
      outcome: "failed",
      pr: absent("no_publish_attempted"),
      branch: present("loop/cycle-x"),
      commit: absent("no_commits"),
      tcr: present(0),
      attest: absent("not_rendered"),
      // usage absent ⇒ tokens/cost UNKNOWN (FIX-290 distinction preserved)…
      usage: absent("no_parseable_usage"),
      cost: absent("no_parseable_usage"),
    });
    // …but the routed model is a dispatch-time fact and is never lost.
    expect(e.model).toBe("deepseek-v4-pro");
    expect(e.usage).toEqual({ present: false, reason: "no_parseable_usage" });
  });

  it("model defaults to empty string when no routing context exists (killed-cycle twin)", () => {
    const e = buildTerminalEvent({
      ...BASE,
      outcome: "aborted_no_delivery",
      pr: absent("killed_before_publish"),
      branch: present("loop/cycle-y"),
      commit: absent("killed_before_capture"),
      tcr: absent("probe_failed"),
      attest: absent("killed_before_capture"),
      usage: absent("killed_before_capture"),
      cost: absent("killed_before_capture"),
    });
    expect(e.model).toBe("");
  });
});

describe("US-TRUTH-001 AC4 — orphan/killed cycles derive a verdict instead of leaving a hole", () => {
  it("dead pid + commits on the branch → aborted_with_delivery", () => {
    expect(deriveOrphanVerdict({ pidAlive: false, commitsAhead: 2, ageSec: 900, timeoutSec: 2700 })).toBe(
      "aborted_with_delivery",
    );
  });
  it("dead pid + no commits → aborted_no_delivery", () => {
    expect(deriveOrphanVerdict({ pidAlive: false, commitsAhead: 0, ageSec: 900, timeoutSec: 2700 })).toBe(
      "aborted_no_delivery",
    );
  });
  it("live pid past the hard timeout → orphan_timeout", () => {
    expect(deriveOrphanVerdict({ pidAlive: true, commitsAhead: 1, ageSec: 9000, timeoutSec: 2700 })).toBe(
      "orphan_timeout",
    );
  });
  it("live pid within budget → null (still running, no verdict yet)", () => {
    expect(deriveOrphanVerdict({ pidAlive: true, commitsAhead: 0, ageSec: 100, timeoutSec: 2700 })).toBeNull();
  });
  it("commit probe unavailable → unknown, not a guessed no-delivery", () => {
    expect(deriveOrphanVerdict({ pidAlive: false, commitsAhead: null, ageSec: 900, timeoutSec: 2700 })).toBe(
      "unknown",
    );
  });
});

describe("US-TRUTH-001 AC6 — the six terminal classes snapshot stably", () => {
  const classes: Array<[string, TerminalEvent]> = [
    [
      "success",
      buildTerminalEvent({
        ...BASE,
        outcome: "published_pending_merge",
        pr: present({ url: "https://github.com/o/r/pull/9", state: "OPEN" }),
        branch: present("loop/cycle-a"),
        commit: present("aaa"),
        tcr: present(4),
        attest: present({ reportPath: "p.html", acMap: true }),
        usage: present({ model: "claude-opus-4-8", tokensIn: 10, tokensOut: 5 }),
        cost: present({ estimatedUsd: 0.1, effectiveUsd: 0.1 }),
      }),
    ],
    [
      "failure",
      buildTerminalEvent({
        ...BASE,
        outcome: "failed",
        pr: absent("no_publish_attempted"),
        branch: present("loop/cycle-b"),
        commit: absent("no_commits"),
        tcr: present(0),
        attest: absent("not_rendered"),
        usage: present({ model: "deepseek-v4-pro", tokensIn: 99, tokensOut: 1 }),
        cost: present({ estimatedUsd: 0.01, effectiveUsd: 0.01 }),
      }),
    ],
    [
      "abort-with-delivery",
      buildTerminalEvent({
        ...BASE,
        outcome: "aborted_with_delivery",
        pr: absent("killed_before_publish"),
        branch: present("loop/cycle-c"),
        commit: present("ccc"),
        tcr: present(2),
        attest: absent("killed_before_capture"),
        usage: absent("killed_before_capture"),
        cost: absent("killed_before_capture"),
      }),
    ],
    [
      "missing-usage",
      buildTerminalEvent({
        ...BASE,
        outcome: "delivered",
        pr: present({ url: "u", state: "MERGED" }),
        branch: present("loop/cycle-d"),
        commit: present("ddd"),
        tcr: present(1),
        attest: present({ reportPath: "r.html", acMap: true }),
        usage: absent("no_parseable_usage"),
        cost: absent("no_parseable_usage"),
      }),
    ],
    [
      "missing-attest",
      buildTerminalEvent({
        ...BASE,
        outcome: "failed",
        pr: present({ url: "u", state: "OPEN" }),
        branch: present("loop/cycle-e"),
        commit: present("eee"),
        tcr: present(5),
        attest: absent("acmap_missing"),
        usage: present({ model: "m", tokensIn: 1, tokensOut: 1 }),
        cost: present({ estimatedUsd: 0, effectiveUsd: 0 }),
      }),
    ],
    [
      "orphan-timeout",
      buildTerminalEvent({
        ...BASE,
        outcome: "orphan_timeout",
        pr: absent("killed_before_publish"),
        branch: present("loop/cycle-f"),
        commit: absent("probe_failed"),
        tcr: absent("probe_failed"),
        attest: absent("killed_before_capture"),
        usage: absent("killed_before_capture"),
        cost: absent("killed_before_capture"),
      }),
    ],
  ];

  it("all six serialize with stable field sets", () => {
    expect(classes.map(([name, e]) => [name, Object.keys(e).sort(), e.outcome])).toMatchSnapshot();
  });
});
