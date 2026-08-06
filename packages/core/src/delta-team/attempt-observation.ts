/**
 * @responsibility Folds Delta attempt events into a read model that never invents claims.
 * US-DELTA-012 — append-only Delta attempt facts.
 *
 * This is deliberately a read model. It never turns a missing artifact into an
 * invocation claim, never changes an event, and never chooses a later rig.
 */
import type {
  AttemptCause,
  DeltaAttemptOutcomeEvent,
  DeltaRoleAvailabilityObservedEvent,
  RollEvent,
} from "@roll/spec";

export interface DeltaAttemptFactsView {
  readonly schemaVersion: 1;
  readonly delegationId: string;
  readonly outcomes: readonly DeltaAttemptOutcomeEvent[];
  readonly availability: readonly DeltaRoleAvailabilityObservedEvent[];
  readonly diagnostics: readonly string[];
}

/** Map only explicit protocol reasons; everything else stays honestly unknown. */
export function attemptCauseFromBlockReason(reason: string): AttemptCause {
  switch (reason) {
    case "evaluation_repair_required":
      return "evaluator_finding";
    case "artifact_invalid":
    case "role_write_violation":
      return "artifact_protocol";
    case "identity_collision":
    case "invalid_resolution":
    case "host_attestation_invalid":
    case "builder_lease_conflict":
      return "identity_or_routing";
    case "model_unavailable":
    case "host_spawn_failed":
      return "external_liveness";
    case "terminal_path_unselected":
      return "owner_scope_change";
    default:
      return "unknown";
  }
}

/**
 * Fold persisted facts for one delegation. Duplicate, contradictory, and
 * out-of-order rows are reported without overwriting the first observed fact.
 */
export function projectDeltaAttemptFacts(
  delegationId: string,
  events: readonly RollEvent[],
): DeltaAttemptFactsView {
  const outcomes: DeltaAttemptOutcomeEvent[] = [];
  const availability: DeltaRoleAvailabilityObservedEvent[] = [];
  const diagnostics: string[] = [];
  const seenAvailability = new Set<string>();
  let prepared = false;
  let terminalCause: AttemptCause | undefined;

  for (const event of events) {
    if (!("delegationId" in event) || event.delegationId !== delegationId) continue;
    if (event.type === "delta:prepared") {
      prepared = true;
      continue;
    }
    if (event.type === "delta:attempt_outcome") {
      if (!prepared) {
        diagnostics.push(`out-of-order attempt outcome before delta:prepared for ${delegationId}`);
        continue;
      }
      if (terminalCause !== undefined) {
        if (terminalCause === event.cause) {
          diagnostics.push(`duplicate terminal cause ${event.cause} for ${delegationId} — kept first occurrence`);
        } else {
          diagnostics.push(`contradictory terminal cause ${event.cause} after ${terminalCause} for ${delegationId} — kept first occurrence`);
        }
        continue;
      }
      terminalCause = event.cause;
      outcomes.push(event);
      continue;
    }
    if (event.type === "delta:role_availability_observed") {
      if (!prepared) {
        diagnostics.push(`out-of-order availability observation before delta:prepared for ${delegationId}`);
        continue;
      }
      const key = [event.role, event.hostId, event.modelId, event.transportClass, event.probeOutcome, event.selection, event.reason, event.ts].join("\t");
      if (seenAvailability.has(key)) {
        diagnostics.push(`duplicate availability observation for ${event.role}/${event.hostId}/${event.modelId} — kept first occurrence`);
        continue;
      }
      seenAvailability.add(key);
      availability.push(event);
    }
  }

  return { schemaVersion: 1, delegationId, outcomes, availability, diagnostics };
}
