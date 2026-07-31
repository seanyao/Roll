/**
 * @responsibility Drafts conservative acceptance-evidence maps from recorded delivery signals.
 * US-OBS-031 — Evidence Drafter: auto-draft ac-map from activity signals + git diff.
 *
 * Turns "事后判罚" into "按构造产出": builder confirms/supplements a draft instead
 * of writing ac-map from scratch. The draft maps cycle activity (TCR commits,
 * gate results, tool calls, changed files) onto a story's acceptance criteria,
 * producing evidence entries with confidence annotations.
 *
 * HARD SAFETY (AC5 + FIX-339): every draft entry defaults to `claimed`, never
 * `pass`. The builder must confirm. Heuristic matches carry low/medium
 * confidence; only direct signal matches get "high" confidence. An uncertain
 * signal is ALWAYS `claimed` — never a fabricated `pass`.
 */

import type { CycleActivityEvent } from "@roll/spec";
import type { AcStatus, EvidenceRef } from "./report.js";

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

/** Confidence tier for a draft evidence entry. */
export type EvidenceConfidence = "high" | "medium" | "low";

/** A single draft evidence reference with its provenance. */
export interface DraftEvidenceRef {
  kind: EvidenceRef["kind"];
  label: string;
  href?: string;
  textFile?: string;
  /** Machine-readable source description for traceability. */
  source: string;
  /** Confidence tier for this specific evidence ref. */
  confidence: EvidenceConfidence;
}

/** One drafted AC entry — conservative (defaults to `claimed`). */
export interface DraftAcMapEntry {
  ac: string;
  status: AcStatus;
  evidence: DraftEvidenceRef[];
  /** Overall confidence for this AC mapping. */
  confidence: EvidenceConfidence;
  /** When status is `claimed`, explains WHY it's uncertain / what's missing. */
  note?: string;
}

/** Input signals for the drafter — reusable across cycles. */
export interface DraftAcMapInput {
  /** Parsed AC items from the story spec (id + text). */
  acItems: Array<{ id: string; text: string }>;
  /** Cycle activity events (from signals.jsonl or the CycleActivityEvent stream). */
  signals: CycleActivityEvent[];
  /** Changed files from git diff (relative repo paths). */
  changedFiles: string[];
  /** Screenshot filenames present in the run dir (e.g. ["terminal.png", "web.png"]). */
  screenshots?: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Draft an ac-map from activity signals + git diff. Every AC starts at
 * `claimed`; evidence entries are attached where signals/files correlate.
 * The builder MUST confirm/supplement — this draft is NEVER auto-passed.
 *
 * Returns entries in the same order as `input.acItems`. Missing ACs that
 * received no correlation still appear (as `claimed` with no evidence).
 */
export function draftAcMap(input: DraftAcMapInput): DraftAcMapEntry[] {
  const { acItems, signals, changedFiles, screenshots } = input;

  // Phase 1: collect raw evidence from signals
  const tcrEntries = extractTcrEvidence(signals);
  const gateEntries = extractGateEvidence(signals);
  const commandEntries = extractCommandEvidence(signals);

  // Phase 2: collect screenshot references
  const screenshotRefs = buildScreenshotRefs(screenshots ?? []);

  // Phase 3: for each AC, match signals and files heuristically
  return acItems.map((ac) => {
    const evidence: DraftEvidenceRef[] = [];
    let bestConfidence: EvidenceConfidence = "low";

    // 3a. Match TCR commits against AC text
    const matchedTcr = matchEvidenceToAc(ac.text, tcrEntries);
    for (const e of matchedTcr) {
      bestConfidence = maxConfidence(bestConfidence, e.confidence);
      evidence.push(e);
    }

    // 3b. Match gate results against AC text
    const matchedGates = matchEvidenceToAc(ac.text, gateEntries);
    for (const e of matchedGates) {
      bestConfidence = maxConfidence(bestConfidence, e.confidence);
      evidence.push(e);
    }

    // 3c. Match commands against AC text
    const matchedCmds = matchEvidenceToAc(ac.text, commandEntries);
    for (const e of matchedCmds) {
      bestConfidence = maxConfidence(bestConfidence, e.confidence);
      evidence.push(e);
    }

    // 3d. Match changed files against AC text
    const fileEvidence = matchFilesToAc(ac.text, changedFiles);
    for (const e of fileEvidence) {
      bestConfidence = maxConfidence(bestConfidence, e.confidence);
      evidence.push(e);
    }

    // 3e. Match screenshots against AC text
    const ssRefs = matchEvidenceToAc(ac.text, screenshotRefs);
    for (const e of ssRefs) {
      bestConfidence = maxConfidence(bestConfidence, e.confidence);
      evidence.push(e);
    }

    // Determine status + note
    const { status, note } = draftStatus(ac, evidence, bestConfidence);

    return {
      ac: ac.id,
      status,
      evidence,
      confidence: bestConfidence,
      ...(note !== undefined ? { note } : {}),
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 1: Signal extraction helpers
// ════════════════════════════════════════════════════════════════════════════

function extractTcrEvidence(signals: CycleActivityEvent[]): DraftEvidenceRef[] {
  const seen = new Set<string>();
  const out: DraftEvidenceRef[] = [];
  for (const s of signals) {
    if (s.kind !== "tcr") continue;
    const hash = s.payload.commitHash;
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({
      kind: "commit",
      label: `tcr: ${s.payload.message}`,
      source: `tcr commit ${hash}`,
      confidence: "high",
    });
  }
  return out;
}

function extractGateEvidence(signals: CycleActivityEvent[]): DraftEvidenceRef[] {
  const seen = new Set<string>();
  const out: DraftEvidenceRef[] = [];
  for (const s of signals) {
    if (s.kind !== "gate") continue;
    const gate = s.payload.gate;
    const verdict = s.payload.verdict;
    const key = `${gate}:${verdict}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = s.payload.detail
      ? `${gate} ${verdict} · ${s.payload.detail}`
      : `${gate} ${verdict}`;
    out.push({
      kind: gate === "ci" ? "ci" : "test-pass",
      label,
      source: `gate ${gate}:${verdict}`,
      confidence: "high",
    });
  }
  return out;
}

function extractCommandEvidence(signals: CycleActivityEvent[]): DraftEvidenceRef[] {
  const out: DraftEvidenceRef[] = [];
  for (const s of signals) {
    if (s.kind !== "tool_call" && s.kind !== "tool_result") continue;
    const tool = s.payload.tool;
    // tool_call has input, tool_result has summary — normalize both
    const rawSummary: unknown =
      "summary" in s.payload ? s.payload.summary :
      "input" in s.payload ? s.payload.input : undefined;
    const summary = typeof rawSummary === "string" ? rawSummary : tool;
    out.push({
      kind: "text",
      label: `${s.kind} ${tool}: ${summary.slice(0, 60)}`,
      source: `${s.kind} ${tool}`,
      confidence: "medium",
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 2: Screenshot references
// ════════════════════════════════════════════════════════════════════════════

function buildScreenshotRefs(files: string[]): DraftEvidenceRef[] {
  return files.map((f) => ({
    kind: "screenshot" as const,
    label: f,
    href: `screenshots/${f}`,
    source: `captured artifact: ${f}`,
    confidence: "high" as EvidenceConfidence,
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 3: Matching helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Match evidence entries against AC text using keyword correlation.
 * Returns entries whose label/source shares at least one keyword with the AC.
 * Confidence: "high" for direct keyword matches, "low" for weak ones.
 */
function matchEvidenceToAc(acText: string, entries: DraftEvidenceRef[]): DraftEvidenceRef[] {
  if (entries.length === 0) return [];
  const acLower = acText.toLowerCase();
  const tokens = keywordTokens(acLower);

  return entries
    .filter((e) => {
      const haystack = `${e.label} ${e.source}`.toLowerCase();
      return tokens.some((t) => haystack.includes(t));
    })
    .map((e) => {
      // Re-score confidence: direct signal matches stay high; keyword-only → medium
      if (e.confidence === "low") return e;
      const haystack = `${e.label} ${e.source}`.toLowerCase();
      const matchCount = tokens.filter((t) => haystack.includes(t)).length;
      return { ...e, confidence: matchCount >= 2 ? "high" : "medium" };
    });
}

/**
 * Map changed files to ACs via path-component keyword matching.
 * Confidence is always "medium" (heuristic file→AC mapping is never certain).
 */
function matchFilesToAc(acText: string, files: string[]): DraftEvidenceRef[] {
  if (files.length === 0) return [];
  const acLower = acText.toLowerCase();
  const tokens = keywordTokens(acLower);
  if (tokens.length === 0) return [];

  const matched = files.filter((f) => {
    const fLower = f.toLowerCase();
    return tokens.some((t) => fLower.includes(t));
  });

  if (matched.length === 0) return [];

  // Collapse into one "changed files" entry rather than one per file
  // (the draft is meant to be concise; the agent fills details).
  return [
    {
      kind: "text",
      label: matched.length === 1
        ? `changed: ${matched[0]}`
        : `changed ${matched.length} files: ${matched.slice(0, 3).join(", ")}${matched.length > 3 ? " …" : ""}`,
      source: `git diff: ${matched.slice(0, 3).join(", ")}`,
      confidence: "medium",
    },
  ];
}

/**
 * Extract significant keyword tokens from AC text.
 * Filters out common stopwords and very short tokens.
 */
function keywordTokens(text: string): string[] {
  const STOP = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "under", "and", "but",
    "or", "nor", "not", "so", "yet", "both", "either", "neither", "each",
    "every", "all", "any", "few", "more", "most", "other", "some", "such",
    "no", "only", "own", "same", "than", "too", "very", "just", "that",
    "this", "these", "those", "it", "its", "when", "where", "which", "who",
    "whom", "whose", "why", "how", "if", "then", "else", "also",
  ]);

  // Split on non-alphanumeric + CJK boundaries
  const raw = text.split(/[\s,./:;()\[\]{}<>!?@#$%^&*+=|\\~`'"-]+/);
  const out: string[] = [];
  for (const t of raw) {
    const trimmed = t.trim().toLowerCase();
    if (trimmed.length < 3) continue;
    if (STOP.has(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue; // pure numbers
    out.push(trimmed);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Status determination
// ════════════════════════════════════════════════════════════════════════════

/**
 * Determine draft status for an AC entry.
 * Rule (AC5): ALWAYS conservative — default to `claimed`. Never auto-`pass`.
 * The builder MUST confirm to promote to `pass`.
 */
function draftStatus(
  ac: { id: string; text: string },
  evidence: DraftEvidenceRef[],
  confidence: EvidenceConfidence,
): { status: AcStatus; note?: string } {
  // No evidence at all → missing
  if (evidence.length === 0) {
    return {
      status: "missing",
      note: "draft: no activity signals or changed files correlate with this AC — needs manual evidence",
    };
  }

  // Evidence exists → claimed (never pass). The note tells the builder what to do.
  const highEvidence = evidence.filter((e) => e.confidence === "high");
  const hasHigh = highEvidence.length > 0;
  const hasScreenshot = evidence.some((e) => e.kind === "screenshot");

  if (hasHigh) {
    const gaps: string[] = [];
    if (!hasScreenshot) gaps.push("screenshot (need visual capture)");
    return {
      status: "claimed",
      note: gaps.length > 0
        ? `draft: ${highEvidence.length} high-confidence signal(s) matched — confirm and add ${gaps.join(", ")}`
        : `draft: ${highEvidence.length} high-confidence signal(s) matched — confirm to pass`,
    };
  }

  return {
    status: "claimed",
    note: `draft: ${evidence.length} signal(s) at ${confidence} confidence — review, supplement, and confirm`,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function maxConfidence(a: EvidenceConfidence, b: EvidenceConfidence): EvidenceConfidence {
  const rank: Record<EvidenceConfidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}
