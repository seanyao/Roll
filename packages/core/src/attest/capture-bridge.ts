/**
 * @responsibility Links completed browser operations to authoritative physical capture requests.
 * US-BROW-006 — CaptureBridge: the only component that links a browser operation
 * run to a Roll Capture physical screenshot request.
 *
 * The CaptureBridge enforces the verdict matrix:
 * - Only a passed browser operation can trigger a physical capture
 * - Failed/denied/expired operations never produce a rescue capture
 * - The bridge records the link as an authoritative fact (browser_capture_link truth anchor)
 */

import { type CaptureBridgeLink, type OperationOutcome, type RollCaptureResponseV1 } from "@roll/spec";
import { EvidenceClassifier } from "./evidence-classifier.js";

// ════════════════════════════════════════════════════════════════════════════
// CaptureBridge
// ════════════════════════════════════════════════════════════════════════════

/**
 * The CaptureBridge links a browser operation run to a physical capture request.
 * It is the single authority for browser_capture_link facts (truth-registry).
 *
 * After a browser operation completes, the bridge evaluates whether a physical
 * capture should be requested and validates the result against the verdict matrix.
 */
export class CaptureBridge {
  private readonly classifier: EvidenceClassifier;
  private links: CaptureBridgeLink[];

  constructor() {
    this.classifier = new EvidenceClassifier();
    this.links = [];
  }

  /**
   * Create a capture bridge link after a browser operation completes.
   *
   * @param runId - The browser operation run identifier
   * @param storyId - The story this capture serves
   * @param captureRequestId - The physical capture request identifier
   * @param operationOutcome - The terminal outcome of the browser operation
   * @param captureResponse - The terminal capture response (if available)
   * @returns The bridge link, or null if capture is not allowed for this outcome
   */
  linkCapture(
    runId: string,
    storyId: string,
    captureRequestId: string,
    operationOutcome: OperationOutcome,
    captureResponse?: RollCaptureResponseV1,
    captureDigest?: string,
  ): CaptureBridgeLink | null {
    // Verdict matrix: only "passed" operations can produce capture evidence
    const matrixCell = this.classifier.evaluateVerdictMatrix(
      operationOutcome,
      captureResponse !== undefined, // captureRequested = response exists
      captureResponse?.status,
    );

    if (!matrixCell.captureAllowed) {
      return null; // No rescue capture — null link
    }

    // Validate the capture response for visual AC
    const visualResult = this.classifier.validateVisualEvidence({
      artifactId: captureRequestId,
      provider: "roll-capture",
      protocol: "roll.capture.v1",
      captureResponse,
      digest: captureDigest,
    });

    const link: CaptureBridgeLink = {
      runId,
      storyId,
      captureRequestId,
      captureResponse,
      ...(captureDigest !== undefined ? { captureDigest } : {}),
      canSatisfyVisualAc: visualResult.verdict === "valid",
      reason: `Operation ${operationOutcome}: ${matrixCell.reason}. Visual evidence: ${visualResult.verdict} — ${visualResult.reason}`,
      linkedAt: new Date().toISOString(),
    };

    this.links.push(link);
    return link;
  }

  /**
   * Retrieve all bridge links for a given story.
   */
  linksForStory(storyId: string): CaptureBridgeLink[] {
    return this.links.filter((l) => l.storyId === storyId);
  }

  /**
   * Retrieve all bridge links for a given run.
   */
  linksForRun(runId: string): CaptureBridgeLink[] {
    return this.links.filter((l) => l.runId === runId);
  }

  /**
   * Retrieve all links (for serialization/auditing).
   */
  allLinks(): readonly CaptureBridgeLink[] {
    return this.links;
  }

  /**
   * Count of links that satisfy visual AC.
   */
  validVisualEvidenceCount(storyId?: string): number {
    const scope = storyId !== undefined ? this.linksForStory(storyId) : this.links;
    return scope.filter((l) => l.canSatisfyVisualAc).length;
  }

  /**
   * Clear all links (for testing).
   */
  clear(): void {
    this.links = [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Static helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Whether the outcome combination allows a capture bridge link.
 * Pure function — no side effects.
 */
export function shouldBridgeCapture(operationOutcome: OperationOutcome): boolean {
  return operationOutcome === "passed";
}

/**
 * Build a capture bridge reason string from the verdict matrix and visual evidence result.
 */
export function buildBridgeReason(
  operationOutcome: OperationOutcome,
  captureRequested: boolean,
  captureStatus?: "taken" | "skipped" | "failed",
): string {
  if (!captureRequested) return "No capture requested";
  if (operationOutcome !== "passed") return `Capture not allowed: operation was ${operationOutcome}`;
  switch (captureStatus) {
    case "taken": return "Capture taken — eligible for visual AC validation";
    case "skipped": return "Capture skipped — not eligible for visual AC";
    case "failed": return "Capture failed — not eligible for visual AC";
    default: return "Capture status unknown";
  }
}
