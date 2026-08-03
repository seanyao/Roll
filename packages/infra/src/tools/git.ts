import type { GitResult } from "../git.js";
import { rawGit } from "../git.js";
import type { ToolDeclaration, ToolDeps, ToolInvocation, ToolMeta, ToolResult } from "@roll/spec";
import { gitCommandOutputSchema, gitCommitInputSchema, gitMergeInputSchema, gitPushInputSchema, gitStatusInputSchema, gitStatusOutputSchema } from "./schema-contracts.js";
import { canonicalExistingPath, resolveWorkspaceLocalRepository } from "./workspace-local-context.js";

export type GitToolId = "git.commit" | "git.status" | "git.push" | "git.merge";

export interface GitCommitInput {
  cwd: string;
  message: string;
  allowEmpty?: boolean;
}

export interface GitPushInput {
  cwd: string;
  branch: string;
  remote?: string;
  setUpstream?: boolean;
}

export interface GitStatusInput {
  cwd: string;
}

export interface GitMergeInput {
  cwd: string;
  ref: string;
  ffOnly?: boolean;
  noCommit?: boolean;
}

export interface GitCommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitStatusOutput extends GitCommandOutput {
  clean: boolean;
}

type GitInput = GitCommitInput | GitPushInput | GitStatusInput | GitMergeInput;
type GitOutput = GitCommandOutput | GitStatusOutput;

const TITLES: Record<GitToolId, string> = {
  "git.commit": "Git Commit",
  "git.status": "Git Status",
  "git.push": "Git Push",
  "git.merge": "Git Merge",
};

export class GitTool {
  readonly declaration: ToolDeclaration;

  constructor(private readonly id: GitToolId) {
    this.declaration = {
      id: id as ToolDeclaration["id"],
      kind: "git",
      title: TITLES[id],
      description: "Run governed git operations through the Tool interface.",
      emitsEvents: id === "git.status" ? false : true,
      defaults: {
        enabled: true,
        timeoutMs: 60_000,
      },
      requirements: [{ kind: "executable", name: "git", optional: false }],
      inputSchema: gitInputSchema(id),
      outputSchema: id === "git.status" ? gitStatusOutputSchema : gitCommandOutputSchema,
    };
  }

  async init(_deps: ToolDeps): Promise<void> {
    return undefined;
  }

  async dispose(_deps: ToolDeps): Promise<void> {
    return undefined;
  }

  async execute(invocation: ToolInvocation<GitInput>, deps: ToolDeps): Promise<ToolResult<GitOutput>> {
    const startedAt = deps.now();
    const access = this.id === "git.status" ? "read" : "write";
    const repository = resolveWorkspaceLocalRepository(invocation, access);
    if (!repository.ok) return contextFailure(invocation, startedAt, deps.now(), repository.code, repository.message);
    const boundInvocation = invocation.repoId === undefined
      ? { ...invocation, repoId: repository.repository.repoId }
      : invocation;
    const cwd = canonicalExistingPath(invocation.input.cwd);
    if (cwd === undefined || cwd !== repository.canonicalWorktreePath) {
      return contextFailure(boundInvocation, startedAt, deps.now(), "invalid_execution_context", "git cwd does not match the selected Issue repository");
    }
    try {
      if (this.id === "git.commit") {
        const input = invocation.input as GitCommitInput;
        const args = ["commit", "-m", deps.redact(input.message)];
        if (input.allowEmpty === true) args.splice(1, 0, "--allow-empty");
        return ok(boundInvocation, startedAt, deps.now(), await rawGit(args, cwd));
      }
      if (this.id === "git.status") {
        const result = await rawGit(["status", "--short"], cwd);
        return {
          ok: true,
          output: { ...toOutput(result), clean: result.code === 0 && result.stdout.trim() === "" },
          meta: meta(boundInvocation, startedAt, deps.now()),
        };
      }
      if (this.id === "git.push") {
        const input = invocation.input as GitPushInput;
        const remote = input.remote ?? "origin";
        const args = input.setUpstream === true ? ["push", "-u", remote, input.branch] : ["push", remote, input.branch];
        return ok(boundInvocation, startedAt, deps.now(), await rawGit(args, cwd));
      }
      const input = invocation.input as GitMergeInput;
      const args = ["merge", ...(input.ffOnly === true ? ["--ff-only"] : []), ...(input.noCommit === true ? ["--no-commit"] : []), input.ref];
      return ok(boundInvocation, startedAt, deps.now(), await rawGit(args, cwd));
    } catch {
      return {
        ok: false,
        error: {
          code: "adapter_error",
          message: "git execution failed",
          retryable: true,
        },
        meta: meta(boundInvocation, startedAt, deps.now()),
      };
    }
  }
}

function gitInputSchema(id: GitToolId): ToolDeclaration["inputSchema"] {
  if (id === "git.commit") return gitCommitInputSchema;
  if (id === "git.status") return gitStatusInputSchema;
  if (id === "git.push") return gitPushInputSchema;
  return gitMergeInputSchema;
}

export function gitTools(): GitTool[] {
  return [new GitTool("git.commit"), new GitTool("git.status"), new GitTool("git.push"), new GitTool("git.merge")];
}

function ok(invocation: ToolInvocation<GitInput>, startedAt: number, endedAt: number, result: GitResult): ToolResult<GitCommandOutput> {
  return {
    ok: true,
    output: toOutput(result),
    meta: meta(invocation, startedAt, endedAt),
  };
}

function toOutput(result: GitResult): GitCommandOutput {
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function meta(invocation: ToolInvocation<GitInput>, startedAt: number, endedAt: number): ToolMeta {
  return {
    invocationId: invocation.invocationId,
    toolId: invocation.toolId,
    caller: invocation.caller,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    correlation: invocation.context === undefined
      ? undefined
      : {
          workspaceId: invocation.context.workspace.workspaceId,
          ...(invocation.context.issue?.storyId === undefined ? {} : { storyId: invocation.context.issue.storyId }),
          ...(invocation.repoId === undefined ? {} : { repoId: invocation.repoId }),
        },
  };
}

function contextFailure(
  invocation: ToolInvocation<GitInput>,
  startedAt: number,
  endedAt: number,
  code: "missing_execution_context" | "invalid_execution_context",
  message: string,
): ToolResult<never> {
  return {
    ok: false,
    error: { code, message, retryable: false },
    meta: meta(invocation, startedAt, endedAt),
  };
}
