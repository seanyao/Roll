/**
 * FIX-1480 — npm is the single publish/install truth source.
 *
 * A `v*` tag push creates a DRAFT GitHub Release (release.yml); the version is
 * not declared complete until npm actually has it. `verifyRelease` is the pure
 * two-phase gate: it confirms the git tag, the npm version, npm's dist-tags
 * latest, and the draft GitHub Release all agree, and ONLY THEN promotes the
 * draft to a normal (latest) release. Any missing/mismatched fact fails loud and
 * leaves the draft untouched — never a falsely-complete release, never an
 * automated `npm publish` (that stays the maintainer's 2FA step).
 */

/** Injectable side-effect seams so the gate is fully unit-testable. */
export interface ReleaseVerifySeams {
  /** Does the git tag exist locally/remotely? */
  tagExists: (tag: string) => boolean;
  /** Does npm have this EXACT package@version published? */
  npmHasVersion: (pkg: string, version: string) => boolean;
  /** npm `dist-tags.latest` for the package (undefined if unknown/unreachable). */
  npmLatest: (pkg: string) => string | undefined;
  /** The GitHub Release for this tag, or undefined when none exists. */
  getRelease: (tag: string) => { isDraft: boolean } | undefined;
  /** Promote the draft release for this tag to a normal (latest) release. */
  promoteRelease: (tag: string) => void;
}

export interface ReleaseVerifyResult {
  /** True when every fact agreed (release is/became complete). */
  ok: boolean;
  /** True when this call flipped the draft → latest (false when already latest). */
  promoted: boolean;
  /** Human-readable gaps; empty iff ok. */
  gaps: string[];
}

export interface ReleaseVerifyOptions {
  /** Require npm dist-tags.latest === version (mirror `npm install <pkg>`). Default true. */
  requireLatest?: boolean;
}

/**
 * Verify npm/tag/GitHub-Release agreement for `pkg@version` (tag `v<version>`)
 * and promote the draft only when ALL facts hold. Pure: all effects go through
 * `seams`. Idempotent — a re-run on an already-promoted release is ok with
 * `promoted:false`.
 */
export function verifyRelease(
  pkg: string,
  version: string,
  tag: string,
  seams: ReleaseVerifySeams,
  opts: ReleaseVerifyOptions = {},
): ReleaseVerifyResult {
  const gaps: string[] = [];

  if (!seams.tagExists(tag)) gaps.push(`git tag ${tag} does not exist`);
  if (!seams.npmHasVersion(pkg, version)) gaps.push(`npm has no ${pkg}@${version} (publish it first — npm is the truth source)`);
  if (opts.requireLatest !== false) {
    const latest = seams.npmLatest(pkg);
    if (latest !== version) {
      gaps.push(`npm dist-tags.latest is ${latest ?? "unknown"}, expected ${version}`);
    }
  }
  const release = seams.getRelease(tag);
  if (release === undefined) gaps.push(`no GitHub Release (draft) found for ${tag}`);

  // Ordering invariant: NEVER promote until every fact is verified.
  if (gaps.length > 0) return { ok: false, promoted: false, gaps };

  // All facts hold. Promote only if still a draft (idempotent re-runs).
  if (release !== undefined && release.isDraft) {
    seams.promoteRelease(tag);
    return { ok: true, promoted: true, gaps: [] };
  }
  return { ok: true, promoted: false, gaps: [] };
}

/** `v<version>` — roll's tag convention (calver version → tag). */
export function releaseTagForVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}
