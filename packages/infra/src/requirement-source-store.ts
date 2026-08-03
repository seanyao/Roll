import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MAX_REQUIREMENT_BODY_BYTES,
  MAX_REQUIREMENT_CONTEXT_BYTES,
  MAX_REQUIREMENT_CONTEXT_FILES,
  normalizeRequirementSourceReference,
  planRequirementCapture,
  renderRequirementAttestProjection,
  requirementRevisionKey,
  resolveRequirementSourcesForStory,
  type RequirementCaptureOutcome,
} from "@roll/core";
import {
  parseRequirementSourceManifest,
  parseWorkspaceManifest,
  type CampaignDeliveryTarget,
  type RequirementContextDescriptor,
  type RequirementSourceManifest,
  type WorkspaceManifest,
} from "@roll/spec";
import { acquireLock, releaseLock } from "./process.js";
import { auditRequirementArchive } from "./requirement-archive-audit.js";
import {
  withWorkspaceAuthorityLockSync,
  WorkspaceAuthorityLockError,
} from "./workspace-authority-lock.js";

export type RequirementSourceStoreErrorCode =
  | "invalid_workspace"
  | "source_not_declared"
  | "story_not_found"
  | "unsafe_context"
  | "context_limit"
  | "source_changed"
  | "revision_conflict"
  | "concurrent_capture"
  | "io_failure"
  | "projection_repair_required";

export class RequirementSourceStoreError extends Error {
  constructor(readonly code: RequirementSourceStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RequirementSourceStoreError";
  }
}

export interface RequirementSourceCaptureInput {
  readonly rollHome: string;
  readonly workspaceRoot: string;
  readonly provider: string;
  readonly ref: string;
  readonly revision: string;
  readonly capturedAt: string;
  readonly bodyFile: string;
  readonly contextRoot?: string;
  readonly contextPaths: readonly string[];
  readonly storyIds: readonly string[];
  readonly deliveryTarget?: CampaignDeliveryTarget;
}

export interface RequirementSourceCaptureResult {
  readonly outcome: RequirementCaptureOutcome;
  readonly workspaceId: string;
  readonly requirementPath: string;
  readonly contextCount: number;
  readonly manifest: RequirementSourceManifest;
}

export type RequirementProjectionState =
  | "current"
  | "drift"
  | "pending_journal"
  | "unsupported_schema";

export interface RequirementProjectionInspection {
  readonly requirementId: string;
  readonly requirementPath: string;
  readonly state: RequirementProjectionState;
}

export interface RequirementProjectionRepairResult {
  readonly outcome: "repaired" | "reused";
  readonly requirementId: string;
  readonly requirementPath: string;
}

export interface RequirementSourceStoreDeps {
  readonly renameFile?: (from: string, to: string) => void;
  readonly afterReadFile?: (path: string) => void;
  readonly beforeProjection?: () => void;
  readonly onLockAcquired?: (lock: "authority" | "requirement") => void;
}

interface StableFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly content: Buffer;
}

interface StableContextFile extends StableFile {
  readonly relativePath: string;
}

interface RevisionEvidence {
  readonly body: StableFile;
  readonly context: readonly StableContextFile[];
}

const PROJECTION_JOURNAL = "projection.pending.json";

function fail(code: RequirementSourceStoreErrorCode, message: string, cause?: unknown): never {
  throw new RequirementSourceStoreError(code, message, cause === undefined ? undefined : { cause });
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicWrite(path: string, content: string | Buffer, renameFile: (from: string, to: string) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameFile(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function stableFile(
  path: string,
  deps: RequirementSourceStoreDeps,
  maximumBytes = Number.MAX_SAFE_INTEGER,
  limitMessage = "Requirement capture input exceeds its byte limit",
): StableFile {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return fail("unsafe_context", "Requirement capture input could not be inspected", error);
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail("unsafe_context", "Requirement capture inputs must be regular files");
    if (before.size > maximumBytes) fail("context_limit", limitMessage);
    const pathBefore = lstatSync(path);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino) {
      fail("unsafe_context", "Requirement capture input changed before it could be anchored");
    }
    const content = readFileSync(descriptor);
    deps.afterReadFile?.(path);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (!sameFile(before, after) || pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
      fail("source_changed", "Requirement capture input changed while it was read");
    }
    return {
      path,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    };
  } catch (error) {
    if (error instanceof RequirementSourceStoreError) throw error;
    return fail("source_changed", "Requirement capture input changed while it was read", error);
  } finally {
    closeSync(descriptor);
  }
}

const PROJECTION_MAX_DEPTH = 32;
function safeRelativePath(value: string): boolean {
  if (value === "" || value !== value.trim() || value.startsWith("/") || value.startsWith("~") || value.includes("\\") || /^[A-Za-z]:/u.test(value)) {
    return false;
  }
  const segments = value.split("/");
  if (segments.length > PROJECTION_MAX_DEPTH) return false;
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function rejectSymlinkSegments(root: string, relativePath: string): void {
  let cursor = root;
  for (const segment of relativePath.split("/")) {
    cursor = join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      return fail("unsafe_context", "Requirement context path could not be inspected", error);
    }
    if (stat.isSymbolicLink()) fail("unsafe_context", "Requirement context cannot traverse symbolic links");
  }
}

function contextFiles(input: RequirementSourceCaptureInput, deps: RequirementSourceStoreDeps): readonly StableContextFile[] {
  if (input.contextPaths.length === 0) return [];
  if (input.contextPaths.length > MAX_REQUIREMENT_CONTEXT_FILES) {
    fail("context_limit", "Requirement context exceeds the file-count limit");
  }
  if (input.contextRoot === undefined) fail("unsafe_context", "Requirement context root is required");
  let root: string;
  try {
    const rootStat = lstatSync(input.contextRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("unsafe_context", "Requirement context root must be a real directory");
    root = realpathSync(input.contextRoot);
  } catch (error) {
    if (error instanceof RequirementSourceStoreError) throw error;
    return fail("unsafe_context", "Requirement context root could not be resolved", error);
  }
  let remainingBytes = MAX_REQUIREMENT_CONTEXT_BYTES;
  return input.contextPaths.map((relativePath) => {
    if (!safeRelativePath(relativePath)) fail("unsafe_context", "Requirement context paths must be safe and relative");
    rejectSymlinkSegments(root, relativePath);
    let path: string;
    try {
      path = realpathSync(join(root, relativePath));
    } catch (error) {
      return fail("unsafe_context", "Requirement context path could not be resolved", error);
    }
    if (!contained(root, path)) fail("unsafe_context", "Requirement context escapes its declared root");
    const file = stableFile(path, deps, remainingBytes, "Requirement context exceeds the total byte limit");
    remainingBytes -= file.bytes;
    return { ...file, relativePath };
  }).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
}

// Re-anchors containment by walking segment-by-segment with lstat + realpath, and callers
// re-invoke this immediately before each mutating write (see projectCurrent/writeRevision/
// prepareProjectionJournal). This closes the check-then-write window between call sites, but
// pathname-based checks cannot close the window inside a single write syscall itself (e.g. a
// path swapped for a symlink between this function's last stat and the write call that follows
// it): only fd-anchored operations (O_NOFOLLOW opens, *at() syscalls) eliminate that residual
// race, and this store does not have that available for directory creation/rename targets.
function ensureSafeDirectory(root: string, target: string, create: boolean): void {
  if (!contained(root, target)) fail("unsafe_context", "Requirement output must remain inside the Workspace");
  const rel = relative(root, target);
  let cursor = root;
  for (const segment of rel === "" ? [] : rel.split(sep)) {
    cursor = join(cursor, segment);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail("unsafe_context", "Requirement output cannot traverse symbolic links or non-directories");
      }
    } catch (error) {
      if (error instanceof RequirementSourceStoreError) throw error;
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        return fail("unsafe_context", "Requirement output path could not be inspected", error);
      }
      try {
        mkdirSync(cursor);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          return fail("io_failure", "Requirement output directory could not be created", mkdirError);
        }
      }
      const created = lstatSync(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        fail("unsafe_context", "Requirement output cannot traverse symbolic links or non-directories");
      }
    }
    let canonical: string;
    try {
      canonical = realpathSync(cursor);
    } catch (error) {
      return fail("unsafe_context", "Requirement output directory could not be resolved", error);
    }
    if (!contained(root, canonical)) fail("unsafe_context", "Requirement output escaped the Workspace");
  }
}

export function readWorkspace(root: string): WorkspaceManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(root, "workspace.yaml"), "utf8"));
  } catch (error) {
    return fail("invalid_workspace", "Workspace manifest could not be read", error);
  }
  const parsed = parseWorkspaceManifest(value);
  if (!parsed.ok) fail("invalid_workspace", "Workspace manifest is invalid");
  return parsed.value;
}

function declaredSource(
  requirements: readonly { readonly provider: string; readonly ref: string }[],
  provider: string,
  ref: string,
): boolean {
  const requested = normalizeRequirementSourceReference(provider, ref);
  if (!requested.ok) return false;
  return requirements.some((candidate) => {
    const normalized = normalizeRequirementSourceReference(candidate.provider, candidate.ref);
    return normalized.ok && normalized.value.requirementId === requested.value.requirementId;
  });
}

function collectStoryIds(root: string, depth = 0): readonly string[] {
  if (depth > 10 || !existsSync(root)) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (existsSync(join(path, "spec.md"))) ids.push(entry.name);
      ids.push(...collectStoryIds(path, depth + 1));
    }
  }
  return ids;
}

function validateStories(workspaceRoot: string, storyIds: readonly string[]): void {
  const known = new Set(collectStoryIds(join(workspaceRoot, "backlog")));
  if (storyIds.some((storyId) => !known.has(storyId))) {
    fail("story_not_found", "Every Requirement Story link must resolve inside the Workspace backlog");
  }
}

function readExisting(path: string): RequirementSourceManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const file = stableFile(path, {}, MAX_REQUIREMENT_CONTEXT_BYTES, "Requirement source index exceeds its byte limit");
    const parsed = parseRequirementSourceManifest(JSON.parse(file.content.toString("utf8")));
    if (!parsed.ok) fail("io_failure", "Requirement source index is invalid");
    return parsed.value;
  } catch (error) {
    if (error instanceof RequirementSourceStoreError) throw error;
    return fail("io_failure", "Requirement source index could not be read", error);
  }
}

/** Inspect only the mutable current projection. Immutable archive trust is a
 * separate read model supplied by auditRequirementArchive; doctor combines
 * both facts before it can offer an explicit projection repair. */
export function inspectRequirementProjection(input: {
  readonly workspaceRoot: string;
  readonly provider: string;
  readonly requirementId: string;
}): RequirementProjectionInspection {
  const workspaceRoot = resolve(input.workspaceRoot);
  let requirementPath = join(workspaceRoot, "requirements", input.provider, input.requirementId);
  const unsupported = (): RequirementProjectionInspection => ({
    requirementId: input.requirementId,
    requirementPath,
    state: "unsupported_schema",
  });
  let canonicalWorkspace: string;
  let canonicalRequirement: string;
  try {
    canonicalWorkspace = realpathSync(workspaceRoot);
    requirementPath = join(canonicalWorkspace, "requirements", input.provider, input.requirementId);
    canonicalRequirement = realpathSync(requirementPath);
  } catch {
    return unsupported();
  }
  if (!contained(canonicalWorkspace, canonicalRequirement) || canonicalRequirement !== requirementPath) {
    return unsupported();
  }
  let manifest: RequirementSourceManifest | undefined;
  try {
    manifest = readExisting(join(requirementPath, "source.yaml"));
  } catch {
    return unsupported();
  }
  if (
    manifest === undefined ||
    manifest.provider !== input.provider ||
    manifest.requirementId !== input.requirementId
  ) return unsupported();
  if (existsSync(join(requirementPath, PROJECTION_JOURNAL))) {
    return { requirementId: input.requirementId, requirementPath, state: "pending_journal" };
  }
  try {
    const evidence = validateRevision(requirementPath, manifest);
    return {
      requirementId: input.requirementId,
      requirementPath,
      state: isProjectionCurrent(requirementPath, manifest, evidence) ? "current" : "drift",
    };
  } catch {
    return { requirementId: input.requirementId, requirementPath, state: "drift" };
  }
}

/** Rebuild the mutable current projection only from the current immutable
 * revision after the archive auditor proves the full revision graph healthy.
 * The projection journal is written before any projection file changes and is
 * retained on interruption so the same operation can resume idempotently. */
function repairRequirementProjectionUnlocked(
  input: {
    readonly workspaceRoot: string;
    readonly provider: string;
    readonly requirementId: string;
  },
  deps: RequirementSourceStoreDeps = {},
): RequirementProjectionRepairResult {
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(resolve(input.workspaceRoot));
  } catch (error) {
    return fail("invalid_workspace", "Workspace root could not be resolved", error);
  }
  const workspace = readWorkspace(workspaceRoot);
  const requirementPath = join(workspaceRoot, "requirements", input.provider, input.requirementId);
  let manifest: RequirementSourceManifest | undefined;
  try {
    manifest = readExisting(join(requirementPath, "source.yaml"));
  } catch (error) {
    return fail("revision_conflict", "Requirement source authority is invalid", error);
  }
  if (
    manifest === undefined || manifest.provider !== input.provider ||
    manifest.requirementId !== input.requirementId ||
    !declaredSource(workspace.requirements, manifest.provider, manifest.ref)
  ) {
    return fail("source_not_declared", "Requirement source is not declared by this Workspace");
  }
  const lockPath = requirementCaptureLockPath(workspaceRoot, input.requirementId);
  ensureSafeDirectory(workspaceRoot, dirname(lockPath), true);
  const lock = acquireLock(lockPath, process.pid, {
    cycleId: `requirement-repair:${workspace.workspaceId}:${input.requirementId}`,
    unparseableIsHeld: true,
  });
  if (!lock.acquired) fail("concurrent_capture", "Requirement source capture or repair is already running");
  try {
    deps.onLockAcquired?.("requirement");
    const audit = auditRequirementArchive({
      workspaceRoot,
      provider: input.provider,
      requirementId: input.requirementId,
    });
    if (audit.status !== "healthy") {
      return fail("revision_conflict", "Immutable Requirement archive is not trusted for projection repair");
    }
    const current = inspectRequirementProjection(input);
    if (current.state === "current") {
      return { outcome: "reused", requirementId: input.requirementId, requirementPath };
    }
    if (current.state === "unsupported_schema") {
      return fail("revision_conflict", "Requirement projection authority is unsupported");
    }
    const evidence = validateRevision(requirementPath, manifest);
    const renameFile = deps.renameFile ?? renameSync;
    prepareProjectionJournal(workspaceRoot, requirementPath, manifest, renameFile);
    projectCurrent(workspaceRoot, requirementPath, manifest, evidence, deps);
    return { outcome: "repaired", requirementId: input.requirementId, requirementPath };
  } finally {
    releaseLock(lockPath);
  }
}

export function repairRequirementProjection(
  input: {
    readonly rollHome: string;
    readonly workspaceRoot: string;
    readonly provider: string;
    readonly requirementId: string;
  },
  deps: RequirementSourceStoreDeps = {},
): RequirementProjectionRepairResult {
  const workspace = readWorkspace(resolve(input.workspaceRoot));
  try {
    return withWorkspaceAuthorityLockSync({
      rollHome: resolve(input.rollHome),
      workspaceId: workspace.workspaceId,
      operation: "requirement-repair",
      onAcquired: () => deps.onLockAcquired?.("authority"),
    }, () => repairRequirementProjectionUnlocked(input, deps));
  } catch (error) {
    if (error instanceof WorkspaceAuthorityLockError) {
      return fail("concurrent_capture", "Workspace authority is locked by another metadata writer", error);
    }
    throw error;
  }
}

function copyContextProjection(
  context: readonly StableContextFile[],
  requirementPath: string,
  renameFile: (from: string, to: string) => void,
): void {
  const staging = join(requirementPath, `.context.${randomUUID()}`);
  const target = join(requirementPath, "context");
  const backup = join(requirementPath, `.context.backup.${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  for (const file of context) {
    const destination = join(staging, file.relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content, { flag: "wx" });
  }
  let movedOld = false;
  try {
    if (existsSync(target)) {
      renameFile(target, backup);
      movedOld = true;
    }
    renameFile(staging, target);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (movedOld && !existsSync(target) && existsSync(backup)) {
      try { renameFile(backup, target); } catch { /* explicit repair owns recovery after this capture fails loud */ }
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function isProjectionCurrent(
  requirementPath: string,
  manifest: RequirementSourceManifest,
  evidence: RevisionEvidence,
): boolean {
  try {
    if (existsSync(join(requirementPath, PROJECTION_JOURNAL))) return false;
    const body = stableFile(join(requirementPath, "requirement.md"), {}, MAX_REQUIREMENT_BODY_BYTES);
    if (!body.content.equals(evidence.body.content)) return false;
    const expectedAttest = renderRequirementAttestProjection(manifest);
    const attest = stableFile(join(requirementPath, "attest.md"), {}, Buffer.byteLength(expectedAttest, "utf8") + 4096);
    if (attest.content.toString("utf8") !== expectedAttest) return false;
    const contextRoot = join(requirementPath, "context");
    const actualPaths = existsSync(contextRoot) ? archiveContextPaths(contextRoot).slice().sort() : [];
    const expectedPaths = evidence.context.map((file) => file.relativePath).slice().sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) return false;
    let remainingBytes = MAX_REQUIREMENT_CONTEXT_BYTES;
    return evidence.context.every((file) => {
      const content = stableFile(join(contextRoot, file.relativePath), {}, Math.min(file.bytes, remainingBytes));
      remainingBytes -= content.bytes;
      return remainingBytes >= 0 && content.content.equals(file.content);
    });
  } catch {
    return false;
  }
}

function projectCurrent(
  workspaceRoot: string,
  requirementPath: string,
  manifest: RequirementSourceManifest,
  evidence: RevisionEvidence,
  deps: RequirementSourceStoreDeps,
): void {
  const renameFile = deps.renameFile ?? renameSync;
  const journal = join(requirementPath, PROJECTION_JOURNAL);
  try {
    deps.beforeProjection?.();
    ensureSafeDirectory(workspaceRoot, requirementPath, false);
    atomicWrite(join(requirementPath, "requirement.md"), evidence.body.content, renameFile);
    copyContextProjection(evidence.context, requirementPath, renameFile);
    atomicWrite(join(requirementPath, "attest.md"), renderRequirementAttestProjection(manifest), renameFile);
    rmSync(journal, { force: true });
  } catch (error) {
    return fail("projection_repair_required", "Requirement revision committed but its current projection needs repair", error);
  }
}

function projectLinkedStories(
  workspaceRoot: string,
  requirementPath: string,
  manifest: RequirementSourceManifest,
  deps: RequirementSourceStoreDeps,
): void {
  const renameFile = deps.renameFile ?? renameSync;
  const journal = join(requirementPath, PROJECTION_JOURNAL);
  try {
    deps.beforeProjection?.();
    ensureSafeDirectory(workspaceRoot, requirementPath, false);
    atomicWrite(join(requirementPath, "attest.md"), renderRequirementAttestProjection(manifest), renameFile);
    rmSync(journal, { force: true });
  } catch (error) {
    return fail("projection_repair_required", "Requirement Story links committed but the pending projection needs repair", error);
  }
}

function archiveContextPathsWalk(
  root: string,
  relativeRoot: string,
  depth: number,
): readonly string[] {
  if (depth > PROJECTION_MAX_DEPTH) {
    fail("revision_conflict", "Requirement context tree exceeds its depth contract");
  }
  const paths: string[] = [];
  for (const entry of readdirSync(join(root, relativeRoot), { withFileTypes: true })) {
    const relativePath = relativeRoot === "" ? entry.name : `${relativeRoot}/${entry.name}`;
    const path = join(root, relativePath);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail("revision_conflict", "Immutable Requirement context contains a symbolic link");
    if (entry.isDirectory()) paths.push(...archiveContextPathsWalk(root, relativePath, depth + 1));
    else if (entry.isFile()) paths.push(relativePath);
    else fail("revision_conflict", "Immutable Requirement context contains a non-regular entry");
  }
  return paths;
}

function archiveContextPaths(root: string, relativeRoot = ""): readonly string[] {
  const paths = archiveContextPathsWalk(root, relativeRoot, 0);
  if (paths.length > MAX_REQUIREMENT_CONTEXT_FILES) {
    fail("revision_conflict", "Immutable Requirement context exceeds its file-count contract");
  }
  return paths;
}

function validateRevision(
  requirementPath: string,
  manifest: RequirementSourceManifest,
): RevisionEvidence {
  try {
    const canonicalRequirementPath = realpathSync(requirementPath);
    const revisionPath = join(canonicalRequirementPath, "revisions", requirementRevisionKey(manifest.revision));
    ensureSafeDirectory(canonicalRequirementPath, revisionPath, false);
    const capturedFile = stableFile(
      join(revisionPath, "capture.yaml"),
      {},
      MAX_REQUIREMENT_CONTEXT_BYTES,
      "Immutable Requirement capture index exceeds its byte limit",
    );
    const parsed = parseRequirementSourceManifest(JSON.parse(capturedFile.content.toString("utf8")));
    if (!parsed.ok) fail("revision_conflict", "Immutable Requirement capture index is invalid");
    const captured = parsed.value;
    if (
      captured.requirementId !== manifest.requirementId || captured.provider !== manifest.provider || captured.ref !== manifest.ref ||
      captured.revision !== manifest.revision || captured.capturedAt !== manifest.capturedAt ||
      captured.requirement.bytes !== manifest.requirement.bytes || captured.requirement.sha256 !== manifest.requirement.sha256 ||
      JSON.stringify(captured.context) !== JSON.stringify(manifest.context) ||
      JSON.stringify(captured.previousRevisions) !== JSON.stringify(manifest.previousRevisions)
    ) {
      fail("revision_conflict", "Immutable Requirement revision metadata does not match source authority");
    }
    const body = stableFile(
      join(revisionPath, "requirement.md"),
      {},
      MAX_REQUIREMENT_BODY_BYTES,
      "Immutable Requirement body exceeds its byte limit",
    );
    if (body.bytes !== manifest.requirement.bytes || body.sha256 !== manifest.requirement.sha256) {
      fail("revision_conflict", "Immutable Requirement body does not match its recorded digest");
    }
    const contextRoot = join(revisionPath, "context");
    ensureSafeDirectory(canonicalRequirementPath, contextRoot, false);
    const actualPaths = archiveContextPaths(contextRoot).slice().sort();
    const expectedPaths = manifest.context.map((entry) => entry.path).slice().sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      fail("revision_conflict", "Immutable Requirement context file set does not match source authority");
    }
    let remainingBytes = MAX_REQUIREMENT_CONTEXT_BYTES;
    const context = manifest.context.map((descriptor) => {
      rejectSymlinkSegments(contextRoot, descriptor.path);
      const path = realpathSync(join(contextRoot, descriptor.path));
      if (!contained(contextRoot, path)) fail("revision_conflict", "Immutable Requirement context escaped its revision");
      const file = stableFile(path, {}, remainingBytes, "Immutable Requirement context exceeds its byte limit");
      remainingBytes -= file.bytes;
      if (file.bytes !== descriptor.bytes || file.sha256 !== descriptor.sha256) {
        fail("revision_conflict", "Immutable Requirement context does not match its recorded digest");
      }
      return { ...file, relativePath: descriptor.path };
    });
    return { body, context };
  } catch (error) {
    if (error instanceof RequirementSourceStoreError && error.code === "revision_conflict") throw error;
    return fail("revision_conflict", "Immutable Requirement revision is missing, unsafe, or unreadable", error);
  }
}

function prepareProjectionJournal(
  workspaceRoot: string,
  requirementPath: string,
  manifest: RequirementSourceManifest,
  renameFile: (from: string, to: string) => void,
): void {
  try {
    ensureSafeDirectory(workspaceRoot, requirementPath, false);
    atomicWrite(
      join(requirementPath, PROJECTION_JOURNAL),
      json({ schema: "roll.requirement-projection-journal/v1", revision: manifest.revision }),
      renameFile,
    );
  } catch (error) {
    return fail("io_failure", "Requirement projection journal could not be prepared", error);
  }
}

function writeRevision(
  workspaceRoot: string,
  requirementPath: string,
  manifest: RequirementSourceManifest,
  body: StableFile,
  context: readonly StableContextFile[],
  renameFile: (from: string, to: string) => void,
): void {
  const revisionPath = join(requirementPath, "revisions", requirementRevisionKey(manifest.revision));
  if (existsSync(revisionPath)) {
    validateRevision(requirementPath, manifest);
    return;
  }
  ensureSafeDirectory(workspaceRoot, requirementPath, false);
  const staging = join(requirementPath, `.revision.${randomUUID()}`);
  try {
    mkdirSync(join(staging, "context"), { recursive: true });
    writeFileSync(join(staging, "capture.yaml"), json(manifest), { flag: "wx" });
    writeFileSync(join(staging, "requirement.md"), body.content, { flag: "wx" });
    for (const [index, file] of context.entries()) {
      const descriptor = manifest.context[index];
      if (descriptor === undefined) fail("io_failure", "Requirement context descriptor mismatch");
      const target = join(staging, "context", descriptor.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { flag: "wx" });
    }
    mkdirSync(dirname(revisionPath), { recursive: true });
    renameFile(staging, revisionPath);
  } catch (error) {
    if (error instanceof RequirementSourceStoreError) throw error;
    return fail("io_failure", "Requirement revision could not be committed", error);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function requirementCaptureLockPath(workspaceRoot: string, requirementId: string): string {
  return join(resolve(workspaceRoot), "runtime", "locks", "requirements", `${requirementId}.lock`);
}

function declaredCanonicalDirs(
  requirements: readonly { readonly provider: string; readonly ref: string }[],
): ReadonlySet<string> {
  const dirs = new Set<string>();
  for (const requirement of requirements) {
    const normalized = normalizeRequirementSourceReference(requirement.provider, requirement.ref);
    if (normalized.ok) dirs.add(`${normalized.value.provider}/${normalized.value.requirementId}`);
  }
  return dirs;
}

function readAllRequirementManifests(
  workspaceRoot: string,
  requirements: readonly { readonly provider: string; readonly ref: string }[],
): readonly RequirementSourceManifest[] {
  const requirementsRoot = join(resolve(workspaceRoot), "requirements");
  const canonicalDirs = declaredCanonicalDirs(requirements);
  if (!existsSync(requirementsRoot)) return [];
  let providerStat;
  try {
    providerStat = lstatSync(requirementsRoot);
  } catch {
    return [];
  }
  if (providerStat.isSymbolicLink() || !providerStat.isDirectory()) return [];
  const seenRequirementIds = new Set<string>();
  const manifests: RequirementSourceManifest[] = [];
  for (const providerEntry of readdirSync(requirementsRoot, { withFileTypes: true })) {
    if (!providerEntry.isDirectory()) continue;
    const providerPath = join(requirementsRoot, providerEntry.name);
    if (lstatSync(providerPath).isSymbolicLink()) continue;
    for (const requirementEntry of readdirSync(providerPath, { withFileTypes: true })) {
      if (!requirementEntry.isDirectory()) continue;
      const requirementPath = join(providerPath, requirementEntry.name);
      if (lstatSync(requirementPath).isSymbolicLink()) continue;
      const isDeclaredCanonical = canonicalDirs.has(`${providerEntry.name}/${requirementEntry.name}`);
      let manifest: RequirementSourceManifest | undefined;
      try {
        manifest = readExisting(join(requirementPath, "source.yaml"));
      } catch (error) {
        if (isDeclaredCanonical) throw error;
        continue;
      }
      if (manifest === undefined) {
        if (isDeclaredCanonical) fail("io_failure", "Declared Requirement source.yaml is missing from its canonical directory");
        continue;
      }
      if (manifest.provider !== providerEntry.name) continue;
      if (manifest.requirementId !== requirementEntry.name) continue;
      if (!declaredSource(requirements, manifest.provider, manifest.ref)) continue;
      if (seenRequirementIds.has(manifest.requirementId)) continue;
      seenRequirementIds.add(manifest.requirementId);
      manifests.push(manifest);
    }
  }
  return manifests;
}

export function resolveRequirementSourcesForStoryOnDisk(
  workspaceRoot: string,
  storyId: string,
): readonly RequirementSourceManifest[] {
  const canonicalRoot = resolve(workspaceRoot);
  const workspace = readWorkspace(canonicalRoot);
  return resolveRequirementSourcesForStory(readAllRequirementManifests(canonicalRoot, workspace.requirements), storyId);
}

function captureRequirementSourceUnlocked(
  input: RequirementSourceCaptureInput,
  deps: RequirementSourceStoreDeps = {},
): RequirementSourceCaptureResult {
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(input.workspaceRoot);
  } catch (error) {
    return fail("invalid_workspace", "Workspace root could not be resolved", error);
  }
  const workspace = readWorkspace(workspaceRoot);
  const source = normalizeRequirementSourceReference(input.provider, input.ref);
  if (!source.ok) fail("source_not_declared", "Requirement source identity is invalid or undeclared");
  if (!declaredSource(workspace.requirements, input.provider, input.ref)) {
    fail("source_not_declared", "Requirement source must be declared in workspace.yaml before capture");
  }
  validateStories(workspaceRoot, input.storyIds);
  const requirementPath = join(workspaceRoot, "requirements", source.value.provider, source.value.requirementId);
  const lockPath = requirementCaptureLockPath(workspaceRoot, source.value.requirementId);
  ensureSafeDirectory(workspaceRoot, dirname(lockPath), true);
  const lock = acquireLock(lockPath, process.pid, {
    cycleId: `requirement:${workspace.workspaceId}:${source.value.requirementId}`,
    unparseableIsHeld: true,
  });
  if (!lock.acquired) fail("concurrent_capture", "Requirement source capture is already running");
  try {
    deps.onLockAcquired?.("requirement");
    const renameFile = deps.renameFile ?? renameSync;
    const sourcePath = join(requirementPath, "source.yaml");
    const existing = existsSync(requirementPath) ? readExisting(sourcePath) : undefined;
    if (existing !== undefined && existsSync(join(requirementPath, PROJECTION_JOURNAL))) {
      fail("projection_repair_required", "Requirement current projection needs explicit repair before capture can continue");
    }
    if (existing !== undefined) {
      const existingEvidence = validateRevision(requirementPath, existing);
      if (!isProjectionCurrent(requirementPath, existing, existingEvidence)) {
        fail("projection_repair_required", "Requirement current projection is missing, stale, or unsafe");
      }
    }
    const body = stableFile(
      resolve(input.bodyFile),
      deps,
      MAX_REQUIREMENT_BODY_BYTES,
      "Requirement body exceeds the capture byte limit",
    );
    const context = contextFiles(input, deps);
    ensureSafeDirectory(workspaceRoot, requirementPath, true);
    const descriptors: RequirementContextDescriptor[] = context.map((file) => ({
      path: file.relativePath,
      bytes: file.bytes,
      sha256: file.sha256,
    }));
    const planned = planRequirementCapture({
      provider: input.provider,
      ref: input.ref,
      revision: input.revision,
      capturedAt: input.capturedAt,
      requirement: { bytes: body.bytes, sha256: body.sha256 },
      context: descriptors,
      stories: input.storyIds,
      ...(input.deliveryTarget === undefined ? {} : { deliveryTarget: input.deliveryTarget }),
    }, existing);
    if (!planned.ok) {
      const first = planned.errors[0];
      const code = first?.code === "context_limit" ? "context_limit" : first?.code === "revision_conflict" ? "revision_conflict" : "unsafe_context";
      fail(code, first?.message ?? "Requirement capture plan is invalid");
    }
    const plan = planned.value;
    if (plan.outcome === "reused") {
      return {
        outcome: plan.outcome,
        workspaceId: workspace.workspaceId,
        requirementPath,
        contextCount: plan.manifest.context.length,
        manifest: plan.manifest,
      };
    }
    let evidence: RevisionEvidence | undefined;
    if (plan.outcome === "created" || plan.outcome === "updated") {
      writeRevision(workspaceRoot, requirementPath, plan.manifest, body, context, renameFile);
      evidence = validateRevision(requirementPath, plan.manifest);
    }
    prepareProjectionJournal(workspaceRoot, requirementPath, plan.manifest, renameFile);
    try {
      ensureSafeDirectory(workspaceRoot, requirementPath, false);
      atomicWrite(sourcePath, json(plan.manifest), renameFile);
    } catch (error) {
      if (error instanceof RequirementSourceStoreError) throw error;
      return fail("io_failure", "Requirement source index could not be committed", error);
    }
    if (plan.outcome === "linked") {
      projectLinkedStories(workspaceRoot, requirementPath, plan.manifest, deps);
    } else {
      if (evidence === undefined) fail("io_failure", "Requirement revision evidence was not prepared");
      projectCurrent(workspaceRoot, requirementPath, plan.manifest, evidence, deps);
    }
    return {
      outcome: plan.outcome,
      workspaceId: workspace.workspaceId,
      requirementPath,
      contextCount: plan.manifest.context.length,
      manifest: plan.manifest,
    };
  } finally {
    releaseLock(lockPath);
  }
}

export function captureRequirementSource(
  input: RequirementSourceCaptureInput,
  deps: RequirementSourceStoreDeps = {},
): RequirementSourceCaptureResult {
  const workspace = readWorkspace(resolve(input.workspaceRoot));
  try {
    return withWorkspaceAuthorityLockSync({
      rollHome: resolve(input.rollHome),
      workspaceId: workspace.workspaceId,
      operation: "requirement-capture",
      onAcquired: () => deps.onLockAcquired?.("authority"),
    }, () => captureRequirementSourceUnlocked(input, deps));
  } catch (error) {
    if (error instanceof WorkspaceAuthorityLockError) {
      return fail("concurrent_capture", "Workspace authority is locked by another metadata writer", error);
    }
    throw error;
  }
}
