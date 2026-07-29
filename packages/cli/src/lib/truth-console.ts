/**
 * US-DOSSIER-011/043 — the Truth Console: index.html is a single-page
 * project control board (Now · Backlog · Loop · Release · Casting · Charter).
 *
 * Faithful to the owner-approved high-fidelity prototype
 * (.roll/features/delivery-dossier/truth-console-design/Delivery Dossier.dc.html):
 * light theme, IBM Plex Sans/Mono, dark sticky header with the project name +
 * EN/中 toggle, sticky tabs, and a Now page a reader digests in thirty seconds
 * — live cycle, loop heartbeat, next picks, needs-you rows, verdict strip, three
 * aggregate tiles, and six-state spectrum. Every number is read from the ONE
 * TruthSnapshot / ledger inputs, so the page can never disagree with truth.json.
 *
 * Tab state survives drill-downs via the URL hash (#now/#backlog/#loop/
 * #release/#casting/#charter): browser Back restores it without any storage.
 *
 * Now carries current operations + the truth rollup; Backlog/Loop/Release/
 * Casting/Charter render their project-specific surfaces below it.
 */
import { bi, CONSISTENCY_DIMENSION_LABELS, type ConsistencyDimensionLabel, FONT_LINKS as CORE_FONT_LINKS } from "@roll/core";
import { isLeftoverLane } from "@roll/spec";
import type { TruthSnapshot, TruthSnapshotLoopLane, TruthSnapshotPanelSlot } from "@roll/spec";
import type { CycleLedgerRow, CycleTapeSegment } from "./cycle-ledger.js";
import type { AgentPanelRow } from "./agent-panel.js";
import type { ReleasePanelDim, ReleasePanelVM } from "./release-panel.js";
import type { ReleaseScopeVM, ScopeEpicGroup } from "./release-scope.js";
import type { SkillsPanelVM } from "./skills-panel.js";
import type { CastingExecSlot, CastingVM, CastingRow } from "./casting.js";
import type { CharterVM } from "./page-charter.js";
import type { GitHooksVM } from "./git-hooks.js";

export interface TruthConsoleBrand {
  /** Injected, never hardcoded (owner ruling): project name + slogan. */
  name: string;
  slogan: string;
}

/**
 * US-DOSSIER-027 — one project row in the cross-project registry
 * (`~/.roll/projects.json`, produced by US-DOSSIER-028). The console consumes
 * it READ-ONLY for the top-bar switcher; it never writes the file. Schema is
 * the 028 contract: `{ name, slug, path, releaseTag, verdict, lastIndexedAt }`.
 */
export interface ProjectRegistryEntry {
  name: string;
  slug: string;
  /** Absolute path to the project root (the switcher targets its dossier). */
  path: string;
  releaseTag?: string;
  verdict?: string;
  lastIndexedAt?: string;
}

/**
 * US-DOSSIER-027 — the machine-global breadcrumb (MACHINE: Agents · Skills ·
 * Conventions · About). These are above-project, machine-layer entry points;
 * their pages are built by later stories (this story wires the stable routing
 * contract and points at sibling HTML files). `current` highlights the active
 * page when one of those pages renders this header; on the console it is unset.
 */
export interface MachineNavLink {
  key: "agents" | "skills" | "tools" | "conventions" | "about";
  en: string;
  zh: string;
  href: string;
}

/** One story row on the Backlog tab (US-DOSSIER-012). */
export interface BacklogStoryVM {
  id: string;
  epic: string;
  /** ID family: US | FIX | REFACTOR | … */
  type: string;
  title: string;
  /** Spectrum state — the SAME classifier the snapshot tally uses. */
  state: "done" | "wip" | "hold" | "todo" | "fail" | "unknown";
  legacy: boolean;
  /** Lifecycle stations done (spine keys in order). */
  stages: string[];
}

export interface BacklogEpicVM {
  name: string;
  done: number;
  total: number;
  stories: BacklogStoryVM[];
}

export interface BacklogVM {
  /** Epics still shipping (not every story merged). */
  shipping: BacklogEpicVM[];
  /** Epics fully settled on main. */
  settled: BacklogEpicVM[];
}

export interface LoopLiveFeedVM {
  /** Absolute live.log path, shown as provenance only. */
  sourcePath: string;
  /** Static archive read-only polling target from .roll/features/index.html. */
  relativeHref: string;
  /** Agent normalizer used by the generated snapshot. */
  agent: string;
  /** live = concise signals present; idle = no activity; paused = unreadable. */
  status: "live" | "idle" | "paused";
  generatedAt: string;
  updatedAt?: string;
  rawLineCount: number;
  renderedLines: string[];
  note?: string;
}

export interface TruthConsoleInput {
  snapshot: TruthSnapshot;
  /** The EXACT serialized snapshot written to truth.json (US-DOSSIER-010). */
  snapshotJson: string;
  brand: TruthConsoleBrand;
  /** Backlog tab view model (US-DOSSIER-012). */
  backlog: BacklogVM;
  /** Spine station keys in lifecycle order (definition→…→retrospective). */
  spineKeys: string[];
  /** Cycle ledger rows, newest first (US-DOSSIER-013). */
  cycles: CycleLedgerRow[];
  /** Agents on this machine (US-DOSSIER-014). */
  agents: AgentPanelRow[];
  /** Release gate head + seven-dimension consistency panel (US-DOSSIER-015/FIX-391). */
  releasePanel: ReleasePanelVM;
  /** Pending delivery + shipped changelog + version history (US-DOSSIER-016). */
  releaseScope: ReleaseScopeVM;
  /** GitHub repo slug (owner/name) for PR links, when known. */
  githubSlug?: string;
  /** Skills catalog + strict-audit truth (US-DOSSIER-017). */
  skills: SkillsPanelVM;
  /**
   * US-DOSSIER-030 — the Casting grid view-model: scoped-role casting plus
   * legacy execute route sources (easy/default/hard/fallback) for compatibility,
   * and scenario roles (peer re-check, PR review, adversarial spar, onboard).
   */
  casting: CastingVM;
  /** FIX-284 — project-scoped git hooks, sourced from core.hooksPath/.git hooks. */
  gitHooks?: GitHooksVM;
  /** US-DOSSIER-044 — read-only live loop feed for the Now tab. */
  liveFeed?: LoopLiveFeedVM;
  /** FIX-1048 — href to the always-on loop digest (.roll/reports/loop/latest.html). */
  loopDigestHref?: string;
  /**
   * US-DOSSIER-033 — the Charter PROJECT TAB: a markdown browser over the
   * project's own charter docs (docs/*.md, the per-epic plan .md files, and the
   * guide map). Collected by the pure `collectCharter()`; doc bodies are baked
   * in at generate time (self-contained, offline-faithful) and the guide/en↔zh
   * pairs follow the EN/中 lang toggle.
   */
  charter: CharterVM;
  /**
   * US-DOSSIER-027 — projects on this machine, read from `~/.roll/projects.json`
   * (US-DOSSIER-028 populates it). Degrades gracefully: when absent/empty the
   * caller passes the current project alone (or omits this entirely), and the
   * switcher renders single-project, no-dropdown, never erroring.
   */
  projects?: ProjectRegistryEntry[];
  /** The current project's slug — marks the active row in the switcher. */
  currentSlug?: string;
  /**
   * US-DOSSIER-027 — which machine-global page (if any) is rendering this
   * header. On the console it is unset, so the project name is the home anchor
   * and no breadcrumb link is highlighted.
   */
  machinePage?: MachineNavLink["key"];
}

export const MONO = `font-family:'IBM Plex Mono',monospace;`;
export const C = {
  bg: "#eef1f5",
  ink: "#161b26",
  body: "#3a4252",
  sub: "#525c6e",
  dim: "#8a93a3",
  faint: "#9aa3b2",
  line: "#e0e5ee",
  hair: "#eef1f5",
  card: "#fff",
  blue: "#2d54e8",
  green: "#178a52",
  amber: "#c77d12",
  red: "#c2402a",
  purple: "#7048bc",
  slate: "#727c8e",
};

/** bi() with the console's own class names (kept compatible with roll-lang). */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function panelData<T>(slot: TruthSnapshotPanelSlot | undefined, fallback: T): T {
  if (slot?.data === undefined || slot.data === null) return fallback;
  return slot.data as T;
}

function withSnapshotPanels(input: TruthConsoleInput): TruthConsoleInput {
  const panels = input.snapshot.panels;
  if (panels === undefined) return input;
  return {
    ...input,
    skills: panelData(panels.skills, input.skills),
    casting: panelData(panels.casting, input.casting),
    charter: panelData(panels.charter, input.charter),
    gitHooks: panelData(panels.gitHooks, input.gitHooks),
    liveFeed: panelData(panels.liveFeed, input.liveFeed),
  };
}

/**
 * US-DOSSIER-034 — the shared `<!DOCTYPE><html>` opening, stamping a stable
 * per-project `data-roll-scope` so CONSOLE_SCRIPT can SCOPE its tab/section
 * persistence per project (the switcher never carries one project's open rows or
 * chosen tab into another). The scope is the project's slug when known, else its
 * brand name. The reading language (`roll-lang`) stays global, deliberately not
 * scoped. Used by every page head (console + machine pages) so the contract
 * holds everywhere.
 */
export function rollScope(input: { currentSlug?: string; brand: TruthConsoleBrand }): string {
  return input.currentSlug !== undefined && input.currentSlug !== "" ? input.currentSlug : input.brand.name;
}
export function htmlHead(scope: string): string {
  return (
    `<!DOCTYPE html>\n<html lang="zh-CN" data-roll-scope="${esc(scope)}">\n<head>\n<meta charset="UTF-8">\n`
  );
}

const SPECTRUM_META: Record<string, { color: string; mark: string; en: string; zh: string; subEn: string; subZh: string }> = {
  done: { color: C.green, mark: "✓", en: "DONE", zh: "已交付", subEn: "merged to main", subZh: "已合主干" },
  fail: { color: C.red, mark: "!", en: "DRIFT", zh: "漂移", subEn: "claim ≠ truth", subZh: "声明≠真相" },
  unknown: { color: C.slate, mark: "?", en: "UNKNOWN", zh: "未知", subEn: "no evidence", subZh: "无证据" },
  wip: { color: C.blue, mark: "●", en: "WIP", zh: "进行中", subEn: "being built", subZh: "建造中" },
  todo: { color: C.amber, mark: "○", en: "TODO", zh: "待办", subEn: "still a wish", subZh: "仍是愿望" },
  hold: { color: C.purple, mark: "⏸", en: "HOLD", zh: "挂起", subEn: "parked", subZh: "停放" },
};
const SPECTRUM_ORDER = ["done", "fail", "unknown", "wip", "todo", "hold"] as const;

function consoleVerdict(s: TruthSnapshot): { word: string; color: string; noteEn: string; noteZh: string } {
  const a = s.audit;
  if (a === undefined) return { word: "UNKNOWN", color: C.slate, noteEn: "no consistency audit yet", noteZh: "尚无一致性审计" };
  if (a.fail > 0) return { word: "FAIL", color: C.red, noteEn: "a dimension is failing", noteZh: "有维度不通过" };
  if (a.warn > 0) return { word: "WARN", color: C.amber, noteEn: "warnings to triage", noteZh: "有警告待处理" };
  return { word: "PASS", color: C.green, noteEn: "all dimensions clear", noteZh: "全维度通过" };
}

function chip(k: string, v: string, color: string): string {
  return (
    `<span style="${MONO}font-size:12px;display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1px solid ${color}33;border-radius:999px;color:${color};background:${color}0d;">` +
    `<b style="font-weight:600;">${k}</b>&nbsp;${v}</span>`
  );
}

export function kicker(text: string): string {
  return `<div style="${MONO}font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:${C.blue};font-weight:600;">${text}</div>`;
}

function sectionLabel(text: string): string {
  return `<span style="${MONO}font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:${C.faint};font-weight:600;">${text}</span>`;
}

function shortTs(iso: string | undefined): string {
  if (iso === undefined || iso === "") return "—";
  return iso.replace(/^\d{4}-/, "").replace("T", " ").replace(/:\d{2}Z$/, "Z");
}

function heartbeatStale(lane: TruthSnapshotLoopLane, generatedAt: string | undefined): boolean {
  if (lane.lastAt === undefined || generatedAt === undefined) return false;
  const last = Date.parse(lane.lastAt);
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return false;
  return now - last > 60_000;
}

// FIX-373: ONE shared track template so the column header and every row align
// pixel-for-pixel (Lane · 模式 · 周期 · 上次 · 下次).
// US-LOOP-118: the EVERY and NEXT columns are gone. Both described resident
// scheduling — a period parsed out of a plist, and a next fire predicted from it.
// Nothing fires on a schedule, so those two cells could only ever print "—" or a
// time that never arrives.
const HB_COLS = "grid-template-columns:2fr 1fr 1.2fr;";

/** FIX-373: aligned column headers above the heartbeat rows. */
function heartbeatHeader(): string {
  const h = (en: string, zh: string): string =>
    `<span style="${MONO}font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:${C.faint};">${bi(en, zh)}</span>`;
  return (
    `<div data-now-section="heartbeat-head" style="display:grid;${HB_COLS}align-items:center;gap:14px;padding:9px 18px;border-top:1px solid ${C.hair};background:#fafbfe;">` +
    `<span style="${MONO}font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:${C.faint};">Lane</span>` +
    h("mode", "模式") +
    h("last", "上次") +
    `</div>`
  );
}

function heartbeatRow(lane: TruthSnapshotLoopLane, generatedAt?: string): string {
  const on = lane.running;
  // codex r4: a leftover lane must never render as a red "zombie". Staleness means
  // "this should be beating and is not" — but a leftover plist is DEBRIS and is
  // expected to be silent, and its `lastAt` is old precisely because it stopped.
  const stale = !isLeftoverLane(lane) && heartbeatStale(lane, generatedAt);
  const dotColor = stale ? C.red : on ? C.green : "#cbd2dc";
  const dot = on
    ? `width:9px;height:9px;border-radius:50%;background:${dotColor};box-shadow:0 0 0 3px ${stale ? "rgba(210,59,59,.18)" : "rgba(23,138,82,.18)"};animation:beat 2.4s infinite;flex:none;`
    : `width:9px;height:9px;border-radius:50%;background:${dotColor};flex:none;`;
  const cell = (value: string, mono = false): string =>
    `<div style="${mono ? MONO : ""}font-size:12.5px;color:${C.body};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${value}</div>`;
  const stateLine = [
    stale ? bi("zombie", "僵尸") : on ? bi("running", "运行中") : bi("off", "未启用"),
    lane.status !== undefined ? esc(lane.status) : "",
    lane.scope !== undefined ? esc(lane.scope) : "",
  ].filter((s) => s !== "").join(" · ");
  return (
    `<div style="display:grid;${HB_COLS}align-items:center;gap:14px;padding:13px 18px;border-top:1px solid #f4f6f9;">` +
    `<div style="display:flex;align-items:center;gap:11px;min-width:0;"><span style="${dot}"></span>` +
    `<div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;color:${C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(lane.name)}</div>` +
    `<div style="${MONO}font-size:10.5px;color:${stale ? C.red : on ? C.green : C.faint};margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${stateLine}</div></div></div>` +
    cell(esc(lane.mode ?? "—")) +
    cell(shortTs(lane.lastAt), true) +
    `</div>`
  );
}

/**
 * US-LOOP-079l — the 3-state loop header (ACTIVE / DORMANT / PAUSED). A PURE
 * function of the snapshot's resolved `runState` (resolver precedence lives in
 * `resolveLoopRunState`: PAUSED > DORMANT > ACTIVE — this just renders the
 * verdict). DORMANT spells out the marker since/reason, each lane's load state
 * (AC2: "loop lane unloaded · zero idle · PR lane active · Dream lane active"),
 * and how the loop wakes. Bilingual EN/ZH on SEPARATE lines (project convention).
 */
function loopStateBanner(input: TruthConsoleInput): string {
  const loop = input.snapshot.loop;
  const state = loop?.runState ?? "ACTIVE";
  const lanes = loop?.lanes ?? [];
  const since = loop?.stateSince !== undefined && loop.stateSince !== "" ? esc(loop.stateSince) : "—";
  const reasonRaw = loop?.stateReason ?? "";
  const reason = reasonRaw !== "" ? ` · ${esc(reasonRaw)}` : "";

  const wrap = (accent: string, bg: string, enLines: string[], zhLines: string[]): string =>
    `<section data-loop-state="${state}" style="border:1px solid ${accent}33;border-left:3px solid ${accent};border-radius:12px;background:${bg};padding:14px 18px;margin:20px 0 4px;">` +
    enLines.map((l) => `<div style="${MONO}font-size:13px;color:${C.ink};line-height:1.7;">${l}</div>`).join("") +
    zhLines.map((l) => `<div style="${MONO}font-size:12px;color:${C.sub};line-height:1.7;">${l}</div>`).join("") +
    `</section>`;

  if (state === "DORMANT") {
    // US-LOOP-115: DORMANT is never WRITTEN any more, but an old dossier snapshot on
    // disk may carry it, so it must still render. What it must NOT do is promise wake
    // sources that no longer exist (new Todo / PR merge / dream scan / resume all
    // re-armed a lane). It is labelled as a historical state instead.
    return wrap(
      C.purple,
      "#f7f5fc",
      [
        `💤 <b>DORMANT</b> · since ${since}${reason}`,
        "historical state — resident scheduling is retired (US-LOOP-115)",
        "Delivery runs in the agent session that drives roll loop go",
      ],
      [
        `💤 休眠 · 自 ${since}${reason}`,
        "历史状态——常驻调度已退役(US-LOOP-115)",
        "交付由跑 roll loop go 的那个 agent 会话驱动",
      ],
    );
  }
  if (state === "PAUSED") {
    return wrap(
      C.amber,
      "#fdf8ef",
      [`⏸ <b>PAUSED</b>${since !== "—" ? ` · since ${since}` : ""}${reason}`, "Resume: roll loop resume"],
      [`⏸ 已暂停${since !== "—" ? ` · 自 ${since}` : ""}${reason}`, "恢复：roll loop resume"],
    );
  }
  // US-LOOP-118: "N/M lanes armed" counted installed timers. What an owner needs
  // to know is whether a session is driving right now, and whether leftover lanes
  // are still lying around.
  const goOpen = lanes.some((l) => l.source === "goal" && l.running);
  // Same marker-not-source rule as roll status: an old snapshot always listed the
  // retired lanes, so counting by source invents leftovers that are not there.
  const leftovers = lanes.filter(isLeftoverLane).length;
  const leftEn = leftovers > 0 ? ` · ${leftovers} leftover lane(s) to disarm` : "";
  const leftZh = leftovers > 0 ? ` · ${leftovers} 个残留 lane 待卸载` : "";
  return wrap(
    C.green,
    "#f1f9f4",
    [
      `● <b>ACTIVE</b> · ${goOpen ? "go session open" : "no open go session"}${leftEn}`,
      "Delivery advances only while an agent session drives it",
    ],
    [
      `● 活跃 · ${goOpen ? "go 会话进行中" : "无进行中的 go 会话"}${leftZh}`,
      "只有 agent 会话在驱动时,交付才会推进",
    ],
  );
}

/**
 * The pill above the repo loops table: what is actually driving, and what debris
 * is left. Replaces "N/M running", which counted retired lanes (codex r4).
 */
export function leftoverAndSessionCount(lanes: readonly TruthSnapshotLoopLane[]): string {
  const sessions = lanes.filter((l) => l.source === "goal" && l.running).length;
  const leftovers = lanes.filter(isLeftoverLane).length;
  const parts = [
    sessions > 0 ? bi(`${sessions} session driving`, `${sessions} 个会话在驱动`) : bi("no session driving", "无会话驱动"),
  ];
  if (leftovers > 0) parts.push(bi(`${leftovers} leftover`, `${leftovers} 个残留`));
  return parts.join(" · ");
}

function repoLoopsPanel(input: TruthConsoleInput): string {
  const lanes = input.snapshot.loop?.lanes ?? [];
  return (
    `<div style="display:flex;align-items:baseline;gap:12px;margin:24px 0 12px;flex-wrap:wrap;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;">${bi("Loops on this repo", "本仓 Loops")}</span>` +
    // codex r4: the subtitle used to read "backlog · PR · dream · go sessions",
    // advertising three retired lanes as live categories, and the pill counted
    // "N/M running" over them. Only go sessions run; the rest can only be debris.
    `<span style="${MONO}font-size:11.5px;color:${C.faint};">${bi("go sessions · leftover lanes", "go 会话 · 残留 lane")}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;min-width:16px;"></span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.dim};white-space:nowrap;">${leftoverAndSessionCount(lanes)}</span></div>` +
    `<section style="border:1px solid ${C.line};border-radius:14px;background:${C.card};overflow:hidden;margin:0 0 8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    (lanes.length > 0
      ? heartbeatHeader() + lanes.map((lane) => heartbeatRow(lane, input.snapshot.generatedAt)).join("")
      : `<div style="padding:16px 18px;font-size:12.5px;color:${C.faint};font-style:italic;">${bi("no loop lanes found for this repo", "未发现本仓 loop lane")}</div>`) +
    `</section>`
  );
}

function tile(opts: {
  tab: string;
  label: string;
  badge: string;
  badgeColor: string;
  metric: string;
  metricColor: string;
  metricSub: string;
  rows: Array<[string, string, string]>;
}): string {
  return (
    `<a href="#${opts.tab}" data-tab-link="${opts.tab}" style="border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:16px 18px 14px;box-shadow:0 1px 2px rgba(17,26,69,.05);cursor:pointer;text-decoration:none;display:block;">` +
    `<div style="display:flex;align-items:center;justify-content:space-between;">` +
    `<span style="${MONO}font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:${C.faint};font-weight:600;">${opts.label}</span>` +
    `<span style="${MONO}font-size:10px;padding:2px 8px;border-radius:999px;border:1px solid ${opts.badgeColor}44;color:${opts.badgeColor};">${opts.badge}</span></div>` +
    `<div style="display:flex;align-items:baseline;gap:8px;margin:13px 0 12px;">` +
    `<span style="font-size:30px;font-weight:700;letter-spacing:-.02em;color:${opts.metricColor};font-variant-numeric:tabular-nums;${MONO}">${opts.metric}</span>` +
    `<span style="font-size:11.5px;color:${C.dim};line-height:1.25;">${opts.metricSub}</span></div>` +
    `<dl style="display:grid;grid-template-columns:1fr auto;gap:6px 12px;margin:0;${MONO}font-size:11.5px;">` +
    opts.rows.map(([k, v, color]) => `<dt style="color:${C.dim};">${k}</dt><dd style="margin:0;color:${color};font-weight:600;text-align:right;">${v}</dd>`).join("") +
    `</dl></a>`
  );
}

function flattenStories(backlog: BacklogVM): BacklogStoryVM[] {
  return [...backlog.shipping, ...backlog.settled].flatMap((epic) => epic.stories);
}

function loopLiveFeedPanel(input: TruthConsoleInput): string {
  const feed: LoopLiveFeedVM = input.liveFeed ?? {
    sourcePath: ".roll/loop/live.log",
    relativeHref: "../loop/live.log",
    agent: "claude",
    status: "idle",
    generatedAt: input.snapshot.generatedAt,
    rawLineCount: 0,
    renderedLines: [],
    note: "live feed not collected during this index run",
  };
  const color = feed.status === "live" ? C.green : feed.status === "paused" ? C.amber : C.slate;
  const status = feed.status === "live" ? bi("live", "实时") : feed.status === "paused" ? bi("paused", "暂停") : bi("idle", "空闲");
  // FIX-373: readable Live Stream — keep a larger recent window (was 16) and
  // render it taller with mono word-wrap (see the enlarged <ol> below).
  const lines = feed.renderedLines.slice(-40);
  const empty = feed.note ?? (feed.status === "idle" ? "idle — no active loop stream" : "paused — live stream unavailable");
  return (
    `<section data-now-section="live-stream" data-live-feed="true" data-live-src="${esc(feed.relativeHref)}" data-live-readonly="true" data-live-agent="${esc(feed.agent)}" style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:14px 0 14px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid ${C.hair};">` +
    sectionLabel(bi("Loop live stream", "Loop 实时流")) +
    `<span data-live-status="true" style="${MONO}font-size:10px;padding:2px 8px;border-radius:999px;border:1px solid ${color}44;color:${color};">${status}</span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.dim};">${bi("same source as roll loop watch", "与 roll loop watch 同源")}</span>` +
    `<span style="flex:1;"></span>` +
    `<a href="#loop" data-tab-link="loop" style="${MONO}font-size:11.5px;color:${C.blue};text-decoration:none;">${bi("open loop", "打开循环页")} →</a></div>` +
    `<div style="padding:16px 18px 18px;background:#0f1722;color:#d8dee9;">` +
    `<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;${MONO}font-size:10.5px;color:#93a0b8;">` +
    `<span>${bi("agent", "agent")} ${esc(feed.agent)}</span><span>${bi("raw lines", "原始行")} ${feed.rawLineCount}</span><span>${bi("updated", "更新")} ${shortTs(feed.updatedAt ?? feed.generatedAt)}</span></div>` +
    (lines.length > 0
      ? `<ol data-live-lines="true" style="list-style:none;margin:0;padding:0;display:grid;gap:4px;max-height:420px;overflow:auto;">${lines
          .map((line) => `<li style="${MONO}font-size:12.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:#d8dee9;">${esc(line)}</li>`)
          .join("")}</ol>`
      : `<div data-live-lines="true" style="${MONO}font-size:12.5px;line-height:1.7;color:#93a0b8;font-style:italic;">${esc(empty)}</div>`) +
    `<div style="margin-top:12px;${MONO}font-size:10px;color:#748196;">${esc(feed.sourcePath)} · ${bi("read-only polling, no loop writes", "只读轮询，不写 loop")}</div>` +
    `</div></section>`
  );
}

/**
 * FIX-373 — the deep-link target for a backlog story: its OWN card page,
 * `features/<epic>/<id>/index.html`, expressed relative to `features/index.html`
 * (so `<epic>/<id>/index.html`). Replaces the old `#backlog/<state>` hrefs that
 * only re-filtered the Backlog tab instead of opening the card.
 */
function storyCardHref(story: BacklogStoryVM): string {
  return `${encodeURIComponent(story.epic)}/${encodeURIComponent(story.id)}/index.html`;
}

const NEEDS_CTA_EN =
  "Held / failed — the loop will not touch these. Your call: keep going, scope down, or archive.";
const NEEDS_CTA_ZH = "挂起/失败,循环不会自动碰——待你裁决：继续/改小/归档。";
const ONDECK_CTA_EN = "When idle the loop pulls cards from here in order; click any to open its card page.";
const ONDECK_CTA_ZH = "循环空闲时会从这里按序取卡;点任意一张直接进它的卡页。";

// ── Pulse badge (US-DEMO-001) ────────────────────────────────────────────────
const SPARK_CHARS_WEB = " ▁▂▃▄▅▆▇█";

function sparklineWeb(values: number[]): string {
  const max = Math.max(...values, 1);
  return values
    .map((v) => SPARK_CHARS_WEB[Math.min(Math.round((v / max) * 8), 8)] ?? SPARK_CHARS_WEB[8])
    .join("");
}

function nowPulseBadge(input: TruthConsoleInput): string {
  const s = input.snapshot;
  const cyc = s.cycle;
  const stories = s.stories ?? [];
  const merged = stories.filter((r) => r.ladder === "merged" || r.ladder === "attested").length;
  const attested = stories.filter((r) => r.ladder === "attested").length;
  const cycles = cyc?.cycles3d ?? 0;

  // Sparkline from spectrum
  const spectrumOrder: Array<keyof typeof s.story.spectrum> = ["done", "fail", "unknown", "wip", "todo", "hold"];
  const sv = spectrumOrder.map((k) => s.story.spectrum[k]);
  const bars = sparklineWeb(sv);

  // Pulse severity — green when cycles active and merged > todo, amber when idle
  const pulseColor = cycles > 0 ? C.green : C.amber;

  return (
    `<section data-now-section="pulse" style="border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:16px 18px;margin:8px 0 14px;box-shadow:0 1px 2px rgba(17,26,69,.05);display:flex;align-items:center;gap:20px;flex-wrap:wrap;">` +
    `<div style="display:flex;align-items:center;gap:10px;flex:none;">` +
    `<span style="font-size:20px;line-height:1;">⚡</span>` +
    `<div>` +
    `<div style="font-size:14px;font-weight:600;color:${C.ink};line-height:1.3;">${bi("Today's pulse", "今日脉搏")}</div>` +
    `<div style="${MONO}font-size:10px;color:${C.faint};margin-top:2px;">${bi("same source as", "同源 ")}<code style="${MONO}font-size:9.5px;color:${C.blue};">roll pulse</code></div>` +
    `</div></div>` +
    `<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;flex:1;min-width:0;">` +
    `<span style="${MONO}font-size:13px;color:${C.sub};">${bi("cycles", "周期")} <b style="color:${pulseColor};font-weight:700;">${cycles}</b></span>` +
    `<span style="${MONO}font-size:13px;color:${C.sub};">${bi("merged", "已合")} <b style="color:${C.green};font-weight:700;">${merged}</b></span>` +
    `<span style="${MONO}font-size:13px;color:${C.sub};">${bi("attested", "已验收")} <b style="color:${C.blue};font-weight:700;">${attested}</b></span>` +
    `<span style="${MONO}font-size:18px;letter-spacing:1px;color:${C.dim};flex:none;" title="story spectrum distribution">${esc(bars)}</span>` +
    `</div></section>`
  );
}

function nowOpsPanel(input: TruthConsoleInput): string {
  const lanes = input.snapshot.loop?.lanes ?? [];
  // FIX-373: a cycle is "running" ONLY when the live stream is actively flowing —
  // i.e. a cycle is mid-flight writing `.roll/loop/live.log` (the live-feed status
  // is "live"). A merely-SCHEDULED heartbeat lane (plist loaded) is NOT a running
  // cycle, and the latest runs.jsonl row is history, not a live cycle: a
  // `failed`/`done` last cycle (e.g. FIX-339, hours ago) must read as idle + shown
  // under "last run", never "a cycle is running". The heartbeat section still
  // reports each lane's own scheduled/idle state separately.
  const live = input.liveFeed?.status === "live";
  const latest = input.cycles[0];

  // History line for the most-recent recorded cycle, shown honestly as the LAST
  // run (never as the current one). Deep-links to that story's own card page.
  const histStory = latest !== undefined && latest.storyId !== "" ? flattenStories(input.backlog).find((s) => s.id === latest.storyId) : undefined;
  const histHref = histStory !== undefined ? storyCardHref(histStory) : undefined;
  const histVerdict = latest !== undefined ? (VERDICT_ZH[latest.verdict] ?? latest.verdict) : "";
  const histColor = latest !== undefined ? (VERDICT_COLORS[latest.verdict] ?? C.slate) : C.slate;
  const histTime = latest !== undefined && latest.tsSec > 0 ? new Date(latest.tsSec * 1000).toISOString().replace(/^\d{4}-/, "").replace("T", " ").replace(/:\d{2}\.?\d*Z$/, "Z") : "";
  const histId = latest !== undefined && latest.storyId !== "" ? latest.storyId : (latest?.cycleId ?? "—");
  const historyLine =
    latest === undefined
      ? `<div style="${MONO}font-size:12px;color:${C.faint};margin-top:10px;">${bi("no recorded cycle yet", "尚无历史周期")}</div>`
      : `<div data-now-section="live-cycle-history" style="${MONO}font-size:12px;color:${C.dim};margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">` +
        `<span>${bi("last run", "最近一次")} ·</span>` +
        (histHref !== undefined
          ? `<a href="${histHref}" style="color:${C.blue};font-weight:600;text-decoration:none;">${esc(histId)}</a>`
          : `<span style="color:${C.sub};font-weight:600;">${esc(histId)}</span>`) +
        `<span style="${MONO}font-size:10px;padding:1px 8px;border-radius:999px;border:1px solid ${histColor}44;color:${histColor};">${histVerdict}</span>` +
        (histTime !== "" ? `<span>${esc(histTime)}</span>` : "") +
        `</div>`;

  // When live, show the running cycle's tape; when idle, no tape (idle state line).
  const runningTape =
    live && latest !== undefined && latest.tape.length > 0
      ? `<div style="display:flex;flex-wrap:nowrap;overflow-x:auto;gap:0;margin-top:14px;padding-bottom:4px;">${latest.tape
          .map((seg, i) => tapeSegment(seg, i === latest.tape.length - 1))
          .join("")}</div>`
      : "";
  const liveDot = live
    ? `width:10px;height:10px;border-radius:50%;flex:none;background:${C.green};box-shadow:0 0 0 4px rgba(23,138,82,.18);animation:beat 2.4s infinite;`
    : `width:10px;height:10px;border-radius:50%;flex:none;background:${C.slate};`;
  const liveState = live
    ? `<span style="${MONO}font-weight:600;color:${C.green};">${bi("a cycle is running", "正在跑一个周期")}${latest?.storyId ? ` · ${esc(latest.storyId)}` : ""}</span>`
    : `<span style="${MONO}font-weight:600;color:${C.slate};">${bi("no cycle is running", "当前没有周期在跑")}</span>`;
  const liveCard =
    `<section data-now-section="live-cycle" style="border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:14px 18px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="display:flex;align-items:center;gap:10px;">${sectionLabel(bi("Live cycle", "实时周期"))}` +
    `<span style="${MONO}font-size:10px;padding:2px 8px;border-radius:999px;border:1px solid ${(live ? C.green : C.slate)}44;color:${live ? C.green : C.slate};">${live ? bi("running", "运行中") : bi("idle", "空闲")}</span>` +
    `<span style="flex:1;"></span><a href="#loop" data-tab-link="loop" style="${MONO}font-size:11.5px;color:${C.blue};text-decoration:none;">${bi("open loop", "打开循环页")} →</a></div>` +
    `<div style="display:flex;align-items:center;gap:12px;margin-top:13px;"><span style="${liveDot}"></span>${liveState}</div>` +
    // History is always shown idle; suppressed while a cycle is genuinely live.
    (live ? "" : historyLine) +
    runningTape +
    `</section>`;

  const stories = flattenStories(input.backlog);

  // US-OBS-018: On-Deck is backlog-primary in the shared snapshot. Older
  // snapshots fall back to the pre-existing backlog VM so historical fixtures
  // remain renderable.
  const onDeckAll = input.snapshot.onDeck?.rows ?? stories.filter((s) => s.state === "todo").map((story) => ({
    id: story.id,
    epic: story.epic,
    title: story.title,
    href: storyCardHref(story),
  }));
  const onDeckCount = input.snapshot.onDeck?.count ?? onDeckAll.length;
  const onDeckRows = onDeckAll.slice(0, 6);
  const onDeck =
    `<section data-now-section="on-deck" style="border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:14px 18px 0;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="display:flex;align-items:center;gap:10px;">${sectionLabel(bi("On deck", "下一步要做"))}` +
    `<span style="${MONO}font-size:10px;padding:2px 9px;border-radius:999px;color:${onDeckCount > 0 ? C.green : C.slate};background:${onDeckCount > 0 ? "#e6f6ef" : "#eef1f7"};font-weight:600;">${onDeckCount}</span></div>` +
    (onDeckRows.length > 0
      ? `<div style="display:grid;gap:4px;margin-top:11px;">${onDeckRows
          .map(
            (story) =>
              `<a href="${esc(story.href)}" style="display:block;text-decoration:none;padding:9px 0;border-top:1px solid ${C.hair};">` +
              `<span style="${MONO}font-size:12px;color:${C.blue};font-weight:600;">${esc(story.id)}</span>` +
              `<span style="display:block;color:${C.sub};font-size:12.5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(story.title)}</span></a>`,
          )
          .join("")}</div>`
      : `<div style="${MONO}font-size:12px;color:${C.faint};font-style:italic;margin-top:10px;">${bi("no queued picks found", "没有待选队列")}</div>`) +
    `<div style="font-size:12px;color:${C.dim};padding:11px 0 12px;border-top:1px solid ${C.hair};margin-top:4px;">${bi(ONDECK_CTA_EN, ONDECK_CTA_ZH)}</div>` +
    `</section>`;

  // FIX-373: Needs-you — real total, fail(red)/hold(amber) split, one-line CTA,
  // each row deep-linked to its own card page.
  const failRows = stories.filter((s) => s.state === "fail");
  const holdRows = stories.filter((s) => s.state === "hold");
  const needsAll = [...failRows, ...holdRows];
  const SHOW = 6;
  const needsRows = needsAll.slice(0, SHOW);
  const truncated = needsAll.length - needsRows.length;
  const needsBadge = needsAll.length > 0 ? (failRows.length > 0 ? C.red : C.amber) : C.green;
  const needsBadgeBg = needsAll.length > 0 ? (failRows.length > 0 ? "#fbe9e7" : "#fbf1df") : "#e6f6ef";
  const tag = (state: "fail" | "hold"): string =>
    state === "fail"
      ? `<span style="${MONO}font-size:10px;padding:1px 7px;border-radius:999px;color:${C.red};background:#fbe9e7;float:right;">${bi("fail", "失败")}</span>`
      : `<span style="${MONO}font-size:10px;padding:1px 7px;border-radius:999px;color:${C.amber};background:#fbf1df;float:right;">${bi("hold", "挂起")}</span>`;
  const needsCta =
    needsAll.length > 0
      ? `<div style="font-size:12px;color:${C.dim};padding:11px 0 12px;border-top:1px solid ${C.hair};margin-top:4px;">${bi(NEEDS_CTA_EN, NEEDS_CTA_ZH)} ` +
        bi(
          `${needsAll.length} total${truncated > 0 ? `, ${needsRows.length} shown` : ", none truncated"}.`,
          `共 ${needsAll.length} 项${truncated > 0 ? `,显示 ${needsRows.length} 项` : ",无截断"}。`,
        ) +
        `</div>`
      : "";
  const needs =
    `<section data-now-section="needs-you" style="border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:14px 18px ${needsAll.length > 0 ? "0" : "14px"};box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="display:flex;align-items:center;gap:10px;">${sectionLabel(bi("Needs you", "需要你处理"))}` +
    `<span data-needs-total="${needsAll.length}" style="${MONO}font-size:10px;padding:2px 9px;border-radius:999px;color:${needsBadge};background:${needsBadgeBg};font-weight:600;">${needsAll.length}</span>` +
    (failRows.length > 0 ? `<span style="${MONO}font-size:10.5px;color:${C.red};">${failRows.length} ${bi("fail", "失败")}</span>` : "") +
    (holdRows.length > 0 ? `<span style="${MONO}font-size:10.5px;color:${C.amber};">${holdRows.length} ${bi("hold", "挂起")}</span>` : "") +
    `</div>` +
    (needsRows.length > 0
      ? `<div style="display:grid;gap:4px;margin-top:11px;">${needsRows
          .map(
            (story) =>
              `<a href="${storyCardHref(story)}" style="display:block;text-decoration:none;padding:9px 0;border-top:1px solid ${C.hair};">` +
              tag(story.state as "fail" | "hold") +
              `<span style="${MONO}font-size:12px;color:${story.state === "fail" ? C.red : C.amber};font-weight:600;">${esc(story.id)}</span>` +
              `<span style="display:block;color:${C.sub};font-size:12.5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(story.title)}</span></a>`,
          )
          .join("")}</div>`
      : `<div style="${MONO}font-size:12px;color:${C.green};font-style:italic;margin-top:10px;">${bi("nothing is blocked or failed", "没有阻塞或失败项")}</div>`) +
    needsCta +
    `</section>`;

  return (
    `<section data-now-section="live-cycle-wrap" style="margin:20px 0 14px;">${liveCard}</section>` +
    `<section data-now-section="operations" style="display:grid;grid-template-columns:1.5fr 1fr;gap:14px;margin:14px 0;align-items:start;">${onDeck}${needs}</section>`
  );
}

function nowTab(input: TruthConsoleInput): string {
  const s = input.snapshot;
  const v = consoleVerdict(s);
  const a = s.audit;
  const lanes = s.loop?.lanes ?? [];
  const spectrum = s.story.spectrum;
  const total = s.story.total || 1;
  const mergedPct = Math.round((spectrum.done / total) * 100);

  const runningCount = lanes.filter((l) => l.running).length;
  const hbPillColor = runningCount > 0 ? C.amber : C.slate;
  const hbPillBg = runningCount > 0 ? "#fbf1df" : "#eef1f7";
  const heartbeat =
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:20px 0 14px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="display:flex;align-items:center;gap:11px;padding:13px 18px;border-bottom:1px solid ${C.hair};">` +
    sectionLabel(bi("Loop heartbeat", "循环心跳")) +
    `<span style="${MONO}font-size:11px;padding:2px 9px;border-radius:999px;color:${hbPillColor};background:${hbPillBg};font-weight:600;white-space:nowrap;">${runningCount}/${lanes.length} ${bi("running", "运行中")}</span>` +
    `<span style="flex:1;"></span>` +
    `<a href="#loop" data-tab-link="loop" style="${MONO}font-size:11.5px;color:${C.blue};cursor:pointer;text-decoration:none;">${bi("open loop", "打开循环页")} →</a></div>` +
    (lanes.length > 0
      ? heartbeatHeader() + lanes.map((lane) => heartbeatRow(lane, s.generatedAt)).join("")
      : `<div style="padding:14px 18px;font-size:12.5px;color:${C.faint};font-style:italic;">${bi("nothing is scheduled — delivery runs in an agent session", "没有任何定时任务——交付在 agent 会话里进行")}</div>`) +
    `</section>`;

  const verdictStrip =
    `<section style="margin:22px 0 16px;display:flex;align-items:stretch;gap:0;border:1px solid ${C.line};border-left:4px solid ${v.color};border-radius:12px;background:${C.card};overflow:hidden;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="padding:16px 20px;display:flex;flex-direction:column;justify-content:center;gap:3px;border-right:1px solid ${C.hair};min-width:182px;">` +
    sectionLabel(bi("Truth verdict", "真相判定")) +
    `<div style="display:flex;align-items:center;gap:9px;"><span data-truth="verdict" style="font-size:25px;font-weight:700;letter-spacing:-.01em;color:${v.color};">${v.word}</span></div>` +
    `<div style="font-size:11.5px;color:${C.dim};">${bi(v.noteEn, v.noteZh)}</div></div>` +
    `<div style="flex:1 1 auto;display:flex;align-items:center;flex-wrap:wrap;gap:9px;padding:14px 20px;">` +
    (a !== undefined
      ? chip("fail", String(a.fail), a.fail > 0 ? C.red : C.green) + chip("warn", String(a.warn), a.warn > 0 ? C.amber : C.green) + chip("?", String(a.unknown), C.slate)
      : `<span style="font-size:12px;color:${C.faint};font-style:italic;">${bi("no audit collected", "未采集审计")}</span>`) +
    `</div>` +
    `<div style="display:flex;flex:none;flex-direction:column;justify-content:center;gap:4px;padding:14px 20px;border-left:1px solid ${C.hair};${MONO}font-size:10.5px;color:${C.faint};text-align:right;white-space:nowrap;">` +
    `<div>${bi("generated", "生成")} <span style="color:#5b6478;">${shortTs(s.generatedAt)}</span></div>` +
    `<div>${bi("collected", "采集")} <span style="color:#5b6478;">${shortTs(s.collectedAt)}</span></div></div></section>`;

  const cyc = s.cycle;
  const rel = s.release;
  const relColor = rel?.verdict === "pass" ? C.green : rel?.verdict === "fail" ? C.red : rel?.verdict === "warn" ? C.amber : C.slate;
  const tiles =
    `<section style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:0 0 8px;">` +
    tile({
      tab: "backlog",
      label: bi("Story", "故事"),
      badge: bi("backlog", "待办页"),
      badgeColor: C.blue,
      metric: String(s.story.total),
      metricColor: C.ink,
      metricSub: bi("stories on the board", "面板上的故事"),
      rows: [
        [bi("done", "已交付"), String(spectrum.done), C.green],
        [bi("todo", "待办"), String(spectrum.todo), C.amber],
        [bi("legacy", "历史交付"), String(s.story.legacy), C.slate],
      ],
    }) +
    tile({
      tab: "loop",
      label: bi("Cycle", "周期"),
      badge: "72h",
      badgeColor: C.blue,
      metric: cyc !== undefined ? String(cyc.cycles3d) : "—",
      metricColor: C.ink,
      metricSub: bi("cycles in the window", "窗口内周期"),
      rows: [
        [bi("failed", "失败"), cyc !== undefined ? String(cyc.failed3d) : "—", cyc !== undefined && cyc.failed3d > 0 ? C.red : C.green],
        [bi("cost", "花费"), cyc !== undefined ? `$${cyc.costUsd3d.toFixed(2)}` : "—", C.body],
      ],
    }) +
    tile({
      tab: "release",
      label: bi("Release", "发版"),
      badge: rel?.verdict ?? "?",
      badgeColor: relColor,
      metric: rel?.latestTag ?? "—",
      metricColor: C.ink,
      metricSub: bi("latest gated tag", "最近过闸 tag"),
      rows: [
        [bi("gate", "闸门"), rel?.verdict ?? "—", relColor],
        [bi("waiver", "豁免"), rel?.waiver ?? "—", rel?.waiver !== undefined ? C.amber : C.body],
      ],
    }) +
    `</section>`;

  const tallyCards = SPECTRUM_ORDER.map((k) => {
    const meta = SPECTRUM_META[k] as NonNullable<(typeof SPECTRUM_META)[string]>;
    const n = spectrum[k];
    return (
      `<a href="#backlog/${k}" data-tab-link="backlog" data-prefilter="${k}" title="${meta.en} · ${meta.zh}" ` +
      `style="position:relative;display:block;padding:14px 14px 12px;text-decoration:none;border-left:1px solid ${C.hair};cursor:pointer;">` +
      `<span style="position:absolute;left:0;top:0;height:3px;width:100%;background:${meta.color};opacity:${n > 0 ? "1" : ".25"};"></span>` +
      `<span style="${MONO}font-size:11px;color:${meta.color};">${meta.mark}</span>` +
      `<div data-truth="spectrum-${k}" style="font-size:30px;font-weight:700;letter-spacing:-.02em;color:${n > 0 ? C.ink : "#c3cad6"};font-variant-numeric:tabular-nums;margin:5px 0 1px;${MONO}">${n}</div>` +
      `<div style="${MONO}font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:${C.slate};font-weight:600;">${bi(meta.en, meta.zh)}</div>` +
      `<div style="font-size:10px;color:${C.faint};margin-top:3px;min-height:12px;">${bi(meta.subEn, meta.subZh)}</div></a>`
    );
  }).join("");

  const bar = SPECTRUM_ORDER.filter((k) => spectrum[k] > 0)
    .map((k) => {
      const meta = SPECTRUM_META[k] as NonNullable<(typeof SPECTRUM_META)[string]>;
      return `<span title="${meta.en} ${spectrum[k]}" style="flex:${spectrum[k]} 1 0%;background:${meta.color};"></span>`;
    })
    .join("");
  const legend = SPECTRUM_ORDER.map((k) => {
    const meta = SPECTRUM_META[k] as NonNullable<(typeof SPECTRUM_META)[string]>;
    return `<span style="display:inline-flex;align-items:center;gap:6px;"><i style="width:9px;height:9px;border-radius:3px;background:${meta.color};display:inline-block;"></i>${bi(meta.en, meta.zh)} ${spectrum[k]}</span>`;
  }).join("");

  const statusBoard =
    `<section style="border:1px solid ${C.line};border-radius:14px;background:${C.card};overflow:hidden;margin:14px 0 8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="display:grid;grid-template-columns:repeat(6,1fr);">${tallyCards}</div>` +
    `<div style="padding:16px 18px 15px;border-top:1px solid ${C.hair};background:#fbfcfe;">` +
    `<div style="display:flex;height:13px;border-radius:999px;overflow:hidden;border:1px solid ${C.line};background:${C.card};">${bar}</div>` +
    `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:9px;${MONO}font-size:11.5px;color:${C.dim};">` +
    `<span data-truth="total">${s.story.total} ${bi("stories", "个故事")}</span>` +
    `<span><b data-truth="merged-pct" style="color:${C.green};font-weight:600;">${mergedPct}%</b> ${bi("merged to main", "已合入主干")}</span></div>` +
    `<div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:11px;${MONO}font-size:11px;color:${C.slate};">${legend}</div>` +
    `</div></section>` +
    (input.loopDigestHref !== undefined
      ? `<p style="margin:4px 0 0;font-size:12px;"><a href="${esc(input.loopDigestHref)}" style="color:${C.blue};">${bi("Loop Digest", "循环摘要")}</a> ${bi("· always-on loop summary", "· 持续刷新的循环摘要")}</p>\n`
      : "");

  return (
    `<div id="freshness-banner" data-generated="${esc(s.generatedAt)}" style="display:none;margin:16px 0 0;padding:10px 16px;border:1px solid ${C.amber}55;border-radius:10px;background:${C.amber}0d;${MONO}font-size:12px;color:${C.amber};">` +
    bi("This snapshot is stale — run <code>roll index</code> to refresh.", "数据已过期——运行 <code>roll index</code> 刷新。") +
    `</div>` +
    `<div style="padding:34px 0 8px;">` +
    kicker(`${esc(input.brand.name)} · ${bi("Truth Console", "真相控制台")}`) +
    `<h1 style="margin:10px 0 0;font-size:33px;line-height:1.1;font-weight:700;letter-spacing:0;color:${C.ink};">${bi("Now", "现在")}</h1>` +
    `<p style="margin:12px 0 0;max-width:660px;font-size:15.5px;line-height:1.6;color:${C.sub};">` +
    bi("What is happening right now: live cycle, heartbeat, next picks, items needing you, and where things stand.", "现在发生什么：实时周期、心跳、下批候选、需要你处理的项，以及当前总体站位。") +
    `</p></div>` +
    nowPulseBadge(input) +
    nowOpsPanel(input) +
    loopLiveFeedPanel(input) +
    heartbeat +
    `<div data-now-section="where-things-stand">` +
    verdictStrip +
    tiles +
    statusBoard +
    `</div>`
  );
}

const VERDICT_COLORS: Record<string, string> = {
  delivered: C.green,
  pending_merge: C.amber, // PR open, merge pending — in-flight (amber), not red
  // FIX-351: gates passed but publish did not land (work committed locally) —
  // a NEUTRAL blue, clearly distinct from `failed` (red). The dashboard reads
  // it as "ran locally, not published", never as a failure.
  unpublished: C.blue,
  reverted: C.amber,
  failed: C.red,
  blocked: C.purple,
  idle: "#cbd2dc",
  unknown: C.slate,
};
const VERDICT_ZH: Record<string, string> = {
  delivered: "已交付",
  pending_merge: "待合并",
  unpublished: "未发布", // FIX-351: 闸通过但未发布(本地已提交)——中性,非失败
  reverted: "已回滚",
  failed: "失败",
  blocked: "被阻塞",
  idle: "空转",
  unknown: "未知",
};
const SEG_COLORS: Record<CycleTapeSegment["state"], string> = { pass: C.green, fail: C.red, idle: "#cbd2dc", unknown: "#c3cad6" };

function tapeSegment(seg: CycleTapeSegment, last: boolean): string {
  const color = SEG_COLORS[seg.state];
  return (
    `<div style="flex:none;width:120px;min-width:120px;">` +
    `<div style="display:flex;align-items:center;"><span style="width:11px;height:11px;border-radius:50%;background:${color};flex:none;"></span>` +
    (last ? "" : `<span style="flex:1;height:2px;background:#e4e8ef;"></span>`) +
    `</div>` +
    `<div style="margin-top:9px;${MONO}font-size:11px;font-weight:600;color:${seg.state === "fail" ? C.red : C.sub};">${esc(seg.key)}</div>` +
    `<div style="margin-top:3px;${MONO}font-size:10.5px;color:${C.dim};line-height:1.35;padding-right:12px;">${esc(seg.detail)}</div></div>`
  );
}

function toolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

function toolCostAmount(row: CycleLedgerRow["toolCosts"][number]): string {
  const currency = row.currency.trim().toUpperCase();
  const amount = Number.isFinite(row.estimatedCost) ? row.estimatedCost.toFixed(2) : "0.00";
  if (currency === "USD") return `$${amount} USD`;
  if (currency === "CNY" || currency === "RMB") return `¥${amount} ${currency}`;
  return `${amount} ${row.currency}`;
}

function toolCostBreakdown(costs: readonly CycleLedgerRow["toolCosts"][number][]): string {
  if (costs.length === 0) return "";
  return costs.map((row) => `${String(row.toolId)} ${toolCostAmount(row)}`).join(" · ");
}

function toolAssetHref(path: string): string {
  const marker = "/.roll/";
  const idx = path.indexOf(marker);
  if (idx >= 0) return `../${path.slice(idx + marker.length)}`;
  if (path.startsWith(".roll/")) return `../${path.slice(".roll/".length)}`;
  return path;
}

function toolPre(labelEn: string, labelZh: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return (
    `<dt style="color:${C.faint};">${bi(labelEn, labelZh)}</dt>` +
    `<dd style="margin:0;"><pre style="margin:0;max-height:120px;overflow:auto;white-space:pre-wrap;border:1px solid ${C.hair};border-radius:6px;background:#f8fafc;padding:7px 8px;color:${C.ink};">${esc(value)}</pre></dd>`
  );
}

function cycleToolRows(cy: CycleLedgerRow): string {
  if (cy.toolSummary === "" && cy.toolTimeline.length === 0) return "";
  const costs = toolCostBreakdown(cy.toolCosts);
  const rows = cy.toolTimeline
    .map((tool) => {
      const accent = tool.ok ? C.green : C.red;
      const mark = tool.ok ? "✓" : "✗";
      const status = tool.ok ? "ok" : (tool.errorCode ?? "unknown");
      const dur = toolDuration(tool.durationMs);
      const shotHref = tool.screenshotPath !== undefined ? toolAssetHref(tool.screenshotPath) : undefined;
      const dumpHref = tool.dumpPath !== undefined ? toolAssetHref(tool.dumpPath) : undefined;
      return (
        `<details class="tool-row" style="border:1px solid ${C.line};border-left:3px solid ${accent};border-radius:8px;background:${C.card};overflow:hidden;">` +
        `<summary style="display:grid;grid-template-columns:18px 1fr auto auto;align-items:center;gap:10px;padding:8px 10px;cursor:pointer;list-style:none;">` +
        `<span style="${MONO}font-size:12px;color:${accent};font-weight:700;">${mark}</span>` +
        `<span style="${MONO}font-size:12px;color:${C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(tool.label)}</span>` +
        `<span style="${MONO}font-size:11px;color:${C.dim};">${esc(dur)}</span>` +
        `<span style="${MONO}font-size:10px;color:${accent};border:1px solid ${accent}44;border-radius:999px;padding:2px 7px;">${esc(status)}</span>` +
        `</summary>` +
        `<dl style="display:grid;grid-template-columns:86px 1fr;gap:6px 10px;margin:0;padding:8px 12px 10px;border-top:1px solid ${C.hair};${MONO}font-size:11px;color:${C.dim};">` +
        `<dt style="color:${C.faint};">${bi("tool", "工具")}</dt><dd style="margin:0;color:${C.ink};">${esc(tool.toolId)}</dd>` +
        `<dt style="color:${C.faint};">${bi("label", "标签")}</dt><dd style="margin:0;color:${C.ink};">${esc(tool.label)}</dd>` +
        `<dt style="color:${C.faint};">${bi("duration", "耗时")}</dt><dd style="margin:0;color:${C.ink};">${esc(dur)}</dd>` +
        (tool.exitCode !== undefined ? `<dt style="color:${C.faint};">${bi("exit", "退出码")}</dt><dd style="margin:0;color:${C.ink};">${tool.exitCode}</dd>` : "") +
        (tool.retryCount !== undefined ? `<dt style="color:${C.faint};">${bi("retries", "重试")}</dt><dd style="margin:0;color:${C.ink};">${tool.retryCount}</dd>` : "") +
        (dumpHref !== undefined ? `<dt style="color:${C.faint};">${bi("dump", "转储")}</dt><dd style="margin:0;"><a href="${esc(dumpHref)}" style="color:${C.blue};text-decoration:none;">${esc(tool.dumpPath ?? "")}</a></dd>` : "") +
        (shotHref !== undefined
          ? `<dt style="color:${C.faint};">${bi("thumbnail", "缩略图")}</dt><dd style="margin:0;"><a href="${esc(shotHref)}" style="display:inline-block;border:1px solid ${C.line};border-radius:7px;overflow:hidden;background:#f8fafc;"><img src="${esc(shotHref)}" alt="${esc(tool.label)}" style="display:block;width:180px;max-width:100%;height:104px;object-fit:cover;"></a></dd>`
          : "") +
        toolPre("stdout", "标准输出", tool.stdout) +
        toolPre("stderr", "标准错误", tool.stderr) +
        (!tool.ok ? `<dt style="color:${C.faint};">${bi("error", "错误")}</dt><dd style="margin:0;color:${accent};">${esc(tool.errorCode ?? "unknown")}</dd>` : "") +
        `</dl></details>`
      );
    })
    .join("");
  return (
    `<section class="cy-tools" style="margin-top:12px;border:1px solid ${C.hair};border-radius:10px;background:#fff;padding:10px 12px;">` +
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:${rows === "" ? "0" : "8px"};">` +
    `<span style="${MONO}font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:${C.faint};font-weight:600;">${bi("Tools", "工具")}</span>` +
    (cy.toolSummary !== "" ? `<span style="${MONO}font-size:11.5px;color:${C.dim};">${esc(cy.toolSummary)}</span>` : `<span style="${MONO}font-size:11.5px;color:${C.faint};">${bi("timeline only", "仅时间线")}</span>`) +
    (costs !== "" ? `<span style="${MONO}font-size:11px;color:${C.dim};margin-left:auto;">${esc(costs)}</span>` : "") +
    `</div>` +
    (rows !== "" ? `<div style="display:grid;gap:7px;">${rows}</div>` : "") +
    `</section>`
  );
}

function cycleSignalRows(cy: CycleLedgerRow): string {
  if (cy.signals === undefined || cy.signals.length === 0) return "";
  const rows = cy.signals
    .map((sig) => {
      const kind = sig.signalKind ?? sig.kind;
      const result = sig.result !== undefined ? ` · ${sig.result}` : "";
      const ref = sig.ref !== undefined ? ` · ${sig.ref}` : "";
      return (
        `<div style="display:grid;grid-template-columns:68px 86px 1fr;gap:10px;align-items:start;padding:6px 0;border-top:1px solid ${C.hair};">` +
        `<span style="${MONO}font-size:10.5px;color:${C.faint};text-transform:uppercase;">${esc(sig.seg)}</span>` +
        `<span style="${MONO}font-size:10.5px;color:${sig.signalKind !== undefined ? C.blue : C.dim};">${esc(kind)}${esc(result)}${esc(ref)}</span>` +
        `<span style="${MONO}font-size:11.5px;color:${C.sub};line-height:1.4;">${esc(sig.summary)}</span>` +
        `</div>`
      );
    })
    .join("");
  return (
    `<section class="cy-signals" style="margin-top:12px;border:1px solid ${C.hair};border-radius:10px;background:#fff;padding:10px 12px;">` +
    `<div style="${MONO}font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:${C.faint};font-weight:600;margin-bottom:4px;">ActivitySignal stream</div>` +
    rows +
    `</section>`
  );
}

/** The trailing digit run — the SAME handle `roll cycle` resolves (US-CLI-012/013). */
function cycleHandle(cycleId: string): string {
  const m = /(\d+)$/.exec(cycleId);
  return m?.[1] !== undefined ? m[1].slice(-5) : cycleId.slice(-5);
}

export function copyChip(cmd: string): string {
  return `<code class="copy-chip" data-copy="${esc(cmd)}" style="${MONO}font-size:10.5px;padding:3px 9px;border-radius:6px;border:1px solid ${C.line};color:${C.blue};background:${C.card};cursor:pointer;">${esc(cmd)}</code>`;
}

function cycleRow(cy: CycleLedgerRow): string {
  const color = VERDICT_COLORS[cy.verdict] ?? C.slate;
  // FIX-297: the displayed handle is the trailing digit run — IDENTICAL to the
  // copy-chip below and to what `roll cycle <handle>` resolves. A naive
  // `.slice(-6)` on `20260614-020436-32144` grabs the `-` separator and shows a
  // fake negative "-32144"; cycleHandle() strips it.
  const n = cycleHandle(cy.cycleId);
  return (
    `<details class="cy-row" data-ts="${cy.tsSec}" data-verdict="${cy.verdict}" data-open-key="cy:${esc(cy.cycleId)}" style="border-top:1px solid ${C.hair};">` +
    `<summary style="display:grid;grid-template-columns:14px 70px 1fr auto;align-items:center;gap:14px;padding:12px 18px;cursor:pointer;list-style:none;">` +
    `<span title="${cy.verdict}" style="width:10px;height:10px;border-radius:50%;background:${color};flex:none;"></span>` +
    `<span style="${MONO}font-size:13px;font-weight:600;color:${C.ink};">${esc(n)}</span>` +
    `<div style="min-width:0;display:flex;align-items:center;gap:10px;">` +
    `<span style="${MONO}font-size:10px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid ${color}44;color:${color};flex:none;">${bi(cy.verdict, VERDICT_ZH[cy.verdict] ?? cy.verdict)}</span>` +
    `<span style="${MONO}font-size:12px;color:${C.blue};font-weight:600;flex:none;">${esc(cy.storyId || "—")}</span></div>` +
    `<div style="display:flex;align-items:center;gap:14px;${MONO}font-size:11.5px;color:${C.dim};flex:none;">` +
    `<span style="color:#5b6478;">${esc(cy.model)}</span>` +
    `<span title="tokens in/out">${esc(cy.tokens)}</span>` +
    `<span style="color:#5b6478;">${esc(cy.cost)}</span>` +
    (cy.toolSummary !== "" ? `<span title="tool cost summary · 工具成本摘要" style="color:${C.dim};">${esc(cy.toolSummary)}</span>` : "") +
    `<span>${esc(cy.duration)}</span>` +
    `<span class="bl-caret" style="color:${C.faint};transition:transform .18s;font-size:10px;">▶</span></div></summary>` +
    `<div style="padding:6px 18px 18px 60px;background:#fbfcfe;border-top:1px solid #f1f4f8;">` +
    `<div style="display:flex;flex-wrap:nowrap;overflow-x:auto;gap:0;margin:12px 0 4px;padding-bottom:4px;">` +
    cy.tape.map((s, i) => tapeSegment(s, i === cy.tape.length - 1)).join("") +
    `</div>` +
    cycleSignalRows(cy) +
    cycleToolRows(cy) +
    `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;">` +
    cy.evidence
      .map((e) => `<a href="${esc(e.href)}" style="${MONO}font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid ${C.line};color:${C.blue};text-decoration:none;background:${C.card};">${esc(e.label)}</a>`)
      .join("") +
    // US-DOSSIER-018: the web teaches the CLI — this command really exists (US-CLI-013).
    copyChip(`roll cycle ${cycleHandle(cy.cycleId)}`) +
    `</div>` +
    `</div></details>`
  );
}

export function agentRow(ag: AgentPanelRow): string {
  const dot = ag.installed
    ? `width:9px;height:9px;border-radius:50%;background:${C.green};flex:none;`
    : `width:9px;height:9px;border-radius:50%;background:#cbd2dc;flex:none;`;
  const ink = ag.installed ? C.ink : C.faint;
  const cell = (label: string, value: string, mono = true): string =>
    `<div><div style="${MONO}font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:${C.faint};">${label}</div>` +
    `<div style="${mono ? MONO : ""}font-size:12px;color:${ag.installed ? "#5b6478" : C.faint};margin-top:3px;white-space:nowrap;">${value}</div></div>`;
  const FILE_STATE: Record<string, [string, string]> = {
    sync: ["✓ in sync", C.green],
    stale: ["⟳ stale", C.amber],
    missing: ["− missing", C.faint],
  };
  return (
    `<details class="ag-row" data-agent="${esc(ag.name)}" data-open-key="ag:${esc(ag.name)}" style="border-top:1px solid ${C.hair};${ag.installed ? "" : "opacity:.62;"}">` +
    `<summary style="display:grid;grid-template-columns:1fr repeat(4,minmax(90px,auto)) auto;align-items:center;gap:14px;padding:11px 18px;cursor:pointer;list-style:none;">` +
    `<span style="display:flex;align-items:center;gap:10px;min-width:0;"><span class="bl-caret" style="${MONO}font-size:9px;color:${C.faint};transition:transform .18s;flex:none;">▶</span>` +
    `<span style="${dot}"></span><span style="${MONO}font-size:13px;font-weight:600;color:${ink};white-space:nowrap;">${esc(ag.display)}</span></span>` +
    cell(bi("runner", "运行器"), esc(ag.runner), false) +
    cell(bi("version", "版本"), esc(ag.version)) +
    cell(bi("cycles 72h", "近72h周期"), String(ag.cycles72h)) +
    cell(bi("cost 72h", "近72h花费"), ag.cycles72h > 0 ? `$${ag.costUsd72h.toFixed(2)}` : "—") +
    `<span style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">` +
    (ag.syncStale
      ? `<span style="${MONO}font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;padding:2px 6px;border-radius:4px;border:1px solid ${C.amber}55;color:${C.amber};white-space:nowrap;">${bi("convention stale", "约定过期")}</span>`
      : "") +
    `<span style="${MONO}font-size:11px;color:${ag.installed ? C.green : C.faint};font-weight:600;white-space:nowrap;">${ag.installed ? bi("available", "可用") : bi("not detected", "未检测到")}</span>` +
    `</span></summary>` +
    `<div style="background:#fbfcfe;border-top:1px solid #f1f4f8;padding:12px 18px 14px 47px;">` +
    `<div style="${MONO}font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:${C.faint};margin-bottom:6px;">${bi("convention files", "接入文件")}</div>` +
    (ag.files.length === 0
      ? `<div style="font-size:12.5px;color:${C.faint};font-style:italic;">${bi("nothing to sync", "无同步内容")}</div>`
      : ag.files
          .map((f) => {
            const [label, color] = FILE_STATE[f.state] ?? ["?", C.slate];
            return (
              `<div style="display:flex;gap:12px;align-items:baseline;padding:2px 0;flex-wrap:wrap;">` +
              `<span style="${MONO}font-size:11.5px;color:${C.ink};">${esc(f.path)}</span>` +
              `<span style="${MONO}font-size:10.5px;color:${C.faint};">${esc(f.kind)}</span>` +
              `<span style="${MONO}font-size:10.5px;color:${color};font-weight:600;">${label}</span></div>`
            );
          })
          .join("")) +
    (ag.setupCmd !== undefined
      ? `<div style="margin-top:9px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">` +
        `<span style="${MONO}font-size:10.5px;color:${C.faint};">${bi("source: conventions/ + AGENTS.md · synced by roll setup", "来源:conventions/ + AGENTS.md · 由 roll setup 同步")}</span>` +
        `<code class="copy-chip" data-copy="${esc(ag.setupCmd)}" style="${MONO}font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid ${C.amber}55;color:${C.amber};background:${C.card};cursor:pointer;">${esc(ag.setupCmd)}</code></div>`
      : "") +
    `</div></details>`
  );
}

/**
 * US-DOSSIER-030 — one Casting row (Role | Agent | Note), matching the design
 * reference's three-column grid. A bare agent token renders monospace ink; a
 * prose rule (peer heterogeneity / onboard) renders sub prose; an unconfigured
 * slot's em-dash renders faint so the honesty reads at a glance. A route-resolve
 * rationale, when present, rides a second muted line beneath the agent.
 */
function castingAgentStyle(empty: boolean, mono: boolean): string {
  return empty
    ? `${MONO}font-size:12.5px;font-weight:600;color:${C.faint};`
    : mono
      ? `${MONO}font-size:12.5px;font-weight:700;color:${C.ink};`
      : `font-size:12.5px;color:${C.sub};`;
}

function execSlotCard(slot: CastingExecSlot): string {
  const border = slot.fallback ? `1px dashed ${C.line}` : `1px solid ${C.line}`;
  const bg = slot.fallback ? "#fbfcfe" : C.card;
  const agentStyle = castingAgentStyle(slot.empty, slot.mono);
  const audit =
    slot.audit !== ""
      ? `<div style="${MONO}font-size:10px;color:${C.dim};margin-top:8px;line-height:1.35;">${esc(slot.audit)}</div>`
      : "";
  const ramp =
    slot.fallback
      ? `<div aria-hidden="true" style="${MONO}font-size:26px;line-height:1;color:${C.faint};">↩</div>`
      : `<div aria-hidden="true" style="height:36px;display:flex;align-items:flex-end;gap:4px;">${slot.ramp
          .map((v) => `<span data-ramp-bar="${esc(slot.key)}" style="display:block;width:8px;height:${10 + v * 7}px;border-radius:5px;background:${C.blue};opacity:${0.34 + v * 0.18};"></span>`)
          .join("")}</div>`;
  return (
    `<article data-exec-slot="${esc(slot.key)}" data-ramp="${slot.ramp.length}" style="min-width:0;border:${border};border-radius:8px;background:${bg};padding:14px 14px 13px;display:flex;flex-direction:column;gap:11px;">` +
    `<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;">${ramp}` +
    `<span style="${MONO}font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:${C.faint};font-weight:600;">${bi(slot.key, slot.key)}</span></div>` +
    `<div><div style="font-size:12px;color:${C.sub};font-weight:600;white-space:nowrap;">${bi(slot.roleEn, slot.roleZh)}</div>` +
    `<div style="margin-top:5px;"><span style="${agentStyle}">${bi(esc(slot.agentEn), esc(slot.agentZh))}</span></div>${audit}</div>` +
    `<div style="${MONO}font-size:10.5px;color:${C.faint};margin-top:auto;">${bi(slot.noteEn, slot.noteZh)}</div>` +
    `</article>`
  );
}

function scenarioRoleRow(cr: CastingRow): string {
  const agentStyle = cr.empty
    ? `${MONO}font-size:12.5px;font-weight:600;color:${C.faint};`
    : cr.mono
      ? `${MONO}font-size:12.5px;font-weight:600;color:${C.ink};`
      : `font-size:12.5px;color:${C.sub};`;
  const audit =
    cr.audit !== ""
      ? `<div style="${MONO}font-size:10px;color:${C.dim};margin-top:3px;white-space:normal;">${esc(cr.audit)}</div>`
      : "";
  return (
    `<div data-scenario-role="${esc(cr.key)}" style="display:grid;grid-template-columns:140px 1fr auto;align-items:center;gap:14px;padding:10px 18px;border-top:1px solid #f4f6f9;">` +
    `<span style="font-size:12.5px;color:${C.sub};font-weight:600;white-space:nowrap;">${bi(cr.roleEn, cr.roleZh)}</span>` +
    `<span><span style="${agentStyle}">${bi(esc(cr.agentEn), esc(cr.agentZh))}</span>${audit}</span>` +
    `<span style="${MONO}font-size:10.5px;color:${C.faint};white-space:nowrap;">${bi(cr.noteEn, cr.noteZh)}</span>` +
    `</div>`
  );
}

/**
 * US-DOSSIER-030 — the CASTING grid: who plays which role. Legacy execute route
 * sources plus four scenario roles, rendered as the design reference's Role /
 * Agent / Note grid. Header carries a copyable `roll agent list` chip.
 */
function castingGrid(input: TruthConsoleInput): string {
  const execSlots = input.casting.execSlots ?? [];
  const scenarioRoles = input.casting.scenarioRoles ?? input.casting.rows.filter((r) => r.key === "peer" || r.key === "review-pr" || r.key === "spar" || r.key === "onboard");
  return (
    `<div style="display:flex;align-items:baseline;gap:12px;margin:24px 0 12px;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;white-space:nowrap;">${bi("Casting", "角色分工")}</span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.faint};">${bi(
      "scoped roles + legacy route sources — who plays what",
      "scoped roles + legacy route sources——谁在什么场景演什么",
    )}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;"></span>` +
    copyChip("roll agent list") +
    `</div>` +
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:0 0 8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div data-exec-ladder="true" style="display:grid;grid-template-columns:repeat(3,1fr) 1.1fr;gap:12px;padding:16px 18px;background:#fbfcfe;">` +
    execSlots.map(execSlotCard).join("") +
    `</div>` +
    `<div data-scenario-roles="true">` +
    scenarioRoles.map(scenarioRoleRow).join("") +
    `</div>` +
    `</section>`
  );
}

/**
 * US-DOSSIER-040 — the CASTING PROJECT TAB: who plays which role, promoted out
 * of the Loop tab into its own top-level tab to match the CORRECT design
 * reference's CASTING TAB (`Delivery Dossier.dc.html` `isTabCasting`: the
 * `<!-- executor complexity ladder -->` + `<!-- scenario roles -->`). The grid
 * body reuses the SAME pure `collectCasting()` view-model rendered by
 * `castingGrid`; only the tab header (kicker + title + lede) is added here.
 */
function castingTab(input: TruthConsoleInput): string {
  return (
    `<div style="padding:30px 0 4px;">` +
    kicker(bi("Who plays which role — scoped roles + scenarios", "谁演什么——scoped roles + 场景角色")) +
    `<h1 style="margin:10px 0 0;font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.02em;color:${C.ink};">${bi("Casting", "选角")}</h1>` +
    `<p style="margin:10px 0 0;max-width:660px;font-size:14.5px;line-height:1.55;color:${C.sub};">${bi(
      "Scoped role bindings and legacy route sources are shown together, never as a guessed agent.",
      "scoped role binding 与 legacy route source 同屏展示，绝不臆测 agent。",
    )}</p></div>` +
    castingGrid(input)
  );
}

/**
 * FIX-284 — the HOOKS-this-repo panel: project-scoped git hooks from the
 * checkout's configured hooks path. Scheduled loop lanes belong to the heartbeat
 * and cycle ledger; they are not commit hooks.
 */
function hooksPanel(input: TruthConsoleInput): string {
  const hooks = input.gitHooks ?? { hooksPath: ".git/hooks", configured: false, rows: [] };
  return (
    `<div style="display:flex;align-items:center;gap:12px;margin:24px 0 12px;flex-wrap:wrap;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;white-space:nowrap;">${bi("Hooks · this repo", "钩子 · 本仓")}</span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.faint};">${bi(
      "git hooks wired into this checkout",
      "本检出已配置的 git 钩子",
    )}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;min-width:16px;"></span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.dim};white-space:nowrap;">${hooks.rows.length} ${bi("git hooks", "git 钩子")} · ${esc(hooks.hooksPath)}</span>` +
    `</div>` +
    `<section data-hooks="this-repo" style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:0 0 8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    (hooks.rows.length > 0
      ? hooks.rows
          .map(
            (h) =>
              `<div data-hook="${esc(h.name)}" style="display:grid;grid-template-columns:170px 1fr auto;align-items:center;gap:14px;padding:12px 18px;border-top:1px solid #f4f6f9;">` +
              `<span style="${MONO}font-size:12.5px;color:${C.ink};font-weight:700;">${esc(h.name)}</span>` +
              `<span style="font-size:12.5px;color:${C.sub};">${bi(esc(h.descEn), esc(h.descZh))}</span>` +
              `<span style="${MONO}font-size:10.5px;color:${C.faint};white-space:nowrap;">${esc(h.path)}</span>` +
              `</div>`,
          )
          .join("")
      : `<div style="padding:14px 18px;font-size:12.5px;color:${C.faint};font-style:italic;">${bi("no configured git hooks in this checkout", "本检出没有已配置的 git 钩子")}</div>`) +
    `</section>`
  );
}

function loopTab(input: TruthConsoleInput): string {
  // FIX-297: the loop runs hundreds of cycles a week, so the ledger opens on a
  // count-capped "recent" window (newest ~50) instead of dumping all history.
  // The time ranges expand it; "all" shows everything. Failures are NEVER hidden
  // by the window — see applyRange.
  const ranges: Array<[string, string, string]> = [
    ["recent", "Recent", "近期"],
    ["1", "Today", "今天"],
    ["3", "3 days", "三天"],
    ["7", "7 days", "七天"],
    ["all", "All", "全部"],
  ];
  return (
    `<div style="padding:30px 0 4px;">` +
    kicker(bi("The engine says it runs — here is the tape", "引擎说在跑——这是轨迹带")) +
    `<h1 style="margin:10px 0 0;font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.02em;color:${C.ink};">${bi("Loop & Cycles", "循环与周期")}</h1>` +
    `<p style="margin:10px 0 0;max-width:660px;font-size:14.5px;line-height:1.55;color:${C.sub};">${bi(
      "Every cycle, complete and replayable. Failures are first-class — never swallowed.",
      "每一个 cycle 完整、可回溯。失败是一等公民——绝不吞。",
    )}</p></div>` +
    // US-LOOP-079l: the 3-state run-state header (ACTIVE/DORMANT/PAUSED) sits
    // atop the lanes so the dossier reads its own liveness before the grid.
    loopStateBanner(input) +
    // US-DOSSIER-040: the Loop tab is Loop&Cycle (heartbeat/lanes) + the
    // project-scoped commit-hooks panel + the Cycle ledger. The inline agents
    // panel (now the machine Agents page) and the inline casting ladder (now its
    // own Casting tab) are NOT rendered here.
    repoLoopsPanel(input) +
    hooksPanel(input) +
    `<div style="display:flex;align-items:center;gap:12px;margin:24px 0 12px;flex-wrap:wrap;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;">${bi("Cycle ledger", "周期账本")}</span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.faint};">${bi("what it actually did while you were away", "你不在的时候它到底干了什么")}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;min-width:16px;"></span>` +
    `<div style="display:flex;border:1px solid #dfe4ec;border-radius:999px;overflow:hidden;background:${C.card};">` +
    ranges
      .map(
        ([key, en, zh]) =>
          `<button type="button" class="cy-range${key === "recent" ? " on" : ""}" data-range="${key}" style="appearance:none;border:0;background:transparent;${MONO}font-size:11px;padding:6px 13px;cursor:pointer;color:${C.sub};">${bi(en, zh)}</button>`,
      )
      .join("") +
    `</div>` +
    // FIX-297: the count tracks the active window; the failed tally is ALWAYS
    // the full-ledger total (failures are first-class — never hidden by a window),
    // and every failed cycle stays in view regardless of the range chosen.
    `<span style="${MONO}font-size:11.5px;color:${C.dim};white-space:nowrap;"><span id="cy-count">—</span> ${bi("shown", "显示")} <span style="color:${C.faint};">·</span> <b id="cy-failed" style="color:#d23b3b;font-weight:600;">—</b> ${bi("failed (all)", "失败（全部）")}</span></div>` +
    `<section id="cy-ledger" style="border:1px solid ${C.line};border-radius:14px;background:${C.card};overflow:hidden;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    (input.cycles.length > 0
      ? input.cycles.map(cycleRow).join("")
      : `<div style="padding:16px 18px;font-size:12.5px;color:${C.faint};font-style:italic;">${bi("no cycles recorded yet", "尚无周期记录")}</div>`) +
    `</section>`
  );
}

const TYPE_COLORS: Record<string, string> = { US: C.blue, FIX: C.red, REFACTOR: C.purple, IDEA: C.amber };

function typeBadge(type: string): string {
  const color = TYPE_COLORS[type] ?? C.slate;
  return `<span style="${MONO}font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;padding:2px 7px;border-radius:5px;border:1px solid ${color}44;color:${color};text-align:center;">${esc(type)}</span>`;
}

function miniSpine(stages: string[], spineKeys: string[], legacy: boolean): string {
  if (legacy) {
    return `<span title="legacy delivery · 历史交付" style="display:inline-flex;gap:3px;">${spineKeys
      .map(() => `<span style="width:14px;height:5px;border-radius:3px;background:#d4dae3;"></span>`)
      .join("")}</span>`;
  }
  const done = new Set(stages);
  return `<span style="display:inline-flex;gap:3px;">${spineKeys
    .map((k) => `<span title="${esc(k)}" style="width:14px;height:5px;border-radius:3px;background:${done.has(k) ? C.green : "#e4e8ef"};"></span>`)
    .join("")}</span>`;
}

function truthChip(state: BacklogStoryVM["state"], legacy: boolean): string {
  const mk = (label: string, color: string): string =>
    `<span style="${MONO}font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;padding:2px 6px;border-radius:4px;border:1px solid ${color}55;color:${color};white-space:nowrap;">${label}</span>`;
  if (legacy) return `<span style="${MONO}font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;padding:2px 5px;border-radius:4px;border:1px dashed #c8ced6;color:${C.faint};">legacy</span>`;
  if (state === "done") return mk("truth ✓", C.green);
  if (state === "fail") return mk("truth ✗", C.red);
  if (state === "unknown") return mk("truth ?", C.slate);
  return "";
}

function storyRow(s: BacklogStoryVM, spineKeys: string[]): string {
  const meta = SPECTRUM_META[s.state] as NonNullable<(typeof SPECTRUM_META)[string]>;
  return (
    `<a class="bl-row" data-state="${s.state}" data-text="${esc(`${s.id} ${s.title}`.toLowerCase())}" href="${esc(s.epic)}/${esc(s.id)}/index.html" ` +
    `style="display:grid;grid-template-columns:62px 150px 1fr 110px minmax(150px,auto);align-items:center;gap:12px;padding:8px 10px;border-radius:8px;cursor:pointer;text-decoration:none;">` +
    typeBadge(s.type) +
    `<span style="${MONO}font-size:12.5px;color:${C.blue};font-weight:600;overflow:hidden;text-overflow:ellipsis;">${esc(s.id)}</span>` +
    `<span style="font-size:13.5px;color:${C.sub};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.title)}</span>` +
    miniSpine(s.stages, spineKeys, s.legacy) +
    `<span style="display:flex;align-items:center;gap:7px;justify-content:flex-end;${MONO}font-size:11px;">` +
    `<span style="width:7px;height:7px;border-radius:50%;background:${meta.color};flex:none;"></span>` +
    `<span style="color:${meta.color};font-weight:600;">${bi(meta.en, meta.zh)}</span>` +
    truthChip(s.state, s.legacy) +
    `</span></a>`
  );
}

function epicAccordion(ep: BacklogEpicVM, spineKeys: string[]): string {
  const donePct = ep.total > 0 ? (ep.done / ep.total) * 100 : 0;
  return (
    `<details class="bl-epic" data-epic="${esc(ep.name)}" data-open-key="ep:${esc(ep.name)}">` +
    `<summary style="display:grid;grid-template-columns:20px 1fr auto;align-items:center;gap:14px;padding:13px 16px;cursor:pointer;list-style:none;">` +
    `<span class="bl-caret" style="${MONO}font-size:11px;color:${C.faint};text-align:center;transition:transform .18s;">▶</span>` +
    `<div style="min-width:0;"><a href="${esc(ep.name)}/index.html" style="font-size:16px;font-weight:600;letter-spacing:-.01em;color:${C.ink};text-decoration:none;">${esc(ep.name)}</a>` +
    `<div style="display:flex;height:6px;border-radius:999px;overflow:hidden;margin-top:8px;max-width:320px;border:1px solid #e4e8ef;">` +
    `<span style="width:${donePct}%;background:${C.green};"></span><span style="flex:1;background:#eef1f5;"></span></div></div>` +
    `<span style="${MONO}font-size:13px;color:${C.dim};white-space:nowrap;"><b style="color:${C.green};font-weight:600;">${ep.done}</b> / ${ep.total}</span>` +
    `</summary>` +
    `<div style="border-top:1px solid ${C.hair};padding:5px 8px 9px;">${ep.stories.map((s) => storyRow(s, spineKeys)).join("")}</div>` +
    `</details>`
  );
}

function backlogTab(input: TruthConsoleInput): string {
  const groupHead = (label: string, count: number, color: string): string =>
    `<div style="display:flex;align-items:baseline;gap:12px;margin:24px 0 12px;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;">${label}</span>` +
    `<span style="${MONO}font-size:12px;color:${color};font-weight:600;">${count}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;"></span></div>`;
  const chips = SPECTRUM_ORDER.map((k) => {
    const meta = SPECTRUM_META[k] as NonNullable<(typeof SPECTRUM_META)[string]>;
    return (
      `<button type="button" class="bl-chip" data-filter="${k}" ` +
      `style="${MONO}font-size:11px;padding:6px 12px;border-radius:999px;border:1px solid ${C.line};background:${C.card};color:${meta.color};cursor:pointer;">` +
      `${meta.mark} ${bi(meta.en, meta.zh)}</button>`
    );
  }).join("");
  return (
    `<div style="padding:30px 0 4px;">` +
    kicker(bi("Wishes, not yet truth", "愿望，尚未成真")) +
    `<h1 style="margin:10px 0 0;font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.02em;color:${C.ink};">${bi("Backlog", "待办")}</h1>` +
    `<p style="margin:10px 0 0;max-width:660px;font-size:14.5px;line-height:1.55;color:${C.sub};">${bi(
      "Every card here is a wish until main proves the merge. Each row shows the claim beside the truth.",
      "这里的每张卡都只是愿望，直到主干证明它合并才算完成。每行同时给出声明与真相。",
    )}</p></div>` +
    `<div style="display:flex;gap:10px;align-items:center;margin:22px 0 12px;flex-wrap:wrap;">` +
    `<div style="flex:1 1 280px;display:flex;align-items:center;gap:9px;background:${C.card};border:1px solid #dfe4ec;border-radius:999px;padding:9px 16px;">` +
    `<span style="color:${C.faint};font-size:13px;">⌕</span>` +
    `<input type="search" id="bl-search" placeholder="Search epics &amp; stories · 搜索史诗与故事" style="flex:1;border:none;outline:none;background:none;font-family:inherit;font-size:13.5px;color:${C.body};"></div>` +
    `<div style="display:flex;gap:6px;flex-wrap:wrap;">${chips}</div></div>` +
    groupHead(bi("Shipping to main", "交付中"), input.backlog.shipping.length, C.blue) +
    input.backlog.shipping.map((e) => epicAccordion(e, input.spineKeys)).join("") +
    groupHead(bi("Settled on main", "已落定"), input.backlog.settled.length, C.green) +
    input.backlog.settled.map((e) => epicAccordion(e, input.spineKeys)).join("")
  );
}

// US-DOSSIER-022: the labels now live in @roll/core beside CONSISTENCY_DIMENSIONS,
// so the web panel and the `roll release` gate report read ONE table and can
// never re-diverge on a dimension name or order (Delivery Dossier ruling #3).
const DIM_META: Record<string, ConsistencyDimensionLabel> = CONSISTENCY_DIMENSION_LABELS;

/** A future/unknown dimension still renders honestly (kimi pair-review) — never
 *  crashes the page. Empty self-explaining copy collapses to nothing. */
const DIM_META_FALLBACK: ConsistencyDimensionLabel = {
  no: "·",
  en: "",
  zh: "",
  whatEn: "",
  whatZh: "",
  failMeansEn: "",
  failMeansZh: "",
  actionEn: "",
  actionZh: "",
};

function fwu(f: number, w: number, u: number): string {
  return (
    `<span style="display:flex;gap:14px;justify-content:flex-end;${MONO}font-size:11.5px;white-space:nowrap;">` +
    `<span style="color:${f > 0 ? C.red : "#b6bdc9"};font-weight:600;">f:${f}</span>` +
    `<span style="color:${w > 0 ? C.amber : "#b6bdc9"};font-weight:600;">w:${w}</span>` +
    `<span style="color:${u > 0 ? C.slate : "#b6bdc9"};">?:${u}</span></span>`
  );
}

function releaseTab(input: TruthConsoleInput): string {
  const s = input.snapshot;
  const rp = input.releasePanel;
  const sc = input.releaseScope;
  const rel = s.release;
  const relColor = rel?.verdict === "pass" ? C.green : rel?.verdict === "fail" ? C.red : rel?.verdict === "warn" ? C.amber : C.slate;
  // FIX-372: the head's merged/pending = the RELEASE DELTA, not "all non-done".
  // `pending` is the next cut's content (Done stories merged since the latest
  // tag — releaseScope.pendingCount), NOT every open backlog card (that lived on
  // Release as a meaningless ~241 and now belongs on the Backlog tab). `merged`
  // is what's already inside a tagged release (shippedCount). The bar reads
  // "this cut's readiness": shipped of (shipped + pending).
  const merged = sc.shippedCount;
  const pending = sc.pendingCount;
  const deltaTotal = merged + pending;
  const mergedPct = deltaTotal > 0 ? Math.round((merged / deltaTotal) * 100) : 100;
  const head = (label: string, value: string, mono = true): string =>
    `<div><div style="${MONO}font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:${C.faint};">${label}</div>` +
    `<div style="${mono ? MONO : ""}font-size:13px;color:${C.body};margin-top:8px;white-space:nowrap;">${value}</div></div>`;

  const gateHead =
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:20px 0 8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:30px;padding:16px 20px;">` +
    `<div><div style="${MONO}font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:${C.faint};">${bi("release", "发版")}</div>` +
    `<div style="${MONO}font-size:24px;font-weight:600;color:${C.ink};margin-top:3px;">${esc(rel?.latestTag ?? "—")}</div></div>` +
    `<div><div style="${MONO}font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:${C.faint};">${bi("verdict", "判定")}</div>` +
    `<div style="margin-top:6px;"><span style="${MONO}font-size:11px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid ${relColor}55;color:${relColor};">${esc(rel?.verdict ?? "unknown")}</span></div></div>` +
    head(bi("gate", "闸门"), fwuInline(rp.total)) +
    head(bi("cut", "切版"), shortTs(rel?.collectedAt)) +
    head(bi("previous", "上一版"), esc(rp.prevTag ?? "—")) +
    `<span style="flex:1;"></span>` +
    `<div style="${MONO}font-size:12px;color:${C.dim};white-space:nowrap;"><b style="color:${C.green};font-weight:600;">${merged}</b> ${bi("merged", "已合")} · <b style="color:${C.amber};font-weight:600;">${pending}</b> ${bi("pending", "待交付")}</div></div>` +
    `<div style="padding:0 20px 16px;"><div style="display:flex;height:11px;border-radius:999px;overflow:hidden;border:1px solid #e4e8ef;">` +
    `<span style="width:${mergedPct}%;background:${C.green};"></span><span style="flex:1;background:#eef1f5;"></span></div></div></section>`;

  // FIX-372: the panel explains ITSELF. A clear top line says whether it can
  // ship; a passing dimension stays a calm one-liner; a failing/warning one
  // EXPANDS to "what it checks · what a fail means · the one action to clear it".
  // The gate ENFORCEMENT is unchanged — this is presentation only.
  const anyDrift = rp.total.fail > 0 || rp.total.warn > 0 || rp.total.unknown > 0;
  const verdictColor = rp.blocking ? C.red : anyDrift ? C.amber : C.green;
  const verdictMark = rp.blocking ? "❌" : anyDrift ? "⚠️" : "✅";
  const failDims = rp.dims.filter((d) => d.tally.fail > 0).length;
  const verdictEn = rp.blocking
    ? `Blocked — cannot release: ${failDims} dimension${failDims === 1 ? "" : "s"} failing`
    : anyDrift
      ? "Releasable — no failing dimension (warnings/unknowns noted below)"
      : "Ready to release — all seven dimensions reconciled";
  const verdictZh = rp.blocking
    ? `不能发版 — ${failDims} 个维度未通过`
    : anyDrift
      ? "可发版 — 无失败维度（下方提示警告/未知）"
      : "可以发版 — 七维全部对齐";
  const verdictLine =
    `<div data-truth="gate-verdict" data-blocking="${rp.blocking ? "1" : "0"}" style="display:flex;align-items:center;gap:12px;padding:14px 18px;background:${verdictColor}0d;border-bottom:1px solid ${C.hair};">` +
    `<span style="font-size:17px;line-height:1;flex:none;">${verdictMark}</span>` +
    `<span style="font-size:13.5px;font-weight:600;color:${verdictColor};">${bi(verdictEn, verdictZh)}</span>` +
    `<span style="flex:1;"></span>` +
    `<span data-truth="gate-total-inline">${fwu(rp.total.fail, rp.total.warn, rp.total.unknown)}</span></div>`;

  const dimRow = (d: ReleasePanelDim): string => {
    // runtime fallback (kimi pair-review): a future dimension renders honestly
    // instead of crashing the whole page.
    const meta = DIM_META[d.key] ?? DIM_META_FALLBACK;
    const failing = d.tally.fail > 0;
    const drift = failing || d.tally.warn > 0 || d.tally.unknown > 0;
    const dotColor = failing ? C.red : d.tally.warn > 0 ? C.amber : d.tally.unknown > 0 ? C.slate : C.green;
    const chips = d.tally.subjects
      .map((sub) => `<a href="#backlog/q:${encodeURIComponent(sub)}" style="${MONO}font-size:10.5px;color:${C.blue};border:1px solid ${C.blue}55;border-radius:5px;padding:2px 7px;text-decoration:none;white-space:nowrap;">${esc(sub)}</a>`)
      .join("");
    // A passing dimension is one calm line (name · what it checks · all clear).
    // A drifting one EXPANDS: what a fail means + the single action + the cards.
    const explain = drift
      ? `<div style="grid-column:2/4;margin-top:6px;padding:10px 12px;border-radius:8px;background:${(failing ? C.red : C.amber)}0d;border:1px solid ${(failing ? C.red : C.amber)}33;">` +
        `<div style="font-size:12px;color:${C.body};line-height:1.5;"><b style="color:${failing ? C.red : C.amber};">${bi("Means", "含义")}:</b> ${bi(meta.failMeansEn, meta.failMeansZh)}</div>` +
        `<div style="font-size:12px;color:${C.body};line-height:1.5;margin-top:4px;"><b style="color:${C.blue};">${bi("Do", "处理")}:</b> ${bi(meta.actionEn, meta.actionZh)}</div>` +
        (chips !== "" ? `<div style="margin-top:7px;display:flex;gap:8px;flex-wrap:wrap;">${chips}</div>` : "") +
        `</div>`
      : "";
    return (
      `<div class="rel-dim${drift ? " rel-dim-drift" : ""}" data-dim="${d.key}" data-fail="${failing ? "1" : "0"}" style="display:grid;grid-template-columns:215px 1fr 200px;gap:14px 14px;align-items:center;padding:11px 18px;border-top:1px solid ${C.hair};">` +
      `<span style="display:flex;align-items:center;gap:9px;min-width:0;">` +
      `<span style="width:8px;height:8px;border-radius:50%;background:${dotColor};flex:none;"></span>` +
      `<span style="${MONO}font-size:12.5px;font-weight:600;color:${C.ink};white-space:nowrap;">${meta.no} ${bi(meta.en, meta.zh)}</span></span>` +
      `<span style="min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span style="font-size:12.5px;color:#6b7488;">${bi(meta.whatEn, meta.whatZh)}</span>` +
      (drift ? "" : `<span style="${MONO}font-size:10.5px;color:${C.green};">${bi("all clear", "全清")}</span>`) +
      `</span>` +
      fwu(d.tally.fail, d.tally.warn, d.tally.unknown) +
      explain +
      `</div>`
    );
  };

  // All-pass collapses to one calm line; any drift shows the rows (offending
  // dimensions expanded). The seven names always stay enumerated when there's
  // anything to act on, so a fail is never hidden.
  const dimRows = anyDrift
    ? rp.dims.map(dimRow).join("")
    : `<div data-truth="gate-collapsed" style="display:flex;align-items:center;gap:10px;padding:13px 18px;border-top:1px solid ${C.hair};color:${C.sub};font-size:12.5px;">` +
      `<span style="width:8px;height:8px;border-radius:50%;background:${C.green};flex:none;"></span>` +
      `${bi(
        "All seven dimensions — code↔backlog · cards · docs · tests · bilingual · site · truth-live — reconcile. Nothing to fix.",
        "七个维度——代码↔待办 · 卡片 · 文档 · 测试 · 双语 · 站点 · 真相活体——全部对齐，无需处理。",
      )}</div>`;

  const totalRow =
    `<div style="display:grid;grid-template-columns:215px 1fr 200px;gap:14px;align-items:center;padding:11px 18px;border-top:1px solid ${C.hair};background:#fbfcfe;">` +
    `<span style="${MONO}font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${C.sub};font-weight:600;">${bi("gate total", "闸门合计")}</span>` +
    `<span>${rp.blocking ? `<span style="${MONO}font-size:11px;font-weight:600;color:${C.red};">${bi("a failing dimension blocks the release", "有维度不通过——挡发版")}</span>` : ""}</span>` +
    `<span data-truth="gate-total">${fwu(rp.total.fail, rp.total.warn, rp.total.unknown)}</span></div>`;

  return (
    `<div style="padding:30px 0 4px;">` +
    kicker(bi("It says it will ship — the gate decides", "说要发——闸门说了算")) +
    `<h1 style="margin:10px 0 0;font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.02em;color:${C.ink};">${bi("Release", "发版")}</h1>` +
    `<p style="margin:10px 0 0;max-width:660px;font-size:14.5px;line-height:1.55;color:${C.sub};">${bi(
      "Why can't it ship? Read it, don't guess it: seven reconciled dimensions, every drift with an address.",
      "为什么发不了版？读出来，不用猜：七个对账维度，每处漂移都有地址。",
    )}</p></div>` +
    gateHead +
    `<div style="display:flex;align-items:baseline;gap:12px;margin:26px 0 12px;flex-wrap:wrap;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;white-space:nowrap;">${bi("Consistency gate", "一致性闸门")}</span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.faint};">${bi("seven dimensions reconciled against truth anchors", "七维对真相锚点对账")}${rp.generatedAt !== undefined ? ` · ${shortTs(rp.generatedAt)}` : ""}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;min-width:16px;"></span>` +
    `<code class="copy-chip" data-copy="roll release --gate-check" style="${MONO}font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid ${C.line};color:${C.blue};background:${C.card};cursor:pointer;">roll release --gate-check</code></div>` +
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:0 0 8px;box-shadow:0 1px 2px rgba(17,26,69,.05);">` +
    verdictLine +
    dimRows +
    // The strict-equality total row is detail; it rides along only when there is
    // something to act on, so an all-pass panel stays the calm verdict + one
    // collapsed line (FIX-372).
    (anyDrift ? totalRow : "") +
    `</section>` +
    releaseScopeSections(input)
  );
}

function scopeGroup(g: ScopeEpicGroup, input: TruthConsoleInput, shipped: boolean): string {
  const rows = g.items
    .map((it) => {
      const meta = SPECTRUM_META[it.state] ?? (SPECTRUM_META["unknown"] as NonNullable<(typeof SPECTRUM_META)[string]>);
      const actionChip = !shipped
        ? `<code class="copy-chip" data-copy="${esc(it.state === "hold" ? `roll backlog promote ${it.id}` : `roll loop go --cards ${it.id}`)}" ` +
          `style="${MONO}font-size:10px;padding:2px 8px;border-radius:5px;border:1px solid ${C.line};color:${C.blue};background:${C.card};cursor:pointer;white-space:nowrap;" onclick="event.preventDefault();event.stopPropagation();">${esc(it.state === "hold" ? `roll backlog promote ${it.id}` : `roll loop go --cards ${it.id}`)}</code>`
        : "";
      const prChip =
        shipped && it.prNumber !== undefined
          ? input.githubSlug !== undefined
            ? `<a href="https://github.com/${esc(input.githubSlug)}/pull/${it.prNumber}" style="${MONO}font-size:10.5px;color:${C.green};border:1px solid ${C.green}55;border-radius:5px;padding:2px 7px;text-decoration:none;white-space:nowrap;">#${it.prNumber} merged</a>`
            : `<span style="${MONO}font-size:10.5px;color:${C.green};">#${it.prNumber} merged</span>`
          : shipped
            ? `<span style="${MONO}font-size:10.5px;color:${C.faint};">merged</span>`
            : "";
      return (
        `<a class="sc-row" href="${encodeURIComponent(it.epic)}/${encodeURIComponent(it.id)}/index.html" ` +
        `style="display:grid;grid-template-columns:150px 1fr auto auto;gap:12px;align-items:center;padding:9px 16px;border-top:1px solid #f4f6f9;text-decoration:none;">` +
        `<span style="${MONO}font-size:12px;color:${C.blue};font-weight:600;overflow:hidden;text-overflow:ellipsis;">${esc(it.id)}</span>` +
        `<span style="font-size:13px;color:${C.sub};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(it.title)}</span>` +
        `<span style="display:flex;align-items:center;gap:7px;${MONO}font-size:11px;"><span style="width:7px;height:7px;border-radius:50%;background:${meta.color};"></span><span style="color:${meta.color};font-weight:600;">${bi(meta.en, meta.zh)}</span></span>` +
        (shipped ? prChip : actionChip) +
        `</a>`
      );
    })
    .join("");
  return (
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:0 0 9px;box-shadow:0 1px 2px rgba(17,26,69,.04);">` +
    `<div style="display:flex;align-items:center;gap:10px;padding:10px 16px;background:#fbfcfe;border-bottom:1px solid ${C.hair};">` +
    `<a href="${encodeURIComponent(g.epic)}/index.html" style="font-size:13.5px;font-weight:600;color:${C.ink};text-decoration:none;white-space:nowrap;">${esc(g.epic)}</a>` +
    `<span style="${MONO}font-size:11px;color:${C.faint};">${g.items.length}</span></div>` +
    rows +
    `</section>`
  );
}

function releaseScopeSections(input: TruthConsoleInput): string {
  const sc = input.releaseScope;
  const sectionHead = (label: string, count: number, color: string, sub: string): string =>
    `<div style="display:flex;align-items:baseline;gap:12px;margin:28px 0 12px;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;white-space:nowrap;">${label}</span>` +
    `<span data-truth="${color === C.amber ? "pending-count" : "shipped-count"}" style="${MONO}font-size:12px;color:${color};font-weight:600;">${count}</span>` +
    `<span style="${MONO}font-size:11.5px;color:${C.faint};">${sub}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;"></span></div>`;
  const history = sc.history
    .map(
      (h) =>
        `<details class="rel-hist" data-tag="${esc(h.tag)}" data-open-key="rel:${esc(h.tag)}" style="border-top:1px solid ${C.hair};">` +
        `<summary style="display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer;list-style:none;">` +
        `<span class="bl-caret" style="${MONO}font-size:9px;color:${C.faint};transition:transform .18s;">▶</span>` +
        `<span style="${MONO}font-size:12.5px;font-weight:600;color:${C.ink};">${esc(h.tag)}</span>` +
        `<span style="${MONO}font-size:11px;color:${C.faint};">${esc(h.date)}</span>` +
        (h.waived ? `<span style="${MONO}font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;padding:2px 6px;border-radius:4px;border:1px solid ${C.amber}55;color:${C.amber};">${bi("waived", "曾豁免")}</span>` : "") +
        `<span style="flex:1;"></span><span style="${MONO}font-size:11px;color:${C.faint};">${h.items.length} ${bi("entries", "条")}</span></summary>` +
        `<ul style="margin:0;padding:6px 16px 12px 40px;font-size:12.5px;color:${C.sub};line-height:1.6;">${h.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` +
        `</details>`,
    )
    .join("");
  // FIX-372: "pending" = the NEXT cut's content — stories merged to main SINCE
  // the latest tag — not every open backlog card. The subtitle names the tag the
  // delta is measured against so the meaning is unambiguous.
  const pendingSubEn = sc.latestTag !== undefined ? `merged to main since ${sc.latestTag} — the next release` : "merged to main since the latest tag — the next release";
  const pendingSubZh = sc.latestTag !== undefined ? `自 ${sc.latestTag} 起合入 main——下个版本的内容` : "自最近 tag 起合入 main——下个版本的内容";
  return (
    sectionHead(bi("Pending delivery", "待交付"), sc.pendingCount, C.amber, bi(pendingSubEn, pendingSubZh)) +
    (sc.pending.length > 0 ? sc.pending.map((g) => scopeGroup(g, input, false)).join("") : `<section style="border:1px dashed ${C.line};border-radius:12px;background:${C.card};padding:16px 20px;color:${C.faint};font-size:12.5px;font-style:italic;">${bi("nothing merged since the latest tag — already shipped", "自最近 tag 起没有新合并——都已发布")}</section>`) +
    sectionHead(bi("Changelog (merged truth)", "变更日志（合并真相）"), sc.shippedCount, C.green, bi("generated from merged PRs, not claims", "从 merged PR 生成，不读声明")) +
    sc.shipped.slice(0, 12).map((g) => scopeGroup(g, input, true)).join("") +
    `<div style="display:flex;align-items:baseline;gap:12px;margin:28px 0 12px;">` +
    `<span style="${MONO}font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.sub};font-weight:600;">${bi("Version history", "历史版本")}</span>` +
    `<span style="flex:1;height:1px;background:#dfe4ec;"></span></div>` +
    `<section style="border:1px solid ${C.line};border-radius:12px;background:${C.card};overflow:hidden;margin:0 0 8px;">${history}</section>`
  );
}

function fwuInline(t: { fail: number; warn: number; unknown: number }): string {
  return `f:${t.fail} w:${t.warn} ?:${t.unknown}`;
}

/* ============================ US-DOSSIER-033 — CHARTER ============================
 * The Charter PROJECT TAB + the markdown body styling shared with the machine
 * pages (About / Conventions). This is the dedicated Charter region — sibling
 * machine-page renderers live in their own files and reuse `MD_BODY_CSS` +
 * `renderMachineShell` below; no other tab's emission code is touched. */

/**
 * The read-only markdown body styling — a single, self-contained stylesheet
 * (AC5: no CDN, no external font for the body) applied to every rendered doc,
 * on the Charter tab AND the About / Conventions pages, so the SKILL.md-style
 * render path looks identical everywhere.
 */
export const MD_BODY_CSS = `
.md-body{font-size:14.5px;line-height:1.7;color:${C.body};word-break:break-word;}
.md-body h1{font-size:23px;line-height:1.2;font-weight:700;letter-spacing:-.01em;color:${C.ink};margin:0 0 14px;}
.md-body h2{font-size:18px;font-weight:700;color:${C.ink};margin:26px 0 10px;padding-top:14px;border-top:1px solid ${C.hair};}
.md-body h3{font-size:15px;font-weight:600;color:${C.ink};margin:20px 0 8px;}
.md-body h4,.md-body h5,.md-body h6{font-size:13.5px;font-weight:600;color:${C.sub};margin:16px 0 6px;}
.md-body p{margin:10px 0;}
.md-body ul{margin:10px 0;padding-left:22px;}
.md-body li{margin:4px 0;}
.md-body a{color:${C.blue};text-decoration:none;}
.md-body a:hover{text-decoration:underline;}
.md-body code{font-family:'IBM Plex Mono',monospace;font-size:12.5px;background:#eef1f7;border:1px solid ${C.line};border-radius:5px;padding:1px 5px;color:${C.ink};}
.md-body strong{font-weight:600;color:${C.ink};}
.md-tree-item.on{background:#eef2ff;border-color:${C.blue}55;}
.md-tree-item:hover{background:#f6f8fb;}
.md-doc{display:none;}
.md-doc.on{display:block;}
`;

/** A directory-tree row that selects a doc into the right-hand reader. */
function charterTreeRow(id: string, title: string, path: string, bilingual: boolean): string {
  const blurb = bilingual ? `<span class="lang-en"> · EN/中</span><span class="lang-zh"> · 中/EN</span>` : "";
  return (
    `<a href="#charter/${esc(encodeURIComponent(id))}" class="md-tree-item" data-doc="${esc(id)}" ` +
    `style="display:block;text-decoration:none;border:1px solid transparent;border-radius:8px;padding:7px 10px;cursor:pointer;">` +
    `<span style="font-size:13px;color:${C.ink};font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(title)}</span>` +
    `<span style="${MONO}font-size:10px;color:${C.faint};display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(path)}${blurb}</span></a>`
  );
}

const CHARTER_GROUP_META: Record<CharterVM["groups"][number]["key"], { en: string; zh: string }> = {
  charter: { en: "Charter", zh: "章程" },
  guide: { en: "Guide", zh: "指南" },
  plans: { en: "Epic plans", zh: "史诗计划" },
};

/**
 * US-DOSSIER-033 — the Charter project tab: a markdown browser. LEFT a directory
 * tree of the project's charter docs (docs/*.md, the per-epic plan .md files,
 * guide/INDEX.md), grouped Charter · Guide · Plans; RIGHT the selected file
 * rendered as markdown via the same render path the SKILL.md viewer uses. The
 * guide/en↔zh pairs carry both bodies and the visible one follows the EN/中
 * toggle. Read-only by design — a browser, not an editor.
 */
function charterTab(input: TruthConsoleInput): string {
  const ch = input.charter;
  const docs = ch.groups.flatMap((g) => g.docs);
  if (docs.length === 0) {
    return (
      `<div style="padding:30px 0 4px;">` +
      kicker(bi("Read-only · the rulebook you are governed by", "只读 · 你被约束的规则书")) +
      `<h1 style="margin:10px 0 0;font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.02em;color:${C.ink};">${bi("Charter", "章程")}</h1></div>` +
      `<section style="border:1px dashed ${C.line};border-radius:12px;background:${C.card};padding:28px 24px;margin:18px 0;color:${C.faint};font-size:13.5px;">` +
      bi("No charter documents found in this project.", "本项目未找到章程文档。") +
      `</section>`
    );
  }
  const defaultId = ch.defaultId ?? docs[0]!.id;

  const tree = ch.groups
    .map((g) => {
      const meta = CHARTER_GROUP_META[g.key];
      return (
        `<div style="margin:0 0 14px;"><div style="${MONO}font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:${C.faint};font-weight:600;margin:0 0 6px;padding:0 4px;">${bi(meta.en, meta.zh)} <span style="color:${C.blue};">${g.docs.length}</span></div>` +
        `<div style="display:flex;flex-direction:column;gap:2px;">${g.docs.map((d) => charterTreeRow(d.id, d.title, d.path, d.bilingual)).join("")}</div></div>`
      );
    })
    .join("");

  const readers = docs
    .map((d) => {
      const on = d.id === defaultId;
      const langWrap = d.bilingual
        ? `<div class="lang-en md-body">${d.bodyEn}</div><div class="lang-zh md-body">${d.bodyZh}</div>`
        : `<div class="md-body">${d.bodyEn}</div>`;
      return (
        `<article class="md-doc${on ? " on" : ""}" data-doc="${esc(d.id)}" id="charter-doc-${esc(encodeURIComponent(d.id))}">` +
        `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;padding:0 0 12px;border-bottom:1px solid ${C.hair};">` +
        `<span style="${MONO}font-size:11px;color:${C.blue};background:${C.blue}0d;border:1px solid ${C.blue}33;border-radius:6px;padding:3px 9px;">${esc(d.path)}</span>` +
        (d.bilingual ? `<span style="${MONO}font-size:10.5px;color:${C.faint};">${bi("follows EN/中 toggle", "随 EN/中 切换")}</span>` : "") +
        `</div>${langWrap}</article>`
      );
    })
    .join("");

  return (
    `<div style="padding:30px 0 4px;">` +
    kicker(bi("Read-only · the rulebook you are governed by", "只读 · 你被约束的规则书")) +
    `<h1 style="margin:10px 0 0;font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.02em;color:${C.ink};">${bi("Charter", "章程")}</h1>` +
    `<p style="margin:10px 0 0;max-width:660px;font-size:14.5px;line-height:1.55;color:${C.sub};">${bi(
      "Browse the project's own charter — manifesto, architecture, epic plans, and the guide map — rendered read-only from the repo. One markdown engine, no document drift.",
      "浏览项目自身的章程——理念、架构、史诗计划、指南索引——从仓库只读渲染。一套 markdown 引擎，零文档漂移。",
    )}</p></div>` +
    `<section class="charter-browser" style="display:grid;grid-template-columns:268px 1fr;gap:18px;margin:18px 0 8px;align-items:start;">` +
    `<nav class="charter-tree" style="border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:12px 10px;position:sticky;top:108px;max-height:calc(100vh - 132px);overflow:auto;box-shadow:0 1px 2px rgba(17,26,69,.04);" aria-label="${bi("charter docs", "章程文档")}">${tree}</nav>` +
    `<div class="charter-reader" style="border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:22px 26px;min-width:0;box-shadow:0 1px 2px rgba(17,26,69,.04);">${readers}</div>` +
    `</section>`
  );
}

/* =================== US-DOSSIER-033 — MACHINE-PAGE SHELL (additive) ===================
 * A self-contained full-page shell the About / Conventions renderers (in their
 * own dedicated files) wrap their body in, so they wear the SAME sticky top bar,
 * lang script, and markdown styling as the console without duplicating the
 * chrome. Additive export — no existing emission code changes. */

export interface MachinePageShellInput extends TopBarInput {
  /** Which machine page this is — drives the breadcrumb highlight + <title>. */
  page: MachineNavLink["key"];
  /** Page <title> (already localized to a single language is fine; EN preferred). */
  titleText: string;
  /** The page body HTML (inside <main>); the caller renders its own sections. */
  body: string;
}

/**
 * Wrap a machine-page body in the shared sticky-shell page (top bar + lang
 * script + the markdown body styling). Self-contained: same fonts/CSS/script as
 * the console, no external fetch.
 */
export function renderMdMachineShell(input: MachinePageShellInput): string {
  const header = topBar({ ...input, machinePage: input.page });
  return (
    htmlHead(rollScope(input)) +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${esc(input.brand.name)} · ${esc(input.titleText)}</title>\n` +
    FONT_LINKS +
    `<style>${SHELL_CSS}${MD_BODY_CSS}</style>\n` +
    `${CONSOLE_SCRIPT}\n</head>\n<body>\n` +
    header +
    `<main style="max-width:1100px;margin:0 auto;padding:0 22px 64px;">${input.body}</main>\n` +
    `</body>\n</html>\n`
  );
}

/** Shared machine-page palette token (kicker dedup'd to the US-DOSSIER-032 copy below). */
export function machinePalette(): typeof C & { mono: string } {
  return { ...C, mono: MONO };
}

/**
 * US-DOSSIER-043 — the ONE project tab set, ordered by daily operating use:
 * Now → Backlog → Loop → Release → Casting → Charter. Both the rendered
 * tab bar (which reads the bilingual `{ en, zh }` labels) and the
 * `CONSOLE_SCRIPT` hash router (which only needs the `key` list, serialized in
 * below) derive from this single source, so the visible bar and the runtime
 * router can never desync. Skills/Agents/Conventions/About are MACHINE-GLOBAL
 * (reached via the MACHINE breadcrumb), never project tabs.
 */
const TABS = [
  { key: "now", en: "Now", zh: "现在" },
  { key: "backlog", en: "Backlog", zh: "待办" },
  { key: "loop", en: "Loop", zh: "循环" },
  { key: "release", en: "Release", zh: "发版" },
  // US-DOSSIER-040 — Casting is its OWN top-level project tab (executor
  // complexity ladder + scenario roles), no longer nested inside Loop.
  { key: "casting", en: "Casting", zh: "选角" },
  // US-DOSSIER-033 — the Charter project tab: a read-only markdown browser over
  // the project's own charter docs (manifesto/architecture/plans/guide).
  { key: "charter", en: "Charter", zh: "章程" },
] as const;

/** The router needs only the keys; serialized once, deterministic order. */
const TAB_KEYS = TABS.map((t) => t.key);

/**
 * US-DOSSIER-027 — the machine-global breadcrumb. These are the machine-layer
 * (above-project) entry points the design reference's top bar promises. Their
 * pages are built by later stories; the routing contract here is stable: each
 * is a sibling HTML file of `features/index.html`. Order is fixed
 * (Agents → Skills → Tools → Conventions → About) so the bar never reshuffles.
 * US-TOOL-017 inserts Tools at the same machine level as Agents/Skills.
 */
export const MACHINE_NAV: readonly MachineNavLink[] = [
  { key: "agents", en: "Agents", zh: "Agents", href: "agents.html" },
  { key: "skills", en: "Skills", zh: "技能", href: "skills.html" },
  { key: "tools", en: "Tools", zh: "工具", href: "tools.html" },
  { key: "conventions", en: "Conventions", zh: "约定", href: "conventions.html" },
  { key: "about", en: "About", zh: "关于", href: "about.html" },
] as const;

export const CONSOLE_SCRIPT = `<script>
(function () {
  var d = document.documentElement;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var lang = get("roll-lang") || ((navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en");
  // US-DOSSIER-034: persistence is SCOPED per project so the project switcher
  // never carries one project's open rows / chosen tab into another. The scope
  // is the project key stamped on <html data-roll-scope> at generate time; lang
  // stays GLOBAL (roll-lang, one reading language across the machine).
  var scope = d.getAttribute("data-roll-scope") || "";
  function tabKey() { return "roll-tab:" + scope; }
  function openKey() { return "roll-open:" + scope; }
  // US-DOSSIER-034: the set of open <details> ids, keyed by their stable
  // data-open-key (cycle id / agent / epic / skill / release tag — never DOM
  // order), so a reader's expansions survive reload + drilldown re-render.
  function readOpen() {
    var raw = get(openKey());
    if (!raw) return {};
    try { var o = JSON.parse(raw); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; }
  }
  function writeOpen(map) { set(openKey(), JSON.stringify(map)); }
  function restoreOpen() {
    var map = readOpen();
    var els = document.querySelectorAll("[data-open-key]");
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute("data-open-key");
      if (!k) continue;
      if (map[k]) els[i].setAttribute("open", ""); else els[i].removeAttribute("open");
    }
  }
  function bindOpenPersistence() {
    var els = document.querySelectorAll("[data-open-key]");
    for (var i = 0; i < els.length; i++) {
      els[i].addEventListener("toggle", function () {
        var k = this.getAttribute("data-open-key");
        if (!k) return;
        var map = readOpen();
        if (this.open) map[k] = 1; else delete map[k];
        writeOpen(map);
      });
    }
  }
  function applyLang() {
    d.setAttribute("data-lang", lang);
    d.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
    var bs = document.querySelectorAll("[data-set-lang]");
    for (var i = 0; i < bs.length; i++) {
      var on = bs[i].getAttribute("data-set-lang") === lang;
      bs[i].classList.toggle("on", on);
      bs[i].setAttribute("aria-pressed", String(on));
    }
  }
  var TABS = ${JSON.stringify(TAB_KEYS)};
  function hashParts() {
    return (location.hash || "").replace(/^#/, "").split("/");
  }
  function currentTab() {
    var h = hashParts()[0];
    if (TABS.indexOf(h) >= 0) return h;
    // US-DOSSIER-034/043: no tab in the hash (a bare reload, or arriving back
    // from a drilldown that dropped the hash) → restore the last tab from
    // storage; first visit lands on Now.
    var saved = get(tabKey());
    if (TABS.indexOf(saved) >= 0) return saved;
    return "now";
  }
  function applyTab() {
    var cur = currentTab();
    for (var i = 0; i < TABS.length; i++) {
      var pane = document.getElementById("tab-" + TABS[i]);
      if (pane) pane.style.display = TABS[i] === cur ? "" : "none";
      var btn = document.querySelector('[data-tab="' + TABS[i] + '"]');
      if (btn) btn.classList.toggle("on", TABS[i] === cur);
    }
    // US-DOSSIER-034: remember the active tab so it survives reload / drilldown.
    set(tabKey(), cur);
    if (cur === "charter") applyCharter();
  }
  // US-DOSSIER-033: the Charter browser doc selector — pure client interaction
  // (the doc bodies are already baked into the page; no fetch). #charter/<id>
  // selects that doc; otherwise the first doc shows by default.
  function applyCharter() {
    var items = document.querySelectorAll(".md-tree-item");
    if (!items.length) return;
    var want = hashParts()[1] || "";
    if (want) { try { want = decodeURIComponent(want); } catch (e) { /* raw */ } }
    // US-DOSSIER-034: no doc in the hash → restore the last-read doc from storage
    // (scoped per project) so a bare reload / back-nav keeps the reader's place.
    if (!want) { var saved = get("roll-charter:" + scope); if (saved) want = saved; }
    var found = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute("data-doc") === want) { found = true; break; }
    }
    if (!found) want = items[0].getAttribute("data-doc");
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle("on", items[j].getAttribute("data-doc") === want);
    }
    var docs = document.querySelectorAll(".md-doc");
    for (var k = 0; k < docs.length; k++) {
      docs[k].classList.toggle("on", docs[k].getAttribute("data-doc") === want);
    }
    set("roll-charter:" + scope, want);
  }
  // US-DOSSIER-012: backlog search + state filters; #backlog/<state> pre-sets one.
  var active = {};
  function applyFilters() {
    var q = (document.getElementById("bl-search") || { value: "" }).value.toLowerCase();
    var any = Object.keys(active).some(function (k) { return active[k]; });
    var rows = document.querySelectorAll(".bl-row");
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var okState = !any || active[r.getAttribute("data-state")];
      var okText = q === "" || (r.getAttribute("data-text") || "").indexOf(q) >= 0;
      r.style.display = okState && okText ? "" : "none";
    }
    var epics = document.querySelectorAll(".bl-epic");
    for (var j = 0; j < epics.length; j++) {
      var visible = epics[j].querySelectorAll('.bl-row:not([style*="display: none"])').length;
      epics[j].style.display = visible > 0 ? "" : "none";
      if ((any || q !== "") && visible > 0) epics[j].setAttribute("open", "");
    }
    var chips = document.querySelectorAll(".bl-chip");
    for (var c = 0; c < chips.length; c++) {
      chips[c].classList.toggle("on", !!active[chips[c].getAttribute("data-filter")]);
    }
  }
  // US-DOSSIER-013 / FIX-297: cycle ledger range filter. Rows render newest-first.
  // The default "recent" window count-caps the view to the newest RECENT_CAP cycles
  // (the loop runs hundreds a week, so showing all history overwhelms the page).
  // Two invariants hold for EVERY range, including "recent":
  //   1. A failed/reverted/blocked cycle is NEVER hidden by the window — failures
  //      are first-class, always in view however narrow the window.
  //   2. The "failed" tally counts the FULL ledger, not just what's visible, so it
  //      stays accurate no matter which range is active.
  var RECENT_CAP = 50;
  function applyRange(range) {
    var rows = document.querySelectorAll(".cy-row");
    var nowSec = Math.floor(Date.now() / 1000);
    var horizon = range === "all" || range === "recent" ? Infinity : Number(range) * 86400;
    var shown = 0, failedAll = 0, kept = 0;
    for (var i = 0; i < rows.length; i++) {
      var v = rows[i].getAttribute("data-verdict");
      var isFail = v === "failed" || v === "reverted" || v === "blocked";
      if (isFail) failedAll++; // full-ledger tally, independent of the window
      var ts = Number(rows[i].getAttribute("data-ts")) || 0;
      var inWindow = range === "all" ? true
        : range === "recent" ? kept < RECENT_CAP
        : nowSec - ts <= horizon;
      // Failures are always shown; otherwise honor the window.
      var show = isFail || inWindow;
      rows[i].style.display = show ? "" : "none";
      if (show) shown++;
      if (inWindow) kept++; // the cap counts non-fail slots; failures are bonus
    }
    var c = document.getElementById("cy-count");
    var f = document.getElementById("cy-failed");
    if (c) c.textContent = String(shown);
    if (f) f.textContent = String(failedAll);
    var btns = document.querySelectorAll(".cy-range");
    for (var b = 0; b < btns.length; b++) btns[b].classList.toggle("on", btns[b].getAttribute("data-range") === range);
  }
  function applyPrefilter() {
    var parts = hashParts();
    if (parts[0] === "backlog" && parts[1]) {
      if (parts[1].indexOf("q:") === 0) {
        // US-DOSSIER-015: dimension drift chips deep-link a search query.
        var q = parts[1].slice(2);
        try { q = decodeURIComponent(q); } catch (e) { /* malformed escape — use raw */ }
        var box = document.getElementById("bl-search");
        if (box) { box.value = q; }
        active = {};
        applyFilters();
      } else {
        active = {};
        active[parts[1]] = true;
        applyFilters();
      }
    }
  }
  // US-DOSSIER-018: the snapshot is honest about being a snapshot.
  function applyFreshness() {
    var b = document.getElementById("freshness-banner");
    if (!b) return;
    var gen = Date.parse(b.getAttribute("data-generated") || "");
    var STALE_MS = 6 * 3600 * 1000;
    if (isFinite(gen) && Date.now() - gen > STALE_MS) b.style.display = "";
  }
  // US-LOOP-118: the hb-next countdown is gone with the NEXT column. It animated
  // "in 12m" toward a fire time predicted from a launchd period; with no timer
  // behind it, that countdown could only reach "due" and stay there. (No backticks
  // in this comment: it lives inside the page's script template literal.)
  // US-DOSSIER-044: browser-side live feed is READ-ONLY. The generated page
  // already contains a server-folded snapshot from loop-fmt; this poller only
  // attempts to read ../loop/live.log and summarize newly visible lines. It never
  // writes loop state, opens tmux, signals a process, or depends on the network.
  function summarizeLiveLine(line) {
    if (!line) return "";
    if (/^── cycle /.test(line) || /cycle done|cycle failed|cycle aborted/i.test(line)) return line;
    try {
      var obj = JSON.parse(line);
      var typ = obj && obj.type;
      if (typ === "result") return "cycle done" + (obj.total_cost_usd ? " — $" + obj.total_cost_usd + " USD" : "");
      var content = obj && obj.message && obj.message.content;
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var part = content[i] || {};
          if (part.type === "tool_use") {
            var name = String(part.name || "tool");
            var input = part.input || {};
            var file = String(input.file_path || input.path || "");
            var cmd = String(input.command || "");
            if (file) return "› edit " + file;
            if (/\\b(test|vitest|pnpm|npm|ci)\\b/i.test(cmd)) return "→ test " + cmd;
            if (/\\b(pr|pull request|gh pr)\\b/i.test(cmd)) return "→ pr " + cmd;
            return "› " + name + (cmd ? " " + cmd : "");
          }
          if (part.type === "tool_result") {
            var txt = String(part.content || "");
            var commit = /\\b[0-9a-f]{7,40}\\b/.exec(txt);
            if (commit) return "→ tcr commit " + commit[0];
            if (/fail|error/i.test(txt)) return "→ alert " + txt.slice(0, 140);
          }
        }
      }
    } catch (e) {
      /* plain text fallback below */
    }
    if (/\\b(US-|FIX-|REFACTOR-|BUG-|PR #|#\\d+|test|vitest|attest|ci|merge|merged|fail|error|blocked)\\b/i.test(line)) return line;
    return "";
  }
  function setupLiveFeeds() {
    var feeds = document.querySelectorAll("[data-live-feed]");
    var fetcher = window.fetch;
    if (!feeds.length || typeof fetcher !== "function") return;
    for (var i = 0; i < feeds.length; i++) {
      (function (feed) {
        var src = feed.getAttribute("data-live-src") || "";
        var status = feed.querySelector("[data-live-status]");
        var linesEl = feed.querySelector("[data-live-lines]");
        if (!src || !linesEl) return;
        var lastText = "";
        function setStatus(text, color) {
          if (!status) return;
          status.textContent = text;
          status.style.color = color;
          status.style.borderColor = color + "44";
        }
        function render(text) {
          if (text === lastText) return;
          lastText = text;
          var raw = text.split(/\\r?\\n/).filter(Boolean).slice(-200);
          var rows = [];
          for (var j = 0; j < raw.length; j++) {
            var s = summarizeLiveLine(raw[j]);
            if (s) rows.push(s);
          }
          rows = rows.slice(-24);
          if (!rows.length) {
            setStatus("idle", "${C.slate}");
            return;
          }
          linesEl.innerHTML = "";
          if (linesEl.tagName !== "OL") {
            var ol = document.createElement("ol");
            ol.setAttribute("data-live-lines", "true");
            ol.style.cssText = "list-style:none;margin:0;padding:0;display:grid;gap:4px;max-height:420px;overflow:auto;";
            linesEl.parentNode.replaceChild(ol, linesEl);
            linesEl = ol;
          }
          for (var k = 0; k < rows.length; k++) {
            var li = document.createElement("li");
            li.style.cssText = "font-family:'IBM Plex Mono',monospace;font-size:11.5px;line-height:1.45;white-space:pre-wrap;color:#d8dee9;";
            li.textContent = rows[k];
            linesEl.appendChild(li);
          }
          setStatus("live", "${C.green}");
          linesEl.scrollTop = linesEl.scrollHeight;
        }
        function refresh() {
          fetcher.call(window, src, { cache: "no-store" })
            .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
            .then(render)
            .catch(function () { setStatus("snapshot", "${C.amber}"); });
        }
        refresh();
        setInterval(refresh, 5000);
      })(feeds[i]);
    }
  }
  // US-DOSSIER-027: the project switcher dropdown — pure client interaction
  // (no data fetch). Opens "roll · this machine", closes on outside click / Esc.
  function setupSwitcher() {
    var btn = document.getElementById("proj-switch-btn");
    var menu = document.getElementById("proj-menu");
    if (!btn || !menu) return; // single-project degrade: no dropdown rendered
    function close() {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
    function open() {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) open(); else close();
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
  }
  window.addEventListener("hashchange", function () { applyTab(); applyPrefilter(); });
  document.addEventListener("DOMContentLoaded", function () {
    applyLang();
    applyTab();
    // US-DOSSIER-034: restore the reader's expanded sections (keyed by stable id)
    // before the filters run, then keep them in sync as the reader toggles rows.
    restoreOpen();
    bindOpenPersistence();
    applyPrefilter();
    setupSwitcher();
    var chips = document.querySelectorAll(".bl-chip");
    for (var c = 0; c < chips.length; c++) {
      chips[c].addEventListener("click", function () {
        var k = this.getAttribute("data-filter");
        active[k] = !active[k];
        applyFilters();
      });
    }
    var search = document.getElementById("bl-search");
    if (search) search.addEventListener("input", applyFilters);
    var chipsCopy = document.querySelectorAll(".copy-chip");
    for (var cc = 0; cc < chipsCopy.length; cc++) {
      chipsCopy[cc].addEventListener("click", function () {
        var text = this.getAttribute("data-copy") || this.textContent;
        var self = this;
        try {
          navigator.clipboard.writeText(text).then(function () {
            var old = self.textContent;
            self.textContent = "✓ copied";
            setTimeout(function () { self.textContent = old; }, 1200);
          });
        } catch (e) { /* clipboard unavailable (file://) — chip stays copyable by selection */ }
      });
    }
    var rbs = document.querySelectorAll(".cy-range");
    for (var rb = 0; rb < rbs.length; rb++) {
      rbs[rb].addEventListener("click", function () { applyRange(this.getAttribute("data-range")); });
    }
    applyRange("recent");
    applyFreshness();
    setupLiveFeeds();
    var bs = document.querySelectorAll("[data-set-lang]");
    for (var i = 0; i < bs.length; i++) {
      bs[i].addEventListener("click", function () {
        lang = this.getAttribute("data-set-lang");
        set("roll-lang", lang);
        applyLang();
      });
    }
  });
  applyLang();
})();
</script>`;

/**
 * US-DOSSIER-027 — the shell CSS shared by the console AND the machine-global
 * pages, so the sticky top bar (switcher + breadcrumb + lang toggle) looks
 * identical everywhere. The console appends its own tab/row rules after this.
 */
export const SHELL_CSS = `
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{background:${C.bg};color:${C.body};font-family:"IBM Plex Sans","IBM Plex Sans SC",-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;}
@keyframes beat{0%{box-shadow:0 0 0 0 rgba(23,138,82,.5);}70%{box-shadow:0 0 0 8px rgba(23,138,82,0);}100%{box-shadow:0 0 0 0 rgba(23,138,82,0);}}
::selection{background:rgba(45,84,232,.16);}
html[data-lang="en"] .lang-zh{display:none;}
html[data-lang="zh"] .lang-en{display:none;}
html:not([data-lang]) .lang-zh{display:none;}
.lang-btn{appearance:none;border:0;background:transparent;color:#8f98ad;font-family:'IBM Plex Mono',monospace;font-size:11px;padding:4px 11px;cursor:pointer;}
.lang-btn.on{background:#2d54e8;color:#fff;}
.proj-switch-btn:hover{background:rgba(255,255,255,.05);}
.proj-switch-btn[aria-expanded="true"] .proj-caret{transform:rotate(180deg);}
.proj-item:hover{background:rgba(255,255,255,.06);border-radius:7px;}
.mach-link:hover{color:#fff;}
`;

/** The shared web-font links (preconnect + IBM Plex), used by every page head.
 *  US-DOSSIER-039: re-exports core's `FONT_LINKS` so the console and the chrome
 *  pages load the SAME IBM Plex faces from ONE source — no duplicated link tag. */
export const FONT_LINKS = CORE_FONT_LINKS;

/**
 * US-DOSSIER-027 — the sticky dark top bar: the stable shell across every
 * surface. LEFT a green-dot project switcher (project name in Mono 600) that
 * opens a "roll · this machine" dropdown of the registry; MIDDLE a
 * machine-global breadcrumb (MACHINE: Agents · Skills · Conventions · About);
 * RIGHT the release badge (from the truth snapshot) + EN/中 toggle. Geometry is
 * the design reference's (54px, rgba(27,34,56,.97), blur(8px), 1px #0e1424).
 */
export interface TopBarInput {
  brand: TruthConsoleBrand;
  projects?: ProjectRegistryEntry[];
  currentSlug?: string;
  machinePage?: MachineNavLink["key"];
  /** Only the release tag is read off the snapshot (the right-side badge). */
  snapshot: { release?: { latestTag?: string } };
}

export function topBar(input: TopBarInput): string {
  // Switcher rows: the registry when present, else this project alone — the
  // graceful single-project degrade (AC2). Self → no dropdown chevron, no menu.
  const registry = input.projects ?? [];
  const entries: ProjectRegistryEntry[] =
    registry.length > 0 ? registry : [{ name: input.brand.name, slug: input.currentSlug ?? input.brand.name, path: "." }];
  const currentSlug = input.currentSlug ?? entries[0]?.slug ?? input.brand.name;
  const multi = entries.length > 1;

  // FIX-283/US-DOSSIER-043: the current project's "home" target depends on the
  // surface. On the console, `#now` selects the default Now tab in place. On a
  // MACHINE page, the link hops to the console sibling file.
  const homeHref = input.machinePage !== undefined ? "index.html#now" : "#now";

  const dot = `<span style="width:9px;height:9px;border-radius:50%;background:${C.green};box-shadow:0 0 0 3px rgba(23,138,82,.22);flex:none;"></span>`;
  const projName = `<span style="${MONO}font-weight:600;font-size:15px;letter-spacing:.02em;color:#fff;white-space:nowrap;">${esc(input.brand.name)}</span>`;

  const menuItems = entries
    .map((p) => {
      const on = p.slug === currentSlug;
      // Other projects expose their own static archive at .roll/features/index.html; the
      // current project's row routes home to the console Now tab (FIX-283:
      // `index.html#now` when this is a machine page, `#now` on console).
      const href = on ? homeHref : `${esc(p.path)}/.roll/features/index.html`;
      const tag = p.releaseTag !== undefined && p.releaseTag !== "" ? esc(p.releaseTag) : "";
      return (
        `<a class="proj-item${on ? " on" : ""}" href="${href}" role="menuitem"${on ? ' aria-current="true"' : ""} ` +
        `style="display:flex;align-items:center;gap:9px;padding:8px 13px;text-decoration:none;color:#cfd5e3;${MONO}font-size:12.5px;white-space:nowrap;">` +
        `<span class="proj-check" style="width:12px;flex:none;color:${C.green};font-weight:600;">${on ? "✓" : ""}</span>` +
        `<span style="flex:1;color:${on ? "#fff" : "#cfd5e3"};font-weight:${on ? "600" : "400"};">${esc(p.name)}</span>` +
        (tag !== "" ? `<span style="color:#6f7892;font-size:10.5px;">${tag}</span>` : "") +
        `</a>`
      );
    })
    .join("");

  // The switcher: a button that toggles the dropdown when there is more than one
  // project; a plain home anchor (no chevron, no menu) when there is only one.
  const switcher = multi
    ? `<div class="proj-switch" style="position:relative;flex:none;">` +
      `<button type="button" id="proj-switch-btn" class="proj-switch-btn" aria-haspopup="menu" aria-expanded="false" ` +
      `style="display:flex;align-items:center;gap:9px;cursor:pointer;background:transparent;border:0;padding:5px 7px;border-radius:8px;">` +
      dot +
      projName +
      `<span class="proj-caret" style="${MONO}font-size:9px;color:#8f98ad;flex:none;transition:transform .18s;">▾</span></button>` +
      `<div id="proj-menu" class="proj-menu" role="menu" aria-label="switch project · 切换项目" hidden ` +
      `style="position:absolute;top:42px;left:0;min-width:240px;background:rgba(27,34,56,.99);border:1px solid #313a55;border-radius:10px;padding:6px;box-shadow:0 10px 30px rgba(7,10,20,.5);z-index:40;">` +
      `<div style="${MONO}font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#6f7892;padding:6px 13px 8px;">${esc(input.brand.name)} · ${bi("this machine", "这台机器")}</div>` +
      menuItems +
      `</div></div>`
    : `<a href="${homeHref}" class="proj-switch-btn" style="display:flex;align-items:center;gap:9px;cursor:pointer;flex:none;text-decoration:none;padding:5px 7px;">` +
      dot +
      projName +
      `</a>`;

  const crumbsNav =
    `<nav style="flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:9px;${MONO}font-size:12px;color:#8f98ad;overflow:hidden;" aria-label="machine layer · 机器层">` +
    `<span style="${MONO}font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#5b6480;flex:none;">${bi("Machine", "机器")}</span>` +
    MACHINE_NAV.map((m, i) => {
      const active = input.machinePage === m.key;
      const sep = i > 0 ? `<span style="color:#3a4360;flex:none;">·</span>` : "";
      return (
        sep +
        `<a class="mach-link${active ? " on" : ""}" data-machine="${m.key}" href="${esc(m.href)}"${active ? ' aria-current="page"' : ""} ` +
        `style="text-decoration:none;color:${active ? "#fff" : "#8f98ad"};font-weight:${active ? "600" : "400"};white-space:nowrap;flex:none;">${bi(m.en, m.zh)}</a>`
      );
    }).join("") +
    `</nav>`;

  const releaseTag = input.snapshot.release?.latestTag;
  const releaseBadge =
    releaseTag !== undefined && releaseTag !== ""
      ? `<span style="${MONO}font-size:11px;color:#6f7892;letter-spacing:.02em;white-space:nowrap;">${bi("release", "发版")} <b style="color:#cfd5e3;font-weight:600;">${esc(releaseTag)}</b></span>`
      : "";

  const langToggle =
    `<div style="display:flex;border:1px solid #313a55;border-radius:999px;overflow:hidden;flex:none;">` +
    `<button type="button" data-set-lang="en" class="lang-btn">EN</button>` +
    `<button type="button" data-set-lang="zh" class="lang-btn">中</button></div>`;

  // The injected slogan stays beside the project name (the reference's place),
  // a quiet tagline; it remains injected brand data, never hardcoded.
  const slogan =
    input.brand.slogan !== ""
      ? `<span style="${MONO}font-size:11.5px;color:#8f98ad;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none;max-width:220px;">${esc(input.brand.slogan)}</span>`
      : "";

  return (
    `<header style="position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:16px;height:54px;padding:0 22px;background:rgba(27,34,56,.97);backdrop-filter:blur(8px);border-bottom:1px solid #0e1424;">` +
    switcher +
    slogan +
    crumbsNav +
    `<div style="flex:none;display:flex;align-items:center;gap:14px;">` +
    releaseBadge +
    langToggle +
    `</div></header>`
  );
}

export function renderTruthConsole(input: TruthConsoleInput): string {
  const view = withSnapshotPanels(input);
  const tabBar = TABS.map(
    (t) =>
      `<a href="#${t.key}" data-tab="${t.key}" class="console-tab">${bi(t.en, t.zh)}</a>`,
  ).join("");

  const header = topBar(view);

  const css = SHELL_CSS + `
.console-tab{appearance:none;border:1px solid transparent;border-bottom:0;background:transparent;color:${C.sub};font-size:13px;font-weight:600;padding:9px 16px;border-radius:9px 9px 0 0;cursor:pointer;text-decoration:none;}
.console-tab.on{background:${C.card};border-color:${C.line};color:${C.ink};box-shadow:0 -1px 2px rgba(17,26,69,.04);}
.console-tab:hover{color:${C.ink};}
a{color:${C.blue};}
.bl-epic{border:1px solid ${C.line};border-radius:12px;background:${C.card};margin:0 0 9px;overflow:hidden;box-shadow:0 1px 2px rgba(17,26,69,.04);}
.bl-epic summary::-webkit-details-marker{display:none;}
.bl-epic[open] .bl-caret{transform:rotate(90deg);}
.bl-row:hover{background:#f6f8fb;}
.bl-chip.on{border-color:${C.blue};box-shadow:0 0 0 1px ${C.blue}33;}
.cy-row summary::-webkit-details-marker{display:none;}
.cy-row[open] .bl-caret{transform:rotate(90deg);}
.cy-row summary:hover{background:#fbfcfe;}
.cy-range.on{background:${C.blue};color:#fff;}
.ag-row summary::-webkit-details-marker{display:none;}
@media(max-width:720px){[data-exec-ladder="true"]{grid-template-columns:1fr 1fr!important;}}
@media(max-width:520px){[data-exec-ladder="true"],[data-scenario-role],[data-hook]{grid-template-columns:1fr!important;}}
.ag-row[open] .bl-caret{transform:rotate(90deg);}
.ag-row summary:hover{background:#fbfcfe;}
.sk-row summary::-webkit-details-marker{display:none;}
.sk-row[open] .bl-caret{transform:rotate(90deg);}
.sk-row summary:hover{background:#fbfcfe;}
@media(max-width:760px){[data-now-section="operations"]{grid-template-columns:1fr!important;}}
@media (max-width:720px){.charter-browser{grid-template-columns:1fr !important;}.charter-tree{position:static !important;max-height:none !important;}}
` + MD_BODY_CSS;

  // US-DOSSIER-043: pane order == tab order (Now · Backlog · Loop · Release ·
  // Casting · Charter). Skills is NOT a project tab — it is a machine-global
  // page (skills.html) reached via the MACHINE breadcrumb.
  const panes =
    `<div id="tab-now">${nowTab(view)}</div>` +
    `<div id="tab-backlog" style="display:none;">${backlogTab(view)}</div>` +
    `<div id="tab-loop" style="display:none;">${loopTab(view)}</div>` +
    `<div id="tab-release" style="display:none;">${releaseTab(view)}</div>` +
    `<div id="tab-casting" style="display:none;">${castingTab(view)}</div>` +
    `<div id="tab-charter" style="display:none;">${charterTab(view)}</div>`;

  return (
    htmlHead(rollScope(view)) +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${esc(view.brand.name)} · Truth Console</title>\n` +
    FONT_LINKS +
    `<style>${css}</style>\n` +
    `${CONSOLE_SCRIPT}\n</head>\n<body>\n` +
    header +
    `<main style="max-width:1100px;margin:0 auto;padding:0 22px 64px;">` +
    `<div style="display:flex;gap:6px;align-items:flex-end;border-bottom:1px solid #dfe4ec;position:sticky;top:54px;background:${C.bg};z-index:20;padding:16px 0 0;">${tabBar}</div>` +
    panes +
    `</main>\n` +
    `<script id="roll-truth" type="application/json">\n${view.snapshotJson.replace(/<\//g, "<\\/")}</script>\n` +
    `</body>\n</html>\n`
  );
}

export interface MachineStubInput extends TopBarInput {
  /** Which machine-global page this is — drives the heading + highlighted link. */
  page: MachineNavLink["key"];
}

/**
 * US-DOSSIER-027 — the machine-global pages (Agents · Skills · Conventions ·
 * About) the top-bar breadcrumb routes to. Later stories fill these with real
 * content; THIS story emits them as the stub targets so the routing contract is
 * live (no 404) and they already wear the same sticky top-bar shell. They share
 * the console's switcher + lang script, so EN/中 and the project switcher work
 * here too.
 */
export function renderMachineStubPage(input: MachineStubInput): string {
  const meta = MACHINE_NAV.find((m) => m.key === input.page) ?? { key: input.page, en: input.page, zh: input.page, href: `${input.page}.html` };
  const header = topBar({ ...input, machinePage: input.page });
  const COMING: Record<MachineNavLink["key"], { en: string; zh: string }> = {
    agents: { en: "The machine-wide agent roster lands here.", zh: "机器级 agent 名册将落在这里。" },
    skills: { en: "The machine-wide skills catalog lands here.", zh: "机器级技能清单将落在这里。" },
    tools: { en: "The machine-wide built-in tool catalog lands here.", zh: "机器级内置工具清单将落在这里。" },
    conventions: { en: "The shared conventions live here.", zh: "共享约定将住在这里。" },
    about: { en: "About roll on this machine.", zh: "关于本机上的 roll。" },
  };
  const note = COMING[input.page];
  return (
    htmlHead(rollScope(input)) +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${esc(input.brand.name)} · ${meta.en}</title>\n` +
    FONT_LINKS +
    `<style>${SHELL_CSS}</style>\n` +
    `${CONSOLE_SCRIPT}\n</head>\n<body>\n` +
    header +
    `<main style="max-width:1100px;margin:0 auto;padding:0 22px 64px;">` +
    `<div style="padding:34px 0 8px;">` +
    kicker(bi("Machine layer", "机器层")) +
    `<h1 style="margin:10px 0 0;font-size:33px;line-height:1.1;font-weight:700;letter-spacing:-.02em;color:${C.ink};">${bi(meta.en, meta.zh)}</h1>` +
    `<p style="margin:12px 0 0;max-width:660px;font-size:15.5px;line-height:1.6;color:${C.sub};">${bi(note.en, note.zh)}</p></div>` +
    `<section style="border:1px dashed ${C.line};border-radius:12px;background:${C.card};padding:28px 24px;margin:18px 0;color:${C.faint};font-size:13.5px;">` +
    bi("This page is being built.", "本页建设中。") +
    `</section>` +
    `</main>\n</body>\n</html>\n`
  );
}

/**
 * US-DOSSIER-032 — the machine-global page shell, factored out of
 * `renderMachineStubPage` so a real filled-in page (e.g. the Skills page in
 * `page-skills.ts`) can wear the EXACT same sticky top-bar shell — switcher +
 * machine breadcrumb + EN/中 toggle, the console's `CONSOLE_SCRIPT` (lang +
 * copy-chip + switcher wiring) and fonts — without re-implementing the chrome.
 * `extraCss` is appended after `SHELL_CSS`; `bodyHtml` is the page's own
 * `<main>` content. The breadcrumb highlights `page`.
 */
/**
 * The IBM Plex font-family stack, inlined — the SAME face the `FONT_LINKS`
 * Google Fonts request pulls, but resolved from the system when IBM Plex is
 * installed and falling back to a cool system sans/mono otherwise. A
 * `selfContained` machine page swaps the external `<link>` for this so the page
 * opens offline as a single file and carries NO external `<link>` (the
 * offline-openable single-file red line the suite enforces).
 */
export const SELF_CONTAINED_FONT_CSS =
  `:root{` +
  `--roll-sans:"IBM Plex Sans","IBM Plex Sans SC",-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;` +
  `--roll-mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;}` +
  `body{font-family:var(--roll-sans);}`;

export function renderMachineShell(input: {
  page: MachineNavLink["key"];
  titleEn: string;
  brand: TruthConsoleBrand;
  projects?: ProjectRegistryEntry[];
  currentSlug?: string;
  snapshot: { release?: { latestTag?: string } };
  extraCss?: string;
  bodyHtml: string;
  /** When true, omit the external font `<link>` and inline the IBM Plex stack
   *  instead — the page stays a single offline-openable file (no `<link>`). */
  selfContained?: boolean;
}): string {
  const header = topBar({
    brand: input.brand,
    ...(input.projects !== undefined ? { projects: input.projects } : {}),
    ...(input.currentSlug !== undefined ? { currentSlug: input.currentSlug } : {}),
    snapshot: input.snapshot,
    machinePage: input.page,
  });
  const fontHead = input.selfContained === true ? "" : FONT_LINKS;
  const fontCss = input.selfContained === true ? SELF_CONTAINED_FONT_CSS : "";
  return (
    htmlHead(rollScope(input)) +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${esc(input.brand.name)} · ${esc(input.titleEn)}</title>\n` +
    fontHead +
    `<style>${fontCss}${SHELL_CSS}${input.extraCss ?? ""}</style>\n` +
    `${CONSOLE_SCRIPT}\n</head>\n<body>\n` +
    header +
    `<main style="max-width:1100px;margin:0 auto;padding:0 22px 64px;">` +
    input.bodyHtml +
    `</main>\n</body>\n</html>\n`
  );
}

/** US-DOSSIER-032 — palette/typography tokens + the bilingual `bi()` reused by
 *  the dedicated machine-global page renderers, so they stay on one visual
 *  system without re-deriving the design tokens. */
export const CONSOLE_TOKENS = { C, MONO } as const;
export { bi as biSpan };
export function machineKicker(text: string): string {
  return kicker(text);
}
export function machineMasthead(input: { kicker: string; title: string; lede?: string }): string {
  return (
    `<div style="padding:30px 0 4px;">` +
    machineKicker(input.kicker) +
    `<h1 style="margin:10px 0 0;font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.02em;color:${C.ink};">${input.title}</h1>` +
    (input.lede !== undefined && input.lede !== ""
      ? `<p style="margin:10px 0 0;max-width:660px;font-size:14.5px;line-height:1.55;color:${C.sub};">${input.lede}</p>`
      : "") +
    `</div>`
  );
}
export function escHtml(s: string): string {
  return esc(s);
}
