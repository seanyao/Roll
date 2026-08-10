/**
 * @responsibility Probes and atomically records honest capture-source capabilities.
 * US-PHYSICAL-012 — honest capabilities.json writer + capability probe.
 *
 * The capture-policy gateway reads `<captureRoot>/capabilities.json` to decide
 * per-source readiness (US-PHYSICAL-011). Nothing wrote it, so the v2 gateway was
 * permanently unavailable. This resolves what roll can ACTUALLY serve from a real
 * probe and writes the per-source advertisement — never claiming a source it does
 * not serve. It never advertises the physical lane's v2 (that is US-PHYSICAL-014);
 * the rendered lane advertises v2 only when the renderer is genuinely present.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROLL_CAPTURE_PROTOCOL_V2,
  type CaptureProtocolAdvertisement,
  type CaptureSource,
  type CaptureSourceAdvertisement,
} from "@roll/spec";

/** A real capability probe — every field is measured, never guessed. */
export interface AdapterCapabilityProbe {
  /** Whether the in-process renderer (Playwright Chromium) can serve rendered v2 NOW. */
  rendererServed: boolean;
  /** Actionable reason when the renderer is not served (e.g. Chromium missing). */
  rendererReason?: string;
  /**
   * The physical host's (native Roll Capture.app) advertised source capability, or
   * null when no host is detected. Today this is v1-only (US-PHYSICAL-014 upgrades it).
   */
  physical?: CaptureSourceAdvertisement | null;
  /** Adapter build tag, for diagnostics. */
  hostVersion: string;
}

/**
 * Resolve the honest per-source advertisement from a real probe. The rendered
 * lane advertises v2 ONLY when the renderer is served; otherwise it records
 * `served: false` with a reason (never omitted-as-if-fine, never over-claimed).
 * `protocols` is the union of protocols a source ACTUALLY serves.
 */
export function resolveAdapterCapabilities(probe: AdapterCapabilityProbe): CaptureProtocolAdvertisement {
  const sources: Partial<Record<CaptureSource, CaptureSourceAdvertisement>> = {
    "playwright-rendered": probe.rendererServed
      ? { protocol: ROLL_CAPTURE_PROTOCOL_V2, served: true }
      : {
          protocol: ROLL_CAPTURE_PROTOCOL_V2,
          served: false,
          reason: probe.rendererReason ?? "Playwright Chromium is not installed",
        },
  };
  if (probe.physical !== undefined && probe.physical !== null) {
    sources["roll-capture-window"] = probe.physical;
  }
  const protocols = Array.from(
    new Set(
      (Object.values(sources).filter((s): s is CaptureSourceAdvertisement => s !== undefined && s.served)).map(
        (s) => s.protocol,
      ),
    ),
  ).sort();
  return { protocols, sources, hostVersion: probe.hostVersion };
}

export function captureCapabilitiesPath(captureRoot: string): string {
  return join(captureRoot, "capabilities.json");
}

/**
 * Atomically write capabilities.json (tmp + rename). Writing identical content is
 * idempotent (byte-stable). Only the resolved advertisement is written — this
 * never fabricates a source the probe did not report.
 */
export function writeCaptureCapabilities(captureRoot: string, advertisement: CaptureProtocolAdvertisement): string {
  mkdirSync(captureRoot, { recursive: true });
  const target = captureCapabilitiesPath(captureRoot);
  const body = `${JSON.stringify(advertisement, null, 2)}\n`;
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, target);
  return target;
}

/** Convenience: probe → resolve → write, returning the written advertisement + path. */
export function refreshCaptureCapabilities(
  captureRoot: string,
  probe: AdapterCapabilityProbe,
): { advertisement: CaptureProtocolAdvertisement; path: string } {
  const advertisement = resolveAdapterCapabilities(probe);
  const path = writeCaptureCapabilities(captureRoot, advertisement);
  return { advertisement, path };
}
