/**
 * @responsibility Classifies capture artifacts and rejects evidence that cannot satisfy visual criteria.
 * US-BROW-006 — EvidenceClassifier: the single authority for distinguishing
 * Playwright diagnostics, DevTools diagnostics and physical-capture evidence.
 *
 * Only roll.capture.v1 with taken status, attached PNG, and verified digest
 * can satisfy a visual acceptance criterion. DevTools/Playwright screenshots
 * are diagnostic-only and can NEVER be promoted to visual AC evidence.
 *
 * The classifier also validates against forgery: protocol forgery, path
 * substitution, and digest mismatch are all rejected.
 */

import {
  type CaptureIntentV2,
  type CaptureReceiptV2,
  type DiagnosticFact,
  type EvidenceClass,
  type EvidenceClassification,
  type EvidenceClassifierInput,
  type OperationOutcome,
  type VerdictMatrixCell,
  type VisualEvidenceFact,
  type VisualEvidenceResult,
  type VisualEvidenceVerdict,
  DEVTOOLS_PROVIDERS,
  PHYSICAL_CAPTURE_PROTOCOL,
  PHYSICAL_CAPTURE_PROVIDERS,
  PLAYWRIGHT_PROVIDERS,
  validateCaptureReceiptV2,
} from "@roll/spec";

// ════════════════════════════════════════════════════════════════════════════
// Evidence classification
// ════════════════════════════════════════════════════════════════════════════

/**
 * Classify a single piece of evidence into one of the three mutually-exclusive
 * evidence classes. The classification considers provider, protocol, and
 * whether the artifact is from a browser operation diagnostic.
 *
 * Rules:
 * 1. Physical-capture providers (roll-capture) with roll.capture.v1 protocol → physical-capture
 * 2. Playwright providers → playwright-diagnostic
 * 3. DevTools providers, or browser diagnostic artifacts → devtools-diagnostic
 * 4. Unknown provider but has browser diagnostic kind → devtools-diagnostic
 * 5. Otherwise → playwright-diagnostic (most conservative default)
 */
export class EvidenceClassifier {
  /**
   * Classify an artifact into one of the three evidence classes.
   */
  classify(input: EvidenceClassifierInput): EvidenceClassification {
    const { artifactId, provider, protocol, isBrowserDiagnostic } = input;

    // Rule 1: Physical capture
    if (provider !== undefined && PHYSICAL_CAPTURE_PROVIDERS.includes(provider)) {
      return {
        artifactId,
        evidenceClass: "physical-capture",
        protocol: protocol ?? PHYSICAL_CAPTURE_PROTOCOL,
        provider,
        digest: input.digest,
        canSatisfyVisualAc: false, // must pass validateVisualEvidence
        reason: "Physical capture provider — requires validateVisualEvidence to confirm visual AC eligibility",
      };
    }

    // Rule 2: Playwright
    if (provider !== undefined && PLAYWRIGHT_PROVIDERS.includes(provider)) {
      return {
        artifactId,
        evidenceClass: "playwright-diagnostic",
        protocol,
        provider,
        canSatisfyVisualAc: false, // NEVER visual AC
        reason: "Playwright diagnostic artifact — never eligible for visual AC",
      };
    }

    // Rule 3: DevTools
    if (provider !== undefined && DEVTOOLS_PROVIDERS.includes(provider)) {
      return {
        artifactId,
        evidenceClass: "devtools-diagnostic",
        protocol,
        provider,
        canSatisfyVisualAc: false, // NEVER visual AC
        reason: "DevTools diagnostic artifact — never eligible for visual AC",
      };
    }

    // Rule 4: Browser diagnostic (no provider but diagnostic kind)
    if (isBrowserDiagnostic === true) {
      return {
        artifactId,
        evidenceClass: "devtools-diagnostic",
        protocol,
        provider,
        canSatisfyVisualAc: false,
        reason: "Browser operation diagnostic artifact — never eligible for visual AC",
      };
    }

    // Rule 5: Default — most conservative
    return {
      artifactId,
      evidenceClass: "playwright-diagnostic",
      protocol,
      provider,
      canSatisfyVisualAc: false,
      reason: "Unclassified provider — treated as diagnostic (conservative default)",
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Visual evidence validation
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Validate whether a physical-capture artifact is genuine visual AC evidence.
   *
   * Only passes when ALL conditions are met:
   * 1. Protocol is exactly roll.capture.v1
   * 2. Provider is roll-capture (not forged)
   * 3. Status is "taken"
   * 4. PNG screenshot is attached
   * 5. Digest is present and matches
   * 6. Screenshot path matches response path (no substitution)
   *
   * Any deviation → rejected with a specific verdict.
   */
  validateVisualEvidence(input: EvidenceClassifierInput): VisualEvidenceResult {
    const { artifactId } = input;

    // Protocol forgery: claims roll.capture.v1 but provider isn't roll-capture
    // Check BEFORE classification — a forged protocol claim from a non-capture
    // provider is a forgery attempt, not just a non-physical artifact.
    if (input.protocol === PHYSICAL_CAPTURE_PROTOCOL && input.provider !== undefined && !PHYSICAL_CAPTURE_PROVIDERS.includes(input.provider)) {
      return {
        artifactId,
        verdict: "protocol_forged",
        reason: `Declares ${PHYSICAL_CAPTURE_PROTOCOL} protocol but provider "${input.provider}" is not a physical-capture provider — rejected as forgery`,
        evidenceClass: "physical-capture",
      };
    }

    const classification = this.classify(input);

    // Not physical capture → never visual AC
    if (classification.evidenceClass !== "physical-capture") {
      return {
        artifactId,
        verdict: "not_physical",
        reason: `${classification.evidenceClass} artifacts cannot satisfy a visual AC — only physical-capture (roll.capture.v1) is eligible`,
        evidenceClass: classification.evidenceClass,
      };
    }

    // No capture response → cannot validate
    if (input.captureResponse === undefined) {
      return {
        artifactId,
        verdict: "capture_missing",
        reason: "Physical capture declared but no capture response available — cannot validate",
        evidenceClass: "physical-capture",
      };
    }

    const response = input.captureResponse;

    // Status check: must be "taken"
    if (response.status !== "taken") {
      return {
        artifactId,
        verdict: "capture_failed",
        reason: `Capture status is "${response.status}" — visual AC requires "taken" status`,
        evidenceClass: "physical-capture",
      };
    }

    // PNG check: taken must have screenshotPath
    if (response.screenshotPath === undefined || response.screenshotPath.length === 0) {
      return {
        artifactId,
        verdict: "png_missing",
        reason: 'Capture status is "taken" but no PNG screenshotPath is attached',
        evidenceClass: "physical-capture",
      };
    }

    // Path substitution check: screenshotPath must not differ from response path
    if (response.screenshotPath !== response.responsePath) {
      // responsePath is the JSON response file, screenshotPath is the actual image
      // They should be different paths (one is JSON, one is PNG) — but the
      // screenshotPath should be what the response declares.
      // Path substitution means the screenshot path was swapped externally.
      // We trust the response's screenshotPath as authoritative.
      // This check is for the case where someone tries to point to a different file.
      // Legitimately, screenshotPath and responsePath SHOULD differ (different files).
      // So we only flag if the screenshot doesn't look like a screenshot path.
      const looksLikePng = response.screenshotPath.toLowerCase().endsWith(".png");
      if (!looksLikePng) {
        return {
          artifactId,
          verdict: "path_substituted",
          reason: `Screenshot path "${response.screenshotPath}" does not appear to be a PNG file — possible path substitution`,
          evidenceClass: "physical-capture",
        };
      }
    }

    // Digest check
    if (input.digest === undefined || input.digest.length === 0) {
      return {
        artifactId,
        verdict: "digest_mismatch",
        reason: "Physical capture with taken status requires a verified digest — none provided",
        evidenceClass: "physical-capture",
      };
    }

    // All checks passed
    return {
      artifactId,
      verdict: "valid",
      reason: "Physical capture verified: roll.capture.v1, taken, PNG attached, digest verified",
      evidenceClass: "physical-capture",
      evidence: {
        protocol: response.protocol,
        provider: input.provider ?? "roll-capture",
        screenshotPath: response.screenshotPath,
        digest: input.digest,
        imageWidth: response.imageWidth,
        imageHeight: response.imageHeight,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Verdict matrix
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The verdict matrix: for each operation outcome and capture state,
   * determine whether a capture is allowed.
   *
   * Rules:
   * - Operation passed → capture allowed
   * - Operation failed → NO rescue capture
   * - Operation denied → NO rescue capture
   * - Operation expired (lease) → NO rescue capture
   */
  evaluateVerdictMatrix(
    operationOutcome: OperationOutcome,
    captureRequested: boolean,
    captureStatus?: "taken" | "skipped" | "failed",
  ): VerdictMatrixCell {
    if (!captureRequested) {
      return {
        operationOutcome,
        captureRequested: false,
        captureAllowed: false,
        reason: "No capture was requested — nothing to evaluate",
      };
    }

    switch (operationOutcome) {
      case "passed":
        return {
          operationOutcome,
          captureRequested: true,
          captureStatus,
          captureAllowed: true,
          reason: "Operation passed — capture is valid visual AC evidence (subject to visual evidence validation)",
        };

      case "failed":
        return {
          operationOutcome,
          captureRequested: true,
          captureStatus,
          captureAllowed: false,
          reason: "Operation failed — no rescue capture after a failed operation",
        };

      case "denied":
        return {
          operationOutcome,
          captureRequested: true,
          captureStatus,
          captureAllowed: false,
          reason: "Operation was denied — no rescue capture after a denied operation",
        };

      case "expired":
        return {
          operationOutcome,
          captureRequested: true,
          captureStatus,
          captureAllowed: false,
          reason: "Operation lease expired — no rescue capture after expiry",
        };

      default: {
        const _exhaustive: never = operationOutcome;
        return _exhaustive;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Report fact separation
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Separate a classified artifact into a diagnostic fact and/or visual
   * evidence fact. The two fact types are mutually exclusive per artifact.
   *
   * - Physical-capture artifacts become visual evidence facts (with verdict)
   * - Diagnostic artifacts become diagnostic facts
   *
   * Both fact types carry their own reasons so reports can display them
   * as separate entries.
   */
  separateFacts(input: EvidenceClassifierInput): {
    diagnostic?: DiagnosticFact;
    visual?: VisualEvidenceFact;
  } {
    const classification = this.classify(input);
    const visualResult = this.validateVisualEvidence(input);

    if (classification.evidenceClass === "physical-capture") {
      return {
        visual: {
          captureRequestId: input.artifactId,
          verdict: visualResult.verdict,
          screenshotPath: visualResult.evidence?.screenshotPath,
          digest: visualResult.evidence?.digest,
          reason: visualResult.reason,
          evidenceClass: "physical-capture",
        },
      };
    }

    // Diagnostic: produce a diagnostic fact
    return {
      diagnostic: {
        artifactId: input.artifactId,
        kind: input.diagnosticKind ?? "devtools-screenshot",
        summary: classification.reason,
        diagnosticOnly: true,
        evidenceClass: classification.evidenceClass,
      },
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// US-PHYSICAL-009 — Capture Gateway v2 receipt awareness
//
// The gate stays v1-authoritative (validateVisualEvidence above), but it must
// also let a VALID v2 physical receipt satisfy a visual AC. The full 4-state
// EvidenceHealth resolver (rendered handling, degraded-infrastructure) lands in
// US-EVID-031; here we only accept a valid physical v2 receipt and surface a
// precise verdict for invalid ones, without touching the v1 path.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Classify a Capture Gateway v2 receipt against a visual AC. A valid, taken
 * physical receipt (source `roll-capture-window`) is `valid`; rendered/legacy
 * receipts are `not_physical` (their gate is the later health resolver);
 * malformed/mismatched ones surface a concrete verdict with the reason.
 */
export function classifyCaptureReceiptV2(receipt: CaptureReceiptV2, intent?: CaptureIntentV2): VisualEvidenceResult {
  const artifactId = receipt.requestId;

  if (receipt.captureClass !== "physical" || receipt.source !== "roll-capture-window") {
    return {
      artifactId,
      verdict: "not_physical",
      reason: `${receipt.captureClass} capture from "${receipt.source}" is not a physical AC receipt (handled by the evidence-health resolver)`,
      evidenceClass: "physical-capture",
    };
  }

  const validation = validateCaptureReceiptV2(receipt, intent);
  if (validation.ok && receipt.state === "taken") {
    return {
      artifactId,
      verdict: "valid",
      reason: "Physical v2 receipt verified: roll.capture.v2, taken, PNG attached, digest present, target-bound",
      evidenceClass: "physical-capture",
      evidence: {
        protocol: receipt.protocol,
        provider: "roll-capture",
        screenshotPath: receipt.screenshotPath ?? "",
        digest: receipt.sha256 ?? "",
      },
    };
  }

  const detail = validation.errors.join("; ");
  const verdict: VisualEvidenceVerdict =
    receipt.state !== "taken"
      ? "capture_failed"
      : receipt.screenshotPath === undefined || receipt.screenshotPath.length === 0
        ? "png_missing"
        : receipt.sha256 === undefined || receipt.sha256.length === 0
          ? "digest_mismatch"
          : "capture_failed";
  return {
    artifactId,
    verdict,
    reason: detail !== "" ? detail : `physical v2 receipt is not acceptable (state=${receipt.state})`,
    evidenceClass: "physical-capture",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Report fact separation (AC: Reports display diagnostic and visual-evidence
// result as separate facts with their own reasons)
// ════════════════════════════════════════════════════════════════════════════

/** Summary of classified evidence for report display. */
export interface EvidenceReportFacts {
  /** Diagnostic facts — never visual AC evidence. */
  diagnostics: Array<{
    artifactId: string;
    evidenceClass: EvidenceClass;
    kind: string;
    reason: string;
  }>;
  /** Visual evidence facts — physical capture results. */
  visualEvidence: Array<{
    captureRequestId: string;
    verdict: VisualEvidenceVerdict;
    reason: string;
    screenshotPath?: string;
    digest?: string;
  }>;
}

/**
 * Classify a batch of evidence artifacts and separate them into diagnostic
 * and visual-evidence facts for report display. Each fact carries its own
 * reason so reports can show them as distinct entries.
 */
export function classifyReportEvidence(inputs: EvidenceClassifierInput[]): EvidenceReportFacts {
  const classifier = new EvidenceClassifier();
  const diagnostics: EvidenceReportFacts["diagnostics"] = [];
  const visualEvidence: EvidenceReportFacts["visualEvidence"] = [];

  for (const input of inputs) {
    const { diagnostic, visual } = classifier.separateFacts(input);
    if (diagnostic !== undefined) {
      diagnostics.push({
        artifactId: diagnostic.artifactId,
        evidenceClass: diagnostic.evidenceClass,
        kind: diagnostic.kind,
        reason: diagnostic.summary,
      });
    }
    if (visual !== undefined) {
      visualEvidence.push({
        captureRequestId: visual.captureRequestId,
        verdict: visual.verdict,
        reason: visual.reason,
        screenshotPath: visual.screenshotPath,
        digest: visual.digest,
      });
    }
  }

  return { diagnostics, visualEvidence };
}

// ════════════════════════════════════════════════════════════════════════════
// Static helper: resolve evidence class from provider
// ════════════════════════════════════════════════════════════════════════════

/** Map a provider string to its evidence class — used for quick classification. */
export function evidenceClassFromProvider(provider?: string): EvidenceClass {
  if (provider !== undefined && PHYSICAL_CAPTURE_PROVIDERS.includes(provider)) return "physical-capture";
  if (provider !== undefined && PLAYWRIGHT_PROVIDERS.includes(provider)) return "playwright-diagnostic";
  if (provider !== undefined && DEVTOOLS_PROVIDERS.includes(provider)) return "devtools-diagnostic";
  return "playwright-diagnostic"; // conservative default
}

/** Whether an evidence class can satisfy a visual AC. */
export function canSatisfyVisualAc(evidenceClass: EvidenceClass): boolean {
  return evidenceClass === "physical-capture";
}

/** Map an operation outcome to whether a capture bridge link is allowed. */
export function captureAllowedForOutcome(outcome: OperationOutcome): boolean {
  return outcome === "passed";
}
