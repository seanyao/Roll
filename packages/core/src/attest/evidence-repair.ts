/**
 * @responsibility Reruns evidence capture without reopening a completed delivery build.
 * US-EVID-032 — Evidence-only repair (AC2).
 *
 * A `degraded-infrastructure` delivery is a COMPLETED story whose capture
 * machine was broken (host/provider/tooling failures) — NOT a product failure
 * (best-effort-capture-plan.md → "Gate semantics"). Such a story must never be
 * rebuilt; instead its evidence can be repaired by re-running ONLY the capture
 * lanes and re-resolving evidence health, leaving the delivery verdict and the
 * build/TCR cycle completely untouched.
 *
 * This module is that repair, expressed purely over the reusable US-EVID-030
 * CapturePlanner + US-EVID-031 EvidenceHealth resolver. It carries the prior
 * delivery verdict through UNCHANGED and it has no dependency on — and never
 * invokes — TCR, the build, or the cycle. `reopenedBuild` is structurally always
 * false: an evidence-only repair cannot rebuild delivery.
 */

import { CapturePlanner, type CaptureLanePort, type CaptureReceiptStorePort, type CapturePlanContext, type CapturePolicy, type DeclaredSurface, type CaptureRunResult } from "./capture-planner.js";
import { evidenceHealthFact, resolveEvidenceHealth, type EvidenceHealthFact } from "./evidence-health.js";

/** Why an evidence-only repair was refused (never a silent no-op). */
export type EvidenceRepairRefusal =
  /** The delivery itself failed — that is normal failure handling, not evidence repair. */
  | "delivery-failed"
  /** The record is not `degraded-infrastructure`, so an evidence-only rerun does not apply. */
  | "not-degraded-infrastructure";

export interface EvidenceRepairRequest {
  storyId: string;
  /** A FRESH run id for this repair attempt — a new capture run, not a rebuild. */
  runId: string;
  /** Absolute run dir for the repair's derived artifact paths. */
  runDir: string;
  /** Project root, for v2 intent path-safety validation. */
  projectRoot: string;
  /** The declared surface to re-capture (from the story spec). */
  surface: DeclaredSurface;
  policy?: CapturePolicy;
}

export interface EvidenceRepairOutcome {
  repaired: boolean;
  /**
   * ALWAYS false: an evidence-only repair NEVER reopens or rebuilds the
   * completed delivery (AC2). Encoded as a field so callers/tests can assert it.
   */
  reopenedBuild: false;
  /** ALWAYS true: the build / TCR cycle is not touched by this path. */
  buildUntouched: true;
  /** The prior evidence-health fact that this repair acted on. */
  priorHealth: EvidenceHealthFact;
  /** The re-resolved health after re-running capture (present when a repair ran). */
  newHealth?: EvidenceHealthFact;
  /** The fresh capture run (present when a repair ran). */
  run?: CaptureRunResult;
  /** Set when the repair was refused. */
  refusal?: EvidenceRepairRefusal;
  reason: string;
}

/**
 * True iff `prior` is a delivery whose evidence CAN be repaired by an
 * evidence-only rerun: a passed delivery whose visual health is
 * `degraded-infrastructure`. A failed delivery, or any other visual state, is
 * not eligible.
 */
export function isEvidenceOnlyRepairable(prior: EvidenceHealthFact): boolean {
  return prior.delivery === "passed" && prior.visual === "degraded-infrastructure";
}

/**
 * Re-run capture collection for a `degraded-infrastructure` record and re-resolve
 * evidence health WITHOUT reopening the completed build (AC2).
 *
 * The delivery verdict is a carried-through INPUT (`prior.delivery`) — it is
 * never recomputed here, so a broken-then-fixed capture machine can only ever
 * improve the VISUAL health, never flip delivery. Refuses (loudly, with a reason)
 * for a failed delivery or a non-degraded record rather than silently rebuilding.
 */
export async function repairDegradedEvidence(
  prior: EvidenceHealthFact,
  request: EvidenceRepairRequest,
  lanes: readonly CaptureLanePort[],
  store: CaptureReceiptStorePort,
  planner: CapturePlanner = new CapturePlanner(),
): Promise<EvidenceRepairOutcome> {
  const base = { reopenedBuild: false as const, buildUntouched: true as const, priorHealth: prior };

  if (prior.delivery === "failed") {
    return {
      ...base,
      repaired: false,
      refusal: "delivery-failed",
      reason: "delivery failed: this is normal failure handling, not an evidence-only repair; the build is not reopened",
    };
  }
  if (prior.visual !== "degraded-infrastructure") {
    return {
      ...base,
      repaired: false,
      refusal: "not-degraded-infrastructure",
      reason: `visual state is "${prior.visual}", not degraded-infrastructure; evidence-only repair only re-runs capture for a broken capture machine`,
    };
  }

  // Re-run ONLY the capture lanes. This touches the capture/evidence layer and
  // the receipt store — never TCR, the build, or the cycle.
  const ctx: CapturePlanContext = {
    storyId: request.storyId,
    runId: request.runId,
    runDir: request.runDir,
    projectRoot: request.projectRoot,
    ...(request.policy !== undefined ? { policy: request.policy } : {}),
  };
  const run = await planner.capture(request.surface, ctx, lanes, store);

  // Re-resolve health with the delivery verdict CARRIED THROUGH unchanged.
  const health = resolveEvidenceHealth({ delivery: prior.delivery, contractDeclared: true, run });
  const newHealth = evidenceHealthFact(run.surfaceId, health);

  return {
    ...base,
    repaired: true,
    run,
    newHealth,
    reason:
      newHealth.visual === "verified"
        ? "evidence repaired: a valid target-bound image was captured; delivery verdict unchanged, build not reopened"
        : `evidence re-run recorded: visual state is now "${newHealth.visual}"; delivery verdict unchanged, build not reopened`,
  };
}
