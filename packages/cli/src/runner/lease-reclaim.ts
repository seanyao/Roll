import { isHumanSoftLeaseActive, isLeaseAlive, type LeaseEntry } from "@roll/core";
import { parseEventLine, type RollEvent } from "@roll/spec";
import { existsSync, readFileSync } from "node:fs";

/**
 * US-DELIV-005: read the event ledger for the delivery-lease projection.
 * Best-effort — a missing/unreadable ledger means "no leases" (the picker
 * stays free), never a pick blocker.
 */
export function readLeaseEvents(eventsPath: string): RollEvent[] {
  try {
    if (!existsSync(eventsPath)) return [];
    const out: RollEvent[] = [];
    for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
      const ev = parseEventLine(line);
      if (ev !== null) out.push(ev);
    }
    return out;
  } catch {
    return [];
  }
}

const LEGACY_SOFT_LEASE_HOURS = 24;
const HOUR_MS = 3_600_000;

export function parseLegacyClaimTimestamp(row: { desc?: string; status?: string }): number | undefined {
  const text = `${row.status ?? ""} ${row.desc ?? ""}`;
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/.exec(text)?.[0];
  if (iso !== undefined) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  const loose = /\b(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?\b/.exec(text);
  if (loose !== null) {
    const parsed = Date.parse(`${loose[1]}T${loose[2]}:00`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** FIX-1211: decide whether a 🔨 In Progress row can be reclaimed to 📋 Todo.
 *  Returns the action + a human-readable reason for observability. */
export function decideInProgressReclaim(
  entry: LeaseEntry | undefined,
  nowMs: number,
  storyId: string,
  annotatedClaimedAt?: number,
): { action: "reclaim" | "keep"; reason: string } {
  if (entry === undefined) {
    if (annotatedClaimedAt === undefined) {
      return { action: "reclaim", reason: `no lease for ${storyId} and no live delivery evidence` };
    }
    const ageHours = (nowMs - annotatedClaimedAt) / HOUR_MS;
    if (ageHours < LEGACY_SOFT_LEASE_HOURS) {
      return { action: "keep", reason: `annotated soft lease for ${storyId} is within 24h window (${Math.max(0, Math.round(ageHours))}h)` };
    }
    return { action: "reclaim", reason: `annotated soft lease expired for ${storyId} (${Math.round(ageHours)}h, no lease file entry)` };
  }
  if (entry.source === "cycle") {
    if (entry.pid !== undefined && isLeaseAlive(entry)) {
      return { action: "keep", reason: `cycle lease ${entry.pid} is alive for ${storyId}` };
    }
    return { action: "reclaim", reason: `cycle lease for ${storyId} is dead (pid ${entry.pid})` };
  }
  if (entry.source === "human" || entry.source === "supervisor") {
    if (isHumanSoftLeaseActive(entry, nowMs)) {
      return { action: "keep", reason: `${entry.source} lease for ${storyId} is within 24h soft window` };
    }
    return { action: "reclaim", reason: `${entry.source} lease for ${storyId} expired (${Math.round((nowMs - entry.claimedAt) / 3_600_000)}h)` };
  }
  return { action: "keep", reason: `unknown lease source ${entry.source} for ${storyId} — preserving` };
}
