import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  classifyRequirementArchiveIntegrity,
  MAX_REQUIREMENT_BODY_BYTES,
  MAX_REQUIREMENT_CONTEXT_BYTES,
  MAX_REQUIREMENT_CONTEXT_FILES,
  requirementRevisionKey,
} from "@roll/core";
import {
  parseRequirementSourceManifest,
  type RequirementArchiveAudit,
  type RequirementArchiveFinding,
  type RequirementContextDescriptor,
  type RequirementPreviousRevision,
  type RequirementSourceManifest,
} from "@roll/spec";

export interface RequirementArchiveAuditInput {
  readonly workspaceRoot: string;
  readonly provider: string;
  readonly requirementId: string;
  readonly limits?: Partial<RequirementArchiveAuditLimits>;
}

export interface RequirementArchiveAuditLimits {
  readonly maxSourceBytes: number;
  readonly maxCaptureBytes: number;
  readonly maxRevisions: number;
  readonly maxRevisionEntries: number;
  readonly maxContextFiles: number;
  readonly maxContextEntries: number;
  readonly maxContextBytes: number;
  readonly maxBodyBytes: number;
  readonly maxDepth: number;
}

export interface RequirementArchiveAuditDependencies {
  readonly afterStatFile?: (path: string) => void;
  readonly afterReadFile?: (path: string) => void;
  readonly beforeOpenDirectory?: (path: string) => void;
}

const DEFAULT_LIMITS: RequirementArchiveAuditLimits = {
  maxSourceBytes: 1024 * 1024,
  maxCaptureBytes: 1024 * 1024,
  maxRevisions: 256,
  maxRevisionEntries: 256,
  maxContextFiles: MAX_REQUIREMENT_CONTEXT_FILES,
  maxContextEntries: MAX_REQUIREMENT_CONTEXT_FILES * 2,
  maxContextBytes: MAX_REQUIREMENT_CONTEXT_BYTES,
  maxBodyBytes: MAX_REQUIREMENT_BODY_BYTES,
  maxDepth: 32,
};

const READ_CHUNK_BYTES = 64 * 1024;

type ReadFailureKind = "missing" | "unsafe" | "limit" | "changed";

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

type StableRead =
  | { readonly ok: true; readonly content: Buffer; readonly identity: FileIdentity }
  | { readonly ok: false; readonly kind: ReadFailureKind };

type DirectoryAnchor =
  | { readonly ok: true; readonly identity: FileIdentity }
  | { readonly ok: false; readonly kind: ReadFailureKind };

interface AnchoredDirectory {
  readonly path: string;
  readonly evidencePath: string;
  readonly revision?: string;
  readonly identity: FileIdentity;
}

function identity(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameNodeIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableReadFile(
  path: string,
  maximumBytes: number,
  deps: RequirementArchiveAuditDependencies,
): StableRead {
  let pathBefore: Stats;
  try {
    pathBefore = lstatSync(path);
  } catch {
    return { ok: false, kind: "missing" };
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) return { ok: false, kind: "unsafe" };
  try {
    if (realpathSync(path) !== resolve(path)) return { ok: false, kind: "unsafe" };
  } catch {
    return { ok: false, kind: "changed" };
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, kind: "changed" };
  }
  try {
    const before = fstatSync(descriptor);
    const beforeIdentity = identity(before);
    if (
      !before.isFile() || !sameIdentity(identity(pathBefore), beforeIdentity) ||
      !anchoredFilePath(path, beforeIdentity)
    ) {
      return { ok: false, kind: "changed" };
    }
    if (before.size > maximumBytes) return { ok: false, kind: "limit" };
    deps.afterStatFile?.(path);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = maximumBytes - total;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining + 1));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) return { ok: false, kind: "limit" };
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const content = Buffer.concat(chunks, total);
    deps.afterReadFile?.(path);
    const after = fstatSync(descriptor);
    const afterIdentity = identity(after);
    if (
      !sameIdentity(beforeIdentity, afterIdentity) ||
      !anchoredFilePath(path, afterIdentity) ||
      after.size !== content.byteLength
    ) {
      return { ok: false, kind: "changed" };
    }
    return { ok: true, content, identity: afterIdentity };
  } catch {
    return { ok: false, kind: "changed" };
  } finally {
    closeSync(descriptor);
  }
}

function anchoredFilePath(path: string, anchor: FileIdentity): boolean {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && stat.isFile() &&
      realpathSync(path) === resolve(path) && sameIdentity(identity(stat), anchor);
  } catch {
    return false;
  }
}

function anchoredDirectoryPath(path: string, anchor: FileIdentity): boolean {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && stat.isDirectory() &&
      realpathSync(path) === resolve(path) && sameIdentity(identity(stat), anchor);
  } catch {
    return false;
  }
}

function stableAnchorDirectory(
  path: string,
  deps: RequirementArchiveAuditDependencies,
): DirectoryAnchor {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch {
    return { ok: false, kind: "missing" };
  }
  if (before.isSymbolicLink() || !before.isDirectory()) return { ok: false, kind: "unsafe" };
  try {
    if (realpathSync(path) !== resolve(path)) return { ok: false, kind: "unsafe" };
  } catch {
    return { ok: false, kind: "changed" };
  }
  let descriptor: number;
  try {
    deps.beforeOpenDirectory?.(path);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, kind: "changed" };
  }
  try {
    const anchorBeforeStat = fstatSync(descriptor);
    const anchorBefore = identity(anchorBeforeStat);
    if (!anchorBeforeStat.isDirectory() || !sameIdentity(identity(before), anchorBefore) || !anchoredDirectoryPath(path, anchorBefore)) {
      return { ok: false, kind: "changed" };
    }
    const anchorAfterStat = fstatSync(descriptor);
    const anchorAfter = identity(anchorAfterStat);
    if (
      !anchorAfterStat.isDirectory() || !sameIdentity(anchorBefore, anchorAfter) ||
      !anchoredDirectoryPath(path, anchorAfter)
    ) {
      return { ok: false, kind: "changed" };
    }
    return { ok: true, identity: anchorAfter };
  } catch {
    return { ok: false, kind: "changed" };
  } finally {
    closeSync(descriptor);
  }
}

function revalidateDirectoryAnchors(
  anchors: readonly AnchoredDirectory[],
  deps: RequirementArchiveAuditDependencies,
  findings: RequirementArchiveFinding[],
): void {
  const changedRoots: string[] = [];
  for (const anchor of anchors) {
    if (changedRoots.some((root) => contained(root, anchor.path))) continue;
    const current = stableAnchorDirectory(anchor.path, deps);
    if (current.ok && sameNodeIdentity(anchor.identity, current.identity)) continue;
    changedRoots.push(anchor.path);
    findings.push(anchor.revision === undefined
      ? { code: "archive_changed_during_read", evidencePath: anchor.evidencePath }
      : { code: "archive_changed_during_read", revision: anchor.revision, evidencePath: anchor.evidencePath });
  }
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function safeSegment(value: string, pattern: RegExp): boolean {
  return value === value.trim() && pattern.test(value);
}

function findingForReadFailure(
  failure: ReadFailureKind,
  evidencePath: string,
  revision?: string,
): RequirementArchiveFinding {
  const code = failure === "changed"
    ? "archive_changed_during_read"
    : failure === "missing" ? "revision_missing" : "unsafe_archive_path";
  return revision === undefined ? { code, evidencePath } : { code, revision, evidencePath };
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function samePreviousRevisions(
  left: readonly RequirementPreviousRevision[],
  right: readonly RequirementPreviousRevision[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedHistoryForRevision(
  source: RequirementSourceManifest,
  revision: string,
): readonly RequirementPreviousRevision[] | undefined {
  if (revision === source.revision) return source.previousRevisions;
  const index = source.previousRevisions.findIndex((entry) => entry.revision === revision);
  return index < 0 ? undefined : source.previousRevisions.slice(0, index);
}

function captureMetadataMatches(
  source: RequirementSourceManifest,
  capture: RequirementSourceManifest,
  revision: string,
): boolean {
  const expectedHistory = expectedHistoryForRevision(source, revision);
  const expectedCapturedAt = revision === source.revision
    ? source.capturedAt
    : source.previousRevisions.find((entry) => entry.revision === revision)?.capturedAt;
  if (
    expectedHistory === undefined || expectedCapturedAt === undefined ||
    capture.revision !== revision || capture.capturedAt !== expectedCapturedAt ||
    !samePreviousRevisions(capture.previousRevisions, expectedHistory)
  ) {
    return false;
  }
  if (revision !== source.revision) return true;
  // source.yaml.stories is mutable Story-link authority. capture.yaml.stories
  // is only the link projection at capture time and is not an archive trust anchor.
  return JSON.stringify(capture.requirement) === JSON.stringify(source.requirement) &&
    JSON.stringify(capture.context) === JSON.stringify(source.context) &&
    JSON.stringify(capture.attest) === JSON.stringify(source.attest);
}

function captureIdentityMatches(
  source: RequirementSourceManifest,
  capture: RequirementSourceManifest,
): boolean {
  return capture.requirementId === source.requirementId &&
    capture.provider === source.provider && capture.ref === source.ref;
}

type DeclaredContextPlan =
  | { readonly ok: true; readonly directories: readonly string[] }
  | { readonly ok: false; readonly evidencePath: string };

function declaredContextPlan(
  descriptors: readonly RequirementContextDescriptor[],
  limits: RequirementArchiveAuditLimits,
): DeclaredContextPlan {
  if (descriptors.length > limits.maxContextFiles) return { ok: false, evidencePath: "" };
  const entries = new Set<string>();
  const directories = new Set<string>();
  let totalBytes = 0;
  for (const descriptor of descriptors) {
    const segments = descriptor.path.split("/");
    if (segments.length > limits.maxDepth) return { ok: false, evidencePath: descriptor.path };
    entries.add(descriptor.path);
    let directory = "";
    for (const segment of segments.slice(0, -1)) {
      directory = directory === "" ? segment : `${directory}/${segment}`;
      directories.add(directory);
      entries.add(directory);
    }
    totalBytes += descriptor.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxContextBytes) {
      return { ok: false, evidencePath: descriptor.path };
    }
    if (entries.size > limits.maxContextEntries) return { ok: false, evidencePath: descriptor.path };
  }
  return {
    ok: true,
    directories: [...directories].sort((left, right) =>
      left.split("/").length - right.split("/").length || compareText(left, right)
    ),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scanRevision(
  requirementRoot: string,
  source: RequirementSourceManifest,
  revision: string,
  limits: RequirementArchiveAuditLimits,
  deps: RequirementArchiveAuditDependencies,
  findings: RequirementArchiveFinding[],
  directoryAnchors: AnchoredDirectory[],
): void {
  const revisionKey = requirementRevisionKey(revision);
  const revisionRelative = `revisions/${revisionKey}`;
  const revisionRoot = join(requirementRoot, "revisions", revisionKey);
  const revisionAnchor = stableAnchorDirectory(revisionRoot, deps);
  if (!revisionAnchor.ok) {
    findings.push(findingForReadFailure(revisionAnchor.kind, revisionRelative, revision));
    return;
  }
  directoryAnchors.push({
    path: revisionRoot,
    evidencePath: revisionRelative,
    revision,
    identity: revisionAnchor.identity,
  });
  const captureRelative = `${revisionRelative}/capture.yaml`;
  const captureRead = stableReadFile(join(revisionRoot, "capture.yaml"), limits.maxCaptureBytes, deps);
  if (!captureRead.ok) {
    findings.push(findingForReadFailure(captureRead.kind, captureRelative, revision));
    return;
  }
  let capture: RequirementSourceManifest | undefined;
  try {
    const parsed = parseRequirementSourceManifest(JSON.parse(captureRead.content.toString("utf8")));
    if (parsed.ok) capture = parsed.value;
  } catch {
    capture = undefined;
  }
  if (capture === undefined || !captureIdentityMatches(source, capture)) {
    findings.push({ code: "manifest_invalid", revision, evidencePath: captureRelative });
    return;
  }
  if (!captureMetadataMatches(source, capture, revision)) {
    findings.push({ code: "revision_metadata_mismatch", revision, evidencePath: captureRelative });
    return;
  }

  const bodyRelative = `${revisionRelative}/requirement.md`;
  if (capture.requirement.bytes > limits.maxBodyBytes) {
    findings.push({ code: "unsafe_archive_path", revision, evidencePath: bodyRelative });
  } else {
    const bodyRead = stableReadFile(join(revisionRoot, "requirement.md"), limits.maxBodyBytes, deps);
    if (!bodyRead.ok) {
      findings.push(findingForReadFailure(bodyRead.kind, bodyRelative, revision));
    } else if (
      bodyRead.content.byteLength !== capture.requirement.bytes ||
      sha256(bodyRead.content) !== capture.requirement.sha256
    ) {
      findings.push({ code: "content_digest_mismatch", revision, evidencePath: bodyRelative });
    }
  }

  const contextRelative = `${revisionRelative}/context`;
  const contextRoot = join(revisionRoot, "context");
  const contextAnchor = stableAnchorDirectory(contextRoot, deps);
  if (!contextAnchor.ok) {
    findings.push(findingForReadFailure(contextAnchor.kind, contextRelative, revision));
    return;
  }
  directoryAnchors.push({
    path: contextRoot,
    evidencePath: contextRelative,
    revision,
    identity: contextAnchor.identity,
  });
  const contextPlan = declaredContextPlan(capture.context, limits);
  if (!contextPlan.ok) {
    const suffix = contextPlan.evidencePath === "" ? "" : `/${contextPlan.evidencePath}`;
    findings.push({ code: "unsafe_archive_path", revision, evidencePath: `${contextRelative}${suffix}` });
    return;
  }
  // Only manifest-declared paths are trust inputs. Undeclared archive entries
  // are intentionally neither enumerated nor followed.
  const blockedDirectories: string[] = [];
  for (const directory of contextPlan.directories) {
    if (blockedDirectories.some((blocked) => directory === blocked || directory.startsWith(`${blocked}/`))) {
      continue;
    }
    const path = join(contextRoot, directory);
    const anchor = stableAnchorDirectory(path, deps);
    if (!anchor.ok) {
      blockedDirectories.push(directory);
      findings.push(findingForReadFailure(anchor.kind, `${contextRelative}/${directory}`, revision));
      continue;
    }
    directoryAnchors.push({
      path,
      evidencePath: `${contextRelative}/${directory}`,
      revision,
      identity: anchor.identity,
    });
  }
  let remainingBytes = limits.maxContextBytes;
  for (const descriptor of capture.context.slice().sort((left, right) => compareText(left.path, right.path))) {
    if (blockedDirectories.some((directory) => descriptor.path.startsWith(`${directory}/`))) continue;
    const relativePath = `${contextRelative}/${descriptor.path}`;
    const read = stableReadFile(join(contextRoot, descriptor.path), remainingBytes, deps);
    if (!read.ok) {
      findings.push(findingForReadFailure(read.kind, relativePath, revision));
      continue;
    }
    remainingBytes -= read.content.byteLength;
    if (remainingBytes < 0) {
      findings.push({ code: "unsafe_archive_path", revision, evidencePath: relativePath });
      break;
    }
    if (read.content.byteLength !== descriptor.bytes || sha256(read.content) !== descriptor.sha256) {
      findings.push({ code: "context_digest_mismatch", revision, evidencePath: relativePath });
    }
  }
}

function validLimits(input: Partial<RequirementArchiveAuditLimits> | undefined): RequirementArchiveAuditLimits | undefined {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) return undefined;
  }
  return limits;
}

/**
 * Audits the v1 source graph, declared paths, metadata, and digest consistency without
 * claiming external authenticity when source authority and evidence are rewritten together.
 */
export function auditRequirementArchive(
  input: RequirementArchiveAuditInput,
  deps: RequirementArchiveAuditDependencies = {},
): RequirementArchiveAudit {
  const limits = validLimits(input.limits);
  const findings: RequirementArchiveFinding[] = [];
  const directoryAnchors: AnchoredDirectory[] = [];
  const fallback = (finding: RequirementArchiveFinding): RequirementArchiveAudit =>
    classifyRequirementArchiveIntegrity({
      requirementId: input.requirementId,
      checkedRevisions: [],
      findings: [finding],
    });
  if (limits === undefined) {
    return fallback({ code: "unsafe_archive_path", evidencePath: "." });
  }
  if (
    !safeSegment(input.provider, /^[a-z][a-z0-9_]*$/u) ||
    !safeSegment(input.requirementId, /^req-[0-9a-f]{12}$/u)
  ) {
    return fallback({ code: "manifest_invalid", evidencePath: "source.yaml" });
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(resolve(input.workspaceRoot));
  } catch {
    return fallback({ code: "unsafe_archive_path", evidencePath: "." });
  }
  const requirementRoot = join(workspaceRoot, "requirements", input.provider, input.requirementId);
  try {
    const canonicalRoot = realpathSync(requirementRoot);
    if (!contained(workspaceRoot, canonicalRoot) || canonicalRoot !== requirementRoot) {
      return fallback({ code: "unsafe_archive_path", evidencePath: "." });
    }
  } catch {
    return fallback({ code: "manifest_invalid", evidencePath: "source.yaml" });
  }
  const requirementAnchor = stableAnchorDirectory(requirementRoot, deps);
  if (!requirementAnchor.ok) {
    return fallback(findingForReadFailure(requirementAnchor.kind, "."));
  }
  directoryAnchors.push({
    path: requirementRoot,
    evidencePath: ".",
    identity: requirementAnchor.identity,
  });
  const sourceRead = stableReadFile(join(requirementRoot, "source.yaml"), limits.maxSourceBytes, deps);
  if (!sourceRead.ok) {
    const finding = sourceRead.kind === "missing"
      ? { code: "manifest_invalid" as const, evidencePath: "source.yaml" }
      : findingForReadFailure(sourceRead.kind, "source.yaml");
    return fallback(finding);
  }
  let source: RequirementSourceManifest | undefined;
  try {
    const parsed = parseRequirementSourceManifest(JSON.parse(sourceRead.content.toString("utf8")));
    if (parsed.ok) source = parsed.value;
  } catch {
    source = undefined;
  }
  if (source === undefined || source.requirementId !== input.requirementId || source.provider !== input.provider) {
    return fallback({ code: "manifest_invalid", evidencePath: "source.yaml" });
  }
  const graph = [source.revision, ...source.previousRevisions.map((entry) => entry.revision).reverse()];
  if (new Set(graph).size !== graph.length || graph.length > limits.maxRevisions) {
    return classifyRequirementArchiveIntegrity({
      requirementId: source.requirementId,
      checkedRevisions: graph.slice(0, limits.maxRevisions),
      findings: [{ code: graph.length > limits.maxRevisions ? "unsafe_archive_path" : "manifest_invalid", evidencePath: "source.yaml" }],
    });
  }
  if (graph.length > limits.maxRevisionEntries) {
    return classifyRequirementArchiveIntegrity({
      requirementId: source.requirementId,
      checkedRevisions: graph,
      findings: [{ code: "unsafe_archive_path", evidencePath: "revisions" }],
    });
  }

  const revisionsRoot = join(requirementRoot, "revisions");
  const revisionsAnchor = stableAnchorDirectory(revisionsRoot, deps);
  if (!revisionsAnchor.ok) {
    findings.push(findingForReadFailure(revisionsAnchor.kind, "revisions"));
  } else {
    directoryAnchors.push({
      path: revisionsRoot,
      evidencePath: "revisions",
      identity: revisionsAnchor.identity,
    });
    for (const revision of graph) {
      scanRevision(requirementRoot, source, revision, limits, deps, findings, directoryAnchors);
    }
  }

  const sourceAfter = stableReadFile(join(requirementRoot, "source.yaml"), limits.maxSourceBytes, deps);
  if (
    !sourceAfter.ok || !sameIdentity(sourceRead.identity, sourceAfter.identity) ||
    !sourceRead.content.equals(sourceAfter.content)
  ) {
    findings.push({ code: "archive_changed_during_read", evidencePath: "source.yaml" });
  }
  revalidateDirectoryAnchors(directoryAnchors, deps, findings);
  return classifyRequirementArchiveIntegrity({
    requirementId: source.requirementId,
    checkedRevisions: graph,
    findings,
  });
}
