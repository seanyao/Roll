/**
 * @responsibility Re-exports the core truth adapter for backward compatibility.
 */
/**
 * US-OBS-016 — truth-adapter moved to @roll/core (single read-side home).
 * Re-export for backward compat; new consumers import from @roll/core.
 */
export {
  TRUTH_SCHEMA_EPOCH_SEC,
  type TruthRunRow,
  type DeliveryGateDiagnostic,
  type DeliveryGateDiagnosticKind,
  cycleTruthFromRow,
  deliveryGateDiagnosticsFromRows,
  rowDelivered,
  storyTruthFromBacklog,
  evidenceTruth,
  outcomeToPanel,
} from "@roll/core";
