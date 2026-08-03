/**
 * `roll backlog sync` — pure GitHub-issues→backlog mapping core (US-PORT-019
 * port of lib/github_sync.py, US-SYNC-001..006). Single direction: GitHub
 * issues become `.roll/backlog.md` rows + feature-stub AC.
 *
 * Everything here is pure (string/data in, string/data out) so it is testable
 * without the network. The HTTP fetch, token resolution, and file writes live
 * in the CLI command (packages/cli/src/commands/backlog-sync.ts).
 */
import { STATUS_MARKER } from "@roll/spec";

/** A GitHub issue, as the REST API returns it (only the fields we read). */
export interface GhIssue {
  number?: number;
  title?: string;
  state?: string;
  body?: string | null;
  labels?: Array<{ name?: string } | string>;
  /** Present iff the "issue" is actually a PR (the issues endpoint includes them). */
  pull_request?: unknown;
}

// label → backlog type. First matching label (case-insensitive) wins; no match → US.
const LABEL_TYPE_MAP: Record<string, string> = {
  bug: "FIX",
  enhancement: "US",
  feature: "US",
  us: "US",
  refactor: "REFACTOR",
};
export const DEFAULT_TYPE = "US";

// Single-source markers (FIX-300): consume @roll/spec, never re-spell a literal.
export const DEFAULT_STATUS = STATUS_MARKER.todo;

function labelName(label: { name?: string } | string): string {
  return typeof label === "string" ? label : (label.name ?? "");
}

/** Map an issue's labels to a backlog type prefix (first known label wins). */
export function mapLabelToType(labels: GhIssue["labels"]): string {
  for (const label of labels ?? []) {
    const key = labelName(label).trim().toLowerCase();
    if (key in LABEL_TYPE_MAP) return LABEL_TYPE_MAP[key]!;
  }
  return DEFAULT_TYPE;
}

/** External Issue state never decides planning completion. */
export function mapStateToStatus(_state: string | undefined): string {
  return DEFAULT_STATUS;
}

/** Canonical, type-independent GitHub id token, e.g. `GH-13` (idempotency key). */
export function ghId(issue: GhIssue): string {
  return `GH-${issue.number}`;
}

/** Canonical planning identity for an imported GitHub issue. */
export function storyIdFromIssue(issue: GhIssue): string {
  return `${mapLabelToType(issue.labels)}-${ghId(issue)}`;
}

/** Render one issue as a backlog table row `| <TYPE>-GH-<n> | <title> | <status> |`. */
export function issueToRow(issue: GhIssue, epic = "backlog-lifecycle"): string {
  const title = (issue.title ?? "").trim();
  const storyId = storyIdFromIssue(issue);
  const status = mapStateToStatus(issue.state);
  return `| [${storyId}](${epic}/${storyId}/spec.md) | ${title} | ${status} |`;
}

/**
 * Append `rows` after the last body row of the FIRST markdown table in
 * `content` (the table = the run of `|` lines after the `|---|` separator).
 * No table → append at the end. Mirrors `_append_rows_to_table`.
 */
export function appendRowsToTable(content: string, rows: string[]): string {
  if (rows.length === 0) return content;
  const lines = content.split("\n");
  let sepIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const stripped = (lines[i] ?? "").trim();
    if (stripped.startsWith("|") && /^[|\-: ]+$/.test(stripped)) {
      sepIdx = i;
      break;
    }
  }
  if (sepIdx === -1) {
    const tail = rows.join("\n");
    if (content !== "" && !content.endsWith("\n")) return `${content}\n${tail}\n`;
    return `${content}${tail}\n`;
  }
  let insertAt = sepIdx + 1;
  while (insertAt < lines.length && (lines[insertAt] ?? "").trim().startsWith("|")) insertAt++;
  const next = [...lines.slice(0, insertAt), ...rows, ...lines.slice(insertAt)];
  return next.join("\n");
}

/**
 * True iff `content` already carries the `GH-<n>` id token (so `GH-1` does not
 * match `GH-13`). Mirrors `_gh_id_present`'s boundary regex.
 */
export function ghIdPresent(content: string, ident: string): boolean {
  const esc = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![0-9A-Za-z])${esc}(?![0-9A-Za-z-])`).test(content);
}

/** Recover the durable planning ID already bound to this external Issue. */
export function existingStoryIdForIssue(content: string, issue: GhIssue): string | undefined {
  const externalId = ghId(issue);
  for (const line of content.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const idCell = line.split("|")[1]?.trim() ?? "";
    if (!ghIdPresent(idCell, externalId)) continue;
    const linked = /^\[([^\]]+)\]/.exec(idCell)?.[1];
    const candidate = linked ?? idCell;
    if (/^[A-Z]+-GH-[0-9]+$/.test(candidate)) return candidate;
  }
  return undefined;
}

/** Parse a `--label` value (comma-separated) into a normalized, deduped list. */
export function parseLabelsFilter(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const tok of value.split(",")) {
    const key = tok.trim().toLowerCase();
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** True iff `issue` carries any `wanted` label (OR); empty `wanted` matches all. */
export function issueHasLabel(issue: GhIssue, wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  const have = new Set<string>();
  for (const label of issue.labels ?? []) {
    const key = labelName(label).trim().toLowerCase();
    if (key) have.add(key);
  }
  return wanted.some((w) => have.has(w));
}

/** Keep only issues matching any `wanted` label (US-SYNC-005). */
export function filterIssuesByLabel(issues: GhIssue[], wanted: string[]): GhIssue[] {
  if (wanted.length === 0) return [...issues];
  return issues.filter((i) => issueHasLabel(i, wanted));
}

const TOP_LEVEL_CHECKBOX = /^[-*] \[([ xX])\] (.+?)\s*$/;

/** Top-level `- [ ]` / `* [ ]` checkbox texts from an issue body (no nested). */
export function extractAcItems(body: string | null | undefined): string[] {
  if (!body) return [];
  const items: string[] = [];
  for (const raw of body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (raw[0] === " " || raw[0] === "\t") continue; // nested → skip
    const m = TOP_LEVEL_CHECKBOX.exec(raw);
    if (m) items.push((m[2] ?? "").trim());
  }
  return items;
}

/** AC section body for a feature stub: each top-level checkbox → `- [ ] <it>`. */
export function renderAcSection(issue: GhIssue): string {
  return extractAcItems(issue.body)
    .map((it) => `- [ ] ${it}`)
    .join("\n");
}

/** The body of a fresh feature stub for an issue (heading + AC). */
export function featureStubContent(issue: GhIssue): string {
  const ident = storyIdFromIssue(issue);
  const title = (issue.title ?? "").trim();
  const typePrefix = mapLabelToType(issue.labels);
  const ac = renderAcSection(issue);
  const parts = [
    `# ${ident} ${title}`.trimEnd(),
    "",
    `> Synced from GitHub issue #${issue.number} (${typePrefix}).`,
    "",
    "## AC",
    "",
  ];
  let stub = parts.join("\n");
  if (ac) stub += ac + "\n";
  return stub;
}

/** `--dry-run` preview line for one issue (US-SYNC-004). */
export function dryRunLine(issue: GhIssue, skipped: boolean, existingStoryId?: string): string {
  const ident = existingStoryId ?? storyIdFromIssue(issue);
  const typePrefix = existingStoryId?.split("-GH-", 1)[0] ?? mapLabelToType(issue.labels);
  if (skipped) return `= ${ident} [${typePrefix}] (skipped, already exists)`;
  return `+ ${ident} [${typePrefix}] ${(issue.title ?? "").trim()}`;
}

export interface SyncPreview {
  added: number;
  skipped: number;
  total: number;
  lines: string[];
}

/** Compute the sync diff over `content` WITHOUT mutating it (dry-run). */
export function dryRunPreview(issues: GhIssue[], content: string): SyncPreview {
  const lines: string[] = [];
  let added = 0;
  let skipped = 0;
  for (const issue of issues) {
    const existingStoryId = existingStoryIdForIssue(content, issue);
    const isSkip = existingStoryId !== undefined;
    if (isSkip) skipped++;
    else added++;
    lines.push(dryRunLine(issue, isSkip, existingStoryId));
  }
  return { added, skipped, total: issues.length, lines };
}

export interface SyncResult {
  /** Backlog content with the new rows appended. */
  content: string;
  added: number;
  skipped: number;
  total: number;
  rows: string[];
  skippedIds: string[];
}

/** Pure: compute new rows + the updated backlog content (idempotent by GH id). */
export function syncToBacklog(issues: GhIssue[], content: string): SyncResult {
  const rows: string[] = [];
  const skippedIds: string[] = [];
  for (const issue of issues) {
    const existingStoryId = existingStoryIdForIssue(content, issue);
    if (existingStoryId !== undefined) skippedIds.push(existingStoryId);
    else rows.push(issueToRow(issue));
  }
  return {
    content: appendRowsToTable(content, rows),
    added: rows.length,
    skipped: skippedIds.length,
    total: issues.length,
    rows,
    skippedIds,
  };
}

/** Parse a GitHub `Link` header into a {rel: url} map. */
export function parseLinkHeader(value: string | undefined): Record<string, string> {
  const rels: Record<string, string> = {};
  if (!value) return rels;
  for (const part of value.split(",")) {
    const segs = part.split(";");
    if (segs.length < 2) continue;
    const url = (segs[0] ?? "").trim().replace(/^</, "").replace(/>$/, "");
    for (const segRaw of segs.slice(1)) {
      const seg = segRaw.trim();
      if (seg.startsWith("rel=")) {
        rels[seg.slice("rel=".length).trim().replace(/^"|"$/g, "")] = url;
      }
    }
  }
  return rels;
}

// ─── sync config block in .roll/local.yaml (US-SYNC-006) ──────────────────────

export const SYNC_CONFIG_KEY = "backlog_sync";
export const DEFAULT_SYNC_DIRECTION = "issues-to-backlog";

export interface SyncConfig {
  repo?: string;
  direction?: string;
  labels?: string[];
  last_sync_at?: string;
  on_loop_cycle?: string;
}

function parseInlineList(raw: string): string[] {
  const v = raw.trim();
  if (!v || v === "[]") return [];
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
      .filter((t) => t !== "");
  }
  return [v.replace(/^['"]|['"]$/g, "")];
}

/** Read the `backlog_sync:` block from local.yaml text (line-based, no parser). */
export function readSyncConfig(text: string): SyncConfig {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (
      (line.trimEnd() === `${SYNC_CONFIG_KEY}:` || line.startsWith(`${SYNC_CONFIG_KEY}:`)) &&
      line[0] !== " " &&
      line[0] !== "\t"
    ) {
      start = i;
      break;
    }
  }
  if (start === -1) return {};
  const cfg: SyncConfig = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (line[0] !== " " && line[0] !== "\t") break; // next top-level key ends block
    const m = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let raw = (m[2] ?? "").trim();
    if (key === "labels") {
      cfg.labels = parseInlineList(raw);
    } else {
      if (raw.length >= 2 && (raw[0] === "'" || raw[0] === '"') && raw[raw.length - 1] === raw[0]) {
        raw = raw.slice(1, -1);
      }
      (cfg as Record<string, unknown>)[key] = raw;
    }
  }
  return cfg;
}

/** Render the `backlog_sync:` YAML block (no trailing newline). */
export function renderSyncBlock(
  repo: string,
  labels: string[],
  lastSyncAt: string,
  direction: string = DEFAULT_SYNC_DIRECTION,
): string {
  const labelsLit = labels.length ? `[${labels.join(", ")}]` : "[]";
  return (
    `${SYNC_CONFIG_KEY}:\n` +
    `  repo: ${repo}\n` +
    `  direction: ${direction}\n` +
    `  labels: ${labelsLit}\n` +
    `  last_sync_at: ${lastSyncAt}`
  );
}

/** Replace (or append) the `backlog_sync:` block in local.yaml text. */
export function writeSyncBlock(original: string, block: string): string {
  const text = original.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (
      (line.trimEnd() === `${SYNC_CONFIG_KEY}:` || line.startsWith(`${SYNC_CONFIG_KEY}:`)) &&
      line[0] !== " " &&
      line[0] !== "\t"
    ) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    const sep = text.endsWith("\n\n") || text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${sep}${block}\n`;
  }
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() !== "" && line[0] !== " " && line[0] !== "\t") break;
    end++;
  }
  const next = [...lines.slice(0, start), ...block.split("\n"), ...lines.slice(end)];
  let out = next.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}
