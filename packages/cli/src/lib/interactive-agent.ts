/**
 * Shared primitives for interactive agent launch — used by `roll init` (legacy
 * onboard), `roll design`, and `roll setup` (US-ONBOARD-NUDGE-004/006).
 *
 * Keeps agent discovery / selection / argv mapping in one place so the
 * interactive entry points do not fork their definition of "installed".
 */
import { accessSync, constants, existsSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  agentInstalledByName as coreAgentInstalledByName,
  getAgentSpec,
  type AgentEnv,
} from "@roll/core";
import { resolveLang, t, v2Catalog, v3Catalog, type Lang } from "@roll/spec";
import { realAgentEnv } from "../commands/agent-list.js";
import { onPath, rollConfig, rollPkgDir } from "../commands/setup-shared.js";

function expandHome(path: string): string {
  const home = process.env["HOME"] ?? homedir();
  return path.replace(/^~/, home);
}

export function agentEnvFromEnv(envDict: NodeJS.ProcessEnv): AgentEnv {
  const pathEnv = envDict["PATH"] ?? "";
  function commandOnPath(bin: string): boolean {
    for (const dir of pathEnv.split(delimiter)) {
      if (dir === "") continue;
      const p = join(dir, bin);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        accessSync(p, constants.X_OK);
        return true;
      } catch { /* keep scanning */ }
    }
    return false;
  }
  return {
    home: envDict["HOME"] ?? homedir(),
    commandOnPath,
    dirExists: (p: string) => existsSync(p),
    fileExecutable: (p: string) => {
      try {
        accessSync(p, constants.X_OK);
        return statSync(p).isFile();
      } catch { return false; }
    },
  };
}

/**
 * Discover interactive agents from the global `~/.roll/config.yaml` `ai_*`
 * registry, probing PATH/binary-name for known agents and dir-existence for
 * unknown/operator-added entries. Mirrors `discoverOnboardAgents` in init.ts.
 *
 * Accepts an optional `AgentEnv` so tests can inject a fabricated PATH; when
 * omitted the real process environment is probed.
 */
export function discoverInteractiveAgents(agentEnv?: AgentEnv): { installed: string[]; missing: string[] } {
  const installed: string[] = [];
  const missing: string[] = [];
  const cfg = rollConfig();
  if (!existsSync(cfg)) return { installed, missing };
  const env = agentEnv ?? realAgentEnv();
  for (const line of readFileSync(cfg, "utf8").split("\n")) {
    const match = /^(ai_[^:]+):\s*(.*)$/.exec(line);
    if (match === null) continue;
    let name = (match[1] ?? "").slice("ai_".length);
    if (name === "kimi_code") name = "kimi";
    name = getAgentSpec(name)?.name ?? name;
    const dir = expandHome(((match[2] ?? "").split("|")[0] ?? "").trim());
    const target = coreAgentInstalledByName(env, name, dir) ? installed : missing;
    if (!target.includes(name)) target.push(name);
  }
  return { installed, missing };
}

/** Read legacy `primary_agent`, or `null` if absent/empty. New writes use `~/.roll/agents.yaml`. */
export function readPrimaryAgent(): string | null {
  const cfg = rollConfig();
  if (!existsSync(cfg)) return null;
  for (const line of readFileSync(cfg, "utf8").split("\n")) {
    const m = /^primary_agent:\s*(.*)$/.exec(line);
    if (m !== null) {
      const v = (m[1] ?? "").replace(/\s*#.*$/, "").trim();
      if (v !== "") return v;
    }
  }
  return null;
}

/**
 * Read a skill markdown body from `skills/<skillName>/SKILL.md` under the
 * install tree, stripping YAML frontmatter. Returns `null` when the skill file
 * is missing (e.g. submodule not initialised).
 */
export function readSkillBody(skillName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicitRoot = env["ROLL_PKG_DIR"]?.trim();
  const packageRoot = explicitRoot === undefined || explicitRoot === "" ? rollPkgDir() : explicitRoot;
  const skillFile = join(packageRoot, "skills", skillName, "SKILL.md");
  if (!existsSync(skillFile)) return null;
  return readFileSync(skillFile, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function kimiBin(): string {
  if (onPath("kimi-code")) return "kimi-code";
  if (onPath("kimi-cli")) return "kimi-cli";
  return "kimi";
}

/**
 * Map a canonical agent name to the interactive argv used to launch it with a
 * single prompt string. Returns `null` for unknown agents.
 */
export function interactiveAgentCommand(agent: string, prompt: string): { bin: string; args: string[] } | null {
  const canonical = getAgentSpec(agent.trim().toLowerCase())?.name ?? agent;
  switch (canonical) {
    case "claude":
      return { bin: "claude", args: [prompt] };
    case "kimi":
      return { bin: kimiBin(), args: [prompt] };
    case "codex":
      return { bin: "codex", args: ["exec", prompt] };
    case "pi":
      return { bin: "pi", args: [prompt] };
    case "agy":
      return { bin: "agy", args: [prompt] };
    case "reasonix":
      return { bin: "reasonix", args: [prompt] };
    case "cursor":
      return { bin: "cursor-agent", args: [prompt] };
    default:
      return null;
  }
}

/** Read one line from fd 0; returns `null` on EOF/error. */
export function readLineFromStdin(): string | null {
  const chunks: number[] = [];
  const buf = Buffer.alloc(1);
  while (true) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch {
      return null;
    }
    if (n === 0) return chunks.length === 0 ? null : Buffer.from(chunks).toString("utf8");
    const b = buf[0] ?? 0;
    if (b === 10) break;
    if (b !== 13) chunks.push(b);
  }
  return Buffer.from(chunks).toString("utf8");
}

// ─── Initial supervise-role selection (US-ONBOARD-NUDGE-006) ─────────────────

/** Check if a legacy configured primary agent is still in the installed set. */
export function isPrimaryValid(primary: string | null, installed: string[]): boolean {
  if (primary === null || primary === "") return false;
  return installed.includes(primary);
}

function lang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

export interface PrimarySelectionOptions {
  /** Currently installed agent names (available set). */
  installed: string[];
  /** Legacy primary_agent value from config, or null if absent. */
  primary: string | null;
  /** Whether stdin is a TTY (controls interactive vs deterministic path). */
  isTTY: boolean;
  /** Explicit re-selection requested (--reselect flag). */
  reselect: boolean;
  /** Read one line callback (injected for testing). */
  readLine: () => string | null;
}

export interface PrimarySelectionResult {
  /** Agent name to persist as Machine Scope supervise role, or null if no change. */
  selected: string | null;
  /** Human-readable guidance line for the caller to emit, or null. */
  guidance: string | null;
}

/**
 * Select an initial supervise agent according to the rules in US-ONBOARD-NUDGE-006:
 *
 *   AC3: installed empty → no selection, return install guidance.
 *   AC4: valid legacy primary + not reselect → silently keep (selected=null, guidance=null).
 *   AC2: no valid legacy primary + installed exactly 1 → auto-select that one.
 *   AC1: no valid legacy primary + installed >1 + TTY → interactive prompt.
 *   AC5: no valid legacy primary + installed >1 + non-TTY → deterministic first-in-order.
 *   AC6: legacy primary points to removed agent → treated as no valid selection.
 */
export function selectPrimaryAgent(opts: PrimarySelectionOptions): PrimarySelectionResult {
  const { installed, primary, isTTY, reselect, readLine } = opts;
  const l = lang();

  // AC3: available set empty → no selection, install guidance
  if (installed.length === 0) {
    return { selected: null, guidance: t(v3Catalog, l, "setup.primary_no_agents") };
  }

  // AC4: valid primary + not reselecting → silently keep (no output per AC4)
  if (!reselect && isPrimaryValid(primary, installed)) {
    return { selected: null, guidance: null };
  }

  // AC6: primary points to removed/unsupported agent → falls through here
  // (isPrimaryValid returned false), treated as no valid primary.

  // AC2: no valid primary + available set exactly 1 → auto-set
  if (installed.length === 1) {
    const chosen = installed[0] ?? "";
    return { selected: chosen, guidance: t(v3Catalog, l, "setup.primary_auto_set", chosen) };
  }

  // AC1: no valid primary + available >1 + TTY → interactive prompt
  if (isTTY) {
    process.stderr.write(`${t(v3Catalog, l, "setup.primary_prompt")}\n`);
    installed.forEach((candidate, index) => {
      process.stderr.write(`    ${index + 1}) ${candidate}\n`);
    });
    process.stderr.write(`  Enter number [1-${installed.length}]: `);
    const choice = readLine();
    if (choice === null) {
      return { selected: null, guidance: null };
    }
    const n = Number(choice);
    if (!Number.isInteger(n) || n < 1 || n > installed.length) {
      return { selected: null, guidance: null };
    }
    return { selected: installed[n - 1] ?? null, guidance: null };
  }

  // AC5: non-TTY + no valid primary → deterministic: first installed by registry order
  return { selected: installed[0] ?? null, guidance: null };
}
