import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  appendIssueEventAtomically,
  readRepositoryBoundFacts,
  readWorkspace,
} from "@roll/infra";
import {
  buildWorkspaceExecutionContext,
  deriveWorkspaceExecutionAuthorities,
  repositoryEventIdentity,
  type CycleContext,
} from "@roll/core";
import {
  parseIssueManifest,
  type CycleRepositoryExecutionContext,
  type IssueExecutionEvent,
  type IssueExecutionEventPayload,
  type RepositoryExecutionContext,
  type RepositoryExecutionEvent,
  type RepositoryExecutionEventPayload,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";

const execFileAsync = promisify(execFile);

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function issueManifest(issueRoot: string, workspaceId: string, storyId: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(issueRoot, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(`invalid_issue_manifest: ${(error as Error).message}`, { cause: error });
  }
  const parsed = parseIssueManifest(raw, { workspaceId, storyId });
  if (!parsed.ok) {
    throw new Error(`invalid_issue_manifest: ${parsed.errors.map((entry) => `${entry.path}:${entry.code}`).join(",")}`);
  }
  return parsed.value;
}

async function worktreeHead(worktreePath: string): Promise<string> {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  }).catch((error: unknown) => {
    throw new Error(`invalid_repository_worktree: ${worktreePath}`, { cause: error });
  });
  const head = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(head)) {
    throw new Error(`invalid_repository_head: ${worktreePath}`);
  }
  return head;
}

/** Resolve an already-initialized Workspace Issue after Story pick. Legacy
 * repository roots return undefined; a Workspace with inconsistent Issue facts
 * fails loud and never falls back to repo-local cwd inference. */
export async function resolveRepositoryExecutionContext(
  workspaceRoot: string,
  storyId: string,
): Promise<CycleRepositoryExecutionContext | undefined> {
  if (!existsSync(join(workspaceRoot, "workspace.yaml"))) return undefined;
  const workspace = readWorkspace(workspaceRoot);
  const issueRoot = join(workspaceRoot, "issues", storyId);
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const canonicalIssue = realpathSync(issueRoot);
  if (!contained(canonicalWorkspace, canonicalIssue)) {
    throw new Error(`invalid_issue_root: ${storyId}`);
  }
  const manifest = issueManifest(issueRoot, workspace.workspaceId, storyId);
  const boundFacts = readRepositoryBoundFacts(issueRoot);
  const repositories: Record<string, RepositoryExecutionContext> = {};
  for (const target of manifest.repositories) {
    const fact = boundFacts.get(target.alias);
    const workBranch = target.access === "write" ? (target.workBranch ?? fact?.workBranch ?? undefined) : undefined;
    if (
      fact === undefined ||
      fact.workspaceId !== workspace.workspaceId ||
      fact.storyId !== storyId ||
      fact.repoId !== target.repoId ||
      fact.access !== target.access ||
      (target.access === "write" && (workBranch === undefined || fact.workBranch !== workBranch)) ||
      (target.access === "read" && fact.workBranch !== null)
    ) {
      throw new Error(`repository_context_mismatch: ${target.alias}`);
    }
    const canonicalWorktree = realpathSync(fact.path);
    if (!contained(canonicalIssue, canonicalWorktree)) {
      throw new Error(`repository_worktree_escape: ${target.alias}`);
    }
    repositories[target.repoId] = {
      repoId: target.repoId,
      alias: target.alias,
      access: target.access,
      requiredDelivery: target.requiredDelivery,
      ...(target.access === "write" ? { noChangePolicy: target.noChangePolicy } : {}),
      ...(workBranch === undefined ? {} : { workBranch }),
      ...(target.dependsOnRepo === undefined ? {} : { dependsOnRepo: target.dependsOnRepo }),
      worktreePath: canonicalWorktree,
      baseSha: fact.baseSha,
      headSha: await worktreeHead(canonicalWorktree),
      // US-WS-012 owns toolchain command resolution. Do not infer commands from
      // package files, CI check names or cwd shape here.
      commands: { test: [], integration: manifest.integrationAcceptance?.command ?? [] },
    };
  }
  if (Object.keys(repositories).length === 0) {
    throw new Error(`invalid_repository_map: ${storyId}`);
  }
  const integrationCwdTarget = manifest.integrationAcceptance === undefined
    ? undefined
    : manifest.integrationAcceptance.cwd === undefined
      ? manifest.repositories.filter((target) => target.access === "write").length === 1
        ? manifest.repositories.find((target) => target.access === "write")
        : undefined
      : manifest.repositories.find((target) => target.alias === manifest.integrationAcceptance?.cwd);
  const integrationAcceptance = manifest.integrationAcceptance === undefined ? undefined : {
    command: manifest.integrationAcceptance.command,
    cwdRepoId: integrationCwdTarget?.repoId ?? "",
  };
  if (integrationAcceptance !== undefined && integrationAcceptance.cwdRepoId === "") {
    throw new Error(`invalid_integration_cwd: ${manifest.integrationAcceptance?.cwd ?? ""}`);
  }
  return {
    workspaceId: workspace.workspaceId,
    issueRoot: canonicalIssue,
    repositories,
    ...(integrationAcceptance === undefined ? {} : { integrationAcceptance }),
  };
}

/** Rebuild and validate the full immutable Workspace context at the Cycle bind
 * boundary. Repository ports use this single snapshot for every governed tool
 * invocation in the Cycle. */
export function buildRepositoryWorkspaceExecutionContext(
  workspaceRoot: string,
  storyId: string,
  execution: CycleRepositoryExecutionContext,
): WorkspaceExecutionContextV1 {
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const workspace = readWorkspace(canonicalWorkspace);
  const manifest = issueManifest(execution.issueRoot, workspace.workspaceId, storyId);
  const built = buildWorkspaceExecutionContext({
    facts: {
      candidate: {
        workspaceId: workspace.workspaceId,
        root: canonicalWorkspace,
        canonicalRoot: canonicalWorkspace,
        manifestWorkspaceId: workspace.workspaceId,
        pathState: "valid",
        lifecycle: "active",
      },
      manifest: workspace,
      authorities: deriveWorkspaceExecutionAuthorities(canonicalWorkspace),
      issue: {
        manifest,
        manifestPath: join(execution.issueRoot, "manifest.json"),
        execution,
      },
    },
    source: "issue_manifest",
    evidence: [],
  });
  if (!built.ok) {
    throw new Error(`${built.error.code}: ${built.error.message}`);
  }
  return built.context;
}

/** The only Issue event writer for repository-scoped runtime facts. Callers
 * provide payload only; Workspace/Story/Cycle/repo identity is derived from the
 * bound CycleContext and written last so it cannot be forged or omitted. */
export function appendRepositoryExecutionEvent(
  ctx: CycleContext,
  repoId: string,
  payload: RepositoryExecutionEventPayload,
): RepositoryExecutionEvent {
  const identified = repositoryEventIdentity(ctx, repoId);
  if (!identified.ok) {
    throw new Error(`${identified.code}: ${identified.repoId ?? repoId}`);
  }
  const execution = ctx.repositoryExecution;
  if (execution === undefined) throw new Error("missing_repository_context");
  const event: RepositoryExecutionEvent = { ...payload, ...identified.identity };
  appendIssueEventAtomically(execution.issueRoot, event);
  return event;
}

/** The only Issue event writer for Story-level facts spanning repository legs. */
export function appendIssueExecutionEvent(
  ctx: CycleContext,
  payload: IssueExecutionEventPayload,
): IssueExecutionEvent {
  const execution = ctx.repositoryExecution;
  const storyId = ctx.storyId ?? "";
  if (execution === undefined) throw new Error("missing_repository_context");
  if (storyId === "" || ctx.cycleId === "") throw new Error("missing_issue_cycle_identity");
  const event: IssueExecutionEvent = {
    ...payload,
    workspaceId: execution.workspaceId,
    storyId,
    cycleId: ctx.cycleId,
  };
  appendIssueEventAtomically(execution.issueRoot, event);
  return event;
}
