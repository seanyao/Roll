/**
 * @responsibility Prevents false delivered conclusions when main CI is red after merge.
 * Delivery gate — pure, injectable guard that prevents false "delivered"
 * conclusions when main CI is red after merge.
 *
 * FIX-1032a: v4 first-trial (intel-radar US-TASK-001, cycle 20260629-112437-39253)
 * exposed a false-delivered condition: PR merged but main CI red → delivery
 * marked `delivered` on broken code
 *      that had already been merged to main.
 *
 * This gate blocks both, produces structured alerts, and is injectable
 * (zero I/O) so fixture tests can cover all three states without real network
 * calls or launchd probes.
 */

/** CI status of the main branch after merge. */
export type MainCiStatus = "green" | "red" | "unknown" | "pending";

/** Pure inputs for {@link deliveryGate} — all injectable. */
export interface DeliveryGateInput {
  /** Main CI status on the merge commit. */
  mainCiStatus: MainCiStatus;
  /** CI run URL for alerting (meaningful when CI is red). */
  ciRunUrl?: string;
}

/** The three possible delivery-gate verdicts. */
export type DeliveryGateVerdict =
  | { readonly verdict: "allowed" }
  | {
      readonly verdict: "ci_red_after_merge";
      readonly alert: string;
      readonly ciRunUrl?: string;
    };

/**
 * Pure delivery gate: decide whether a published/merged cycle may be recorded
 * as delivered, or whether red main CI blocks the delivery conclusion.
 *
 * Rules (FIX-1032a):
 *   - Main CI red after merge    → `ci_red_after_merge` (never delivered).
 *   - Otherwise                  → `allowed`.
 *
 * Pure by construction: zero I/O, zero side effects. All facts are injected;
 * the caller (executor / test) resolves CI status.
 */
export function deliveryGate(input: DeliveryGateInput): DeliveryGateVerdict {
  if (input.mainCiStatus === "red") {
    return {
      verdict: "ci_red_after_merge",
      alert:
        "main CI red after merge; delivery blocked — merged code has failing CI. Fix-forward or revert required.",
      ciRunUrl: input.ciRunUrl,
    };
  }
  return { verdict: "allowed" };
}
