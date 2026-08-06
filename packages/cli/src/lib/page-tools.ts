/**
 * @responsibility Builds the machine-global Tools page.
 */
/**
 * US-TOOL-017 — the machine-global **Tools** page (`tools.html`), the fifth
 * machine-layer breadcrumb destination, peer to Agents · Skills · Conventions ·
 * About. It promotes the built-in tool catalog to a first-class machine-scope
 * page: every built-in tool adapter the loop's agents call through — its kind,
 * what it does, whether it emits cycle events, the default guardrails
 * (timeout · sandbox · retry · per-cycle cap), and any external requirements.
 *
 * One source of truth: rows are rendered from `collectToolPanel`
 * (`ToolPanelRow[]`, US-TOOL-016), over `builtinToolDeclarations()`, so the page
 * can never disagree with the actually-registered adapters. Machine-global → no
 * per-project usage/cost (that lives on each project's Loop view). The tool
 * catalog is stable; requirement readiness reflects this host's dependencies,
 * so the page renders byte-identical only for the same machine state.
 *
 * Edge cases: an empty `tools` set renders a friendly "no built-in tools
 * detected" card, never a crash; multi-tool kinds group under one kind heading,
 * single-tool kinds render one row; index-gen wires it best-effort (try/catch).
 */
import { bi } from "@roll/core";
import type { ToolPanelRow } from "./tool-panel.js";
import {
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

export interface ToolsPageInput {
  brand: TruthConsoleBrand;
  /**
   * Every built-in tool adapter on this MACHINE (US-TOOL-017 AC2): the row set
   * is the `collectToolPanel()` catalog over `builtinToolDeclarations()`, not a
   * project's usage ledger. Requirement readiness is host-dependent.
   */
  tools: ToolPanelRow[];
  /** Cross-project switcher rows (read-only, US-DOSSIER-027). */
  projects?: ProjectRegistryEntry[];
  currentSlug?: string;
  /** Only the release tag is read off the snapshot (top-bar right badge). */
  snapshot: { release?: { latestTag?: string } };
}

/**
 * The `.ag-row` expand/caret/hover rules the tool rows reuse — present on the
 * console's tab CSS, but NOT in the shared SHELL_CSS — so the accordion works on
 * this standalone machine page too (AC2 row-expand interaction).
 */
const TOOLS_PAGE_CSS = `
a{color:${C.blue};}
.ag-row summary::-webkit-details-marker{display:none;}
.ag-row[open] .bl-caret{transform:rotate(90deg);}
.ag-row summary:hover{background:#fbfcfe;}
.tl-chip{${MONO}font-size:10.5px;color:${C.sub};border:1px solid ${C.line};border-radius:999px;padding:2px 9px;white-space:nowrap;}
.tl-req{border:1px solid ${C.line};border-radius:8px;background:#fff;padding:10px 11px;}
.tl-req + .tl-req{margin-top:8px;}
@media (max-width:760px){.tl-sum{grid-template-columns:1fr !important;gap:6px !important;}.tl-status-strip{justify-content:flex-start !important;}}
`;

/** Human-readable bilingual label per kind heading. Unknown kinds fall back to
 *  the raw kind on both lines (the collector controls the kind set). */
const KIND_META: Record<string, { en: string; zh: string }> = {
  bash: { en: "Bash", zh: "Bash" },
  browser: { en: "Browser", zh: "浏览器" },
  filesystem: { en: "Filesystem", zh: "文件系统" },
  git: { en: "Git", zh: "Git" },
  github: { en: "GitHub", zh: "GitHub" },
  mcp: { en: "MCP", zh: "MCP" },
  network: { en: "Network", zh: "网络" },
  physical: { en: "Physical Capture", zh: "物理截图" },
};

/** A small bilingual label / value pair (mono value), the agent-row cell motif. */
function cell(label: string, value: string, mono = true): string {
  return (
    `<div><div style="${MONO}font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:${C.faint};">${label}</div>` +
    `<div style="${mono ? MONO : ""}font-size:12px;color:${C.body};margin-top:3px;">${value}</div></div>`
  );
}

/** The default-policy line: timeout · sandbox · retry · per-cycle cap. Each
 *  sub-field is shown only when the declaration set it; an all-empty policy
 *  reads "default policy" so the absence is honest, never blank. */
function guardrailLine(row: ToolPanelRow): string {
  const g = row.guardrails;
  const parts: string[] = [];
  if (g.timeoutMs !== undefined) parts.push(`${bi("timeout", "超时")} ${Math.round(g.timeoutMs / 1000)}s`);
  if (g.sandbox !== undefined) parts.push(`${bi("sandbox", "沙箱")} ${esc(g.sandbox)}`);
  if (g.retries !== undefined) parts.push(`${bi("retry", "重试")} ×${g.retries}`);
  if (g.maxPerCycle !== undefined) parts.push(`${bi("per-cycle", "每周期")} ${g.maxPerCycle}`);
  return parts.length === 0 ? bi("default policy", "默认策略") : parts.join(` <span style="color:${C.faint};">·</span> `);
}

function readinessChip(status: string): string {
  const color = status === "available" ? C.green : status === "degraded" ? C.amber : C.red;
  return `<span class="tl-chip" style="border-color:${color};color:${color};font-weight:600;">${esc(status)}</span>`;
}

function requirementStatusChip(status: string): string {
  const color = status === "ok" ? C.green : status === "permission-missing" ? C.amber : status === "missing" ? C.red : C.sub;
  return `<span class="tl-chip" style="border-color:${color};color:${color};font-weight:600;">${esc(status)}</span>`;
}

function requirementChain(row: ToolPanelRow): string {
  if (row.requirementDetails.length === 0) {
    return `<div style="font-size:12.5px;color:${C.faint};font-style:italic;">${bi("none — works out of the box", "无 — 开箱即用")}</div>`;
  }
  return row.requirementDetails
    .map((requirement) => {
      const fix =
        requirement.repairCommand === undefined
          ? ""
          : `<div style="${MONO}font-size:11.5px;color:${C.blue};margin-top:6px;">fix: ${esc(requirement.repairCommand)}</div>`;
      const authorize =
        requirement.authorizeCommand === undefined
          ? ""
          : `<div style="${MONO}font-size:11.5px;color:${C.amber};margin-top:6px;">authorize: ${esc(requirement.authorizeCommand)}</div>`;
      return (
        `<div class="tl-req" data-requirement="${esc(requirement.name)}">` +
        `<div style="display:flex;align-items:center;gap:8px;justify-content:space-between;min-width:0;flex-wrap:wrap;">` +
        `<div style="min-width:0;"><span style="${MONO}font-size:12.5px;font-weight:650;color:${C.ink};">${esc(requirement.label)}</span>` +
        `<span style="${MONO}font-size:10.5px;color:${C.faint};margin-left:8px;">${esc(requirement.kind)}${requirement.optional ? ` · ${bi("optional", "可选")}` : ""}</span></div>` +
        requirementStatusChip(requirement.status) +
        `</div>` +
        `<div style="font-size:12.5px;line-height:1.5;color:${C.body};margin-top:7px;">${esc(requirement.detail)}</div>` +
        fix +
        authorize +
        `</div>`
      );
    })
    .join("");
}

/** One tool row: a collapsed grid summary (caret · id · kind · title · events)
 *  + an expanded body with the full description, the exact default policy, and
 *  the external requirements. Same `<details class="ag-row">` accordion idiom as
 *  the Agents page so the shared open-state persistence + caret CSS apply. */
function toolRow(row: ToolPanelRow): string {
  const events = row.emitsEvents
    ? `<span style="${MONO}font-size:11px;color:${C.green};font-weight:600;white-space:nowrap;">${bi("events ✓", "事件 ✓")}</span>`
    : `<span style="${MONO}font-size:11px;color:${C.faint};white-space:nowrap;">${bi("events —", "事件 —")}</span>`;
  const reqInline =
    row.requirements.length === 0
      ? `<span style="${MONO}font-size:11px;color:${C.faint};white-space:nowrap;">${bi("requires —", "依赖 —")}</span>`
      : `<span style="${MONO}font-size:11px;color:${C.sub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${bi("requires", "依赖")} ${esc(row.requirements.join(", "))}</span>`;
  return (
    `<details class="ag-row" data-tool="${esc(row.id)}" data-open-key="tl:${esc(row.id)}" style="border-top:1px solid ${C.hair};">` +
    `<summary class="tl-sum" style="display:grid;grid-template-columns:220px 110px 1fr auto auto auto;align-items:center;gap:14px;padding:11px 18px;cursor:pointer;list-style:none;">` +
    `<span style="display:flex;align-items:center;gap:10px;min-width:0;"><span class="bl-caret" style="${MONO}font-size:9px;color:${C.faint};transition:transform .18s;flex:none;">▶</span>` +
    `<span style="${MONO}font-size:13px;font-weight:600;color:${C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(row.id)}</span></span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.sub};white-space:nowrap;">${esc(row.kind)}</span>` +
    `<span style="font-size:12.5px;color:${C.sub};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(row.title)}</span>` +
    readinessChip(row.readiness) +
    events +
    reqInline +
    `</summary>` +
    `<div style="background:#fbfcfe;border-top:1px solid #f1f4f8;padding:13px 18px 15px 47px;">` +
    `<div style="font-size:13px;line-height:1.6;color:${C.body};max-width:680px;">${esc(row.description !== "" ? row.description : row.title)}</div>` +
    `<div style="display:flex;flex-wrap:wrap;gap:18px 36px;margin-top:13px;">` +
    cell(bi("kind", "类别"), esc(row.kind)) +
    cell(bi("emits events", "触发事件"), row.emitsEvents ? bi("yes", "是") : bi("no", "否"), false) +
    cell(bi("input contract", "入参契约"), esc(row.inputContract ?? "-")) +
    cell(bi("output contract", "出参契约"), esc(row.outputContract ?? "-")) +
    `<div style="min-width:0;"><div style="${MONO}font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:${C.faint};">${bi("default policy", "默认策略")}</div>` +
    `<div style="${MONO}font-size:12px;color:${C.body};margin-top:3px;">${guardrailLine(row)}</div></div>` +
    `</div>` +
    `<div style="margin-top:13px;">` +
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px;">` +
    `<div style="${MONO}font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:${C.faint};">${bi("requirement chain", "依赖链")}</div>` +
    `<div class="tl-status-strip" style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">${readinessChip(row.readiness)}</div>` +
    `</div>` +
    requirementChain(row) +
    `</div>` +
    `</div></details>`
  );
}

/** One kind group: a labelled hairline header + a card of its tool rows. */
function kindGroup(kind: string, rows: ToolPanelRow[]): string {
  const meta = KIND_META[kind] ?? { en: kind, zh: kind };
  return (
    `<div style="display:flex;align-items:baseline;gap:12px;margin:26px 0 10px;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;white-space:nowrap;">${bi(meta.en, meta.zh)}</span>` +
    `<span style="${MONO}font-size:12px;color:${C.blue};font-weight:600;">${rows.length}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;"></span></div>` +
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:0 0 4px;box-shadow:0 1px 2px rgba(17,26,69,.04);">` +
    rows.map(toolRow).join("") +
    `</section>`
  );
}

/** Group the (already deterministically ordered) rows by kind, preserving the
 *  collector's first-seen kind order so the page stays snapshot-stable. */
function groupByKind(tools: ToolPanelRow[]): Array<[string, ToolPanelRow[]]> {
  const order: string[] = [];
  const buckets = new Map<string, ToolPanelRow[]>();
  for (const row of tools) {
    let bucket = buckets.get(row.kind);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(row.kind, bucket);
      order.push(row.kind);
    }
    bucket.push(row);
  }
  return order.map((kind) => [kind, buckets.get(kind) ?? []]);
}

/**
 * US-TOOL-017 — render the machine-global Tools page. Reuses the top-bar shell
 * (switcher + breadcrumb + lang toggle) and the shared machine masthead; the
 * breadcrumb's Tools crumb self-highlights (AC3). The capability surface is
 * grouped by kind, each row expandable to full description + default policy +
 * requirements.
 */
export function renderToolsPage(input: ToolsPageInput): string {
  const header = topBar({ ...input, machinePage: "tools" });
  const groups = groupByKind(input.tools);
  const kindCount = groups.length;
  const toolCount = input.tools.length;

  const sectionHeader =
    `<div style="display:flex;align-items:baseline;gap:12px;margin:24px 0 12px;flex-wrap:wrap;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;white-space:nowrap;">${bi(
      "Built-in tools",
      "内置工具",
    )}</span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.faint};">${bi(
      "every adapter the loop's agents call through",
      "循环里 agent 调用的每个适配器",
    )}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;min-width:16px;"></span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.dim};white-space:nowrap;">${kindCount} ${bi("kinds", "类")} <span style="color:#dfe4ec;">·</span> ${toolCount} ${bi(
      "tools",
      "个工具",
    )}</span>` +
    `</div>`;

  const body =
    toolCount === 0
      ? `<section style="border:1px dashed ${C.line};border-radius:12px;background:${C.card};padding:28px 24px;margin:8px 0;color:${C.faint};font-size:13.5px;">` +
        bi(
          "No built-in tools detected on this machine.",
          "本机未检测到内置工具。",
        ) +
        `</section>`
      : sectionHeader + groups.map(([kind, rows]) => kindGroup(kind, rows)).join("");

  return (
    htmlHead(rollScope(input)) +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${esc(input.brand.name)} · Tools</title>\n` +
    FONT_LINKS +
    `<style>${SHELL_CSS}${TOOLS_PAGE_CSS}</style>\n` +
    `${CONSOLE_SCRIPT}\n</head>\n<body>\n` +
    header +
    `<main style="max-width:1100px;margin:0 auto;padding:0 22px 64px;">` +
    machineMasthead({
      kicker: bi("Machine layer", "机器层"),
      title: bi("Tools", "工具"),
      lede: bi(
        "The capability surface the loop's agents call through — every built-in tool adapter on this machine, its kind, what it does, and the default guardrails + external requirements. Machine-global, not one project's usage. (Per-project tool spend → each project's Loop view.)",
        "循环里 agent 调用的能力面——本机每个内置工具适配器、它的类别、它做什么，以及默认护栏与外部依赖。机器级，不是单个项目的使用记录。（单项目的工具开销 → 各项目的循环视图。）",
      ),
    }) +
    body +
    `<footer style="margin-top:42px;padding-top:18px;border-top:1px solid #dfe4ec;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;${MONO}font-size:11.5px;color:${C.faint};">` +
    `<span>${bi("machine-global · live requirements vary by host", "机器级 · live 依赖随宿主变化")}</span>` +
    `<span>${bi("one source of truth: builtinToolDeclarations()", "单一真相来源:builtinToolDeclarations()")}</span></footer>` +
    `</main>\n</body>\n</html>\n`
  );
}
