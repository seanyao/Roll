/**
 * @responsibility Runs the `roll lang` subcommand, reading and persisting the UI language setting.
 */
/**
 * `roll lang` — TS port of bin/roll cmd_lang (14334-14379).
 * No-arg: print `current: <lang>, source: <src>`. `zh`/`en`: persist
 * `lang: <v>` to ~/.roll/config.yaml (atomic temp-file swap, mirroring the
 * bash `grep -vE '^lang:' > tmp; printf >> tmp; mv tmp config` sequence).
 * `--reset`: strip the `lang:` line. Unknown arg: bilingual error + exit 1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveLang, t, v2Catalog, type Lang } from "@roll/spec";

function rollConfigPath(): string {
  const rollHome = process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  return join(rollHome, "config.yaml");
}

/** Extract `lang:` value from config.yaml (mirrors agent-list configLang). */
export function configLang(): string | undefined {
  const cfg = rollConfigPath();
  if (!existsSync(cfg)) return undefined;
  for (const line of readFileSync(cfg, "utf8").split("\n")) {
    const m = /^lang:\s*(.*)$/.exec(line);
    if (m !== null) {
      const v = (m[1] ?? "").replace(/\s*#.*$/, "").trim();
      if (v !== "") return v;
    }
  }
  return undefined;
}

/** True when config.yaml has any `^lang:` line (mirrors bash grep -qE). */
export function configHasLangLine(): boolean {
  const cfg = rollConfigPath();
  if (!existsSync(cfg)) return false;
  return readFileSync(cfg, "utf8").split("\n").some((l) => /^lang:/.test(l));
}

function appleLang(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const out = execFileSync("defaults", ["read", "-g", "AppleLanguages"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = out.split("\n").slice(0, 2);
    const second = (lines[1] ?? "").replace(/[ ",()]/g, "");
    return second !== "" ? second : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCurrent(): Lang {
  const env = process.env;
  const direct = resolveLang({
    rollLang: env["ROLL_LANG"],
    configLang: configLang(),
    lcAll: env["LC_ALL"],
    lang: env["LANG"],
  });
  if (
    (env["ROLL_LANG"] ?? "") === "" &&
    configLang() === undefined &&
    (env["LC_ALL"] ?? "") === "" &&
    (env["LANG"] ?? "") === ""
  ) {
    return resolveLang({ appleLang: appleLang() });
  }
  return direct;
}

/** Mirrors cmd_lang's source-attribution ladder verbatim. */
export function resolveSource(): string {
  const env = process.env;
  if ((env["ROLL_LANG"] ?? "") !== "") return "ROLL_LANG env";
  if (existsSync(rollConfigPath()) && configHasLangLine()) return `config (${rollConfigPath()})`;
  if ((env["LC_ALL"] ?? "") !== "" || (env["LANG"] ?? "") !== "") return "LC_ALL/LANG";
  return "default";
}

/** Lang used to render the ok/err messages themselves (bash msg resolution). */
function msgLang(): Lang {
  return resolveCurrent();
}

function ok(line: string): void {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  const GREEN = noColor ? "" : "\x1b[0;32m";
  const NC = noColor ? "" : "\x1b[0m";
  process.stdout.write(`${GREEN}[roll]${NC} ${line}\n`);
}

function err(line: string): void {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  const RED = noColor ? "" : "\x1b[0;31m";
  const NC = noColor ? "" : "\x1b[0m";
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}

/** Path to roll config.yaml. */
export function configLangPath(): string { return rollConfigPath(); }

/** Atomic: write all-but-lang lines + new lang line to a temp, then rename. */
export function writeLang(value: string): void {
  const cfg = rollConfigPath();
  mkdirSync(dirname(cfg), { recursive: true });
  const existing = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  // grep -vE '^lang:' keeps every non-lang line; bash preserves their bytes.
  const kept = existing === "" ? [] : existing.split("\n").filter((l) => !/^lang:/.test(l));
  // existing ends with "\n" → split yields a trailing "" we must drop so the
  // appended `lang:` line doesn't gain a blank line ahead of it. grep over a
  // file that ends in \n emits no trailing empty record.
  if (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const body = kept.length > 0 ? kept.join("\n") + "\n" : "";
  const tmp = join(mkdtempSync(join(tmpdir(), "roll-lang-")), "config.yaml");
  writeFileSync(tmp, `${body}lang: ${value}\n`);
  renameSync(tmp, cfg);
}

export function clearLang(): void {
  const cfg = rollConfigPath();
  if (!existsSync(cfg)) return;
  const existing = readFileSync(cfg, "utf8");
  const kept = existing.split("\n").filter((l) => !/^lang:/.test(l));
  if (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const body = kept.length > 0 ? kept.join("\n") + "\n" : "";
  const tmp = join(mkdtempSync(join(tmpdir(), "roll-lang-")), "config.yaml");
  writeFileSync(tmp, body);
  renameSync(tmp, cfg);
}

export function langCommand(args: string[]): number {
  const arg = args[0] ?? "";

  if (arg === "") {
    const current = resolveCurrent();
    const src = resolveSource();
    process.stdout.write(`current: ${current}, source: ${src}\n`);
    return 0;
  }

  if (arg === "zh" || arg === "en") {
    writeLang(arg);
    // bash unsets ROLL_LANG_RESOLVED then resolves `ok`'s message lang via the
    // normal `msg` ladder: ROLL_LANG env still outranks the just-written config
    // (so `ROLL_LANG=en roll lang zh` confirms in EN). resolveCurrent re-reads
    // config so a no-env invocation reflects the new value.
    ok(t(v2Catalog, resolveCurrent(), "lang.language_set_to", arg));
    return 0;
  }

  if (arg === "--reset") {
    clearLang();
    // config lang gone → ok message follows env/locale (resolveCurrent re-reads).
    ok(t(v2Catalog, msgLang(), "lang.language_preference_cleared_will_follow_locale"));
    return 0;
  }

  const lang = msgLang();
  err(t(v2Catalog, lang, "lang.unknown_language", arg));
  process.stdout.write(lang === "zh" ? `${t(v2Catalog, lang, "lang.options_zh_en_reset")}\n` : "  Valid values: zh, en, --reset\n");
  return 1;
}
