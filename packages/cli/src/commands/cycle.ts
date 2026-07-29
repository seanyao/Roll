/**
 * US-CLI-013 — `roll cycle <id>`: one cycle, fully replayable in the terminal,
 * SAME shape and vocabulary as the web trace tape (US-DOSSIER-013): summary
 * line → story line → vertical seven-segment tape (each segment a colored dot
 * + fact summary; segments a dead cycle never reached read "not reached", not
 * omitted) → evidence pointers (PR / diff / story dossier).
 */
import { parseEventLine, resolveLang, type CycleRoleSummary, type RollEvent } from "@roll/spec";
import {
  aggregateRounds,
  analyzeCycleActivity,
  buildCycleRoleSummary,
  cycleActivitySignalsFromEvents,
  EVENTS_FILE,
  formatRoundReadout,
  projectCollabCycle,
  readRoundEntries,
  renderCycleRolesForTerminal,
  renderRoundJournalMd,
  serializeEvent,
  type ActivitySignal,
  type CycleActivityAnalysis,
} from "@roll/core";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { cardArchiveDir } from "../lib/archive.js";
import { analyzeRepairRounds, listPendingSplitAdvice, writeSplitAdvice } from "../lib/split-advice.js";
import { cycleModelSwapCommand } from "./cycle-model-swap.js";
import { collectCycleLedger, formatBuilderIdentity, type CycleLedgerRow, type CycleTapeSegment } from "../lib/cycle-ledger.js";
import { collectGitDossierFacts } from "../lib/story-dossier.js";
import { cycleNo } from "./cycles.js";
import { c, renderState } from "../render.js";
import { formatToolCostSummary, formatToolTimelineRow } from "../lib/tool-display.js";
import { renderSignal } from "./loop-fmt.js";
import { renderCollabCycle, renderLegend, type CollabRenderNoise } from "../lib/collab-render.js";

export const CYCLE_USAGE =
  "Usage: roll cycle <id>\n" +
  "       roll cycle <id> --activity [--json]\n" +
  "       roll cycle <id> --roles [--json]\n" +
  "       roll cycle <id> --collab [--json] [--no-color]\n" +
  "       roll cycle --legend [--no-color]\n" +
  "       roll cycle watch [<id>] [--once] [--since <lines>] [--json]\n" +
  "       roll cycle journal <card-id> [--json]\n" +
  "       roll cycle split-advice [<card-id>] [--generate] [--json]\n" +
  "       roll cycle model-swap [<card-id>] [--adjudicate] [--json]\n" +
  "  One cycle's full trace tape, a read-only ActivitySignal watch window, a\n" +
  "  supervisor-facing activity explanation, or a collaboration relay view.\n" +
  "  journal <card>  Round-journal readout for a card: median/mean/p90 duration +\n" +
  "                  gate-time share, split by era window (US-CYCLE-004).\n" +
  "  --activity  Explain why this cycle is active, silent, or advisory (US-OBS-042).\n" +
  "  --roles     Show the execution cast (builder, reviewers, evaluators, gates).\n" +
  "  --collab    Show the cycle as a protocol relay (assign → build → peer → score → gate).\n" +
  "  --legend    Print the Layer A collaboration protocol legend.\n" +
  "单个 cycle 的完整轨迹带、只读 ActivitySignal 实时窗口、督导活动说明或协同协议链视图。\n" +
  "  --activity  解释本 cycle 为何活跃/静默/有何 advisory 状态（US-OBS-042）。\n" +
  "  --roles     显示执行选角（构建者、评审人、评估者、门禁）。\n" +
  "  --collab    以协议链形式展示 cycle（指派 → 建造 → 评审 → 打分 → 闸门）。\n" +
  "  --legend    打印 Layer A 协同协议读法头。";

const CYCLE_WATCH_USAGE =
  "Usage: roll cycle watch [<id>] [--once] [--since <lines>] [--json]\n" +
  "  Follow one cycle's standard ActivitySignal stream. --once replays and exits.\n" +
  "跟随单个 cycle 的标准 ActivitySignal 流。--once 回放一帧后退出。";

const SEG_COLOR: Record<CycleTapeSegment["state"], string> = {
  pass: "green",
  fail: "red",
  idle: "muted",
  unknown: "muted",
};

function normalizeHandle(raw: string): string {
  return raw.replace(/^#/, "").replace(/^0+(?=\d)/, "");
}

/** Match tolerance (AC1): with/without `#`, with/without leading zeros, full id or trailing digit run. */
export function findCycle(rows: CycleLedgerRow[], raw: string): CycleLedgerRow | undefined {
  const want = normalizeHandle(raw);
  return rows.find((r) => {
    if (r.cycleId === raw || r.cycleId === want) return true;
    const no = cycleNo(r.cycleId);
    return normalizeHandle(no) === want || no === want;
  });
}

export function renderCycleTrace(row: CycleLedgerRow, lang: "en" | "zh", slug?: string): string {
  const lines: string[] = [];
  lines.push(
    // FIX-1067: the SAME shared Builder identity formatter `roll cycles` uses, so
    // the two surfaces normalize the raw agent/model facts identically.
    `#${cycleNo(row.cycleId)} · ${c(row.verdict === "delivered" ? "green" : row.verdict === "idle" || row.verdict === "unpublished" ? "muted" : "red", row.verdict)} · ${formatBuilderIdentity(row.agent, row.model)} · ${row.tokens} · ${row.cost} · ${row.duration}`,
  );
  lines.push(lang === "zh" ? `story ${row.storyId === "" ? "—（无故事）" : row.storyId}` : `story ${row.storyId === "" ? "— (no story)" : row.storyId}`);
  if (row.toolSummary !== "") lines.push(`cost ${row.cost} · tools ${formatToolCostSummary(row.toolCosts, " ")}`);
  lines.push("");
  const reached = new Set(row.tape.filter((s) => s.detail !== "—" || s.state !== "unknown").map((s) => s.key));
  for (let i = 0; i < row.tape.length; i++) {
    const seg = row.tape[i] as CycleTapeSegment;
    const dead = !reached.has(seg.key) && seg.state === "unknown";
    const dot = c(dead ? "muted" : SEG_COLOR[seg.state], "●");
    const detail = dead ? (lang === "zh" ? "未达" : "not reached") : seg.detail;
    lines.push(`${dot} ${seg.key.padEnd(7)} ${detail}`);
    if (seg.key === "build" && row.toolTimeline.length > 0) {
      for (const tool of row.toolTimeline) {
        lines.push(`  ↳ ${formatToolTimelineRow(tool)}`);
      }
    }
    if (i < row.tape.length - 1) lines.push("│");
  }
  lines.push("");
  const ev: string[] = [];
  const prMatch = /#(\d+)/.exec(row.tape.find((s) => s.key === "pr")?.detail ?? "");
  if (prMatch?.[1] !== undefined && slug !== undefined) {
    ev.push(`PR https://github.com/${slug}/pull/${prMatch[1]}`);
    ev.push(`diff https://github.com/${slug}/pull/${prMatch[1]}/files`);
  }
  if (row.storyId !== "") ev.push(`story .roll/features/*/${row.storyId}/index.html`);
  lines.push(`evidence  ${ev.length > 0 ? ev.join(" · ") : lang === "zh" ? "—（无可定位证据）" : "— (nothing addressable)"}`);
  return `${lines.join("\n")}\n`;
}

/**
 * US-DOSSIER-036 --json (AC5/AC7): the machine view of ONE cycle — the SAME
 * row, the SAME tape segments (key · detail · state), and the SAME evidence
 * pointers the human trace renders, derived from the same `row`+`slug` call.
 */
export function cycleTraceJson(row: CycleLedgerRow, slug: string | undefined): unknown {
  const ev: Array<{ label: string; href: string }> = [];
  const prMatch = /#(\d+)/.exec(row.tape.find((s) => s.key === "pr")?.detail ?? "");
  if (prMatch?.[1] !== undefined && slug !== undefined) {
    ev.push({ label: "PR", href: `https://github.com/${slug}/pull/${prMatch[1]}` });
    ev.push({ label: "diff", href: `https://github.com/${slug}/pull/${prMatch[1]}/files` });
  }
  if (row.storyId !== "") ev.push({ label: "story", href: `.roll/features/*/${row.storyId}/index.html` });
  return {
    no: cycleNo(row.cycleId),
    cycleId: row.cycleId,
    verdict: row.verdict,
    storyId: row.storyId,
    agent: row.agent,
    model: row.model,
    tokens: row.tokens,
    cost: row.cost,
    toolSummary: row.toolSummary,
    toolTimeline: row.toolTimeline.map((t) => ({ toolId: t.toolId, label: t.label, durationMs: t.durationMs, ok: t.ok, errorCode: t.errorCode })),
    duration: row.duration,
    tape: row.tape.map((s) => ({ key: s.key, detail: s.detail, state: s.state })),
    evidence: ev,
  };
}

interface CycleWatchOptions {
  cycleId?: string;
  once: boolean;
  json: boolean;
  sinceLines: number;
}

function runtimeDir(projectPath: string): string {
  const env = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  return env !== "" ? env : join(projectPath, ".roll", "loop");
}

function parseSince(value: string | undefined): number | undefined {
  const raw = (value ?? "").trim();
  if (raw === "") return undefined;
  if (raw === "all" || raw === "+1") return 0;
  const n = Number(raw.replace(/^\+/, ""));
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : undefined;
}

function parseCycleWatchOptions(args: string[]): CycleWatchOptions | { error: string } {
  let once = false;
  let json = false;
  let sinceLines = 200;
  let cycleId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--since" || arg === "-n") {
      const parsed = parseSince(args[i + 1]);
      if (parsed === undefined) return { error: "roll cycle watch: --since must be a non-negative line count or 'all'" };
      sinceLines = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--since=")) {
      const parsed = parseSince(arg.slice("--since=".length));
      if (parsed === undefined) return { error: "roll cycle watch: --since must be a non-negative line count or 'all'" };
      sinceLines = parsed;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { error: CYCLE_WATCH_USAGE.trimEnd() };
    if (arg.startsWith("-")) return { error: `[roll] unknown flag: ${arg}\n${CYCLE_WATCH_USAGE}` };
    if (cycleId !== undefined) return { error: `[roll] too many cycle ids for watch\n${CYCLE_WATCH_USAGE}` };
    cycleId = arg;
  }
  return { ...(cycleId !== undefined ? { cycleId } : {}), once, json, sinceLines };
}

function readEvents(eventsPath: string): RollEvent[] {
  if (!existsSync(eventsPath)) return [];
  const out: RollEvent[] = [];
  for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
    const ev = parseEventLine(line);
    if (ev !== null) out.push(ev);
  }
  return out;
}

function readSignals(signalsPath: string): ActivitySignal[] {
  if (!existsSync(signalsPath)) return [];
  let text = "";
  try {
    text = readFileSync(signalsPath, "utf8");
  } catch {
    return [];
  }
  const out: ActivitySignal[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isActivitySignal(parsed)) out.push(parsed);
    } catch {
      /* skip torn/malformed lines */
    }
  }
  return out;
}

function isActivitySignal(value: unknown): value is ActivitySignal {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec["ts"] === "number" &&
    typeof rec["cycleId"] === "string" &&
    typeof rec["seg"] === "string" &&
    typeof rec["kind"] === "string" &&
    typeof rec["tier"] === "string" &&
    typeof rec["summary"] === "string";
}

function cycleEventId(ev: RollEvent): string | undefined {
  return "cycleId" in ev && typeof (ev as { cycleId?: unknown }).cycleId === "string" ? (ev as { cycleId: string }).cycleId : undefined;
}

function findRunningCycle(events: readonly RollEvent[]): string | undefined {
  const ended = new Set<string>();
  let running: string | undefined;
  for (const ev of events) {
    const id = cycleEventId(ev);
    if (id === undefined || id === "") continue;
    if (ev.type === "cycle:end" || ev.type === "cycle:terminal") ended.add(id);
    if (ev.type === "cycle:start" && !ended.has(id)) running = id;
  }
  return running !== undefined && !ended.has(running) ? running : undefined;
}

function findLatestCycle(events: readonly RollEvent[], rows: readonly CycleLedgerRow[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const id = cycleEventId(events[i]!);
    if (id !== undefined && id !== "") return id;
  }
  return rows[0]?.cycleId;
}

function resolveWatchCycleId(input: string | undefined, events: readonly RollEvent[], rows: CycleLedgerRow[], once: boolean): string | undefined {
  if (input === undefined) return findRunningCycle(events) ?? (once ? findLatestCycle(events, rows) : undefined);
  return findCycle(rows, input)?.cycleId ?? (events.some((ev) => cycleEventId(ev) === input) ? input : undefined);
}

function eventsForCycle(events: readonly RollEvent[], cycleId: string): RollEvent[] {
  return events.filter((ev) => cycleEventId(ev) === cycleId);
}

function cycleStartFacts(events: readonly RollEvent[], row: CycleLedgerRow | undefined): { storyId: string; agent: string } {
  const start = events.find((ev) => ev.type === "cycle:start") as Extract<RollEvent, { type: "cycle:start" }> | undefined;
  return {
    storyId: start?.storyId ?? row?.storyId ?? "",
    agent: start?.agent ?? "",
  };
}

function cycleOutcome(events: readonly RollEvent[], row: CycleLedgerRow | undefined): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.type === "cycle:end") return ev.outcome;
    if (ev.type === "cycle:terminal") return ev.outcome;
  }
  return row?.verdict ?? "running";
}

function renderCycleWatchFrame(cycleId: string, events: readonly RollEvent[], row: CycleLedgerRow | undefined, json: boolean, persistedSignals: readonly ActivitySignal[] = []): string {
  const scoped = eventsForCycle(events, cycleId);
  const facts = cycleStartFacts(scoped, row);
  const outcome = cycleOutcome(scoped, row);
  const signals = persistedSignals.length > 0 ? [...persistedSignals] : cycleActivitySignalsFromEvents(scoped, cycleId);
  if (json) {
    return JSON.stringify(
      {
        cycleId,
        storyId: facts.storyId,
        agent: facts.agent,
        outcome,
        signals,
      },
      null,
      2,
    ) + "\n";
  }
  const lines = [
    `cycle ${cycleId}`,
    `story ${facts.storyId === "" ? "—" : facts.storyId}`,
    `agent ${facts.agent === "" ? "—" : facts.agent}`,
    `outcome ${outcome}`,
    "",
  ];
  for (const sig of signals) lines.push(renderSignal(sig));
  if (signals.length === 0) lines.push("no activity signals recorded for this cycle");
  return `${lines.join("\n")}\n`;
}

async function followSignalFile(signalsPath: string, sinceLines: number): Promise<number> {
  const seek = sinceLines === 0 ? "+1" : String(sinceLines);
  const child = spawn("tail", ["-n", seek, "-F", signalsPath], { stdio: ["ignore", "pipe", "inherit"] });
  const stop = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("SIGINT", stop);
  try {
    const rl = createInterface({ input: child.stdout as Readable, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isActivitySignal(parsed)) process.stdout.write(`${renderSignal(parsed)}\n`);
      } catch {
        /* skip torn/malformed lines */
      }
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    stop();
  }
}

async function followCycle(eventsPath: string, cycleId: string, sinceLines: number): Promise<number> {
  if (!existsSync(eventsPath)) {
    process.stderr.write(`[roll] no event stream at ${eventsPath}\n`);
    return 1;
  }
  const seek = sinceLines === 0 ? "+1" : String(sinceLines);
  const child = spawn("tail", ["-n", seek, "-F", eventsPath], { stdio: ["ignore", "pipe", "inherit"] });
  const stop = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("SIGINT", stop);
  try {
    const rl = createInterface({ input: child.stdout as Readable, crlfDelay: Infinity });
    for await (const line of rl) {
      const ev = parseEventLine(line);
      if (ev === null || cycleEventId(ev) !== cycleId) continue;
      const rendered = cycleActivitySignalsFromEvents([ev], cycleId).map((sig) => renderSignal(sig));
      for (const row of rendered) process.stdout.write(`${row}\n`);
      if (ev.type === "cycle:end" || ev.type === "cycle:terminal") break;
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    stop();
  }
}

function cycleWatchCommand(args: string[]): number | Promise<number> {
  const parsed = parseCycleWatchOptions(args);
  if ("error" in parsed) {
    const isHelp = parsed.error === CYCLE_WATCH_USAGE.trimEnd();
    (isHelp ? process.stdout : process.stderr).write(`${parsed.error}\n`);
    return isHelp ? 0 : 1;
  }
  const rt = runtimeDir(process.cwd());
  const eventsPath = join(rt, "events.ndjson");
  const events = readEvents(eventsPath);
  const rows = collectCycleLedger(process.cwd());
  const cycleId = resolveWatchCycleId(parsed.cycleId, events, rows, parsed.once || parsed.json);
  if (cycleId === undefined) {
    process.stderr.write(parsed.cycleId === undefined
      ? "[roll] no running cycle (pass a cycle id, or use `roll cycles --since all`)\n"
      : `[roll] no cycle matches ${parsed.cycleId} (try roll cycles --since all)\n`);
    return 1;
  }
  const row = rows.find((r) => r.cycleId === cycleId);
  const signalsPath = join(rt, `cycle-${cycleId}.signals.jsonl`);
  const persistedSignals = readSignals(signalsPath);
  if (parsed.once) {
    process.stdout.write(renderCycleWatchFrame(cycleId, events, row, parsed.json, persistedSignals));
    return 0;
  }
  if (parsed.json) {
    process.stdout.write(renderCycleWatchFrame(cycleId, events, row, true, persistedSignals));
    return 0;
  }
  if (persistedSignals.length > 0) return followSignalFile(signalsPath, parsed.sinceLines);
  return followCycle(eventsPath, cycleId, parsed.sinceLines);
}

/**
 * US-OBS-033: `roll cycle <id> --roles` — render the execution cast
 * (Builder, Peer Review, Evaluator/Score, Gates) from CycleRoleSummary.
 */
function cycleRolesCommand(handle: string, cycleId: string, json: boolean, lang: "en" | "zh"): number {
  const rt = runtimeDir(process.cwd());
  const eventsPath = join(rt, "events.ndjson");
  const cycleLogDir = join(rt, "cycle-logs");
  const summaryPath = join(cycleLogDir, cycleId, "summary.json");

  // Try reading cached summary artifact first
  if (existsSync(summaryPath)) {
    try {
      const raw = readFileSync(summaryPath, "utf8");
      const summary = JSON.parse(raw) as CycleRoleSummary;
      process.stdout.write(renderCycleRolesForTerminal(summary, { json }));
      return 0;
    } catch {
      // Fall through to rebuild from events
    }
  }

  // Rebuild from events.ndjson when summary artifact is missing or corrupt
  if (!existsSync(eventsPath)) {
    process.stderr.write(
      lang === "zh"
        ? `[roll] 找不到周期 ${handle} 的事件流（无 ${eventsPath}）\n`
        : `[roll] no event stream for cycle ${handle} (${eventsPath} not found)\n`,
    );
    return 1;
  }

  const events = readEvents(eventsPath);
  const cycleEvents = events.filter(
    (e) => "cycleId" in e && (e as { cycleId: string }).cycleId === cycleId,
  );
  if (cycleEvents.length === 0) {
    process.stderr.write(
      lang === "zh"
        ? `[roll] 周期 ${handle} 没有可用的事件\n`
        : `[roll] no events available for cycle ${handle}\n`,
    );
    return 1;
  }

  const peerDir = join(rt, "peer");
  const summary = buildCycleRoleSummary({
    cycleId,
    events,
    eventsPath,
    peerDir,
    cycleLogDir,
  });
  process.stdout.write(renderCycleRolesForTerminal(summary, { json }));
  return 0;
}

function collabNoiseForCycle(events: readonly RollEvent[], cycleId: string): CollabRenderNoise {
  const inCycle = (e: RollEvent) => cycleEventId(e) === cycleId;
  return {
    scoreFailures: events.filter((e) => inCycle(e) && e.type === "pair:score-failure").length,
    peerConsults: events.filter((e) => inCycle(e) && e.type === "pair:consult").length,
  };
}

/**
 * US-OBS-039: `roll cycle <id> --collab` — render one cycle as a protocol relay.
 */
function cycleCollabCommand(handle: string, cycleId: string, json: boolean, noColor: boolean, lang: "en" | "zh"): number {
  const rt = runtimeDir(process.cwd());
  const eventsPath = join(rt, "events.ndjson");
  const cycleLogDir = join(rt, "cycle-logs");
  const summaryPath = join(cycleLogDir, cycleId, "summary.json");

  let summary: CycleRoleSummary | undefined;
  if (existsSync(summaryPath)) {
    try {
      summary = JSON.parse(readFileSync(summaryPath, "utf8")) as CycleRoleSummary;
    } catch {
      summary = undefined;
    }
  }

  let events: RollEvent[] = [];
  if (existsSync(eventsPath)) {
    events = readEvents(eventsPath);
  }

  if (!summary) {
    const cycleEvents = events.filter((e) => cycleEventId(e) === cycleId);
    if (cycleEvents.length > 0) {
      summary = buildCycleRoleSummary({
        cycleId,
        events,
        eventsPath,
        peerDir: join(rt, "peer"),
        cycleLogDir,
      });
    }
  }

  if (!summary) {
    process.stderr.write(
      lang === "zh"
        ? `[roll] 周期 ${handle} 的协同摘要不可用（缺少事件与摘要）\n`
        : `[roll] collab view unavailable for cycle ${handle} (missing events and summary)\n`,
    );
    return 1;
  }

  const supervisor = process.env["ROLL_SUPERVISOR_AGENT"] ?? "codex";
  const view = projectCollabCycle(summary, events, supervisor);

  if (view.terminus === "" && view.handoffs.length === 0) {
    process.stderr.write(
      lang === "zh"
        ? `[roll] 周期 ${handle} 的协同摘要不可用\n`
        : `[roll] collab view unavailable for cycle ${handle}\n`,
    );
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(view, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    renderCollabCycle(view, { color: !noColor, fold: true, width: 72, lang }, collabNoiseForCycle(events, cycleId)) + "\n",
  );
  return 0;
}

/** US-OBS-042 — supervisor-facing activity explanation for one cycle. */
function renderCycleActivity(analysis: CycleActivityAnalysis, json: boolean): string {
  if (json) return JSON.stringify(analysis, null, 2) + "\n";
  const lines: string[] = [];
  lines.push(`cycle ${analysis.cycleId}`);
  lines.push(`classification ${analysis.classification}`);
  lines.push(`quiet ${analysis.quietSec}s · ${analysis.tcrCount} TCR`);
  if (analysis.microStep !== undefined) {
    lines.push(`micro-step ${analysis.microStep.actionId}: ${analysis.microStep.summary}`);
    lines.push(`  evidence: ${analysis.microStep.expectedEvidence}`);
    lines.push(`  scope: ${analysis.microStep.fileAreaScope.join(", ")}`);
  }
  if (analysis.testTransition !== undefined) {
    lines.push(
      `test:${analysis.testTransition.state} at +${Math.floor(analysis.testTransition.at / 1000)}s (${analysis.testTransition.source})`,
    );
  }
  if (analysis.greenUncommitted !== undefined) {
    lines.push(`green-uncommitted ${analysis.greenUncommitted.durationSec}s (advisory)`);
  }
  if (analysis.oversizedAction !== undefined) {
    lines.push(
      `action oversized · ${analysis.oversizedAction.filesTouched} files / ${analysis.oversizedAction.contractAreas} areas (advisory)`,
    );
  }
  if (analysis.splitSuggestion !== undefined) {
    const action = analysis.splitSuggestion.actionId ?? "action";
    lines.push(`split suggested ${action} · ${analysis.splitSuggestion.reason} (advisory)`);
    lines.push(`  safe boundary: ${analysis.splitSuggestion.safeBoundary}`);
    lines.push(`  follow-up draft: ${analysis.splitSuggestion.followupDraft.title}`);
    lines.push("  deferred scope is not delivered by this card");
    if (analysis.splitSuggestion.evaluatorContext !== undefined) {
      lines.push(`  evaluator: ${analysis.splitSuggestion.evaluatorContext}`);
    }
  }
  for (const followup of analysis.queuedFollowups ?? []) {
    lines.push(`follow-up ${followup.id ?? "(queued action)"} · ${followup.title} (${followup.reason})`);
  }
  for (const sandbox of analysis.sandboxEvents ?? []) {
    lines.push(`sandbox ${sandbox.type} · ${sandbox.summary}`);
  }
  return lines.join("\n") + "\n";
}

function cycleActivityCommand(handle: string, json: boolean): number {
  const rt = runtimeDir(process.cwd());
  const eventsPath = join(rt, "events.ndjson");
  const events = readEvents(eventsPath);
  const rows = collectCycleLedger(process.cwd());
  const cycleId =
    findCycle(rows, handle)?.cycleId ?? (events.some((ev) => cycleEventId(ev) === handle) ? handle : undefined);
  if (cycleId === undefined) {
    process.stderr.write(`[roll] no cycle matches ${handle} (try roll cycles --since all)\n`);
    return 1;
  }
  // Test seam: ROLL_CYCLE_ACTIVITY_NOW_MS pins the analysis clock.
  const nowMsRaw = (process.env["ROLL_CYCLE_ACTIVITY_NOW_MS"] ?? "").trim();
  const nowMs = nowMsRaw !== "" ? Number(nowMsRaw) : Date.now();
  const activitySignals = readSignals(join(rt, `cycle-${cycleId}.signals.jsonl`));
  const analysis = analyzeCycleActivity(events, cycleId, nowMs, { activitySignals });
  process.stdout.write(renderCycleActivity(analysis, json));
  return 0;
}

/**
 * US-CYCLE-004 — `roll cycle journal <cardId> [--json]`: read a card's
 * round-journal and print the readout (median/mean/p90 duration + gate share,
 * split by era window). Data source is `.roll/features/<epic>/<cardId>/
 * round-journal.jsonl`; malformed lines are skipped + counted.
 */
export function cycleJournalCommand(args: string[], lang: "en" | "zh"): number {
  const json = args.includes("--json");
  const cardId = args.find((a) => !a.startsWith("-"));
  if (cardId === undefined || cardId === "") {
    process.stderr.write(
      lang === "zh"
        ? "用法：roll cycle journal <卡号> [--json]\n"
        : "Usage: roll cycle journal <card-id> [--json]\n",
    );
    return 1;
  }
  const cardDir = cardArchiveDir(process.cwd(), cardId);
  // Regenerate the derived human `.md` table on demand (append is kept O(1) on
  // the hot path, so the .md is produced here from the jsonl source of truth).
  try {
    renderRoundJournalMd(cardDir, readRoundEntries(cardDir).entries);
  } catch {
    /* .md is derived; a render failure never blocks the readout */
  }
  const agg = aggregateRounds(cardDir);
  if (json) {
    process.stdout.write(`${JSON.stringify(agg, null, 2)}\n`);
    return 0;
  }
  if (agg.overall.count === 0) {
    process.stdout.write(
      lang === "zh"
        ? `${cardId}: 暂无 round-journal 记录\n`
        : `${cardId}: no round-journal entries yet\n`,
    );
    return 0;
  }
  process.stdout.write(`${cardId} round-journal\n${formatRoundReadout(agg)}\n`);
  return 0;
}

/**
 * US-CYCLE-006 — `roll cycle split-advice [<card>] [--generate] [--json]`.
 *   • no card (or --list): list every card carrying a pending split-advice.md.
 *   • <card> --generate: analyze the card's round-journal; if repair rounds >
 *     threshold, write split-advice.md (idempotent) and emit a `split:advice`
 *     event. Signal only — never touches backlog or spec.
 *   • <card> (no --generate): preview whether the card would produce advice.
 */
export function cycleSplitAdviceCommand(args: string[], lang: "en" | "zh"): number {
  const json = args.includes("--json");
  const generate = args.includes("--generate");
  const cardId = args.find((a) => !a.startsWith("-"));
  const cwd = process.cwd();

  if (cardId === undefined || cardId === "" || args.includes("--list")) {
    const pending = listPendingSplitAdvice(cwd);
    if (json) {
      process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`);
      return 0;
    }
    if (pending.length === 0) {
      process.stdout.write(lang === "zh" ? "暂无待处理的拆分建议\n" : "no pending split advice\n");
      return 0;
    }
    process.stdout.write((lang === "zh" ? "待处理拆分建议:\n" : "pending split advice:\n") + pending.map((p) => `  ${p.card}  ${p.path}`).join("\n") + "\n");
    return 0;
  }

  const cardDir = cardArchiveDir(cwd, cardId);
  const advice = analyzeRepairRounds(cardDir, cardId);
  if (advice === null) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ card: cardId, advice: null }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      lang === "zh"
        ? `${cardId}: repair 轮数未超阈值,无需拆分建议\n`
        : `${cardId}: repair rounds within threshold — no split advice\n`,
    );
    return 0;
  }

  if (!generate) {
    if (json) {
      process.stdout.write(`${JSON.stringify(advice, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      (lang === "zh"
        ? `${cardId}: ${advice.roundCount} 轮 (超阈值) — 用 --generate 生成 split-advice.md\n`
        : `${cardId}: ${advice.roundCount} rounds (over threshold) — pass --generate to write split-advice.md\n`),
    );
    return 0;
  }

  const { path, written } = writeSplitAdvice(cardDir, advice);
  if (written) {
    // Emit the signal event (best-effort) — idempotent write means a re-run that
    // changes nothing does NOT re-emit.
    try {
      const loopDir = join(cwd, ".roll", "loop");
      mkdirSync(loopDir, { recursive: true });
      const ev: RollEvent = { type: "split:advice", card: cardId, rounds: advice.roundCount, path, ts: Date.now() };
      appendFileSync(join(loopDir, EVENTS_FILE), serializeEvent(ev) + "\n");
    } catch {
      /* event emission is best-effort observability */
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...advice, path, written }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    written
      ? (lang === "zh" ? `${cardId}: 已生成 ${path} (${advice.roundCount} 轮)\n` : `${cardId}: wrote ${path} (${advice.roundCount} rounds)\n`)
      : (lang === "zh" ? `${cardId}: split-advice.md 已是最新 (幂等,未改动)\n` : `${cardId}: split-advice.md already current (idempotent, unchanged)\n`),
  );
  return 0;
}

export function cycleCommand(args: string[]): number | Promise<number> {
  const noColor = args.includes("--no-color") || !process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "";
  renderState.useColor = !noColor;
  const lang = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
  if (args[0] === "watch") {
    return cycleWatchCommand(args.slice(1).filter((a) => a !== "--no-color"));
  }
  if (args[0] === "journal") {
    return cycleJournalCommand(args.slice(1), lang);
  }
  if (args[0] === "split-advice") {
    return cycleSplitAdviceCommand(args.slice(1), lang);
  }
  if (args[0] === "model-swap") {
    return cycleModelSwapCommand(args.slice(1), lang);
  }
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(`${CYCLE_USAGE}\n`);
    return args.length === 0 ? 1 : 0;
  }
  if (args.includes("--legend")) {
    process.stdout.write(renderLegend({ color: !noColor, fold: true }) + "\n");
    return 0;
  }
  const activity = args.includes("--activity");
  const roles = args.includes("--roles");
  const collab = args.includes("--collab");
  const json = args.includes("--json");
  // kimi pair-review: reject unknown flags like `roll cycles` does.
  const unknown = args.filter((a) => a.startsWith("-") && a !== "--no-color" && a !== "--help" && a !== "-h" && a !== "--json" && a !== "--roles" && a !== "--collab" && a !== "--legend" && a !== "--activity");
  if (unknown.length > 0) {
    process.stderr.write(`[roll] unknown flag: ${unknown[0]}\n${CYCLE_USAGE}\n`);
    return 1;
  }
  const handle = args.find((a) => !a.startsWith("-"));
  if (handle === undefined) {
    process.stderr.write(`${CYCLE_USAGE}\n`);
    return 1;
  }
  if (activity) {
    return cycleActivityCommand(handle, json);
  }
  const rows = collectCycleLedger(process.cwd());
  const row = findCycle(rows, handle);
  if (roles) {
    return cycleRolesCommand(handle, row?.cycleId ?? handle, json, lang);
  }
  if (collab) {
    return cycleCollabCommand(handle, row?.cycleId ?? handle, json, noColor, lang);
  }
  if (row === undefined) {
    process.stderr.write(lang === "zh" ? `[roll] 找不到周期 ${handle}（试试 roll cycles --since all）\n` : `[roll] no cycle matches ${handle} (try roll cycles --since all)\n`);
    return 1;
  }
  const slug = collectGitDossierFacts(process.cwd())?.slug;
  if (json) {
    process.stdout.write(JSON.stringify(cycleTraceJson(row!, slug), null, 2) + "\n");
    return 0;
  }
  process.stdout.write(renderCycleTrace(row!, lang, slug));
  return 0;
}
