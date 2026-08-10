/**
 * @responsibility Collects the Charter project tab as a markdown browser.
 */
/**
 * US-DOSSIER-033 — the Charter PROJECT TAB collector: a markdown browser.
 *
 * The design reference (`Delivery Dossier.dc.html`) proves the render primitive
 * we reuse here: `viewMd()` fetches a markdown file and shows it in an in-place
 * scroll region (the SKILL.md viewer, lines 1414–1423). This collector reads the
 * project's own charter docs — `docs/*.md`, the per-epic plan `.md` files under
 * `.roll/features/<epic>/`, and `guide/INDEX.md` — at GENERATE time and bakes the
 * rendered bodies into the static console (determinism: no fetch at view time,
 * the page renders identically offline; matches the mount-board snapshot).
 *
 * Language-aware (AC2): a `guide/en/<x>.md` doc carries its `guide/zh/<x>.md`
 * sibling, so the Charter browser follows the EN/中 lang toggle the same way the
 * rest of the console does — the en body shows under EN, the zh body under 中.
 *
 * Purity: the collector NEVER reads the clock / PATH / network; every read is a
 * file read rooted at the injected project path, sorted deterministically. Same
 * tree on disk → same Charter view-model.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One selectable doc in the Charter directory tree. */
export interface CharterDoc {
  /** Stable id (the repo-relative path), drives the selector + test asserts. */
  id: string;
  /** Repo-relative path shown in the tree row. */
  path: string;
  /** Human title (first `# ` heading, else the basename). */
  title: string;
  /** Rendered markdown body (EN view / language-neutral). */
  bodyEn: string;
  /**
   * Rendered markdown body for the 中 view. Equals `bodyEn` for a single-language
   * doc; differs only for `guide/en` docs that have a `guide/zh` sibling.
   */
  bodyZh: string;
  /** `true` when bodyZh is a distinct translation (a guide/en↔zh pair). */
  bilingual: boolean;
}

/** One named group of docs in the tree (Charter · Guide · Plans). */
export interface CharterGroup {
  key: "charter" | "guide" | "plans";
  docs: CharterDoc[];
}

export interface CharterVM {
  groups: CharterGroup[];
  /** The id selected by default (first doc of the first non-empty group). */
  defaultId?: string;
}

export interface CharterDeps {
  /** Read a repo-relative file; undefined when absent/unreadable. */
  readDoc: (rel: string) => string | undefined;
  /** List repo-relative `*.md` paths under a repo-relative dir, sorted. */
  listMd: (relDir: string) => string[];
  /** The epic directory names under `.roll/features/`, sorted. */
  listEpics: () => string[];
  /** A render function (markdown → HTML); injected so tests stay deterministic. */
  render: (md: string) => string;
}

/** First `# ` heading in the source, else the basename without extension. */
function docTitle(src: string, path: string): string {
  for (const raw of src.split("\n")) {
    const m = /^#\s+(.*)$/.exec(raw.trim());
    if (m) return m[1]!.trim();
  }
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/\.md$/, "");
}

/**
 * Collect the Charter browser view-model from the real doc tree. Pure over the
 * injected deps; deterministic ordering throughout.
 */
export function collectCharter(deps: CharterDeps): CharterVM {
  const groups: CharterGroup[] = [];

  // 1) Charter group — docs/*.md (manifesto, architecture, …) in path order.
  const charterDocs: CharterDoc[] = [];
  for (const rel of deps.listMd("docs")) {
    const src = deps.readDoc(rel);
    if (src === undefined) continue;
    const body = deps.render(src);
    charterDocs.push({ id: rel, path: rel, title: docTitle(src, rel), bodyEn: body, bodyZh: body, bilingual: false });
  }
  if (charterDocs.length > 0) groups.push({ key: "charter", docs: charterDocs });

  // 2) Guide group — guide/INDEX.md plus the guide/en docs, each carrying its
  //    guide/zh sibling so the body follows the lang toggle (AC2).
  const guideDocs: CharterDoc[] = [];
  const index = deps.readDoc("guide/INDEX.md");
  if (index !== undefined) {
    const body = deps.render(index);
    guideDocs.push({ id: "guide/INDEX.md", path: "guide/INDEX.md", title: docTitle(index, "guide/INDEX.md"), bodyEn: body, bodyZh: body, bilingual: false });
  }
  for (const rel of deps.listMd("guide/en")) {
    const en = deps.readDoc(rel);
    if (en === undefined) continue;
    const zhRel = rel.replace(/^guide\/en\//, "guide/zh/");
    const zh = deps.readDoc(zhRel);
    const bodyEn = deps.render(en);
    const bodyZh = zh !== undefined ? deps.render(zh) : bodyEn;
    guideDocs.push({
      id: rel,
      path: rel,
      title: docTitle(en, rel),
      bodyEn,
      bodyZh,
      bilingual: zh !== undefined,
    });
  }
  if (guideDocs.length > 0) groups.push({ key: "guide", docs: guideDocs });

  // 3) Plans group — the per-epic plan markdown under .roll/features/<epic>/*.md
  //    (the human-authored epic plans, not the generated index.html). Best-effort.
  const planDocs: CharterDoc[] = [];
  for (const epic of deps.listEpics()) {
    for (const rel of deps.listMd(join(".roll", "features", epic))) {
      const src = deps.readDoc(rel);
      if (src === undefined) continue;
      const body = deps.render(src);
      planDocs.push({ id: rel, path: rel, title: docTitle(src, rel), bodyEn: body, bodyZh: body, bilingual: false });
    }
  }
  if (planDocs.length > 0) groups.push({ key: "plans", docs: planDocs });

  const defaultId = groups[0]?.docs[0]?.id;
  return { groups, ...(defaultId !== undefined ? { defaultId } : {}) };
}

/** Default deps — best-effort real reads rooted at `cwd`. */
export function defaultCharterDeps(cwd: string, render: (md: string) => string): CharterDeps {
  const readDoc = (rel: string): string | undefined => {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) return undefined;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  };
  const listMd = (relDir: string): string[] => {
    const abs = join(cwd, relDir);
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".md"))
      .filter((n) => {
        try {
          return statSync(join(abs, n)).isFile();
        } catch {
          return false;
        }
      })
      .sort()
      .map((n) => `${relDir}/${n}`);
  };
  const listEpics = (): string[] => {
    const abs = join(cwd, ".roll", "features");
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return [];
    }
    return names
      .filter((n) => {
        try {
          return statSync(join(abs, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  };
  return { readDoc, listMd, listEpics, render };
}
