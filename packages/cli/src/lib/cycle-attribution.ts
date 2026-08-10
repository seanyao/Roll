/**
 * @responsibility Recovers durable cycle-to-story and cycle-to-agent attribution from the events stream.
 */
/**
 * FIX-1060 — durable cycle→story/agent attribution recovery from events.ndjson.
 *
 * When a cycle is aborted externally (signal teardown, exception fallback) the
 * live {@link CycleContext} may already be gone. The events file, however, was
 * appended as the cycle progressed: `evidence:frame-opened` records the picked
 * story, `cycle:start` records the routed agent, `agent:stall` records the agent,
 * etc. This module recovers the best-known attribution by scanning those rows.
 */
import { existsSync, readFileSync } from "node:fs";

export interface CycleAttribution {
  /** The picked story id, if any event recorded it for this cycle. */
  storyId?: string;
  /** The routed/assigned agent, if any event recorded it for this cycle. */
  agent?: string;
}

/**
 * Recover the best-known story/agent for `cycleId` from `eventsPath`.
 *
 * Reads the whole ndjson file (it is append-only and typically < few MB) and
 * returns the last non-empty `storyId` / `agent` seen on an event whose
 * `cycleId` matches. Returns `{}` when the file is missing, unreadable, or
 * contains no attribution for the cycle.
 *
 * LENIENT: malformed lines are skipped; the helper must never throw, because
 * it runs on abort/signal paths where throwing would mask the original failure.
 */
export function readCycleAttributionFromEvents(eventsPath: string, cycleId: string): CycleAttribution {
  if (!existsSync(eventsPath)) return {};
  let content: string;
  try {
    content = readFileSync(eventsPath, "utf8");
  } catch {
    return {};
  }
  let storyId: string | undefined;
  let agent: string | undefined;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev["cycleId"] !== cycleId) continue;
    const sid = ev["storyId"];
    if (typeof sid === "string" && sid !== "") storyId = sid;
    const ag = ev["agent"];
    if (typeof ag === "string" && ag !== "") agent = ag;
  }
  return { storyId, agent };
}
