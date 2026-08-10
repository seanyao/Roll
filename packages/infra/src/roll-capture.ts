/**
 * @responsibility Runs the roll-capture binary for physical evidence.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  CaptureIntentV2,
  CaptureProtocolAdvertisement,
  CaptureProtocolNegotiation,
  CaptureReceiptV2,
  RollCaptureRequestV1,
  RollCaptureResponseV1,
} from "@roll/spec";
import {
  negotiateCaptureProtocol,
  parseCaptureProtocolAdvertisement,
  parseCaptureReceiptV2,
  parseRollCaptureResponseV1,
  validateCaptureReceiptV2,
  validateRollCaptureResponseV1,
} from "@roll/spec";

export type RollCaptureProviderResult =
  | { status: "taken"; path: string; response: RollCaptureResponseV1 }
  | { status: "skipped"; reason: string; response: RollCaptureResponseV1 }
  | { status: "failed"; reason: string; response: RollCaptureResponseV1 }
  | { status: "timeout"; reason: string };

export type RollCaptureWaitOptions = {
  timeoutMs: number;
  pollIntervalMs?: number;
};

export interface RollCaptureProviderPort {
  writeRequest(request: RollCaptureRequestV1): Promise<void>;
  readResponse(request: RollCaptureRequestV1): Promise<RollCaptureResponseV1 | null>;
  waitForResponse(request: RollCaptureRequestV1, options: RollCaptureWaitOptions): Promise<RollCaptureProviderResult>;
}

export type RollCaptureProviderOptions = {
  root?: string;
  defaultPollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_POLL_INTERVAL_MS = 250;

export type RollCaptureResponseReadProblem =
  | { stage: "read"; error: unknown }
  | { stage: "parse"; error: unknown }
  | { stage: "shape"; value: unknown; request: RollCaptureRequestV1 };

export type RollCaptureResponseReadProblemClassification = {
  kind: "transient" | "terminal";
  reason: string;
};

export class RollCaptureProvider implements RollCaptureProviderPort {
  readonly root: string;
  readonly inbox: string;
  readonly responses: string;
  private readonly defaultPollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RollCaptureProviderOptions = {}) {
    this.root = options.root ?? defaultRollCaptureRoot();
    this.inbox = join(this.root, "inbox");
    this.responses = join(this.root, "responses");
    this.defaultPollIntervalMs = options.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  async writeRequest(request: RollCaptureRequestV1): Promise<void> {
    await this.ensureLayout();
    const path = this.requestPath(request.requestId);
    if ((await fileExists(path)) || (await fileExists(this.responsePath(request.requestId)))) {
      throw new Error(`duplicate_request_id: ${request.requestId}`);
    }
    await writeAtomically(JSON.stringify(request, null, 2) + "\n", path);
  }

  async readResponse(request: RollCaptureRequestV1): Promise<RollCaptureResponseV1 | null> {
    const path = this.responsePath(request.requestId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new RollCaptureResponseReadError(classifyRollCaptureResponseReadProblem({ stage: "parse", error }));
    }
    const response = parseRollCaptureResponseV1(value);
    if (response === null) throw new RollCaptureResponseReadError(classifyRollCaptureResponseReadProblem({ stage: "shape", value, request }));
    const validation = validateRollCaptureResponseV1(response, request);
    if (!validation.ok) throw new RollCaptureResponseReadError({ kind: "terminal", reason: validation.errors.join("; ") });
    return response;
  }

  async waitForResponse(request: RollCaptureRequestV1, options: RollCaptureWaitOptions): Promise<RollCaptureProviderResult> {
    await this.ensureLayout();
    const timeoutMs = Math.max(0, options.timeoutMs);
    const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? this.defaultPollIntervalMs);
    const startedAt = this.now();
    const deadline = startedAt + timeoutMs;

    while (this.now() <= deadline) {
      try {
        const response = await this.readResponse(request);
        if (response !== null) return resultFromResponse(response);
      } catch (error) {
        if (error instanceof RollCaptureResponseReadError && error.classification.kind === "transient") {
          const remainingMs = deadline - this.now();
          if (remainingMs <= 0) break;
          await this.sleep(Math.min(pollIntervalMs, remainingMs));
          continue;
        }
        return { status: "failed", reason: error instanceof Error ? error.message : String(error), response: failedResponse(request, this.responsePath(request.requestId), error) };
      }
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) break;
      await this.sleep(Math.min(pollIntervalMs, remainingMs));
    }

    return {
      status: "timeout",
      reason: `timed out after ${timeoutMs}ms waiting for ${this.responsePath(request.requestId)}`,
    };
  }

  requestPath(requestId: string): string {
    return join(this.inbox, `request-${requestId}.json`);
  }

  responsePath(requestId: string): string {
    return join(this.responses, `response-${requestId}.json`);
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.inbox, { recursive: true });
    await mkdir(this.responses, { recursive: true });
  }
}

export function defaultRollCaptureRoot(home = homedir()): string {
  return join(home, "Library", "Application Support", "Roll Capture");
}

export function classifyRollCaptureResponseReadProblem(problem: RollCaptureResponseReadProblem): RollCaptureResponseReadProblemClassification {
  if (problem.stage === "read") {
    if (isNodeError(problem.error) && problem.error.code === "ENOENT") return { kind: "transient", reason: "response file is not ready yet" };
    return { kind: "terminal", reason: problem.error instanceof Error ? problem.error.message : String(problem.error) };
  }
  if (problem.stage === "parse") {
    return { kind: "transient", reason: `malformed response JSON: ${problem.error instanceof Error ? problem.error.message : String(problem.error)}` };
  }

  const value = problem.value;
  if (!isRecord(value)) return { kind: "terminal", reason: "response JSON must be an object" };
  const protocol = value["protocol"];
  if (protocol !== problem.request.protocol) {
    return { kind: "terminal", reason: `response protocol "${String(protocol)}" does not match request protocol "${problem.request.protocol}"` };
  }
  const requestId = value["requestId"];
  if (requestId !== problem.request.requestId) {
    return { kind: "terminal", reason: `response id "${String(requestId)}" does not match request id "${problem.request.requestId}"` };
  }
  const status = value["status"];
  if (status !== "taken" && status !== "skipped" && status !== "failed") {
    return { kind: "terminal", reason: `response status "${String(status)}" is not one of taken, skipped, failed` };
  }
  return { kind: "terminal", reason: "response JSON does not match roll.capture.v1 schema" };
}

class RollCaptureResponseReadError extends Error {
  readonly classification: RollCaptureResponseReadProblemClassification;

  constructor(classification: RollCaptureResponseReadProblemClassification) {
    super(classification.reason);
    this.name = "RollCaptureResponseReadError";
    this.classification = classification;
  }
}

async function writeAtomically(data: string, path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, data, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function resultFromResponse(response: RollCaptureResponseV1): RollCaptureProviderResult {
  if (response.status === "taken") {
    if (response.screenshotPath === undefined || response.screenshotPath.length === 0) {
      return { status: "failed", reason: "taken response did not include screenshotPath", response };
    }
    return { status: "taken", path: response.screenshotPath, response };
  }
  if (response.status === "skipped") {
    return { status: "skipped", reason: response.reason ?? "Roll Capture skipped without a reason", response };
  }
  return { status: "failed", reason: response.reason ?? "Roll Capture failed without a reason", response };
}

function failedResponse(request: RollCaptureRequestV1, responsePath: string, error: unknown): RollCaptureResponseV1 {
  const now = new Date().toISOString();
  return {
    protocol: request.protocol,
    requestId: request.requestId,
    status: "failed",
    responsePath,
    reason: error instanceof Error ? error.message : String(error),
    host: {
      appName: "Roll Capture.app",
      bundleId: "com.seanyao.roll.capture",
      version: "unknown",
    },
    startedAt: now,
    finishedAt: now,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════════════════════════════════════
// US-PHYSICAL-009 — Capture Gateway v2: protocol negotiation + receipt store
//
// This transport NEVER reads ROLL_NO_SCREENCAP: that ban gates only the
// Runner's direct native lane (packages/infra/src/screenshot.ts). An ambient
// environment switch must never silently turn off the v2 gateway.
// ════════════════════════════════════════════════════════════════════════════

/** Default location of the host capability advertisement file. */
export function captureHostAdvertisementPath(root: string): string {
  return join(root, "capabilities.json");
}

/**
 * Read the host's advertised protocol capabilities. A missing / unreadable /
 * malformed file returns `null` — a legacy host that advertised nothing, which
 * {@link negotiateCaptureProtocol} treats as "v2 never guessed".
 */
export async function readCaptureHostAdvertisement(root: string): Promise<CaptureProtocolAdvertisement | null> {
  let raw: string;
  try {
    raw = await readFile(captureHostAdvertisementPath(root), "utf8");
  } catch {
    return null;
  }
  try {
    return parseCaptureProtocolAdvertisement(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Negotiate capture protocol readiness from the host's advertisement on disk. */
export async function negotiateRollCaptureProtocol(root: string): Promise<CaptureProtocolNegotiation> {
  return negotiateCaptureProtocol(await readCaptureHostAdvertisement(root));
}

/** Append-only CaptureSet index: attempts for one storyId+runId+surfaceId. */
export interface CaptureSetIndex {
  captureSetId: string;
  storyId: string;
  runId: string;
  surfaceId: string;
  /** Attempt request ids, in append order. Retries add; nothing is removed. */
  attempts: string[];
  /** The first accepted (taken) receipt id — frozen once set; never overwritten. */
  acceptedReceiptId: string | null;
}

export type RollCaptureReceiptPersistResult =
  | { status: "persisted"; receipt: CaptureReceiptV2; captureSetId: string; accepted: boolean }
  | { status: "duplicate"; receipt: CaptureReceiptV2; captureSetId: string; accepted: boolean }
  | { status: "rejected"; reason: string; captureSetId: string; existing?: CaptureReceiptV2 };

export type RollCaptureReceiptStoreOptions = {
  root?: string;
};

/**
 * Durable store for accepted v2 receipts.
 *
 * Contract (AC4):
 * - a duplicate request id with identical content returns the persisted receipt;
 * - a duplicate request id with DIFFERENT content is rejected, never overwriting;
 * - a retry uses a new request id, joins the same CaptureSet, and CANNOT
 *   overwrite an already-accepted (taken) receipt;
 * - malformed / mismatched / missing-artifact receipts are rejected before any
 *   write, so a prior taken receipt is never disturbed.
 */
export class RollCaptureReceiptStore {
  readonly root: string;
  readonly receipts: string;

  constructor(options: RollCaptureReceiptStoreOptions = {}) {
    this.root = options.root ?? defaultRollCaptureRoot();
    this.receipts = join(this.root, "receipts");
  }

  captureSetId(keys: Pick<CaptureReceiptV2, "storyId" | "runId" | "surfaceId">): string {
    return createHash("sha256").update(`${keys.storyId} ${keys.runId} ${keys.surfaceId}`).digest("hex").slice(0, 32);
  }

  receiptPath(requestId: string): string {
    return join(this.receipts, `receipt-${safeReceiptFileId(requestId)}.json`);
  }

  setPath(captureSetId: string): string {
    return join(this.receipts, `set-${captureSetId}.json`);
  }

  async persistReceipt(intent: CaptureIntentV2, receipt: CaptureReceiptV2): Promise<RollCaptureReceiptPersistResult> {
    const captureSetId = this.captureSetId(receipt);

    const validation = validateCaptureReceiptV2(receipt, intent);
    if (!validation.ok) {
      return { status: "rejected", reason: validation.errors.join("; "), captureSetId };
    }

    const path = this.receiptPath(receipt.requestId);
    const existingRaw = await readFileOrNull(path);
    if (existingRaw !== null) {
      const existing = parseCaptureReceiptV2(safeJsonParse(existingRaw));
      if (existing === null) {
        return { status: "rejected", reason: `existing receipt for "${receipt.requestId}" is malformed; refusing to overwrite`, captureSetId };
      }
      if (sameReceiptContent(existing, receipt)) {
        const index = await this.readCaptureSet(captureSetId);
        return { status: "duplicate", receipt: existing, captureSetId, accepted: index?.acceptedReceiptId === existing.requestId };
      }
      return {
        status: "rejected",
        reason: `duplicate_request_id_different_content: "${receipt.requestId}" already persisted with different content`,
        captureSetId,
        existing,
      };
    }

    await writeAtomically(JSON.stringify(receipt, null, 2) + "\n", path);

    const index = (await this.readCaptureSet(captureSetId)) ?? {
      captureSetId,
      storyId: receipt.storyId,
      runId: receipt.runId,
      surfaceId: receipt.surfaceId,
      attempts: [],
      acceptedReceiptId: null,
    };
    if (!index.attempts.includes(receipt.requestId)) index.attempts.push(receipt.requestId);
    // Freeze the first accepted (taken) receipt; a later taken attempt is
    // recorded but NEVER overwrites the accepted artifact.
    if (index.acceptedReceiptId === null && receipt.state === "taken") {
      index.acceptedReceiptId = receipt.requestId;
    }
    await writeAtomically(JSON.stringify(index, null, 2) + "\n", this.setPath(captureSetId));

    return { status: "persisted", receipt, captureSetId, accepted: index.acceptedReceiptId === receipt.requestId };
  }

  async readReceipt(requestId: string): Promise<CaptureReceiptV2 | null> {
    const raw = await readFileOrNull(this.receiptPath(requestId));
    if (raw === null) return null;
    return parseCaptureReceiptV2(safeJsonParse(raw));
  }

  async readCaptureSet(captureSetId: string): Promise<CaptureSetIndex | null> {
    const raw = await readFileOrNull(this.setPath(captureSetId));
    if (raw === null) return null;
    const value = safeJsonParse(raw);
    if (!isRecord(value)) return null;
    const attempts = Array.isArray(value["attempts"]) ? value["attempts"].filter((x): x is string => typeof x === "string") : [];
    const acceptedReceiptId = typeof value["acceptedReceiptId"] === "string" ? value["acceptedReceiptId"] : null;
    if (typeof value["captureSetId"] !== "string" || typeof value["storyId"] !== "string" || typeof value["runId"] !== "string" || typeof value["surfaceId"] !== "string") {
      return null;
    }
    return { captureSetId: value["captureSetId"], storyId: value["storyId"], runId: value["runId"], surfaceId: value["surfaceId"], attempts, acceptedReceiptId };
  }

  /** The frozen accepted receipt for a CaptureSet, or null when none is taken yet. */
  async readAcceptedReceipt(keys: Pick<CaptureReceiptV2, "storyId" | "runId" | "surfaceId">): Promise<CaptureReceiptV2 | null> {
    const index = await this.readCaptureSet(this.captureSetId(keys));
    if (index === null || index.acceptedReceiptId === null) return null;
    return this.readReceipt(index.acceptedReceiptId);
  }
}

/** Content-identity fields — differ ⇒ "different content" (excludes transport/timing). */
function sameReceiptContent(a: CaptureReceiptV2, b: CaptureReceiptV2): boolean {
  const key = (r: CaptureReceiptV2): string =>
    JSON.stringify({
      storyId: r.storyId,
      runId: r.runId,
      surfaceId: r.surfaceId,
      source: r.source,
      captureClass: r.captureClass,
      state: r.state,
      screenshotPath: r.screenshotPath ?? null,
      sha256: r.sha256 ?? null,
      finalUrl: r.finalUrl ?? null,
      target: r.target ?? null,
      reason: r.reason ?? null,
    });
  return key(a) === key(b);
}

function safeReceiptFileId(requestId: string): string {
  return requestId.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/-+/gu, "-");
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
