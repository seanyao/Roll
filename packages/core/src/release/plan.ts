/**
 * @responsibility Plans release versions and flow under calver and semver schemes.
 * roll release — version + flow planning (US-PORT-004, TS port).
 *
 * TWO version schemes live here (FIX-1247):
 *
 *   - calver — roll's OWN build-number scheme `<major>.<MMDD>.<seq>` (e.g.
 *     `3.606.2` = major 3, June 6, the 2nd release that day). This is roll's
 *     internal cadence and MUST NOT leak onto the projects roll releases.
 *   - semver — the DEFAULT for every other (target/user) project: bump the
 *     patch of the project's own `<major>.<minor>.<patch>` lineage, and give a
 *     sensible initial value on first release. roll serves user projects (see
 *     roll_serves_user_projects), so a target project's version must anchor to
 *     the TARGET's package.json, never to roll's build number — releasing
 *     intel-radar must not produce `4.713.1`/`0.713.1`.
 *
 * The scheme is chosen from the project being released ({@link resolveVersionScheme}):
 * only roll's own package resolves to calver; everything else is semver.
 * package.json is the single source of truth for the running version (see
 * packages/cli/src/commands/version.ts).
 *
 * These are PURE functions (no I/O, no clock): the date is always passed in so
 * they unit-test deterministically. The CLI adapter (packages/cli) reads the
 * current version + changelog state and supplies `new Date()`.
 *
 * `roll release` is READ-ONLY GUIDANCE — it computes the next version, surfaces
 * changelog readiness, and prints the ordered PR/tag flow. It never pushes a
 * tag or publishes: tagging triggers release.yml's consistency-gate and the
 * actual publish requires the maintainer's 2FA. This mirrors the loop's hard
 * rule — a release is always a human decision, never autonomous.
 */

/** A parsed calver version: `<major>.<mid>.<seq>` where mid encodes MMDD. */
export interface Version {
  major: number;
  /** month * 100 + day (e.g. June 6 → 606, Dec 5 → 1205). */
  mid: number;
  seq: number;
}

/** A release date — the day the release is cut. */
export interface ReleaseDate {
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
}

const DEFAULT_MAJOR = 3;

/**
 * roll's own npm package name — the ONLY project that uses the calver scheme.
 *
 * FIX-1493: THIS repo publishes exactly ONE name. The dual-scope arrangement
 * (US-INSTALL-007) is retired: `seanyao/roll` and `BIPOSVC/ape-roll` are now
 * separate repositories that each publish their own npm name, so mirroring one
 * repo's artifact under the other's name would ship this repo's code as the other
 * project. `@seanyao/roll` belongs to the old repo and is NOT a release target
 * here.
 *
 * The alias MECHANISM is kept (an empty list, not deleted code) because it is
 * what makes version planning, self-update and the release gate treat every
 * published name identically — adding a name later is one edit, and the release
 * gate keeps its "every name must carry this version" guarantee for free.
 */
export const ROLL_PACKAGE_NAME = "@bipo-ape/roll";

/**
 * Equivalent published names for the same artifact (see {@link ROLL_PACKAGE_NAME}).
 *
 * FIX-1493: intentionally EMPTY. Do not re-add `@seanyao/roll` — that name is the
 * old repo's, and publishing it from here would push this codebase out under the
 * other project's identity. Historical `npx @seanyao/roll@2 migrate` pointers are
 * unrelated: they point users at the retired v2 TOOL, not at a release target.
 */
export const ROLL_PACKAGE_ALIASES = [] as const;

/** Every name roll is published under, primary first. */
export const ROLL_PACKAGE_NAMES: readonly string[] = [ROLL_PACKAGE_NAME, ...ROLL_PACKAGE_ALIASES];

/**
 * US-INSTALL-008 — the product repo, in ONE place.
 *
 * roll moved from a personal account to the org (`BIPOSVC/ape-roll`); the old
 * repo stays readable but frozen. Every user-facing link and every remote
 * lookup reads these, so the next move is one edit rather than a hunt through
 * four files that each learned the address by heart.
 */
export const ROLL_REPO_SLUG = "BIPOSVC/ape-roll";

/** Browser URL for {@link ROLL_REPO_SLUG}. */
export const ROLL_REPO_URL = `https://github.com/${ROLL_REPO_SLUG}`;

/** True when `name` is one of roll's own published package names. */
/**
 * FIX-1493 — names roll has EVER been installed as, including retired ones.
 *
 * Distinct from {@link ROLL_PACKAGE_NAMES} on purpose. That list is "what this
 * repo publishes" (one name). THIS list is "what a running install might call
 * itself", and it must keep recognising retired names so self-update follows the
 * name the owner actually installed instead of silently moving them onto a
 * different package.
 */
export const ROLL_KNOWN_INSTALL_NAMES: readonly string[] = [ROLL_PACKAGE_NAME, "@seanyao/roll"];

export function isRollPackageName(name: string): boolean {
  return ROLL_PACKAGE_NAMES.includes(name);
}

/** Sensible first-release version for a target project with no version lineage. */
export const INITIAL_SEMVER = "0.1.0";

/** Which version scheme a release plan uses. */
export type VersionScheme = "calver" | "semver";

/**
 * Choose the version scheme from the project being released. Only roll's own
 * package uses the calver build-number scheme; every other (user/target)
 * project uses plain semver so its version anchors to its OWN lineage, never to
 * roll's build number (FIX-1247).
 */
export function resolveVersionScheme(packageName: string | null | undefined): VersionScheme {
  // US-INSTALL-007: EVERY name roll publishes under is roll — an alias falling
  // through to semver would plan a different version for the same artifact.
  return typeof packageName === "string" && isRollPackageName(packageName) ? "calver" : "semver";
}

/** Parse a `<major>.<mid>.<seq>` calver string, or null if it does not conform. */
export function parseVersion(v: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), mid: Number(m[2]), seq: Number(m[3]) };
}

/** A parsed semver `<major>.<minor>.<patch>` (core triple only). */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parse a strict `<major>.<minor>.<patch>` semver, or null if it does not conform. */
export function parseSemver(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * The next semver for a target project: bump the patch of the project's own
 * lineage. A missing/unparseable version, or the npm-init default `0.0.0` (no
 * real lineage yet), is a FIRST release → the sensible initial {@link INITIAL_SEMVER}.
 * This is deliberately date-independent: a user project's version has nothing to
 * do with roll's release calendar.
 */
export function computeNextSemver(current: string): string {
  const parsed = parseSemver(current);
  if (!parsed || (parsed.major === 0 && parsed.minor === 0 && parsed.patch === 0)) {
    return INITIAL_SEMVER;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/** The MMDD middle segment for a release date: month * 100 + day. */
function midOf(date: ReleaseDate): number {
  return date.month * 100 + date.day;
}

/**
 * The next version under the calver scheme: the middle segment becomes today's
 * MMDD; the seq bumps when the current version already targets today, else
 * resets to 1. The current major is preserved (falls back to {@link DEFAULT_MAJOR}
 * when the current version is malformed).
 */
export function computeNextCalver(current: string, date: ReleaseDate): string {
  const parsed = parseVersion(current);
  const major = parsed?.major ?? DEFAULT_MAJOR;
  const mid = midOf(date);
  const seq = parsed && parsed.mid === mid ? parsed.seq + 1 : 1;
  return `${major}.${mid}.${seq}`;
}

/**
 * The next version for a release. Under `semver` (the default for every
 * target/user project) the version anchors to the project's OWN lineage — the
 * `date` is ignored (FIX-1247). Under `calver` (roll's own scheme) the date
 * drives the MMDD middle segment. Defaults to `calver` for back-compat with
 * roll's own release path; callers releasing a target project pass `semver`.
 */
export function computeNextVersion(current: string, date: ReleaseDate, scheme: VersionScheme = "calver"): string {
  return scheme === "semver" ? computeNextSemver(current) : computeNextCalver(current, date);
}

/** Inputs for {@link planRelease}. */
export interface ReleasePlanInput {
  currentVersion: string;
  date: ReleaseDate;
  /** True when CHANGELOG.md has releasable notes for the planned release. */
  changelogReady: boolean;
  /**
   * Version scheme for THIS project (FIX-1247). Defaults to `calver` (roll's own
   * scheme) for back-compat; the CLI resolves it from the project's package name
   * so target projects get `semver` and never inherit roll's build number.
   */
  scheme?: VersionScheme;
}

/** A computed release plan — pure data the CLI renders into guidance. */
export interface ReleasePlan {
  currentVersion: string;
  nextVersion: string;
  /** The git tag whose push triggers release.yml: `v<nextVersion>`. */
  tag: string;
  changelogReady: boolean;
}

/** Build the release plan: next version, the `v*` tag, and changelog readiness. */
export function planRelease(input: ReleasePlanInput): ReleasePlan {
  const nextVersion = computeNextVersion(input.currentVersion, input.date, input.scheme ?? "calver");
  return {
    currentVersion: input.currentVersion,
    nextVersion,
    tag: `v${nextVersion}`,
    changelogReady: input.changelogReady,
  };
}
