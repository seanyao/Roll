/**
 * @responsibility Audits existing screenshot exemptions read-only.
 */
/**
 * US-EVID-027 — read-only audit of EXISTING screenshot exemptions.
 *
 * The new exemption discipline (US-EVID-025) is forward-enforcing; this lists
 * the ~306 legacy per-card exemptions and any policy epic-level blanket exempt
 * (`acceptance.screenshot_exempt_epics`) so they can be reviewed in batches. It
 * ONLY reports — it never blocks or rewrites anything (追溯不阻塞). Pure read.
 */
import { cardSpecs, readExemption } from "./exemption-stats.js";
import { screenshotExemptEpics } from "./attest-gate.js";

export interface ExemptCard {
  id: string;
  epic: string;
  reason: string;
}

export interface ExemptionAudit {
  /** Per-card `screenshot_exempt: <reason>` cards, sorted by epic then id. */
  cards: ExemptCard[];
  /** Epics blanket-exempted by policy `acceptance.screenshot_exempt_epics`. */
  blanketEpics: string[];
}

/**
 * Epics under `acceptance.screenshot_exempt_epics:` — delegates to the canonical
 * policy reader (handles inline `[a,b]` + block-sequence forms and scopes the
 * key to its `acceptance:` parent), rather than re-parsing policy.yaml here.
 */
export function blanketExemptEpics(repoCwd: string): string[] {
  return screenshotExemptEpics(repoCwd);
}

/** Enumerate all per-card exemptions + policy blanket-exempt epics. Read-only. */
export function exemptionAudit(repoCwd: string): ExemptionAudit {
  const cards: ExemptCard[] = [];
  for (const { epic, id, specText } of cardSpecs(repoCwd)) {
    const ex = readExemption(specText);
    if (ex.exempt) cards.push({ id, epic, reason: ex.reason });
  }
  cards.sort((a, b) => (a.epic === b.epic ? a.id.localeCompare(b.id) : a.epic.localeCompare(b.epic)));
  return { cards, blanketEpics: blanketExemptEpics(repoCwd) };
}

/** Human-readable audit report (read-only; the header states it never blocks). */
export function renderExemptionAudit(audit: ExemptionAudit): string {
  const lines = [`screenshot_exempt audit (read-only — forward-enforce, never blocks legacy cards):`];
  lines.push(`  per-card exemptions: ${audit.cards.length}`);
  for (const c of audit.cards) lines.push(`    ${c.epic}/${c.id} — ${c.reason}`);
  lines.push(`  blanket-exempt epics: ${audit.blanketEpics.length === 0 ? "(none)" : audit.blanketEpics.join(", ")}`);
  return lines.join("\n");
}
