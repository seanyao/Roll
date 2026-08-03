import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { BrowserOperationLedger, BrowserTransportRegistry, isReservedBrowserTransport } from "@roll/core";
import type {
  BrowserOperationEvent,
  ToolDeclaration,
  ToolDeps,
  ToolInvocation,
  ToolMeta,
  ToolResult,
  WorkspaceExecutionContextV1,
} from "@roll/spec";
import { mcpInputSchema, mcpOutputSchema } from "./schema-contracts.js";
import { resolveToolExecutionContext, toolCorrelation } from "./workspace-context.js";

export interface McpInput {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface McpOutput {
  content: Array<{ type: string; text?: string }>;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpConnection {
  callTool(toolName: string, args: Record<string, unknown>): Promise<McpOutput>;
  close(): Promise<void>;
}

export interface McpToolOptions {
  projectRoot?: string;
  connect?: (config: McpServerConfig) => Promise<McpConnection>;
  /** Browser Operations owns the reserved DevTools identity, never generic MCP. */
  browserTransportRegistry?: BrowserTransportRegistry;
  /** Caller-owned durable event writer for security-boundary denials. */
  recordBrowserEvent?: (event: BrowserMcpBypassDeniedEvent) => void;
}

type BrowserMcpBypassDeniedEvent = Extract<BrowserOperationEvent, { type: "browser:mcp-bypass-denied" }>;

const MCP_TOOL_ID = "mcp.call" as ToolDeclaration["id"];

export class McpTool {
  readonly declaration: ToolDeclaration = {
    id: MCP_TOOL_ID,
    kind: "mcp",
    title: "MCP Call",
    description: "Call external MCP server tools through the governed Tool interface.",
    defaults: {
      enabled: true,
      timeoutMs: 30_000,
      sandbox: {
        network: "restricted",
      },
    },
    inputSchema: mcpInputSchema,
    outputSchema: mcpOutputSchema,
  };

  private readonly projectRoot: string | undefined;
  private readonly connect: (config: McpServerConfig) => Promise<McpConnection>;
  private readonly browserTransportRegistry: BrowserTransportRegistry;
  private readonly recordBrowserEvent: ((event: BrowserMcpBypassDeniedEvent) => void) | undefined;
  private readonly connections = new Map<string, Promise<McpConnection>>();

  constructor(options: McpToolOptions = {}) {
    this.projectRoot = options.projectRoot;
    this.connect = options.connect ?? defaultConnect;
    this.browserTransportRegistry = options.browserTransportRegistry ?? new BrowserTransportRegistry();
    this.recordBrowserEvent = options.recordBrowserEvent;
  }

  async init(_deps: ToolDeps): Promise<void> {
    return undefined;
  }

  async dispose(_deps: ToolDeps): Promise<void> {
    const connections = await Promise.allSettled(this.connections.values());
    this.connections.clear();
    await Promise.all(connections.map((entry) => (entry.status === "fulfilled" ? entry.value.close() : Promise.resolve())));
  }

  async execute(invocation: ToolInvocation<McpInput>, deps: ToolDeps): Promise<ToolResult<McpOutput>> {
    const startedAt = deps.now();
    const scoped = resolveToolExecutionContext(invocation, "issue_required");
    if (!scoped.ok) {
      return failure(invocation, startedAt, deps.now(), scoped.error.code, scoped.error.message, false);
    }
    const effectiveInvocation = { ...invocation, context: scoped.context };
    if (!effectiveInvocation.policy.enabled) {
      return failure(effectiveInvocation, startedAt, deps.now(), "policy_denied", "MCP tool is disabled by policy", false);
    }

    const validation = validateInput(effectiveInvocation.input);
    if (validation !== undefined) {
      return failure(effectiveInvocation, startedAt, deps.now(), "invalid_input", validation, false);
    }

    if (isReservedBrowserTransport(effectiveInvocation.input.serverName)) {
      const event = this.browserTransportRegistry.denyGenericMcp(effectiveInvocation.input.serverName, new Date(deps.now()).toISOString());
      if (this.recordBrowserEvent !== undefined) this.recordBrowserEvent(event);
      else new BrowserOperationLedger().recordMcpBypassDenial(
        join(scoped.context.authorities.events, "browser-operations.ndjson"),
        event,
      );
      return failure(effectiveInvocation, startedAt, deps.now(), "policy_denied", event.reason.message, false, event.reason.detail);
    }

    const servers = await readServers(scoped.context.authorities.policy, this.projectRoot, deps);
    const config = servers[effectiveInvocation.input.serverName];
    if (config === undefined) {
      return failure(effectiveInvocation, startedAt, deps.now(), "adapter_error", `MCP server not configured: ${effectiveInvocation.input.serverName}`, false);
    }

    try {
      const connection = await this.connectionFor(
        effectiveInvocation.input.serverName,
        config,
        scoped.context,
        effectiveInvocation.repoId,
      );
      const args = redactArgs(effectiveInvocation.input.arguments ?? {}, deps);
      const output = normalizeOutput(await connection.callTool(effectiveInvocation.input.toolName, args));
      return {
        ok: true,
        output,
        meta: meta(effectiveInvocation, startedAt, deps.now()),
      };
    } catch (cause) {
      const unavailable = classifyUnavailable(cause);
      return failure(effectiveInvocation, startedAt, deps.now(), "adapter_error", unavailable, true, cause);
    }
  }

  private connectionFor(
    serverName: string,
    config: McpServerConfig,
    context: WorkspaceExecutionContextV1,
    repoId: string | undefined,
  ): Promise<McpConnection> {
    const cacheKey = mcpConnectionCacheKey(serverName, config, context, repoId);
    const existing = this.connections.get(cacheKey);
    if (existing !== undefined) return existing;
    const pending = this.connect(config).catch((cause) => {
      this.connections.delete(cacheKey);
      throw cause;
    });
    this.connections.set(cacheKey, pending);
    return pending;
  }
}

function mcpConnectionCacheKey(
  serverName: string,
  config: McpServerConfig,
  context: WorkspaceExecutionContextV1,
  repoId: string | undefined,
): string {
  return JSON.stringify({
    workspaceId: context.workspace.workspaceId,
    storyId: context.issue?.storyId,
    repoId,
    serverName,
    config: {
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd,
      env: Object.entries(config.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    },
  });
}

export function mcpTools(projectRoot?: string): McpTool[] {
  return [new McpTool(projectRoot === undefined ? {} : { projectRoot })];
}

function validateInput(input: McpInput): string | undefined {
  if (typeof input.serverName !== "string" || input.serverName.trim() === "") return "serverName is required";
  if (typeof input.toolName !== "string" || input.toolName.trim() === "") return "toolName is required";
  if (input.arguments !== undefined && !isRecord(input.arguments)) return "arguments must be a record";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactArgs(args: Record<string, unknown>, deps: ToolDeps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = redactValue(value, deps);
  return out;
}

function redactValue(value: unknown, deps: ToolDeps): unknown {
  if (typeof value === "string") return deps.redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, deps));
  if (isRecord(value)) return redactArgs(value, deps);
  return value;
}

function normalizeOutput(value: McpOutput): McpOutput {
  return {
    content: Array.isArray(value.content)
      ? value.content.map((item) => ({
          type: String(item.type),
          ...(item.text !== undefined ? { text: String(item.text) } : {}),
        }))
      : [],
  };
}

async function readServers(
  workspacePolicyPath: string,
  machineConfigRoot: string | undefined,
  deps: ToolDeps,
): Promise<Record<string, McpServerConfig>> {
  const workspacePolicy = await readOptional(deps, workspacePolicyPath);
  const workspaceServers = workspacePolicy === undefined ? {} : parsePolicyServers(workspacePolicy);
  if (Object.keys(workspaceServers).length > 0) return workspaceServers;
  if (machineConfigRoot === undefined) return {};
  const json = await readOptional(deps, join(machineConfigRoot, ".roll", "mcp-servers.json"));
  if (json !== undefined) return parseJsonServers(json);
  const machinePolicy = await readOptional(deps, join(machineConfigRoot, ".roll", "policy.yaml"));
  return machinePolicy === undefined ? {} : parsePolicyServers(machinePolicy);
}

async function readOptional(deps: ToolDeps, path: string): Promise<string | undefined> {
  try {
    return await deps.fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function parseJsonServers(text: string): Record<string, McpServerConfig> {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || !isRecord(value["servers"])) return {};
    return parseServerMap(value["servers"]);
  } catch {
    return {};
  }
}

function parseServerMap(value: Record<string, unknown>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(value)) {
    const server = parseServer(raw);
    if (server !== undefined) out[name] = server;
  }
  return out;
}

function parseServer(raw: unknown): McpServerConfig | undefined {
  if (!isRecord(raw) || typeof raw["command"] !== "string" || raw["command"].trim() === "") return undefined;
  return {
    command: raw["command"],
    args: parseStringArray(raw["args"]),
    cwd: typeof raw["cwd"] === "string" ? raw["cwd"] : undefined,
    env: parseStringRecord(raw["env"]),
  };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item));
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) out[key] = String(item);
  return out;
}

interface Line {
  indent: number;
  text: string;
}

function parsePolicyServers(text: string): Record<string, McpServerConfig> {
  const lines = yamlLines(text);
  const tools = nestedBlock(lines, 0, "tools");
  const mcp = nestedBlock(tools, 2, "mcp");
  const servers = nestedBlock(mcp, 4, "servers");
  const out: Record<string, McpServerConfig> = {};

  for (const line of servers) {
    if (line.indent !== 6 || !line.text.endsWith(":")) continue;
    const name = line.text.slice(0, -1).trim();
    const block = blockAfter(servers, line);
    const fieldMap = fields(block, 8);
    const command = fieldMap.get("command");
    if (command === undefined || command === "") continue;
    out[name] = {
      command,
      args: parseInlineList(fieldMap.get("args")),
      cwd: fieldMap.get("cwd"),
      env: undefined,
    };
  }

  return out;
}

function yamlLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const noComment = line.replace(/\s+#.*$/, "");
    if (noComment.trim() === "") continue;
    out.push({ indent: noComment.length - noComment.trimStart().length, text: noComment.trim() });
  }
  return out;
}

function nestedBlock(lines: readonly Line[], indent: number, key: string): Line[] {
  const head = lines.find((line) => line.indent === indent && line.text === `${key}:`);
  return head === undefined ? [] : blockAfter(lines, head);
}

function blockAfter(lines: readonly Line[], head: Line): Line[] {
  const index = lines.indexOf(head);
  const out: Line[] = [];
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.indent <= head.indent) break;
    out.push(line);
  }
  return out;
}

function fields(lines: readonly Line[], indent: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    if (line.indent !== indent) continue;
    const idx = line.text.indexOf(":");
    if (idx < 0) continue;
    const key = line.text.slice(0, idx).trim();
    const value = line.text.slice(idx + 1).trim();
    out.set(key, unquote(value));
  }
  return out;
}

function parseInlineList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [unquote(trimmed)];
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((item) => unquote(item.trim()));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function classifyUnavailable(cause: unknown): string {
  if (isNodeCode(cause, "ENOENT")) return "BINARY_NOT_FOUND: MCP transport binary was not found";
  return "NETWORK_UNAVAILABLE: MCP server connection failed";
}

function isNodeCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: unknown }).code === code;
}

function failure(
  invocation: ToolInvocation<McpInput>,
  startedAt: number,
  endedAt: number,
  code: "policy_denied" | "invalid_input" | "adapter_error" | "missing_execution_context" | "invalid_execution_context",
  message: string,
  retryable: boolean,
  detail?: unknown,
): ToolResult<never> {
  return {
    ok: false,
    error: { code, message, retryable, detail },
    meta: meta(invocation, startedAt, endedAt),
  };
}

function meta(invocation: ToolInvocation<McpInput>, startedAt: number, endedAt: number): ToolMeta {
  const correlation = toolCorrelation(invocation);
  return {
    invocationId: invocation.invocationId,
    toolId: invocation.toolId,
    caller: invocation.caller,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    ...(correlation === undefined ? {} : { correlation }),
  };
}

async function defaultConnect(config: McpServerConfig): Promise<McpConnection> {
  if (config.command.trim() === "") throw Object.assign(new Error("empty MCP command"), { code: "ENOENT" });
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: config.env === undefined ? process.env : { ...process.env, ...config.env },
    stdio: "pipe",
  });
  return StdioMcpConnection.open(child);
}

class StdioMcpConnection implements McpConnection {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(cause: unknown): void }>();

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.on("exit", () => this.rejectAll(new Error("MCP server exited")));
  }

  static async open(child: ChildProcessWithoutNullStreams): Promise<StdioMcpConnection> {
    await new Promise<void>((resolve, reject) => {
      const onError = (cause: Error): void => {
        child.off("spawn", onSpawn);
        reject(cause);
      };
      const onSpawn = (): void => {
        child.off("error", onError);
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    const connection = new StdioMcpConnection(child);
    await connection.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "roll", version: "3" },
    });
    connection.notify("notifications/initialized", {});
    return connection;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpOutput> {
    const result = await this.request("tools/call", { name: toolName, arguments: args });
    if (!isRecord(result)) return { content: [] };
    const content = Array.isArray(result["content"]) ? result["content"] : [];
    return normalizeOutput({ content: content as McpOutput["content"] });
  }

  async close(): Promise<void> {
    if (!this.child.killed) this.child.kill();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(message);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const parsed = this.tryParseMessage();
      if (parsed === undefined) return;
      this.handleMessage(parsed);
    }
  }

  private tryParseMessage(): unknown | undefined {
    const sep = this.buffer.indexOf("\r\n\r\n");
    if (sep < 0) return undefined;
    const header = this.buffer.slice(0, sep).toString("utf8");
    const length = /^Content-Length:\s*(\d+)$/im.exec(header)?.[1];
    if (length === undefined) return undefined;
    const bodyLength = Number.parseInt(length, 10);
    const start = sep + 4;
    if (this.buffer.length < start + bodyLength) return undefined;
    const body = this.buffer.slice(start, start + bodyLength);
    this.buffer = this.buffer.slice(start + bodyLength);
    return JSON.parse(body.toString("utf8")) as unknown;
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message) || typeof message["id"] !== "number") return;
    const pending = this.pending.get(message["id"]);
    if (pending === undefined) return;
    this.pending.delete(message["id"]);
    if (message["error"] !== undefined) pending.reject(message["error"]);
    else pending.resolve(message["result"]);
  }

  private rejectAll(cause: unknown): void {
    for (const pending of this.pending.values()) pending.reject(cause);
    this.pending.clear();
  }
}
