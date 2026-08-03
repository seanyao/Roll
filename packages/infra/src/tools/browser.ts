import { existsSync, realpathSync } from "node:fs";
import { basename, dirname as pathDirname, isAbsolute, join, relative, resolve } from "node:path";
import { PHYSICAL_SCREENSHOT_TOOL_CONTRACT } from "@roll/spec";
import type { ExecResult, RollCaptureRequestV1, RollCaptureResponseV1, ToolDeclaration, ToolDeps, ToolErrorCode, ToolInvocation, ToolMeta, ToolResult } from "@roll/spec";
import { PLAYWRIGHT_PIN } from "../playwright-pin.js";
import { RollCaptureProvider, type RollCaptureProviderPort } from "../roll-capture.js";
import {
  browserConsoleInputSchema,
  browserConsoleOutputSchema,
  browserDomQueryInputSchema,
  browserDomQueryOutputSchema,
  browserScreenshotInputSchema,
  browserScreenshotOutputSchema,
} from "./schema-contracts.js";
import { resolveToolExecutionContext, toolCorrelation } from "./workspace-context.js";

export type BrowserToolId = "browser.screenshot" | "browser.console" | "browser.dom-query" | "physical.screenshot";

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserScreenshotInput {
  url: string;
  viewport?: BrowserViewport;
  waitFor?: string;
  screenshotPath?: string;
}

export interface BrowserConsoleInput {
  url: string;
  waitFor?: string;
}

export interface BrowserDomQueryInput {
  url: string;
  selector: string;
  waitFor?: string;
}

export interface BrowserScreenshotOutput {
  screenshotPath: string;
  finalUrl: string;
  statusCode: number | null;
}

export interface BrowserConsoleLog {
  level: string;
  text: string;
  ts: number;
}

export interface BrowserConsoleOutput {
  consoleLogs: BrowserConsoleLog[];
  finalUrl: string;
  statusCode: number | null;
}

export interface BrowserDomQueryOutput {
  domResults: string[];
  finalUrl: string;
  statusCode: number | null;
}

export interface PhysicalScreenshotOutput {
  status: "taken" | "skipped" | "failed" | "timeout";
  path?: string;
  reason?: string;
  response?: RollCaptureResponseV1;
}

type BrowserWebInput = BrowserScreenshotInput | BrowserConsoleInput | BrowserDomQueryInput;
type BrowserInput = BrowserWebInput | RollCaptureRequestV1;
type BrowserOutput = BrowserScreenshotOutput | BrowserConsoleOutput | BrowserDomQueryOutput | PhysicalScreenshotOutput;

class BrowserToolState {
  queue: Promise<unknown> = Promise.resolve();
  initialized = false;

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

const TOOL_TITLES: Record<BrowserToolId, string> = {
  "browser.screenshot": "Browser Screenshot",
  "browser.console": "Browser Console",
  "browser.dom-query": "Browser DOM Query",
  "physical.screenshot": "Physical Screenshot",
};

export class BrowserTool {
  readonly declaration: ToolDeclaration;

  constructor(
    private readonly id: BrowserToolId,
    private readonly state = new BrowserToolState(),
    private readonly rollCaptureProvider: RollCaptureProviderPort = new RollCaptureProvider(),
  ) {
    this.declaration = id === "physical.screenshot" ? PHYSICAL_SCREENSHOT_TOOL_CONTRACT : {
      id: id as ToolDeclaration["id"],
      kind: "browser",
      title: TOOL_TITLES[id],
      description: "Open URLs through the governed browser adapter.",
      defaults: {
        enabled: true,
        timeoutMs: 60_000,
        sandbox: {
          headlessOnly: true,
          maxOutputBytes: 2 * 1024 * 1024,
        },
      },
      requirements: [{ kind: "executable", name: "playwright-chromium", optional: true }],
      inputSchema: browserInputSchema(id),
      outputSchema: browserOutputSchema(id),
    };
  }

  async init(_deps: ToolDeps): Promise<void> {
    this.state.initialized = true;
  }

  async dispose(_deps: ToolDeps): Promise<void> {
    await this.state.queue.catch(() => undefined);
    this.state.initialized = false;
  }

  async execute(invocation: ToolInvocation<BrowserInput>, deps: ToolDeps): Promise<ToolResult<BrowserOutput>> {
    return this.state.enqueue(() => this.executeQueued(invocation, deps));
  }

  private async executeQueued(invocation: ToolInvocation<BrowserInput>, deps: ToolDeps): Promise<ToolResult<BrowserOutput>> {
    const startedAt = deps.now();
    const scoped = resolveToolExecutionContext(invocation, "issue_required");
    if (!scoped.ok) {
      return fail(invocation, startedAt, deps.now(), scoped.error.code, scoped.error.message, false);
    }
    const effectiveInvocation = { ...invocation, context: scoped.context };
    if (this.id === "physical.screenshot") {
      const result = await this.executePhysicalScreenshot(effectiveInvocation as ToolInvocation<RollCaptureRequestV1>, deps, startedAt);
      return result as ToolResult<BrowserOutput>;
    }
    const input = effectiveInvocation.input as BrowserWebInput;
    const origin = originOf(input.url);
    if (origin === undefined) return fail(effectiveInvocation, startedAt, deps.now(), "invalid_input", `invalid URL: ${deps.redact(input.url)}`, false);
    if (!originAllowed(origin, effectiveInvocation.policy.sandbox?.allowedOrigins)) {
      return fail(effectiveInvocation, startedAt, deps.now(), "sandbox_denied", `origin is outside allowedOrigins: ${origin}`, false);
    }

    if (this.id === "browser.screenshot") {
      const result = await this.executeScreenshot(effectiveInvocation as ToolInvocation<BrowserScreenshotInput>, deps, startedAt);
      return result as ToolResult<BrowserOutput>;
    }
    if (this.id === "browser.console") {
      const result = await this.executeHeadlessJson<BrowserConsoleInput, BrowserConsoleOutput>(effectiveInvocation as ToolInvocation<BrowserConsoleInput>, deps, "console", startedAt);
      return result as ToolResult<BrowserOutput>;
    }
    const result = await this.executeHeadlessJson<BrowserDomQueryInput, BrowserDomQueryOutput>(effectiveInvocation as ToolInvocation<BrowserDomQueryInput>, deps, "dom-query", startedAt);
    return result as ToolResult<BrowserOutput>;
  }

  private async executeScreenshot(
    invocation: ToolInvocation<BrowserScreenshotInput>,
    deps: ToolDeps,
    startedAt: number,
  ): Promise<ToolResult<BrowserScreenshotOutput>> {
    const input = invocation.input;
    const screenshotPath = input.screenshotPath ?? join(
      invocation.context!.authorities.toolDumps,
      `${invocation.invocationId}.png`,
    );
    if (!workspaceArtifactPathAllowed(screenshotPath, invocation.context!)) {
      return fail(invocation, startedAt, deps.now(), "sandbox_denied", "screenshot path is outside Workspace evidence authorities", false);
    }
    if (shouldUseHeadless(invocation)) return this.executeHeadlessScreenshot(invocation, deps, screenshotPath, startedAt);

    const aqua = await hasAquaSession(deps, invocation.policy.timeoutMs);
    if (aqua) {
      return this.executeGuiScreenshot(invocation, deps, screenshotPath, startedAt);
    }
    return this.executeHeadlessScreenshot(invocation, deps, screenshotPath, startedAt);
  }

  private async executeHeadlessScreenshot(
    invocation: ToolInvocation<BrowserScreenshotInput>,
    deps: ToolDeps,
    screenshotPath: string,
    startedAt: number,
  ): Promise<ToolResult<BrowserScreenshotOutput>> {
    const input = invocation.input;
    const args = headlessArgs("screenshot", {
      url: deps.redact(input.url),
      screenshotPath,
      waitFor: input.waitFor === undefined ? undefined : deps.redact(input.waitFor),
      viewport: input.viewport,
    });
    const result = await runBrowserCommand(deps, "npx", args, invocation.policy.timeoutMs, invocation.policy.sandbox?.maxOutputBytes);
    if (!result.ok) return fail(invocation, startedAt, deps.now(), "adapter_error", `headless browser unavailable: ${result.reason}`, true);

    const parsed = parseObject(result.result.stdout);
    const png = stringValue(parsed.png);
    if (png !== undefined) {
      if (png.length === 0) return fail(invocation, startedAt, deps.now(), "adapter_error", "headless browser produced an empty screenshot", true);
      await deps.fs.mkdir(dirname(screenshotPath), { recursive: true });
      await deps.fs.writeFile(screenshotPath, deps.redact(png), "utf8");
    }
    return {
      ok: true,
      output: {
        screenshotPath,
        finalUrl: stringValue(parsed.finalUrl) ?? input.url,
        statusCode: statusValue(parsed.statusCode),
      },
      meta: meta(invocation, startedAt, deps.now()),
    };
  }

  private async executeGuiScreenshot(
    invocation: ToolInvocation<BrowserScreenshotInput>,
    deps: ToolDeps,
    screenshotPath: string,
    startedAt: number,
  ): Promise<ToolResult<BrowserScreenshotOutput>> {
    const input = invocation.input;
    const open = await runBrowserCommand(deps, "osascript", ["-e", guiOpenScript(deps.redact(input.url))], invocation.policy.timeoutMs, invocation.policy.sandbox?.maxOutputBytes);
    if (!open.ok) return fail(invocation, startedAt, deps.now(), "adapter_error", `GUI browser unavailable: ${open.reason}`, true);
    const shot = await runBrowserCommand(deps, "screencapture", ["-x", screenshotPath], invocation.policy.timeoutMs, invocation.policy.sandbox?.maxOutputBytes);
    if (!shot.ok) return fail(invocation, startedAt, deps.now(), "adapter_error", `GUI browser unavailable: ${shot.reason}`, true);
    if (shot.result.stdout.length > 0) {
      await deps.fs.mkdir(dirname(screenshotPath), { recursive: true });
      await deps.fs.writeFile(screenshotPath, deps.redact(shot.result.stdout), "utf8");
    }
    return {
      ok: true,
      output: { screenshotPath, finalUrl: input.url, statusCode: null },
      meta: meta(invocation, startedAt, deps.now()),
    };
  }

  private async executePhysicalScreenshot(
    invocation: ToolInvocation<RollCaptureRequestV1>,
    deps: ToolDeps,
    startedAt: number,
  ): Promise<ToolResult<PhysicalScreenshotOutput>> {
    const contextStoryId = invocation.context!.issue!.storyId;
    if (invocation.input.storyId !== undefined && invocation.input.storyId !== contextStoryId) {
      return fail(invocation, startedAt, deps.now(), "invalid_execution_context", "physical capture Story does not match the frozen Workspace execution context", false);
    }
    if (!workspaceArtifactPathAllowed(invocation.input.out, invocation.context!)) {
      return fail(invocation, startedAt, deps.now(), "sandbox_denied", "physical capture path is outside Workspace evidence authorities", false);
    }
    try {
      await this.rollCaptureProvider.writeRequest(invocation.input);
      const result = await this.rollCaptureProvider.waitForResponse(invocation.input, { timeoutMs: invocation.policy.timeoutMs ?? invocation.input.timeoutMs });
      if (result.status === "taken") {
        return {
          ok: true,
          output: { status: "taken", path: result.path, response: result.response },
          meta: meta(invocation, startedAt, deps.now()),
        };
      }
      if (result.status === "timeout") {
        return fail(invocation, startedAt, deps.now(), "timeout", deps.redact(result.reason), true);
      }
      return fail(invocation, startedAt, deps.now(), "adapter_error", deps.redact(result.reason), result.status === "failed");
    } catch (error) {
      return fail(invocation, startedAt, deps.now(), "adapter_error", error instanceof Error ? deps.redact(error.message) : "Roll Capture request failed", true);
    }
  }

  private async executeHeadlessJson<I extends BrowserWebInput, O extends BrowserOutput>(
    invocation: ToolInvocation<I>,
    deps: ToolDeps,
    action: "console" | "dom-query",
    startedAt: number,
  ): Promise<ToolResult<O>> {
    const input = invocation.input;
    const args = headlessArgs(action, {
      url: deps.redact(input.url),
      waitFor: input.waitFor === undefined ? undefined : deps.redact(input.waitFor),
      selector: hasSelector(input) ? deps.redact(input.selector) : undefined,
    });
    const result = await runBrowserCommand(deps, "npx", args, invocation.policy.timeoutMs, invocation.policy.sandbox?.maxOutputBytes);
    if (!result.ok) return fail(invocation, startedAt, deps.now(), "adapter_error", `headless browser unavailable: ${result.reason}`, true) as ToolResult<O>;
    const parsed = parseObject(result.result.stdout);
    if (action === "console") {
      return {
        ok: true,
        output: {
          consoleLogs: consoleLogsValue(parsed.consoleLogs),
          finalUrl: stringValue(parsed.finalUrl) ?? input.url,
          statusCode: statusValue(parsed.statusCode),
        } as O,
        meta: meta(invocation, startedAt, deps.now()),
      };
    }
    return {
      ok: true,
      output: {
        domResults: stringArrayValue(parsed.domResults),
        finalUrl: stringValue(parsed.finalUrl) ?? input.url,
        statusCode: statusValue(parsed.statusCode),
      } as O,
      meta: meta(invocation, startedAt, deps.now()),
    };
  }
}

function workspaceArtifactPathAllowed(path: string, context: NonNullable<ToolInvocation["context"]>): boolean {
  if (!isAbsolute(path)) return false;
  const declaredWorkspaceRoot = resolve(context.workspace.canonicalRoot);
  if (!existsSync(declaredWorkspaceRoot)) {
    return [context.authorities.evidence, context.authorities.toolDumps].some((authority) =>
      pathContained(resolve(authority), resolve(path)),
    );
  }
  const canonicalWorkspaceRoot = canonicalizeAllowMissing(declaredWorkspaceRoot);
  if (canonicalWorkspaceRoot === undefined || canonicalWorkspaceRoot !== declaredWorkspaceRoot) return false;
  const canonicalTarget = canonicalizeAllowMissing(path);
  if (canonicalTarget === undefined) return false;
  return [context.authorities.evidence, context.authorities.toolDumps].some((authority) => {
    const canonicalAuthority = canonicalizeAllowMissing(authority);
    return canonicalAuthority !== undefined &&
      pathContained(canonicalWorkspaceRoot, canonicalAuthority) &&
      pathContained(canonicalAuthority, canonicalTarget);
  });
}

function canonicalizeAllowMissing(path: string): string | undefined {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = pathDirname(ancestor);
    if (parent === ancestor) return undefined;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  try {
    return resolve(realpathSync.native(ancestor), ...suffix);
  } catch {
    return undefined;
  }
}

function pathContained(root: string, target: string): boolean {
  const descendant = relative(root, target);
  return descendant === "" || (descendant !== ".." && !descendant.startsWith("../") && !isAbsolute(descendant));
}

function browserInputSchema(id: BrowserToolId): ToolDeclaration["inputSchema"] {
  if (id === "browser.screenshot") return browserScreenshotInputSchema;
  if (id === "physical.screenshot") return browserScreenshotInputSchema;
  if (id === "browser.console") return browserConsoleInputSchema;
  return browserDomQueryInputSchema;
}

function browserOutputSchema(id: BrowserToolId): ToolDeclaration["outputSchema"] {
  if (id === "browser.screenshot") return browserScreenshotOutputSchema;
  if (id === "physical.screenshot") return browserScreenshotOutputSchema;
  if (id === "browser.console") return browserConsoleOutputSchema;
  return browserDomQueryOutputSchema;
}

export function browserTools(): BrowserTool[] {
  const state = new BrowserToolState();
  return [
    new BrowserTool("browser.screenshot", state),
    new BrowserTool("browser.console", state),
    new BrowserTool("browser.dom-query", state),
    new BrowserTool("physical.screenshot", state),
  ];
}

function shouldUseHeadless(invocation: ToolInvocation<BrowserInput>): boolean {
  return invocation.policy.sandbox?.headlessOnly === true || process.env.CI === "true" || process.env.CI === "1";
}

function headlessArgs(
  action: "screenshot" | "console" | "dom-query",
  payload: { url: string; screenshotPath?: string; waitFor?: string; selector?: string; viewport?: BrowserViewport },
): string[] {
  return [
    "-y",
    "-p",
    PLAYWRIGHT_PIN,
    "node",
    "-e",
    headlessScript(action),
    "--",
    JSON.stringify(payload),
    action,
    payload.url,
  ];
}

function headlessScript(action: "screenshot" | "console" | "dom-query"): string {
  const body =
    action === "screenshot"
      ? [
          "const { chromium } = require('playwright');",
          "const input = JSON.parse(process.argv[1]);",
          "(async () => {",
          "  const browser = await chromium.launch({ headless: true });",
          "  const page = await browser.newPage({ viewport: input.viewport || undefined });",
          "  const response = await page.goto(input.url, { waitUntil: 'networkidle' });",
          "  if (input.waitFor) await page.waitForSelector(input.waitFor);",
          "  await page.screenshot({ path: input.screenshotPath, fullPage: true });",
          "  console.log(JSON.stringify({ finalUrl: page.url(), statusCode: response ? response.status() : null }));",
          "  await browser.close();",
          "})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });",
        ]
      : action === "console"
        ? [
            "const { chromium } = require('playwright');",
            "const input = JSON.parse(process.argv[1]);",
            "(async () => {",
            "  const logs = [];",
            "  const browser = await chromium.launch({ headless: true });",
            "  const page = await browser.newPage();",
            "  page.on('console', (msg) => logs.push({ level: msg.type(), text: msg.text(), ts: Date.now() }));",
            "  const response = await page.goto(input.url, { waitUntil: 'networkidle' });",
            "  if (input.waitFor) await page.waitForSelector(input.waitFor);",
            "  console.log(JSON.stringify({ consoleLogs: logs, finalUrl: page.url(), statusCode: response ? response.status() : null }));",
            "  await browser.close();",
            "})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });",
          ]
        : [
            "const { chromium } = require('playwright');",
            "const input = JSON.parse(process.argv[1]);",
            "(async () => {",
            "  const browser = await chromium.launch({ headless: true });",
            "  const page = await browser.newPage();",
            "  const response = await page.goto(input.url, { waitUntil: 'networkidle' });",
            "  if (input.waitFor) await page.waitForSelector(input.waitFor);",
            "  const domResults = await page.$$eval(input.selector, (nodes) => nodes.map((node) => node.textContent || ''));",
            "  console.log(JSON.stringify({ domResults, finalUrl: page.url(), statusCode: response ? response.status() : null }));",
            "  await browser.close();",
            "})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });",
          ];
  return body.join("\n");
}

async function hasAquaSession(deps: ToolDeps, timeoutMs: number | undefined): Promise<boolean> {
  const result = await runBrowserCommand(deps, "launchctl", ["managername"], timeoutMs, 1024);
  return result.ok && result.result.stdout.includes("Aqua");
}

async function runBrowserCommand(
  deps: ToolDeps,
  command: string,
  args: readonly string[],
  timeoutMs: number | undefined,
  maxOutputBytes: number | undefined,
): Promise<{ ok: true; result: ExecResult } | { ok: false; reason: string }> {
  try {
    const result = await deps.execFile(command, args, { timeoutMs, maxOutputBytes });
    if (result.timedOut) return { ok: false, reason: "timed out" };
    if (result.exitCode !== 0) return { ok: false, reason: deps.redact(result.stderr || `exit ${result.exitCode}`) };
    return { ok: true, result };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? deps.redact(cause.message) : "execution failed" };
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function originAllowed(origin: string, allowedOrigins: readonly string[] | undefined): boolean {
  return allowedOrigins === undefined || allowedOrigins.length === 0 || allowedOrigins.includes(origin);
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function statusValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function consoleLogsValue(value: unknown): BrowserConsoleLog[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const level = stringValue(record.level);
    const text = stringValue(record.text);
    const ts = statusValue(record.ts);
    return level === undefined || text === undefined || ts === null ? [] : [{ level, text, ts }];
  });
}

function hasSelector(input: BrowserInput): input is BrowserDomQueryInput {
  return "selector" in input && typeof input.selector === "string";
}

function fail(
  invocation: ToolInvocation<BrowserInput>,
  startedAt: number,
  endedAt: number,
  code: ToolErrorCode,
  message: string,
  retryable: boolean,
): ToolResult<never> {
  return {
    ok: false,
    error: { code, message, retryable },
    meta: meta(invocation, startedAt, endedAt),
  };
}

function meta(invocation: ToolInvocation<BrowserInput>, startedAt: number, endedAt: number): ToolMeta {
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

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}

function guiOpenScript(url: string): string {
  return [
    'tell application "Google Chrome"',
    "  activate",
    "  if not (exists window 1) then make new window",
    `  set URL of active tab of front window to "${appleScriptString(url)}"`,
    "  delay 1",
    "end tell",
  ].join("\n");
}

function appleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
