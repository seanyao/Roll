import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildWorkspaceExecutionContext,
  deriveWorkspaceExecutionAuthorities,
  resolveWorkspaceExecutionContextScope,
  type ResolvedWorkspaceTarget,
  type WorkspaceExecutionContextErrorCode,
} from "@roll/core";
import {
  parseIssueManifest,
  type RepositoryExecutionContext,
  type WorkspaceContextScope,
  type WorkspaceExecutionContextResolutionSource,
  type WorkspaceExecutionContextV1,
  type WorkspaceMatchEvidence,
} from "@roll/spec";
import { readRepositoryBoundFacts } from "./issue-worktrees.js";
import {
  loadExplicitWorkspaceDiscovery,
  readWorkspaceAuthoritySnapshot,
  type WorkspaceDiscoveryLoaderDependencies,
} from "./workspace-discovery.js";

export type WorkspaceContextLoaderErrorCode = WorkspaceExecutionContextErrorCode
  | "target_mismatch"
  | "workspace_discovery_incomplete"
  | "invalid_issue_manifest"
  | "symlink_escape"
  | "authority_changed"
  | "invalid_repository_head";

export class WorkspaceContextLoaderError extends Error {
  constructor(readonly code: WorkspaceContextLoaderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceContextLoaderError";
  }
}

export interface WorkspaceContextLoaderDependencies extends WorkspaceDiscoveryLoaderDependencies {
  readonly headSha?: (worktreePath: string) => string;
  readonly afterRepositoryHead?: (worktreePath: string) => void;
}

export interface WorkspaceContextLoaderInput {
  readonly rollHome: string;
  readonly target?: ResolvedWorkspaceTarget;
  readonly source: WorkspaceExecutionContextResolutionSource;
  readonly scope: WorkspaceContextScope;
  readonly storyId?: string;
  readonly evidence: readonly WorkspaceMatchEvidence[];
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalDirectorySnapshot(path: string, code: WorkspaceContextLoaderErrorCode): Stats {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== path) {
      fail(code, `Authority directory is not canonical: ${path}`);
    }
    return stat;
  } catch (error) {
    if (error instanceof WorkspaceContextLoaderError) throw error;
    fail(code, `Authority directory could not be inspected: ${path}`, error);
  }
}

function assertDirectoryUnchanged(path: string, before: Stats): void {
  try {
    const after = lstatSync(path);
    if (
      after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(before, after) ||
      realpathSync(path) !== path
    ) {
      fail("authority_changed", `Authority directory changed during context loading: ${path}`);
    }
  } catch (error) {
    if (error instanceof WorkspaceContextLoaderError) throw error;
    fail("authority_changed", `Authority directory changed during context loading: ${path}`, error);
  }
}

function fail(code: WorkspaceContextLoaderErrorCode, message: string, cause?: unknown): never {
  throw new WorkspaceContextLoaderError(code, message, cause === undefined ? undefined : { cause });
}

function assertSafeAuthorityPath(root: string, target: string): void {
  if (!isAbsolute(target) || resolve(target) !== target || !contained(root, target)) {
    fail("symlink_escape", `Workspace authority path escapes its canonical root: ${target}`);
  }
  const relativePath = relative(root, target);
  const segments = relativePath === "" ? [] : relativePath.split(sep);
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    let stat: Stats;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      fail("authority_changed", `Workspace authority path could not be inspected: ${cursor}`, error);
    }
    if (stat.isSymbolicLink()) fail("symlink_escape", `Workspace authority contains a symlink: ${cursor}`);
    let canonical: string;
    try {
      canonical = realpathSync(cursor);
    } catch (error) {
      fail("authority_changed", `Workspace authority path changed during inspection: ${cursor}`, error);
    }
    if (canonical !== cursor || !contained(root, canonical)) {
      fail("symlink_escape", `Workspace authority path is not canonically contained: ${cursor}`);
    }
  }
}

function defaultHeadSha(worktreePath: string): string {
  try {
    return execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail("invalid_repository_head", `Repository HEAD could not be resolved: ${worktreePath}`, error);
  }
}

function stableWorktreeHead(
  worktreePath: string,
  dependencies: WorkspaceContextLoaderDependencies,
): string {
  let before: Stats;
  try {
    before = lstatSync(worktreePath);
    if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(worktreePath) !== worktreePath) {
      fail("symlink_escape", `Repository worktree is not a canonical directory: ${worktreePath}`);
    }
  } catch (error) {
    if (error instanceof WorkspaceContextLoaderError) throw error;
    fail("repository_context_mismatch", `Repository worktree could not be inspected: ${worktreePath}`, error);
  }
  let head: string;
  try {
    head = (dependencies.headSha ?? defaultHeadSha)(worktreePath);
  } catch (error) {
    if (error instanceof WorkspaceContextLoaderError) throw error;
    fail("invalid_repository_head", `Repository HEAD could not be resolved: ${worktreePath}`, error);
  }
  try {
    dependencies.afterRepositoryHead?.(worktreePath);
  } catch (error) {
    fail("authority_changed", `Repository worktree changed during HEAD resolution: ${worktreePath}`, error);
  }
  try {
    const after = lstatSync(worktreePath);
    if (
      after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(before, after) ||
      realpathSync(worktreePath) !== worktreePath
    ) {
      fail("authority_changed", `Repository worktree changed during HEAD resolution: ${worktreePath}`);
    }
  } catch (error) {
    if (error instanceof WorkspaceContextLoaderError) throw error;
    fail("authority_changed", `Repository worktree changed during HEAD resolution: ${worktreePath}`, error);
  }
  if (!/^[0-9a-f]{40,64}$/u.test(head)) {
    fail("invalid_repository_head", `Repository HEAD is not an immutable object ID: ${worktreePath}`);
  }
  return head;
}

function parseIssueAuthority(
  workspaceRoot: string,
  workspaceId: string,
  storyId: string,
  dependencies: WorkspaceContextLoaderDependencies,
) {
  const issueRoot = join(workspaceRoot, "issues", storyId);
  const manifestPath = join(issueRoot, "manifest.json");
  assertSafeAuthorityPath(workspaceRoot, issueRoot);
  const directorySnapshot = canonicalDirectorySnapshot(issueRoot, "invalid_issue_manifest");
  let raw: unknown;
  try {
    raw = JSON.parse(readWorkspaceAuthoritySnapshot({
      workspaceRoot,
      path: manifestPath,
      missingCode: "invalid_issue_manifest",
    }, dependencies).toString("utf8")) as unknown;
  } catch (error) {
    fail("invalid_issue_manifest", `Issue manifest could not be loaded: ${manifestPath}`, error);
  }
  const parsed = parseIssueManifest(raw, { workspaceId, storyId });
  if (!parsed.ok) fail("invalid_issue_manifest", `Issue manifest is invalid or mismatched: ${manifestPath}`);
  return { issueRoot, manifestPath, manifest: parsed.value, directorySnapshot };
}

function repositoryExecution(
  workspaceRoot: string,
  issue: ReturnType<typeof parseIssueAuthority>,
  dependencies: WorkspaceContextLoaderDependencies,
): Readonly<Record<string, RepositoryExecutionContext>> {
  const eventsPath = join(issue.issueRoot, "events.jsonl");
  let eventText: string;
  try {
    eventText = readWorkspaceAuthoritySnapshot({
      workspaceRoot,
      path: eventsPath,
      missingCode: "invalid_issue_manifest",
    }, dependencies).toString("utf8");
  } catch (error) {
    fail("repository_context_mismatch", `Issue repository facts could not be loaded: ${eventsPath}`, error);
  }
  let boundFacts;
  try {
    boundFacts = readRepositoryBoundFacts(issue.issueRoot, { readText: () => eventText });
  } catch (error) {
    fail("repository_context_mismatch", "Issue repository facts are invalid or conflicting", error);
  }
  const repositories: Record<string, RepositoryExecutionContext> = {};
  for (const target of issue.manifest.repositories) {
    const pinned = boundFacts.get(target.alias);
    const expectedWorktree = join(issue.issueRoot, target.alias);
    const workBranch = target.access === "write" ? (target.workBranch ?? pinned?.workBranch ?? undefined) : undefined;
    if (
      pinned === undefined || pinned.workspaceId !== issue.manifest.workspaceId ||
      pinned.storyId !== issue.manifest.storyId || pinned.repoId !== target.repoId ||
      pinned.access !== target.access || pinned.path !== expectedWorktree ||
      (target.access === "write" && (workBranch === undefined || pinned.workBranch !== workBranch)) ||
      (target.access === "read" && pinned.workBranch !== null)
    ) {
      fail("repository_context_mismatch", `Repository facts do not match Issue target ${target.alias}`);
    }
    assertSafeAuthorityPath(issue.issueRoot, expectedWorktree);
    repositories[target.repoId] = {
      repoId: target.repoId,
      alias: target.alias,
      access: target.access,
      requiredDelivery: target.requiredDelivery,
      ...(target.access === "write" ? { noChangePolicy: target.noChangePolicy } : {}),
      ...(workBranch === undefined ? {} : { workBranch }),
      ...(target.dependsOnRepo === undefined ? {} : { dependsOnRepo: target.dependsOnRepo }),
      worktreePath: expectedWorktree,
      baseSha: pinned.baseSha,
      headSha: stableWorktreeHead(expectedWorktree, dependencies),
      commands: { test: [], integration: issue.manifest.integrationAcceptance?.command ?? [] },
    };
  }
  if (Object.keys(repositories).length === 0 || Object.keys(repositories).length !== boundFacts.size) {
    fail("repository_context_mismatch", "Issue repository execution map is incomplete or contains undeclared facts");
  }
  return repositories;
}

export function loadWorkspaceExecutionContext(
  input: WorkspaceContextLoaderInput,
  dependencies: WorkspaceContextLoaderDependencies = {},
): WorkspaceExecutionContextV1 | undefined {
  if (input.target === undefined) {
    const scoped = resolveWorkspaceExecutionContextScope({ scope: input.scope, context: undefined });
    if (!scoped.ok) fail(scoped.error.code, scoped.error.message);
    return undefined;
  }
  const workspaceSnapshot = canonicalDirectorySnapshot(input.target.canonicalRoot, "target_mismatch");
  const loaded = loadExplicitWorkspaceDiscovery(
    { rollHome: input.rollHome, workspaceId: input.target.workspaceId },
    dependencies,
  );
  if (loaded.diagnostics.length > 0) {
    fail(
      "workspace_discovery_incomplete",
      `Selected Workspace authority could not be loaded completely: ${loaded.diagnostics.map((entry) => `${entry.code}:${entry.authorityPath}`).join(", ")}`,
    );
  }
  const facts = loaded.workspaces[0];
  if (
    facts === undefined || loaded.workspaces.length !== 1 ||
    facts.candidate.root !== input.target.root || facts.candidate.canonicalRoot !== input.target.canonicalRoot
  ) {
    fail("target_mismatch", "Selected Workspace target no longer matches the registry snapshot");
  }
  if (facts.candidate.lifecycle === "archived" && input.source !== "explicit") {
    fail("workspace_lifecycle_forbidden", "Archived Workspace context requires an explicit read target");
  }
  const authorities = deriveWorkspaceExecutionAuthorities(facts.candidate.canonicalRoot);
  for (const path of Object.values(authorities)) assertSafeAuthorityPath(facts.candidate.canonicalRoot, path);
  const issue = input.storyId === undefined
    ? undefined
    : parseIssueAuthority(facts.candidate.canonicalRoot, facts.candidate.workspaceId, input.storyId, dependencies);
  const repositories = issue === undefined
    ? undefined
    : repositoryExecution(facts.candidate.canonicalRoot, issue, dependencies);
  if (issue !== undefined) assertDirectoryUnchanged(issue.issueRoot, issue.directorySnapshot);
  const build = buildWorkspaceExecutionContext({
    facts: {
      candidate: facts.candidate,
      manifest: facts.manifest,
      authorities,
      ...(issue === undefined ? {} : {
        issue: {
          manifest: issue.manifest,
          manifestPath: issue.manifestPath,
          execution: {
            workspaceId: facts.candidate.workspaceId,
            issueRoot: issue.issueRoot,
            repositories: repositories ?? {},
            ...(issue.manifest.integrationAcceptance === undefined ? {} : {
              integrationAcceptance: {
                command: issue.manifest.integrationAcceptance.command,
                cwdRepoId: (issue.manifest.integrationAcceptance.cwd === undefined
                  ? issue.manifest.repositories.filter((target) => target.access === "write").length === 1
                    ? issue.manifest.repositories.find((target) => target.access === "write")
                    : undefined
                  : issue.manifest.repositories.find((target) => target.alias === issue.manifest.integrationAcceptance?.cwd))?.repoId ?? "",
              },
            }),
          },
        },
      }),
    },
    source: input.source,
    evidence: input.evidence,
  });
  if (!build.ok) fail(build.error.code, build.error.message);
  const scoped = resolveWorkspaceExecutionContextScope({ scope: input.scope, context: build.context });
  if (!scoped.ok) fail(scoped.error.code, scoped.error.message);
  assertDirectoryUnchanged(input.target.canonicalRoot, workspaceSnapshot);
  return scoped.context;
}
