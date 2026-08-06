/**
 * @responsibility Reconciles the latest released version from the real release truth source.
 */
/**
 * FIX-368 — reconcile the dossier's "latest released version" from the REAL
 * source of truth, not from the `release:gate` event cache.
 *
 * Why this exists: `releaseTruthBoard` + `collectReleasePanel` used to derive
 * the headline version SOLELY from `release:gate` events in events.ndjson. But
 * the release flow stopped emitting that event (the old `release ship recordGate`
 * writer is gone), so the dossier froze at the last release that happened to
 * emit one (v3.612.2) while reality moved on (v3.619.1). A truth projection must
 * RECONCILE reality, never read a cache that can go stale.
 *
 * The real source of truth for "what shipped" is, in priority order:
 *   1. the newest `v*` git tag whose major matches the running package version
 *      (a `v<ver>` tag push is exactly what triggers a publish — `release.yml`);
 *   2. the CHANGELOG's top released section (`## v<ver> — <date>`);
 *   3. `v<package.json version>` (the running version is the floor of "latest");
 *   4. the `release:gate` tag from the event stream (the legacy cache — last).
 *
 * Tags are filtered to the running major so legacy calver tags from a former
 * scheme (e.g. `v2026.601.4`, `v2.*`) cannot masquerade as "latest". The
 * comparison reuses {@link parseVersion} from @roll/core (the calver parser the
 * release planner already trusts).
 *
 * Purity: {@link reconcileLatestRelease} is a PURE function over candidate
 * strings — no I/O, no clock — so it unit-tests deterministically. The reader
 * ({@link defaultReleaseFactsReader}) is the only impure seam and is injectable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVersion } from "@roll/core";

/** Raw facts about released versions, gathered from reality (all optional). */
export interface ReleaseFacts {
  /** All `v*` tag names (e.g. `["v3.619.1", "v3.618.3", …]`). Unordered. */
  tags?: string[];
  /** The running `package.json` version (no `v` prefix), e.g. `"3.619.1"`. */
  packageVersion?: string;
  /**
   * All RELEASED version tags from the CHANGELOG (`## v… — date` sections),
   * e.g. `["v3.619.1", "v3.618.3", …]`. The full history is fed (not just the
   * top) so `prevTag` is recoverable even when git tags aren't fetched.
   */
  changelogTags?: string[];
  /** The newest `release:gate` tag in the event stream (the legacy cache). */
  gateTag?: string;
}

/** Reconciled release identity: the true latest tag + the one before it. */
export interface ReconciledRelease {
  /** The actual latest released tag (e.g. `v3.619.1`), or undefined when unknown. */
  latestTag?: string;
  /** The previous released tag (the one before latest), when knowable. */
  prevTag?: string;
}

/** Strip a single leading `v`/`V` from a tag to get the bare version string. */
function bareVersion(tag: string): string {
  return tag.replace(/^[vV]/, "");
}

/** Order two calver versions; non-conforming strings sort BELOW conforming ones. */
function compareVersion(a: string, b: string): number {
  const pa = parseVersion(bareVersion(a));
  const pb = parseVersion(bareVersion(b));
  if (pa === null && pb === null) return a.localeCompare(b);
  if (pa === null) return -1;
  if (pb === null) return 1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.mid !== pb.mid) return pa.mid - pb.mid;
  return pa.seq - pb.seq;
}

/**
 * Reconcile the latest (and previous) released tag from candidate facts.
 *
 * Candidates are normalized to `v`-prefixed tags and de-duplicated; the set is
 * filtered to the running major (from `packageVersion`) so a former calver
 * scheme's tags cannot outrank the live one. The newest by {@link compareVersion}
 * wins; `prevTag` is the next-newest distinct version. When no candidate is a
 * conforming calver version, the single best raw string is still returned so a
 * pre-calver project shows *something* rather than nothing.
 */
export function reconcileLatestRelease(facts: ReleaseFacts): ReconciledRelease {
  const raw: string[] = [];
  for (const t of facts.tags ?? []) if (typeof t === "string" && t.trim() !== "") raw.push(t.trim());
  for (const t of facts.changelogTags ?? []) if (typeof t === "string" && t.trim() !== "") raw.push(t.trim());
  if (facts.packageVersion !== undefined && facts.packageVersion.trim() !== "") raw.push(`v${bareVersion(facts.packageVersion.trim())}`);
  if (facts.gateTag !== undefined && facts.gateTag.trim() !== "") raw.push(facts.gateTag.trim());

  // Normalize to a single `v` prefix + de-dup on the bare version.
  const byVersion = new Map<string, string>();
  for (const r of raw) {
    const tag = `v${bareVersion(r)}`;
    if (!byVersion.has(bareVersion(tag))) byVersion.set(bareVersion(tag), tag);
  }
  let candidates = [...byVersion.values()];
  if (candidates.length === 0) return {};

  // Filter to the running major when known, so legacy-scheme tags don't win.
  const runMajor = facts.packageVersion !== undefined ? parseVersion(bareVersion(facts.packageVersion))?.major : undefined;
  if (runMajor !== undefined) {
    const sameMajor = candidates.filter((t) => parseVersion(bareVersion(t))?.major === runMajor);
    if (sameMajor.length > 0) candidates = sameMajor;
  }

  candidates.sort(compareVersion); // ascending
  const latestTag = candidates.at(-1);
  const prevTag = candidates.length >= 2 ? candidates.at(-2) : undefined;
  return {
    ...(latestTag !== undefined ? { latestTag } : {}),
    ...(prevTag !== undefined ? { prevTag } : {}),
  };
}

/** A function that gathers release facts from a project on disk (injectable). */
export type ReleaseFactsReader = (projectPath: string) => ReleaseFacts;

/** Read all `v*` git tags in `projectPath` (best-effort; [] on any failure). */
function readGitTags(projectPath: string): string[] {
  try {
    const out = execFileSync("git", ["-C", projectPath, "tag", "--list", "v*"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  } catch {
    return [];
  }
}

/** Read the `package.json` version of `projectPath` (best-effort). */
function readPackageVersion(projectPath: string): string | undefined {
  try {
    const obj = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf8")) as { version?: unknown };
    return typeof obj.version === "string" && obj.version.trim() !== "" ? obj.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** All RELEASED version tags from the CHANGELOG (`## v… — date` sections). */
function readChangelogTags(projectPath: string): string[] {
  const out: string[] = [];
  try {
    const text = readFileSync(join(projectPath, "CHANGELOG.md"), "utf8");
    for (const line of text.split("\n")) {
      const m = /^## (v\S+)\s+—\s+\S+/.exec(line);
      if (m !== null && m[1] !== undefined) out.push(m[1]);
    }
  } catch {
    /* best-effort */
  }
  return out;
}

/** The newest `release:gate` tag in the event stream (the legacy cache). */
function readGateTag(projectPath: string): string | undefined {
  const path = join(projectPath, ".roll", "loop", "events.ndjson");
  if (!existsSync(path)) return undefined;
  let last: string | undefined;
  try {
    // Cheap, dependency-free scan: the gate event carries `"type":"release:gate"`
    // and a `"tag":"v…"`; the newest line wins. (Reader, not a parser — the
    // pure reconciler does the real work; this only feeds it the legacy hint.)
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes('"type":"release:gate"')) continue;
      const m = /"tag":"(v[^"]+)"/.exec(line);
      if (m !== null) last = m[1];
    }
  } catch {
    /* best-effort */
  }
  return last;
}

/** Default reader: gathers tags + package version + CHANGELOG top + gate tag. */
export const defaultReleaseFactsReader: ReleaseFactsReader = (projectPath) => {
  const facts: ReleaseFacts = {};
  const tags = readGitTags(projectPath);
  if (tags.length > 0) facts.tags = tags;
  const pkg = readPackageVersion(projectPath);
  if (pkg !== undefined) facts.packageVersion = pkg;
  const clTags = readChangelogTags(projectPath);
  if (clTags.length > 0) facts.changelogTags = clTags;
  const gate = readGateTag(projectPath);
  if (gate !== undefined) facts.gateTag = gate;
  return facts;
};

/** Reconcile the latest/prev released tag for a project (reader injectable). */
export function reconcileReleaseForProject(
  projectPath: string,
  reader: ReleaseFactsReader = defaultReleaseFactsReader,
): ReconciledRelease {
  return reconcileLatestRelease(reader(projectPath));
}
