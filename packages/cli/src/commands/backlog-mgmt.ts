/**
 * @responsibility Runs the `roll backlog` write and maintenance subcommands (block, defer, unblock, promote, lint).
 */
/**
 * `roll backlog` WRITE/maintenance subcommands — US-PORT-019. Ports the bash
 * `cmd_backlog` status-management arms off the frozen `bin/roll`:
 *   - block / defer / unblock / promote : rewrite the Status cell (BacklogStore).
 *   - lint [--gate]                     : flag rows whose description carries
 *                                         technical detail (the AGENTS.md §4 rule).
 * (`sync` and `unstick` live in their own modules — they are bigger ports.)
 *
 * Output mirrors the bash oracle: plain `echo` lines (no [roll] prefix), the
 * resolved-locale msg catalog, and the same exit codes.
 */
import {
  BacklogStore,
  splitBacklogRow,
  type UnstickEvent,
  applyStuckReverts,
  lintIdeaDescription,
  reconcileStuckBacklog,
} from "@roll/core";
import { resolveLang, STATUS_MARKER, t, v2Catalog, type Lang } from "@roll/spec";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claimStoryLease, type LeaseSource } from "@roll/core";
import { projectSlug, sharedRoot } from "./dashboard.js";

const BACKLOG_PATH = ".roll/backlog.md";
const LEASE_PATH = ".roll/loop/leases";

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
function out(line: string): void {
  process.stdout.write(line + "\n");
}
function errLine(line: string): void {
  process.stderr.write(line + "\n");
}

/**
 * New status string for a set-status subcommand (mirrors the bash case).
 * `block`/`defer` keep their distinct surface markers (`🔒 Blocked` / `⏸ Deferred`,
 * both legacy hold aliases that `classifyStatus` folds to `hold`) so the renderer
 * can still tell a blocked row from a deferred one; unblock/promote return the
 * canonical Todo marker from the single source (FIX-300).
 */
export function statusFor(subcmd: string, reason: string): string | null {
  switch (subcmd) {
    case "block":
      return `🔒 Blocked${reason ? ` [${reason}]` : ""}`;
    case "defer":
      return `⏸ Deferred${reason ? ` [${reason}]` : ""}`;
    case "unblock":
    case "promote":
      return STATUS_MARKER.todo;
    default:
      return null;
  }
}

/** `roll backlog <block|defer|unblock|promote> <pattern> [reason]`. */
export function backlogSetStatusCommand(
  subcmd: string,
  args: string[],
  store: BacklogStore = new BacklogStore(),
): number {
  const pattern = args[0] ?? "";
  const reason = args[1] ?? "";
  if (pattern === "") {
    errLine(`[roll] ${msg("backlog.usage_roll_backlog_pattern_reason", subcmd)}`);
    return 1;
  }
  const newStatus = statusFor(subcmd, reason);
  if (newStatus === null) return 1; // unreachable via the dispatcher
  if (!existsSync(BACKLOG_PATH)) {
    errLine(`[roll] ${msg("backlog.roll_backlog_md_not_found_run")}`);
    return 1;
  }
  const snap = store.readBacklog(BACKLOG_PATH);
  const { count } = store.mark(BACKLOG_PATH, snap.hash, pattern, newStatus);
  if (count === 0) out(msg("backlog.no_items_matched", pattern));
  else {
    out(msg("backlog.updated_item_s", count, newStatus));
    // US-V4-001: a status flip is a backlog-only change. It no longer refreshes
    // the global dossier/epic pages as a side effect — `roll index` renders them
    // on demand. Delivery truth comes from main + structured truth, not the board.
  }
  return 0;
}

export interface ClaimDeps {
  nowMs: () => number;
}

function realClaimDeps(): ClaimDeps {
  return { nowMs: () => Date.now() };
}

/** `roll backlog claim <card> [--source human|supervisor]` — manual soft lease writer. */
export function backlogClaimCommand(args: string[], deps: ClaimDeps = realClaimDeps(), store: BacklogStore = new BacklogStore()): number {
  const pattern = args[0] ?? "";
  let source: LeaseSource = "human";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--source") {
      const raw = args[i + 1] ?? "";
      if (raw === "human" || raw === "supervisor") source = raw;
      else {
        errLine("usage: roll backlog claim <card> [--source human|supervisor]");
        return 1;
      }
      i++;
    }
  }
  if (pattern === "") {
    errLine("usage: roll backlog claim <card> [--source human|supervisor]");
    return 1;
  }
  if (!existsSync(BACKLOG_PATH)) {
    errLine(`[roll] ${msg("backlog.roll_backlog_md_not_found_run")}`);
    return 1;
  }
  const snap = store.readBacklog(BACKLOG_PATH);
  const { count } = store.mark(BACKLOG_PATH, snap.hash, pattern, STATUS_MARKER.in_progress);
  if (count === 0) {
    out(msg("backlog.no_items_matched", pattern));
    return 0;
  }
  mkdirSync(dirname(LEASE_PATH), { recursive: true });
  const result = claimStoryLease(LEASE_PATH, pattern, { source, claimedAt: deps.nowMs() });
  if (result.status !== "claimed") {
    errLine(`claim failed: story ${pattern} already owned by ${result.status === "exists" ? result.existingSource : "unknown"}`);
    return 1;
  }
  out(`claimed ${pattern} (${source} lease)`);
  return 0;
}

// ─── lint ───────────────────────────────────────────────────────────────────

const ID_PREFIX_RE = /^\[[A-Z]+-[0-9]+\]\([^)]*\)\s*|^[A-Z]+-[0-9]+\s*/;

/** Category tags for a description, with the bash `length>N` detail restored. */
export function lintRowIssues(desc: string): string[] {
  const cats = lintIdeaDescription(desc);
  if (cats.length === 0) return [];
  const bodyLen = desc.replace(ID_PREFIX_RE, "").length;
  return cats.map((c) => (c === "length" ? `length>${bodyLen}` : c));
}

/** A lint finding: source line number, story id, joined issues, raw description. */
export interface LintFinding {
  lineno: number;
  sid: string;
  issues: string;
  desc: string;
}

/** Pure: scan backlog content for rows whose description violates §4. */
export function lintBacklogContent(content: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (!line.startsWith("|")) continue;
    if (/Story.*Description.*Status/.test(line) || line.includes("---")) continue;
    const fields = splitBacklogRow(line);
    const desc = (fields[2] ?? "").trim();
    if (desc === "") continue;
    const issues = lintRowIssues(desc);
    if (issues.length === 0) continue;
    const sidCell = (fields[1] ?? "").trim();
    const sidMatch = /([A-Z]+-[0-9]+)/.exec(sidCell);
    findings.push({
      lineno: i + 1,
      sid: sidMatch?.[1] ?? "",
      issues: issues.join(", "),
      desc,
    });
  }
  return findings;
}

// ─── unstick (FIX-112) ────────────────────────────────────────────────────────

/** Injectable seams so tests drive slug / shared root / clock deterministically. */
export interface UnstickDeps {
  slug: () => string;
  sharedRoot: () => string;
  nowMs: () => number;
}
function realUnstickDeps(): UnstickDeps {
  return { slug: () => projectSlug(), sharedRoot: () => sharedRoot(), nowMs: () => Date.now() };
}

function fmtAge(h: number): string {
  return h.toFixed(1);
}

/**
 * `roll backlog unstick [--dry-run] [--ttl-hours N] [--backlog PATH]` — revert
 * 🔨 In Progress stories whose latest cycle failed ≥ TTL hours ago to 📋 Todo
 * (FIX-112). Reads the per-project events ndjson, plans via the pure core, then
 * (unless --dry-run) rewrites the backlog and appends an ALERT note. Always 0.
 */
export function backlogUnstickCommand(args: string[], deps: UnstickDeps = realUnstickDeps()): number {
  let dryRun = false;
  let ttlHours = 4.0;
  let backlog = BACKLOG_PATH;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--ttl-hours") {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n)) ttlHours = n;
      i++;
    } else if (args[i] === "--backlog") {
      backlog = args[i + 1] ?? backlog;
      i++;
    }
  }
  if (!existsSync(backlog)) {
    errLine(`backlog not found: ${backlog}`);
    return 0;
  }

  const slug = deps.slug();
  const loopDir = join(deps.sharedRoot(), "loop");
  const eventsPath = join(loopDir, `events-${slug}.ndjson`);
  const events = existsSync(eventsPath) ? parseUnstickEvents(readFileSync(eventsPath, "utf8")) : [];
  const content = readFileSync(backlog, "utf8");
  const nowMs = deps.nowMs();
  const candidates = reconcileStuckBacklog(content, events, nowMs, ttlHours);
  if (candidates.length === 0) return 0;

  if (dryRun) {
    for (const c of candidates) {
      out(`would-revert ${c.storyId} (cycle ended ${c.outcome} ${fmtAge(c.ageHours)}h ago)`);
    }
    return 0;
  }

  writeFileSync(backlog, applyStuckReverts(content, candidates));

  const alertPath = join(loopDir, `ALERT-${slug}.md`);
  mkdirSync(dirname(alertPath), { recursive: true });
  const ts = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  let alertBlock = "";
  for (const c of candidates) {
    alertBlock += `[${ts}] unstick: reverted ${c.storyId} (cycle ended ${c.outcome} ${fmtAge(c.ageHours)}h ago, > ${ttlHours}h TTL)\n`;
  }
  appendFileSync(alertPath, alertBlock);

  for (const c of candidates) {
    out(`reverted ${c.storyId} (cycle ended ${c.outcome} ${fmtAge(c.ageHours)}h ago)`);
  }
  return 0;
}

/** Parse events-<slug>.ndjson into UnstickEvent[] (ts ISO → epoch ms). */
function parseUnstickEvents(ndjson: string): UnstickEvent[] {
  const events: UnstickEvent[] = [];
  for (const raw of ndjson.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const tsRaw = typeof o["ts"] === "string" ? (o["ts"] as string) : "";
      const ms = tsRaw ? Date.parse(tsRaw) : Number.NaN;
      events.push({
        stage: typeof o["stage"] === "string" ? (o["stage"] as string) : undefined,
        label: typeof o["label"] === "string" ? (o["label"] as string) : undefined,
        detail: typeof o["detail"] === "string" ? (o["detail"] as string) : undefined,
        outcome: typeof o["outcome"] === "string" ? (o["outcome"] as string) : undefined,
        ts: Number.isNaN(ms) ? undefined : ms,
      });
    } catch {
      /* skip malformed */
    }
  }
  return events;
}

/** `roll backlog lint [--gate] [<path>]` — warn (or gate-fail) on §4 violations. */
export function backlogLintCommand(args: string[]): number {
  let gate = false;
  let backlog = BACKLOG_PATH;
  for (const a of args) {
    if (a === "--gate") gate = true;
    else backlog = a;
  }
  if (!existsSync(backlog)) {
    errLine(`[roll] backlog not found: ${backlog}`);
    return 1;
  }
  const findings = lintBacklogContent(readFileSync(backlog, "utf8"));
  for (const f of findings) {
    out(`${backlog}:${f.lineno}: ${f.sid} — ${f.issues}`);
    out(`  ${f.desc}`);
  }
  out("");
  if (findings.length > 0) {
    out(`  ${findings.length} violation(s) — see conventions/global/AGENTS.md §4`);
    if (gate) {
      out(msg("ci.gate_enabled_exiting_1", findings.length));
      return 1;
    }
    out(msg("ci.phase_1_warn_only_not_blocking", findings.length));
  } else {
    out(msg("ci.no_violations"));
  }
  return 0;
}
