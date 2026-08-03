/**
 * `roll config` — full command surface, TS-native (US-PORT-006).
 *
 * The READ surface (help / --list / key read) was ported first (US-CLI-003,
 * config-get.ts) and is reused verbatim here. This module adds the WRITE
 * surface and the dream-time compact facade, so the entire `config` command is now TS — the bash fallback in
 * the router is retired (整个 config 命令收口).
 *
 * REFACTOR-049: the `config lang` sub-command subsumes the former top-level
 * `roll lang` command. `roll lang` is removed from the command registry; the
 * lang surface now lives exclusively under `roll config lang <zh|en|--reset>`.
 *
 * ─── v2 oracle ──────────────────────────────────────────────────────────────
 *   cmd_config (bin/roll 6085-6181), _config_daily_time (6021). Validation /
 *   yaml writing / scope→file
 *   live in @roll/infra (configValidate / configSet / configKeyFile).
 *
 * FIX-1506 retires the scheduler-only loop-window and loop-schedule facades and
 * their raw keys. They must reject before config file selection or mutation.
 */
import { CONFIG_KEYS, configKeyFile, configResolve, configSet, configValidate } from "@roll/infra";
import { INACTIVE_KEYS } from "./config-get.js";
/**
 * The "this key does nothing" note, in ONE language.
 *
 * codex r12: my first version printed EN and ZH back to back, which breaks the
 * project's single-language rule for user-facing output (the language-surface test
 * asserts `expectNoAdjacentBilingualPairs`). Bilingual means both wordings exist,
 * not that both are shown.
 */
function inactiveNote(en: string, zh: string): void {
  // Deliberately English, and NOT locale-selected (codex raised this in r13 and r18).
  //
  // The `ok("✓ set …")` line this annotates is English-only hardcoded, in all six
  // places. Making the note Chinese under a zh locale therefore produces "English
  // success line + Chinese note" — adjacent bilingual output, the exact rule this was
  // meant to respect. Keeping it English makes the command's output CONSISTENTLY
  // English for a zh user: not localised, but not lying and not mixed.
  //
  // The real fix is to localise `ok()` itself along with the frozen values that
  // capture it, which is wider than a docs card. Tracked as FIX-1485 item 5.
  void zh;
  void resolveCurrent;
  process.stdout.write(`${en}\n`);
}

import { clearLang, resolveCurrent, resolveSource, writeLang } from "./lang.js";
import { CONFIG_FACADE_KEYS, configGetCommand } from "./config-get.js";

type Scope = "project" | "global";

const RETIRED_CONFIG_KEYS = new Set([
  "loop-window",
  "loop-schedule",
  "loop_active_start",
  "loop_active_end",
  "loop_schedule.period_minutes",
  "loop_schedule.offset_minute",
]);

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

function retiredConfig(key: string): number {
  err(`config: '${key}' is retired; run 'roll loop go' when needed`);
  err(`config：'${key}' 已退役；需要时请运行 'roll loop go'`);
  return 2;
}

/** Render a resolved key's source as a facade does: "from <file>|default". */
function fromSource(source: string): string {
  return source !== "default" ? `from ${source}` : "from default";
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// ─── facades ────────────────────────────────────────────────────────────────

/** `config dream-time [<HH:MM>]` — mirrors _config_daily_time "dream". */
function dreamTime(value: string, scope: Scope): number {
  const svc = "dream";
  const hourKey = `loop_${svc}_hour`;
  const minKey = `loop_${svc}_minute`;
  if (value === "") {
    const [vh, sh] = configResolve(hourKey) ?? ["", "default"];
    let [vm] = configResolve(minKey) ?? ["", "default"];
    if (vm === "-" || vm === "") vm = "0";
    process.stdout.write(`${svc}-time: ${pad2(Number(vh))}:${pad2(Number(vm))} (${fromSource(sh)}) — inactive, nothing reads this\n`);
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
  inactiveNote(
    `note: nothing reads this — run \`roll ${svc} run-once\` when you want a scan`,
    `说明:这个值没人读 —— 想扫就跑 \`roll ${svc} run-once\``,
  );
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
 * like dream-time — it translates into the
 * lang.ts write/clear/read surface without needing a separate config key.
 */
export function configCommand(args: string[]): number {
  let key = "";
  let value = "";
  let scope: Scope | "" = "";
  let sawValue = false;
  let extraArgument = "";
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
    } else if (extraArgument === "") extraArgument = a;
  }

  if (RETIRED_CONFIG_KEYS.has(key)) return retiredConfig(key);
  if (extraArgument !== "") {
    err(`config: unexpected argument '${extraArgument}'`);
    err(`config：多余参数 '${extraArgument}'`);
    return 2;
  }

  // REFACTOR-049: `config lang` is a compact facade — it writes/reads the
  // global ~/.roll/config.yaml `lang:` line, not a standard config key.
  if (key === "lang") return configLangSub(value, scope === "" ? "global" : scope);

  // dream-time defaults to global scope.
  if (CONFIG_FACADE_KEYS.includes(key)) {
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
  // The remaining inactive dream keys must disclose that nothing reads them on
  // both raw and facade write paths.
  if (INACTIVE_KEYS.has(key)) {
    inactiveNote("note: this key is inactive — nothing reads it", "说明:这个 key 已失效 —— 没有任何东西读它");
  }
  return 0;
}
