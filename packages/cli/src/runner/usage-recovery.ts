/**
 * @responsibility Recovers session-file usage for interrupted cycles.
 */
/**
 * Session-file usage recovery (cli adapters over core's pure summers).
 *
 * FIX-303 broadened this from pi-only to the agents whose `-p` stdout carries no
 * parseable usage — pi and kimi — so a real cycle for either no longer records
 * `usage_unknown` (tokens "?", cost $0). Each agent persists authoritative
 * per-turn usage to its own store, and the core summers
 * (`sumPiSession`/`sumKimiWire`) normalize both onto the ONE 4-component model;
 * these adapters do the per-agent file discovery the core deliberately leaves to
 * the caller. (The codex recovery lane was removed with codex from the agent
 * pool — owner ruling: the unattended loop only spawns kimi/pi/reasonix.)
 *
 * FIX-249 — pi session-file usage recovery (cli adapter).
 *
 * pi's text-mode stdout carries no usage — `piExtract` is an always-null stub —
 * so every pi cycle's runs row lacked tokens/cost/model: dashboards read "—"/$0
 * and the budget guardrail (US-CORE-011, I11) gated on a cost that was always
 * zero. pi DOES write authoritative per-message usage into its session store:
 *
 *   ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl
 *
 * where <encoded-cwd> is the working directory with `/` → `-`, wrapped in `--`
 * (e.g. `/w/t` → `--w-t--`). Core already ports the pure summers
 * (`sumPiSession` / `aggregateSessions`, v2 oracle pi.py) — they had no live
 * caller. This adapter does the file discovery the core deliberately leaves to
 * the caller: resolve the cycle worktree's session dir, scope to files written
 * THIS cycle (mtime ≥ cycle start), sum, and shape the result as AgentUsage so
 * `toCycleCost` prices it from the table (pi reports no list cost).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type AgentUsage,
  aggregateSessions,
  sumKimiWire,
  sumPiSession,
} from "@roll/core";

/** Default pi session store root. */
export function defaultPiSessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/** The session dir pi uses for work done in `cwd` (path-encoded dir name). */
export function piSessionsDirFor(root: string, cwd: string): string {
  return join(root, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
}

/**
 * Recover this cycle's pi usage from its session files, or null when there is
 * nothing attributable (missing dir, no fresh files, zero tokens — "n/a, never
 * fake zeros"). `sinceSec` scopes to files touched this cycle; omitted = all.
 */
export function recoverPiUsage(
  worktreeCwd: string,
  sinceSec?: number,
  sessionsRoot: string = defaultPiSessionsRoot(),
): AgentUsage | null {
  const dir = piSessionsDirFor(sessionsRoot, worktreeCwd);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null; // no session dir for this cwd
  }
  const summaries = [];
  for (const f of files) {
    const p = join(dir, f);
    try {
      if (sinceSec !== undefined && statSync(p).mtimeMs / 1000 < sinceSec) continue;
      summaries.push(sumPiSession(readFileSync(p, "utf8").split("\n")));
    } catch {
      /* unreadable session file: skip, never fail the cycle */
    }
  }
  // FIX-1259: no source-baked model default — when a session file carried no
  // model, leave it empty so toCycleCost backfills the spawn model.
  const agg = aggregateSessions(summaries, "");
  if (agg === null) return null;
  return {
    model: agg.model ?? "",
    input_tokens: agg.input_tokens,
    output_tokens: agg.output_tokens,
    cache_creation_tokens: agg.cache_creation_tokens,
    cache_read_tokens: agg.cache_read_tokens,
    // pi's own per-message cost sum rides along for audit; toCycleCost still
    // prices from the table (no cost_list_usd here, by design).
    cost_reported: agg.cost_reported,
  };
}


// ── kimi session-file recovery (FIX-303) ─────────────────────────────────────

/** Default kimi-code session store root (env override → ~/.kimi-code/sessions). */
export function defaultKimiSessionsRoot(): string {
  return (process.env["ROLL_KIMI_SESSIONS_DIR"] ?? "").trim() || join(homedir(), ".kimi-code", "sessions");
}

/**
 * Recover this cycle's kimi usage from its persisted wire files, mirroring the
 * v2 `kimi.usage_from_session` (FIX-303: kimi-code's `-p` stdout carries no
 * parseable usage footer — the stdout-scrape `kimiExtract` lane is null on a
 * real cycle — so its runs row showed tokens "?"/cost $0). kimi-code persists
 * authoritative per-turn usage at
 *   <root>/wd_<worktree-basename>_<hash>/session_(star)/agents/main/wire.jsonl
 * Scope: match the `wd_<basename>_` segment against the cycle worktree basename
 * (retries reuse the same worktree → multiple files SUMMED), then `sumKimiWire`
 * each into the 4-component model. `sinceSec` scopes to files touched this cycle
 * (mtime ≥ cycle start). Returns null when nothing is attributable ("n/a, never
 * fake zeros").
 */
export function recoverKimiUsage(
  worktreeCwd: string,
  sinceSec?: number,
  sessionsRoot: string = defaultKimiSessionsRoot(),
): AgentUsage | null {
  const wantBasename = basename(worktreeCwd.replace(/\/+$/, ""));
  let wdDirs: string[];
  try {
    wdDirs = readdirSync(sessionsRoot).filter((d) => d.startsWith(`wd_${wantBasename}_`));
  } catch {
    return null; // no kimi session store
  }
  const wireFiles: string[] = [];
  for (const wd of wdDirs) {
    const agentsRoot = join(sessionsRoot, wd);
    let sessions: string[];
    try {
      sessions = readdirSync(agentsRoot).filter((s) => s.startsWith("session_"));
    } catch {
      continue;
    }
    for (const session of sessions) {
      wireFiles.push(join(agentsRoot, session, "agents", "main", "wire.jsonl"));
    }
  }
  const summaries = [];
  for (const p of wireFiles) {
    try {
      if (sinceSec !== undefined && statSync(p).mtimeMs / 1000 < sinceSec) continue;
      summaries.push(sumKimiWire(readFileSync(p, "utf8").split("\n")));
    } catch {
      /* unreadable / absent wire file: skip, never fail the cycle */
    }
  }
  // FIX-1259: no source-baked model default — empty when the wire carried none,
  // so toCycleCost backfills the spawn model.
  const agg = aggregateSessions(summaries, "");
  if (agg === null) return null;
  return {
    model: agg.model ?? "",
    input_tokens: agg.input_tokens,
    output_tokens: agg.output_tokens,
    cache_creation_tokens: agg.cache_creation_tokens,
    cache_read_tokens: agg.cache_read_tokens,
  };
}
