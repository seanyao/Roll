/**
 * @responsibility Declares and runs the git tool adapter.
 */
import type { GitResult } from "../git.js";
import { rawGit } from "../git.js";
import type { ToolDeclaration, ToolDeps, ToolInvocation, ToolMeta, ToolResult } from "@roll/spec";
import { gitCommandOutputSchema, gitCommitInputSchema, gitMergeInputSchema, gitPushInputSchema, gitStatusInputSchema, gitStatusOutputSchema } from "./schema-contracts.js";

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
    try {
      if (this.id === "git.commit") {
        const input = invocation.input as GitCommitInput;
        const args = ["commit", "-m", deps.redact(input.message)];
        if (input.allowEmpty === true) args.splice(1, 0, "--allow-empty");
        return ok(invocation, startedAt, deps.now(), await rawGit(args, input.cwd));
      }
      if (this.id === "git.status") {
        const input = invocation.input as GitStatusInput;
        const result = await rawGit(["status", "--short"], input.cwd);
        return {
          ok: true,
          output: { ...toOutput(result), clean: result.code === 0 && result.stdout.trim() === "" },
          meta: meta(invocation, startedAt, deps.now()),
        };
      }
      if (this.id === "git.push") {
        const input = invocation.input as GitPushInput;
        const remote = input.remote ?? "origin";
        const args = input.setUpstream === true ? ["push", "-u", remote, input.branch] : ["push", remote, input.branch];
        return ok(invocation, startedAt, deps.now(), await rawGit(args, input.cwd));
      }
      const input = invocation.input as GitMergeInput;
      const args = ["merge", ...(input.ffOnly === true ? ["--ff-only"] : []), ...(input.noCommit === true ? ["--no-commit"] : []), input.ref];
      return ok(invocation, startedAt, deps.now(), await rawGit(args, input.cwd));
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "adapter_error",
          message: "git execution failed",
          retryable: true,
          detail: cause,
        },
        meta: meta(invocation, startedAt, deps.now()),
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
  };
}
