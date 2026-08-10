/**
 * @responsibility Builds the machine-global Conventions page.
 */
/**
 * US-DOSSIER-033 — the Conventions machine-global page.
 *
 * Conventions is the rulebook every AI agent on this machine is governed by,
 * surfaced read-only behind the machine breadcrumb (`Conventions / 约定`). It
 * lists the FOUR sync targets declared in `conventions/config.yaml`
 * (`sync_claude` / `sync_kimi` / `sync_codex` / `sync_agy`) and, for each target
 * agent, whether it is in-sync or stale — using the SAME `ok`/`stale` freshness
 * the agents-on-machine panel computes (AC4: one口径, no second freshness check):
 * we read the freshness straight off the {@link AgentPanelRow[]} the loop tab
 * already collects (`collectAgentPanel`), never re-probing the filesystem here.
 *
 * The rulebook itself (AGENTS.md / conventions source) is rendered read-only via
 * the SAME minimal markdown path the dossier uses (`renderMarkdown`), baked in at
 * generate time — self-contained, offline-faithful (AC5).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { yamlReadFlat } from "@roll/infra";
import { bi, canonicalAgentName } from "@roll/core";
import type { AgentPanelRow } from "./agent-panel.js";
import { machineMasthead, machinePalette, renderMdMachineShell, type ProjectRegistryEntry, type TruthConsoleBrand } from "./truth-console.js";

/** One sync target row (config key → agent → freshness). */
export interface ConventionsTarget {
  /** The config.yaml key, e.g. `sync_claude`. */
  configKey: string;
  /** Canonical agent name the key maps to, e.g. `claude`. */
  agent: string;
  /** The declared destination path (raw value from config.yaml), or "" if unset. */
  dest: string;
  /**
   * Freshness, taken verbatim from the agents-on-machine panel:
   *   - "sync"    — agent installed, all its convention files in sync;
   *   - "stale"   — agent installed but a convention file is stale/missing;
   *   - "absent"  — agent not installed on this machine (no row / not installed).
   */
  state: "sync" | "stale" | "absent";
}

export interface ConventionsVM {
  targets: ConventionsTarget[];
  /** The rendered rulebook (AGENTS.md) HTML fragment — undefined when absent. */
  rulebook?: { path: string; html: string };
}

/** The four config keys → canonical agent, in the order config.yaml declares. */
const SYNC_KEYS: ReadonlyArray<{ key: string; agent: string }> = [
  { key: "sync_claude", agent: "claude" },
  { key: "sync_kimi", agent: "kimi" },
  { key: "sync_pi", agent: "pi" },
  { key: "sync_reasonix", agent: "reasonix" },
] as const;

export interface ConventionsDeps {
  /** Read a config.yaml value by flat key (mirrors `roll config get`). */
  readConfig: (key: string) => string;
  /** The agents-on-machine rows — the SAME freshness source as the loop panel. */
  agents: AgentPanelRow[];
  /** Read a repo-relative file; undefined when absent/unreadable. */
  readDoc: (rel: string) => string | undefined;
  render: (md: string) => string;
}

/** Derive a target's freshness from the agents panel rows (one口径 with AC4). */
function freshnessFor(agent: string, agents: AgentPanelRow[]): ConventionsTarget["state"] {
  const canon = canonicalAgentName(agent);
  const row = agents.find((a) => canonicalAgentName(a.name) === canon);
  if (row === undefined || !row.installed) return "absent";
  return row.syncStale ? "stale" : "sync";
}

/** Collect the Conventions view-model (pure over the injected deps). */
export function collectConventions(deps: ConventionsDeps): ConventionsVM {
  const targets: ConventionsTarget[] = SYNC_KEYS.map(({ key, agent }) => ({
    configKey: key,
    agent,
    dest: deps.readConfig(key),
    state: freshnessFor(agent, deps.agents),
  }));
  const rule = deps.readDoc("AGENTS.md");
  return {
    targets,
    ...(rule !== undefined ? { rulebook: { path: "AGENTS.md", html: deps.render(rule) } } : {}),
  };
}

/** Default deps — config.yaml + AGENTS.md reads rooted at `cwd`; injected agents. */
export function defaultConventionsDeps(cwd: string, agents: AgentPanelRow[], render: (md: string) => string): ConventionsDeps {
  const configPath = join(cwd, "conventions", "config.yaml");
  return {
    readConfig: (key) => yamlReadFlat(configPath, key),
    agents,
    readDoc: (rel) => {
      const abs = join(cwd, rel);
      if (!existsSync(abs)) return undefined;
      try {
        return readFileSync(abs, "utf8");
      } catch {
        return undefined;
      }
    },
    render,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const AGENT_LABEL: Record<string, string> = {
  claude: "Claude Code",
  kimi: "Kimi CLI",
  pi: "pi CLI",
  reasonix: "reasonix CLI",
};

export interface RenderConventionsInput {
  brand: TruthConsoleBrand;
  vm: ConventionsVM;
  projects?: ProjectRegistryEntry[];
  currentSlug?: string;
  snapshot: { release?: { latestTag?: string } };
}

/**
 * US-DOSSIER-033 — render the Conventions machine page: the four sync targets
 * (config.yaml) with each agent's in-sync/stale freshness (the SAME ok/stale the
 * agents-on-machine panel computes), plus the rulebook (AGENTS.md) rendered
 * read-only via the SKILL.md-style markdown path. Wrapped in the shared shell.
 */
export function renderConventionsPage(input: RenderConventionsInput): string {
  const C = machinePalette();
  const MONO = C.mono;
  const { vm, brand } = input;

  const stateChip = (state: ConventionsTarget["state"]): string => {
    if (state === "sync") return `<span style="${MONO}font-size:11.5px;color:${C.green};font-weight:600;white-space:nowrap;">✓ ${bi("in sync", "已同步")}</span>`;
    if (state === "stale") return `<span style="${MONO}font-size:11.5px;color:${C.amber};font-weight:600;white-space:nowrap;">⟳ ${bi("stale", "已过期")}</span>`;
    return `<span style="${MONO}font-size:11.5px;color:${C.faint};white-space:nowrap;">— ${bi("not installed", "未安装")}</span>`;
  };

  const targetRows = vm.targets
    .map(
      (t) =>
        `<div data-target="${esc(t.agent)}" data-state="${t.state}" style="display:grid;grid-template-columns:180px 1fr 150px;gap:14px;align-items:center;padding:11px 18px;border-bottom:1px solid ${C.hair};">` +
        `<span style="display:flex;align-items:center;gap:9px;min-width:0;">` +
        `<span style="width:8px;height:8px;border-radius:50%;flex:none;background:${t.state === "sync" ? C.green : t.state === "stale" ? C.amber : "transparent"};border:${t.state === "absent" ? `1.5px dashed ${C.faint}` : "none"};box-sizing:border-box;"></span>` +
        `<span style="font-size:13.5px;color:${C.ink};font-weight:600;white-space:nowrap;">${esc(AGENT_LABEL[t.agent] ?? t.agent)}</span></span>` +
        `<span style="${MONO}font-size:11.5px;color:${C.sub};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.configKey)} → ${esc(t.dest !== "" ? t.dest : "—")}</span>` +
        `<span style="text-align:right;">${stateChip(t.state)}</span></div>`,
    )
    .join("");

  const syncSection =
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:14px 0;box-shadow:0 1px 2px rgba(17,26,69,.04);">` +
    `<div style="display:grid;grid-template-columns:180px 1fr 150px;gap:14px;padding:9px 18px;border-bottom:1px solid ${C.line};${MONO}font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${C.faint};">` +
    `<span>${bi("agent", "agent")}</span><span>${bi("sync target", "同步目标")}</span><span style="text-align:right;">${bi("freshness", "新鲜度")}</span></div>` +
    targetRows +
    `<div style="padding:9px 18px;${MONO}font-size:10.5px;color:${C.faint};background:#fbfcfe;border-top:1px solid ${C.hair};">${bi(
      "same ok/stale yardstick as the agents-on-machine panel · source: conventions/ + AGENTS.md",
      "与机器内 agents 面板同口径的 已同步/已过期 · 来源:conventions/ + AGENTS.md",
    )}</div></section>`;

  const rulebookSection =
    vm.rulebook !== undefined
      ? `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:22px 26px;margin:14px 0;box-shadow:0 1px 2px rgba(17,26,69,.04);">` +
        `<div style="${MONO}font-size:11px;color:${C.blue};background:${C.blue}0d;border:1px solid ${C.blue}33;border-radius:6px;padding:3px 9px;display:inline-block;margin:0 0 14px;">${esc(vm.rulebook.path)}</div>` +
        `<div class="md-body">${vm.rulebook.html}</div></section>`
      : `<section style="border:1px dashed ${C.line};border-radius:12px;background:${C.card};padding:20px 22px;margin:14px 0;color:${C.faint};font-size:13px;">${bi("AGENTS.md not found.", "未找到 AGENTS.md。")}</section>`;

  const sectionLabel = (en: string, zh: string): string =>
    `<div style="display:flex;align-items:baseline;gap:12px;margin:26px 0 4px;"><span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;">${bi(en, zh)}</span><span style="flex:1;height:1px;background:#dfe4ec;"></span></div>`;

  const body =
    machineMasthead({
      kicker: bi("Machine layer · conventions", "机器层 · 约定"),
      title: bi("Conventions", "约定"),
      lede: bi(
        "The rulebook roll syncs into every AI agent on this machine, and whether each target is in sync — rendered read-only from conventions/ + AGENTS.md.",
        "roll 同步进本机每个 AI agent 的规则书，以及每个目标是否已同步——从 conventions/ + AGENTS.md 只读渲染。",
      ),
    }) +
    sectionLabel("Sync targets", "同步目标") +
    syncSection +
    sectionLabel("Rulebook", "规则书") +
    rulebookSection;

  return renderMdMachineShell({
    page: "conventions",
    titleText: "Conventions",
    brand,
    body,
    snapshot: input.snapshot,
    ...(input.projects !== undefined ? { projects: input.projects } : {}),
    ...(input.currentSlug !== undefined ? { currentSlug: input.currentSlug } : {}),
  });
}
