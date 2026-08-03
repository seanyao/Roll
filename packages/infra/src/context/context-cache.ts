import { isAbsolute, join, resolve } from "node:path";
import {
  isValidContextBranch,
  isValidContextProviderId,
  normalizeContextGitRemote,
  resolveContextGitRemote,
  type ContextDiagnosticCode,
  type ContextDiagnosticV1,
  type GitLlmWikiProviderConfigV1,
} from "@roll/spec";

export const GIT_LLM_WIKI_REMOTE_NAME = "origin" as const;

export const GIT_LLM_WIKI_POLICY_ARGS = [
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.ssh.allow=always",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.askPass=false",
  "-c", "credential.interactive=never",
] as const;

export interface ContextCacheIdentity {
  readonly providerId: string;
  readonly remoteIdentity: string;
  readonly fetchEndpoint: string;
  readonly branch: string;
  readonly cacheRoot: string;
  readonly cachePath: string;
  readonly temporaryPath: string;
  readonly lockPath: string;
  readonly remoteName: typeof GIT_LLM_WIKI_REMOTE_NAME;
}

export class ContextTransportError extends Error {
  readonly diagnostic: ContextDiagnosticV1;

  constructor(
    readonly code: ContextDiagnosticCode,
    message: string,
    providerId?: string,
  ) {
    super(message);
    this.name = "ContextTransportError";
    this.diagnostic = {
      code,
      severity: "blocking",
      ...(providerId === undefined ? {} : { providerId }),
      message,
    };
  }
}

function normalizedProvider(provider: GitLlmWikiProviderConfigV1): {
  readonly providerId: string;
  readonly remoteIdentity: string;
  readonly fetchEndpoint: string;
  readonly branch: string;
} {
  if (
    provider.type !== "git_llm_wiki" ||
    !provider.enabled ||
    !isValidContextProviderId(provider.id) ||
    !isValidContextBranch(provider.branch) ||
    !Number.isSafeInteger(provider.fetch_timeout_seconds) ||
    provider.fetch_timeout_seconds < 5 ||
    provider.fetch_timeout_seconds > 300
  ) {
    throw new ContextTransportError(
      "invalid_provider_config",
      "Context Provider configuration is invalid",
      isValidContextProviderId(provider.id) ? provider.id : undefined,
    );
  }
  const remote = resolveContextGitRemote(provider.remote);
  if (!remote.ok) {
    throw new ContextTransportError(
      "unsupported_git_transport",
      "Context Provider Git transport is not supported",
      provider.id,
    );
  }
  return {
    providerId: provider.id,
    remoteIdentity: remote.value.remoteIdentity,
    fetchEndpoint: remote.value.fetchEndpoint,
    branch: provider.branch,
  };
}

export function resolveContextCacheIdentity(input: {
  readonly rollHome: string;
  readonly provider: GitLlmWikiProviderConfigV1;
}): ContextCacheIdentity {
  if (!isAbsolute(input.rollHome)) {
    throw new ContextTransportError("invalid_provider_config", "ROLL_HOME must be an absolute path");
  }
  const provider = normalizedProvider(input.provider);
  const cacheRoot = join(resolve(input.rollHome), "context-cache");
  return {
    providerId: provider.providerId,
    remoteIdentity: provider.remoteIdentity,
    fetchEndpoint: provider.fetchEndpoint,
    branch: provider.branch,
    cacheRoot,
    cachePath: join(cacheRoot, `${provider.providerId}.git`),
    temporaryPath: join(cacheRoot, `${provider.providerId}.creating`),
    lockPath: join(cacheRoot, "locks", `${provider.providerId}.lock`),
    remoteName: GIT_LLM_WIKI_REMOTE_NAME,
  };
}

export function buildGitLlmWikiCommand(
  _operation: "fetch",
  provider: GitLlmWikiProviderConfigV1,
): readonly string[] {
  const normalized = normalizedProvider(provider);
  return [
    ...GIT_LLM_WIKI_POLICY_ARGS,
    "fetch",
    "--prune",
    "--no-tags",
    "--recurse-submodules=no",
    normalized.fetchEndpoint,
    `+refs/heads/${normalized.branch}:refs/remotes/${GIT_LLM_WIKI_REMOTE_NAME}/${normalized.branch}`,
  ];
}
