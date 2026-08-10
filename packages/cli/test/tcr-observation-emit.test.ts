import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEventLine, parseTcrObservationEvent } from "@roll/spec";
import { beginTcrRound, completeTcrRound, mintTcrRoundId, sha256Text } from "../src/runner/tcr-observation-emit.js";

let dir = "";
let eventsPath = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcr-emit-"));
  eventsPath = join(dir, "events.ndjson");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const START = { storyId: "US-DELTA-011", delegationId: "d1", hostId: "kimi", modelId: "model-x", headSha: "a1", startedMs: 1_000 };
const RUN = { finishedMs: 19_420, command: "npm test -- --affected", affectedScope: "affected", exitCode: 0, output: "some raw test output that must never be persisted" };

function readEvents(): unknown[] {
  return readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => parseEventLine(line));
}

describe("beginTcrRound + completeTcrRound", () => {
  it("emits strictly parseable start and finish facts with one shared round id", () => {
    const session = beginTcrRound({ ...START, eventsPath });
    expect(session).not.toBeNull();
    completeTcrRound(session, RUN);
    const events = readEvents();
    expect(events.map((event) => (event as { type: string }).type)).toEqual(["tcr:round_started", "tcr:test_finished"]);
    for (const event of events) expect(parseTcrObservationEvent(event)).not.toBeNull();
    expect(events[0]).toMatchObject({ type: "tcr:round_started", roundId: session!.roundId, ts: 1_000 });
    expect(events[1]).toMatchObject({ type: "tcr:test_finished", roundId: session!.roundId, wallMs: 18_420, ts: 19_420 });
  });

  it("persists only a digest, never raw test output", () => {
    completeTcrRound(beginTcrRound({ ...START, eventsPath }), RUN);
    const raw = readFileSync(eventsPath, "utf8");
    expect(raw).not.toContain(RUN.output);
    expect(raw).toContain(sha256Text(RUN.output));
  });

  it("rejects a purported finished row that carries raw output", () => {
    const session = beginTcrRound({ ...START, eventsPath });
    completeTcrRound(session, RUN);
    const finished = readEvents()[1] as Record<string, unknown>;
    expect(parseTcrObservationEvent({ ...finished, output: RUN.output })).toBeNull();
  });

  it("rejects a malformed output digest instead of accepting a fake result", () => {
    const session = beginTcrRound({ ...START, eventsPath });
    completeTcrRound(session, RUN);
    const finished = readEvents()[1] as Record<string, unknown>;
    expect(parseTcrObservationEvent({ ...finished, outputSha256: "not-a-sha256" })).toBeNull();
  });

  it("omits an unknown delegation instead of guessing", () => {
    completeTcrRound(beginTcrRound({ ...START, delegationId: undefined, eventsPath }), RUN);
    for (const event of readEvents()) expect("delegationId" in (event as object)).toBe(false);
  });

  it("keeps a story-less run as a deliberate no-op", () => {
    const session = beginTcrRound({ ...START, storyId: undefined, eventsPath });
    expect(session).toBeNull();
    completeTcrRound(session, RUN);
  });

  it("swallows an invalid append path", () => {
    const session = beginTcrRound({ ...START, eventsPath: join(dir, "\0bad", "events.ndjson") });
    expect(session).toBeNull();
    completeTcrRound(session, RUN);
  });
});

describe("mintTcrRoundId", () => {
  it("is deterministic for the actual start facts and changes for a new round", () => {
    const round = mintTcrRoundId("a1", 1_000);
    expect(round).toBe(mintTcrRoundId("a1", 1_000));
    expect(round).not.toBe(mintTcrRoundId("a1", 1_001));
  });
});
