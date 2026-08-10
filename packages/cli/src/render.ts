/**
 * @responsibility Renders terminal output with byte-aligned layout, color, and CJK width handling.
 */
/**
 * Terminal rendering primitives — TS port of lib/roll_render.py (the shared
 * layout engine for status/prices/backlog/dashboard views). Byte-aligned with
 * the python oracle; CJK/fullwidth glyphs occupy 2 cells (strw) which is what
 * keeps EN/ZH paired rows column-aligned.
 */

export const COLS = 100;

/** Set from the entry after flag/TTY checks — mirrors roll_render.USE_COLOR. */
export const renderState = { useColor: true };

function rgb(hexstr: string): string {
  const h = hexstr.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Single source of truth — every visible color (mirrors PAL). */
const PAL: Record<string, string> = {
  fg: rgb("e6edf3"),
  dim: rgb("8b949e"),
  muted: rgb("6e7681"),
  faint: rgb("484f58"),
  blue: rgb("58a6ff"),
  green: rgb("3fb950"),
  amber: rgb("d29922"),
  red: rgb("f85149"),
  purple: rgb("bc8cff"),
  pink: rgb("f778ba"),
  yellow: rgb("e3b341"),
};
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function c(color: string, s: string, opts: { bold?: boolean } = {}): string {
  if (!renderState.useColor) return s;
  return `${PAL[color] ?? ""}${opts.bold === true ? BOLD : ""}${s}${RESET}`;
}

const ANSI_RE = /\x1b\[[\d;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * East-Asian wide (W) / fullwidth (F) code points → 2 cells, everything else 1
 * (mirrors python unicodedata.east_asian_width in ("F","W")).
 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals .. CJK Symbols (excl. 303F)
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji blocks classified W
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}

/** Display width after stripping ANSI escapes. */
export function strw(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

export function pad(s: string, w: number, align: "l" | "r" = "l"): string {
  const sw = strw(s);
  if (sw >= w) return s;
  const fill = " ".repeat(w - sw);
  return align === "r" ? fill + s : s + fill;
}

/** Two-end-flush row at `width` columns. */
export function row(left: string, right: string, width: number = COLS): string {
  const gap = Math.max(1, width - strw(left) - strw(right));
  return left + " ".repeat(gap) + right;
}

export function sectionHead(en: string, zh: string, hint: string): string {
  const left = "  " + c("pink", en, { bold: true }) + c("muted", "  ·  ") + c("dim", zh);
  return row(left, c("muted", hint));
}

/** Horizontal rule line (mirrors status._hr). */
export function hr(): string {
  return c("faint", "─".repeat(COLS));
}

/** Truncate to display width n with a trailing ellipsis (mirrors trunc). */
export function trunc(s: string, n: number): string {
  if (strw(s) <= n) return s;
  let out = "";
  for (const ch of s) {
    if (strw(out) + strw(ch) + 1 > n) return out + "\u2026";
    out += ch;
  }
  return out;
}

const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export function sparkline(values: readonly (number | null)[]): string {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return "";
  if (nums.length === 0) return values.map(() => "·").join("");
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (Math.abs(max - min) < 1e-9) {
    return values.map((value) => (value === null ? "·" : SPARK_BLOCKS[0])).join("");
  }
  return values.map((value) => {
    if (value === null || !Number.isFinite(value)) return "·";
    const bucket = Math.min(SPARK_BLOCKS.length - 1, Math.max(0, Math.floor(((value - min) / (max - min)) * (SPARK_BLOCKS.length - 1))));
    return SPARK_BLOCKS[bucket] ?? SPARK_BLOCKS[0];
  }).join("");
}

/** Raw RESET escape (exported for background-row rendering parity). */
export const RESET_RAW = "\x1b[0m";

/** Raw BOLD escape (needed by dashboard for direct concatenation parity). */
export const BOLD_RAW = "\x1b[1m";

// ════════════════════════════════════════════════════════════════════════════
// Formatters — faithful ports of lib/roll_render.py (used by the dashboard).
// ════════════════════════════════════════════════════════════════════════════

/** Mirror roll_render.fmt_dur. */
export function fmtDur(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Mirror roll_render.fmt_model. */
export function fmtModel(model: string | null | undefined): string {
  if (model === null || model === undefined || model === "") return "—";
  const prefixed = /^([a-z][a-z0-9_]*)-(.+)$/i.exec(model);
  if (prefixed === null) return model;
  const vendor = prefixed[1] ?? "";
  let s = prefixed[2] ?? "";
  if (vendor !== "claude") return model;
  s = s.replace(/-\d{6,8}$/, "");
  return s !== "" ? s : model;
}

/**
 * Mirror roll_render.fmt_tokens. Python's `f"{x:.1f}"` rounds half-to-even,
 * but the values here are ratios of integers / 1000 etc. — we replicate via
 * a banker's-rounding-aware toFixed below to stay byte-aligned.
 */
function pyFixed1(x: number): string {
  // Python format spec uses round-half-to-even on the decimal value.
  // For 1 decimal place: scale by 10, round half-to-even, format.
  const scaled = x * 10;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  let r: number;
  const eps = 1e-9;
  if (Math.abs(frac - 0.5) < eps) {
    r = floor % 2 === 0 ? floor : floor + 1;
  } else {
    r = Math.round(scaled);
  }
  return (r / 10).toFixed(1);
}

export function fmtTokens(n: number): string {
  if (!n) return "—";
  if (n < 1000) return String(Math.trunc(n));
  if (n < 1_000_000) return `${pyFixed1(n / 1000)}K`.replace(".0K", "K");
  if (n < 1_000_000_000) return `${pyFixed1(n / 1_000_000)}M`.replace(".0M", "M");
  return `${pyFixed1(n / 1_000_000_000)}B`.replace(".0B", "B");
}

/** Subtle red wash for a whole failure row (mirror roll_render.BG_FAIL). */
export const BG_FAIL = "\x1b[48;2;55;15;15m";

/** Python round() — round-half-to-even, integer result. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  const eps = 1e-9;
  if (Math.abs(frac - 0.5) < eps) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(x);
}

export type DeltaKind = "up_good" | "up_bad" | "any";

/** Mirror roll_render.fmt_delta → [text, colorName]. */
export function fmtDelta(
  today: number,
  yest: number,
  kind: DeltaKind,
  unit = "",
): [string, string] {
  if (yest === 0 && today === 0) return ["—", "muted"];
  if (yest === 0) return ["▲ new", "amber"];
  const diff = today - yest;
  if (Math.abs(diff) < 1e-9) return ["=", "muted"];
  const arrow = diff > 0 ? "▲" : "▼";
  const sign = diff > 0 ? "+" : "−";
  const mag = Math.abs(diff);
  let body: string;
  if (unit === "$" || unit === "¥") body = `${sign}${unit}${mag.toFixed(2)}`;
  else if (unit === "m") body = `${sign}${pyRound(mag)}m`;
  else body = `${sign}${pyRound(mag)}`;
  const color =
    kind === "up_good"
      ? diff > 0
        ? "green"
        : "amber"
      : kind === "up_bad"
        ? diff > 0
          ? "red"
          : "green"
        : "amber";
  return [`${arrow} ${body}`, color];
}

export interface Rollup {
  cycles: number;
  prs: number;
  failed: number;
  duration_s: number;
  cost: number;
  input_tokens: number;
  output_tokens: number;
}

export function emptyRollup(): Rollup {
  return {
    cycles: 0,
    prs: 0,
    failed: 0,
    duration_s: 0,
    cost: 0.0,
    input_tokens: 0,
    output_tokens: 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Section / metric / cycle rows — printers used by the dashboard.
// Each returns the string(s) it would `print`; the caller joins with "\n".
// ════════════════════════════════════════════════════════════════════════════

interface MetricOpts {
  yestColor?: string;
  yestSuffix?: string;
  partial?: boolean;
}

/** Mirror roll_render.metric. */
export function metric(
  name: string,
  t: number,
  y: number,
  d2: number,
  kind: DeltaKind,
  opts: MetricOpts = {},
): string {
  const yestColor = opts.yestColor ?? "dim";
  const yestSuffix = opts.yestSuffix ?? "";
  const partial = opts.partial ?? false;
  const [deltaText, deltaC0] = fmtDelta(t, y, kind);
  let deltaC = deltaC0;
  if (partial && deltaC !== "muted") deltaC = "muted";
  const yestStr = `${y}` + (yestSuffix !== "" ? ` ${yestSuffix}` : "");
  return (
    "  " +
    c("dim", pad(name, 14)) +
    c("fg", pad(String(t), 8, "r"), { bold: true }) +
    "  " +
    c(deltaC, pad(deltaText, 12), { bold: deltaC !== "muted" }) +
    c(yestColor, pad(yestStr, 10), { bold: yestSuffix !== "" }) +
    c("muted", pad(String(d2), 8))
  );
}

/** Mirror roll_render.metric_dur. */
export function metricDur(
  name: string,
  t: number,
  y: number,
  d2: number,
  opts: { partial?: boolean } = {},
): string {
  const partial = opts.partial ?? false;
  const tM = Math.floor(t / 60);
  const yM = Math.floor(y / 60);
  const [deltaText, deltaC0] = fmtDelta(tM, yM, "up_bad", "m");
  let deltaC = deltaC0;
  if (partial && deltaC !== "muted") deltaC = "muted";
  return (
    "  " +
    c("dim", pad(name, 14)) +
    c("fg", pad(fmtDur(t), 8, "r"), { bold: true }) +
    "  " +
    c(deltaC, pad(deltaText, 12), { bold: deltaC !== "muted" }) +
    c("dim", pad(fmtDur(y), 10)) +
    c("muted", pad(fmtDur(d2), 8))
  );
}

/** Mirror roll_render.metric_dollar. */
export function metricDollar(
  name: string,
  t: number,
  y: number,
  d2: number,
  opts: { partial?: boolean; symbol?: string } = {},
): string {
  const partial = opts.partial ?? false;
  const symbol = opts.symbol ?? "$";
  const [deltaText, deltaC0] = fmtDelta(t, y, "up_bad", symbol);
  let deltaC = deltaC0;
  if (partial && deltaC !== "muted") deltaC = "muted";
  return (
    "  " +
    c("dim", pad(name, 14)) +
    c("fg", pad(`${symbol}${t.toFixed(2)}`, 8, "r"), { bold: true }) +
    "  " +
    c(deltaC, pad(deltaText, 12), { bold: deltaC !== "muted" }) +
    c("dim", pad(`${symbol}${y.toFixed(2)}`, 10)) +
    c("muted", pad(`${symbol}${d2.toFixed(2)}`, 8))
  );
}

/** Mirror roll_render.metric_tokens. */
export function metricTokens(
  name: string,
  t: number,
  y: number,
  d2: number,
  opts: { partial?: boolean } = {},
): string {
  const partial = opts.partial ?? false;
  let deltaText: string;
  let deltaC: string;
  if (y === 0 && t === 0) {
    deltaText = "—";
    deltaC = "muted";
  } else if (y === 0) {
    deltaText = "▲ new";
    deltaC = "amber";
  } else if (t === y) {
    deltaText = "=";
    deltaC = "muted";
  } else {
    const diff = t - y;
    const arrow = diff > 0 ? "▲" : "▼";
    const sign = diff > 0 ? "+" : "−";
    deltaText = `${arrow} ${sign}${fmtTokens(Math.abs(diff))}`;
    deltaC = diff > 0 ? "red" : "green";
  }
  if (partial && deltaC !== "muted") deltaC = "muted";
  return (
    "  " +
    c("dim", pad(name, 14)) +
    c("fg", pad(fmtTokens(t), 8, "r"), { bold: true }) +
    "  " +
    c(deltaC, pad(deltaText, 12), { bold: deltaC !== "muted" }) +
    c("dim", pad(fmtTokens(y), 10)) +
    c("muted", pad(fmtTokens(d2), 8))
  );
}

const WEEKDAY_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/**
 * weekday index (0=Mon..6=Sun) for a YYYY-MM-DD date string (Zeller-free,
 * via UTC Date — the date carries no TZ so UTC math is exact).
 */
function weekdayIndex(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  // getUTCDay: 0=Sun..6=Sat → convert to 0=Mon..6=Sun
  return (dt.getUTCDay() + 6) % 7;
}

/** Days between two YYYY-MM-DD date strings (a - b), calendar days. */
function dateDiffDays(a: string, b: string): number {
  const pa = a.split("-").map((x) => parseInt(x, 10));
  const pb = b.split("-").map((x) => parseInt(x, 10));
  const ua = Date.UTC(pa[0] ?? 1970, (pa[1] ?? 1) - 1, pa[2] ?? 1);
  const ub = Date.UTC(pb[0] ?? 1970, (pb[1] ?? 1) - 1, pb[2] ?? 1);
  return Math.round((ua - ub) / 86400000);
}

/**
 * Mirror roll_render.day_band. `nowDayKey`/`yestDayKey` are the display-TZ
 * YYYY-MM-DD strings of `now` and `now-1d` (caller computes in UTC+8).
 */
export function dayBand(
  dayKey: string,
  nTotal: number,
  nFailed: number,
  nowDayKey: string,
  yestDayKey: string,
  opts: { inProgress?: boolean } = {},
): string {
  const inProgress = opts.inProgress ?? false;
  let label: string;
  if (dayKey === nowDayKey) label = "Today · 今日";
  else if (dayKey === yestDayKey) label = "Yesterday · 昨日";
  else {
    const n = dateDiffDays(nowDayKey, dayKey);
    label = `−${n} days · 前 ${n} 天`;
  }
  const wi = weekdayIndex(dayKey);
  const weekday = WEEKDAY_EN[wi] ?? "";
  const weekdayZh = WEEKDAY_ZH[wi] ?? "";
  let countStr = `${nTotal} cycles` + (nFailed ? ` · ${nFailed} failed` : " · 0 failed");
  if (inProgress) countStr += "  ·  " + "in progress";
  const left =
    "  " +
    c("faint", "─ ") +
    c("fg", label, { bold: true }) +
    c("muted", " · ") +
    c("dim", dayKey) +
    c("muted", " · ") +
    c("dim", `${weekday} · ${weekdayZh}`) +
    " ";
  let rightInner: string;
  if (inProgress) {
    rightInner =
      c("dim", `${nTotal} cycles`) +
      (nFailed ? c("dim", ` · ${nFailed} failed`) : c("dim", " · 0 failed")) +
      c("muted", "  ·  ") +
      c("amber", "in progress");
  } else {
    rightInner = c("dim", countStr);
  }
  const right = "  " + rightInner;
  const dashes = Math.max(2, COLS - strw(left) - strw(right));
  return left + c("faint", "─".repeat(dashes)) + right;
}

export interface CycleView {
  outcome?: string;
  pr_outcome?: string | null;
  start_hhmm: string; // display-TZ HH:MM (caller computes)
  duration_s?: number;
  cron_duration_s?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  cost_currency?: string;
  cost_list?: number | null;
  cron_cost?: number | null;
  tool_summary?: string;
  story?: string | null;
  built?: string[];
  model?: string | null;
  agent?: string | null;
  pr_num?: number | null;
  cost_list_legacy?: boolean;
  fail_detail?: string | null;
  label?: string;
}

/** Mirror roll_render.cycle_row → array of output lines. */
export function cycleRow(cy: CycleView): string[] {
  const outcome = cy.outcome ?? "done";
  const prOutcome = cy.pr_outcome ?? null;
  const glyphMap: Record<string, [string, string]> = {
    done: ["green", "✓"],
    ok: ["green", "✓"],
    fail: ["red", "✗"],
    running: ["purple", "⏵"],
    idle: ["muted", "·"],
    // US-TRUTH-004 AC4: an unknown verdict must read as unknown — never as a
    // neutral dot the eye parses as success.
    unknown: ["amber", "?"],
  };
  let [glyphC, glyph] = glyphMap[outcome] ?? ["muted", "·"];
  if ((outcome === "done" || outcome === "ok") && prOutcome === "closed") {
    glyphC = "amber";
    glyph = "⊘";
  }
  const timeStr = cy.start_hhmm;
  let durS = cy.duration_s || cy.cron_duration_s || 0;
  // running wall-clock elapsed is handled by the caller (needs `now`).
  const dur = durS ? fmtDur(durS) : "—";

  const inp = cy.input_tokens || 0;
  const outTok = cy.output_tokens || 0;
  const cw = cy.cache_creation_tokens || 0;
  const crd = cy.cache_read_tokens || 0;
  let tok: string;
  if (cw || crd) {
    tok = `${fmtTokens(inp)}/${fmtTokens(cw)}↑ ${fmtTokens(crd)}↓/${fmtTokens(outTok)}`;
  } else {
    tok = `${fmtTokens(inp)}/${fmtTokens(outTok)}`;
  }
  const cur = cy.cost_currency ?? "USD";
  const symbol = cur === "CNY" ? "¥" : "$";
  // Quirk parity: in the python cycle_row the local `cr` name is reassigned to
  // cache_read_tokens (an int) *before* the cost fallback, so the
  // `elif cr: cr.get('cost')` branch is effectively dead (cache_read is 0 in
  // practice, and would AttributeError if not). Cost therefore only ever shows
  // from cost_list; everything else renders "—". cron_cost is intentionally
  // unused here.
  let cost: string;
  if (cy.cost_list !== undefined && cy.cost_list !== null) {
    cost = `${symbol}${cy.cost_list.toFixed(2)}`;
  } else {
    cost = "—";
  }
  const sid = cy.story || "—";
  const built = cy.built && cy.built.length > 0 ? cy.built : sid !== "—" ? [sid] : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const s of built) {
    if (s && !seen.has(s)) {
      seen.add(s);
      ids.push(s);
    }
  }
  const idsStr = ids.length > 0 ? ids.join(" | ") : sid;
  const timeC = outcome === "fail" ? "red" : "fg";
  const sidC = outcome === "fail" ? "red" : "blue";

  // FIX-1262: show the ledger's spawn model, or "—" when it is absent. NEVER
  // backfill the agent's source-baked default model (agentDefaultModel): that
  // fabricates a model this cycle may never have run on. fmtModel already maps
  // an empty/absent model to "—".
  const modelLabel = fmtModel(cy.model);
  const showModel = COLS >= 100;
  const modelSeg = showModel ? c("muted", pad(modelLabel, 11)) + " " : "";

  let prMarker = "";
  const prNum = cy.pr_num;
  if (prNum !== undefined && prNum !== null && prOutcome) {
    const markMap: Record<string, [string, string]> = {
      merged: ["green", "✓"],
      closed: ["amber", "↩"],
      open: ["dim", "…"],
    };
    const [markC, markSym] = markMap[prOutcome] ?? ["dim", "…"];
    prMarker = " " + c(markC, `#${prNum} ${markSym}`);
  }
  const legacyMarker = cy.cost_list_legacy ? " " + c("muted", "[legacy]") : "";
  const tools = cy.tool_summary && cy.tool_summary !== "" ? c("muted", pad(cy.tool_summary, 22)) + " " : "";
  const inner =
    "  " +
    c(glyphC, glyph, { bold: true }) +
    "  " +
    c(timeC, pad(timeStr, 5), { bold: outcome === "fail" }) +
    "   " +
    c("muted", pad(dur, 4, "r")) +
    "  " +
    c("muted", pad(tok, 26)) +
    "  " +
    modelSeg +
    c("muted", pad(cost, 7, "r")) +
    "   " +
    tools +
    c(sidC, idsStr, { bold: true }) +
    prMarker +
    legacyMarker;

  const lines: string[] = [];
  if (outcome === "fail" && renderState.useColor) {
    const linePad = Math.max(0, COLS - strw(inner));
    const innerPadded = inner + " ".repeat(linePad);
    lines.push(BG_FAIL + innerPadded.replaceAll(RESET_RAW, RESET_RAW + BG_FAIL) + RESET_RAW);
    let hint = " ".repeat(8) + c("dim", "→ ") + c("amber", `roll loop runs --detail ${cy.label ?? ""}`);
    if (cy.fail_detail) hint += c("muted", "   ") + c("dim", cy.fail_detail);
    const hintPad = Math.max(0, COLS - strw(hint));
    const hintPadded = hint + " ".repeat(hintPad);
    lines.push(BG_FAIL + hintPadded.replaceAll(RESET_RAW, RESET_RAW + BG_FAIL) + RESET_RAW);
  } else {
    lines.push(inner);
    if (outcome === "fail" && cy.fail_detail) {
      lines.push(" ".repeat(8) + "→ " + `roll loop runs --detail ${cy.label ?? ""}`);
    }
  }
  return lines;
}
