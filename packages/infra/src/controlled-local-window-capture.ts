/**
 * @responsibility Captures a visible local window without touching the owner's Chrome profile.
 */
/**
 * FIX-005 — physical evidence for a local synthetic page must have a visible
 * target window, while never touching the owner's Chrome profile or tabs.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type CDPSession, type Frame, type Locator, type Page } from "playwright-core";
import {
  validateRollCaptureRequestV1,
  type RollCaptureRequestV1,
  type RollCaptureResponseV1,
} from "@roll/spec";
import { type CdpSession, type ChromeLauncher, type ChromeProcess, SystemChromeLauncher } from "./browser-operations/managed-chrome-adapter.js";
import { openLoopbackCdpSession } from "./browser-operations/interactive-chrome-adapter.js";
import { RollCaptureProvider, type RollCaptureProviderPort } from "./roll-capture.js";

const CHROME_APP_NAME = "Google Chrome";
const PAGE_DISCOVERY_ATTEMPTS = 40;
const PAGE_DISCOVERY_INTERVAL_MS = 200;
const PREPARE_FRAME_ATTEMPTS = 40;
const PREPARE_FRAME_INTERVAL_MS = 100;
const WINDOW_TITLE_SETTLE_MS = 3_000;

export interface ControlledLocalWindowCaptureInput {
  /** The product project's root; screenshot output must remain under `.roll`. */
  projectRoot: string;
  /** The one local synthetic page to make visible. Network and file URLs are refused. */
  url: string;
  /** Original tested page when a nonce wrapper owns the visible window. */
  prepareTargetUrl?: string;
  /** Closed-vocabulary interaction steps completed before physical capture. */
  prepare?: readonly ControlledPrepareAction[];
  /**
   * Exact title rendered by the synthetic page. It must carry a caller-created
   * nonce so another Chrome window cannot be selected accidentally.
   */
  windowTitle: string;
  /** The caller supplies evidence identity/output, but not the physical window selector. */
  request: Omit<RollCaptureRequestV1, "target">;
}

/** Public safe entry: wraps one loopback page in a nonce-titled local window. */
export interface ControlledLocalPageCaptureInput {
  projectRoot: string;
  url: string;
  /** Closed-vocabulary interaction steps completed inside the local page before capture. */
  prepare?: readonly ControlledPrepareAction[];
  request: Omit<RollCaptureRequestV1, "target">;
}

export interface ControlledLocalWindowCaptureResult {
  status: "taken" | "skipped" | "failed" | "timeout";
  path?: string;
  reason?: string;
  response?: RollCaptureResponseV1;
  selector?: { appName: typeof CHROME_APP_NAME; windowTitle: string };
}

export interface ControlledPage {
  url: string;
  webSocketDebuggerUrl: string;
}

export type ControlledPrepareAction =
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "wait"; ms: number }
  | { kind: "scroll"; selector: string };

export interface ControlledPreparePort {
  run(input: { page: ControlledPage; targetUrl: string; actions: readonly ControlledPrepareAction[] }): Promise<void>;
}

export interface ControlledPrepareDeps {
  connect(socketUrl: string): Promise<CdpSession>;
  sleep(ms: number): Promise<void>;
}

export interface ControlledPlaywrightPrepareDeps {
  connectOverCDP(endpoint: string): Promise<Browser>;
  connectCdp(socketUrl: string): Promise<CdpSession>;
  sleep(ms: number): Promise<void>;
}

export interface ControlledPagePort {
  find(input: { endpoint: string; expectedUrl: string }): Promise<ControlledPage | null>;
}

export interface ControlledCaptureWrapper {
  url: string;
  windowTitle: string;
  close(): Promise<void>;
}

export interface ControlledLocalWindowCaptureDeps {
  chrome: ChromeLauncher;
  fs: {
    mkdtemp(prefix: string): Promise<string>;
    rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  };
  ports: { allocate(): Promise<number> };
  pages: ControlledPagePort;
  /** Closed-vocabulary interactions against only the disposable Chrome page. */
  prepare: ControlledPreparePort;
  provider: RollCaptureProviderPort;
  sleep(ms: number): Promise<void>;
}

export interface ControlledLocalPageCaptureDeps extends ControlledLocalWindowCaptureDeps {
  wrappers: {
    open(input: { url: string; storyId: string }): Promise<ControlledCaptureWrapper>;
  };
}

/**
 * Start a disposable, nonce-titled wrapper around an exact loopback page, then
 * capture only that wrapper window. The wrapper is the reason the macOS window
 * title is deterministic without inspecting or modifying the app under test.
 */
export async function captureControlledLocalPage(
  input: ControlledLocalPageCaptureInput,
  deps: ControlledLocalPageCaptureDeps = defaultControlledLocalPageCaptureDeps(),
): Promise<ControlledLocalWindowCaptureResult> {
  const urlFailure = localUrlFailure(input.url);
  if (urlFailure !== undefined) return { status: "failed", reason: urlFailure };

  let wrapper: ControlledCaptureWrapper | undefined;
  try {
    wrapper = await deps.wrappers.open({ url: input.url, storyId: input.request.storyId ?? "evidence" });
    return await captureControlledLocalWindow({
      projectRoot: input.projectRoot,
      url: wrapper.url,
      prepareTargetUrl: input.url,
      prepare: input.prepare,
      windowTitle: wrapper.windowTitle,
      request: input.request,
    }, deps);
  } catch (error) {
    return {
      status: "failed",
      reason: `controlled local page wrapper failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (wrapper !== undefined) await closeWrapperQuietly(wrapper);
  }
}

export async function captureControlledLocalWindow(
  input: ControlledLocalWindowCaptureInput,
  deps: ControlledLocalWindowCaptureDeps = defaultControlledLocalWindowCaptureDeps(),
): Promise<ControlledLocalWindowCaptureResult> {
  const urlFailure = localUrlFailure(input.url);
  if (urlFailure !== undefined) return { status: "failed", reason: urlFailure };
  const prepareTargetUrl = input.prepareTargetUrl ?? input.url;
  const prepareUrlFailure = localUrlFailure(prepareTargetUrl);
  if (prepareUrlFailure !== undefined) return { status: "failed", reason: prepareUrlFailure };
  const prepareFailure = validateControlledPrepareActions(input.prepare);
  if (prepareFailure !== undefined) return { status: "failed", reason: prepareFailure };
  if (!input.windowTitle.startsWith("Roll Capture ") || input.windowTitle.length <= "Roll Capture ".length) {
    return { status: "failed", reason: "controlled local window capture requires a nonce-bearing title beginning with Roll Capture " };
  }
  if (input.request.kind !== "web") {
    return { status: "failed", reason: "controlled local window capture only accepts web evidence" };
  }

  const initialRequest: RollCaptureRequestV1 = {
    ...input.request,
    target: { type: "window", appName: CHROME_APP_NAME },
  };
  const requestValidation = validateRollCaptureRequestV1(initialRequest, { projectRoot: input.projectRoot });
  if (!requestValidation.ok) return { status: "failed", reason: requestValidation.errors.join("; ") };

  let profileDir: string | undefined;
  let chrome: ChromeProcess | undefined;
  try {
    profileDir = await deps.fs.mkdtemp(join(tmpdir(), "roll-controlled-capture-"));
    const remoteDebuggingPort = await deps.ports.allocate();
    chrome = await deps.chrome.launch({
      profileDir: join(profileDir, "profile"),
      remoteDebuggingPort,
      visibility: "visible",
      initialUrl: input.url,
    });

    const endpoint = `http://127.0.0.1:${remoteDebuggingPort}`;
    const page = await waitForExactLocalPage(endpoint, input.url, deps);
    if (page === null) {
      return { status: "failed", reason: "isolated local page was not discovered before capture" };
    }

    if (input.prepare !== undefined && input.prepare.length > 0) {
      await deps.prepare.run({ page, targetUrl: prepareTargetUrl, actions: input.prepare });
    }

    // macOS obtains a window title asynchronously from Chromium. Keeping the
    // process alive through this short settle interval avoids a false missing-window skip.
    await deps.sleep(WINDOW_TITLE_SETTLE_MS);

    const request: RollCaptureRequestV1 = {
      ...input.request,
      target: { type: "window", appName: CHROME_APP_NAME, windowTitle: input.windowTitle },
    };
    await deps.provider.writeRequest(request);
    const result = await deps.provider.waitForResponse(request, { timeoutMs: request.timeoutMs });
    const selector = { appName: CHROME_APP_NAME, windowTitle: input.windowTitle } as const;
    if (result.status === "taken") return { status: "taken", path: result.path, response: result.response, selector };
    if (result.status === "timeout") return { status: "timeout", reason: result.reason, selector };
    return { status: result.status, reason: result.reason, response: result.response, selector };
  } catch (error) {
    return {
      status: "failed",
      reason: `controlled local window capture failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (chrome !== undefined) await killQuietly(chrome);
    if (profileDir !== undefined) await removeQuietly(profileDir, deps);
  }
}

function defaultControlledLocalWindowCaptureDeps(): ControlledLocalWindowCaptureDeps {
  return {
    chrome: new SystemChromeLauncher(),
    fs: { mkdtemp, rm },
    ports: { allocate: allocateLoopbackPort },
    pages: defaultControlledPagePort(),
    prepare: defaultControlledPreparePort(),
    provider: new RollCaptureProvider(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function validateControlledPrepareActions(actions: readonly ControlledPrepareAction[] | undefined): string | undefined {
  if (actions === undefined) return undefined;
  if (actions.length > 16) return "controlled prepare allows at most 16 actions";
  let totalWaitMs = 0;
  for (const action of actions as readonly unknown[]) {
    if (typeof action !== "object" || action === null || !("kind" in action) || typeof action.kind !== "string") {
      return "controlled prepare action is invalid";
    }
    if (action.kind === "wait") {
      if (!("ms" in action) || typeof action.ms !== "number" || !Number.isInteger(action.ms) || action.ms < 0 || action.ms > 5_000) {
        return "controlled prepare wait requires an integer ms from 0 to 5000";
      }
      totalWaitMs += action.ms;
      if (totalWaitMs > 15_000) return "controlled prepare waits may total at most 15000ms";
      continue;
    }
    if (action.kind !== "click" && action.kind !== "fill" && action.kind !== "scroll") {
      return "controlled prepare only permits click, fill, wait, and scroll actions";
    }
    if (!("selector" in action) || typeof action.selector !== "string" || action.selector.trim() === "" || action.selector.length > 500) {
      return "controlled prepare selector must be a non-empty string of at most 500 characters";
    }
    if (action.kind === "fill" && (!("value" in action) || typeof action.value !== "string" || action.value.length > 1_000)) {
      return "controlled prepare fill value must be a string of at most 1000 characters";
    }
  }
  return undefined;
}

function defaultControlledLocalPageCaptureDeps(): ControlledLocalPageCaptureDeps {
  return {
    ...defaultControlledLocalWindowCaptureDeps(),
    wrappers: { open: createControlledCaptureWrapper },
  };
}

function defaultControlledPreparePort(): ControlledPreparePort {
  return {
    run: (input) => runPlaywrightControlledPrepareActions(input),
  };
}

/**
 * The public prepare schema remains closed. Playwright attaches only to the
 * disposable loopback Chrome launched by this capture path and resolves one
 * exact page/frame already discovered for the capture, never an owner window.
 */
export async function runPlaywrightControlledPrepareActions(
  input: { page: ControlledPage; targetUrl: string; actions: readonly ControlledPrepareAction[] },
  deps: ControlledPlaywrightPrepareDeps = {
    connectOverCDP: (endpoint) => chromium.connectOverCDP(endpoint),
    connectCdp: openLoopbackCdpSession,
    sleep: sleepForPrepare,
  },
): Promise<void> {
  if (loopbackOrigin(input.targetUrl) === undefined) throw new Error("controlled prepare target must remain loopback");
  const endpoint = devToolsHttpEndpoint(input.page.webSocketDebuggerUrl);
  if (endpoint === undefined) throw new Error("controlled prepare DevTools endpoint must remain loopback");
  const identity = await captureDiscoveredDevToolsFrameIdentity(input.page, input.targetUrl, deps.connectCdp, deps.sleep);
  let browser: Browser | undefined;
  try {
    browser = await deps.connectOverCDP(endpoint);
    let target = await waitForPlaywrightPrepareTarget(browser, input.page.url, input.targetUrl, deps.sleep, identity);
    if (target === undefined) throw new Error("controlled prepare original DevTools frame identity was not found before action");
    for (const action of input.actions) {
      if (action.kind === "wait") {
        await deps.sleep(action.ms);
      } else if (action.kind === "click") {
        const locator = await visibleLocator(target.frame, action.selector);
        if ((await locator.getAttribute("type"))?.toLowerCase() === "checkbox") {
          const initiallyChecked = await locator.isChecked();
          await locator.click();
          if (await locator.isChecked() === initiallyChecked) {
            await closePlaywrightBrowser(browser);
            browser = await deps.connectOverCDP(endpoint);
            await deps.sleep(500);
            target = await waitForPlaywrightPrepareTarget(browser, input.page.url, input.targetUrl, deps.sleep, identity);
            if (target === undefined) throw new Error("controlled prepare original DevTools frame identity was not found after reconnect");
            const recovered = await visibleLocator(target.frame, action.selector);
            if (initiallyChecked) await recovered.uncheck(); else await recovered.check();
            if (await recovered.isChecked() === initiallyChecked) throw new Error("controlled prepare checkbox recovery did not change state");
          }
        } else {
          await locator.click();
        }
      } else if (action.kind === "fill") {
        const locator = await visibleLocator(target.frame, action.selector);
        await assertSafePrepareFillTarget(locator);
        await locator.fill(action.value);
      } else {
        await (await visibleLocator(target.frame, action.selector)).scrollIntoViewIfNeeded();
      }
      if (target.frame.isDetached() || target.frame.url() !== input.targetUrl) {
        throw new Error("controlled prepare action left the original loopback target frame");
      }
    }
  } finally {
    if (browser !== undefined) await closePlaywrightBrowser(browser);
  }
}

interface PlaywrightPrepareTarget {
  page: Page;
  frame: Frame;
}

interface DevToolsFrameIdentity {
  targetId: string;
  frameId: string;
  targetUrl: string;
}

async function captureDiscoveredDevToolsFrameIdentity(
  page: ControlledPage,
  targetUrl: string,
  connect: (socketUrl: string) => Promise<CdpSession>,
  sleep: (ms: number) => Promise<void>,
): Promise<DevToolsFrameIdentity> {
  const targetId = devToolsTargetId(page.webSocketDebuggerUrl);
  if (targetId === undefined) throw new Error("controlled prepare DevTools page identity is invalid");
  const session = await connect(page.webSocketDebuggerUrl);
  try {
    const frameId = await waitForExactDevToolsFrameId(session, targetUrl, sleep);
    if (frameId === undefined) throw new Error("controlled prepare discovered DevTools frame identity was not found");
    return { targetId, frameId, targetUrl };
  } finally {
    await closePrepareSession(session);
  }
}

async function waitForExactDevToolsFrameId(
  session: Pick<CdpSession, "send">,
  targetUrl: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < PREPARE_FRAME_ATTEMPTS; attempt += 1) {
    const frameId = await exactFrameIdFromSession(session, targetUrl);
    if (frameId !== undefined) return frameId;
    if (attempt + 1 < PREPARE_FRAME_ATTEMPTS) await sleep(PREPARE_FRAME_INTERVAL_MS);
  }
  return undefined;
}

async function waitForPlaywrightPrepareTarget(
  browser: Browser,
  pageUrl: string,
  targetUrl: string,
  sleep: (ms: number) => Promise<void>,
  identity?: DevToolsFrameIdentity,
): Promise<PlaywrightPrepareTarget | undefined> {
  for (let attempt = 0; attempt < PREPARE_FRAME_ATTEMPTS; attempt += 1) {
    const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => page.url() === pageUrl);
    if (pages.length > 1) throw new Error("controlled prepare found multiple exact capture pages");
    const [page] = pages;
    if (page !== undefined) {
      const frames = page.frames().filter((frame) => frame.url() === targetUrl);
      if (frames.length > 1) throw new Error("controlled prepare requires exactly one original target frame");
      if (frames.length === 1) {
        const [frame] = frames;
        if (frame !== undefined && (identity === undefined || await matchesDevToolsFrameIdentity(page, identity))) return { page, frame };
      }
    }
    await sleep(PREPARE_FRAME_INTERVAL_MS);
  }
  return undefined;
}

async function matchesDevToolsFrameIdentity(page: Page, identity: DevToolsFrameIdentity): Promise<boolean> {
  const session = await page.context().newCDPSession(page);
  try {
    return await targetIdFromSession(session) === identity.targetId && await exactFrameIdFromSession(session, identity.targetUrl) === identity.frameId;
  } finally {
    await detachPlaywrightSession(session);
  }
}

async function targetIdFromSession(session: CDPSession): Promise<string | undefined> {
  const result = await session.send("Target.getTargetInfo") as { targetInfo?: { targetId?: unknown } };
  return typeof result.targetInfo?.targetId === "string" ? result.targetInfo.targetId : undefined;
}

async function exactFrameIdFromSession(session: Pick<CdpSession, "send"> | Pick<CDPSession, "send">, targetUrl: string): Promise<string | undefined> {
  const result = await session.send("Page.getFrameTree") as { frameTree?: unknown };
  const frames = matchingFrameIds(result.frameTree, targetUrl);
  if (frames.length > 1) throw new Error("controlled prepare requires exactly one original DevTools frame");
  return frames[0];
}

function matchingFrameIds(value: unknown, targetUrl: string): string[] {
  if (typeof value !== "object" || value === null) return [];
  const tree = value as { frame?: { id?: unknown; url?: unknown }; childFrames?: unknown };
  const found = typeof tree.frame?.id === "string" && tree.frame.url === targetUrl ? [tree.frame.id] : [];
  if (!Array.isArray(tree.childFrames)) return found;
  return tree.childFrames.flatMap((child) => matchingFrameIds(child, targetUrl)).concat(found);
}

function devToolsTargetId(socketUrl: string): string | undefined {
  try {
    const parsed = new URL(socketUrl);
    const match = /^\/devtools\/page\/([^/]+)$/.exec(parsed.pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function detachPlaywrightSession(session: CDPSession): Promise<void> {
  try {
    await session.detach();
  } catch {
    // Detach is best effort; the disposable Chrome lifecycle remains owned by the caller.
  }
}

async function closePlaywrightBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // Closing a CDP attachment detaches it; the disposable Chrome stays alive for Roll Capture.
  }
}

async function visibleLocator(frame: Frame, selector: string): Promise<Locator> {
  const first = frame.locator(selector).first();
  try {
    await first.waitFor({ state: "visible", timeout: PREPARE_FRAME_ATTEMPTS * PREPARE_FRAME_INTERVAL_MS });
  } catch {
    throw new Error(`prepare selector did not resolve to a visible element: ${selector}`);
  }
  if (!await first.isVisible()) throw new Error("prepare selector is not visible");
  return first;
}

async function assertSafePrepareFillTarget(locator: Locator): Promise<void> {
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  if (tagName !== "input" && tagName !== "textarea") throw new Error("prepare fill target must be an input or textarea");
  if (await locator.getAttribute("contenteditable") !== null) throw new Error("prepare does not fill contenteditable fields");
  if (tagName === "input" && (await locator.getAttribute("type"))?.toLowerCase() === "password") {
    throw new Error("prepare does not fill password fields");
  }
}

function devToolsHttpEndpoint(socketUrl: string): string | undefined {
  try {
    const parsed = new URL(socketUrl);
    if (parsed.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) return undefined;
    return `http://${parsed.host}`;
  } catch {
    return undefined;
  }
}

export async function runControlledPrepareActions(
  input: { page: ControlledPage; targetUrl: string; actions: readonly ControlledPrepareAction[] },
  deps: ControlledPrepareDeps = { connect: openLoopbackCdpSession, sleep: sleepForPrepare },
): Promise<void> {
  const cdp = await deps.connect(input.page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("DOM.enable");
    const targetOrigin = loopbackOrigin(input.targetUrl);
    if (targetOrigin === undefined) throw new Error("controlled prepare target must remain loopback");
    const frameId = await waitForInitialPrepareFrame(cdp, input.targetUrl, deps.sleep);
    if (frameId === undefined) throw new Error("controlled prepare target frame was not found");
    for (const action of input.actions) {
      if (action.kind === "wait") {
        await deps.sleep(action.ms);
      } else {
        const contextId = await isolatedFrameContext(cdp, frameId);
        if (action.kind === "click") await dispatchPhysicalPrepareClick(cdp, contextId, frameId, action.selector);
        if (action.kind === "fill") await evaluatePrepare(cdp, contextId, fillPrepareExpression(action.selector, action.value));
        if (action.kind === "scroll") await evaluatePrepare(cdp, contextId, scrollPrepareExpression(action.selector));
      }
      if (!await originalPrepareFrameRemainsLocal(cdp, frameId, targetOrigin)) {
        throw new Error("controlled prepare action left the original loopback origin");
      }
    }
  } finally {
    await closePrepareSession(cdp);
  }
}

async function findInitialPrepareFrame(cdp: CdpSession, targetUrl: string): Promise<string | undefined> {
  const tree = await cdp.send("Page.getFrameTree") as { frameTree?: unknown };
  return findFrame(tree.frameTree, (url) => url === targetUrl);
}

async function waitForInitialPrepareFrame(cdp: CdpSession, targetUrl: string, sleep: (ms: number) => Promise<void>): Promise<string | undefined> {
  for (let attempt = 0; attempt < PREPARE_FRAME_ATTEMPTS; attempt += 1) {
    const frameId = await findInitialPrepareFrame(cdp, targetUrl);
    if (frameId !== undefined) return frameId;
    await sleep(PREPARE_FRAME_INTERVAL_MS);
  }
  return undefined;
}

async function originalPrepareFrameRemainsLocal(cdp: CdpSession, frameId: string, targetOrigin: string): Promise<boolean> {
  const tree = await cdp.send("Page.getFrameTree") as { frameTree?: unknown };
  return findFrame(tree.frameTree, (url, id) => id === frameId && originOf(url) === targetOrigin) !== undefined;
}

function findFrame(value: unknown, matches: (url: string, id: string) => boolean): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tree = value as { frame?: { id?: unknown; url?: unknown }; childFrames?: unknown };
  if (typeof tree.frame?.id === "string" && typeof tree.frame.url === "string" && matches(tree.frame.url, tree.frame.id)) return tree.frame.id;
  if (!Array.isArray(tree.childFrames)) return undefined;
  for (const child of tree.childFrames) {
    const found = findFrame(child, matches);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function isolatedFrameContext(cdp: CdpSession, frameId: string): Promise<number> {
  const result = await cdp.send("Page.createIsolatedWorld", { frameId, grantUniveralAccess: false }) as { executionContextId?: unknown };
  if (typeof result.executionContextId !== "number") throw new Error("controlled prepare could not create an isolated frame context");
  return result.executionContextId;
}

async function evaluatePrepare(cdp: CdpSession, contextId: number, expression: string): Promise<void> {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
  }) as { exceptionDetails?: { text?: unknown; exception?: { description?: unknown } } };
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "prepare action failed";
    throw new Error(typeof detail === "string" ? detail : "prepare action failed");
  }
}

async function dispatchPhysicalPrepareClick(cdp: CdpSession, contextId: number, frameId: string, selector: string): Promise<void> {
  const point = await evaluatePrepareValue(cdp, contextId, clickPointPrepareExpression(selector));
  if (!isPrepareClickPoint(point)) throw new Error("prepare click target has no usable visible point");
  const offset = await prepareFrameOffset(cdp, frameId);
  const x = point.x + offset.x;
  const y = point.y + offset.y;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function evaluatePrepareValue(cdp: CdpSession, contextId: number, expression: string): Promise<unknown> {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
  }) as { result?: { value?: unknown }; exceptionDetails?: { text?: unknown; exception?: { description?: unknown } } };
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "prepare action failed";
    throw new Error(typeof detail === "string" ? detail : "prepare action failed");
  }
  return result.result?.value;
}

function isPrepareClickPoint(value: unknown): value is { x: number; y: number } {
  if (typeof value !== "object" || value === null) return false;
  const point = value as { x?: unknown; y?: unknown };
  return typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y);
}

async function prepareFrameOffset(cdp: CdpSession, frameId: string): Promise<{ x: number; y: number }> {
  const tree = await cdp.send("Page.getFrameTree") as { frameTree?: unknown };
  const ancestors = frameAncestors(tree.frameTree, frameId);
  if (ancestors === undefined) throw new Error("controlled prepare target frame was not found");
  let x = 0;
  let y = 0;
  for (const childFrameId of ancestors) {
    const owner = await cdp.send("DOM.getFrameOwner", { frameId: childFrameId }) as { backendNodeId?: unknown };
    if (typeof owner.backendNodeId !== "number") throw new Error("prepare click target frame owner was not found");
    const model = await cdp.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }) as { model?: { content?: unknown } };
    const content = model.model?.content;
    if (!Array.isArray(content) || content.length !== 8 || content.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) {
      throw new Error("prepare click target frame has no usable visible point");
    }
    x += Math.min(content[0], content[2], content[4], content[6]);
    y += Math.min(content[1], content[3], content[5], content[7]);
  }
  return { x, y };
}

function frameAncestors(value: unknown, targetFrameId: string, ancestors: readonly string[] = []): readonly string[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tree = value as { frame?: { id?: unknown }; childFrames?: unknown };
  if (tree.frame?.id === targetFrameId) return ancestors;
  if (!Array.isArray(tree.childFrames)) return undefined;
  for (const child of tree.childFrames) {
    if (typeof child !== "object" || child === null) continue;
    const childFrame = child as { frame?: { id?: unknown } };
    if (typeof childFrame.frame?.id !== "string") continue;
    const found = frameAncestors(child, targetFrameId, [...ancestors, childFrame.frame.id]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function clickPointPrepareExpression(selector: string): string {
  return `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error("prepare click selector not found"); const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") throw new Error("prepare click target has no usable visible point"); const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2; if (!element.contains(document.elementFromPoint(x, y))) throw new Error("prepare click target has no usable visible point"); return { x, y }; })()`;
}

function fillPrepareExpression(selector: string, value: string): string {
  return `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error("prepare fill selector is not fillable"); if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") throw new Error("prepare does not fill password fields"); const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype; const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set; if (setValue === undefined) throw new Error("prepare fill value setter unavailable"); setValue.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); })()`;
}

function scrollPrepareExpression(selector: string): string {
  return `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error("prepare scroll selector not found"); element.scrollIntoView({ block: "center", inline: "nearest" }); })()`;
}

function loopbackOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

async function sleepForPrepare(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function closePrepareSession(cdp: CdpSession): Promise<void> {
  try {
    await cdp.close();
  } catch {
    // The disposable browser and profile cleanup still run after a lost socket.
  }
}

function localUrlFailure(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "controlled local window capture requires a valid loopback URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "controlled local window capture only permits loopback HTTP(S) pages";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "controlled local window capture refuses URL credentials";
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) {
    return "controlled local window capture only permits loopback pages";
  }
  return undefined;
}

export function isLoopbackCaptureUrl(raw: string): boolean {
  return localUrlFailure(raw) === undefined;
}

async function waitForExactLocalPage(
  endpoint: string,
  expectedUrl: string,
  deps: ControlledLocalWindowCaptureDeps,
): Promise<ControlledPage | null> {
  for (let attempt = 0; attempt < PAGE_DISCOVERY_ATTEMPTS; attempt += 1) {
    let page: ControlledPage | null = null;
    try {
      page = await deps.pages.find({ endpoint, expectedUrl });
    } catch {
      // Chrome has not bound its private loopback port yet. The bounded retry
      // remains inside the isolated process and never falls back to owner Chrome.
    }
    if (page !== null) return page;
    await deps.sleep(PAGE_DISCOVERY_INTERVAL_MS);
  }
  return null;
}

async function killQuietly(chrome: ChromeProcess): Promise<void> {
  try {
    await chrome.kill();
  } catch {
    // The profile cleanup below still runs if Chrome was already gone.
  }
}

async function removeQuietly(path: string, deps: ControlledLocalWindowCaptureDeps): Promise<void> {
  try {
    await deps.fs.rm(path, { recursive: true, force: true });
  } catch {
    // A failed cleanup never changes the truthful capture result.
  }
}

async function closeWrapperQuietly(wrapper: ControlledCaptureWrapper): Promise<void> {
  try {
    await wrapper.close();
  } catch {
    // The browser/profile cleanup still completed; a local wrapper cannot turn
    // a truthful capture result into a false success.
  }
}

async function createControlledCaptureWrapper(input: { url: string; storyId: string }): Promise<ControlledCaptureWrapper> {
  const { createServer } = await import("node:http");
  const nonce = randomNonce();
  const windowTitle = `Roll Capture ${safeStoryLabel(input.storyId)} ${nonce}`;
  const frameOrigin = new URL(input.url).origin;
  const body = [
    "<!doctype html>",
    `<title>${escapeHtml(windowTitle)}</title>`,
    "<style>html,body,iframe{margin:0;border:0;width:100%;height:100%;overflow:hidden}</style>",
    `<iframe title="synthetic capture target" src="${escapeHtmlAttribute(input.url)}"></iframe>`,
  ].join("");
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-src ${frameOrigin}`,
    });
    response.end(body);
  });
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        server.close(() => reject(new Error("could not allocate the local capture wrapper")));
        return;
      }
      resolve({ port: bound.port });
    });
  });
  return {
    url: `http://127.0.0.1:${address.port}/`,
    windowTitle,
    close: () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

function randomNonce(): string {
  // macOS may truncate long app-window names in CGWindow metadata. A 48-bit
  // nonce keeps the selector short while making collisions impractical.
  return randomUUID().replace(/-/gu, "").slice(0, 12);
}

function safeStoryLabel(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 48);
  return sanitized === "" ? "evidence" : sanitized;
}

function escapeHtml(raw: string): string {
  return raw.replace(/[&<>]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] ?? char);
}

function escapeHtmlAttribute(raw: string): string {
  return escapeHtml(raw).replace(/"/gu, "&quot;");
}

function defaultControlledPagePort(): ControlledPagePort {
  return {
    async find({ endpoint, expectedUrl }) {
      const response = await fetch(`${endpoint}/json/list`);
      if (!response.ok) return null;
      const targets = await response.json();
      if (!Array.isArray(targets)) return null;
      for (const target of targets) {
        if (!isExactLocalPage(target, expectedUrl)) continue;
        return { url: target.url, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
      }
      return null;
    },
  };
}

function isExactLocalPage(value: unknown, expectedUrl: string): value is ControlledPage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate["type"] === "page" &&
    candidate["url"] === expectedUrl &&
    typeof candidate["webSocketDebuggerUrl"] === "string" &&
    isLoopbackWebSocket(candidate["webSocketDebuggerUrl"]);
}

function isLoopbackWebSocket(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a loopback debugging port")));
        return;
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}
