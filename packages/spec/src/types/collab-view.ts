/**
 * @responsibility Declares the collab-view projection types.
 */
/**
 * collab-view.v1 — cross-cycle collaboration projection derived from
 * CycleRoleSummary + RollEvent stream (US-OBS-038).
 *
 * This projection tells the story of how the baton moves between roles in a
 * roll v4 cycle: assignment, build, review, score, gate, and escalation back
 * to supervisor.  It is a read-only view, not a new source of truth.
 */

import type { RollEvent } from "./events.js";
import type { CycleRoleSummary } from "./cycle-role-summary.js";

export type CollabHandoffKind =
  | "assign"
  | "build"
  | "review"
  | "score"
  | "gate"
  | "escalate";

export interface CollabHandoff {
  readonly fromRole: string;
  readonly toRole: string;
  readonly agent: string | null;
  readonly atMs: number;
  readonly kind: CollabHandoffKind;
  readonly folded?: number;
  readonly verdict?: string;
}

export type CollabEscalationTrigger =
  | "stall"
  | "blocked"
  | "aborted"
  | "gave_up"
  | "gate_tripped";

export type SupervisorAction =
  | "diagnose"
  | "split"
  | "reroute"
  | "self_build"
  | "park";

export interface CollabEscalation {
  readonly fromRole: string;
  readonly atMs: number;
  readonly trigger: CollabEscalationTrigger;
  readonly supervisorAction: SupervisorAction;
  readonly inferred: boolean;
  readonly spawnedCard?: string;
  readonly detail?: string;
}

export type SupervisorStanceLevel = "supervise" | "plan" | "build";

export interface SupervisorStance {
  readonly level: SupervisorStanceLevel;
  readonly note?: string;
}

export type CollabTerminus =
  | "walked_full"
  | "escalated"
  | "split"
  | "supervisor_fix"
  | "";

export interface CollabCycleCast {
  readonly supervise: string;
  readonly build?: string;
  readonly peers: readonly string[];
  readonly scorer?: string;
}

export interface CollabCycleView {
  readonly schema: "collab-view.v1";
  readonly cycleId: string;
  readonly storyId: string;
  readonly startedAtMs: number;
  readonly cast: CollabCycleCast;
  readonly handoffs: readonly CollabHandoff[];
  readonly escalation?: CollabEscalation;
  readonly terminus: CollabTerminus;
  readonly stance?: SupervisorStance;
}

export interface CollabStreamView {
  readonly schema: "collab-stream.v1";
  readonly goalScope: string;
  readonly supervisor: string;
  readonly cycles: readonly CollabCycleView[];
}

export interface EventSource {
  readEvents(): readonly RollEvent[];
  readSummary(cycleId: string): CycleRoleSummary | null;
  rebuildSummary(cycleId: string): CycleRoleSummary | null;
  supervisor?(): string;
  goalScope?(): string;
}
