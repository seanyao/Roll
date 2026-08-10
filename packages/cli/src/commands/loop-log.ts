/**
 * @responsibility Runs the `roll loop log` subcommand, reading per-cycle logs from the cycle-logs directory.
 */
/**
 * `roll loop log [<cycle-id|prefix>]` — TS port of bin/roll's `_loop_log` +
 * `_loop_log_show` (US-PORT-022). Reads `.roll/cycle-logs/*.log`: no arg shows
 * the latest cycle (with a stderr steer toward per-cycle search); an arg does
 * exact-then-prefix match. Pure read — no bash fallback.
 *
 * Byte-aligned with the frozen bash oracle: same friendly empty message, the
 * two-line stderr note, the `# cycle <id> · <ts>` header (timestamp derived
 * from the filename), and the ambiguous-prefix listing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { type Lang, resolveLang, t, v2Catalog } from "@roll/spec";

function lang(): Lang {
  return resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
}
function msg(key: string, ...args: Array<string | number>): string {
  return t(v2Catalog, lang(), key, ...args);
}

function projectPath(): string {
  return (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
}

/** Mirror `_loop_log_show`: header (`# cycle <id> · <YYYY-MM-DD HH:MM>`) + body. */
function showLog(file: string): void {
  const id = basename(file, ".log");
  // filename encodes the cycle start: YYYYMMDD-HHMMSS-PID → "YYYY-MM-DD HH:MM".
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(id);
  const ts = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : id;
  let body = "";
  try {
    body = readFileSync(file, "utf8");
  } catch {
    body = "";
  }
  process.stdout.write(`# cycle ${id} · ${ts}\n${body}`);
}

function logFiles(logsDir: string): string[] {
  try {
    return readdirSync(logsDir).filter((n) => n.endsWith(".log"));
  } catch {
    return [];
  }
}

export function loopLogCommand(argv: string[]): number {
  const logsDir = join(projectPath(), ".roll", "cycle-logs");
  const all = logFiles(logsDir);
  if (!existsSync(logsDir) || all.length === 0) {
    process.stdout.write(msg("loop.no_cycle_logs_found_run_roll") + "\n");
    return 0;
  }

  const query = (argv[0] ?? "").trim();
  if (query === "") {
    // cron.log steer — always to stderr so piped log output stays clean.
    process.stderr.write("note: cron.log is a legacy aggregate; use 'roll loop log <cycle-id>' for per-cycle search\n");
    process.stderr.write("提示：cron.log 是旧的聚合日志；按周期查看请用 'roll loop log <cycle-id>'\n");
    // Filenames sort lexicographically by start timestamp → greatest = latest.
    const latest = [...all].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0];
    if (latest === undefined) {
      process.stdout.write(msg("loop.no_cycle_logs_found_run_roll_2") + "\n");
      return 0;
    }
    showLog(join(logsDir, latest));
    return 0;
  }

  const exact = join(logsDir, `${query}.log`);
  if (existsSync(exact)) {
    showLog(exact);
    return 0;
  }

  const matches = all.filter((n) => n.startsWith(query)).sort();
  if (matches.length === 0) {
    process.stdout.write(msg("loop.no_cycle_log_matching", query) + "\n");
    return 1;
  }
  if (matches.length === 1) {
    showLog(join(logsDir, matches[0] as string));
    return 0;
  }
  process.stdout.write(msg("loop.ambiguous_prefix_matches_logs", query, matches.length) + "\n");
  for (const f of matches) process.stdout.write(`  ${basename(f, ".log")}\n`);
  return 1;
}
