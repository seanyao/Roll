/**
 * @responsibility Pins a Chrome DevTools MCP session for managed browser operations.
 */
/**
 * US-BROW-016 — pinned Chrome DevTools MCP session for managed browser
 * operations.
 *
 * Every managed run gets its own short-lived stdio MCP session. The session:
 *   1. Spawns the exact machine-approved `chrome-devtools-mcp` package pin.
 *   2. Completes MCP `initialize` and `tools/list`.
 *   3. Validates a versioned minimum tool manifest before any action.
 *   4. Serializes browser actions through the MCP boundary.
 *   5. Closes the session exactly once on success, denial, timeout,
 *      cancellation, or process error.
 *
 * No project-supplied command, args, endpoint, or environment override is
 * accepted. The production path never instantiates the raw WebSocket/CDP
 * adapter.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BrowserMcpFailureCategory, BrowserOperationEvent } from "@roll/spec";
import {
  DevToolsProtocolError,
  MANAGED_DEVTOOLS_PACKAGE,
  MANAGED_DEVTOOLS_PACKAGE_VERSION,
  MINIMUM_DEVTOOLS_MCP_MANIFEST,
  type DevToolsMcpManifest,
} from "@roll/core";
import type { CdpSession } from "./managed-chrome-adapter.js";
import {
  McpDiagnosticFacade,
  type DiagnosticArtifactWriter,
} from "./mcp-diagnostic-facade.js";

// ── Public types ─────────────────────────────────────────────────────────────

/** Events emitted by {@link McpBrowserSession}. */
export type McpBrowserSessionEvent =
  | Extract<BrowserOperationEvent, { type: "browser:mcp-started" }>
  | Extract<BrowserOperationEvent, { type: "browser:mcp-initialized" }>
  | Extract<BrowserOperationEvent, { type: "browser:mcp-closed" }>
  | Extract<BrowserOperationEvent, { type: "browser:mcp-failed" }>;

/** Process-group settings required for a managed MCP sidecar. */
export interface McpSpawnOptions {
  /** The npx wrapper must lead its own group so close can terminate its server child too. */
  detached: true;
}

/** Injectable spawn seam. The default refuses every project override. */
export type McpSpawn = (
  command: string,
  args: readonly string[],
  options: McpSpawnOptions,
) => ChildProcessWithoutNullStreams;

/**
 * Injectable process-control seam for managed MCP cleanup.
 *
 * FIX-1275: cleanup must be testable without spawning a real browser and must
 * distinguish "already-dead / macOS EPERM-on-a-redundant-kill" (harmless) from
 * "genuinely alive and unkillable" (an explicit failure). All process-group
 * signalling and the cleanup timing flow through this seam so tests can inject
 * a `kill` that throws `{ code: "EPERM" }` and drive every terminal path
 * deterministically.
 */
export interface ManagedProcessControl {
  /** Platform gate — mirrors `process.platform`; only non-win32 uses group signals. */
  platform: NodeJS.Platform;
  /** Signal (or probe, with signal 0) the process GROUP led by `pid` via `kill(-pid, signal)`. */
  killGroup(pid: number, signal: NodeJS.Signals | 0): void;
  /** Sleep between liveness polls. Defaults to a real timer. */
  sleep?(ms: number): Promise<void>;
  /** Grace period a SIGTERM'd group gets to exit before SIGKILL. Default 250ms. */
  sigtermGraceMs?: number;
  /** Settle window a SIGKILL'd group gets before the final liveness verdict. Default 100ms. */
  sigkillSettleMs?: number;
  /**
   * FIX-1434: bounded budget for retrying SIGKILL against a group that still
   * reads "alive" AFTER our direct MCP child has exited — reparented descendants
   * that the kernel has not finished reaping (a Linux reap-lag race, where
   * `kill(-pgid, 0)` on a zombie returns success rather than EPERM). Default 1500ms.
   */
  sigkillReapBudgetMs?: number;
  /** Liveness poll interval. Default 20ms. */
  pollIntervalMs?: number;
}

/** Dependencies for {@link McpBrowserSession}. */
export interface McpBrowserSessionDeps {
  runId: string;
  now: () => string;
  emit: (event: McpBrowserSessionEvent) => void;
  manifest?: DevToolsMcpManifest;
  spawn?: McpSpawn;
  /** FIX-1275: injectable process-control seam for cleanup; defaults to real `process.kill`. */
  processControl?: ManagedProcessControl;
}

/** Factory that creates an MCP-backed CDP session for a managed run. */
export interface McpBrowserSessionFactory {
  create(runId: string): Promise<CdpSession>;
}

/** The production typed-action MCP session returned to Browser Operations. */
export interface McpDiagnosticSession {
  facade: McpDiagnosticFacade;
  close(): Promise<void>;
}

export interface McpDiagnosticSessionFactoryOptions extends McpCdpTransportFactoryOptions {}

/** Opens a pinned MCP session and exposes only the typed diagnostic facade. */
export class McpDiagnosticSessionFactory {
  constructor(private readonly options: McpDiagnosticSessionFactoryOptions = {}) {}

  async create(runId: string, writer: DiagnosticArtifactWriter, randomId: () => string): Promise<McpDiagnosticSession> {
    const session = await McpBrowserSession.open({
      runId,
      now: this.options.now ?? (() => new Date().toISOString()),
      emit: this.options.emit ?? noopEmit,
      spawn: this.options.spawn,
      manifest: this.options.manifest,
      processControl: this.options.processControl,
    });
    return {
      facade: new McpDiagnosticFacade({
        caller: { call: (tool, input) => session.callTool(tool, input) },
        writer,
        randomId,
      }),
      close: () => session.close(),
    };
  }
}

/** Options for {@link McpCdpTransportFactory}. */
export interface McpCdpTransportFactoryOptions {
  now?: () => string;
  emit?: (event: McpBrowserSessionEvent) => void;
  spawn?: McpSpawn;
  manifest?: DevToolsMcpManifest;
  /** FIX-1275: injectable process-control seam for cleanup; defaults to real `process.kill`. */
  processControl?: ManagedProcessControl;
}

// ── McpBrowserSession ────────────────────────────────────────────────────────

/**
 * Owns the lifecycle of one pinned chrome-devtools-mcp stdio session.
 *
 * The process command and arguments are hardcoded; callers cannot supply their
 * own. The session fail-closes on initialize errors, manifest mismatches, and
 * process crashes.
 */
export class McpBrowserSession {
  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly rpc: McpJsonRpcClient,
    private readonly deps: Required<Pick<McpBrowserSessionDeps, "runId" | "now" | "emit" | "manifest">>,
    private readonly control: ManagedProcessControl,
  ) {}

  /** Spawn, initialize, and validate the MCP session. */
  static async open(deps: McpBrowserSessionDeps): Promise<McpBrowserSession> {
    const runId = deps.runId;
    const now = deps.now;
    const emit = deps.emit;
    const manifest = deps.manifest ?? MINIMUM_DEVTOOLS_MCP_MANIFEST;
    const doSpawn = deps.spawn ?? defaultMcpSpawn;
    const control = deps.processControl ?? defaultProcessControl;

    const command = "npx";
    // US-BROW-020 (live-gate finding): --isolated gives the server a temporary
    // Chrome profile that is deleted on close — without it the server reuses a
    // PERSISTENT profile, breaking the managed lane's "temp profile, no state
    // survives" promise. --headless lets the server-launched Chrome run on
    // GUI-less machines (the Chrome-capable CI lane has no display).
    const args: readonly string[] = [
      "-y",
      `${MANAGED_DEVTOOLS_PACKAGE}@${manifest.version}`,
      "--no-usage-statistics",
      "--isolated",
      "--headless",
    ];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = doSpawn(command, args, { detached: true });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      emit({ type: "browser:mcp-failed", runId, ts: now(), category: "crash", message: `spawn failed: ${message}` });
      throw new DevToolsProtocolError(`Failed to spawn managed DevTools MCP: ${message}`);
    }

    emit({ type: "browser:mcp-started", runId, ts: now() });

    const rpc = new McpJsonRpcClient(child);

    try {
      await rpc.initialized();
      const tools = await rpc.listTools();
      validateManifest(tools, manifest);
      emit({ type: "browser:mcp-initialized", runId, ts: now(), version: manifest.version, tools });
      return new McpBrowserSession(child, rpc, { runId, now, emit, manifest }, control);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const category = failureCategory(cause);
      emit({ type: "browser:mcp-failed", runId, ts: now(), category, message });
      try {
        await terminateMcpProcessTree(child, control);
      } catch (cleanupCause) {
        emit({ type: "browser:mcp-failed", runId, ts: now(), category: "crash", message: cleanupFailureMessage(cleanupCause) });
      }
      throw cause instanceof DevToolsProtocolError ? cause : new DevToolsProtocolError(message);
    }
  }

  /**
   * Call a CDP method through the MCP boundary.
   *
   * The method and parameters are forwarded to the required
   * `chrome_devtools_call` tool; the result is parsed from the tool's text
   * content.
   */
  async callTool(toolName: import("@roll/core").DevToolsMcpToolName | "chrome_devtools_call", input: Record<string, unknown>): Promise<unknown> {
    if (!this.deps.manifest.requiredTools.includes(toolName)) {
      throw new DevToolsProtocolError(`MCP tool is not approved by the manifest: ${toolName}`);
    }
    return parseToolResult(await this.rpc.callTool(toolName, input));
  }

  /** Close the session exactly once and emit the closed event. */
  async close(): Promise<void> {
    if (this.rpc.isClosed()) return;
    this.rpc.markClosed();
    try {
      await terminateMcpProcessTree(this.child, this.control);
    } catch (cause) {
      const message = cleanupFailureMessage(cause);
      this.deps.emit({ type: "browser:mcp-failed", runId: this.deps.runId, ts: this.deps.now(), category: "crash", message });
      throw new DevToolsProtocolError(message);
    }
    this.deps.emit({ type: "browser:mcp-closed", runId: this.deps.runId, ts: this.deps.now() });
  }
}

// ── MCP-backed CDP transport factory ─────────────────────────────────────────

/**
 * Production transport factory for the managed lane.
 *
 * Replaces the raw WebSocket/CDP factory with an MCP stdio session. The adapter
 * consumes the returned object through the same `CdpSession` interface, but the
 * underlying transport is the pinned MCP server.
 */
export class McpCdpTransportFactory implements McpBrowserSessionFactory {
  constructor(private readonly options: McpCdpTransportFactoryOptions = {}) {}

  async create(runId: string): Promise<CdpSession> {
    const session = await McpBrowserSession.open({
      runId,
      now: this.options.now ?? (() => new Date().toISOString()),
      emit: this.options.emit ?? noopEmit,
      spawn: this.options.spawn,
      manifest: this.options.manifest,
      processControl: this.options.processControl,
    });
    return new McpCdpSession(session);
  }
}

class McpCdpSession implements CdpSession {
  constructor(private readonly session: McpBrowserSession) {}

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.session.callTool("chrome_devtools_call", { method, params });
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

// ── JSON-RPC stdio client ────────────────────────────────────────────────────

interface McpJsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: unknown };
}

class McpJsonRpcClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.on("exit", () => this.rejectAll(new Error("MCP server exited")));
    child.on("error", (cause) => this.rejectAll(cause instanceof Error ? cause : new Error(String(cause))));
  }

  async initialized(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "roll", version: "4" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<string[]> {
    const result = (await this.request("tools/list", {})) as { tools?: unknown[] } | undefined;
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.map((tool) => (isRecord(tool) && typeof tool["name"] === "string" ? tool["name"] : "")).filter(Boolean);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  isClosed(): boolean {
    return this.closed;
  }

  markClosed(): void {
    this.closed = true;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new DevToolsProtocolError("MCP request after close"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: McpJsonRpcMessage): void {
    // MCP stdio transport is NEWLINE-DELIMITED JSON-RPC (one message per line),
    // not LSP-style Content-Length framing. chrome-devtools-mcp ignores framed
    // input's header line and replies with plain JSON lines — the previous
    // Content-Length framing made `initialize` hang forever (US-BROW-019 probe
    // caught this live; injected-spawn tests spoke the same wrong dialect on
    // both sides and never noticed).
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.closed) {
      const message = this.tryParseMessage();
      if (message === undefined) return;
      this.handleMessage(message);
    }
  }

  private tryParseMessage(): McpJsonRpcMessage | undefined {
    // Newline-delimited JSON-RPC: consume one \n-terminated line per message.
    // Non-JSON lines (server logs on stdout) are skipped, not fatal.
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return undefined;
      const line = this.buffer.slice(0, nl).toString("utf8").trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line === "") continue;
      try {
        return JSON.parse(line) as McpJsonRpcMessage;
      } catch {
        continue;
      }
    }
  }

  private handleMessage(message: McpJsonRpcMessage): void {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (pending === undefined) return;
    if (message.error !== undefined) {
      pending.reject(
        new DevToolsProtocolError(
          typeof message.error.message === "string" ? message.error.message : "MCP protocol error",
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(cause: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(cause);
    }
    this.pending.clear();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultMcpSpawn(
  command: string,
  args: readonly string[],
  options: McpSpawnOptions,
): ChildProcessWithoutNullStreams {
  if (command.trim() === "") {
    throw Object.assign(new Error("empty MCP command"), { code: "ENOENT" });
  }
  return spawn(command, args, {
    stdio: "pipe",
    env: process.env,
    detached: options.detached,
  }) as ChildProcessWithoutNullStreams;
}

function validateManifest(tools: string[], manifest: DevToolsMcpManifest): void {
  const missing = manifest.requiredTools.filter((required) => !tools.includes(required));
  if (missing.length > 0) {
    throw new DevToolsProtocolError(
      `MCP tool manifest mismatch for ${MANAGED_DEVTOOLS_PACKAGE}@${manifest.version}: missing ${missing.join(", ")}`,
    );
  }
}

function parseToolResult(raw: unknown): unknown {
  if (!isRecord(raw)) return undefined;
  const content = Array.isArray(raw["content"]) ? raw["content"] : [];
  const text = content
    .filter((item): item is Record<string, unknown> => isRecord(item) && item["type"] === "text")
    .map((item) => item["text"])
    .find((value): value is string => typeof value === "string");
  // US-BROW-020: the real server returns screenshots as a separate
  // `{type:"image", data:<base64>}` content item next to the prose text item —
  // text-only parsing dropped the bytes and every live screenshot failed.
  const image = content.find(
    (item): item is Record<string, unknown> => isRecord(item) && item["type"] === "image" && typeof item["data"] === "string",
  );
  if (image !== undefined) {
    return { text: text ?? "", data: image["data"], mimeType: image["mimeType"] };
  }
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function failureCategory(cause: unknown): BrowserMcpFailureCategory {
  if (cause instanceof DevToolsProtocolError) return "devtools-error";
  if (cause instanceof Error && /timed?\s*out/i.test(cause.message)) return "timeout";
  return "crash";
}

/**
 * Explicit cleanup failure for a managed MCP process that is genuinely still
 * alive and could not be terminated. Distinct from the harmless
 * already-dead / EPERM-on-a-redundant-kill paths, which resolve successfully.
 */
export class McpProcessCleanupError extends Error {
  readonly code = "mcp_process_cleanup_failed" as const;
  constructor(
    message: string,
    readonly diagnostics: { pid: number; groupState: GroupLiveness; childExited: boolean },
  ) {
    super(message);
    this.name = "McpProcessCleanupError";
  }
}

/** Liveness verdict for a managed process group. */
type GroupLiveness =
  /** `kill(-pgid, 0)` returned ESRCH — the group is gone. */
  | "dead"
  /** `kill(-pgid, 0)` succeeded — at least one signalable member is alive. */
  | "alive"
  /**
   * `kill(-pgid, 0)` was rejected with EPERM — the group cannot be signalled.
   * On macOS this is what a redundant kill against an already-dead / zombie
   * group returns; it does NOT prove a live server is leaking.
   */
  | "uncertain";

const defaultProcessControl: ManagedProcessControl = {
  platform: process.platform,
  killGroup: (pid, signal) => {
    process.kill(-pid, signal);
  },
};

function controlSleep(control: ManagedProcessControl): (ms: number) => Promise<void> {
  return control.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

async function terminateMcpProcessTree(
  child: ChildProcessWithoutNullStreams,
  control: ManagedProcessControl,
): Promise<void> {
  const pid = child.pid;
  if (pid !== undefined && control.platform !== "win32") {
    await terminateProcessGroup(control, child, pid);
    return;
  }
  await terminateChild(child);
}

/**
 * FIX-1275: bounded, idempotent process-group termination that stays honest
 * about the outcome.
 *
 * - Already-dead group (ESRCH) → success, nothing to do.
 * - Our direct MCP child has exited and the group only answers EPERM → success:
 *   the child is gone and macOS is merely refusing a redundant kill against a
 *   dead / zombie group; a best-effort group SIGKILL reaps any lingering
 *   descendant.
 * - A genuinely alive group that survives SIGKILL, or an EPERM group while our
 *   MCP child is STILL running, → explicit {@link McpProcessCleanupError} with
 *   actionable diagnostics. Arbitrary (non-ESRCH/EPERM) errors are never
 *   swallowed; they surface as cleanup failures too.
 */
async function terminateProcessGroup(
  control: ManagedProcessControl,
  child: ChildProcessWithoutNullStreams,
  pid: number,
): Promise<void> {
  const initial = probeGroup(control, pid);
  if (initial === "dead") return;
  if (initial === "uncertain" && child.exitCode !== null) {
    // EPERM-on-dead: our direct child already exited and the group refuses a
    // redundant kill. Attempt a best-effort SIGKILL to reap any descendant,
    // ignore the redundant-kill rejection, and accept — nothing we own is alive.
    signalGroupBestEffort(control, pid, "SIGKILL");
    return;
  }

  const sigtermGraceMs = control.sigtermGraceMs ?? 250;
  const sigkillSettleMs = control.sigkillSettleMs ?? 100;

  signalGroupBestEffort(control, pid, "SIGTERM");
  if (await waitForGroupDead(control, pid, sigtermGraceMs)) return;

  signalGroupBestEffort(control, pid, "SIGKILL");
  if (await waitForGroupDead(control, pid, sigkillSettleMs)) return;

  let finalState = probeGroup(control, pid);
  if (finalState === "dead") return;
  // Our direct child has exited; residual EPERM is a dead/zombie group we cannot
  // (and need not) signal. Not a leak.
  if (finalState === "uncertain" && child.exitCode !== null) return;

  // FIX-1434: on Linux, `kill(-pgid, 0)` against a just-exited-but-not-yet-reaped
  // descendant returns success ("alive"), not EPERM — so the EPERM leniency above
  // never triggers there, and a transient reap-lag under CI load spuriously trips
  // the leak gate. When our direct MCP child has already exited, an "alive" group
  // is almost always reparented descendants pending reap: give it a bounded,
  // re-signalling budget before the final verdict. A group that outlives the whole
  // budget still fails loud, and a group that is alive while our MCP child is STILL
  // running remains an immediate, unchanged leak failure.
  if (finalState === "alive" && child.exitCode !== null) {
    const reapBudgetMs = control.sigkillReapBudgetMs ?? 1500;
    const sliceMs = Math.max(sigkillSettleMs, 50);
    const rounds = Math.max(1, Math.ceil(reapBudgetMs / sliceMs));
    for (let round = 0; round < rounds; round += 1) {
      signalGroupBestEffort(control, pid, "SIGKILL");
      if (await waitForGroupDead(control, pid, sliceMs)) return;
    }
    finalState = probeGroup(control, pid);
    if (finalState === "dead") return;
    // Reaped into a zombie/EPERM state — the descendants are gone, not a leak.
    if (finalState === "uncertain") return;
  }

  throw new McpProcessCleanupError(describeUnkillableGroup(pid, finalState, child.exitCode !== null), {
    pid,
    groupState: finalState,
    childExited: child.exitCode !== null,
  });
}

function describeUnkillableGroup(pid: number, state: GroupLiveness, childExited: boolean): string {
  if (state === "alive") {
    return `managed MCP process group ${pid} is still alive after SIGTERM and SIGKILL`;
  }
  // state === "uncertain" while the MCP child is still running.
  return (
    `managed MCP process group ${pid} could not be confirmed terminated ` +
    `(kill returned EPERM while the MCP child is still running${childExited ? "" : ", child not exited"})`
  );
}

function probeGroup(control: ManagedProcessControl, pid: number): GroupLiveness {
  try {
    control.killGroup(pid, 0);
    return "alive";
  } catch (cause) {
    if (hasCode(cause, "ESRCH")) return "dead";
    if (hasCode(cause, "EPERM")) return "uncertain";
    // Never swallow an unexpected error class — surface it as a cleanup failure.
    throw cause;
  }
}

function signalGroupBestEffort(control: ManagedProcessControl, pid: number, signal: NodeJS.Signals): void {
  try {
    control.killGroup(pid, signal);
  } catch (cause) {
    // ESRCH: the group is already gone. EPERM: macOS refusing a redundant kill
    // against an already-dead / zombie member. Neither is a cleanup failure —
    // liveness is judged afterwards by probeGroup. Any other error surfaces.
    if (hasCode(cause, "ESRCH") || hasCode(cause, "EPERM")) return;
    throw cause;
  }
}

async function waitForGroupDead(control: ManagedProcessControl, pid: number, timeoutMs: number): Promise<boolean> {
  const sleep = controlSleep(control);
  const pollIntervalMs = control.pollIntervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probeGroup(control, pid) === "dead") return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  if (!child.kill("SIGTERM")) throw new Error("SIGTERM was not delivered to MCP process");
  if (await waitForChildExit(child)) return;
  if (!child.kill("SIGKILL")) throw new Error("SIGKILL was not delivered to MCP process");
  if (await waitForChildExit(child)) return;
  throw new Error("MCP process survived SIGKILL");
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode !== null), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function cleanupFailureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `MCP process cleanup failed: ${detail}`;
}

function hasCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noopEmit(_event: McpBrowserSessionEvent): void {
  /* default: events are dropped when no ledger is wired */
}
