/**
 * @responsibility Declares the cycle activity projection types.
 */
/**
 * US-OBS-026 — the standard cycle activity projection type.
 *
 * THREE-STREAM AUTHORITY BOUNDARY (the keystone contract):
 *
 *   1. `events.ndjson` = SINGLE DURABLE TRUTH source.
 *      Every loop cycle appends structured {@link RollEvent}s here;
 *      all state is rebuilt from this stream. Never a cache, never
 *      a secondary store. Runner-written facts (cycle:phase,
 *      cycle:first_edit, cycle:tcr, cycle:stdout, cycle:end, ci:*,
 *      pr:*, peer:gate, attest:gate) are agent-agnostic and durable.
 *
 *   2. `ActivitySignal` = PROJECTION model.
 *      Derived FROM the durable truth (RollEvent stream) OR from a
 *      per-agent raw-stream normalizer. Downstream renderers (watch
 *      window, static archive, cycle ledger) consume ONLY ActivitySignal
 *      — never agent-specific parsing. This is the rich UI model
 *      with tier / seg / summary / result / ref / signalKind.
 *
 *   3. `live.log` = RAW TRANSCRIPT / DEBUG ATTACHMENT.
 *      A passthrough of the agent's stdout. NOT truth — never
 *      participates in judgment, scoring, or evidence decisions.
 *      Debug-only; may be incomplete, truncated, or missing.
 *
 * This module defines {@link CycleActivityEvent} — the STANDARD
 * projection from durable events (events.ndjson) into a structured,
 * agent-agnostic cycle-activity stream. It is a DISCRIMINATED UNION
 * keyed on `kind`, built ON the existing {@link RollEvent} vocabulary
 * (no parallel type system). Every variant carries `cycle_id` / `ts` /
 * `agent` / `payload`.
 *
 * The projection function {@link cycleActivityFromEvents} (in
 * `@roll/core`) maps `RollEvent[] → CycleActivityEvent[]` using ONLY
 * the agent-agnostic durable facts already in events.ndjson. It does
 * NOT depend on any per-agent normalizer — claude, codex, kimi, pi,
 * and future agents all work from the same source of truth.
 */

import type { CyclePhase } from "./cycle.js";

/** The closed set of cycle activity event kinds. */
export type CycleActivityEventKind =
  | "lifecycle"
  | "phase"
  | "tcr"
  | "gate"
  | "stdout"
  | "tool_call"
  | "tool_result"
  | "state_change";

/** Fields common to every CycleActivityEvent. */
export interface CycleActivityBase {
  /** The cycle this event belongs to. */
  cycle_id: string;
  /** Epoch milliseconds. */
  ts: number;
  /** The agent driving this cycle ("" when not yet known). */
  agent: string;
}

/** Lifecycle events: cycle:start, cycle:end, banners. */
export type CycleActivityLifecycle = CycleActivityBase & {
  kind: "lifecycle";
  payload: {
    /** The lifecycle event name (e.g. "cycle:start", "cycle:end"). */
    event: string;
    /** Optional detail string (outcome, storyId, etc.). */
    detail?: string;
  };
};

/** Phase transitions: cycle:phase {phase}. */
export type CycleActivityPhase = CycleActivityBase & {
  kind: "phase";
  payload: {
    /** The CyclePhase the runner transitioned to. */
    phase: CyclePhase;
  };
};

/** TCR commits: cycle:tcr + cycle:first_edit. */
export type CycleActivityTcr = CycleActivityBase & {
  kind: "tcr";
  payload: {
    /** Short (7-9 char) commit hash. */
    commitHash: string;
    /** Commit subject line. */
    message: string;
    /** Git author epoch ms (absent when the runner observation
     *  timestamp is used instead). */
    commitTs?: number;
    /** Whether this is the cycle's first observed commit
     *  (cycle:first_edit). */
    firstEdit?: boolean;
  };
};

/** Gate events: ci:pass/fail, peer:gate, attest:gate, visual:gate. */
export type CycleActivityGate = CycleActivityBase & {
  kind: "gate";
  payload: {
    /** Gate identifier (e.g. "ci", "peer", "attest", "visual"). */
    gate: string;
    /** Verdict: pass / fail / pending / skipped / consulted / produced. */
    verdict: string;
    /** Optional detail (fail summary, reasons, round count). */
    detail?: string;
    /** Optional reference (PR number, agent pair). */
    ref?: string;
  };
};

/** Stdout / heartbeat lines: cycle:stdout. */
export type CycleActivityStdout = CycleActivityBase & {
  kind: "stdout";
  payload: {
    /** The stdout data (may be a heartbeat tag or raw agent output). */
    data: string;
  };
};

/**
 * Tool call — FUTURE (US-OBS-028 per-agent normalization).
 * Present in the type contract so downstream consumers can handle
 * tool granularity when it becomes available, without a schema change.
 */
export type CycleActivityToolCall = CycleActivityBase & {
  kind: "tool_call";
  payload: {
    /** Tool name (e.g. "Bash", "Edit", "Write"). */
    tool: string;
    /** Tool input (opaque; shape varies by agent). */
    input?: unknown;
  };
};

/**
 * Tool result — FUTURE (US-OBS-028 per-agent normalization).
 * Present in the type contract for the same forward-compat reason
 * as {@link CycleActivityToolCall}.
 */
export type CycleActivityToolResult = CycleActivityBase & {
  kind: "tool_result";
  payload: {
    /** Tool name that produced this result. */
    tool: string;
    /** Whether the tool reported an error. */
    isError?: boolean;
    /** One-line summary of the result. */
    summary?: string;
  };
};

/**
 * State change — covers transitions not already expressed as
 * lifecycle / phase / gate events (e.g. route:resolve).
 */
export type CycleActivityStateChange = CycleActivityBase & {
  kind: "state_change";
  payload: {
    /** Previous state label. */
    from: string;
    /** New state label. */
    to: string;
    /** Optional reason for the transition. */
    reason?: string;
  };
};

/**
 * The standard, agent-agnostic cycle activity event — a discriminated
 * union keyed on `kind`. Every variant carries `cycle_id` / `ts` /
 * `agent` / `payload`. Downstream consumers (watch window, cycle
 * ledger, evidence assembler) consume ONLY this type — never
 * agent-specific parsing.
 *
 * Built ON the existing {@link RollEvent} vocabulary; no parallel
 * type system. `tool_call` / `tool_result` are forward-compat slots
 * for per-agent normalization (US-OBS-028); the agent-agnostic
 * projection never emits them.
 */
export type CycleActivityEvent =
  | CycleActivityLifecycle
  | CycleActivityPhase
  | CycleActivityTcr
  | CycleActivityGate
  | CycleActivityStdout
  | CycleActivityToolCall
  | CycleActivityToolResult
  | CycleActivityStateChange;

/**
 * Parse one JSON line into a CycleActivityEvent. Returns null for
 * blank lines, malformed JSON, or objects missing required fields
 * (`kind`, `cycle_id`, `ts`). Callers must skip nulls — never crash
 * (I8: rebuild always succeeds).
 *
 * No diff/patch fields; the contract is a full event stream, not an
 * incremental protocol (AC5).
 */
export function parseCycleActivityLine(line: string): CycleActivityEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (
    typeof rec["kind"] !== "string" ||
    typeof rec["cycle_id"] !== "string" ||
    typeof rec["ts"] !== "number"
  ) {
    return null;
  }
  return obj as CycleActivityEvent;
}
