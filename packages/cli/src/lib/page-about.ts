/**
 * @responsibility Builds the machine-global About page content model.
 */
/**
 * US-DOSSIER-041 — the About machine-global page, rebuilt to the CORRECT content
 * model (the design reference's ABOUT ROLL TAB).
 *
 * About is the harness's own charter, surfaced read-only behind the machine
 * breadcrumb (`About / 关于`). It is NOT a markdown file browser — it is a
 * STRUCTURED page that introduces roll the harness (global, shared by every roll
 * project):
 *   1. Creed / 信条       — roll's one-line philosophy.
 *   2. Feedback loop      — the 4 phases Act → Sense → Score → Correct.
 *   3. Capability domains — the 7 (Orchestration / Execution / Tool Use /
 *                           Context / Observability / Evals / Guardrails).
 *   4. Principles         — the ~14, grouped Control / Truth / Failure / Structure.
 *   5. Invariants         — the 12 behavior invariants (I1–I12).
 *
 * The copy is the authoritative bilingual `ui.*` / data strings from the design
 * reference (`truth-console-design/Delivery Dossier.dc.html`, the ABOUT ROLL TAB
 * sub-sections), cross-referenced with `docs/manifesto.md` (principles) and
 * `docs/architecture.md` (capability-domain homes + the 12 invariants). It is
 * baked in at generate time — the page makes no network fetch and renders
 * identically offline, and carries NO external `<link>` (self-contained).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bi } from "@roll/core";
import { machineMasthead, machinePalette, renderMachineShell, type ProjectRegistryEntry, type TruthConsoleBrand } from "./truth-console.js";

/** One bilingual string. */
export interface Bilingual {
  en: string;
  zh: string;
}

/** A capability-domain plane — the structural core vs the control plane. */
export type DomainPlane = "core" | "control";

/** One capability domain (one of the 7), with its home package(s) + plane. */
export interface AboutDomain {
  name: Bilingual;
  /** Which package(s) own this domain (from docs/architecture.md). */
  home: string;
  plane: DomainPlane;
}

/** One principle, numbered within the whole list (1..14). */
export interface AboutPrinciple {
  n: number;
  t: Bilingual;
}

/** A group of principles (Control / Truth / Failure / Structure). */
export interface AboutPrincipleGroup {
  group: Bilingual;
  items: AboutPrinciple[];
}

/** One feedback-loop stage (Act / Sense / Score / Correct). */
export interface AboutLoopStage {
  label: Bilingual;
  sub: Bilingual;
}

/** One behavior invariant (I1..I12). */
export interface AboutInvariant {
  n: string;
  t: Bilingual;
}

/**
 * The About view-model — the structured charter content. The copy is constant
 * (the design reference's authoritative strings); `manifestoPresent` /
 * `architecturePresent` record whether the source docs the copy is drawn from
 * exist in this repo, so the page can cite them honestly.
 */
export interface AboutVM {
  creed: Bilingual;
  loop: AboutLoopStage[];
  domains: AboutDomain[];
  principles: AboutPrincipleGroup[];
  invariants: AboutInvariant[];
  /** docs/manifesto.md exists (principles source). */
  manifestoPresent: boolean;
  /** docs/architecture.md exists (domains + invariants source). */
  architecturePresent: boolean;
}

// ─── Authoritative copy (verbatim from the design reference's ABOUT ROLL TAB) ──

/** roll's one-line philosophy (design ref: ROLL_CREED). */
export const ROLL_CREED: Bilingual = {
  en: "Treat the model as a black box; drive its output toward reliability with a feedback loop — a harness that is observable, trustworthy, self-evaluating, and able to stop itself.",
  zh: "把 AI 当黑盒，用反馈闭环把它的产出逼向可靠；让这台 harness 自己可观测、可信赖、能自评、还拦得住自己。",
};

/** The 4 feedback-loop phases (design ref: LOOP_STAGES) — Act → Sense → Score → Correct. */
export const ROLL_LOOP: AboutLoopStage[] = [
  { label: { en: "Act", zh: "作动" }, sub: { en: "orchestrate · execute", zh: "编排 · 执行" } },
  { label: { en: "Sense", zh: "传感" }, sub: { en: "observe", zh: "可观测" } },
  { label: { en: "Score", zh: "评分" }, sub: { en: "evals = error signal", zh: "Evals = 误差信号" } },
  { label: { en: "Correct", zh: "反哺" }, sub: { en: "tune next cycle", zh: "修正下一轮" } },
];

/** The 7 capability domains (design ref: DOMAINS) — each with a home + plane. */
export const ROLL_DOMAINS: AboutDomain[] = [
  { name: { en: "Orchestration", zh: "编排" }, home: "core · infra", plane: "core" },
  { name: { en: "Execution / Sandbox", zh: "执行隔离" }, home: "infra", plane: "core" },
  { name: { en: "Tool Use", zh: "工具 / 多 agent" }, home: "core · infra", plane: "core" },
  { name: { en: "Context Engineering", zh: "上下文" }, home: "skills · .roll/", plane: "core" },
  { name: { en: "Observability", zh: "可观测" }, home: "spec · core · cli", plane: "control" },
  { name: { en: "Evals", zh: "验证 / 评分" }, home: "core", plane: "control" },
  { name: { en: "Guardrails", zh: "治理" }, home: "core", plane: "control" },
];

/** The 14 principles in 4 groups (design ref: PRINCIPLES). */
export const ROLL_PRINCIPLES: AboutPrincipleGroup[] = [
  {
    group: { en: "Control", zh: "控制" },
    items: [
      { n: 1, t: { en: "Reliability lives in the harness, not the model", zh: "可靠性在 harness，不在模型" } },
      { n: 2, t: { en: "roll is a feedback loop, not a pile of features", zh: "roll 是按反馈闭环设计的 harness" } },
      { n: 3, t: { en: "Never open the black box", zh: "不打开黑盒" } },
    ],
  },
  {
    group: { en: "Truth", zh: "真相" },
    items: [
      { n: 4, t: { en: "main is truth — done ≡ merged", zh: "主干即真相 — 完成 ≡ 已合并" } },
      { n: 5, t: { en: "Context is a persistent doc, not chat history", zh: "上下文是持久文档，不是对话历史" } },
      { n: 6, t: { en: "Persistence over convenience", zh: "持久优先于便利" } },
    ],
  },
  {
    group: { en: "Failure", zh: "失败" },
    items: [
      { n: 7, t: { en: "Failures ring out — never silently self-heal", zh: "失败要响，不偷偷自愈" } },
      { n: 8, t: { en: "Processes can die; defend every path", zh: "进程随时会死，防御覆盖每条路径" } },
      { n: 9, t: { en: "Every feedback has a Goodhart guardrail", zh: "反馈必有 Goodhart 护栏" } },
    ],
  },
  {
    group: { en: "Structure", zh: "结构" },
    items: [
      { n: 10, t: { en: "Bounded & reversible", zh: "有界且可逆" } },
      { n: 11, t: { en: "Path is identity", zh: "路径即身份" } },
      { n: 12, t: { en: "One capability domain, one home", zh: "一个能力域，一个家" } },
      { n: 13, t: { en: "The observable contract is truth, not impl quirks", zh: "可观察契约是真相，实现怪癖不是" } },
      { n: 14, t: { en: "Humans on the loop, not in it", zh: "人在环上，不在环中" } },
    ],
  },
];

/** The 12 behavior invariants (design ref: INVARIANTS) — I1..I12. */
export const ROLL_INVARIANTS: AboutInvariant[] = [
  { n: "I1", t: { en: "Heartbeat ≤60s; watchdog reaps & writes terminal", zh: "心跳 ≤60s；超时回收并落终态" } },
  { n: "I2", t: { en: "SIGKILL-safe re-entry detects orphans", zh: "SIGKILL 重入检测孤儿并安全接管" } },
  { n: "I3", t: { en: "≤1 open PR per story", zh: "同一 Story 至多一个 open PR" } },
  { n: "I4", t: { en: "main = truth; exit-0 / green CI ≠ delivered", zh: "主干即真相；退出码/CI 绿 ≠ 已交付" } },
  { n: "I5", t: { en: "One bad story never freezes the rest", zh: "一个坏 Story 不冻结其他工作" } },
  { n: "I6", t: { en: "Repeated failure → pause + alert, human decides", zh: "连败 → 暂停+告警，人决策" } },
  { n: "I7", t: { en: "Path is identity — per-project .roll/loop/", zh: "路径即身份 — 每项目独立 .roll/loop/" } },
  { n: "I8", t: { en: "State rebuilt from immutable events; atomic append", zh: "状态从不可变事件重建；原子追加" } },
  { n: "I9", t: { en: "Optimistic lock; exact-line story match", zh: "乐观锁；整行精确匹配" } },
  { n: "I10", t: { en: "Predictable routing; probe before spawn", zh: "可预测路由；spawn 前探活" } },
  { n: "I11", t: { en: "Per-cycle cost recorded; budget guardrail", zh: "逐周期记成本；预算限幅" } },
  { n: "I12", t: { en: "One cycle one story, fresh ctx, TCR green-or-revert", zh: "一周期一故事、全新上下文、TCR 绿或回退" } },
];

export interface AboutDeps {
  /** Does this repo-relative doc exist? (used only to cite the source honestly) */
  docExists: (rel: string) => boolean;
}

/**
 * Collect the About view-model. The structured charter copy is constant (the
 * design reference's authoritative strings); deps only record whether the source
 * docs are present so the page can cite them. Pure over deps, deterministic.
 */
export function collectAbout(deps: AboutDeps): AboutVM {
  return {
    creed: ROLL_CREED,
    loop: ROLL_LOOP,
    domains: ROLL_DOMAINS,
    principles: ROLL_PRINCIPLES,
    invariants: ROLL_INVARIANTS,
    manifestoPresent: deps.docExists("docs/manifesto.md"),
    architecturePresent: deps.docExists("docs/architecture.md"),
  };
}

/** Default deps — best-effort real existence checks rooted at `cwd`. */
export function defaultAboutDeps(cwd: string): AboutDeps {
  return {
    docExists: (rel) => {
      try {
        return existsSync(join(cwd, rel));
      } catch {
        return false;
      }
    },
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface RenderAboutInput {
  brand: TruthConsoleBrand;
  vm: AboutVM;
  projects?: ProjectRegistryEntry[];
  currentSlug?: string;
  snapshot: { release?: { latestTag?: string } };
}

/**
 * US-DOSSIER-041 — render the About machine page: the structured charter —
 * creed → feedback loop (4 phases) → capability domains (7) → principles
 * (grouped) → invariants (12). Wrapped in the shared machine shell (top bar +
 * lang script + the About breadcrumb highlighted), self-contained (no external
 * `<link>`), bilingual EN/中 on separate lines via `bi()`.
 */
export function renderAboutPage(input: RenderAboutInput): string {
  const C = machinePalette();
  const MONO = C.mono;
  const { vm, brand } = input;

  const sectionLabel = (en: string, zh: string): string =>
    `<div style="display:flex;align-items:baseline;gap:12px;margin:26px 0 12px;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;white-space:nowrap;">${bi(en, zh)}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;"></span></div>`;

  // 1) Creed — roll's one-line philosophy, the lede card.
  const creed =
    `<section style="border:1px solid ${C.line};border-left:4px solid ${C.blue};border-radius:12px;background:${C.card};padding:20px 22px;margin:18px 0;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<p style="margin:0;font-size:18px;line-height:1.6;font-weight:500;color:#1f2733;">${bi(esc(vm.creed.en), esc(vm.creed.zh))}</p>` +
    `</section>`;

  // 2) Feedback loop — Act → Sense → Score → Correct, the 4 phases in a row.
  const loopCells = vm.loop
    .map((s, i) => {
      const last = i === vm.loop.length - 1;
      const arrow = last
        ? `<span style="${MONO}font-size:14px;color:${C.blue};padding:0 8px;">↺</span>`
        : `<span style="${MONO}font-size:13px;color:#c5ccd8;padding:0 9px;">→</span>`;
      return (
        `<div style="display:flex;align-items:center;flex:1 1 0;min-width:140px;">` +
        `<div style="flex:1;border:1px solid #e8ebf0;border-radius:10px;background:#fbfcfe;padding:12px 14px;">` +
        `<div style="font-size:15px;font-weight:700;color:${C.ink};">${bi(esc(s.label.en), esc(s.label.zh))}</div>` +
        `<div style="${MONO}font-size:10.5px;color:${C.dim};margin-top:4px;">${bi(esc(s.sub.en), esc(s.sub.zh))}</div>` +
        `</div>${arrow}</div>`
      );
    })
    .join("");
  const loopSection =
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:20px 22px;margin:0 0 8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="display:flex;align-items:stretch;flex-wrap:wrap;gap:0;">${loopCells}</div></section>`;

  // 3) Capability domains — the 7, each chip carries its home + plane.
  const domainColor = (plane: DomainPlane): string => (plane === "core" ? C.blue : C.green);
  const domainChips = vm.domains
    .map((d) => {
      const col = domainColor(d.plane);
      const planeLabel = d.plane === "core" ? bi("core", "结构核心") : bi("control plane", "控制平面");
      return (
        `<div style="border:1px solid ${C.line};border-left:3px solid ${col};border-radius:10px;background:${C.card};padding:12px 14px;box-shadow:0 1px 2px rgba(17,26,69,.04);">` +
        `<div style="display:flex;align-items:center;gap:8px;">` +
        `<span style="width:7px;height:7px;border-radius:50%;background:${col};flex:none;display:inline-block;"></span>` +
        `<span style="font-size:13.5px;font-weight:600;color:${C.ink};">${bi(esc(d.name.en), esc(d.name.zh))}</span></div>` +
        `<div style="display:flex;justify-content:space-between;gap:8px;margin-top:8px;${MONO}font-size:10.5px;color:${C.faint};">` +
        `<span>${esc(d.home)}</span><span>${planeLabel}</span></div></div>`
      );
    })
    .join("");
  const domainsSection = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:8px;">${domainChips}</div>`;

  // 4) Principles — ~14 in 4 groups (Control / Truth / Failure / Structure).
  const principleGroups = vm.principles
    .map((g) => {
      const items = g.items
        .map(
          (p) =>
            `<div style="display:flex;gap:9px;align-items:baseline;padding:5px 0;">` +
            `<span style="${MONO}font-size:10.5px;color:#b6bdc9;font-weight:600;flex:none;min-width:16px;">${p.n}</span>` +
            `<span style="font-size:12.5px;color:${C.body};line-height:1.45;">${bi(esc(p.t.en), esc(p.t.zh))}</span></div>`,
        )
        .join("");
      return (
        `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:14px 16px;box-shadow:0 1px 2px rgba(17,26,69,.04);">` +
        `<div style="${MONO}font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${C.blue};font-weight:600;margin-bottom:9px;">${bi(esc(g.group.en), esc(g.group.zh))}</div>` +
        items +
        `</section>`
      );
    })
    .join("");
  const principlesSection = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:8px;">${principleGroups}</div>`;

  // 5) Invariants — the 12 behavior invariants (I1..I12), a two-column grid.
  const invariantRows = vm.invariants
    .map(
      (iv) =>
        `<div style="display:flex;gap:10px;align-items:baseline;padding:9px 16px;border-top:1px solid #f4f6f9;">` +
        `<span style="${MONO}font-size:11px;font-weight:600;color:${C.green};flex:none;min-width:26px;">${esc(iv.n)}</span>` +
        `<span style="font-size:12px;color:${C.sub};line-height:1.45;">${bi(esc(iv.t.en), esc(iv.t.zh))}</span></div>`,
    )
    .join("");
  const invariantsSection =
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin-bottom:8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="display:grid;grid-template-columns:1fr 1fr;">${invariantRows}</div></section>`;

  // Source citation — the docs the copy is drawn from, when present.
  const sources: string[] = [];
  if (vm.manifestoPresent) sources.push("docs/manifesto.md");
  if (vm.architecturePresent) sources.push("docs/architecture.md");
  const sourceNote =
    sources.length > 0
      ? `<div style="${MONO}font-size:10.5px;letter-spacing:.04em;color:${C.faint};margin:16px 0 0;">${bi(
          `Drawn from ${sources.join(" + ")}`,
          `取自 ${sources.join(" + ")}`,
        )}</div>`
      : "";

  const body =
    machineMasthead({
      kicker: bi("The harness · global · shared by every roll project", "框架 · 全局 · 每个 roll 项目共享"),
      title: bi("How roll works", "roll 怎么运转"),
    }) +
    creed +
    sectionLabel("roll harness · the feedback loop", "roll 框架 · 反馈闭环") +
    loopSection +
    sectionLabel("roll harness · capability domains", "roll 框架 · 能力域") +
    domainsSection +
    sectionLabel("roll harness · principles", "roll 框架 · 十四条理念") +
    principlesSection +
    sectionLabel("roll harness · 12 invariants", "roll 框架 · 十二条不变量") +
    invariantsSection +
    sourceNote;

  return renderMachineShell({
    page: "about",
    titleEn: "About",
    brand,
    bodyHtml: body,
    snapshot: input.snapshot,
    ...(input.projects !== undefined ? { projects: input.projects } : {}),
    ...(input.currentSlug !== undefined ? { currentSlug: input.currentSlug } : {}),
  });
}
