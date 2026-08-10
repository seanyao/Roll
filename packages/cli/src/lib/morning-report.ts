/**
 * @responsibility Builds the morning report digest from the event stream.
 */
import { CHROME_CONTROLS, CHROME_CSS, CHROME_SCRIPT, buildLoopDigestModel, serializeEvent, type LoopDigestModel, type MorningRunRow } from "@roll/core";
import { parseEventLine, type RollEvent } from "@roll/spec";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { rowDelivered } from "./truth-adapter.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function readEvents(path: string): RollEvent[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map(parseEventLine)
      .filter((ev): ev is RollEvent => ev !== null);
  } catch {
    return [];
  }
}

function readRuns(path: string): MorningRunRow[] {
  try {
    const all = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as MorningRunRow);
    // US-TRUTH-019: last-wins by (story_id, cycle_id) for append-only safety
    const lastWins = new Map<string, MorningRunRow>();
    const unkeyed: MorningRunRow[] = [];
    for (const row of all) {
      const sid = typeof row.story_id === "string" ? row.story_id : "";
      const cid = typeof row.cycle_id === "string" ? (row.cycle_id as string) : "";
      if (sid !== "" && cid !== "") {
        lastWins.set(`${sid}\t${cid}`, row);
      } else {
        unkeyed.push(row);
      }
    }
    return [...unkeyed, ...lastWins.values()];
  } catch {
    return [];
  }
}

function list(xs: string[], empty: string): string {
  return xs.length === 0 ? `<span class="muted">${esc(empty)}</span>` : xs.map((x) => `<code>${esc(x)}</code>`).join(" ");
}

function degradationMessage(model: LoopDigestModel): string {
  return `loop digest degraded: ${model.degradedReasons.join("; ")}`;
}

function degradationHash(reasons: readonly string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify([...reasons].sort()), "utf8").digest("hex")}`;
}

function readDegradedStateHash(path: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const hash = (raw as { reasonsHash?: unknown }).reasonsHash;
    return typeof hash === "string" && hash !== "" ? hash : undefined;
  } catch {
    return undefined;
  }
}

function writeDegradedStateHash(path: string, reasons: readonly string[], nowSec: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify(
      {
        reasonsHash: degradationHash(reasons),
        reasons: [...reasons].sort(),
        updatedAt: iso(nowSec),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  renameSync(tmp, path);
}

export function renderLoopDigestHtml(model: LoopDigestModel): string {
  const money = `$${model.totalCostUsd.toFixed(4)}`;
  const alertItems = model.alerts.length === 0
    ? `<li><span class="muted">No active alert in this window · 本窗口无 ALERT</span></li>`
    : model.alerts.map((a) => `<li>${esc(a)}</li>`).join("");
  const degradedBlock = model.degraded
    ? `<div class="degraded"><strong>DEGRADED · 数据降级</strong><p>${esc(model.degradedReasons.join("; "))}</p></div>\n`
    : "";
  return (
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>Roll · Loop Digest</title>\n<style>\n${CHROME_CSS}` +
    `body{max-width:960px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.tile{border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--bg-raise)}.num{font:700 28px/1 var(--mono);color:var(--pass)}.muted{color:var(--muted)}.pause{color:${model.paused ? "var(--fail)" : "var(--pass)"};font-weight:700}.degraded{border:1px solid var(--warn);border-radius:8px;padding:12px 14px;background:color-mix(in srgb,var(--warn) 9%,transparent);color:var(--fg)}.degraded strong{color:var(--warn)}.degraded p{margin:6px 0 0}.section{border-top:1px solid var(--line);padding-top:18px;margin-top:18px}code{margin-right:6px}ul{padding-left:22px}</style>\n` +
    `${CHROME_SCRIPT}\n</head>\n<body>\n${CHROME_CONTROLS}\n` +
    `<p class="crumb"><a href="../../features/index.html">Features Index</a> / Loop Digest</p>\n` +
    `<div class="masthead"><p class="kicker">Roll · Loop Digest</p>` +
    `<h1>Unattended Loop Summary</h1>` +
    `<p class="lede">${esc(iso(model.windowStart))} → ${esc(iso(model.windowEnd))}</p></div>\n` +
    degradedBlock +
    `<div class="grid">` +
    `<div class="tile"><div class="num">${model.cycles}</div><div>cycles · 周期</div></div>` +
    `<div class="tile"><div class="num">${model.deliveredStories.length}</div><div>delivered · 交付</div></div>` +
    `<div class="tile"><div class="num">${model.corrections}</div><div>corrections · 纠正</div></div>` +
    `<div class="tile"><div class="num">${money}</div><div>cost · 花费</div></div>` +
    `</div>\n` +
    `<p class="pause">${model.paused ? "PAUSED · 已熔断暂停" : "No circuit breaker · 未熔断"}</p>\n` +
    `<div class="section"><h2>Delivered · 已交付</h2><p>${list(model.deliveredStories, "None")}</p></div>\n` +
    `<div class="section"><h2>Returned / Rerouted · 被打回/改路由</h2><p>${list(model.returnedStories, "None")}</p></div>\n` +
    `<div class="section"><h2>Safety · 安全刹车</h2><p>${model.circuitBreakers} correction breaker(s) · ${model.circuitBreakers} 次纠正熔断</p></div>\n` +
    `<div class="section"><h2>Alerts · 告警</h2><ul>${alertItems}</ul></div>\n` +
    `<footer>Generated by <code>roll loop run-once</code> from <code>events.ndjson</code> and <code>runs.jsonl</code></footer>\n` +
    `</body>\n</html>\n`
  );
}

/** @deprecated Use renderLoopDigestHtml instead. */
export const renderMorningReportHtml = renderLoopDigestHtml;

export function loopDigestHref(projectPath: string): string | undefined {
  const report = join(projectPath, ".roll", "reports", "loop", "latest.html");
  if (existsSync(report)) return "../reports/loop/latest.html";
  // Compatibility: fall back to legacy morning path if loop digest hasn't been written yet
  const legacy = join(projectPath, ".roll", "reports", "morning", "latest.html");
  return existsSync(legacy) ? "../reports/morning/latest.html" : undefined;
}

/** @deprecated Use loopDigestHref instead. */
export const morningReportHref = loopDigestHref;

export function writeLatestLoopDigest(
  projectPath: string,
  eventsPath: string,
  runsPath: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const windowEnd = nowSec;
  const windowStart = nowSec - 12 * 60 * 60;
  const model = buildLoopDigestModel(readEvents(eventsPath), readRuns(runsPath), {
    windowStart,
    windowEnd,
    runDelivered: (row, now) => rowDelivered(row, now),
  });
  // Primary path: neutral loop digest
  const primaryDir = join(projectPath, ".roll", "reports", "loop");
  const latest = join(primaryDir, "latest.html");
  const dated = join(primaryDir, `${new Date(nowSec * 1000).toISOString().slice(0, 10)}.html`);
  const degradedState = join(primaryDir, "degraded-state.json");
  mkdirSync(primaryDir, { recursive: true });
  const html = renderLoopDigestHtml(model);
  writeFileSync(latest, html, "utf8");
  writeFileSync(dated, html, "utf8");
  // Compatibility: also write to legacy morning path so existing links don't break
  try {
    const legacyDir = join(projectPath, ".roll", "reports", "morning");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "latest.html"), html, "utf8");
  } catch {
    /* best-effort compatibility alias */
  }
  const currentDegradedHash = degradationHash(model.degradedReasons);
  const previousDegradedHash = readDegradedStateHash(degradedState);
  const shouldNotifyDegraded = model.degraded && currentDegradedHash !== previousDegradedHash;
  try {
    mkdirSync(dirname(eventsPath), { recursive: true });
    // FIX-1490: serializeEvent puts `ts` on the epoch-ms contract. These two
    // appends used to JSON.stringify a SECONDS clock straight to disk — one of
    // three writers that bypassed the bus (168 report:loop-digest + 33
    // alert:notify seconds events survive on disk from this path alone).
    if (shouldNotifyDegraded) {
      appendFileSync(
        eventsPath,
        serializeEvent({
          type: "alert:notify",
          channel: "loop-digest",
          message: degradationMessage(model),
          ts: nowSec,
        } satisfies RollEvent),
        "utf8",
      );
    }
    writeDegradedStateHash(degradedState, model.degradedReasons, nowSec);
    appendFileSync(
      eventsPath,
      serializeEvent({
        type: "report:loop-digest",
        path: ".roll/reports/loop/latest.html",
        windowStart,
        windowEnd,
        cycles: model.cycles,
        corrections: model.corrections,
        paused: model.paused,
        ts: nowSec,
      } satisfies RollEvent),
      "utf8",
    );
  } catch {
    /* report file is the primary artifact; event trace is best-effort */
  }
  return latest;
}

/** @deprecated Use writeLatestLoopDigest instead. */
export const writeLatestMorningReport = writeLatestLoopDigest;
