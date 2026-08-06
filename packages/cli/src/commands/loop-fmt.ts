/**
 * @responsibility Runs the `roll loop fmt` subcommand, formatting the agent observation stream for the watch window.
 */
/**
 * `roll loop fmt` — US-PORT-012 → US-LOOP-077.
 *
 * The observation-window pipe: stdin is the running agent's raw stream (the same
 * bytes tee'd to live.log), stdout is the formatted transcript the tmux watch
 * window renders. The runner template pipes `tail -F live.log` into this;
 * live.log itself is written untouched upstream, so the machine-readable raw
 * stream is unaffected.
 *
 * US-LOOP-077 made this agent-agnostic. The watch no longer parses claude
 * stream-json directly; it selects {@link normalizerFor}(agent) → feeds stdin
 * lines through it → gets a stream of standard {@link ActivitySignal}s → renders
 * them by tier. So claude (stream-json), codex (plain text / jsonl), and any
 * other agent (kimi / pi → generic passthrough) all surface meaningful live
 * activity in the SAME window, and a quiet agent still beats via the heartbeat.
 *
 * This module is pure render + I/O glue: it colors each signal by kind, gates
 * tiers (default = tier A + folded B; `--verbose`/`--raw` also shows C), stamps
 * a clock, and walks stdin line-by-line. The semantic decisions (what a line
 * MEANS) live in @roll/core's normalizers — downstream never re-parses an
 * agent's wire format.
 */
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import {
  type ActivityKind,
  type ActivitySignal,
  DEFAULT_HEARTBEAT_GAP_MS,
  type DisplayTier,
  maybeHeartbeat,
  newNormalizerState,
  normalizerFor,
} from "@roll/core";
import { c, renderState } from "../render.js";

/** Color per activity kind (agent-agnostic — never keyed on agent). */
const KIND_COLOR: Record<ActivityKind, string> = {
  lifecycle: "dim",
  edit: "muted",
  test: "green",
  tool: "muted",
  tool_call: "muted",
  tool_result: "muted",
  say: "dim",
  tcr: "green",
  commit: "green",
  pr: "green",
  gate: "purple",
  heartbeat: "amber",
  alert: "red",
};

/** A short category column glyph/word per kind. */
const KIND_CAT: Record<ActivityKind, string> = {
  lifecycle: "·",
  edit: "✏",
  test: "test",
  tool: "›",
  tool_call: "call",
  tool_result: "result",
  say: "·",
  tcr: "tcr",
  commit: "commit",
  pr: "pr",
  gate: "gate",
  heartbeat: "♥",
  alert: "error",
};

/** Default view shows tier A always and tier B (folded); C only with --verbose. */
export function tierVisible(tier: DisplayTier, verbose: boolean): boolean {
  if (verbose) return true;
  return tier === "A" || tier === "B";
}

/**
 * Render ONE ActivitySignal into a display string (color gated by renderState).
 * Lifecycle/banner-class signals render as a dim spine line; everything else as
 * a categorized signal row. A failing result (test/ci/pr) renders red.
 */
export function renderSignal(sig: ActivitySignal, opts: { ts?: string } = {}): string {
  const ts = opts.ts !== undefined && opts.ts !== "" ? c("muted", opts.ts) + "  " : "";

  // Lifecycle spine (cycle banner / cycle done) → dim line, no arrow.
  if (sig.kind === "lifecycle") {
    const detail = sig.detail !== undefined && sig.detail !== "" ? c("muted", ` — ${sig.detail}`) : "";
    return `${ts}${c("dim", sig.summary)}${detail}`;
  }
  // Muted fold lines (edit / tool / say) → dim category + summary, no arrow.
  if (sig.kind === "edit" || sig.kind === "tool" || sig.kind === "tool_call" || sig.kind === "tool_result" || sig.kind === "say") {
    const cat = KIND_CAT[sig.kind];
    const detail = sig.detail !== undefined && sig.detail !== "" ? `  ${sig.detail}` : "";
    return `${ts}${c("muted", `${cat} ${sig.summary}${detail}`)}`;
  }
  // Signal rows (tcr / pr / gate / test / commit / alert / heartbeat).
  const isFail = sig.result === "fail" || sig.kind === "alert";
  const color = isFail ? "red" : KIND_COLOR[sig.kind];
  const arrow = sig.kind === "heartbeat" ? c("amber", "♥") : c("faint", "→");
  const cat = c("blue", KIND_CAT[sig.kind].padEnd(6));
  const label = c(color, sig.summary.padEnd(14), { bold: true });
  const detail = sig.detail !== undefined && sig.detail !== "" ? "  " + c("muted", sig.detail) : "";
  return `${ts}${arrow}  ${cat}  ${label}${detail}`;
}

/**
 * Fold a whole list of raw stream lines into rendered strings (one state across
 * the list), via the agent's normalizer. Pure given inputs + renderState — the
 * timestamp is omitted by default so tests stay deterministic; the live command
 * stamps each line with the wall clock. `nowMs` defaults to a fixed 0 so the
 * normalize() calls are deterministic too (heartbeats are timer-driven in the
 * live command, not here).
 */
export function formatStream(
  lines: string[],
  agent: string,
  opts: { ts?: string; verbose?: boolean; nowMs?: number } = {},
): string[] {
  const norm = normalizerFor(agent);
  const st = newNormalizerState();
  const verbose = opts.verbose ?? false;
  const nowMs = opts.nowMs ?? 0;
  const out: string[] = [];
  const renderOpts = opts.ts !== undefined ? { ts: opts.ts } : {};
  for (const raw of lines) {
    for (const sig of norm.normalize(raw, st, nowMs)) {
      if (tierVisible(sig.tier, verbose)) out.push(renderSignal(sig, renderOpts));
    }
  }
  return out;
}

function hms(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Drive the renderer over a live input stream, line by line, with a heartbeat.
 *
 * The ONE streaming engine shared by `roll loop fmt` (stdin) and `roll loop
 * watch` (a `tail -F live.log` child's stdout). Two properties matter:
 *
 *   - AC4 (no mid-stream freeze): each rendered line is written AND flushed the
 *     instant its source line arrives — `readline` yields per `\n`, and we drain
 *     synchronously. There is no batch fold, so attaching to a stream already in
 *     progress shows activity immediately instead of looking stuck.
 *   - heartbeat: a wall-clock timer surfaces a "still alive" line when the agent
 *     goes quiet, independent of input lines, so a long phase never looks frozen.
 *
 * Returns when the input stream ends. Pure render + I/O glue; all meaning lives
 * in @roll/core's normalizers (no agent special-casing here).
 */
export async function streamThroughRenderer(
  input: Readable,
  out: Writable,
  opts: { agent: string; verbose: boolean; gapMs?: number; status?: () => string | null },
): Promise<void> {
  const norm = normalizerFor(opts.agent);
  const st = newNormalizerState();
  const gapMs = opts.gapMs ?? DEFAULT_HEARTBEAT_GAP_MS;
  let lastStatus: string | null = null;
  const write = (sig: ActivitySignal): void => {
    if (tierVisible(sig.tier, opts.verbose)) out.write(renderSignal(sig, { ts: hms() }) + "\n");
  };
  const beat = setInterval(() => {
    const status = opts.status?.() ?? null;
    if (status !== null) {
      if (status !== lastStatus) {
        // US-OBS-044: a status payload may carry a multi-line transition block
        // followed by the single-line status summary. Prefix only the final line
        // with the wall-clock timestamp; leading lines (transition framing) are
        // emitted as-is so the handoff block is visually distinct.
        const lines = status.split("\n");
        for (let i = 0; i < lines.length - 1; i += 1) {
          out.write(`${lines[i]}\n`);
        }
        out.write(`${hms()}  ${lines[lines.length - 1]}\n`);
        lastStatus = status;
      }
      return;
    }
    for (const sig of maybeHeartbeat(st, Date.now(), gapMs)) write(sig);
  }, Math.min(gapMs, 15_000));
  beat.unref?.();
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      for (const sig of norm.normalize(raw, st, Date.now())) write(sig);
    }
  } finally {
    clearInterval(beat);
    rl.close();
  }
}

const HELP = `Usage: roll loop fmt [--verbose] [--no-color]

Reads the running agent's raw stream on stdin and writes a formatted, tiered
transcript to stdout (the loop observation window). It selects a per-agent
normalizer (claude stream-json · codex text/jsonl · generic passthrough),
folds each line into a standard activity signal, and renders by tier:
surfaces turning points (story / tcr / test / ci / pr / gate / error), folds
edits + tools, and beats a heartbeat when the agent goes quiet so the window
never looks frozen.
读取运行中 agent 的原始流，归一为标准活动信号后分层输出（观测窗）。
任何 agent（claude/codex/kimi/pi…）都显示真实活动，静默时心跳保活。

  --verbose, --raw   also show tier-C lines (assistant prose / passthrough say)
  --no-color         plain text (also auto-off when stdout is not a TTY)

The agent is read from $ROLL_LOOP_AGENT (default: claude → claude normalizer;
unknown → generic). Intended to sit in the watch pipe:
  tail -F live.log | roll loop fmt
`;

/** The `roll loop fmt` entry: stream stdin → formatted stdout. */
export async function loopFmtCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const noColor = args.includes("--no-color") || !process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "";
  renderState.useColor = !noColor;
  const verbose = args.includes("--verbose") || args.includes("--raw");
  const agent = (process.env["ROLL_LOOP_AGENT"] ?? "claude").trim() || "claude";

  await streamThroughRenderer(process.stdin, process.stdout, { agent, verbose });
  return 0;
}
