/**
 * @responsibility Gates bootstrap on verified pending-delivery evidence manifests.
 * FIX-1272 — Pending-delivery evidence manifest + bootstrap artifact gate.
 *
 * The loop's bootstrap gate must never mistake a runner's verified
 * pending-delivery evidence (the dossier/report/screenshots for a still-open
 * delivery PR) for unknown checkout pollution and pause an unrelated eligible
 * card. It must also never be tricked into treating unknown `.roll` files,
 * hash-mismatched files, malformed manifests, symlink escapes, or product-file
 * dirt as "owned".
 *
 * The single acceptance mechanism is a per-cycle, schema-validated manifest
 * written by the RUNNER before the gate ever reads the checkout. A dirty path
 * is `verified` only when it appears exactly once across schema-valid manifests
 * AND the regular file on disk hashes to the recorded SHA-256 AND the file
 * lives inside the repository (no symlink escape, no directory, no product
 * source file). Everything else fails closed: unverified `.roll/**` paths are
 * `unconfirmed`, and every non-`.roll/**` path is `external`.
 *
 * There is deliberately NO blanket `--ignore-dirty`, no path-shape allow-list,
 * and no manual "trust all evidence" switch. A generic `.roll/**` path or a
 * truncated status list can never make the gate permissive.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/** A repository-relative POSIX path from `git status --porcelain`. */
export type DirtyPath = string;

/** The evidence categories a runner records in a manifest. */
export type ManifestFileKind = "dossier" | "report" | "evidence" | "screenshot";

const MANIFEST_FILE_KINDS: readonly ManifestFileKind[] = ["dossier", "report", "evidence", "screenshot"];

export interface ManifestFile {
  /** Repository-relative POSIX path (never absolute, never containing `..`). */
  readonly path: string;
  /** Lowercase hex SHA-256 (64 chars) of the file's exact contents. */
  readonly sha256: string;
  readonly kind: ManifestFileKind;
}

export interface PendingDeliveryEvidenceManifest {
  readonly version: 1;
  readonly cycleId: string;
  readonly storyId: string;
  readonly branch: string;
  readonly files: readonly ManifestFile[];
}

export interface BootstrapArtifactAssessment {
  /** Runner-owned files whose current content matches a valid manifest. */
  readonly verified: readonly DirtyPath[];
  /**
   * FIX-1455: a SANCTIONED append-only runtime ledger (an exact allow-listed
   * path) whose current content still validates as newline-delimited JSON. It is
   * expected to change as normal owner-approved evidence is appended, so it does
   * not pause the gate — but the exception is bounded to the exact path AND to a
   * valid ndjson shape, so a replaced or corrupted ledger falls through to
   * `unconfirmed`. This is NOT a trust-all or ignore-dirty bypass.
   */
  readonly runtimeLedger: readonly DirtyPath[];
  /** `.roll/**` paths that could NOT be confirmed as runner-owned. */
  readonly unconfirmed: readonly DirtyPath[];
  /** Non-`.roll/**` paths (product-file dirt); never verifiable via a manifest. */
  readonly external: readonly DirtyPath[];
}

/**
 * FIX-1455: exact, sanctioned append-only runtime ledgers. Membership is by
 * WHOLE-PATH equality only — never a prefix or glob — so the exception can never
 * widen to arbitrary `.roll/**` content. Currently just the browser
 * approval/audit ledger, which legitimately grows as evidence is collected.
 */
export const SANCTIONED_RUNTIME_LEDGERS: ReadonlySet<string> = new Set([
  ".roll/browser-operations/events.ndjson",
]);

/**
 * Validate that a file is well-formed newline-delimited JSON: every non-empty
 * line parses as JSON. An empty file is valid (a freshly-created ledger). A
 * single malformed line rejects the whole file (fail closed), so a replaced or
 * corrupted ledger is never waved through as a runtime ledger.
 */
export function isValidNdjsonLedger(absPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      JSON.parse(line);
    } catch {
      return false;
    }
  }
  return true;
}

/** Control-plane directory that holds per-cycle evidence manifests. */
export function evidenceManifestDir(projectPath: string): string {
  return join(projectPath, ".roll", "loop", "evidence-manifests");
}

/** Absolute path of the immutable manifest file for a cycle. */
export function evidenceManifestPath(projectPath: string, cycleId: string): string {
  return join(evidenceManifestDir(projectPath), `${manifestFileStem(cycleId)}.json`);
}

/** A `.roll/**` (or bare `.roll`) path — the only namespace a manifest may own. */
export function isRollControlPlanePath(path: string): boolean {
  return path === ".roll" || path.startsWith(".roll/");
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Sanitize a cycle id into a safe, collision-free file stem. */
function manifestFileStem(cycleId: string): string {
  const cleaned = cycleId.replace(/[^A-Za-z0-9._-]/g, "_");
  // Distinguish ids that only differ by sanitized characters.
  const digest = createHash("sha256").update(cycleId, "utf8").digest("hex").slice(0, 12);
  return `${cleaned || "cycle"}-${digest}`;
}

/** True iff a repo-relative POSIX path is safe (relative, no traversal). */
function isSafeRelPath(path: string): boolean {
  if (typeof path !== "string" || path.trim() === "") return false;
  if (path !== path.trim()) return false;
  if (isAbsolute(path)) return false;
  if (path.includes("\\")) return false;
  if (path.startsWith("/") || path.startsWith("./") || path.startsWith("../")) return false;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  return true;
}

/**
 * Validate an untrusted value against the manifest schema. Returns the typed
 * manifest when every field is well-formed, otherwise `undefined` (fail closed).
 * A single malformed file entry rejects the WHOLE manifest — a manifest never
 * partially applies.
 */
export function validatePendingDeliveryEvidenceManifest(raw: unknown): PendingDeliveryEvidenceManifest | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  if (m["version"] !== 1) return undefined;
  const cycleId = m["cycleId"];
  const storyId = m["storyId"];
  const branch = m["branch"];
  if (typeof cycleId !== "string" || cycleId.trim() === "") return undefined;
  if (typeof storyId !== "string" || storyId.trim() === "") return undefined;
  if (typeof branch !== "string" || branch.trim() === "") return undefined;
  const files = m["files"];
  if (!Array.isArray(files)) return undefined;
  const validated: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const entry of files) {
    if (entry === null || typeof entry !== "object") return undefined;
    const f = entry as Record<string, unknown>;
    const path = f["path"];
    const sha256 = f["sha256"];
    const kind = f["kind"];
    if (typeof path !== "string" || !isSafeRelPath(path)) return undefined;
    // A manifest may only ever own control-plane evidence, never product files.
    if (!isRollControlPlanePath(path)) return undefined;
    if (typeof sha256 !== "string" || !HEX64.test(sha256)) return undefined;
    if (typeof kind !== "string" || !MANIFEST_FILE_KINDS.includes(kind as ManifestFileKind)) return undefined;
    // A path may not appear twice within a single manifest.
    if (seen.has(path)) return undefined;
    seen.add(path);
    validated.push({ path, sha256, kind: kind as ManifestFileKind });
  }
  return { version: 1, cycleId, storyId, branch, files: validated };
}

/** SHA-256 of a file's exact bytes; `undefined` when it cannot be read. */
export function hashFileSha256(absPath: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Normalize a git-status path to a repo-relative POSIX path. */
function normalizeDirtyPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

/**
 * Resolve `relPath` under `repositoryRoot` and confirm it is a REGULAR file
 * that physically lives inside the repository (no symlink escape, no
 * directory). Returns the absolute path when safe, otherwise `undefined`.
 */
function safeRegularFileInside(repositoryRoot: string, relPath: string): string | undefined {
  if (!isSafeRelPath(relPath)) return undefined;
  const abs = resolve(repositoryRoot, relPath);
  let rootReal: string;
  try {
    rootReal = realpathSync(repositoryRoot);
  } catch {
    return undefined;
  }
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return undefined;
  }
  // lstat does not follow the final component: a symlink is rejected outright.
  if (!st.isFile()) return undefined;
  // Guard against an intermediate symlink component escaping the repo.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return undefined;
  }
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (!real.startsWith(prefix)) return undefined;
  return abs;
}

/**
 * Classify every dirty path against the runner-written manifests. Pure with
 * respect to its inputs and the filesystem state under `repositoryRoot`; it
 * never mutates anything. Malformed manifests are dropped (fail closed).
 *
 * A `.roll/**` path is `verified` iff its CURRENT on-disk SHA-256 equals the
 * hash recorded for that path by at least one schema-valid manifest — and the
 * file is a regular file living inside the repository. Recording a path across
 * several per-cycle manifests (a re-delivered or status-evolving file) is
 * therefore fine, because only the entry whose hash matches the live content
 * can ever confirm it; an entry with a stale hash simply does not match. This
 * cannot be tricked by an unknown path, a tampered file (hash no longer
 * matches), a symlink escape, a directory, or any product-file dirt.
 */
export function assessBootstrapArtifacts(
  dirtyPaths: readonly DirtyPath[],
  manifests: readonly PendingDeliveryEvidenceManifest[],
  repositoryRoot: string,
): BootstrapArtifactAssessment {
  // Build path → { accepted SHA values } from schema-valid manifests only.
  const expected = new Map<string, Set<string>>();
  for (const candidate of manifests) {
    const valid = validatePendingDeliveryEvidenceManifest(candidate);
    if (valid === undefined) continue;
    for (const file of valid.files) {
      const set = expected.get(file.path) ?? new Set<string>();
      set.add(file.sha256);
      expected.set(file.path, set);
    }
  }

  const verified: DirtyPath[] = [];
  const runtimeLedger: DirtyPath[] = [];
  const unconfirmed: DirtyPath[] = [];
  const external: DirtyPath[] = [];
  const seen = new Set<string>();

  for (const rawPath of dirtyPaths) {
    const path = normalizeDirtyPath(rawPath);
    if (path === "" || seen.has(path)) continue;
    seen.add(path);

    // Product-file dirt can never be verified by a manifest.
    if (!isRollControlPlanePath(path)) {
      external.push(path);
      continue;
    }

    // FIX-1455: an EXACT sanctioned append-only runtime ledger (e.g. the browser
    // approval/audit ledger) is expected to grow with normal evidence. Accept it
    // ONLY when it is a safe regular file inside the repo AND still validates as
    // ndjson; a replaced / corrupted / symlinked ledger falls through to
    // `unconfirmed`. Bounded to the exact path — never a prefix, glob, or bypass.
    if (SANCTIONED_RUNTIME_LEDGERS.has(path)) {
      const ledgerAbs = safeRegularFileInside(repositoryRoot, path);
      if (ledgerAbs !== undefined && isValidNdjsonLedger(ledgerAbs)) {
        runtimeLedger.push(path);
      } else {
        unconfirmed.push(path);
      }
      continue;
    }

    const accepted = expected.get(path);
    if (accepted === undefined) {
      // No manifest claims this `.roll` path → fail closed.
      unconfirmed.push(path);
      continue;
    }

    const abs = safeRegularFileInside(repositoryRoot, path);
    if (abs === undefined) {
      // Symlink escape, directory, or file outside the repo → fail closed.
      unconfirmed.push(path);
      continue;
    }
    const gotSha = hashFileSha256(abs);
    if (gotSha === undefined || !accepted.has(gotSha)) {
      // Missing, hash-mismatched, or unreadable → fail closed.
      unconfirmed.push(path);
      continue;
    }
    verified.push(path);
  }

  return { verified, runtimeLedger, unconfirmed, external };
}

export interface BuildManifestInput {
  readonly cycleId: string;
  readonly storyId: string;
  readonly branch: string;
  readonly repositoryRoot: string;
  /** Candidate evidence files as repo-relative POSIX paths with their kind. */
  readonly files: ReadonlyArray<{ path: string; kind: ManifestFileKind }>;
}

/**
 * Build a manifest by hashing each candidate file's current contents. A
 * candidate that is not a safe regular file inside the repo, or under a
 * non-`.roll` path, is skipped (never recorded). The returned manifest is
 * always schema-valid.
 */
export function buildPendingDeliveryEvidenceManifest(input: BuildManifestInput): PendingDeliveryEvidenceManifest {
  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const candidate of input.files) {
    const path = normalizeDirtyPath(candidate.path);
    if (path === "" || seen.has(path)) continue;
    if (!isRollControlPlanePath(path)) continue;
    const abs = safeRegularFileInside(input.repositoryRoot, path);
    if (abs === undefined) continue;
    const sha256 = hashFileSha256(abs);
    if (sha256 === undefined) continue;
    seen.add(path);
    files.push({ path, sha256, kind: candidate.kind });
  }
  return { version: 1, cycleId: input.cycleId, storyId: input.storyId, branch: input.branch, files };
}

/**
 * Atomically write a per-cycle manifest to control-plane state (tmp + rename),
 * keyed by cycle id so concurrent cycles cannot overwrite each other. Repeated
 * writes of identical content are idempotent.
 */
export function writePendingDeliveryEvidenceManifest(
  projectPath: string,
  manifest: PendingDeliveryEvidenceManifest,
): string {
  const dir = evidenceManifestDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const target = evidenceManifestPath(projectPath, manifest.cycleId);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, target);
  return target;
}

/**
 * Read every valid manifest from control-plane state. Files that are missing,
 * unreadable, non-JSON, or schema-invalid are silently skipped (fail closed).
 */
export function readPendingDeliveryEvidenceManifests(projectPath: string): PendingDeliveryEvidenceManifest[] {
  const dir = evidenceManifestDir(projectPath);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PendingDeliveryEvidenceManifest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const valid = validatePendingDeliveryEvidenceManifest(raw);
    if (valid !== undefined) out.push(valid);
  }
  return out;
}
