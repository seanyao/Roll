/**
 * `roll config` read surface — TS port of cmd_config's help/--list/key-read
 * paths (US-CLI-003). Writes and the compact facades (loop-window /
 * loop-schedule / dream-time) stay on the bash fallback via the registry
 * router until their cards come up.
 */
import { CONFIG_KEYS, yamlReadFlat, yamlReadNested } from "@roll/infra";
import { homedir } from "node:os";
import { join } from "node:path";

// The scoped-key registry is the single source of truth in @roll/infra
// (config.ts). REFACTOR: the former inline duplicate here drifted from that
// registry; importing CONFIG_KEYS keeps `roll config` and the infra config
// model in lockstep (scope / store / default) — one place to add a key.

export const CONFIG_FACADE_KEYS = ["loop-window", "loop-schedule", "dream-time"];

/**
 * Keys still stored and printed that nothing reads. Shared with the write path in
 * config.ts so the two can never disagree about which keys are dead.
 */
export const INACTIVE_KEYS = new Set([
  "loop_active_start",
  "loop_active_end",
  "loop_schedule.period_minutes",
  "loop_schedule.offset_minute",
  "loop_dream_hour",
  "loop_dream_minute",
]);

const HELP = `Usage: roll config <key>                 print current value + source
       roll config --list                list all loop/dream config keys
       roll config <key> <value> [--global|--project]   set a value
                                                                  统一调度配置
Read / list / set loop and dream config keys without hand-editing yaml.
Default write scope is --project (.roll/local.yaml); --global writes
~/.roll/config.yaml. The window/period/time keys below are INACTIVE — they are
still stored and printed, but nothing reads them.
读 / 列 / 写 loop、dream 配置 key，免去手工编辑 yaml。默认写 --project
（.roll/local.yaml）；--global 写 ~/.roll/config.yaml。下面的窗口/周期/时刻 key
都已**失效**：仍然会存、会打印，但没有任何东西读它们。

Supported keys (range):
  loop_active_start              0-23    (inactive) stored hour, unread
  loop_active_end                1-24    (inactive) stored hour, unread
  loop_schedule.period_minutes   1-1440  (inactive) stored minutes, unread
  loop_schedule.offset_minute    0-59    (inactive) stored offset, unread
  loop_dream_hour                0-23    (inactive) stored hour, unread
  loop_dream_minute              0-59    (inactive) stored minute, unread

Compact facades (write multiple keys at once):
  roll config loop-window 9-18              loop_active_start + loop_active_end
  roll config loop-schedule 30/7            period_minutes + offset_minute
  roll config dream-time 03:20              loop_dream_hour + loop_dream_minute
  (these three write values nothing reads — delivery is driven by "roll loop go"
   in a session you open, and a scan by "roll dream run-once")

Language (REFACTOR-049: roll lang → roll config lang):
  roll config lang                          show current language + source
  roll config lang zh                       set language to zh
  roll config lang en                       set language to en
  roll config lang --reset                  clear preference (follow locale)

Examples:
  roll config loop_dream_hour
  roll config --list
  roll config loop_schedule.period_minutes 30
  roll config loop_dream_hour 3 --global
  roll config dream-time 03:20
`;

function rollConfigPath(): string {
  const rollHome = process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  return join(rollHome, "config.yaml");
}

function keyFile(scope: "project" | "global"): string {
  return scope === "global" ? rollConfigPath() : ".roll/local.yaml";
}

// yamlReadNested / yamlReadFlat are the canonical _yaml_read_nested ports —
// MOVED to @roll/infra (US-INFRA-001) and imported above so the cli read
// surface and the infra config module share one byte-faithful implementation.

/** Mirrors _config_resolve: returns [value, source]. */
function configResolve(key: string): [string, string] | null {
  const record = CONFIG_KEYS.find((r) => r.key === key);
  if (record === undefined) return null;
  const { scope, store, default: def } = record;
  const file = keyFile(scope);
  let val: string;
  if (store.startsWith("nested:")) {
    const parent = store.slice("nested:".length);
    const child = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
    val = yamlReadNested(file, parent, child);
  } else {
    val = yamlReadFlat(file, key);
  }
  return val !== "" ? [val, file] : [def, "default"];
}

function err(line: string): void {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  const RED = noColor ? "" : "\x1b[0;31m";
  const NC = noColor ? "" : "\x1b[0m";
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}

const padEndW = (s: string, w: number): string => (s.length >= w ? s : s + " ".repeat(w - s.length));

/**
 * Read-surface handler. The registry router guarantees we only see:
 * help / --list / single known-or-unknown key without a value.
 */
export function configGetCommand(args: string[]): number {
  let key = "";
  let wantList = false;
  for (const a of args) {
    if (a === "--help" || a === "-h" || a === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (a === "--list") {
      wantList = true;
      continue;
    }
    if (a === "--global" || a === "--project") continue; // scope is write-only
    if (key === "") key = a;
  }

  if (wantList) {
    const out: string[] = [];
    for (const { key: k } of CONFIG_KEYS) {
      const resolved = configResolve(k);
      if (resolved === null) continue;
      const [v, src] = resolved;
      // codex r10: --list is the THIRD read path. Marking it here too means all
      // three (single read, --list, write) agree; a row without the marker is a key
      // something actually reads.
      const dead = INACTIVE_KEYS.has(k) ? "  [inactive]" : "";
      out.push(`  ${padEndW(k, 30)} = ${padEndW(v, 8)} (${src})${dead}`);
    }
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  }

  if (key === "") {
    process.stdout.write(HELP);
    return 0;
  }

  const resolved = configResolve(key);
  if (resolved === null) {
    err(`config: unknown key '${key}'`);
    err(`config：未知 key '${key}'`);
    err("Try: roll config --list");
    return 2;
  }
  const [v, src] = resolved;
  process.stdout.write(`${key} = ${v}  (from ${src})\n`);
  // codex r9: a raw READ of a dead key printed a bare value, reading as effective.
  // Writes already disclosed it; both directions must.
  if (INACTIVE_KEYS.has(key)) {
    process.stdout.write("note: this key is inactive — nothing reads it\n");
  }
  return 0;
}
