/**
 * US-DELTA-011 — TCR round observation: precise test/commit timing facts.
 *
 * The TCR execution boundary (`roll test` + the git commit hook) appends the
 * versioned `tcr:*` {@link TcrObservationEvent}s; this module is the pure read
 * side: it folds an event stream into per-round telemetry and derives proof
 * freshness from REAL observation timestamps (test completion → commit) against
 * the existing sixty-second pre-commit rule ({@link FRESHNESS_LIMIT_SECONDS}).
 *
 * Honesty contract (delta-delivery-metrics-design.md §Failure modes):
 *   - proof age is computed from event timestamps, never assumed;
 *   - an absent test-completion fact or a reversed clock is LOUD and UNKNOWN
 *     (`ok:false`), never fabricated into a fresh proof;
 *   - a stream with NO `tcr:*` facts (legacy loops, partial NDJSON) projects as
 *     `status:"incomplete"` with an explicit diagnostic — never as "zero TCR
 *     rounds", which would silently turn a telemetry gap into a delivery signal;
 *   - duplicate rows are surfaced as diagnostics and counted once.
 *
 * Pure: no clock, no FS, no git — the stream is injected.
 */
import {
  parseTcrObservationEvent,
  type RollEvent,
  type TcrCommittedEvent,
  type TcrRoundStartedEvent,
  type TcrTestFinishedEvent,
} from "@roll/spec";
import { FRESHNESS_LIMIT_SECONDS } from "./tcr.js";

/** The existing 60 s pre-commit freshness rule, in milliseconds. */
export const TCR_PROOF_FRESH_LIMIT_MS = FRESHNESS_LIMIT_SECONDS * 1000;

/**
 * The proof-age verdict for one commit. `ok:false` is the loud/unknown shape —
 * the caller must render it as unknown, never as fresh.
 */
export type ProofAge =
  | { ok: true; proofAgeMs: number; fresh: boolean }
  | { ok: false; reason: "missing-test-proof" | "reversed-clock" };

/**
 * Derive proof age from the test-completion timestamp to the commit timestamp.
 *   - no test-completion fact → `missing-test-proof` (unknown, loud);
 *   - commit BEFORE test completion → `reversed-clock` (unknown, loud);
 *   - otherwise the real age, `fresh` iff within the 60 s rule.
 * Pure: both timestamps are injected observation facts.
 */
export function computeProofAge(
  testFinishedTsMs: number | undefined,
  commitTsMs: number,
  limitMs: number = TCR_PROOF_FRESH_LIMIT_MS,
): ProofAge {
  if (testFinishedTsMs === undefined) return { ok: false, reason: "missing-test-proof" };
  const age = commitTsMs - testFinishedTsMs;
  if (age < 0) return { ok: false, reason: "reversed-clock" };
  return { ok: true, proofAgeMs: age, fresh: age <= limitMs };
}

/** Per-round TCR telemetry projected from the `tcr:*` observation stream. */
export interface TcrRoundTelemetry {
  readonly roundId: string;
  readonly storyId: string;
  readonly delegationId?: string;
  /** complete = test_finished AND committed facts both present. */
  readonly status: "complete" | "incomplete";
  /** true iff a test fact exists and its exit code is 0. */
  readonly green: boolean;
  /** Wall time of the test run, when a test fact exists. */
  readonly testWallMs?: number;
  /** Proof freshness, derivable only when a commit fact exists. */
  readonly proof?: ProofAge;
  readonly diagnostics: readonly string[];
}

/** Stream-level TCR telemetry. `status:"incomplete"` is the honest legacy shape. */
export interface TcrTelemetry {
  readonly schemaVersion: 1;
  readonly status: "ok" | "incomplete";
  readonly rounds: readonly TcrRoundTelemetry[];
  readonly diagnostics: readonly string[];
}

interface RoundAcc {
  started?: TcrRoundStartedEvent;
  test?: TcrTestFinishedEvent;
  commit?: TcrCommittedEvent;
}

/**
 * Fold an event stream into per-round TCR telemetry. Rows that fail strict
 * parsing are skipped with a diagnostic (a partial/corrupt NDJSON line degrades
 * the result to incomplete — it never silently changes a denominator).
 * Duplicate (roundId, type) rows keep the first and surface a diagnostic.
 */
export function projectTcrTelemetry(events: readonly RollEvent[]): TcrTelemetry {
  const diagnostics: string[] = [];
  const roundOrder: string[] = [];
  const rounds = new Map<string, RoundAcc>();
  const seenRows = new Set<string>();
  let sawTcrRow = false;

  for (const ev of events) {
    if (typeof ev?.type !== "string" || !ev.type.startsWith("tcr:")) continue;
    sawTcrRow = true;
    const parsed = parseTcrObservationEvent(ev);
    if (parsed === null) {
      diagnostics.push(`invalid tcr observation row of type ${ev.type} — skipped (telemetry incomplete)`);
      continue;
    }
    const rowKey = `${parsed.roundId}	${parsed.type}`;
    if (seenRows.has(rowKey)) {
      diagnostics.push(`duplicate ${parsed.type} for round ${parsed.roundId} — kept first occurrence`);
      continue;
    }
    seenRows.add(rowKey);
    let acc = rounds.get(parsed.roundId);
    if (acc === undefined) {
      acc = {};
      rounds.set(parsed.roundId, acc);
      roundOrder.push(parsed.roundId);
    }
    switch (parsed.type) {
      case "tcr:round_started":
        acc.started = parsed;
        break;
      case "tcr:test_finished":
        acc.test = parsed;
        break;
      case "tcr:committed":
        acc.commit = parsed;
        break;
    }
  }

  if (!sawTcrRow) {
    diagnostics.push(
      "no-tcr-observations: the stream carries no tcr:* facts — TCR telemetry is incomplete, not zero rounds",
    );
  }

  const out: TcrRoundTelemetry[] = [];
  for (const roundId of roundOrder) {
    const acc = rounds.get(roundId)!;
    const anchor = acc.started ?? acc.test ?? acc.commit!;
    const roundDiags: string[] = [];
    if (acc.test === undefined) roundDiags.push("missing tcr:test_finished fact for this round");
    if (acc.commit === undefined) roundDiags.push("missing tcr:committed fact for this round");
    const proof =
      acc.commit !== undefined ? computeProofAge(acc.test?.ts, acc.commit.ts) : undefined;
    if (proof !== undefined && !proof.ok) {
      roundDiags.push(`proof freshness unknown: ${proof.reason}`);
    }
    const complete = acc.test !== undefined && acc.commit !== undefined;
    out.push({
      roundId,
      storyId: anchor.storyId,
      ...(anchor.delegationId !== undefined ? { delegationId: anchor.delegationId } : {}),
      status: complete ? "complete" : "incomplete",
      green: acc.test !== undefined && acc.test.exitCode === 0,
      ...(acc.test !== undefined ? { testWallMs: acc.test.wallMs } : {}),
      ...(proof !== undefined ? { proof } : {}),
      diagnostics: roundDiags,
    });
  }

  const status =
    sawTcrRow && out.length > 0 && out.every((r) => r.status === "complete") ? "ok" : "incomplete";
  return { schemaVersion: 1, status, rounds: out, diagnostics };
}
