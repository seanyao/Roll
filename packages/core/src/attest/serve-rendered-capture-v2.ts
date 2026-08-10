/**
 * @responsibility Serves rendered capture requests through the v2 evidence protocol.
 * US-PHYSICAL-010 — serve `roll.capture.v2` rendered receipts in-process.
 *
 * The CapturePlanner (US-EVID-030) plans `playwright-rendered` lanes; this
 * module is the writer-side serve entry that turns a rendered intent into a
 * durable CaptureReceiptV2. Playwright itself is injected as a port so core
 * stays free of infra side effects (wired later by US-PHYSICAL-013).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  canonicalizeSurfaceUrl,
  validateCaptureIntentV2,
  type CaptureIntentV2,
  type CaptureReceiptV2,
  type CaptureReceiptState,
  type CaptureSource,
} from "@roll/spec";
import type { CaptureReceiptPersistOutcome, CaptureReceiptStorePort } from "./capture-planner.js";

export type { CaptureReceiptPersistOutcome, CaptureReceiptStorePort };

/** Outcome of one headless render attempt against a declared surface URL. */
export type RenderedSurfaceRenderResult =
  | { status: "taken"; screenshotPath: string; finalUrl: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/** Injected Playwright (or test double) that renders one URL to a PNG path. */
export interface RenderedSurfacePort {
  render(input: { url: string; out: string; timeoutMs: number }): Promise<RenderedSurfaceRenderResult>;
}

export interface ServeRenderedCaptureV2Deps {
  projectRoot: string;
  store: CaptureReceiptStorePort;
  render: RenderedSurfacePort;
  /** Durable path recorded on the receipt (typically the store's receipt file). */
  responsePathFor: (requestId: string) => string;
  now?: () => Date;
}

export interface ServeRenderedCaptureV2Result {
  receipt: CaptureReceiptV2;
  persist: CaptureReceiptPersistOutcome;
}

const PHYSICAL_REFUSED_REASON = "physical source served elsewhere";

/**
 * Serve one rendered `roll.capture.v2` intent in-process.
 *
 * - `playwright-rendered` → validate, render headless, digest PNG, persist.
 * - `roll-capture-window` → refuse with {@link PHYSICAL_REFUSED_REASON} (US-PHYSICAL-014).
 * - Login / foreign redirect / disallowed target → `skipped` (never a taken receipt).
 */
/** Deps for building a rendered receipt WITHOUT persisting (US-PHYSICAL-013). */
export type RenderedReceiptDeps = Pick<ServeRenderedCaptureV2Deps, "render" | "responsePathFor" | "projectRoot" | "now">;

/**
 * US-PHYSICAL-013: render a declared surface and return the terminal
 * `CaptureReceiptV2` — WITHOUT persisting. This is the pure render→receipt half
 * of {@link serveRenderedCaptureV2}, reused by the CapturePlanner lane port
 * (which owns persistence). Same invariants: login/foreign-redirect/disallowed →
 * `skipped`, a real taken receipt carries the PNG's sha256 digest.
 */
export async function buildRenderedCaptureReceipt(
  intent: CaptureIntentV2,
  deps: RenderedReceiptDeps,
): Promise<CaptureReceiptV2> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const responsePath = deps.responsePathFor(intent.requestId);

  if (intent.source === "roll-capture-window") {
    return terminalReceipt(intent, "skipped", PHYSICAL_REFUSED_REASON, responsePath, startedAt, now().toISOString());
  }
  if (intent.source !== "playwright-rendered") {
    return terminalReceipt(intent, "skipped", `source "${intent.source}" is not served by serveRenderedCaptureV2`, responsePath, startedAt, now().toISOString());
  }
  const validation = validateCaptureIntentV2(intent, { projectRoot: deps.projectRoot, expectedRequestId: intent.requestId });
  if (!validation.ok) {
    return terminalReceipt(intent, "failed", `invalid intent: ${validation.errors.join("; ")}`, responsePath, startedAt, now().toISOString());
  }

  const rendered = await deps.render.render({
    url: intent.surface.declaredUrl,
    out: intent.out,
    timeoutMs: intent.timeoutMs,
  });

  if (rendered.status === "skipped" || rendered.status === "failed") {
    const state: CaptureReceiptState = rendered.status === "skipped" ? "skipped" : "failed";
    return terminalReceipt(intent, state, rendered.reason, responsePath, startedAt, now().toISOString());
  }

  const canonicalFinal = canonicalizeSurfaceUrl(rendered.finalUrl);
  const surfaceId = intent.surface.id;
  if (canonicalFinal === null || canonicalFinal !== surfaceId) {
    return terminalReceipt(
      intent,
      "skipped",
      `invalid target / redirect: finalUrl "${rendered.finalUrl}" does not equal the declared surface "${surfaceId}"`,
      responsePath,
      startedAt,
      now().toISOString(),
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(rendered.screenshotPath);
  } catch (error) {
    return terminalReceipt(
      intent,
      "failed",
      `rendered PNG missing at "${rendered.screenshotPath}": ${error instanceof Error ? error.message : String(error)}`,
      responsePath,
      startedAt,
      now().toISOString(),
    );
  }
  if (bytes.length === 0) {
    return terminalReceipt(intent, "failed", `rendered PNG at "${rendered.screenshotPath}" is empty`, responsePath, startedAt, now().toISOString());
  }

  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {
    protocol: intent.protocol,
    requestId: intent.requestId,
    storyId: intent.storyId,
    runId: intent.runId,
    surfaceId,
    source: "playwright-rendered",
    captureClass: "rendered",
    state: "taken",
    screenshotPath: rendered.screenshotPath,
    sha256,
    finalUrl: canonicalFinal,
    responsePath,
    startedAt,
    finishedAt: now().toISOString(),
  };
}

export async function serveRenderedCaptureV2(
  intent: CaptureIntentV2,
  deps: ServeRenderedCaptureV2Deps,
): Promise<ServeRenderedCaptureV2Result> {
  const receipt = await buildRenderedCaptureReceipt(intent, deps);
  return finalize(intent, deps, receipt);
}

/**
 * US-PHYSICAL-013: the CapturePlanner rendered-lane executor. `run(intent)`
 * renders → returns a receipt; the planner owns persistence (do NOT persist here).
 */
export function renderedCaptureLanePort(deps: RenderedReceiptDeps): {
  readonly source: "playwright-rendered";
  run(intent: CaptureIntentV2): Promise<CaptureReceiptV2>;
} {
  return {
    source: "playwright-rendered",
    run: (intent) => buildRenderedCaptureReceipt(intent, deps),
  };
}

async function finalize(
  intent: CaptureIntentV2,
  deps: ServeRenderedCaptureV2Deps,
  receipt: CaptureReceiptV2,
): Promise<ServeRenderedCaptureV2Result> {
  const persist = await deps.store.persistReceipt(intent, receipt);
  if (persist.status === "duplicate" || persist.status === "persisted") {
    return { receipt: persist.receipt, persist };
  }
  return { receipt, persist };
}

function terminalReceipt(
  intent: CaptureIntentV2,
  state: Exclude<CaptureReceiptState, "taken">,
  reason: string,
  responsePath: string,
  startedAt: string,
  finishedAt: string,
): CaptureReceiptV2 {
  return {
    protocol: intent.protocol,
    requestId: intent.requestId,
    storyId: intent.storyId,
    runId: intent.runId,
    surfaceId: intent.surface.id,
    source: intent.source,
    captureClass: captureClassFor(intent.source),
    state,
    reason,
    responsePath,
    startedAt,
    finishedAt,
  };
}

function captureClassFor(source: CaptureSource): "physical" | "rendered" {
  return source === "playwright-rendered" ? "rendered" : "physical";
}
