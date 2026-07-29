import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  foldWorkspaceLifecycles,
  type WorkspaceDiscoveryFactsV1,
  type WorkspaceRegistryCandidate,
} from "@roll/core";
import {
  parseIssueManifest,
  parseWorkspaceManifest,
  type IssueManifest,
  type WorkspaceDiscoveryDiagnosticCode,
  type WorkspaceDiscoveryDiagnosticV1,
  type WorkspaceLifecycle,
} from "@roll/spec";
import {
  WorkspaceRegistry,
  workspaceRegistryPath,
} from "./workspace-registry.js";

export const WORKSPACE_DISCOVERY_LOAD_V1 = "roll.workspace-discovery-load/v1" as const;
export const WORKSPACE_DISCOVERY_INDEX_V1 = "roll.workspace-discovery-index/v1" as const;
export const MAX_DISCOVERY_ISSUES_PER_WORKSPACE = 4_096;
const MAX_DISCOVERY_AUTHORITY_BYTES = 4 * 1024 * 1024;

export interface WorkspaceDiscoveryLoadResultV1 {
  readonly schema: typeof WORKSPACE_DISCOVERY_LOAD_V1;
  readonly registryRevision: number;
  readonly discoveryFactsSha256: string;
  readonly workspaces: readonly WorkspaceDiscoveryFactsV1[];
  readonly diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[];
}

export interface WorkspaceDiscoveryLoaderDependencies {
  readonly afterAuthorityRead?: (path: string) => void;
}

class DiscoveryAuthorityError extends Error {
  constructor(
    readonly code: WorkspaceDiscoveryDiagnosticCode,
    readonly authorityPath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DiscoveryAuthorityError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshotMetadata(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function safeCanonicalRoot(entry: {
  readonly root: string;
  readonly canonicalRoot: string;
  readonly pathState: "valid" | "stale";
}): string {
  if (entry.pathState === "stale") {
    throw new DiscoveryAuthorityError("stale_registry", entry.root, "Workspace registry entry is marked stale");
  }
  try {
    const canonical = realpathSync(entry.canonicalRoot);
    const rootCanonical = realpathSync(entry.root);
    const stat = lstatSync(canonical);
    if (canonical !== entry.canonicalRoot || rootCanonical !== entry.canonicalRoot || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new DiscoveryAuthorityError("stale_registry", entry.root, "Workspace registry root no longer resolves to its canonical root");
    }
    return canonical;
  } catch (error) {
    if (error instanceof DiscoveryAuthorityError) throw error;
    throw new DiscoveryAuthorityError("stale_registry", entry.root, "Workspace registry root could not be resolved", { cause: error });
  }
}

function safeAuthorityFile(
  workspaceRoot: string,
  path: string,
  dependencies: WorkspaceDiscoveryLoaderDependencies,
  missingCode: "invalid_workspace_manifest" | "invalid_issue_manifest",
): Buffer {
  let fd: number | undefined;
  try {
    const beforePath = lstatSync(path);
    if (beforePath.isSymbolicLink()) {
      throw new DiscoveryAuthorityError("symlink_escape", path, "Workspace discovery authority must not be a symlink");
    }
    if (!beforePath.isFile()) {
      throw new DiscoveryAuthorityError("discovery_io_failure", path, "Workspace discovery authority is not a regular file");
    }
    if (beforePath.size > MAX_DISCOVERY_AUTHORITY_BYTES) {
      throw new DiscoveryAuthorityError("discovery_io_failure", path, "Workspace discovery authority exceeds the bounded read limit");
    }
    const canonical = realpathSync(path);
    if (canonical !== path || !contained(workspaceRoot, canonical)) {
      throw new DiscoveryAuthorityError("symlink_escape", path, "Workspace discovery authority escapes its canonical root");
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const beforeFd = fstatSync(fd);
    if (!beforeFd.isFile() || !sameIdentity(beforePath, beforeFd)) {
      throw new DiscoveryAuthorityError("discovery_io_failure", path, "Workspace discovery authority changed before its bounded read");
    }
    const bytes = Buffer.alloc(beforeFd.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) {
      throw new DiscoveryAuthorityError("discovery_io_failure", path, "Workspace discovery authority could not be read completely");
    }
    dependencies.afterAuthorityRead?.(path);
    const afterPath = lstatSync(path);
    if (afterPath.isSymbolicLink()) {
      throw new DiscoveryAuthorityError("symlink_escape", path, "Workspace discovery authority became a symlink during read");
    }
    const afterFd = fstatSync(fd);
    if (
      !afterPath.isFile() || !sameIdentity(afterPath, afterFd) ||
      !sameSnapshotMetadata(beforeFd, afterFd)
    ) {
      throw new DiscoveryAuthorityError("discovery_io_failure", path, "Workspace discovery authority changed during read");
    }
    const verification = Buffer.alloc(afterFd.size);
    let verificationOffset = 0;
    while (verificationOffset < verification.length) {
      const count = readSync(
        fd,
        verification,
        verificationOffset,
        verification.length - verificationOffset,
        verificationOffset,
      );
      if (count === 0) break;
      verificationOffset += count;
    }
    const finalFd = fstatSync(fd);
    const finalPath = lstatSync(path);
    if (
      verificationOffset !== verification.length || finalPath.isSymbolicLink() || !finalPath.isFile() ||
      !sameIdentity(finalPath, finalFd) || !sameSnapshotMetadata(afterFd, finalFd) ||
      sha256(verification) !== sha256(bytes)
    ) {
      throw new DiscoveryAuthorityError("discovery_io_failure", path, "Workspace discovery authority snapshot was not stable");
    }
    return bytes;
  } catch (error) {
    if (error instanceof DiscoveryAuthorityError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DiscoveryAuthorityError(missingCode, path, "Workspace discovery authority is missing", { cause: error });
    }
    throw new DiscoveryAuthorityError("discovery_io_failure", path, "Workspace discovery authority could not be read", { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Reuse the discovery loader's FD-bound, bounded, no-follow authority read
 * for another selected-Workspace host loader. The caller supplies a canonical
 * Workspace root and one authority path inside it; no ambient cwd is used. */
export function readWorkspaceAuthoritySnapshot(
  input: {
    readonly workspaceRoot: string;
    readonly path: string;
    readonly missingCode: "invalid_workspace_manifest" | "invalid_issue_manifest";
  },
  dependencies: WorkspaceDiscoveryLoaderDependencies = {},
): Buffer {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(input.workspaceRoot);
  } catch (error) {
    throw new DiscoveryAuthorityError("stale_registry", input.workspaceRoot, "Workspace root could not be resolved", { cause: error });
  }
  if (canonicalRoot !== input.workspaceRoot || !contained(canonicalRoot, input.path)) {
    throw new DiscoveryAuthorityError("symlink_escape", input.path, "Workspace authority escapes its canonical root");
  }
  return safeAuthorityFile(canonicalRoot, input.path, dependencies, input.missingCode);
}

function parseJson(bytes: Buffer, code: WorkspaceDiscoveryDiagnosticCode, path: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new DiscoveryAuthorityError(code, path, "Workspace discovery authority is not valid JSON", { cause: error });
  }
}

function safeIssueDirectories(workspaceRoot: string): readonly string[] {
  const issuesRoot = join(workspaceRoot, "issues");
  if (!existsSync(issuesRoot)) return [];
  try {
    const stat = lstatSync(issuesRoot);
    if (stat.isSymbolicLink()) {
      throw new DiscoveryAuthorityError("symlink_escape", issuesRoot, "Workspace Issue authority directory must not be a symlink");
    }
    if (!stat.isDirectory() || realpathSync(issuesRoot) !== issuesRoot) {
      throw new DiscoveryAuthorityError("discovery_io_failure", issuesRoot, "Workspace Issue authority is not a canonical directory");
    }
    const entries = readdirSync(issuesRoot, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
    if (entries.length > MAX_DISCOVERY_ISSUES_PER_WORKSPACE) {
      throw new DiscoveryAuthorityError("discovery_io_failure", issuesRoot, "Workspace Issue authority exceeds the bounded discovery limit");
    }
    const directories: string[] = [];
    for (const entry of entries) {
      const path = join(issuesRoot, entry.name);
      if (entry.isSymbolicLink()) {
        throw new DiscoveryAuthorityError("symlink_escape", path, "Workspace Issue authority contains a symlink");
      }
      if (!entry.isDirectory()) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name)) {
        throw new DiscoveryAuthorityError("invalid_issue_manifest", path, "Workspace Issue directory has an invalid identity");
      }
      if (realpathSync(path) !== path || !contained(workspaceRoot, path)) {
        throw new DiscoveryAuthorityError("symlink_escape", path, "Workspace Issue directory escapes its canonical root");
      }
      directories.push(entry.name);
    }
    return directories;
  } catch (error) {
    if (error instanceof DiscoveryAuthorityError) throw error;
    throw new DiscoveryAuthorityError("discovery_io_failure", issuesRoot, "Workspace Issue authority could not be enumerated", { cause: error });
  }
}

function loadIssues(
  workspaceRoot: string,
  workspaceId: string,
  dependencies: WorkspaceDiscoveryLoaderDependencies,
): { readonly facts: WorkspaceDiscoveryFactsV1["issues"]; readonly authoritySha256: string } {
  const issues: Pick<IssueManifest, "storyId" | "workspaceId" | "requirements">[] = [];
  const digests: string[] = [];
  for (const storyId of safeIssueDirectories(workspaceRoot)) {
    const manifestPath = join(workspaceRoot, "issues", storyId, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new DiscoveryAuthorityError("invalid_issue_manifest", manifestPath, "Workspace Issue manifest is missing");
    }
    const bytes = safeAuthorityFile(workspaceRoot, manifestPath, dependencies, "invalid_issue_manifest");
    const parsed = parseIssueManifest(parseJson(bytes, "invalid_issue_manifest", manifestPath), { workspaceId, storyId });
    if (!parsed.ok) {
      throw new DiscoveryAuthorityError("invalid_issue_manifest", manifestPath, "Workspace Issue manifest is invalid or mismatched");
    }
    issues.push({
      storyId: parsed.value.storyId,
      workspaceId: parsed.value.workspaceId,
      requirements: parsed.value.requirements,
    });
    digests.push(`${storyId}\0${sha256(bytes)}`);
  }
  return { facts: issues, authoritySha256: sha256(digests.join("\n")) };
}

export function workspaceDiscoveryIndexPath(rollHome: string, workspaceId: string): string {
  return join(rollHome, "cache", "workspace-discovery", `${workspaceId}.json`);
}

function rebuildDerivedIndex(
  rollHome: string,
  workspaceId: string,
  authoritySha256: string,
  issueCount: number,
): void {
  const value = {
    schema: WORKSPACE_DISCOVERY_INDEX_V1,
    workspaceId,
    authoritySha256,
    issueCount,
  };
  let path: string;
  try {
    mkdirSync(rollHome, { recursive: true });
    const canonicalHome = realpathSync(rollHome);
    if (lstatSync(canonicalHome).isSymbolicLink()) return;
    const cacheRoot = join(canonicalHome, "cache");
    if (existsSync(cacheRoot)) {
      const cacheStat = lstatSync(cacheRoot);
      if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory() || realpathSync(cacheRoot) !== cacheRoot) return;
    } else {
      mkdirSync(cacheRoot);
    }
    const discoveryRoot = join(cacheRoot, "workspace-discovery");
    if (existsSync(discoveryRoot)) {
      const discoveryStat = lstatSync(discoveryRoot);
      if (
        discoveryStat.isSymbolicLink() || !discoveryStat.isDirectory() ||
        realpathSync(discoveryRoot) !== discoveryRoot
      ) return;
    } else {
      mkdirSync(discoveryRoot);
    }
    path = join(discoveryRoot, `${workspaceId}.json`);
  } catch {
    return;
  }
  const temp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch {
    // The index is disposable derived data; authority loading never depends on it.
  } finally {
    rmSync(temp, { force: true });
  }
}

function diagnostic(
  entry: { readonly workspaceId: string; readonly root: string },
  error: DiscoveryAuthorityError,
): WorkspaceDiscoveryDiagnosticV1 {
  return {
    workspaceId: entry.workspaceId,
    root: entry.root,
    code: error.code,
    authorityPath: error.authorityPath,
    message: error.message,
  };
}

function factsDigest(input: {
  readonly registryRevision: number;
  readonly workspaces: readonly WorkspaceDiscoveryFactsV1[];
  readonly diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[];
}): string {
  return sha256(stableJson(input));
}

function loadWorkspaceDiscoveryInternal(
  input: { readonly rollHome: string },
  dependencies: WorkspaceDiscoveryLoaderDependencies,
  explicitReadWorkspaceId?: string,
): WorkspaceDiscoveryLoadResultV1 {
  const registry = new WorkspaceRegistry({ rollHome: input.rollHome });
  let snapshot;
  let lifecycleById: ReadonlyMap<string, { readonly lifecycle: WorkspaceLifecycle }>;
  try {
    snapshot = registry.read();
    lifecycleById = new Map(foldWorkspaceLifecycles(registry.readEvents()).map((state) => [state.workspaceId, state]));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace registry could not be loaded";
    const result = {
      registryRevision: 0,
      workspaces: [],
      diagnostics: [{
        workspaceId: "<registry>",
        root: input.rollHome,
        code: "discovery_io_failure" as const,
        authorityPath: workspaceRegistryPath(input.rollHome),
        message,
      }],
    };
    return { schema: WORKSPACE_DISCOVERY_LOAD_V1, ...result, discoveryFactsSha256: factsDigest(result) };
  }

  const workspaces: WorkspaceDiscoveryFactsV1[] = [];
  const diagnostics: WorkspaceDiscoveryDiagnosticV1[] = [];
  for (const entry of snapshot.entries) {
    if (explicitReadWorkspaceId !== undefined && entry.workspaceId !== explicitReadWorkspaceId) continue;
    const lifecycle = lifecycleById.get(entry.workspaceId)?.lifecycle;
    if (lifecycle === undefined) {
      diagnostics.push({
        workspaceId: entry.workspaceId,
        root: entry.root,
        code: "discovery_io_failure",
        authorityPath: workspaceRegistryPath(input.rollHome),
        message: "Workspace registry entry has no lifecycle authority",
      });
      continue;
    }
    if (lifecycle === "archived" && explicitReadWorkspaceId !== entry.workspaceId) continue;
    try {
      const workspaceRoot = safeCanonicalRoot(entry);
      const manifestPath = join(workspaceRoot, "workspace.yaml");
      const manifestBytes = safeAuthorityFile(workspaceRoot, manifestPath, dependencies, "invalid_workspace_manifest");
      const parsedManifest = parseWorkspaceManifest(parseJson(
        manifestBytes,
        "invalid_workspace_manifest",
        manifestPath,
      ), { workspaceId: entry.workspaceId });
      if (!parsedManifest.ok) {
        const identityMismatch = parsedManifest.errors.some((finding) => finding.code === "identity_mismatch");
        throw new DiscoveryAuthorityError(
          identityMismatch ? "identity_mismatch" : "invalid_workspace_manifest",
          manifestPath,
          identityMismatch ? "Workspace manifest identity does not match registry" : "Workspace manifest is invalid",
        );
      }
      const issues = loadIssues(workspaceRoot, entry.workspaceId, dependencies);
      const candidate: WorkspaceRegistryCandidate = {
        workspaceId: entry.workspaceId,
        root: entry.root,
        canonicalRoot: workspaceRoot,
        manifestWorkspaceId: parsedManifest.value.workspaceId,
        pathState: "valid",
        lifecycle,
      };
      const facts: WorkspaceDiscoveryFactsV1 = {
        candidate,
        manifest: parsedManifest.value,
        issues: issues.facts,
      };
      workspaces.push(facts);
      rebuildDerivedIndex(
        input.rollHome,
        entry.workspaceId,
        sha256(`${sha256(manifestBytes)}\n${issues.authoritySha256}`),
        issues.facts.length,
      );
    } catch (error) {
      const authorityError = error instanceof DiscoveryAuthorityError
        ? error
        : new DiscoveryAuthorityError(
            "discovery_io_failure",
            entry.canonicalRoot,
            error instanceof Error ? error.message : "Workspace discovery failed",
            { cause: error },
          );
      diagnostics.push(diagnostic(entry, authorityError));
    }
  }

  workspaces.sort((left, right) => compareText(left.candidate.workspaceId, right.candidate.workspaceId));
  diagnostics.sort((left, right) => (
    compareText(left.workspaceId, right.workspaceId) ||
    compareText(left.authorityPath, right.authorityPath) ||
    compareText(left.code, right.code)
  ));
  const digestInput = { registryRevision: snapshot.revision, workspaces, diagnostics };
  return {
    schema: WORKSPACE_DISCOVERY_LOAD_V1,
    ...digestInput,
    discoveryFactsSha256: factsDigest(digestInput),
  };
}

export function loadWorkspaceDiscovery(
  input: { readonly rollHome: string },
  dependencies: WorkspaceDiscoveryLoaderDependencies = {},
): WorkspaceDiscoveryLoadResultV1 {
  return loadWorkspaceDiscoveryInternal(input, dependencies);
}

export function loadExplicitWorkspaceDiscovery(
  input: { readonly rollHome: string; readonly workspaceId: string },
  dependencies: WorkspaceDiscoveryLoaderDependencies = {},
): WorkspaceDiscoveryLoadResultV1 {
  return loadWorkspaceDiscoveryInternal(input, dependencies, input.workspaceId);
}
