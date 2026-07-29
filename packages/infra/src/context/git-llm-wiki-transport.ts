import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  normalizeContextGitRemote,
  type ContextDiagnosticCode,
  type GitLlmWikiProviderConfigV1,
} from "@roll/spec";
import { git, type GitExecutionOptions, type GitResult } from "../git.js";
import { acquireLock, readLockOwner, releaseLock } from "../process.js";
import {
  buildGitLlmWikiCommand,
  ContextTransportError,
  GIT_LLM_WIKI_POLICY_ARGS,
  resolveContextCacheIdentity,
  type ContextCacheIdentity,
} from "./context-cache.js";

export interface GitProviderRevisionV1 {
  readonly providerId: string;
  readonly remoteIdentity: string;
  readonly branch: string;
  readonly fetchedAt: string;
  readonly revision: string;
  readonly cachePath: string;
}

export type GitLlmWikiCommandRunner = (
  args: readonly string[],
  cwd: string | undefined,
  options: GitExecutionOptions,
) => Promise<GitResult>;

export interface FreshGitLlmWikiReadInput {
  readonly rollHome: string;
  readonly provider: GitLlmWikiProviderConfigV1;
  readonly runGit?: GitLlmWikiCommandRunner;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
  readonly now?: () => number;
  readonly audit?: GitLlmWikiReadAuditSink;
}

export interface GitLlmWikiReadAuditEventV1 {
  readonly type: "context:git-llm-wiki-read";
  readonly providerId: string;
  readonly remoteIdentity: string;
  readonly branch: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly outcome: "completed" | "failed";
  readonly revision?: string;
  readonly bytes?: number;
  readonly diagnosticCode?: ContextDiagnosticCode;
}

export type GitLlmWikiReadAuditSink = (
  event: GitLlmWikiReadAuditEventV1,
) => void | Promise<void>;

interface ProviderReadLease {
  readonly token: string;
}

interface CheckedGitOptions {
  readonly failureCode?: "fetch_failed" | "revision_missing";
  readonly operation: string;
  readonly timeoutMs: number;
  readonly classifyBranchMissing?: boolean;
}

const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CONTEXT_GIT_ENV: Readonly<Record<string, string>> = {
  LC_ALL: "C",
  LANG: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "false",
  SSH_ASKPASS: "false",
  GCM_INTERACTIVE: "Never",
};

function policyCommand(operation: readonly string[]): readonly string[] {
  return [...GIT_LLM_WIKI_POLICY_ARGS, ...operation];
}

function pathIsSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function prepareCacheRoots(identity: ContextCacheIdentity): void {
  if (pathIsSymlink(identity.cacheRoot)) {
    throw new ContextTransportError("fetch_failed", "Managed Context cache root is unsafe", identity.providerId);
  }
  mkdirSync(identity.cacheRoot, { recursive: true });
  const locksRoot = `${identity.cacheRoot}/locks`;
  if (pathIsSymlink(locksRoot)) {
    throw new ContextTransportError("fetch_failed", "Managed Context cache lock root is unsafe", identity.providerId);
  }
  mkdirSync(locksRoot, { recursive: true });
  if (pathIsSymlink(identity.cachePath) || pathIsSymlink(identity.temporaryPath)) {
    throw new ContextTransportError("fetch_failed", "Managed Context cache path is unsafe", identity.providerId);
  }
}

async function takeProviderReadLock(
  identity: ContextCacheIdentity,
  timeoutMs: number,
  retryMs: number,
): Promise<ProviderReadLease> {
  const deadline = Date.now() + timeoutMs;
  const token = `context:${identity.providerId}:${randomUUID()}`;
  for (;;) {
    const acquired = acquireLock(identity.lockPath, process.pid, {
      staleSec: Number.POSITIVE_INFINITY,
      cycleId: token,
      unparseableIsHeld: true,
    });
    if (acquired.acquired) {
      const owner = readLockOwner(identity.lockPath);
      if (owner?.pid === process.pid && owner.cycleId === token) return { token };
      if (owner === undefined) releaseLock(identity.lockPath);
      throw new ContextTransportError(
        "context_lock_timeout",
        "Context Provider read lock owner metadata is unavailable",
        identity.providerId,
      );
    }
    if (Date.now() >= deadline) {
      throw new ContextTransportError(
        "context_lock_timeout",
        "Context Provider read lock timed out",
        identity.providerId,
      );
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, retryMs));
  }
}

function assertLease(identity: ContextCacheIdentity, lease: ProviderReadLease): void {
  const owner = readLockOwner(identity.lockPath);
  if (owner?.pid !== process.pid || owner.cycleId !== lease.token) {
    throw new ContextTransportError("context_lock_timeout", "Context Provider read lock was lost", identity.providerId);
  }
  prepareCacheRoots(identity);
}

function releaseProviderReadLock(identity: ContextCacheIdentity, lease: ProviderReadLease): void {
  const owner = readLockOwner(identity.lockPath);
  if (owner?.pid === process.pid && owner.cycleId === lease.token) releaseLock(identity.lockPath);
}

function branchMissing(stderr: string): boolean {
  return /(?:couldn't find remote ref|could not find remote ref|remote ref does not exist)/iu.test(stderr);
}

async function checkedGit(
  identity: ContextCacheIdentity,
  lease: ProviderReadLease,
  runGit: GitLlmWikiCommandRunner,
  args: readonly string[],
  cwd: string | undefined,
  options: CheckedGitOptions,
): Promise<GitResult> {
  assertLease(identity, lease);
  let result: GitResult;
  try {
    result = await runGit(args, cwd, { timeoutMs: options.timeoutMs, env: CONTEXT_GIT_ENV });
  } catch {
    throw new ContextTransportError(
      options.failureCode ?? "fetch_failed",
      `Context Git ${options.operation} could not start`,
      identity.providerId,
    );
  }
  if (result.code !== 0) {
    if (result.timedOut === true) {
      throw new ContextTransportError(
        options.operation === "fetch" ? "fetch_timeout" : (options.failureCode ?? "fetch_failed"),
        `Context Git ${options.operation} timed out`,
        identity.providerId,
      );
    }
    if (options.classifyBranchMissing === true && branchMissing(result.stderr)) {
      throw new ContextTransportError("branch_not_found", "Context Provider branch was not found", identity.providerId);
    }
    throw new ContextTransportError(
      options.failureCode ?? "fetch_failed",
      `Context Git ${options.operation} failed`,
      identity.providerId,
    );
  }
  assertLease(identity, lease);
  return result;
}

async function validateCache(
  identity: ContextCacheIdentity,
  lease: ProviderReadLease,
  runGit: GitLlmWikiCommandRunner,
  timeoutMs: number,
  cachePath = identity.cachePath,
): Promise<void> {
  const bare = await checkedGit(
    identity,
    lease,
    runGit,
    policyCommand(["rev-parse", "--is-bare-repository"]),
    cachePath,
    { operation: "cache validation", timeoutMs },
  );
  if (bare.stdout.trim() !== "true") {
    throw new ContextTransportError("fetch_failed", "Managed Context cache is not a bare repository", identity.providerId);
  }
  const origin = await checkedGit(
    identity,
    lease,
    runGit,
    policyCommand(["remote", "get-url", "--all", identity.remoteName]),
    cachePath,
    { operation: "remote validation", timeoutMs },
  );
  const remotes = origin.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  const normalizedRemote = remotes.length === 1 ? normalizeContextGitRemote(remotes[0]) : undefined;
  if (normalizedRemote === undefined || !normalizedRemote.ok || normalizedRemote.value !== identity.remoteIdentity) {
    throw new ContextTransportError(
      "remote_identity_mismatch",
      "Managed Context cache remote identity does not match Provider configuration",
      identity.providerId,
    );
  }
}

async function initializeCache(
  identity: ContextCacheIdentity,
  lease: ProviderReadLease,
  runGit: GitLlmWikiCommandRunner,
  timeoutMs: number,
): Promise<void> {
  assertLease(identity, lease);
  rmSync(identity.temporaryPath, { recursive: true, force: true });
  let installed = false;
  try {
    await checkedGit(
      identity,
      lease,
      runGit,
      policyCommand(["init", "--bare", identity.temporaryPath]),
      undefined,
      { operation: "cache initialization", timeoutMs },
    );
    await checkedGit(
      identity,
      lease,
      runGit,
      policyCommand(["remote", "add", identity.remoteName, identity.fetchEndpoint]),
      identity.temporaryPath,
      { operation: "remote setup", timeoutMs },
    );
    await validateCache(identity, lease, runGit, timeoutMs, identity.temporaryPath);
    assertLease(identity, lease);
    renameSync(identity.temporaryPath, identity.cachePath);
    installed = true;
  } finally {
    if (!installed) rmSync(identity.temporaryPath, { recursive: true, force: true });
  }
}

async function ensureCache(
  identity: ContextCacheIdentity,
  lease: ProviderReadLease,
  runGit: GitLlmWikiCommandRunner,
  timeoutMs: number,
): Promise<void> {
  assertLease(identity, lease);
  if (!existsSync(identity.cachePath)) {
    await initializeCache(identity, lease, runGit, timeoutMs);
    return;
  }
  await validateCache(identity, lease, runGit, timeoutMs);
}

async function fetchRevision(
  identity: ContextCacheIdentity,
  provider: GitLlmWikiProviderConfigV1,
  lease: ProviderReadLease,
  runGit: GitLlmWikiCommandRunner,
  timeoutMs: number,
  now: () => number,
): Promise<GitProviderRevisionV1> {
  await checkedGit(
    identity,
    lease,
    runGit,
    buildGitLlmWikiCommand("fetch", provider),
    identity.cachePath,
    { operation: "fetch", timeoutMs, classifyBranchMissing: true },
  );
  const remoteRef = `refs/remotes/${identity.remoteName}/${identity.branch}`;
  const resolved = await checkedGit(
    identity,
    lease,
    runGit,
    policyCommand(["rev-parse", "--verify", remoteRef]),
    identity.cachePath,
    { operation: "revision resolve", timeoutMs, failureCode: "revision_missing" },
  );
  const revision = resolved.stdout.trim();
  if (!FULL_GIT_OBJECT_ID.test(revision)) {
    throw new ContextTransportError("revision_missing", "Context revision is not a full Git object id", identity.providerId);
  }
  const type = await checkedGit(
    identity,
    lease,
    runGit,
    policyCommand(["cat-file", "-t", revision]),
    identity.cachePath,
    { operation: "revision type validation", timeoutMs, failureCode: "revision_missing" },
  );
  if (type.stdout.trim() !== "commit") {
    throw new ContextTransportError("revision_missing", "Context revision is not a commit object", identity.providerId);
  }
  return {
    providerId: identity.providerId,
    remoteIdentity: identity.remoteIdentity,
    branch: identity.branch,
    fetchedAt: new Date(now()).toISOString(),
    revision,
    cachePath: identity.cachePath,
  };
}

/**
 * Execute one fresh Provider read under one cross-process lease. The callback is
 * deliberately inside the lease so fixed-SHA object reads and validation finish
 * before another process may fetch or maintain the same bare cache.
 */
export async function withFreshGitLlmWikiRead<T>(
  input: FreshGitLlmWikiReadInput,
  readAtRevision: (revision: GitProviderRevisionV1) => Promise<T>,
): Promise<{ readonly revision: GitProviderRevisionV1; readonly value: T }> {
  const identity = resolveContextCacheIdentity(input);
  const lockTimeoutMs = input.lockTimeoutMs ?? (input.provider.fetch_timeout_seconds + 5) * 1_000;
  const lockRetryMs = input.lockRetryMs ?? 25;
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0 || !Number.isFinite(lockRetryMs) || lockRetryMs <= 0) {
    throw new ContextTransportError("invalid_provider_config", "Context Provider lock timing is invalid", identity.providerId);
  }
  const runGit = input.runGit ?? git;
  const timeoutMs = input.provider.fetch_timeout_seconds * 1_000;
  const now = input.now ?? Date.now;
  const startedAtMs = now();
  let lease: ProviderReadLease | undefined;
  let operation:
    | { readonly ok: true; readonly revision: GitProviderRevisionV1; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  try {
    prepareCacheRoots(identity);
    lease = await takeProviderReadLock(identity, lockTimeoutMs, lockRetryMs);
    assertLease(identity, lease);
    await ensureCache(identity, lease, runGit, timeoutMs);
    const revision = await fetchRevision(
      identity,
      input.provider,
      lease,
      runGit,
      timeoutMs,
      now,
    );
    assertLease(identity, lease);
    const value = await readAtRevision(revision);
    assertLease(identity, lease);
    operation = { ok: true, revision, value };
  } catch (error) {
    operation = { ok: false, error };
  } finally {
    if (lease !== undefined) releaseProviderReadLock(identity, lease);
  }

  const finishedAtMs = now();
  const timing = {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
  };
  if (!operation.ok) {
    const event: GitLlmWikiReadAuditEventV1 = {
      type: "context:git-llm-wiki-read",
      providerId: identity.providerId,
      remoteIdentity: identity.remoteIdentity,
      branch: identity.branch,
      ...timing,
      outcome: "failed",
      ...(operation.error instanceof ContextTransportError ? { diagnosticCode: operation.error.code } : {}),
    };
    try {
      await input.audit?.(event);
    } catch {
      // Preserve the primary transport/read failure; audit sinks must not mask it.
    }
    throw operation.error;
  }
  try {
    await input.audit?.({
      type: "context:git-llm-wiki-read",
      providerId: identity.providerId,
      remoteIdentity: identity.remoteIdentity,
      branch: identity.branch,
      ...timing,
      outcome: "completed",
      revision: operation.revision.revision,
    });
  } catch {
    // Audit sinks are observational and must not mask a completed read.
  }
  return { revision: operation.revision, value: operation.value };
}
