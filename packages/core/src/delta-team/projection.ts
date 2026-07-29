/**
 * US-DELTA-001 — Pure visible-mode projection and delegation status.
 *
 * Consumes events (folded from the delegation event stream) and produces
 * deterministic, serializable status views. No CLI, I/O, or host API.
 *
 * Design rules (ratified §14):
 * - VisibleDeliveryMode is DERIVED from trigger + topology; never stored.
 * - Host-guided cost is always `? (host_unobservable)`.
 * - Host-attested vs adapter-observed is a provenance label, never "verified session".
 * - Quality profile never implies topology.
 */
import type {
  DelegationTrigger,
  DeliveryTopology,
  VisibleDeliveryMode,
  DeliveryShape,
  HistoricalDelegationTrigger,
  HistoricalVisibleDeliveryMode,
  IdentityProvenance,
  RollEvent,
} from "@roll/spec";
import { RETIRED_DELEGATION_TRIGGERS } from "@roll/spec";

// ── Visible-mode projection ───────────────────────────────────────────────────

/**
 * Derive the user-visible delivery mode from trigger + topology.
 *
 * US-LOOP-110: the LIVE trigger axis collapsed to a single value, so for any new
 * delegation topology alone determines the mode. But a HISTORICAL record written
 * under the retired `loop-autonomous` trigger was rendered as `autonomous-loop`
 * at the time, and re-rendering it as `solo-skill` would silently rewrite what
 * that delivery actually was (codex review r1). Such a record therefore projects
 * to its historical mode, which the caller must treat as read-only history.
 *
 * The return type widens to include the retired mode for exactly this reason —
 * `VISIBLE_DELIVERY_MODES` still lists only what a NEW delegation may produce.
 */
export function visibleMode(
  trigger: DelegationTrigger,
  topology: DeliveryTopology,
): VisibleDeliveryMode | HistoricalVisibleDeliveryMode {
  // Read-side only: a historical trigger keeps its historical projection.
  if ((RETIRED_DELEGATION_TRIGGERS as readonly string[]).includes(trigger as string)) {
    return "autonomous-loop";
  }
  switch (topology) {
    case "solo":
      return "solo-skill";
    case "delta-team":
      return "delta-team";
    case "full-delta-team":
      return "full-delta-team";
  }
}

/** Derive visible mode from a full DeliveryShape. */
export function visibleModeFromShape(
  shape: DeliveryShape,
): VisibleDeliveryMode | HistoricalVisibleDeliveryMode {
  return visibleMode(shape.trigger, shape.topology);
}

// ── Cost rendering ────────────────────────────────────────────────────────────

/** Host-guided cost is structurally unobservable to Roll. */
export const HOST_UNOBSERVABLE_COST = "? (host_unobservable)";

/** Render a per-role or total cost string. */
export function renderCost(provenance: IdentityProvenance | null): string {
  if (provenance === "host-attested" || provenance === null) return HOST_UNOBSERVABLE_COST;
  // adapter-observed cost may be available in a future schema
  return "? (usage_authority_unavailable)";
}

// ── Delegation status projection ──────────────────────────────────────────────

export type DelegationStatus =
  | "unknown"
  | "prepared"
  | "in_progress"
  | "handoff_ready"
  | "blocked"
  | "abandoned";

/** A single role's current observed state. */
export interface DelegationRoleStatus {
  readonly role: string;
  readonly status: "resolved" | "started" | "artifact_published" | "unknown";
  readonly hostId?: string;
  readonly modelId?: string;
  readonly identityProvenance?: IdentityProvenance;
  readonly cost: string;
}

/** The deterministic status projection for one delegation. */
export interface DelegationStatusView {
  readonly delegationId: string;
  readonly storyId: string;
  readonly status: DelegationStatus;
  /**
   * codex review r2: a status view is a READ of the event ledger, so these two
   * fields must be typed as widely as the ledger can hold — a delegation prepared
   * under the retired trigger reads back its historical trigger and the historical
   * mode it was rendered as. Typing them live-only forced a cast and left
   * historical consumers unable to read the returned values safely.
   */
  readonly visibleMode: VisibleDeliveryMode | HistoricalVisibleDeliveryMode | null;
  readonly trigger: DelegationTrigger | HistoricalDelegationTrigger | null;
  readonly topology: DeliveryTopology | null;
  readonly qualityProfile: string | null;
  readonly blockReason?: string;
  readonly blockDetail?: string;
  readonly terminalBinding?: string;
  readonly deliveryDisposition?: string;
  readonly roles: readonly DelegationRoleStatus[];
  readonly totalCost: string;
}

/**
 * Fold a list of Delta events for a single delegation into a status view.
 * Pure function — no I/O, no host API, no side effects.
 */
export function projectDelegationStatus(
  delegationId: string,
  events: readonly RollEvent[],
): DelegationStatusView {
  // Mutable accumulator — final result cast to readonly view at return.
  const view = {
    delegationId,
    storyId: "",
    status: "unknown" as DelegationStatus,
    visibleMode: null as VisibleDeliveryMode | HistoricalVisibleDeliveryMode | null,
    trigger: null as DelegationTrigger | HistoricalDelegationTrigger | null,
    topology: null as DeliveryTopology | null,
    qualityProfile: null as string | null,
    blockReason: undefined as string | undefined,
    blockDetail: undefined as string | undefined,
    terminalBinding: undefined as string | undefined,
    deliveryDisposition: undefined as string | undefined,
    roles: [] as DelegationRoleStatus[],
    totalCost: HOST_UNOBSERVABLE_COST,
  };

  // Track role states across events
  const roleMap = new Map<string, DelegationRoleStatus>();

  for (const ev of events) {
    // Only process events for this delegation
    if (!("delegationId" in ev) || (ev as Record<string, unknown>).delegationId !== delegationId) continue;

    switch (ev.type) {
      case "delta:prepared": {
        view.storyId = ev.storyId;
        view.status = "prepared";
        view.trigger = ev.trigger;
        view.topology = ev.topology;
        view.qualityProfile = ev.qualityProfile;
        view.visibleMode = visibleMode(ev.trigger, ev.topology);
        break;
      }
      case "delta:role_resolved": {
        roleMap.set(ev.role, {
          role: ev.role,
          status: "resolved",
          hostId: ev.hostId,
          modelId: ev.modelId,
          cost: renderCost(null),
        });
        view.status = "in_progress";
        break;
      }
      case "delta:role_started": {
        const existing = roleMap.get(ev.role);
        const started: DelegationRoleStatus = {
          role: ev.role,
          status: "started",
          hostId: ev.hostId,
          modelId: ev.modelId,
          identityProvenance: ev.identityProvenance,
          cost: renderCost(ev.identityProvenance),
        };
        roleMap.set(ev.role, started);
        view.status = "in_progress";
        break;
      }
      case "delta:artifact_published": {
        roleMap.set(ev.role, {
          role: ev.role,
          status: "artifact_published",
          hostId: roleMap.get(ev.role)?.hostId,
          modelId: roleMap.get(ev.role)?.modelId,
          identityProvenance: ev.identityProvenance,
          cost: renderCost(ev.identityProvenance),
        });
        view.status = "in_progress";
        break;
      }
      case "delta:terminal": {
        if (ev.outcome === "handoff_ready") {
          view.status = "handoff_ready";
        } else if (ev.outcome === "abandoned") {
          view.status = "abandoned";
        }
        view.terminalBinding = ev.terminalBinding;
        view.deliveryDisposition = ev.deliveryDisposition;
        break;
      }
      case "delta:blocked": {
        view.status = "blocked";
        view.blockReason = ev.reason;
        view.blockDetail = ev.detail;
        break;
      }
    }
  }

  view.roles = [...roleMap.values()];

  // Compute totalCost dynamically: host-guided always unobservable;
  // adapter-observed roles reflect usage_authority_unavailable.
  const hasAdapterObserved = view.roles.some(
    (r) => r.identityProvenance === "adapter-observed",
  );
  view.totalCost = hasAdapterObserved
    ? "? (usage_authority_unavailable)"
    : HOST_UNOBSERVABLE_COST;

  return view as DelegationStatusView;
}

/**
 * Build a lightweight fixture view suitable for snapshot testing.
 * Returns every visible mode plus unknown/blocked, with stable fake IDs.
 */
export function buildStatusFixture(
  scenario: "full-delta-team" | "delta-team" | "solo-skill" | "unknown" | "blocked",
): DelegationStatusView {
  switch (scenario) {
    case "unknown":
      return {
        delegationId: "deleg-000",
        storyId: "US-FIXTURE-0",
        status: "unknown",
        visibleMode: null,
        trigger: null,
        topology: null,
        qualityProfile: null,
        roles: [],
        totalCost: HOST_UNOBSERVABLE_COST,
      };
    case "full-delta-team":
      return {
        delegationId: "deleg-full-001",
        storyId: "US-FULL-1",
        status: "handoff_ready",
        visibleMode: "full-delta-team",
        trigger: "host-guided",
        topology: "full-delta-team",
        qualityProfile: "designed",
        terminalBinding: "handoff_only",
        deliveryDisposition: "owner_continue",
        roles: [
          { role: "designer", status: "artifact_published", hostId: "host-1", modelId: "model-host-1", identityProvenance: "host-attested", cost: "? (host_unobservable)" },
          { role: "builder", status: "artifact_published", hostId: "host-2", modelId: "model-host-2", identityProvenance: "host-attested", cost: "? (host_unobservable)" },
          { role: "evaluator", status: "artifact_published", hostId: "host-3", modelId: "model-host-3", identityProvenance: "host-attested", cost: "? (host_unobservable)" },
        ],
        totalCost: "? (host_unobservable)",
      };
    case "delta-team":
      return {
        delegationId: "deleg-delta-001",
        storyId: "US-DELTA-1",
        status: "in_progress",
        visibleMode: "delta-team",
        trigger: "host-guided",
        topology: "delta-team",
        qualityProfile: "verified",
        roles: [
          { role: "designer", status: "artifact_published", hostId: "pi", modelId: "model-host-1", identityProvenance: "host-attested", cost: "? (host_unobservable)" },
          { role: "builder", status: "started", hostId: "pi", modelId: "model-host-2", identityProvenance: "host-attested", cost: "? (host_unobservable)" },
          { role: "evaluator", status: "resolved", hostId: "pi", modelId: "model-host-3", cost: "? (host_unobservable)" },
        ],
        totalCost: "? (host_unobservable)",
      };
    case "solo-skill":
      return {
        delegationId: "deleg-solo-001",
        storyId: "US-SOLO-1",
        status: "handoff_ready",
        visibleMode: "solo-skill",
        trigger: "host-guided",
        topology: "solo",
        qualityProfile: "standard",
        terminalBinding: "handoff_only",
        deliveryDisposition: "owner_continue",
        roles: [
          { role: "builder", status: "artifact_published", hostId: "pi", modelId: "model-host-2", identityProvenance: "host-attested", cost: "? (host_unobservable)" },
        ],
        totalCost: "? (host_unobservable)",
      };
    case "blocked":
      return {
        delegationId: "deleg-block-001",
        storyId: "US-BLOCK-1",
        status: "blocked",
        visibleMode: "solo-skill",
        trigger: "host-guided",
        topology: "solo",
        qualityProfile: "standard",
        blockReason: "host_attestation_invalid",
        blockDetail: "host attestation missing or malformed for role builder",
        roles: [
          { role: "builder", status: "resolved", hostId: "pi", modelId: "model-host-2", cost: "? (host_unobservable)" },
        ],
        totalCost: "? (host_unobservable)",
      };
  }
}
