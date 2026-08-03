/**
 * US-DELTA-011 — the `roll test` side of the TCR observation boundary.
 *
 * One `roll test` gate run is ONE Builder TCR round, observed as a begin/complete
 * pair: {@link beginTcrRound} appends `tcr:round_started` BEFORE the command
 * runs, so the round id can be carried into the proof writer; {@link
 * completeTcrRound} appends `tcr:test_finished` from the real result. Output is
 * persisted ONLY as a sha256 digest — raw test output never enters an event row.
 *
 * Association is honest: a story-less invocation (no ROLL_STORY_ID) begins NO
 * round — the stream simply carries no fact, which the
 * projection reads as incomplete telemetry, never as a fabricated round.
 *
 * Best-effort throughout: observation must NEVER fail or delay the test gate —
 * any I/O error resolves to null / a swallowed append instead of throwing into
 * the caller.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serializeEvent } from "@roll/core";
import type { TcrObservationEvent } from "@roll/spec";

/** Facts known at round start, before the test command runs. */
export interface TcrRoundStart {
  /** Owning story; undefined/empty ⇒ no round (association only when known). */
  storyId?: string;
  /** Host-guided delegation, when the host propagated it. */
  delegationId?: string;
  /** Executing host/model identity; "unknown" when not propagated — never guessed. */
  hostId: string;
  modelId: string;
  /** HEAD at round start. */
  headSha: string;
  startedMs: number;
  /** The repo event stream to append to. */
  eventsPath: string;
}

/** A live round: the correlation handle the caller threads to round end. */
export interface TcrRoundSession {
  readonly roundId: string;
  readonly storyId: string;
  readonly delegationId?: string;
  readonly hostId: string;
  readonly modelId: string;
  readonly headSha: string;
  readonly startedMs: number;
  readonly eventsPath: string;
}

/** The measured facts of the finished test run. All timestamps epoch ms. */
export interface TcrRoundRun {
  finishedMs: number;
  /** The command that actually ran (after any conservative fallback). */
  command: string;
  /** The gate scope that ran (affected | changed | full | custom). */
  affectedScope: string;
  exitCode: number;
  /** Raw combined output — DIGESTED, never persisted. */
  output: string;
}

/** sha256 hex digest of a text blob — the only output representation allowed in events. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Mint the round id from real start inputs, never random. It is minted before
 * the command runs so it can reach the proof writer via ROLL_TCR_ROUND_ID.
 */
export function mintTcrRoundId(headSha: string, startedMs: number): string {
  return `tcr-${startedMs}-${sha256Text(`${headSha}|${startedMs}`).slice(0, 12)}`;
}

function appendEvents(eventsPath: string, events: readonly TcrObservationEvent[]): boolean {
  try {
    mkdirSync(dirname(eventsPath), { recursive: true });
    appendFileSync(eventsPath, events.map((ev) => serializeEvent(ev)).join(""), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Begin the round and return its correlation handle. If the story is unknown or
 * appending fails, return null; the gate result remains authoritative.
 */
export function beginTcrRound(start: TcrRoundStart): TcrRoundSession | null {
  if (start.storyId === undefined || start.storyId === "") return null;
  const roundId = mintTcrRoundId(start.headSha, start.startedMs);
  const event: TcrObservationEvent = {
    type: "tcr:round_started", v: 1, storyId: start.storyId,
    ...(start.delegationId !== undefined ? { delegationId: start.delegationId } : {}),
    roundId, role: "builder", hostId: start.hostId, modelId: start.modelId,
    headSha: start.headSha, ts: start.startedMs,
  };
  if (!appendEvents(start.eventsPath, [event])) return null;
  return { roundId, storyId: start.storyId,
    ...(start.delegationId !== undefined ? { delegationId: start.delegationId } : {}),
    hostId: start.hostId, modelId: start.modelId, headSha: start.headSha,
    startedMs: start.startedMs, eventsPath: start.eventsPath };
}

/** Complete the round with the real result. A null session is a deliberate no-op. */
export function completeTcrRound(session: TcrRoundSession | null, run: TcrRoundRun): void {
  if (session === null) return;
  const event: TcrObservationEvent = {
    type: "tcr:test_finished", v: 1, storyId: session.storyId,
    ...(session.delegationId !== undefined ? { delegationId: session.delegationId } : {}),
    roundId: session.roundId, command: run.command, affectedScope: run.affectedScope,
    exitCode: run.exitCode, wallMs: run.finishedMs - session.startedMs,
    outputSha256: sha256Text(run.output), ts: run.finishedMs,
  };
  appendEvents(session.eventsPath, [event]);
}
