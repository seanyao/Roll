/**
 * @responsibility Declares the capture evidence type vocabulary.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import type { JsonSchema } from "./json-schema.js";
import type { ToolDeclaration } from "./tool.js";

export const ROLL_CAPTURE_PROTOCOL_V1 = "roll.capture.v1";
export const ROLL_CAPTURE_PROVIDER = "roll-capture";
export const ROLL_CAPTURE_PLATFORM = "darwin";
export const ROLL_CAPTURE_HOST_APP_NAME = "Roll Capture.app";
export const ROLL_CAPTURE_HOST_BUNDLE_ID = "com.seanyao.roll.capture";

export type CaptureKind = "web" | "terminal" | "physical_terminal" | "region" | "display";
export type CaptureStatus = "taken" | "skipped" | "failed";

export type CaptureTarget =
  | { type: "window"; appName: string; windowTitle?: string }
  | { type: "region"; x: number; y: number; width: number; height: number }
  | { type: "display"; displayId?: string };

export type RollCaptureRequestV1 = {
  protocol: typeof ROLL_CAPTURE_PROTOCOL_V1;
  requestId: string;
  storyId?: string;
  runId?: string;
  kind: CaptureKind;
  target: CaptureTarget;
  out: string;
  timeoutMs: number;
  createdAt: string;
};

export type CaptureHost = {
  appName: typeof ROLL_CAPTURE_HOST_APP_NAME;
  bundleId: typeof ROLL_CAPTURE_HOST_BUNDLE_ID;
  version: string;
};

export type RollCaptureResponseV1 = {
  protocol: typeof ROLL_CAPTURE_PROTOCOL_V1;
  requestId: string;
  status: CaptureStatus;
  screenshotPath?: string;
  responsePath: string;
  reason?: string;
  /** US-PHYSICAL-007 — captured image dimensions, supplied by the host when available. */
  imageWidth?: number;
  /** US-PHYSICAL-007 — captured image dimensions, supplied by the host when available. */
  imageHeight?: number;
  host: CaptureHost;
  startedAt: string;
  finishedAt: string;
};

export type CaptureLedgerEntry = {
  requestId: string;
  storyId?: string;
  runId?: string;
  kind?: CaptureKind;
  status: CaptureStatus;
  screenshotPath?: string;
  responsePath: string;
  reportPath?: string;
  attachedToReport: boolean;
  reason?: string;
  startedAt: string;
  finishedAt: string;
};

export type RollCaptureValidationResult =
  | { ok: true; errors: [] }
  | { ok: false; errors: readonly string[] };

export type RollCaptureRequestValidationOptions = {
  projectRoot: string;
  expectedRequestId?: string;
};

const stringSchema: JsonSchema = { type: "string" };
const nonEmptyStringSchema: JsonSchema = { type: "string", minLength: 1 };
const integerSchema: JsonSchema = { type: "integer" };
const booleanSchema: JsonSchema = { type: "boolean" };
const numberSchema: JsonSchema = { type: "number" };

function objectSchema(properties: Readonly<Record<string, JsonSchema>>, required: readonly string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const captureKindSchema: JsonSchema = { type: "string", enum: ["web", "terminal", "physical_terminal", "region", "display"] };
const captureStatusSchema: JsonSchema = { type: "string", enum: ["taken", "skipped", "failed"] };
const captureTargetSchema: JsonSchema = {
  oneOf: [
    objectSchema({ type: { const: "window" }, appName: nonEmptyStringSchema, windowTitle: stringSchema }, ["type", "appName"]),
    objectSchema({ type: { const: "region" }, x: integerSchema, y: integerSchema, width: integerSchema, height: integerSchema }, ["type", "x", "y", "width", "height"]),
    objectSchema({ type: { const: "display" }, displayId: stringSchema }, ["type"]),
  ],
};
const captureHostSchema = objectSchema(
  {
    appName: { const: ROLL_CAPTURE_HOST_APP_NAME },
    bundleId: { const: ROLL_CAPTURE_HOST_BUNDLE_ID },
    version: nonEmptyStringSchema,
  },
  ["appName", "bundleId", "version"],
);

export const rollCaptureRequestV1Schema: JsonSchema = objectSchema(
  {
    protocol: { const: ROLL_CAPTURE_PROTOCOL_V1 },
    requestId: nonEmptyStringSchema,
    storyId: stringSchema,
    runId: stringSchema,
    kind: captureKindSchema,
    target: captureTargetSchema,
    out: nonEmptyStringSchema,
    timeoutMs: integerSchema,
    createdAt: nonEmptyStringSchema,
  },
  ["protocol", "requestId", "kind", "target", "out", "timeoutMs", "createdAt"],
);

const captureResponseProperties = {
  protocol: { const: ROLL_CAPTURE_PROTOCOL_V1 },
  requestId: nonEmptyStringSchema,
  screenshotPath: stringSchema,
  responsePath: nonEmptyStringSchema,
  reason: stringSchema,
  imageWidth: integerSchema,
  imageHeight: integerSchema,
  host: captureHostSchema,
  startedAt: nonEmptyStringSchema,
  finishedAt: nonEmptyStringSchema,
} satisfies Readonly<Record<string, JsonSchema>>;

const captureResponseRequired = ["protocol", "requestId", "status", "responsePath", "host", "startedAt", "finishedAt"] as const;

export const rollCaptureResponseV1Schema: JsonSchema = {
  oneOf: [
    objectSchema({ ...captureResponseProperties, status: { const: "taken" } }, [...captureResponseRequired, "screenshotPath"]),
    objectSchema({ ...captureResponseProperties, status: { const: "skipped" } }, [...captureResponseRequired, "reason"]),
    objectSchema({ ...captureResponseProperties, status: { const: "failed" } }, [...captureResponseRequired, "reason"]),
  ],
};

export const captureLedgerEntrySchema: JsonSchema = objectSchema(
  {
    requestId: nonEmptyStringSchema,
    storyId: stringSchema,
    runId: stringSchema,
    kind: captureKindSchema,
    status: captureStatusSchema,
    screenshotPath: stringSchema,
    responsePath: nonEmptyStringSchema,
    reportPath: stringSchema,
    attachedToReport: booleanSchema,
    reason: stringSchema,
    startedAt: nonEmptyStringSchema,
    finishedAt: nonEmptyStringSchema,
  },
  ["requestId", "status", "responsePath", "attachedToReport", "startedAt", "finishedAt"],
);

export const rollCaptureToolOutputSchema: JsonSchema = toolResultSchema(
  objectSchema(
    {
      status: { type: "string", enum: ["taken", "skipped", "failed", "timeout"] },
      path: stringSchema,
      reason: stringSchema,
      response: rollCaptureResponseV1Schema,
    },
    ["status"],
  ),
);

export const physicalScreenshotToolInputSchema: JsonSchema = {
  title: "Roll Capture request",
  oneOf: [rollCaptureRequestV1Schema],
};

export const PHYSICAL_SCREENSHOT_TOOL_CONTRACT: ToolDeclaration = {
  id: "physical.screenshot" as ToolDeclaration["id"],
  kind: "physical",
  title: "Physical Screenshot",
  description: "Request real physical screen pixels through Roll Capture.app.",
  provider: ROLL_CAPTURE_PROVIDER,
  protocol: ROLL_CAPTURE_PROTOCOL_V1,
  platform: ROLL_CAPTURE_PLATFORM,
  defaults: {
    enabled: true,
    timeoutMs: 60_000,
    sandbox: { maxOutputBytes: 2 * 1024 * 1024 },
  },
  requirements: [{ kind: "service", name: "roll-capture-app", optional: false }],
  inputSchema: physicalScreenshotToolInputSchema,
  outputSchema: rollCaptureToolOutputSchema,
};

export function parseRollCaptureRequestV1(value: unknown): RollCaptureRequestV1 | null {
  if (!isRecord(value)) return null;
  if (value["protocol"] !== ROLL_CAPTURE_PROTOCOL_V1) return null;
  if (typeof value["requestId"] !== "string") return null;
  if (!isCaptureKind(value["kind"])) return null;
  const target = parseCaptureTarget(value["target"]);
  if (target === null) return null;
  if (typeof value["out"] !== "string") return null;
  if (typeof value["timeoutMs"] !== "number") return null;
  if (typeof value["createdAt"] !== "string") return null;
  return {
    protocol: ROLL_CAPTURE_PROTOCOL_V1,
    requestId: value["requestId"],
    ...(typeof value["storyId"] === "string" ? { storyId: value["storyId"] } : {}),
    ...(typeof value["runId"] === "string" ? { runId: value["runId"] } : {}),
    kind: value["kind"],
    target,
    out: value["out"],
    timeoutMs: value["timeoutMs"],
    createdAt: value["createdAt"],
  };
}

export function parseRollCaptureResponseV1(value: unknown): RollCaptureResponseV1 | null {
  if (!isRecord(value)) return null;
  if (value["protocol"] !== ROLL_CAPTURE_PROTOCOL_V1) return null;
  if (typeof value["requestId"] !== "string") return null;
  if (!isCaptureStatus(value["status"])) return null;
  if (typeof value["responsePath"] !== "string") return null;
  const host = parseCaptureHost(value["host"]);
  if (host === null) return null;
  if (typeof value["startedAt"] !== "string" || typeof value["finishedAt"] !== "string") return null;
  const imageWidth = parseOptionalInteger(value["imageWidth"]);
  const imageHeight = parseOptionalInteger(value["imageHeight"]);
  return {
    protocol: ROLL_CAPTURE_PROTOCOL_V1,
    requestId: value["requestId"],
    status: value["status"],
    ...(typeof value["screenshotPath"] === "string" ? { screenshotPath: value["screenshotPath"] } : {}),
    responsePath: value["responsePath"],
    ...(typeof value["reason"] === "string" ? { reason: value["reason"] } : {}),
    ...(imageWidth !== undefined ? { imageWidth } : {}),
    ...(imageHeight !== undefined ? { imageHeight } : {}),
    host,
    startedAt: value["startedAt"],
    finishedAt: value["finishedAt"],
  };
}

export function validateRollCaptureRequestV1(
  request: RollCaptureRequestV1,
  options: RollCaptureRequestValidationOptions,
): RollCaptureValidationResult {
  const errors: string[] = [];
  if (request.protocol !== ROLL_CAPTURE_PROTOCOL_V1) {
    errors.push(`unsupported protocol "${request.protocol}", expected ${ROLL_CAPTURE_PROTOCOL_V1}`);
  }
  errors.push(...validateRequestId(request.requestId, options.expectedRequestId));
  errors.push(...validateTarget(request.target));
  errors.push(...validateOutputPath(request.out, options.projectRoot));
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 600_000) {
    errors.push(`invalid timeout: ${request.timeoutMs}ms outside 1...600000`);
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

export function validateRollCaptureResponseV1(
  response: RollCaptureResponseV1,
  request: RollCaptureRequestV1,
): RollCaptureValidationResult {
  const errors: string[] = [];
  if (response.protocol !== request.protocol) {
    errors.push(`response protocol "${response.protocol}" does not match request protocol "${request.protocol}"`);
  }
  if (response.requestId !== request.requestId) {
    errors.push(`response id "${response.requestId}" does not match request id "${request.requestId}"`);
  }
  if (response.status === "taken" && (response.screenshotPath === undefined || response.screenshotPath.length === 0)) {
    errors.push("taken response requires screenshotPath");
  }
  if (response.status !== "taken" && (response.reason === undefined || response.reason.length === 0)) {
    errors.push(`${response.status} response requires reason`);
  }
  if (response.imageWidth !== undefined && (!Number.isInteger(response.imageWidth) || response.imageWidth <= 0)) {
    errors.push(`invalid imageWidth: ${String(response.imageWidth)}`);
  }
  if (response.imageHeight !== undefined && (!Number.isInteger(response.imageHeight) || response.imageHeight <= 0)) {
    errors.push(`invalid imageHeight: ${String(response.imageHeight)}`);
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

function validateRequestId(requestId: string, expectedRequestId: string | undefined): string[] {
  const errors: string[] = [];
  if (requestId.length === 0) errors.push("invalid request id: empty");
  if (/[^A-Za-z0-9._-]/u.test(requestId)) errors.push("invalid request id: contains illegal characters (allowed: A-Z a-z 0-9 . _ -)");
  if (requestId.includes("..")) errors.push('invalid request id: contains ".."');
  if (expectedRequestId !== undefined && requestId !== expectedRequestId) {
    errors.push(`invalid request id: body id "${requestId}" does not match request file id "${expectedRequestId}"`);
  }
  return errors;
}

function validateTarget(target: CaptureTarget): string[] {
  if (target.type === "window" && target.appName.trim().length === 0) {
    return ["unsupported target: window target requires a non-empty appName"];
  }
  if (target.type === "region" && (!Number.isInteger(target.x) || !Number.isInteger(target.y) || !Number.isInteger(target.width) || !Number.isInteger(target.height))) {
    return [`unsupported target: region target requires integer x/y/width/height, got ${target.x},${target.y},${target.width},${target.height}`];
  }
  if (target.type === "region" && (target.width <= 0 || target.height <= 0)) {
    return [`unsupported target: region target requires positive width and height, got ${target.width}x${target.height}`];
  }
  return [];
}

function validateOutputPath(out: string, projectRoot: string): string[] {
  if (out.length === 0) return ["unsafe output path: empty"];
  if (!isAbsolute(out)) return [`unsafe output path: must be an absolute path, got "${out}"`];
  if (out.split(/[\\/]+/u).includes("..")) return ['unsafe output path: must not contain a ".." component'];
  const rollRoot = withTrailingSeparator(realpathIfPossible(resolve(projectRoot, ".roll")));
  const candidateParent = withTrailingSeparator(realpathIfPossible(dirname(resolve(out))));
  if (candidateParent !== rollRoot && !candidateParent.startsWith(rollRoot)) {
    return [`unsafe output path: must be inside project .roll (${resolve(projectRoot, ".roll")})`];
  }
  return [];
}

function realpathIfPossible(path: string): string {
  const missingParts: string[] = [];
  let cursor = resolve(path);
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...missingParts.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missingParts.push(basename(cursor));
      cursor = parent;
    }
  }
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isInteger(value)) return undefined;
  return value;
}

function parseCaptureTarget(value: unknown): CaptureTarget | null {
  if (!isRecord(value) || typeof value["type"] !== "string") return null;
  if (value["type"] === "window") {
    if (typeof value["appName"] !== "string") return null;
    return { type: "window", appName: value["appName"], ...(typeof value["windowTitle"] === "string" ? { windowTitle: value["windowTitle"] } : {}) };
  }
  if (value["type"] === "region") {
    if (typeof value["x"] !== "number" || typeof value["y"] !== "number" || typeof value["width"] !== "number" || typeof value["height"] !== "number") return null;
    return { type: "region", x: value["x"], y: value["y"], width: value["width"], height: value["height"] };
  }
  if (value["type"] === "display") {
    return { type: "display", ...(typeof value["displayId"] === "string" ? { displayId: value["displayId"] } : {}) };
  }
  return null;
}

function parseCaptureHost(value: unknown): CaptureHost | null {
  if (!isRecord(value)) return null;
  if (value["appName"] !== ROLL_CAPTURE_HOST_APP_NAME || value["bundleId"] !== ROLL_CAPTURE_HOST_BUNDLE_ID) return null;
  if (typeof value["version"] !== "string") return null;
  return { appName: ROLL_CAPTURE_HOST_APP_NAME, bundleId: ROLL_CAPTURE_HOST_BUNDLE_ID, version: value["version"] };
}

function isCaptureKind(value: unknown): value is CaptureKind {
  return value === "web" || value === "terminal" || value === "physical_terminal" || value === "region" || value === "display";
}

function isCaptureStatus(value: unknown): value is CaptureStatus {
  return value === "taken" || value === "skipped" || value === "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withTrailingSeparator(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

// ════════════════════════════════════════════════════════════════════════════
// US-PHYSICAL-009 — Capture Gateway v2 contract
//
// v2 is ADDITIVE: `roll.capture.v1` above stays fully readable. v2 gives
// physical and rendered captures ONE durable, source-labelled evidence
// contract. Old hosts that do not advertise v2 are NEVER guessed to support it
// — negotiation retains explicit v1/v2 unavailable reasons instead.
// ════════════════════════════════════════════════════════════════════════════

export const ROLL_CAPTURE_PROTOCOL_V2 = "roll.capture.v2";

/** Where a capture's pixels came from. `legacy-native` is never a v2 accepted capture. */
export type CaptureSource = "roll-capture-window" | "playwright-rendered" | "legacy-native";
/** Physical (real screen pixels) vs rendered (controlled browser PNG). */
export type CaptureClass = "physical" | "rendered";
/** Full lifecycle; a receipt can carry every state except the pre-dispatch `requested`. */
export type CaptureState = "requested" | "taken" | "skipped" | "failed" | "timeout";
/** The terminal states a receipt may record. */
export type CaptureReceiptState = Exclude<CaptureState, "requested">;

export const CAPTURE_SOURCES: readonly CaptureSource[] = ["roll-capture-window", "playwright-rendered", "legacy-native"];
export const CAPTURE_CLASSES: readonly CaptureClass[] = ["physical", "rendered"];
export const CAPTURE_RECEIPT_STATES: readonly CaptureReceiptState[] = ["taken", "skipped", "failed", "timeout"];

export type CaptureOperationV2 = "capture-window" | "register-rendered";

export interface CaptureIntentV2 {
  protocol: typeof ROLL_CAPTURE_PROTOCOL_V2;
  requestId: string;
  storyId: string;
  runId: string;
  surface: { id: string; declaredUrl: string; expectedAcIds: string[] };
  operation: CaptureOperationV2;
  source: CaptureSource;
  target?: { appName: string; windowTitle?: string };
  /** register-rendered only: the staged client PNG to adopt. */
  inputPath?: string;
  out: string;
  timeoutMs: number;
  createdAt: string;
}

export interface CaptureReceiptV2 {
  protocol: typeof ROLL_CAPTURE_PROTOCOL_V2;
  requestId: string;
  storyId: string;
  runId: string;
  surfaceId: string;
  source: CaptureSource;
  captureClass: CaptureClass;
  state: CaptureReceiptState;
  screenshotPath?: string;
  sha256?: string;
  /** Renderer reports this; a physical capture can never claim URL verification. */
  finalUrl?: string;
  target?: { appName: string; windowTitle?: string };
  reason?: string;
  responsePath: string;
  startedAt: string;
  finishedAt: string;
}

/**
 * The four visual-evidence states (US-EVID-031). They are SEPARATE from the
 * delivery verdict: a broken capture machine (`degraded-infrastructure`) must
 * never force a completed story to be rebuilt, while a missing contract
 * (`absent-contract`) or a poisoned lane (`invalid-target`) still fails loudly.
 */
export type EvidenceVisualState = "verified" | "degraded-infrastructure" | "invalid-target" | "absent-contract";

export const EVIDENCE_VISUAL_STATES: readonly EvidenceVisualState[] = [
  "verified",
  "degraded-infrastructure",
  "invalid-target",
  "absent-contract",
];

/** The two visual states that BLOCK the gate as loud evidence/contract failures. */
export const EVIDENCE_BLOCKING_VISUAL_STATES: readonly EvidenceVisualState[] = ["invalid-target", "absent-contract"];

export interface EvidenceHealth {
  delivery: "passed" | "failed";
  visual: EvidenceVisualState;
  acceptedReceiptIds: string[];
  attempts: string[];
}

// ── Surface canonicalization ─────────────────────────────────────────────────

/**
 * `surface.id` is the canonical declared URL: `origin + pathname + search + hash`.
 * Different ACs may share it. Returns null for a non-URL string.
 */
export function canonicalizeSurfaceUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

// ── Protocol negotiation (AC1) ───────────────────────────────────────────────

/**
 * US-PHYSICAL-011: per-source capability a host advertises. `served` is the
 * writer's real capability probe — a source that is declared but not actually
 * served (e.g. renderer missing) must set `served: false` with a reason, never
 * over-claim.
 */
export interface CaptureSourceAdvertisement {
  /** Highest protocol this source can serve, e.g. `roll.capture.v2`. */
  protocol: string;
  /** Whether the source is genuinely served right now (capability-probed). */
  served: boolean;
  /** Actionable reason when not served / for diagnostics. */
  reason?: string;
}

/** What a Roll Capture host advertises about the protocols it can serve. */
export interface CaptureProtocolAdvertisement {
  /** Protocols the host declares it can serve. Absent = legacy host. */
  protocols?: readonly string[];
  /**
   * US-PHYSICAL-011: OPTIONAL per-source capability. When present, negotiation
   * reports per-source availability so status never claims "v2 ready" when a
   * declared source (e.g. physical) is still only v1. Absent = protocol-level
   * only (exact legacy behavior, back-compat).
   */
  sources?: Readonly<Partial<Record<CaptureSource, CaptureSourceAdvertisement>>>;
  /** Optional host build version, for diagnostics. */
  hostVersion?: string;
}

export type CaptureProtocolAvailability = { available: true } | { available: false; reason: string };

export interface CaptureProtocolNegotiation {
  v1: CaptureProtocolAvailability;
  v2: CaptureProtocolAvailability;
  /** Highest mutually-supported protocol, or null when none can be negotiated. */
  selected: typeof ROLL_CAPTURE_PROTOCOL_V2 | typeof ROLL_CAPTURE_PROTOCOL_V1 | null;
  /**
   * US-PHYSICAL-011: per-source v2 availability, present ONLY when the
   * advertisement carried a `sources` map. A source's v2 is available iff it
   * explicitly advertises `roll.capture.v2` AND `served: true` — never inferred
   * from the protocol-level list. Absent here = the host made no per-source claim.
   */
  perSource?: Readonly<Partial<Record<CaptureSource, CaptureProtocolAvailability>>>;
}

/**
 * Negotiate capture protocol readiness from a host advertisement.
 *
 * Security invariant (AC1): v2 is ONLY available when the host EXPLICITLY
 * advertises `roll.capture.v2`. An absent advertisement (legacy / unknown host)
 * yields an explicit v2-unavailable reason — v2 is never guessed. v1 stays
 * readable but is also only negotiated on an explicit advertisement, so an old
 * host that speaks nothing gets clear reasons for both.
 */
export function negotiateCaptureProtocol(
  advertisement: CaptureProtocolAdvertisement | null | undefined,
): CaptureProtocolNegotiation {
  const protocols = advertisement?.protocols;
  if (protocols === undefined || protocols === null) {
    return {
      v1: {
        available: false,
        reason: "host advertised no capture protocols (legacy host); v1 negotiation requires an explicit advertisement",
      },
      v2: {
        available: false,
        reason: "host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host",
      },
      selected: null,
    };
  }
  const v1: CaptureProtocolAvailability = protocols.includes(ROLL_CAPTURE_PROTOCOL_V1)
    ? { available: true }
    : { available: false, reason: `host does not advertise ${ROLL_CAPTURE_PROTOCOL_V1}` };
  const v2: CaptureProtocolAvailability = protocols.includes(ROLL_CAPTURE_PROTOCOL_V2)
    ? { available: true }
    : { available: false, reason: `host does not advertise ${ROLL_CAPTURE_PROTOCOL_V2}` };
  const selected = v2.available ? ROLL_CAPTURE_PROTOCOL_V2 : v1.available ? ROLL_CAPTURE_PROTOCOL_V1 : null;

  // US-PHYSICAL-011: per-source v2 availability, only when the host made a
  // per-source claim. A source is v2-available ONLY if it explicitly advertises
  // roll.capture.v2 AND is genuinely served — never inferred from `protocols`.
  const sources = advertisement?.sources;
  if (sources === undefined) return { v1, v2, selected };
  const perSource: Partial<Record<CaptureSource, CaptureProtocolAvailability>> = {};
  for (const source of CAPTURE_SOURCES) {
    const adv = sources[source];
    if (adv === undefined) continue;
    perSource[source] =
      adv.protocol === ROLL_CAPTURE_PROTOCOL_V2 && adv.served === true
        ? { available: true }
        : {
            available: false,
            reason:
              adv.reason ??
              (adv.protocol !== ROLL_CAPTURE_PROTOCOL_V2
                ? `source ${source} serves ${adv.protocol}, not ${ROLL_CAPTURE_PROTOCOL_V2}`
                : `source ${source} advertises ${ROLL_CAPTURE_PROTOCOL_V2} but is not served`),
          };
  }
  return { v1, v2, selected, perSource };
}

export function parseCaptureProtocolAdvertisement(value: unknown): CaptureProtocolAdvertisement | null {
  if (!isRecord(value)) return null;
  const rawProtocols = value["protocols"];
  const protocols = Array.isArray(rawProtocols) ? rawProtocols.filter((p): p is string => typeof p === "string") : undefined;
  // US-PHYSICAL-011: parse the OPTIONAL per-source map. Only well-formed entries
  // for known sources are kept; a malformed `sources` value is dropped entirely
  // (fail closed to protocol-level), never partially trusted.
  const sources = parseCaptureSourceAdvertisements(value["sources"]);
  return {
    ...(protocols !== undefined ? { protocols } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(typeof value["hostVersion"] === "string" ? { hostVersion: value["hostVersion"] } : {}),
  };
}

function parseCaptureSourceAdvertisements(
  raw: unknown,
): Readonly<Partial<Record<CaptureSource, CaptureSourceAdvertisement>>> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Partial<Record<CaptureSource, CaptureSourceAdvertisement>> = {};
  let any = false;
  for (const source of CAPTURE_SOURCES) {
    const entry = raw[source];
    if (!isRecord(entry)) continue;
    const protocol = entry["protocol"];
    const served = entry["served"];
    if (typeof protocol !== "string" || protocol === "" || typeof served !== "boolean") continue;
    out[source] = {
      protocol,
      served,
      ...(typeof entry["reason"] === "string" ? { reason: entry["reason"] } : {}),
    };
    any = true;
  }
  return any ? out : undefined;
}

// ── v2 schemas ───────────────────────────────────────────────────────────────

const captureSourceSchema: JsonSchema = { type: "string", enum: [...CAPTURE_SOURCES] };
const captureClassSchema: JsonSchema = { type: "string", enum: [...CAPTURE_CLASSES] };
const captureReceiptStateSchema: JsonSchema = { type: "string", enum: [...CAPTURE_RECEIPT_STATES] };
const captureWindowTargetSchema: JsonSchema = objectSchema(
  { appName: nonEmptyStringSchema, windowTitle: stringSchema },
  ["appName"],
);

export const captureIntentV2Schema: JsonSchema = objectSchema(
  {
    protocol: { const: ROLL_CAPTURE_PROTOCOL_V2 },
    requestId: nonEmptyStringSchema,
    storyId: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    surface: objectSchema(
      { id: nonEmptyStringSchema, declaredUrl: nonEmptyStringSchema, expectedAcIds: { type: "array", items: nonEmptyStringSchema } },
      ["id", "declaredUrl", "expectedAcIds"],
    ),
    operation: { type: "string", enum: ["capture-window", "register-rendered"] },
    source: captureSourceSchema,
    target: captureWindowTargetSchema,
    inputPath: stringSchema,
    out: nonEmptyStringSchema,
    timeoutMs: integerSchema,
    createdAt: nonEmptyStringSchema,
  },
  ["protocol", "requestId", "storyId", "runId", "surface", "operation", "source", "out", "timeoutMs", "createdAt"],
);

export const captureReceiptV2Schema: JsonSchema = objectSchema(
  {
    protocol: { const: ROLL_CAPTURE_PROTOCOL_V2 },
    requestId: nonEmptyStringSchema,
    storyId: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    surfaceId: nonEmptyStringSchema,
    source: captureSourceSchema,
    captureClass: captureClassSchema,
    state: captureReceiptStateSchema,
    screenshotPath: stringSchema,
    sha256: stringSchema,
    finalUrl: stringSchema,
    target: captureWindowTargetSchema,
    reason: stringSchema,
    responsePath: nonEmptyStringSchema,
    startedAt: nonEmptyStringSchema,
    finishedAt: nonEmptyStringSchema,
  },
  ["protocol", "requestId", "storyId", "runId", "surfaceId", "source", "captureClass", "state", "responsePath", "startedAt", "finishedAt"],
);

// ── v2 parsers ───────────────────────────────────────────────────────────────

function parseWindowTarget(value: unknown): { appName: string; windowTitle?: string } | null {
  if (!isRecord(value) || typeof value["appName"] !== "string") return null;
  return { appName: value["appName"], ...(typeof value["windowTitle"] === "string" ? { windowTitle: value["windowTitle"] } : {}) };
}

export function parseCaptureIntentV2(value: unknown): CaptureIntentV2 | null {
  if (!isRecord(value)) return null;
  if (value["protocol"] !== ROLL_CAPTURE_PROTOCOL_V2) return null;
  const surface = value["surface"];
  if (!isRecord(surface)) return null;
  if (typeof surface["id"] !== "string" || typeof surface["declaredUrl"] !== "string") return null;
  const rawAc = surface["expectedAcIds"];
  if (!Array.isArray(rawAc) || !rawAc.every((x) => typeof x === "string")) return null;
  if (value["operation"] !== "capture-window" && value["operation"] !== "register-rendered") return null;
  if (!isCaptureSource(value["source"])) return null;
  if (
    typeof value["requestId"] !== "string" ||
    typeof value["storyId"] !== "string" ||
    typeof value["runId"] !== "string" ||
    typeof value["out"] !== "string" ||
    typeof value["timeoutMs"] !== "number" ||
    typeof value["createdAt"] !== "string"
  ) {
    return null;
  }
  const target = value["target"] !== undefined ? parseWindowTarget(value["target"]) : undefined;
  if (value["target"] !== undefined && target === null) return null;
  return {
    protocol: ROLL_CAPTURE_PROTOCOL_V2,
    requestId: value["requestId"],
    storyId: value["storyId"],
    runId: value["runId"],
    surface: { id: surface["id"], declaredUrl: surface["declaredUrl"], expectedAcIds: [...(rawAc as string[])] },
    operation: value["operation"],
    source: value["source"],
    ...(target != null ? { target } : {}),
    ...(typeof value["inputPath"] === "string" ? { inputPath: value["inputPath"] } : {}),
    out: value["out"],
    timeoutMs: value["timeoutMs"],
    createdAt: value["createdAt"],
  };
}

export function parseCaptureReceiptV2(value: unknown): CaptureReceiptV2 | null {
  if (!isRecord(value)) return null;
  if (value["protocol"] !== ROLL_CAPTURE_PROTOCOL_V2) return null;
  if (!isCaptureSource(value["source"])) return null;
  if (!isCaptureClass(value["captureClass"])) return null;
  if (!isCaptureReceiptState(value["state"])) return null;
  if (
    typeof value["requestId"] !== "string" ||
    typeof value["storyId"] !== "string" ||
    typeof value["runId"] !== "string" ||
    typeof value["surfaceId"] !== "string" ||
    typeof value["responsePath"] !== "string" ||
    typeof value["startedAt"] !== "string" ||
    typeof value["finishedAt"] !== "string"
  ) {
    return null;
  }
  const target = value["target"] !== undefined ? parseWindowTarget(value["target"]) : undefined;
  if (value["target"] !== undefined && target === null) return null;
  return {
    protocol: ROLL_CAPTURE_PROTOCOL_V2,
    requestId: value["requestId"],
    storyId: value["storyId"],
    runId: value["runId"],
    surfaceId: value["surfaceId"],
    source: value["source"],
    captureClass: value["captureClass"],
    state: value["state"],
    ...(typeof value["screenshotPath"] === "string" ? { screenshotPath: value["screenshotPath"] } : {}),
    ...(typeof value["sha256"] === "string" ? { sha256: value["sha256"] } : {}),
    ...(typeof value["finalUrl"] === "string" ? { finalUrl: value["finalUrl"] } : {}),
    ...(target != null ? { target } : {}),
    ...(typeof value["reason"] === "string" ? { reason: value["reason"] } : {}),
    responsePath: value["responsePath"],
    startedAt: value["startedAt"],
    finishedAt: value["finishedAt"],
  };
}

// ── v2 validators (AC4) ──────────────────────────────────────────────────────

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type CaptureIntentV2ValidationOptions = {
  projectRoot: string;
  expectedRequestId?: string;
};

export function validateCaptureIntentV2(
  intent: CaptureIntentV2,
  options: CaptureIntentV2ValidationOptions,
): RollCaptureValidationResult {
  const errors: string[] = [];
  if (intent.protocol !== ROLL_CAPTURE_PROTOCOL_V2) {
    errors.push(`unsupported protocol "${intent.protocol}", expected ${ROLL_CAPTURE_PROTOCOL_V2}`);
  }
  errors.push(...validateRequestId(intent.requestId, options.expectedRequestId));
  if (intent.storyId.trim() === "") errors.push("invalid intent: empty storyId");
  if (intent.runId.trim() === "") errors.push("invalid intent: empty runId");

  const canonical = canonicalizeSurfaceUrl(intent.surface.declaredUrl);
  if (canonical === null) {
    errors.push(`invalid surface: declaredUrl "${intent.surface.declaredUrl}" is not a valid URL`);
  } else if (intent.surface.id !== canonical) {
    errors.push(`invalid surface: id "${intent.surface.id}" is not the canonical declared URL "${canonical}"`);
  }
  if (intent.surface.expectedAcIds.length === 0) errors.push("invalid surface: expectedAcIds must be non-empty");

  if (intent.operation === "capture-window") {
    if (intent.source !== "roll-capture-window") {
      errors.push(`invalid intent: capture-window requires source "roll-capture-window", got "${intent.source}"`);
    }
    if (intent.target === undefined || intent.target.appName.trim() === "") {
      errors.push("invalid intent: capture-window requires a target with a non-empty appName");
    }
  } else {
    if (intent.source !== "playwright-rendered") {
      errors.push(`invalid intent: register-rendered requires source "playwright-rendered", got "${intent.source}"`);
    }
    if (intent.inputPath === undefined || intent.inputPath.trim() === "") {
      errors.push("invalid intent: register-rendered requires an inputPath");
    } else {
      errors.push(...validateOutputPath(intent.inputPath, options.projectRoot).map((e) => e.replace("output path", "inputPath")));
    }
  }

  errors.push(...validateOutputPath(intent.out, options.projectRoot));
  if (!Number.isInteger(intent.timeoutMs) || intent.timeoutMs <= 0 || intent.timeoutMs > 600_000) {
    errors.push(`invalid timeout: ${intent.timeoutMs}ms outside 1...600000`);
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * Validate a v2 receipt against its intent. Rejects malformed / mismatched /
 * missing-artifact receipts. A `taken` receipt must satisfy its class rules:
 * physical never claims a finalUrl and must match the requested target; rendered
 * must report a finalUrl equal to the canonical surface. `legacy-native` is
 * never a v2 accepted capture.
 */
export function validateCaptureReceiptV2(receipt: CaptureReceiptV2, intent?: CaptureIntentV2): RollCaptureValidationResult {
  const errors: string[] = [];
  if (receipt.protocol !== ROLL_CAPTURE_PROTOCOL_V2) {
    errors.push(`unsupported protocol "${receipt.protocol}", expected ${ROLL_CAPTURE_PROTOCOL_V2}`);
  }
  if (receipt.responsePath.trim() === "") errors.push("invalid receipt: empty responsePath");

  if (intent !== undefined) {
    if (receipt.requestId !== intent.requestId) errors.push(`receipt requestId "${receipt.requestId}" does not match intent "${intent.requestId}"`);
    if (receipt.storyId !== intent.storyId) errors.push(`receipt storyId "${receipt.storyId}" does not match intent "${intent.storyId}"`);
    if (receipt.runId !== intent.runId) errors.push(`receipt runId "${receipt.runId}" does not match intent "${intent.runId}"`);
    if (receipt.surfaceId !== intent.surface.id) errors.push(`receipt surfaceId "${receipt.surfaceId}" does not match intent surface "${intent.surface.id}"`);
    if (receipt.source !== intent.source) errors.push(`receipt source "${receipt.source}" does not match intent source "${intent.source}"`);
  }

  // Source → class binding.
  if (receipt.source === "legacy-native") {
    errors.push("legacy-native captures are never a v2 accepted capture; they stay legacy-unverified");
  } else if (receipt.source === "roll-capture-window" && receipt.captureClass !== "physical") {
    errors.push(`source "roll-capture-window" must be captureClass "physical", got "${receipt.captureClass}"`);
  } else if (receipt.source === "playwright-rendered" && receipt.captureClass !== "rendered") {
    errors.push(`source "playwright-rendered" must be captureClass "rendered", got "${receipt.captureClass}"`);
  }

  if (receipt.state === "taken") {
    if (receipt.screenshotPath === undefined || receipt.screenshotPath.trim() === "") {
      errors.push("taken receipt requires a screenshotPath (missing artifact)");
    }
    if (receipt.sha256 === undefined || receipt.sha256.trim() === "") {
      errors.push("taken receipt requires a sha256 digest");
    } else if (!SHA256_PATTERN.test(receipt.sha256)) {
      errors.push(`taken receipt has a malformed sha256 digest "${receipt.sha256}"`);
    }
    if (receipt.captureClass === "physical") {
      if (receipt.finalUrl !== undefined) errors.push("physical receipt must not claim a finalUrl");
      const target = intent?.target;
      if (target !== undefined) {
        if (receipt.target === undefined) {
          errors.push("physical receipt must echo the requested target");
        } else {
          if (receipt.target.appName !== target.appName) errors.push(`physical receipt appName "${receipt.target.appName}" does not match requested "${target.appName}"`);
          if ((target.windowTitle ?? undefined) !== (receipt.target.windowTitle ?? undefined)) {
            errors.push(`physical receipt windowTitle "${receipt.target.windowTitle ?? ""}" does not match requested "${target.windowTitle ?? ""}"`);
          }
        }
      }
    } else if (receipt.captureClass === "rendered") {
      if (receipt.finalUrl === undefined || receipt.finalUrl.trim() === "") {
        errors.push("rendered receipt requires a finalUrl equal to the canonical surface");
      } else {
        const canonicalFinal = canonicalizeSurfaceUrl(receipt.finalUrl);
        if (canonicalFinal === null) {
          errors.push(`rendered receipt finalUrl "${receipt.finalUrl}" is not a valid URL`);
        } else if (canonicalFinal !== receipt.surfaceId) {
          errors.push(`rendered receipt finalUrl "${canonicalFinal}" does not equal the surface "${receipt.surfaceId}" (invalid target / redirect)`);
        }
      }
    }
  } else {
    // Non-taken terminal states record why, and carry no accepted artifact.
    if (receipt.reason === undefined || receipt.reason.trim() === "") errors.push(`${receipt.state} receipt requires a reason`);
    if (receipt.screenshotPath !== undefined) errors.push(`${receipt.state} receipt must not claim a screenshotPath`);
    if (receipt.sha256 !== undefined) errors.push(`${receipt.state} receipt must not claim a sha256 digest`);
    if (receipt.finalUrl !== undefined) errors.push(`${receipt.state} receipt must not claim a finalUrl`);
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/** True iff the receipt is a valid, accepted (taken) v2 capture for its intent. */
export function isAcceptedCaptureReceiptV2(receipt: CaptureReceiptV2, intent?: CaptureIntentV2): boolean {
  return receipt.state === "taken" && validateCaptureReceiptV2(receipt, intent).ok;
}

function isCaptureSource(value: unknown): value is CaptureSource {
  return value === "roll-capture-window" || value === "playwright-rendered" || value === "legacy-native";
}

function isCaptureClass(value: unknown): value is CaptureClass {
  return value === "physical" || value === "rendered";
}

function isCaptureReceiptState(value: unknown): value is CaptureReceiptState {
  return value === "taken" || value === "skipped" || value === "failed" || value === "timeout";
}

function toolResultSchema(output: JsonSchema): JsonSchema {
  const meta = objectSchema(
    {
      invocationId: stringSchema,
      toolId: stringSchema,
      caller: { type: "object", additionalProperties: true },
      startedAt: numberSchema,
      endedAt: numberSchema,
      durationMs: numberSchema,
      attempt: integerSchema,
    },
    ["invocationId", "toolId", "caller", "startedAt", "endedAt", "durationMs"],
  );
  const error = objectSchema(
    {
      code: { type: "string", enum: ["not_found", "init_failed", "policy_denied", "budget_exhausted", "sandbox_denied", "timeout", "adapter_error", "invalid_input", "unknown"] },
      message: stringSchema,
      retryable: booleanSchema,
      detail: true,
    },
    ["code", "message", "retryable"],
  );
  return {
    oneOf: [
      objectSchema({ ok: { const: true }, output, meta, warnings: { type: "array", items: stringSchema } }, ["ok", "output", "meta"]),
      objectSchema({ ok: { const: false }, error, meta, warnings: { type: "array", items: stringSchema } }, ["ok", "error", "meta"]),
    ],
  };
}
