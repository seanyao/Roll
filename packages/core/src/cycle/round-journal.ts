/**
 * @responsibility Appends per-card per-round mechanical facts to the round journal.
 * US-CYCLE-004 — round-journal: a per-card, per-round, append-only mechanical
 * ledger of who did what for how long with what outcome. "Observe before you
 * optimize": every later efficiency lever needs a baseline, a comparison window
 * (by `era`), and a rollback criterion, and the current gate-time buckets don't
 * reconcile with the 30–60 min/card budget. This is the data spine.
 *
 * Truth source is `round-journal.jsonl` (one JSON object per line, append-only).
 * `round-journal.md` is a human-readable table DERIVED from the jsonl. Distinct
 * from `supervisor:journal` (a global narrative event stream): this is a
 * per-card-per-round machine ledger that reuses the atomic-append discipline,
 * not that event type. See the card spec's "8 questions" for the durability
 * contract (concurrency, schema evolution, bad-line tolerance, cleanup).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile as appendFileAsync, mkdir as mkdirAsync, readFile as readFileAsync } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ROUND_JOURNAL_SCHEMA_VERSION = 1;
export const ROUND_JOURNAL_JSONL = "round-journal.jsonl";
export const ROUND_JOURNAL_MD = "round-journal.md";

/** One row of the ledger: a single role's turn within a card's round. */
export interface RoundJournalEntry {
  schemaVersion: number;
  /** Card id (also implied by file location; kept in-line for portable reads). */
  card: string;
  /**
   * Round index within the card (1-based). OPTIONAL: callers on the hot path
   * omit it (computing it would need a racy read-modify-write count). The
   * readout DERIVES the round from `cycleId` ordering — one cycle = one round —
   * via {@link deriveRounds}, which is race-free and read-free on the hot path.
   */
  round?: number;
  /** builder | evaluator | designer | scorer | gate | … */
  role: string;
  /** Resolved model, when known. */
  model?: string;
  /** Epoch ms when this turn started. */
  start: number;
  /** Wall-clock duration of this turn in ms. */
  durMs: number;
  /** delivered | failed | blocked | passed | timeout | … */
  outcome: string;
  /** Gate (local test/lint/CI-precheck) time attributed to this turn, ms. */
  gateTimeMs?: number;
  /**
   * US-CYCLE-011 — which gate SCOPE this turn's gate time (and its last
   * `.roll/last-test-pass` proof) belongs to: `"changed"` = the per-commit
   * affected/`--changed` subset, `"full"` = the round-tail whole-suite verify. So
   * a readout can bucket gate time `--changed` vs `full` and reconcile it against
   * the total ({@link gateTimeByMode}). Optional + forward-tolerant: older rows
   * carry none; a value other than `changed`/`full` is dropped by the reader.
   */
  gateMode?: "changed" | "full";
  /** Comparison window label (e.g. a dogfood era) so baselines don't drift. */
  era?: string;
  /** Owning cycle id, when known. */
  cycleId?: string;
  /**
   * US-CYCLE-008 — the DECLARED evaluation risk tier for this turn (`low` = single
   * evaluator, `high` = parallel adversarial panel). Present on the evaluator turn
   * so a readout can audit declared-vs-actual evaluation depth. Optional +
   * forward-tolerant (older rows have none; a non-`low|high` value is dropped by
   * the reader).
   */
  tier?: "low" | "high";
  /**
   * US-CYCLE-008 — the ACTUAL panel composition: the evaluator peers a fresh
   * session was spawned for this turn. A one-element list for a low-tier serial
   * evaluation; the bounded parallel pool for a high-tier panel. Paired with
   * `tier` it lets a readout reconcile "declared high → really fanned out to N".
   */
  panel?: string[];
}

/** Fields a caller supplies; schemaVersion is stamped automatically. */
export type RoundJournalInput = Omit<RoundJournalEntry, "schemaVersion">;

function jsonlPath(cardDir: string): string {
  return join(cardDir, ROUND_JOURNAL_JSONL);
}
function mdPath(cardDir: string): string {
  return join(cardDir, ROUND_JOURNAL_MD);
}

/**
 * Append one entry to the card's jsonl ledger and re-render the .md table.
 * Best-effort: NEVER throws — an observability write must not block the cycle's
 * critical path (spawn/gate/delivery). Returns true iff the jsonl line landed.
 *
 * Concurrency: one line per entry via `appendFileSync` (POSIX O_APPEND is atomic
 * for a single write under PIPE_BUF), so concurrent roles/processes never
 * interleave a line. The .md is a derived view re-rendered atomically (tmp +
 * rename); jsonl remains the source of truth.
 */
export function appendRoundEntry(cardDir: string, input: RoundJournalInput): boolean {
  const entry: RoundJournalEntry = { schemaVersion: ROUND_JOURNAL_SCHEMA_VERSION, ...input };
  try {
    mkdirSync(cardDir, { recursive: true });
    const p = jsonlPath(cardDir);
    // Guard against a prior half-written line (a crash mid-append leaves a row
    // with no trailing newline): if the file does not end in "\n", prefix one so
    // this entry lands on its own line instead of concatenating onto the corrupt
    // tail. The corrupt row is then the ONLY casualty (skipped by the reader).
    let prefix = "";
    if (existsSync(p)) {
      try {
        const cur = readFileSync(p, "utf8");
        if (cur.length > 0 && !cur.endsWith("\n")) prefix = "\n";
      } catch {
        /* unreadable → append anyway; reader tolerates */
      }
    }
    appendFileSync(p, `${prefix}${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    return false; // best-effort — do not block delivery on a journal write
  }
  // NOTE: the derived `.md` is intentionally NOT re-rendered here. Rewriting the
  // whole table on every append is O(n) work on a hot path; the jsonl is the
  // source of truth, and the .md is regenerated on demand at read time
  // (`aggregateRounds`/the readout command call `renderRoundJournalMd`). Keeping
  // append to a single bounded line preserves the non-blocking contract (AC2).
  return true;
}

/**
 * Non-blocking append for the hot path (spawn/gate). Uses async fs so the event
 * loop is NEVER blocked — even on a slow/stalled filesystem the I/O yields
 * instead of freezing cycle continuation. Does NOT compute a round (no
 * read-modify-write → no cross-process race); the readout derives rounds from
 * `cycleId`. Best-effort: resolves false on any failure, never rejects.
 */
export async function appendRoundEntryAsync(cardDir: string, input: RoundJournalInput): Promise<boolean> {
  const entry: RoundJournalEntry = { schemaVersion: ROUND_JOURNAL_SCHEMA_VERSION, ...input };
  try {
    await mkdirAsync(cardDir, { recursive: true });
    const p = jsonlPath(cardDir);
    // Half-line guard (async, non-blocking): if the file's last byte isn't "\n",
    // prefix one so this row can't concatenate onto a crash-truncated tail.
    let prefix = "";
    try {
      const cur = await readFileAsync(p, "utf8");
      if (cur.length > 0 && !cur.endsWith("\n")) prefix = "\n";
    } catch {
      /* no file yet / unreadable → append fresh; reader tolerates */
    }
    await appendFileAsync(p, `${prefix}${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false; // best-effort — never block/break the cycle on a journal write
  }
}

export interface ReadResult {
  entries: RoundJournalEntry[];
  /** Count of malformed/half-written lines skipped (bad-line tolerance). */
  skipped: number;
}

/**
 * Assign a display round to each entry: entries sharing a `cycleId` belong to the
 * same round (one cycle = one round of work on the card), numbered 1-based in
 * first-appearance order. Entries with no cycleId keep any explicit `round`, else
 * fall into their own append-order slot. Race-free and read-free on the hot path
 * (derived purely from already-read entries).
 */
export function deriveRounds(entries: readonly RoundJournalEntry[]): (RoundJournalEntry & { round: number })[] {
  // Single monotonic counter shared by BOTH cycle groups and cycle-less entries,
  // so a stored/legacy `round` can never collide with a cycle-derived one. Turns
  // sharing a `cycleId` map to the same round; each cycle-less entry gets its own.
  const cycleRound = new Map<string, number>();
  let next = 0;
  return entries.map((e) => {
    let round: number;
    if (typeof e.cycleId === "string" && e.cycleId !== "") {
      const seen = cycleRound.get(e.cycleId);
      if (seen !== undefined) round = seen;
      else {
        next += 1;
        cycleRound.set(e.cycleId, next);
        round = next;
      }
    } else {
      next += 1;
      round = next;
    }
    return { ...e, round };
  });
}

/**
 * Read all valid entries from the card's jsonl, tolerating malformed lines
 * (a half-written trailing line, a corrupt row) by skipping + counting them.
 * Missing file → empty result. Unknown/older schemaVersion fields are preserved
 * as-is (tolerant reader: never rejects a row for an unexpected field).
 */
export function readRoundEntries(cardDir: string): ReadResult {
  const p = jsonlPath(cardDir);
  if (!existsSync(p)) return { entries: [], skipped: 0 };
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return { entries: [], skipped: 0 };
  }
  const entries: RoundJournalEntry[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      // Required shape: role (string) + finite durMs (number). Anything else is
      // a malformed row (skipped + counted). Extra/unknown fields are preserved
      // for forward-schema tolerance; but SHARED fields the readout relies on
      // are normalized so a hand-corrupted value (e.g. `"era": 1`) can never
      // crash aggregation (localeCompare) or rendering downstream.
      if (raw !== null && typeof raw === "object" && typeof raw["role"] === "string" && typeof raw["durMs"] === "number" && Number.isFinite(raw["durMs"])) {
        const norm = { ...raw } as unknown as RoundJournalEntry;
        if (typeof raw["era"] !== "string") delete (norm as { era?: unknown }).era;
        if (typeof raw["model"] !== "string") delete (norm as { model?: unknown }).model;
        if (typeof raw["outcome"] !== "string") norm.outcome = String(raw["outcome"] ?? "");
        if (typeof raw["round"] !== "number") delete (norm as { round?: unknown }).round;
        // US-CYCLE-008: forward-tolerant normalization for the tier-audit fields.
        // A hand-corrupted `tier` (anything but "low"/"high") or a non-string-array
        // `panel` is dropped so downstream readouts/rendering can never crash on it.
        if (raw["tier"] !== "low" && raw["tier"] !== "high") delete (norm as { tier?: unknown }).tier;
        if (!Array.isArray(raw["panel"]) || !(raw["panel"] as unknown[]).every((p) => typeof p === "string")) {
          delete (norm as { panel?: unknown }).panel;
        }
        // US-CYCLE-011: drop a hand-corrupted gateMode so the gate-time buckets
        // can never crash on an unexpected value.
        if (raw["gateMode"] !== "changed" && raw["gateMode"] !== "full") delete (norm as { gateMode?: unknown }).gateMode;
        entries.push(norm);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

// ─── aggregation / readout ───────────────────────────────────────────────────

export interface RoundStats {
  count: number;
  medianMs: number;
  meanMs: number;
  p90Ms: number;
  /** Sum(gateTimeMs) / Sum(durMs) as a 0..1 share — the "fixed overhead" proxy. */
  gateShare: number;
}

export interface EraStats extends RoundStats {
  era: string;
}

export interface RoundAggregate {
  overall: RoundStats;
  /** Per-era windows, sorted by era label. */
  byEra: EraStats[];
  skipped: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank; deterministic and dependency-free.
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? 0;
}

function statsFor(entries: readonly RoundJournalEntry[]): RoundStats {
  const durs = entries.map((e) => e.durMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const count = durs.length;
  if (count === 0) return { count: 0, medianMs: 0, meanMs: 0, p90Ms: 0, gateShare: 0 };
  const sum = durs.reduce((a, b) => a + b, 0);
  const totalGate = entries.reduce((a, e) => a + (Number.isFinite(e.gateTimeMs) ? (e.gateTimeMs ?? 0) : 0), 0);
  return {
    count,
    medianMs: percentile(durs, 50),
    meanMs: Math.round(sum / count),
    p90Ms: percentile(durs, 90),
    gateShare: sum > 0 ? totalGate / sum : 0,
  };
}

/**
 * US-CYCLE-011 — bucket gate time by gate mode so the local-gate budget line
 * ("5–8 min --changed, full verify at round tail") can be audited. `changed` +
 * `full` + `untagged` (rows with gate time but no `gateMode`) ALWAYS reconcile
 * to `total` — the books can be checked exactly. Only rows carrying a finite
 * positive-or-zero `gateTimeMs` contribute; a row without gate time is ignored
 * (it spent no gate time to bucket).
 */
export interface GateTimeByMode {
  changedMs: number;
  fullMs: number;
  untaggedMs: number;
  totalMs: number;
}

export function gateTimeByMode(entries: readonly RoundJournalEntry[]): GateTimeByMode {
  let changedMs = 0;
  let fullMs = 0;
  let untaggedMs = 0;
  for (const e of entries) {
    const g = e.gateTimeMs;
    // Only positive-or-zero gate time contributes; a negative value is corrupt
    // (a real turn never spends negative time) and is dropped so the buckets and
    // the reconciled total stay honest.
    if (!Number.isFinite(g) || g === undefined || g < 0) continue;
    if (e.gateMode === "changed") changedMs += g;
    else if (e.gateMode === "full") fullMs += g;
    else untaggedMs += g;
  }
  return { changedMs, fullMs, untaggedMs, totalMs: changedMs + fullMs + untaggedMs };
}

/** Aggregate a card's entries overall and split by `era` window. */
export function aggregateRounds(cardDir: string): RoundAggregate {
  const { entries, skipped } = readRoundEntries(cardDir);
  const eras = new Map<string, RoundJournalEntry[]>();
  for (const e of entries) {
    const key = e.era ?? "unknown";
    const bucket = eras.get(key);
    if (bucket) bucket.push(e);
    else eras.set(key, [e]);
  }
  const byEra: EraStats[] = [...eras.entries()]
    .map(([era, es]) => ({ era, ...statsFor(es) }))
    .sort((a, b) => a.era.localeCompare(b.era));
  return { overall: statsFor(entries), byEra, skipped };
}

// ─── human-readable .md view (derived from jsonl) ────────────────────────────

function isoOrDash(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "—";
  }
}

/** Render the derived human table atomically (tmp + rename). */
export function renderRoundJournalMd(cardDir: string, entries: readonly RoundJournalEntry[]): void {
  const lines: string[] = [
    "# Round journal",
    "",
    "> Derived from `round-journal.jsonl` (the append-only source of truth). Do not edit by hand.",
    "",
    "| round | role | model | start | dur (s) | gate (s) | outcome | era |",
    "|------:|------|-------|-------|--------:|---------:|---------|-----|",
  ];
  for (const e of deriveRounds(entries)) {
    const durS = (e.durMs / 1000).toFixed(1);
    const gateS = e.gateTimeMs !== undefined ? (e.gateTimeMs / 1000).toFixed(1) : "—";
    lines.push(
      `| ${e.round} | ${e.role} | ${e.model ?? "—"} | ${isoOrDash(e.start)} | ${durS} | ${gateS} | ${e.outcome} | ${e.era ?? "unknown"} |`,
    );
  }
  lines.push("");
  const target = mdPath(cardDir);
  const tmp = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(tmp, lines.join("\n"), "utf8");
  renameSync(tmp, target);
}

/** One-line-per-era readout string (median/mean/p90/gate-share), for the CLI. */
export function formatRoundReadout(agg: RoundAggregate): string {
  const fmt = (s: RoundStats): string =>
    `n=${s.count} median=${(s.medianMs / 1000).toFixed(1)}s mean=${(s.meanMs / 1000).toFixed(1)}s p90=${(s.p90Ms / 1000).toFixed(1)}s gate=${(s.gateShare * 100).toFixed(0)}%`;
  const out: string[] = [`overall: ${fmt(agg.overall)}`];
  for (const e of agg.byEra) out.push(`era ${e.era}: ${fmt(e)}`);
  if (agg.skipped > 0) out.push(`(${agg.skipped} malformed line(s) skipped)`);
  return out.join("\n");
}
