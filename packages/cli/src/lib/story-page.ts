/**
 * Shared story-card page generator (US-META-005/006/007).
 *
 * One source of truth for the per-story `spec.md` + `index.html` skeleton and
 * for the phase-section markup contract: `roll idea` and `roll migrate-features`
 * emit the skeleton through here, and `roll attest` flips a phase section to
 * done through `markPhaseDone` — so the emitters and the updater can never
 * drift apart (previously two hand-rolled skeletons disagreed on the section
 * markup and attest's update regex silently matched only one of them).
 *
 * Pages wear the shared「交付档案 · Delivery Dossier」chrome from @roll/core:
 * bilingual copy with an EN/中 toggle and a light/dark toggle, single
 * self-contained file. Phase sections are addressed by `data-phase` keys, not
 * by heading text — headings are bilingual and free to change.
 */
import { CHROME_CONTROLS, CHROME_CSS, CHROME_SCRIPT, bi } from "@roll/core";

/** Story-ID families the archive layout recognizes (`<FAMILY>-<n>` dirs). */
export const STORY_ID_RE = /^(FIX|US|IDEA|REFACTOR)-/;

/** `FIX-216` → `FIX`; null when the id is not in a known family. */
export function storyFamilyOf(storyId: string): string | null {
  const m = STORY_ID_RE.exec(storyId);
  return m === null ? null : (m[1] as string);
}

export interface StoryCardMeta {
  id: string;
  /** One-line human title; omitted for backfilled cards that only have an id. */
  title?: string;
  /** YYYY-MM-DD. */
  created: string;
  /** spec.md frontmatter `type:`; derived from the id family when omitted. */
  type?: string;
  /** spec.md frontmatter `epic:` (backfill records placement; live cards omit it). */
  epic?: string;
  /** Extra blockquote line under the spec.md heading (e.g. backfill provenance). */
  note?: string;
  /** US-CYCLE-005 — estimated builder minutes (granularity contract; ≤25). */
  estMin?: number;
  /** US-CYCLE-005 — risk tier (low|high; drives US-CYCLE-008 evaluation depth). */
  riskTier?: "low" | "high";
}

/** Lifecycle phases every story page carries, addressed by stable key. */
export const STORY_PHASES = [
  { key: "design", en: "Design", zh: "设计", emptyEn: "Not yet started", emptyZh: "尚未开始" },
  { key: "execution", en: "Execution", zh: "执行", emptyEn: "No cycles yet", emptyZh: "暂无周期" },
  { key: "delivery", en: "Delivery", zh: "交付", emptyEn: "Not yet delivered", emptyZh: "尚未交付" },
  { key: "retrospective", en: "Retrospective", zh: "复盘", emptyEn: "Not yet written", emptyZh: "尚未撰写" },
] as const;

/** Render the `spec.md` definition file for a story card. */
export function renderSpecMd(meta: StoryCardMeta): string {
  const type = meta.type ?? storyFamilyOf(meta.id)?.toLowerCase() ?? "unknown";
  return (
    `---\n` +
    `id: ${meta.id}\n` +
    (meta.title !== undefined ? `title: ${meta.title}\n` : "") +
    `type: ${type}\n` +
    (meta.epic !== undefined ? `epic: ${meta.epic}\n` : "") +
    (meta.estMin !== undefined ? `est_min: ${meta.estMin}\n` : "") +
    (meta.riskTier !== undefined ? `risk_tier: ${meta.riskTier}\n` : "") +
    `created: ${meta.created}\n` +
    `---\n\n` +
    `# ${meta.id}${meta.title !== undefined ? ` — ${meta.title}` : ""}\n` +
    (meta.note !== undefined ? `\n> ${meta.note}\n` : "") +
    // US-CYCLE-005 — seed the Evaluation-contract skeleton so a new-regime card
    // (one minted with est_min/risk_tier) starts with the granularity contract
    // visible for the designer to fill (≤3 evidence, ≤6 AC).
    (meta.estMin !== undefined
      ? `\n## Evaluation contract\n\n**Expected evidence:**\n- \`test\` — \n\n**Scorer focus:** \n`
      : "")
  );
}

/**
 * The shared phase-section opening tag — the single anchor contract used by BOTH
 * the skeleton generator (renderStoryPage) and the full dossier renderer
 * (story-dossier.ts), so a section is always addressable by its `data-phase` key
 * regardless of which path wrote the page (US-DOSSIER-007). `markPhaseDone` keys
 * off this exact shape; keep the three in lockstep.
 */
export function phaseSectionTag(phaseKey: string, done: boolean): string {
  return `<section class="phase phase-${done ? "done" : "pending"}" data-phase="${phaseKey}">`;
}

/** Render the `index.html` skeleton for a story card (all phases pending). */
export function renderStoryPage(meta: StoryCardMeta): string {
  const q = (s: string): string => s.replace(/"/g, "&quot;");
  const badge = storyFamilyOf(meta.id) ?? meta.id.split("-")[0];
  const sections = STORY_PHASES.map(
    (p) =>
      `${phaseSectionTag(p.key, false)}<h2>${bi(p.en, p.zh)}</h2><p class="empty">${bi(p.emptyEn, p.emptyZh)}</p></section>`,
  ).join("\n");
  return (
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${meta.title !== undefined ? `${meta.id} — ${q(meta.title)}` : meta.id}</title>\n` +
    `<style>\n${CHROME_CSS}` +
    `.phase-done { border-left:4px solid var(--pass); } .phase-pending { border-left:4px solid var(--line); }\n` +
    `</style>\n${CHROME_SCRIPT}\n` +
    `</head>\n<body>\n${CHROME_CONTROLS}\n` +
    `<p class="kicker">Roll · ${bi("Story Dossier", "故事档案")}</p>\n` +
    `<h1>${meta.id}</h1>\n` +
    `<p class="meta"><code>${badge}</code> · ${bi("Created", "创建于")} ${meta.created}</p>\n` +
    (meta.title !== undefined ? `<p>${q(meta.title)}</p>\n` : "") +
    `${sections}\n` +
    `<footer>Roll · <a href="spec.md">spec.md</a></footer>\n</body>\n</html>\n`
  );
}

/**
 * Flip a phase section from pending to done, replacing its body. Sections are
 * matched by `data-phase` key (markup-stable), and the bilingual heading is
 * regenerated from STORY_PHASES. Returns the html unchanged when the section
 * is absent (legacy / hand-edited pages) or the key is unknown.
 */
export function markPhaseDone(html: string, phaseKey: string, innerHtml: string): string {
  const p = STORY_PHASES.find((x) => x.key === phaseKey);
  if (p === undefined) return html;
  // Match the section in EITHER state so re-mounting an already-done section is
  // idempotent (US-DOSSIER-007) — the mount is the live update primitive, not a
  // one-shot pending→done flip.
  return html.replace(
    new RegExp(`<section class="phase phase-(?:pending|done)" data-phase="${p.key}">[\\s\\S]*?</section>`),
    `${phaseSectionTag(p.key, true)}<h2>${bi(p.en, p.zh)}</h2>${innerHtml}</section>`,
  );
}
