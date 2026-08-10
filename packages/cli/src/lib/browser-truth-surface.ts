/**
 * @responsibility Renders the shared browser-operations truth surface for supervisor and dossier views.
 */
/**
 * US-BROW-009b — shared rendering surface that consumes {@link BrowserOperationsTruth}
 * from the truth adapter (US-BROW-009a). Both `roll supervisor next` and
 * `roll doctor --tools` render browser readiness through this module so there
 * is exactly one formatter for the three readiness lanes.
 *
 * Contract: every consumer that displays managed / interactive / capture
 * readiness goes through this renderer — no parallel formatter.
 */
import type { BrowserOperationsTruth } from "@roll/spec";

/** Status marker symbols used by both compact and verbose rendering. */
function marker(status: string): string {
  if (status === "ready") return "✓";
  if (status === "degraded" || status === "expired") return "~";
  return "✗";
}

function reasonLine(laneLabel: string, status: string, reason?: string, expiresAt?: string): string {
  let line = `${laneLabel}: ${status}`;
  if (reason) line += ` — ${reason}`;
  if (expiresAt) line += ` (expires ${expiresAt})`;
  return line;
}

/** Compact three-lane block for `roll doctor --tools`. */
export function renderBrowserTruthDoctorRow(truth: BrowserOperationsTruth): string[] {
  const lines = ["", "Browser operations readiness (truth)", "浏览器操作就绪度（事实）", ""];
  lines.push(`  ${marker(truth.managed.status)} ${reasonLine("managed", truth.managed.status, truth.managed.unavailableReason)}`);
  lines.push(
    `  ${marker(truth.lease.status)} ${reasonLine("interactive", truth.lease.status, truth.lease.unavailableReason, truth.lease.expiresAt)}`,
  );
  lines.push(`  ${marker(truth.capture.status)} ${reasonLine("capture", truth.capture.status, truth.capture.unavailableReason)}`);
  return lines;
}

/** Per-lane block for `roll supervisor next` — shows each lane with status,
 *  unavailable reason, and lease expiry per AC requirement. */
export function renderBrowserTruthSupervisorLine(truth: BrowserOperationsTruth): string[] {
  const lines = ["  browser readiness:"];
  lines.push(`    ${marker(truth.managed.status)} managed: ${truth.managed.status}${truth.managed.unavailableReason ? ` — ${truth.managed.unavailableReason}` : ""}`);
  const leaseLine = `    ${marker(truth.lease.status)} interactive: ${truth.lease.status}${truth.lease.unavailableReason ? ` — ${truth.lease.unavailableReason}` : ""}${truth.lease.expiresAt ? ` (expires ${truth.lease.expiresAt})` : ""}`;
  lines.push(leaseLine);
  lines.push(`    ${marker(truth.capture.status)} capture: ${truth.capture.status}${truth.capture.unavailableReason ? ` — ${truth.capture.unavailableReason}` : ""}`);
  return lines;
}

/** Verbose three-lane block for `roll browser doctor` or dossier detail. */
export function renderBrowserTruthVerbose(truth: BrowserOperationsTruth): string[] {
  const lines: string[] = [];
  const pad = (label: string, status: string): string => {
    const head = `${label}:`;
    return `${marker(status)} ${head.padEnd(15)}${status.padEnd(9)}`;
  };

  lines.push(pad("managed", truth.managed.status) + (truth.managed.unavailableReason ?? ""));
  if (truth.managed.unavailableReason) lines.push(`    → ${truth.managed.unavailableReason}`);

  const leaseExtra = truth.lease.expiresAt ? ` expires ${truth.lease.expiresAt}` : "";
  lines.push(pad("interactive", truth.lease.status) + (truth.lease.unavailableReason ?? "") + leaseExtra);
  if (truth.lease.unavailableReason) lines.push(`    → ${truth.lease.unavailableReason}`);

  lines.push(pad("capture", truth.capture.status) + (truth.capture.unavailableReason ?? ""));
  if (truth.capture.unavailableReason) lines.push(`    → ${truth.capture.unavailableReason}`);

  return lines;
}
