import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:http";
import type { ToolDeclaration, ToolDeps, ToolInvocation, ToolMeta, ToolResult } from "@roll/spec";
import { networkInputSchema, networkOutputSchema } from "./schema-contracts.js";
import { resolveToolExecutionContext, toolCorrelation } from "./workspace-context.js";

export interface NetworkInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface NetworkOutput {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

const NETWORK_TOOL_ID = "network.fetch" as ToolDeclaration["id"];
const MAX_REDIRECTS = 5;

export class NetworkTool {
  readonly declaration: ToolDeclaration = {
    id: NETWORK_TOOL_ID,
    kind: "network",
    title: "Network Fetch",
    description: "Make governed HTTP requests through the Tool interface.",
    defaults: {
      enabled: true,
      timeoutMs: 30_000,
      retry: { attempts: 1, backoffMs: 0 },
      sandbox: {
        network: "restricted",
      },
    },
    inputSchema: networkInputSchema,
    outputSchema: networkOutputSchema,
  };

  async init(_deps: ToolDeps): Promise<void> {
    return undefined;
  }

  async dispose(_deps: ToolDeps): Promise<void> {
    return undefined;
  }

  async execute(invocation: ToolInvocation<NetworkInput>, deps: ToolDeps): Promise<ToolResult<NetworkOutput>> {
    const startedAt = deps.now();
    const scoped = resolveToolExecutionContext(invocation, "issue_required");
    if (!scoped.ok) {
      return failure(invocation, startedAt, deps.now(), scoped.error.code, scoped.error.message, false);
    }
    const effectiveInvocation = { ...invocation, context: scoped.context };
    const url = parseUrl(effectiveInvocation.input.url);
    if (url === undefined) return failure(effectiveInvocation, startedAt, deps.now(), "invalid_input", "invalid URL", false);

    if (effectiveInvocation.policy.sandbox?.network === "blocked") {
      return failure(effectiveInvocation, startedAt, deps.now(), "policy_denied", "network is blocked by policy", false);
    }
    if (!originAllowed(url, effectiveInvocation.policy.sandbox?.allowedOrigins)) {
      return failure(effectiveInvocation, startedAt, deps.now(), "policy_denied", `origin is outside allowedOrigins: ${url.origin}`, false);
    }

    const timeoutMs = effectiveInvocation.input.timeoutMs ?? effectiveInvocation.policy.timeoutMs ?? this.declaration.defaults?.timeoutMs ?? 30_000;
    const attempts = Math.max(1, effectiveInvocation.policy.retry?.attempts ?? this.declaration.defaults?.retry?.attempts ?? 1);
    const backoffMs = effectiveInvocation.policy.retry?.backoffMs ?? this.declaration.defaults?.retry?.backoffMs ?? 0;
    let lastFailure: ToolResult<never> | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const attemptStartedAt = deps.now();
      try {
        const output = await requestWithRedirects(url, effectiveInvocation.input, deps, timeoutMs, 0, attemptStartedAt);
        return {
          ok: true,
          output,
          meta: meta(effectiveInvocation, startedAt, deps.now(), attempt),
        };
      } catch (cause) {
        const endedAt = deps.now();
        const timeout = isTimeout(cause);
        lastFailure = failure(effectiveInvocation, startedAt, endedAt, timeout ? "timeout" : "adapter_error", timeout ? "network request timed out" : "network request failed", true, cause, attempt);
        if (attempt < attempts) await delay(backoffMs);
      }
    }

    return lastFailure ?? failure(effectiveInvocation, startedAt, deps.now(), "adapter_error", "network request failed", true);
  }
}

export function networkTools(): NetworkTool[] {
  return [new NetworkTool()];
}

function parseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function originAllowed(url: URL, allowedOrigins: readonly string[] | undefined): boolean {
  if (allowedOrigins === undefined || allowedOrigins.length === 0) return true;
  return allowedOrigins.some((allowed) => {
    if (allowed === url.origin || allowed === url.hostname) return true;
    const parsed = parseUrl(allowed);
    return parsed !== undefined && parsed.origin === url.origin;
  });
}

async function requestWithRedirects(
  url: URL,
  input: NetworkInput,
  deps: ToolDeps,
  timeoutMs: number,
  redirects: number,
  startedAt: number,
): Promise<NetworkOutput> {
  const response = await requestOnce(url, input, deps, timeoutMs, startedAt);
  const location = response.headers["location"];
  if (isRedirect(response.statusCode) && location !== undefined && redirects < MAX_REDIRECTS) {
    return requestWithRedirects(new URL(location, url), { ...input, url: new URL(location, url).toString() }, deps, timeoutMs, redirects + 1, startedAt);
  }
  return response;
}

function requestOnce(url: URL, input: NetworkInput, deps: ToolDeps, timeoutMs: number, startedAt: number): Promise<NetworkOutput> {
  return new Promise((resolve, reject) => {
    const proxy = proxyFor(url);
    const viaProxy = proxy !== undefined;
    const requestUrl = viaProxy ? proxy : url;
    const headers = redactHeaders(input.headers, deps);
    const body = input.body === undefined ? undefined : deps.redact(input.body);
    const options: RequestOptions = {
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      method: input.method ?? (body === undefined ? "GET" : "POST"),
      path: viaProxy ? url.toString() : `${url.pathname}${url.search}`,
      headers,
    };
    const transport = requestUrl.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: normalizeHeaders(res.headers),
          body: deps.redact(Buffer.concat(chunks).toString("utf8")),
          durationMs: Math.max(0, deps.now() - startedAt),
        });
      });
    });
    const timer = setTimeout(() => {
      const err = new Error("request timed out");
      err.name = "TimeoutError";
      req.destroy(err);
    }, timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function proxyFor(url: URL): URL | undefined {
  const value =
    url.protocol === "https:"
      ? process.env["HTTPS_PROXY"] ?? process.env["https_proxy"]
      : process.env["HTTP_PROXY"] ?? process.env["http_proxy"];
  if (value === undefined || value === "") return undefined;
  return parseUrl(value);
}

function redactHeaders(headers: Record<string, string> | undefined, deps: ToolDeps): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key] = deps.redact(value);
  return out;
}

function normalizeHeaders(headers: Record<string, string | string[] | number | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "TimeoutError";
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failure(
  invocation: ToolInvocation<NetworkInput>,
  startedAt: number,
  endedAt: number,
  code: "adapter_error" | "invalid_input" | "policy_denied" | "timeout" | "missing_execution_context" | "invalid_execution_context",
  message: string,
  retryable: boolean,
  detail?: unknown,
  attempt?: number,
): ToolResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      detail,
    },
    meta: meta(invocation, startedAt, endedAt, attempt),
  };
}

function meta(invocation: ToolInvocation<NetworkInput>, startedAt: number, endedAt: number, attempt?: number): ToolMeta {
  const correlation = toolCorrelation(invocation);
  return {
    invocationId: invocation.invocationId,
    toolId: invocation.toolId,
    caller: invocation.caller,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    attempt,
    ...(correlation === undefined ? {} : { correlation }),
  };
}
