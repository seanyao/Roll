/**
 * `roll agent list` — TS port of bin/roll cmd_agent `list)` arm (US-CLI-002).
 * Lists the known agent registry with installed/current markers, byte-aligned
 * with the bash oracle (colors honor NO_COLOR exactly like bin/roll does).
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  AGENT_REGISTRY_NAMES,
  agentDisplayName,
  agentInstalledByName as coreAgentInstalledByName,
  canonicalAgentName,
  normalizeAgentScopeConfig,
  readAgentDisabledFromText,
  type AgentEnv,
} from "@roll/core";
import { resolveLang, t, v2Catalog, type AgentName, type Lang } from "@roll/spec";

// ── i18n (mirrors bash msg/_i18n_resolve_lang inputs) ───────────────────────
function configLang(): string | undefined {
  const rollHome = process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  const cfg = join(rollHome, "config.yaml");
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

export function currentLang(): Lang {
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

/** Real-filesystem {@link AgentEnv} for core registry probes
 *  (`firstInstalledAgent` / core `agentInstalledByName`). */
export function realAgentEnv(): AgentEnv {
  return {
    home: homedir(),
    commandOnPath,
    dirExists: (p) => existsSync(p),
    fileExecutable: (p) => {
      try {
        accessSync(p, constants.X_OK);
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
  };
}

function commandOnPath(bin: string): boolean {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const p = join(dir, bin);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

export function agentInstalledByName(agent: string): boolean {
  return coreAgentInstalledByName(realAgentEnv(), agent);
}

function scopedSuperviseAgent(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  if (!text.includes("roll-agents/v1")) return undefined;
  const parsed = normalizeAgentScopeConfig(text);
  if (parsed.config === null || parsed.errors.length > 0) return undefined;
  const binding = parsed.config.roles.supervise;
  if (binding === undefined) return undefined;
  if (binding.kind === "fixed") return binding.agent;
  if (binding.kind === "select") return binding.from?.[0] ?? Object.keys(parsed.config.agents)[0];
  return undefined;
}

/** Current marker: scoped supervise role → built-in display default. */
export function projectAgent(): string {
  const rollHome = process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  const fromProjectScope = scopedSuperviseAgent(".roll/agents.yaml");
  if (fromProjectScope !== undefined) return fromProjectScope;
  const fromMachineScope = scopedSuperviseAgent(join(rollHome, "agents.yaml"));
  if (fromMachineScope !== undefined) return fromMachineScope;
  return "claude";
}

/** Machine capability view; never consults repository-local casting policy. */
export function machineAgent(): string {
  const rollHome = process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  return scopedSuperviseAgent(join(rollHome, "agents.yaml")) ?? "claude";
}

// ── Entry ────────────────────────────────────────────────────────────────────
export const AGENT_ORDER = AGENT_REGISTRY_NAMES;

export function agentListCommand(_args: string[]): number {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  const GREEN = noColor ? "" : "\x1b[0;32m";
  const YELLOW = noColor ? "" : "\x1b[0;33m";
  const RED = noColor ? "" : "\x1b[0;31m";
  const NC = noColor ? "" : "\x1b[0m";
  const lang = currentLang();

  // US-WS-017a — list is a machine capability view, independent of cwd.
  const rollHome = process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  const machineDisabled = new Set<string>();
  try {
    const machineText = readFileSync(join(rollHome, "agents.yaml"), "utf8");
    if (machineText.includes("roll-agents/v1")) {
      for (const a of AGENT_REGISTRY_NAMES) {
        if (readAgentDisabledFromText(machineText, a as AgentName).disabled) {
          machineDisabled.add(a);
        }
      }
    }
  } catch { /* file missing is fine */ }
  const out: string[] = [];
  out.push("", `  ${t(v2Catalog, lang, "agent.available_agents")}`, "");
  const current = canonicalAgentName(machineAgent());
  for (const a of AGENT_ORDER) {
    const disp = agentDisplayName(a);
    const disabledSource = machineDisabled.has(a) ? "machine" : null;
    if (agentInstalledByName(a)) {
      const currentTag = a === current ? "  (current)" : "";
      if (disabledSource !== null) {
        out.push(`    ${RED}⊘ ${disp}${NC}  (disabled · ${disabledSource})${currentTag}`);
      } else {
        out.push(
          a === current
            ? `    ${GREEN}✓ ${disp}${NC}  (current)`
            : `    ${GREEN}✓ ${disp}${NC}`,
        );
      }
    } else {
      out.push(`    ${YELLOW}✗ ${disp}${NC}  (not installed)`);
    }
  }
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}
