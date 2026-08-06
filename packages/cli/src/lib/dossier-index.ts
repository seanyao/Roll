/**
 * @responsibility Builds the Features Index landing page as the Delivery Dossier front page.
 */
/**
 * US-DOSSIER-001a — the Features Index landing page, rebuilt as the Delivery
 * Dossier front page. The page exists to make one thing legible in ten
 * seconds: backlog is *wish*, main is *truth*, and how much wish has become
 * truth — per project (ledger) and per epic (cards).
 *
 * Layout: masthead (kicker + serif H1 + lede) → ledger (4 figures +
 * wish→truth bar) → lifecycle spine motif → toolbar (search + only-shipping)
 * → epic cards in two groups ("Shipping to main", then "In backlog").
 * Self-contained single file: chrome script + dossier filter script only.
 */
import { CHROME_CONTROLS, CHROME_CSS, CHROME_SCRIPT, bi } from "@roll/core";
import {
  SPINE_STAGES,
  deriveDeliveryLadder,
  storySpectrumState,
  countLegacyStories,
  NO_EVIDENCE,
  type TruthBoardAudit,
  type TruthBoardCycle,
  type TruthBoardRelease,
  type TruthBoardInput,
  type TruthBoardVerdict,
} from "@roll/core";
import { STATUS_MARKER, type DeliveryLadder, type StoryEvidenceFlags } from "@roll/spec";
import { type DossierEpic } from "./archive.js";
import { DOSSIER_CSS, DOSSIER_FILTER_SCRIPT } from "./dossier-css.js";

// Re-export for backward compat (US-OBS-016: logic moved to @roll/core)
export {
  SPINE_STAGES,
  deriveDeliveryLadder,
  storySpectrumState,
  countLegacyStories,
  NO_EVIDENCE,
  type TruthBoardInput,
  type TruthBoardVerdict,
};

/** The five lifecycle stations, shared with epic/story pages (001b/001c). */
// SPINE_STAGES — imported from @roll/core (US-OBS-016)

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The leading display glyph of a canonical {@link STATUS_MARKER} token (FIX-300).
 *  The dossier shows only the icon (the EN/ZH label is rendered separately), so it
 *  sources the glyph from the ONE marker set rather than hardcoding its own — e.g.
 *  Hold is the canonical 🚫, never the legacy lock 🔒. */
const markerGlyph = (marker: string): string => marker.split(" ")[0] ?? marker;

/**
 * US-DOSSIER-025 — the claimed→merged→attested ladder's visual identity for the
 * list surfaces (front-page spectrum/tally/legend, epic-page rows + mini-spine).
 * Taken verbatim from the design reference's truth model — attested = truth-green
 * #178a52, merged = attest-pending teal #0d9488, claimed = claim amber #c77d12 —
 * the SAME three hexes the story dossier spine + banners use (US-DOSSIER-023),
 * so the same rung paints the same color on every surface. Injected as a small
 * extra <style> block (NOT into DOSSIER_CSS, which stays hex-free) on both the
 * front page and the epic page; idempotent — a page lists it once.
 */
export const LADDER_CSS = `
/* front-page spectrum segments + tally + legend (US-DOSSIER-025 ladder) */
.s-attested{background:#178a52;} .s-merged{background:#0d9488;} .s-claimed{background:#c77d12;}
.statusboard.ladder{grid-template-columns:repeat(4,1fr);}
.tally.attested .num{color:#178a52;} .tally.attested .accentbar{background:#178a52;}
.tally.merged .num{color:#0d9488;} .tally.merged .accentbar{background:#0d9488;}
.tally.claimed .num{color:#c77d12;} .tally.claimed .accentbar{background:#c77d12;}
.i-attested{background:#178a52;} .i-merged{background:#0d9488;} .i-claimed{background:#c77d12;}
/* epic / front-page row status pills + the row mini lifespine delivery node */
.st-attested{color:#178a52;} .st-attested .sdot{background:#178a52;}
.st-merged{color:#0d9488;} .st-merged .sdot{background:#0d9488;}
.st-claimed{color:#c77d12;} .st-claimed .sdot{background:transparent;border:1px solid #c77d12;}
.struth.tr-attested{color:#178a52;border-color:#178a5288;}
.struth.tr-merged{color:#0d9488;border-color:#0d948888;}
.struth.tr-claimed{color:#c77d12;border-color:#c77d1288;border-style:dashed;}
.lifespine i.attested{border-color:#178a52;background:#178a52;}
.lifespine i.merged{border-color:#0d9488;background:#0d9488;}
.lifespine i.claimed{border-color:#c77d12;background:repeating-linear-gradient(45deg,#c77d12 0 1.5px,transparent 1.5px 3px);}
/* epic-page row pill rungs (.pill.attested/.merged/.claimed) */
.pill.attested{color:#178a52;border:1px solid #178a5288;}
.pill.merged{color:#0d9488;border:1px solid #0d948888;}
.pill.claimed{color:#c77d12;border:1px dashed #c77d1288;}
/* toolbar status-filter chips on the ladder vocabulary (pressed = rung color) */
.sf.attested[aria-pressed=true]{background:#178a52;color:#fff;}
.sf.merged[aria-pressed=true]{background:#0d9488;color:#fff;}
.sf.claimed[aria-pressed=true]{background:#c77d12;color:#fff;}
@media (max-width:680px){.statusboard.ladder{grid-template-columns:repeat(2,1fr);}}
`;

/** The decorative full spine on index/epic mastheads — delivery carries the truth badge. */
export function spineMotif(): string {
  const nodes = SPINE_STAGES.map((s, i) => {
    const cls = s.key === "delivery" ? " truth" : "";
    const seg = i < SPINE_STAGES.length - 1 ? `<span class="seg"></span>` : "";
    return `<span class="node${cls}"><span class="dot"></span><span class="tag">${bi(s.en, s.zh)}</span></span>${seg}`;
  });
  return `<div class="spine" aria-hidden="true">${nodes.join("")}</div>`;
}

type StoryView = DossierEpic["stories"][number];
type State = "done" | "wip" | "hold" | "todo" | "fail" | "unknown";

/**
 * US-DOSSIER-025 — the front-page render vocabulary. It is the spectrum `State`
 * with the lumped `done` split into the claimed→merged→attested ladder, so the
 * spectrum bar, tally cards, legend, and epic rows reflect the SAME three rungs
 * the story dossier (US-DOSSIER-023) and the truth.json registry (US-DOSSIER-021)
 * report. `attested` (merged + full attest evidence) and `merged` (merge truth,
 * attest pending) replace the binary `done`; `claimed` is a backlog ✅ Done with
 * no merge evidence yet (was bucketed `unknown` before, now its own honest rung).
 * The fail / wip / hold / todo / unknown buckets carry over unchanged.
 */
export type LadderState = "attested" | "merged" | "claimed" | "wip" | "hold" | "todo" | "fail" | "unknown";
/** Render order: strongest rung first, so the bar reads attested → … → unknown. */
const LADDER_STATES: readonly LadderState[] = ["attested", "merged", "claimed", "fail", "unknown", "wip", "todo", "hold"];
const STAGE_KEYS = SPINE_STAGES.map((s) => s.key);

// TruthBoard types — re-exported from @roll/core (US-OBS-016)

export interface RenderFeaturesIndexOptions {
  loopDigestHref?: string;
  morningReportHref?: string;
  truth?: TruthBoardInput;
  /** US-DOSSIER-010: the EXACT serialized TruthSnapshot written to truth.json —
   *  embedded verbatim so page data and the machine file cannot diverge. */
  snapshotJson?: string;
}

/** Claim/truth-aligned delivery state for one story (US-DOSSIER-010: exported
 *  as the ONE spectrum classifier every surface shares). */
// storySpectrumState, countLegacyStories — imported from @roll/core (US-OBS-016)

/**
 * US-DOSSIER-021 — the claim↔truth ladder rung a story has reached, derived from
 * the SAME `delivered` signal `collectDossier` already folds (it bakes in the
 * truth selector + FIX-278 offline merge evidence), never re-deriving merge from
 * scratch:
 *   - `attested` — delivered (merge truth) AND full attest evidence on disk:
 *     a report, an ac-map, and a real-pixel screenshot. The strongest rung.
 *   - `merged`   — delivered (merge truth) but missing some attest evidence —
 *     the honest middle rung, never full green.
 *   - `claimed`  — the backlog claims Done (status==="done") but there is NO
 *     merge evidence (a premature-Done: the selector keeps `delivered` false).
 *   - `"none"`   — not even claimed done (todo / wip / hold / absent).
 */
// deriveDeliveryLadder — imported from @roll/core (US-OBS-016)

/**
 * US-DOSSIER-025 — the ONE ladder classifier every front-page surface shares,
 * built on the SAME `deriveDeliveryLadder` the story dossier + truth.json
 * registry use (zero duplicated rung logic — duplicating it per surface is the
 * exact drift this story closes). Truth drift / unknown verdicts win first
 * (they are not a rung); otherwise:
 *   - delivered → `attested` (merge + full evidence) | `merged` (merge, attest
 *     pending) via the shared ladder + the story's enriched `evidence` flags.
 *   - backlog ✅ Done but no merge evidence → `claimed` (a wish, not yet truth).
 *   - live work → `wip` | `hold` | `todo`.
 * Deterministic: no clock/locale dependence, byte-stable across reruns.
 */
export function storyLadderState(s: StoryView): LadderState {
  if (s.truthState === "fail") return "fail";
  if (s.truthState === "unknown") return "unknown";
  if (s.status === "in_progress") return "wip";
  if (s.status === "hold") return "hold";
  const rung = deriveDeliveryLadder(s, s.evidence ?? NO_EVIDENCE);
  if (rung === "attested" || rung === "merged" || rung === "claimed") return rung;
  // `none`: not delivered and not claimed Done. A `done` status with no merge
  // evidence is `claimed` above; anything left that claims done is honest unknown.
  if (s.status === "done") return "unknown";
  return "todo";
}

function storyState(s: StoryView): State {
  if (s.truthState === "fail") return "fail";
  if (s.truthState === "unknown") return "unknown";
  if (s.status === "in_progress") return "wip";
  if (s.status === "hold") return "hold";
  if (s.delivered) return "done"; // backlog ✅ Done, or heuristic-delivered
  if (s.status === "done") return "unknown";
  return "todo";
}

/** Count stories by state across a list of epics. */
function tallyStates(epics: DossierEpic[]): Record<State, number> {
  const t: Record<State, number> = { done: 0, wip: 0, hold: 0, todo: 0, fail: 0, unknown: 0 };
  for (const e of epics) for (const s of e.stories) t[storyState(s)] += 1;
  return t;
}

/** US-DOSSIER-025 — count stories by ladder rung (the `done` split into
 *  attested vs merged + the claimed rung). The spectrum / tally / legend read
 *  this so they stay one-to-one with the per-story rung and the registry. */
function tallyLadder(epics: DossierEpic[]): Record<LadderState, number> {
  const t = Object.fromEntries(LADDER_STATES.map((k) => [k, 0])) as Record<LadderState, number>;
  for (const e of epics) for (const s of e.stories) t[storyLadderState(s)] += 1;
  return t;
}

function dataOrQ(v: string | number | undefined): string {
  return v === undefined ? "?" : esc(String(v));
}

/** FIX-361: format a cost value with the correct currency symbol. */
function moneyOrQ(v: number | undefined, currency = "USD"): string {
  if (v === undefined) return "?";
  const sym = currency === "CNY" ? "\u00A5" : "$";
  return `${sym}${v.toFixed(2)}`;
}

/** FIX-361: format cycle cost, preferring per-currency breakdown when available. */
function cycleCostHtml(c: TruthBoardCycle | undefined): string {
  if (c === undefined) return "?";
  const byCur = c.costByCurrency3d;
  if (byCur !== undefined && Object.keys(byCur).length > 0) {
    return Object.entries(byCur)
      .map(([cur, val]) => moneyOrQ(val, cur))
      .join(" + ");
  }
  return moneyOrQ(c.costUsd3d);
}

function truthBoardVerdict(epics: DossierEpic[], truth: TruthBoardInput | undefined): TruthBoardVerdict {
  const t = tallyStates(epics);
  const audit = truth?.audit;
  const release = truth?.release;
  if ((audit?.fail ?? 0) > 0 || t.fail > 0 || release?.verdict === "fail") return "fail";
  if ((audit?.warn ?? 0) > 0 || release?.verdict === "warn") return "warn";
  if (truth === undefined || audit === undefined || release === undefined || (audit.unknown > 0) || t.unknown > 0 || release.verdict === "unknown") {
    return "unknown";
  }
  return "pass";
}

function storyTruthTile(epics: DossierEpic[]): string {
  const t = tallyStates(epics);
  const total = epics.reduce((n, e) => n + e.stories.length, 0);
  let covered = 0;
  for (const e of epics) {
    for (const s of e.stories) {
      if (s.stages?.includes("delivery") === true || s.delivered) covered += 1;
    }
  }
  const pct = total > 0 ? Math.round((covered / total) * 100) : 0;
  return (
    `<section class="truth-tile story">` +
    `<h2>Story</h2>` +
    `<div class="truth-metric"><b>${pct}%</b><span>${bi("attest coverage", "验收覆盖")}</span></div>` +
    `<dl><dt>${bi("truth fail", "真相失败")}</dt><dd>${t.fail}</dd>` +
    `<dt>${bi("unknown", "未知")}</dt><dd>${t.unknown}</dd></dl>` +
    `</section>`
  );
}

function cycleTruthTile(truth: TruthBoardInput | undefined): string {
  const c = truth?.cycle;
  return (
    `<section class="truth-tile cycle">` +
    `<h2>Cycle</h2>` +
    `<div class="truth-metric"><b>${dataOrQ(c?.cycles3d)}</b><span>${bi("cycles / 3d", "近 3 天周期")}</span></div>` +
    `<dl><dt>${bi("failed", "失败")}</dt><dd>${dataOrQ(c?.failed3d)}</dd>` +
    `<dt>${bi("cost", "花费")}</dt><dd>${cycleCostHtml(c)}</dd></dl>` +
    `</section>`
  );
}

function releaseTruthTile(truth: TruthBoardInput | undefined): string {
  const r = truth?.release;
  return (
    `<section class="truth-tile release ${r?.verdict ?? "unknown"}">` +
    `<h2>Release</h2>` +
    `<div class="truth-metric"><b>${dataOrQ(r?.latestTag)}</b><span>${bi("latest tag", "最近标签")}</span></div>` +
    `<dl><dt>${bi("verdict", "判定")}</dt><dd>${dataOrQ(r?.verdict)}</dd>` +
    `<dt>${bi("waiver", "豁免")}</dt><dd>${dataOrQ(r?.waiver)}</dd></dl>` +
    `</section>`
  );
}

export function renderTruthBoard(epics: DossierEpic[], truth: TruthBoardInput | undefined): string {
  const verdict = truthBoardVerdict(epics, truth);
  const audit = truth?.audit;
  const collectedAt = truth?.collectedAt ?? audit?.collectedAt ?? truth?.cycle?.collectedAt ?? truth?.release?.collectedAt;
  const release = truth?.release;
  const verdictText = verdict === "pass" ? bi("all clear", "全部通过") : verdict;
  return (
    `<section class="truth-board" data-truth-board="${verdict}">` +
    `<div class="truth-strip ${verdict}">` +
    `<span class="truth-label">${bi("Truth", "真相")}</span>` +
    `<strong>${verdictText}</strong>` +
    `<span>${bi("audit", "审计")} f:${dataOrQ(audit?.fail)} w:${dataOrQ(audit?.warn)} ?:${dataOrQ(audit?.unknown)}</span>` +
    `<span>${bi("release", "发版")} ${dataOrQ(release?.verdict)}${release?.waiver !== undefined ? ` · ${bi("waiver", "豁免")} ${esc(release.waiver)}` : ""}</span>` +
    `<span>${bi("generated", "生成")} ${dataOrQ(truth?.generatedAt)}</span>` +
    `<span>${bi("collected", "采集")} ${dataOrQ(collectedAt)}</span>` +
    `</div>` +
    `<div class="truth-tiles">${storyTruthTile(epics)}${cycleTruthTile(truth)}${releaseTruthTile(truth)}</div>` +
    `</section>`
  );
}

/** US-DOSSIER-025 — a segmented proportional bar (the "delivery spectrum") over
 *  the ladder tally: the strongest rung (attested, truth-green) leads, then
 *  merged (attest-pending teal), claimed (amber), then drift / unknown / live
 *  work. The `done`-equivalent is split into attested vs merged so the bar never
 *  disagrees with the per-story rung or the truth.json registry. */
function spectrum(t: Record<LadderState, number>, cls: string): string {
  const total = LADDER_STATES.reduce((n, k) => n + t[k], 0) || 1;
  const seg = (k: LadderState): string =>
    t[k] > 0 ? `<span class="s-${k}" style="width:${(t[k] / total) * 100}%"></span>` : "";
  return `<div class="${cls}">${LADDER_STATES.map(seg).join("")}</div>`;
}

/** The five-station lifecycle spine for one story, from its real `stages`. */
function storySpine(s: StoryView): string {
  // US-DOSSIER-008: a pre-v3 legacy delivery has no v3 evidence trail, so the
  // evidence-based spine would render bare and read as half-finished. Show the
  // whole spine in a uniform muted "legacy done" state instead of lying either way.
  if (s.legacy) {
    let lh = "";
    STAGE_KEYS.forEach((_, i) => {
      lh += `<i></i>`;
      if (i < STAGE_KEYS.length - 1) lh += `<b></b>`;
    });
    return `<span class="lifespine legacy" title="历史交付 · pre-v3，无 v3 留痕 / legacy delivery">${lh}</span>`;
  }
  // Enriched `stages` win; absent (un-enriched render) → derive from delivered.
  const done = new Set<string>(
    s.stages ?? (s.delivered ? ["definition", "design", "execution", "delivery"] : ["definition"]),
  );
  const state = storyLadderState(s);
  // US-DOSSIER-025: the delivery node carries its ladder rung, not a binary fill —
  // attested (truth-green) > merged (teal) > claimed (amber, reached-but-unproven;
  // lit even though merge-gated `stages` exclude delivery). Same three rungs the
  // story dossier spine + truth.json registry report, so a row never reads fully
  // done unless it is at least `merged`.
  const rung: DeliveryLadder | "none" =
    state === "attested" ? "attested" : state === "merged" ? "merged" : state === "claimed" ? "claimed" : "none";
  const deliveryReached = (k: string): boolean => (k === "delivery" ? rung !== "none" : done.has(k));
  const active = state === "wip" || state === "hold";
  const firstUndone = STAGE_KEYS.findIndex((k) => !deliveryReached(k));
  let html = "";
  STAGE_KEYS.forEach((k, i) => {
    let cls = "";
    if (k === "delivery") {
      cls = rung !== "none" ? rung : active && i === firstUndone ? "now" : "";
    } else {
      cls = done.has(k) ? "on" : active && i === firstUndone ? "now" : "";
    }
    html += `<i class="${cls}"></i>`;
    if (i < STAGE_KEYS.length - 1) {
      const segOn = deliveryReached(k) && deliveryReached(STAGE_KEYS[i + 1]!);
      html += `<b class="${segOn ? "on" : ""}"></b>`;
    }
  });
  const title = SPINE_STAGES.map((st) => `${st.zh}${deliveryReached(st.key) ? "✓" : "—"}`).join(" ");
  return `<span class="lifespine${state === "hold" ? " held" : ""}" title="${title}">${html}</span>`;
}

/** US-DOSSIER-025 — the ladder rung's short EN status word for the row pill. */
const LADDER_WORD: Record<LadderState, string> = {
  attested: "attested",
  merged: "merged",
  claimed: "claimed",
  wip: "wip",
  hold: "hold",
  todo: "todo",
  fail: "fail",
  unknown: "unknown",
};

/** One story row inside an expanded epic: type · id · title · spine · status.
 *  US-DOSSIER-025: the status pill is the ladder rung (attested / merged /
 *  claimed / …), the SAME rung the row spine, the epic page, and the truth.json
 *  registry carry — not the old binary `done`. */
function storyRow(epic: string, s: StoryView): string {
  const state = storyLadderState(s);
  const type = (s.type || "").toUpperCase();
  const href = `${encodeURIComponent(epic)}/${encodeURIComponent(s.id)}/index.html`;
  const claim = s.status !== undefined ? `<span class="sclaim cl-${state}">claim ${s.status === "in_progress" ? "wip" : s.status}</span>` : "";
  const truthText =
    state === "unknown" ? "truth ?"
    : state === "fail" ? "truth fail"
    : state === "attested" ? "truth attested"
    : state === "merged" ? "truth merged"
    : state === "claimed" ? "truth ?" // claimed = no merge evidence yet → unproven
    : "";
  const truth = truthText !== "" ? `<span class="struth tr-${state}" title="${esc(s.truthReason ?? "")}">${truthText}</span>` : "";
  // US-DOSSIER-008: legacy (pre-v3) deliveries are done, but flagged apart.
  const chip = s.legacy
    ? `<span class="slegacy" title="历史交付：pre-v3 已完成，无 v3 证据链">${bi("legacy", "历史")}</span>`
    : "";
  return (
    `<a class="story${s.legacy ? " is-legacy" : ""}" href="${href}" data-status="${state}">` +
    `<span class="stype ${esc(type)}">${esc(type)}</span>` +
    `<span class="sid">${esc(s.id)}</span>` +
    `<span class="stitle">${esc(s.title ?? s.id)}</span>` +
    storySpine(s) +
    `<span class="sstat st-${state}"><span class="sdot"></span>${LADDER_WORD[state]}${chip}${claim}${truth}</span>` +
    `</a>`
  );
}

/** One epic as a foldable <details>: summary (name + mini-spectrum + tally),
 *  body = its story rows. data-search/data-status drive the toolbar filter. */
function epicFold(e: DossierEpic): string {
  const t = tallyLadder([e]);
  const states = [...new Set(e.stories.map(storyLadderState))].join(" ");
  const search = `${e.name} ${e.stories.map((s) => `${s.id} ${s.title ?? ""}`).join(" ")}`;
  const hasOverview = (e.docs ?? []).some((d) => d.kind === "overview");
  const docMark = hasOverview
    ? `<span class="epic-docmark has-overview">${bi("overview", "总览")}</span>`
    : `<span class="epic-docmark no-overview">${bi("no overview", "无总览")}</span>`;
  return (
    `<details class="epic" data-search="${esc(search)}" data-status="${states}" data-truth="${e.delivered > 0 ? "1" : "0"}">` +
    `<summary class="epic-sum">` +
    `<span class="caret">▸</span>` +
    `<span class="epic-main">` +
    `<span class="epic-name"><a href="${encodeURIComponent(e.name)}/index.html">${esc(e.name)}</a>${docMark}</span>` +
    spectrum(t, "epic-mini") +
    `</span>` +
    `<span class="epic-tally"><b>${e.delivered}</b><span class="of"> / ${e.stories.length}</span></span>` +
    `</summary>` +
    `<div class="stories">${e.stories.map((s) => storyRow(e.name, s)).join("")}</div>` +
    `</details>`
  );
}

/** Count delivered stories that are legacy (pre-v3, no v3 evidence trail). */
function countLegacy(epics: DossierEpic[]): number {
  let n = 0;
  for (const e of epics) for (const s of e.stories) if (s.legacy) n += 1;
  return n;
}

/** The pulled-out status overview: tallies + the delivery spectrum.
 *  US-DOSSIER-025: the tallies + spectrum + legend are now the claimed→merged→
 *  attested ladder. The old lumped "Done" card splits into Attested (merge + full
 *  attest evidence) and Merged (merge truth, attest pending), and Claimed (backlog
 *  Done with no merge evidence yet) is its own honest card — the same three rungs
 *  the per-story dossier + truth.json registry report. `% merged to main` stays
 *  (attested + merged) / total, the same `delivered` proportion as before. */
function overview(epics: DossierEpic[]): string {
  const t = tallyLadder(epics);
  const total = epics.reduce((n, e) => n + e.stories.length, 0);
  const mergedToMain = t.attested + t.merged; // delivered (merge truth) at either rung
  const pct = total > 0 ? Math.round((mergedToMain / total) * 100) : 0;
  // US-DOSSIER-008: the attested/merged cards annotate how many deliveries are
  // legacy (pre-v3, no v3 evidence trail) — legacy sits at the `merged` rung.
  const legCount = countLegacy(epics);
  const card = (k: LadderState, mark: string, en: string, zh: string, sub = ""): string =>
    `<a class="tally ${k}" href="#" data-jump="${k}"><div class="mark">${mark}</div>` +
    `<div class="num">${t[k]}</div><div class="lbl">${bi(en, zh)}</div>${sub}<div class="accentbar"></div></a>`;
  const leg = (k: LadderState, en: string, zh: string): string =>
    `<span><i class="i-${k}"></i>${bi(en, zh)}</span>`;
  return (
    `<div class="statusboard ladder">` +
    card("attested", "✓", "Attested", "已验收") +
    card("merged", "◐", "Merged", "已合主干", legCount > 0 ? `<div class="tsub">${bi(`incl. ${legCount} legacy`, `含 ${legCount} 历史`)}</div>` : "") +
    card("claimed", "△", "Claimed", "仅声称") +
    card("fail", "!", "Drift", "漂移") +
    card("unknown", "?", "Unknown", "未知") +
    card("wip", markerGlyph(STATUS_MARKER.in_progress), "In progress", "进行中") +
    card("todo", markerGlyph(STATUS_MARKER.todo), "Todo", "待办") +
    card("hold", markerGlyph(STATUS_MARKER.hold), "Hold", "挂起") +
    `</div>` +
    `<div class="spectrum-wrap">` +
    spectrum(t, "spectrum") +
    `<div class="pctline">${bi(`${total} stories · ${epics.length} epics`, `在册 ${total} 故事 · ${epics.length} 史诗`)}` +
    `<span><b>${pct}%</b> ${bi("merged to main", "已合主干")}</span></div>` +
    `<div class="spectrum-legend">${leg("attested", "attested", "已验收")}${leg("merged", "merged", "已合")}${leg("claimed", "claimed", "仅声称")}${leg("fail", "drift", "漂移")}${leg("unknown", "unknown", "未知")}${leg("wip", "in progress", "进行中")}${leg("todo", "todo", "待办")}${leg("hold", "hold", "挂起")}</div>` +
    `</div>`
  );
}

/** US-DOSSIER-025 — the search + status-filter toolbar, chips on the ladder
 *  vocabulary so a chip's `data-sf` matches the `data-status` rungs the epic
 *  folds now carry (attested / merged / claimed / …); the filter script keys off
 *  these unchanged. ONE definition shared by the front page and the fragment. */
function toolbarFilter(): string {
  const chip = (k: LadderState, mark: string, en: string, zh: string): string =>
    `<button class="sf ${k}" data-sf="${k}" aria-pressed="false">${mark} ${bi(en, zh)}</button>`;
  return (
    `<div class="toolbar">` +
    `<input type="search" data-dossier-search placeholder="Search epics &amp; stories · 搜索史诗与故事" aria-label="search">` +
    `<div class="statusfilter" role="group">` +
    chip("attested", "✓", "Attested", "已验收") +
    chip("merged", "◐", "Merged", "已合") +
    chip("claimed", "△", "Claimed", "仅声称") +
    chip("fail", "!", "Drift", "漂移") +
    chip("unknown", "?", "Unknown", "未知") +
    chip("wip", markerGlyph(STATUS_MARKER.in_progress), "WIP", "进行") +
    chip("todo", markerGlyph(STATUS_MARKER.todo), "Todo", "待办") +
    chip("hold", markerGlyph(STATUS_MARKER.hold), "Hold", "挂起") +
    `</div></div>\n`
  );
}

/** Render the Delivery Dossier front page — a delivery board: a pulled-out
 *  status overview (tallies + spectrum), then foldable epics grouped by their
 *  aggregate state, each story carrying its lifecycle spine + backlog status. */
/** US-DOSSIER-011: the searchable ledger (toolbar + epic groups) as a fragment —
 *  the Truth Console embeds it under the Backlog tab until US-DOSSIER-012
 *  redesigns that surface. Same markup the legacy front page renders. */
export function featuresLedgerFragment(epics: DossierEpic[]): string {
  const done = epics.filter((e) => e.stories.length > 0 && e.delivered === e.stories.length);
  const shipping = epics.filter((e) => e.delivered > 0 && e.delivered < e.stories.length);
  const backlog = epics.filter((e) => e.delivered === 0);
  const group = (title: string, zh: string, list: DossierEpic[]): string =>
    list.length === 0
      ? ""
      : `<div class="section-h">${bi(title, zh)} <span class="ct">${list.length}</span><span class="rule"></span></div>\n` +
        `${list.map(epicFold).join("\n")}\n`;
  return (
    toolbarFilter() +
    group("Shipping to main", "交付中", shipping) +
    group("Delivered to main", "已交付", done) +
    group("In backlog", "仍在待办", backlog)
  );
}

export function renderFeaturesIndex(epics: DossierEpic[], opts: RenderFeaturesIndexOptions = {}): string {
  const done = epics.filter((e) => e.stories.length > 0 && e.delivered === e.stories.length);
  const shipping = epics.filter((e) => e.delivered > 0 && e.delivered < e.stories.length);
  const backlog = epics.filter((e) => e.delivered === 0);
  const group = (title: string, zh: string, list: DossierEpic[]): string =>
    list.length === 0
      ? ""
      : `<div class="section-h">${bi(title, zh)} <span class="ct">${list.length}</span><span class="rule"></span></div>\n` +
        `${list.map(epicFold).join("\n")}\n`;
  return (
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>Roll · Delivery Dossier</title>\n` +
    `<style>\n${CHROME_CSS}${DOSSIER_CSS}${LADDER_CSS}body { max-width:1040px; }\n</style>\n` +
    `${CHROME_SCRIPT}\n${DOSSIER_FILTER_SCRIPT}\n</head>\n<body>\n${CHROME_CONTROLS}\n` +
    `<div class="masthead">\n` +
    `<p class="kicker">Roll · ${bi("Delivery Dossier", "交付档案")}</p>\n` +
    `<h1>${bi("Features Index", "功能档案")}</h1>\n` +
    `<p class="lede">${bi(
      "The backlog is a <em>wish</em>; main is the <em>truth</em>. A story is done only when it has merged — this board keeps the two honest.",
      "待办是<em>愿望</em>，主干是<em>事实</em>。故事只有合入主干才算完成——这块看板让两者互相对得上。",
    )}</p>\n` +
    `</div>\n` +
    renderTruthBoard(epics, opts.truth) +
    overview(epics) +
    (opts.loopDigestHref !== undefined
      ? `<p class="ops-link"><a href="${esc(opts.loopDigestHref)}">${bi("Loop Digest", "循环摘要")}</a></p>\n`
      : opts.morningReportHref !== undefined
        ? `<p class="ops-link"><a href="${esc(opts.morningReportHref)}">${bi("Loop Digest", "循环摘要")}</a></p>\n`
        : "") +
    toolbarFilter() +
    group("Shipping to main", "交付中", shipping) +
    group("Delivered to main", "已交付", done) +
    group("In backlog", "仍在待办", backlog) +
    `<footer>${bi("Generated by", "生成自")} <code>roll index</code></footer>\n` +
    // US-DOSSIER-010: the machine-readable snapshot, byte-equal to truth.json
    // (the same serialized string; `</` escaped so JSON can never close the tag).
    (opts.snapshotJson !== undefined
      ? `<script id="roll-truth" type="application/json">\n${opts.snapshotJson.replace(/<\//g, "<\\/")}</script>\n`
      : "") +
    `</body>\n</html>\n`
  );
}
