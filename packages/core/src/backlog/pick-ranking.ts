/**
 * @responsibility Ranks backlog items into a deterministic pick order.
 */
import { createHash } from "node:crypto";
import type { BacklogItem } from "./store.js";

export interface PickRankingEntry {
  id: string;
  score: number;
  reason: string;
}

export type PickRankingParseResult =
  | { ok: true; entries: PickRankingEntry[] }
  | { ok: false; reason: string };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function candidateSetFingerprint(candidates: readonly BacklogItem[]): string {
  return JSON.stringify(candidates.map((row) => ({ id: row.id, desc: row.desc, status: row.status })));
}

export function buildPickRankingCacheKey(
  backlogContent: string,
  candidates: readonly BacklogItem[],
): { backlogHash: string; candidateSetHash: string } {
  return {
    backlogHash: sha256(backlogContent),
    candidateSetHash: sha256(candidateSetFingerprint(candidates)),
  };
}

function normalizeReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim();
}

export function parsePickRankingJson(
  text: string,
  candidates: readonly BacklogItem[] = [],
): PickRankingParseResult {
  let firstInvalid: PickRankingParseResult | undefined;
  for (const candidate of jsonArrayCandidates(text)) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(raw)) {
      firstInvalid ??= { ok: false, reason: "not_array" };
      continue;
    }
    const parsed = parsePickRankingArray(raw, candidates);
    if (parsed.ok) return parsed;
    firstInvalid ??= parsed;
  }
  if (firstInvalid !== undefined) return firstInvalid;
  return { ok: false, reason: "bad_json" };
}

function parsePickRankingArray(
  raw: unknown[],
  candidates: readonly BacklogItem[],
): PickRankingParseResult {
  if (!Array.isArray(raw)) return { ok: false, reason: "not_array" };
  const candidateIds = new Set(candidates.map((row) => row.id));
  const seen = new Set<string>();
  const entries: PickRankingEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { ok: false, reason: "bad_entry" };
    const rec = item as Record<string, unknown>;
    const id = typeof rec["id"] === "string" ? rec["id"].trim() : "";
    const score = rec["score"];
    const reason = typeof rec["reason"] === "string" ? normalizeReason(rec["reason"]) : "";
    if (id === "") return { ok: false, reason: "bad_id" };
    if (candidateIds.size > 0 && !candidateIds.has(id)) return { ok: false, reason: "unknown_id" };
    if (seen.has(id)) return { ok: false, reason: "duplicate_id" };
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
      return { ok: false, reason: "bad_score" };
    }
    if (reason === "") return { ok: false, reason: "bad_reason" };
    seen.add(id);
    entries.push({ id, score, reason });
  }
  return { ok: true, entries };
}

function* jsonArrayCandidates(text: string): Iterable<string> {
  const trimmed = text.trim();
  if (trimmed === "") return;
  yield trimmed;

  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== "[") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < trimmed.length; j += 1) {
      const ch = trimmed[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
      } else if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          yield trimmed.slice(i, j + 1);
          break;
        }
      }
    }
  }
}

export function advisoryRankItems(
  items: readonly BacklogItem[],
  ranking: readonly PickRankingEntry[] | undefined,
): BacklogItem[] {
  if (ranking === undefined || ranking.length === 0) return [...items];
  const byId = new Map<string, { entry: PickRankingEntry; index: number }>();
  ranking.forEach((entry, index) => byId.set(entry.id, { entry, index }));
  return [...items].sort((a, b) => {
    const ar = byId.get(a.id);
    const br = byId.get(b.id);
    if (ar === undefined && br === undefined) return 0;
    if (ar === undefined) return 1;
    if (br === undefined) return -1;
    return br.entry.score - ar.entry.score || ar.index - br.index;
  });
}

export function rankingEntryForPicked(
  pickedId: string,
  ranking: readonly PickRankingEntry[] | undefined,
): { entry: PickRankingEntry; rank: number; total: number } | undefined {
  if (ranking === undefined) return undefined;
  const sorted = [...ranking].sort((a, b) => b.score - a.score);
  const index = sorted.findIndex((entry) => entry.id === pickedId);
  const entry = sorted[index];
  if (entry === undefined) return undefined;
  return { entry, rank: index + 1, total: sorted.length };
}
