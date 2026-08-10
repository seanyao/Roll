/**
 * @responsibility Applies circuit-breaker safety limits to repeated correction signals.
 */
import type { RollEvent } from "@roll/spec";
import type { LoopSafetyConfig } from "../policy/engine.js";

export type CorrectionCircuitKind = "signal_repeat";

export interface CorrectionSignal {
  storyId?: string;
  cycleId?: string;
  signal: string;
  action: string;
  ts: number;
  source: "correction" | "attest";
}

export type CorrectionCircuitVerdict =
  | { action: "continue" }
  | {
      action: "pause_and_notify";
      kind: CorrectionCircuitKind;
      storyId?: string;
      signal: string;
      count: number;
      threshold: number;
      reason: string;
    };

function normalizeSignal(signal: string): string {
  return signal.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
}

function cycleStoryMap(events: readonly RollEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const ev of events) {
    if (ev.type === "cycle:start" && ev.storyId.trim() !== "") out.set(ev.cycleId, ev.storyId);
  }
  return out;
}

/** FIX-913: cycles that ended `needs_review` (FIX-908 work-preservation — code
 *  committed + CI-green but the attest artifact (peer score / ac-map) could not
 *  yet be produced) are a PRESERVED SUCCESS awaiting re-certification, NOT a
 *  failure. Their attest:gate-skipped / correction:action signals must NOT feed
 *  the correction circuit breaker — else preserving work (the whole point of
 *  FIX-908) falsely trips the breaker and pauses the loop (observed 2026-06-22
 *  23:03: needs_review mis-counted as unknown_failure → false pause). */
function needsReviewCycles(events: readonly RollEvent[]): Set<string> {
  const out = new Set<string>();
  for (const ev of events) {
    if (ev.type === "cycle:terminal" && ev.outcome === "needs_review") out.add(ev.cycleId);
  }
  return out;
}

/** FIX-1261: cards that have been delivered or superseded are "healed" — their
 *  historical failure signals must not count toward the circuit breaker
 *  threshold for current cards. A healed card's old unknown_failure should not
 *  trip the breaker after the card is fixed. */
function healedStoryIds(events: readonly RollEvent[]): Set<string> {
  const out = new Set<string>();
  for (const ev of events) {
    if (ev.type === "cycle:terminal" && ev.outcome === "delivered") {
      out.add(ev.storyId);
    }
    // E3: `delivered_local` is a real (local-only) delivery — it heals the
    // story exactly like a remote delivered/delivered_external.
    if (ev.type === "delivery:reconciled" && (ev.state === "delivered" || ev.state === "delivered_external" || ev.state === "delivered_local" || ev.state === "superseded")) {
      out.add(ev.storyId);
    }
  }
  return out;
}

export function correctionSignals(events: readonly RollEvent[]): CorrectionSignal[] {
  const stories = cycleStoryMap(events);
  const preserved = needsReviewCycles(events);
  const healed = healedStoryIds(events);
  const out: CorrectionSignal[] = [];
  for (const ev of events) {
    if (ev.type === "correction:action") {
      if (ev.cycleId !== undefined && preserved.has(ev.cycleId)) continue;
      // FIX-1261: exclude signals from healed (delivered/superseded) cards.
      if (ev.storyId !== undefined && ev.storyId !== "" && healed.has(ev.storyId)) continue;
      const signal = normalizeSignal(ev.signal);
      if (signal === "") continue;
      out.push({
        storyId: ev.storyId,
        ...(ev.cycleId !== undefined ? { cycleId: ev.cycleId } : {}),
        signal,
        action: ev.action,
        ts: ev.ts,
        source: "correction",
      });
    } else if (ev.type === "attest:gate" && ev.verdict === "skipped") {
      if (preserved.has(ev.cycleId)) continue;
      const storyId = stories.get(ev.cycleId);
      // FIX-1261: exclude signals from healed (delivered/superseded) cards.
      if (storyId !== undefined && healed.has(storyId)) continue;
      const signal = normalizeSignal(ev.reasons[0] ?? "attest gate skipped");
      if (signal === "") continue;
      out.push({
        ...(storyId !== undefined ? { storyId } : {}),
        cycleId: ev.cycleId,
        signal,
        action: "attest_skipped",
        ts: ev.ts,
        source: "attest",
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function correctionSignalVerdict(
  events: readonly RollEvent[],
  safety: LoopSafetyConfig,
  nowSec?: number,
): CorrectionCircuitVerdict {
  const threshold = safety.correctionSignalThreshold;
  if (threshold <= 0) return { action: "continue" };
  const all = correctionSignals(events);
  const latestTs = nowSec ?? all[all.length - 1]?.ts ?? 0;
  const windowSec = Math.max(1, safety.correctionSignalWindowSec);
  const inWindow = all.filter((s) => s.ts >= latestTs - windowSec && s.ts <= latestTs);
  const bySignal = new Map<string, CorrectionSignal[]>();
  for (const sig of inWindow) {
    bySignal.set(sig.signal, [...(bySignal.get(sig.signal) ?? []), sig]);
  }
  for (const [signal, hits] of [...bySignal.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    if (hits.length < threshold) continue;
    const knownStories = new Set(hits.map((h) => h.storyId).filter((s): s is string => s !== undefined && s !== ""));
    return {
      action: "pause_and_notify",
      kind: "signal_repeat",
      ...(knownStories.size > 0 ? { storyId: [...knownStories].sort().join(",") } : {}),
      signal,
      count: hits.length,
      threshold,
      reason: `failure signal repeated: "${signal}" ${hits.length} times in ${windowSec}s >= ${threshold}`,
    };
  }
  return { action: "continue" };
}

export function correctionCircuitVerdict(
  events: readonly RollEvent[],
  safety: LoopSafetyConfig,
  nowSec?: number,
): CorrectionCircuitVerdict {
  return correctionSignalVerdict(events, safety, nowSec);
}
