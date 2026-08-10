/**
 * @responsibility Reports browser-operations readiness for doctor and browser doctor.
 */
/**
 * US-BROW-003 — browser operations readiness for `roll doctor --tools` and
 * `roll browser doctor`.
 *
 * Combines the non-mutating DevTools probes (infra) with Roll Capture readiness
 * (reused, but never a prerequisite for managed diagnostics) and the pure
 * verdict aggregate (core). The rendered row makes an unavailable browser
 * honest — a degraded/blocked lane can never read as a passing check.
 */
import { deriveBrowserEnvironmentReadiness } from "@roll/core";
import type { BrowserEnvironmentReadiness, BrowserLaneReadiness, BrowserLaneVerdict, BrowserProbeResult } from "@roll/spec";
import { probeBrowserEnvironment, defaultBrowserEnvironmentProbeDeps, type BrowserEnvironmentProbeDeps } from "@roll/infra";
import { collectRollCaptureReadiness, type RollCaptureReadiness } from "./roll-capture-readiness.js";

export function collectBrowserEnvironmentReadiness(
  captureReadiness: RollCaptureReadiness = collectRollCaptureReadiness(),
  probeDeps: BrowserEnvironmentProbeDeps = defaultBrowserEnvironmentProbeDeps(),
  probeResult?: BrowserProbeResult,
): BrowserEnvironmentReadiness {
  const captureStatus = {
    status: captureReadiness.status,
    detail: captureReadiness.detailLines.join("; "),
  };
  const observations = probeBrowserEnvironment(captureStatus, probeDeps);
  return deriveBrowserEnvironmentReadiness(observations, probeResult);
}

function marker(verdict: BrowserLaneVerdict): string {
  if (verdict === "ready") return "✓";
  if (verdict === "configured") return "○";
  if (verdict === "degraded") return "~";
  return "✗";
}

/** Compact block for `roll doctor --tools`. */
export function renderBrowserReadinessDoctorRow(readiness: BrowserEnvironmentReadiness): string[] {
  const lines = ["", "Browser operations readiness", "浏览器操作就绪度", ""];
  for (const lane of [readiness.managed, readiness.interactive, readiness.capture]) {
    lines.push(`  ${marker(lane.verdict)} ${lane.lane}: ${lane.verdict} — ${lane.reason}`);
    for (const action of lane.actions) lines.push(`    fix: ${action}`);
  }
  return lines;
}

/** Verbose three-lane readout for `roll browser doctor`. */
export function renderBrowserDoctor(readiness: BrowserEnvironmentReadiness): string[] {
  const lines: string[] = [];
  const pad = (lane: BrowserLaneReadiness): string => {
    const head = `${lane.lane}:`;
    return `${marker(lane.verdict)} ${head.padEnd(13)}${lane.verdict.padEnd(9)}${lane.reason}`;
  };
  for (const lane of [readiness.managed, readiness.interactive, readiness.capture]) {
    lines.push(pad(lane));
    for (const action of lane.actions) lines.push(`    → ${action}`);
  }
  return lines;
}
