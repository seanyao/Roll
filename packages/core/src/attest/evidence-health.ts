/**
 * @responsibility Resolves visual-evidence health independently from delivery correctness.
 * US-EVID-031 — EvidenceHealth resolver + gate separation.
 *
 * Delivery correctness and visual-evidence health are SEPARATE facts. A broken
 * capture machine (`degraded-infrastructure`) must never force a completed story
 * to be rebuilt, while a missing capture contract (`absent-contract`) or a
 * poisoned lane (`invalid-target`) still fails loudly.
 *
 * The resolver maps a CaptureRunResult (US-EVID-030) + the delivery verdict +
 * whether a capture contract was declared onto one of EXACTLY four visual states
 * (best-effort-capture-plan.md → "Gate semantics"):
 *
 *   | visual state             | when                                                        |
 *   |--------------------------|-------------------------------------------------------------|
 *   | verified                 | ≥1 valid, target-bound taken image (physical OR rendered)   |
 *   | degraded-infrastructure  | all lanes attempted; only host/provider/tooling failures    |
 *   | invalid-target           | a lane hit login/redirect/wrong target/corrupt/forged       |
 *   | absent-contract          | no declared surface, no planned attempt, or planner bypassed |
 *
 * Precedence is DETERMINISTIC and encodes the scorer_focus attacks:
 *   1. `invalid-target` (a poisoned lane) BLOCKS and WINS over a coexisting valid
 *      image on the same surface — one good image can never mask a poisoned lane.
 *   2. `degraded-infrastructure` (zero valid images, only host failures) is NEVER
 *      disguised as `verified`.
 *
 * The resolver reads the durable attempt facts' `failureKind` (set by the
 * planner) — never a brittle reason-string match — to tell a poisoned lane apart
 * from a broken machine.
 */

import type {
  EvidenceHealth,
  EvidenceVisualState,
  CaptureReceiptState,
} from "@roll/spec";
import { EVIDENCE_BLOCKING_VISUAL_STATES } from "@roll/spec";
import type { CaptureFailureKind, CaptureRunResult } from "./capture-planner.js";

// ── Resolver input (structural — the real CaptureRunResult satisfies it) ──────

/** One attempt, reduced to what the resolver needs. `CaptureAttemptFact` fits. */
export interface EvidenceAttemptView {
  requestId: string;
  state: CaptureReceiptState;
  accepted: boolean;
  failureKind?: CaptureFailureKind;
}

/** The capture run, reduced to what the resolver needs. `CaptureRunResult` fits. */
export interface EvidenceRunView {
  surfaceId: string | null;
  attempts: readonly EvidenceAttemptView[];
  /** Requested (planned + dispatched) lanes — used to detect "no planned attempt". */
  requested?: readonly { requestId: string }[];
}

export interface ResolveEvidenceHealthInput {
  /**
   * The delivery (product/AC correctness) verdict, resolved INDEPENDENTLY of
   * visual evidence. A broken capture machine must not flip this to `failed`.
   */
  delivery: "passed" | "failed";
  /**
   * Did the story DECLARE a visual capture contract (a deliverable surface)?
   * `false` ⇒ `absent-contract` (nothing was ever contracted to capture).
   */
  contractDeclared: boolean;
  /** The CaptureRunResult. Absent/null ⇒ the planner never ran (bypassed). */
  run?: EvidenceRunView | null;
}

// ── Core resolver (AC1) ───────────────────────────────────────────────────────

/**
 * Resolve EXACTLY one of the four visual states plus the delivery verdict into a
 * single `EvidenceHealth` fact (AC1). Pure and deterministic.
 */
export function resolveEvidenceHealth(input: ResolveEvidenceHealthInput): EvidenceHealth {
  const run = input.run ?? null;
  const attempts = run?.attempts ?? [];
  const acceptedReceiptIds = attempts.filter((a) => a.accepted && a.state === "taken").map((a) => a.requestId);
  const attemptIds = attempts.map((a) => a.requestId);
  const visual = resolveVisualState(input.contractDeclared, run, attempts, acceptedReceiptIds.length);
  return { delivery: input.delivery, visual, acceptedReceiptIds, attempts: attemptIds };
}

function resolveVisualState(
  contractDeclared: boolean,
  run: EvidenceRunView | null,
  attempts: readonly EvidenceAttemptView[],
  acceptedCount: number,
): EvidenceVisualState {
  // absent-contract — no declared surface, no planned attempt, or planner bypassed.
  if (!contractDeclared) return "absent-contract";
  if (run === null) return "absent-contract";
  if (run.surfaceId === null) return "absent-contract";
  const plannedCount = run.requested?.length ?? 0;
  if (plannedCount === 0 && attempts.length === 0) return "absent-contract";

  // invalid-target — a poisoned lane BLOCKS and WINS over a coexisting valid image
  // on the same surface (scorer_focus). This precedence is intentional: checked
  // BEFORE verified so one good image never masks a poisoned lane.
  if (attempts.some((a) => a.failureKind === "invalid-target")) return "invalid-target";

  // verified — at least one valid, target-bound taken image (physical OR rendered).
  if (acceptedCount > 0) return "verified";

  // degraded-infrastructure — lanes attempted but only host/provider/tooling
  // failures/timeouts/skips occurred. Never disguised as verified (scorer_focus).
  return "degraded-infrastructure";
}

/** Convenience overload: resolve straight from a real CaptureRunResult. */
export function resolveEvidenceHealthFromRun(args: {
  delivery: "passed" | "failed";
  contractDeclared: boolean;
  run: CaptureRunResult | null;
}): EvidenceHealth {
  return resolveEvidenceHealth({
    delivery: args.delivery,
    contractDeclared: args.contractDeclared,
    run: args.run,
  });
}

// ── Gate separation (AC2 / AC3 / AC5) ─────────────────────────────────────────

/**
 * The coarse, gate-facing category (AC5 — three distinct signals plus the
 * healthy case). `delivery-failure` is a product/AC failure; `evidence-*` are
 * the visual-health signals, kept strictly separate from delivery.
 */
export type EvidenceCategory =
  | "delivery-failure"
  | "evidence-verified"
  | "evidence-degradation"
  | "evidence-contract-failure";

export function evidenceCategory(health: EvidenceHealth): EvidenceCategory {
  if (health.delivery === "failed") return "delivery-failure";
  switch (health.visual) {
    case "verified":
      return "evidence-verified";
    case "degraded-infrastructure":
      return "evidence-degradation";
    case "invalid-target":
    case "absent-contract":
      return "evidence-contract-failure";
  }
}

/** True iff a visual state BLOCKS the gate as a loud evidence/contract failure. */
export function isBlockingVisualState(visual: EvidenceVisualState): boolean {
  return EVIDENCE_BLOCKING_VISUAL_STATES.includes(visual);
}

export interface EvidenceGateDecision {
  category: EvidenceCategory;
  /** Visual (or delivery) health BLOCKS publish and fails the gate loudly. */
  blocksGate: boolean;
  /**
   * This warrants rescheduling/rebuilding the story. `degraded-infrastructure`
   * MUST be `false` (AC2): a broken capture machine never rebuilds a completed story.
   */
  reschedulesBuild: boolean;
  /** Delivery passed and visual health does not block ⇒ safe to publish. */
  publishable: boolean;
  /** Publish, but VISIBLY mark the evidence as degraded (AC2). */
  markedDegraded: boolean;
  /** Repairable by an evidence-only rerun without reopening the build cycle. */
  evidenceOnlyRepair: boolean;
  reason: string;
}

/**
 * The full gate decision derived from an EvidenceHealth (AC2/AC3/AC5). Delivery
 * failure and the three evidence signals are kept strictly separate.
 */
export function evidenceGateDecision(health: EvidenceHealth): EvidenceGateDecision {
  const category = evidenceCategory(health);
  if (health.delivery === "failed") {
    return {
      category,
      blocksGate: true,
      reschedulesBuild: true,
      publishable: false,
      markedDegraded: false,
      evidenceOnlyRepair: false,
      reason: "delivery failed: product/AC correctness failure — normal failure handling",
    };
  }
  switch (health.visual) {
    case "verified":
      return {
        category,
        blocksGate: false,
        reschedulesBuild: false,
        publishable: true,
        markedDegraded: false,
        evidenceOnlyRepair: false,
        reason: "verified: at least one valid, target-bound image — publish normally",
      };
    case "degraded-infrastructure":
      return {
        category,
        blocksGate: false,
        reschedulesBuild: false,
        publishable: true,
        markedDegraded: true,
        evidenceOnlyRepair: true,
        reason:
          "degraded-infrastructure: all lanes attempted, only host/provider/tooling failures — publish visibly marked, do NOT rebuild; repairable by an evidence-only rerun",
      };
    case "invalid-target":
      return {
        category,
        blocksGate: true,
        reschedulesBuild: false,
        publishable: false,
        markedDegraded: false,
        evidenceOnlyRepair: true,
        reason:
          "invalid-target: a lane reached login / an unapproved redirect / the wrong target / a corrupt image / a forged receipt — block as an evidence failure, repair the target/configuration",
      };
    case "absent-contract":
      return {
        category,
        blocksGate: true,
        reschedulesBuild: false,
        publishable: false,
        markedDegraded: false,
        evidenceOnlyRepair: false,
        reason:
          "absent-contract: no declared surface, no planned attempt, or the planner was bypassed — block as a design/execution failure",
      };
  }
}

// ── Status labels (AC5 — bilingual, one language per line) ─────────────────────

/** A short bilingual label for a category, for loop status / CLI output. */
export function evidenceSignalLabel(category: EvidenceCategory): { en: string; zh: string } {
  switch (category) {
    case "delivery-failure":
      return { en: "delivery failed", zh: "交付失败" };
    case "evidence-verified":
      return { en: "evidence verified", zh: "证据已验证" };
    case "evidence-degradation":
      return { en: "evidence degraded (infrastructure)", zh: "证据降级（基础设施）" };
    case "evidence-contract-failure":
      return { en: "evidence contract failure", zh: "证据契约失败" };
  }
}

/**
 * A machine-readable + human-facing summary of one surface's health, for the
 * manifest (`evidence.json`) and loop status (AC5). Additive: legacy readers
 * ignore the extra keys.
 */
export interface EvidenceHealthFact extends EvidenceHealth {
  surfaceId: string | null;
  category: EvidenceCategory;
  blocksGate: boolean;
  reschedulesBuild: boolean;
  markedDegraded: boolean;
  evidenceOnlyRepair: boolean;
  reason: string;
}

/** Build the durable + status-facing fact for one surface. */
export function evidenceHealthFact(surfaceId: string | null, health: EvidenceHealth): EvidenceHealthFact {
  const decision = evidenceGateDecision(health);
  return {
    surfaceId,
    delivery: health.delivery,
    visual: health.visual,
    acceptedReceiptIds: health.acceptedReceiptIds,
    attempts: health.attempts,
    category: decision.category,
    blocksGate: decision.blocksGate,
    reschedulesBuild: decision.reschedulesBuild,
    markedDegraded: decision.markedDegraded,
    evidenceOnlyRepair: decision.evidenceOnlyRepair,
    reason: decision.reason,
  };
}
