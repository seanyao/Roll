/**
 * @responsibility Projects policy decisions into locale-aware language surfaces.
 * US-LANG-002 — language surface policy and mechanical audit.
 *
 * Pure rules: given a file path and its text, decide which
 * {@link LanguageSurfacePolicy} applies and emit findings when rendered output
 * mixes languages outside the allowed foreign-token carve-outs.
 *
 * The audit is intentionally conservative / shadow-only: it reports drift so
 * humans can fix it, not gate releases autonomously.
 */

export type LanguageSurfaceKind =
  | "agent_contract"
  | "owner_conversation"
  | "cli_output"
  | "html_projection"
  | "docs_page"
  | "backlog_spec"
  | "release_note"
  | "code_comment";

export type RenderLanguage = "en" | "zh" | "user";

export interface LanguageSurfacePolicy {
  readonly kind: LanguageSurfaceKind;
  readonly audience: "agent" | "owner" | "end_user" | "maintainer";
  readonly sourceOfTruth: "contract" | "locale" | "user_message" | "project_primary_language";
  readonly renderLanguage: RenderLanguage;
  readonly resourceMode: "single_source" | "parallel_locale_files" | "catalog_keys";
  readonly mixedLanguageAllowed: boolean;
  readonly allowedForeignTokens: readonly string[];
  readonly enforcement: "lint" | "snapshot" | "doctor" | "review";
}

export interface LanguageAuditFinding {
  readonly path: string;
  readonly line: number;
  readonly severity: "warn" | "fail";
  readonly surface: LanguageSurfaceKind;
  readonly message: string;
}

const CJK_RE = /[\u4e00-\u9fff]/;
const EN_WORD_RE = /[A-Za-z]{2,}/;

function policyBase(
  kind: LanguageSurfaceKind,
  renderLanguage: RenderLanguage,
): LanguageSurfacePolicy {
  return {
    kind,
    audience: kind === "agent_contract" ? "agent" : kind === "backlog_spec" ? "maintainer" : "end_user",
    sourceOfTruth:
      kind === "agent_contract"
        ? "contract"
        : kind === "backlog_spec"
          ? "project_primary_language"
          : "locale",
    renderLanguage,
    resourceMode: kind === "docs_page" ? "parallel_locale_files" : "single_source",
    mixedLanguageAllowed: false,
    allowedForeignTokens: [],
    enforcement: "doctor",
  };
}

function docsPageLang(path: string): RenderLanguage {
  if (/(^|\/)guide\/en\//.test(path)) return "en";
  if (/(^|\/)guide\/zh\//.test(path)) return "zh";
  return "en";
}

/**
 * Map a path to its governing {@link LanguageSurfacePolicy}.
 *
 * The caller may override the inferred surface via `hint`; this is useful when
 * the same physical file is being audited under a different lens (e.g. a CLI
 * snapshot treated as `cli_output`).
 */
export function resolveLanguageSurfacePolicy(
  path: string,
  hint?: LanguageSurfaceKind,
): LanguageSurfacePolicy {
  const norm = path.replace(/\\/g, "/");
  if (hint !== undefined) {
    const base = policyBase(hint, hint === "docs_page" ? docsPageLang(norm) : "en");
    return base;
  }
  if (/(^|\/)guide\//.test(norm)) return policyBase("docs_page", docsPageLang(norm));
  if (/(^|\/)skills\//.test(norm)) return policyBase("agent_contract", "en");
  if (/(^|\/)conventions\//.test(norm)) return policyBase("agent_contract", "en");
  if (/(^|\/)roll\.md$/.test(norm) || /(^|\/)AGENTS\.md$/.test(norm)) {
    return policyBase("backlog_spec", "zh");
  }
  if (/(^|\/)\.roll\/features\//.test(norm) || /(^|\/)archive\//.test(norm)) {
    return policyBase("backlog_spec", "zh");
  }
  return policyBase("owner_conversation", "user");
}

/** True when the line contains a CJK character. */
function hasCjk(line: string): boolean {
  return CJK_RE.test(line);
}

/** True when the line contains an English word (>=2 letters). */
function hasEnWord(line: string): boolean {
  return EN_WORD_RE.test(line);
}

/**
 * Strip the foreign-token carve-outs so the remaining text is what a reader
 * would actually perceive as mixed-language prose.
 *
 * Allowed tokens include:
 *   - inline code / quoted user input
 *   - command names (`roll doctor`, `roll design`, ...)
 *   - agent/model names
 *   - file paths and package names (tokens containing `/` or `@roll/`)
 *   - CamelCase / UPPER_SNAKE identifiers (type names, enum literals)
 */
function scrubAllowedTokens(line: string): string {
  return (
    line
      // inline / fenced code fragments
      .replace(/`[^`]*`/g, " ")
      // quoted user input
      .replace(/"[^"]*"/g, " ")
      .replace(/'[^']*'/g, " ")
      // markdown links: keep only the link text? no — the URL is allowed, text may be prose.
      // We remove the URL portion; the bracket text stays for inspection.
      .replace(/\]\([^)]+\)/g, " ")
      // URLs
      .replace(/https?:\/\/\S+/g, " ")
      // command names
      .replace(/\broll\s+[a-z][a-z0-9-]*\b/gi, " ")
      // agent / model names
      .replace(
        /\b(?:claude|kimi|codex|pi|agy|reasonix|cursor|gpt|o1|openai|deepseek|qwen|llama)\b/gi,
        " ",
      )
      // file paths and scoped package names
      .replace(/\b[\w@./-]*\/[\w@./-]+\b/g, " ")
      // type / enum identifiers: CamelCase, PascalCase, UPPER_SNAKE
      .replace(/\b[A-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g, " ")
      .replace(/\b[A-Z][A-Z0-9_]+\b/g, " ")
  );
}

type LineLanguage = "en" | "zh" | "mixed" | "none";

function classifyLine(line: string): LineLanguage {
  const scrubbed = scrubAllowedTokens(line);
  const cjk = hasCjk(scrubbed);
  const en = hasEnWord(scrubbed);
  if (cjk && en) return "mixed";
  if (cjk) return "zh";
  if (en) return "en";
  return "none";
}

function isCodeBlockFence(line: string): boolean {
  return /^\s*```/.test(line);
}

function pushFinding(
  findings: LanguageAuditFinding[],
  path: string,
  lineNo: number,
  surface: LanguageSurfaceKind,
  message: string,
  severity: "warn" | "fail" = "warn",
): void {
  findings.push({ path, line: lineNo, severity, surface, message });
}

/**
 * Audit a single file's text against the surface policy inferred from `path`.
 *
 * Skips fenced code blocks. Reports:
 *   - inline mixed language outside allowed tokens
 *   - adjacent lines that flip between English and Chinese prose
 */
export function auditLanguageSurfaceText(path: string, text: string): readonly LanguageAuditFinding[] {
  const policy = resolveLanguageSurfacePolicy(path);
  if (policy.mixedLanguageAllowed || policy.renderLanguage === "user") return [];

  const findings: LanguageAuditFinding[] = [];
  const lines = text.split("\n");
  let inCodeBlock = false;
  const classifications: { lineNo: number; lang: LineLanguage; raw: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (isCodeBlockFence(raw)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    if (raw.trim() === "") continue;

    const lineNo = i + 1;
    const lang = classifyLine(raw);
    classifications.push({ lineNo, lang, raw });

    if (lang === "mixed") {
      const message =
        policy.renderLanguage === "zh"
          ? "English prose in Chinese surface"
          : "Chinese prose in English surface";
      pushFinding(findings, path, lineNo, policy.kind, message, "warn");
      continue;
    }

    // Single-language surfaces: a foreign-primary sentence is a finding.
    if (policy.renderLanguage === "zh" && lang === "en") {
      pushFinding(findings, path, lineNo, policy.kind, "English prose in Chinese surface", "warn");
    } else if (policy.renderLanguage === "en" && lang === "zh") {
      pushFinding(findings, path, lineNo, policy.kind, "Chinese prose in English surface", "warn");
    }
  }

  // Adjacent bilingual lines — the old "English and Chinese on separate lines" rule.
  for (let i = 1; i < classifications.length; i++) {
    const prev = classifications[i - 1];
    const cur = classifications[i];
    if (prev === undefined || cur === undefined) continue;
    if (prev.lang === "en" && cur.lang === "zh") {
      pushFinding(findings, path, cur.lineNo, policy.kind, "Bilingual adjacent lines", "warn");
    } else if (prev.lang === "zh" && cur.lang === "en") {
      pushFinding(findings, path, cur.lineNo, policy.kind, "Bilingual adjacent lines", "warn");
    }
  }

  return findings;
}

/** Throw when `output` contains characters from a language other than `lang`. */
export function assertSingleLanguageOutput(output: string, lang: "en" | "zh"): void {
  if (lang === "en" && hasCjk(output)) {
    throw new Error("Output contains Chinese characters in an English locale");
  }
  if (lang === "zh" && hasEnWord(output)) {
    throw new Error("Output contains English words in a Chinese locale");
  }
}

/** Render a locale pair as a single-language string. */
export function renderLocalePair(pair: { en: string; zh: string }, lang: "en" | "zh"): string {
  return lang === "zh" ? pair.zh : pair.en;
}
