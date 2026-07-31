/**
 * Doc-drift verdict (US-RULE-004a) — the SHARED pure decision for "a declared
 * source surface changed without its declared documentation". This module is
 * the single home for BOTH doc-gap rulesets:
 *
 *  - the US-META-010 attest doc-gap signal ({@link assessDocGapFromFiles},
 *    extracted verbatim from commands/attest.ts — attest.ts now imports and
 *    re-exports it, so there is exactly ONE implementation, never two copies
 *    that can drift apart);
 *  - the rules-registry verdict ({@link checkDocDrift}) over the
 *    `doc_surfaces` declared in `policy/rules.yaml` (US-RULE-001).
 *
 * Purity contract: every function here is deterministic over its arguments —
 * no filesystem, no clock, no env, and NO exemption input. Callers that want
 * the changed-path set (git diff) or want to persist a soft hit do that I/O
 * themselves and pass plain data in.
 */
import { createHash } from "node:crypto";
import { t, v3Catalog, type DocSurface, type Lang, type RollEvent } from "@roll/spec";
import { EventBus, nodeEventStore, type DocGapWarning, type EventStore } from "@roll/core";

const DOC_ALIGNMENT_PATTERNS: readonly RegExp[] = [
  /^README(?:_[A-Z]+)?\.md$/,
  /^AGENTS\.md$/,
  /^CHANGELOG\.md$/,
  /^docs\//,
  /^guide\//,
  /^site\//,
];

const USER_VISIBLE_SURFACE_PATTERNS: readonly RegExp[] = [
  /^packages\/cli\/src\/commands\/[^/]+\.ts$/,
  /^packages\/cli\/src\/commands\/index\.ts$/,
  /^packages\/cli\/src\/index\.ts$/,
  /^packages\/cli\/src\/render\.ts$/,
  /^packages\/spec\/src\/i18n\//,
];

/** Normalize one diff path: trimmed, forward slashes, no leading `./`. */
export function normalizeDiffPath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Normalize + dedupe a changed-path list, first occurrence wins (pure). */
export function normalizeChangedPaths(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    const normalized = normalizeDiffPath(file);
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function isDocAlignmentFile(file: string): boolean {
  const normalized = normalizeDiffPath(file);
  return DOC_ALIGNMENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isUserVisibleSurfaceFile(file: string): boolean {
  const normalized = normalizeDiffPath(file);
  return USER_VISIBLE_SURFACE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * US-META-010 shadow DoD signal (moved from commands/attest.ts unchanged):
 * user-visible surface changed without any doc-alignment file in the same
 * diff. Warning evidence only; never changes the acceptance gate verdict.
 */
export function assessDocGapFromFiles(files: readonly string[]): DocGapWarning | undefined {
  const changedFiles = normalizeChangedPaths(files);
  const visibleFiles = changedFiles.filter(isUserVisibleSurfaceFile);
  if (visibleFiles.length === 0) return undefined;
  if (changedFiles.some(isDocAlignmentFile)) return undefined;
  return { changedFiles, visibleFiles };
}

/**
 * Match one normalized path against a declared registry pattern. The registry
 * vocabulary (US-RULE-001) uses exact paths and `/**` prefix globs only; keep
 * the matcher exactly that small — no regex, no `*`-in-the-middle magic.
 */
export function matchDeclaredPath(pattern: string, normalizedPath: string): boolean {
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
  }
  return normalizedPath === pattern;
}

/** One surface whose declared sources changed without its declared docs. */
export interface DocDriftSurfaceHit {
  readonly surfaceId: string;
  readonly matchedPaths: readonly string[];
}

/** The pure doc-drift verdict over a changed-path set. */
export interface DocDriftVerdict {
  /** Normalized, de-duplicated inputs (what the verdict actually judged). */
  readonly changedPaths: readonly string[];
  /** Every matched surface, in surface declaration order. */
  readonly hits: readonly DocDriftSurfaceHit[];
}

/**
 * US-RULE-004a — the pure doc-drift verdict. For each declared surface: a hit
 * iff ≥1 declared source path changed AND no declared doc path changed;
 * changing ANY declared doc clears that surface's hit; unrelated paths never
 * hit. Pure: normalization + dedupe only, no I/O, no exemption channel.
 */
export function checkDocDrift(input: {
  readonly changedPaths: readonly string[];
  readonly surfaces: readonly DocSurface[];
}): DocDriftVerdict {
  const changedPaths = normalizeChangedPaths(input.changedPaths);
  const hits: DocDriftSurfaceHit[] = [];
  for (const surface of input.surfaces) {
    const matchedPaths = changedPaths.filter((path) =>
      surface.paths.some((pattern) => matchDeclaredPath(pattern, path)),
    );
    if (matchedPaths.length === 0) continue;
    const docTouched = changedPaths.some((path) =>
      surface.docs.some((pattern) => matchDeclaredPath(pattern, path)),
    );
    if (docTouched) continue;
    hits.push({ surfaceId: surface.id, matchedPaths });
  }
  return { changedPaths, hits };
}

/** Identity of one auditable soft hit (US-RULE-004a aggregate DocDriftHit). */
export interface DocDriftHitKey {
  readonly cycleId: string;
  readonly storyId: string;
  /** The diff baseline the changed-path set was computed against. */
  readonly baseline: string;
  readonly verdict: DocDriftVerdict;
}

/**
 * Stable hit identity: sha256 over cycle + story + baseline + the SORTED set
 * of matched surface ids. Sorting makes the id independent of the registry's
 * declaration order, so the same drift retried against the same baseline
 * always derives the same hitId — the idempotency key.
 */
export function docDriftHitId(key: DocDriftHitKey): string {
  const surfaceIds = key.verdict.hits.map((h) => h.surfaceId).sort();
  return createHash("sha256")
    .update([key.cycleId, key.storyId, key.baseline, ...surfaceIds].join("\n"))
    .digest("hex");
}

/** Build the `doc_drift_soft_hit` event for a hit key (pure). */
export function docDriftSoftHitEvent(key: DocDriftHitKey, ts: number): RollEvent {
  return {
    type: "doc_drift_soft_hit",
    hitId: docDriftHitId(key),
    cycleId: key.cycleId,
    storyId: key.storyId,
    baseline: key.baseline,
    surfaces: key.verdict.hits.map((h) => h.surfaceId),
    ts,
  };
}

export interface DocDriftSoftHitRecord {
  readonly hitId: string;
  /** false when the hit already existed (retry) or the verdict was clean. */
  readonly appended: boolean;
}

/**
 * Record a soft hit into the event stream. Idempotent: the stream is read for
 * an existing `doc_drift_soft_hit` with the same hitId first, and a retry
 * appends NOTHING. The append itself is the bus's single atomic O_APPEND
 * write — if it fails, the error propagates and no partial duplicate record
 * is left behind. A clean verdict writes nothing.
 *
 * This is a FACT append only — never an adjudication: the event carries no
 * actor, accepts no owner input, and claims no human/peer verdict.
 */
export function recordDocDriftSoftHit(opts: DocDriftHitKey & {
  readonly eventsPath: string;
  readonly ts: number;
  readonly store?: EventStore;
}): DocDriftSoftHitRecord {
  const bus = new EventBus(opts.store ?? nodeEventStore);
  const hitId = docDriftHitId(opts);
  if (opts.verdict.hits.length === 0) return { hitId, appended: false };
  const exists = bus
    .readEvents(opts.eventsPath)
    .some((ev) => ev.type === "doc_drift_soft_hit" && ev.hitId === hitId);
  if (exists) return { hitId, appended: false };
  bus.appendEvent(opts.eventsPath, docDriftSoftHitEvent(opts, opts.ts));
  return { hitId, appended: true };
}

/**
 * Render the soft-hit diagnostic in the resolved locale (single language per
 * output — the catalog carries both en and zh). Pure string building.
 */
export function renderDocDriftSoftHit(hitId: string, verdict: DocDriftVerdict, lang: Lang): string {
  const lines = [t(v3Catalog, lang, "doc_drift.soft_hit.summary", hitId, verdict.hits.length)];
  for (const hit of verdict.hits) {
    lines.push(t(v3Catalog, lang, "doc_drift.soft_hit.surface", hit.surfaceId, hit.matchedPaths.join(", ")));
  }
  return `${lines.join("\n")}\n`;
}

export interface DocDriftSoftCheckResult {
  readonly verdict: DocDriftVerdict;
  readonly hitId: string;
  readonly appended: boolean;
  /** Soft mode NEVER blocks: always 0, hit or not. */
  readonly exitCode: 0;
  /** The locale-rendered diagnostic ("" when the verdict is clean). */
  readonly output: string;
}

/**
 * US-RULE-004a — the soft doc-drift check the loop/CI adapters share: run the
 * pure verdict, record the auditable soft hit (when an eventsPath is given),
 * and return exit 0 + a bilingual-catalogued diagnostic. It emits ONLY
 * `doc_drift_soft_hit` — never `doc_drift_adjudicated` — and takes no actor
 * input, so nothing here can masquerade as a human/peer verdict.
 */
export function runDocDriftSoftCheck(opts: {
  readonly changedPaths: readonly string[];
  readonly surfaces: readonly DocSurface[];
  readonly cycleId: string;
  readonly storyId: string;
  readonly baseline: string;
  readonly lang: Lang;
  readonly eventsPath?: string;
  readonly ts?: number;
  readonly store?: EventStore;
}): DocDriftSoftCheckResult {
  const verdict = checkDocDrift({ changedPaths: opts.changedPaths, surfaces: opts.surfaces });
  const key = { cycleId: opts.cycleId, storyId: opts.storyId, baseline: opts.baseline, verdict };
  const hitId = docDriftHitId(key);
  if (verdict.hits.length === 0) {
    return { verdict, hitId, appended: false, exitCode: 0, output: "" };
  }
  let appended = false;
  if (opts.eventsPath !== undefined) {
    appended = recordDocDriftSoftHit({
      ...key,
      eventsPath: opts.eventsPath,
      ts: opts.ts ?? Date.now(),
      ...(opts.store !== undefined ? { store: opts.store } : {}),
    }).appended;
  }
  return { verdict, hitId, appended, exitCode: 0, output: renderDocDriftSoftHit(hitId, verdict, opts.lang) };
}
