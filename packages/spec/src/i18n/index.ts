/**
 * @responsibility Re-exports the shared i18n catalogs and language resolution helpers.
 */
/**
 * Roll i18n engine — TS port of lib/i18n.sh (v2 oracle, US-SCAF-001).
 *
 * Behavioral contract (diff-tested against bash `msg`):
 *  - Locale resolution precedence: ROLL_LANG > config `lang:` > LC_ALL > LANG
 *    > macOS AppleLanguages > "en". First non-empty source wins and is
 *    classified to "zh" | "en" (anything starting with "zh" → zh, else en).
 *  - Lookup: zh requested → zh entry if present, else en entry, else the key
 *    itself (missing translations stay visible without crashing).
 *  - Templates are printf-style; catalogs only use %s / %d / %%.
 *  - Output is a single language per resolved locale — never bilingual.
 *
 * Pure module: no I/O. Callers (infra/cli) inject env + config values.
 */

export type Lang = "en" | "zh";

/** zh* → "zh", everything else → "en" (mirrors _i18n_classify). */
export function classifyLocale(raw: string): Lang {
  return raw.startsWith("zh") ? "zh" : "en";
}

export interface LangSources {
  /** ROLL_LANG environment variable. */
  rollLang?: string | undefined;
  /** `lang:` value from ~/.roll/config.yaml (already extracted). */
  configLang?: string | undefined;
  lcAll?: string | undefined;
  lang?: string | undefined;
  /** First entry of macOS AppleLanguages, when available. */
  appleLang?: string | undefined;
}

/** Mirrors _i18n_resolve_lang: first non-empty source, classified; default en. */
export function resolveLang(sources: LangSources): Lang {
  for (const v of [
    sources.rollLang,
    sources.configLang,
    sources.lcAll,
    sources.lang,
    sources.appleLang,
  ]) {
    if (v !== undefined && v !== "") return classifyLocale(v);
  }
  return "en";
}

/** A catalog entry: en is required (fallback target), zh optional. */
export interface CatalogEntry {
  en: string;
  zh?: string;
}

export type Catalog = Record<string, CatalogEntry>;

/**
 * printf-style template formatting for the subset catalogs use: %s, %d, %%.
 * Missing args render as "" (bash printf behavior); extra args are ignored
 * (deliberate divergence from printf's format-reuse — no catalog relies on it).
 */
export function formatTemplate(tmpl: string, args: ReadonlyArray<string | number>): string {
  let i = 0;
  return tmpl.replace(/%[sd%]/g, (m) => {
    if (m === "%%") return "%";
    const a = args[i++];
    if (a === undefined) return "";
    return m === "%d" ? String(Math.trunc(Number(a))) : String(a);
  });
}

/**
 * Mirrors bash `msg`: lookup with EN fallback then key itself, printf-format.
 * Note: bash appends a trailing newline (echo); emitting the newline is the
 * caller's concern in TS (console.log adds it) — diff-tests compare full lines.
 */
export function t(
  catalog: Catalog,
  lang: Lang,
  key: string,
  ...args: ReadonlyArray<string | number>
): string {
  const entry = catalog[key];
  const tmpl =
    lang === "zh" && entry?.zh !== undefined ? entry.zh : entry?.en !== undefined ? entry.en : key;
  return formatTemplate(tmpl, args);
}
