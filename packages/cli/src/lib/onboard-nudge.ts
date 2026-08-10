/**
 * @responsibility Detects PRD and empty-backlog design-handoff signals.
 */
/**
 * US-ONBOARD-NUDGE-001 — PRD + empty-backlog design-handoff signal detection.
 *
 * Pure, deterministic library: detects whether a project has requirement/design
 * materials but an empty backlog, and renders a locale-aware nudge message.
 * No agent/network imports — structurally deterministic and testable.
 *
 * Commands (init/status/doctor) consume these primitives; the wiring is in
 * US-ONBOARD-NUDGE-002 / 003.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseBacklog } from "@roll/core";
import { t, v3Catalog, type Lang } from "@roll/spec";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DesignHandoffSignal {
  /** Whether any requirement/design material was heuristically found. */
  materialPresent: boolean;
  /** Whether the backlog file is absent or parses to zero items. */
  backlogEmpty: boolean;
  /** materialPresent AND backlogEmpty — the nudge should be shown. */
  shouldNudge: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Document extensions that qualify as design materials. */
const DOC_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst", ".pdf", ".doc", ".docx"]);

/** File/directory name pattern for requirement/design signals. */
const MATERIAL_NAME_RE = /(prd|spec|requirement|design|rfc|需求|产品|需求文档)/i;

/**
 * Explicit exclusion set — files that match the material pattern by accident
 * but are not design documents. Matched against basename (no extension).
 */
const EXCLUDED_NAMES = new Set([
  "readme",
  "changelog",
  "contributing",
  "license",
  "code_of_conduct",
  "security",
  "agents",   // AGENTS.md (roll scaffold)
]);

/** Directories to skip entirely during the scan. */
const SKIP_DIRS = new Set([
  ".roll",
  ".git",
  "node_modules",
  ".claude",
  "dist",
  "build",
  "coverage",
]);

/** Maximum file size in bytes before we judge by filename only (2 MB). */
const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024;

/** Maximum scan depth (0 = root only, 2 = root + 2 levels of subdirectories). */
const MAX_SCAN_DEPTH = 2;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Check if a filename or its parent directory matches the material pattern. */
function isMaterialName(name: string): boolean {
  return MATERIAL_NAME_RE.test(name);
}

/** Check if a file is explicitly excluded by basename. */
function isExcludedFile(filename: string): boolean {
  // Strip extension for comparison, e.g., "README.md" → "readme"
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot).toLowerCase() : filename.toLowerCase();
  return EXCLUDED_NAMES.has(stem);
}

/** Check if a path component should be skipped (hidden or in skip set). */
function shouldSkipDir(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

/** Check if a file extension qualifies as a document. */
function isDocFile(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return false;
  return DOC_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

/** Check if a file is non-empty. For text files, strip whitespace. For others, check size > 0. */
function isNonEmpty(fullPath: string, isText: boolean): boolean {
  try {
    const s = statSync(fullPath);
    if (s.size === 0) return false;
    if (!isText) return s.size > 0;
    // For text: strip whitespace, check if remaining content is non-empty
    const content = readFileSync(fullPath, "utf8");
    return content.replace(/\s/g, "").length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan `projectDir` for design/requirement materials and check backlog emptiness.
 *
 * - Scans directories up to depth 2 (root = 0, root's children = 1, grandchildren = 2).
 * - Skips `.roll/`, `.git/`, `node_modules/`, `.claude/`, `dist/`, `build/`, `coverage/`,
 *   and any directory starting with `.`.
 * - Does NOT follow directory symlinks (lstat). Large files (>2MB) judged by name only.
 * - Single unreadable file → skipped; directory-level/permission errors → returns
 *   `shouldNudge=false`, never throws.
 */
export function detectDesignHandoff(projectDir: string): DesignHandoffSignal {
  // Backlog emptiness check
  let backlogEmpty = true;
  try {
    const backlogPath = join(projectDir, ".roll", "backlog.md");
    if (existsSync(backlogPath)) {
      const content = readFileSync(backlogPath, "utf8");
      const items = parseBacklog(content);
      backlogEmpty = items.length === 0;
    }
    // else: no file → empty
  } catch {
    // Unreadable backlog → treat as empty (fail safe: still signal so user is nudged)
    backlogEmpty = true;
  }

  // Material scan
  let materialPresent = false;
  try {
    if (!existsSync(projectDir)) {
      return { materialPresent: false, backlogEmpty, shouldNudge: false };
    }
    materialPresent = scanForMaterials(projectDir, 0);
  } catch {
    // Directory-level error → conservatively return false
    return { materialPresent: false, backlogEmpty, shouldNudge: false };
  }

  return {
    materialPresent,
    backlogEmpty,
    shouldNudge: materialPresent && backlogEmpty,
  };
}

/**
 * Recursively scan directory for design materials up to MAX_SCAN_DEPTH.
 * Returns true as soon as a material is found (short-circuit).
 */
function scanForMaterials(dir: string, depth: number): boolean {
  if (depth > MAX_SCAN_DEPTH) return false;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Single directory unreadable → skip (consistent with AC4 grading)
    return false;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);

    // Symlink guard — do not follow directory symlinks
    let lst;
    try {
      lst = lstatSync(fullPath);
    } catch {
      continue; // unreadable entry → skip
    }

    if (lst.isSymbolicLink()) continue; // skip all symlinks per AC4b

    if (lst.isDirectory()) {
      if (shouldSkipDir(entry)) continue;
      // Check if directory NAME itself signals material
      // (e.g., "prd-draft/", "需求/", "design/")
      if (isMaterialName(entry)) {
        // Look for any non-empty doc file inside at any depth
        if (hasMaterialFileInside(fullPath, 0)) return true;
      }
      // Recurse into directory
      if (scanForMaterials(fullPath, depth + 1)) return true;
      continue;
    }

    if (!lst.isFile()) continue;
    if (!isDocFile(entry)) continue;

    // Large file → judge by name only
    if (lst.size > LARGE_FILE_THRESHOLD) {
      if (isMaterialName(entry) && !isExcludedFile(entry)) return true;
      // Also check parent dir name for large files
      if (isMaterialName(basename(dir)) && !isExcludedFile(entry)) return true;
      continue;
    }

    // Excluded files (README, CHANGELOG, etc.)
    if (isExcludedFile(entry)) continue;

    // Material signal: filename or parent dir name matches the pattern
    const filenameMatch = isMaterialName(entry);
    const dirnameMatch = isMaterialName(basename(dir));

    if (filenameMatch || dirnameMatch) {
      if (isNonEmpty(fullPath, true)) return true;
    }
  }

  return false;
}

/**
 * Check if a directory contains any non-empty document file (recursive, limited depth).
 * Used when the directory name itself signals material (e.g., "prd-draft/").
 */
function hasMaterialFileInside(dir: string, depth: number): boolean {
  if (depth > MAX_SCAN_DEPTH) return false;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let lst;
    try {
      lst = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) continue;
    if (lst.isDirectory()) {
      if (shouldSkipDir(entry)) continue;
      if (hasMaterialFileInside(fullPath, depth + 1)) return true;
      continue;
    }
    if (!lst.isFile()) continue;
    if (!isDocFile(entry)) continue;
    if (lst.size > LARGE_FILE_THRESHOLD) return true; // large doc inside material dir → count it
    if (isNonEmpty(fullPath, true)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// renderDesignNudge
// ---------------------------------------------------------------------------

/**
 * Render the design-handoff nudge message in the given locale.
 *
 * Returns a single-line array (callers may prepend newlines or combine
 * with other output). Message follows the project's single-language contract
 * (en or zh, never mixed). Baselines only `$roll-design` — the `roll design`
 * command phrasing is added by US-ONBOARD-NUDGE-005 after 004 ships.
 */
export function renderDesignNudge(lang: Lang): string[] {
  const msg = t(v3Catalog, lang, "onboard.design_nudge", "$roll-design");
  return [msg];
}
