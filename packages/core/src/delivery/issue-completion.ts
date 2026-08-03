import {
  isImmutableGitObjectId,
  type IssueCompletionConflict,
  type IssueCompletionProjection,
  type IssueIntegrationAcceptanceEvidence,
  type IssueRepositoryCompletion,
  type RepositoryMergeEvidence,
} from "@roll/spec";

export interface IssueCompletionRepositoryTarget {
  readonly repoId: string;
  readonly required: boolean;
}

export interface IssueCompletionInput {
  readonly workspaceId: string;
  readonly storyId: string;
  readonly repositories: readonly IssueCompletionRepositoryTarget[];
  readonly repositoryFacts: readonly RepositoryMergeEvidence[];
  readonly integrationAcceptances: readonly IssueIntegrationAcceptanceEvidence[];
  /** Weak generated projection only. It can diagnose drift but never deliver. */
  readonly backlogDone: boolean;
}

interface RepositoryResolution {
  readonly completion: IssueRepositoryCompletion;
  readonly conflicts: readonly IssueCompletionConflict[];
}

function latest<T extends { readonly recordedAt: number }>(items: readonly T[]): T | undefined {
  return [...items].sort((left, right) => left.recordedAt - right.recordedAt).at(-1);
}

function unique<T>(items: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function conflict(repoId: string, code: IssueCompletionConflict["code"]): IssueCompletionConflict {
  return { repoId, code };
}

function resolveRepository(repoId: string, facts: readonly RepositoryMergeEvidence[]): RepositoryResolution {
  const scoped = unique(facts.filter((fact) => fact.repoId === repoId));
  const providers = scoped.filter((fact) => fact.authority === "provider");
  const branches = scoped.filter((fact) => fact.authority === "integration_branch");
  const projections = scoped.filter((fact) => fact.authority === "projection");
  const provider = latest(providers.filter((fact) => fact.prState !== "UNKNOWN")) ?? latest(providers);
  const branch = latest(branches);
  const projection = latest(projections);
  const conflicts: IssueCompletionConflict[] = [];

  const providerMerges = providers.filter((fact) => fact.prState === "MERGED");
  const mergeCommits = new Set(providerMerges.map((fact) => fact.mergeCommit).filter((sha): sha is string => sha !== undefined && sha !== ""));
  if (providerMerges.some((fact) => fact.mergeCommit === undefined || !isImmutableGitObjectId(fact.mergeCommit))) {
    conflicts.push(conflict(repoId, "invalid_merge_evidence"));
  }
  if (mergeCommits.size > 1) conflicts.push(conflict(repoId, "conflicting_merge_commit"));
  const reachableBranches = branches.filter((fact) => fact.reachable);
  const branchMergeCommits = new Set(reachableBranches.map((fact) => fact.mergeCommit).filter((sha): sha is string => sha !== undefined && sha !== ""));
  if (reachableBranches.some((fact) => fact.mergeCommit === undefined || !isImmutableGitObjectId(fact.mergeCommit))) {
    conflicts.push(conflict(repoId, "invalid_merge_evidence"));
  }
  if (branchMergeCommits.size > 1) conflicts.push(conflict(repoId, "conflicting_merge_commit"));
  if (branch?.reachable === false && reachableBranches.some((fact) => fact.recordedAt <= branch.recordedAt)) {
    conflicts.push(conflict(repoId, "strong_fact_conflict"));
  }
  if (provider?.prState !== "MERGED" && providerMerges.some((fact) => fact.recordedAt <= (provider?.recordedAt ?? 0))) {
    conflicts.push(conflict(repoId, "strong_fact_conflict"));
  }
  if (provider !== undefined && provider.prState !== "UNKNOWN" && branch?.reachable === true) {
    if (provider.prState !== "MERGED" || (provider.mergeCommit !== undefined && provider.mergeCommit !== branch.mergeCommit)) {
      conflicts.push(conflict(repoId, "strong_fact_conflict"));
    }
  }
  if (conflicts.length > 0) {
    return { completion: { repoId, status: "blocked", ...(provider === undefined ? {} : { authority: "provider" }) }, conflicts };
  }

  if (provider !== undefined && provider.prState !== "UNKNOWN") {
    if (provider.prState === "MERGED" && provider.mergeCommit !== undefined) {
      return { completion: { repoId, status: "merged", authority: "provider", mergeCommit: provider.mergeCommit }, conflicts };
    }
    if (provider.prState === "CLOSED") return { completion: { repoId, status: "abandoned", authority: "provider" }, conflicts };
    if (provider.ci === "red") return { completion: { repoId, status: "blocked", authority: "provider" }, conflicts };
    return { completion: { repoId, status: "awaiting_merge", authority: "provider" }, conflicts };
  }
  if (branch?.reachable === true && branch.mergeCommit !== undefined && branch.mergeCommit !== "") {
    return { completion: { repoId, status: "merged", authority: "integration_branch", mergeCommit: branch.mergeCommit }, conflicts };
  }
  if (projection !== undefined) {
    const status = projection.state === "merged"
      ? "merged"
      : projection.state === "awaiting_merge"
        ? "awaiting_merge"
        : projection.state;
    return {
      completion: {
        repoId,
        status,
        authority: "projection",
        ...(projection.mergeCommit === undefined ? {} : { mergeCommit: projection.mergeCommit }),
      },
      conflicts,
    };
  }
  return { completion: { repoId, status: "none" }, conflicts };
}

function exactMap(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export function deriveIssueCompletion(input: IssueCompletionInput): IssueCompletionProjection {
  const required = input.repositories.filter((repository) => repository.required);
  const resolutions = required.map((target) => resolveRepository(
    target.repoId,
    input.repositoryFacts.filter((fact) => fact.workspaceId === input.workspaceId && fact.storyId === input.storyId),
  ));
  const repositories = resolutions.map((resolution) => resolution.completion);
  const conflicts = resolutions.flatMap((resolution) => resolution.conflicts);
  const mergeCommits = Object.fromEntries(repositories.flatMap((repository) =>
    repository.status === "merged" && repository.mergeCommit !== undefined
      ? [[repository.repoId, repository.mergeCommit] as const]
      : []
  ));

  let state: IssueCompletionProjection["state"];
  const mergedCount = repositories.filter((repository) => repository.status === "merged").length;
  if (conflicts.length > 0) {
    state = "blocked";
  } else if (mergedCount > 0 && mergedCount < repositories.length) {
    state = "partial_delivery";
  } else if (repositories.length > 0 && mergedCount === repositories.length) {
    const allStrong = repositories.every((repository) =>
      repository.authority === "provider" || repository.authority === "integration_branch"
    );
    if (!allStrong) {
      state = "integration_pending";
    } else {
      const acceptance = latest(input.integrationAcceptances.filter((item) =>
        item.workspaceId === input.workspaceId && item.storyId === input.storyId
      ));
      if (acceptance === undefined) state = "integration_pending";
      else if (acceptance.verdict !== "pass" || !exactMap(acceptance.inputMergeCommits, mergeCommits)) state = "blocked";
      else state = "delivered";
    }
  } else if (repositories.some((repository) => repository.status === "abandoned")) {
    state = "abandoned";
  } else if (repositories.some((repository) => repository.status === "blocked")) {
    state = "blocked";
  } else if (repositories.length > 0 && repositories.every((repository) => repository.status === "awaiting_merge")) {
    state = "awaiting_repo_merges";
  } else if (repositories.some((repository) => repository.status !== "none")) {
    state = "building";
  } else {
    state = "planned";
  }

  return { workspaceId: input.workspaceId, storyId: input.storyId, state, repositories, mergeCommits, conflicts };
}
