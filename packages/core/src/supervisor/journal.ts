/**
 * @responsibility Reads and renders the supervisor journal event stream.
 * US-OBS-048 — Supervisor journal read-side helpers.
 *
 * The journal is an append-only stream of `supervisor:journal` events written
 * to the shared events.ndjson runtime file. This module provides deterministic
 * selectors and rendering for terminal introspection.
 */
import {
  type ArtifactRef,
  type Lang,
  type RollEvent,
  SUPERVISOR_JOURNAL_ACTIONS,
  type SupervisorJournalAction,
  t,
  v3Catalog,
} from "@roll/spec";

export interface JournalViewEntry {
  readonly ts: number;
  readonly actor: string;
  readonly action: SupervisorJournalAction;
  readonly storyId?: string;
  readonly cycleId?: string;
  readonly note?: string;
  readonly evidence: readonly ArtifactRef[];
}

export interface JournalFilter {
  readonly storyId?: string;
  readonly limit?: number;
}

function isSupervisorJournalEvent(ev: RollEvent): ev is Extract<RollEvent, { type: "supervisor:journal" }> {
  return ev.type === "supervisor:journal";
}

/** Keep only supervisor:journal events, newest first, with optional filters. */
export function buildJournalView(events: readonly RollEvent[], filter: JournalFilter = {}): JournalViewEntry[] {
  const matched = events.filter(isSupervisorJournalEvent).map((ev): JournalViewEntry => ({
    ts: ev.ts,
    actor: ev.actor,
    action: ev.action,
    storyId: ev.storyId,
    cycleId: ev.cycleId,
    note: ev.note,
    evidence: ev.evidence ?? [],
  }));
  matched.sort((a, b) => b.ts - a.ts);
  const byStory = filter.storyId === undefined
    ? matched
    : matched.filter((e) => e.storyId === filter.storyId);
  const limit = filter.limit ?? byStory.length;
  return byStory.slice(0, Math.max(0, limit));
}

/** Count journal entries in the event stream (for north-star summary). */
export function countJournalEntries(events: readonly RollEvent[]): number {
  return events.filter(isSupervisorJournalEvent).length;
}

/** The most recent journal entry, if any. */
export function latestJournalEntry(events: readonly RollEvent[]): JournalViewEntry | undefined {
  const view = buildJournalView(events, { limit: 1 });
  return view[0];
}

function isoTime(ts: number): string {
  try {
    return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return String(ts);
  }
}

function notePreview(note: string | undefined, max = 60): string {
  if (note === undefined || note === "") return "-";
  const trimmed = note.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function evidenceLabels(evidence: readonly ArtifactRef[]): string {
  if (evidence.length === 0) return "";
  const names = evidence.map((ref) => ref.path.split("/").pop() ?? ref.path).join(", ");
  return ` [${names}]`;
}

/** Render a journal view as a bilingual terminal table. */
export function renderJournal(view: readonly JournalViewEntry[], lang: Lang): string {
  if (view.length === 0) {
    return `  ${t(v3Catalog, lang, "supervisor.journal.title")}: ${t(v3Catalog, lang, "supervisor.journal.empty")}\n`;
  }
  const lines: string[] = [
    "",
    `  ${t(v3Catalog, lang, "supervisor.journal.title")}`,
    `    ${t(v3Catalog, lang, "supervisor.journal.header")}`,
  ];
  for (const entry of view) {
    const story = entry.storyId ?? "-";
    const note = `${notePreview(entry.note)}${evidenceLabels(entry.evidence)}`;
    lines.push(
      `    ${isoTime(entry.ts)} · ${entry.actor} · ${entry.action} · ${story} · ${note}`,
    );
  }
  return lines.join("\n") + "\n";
}
