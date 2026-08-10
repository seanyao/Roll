/**
 * @responsibility Runs the `roll loop alert` subcommand, adapting core alert-loop decisions to the CLI presentation.
 */
/**
 * `roll loop alert` — TS port of bin/roll cmd_alert (14056-14104) + _alert_log
 * (14112-14149) + _alert_log_file (14246-14249). The DECISION layer is reused
 * from @roll/core's alert-loop (cli depends on core): alertConsumeAction,
 * parseLogCount, parseAlertLogTail. This module is the CLI adapter — it
 * resolves the on-disk paths the oracle resolves, applies the color/prefix
 * presentation, and emits the byte-identical lines.
 *
 * Subcommands: list/"" | ack | resolve/clear | log [N] | unknown.
 *
 * Path resolution (mirrors bin/roll 7286-7322):
 *   $_LOOP_ALERT = <rt_dir or shared_root/loop>/ALERT-<slug>.md
 *   _alert_log_file = .roll/state/alert-log.jsonl (relative to cwd, 14247-14249)
 * Notes on test parity: in the bash source the rt-dir branch is unreachable at
 * source time (the helper is defined after the assignment), so a live `roll
 * alert` always resolves the ACTIVE file under $_SHARED_ROOT/loop — which the
 * difftests fabricate via the _SHARED_ROOT env override + ROLL_MAIN_SLUG.
 */
import {
  ALERT_LOG_RELATIVE_PATH,
  alertConsumeAction,
  alertFileName,
  parseAlertLogTail,
} from "@roll/core";
import { resolveLang, t, v2Catalog, type Lang } from "@roll/spec";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Palette {
  RED: string;
  GREEN: string;
  YELLOW: string;
  CYAN: string;
  BOLD: string;
  NC: string;
}

function palette(): Palette {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  return noColor
    ? { RED: "", GREEN: "", YELLOW: "", CYAN: "", BOLD: "", NC: "" }
    : {
        RED: "\x1b[0;31m",
        GREEN: "\x1b[0;32m",
        YELLOW: "\x1b[0;33m",
        CYAN: "\x1b[0;36m",
        BOLD: "\x1b[1m",
        NC: "\x1b[0m",
      };
}

function msgLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

/** The current project slug (ROLL_MAIN_SLUG short-circuits, mirroring _project_slug 6947). */
function projectSlug(): string {
  const fromEnv = process.env["ROLL_MAIN_SLUG"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return "default";
}

/**
 * Resolve the ACTIVE alert file ($_LOOP_ALERT). Project-local first:
 * `.roll/loop/ALERT-<slug>.md` (FIX-052: per-project state). Falls back to
 * the v2 shared location for backward compat with pre-existing alerts.
 * ROLL_PROJECT_RUNTIME_DIR (test only) overrides all.
 */
function loopAlertPath(): string {
  const slug = projectSlug();
  const name = alertFileName(slug);
  const rt = process.env["ROLL_PROJECT_RUNTIME_DIR"];
  if (rt !== undefined && rt !== "") return join(rt, name);
  // Project-local first (FIX-052 / FIX-216).
  const local = join(".roll", "loop", name);
  if (existsSync(local)) return local;
  // V2 shared fallback — backward compat for pre-existing alerts from old loops.
  const shared = process.env["_SHARED_ROOT"] ?? join(homedir(), ".shared", "roll");
  return join(shared, "loop", name);
}

/** _alert_log_file: relative `.roll/state/alert-log.jsonl`, dir auto-created (14247-14249). */
function alertLogFile(): string {
  try {
    mkdirSync(".roll/state", { recursive: true });
  } catch {
    /* best-effort, mirrors `mkdir -p ... 2>/dev/null || true` */
  }
  return ALERT_LOG_RELATIVE_PATH;
}

function ok(line: string, p: Palette): void {
  process.stdout.write(`${p.GREEN}[roll]${p.NC} ${line}\n`);
}
function warn(line: string, p: Palette): void {
  process.stdout.write(`${p.YELLOW}[roll]${p.NC} ${line}\n`);
}
function err(line: string, p: Palette): void {
  process.stderr.write(`${p.RED}[roll]${p.NC} ${line}\n`);
}

/** Render `roll loop alert log` exactly as _alert_log's python printer (14121-14148). */
function renderLog(n: number, p: Palette, lang: Lang): number {
  const file = alertLogFile();
  // bash `[[ ! -s "$file" ]]` → absent OR empty → "no history yet".
  let body = "";
  try {
    if (existsSync(file) && statSync(file).size > 0) body = readFileSync(file, "utf8");
  } catch {
    body = "";
  }
  if (body === "") {
    ok("No alert history yet.", p);
    process.stdout.write("  暂无告警历史。\n");
    return 0;
  }
  const out: string[] = [];
  // echo -e "  ${BOLD}Alert log${NC}  (${CYAN}${file}${NC})"
  out.push(`  ${p.BOLD}Alert log${p.NC}  (${p.CYAN}${file}${p.NC})`);
  out.push(`  告警日志  最近 ${n} 条`);
  out.push("");
  for (const rec of parseAlertLogTail(body, n)) {
    const ts = rec.recorded_at;
    const hhmm = ts.length >= 16 ? ts.slice(11, 16) : ts;
    const glyph = rec.notified ? `${p.GREEN}●${p.NC}` : `${p.YELLOW}○${p.NC}`;
    const lc = rec.level === "error" ? p.RED : rec.level === "warn" ? p.YELLOW : "";
    out.push(`  ${hhmm}  ${glyph} ${lc}[${rec.level}]${p.NC} ${rec.category} — ${rec.message}`);
  }
  process.stdout.write(out.join("\n") + "\n");
  void lang;
  return 0;
}

export function alertCommand(args: string[]): number {
  const p = palette();
  const lang = msgLang();
  const subcmd = args[0] ?? "list";
  const rest = args.slice(1);

  const file = loopAlertPath();
  const fileExists = existsSync(file);
  const contents = fileExists ? readFileSync(file, "utf8") : "";
  // ack footer ts: bash `date '+%Y-%m-%d %H:%M:%S'`.
  const ts = nowStamp();
  const action = alertConsumeAction(subcmd, fileExists, contents, ts, rest[0]);

  switch (action.kind) {
    case "show_none":
      // list (absent) AND resolve/clear (absent) both → "No active alerts".
      ok(t(v2Catalog, lang, "alert.no_active_alerts"), p);
      return 0;
    case "show": {
      const out: string[] = [];
      // echo -e "$(msg alert.active_alert ${BOLD} ${NC})"  →  BOLD..Active Alert..NC
      out.push(t(v2Catalog, lang, "alert.active_alert", p.BOLD, p.NC));
      out.push("");
      // cat "$file" (no extra newline added by cat beyond the file's own bytes).
      // bash: `cat` then `echo ""`. We print the contents then a blank line.
      process.stdout.write(out.join("\n") + "\n");
      process.stdout.write(action.contents);
      const tail: string[] = [];
      tail.push("");
      tail.push(`  Run '${p.CYAN}roll loop alert ack${p.NC}' to acknowledge, '${p.CYAN}roll loop alert resolve${p.NC}' to clear.`);
      tail.push(t(v2Catalog, lang, "alert.run_roll_alert_ack_to_acknowledge"));
      process.stdout.write(tail.join("\n") + "\n");
      return 0;
    }
    case "ack_none":
      warn(t(v2Catalog, lang, "alert.no_active_alerts_to_acknowledge"), p);
      return 0;
    case "ack_append": {
      // bash appends: `\n` + `**Acknowledged**: <ts>` (each via echo → trailing \n).
      appendFileSync(file, `\n**Acknowledged**: ${ts}\n`);
      ok(ackMessage(lang, ts), p);
      return 0;
    }
    case "remove":
      rmSync(file, { force: true });
      ok(t(v2Catalog, lang, "alert.alert_resolved_and_cleared"), p);
      return 0;
    case "log":
      return renderLog(action.n, p, lang);
    case "unknown":
      err(t(v2Catalog, lang, "alert.unknown_subcommand", action.subcommand), p);
      process.stdout.write("  Usage: roll loop alert [list|ack|resolve|log]\n");
      process.stdout.write("  用法：roll loop alert [list|ack|resolve|log]\n");
      return 1;
  }
}

/** `date '+%Y-%m-%d %H:%M:%S'` in local time. */
function nowStamp(): string {
  const d = new Date();
  const z = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

/**
 * The ack confirmation message. The bash oracle's `ok "$(msg
 * alert.alert_acknowledged_at ${ts})"` word-splits the unquoted ${ts} on its
 * SPACE into two args (date + time), and bash printf REUSES the "%s" format
 * once per arg — yielding "Alert acknowledged at <date>Alert acknowledged at
 * <time>" for EN. The ZH entry has no "%s" so it renders verbatim. We reproduce
 * that quirk verbatim so the bytes match the frozen oracle.
 */
function ackMessage(lang: Lang, ts: string): string {
  const entry = v2Catalog["alert.alert_acknowledged_at"];
  const tmpl = lang === "zh" && entry?.zh !== undefined ? entry.zh : (entry?.en ?? "alert.alert_acknowledged_at");
  if (!tmpl.includes("%s")) return tmpl; // ZH path: no substitution.
  // EN path: emulate printf format-reuse across the whitespace-split args.
  const parts = ts.split(/\s+/).filter((s) => s !== "");
  return parts.map((arg) => tmpl.replace(/%s/, arg)).join("");
}
