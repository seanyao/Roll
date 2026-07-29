/**
 * roll idea — fast backlog capture (US-PORT-003, TS port).
 *
 * v2 had NO `roll idea` CLI command: capture lived entirely in the roll-idea
 * skill (an agent reading/editing `.roll/backlog.md` with Read/Edit). This port
 * makes capture deterministic and shares the backlog reader/writer with the rest
 * of v3 (与 backlog 存取同源): the CLI adapter reads via `BacklogStore`, computes
 * the next id from the parsed rows, lint-gates the description with the SAME
 * rules as the bash `_backlog_lint` oracle, and appends through the store's
 * optimistic-concurrency atomic write.
 *
 * Pure functions only (no I/O) so they unit-test without files; the adapter in
 * packages/cli wires them to `BacklogStore`.
 */
import { STATUS_MARKER } from "@roll/spec";
import type { BacklogItem } from "./store.js";

/** Classification of a captured line: a defect or a forward-looking idea. */
export type IdeaKind = "bug" | "idea";

/** ID family prefix per kind: bugs → FIX, ideas → IDEA. */
export type IdeaPrefix = "FIX" | "IDEA";

/**
 * English defect vocabulary. Matched with letter boundaries (so "error" does
 * not fire on "terror", nor "broken" on "unbroken") — see {@link classifyIdea}.
 * DELIBERATE divergence from the roll-idea skill's loose "也要/没/不" heuristic:
 * those bare characters are far too noisy for a deterministic classifier (they
 * appear in ordinary feature requests), so v3 keys on bug-signal words instead.
 */
const BUG_SIGNALS_EN: readonly string[] = [
  "bug",
  "broken",
  "breaks",
  "crash",
  "error",
  "fails",
  "failing",
  "regression",
  "doesn't",
  "does not",
  "can't",
  "cannot",
  "not working",
  "wrong",
  "incorrect",
  "exception",
  "throws",
  "hangs",
  "leak",
  "stale",
];

/** Chinese defect vocabulary. Matched as substrings (CJK has no word
 *  boundaries), scanned regardless of the output locale (users type either). */
const BUG_SIGNALS_ZH: readonly string[] = [
  "报错",
  "错误",
  "崩溃",
  "失败",
  "挂了",
  "异常",
  "卡死",
  "不工作",
  "无法",
  "修复",
  "回归",
  "坏了",
  "丢失",
  "泄漏",
  "不对",
];

/** Classify a capture as `bug` (defect signals present) or `idea` (otherwise).
 *  English signals match on letter boundaries to avoid false positives like
 *  "terror" → error; Chinese signals match as substrings. */
export function classifyIdea(text: string): IdeaKind {
  const lower = text.toLowerCase();
  for (const sig of BUG_SIGNALS_ZH) {
    if (lower.includes(sig)) return "bug";
  }
  for (const sig of BUG_SIGNALS_EN) {
    const escaped = sig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![a-z])${escaped}(?![a-z])`).test(lower)) return "bug";
  }
  return "idea";
}

/** The ID family prefix for a kind. */
export function prefixForKind(kind: IdeaKind): IdeaPrefix {
  return kind === "bug" ? "FIX" : "IDEA";
}

/**
 * Next id in a family: max numeric suffix among existing `<prefix>-NNN…` ids
 * plus one, zero-padded to three digits. A trailing non-numeric suffix (e.g.
 * `FIX-150b`) contributes its leading integer (150). No matching rows → `001`.
 */
export function nextIdeaId(items: readonly BacklogItem[], prefix: IdeaPrefix): string {
  const re = new RegExp(`^${prefix}-(\\d+)`);
  let max = 0;
  for (const it of items) {
    const m = re.exec(it.id);
    if (m === null) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

const FILENAME_RE = /[A-Za-z_][A-Za-z0-9_.-]*\.(sh|bash|yaml|yml|json|js|ts|tsx|py|rb|go|rs|c|cpp|h)\b/;
const PATH_RE = /[A-Za-z_][A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]+/;
const FUNCTION_RE = /(?:\b_[a-zA-Z][a-zA-Z0-9_]+\b|\b[A-Za-z_][A-Za-z0-9_]+\(\))/;
const ID_PREFIX_RE = /^\[[A-Z]+-[0-9]+\]\([^)]*\)\s*|^[A-Z]+-[0-9]+\s*/;

/**
 * Lint a capture description with the SAME category checks as the bash oracle
 * `_backlog_lint` (bin/roll ~14418-14510). Returns the violated category tags
 * (`length` / `code-fence` / `filename` / `path` / `function`); an empty array
 * means the description is clean. A leading `[ID](url)` or bare `ID ` prefix is
 * stripped first (structural, not prose), exactly as the oracle does.
 */
export function lintIdeaDescription(desc: string): string[] {
  const body = desc.replace(ID_PREFIX_RE, "");
  const issues: string[] = [];
  if (body.length > 120) issues.push("length");
  if (body.includes("`")) issues.push("code-fence");
  if (FILENAME_RE.test(body)) issues.push("filename");
  if (PATH_RE.test(body)) issues.push("path");
  if (FUNCTION_RE.test(body)) issues.push("function");
  return issues;
}

/** A capture plan: the classification, assigned id, and any lint violations. */
export interface IdeaPlan {
  kind: IdeaKind;
  prefix: IdeaPrefix;
  id: string;
  violations: string[];
}

/**
 * REFACTOR-050: lightweight epic inference from the description text.
 * Matches short keyword → known epic slug; returns undefined when no
 * signal is found (caller falls back to the default/"uncategorized" bucket
 * or interactive confirmation at the CLI layer).
 *
 * The mapping is intentionally small and conservative — a "loader" rather
 * than a classifier. Add pairs as the project's epic set grows.
 */
export function inferEpic(text: string): string | undefined {
  const lower = text.toLowerCase();
  const KW = [
    [/\bcli\b|\bcommand\b|\bflag\b|\busage\b/, "cli-simplification"],
    [/\blog\b|\bloop\b|auto(?:matic)?\b|\bcycle\b|\brunner\b|\bdispatch/, "loop-engine"],
    [/\bskill\b|\bagent\b.*\bskill\b|\bskill\b.*\bagent\b/, "skill-ecosystem"],
    [/\bdossier\b|\bindex\b|\bpage\b|\breport\b|\bdelivery dossier/, "delivery-dossier"],
    [/\bevidence\b|\battest\b|\bacceptance\b|\bverify/, "acceptance-evidence"],
    [/\bdoc\b|\bguide\b|\breadme\b|\btutorial\b|\bgetting.?started/, "documentation"],
    [/\brelease\b|\bdeploy\b|\bship\b|\bpublish\b|\bversion/, "release-management"],
    [/\bbuild\b|\bbundle\b|\bcompile\b|\btypescript\b|\bproject/, "bash-endgame"],
    [/\bpair\b|\bcross.?agent\b|\breview\b|\bpeer\b/, "cross-agent-pairing"],
    [/\bbacklog\b|\bcard\b|\bstory\b.*(?:create|new|lifecycle)/, "backlog-lifecycle"],
    [/\bengineer(?:ing)?\b|\binfra\b|\bci\b|\bgithub\b.*action/, "engineering-infrastructure"],
  ] as const;
  for (const [re, slug] of KW) {
    if (re.test(lower)) return slug;
  }
  return undefined;
}

/** Compose classify → next-id → lint into a single plan over the parsed rows. */
export function planIdea(items: readonly BacklogItem[], text: string): IdeaPlan {
  const kind = classifyIdea(text);
  const prefix = prefixForKind(kind);
  return {
    kind,
    prefix,
    id: nextIdeaId(items, prefix),
    violations: lintIdeaDescription(text),
  };
}

/** Section heading per kind (markdown; structural, not localized). */
export const IDEA_SECTIONS: Record<IdeaKind, string> = {
  bug: "## 🐛 Bug Fixes",
  idea: "## 💡 Ideas",
};

const TABLE_HEADER = "| ID | Description | Status |";
const TABLE_SEPARATOR = "|----|-------------|--------|";

function sectionMatcher(kind: IdeaKind): RegExp {
  return kind === "bug" ? /^##\s.*Bug Fixes/i : /^##\s.*Ideas/i;
}

/** Outcome of an append: the rewritten content and the section it landed in. */
export interface AppendResult {
  content: string;
  section: string;
}

/**
 * Append a capture row `| <id> | <desc> | 📋 Todo |` to the kind's section.
 * If the section exists, the row goes after the last table row in it; if the
 * section has a heading but no table yet, a header+separator+row is added; if
 * the section is absent, a fresh section block is appended at end of file.
 * Pure: returns new content, never touches disk.
 */
export function appendIdea(
  content: string,
  id: string,
  kind: IdeaKind,
  desc: string,
  options: { readonly epic?: string; readonly linkPrefix?: string } = {},
): AppendResult {
  const label = options.linkPrefix === undefined || options.epic === undefined
    ? id
    : `[${id}](${options.linkPrefix}/${options.epic}/${id}/spec.md)`;
  const row = `| ${label} | ${desc} | ${STATUS_MARKER.todo} |`;
  const heading = IDEA_SECTIONS[kind];
  const lines = content.split("\n");
  const matcher = sectionMatcher(kind);

  const h = lines.findIndex((l) => matcher.test(l));
  if (h === -1) {
    // No section yet — append a fresh block at end of file.
    const out = [...lines];
    // Drop a single trailing empty line so we don't accumulate blank gaps,
    // then re-add exactly one blank separator before the new section.
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push("", heading, "", TABLE_HEADER, TABLE_SEPARATOR, row, "");
    return { content: out.join("\n"), section: heading };
  }

  // Section exists: find its region (up to the next `#`/`##` heading or EOF).
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  // Last table row in the region (a `|`-led line).
  let lastTable = -1;
  for (let i = h + 1; i < end; i++) {
    if ((lines[i] ?? "").startsWith("|")) lastTable = i;
  }
  const out = [...lines];
  if (lastTable !== -1) {
    out.splice(lastTable + 1, 0, row);
  } else {
    // Heading present but no table — insert a fresh table right after heading,
    // with a trailing blank so the row never abuts a following heading.
    out.splice(h + 1, 0, "", TABLE_HEADER, TABLE_SEPARATOR, row, "");
  }
  return { content: out.join("\n"), section: heading };
}
