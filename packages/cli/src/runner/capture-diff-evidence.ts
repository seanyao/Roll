import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveIntegrationBranch } from "@roll/infra";
import type { CycleRepositoryExecutionContext } from "@roll/spec";
import type { DraftEvidence } from "./attest-remediation.js";

const execFileAsync = promisify(execFile);

function writableRepositories(execution: CycleRepositoryExecutionContext) {
  return Object.values(execution.repositories)
    .filter((repository) => repository.access === "write")
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

export interface WorkspaceDiffEvidence {
  readonly diff: string;
  readonly changedFiles: readonly string[];
  readonly diffStat: string;
}

/** Collect reviewer input from every writable repository leg. Omitting one
 * unreadable leg would let a scorer judge only a convenient subset. */
export async function collectWorkspaceDiffEvidence(
  execution: CycleRepositoryExecutionContext,
): Promise<WorkspaceDiffEvidence> {
  const diffSections: string[] = [];
  const changedFiles: string[] = [];
  const statSections: string[] = [];
  for (const repository of writableRepositories(execution)) {
    try {
      const [diff, files, stat] = await Promise.all([
        execFileAsync("git", ["diff", `${repository.baseSha}...HEAD`], {
          cwd: repository.worktreePath,
          encoding: "utf8",
          timeout: 15_000,
        }),
        execFileAsync("git", ["diff", "--name-only", `${repository.baseSha}...HEAD`], {
          cwd: repository.worktreePath,
          encoding: "utf8",
          timeout: 15_000,
        }),
        execFileAsync("git", ["diff", "--stat", `${repository.baseSha}...HEAD`], {
          cwd: repository.worktreePath,
          encoding: "utf8",
          timeout: 15_000,
        }),
      ]);
      if (diff.stdout.trim() !== "") diffSections.push(`Repository: ${repository.alias}\n${diff.stdout}`);
      changedFiles.push(...files.stdout.split("\n")
        .map((path) => path.trim())
        .filter((path) => path !== "")
        .map((path) => `${repository.alias}/${path}`));
      if (stat.stdout.trim() !== "") statSections.push(`Repository: ${repository.alias}\n${stat.stdout}`);
    } catch {
      throw new Error(`workspace_diff_unavailable:${repository.alias}`);
    }
  }
  return {
    diff: diffSections.join("\n").slice(0, 60_000),
    changedFiles,
    diffStat: statSections.join("\n").slice(0, 4_000),
  };
}

export async function collectDraftEvidence(worktreeCwd: string, repoCwd: string): Promise<DraftEvidence> {
  const empty: DraftEvidence = { commitLines: [], diffStatLines: [], changedFilenames: [] };
  const base = resolveIntegrationBranch(repoCwd);
  try {
    const [commits, diffStat, changedFiles] = await Promise.all([
      execFileAsync("git", ["log", "--oneline", `${base}..HEAD`, "-n", "50"], {
        cwd: worktreeCwd,
        encoding: "utf8",
        timeout: 15_000,
      }).then((result) => result.stdout.trim().split("\n").filter((line) => line !== ""), () => [] as string[]),
      execFileAsync("git", ["diff", "--stat", `${base}...HEAD`], {
        cwd: worktreeCwd,
        encoding: "utf8",
        timeout: 15_000,
      }).then((result) => result.stdout.trim().split("\n").filter((line) => line !== ""), () => [] as string[]),
      execFileAsync("git", ["diff", "--name-only", `${base}...HEAD`], {
        cwd: worktreeCwd,
        encoding: "utf8",
        timeout: 15_000,
      }).then((result) => result.stdout.trim().split("\n").filter((line) => line !== ""), () => [] as string[]),
    ]);
    return { commitLines: commits, diffStatLines: diffStat, changedFilenames: changedFiles };
  } catch {
    return empty;
  }
}
