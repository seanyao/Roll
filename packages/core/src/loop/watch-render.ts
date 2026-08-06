/**
 * @responsibility Renders watch output rows from parsed events.
 */
import { parseEventLine, type RollEvent } from "@roll/spec";

export type WatchMode = "status" | "events" | "raw-events";

export type WatchRenderKind =
  | "cycle"
  | "phase"
  | "heartbeat"
  | "tcr"
  | "gate"
  | "evidence"
  | "pr"
  | "alert"
  | "raw";

export type WatchSeverity = "normal" | "muted" | "good" | "warn" | "bad";

export interface WatchRenderEvent {
  kind: WatchRenderKind;
  observedAt: number;
  cycleId?: string;
  storyId?: string;
  phase?: string;
  summary: string;
  detail?: string;
  severity: WatchSeverity;
}

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function clean(input: string): string {
  return input.replace(ANSI_PATTERN, "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

function text(input: unknown): string {
  return clean(typeof input === "string" ? input : "");
}

function shortHash(input: string): string {
  return input.slice(0, 9);
}

function eventTs(input: { ts: number }): number {
  return input.ts;
}

function heartbeatDetail(data: string): string {
  return clean(data.replace(/^heartbeat:\s*/i, ""));
}

function eventFromUnknown(raw: RollEvent): WatchRenderEvent | null {
  const rec = raw as unknown as Record<string, unknown>;
  const ts = typeof rec["ts"] === "number" ? rec["ts"] : 0;
  return {
    kind: "raw",
    observedAt: ts,
    summary: clean(String(rec["type"] ?? "unknown")),
    detail: "",
    severity: "muted",
  };
}

export function watchRenderEventFromRollEvent(ev: RollEvent, mode: WatchMode = "events"): WatchRenderEvent | null {
  switch (ev.type) {
    case "cycle:start":
      return {
        kind: "cycle",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        storyId: ev.storyId,
        summary: "cycle:start",
        detail: [ev.cycleId, ev.storyId, ev.agent].filter((v) => v !== "").join(" · "),
        severity: "normal",
      };
    // US-V4-004: surface the selected Story execution profile in the live stream.
    case "execution:profile":
      return {
        kind: "phase",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "execution profile",
        detail: `${ev.profile} (${ev.reason})`,
        severity: "normal",
      };
    case "cycle:phase":
      return {
        kind: "phase",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        phase: ev.phase,
        summary: "phase",
        detail: ev.phase,
        severity: "normal",
      };
    case "cycle:stdout": {
      const detail = heartbeatDetail(ev.data);
      if (!detail.toLowerCase().startsWith("building")) return mode === "status" ? null : eventFromUnknown(ev);
      return {
        kind: "heartbeat",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "heartbeat",
        detail,
        severity: "muted",
      };
    }
    case "cycle:tcr":
      return {
        kind: "tcr",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "tcr",
        detail: `${shortHash(ev.commitHash)} · ${text(ev.message)}`,
        severity: "good",
      };
    case "pick:ranked":
      return {
        kind: "phase",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        storyId: ev.picked,
        summary: "pick:ranked",
        detail: `picked ${text(ev.picked)} (rank ${ev.rank}/${ev.total}: ${text(ev.reason)})`,
        severity: "normal",
      };
    case "pick:skipped":
      return {
        kind: "phase",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        storyId: ev.storyId,
        summary: "pick:skipped",
        detail: `${text(ev.storyId)} · ${text(ev.reason)}`,
        severity: "warn",
      };
    case "sandbox:write_protected":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "sandbox:write_protected",
        detail: `${ev.status} · ${ev.paths} path${ev.paths === 1 ? "" : "s"}`,
        severity: ev.status === "released" ? "muted" : "normal",
      };
    case "sandbox:quarantined":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        storyId: ev.storyId,
        summary: "sandbox:quarantined",
        detail: `${ev.phase} · ${ev.reason} · ${ev.ref} · ${ev.files.length} item${ev.files.length === 1 ? "" : "s"}`,
        severity: "warn",
      };
    case "cycle:end":
      return {
        kind: "cycle",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "cycle:end",
        detail: [ev.outcome, ev.failure_class, ev.root_cause_key].filter((v) => v !== undefined && v !== "").join(" · "),
        severity: ev.outcome === "delivered" ? "good" : ev.outcome === "failed" || ev.outcome === "blocked" ? "bad" : "warn",
      };
    case "visual:gate":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        storyId: ev.storyId,
        summary: "visual:gate",
        detail: [ev.verdict, ev.code, ev.surface].filter((v) => v !== undefined && v !== "").join(" · "),
        severity: ev.verdict === "ok" ? "good" : ev.verdict === "diagnostic" ? "normal" : "warn",
      };
    case "evidence:frame-opened":
      return {
        kind: "evidence",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        storyId: ev.storyId,
        summary: "evidence:frame-opened",
        detail: text(ev.runDir),
        severity: "normal",
      };
    case "pr:open":
    case "pr:merge":
      return {
        kind: "pr",
        observedAt: eventTs(ev),
        storyId: ev.storyId,
        summary: ev.type,
        detail: `#${ev.prNumber}${ev.storyId !== "" ? ` · ${ev.storyId}` : ""}`,
        severity: ev.type === "pr:merge" ? "good" : "normal",
      };
    case "pr:rebase":
      return {
        kind: "pr",
        observedAt: eventTs(ev),
        summary: "pr:rebase",
        detail: `#${ev.prNumber}`,
        severity: "warn",
      };
    case "pr:close":
      return {
        kind: "pr",
        observedAt: eventTs(ev),
        summary: "pr:close",
        detail: `#${ev.prNumber}${ev.reason !== "" ? ` · ${text(ev.reason)}` : ""}`,
        severity: "warn",
      };
    case "ci:pass":
      return { kind: "gate", observedAt: eventTs(ev), summary: "ci:pass", detail: `#${ev.prNumber}`, severity: "good" };
    case "ci:fail":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        summary: "ci:fail",
        detail: `#${ev.prNumber}${ev.failSummary !== "" ? ` · ${text(ev.failSummary)}` : ""}`,
        severity: "bad",
      };
    case "ci:rerun":
      return { kind: "gate", observedAt: eventTs(ev), summary: "ci:rerun", detail: `#${ev.prNumber}`, severity: "warn" };
    case "peer:gate":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "peer:gate",
        detail: [ev.verdict, ...ev.reasons.map(text)].filter((v) => v !== "").join(" · "),
        severity: ev.verdict === "consulted" ? "good" : ev.verdict === "skipped" ? "bad" : "warn",
      };
    case "attest:gate":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "attest:gate",
        detail: [ev.verdict, ...ev.reasons.map(text)].filter((v) => v !== "").join(" · "),
        severity: ev.verdict === "produced" ? "good" : "bad",
      };
    case "alert:notify":
      return {
        kind: "alert",
        observedAt: eventTs(ev),
        summary: "alert:notify",
        detail: [ev.channel, text(ev.message)].filter((v) => v !== "").join(" · "),
        severity: "bad",
      };
    case "cycle:terminal":
      return {
        kind: "cycle",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        storyId: ev.storyId,
        summary: "cycle:terminal",
        detail: [ev.outcome, ev.failure_class, ev.root_cause_key, ev.agent, ev.model].filter((v) => v !== undefined && v !== "").join(" · "),
        severity: ev.outcome === "delivered" ? "good" : ev.outcome === "failed" || ev.outcome === "blocked" ? "bad" : "warn",
      };
    case "report:morning":
      return {
        kind: "raw",
        observedAt: eventTs(ev),
        summary: "report:morning",
        detail: [ev.path, ev.paused ? "paused" : ""].filter((v) => v !== "").join(" · "),
        severity: "muted",
      };
    // ── FIX-934: pair:* event rendering ────────────────────────────────────
    case "pair:selected": {
      // FIX-1054: a fallback selection (attempt ≥ 2) carries its reason so the
      // ledger shows WHY a later candidate was chosen.
      const attemptTag = ev.attempt !== undefined && ev.attempt > 1 ? ` · attempt ${ev.attempt}${ev.reason !== undefined ? ` (${text(ev.reason)})` : ""}` : "";
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "pair:selected",
        detail: `${text(ev.workingAgent)} → ${text(ev.peer)} (${text(ev.stage)})${attemptTag}`,
        severity: "normal",
      };
    }
    // FIX-1054 — serial-dispatch policy events.
    case "pair:skipped":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "pair:skipped",
        detail: `${ev.peers.map(text).join(", ")} · ${text(ev.reason)} · ${text(ev.stage)}`,
        severity: "normal",
      };
    case "pair:fanout":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "pair:fanout",
        detail: `${text(ev.stage)} · ${text(ev.reason)} · limit ${ev.limit} · ${ev.peers.map(text).join(", ")}`,
        severity: "warn",
      };
    case "pair:verdict":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "pair:verdict",
        detail: [ev.peer, ev.verdict, `${ev.findings} finding${ev.findings === 1 ? "" : "s"}`, ev.stage !== undefined ? ev.stage : ""].filter((v) => v !== "").join(" · "),
        severity: ev.verdict === "agree" ? "good" : ev.verdict === "object" ? "warn" : "normal",
      };
    case "pair:score":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "pair:score",
        detail: [ev.peer, String(ev.score), ev.verdict].join(" · "),
        severity: ev.verdict === "good" ? "good" : ev.verdict === "regression" ? "bad" : "warn",
      };
    case "pair:consult": {
      const durSec = (ev.durationMs / 1000).toFixed(1);
      const causeTag = ev.cause !== undefined ? ` (${ev.cause})` : "";
      return {
        kind: "raw",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "pair:consult",
        detail: `${text(ev.peer)} · ${ev.outcome} · ${durSec}s${causeTag}`,
        severity: ev.outcome === "reviewed" ? "good" : ev.outcome === "timeout" ? "warn" : "bad",
      };
    }
    case "pair:none-available":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "pair:none-available",
        detail: `${text(ev.stage)} · ${text(ev.reason)}`,
        severity: "warn",
      };
    case "pair:score-failure":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "pair:score-failure",
        detail: [ev.peer, ev.cause, ev.detail !== undefined ? ev.detail : ""].filter((v) => v !== "").join(" · "),
        severity: "bad",
      };
    case "pair:excluded":
      return {
        kind: "gate",
        observedAt: eventTs(ev),
        cycleId: ev.cycleId,
        summary: "pair:excluded",
        detail: `${text(ev.agent)} · ${ev.cause} · ${ev.failures} failure${ev.failures === 1 ? "" : "s"}`,
        severity: "warn",
      };
    default:
      return mode === "status" ? null : eventFromUnknown(ev);
  }
}

export function watchRenderEventFromLine(line: string, mode: WatchMode = "events"): WatchRenderEvent | null {
  const ev = parseEventLine(line);
  if (ev === null) {
    return mode === "status"
      ? null
      : {
          kind: "raw",
          observedAt: 0,
          summary: "malformed",
          detail: clean(line),
          severity: "muted",
        };
  }
  return watchRenderEventFromRollEvent(ev, mode);
}

function observedDate(ts: number): Date {
  return new Date(ts > 9_999_999_999 ? ts : ts * 1000);
}

function hhmmss(ts: number): string {
  const d = observedDate(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderLabel(ev: WatchRenderEvent): string {
  if (ev.kind === "tcr") return "tcr";
  if (ev.kind === "heartbeat") return "heartbeat";
  return ev.summary;
}

export function renderCompactWatchEvent(ev: WatchRenderEvent): string {
  const label = clean(renderLabel(ev)).padEnd(21);
  const detail = ev.detail !== undefined && ev.detail !== "" ? `  ${clean(ev.detail)}` : "";
  return `${hhmmss(ev.observedAt)}  ${label}${detail}`.trimEnd();
}

export function renderCompactWatchLines(lines: readonly string[], mode: WatchMode = "events"): string[] {
  if (mode === "raw-events") return lines.map((line) => line.replace(/\r?\n$/, ""));
  const out: string[] = [];
  for (const line of lines) {
    const ev = watchRenderEventFromLine(line, mode);
    if (ev !== null) out.push(renderCompactWatchEvent(ev));
  }
  return out;
}
