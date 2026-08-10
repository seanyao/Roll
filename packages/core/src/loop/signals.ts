/**
 * @responsibility Declares the single turning-point signal table for the whole loop.
 * US-PORT-012 — the single signal口径 ("一处定义两处消费").
 *
 * One table decides "what is a turning-point signal" for the whole loop. Two
 * consumers read it so the key nodes never drift between surfaces:
 *
 *   - {@link extractCycleSignals} (transcript.ts) — reduces the RollEvent stream
 *     into the acceptance-report timeline; its `signal`-layer entries are
 *     exactly the markers {@link signalKindForMarker} classifies.
 *   - the observation-window formatter (loop-fmt.ts) — folds the agent's raw
 *     stream-json into a three-tier tmux transcript; its Tier-1 lines carry the
 *     SAME {@link SignalKind} values.
 *
 * So a TCR commit (or a CI gate, a PR merge, an ALERT) shows up under one shared
 * vocabulary in both the report's timeline and the live watch window — defined
 * here once, consumed in both places.
 */

/** The closed set of turning-point kinds a reviewer actually traces. */
export type SignalKind = "tcr" | "skill" | "ci" | "peer" | "attest" | "pr" | "alert";

export const SIGNAL_KINDS: readonly SignalKind[] = [
  "tcr",
  "skill",
  "ci",
  "peer",
  "attest",
  "pr",
  "alert",
] as const;

/**
 * Classify a timeline marker (transcript.ts vocabulary) into its signal kind,
 * or `null` when the marker is part of the outline spine (cycle:start/end,
 * phase:*) rather than a turning point. This is the bridge that lets the
 * stream-json formatter and the event-stream timeline assert "same source".
 */
export function signalKindForMarker(marker: string): SignalKind | null {
  if (marker === "tcr") return "tcr";
  if (marker === "skill" || marker === "story") return "skill";
  if (marker.startsWith("ci:")) return "ci";
  if (marker === "peer:gate" || marker === "peer" || marker.startsWith("pair:")) return "peer";
  if (marker === "attest:gate" || marker === "visual:gate" || marker === "evidence:frame-opened" || marker === "attest") return "attest";
  if (marker.startsWith("pr:")) return "pr";
  if (marker === "alert" || marker === "error") return "alert";
  return null;
}
