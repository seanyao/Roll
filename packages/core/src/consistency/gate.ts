/**
 * @responsibility Gates releases on consistency drift unless a recorded waiver applies.
 * US-TRUTH-005 — the release consistency gate + recorded waivers (pure).
 *
 * The shadow audit (US-TRUTH-002) quantified drift; once its false positives
 * are gone the same findings become a release blocker: shipping past a
 * fail-level drift requires an OWNER WAIVER that is itself a fact —
 * reason, scope, expiry, operator, timestamp — appended to the event stream
 * (release_waiver anchor: an un-recorded bypass is itself drift; an expired
 * waiver no longer waives).
 *
 * Severity policy (AC2):
 *   fail          → blocks, unless an unexpired waiver matches
 *   warn          → allows (reported)
 *   unknown       → allows (external API flake / convergence windows must not
 *                   kill releases — the documented unknown policy)
 *   grandfathered → allows (history is listed, never a blocker)
 */
import type { AuditFinding } from "./audit.js";

/** A recorded owner waiver (the release_waiver anchor's value shape). */
export interface ReleaseWaiver {
  reason: string;
  /** What it waives: "all", a rule id, or a finding subject. */
  scope: string;
  /** Epoch seconds; a waiver at/after this moment no longer waives. */
  expiresSec: number;
  operator: string;
  /** When it was recorded (epoch seconds). */
  tsSec: number;
}

export interface ReleaseGateDecision {
  ok: boolean;
  /** fail findings with no live waiver — these block. */
  blockedBy: AuditFinding[];
  /** fail findings allowed through by a live waiver (finding + the waiver). */
  waived: Array<{ finding: AuditFinding; waiver: ReleaseWaiver }>;
}

/** Does a waiver cover a finding (and is it still alive at `nowSec`)? */
export function waiverCovers(w: ReleaseWaiver, f: AuditFinding, nowSec: number): boolean {
  if (nowSec >= w.expiresSec) return false; // expired waivers block again (AC6)
  return w.scope === "all" || w.scope === f.rule || w.scope === f.subject;
}

/** Decide the gate from audit findings + recorded waivers. Pure. */
export function decideReleaseGate(
  findings: readonly AuditFinding[],
  waivers: readonly ReleaseWaiver[],
  nowSec: number,
): ReleaseGateDecision {
  const blockedBy: AuditFinding[] = [];
  const waived: Array<{ finding: AuditFinding; waiver: ReleaseWaiver }> = [];
  for (const f of findings) {
    if (f.severity !== "fail") continue; // warn/unknown/grandfathered allow (AC2)
    const w = waivers.find((x) => waiverCovers(x, f, nowSec));
    if (w !== undefined) waived.push({ finding: f, waiver: w });
    else blockedBy.push(f);
  }
  return { ok: blockedBy.length === 0, blockedBy, waived };
}
