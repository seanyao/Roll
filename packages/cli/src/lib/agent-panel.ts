/**
 * @responsibility Builds the agents-on-this-machine panel view model for the loop tab.
 */
/**
 * US-DOSSIER-014 — the "agents on this machine" panel for the loop tab.
 *
 * One row per known agent: runner · version · 72h cycles & spend · availability.
 * Expanding a row shows the convention-file sync truth (✓ in sync / ⟳ stale /
 * − missing) — the SAME probes `roll status` runs — plus the copyable
 * `roll setup -f` repair command when anything is stale.
 *
 * Window note (AC3 trade-off): the cycles/spend window is FIXED at 72h and
 * labelled on the panel — linking it to the cycle ledger's range switch would
 * require re-aggregating per range client-side; the explicit label keeps the
 * number honest and matches the snapshot's cycle window.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDisplayName, agentsInstalled, canonicalAgentName } from "@roll/core";
import { realAgentEnv } from "../commands/agent-list.js";
import { aiSyncStatus, parseAiEntries, type AiEntry } from "../commands/status.js";

export interface AgentPanelFile {
  path: string;
  kind: string;
  state: "sync" | "stale" | "missing";
}

export interface AgentPanelRow {
  name: string;
  display: string;
  runner: string;
  version: string;
  installed: boolean;
  cycles72h: number;
  costUsd72h: number;
  files: AgentPanelFile[];
  /** Any convention file stale/missing → the amber "convention stale" badge. */
  syncStale: boolean;
  setupCmd?: string;
}

export interface AgentPanelDeps {
  installed: () => string[];
  versionOf: (agent: string) => string | null;
  nowSec: () => number;
  /** AI client entries (kimi pair-review: injectable so tests never read the
   *  real ~/.roll config). */
  aiEntries: () => AiEntry[];
}

const RUNNER_LABEL: Record<string, string> = {
  claude: "Claude Code",
  kimi: "Kimi CLI",
  codex: "Codex CLI",
  pi: "pi CLI",
  agy: "Antigravity CLI",
  reasonix: "reasonix CLI",
  cursor: "Cursor Agent",
};

export function agentRunnerLabelNames(): string[] {
  return Object.keys(RUNNER_LABEL);
}

export function defaultAgentPanelDeps(): AgentPanelDeps {
  return {
    installed: () => agentsInstalled(realAgentEnv()),
    versionOf: () => null, // version probing spawns; the panel stays honest with "—"
    nowSec: () => Math.floor(Date.now() / 1000),
    aiEntries: parseAiEntries,
  };
}

function spend72h(projectPath: string, nowSec: number): Map<string, { cycles: number; cost: number }> {
  const out = new Map<string, { cycles: number; cost: number }>();
  const path = join(projectPath, ".roll", "loop", "runs.jsonl");
  if (!existsSync(path)) return out;
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  const cutoff = nowSec - 72 * 3600;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rawTs = row["ts"];
    const ts =
      typeof rawTs === "string"
        ? Date.parse(rawTs) / 1000
        : typeof rawTs === "number"
          ? rawTs > 10_000_000_000
            ? rawTs / 1000
            : rawTs
          : Number.NaN;
    if (!Number.isFinite(ts) || ts < cutoff || ts > nowSec) continue;
    const agent = String(row["agent"] ?? "");
    if (agent === "") continue;
    const cost = typeof row["cost_effective_usd"] === "number" ? (row["cost_effective_usd"] as number) : typeof row["cost_usd"] === "number" ? (row["cost_usd"] as number) : 0;
    const cur = out.get(agent) ?? { cycles: 0, cost: 0 };
    cur.cycles += 1;
    cur.cost += cost;
    out.set(agent, cur);
  }
  return out;
}

export function collectAgentPanel(projectPath: string, deps: AgentPanelDeps = defaultAgentPanelDeps()): AgentPanelRow[] {
  const installed = new Set(deps.installed().map(canonicalAgentName));
  const spend = spend72h(projectPath, deps.nowSec());
  const entries = deps.aiEntries();
  const rows: AgentPanelRow[] = [];
  // Canonicalize before merging (live finding: "antigravity" config entry and
  // installed "agy" rendered as two rows of the same agent).
  const names = new Set<string>([...installed, ...entries.map((e) => canonicalAgentName(e.name))]);
  for (const name of [...names].sort()) {
    const isInstalled = installed.has(name);
    const entry = entries.find((e) => canonicalAgentName(e.name) === name);
    const files: AgentPanelFile[] = [];
    if (entry !== undefined) {
      const sync = aiSyncStatus(entry);
      files.push({
        path: join(entry.ai_dir, entry.cfg_file),
        kind: entry.cfg_file,
        state: sync === "sync" ? "sync" : sync === "missing" ? "missing" : "stale",
      });
    }
    const s = spend.get(name) ?? { cycles: 0, cost: 0 };
    const stale = files.some((f) => f.state !== "sync");
    rows.push({
      name,
      display: agentDisplayName(name),
      runner: RUNNER_LABEL[name] ?? `${agentDisplayName(name)} CLI`,
      version: deps.versionOf(name) ?? "—",
      installed: isInstalled,
      cycles72h: s.cycles,
      costUsd72h: Number(s.cost.toFixed(4)),
      files,
      syncStale: isInstalled && stale,
      ...(isInstalled && stale ? { setupCmd: "roll setup -f" } : {}),
    });
  }
  // installed first, then by 72h activity, then name.
  rows.sort((a, b) => Number(b.installed) - Number(a.installed) || b.cycles72h - a.cycles72h || a.name.localeCompare(b.name));
  return rows;
}
