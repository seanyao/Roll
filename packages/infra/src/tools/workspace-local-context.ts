import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { resolveWorkspaceExecutionContextScope } from "@roll/core";
import type {
  RepositoryExecutionContext,
  ToolContextCorrelation,
  ToolErrorCode,
  ToolInvocation,
} from "@roll/spec";

export type WorkspaceLocalAccess = "read" | "write";

export type WorkspaceLocalContextFailure = {
  ok: false;
  code: Extract<ToolErrorCode, "missing_execution_context" | "invalid_execution_context">;
  message: string;
};

export type WorkspaceLocalRepository = {
  ok: true;
  repository: RepositoryExecutionContext;
  canonicalWorktreePath: string;
  correlation: ToolContextCorrelation;
};

export type WorkspaceLocalRepositoryResult = WorkspaceLocalContextFailure | WorkspaceLocalRepository;

export function resolveWorkspaceLocalRepository(
  invocation: Pick<ToolInvocation, "context" | "repoId">,
  access: WorkspaceLocalAccess,
): WorkspaceLocalRepositoryResult {
  if (invocation.context === undefined || invocation.context.issue === undefined) {
    return missing("tool invocation requires an Issue execution context");
  }
  const scoped = resolveWorkspaceExecutionContextScope({ scope: "repository_required", context: invocation.context });
  const context = scoped.ok ? scoped.context : undefined;
  const issue = context?.issue;
  if (context === undefined || issue === undefined) {
    return invalid("tool invocation has an invalid Issue repository execution context");
  }

  const repositories = Object.values(issue.execution.repositories);
  let repository: RepositoryExecutionContext | undefined;
  if (invocation.repoId !== undefined) {
    repository = issue.execution.repositories[invocation.repoId];
    if (repository === undefined) return invalid("selected repository is not bound to the Issue context");
  } else {
    const eligible = access === "write" ? repositories.filter((candidate) => candidate.access === "write") : repositories;
    if (eligible.length !== 1) return missing(`tool invocation requires a unique ${access} Issue repository`);
    repository = eligible[0];
  }

  if (repository === undefined) return missing(`tool invocation requires a unique ${access} Issue repository`);

  if (access === "write" && repository.access !== "write") {
    return invalid("selected Issue repository does not grant write access");
  }

  const canonicalIssueRoot = canonicalExistingPath(issue.execution.issueRoot);
  const canonicalWorktreePath = canonicalExistingPath(repository.worktreePath);
  if (
    canonicalIssueRoot === undefined ||
    canonicalWorktreePath === undefined ||
    !isCanonicalPathContained(canonicalIssueRoot, canonicalWorktreePath)
  ) {
    return invalid("selected Issue repository worktree is unavailable");
  }
  return {
    ok: true,
    repository,
    canonicalWorktreePath,
    correlation: {
      workspaceId: context.workspace.workspaceId,
      storyId: issue.storyId,
      repoId: repository.repoId,
    },
  };
}

export function canonicalExistingPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

export function isCanonicalPathContained(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

export function resolveContainedExistingPath(root: string, path: string): string | undefined {
  const lexical = resolve(root, path);
  const canonical = canonicalExistingPath(lexical);
  if (canonical === undefined || !isCanonicalPathContained(root, canonical)) return undefined;
  return canonical;
}

export function resolveContainedPath(root: string, path: string, allowMissing: boolean): string | undefined {
  const lexical = resolve(root, path);
  const existing = canonicalExistingPath(lexical);
  if (existing !== undefined) return isCanonicalPathContained(root, existing) ? existing : undefined;
  if (!allowMissing) return undefined;

  const suffix: string[] = [];
  let ancestor = lexical;
  let canonicalAncestor: string | undefined;
  while (canonicalAncestor === undefined) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return undefined;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
    canonicalAncestor = canonicalExistingPath(ancestor);
  }
  if (!isCanonicalPathContained(root, canonicalAncestor)) return undefined;
  const target = resolve(canonicalAncestor, ...suffix);
  return isCanonicalPathContained(root, target) ? target : undefined;
}

function missing(message: string): WorkspaceLocalContextFailure {
  return { ok: false, code: "missing_execution_context", message };
}

function invalid(message: string): WorkspaceLocalContextFailure {
  return { ok: false, code: "invalid_execution_context", message };
}
