/**
 * @responsibility Enforces the design-phase visual-evidence contract.
 */
/**
 * FIX-311 — the DESIGN-PHASE visual-evidence contract (roll-design's teeth).
 *
 * The three screenshot gates must agree or they fight each other:
 *   - DESIGN (this file / FIX-311): the spec is BORN honest — every non-exempt
 *     story carries an AC that captures its user-visible surface, and a WEB
 *     surface DECLARES the real product page it will screenshot
 *     (`deliverable_url:`, alias `screenshot_url:`).
 *   - ENFORCE (FIX-309 / runner/attest-gate.ts): a captured screenshot is the
 *     baseline for EVERY story; keyword/rule matching may NEVER enable the
 *     requirement, only record an explicit exemption.
 *   - ARCHIVE (FIX-334): the produced evidence lands in the card dossier.
 *
 * This is the shift-left of the SAME contract: it is far cheaper to catch a
 * spec with no visual-evidence AC at design time than to let the runtime gate
 * discover, mid-delivery, that the card can never satisfy the screenshot floor.
 *
 * FIX-311b — two refinements that make this safe to WIRE INTO the build
 * preflight (it now actually fails-loud, so over-enforce / false-positives
 * would block the loop):
 *   (a) SURFACE-AWARE. `deliverable_url` is WEB-ONLY: a card whose visual AC
 *       captures a TERMINAL surface (CLI / TUI / `roll` command / a screen
 *       recording cast) rides the separate terminal-capture lane and must NOT
 *       be forced to declare a web url. Only a WEB-surface visual AC (a page /
 *       console / browser tab / index.html) owes a `deliverable_url`. A visual
 *       AC of an AMBIGUOUS surface (a bare "screenshot" with no web/terminal
 *       cue) is treated conservatively as terminal-or-unknown — it is NOT
 *       blocked for a missing url (the runtime FIX-309 gate is the backstop).
 *   (b) DUAL-USE TOKEN FIX. The words `captured` / `capture of` /
 *       `deliverable_url` / `screenshot_url` are dual-use: "telemetry data is
 *       captured from the API" or "writes deliverable_url into the manifest" are
 *       NOT visual-evidence ACs. These tokens now count ONLY inside an explicit
 *       visual-evidence context (a `[visual-evidence]` marker, "截图证明", or
 *       paired with a web/terminal screenshot cue). The unambiguous nouns
 *       (`screenshot` / `截图` / `录屏` / `终端截图` …) still count on their own.
 *
 * RED LINE — a GENERIC mechanism, never a per-card patch. It NEVER names a
 * specific card's url and NEVER uses keywords to ENABLE the requirement
 * (the FIX-284 dead-field trap). Visual evidence is required BY DEFAULT for
 * every story; the ONLY way out is a recorded, per-card exemption
 * (`screenshot_exempt: <reason>`). Keyword matching is consulted ONLY to
 * RECOGNISE an AC that already captures a visual surface — never to decide a
 * card needs one.
 */
import { parseAcBlocks } from "@roll/core";
import { allowedDeliverableCmd } from "../runner/attest-gate.js";
import { declaresPhysicalTerminalSpec, physicalTerminalFromSpecText, physicalTerminalParseError } from "./physical-terminal.js";

/** The user-visible surface a story's visual-evidence AC captures. */
export type VisualSurface =
  /** A web page / console / browser tab — owes a declared `deliverable_url`. */
  | "web"
  /** A terminal / CLI / TUI / screen-recording cast — rides the terminal-capture lane (no url). */
  | "terminal"
  /** A visual AC with no web/terminal cue — conservatively NOT forced to declare a url. */
  | "ambiguous"
  /** No visual-evidence AC at all. */
  | "none";

export interface VisualEvidenceVerdict {
  /** true ⇒ the spec satisfies the design-phase visual-evidence contract. */
  ok: boolean;
  /** Machine-readable failure code; undefined when ok. */
  code?: "missing-visual-evidence-ac" | "web-surface-without-deliverable-url" | "deliverable-cmd-rejected" | "physical-terminal-invalid";
  /** Human-readable reason (EN) — undefined when ok. */
  reason?: string;
  /** When exempt, the recorded exemption reason (the contract was waived, not met). */
  exemptReason?: string;
  /** Whether the spec declares a `deliverable_url` / `screenshot_url`. */
  declaresDeliverableUrl: boolean;
  /** Whether some AC captures a user-visible surface (web / CLI / TUI). */
  hasVisualEvidenceAc: boolean;
  /** The surface the visual-evidence AC captures (drives the url requirement). */
  surface: VisualSurface;
  /** deliverable_cmd entries rejected by the allowlist (same as attest gate would reject). */
  rejectedDeliverableCmds?: string[];
  /** deliverable_cmd entries that look like streaming/never-terminating commands. */
  streamingDeliverableCmds?: string[];
  /** Whether an exempt spec lacks substitute capturable evidence (authoring-only gate). */
  exemptSubstituteMissing?: boolean;
}

/**
 * UNAMBIGUOUS visual-evidence nouns — these mark an AC as a visual-evidence AC
 * on their own (no surrounding context required). They are never used as
 * non-visual jargon in the corpus. Bilingual + the canonical evidence nouns so
 * the recogniser is not locale-fragile. This list ONLY RECOGNISES an existing
 * visual-evidence AC — it is never used to decide whether a card needs one
 * (that is always yes, by default).
 */
const UNAMBIGUOUS_VISUAL_TOKENS = [
  "screenshot",
  "screen shot",
  "screen-capture",
  "screencapture",
  "screen capture",
  "visual evidence",
  "visual proof",
  "rendered view",
  "截图",
  "截屏",
  "可视证据",
  "可视化证据",
  "录屏",
  "终端截图",
  "tui 截",
  "cli 截",
];

/**
 * DUAL-USE tokens — words that appear in BOTH visual-evidence ACs AND ordinary
 * non-visual prose (FIX-311b hole b: "telemetry captured", "write deliverable_url
 * into the manifest"). They count as a visual-evidence AC ONLY when the AC item
 * ALSO carries an explicit visual-evidence context cue (see below) — never on
 * their own.
 */
const DUAL_USE_VISUAL_TOKENS = [
  "captured",
  "capture of",
  "deliverable_url",
  "screenshot_url",
];

/**
 * The AUTHORITATIVE visual-evidence MARKER (FIX-341 AC1). An author who writes a
 * literal `[visual-evidence]` marker on an AC item has EXPLICITLY declared "this
 * AC carries visual evidence" — the marker IS the verdict. It counts on its own,
 * exactly like an unambiguous noun, and is NOT subject to the dual-use rule (it
 * does NOT need an accompanying `screenshot`/`截图` keyword). This closes the
 * false-negative where `[visual-evidence] headless 截 Now 及各 tab 真实渲染页`
 * was wrongly flagged `missing-visual-evidence-ac` because the verb "截" did not
 * match the hard-coded noun "截图".
 */
const VISUAL_EVIDENCE_MARKER = "[visual-evidence]";

/**
 * Explicit visual-evidence CONTEXT cues — when present in the same AC item, they
 * promote an otherwise dual-use token into a real visual-evidence AC. The Chinese
 * "截图证明 / 截图佐证", or any of the unambiguous nouns above (so
 * "deliverable_url screenshot" still counts). The `[visual-evidence]` marker is
 * NOT here — it is authoritative on its own (see {@link itemIsVisualEvidence}),
 * not merely a promoter of dual-use tokens.
 */
const VISUAL_CONTEXT_CUES = [
  "visual-evidence",
  "visual evidence",
  "截图证明",
  "截图佐证",
  "截屏证明",
  ...UNAMBIGUOUS_VISUAL_TOKENS,
];

/**
 * WEB-surface cues. A visual-evidence AC carrying any of these captures a WEB
 * surface and so owes a declared `deliverable_url` (the runtime web gate needs a
 * real product page). Bilingual + the canonical web nouns. Deliberately
 * CONSERVATIVE: genuinely cross-surface words (e.g. "dashboard", which can be a
 * TUI dashboard) are NOT here — they leave the surface ambiguous so the gate
 * never forces a web url onto a terminal deliverable (FIX-311b red line).
 */
const WEB_SURFACE_CUES = [
  "web page",
  "webpage",
  "web ui",
  "web 页",
  "网页",
  "页面",
  "browser",
  "浏览器",
  "console",
  "控制台",
  "index.html",
  ".html",
  "deliverable_url",
  "screenshot_url",
  "tab", // word-boundary matched below → never matches "table"/"establish"
  "标签页",
  "标签",
];

/**
 * TERMINAL-surface cues. A visual-evidence AC carrying any of these captures a
 * TERMINAL surface — it rides the separate terminal-capture lane and must NOT be
 * forced to declare a web url (FIX-311b hole a). CLI / TUI / a `roll …` command /
 * a terminal screenshot / a screen-recording cast. Alphanumeric cues are
 * word-boundary matched (so "cast" never matches "Casting", "cli" never matches
 * "click", "roll" never matches "rollback").
 */
const TERMINAL_SURFACE_CUES = [
  "terminal",
  "终端",
  "cli",
  "command line",
  "命令行",
  "tui",
  "录屏",
  "cast",
  "终端截图",
  "终端截屏",
  "tui 截",
  "cli 截",
  "stdout",
  "roll", // a `roll <subcommand>` invocation — a CLI deliverable
];

/**
 * Word-boundary-aware cue match. A cue made of ASCII word chars (with optional
 * spaces) must match on whole-word boundaries — so "cast" does NOT fire on
 * "Casting", "cli" not on "click", "roll" not on "rollback". A cue carrying
 * non-word characters (`.html`, `[visual-evidence]`) or CJK (no word boundaries
 * in JS regex) falls back to a plain substring test. `text` is already lower-cased.
 */
function cueMatches(text: string, cue: string): boolean {
  const lower = cue.toLowerCase();
  if (/^[a-z0-9 ]+$/.test(lower)) {
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(text);
  }
  return text.includes(lower);
}

function frontmatter(specText: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(specText);
  return m === null ? null : (m[1] ?? "");
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The recorded per-card exemption reason, or undefined. Mirrors the runtime
 * gate (FIX-309): a naked boolean (`true`/`false`/`yes`/`no`/`on`/`1`/`0`) is
 * NOT a reason — an exemption MUST carry words explaining why the card has no
 * visual surface. Frontmatter only (matching where the runtime gate reads it).
 */
export function visualExemptionReason(specText: string): string | undefined {
  const fm = frontmatter(specText);
  if (fm === null) return undefined;
  const m = /^screenshot_exempt:\s*(.+)$/m.exec(fm);
  if (m === null) return undefined;
  const reason = stripQuotes((m[1] ?? "").trim());
  if (reason === "" || /^(false|no|0|true|yes|on|1)$/i.test(reason)) return undefined;
  return reason;
}

/** Whether the spec frontmatter declares a real deliverable surface URL. */
export function declaresDeliverableUrl(specText: string): boolean {
  const fm = frontmatter(specText);
  if (fm === null) return false;
  const m = /^(?:deliverable_url|screenshot_url):\s*(.+)$/m.exec(fm);
  if (m === null) return false;
  return stripQuotes((m[1] ?? "").trim()) !== "";
}

/**
 * Whether the spec frontmatter declares a `deliverable_cmd` — a CLI/terminal
 * deliverable that rides the terminal-capture lane. Accepts both the scalar form
 * (`deliverable_cmd: roll status`) and the YAML block-list form
 * (`deliverable_cmd:\n  - roll status\n  - roll cycles`).
 */
export function declaresDeliverableCmd(specText: string): boolean {
  return parseDeliverableCmdsFromSpec(specText).length > 0;
}

/**
 * Whether a recorded screenshot exemption lacks substitute capturable evidence.
 * Runtime preflight keeps exemptions non-blocking; authoring validation uses
 * this extra signal to reject "no screenshot" specs that also name no command,
 * test, coverage output, or other capturable substitute.
 */
export function exemptionSubstituteMissing(specText: string): boolean {
  const reason = visualExemptionReason(specText);
  if (reason === undefined) return false;
  if (declaresDeliverableCmd(specText)) return false;
  return !/test|单测|测试|命令|输出|coverage|deliverable_cmd/i.test(reason);
}

/** Whether the spec frontmatter declares a `physical_terminal:` block. */
export function declaresPhysicalTerminal(specText: string): boolean {
  return declaresPhysicalTerminalSpec(specText);
}

/**
 * Parse the `deliverable_cmd:` frontmatter values from a spec. Returns the raw
 * commands (scalar = whole line, block list = per item; NO comma split, because
 * a command line legitimately carries commas). Empty / absent ⇒ [].
 *
 * FIX-383 — this pure-text parser mirrors the shape parser in attest-gate.ts
 * (`rawDeliverableCmdsForStory`), but works on raw spec text rather than
 * worktree+storyId, so `validateStoryVisualEvidence` can check the commands
 * against `allowedDeliverableCmd` during design-time validation.
 */
export function parseDeliverableCmdsFromSpec(specText: string): string[] {
  const fm = frontmatter(specText);
  if (fm === null) return [];
  const lines = fm.split("\n");
  const keyIdx = lines.findIndex((l) => /^deliverable_cmd:\s*(.*)$/.test(l));
  if (keyIdx === -1) return [];
  const scalar = stripQuotes((/^deliverable_cmd:\s*(.*)$/.exec(lines[keyIdx] ?? "")?.[1] ?? "").trim());
  if (scalar !== "") return [scalar];
  // Block-list form: the key line is empty; indented `- …` items follow
  // before the next top-level key.
  const cmds: string[] = [];
  for (const l of lines.slice(keyIdx + 1)) {
    const m = /^\s+-\s*(.+?)\s*$/.exec(l);
    if (m !== null) {
      const cmd = stripQuotes((m[1] ?? "").trim());
      if (cmd !== "") cmds.push(cmd);
      continue;
    }
    if (l.trim() === "") continue;
    break; // any other content (incl. the next key) ends the block
  }
  return cmds;
}

/**
 * Known streaming/never-terminating command patterns. A deliverable_cmd matching
 * any of these can never produce a single-frame screenshot (the capture mechanism
 * hangs waiting for the command to exit), so it is not suitable as a
 * deliverable_cmd — the author should use `--once` / a snapshot mode, or declare
 * `screenshot_exempt`.
 */
const STREAMING_CMD_PATTERNS: RegExp[] = [
  /\bwatch\b/i,
  /\btail\s+-f\b/i,
  /\bstream\b/i,
];

/** Whether a command looks like a streaming/never-terminating command. */
function isStreamingCommand(cmd: string): boolean {
  return STREAMING_CMD_PATTERNS.some((re) => re.test(cmd));
}

/**
 * Whether a single AC item's text is a visual-evidence AC.
 *
 * FIX-341 AC1: an explicit `[visual-evidence]` MARKER is authoritative — the
 * author declared this AC carries visual evidence, so it counts on its own
 * regardless of which nouns/verbs the AC text uses.
 *
 * FIX-311b dual-use fix: an UNAMBIGUOUS noun (`screenshot`, `截图`, `录屏`, …)
 * counts on its own; a DUAL-USE token (`captured`, `deliverable_url`, …) counts
 * ONLY when the same item ALSO carries an explicit visual-evidence context cue.
 * So "telemetry data is captured from the API" and "writes deliverable_url into
 * the manifest" are NOT visual-evidence ACs.
 */
function itemIsVisualEvidence(itemText: string): boolean {
  const text = itemText.toLowerCase();
  if (text.includes(VISUAL_EVIDENCE_MARKER)) return true;
  if (UNAMBIGUOUS_VISUAL_TOKENS.some((tok) => cueMatches(text, tok))) return true;
  const hasDualUse = DUAL_USE_VISUAL_TOKENS.some((tok) => cueMatches(text, tok));
  if (!hasDualUse) return false;
  // A dual-use token only counts inside an explicit visual-evidence context.
  return VISUAL_CONTEXT_CUES.some((cue) => cueMatches(text, cue));
}

/** Classify the surface a visual-evidence AC item captures (web/terminal/ambiguous). */
function itemSurface(itemText: string): "web" | "terminal" | "ambiguous" {
  const text = itemText.toLowerCase();
  const isWeb = WEB_SURFACE_CUES.some((cue) => cueMatches(text, cue));
  const isTerminal = TERMINAL_SURFACE_CUES.some((cue) => cueMatches(text, cue));
  // A genuinely mixed item (both cues) is treated as ambiguous — we never block
  // an ambiguous surface for a missing url (FIX-311b conservatism: FIX-309 backstops).
  if (isWeb && !isTerminal) return "web";
  if (isTerminal && !isWeb) return "terminal";
  return "ambiguous";
}

/** Whether ANY AC item in the spec captures a user-visible surface. */
export function hasVisualEvidenceAc(specText: string): boolean {
  for (const section of parseAcBlocks(specText)) {
    for (const item of section.items) {
      if (itemIsVisualEvidence(item.text)) return true;
    }
  }
  return false;
}

/**
 * Classify the visual surface of the spec's visual-evidence AC(s).
 *   - `none`      — no visual-evidence AC at all.
 *   - `web`       — at least one visual-evidence AC captures a WEB surface (and
 *                   none is a clear terminal-only deliverable). Owes a url.
 *   - `terminal`  — every visual-evidence AC captures a terminal surface (CLI /
 *                   TUI / cast). Rides the terminal-capture lane; no url owed.
 *   - `ambiguous` — a visual-evidence AC exists but no clear web/terminal cue,
 *                   OR a mix that does not cleanly resolve. Conservatively NOT
 *                   forced to declare a url (FIX-309 backstops at capture time).
 *
 * FIX-341 AC2 — the DECLARATION is authoritative over AC-text heuristics. Once a
 * visual-evidence AC exists, the surface is read from the frontmatter FIRST:
 *   1. a declared web `deliverable_url` / `screenshot_url` ⇒ `web` (the card has
 *      committed to a real product page, so it must capture one — this fixes the
 *      false-negative where US-DOSSIER-042 / US-EVID-018 declared `agents.html` /
 *      `index.html#loop` yet were mis-classified `terminal` from their AC prose).
 *   2. else a declared `deliverable_cmd` ⇒ `terminal` (a CLI deliverable).
 *   3. else fall back to the AC-text heuristic below.
 *
 * In the AC-text fallback, WEB wins when present and unambiguous: a card that
 * screenshots a web page genuinely owes a real product url even if it also
 * captures a terminal step.
 */
export function visualSurface(specText: string): VisualSurface {
  let sawVisual = false;
  let sawWeb = false;
  let sawTerminal = false;
  let sawAmbiguous = false;
  for (const section of parseAcBlocks(specText)) {
    for (const item of section.items) {
      if (!itemIsVisualEvidence(item.text)) continue;
      sawVisual = true;
      const s = itemSurface(item.text);
      if (s === "web") sawWeb = true;
      else if (s === "terminal") sawTerminal = true;
      else sawAmbiguous = true;
    }
  }
  if (!sawVisual) return "none";
  // FIX-341 AC2: the declared surface wins over AC-text heuristics.
  if (declaresDeliverableUrl(specText)) return "web";
  if (declaresPhysicalTerminal(specText)) return "terminal";
  if (declaresDeliverableCmd(specText)) return "terminal";
  if (sawWeb) return "web"; // a real web surface always owes its url
  if (sawTerminal && !sawAmbiguous) return "terminal";
  return "ambiguous";
}

/**
 * Validate a story spec against the FIX-311 design-phase visual-evidence
 * contract. PURE — takes the spec markdown, returns a verdict; no filesystem,
 * agent-agnostic, so the skill text can cite a function with real teeth and a
 * test can assert both the pass and fail paths.
 *
 * Decision (default = REQUIRED, exemption is the only opt-out):
 *   1. A recorded `screenshot_exempt: <reason>` ⇒ ok (contract waived, with
 *      the reason carried through). This is the ONLY honest skip.
 *   2. Otherwise the spec MUST carry a visual-evidence AC. None ⇒ fail
 *      (`missing-visual-evidence-ac`) — hole ②, the keyword-as-enabler leak.
 *   3. SURFACE-AWARE (FIX-311b hole a). A visual-evidence AC that captures a
 *      WEB surface but declares no `deliverable_url`/`screenshot_url` ⇒ fail
 *      (`web-surface-without-deliverable-url`) — the runtime web gate would
 *      have no real product page and the card would honest-skip forever
 *      (hole ①). A TERMINAL or AMBIGUOUS surface is NOT required to declare a
 *      url — it rides the terminal-capture lane (terminal) or is left to the
 *      runtime FIX-309 gate (ambiguous), so a CLI/TUI/back-end card is never
 *      blocked here for a missing web url.
 */
export function validateStoryVisualEvidence(specText: string): VisualEvidenceVerdict {
  const exemptReason = visualExemptionReason(specText);
  const declares = declaresDeliverableUrl(specText);
  const surface = visualSurface(specText);
  const hasAc = surface !== "none";

  if (exemptReason !== undefined) {
    const missingSubstitute = exemptionSubstituteMissing(specText);
    return {
      ok: true,
      exemptReason,
      declaresDeliverableUrl: declares,
      hasVisualEvidenceAc: hasAc,
      surface,
      ...(missingSubstitute ? { exemptSubstituteMissing: true } : {}),
    };
  }

  if (!hasAc) {
    return {
      ok: false,
      code: "missing-visual-evidence-ac",
      reason:
        "no AC captures a user-visible surface (web/CLI/TUI) and no recorded `screenshot_exempt: <reason>` — every story owes a visual-evidence AC by default; only a recorded exemption opts out",
      declaresDeliverableUrl: declares,
      hasVisualEvidenceAc: hasAc,
      surface,
    };
  }

  if (surface === "web" && !declares) {
    return {
      ok: false,
      code: "web-surface-without-deliverable-url",
      reason:
        "a WEB-surface visual-evidence AC is present but the spec frontmatter declares no `deliverable_url:` (alias `screenshot_url:`) pointing at the real product page — the runtime web gate would have no target to capture and the card would honest-skip forever; a terminal/CLI deliverable does not need a url (it rides the terminal-capture lane)",
      declaresDeliverableUrl: declares,
      hasVisualEvidenceAc: hasAc,
      surface,
    };
  }

  // physical_terminal: validate the parsed spec and its command against the allowlist.
  const physicalError = physicalTerminalParseError(specText);
  if (physicalError !== null) {
    return {
      ok: false,
      code: "physical-terminal-invalid",
      reason: `invalid physical_terminal frontmatter: ${physicalError}`,
      declaresDeliverableUrl: declares,
      hasVisualEvidenceAc: hasAc,
      surface,
    };
  }

  // FIX-383 — validate deliverable_cmd against the SAME allowlist attest uses.
  // A deliverable_cmd that attest would reject must be caught at design time
  // (validate), not left to runtime (attest gate) where it wastes a whole cycle.
  const rawCmds = parseDeliverableCmdsFromSpec(specText);
  const physicalTerminal = physicalTerminalFromSpecText(specText);
  const physicalCmds = physicalTerminal === null ? [] : [physicalTerminal.command];
  const allTerminalCmds = [...rawCmds, ...physicalCmds];
  if (allTerminalCmds.length > 0) {
    const rejected = allTerminalCmds.filter((c) => !allowedDeliverableCmd(c));
    const streaming = allTerminalCmds.filter((c) => isStreamingCommand(c));
    if (rejected.length > 0) {
      const streamingHint =
        streaming.length > 0
          ? "\n  💡 流式命令提示: 检测到 watch/tail -f/stream 类命令 — 这些命令持续输出不会终止,截图机制会挂;请改用 `--once`/快照子模式(渲一帧即退出)再声明,或加 `screenshot_exempt` 走豁免。"
          : "";
      return {
        ok: false,
        code: "deliverable-cmd-rejected",
        reason:
          `deliverable_cmd 非白名单(仅限 roll 只读子命令): ${rejected.join(", ")} — 与 attest 闸同口径,` +
          ` 以下会被运行时拒绝: ${rejected.join(", ")}。` +
          ` 请改用只读 roll 子命令(如 roll status/pulse/cycles/ls),或加 screenshot_exempt 豁免截图。` +
          streamingHint,
        declaresDeliverableUrl: declares,
        hasVisualEvidenceAc: hasAc,
        surface,
        rejectedDeliverableCmds: rejected,
        streamingDeliverableCmds: streaming.length > 0 ? streaming : undefined,
      };
    }
  }

  return { ok: true, declaresDeliverableUrl: declares, hasVisualEvidenceAc: hasAc, surface };
}
