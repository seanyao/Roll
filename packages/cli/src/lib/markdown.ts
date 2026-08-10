/**
 * @responsibility Renders a minimal markdown to HTML.
 */
/**
 * Minimal markdown → HTML renderer.
 *
 * A tiny, dependency-free renderer (headings / paragraphs / unordered lists +
 * inline code/links/bold/italic) — enough to render a card's `spec.md` into the
 * dossier's `spec.html` (the "Design doc" link). No external markdown library by
 * design; the dossier wants a stable, auditable, self-contained transform.
 */

/** HTML-escape the five sensitive characters (attribute-safe). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Inline spans: `code`, [text](url), **bold**, *italic*. */
function inlineMd(text: string): string {
  let t = text.replace(/`([^`]+)`/g, (_m, g1: string) => "<code>" + escapeHtml(g1) + "</code>");
  t = t.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, g1: string, g2: string) => `<a href="${escapeHtml(g2)}">${g1}</a>`,
  );
  t = t.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return t;
}

function minimalMarkdown(src: string): string {
  const lines = src.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out: string[] = [];
  let inList = false;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length) {
      const text = para
        .map((p) => p.trim())
        .filter((p) => p)
        .join(" ");
      if (text) out.push("<p>" + inlineMd(text) + "</p>");
      para = [];
    }
  };
  const flushList = (): void => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const level = h[1]!.length;
      out.push(`<h${level}>${inlineMd(h[2]!)}</h${level}>`);
      continue;
    }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) {
      flushPara();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMd(b[1]!)}</li>`);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("\n");
}

/** Render a markdown source string to a minimal HTML fragment. */
export function renderMarkdown(src: string): string {
  return minimalMarkdown(src);
}
