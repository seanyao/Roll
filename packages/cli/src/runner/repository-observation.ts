import type { CycleContext, ObservedCommit } from "@roll/core";
import type { BoundRepositoryPorts } from "./ports.js";

export type RepositoryObservationOperation =
  | "commits_ahead"
  | "tcr_count"
  | "recent_commits"
  | "dirty";

export class RepositoryObservationError extends Error {
  constructor(
    readonly repoId: string,
    readonly operation: RepositoryObservationOperation,
    options?: ErrorOptions,
  ) {
    super(`repository_observation_failed: ${repoId}: ${operation}`, options);
    this.name = "RepositoryObservationError";
  }
}

export interface RepositoryLegObservation {
  readonly repoId: string;
  readonly commitsAhead: number;
  readonly tcrCount: number;
  readonly worktreeDirty: boolean;
}

export interface RepositoryObservationSummary {
  readonly legs: readonly RepositoryLegObservation[];
  readonly commitsAhead: number;
  readonly tcrCount: number;
  readonly worktreeDirty: boolean;
}

export function writableRepositoryIds(ctx: CycleContext): readonly string[] {
  const execution = ctx.repositoryExecution;
  if (execution === undefined) throw new Error("missing_repository_context");
  const ids = Object.entries(execution.repositories)
    .filter(([, repository]) => repository.access === "write")
    .map(([repoId]) => repoId)
    .sort((left, right) => left.localeCompare(right));
  if (ids.length === 0) throw new Error("invalid_repository_map: at least one writable repository is required");
  return ids;
}

async function observe<T>(
  repoId: string,
  operation: RepositoryObservationOperation,
  probe: () => Promise<T>,
): Promise<T> {
  try {
    return await probe();
  } catch (error) {
    throw new RepositoryObservationError(repoId, operation, { cause: error });
  }
}

export async function observeWritableRepositories(
  ctx: CycleContext,
  repositories: BoundRepositoryPorts,
): Promise<RepositoryObservationSummary> {
  const legs: RepositoryLegObservation[] = [];
  for (const repoId of writableRepositoryIds(ctx)) {
    const commitsAhead = await observe(repoId, "commits_ahead", () => repositories.git.commitsAhead(repoId));
    const tcrCount = await observe(repoId, "tcr_count", () => repositories.git.tcrCount(repoId));
    const worktreeDirty = await observe(repoId, "dirty", () => repositories.git.dirty(repoId));
    legs.push({ repoId, commitsAhead, tcrCount, worktreeDirty });
  }
  return {
    legs,
    commitsAhead: legs.reduce((sum, leg) => sum + leg.commitsAhead, 0),
    tcrCount: legs.reduce((sum, leg) => sum + leg.tcrCount, 0),
    worktreeDirty: legs.some((leg) => leg.worktreeDirty),
  };
}

export async function observeWritableRepositoryCommitCount(
  ctx: CycleContext,
  repositories: BoundRepositoryPorts,
): Promise<number> {
  let total = 0;
  for (const repoId of writableRepositoryIds(ctx)) {
    total += await observe(repoId, "commits_ahead", () => repositories.git.commitsAhead(repoId));
  }
  return total;
}

export function observeRepositoryRecentCommits(
  repoId: string,
  repositories: BoundRepositoryPorts,
): Promise<ObservedCommit[]> {
  return observe(repoId, "recent_commits", () => repositories.git.recentCommits(repoId));
}
