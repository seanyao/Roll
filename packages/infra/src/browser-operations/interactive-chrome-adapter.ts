/**
 * @responsibility Connects the owner Chrome for explicitly approved operations.
 */
/**
 * US-BROW-008b — owner Chrome connector for explicitly approved operations.
 *
 * This adapter deliberately owns only the short-lived DevTools connection. It
 * never launches, kills, or otherwise controls the owner's Chrome process.
 */
import { authorizeOrigin } from "@roll/core";
import type { BrowserActionResult, BrowserDenialReason, BrowserLease, BrowserLanePolicy } from "@roll/spec";
import type { CdpSession } from "./managed-chrome-adapter.js";

export type InteractiveLowRiskAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "press_key"; key: string };

export interface OwnerChromeTarget {
  id: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface InteractiveChromeAdapterDeps {
  /** Discover tabs from an already-running, loopback-only Chrome endpoint. */
  discoverTargets(): Promise<readonly OwnerChromeTarget[]>;
  /** Open a DevTools session to one of the discovered targets. */
  connect(target: OwnerChromeTarget): Promise<CdpSession>;
  nowMs(): number;
}

export type InteractiveOperationResult =
  | { kind: "completed"; tabId: string; result: BrowserActionResult; ciPassed: false }
  | { kind: "denied"; reason: BrowserDenialReason; ciPassed: false };

const OWNER_LANE_POLICY = (origin: string): BrowserLanePolicy => ({
  enabled: true,
  allowedOrigins: [origin],
  allowedActions: ["navigate", "click", "fill", "press_key"],
  requireOwnerApproval: true,
});

/**
 * Executes one closed-vocabulary action against a tab whose origin exactly
 * matches the approved origin. It has no cookie, storage, or network-body API.
 */
export class InteractiveChromeAdapter {
  constructor(private readonly deps: InteractiveChromeAdapterDeps) {}

  async execute(input: {
    lease: BrowserLease;
    origin: string;
    action: InteractiveLowRiskAction;
  }): Promise<InteractiveOperationResult> {
    if (Date.parse(input.lease.expiresAt) <= this.deps.nowMs()) {
      return denied("interactive_lease_expired", "The approved owner Chrome lease has expired");
    }

    const policy = OWNER_LANE_POLICY(input.origin);
    const approvedOrigin = originFor(input.origin);
    if (approvedOrigin === undefined) {
      return denied("origin_invalid", "The approved origin is invalid");
    }
    const tab = (await this.deps.discoverTargets()).find(
      (candidate) => originFor(candidate.url) === approvedOrigin && isLoopbackDevToolsSocket(candidate.webSocketDebuggerUrl),
    );
    if (tab === undefined) {
      return denied("devtools_unavailable", "No owner Chrome tab matches the approved origin", { origin: approvedOrigin });
    }

    let cdp: CdpSession | undefined;
    try {
      cdp = await this.deps.connect(tab);
      const result = await this.runAction(cdp, input.action, policy);
      return { kind: "completed", tabId: tab.id, result, ciPassed: false };
    } catch (error) {
      return denied("devtools_unavailable", error instanceof Error ? error.message : "Owner Chrome DevTools connection failed");
    } finally {
      if (cdp !== undefined) await closeQuietly(cdp);
    }
  }

  private async runAction(cdp: CdpSession, action: InteractiveLowRiskAction, policy: BrowserLanePolicy): Promise<BrowserActionResult> {
    switch (action.kind) {
      case "navigate":
        this.assertApprovedUrl(action.url, policy);
        await cdp.send("Page.navigate", { url: action.url });
        await this.assertCurrentOrigin(cdp, policy);
        return result("ok", `navigated to approved origin`);
      case "click":
        await this.assertCurrentOrigin(cdp, policy);
        await cdp.send("Runtime.evaluate", { expression: clickExpression(action.selector), awaitPromise: true });
        await this.assertCurrentOrigin(cdp, policy);
        return result("ok", "clicked approved selector");
      case "fill":
        await this.assertCurrentOrigin(cdp, policy);
        await cdp.send("Runtime.evaluate", { expression: fillExpression(action.selector, action.value), awaitPromise: true });
        await this.assertCurrentOrigin(cdp, policy);
        return result("ok", "filled approved selector");
      case "press_key":
        await this.assertCurrentOrigin(cdp, policy);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: action.key });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: action.key });
        await this.assertCurrentOrigin(cdp, policy);
        return result("ok", "sent approved key");
    }
  }

  private async assertCurrentOrigin(cdp: CdpSession, policy: BrowserLanePolicy): Promise<void> {
    const response = await cdp.send("Runtime.evaluate", { expression: "window.location.href", returnByValue: true }) as { result?: { value?: unknown } };
    const url = response.result?.value;
    if (typeof url !== "string") throw new Error("Owner Chrome did not return its current URL");
    this.assertApprovedUrl(url, policy);
  }

  private assertApprovedUrl(url: string, policy: BrowserLanePolicy): void {
    const authorization = authorizeOrigin(url, policy);
    if (!authorization.authorized) throw new Error("Operation left the approved origin");
  }
}

/** Create the production connector for a Chrome instance the owner started. */
export function createLoopbackOwnerChromeAdapter(endpoint: string): InteractiveChromeAdapter {
  const base = loopbackEndpoint(endpoint);
  return new InteractiveChromeAdapter({
    discoverTargets: async () => {
      const response = await fetch(new URL("/json/list", base));
      if (!response.ok) throw new Error(`Owner Chrome target list returned ${response.status}`);
      const parsed = await response.json();
      if (!Array.isArray(parsed)) throw new Error("Owner Chrome target list is invalid");
      return parsed.flatMap((target): OwnerChromeTarget[] => {
        if (!isOwnerChromeTarget(target)) return [];
        return [{ id: target.id, url: target.url, webSocketDebuggerUrl: target.webSocketDebuggerUrl }];
      });
    },
    connect: async (target) => openLoopbackCdpSession(target.webSocketDebuggerUrl),
    nowMs: Date.now,
  });
}

function originFor(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function clickExpression(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)})?.click()`;
}

function fillExpression(selector: string, value: string): string {
  // React (and other controlled-input frameworks) install a value tracker and
  // override the element's `value` setter. A bare `el.value = x` advances that
  // tracker in lockstep, so the subsequent `input` event looks like a no-op and
  // `onChange` never fires — the typed value is lost on submit (#1446). Driving
  // the NATIVE prototype setter leaves the tracker stale, so the bubbling
  // `input` event makes React observe the change exactly as user typing would.
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("selector not found"); if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error("selector is not fillable"); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set; if (setter) { setter.call(el, ${JSON.stringify(value)}); } else { el.value = ${JSON.stringify(value)}; } el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); })()`;
}

function result(status: BrowserActionResult["status"], redactedSummary: string): BrowserActionResult {
  return { runId: "interactive-owner", actionId: "owner-approved", status, diagnosticRefs: [], redactedSummary };
}

function denied(code: BrowserDenialReason["code"], message: string, detail?: Record<string, unknown>): InteractiveOperationResult {
  return { kind: "denied", reason: { code, message, detail }, ciPassed: false };
}

async function closeQuietly(cdp: CdpSession): Promise<void> {
  try {
    await cdp.close();
  } catch {
    // A lost DevTools socket must not be retried as a background operation.
  }
}

function loopbackEndpoint(endpoint: string): URL {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) {
    throw new Error("Owner Chrome debug endpoint must be an already-open loopback HTTP endpoint");
  }
  return parsed;
}

function isOwnerChromeTarget(value: unknown): value is OwnerChromeTarget {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.url === "string" && typeof candidate.webSocketDebuggerUrl === "string";
}

function isLoopbackDevToolsSocket(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "ws:" || parsed.protocol === "wss:") && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

interface SocketLike {
  send(text: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error", listener: (event: { data?: unknown }) => void): void;
}

/**
 * Open a DevTools session only when the discovered socket remains loopback.
 *
 * The controlled local-capture lane reuses this transport for its disposable
 * profile; it never discovers or connects to an owner Chrome endpoint.
 */
export async function openLoopbackCdpSession(url: string): Promise<CdpSession> {
  if (!isLoopbackDevToolsSocket(url)) throw new Error("DevTools WebSocket must remain loopback");
  const Socket = (globalThis as Record<string, unknown>)["WebSocket"];
  if (typeof Socket !== "function") throw new Error("WebSocket is unavailable in this runtime");
  const socket = new (Socket as new (url: string) => SocketLike)(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Owner Chrome DevTools connection timed out")), 5_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Owner Chrome DevTools connection failed")); });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data ?? "")) as { id?: unknown; result?: unknown; error?: { message?: unknown } };
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (request === undefined) return;
      if (message.error !== undefined) request.reject(new Error(String(message.error.message ?? "DevTools error")));
      else request.resolve(message.result);
    } catch {
      // Ignore malformed unsolicited DevTools messages.
    }
  });
  return {
    send(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
      });
    },
    close: async () => { socket.close(); },
  };
}
