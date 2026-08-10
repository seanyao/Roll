/**
 * @responsibility Reduces a cycle's raw event stream into layered timeline entries.
 * US-ATTEST-014 — the shared cycle-trace extractor (loop-fmt 三层口径).
 *
 * One reducer turns a cycle's raw {@link RollEvent} stream into a layered,
 * human-readable trace. Two of the three "口径" (granularities) live here as a
 * single chronological {@link TimelineEntry} list, each tagged with its layer:
 *
 *   - `outline` — the lifecycle spine: cycle:start → phases → cycle:end. The
 *     skeleton a reader skims to see "where the cycle got to".
 *   - `signal`  — the key turning points a reviewer actually cares about:
 *     TCR commits, Gate (CI / peer / attest), PR (open/merge/rebase/close) and
 *     ALERTs. Surfaced separately as {@link CycleSignals.turningPoints} so the
 *     signal layer is 一眼可辨.
 *
 * The third 口径 — the full raw transcript — is the cycle's agent log, not the
 * event stream; {@link boundTranscript} size-bounds it for inline embedding.
 *
 * Purity: no clock, no FS. Offsets are computed relative to the cycle's first
 * event (timezone-free, deterministic), so the same event stream always renders
 * byte-identical regardless of host locale. This is why US-PORT-012's
 * observation window can reuse the very same reducer.
 *
 * Scoping: events carrying a `cycleId` are kept only when it matches; events
 * WITHOUT a `cycleId` (pr:*, ci:*, alert:notify) are kept verbatim — the caller
 * is responsible for passing only the PR/CI/ALERT events relevant to this
 * cycle's story (it scopes them by storyId / prNumber upstream).
 */
import type { RollEvent } from "@roll/spec";
import { signalKindForMarker } from "./signals.js";

export type SignalLayer = "outline" | "signal";

export interface TimelineEntry {
  /** Raw event epoch (seconds or ms, as the event carried it). */
  ts: number;
  /** Whole seconds since the cycle's first event (>= 0; timezone-free). */
  offsetSec: number;
  layer: SignalLayer;
  /** Machine tag, e.g. `cycle:start`, `tcr`, `pr:merge`, `phase:execute`. */
  marker: string;
  /** Human one-liner (concise; bilingual where it helps). */
  label: string;
}

export interface CycleSignals {
  cycleId: string;
  /** Chronological, stable. Both layers interleaved. */
  timeline: TimelineEntry[];
  /** The signal-layer subset — tcr/Gate/PR/ALERT turning points only. */
  turningPoints: TimelineEntry[];
}

/** Normalize an event ts to whole seconds (ms epoch ≥ 1e12 → s). */
function toSeconds(ts: number): number {
  return ts >= 1e12 ? Math.floor(ts / 1000) : ts;
}

/** Clip a free-text field for a one-line label. */
function clip(s: string, n = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/**
 * Map ONE event to a timeline entry (minus `layer`, derived centrally from the
 * shared taxonomy in {@link extractCycleSignals}), or null when the event type
 * is not part of the per-cycle process trace (loop:* / policy:* / route:* /
 * stdout are skipped — they are not the turning points a reviewer traces).
 * `offsetSec` is filled by the caller (it needs the cycle's base ts).
 */
function toEntry(ev: RollEvent): Omit<TimelineEntry, "offsetSec" | "layer"> | null {
  switch (ev.type) {
    case "cycle:start":
      return { ts: ev.ts, marker: "cycle:start", label: `周期开始 · cycle start${ev.storyId !== "" ? ` · ${ev.storyId}` : ""}` };
    case "cycle:phase":
      return { ts: ev.ts, marker: `phase:${ev.phase}`, label: `阶段 · phase · ${ev.phase}` };
    case "cycle:end":
      return { ts: ev.ts, marker: "cycle:end", label: `周期结束 · cycle end · ${ev.outcome}` };
    case "cycle:tcr":
      return { ts: ev.ts, marker: "tcr", label: `TCR ${ev.commitHash.slice(0, 9)} · ${clip(ev.message)}` };
    case "cycle:first_edit":
      return { ts: ev.ts, marker: "first-edit", label: `首次落笔 · first edit · ${ev.commitHash.slice(0, 9)}` };
    case "cycle:stdout":
      // US-LOOP-076: the runner-observed build heartbeat lands as a tagged stdout
      // line; surface it on the outline spine so a long quiet build phase shows
      // its liveness beats (and a 37-min/2-commit anomaly is legible). Ordinary
      // (un-tagged) stdout is firehose noise and stays out of the timeline.
      return ev.data.startsWith("heartbeat:")
        ? { ts: ev.ts, marker: "build:heartbeat", label: `心跳 · ${clip(ev.data.replace(/^heartbeat:\s*/, ""))}` }
        : null;
    case "ci:pass":
      return { ts: ev.ts, marker: "ci:pass", label: `Gate CI 通过 · PR #${ev.prNumber}` };
    case "ci:fail":
      return { ts: ev.ts, marker: "ci:fail", label: `Gate CI 失败 · PR #${ev.prNumber}${ev.failSummary !== "" ? ` · ${clip(ev.failSummary)}` : ""}` };
    case "ci:rerun":
      return { ts: ev.ts, marker: "ci:rerun", label: `Gate CI 重跑 · PR #${ev.prNumber}` };
    case "peer:gate":
      return { ts: ev.ts, marker: "peer:gate", label: `Peer gate · ${ev.verdict}` };
    case "attest:gate":
      return { ts: ev.ts, marker: "attest:gate", label: `Attest gate · ${ev.verdict}` };
    // US-OBS-045: accepted evaluator / consult / failure land on the cycle trace
    // so `roll cycle <id>` and `roll cycle watch --once` surface them directly.
    case "pair:score":
      return { ts: ev.ts, marker: "pair:score", label: `score ${ev.peer} ${ev.score}/${ev.verdict}` };
    case "pair:score-failure":
      return { ts: ev.ts, marker: "pair:score-failure", label: `score ${ev.peer} failed · ${ev.cause}` };
    case "pair:consult": {
      const durSec = (ev.durationMs / 1000).toFixed(1);
      const causeTag = ev.cause !== undefined ? ` (${ev.cause})` : "";
      return { ts: ev.ts, marker: "pair:consult", label: `consult ${ev.peer} ${ev.outcome} ${durSec}s${causeTag}` };
    }
    case "visual:gate":
      return { ts: ev.ts, marker: "visual:gate", label: `Visual gate · ${ev.verdict}${ev.code !== undefined ? ` · ${ev.code}` : ""}` };
    case "evidence:frame-opened":
      return { ts: ev.ts, marker: "evidence:frame-opened", label: `Evidence frame opened · ${clip(ev.runDir)}` };
    case "pr:open":
      return { ts: ev.ts, marker: "pr:open", label: `PR #${ev.prNumber} 开启 · opened` };
    case "pr:merge":
      return { ts: ev.ts, marker: "pr:merge", label: `PR #${ev.prNumber} 合并 · merged` };
    case "pr:rebase":
      return { ts: ev.ts, marker: "pr:rebase", label: `PR #${ev.prNumber} rebase` };
    case "pr:close":
      return { ts: ev.ts, marker: "pr:close", label: `PR #${ev.prNumber} 关闭 · closed${ev.reason !== "" ? ` · ${clip(ev.reason)}` : ""}` };
    case "alert:notify":
      return { ts: ev.ts, marker: "alert", label: `ALERT · ${clip(ev.message)}` };
    default:
      return null;
  }
}

/** Does this event belong to the cycle's trace? cycleId-bearing → must match. */
function inScope(ev: RollEvent, cycleId: string): boolean {
  if ("cycleId" in ev && typeof (ev as { cycleId?: unknown }).cycleId === "string") {
    return (ev as { cycleId: string }).cycleId === cycleId;
  }
  return true; // pr:* / ci:* / alert:notify — caller-scoped, kept verbatim
}

/** Reduce a cycle's event stream into the layered trace. Pure. */
export function extractCycleSignals(events: RollEvent[], cycleId: string): CycleSignals {
  const indexed = events
    .map((ev, i) => ({ ev, i }))
    .filter(({ ev }) => inScope(ev, cycleId));
  // stable chronological sort (ts asc, original order as tiebreaker)
  indexed.sort((a, b) => toSeconds(a.ev.ts) - toSeconds(b.ev.ts) || a.i - b.i);

  const partial = indexed
    .map(({ ev }) => toEntry(ev))
    .filter((e): e is Omit<TimelineEntry, "offsetSec" | "layer"> => e !== null);
  const baseSec = partial.length > 0 ? toSeconds(partial[0]!.ts) : 0;
  // Layer is derived from the SHARED taxonomy (signals.ts), not hard-coded per
  // case — a marker is `signal` iff signalKindForMarker classifies it. This is
  // the single口径 the observation-window formatter also consumes.
  const timeline: TimelineEntry[] = partial.map((e) => ({
    ...e,
    layer: signalKindForMarker(e.marker) !== null ? "signal" : "outline",
    offsetSec: Math.max(0, toSeconds(e.ts) - baseSec),
  }));

  return {
    cycleId,
    timeline,
    turningPoints: timeline.filter((t) => t.layer === "signal"),
  };
}

export interface BoundedTranscript {
  /** The (possibly middle-elided) text to embed. */
  text: string;
  truncated: boolean;
  /** Length (UTF-16 code units) of the original transcript. */
  totalLen: number;
  /** Length actually embedded (head + tail when truncated). */
  shownLen: number;
}

export interface BoundTranscriptOpts {
  /** Cap above which the middle is elided (default 60_000). */
  maxLen?: number;
  /** Head kept when over the cap (default 24_000). */
  headLen?: number;
  /** Tail kept when over the cap (default 24_000). */
  tailLen?: number;
}

/**
 * Size-bound a raw transcript for inline embedding: under the cap it passes
 * through untouched; over the cap the middle is elided with a clear bilingual
 * truncation marker and the original byte count, so a reader knows there is more
 * and the machine original (path indexed by the caller) holds the full record.
 * Pure & deterministic — length measured in UTF-16 code units, no Buffer.
 */
export function boundTranscript(raw: string, opts: BoundTranscriptOpts = {}): BoundedTranscript {
  const maxLen = opts.maxLen ?? 60_000;
  const headLen = opts.headLen ?? 24_000;
  const tailLen = opts.tailLen ?? 24_000;
  const totalLen = raw.length;
  if (totalLen <= maxLen) {
    return { text: raw, truncated: false, totalLen, shownLen: totalLen };
  }
  const head = raw.slice(0, headLen);
  const tail = raw.slice(totalLen - tailLen);
  const elided = totalLen - head.length - tail.length;
  const marker = `\n\n… 中间省略 ${elided} 字符 / ${elided} chars elided（完整原件见下方索引 · full log at the indexed path）…\n\n`;
  const text = head + marker + tail;
  return { text, truncated: true, totalLen, shownLen: head.length + tail.length };
}
