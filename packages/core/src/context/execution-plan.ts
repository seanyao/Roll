import { createHash } from "node:crypto";
import {
  isSafeContextPath,
  isValidContextBranch,
  isValidContextProviderId,
  normalizeContextGitRemote,
  parseContextRef,
  resolveContextGitRemote,
  workspaceExecutionContextV1Schema,
  type ContextDiagnosticV1,
  type ContextProviderExecutionPlanV1,
  type ContextProviderRegistryV1,
  type GitLlmWikiProviderConfigV1,
  type WorkspaceContextBindingV1,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { validateJsonSchemaValue } from "../tools/schema.js";
import { planLlmWikiRevisionPaths } from "./context-ref.js";
import { LLM_WIKI_MAX_PAGES } from "./llm-wiki-validator.js";

export interface CompileContextProviderExecutionPlansInput {
  readonly registry?: ContextProviderRegistryV1;
  readonly workspace?: unknown;
  readonly refs?: readonly string[];
}

export type WorkspaceExecutionContextParseResult =
  | { readonly ok: true; readonly value: WorkspaceExecutionContextV1 }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate the complete Workspace authority at the core boundary before any
 * Context planning can consume it. Callers cannot bypass the versioned,
 * closed schema through TypeScript structural compatibility.
 */
export function parseWorkspaceExecutionContext(value: unknown): WorkspaceExecutionContextParseResult {
  const validation = validateJsonSchemaValue(workspaceExecutionContextV1Schema, value);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, value: value as WorkspaceExecutionContextV1 };
}

export interface ContextProviderExecutionPlanCompilationV1 {
  readonly outcome: "disabled" | "blocked" | "ready";
  readonly plans: readonly ContextProviderExecutionPlanV1[];
  readonly diagnostics: readonly ContextDiagnosticV1[];
}

function diagnostic(
  code: ContextDiagnosticV1["code"],
  severity: ContextDiagnosticV1["severity"],
  message: string,
  providerId?: string,
  ref?: string,
): ContextDiagnosticV1 {
  return {
    code,
    severity,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(ref !== undefined ? { ref } : {}),
    message,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Context digest input must be JSON-compatible");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function stableUnique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function invalidBinding(binding: WorkspaceContextBindingV1): boolean {
  return !isValidContextProviderId(binding.providerId) ||
    (binding.required && !binding.enabled) ||
    binding.entrypoints.some((path) => !isSafeContextPath(path, false));
}

function normalizeProvider(provider: GitLlmWikiProviderConfigV1): GitLlmWikiProviderConfigV1 | undefined {
  const remote = resolveContextGitRemote(provider.remote);
  if (provider.type !== "git_llm_wiki" ||
    !isValidContextProviderId(provider.id) ||
    !isValidContextBranch(provider.branch) ||
    !Number.isSafeInteger(provider.fetch_timeout_seconds) ||
    provider.fetch_timeout_seconds < 5 ||
    provider.fetch_timeout_seconds > 300 ||
    !remote.ok
  ) return undefined;
  return {
    id: provider.id,
    type: "git_llm_wiki",
    enabled: provider.enabled,
    remote: remote.value.fetchEndpoint,
    branch: provider.branch,
    fetch_timeout_seconds: provider.fetch_timeout_seconds,
  };
}

function providerDigestInput(provider: GitLlmWikiProviderConfigV1): GitLlmWikiProviderConfigV1 {
  const remote = normalizeContextGitRemote(provider.remote);
  return { ...provider, remote: remote.ok ? remote.value : provider.remote };
}

/**
 * Compile the complete authorization plan before any provider effect occurs.
 * The function is synchronous and deterministic: it does not inspect cwd,
 * files, environment variables, caches, or Git state.
 */
export function compileContextProviderExecutionPlans(
  input: CompileContextProviderExecutionPlansInput,
): ContextProviderExecutionPlanCompilationV1 {
  if (input.registry === undefined || !input.registry.enabled || input.workspace === undefined) {
    return {
      outcome: "disabled",
      plans: [],
      diagnostics: [diagnostic("context_disabled", "warning", "Context is disabled for this machine or Workspace")],
    };
  }

  const parsedWorkspace = parseWorkspaceExecutionContext(input.workspace);
  if (!parsedWorkspace.ok) {
    return {
      outcome: "blocked",
      plans: [],
      diagnostics: [diagnostic(
        "invalid_context_binding",
        "blocking",
        "Workspace execution Context authority is invalid",
      )],
    };
  }

  const contexts = parsedWorkspace.value.contexts;
  if (contexts === undefined || !contexts.enabled) {
    return {
      outcome: "disabled",
      plans: [],
      diagnostics: [diagnostic("context_disabled", "warning", "Context is disabled for this machine or Workspace")],
    };
  }

  const refs = input.refs ?? [];
  const parsedRefs = refs.map((ref) => parseContextRef(ref));
  const invalidRefIndex = parsedRefs.findIndex((entry) => !entry.ok);
  if (invalidRefIndex >= 0) {
    return {
      outcome: "blocked",
      plans: [],
      diagnostics: [diagnostic(
        "invalid_context_ref",
        "blocking",
        "Context ref is invalid",
        undefined,
        refs[invalidRefIndex],
      )],
    };
  }

  const bindings = contexts.bindings;
  const seenBindings = new Set<string>();
  for (const binding of bindings) {
    if (seenBindings.has(binding.providerId) || invalidBinding(binding)) {
      return {
        outcome: "blocked",
        plans: [],
        diagnostics: [diagnostic(
          "invalid_context_binding",
          "blocking",
          "Workspace Context binding is duplicate or contradictory",
          binding.providerId,
        )],
      };
    }
    seenBindings.add(binding.providerId);
  }

  const enabledBindingIds = new Set(bindings.filter((binding) => binding.enabled).map((binding) => binding.providerId));
  for (const parsed of parsedRefs) {
    if (!parsed.ok) continue;
    if (!enabledBindingIds.has(parsed.value.providerId)) {
      return {
        outcome: "blocked",
        plans: [],
        diagnostics: [diagnostic(
          "provider_not_bound",
          "blocking",
          "Explicit Context ref targets a Provider not enabled by this Workspace",
          parsed.value.providerId,
          parsed.value.ref,
        )],
      };
    }
  }

  const activeBindings = bindings.filter((binding) => binding.enabled);
  if (activeBindings.length === 0) {
    return {
      outcome: "disabled",
      plans: [],
      diagnostics: [diagnostic("context_disabled", "warning", "Workspace has no enabled Context binding")],
    };
  }

  const providers = new Map<string, GitLlmWikiProviderConfigV1>();
  const duplicateProviders = new Set<string>();
  for (const provider of input.registry.providers) {
    if (providers.has(provider.id)) duplicateProviders.add(provider.id);
    else providers.set(provider.id, provider);
  }

  const diagnostics: ContextDiagnosticV1[] = [];
  const plans: ContextProviderExecutionPlanV1[] = [];
  let blocked = false;

  for (const binding of activeBindings) {
    const severity = binding.required ? "blocking" as const : "gap" as const;
    if (duplicateProviders.has(binding.providerId)) {
      diagnostics.push(diagnostic(
        "invalid_provider_config",
        severity,
        "Context Provider id is duplicated in the machine registry",
        binding.providerId,
      ));
      blocked ||= binding.required;
      continue;
    }

    const provider = providers.get(binding.providerId);
    if (provider === undefined) {
      diagnostics.push(diagnostic(
        "provider_not_found",
        severity,
        "Workspace Context binding does not resolve to an installed Provider",
        binding.providerId,
      ));
      blocked ||= binding.required;
      continue;
    }
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider === undefined) {
      diagnostics.push(diagnostic(
        "invalid_provider_config",
        severity,
        "Context Provider configuration is invalid",
        binding.providerId,
      ));
      blocked ||= binding.required;
      continue;
    }
    if (!provider.enabled) {
      diagnostics.push(diagnostic(
        "provider_disabled",
        severity,
        "Workspace Context binding targets a disabled Provider",
        binding.providerId,
      ));
      blocked ||= binding.required;
      continue;
    }

    const requestedPaths = parsedRefs.flatMap((parsed) =>
      parsed.ok && parsed.value.providerId === binding.providerId ? [parsed.value.path] : []
    );
    const normalizedBinding: WorkspaceContextBindingV1 = {
      providerId: binding.providerId,
      enabled: binding.enabled,
      required: binding.required,
      entrypoints: stableUnique(binding.entrypoints),
    };
    const plannedPaths = planLlmWikiRevisionPaths(normalizedBinding.entrypoints, requestedPaths);
    if (plannedPaths.length > LLM_WIKI_MAX_PAGES) {
      diagnostics.push(diagnostic(
        "context_budget_exceeded",
        severity,
        "Context Provider planned page budget exceeded",
        binding.providerId,
      ));
      blocked ||= binding.required;
      continue;
    }
    plans.push({
      provider: normalizedProvider,
      binding: normalizedBinding,
      paths: plannedPaths,
      providerConfigDigest: digest(providerDigestInput(normalizedProvider)),
      bindingDigest: digest(normalizedBinding),
    });
  }

  if (blocked) return { outcome: "blocked", plans: [], diagnostics };
  return { outcome: "ready", plans, diagnostics };
}
