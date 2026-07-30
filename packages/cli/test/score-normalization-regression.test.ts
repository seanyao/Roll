/**
 * FIX-1492 — regression guard for the tolerant score normalization.
 *
 * Every fixture below is the SHAPE of a real historical failure artifact taken
 * from this repo's event stream (66 `pair:score-failure cause:unparseable` rows
 * that still had their raw output on disk). Replaying all 66 through today's
 * parser: 49 now parse, 17 do not — and 15 of those 17 genuinely returned no
 * score content, i.e. they are correctly refused.
 *
 * So the "60% of score failures are unparseable" number was real but is already
 * fixed — by FIX-1044's normalization, NOT by FIX-910's retry. These tests exist
 * so that fix cannot silently regress, since the failure mode it prevents is
 * invisible: a perfectly good review gets thrown away and the cycle just retries.
 */
import { describe, expect, it } from "vitest";
import { diagnosePairScoreOutput, normalizeScoreStdout, parsePairScoreOutput } from "../src/runner/pairing-gate.js";

const BODY = "SCORE: 7\nVERDICT: good\nRATIONALE: Delivery is structurally sound and the regression test covers the reported path.\n";

describe("FIX-1492 — real-world wrappers must not throw away a valid review", () => {
  it("pi / agy: EOT + backspace overstrike immediately before SCORE", () => {
    // Observed verbatim in 13 artifacts: "\b\bSCORE: 7".
    const raw = `--- stdout ---\n\b\b${BODY}`;
    const parsed = parsePairScoreOutput(raw);
    expect(parsed, "a leading control overstrike must not reject the block").not.toBeNull();
    expect(parsed?.score).toBe(7);
    expect(parsed?.verdict).toBe("good");
  });

  it("kimi: a bullet prefix on the block", () => {
    // Observed in 4 artifacts: kimi prefixes its output with "• ".
    const raw = `--- stdout ---\n• ${BODY}`;
    expect(parsePairScoreOutput(raw)?.score).toBe(7);
  });

  it("reasonix: startup warnings above the block", () => {
    const raw =
      `--- stdout ---\nwarning: skill "x" has no description: — it will load but won't appear in the index\n` +
      `warning: skill "y" has no description\n${BODY}`;
    expect(parsePairScoreOutput(raw)?.score).toBe(7);
  });

  it("claude: the protocol text arrives inside a stream-json result event", () => {
    const raw =
      `--- stdout ---\n` +
      `${JSON.stringify({ type: "system", subtype: "hook_started" })}\n` +
      `${JSON.stringify({ type: "result", result: BODY })}\n`;
    expect(parsePairScoreOutput(raw)?.score).toBe(7);
  });

  it("normalizeScoreStdout keeps the protocol lines line-anchored", () => {
    const normalized = normalizeScoreStdout(`\b\b${BODY}`);
    expect(/^SCORE: 7$/m.test(normalized)).toBe(true);
    expect(normalized).not.toContain("");
  });
});

describe("FIX-1492 — tolerance must NOT become permissiveness", () => {
  it("no score content is still refused (15 of the 17 residual failures)", () => {
    const raw = "--- stdout ---\nI looked at the diff and it seems reasonable overall.\n";
    expect(parsePairScoreOutput(raw)).toBeNull();
    expect(diagnosePairScoreOutput(raw).category).toBe("no-score-content");
  });

  it("an out-of-range score is still refused", () => {
    const raw = `SCORE: 42\nVERDICT: good\nRATIONALE: nope\n`;
    expect(parsePairScoreOutput(raw)).toBeNull();
  });

  it("an unsupported verdict is still refused", () => {
    const raw = `SCORE: 7\nVERDICT: excellent\nRATIONALE: nope\n`;
    expect(parsePairScoreOutput(raw)).toBeNull();
  });

  it("an empty response is still refused", () => {
    expect(parsePairScoreOutput("")).toBeNull();
    expect(parsePairScoreOutput("--- stdout ---\n")).toBeNull();
  });
});

describe("FIX-1492 — the score budget follows the measured distribution", () => {
  it("kimi gets a raised budget: its p90 (197s) exceeds the flat 180s", async () => {
    const { scoreTimeoutMsFor } = await import("../src/runner/pairing-gate.js");
    expect(scoreTimeoutMsFor("kimi")).toBeGreaterThan(180_000);
  });

  it("agents whose p90 fits keep the flat budget", async () => {
    const { scoreTimeoutMsFor } = await import("../src/runner/pairing-gate.js");
    // Deliberately NOT "raise it for everybody" — a generous global deadline turns
    // a genuinely hung agent into a long stall.
    for (const agent of ["pi", "reasonix", "claude", "codex", "cursor"]) {
      expect(scoreTimeoutMsFor(agent), agent).toBe(180_000);
    }
  });

  it("an unknown agent falls back to the flat budget", async () => {
    const { scoreTimeoutMsFor } = await import("../src/runner/pairing-gate.js");
    expect(scoreTimeoutMsFor("some-new-agent")).toBe(180_000);
  });
});
