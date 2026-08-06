/**
 * @responsibility Reports the screenshot_exempt rate as an observability signal.
 */
/**
 * US-EVID-026 — screenshot_exempt rate as an observability signal.
 *
 * 27% of cards self-exempt from visual evidence; if exemption quietly creeps
 * back to "the easy default", the acceptance bar erodes. This surfaces the rate
 * (overall + per epic) as a SMELL signal — never a gate — so a drift back up is
 * visible. Pure read of `.roll/features/<epic>/<id>/spec.md`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface EpicExemption {
  epic: string;
  total: number;
  exempt: number;
}

export interface ExemptionStats {
  total: number;
  exempt: number;
  /** exempt / total in [0,1]; 0 when total is 0. */
  rate: number;
  byEpic: EpicExemption[];
}

/** The spec frontmatter body, tolerant of a BOM, leading blank lines, and
 *  trailing spaces on the `---` fences. Returns null when there is no block. */
function frontmatter(specText: string): string | null {
  const t = specText.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^\s*---[ \t]*\n([\s\S]*?)\n[ \t]*---[ \t]*(?:\n|$)/.exec(t);
  return m === null ? null : (m[1] ?? "");
}

/**
 * Single source of truth for reading a card's exemption. A REAL exemption is
 * `screenshot_exempt:` with a non-empty, non-boolean reason (a naked
 * true/false/yes/no is NOT a valid exemption). Comments and quotes are stripped.
 */
export function readExemption(specText: string): { exempt: boolean; reason: string } {
  const fm = frontmatter(specText);
  if (fm === null) return { exempt: false, reason: "" };
  const m = /^screenshot_exempt:[ \t]*(.+)$/m.exec(fm);
  if (m === null) return { exempt: false, reason: "" };
  const reason = (m[1] ?? "").replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const exempt = reason !== "" && !/^(false|no|0|true|yes|on|1)$/i.test(reason);
  return { exempt, reason: exempt ? reason : "" };
}

/** A card carries a REAL exemption iff `screenshot_exempt:` has a non-boolean reason. */
export function specIsExempt(specText: string): boolean {
  return readExemption(specText).exempt;
}

/**
 * Walk every card spec under `.roll/features/<epic>/<id>/spec.md`. Shared by the
 * stats and audit readers so the corpus is walked one way. Best-effort — an
 * unreadable features dir / epic / spec is skipped, never throws.
 */
export function* cardSpecs(repoCwd: string): Iterable<{ epic: string; id: string; specText: string }> {
  const featuresDir = join(repoCwd, ".roll", "features");
  let epics: string[];
  try {
    epics = readdirSync(featuresDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  for (const epic of epics) {
    let ids: string[];
    try {
      ids = readdirSync(join(featuresDir, epic), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const id of ids) {
      try {
        yield { epic, id, specText: readFileSync(join(featuresDir, epic, id, "spec.md"), "utf8") };
      } catch {
        /* no spec.md in this folder — not a card */
      }
    }
  }
}

/**
 * Tally the exemption rate overall and per epic. Best-effort; sorts by epic for
 * a stable board rendering.
 */
export function exemptionStats(repoCwd: string): ExemptionStats {
  const perEpic = new Map<string, { total: number; exempt: number }>();
  for (const { epic, specText } of cardSpecs(repoCwd)) {
    const cur = perEpic.get(epic) ?? { total: 0, exempt: 0 };
    cur.total += 1;
    if (specIsExempt(specText)) cur.exempt += 1;
    perEpic.set(epic, cur);
  }
  const byEpic = [...perEpic.entries()]
    .map(([epic, v]) => ({ epic, total: v.total, exempt: v.exempt }))
    .sort((a, b) => a.epic.localeCompare(b.epic));
  const total = byEpic.reduce((s, e) => s + e.total, 0);
  const exempt = byEpic.reduce((s, e) => s + e.exempt, 0);
  return { total, exempt, rate: total === 0 ? 0 : exempt / total, byEpic };
}

/** One-line board/status summary, e.g. `screenshot_exempt: 27% (306/1117)`. */
export function exemptionSummaryLine(stats: ExemptionStats): string {
  const pct = Math.round(stats.rate * 100);
  return `screenshot_exempt: ${pct}% (${stats.exempt}/${stats.total})`;
}

/**
 * Dashboard smell-signal lines: the overall summary, then one ⚠ line per epic
 * whose exemption is a HIGH OUTLIER. An epic is compared against the rest of the
 * corpus (leave-one-out) — not the all-in overall — so a large, heavily-exempt
 * epic cannot hide by inflating the very baseline it is measured against.
 * Two guards keep it a signal rather than noise: `epic.total >= 3` (one 100%
 * card is not a trend) and a `>= 0.25` (25 percentage-point) gap over the rest
 * (a materiality floor, tuned to flag the ~27% legacy epics without crying wolf
 * on small drifts). Observe-only — the caller renders these; nothing gates on them.
 */
export function renderExemptionSignal(stats: ExemptionStats): string[] {
  if (stats.total === 0) return [];

  const lines = [exemptionSummaryLine(stats)];
  for (const epic of stats.byEpic) {
    if (epic.total < 3) continue;
    const rate = epic.exempt / epic.total;
    const restTotal = stats.total - epic.total;
    const restExempt = stats.exempt - epic.exempt;
    const restRate = restTotal > 0 ? restExempt / restTotal : 0;
    if (rate - restRate < 0.25) continue;
    lines.push(`⚠ ${epic.epic} ${Math.round(rate * 100)}% exempt`);
  }
  return lines;
}
