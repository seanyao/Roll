/**
 * @responsibility Renders acceptance evidence and delivery truth into standalone reports.
 * US-ATTEST-005 — Acceptance Review Page renderer: ONE self-contained HTML file
 * (all CSS inline, no external assets; screenshots referenced RELATIVELY as
 * `./screenshots/*.png`), offline-openable and print-to-PDF friendly.
 *
 * Status ladder (design D5 + US-ATTEST-012 状态口径补全):
 *   ✅ pass      live evidence from this session (command output / shot / curl)
 *   🟩 pass-with-evidence  harness-confirmed from strong on-disk evidence
 *   🟦 readonly  boundary observation (config visible, log line exists)
 *   🟨 partial   partly satisfied — note MUST say which sub-condition is open
 *   ❌ fail      verified AND failed — 验证过且失败 ≠ 缺证据 (not a positive claim)
 *   ⛔ blocked   a precondition blocks verification (note SHOULD say which)
 *   🟧 claimed   statement only (commit/PR text), no artifact
 *   🟥 missing   nothing found at all
 *
 * RED LINE (RL-EVID-003: registered redline in policy/rules.yaml — enforced
 * HERE, not trusted from the caller): an AC item with ZERO
 * evidence refs cannot claim pass/readonly/partial — it is FORCED down to
 * `claimed` and surfaces in the "Discrepancies" appendix. The reporter is the
 * last line of defense against "嘴上 Done"(FIX-198 的台词层/动作层教训).
 *
 * Deletion-not-placeholder: the screenshot <figure> renders ONLY when a
 * screenshot evidence ref exists (no placeholder image, no warning text — D6).
 */
import { type CaptureReceiptV2, type CaptureClass, type CaptureSource, type EvidenceVisualState, type CycleRoleSummary, type CycleRoleName, type CycleRoleAttemptState, type OutwardVerificationStatus } from "@roll/spec";
import { CHROME_CONTROLS, CHROME_CSS, CHROME_SCRIPT, bi } from "../html/chrome.js";
import { ANSI_CSS } from "./ansi-html.js";
import type { DeliveryCiFact } from "../delivery/delivery-ci.js";
import { buildExecutionCastProjection, type ExecutionCastRow } from "./execution-cast.js";

export type AcStatus = "pass" | "pass-with-evidence" | "readonly" | "partial" | "fail" | "blocked" | "claimed" | "missing";

export interface EvidenceRef {
  kind: "screenshot" | "text" | "commit" | "ci" | "deploy" | "test-pass" | "cast" | "video";
  /** Short human label (e.g. `tcr: FIX-200 修正偏移` / `CI run`). */
  label: string;
  /** Relative path (screenshots) or external URL (ci/deploy) — optional. */
  href?: string;
  /** Pre-rendered inline HTML (the ANSI `<pre>` for kind=text). */
  inlineHtml?: string;
}

export interface AcReportItem {
  id: string;
  text: string;
  status: AcStatus;
  evidence: EvidenceRef[];
  /** Required free-text for `partial` (which sub-condition is open). */
  note?: string;
}

/**
 * US-ATTEST-013 — the delivery chain a reviewer needs to trace a story end to
 * end without leaving the report. Every field is optional; empties are trimmed.
 */
export interface DeliveryChain {
  prLinks?: Array<{ label: string; href: string }>;
  cycleId?: string;
  timeline?: string;
  cost?: string;
}

/**
 * US-ATTEST-013 — self-contained card context (the business body's lead): what
 * the todo is, in plain language, plus where it sits and how it shipped. Drawn
 * from the card README + backlog + delivery facts by the caller. Any subset may
 * be present; a context with no populated sub-field renders nothing (trim).
 */
export interface CardContext {
  oneLiner?: string;
  epic?: string;
  summary?: string;
  backlogStatus?: string;
  delivery?: DeliveryChain;
}

/**
 * US-META-010 — shadow DoD signal: the delivery changed user-visible command
 * surface or output copy without a docs touch in the same diff. This is warning
 * evidence only; it never changes the acceptance gate verdict yet.
 */
export interface DocGapWarning {
  changedFiles: string[];
  visibleFiles: string[];
}

/**
 * US-ATTEST-013 — a坏态/好态 pair for FIX / behaviour-changing US. `before-*.png`
 * / `after-*.png` shots render side by side. Brand-new features carry none.
 */
export interface BeforeAfterPair {
  label: string;
  before: EvidenceRef;
  after: EvidenceRef;
}

/**
 * US-ATTEST-014 — one timeline entry of the process trace (structurally the
 * core extractor's {@link TimelineEntry}, restated here so the renderer stays
 * decoupled from the loop module). `offsetSec` is seconds since cycle start.
 */
export interface ProcessTimelineEntry {
  offsetSec: number;
  layer: "outline" | "signal";
  marker: string;
  label: string;
}

/**
 * US-ATTEST-014 — the cycle process archive a reviewer traces to answer "how
 * did this card actually get built". Loop-delivered cards carry a cycle id +
 * agent + timeline + (bounded) transcript; a card delivered by hand degrades to
 * `delivery: "manual"` ("conductor 手工交付") with whatever process evidence is
 * available. Any missing segment is named in {@link missing} (D1 degrade, never
 * a hard error). Absent archive ⇒ the whole section is trimmed.
 */
export interface ProcessArchive {
  delivery: "loop" | "manual";
  cycleId?: string;
  agent?: string;
  /** Chronological timeline (outline spine + signal turning points). */
  timeline?: ProcessTimelineEntry[];
  /** Human-readable per-tool breakdown, e.g. bash×3(21s) · browser×1(3s). */
  toolCostSummary?: string;
  /** Bounded raw transcript, pre-rendered to inline HTML (ANSI→HTML). */
  transcript?: {
    inlineHtml: string;
    truncated: boolean;
    totalLen: number;
    shownLen: number;
    /** Path to the machine original (indexed, never embedded whole). */
    originalPath?: string;
  };
  /** Segments unavailable for this card (e.g. ["transcript"]) — degrade markers. */
  missing?: string[];
}

/**
 * US-ATTEST-017 — one outward AC's resolved verification, rendered prominently
 * so a human operator can never mistake a simulation pass or a skipped external
 * smoke for green acceptance. `status` is the resolved outcome from
 * `@roll/core`'s outward resolver (US-ATTEST-015); only `verified` is green.
 */
export interface OutwardAcReport {
  /** The AC id (e.g. `US-X-001:AC4`). */
  ac: string;
  /** How this AC declared it would be verified. */
  mode: "external-smoke" | "owner-attested";
  /** Resolved outcome — drives the badge and the (non-)green line. */
  status: OutwardVerificationStatus;
  /** external-smoke: the declared environment (ci/nightly/release). */
  environment?: string;
  /** external-smoke: the smoke command template (never credentials). */
  command?: string;
  /** owner-attested: the traceable approval reference. */
  approvalRef?: string;
  /** Human-readable resolver note / failure detail / smoke summary. */
  detail?: string;
}

export const REVIEW_SCORE_LOW_THRESHOLD = 5;

export interface ReviewScoreReportEntry {
  skill: string;
  score: number;
  verdict: string;
  ts: string;
  note: string;
  href?: string;
  dimensions?: Record<string, number>;
}

export interface CaptureSkipReportEntry {
  kind: string;
  out: string;
  skipped: string;
}

export interface CaptureAnnotation {
  target: string;
  requestedBy: string;
  capturedAt: string;
  declaredFullscreen: boolean;
}

export interface PhysicalCaptureReportEntry {
  provider: string;
  kind: string;
  statusChain: readonly string[];
  reason?: string;
  screenshot?: EvidenceRef;
  requestPath?: string;
  responsePath?: string;
  ledgerLinks?: Array<{ label: string; href: string }>;
  ledgerDetails?: string[];
  /** US-PHYSICAL-007 — visible provenance for every accepted physical screenshot. */
  annotation?: CaptureAnnotation;
}

/**
 * US-EVID-031 — one accepted (or legacy) capture image beneath a shared surface.
 * Every retained image is rendered with its provenance, physical/rendered class,
 * hash, and a link to its receipt; NO image is hidden merely because a
 * higher-preference lane failed (AC4).
 */
export interface CaptureSurfaceImage {
  source: CaptureSource;
  captureClass: CaptureClass;
  /** Provenance label, e.g. `Roll Capture · physical` / `Playwright · rendered`. */
  label: string;
  /** Run-relative href to the PNG (`screenshots/*.png`). */
  href?: string;
  /** PNG digest (`sha256:…`). */
  sha256?: string;
  /** Run-relative href to the receipt (`*.response.json`) — the linked receipt. */
  receiptHref?: string;
  requestId: string;
  /** Legacy captures stay visible + labelled legacy; never promoted (builder_notes). */
  legacy?: boolean;
}

/**
 * US-EVID-031 — a declared visual surface with its resolved visual-evidence
 * health and every retained image mapped to it. One physical AND one rendered
 * image can sit under the same declared surface (AC6).
 */
export interface CaptureSurfaceReport {
  surfaceId: string;
  /** The resolved 4-state visual health (AC1/AC5). */
  visual: EvidenceVisualState;
  /** The ACs this surface backs. */
  acIds: readonly string[];
  images: CaptureSurfaceImage[];
  /** Why the surface is degraded / blocked (rendered when non-verified). */
  reason?: string;
}

export interface ReportInput {
  storyId: string;
  title: string;
  /** ISO timestamp injected by the caller (clock-free renderer). */
  generatedAt: string;
  items: AcReportItem[];
  /** US-ATTEST-013 — business-body lead: self-contained card context. */
  context?: CardContext;
  /** US-ATTEST-013 — before/after comparison pairs (empty ⇒ section trimmed). */
  beforeAfter?: BeforeAfterPair[];
  /** US-EVID-004 / US-V4-001 — after-only delivery visuals for brand-new
   *  surfaces (no `before-*` counterpart). Rendered inside the same Before/After
   *  section so the evidence has a home in the story-scoped Review Page now that the
   *  global dossier delivery page is retired. Empty/absent ⇒ nothing emitted. */
  afterOnly?: EvidenceRef[];
  /** Summary facts row (counts come from evidence.json). */
  facts?: { tcrCount: number; ciConclusion: string; testPassAge: string };
  /**
   * US-EVID-033 — this card's delivery-time CI truth (its own PR's checks at the
   * sha they ran on). Absent ⇒ the block is trimmed; a `red`/`unknown` state is
   * rendered as-is with its reason, never softened.
   */
  deliveryCi?: DeliveryCiFact;
  /** US-ATTEST-009 — same-story Review Score entries from .roll/notes/; the
   *  whole collapsed block is SKIPPED when none exist (no placeholder). */
  reviewScores?: ReviewScoreReportEntry[];
  /** US-EVID-013 — US-SKILL-014 trend line, computed by the CLI reader. */
  reviewScoreTrend?: string;
  /** US-ATTEST-014 — the cycle process archive (timeline + signal layer +
   *  folded transcript). Absent ⇒ section trimmed; `manual` delivery degrades. */
  process?: ProcessArchive;
  /** US-OBS-034 — cycle role summary (Execution Cast). Absent ⇒ block trimmed. */
  cycleRoleSummary?: CycleRoleSummary;
  /** Relative href to summary.json artifact (for artifact links in the Execution Cast block). */
  cycleRoleSummaryHref?: string;
  /** Hrefs keyed by CycleRoleAttempt artifact/log paths. */
  cycleRoleArtifactHrefs?: Record<string, string>;
  /** US-META-010 — doc/code/product alignment shadow warning. */
  docGap?: DocGapWarning;
  /** US-ATTEST-011 — screenshots an unattended cycle's Gate produced for itself
   *  (terminal lane). Renders a dedicated figure section; the block is SKIPPED
   *  when empty (deletion-not-placeholder — a headless host that honestly
   *  skipped the capture surfaces NOTHING here, never a placeholder). */
  selfCaptures?: EvidenceRef[];
  /** FIX-258 — machine-generated capture skips. These are not screenshot
   *  placeholders and do not count as pixels; they are structured facts that
   *  explain why a screenshot could not be produced. */
  captureSkips?: CaptureSkipReportEntry[];
  /** US-PHYSICAL-004 — physical.screenshot provider status chain. */
  physicalCaptures?: PhysicalCaptureReportEntry[];
  /** US-EVID-031 — declared capture surfaces with resolved visual health and every
   *  retained image (physical + rendered) mapped to a shared surface. Absent/empty
   *  ⇒ section trimmed (legacy stories render nothing). */
  captureSurfaces?: CaptureSurfaceReport[];
  /** US-SKILL-030 — design-contract-vs-delivered evidence delta from the spec's
   *  Evaluation contract block. Empty string or absent => section trimmed
   *  (legacy specs degrade gracefully). */
  evidenceDeltaSummary?: string;
  /** US-ATTEST-017 — outward AC verification, rendered as a prominent banner +
   *  table near the head of the report. Empty/absent ⇒ section trimmed (legacy
   *  stories with no outward ACs render nothing). Any non-`verified` entry
   *  forces the banner into its non-green state. */
  outwardVerification?: OutwardAcReport[];
}

const BADGE: Record<AcStatus, { icon: string; en: string; zh: string; cls: string }> = {
  pass: { icon: "✅", en: "Pass", zh: "通过", cls: "s-pass" },
  "pass-with-evidence": { icon: "🟩", en: "Pass with Evidence", zh: "证据通过", cls: "s-pass" },
  readonly: { icon: "🟦", en: "Read-only Pass", zh: "只读通过", cls: "s-readonly" },
  partial: { icon: "🟨", en: "Partial", zh: "部分满足", cls: "s-partial" },
  fail: { icon: "❌", en: "Fail", zh: "未通过", cls: "s-fail" },
  blocked: { icon: "⛔", en: "Blocked", zh: "受阻", cls: "s-blocked" },
  claimed: { icon: "🟧", en: "Claimed", zh: "仅声明", cls: "s-claimed" },
  missing: { icon: "🟥", en: "Missing", zh: "无证据", cls: "s-missing" },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The red line: a POSITIVE claim with no evidence ⇒ at best `claimed`. Only the
 * positive verdicts (pass/pass-with-evidence/readonly/partial) are downgraded — `fail` and
 * `blocked` are NOT positive claims (US-ATTEST-012: 验证过且失败 ≠ 缺证据), so a
 * fail/blocked with zero refs stays itself and never surfaces as a discrepancy;
 * `claimed`/`missing` are already at/below the floor.
 */
const POSITIVE: ReadonlySet<AcStatus> = new Set<AcStatus>(["pass", "pass-with-evidence", "readonly", "partial"]);
export function enforceRedLine(item: AcReportItem): { item: AcReportItem; downgraded: boolean } {
  if (item.evidence.length === 0 && POSITIVE.has(item.status)) {
    return { item: { ...item, status: "claimed" }, downgraded: true };
  }
  return { item, downgraded: false };
}

/**
 * US-PHYSICAL-009 — turn an accepted v2 physical receipt into a screenshot
 * EvidenceRef so its PNG reaches the report attachment path (`screenshots/*`).
 * Returns null for a non-taken receipt with no artifact (deletion-not-placeholder).
 * `screenshotPathHref` overrides the rendered href (e.g. a run-relative manifest
 * path); otherwise the receipt's own screenshotPath basename is used.
 */
export function captureReceiptEvidenceRef(receipt: CaptureReceiptV2, screenshotPathHref?: string): EvidenceRef | null {
  if (receipt.state !== "taken") return null;
  if (receipt.screenshotPath === undefined || receipt.screenshotPath.length === 0) return null;
  const href = screenshotPathHref ?? `screenshots/${receipt.screenshotPath.split(/[\\/]/u).pop() ?? receipt.screenshotPath}`;
  const label = `${receipt.captureClass === "physical" ? "Roll Capture · physical" : "Playwright · rendered"} · ${receipt.surfaceId}`;
  return { kind: "screenshot", label, href };
}

function evidenceCard(ref: EvidenceRef): string {
  if (ref.kind === "screenshot" && ref.href !== undefined) {
    // deletion contract: figure exists ONLY because the artifact exists.
    return `<figure class="shot"><img src="${esc(ref.href)}" alt="${esc(ref.label)}"><figcaption>${esc(ref.label)}</figcaption></figure>`;
  }
  if (ref.kind === "cast" && ref.href !== undefined) {
    const inline = ref.inlineHtml !== undefined ? ref.inlineHtml : "";
    return (
      `<details class="ev ev-cast cast-replay"><summary>${bi("Dynamic replay", "动态复现")} · ${esc(ref.label)}</summary>` +
      `<p><a href="${esc(ref.href)}">${esc(ref.href)}</a></p>${inline}</details>`
    );
  }
  if (ref.kind === "video" && ref.href !== undefined) {
    return (
      `<figure class="ev ev-video replay-video"><video controls preload="metadata" src="${esc(ref.href)}"></video>` +
      `<figcaption>${bi("Dynamic replay", "动态复现")} · ${esc(ref.label)}</figcaption></figure>`
    );
  }
  if (ref.kind === "text" && ref.inlineHtml !== undefined) {
    return `<div class="ev ev-text"><div class="ev-label">${esc(ref.label)}</div>${ref.inlineHtml}</div>`;
  }
  const body = ref.href !== undefined ? `<a href="${esc(ref.href)}">${esc(ref.label)}</a>` : esc(ref.label);
  return `<div class="ev ev-${ref.kind}">${body}</div>`;
}

/**
 * US-ATTEST-013 — information layering. Each AC carries business-facing evidence
 * (screenshots, PR/CI/deploy links — what a product reviewer reads) inline, and
 * technical evidence (ANSI command output / logs — kind=text) tucked into a
 * collapsed `<details>` that defaults closed. The fold is omitted entirely when
 * there is no technical evidence (deletion-not-placeholder).
 */
/** Delivery chain as a `<dl>`; empty when no sub-field is populated (trim). */
function deliveryBlock(d: DeliveryChain): string {
  const parts: string[] = [];
  if (d.prLinks !== undefined && d.prLinks.length > 0)
    parts.push(`<dt>PR</dt><dd>${d.prLinks.map((p) => `<a href="${esc(p.href)}">${esc(p.label)}</a>`).join(" · ")}</dd>`);
  if (d.cycleId !== undefined && d.cycleId !== "") parts.push(`<dt>Cycle</dt><dd><code>${esc(d.cycleId)}</code></dd>`);
  if (d.timeline !== undefined && d.timeline !== "") parts.push(`<dt>${bi("Timeline", "时间线")}</dt><dd>${esc(d.timeline)}</dd>`);
  if (d.cost !== undefined && d.cost !== "") parts.push(`<dt>${bi("Cost", "成本")}</dt><dd>${esc(d.cost)}</dd>`);
  return parts.length > 0 ? `<dl class="delivery">${parts.join("")}</dl>` : "";
}

/**
 * US-ATTEST-013 — the business body's lead. A product/business reviewer reads
 * this first and learns the whole story without leaving the report. Rendered
 * ONLY when at least one sub-field is populated; a fully-empty context is
 * trimmed (deletion-not-placeholder).
 */
function cardContextBlock(ctx: CardContext | undefined): string {
  if (ctx === undefined) return "";
  const rows: string[] = [];
  if (ctx.oneLiner !== undefined && ctx.oneLiner !== "") rows.push(`<p class="one-liner">${esc(ctx.oneLiner)}</p>`);
  const meta: string[] = [];
  if (ctx.epic !== undefined && ctx.epic !== "") meta.push(`Epic：${esc(ctx.epic)}`);
  if (ctx.backlogStatus !== undefined && ctx.backlogStatus !== "") meta.push(`Backlog：${esc(ctx.backlogStatus)}`);
  if (meta.length > 0) rows.push(`<p class="ctx-meta">${meta.join(" · ")}</p>`);
  if (ctx.summary !== undefined && ctx.summary !== "") rows.push(`<p class="summary">${esc(ctx.summary)}</p>`);
  const delivery = ctx.delivery !== undefined ? deliveryBlock(ctx.delivery) : "";
  if (delivery !== "") rows.push(delivery);
  if (rows.length === 0) return "";
  return `<section class="card-context"><h2>${bi("Context", "卡上下文")}</h2>\n${rows.join("\n")}\n</section>`;
}

/**
 * US-ATTEST-017 — outward verification banner + table. Rendered near the head of
 * the report so a human operator sees the real-vs-simulated distinction before
 * scrolling into per-AC evidence. THE RED LINE: any status other than `verified`
 * is visibly non-green and the banner reads "incomplete". `verified-in-simulation`
 * and `unverified-external` never present as positive acceptance (AC1). The block
 * is trimmed entirely when there are no outward ACs.
 */
interface OutwardStatusRender {
  icon: string;
  line: string;
  cls: string;
  green: boolean;
}
function outwardStatusRender(o: OutwardAcReport): OutwardStatusRender {
  switch (o.status) {
    case "verified":
      return {
        icon: "✅",
        line: o.mode === "owner-attested" ? "VERIFIED (owner-attested)" : "VERIFIED (external smoke)",
        cls: "ov-verified",
        green: true,
      };
    case "verified-in-simulation":
      return {
        icon: "🟧",
        line: "verified-in-simulation — simulation only, NOT accepted",
        cls: "ov-simulation",
        green: false,
      };
    case "failed-external":
      return { icon: "❌", line: "FAILED — external smoke", cls: "ov-failed", green: false };
    case "unverified-external":
    default:
      return {
        icon: "🟥",
        line: o.mode === "owner-attested" ? "UNVERIFIED — owner attestation pending" : "UNVERIFIED — external smoke not run",
        cls: "ov-unverified",
        green: false,
      };
  }
}
function outwardVerificationBlock(entries: ReportInput["outwardVerification"]): string {
  if (entries === undefined || entries.length === 0) return "";
  const anyNonGreen = entries.some((e) => outwardStatusRender(e).green === false);
  const banner = anyNonGreen
    ? `<p class="ov-banner ov-banner-warn">⚠ ${bi(
        "Outward verification incomplete — the AC(s) below are NOT green acceptance.",
        "外部行为验证未完成——下列 AC 不构成绿色验收。",
      )}</p>`
    : `<p class="ov-banner ov-banner-ok">✅ ${bi(
        "Outward verification complete — every external AC ran real smoke or a valid owner attestation.",
        "外部行为验证已完成——每个外部 AC 都跑过真实 smoke 或持有有效的 owner 认证。",
      )}</p>`;
  const rows = entries
    .map((e) => {
      const r = outwardStatusRender(e);
      const meta: string[] = [];
      if (e.mode === "external-smoke") {
        if (e.environment !== undefined && e.environment !== "") meta.push(`env <code>${esc(e.environment)}</code>`);
        if (e.command !== undefined && e.command !== "") meta.push(`<code>${esc(e.command)}</code>`);
      } else {
        if (e.approvalRef !== undefined && e.approvalRef !== "") meta.push(`ref <code>${esc(e.approvalRef)}</code>`);
      }
      const metaHtml = meta.length > 0 ? `<div class="ov-meta">${meta.join(" · ")}</div>` : "";
      const detail = e.detail !== undefined && e.detail !== "" ? `<div class="ov-detail">${esc(e.detail)}</div>` : "";
      return `<tr class="ov-row ${r.cls}">
<td><code>${esc(e.ac)}</code></td>
<td>${esc(e.mode)}</td>
<td class="ov-result"><span class="ov-status">${r.icon} ${esc(r.line)}</span>${metaHtml}${detail}</td>
</tr>`;
    })
    .join("\n");
  return `<section class="outward-verification">
<h2>${bi("Outward verification", "外部行为验证")}</h2>
${banner}
<table class="ov-table"><thead><tr><th>AC</th><th>${bi("Mode", "模式")}</th><th>${bi("Result", "结果")}</th></tr></thead>
<tbody>${rows}</tbody></table>
</section>`;
}

function acSection(item: AcReportItem): string {
  const b = BADGE[item.status];
  const note = item.note !== undefined && item.note !== "" ? `<p class="note">${esc(item.note)}</p>` : "";
  const business = item.evidence.filter((e) => e.kind !== "text");
  const technical = item.evidence.filter((e) => e.kind === "text");
  const bizHtml = business.map(evidenceCard).join("\n");
  const techHtml =
    technical.length > 0
      ? `<details class="tech"><summary>${bi(`Technical detail (${technical.length})`, `技术细节（${technical.length}）`)}</summary>\n${technical.map(evidenceCard).join("\n")}\n</details>`
      : "";
  return `<section class="ac ${b.cls}" id="${esc(item.id)}">
<h3><span class="badge">${b.icon} ${bi(b.en, b.zh)}</span> <code>${esc(item.id)}</code></h3>
<p class="ac-text">${esc(item.text)}</p>
${note}
${bizHtml}
${techHtml}
</section>`;
}

/**
 * US-ATTEST-013 — before/after comparison. Each pair renders its two shots side
 * by side (a flex row that wraps to stacked on narrow viewports). A figure is
 * emitted only for a ref that carries an href; a pair with neither shot is
 * dropped, and an empty list trims the whole section (全新功能免出).
 */
function beforeAfterBlock(pairs: ReportInput["beforeAfter"], afterOnly?: ReportInput["afterOnly"]): string {
  const fig = (ref: EvidenceRef, side: string, cls: string): string =>
    ref.href !== undefined
      ? `<figure class="shot ${cls}"><img src="${esc(ref.href)}" alt="${esc(ref.label)}"><figcaption>${side}：${esc(ref.label)}</figcaption></figure>`
      : "";
  const groups = (pairs ?? [])
    .map((p) => {
      const before = fig(p.before, bi("Before", "改前"), "ba-before");
      const after = fig(p.after, bi("After", "改后"), "ba-after");
      if (before === "" && after === "") return "";
      return `<div class="before-after"><h3>${esc(p.label)}</h3><div class="ba-pair">${before}${after}</div></div>`;
    })
    .filter((s) => s !== "");
  // US-V4-001: after-only delivery shots (brand-new surfaces) render in the same
  // section so they keep an evidence home in the story-scoped report.
  const singles = (afterOnly ?? [])
    .map((ref) => fig(ref, bi("After", "改后"), "ba-after delivery-shot-single"))
    .filter((s) => s !== "");
  if (groups.length === 0 && singles.length === 0) return "";
  const body = [...groups, ...singles].join("\n");
  return `<section class="before-after-section"><h2>${bi("Before / After", "对照实拍")}</h2>\n${body}\n</section>`;
}

/**
 * US-ATTEST-011 — the unattended Gate's own screenshots. Renders ONLY when the
 * terminal lane actually produced pixels (the bridge yields no ref on skip), so
 * a headless cycle drops this screenshot block — deletion-not-placeholder, same
 * red line as the per-AC screenshot figure. Structured skips render separately.
 */
function selfCaptureBlock(refs: ReportInput["selfCaptures"]): string {
  if (refs === undefined || refs.length === 0) return "";
  const figs = refs.map(evidenceCard).join("\n");
  return `<section class="self-capture"><h2>${bi("Gate self-capture", "Gate 自产实拍")}</h2>\n${figs}\n</section>`;
}

function captureSkipBlock(skips: ReportInput["captureSkips"]): string {
  if (skips === undefined || skips.length === 0) return "";
  const rows = skips
    .map((s) => {
      const json = JSON.stringify({ kind: s.kind, out: s.out, taken: false, skipped: s.skipped }, null, 2);
      return `<details class="capture-skip"><summary>${bi("Capture skip", "截图跳过")} · ${esc(s.kind)}</summary><pre data-machine-capture-skip="true">${esc(json)}</pre></details>`;
    })
    .join("\n");
  return `<section class="capture-skips"><h2>${bi("Capture skip", "截图跳过")}</h2>\n${rows}\n</section>`;
}

function physicalCaptureBlock(entries: ReportInput["physicalCaptures"]): string {
  if (entries === undefined || entries.length === 0) return "";
  const rows = entries
    .map((entry) => {
      const shot = entry.screenshot !== undefined ? evidenceCard(entry.screenshot) : "";
      const reason = entry.reason !== undefined && entry.reason !== "" ? `<p class="note">${esc(entry.reason)}</p>` : "";
      const links: string[] = [];
      if (entry.requestPath !== undefined && entry.requestPath !== "") {
        links.push(`<a href="${esc(entry.requestPath)}">request</a>`);
      }
      if (entry.responsePath !== undefined && entry.responsePath !== "") {
        links.push(`<a href="${esc(entry.responsePath)}">response</a>`);
      }
      for (const link of entry.ledgerLinks ?? []) {
        links.push(`<a href="${esc(link.href)}">${esc(link.label)}</a>`);
      }
      const linked = links.length > 0 ? `<p class="physical-links">${links.join(" · ")}</p>` : "";
      const details =
        entry.ledgerDetails !== undefined && entry.ledgerDetails.length > 0
          ? `<ul class="physical-links">${entry.ledgerDetails.map((detail) => `<li>${esc(detail)}</li>`).join("")}</ul>`
          : "";
      const annotation = entry.annotation;
      const annotationHtml =
        annotation !== undefined
          ? `<dl class="physical-links"><dt>${bi("Target", "目标")}</dt><dd>${esc(annotation.target)}</dd>` +
            `<dt>${bi("Requested by", "请求方")}</dt><dd>${esc(annotation.requestedBy)}</dd>` +
            `<dt>${bi("Captured at", "拍摄于")}</dt><dd>${esc(annotation.capturedAt)}</dd>` +
            `<dt>${bi("Declared fullscreen", "显式声明全屏")}</dt><dd>${annotation.declaredFullscreen ? bi("yes", "是") : bi("no", "否")}</dd></dl>`
          : "";
      return `<details class="physical-capture" open><summary>${esc(entry.provider)} · ${esc(entry.kind)} · ${esc(entry.statusChain.join(" → "))}</summary>${reason}${shot}${linked}${annotationHtml}${details}</details>`;
    })
    .join("\n");
  return `<section class="physical-captures"><h2>physical.screenshot</h2>\n${rows}\n</section>`;
}

// US-EVID-031 — visual-health badge copy per resolved state (AC5: the three
// distinct signals are visibly rendered, not just verified vs not).
const VISUAL_BADGE: Record<EvidenceVisualState, { icon: string; en: string; zh: string; cls: string }> = {
  verified: { icon: "🟢", en: "Verified", zh: "已验证", cls: "vh-verified" },
  "degraded-infrastructure": { icon: "🟠", en: "Evidence degraded (infrastructure)", zh: "证据降级（基础设施）", cls: "vh-degraded" },
  "invalid-target": { icon: "⛔", en: "Invalid target (blocked)", zh: "目标非法（受阻）", cls: "vh-blocked" },
  "absent-contract": { icon: "🟥", en: "Absent contract (blocked)", zh: "契约缺失（受阻）", cls: "vh-blocked" },
};

/**
 * US-EVID-031 — render every declared capture surface with its resolved visual
 * health and EVERY retained image (physical + rendered) beneath the shared
 * surface, each with provenance, class, hash, and a linked receipt (AC4/AC6).
 * A lower-preference image is never hidden because a higher one failed. Legacy
 * images stay visible and labelled legacy (builder_notes). Absent ⇒ trimmed.
 */
function captureSurfacesBlock(surfaces: ReportInput["captureSurfaces"]): string {
  if (surfaces === undefined || surfaces.length === 0) return "";
  const rows = surfaces
    .map((s) => {
      const badge = VISUAL_BADGE[s.visual];
      const acs = s.acIds.length > 0 ? `<p class="cs-acs">${bi("Backs", "支撑")}: ${s.acIds.map((a) => `<code>${esc(a)}</code>`).join(" · ")}</p>` : "";
      const reason = s.visual !== "verified" && s.reason !== undefined && s.reason !== "" ? `<p class="cs-reason">${esc(s.reason)}</p>` : "";
      const figs =
        s.images.length > 0
          ? `<div class="cs-figs">${s.images.map(captureSurfaceFigure).join("\n")}</div>`
          : `<p class="note">${bi("No image retained for this surface.", "该 surface 无留存图像。")}</p>`;
      return (
        `<section class="capture-surface ${badge.cls}" data-visual="${esc(s.visual)}">` +
        `<h3><a href="${esc(s.surfaceId)}"><code>${esc(s.surfaceId)}</code></a> ` +
        `<span class="vh-badge ${badge.cls}">${badge.icon} ${bi(badge.en, badge.zh)}</span></h3>` +
        `${acs}${reason}${figs}</section>`
      );
    })
    .join("\n");
  return `<section class="capture-surfaces"><h2>${bi("Visual evidence by surface", "按 surface 的视觉证据")}</h2>\n${rows}\n</section>`;
}

/** One image figure under a surface: provenance + class + hash + linked receipt. */
function captureSurfaceFigure(img: CaptureSurfaceImage): string {
  const cls = img.captureClass === "physical" ? bi("physical", "实拍") : bi("rendered", "渲染");
  const legacy = img.legacy === true ? ` <span class="cs-legacy">${bi("legacy", "历史")}</span>` : "";
  const shot =
    img.href !== undefined
      ? `<a href="${esc(img.href)}"><img src="${esc(img.href)}" alt="${esc(img.label)}" loading="lazy"></a>`
      : `<p class="note">${bi("image not retained", "图像未留存")}</p>`;
  const hash = img.sha256 !== undefined ? `<span class="cs-hash" title="${esc(img.sha256)}">${esc(img.sha256)}</span>` : "";
  const receipt = img.receiptHref !== undefined ? ` · <a href="${esc(img.receiptHref)}">${bi("receipt", "回执")}</a>` : "";
  return (
    `<figure class="shot cs-fig" data-source="${esc(img.source)}" data-class="${esc(img.captureClass)}">` +
    `${shot}` +
    `<figcaption><b>${esc(img.label)}</b>${legacy} · ${cls}${receipt}${hash !== "" ? `<br>${hash}` : ""}</figcaption>` +
    `</figure>`
  );
}

/**
 * US-ATTEST-013 — closing evidence index. Every evidence file referenced
 * anywhere in the report (per-AC, before/after, self-capture) appears once in a
 * single table so a reviewer can reach the raw artifact directly. Screenshots /
 * external links show their locator; inlined text shows "inline". Skipped
 * entirely when nothing was collected (no empty table).
 */
function evidenceIndexBlock(
  items: AcReportItem[],
  beforeAfter: ReportInput["beforeAfter"],
  selfCaptures: ReportInput["selfCaptures"],
): string {
  const rows: string[] = [];
  const row = (ref: EvidenceRef): void => {
    const loc =
      ref.href !== undefined
        ? `<a href="${esc(ref.href)}">${esc(ref.href)}</a>`
        : ref.inlineHtml !== undefined
          ? "inline"
          : "—";
    rows.push(`<tr><td><code>${esc(ref.kind)}</code></td><td>${esc(ref.label)}</td><td>${loc}</td></tr>`);
  };
  for (const it of items) for (const e of it.evidence) row(e);
  if (beforeAfter !== undefined) for (const p of beforeAfter) for (const r of [p.before, p.after]) if (r.href !== undefined) row(r);
  if (selfCaptures !== undefined) for (const r of selfCaptures) row(r);
  if (rows.length === 0) return "";
  return `<section class="evidence-index"><h2>${bi("Evidence index", "证据索引")}</h2>
<table class="ev-index"><thead><tr><th>Kind</th><th>Label</th><th>Locator</th></tr></thead>
<tbody>${rows.join("\n")}</tbody></table></section>`;
}

function evidenceDeltaBlock(delta: string | undefined): string {
  if (!delta || delta.trim() === "") return "";
  return `<section class="evidence-delta"><h2>${bi("Design contract vs delivered evidence", "设计契约 vs 实际证据")}</h2>
<pre>${esc(delta.trim())}</pre>
</section>`;
}

function docGapBlock(warning: ReportInput["docGap"]): string {
  if (warning === undefined || warning.visibleFiles.length === 0) return "";
  const shown = warning.visibleFiles.slice(0, 12);
  const extra = warning.visibleFiles.length - shown.length;
  const list = shown.map((file) => `<li><code>${esc(file)}</code></li>`).join("\n");
  const more = extra > 0 ? `<li>${bi(`and ${extra} more`, `另有 ${extra} 个`)}</li>` : "";
  return `<section class="doc-gap"><h2>doc-gap · ${bi("Shadow warning", "Shadow 警示")}</h2>
<p>${bi(
    "User-visible command/copy files changed without a README/docs/guide/site update in the same diff. This is a shadow warning; it does not change the Gate verdict yet.",
    "本次 diff 修改了用户可见命令面/输出文案，但没有同步 README/docs/guide/site。该项仍是 shadow 警示，不改变 Gate 结论。",
  )}</p>
<ul>${list}${more}</ul>
</section>`;
}

/**
 * US-EVID-033 — delivery-time facts: THIS card's own PR, the head sha its checks
 * ran on, each check's conclusion, and the merge commit. A `red` or `unknown`
 * state is stated as such with its reason — never softened, never omitted. When
 * the fact was collected after the merge the block says so (post-hoc), so nobody
 * mistakes a reconstruction for cycle-time evidence.
 */
function deliveryCiBlock(fact: ReportInput["deliveryCi"]): string {
  if (fact === undefined) return "";
  const verdict =
    fact.state === "verified"
      ? `<span class="badge dci-verified">✅ ${bi("verified", "已核实")}</span>`
      : fact.state === "red"
        ? `<span class="badge dci-red">❌ ${bi("red", "红")}</span>`
        : `<span class="badge dci-unknown">❔ ${bi("unknown", "未知")}</span>`;
  const rows: string[] = [];
  if (fact.prNumber !== undefined) rows.push(`<li>PR <code>#${fact.prNumber}</code></li>`);
  if (fact.headSha !== undefined) rows.push(`<li>${bi("head sha", "head sha")} <code>${esc(fact.headSha)}</code></li>`);
  if (fact.mergeCommit !== undefined)
    rows.push(`<li>${bi("merge commit", "合并提交")} <code>${esc(fact.mergeCommit)}</code></li>`);
  if (fact.mergedAt !== undefined) rows.push(`<li>${bi("merged at", "合并时间")} <code>${esc(fact.mergedAt)}</code></li>`);
  const checks =
    fact.checks.length > 0
      ? `<ul>${fact.checks
          .map(
            (c) =>
              `<li><code>${esc(c.name)}</code> → <b>${esc(c.conclusion !== "" ? c.conclusion : bi("running", "进行中"))}</b></li>`,
          )
          .join("\n")}</ul>`
      : `<p class="note">${bi("No check runs were reported for this sha.", "该 sha 上没有任何检查记录。")}</p>`;
  const reason =
    fact.reason !== undefined
      ? `<p class="note">${bi("reason", "原因")}: <code>${esc(fact.reason)}</code></p>`
      : "";
  // Codex r4: the requirement set this verdict was measured against, WHICH surface
  // declared it, and the honest caveat that GitHub only exposes the CURRENT
  // configuration — all surfaced to the human reader, not just the JSON.
  const requirements =
    fact.requiredChecksSource !== undefined
      ? `<p class="note">${bi("required checks", "必需检查")}: ${
          fact.requiredChecks !== undefined && fact.requiredChecks.length > 0
            ? fact.requiredChecks
                .map((r) => `<code>${esc(r.context)}${r.appId !== undefined ? `@app${r.appId}` : ""}</code>`)
                .join(" ")
            : `<em>${bi("none declared", "未声明")}</em>`
        } · ${bi("source", "来源")} <code>${esc(fact.requiredChecksSource)}</code></p>
<p class="note">${bi(
          "Requirements reflect the CURRENT branch configuration — GitHub exposes no historical view, so a requirement relaxed after the merge cannot be detected here.",
          "必需检查取自分支的当前配置 —— GitHub 不提供历史视图，因此合并之后被放宽的要求在这里无法察觉。",
        )}</p>`
      : "";
  // Tri-state (codex r1): a timing we cannot establish is SAID to be unknown —
  // never rendered as if the evidence were collected during the cycle.
  const postHoc =
    fact.postHoc === "yes"
      ? `<p class="note">${bi(
          "Collected AFTER the merge — this is a post-hoc reconstruction of delivery-time truth, not cycle-time evidence.",
          "采集时间晚于合并 —— 这是对交付时真相的事后重建，不是周期内证据。",
        )}</p>`
      : fact.postHoc === "unknown"
        ? `<p class="note">${bi(
            "Merge time unknown — whether this was collected during the cycle or reconstructed afterwards cannot be established.",
            "合并时间未知 —— 无法判定这份证据是周期内采集还是事后重建。",
          )}</p>`
        : "";
  // Machine-stable markers so downstream readers (and the release gate) can read
  // the state without parsing prose.
  return `<section class="delivery-ci" data-state="${fact.state}" data-posthoc="${fact.postHoc}"><h2>${bi("Delivery-time facts", "交付时事实")} ${verdict}</h2>
<p class="note">${bi(
    "The checks that ran on this card's own PR, at the sha they ran on.",
    "这张卡自己的 PR 在其 head sha 上跑过的检查。",
  )}</p>
${rows.length > 0 ? `<ul>${rows.join("\n")}</ul>` : ""}
${checks}
${requirements}${reason}${postHoc}
<p class="note">${bi("collected at", "采集时间")} <code>${esc(fact.collectedAt)}</code></p>
</section>`;
}

/** Format whole seconds as `+MM:SS` (minutes grow past 59; timezone-free). */
function fmtOffset(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `+${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * US-ATTEST-014 — the process trace section. Loop-delivered cards lead with the
 * cycle id + agent, then the timeline (outline spine + signal turning points,
 * the signal layer styled so it is 一眼可辨), then the full transcript folded in
 * a `<details>` appendix carrying its truncation note and the machine-original
 * path index. A hand-delivered card degrades to "conductor 手工交付" and names
 * the missing segments. The whole section is trimmed when no archive is present.
 */
function processTraceBlock(p: ProcessArchive | undefined): string {
  if (p === undefined) return "";
  const rows: string[] = [];

  const mode =
    p.delivery === "manual"
      ? `<p class="delivery-mode">🧑‍🔧 ${bi("delivered by hand (no loop cycle)", "conductor 手工交付（无自动周期）")}</p>`
      : `<p class="delivery-mode">🔁 loop cycle${p.cycleId !== undefined && p.cycleId !== "" ? ` <code>${esc(p.cycleId)}</code>` : ""}${p.agent !== undefined && p.agent !== "" ? ` · agent <code>${esc(p.agent)}</code>` : ""}</p>`;
  rows.push(mode);

  if (p.timeline !== undefined && p.timeline.length > 0) {
    const li = p.timeline
      .map(
        (t) =>
          `<li class="tl-${t.layer === "signal" ? "signal" : "outline"}"><span class="tl-offset">${esc(fmtOffset(t.offsetSec))}</span> <span class="tl-label">${esc(t.label)}</span></li>`,
      )
      .join("\n");
    rows.push(`<ol class="timeline">\n${li}\n</ol>`);
  }

  if (p.toolCostSummary !== undefined && p.toolCostSummary !== "") {
    rows.push(`<p class="trace-cost"><strong>${bi("Tool cost", "工具成本")}</strong> ${esc(p.toolCostSummary)}</p>`);
  }

  if (p.missing !== undefined && p.missing.length > 0) {
    rows.push(`<p class="trace-missing">${bi("missing process data", "过程数据缺失")}：${p.missing.map(esc).join(" · ")}</p>`);
  }

  if (p.transcript !== undefined) {
    const t = p.transcript;
    const note = t.truncated
      ? bi(`truncated — ${t.shownLen} / ${t.totalLen} chars shown`, `已截断（展示 ${t.shownLen} / ${t.totalLen} 字符）`)
      : bi(`full inline — ${t.totalLen} chars`, `完整内联（${t.totalLen} 字符）`);
    const idx =
      t.originalPath !== undefined && t.originalPath !== ""
        ? `<p class="orig-path">${bi("machine original", "机器原件")}：<code>${esc(t.originalPath)}</code></p>`
        : "";
    rows.push(
      `<details class="transcript"><summary>${bi("Full transcript", "完整转录")}（${note}）</summary>\n${idx}\n${t.inlineHtml}\n</details>`,
    );
  }

  return `<section class="process-trace"><h2>${bi("Process trace", "过程档案")}</h2>\n${rows.join("\n")}\n</section>`;
}

function reviewScoreClass(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v === "good" || v === "ok" || v === "regression") return v;
  return "unknown";
}

function reviewScoreDimensions(e: ReviewScoreReportEntry): string {
  const dims = Object.entries(e.dimensions ?? {})
    .filter(([, v]) => Number.isFinite(v))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (dims.length === 0) return "";
  return `<div class="reviewscore-dims">${dims.map(([k, v]) => `<span><code>${esc(k)}</code>: <b>${esc(String(v))}</b></span>`).join(" ")}</div>`;
}

function reviewScoreIssues(entries: ReportInput["reviewScores"]): string[] {
  if (entries === undefined) return [];
  const out: string[] = [];
  for (const e of entries) {
    const verdict = e.verdict.toLowerCase();
    if (verdict === "regression") out.push(`review-score regression: ${e.score}/10`);
    else if (verdict === "ok" && e.score <= REVIEW_SCORE_LOW_THRESHOLD) out.push(`low review-score: ok ${e.score}/10`);
  }
  return out;
}

function reviewScoreBlock(entries: ReportInput["reviewScores"], trend: string | undefined): string {
  if (entries === undefined || entries.length === 0) return "";
  const li = entries
    .map((e) => {
      const cls = reviewScoreClass(e.verdict);
      const href = e.href !== undefined && e.href !== "" ? ` · <a href="${esc(e.href)}">${bi("Full note", "全文 note")}</a>` : "";
      return (
        `<li><span class="reviewscore-badge reviewscore-${cls}">${esc(e.verdict)}</span> ` +
        `<b>${esc(String(e.score))}</b>/10 · ${esc(e.verdict)} · <code>${esc(e.skill)}</code> · <span class="meta">${esc(e.ts)}</span>${href}` +
        `${e.note !== "" ? `<br><span class="note">${esc(e.note)}</span>` : ""}` +
        reviewScoreDimensions(e) +
        `</li>`
      );
    })
    .join("\n");
  const trendLine = trend !== undefined && trend !== "" ? `<p class="reviewscore-trend">${esc(trend)}</p>\n` : "";
  return `<details class="reviewscore"><summary>${bi("Review Score", "评审分")}（${entries.length}）</summary>\n${trendLine}<ul>\n${li}\n</ul>\n</details>`;
}



/**
 * US-OBS-034 — Execution Cast: render the cycle role chain as an HTML block.
 * Shows Builder, Peer Reviewer(s), accepted Evaluator/Scorer, parse failures,
 * and Attest Gate. Degrades gracefully when no summary is available.
 * Links to summary.json / summary.md when artifact paths are available.
 */
function executionCastBlock(
  cycleRoleSummary: CycleRoleSummary | undefined,
  summaryHref: string | undefined,
  artifactHrefs: Record<string, string> | undefined,
): string {
  if (cycleRoleSummary === undefined) {
    return `<section id="execution-cast" class="execution-cast"><h2>🎭 ${bi("Execution Cast", "执行阵容")}</h2>
<p class="text-muted">${bi("Role summary unavailable — cycle did not produce a role cast.", "角色摘要不可用——cycle 未产生角色阵容。")}</p></section>`;
  }

  const roleLabel = (role: CycleRoleName): string => {
    switch (role) {
      case "builder": return bi("Builder", "构建者");
      case "peer_reviewer": return bi("Peer Reviewer", "同行评审");
      case "evaluator": return bi("Evaluator", "评审员");
      case "attest_gate": return bi("Attest Gate", "验收门禁");
      case "designer": return bi("Designer", "设计者");
    }
  };

  const stateBadge = (state: CycleRoleAttemptState): string => {
    switch (state) {
      case "accepted": return `<span class="cast-badge cast-ok">✅ ${bi("Accepted", "已通过")}</span>`;
      case "rejected": return `<span class="cast-badge cast-fail">❌ ${bi("Rejected", "已拒绝")}</span>`;
      case "failed": return `<span class="cast-badge cast-fail">❌ ${bi("Failed", "失败")}</span>`;
      case "returned": return `<span class="cast-badge cast-warn">🔄 ${bi("Returned", "已退回")}</span>`;
      case "selected": return `<span class="cast-badge cast-pending">⏳ ${bi("Selected", "已选中")}</span>`;
      case "started": return `<span class="cast-badge cast-pending">▶️ ${bi("Started", "已开始")}</span>`;
      case "parsed": return `<span class="cast-badge cast-ok">📋 ${bi("Parsed", "已解析")}</span>`;
      case "not_required": return `<span class="cast-badge cast-muted">— ${bi("Not required", "无需")}</span>`;
      case "not_available": return `<span class="cast-badge cast-fail">⛔ ${bi("Not available", "不可用")}</span>`;
      // FIX-1054: a candidate deliberately NOT spawned (serial dispatch accepted
      // another reviewer/evaluator first) — a cost decision, not a failure.
      case "skipped": return `<span class="cast-badge cast-muted">⏭️ ${bi("Skipped", "已跳过")}</span>`;
    }
  };

  const projection = buildExecutionCastProjection(cycleRoleSummary);
  const rows = projection.rows.map((r) => executionCastRowHtml(r, roleLabel, stateBadge));

  // Summary artifact links
  const sourcesHtml = summaryHref
    ? `<p class="cast-links text-muted">📄 <a href="${esc(summaryHref)}">summary.json</a> · <a href="${esc(summaryHref.replace(/\.json$/, ".md"))}">summary.md</a></p>`
    : "";

  const artifactLinks = projection.artifactLinks
    .map((a) => {
      const href = cycleRoleSummaryHrefForPath(a.path, artifactHrefs);
      return href === undefined ? "" : `<a href="${esc(href)}">${esc(a.label)}</a>`;
    })
    .filter((x) => x !== "")
    .join(" · ");
  const artifactsHtml = artifactLinks !== "" ? `<p class="cast-links text-muted">🔗 ${artifactLinks}</p>` : "";

  return `<section id="execution-cast" class="execution-cast"><h2>🎭 ${bi("Execution Cast", "执行阵容")}</h2>
<p class="text-muted">${bi("Cycle", "周期")} <code>${esc(cycleRoleSummary.cycleId)}</code> · ${bi("Profile", "画像")}: ${esc(cycleRoleSummary.executionProfile)}</p>
<div class="cast-grid">
${rows.join("\n")}
</div>
${sourcesHtml}
${artifactsHtml}
</section>`;
}

function cycleRoleSummaryHrefForPath(path: string, hrefMap: Record<string, string> | undefined): string | undefined {
  if (hrefMap === undefined) return undefined;
  const href = hrefMap[path];
  return href === "" ? undefined : href;
}

function executionCastRowHtml(
  r: ExecutionCastRow,
  roleLabel: (role: CycleRoleName) => string,
  stateBadge: (state: CycleRoleAttemptState) => string,
): string {
  const agent = r.agent !== null ? `<code>${esc(r.agent)}</code>` : `<span class="text-muted">${bi("none", "无")}</span>`;
  const role = r.role === "evaluator" && r.state !== "accepted"
    ? bi("Evaluator (parse failure)", "评审解析失败")
    : roleLabel(r.role);
  const detail: string[] = [];
  if (r.model !== undefined) detail.push(`<span class="text-muted">${esc(r.model)}</span>`);
  if (r.score !== undefined) detail.push(`<strong>${r.score}/10</strong>`);
  if (r.verdict !== undefined) detail.push(`<span class="cast-verdict">${esc(r.verdict)}</span>`);
  if (r.findings !== undefined) detail.push(`${r.findings} ${bi("findings", "意见")}`);
  if (r.cause !== undefined) detail.push(`<span class="cast-fail-text">${esc(r.cause)}</span>`);
  if (r.detail !== undefined && r.role === "attest_gate") detail.push(`<span class="text-muted">${esc(r.detail)}</span>`);
  const detailHtml = detail.length > 0 ? ` · ${detail.join(" · ")}` : "";
  const cls =
    r.role === "builder" ? "cast-builder" :
    r.role === "peer_reviewer" ? "cast-peer" :
    r.role === "evaluator" && r.state !== "accepted" ? "cast-evaluator cast-failed" :
    r.role === "evaluator" ? "cast-evaluator" :
    r.role === "attest_gate" ? "cast-gate" :
    "cast-designer";
  return `<div class="cast-row ${cls}"><span class="cast-role-label">${role}</span>` +
    `<span class="cast-agent">${agent}${detailHtml}</span>` +
    `<span class="cast-state">${stateBadge(r.state)}</span></div>`;
}

/** Render the single-file report. Pure: same input → same bytes. */
export function renderReport(input: ReportInput): string {
  const enforced = input.items.map(enforceRedLine);
  const items = enforced.map((e) => e.item);
  const discrepancies = enforced.filter((e) => e.downgraded).map((e) => e.item);
  const scoreIssues = reviewScoreIssues(input.reviewScores);
  const counts = new Map<AcStatus, number>();
  for (const it of items) counts.set(it.status, (counts.get(it.status) ?? 0) + 1);

  const summary = (Object.keys(BADGE) as AcStatus[])
    .filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `<span class="badge ${BADGE[s].cls}">${BADGE[s].icon} ${bi(BADGE[s].en, BADGE[s].zh)} × ${counts.get(s)}</span>`)
    .join(" ");

  const facts =
    input.facts !== undefined
      ? `<p class="facts">TCR commits: <b>${input.facts.tcrCount}</b> · CI: <b>${esc(input.facts.ciConclusion || "—")}</b> · test-pass: <b>${esc(input.facts.testPassAge)}</b></p>`
      : "";

  const disc =
    discrepancies.length > 0 || scoreIssues.length > 0
      ? `<section class="discrepancies"><h2>${bi("Discrepancies", "证据缺口")}</h2>
${discrepancies.length > 0 ? `
<p>${bi(
          "The ACs below carried <strong>zero evidence entries</strong> and were force-downgraded to 🟧 Claimed (red line, enforced by the renderer):",
          "下列 AC 因<strong>没有任何证据条目</strong>被强制降级为 🟧 Claimed（红线，渲染层强制）：",
        )}</p>
<ul>${discrepancies.map((d) => `<li><a href="#${esc(d.id)}"><code>${esc(d.id)}</code></a> ${esc(d.text)}</li>`).join("\n")}</ul>
` : ""}
${scoreIssues.length > 0 ? `<p><strong>Review-score discrepancy</strong></p><ul>${scoreIssues.map((i) => `<li>${esc(i)}</li>`).join("\n")}</ul>` : ""}
</section>`
      : "";

  // US-ATTEST-013 + US-META-010 — 收口 (closing): quality gate → shadow doc-gap
  // → discrepancies → evidence index → review-score. Assembled then wrapped only
  // when non-empty (trim, no hollow section).
  const gate = facts !== "" ? `<h2>${bi("Quality gate", "质量门禁")}</h2>\n${facts}` : "";
  const deliveryCi = deliveryCiBlock(input.deliveryCi);
  const docGap = docGapBlock(input.docGap);
  const evDelta = evidenceDeltaBlock(input.evidenceDeltaSummary);
  const evIndex = evidenceIndexBlock(items, input.beforeAfter, input.selfCaptures);
  const reviewScore = reviewScoreBlock(input.reviewScores, input.reviewScoreTrend);
  const closingInner = [gate, deliveryCi, docGap, disc, evDelta, evIndex, reviewScore].filter((s) => s !== "").join("\n");
  const closing = closingInner !== "" ? `<section class="closing">\n${closingInner}\n</section>` : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.storyId)} — Acceptance Review Page · 验收 Review Page</title>
<style>
${CHROME_CSS}
.badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12.5px; border:1px solid var(--line); }
.facts, .note { color:var(--muted); font-size:13px; }
header.doc { position:relative; padding-right:96px; }
.seal { position:absolute; right:0; top:2px; width:74px; height:74px; border:2px solid var(--accent);
  border-radius:50%; transform:rotate(-12deg); color:var(--accent); font-family:var(--serif);
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px;
  font-size:17px; letter-spacing:.12em; opacity:.85; box-shadow:inset 0 0 0 2px transparent, inset 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); }
.seal span { font-size:9.5px; letter-spacing:.34em; text-indent:.34em; }
section.ac h3 { margin:0 0 6px; font-size:14.5px; }
.s-pass { border-left:4px solid var(--pass); } .s-readonly { border-left:4px solid var(--info); }
.s-partial { border-left:4px solid var(--warn); } .s-claimed { border-left:4px solid var(--claim); }
.s-fail { border-left:4px solid var(--fail); } .s-blocked { border-left:4px solid var(--block); }
.s-missing { border-left:4px solid var(--fail); }
figure.shot { margin:10px 0; } figure.shot img { max-width:100%; border:1px solid var(--line); border-radius:6px; }
figure.shot figcaption { color:var(--muted); font-size:12.5px; }
.ev { margin:6px 0; font-size:13.5px; } .ev-label { color:var(--muted); font-size:12.5px; margin-bottom:4px; }
.cast-replay { border:1px solid var(--line); border-radius:6px; padding:6px 12px; background:color-mix(in srgb, var(--fg) 3%, transparent); }
.cast-replay summary { cursor:pointer; color:var(--muted); font-size:12.5px; font-weight:600; }
.replay-video { margin:10px 0; } .replay-video video { width:100%; max-width:760px; border:1px solid var(--line); border-radius:6px; background:#000; }
.replay-video figcaption { color:var(--muted); font-size:12.5px; }
.delivery-ci { border:1px solid var(--line); border-radius:8px; padding:8px 16px; margin-top:28px; }
.dci-verified { color:var(--pass); } .dci-red { color:var(--fail); } .dci-unknown { color:var(--muted); }
.doc-gap { border:1px dashed var(--warn); border-radius:8px; padding:8px 16px; margin-top:28px; }
.doc-gap h2 { color:var(--warn); }
.discrepancies { border:1px dashed var(--claim); border-radius:8px; padding:8px 16px; margin-top:28px; }
details.reviewscore { margin-top:28px; border:1px solid var(--line); border-radius:8px; padding:8px 16px; background:var(--bg-raise); }
details.reviewscore summary { cursor:pointer; font-weight:600; }
details.reviewscore ul { margin:8px 0 4px; padding-left:18px; }
.reviewscore-badge { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 8px; font-size:12px; font-weight:600; }
.reviewscore-good { color:var(--pass); } .reviewscore-ok { color:var(--warn); } .reviewscore-regression { color:var(--fail); }
.reviewscore-dims, .reviewscore-trend { color:var(--muted); font-size:12.5px; margin-top:4px; }
.capture-skip { margin:8px 0; border:1px solid var(--line); border-radius:6px; padding:6px 12px; background:color-mix(in srgb, var(--fg) 3%, transparent); }
.capture-skip summary { cursor:pointer; color:var(--muted); font-size:12.5px; font-weight:600; }
.capture-skip pre { white-space:pre-wrap; font-size:12px; }
.physical-capture { margin:8px 0; border:1px solid var(--line); border-radius:6px; padding:6px 12px; background:color-mix(in srgb, var(--fg) 3%, transparent); }
.physical-capture summary { cursor:pointer; color:var(--muted); font-size:12.5px; font-weight:600; }
.physical-links { font-size:12.5px; color:var(--muted); }
section.capture-surfaces { margin-top:24px; }
.capture-surface { margin:12px 0; border:1px solid var(--line); border-left-width:4px; border-radius:6px; padding:8px 14px; }
.capture-surface.vh-verified { border-left-color:var(--pass); }
.capture-surface.vh-degraded { border-left-color:var(--warn); }
.capture-surface.vh-blocked { border-left-color:var(--fail); }
.capture-surface h3 { margin:0 0 6px; font-size:14px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.vh-badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:600; border:1px solid var(--line); }
.vh-badge.vh-verified { color:var(--pass); } .vh-badge.vh-degraded { color:var(--warn); } .vh-badge.vh-blocked { color:var(--fail); }
.cs-acs, .cs-reason { color:var(--muted); font-size:12.5px; margin:2px 0; }
.cs-figs { display:flex; flex-wrap:wrap; gap:12px; }
figure.cs-fig { flex:1 1 280px; margin:8px 0; }
figure.cs-fig .cs-hash { font-family:var(--mono); font-size:11px; color:var(--muted); word-break:break-all; }
.cs-legacy { display:inline-block; padding:0 6px; border-radius:4px; font-size:11px; border:1px solid var(--line); color:var(--muted); }
details.tech { margin:8px 0 2px; border:1px solid var(--line); border-radius:6px; padding:6px 12px; background:color-mix(in srgb, var(--fg) 3%, transparent); }
details.tech summary { cursor:pointer; color:var(--muted); font-size:12.5px; font-weight:600; }
details.tech[open] summary { margin-bottom:6px; }
section.card-context { padding:6px 18px 12px; }
section.card-context .one-liner { font-size:15.5px; font-weight:600; }
section.card-context .ctx-meta { color:var(--muted); font-size:13px; }
dl.delivery { display:grid; grid-template-columns:auto 1fr; gap:2px 12px; margin:8px 0 0; font-size:13.5px; }
dl.delivery dt { color:var(--muted); } dl.delivery dd { margin:0; }
.before-after { margin:10px 0; } .before-after h3 { font-size:14px; margin:0 0 6px; }
.ba-pair { display:flex; flex-wrap:wrap; gap:12px; } .ba-pair figure.shot { flex:1 1 280px; margin:0; }
table.ev-index { width:100%; border-collapse:collapse; font-size:13px; margin-top:8px; }
table.ev-index th, table.ev-index td { border:1px solid var(--line); padding:4px 8px; text-align:left; vertical-align:top; }
table.ev-index th { color:var(--muted); font-weight:600; font-family:var(--serif); letter-spacing:.04em; }
table.ev-index td a { word-break:break-all; }
section.process-trace { margin-top:28px; padding:6px 18px 12px; }
.delivery-mode { font-size:13.5px; color:var(--muted); }
ol.timeline { list-style:none; margin:8px 0; padding:0; font-size:13.5px; }
ol.timeline li { padding:3px 0 3px 10px; border-left:2px solid var(--line); }
ol.timeline li.tl-signal { border-left:3px solid var(--info); font-weight:600; }
ol.timeline li.tl-outline { color:var(--muted); }
ol.timeline .tl-offset { display:inline-block; min-width:58px; color:var(--muted); font-variant-numeric:tabular-nums; font-size:12.5px; font-family:var(--mono); }
.trace-missing { color:var(--warn); font-size:13px; }
details.transcript { margin-top:8px; border:1px solid var(--line); border-radius:6px; padding:6px 12px; background:color-mix(in srgb, var(--fg) 3%, transparent); }
details.transcript summary { cursor:pointer; color:var(--muted); font-size:12.5px; font-weight:600; }
details.transcript .orig-path { font-size:12.5px; color:var(--muted); margin:6px 0; }
section.closing { margin-top:32px; border:none; background:none; border-radius:0; padding:8px 0 0; border-top:3px double var(--line); }
section.execution-cast { margin-top:24px; padding:6px 18px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg-raise); }
section.execution-cast h2 { margin:0 0 4px; font-size:15px; }
.cast-grid { display:grid; grid-template-columns:auto 1fr auto; gap:6px 12px; font-size:13.5px; }
.cast-row { display:contents; }
.cast-row > * { padding:3px 0; }
.cast-role-label { color:var(--muted); font-weight:600; font-size:12.5px; white-space:nowrap; }
.cast-agent { font-size:13px; }
.cast-state { text-align:right; white-space:nowrap; }
.cast-badge { display:inline-block; padding:1px 6px; border-radius:4px; font-size:12px; line-height:1.4; }
.cast-ok { color:var(--pass); } .cast-fail { color:var(--fail); } .cast-warn { color:var(--warn); }
.cast-pending { color:var(--info); } .cast-muted { color:var(--muted); }
.cast-fail-text { color:var(--fail); font-size:12.5px; }
.cast-links { margin:8px 0 0; font-size:12.5px; }
.cast-links a { color:var(--accent); }
section.outward-verification { margin:16px 0 8px; padding:6px 18px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg-raise); }
section.outward-verification h2 { margin:0 0 6px; font-size:15px; }
.ov-banner { font-size:13.5px; font-weight:600; border-radius:6px; padding:6px 12px; margin:6px 0 10px; }
.ov-banner-warn { color:var(--fail); border:1px solid var(--fail); background:color-mix(in srgb, var(--fail) 10%, transparent); }
.ov-banner-ok { color:var(--pass); border:1px solid var(--pass); background:color-mix(in srgb, var(--pass) 10%, transparent); }
table.ov-table { width:100%; border-collapse:collapse; font-size:13px; }
table.ov-table th, table.ov-table td { border:1px solid var(--line); padding:4px 8px; text-align:left; vertical-align:top; }
table.ov-table th { color:var(--muted); font-weight:600; font-family:var(--serif); letter-spacing:.04em; }
.ov-status { font-weight:600; }
.ov-row.ov-verified .ov-status { color:var(--pass); }
.ov-row.ov-simulation .ov-status { color:var(--claim); }
.ov-row.ov-unverified .ov-status { color:var(--fail); }
.ov-row.ov-failed .ov-status { color:var(--fail); }
.ov-meta, .ov-detail { color:var(--muted); font-size:12.5px; margin-top:3px; }
.ov-meta code { word-break:break-all; }
${ANSI_CSS}
</style>
${CHROME_SCRIPT}
</head>
<body>
${CHROME_CONTROLS}
<header class="doc">
<p class="kicker">Roll · ${bi("Acceptance Review Page", "验收 Review Page")}</p>
<h1>${esc(input.title)}</h1>
<p class="meta"><code>${esc(input.storyId)}</code> · ${bi("generated", "生成于")} ${esc(input.generatedAt)} · Gate: PASS</p>
<div class="seal" aria-hidden="true"><span>ROLL</span>验讫</div>
</header>
${cardContextBlock(input.context)}
${executionCastBlock(input.cycleRoleSummary, input.cycleRoleSummaryHref, input.cycleRoleArtifactHrefs)}
<p>${summary}</p>
${outwardVerificationBlock(input.outwardVerification)}
${items.map(acSection).join("\n")}
${beforeAfterBlock(input.beforeAfter, input.afterOnly)}
${selfCaptureBlock(input.selfCaptures)}
${captureSurfacesBlock(input.captureSurfaces)}
${physicalCaptureBlock(input.physicalCaptures)}
${captureSkipBlock(input.captureSkips)}
${processTraceBlock(input.process)}
${closing}
<footer>Roll · ${bi("Acceptance Review Page", "验收 Review Page")} · <code>${esc(input.storyId)}</code></footer>
</body>
</html>
`;
}
