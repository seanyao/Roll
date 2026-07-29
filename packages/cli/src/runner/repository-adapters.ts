import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ToolRegistry, type CycleContext, type ObservedCommit, type Tool } from "@roll/core";
import {
  BashTool, GitTool, canonicalExistingPath, ghRepoSlug, infraToolExecFile, infraToolFs, prViewMergeInfo,
  prViewState, push as gitPush, redactInfraToolValue, remoteUrl,
  resolveWorkspaceLocalRepository,
  type BashInput, type BashOutput, type GitCommandOutput, type GitPushInput,
  type GitStatusInput, type GitStatusOutput,
} from "@roll/infra";
import type {
  CycleRepositoryExecutionContext, RepositoryExecutionContext, ToolDeclaration, ToolDeps,
  ToolEvent, ToolInvocation, ToolMeta, ToolResult,
} from "@roll/spec";
import type { RepositoryPortAdapters } from "./ports.js";
import { buildRepositoryWorkspaceExecutionContext } from "./repository-context.js";
import { createWorkspaceToolInvocationFactory } from "./tool-context-invocation.js";

const execFileAsync = promisify(execFile);

async function repositoryCommitsAhead(repository: RepositoryExecutionContext): Promise<number> {
  const result = await execFileAsync("git", ["rev-list", "--count", `${repository.baseSha}..HEAD`], {
    cwd: repository.worktreePath, encoding: "utf8",
  });
  const count = Number(result.stdout.trim());
  if (!Number.isInteger(count) || count < 0) throw new Error("invalid commits-ahead result");
  return count;
}

async function repositoryTcrCount(repository: RepositoryExecutionContext): Promise<number> {
  const result = await execFileAsync("git", ["log", "--oneline", `${repository.baseSha}..HEAD`], {
    cwd: repository.worktreePath, encoding: "utf8",
  });
  return result.stdout.split("\n").filter((line) => line.includes(" tcr:")).length;
}

async function repositoryRecentCommits(repository: RepositoryExecutionContext): Promise<ObservedCommit[]> {
  const result = await execFileAsync("git", ["log", "--reverse", "--format=%H%x09%ct%x09%s", `${repository.baseSha}..HEAD`], {
    cwd: repository.worktreePath, encoding: "utf8",
  });
  return result.stdout.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    const [hash, rawTs, ...message] = line.split("\t");
    if (hash === undefined || hash === "") throw new Error("invalid recent-commit result");
    const tsSec = Number(rawTs ?? "0");
    if (!Number.isFinite(tsSec)) throw new Error("invalid recent-commit timestamp");
    return [{ hash, message: message.join("\t"), tsSec }];
  });
}

async function repositoryDirty(repository: RepositoryExecutionContext): Promise<boolean> {
  const result = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repository.worktreePath, encoding: "utf8",
  });
  return result.stdout.trim() !== "";
}

export async function repositoryHeadSha(repository: RepositoryExecutionContext): Promise<string> {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository.worktreePath, encoding: "utf8" });
  const head = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(head)) throw new Error("invalid repository head");
  return head;
}

function commandFailure(error: unknown): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record["code"] !== "number") return undefined;
  return {
    exitCode: record["code"],
    stdout: typeof record["stdout"] === "string" ? record["stdout"] : "",
    stderr: typeof record["stderr"] === "string" ? record["stderr"] : "",
  };
}

async function runRepositoryCommand(cwd: string, command: readonly string[], env: Readonly<Record<string, string>>) {
  const [executable, ...args] = command;
  if (executable === undefined || executable.trim() === "") throw new Error("empty_repository_verification_command");
  try {
    const result = await execFileAsync(executable, args, {
      cwd, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = commandFailure(error);
    if (failure !== undefined) return failure;
    throw error;
  }
}

interface RepositoryToolRuntime {
  commitsAhead(repository: RepositoryExecutionContext): Promise<number>;
  tcrCount(repository: RepositoryExecutionContext): Promise<number>;
  recentCommits(repository: RepositoryExecutionContext): Promise<ObservedCommit[]>;
  dirty(repository: RepositoryExecutionContext): Promise<boolean>;
  headSha(repository: RepositoryExecutionContext): Promise<string>;
  push(repository: RepositoryExecutionContext, branch: string): Promise<{ code: number }>;
  runRepository(repository: RepositoryExecutionContext, command: readonly string[], env: Readonly<Record<string, string>>): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  runIntegration(execution: CycleRepositoryExecutionContext, cwdRepoId: string, command: readonly string[], env: Readonly<Record<string, string>>): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

type GitQueryOperation = "commits_ahead" | "tcr_count" | "recent_commits" | "head_sha";
interface GitQueryInput { cwd: string; operation: GitQueryOperation; baseSha?: string }
interface GitQueryOutput { exitCode: number; stdout: string; stderr: string }

class RepositoryGitQueryTool implements Tool<GitQueryInput, GitQueryOutput> {
  readonly declaration: ToolDeclaration = {
    id: "runner.git.query" as ToolDeclaration["id"],
    kind: "git",
    title: "Runner Git Query",
    description: "Run fixed read-only repository observations in a bound Workspace context.",
    defaults: { enabled: true, timeoutMs: 30_000 },
    requirements: [{ kind: "executable", name: "git", optional: false }],
  };

  async init(): Promise<void> { return undefined; }
  async dispose(): Promise<void> { return undefined; }

  async execute(invocation: ToolInvocation<GitQueryInput>, deps: ToolDeps): Promise<ToolResult<GitQueryOutput>> {
    const startedAt = deps.now();
    const repository = resolveWorkspaceLocalRepository(invocation, "read");
    if (!repository.ok) return queryFailure(invocation, startedAt, deps.now(), repository.code, repository.message);
    const cwd = canonicalExistingPath(invocation.input.cwd);
    if (cwd === undefined || cwd !== repository.canonicalWorktreePath) {
      return queryFailure(invocation, startedAt, deps.now(), "invalid_execution_context", "git query cwd does not match the selected Issue repository");
    }
    const args = gitQueryArgs(invocation.input);
    if (args === undefined) return queryFailure(invocation, startedAt, deps.now(), "invalid_input", "git query input is invalid");
    try {
      const output = await deps.execFile("git", args, { cwd, timeoutMs: invocation.policy.timeoutMs });
      return {
        ok: true,
        output: { exitCode: output.exitCode, stdout: output.stdout, stderr: output.stderr },
        meta: queryMeta(invocation, startedAt, deps.now()),
      };
    } catch {
      return queryFailure(invocation, startedAt, deps.now(), "adapter_error", "git query execution failed", true);
    }
  }
}

function gitQueryArgs(input: GitQueryInput): string[] | undefined {
  if (input.operation === "head_sha") return ["rev-parse", "HEAD"];
  if (input.baseSha === undefined || !/^[0-9a-f]{40,64}$/u.test(input.baseSha)) return undefined;
  const range = `${input.baseSha}..HEAD`;
  if (input.operation === "commits_ahead") return ["rev-list", "--count", range];
  if (input.operation === "tcr_count") return ["log", "--oneline", range];
  return ["log", "--reverse", "--format=%H%x09%ct%x09%s", range];
}

function queryMeta(invocation: ToolInvocation<GitQueryInput>, startedAt: number, endedAt: number): ToolMeta {
  return {
    invocationId: invocation.invocationId, toolId: invocation.toolId, caller: invocation.caller,
    startedAt, endedAt, durationMs: Math.max(0, endedAt - startedAt),
  };
}

function queryFailure(
  invocation: ToolInvocation<GitQueryInput>, startedAt: number, endedAt: number,
  code: "missing_execution_context" | "invalid_execution_context" | "invalid_input" | "adapter_error",
  message: string, retryable = false,
): ToolResult<never> {
  return { ok: false, error: { code, message, retryable }, meta: queryMeta(invocation, startedAt, endedAt) };
}

function createRepositoryToolRuntime(ctx: CycleContext): RepositoryToolRuntime {
  const execution = ctx.repositoryExecution;
  const storyId = ctx.storyId;
  if (execution === undefined || storyId === undefined || storyId === "") throw new Error("missing_repository_context");
  const workspaceRoot = dirname(dirname(execution.issueRoot));
  const requests = createWorkspaceToolInvocationFactory({
    cycleId: ctx.cycleId, storyId,
    workspace: buildRepositoryWorkspaceExecutionContext(workspaceRoot, storyId, execution),
    ...(ctx.agent === undefined ? {} : { agent: ctx.agent }),
  });
  const deps: ToolDeps = { fs: infraToolFs, execFile: infraToolExecFile, now: () => Date.now(), redact: redactInfraToolValue };
  const registry = new ToolRegistry({
    deps,
    policyEngine: {
      resolve(_toolId, defaults) {
        return {
          enabled: defaults?.enabled ?? true,
          ...(defaults?.timeoutMs === undefined ? {} : { timeoutMs: defaults.timeoutMs }),
          ...(defaults?.retry === undefined ? {} : { retry: defaults.retry }),
          ...(defaults?.sandbox === undefined ? {} : { sandbox: defaults.sandbox }),
          ...(defaults?.maxInvocationsPerCycle === undefined ? {} : { maxInvocationsPerCycle: defaults.maxInvocationsPerCycle }),
        };
      },
    },
    events: {
      emit(event: ToolEvent) {
        mkdirSync(requests.context.authorities.events, { recursive: true });
        appendFileSync(join(requests.context.authorities.events, "tools.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
      },
    },
  });
  registry.register(new BashTool());
  registry.register(new GitTool("git.status"));
  registry.register(new GitTool("git.push"));
  registry.register(new RepositoryGitQueryTool());
  let invocation = 0;
  const invocationId = (toolId: string): string => `${ctx.cycleId}:${toolId}:${++invocation}`;
  const runRepository = async (repository: RepositoryExecutionContext, command: readonly string[], env: Readonly<Record<string, string>>) => {
    const [executable, ...args] = command;
    if (executable === undefined || executable.trim() === "") throw new Error("empty_repository_verification_command");
    const result = await registry.invoke<BashInput, BashOutput>("bash", requests.request({
      invocationId: invocationId("bash"), repoId: repository.repoId,
      input: { command: executable, args, cwd: repository.worktreePath, env: { ...env } },
    }));
    if (!result.ok) throw new Error(`repository_tool_failed: ${result.error.code}`);
    return { exitCode: result.output.exitCode, stdout: result.output.stdout, stderr: result.output.stderr };
  };
  const query = async (repository: RepositoryExecutionContext, operation: GitQueryOperation): Promise<GitQueryOutput> => {
    const result = await registry.invoke<GitQueryInput, GitQueryOutput>("runner.git.query", requests.request({
      invocationId: invocationId("runner.git.query"), repoId: repository.repoId,
      input: { cwd: repository.worktreePath, operation, ...(operation === "head_sha" ? {} : { baseSha: repository.baseSha }) },
    }));
    if (!result.ok) throw new Error(`repository_tool_failed: ${result.error.code}`);
    if (result.output.exitCode !== 0) throw new Error(`repository_git_query_failed: ${operation}`);
    return result.output;
  };
  return {
    async commitsAhead(repository) {
      const count = Number((await query(repository, "commits_ahead")).stdout.trim());
      if (!Number.isInteger(count) || count < 0) throw new Error("invalid commits-ahead result");
      return count;
    },
    async tcrCount(repository) {
      return (await query(repository, "tcr_count")).stdout.split("\n").filter((line) => line.includes(" tcr:")).length;
    },
    async recentCommits(repository) {
      return parseRecentCommits((await query(repository, "recent_commits")).stdout);
    },
    async dirty(repository) {
      const result = await registry.invoke<GitStatusInput, GitStatusOutput>("git.status", requests.request({
        invocationId: invocationId("git.status"), repoId: repository.repoId, input: { cwd: repository.worktreePath },
      }));
      if (!result.ok) throw new Error(`repository_tool_failed: ${result.error.code}`);
      return !result.output.clean;
    },
    async headSha(repository) {
      const head = (await query(repository, "head_sha")).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/u.test(head)) throw new Error("invalid repository head");
      return head;
    },
    async push(repository, branch) {
      const result = await registry.invoke<GitPushInput, GitCommandOutput>("git.push", requests.request({
        invocationId: invocationId("git.push"), repoId: repository.repoId,
        input: { cwd: repository.worktreePath, branch },
      }));
      if (!result.ok) throw new Error(`repository_tool_failed: ${result.error.code}`);
      return { code: result.output.code };
    },
    runRepository,
    async runIntegration(boundExecution, cwdRepoId, command, env) {
      const repository = boundExecution.repositories[cwdRepoId];
      if (repository === undefined || repository.access !== "write") {
        throw new Error("missing_execution_context: integration verification requires its declared writable cwd repository");
      }
      return runRepository(repository, command, env);
    },
  };
}

function parseRecentCommits(stdout: string): ObservedCommit[] {
  return stdout.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    const [hash, rawTs, ...message] = line.split("\t");
    if (hash === undefined || hash === "") throw new Error("invalid recent-commit result");
    const tsSec = Number(rawTs ?? "0");
    if (!Number.isFinite(tsSec)) throw new Error("invalid recent-commit timestamp");
    return [{ hash, message: message.join("\t"), tsSec }];
  });
}

export function defaultRepositoryAdapters(ctx?: CycleContext): RepositoryPortAdapters {
  const tools = ctx === undefined ? undefined : createRepositoryToolRuntime(ctx);
  return {
    git: {
      commitsAhead: tools?.commitsAhead ?? repositoryCommitsAhead,
      tcrCount: tools?.tcrCount ?? repositoryTcrCount,
      recentCommits: tools?.recentCommits ?? repositoryRecentCommits,
      dirty: tools?.dirty ?? repositoryDirty,
      headSha: tools?.headSha ?? repositoryHeadSha,
      push: tools?.push ?? ((repository, branch) => gitPush(repository.worktreePath, branch)),
    },
    verification: {
      runRepository: tools?.runRepository ?? ((repository, command, env) => runRepositoryCommand(repository.worktreePath, command, env)),
      runIntegration: tools?.runIntegration ?? ((execution, cwdRepoId, command, env) => {
        const repository = execution.repositories[cwdRepoId];
        if (repository === undefined || repository.access !== "write") {
          throw new Error("missing_execution_context: integration verification requires its declared writable cwd repository");
        }
        return runRepositoryCommand(repository.worktreePath, command, env);
      }),
    },
    provider: {
      async repoSlug(repository) { return ghRepoSlug(await remoteUrl(repository.worktreePath)); },
      async prState(repository, branch) {
        const slug = ghRepoSlug(await remoteUrl(repository.worktreePath));
        return slug === undefined ? "UNKNOWN" : prViewState(slug, branch);
      },
      async prMergeInfo(repository, branch) {
        const slug = ghRepoSlug(await remoteUrl(repository.worktreePath));
        return slug === undefined ? undefined : prViewMergeInfo(slug, branch);
      },
    },
  };
}

export function productionRepositoryAdapters(ctx: CycleContext): RepositoryPortAdapters {
  return defaultRepositoryAdapters(ctx);
}
