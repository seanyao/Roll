/**
 * @responsibility Defines the Delivery Dossier design system layered on the shared chrome CSS.
 */
/**
 * US-DOSSIER-001a — the Delivery Dossier design system, layered ON TOP of
 * CHROME_CSS (which owns the palette, type stack, chrome bar and print rules).
 *
 * Token ruling (US-DOSSIER-039: the cool design system): every dossier
 * component reuses the chrome variables, which now carry the console's cool
 * palette — `--accent` is indigo `#2d54e8`, `--pass` truth-green `#178a52`,
 * type is IBM Plex. "Zero new colors/fonts" is taken literally: no new hex
 * values appear in this file, so flipping CHROME_CSS to cool turns every
 * component cool for free.
 *
 * Components (shared by index / epic / story pages):
 *   masthead+lede · ledger (4 figures) · wish→truth bar · lifecycle spine
 *   (.spine / .mini-spine) · toolbar (search + only-shipping) · epic cards +
 *   progress bar + id chips · status pills · wish-quote · attest banner ·
 *   AC table. Responsive at 680px; print stays chrome-free (CHROME_CSS rule).
 */

/** Dossier component stylesheet — append AFTER `CHROME_CSS` in every page. */
export const DOSSIER_CSS = `
/* ── masthead ── */
.lede { font:16.5px/1.75 var(--serif); color:var(--fg); max-width:640px; margin:6px 0 18px; }
.lede em { font-style:italic; color:var(--accent); }
.masthead .crumb { font:12px/1 var(--mono); color:var(--muted); margin:0 0 14px; }
.masthead .crumb a { color:var(--muted); }
.kv { display:flex; gap:18px; flex-wrap:wrap; font-size:12.5px; color:var(--muted); margin:8px 0 0; }
.kv b { color:var(--fg); font-weight:600; }

/* ── ledger: four figures + wish→truth bar ── */
.ledger { border:1px solid var(--line); border-radius:8px; background:var(--bg-raise);
  padding:16px 18px; margin:18px 0; position:relative; z-index:2; }
.figures { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; }
.figure .num { font:600 30px/1.1 var(--serif); letter-spacing:.01em; }
.figure .num.truth { color:var(--pass); }
.figure .lbl { font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.wt-bar { margin-top:14px; height:10px; border:1px solid var(--line); border-radius:999px; overflow:hidden;
  background:repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, var(--muted) 28%, transparent) 4px 5px); }
.wt-bar .truth { display:block; height:100%; background:var(--pass); border-radius:999px 0 0 999px; }
.wt-legend { display:flex; justify-content:space-between; font-size:11.5px; color:var(--muted); margin-top:5px; }

/* ── lifecycle spine (full) + mini-spine (rows) ── */
.spine { display:flex; align-items:center; margin:18px 0; position:relative; z-index:2; }
.spine .node { display:flex; flex-direction:column; align-items:center; gap:6px; flex:0 0 auto; text-align:center; }
.spine .dot { width:13px; height:13px; border-radius:50%; border:2px solid var(--line); background:var(--bg-raise); box-sizing:border-box; }
.spine .node.done .dot { border-color:var(--accent); background:var(--accent); }
.spine .node.truth .dot { border-color:var(--pass); background:var(--pass); }
.spine .node .tag { font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); white-space:nowrap; }
.spine .node.done .tag, .spine .node.truth .tag { color:var(--fg); }
.spine .seg { flex:1 1 0; height:2px; background:var(--line); margin:0 6px 18px; }
.spine .seg.done { background:var(--accent); }
.spine.legacy .node .dot { border-style:dashed; border-color:color-mix(in srgb,var(--muted) 55%,transparent); background:transparent; }
.spine.legacy .seg { background:color-mix(in srgb,var(--muted) 30%,transparent); }
.legacy-banner { margin:14px 0; padding:10px 14px; border:1px dashed var(--line); border-radius:8px; background:color-mix(in srgb,var(--muted) 7%,transparent); color:var(--muted); font-size:13px; line-height:1.5; }
.mini-spine { display:inline-flex; align-items:center; vertical-align:middle; }
.mini-spine i { width:7px; height:7px; border-radius:50%; background:none; border:1.5px solid var(--line); box-sizing:border-box; }
.mini-spine i.done { border-color:var(--accent); background:var(--accent); }
.mini-spine i.truth { border-color:var(--pass); background:var(--pass); }
.mini-spine s { width:8px; height:1.5px; background:var(--line); text-decoration:none; }
.mini-spine s.done { background:var(--accent); }

/* ── toolbar: search + only-shipping ── */
.toolbar { display:flex; gap:10px; align-items:center; margin:18px 0 8px; position:relative; z-index:2; }
.toolbar input[type="search"] { flex:1 1 auto; font:13.5px/1 var(--sans); color:var(--fg);
  background:var(--bg-raise); border:1px solid var(--line); border-radius:999px; padding:8px 14px; outline:none; }
.toolbar input[type="search"]:focus { border-color:var(--accent); }
.toolbar label.only { display:flex; gap:6px; align-items:center; font-size:12.5px; color:var(--muted);
  cursor:pointer; white-space:nowrap; }
[data-filtered="1"] .filtered-out { display:none; }

/* ── epic table + chips ── */
.epic-table { width:100%; border-collapse:collapse; position:relative; z-index:2; margin:0 0 8px;
  background:var(--bg-raise); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.epic-table thead th { font:600 11px/1 var(--mono); text-transform:uppercase; letter-spacing:.06em;
  color:var(--muted); text-align:left; padding:9px 14px; border-bottom:1px solid var(--line); background:transparent; }
.epic-table tbody tr { border-top:1px solid var(--line); }
.epic-table tbody tr:first-child { border-top:none; }
.epic-table td, .epic-table th[scope="row"] { padding:11px 14px; vertical-align:top; }
.epic-name { font:600 14.5px/1.3 var(--serif); text-align:left; white-space:nowrap; }
.epic-name a { color:var(--fg); text-decoration:none; }
.epic-name a:hover { color:var(--accent); }
.epic-progress { width:200px; }
.epic-progress .stat { font-size:12px; color:var(--muted); }
.epic-bar { height:7px; border:1px solid var(--line); border-radius:999px; overflow:hidden; margin:6px 0 0;
  background:repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, var(--muted) 28%, transparent) 4px 5px); }
.epic-bar .truth { display:block; height:100%; background:var(--pass); }
.chips { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }
.chip { font:11px/1 var(--mono); border:1px solid var(--line); border-radius:5px; padding:4px 7px;
  color:var(--muted); text-decoration:none; }
.chip:hover { border-color:var(--accent); color:var(--accent); }
.chip.truth { border-color:color-mix(in srgb, var(--pass) 55%, transparent); color:var(--pass); }
/* backlog-aligned status (US-DOSSIER): in-progress → warn, hold → block. */
.chip.wip { border-color:color-mix(in srgb, var(--warn) 55%, transparent); color:var(--warn); }
.chip.hold { border-color:color-mix(in srgb, var(--block) 50%, transparent); color:var(--block); }

/* ── type chips + status pills ── */
.type { font:10.5px/1 var(--mono); letter-spacing:.05em; border-radius:4px; padding:3px 6px; }
.type-US { color:var(--info); border:1px solid color-mix(in srgb, var(--info) 45%, transparent); }
.type-FIX { color:var(--claim); border:1px solid color-mix(in srgb, var(--claim) 45%, transparent); }
.type-REFACTOR { color:var(--block); border:1px solid color-mix(in srgb, var(--block) 45%, transparent); }
.type-IDEA { color:var(--warn); border:1px solid color-mix(in srgb, var(--warn) 45%, transparent); }
.pill { font-size:11px; line-height:1; border-radius:999px; padding:4px 9px; white-space:nowrap; }
.pill.merged { color:var(--pass); border:1px solid color-mix(in srgb, var(--pass) 50%, transparent); }
.pill.cycle { color:var(--warn); border:1px solid color-mix(in srgb, var(--warn) 50%, transparent); }
.pill.backlog { color:var(--muted); border:1px solid var(--line); }

/* ── story rows (epic page) ── */
.story-rows { position:relative; z-index:2; }
.story-row { display:flex; gap:10px; align-items:center; padding:9px 6px; border-bottom:1px solid var(--line);
  text-decoration:none; color:var(--fg); }
.story-row:hover { background:var(--bg-raise); }
.story-row .id { font:12.5px/1 var(--mono); min-width:130px; }
.story-row .title { flex:1 1 auto; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* ── story dossier blocks ── */
.wish-quote { border-left:3px solid var(--accent); padding:6px 14px; margin:10px 0;
  font:15.5px/1.75 var(--serif); font-style:italic; }
.attest-banner { display:flex; gap:12px; align-items:center; border:1px solid color-mix(in srgb, var(--pass) 45%, transparent);
  border-radius:8px; padding:10px 14px; margin:10px 0; }
.attest-banner .mark { font-size:18px; color:var(--pass); }
.ac-table { width:100%; border-collapse:collapse; font-size:13px; }
.ac-table th, .ac-table td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
.ac-table th { font-family:var(--serif); color:var(--muted); letter-spacing:.04em; }

/* ── responsive ── */
@media (max-width:680px) {
  .figures { grid-template-columns:repeat(2, 1fr); }
  .epic-grid { grid-template-columns:1fr; }
  .story-row .id { min-width:0; }
  .story-row .title { white-space:normal; }
}

/* ── truth board (US-TRUTH-011): aggregate strip + Story/Cycle/Release tiles ── */
.truth-board{margin:26px 0 18px;}
.truth-strip{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--bg-raise);font:600 11px/1.2 var(--mono);color:var(--muted);}
.truth-strip strong{font:700 13px/1 var(--mono);text-transform:uppercase;color:var(--fg);}
.truth-label{letter-spacing:.12em;text-transform:uppercase;color:var(--accent);}
.truth-strip.pass{border-color:color-mix(in srgb,var(--pass) 42%,var(--line));}
.truth-strip.pass strong{color:var(--pass);}
.truth-strip.warn{border-color:color-mix(in srgb,var(--warn) 50%,var(--line));}
.truth-strip.warn strong{color:var(--warn);}
.truth-strip.fail{border-color:color-mix(in srgb,var(--fail) 50%,var(--line));}
.truth-strip.fail strong{color:var(--fail);}
.truth-strip.unknown{border-style:dashed;}
.truth-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px;}
.truth-tile{border:1px solid var(--line);border-radius:8px;background:var(--bg-raise);padding:13px 14px;min-height:112px;}
.truth-tile h2{margin:0 0 10px;font:700 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);}
.truth-metric{display:flex;align-items:baseline;gap:9px;margin-bottom:12px;}
.truth-metric b{font:700 28px/1 var(--serif);color:var(--fg);font-variant-numeric:tabular-nums;}
.truth-metric span{font:600 10px/1.2 var(--mono);text-transform:uppercase;color:var(--muted);}
.truth-tile dl{display:grid;grid-template-columns:1fr auto;gap:6px 10px;margin:0;font:11px/1.15 var(--mono);}
.truth-tile dt{color:var(--muted);}
.truth-tile dd{margin:0;color:var(--fg);font-weight:700;}
.truth-tile.story .truth-metric b{color:var(--pass);}
.truth-tile.release.fail dd,.truth-tile.release.fail .truth-metric b{color:var(--fail);}
.truth-tile.release.warn dd,.truth-tile.release.warn .truth-metric b{color:var(--warn);}

/* ── delivery board (US-DOSSIER): status overview + spectrum ── */
.statusboard{display:grid;grid-template-columns:repeat(6,1fr);border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--bg-raise);margin:28px 0 14px;}
.tally{padding:16px 18px 14px;border-right:1px solid var(--line);position:relative;text-decoration:none;color:inherit;transition:background .15s;}
.tally:last-child{border-right:none;}
.tally:hover{background:color-mix(in srgb,var(--accent) 6%,transparent);}
.tally .mark{font:13px/1 var(--mono);color:var(--muted);}
.tally .num{font:600 34px/1 var(--serif);letter-spacing:-.02em;margin:7px 0 2px;font-variant-numeric:tabular-nums;}
.tally .lbl{font:600 10.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);}
.tally .tsub{font:500 9.5px/1.2 var(--mono);color:var(--muted);margin-top:4px;opacity:.85;}
.tally.done .num{color:var(--pass);} .tally.fail .num{color:var(--fail);} .tally.unknown .num{color:var(--muted);} .tally.wip .num{color:var(--warn);} .tally.todo .num{color:var(--fg);} .tally.hold .num{color:var(--block);}
.tally .accentbar{position:absolute;left:0;bottom:0;height:3px;width:100%;}
.tally.done .accentbar{background:var(--pass);} .tally.fail .accentbar{background:var(--fail);} .tally.unknown .accentbar{background:var(--muted);} .tally.wip .accentbar{background:var(--warn);} .tally.todo .accentbar{background:var(--muted);} .tally.hold .accentbar{background:var(--block);}
.spectrum{display:flex;height:14px;border-radius:999px;overflow:hidden;border:1px solid var(--line);background:var(--bg-raise);}
.spectrum span,.epic-mini span{display:block;height:100%;}
.s-done{background:var(--pass);} .s-fail{background:var(--fail);} .s-unknown{background:color-mix(in srgb,var(--muted) 50%,transparent);} .s-wip{background:var(--warn);} .s-hold{background:var(--block);}
.s-todo{background:repeating-linear-gradient(45deg,color-mix(in srgb,var(--muted) 38%,transparent) 0 5px,transparent 5px 9px);}
.spectrum-wrap{margin:0 0 6px;}
.pctline{margin-top:6px;font:11.5px/1 var(--mono);color:var(--muted);display:flex;justify-content:space-between;gap:10px;}
.pctline b{color:var(--pass);font-weight:600;}
.spectrum-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font:11px/1 var(--mono);color:var(--muted);}
.spectrum-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:-1px;}
.i-done{background:var(--pass);} .i-fail{background:var(--fail);} .i-unknown{background:color-mix(in srgb,var(--muted) 50%,transparent);} .i-wip{background:var(--warn);} .i-hold{background:var(--block);} .i-todo{background:color-mix(in srgb,var(--muted) 50%,transparent);}
.statusfilter{display:flex;gap:6px;flex-wrap:wrap;}
.sf{font:600 11px/1 var(--mono);letter-spacing:.04em;text-transform:uppercase;cursor:pointer;background:var(--bg-raise);color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:8px 12px;}
.sf:hover{border-color:var(--accent);}
.sf[aria-pressed=true]{color:var(--bg);border-color:transparent;}
.sf.done[aria-pressed=true]{background:var(--pass);} .sf.fail[aria-pressed=true]{background:var(--fail);} .sf.unknown[aria-pressed=true]{background:var(--muted);} .sf.wip[aria-pressed=true]{background:var(--warn);} .sf.hold[aria-pressed=true]{background:var(--block);} .sf.todo[aria-pressed=true]{background:var(--fg);color:var(--bg);}
.section-h{font:600 12px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:30px 0 11px;display:flex;align-items:baseline;gap:10px;}
.section-h .rule{flex:1;height:1px;background:var(--line);}
.section-h .ct{color:var(--accent);}
details.epic{border:1px solid var(--line);border-radius:10px;background:var(--bg-raise);margin:0 0 9px;overflow:hidden;}
details.epic[open]{border-color:color-mix(in srgb,var(--accent) 40%,var(--line));}
details.epic.filtered-out{display:none;}
summary.epic-sum{list-style:none;cursor:pointer;padding:13px 16px;display:grid;grid-template-columns:18px 1fr auto;align-items:center;gap:14px;}
summary.epic-sum::-webkit-details-marker{display:none;}
.caret{width:18px;height:18px;color:var(--muted);transition:transform .18s;font:13px/18px var(--mono);text-align:center;}
details.epic[open] .caret{transform:rotate(90deg);color:var(--accent);}
.epic-main{min-width:0;}
.epic-name{font:600 17px/1.25 var(--serif);letter-spacing:-.01em;}
.epic-name a{color:var(--fg);text-decoration:none;} .epic-name a:hover{color:var(--accent);}
.epic-docmark{display:inline-flex;align-items:center;margin-left:8px;vertical-align:2px;font:600 9.5px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;border:1px solid var(--line);border-radius:999px;padding:3px 7px;color:var(--muted);}
.epic-docmark.has-overview{color:var(--pass);border-color:color-mix(in srgb,var(--pass) 45%,transparent);}
.epic-docmark.no-overview{border-style:dashed;}
.epic-mini{display:flex;height:6px;border-radius:999px;overflow:hidden;margin-top:7px;max-width:320px;border:1px solid var(--line);}
.epic-tally{font:13px/1 var(--mono);color:var(--muted);white-space:nowrap;text-align:right;}
.epic-tally b{font-weight:600;color:var(--pass);font-variant-numeric:tabular-nums;}
.epic-docs{margin:18px 0;}
.epic-doclinks{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;}
.epic-doc{display:grid;gap:5px;border:1px solid var(--line);border-radius:8px;padding:11px 12px;background:var(--bg-raise);text-decoration:none;color:var(--fg);}
.epic-doc:hover{border-color:var(--accent);}
.doc-kind{font:700 10px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--accent);}
.doc-title{font:600 14px/1.3 var(--serif);}
.epic-doc code{justify-self:start;color:var(--muted);}
.stories{border-top:1px solid var(--line);padding:5px 8px 9px;}
.story{display:grid;grid-template-columns:56px 120px 1fr 116px minmax(168px,auto);align-items:center;gap:12px;padding:7px 10px;border-radius:7px;text-decoration:none;color:inherit;}
.slegacy{font:600 9.5px/1 var(--mono);letter-spacing:.04em;text-transform:uppercase;padding:2px 5px;border-radius:4px;border:1px dashed var(--line);color:var(--muted);background:color-mix(in srgb,var(--muted) 8%,transparent);}
.story:hover{background:color-mix(in srgb,var(--accent) 7%,transparent);}
.stype{font:600 10px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;text-align:center;padding:4px 0;border-radius:4px;border:1px solid var(--line);color:var(--muted);}
.stype.US{color:var(--info);border-color:color-mix(in srgb,var(--info) 40%,transparent);}
.stype.FIX{color:var(--fail);border-color:color-mix(in srgb,var(--fail) 40%,transparent);}
.stype.REFACTOR{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent);}
.stype.IDEA{color:var(--claim);border-color:color-mix(in srgb,var(--claim) 40%,transparent);}
.sid{font:12.5px/1 var(--mono);color:var(--fg);}
.stitle{font:14px/1.35 var(--serif);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sstat{font:600 11px/1 var(--mono);white-space:nowrap;display:flex;align-items:center;gap:6px;}
.sdot{width:8px;height:8px;border-radius:50%;display:inline-block;}
.st-done{color:var(--pass);} .st-done .sdot{background:var(--pass);}
.st-fail{color:var(--fail);} .st-fail .sdot{background:var(--fail);}
.st-unknown{color:var(--muted);} .st-unknown .sdot{background:transparent;border:1px solid var(--muted);}
.st-wip{color:var(--warn);} .st-wip .sdot{background:var(--warn);}
.st-todo{color:var(--muted);} .st-todo .sdot{background:var(--muted);}
.st-hold{color:var(--block);} .st-hold .sdot{background:var(--block);}
.sclaim,.struth{font:600 9.5px/1 var(--mono);letter-spacing:.04em;text-transform:uppercase;padding:2px 5px;border-radius:4px;border:1px solid var(--line);color:var(--muted);}
.struth.tr-fail{color:var(--fail);border-color:color-mix(in srgb,var(--fail) 50%,transparent);}
.struth.tr-unknown{color:var(--muted);border-style:dashed;}
.struth.tr-done{color:var(--pass);border-color:color-mix(in srgb,var(--pass) 50%,transparent);}
.pill.fail{color:var(--fail);border:1px solid color-mix(in srgb,var(--fail) 50%,transparent);}
.pill.unknown{color:var(--muted);border:1px dashed var(--line);}
.truth-reason{font:10.5px/1 var(--mono);color:var(--muted);}
.lifespine{display:flex;align-items:center;gap:0;}
.lifespine i{width:8px;height:8px;border-radius:50%;border:1.5px solid var(--line);background:transparent;flex:none;}
.lifespine b{height:1.5px;width:13px;background:var(--line);flex:none;}
.lifespine i.on{border-color:var(--pass);background:var(--pass);} .lifespine b.on{background:var(--pass);}
.lifespine i.now{border-color:var(--warn);background:var(--warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 22%,transparent);}
.lifespine.held i.now{border-color:var(--block);background:var(--block);box-shadow:0 0 0 3px color-mix(in srgb,var(--block) 22%,transparent);}
.lifespine.legacy i{border-style:dashed;border-color:color-mix(in srgb,var(--muted) 55%,transparent);background:transparent;}
.lifespine.legacy b{background:color-mix(in srgb,var(--muted) 35%,transparent);}
@media (max-width:680px){.truth-tiles{grid-template-columns:1fr;} .statusboard{grid-template-columns:repeat(2,1fr);} .story{grid-template-columns:48px 1fr auto;gap:8px;} .story .lifespine,.story .stitle{display:none;}}
`;

/**
 * Inline filter script for list pages (search box + "only shipping" toggle).
 * Self-containment holds: inline, zero network, zero external assets — the
 * single-script red line is a REPORT-page contract; list pages carry chrome +
 * this filter. Rows opt in via `data-search` (haystack) and `data-truth`.
 */
export const DOSSIER_FILTER_SCRIPT = `<script>
(function () {
  function norm(s) { return (s || "").toLowerCase(); }
  document.addEventListener("DOMContentLoaded", function () {
    var q = document.querySelector("[data-dossier-search]");
    var sfs = [].slice.call(document.querySelectorAll("[data-sf]"));
    var epics = [].slice.call(document.querySelectorAll("details.epic"));
    function active() {
      return sfs.filter(function (b) { return b.getAttribute("aria-pressed") === "true"; })
                .map(function (b) { return b.getAttribute("data-sf"); });
    }
    function apply() {
      var needle = norm(q && q.value);
      var act = active();
      for (var i = 0; i < epics.length; i++) {
        var ep = epics[i];
        var hitText = !needle || norm(ep.getAttribute("data-search")).indexOf(needle) !== -1;
        var sts = (ep.getAttribute("data-status") || "").split(" ");
        var hitStat = act.length === 0 || act.some(function (a) { return sts.indexOf(a) !== -1; });
        var show = hitText && hitStat;
        ep.classList.toggle("filtered-out", !show);
        // Auto-expand matches while a filter is active; collapse again when cleared.
        if (show && (needle || act.length)) ep.open = true;
        else if (!needle && act.length === 0) ep.open = false;
      }
      document.documentElement.setAttribute("data-filtered", needle || act.length ? "1" : "0");
    }
    if (q) q.addEventListener("input", apply);
    sfs.forEach(function (b) {
      b.addEventListener("click", function () {
        b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
        apply();
      });
    });
    // Overview tally cards jump-filter to that one status.
    [].slice.call(document.querySelectorAll("[data-jump]")).forEach(function (t) {
      t.addEventListener("click", function (e) {
        e.preventDefault();
        var k = t.getAttribute("data-jump");
        sfs.forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-sf") === k ? "true" : "false"); });
        apply();
      });
    });
    apply();
  });
})();
</script>`;
