/**
 * @responsibility Finds recovery candidates from the event stream.
 */
import type { RollEvent } from "@roll/spec";

/**
 * Recovery permission lasts only until the explicitly re-armed story starts a
 * replacement cycle. This keeps a merged delivery blocked by default while
 * allowing one auditable remediation attempt after `roll loop recover --apply`.
 */
export function pendingRecoveryCandidateIds(events: readonly RollEvent[]): Set<string> {
  const pending = new Set<string>();
  for (const event of events) {
    if (event.type === "goal:recovery" && event.decision === "allowed" && event.storyId !== undefined) {
      pending.add(event.storyId);
      continue;
    }
    if (event.type === "cycle:start") pending.delete(event.storyId);
  }
  return pending;
}
