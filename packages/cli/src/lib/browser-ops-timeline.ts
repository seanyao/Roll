/**
 * @responsibility Builds the compact read-only browser-operations timeline for the dossier.
 */
/**
 * US-BROW-013 — compact read-only browser-operations timeline for the dossier.
 *
 * Projection comes from {@link browserOperationsTimeline}; this module only
 * formats HTML. Artifact/evidence links are emitted only when the viewer is
 * authorized under existing dossier rules (an explicit href map), never from
 * raw ids alone.
 */
import { bi } from "@roll/core";
import type { BrowserOperationsTimeline, BrowserTimelineRow } from "@roll/spec";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Existing dossier link authorization: only mapped hrefs may become anchors. */
export interface BrowserTimelineLinkAuth {
  /** Local dossier generation is authorized; shared/untrusted exports pass false. */
  viewerAuthorized: boolean;
  /** Maps timeline artifact ids (diagnostic id or screenshot path) → relative href. */
  artifactHrefs?: Readonly<Record<string, string>>;
}

function authorizedHref(auth: BrowserTimelineLinkAuth, artifactId: string | undefined): string | undefined {
  if (!auth.viewerAuthorized || artifactId === undefined || artifactId === "") return undefined;
  const href = auth.artifactHrefs?.[artifactId];
  if (href === undefined || href === "") return undefined;
  return href;
}

function rowHtml(row: BrowserTimelineRow, auth: BrowserTimelineLinkAuth): string {
  const stamp = row.ts === undefined || row.ts === ""
    ? `<span class="bot-absent">${esc(row.presence)}</span>`
    : `<time datetime="${esc(row.ts)}">${esc(row.ts)}</time>`;
  const detail = row.detail === undefined || row.detail === "" ? "" : ` — ${esc(row.detail)}`;
  let link = "";
  if (row.artifact !== undefined) {
    const href = authorizedHref(auth, row.artifact.id);
    if (href !== undefined) {
      link = ` · <a class="bot-artifact" href="${esc(href)}" rel="noopener">${esc(row.artifact.label)}</a>`;
    } else {
      link = ` · <span class="bot-artifact-locked" title="viewer not authorized">${esc(row.artifact.label)}</span>`;
    }
  }
  return (
    `<li class="bot-row bot-${esc(row.presence)}" data-kind="${esc(row.kind)}">` +
    `${stamp} <strong>${esc(row.label)}</strong>${detail}${link}` +
    `</li>`
  );
}

/**
 * Render the compact browser-operations timeline block.
 * Returns empty string when no present facts exist so story reports stay
 * stable for cards without browser operations.
 */
export function renderBrowserOperationsTimelineHtml(
  timeline: BrowserOperationsTimeline | undefined,
  auth: BrowserTimelineLinkAuth = { viewerAuthorized: true },
): string {
  if (timeline === undefined || !timeline.hasFacts) return "";

  const present = timeline.rows.map((row) => rowHtml(row, auth)).join("");
  const absences = timeline.absences.map((row) => rowHtml(row, auth)).join("");
  const absenceBlock =
    absences === ""
      ? ""
      : `<p class="bot-absences-label">${bi("Absent facts", "缺失事实")}</p><ul class="bot-absences">${absences}</ul>`;

  return (
    `<details id="browser-operations" class="browser-ops-timeline" open>` +
    `<summary>${bi("Browser operations timeline", "浏览器操作时间线")}</summary>` +
    `<ol class="bot-timeline">${present}</ol>` +
    absenceBlock +
    `</details>`
  );
}
