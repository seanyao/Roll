/**
 * `roll loop status` — TS port of lib/roll-loop-status.py (US-CLI-006).
 *
 * Renders the loop health dashboard. Byte-aligned with the python oracle
 * (fixture + live diff-tests). Display time is fixed to Asia/Shanghai (UTC+8,
 * no DST): internal timestamps stay UTC, only display conversions add +8h.
 *
 * Most `loop` subcommands stay on the bash fallback; only `status` (and the
 * `--eval` view it owns) is ported here.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import { resolveLoopRunState } from "./loop-sched.js";
import {
  COLS,
  c,
  cycleRow,
  dayBand,
  fmtDur,
  metric,
  metricDollar,
  metricDur,
  metricTokens,
  pad,
  renderState,
  row,
  trunc,
  type CycleView,
} from "../render.js";
import {
  INNER_LOCK_STALE_SEC,
  isOwnerHeld,
  livenessVerdict,
  readLockOwner,
  systemPidAlive,
  type PidAlive,
} from "@roll/infra";
import { getAgentSpec } from "@roll/core";
import { computeListCost, currencyFor } from "./prices-cost.js";
import { exemptionStats, renderExemptionSignal } from "../runner/exemption-stats.js";
import { screenLockWaitReason } from "../runner/screen-lock-events.js";
import { TRUTH_SCHEMA_EPOCH_SEC, cycleTruthFromRow, deliveryGateDiagnosticsFromRows, outcomeToPanel, type DeliveryGateDiagnostic } from "../lib/truth-adapter.js";
import { collectToolEvidenceFromEventsPath, formatToolCostSummary } from "../lib/tool-display.js";
import { deliveryMetrics } from "../lib/cycle-ledger.js";
import { reconciledLedger, deliveryMetricsLine } from "./cycles.js";
import { TZ_OFFSET_MS, dayKeyOffset, pad2, shDayKey, shHHMM, shYmdHm, toShanghai } from "../lib/sh-time.js";

function parseTs(ts: string): Date {
  return new Date(ts.replace("Z", "+00:00"));
}

// ════════════════════════════════════════════════════════════════════════════
// Paths — mirror project_slug / shared_root / runtime-dir resolution.
// ════════════════════════════════════════════════════════════════════════════
function gitRemoteUrl(repoPath: string): string | null {
  try {
    const url = execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (url) return url;
  } catch {
    /* no origin */
  }
  try {
    const remotes = execFileSync("git", ["-C", repoPath, "remote"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .filter((x) => x !== "");
    if (remotes.length > 0) {
      const url = execFileSync("git", ["-C", repoPath, "remote", "get-url", remotes[0] ?? ""], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (url) return url;
    }
  } catch {
    /* no remotes */
  }
  return null;
}

export function projectSlug(p?: string): string {
  const envSlug = (process.env["ROLL_MAIN_SLUG"] ?? "").trim();
  if (envSlug) return envSlug;

  let path = realpathSync(p ?? process.cwd());
  try {
    const common = execFileSync("git", ["-C", path, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common.endsWith("/.git")) path = common.slice(0, -5);
  } catch {
    /* not a git repo */
  }

  let remoteUrl = gitRemoteUrl(path);
  if (remoteUrl) {
    remoteUrl = remoteUrl.replace(/\/+$/, "");
    if (remoteUrl.endsWith(".git")) remoteUrl = remoteUrl.slice(0, -4);
    const m = /^git@([^:]+):(.+)$/.exec(remoteUrl);
    if (m) remoteUrl = `https://${m[1]}/${m[2]}`;
    remoteUrl = remoteUrl.toLowerCase();
    const base = basename(remoteUrl)
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const h = createHash("md5").update(remoteUrl).digest("hex").slice(0, 6);
    return `${base}-${h}`;
  }

  const base = basename(path)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const h = createHash("md5").update(path).digest("hex").slice(0, 6);
  return `${base}-${h}`;
}

export function sharedRoot(): string {
  return process.env["ROLL_SHARED_ROOT"] || join(homedir(), ".shared", "roll");
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveProjectPath(slug: string): string | null {
  const envProj = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim();
  if (envProj && isDir(envProj)) return envProj;

  if (platform() === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", `com.roll.loop.${slug}.plist`);
    if (existsSync(plist)) {
      try {
        const text = readFileSync(plist, "utf8");
        const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
        if (m && m[1] !== undefined && isDir(m[1])) return m[1];
      } catch {
        /* unreadable */
      }
    }
  }

  try {
    const cronOut = execFileSync("crontab", ["-l"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of cronOut.split("\n")) {
      if (line.includes(`run-${slug}.sh`)) {
        const m = /cd\s+"([^"]+)"/.exec(line);
        if (m && m[1] !== undefined && isDir(m[1])) return m[1];
      }
    }
  } catch {
    /* no crontab */
  }

  const innerScript = join(sharedRoot(), "loop", `run-${slug}-inner.sh`);
  if (existsSync(innerScript)) {
    try {
      const text = readFileSync(innerScript, "utf8");
      const m = /export ROLL_MAIN_PROJECT="([^"]+)"/.exec(text);
      if (m && m[1] !== undefined && isDir(m[1])) return m[1];
    } catch {
      /* unreadable */
    }
  }
  return null;
}

export function loopRuntimeDir(slug: string): string | null {
  const envRt = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  if (envRt) return envRt;
  const proj = resolveProjectPath(slug);
  if (proj === null) return null;
  return join(proj, ".roll", "loop");
}

// ════════════════════════════════════════════════════════════════════════════
// Loaders
// ════════════════════════════════════════════════════════════════════════════
interface RawEvent {
  ts?: string;
  label?: string;
  stage?: string;
  detail?: unknown;
  outcome?: string;
  _ts: Date;
}

/** v3 RollEvent `type` → the legacy bash `stage` the reader/aggregate expect. */
const V3_TYPE_TO_STAGE: Record<string, string> = {
  "cycle:start": "cycle_start",
  "cycle:end": "cycle_end",
  pick_todo: "pick_todo",
};

/**
 * FIX-213: bridge the v3 heart's NATIVE RollEvent line to the legacy reader.
 *
 * The TS runner appends `{ type: "cycle:end", cycleId, ts: <epoch seconds> }`,
 * but `loadEvents`/`aggregate` were written for the bash shape
 * (`stage`/`label`/ISO `ts`). A numeric epoch is `Invalid Date` under
 * `parseTs`, so v3 events were silently dropped and history read 0 cycles.
 *
 * A row that already carries a string `stage` is the legacy shape and passes
 * through byte-identical (keeps the python-oracle difftest parity). A row with
 * a string `type` is the v3 shape: map `type → stage`, `cycleId → label`, and
 * the numeric epoch (seconds, or ms when ≥ 1e12) → an ISO string `parseTs`
 * understands.
 */
/**
 * FIX-248 — fold every outcome literal (v2 stages, v3 events, v3 runs rows)
 * onto the panel's classification vocabulary. The panel counts/glyphs key on
 * exactly "fail" / "done" / "idle" / "running"; v3 emits "failed" / "blocked" /
 * "aborted" / "delivered" / "published" / "merged" — without this fold the
 * 2026-06-10 panel read "15 cycles · 0 failed" against 14 real failures.
 */
const OUTCOME_FOLD: Record<string, string> = {
  // failure family
  failed: "fail",
  blocked: "fail",
  aborted: "fail",
  interrupted: "fail",
  fail: "fail",
  // success family ("published" = delivered, merge pending — FIX-244)
  delivered: "done",
  merged: "done",
  published: "done",
  done: "done",
};

export function panelOutcome(o: string): string {
  return OUTCOME_FOLD[o] ?? o;
}

export function normalizeRawEvent(raw: unknown): RawEvent {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw as RawEvent; // parseTs(undefined) will drop it downstream
  }
  const o = raw as Record<string, unknown>;
  if (typeof o["stage"] === "string") return o as unknown as RawEvent; // legacy — untouched
  if (typeof o["type"] !== "string") return o as unknown as RawEvent;
  const type = o["type"] as string;
  const tsNum = typeof o["ts"] === "number" ? (o["ts"] as number) : NaN;
  const ms = Number.isFinite(tsNum) ? (tsNum < 1e12 ? tsNum * 1000 : tsNum) : NaN;
  const isoTs = Number.isFinite(ms) ? new Date(ms).toISOString() : String(o["ts"] ?? "");
  return {
    ts: isoTs,
    stage: V3_TYPE_TO_STAGE[type] ?? type,
    label: typeof o["cycleId"] === "string" ? (o["cycleId"] as string) : ((o["label"] as string) ?? ""),
    detail: o["detail"],
    ...(typeof o["outcome"] === "string" ? { outcome: o["outcome"] as string } : {}),
    _ts: new Date(NaN),
  };
}

function loadEvents(slug: string, days: number): RawEvent[] {
  const candidates: string[] = [];
  const rtDir = loopRuntimeDir(slug);
  if (rtDir !== null) {
    const head = join(rtDir, "events.ndjson");
    candidates.push(head);
    for (let i = 1; i < 5; i++) candidates.push(join(rtDir, `events.ndjson.${i}`));
  }
  const sharedHead = join(sharedRoot(), "loop", `events-${slug}.ndjson`);
  candidates.push(sharedHead);
  for (let i = 1; i < 5; i++) {
    candidates.push(join(sharedRoot(), "loop", `events-${slug}.ndjson.${i}`));
  }
  const existing = candidates.filter((p) => existsSync(p));
  if (existing.length === 0) return [];
  const cutoff = renderNow().getTime() - (days + 1) * 86400 * 1000;
  const out: RawEvent[] = [];
  const seen = new Set<string>();
  for (const p of existing) {
    let content: string;
    try {
      content = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (let line of content.split("\n")) {
      line = line.trim();
      if (line === "") continue;
      if (seen.has(line)) continue;
      seen.add(line);
      try {
        const e = normalizeRawEvent(JSON.parse(line));
        const ts = parseTs(String(e.ts));
        e._ts = ts;
        if (ts.getTime() >= cutoff) out.push(e);
      } catch {
        continue;
      }
    }
  }
  out.sort((a, b) => a._ts.getTime() - b._ts.getTime());
  return out;
}

const CRON_PAT =
  /^(\d{2}:\d{2}):(\d{2})\s+cycle done — (\w+)(?:\s*·\s*(\d+)\s+tcr)?\s*·\s*(\d+)s\s*·\s*\$([\d.]+)/;
const ANSI_RE = /\x1b\[[\d;]*m/g;

interface CronEntry {
  hhmm: string;
  ss: number;
  outcome: string;
  tcr: number;
  duration_s: number;
  cost: number;
}

function loadCronLog(slug: string): CronEntry[] {
  const rtDir = loopRuntimeDir(slug);
  let path = rtDir !== null ? join(rtDir, "cron.log") : null;
  if (path === null || !existsSync(path)) {
    path = join(sharedRoot(), "loop", `cron-${slug}.log`);
  }
  if (!existsSync(path)) return [];
  const out: CronEntry[] = [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  for (const rawLine of content.split("\n")) {
    const m = CRON_PAT.exec(rawLine.replace(ANSI_RE, "").trim());
    if (m) {
      out.push({
        hhmm: m[1] ?? "",
        ss: parseInt(m[2] ?? "0", 10),
        outcome: m[3] ?? "",
        tcr: parseInt(m[4] ?? "0", 10),
        duration_s: parseInt(m[5] ?? "0", 10),
        cost: parseFloat(m[6] ?? "0"),
      });
    }
  }
  return out;
}

function loadState(slug: string): Record<string, string> {
  const rtDir = loopRuntimeDir(slug);
  let path = rtDir !== null ? join(rtDir, "state.yaml") : null;
  if (path === null || !existsSync(path)) {
    path = join(sharedRoot(), "loop", `state-${slug}.yaml`);
  }
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  for (const line of content.split("\n")) {
    const m = /^([\w_]+):\s*(.*?)\s*$/.exec(line);
    if (m) {
      let v = (m[2] ?? "").trim();
      v = v.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
      out[m[1] ?? ""] = v;
    }
  }
  return out;
}

export function loadBacklog(projectRoot?: string): Record<string, string> {
  const path = join(projectRoot ?? "", ".roll/backlog.md");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  const pat = /^\|\s*(?:\[)?([A-Z]+-\d+)(?:\]\([^)]+\))?\s*\|\s*([^|]+?)\s*\|/;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  for (const line of content.split("\n")) {
    const m = pat.exec(line);
    if (m) out[m[1] ?? ""] = m[2] ?? "";
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Cycle aggregation
// ════════════════════════════════════════════════════════════════════════════
const STORY_ID_PAT = /\b([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+)\b/;
const PR_NUM_PAT = /\/pull\/(\d+)/;

function extractStoryId(detail: string): string | null {
  if (!detail) return null;
  const m = STORY_ID_PAT.exec(detail);
  return m ? (m[1] ?? null) : null;
}

function extractPrNum(url: string): number | null {
  if (!url) return null;
  const m = PR_NUM_PAT.exec(url);
  return m ? parseInt(m[1] ?? "0", 10) : null;
}

function normalizePrOutcome(raw: string): string {
  if (raw === "merged" || raw === "closed" || raw === "open") return raw;
  return "open";
}

function normalizeCycleLabel(lbl: string): string {
  if (lbl.startsWith("loop/cycle-")) return lbl.slice("loop/cycle-".length);
  return lbl;
}

export interface Cycle {
  label: string;
  start: Date | null;
  end: Date | null;
  outcome: string | null;
  story: string | null;
  pr: string | null;
  pr_ts?: Date;
  pr_num?: number;
  pr_outcome?: string;
  fail_detail: string | null;
  agent?: string;
  usage_event?: Record<string, unknown>;
  cron?: CronEntry;
  duration_s?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  model?: string | null;
  cost_list?: number | null;
  cost_currency?: string;
  cost_list_legacy?: boolean;
  tool_summary?: string;
  tcr_count?: number;
  built?: string[];
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? 0), 10);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function aggregate(events: RawEvent[], cron: CronEntry[]): Cycle[] {
  const byLabel = new Map<string, Cycle>();
  const getCy = (lbl: string): Cycle => {
    let cy = byLabel.get(lbl);
    if (cy === undefined) {
      cy = {
        label: lbl,
        start: null,
        end: null,
        outcome: null,
        story: null,
        pr: null,
        fail_detail: null,
      };
      byLabel.set(lbl, cy);
    }
    return cy;
  };

  for (const e of events) {
    const lbl = normalizeCycleLabel(e.label ?? "");
    if (!lbl || lbl.startsWith("tmp-")) continue;
    const cy = getCy(lbl);
    cy.label = lbl;
    const stage = e.stage ?? "";
    const detail = typeof e.detail === "string" ? e.detail : "";
    if (stage === "cycle_start") {
      cy.start = e._ts;
    } else if (stage === "cycle_end") {
      cy.end = e._ts;
      cy.outcome = panelOutcome(e.outcome ?? "done"); // FIX-248: v3 literals fold
    } else if (stage === "idle") {
      cy.end = e._ts;
      cy.outcome = "idle";
    } else if (stage === "pr") {
      cy.pr = detail;
      cy.pr_ts = e._ts;
      const prNum = extractPrNum(detail);
      if (prNum !== null) cy.pr_num = prNum;
      cy.pr_outcome = normalizePrOutcome(e.outcome ?? "");
      const sid = extractStoryId(detail) ?? extractStoryId(lbl);
      if (sid && !cy.story) cy.story = sid;
    } else if (stage === "pick_todo") {
      const sid = extractStoryId(detail);
      if (sid) cy.story = sid;
    } else if (stage === "agent_used") {
      if (detail) cy.agent = detail;
    } else if (stage === "usage") {
      const d = e.detail;
      if (d !== null && typeof d === "object" && !Array.isArray(d)) {
        const dd = d as Record<string, unknown>;
        const prev = cy.usage_event ?? {};
        const merged: Record<string, unknown> = { ...prev, ...dd };
        for (const k of [
          "input_tokens",
          "output_tokens",
          "cache_creation_tokens",
          "cache_read_tokens",
        ]) {
          merged[k] = toInt(prev[k]) + toInt(dd[k]);
        }
        cy.usage_event = merged;
      }
    } else if ((stage === "test" || stage === "build") && e.outcome === "fail") {
      cy.fail_detail = detail || stage;
    }
  }

  const cycles = [...byLabel.values()].filter((v) => v.start !== null);
  // stable sort newest-first by start time (Array.sort is stable in V8)
  cycles.sort((a, b) => (b.start as Date).getTime() - (a.start as Date).getTime());

  for (const cy of cycles) {
    const anchor = cy.pr_ts ?? cy.end ?? cy.start;
    if (anchor) {
      // Quirk parity: python reads anchor.hour/minute/second off the UTC-aware
      // datetime (UTC fields), while cron entries carry *local* HH:MM:SS — so
      // the two are 8h apart and rarely match. Mirror the UTC read exactly.
      const target =
        anchor.getUTCHours() * 3600 + anchor.getUTCMinutes() * 60 + anchor.getUTCSeconds();
      let best: CronEntry | null = null;
      let bestDt = 999;
      for (const cr of cron) {
        const [ch, cm] = cr.hhmm.split(":");
        const csec = parseInt(ch ?? "0", 10) * 3600 + parseInt(cm ?? "0", 10) * 60 + cr.ss;
        const dt = Math.abs(csec - target);
        if (dt < bestDt) {
          bestDt = dt;
          best = cr;
        }
      }
      if (best && bestDt <= 120) cy.cron = best;
    }

    if (cy.end && cy.start) {
      cy.duration_s = Math.trunc((cy.end.getTime() - cy.start.getTime()) / 1000);
    } else if (cy.cron) {
      cy.duration_s = cy.cron.duration_s;
    }

    if (!cy.outcome) {
      cy.outcome = !cy.end ? "running" : "unknown";
    }
  }
  return cycles;
}

/** A live-cycle verdict — the dashboard eyebrow and the US-PORT-011 observation
 *  window share this single determination (FIX-203, req 4). */
export interface LiveCycle {
  /** A v3 cycle is executing right now. */
  running: boolean;
  /** The story being worked, when known (from the open cycle's `pick_todo`). */
  story: string | null;
  /** Wall-clock seconds since the open cycle's `cycle_start`. */
  elapsedSec: number;
}

/**
 * Decide whether a v3 cycle is live RIGHT NOW, reading the signals the v3 heart
 * actually emits (FIX-203). The v2 `state.yaml` `status:` line the old eyebrow
 * trusted is never written by the TS runner, so liveness must come from:
 *   - a held `inner.lock` — pid alive AND fresh (`isOwnerHeld`, 4h staleness), and
 *   - a fresh `heartbeat` (`livenessVerdict`, 30-min default), and
 *   - a most-recent `cycle_start` with no matching `cycle_end` (an open cycle).
 *
 * All three must hold; any missing/stale signal → not running. This is
 * deliberately conservative so a crashed cycle (dead pid / stale heartbeat)
 * does not masquerade as live. `rtDir === null` (fixture / unresolved project)
 * → not running.
 */
export function detectLiveCycle(
  rtDir: string | null,
  cycles: Cycle[],
  now: Date,
  pidAlive: PidAlive = systemPidAlive,
): LiveCycle {
  const dead: LiveCycle = { running: false, story: null, elapsedSec: 0 };
  if (rtDir === null) return dead;
  const lockPath = join(rtDir, "inner.lock");
  if (!existsSync(lockPath)) return dead;
  const nowSec = Math.floor(now.getTime() / 1000);
  const owner = readLockOwner(lockPath);
  if (!isOwnerHeld(owner, nowSec, INNER_LOCK_STALE_SEC, pidAlive)) return dead;
  const hb = livenessVerdict(join(rtDir, "heartbeat"), { now: () => nowSec });
  if (!hb.alive) return dead;
  // cycles are sorted newest-first; the MOST RECENT open cycle (no end) is the
  // live cycle — but we skip zombies: a cycle open > ZOMBIE_THRESHOLD_SEC is a
  // crash artifact, not a running cycle (FIX-217).
  const ZOMBIE_THRESHOLD_SEC = 2 * 3600; // 2 hours
  for (const cy of cycles) {
    if (cy.start === null || cy.end !== null) continue;
    const elapsedSec = Math.max(0, Math.trunc((now.getTime() - cy.start.getTime()) / 1000));
    if (elapsedSec > ZOMBIE_THRESHOLD_SEC) continue; // zombie — skip
    return { running: true, story: cy.story, elapsedSec };
  }
  return dead;
}

// ════════════════════════════════════════════════════════════════════════════
// runs.jsonl
// ════════════════════════════════════════════════════════════════════════════
interface RunRecord {
  project?: string;
  run_id?: string;
  ts?: string;
  tcr_count?: number;
  built?: string[];
  duration_sec?: number;
  status?: string;
  agent?: string;
  result_eval?: unknown;
  [k: string]: unknown;
}

function loadRuns(slug: string): Record<string, RunRecord> {
  const rtDir = loopRuntimeDir(slug);
  let path = rtDir !== null ? join(rtDir, "runs.jsonl") : null;
  if (path === null || !existsSync(path)) {
    path = join(sharedRoot(), "loop", "runs.jsonl");
  }
  if (!existsSync(path)) return {};
  const base = slug.split("-")[0] ?? "";
  const projPath = resolveProjectPath(slug);
  const out: Record<string, RunRecord> = {};
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r === null || typeof r !== "object" || Array.isArray(r)) continue;
    const rec = r as RunRecord;
    const p = rec.project ?? "";
    // FIX-213: a project-less row (the shape buildRunRow wrote) read from the
    // per-project runtime file is THIS project's — don't drop it. A stray row
    // from another project can only ENRICH a cycle of ours via the id-match in
    // mergeRunsIntoCycles (run_id == cycleId), so admitting it is harmless.
    if (p !== "" && p !== slug && p !== base && !p.startsWith(`${slug}-cycle-`)) {
      if (projPath === null) continue;
      const otherProj = resolveProjectPath(p);
      if (otherProj === null || otherProj !== projPath) continue;
    }
    const rid = rec.run_id ?? "";
    if (rid) out[rid] = rec;
  }
  return out;
}

/** Fold one runs row into its matched cycle. `ts` is the row's parsed timestamp
 *  when known (used only to cap a reported duration against wall-clock); null
 *  for a tsless v3 row matched by id. */
function applyRunRow(cy: Cycle, r: RunRecord, ts: Date | null): void {
  cy.tcr_count = r.tcr_count ?? 0;
  cy.built = r.built && Array.isArray(r.built) ? r.built : [];
  if (r.duration_sec) {
    if (ts !== null && cy.start !== null) {
      const cap = Math.trunc((ts.getTime() - cy.start.getTime()) / 1000);
      cy.duration_s = cap > 0 ? Math.min(r.duration_sec, cap) : r.duration_sec;
    } else if (!cy.duration_s) {
      cy.duration_s = r.duration_sec;
    }
  }
  // US-TRUTH-004: the runs row is the cycle_outcome anchor's view — classify
  // it through the ONE truth adapter (selector-backed) instead of a local
  // literal map. Eligibility unchanged (richer event verdicts not downgraded);
  // "built" keeps its v2 done-parity via the published_pending_merge fold.
  if (
    (cy.outcome === "unknown" ||
      cy.outcome === "running" ||
      cy.outcome === "idle" ||
      cy.outcome === "fail" ||
      cy.outcome === "failed" ||
      cy.outcome === "built" ||
      cy.outcome === "orphan") &&
    r.status
  ) {
    const truth = cycleTruthFromRow(r as Record<string, unknown>, { nowSec: Math.floor(renderNow().getTime() / 1000) });
    cy.outcome = outcomeToPanel(truth.outcome, truth.state);
  }
  // FIX-213: surface the v3 row's own cost/token fields. v2 rows omit these
  // (cost arrives via `usage` events) so this is a no-op for them, but the v3
  // heart emits no `usage` events — without this the cost columns stay blank
  // for real deliveries.
  if (typeof r["cost_usd"] === "number" && cy.cost_list == null) cy.cost_list = r["cost_usd"];
  // FIX-361: surface native currency from the v3 row so display shows ¥ vs $.
  if (typeof r["cost_currency"] === "string" && cy.cost_currency == null) cy.cost_currency = r["cost_currency"];
  if (typeof r["tokens_in"] === "number" && !cy.input_tokens) cy.input_tokens = r["tokens_in"];
  if (typeof r["tokens_out"] === "number" && !cy.output_tokens) cy.output_tokens = r["tokens_out"];
  // FIX-249 AC3: the v3 row's cache split + model feed the same columns the
  // v2 `usage` events used to fill.
  if (typeof r["tokens_cache_read"] === "number" && !cy.cache_read_tokens) cy.cache_read_tokens = r["tokens_cache_read"];
  if (typeof r["tokens_cache_write"] === "number" && !cy.cache_creation_tokens) cy.cache_creation_tokens = r["tokens_cache_write"];
  if (typeof r["model"] === "string" && r["model"] !== "" && !cy.model) cy.model = r["model"];
  if (!cy.story && cy.built.length > 0) cy.story = cy.built[0] ?? null;
  if (!cy.story && typeof r["story_id"] === "string" && r["story_id"] !== "") cy.story = r["story_id"];
}

function attachToolEvidence(cycles: Cycle[], rtDir: string | null): void {
  if (rtDir === null) return;
  const evidence = collectToolEvidenceFromEventsPath(join(rtDir, "events.ndjson"));
  for (const cy of cycles) {
    const costs = evidence.costsByCycle.get(cy.label);
    if (costs === undefined || costs.length === 0) continue;
    cy.tool_summary = formatToolCostSummary(costs);
  }
}

/** @returns the run_ids that matched a rendered cycle (id- or ts-window-match)
 *  — FIX-248 AC2 pins the agents line to exactly this set. */
export function mergeRunsIntoCycles(cycles: Cycle[], runs: Record<string, RunRecord>): Set<string> {
  const consumed = new Set<string>();
  const idMatched = new Set<Cycle>();

  // FIX-213: id-match first. A v3 runs row is keyed by run_id == cycleId == the
  // cycle's label, so it attaches directly with no ts (the row may lack one).
  // This is what makes historical deliveries' story / tcr / cost surface in
  // ROLLUP + RECENT instead of reading 0 cycles.
  for (const cy of cycles) {
    const r = runs[cy.label];
    if (r === undefined) continue;
    const tsRaw = parseTs(String(r.ts));
    applyRunRow(cy, r, Number.isNaN(tsRaw.getTime()) ? null : tsRaw);
    consumed.add(cy.label);
    idMatched.add(cy);
  }

  // ts-window match for legacy v2 rows whose run_id ("loop-…") differs from the
  // event label ("YYYYMMDD-…-pid") — unchanged heuristic, oracle-parity safe.
  const runsList: Array<[Date, string, RunRecord]> = [];
  for (const [rid, r] of Object.entries(runs)) {
    if (consumed.has(rid)) continue;
    try {
      const ts = parseTs(String(r.ts));
      if (Number.isNaN(ts.getTime())) continue;
      runsList.push([ts, rid, r]);
    } catch {
      continue;
    }
  }
  runsList.sort((a, b) => a[0].getTime() - b[0].getTime());

  for (let i = 0; i < cycles.length; i++) {
    const cy = cycles[i];
    if (cy === undefined || cy.start === null || idMatched.has(cy)) continue;
    const start = cy.start;
    const prevCy = i > 0 ? cycles[i - 1] : undefined;
    const nextStart =
      prevCy && prevCy.start
        ? prevCy.start
        : new Date(start.getTime() + 2 * 3600 * 1000);
    let windowEnd: Date;
    if (cy.end) {
      const clamp = new Date(cy.end.getTime() + 30 * 60 * 1000);
      windowEnd = clamp.getTime() < nextStart.getTime() ? clamp : nextStart;
    } else {
      windowEnd = nextStart;
    }
    let best: [Date, string, RunRecord] | null = null;
    for (const entry of runsList) {
      const [ts, rid] = entry;
      if (consumed.has(rid)) continue;
      if (ts.getTime() < start.getTime()) continue;
      if (ts.getTime() >= windowEnd.getTime()) break;
      if (best === null || ts.getTime() < best[0].getTime()) best = entry;
    }
    if (best === null) continue;
    const [ts, rid, r] = best;
    consumed.add(rid);
    applyRunRow(cy, r, ts);
  }
  return consumed;
}

// ════════════════════════════════════════════════════════════════════════════
// git merge repair
// ════════════════════════════════════════════════════════════════════════════
interface GitMerge {
  pr: string | null;
  stories: string[];
}

function loadPrMergesFromGit(days: number): Record<string, GitMerge> {
  let out: string;
  try {
    out = execFileSync(
      "git",
      [
        "log",
        `--since=${days + 1} days ago`,
        "--grep=loop[ /]cycle",
        "--extended-regexp",
        "--format=%H|||%s|||%b<<<END>>>",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return {};
  }
  const result: Record<string, GitMerge> = {};
  const labelRe = /loop[ /]cycle[-\s](\d{8}-\d+-\d+)/;
  const prRe = /#(\d+)/;
  const storyRe = /\b([A-Z]+(?:-[A-Z]+)*-\d+)\b/g;
  for (let chunk of out.split("<<<END>>>")) {
    chunk = chunk.trim();
    if (!chunk) continue;
    const parts = chunk.split("|||");
    if (parts.length < 3) continue;
    const subj = parts[1] ?? "";
    const body = parts.slice(2).join("|||");
    const text = `${subj}\n${body}`;
    const m = labelRe.exec(text);
    if (!m) continue;
    const label = m[1] ?? "";
    const prM = prRe.exec(subj);
    const stories: string[] = [];
    let sm: RegExpExecArray | null;
    storyRe.lastIndex = 0;
    while ((sm = storyRe.exec(text)) !== null) {
      const s = sm[1] ?? "";
      if (s && !stories.includes(s)) stories.push(s);
    }
    result[label] = { pr: prM ? (prM[1] ?? null) : null, stories };
  }
  return result;
}

function repairOrphanCyclesFromGit(
  cycles: Cycle[],
  gitMerges: Record<string, GitMerge>,
): void {
  for (const cy of cycles) {
    const m = gitMerges[cy.label];
    if (!m) continue;
    if (cy.outcome === "running" || cy.outcome === "unknown") cy.outcome = "done";
    if (m.pr && !cy.pr) cy.pr = `https://github.com/seanyao/roll/pull/${m.pr}`;
    if (m.pr) {
      cy.pr_num = parseInt(m.pr, 10);
      cy.pr_outcome = "merged";
    }
    if (m.stories.length > 0 && (!cy.built || cy.built.length === 0)) {
      cy.built = m.stories;
      cy.story = m.stories[0] ?? null;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Agent session backfill
// ════════════════════════════════════════════════════════════════════════════
interface SessionUsage {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_reported_usd: number | null;
  duration_ms: number | null;
}

/**
 * FIX-1262 — the `~/.claude/projects/<enc>` dir a cycle's stream-json session
 * lands in, derived from sharedRoot() (ROLL_SHARED_ROOT or ~/.shared/roll) and
 * homedir(). NEVER a hardcoded owner username ('seanyao') nor an absolute
 * /Users/... path — those made the backfill silently miss every machine whose
 * owner ≠ seanyao / whose home ≠ /Users/<owner>. Exported for tests.
 */
export function sessionBackfillProjDir(slug: string, label: string): string {
  const worktreePath = join(sharedRoot(), "worktrees", `${slug}-cycle-${label}`);
  const projName = "-" + worktreePath.replaceAll("/", "-").replaceAll(".", "-").replace(/^-+/, "");
  return join(homedir(), ".claude", "projects", projName);
}

function loadStreamJsonSessionUsage(label: string, slug: string, agent: string): SessionUsage | null {
  if (getAgentSpec(agent)?.usage.sessionBackfill !== "claude-projects") return null;
  const projDir = sessionBackfillProjDir(slug, label);
  if (!existsSync(projDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(projDir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => {
    const sa = statSync(join(projDir, a)).size;
    const sb = statSync(join(projDir, b)).size;
    return sb - sa;
  });
  const path = join(projDir, entries[0] ?? "");
  const sums = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
  };
  let model: string | null = null;
  let cost: number | null = null;
  let durationMs: number | null = null;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e["type"] === "result") {
      cost = (e["total_cost_usd"] as number) || cost;
      durationMs = (e["duration_ms"] as number) || durationMs;
      continue;
    }
    const msg = (e["message"] as Record<string, unknown>) ?? {};
    const usage = (msg["usage"] as Record<string, unknown>) ?? {};
    if (Object.keys(usage).length === 0) continue;
    if (msg["model"] && model === null) model = msg["model"] as string;
    sums.input_tokens += toInt(usage["input_tokens"]);
    sums.output_tokens += toInt(usage["output_tokens"]);
    sums.cache_creation_tokens += toInt(usage["cache_creation_input_tokens"]);
    sums.cache_read_tokens += toInt(usage["cache_read_input_tokens"]);
  }
  if (sums.input_tokens === 0 && sums.output_tokens === 0) return null;
  return { model, ...sums, cost_reported_usd: cost, duration_ms: durationMs };
}

function backfillUsageFromAgentSessions(cycles: Cycle[], slug: string): void {
  for (const cy of cycles) {
    const ue = cy.usage_event;
    if (
      ue !== undefined &&
      (toInt(ue["input_tokens"]) || toInt(ue["output_tokens"]))
    ) {
      cy.input_tokens = toInt(ue["input_tokens"]);
      cy.output_tokens = toInt(ue["output_tokens"]);
      cy.cache_creation_tokens = toInt(ue["cache_creation_tokens"]);
      cy.cache_read_tokens = toInt(ue["cache_read_tokens"]);
      cy.model = (ue["model"] as string | null) ?? null;
      const persisted = ue["cost_list_usd"];
      if (persisted !== undefined && persisted !== null) {
        cy.cost_list = Number(persisted);
        cy.cost_currency = (ue["cost_currency"] as string) || "USD";
        cy.cost_list_legacy = false;
      } else {
        cy.cost_list = computeListCost(ue["model"] as string | null | undefined, {
          input_tokens: toInt(ue["input_tokens"]),
          output_tokens: toInt(ue["output_tokens"]),
          cache_creation_tokens: toInt(ue["cache_creation_tokens"]),
          cache_read_tokens: toInt(ue["cache_read_tokens"]),
        });
        cy.cost_currency = currencyFor(ue["model"] as string | null | undefined) || "USD";
        cy.cost_list_legacy = true;
      }
      const durMs = ue["duration_ms"];
      if (durMs && !cy.duration_s) cy.duration_s = Math.trunc(Number(durMs) / 1000);
      continue;
    }
    if (cy.input_tokens || cy.output_tokens) continue;
    const u = loadStreamJsonSessionUsage(cy.label, slug, cy.agent ?? "");
    if (!u) continue;
    cy.input_tokens = toInt(u.input_tokens);
    cy.output_tokens = toInt(u.output_tokens);
    cy.cache_creation_tokens = toInt(u.cache_creation_tokens);
    cy.cache_read_tokens = toInt(u.cache_read_tokens);
    cy.model = u.model;
    cy.cost_list = computeListCost(u.model, {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_creation_tokens: u.cache_creation_tokens,
      cache_read_tokens: u.cache_read_tokens,
    });
    cy.cost_currency = currencyFor(u.model) || "USD";
    cy.cost_list_legacy = true;
    if (u.duration_ms && !cy.duration_s) cy.duration_s = Math.trunc(u.duration_ms / 1000);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Rollup math (by display-TZ day)
// ════════════════════════════════════════════════════════════════════════════
function bucketByDay(cycles: Cycle[]): Map<string, Cycle[]> {
  const out = new Map<string, Cycle[]>();
  for (const cy of cycles) {
    if (cy.start === null) continue;
    const day = shDayKey(cy.start);
    const arr = out.get(day);
    if (arr) arr.push(cy);
    else out.set(day, [cy]);
  }
  return out;
}

interface DayRollup {
  cycles: number;
  prs: number;
  failed: number;
  duration_s: number;
  cost: number;
  cost_by_cur: Record<string, number>;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

function rollupForDay(dayCycles: Cycle[]): DayRollup {
  const r: DayRollup = {
    cycles: dayCycles.length,
    prs: 0,
    failed: 0,
    duration_s: 0,
    cost: 0.0,
    cost_by_cur: {},
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
  };
  for (const cy of dayCycles) {
    if (cy.outcome === "fail") r.failed += 1;
    if (cy.duration_s) r.duration_s += cy.duration_s;
    if (cy.input_tokens) r.input_tokens += cy.input_tokens;
    if (cy.output_tokens) r.output_tokens += cy.output_tokens;
    if (cy.cache_creation_tokens) r.cache_creation_tokens += cy.cache_creation_tokens;
    if (cy.cache_read_tokens) r.cache_read_tokens += cy.cache_read_tokens;
    if (cy.pr_outcome === "merged") r.prs += 1;
    if (cy.cost_list !== undefined && cy.cost_list !== null) {
      r.cost += cy.cost_list;
      const cur = cy.cost_currency ?? "USD";
      r.cost_by_cur[cur] = (r.cost_by_cur[cur] ?? 0.0) + cy.cost_list;
    } else if (cy.cron) {
      r.cost += cy.cron.cost;
      r.cost_by_cur["USD"] = (r.cost_by_cur["USD"] ?? 0.0) + cy.cron.cost;
    }
  }
  return r;
}

// ════════════════════════════════════════════════════════════════════════════
// review-score / result-eval / agent summary lines
// ════════════════════════════════════════════════════════════════════════════
function reviewScoreSummaryLine(notesDir = ".roll/notes", windowN = 14, featuresDir = ".roll/features"): string {
  // US-META-008: review-score notes live in each card's notes/; the flat
  // .roll/notes carries the diary + pre-migration history. The trend window
  // merges both sources, ordered by the date-prefixed basename.
  const entries: Array<{ name: string; path: string }> = [];
  try {
    for (const n of readdirSync(notesDir)) if (n.endsWith(".md")) entries.push({ name: n, path: join(notesDir, n) });
  } catch {
    /* flat dir absent */
  }
  try {
    for (const epic of readdirSync(featuresDir, { withFileTypes: true })) {
      if (!epic.isDirectory()) continue;
      for (const card of readdirSync(join(featuresDir, epic.name), { withFileTypes: true })) {
        if (!card.isDirectory()) continue;
        const nd = join(featuresDir, epic.name, card.name, "notes");
        try {
          for (const n of readdirSync(nd)) if (n.endsWith(".md")) entries.push({ name: n, path: join(nd, n) });
        } catch {
          /* card without notes */
        }
      }
    }
  } catch {
    /* features dir absent */
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = entries.slice(-windowN);
  if (files.length === 0) return "";
  let total = 0;
  let count = 0;
  let minv = 11;
  let redo = 0;
  for (const f of files) {
    let score: number | null = null;
    let verdict: string | null = null;
    let content: string;
    try {
      content = readFileSync(f.path, "utf8");
    } catch {
      content = "";
    }
    for (const line of content.split("\n")) {
      if (line.startsWith("score: ")) {
        const v = parseInt(line.split(": ").slice(1).join(": ").trim(), 10);
        score = Number.isNaN(v) ? null : v;
      } else if (line.startsWith("verdict: ")) {
        verdict = line.split(": ").slice(1).join(": ").trim();
      }
      if (score !== null && verdict !== null) break;
    }
    if (score === null) continue;
    count += 1;
    total += score;
    if (score < minv) minv = score;
    if (verdict === "regression") redo += 1;
    else if (verdict === "ok" && score < 6) redo += 1;
  }
  if (count < 3) return `review-score: (n/a) — ${count} sample(s), need 3 (last ${windowN})`;
  const mean = total / count;
  return `review-score: mean ${mean.toFixed(1)} / min ${minv} / redo ${redo} (last ${windowN})`;
}

const EVAL_DIM_NAMES = [
  "outcome",
  "correctness",
  "scope_fidelity",
  "quality",
  "efficiency",
  "cleanliness",
];
const UNKNOWN = "unknown";
const TREND_ARROW: Record<string, string> = { up: "↑", down: "↓", flat: "→" };

interface EvalAgg {
  n: number;
  mean: number | null;
  min: number | null;
  trend: string | null;
  dims: Record<string, number | null>;
}

function evalRecords(records: RunRecord[], windowN: number): Array<Record<string, unknown>> {
  const ordered = [...records.map((r) => r ?? {})].sort((a, b) =>
    String(a.ts ?? "").localeCompare(String(b.ts ?? "")),
  );
  const rows: Array<Record<string, unknown>> = [];
  for (const r of ordered) {
    const ev = r.result_eval;
    if (
      ev !== null &&
      typeof ev === "object" &&
      !Array.isArray(ev) &&
      typeof (ev as Record<string, unknown>)["score"] === "number"
    ) {
      rows.push(ev as Record<string, unknown>);
    }
  }
  return windowN > 0 ? rows.slice(-windowN) : rows;
}

function pyRoundInt(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  const eps = 1e-9;
  if (Math.abs(frac - 0.5) < eps) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(x);
}

function aggregateEval(records: RunRecord[], windowN = 14): EvalAgg {
  const rows = evalRecords(records, windowN);
  const n = rows.length;
  const scores = rows.map((ev) => Number(ev["score"]));
  const out: EvalAgg = { n, mean: null, min: null, trend: null, dims: {} };
  if (n === 0) return out;
  out.mean = scores.reduce((a, b) => a + b, 0) / n;
  out.min = Math.min(...scores);
  for (const dim of EVAL_DIM_NAMES) {
    let known = 0;
    let hits = 0;
    for (const ev of rows) {
      const dims = (ev["dims"] as Record<string, unknown>) ?? {};
      const v = dim in dims ? dims[dim] : UNKNOWN;
      if (v === UNKNOWN || v === null) continue;
      known += 1;
      if (Number(v) >= 1.0) hits += 1;
    }
    out.dims[dim] = known ? hits / known : null;
  }
  if (n >= 2) {
    const half = Math.floor(n / 2);
    const older = half > 0 ? scores.slice(0, half) : scores.slice(0, 1);
    const newer = scores.slice(half);
    const delta =
      newer.reduce((a, b) => a + b, 0) / newer.length -
      older.reduce((a, b) => a + b, 0) / older.length;
    if (delta > 0.3) out.trend = "up";
    else if (delta < -0.3) out.trend = "down";
    else out.trend = "flat";
  }
  return out;
}

function resultEvalSummaryLine(records: RunRecord[], windowN = 14): string {
  const agg = aggregateEval(records, windowN);
  const n = agg.n;
  if (n === 0) return "";
  if (n < 3) return `result-eval: (n/a) — ${n} sample(s), need 3 (last ${windowN})`;
  const arrow = TREND_ARROW[agg.trend ?? "flat"] ?? "";
  const short: Record<string, string> = {
    outcome: "out",
    correctness: "ci",
    scope_fidelity: "scope",
    quality: "qual",
    efficiency: "eff",
    cleanliness: "clean",
  };
  const dimBits: string[] = [];
  for (const [dim, rate] of Object.entries(agg.dims)) {
    if (rate === null) continue;
    dimBits.push(`${short[dim] ?? dim} ${pyRoundInt(rate * 100)}%`);
  }
  const dimsStr = dimBits.length > 0 ? " / " + dimBits.join(" ") : "";
  return `result-eval: mean ${(agg.mean as number).toFixed(1)}${arrow} / min ${Math.trunc(
    agg.min as number,
  )}${dimsStr} (last ${windowN})`;
}

function formatEvalView(records: RunRecord[], windowN = 14): string {
  const agg = aggregateEval(records, windowN);
  const n = agg.n;
  const lines: string[] = [];
  lines.push(`Loop result-eval — last ${windowN} cycles`);
  lines.push(`循环结果评分 — 最近 ${windowN} 轮`);
  lines.push("");
  if (n === 0) {
    lines.push("no scored cycles yet (need result_eval in runs.jsonl)");
    lines.push("尚无评分 cycle（runs.jsonl 需含 result_eval）");
    return lines.join("\n");
  }
  if (n < 3) {
    lines.push(`(n/a) — ${n} sample(s), need 3`);
    lines.push(`(n/a) — 样本 ${n} 个，至少需要 3 个`);
    return lines.join("\n");
  }
  const arrow = TREND_ARROW[agg.trend ?? "flat"] ?? "";
  lines.push(`  mean   ${(agg.mean as number).toFixed(1)} / 10   ${arrow}`);
  lines.push(`  min    ${Math.trunc(agg.min as number)} / 10`);
  lines.push(`  n      ${n}`);
  lines.push("");
  lines.push("  dimension hit-rate / 各维度命中率");
  for (const dim of EVAL_DIM_NAMES) {
    const rate = agg.dims[dim];
    if (rate === undefined || rate === null) {
      lines.push(`    ${pyLjust(dim, 16)} n/a`);
    } else {
      lines.push(`    ${pyLjust(dim, 16)} ${pyRoundInt(rate * 100)}%`);
    }
  }
  return lines.join("\n");
}

function pyLjust(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

export function agentSummaryLine(records: RunRecord[], windowCycles = 50, minSample = 5): string {
  if (records.length === 0 || windowCycles <= 0) return "";
  const tail: RunRecord[] = [];
  for (const rec of records.slice(-windowCycles)) {
    const agent = (rec ?? {}).agent ?? "";
    if (!agent) continue;
    tail.push(rec);
  }
  if (tail.length === 0) return "";
  const counts = new Map<string, [number, number]>();
  const order: string[] = [];
  for (const rec of tail) {
    const agent = rec.agent ?? "";
    if (!agent) continue;
    if (!counts.has(agent)) {
      counts.set(agent, [0, 0]);
      order.push(agent);
    }
    const cur = counts.get(agent);
    if (cur) {
      cur[1] += 1;
      // FIX-248: v3 success statuses — done/published/merged (and v2's built).
      const st = rec.status ?? "";
      if (st === "built" || st === "done" || st === "published" || st === "merged" || st === "delivered") cur[0] += 1;
    }
  }
  if (order.length === 0) return "";
  const parts: string[] = [];
  for (const agent of order) {
    const [built, total] = counts.get(agent) ?? [0, 0];
    if (total < minSample) parts.push(`${agent} ${built}/${total} (n/a)`);
    else {
      const pct = total ? pyRoundInt((100 * built) / total) : 0;
      parts.push(`${agent} ${built}/${total} (${pct}%)`);
    }
  }
  return "agents: " + parts.join(" · ");
}

// ════════════════════════════════════════════════════════════════════════════
// Install-state / schedule / tick lines (eyebrow)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Is a plist for ANY retired lane of this project still on disk?
 *
 * US-LOOP-118: this used to grade the lane — "enabled" when `launchctl print`
 * succeeded, "stale" when it did not — and the banner then promised a next run for
 * an "enabled" one. Nothing fires, so the grade is meaningless and the probe is
 * pointless: a plist is leftover debris either way.
 *
 * codex r3: it also checked only the LOOP lane, so a dream-only (or pr-only)
 * leftover went unmentioned here — and the dream line that used to mention it was
 * deleted in the same card, which would have made that plist silent everywhere.
 * `pr` is included because it was retired earlier still (US-DELIV-006).
 */
const RETIRED_LANE_SERVICES = ["loop", "pr", "dream"] as const;

function loopLaneLeftover(): boolean {
  const dir = launchAgentsDir();
  const slug = projectSlug();
  return RETIRED_LANE_SERVICES.some((svc) => existsSync(join(dir, `com.roll.${svc}.${slug}.plist`)));
}

function launchAgentsDir(): string {
  return process.env["_LAUNCHD_DIR"] ?? join(homedir(), "Library", "LaunchAgents");
}

// US-LOOP-118 (codex r2): the daily-plist schedule reader, computeNextFire(), and
// dailyScheduleLine() are deleted. They printed "dream: 03:00 (next fire in 5h
// 12m)" under the banner — the same prediction as the loop lane, one row down.
// A leftover dream plist now surfaces the same way every other retired lane does:
// as debris, via the leftover-lane note and roll doctor.

function tickAgeLine(loopType: string, now: Date): string | null {
  const slug = projectSlug();
  const rtDir = loopRuntimeDir(slug);
  const tickFile =
    rtDir !== null
      ? join(rtDir, `${loopType}-tick.jsonl`)
      : join(sharedRoot(), "loop", `${loopType}-tick-${slug}.jsonl`);
  if (!existsSync(tickFile)) return null;
  let lastLine: string;
  try {
    const lines = readFileSync(tickFile, "utf8").trim().split("\n");
    lastLine = lines[lines.length - 1] ?? "";
    if (lastLine === "") return null;
  } catch {
    return null;
  }
  const m = /"ts":"([^"]+)"/.exec(lastLine);
  if (!m) return null;
  const tsStr = m[1] ?? "";
  const tm = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(tsStr);
  if (!tm) return null;
  const tickEpoch = Date.UTC(
    parseInt(tm[1] ?? "0", 10),
    parseInt(tm[2] ?? "1", 10) - 1,
    parseInt(tm[3] ?? "1", 10),
    parseInt(tm[4] ?? "0", 10),
    parseInt(tm[5] ?? "0", 10),
    parseInt(tm[6] ?? "0", 10),
  );
  const ageSec = Math.trunc((now.getTime() - tickEpoch) / 1000);
  let ageStr: string;
  if (ageSec < 60) ageStr = `${ageSec}s`;
  else if (ageSec < 3600) ageStr = `${Math.floor(ageSec / 60)}m`;
  else ageStr = `${Math.floor(ageSec / 3600)}h`;
  return `${loopType}: tick ${ageStr} ago`;
}

function deliveryGateDiagnosticLine(diagnostic: DeliveryGateDiagnostic): string {
  const ci = diagnostic.ciRunUrl !== undefined ? ` · ${diagnostic.ciRunUrl}` : "";
  return c("red", "⚠ main CI red") + c("dim", `  ${diagnostic.storyId}${ci}`);
}

// US-LOOP-118 (codex r1): the loop-plist schedule reader, the last-fire probe, and
// nextLoopScheduleHint() are deleted. Together they parsed StartInterval /
// StartCalendarInterval out of a plist and projected the next fire time so the
// banner could print "next run 14:30 · in 12m". Nothing fires, so every one of
// those numbers was a promise about a timer that no longer exists.

// ════════════════════════════════════════════════════════════════════════════
// Fixture data (test-only; ROLL_RENDER_FIXTURE=1)
// ════════════════════════════════════════════════════════════════════════════
interface FixtureBundle {
  events: RawEvent[];
  cron: CronEntry[];
  state: Record<string, string>;
  backlog: Record<string, string>;
}

/** Test-only pinned clock: `ROLL_RENDER_NOW=<ISO|epoch-ms>` freezes "now" for
 *  both fixture generation and live-render day bucketing, so frozen snapshots
 *  never drift with wall time or host TZ. Falls back to the wall clock. */
function renderNow(): Date {
  const v = process.env["ROLL_RENDER_NOW"] ?? "";
  if (v !== "") {
    const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return new Date();
}

function fixtureData(): FixtureBundle {
  const now = renderNow(); // UTC instant (pinnable via ROLL_RENDER_NOW)
  const events: RawEvent[] = [];
  const cron: CronEntry[] = [];
  let cycleId = 0;
  for (const d of [2, 1, 0]) {
    const day = new Date(now.getTime() - d * 86400 * 1000);
    const nCycles = [3, 4, 5][2 - d] ?? 0;
    for (let i = 0; i < nCycles; i++) {
      const hour = 0 + i * 5;
      // start = day.replace(hour=hour, minute=48, second=0, microsecond=0) — UTC
      const start = new Date(
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 48, 0, 0),
      );
      const end = new Date(start.getTime() + (540 + i * 120) * 1000);
      const label = isoLabel(start);
      const story = ["FIX-048", "US-112", "FIX-047", "REFACT-9", "FIX-040"][i % 5] ?? "";
      const outcome = d === 1 && i === 2 ? "fail" : "done";
      const startIso = start.toISOString().replace(".000Z", "+00:00").replace("Z", "+00:00");
      const endIso = end.toISOString().replace(".000Z", "+00:00").replace("Z", "+00:00");
      events.push(
        { ts: startIso, stage: "cycle_start", label, detail: "", outcome: "", _ts: start },
        {
          ts: startIso,
          stage: "pick_todo",
          label,
          detail: `${story} picked`,
          outcome: "ok",
          _ts: new Date(start.getTime() + 2000),
        },
        { ts: endIso, stage: "cycle_end", label, detail: "", outcome, _ts: end },
      );
      if (outcome === "done") {
        events.push({
          ts: endIso,
          stage: "pr",
          label,
          detail: `https://github.com/x/y/pull/${50 + cycleId}`,
          outcome: "ok",
          _ts: new Date(end.getTime() - 1000),
        });
      }
      const local = toShanghai(end);
      cron.push({
        hhmm: `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`,
        ss: local.getUTCSeconds(),
        outcome,
        tcr: outcome === "done" ? 1 : 0,
        duration_s: Math.trunc((end.getTime() - start.getTime()) / 1000),
        cost: 3.2 + i * 0.32,
      });
      cycleId += 1;
    }
  }
  const state = { status: "idle", last_run_outcome: "success" };
  const backlog: Record<string, string> = {
    "FIX-048": "Dedupe Todo across cycles",
    "US-112": "Loop run summary report",
    "FIX-047": "Cycle log rotation by day",
    "REFACT-9": "Extract stage runner module",
    "FIX-040": "8/12 tests failed → bail",
  };
  return { events, cron, state, backlog };
}

/** Mirror python start.strftime("%Y%m%d-%H%M%S-30585") in UTC. */
function isoLabel(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}-30585`
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Render
// ════════════════════════════════════════════════════════════════════════════
interface RenderArgs {
  days: number;
  lang: "both" | "en" | "zh";
  runs: Record<string, RunRecord>;
  gitMerges: Record<string, GitMerge>;
  projectSlug: string | null;
  now: Date;
  /** Loop runtime dir for live-cycle detection (null in fixture mode). */
  rtDir: string | null;
}

function render(
  out: string[],
  events: RawEvent[],
  cron: CronEntry[],
  state: Record<string, string>,
  backlog: Record<string, string>,
  args: RenderArgs,
): void {
  const { days, lang, runs, gitMerges, projectSlug, now, rtDir } = args;
  const cycles = aggregate(events, cron);
  const matchedRunIds = Object.keys(runs).length > 0 ? mergeRunsIntoCycles(cycles, runs) : new Set<string>();
  // US-TRUTH-004 AC4: a COMPLETED post-epoch cycle with no runs row has no
  // terminal truth — render it as unknown, never as the success-looking dot.
  // (Running cycles and pre-epoch history keep their lanes.)
  for (const cy of cycles) {
    if (cy.tcr_count !== undefined) continue; // a row matched (applyRunRow ran)
    if (cy.end === null || cy.end === undefined) continue; // still running
    if (cy.end.getTime() / 1000 < TRUTH_SCHEMA_EPOCH_SEC) continue; // grandfathered
    if (cy.outcome === "running" || cy.outcome === "idle") continue;
    cy.outcome = "unknown";
  }
  if (Object.keys(gitMerges).length > 0) repairOrphanCyclesFromGit(cycles, gitMerges);
  backfillUsageFromAgentSessions(cycles, projectSlug ?? "");
  attachToolEvidence(cycles, rtDir);
  const byDay = bucketByDay(cycles);
  const daysKeys = [...byDay.keys()].sort().reverse().slice(0, days);

  const bilingual = (enLine: string, zhLine: string | null): void => {
    if (lang === "both" || lang === "en") out.push(enLine);
    if ((lang === "both" || lang === "zh") && zhLine !== null) out.push(zhLine);
  };

  // Liveness is derived from the v3 heart's own signals (inner.lock + heartbeat
  // + open cycle_start), not the v2 `state.yaml` the TS runner never writes
  // (FIX-203). Computed once here; the title caption and the eyebrow share it.
  const live = detectLiveCycle(args.rtDir, cycles, now);

  // ── Title row ──
  const nCycles = cycles.length;
  // When a cycle is live, split the count so a not-yet-completed cycle is not
  // miscounted as a finished one (FIX-203 req 3: "0 cycles" was misleading —
  // completed cycles are one tally, the running one is listed apart).
  const runningCount = cycles.filter((cy) => cy.outcome === "running").length;
  const caption = live.running
    ? `${nCycles - runningCount} done · ${runningCount} running / ${days * 24}h`
    : `${nCycles} cycles / ${days * 24}h`;
  const titleL = c("fg", "roll loop", { bold: true }) + c("muted", "  ·  ") + c("dim", "health");
  const titleR = c("dim", shYmdHm(now)) + c("muted", " · ") + c("muted", caption);
  out.push(row(titleL, titleR));
  out.push("");

  // ── Status eyebrow ──
  // A live verdict (computed above) trumps a stale state.yaml.
  const statusWord = (state["status"] ?? "idle").toLowerCase();
  // US-LOOP-079g: marker-based resolver (PAUSED > DORMANT > ACTIVE) —
  // truth comes from on-disk PAUSE/DORMANT markers, not state.yaml.
  const markerState = args.projectSlug !== null
    ? (() => {
        const proj = resolveProjectPath(args.projectSlug!);
        return proj !== null
          ? resolveLoopRunState(proj, args.projectSlug!)
          : null;
      })()
    : null;
  let ebL: string;
  let ebZh = "";
  if (live.running) {
    const item = live.story || state["current_item"] || "—";
    const elapsed = fmtDur(live.elapsedSec);
    ebL =
      c("purple", "⏵", { bold: true }) +
      " " +
      c("purple", "RUNNING", { bold: true }) +
      c("muted", "   ") +
      c("dim", "story ") +
      c("blue", item, { bold: true }) +
      c("muted", " · ") +
      c("dim", "elapsed ") +
      c("fg", elapsed);
    ebZh = c("dim", "  正在运行 · 当前 ") + c("blue", item) + c("dim", " · 已运行 ") + c("fg", elapsed);
  } else if (statusWord === "running") {
    const item = state["current_item"] || "—";
    ebL =
      c("purple", "⏵", { bold: true }) +
      " " +
      c("purple", "RUNNING", { bold: true }) +
      c("muted", "   ") +
      c("dim", "story ") +
      c("blue", item, { bold: true });
    ebZh = c("dim", "  正在运行 · 当前 ") + c("blue", item);
  } else if (statusWord === "paused" || markerState === "PAUSED") {
    ebL =
      c("amber", "⏸ PAUSED", { bold: true }) +
      c("muted", "   ") +
      c("dim", "since ") +
      c("fg", state["paused_at"] ?? "—") +
      c("muted", " · ") +
      c("dim", state["paused_reason"] ?? "");
    ebZh = c("dim", "  已暂停 · run: roll loop resume");
  // US-LOOP-115: the DORMANT branch is gone — a session-driven loop cannot
  // idle-spin, so there is no dormant state to render.
  } else {
    // FIX-1268b: status reflects the latest durable lock state. An unlock event
    // clears the wait copy, so stale lock events cannot lie forever.
    let waitReasonEn = "";
    let waitReasonZh = "";
    if (args.projectSlug !== null) {
      const proj = resolveProjectPath(args.projectSlug);
      if (proj !== null) {
        const eventsPath = join(proj, ".roll", "loop", "events.ndjson");
        const en = screenLockWaitReason(eventsPath, "en");
        const zh = screenLockWaitReason(eventsPath, "zh");
        waitReasonEn = en === null ? "" : ` · ${en}`;
        waitReasonZh = zh === null ? "" : ` · ${zh}`;
      }
    }
    // US-LOOP-118 (codex r1): the third branch is gone. It was the "lane loaded"
    // case and printed "enabled · next run 14:30 · in 12m" — a fire time computed
    // from a plist period, for a lane that fires never. Whether a leftover plist is
    // loaded or not changes nothing about how delivery advances, so there are two
    // states left: a session drives, and (separately) there may be debris to remove.
    ebL =
      c("muted", "◆ session-driven", { bold: true }) +
      c("muted", "   ") +
      c("dim", "run ") +
      c("fg", "roll loop go", { bold: true }) +
      c("dim", " in this session") +
      c("dim", waitReasonEn);
    ebZh = c("dim", "  会话驱动 · 在本会话运行 ") + c("fg", "roll loop go") + c("dim", waitReasonZh);
  }

  // US-LOOP-118 (codex r7): debris is independent of run state. Nested inside the
  // idle branch, a real loop/pr/dream plist stayed hidden whenever a cycle was
  // RUNNING or the project was PAUSED — the two states an owner is most likely to
  // be looking at. A leftover lane is a fact about the machine, not about this
  // cycle, so it is appended whatever the banner says.
  if (loopLaneLeftover()) {
    // US-LOOP-113 (codex r5): a plist on disk is a LEFTOVER from an older install,
    // not something to repair — Roll installs no timers. Point at the disarm path
    // (`roll doctor` lists every lane with the command to remove it).
    ebL += c("amber", "   ◌ leftover plist — run ") + c("fg", "roll doctor", { bold: true });
    ebZh += c("amber", " · 旧版安装留下的 plist,运行 ") + c("fg", "roll doctor");
  }

  // 'last' actionable cycle
  let last: Cycle | null =
    cycles.find((cy) => cy.outcome !== "running" && cy.outcome !== "idle") ??
    (cycles.length > 0 ? (cycles[0] ?? null) : null);
  let ebR: string;
  if (last) {
    const story = last.story || "—";
    const title = story !== "—" ? (backlog[story] ?? "") : "";
    const glyphMap: Record<string, [string, string]> = {
      done: ["green", "✓"],
      ok: ["green", "✓"],
      idle: ["muted", "·"],
      fail: ["red", "✗"],
      running: ["purple", "⏵"],
    };
    const [glyphC, glyphCh] = glyphMap[last.outcome ?? ""] ?? ["muted", "·"];
    const glyph = c(glyphC, glyphCh, { bold: true });
    ebR =
      c("dim", "last ") +
      glyph +
      " " +
      c("fg", last.start ? shHHMM(last.start) : "") +
      "  " +
      c("blue", story, { bold: true }) +
      "  " +
      c("fg", trunc(title, 32));
  } else {
    ebR = c("muted", "no cycles yet");
  }
  out.push(row(ebL, ebR));
  if (lang !== "en" && last) out.push(ebZh);

  // US-LOOP-116: no process-fallback backend to surface — the second resident
  // scheduler is deleted, so there is no lease, PID or heartbeat to report.

  // Delivery gate diagnostics — read runs for recent main-CI-red cycles.
  if (args.projectSlug !== null) {
    const dt = deliveryGateDiagnosticsFromRows(args.runs, { nowSec: Math.floor(args.now.getTime() / 1000) });
    for (const diagnostic of dt) out.push("  " + deliveryGateDiagnosticLine(diagnostic));
  }
  out.push("");

  out.push(c("faint", "─".repeat(COLS)));
  out.push("");

  // ── ROLLUP ──
  out.push(sectionHeadLine("ROLLUP", "近 " + String(days) + " 天", "↑ today vs yesterday · 今日 vs 昨日"));
  out.push("");

  const todayKey = shDayKey(now);
  const yestKey = dayKeyOffset(now, -1);
  const d2Key = dayKeyOffset(now, -2);

  const today = rollupForDay(byDay.get(todayKey) ?? []);
  const yest = rollupForDay(byDay.get(yestKey) ?? []);
  const d2 = rollupForDay(byDay.get(d2Key) ?? []);

  const isPartial = today.cycles < yest.cycles;

  const hdrEn =
    "  " +
    c("muted", pad("", 14)) +
    c("fg", pad("Today", 22), { bold: true }) +
    c("dim", pad("Yesterday", 10)) +
    c("muted", pad("−2d", 8));
  const hdrZh =
    "  " +
    c("muted", pad("", 14)) +
    c("dim", pad("今日", 22)) +
    c("muted", pad("昨日", 10)) +
    c("muted", pad("前天", 8));
  bilingual(hdrEn, hdrZh);

  out.push(metric("cycles", today.cycles, yest.cycles, d2.cycles, "up_good", { partial: isPartial }));
  out.push(metric("merged PRs", today.prs, yest.prs, d2.prs, "up_good", { partial: isPartial }));
  out.push(
    metric("failed", today.failed, yest.failed, d2.failed, "up_bad", {
      yestColor: yest.failed > 0 ? "amber" : "dim",
      yestSuffix: yest.failed > 0 ? "⚠" : "",
    }),
  );
  out.push(metricDur("duration", today.duration_s, yest.duration_s, d2.duration_s, { partial: isPartial }));
  out.push(
    metricTokens("input tokens", today.input_tokens, yest.input_tokens, d2.input_tokens, {
      partial: isPartial,
    }),
  );
  out.push(
    metricTokens(
      "cache writes",
      today.cache_creation_tokens,
      yest.cache_creation_tokens,
      d2.cache_creation_tokens,
      { partial: isPartial },
    ),
  );
  out.push(
    metricTokens(
      "cache reads",
      today.cache_read_tokens,
      yest.cache_read_tokens,
      d2.cache_read_tokens,
      { partial: isPartial },
    ),
  );
  out.push(
    metricTokens("output tokens", today.output_tokens, yest.output_tokens, d2.output_tokens, {
      partial: isPartial,
    }),
  );

  const costDays = [today, yest, d2];
  const currencies: string[] = [];
  for (const cur of ["USD", "CNY"]) {
    if (costDays.some((r) => r.cost_by_cur[cur])) currencies.push(cur);
  }
  for (const r of costDays) {
    for (const cur of Object.keys(r.cost_by_cur)) {
      if (!currencies.includes(cur) && r.cost_by_cur[cur]) currencies.push(cur);
    }
  }
  if (currencies.length === 0) currencies.push("USD");
  for (const cur of currencies) {
    const sym = cur === "CNY" ? "¥" : "$";
    const label = currencies.length === 1 ? "cost" : "cost " + sym;
    out.push(
      metricDollar(
        label,
        today.cost_by_cur[cur] ?? 0.0,
        yest.cost_by_cur[cur] ?? 0.0,
        d2.cost_by_cur[cur] ?? 0.0,
        { partial: isPartial, symbol: sym },
      ),
    );
  }

  // agent / review-score / result-eval lines
  let agentLine = "";
  try {
    const runsRecords = Object.values(runs);
    runsRecords.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
    // FIX-248 AC2: same window, same denominator — only the runs rows whose
    // cycle the panel is actually rendering (was: tail-50 of ALL history,
    // contradicting the ROLLUP/RECENT sections on the same screen).
    const windowRecords = runsRecords.filter((r0) => matchedRunIds.has(String(r0.run_id ?? "")));
    agentLine = agentSummaryLine(windowRecords, Math.max(windowRecords.length, 1));
  } catch {
    agentLine = "";
  }
  if (agentLine) out.push("  " + c("dim", agentLine));

  let skillLine = "";
  try {
    skillLine = reviewScoreSummaryLine(process.env["ROLL_NOTES_DIR"], 14, process.env["ROLL_FEATURES_DIR"]);

  } catch {
    skillLine = "";
  }
  if (skillLine) out.push("  " + c("dim", skillLine));

  let evalLine = "";
  try {
    evalLine = resultEvalSummaryLine(Object.values(runs));
  } catch {
    evalLine = "";
  }
  if (evalLine) out.push("  " + c("dim", evalLine));

  // US-DELIV-012: the delivery observability line — external-merge rate /
  // awaiting_merge dwell / fan-out waste, from the SAME reconciled ledger +
  // pure `deliveryMetrics` `roll cycles` renders. Live mode only (rtDir set): in
  // fixture mode there is no real .roll to reconcile, and it must never run the
  // git patch-id reconcile against the test's cwd. Read-only, resilient.
  if (rtDir !== null) {
    let deliveryLine = "";
    try {
      const root = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
      const m = deliveryMetrics(reconciledLedger(root), now.getTime());
      deliveryLine = deliveryMetricsLine(m, lang === "zh" ? "zh" : "en");
    } catch {
      deliveryLine = "";
    }
    if (deliveryLine) out.push("  " + c("dim", deliveryLine));
  }

  out.push("");
  out.push(c("faint", "─".repeat(COLS)));
  out.push("");

  // ── RECENT ──
  out.push(
    sectionHeadLine(
      "RECENT",
      `最近 ${cycles.length} 个 cycle`,
      "t · time   Δ · duration   tok · tokens   $/¥ · cost   id · backlog",
    ),
  );
  out.push("");

  if (cycles.length === 0) {
    out.push("  " + c("dim", "no cycles yet — first run fires on next cron tick"));
    out.push("  " + c("dim", "尚无 cycle · 等待下一次 cron 触发"));
    return;
  }

  const yestForBand = dayKeyOffset(now, -1);
  for (const dayKey of daysKeys) {
    const dayCycles = byDay.get(dayKey) ?? [];
    if (dayCycles.length === 0) continue;
    out.push(
      dayBand(
        dayKey,
        dayCycles.length,
        dayCycles.filter((c0) => c0.outcome === "fail").length,
        todayKey,
        yestForBand,
        { inProgress: dayKey === todayKey && isPartial },
      ),
    );
    for (let j = dayCycles.length - 1; j >= 0; j--) {
      const cy = dayCycles[j];
      if (cy === undefined) continue;
      out.push(...renderCycle(cy, now));
    }
    out.push("");
  }

  out.push(c("faint", "─".repeat(COLS)));
  out.push("");
  // US-PORT-022: `loop show` / `loop --watch` never existed (dead v2 hints).
  // Drill repoints to the real per-cycle reader; live watch is a tmux attach.
  out.push(
    "  " +
      c("dim", "drill   ") +
      c("blue", "roll loop runs --detail <cycle>") +
      c("muted", "       ") +
      c("dim", "watch   ") +
      c("blue", "tmux attach -t roll-loop-<slug>") +
      c("muted", "       ") +
      c("dim", "more   ") +
      c("blue", "roll loop status --days 7"),
  );
}

/** Build a CycleView for cycleRow, computing running wall-clock duration. */
function renderCycle(cy: Cycle, now: Date): string[] {
  let durS = cy.duration_s || cy.cron?.duration_s || 0;
  if (cy.outcome === "running" && !durS && cy.start) {
    durS = Math.trunc((now.getTime() - cy.start.getTime()) / 1000);
  }
  const view: CycleView = {
    outcome: cy.outcome ?? "done",
    pr_outcome: cy.pr_outcome ?? null,
    start_hhmm: cy.start ? shHHMM(cy.start) : "",
    duration_s: durS,
    input_tokens: cy.input_tokens ?? 0,
    output_tokens: cy.output_tokens ?? 0,
    cache_creation_tokens: cy.cache_creation_tokens ?? 0,
    cache_read_tokens: cy.cache_read_tokens ?? 0,
    cost_currency: cy.cost_currency ?? "USD",
    cost_list: cy.cost_list ?? null,
    cron_cost: cy.cron ? cy.cron.cost : null,
    story: cy.story ?? null,
    built: cy.built,
    model: cy.model ?? null,
    agent: cy.agent ?? null,
    pr_num: cy.pr_num ?? null,
    cost_list_legacy: cy.cost_list_legacy ?? false,
    tool_summary: cy.tool_summary ?? "",
    fail_detail: cy.fail_detail ?? null,
    label: cy.label,
  };
  return cycleRow(view);
}

/** Mirror roll_render.section_head as a returned string (not printed). */
function sectionHeadLine(en: string, zh: string, hint: string): string {
  const left = "  " + c("pink", en, { bold: true }) + c("muted", "  ·  ") + c("dim", zh);
  return row(left, c("muted", hint));
}

// ════════════════════════════════════════════════════════════════════════════
// Entry
// ════════════════════════════════════════════════════════════════════════════
interface ParsedArgs {
  days: number;
  noColor: boolean;
  en: boolean;
  zh: boolean;
  evalN: number | null;
  unknown: string[];
}

/** Mirror argparse for the dashboard's flags. */
function parseArgs(argv: string[]): ParsedArgs {
  const r: ParsedArgs = {
    days: 3,
    noColor: false,
    en: false,
    zh: false,
    evalN: null,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-color") r.noColor = true;
    else if (a === "--en") r.en = true;
    else if (a === "--zh") r.zh = true;
    else if (a === "--days") {
      const v = argv[++i];
      r.days = parseInt(v ?? "", 10);
      if (Number.isNaN(r.days)) r.unknown.push(a);
    } else if (a !== undefined && a.startsWith("--days=")) {
      r.days = parseInt(a.slice("--days=".length), 10);
    } else if (a === "--eval") {
      // nargs="?" const=14 — consume the next token only if it's an int.
      const next = argv[i + 1];
      if (next !== undefined && /^-?\d+$/.test(next)) {
        r.evalN = parseInt(next, 10);
        i++;
      } else {
        r.evalN = 14;
      }
    } else if (a !== undefined && a.startsWith("--eval=")) {
      r.evalN = parseInt(a.slice("--eval=".length), 10);
    } else if (a !== undefined) {
      r.unknown.push(a);
    }
  }
  return r;
}

// ════════════════════════════════════════════════════════════════════════════
// `roll loop story <ID>` — per-story cycle rollup (US-PORT-007, port of
// lib/roll-loop-story.py). Reuses the SAME cycle pipeline as the dashboard:
// load events/cron/runs/git-merges → aggregate → merge runs → repair orphans →
// backfill usage, then fold the cycles belonging to one story id.
// ════════════════════════════════════════════════════════════════════════════

/** Build the cycle history exactly as the dashboard does (py collect_cycles). */
function collectCycles(slug: string, days: number): Cycle[] {
  const events = loadEvents(slug, days);
  const cron = loadCronLog(slug);
  const runs = loadRuns(slug);
  const gitMerges = loadPrMergesFromGit(days);
  const cycles = aggregate(events, cron);
  if (Object.keys(runs).length > 0) mergeRunsIntoCycles(cycles, runs);
  if (Object.keys(gitMerges).length > 0) repairOrphanCyclesFromGit(cycles, gitMerges);
  backfillUsageFromAgentSessions(cycles, slug);
  attachToolEvidence(cycles, loopRuntimeDir(slug));
  return cycles;
}

interface StoryPr {
  num: number;
  outcome: string;
}

/** The per-story rollup (py rollup_for_story). */
export interface StoryRollup {
  story_id: string;
  cycles: Cycle[];
  count: number;
  ok_count: number;
  fail_count: number;
  running_count: number;
  span_start: Date | null;
  span_end: Date | null;
  duration_s: number;
  /** FIX-361: total cost (all currencies, raw sum — for backward compat). */
  cost: number;
  /** FIX-361: cost separated by native currency so display never blindly sums ¥+$. */
  cost_by_cur: Record<string, number>;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  prs: StoryPr[];
  model: string | null;
}

/** Aggregate the cycles belonging to one story id (case-insensitive). Faithful
 *  port of py rollup_for_story (lib/roll-loop-status.py:761). */
export function rollupForStory(cycles: Cycle[], storyId: string): StoryRollup {
  const sidLower = (storyId || "").toLowerCase();
  const matched = cycles.filter((cy) => (cy.story ?? "").toLowerCase() === sidLower);
  const r: StoryRollup = {
    story_id: storyId,
    cycles: matched,
    count: matched.length,
    ok_count: 0,
    fail_count: 0,
    running_count: 0,
    span_start: null,
    span_end: null,
    duration_s: 0,
    cost: 0,
    cost_by_cur: {},
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    prs: [],
    model: null,
  };
  for (const cy of matched) {
    const outcome = cy.outcome ?? "";
    if (outcome === "fail") r.fail_count += 1;
    else if (outcome === "running") r.running_count += 1;
    else r.ok_count += 1;
    if (cy.start !== null) {
      if (r.span_start === null || cy.start < r.span_start) r.span_start = cy.start;
    }
    if (cy.end !== null && cy.end !== undefined) {
      if (r.span_end === null || cy.end > r.span_end) r.span_end = cy.end;
    }
    if (cy.duration_s) r.duration_s += cy.duration_s;
    r.input_tokens += cy.input_tokens ?? 0;
    r.output_tokens += cy.output_tokens ?? 0;
    r.cache_creation_tokens += cy.cache_creation_tokens ?? 0;
    r.cache_read_tokens += cy.cache_read_tokens ?? 0;
    if (cy.cost_list !== null && cy.cost_list !== undefined) {
      r.cost += cy.cost_list;
      // FIX-361: separate by native currency so display never blindly sums ¥+$.
      const cur = cy.cost_currency ?? "USD";
      r.cost_by_cur[cur] = (r.cost_by_cur[cur] ?? 0) + cy.cost_list;
    } else if (cy.cron) {
      r.cost += cy.cron.cost;
      // cron log entries are historical and always USD.
      r.cost_by_cur["USD"] = (r.cost_by_cur["USD"] ?? 0) + cy.cron.cost;
    }
    if (cy.pr_num) r.prs.push({ num: cy.pr_num, outcome: cy.pr_outcome ?? "open" });
    if (cy.model && !r.model) r.model = cy.model;
  }
  return r;
}

/** py _fmt_dt — "YYYY-MM-DD HH:MM" in the fixed display TZ. roll-loop-status.py
 *  pins the process TZ to Asia/Shanghai (UTC+8) before .astimezone(), so the
 *  story panel must convert to +8 too (NOT the host's local TZ — that only
 *  agreed by accident on a +8 dev box; CI runs UTC). Reuse shYmdHm. */
function storyFmtDt(d: Date): string {
  return shYmdHm(d);
}

/** py _fmt_dur. */
function storyFmtDur(s: number): string {
  if (!s) return "—";
  const h = Math.trunc(s / 3600);
  const m = Math.trunc((s % 3600) / 60);
  return h ? `${h}h ${m < 10 ? `0${m}` : m}m` : `${m}m`;
}

/** py _fmt_tokens. */
function storyFmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/** py _fmt_pr. */
function storyFmtPr(p: StoryPr): string {
  const g = p.outcome === "merged" ? "✓" : p.outcome === "closed" ? "✗" : "⏵";
  return `#${p.num} ${g}`;
}

function storyOutcomeGlyph(o: string): string {
  if (o === "fail") return "✗";
  if (o === "running") return "⏵";
  if (o === "idle") return "·";
  if (o === "unknown") return "?"; // US-TRUTH-004 AC4
  return "✓";
}

/** Render the per-story panel (py render_panel). */
export function renderStoryPanel(r: StoryRollup, description = ""): string {
  let head = `── ${r.story_id}`;
  if (description) head += ` · ${description}`;
  head += " " + "─".repeat(Math.max(0, 78 - head.length));

  let span = "—";
  if (r.span_start && r.span_end) span = `${storyFmtDt(r.span_start)}  →  ${storyFmtDt(r.span_end)}`;
  else if (r.span_start) span = `${storyFmtDt(r.span_start)}  →  (running)`;

  const counts = `  cycles    ${r.count}  (✓ ${r.ok_count}  ✗ ${r.fail_count}  ⏵ ${r.running_count})`;
  const lineSpan = `  span      ${span}`;
  const lineDur =
    `  duration  ${storyFmtDur(r.duration_s)}` +
    `   tokens  in ${storyFmtTokens(r.input_tokens)}` +
    `  out ${storyFmtTokens(r.output_tokens)}` +
    `  cache w ${storyFmtTokens(r.cache_creation_tokens)}` +
    `  r ${storyFmtTokens(r.cache_read_tokens)}`;
  const model = r.model || "—";
  // FIX-361: per-currency cost — show each currency separately so ¥ and $ are never blindly summed.
  const costParts = Object.entries(r.cost_by_cur).map(([cur, val]) => {
    const sym = cur === "CNY" ? "\u00A5" : "$";
    return `${sym}${val.toFixed(2)}`;
  });
  const costStr = costParts.length > 0 ? costParts.join(" + ") : `$${r.cost.toFixed(2)}`;
  const lineCost = `  cost      ${costStr}    model  ${model}`;
  const prs = r.prs;
  const linePrs = "  PRs       " + (prs.length ? prs.slice(0, 8).map(storyFmtPr).join(" ") : "—");

  // Recent 3 cycles, oldest→newest of the matched set.
  const recent = [...r.cycles]
    .sort((a, b) => (a.start?.getTime() ?? -Infinity) - (b.start?.getTime() ?? -Infinity))
    .slice(-3);
  const recentLines: string[] = [];
  recent.forEach((cy, i) => {
    const label = cy.label || "—";
    const glyph = storyOutcomeGlyph(cy.outcome ?? "");
    const cost = cy.cost_list;
    // FIX-361: use the cycle's native currency symbol.
    const curSym = (cy.cost_currency ?? "USD") === "CNY" ? "\u00A5" : "$";
    const costS = cost !== null && cost !== undefined ? `${curSym}${cost.toFixed(2)}` : "—";
    const prefix = i === 0 ? "  recent   " : "           ";
    recentLines.push(`${prefix} ${label}  ${glyph}  ${costS}`);
  });
  if (recentLines.length === 0) recentLines.push("  recent    —");

  return [head, counts, lineSpan, lineDur, lineCost, linePrs, ...recentLines].join("\n");
}

/** Render the per-story rollup as JSON (py to_json — UTC ISO datetimes). */
export function storyJson(r: StoryRollup): string {
  const isoUtc = (d: Date | null): string | null => (d === null ? null : d.toISOString().replace(/\.\d{3}Z$/, "+00:00"));
  const payload: Record<string, unknown> = {
    story_id: r.story_id,
    count: r.count,
    ok_count: r.ok_count,
    fail_count: r.fail_count,
    running_count: r.running_count,
    span_start: isoUtc(r.span_start),
    span_end: isoUtc(r.span_end),
    duration_s: r.duration_s,
    cost: r.cost,
    cost_by_cur: r.cost_by_cur,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_creation_tokens: r.cache_creation_tokens,
    cache_read_tokens: r.cache_read_tokens,
    prs: r.prs,
    model: r.model,
    cycles: r.cycles.map((cy) => ({
      label: cy.label,
      start: isoUtc(cy.start),
      end: isoUtc(cy.end ?? null),
      outcome: cy.outcome,
      duration_s: cy.duration_s ?? null,
      input_tokens: cy.input_tokens ?? null,
      output_tokens: cy.output_tokens ?? null,
      cache_creation_tokens: cy.cache_creation_tokens ?? null,
      cache_read_tokens: cy.cache_read_tokens ?? null,
      cost_list: cy.cost_list ?? null,
      model: cy.model ?? null,
      pr_num: cy.pr_num ?? null,
      pr_outcome: cy.pr_outcome ?? null,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

const STORY_HELP = `Usage: roll loop story <STORY-ID> [--days N] [--json]

  Show a per-story rollup across cycles: count, span, duration, tokens,
  cost, model, PR landings, and the last 3 cycles. Story ID is case-
  insensitive (us-loop-004 == US-LOOP-004).

Examples:
  roll loop story US-LOOP-004
  roll loop story us-loop-004 --days 90
  roll loop story US-LOOP-004 --json | jq .cost
`;

/** `roll loop story <ID>` adapter. Exit 0 = ≥1 cycle, 2 = none, 1 = usage. */
export function loopStoryCommand(argv: string[]): number {
  const first = argv[0];
  if (first === undefined || first === "-h" || first === "--help") {
    process.stdout.write(STORY_HELP);
    return 1;
  }
  let storyId = "";
  let days = 30;
  let wantJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") wantJson = true;
    else if (a === "--days") {
      const v = argv[++i];
      const n = parseInt(v ?? "", 10);
      if (Number.isFinite(n)) days = n;
    } else if (a !== undefined && a.startsWith("--days=")) {
      const n = parseInt(a.slice("--days=".length), 10);
      if (Number.isFinite(n)) days = n;
    } else if (a !== undefined && storyId === "") {
      storyId = a;
    }
  }

  const slug = projectSlug();
  const cycles = collectCycles(slug, days);
  const r = rollupForStory(cycles, storyId);

  if (wantJson) {
    process.stdout.write(storyJson(r) + "\n");
    return r.count > 0 ? 0 : 2;
  }
  if (r.count === 0) {
    process.stderr.write(
      `roll loop story: no cycles found for ${storyId} in the last ${days} days\n` +
        `未找到 ${storyId} 在最近 ${days} 天内的循环\n`,
    );
    return 2;
  }
  const backlog = loadBacklog();
  const description = backlog[storyId.toUpperCase()] ?? "";
  process.stdout.write(renderStoryPanel(r, description) + "\n");
  return 0;
}

const EVAL_HELP = `Usage: roll loop eval [N]

  Result-eval trend over the last N scored cycles (default 14).
  Reads each runs.jsonl record's result_eval block and reports the mean and
  minimum cycle score (1..10), each rubric dimension's hit-rate, and a trend
  arrow. Cycles without a result_eval (older schema) are skipped. With fewer
  than 3 scored cycles, prints an "(n/a) need 3" notice.

  近 N 轮 cycle 的结果评分趋势（默认 14）。
  读取每条 runs.jsonl 的 result_eval，输出均分 / 最低分 / 各维度命中率 / 趋势箭头。
  无 result_eval 的旧记录跳过；样本不足 3 个时提示 (n/a) need 3。

Examples:
  roll loop eval
  roll loop eval 30
`;

/** `roll loop eval [N]` adapter — validates N then delegates to the --eval view
 *  (py _loop_eval → roll-loop-status.py --eval). */
export function loopEvalCommand(argv: string[]): number {
  const first = argv[0];
  if (first === "-h" || first === "--help") {
    process.stdout.write(EVAL_HELP);
    return 0;
  }
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  if (first !== undefined && !/^[0-9]+$/.test(first)) {
    const RED = noColor ? "" : "\x1b[0;31m";
    const NC = noColor ? "" : "\x1b[0m";
    process.stderr.write(`${RED}[roll]${NC} roll loop eval: N must be a positive integer (got '${first}')\n`);
    return 1;
  }
  return dashboardCommand(first !== undefined ? ["--eval", first] : ["--eval"]);
}

export function dashboardCommand(argv: string[]): number {
  const args = parseArgs(argv);

  if (args.unknown.length > 0) {
    // argparse errors on unrecognized args with exit code 2.
    process.stderr.write(
      `usage: roll-loop-status.py [-h] [--days DAYS] [--no-color] [--en] [--zh]\n` +
        `                           [--eval [N]]\n` +
        `roll-loop-status.py: error: unrecognized arguments: ${args.unknown.join(" ")}\n`,
    );
    return 2;
  }

  const useFixture = (process.env["ROLL_RENDER_FIXTURE"] ?? "") !== "";

  // --eval view → print and exit (no color dependency).
  if (args.evalN !== null) {
    const windowN = args.evalN > 0 ? args.evalN : 14;
    let records: RunRecord[];
    if (useFixture) records = [];
    else {
      const slug = projectSlug();
      records = Object.values(loadRuns(slug));
    }
    process.stdout.write(formatEvalView(records, windowN) + "\n");
    return 0;
  }

  renderState.useColor =
    !args.noColor &&
    (process.env["NO_COLOR"] ?? "") === "" &&
    (process.stdout.isTTY === true || (process.env["FORCE_COLOR"] ?? "") !== "");

  const lang: "both" | "en" | "zh" = args.en ? "en" : args.zh ? "zh" : "both";
  const now = renderNow();

  let events: RawEvent[];
  let cron: CronEntry[];
  let state: Record<string, string>;
  let backlog: Record<string, string>;
  let runs: Record<string, RunRecord>;
  let gitMerges: Record<string, GitMerge>;
  let slug: string | null;

  if (useFixture) {
    const fx = fixtureData();
    events = fx.events;
    cron = fx.cron;
    state = fx.state;
    backlog = fx.backlog;
    runs = {};
    gitMerges = {};
    slug = null;
  } else {
    slug = projectSlug();
    events = loadEvents(slug, args.days);
    cron = loadCronLog(slug);
    state = loadState(slug);
    backlog = loadBacklog();
    runs = loadRuns(slug);
    gitMerges = loadPrMergesFromGit(args.days);
  }

  const out: string[] = [];
  render(out, events, cron, state, backlog, {
    days: args.days,
    lang,
    runs,
    gitMerges,
    projectSlug: slug,
    now,
    rtDir: useFixture || slug === null ? null : loopRuntimeDir(slug),
  });
  if (!useFixture) {
    const corpusRoot = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
    const sig = renderExemptionSignal(exemptionStats(corpusRoot));
    if (sig.length > 0) out.push("", ...sig);
  }
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}
