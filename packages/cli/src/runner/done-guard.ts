/**
 * RL-EVID-004: registered redline in policy/rules.yaml — a card may only be
 * marked Done when the merge is confirmed on main AND acceptance evidence is
 * complete. markDoneGuarded() enforces it at the status-write boundary: it
 * rejects the transition instead of trusting the caller's claim.
 */
import { existsSync } from "node:fs";
import { STATUS_MARKER } from "@roll/spec";
import { cardArchiveDir } from "../lib/archive.js";
import { evidencePathsUnresolved, readAcMapEntries, verificationReportHasContent, verificationReportPath } from "./attest-gate.js";

export interface DoneGuardEvidence {
  mergedToMain: boolean;
}

export interface DoneGuardDeps {
  markStatus: (projectCwd: string, id: string, status: string) => void;
  alert?: (message: string) => void;
}

export interface DoneGuardResult {
  ok: boolean;
  missing: string[];
  debt?: boolean;
}

export function acceptanceEvidenceGaps(projectCwd: string, id: string): string[] {
  const gaps: string[] = [];
  const report = verificationReportPath(projectCwd, id);
  if (!existsSync(report)) gaps.push(`report missing: ${report}`);
  const entries = readAcMapEntries(projectCwd, id);
  if (entries === null || entries.length === 0) {
    gaps.push("ac-map.json missing or empty");
  } else {
    const claimed = entries.filter((entry) => entry.status === "claimed").map((entry) => entry.ac ?? "?");
    if (claimed.length > 0) gaps.push(`claimed evidence status: ${claimed.join(", ")}`);
    const failed = entries.filter((entry) => entry.status === "fail").map((entry) => entry.ac ?? "?");
    if (failed.length > 0) gaps.push(`failed evidence status: ${failed.join(", ")}`);
  }
  gaps.push(...evidencePathsUnresolved(projectCwd, id));
  if (existsSync(report) && !verificationReportHasContent(projectCwd, id)) gaps.push("report content floor failed");
  return gaps;
}

function hasAcceptanceEvidenceDirectory(projectCwd: string, id: string): boolean {
  const cardDir = cardArchiveDir(projectCwd, id);
  return ["latest", "evidence", "screenshots", "ac-map.json"].some((name) => existsSync(`${cardDir}/${name}`));
}

export function markDoneGuarded(
  projectCwd: string,
  id: string,
  evidence: DoneGuardEvidence,
  deps: DoneGuardDeps,
): DoneGuardResult {
  if (evidence.mergedToMain && !hasAcceptanceEvidenceDirectory(projectCwd, id)) {
    deps.alert?.(`Done guard evidence_debt ${id}: legacy merged card has no acceptance evidence directory`);
    deps.markStatus(projectCwd, id, `${STATUS_MARKER.done} · evidence_debt`);
    return { ok: true, missing: [], debt: true };
  }
  const missing = [
    ...(evidence.mergedToMain ? [] : ["merge not confirmed on main"]),
    ...acceptanceEvidenceGaps(projectCwd, id),
  ];
  if (missing.length > 0) {
    deps.alert?.(`Done guard rejected ${id}: ${missing.join(", ")}`);
    return { ok: false, missing };
  }
  deps.markStatus(projectCwd, id, STATUS_MARKER.done);
  return { ok: true, missing: [] };
}
