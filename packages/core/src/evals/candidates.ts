/**
 * @responsibility Ranks evaluation candidates from recorded feedback signals.
 * Eval candidates — 连续低分 → 待人确认候选 (Goodhart 护栏, US-CORE-013).
 *
 * Direct port of the SIGNAL-emission half of `lib/loop_result_eval.py`
 * (detect_signals, lines 253-335; the signal metadata, lines 254-267). Pure
 * DETECTION: an ordered (oldest→newest) list of result_eval records in, a list
 * of structured improvement SIGNALS out. It never writes the brief, never
 * touches the backlog, never dedups against history — that side-effecting wiring
 * is the loop's (bin/roll dedups on each signal's stable `key`).
 *
 * Goodhart guardrail / human-on-the-loop invariant: a signal is ADVISORY only.
 * It seeds a candidate backlog DRAFT marked 📋 待人确认 (waiting for human
 * confirmation) and is surfaced in the brief — NEVER auto-activating a story,
 * auto-editing code, or auto-modifying the backlog. The candidate writer is
 * injected so core emits the decision + the draft text and the caller persists
 * it (to a signals artifact) without core doing I/O.
 *
 * Detection (py detect_signals, lines 283-335): for each dimension IN
 * {@link DIMENSIONS} ORDER, walk the records newest→oldest counting a LEADING run
 * of known-low (== 0.0) scores; an `unknown`/null score is SKIPPED (neither
 * extends nor breaks the run, so a missing CI signal can't mask a real failing
 * streak); a known-good (> 0.0) score BREAKS the run. A run >= `streak` (default
 * 3) fires one signal. Signals come back in DIMENSIONS order (deterministic,
 * locale-independent).
 */
import { DIMENSIONS, UNKNOWN } from "./score.js";

/** Consecutive low cycles required to fire a signal (py SIGNAL_STREAK = 3). */
export const SIGNAL_STREAK = 3;

/** Per-dimension signal metadata (py _SIGNAL_META, lines 260-267): the candidate
 *  backlog item kind (FIX vs IDEA) + a human-facing description of the streak. */
export const SIGNAL_META: Record<string, { kind: "FIX" | "IDEA"; why: string }> = {
  outcome: { kind: "FIX", why: "cycles keep failing to merge into main" },
  correctness: { kind: "FIX", why: "produced PRs keep failing CI" },
  scope_fidelity: { kind: "IDEA", why: "cycles keep going idle or off-scope" },
  quality: { kind: "FIX", why: "cycles keep landing without test activity" },
  efficiency: { kind: "IDEA", why: "cycles keep blowing past their est_min budget" },
  cleanliness: { kind: "FIX", why: "cycles keep leaving orphans / raising ALERTs" },
};

/** A result_eval block (or a full runs record wrapping one). */
export interface EvalRecord {
  result_eval?: { score?: number; dims?: Record<string, unknown> };
  score?: number;
  dims?: Record<string, unknown>;
  [k: string]: unknown;
}

/** One improvement signal (py detect_signals output dict, lines 328-334). */
export interface ImprovementSignal {
  /** Stable id for dedup (`lowdim:<dim>`). */
  key: string;
  dim: string;
  kind: "FIX" | "IDEA";
  /** How many consecutive low cycles (the actual run length, may exceed streak). */
  streak: number;
  /** One-line human description (`<why> for <n> cycles in a row`). */
  summary: string;
}

/**
 * Pull a usable result_eval block out of a record, or null (py _result_eval_of,
 * lines 270-280): accepts a full runs record (`{result_eval:{dims}}`) or a bare
 * block (`{dims}`); requires `dims` to be an object.
 */
function resultEvalOf(record: EvalRecord | null | undefined): { dims: Record<string, unknown> } | null {
  if (record === null || record === undefined || typeof record !== "object") return null;
  const ev = (record.result_eval ?? record) as { dims?: unknown };
  if (ev !== null && typeof ev === "object" && typeof ev.dims === "object" && ev.dims !== null) {
    return { dims: ev.dims as Record<string, unknown> };
  }
  return null;
}

/**
 * Detect repeated-low-score patterns over an ordered (oldest→newest) record
 * list (py detect_signals, lines 283-335). `streak` < 1 is clamped to 1
 * (py lines 306-307); non-integer falls back to {@link SIGNAL_STREAK}.
 *
 * For each dimension, count the leading newest→oldest run of known-low (0.0)
 * scores, skipping `unknown`/null, breaking on a known-good score. A run >=
 * streak emits a signal. Returns signals in {@link DIMENSIONS} order.
 */
export function detectSignals(records: readonly (EvalRecord | null | undefined)[], streak: number = SIGNAL_STREAK): ImprovementSignal[] {
  let s = Number.isInteger(streak) ? streak : SIGNAL_STREAK;
  if (s < 1) s = 1;

  const evals = (records ?? [])
    .map((r) => resultEvalOf(r))
    .filter((e): e is { dims: Record<string, unknown> } => e !== null);

  const signals: ImprovementSignal[] = [];
  for (const [name] of DIMENSIONS) {
    let run = 0;
    for (let i = evals.length - 1; i >= 0; i--) {
      const dims = evals[i]?.dims ?? {};
      const v = name in dims ? dims[name] : UNKNOWN;
      if (v === UNKNOWN || v === null || v === undefined) continue; // skip unknown
      const fv = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(fv)) continue; // py float() failure → skip (continue)
      if (fv <= 0.0) run += 1;
      else break; // known-good breaks the streak
    }
    if (run >= s) {
      const meta = SIGNAL_META[name] ?? { kind: "IDEA" as const, why: "repeated low score" };
      signals.push({
        key: `lowdim:${name}`,
        dim: name,
        kind: meta.kind,
        streak: run,
        summary: `${meta.why} for ${run} cycles in a row`,
      });
    }
  }
  return signals;
}

// ── Candidate draft (human-on-the-loop: 待人确认, never auto-modifies backlog) ──

/** The status marker every candidate draft carries — waiting for human confirm
 *  (mirrors bin/roll:10264 `待人确认`). It is NEVER 📋 Todo: the picker must not
 *  pick it until a human promotes it. */
export const CANDIDATE_STATUS = "📋 待人确认";

/** A candidate backlog draft derived from a signal — advisory, awaiting human. */
export interface CandidateDraft {
  /** The signal's stable key (dedup anchor). */
  key: string;
  dim: string;
  kind: "FIX" | "IDEA";
  status: typeof CANDIDATE_STATUS;
  /** Draft row text for the signals artifact. */
  text: string;
}

/**
 * Turn a signal into a candidate DRAFT marked 待人确认 (never auto-activated).
 * Mirrors the brief's candidate line (bin/roll:10264): the loop emits a draft
 * for human confirmation; only a human promotes it to 📋 Todo. Pure: returns the
 * draft; the injected writer (below) persists it.
 */
export function candidateFromSignal(signal: ImprovementSignal): CandidateDraft {
  return {
    key: signal.key,
    dim: signal.dim,
    kind: signal.kind,
    status: CANDIDATE_STATUS,
    text:
      `${signal.kind} candidate (${CANDIDATE_STATUS}): ${signal.summary}. ` +
      "Confirm by a human before activating — never auto-added to the backlog.",
  };
}

/** Injected sink that persists a candidate draft to a signals artifact. Core
 *  never writes files; the adapter does. Idempotency/dedup (on `draft.key`) is
 *  the writer's job, mirroring bin/roll's per-key dedup. */
export type CandidateWriter = (draft: CandidateDraft) => void;

/**
 * End-to-end: detect signals over records, turn each into a 待人确认 candidate
 * draft, and hand each to the injected `writer`. Returns the drafts (for the
 * brief). NEVER touches the backlog — human-on-the-loop invariant.
 */
export function emitCandidates(
  records: readonly (EvalRecord | null | undefined)[],
  writer: CandidateWriter,
  streak: number = SIGNAL_STREAK,
): CandidateDraft[] {
  const drafts = detectSignals(records, streak).map(candidateFromSignal);
  for (const d of drafts) writer(d);
  return drafts;
}
