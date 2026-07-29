/**
 * US-DELTA-001 — Shared Delta Team types: orthogonal trigger, topology, quality
 * profile, and the derived visible-mode projection.
 *
 * The design separates HOW a delivery request originates, HOW MANY execution
 * actors it has, and HOW STRICT its quality gates are. These are distinct axes;
 * no profile implies a topology and no topology implies a trigger.
 */

// ── Orthogonal dimensions ────────────────────────────────────────────────────

/**
 * How a delivery request originates.
 *
 * US-LOOP-110: this was a `host-guided | loop-autonomous` binary whose second
 * value described a daemon tick with no coding-agent main session. That premise
 * was wrong — a loop is not a timer. A `roll loop go` chain runs INSIDE a host
 * session, so it has an implicit Supervisor and full sub-agent capability like
 * any other delegation. With the daemon lanes retired, no trigger can lack a
 * host, so the axis collapses to a single value.
 *
 * The FIELD is kept (not deleted from the schema) so historical v2 manifests and
 * events stay parseable — {@link isKnownHistoricalTrigger} recognises the retired
 * literal on the read side without admitting it as a live value.
 */
export const DELEGATION_TRIGGERS = ["host-guided"] as const;
export type DelegationTrigger = (typeof DELEGATION_TRIGGERS)[number];

/** The retired trigger literal, kept for read-side compatibility only. */
export const RETIRED_DELEGATION_TRIGGERS = ["loop-autonomous"] as const;
/** A trigger Roll no longer accepts but must still read back from history. */
export type HistoricalDelegationTrigger = (typeof RETIRED_DELEGATION_TRIGGERS)[number];

/**
 * Read-side guard: does this string name a trigger Roll has ever written?
 * Accepts both live and retired literals so historical artifacts remain
 * readable. Never use it to admit a live delegation — that is what
 * {@link DELEGATION_TRIGGERS} is for.
 */
export function isKnownHistoricalTrigger(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    (DELEGATION_TRIGGERS as readonly string[]).includes(value) ||
    (RETIRED_DELEGATION_TRIGGERS as readonly string[]).includes(value)
  );
}

/** Delivery actor shape, independent of trigger and quality profile. */
export const DELIVERY_TOPOLOGIES = ["solo", "delta-team", "full-delta-team"] as const;
export type DeliveryTopology = (typeof DELIVERY_TOPOLOGIES)[number];

/** Verification rigor — never a topology synonym. */
export const QUALITY_PROFILES = ["standard", "verified", "designed"] as const;
export type QualityProfile = (typeof QUALITY_PROFILES)[number];

// ── Derived visible mode ─────────────────────────────────────────────────────

/**
 * User-visible mode derived from trigger + topology. Never stored as a hidden
 * fourth state — it is always computed from the orthogonal shape.
 */
export const VISIBLE_DELIVERY_MODES = [
  "full-delta-team",
  "delta-team",
  "solo-skill",
] as const;
export type VisibleDeliveryMode = (typeof VISIBLE_DELIVERY_MODES)[number];

/**
 * US-LOOP-110: `autonomous-loop` was the visible mode of the retired
 * `loop-autonomous` trigger. No live trigger maps to it, so it is no longer
 * produced. Kept here for read-side recognition of historical projections.
 */
export const RETIRED_VISIBLE_DELIVERY_MODES = ["autonomous-loop"] as const;
/** A mode Roll no longer produces but must still render for historical records. */
export type HistoricalVisibleDeliveryMode = (typeof RETIRED_VISIBLE_DELIVERY_MODES)[number];

/** Read-side guard: has Roll ever rendered this visible mode? */
export function isKnownHistoricalVisibleMode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    (VISIBLE_DELIVERY_MODES as readonly string[]).includes(value) ||
    (RETIRED_VISIBLE_DELIVERY_MODES as readonly string[]).includes(value)
  );
}

// ── Delivery shape ────────────────────────────────────────────────────────────

/** The immutable composition that produces a visible mode. */
export interface DeliveryShape {
  readonly trigger: DelegationTrigger;
  readonly topology: DeliveryTopology;
  readonly qualityProfile: QualityProfile;
}

/**
 * A shape as it may appear in a HISTORICAL record: identical to
 * {@link DeliveryShape} except the trigger may be a retired literal. Read-side
 * consumers accept this so a historical artifact needs no cast (codex review r3).
 */
export interface HistoricalDeliveryShape {
  readonly trigger: DelegationTrigger | HistoricalDelegationTrigger;
  readonly topology: DeliveryTopology;
  readonly qualityProfile: QualityProfile;
}

/** Type guard: is every field within its valid literal set? */
export function isValidDeliveryShape(s: unknown): s is DeliveryShape {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  return (
    (DELEGATION_TRIGGERS as readonly string[]).includes(r.trigger as string) &&
    (DELIVERY_TOPOLOGIES as readonly string[]).includes(r.topology as string) &&
    (QUALITY_PROFILES as readonly string[]).includes(r.qualityProfile as string)
  );
}

// ── Roles ────────────────────────────────────────────────────────────────────

export const DELTA_ROLES = ["designer", "builder", "evaluator", "peer"] as const;
export type DeltaRole = (typeof DELTA_ROLES)[number];

// ── Model resolution (host-neutral contract) ─────────────────────────────────

export type ResolutionSource = "user-pin" | "preset-preference" | "availability-fallback";

/** Opaque host model descriptor — Roll never queries a host. */
export interface HostModelDescriptor {
  readonly id: string;
  readonly available: boolean;
  readonly capabilityTags: readonly string[];
  readonly costClass?: "low" | "medium" | "high" | "unknown";
}

export interface HostModelInventory {
  readonly hostId: string;
  readonly observedAt: string;
  readonly models: readonly HostModelDescriptor[];
}

export interface RoleModelPreference {
  readonly preferredModelIds: readonly string[];
  readonly requiredTags?: readonly string[];
  readonly preferredCostClass?: "low" | "medium" | "high";
  readonly diversity: "allow" | "prefer" | "require";
}

export interface MachineDeltaPreset {
  readonly schema: "roll-delta-preset/v1";
  readonly id: string;
  readonly hostId: string;
  readonly roles: Readonly<Record<"designer" | "builder" | "evaluator", RoleModelPreference>>;
  readonly peer?: RoleModelPreference;
}

export interface ResolvedRoleAssignment {
  readonly role: DeltaRole;
  readonly roleInstanceId: string;
  readonly hostId: string;
  readonly modelId: string;
  readonly source: ResolutionSource;
  readonly reasons: readonly string[];
}

export interface DelegationResolution {
  readonly schema: "roll-delta-resolution/v1";
  readonly delegationId: string;
  readonly storyId: string;
  /**
   * US-LOOP-110 (codex r5): a PERSISTED resolution on disk may predate the trigger
   * collapse, so this read contract holds historical values too. New resolutions
   * are constrained at the write boundary — `roll delta prepare` rejects a template
   * whose trigger is not live.
   */
  readonly trigger: DelegationTrigger | HistoricalDelegationTrigger;
  readonly topology: DeliveryTopology;
  readonly qualityProfile: QualityProfile;
  readonly presetId: string;
  readonly presetSha256: string;
  readonly inventoryObservedAt: string;
  readonly inventorySha256: string;
  readonly instructionSha256?: string;
  readonly roles: readonly ResolvedRoleAssignment[];
}

// ── Identity provenance ──────────────────────────────────────────────────────

/** Provenance of an identity claim — structural validation only, never proof. */
export type IdentityProvenance = "host-attested" | "adapter-observed";

// ── Artifact manifest v2 compatibility types ──────────────────────────────────

export interface DeltaArtifactManifest {
  readonly schemaVersion: 2;
  readonly delegationId: string;
  readonly storyId: string;
  readonly cycleId?: string;
  readonly role: DeltaRole;
  /** Read contract over a persisted v2 artifact — may be a historical value. */
  readonly trigger: DelegationTrigger | HistoricalDelegationTrigger;
  readonly topology: DeliveryTopology;
  readonly qualityProfile: QualityProfile;
  readonly executionIdentity: {
    readonly kind: "host-native" | "roll-adapter";
    readonly hostId: string;
    readonly roleInstanceId: string;
    readonly modelId: string;
    readonly adapter?: string;
  };
  readonly sessionId: string;
  readonly hostAttestation?: {
    readonly schema: "roll-delta-host-attestation/v1";
    readonly hostId: string;
    readonly role: DeltaRole;
    readonly roleInstanceId: string;
    readonly modelId: string;
    readonly sessionId: string;
    readonly assertedAt: string;
  };
  readonly worktreeAccess: "read-only" | "builder-write";
  readonly inputs: readonly import("./agent.js").ArtifactRef[];
  readonly outputs: readonly import("./agent.js").ArtifactRef[];
  readonly createdAt: string;
}

// ── Block reasons ────────────────────────────────────────────────────────────

export const DELTA_BLOCK_REASONS = [
  "model_unavailable",
  "invalid_preset",
  "invalid_resolution",
  "artifact_invalid",
  "identity_collision",
  "host_attestation_invalid",
  "role_write_violation",
  "builder_lease_conflict",
  "host_spawn_failed",
  "evaluation_repair_required",
  "terminal_path_unselected",
  "uncommitted_delegation_frame",
] as const;
export type DeltaBlockReason = (typeof DELTA_BLOCK_REASONS)[number];

/**
 * US-LOOP-110: `host_supervisor_required` blocked `loop-autonomous + delta-team`
 * on the premise that a loop has no host session. That premise was wrong and the
 * trigger it guarded is gone, so the reason is unreachable and no longer emitted.
 * Kept for read-side recognition of historical `delta:blocked` events.
 */
export const RETIRED_DELTA_BLOCK_REASONS = ["host_supervisor_required"] as const;
/** A reason Roll no longer emits but must still read back from history. */
export type HistoricalDeltaBlockReason = (typeof RETIRED_DELTA_BLOCK_REASONS)[number];

/** Read-side guard: has Roll ever emitted this block reason? */
export function isKnownHistoricalBlockReason(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    (DELTA_BLOCK_REASONS as readonly string[]).includes(value) ||
    (RETIRED_DELTA_BLOCK_REASONS as readonly string[]).includes(value)
  );
}

// ── Terminal outcome ─────────────────────────────────────────────────────────

export type DeltaTerminalOutcome = "handoff_ready" | "blocked" | "abandoned";
export type TerminalBinding = "cycle_adoption" | "manual_host_bridge" | "handoff_only";
export type DeliveryDisposition = "owner_continue" | "owner_hold" | "owner_redelegate";
