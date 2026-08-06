/**
 * @responsibility Runs the `roll loop signals` subcommand, reading scored runs for rubric signals.
 */
/**
 * `roll loop signals [--streak N] [--quiet]` — TS port of bin/roll's
 * `_loop_signals` read-face command (US-PORT-007). Reads the project's scored
 * runs.jsonl, asks the pure rubric detector (`@roll/core` detectSignals — a
 * direct port of lib/loop_result_eval.py) for any dimension that has been low
 * for N cycles in a row, and for each *fresh* signal (deduped on its stable key
 * against `.roll/loop/signals-seen-<slug>`) appends a CANDIDATE backlog DRAFT
 * (📋 待人确认) to `.roll/signals/candidates.md`.
 *
 * Human-on-the-loop invariant: it NEVER edits the real backlog, activates a
 * story, or touches code — it only exposes. No bash fallback.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectSignals } from "@roll/core";
import { type Lang, resolveLang, t, v2Catalog } from "@roll/spec";
import { projectSlug } from "./dashboard.js";
import { runsFile } from "./loop-runs.js";

function lang(): Lang {
  return resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
}

function nowIsoUtc(): string {
  // Mirror bin/roll `date -u +%Y-%m-%dT%H:%M:%SZ`.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function loopSignalsCommand(argv: string[]): number {
  let quiet = false;
  let streak = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(SIGNALS_HELP);
      return 0;
    }
    if (a === "--quiet") quiet = true;
    else if (a === "--streak") {
      const v = argv[++i];
      const n = parseInt(v ?? "", 10);
      streak = Number.isFinite(n) ? n : 3;
    } else if (a !== undefined && a.startsWith("--streak=")) {
      const n = parseInt(a.slice("--streak=".length), 10);
      streak = Number.isFinite(n) ? n : 3;
    }
  }
  const say = (s: string): void => {
    if (!quiet) process.stdout.write(s + "\n");
  };

  const runsSrc = runsFile();
  if (!existsSync(runsSrc) || readFileSync(runsSrc, "utf8").trim() === "") {
    say(t(v2Catalog, lang(), "loop.no_loop_runs_yet"));
    return 0;
  }

  // Prefer the main project dir (the inner runner runs from a worktree, so
  // candidates/dedup must land in the canonical .roll/).
  const projectPath = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
  const slug = projectSlug();

  // Records for this project, oldest→newest (file order), for the detector.
  const records: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(runsSrc, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (r !== null && typeof r === "object" && !Array.isArray(r) && (r as Record<string, unknown>)["project"] === slug) {
        records.push(r as Record<string, unknown>);
      }
    } catch {
      /* skip */
    }
  }

  const signals = detectSignals(records, streak);

  const rtDir = (process.env["_LOOP_RT_DIR"] ?? "").trim() || join(projectPath, ".roll", "loop");
  const seenFile = join(rtDir, `signals-seen-${slug}`);
  const candFile = join(projectPath, ".roll", "signals", "candidates.md");
  mkdirSync(rtDir, { recursive: true });
  mkdirSync(dirname(candFile), { recursive: true });
  if (!existsSync(seenFile)) writeFileSync(seenFile, "");

  // next candidate id — scan existing candidates so re-runs keep counting up.
  let lastId = 0;
  if (existsSync(candFile)) {
    for (const m of readFileSync(candFile, "utf8").matchAll(/CAND-(\d+)/g)) {
      const n = parseInt(m[1] ?? "0", 10);
      if (n > lastId) lastId = n;
    }
  }

  const seen = new Set(
    existsSync(seenFile)
      ? readFileSync(seenFile, "utf8").split("\n").filter((l) => l !== "")
      : [],
  );

  let newCount = 0;
  for (const sig of signals) {
    if (seen.has(sig.key)) continue;
    lastId += 1;
    const candId = `CAND-${String(lastId).padStart(3, "0")}`;
    const ts = nowIsoUtc();
    const block =
      `\n## ${candId} — ${sig.dim} (${sig.kind}) 📋 待人确认\n` +
      `- Detected: ${ts}\n` +
      `- Pattern: ${sig.key}\n` +
      `- Signal: ${sig.summary}\n` +
      `- 信号：result-eval 维度 ${sig.dim} 连续 ${sig.streak} 轮低分；候选 ${sig.kind}，待人确认后再激活。\n`;
    appendFileSync(candFile, block);
    appendFileSync(seenFile, sig.key + "\n");
    seen.add(sig.key);
    newCount += 1;
    say(`signal: ${candId} ${sig.dim} → candidate ${sig.kind} (${sig.summary})`);
  }

  if (newCount === 0) {
    say("no new improvement signals (result-eval patterns)");
    return 0;
  }
  say(`${newCount} candidate draft(s) → ${candFile} (📋 待人确认, not activated)`);
  return 0;
}

const SIGNALS_HELP = `Usage: roll loop signals [--streak N] [--quiet]

  Detect repeated low-score patterns in the cycle result-eval history and
  expose them as improvement signals: each fresh pattern appends a CANDIDATE
  backlog draft (IDEA/FIX, marked 📋 待人确认) to .roll/signals/candidates.md.
  Deduped per pattern, so a standing issue is raised once, not every cycle.
  Never edits the real backlog, activates a story, or changes code.

  检测 cycle 结果评分中反复出现的低分模式，暴露成改善信号：每个新模式向
  .roll/signals/candidates.md 追加一条候选 backlog 草稿（IDEA/FIX，标 📋 待人确认）。
  按模式去重，同一问题只提一次；绝不改真实 backlog / 激活故事 / 改代码。

Options:
  --streak N   consecutive low cycles required to fire (default 3)
  --quiet      suppress the "no new signals" line (used by the cycle hook)
`;
