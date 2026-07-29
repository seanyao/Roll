/**
 * US-META-001 — archive-layout write-side support.
 *
 * The card folder `.roll/features/<epic>/<ID>/` is the single home for a card's
 * deliverables (attest runs, screenshots, evidence). Locating the right epic for
 * a story is driven by a backlog-generated authoritative index
 * (`.roll/index.json`): a deterministic ID→epic map. Anything the index can't
 * place falls back to `features/uncategorized/<ID>/` — resolution NEVER blocks a
 * write (D1, same posture as attest's never-block failure policy).
 *
 * Lifecycle note: US-META-002a/b migrated the legacy `verification/<ID>/` trees
 * into card folders; US-META-002c retired the read-compat — the card folder is
 * the single home for a story's run artifacts.
 */
import { parseBacklog } from "@roll/core";
import { markPhaseDone } from "./story-page.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Dirent } from "node:fs";

/** The uncategorized epic slug — the never-block fallback bucket. */
export const UNCATEGORIZED = "uncategorized";

/**
 * Resolve the project-data authority root without conflating canonical
 * Workspaces with imported legacy projects. A canonical Workspace owns
 * `backlog/index.md` + `features/` directly; legacy projects keep `.roll/`.
 */
export type ProjectDataAuthorityMode = "auto" | "workspace" | "legacy";

export function projectDataRoot(projectPath: string, authorityMode: ProjectDataAuthorityMode = "auto"): string {
  if (authorityMode === "workspace") return projectPath;
  if (authorityMode === "legacy") return join(projectPath, ".roll");
  try {
    if (statSync(join(projectPath, "workspace.yaml")).isFile()) return projectPath;
  } catch {
    // No canonical Workspace marker; retain legacy auto-detection below.
  }
  return existsSync(join(projectPath, "backlog", "index.md")) && existsSync(join(projectPath, "features"))
    ? projectPath
    : join(projectPath, ".roll");
}

export function projectDataPath(projectPath: string, ...segments: string[]): string {
  return join(projectDataRoot(projectPath), ...segments);
}

export function projectBacklogPath(projectPath: string, authorityMode: ProjectDataAuthorityMode = "auto"): string {
  const root = projectDataRoot(projectPath, authorityMode);
  return root === projectPath ? join(root, "backlog", "index.md") : join(root, "backlog.md");
}

export function projectRuntimePath(projectPath: string, ...segments: string[]): string {
  const root = projectDataRoot(projectPath);
  return root === projectPath ? join(root, "runtime", ...segments) : join(root, "loop", ...segments);
}

export function projectOperationalPath(projectPath: string, ...segments: string[]): string {
  const root = projectDataRoot(projectPath);
  return root === projectPath ? join(root, "runtime", ...segments) : join(root, ...segments);
}

/**
 * FIX-1059 — is this directory entry a markdown FILE we should treat as a story
 * candidate? A real `.md` file qualifies directly; a SYMLINK whose name ends in
 * `.md` qualifies only when it resolves (stat follows the link) to a real
 * regular file. Loop worktrees link `features/<epic>/<ID>/spec.md` to the
 * persistent `.roll` spec, so the linked card file must be discoverable just like
 * a physical one — otherwise `roll attest` mis-reports the story as not found.
 *
 * Safety (AC3): a broken symlink makes `statSync` throw → false; a symlink to a
 * directory is `isFile() === false` → false (never followed as a file, so no
 * directory loop). Directory-symlink walking is already excluded upstream because
 * `Dirent.isDirectory()` is false for a symlink, so the walker never descends it.
 */
export function isMarkdownStoryEntry(path: string, entry: Dirent): boolean {
  if (!entry.name.endsWith(".md")) return false;
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false; // broken symlink — ignored safely
  }
}

/** FIX-1483: run artifacts (`latest/`, an `evidence/` payload, a timestamped or
 *  `cycle-` prefixed run directory, …) only ever live INSIDE a card folder —
 *  `features/<epic>/<ID>/<run>` — never at the epic level. Applying the
 *  heuristic to a direct child of `features/` silently hid EVERY card of the
 *  `cycle-efficiency` epic from `roll attest` ("story not found"), because that
 *  epic's own name starts with `cycle-`; the whole epic could therefore never
 *  earn an acceptance report. `depth` is the distance below `features/`: epics
 *  sit at depth 0, card folders at depth 1, run artifacts at depth 2+ — so the
 *  heuristic is confined to depth ≥ 2 (codex review: a depth ≥ 1 gate would
 *  still swallow a legacy feature-slug folder such as `cycle-meta-sync/` that
 *  legitimately owns specs; measured on the live tree, all 2675 run-shaped
 *  directories sit at depth 2 and none at depth 1). */
export function isRunArtifactDir(name: string, depth: number): boolean {
  if (depth < 2) return false;
  if (name === "notes" || name === "evidence" || name === "screenshots" || name === "latest") return true;
  return /^\d{4}-\d{2}-\d{2}T/.test(name) || name.startsWith("cycle-") || name === "pre-evidence-backfill";
}

/** Every feature markdown that could define a story, in resolution priority:
 *  ID-named owners (the legacy flat `<storyId>.md` and the card-folder
 *  `<storyId>/spec.md`, FIX-225 / US-META-001) first, then prose/content
 *  mentions in walk order. `findFeatureFile` takes the top candidate; AC
 *  extraction (attest) may walk PAST a content-free stub owner — a
 *  migrate-features `spec.md` (US-META-007) owns the card folder yet carries no
 *  `**AC:**` block, while the real ACs still live in the epic feature file
 *  (FIX-226). Exposing the full list lets that caller fall through. */
export function findFeatureFiles(projectPath: string, storyId: string): string[] {
  const root = projectDataPath(projectPath, "features");
  if (!existsSync(root)) return [];
  const hits: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (isRunArtifactDir(e.name, depth)) continue;
        walk(p, depth + 1);
      } else if (isMarkdownStoryEntry(p, e)) {
        const idOwned =
          e.name === `${storyId}.md` || (e.name === "spec.md" && basename(dir) === storyId);
        if (idOwned) hits.unshift(p); // ID-named owner wins
        else {
          try {
            if (readFileSync(p, "utf8").includes(storyId)) hits.push(p);
          } catch {
            /* unreadable file: skip */
          }
        }
      }
    }
  };
  try {
    walk(root, 0);
  } catch {
    return [];
  }
  return hits;
}

/** The top feature markdown that defines a story (heading or AC owner); null
 *  when nothing matches. See {@link findFeatureFiles} for the full priority. */
export function findFeatureFile(projectPath: string, storyId: string): string | null {
  return findFeatureFiles(projectPath, storyId)[0] ?? null;
}

/** Resolve an existing card folder even when a partial cycle worktree carries
 *  only `.roll/features/<epic>/<ID>/` artifacts and no spec/index/backlog. */
function liveCardDirEpicOf(projectPath: string, storyId: string): string | null {
  const root = projectDataPath(projectPath, "features");
  let epics: string[] = [];
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        readdirSync(join(root, e.name, storyId), { withFileTypes: true });
        epics = [...epics, e.name];
      } catch {
        /* no card dir for this epic */
      }
    }
  } catch {
    return null;
  }
  return epics.length === 1 ? (epics[0] ?? null) : null;
}

/** The primary human confirmation page filename: `<ID>-review.html`. */
export function reviewFileName(storyId: string): string {
  return `${storyId}-review.html`;
}

/** Legacy acceptance report alias retained for one release cycle. */
export function reportFileName(storyId: string): string {
  return `${storyId}-report.html`;
}

/** A directory name that can serve as an epic (not empty/`.`/the `features` root itself). */
function isEpicName(name: string): boolean {
  return name !== "" && name !== "." && name !== "features";
}

/**
 * Derive the epic from a feature file path — the single owner of the
 * `features/<epic>/<ID>/spec.md` layout knowledge.
 *
 * The file lives inside the story directory, so the epic is TWO levels up:
 *   spec.md → <ID>/ → <epic>/
 * Legacy fallback: a file directly under `features/<epic>/` (no story subdir)
 * takes its epic from ONE level up. Returns null when neither level yields one.
 */
export function epicFromFeaturePath(featureFile: string): string | null {
  const storyDir = dirname(featureFile);
  const epic = basename(dirname(storyDir));
  if (isEpicName(epic)) return epic;
  const legacy = basename(storyDir);
  return isEpicName(legacy) ? legacy : null;
}

/**
 * Resolve a story's epic by LIVE filesystem walk (see {@link epicFromFeaturePath}
 * for the layout rules). Returns null when the file is missing or has no epic
 * parent — falls back to `uncategorized` at the call site.
 */
export function liveEpicOf(projectPath: string, storyId: string): string | null {
  const cardDirEpic = liveCardDirEpicOf(projectPath, storyId);
  if (cardDirEpic !== null) return cardDirEpic;
  const file = findFeatureFile(projectPath, storyId);
  if (file === null) return null;
  return epicFromFeaturePath(file);
}

/**
 * FIX-275 — bulk epic resolution with ONE tree walk.
 *
 * `generateIndex` used to call {@link liveEpicOf} per backlog ID, each walking
 * the whole `.roll/features/` tree (O(ids × tree); 1m28s on the real repo at
 * card-count ~350). This resolver snapshots the walk once and resolves every ID
 * against it with the EXACT per-ID semantics:
 *   - ID-owned files (`<id>.md`, `<id>/spec.md`) beat content mentions; among
 *     several owners the LAST in walk order wins (the original `unshift`).
 *   - Otherwise the FIRST file in walk order whose content mentions the ID wins.
 *   - No hit → null (→ uncategorized at the call site).
 * Single-ID callers ({@link liveEpicOf} / {@link findFeatureFile}) are untouched.
 */
export function bulkLiveEpics(
  projectPath: string,
  ids: readonly string[],
  authorityMode: ProjectDataAuthorityMode = "auto",
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  const remaining = new Set(ids);
  const files: Array<{ path: string; name: string; dirName: string }> = [];
  const root = join(projectDataRoot(projectPath, authorityMode), "features");
  const walk = (dir: string, depth: number): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (isRunArtifactDir(e.name, depth)) continue;
        walk(p, depth + 1);
      } else if (isMarkdownStoryEntry(p, e)) {
        files.push({ path: p, name: e.name, dirName: basename(dir) });
      }
    }
  };
  try {
    if (existsSync(root)) walk(root, 0);
  } catch {
    /* unreadable tree → every id resolves null, same as the per-ID walk */
  }
  // Pass 0: live card directories. Partial loop worktrees may carry
  // `features/<epic>/<ID>/ac-map.json` and evidence without spec.md or index.json;
  // that directory is still the story's live home. Only a unique directory owner
  // is accepted; duplicates stay unresolved for the later fail-loud paths.
  const dirOwners = new Map<string, string[]>();
  try {
    if (existsSync(root)) {
      for (const epic of readdirSync(root, { withFileTypes: true })) {
        if (!epic.isDirectory()) continue;
        for (const id of remaining) {
          try {
            readdirSync(join(root, epic.name, id), { withFileTypes: true });
            const owners = dirOwners.get(id) ?? [];
            dirOwners.set(id, [...owners, epic.name]);
          } catch {
            /* no card dir for this id under this epic */
          }
        }
      }
    }
  } catch {
    /* fall through to markdown-based resolution */
  }
  for (const [id, owners] of dirOwners) {
    if (owners.length !== 1) continue;
    result.set(id, owners[0] ?? null);
    remaining.delete(id);
  }
  // Pass 1: ID-owned files. Overwriting per walk order reproduces "later owner
  // wins" (each unshift put the newest owner at the head).
  const owner = new Map<string, string>();
  for (const f of files) {
    const id = f.name === "spec.md" ? f.dirName : f.name.slice(0, -3);
    if (remaining.has(id)) owner.set(id, f.path);
  }
  for (const [id, p] of owner) {
    result.set(id, epicFromFeaturePath(p));
    remaining.delete(id);
  }
  // Pass 2: content mentions — each file read at most ONCE, first hit wins.
  for (const f of files) {
    if (remaining.size === 0) break;
    let content: string;
    try {
      content = readFileSync(f.path, "utf8");
    } catch {
      continue;
    }
    for (const id of [...remaining]) {
      if (content.includes(id)) {
        result.set(id, epicFromFeaturePath(f.path));
        remaining.delete(id);
      }
    }
  }
  for (const id of remaining) result.set(id, null);
  return result;
}

/** Read `.roll/index.json` → ID→epic map; {} on absence / malformed (lenient). */
export function readIndex(projectPath: string): Record<string, string> {
  const p = projectDataPath(projectPath, "index.json");
  if (!existsSync(p)) return {};
  try {
    const obj = JSON.parse(readFileSync(p, "utf8")) as { stories?: Record<string, string> };
    const s = obj?.stories;
    if (s === undefined || s === null || typeof s !== "object") return {};
    return s;
  } catch {
    return {};
  }
}

/**
 * (Re)generate `.roll/index.json` from the backlog: every backlog story id whose
 * epic the live walk can place is recorded. Deterministic + idempotent (sorted,
 * no volatile fields). Returns the written map.
 */
export function generateIndex(
  projectPath: string,
  authorityMode: ProjectDataAuthorityMode = "auto",
): Record<string, string> {
  const authorityRoot = projectDataRoot(projectPath, authorityMode);
  const backlogPath = projectBacklogPath(projectPath, authorityMode);
  let ids: string[] = [];
  if (existsSync(backlogPath)) {
    try {
      ids = parseBacklog(readFileSync(backlogPath, "utf8")).map((it) => it.id);
    } catch {
      ids = [];
    }
  }
  // FIX-275: one walk for all ids (was a full-tree walk PER id).
  const bulk = bulkLiveEpics(projectPath, ids, authorityMode);
  const stories = buildStoryIndex(ids, (id) => bulk.get(id) ?? null);
  const rollDir = authorityRoot;
  if (!existsSync(rollDir)) mkdirSync(rollDir, { recursive: true });
  writeFileSync(join(rollDir, "index.json"), serializeIndex(stories));
  return stories;
}

/**
 * The epic to place a story under. US-V4-001 (v4 truth plane): the LIVE
 * filesystem is authoritative for a story's location — the existing
 * `features/<epic>/<storyId>/` (or its feature markdown) IS the story's home.
 * `.roll/index.json` is consulted ONLY as a fallback cache for ids the live walk
 * can't place; it is never a delivery precondition. This is the inversion of the
 * v3 "index-first" order: story artifact location no longer depends on a freshly
 * regenerated index (a stale index entry can no longer mis-route an attest write).
 * Returns null when neither the live walk nor the cache resolves (→ uncategorized).
 */
export function epicForStory(projectPath: string, storyId: string): string | null {
  const live = liveEpicOf(projectPath, storyId);
  if (live !== null) return live;
  const fromIndex = readIndex(projectPath)[storyId];
  if (fromIndex !== undefined && fromIndex !== "") return fromIndex;
  return null;
}

/**
 * The WRITE destination for a card's deliverables: `features/<epic>/<ID>/`, or
 * `features/uncategorized/<ID>/` when no epic resolves. Never throws — resolution
 * never blocks a write (D1).
 */
export function cardArchiveDir(projectPath: string, storyId: string): string {
  const epic = epicForStory(projectPath, storyId) ?? UNCATEGORIZED;
  return projectDataPath(projectPath, "features", epic, storyId);
}

/**
 * US-DOSSIER-007 AC2: at PR-open, mount the EXECUTION section onto the story's
 * dossier page with the fact known *right now* — the PR number/link — rather
 * than leaving it for a later full re-render to reconstruct from squash-flattened
 * history (which loses it). Best-effort: returns false (never throws) when the
 * page or its execution anchor is absent. Idempotent via `markPhaseDone`.
 */
export function mountExecutionAtPublish(projectPath: string, storyId: string, prUrl: string): boolean {
  try {
    const idxPath = join(cardArchiveDir(projectPath, storyId), "index.html");
    if (!existsSync(idxPath)) return false;
    const html = readFileSync(idxPath, "utf8");
    const num = /\/pull\/(\d+)/.exec(prUrl)?.[1];
    const label = num !== undefined ? `PR #${num}` : "PR";
    const safe = prUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const mounted = markPhaseDone(html, "execution", `<p><a href="${safe}">${label}</a></p>`);
    if (mounted === html) return false; // no execution anchor matched
    writeFileSync(idxPath, mounted, "utf8");
    return true;
  } catch {
    return false;
  }
}

// US-META-002c: the legacy `.roll/verification/<ID>` read-compat
// (legacyArchiveDir / resolveReadArchiveDir) is retired — the tree is migrated
// (002b) and deleted; the card folder is the single home for run artifacts.

/**
 * Pure: build the ID→epic map from a list of story ids and an epic resolver.
 * Stories the resolver can't place (returns null) are OMITTED — at lookup time
 * they fall back to `uncategorized`, so the index only records confident hits.
 */
export function buildStoryIndex(ids: string[], epicOf: (id: string) => string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const epic = epicOf(id);
    if (epic !== null && epic !== "") out[id] = epic;
  }
  return out;
}

/**
 * Pure: serialize the index to deterministic JSON (sorted keys, trailing
 * newline). Same input → byte-identical output, so regeneration is idempotent.
 */
export function serializeIndex(stories: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(stories).sort()) sorted[k] = stories[k] as string;
  return JSON.stringify({ stories: sorted }, null, 2) + "\n";
}

// ── US-OBS-016 — dossier data model moved to @roll/core ────────────────────
// Re-export for backward compat; new consumers import from @roll/core.
export {
  collectDossier,
  type DossierStory,
  type DossierEpic,
  type DossierEpicDoc,
  type DossierEpicDocKind,
  type CollectDossierOptions,
} from "@roll/core";
