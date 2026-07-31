/**
 * @responsibility Evaluates outward verification declarations and their execution outcomes.
 * US-ATTEST-015 — Outward verification validator and status resolver.
 *
 * Pure functions: no filesystem, no clock, no side effects.
 *
 * Two responsibilities:
 *   1. VALIDATE outward declarations in the evaluation contract (AC2)
 *   2. RESOLVE outward verification status from evidence artifacts (AC3)
 *   3. CLASSIFY outward status into the AcStatus ladder for the report (AC3)
 *
 * Outward ACs are identified by the presence of `external-smoke` or
 * `owner-attested` evidence items in the evaluation contract. The system
 * never infers outward behavior from prose (AC1).
 */
import type {
  OutwardSmokeDeclaration,
  OwnerAttestedDeclaration,
  OutwardVerificationDeclaration,
  OutwardVerificationStatus,
  OutwardValidationError,
  OutwardValidationResult,
  OutwardAcVerification,
} from "@roll/spec";
import type { AcStatus } from "./report.js";

// ════════════════════════════════════════════════════════════════════════════
// Re-export convenience types for callers
// ════════════════════════════════════════════════════════════════════════════

export type {
  OutwardSmokeDeclaration,
  OwnerAttestedDeclaration,
  OutwardVerificationDeclaration,
  OutwardVerificationStatus,
  OutwardValidationError,
  OutwardValidationResult,
  OutwardAcVerification,
};

/**
 * A flat map of AC id → outward declaration (one per AC).
 * Callers build this from the evaluation contract's expected_evidence items.
 */
export type OutwardEvidenceMap = Record<string, OutwardVerificationDeclaration>;

/**
 * A smoke result artifact produced by an external smoke runner (US-ATTEST-016).
 * For US-ATTEST-015, callers supply whatever smoke data is available — in
 * practice this comes from smoke artifact files or is empty.
 */
export interface OutwardSmokeResult {
  ac: string;
  exitCode: number;
  summary: string;
  command: string;
  environment: string;
}

/**
 * Simulation evidence — a non-external test/command that ran locally but
 * cannot substitute for real outward verification.
 */
export interface SimulationEvidence {
  ac: string;
  kind: string;
  label: string;
}

export interface OwnerAttestationRecord {
  ac: string;
  reason: string;
  approvalRef: string;
  expiresAt?: string;
}

/** Aggregated report output from classifyOutwardStatusForReport. */
export interface OutwardReportClassification {
  /** Per-AC outward verification status. */
  acStatuses: Map<string, OutwardVerificationStatus>;
  /** Validation errors for repair display. */
  validationErrors: OutwardValidationError[];
  /** Summary: does the contract validate? */
  contractValid: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION (AC2)
// ════════════════════════════════════════════════════════════════════════════

const VALID_ENVIRONMENTS = new Set(["ci", "nightly", "release"]);

/**
 * Validate outward verification declarations in the evaluation contract.
 *
 * Each evidence item with kind `external-smoke` or `owner-attested` must
 * carry complete, valid metadata. Any gap produces a repairable error message.
 *
 * Legacy contracts with no outward evidence items are trivially valid (AC4).
 */
export function validateOutwardDeclarations(
  contract: { expected_evidence: Array<{ kind: string; proves: string; outward?: OutwardVerificationDeclaration }> },
): OutwardValidationResult {
  const errors: OutwardValidationError[] = [];

  for (const item of contract.expected_evidence) {
    if (item.kind !== "external-smoke" && item.kind !== "owner-attested") continue;

    const ac = item.proves.trim() === "" ? "?" : item.proves;

    // Outward evidence item without outward metadata
    if (item.outward === undefined) {
      errors.push({
        ac,
        code: "missing_declaration",
        message: `${ac}: outward evidence kind "${item.kind}" requires an outward verification declaration with full metadata`,
      });
      continue;
    }

    const outward = item.outward as { mode: string; command?: string; environment?: string; timeoutSec?: number; reason?: string; approvalRef?: string };

    if (outward.mode !== "external-smoke" && outward.mode !== "owner-attested") {
      errors.push({
        ac,
        code: "invalid_mode",
        message: `${ac}: outward mode must be "external-smoke" or "owner-attested", got "${String(outward.mode)}"`,
      });
      continue;
    }

    if (outward.mode === "external-smoke") {
      const cmd = outward.command?.trim() ?? "";
      if (cmd === "") {
        errors.push({ ac, code: "missing_command", message: `${ac}: external-smoke requires a non-empty command` });
      }
      const env = outward.environment ?? "";
      if (env === "") {
        errors.push({ ac, code: "missing_environment", message: `${ac}: external-smoke requires an environment (ci/nightly/release)` });
      } else if (!VALID_ENVIRONMENTS.has(env)) {
        errors.push({
          ac,
          code: "invalid_environment",
          message: `${ac}: external-smoke environment must be ci/nightly/release, got "${env}"`,
        });
      }
      const timeout = outward.timeoutSec;
      if (timeout === undefined || timeout === null || timeout <= 0) {
        errors.push({
          ac,
          code: "invalid_timeout",
          message: `${ac}: external-smoke requires a positive timeout_sec (got ${String(timeout)})`,
        });
      }
    }

    if (outward.mode === "owner-attested") {
      const reason = outward.reason?.trim() ?? "";
      if (reason === "") {
        errors.push({
          ac,
          code: "missing_reason",
          message: `${ac}: owner-attested requires a reason explaining why manual attestation is necessary`,
        });
      }
      const ref = outward.approvalRef?.trim() ?? "";
      if (ref === "") {
        errors.push({
          ac,
          code: "missing_approval_ref",
          message: `${ac}: owner-attested requires an approval reference (GitHub link, commit, etc.)`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ════════════════════════════════════════════════════════════════════════════
// STATUS RESOLUTION (AC3)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a flat outward evidence map from the evaluation contract.
 * Only outward evidence items are included; non-outward items are skipped.
 */
export function buildOutwardEvidenceMap(
  contract: { expected_evidence: Array<{ kind: string; proves: string; outward?: OutwardVerificationDeclaration }> },
): OutwardEvidenceMap {
  const map: OutwardEvidenceMap = {};
  for (const item of contract.expected_evidence) {
    if (item.outward !== undefined && item.proves.trim() !== "") {
      map[item.proves] = item.outward;
    }
  }
  return map;
}

/**
 * Resolve outward verification status for every outward AC.
 *
 * Rules (consistent with the outward-verification-plan.md failure matrix):
 *   - Smoke result exitCode=0 → verified
 *   - Smoke result exitCode≠0 → failed-external
 *   - No smoke results, no simulation evidence → unverified-external
 *   - No smoke results, simulation evidence present → verified-in-simulation
 *   - Owner attestation record matches → verified
 *   - Owner attestation expired → unverified-external
 *   - No attestation record → unverified-external
 *   - Smoke result takes precedence over simulation
 *
 * Pure: given the same inputs, always returns the same outputs.
 */
export function resolveOutwardVerificationStatus(
  outwardMap: OutwardEvidenceMap,
  smokeResults: OutwardSmokeResult[],
  simulationEvidence: SimulationEvidence[],
  ownerAttestations?: OwnerAttestationRecord[],
): OutwardAcVerification[] {
  const smokeByAc = new Map<string, OutwardSmokeResult[]>();
  for (const s of smokeResults) smokeByAc.set(s.ac, [...(smokeByAc.get(s.ac) ?? []), s]);

  const simByAc = new Set(simulationEvidence.map((s) => s.ac));
  const ownerByAc = new Map<string, OwnerAttestationRecord[]>();
  for (const o of ownerAttestations ?? []) ownerByAc.set(o.ac, [...(ownerByAc.get(o.ac) ?? []), o]);

  const results: OutwardAcVerification[] = [];

  for (const [ac, declaration] of Object.entries(outwardMap)) {
    if (declaration.mode === "external-smoke") {
      const smoke = smokeByAc.get(ac);

      if (smoke !== undefined && smoke.length > 0) {
        // Pick the first matching smoke result
        const match = smoke[0];
        if (match === undefined) continue;
        if (match.exitCode === 0) {
          results.push({
            ac,
            status: "verified",
            smokeArtifact: {
              command: match.command,
              environment: match.environment,
              exitCode: match.exitCode,
              summary: match.summary,
            },
          });
        } else {
          results.push({
            ac,
            status: "failed-external",
            failureDetail: `exit code ${match.exitCode}: ${match.summary}`,
          });
        }
      } else if (simByAc.has(ac)) {
        // Simulation ran but no real smoke → verified-in-simulation (NOT verified)
        results.push({
          ac,
          status: "verified-in-simulation",
          note: "local simulation passed but no external smoke results exist — this is not a positive verification",
        });
      } else {
        results.push({
          ac,
          status: "unverified-external",
          note: `no smoke results available for environment "${declaration.environment}" and no local simulation evidence`,
        });
      }
    } else if (declaration.mode === "owner-attested") {
      const records = ownerByAc.get(ac);

      if (records !== undefined && records.length > 0) {
        const record = records[0];
        if (record === undefined) continue;
        // Check expiration
        const now = new Date();
        const expired = record.expiresAt !== undefined && record.expiresAt !== "" && new Date(record.expiresAt) < now;

        if (expired) {
          results.push({
            ac,
            status: "unverified-external",
            ownerAttestation: { reason: record.reason, approvalRef: record.approvalRef, expiresAt: record.expiresAt },
            note: `owner attestation expired at ${record.expiresAt} — re-attestation required`,
          });
        } else {
          results.push({
            ac,
            status: "verified",
            ownerAttestation: { reason: record.reason, approvalRef: record.approvalRef, expiresAt: record.expiresAt },
          });
        }
      } else {
        results.push({
          ac,
          status: "unverified-external",
          note: `no owner attestation record found — manual verification at "${declaration.approvalRef}" is pending`,
        });
      }
    }
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// STATUS → AcStatus MAPPING (AC3)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Map outward verification status to the attest report's AcStatus ladder.
 *
 * THE RED LINE (AC3): `verified-in-simulation` must NEVER produce `pass` or
 * `pass-with-evidence`. Simulation alone cannot make an outward AC green.
 */
export function outwardAcStatusFromVerification(status: OutwardVerificationStatus): AcStatus {
  switch (status) {
    case "verified":
      return "pass";
    case "verified-in-simulation":
      // Simulation passed, but no real outward verification → NOT pass
      return "claimed";
    case "unverified-external":
      return "claimed";
    case "failed-external":
      return "fail";
    default:
      return "claimed";
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CLASSIFY FOR REPORT (AC3 — aggregate)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Classify the outward verification status of all ACs in a story's evaluation
 * contract for the report. This is the top-level entry point to feed outward
 * status into the attest report's AcReportItem mappings.
 *
 * Returns null when there are no outward evidence items in the contract (AC4:
 * legacy stories degrade gracefully with no outward status).
 */
export function classifyOutwardStatusForReport(
  contract: { expected_evidence: Array<{ kind: string; proves: string; outward?: OutwardVerificationDeclaration }> },
  smokeResults: OutwardSmokeResult[],
  simulationEvidence: SimulationEvidence[],
  ownerAttestations?: OwnerAttestationRecord[],
): OutwardReportClassification | null {
  const outwardMap = buildOutwardEvidenceMap(contract);
  if (Object.keys(outwardMap).length === 0) return null;

  const validationResult = validateOutwardDeclarations(contract);
  const resolved = resolveOutwardVerificationStatus(outwardMap, smokeResults, simulationEvidence, ownerAttestations);

  const acStatuses = new Map<string, OutwardVerificationStatus>();
  for (const r of resolved) {
    acStatuses.set(r.ac, r.status);
  }

  return {
    acStatuses,
    validationErrors: validationResult.errors,
    contractValid: validationResult.valid,
  };
}
