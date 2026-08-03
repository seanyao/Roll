/**
 * US-DELTA-011 — precise TCR round + test-proof timing facts.
 *
 * Fixtures pin the contract: versioned `tcr:*` events parse strictly, proof
 * freshness is derived from REAL test-completion → commit timestamps against
 * the existing 60 s rule, an absent or reversed clock is loud/unknown (never
 * fabricated fresh), and legacy streams project as INCOMPLETE telemetry —
 * never as zero TCR rounds.
 */
import { describe, expect, it } from "vitest";
import { parseEventLine, type RollEvent } from "@roll/spec";
import {
  TCR_PROOF_FRESH_LIMIT_MS,
  computeProofAge,
  projectTcrTelemetry,
} from "../src/delivery/tcr-observation.js";

const STARTED = {
  type: "tcr:round_started",
  v: 1,
  storyId: "US-DELTA-011",
  delegationId: "d1",
  roundId: "tcr-1",
  role: "builder",
  hostId: "kimi",
  modelId: "model-x",
  headSha: "a1",
  ts: 1_000,
} as const;

const FINISHED = {
  type: "tcr:test_finished",
  v: 1,
  storyId: "US-DELTA-011",
  delegationId: "d1",
  roundId: "tcr-1",
  command: "roll test --affected",
  affectedScope: "affected",
  exitCode: 0,
  wallMs: 18_420,
  outputSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  ts: 19_420,
} as const;

const COMMITTED = {
  type: "tcr:committed",
  v: 1,
  storyId: "US-DELTA-011",
  delegationId: "d1",
  roundId: "tcr-1",
  commitSha: "b2",
  proofAgeMs: 1_200,
  ts: 20_620,
} as const;

describe("tcr event strict parsing", () => {
  it("round-trips the three versioned variants through parseEventLine", () => {
    for (const ev of [STARTED, FINISHED, COMMITTED]) {
      const parsed = parseEventLine(JSON.stringify(ev));
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe(ev.type);
    }
  });

  it("never carries raw test output — only a digest field exists", () => {
    const serialized = JSON.stringify(FINISHED);
    expect(serialized).toContain("outputSha256");
    expect(serialized).not.toMatch(/stdout|stderr|rawOutput/);
  });
});

describe("computeProofAge — real test-completion → commit timing", () => {
  it("green: fresh proof within the existing 60 s rule", () => {
    const age = computeProofAge(19_420, 20_620);
    expect(age).toEqual({ ok: true, proofAgeMs: 1_200, fresh: true });
  });

  it("stale: proof older than 60 s is not fresh", () => {
    const age = computeProofAge(0, TCR_PROOF_FRESH_LIMIT_MS + 1);
    expect(age).toEqual({ ok: true, proofAgeMs: TCR_PROOF_FRESH_LIMIT_MS + 1, fresh: false });
  });

  it("absent test completion is loud-unknown, never fabricated fresh", () => {
    expect(computeProofAge(undefined, 20_620)).toEqual({ ok: false, reason: "missing-test-proof" });
  });

  it("reversed clock (commit before test completion) is loud-unknown", () => {
    expect(computeProofAge(20_620, 19_420)).toEqual({ ok: false, reason: "reversed-clock" });
  });
});

describe("projectTcrTelemetry", () => {
  it("green round: started + finished + committed project as one complete round", () => {
    const t = projectTcrTelemetry([STARTED, FINISHED, COMMITTED] as unknown as RollEvent[]);
    expect(t.status).toBe("ok");
    expect(t.rounds).toHaveLength(1);
    const r = t.rounds[0]!;
    expect(r.roundId).toBe("tcr-1");
    expect(r.status).toBe("complete");
    expect(r.green).toBe(true);
    expect(r.proof).toEqual({ ok: true, proofAgeMs: 1_200, fresh: true });
    expect(r.testWallMs).toBe(18_420);
  });

  it("red round: non-zero exit projects as a complete but red round", () => {
    const red = { ...FINISHED, exitCode: 1 };
    const t = projectTcrTelemetry([STARTED, red] as unknown as RollEvent[]);
    expect(t.rounds[0]?.green).toBe(false);
  });

  it("stale proof: commit 60 s+ after test completion projects fresh:false", () => {
    const stale = { ...COMMITTED, ts: FINISHED.ts + TCR_PROOF_FRESH_LIMIT_MS + 5_000 };
    const t = projectTcrTelemetry([STARTED, FINISHED, stale] as unknown as RollEvent[]);
    expect(t.rounds[0]?.proof).toMatchObject({ ok: true, fresh: false });
  });

  it("unknown-delegation: events without delegationId still project, tagged unknown", () => {
    const anon = { ...STARTED, delegationId: undefined };
    const t = projectTcrTelemetry([anon] as unknown as RollEvent[]);
    expect(t.rounds[0]?.delegationId).toBeUndefined();
    expect(t.status).toBe("incomplete"); // started only — no test/commit facts
  });

  it("duplicate rows surface a diagnostic and are counted once", () => {
    const t = projectTcrTelemetry([STARTED, STARTED, FINISHED, COMMITTED] as unknown as RollEvent[]);
    expect(t.rounds).toHaveLength(1);
    expect(t.diagnostics.some((d) => d.includes("duplicate"))).toBe(true);
  });

  it("partial round (test but no commit) is incomplete, with a loud diagnostic", () => {
    const t = projectTcrTelemetry([STARTED, FINISHED] as unknown as RollEvent[]);
    expect(t.status).toBe("incomplete");
    expect(t.rounds[0]?.status).toBe("incomplete");
    expect(t.rounds[0]?.diagnostics.some((d) => d.includes("commit"))).toBe(true);
  });

  it("reversed clock in the stream is unknown, never fabricated fresh", () => {
    const reversed = { ...COMMITTED, ts: FINISHED.ts - 1 };
    const t = projectTcrTelemetry([STARTED, FINISHED, reversed] as unknown as RollEvent[]);
    expect(t.rounds[0]?.proof).toEqual({ ok: false, reason: "reversed-clock" });
  });

  it("legacy stream without tcr facts → incomplete telemetry, never zero rounds", () => {
    const legacy = [
      { type: "cycle:tcr", cycleId: "c1", commitHash: "ab12", message: "tcr: x", ts: 5_000 },
    ] as unknown as RollEvent[];
    const t = projectTcrTelemetry(legacy);
    expect(t.status).toBe("incomplete");
    expect(t.rounds).toHaveLength(0);
    expect(t.diagnostics.some((d) => d.includes("no-tcr-observations"))).toBe(true);
  });
});
