/**
 * `roll loop runs [N] [--all] [--detail <cycle>]` — TS port of bin/roll's
 * `_loop_runs` read-face command (US-PORT-007). Thin reader over the project's
 * `.roll/loop/runs.jsonl`: filter to this project (or `--all` across every
 * loop-registered project), newest-first, format each row. No bash fallback.
 *
 * Byte-aligned with the frozen bash oracle (`_loop_runs` + `_loop_runs_format_line`
 * + `_loop_runs_detail`). TS parses JSON natively, so the bash `jq required`
 * branch is unreachable here; every other observable line matches.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import { type Lang, resolveLang, t, v2Catalog } from "@roll/spec";
import { collectProjectsRegistry } from "../lib/projects-registry.js";
import { projectSlug, sharedRoot } from "./dashboard.js";

function lang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}
function msg(key: string, ...args: Array<string | number>): string {
  return t(v2Catalog, lang(), key, ...args);
}

/** Mirror bin/roll `_loop_runs_file`: resolve the current project's runs.jsonl. */
export function runsFile(): string {
  const envRt = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  if (envRt) return join(envRt, "runs.jsonl");
  const sharedDefault = join(sharedRoot(), "loop", "runs.jsonl");
  const override = (process.env["_LOOP_RUNS"] ?? "").trim();
  if (override && override !== sharedDefault) return override;
  const proj = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
  return join(proj, ".roll", "loop", "runs.jsonl");
}

type Row = Record<string, unknown>;

function parseRows(text: string): Row[] {
  const out: Row[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (r !== null && typeof r === "object" && !Array.isArray(r)) out.push(r as Row);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function num(v: unknown, dflt = 0): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : dflt;
}
function str(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** py/bash _loop_runs_dur. */
function runsDur(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.trunc(s / 60)}m`;
  return `${Math.trunc(s / 3600)}h ${Math.trunc((s % 3600) / 60)}m`;
}

/** bin/roll `_loop_runs_slowest_phase`: abbreviated slowest phase + its share. */
function slowestPhase(row: Row): string {
  const phases = row["phases"];
  if (phases === null || typeof phases !== "object" || Array.isArray(phases)) return "";
  const entries = Object.entries(phases as Record<string, unknown>).map(
    ([k, v]) => [k, num(v)] as [string, number],
  );
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return "";
  // sort_by(-.value) — descending; ties keep first-seen (stable).
  let maxName = "";
  let maxDur = 0;
  for (const [k, v] of entries) {
    if (v > maxDur) {
      maxDur = v;
      maxName = k;
    }
  }
  if (!maxName) return "";
  const abbr: Record<string, string> = {
    agent_invoke: "agent",
    publish_wait_merge: "pr-wait",
    publish_push: "publish",
    worktree_setup: "worktree",
  };
  const name = abbr[maxName] ?? maxName;
  const pct = Math.trunc((maxDur * 100 + Math.trunc(total / 2)) / total);
  return `${name} ${pct}%`;
}

/** HH:MM from an ISO ts, mirroring _loop_runs_format_line's date handling:
 *  a strict `...Z` ts is parsed as UTC and shown in local time; anything else
 *  falls back to the literal HH:MM in the string. */
function hhmm(ts: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ts)) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
      return `${p(d.getHours())}:${p(d.getMinutes())}`;
    }
  }
  const m = /.*T(\d{2}):(\d{2}).*/.exec(ts);
  return m ? `${m[1]}:${m[2]}` : "";
}

/** Replicate the bin/roll awk backlog lookup: exact id or `[id](...)` in col 2,
 *  description from col 3 (trimmed). Full multi-segment ids match (unlike
 *  dashboard's loadBacklog regex, which only catches single-segment families). */
function backlogDesc(backlogText: string, id: string): string {
  if (!backlogText) return "";
  for (const line of backlogText.split("\n")) {
    const cols = line.split("|");
    if (cols.length < 3) continue;
    const c2 = (cols[1] ?? "").trim();
    if (c2 === id || c2.startsWith(`[${id}]`)) {
      return (cols[2] ?? "").trim();
    }
  }
  return "";
}

/** bin/roll `_loop_runs_format_line` for a single row. */
function formatLine(row: Row, showProject: boolean, backlogText: string): string {
  const ts = str(row["ts"]);
  const status = str(row["status"]);
  const project = str(row["project"]);
  const tcr = num(row["tcr_count"]);
  const duration = num(row["duration_sec"]);
  const reason = str(row["reason"]);
  const builtCount = arr(row["built"]).length;
  const skippedCount = arr(row["skipped"]).length;
  const time = hhmm(ts);
  const prefix = showProject ? `[${basename(project)}] ` : "";

  const lines: string[] = [];
  if (status === "built") {
    const skippedNote = skippedCount > 0 ? `, ${skippedCount} skipped` : "";
    const itemsWord = builtCount === 1 ? "item" : "items";
    const slowestStr = slowestPhase(row);
    const slowestNote = slowestStr ? `, slowest=${slowestStr}` : "";
    lines.push(
      `  ${time}  ${prefix}✅ built ${builtCount} ${itemsWord} (${tcr} tcr${skippedNote}, ${runsDur(duration)}${slowestNote})`,
    );
    for (const idRaw of arr(row["built"])) {
      const id = typeof idRaw === "string" ? idRaw : String(idRaw);
      if (id === "") continue;
      let desc = backlogDesc(backlogText, id);
      if (desc) {
        if (desc.length > 72) desc = desc.slice(0, 69) + "...";
        lines.push(`    • ${id.padEnd(14)} ${desc}`);
      } else {
        lines.push(`    • ${id}`);
      }
    }
  } else if (status === "idle") {
    lines.push(`  ${time}  ${prefix}○ idle — no Todo items`);
  } else if (status === "failed") {
    lines.push(`  ${time}  ${prefix}✗ FAILED — ${reason || "unknown"}`);
  } else {
    lines.push(`  ${time}  ${prefix}? ${status}`);
  }
  return lines.join("\n");
}

/** Candidate runs.jsonl files for `--all`, deduped, mirroring bin/roll
 *  `_loop_runs_aggregate_all` (env hooks first, then launchd, then current). */
function aggregateAllFiles(): string[] {
  const candidates: string[] = [];
  const allDirs = (process.env["ROLL_LOOP_RUNS_ALL_DIRS"] ?? "").trim();
  if (allDirs) {
    for (const d of allDirs.split(":")) if (d) candidates.push(join(d, "runs.jsonl"));
  } else if ((process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim()) {
    candidates.push(join((process.env["ROLL_PROJECT_RUNTIME_DIR"] as string).trim(), "runs.jsonl"));
  } else {
    // codex r15: this used to enumerate projects from `com.roll.loop.*` plists ONLY,
    // which made `--all` progressively blind as owners followed the cleanup guide —
    // remove the debris, lose the history. The project registry is the real list and
    // has nothing to do with scheduling.
    for (const entry of collectProjectsRegistry()) {
      if (entry.path) candidates.push(join(entry.path, ".roll", "loop", "runs.jsonl"));
    }
    // A leftover lane may still point at a project the registry never recorded, so
    // it stays a supplementary source — never the only one.
    if (platform() === "darwin") {
      const laDir = (process.env["_LAUNCHD_DIR"] ?? "").trim() || join(homedir(), "Library", "LaunchAgents");
      let plists: string[] = [];
      try {
        plists = readdirSync(laDir).filter((f) => f.startsWith("com.roll.loop.") && f.endsWith(".plist"));
      } catch {
        plists = [];
      }
      for (const pl of plists) {
        let content: string;
        try {
          content = readFileSync(join(laDir, pl), "utf8");
        } catch {
          continue;
        }
        const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(content);
        if (m && m[1]) candidates.push(join(m[1], ".roll", "loop", "runs.jsonl"));
      }
    }
  }
  candidates.push(runsFile());

  const seen = new Set<string>();
  const files: string[] = [];
  for (const f of candidates) {
    if (!f || seen.has(f)) continue;
    try {
      if (!existsSync(f) || readFileSync(f, "utf8").trim() === "") continue;
    } catch {
      continue;
    }
    seen.add(f);
    files.push(f);
  }
  return files;
}

/** `--all`: merge every project's rows, stable-sorted oldest→newest by ts. */
function aggregateAllRows(): Row[] {
  const rows: Row[] = [];
  for (const f of aggregateAllFiles()) {
    try {
      rows.push(...parseRows(readFileSync(f, "utf8")));
    } catch {
      /* skip */
    }
  }
  // Stable sort by (ts // "") — same-ts rows keep encounter order.
  return rows
    .map((r, i) => [r, i] as [Row, number])
    .sort((a, b) => {
      const ta = str(a[0]["ts"]);
      const tb = str(b[0]["ts"]);
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a[1] - b[1];
    })
    .map(([r]) => r);
}

/** bin/roll `_loop_runs_detail`: the Phase Breakdown panel for one cycle. */
function runsDetail(cycleId: string): number {
  const src = runsFile();
  if (!existsSync(src)) {
    process.stdout.write(msg("loop.no_runs_jsonl_yet") + "\n");
    return 0;
  }
  let rows: Row[];
  try {
    rows = parseRows(readFileSync(src, "utf8"));
  } catch {
    rows = [];
  }
  const row = rows.find((r) => str(r["cycle_id"]) === cycleId);
  if (row === undefined) {
    process.stdout.write(msg("loop.cycle_not_found", cycleId) + "\n");
    return 1;
  }
  const phases = row["phases"];
  const phaseEntries =
    phases !== null && typeof phases === "object" && !Array.isArray(phases)
      ? Object.entries(phases as Record<string, unknown>).map(([k, v]) => [k, num(v)] as [string, number])
      : [];
  if (phaseEntries.length === 0) {
    process.stdout.write(msg("loop.cycle_has_no_phases_data_pre", cycleId) + "\n");
    return 0;
  }
  const out: string[] = ["", `─── Cycle ${cycleId} Phase Breakdown ───`];
  let total = phaseEntries.reduce((a, [, v]) => a + v, 0);
  if (total <= 0) total = 1;
  const sorted = [...phaseEntries].sort((a, b) => b[1] - a[1]);
  for (const [name, dur] of sorted) {
    if (!name) continue;
    const pct = Math.trunc((dur * 1000) / total);
    const pctStr = `${Math.trunc(pct / 10)}.${pct % 10}%`;
    const barLen = Math.trunc((dur * 20) / total);
    const bar = barLen > 0 ? "█".repeat(barLen) : "";
    out.push(`  ${name.padEnd(22)} ${String(dur).padStart(6)}s  (${pctStr.padStart(6)})  ${bar}`);
  }
  out.push("  ──────────────────────────────────────");
  out.push(`  ${"Total".padEnd(22)} ${String(total).padStart(6)}s`);
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

export function loopRunsCommand(argv: string[]): number {
  let n = 10;
  let allFlag = false;
  let detailCycle = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") allFlag = true;
    else if (a === "--detail") detailCycle = argv[++i] ?? "";
    else if (a !== undefined && a.startsWith("--detail=")) detailCycle = a.slice("--detail=".length);
    else if (a !== undefined && /^[0-9]+$/.test(a)) n = parseInt(a, 10);
  }

  if (detailCycle !== "") return runsDetail(detailCycle);

  let rows: Row[];
  if (allFlag) {
    rows = aggregateAllRows();
  } else {
    const src = runsFile();
    if (!existsSync(src) || readFileSync(src, "utf8").trim() === "") {
      process.stdout.write(msg("loop.no_loop_runs_yet") + "\n");
      return 0;
    }
    const slug = projectSlug();
    rows = parseRows(readFileSync(src, "utf8")).filter((r) => str(r["project"]) === slug);
  }

  if (rows.length === 0) {
    process.stdout.write(msg("loop.no_loop_runs_for_current_project") + "\n");
    return 0;
  }

  const recent = [...rows].reverse().slice(0, n);
  const proj = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
  let backlogText = "";
  const blPath = join(proj, ".roll", "backlog.md");
  if (existsSync(blPath)) {
    try {
      backlogText = readFileSync(blPath, "utf8");
    } catch {
      backlogText = "";
    }
  }
  const out = recent.map((r) => formatLine(r, allFlag, backlogText));
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}
