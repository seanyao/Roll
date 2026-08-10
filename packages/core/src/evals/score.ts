/**
 * @responsibility Computes bounded evaluation scores from normalized evidence.
 * Evals — six-dimension cycle quality score (US-CORE-012).
 *
 * Direct port of the scoring half of `lib/loop_result_eval.py` (read FULLY).
 * Pure: cycle FACTS in, the `result_eval` block out — no fact collection, no
 * runs.jsonl, no git/gh (that wiring is the loop's, mirroring the py's split).
 *
 * Rubric (loop_result_eval.py:80-87 `DIMENSIONS`) — name → weight:
 *   outcome 3 · correctness 2 · scope_fidelity 2 · quality 1 · efficiency 1 ·
 *   cleanliness 1. Each dimension scores 0..1 from facts, or the {@link UNKNOWN}
 *   sentinel when its required facts are absent (缺数据 ≠ 0 分). Unknown dims are
 *   EXCLUDED from the weighted sum and the remaining weights renormalised
 *   (loop_result_eval.py:208-225), so a missing fact never silently scores 0.
 *
 * Rollup (loop_result_eval.py:38-42, 208-225):
 *   weighted = Σ(score_i · weight_i) / Σ(weight_i)   over KNOWN dims, 0..1
 *   cycle_score = round(1 + weighted · 9)            → int 1..10
 *   all-unknown → neutral midpoint 5.
 *
 * Rounding: the py uses Python3 `round()` (banker's rounding, round-half-to-even)
 * on `1 + weighted*9`, then `int()`. {@link roundHalfEven} reproduces that
 * exactly so the score byte-matches the oracle. JSON output mirrors
 * `score_cycle` (loop_result_eval.py:228-235): `{version, score, dims}` where a
 * known dim is a float 0..1 and an unknown dim is the literal string "unknown".
 */

/** Sentinel for a dimension whose facts are unavailable (py UNKNOWN, line 72). */
export const UNKNOWN = "unknown" as const;
export type DimScore = number | typeof UNKNOWN;

/** Schema version stamped into the result_eval block (py SCHEMA_VERSION = 1). */
export const SCHEMA_VERSION = 1;

/** Rubric: dimension → weight, IN ORDER (py DIMENSIONS, lines 80-87). Order is
 *  load-bearing: aggregate + output iterate in this exact order (deterministic,
 *  locale-independent). */
export const DIMENSIONS: ReadonlyArray<readonly [string, number]> = [
  ["outcome", 3.0],
  ["correctness", 2.0],
  ["scope_fidelity", 2.0],
  ["quality", 1.0],
  ["efficiency", 1.0],
  ["cleanliness", 1.0],
];

/** Cycle facts the rubric scores. All optional — absence drives UNKNOWN. Mirrors
 *  the keys the py's `facts.get(...)` reads. */
export interface EvalCycleFacts {
  status?: string;
  merged?: boolean;
  ci?: string | null;
  routed_story?: string;
  built?: string[];
  tcr_count?: number | string | null;
  rework_fix?: unknown;
  duration_sec?: number | string | null;
  est_min?: number | string | null;
  alerts?: unknown[];
  orphans?: unknown[];
}

/** The `result_eval` block (py score_cycle, lines 228-235). */
export interface ResultEval {
  version: number;
  score: number;
  dims: Record<string, DimScore>;
}

// ── Per-dimension scorers (1:1 with the py _score_* functions) ───────────────

/** py _truthy_merged (lines 92-96): status=="merged" (case-insensitive, trimmed)
 *  OR a truthy `merged` flag. */
function truthyMerged(f: EvalCycleFacts): boolean {
  if (String(f.status ?? "").trim().toLowerCase() === "merged") return true;
  return Boolean(f.merged);
}

/** outcome (py _score_outcome, lines 99-104): UNKNOWN only when there is no
 *  signal at all (no `merged` key AND falsy `status`); else 1.0 merged / 0.0. */
function scoreOutcome(f: EvalCycleFacts): DimScore {
  const hasMergedKey = Object.prototype.hasOwnProperty.call(f, "merged");
  if (!hasMergedKey && !f.status) return UNKNOWN;
  return truthyMerged(f) ? 1.0 : 0.0;
}

/** correctness (py _score_correctness, lines 107-117): CI verdict → 1.0 green /
 *  0.0 red / UNKNOWN otherwise (incl. empty). */
function scoreCorrectness(f: EvalCycleFacts): DimScore {
  const ci = f.ci;
  if (ci === null || ci === undefined || String(ci).trim() === "") return UNKNOWN;
  const v = String(ci).trim().toLowerCase();
  if (v === "green" || v === "pass" || v === "passing" || v === "success") return 1.0;
  if (v === "red" || v === "fail" || v === "failing" || v === "failure") return 0.0;
  return UNKNOWN;
}

/** scope_fidelity (py _score_scope_fidelity, lines 120-135): idle / no routed
 *  story → 0.0; routed AND present in built[] → 1.0; routed but not built → 0.0.
 *  Never UNKNOWN. */
function scoreScopeFidelity(f: EvalCycleFacts): DimScore {
  const status = String(f.status ?? "").trim().toLowerCase();
  if (status === "idle" || !f.routed_story) return 0.0;
  const built = Array.isArray(f.built) ? f.built : [];
  const routed = f.routed_story;
  if (Array.isArray(built) && routed !== undefined && built.includes(routed)) return 1.0;
  return 0.0;
}

/** quality (py _score_quality, lines 138-155): tcr_count missing/unparseable →
 *  UNKNOWN; <=0 → 0.0; >=1 with rework_fix → 0.5; >=1 clean → 1.0. */
function scoreQuality(f: EvalCycleFacts): DimScore {
  const tcrRaw = f.tcr_count;
  if (tcrRaw === null || tcrRaw === undefined) return UNKNOWN;
  // py int(tcr): accepts int or a numeric string; floats truncate; else UNKNOWN.
  const tcr = pyInt(tcrRaw);
  if (tcr === null) return UNKNOWN;
  if (tcr <= 0) return 0.0;
  if (f.rework_fix) return 0.5;
  return 1.0;
}

/** efficiency (py _score_efficiency, lines 158-180): UNKNOWN when duration_sec or
 *  est_min missing/unparseable or budget<=0; within budget → 1.0; over budget
 *  graded `1 - (overrun-1)*0.4` clamped to [0.2, 1.0]. */
function scoreEfficiency(f: EvalCycleFacts): DimScore {
  const durRaw = f.duration_sec;
  const estRaw = f.est_min;
  if (durRaw === null || durRaw === undefined || estRaw === null || estRaw === undefined) return UNKNOWN;
  const durationSec = pyFloat(durRaw);
  const budget = pyFloat(estRaw);
  if (durationSec === null || budget === null) return UNKNOWN;
  if (budget <= 0) return UNKNOWN;
  const durationMin = durationSec / 60.0;
  if (durationMin <= budget) return 1.0;
  const overrun = durationMin / budget; // > 1
  const graded = 1.0 - (overrun - 1.0) * 0.4;
  return Math.max(0.2, Math.min(1.0, graded));
}

/** cleanliness (py _score_cleanliness, lines 183-189): any alerts or orphans →
 *  0.0; else 1.0. */
function scoreCleanliness(f: EvalCycleFacts): DimScore {
  const alerts = Array.isArray(f.alerts) ? f.alerts : [];
  const orphans = Array.isArray(f.orphans) ? f.orphans : [];
  if (alerts.length > 0 || orphans.length > 0) return 0.0;
  return 1.0;
}

const SCORERS: Record<string, (f: EvalCycleFacts) => DimScore> = {
  outcome: scoreOutcome,
  correctness: scoreCorrectness,
  scope_fidelity: scoreScopeFidelity,
  quality: scoreQuality,
  efficiency: scoreEfficiency,
  cleanliness: scoreCleanliness,
};

// ── Python-faithful numeric coercion ─────────────────────────────────────────

/** Mirror Python `int(x)` over the values facts carry: ints pass; numeric
 *  strings parse (base-10, trimmed); floats truncate toward zero; anything else
 *  → null (the py catches TypeError/ValueError → UNKNOWN). */
function pyInt(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? Math.trunc(x) : null;
  if (typeof x === "boolean") return x ? 1 : 0; // py int(True)==1 (bool is int).
  if (typeof x === "string") {
    const t = x.trim();
    if (!/^[+-]?\d+$/.test(t)) return null; // py int("1.5") raises; only integers.
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Mirror Python `float(x)`: numbers pass; numeric strings parse; else null. */
function pyFloat(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "string") {
    const t = x.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Round half to even (banker's rounding) — reproduces Python3 `round()`. The py
 *  rounds `1 + weighted*9` then `int()`s; we apply round-half-even then truncate
 *  (the value is already an integer after rounding, so int() is a no-op). */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exactly .5 → round to even.
  return floor % 2 === 0 ? floor : floor + 1;
}

// ── Public scoring API (1:1 with py score_dimensions / aggregate / score_cycle)

/** Score every rubric dimension (py score_dimensions, lines 202-205). Returns a
 *  record keyed in {@link DIMENSIONS} order. */
export function scoreDimensions(facts: EvalCycleFacts): Record<string, DimScore> {
  const f = facts ?? {};
  const out: Record<string, DimScore> = {};
  for (const [name] of DIMENSIONS) {
    const scorer = SCORERS[name];
    if (scorer !== undefined) out[name] = scorer(f);
  }
  return out;
}

/**
 * Roll per-dimension scores into a 1..10 cycle score (py aggregate, lines
 * 208-225). Unknown dims excluded, remaining weights renormalised; all-unknown →
 * neutral 5. Uses Python-faithful round-half-even (py `round()`).
 */
export function aggregate(dims: Record<string, DimScore>): number {
  let num = 0;
  let den = 0;
  for (const [name, weight] of DIMENSIONS) {
    const s = dims[name] ?? UNKNOWN;
    if (s === UNKNOWN) continue;
    num += s * weight;
    den += weight;
  }
  if (den === 0) return 5;
  const weighted = num / den; // 0..1
  return roundHalfEven(1 + weighted * 9);
}

/** Compute the full result_eval block for one cycle's facts (py score_cycle). */
export function scoreCycle(facts: EvalCycleFacts): ResultEval {
  const dims = scoreDimensions(facts);
  return { version: SCHEMA_VERSION, score: aggregate(dims), dims };
}
