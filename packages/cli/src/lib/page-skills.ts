/**
 * @responsibility Builds the machine-global Skills page.
 */
/**
 * US-DOSSIER-032 — the machine-global Skills page (`skills.html`), reached by
 * the top-bar breadcrumb (MACHINE › Skills). Skills are a MACHINE-side contract
 * — `skills/<name>/SKILL.md` governs every project on this box — so this is a
 * machine-global page, not a per-project console tab.
 *
 * Reproduces the design reference's Skills surface (`Delivery Dossier.dc.html`
 * lines 573–684) to full fidelity:
 *   - header (kicker · title · lede)
 *   - audit strip: skills · violations · Load-when · Gotchas · over-250 · aux ·
 *     hub-lines stats, the doctor + audit command chips, and the shared
 *     data-source line (route-cases/skills.json · scripts/audit-skills.mjs ·
 *     docs/skill-authoring.md)
 *   - the four skill groups (delivery / quality / observe / lifecycle), each a
 *     labelled section of expandable rows: caret · status dot · name · passive
 *     badge · description · meta · usage bar · invocations · last
 *   - per-row expand: real file tree (SKILL.md line count, references/ assets/
 *     scripts/), audit essentials (Load-when ✓ · Gotchas ✓ · route-case counts),
 *     a copyable directory path, and an INLINE rendered SKILL.md viewer.
 *
 * Scope: this reads the skills installed on THIS box (the `skills/` tree the
 * console was generated from), not a live cross-project disk crawl. Data comes
 * entirely from `collectSkillsPanel` (US-DOSSIER-017 VM, extended) — zero
 * hardcoded arrays. AC4: when the audit can't run, the bar + rows render
 * `unknown`, never a silent `0`. Determinism: the markdown render and the
 * sorted rows are pure; no clock, no randomness.
 */
import { renderMarkdown } from "./markdown.js";
import {
  CONSOLE_TOKENS,
  biSpan as bi,
  escHtml as esc,
  machineMasthead,
  renderMachineShell,
  type ProjectRegistryEntry,
  type TruthConsoleBrand,
} from "./truth-console.js";
import type { SkillPanelRow, SkillsPanelVM } from "./skills-panel.js";

const { C, MONO } = CONSOLE_TOKENS;

const GROUP_META: Record<string, { en: string; zh: string }> = {
  delivery: { en: "Delivery", zh: "交付" },
  quality: { en: "Quality", zh: "质量" },
  observe: { en: "Observe", zh: "观察" },
  lifecycle: { en: "Lifecycle", zh: "生命周期" },
};

export interface SkillsPageInput {
  skills: SkillsPanelVM;
  brand: TruthConsoleBrand;
  projects?: ProjectRegistryEntry[];
  currentSlug?: string;
  snapshot: { release?: { latestTag?: string } };
}

/** A copyable command chip (the design's audit/doctor pills + dir-path chip). */
function cmdChip(cmd: string): string {
  return (
    `<code class="copy-chip" data-copy="${esc(cmd)}" ` +
    `style="${MONO}font-size:10.5px;padding:3px 9px;border-radius:6px;border:1px solid ${C.line};color:${C.blue};background:${C.card};cursor:pointer;white-space:nowrap;">${esc(cmd)}</code>`
  );
}

function statCell(labelEn: string, labelZh: string, value: string, big: boolean, color: string): string {
  return (
    `<div>` +
    `<div style="${MONO}font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:${C.faint};">${bi(labelEn, labelZh)}</div>` +
    (big
      ? `<div style="${MONO}font-size:24px;font-weight:600;color:${color};margin-top:3px;">${esc(value)}</div>`
      : `<div style="${MONO}font-size:13px;color:${C.body};margin-top:8px;white-space:nowrap;">${esc(value)}</div>`) +
    `</div>`
  );
}

/** The audit strip — the reference's seven figures + command chips + the shared
 *  data-source line. Reads every figure off the panel VM (one yardstick). */
function auditStrip(vm: SkillsPanelVM): string {
  const rows = vm.groups.flatMap((g) => g.rows);
  const auditRan = vm.summary.auditRan;
  const loadOk = rows.filter((r) => r.auditKnown && r.hasLoadTrigger).length;
  const gotchasOk = rows.filter((r) => r.auditKnown && r.hasGotchas).length;
  const oversize = rows.filter((r) => r.hubLines > 250).length;
  const aux = rows.filter((r) => r.files.some((f) => f.dir)).length;
  const total = vm.summary.skills;
  const violVal = auditRan ? String(vm.summary.violations) : "—";
  const violColor = auditRan ? ((vm.summary.violations as number) > 0 ? C.red : C.green) : C.amber;
  const ratio = (n: number): string => (auditRan ? `${n}/${total}` : bi("unknown", "未知"));

  return (
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:20px 0 8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:28px;padding:16px 20px;">` +
    statCell("skills", "个技能", String(total), true, C.ink) +
    statCell("violations", "违规", violVal, true, violColor) +
    statCell("Load when… desc", "Load when… 描述", ratio(loadOk), false, C.body) +
    statCell("Gotchas coverage", "Gotchas 覆盖", ratio(gotchasOk), false, C.body) +
    statCell("over 250 lines", "超 250 行", String(oversize), false, C.body) +
    statCell("with aux files", "带附属文件", String(aux), false, C.body) +
    statCell("hub lines", "hub 行数", vm.summary.hubLines.toLocaleString("en-US"), false, C.body) +
    `<span style="flex:1;"></span>` +
    `<div style="display:flex;flex-direction:column;gap:7px;align-items:flex-end;">` +
    `<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:11px;color:${C.faint};white-space:nowrap;">${bi("machine-side: install & sync health", "机器侧：安装与同步健康")}</span>${cmdChip("roll doctor skills")}</div>` +
    `<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:11px;color:${C.faint};white-space:nowrap;">${bi("repo-side: reproduces these numbers", "仓库侧：复现上面这些数字")}</span>${cmdChip("roll skills audit --strict")}</div>` +
    `</div></div>` +
    // AC4 — an explicit, page-wide banner when the audit never ran.
    (auditRan
      ? ""
      : `<div style="padding:8px 20px;border-top:1px solid ${C.hair};background:#fdf6ec;${MONO}font-size:11px;color:${C.amber};">${bi("audit unavailable — violations unknown", "审计不可用 — 违规未知")}</div>`) +
    `<div style="display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;padding:10px 20px;border-top:1px solid ${C.hair};background:#fbfcfe;${MONO}font-size:11px;color:${C.dim};">` +
    `<span style="letter-spacing:.08em;text-transform:uppercase;font-size:10px;color:${C.faint};">${bi("repo shared", "仓库共享")}</span>` +
    `<span>route-cases/skills.json</span><span>scripts/audit-skills.mjs</span><span>docs/skill-authoring.md</span>` +
    `</div></section>`
  );
}

/** Strip the leading `---` frontmatter so the inline viewer renders the body. */
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---", 4);
  if (end === -1) return md;
  const bodyStart = md.indexOf("\n", end + 4);
  return bodyStart === -1 ? "" : md.slice(bodyStart + 1);
}

/** One skill row: collapsed grid + expanded structure / essentials / viewer. */
function skillRow(r: SkillPanelRow): string {
  const ok = r.auditKnown && r.violations.length === 0;
  const dotColor = !r.auditKnown ? C.amber : ok ? C.green : C.red;
  const verdict = !r.auditKnown
    ? `<span style="${MONO}font-size:10.5px;color:${C.amber};white-space:nowrap;text-align:right;">${bi("unknown", "未知")}</span>`
    : `<span style="${MONO}font-size:10.5px;color:${ok ? C.green : C.red};white-space:nowrap;text-align:right;">${ok ? bi("clean", "无违规") : `${r.violations.length} ${bi("violations", "违规")}`}</span>`;
  const usageMax = 72; // the reference's bar scale
  const barW = r.usage > 0 ? Math.max(3, Math.round((r.usage / usageMax) * 100)) : 0;
  const usageBar =
    `<span style="display:inline-block;width:150px;height:6px;border-radius:999px;background:#eef1f5;overflow:hidden;">` +
    `<span style="display:block;height:100%;border-radius:999px;background:${r.usage > 0 ? C.blue : "transparent"};width:${barW}%;"></span></span>`;

  const check = (on: boolean, label: string): string =>
    !r.auditKnown
      ? `<span style="${MONO}font-size:10.5px;color:${C.amber};white-space:nowrap;">? ${label}</span>`
      : `<span style="${MONO}font-size:10.5px;color:${on ? C.green : C.red};font-weight:600;white-space:nowrap;">${on ? "✓" : "✗"} ${label}</span>`;

  // The real file tree: SKILL.md line count, references/ assets/ scripts/ — long
  // reference bodies stay pointers (line counts), never inlined.
  const tree = r.files
    .map(
      (f) =>
        `<div style="display:flex;gap:12px;align-items:baseline;padding:2px 0;">` +
        `<span style="${MONO}font-size:11.5px;color:${f.dir ? C.faint : C.ink};">${esc(f.path)}</span>` +
        (f.dir ? "" : `<span style="${MONO}font-size:10.5px;color:${C.faint};">${f.lines} ${bi("lines", "行")}</span>`) +
        `</div>`,
    )
    .join("");

  const passiveBadge = r.name.startsWith("roll-.")
    ? `<span style="${MONO}font-size:9px;letter-spacing:.05em;text-transform:uppercase;padding:2px 5px;border-radius:4px;border:1px dashed #c8ced6;color:${C.faint};flex:none;">${bi("passive", "被动")}</span>`
    : "";

  const auxCount = r.files.filter((f) => f.dir).length;
  const anatomy = `${r.files.filter((f) => !f.dir).length} ${bi("files", "文件")} · ${auxCount} ${bi("aux dirs", "附属目录")}`;

  const rendered = renderMarkdown(stripFrontmatter(r.hubText));

  return (
    `<details class="sk-row" data-skill="${esc(r.name)}" data-open-key="sk:${esc(r.name)}" style="border-top:1px solid #f4f6f9;">` +
    `<summary style="display:grid;grid-template-columns:220px 1fr 160px 56px 84px;gap:14px;align-items:center;padding:11px 18px;cursor:pointer;list-style:none;">` +
    `<div style="display:flex;align-items:center;gap:7px;min-width:0;">` +
    `<span class="bl-caret" style="${MONO}font-size:9px;color:${C.faint};transition:transform .18s;flex:none;">▶</span>` +
    `<span style="width:8px;height:8px;border-radius:50%;background:${dotColor};flex:none;"></span>` +
    `<span style="${MONO}font-size:12.5px;font-weight:600;color:${C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.name)}</span>` +
    passiveBadge +
    `</div>` +
    `<div style="min-width:0;">` +
    `<div style="font-size:13px;color:${C.sub};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.description)}</div>` +
    `<div style="${MONO}font-size:10.5px;color:${C.faint};margin-top:2px;">${r.hubLines} ${bi("hub lines", "hub 行")}</div></div>` +
    usageBar +
    `<span style="${MONO}font-size:12px;font-weight:600;color:${r.usage > 0 ? C.blue : C.faint};text-align:right;" title="invocations (review-score notes) · 调用次数">${r.usage > 0 ? `×${r.usage}` : "—"}</span>` +
    verdict +
    `</summary>` +
    `<div style="background:#fbfcfe;border-top:1px solid #f1f4f8;padding:12px 18px 14px 43px;">` +
    `<div style="display:flex;flex-wrap:wrap;gap:18px 28px;align-items:flex-start;">` +
    // file structure
    `<div style="flex:1 1 320px;min-width:0;">` +
    `<div style="${MONO}font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:${C.faint};margin-bottom:6px;">${bi("Structure", "结构")}</div>${tree}</div>` +
    // audit essentials + actions
    `<div style="flex:1 1 280px;min-width:0;">` +
    `<div style="${MONO}font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:${C.faint};margin-bottom:6px;">${bi("audit essentials", "审计要件")}</div>` +
    `<div style="display:flex;flex-wrap:wrap;gap:12px;">${check(r.hasLoadTrigger, "Load when")}${check(r.hasGotchas, "Gotchas")}` +
    `<span style="${MONO}font-size:10.5px;color:${C.sub};">${r.routeCases.positive}+/${r.routeCases.negative}− ${bi("route cases", "路由用例")}</span></div>` +
    (r.auditKnown && r.violations.length > 0
      ? `<ul style="margin:8px 0 0;padding-left:16px;font-size:11.5px;color:${C.red};">${r.violations.map((v) => `<li>${esc(v)}</li>`).join("")}</ul>`
      : !r.auditKnown
        ? `<div style="margin:8px 0 0;${MONO}font-size:11px;color:${C.amber};">${bi("audit unavailable — violations unknown", "审计不可用 — 违规未知")}</div>`
        : "") +
    `</div>` +
    // right column: viewer toggle + copyable dir path + anatomy
    `<div style="flex:none;display:flex;flex-direction:column;gap:8px;align-items:flex-end;">` +
    `<code class="copy-chip" data-copy="${esc(r.dirPath)}" style="${MONO}font-size:10.5px;padding:3px 9px;border-radius:6px;border:1px solid ${C.line};color:${C.blue};background:${C.card};cursor:pointer;">${esc(r.dirPath)}</code>` +
    `<span style="${MONO}font-size:10.5px;color:${C.faint};white-space:nowrap;">${anatomy}</span>` +
    `</div></div>` +
    // inline rendered SKILL.md viewer (a nested <details> = the "view source" toggle)
    `<details class="sk-md" data-open-key="skmd:${esc(r.name)}" style="margin-top:11px;"><summary style="${MONO}font-size:10.5px;color:${C.blue};cursor:pointer;list-style:none;">SKILL.md · ${bi("view source", "查看原文")}</summary>` +
    `<div class="sk-md-body" style="margin-top:8px;border:1px solid ${C.line};border-radius:8px;background:${C.card};max-height:360px;overflow:auto;padding:13px 16px;font-size:13px;line-height:1.65;color:${C.body};">${rendered}</div>` +
    `</details>` +
    `</div></details>`
  );
}

function group(g: { key: string; rows: SkillPanelRow[] }): string {
  if (g.rows.length === 0) return "";
  const meta = GROUP_META[g.key] ?? { en: g.key, zh: g.key };
  return (
    `<div style="display:flex;align-items:baseline;gap:12px;margin:26px 0 10px;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;white-space:nowrap;">${bi(meta.en, meta.zh)}</span>` +
    `<span style="${MONO}font-size:12px;color:${C.blue};font-weight:600;">${g.rows.length}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;"></span></div>` +
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:0 0 4px;box-shadow:0 1px 2px rgba(17,26,69,.04);">` +
    `<div style="display:grid;grid-template-columns:220px 1fr 160px 56px 84px;gap:14px;align-items:center;padding:9px 18px;border-bottom:1px solid ${C.hair};${MONO}font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${C.faint};">` +
    `<span>${bi("skill", "技能")}</span><span></span><span>${bi("invocations / 3d", "近 3 天调用")}</span><span></span><span style="text-align:right;">${bi("last", "最近")}</span></div>` +
    g.rows.map(skillRow).join("") +
    `</section>`
  );
}

const SKILLS_PAGE_CSS = `
.sk-row summary::-webkit-details-marker{display:none;}
.sk-row[open] .bl-caret{transform:rotate(90deg);}
.sk-row summary:hover{background:#fbfcfe;}
.sk-md summary::-webkit-details-marker{display:none;}
.sk-md-body h1,.sk-md-body h2,.sk-md-body h3{font-size:14px;font-weight:600;color:${C.ink};margin:12px 0 4px;}
.sk-md-body h1{font-size:15px;}
.sk-md-body p{margin:6px 0;}
.sk-md-body ul{margin:6px 0;padding-left:20px;}
.sk-md-body code{font-family:'IBM Plex Mono',monospace;font-size:11.5px;background:#eef1f5;padding:1px 5px;border-radius:4px;}
.sk-md-body a{color:${C.blue};}
`;

export function renderSkillsPage(input: SkillsPageInput): string {
  const vm = input.skills;
  const body =
    machineMasthead({
      kicker: bi("Harness rulebook", "执行契约"),
      title: bi("Skills on this machine", "本机技能"),
      lede: bi(
        "Markdown playbooks agents load and follow — machine-side contracts that govern every project on this box. A contract is a claim; the strict audit and real invocations are its truth. The catalog is read from the skills/ directory: a skill that is not on disk does not exist here.",
        "agent 加载并遵循的 markdown 工作手册——机器侧契约，治理本机上的每个项目。契约是声明；严格审计与真实调用，才是它的真相。清单从 skills/ 目录实读：磁盘上不存在的技能这里也不存在。",
      ),
    }) +
    auditStrip(vm) +
    vm.groups.map(group).join("") +
    `<footer style="margin-top:42px;padding-top:18px;border-top:1px solid #dfe4ec;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;${MONO}font-size:11.5px;color:${C.faint};">` +
    `<span>${bi("main = truth · done ≡ merged", "主干即真相 · 完成 ≡ 已合并")}</span>` +
    `<span>${bi("same yardstick as audit-skills --strict", "与 audit-skills --strict 同口径")}</span></footer>`;

  return renderMachineShell({
    page: "skills",
    titleEn: "Skills",
    brand: input.brand,
    ...(input.projects !== undefined ? { projects: input.projects } : {}),
    ...(input.currentSlug !== undefined ? { currentSlug: input.currentSlug } : {}),
    snapshot: input.snapshot,
    extraCss: SKILLS_PAGE_CSS,
    bodyHtml: body,
  });
}
