/**
 * US-CYCLE-006 — run-time mis-sizing signal. A card that needed more than the
 * repair threshold of rounds is a SIZING error surfaced late: it should have been
 * split at design time. This turns that into a feedback loop — an automatic
 * `split-advice.md` (built from round-journal FACTS, never model guesswork) fed
 * back to the design side. Signal ONLY: it never mutates backlog or spec.
 *
 * Idempotent: the advice content is a deterministic function of the journal, and
 * {@link writeSplitAdvice} rewrites only when the content actually changed, so a
 * re-run never duplicates.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { deriveRounds, readRoundEntries } from "@roll/core";

/** Distinct journal rounds STRICTLY above this ⇒ advice. A 3-round card trips it. */
export const REPAIR_ROUNDS_THRESHOLD = 2;

/** The per-card advice file name (lives beside the card's spec). */
export const SPLIT_ADVICE_FILE = "split-advice.md";

export interface RoundTheme {
  round: number;
  /** Journal facts for this round — the roles that ran and how each ended. */
  roles: { role: string; outcome: string }[];
}

export interface SplitAdvice {
  card: string;
  /** Distinct rounds observed in the round-journal. */
  roundCount: number;
  rounds: RoundTheme[];
}

/**
 * Analyze a card's round-journal. Returns advice iff the distinct-round count
 * exceeds {@link REPAIR_ROUNDS_THRESHOLD}; otherwise null (no signal). Pure read.
 */
export function analyzeRepairRounds(cardDir: string, cardId: string): SplitAdvice | null {
  const { entries } = readRoundEntries(cardDir);
  if (entries.length === 0) return null;
  const byRound = new Map<number, { role: string; outcome: string }[]>();
  for (const e of deriveRounds(entries)) {
    const arr = byRound.get(e.round) ?? [];
    arr.push({ role: e.role, outcome: e.outcome });
    byRound.set(e.round, arr);
  }
  const roundCount = byRound.size;
  if (roundCount <= REPAIR_ROUNDS_THRESHOLD) return null;
  const rounds = [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, roles]) => ({ round, roles }));
  return { card: cardId, roundCount, rounds };
}

/** Render the advice as deterministic markdown (facts-only, no model prose). */
export function renderSplitAdviceMd(advice: SplitAdvice): string {
  const lines: string[] = [
    `# Split advice — ${advice.card}`,
    "",
    "> Auto-generated from the round-journal (US-CYCLE-006). Signal only — this file",
    "> never changes the backlog or the spec; a human decides whether to split.",
    "",
    `This card ran **${advice.roundCount} rounds** (repair threshold is ${REPAIR_ROUNDS_THRESHOLD}). Needing more`,
    "than the threshold is a sizing signal: the card was likely too big for one",
    "builder session and should have been split at design time.",
    "",
    "## Per-round outcomes (round-journal facts)",
    "",
  ];
  for (const r of advice.rounds) {
    const themes = r.roles.map((x) => `${x.role}→${x.outcome}`).join(", ");
    lines.push(`- round ${r.round}: ${themes === "" ? "(no role entries)" : themes}`);
  }
  lines.push(
    "",
    "## Suggested split",
    "",
    `Consider splitting into ${Math.max(2, advice.roundCount - 1)}–${advice.roundCount} cards, each satisfiable in one`,
    "builder session (see US-CYCLE-005 granularity limits). Draw the boundary along",
    "the outcome dimensions that repeatedly failed above (each recurring failed role",
    "/ AC group is a candidate slice).",
    "",
  );
  return lines.join("\n");
}

/**
 * Write `split-advice.md` beside the card's spec, IDEMPOTENTLY: if an identical
 * file already exists it is left untouched (`written: false`), so a re-run never
 * duplicates. Returns the path (repo-relative when possible) and whether it wrote.
 */
export function writeSplitAdvice(cardDir: string, advice: SplitAdvice): { path: string; written: boolean } {
  const path = join(cardDir, SPLIT_ADVICE_FILE);
  const content = renderSplitAdviceMd(advice);
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === content) return { path, written: false };
    } catch {
      /* unreadable → overwrite below */
    }
  }
  writeFileSync(path, content, "utf8");
  return { path, written: true };
}

/**
 * US-CYCLE-006 auto-trigger: analyze the card's journal and write advice if it is
 * over the threshold. Idempotent (delegates to {@link writeSplitAdvice}). Returns
 * the advice + whether the file changed, or null when no advice is warranted.
 * Called from the round-journal write path so the signal is AUTOMATIC — a card
 * that crosses the threshold produces advice with no manual command.
 */
export function maybeWriteSplitAdvice(cardDir: string, cardId: string): { advice: SplitAdvice; path: string; written: boolean } | null {
  const advice = analyzeRepairRounds(cardDir, cardId);
  if (advice === null) return null;
  const { path, written } = writeSplitAdvice(cardDir, advice);
  return { advice, path, written };
}

/** List every card that currently carries a pending `split-advice.md`. */
export function listPendingSplitAdvice(repoCwd: string): { card: string; epic: string; path: string }[] {
  const featuresDir = join(repoCwd, ".roll", "features");
  const out: { card: string; epic: string; path: string }[] = [];
  if (!existsSync(featuresDir)) return out;
  for (const epic of safeDirs(featuresDir)) {
    const epicDir = join(featuresDir, epic);
    for (const card of safeDirs(epicDir)) {
      const p = join(epicDir, card, SPLIT_ADVICE_FILE);
      if (existsSync(p)) out.push({ card, epic, path: relative(repoCwd, p) });
    }
  }
  return out.sort((a, b) => a.card.localeCompare(b.card));
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
