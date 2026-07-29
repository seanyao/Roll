/**
 * `roll loop reset | mute | unmute | gc | test` — US-PORT-022 (part 2): the
 * residual loop WRITE/maintenance subcommands ported off the frozen bash
 * `bin/roll` engine. Each mirrors its v2 oracle's side effects, gates, and
 * flags; output follows the resolved locale (single language), via the same
 * [roll]-prefixed ok/info/warn/err presentation the bash helpers emit.
 *
 * Path model (mirrors bin/roll 7286-7330 source-time resolution):
 *   - state file : <rt>/state-<slug>.yaml   (rt = ROLL_PROJECT_RUNTIME_DIR env
 *                  → plist/crontab/inner-script resolved project /.roll/loop →
 *                  else <shared>/loop). Same resolution as `loop status`.
 *   - mute file  : <rt>/mute-<slug>         (shared by the loop + peer auto-attach
 *                  popup gate; run-once reads it before opening the report).
 *   - heal dir   : ${ROLL_LOOP_DIR:-<shared>/loop}/heal  (HEAD-CI heal counters).
 */
import { rollConfigPath, yamlReadNested } from "@roll/infra";
import { agentSmokeCommand } from "@roll/core";
import { resolveLang, t, v2Catalog, type Lang } from "@roll/spec";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loopRuntimeDir, projectSlug, sharedRoot } from "./dashboard.js";

// ─── presentation (mirrors bin/roll ok/info/warn/err: "[roll] <line>") ────────
interface Palette {
  GREEN: string;
  CYAN: string;
  YELLOW: string;
  RED: string;
  NC: string;
}
function palette(): Palette {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  return noColor
    ? { GREEN: "", CYAN: "", YELLOW: "", RED: "", NC: "" }
    : { GREEN: "\x1b[0;32m", CYAN: "\x1b[0;36m", YELLOW: "\x1b[0;33m", RED: "\x1b[0;31m", NC: "\x1b[0m" };
}
function ok(line: string, p = palette()): void {
  process.stdout.write(`${p.GREEN}[roll]${p.NC} ${line}\n`);
}
function info(line: string, p = palette()): void {
  process.stdout.write(`${p.CYAN}[roll]${p.NC} ${line}\n`);
}
function err(line: string, p = palette()): void {
  process.stderr.write(`${p.RED}[roll]${p.NC} ${line}\n`);
}

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

// ─── path resolution ──────────────────────────────────────────────────────────

/** <rt>/state-<slug>.yaml — rt from loopRuntimeDir, else <shared>/loop. */
export function stateFile(slug: string): string {
  const rt = loopRuntimeDir(slug) ?? join(sharedRoot(), "loop");
  return join(rt, `state-${slug}.yaml`);
}

/** <rt>/mute-<slug> — same rt resolution as the state file. */
export function muteFile(slug: string): string {
  const rt = loopRuntimeDir(slug) ?? join(sharedRoot(), "loop");
  return join(rt, `mute-${slug}`);
}

/** ${ROLL_LOOP_DIR:-<shared>/loop}/heal — bin/roll `_loop_heal_dir` (11454). */
export function healDir(): string {
  const base = (process.env["ROLL_LOOP_DIR"] ?? "").trim() || join(sharedRoot(), "loop");
  return join(base, "heal");
}

// ─── commands ─────────────────────────────────────────────────────────────────

/**
 * `roll loop reset` — clear the per-project loop state + heal counters so the
 * next cycle starts fresh. The most-pointed-to recovery path (ALERT messages,
 * stale-lock self-heal, tcr.ts error hints all steer here). Mirrors bin/roll
 * `_loop_reset` (10444): rm state-<slug>.yaml (report which branch), then
 * rm -rf the heal dir unconditionally.
 */
export function loopResetCommand(_args: string[] = []): number {
  const slug = projectSlug();
  const state = stateFile(slug);
  if (existsSync(state)) {
    rmSync(state, { force: true });
    ok(msg("loop.loop_state_cleared_will_start_fresh"));
  } else {
    info(msg("loop.no_loop_state_to_clear"));
  }
  rmSync(healDir(), { recursive: true, force: true });
  return 0;
}

/**
 * `roll loop mute` — suppress the auto-attach popup. The marker file's presence
 * makes run-once (and the peer popup gate) skip the Terminal popup on the next
 * fire; loop output still flows to tmux + log. Mirrors `_loop_mute` (10457):
 * mkdir -p the parent, then truncate-create the marker.
 */
export function loopMuteCommand(_args: string[] = []): number {
  const slug = projectSlug();
  const file = muteFile(slug);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  ok(msg("loop.muted_auto_attach_disabled"));
  return 0;
}

/**
 * `roll loop unmute` — re-enable the auto-attach popup. Mirrors `_loop_unmute`
 * (10464): rm -f the marker.
 */
export function loopUnmuteCommand(_args: string[] = []): number {
  const slug = projectSlug();
  rmSync(muteFile(slug), { force: true });
  ok(msg("loop.unmuted_auto_attach_live"));
  return 0;
}

// ─── loop gc ────────────────────────────────────────────────────────────────

/** Port of `_loop_in_cycle` (bin/roll): cycle context via runner-exported env. */
export function loopInCycle(): boolean {
  return (
    (process.env["ROLL_LOOP_AGENT"] ?? "") !== "" || (process.env["ROLL_CYCLE_LOG_RAW"] ?? "") !== ""
  );
}

/** Injectable surface so tests drive a sandbox dir + a frozen clock. */
export interface LoopGcDeps {
  /** Canonical LaunchAgents dir — always ~/Library/LaunchAgents live (auto-sandbox
   *  only redirects WRITES; gc scans the canonical dir). */
  plistDir: () => string;
  /** <shared>/loop — the control-plane root holding runners + data + debris. */
  loopDir: () => string;
  /** Wall clock (epoch ms) — frozen in tests for deterministic cutoffs/stamps. */
  nowMs: () => number;
}
function realGcDeps(): LoopGcDeps {
  return {
    plistDir: () => join(homedir(), "Library", "LaunchAgents"),
    loopDir: () => join(sharedRoot(), "loop"),
    nowMs: () => Date.now(),
  };
}

/** mtime in epoch SECONDS; 0 when unreadable (mirrors `_file_mtime`). */
function fileMtimeSec(f: string): number {
  try {
    return Math.floor(statSync(f).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

/** Extract WorkingDirectory from a launchd plist (mirrors the gc awk). */
function plistWorkingDir(plistPath: string): string {
  try {
    const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(
      readFileSync(plistPath, "utf8"),
    );
    return m?.[1] ?? "";
  } catch {
    return "";
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** ts stamp `YYYYMMDDTHHMMSS` from a Date, LOCAL time (mirrors `date +...`). */
function gcStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** List <loopDir> basenames whose name matches one of the glob shapes. */
function loopDirEntries(loopDir: string): string[] {
  try {
    return readdirSync(loopDir);
  } catch {
    return [];
  }
}

/**
 * `roll loop gc [--dry-run] [--keep-days N]` — garbage-collect orphan slugs,
 * tmp debris, and expired backups (US-LOOP-021). TS port of `_loop_gc` (10504).
 *
 * Gates / contracts preserved:
 *   - FIX-125 cycle-context tripwire (refuses; this mutates ~/Library/LaunchAgents).
 *   - Retention precedence: ROLL_LOOP_GC_RETENTION_DAYS env > (when .roll/local.yaml
 *     exists) the GLOBAL config's nested loop_gc.retention_days > --keep-days > 30.
 *     NOTE the v2 quirk faithfully kept: the local.yaml presence GUARDS the read,
 *     but the value comes from the GLOBAL config (`config_get` reads $ROLL_CONFIG).
 *   - Phase 1 archives orphan slugs (plist WorkingDirectory gone) to
 *     <loop>/archived/<slug>-<ts>; Phase 2 sweeps runs.jsonl.tmp.* (always),
 *     backup-before-merge-*.tgz (>5d), *.migrated-* (>7d), *.bak (>keep-days).
 *   - Summary line + every [DRY-RUN]/gc: line are plain English echoes (no i18n).
 */
export function loopGcCommand(args: string[] = [], deps: LoopGcDeps = realGcDeps()): number {
  if (loopInCycle()) {
    process.stderr.write("roll loop gc: refusing — cycle-context tripwire (FIX-125)\n");
    process.stderr.write("  This command scans ~/Library/LaunchAgents directly. Running it\n");
    process.stderr.write("  from inside a loop cycle is a known host-state corruption path.\n");
    return 1;
  }

  let dryRun = false;
  let keepDays = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--keep-days") {
      keepDays = Number(args[i + 1]);
      i++;
    }
  }

  // Retention: env > local.yaml-guarded global nested > --keep-days/30.
  const envRet = (process.env["ROLL_LOOP_GC_RETENTION_DAYS"] ?? "").trim();
  if (envRet !== "") {
    keepDays = Number(envRet);
  } else if (existsSync(join(".roll", "local.yaml"))) {
    const v = yamlReadNested(rollConfigPath(), "loop_gc", "retention_days");
    if (/^\d+$/.test(v)) keepDays = Number(v);
  }

  const loopDir = deps.loopDir();
  const plistDir = deps.plistDir();
  const nowMs = deps.nowMs();
  const nowSec = Math.floor(nowMs / 1000);
  let gcCount = 0;

  // ── Phase 1: orphan slug detection ──
  for (const fname of loopDirEntries(plistDir)) {
    if (!fname.startsWith("com.roll.loop.") || !fname.endsWith(".plist")) continue;
    const plist = join(plistDir, fname);
    if (!statSafeIsFile(plist)) continue; // mirrors bash `[[ -f "$plist" ]] || continue`
    const slug = fname.slice("com.roll.loop.".length, -".plist".length);
    if (slug === "") continue;

    const proj = plistWorkingDir(plist);
    if (proj !== "" && isDir(proj)) continue; // live project — keep

    if (dryRun) {
      process.stdout.write(`[DRY-RUN] orphan slug: ${slug} (project not found)\n`);
      gcCount++;
      continue;
    }

    process.stdout.write(`gc: archiving orphan slug ${slug}\n`);
    const archiveDir = join(loopDir, "archived", `${slug}-${gcStamp(new Date(nowMs))}`);
    mkdirSync(archiveDir, { recursive: true });
    for (const rel of [
      `run-${slug}.sh`,
      `run-${slug}-inner.sh`,
      `attach-roll-loop-${slug}.command`,
    ]) {
      const src = join(loopDir, rel);
      if (existsSync(src)) renameSync(src, join(archiveDir, rel));
    }
    if (existsSync(plist)) renameSync(plist, join(archiveDir, fname));
    for (const rel of [
      `state-${slug}.yaml`,
      `runs-${slug}.jsonl`,
      `events-${slug}.ndjson`,
      `cron-${slug}.log`,
    ]) {
      rmSync(join(loopDir, rel), { force: true });
    }
    gcCount++;
  }

  // ── Phase 2: tmp debris + expired backups ──
  const cutoff5d = nowSec - 5 * 86400;
  const cutoff7d = nowSec - 7 * 86400;
  const cutoffKeep = nowSec - keepDays * 86400;
  for (const fname of loopDirEntries(loopDir)) {
    const f = join(loopDir, fname);
    if (!statSafeIsFile(f)) continue;

    // runs.jsonl.tmp.* — always safe to remove.
    if (fname.startsWith("runs.jsonl.tmp.")) {
      if (dryRun) process.stdout.write(`[DRY-RUN] tmp debris: ${basename(f)}\n`);
      else rmSync(f, { force: true });
      gcCount++;
      continue;
    }
    // backup-before-merge-*.tgz older than 5 days.
    if (fname.startsWith("backup-before-merge-") && fname.endsWith(".tgz")) {
      if (fileMtimeSec(f) < cutoff5d) {
        if (dryRun) process.stdout.write(`[DRY-RUN] old backup: ${basename(f)}\n`);
        else rmSync(f, { force: true });
        gcCount++;
      }
      continue;
    }
    // *.migrated-* older than 7 days.
    if (fname.includes(".migrated-")) {
      if (fileMtimeSec(f) < cutoff7d) {
        if (dryRun) process.stdout.write(`[DRY-RUN] old migrated: ${basename(f)}\n`);
        else rmSync(f, { force: true });
        gcCount++;
      }
      continue;
    }
    // *.bak older than keep-days.
    if (fname.endsWith(".bak")) {
      if (fileMtimeSec(f) < cutoffKeep) {
        if (dryRun) process.stdout.write(`[DRY-RUN] old .bak: ${basename(f)}\n`);
        else rmSync(f, { force: true });
        gcCount++;
      }
    }
  }

  process.stdout.write(
    dryRun
      ? `gc: dry-run complete (${gcCount} items would be cleaned)\n`
      : `gc: ${gcCount} items cleaned, keep-days=${keepDays}\n`,
  );
  return 0;
}

function statSafeIsFile(f: string): boolean {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
}

// ─── loop test ──────────────────────────────────────────────────────────────

/** Injectable surface so tests drive paths + a fake runner exec + clock. */

/** The default smoke command for an agent (mirrors `_loop_test`). */
export function defaultSmokeCmd(agent: string): string {
  return `${agentSmokeCommand(agent)}; sleep 10`;
}

// US-LOOP-117: `roll loop test` is gone. It smoke-tested the generated launchd
// runner and hard-required it ("Run 'roll loop on' first to generate it") — a
// runner nothing can generate any more. `roll loop go --max-cycles 1` is the
// honest way to try the flow end to end.


export { err as _err, info as _info, ok as _ok, palette as _palette };
