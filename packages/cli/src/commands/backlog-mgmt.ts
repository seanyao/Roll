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
  type UnstickEvent,
  applyStuckReverts,
  lintIdeaDescription,
  reconcileStuckBacklog,
} from "@roll/core";
import { resolveLang, STATUS_MARKER, t, v2Catalog, type Lang } from "@roll/spec";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claimStoryLease, type LeaseSource } from "@roll/core";
import {
  emitBacklogTarget,
  emitBacklogTargetError,
  resolveBacklogCommandTarget,
  stripBacklogScopeArgs,
  workspaceOwnsPath,
  type BacklogTargetResolver,
  type ResolvedBacklogTarget,
} from "./backlog-target.js";

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

export interface BacklogMgmtTargetDeps {
  readonly resolveTarget?: BacklogTargetResolver;
}

function resolveOneTarget(
  rawArgs: readonly string[],
  operation: "read" | "mutation",
  deps: BacklogMgmtTargetDeps,
): ResolvedBacklogTarget | number {
  const decision = (deps.resolveTarget ?? resolveBacklogCommandTarget)(rawArgs, operation);
  if (!decision.ok) return emitBacklogTargetError(decision);
  if ("aggregate" in decision) {
    errLine("backlog: invalid_arguments — aggregate management commands are not supported");
    return 1;
  }
  return decision;
}

function requireOwnedPaths(target: ResolvedBacklogTarget, paths: readonly string[]): boolean {
  const escaped = paths.find((path) => !workspaceOwnsPath(target.canonicalRoot, path));
  if (escaped === undefined) return true;
  errLine(`backlog: invalid_target — Workspace-owned path escapes canonical root: ${escaped}`);
  return false;
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
  deps: BacklogMgmtTargetDeps = {},
): number {
  const scoped = stripBacklogScopeArgs(args);
  if (!scoped.ok) return 1;
  const pattern = scoped.args[0] ?? "";
  const reason = scoped.args[1] ?? "";
  if (pattern === "") {
    errLine(`[roll] ${msg("backlog.usage_roll_backlog_pattern_reason", subcmd)}`);
    return 1;
  }
  const newStatus = statusFor(subcmd, reason);
  if (newStatus === null) return 1; // unreachable via the dispatcher
  const target = resolveOneTarget(args, "mutation", deps);
  if (typeof target === "number") return target;
  if (!requireOwnedPaths(target, [target.backlogPath])) return 1;
  if (!existsSync(target.backlogPath)) {
    errLine(`[roll] ${msg("backlog.roll_backlog_md_not_found_run")}`);
    return 1;
  }
  emitBacklogTarget(target);
  const snap = store.readBacklog(target.backlogPath);
  const { count } = store.mark(target.backlogPath, snap.hash, pattern, newStatus);
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
  resolveTarget?: BacklogTargetResolver;
}

function realClaimDeps(): ClaimDeps {
  return { nowMs: () => Date.now(), resolveTarget: resolveBacklogCommandTarget };
}

/** `roll backlog claim <card> [--source human|supervisor]` — manual soft lease writer. */
export function backlogClaimCommand(args: string[], deps: ClaimDeps = realClaimDeps(), store: BacklogStore = new BacklogStore()): number {
  const scoped = stripBacklogScopeArgs(args);
  if (!scoped.ok) return 1;
  const pattern = scoped.args[0] ?? "";
  let source: LeaseSource = "human";
  for (let i = 1; i < scoped.args.length; i++) {
    if (scoped.args[i] === "--source") {
      const raw = scoped.args[i + 1] ?? "";
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
  const target = resolveOneTarget(args, "mutation", deps);
  if (typeof target === "number") return target;
  const leasePath = join(target.runtimeRoot, "locks", "leases");
  if (!requireOwnedPaths(target, [target.backlogPath, leasePath])) return 1;
  if (!existsSync(target.backlogPath)) {
    errLine(`[roll] ${msg("backlog.roll_backlog_md_not_found_run")}`);
    return 1;
  }
  emitBacklogTarget(target);
  const snap = store.readBacklog(target.backlogPath);
  const { count } = store.mark(target.backlogPath, snap.hash, pattern, STATUS_MARKER.in_progress);
  if (count === 0) {
    out(msg("backlog.no_items_matched", pattern));
    return 0;
  }
  mkdirSync(dirname(leasePath), { recursive: true });
  const result = claimStoryLease(leasePath, pattern, { source, claimedAt: deps.nowMs() });
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
    const fields = line.split("|");
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
  nowMs: () => number;
  resolveTarget?: BacklogTargetResolver;
}
function realUnstickDeps(): UnstickDeps {
  return { nowMs: () => Date.now(), resolveTarget: resolveBacklogCommandTarget };
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
  const scoped = stripBacklogScopeArgs(args);
  if (!scoped.ok) return 1;
  let dryRun = false;
  let ttlHours = 4.0;
  for (let i = 0; i < scoped.args.length; i++) {
    if (scoped.args[i] === "--dry-run") dryRun = true;
    else if (scoped.args[i] === "--ttl-hours") {
      const n = Number(scoped.args[i + 1]);
      if (Number.isFinite(n)) ttlHours = n;
      i++;
    } else return 1;
  }
  const target = resolveOneTarget(args, "mutation", deps);
  if (typeof target === "number") return target;
  const eventsPath = join(target.runtimeRoot, "events.ndjson");
  const alertPath = join(target.runtimeRoot, "alerts", "unstick.md");
  if (!requireOwnedPaths(target, [target.backlogPath, eventsPath, alertPath])) return 1;
  if (!existsSync(target.backlogPath)) {
    errLine(`backlog not found: ${target.backlogPath}`);
    return 0;
  }

  emitBacklogTarget(target);
  const events = existsSync(eventsPath) ? parseUnstickEvents(readFileSync(eventsPath, "utf8")) : [];
  const content = readFileSync(target.backlogPath, "utf8");
  const nowMs = deps.nowMs();
  const candidates = reconcileStuckBacklog(content, events, nowMs, ttlHours);
  if (candidates.length === 0) return 0;

  if (dryRun) {
    for (const c of candidates) {
      out(`would-revert ${c.storyId} (cycle ended ${c.outcome} ${fmtAge(c.ageHours)}h ago)`);
    }
    return 0;
  }

  writeFileSync(target.backlogPath, applyStuckReverts(content, candidates));

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

/** `roll backlog lint [--gate]` — warn (or gate-fail) on §4 violations. */
export function backlogLintCommand(args: string[], deps: BacklogMgmtTargetDeps = {}): number {
  const scoped = stripBacklogScopeArgs(args);
  if (!scoped.ok) return 1;
  let gate = false;
  for (const a of scoped.args) {
    if (a === "--gate") gate = true;
    else return 1;
  }
  const target = resolveOneTarget(args, "read", deps);
  if (typeof target === "number") return target;
  if (!requireOwnedPaths(target, [target.backlogPath])) return 1;
  if (!existsSync(target.backlogPath)) {
    errLine(`[roll] backlog not found: ${target.backlogPath}`);
    return 1;
  }
  emitBacklogTarget(target);
  const findings = lintBacklogContent(readFileSync(target.backlogPath, "utf8"));
  for (const f of findings) {
    out(`${target.backlogPath}:${f.lineno}: ${f.sid} — ${f.issues}`);
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
