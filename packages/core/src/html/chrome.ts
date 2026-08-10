/**
 * @responsibility Renders the shared page chrome for every generated dossier page.
 * Shared page chrome for every generated meta page (features index → story
 * card → acceptance report) — the「交付档案 · Delivery Dossier」visual language.
 *
 * US-DOSSIER-039 — ONE design across the whole dossier. The chrome is the COOL
 * design system the truth console (`truth-console.ts` C / SHELL_CSS) already
 * uses: a cool canvas `#eef1f5`, indigo accent `#2d54e8`, truth-green `#178a52`,
 * attest-pending teal `#0d9488`, drift red `#d23b3b`, and IBM Plex Sans / IBM
 * Plex Sans SC / IBM Plex Mono throughout. The cool tokens are exported
 * (`COOL_VARS`) so the console can reference the SAME source — no second
 * palette, no drift. Every page is still ONE self-contained file (inline CSS +
 * one inline script; IBM Plex pulled from Google Fonts with a system fallback,
 * offline-openable, print-to-PDF clean).
 *
 * Two standard controls (fixed top-right, hidden in print):
 *  - language: full locale resources are embedded as `.lang-en` / `.lang-zh`
 *    spans; CSS shows one side before JavaScript runs. The script then follows
 *    the browser locale, and an explicit choice persists in localStorage
 *    (`roll-lang`).
 *  - theme: light/dark via `html[data-theme]` overriding prefers-color-scheme;
 *    persists in localStorage (`roll-theme`). The reference is light-first; the
 *    dark variant is a cool deep-slate (never the old warm ink).
 *
 * No-JS degrade: without the script the English side renders and the Chinese
 * resource side stays hidden; the theme follows the OS.
 */

/** A bilingual copy pair — exactly one side is visible once chrome JS runs. */
export function bi(en: string, zh: string): string {
  return `<span class="lang-en">${en}</span><span class="lang-zh">${zh}</span>`;
}

/**
 * US-DOSSIER-039 — the cool design tokens, the SINGLE source the whole dossier
 * (chrome pages + the console) reads. Values are the console's own palette
 * (`truth-console.ts` C): canvas `#eef1f5`, card `#fff`, ink `#161b26`, sub
 * `#525c6e`, line `#e0e5ee`, indigo `#2d54e8`, truth-green `#178a52`,
 * attest-pending teal `#0d9488`, drift red `#d23b3b`, claim amber `#c77d12`,
 * purple `#7048bc`; type is IBM Plex Sans/SC + IBM Plex Mono. `--serif` is
 * mapped to the SAME IBM Plex Sans stack (the cool system carries no serif), so
 * every component still resolving `var(--serif)` lands on IBM Plex, not Iowan.
 */
export const COOL_VARS =
  `--bg:#eef1f5; --bg-raise:#fff; --fg:#161b26; --muted:#525c6e; --line:#e0e5ee; --accent:#2d54e8;` +
  ` --grain:transparent;` +
  ` --pass:#178a52; --info:#2d54e8; --warn:#c77d12; --claim:#c77d12; --fail:#d23b3b; --block:#7048bc;` +
  ` --teal:#0d9488;` +
  ` --serif:"IBM Plex Sans","IBM Plex Sans SC",-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;` +
  ` --sans:"IBM Plex Sans","IBM Plex Sans SC",-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;` +
  ` --mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;`;

/** Cool dark variant — a deep slate keyed to the cool palette (NOT warm ink),
 *  so the light/dark toggle stays consistent with the one design system. */
const DARK_VARS =
  `--bg:#10141d; --bg-raise:#181d29; --fg:#e6ebf4; --muted:#9aa3b2; --line:#2a3140; --accent:#5b82ff;` +
  ` --grain:transparent;` +
  ` --pass:#3ec07e; --info:#5b82ff; --warn:#e0a23c; --claim:#e0a23c; --fail:#ef5b4a; --block:#9b76e0;` +
  ` --teal:#2bb8a8;`;

/**
 * US-DOSSIER-039 — the IBM Plex font links (preconnect + Google Fonts), the ONE
 * source for the console's web fonts (`truth-console.ts` re-exports this). The
 * self-contained meta pages (index / epic / story dossier / report / morning)
 * deliberately carry NO external `<link>` (an offline-openable single-file red
 * line the tests enforce); they get IBM Plex via the `COOL_VARS` font STACK,
 * which prefers IBM Plex when installed and otherwise falls back to a cool
 * system sans — so the cool palette is identical and the type matches whenever
 * IBM Plex is present, with no contract break.
 */
export const FONT_LINKS =
  `<link rel="preconnect" href="https://fonts.googleapis.com">\n` +
  `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n` +
  `<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+SC:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">\n`;

/**
 * Base stylesheet: the cool theme variables, IBM Plex typography, ledger layout
 * primitives shared by all meta pages, the chrome bar, language switching and
 * print rules. Page-specific styles append after this.
 */
export const CHROME_CSS = `
:root { color-scheme: light; ${COOL_VARS} }
:root[data-theme="dark"] { color-scheme: dark; ${DARK_VARS} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; ${DARK_VARS} } }
html { background:var(--bg); }
body { margin:0 auto; max-width:880px; padding:30px 20px 80px; background:var(--bg); color:var(--fg);
  font:15px/1.7 var(--sans); -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
::selection { background:rgba(45,84,232,.16); }
.kicker { font:600 11.5px/1 var(--mono); letter-spacing:.22em; text-transform:uppercase; color:var(--accent);
  padding-top:10px; margin:0 0 10px; }
h1 { font:600 26px/1.3 var(--sans); margin:0 0 4px; letter-spacing:-.01em; }
h2 { font:600 17px/1.4 var(--sans); border-bottom:1px solid var(--line); padding-bottom:6px; letter-spacing:0; }
code { font-family:var(--mono); background:color-mix(in srgb, var(--accent) 7%, transparent); padding:1px 6px; border-radius:4px; font-size:.9em; }
pre { background:color-mix(in srgb, var(--fg) 4%, transparent); padding:12px; border-radius:6px; overflow-x:auto; }
a { color:var(--accent); text-decoration-color:color-mix(in srgb, var(--accent) 40%, transparent); }
section { border:1px solid var(--line); border-radius:8px; padding:14px 18px; margin:14px 0;
  background:var(--bg-raise); position:relative; z-index:2; }
.empty { color:var(--muted); font-style:italic; }
.meta, .muted { color:var(--muted); font-size:13px; }
footer { color:var(--muted); font-size:12.5px; font-family:var(--mono); letter-spacing:.04em;
  margin-top:40px; border-top:1px solid var(--line); padding-top:12px; }
/* language switching — no-JS/default renders exactly one language */
html:not([data-lang]) .lang-zh { display:none; }
[data-lang="en"] .lang-zh { display:none; } [data-lang="zh"] .lang-en { display:none; }
/* chrome bar */
.chrome { position:fixed; top:14px; right:14px; z-index:10; display:flex; gap:8px; font-family:var(--mono); }
.chrome .seg { display:flex; border:1px solid var(--line); border-radius:999px; overflow:hidden;
  background:color-mix(in srgb, var(--bg-raise) 82%, transparent); backdrop-filter:blur(6px); }
.chrome button { all:unset; cursor:pointer; font-size:12px; line-height:1; padding:7px 11px; color:var(--muted); }
.chrome button.on { background:var(--accent); color:#fff; }
.chrome button:not(.on):hover { color:var(--fg); }
@media print { body { max-width:none; padding:0; }  .chrome { display:none; }
  section { break-inside:avoid; background:none; } }
`;

/** The fixed top-right control bar: [EN|中] + [☀|☾]. */
export const CHROME_CONTROLS = `<nav class="chrome" aria-label="page controls">
<div class="seg" role="group" aria-label="language"><button type="button" data-set-lang="en">EN</button><button type="button" data-set-lang="zh">中</button></div>
<div class="seg" role="group" aria-label="theme"><button type="button" data-set-theme="light" aria-label="light">☀</button><button type="button" data-set-theme="dark" aria-label="dark">☾</button></div>
</nav>`;

/**
 * The ONLY script on a meta page. Inline (self-contained, offline) — pages
 * still carry no external scripts, no fetches, no third-party code.
 */
export const CHROME_SCRIPT = `<script>
(function () {
  var d = document.documentElement;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var lang = get("roll-lang") || ((navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en");
  var theme = get("roll-theme") || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  function apply() {
    d.setAttribute("data-lang", lang);
    d.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
    d.setAttribute("data-theme", theme);
    var bs = document.querySelectorAll("[data-set-lang],[data-set-theme]");
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var on = b.getAttribute("data-set-lang") === lang || b.getAttribute("data-set-theme") === theme;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }
  apply();
  document.addEventListener("DOMContentLoaded", function () {
    var bs = document.querySelectorAll("[data-set-lang],[data-set-theme]");
    for (var i = 0; i < bs.length; i++) {
      bs[i].addEventListener("click", function () {
        var l = this.getAttribute("data-set-lang");
        var t = this.getAttribute("data-set-theme");
        if (l) { lang = l; set("roll-lang", l); }
        if (t) { theme = t; set("roll-theme", t); }
        apply();
      });
    }
    apply();
  });
})();
</script>`;
