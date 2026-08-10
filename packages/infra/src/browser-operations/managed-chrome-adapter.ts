/**
 * @responsibility Adapts managed Chrome and DevTools sessions.
 */
/**
 * US-BROW-004b — Managed Chrome/DevTools adapter.
 *
 * Runs approved typed actions in an isolated temporary Chrome profile, observes
 * the final redirect URL before any content capture, and denies operations that
 * land outside the policy allowlist. Timeout / crash / DevTools errors become
 * categorized diagnostic failures; they can never be expressed as passing
 * product assertions.
 *
 * The adapter consumes the US-BROW-004a run service for lifecycle/state and the
 * US-BROW-002 managed DevTools transport seam for the CDP connection.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeOrigin,
  authorizePerformanceProfile,
  BrowserOperationLedger,
  BrowserOperationRunService,
  DevToolsProtocolError,
  degradedPerformanceSummary,
  persistDiagnostic,
  policyFingerprint,
  redactDiagnostic,
  resolveDeviceProfile,
  summarizePerformanceMetrics,
  type DiagnosticFailure,
} from "@roll/core";
import type {
  BrowserActionKind,
  BrowserActionResult,
  BrowserDenialReason,
  BrowserLanePolicy,
  DeviceProfile,
  DiagnosticArtifactKind,
  DiagnosticArtifactRef,
  NormalizedOrigin,
  PerformanceDiagnosticSummary,
  PerformanceProfile,
} from "@roll/spec";
import { McpCdpTransportFactory, McpDiagnosticSessionFactory, type McpBrowserSessionFactory, type McpDiagnosticSession } from "./mcp-session.js";
import type { DiagnosticArtifactWriter } from "./mcp-diagnostic-facade.js";

// ── Public types ─────────────────────────────────────────────────────────────

/** A running Chrome process returned by a launcher. */
export interface ChromeProcess {
  pid: number;
  kill(): Promise<void>;
}

export interface ChromeLaunchOptions {
  profileDir: string;
  remoteDebuggingPort: number;
  /** Default managed diagnostics remain headless; physical capture opts in explicitly. */
  visibility?: "headless" | "visible";
  /** Only used for a visible, isolated capture window. */
  initialUrl?: string;
}

/** Launches a Chrome instance bound to a temporary profile and debug port. */
export interface ChromeLauncher {
  launch(options: ChromeLaunchOptions): Promise<ChromeProcess>;
}

/** A single CDP session. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Factory that creates a CDP session for a loopback debug endpoint. */
export interface CdpTransportFactory {
  create(endpoint: { host: string; port: number }): Promise<CdpSession>;
}

/** File-system seam used by the adapter. */
export interface AdapterFs {
  mkdtemp(prefix: string): Promise<string>;
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  writeFile(path: string, data: string | Buffer, encoding?: BufferEncoding): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

/** Injectable dependencies for {@link ManagedChromeAdapter}. */
export interface ManagedChromeAdapterDeps {
  launcher: ChromeLauncher;
  /**
   * MCP transport factory for production managed runs (US-BROW-016).
   *
   * Exactly one of {@link mcpSessionFactory} or {@link transportFactory} must be
   * supplied. Production wiring uses the MCP factory; the CDP factory remains
   * available only as a test-injection seam.
   */
  mcpSessionFactory?: McpBrowserSessionFactory;
  /** Production typed MCP facade. Raw CDP is retained only as a test seam. */
  mcpDiagnosticSessionFactory?: McpDiagnosticSessionFactory;
  /**
   * Raw CDP transport factory — test-injection seam only.
   *
   * Fake CDP sessions are permissible in tests, but no CLI/runtime wiring may
   * reach the raw WebSocket/CDP adapter.
   */
  transportFactory?: CdpTransportFactory;
  fs: AdapterFs;
  now: () => string;
  randomId: () => string;
  remoteDebuggingHost: string;
  diagnosticsDir: string;
}

/** Input to execute one typed action inside a managed run. */
export interface ManagedRunInput {
  runService: BrowserOperationRunService;
  lanePolicy: BrowserLanePolicy;
  action: BrowserActionKind;
  payload: Record<string, string | number | boolean>;
  timeoutMs: number;
  /** Optional device emulation profile name (managed lane only, diagnostic-only). */
  deviceProfile?: string;
  /** Optional performance diagnostic profile name (managed lane only, opt-in, diagnostic-only). */
  performanceProfile?: string;
}

/** Outcome of a best-effort performance diagnostic profile collection. */
export interface PerformanceProfileOutcome {
  /** The bounded, redacted summary (present unless the profile was denied). */
  summary?: PerformanceDiagnosticSummary;
  /** Structured denial when policy disabled the profile or the name was unknown. */
  denial?: BrowserDenialReason;
  /** The persisted diagnostic-only artifact ref, when a summary was collected. */
  ref?: DiagnosticArtifactRef;
}

// ── Default production seams ─────────────────────────────────────────────────

/** Default Chrome launcher for macOS / Linux. */
export class SystemChromeLauncher implements ChromeLauncher {
  constructor(private readonly chromeExecutable: string = defaultChromeExecutable()) {}

  async launch(options: ChromeLaunchOptions): Promise<ChromeProcess> {
    const { spawn } = await import("node:child_process");
    const args = chromeLaunchArgs(options);
    const child = spawn(this.chromeExecutable, args, { detached: false });
    if (child.pid === undefined) {
      throw new Error(`Failed to spawn Chrome from ${this.chromeExecutable}`);
    }
    return {
      pid: child.pid,
      kill: async () => {
        child.kill("SIGTERM");
        // Best-effort graceful shutdown; do not await indefinitely.
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5_000);
          child.on("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });
      },
    };
  }
}

/**
 * Chrome arguments are deterministic so the controlled-capture path can prove
 * that it never inherits the owner's profile or enables extensions.
 */
export function chromeLaunchArgs(options: ChromeLaunchOptions): string[] {
  const visible = options.visibility === "visible";
  return [
    `--user-data-dir=${options.profileDir}`,
    `--remote-debugging-port=${options.remoteDebuggingPort}`,
    ...(visible ? [] : ["--headless=new"]),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-popup-blocking",
    "--disable-features=Translate",
    visible ? `--app=${options.initialUrl ?? "about:blank"}` : "about:blank",
  ];
}

function defaultChromeExecutable(): string {
  const { platform } = process;
  if (platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (platform === "win32") return "chrome.exe";
  return "google-chrome";
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/** Error thrown when the final origin is not in the allowlist. */
class OriginDenialError extends Error {
  constructor(readonly reason: BrowserDenialReason) {
    super(reason.message);
  }
}

/** Creates default production dependencies for {@link ManagedChromeAdapter}. */
export function defaultManagedChromeAdapterDeps(diagnosticsDir: string): ManagedChromeAdapterDeps {
  return {
    launcher: new SystemChromeLauncher(),
    mcpDiagnosticSessionFactory: new McpDiagnosticSessionFactory({
      emit: defaultMcpEventEmitter(),
    }),
    fs: nodeAdapterFs(),
    now: () => new Date().toISOString(),
    randomId: () => randomUUID(),
    remoteDebuggingHost: "127.0.0.1",
    diagnosticsDir,
  };
}

function defaultMcpEventEmitter(): (event: import("./mcp-session.js").McpBrowserSessionEvent) => void {
  const ledger = new BrowserOperationLedger();
  const path = join(process.cwd(), ".roll", "browser-operations", "events.ndjson");
  return (event) => ledger.recordBrowserEvent(path, event);
}

function nodeAdapterFs(): AdapterFs {
  return {
    mkdtemp: (prefix) => mkdtemp(prefix),
    mkdir: (path, options) => mkdir(path, options),
    writeFile: (path, data, encoding) => writeFile(path, data, encoding),
    rm: (path, options) => rm(path, options),
  };
}

/**
 * Managed Chrome adapter: runs approved typed actions in a temporary profile
 * and enforces origin policy before any content capture.
 */
export class ManagedChromeAdapter {
  constructor(private readonly deps: ManagedChromeAdapterDeps) {}

  /** Execute one typed action and return the action-level result plus the terminal run service. */
  async execute(input: ManagedRunInput): Promise<{
    result: BrowserActionResult;
    service: BrowserOperationRunService;
    /** Present only when a performance diagnostic profile was requested (US-BROW-012). */
    performance?: PerformanceProfileOutcome;
  }> {
    const { runService, lanePolicy, action, payload, timeoutMs } = input;
    const fingerprint = policyFingerprint(lanePolicy);
    let service = runService.authorize(fingerprint);

    if (!lanePolicy.allowedActions.includes(action)) {
      service = service.deny();
      return {
        service,
        result: actionResult(service.run.runId, "denied", [], `Action "${action}" denied by lane policy`),
      };
    }

    service = service.start();

    let profileDir: string | undefined;
    let chrome: ChromeProcess | undefined;
    let cdp: CdpSession | undefined;
    let diagnosticSession: McpDiagnosticSession | undefined;
    let terminalService: BrowserOperationRunService = service;
    let actionResultValue: BrowserActionResult;
    let performance: PerformanceProfileOutcome | undefined;

    try {
      profileDir = await this.deps.fs.mkdtemp(join(tmpdir(), "roll-managed-chrome-"));
      service = service.activateProfile();

      const remoteDebuggingPort = await this.allocateDebugPort();
      chrome = await this.deps.launcher.launch({ profileDir, remoteDebuggingPort });

      if (this.deps.mcpDiagnosticSessionFactory !== undefined) {
        diagnosticSession = await this.withTimeout(
          this.deps.mcpDiagnosticSessionFactory.create(service.run.runId, this.diagnosticWriter(), this.deps.randomId),
          timeoutMs,
          "DevTools MCP session",
        );
        actionResultValue = await this.withTimeout(
          this.runFacadeAction(diagnosticSession, action, payload, lanePolicy, service.run.requestedOrigin),
          timeoutMs,
          `action ${action}`,
        );
        terminalService = service.pass();
        await diagnosticSession.close();
        diagnosticSession = undefined;
        await this.kill(chrome);
        chrome = undefined;
        terminalService = await this.cleanupProfile(profileDir, terminalService);
        profileDir = undefined;
        return { service: terminalService, result: actionResultValue };
      }

      cdp = await this.withTimeout(this.createSession(service.run.runId), timeoutMs, "DevTools session");

      // Enable the domains the typed actions need.
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");

      // Device emulation (US-BROW-014): apply profile before any page action.
      if (input.deviceProfile !== undefined) {
        const resolved = resolveDeviceProfile(input.deviceProfile);
        if ("code" in resolved) {
          throw new DevToolsError(resolved.message);
        }
        await this.emulateDevice(cdp, resolved);
      }

      actionResultValue = await this.withTimeout(
        this.runTypedAction({ cdp, action, payload, lanePolicy }),
        timeoutMs,
        `action ${action}`,
      );

      // Performance diagnostic profile (US-BROW-012): opt-in, policy-gated and
      // strictly best-effort. It runs AFTER the action and can never change the
      // action verdict — a denied or failed profile leaves navigation/Capture
      // outcomes exactly as they were without it (AC4).
      if (input.performanceProfile !== undefined) {
        performance = await this.runPerformanceProfile(cdp, input.performanceProfile, lanePolicy);
        if (performance.ref !== undefined) {
          actionResultValue = {
            ...actionResultValue,
            diagnosticRefs: [...actionResultValue.diagnosticRefs, performance.ref],
          };
        }
      }

      terminalService = service.pass();
    } catch (error) {
      terminalService = this.finalizeFromError(service, error);
      actionResultValue = actionResult(
        terminalService.run.runId,
        this.actionStatusFromError(error),
        [],
        redactedSummaryFromError(error),
      );
    } finally {
      if (diagnosticSession !== undefined) await diagnosticSession.close();
      await this.close(cdp);
      await this.kill(chrome);
      terminalService = await this.cleanupProfile(profileDir, terminalService);
    }

    return { service: terminalService, result: actionResultValue, performance };
  }

  private async runFacadeAction(
    session: McpDiagnosticSession,
    action: BrowserActionKind,
    payload: Record<string, string | number | boolean>,
    lanePolicy: BrowserLanePolicy,
    requestedOrigin: string,
  ): Promise<BrowserActionResult> {
    const initialUrl = action === "navigate" ? stringPayload(payload, "url") : undefined;
    await this.assertOriginAllowed(initialUrl ?? requestedOrigin, lanePolicy, "before typed MCP action");

    // US-BROW-020 (live-gate finding): every managed run starts a FRESH
    // temporary Chrome at about:blank, so a non-navigate diagnostic must load
    // the requested page first or it inspects a blank tab. Only navigation
    // reports a final URL on the real server (prose "## Pages … [selected]"),
    // so the final-origin guard anchors on the navigate step.
    let finalUrl: string;
    if (action === "navigate") {
      const nav = await session.facade.execute({ action, payload });
      if (nav.status === "denied") throw new OriginDenialError(nav.denial ?? { code: "action_not_allowed", message: nav.summary });
      if (nav.status === "failed") throw new DevToolsError(nav.summary);
      if (nav.finalUrl === undefined) throw new DevToolsError("Typed MCP navigation did not report a final URL");
      finalUrl = nav.finalUrl;
      await this.assertOriginAllowed(finalUrl, lanePolicy, "after typed MCP action");
      return actionResult("", "ok", nav.diagnosticRefs, nav.summary);
    }

    const nav = await session.facade.execute({ action: "navigate", payload: { url: requestedOrigin } });
    if (nav.status === "denied") throw new OriginDenialError(nav.denial ?? { code: "action_not_allowed", message: nav.summary });
    if (nav.status === "failed") throw new DevToolsError(nav.summary);
    if (nav.finalUrl === undefined) throw new DevToolsError("Typed MCP navigation did not report a final URL");
    finalUrl = nav.finalUrl;
    await this.assertOriginAllowed(finalUrl, lanePolicy, "after navigation, before diagnostic");

    const result = await session.facade.execute({ action, payload });
    if (result.status === "denied") throw new OriginDenialError(result.denial ?? { code: "action_not_allowed", message: result.summary });
    if (result.status === "failed") throw new DevToolsError(result.summary);
    if (result.finalUrl !== undefined) {
      await this.assertOriginAllowed(result.finalUrl, lanePolicy, "after typed MCP action");
    }
    return actionResult("", "ok", result.diagnosticRefs, result.summary);
  }

  private diagnosticWriter(): DiagnosticArtifactWriter {
    return {
      write: async ({ artifactId, bytes }) => {
        await this.deps.fs.mkdir(this.deps.diagnosticsDir, { recursive: true });
        await this.deps.fs.writeFile(join(this.deps.diagnosticsDir, `${artifactId}.bin`), bytes);
      },
    };
  }

  // ── Performance diagnostic profile (US-BROW-012) ────────────────────────

  /**
   * Collect the opt-in performance diagnostic profile. Fully wrapped: it never
   * throws and never propagates a failure to the caller, guaranteeing the
   * action verdict is untouched. A policy denial or unknown name returns a
   * structured denial; a collection error returns a degraded (empty) summary.
   *
   * Only local CDP methods are used — no URL or trace is sent to CrUX or any
   * external service (AC3).
   */
  private async runPerformanceProfile(
    cdp: CdpSession,
    rawName: string,
    lanePolicy: BrowserLanePolicy,
  ): Promise<PerformanceProfileOutcome> {
    const authorized = authorizePerformanceProfile(rawName, lanePolicy);
    if ("code" in authorized) {
      return { denial: authorized };
    }
    try {
      const summary = await this.collectPerformanceSummary(cdp, authorized);
      const ref = await this.writeDiagnosticArtifact(
        "performance-summary",
        Buffer.from(JSON.stringify(summary), "utf8"),
      );
      return { summary, ref };
    } catch {
      // Graceful degradation — the profile failed but the action still passes.
      return { summary: degradedPerformanceSummary(authorized.name) };
    }
  }

  private async collectPerformanceSummary(
    cdp: CdpSession,
    profile: PerformanceProfile,
  ): Promise<PerformanceDiagnosticSummary> {
    await cdp.send("Performance.enable");
    const raw = (await cdp.send("Performance.getMetrics")) as {
      metrics?: ReadonlyArray<{ name?: unknown; value?: unknown }>;
    };
    return summarizePerformanceMetrics(raw.metrics ?? [], profile);
  }

  // ── Device emulation (US-BROW-014) ──────────────────────────────────────

  /**
   * Apply device emulation via CDP before the page action runs.
   *
   * Sends Emulation.setDeviceMetricsOverride and — when the profile specifies
   * a userAgent — Network.setUserAgentOverride. This is diagnostic-only and
   * bounded to the managed lane; it never alters origin or cleanup policy.
   */
  private async emulateDevice(cdp: CdpSession, profile: DeviceProfile): Promise<void> {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: profile.width,
      height: profile.height,
      deviceScaleFactor: profile.deviceScaleFactor,
      mobile: profile.mobile,
      screenWidth: profile.width,
      screenHeight: profile.height,
      fitWindow: false,
    });
    if (profile.userAgent !== undefined) {
      await cdp.send("Network.setUserAgentOverride", {
        userAgent: profile.userAgent,
      });
    }
  }

  private async runTypedAction(options: {
    cdp: CdpSession;
    action: BrowserActionKind;
    payload: Record<string, string | number | boolean>;
    lanePolicy: BrowserLanePolicy;
  }): Promise<BrowserActionResult> {
    const { cdp, action, payload, lanePolicy } = options;

    switch (action) {
      case "navigate": {
        const url = stringPayload(payload, "url");
        await this.assertOriginAllowed(url, lanePolicy, "before navigation");
        await cdp.send("Page.navigate", { url });
        const finalUrl = await this.readCurrentUrl(cdp);
        await this.assertOriginAllowed(finalUrl, lanePolicy, "after redirect");
        return actionResult("", "ok", [], `navigated to ${finalUrl}`);
      }
      case "snapshot": {
        // DOM assertion: read textContent for the selector; no external capture.
        const selector = stringPayload(payload, "selector");
        const finalUrl = await this.readCurrentUrl(cdp);
        await this.assertOriginAllowed(finalUrl, lanePolicy, "before DOM assertion");
        const snapshot = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [], includeDOMRects: false });
        const ref = await this.writeTextDiagnosticArtifact("dom-snapshot", JSON.stringify({ selector, snapshot }));
        return actionResult("", "ok", [ref], "DOM snapshot recorded");
      }
      case "console": {
        const finalUrl = await this.readCurrentUrl(cdp);
        await this.assertOriginAllowed(finalUrl, lanePolicy, "before console summary");
        const log = await cdp.send("Log.enable");
        const ref = await this.writeTextDiagnosticArtifact("console-summary", JSON.stringify({ entries: normalizeConsoleEntries(log) }));
        return actionResult("", "ok", [ref], "console summary recorded");
      }
      case "network": {
        const finalUrl = await this.readCurrentUrl(cdp);
        await this.assertOriginAllowed(finalUrl, lanePolicy, "before network summary");
        const network = await cdp.send("Network.enable");
        const ref = await this.writeTextDiagnosticArtifact("network-summary", JSON.stringify({ entries: normalizeNetworkEntries(network) }));
        return actionResult("", "ok", [ref], "network summary recorded");
      }
      case "screenshot": {
        const finalUrl = await this.readCurrentUrl(cdp);
        await this.assertOriginAllowed(finalUrl, lanePolicy, "before screenshot");
        const capture = (await cdp.send("Page.captureScreenshot")) as { data?: string };
        const data = stringValue(capture.data);
        if (data === undefined || data === "") {
          throw new DevToolsError("Page.captureScreenshot returned empty data");
        }
        const ref = await this.writeDiagnosticArtifact("devtools-screenshot", Buffer.from(data, "base64"));
        return actionResult("", "ok", [ref], `diagnostic screenshot captured at ${finalUrl}`);
      }
      default:
        throw new DevToolsError(`Action "${action}" is not implemented in the managed adapter`);
    }
  }

  private async readCurrentUrl(cdp: CdpSession): Promise<string> {
    const result = (await cdp.send("Runtime.evaluate", { expression: "window.location.href", returnByValue: true })) as {
      result?: { value?: unknown };
    };
    const value = stringValue(result.result?.value);
    if (value === undefined) {
      throw new DevToolsError("Could not read current URL from page");
    }
    return value;
  }

  private async assertOriginAllowed(url: string, lanePolicy: BrowserLanePolicy, context: string): Promise<void> {
    const auth = authorizeOrigin(url, lanePolicy);
    if (!auth.authorized || auth.normalized === undefined) {
      const denial: BrowserDenialReason = auth.denial ?? {
        code: "origin_not_allowed",
        message: `Origin not allowed (${context}): ${url}`,
      };
      throw new OriginDenialError(denial);
    }
  }

  private async writeDiagnosticArtifact(kind: DiagnosticArtifactKind, bytes: Buffer): Promise<DiagnosticArtifactRef> {
    const artifactId = this.deps.randomId();
    const path = join(this.deps.diagnosticsDir, `${artifactId}.bin`);
    await this.deps.fs.mkdir(this.deps.diagnosticsDir, { recursive: true });
    await this.deps.fs.writeFile(path, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      artifactId,
      kind,
      digest,
      bytes: bytes.length,
      untrusted: true,
      diagnosticOnly: true,
    };
  }

  private async writeTextDiagnosticArtifact(kind: DiagnosticArtifactKind, text: string): Promise<DiagnosticArtifactRef> {
    const artifactId = this.deps.randomId();
    const persisted = persistDiagnostic({ artifactId, kind, text });
    if (persisted.kind === "dropped") {
      throw new DevToolsError(`Diagnostic artifact dropped: ${persisted.failure}`);
    }
    const path = join(this.deps.diagnosticsDir, `${artifactId}.bin`);
    await this.deps.fs.mkdir(this.deps.diagnosticsDir, { recursive: true });
    await this.deps.fs.writeFile(path, persisted.text, "utf8");
    return persisted.artifact;
  }

  private finalizeFromError(service: BrowserOperationRunService, error: unknown): BrowserOperationRunService {
    if (error instanceof OriginDenialError) {
      return service.deny();
    }
    const failure = diagnosticFailureFromError(error, this.deps.now);
    return service.fail([failure]);
  }

  private actionStatusFromError(error: unknown): BrowserActionResult["status"] {
    if (error instanceof OriginDenialError) return "denied";
    return "failed";
  }

  private async close(cdp: CdpSession | undefined): Promise<void> {
    if (cdp === undefined) return;
    try {
      await cdp.close();
    } catch {
      /* best-effort */
    }
  }

  private async kill(chrome: ChromeProcess | undefined): Promise<void> {
    if (chrome === undefined) return;
    try {
      await chrome.kill();
    } catch {
      /* best-effort */
    }
  }

  private async cleanupProfile(
    profileDir: string | undefined,
    service: BrowserOperationRunService,
  ): Promise<BrowserOperationRunService> {
    if (profileDir === undefined) return service;
    try {
      await this.deps.fs.rm(profileDir, { recursive: true, force: true });
    } catch {
      /* swallow: cleanup is best-effort but the run state still records removed */
    }
    return service.removeProfile();
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, context: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TimeoutError(`${context} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async allocateDebugPort(): Promise<number> {
    // FIX-325 / isolation: pick a random high port to avoid collisions when
    // multiple managed runs exist in the same cycle.
    return 10_000 + Math.floor(Math.random() * 45_000);
  }

  private createSession(runId: string): Promise<CdpSession> {
    if (this.deps.mcpSessionFactory !== undefined) {
      return this.deps.mcpSessionFactory.create(runId);
    }
    if (this.deps.transportFactory !== undefined) {
      // Test-injection seam only: fake CDP sessions are permitted in tests but
      // must never be wired from CLI/runtime code.
      return this.deps.transportFactory.create({ host: this.deps.remoteDebuggingHost, port: 0 });
    }
    throw new DevToolsError("No DevTools session factory configured");
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
  }
}

class DevToolsError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function diagnosticFailureFromError(error: unknown, now: () => string): DiagnosticFailure {
  if (error instanceof TimeoutError) {
    return { category: "timeout", message: error.message, at: now() };
  }
  if (error instanceof OriginDenialError) {
    return { category: "devtools-error", message: `${error.reason.code}: ${error.reason.message}`, at: now() };
  }
  if (error instanceof DevToolsProtocolError) {
    return { category: "devtools-error", message: `${error.code}: ${error.message}`, at: now() };
  }
  if (error instanceof DevToolsError || error instanceof Error) {
    return { category: "devtools-error", message: error.message, at: now() };
  }
  return { category: "crash", message: "Chrome or adapter crashed", at: now() };
}

function redactedSummaryFromError(error: unknown): string {
  if (error instanceof OriginDenialError) return `denied: ${error.reason.message}`;
  if (error instanceof Error) return `failed: ${redactDiagnostic(error.message)}`;
  return "failed: unknown error";
}

function actionResult(
  runId: string,
  status: BrowserActionResult["status"],
  diagnosticRefs: DiagnosticArtifactRef[],
  redactedSummary: string,
): BrowserActionResult {
  return {
    runId,
    actionId: randomUUID(),
    status,
    diagnosticRefs,
    redactedSummary,
  };
}

function stringPayload(payload: Record<string, string | number | boolean>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new DevToolsError(`Payload key "${key}" must be a string`);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeConsoleEntries(value: unknown): Array<{ level: string; message: string; source?: string }> {
  const entries = isRecord(value) && Array.isArray(value["entries"]) ? value["entries"] : [];
  return entries.slice(0, 50).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const message = typeof entry["text"] === "string" ? entry["text"] : typeof entry["message"] === "string" ? entry["message"] : "";
    const source = typeof entry["source"] === "string" ? entry["source"] : undefined;
    return [{
      level: typeof entry["level"] === "string" ? entry["level"] : "info",
      message,
      ...(source === undefined ? {} : { source }),
    }];
  });
}

function normalizeNetworkEntries(value: unknown): Array<{ method: string; origin?: string; status?: number; duration?: number; failure?: string }> {
  const entries = isRecord(value) && Array.isArray(value["entries"]) ? value["entries"] : [];
  return entries.slice(0, 50).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const rawUrl = typeof entry["url"] === "string" ? entry["url"] : undefined;
    const status = typeof entry["status"] === "number" ? entry["status"] : undefined;
    const duration = typeof entry["duration"] === "number" ? entry["duration"] : undefined;
    const failure = typeof entry["failure"] === "string" ? entry["failure"] : undefined;
    return [{
      method: typeof entry["method"] === "string" ? entry["method"] : "GET",
      ...(rawUrl === undefined ? {} : { origin: normalizeDiagnosticOrigin(rawUrl) }),
      ...(status === undefined ? {} : { status }),
      ...(duration === undefined ? {} : { duration }),
      ...(failure === undefined ? {} : { failure }),
    }];
  });
}

function normalizeDiagnosticOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
