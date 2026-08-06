/**
 * @responsibility Normalizes per-agent signals into the standard activity signal model.
 */
import { agentNormalizerKind } from "../agent/specs.js";

/**
 * US-LOOP-077 — the observability CORE: a standard {@link ActivitySignal} model
 * + a per-agent normalization layer.
 *
 * roll's core thesis: find the commonality, normalize away agent differences via
 * a STANDARD layer. The loop runs many agents (kimi / pi / reasonix / …) plus the
 * claude harness; each emits a different raw stream — claude speaks
 * `--output-format stream-json`, the others emit free text. The watch window used
 * to only understand claude's stream-json, so a NON-claude cycle looked frozen
 * even while the agent worked.
 *
 * The fix: EVERY agent's raw stream maps into one standard {@link ActivitySignal}.
 * Downstream code (renderers, the future web window, ledgers) consumes ONLY
 * ActivitySignal — never agent-specific parsing, never `if (agent === "claude")`.
 * Adding a new agent means adding ONE normalizer here; nothing downstream changes.
 *
 *   raw stream  ──normalizerFor(agent).normalize()──▶  ActivitySignal[]  ──▶  render
 *
 * Purity: {@link AgentActivityNormalizer.normalize} is pure given (raw line,
 * state) — no clock, no FS, no I/O. The timestamp is supplied by the caller
 * (`nowMs`) so tests are deterministic and table-driven. The raw stream is never
 * mutated; normalization happens at render time, leaving live.log as the single
 * machine-readable source.
 */
import { type SignalKind, signalKindForMarker } from "./signals.js";

/**
 * The cycle's coarse phase. A renderer can group / fold by segment, and the
 * heartbeat says "still in <seg>" so a long phase never looks stuck.
 */
export type Segment = "cycle" | "story" | "build" | "peer" | "ci" | "pr" | "end";

/** What KIND of thing happened — agent-agnostic. */
export type ActivityKind =
  | "lifecycle"
  | "edit"
  | "test"
  | "tool"
  | "tool_call"
  | "tool_result"
  | "say"
  | "tcr"
  | "commit"
  | "pr"
  | "gate"
  | "heartbeat"
  | "alert";

/**
 * Display tier. A = always-show · B = fold/summarize · C = verbose only.
 * (Named `DisplayTier` to avoid colliding with the agent router's complexity
 * `Tier` = easy|default|hard in the @roll/core barrel export.)
 */
export type DisplayTier = "A" | "B" | "C";

/** The standard, agent-agnostic activity signal — the ONE model downstream consumes. */
export interface ActivitySignal {
  /** Epoch ms (caller-supplied; pure normalizers don't read the clock). */
  ts: number;
  /** The cycle this belongs to (banner-derived; "" until a banner is seen). */
  cycleId: string;
  seg: Segment;
  kind: ActivityKind;
  tier: DisplayTier;
  /** Human one-liner. */
  summary: string;
  /** Outcome where it applies (test / ci / pr / gate). */
  result?: "pass" | "fail" | "pending" | "skip";
  /** A short reference — commit hash, PR #, file, agents. */
  ref?: string;
  /** Optional dim detail suffix. */
  detail?: string;
  /**
   * The shared turning-point taxonomy tag, when this signal is a key node the
   * report timeline also tracks (keeps live window & report from drifting).
   */
  signalKind?: SignalKind;
}

/**
 * Mutable per-stream state. One per watch pipe; {@link AgentActivityNormalizer.reset}
 * clears it at a cycle boundary. Carries the pending tool_use→tool_result
 * correlation (payloads like a commit hash live in the RESULT, not the use),
 * the consecutive-edit streak file (so a 12-edit run to one file is one signal),
 * and the heartbeat bookkeeping (last emit time + last summary).
 */
export interface NormalizerState {
  cycleId: string;
  seg: Segment;
  // pending tool_use → tool_result correlation (claude)
  pendingCommit: boolean;
  pendingPr: boolean;
  pendingCi: boolean;
  pendingStory: boolean;
  lastBashCmd: string;
  tcrCount: number;
  /** The file path of the current consecutive Edit/Write streak (null = none). */
  editStreakFile: string | null;
  /** Epoch ms of the last EMITTED signal (heartbeat baseline). 0 = none yet. */
  lastActionTs: number;
  /** Summary of the last emitted signal (shown in the heartbeat tail). */
  lastSummary: string;
  /** Epoch ms of the last heartbeat we emitted (so we don't spam). 0 = none. */
  lastHeartbeatTs: number;
}

export function newNormalizerState(): NormalizerState {
  return {
    cycleId: "",
    seg: "cycle",
    pendingCommit: false,
    pendingPr: false,
    pendingCi: false,
    pendingStory: false,
    lastBashCmd: "",
    tcrCount: 0,
    editStreakFile: null,
    lastActionTs: 0,
    lastSummary: "",
    lastHeartbeatTs: 0,
  };
}

/**
 * One agent's raw-stream → ActivitySignal[] adapter. The ONLY place that knows
 * about an agent's wire format. `normalize` is pure given (raw, state, nowMs).
 */
export interface AgentActivityNormalizer {
  readonly agent: string;
  /**
   * Fold ONE raw stream line into zero or more ActivitySignals, mutating `st`.
   * `nowMs` is the caller's wall clock (kept out of the function body so tests
   * stay deterministic). Never throws on malformed input (returns []).
   */
  normalize(raw: string, st: NormalizerState, nowMs: number): ActivitySignal[];
  /** Reset the per-stream state (cycle boundary). */
  reset(st: NormalizerState): void;
}

// ════════════════════════════════════════════════════════════════════════════
// Shared helpers (agent-agnostic).
// ════════════════════════════════════════════════════════════════════════════

/** Default tier for a kind. test/heartbeat get refined by the caller (fail→A). */
const KIND_TIER: Record<ActivityKind, DisplayTier> = {
  lifecycle: "A",
  tcr: "A",
  commit: "A",
  pr: "A",
  gate: "A",
  alert: "A",
  heartbeat: "A",
  test: "B", // pass → B; a FAIL is promoted to A at emit time
  edit: "B",
  tool: "B",
  tool_call: "B",
  tool_result: "B",
  say: "C",
};

/** Collapse whitespace and clip to one short line. */
function clip(s: string, n = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** basename without importing node:path (keeps this module FS/clock-free). */
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/**
 * Build one ActivitySignal, applying the default tier for its kind (with the
 * test-fail → A promotion) and recording it as the state's "last action" for
 * the heartbeat. Every normalizer routes emits through here.
 */
function emit(
  st: NormalizerState,
  nowMs: number,
  fields: {
    seg?: Segment;
    kind: ActivityKind;
    summary: string;
    tier?: DisplayTier;
    result?: ActivitySignal["result"];
    ref?: string;
    detail?: string;
    marker?: string; // → signalKind via the shared taxonomy
  },
): ActivitySignal {
  let tier = fields.tier ?? KIND_TIER[fields.kind];
  // A failing test is a turning point — promote it out of the fold.
  if (fields.kind === "test" && fields.result === "fail") tier = "A";
  const sig: ActivitySignal = {
    ts: nowMs,
    cycleId: st.cycleId,
    seg: fields.seg ?? st.seg,
    kind: fields.kind,
    tier,
    summary: fields.summary,
  };
  if (fields.result !== undefined) sig.result = fields.result;
  if (fields.ref !== undefined && fields.ref !== "") sig.ref = fields.ref;
  if (fields.detail !== undefined && fields.detail !== "") sig.detail = fields.detail;
  if (fields.marker !== undefined) {
    const sk = signalKindForMarker(fields.marker);
    if (sk !== null) sig.signalKind = sk;
  }
  // Heartbeat bookkeeping (heartbeats themselves don't reset the baseline —
  // they describe an idle gap, they aren't activity).
  if (fields.kind !== "heartbeat") {
    st.lastActionTs = nowMs;
    st.lastSummary = fields.summary;
  }
  return sig;
}

/** Clear the pending tool_use→result correlation (cycle boundary / error). */
function clearPending(st: NormalizerState): void {
  st.pendingCommit = false;
  st.pendingPr = false;
  st.pendingCi = false;
  st.pendingStory = false;
}

/** Generic reset shared by every normalizer. */
function resetState(st: NormalizerState): void {
  clearPending(st);
  st.tcrCount = 0;
  st.editStreakFile = null;
  st.seg = "cycle";
  // lastActionTs / lastSummary / lastHeartbeatTs persist across reset so a
  // banner-then-silence still heartbeats against the banner.
}

/**
 * Recognize a cycle banner (`── cycle <id> · <story> · agent <a> ──`) or a
 * `[loop] cycle N` spine line — shared across agents (the executor writes the
 * banner before the agent stream, regardless of which agent). Returns the
 * cycleId label, or null.
 */
function matchBanner(line: string): { label: string; cycleId: string } | null {
  const header = /^──\s*cycle\s+(.+?)\s*──\s*$/.exec(line);
  if (header) {
    const inner = header[1]!;
    const id = /([0-9]{6,8}-\d+)/.exec(inner);
    return { label: clip(inner, 80), cycleId: id ? id[1]! : inner.split(/\s+/)[0] ?? "" };
  }
  const m = /\[loop\]\s+cycle\s+(\d+)/.exec(line);
  if (m) return { label: `cycle #${m[1]}`, cycleId: m[1]! };
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// Heartbeat — agent-agnostic. If > heartbeatGapMs passes with no emitted
// signal, the renderer calls this to surface a "still alive" line so NO surface
// (claude or otherwise) ever looks frozen.
// ════════════════════════════════════════════════════════════════════════════

export const DEFAULT_HEARTBEAT_GAP_MS = 45_000;

/** Format an elapsed-ms gap as a compact `Ns` / `Nm Ns`. */
function fmtElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Emit a heartbeat IF the surface has gone quiet for >= `gapMs` since the last
 * emitted signal (and since the last heartbeat). Pure given (state, nowMs).
 * Returns [] when activity is recent. Call this on a timer tick (the live
 * command does) — it is NOT driven by raw lines, so a silent agent still beats.
 */
export function maybeHeartbeat(
  st: NormalizerState,
  nowMs: number,
  gapMs: number = DEFAULT_HEARTBEAT_GAP_MS,
): ActivitySignal[] {
  const baseline = st.lastActionTs || st.lastHeartbeatTs;
  if (baseline === 0) return []; // nothing has happened yet — nothing to beat against
  const since = Math.max(st.lastActionTs, st.lastHeartbeatTs);
  if (nowMs - since < gapMs) return [];
  st.lastHeartbeatTs = nowMs;
  const elapsed = fmtElapsed(nowMs - st.lastActionTs);
  const last = st.lastSummary !== "" ? ` · last: ${st.lastSummary}` : "";
  return [
    {
      ts: nowMs,
      cycleId: st.cycleId,
      seg: st.seg,
      kind: "heartbeat",
      tier: "A",
      summary: `…still in ${st.seg} · ${elapsed}${last}`,
    },
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// claudeNormalizer — REFACTOR of the US-PORT-012 formatLine logic. Same turning
// points, now expressed as ActivitySignals. MUST NOT regress.
// ════════════════════════════════════════════════════════════════════════════

const SUPPRESS_TOOLS = new Set([
  "Read", "Glob", "Grep", "ReadMcpResourceTool", "ListMcpResourcesTool",
  "WebFetch", "WebSearch", "TaskCreate", "TaskGet", "TaskList",
  "TaskUpdate", "TaskOutput", "TaskStop",
]);

const PEER_VERDICTS = ["AGREE", "REFINE", "OBJECT", "ESCALATE"] as const;

function claudeText(text: string, st: NormalizerState, nowMs: number): ActivitySignal[] {
  const t = text.trim();
  if (t === "") return [];
  for (const v of PEER_VERDICTS) {
    if (t.includes(v)) {
      const rm = /round\s+(\d+)[/\\](\d+)/i.exec(t);
      const round = rm ? `round ${rm[1]}/${rm[2]}` : "round ?";
      const am = /(\w+)\s*→\s*(\w+)/.exec(t);
      const agents = am ? `${am[1]} → ${am[2]}` : "peer";
      st.editStreakFile = null;
      st.seg = "peer";
      return [emit(st, nowMs, {
        seg: "peer", kind: "gate", summary: agents,
        detail: `${round} · ${v}`, ref: agents, marker: "peer",
      })];
    }
  }
  // Plain assistant prose: a tier-C "say" so --verbose can show the chatter.
  return [emit(st, nowMs, { kind: "say", summary: clip(t, 80) })];
}

function claudeToolUse(blk: Record<string, unknown>, st: NormalizerState, nowMs: number): ActivitySignal[] {
  const name = typeof blk["name"] === "string" ? (blk["name"] as string) : "";
  const input = (blk["input"] ?? {}) as Record<string, unknown>;

  if (SUPPRESS_TOOLS.has(name)) return []; // read-class tools: no signal

  if (name === "Edit" || name === "Write") {
    const path = (typeof input["file_path"] === "string" && input["file_path"]) ||
      (typeof input["path"] === "string" && input["path"]) || "";
    if (path === st.editStreakFile) return []; // collapse consecutive same-file edits
    st.editStreakFile = path as string;
    st.seg = "build";
    return [emit(st, nowMs, {
      seg: "build", kind: "edit", summary: basename(path as string), ref: path as string,
    })];
  }

  // Any non-edit tool breaks the streak (don't collapse across them).
  st.editStreakFile = null;

  if (name === "Bash") {
    const cmd = typeof input["command"] === "string" ? (input["command"] as string) : "";
    const first = cmd.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? cmd;
    st.lastBashCmd = first;
    if (/git\s+commit[\s\S]*tcr:/.test(cmd)) {
      st.pendingCommit = true;
      return [];
    }
    if (/gh\s+pr\s+(create|merge)/.test(cmd)) {
      st.pendingPr = true;
      st.seg = "pr";
      return [];
    }
    if (/(roll\s+ci|npm\s+run\s+ci|_ci_wait|ci:local)/.test(cmd)) {
      st.pendingCi = true;
      st.seg = "ci";
      return [];
    }
    // A non-signal Bash command is a tier-B tool action (folded by default).
    return [emit(st, nowMs, { kind: "tool", summary: clip(first, 60), ref: "bash" })];
  }

  if (name === "Skill") {
    const skill = typeof input["skill"] === "string" ? (input["skill"] as string) : "";
    if (skill === "roll-build" || skill === "roll-fix") {
      const args = (typeof input["args"] === "string" ? (input["args"] as string) : "").trim();
      const usId = args.split(/\s+/)[0] || "?";
      st.pendingStory = true;
      st.seg = "story";
      return [emit(st, nowMs, {
        seg: "story", kind: "lifecycle", summary: usId, detail: clip(args, 60),
        ref: usId, marker: "skill",
      })];
    }
    return [];
  }

  return []; // Agent, ToolSearch, etc.: no signal
}

function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && (c as Record<string, unknown>)["type"] === "text")
      .map((c) => (typeof c["text"] === "string" ? c["text"] : ""))
      .join("\n");
  }
  return content == null ? "" : String(content);
}

function claudeAssistant(ev: Record<string, unknown>, st: NormalizerState, nowMs: number): ActivitySignal[] {
  const msg = (ev["message"] ?? {}) as Record<string, unknown>;
  const content = Array.isArray(msg["content"]) ? msg["content"] : [];
  const out: ActivitySignal[] = [];
  for (const blkRaw of content) {
    if (typeof blkRaw !== "object" || blkRaw === null) continue;
    const blk = blkRaw as Record<string, unknown>;
    const bt = blk["type"];
    if (bt === "thinking") continue; // suppressed
    if (bt === "text") out.push(...claudeText(typeof blk["text"] === "string" ? (blk["text"] as string) : "", st, nowMs));
    else if (bt === "tool_use") out.push(...claudeToolUse(blk, st, nowMs));
  }
  return out;
}

function claudeUser(ev: Record<string, unknown>, st: NormalizerState, nowMs: number): ActivitySignal[] {
  const msg = (ev["message"] ?? {}) as Record<string, unknown>;
  const content = Array.isArray(msg["content"]) ? msg["content"] : [];
  const out: ActivitySignal[] = [];
  for (const blkRaw of content) {
    if (typeof blkRaw !== "object" || blkRaw === null) continue;
    const blk = blkRaw as Record<string, unknown>;
    if (blk["type"] !== "tool_result") continue;
    const text = extractResultText(blk["content"]);

    if (blk["is_error"] === true) {
      st.editStreakFile = null;
      const lines = text.split("\n").filter((l) => l.trim() !== "").slice(0, 3);
      clearPending(st);
      out.push(emit(st, nowMs, {
        kind: "alert", summary: "tool", detail: clip(lines.join(" | "), 80),
        result: "fail", marker: "alert",
      }));
      continue;
    }

    if (st.pendingCommit) {
      st.pendingCommit = false;
      const m = /\[[\w/-]+ ([0-9a-f]{7,})\]\s*tcr:\s*(.+)/.exec(text);
      if (m) {
        st.tcrCount += 1;
        out.push(emit(st, nowMs, {
          kind: "tcr", summary: m[1]!.slice(0, 7), detail: clip(m[2]!.trim(), 60),
          ref: m[1]!.slice(0, 7), result: "pass", marker: "tcr",
        }));
      }
      continue;
    }

    if (st.pendingStory) {
      st.pendingStory = false; // story body suppressed; tcr lines showed the work
      continue;
    }

    if (st.pendingPr) {
      st.pendingPr = false;
      const m = /#(\d+)/.exec(text);
      if (m) {
        const branch = /loop\/[\w-]+/.exec(st.lastBashCmd);
        out.push(emit(st, nowMs, {
          seg: "pr", kind: "pr", summary: `#${m[1]}`, ref: `#${m[1]}`,
          detail: branch ? `merged · ${branch[0]}` : "merged", result: "pass", marker: "pr:merge",
        }));
      }
      continue;
    }

    if (st.pendingCi) {
      st.pendingCi = false;
      const green = /(green|pass|success|all tests)/i.test(text);
      const red = /(red|fail|error)/i.test(text);
      const dur = /(\d+(?:\.\d+)?)\s*s\b/.exec(text);
      const tests = /(\d+)\s+tests?/.exec(text);
      const detail = [dur ? `${dur[1]}s` : "", tests ? `${tests[1]} tests` : ""].filter(Boolean).join(" · ");
      const ok = green && !red;
      out.push(emit(st, nowMs, {
        seg: "ci", kind: "gate", summary: ok ? "green" : "red",
        result: ok ? "pass" : "fail", detail, marker: ok ? "ci:pass" : "ci:fail",
      }));
      continue;
    }
    // Non-matching result: suppressed.
  }
  return out;
}

function claudeResult(ev: Record<string, unknown>, st: NormalizerState, nowMs: number): ActivitySignal[] {
  st.editStreakFile = null;
  st.seg = "end";
  const durMs = typeof ev["duration_ms"] === "number" ? (ev["duration_ms"] as number) : 0;
  const cost = typeof ev["total_cost_usd"] === "number" ? (ev["total_cost_usd"] as number) : 0;
  const durS = Math.round(durMs / 1000);
  if (ev["subtype"] === "error_max_turns") {
    return [emit(st, nowMs, { seg: "end", kind: "alert", summary: "max-turns", detail: `${durS}s`, result: "fail", marker: "alert" })];
  }
  const parts = [
    st.tcrCount > 0 ? `${st.tcrCount} tcr` : "",
    `${durS}s`,
    cost > 0 ? `$${cost.toFixed(2)}` : "",
  ].filter(Boolean);
  return [emit(st, nowMs, { seg: "end", kind: "lifecycle", summary: "cycle done", detail: parts.join(" · ") })];
}

export const claudeNormalizer: AgentActivityNormalizer = {
  agent: "claude",
  reset: resetState,
  normalize(raw: string, st: NormalizerState, nowMs: number): ActivitySignal[] {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") return [];

    const banner = matchBanner(line);
    if (banner) {
      resetState(st);
      st.cycleId = banner.cycleId;
      return [emit(st, nowMs, { seg: "cycle", kind: "lifecycle", summary: banner.label })];
    }

    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return []; // half / non-JSON tolerated (claude stream is JSON per line)
    }
    if (typeof ev !== "object" || ev === null) return [];
    const type = (ev as { type?: unknown }).type;
    if (type === "system") return [];
    if (type === "assistant") return claudeAssistant(ev as Record<string, unknown>, st, nowMs);
    if (type === "user") return claudeUser(ev as Record<string, unknown>, st, nowMs);
    if (type === "result") return claudeResult(ev as Record<string, unknown>, st, nowMs);
    return [];
  },
};

// ════════════════════════════════════════════════════════════════════════════
// genericNormalizer — any unknown agent. Timestamped passthrough of non-empty
// lines as tier-C "say", with banner recognition so the cycle id is still set.
// ════════════════════════════════════════════════════════════════════════════

export const genericNormalizer: AgentActivityNormalizer = {
  agent: "generic",
  reset: resetState,
  normalize(raw: string, st: NormalizerState, nowMs: number): ActivitySignal[] {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") return [];
    const banner = matchBanner(line);
    if (banner) {
      resetState(st);
      st.cycleId = banner.cycleId;
      return [emit(st, nowMs, { seg: "cycle", kind: "lifecycle", summary: banner.label })];
    }
    return [emit(st, nowMs, { kind: "say", summary: clip(line, 100) })];
  },
};

type ParsedToolSignal = { kind: "tool_call" | "tool_result"; tool: string; detail: string; result?: ActivitySignal["result"] };

function parseStructuredToolLine(line: string): ParsedToolSignal | null {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof ev !== "object" || ev === null) return null;
  const rec = ev as Record<string, unknown>;
  const type = typeof rec["type"] === "string" ? rec["type"] : "";
  const kind = type === "tool_call" || type === "tool_use"
    ? "tool_call"
    : type === "tool_result" || type === "tool_output"
      ? "tool_result"
      : "";
  if (kind === "") return null;
  const tool = typeof rec["tool"] === "string"
    ? rec["tool"]
    : typeof rec["name"] === "string"
      ? rec["name"]
      : "tool";
  const detailValue = rec["summary"] ?? rec["input"] ?? rec["content"] ?? rec["output"] ?? "";
  const detail = typeof detailValue === "string" ? detailValue : JSON.stringify(detailValue);
  const result = kind === "tool_result"
    ? rec["is_error"] === true || rec["ok"] === false
      ? "fail"
      : "pass"
    : undefined;
  return { kind, tool, detail, ...(result !== undefined ? { result } : {}) };
}

const TOOL_NAME = /[A-Za-z][A-Za-z0-9_.-]*/;

function parseTextToolSignal(line: string): ParsedToolSignal | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  let m = new RegExp(`^(?:tool_call|tool call|tool-use|tool use)\\s*[:：]\\s*(${TOOL_NAME.source})(?:\\s*[:：-]\\s*(.*))?$`, "i").exec(trimmed);
  if (m) return { kind: "tool_call", tool: m[1]!, detail: m[2] ?? "" };

  m = new RegExp(`^(?:tool_result|tool result|tool-output|tool output)\\s*[:：]\\s*(${TOOL_NAME.source})(?:\\s*[:：-]\\s*(.*))?$`, "i").exec(trimmed);
  if (m) return { kind: "tool_result", tool: m[1]!, detail: m[2] ?? "", result: /\\b(fail|error|failed|exit\\s*[1-9])\\b/i.test(m[2] ?? "") ? "fail" : "pass" };

  m = new RegExp(`^(?:Tool|工具)\\s*[:：]\\s*(${TOOL_NAME.source})(?:\\s*[:：-]\\s*(.*))?$`, "i").exec(trimmed);
  if (m) return { kind: "tool_call", tool: m[1]!, detail: m[2] ?? "" };

  m = /^(?:Running command|run command|执行命令)\s*[:：]\s*(.+)$/i.exec(trimmed);
  if (m) return { kind: "tool_call", tool: "Bash", detail: m[1] ?? "" };

  m = new RegExp(`^(${TOOL_NAME.source})\\((.*)\\)$`).exec(trimmed);
  if (m && ["Bash", "Read", "Edit", "Write", "Glob", "Grep"].includes(m[1]!)) {
    return { kind: "tool_call", tool: m[1]!, detail: m[2] ?? "" };
  }

  m = /^(?:Command output|命令输出)\s*[:：]\s*(.+)$/i.exec(trimmed);
  if (m) return { kind: "tool_result", tool: "Bash", detail: m[1] ?? "", result: "pass" };

  return null;
}

function textToolNormalizer(agent: "pi" | "kimi"): AgentActivityNormalizer {
  return {
    agent,
    reset: resetState,
    normalize(raw: string, st: NormalizerState, nowMs: number): ActivitySignal[] {
      const line = raw.replace(/\s+$/, "");
      if (line.trim() === "") return [];
      const banner = matchBanner(line);
      if (banner) {
        resetState(st);
        st.cycleId = banner.cycleId;
        return [emit(st, nowMs, { seg: "cycle", kind: "lifecycle", summary: banner.label })];
      }
      const parsed = parseStructuredToolLine(line) ?? parseTextToolSignal(line);
      if (parsed !== null) {
        st.editStreakFile = null;
        st.seg = "build";
        return [emit(st, nowMs, {
          seg: "build",
          kind: parsed.kind,
          summary: `${parsed.kind} ${parsed.tool}`,
          detail: clip(parsed.detail, 80),
          ref: parsed.tool,
          ...(parsed.result !== undefined ? { result: parsed.result } : {}),
        })];
      }
      return [emit(st, nowMs, { kind: "say", summary: clip(line, 100) })];
    },
  };
}

export const piNormalizer: AgentActivityNormalizer = textToolNormalizer("pi");
export const kimiNormalizer: AgentActivityNormalizer = textToolNormalizer("kimi");

/**
 * Pick the normalizer for an agent. claude → stream-json fold (harness — roll
 * runs inside Claude Code); everything else (kimi / codex / pi / agy /
 * reasonix / unknown) → generic passthrough. This is the ONLY place a name maps to a parser —
 * downstream stays agnostic.
 */
export function normalizerFor(agent: string): AgentActivityNormalizer {
  const kind = agentNormalizerKind(agent);
  if (kind === "claude") return claudeNormalizer;
  if (kind === "pi") return piNormalizer;
  if (kind === "kimi") return kimiNormalizer;
  return genericNormalizer;
}
