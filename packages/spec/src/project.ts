/**
 * @responsibility Defines the path-as-identity project slug contract (I7).
 */
/**
 * Project identity — path-as-identity contract (I7), TS port of v2
 * `_project_slug` (US-SCAF-005, diff-tested against the frozen bash oracle).
 *
 * Pure module: callers (infra) perform the I/O steps and inject results —
 *  - canonicalize the path (realpath on macOS case-insensitive fs, FIX-056)
 *  - resolve a git worktree to its main tree via git-common-dir (FIX-034)
 *  - read the remote URL (origin, else first remote) (US-OBS-010)
 *  - read ROLL_MAIN_SLUG from the environment (US-LOOP-006)
 */
import { createHash } from "node:crypto";

/** md5 hex of a string, first 6 chars — slug discriminator (matches `md5 | cut -c1-6`). */
function md5_6(s: string): string {
  return createHash("md5").update(s).digest("hex").slice(0, 6);
}

/** Mirrors `tr -cs '[:alnum:]' '-' | sed 's/-*$//'`: runs of non-alnum → "-", strip trailing. */
export function sanitizeSlugBase(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");
}

/**
 * Mirrors v2 remote normalization: strip trailing `.git`,
 * `git@HOST:PATH` → `https://HOST/PATH`, lowercase.
 */
export function normalizeRemoteUrl(url: string): string {
  let u = url.endsWith(".git") ? url.slice(0, -4) : url;
  const ssh = /^git@([^:]+):(.+)$/.exec(u);
  if (ssh !== null) u = `https://${ssh[1]}/${ssh[2]}`;
  return u.toLowerCase();
}

/** POSIX basename for the cases the oracle exercises. */
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

export interface ProjectIdentityInputs {
  /** ROLL_MAIN_SLUG override — wins outright when non-empty (US-LOOP-006). */
  mainSlugOverride?: string | undefined;
  /** Canonical project path (realpath'd, worktree-resolved by the caller). */
  path: string;
  /** Remote URL (origin, else first remote); undefined when repo has none. */
  remoteUrl?: string | undefined;
}

/**
 * Derive the project slug — the single identity under which all runtime
 * state (events, runs, locks) is keyed. Remote-based for cross-machine
 * stability; falls back to path-based when no remote exists.
 */
export function projectSlug(inputs: ProjectIdentityInputs): string {
  if (inputs.mainSlugOverride !== undefined && inputs.mainSlugOverride !== "") {
    return inputs.mainSlugOverride;
  }
  if (inputs.remoteUrl !== undefined && inputs.remoteUrl !== "") {
    const url = normalizeRemoteUrl(inputs.remoteUrl);
    return `${sanitizeSlugBase(basename(url))}-${md5_6(url)}`;
  }
  return `${sanitizeSlugBase(basename(inputs.path))}-${md5_6(inputs.path)}`;
}
