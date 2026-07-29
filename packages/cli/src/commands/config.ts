/**
 * `roll config` — full command surface, TS-native (US-PORT-006).
 *
 * The READ surface (help / --list / key read) was ported first (US-CLI-003,
 * config-get.ts) and is reused verbatim here. This module adds the WRITE
 * surface and the three compact facades (loop-window / loop-schedule /
 * dream-time), so the entire `config` command is now TS — the bash fallback in
 * the router is retired (整个 config 命令收口).
 *
 * REFACTOR-049: the `config lang` sub-command subsumes the former top-level
 * `roll lang` command. `roll lang` is removed from the command registry; the
 * lang surface now lives exclusively under `roll config lang <zh|en|--reset>`.
 *
 * ─── v2 oracle ──────────────────────────────────────────────────────────────
 *   cmd_config (bin/roll 6085-6181), _config_loop_window (5929), _config_loop_schedule
 *   (5974), _config_daily_time (6021). Validation / yaml writing / scope→file
 *   live in @roll/infra (configValidate / configSet / configKeyFile).
 *
 * ─── DELIBERATE DIVERGENCE: schedule reload ─────────────────────────────────
 * v2's cmd_config calls `_config_reload_schedule` after every successful write,
 * which re-runs `_install_launchd_plists >/dev/null 2>&1` — SILENT on success,
 * warning only when the loop is paused/muted or the install fails. The TS port
 * does NOT implicitly (re)mount launchd from a config write: mounting is owned
 * by `roll loop on` (US-LOOP-009), which FIX-212 made verify-or-fail-loud — a
 * silent best-effort remount from an unrelated config edit would undermine that
 * guarantee. The facades already print "run `roll loop on` to apply", and the
 * plain-key write path's observable output is unchanged (the v2 reload emits
 * nothing on the success path). Net: byte-identical CLI output; the only
 * behavioural change is that applying a new schedule is now an explicit
 * `roll loop on` rather than an implicit side effect.
 */
import { CONFIG_KEYS, configKeyFile, configResolve, configSet, configValidate } from "@roll/infra";
import { clearLang, resolveCurrent, resolveSource, writeLang } from "./lang.js";
import { CONFIG_FACADE_KEYS, configGetCommand } from "./config-get.js";

type Scope = "project" | "global";
export type ConfigWorkspaceContextOperation = "read" | "write";

/** Argument classifier shared by live dispatch registration and config parsing. */
export function configWorkspaceContextOperation(args: readonly string[]): ConfigWorkspaceContextOperation | undefined {
  const positional = args.filter((arg) =>
    arg !== "--list" && arg !== "--global" && arg !== "--project" && arg !== "--help" && arg !== "-h");
  if (positional[0] === "help") return "read";
  const key = positional[0];
  if (key === undefined) return "read";
  const known = key === "lang" || CONFIG_FACADE_KEYS.includes(key) || CONFIG_KEYS.some((record) => record.key === key);
  if (!known) return undefined;
  return positional.length >= 2 ? "write" : "read";
}

function noColor(): boolean {
  return (process.env["NO_COLOR"] ?? "") !== "";
}

function ok(line: string): void {
  const GREEN = noColor() ? "" : "\x1b[0;32m";
  const NC = noColor() ? "" : "\x1b[0m";
  process.stdout.write(`${GREEN}[roll]${NC} ${line}\n`);
}

function err(line: string): void {
  const RED = noColor() ? "" : "\x1b[0;31m";
  const NC = noColor() ? "" : "\x1b[0m";
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}

/** Render a resolved key's source as bash's facades do: "from <file>|default". */
function fromSource(source: string): string {
  return source !== "default" ? `from ${source}` : "from default";
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// ─── facades ────────────────────────────────────────────────────────────────

/** `config loop-window [<start>-<end>]` — mirrors _config_loop_window. */
function loopWindow(value: string, scope: Scope): number {
  if (value === "") {
    const [vs, s1] = configResolve("loop_active_start") ?? ["", "default"];
    const [ve] = configResolve("loop_active_end") ?? ["", "default"];
    process.stdout.write(`loop-window: ${vs}-${ve} (${fromSource(s1)})\n`);
    return 0;
  }
  if (!/^[0-9]+-[0-9]+$/.test(value)) {
    err(`config: loop-window expects <start>-<end>, got '${value}'`);
    err(`config：loop-window 需要 <start>-<end> 格式，收到 '${value}'`);
    return 2;
  }
  const start = Number(value.slice(0, value.indexOf("-")));
  const end = Number(value.slice(value.indexOf("-") + 1));
  if (start < 0 || start > 24) {
    err("config: loop-window start must be in [0,24]");
    err("config：loop-window 开始时间必须在 [0,24]");
    return 2;
  }
  if (end > 24) {
    err("config: loop-window end must be <= 24");
    err("config：loop-window 结束时间必须 ≤ 24");
    return 2;
  }
  if (start >= end) {
    err(`config: loop-window start must be < end (got ${start}-${end})`);
    err(`config：loop-window 开始时间必须 < 结束时间（收到 ${start}-${end}）`);
    return 2;
  }
  const file = configKeyFile(scope);
  configSet("loop_active_start", String(start), file);
  configSet("loop_active_end", String(end), file);
  ok(`✓ set loop-window = ${start}-${end} in ${file}`);
  process.stdout.write("run `roll loop on` to apply\n");
  return 0;
}

/** `config loop-schedule [<period>[/<offset>]]` — mirrors _config_loop_schedule. */
function loopSchedule(value: string, scope: Scope): number {
  if (value === "") {
    const [vp, sp] = configResolve("loop_schedule.period_minutes") ?? ["", "default"];
    const [vo] = configResolve("loop_schedule.offset_minute") ?? ["", "default"];
    process.stdout.write(`loop-schedule: every ${vp}min (offset :${vo}) (${fromSource(sp)})\n`);
    return 0;
  }
  if (!/^[0-9]+(\/[0-9]+)?$/.test(value)) {
    err(`config: loop-schedule expects <period>[/<offset>], got '${value}'`);
    err(`config：loop-schedule 需要 <period>[/<offset>] 格式，收到 '${value}'`);
    return 2;
  }
  const period = Number(value.includes("/") ? value.slice(0, value.indexOf("/")) : value);
  const offset = value.includes("/") ? value.slice(value.indexOf("/") + 1) : "";
  if (period < 1 || period > 1440) {
    err("config: loop-schedule period must be in [1,1440]");
    err("config：loop-schedule 周期必须在 [1,1440]");
    return 2;
  }
  if (offset !== "" && Number(offset) > period - 1) {
    err(`config: loop-schedule offset must be in [0, period-1] (period ${period})`);
    err(`config：loop-schedule 偏移必须在 [0, period-1]（周期 ${period}）`);
    return 2;
  }
  const file = configKeyFile(scope);
  configSet("loop_schedule.period_minutes", String(period), file);
  if (offset !== "") {
    configSet("loop_schedule.offset_minute", String(Number(offset)), file);
    ok(`✓ set loop-schedule = ${period}/${Number(offset)} in ${file}`);
  } else {
    ok(`✓ set loop-schedule = ${period} in ${file}`);
  }
  process.stdout.write("run `roll loop on` to apply\n");
  return 0;
}

/** `config dream-time [<HH:MM>]` — mirrors _config_daily_time "dream". */
function dreamTime(value: string, scope: Scope): number {
  const svc = "dream";
  const hourKey = `loop_${svc}_hour`;
  const minKey = `loop_${svc}_minute`;
  if (value === "") {
    const [vh, sh] = configResolve(hourKey) ?? ["", "default"];
    let [vm] = configResolve(minKey) ?? ["", "default"];
    if (vm === "-" || vm === "") vm = "0";
    process.stdout.write(`${svc}-time: ${pad2(Number(vh))}:${pad2(Number(vm))} (${fromSource(sh)})\n`);
    return 0;
  }
  if (!/^[0-9]{1,2}:[0-9]{1,2}$/.test(value)) {
    err(`config: ${svc}-time expects <HH:MM>, got '${value}'`);
    err(`config：${svc}-time 需要 <HH:MM> 格式，收到 '${value}'`);
    return 2;
  }
  const hh = Number(value.slice(0, value.indexOf(":")));
  const mm = Number(value.slice(value.indexOf(":") + 1));
  if (hh < 0 || hh > 23) {
    err(`config: ${svc}-time hour must be in [0,23]`);
    err(`config：${svc}-time 小时必须在 [0,23]`);
    return 2;
  }
  if (mm < 0 || mm > 59) {
    err(`config: ${svc}-time minute must be in [0,59]`);
    err(`config：${svc}-time 分钟必须在 [0,59]`);
    return 2;
  }
  const file = configKeyFile(scope);
  configSet(hourKey, String(hh), file);
  configSet(minKey, String(mm), file);
  ok(`✓ set ${svc}-time = ${pad2(hh)}:${pad2(mm)} in ${file}`);
  process.stdout.write("run `roll loop on` to apply\n");
  return 0;
}

// ─── lang facade (REFACTOR-049) ───────────────────────────────────────────

/** `config lang [zh|en|--reset]` — the lang command merged into config. */
function configLangSub(value: string, _scope: Scope): number {
  if (value === "") {
    const current = resolveCurrent();
    const src = resolveSource();
    process.stdout.write(`lang: ${current} (source: ${src})\n`);
    return 0;
  }
  if (value === "zh" || value === "en") {
    writeLang(value);
    ok(`✓ set lang = ${value}`);
    return 0;
  }
  if (value === "--reset") {
    clearLang();
    ok("✓ language preference cleared (will follow locale)");
    return 0;
  }
  if (resolveCurrent() === "zh") {
    err(`config lang: 未知语言 '${value}'`);
    process.stdout.write("  可选值: zh, en, --reset\n");
  } else {
    err(`config lang: unknown language '${value}'`);
    process.stdout.write("  Valid values: zh, en, --reset\n");
  }
  return 2;
}

// ─── command ──────────────────────────────────────────────────────────────────

/**
 * The full `roll config` handler. Parsing mirrors cmd_config exactly:
 * help token → help; flags --list/--global/--project anywhere; the first two
 * bare args are key then value; a third bare arg is an error. Facades and the
 * read surface dispatch on the parsed key.
 *
 * REFACTOR-049 addition: `config lang <zh|en|--reset>` is a compact facade
 * like loop-window/loop-schedule/dream-time — it translates into the
 * lang.ts write/clear/read surface without needing a separate config key.
 */
export function configCommand(args: string[]): number {
  let key = "";
  let value = "";
  let scope: Scope | "" = "";
  let sawValue = false;
  for (const a of args) {
    if (a === "--help" || a === "-h" || a === "help") return configGetCommand(args);
    if (a === "--list") continue; // delegated to the read surface below
    if (a === "--global") {
      scope = "global";
      continue;
    }
    if (a === "--project") {
      scope = "project";
      continue;
    }
    if (key === "") {
      key = a;
    } else if (!sawValue) {
      value = a;
      sawValue = true;
    } else {
      err(`config: unexpected argument '${a}'`);
      err(`config：多余参数 '${a}'`);
      return 2;
    }
  }

  // REFACTOR-049: `config lang` is a compact facade — it writes/reads the
  // global ~/.roll/config.yaml `lang:` line, not a standard config key.
  if (key === "lang") return configLangSub(value, scope === "" ? "global" : scope);

  // Compact facades (US-LOOP-034/035): translate one token into key writes.
  // loop-* default to project scope; dream-time defaults to global.
  if (CONFIG_FACADE_KEYS.includes(key)) {
    if (key === "loop-window") return loopWindow(value, scope === "" ? "project" : scope);
    if (key === "loop-schedule") return loopSchedule(value, scope === "" ? "project" : scope);
    return dreamTime(value, scope === "" ? "global" : scope);
  }

  // --list / empty-key help / single-key read / unknown-key read all live in
  // the already-ported read surface. Anything without a value routes there.
  const wantsList = args.includes("--list");
  if (wantsList || !sawValue) return configGetCommand(args);

  // Write mode: unknown-key guard, then integer-range validation, then write.
  if (!CONFIG_KEYS.some((r) => r.key === key)) {
    err(`config: unknown key '${key}'`);
    err(`config：未知 key '${key}'`);
    err("Try: roll config --list");
    return 2;
  }
  const v = configValidate(key, value);
  if (!v.ok) {
    for (const line of v.lines) err(line);
    return 2;
  }
  const sc: Scope = scope === "" ? "project" : scope;
  const file = configKeyFile(sc);
  configSet(key, value, file);
  ok(`✓ set ${key} = ${value} in ${file}`);
  return 0;
}
