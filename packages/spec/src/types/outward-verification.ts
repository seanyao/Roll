/**
 * @responsibility Declares the outward behavior verification types.
 */
/**
 * US-ATTEST-015 — Outward behavior verification types.
 *
 * An "outward" AC is a behavior that cannot be verified locally (e.g. real
 * `npm install`, published CLI startup, OAuth callback). Outward ACs must
 * carry an explicit verification declaration (external-smoke or owner-attested);
 * the system never infers outward from prose.
 *
 * The status ladder below feeds the attest report AcStatus ladder (§report.ts)
 * but adds an enforcement layer: simulation-only or skipped manual work must
 * never promote to a positive AC status. These types are pure schema — the
 * validator and resolver live in @roll/core.
 */

// ── Outward verification declarations ──────────────────────────────────────

/** A machine-executable external smoke command (run in isolated environment). */
export interface OutwardSmokeDeclaration {
  mode: "external-smoke";
  /** Shell command template (must be declared in spec; no free-form injection). */
  command: string;
  /** The environment the smoke runs in. */
  environment: "ci" | "nightly" | "release";
  /** Max execution time in seconds. */
  timeoutSec: number;
}

/** A human owner attestation (manual verification with traceable approval). */
export interface OwnerAttestedDeclaration {
  mode: "owner-attested";
  /** Why manual attestation is necessary (and why smoke can't cover it). */
  reason: string;
  /** Traceable reference (e.g. GitHub issue/discussion, sign-off commit). */
  approvalRef: string;
  /** Optional: ISO date after which the attestation should be re-confirmed. */
  expiresAt?: string;
  /** Optional: scope limitation (e.g. "only the macOS arm64 install path"). */
  scope?: string;
}

/** Discriminated union: every outward AC must carry exactly one. */
export type OutwardVerificationDeclaration = OutwardSmokeDeclaration | OwnerAttestedDeclaration;

// ── Verification status (outcome, not declaration) ─────────────────────────

/**
 * The OUTCOME of an outward verification. These are resolved at report time
 * from the available evidence artifacts (smoke results, owner attestation
 * records) and feed into the attest report AcStatus ladder.
 *
 * Important: `verified-in-simulation` is a distinct, non-positive status —
 * it means `npm pack` or a local mock passed but the real external smoke did
 * NOT run. It must never promote to `pass`/`pass-with-evidence`.
 */
export type OutwardVerificationStatus =
  | "verified"              // external-smoke ran and passed
  | "verified-in-simulation" // simulation only; real smoke did not run
  | "unverified-external"   // outward declared but no smoke/attestation evidence exists
  | "failed-external";       // external-smoke ran and failed

// ── Validation result ──────────────────────────────────────────────────────

/** A single validation finding for an outward verification declaration. */
export interface OutwardValidationError {
  /** The AC id this finding relates to. */
  ac: string;
  /** Machine-readable error code. */
  code: "missing_declaration" | "missing_command" | "missing_environment" | "invalid_environment" | "missing_timeout" | "invalid_timeout" | "missing_reason" | "missing_approval_ref" | "invalid_mode";
  /** Human-readable repair instruction (single sentence). */
  message: string;
}

/** Result of validating a story's outward verification declarations. */
export interface OutwardValidationResult {
  valid: boolean;
  errors: OutwardValidationError[];
}

// ── Resolved outward status for a single AC ────────────────────────────────

/** The resolved outward verification status for one AC, with provenance. */
export interface OutwardAcVerification {
  /** The AC id. */
  ac: string;
  /** Resolved outcome status. */
  status: OutwardVerificationStatus;
  /** When `verified`, the smoke artifact reference. */
  smokeArtifact?: { command: string; environment: string; exitCode: number; summary: string };
  /** When `failed-external`, the failure detail. */
  failureDetail?: string;
  /** When `owner-attested`, the attestation record ref. */
  ownerAttestation?: { reason: string; approvalRef: string; expiresAt?: string };
  /** When the resolved status is not `verified`, what's blocking it. */
  note?: string;
}
