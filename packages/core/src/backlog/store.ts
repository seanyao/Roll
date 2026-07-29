/**
 * BacklogStore — TS port of the v2 backlog read/mark path.
 *
 * v2 oracle (frozen bash, /bin/roll):
 *   - `_backlog_set_status pattern new_status` (lines ~14006-14029): the python
 *     heredoc that rewrites the Status cell of every matching table row and
 *     prints the count.
 *   - row shape `| id | desc | ... | status |` recognised by `line.startswith('|')`
 *     and `line.count('|') >= 4`; the id cell is `parts[1]` with the markdown
 *     link stripped (`[X](url)` → `X`); the status cell is the SECOND-TO-LAST
 *     field (`parts[-2]`), rewritten as ` <new_status> `.
 *
 * Parse model mirrors packages/cli/src/commands/backlog.ts (linked or bare IDs,
 * the `(US|FIX|REFACTOR|IDEA)-` family filter).
 *
 * DELIBERATE v3 DIVERGENCE from the bash oracle (FIX-106 hardening):
 *   bash matches with `pattern.upper() in id_field.upper()` — a plain
 *   case-insensitive SUBSTRING test, so `US-LOOP-01` wrongly matches
 *   `US-LOOP-019`. The v3 contract requires ID-token-anchored matching: a row
 *   matches iff its bare id equals the pattern OR begins with the pattern
 *   followed by a token boundary (`-`). Thus `US-LOOP-01` matches `US-LOOP-01`
 *   and `US-LOOP-01-a` but never `US-LOOP-019`. A `depends-on:US-X` token living
 *   inside the Description cell is never consulted (only the id cell is).
 *
 * NEW v3 contract (invariant I9 — optimistic concurrency, no bash oracle):
 *   `readBacklog` returns content + its sha256; `writeBacklog` re-reads, compares
 *   the hash, throws {@link ConflictError} on mismatch, else writes atomically
 *   (tmp-file + rename) via the injected {@link FileStore}.
 */
import { createHash } from "node:crypto";
import { STATUS_MARKER } from "@roll/spec";
import { type FileStore, nodeFileStore } from "./infra-default.js";

/** A parsed backlog table row. */
export interface BacklogItem {
  /** Bare id with any `[X](url)` markdown link stripped, trimmed. */
  id: string;
  /** Raw description cell, trimmed. */
  desc: string;
  /** Raw status cell, trimmed (e.g. `📋 Todo`, `✅ Done`, `🔒 Blocked [reason]`). */
  status: string;
}

/** Snapshot returned by {@link BacklogStore.readBacklog}. */
export interface BacklogSnapshot {
  /** Full file content, verbatim. */
  content: string;
  /** sha256 hex of `content` — the optimistic-concurrency token. */
  hash: string;
  /** Parsed table rows. */
  items: BacklogItem[];
}

/** Thrown by {@link BacklogStore.writeBacklog} when the file changed underfoot. */
export class ConflictError extends Error {
  constructor(
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(
      `backlog changed on disk (expected sha256 ${expectedHash.slice(0, 12)}…, ` +
        `found ${actualHash.slice(0, 12)}…)`,
    );
    this.name = "ConflictError";
  }
}

/** Outcome of a mark operation. */
export interface MarkResult {
  /** Rewritten file content. */
  content: string;
  /** Number of rows whose status was changed (mirrors bash `print(count)`). */
  count: number;
}

const ID_LINK_RE = /\[([^\]]+)\]\([^)]+\)/;
const ID_FAMILY_RE = /^(US|FIX|REFACTOR|IDEA)-/;

/** Strip a `[X](url)` markdown link to its bare label; pass through otherwise. */
function stripLink(cell: string): string {
  const m = ID_LINK_RE.exec(cell);
  return (m !== null ? (m[1] ?? cell) : cell).trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * ID-token-anchored match (FIX-106 safe). Case-insensitive, like the oracle,
 * but anchored so a pattern only matches a whole id or an id whose remainder
 * starts at a `-` boundary.
 */
export function idMatchesPattern(id: string, pattern: string): boolean {
  const a = id.toUpperCase();
  const b = pattern.toUpperCase();
  if (a === b) return true;
  return a.startsWith(`${b}-`);
}

/**
 * Parse backlog text into rows. Mirrors the bash/CLI recognition: a line that
 * starts with `|` and has at least 4 pipes, whose id cell (after link-strip)
 * belongs to the `US|FIX|REFACTOR|IDEA` family.
 */
export function parseBacklog(content: string): BacklogItem[] {
  const items: BacklogItem[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("|")) continue;
    const parts = line.split("|");
    // bash gate: at least 4 '|' chars → parts.length >= 5.
    if (parts.length < 5) continue;
    const id = stripLink((parts[1] ?? "").trim());
    if (!ID_FAMILY_RE.test(id)) continue;
    const desc = (parts[2] ?? "").trim();
    // Status is the second-to-last field (bash `parts[-2]`), trimmed.
    const status = (parts[parts.length - 2] ?? "").trim();
    items.push({ id, desc, status });
  }
  return items;
}

/**
 * Pure marking core: rewrite the Status cell (`parts[-2]` → ` <newStatus> `) of
 * every row whose id matches `pattern` (ID-token-anchored). Returns the new
 * content and the count of rewritten rows. Line endings are preserved verbatim.
 */
/**
 * FIX-250 — append a freshly minted card's row. Placement: after the LAST row
 * already linking `features/<epic>/` (the card's siblings); when the epic has
 * no rows yet, after the last table row in the file. Returns the new content
 * and whether a row was appended (an existing row for the id is a no-op so the
 * command is idempotent).
 *
 * US-AGENT-042 — optional `dependsOn` / `chainDepth` are appended to the
 * Description cell as the same `depends-on:a,b` / `chain_depth:N` tags the
 * picker and self-downgrade cap read back (consistent with `est_min:`). Omitting
 * them yields the original bare-title row byte-for-byte (existing callers
 * unchanged). A self-downgrade child carries the parent's ORIGINAL inbound deps
 * here — never the parked parent — so the picker can take it next cycle.
 */
export function appendBacklogRow(
  content: string,
  row: { id: string; title: string; epic: string; dependsOn?: string[]; chainDepth?: number },
): { content: string; appended: boolean } {
  // FIX-1475: de-dup by an EXACT id-cell match, not `content.includes("| [id]")`.
  // The substring form falsely treated ANOTHER row whose description opens with a
  // link to `[<id>](...)` as an already-existing card, silently dropping the
  // append (create / self-downgrade).
  const alreadyPresent = content.split("\n").some((l) => {
    if (!l.startsWith("|")) return false;
    const cell = (l.split("|")[1] ?? "").trim();
    const id = cell.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").trim();
    return id === row.id;
  });
  if (alreadyPresent) return { content, appended: false };
  const tags = [
    row.chainDepth !== undefined && row.chainDepth > 0 ? `chain_depth:${row.chainDepth}` : "",
    row.dependsOn !== undefined && row.dependsOn.length > 0 ? `depends-on:${row.dependsOn.join(",")}` : "",
  ].filter((t) => t !== "");
  const desc = tags.length > 0 ? `${row.title} ${tags.join(" ")}` : row.title;
  const line = `| [${row.id}](.roll/features/${row.epic}/${row.id}/spec.md) | ${desc} | ${STATUS_MARKER.todo} |`;
  const lines = content.split("\n");
  let anchor = -1;
  let lastTableRow = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (!l.startsWith("| [")) continue;
    lastTableRow = i;
    if (l.includes(`features/${row.epic}/`)) anchor = i;
  }
  const at = anchor !== -1 ? anchor : lastTableRow;
  if (at === -1) {
    // no tables at all — append a minimal section at the end.
    const tail = `\n## Epic: ${row.epic}\n\n| ID | Description | Status |\n|----|----|----|\n${line}\n`;
    return { content: content.replace(/\n*$/, "\n") + tail, appended: true };
  }
  lines.splice(at + 1, 0, line);
  return { content: lines.join("\n"), appended: true };
}

/**
 * Extract trailing annotation from a Done status cell.
 * Returns the annotation text (trimmed) or undefined.
 *
 * Examples:
 *   "✅ Done (PR#1238 · merged abc123)" → "(PR#1238 · merged abc123)"
 *   "✅ Done · evidence_debt"          → "· evidence_debt"
 *   "✅ Done"                          → undefined
 *   "🔨 In Progress"                   → undefined
 */
export function extractAnnotation(cell: string): string | undefined {
  const canonical = cell.match(/^✅\s*Done\s+(.+)$/);
  if (canonical?.[1]?.trim()) return canonical[1].trim();
  const legacy = cell.match(/^✔️\s*Done\s+(.+)$/);
  if (legacy?.[1]?.trim()) return legacy[1].trim();
  return undefined;
}

/**
 * Rewrite the Status cell of every row whose id cell satisfies `matches`.
 * Shared core of {@link markStatus} (bash-parity prefix matching) and
 * {@link markStatusExact} (exact-id only).
 */
function markStatusWith(
  content: string,
  matches: (id: string) => boolean,
  newStatus: string,
): MarkResult {
  let count = 0;
  const lines = content.split("\n");
  const out = lines.map((raw) => {
    // Preserve a trailing CR so CRLF files round-trip byte-identically.
    const hasCr = raw.endsWith("\r");
    const line = hasCr ? raw.slice(0, -1) : raw;
    if (!line.startsWith("|")) return raw;
    const parts = line.split("|");
    if (parts.length < 5) return raw;
    const id = stripLink((parts[1] ?? "").trim());
    if (!matches(id)) return raw;
    const currentCell = (parts[parts.length - 2] ?? "").trim();
    // FIX-1219: preserve annotation text when rewriting Done status.
    // When the current cell already has a Done marker with trailing annotation
    // (e.g. "✅ Done (PR#1238 · merged abc1234)") and the new status is also
    // a Done marker, preserve the annotation so the supervisor's merge ref
    // annotations are not silently stripped.
    let finalStatus = newStatus;
    if (newStatus.includes("✅") || newStatus.includes("✔️")) {
      const annotation = extractAnnotation(currentCell);
      if (annotation) {
        finalStatus = `${newStatus} ${annotation}`;
      }
    }
    parts[parts.length - 2] = ` ${finalStatus} `;
    count += 1;
    const rebuilt = parts.join("|");
    return hasCr ? `${rebuilt}\r` : rebuilt;
  });
  return { content: out.join("\n"), count };
}

export function markStatus(content: string, pattern: string, newStatus: string): MarkResult {
  // No family filter here — bash `_backlog_set_status` marks any row whose id
  // cell matches, regardless of US/FIX/… prefix. `idMatchesPattern` also marks
  // `<id>-` descendants (bash parity). The only intentional divergence from the
  // oracle is ID-token anchoring (FIX-106).
  return markStatusWith(content, (id) => idMatchesPattern(id, pattern), newStatus);
}

/**
 * FIX-1475: rewrite the Status cell of ONLY the row whose id EXACTLY equals
 * `id` (case-insensitive). Unlike {@link markStatus}, this never touches
 * `<id>-` descendant rows — a durable Done flip for `FIX-1475` must not also
 * mark `FIX-1475-followup` Done.
 */
export function markStatusExact(content: string, id: string, newStatus: string): MarkResult {
  const target = id.toUpperCase();
  return markStatusWith(content, (rowId) => rowId.toUpperCase() === target, newStatus);
}

/** Store bound to a {@link FileStore} (Node-backed by default). */
export class BacklogStore {
  constructor(private readonly fs: FileStore = nodeFileStore) {}

  /** Read the backlog, returning content + sha256 + parsed rows. */
  readBacklog(path: string): BacklogSnapshot {
    const content = this.fs.readText(path);
    return { content, hash: sha256(content), items: parseBacklog(content) };
  }

  /**
   * Optimistic write: re-read `path`, verify its current sha256 equals
   * `expectedHash` (else throw {@link ConflictError}), run `updater` on the
   * fresh content, and persist the result atomically (tmp-file + rename).
   * Returns the sha256 of the written content.
   */
  writeBacklog(path: string, expectedHash: string, updater: (content: string) => string): string {
    const current = this.fs.readText(path);
    const actualHash = sha256(current);
    if (actualHash !== expectedHash) throw new ConflictError(expectedHash, actualHash);
    const next = updater(current);
    this.fs.writeFileAtomic(path, next);
    return sha256(next);
  }

  /**
   * Convenience: mark every row matching `pattern` to `newStatus` under
   * optimistic concurrency. Returns the rewritten content, count, and new hash.
   */
  mark(
    path: string,
    expectedHash: string,
    pattern: string,
    newStatus: string,
  ): MarkResult & { hash: string } {
    let result: MarkResult = { content: "", count: 0 };
    const hash = this.writeBacklog(path, expectedHash, (content) => {
      result = markStatus(content, pattern, newStatus);
      return result.content;
    });
    return { ...result, hash };
  }

  /**
   * FIX-1475: like {@link mark} but flips ONLY the row whose id EXACTLY equals
   * `id` — never `<id>-` descendants. Use this when marking a single concrete
   * story (e.g. a Done/In-Progress transition for one card), where prefix
   * matching would wrongly flip sibling rows.
   */
  markExact(
    path: string,
    expectedHash: string,
    id: string,
    newStatus: string,
  ): MarkResult & { hash: string } {
    let result: MarkResult = { content: "", count: 0 };
    const hash = this.writeBacklog(path, expectedHash, (content) => {
      result = markStatusExact(content, id, newStatus);
      return result.content;
    });
    return { ...result, hash };
  }
}
