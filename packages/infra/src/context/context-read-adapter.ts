import {
  LLM_WIKI_MAX_FILE_BYTES,
  LLM_WIKI_MAX_PAGES,
  LLM_WIKI_MAX_PROVIDER_BYTES,
  validateLlmWikiRevision,
  type ContextProviderReadAdapter,
  type ContextProviderReadFailureV1,
  type ContextProviderReadInputV1,
  type ContextProviderReadOutcomeV1,
  type FixedRevisionBlobFact,
} from "@roll/core";
import type { ContextDiagnosticV1 } from "@roll/spec";
import {
  git,
  rawGitBinary,
  type GitBinaryResult,
  type GitExecutionOptions,
} from "../git.js";
import {
  ContextTransportError,
  GIT_LLM_WIKI_POLICY_ARGS,
} from "./context-cache.js";
import {
  withFreshGitLlmWikiRead,
  type GitLlmWikiCommandRunner,
  type GitLlmWikiReadAuditEventV1,
  type GitLlmWikiReadAuditSink,
  type GitProviderRevisionV1,
} from "./git-llm-wiki-transport.js";

export interface CreateContextReadAdapterOptions {
  readonly rollHome: string;
  readonly runGit?: GitLlmWikiCommandRunner;
  readonly runGitBinary?: GitLlmWikiBinaryCommandRunner;
  readonly now?: () => number;
  readonly audit?: GitLlmWikiReadAuditSink;
}

export type GitLlmWikiBinaryCommandRunner = (
  args: readonly string[],
  cwd: string | undefined,
  options: GitExecutionOptions,
) => Promise<GitBinaryResult>;

async function emitAudit(
  audit: GitLlmWikiReadAuditSink | undefined,
  event: GitLlmWikiReadAuditEventV1 | undefined,
): Promise<void> {
  if (audit === undefined || event === undefined) return;
  try {
    await audit(event);
  } catch {
    // Audit sinks must not mask the primary Context read result.
  }
}

interface GitObjectDescriptor {
  readonly path: string;
  readonly mode: FixedRevisionBlobFact["mode"];
  readonly oid: string;
  readonly bytes: number;
}

class ContextObjectReadError extends Error {
  constructor(
    readonly code: ContextDiagnosticV1["code"],
    readonly ref?: string,
  ) {
    super("Context fixed-revision object read failed");
    this.name = "ContextObjectReadError";
  }
}

function command(operation: readonly string[]): readonly string[] {
  return [...GIT_LLM_WIKI_POLICY_ARGS, ...operation];
}

function diagnostic(
  providerId: string,
  code: ContextDiagnosticV1["code"],
  message: string,
  ref?: string,
): ContextProviderReadFailureV1 {
  return {
    ok: false,
    diagnostic: {
      code,
      severity: "blocking",
      providerId,
      ...(ref === undefined ? {} : { ref }),
      message,
    },
  };
}

async function checkedObjectGit(
  runGit: GitLlmWikiCommandRunner,
  revision: GitProviderRevisionV1,
  args: readonly string[],
  timeoutMs: number,
  code: ContextDiagnosticV1["code"],
  ref?: string,
): Promise<string> {
  let result;
  try {
    result = await runGit(
      command(args),
      revision.cachePath,
      { timeoutMs },
    );
  } catch {
    throw new ContextObjectReadError(code, ref);
  }
  if (result.code !== 0 || result.timedOut === true) throw new ContextObjectReadError(code, ref);
  return result.stdout;
}

async function checkedObjectGitBinary(
  runGitBinary: GitLlmWikiBinaryCommandRunner,
  revision: GitProviderRevisionV1,
  args: readonly string[],
  timeoutMs: number,
  code: ContextDiagnosticV1["code"],
  ref?: string,
): Promise<Uint8Array> {
  let result;
  try {
    result = await runGitBinary(
      command(args),
      revision.cachePath,
      { timeoutMs },
    );
  } catch {
    throw new ContextObjectReadError(code, ref);
  }
  if (result.code !== 0 || result.timedOut === true) throw new ContextObjectReadError(code, ref);
  return result.stdout;
}

function parseLsTree(path: string, output: string): { readonly mode: FixedRevisionBlobFact["mode"]; readonly oid: string } | undefined {
  if (output === "") return undefined;
  if (!output.endsWith("\0")) {
    throw new ContextObjectReadError("context_file_missing", `context://unknown/${path}`);
  }
  const record = output.slice(0, -1);
  if (record.includes("\0")) {
    throw new ContextObjectReadError("context_file_missing", `context://unknown/${path}`);
  }
  const match = /^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u.exec(record);
  if (match === null || match[3] !== path || match[1] === undefined || match[2] === undefined) {
    throw new ContextObjectReadError("context_file_missing", `context://unknown/${path}`);
  }
  return { mode: match[1] as FixedRevisionBlobFact["mode"], oid: match[2] };
}

async function describeFiles(
  runGit: GitLlmWikiCommandRunner,
  revision: GitProviderRevisionV1,
  paths: readonly string[],
  timeoutMs: number,
): Promise<readonly GitObjectDescriptor[]> {
  const descriptors: GitObjectDescriptor[] = [];
  for (const path of paths) {
    const ref = `context://${revision.providerId}/${path}`;
    const tree = await checkedObjectGit(
      runGit,
      revision,
      ["ls-tree", "-z", revision.revision, "--", path],
      timeoutMs,
      "context_file_missing",
      ref,
    );
    const parsed = parseLsTree(path, tree);
    if (parsed === undefined) continue;
    const rawSize = await checkedObjectGit(
      runGit,
      revision,
      ["cat-file", "-s", parsed.oid],
      timeoutMs,
      "context_file_missing",
      ref,
    );
    const bytes = Number(rawSize.trim());
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ContextObjectReadError("context_file_missing", ref);
    descriptors.push({ path, mode: parsed.mode, oid: parsed.oid, bytes });
  }
  return descriptors;
}

function budgetFailure(
  providerId: string,
  descriptors: readonly GitObjectDescriptor[],
): ContextProviderReadFailureV1 | undefined {
  if (descriptors.length > LLM_WIKI_MAX_PAGES) {
    return diagnostic(providerId, "context_budget_exceeded", "Context Provider page budget exceeded");
  }
  const oversized = descriptors.find((file) => file.bytes > LLM_WIKI_MAX_FILE_BYTES);
  if (oversized !== undefined) {
    return diagnostic(
      providerId,
      "context_file_too_large",
      "Context file exceeds the per-file byte limit",
      `context://${providerId}/${oversized.path}`,
    );
  }
  const total = descriptors.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(total) || total > LLM_WIKI_MAX_PROVIDER_BYTES) {
    return diagnostic(providerId, "context_budget_exceeded", "Context Provider byte budget exceeded");
  }
  return undefined;
}

async function readContents(
  runGitBinary: GitLlmWikiBinaryCommandRunner,
  revision: GitProviderRevisionV1,
  descriptors: readonly GitObjectDescriptor[],
  timeoutMs: number,
): Promise<readonly FixedRevisionBlobFact[]> {
  const files: FixedRevisionBlobFact[] = [];
  for (const descriptor of descriptors) {
    const ref = `context://${revision.providerId}/${descriptor.path}`;
    if (descriptor.mode === "120000") {
      files.push({
        path: descriptor.path,
        objectType: "blob",
        mode: descriptor.mode,
        bytes: descriptor.bytes,
        content: "",
      });
      continue;
    }
    const content = await checkedObjectGitBinary(
      runGitBinary,
      revision,
      ["cat-file", "blob", descriptor.oid],
      timeoutMs,
      "context_file_missing",
      ref,
    );
    files.push({
      path: descriptor.path,
      objectType: "blob",
      mode: descriptor.mode,
      bytes: descriptor.bytes,
      content,
    });
  }
  return files;
}

async function readAtFixedRevision(
  input: ContextProviderReadInputV1,
  revision: GitProviderRevisionV1,
  runGit: GitLlmWikiCommandRunner,
  runGitBinary: GitLlmWikiBinaryCommandRunner,
): Promise<ContextProviderReadOutcomeV1> {
  try {
    const timeoutMs = input.plan.provider.fetch_timeout_seconds * 1_000;
    const descriptors = await describeFiles(runGit, revision, input.paths, timeoutMs);
    const overBudget = budgetFailure(revision.providerId, descriptors);
    if (overBudget !== undefined) return overBudget;
    const facts = await readContents(runGitBinary, revision, descriptors, timeoutMs);
    const validation = validateLlmWikiRevision({
      providerId: revision.providerId,
      entrypoints: input.plan.binding.entrypoints,
      refs: input.refs,
      files: facts,
    });
    if (!validation.valid) {
      return { ok: false, diagnostic: validation.diagnostics[0] ?? {
        code: "invalid_wiki_layout",
        severity: "blocking",
        providerId: revision.providerId,
        message: "LLM Wiki validation failed",
      } };
    }
    return {
      ok: true,
      revision: {
        providerId: revision.providerId,
        remoteIdentity: revision.remoteIdentity,
        branch: revision.branch,
        fetchedAt: revision.fetchedAt,
        revision: revision.revision,
      },
      files: validation.files,
      warnings: validation.diagnostics,
    };
  } catch (error) {
    if (error instanceof ContextObjectReadError) {
      return diagnostic(
        revision.providerId,
        error.code,
        "Context file could not be read at the resolved revision",
        error.ref?.replace("context://unknown/", `context://${revision.providerId}/`),
      );
    }
    return diagnostic(revision.providerId, "fetch_failed", "Context fixed-revision object read failed");
  }
}

export function createContextReadAdapter(options: CreateContextReadAdapterOptions): ContextProviderReadAdapter {
  const runGit = options.runGit ?? git;
  const runGitBinary = options.runGitBinary ?? rawGitBinary;
  return {
    async read(input: ContextProviderReadInputV1): Promise<ContextProviderReadOutcomeV1> {
      if (input.paths.length > LLM_WIKI_MAX_PAGES) {
        return diagnostic(
          input.plan.provider.id,
          "context_budget_exceeded",
          "Context Provider planned page budget exceeded",
        );
      }
      const transportAudit: GitLlmWikiReadAuditEventV1[] = [];
      try {
        const result = await withFreshGitLlmWikiRead({
          rollHome: options.rollHome,
          provider: input.plan.provider,
          runGit,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.audit === undefined ? {} : { audit: (event) => { transportAudit.push(event); } }),
        }, async (revision) => readAtFixedRevision(input, revision, runGit, runGitBinary));
        const event = transportAudit.at(-1);
        await emitAudit(options.audit, event === undefined ? undefined : {
          ...event,
          ...(result.value.ok
            ? { bytes: result.value.files.reduce((sum, file) => sum + file.bytes, 0) }
            : {}),
        });
        return result.value;
      } catch (error) {
        await emitAudit(options.audit, transportAudit.at(-1));
        if (error instanceof ContextTransportError) return { ok: false, diagnostic: error.diagnostic };
        return diagnostic(input.plan.provider.id, "fetch_failed", "Context Provider transport failed");
      }
    },
  };
}
