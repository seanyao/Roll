/**
 * @responsibility Declares the evidence classification contract types.
 */
/**
 * US-BROW-006 — Evidence classification contract.
 *
 * The EvidenceClassifier distinguishes three mutually-exclusive evidence classes
 * and enforces that only physical-capture (roll.capture.v1) with a verified
 * digest can satisfy a visual acceptance criterion. DevTools and Playwright
 * screenshots are diagnostic-only, never visual AC evidence.
 *
 * Domain model: Evidence bounded context.
 * Aggregate: EvidenceClassifier owns Playwright diagnostic, DevTools diagnostic
 * and physical-capture classifications.
 */

import type { CaptureStatus, RollCaptureResponseV1 } from "./capture.js";

// ── Evidence class (closed set) ────────────────────────────────────────────

/** The three mutually-exclusive evidence classes. */
export type EvidenceClass =
  | "playwright-diagnostic"
  | "devtools-diagnostic"
  | "physical-capture";

export const EVIDENCE_CLASSES: readonly EvidenceClass[] = [
  "playwright-diagnostic",
  "devtools-diagnostic",
  "physical-capture",
];

// ── Protocol identifiers ────────────────────────────────────────────────────

/** The v1 protocol whose evidence can satisfy a visual AC. */
export const PHYSICAL_CAPTURE_PROTOCOL = "roll.capture.v1";

/** US-PHYSICAL-009 — the additive v2 gateway protocol. */
export const PHYSICAL_CAPTURE_PROTOCOL_V2 = "roll.capture.v2";

/** Both physical-capture protocols eligible for a visual AC (v1 + v2). */
export const PHYSICAL_CAPTURE_PROTOCOLS: readonly string[] = ["roll.capture.v1", "roll.capture.v2"];

/** Provider identifiers that map to each evidence class. */
export const PHYSICAL_CAPTURE_PROVIDERS: readonly string[] = ["roll-capture"];
export const PLAYWRIGHT_PROVIDERS: readonly string[] = ["playwright"];
export const DEVTOOLS_PROVIDERS: readonly string[] = ["chrome-devtools", "chrome-devtools-mcp"];

// ── Classification result ──────────────────────────────────────────────────

/** What the classifier ruled about one artifact. */
export interface EvidenceClassification {
  /** The classified artifact id or reference. */
  artifactId: string;
  /** The resolved evidence class. */
  evidenceClass: EvidenceClass;
  /** Protocol declared by the artifact (only physical-capture carries roll.capture.v1). */
  protocol?: string;
  /** Provider that produced the artifact. */
  provider?: string;
  /** SHA-256 digest of the artifact content (physical-capture only). */
  digest?: string;
  /** Whether this artifact can satisfy a visual acceptance criterion. */
  canSatisfyVisualAc: boolean;
  /** Human-readable reason for the classification. */
  reason: string;
}

// ── Visual evidence result ─────────────────────────────────────────────────

/** How a piece of evidence was classified against a visual AC. */
export type VisualEvidenceVerdict =
  | "valid"            // physical-capture, taken, PNG attached, digest verified
  | "not_physical"     // playwright-diagnostic or devtools-diagnostic — never visual AC
  | "capture_failed"   // physical-capture but status != taken
  | "capture_missing"  // physical-capture request was made but no response
  | "digest_mismatch"  // physical-capture but digest doesn't match
  | "protocol_forged"  // declared roll.capture.v1 but not from the roll-capture provider
  | "path_substituted" // screenshot path doesn't match response path
  | "png_missing"      // taken status but no PNG attached
  | "unclassified";    // artifact not classified yet

/** The result of classifying a piece of potential evidence against a visual AC. */
export interface VisualEvidenceResult {
  /** The artifact being classified. */
  artifactId: string;
  /** The verdict. */
  verdict: VisualEvidenceVerdict;
  /** When invalid, why. */
  reason: string;
  /** Evidence class of the artifact. */
  evidenceClass: EvidenceClass;
  /** When valid, the attached evidence details. */
  evidence?: {
    protocol: string;
    provider: string;
    screenshotPath: string;
    digest: string;
    imageWidth?: number;
    imageHeight?: number;
  };
}

// ── Operation-to-capture verdict matrix ────────────────────────────────────

/** Operation terminal outcome for the verdict matrix. */
export type OperationOutcome =
  | "passed"
  | "failed"
  | "denied"
  | "expired";

/** A single cell in the verdict matrix. */
export interface VerdictMatrixCell {
  /** The operation outcome. */
  operationOutcome: OperationOutcome;
  /** Whether a physical capture was requested. */
  captureRequested: boolean;
  /** The capture status if requested. */
  captureStatus?: CaptureStatus;
  /** Whether capture is allowed (false = no rescue capture after failure/denial). */
  captureAllowed: boolean;
  /** Human-readable reason. */
  reason: string;
}

// ── Capture bridge domain types ────────────────────────────────────────────

/** A link from a browser operation run to a physical capture request. */
export interface CaptureBridgeLink {
  /** The browser operation run identifier. */
  runId: string;
  /** The story this capture serves. */
  storyId: string;
  /** The capture request id. */
  captureRequestId: string;
  /** The terminal capture response, when available. */
  captureResponse?: RollCaptureResponseV1;
  /** SHA-256 of the attached physical image, when available for validation. */
  captureDigest?: string;
  /** Whether the capture is valid visual AC evidence. */
  canSatisfyVisualAc: boolean;
  /** Reason for the bridge verdict. */
  reason: string;
  /** When the bridge link was created. */
  linkedAt: string;
}

// ── Report fact separation ─────────────────────────────────────────────────

/** A diagnostic fact (never visual AC evidence). */
export interface DiagnosticFact {
  /** The artifact reference. */
  artifactId: string;
  /** Diagnostic kind. */
  kind: "dom-snapshot" | "console-summary" | "network-summary" | "devtools-screenshot";
  /** Human-readable summary of the diagnostic result. */
  summary: string;
  /** Always true — diagnostic artifacts are never visual AC evidence. */
  diagnosticOnly: true;
  /** The evidence class of this fact. */
  evidenceClass: EvidenceClass;
}

/** A visual evidence fact (physical-capture that CAN satisfy a visual AC). */
export interface VisualEvidenceFact {
  /** The capture request id. */
  captureRequestId: string;
  /** The verdict. */
  verdict: VisualEvidenceVerdict;
  /** When valid, where the screenshot is. */
  screenshotPath?: string;
  /** When valid, the verified digest. */
  digest?: string;
  /** Human-readable reason for this fact's status. */
  reason: string;
  /** The evidence class of this fact. */
  evidenceClass: "physical-capture";
}

// ── Classifier input ───────────────────────────────────────────────────────

/** Input to the EvidenceClassifier. */
export interface EvidenceClassifierInput {
  /** The artifact id to classify. */
  artifactId: string;
  /** Provider that produced this artifact. */
  provider?: string;
  /** Protocol string if declared. */
  protocol?: string;
  /** Whether the artifact claims to be a capture response. */
  isCaptureResponse?: boolean;
  /** The raw capture response if available. */
  captureResponse?: RollCaptureResponseV1;
  /** SHA-256 digest of the artifact content. */
  digest?: string;
  /** Whether the artifact is from a browser operation diagnostic. */
  isBrowserDiagnostic?: boolean;
  /** The diagnostic kind if from browser operations. */
  diagnosticKind?: "dom-snapshot" | "console-summary" | "network-summary" | "devtools-screenshot";
}
