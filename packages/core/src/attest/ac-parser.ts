/**
 * @responsibility Parses story acceptance-criterion blocks into stable derived entries.
 * US-ATTEST-001 — AC parser.
 *
 * Parses `**AC:**` blocks out of `.roll/features/<epic>/<slug>.md` story files
 * into structured entries with STABLE derived ids (`<storyId>:AC<n>` by block
 * order) — purely derived, never written back to the markdown (the corpus is
 * protected; anchors stay optional).
 *
 * Grammar (pinned against the live roll-meta corpus, 2026-06):
 *   - A story SECTION starts at a `##`/`###` heading whose text contains a
 *     story id (`US-…`, `FIX-…`, `REFACTOR-…`, lowercase suffix allowed) and
 *     runs until the next heading of the same-or-higher level.
 *   - An AC BLOCK starts at a line that is exactly `**AC:**` (trailing spaces
 *     tolerated) or at a heading `## Acceptance Criteria` / `## 验收标准` /
 *     `## AC` (any heading level). Near-misses like `**AC refreshed**: …` or
 *     `**AC(note)**` are NOT blocks — the colon-inside-bold form remains the
 *     legacy contract.
 *   - Items are markdown task-list lines `- [ ] …` / `- [x] …`; an indented
 *     continuation line is appended to the previous item. Blank lines and
 *     bold-only group sub-headers (`**配置:**`) inside the block are tolerated
 *     (the corpus groups long AC lists this way). The block ends at the first
 *     other line.
 *   - Blocks before any story heading are FILE-LEVEL (storyId "") — the
 *     one-card `FIX-XXX.md` house style binds them by filename at the caller.
 */

export interface AcItem {
  /** Stable derived id: `<storyId>:AC<ordinal>` (file-level: `AC<ordinal>`). */
  id: string;
  /** 1-based position inside its AC block. */
  ordinal: number;
  text: string;
  /** `- [x]` checked state in the source (informational — attest re-judges). */
  checked: boolean;
}

export interface AcSection {
  /** Story id owning the block; "" for file-level blocks. */
  storyId: string;
  items: AcItem[];
}

const HEADING = /^(#{2,3})\s+(.*)$/;
const STORY_ID = /\b((?:US|FIX|REFACTOR)-[A-Z0-9]+(?:-[A-Z0-9]+)*?-?\d+[a-z]?)\b/;
const AC_OPEN = /^\*\*AC:\*\*\s*$/;
const AC_HEADING = /^#{2,4}\s+(?:Acceptance Criteria|验收标准|AC)\s*$/i;
const ITEM = /^- \[([ xX])\]\s?(.*)$/;
const CONTINUATION = /^\s{2,}(\S.*)$/;

/** Extract every AC block in the document, attributed to its story section. */
export function parseAcBlocks(markdown: string): AcSection[] {
  const lines = markdown.split("\n");
  const sections: AcSection[] = [];
  let currentStory = ""; // "" until the first story heading → file-level
  let block: AcItem[] | null = null;
  let ordinal = 0;

  const closeBlock = (): void => {
    if (block !== null && block.length > 0) {
      sections.push({ storyId: currentStory, items: block });
    }
    block = null;
    ordinal = 0;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");

    if (AC_HEADING.test(line)) {
      closeBlock();
      block = [];
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      closeBlock();
      const id = STORY_ID.exec(h[2] ?? "");
      // A heading WITH a story id opens that story's section; one without
      // (e.g. `## 背景`) stays inside the current story's section.
      if (id?.[1] !== undefined) currentStory = id[1];
      continue;
    }

    if (AC_OPEN.test(line)) {
      closeBlock();
      block = [];
      continue;
    }

    if (block !== null) {
      const item = ITEM.exec(line);
      if (item) {
        ordinal += 1;
        const prefix = currentStory === "" ? "" : `${currentStory}:`;
        block.push({
          id: `${prefix}AC${ordinal}`,
          ordinal,
          text: (item[2] ?? "").trim(),
          checked: (item[1] ?? " ").toLowerCase() === "x",
        });
        continue;
      }
      const cont = CONTINUATION.exec(line);
      if (cont && block.length > 0) {
        const last = block[block.length - 1];
        if (last !== undefined) last.text = `${last.text} ${(cont[1] ?? "").trim()}`;
        continue;
      }
      // Corpus tolerance: blank lines and bold-only group sub-headers stay
      // inside the block (`**AC:**\n\n**配置（…）:**\n- [ ] …` grouping style).
      if (line.trim() === "" || /^\*\*[^*]+\*\*:?\s*$/.test(line.trim())) continue;
      closeBlock(); // first other line ends the block
    }
  }
  closeBlock();
  return sections;
}

export interface AcForStoryOptions {
  /**
   * US-ATTEST-012 — the markdown is an ID-NAMED card file (`<storyId>.md`), so
   * the WHOLE file belongs to this story: every AC block is attributed to it
   * regardless of `##` section headings. Filename wins over section attribution
   * — this stops a heading that merely mentions ANOTHER card id (FIX-214 实案)
   * from hijacking the trailing AC. Default false keeps section attribution.
   */
  fileOwned?: boolean;
}

/**
 * The AC items for ONE story: its section blocks (concatenated in order, ids
 * re-derived across the whole story so they stay stable), falling back to the
 * file-level block when the document carries no story-scoped AC (the one-card
 * FIX-XXX.md house style). With `fileOwned`, ALL blocks in the document are
 * claimed by the story (the filename is authoritative).
 */
export function acForStory(markdown: string, storyId: string, opts: AcForStoryOptions = {}): AcItem[] {
  const sections = parseAcBlocks(markdown);
  const scoped = opts.fileOwned === true ? sections : sections.filter((s) => s.storyId === storyId);
  const chosen = scoped.length > 0 ? scoped : sections.filter((s) => s.storyId === "");
  const items: AcItem[] = [];
  for (const s of chosen) {
    for (const it of s.items) {
      const ordinal = items.length + 1;
      items.push({ ...it, ordinal, id: `${storyId}:AC${ordinal}` });
    }
  }
  return items;
}
