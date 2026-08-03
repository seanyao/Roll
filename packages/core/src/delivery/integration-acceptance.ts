import {
  integrationAcceptanceCommandDigest,
  isImmutableGitObjectId,
  isSafeGitRef,
  isSafeIssueEvidencePath,
  type IssueIntegrationAcceptanceEvidence,
} from "@roll/spec";

export interface IntegrationAcceptanceRepository {
  readonly repoId: string;
  readonly repositoryPath: string;
  readonly integrationBranch: string;
  readonly authority?: "provider" | "integration_branch" | "projection";
  readonly status: "none" | "building" | "awaiting_merge" | "merged" | "blocked" | "abandoned";
  readonly mergeCommit?: string;
}

export interface IntegrationAcceptanceInput {
  readonly workspaceId: string;
  readonly storyId: string;
  readonly repositories: readonly IntegrationAcceptanceRepository[];
  readonly command: readonly string[];
  readonly profile: string;
  readonly artifactPath: string;
  readonly recordedAt: number;
}

export interface IntegrationAcceptanceReachabilityInput {
  readonly repoId: string;
  readonly repositoryPath: string;
  readonly integrationBranch: string;
  readonly mergeCommit: string;
}

export interface IntegrationAcceptanceExecutionInput {
  readonly command: readonly string[];
  readonly commandDigest: string;
  readonly profile: string;
  readonly inputMergeCommits: Readonly<Record<string, string>>;
  readonly artifactPath: string;
}

export interface IntegrationAcceptancePorts {
  readonly isReachable: (input: IntegrationAcceptanceReachabilityInput) => Promise<boolean | undefined>;
  readonly execute: (input: IntegrationAcceptanceExecutionInput) => Promise<{
    readonly exitCode: number;
    readonly artifactPath: string;
  }>;
}

export type IntegrationAcceptanceResult =
  | { readonly status: "pending"; readonly message: string }
  | { readonly status: "blocked"; readonly message: string }
  | {
      readonly status: "recorded";
      readonly evidence: IssueIntegrationAcceptanceEvidence;
      readonly message: string;
    };

export class IntegrationAcceptanceError extends Error {}

function safeLabel(value: string): boolean {
  return value !== "" && value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value);
}

function validateInput(input: IntegrationAcceptanceInput): void {
  if (!safeLabel(input.workspaceId) || !safeLabel(input.storyId)) {
    throw new IntegrationAcceptanceError("integration acceptance identity is invalid");
  }
  if (input.repositories.length === 0) {
    throw new IntegrationAcceptanceError("integration acceptance requires at least one repository");
  }
  if (input.command.length === 0 || input.command.some((argument) => !safeLabel(argument))) {
    throw new IntegrationAcceptanceError("integration acceptance command is invalid");
  }
  if (!safeLabel(input.profile)) throw new IntegrationAcceptanceError("integration acceptance profile is invalid");
  if (!isSafeIssueEvidencePath(input.artifactPath)) {
    throw new IntegrationAcceptanceError("integration acceptance artifact path must remain under evidence/");
  }
  if (!Number.isFinite(input.recordedAt)) {
    throw new IntegrationAcceptanceError("integration acceptance recordedAt must be finite");
  }
  const repoIds = new Set<string>();
  for (const repository of input.repositories) {
    if (!/^[a-z][a-z0-9-]*$/u.test(repository.repoId) || !isSafeGitRef(repository.integrationBranch)) {
      throw new IntegrationAcceptanceError("integration acceptance repository identity is invalid");
    }
    if (repoIds.has(repository.repoId)) {
      throw new IntegrationAcceptanceError(`integration acceptance repeats repoId ${repository.repoId}`);
    }
    repoIds.add(repository.repoId);
  }
}

function exactMergeMap(repositories: readonly IntegrationAcceptanceRepository[]): Readonly<Record<string, string>> {
  return Object.fromEntries(
    repositories
      .map((repository) => [repository.repoId, repository.mergeCommit!] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
}

function evidence(
  input: IntegrationAcceptanceInput,
  inputMergeCommits: Readonly<Record<string, string>>,
  verdict: "pass" | "fail",
): IssueIntegrationAcceptanceEvidence {
  return {
    workspaceId: input.workspaceId,
    storyId: input.storyId,
    inputMergeCommits,
    commandDigest: integrationAcceptanceCommandDigest(input.command),
    profile: input.profile,
    verdict,
    artifactPath: input.artifactPath,
    recordedAt: input.recordedAt,
  };
}

export async function runIntegrationAcceptance(
  input: IntegrationAcceptanceInput,
  ports: IntegrationAcceptancePorts,
): Promise<IntegrationAcceptanceResult> {
  validateInput(input);
  for (const repository of input.repositories) {
    const strong = repository.authority === "provider" || repository.authority === "integration_branch";
    if (repository.status !== "merged" || !strong || repository.mergeCommit === undefined ||
      !isImmutableGitObjectId(repository.mergeCommit)) {
      return {
        status: "pending",
        message: `integration acceptance pending: ${repository.repoId} has no strongly proven merge commit`,
      };
    }
  }

  const inputMergeCommits = exactMergeMap(input.repositories);
  for (const repository of input.repositories) {
    const mergeCommit = repository.mergeCommit!;
    const reachable = await ports.isReachable({
      repoId: repository.repoId,
      repositoryPath: repository.repositoryPath,
      integrationBranch: repository.integrationBranch,
      mergeCommit,
    });
    if (reachable !== true) {
      return {
        status: "blocked",
        message: `integration acceptance blocked: ${repository.repoId}@${mergeCommit} is not reachable from integration branch ${repository.integrationBranch}`,
      };
    }
  }

  const accepted = evidence(input, inputMergeCommits, "pass");
  const execution = await ports.execute({
    command: input.command,
    commandDigest: accepted.commandDigest,
    profile: input.profile,
    inputMergeCommits,
    artifactPath: input.artifactPath,
  });
  if (execution.artifactPath !== input.artifactPath || !isSafeIssueEvidencePath(execution.artifactPath)) {
    throw new IntegrationAcceptanceError("integration acceptance command returned an invalid artifact identity");
  }
  const verdict = execution.exitCode === 0 ? "pass" : "fail";
  return {
    status: "recorded",
    evidence: verdict === "pass" ? accepted : evidence(input, inputMergeCommits, "fail"),
    message: verdict === "pass"
      ? "integration acceptance passed"
      : `integration acceptance command failed with exit code ${execution.exitCode}`,
  };
}
