/**
 * @responsibility Runs the `roll north` subcommand, rendering the North Star report.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildNorthStarReport,
  countJournalEntries,
  EventBus,
  latestJournalEntry,
  splitBacklogRow,
  type NorthStarMetric,
  type NorthStarReport,
  type NorthStarBacklogEntry,
  type NorthStarCardMeta,
  type NorthStarDelivery,
  type NorthStarEvent,
  type NorthStarRun,
} from "@roll/core";
import { resolveLang, t, type Lang, type RollEvent, v3Catalog } from "@roll/spec";
import { shWindowDays } from "../lib/sh-time.js";
import { c, pad, renderState, sparkline, trunc } from "../render.js";

const USAGE =
  "Usage: roll north [--json] [--no-color]\n  Render the north-star terminal panel, or emit the raw roll.north.v1 metrics JSON.\n";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(row: Record<string, unknown>, key: string): string[] | undefined {
  const value = row[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function jsonlObjects(paths: readonly string[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let text: string;
    try {
      // Rotation keeps each segment bounded (<=10MiB), so sync reads remain deterministic and small.
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || seen.has(line)) continue;
      seen.add(line);
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed)) rows.push(parsed);
      } catch {
        continue;
      }
    }
  }
  return rows;
}

function rotatedPaths(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}(?:\\.(\\d+))?$`);
  return readdirSync(dir)
    .flatMap((entry) => {
      const match = pattern.exec(entry);
      return match === null ? [] : [{ path: join(dir, entry), index: match[1] === undefined ? 0 : Number(match[1]) }];
    })
    .sort((a, b) => a.index - b.index || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
}

function projectRoot(): string {
  const envRoot = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim();
  return envRoot === "" ? process.cwd() : envRoot;
}

function loopDir(root: string): string {
  const envDir = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  return envDir === "" ? join(root, ".roll", "loop") : envDir;
}

function readRuns(dir: string): NorthStarRun[] {
  return jsonlObjects(rotatedPaths(dir, "runs.jsonl")).map((row) => ({
    runId: stringField(row, "run_id") ?? stringField(row, "runId"),
    cycleId: stringField(row, "cycle_id") ?? stringField(row, "cycleId"),
    status: stringField(row, "status"),
    outcome: stringField(row, "outcome"),
    ts: stringField(row, "ts") ?? numberField(row, "ts"),
    storyId: stringField(row, "story_id") ?? stringField(row, "storyId"),
    built: stringArrayField(row, "built"),
    failureClass: stringField(row, "failure_class") ?? stringField(row, "failureClass"),
    rootCauseKey: stringField(row, "root_cause_key") ?? stringField(row, "rootCauseKey"),
  }));
}

function readEvents(dir: string): NorthStarEvent[] {
  return jsonlObjects(rotatedPaths(dir, "events.ndjson")).map((row) => ({
    type: stringField(row, "type"),
    ts: stringField(row, "ts") ?? numberField(row, "ts"),
    storyId: stringField(row, "storyId") ?? stringField(row, "story_id"),
    cycleId: stringField(row, "cycleId") ?? stringField(row, "cycle_id"),
    actor: stringField(row, "actor"),
    failureClass: stringField(row, "failure_class") ?? stringField(row, "failureClass"),
  }));
}

function readDeliveries(dir: string): NorthStarDelivery[] {
  return jsonlObjects(rotatedPaths(dir, "deliveries.jsonl")).map((row) => {
    const mergedAt = row["mergedAt"];
    const delivery: NorthStarDelivery = {
      storyId: stringField(row, "storyId") ?? stringField(row, "story_id") ?? "",
      lifecycleState: stringField(row, "lifecycleState") ?? stringField(row, "lifecycle_state"),
      recordedAt: numberField(row, "recordedAt") ?? numberField(row, "recorded_at"),
    };
    if (isRecord(mergedAt)) {
      delivery.mergedAt = {
        present: typeof mergedAt["present"] === "boolean" ? mergedAt["present"] : undefined,
        value: typeof mergedAt["value"] === "number" ? mergedAt["value"] : undefined,
      };
    }
    return delivery;
  }).filter((delivery) => delivery.storyId !== "");
}

function readJournalEvents(dir: string): RollEvent[] {
  const path = join(dir, "events.ndjson");
  if (!existsSync(path)) return [];
  try {
    return new EventBus().readEvents(path);
  } catch {
    return [];
  }
}

function readBacklog(root: string): NorthStarBacklogEntry[] {
  const path = join(root, ".roll", "backlog.md");
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: NorthStarBacklogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = splitBacklogRow(line).map((cell) => cell.trim()).filter((cell) => cell !== "");
    if (cells.length < 3 || /^-+$/.test(cells[0] ?? "")) continue;
    const idCell = cells[0] ?? "";
    const idMatch = /\b([A-Z][A-Z0-9]*(?:-[A-Z0-9a-z]+)*-\d+[a-z]?)\b/.exec(idCell);
    if (idMatch === null) continue;
    entries.push({ id: idMatch[1] ?? "", status: cells[cells.length - 1] ?? "" });
  }
  return entries.filter((entry) => entry.id !== "");
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let st;
  try {
    st = statSync(dir);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const meta: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (m !== null) meta[m[1] ?? ""] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return meta;
}

function gitCreatedMap(root: string): Map<string, string> {
  const metaRoot = join(root, ".roll");
  const dates = new Map<string, string>();
  if (!existsSync(metaRoot)) return dates;
  try {
    const out = execFileSync("git", ["-C", metaRoot, "log", "--diff-filter=A", "--name-only", "--format=%ct"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let currentDate: string | undefined;
    for (const rawLine of out.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      const seconds = Number(line);
      if (Number.isFinite(seconds)) {
        currentDate = new Date(seconds * 1000).toISOString().slice(0, 10);
      } else if (currentDate !== undefined && !dates.has(line)) {
        dates.set(line, currentDate);
      }
    }
  } catch {
    return dates;
  }
  return dates;
}

function readCards(root: string): NorthStarCardMeta[] {
  const featuresRoot = join(root, ".roll", "features");
  const cards: NorthStarCardMeta[] = [];
  const createdByPath = gitCreatedMap(root);
  for (const path of walkFiles(featuresRoot).filter((item) => item.endsWith("spec.md"))) {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const fm = frontmatter(text);
    const id = fm["id"];
    if (id === undefined || id === "") continue;
    const card: NorthStarCardMeta = { id };
    const type = fm["type"] ?? id.split("-")[0]?.toLowerCase();
    const epic = fm["epic"] ?? path.slice(featuresRoot.length + 1).split("/")[0];
    const metaRelativePath = path.slice(join(root, ".roll").length + 1);
    const created = fm["created"] ?? (/^FIX-/i.test(id) ? createdByPath.get(metaRelativePath) : undefined);
    const rootCauseKey = fm["root_cause_key"] ?? fm["rootCauseKey"];
    if (type !== undefined && type !== "") card.type = type;
    if (epic !== undefined && epic !== "") card.epic = epic;
    if (created !== undefined && created !== "") card.created = created;
    if (rootCauseKey !== undefined && rootCauseKey !== "") card.rootCauseKey = rootCauseKey;
    cards.push(card);
  }
  return cards;
}

function nowForNorth(): Date {
  const injected = (process.env["ROLL_NORTH_NOW"] ?? "").trim();
  if (injected !== "") {
    const parsed = Date.parse(injected);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date();
}

export function loadNorthStarReport(root = projectRoot(), now = nowForNorth()): NorthStarReport {
  const dir = loopDir(root);
  return buildNorthStarReport({
    nowMs: now.getTime(),
    days: shWindowDays(now, 14),
    runs: readRuns(dir),
    events: readEvents(dir),
    cards: readCards(root),
    backlog: readBacklog(root),
    deliveries: readDeliveries(dir),
  });
}

type MetricKey = keyof NorthStarReport["metrics"];

const METRIC_KEYS = ["autonomy", "deliveryRate", "fixTax", "attributionErrors"] as const satisfies readonly MetricKey[];

function metricName(key: MetricKey, lang: Lang): string {
  return t(v3Catalog, lang, `north.metric.${key}`);
}

function metricShortName(key: MetricKey, lang: Lang): string {
  return t(v3Catalog, lang, `north.metric_short.${key}`);
}

function reasonText(reason: string | undefined, lang: Lang): string {
  if (reason === undefined || reason === "") return t(v3Catalog, lang, "north.reason.unknown");
  const key = `north.reason.${reason}`;
  const rendered = t(v3Catalog, lang, key);
  return rendered === key ? t(v3Catalog, lang, "north.reason.unknown") : rendered;
}

function metricValue(key: MetricKey, value: number, unit: string | undefined): string {
  if (unit === "hours") return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}h`;
  if (unit === "count") return String(Math.trunc(value));
  if (unit === "ratio" && key === "deliveryRate") return `${Math.round(value * 100)}%`;
  if (unit === "ratio") return `${value.toFixed(2)}x`;
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
}

function targetValue(key: MetricKey, metric: NorthStarMetric<unknown>): string {
  const op = metric.target.op === ">=" ? "≥" : metric.target.op;
  return `${op}${metricValue(key, metric.target.value, metric.target.unit)}`;
}

function trendArrow(metric: NorthStarMetric<unknown>, lang: Lang): string {
  if (metric.trend === "up") return t(v3Catalog, lang, "north.trend.up");
  if (metric.trend === "down") return t(v3Catalog, lang, "north.trend.down");
  return t(v3Catalog, lang, "north.trend.flat");
}

type RenderStatus = "met" | "near" | "miss";

function renderStatus(metric: NorthStarMetric<unknown>): RenderStatus {
  const current = metric.current;
  if (metric.met) return "met";
  if (current === null) return "miss";
  // "Near" is a render-only affordance: within 20% on the non-met side of the target line.
  if (metric.target.op === ">=") return current >= metric.target.value * 0.8 ? "near" : "miss";
  if (metric.target.op === "<") return current <= metric.target.value * 1.2 ? "near" : "miss";
  return Math.abs(current - metric.target.value) <= Math.max(1, Math.abs(metric.target.value) * 0.2) ? "near" : "miss";
}

function statusColor(status: RenderStatus): string {
  if (status === "met") return "green";
  if (status === "near") return "amber";
  return "red";
}

function statusDot(status: RenderStatus, lang: Lang): string {
  return `${c(statusColor(status), "●")} ${t(v3Catalog, lang, `north.status.${status}`)}`;
}

function terminalWidth(fallback = 100): number {
  const cols = process.stdout.columns;
  return typeof cols === "number" && cols > 0 ? cols : fallback;
}

function metricLine(key: MetricKey, metric: NorthStarMetric<unknown>, lang: Lang, width: number): string {
  const name = trunc(metricName(key, lang), lang === "zh" ? 16 : 20);
  const nameWidth = lang === "zh" ? 16 : 20;
  const label = pad(name, nameWidth);
  if (metric.current === null) {
    return trunc(`  ${label} ${t(v3Catalog, lang, "north.no_data")} · ${reasonText(metric.reason ?? metric.daily.find((d) => d.reason !== undefined)?.reason, lang)}`, width);
  }
  const current = pad(metricValue(key, metric.current, metric.target.unit), 7, "r");
  const target = targetValue(key, metric);
  const spark = sparkline(metric.daily.map((d) => d.value));
  const line = `  ${label} ${current} →${target} [${spark}] ${trendArrow(metric, lang)} ${statusDot(renderStatus(metric), lang)}`;
  return trunc(line, width);
}

export function renderNorthPanel(report: NorthStarReport, lang: Lang, width = terminalWidth()): string {
  const safeWidth = Math.max(48, width);
  const out: string[] = [];
  const title = `${t(v3Catalog, lang, "north.title")} ${c("muted", `· ${report.windowDays}d · ${report.window.startDay}..${report.window.endDay}`)}`;
  out.push(trunc(title, safeWidth), "");
  for (const key of METRIC_KEYS) {
    out.push(metricLine(key, report.metrics[key], lang, safeWidth));
  }
  return out.join("\n");
}

function isoTime(ts: number): string {
  try {
    return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return String(ts);
  }
}

function renderJournalSummary(events: RollEvent[], lang: Lang, width = terminalWidth()): string {
  const count = countJournalEntries(events);
  if (count === 0) return "";
  const latest = latestJournalEntry(events);
  if (latest === undefined) return "";
  const line = `  ${t(v3Catalog, lang, "supervisor.journal.summary", count)} · ${t(v3Catalog, lang, "supervisor.journal.latest", latest.action, latest.actor, isoTime(latest.ts))}`;
  return trunc(line, width);
}

export function renderNorthStatusSummary(report: NorthStarReport | undefined, lang: Lang, width = terminalWidth()): string {
  if (report === undefined) return trunc(`  ${t(v3Catalog, lang, "north.status_title")}  ${t(v3Catalog, lang, "north.no_data")}`, width);
  const parts = METRIC_KEYS.map((key) => {
    const metric = report.metrics[key];
    const value = metric.current === null ? t(v3Catalog, lang, "north.no_data") : metricValue(key, metric.current, metric.target.unit);
    return `${metricShortName(key, lang)} ${value} ${c(statusColor(renderStatus(metric)), "●")}`;
  });
  return trunc(`  ${t(v3Catalog, lang, "north.status_title")}  ${parts.join(c("muted", " · "))}`, width);
}

export function northCommand(args: string[]): number {
  const json = args.includes("--json");
  const noColor = args.includes("--no-color");
  const unknown = args.filter((arg) => arg !== "--json" && arg !== "--no-color");
  if (unknown.length > 0) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (noColor || (process.env["NO_COLOR"] ?? "") !== "" || !process.stdout.isTTY) renderState.useColor = false;
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
  const root = projectRoot();
  const now = nowForNorth();
  let report: NorthStarReport;
  try {
    report = loadNorthStarReport(root, now);
  } catch {
    report = buildNorthStarReport({
      nowMs: now.getTime(),
      days: shWindowDays(now, 14),
      runs: [],
      events: [],
      cards: [],
      backlog: [],
      deliveries: [],
    });
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const width = terminalWidth();
    const panel = renderNorthPanel(report, lang, width);
    const journal = renderJournalSummary(readJournalEvents(loopDir(root)), lang, width);
    process.stdout.write(journal === "" ? `${panel}\n` : `${panel}\n${journal}\n`);
  }
  return 0;
}
