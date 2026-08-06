/**
 * @responsibility Builds the machine-global Agents page.
 */
/**
 * US-DOSSIER-031 — the machine-global **Agents** page the top-bar breadcrumb
 * routes to (`agents.html`), filling the US-DOSSIER-027 stub.
 *
 * The agents inventory exists today only inside the Loop tab, scoped to a
 * single project's loop activity. This page promotes the SAME panel to a
 * first-class machine-scope destination: every installed agent on the machine —
 * its runner, version, 72h cycles + cost share, and whether its convention
 * files are actually in sync — that the loop dispatches to regardless of which
 * project you opened.
 *
 * One source of truth: the rows are rendered from `collectAgentPanel`
 * (`AgentPanelRow[]`) — the exact collector the Loop tab uses — via the SAME
 * `agentRow` renderer exported from `truth-console.ts`, so the numbers can never
 * disagree with the Loop tab. Determinism: this file holds no clock/RNG; the
 * 72h window + render-now are fixed upstream (`collectAgentPanel` /
 * `ROLL_RENDER_NOW`).
 *
 * AC3 hard rule: a not-installed / not-detected agent renders neutral gray
 * "expected" (version `—`, "not installed — nothing synced"), never a red
 * error. AC4: a `stale`/`missing` agent surfaces an amber `convention stale`
 * badge + a copyable `roll setup -f` repair chip; a fully in-sync agent
 * shows neither. Conflict isolation: the renderer lives here, in a dedicated
 * file; index-gen wires it with a one-line swap of the agents stub.
 */
import { bi } from "@roll/core";
import type { AgentPanelRow } from "./agent-panel.js";
import type { ExternalToolState } from "./external-tools.js";
import {
  agentRow,
  C,
  CONSOLE_SCRIPT,
  esc,
  FONT_LINKS,
  htmlHead,
  machineMasthead,
  MONO,
  rollScope,
  SHELL_CSS,
  topBar,
  type ProjectRegistryEntry,
  type TruthConsoleBrand,
} from "./truth-console.js";

export interface AgentsPageInput {
  brand: TruthConsoleBrand;
  /**
   * Every installed agent on this MACHINE (US-DOSSIER-031 AC2): the row set is
   * driven by installed agents, not the current project's cycle ledger — an
   * installed-but-idle agent still renders a row. Same `collectAgentPanel`
   * output behind the Loop tab → one source of truth.
   */
  agents: AgentPanelRow[];
  /** Machine-level external capture/auth requirements used by evidence flows. */
  externalTools?: ExternalToolState[];
  /** Cross-project switcher rows (read-only, US-DOSSIER-027). */
  projects?: ProjectRegistryEntry[];
  currentSlug?: string;
  /** Only the release tag is read off the snapshot (top-bar right badge). */
  snapshot: { release?: { latestTag?: string } };
}

/**
 * The `.ag-row` expand/caret/hover rules the agent rows depend on — present on
 * the console's tab CSS, but NOT in the shared SHELL_CSS — so the accordion
 * works on this standalone machine page too (AC6 row-expand interaction).
 */
const AGENTS_PAGE_CSS = `
a{color:${C.blue};}
.ag-row summary::-webkit-details-marker{display:none;}
.ag-row[open] .bl-caret{transform:rotate(90deg);}
.ag-row summary:hover{background:#fbfcfe;}
.copy-chip:hover{border-color:${C.blue};}
.tool-row{display:grid;grid-template-columns:190px 112px 1fr;gap:14px;align-items:start;padding:14px 18px;border-top:1px solid ${C.line};}
.tool-row:first-child{border-top:0;}
.tool-status{${MONO}font-size:11px;text-transform:uppercase;font-weight:700;letter-spacing:.04em;}
@media (max-width:760px){.tool-row{grid-template-columns:1fr;gap:6px;}}
`;

function toolStatusColor(status: ExternalToolState["status"]): string {
  if (status === "ok") return C.green;
  if (status === "permission-missing") return C.amber;
  if (status === "missing") return C.red;
  return C.faint;
}

function externalToolRow(tool: ExternalToolState): string {
  const repair =
    tool.repairCommand === undefined
      ? ""
      : `<button type="button" class="copy-chip" data-copy="${esc(tool.repairCommand)}" style="margin-top:8px;border:1px solid ${C.line};background:#fff;border-radius:999px;padding:5px 8px;${MONO}font-size:11px;color:${C.blue};cursor:pointer;">${esc(
          tool.repairCommand,
        )}</button>`;
  return (
    `<div class="tool-row">` +
    `<div><b style="font-size:13px;color:${C.ink};">${esc(tool.label)}</b><div style="${MONO}font-size:11px;color:${C.faint};margin-top:4px;">${esc(
      tool.required ? "required" : "optional",
    )}</div></div>` +
    `<div class="tool-status" style="color:${toolStatusColor(tool.status)};">${esc(tool.status)}</div>` +
    `<div style="font-size:12.5px;color:${C.sub};line-height:1.55;">` +
    `<div>${esc(tool.purpose)}</div>` +
    `<div style="color:${C.dim};margin-top:4px;">${esc(tool.detail)}</div>` +
    (tool.status === "ok" ? "" : `<div style="color:${C.amber};margin-top:4px;">${esc(tool.impact)}</div>`) +
    repair +
    `</div>` +
    `</div>`
  );
}

/**
 * US-DOSSIER-031 — render the machine-global Agents page. Reuses the top-bar
 * shell (switcher + breadcrumb + lang toggle), the agents section header with
 * its 72h-window label, and the shared `agentRow` body. The breadcrumb's Agents
 * crumb self-highlights (AC1); leaving it returns to the prior console view.
 */
export function renderAgentsMachinePage(input: AgentsPageInput): string {
  const header = topBar({ ...input, machinePage: "agents" });
  const installedN = input.agents.filter((a) => a.installed).length;
  const staleN = input.agents.filter((a) => a.syncStale).length;
  const externalTools = input.externalTools ?? [];

  // AC5: the fixed 72h window is stated explicitly so the number stays honest in
  // a frozen snapshot (the agent-panel.ts window note).
  const sectionHeader =
    `<div style="display:flex;align-items:baseline;gap:12px;margin:24px 0 12px;flex-wrap:wrap;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;white-space:nowrap;">${bi(
      "Agents on this machine",
      "本机 agents",
    )}</span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.faint};">${bi(
      "detected by roll doctor — the loop dispatches to these",
      "roll doctor 检测——循环向它们派活",
    )}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;min-width:16px;"></span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.dim};white-space:nowrap;">${installedN}/${input.agents.length} ${bi(
      "installed · 72h window",
      "已安装 · 72h 窗口",
    )}${staleN > 0 ? ` <span style="color:#dfe4ec;">·</span> <b style="color:${C.amber};font-weight:600;">${staleN} ${bi("stale", "过期")}</b>` : ""}</span>` +
    `</div>`;

  const section =
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:0 0 8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    (input.agents.length > 0
      ? input.agents.map(agentRow).join("")
      : `<div style="padding:14px 18px;font-size:12.5px;color:${C.faint};font-style:italic;">${bi(
          "no agents detected on this machine",
          "本机未检测到 agent",
        )}</div>`) +
    `</section>`;

  const toolHeader =
    `<div style="display:flex;align-items:baseline;gap:12px;margin:26px 0 12px;flex-wrap:wrap;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;white-space:nowrap;">${bi(
      "External requirements",
      "外部依赖",
    )}</span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.faint};">${bi(
      "machine dependencies for screenshot and web evidence",
      "截图与网页证据的机器依赖",
    )}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;min-width:16px;"></span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.dim};white-space:nowrap;">${externalTools.filter((t) => t.status === "ok").length}/${externalTools.length} ${bi(
      "available",
      "可用",
    )}</span>` +
    `</div>`;

  const toolSection =
    externalTools.length === 0
      ? ""
      : toolHeader +
        `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:0 0 8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
        externalTools.map(externalToolRow).join("") +
        `</section>`;

  return (
    htmlHead(rollScope(input)) +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${esc(input.brand.name)} · Agents</title>\n` +
    FONT_LINKS +
    `<style>${SHELL_CSS}${AGENTS_PAGE_CSS}</style>\n` +
    `${CONSOLE_SCRIPT}\n</head>\n<body>\n` +
    header +
    `<main style="max-width:1100px;margin:0 auto;padding:0 22px 64px;">` +
    machineMasthead({
      kicker: bi("Machine layer", "机器层"),
      title: bi("Agents", "Agents"),
      lede: bi(
        "What this machine knows how to run, and whether it is healthy — every installed agent the loop dispatches to, with its runner, recent cycles & spend, and convention-file sync truth. Machine-global, not one project's usage.",
        "这台机器会跑什么、它是否健康——循环派活的每个已安装 agent，连同运行器、近期周期与花费、约定文件同步真相。机器级，不是单个项目的使用记录。",
      ),
    }) +
    sectionHeader +
    section +
    toolSection +
    `</main>\n</body>\n</html>\n`
  );
}
