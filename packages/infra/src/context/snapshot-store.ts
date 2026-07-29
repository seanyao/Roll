import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ContextDiagnosticV1, ContextReadFileV1, ContextReadResultV1, WorkspaceExecutionContextV1 } from "@roll/spec";
import { verifyContextSnapshot, type ContextSnapshotReferenceV1 } from "@roll/core";

export class ContextSnapshotStoreError extends Error {
  readonly diagnostic: ContextDiagnosticV1 = {
    code: "invalid_context_snapshot",
    severity: "blocking",
    message: "Context Snapshot artifact is invalid",
  };

  constructor(message = "Context Snapshot artifact is invalid") {
    super(message);
    this.name = "ContextSnapshotStoreError";
  }
}

export interface ContextSnapshotWriteOptions {
  /** Test/host seam invoked after the exclusive temp write and before atomic publication. */
  readonly beforePublish?: () => void;
}

function invalid(): never {
  throw new ContextSnapshotStoreError();
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
}

function expectedArtifactPath(workspace: WorkspaceExecutionContextV1, snapshot: ContextReadResultV1): string {
  const runtime = resolve(workspace.authorities.runtime);
  const scopeFolder = snapshot.requestScope.storyId ?? "_workspace";
  return join(runtime, "context", scopeFolder, `${snapshot.snapshotId}.json`);
}

function assertSafeDirectory(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) invalid();
}

function prepareArtifactDirectory(workspace: WorkspaceExecutionContextV1, snapshot: ContextReadResultV1): string {
  const runtime = resolve(workspace.authorities.runtime);
  if (!isAbsolute(workspace.authorities.runtime)) invalid();
  assertSafeDirectory(runtime);
  const contextRoot = join(runtime, "context");
  assertSafeDirectory(contextRoot);
  mkdirSync(contextRoot, { recursive: true, mode: 0o700 });
  const artifactDirectory = dirname(expectedArtifactPath(workspace, snapshot));
  assertSafeDirectory(artifactDirectory);
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  assertSafeDirectory(artifactDirectory);
  return artifactDirectory;
}

function assertSnapshotForWorkspace(workspace: WorkspaceExecutionContextV1, snapshot: ContextReadResultV1): string {
  const verification = verifyContextSnapshot(snapshot);
  if (!verification.valid || snapshot.outcome === "disabled") invalid();
  if (snapshot.requestScope.workspaceId !== workspace.workspace.workspaceId) invalid();
  const expected = expectedArtifactPath(workspace, snapshot);
  const runtime = resolve(workspace.authorities.runtime);
  if (!contained(runtime, expected) || resolve(snapshot.artifactPath) !== expected || snapshot.artifactPath !== expected) invalid();
  return expected;
}

export function writeContextSnapshot(
  workspace: WorkspaceExecutionContextV1,
  snapshot: ContextReadResultV1,
  options: ContextSnapshotWriteOptions = {},
): string {
  const target = assertSnapshotForWorkspace(workspace, snapshot);
  const directory = prepareArtifactDirectory(workspace, snapshot);
  const lock = `${target}.write-lock`;
  const temporary = join(directory, `.${snapshot.snapshotId}.${process.pid}.${randomUUID()}.tmp`);
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    invalid();
  }
  try {
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    options.beforePublish?.();
    linkSync(temporary, target);
    rmSync(temporary, { force: true });
    return target;
  } catch (error) {
    if (error instanceof ContextSnapshotStoreError) throw error;
    invalid();
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

export function readContextSnapshot(
  workspace: WorkspaceExecutionContextV1,
  reference: ContextSnapshotReferenceV1,
): ContextReadResultV1 {
  const runtime = resolve(workspace.authorities.runtime);
  const target = resolve(reference.artifactPath);
  if (!contained(runtime, target) || target !== reference.artifactPath) invalid();
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(target) !== target) invalid();
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    const verification = verifyContextSnapshot(parsed);
    if (
      !verification.valid ||
      verification.snapshot.snapshotId !== reference.snapshotId ||
      verification.snapshot.snapshotDigest !== reference.snapshotDigest ||
      verification.snapshot.artifactPath !== reference.artifactPath ||
      expectedArtifactPath(workspace, verification.snapshot) !== target
    ) invalid();
    if (verification.snapshot.requestScope.workspaceId !== workspace.workspace.workspaceId) invalid();
    return verification.snapshot;
  } catch (error) {
    if (error instanceof ContextSnapshotStoreError) throw error;
    invalid();
  }
}

export function readCapturedContextFile(
  snapshot: ContextReadResultV1,
  ref: string,
): ContextReadFileV1 {
  for (const provider of snapshot.providers) {
    const file = provider.files.find((entry) => entry.ref === ref);
    if (file !== undefined) return file;
  }
  invalid();
}
