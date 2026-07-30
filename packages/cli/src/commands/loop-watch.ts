/**
 * `roll loop watch` — US-LOOP-074.
 *
 * The one-command, READ-ONLY, concise live view of the loop. It auto-locates the
 * CURRENT project's runtime `live.log` (the same `.roll/loop/live.log` the runner
 * tees the agent stream to) and streams it through the US-LOOP-077 renderer:
 * cycle boundaries / story / per-segment results / ALERT / cost / heartbeat by
 * default; the raw agent transcript only behind `--verbose|--raw`.
 *
 * Three contracts make this safe and useful:
 *
 *   - READ-ONLY (AC2): the only thing it ever touches the loop with is a follow
 *     read of live.log (`tail -F`) and, with `--attach`, a `tmux attach -r` (the
 *     `-r` makes the client read-only). It NEVER writes loop state, NEVER signals
 *     a cycle, and no keypress in the view can reach a running cycle. Ctrl-C ends
 *     the VIEW only — the loop keeps running in its own process.
 *   - NOT NETWORK-GATED: watch is local-only (it just tails a file), so the
 *     FIX-298 network guard's {@link networkNeeds} returns null for it (only
 *     `loop go`/`loop now` are gated). Asking for help never needs the network.
 *   - CONCISE + MID-STREAM RELIABLE (AC3/AC4): it reuses {@link streamThroughRenderer},
 *     which writes each rendered line the instant its source line arrives (no
 *     batch fold), so attaching to a stream already in progress shows activity
 *     immediately instead of looking frozen — the exact failure of a hand-typed
 *     `tail -F live.log | roll loop fmt`.
 */
import type { Readable } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseEventLine } from "@roll/spec";
import {
  parseBacklog,
  renderCompactWatchEvent,
  renderStoryTransition,
  renderWatchStatusSummary,
  summarizeWatchEvents,
  watchRenderEventFromLine,
  type DurableCycleLookup,
  type StoryTransitionContext,
  type WatchStatusSummary,
} from "@roll/core";
import { projectIdentity } from "@roll/infra";
import { renderState } from "../render.js";
import { streamThroughRenderer } from "./loop-fmt.js";
import { planGoTmuxCommands, type GoTmuxState } from "./loop-go.js";

/** Resolve the `.roll/loop/` runtime dir (ROLL_PROJECT_RUNTIME_DIR override) —
 *  mirrors loop-run-once.ts so watch and the runner agree on the live.log path. */
function runtimeDir(projectPath: string): string {
  const env = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  return env !== "" ? env : join(projectPath, ".roll", "loop");
}

/** The roll binary to re-invoke for the tmux watch window (mirrors loop-go.ts). */
function rollBin(): string {
  return (process.env["ROLL_BIN"] ?? "").trim() || process.argv[1] || "roll";
}

/** tmux session name for a project slug (mirrors loop-go.ts goSessionName). */
function watchSessionName(slug: string): string {
  return `roll-loop-${slug}`;
}

interface WatchOptions {
  verbose: boolean;
  raw: boolean;
  attach: boolean;
  events: boolean;
  rawEvents: boolean;
  /** Look-back: number of trailing lines to seed from (tail -n). */
  sinceLines: number;
}

/** Default look-back: enough to catch the current cycle banner + recent nodes
 *  without flooding the view (bare `tail` is too noisy — AC3). */
const DEFAULT_SINCE_LINES = 200;

function parseSince(value: string | undefined): number | undefined {
  const raw = (value ?? "").trim();
  if (raw === "") return undefined;
  // `all` / `+1` → from the start of the file.
  if (raw === "all" || raw === "+1") return 0;
  const n = Number(raw.replace(/^\+/, ""));
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}

function parseOptions(args: string[]): WatchOptions {
  let verbose = false;
  let raw = false;
  let attach = false;
  let events = false;
  let rawEvents = false;
  let sinceLines = DEFAULT_SINCE_LINES;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--raw") {
      raw = true;
      verbose = true; // raw implies showing everything (tier C too).
      continue;
    }
    if (arg === "--events") {
      events = true;
      continue;
    }
    if (arg === "--raw-events") {
      rawEvents = true;
      continue;
    }
    if (arg === "--attach" || arg === "--follow") {
      attach = true;
      continue;
    }
    if (arg === "-n" || arg === "--since") {
      const parsed = parseSince(args[i + 1]);
      if (parsed === undefined) throw new Error("roll loop watch: -n/--since must be a non-negative line count or 'all'");
      sinceLines = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--since=")) {
      const parsed = parseSince(arg.slice("--since=".length));
      if (parsed === undefined) throw new Error("roll loop watch: -n/--since must be a non-negative line count or 'all'");
      sinceLines = parsed;
      continue;
    }
    if (arg.startsWith("-n")) {
      const parsed = parseSince(arg.slice(2));
      if (parsed === undefined) throw new Error("roll loop watch: -n/--since must be a non-negative line count or 'all'");
      sinceLines = parsed;
      continue;
    }
  }
  if (events && rawEvents) throw new Error("roll loop watch: choose only one of --events or --raw-events");
  if (attach && (events || rawEvents)) throw new Error("roll loop watch: --attach cannot be combined with --events or --raw-events");
  return { verbose, raw, attach, events, rawEvents, sinceLines };
}

function watchHelp(): string {
  return [
    "Usage: roll loop watch [-n <lines>|--since <lines>] [--verbose|--raw] [--events|--raw-events] [--attach]",
    "  Read-only, real-time view of THIS project's loop.",
    "  只读、实时地查看本项目的 loop。",
    "",
    "Watch layers:",
    "  default             Owner-facing status: live.log activity plus events.ndjson phase/quiet/TCR/last-signal summary.",
    "  --events            Developer compact stream from .roll/loop/events.ndjson.",
    "  --raw-events        Audit/debug escape hatch: raw .roll/loop/events.ndjson JSON lines unchanged.",
    "观察层级：",
    "  default             owner 日常状态层：live.log 活动 + events.ndjson 的 phase/quiet/TCR/last-signal 摘要。",
    "  --events            开发者 compact 事件流，读取 .roll/loop/events.ndjson。",
    "  --raw-events        审计/排障出口，原样打印 .roll/loop/events.ndjson JSON 行。",
    "",
    "All modes are local and read-only. They never write loop state or signal a running cycle. Ctrl-C ends the view, not the loop.",
    "所有模式都是本地只读；不会写 loop 状态，也不会向运行中的 cycle 发信号。Ctrl-C 只结束视图，不会停掉 loop。",
    "",
    "Options:",
    "  -n, --since <lines>  Look back this many trailing lines before following (default 200; 'all' = whole log).",
    "  --verbose            Also show the raw agent transcript (tier-C prose / passthrough).",
    "  --raw                Alias of --verbose (show everything).",
    "  --events             Follow .roll/loop/events.ndjson and render compact event lines.",
    "  --raw-events         Follow .roll/loop/events.ndjson and print raw JSON lines unchanged.",
    "  --attach             Read-only attach to the loop's tmux observe window (tmux attach -r); recreates the window if missing.",
    "  Note: --verbose/--raw apply to the default live transcript; event modes read events.ndjson.",
    "",
  ].join("\n");
}

/** Injectable seams so the command is fully unit-testable without real IO. */
export interface LoopWatchDeps {
  /** Resolve the current project's identity (path + slug). */
  identity: () => Promise<{ path: string; slug: string }>;
  /** Does a path exist on disk? */
  exists: (path: string) => boolean;
  /** Read a small text snapshot without mutating loop state. */
  readText: (path: string) => string | null;
  /** Open a follow read of live.log and return its stdout stream + a stopper.
   *  READ-ONLY by contract: it only reads the file. */
  follow: (livePath: string, sinceLines: number) => { stream: Readable; stop: () => void };
  /** Run the renderer over a stream (default {@link streamThroughRenderer}). */
  render: (input: Readable, opts: { agent: string; verbose: boolean; status?: () => string | null }) => Promise<void>;
  /** Render event-log modes over a stream. */
  renderEvents: (input: Readable, opts: { raw: boolean }) => Promise<void>;
  /** Probe the tmux session/window state for a slug. */
  tmuxState: (slug: string) => GoTmuxState;
  /** Run a tmux argv (returns true on exit 0). Used to (re)create the watch window. */
  tmuxRun: (argv: string[]) => boolean;
  /** Read-only attach to the tmux session's watch window (blocks until detached). */
  tmuxAttach: (session: string) => void;
  /** Does tmux exist on PATH? */
  hasTmux: () => boolean;
  /** Sink for the command's own (non-stream) lines. */
  emit: (line: string) => void;
}

function realFollow(livePath: string, sinceLines: number): { stream: Readable; stop: () => void } {
  // `-n <N>` seeds the look-back, `-F` follows across truncation/rotation (the
  // runner truncates live.log at each cycle boundary). Pure read — no writes.
  const seek = sinceLines === 0 ? "+1" : String(sinceLines);
  const child = spawn("tail", ["-n", seek, "-F", livePath], { stdio: ["ignore", "pipe", "inherit"] });
  const stop = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  return { stream: child.stdout as Readable, stop };
}

async function streamEvents(input: Readable, opts: { raw: boolean }): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const rawLine of rl) {
      if (opts.raw) {
        process.stdout.write(`${rawLine}\n`);
        continue;
      }
      const ev = watchRenderEventFromLine(rawLine, "events");
      if (ev !== null) process.stdout.write(`${renderCompactWatchEvent(ev)}\n`);
    }
  } finally {
    rl.close();
  }
}

function realDeps(): LoopWatchDeps {
  return {
    identity: async () => {
      const id = await projectIdentity();
      return { path: id.path, slug: id.slug };
    },
    exists: (p) => existsSync(p),
    readText: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    follow: realFollow,
    render: (input, opts) => streamThroughRenderer(input, process.stdout, opts),
    renderEvents: streamEvents,
    tmuxState: probeWatchTmuxState,
    tmuxRun: (argv) => spawnSync("tmux", argv, { stdio: "ignore" }).status === 0,
    tmuxAttach: (session) => {
      // `-r` = read-only client: keypresses cannot reach the window. AC5 + AC2.
      spawnSync("tmux", ["attach-session", "-r", "-t", session], { stdio: "inherit" });
    },
    hasTmux: () => {
      try {
        return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
      } catch {
        return false;
      }
    },
    emit: (line) => process.stdout.write(`${line}\n`),
  };
}

/** Probe tmux for the watch session/window state of a slug (mirrors loop-go.ts). */
function probeWatchTmuxState(slug: string): GoTmuxState {
  const session = watchSessionName(slug);
  const sessionExists = spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
  if (!sessionExists) return { sessionExists: false, watchWindowExists: false };
  const listed = spawnSync("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"], { encoding: "utf8" });
  const windows = listed.status === 0 ? String(listed.stdout ?? "").split("\n").map((w) => w.trim()) : [];
  return { sessionExists: true, watchWindowExists: windows.includes("watch") };
}

/**
 * `--attach` path: read-only attach to the loop's tmux observe window. AC5: when
 * the session exists but its `watch` window is missing (a reused `roll loop go`
 * session, or a closed window), recreate JUST the watch window first so attaching
 * always lands on the live feed — built on FIX-289's {@link planGoTmuxCommands}.
 */
function attachToWatchWindow(projectPath: string, slug: string, deps: LoopWatchDeps): number {
  if (!deps.hasTmux()) {
    deps.emit("roll loop watch: tmux not found — cannot --attach. Run `roll loop watch` (no --attach) to follow the live feed.");
    deps.emit("未找到 tmux，无法 --attach。改用 `roll loop watch`（不带 --attach）跟随实时输出。");
    return 1;
  }
  const session = watchSessionName(slug);
  const state = deps.tmuxState(slug);
  if (!state.sessionExists) {
    deps.emit(`roll loop watch: no tmux session '${session}'. Start the loop with \`roll loop go\` first, or watch without --attach.`);
    deps.emit(`未找到 tmux 会话 '${session}'。先用 \`roll loop go\` 启动 loop，或不带 --attach 观察。`);
    return 1;
  }
  if (!state.watchWindowExists) {
    // Recreate ONLY the watch window — never the worker/go window — from the
    // FIX-289 plan, so we never start a cycle from the observer.
    const plan = planGoTmuxCommands({ projectPath, slug, args: [], rollBin: rollBin() }, state);
    const watchCmd = plan.find((argv) => argv[0] === "new-window" && argv.includes("watch"));
    if (watchCmd !== undefined) deps.tmuxRun(watchCmd);
  }
  deps.tmuxAttach(session);
  return 0;
}

/** FIX-382: parse runs.jsonl into a DurableCycleLookup (cycleId → { storyId, agent }).
 *  Returns an empty record when the file is missing or unparseable. */
function buildDurableLookup(runsPath: string, deps: LoopWatchDeps): DurableCycleLookup {
  if (!deps.exists(runsPath)) return {};
  const text = deps.readText(runsPath);
  if (text === null) return {};
  const lookup: DurableCycleLookup = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const row: Record<string, unknown> = JSON.parse(line);
      const cycleId = typeof row["cycle_id"] === "string" ? row["cycle_id"] : undefined;
      const storyId = typeof row["story_id"] === "string" ? row["story_id"] : "";
      const agent = typeof row["agent"] === "string" ? row["agent"] : "";
      if (cycleId !== undefined && cycleId !== "") {
        // Last-wins: a later row for the same cycle overwrites.
        lookup[cycleId] = { storyId, agent };
      }
    } catch {
      // skip malformed lines
    }
  }
  return lookup;
}

function cleanBrief(desc: string): string {
  return desc
    .replace(/\bdepends-on:[A-Za-z][A-Za-z0-9,-]+\b/g, "")
    .replace(/\bchain_depth:\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function storyBriefResolver(backlogText: string | null): (storyId: string) => string | undefined {
  if (backlogText === null) return () => undefined;
  const items = parseBacklog(backlogText);
  const map = new Map(items.map((item) => [item.id, cleanBrief(item.desc)]));
  return (id) => {
    const brief = map.get(id);
    return brief === undefined || brief === "" ? undefined : brief;
  };
}

function routeReasonResolver(eventsPath: string, deps: LoopWatchDeps): (storyId: string) => { agent: string; reason: string } | undefined {
  return (storyId) => {
    if (!deps.exists(eventsPath)) return undefined;
    const text = deps.readText(eventsPath);
    if (text === null) return undefined;
    const resolved = new Map<string, { agent: string; reason: string }>();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const event = parseEventLine(line);
      if (event !== null && event.type === "route:resolve") {
        resolved.set(event.storyId, { agent: event.agent, reason: event.rule });
      }
    }
    return resolved.get(storyId);
  };
}

function actionPlanResolver(): () => string | undefined {
  // US-OBS-044: runtime action-plan events are not yet implemented; avoid
  // inventing a plan. The renderer will show "plan: pending" instead.
  return () => undefined;
}

function buildStatusProvider(eventsPath: string, runsPath: string, backlogPath: string, deps: LoopWatchDeps): () => string | null {
  const durableLookup = buildDurableLookup(runsPath, deps);
  const backlogText = deps.exists(backlogPath) ? deps.readText(backlogPath) : null;
  const storyBrief = storyBriefResolver(backlogText);
  const routeReason = routeReasonResolver(eventsPath, deps);
  const actionPlan = actionPlanResolver();
  const ctx: StoryTransitionContext = { storyBrief, routeReason, actionPlan };
  let previous: WatchStatusSummary | null = null;
  return (): string | null => {
    if (!deps.exists(eventsPath)) {
      return `status  no events.ndjson yet - live.log only (${eventsPath})`;
    }
    const text = deps.readText(eventsPath);
    if (text === null) {
      return `status  event summary unavailable - live.log only (${eventsPath})`;
    }
    const summary = summarizeWatchEvents(text.split(/\r?\n/), durableLookup);
    if (summary === null) {
      return `status  event summary unavailable - live.log only (${eventsPath})`;
    }
    const transition = previous !== null ? renderStoryTransition(previous, summary, ctx) : null;
    const statusLine = renderWatchStatusSummary(summary, Date.now());
    previous = summary;
    if (transition !== null && transition !== "") {
      return `${transition}\n${statusLine}`;
    }
    return statusLine;
  };
}

/** The `roll loop watch` entry. */
export async function loopWatchCommand(args: string[], deps: LoopWatchDeps = realDeps()): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    deps.emit(watchHelp().trimEnd());
    return 0;
  }
  let opts: WatchOptions;
  try {
    opts = parseOptions(args);
  } catch (err) {
    deps.emit(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "") renderState.useColor = false;

  const id = await deps.identity();

  if (opts.attach) return attachToWatchWindow(id.path, id.slug, deps);

  const rt = runtimeDir(id.path);
  const watchPath = join(rt, opts.events || opts.rawEvents ? "events.ndjson" : "live.log");
  if (!deps.exists(watchPath)) {
    if (opts.events || opts.rawEvents) {
      deps.emit(`roll loop watch: no event stream at ${watchPath} yet — the loop has not written events in this project.`);
      deps.emit(`此项目还没有事件流（${watchPath} 不存在）——loop 尚未在本项目写入 events。`);
    } else {
      deps.emit(`roll loop watch: no live feed at ${watchPath} yet — the loop has not run a cycle in this project.`);
      deps.emit(`此项目还没有实时输出（${watchPath} 不存在）——loop 尚未在本项目跑过 cycle。`);
      deps.emit("Start it with `roll loop go` in this session, then watch.");
      deps.emit("先在本会话用 `roll loop go` 启动，再观察。");
    }
    return 1;
  }

  const agent = (process.env["ROLL_LOOP_AGENT"] ?? "claude").trim() || "claude";
  const eventsPath = join(rt, "events.ndjson");
  // FIX-382: build durable fallback lookup from runs.jsonl so story/agent can
  // be resolved even when cycle:start has been pushed out of the tail window.
  const runsPath = join(rt, "runs.jsonl");
  const backlogPath = join(id.path, ".roll", "backlog.md");
  const status = !opts.events && !opts.rawEvents ? buildStatusProvider(eventsPath, runsPath, backlogPath, deps) : undefined;
  if (status !== undefined) deps.emit(status() ?? `status  event summary unavailable - live.log only (${eventsPath})`);
  const { stream, stop } = deps.follow(watchPath, opts.sinceLines);
  // Ctrl-C ends the VIEW only (read-only): stop the follow, never the loop.
  const onSigint = (): void => stop();
  process.on("SIGINT", onSigint);
  try {
    if (opts.events || opts.rawEvents) await deps.renderEvents(stream, { raw: opts.rawEvents });
    else await deps.render(stream, { agent, verbose: opts.verbose, status });
  } finally {
    process.removeListener("SIGINT", onSigint);
    stop();
  }
  return 0;
}
