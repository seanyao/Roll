/**
 * @responsibility Checks post-capture privacy and redaction compliance.
 */
/**
 * US-PHYSICAL-007 — post-capture privacy checker.
 *
 * After Roll Capture.app returns a "taken" screenshot, attest must verify that
 * the pixels actually match what was declared:
 *   - window target  → image must NOT be fullscreen-sized
 *   - display target → only accepted when explicitly declared
 * Anything that fails is recorded as a privacy rejection and degrades to a
 * skipped capture (missing evidence) rather than blocking the card delivery.
 */
import { readFileSync } from "node:fs";
import type { RollCaptureRequestV1, RollCaptureResponseV1 } from "@roll/spec";

export type CapturePrivacyAnnotation = {
  /** App / window / display that was targeted. */
  target: string;
  /** Story/run that requested the capture. */
  requestedBy: string;
  /** ISO timestamp when the host finished the capture. */
  capturedAt: string;
  /** Whether the original request explicitly asked for fullscreen. */
  declaredFullscreen: boolean;
};

export type CapturePrivacyResult =
  | { ok: true; annotation: CapturePrivacyAnnotation }
  | { ok: false; reason: string; annotation: CapturePrivacyAnnotation };

export type DisplaySize = { width: number; height: number };

export type CapturePrivacyOptions = {
  /**
   * Primary display size. When provided, a window-targeted image whose
   * dimensions equal or exceed the display is treated as fullscreen.
   */
  displaySize?: DisplaySize;
  /**
   * Fallback fullscreen threshold when displaySize is not available.
   * Defaults are chosen to catch modern Retina/full-HD displays without
   * rejecting large but genuine application windows.
   */
  fullscreenThreshold?: DisplaySize;
  /** Whether the original card explicitly declared a fullscreen capture. */
  declaredFullscreen?: boolean;
  /** Override the image-dimensions reader for tests. */
  readDimensions?: (path: string) => { width: number; height: number } | null;
};

const DEFAULT_FULLSCREEN_THRESHOLD: DisplaySize = { width: 1440, height: 900 };

/**
 * Read PNG dimensions from the IHDR chunk. Returns null for non-PNG or
 * malformed files so the caller can fall back to "cannot verify".
 */
export function readPngDimensions(path: string): { width: number; height: number } | null {
  try {
    const header = readFileSync(path);
    if (header.length < 24) return null;
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      header[0] !== 0x89 ||
      header[1] !== 0x50 ||
      header[2] !== 0x4e ||
      header[3] !== 0x47 ||
      header[4] !== 0x0d ||
      header[5] !== 0x0a ||
      header[6] !== 0x1a ||
      header[7] !== 0x0a
    ) {
      return null;
    }
    // First chunk length (4 bytes) then "IHDR" (4 bytes), then width/height (4 bytes each, big-endian).
    const width = (header.readUInt8(16) << 24) | (header.readUInt8(17) << 16) | (header.readUInt8(18) << 8) | header.readUInt8(19);
    const height = (header.readUInt8(20) << 24) | (header.readUInt8(21) << 16) | (header.readUInt8(22) << 8) | header.readUInt8(23);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

function isFullscreen(size: DisplaySize, threshold: DisplaySize): boolean {
  return size.width >= threshold.width && size.height >= threshold.height;
}

function formatDimensions(size: DisplaySize): string {
  return `${size.width}x${size.height}`;
}

function targetLabel(request: RollCaptureRequestV1): string {
  if (request.target.type === "window") {
    const title = request.target.windowTitle;
    return title !== undefined && title !== "" ? `${request.target.appName} · ${title}` : request.target.appName;
  }
  if (request.target.type === "region") {
    return `region ${request.target.x},${request.target.y} ${request.target.width}x${request.target.height}`;
  }
  return "fullscreen display";
}

function requestedBy(request: RollCaptureRequestV1): string {
  const parts: string[] = [];
  if (request.storyId !== undefined && request.storyId !== "") parts.push(request.storyId);
  if (request.runId !== undefined && request.runId !== "") parts.push(request.runId);
  return parts.length > 0 ? parts.join(" / ") : request.requestId;
}

/**
 * Check a taken screenshot against its declared target.
 *
 * The check is intentionally conservative: when dimensions are unavailable
 * (missing from response and unreadable from disk) the capture is rejected.
 * A rejected capture is recorded but degrades to "missing evidence" so the
 * card can still complete with other evidence.
 */
export function checkCapturePrivacy(
  request: RollCaptureRequestV1,
  response: RollCaptureResponseV1,
  options: CapturePrivacyOptions = {},
): CapturePrivacyResult {
  const declaredFullscreen = options.declaredFullscreen ?? request.target.type === "display";
  const annotation: CapturePrivacyAnnotation = {
    target: targetLabel(request),
    requestedBy: requestedBy(request),
    capturedAt: response.finishedAt,
    declaredFullscreen,
  };

  // Fullscreen must be explicitly declared. If the target is display but the
  // caller says it was not declared, reject.
  if (request.target.type === "display" && !declaredFullscreen) {
    return {
      ok: false,
      reason: "display capture rejected: fullscreen was not explicitly declared",
      annotation,
    };
  }

  // Region targets are not subject to the window/fullscreen privacy rule.
  if (request.target.type === "region") {
    return { ok: true, annotation };
  }

  // Resolve image dimensions: prefer host-reported metadata, fall back to disk.
  let dimensions: { width: number; height: number } | null = null;
  if (response.imageWidth !== undefined && response.imageHeight !== undefined) {
    dimensions = { width: response.imageWidth, height: response.imageHeight };
  } else if (response.screenshotPath !== undefined && response.screenshotPath !== "") {
    const reader = options.readDimensions ?? readPngDimensions;
    dimensions = reader(response.screenshotPath);
  }

  if (dimensions === null) {
    return {
      ok: false,
      reason: "window capture rejected: could not read image dimensions to verify bounds",
      annotation,
    };
  }

  const threshold = options.displaySize ?? options.fullscreenThreshold ?? DEFAULT_FULLSCREEN_THRESHOLD;

  if (request.target.type === "window" && isFullscreen(dimensions, threshold)) {
    return {
      ok: false,
      reason: `window capture rejected: image is fullscreen size (${formatDimensions(dimensions)})`,
      annotation,
    };
  }

  return { ok: true, annotation };
}
