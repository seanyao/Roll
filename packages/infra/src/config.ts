/**
 * Config module — TS port of the v2 config read surface (US-INFRA-001).
 *
 * ─── v2 oracle (frozen bash, bin/roll) ──────────────────────────────────────
 *   - `config_get()`            bin/roll 794-818  — the generic key reader.
 *   - `_yaml_read_nested()`     bin/roll 778-792  — awk block reader for one
 *                               indent level under a `parent:` block.
 *   - `_config_resolve()`       bin/roll 5793-5816 — the scoped registry reader
 *                               (project|global, source-tracked) that backs
 *                               `roll config`. Already ported in cli's
 *                               config-get.ts; the helpers it depends on
 *                               (yamlReadNested/yamlReadFlat) are MOVED here and
 *                               re-exported from cli (this card's mandate).
 *   - env / layer setup         bin/roll 8-9 (`ROLL_HOME`, `ROLL_CONFIG`),
 *                               4477/4485 (`.roll/local.yaml` + legacy
 *                               `.roll.yaml`).
 *
 * ─── Two distinct readers, mirrored faithfully ──────────────────────────────
 * v2 has TWO read paths and they are NOT the same; do not unify them:
 *
 *   1. `config_get key [default]` (the generic reader, {@link configGet}):
 *        - reads ONE file only — the GLOBAL `$ROLL_CONFIG`
 *          (`$ROLL_HOME/config.yaml`, default `~/.roll/config.yaml`).
 *        - `key` containing a `.` is split into `parent.child` and read via
 *          `_yaml_read_nested`; otherwise a flat `grep -E "^${key}:"` first-hit.
 *        - the resolved value (or the default) is run through leading-only
 *          tilde expansion `${val/#\~/$HOME}` — ONLY a `~` in column 0 expands.
 *        - NEVER consults `.roll/local.yaml` or `.roll.yaml`. (Those are read by
 *          purpose-built resolvers: `_project_agent` 4480, `_config_resolve`
 *          5793, isolation 6554 — each keyed to a specific key, not generic.)
 *
 *   2. `_config_resolve key` (the scoped registry reader, {@link configResolve}):
 *        - looks the key up in a fixed registry; project keys read
 *          `.roll/local.yaml`, global keys read `$ROLL_CONFIG`.
 *        - returns [value, source] where source is the file path or "default".
 *        - NO tilde expansion (the registry only holds integers).
 *      The cli port (config-get.ts) owns the registry + handler; here we expose
 *      only the yaml field extractors it shares with {@link configGet}.
 *
 * ─── Documented precedence (AGENTS layered contract) ────────────────────────
 * The project contract is CLI > env > file > default. v2's *generic* reader
 * (`config_get`) only implements the file→default tail of that chain (env vars
 * like ROLL_HOME relocate the file; ROLL_LANG precedence lives in
 * @roll/spec i18n, out of scope here). {@link resolveConfig} makes the full
 * CLI > env > file > default chain explicit for v3 callers that want it,
 * without changing what bare `configGet` observes — `configGet` IS the
 * file→default layer, byte-for-byte.
 *
 * ─── Lib choice ─────────────────────────────────────────────────────────────
 * NO yaml parser dependency. v2 reads yaml with awk/grep/sed line surgery, not
 * a real parser, so a structural parser (js-yaml) would DISTORT observable
 * behavior (it would, e.g., honor block scalars, anchors, quoting, multi-line
 * values that the bash line-readers ignore). We reproduce the exact line
 * semantics with regex. Zero runtime deps. (Divergence from any "use a yaml
 * lib" suggestion is deliberate — behavioral fidelity outranks it.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Leading-only tilde expansion — mirrors bash `${val/#\~/$HOME}`.
 * Only a `~` at position 0 is replaced with `$HOME`; a `~` anywhere else is
 * left untouched. Empty string stays empty.
 */
export function expandLeadingTilde(val: string, home: string = homedir()): string {
  return val.startsWith("~") ? home + val.slice(1) : val;
}

/**
 * The global config file path — mirrors bin/roll 8-9:
 *   `ROLL_HOME="${ROLL_HOME:-${HOME}/.roll}"; ROLL_CONFIG="${ROLL_HOME}/config.yaml"`.
 * Reads `process.env` live so tests can relocate HOME / ROLL_HOME.
 */
export function rollConfigPath(): string {
  const rollHome = process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  return join(rollHome, "config.yaml");
}

/**
 * Mirrors `_yaml_read_nested file parent child` (bin/roll 778-792).
 *
 * awk semantics reproduced exactly:
 *   - scan lines; once a line matches `^${parent}:`, enter the block (`found`).
 *     Note: the bash `next` means the parent line itself is never tested as a
 *     child, and a line equal to the parent marker re-arms nothing.
 *   - inside the block, the FIRST line starting with a non-whitespace char
 *     (`^[^[:space:]]`) ends the block → return "" (dedent = block over).
 *   - the first line matching `^[[:space:]]+${child}:` yields its value:
 *       strip `^\s*<anychars-up-to-colon>:\s*`, then trailing ` #...` comment,
 *       then trailing whitespace.
 *   - missing file → "" (bash `[[ -f ]] || return 0` prints nothing).
 *
 * `parent`/`child` are anchored with `^...:` exactly as the awk `-v` patterns;
 * they are treated as regex fragments verbatim (the v2 awk does the same — it
 * never escapes them), so the registry's plain identifiers behave identically.
 */
export function yamlReadNested(file: string, parent: string, child: string): string {
  if (!existsSync(file)) return "";
  const parentRe = new RegExp(`^${parent}:`);
  const childRe = new RegExp(`^[ \\t]+${child}:`);
  let found = false;
  // Match awk record-splitting: trailing newline yields no extra empty record.
  const text = readFileSync(file, "utf8");
  const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
  for (const line of lines) {
    if (!found) {
      if (parentRe.test(line)) found = true;
      continue; // bash `next` — never test the parent line as a child
    }
    if (/^[^ \t]/.test(line)) return ""; // dedent ends the block
    if (childRe.test(line)) {
      return line
        .replace(/^[ \t]*[^:]*:[ \t]*/, "")
        .replace(/[ \t]*#.*$/, "")
        .replace(/[ \t]*$/, "");
    }
  }
  return "";
}

/**
 * Mirrors the flat branch of `config_get` / `_config_resolve`:
 *   grep -E "^KEY:" file, take head -1, then three sed strips: the label
 *   `^[^:]*:[[:space:]]*`, a trailing comment `[[:space:]]*#.*$`, and trailing
 *   whitespace `[[:space:]]*$`.
 *
 * The first line whose start matches `^${key}:` wins; the label
 * (`<anything>:` plus following whitespace), then a trailing comment, then
 * trailing whitespace are stripped. Missing file → "".
 *
 * FIDELITY NOTE on `key`: v2 interpolates `key` straight into `grep -E` WITHOUT
 * escaping, so a `.` in a flat key acts as a regex wildcard in bash. In v2 this
 * never bites because dotted keys are routed to the nested reader before
 * reaching here. To match that exact reachable behavior we anchor `^${key}:`
 * with `key` as a literal (the callers only pass dot-free identifiers to the
 * flat path); dotted keys go through {@link yamlReadNested}. This preserves
 * every observable v2 outcome while avoiding an unreachable wildcard footgun.
 */
export function yamlReadFlat(file: string, key: string): string {
  if (!existsSync(file)) return "";
  const re = new RegExp(`^${escapeRegExp(key)}:`);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (re.test(line)) {
      return line
        .replace(/^[^:]*:[ \t]*/, "")
        .replace(/[ \t]*#.*$/, "")
        .replace(/[ \t]*$/, "");
    }
  }
  return "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * TS port of `config_get key [default]` (bin/roll 794-818) — the GENERIC
 * single-file reader against the global `$ROLL_CONFIG`.
 *
 * Returns the resolved value with leading-tilde expansion applied, falling back
 * to `default` (also tilde-expanded) when absent. Byte-for-byte mirror:
 *   - dotted key → split at FIRST `.` into parent/child, read nested.
 *   - flat key   → first `^key:` line in the global file.
 *   - empty resolved value → default.
 *
 * @param key      config key (`flat` or `parent.child`)
 * @param def      default echoed when unset (bash `${2:-}` → "")
 * @param configPath override of the global file (tests); defaults to
 *                   {@link rollConfigPath}
 */
export function configGet(key: string, def = "", configPath: string = rollConfigPath()): string {
  const home = homedir();
  if (key.includes(".")) {
    const dot = key.indexOf(".");
    const parent = key.slice(0, dot);
    const child = key.slice(dot + 1);
    const nval = yamlReadNested(configPath, parent, child);
    return nval !== "" ? expandLeadingTilde(nval, home) : expandLeadingTilde(def, home);
  }
  if (existsSync(configPath)) {
    const val = yamlReadFlat(configPath, key);
    if (val !== "") return expandLeadingTilde(val, home);
  }
  return expandLeadingTilde(def, home);
}

/** A registry record: `<key>|<scope>|<store>|<min>|<max>|<default>`. */
export interface ConfigKeyRecord {
  key: string;
  scope: "project" | "global";
  /** `flat` or `nested:<parent>`. */
  store: string;
  /**
   * Value domain for validation. Absent is treated as `"int"` (the v2 registry
   * held only integers, so the six ported keys keep integer semantics without an
   * explicit tag). `"string"` opts a key into the non-empty git-ref-safe string
   * validation used by {@link configValidate}.
   */
  type?: "int" | "string";
  /**
   * E3: a closed set of allowed values for a `"string"` key. When present,
   * {@link configValidate} checks membership (case-sensitive) INSTEAD of the
   * git-ref-safe charset check — the value must be exactly one of these tokens.
   * Only meaningful for string keys (e.g. `publish_mode: remote|local`).
   */
  enum?: readonly string[];
  min: string;
  max: string;
  default: string;
}

/**
 * The scoped-key registry — mirrors `_config_keys` (bin/roll 5752-5760)
 * verbatim. The cli `roll config` handler owns the user-facing surface; this
 * registry + {@link configResolve} are the shared data model so both layers
 * agree on scope/default semantics.
 */
export const CONFIG_KEYS: readonly ConfigKeyRecord[] = [
  { key: "loop_dream_hour", scope: "global", store: "flat", min: "0", max: "23", default: "3" },
  { key: "loop_dream_minute", scope: "global", store: "flat", min: "0", max: "59", default: "-" },
  // E1: the loop's integration branch — the ref cycles rebase/merge/reset onto.
  // A string key (not integer): non-empty + git-ref-safe. Default preserves the
  // historical hardcoded `origin/main`, so unset = byte-identical prior behavior.
  { key: "integration_branch", scope: "project", store: "flat", type: "string", min: "", max: "", default: "origin/main" },
  // E3: the delivery publish mode — `remote` (default: push→PR→CI→merge) or
  // `local` (land the cycle on the LOCAL integration branch, no push/PR/CI). An
  // enum string key: validation checks membership in remote|local. Default
  // `remote` keeps every existing remote delivery path byte-identical.
  { key: "publish_mode", scope: "project", store: "flat", type: "string", enum: ["remote", "local"], min: "", max: "", default: "remote" },
  // E6: the fallback target submodule for a submodule-superproject story that
  // neither declares `target-submodule:` / `target_submodule:` nor unambiguously
  // references exactly one submodule in its spec. A string key; default EMPTY
  // (= unset → no fallback, story routes to the superproject as today). When a
  // user sets it, it must be a git-ref-safe token (a submodule path); an empty
  // value is treated as unset by every reader, so it never trips validation.
  { key: "default_submodule", scope: "project", store: "flat", type: "string", min: "", max: "", default: "" },
];

/** Project-scope yaml file — mirrors `_config_key_file project` (5786). */
export function projectConfigPath(): string {
  return ".roll/local.yaml";
}

/** Legacy project file still read as agent-pref fallback (bin/roll 4485). */
export function legacyProjectConfigPath(): string {
  return ".roll.yaml";
}

/**
 * TS port of `_config_resolve key` (bin/roll 5793-5816). Returns
 * `[value, source]` (source = file path or "default"), or `null` for an
 * unknown key (bash `return 1`). NO tilde expansion (registry holds integers).
 *
 * @param scopedPath optional `{ project, global }` file overrides (tests).
 */
export function configResolve(
  key: string,
  scopedPath?: { project?: string; global?: string },
): [value: string, source: string] | null {
  const rec = CONFIG_KEYS.find((r) => r.key === key);
  if (rec === undefined) return null;
  const file =
    rec.scope === "global"
      ? (scopedPath?.global ?? rollConfigPath())
      : (scopedPath?.project ?? projectConfigPath());
  let val = "";
  if (rec.store.startsWith("nested:")) {
    const parent = rec.store.slice("nested:".length);
    const child = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
    val = yamlReadNested(file, parent, child);
  } else if (existsSync(file)) {
    val = yamlReadFlat(file, key);
  }
  return val !== "" ? [val, file] : [rec.default, "default"];
}

/** Source layer that produced a resolved value (for {@link resolveConfig}). */
export type ConfigLayer = "cli" | "env" | "file" | "default";

/** Inputs to the explicit layered resolver. */
export interface LayeredConfigInputs {
  /** Highest precedence: an explicit `--key value` from the command line. */
  cli?: string | undefined;
  /** Env override (e.g. a `ROLL_*` var the caller already read). */
  env?: string | undefined;
  /** File layer: the value `configGet` would return (already tilde-expanded). */
  file?: string | undefined;
  /** Last-resort default. */
  default?: string | undefined;
}

/**
 * Make the AGENTS layered precedence explicit: CLI > env > file > default.
 * A layer participates only when its value is a non-empty string (mirroring
 * bash's `[[ -n "$x" ]]` emptiness test used throughout the config paths).
 * Returns the winning value and which layer supplied it.
 *
 * This does NOT change what {@link configGet} observes — it is a composition
 * helper for v3 callers that already hold the CLI/env candidates. Feeding only
 * `{ file, default }` reduces exactly to `configGet`'s file→default tail.
 */
export function resolveConfig(inputs: LayeredConfigInputs): { value: string; layer: ConfigLayer } {
  const order: ReadonlyArray<[ConfigLayer, string | undefined]> = [
    ["cli", inputs.cli],
    ["env", inputs.env],
    ["file", inputs.file],
    ["default", inputs.default],
  ];
  for (const [layer, v] of order) {
    if (v !== undefined && v !== "") return { value: v, layer };
  }
  return { value: inputs.default ?? "", layer: "default" };
}

// ─── write surface (US-PORT-006) ────────────────────────────────────────────
// TS ports of the cmd_config write helpers (bin/roll): `_config_key_file`
// (5781-5788), `_config_validate` (5820-5840), and `_config_set` (5846-5890).
// Kept here next to the read surface so both layers share one byte-faithful
// model; the cli handler orchestrates these into the user-facing command.

/** Scope → backing yaml file. Mirrors `_config_key_file` (bin/roll 5781). */
export function configKeyFile(scope: "project" | "global"): string {
  return scope === "global" ? rollConfigPath() : projectConfigPath();
}

/** A validation failure — the two bilingual message lines WITHOUT the `[roll]`
 *  prefix (the cli `err` helper prepends it, exactly as bash's `err` does). */
export interface ConfigValidateError {
  ok: false;
  lines: [en: string, zh: string];
}

/**
 * TS port of `_config_validate key value` (bin/roll 5820-5840): the registry
 * key must hold an integer within `[min, max]`. Returns `{ ok: true }` or the
 * two bilingual error lines (caller prints to stderr and exits 2). An unknown
 * key yields `{ ok: false }` with empty lines — but the write path validates
 * only AFTER the unknown-key guard, so that branch is unreachable in practice
 * (kept total for safety, mirroring bash `return 1`).
 */
export function configValidate(key: string, value: string): { ok: true } | ConfigValidateError {
  const rec = CONFIG_KEYS.find((r) => r.key === key);
  if (rec === undefined) return { ok: false, lines: ["", ""] };
  // String keys (E1: integration_branch) validate as a non-empty, git-ref-safe
  // token instead of an integer range. Safe charset mirrors the characters a git
  // ref/refspec legitimately uses (`^[A-Za-z0-9/_.-]+$`) — this both rejects
  // empties and blocks shell-injection into the `git` argv the ref feeds.
  if (rec.type === "string") {
    // E3: an enum string key validates membership in its closed value set
    // (case-sensitive), INSTEAD of the empty/git-ref-safe checks. An empty
    // value is simply "not a member", so it is rejected by this branch too.
    if (rec.enum !== undefined) {
      if (rec.enum.includes(value)) return { ok: true };
      const allowed = rec.enum.join("|");
      return {
        ok: false,
        lines: [
          `config: '${key}' must be one of ${allowed}, got '${value}'`,
          `config：'${key}' 取值须为 ${allowed}，收到 '${value}'`,
        ],
      };
    }
    if (value === "") {
      return {
        ok: false,
        lines: [
          `config: '${key}' must not be empty`,
          `config：'${key}' 不能为空`,
        ],
      };
    }
    if (!/^[A-Za-z0-9/_.-]+$/.test(value)) {
      return {
        ok: false,
        lines: [
          `config: '${key}' has unsafe characters, got '${value}'`,
          `config：'${key}' 含非法字符，收到 '${value}'`,
        ],
      };
    }
    return { ok: true };
  }
  if (!/^-?[0-9]+$/.test(value)) {
    return {
      ok: false,
      lines: [
        `config: '${key}' expects an integer, got '${value}'`,
        `config：'${key}' 需要整数，收到 '${value}'`,
      ],
    };
  }
  const n = Number(value);
  if (rec.min !== "" && n < Number(rec.min)) {
    return {
      ok: false,
      lines: [`config: '${key}' must be >= ${rec.min} (got ${value})`, `config：'${key}' 必须 >= ${rec.min}（收到 ${value}）`],
    };
  }
  if (rec.max !== "" && n > Number(rec.max)) {
    return {
      ok: false,
      lines: [`config: '${key}' must be <= ${rec.max} (got ${value})`, `config：'${key}' 必须 <= ${rec.max}（收到 ${value}）`],
    };
  }
  return { ok: true };
}

/** awk record semantics: a trailing `\n` yields no extra empty record. */
function configSplitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

/**
 * Pure form of `_config_set` (bin/roll 5846-5890): given the current file text,
 * return the new text with `key` set to `value`. Reproduces both awk branches
 * exactly — flat top-level keys and nested `parent.child` keys — preserving
 * every other line, comment and ordering. Output always ends in one `\n`
 * (awk emits a newline per record, including the appended one).
 *
 * Unknown key → text returned unchanged (bash `_config_key_record` `return 1`).
 */
export function applyConfigSet(text: string, key: string, value: string): string {
  const rec = CONFIG_KEYS.find((r) => r.key === key);
  if (rec === undefined) return text;
  const lines = configSplitLines(text);
  const out: string[] = [];
  let done = false;

  if (rec.store.startsWith("nested:")) {
    const parent = rec.store.slice("nested:".length);
    const child = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
    const parentRe = new RegExp(`^${parent}:`);
    const childRe = new RegExp(`^[ \\t]+${child}:`);
    let inBlock = false;
    for (const line of lines) {
      if (parentRe.test(line)) {
        inBlock = true;
        out.push(line);
        continue;
      }
      if (inBlock && childRe.test(line)) {
        out.push(`  ${child}: ${value}`);
        done = true;
        inBlock = false;
        continue;
      }
      if (inBlock && /^[^ \t]/.test(line)) {
        if (!done) {
          out.push(`  ${child}: ${value}`);
          done = true;
        }
        inBlock = false;
        out.push(line);
        continue;
      }
      out.push(line);
    }
    if (inBlock && !done) {
      out.push(`  ${child}: ${value}`);
      done = true;
    }
    if (!done) {
      out.push(`${parent}:`);
      out.push(`  ${child}: ${value}`);
    }
  } else {
    const keyRe = new RegExp(`^${escapeRegExp(key)}:`);
    for (const line of lines) {
      if (keyRe.test(line) && !done) {
        out.push(`${key}: ${value}`);
        done = true;
        continue;
      }
      out.push(line);
    }
    if (!done) out.push(`${key}: ${value}`);
  }
  return out.join("\n") + "\n";
}

/**
 * File wrapper around {@link applyConfigSet}, mirroring `_config_set`'s I/O:
 * ensure the parent dir exists, read current text (missing file → empty, as
 * bash `[[ -f ]] || : > file`), transform, write back atomically-enough for a
 * single-writer CLI (write through; bash uses mktemp+mv — equivalent here).
 */
export function configSet(key: string, value: string, file: string): void {
  if (!CONFIG_KEYS.some((record) => record.key === key)) return;
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, applyConfigSet(text, key, value));
}
