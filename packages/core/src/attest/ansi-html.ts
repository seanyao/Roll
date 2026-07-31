/**
 * @responsibility Converts supported ANSI terminal formatting into safe HTML fragments.
 * US-ATTEST-002 — ANSI→HTML: turn colored CLI output into a SEARCHABLE
 * `<pre class="ansi">` fragment for the acceptance report.
 *
 * CLI/TUI stories don't screenshot (D6): text beats pixels — readable,
 * greppable, diffable. This converter covers the SGR subset real tool output
 * uses (vitest, npm, git, bats): named fg/bg colors incl. bright, bold/dim/
 * italic/underline, and reset. Anything fancier (256-color `38;5;n`,
 * truecolor `38;2;r;g;b`, cursor movement) is consumed and DROPPED — the text
 * always survives, unstyled rather than garbled.
 *
 * Output uses classes (`a-fg31`, `a-bold`) + an exported CSS block so the
 * single-file report stays CSP-friendly (no inline styles); `ANSI_CSS` ships
 * both dark/light values via prefers-color-scheme.
 */

/** Map one SGR parameter to a css class (null = no class / handled elsewhere). */
function sgrClass(code: number): string | null {
  if (code === 1) return "a-bold";
  if (code === 2) return "a-dim";
  if (code === 3) return "a-italic";
  if (code === 4) return "a-underline";
  if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) return `a-fg${code}`;
  if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) return `a-bg${code}`;
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m|\x1b\][^\x07]*\x07|\x1b[^[\]]/g;

/**
 * Convert ANSI text to an HTML fragment (span-wrapped runs, no outer <pre>).
 * `\r`-overwritten progress segments keep only the final paint per line.
 */
export function ansiToHtml(text: string): string {
  // Progress-line collapse: within each \n-line, keep the last \r segment.
  const collapsed = text
    .split("\n")
    .map((l) => {
      const segs = l.split("\r");
      return segs[segs.length - 1] ?? "";
    })
    .join("\n");

  let html = "";
  let open: string[] = [];
  let last = 0;
  const flush = (upTo: number): void => {
    if (upTo > last) {
      const chunk = escapeHtml(collapsed.slice(last, upTo));
      html += open.length > 0 ? `<span class="${open.join(" ")}">${chunk}</span>` : chunk;
    }
  };
  for (const m of collapsed.matchAll(ANSI_RE)) {
    flush(m.index ?? 0);
    last = (m.index ?? 0) + m[0].length;
    const params = m[1];
    if (params === undefined) continue; // OSC / lone escape: dropped
    const codes = params === "" ? [0] : params.split(";").map((n) => Number(n));
    let i = 0;
    while (i < codes.length) {
      const c = codes[i] ?? 0;
      if (c === 0) {
        open = [];
      } else if (c === 38 || c === 48) {
        // extended color: consume its arguments, render unstyled.
        const mode = codes[i + 1];
        i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
      } else {
        const cls = sgrClass(c);
        if (cls !== null && !open.includes(cls)) open = [...open, cls];
      }
      i += 1;
    }
  }
  flush(collapsed.length);
  return html;
}

/** The full embeddable fragment: `<pre class="ansi">…</pre>`. */
export function ansiPre(text: string): string {
  return `<pre class="ansi">${ansiToHtml(text)}</pre>`;
}

/** Dark/light CSS for the classes `ansiToHtml` emits — inline into report.html. */
export const ANSI_CSS = `
.ansi { background: #11151c; color: #d8dee9; padding: 12px 14px; border-radius: 8px;
  overflow-x: auto; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.ansi .a-bold { font-weight: 700; } .ansi .a-dim { opacity: .6; }
.ansi .a-italic { font-style: italic; } .ansi .a-underline { text-decoration: underline; }
.ansi .a-fg30 { color: #3b4252; } .ansi .a-fg31 { color: #e06c75; }
.ansi .a-fg32 { color: #98c379; } .ansi .a-fg33 { color: #e5c07b; }
.ansi .a-fg34 { color: #61afef; } .ansi .a-fg35 { color: #c678dd; }
.ansi .a-fg36 { color: #56b6c2; } .ansi .a-fg37 { color: #d8dee9; }
.ansi .a-fg90 { color: #6b7280; } .ansi .a-fg91 { color: #ef8790; }
.ansi .a-fg92 { color: #b5e8a0; } .ansi .a-fg93 { color: #f0d197; }
.ansi .a-fg94 { color: #8cc6ff; } .ansi .a-fg95 { color: #d9a0e8; }
.ansi .a-fg96 { color: #7fd6e0; } .ansi .a-fg97 { color: #ffffff; }
@media (prefers-color-scheme: light) {
  .ansi { background: #f6f8fa; color: #24292f; }
  .ansi .a-fg37 { color: #24292f; } .ansi .a-fg97 { color: #57606a; }
}
`.trim();
