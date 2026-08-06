/**
 * @responsibility Resolves role-to-model assignments deterministically from preset and constraints.
 * US-DELTA-002 — Deterministic model resolution.
 *
 * Pure ranking algorithm that resolves role→model assignments from a preset,
 * host inventory, and normalized owner constraints. No I/O, no host API, no
 * Date.now, no crypto — fully deterministic and testable.
 *
 * Design rules (ratified §14, plan §4.3):
 * - Hard pin → block if unavailable (no silent fallback).
 * - Required diversity → block if roles would share a model.
 * - Preferred diversity → fallback with availability-fallback source + reason.
 * - Cost/tag filters applied before ranking.
 * - Stable lexical tie-break for otherwise-equal candidates.
 * - Stale inventory rejected (caller passes nowMs/maxInventoryAgeMs).
 * - HostId mismatch rejected.
 * - No Pi concrete model IDs in production code.
 */
import type {
  MachineDeltaPreset,
  HostModelInventory,
  HostModelDescriptor,
  RoleModelPreference,
  ResolvedRoleAssignment,
  DeltaRole,
  ResolutionSource,
} from "@roll/spec";

// ── Public types ──────────────────────────────────────────────────────────────

/** Normalized owner constraints — never raw chat. */
export interface OwnerConstraints {
  /** Per-role exact model pins. Unavailable pin → block. */
  readonly pins?: Readonly<Record<string, string>>;
  /** Per-role excluded model IDs. */
  readonly exclusions?: Readonly<Record<string, readonly string[]>>;
  /** Hard cost cap — models above this class are removed. */
  readonly maxCostClass?: "low" | "medium" | "high";
  /** Override per-role diversity level for all roles. */
  readonly diversity?: "allow" | "prefer" | "require";
  /** Per-role additional required tags (merged with preset tags). */
  readonly preferredTags?: Readonly<Record<string, readonly string[]>>;
}

/** Caller-provided freshness parameters — core never calls Date.now. */
export interface InventoryFreshnessParams {
  readonly nowMs: number;
  readonly maxInventoryAgeMs: number;
}

/** Discriminated resolution result. */
export type ResolutionResult =
  | { readonly outcome: "success"; readonly assignments: readonly ResolvedRoleAssignment[] }
  | { readonly outcome: "failure"; readonly reason: string; readonly detail: string };

// ── Cost-class ordering ───────────────────────────────────────────────────────

const COST_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  unknown: 3,
};

// ── Role resolution order ─────────────────────────────────────────────────────

const ROLE_ORDER: readonly DeltaRole[] = ["designer", "builder", "evaluator", "peer"];

// ── Internal candidate type ───────────────────────────────────────────────────

interface Candidate {
  readonly model: HostModelDescriptor;
  readonly prefIndex: number;    // index in preferredModelIds (-1 if not listed)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Deterministically resolve role→model assignments from a preset, inventory,
 * and owner constraints.
 *
 * Pure function — no I/O, no host API, no Date.now, no side effects.
 *
 * @param preset       Machine-local preset with role preferences.
 * @param inventory    Host-supplied live model inventory.
 * @param constraints  Normalized owner constraints (pins, exclusions, caps, diversity).
 * @param freshness    nowMs + maxInventoryAgeMs for staleness check.
 * @param delegationId Non-empty delegation identifier used to generate delegation-unique roleInstanceIds.
 * @returns            Success with assignments, or failure with reason+detail.
 */
export function resolveRoles(
  preset: MachineDeltaPreset,
  inventory: HostModelInventory,
  constraints: OwnerConstraints,
  freshness: InventoryFreshnessParams,
  delegationId: string,
): ResolutionResult {
  // ── 0. Validate hostId match ──────────────────────────────────────────────
  if (preset.hostId !== inventory.hostId) {
    return {
      outcome: "failure",
      reason: "Host ID mismatch between preset and inventory",
      detail: `Preset hostId: "${preset.hostId}", inventory hostId: "${inventory.hostId}". ` +
        "The inventory must come from the same host the preset is configured for.",
    };
  }

  // ── 1. Validate inventory staleness ──────────────────────────────────────
  const observedAtMs = Date.parse(inventory.observedAt);
  if (Number.isNaN(observedAtMs)) {
    return {
      outcome: "failure",
      reason: "Invalid inventory timestamp",
      detail: `Cannot parse observedAt: "${inventory.observedAt}". Expected ISO-8601 format.`,
    };
  }
  const ageMs = freshness.nowMs - observedAtMs;
  if (ageMs > freshness.maxInventoryAgeMs) {
    return {
      outcome: "failure",
      reason: "Stale inventory rejected",
      detail: `Inventory observed at ${inventory.observedAt} (${ageMs}ms ago) ` +
        `exceeds max age of ${freshness.maxInventoryAgeMs}ms. Refresh the host inventory.`,
    };
  }
  if (ageMs < 0) {
    return {
      outcome: "failure",
      reason: "Inventory observedAt is in the future",
      detail: `observedAt "${inventory.observedAt}" is after nowMs (${freshness.nowMs}). ` +
        "Check clock synchronization.",
    };
  }

  // ── 2. Resolve each role in order ────────────────────────────────────────
  const assignments: ResolvedRoleAssignment[] = [];
  const assignedModelIds = new Set<string>();

  // Determine which roles to resolve
  const rolesToResolve: Array<{ role: DeltaRole; prefs: RoleModelPreference | undefined }> = [];
  for (const role of ROLE_ORDER) {
    if (role === "peer") {
      if (preset.peer) {
        rolesToResolve.push({ role, prefs: preset.peer });
      }
    } else {
      rolesToResolve.push({ role, prefs: preset.roles[role] });
    }
  }

  for (const { role, prefs } of rolesToResolve) {
    const result = resolveOneRole(
      role,
      prefs!,
      inventory,
      constraints,
      assignedModelIds,
      delegationId,
    );

    if (result.outcome === "failure") {
      return result; // propagate failure
    }

    // Narrowed: result is SingleRoleSuccess
    const resolved = result as SingleRoleSuccess;
    assignments.push(resolved.assignment);
    assignedModelIds.add(resolved.assignment.modelId);
  }

  return { outcome: "success", assignments };
}

// ── Single-role resolution ────────────────────────────────────────────────────

interface SingleRoleSuccess {
  readonly outcome: "success";
  readonly assignment: ResolvedRoleAssignment;
}

type SingleRoleResult = SingleRoleSuccess | ResolutionResult;

function resolveOneRole(
  role: DeltaRole,
  prefs: RoleModelPreference,
  inventory: HostModelInventory,
  constraints: OwnerConstraints,
  alreadyAssigned: ReadonlySet<string>,
  delegationId: string,
): SingleRoleResult {
  const reasons: string[] = [];

  // ── Step 1: Filter available models ──────────────────────────────────────
  let candidates = inventory.models.filter(m => m.available);

  // ── Step 2: Remove excluded models ───────────────────────────────────────
  const exclusions = constraints.exclusions?.[role] ?? [];
  if (exclusions.length > 0) {
    const excludedSet = new Set(exclusions);
    const before = candidates.length;
    candidates = candidates.filter(m => !excludedSet.has(m.id));
    if (candidates.length < before) {
      reasons.push(`excluded models removed: ${[...excludedSet].filter(e => inventory.models.some(m => m.id === e && m.available)).join(", ")}`);
    }
  }

  // ── Step 3: Filter by required tags ──────────────────────────────────────
  const mergedTags = [
    ...(prefs.requiredTags ?? []),
    ...(constraints.preferredTags?.[role] ?? []),
  ];
  if (mergedTags.length > 0) {
    const before = candidates.length;
    candidates = candidates.filter(m =>
      mergedTags.every(tag => m.capabilityTags.includes(tag)),
    );
    if (candidates.length < before) {
      reasons.push(`tag-filter: kept ${candidates.length}/${before} models matching required tags [${mergedTags.join(", ")}]`);
    }
  }

  // ── Step 4: Apply hard cost cap ──────────────────────────────────────────
  const maxCost = constraints.maxCostClass;
  if (maxCost) {
    const maxCostOrdinal = COST_ORDER[maxCost] ?? 3;
    const before = candidates.length;
    candidates = candidates.filter(m => {
      const ord = m.costClass !== undefined ? (COST_ORDER[m.costClass] ?? 3) : 3;
      return ord <= maxCostOrdinal;
    });
    if (candidates.length < before) {
      reasons.push(`cost-cap: removed ${before - candidates.length} models above cost class "${maxCost}"`);
    }
  }

  // ── Step 5: Hard pin check ───────────────────────────────────────────────
  const pin = constraints.pins?.[role];
  if (pin) {
    const pinnedModel = candidates.find(m => m.id === pin);
    if (!pinnedModel) {
      // Check if it exists at all (available or not)
      const existsInInventory = inventory.models.some(m => m.id === pin);
      const detail = existsInInventory
        ? `Pinned model "${pin}" exists in inventory but is not available for role "${role}".`
        : `Pinned model "${pin}" not found in inventory for role "${role}".`;
      return {
        outcome: "failure",
        reason: `User-pinned model unavailable: ${pin}`,
        detail: `${detail} Check the preset, inventory, and constraints.`,
      };
    }
    // Pin available → use it directly (source: user-pin)
    return {
      outcome: "success",
      assignment: {
        role,
        roleInstanceId: `ri-${delegationId}-${role}`,
        hostId: inventory.hostId,
        modelId: pinnedModel.id,
        source: "user-pin",
        reasons: [
          `user-pinned model resolved: ${pinnedModel.id}`,
          ...reasons,
        ],
      },
    };
  }

  // ── Step 6: No candidates left → fail ────────────────────────────────────
  if (candidates.length === 0) {
    return {
      outcome: "failure",
      reason: `No eligible candidates for role "${role}"`,
      detail: `After filtering for tags, cost cap, and exclusions, no models remain. ` +
        `Check inventory availability and constraints. Reasons so far: ${reasons.join("; ") || "none"}`,
    };
  }

  // ── Step 7: Rank candidates ──────────────────────────────────────────────
  const effectiveDiversity: RoleModelPreference["diversity"] =
    constraints.diversity ?? prefs.diversity;

  const ranked = rankCandidates(
    candidates,
    prefs.preferredModelIds,
    prefs.preferredCostClass,
    effectiveDiversity,
    alreadyAssigned,
  );

  // ── Step 8: Pick best model ──────────────────────────────────────────────
  for (const c of ranked) {
    const modelUsed = alreadyAssigned.has(c.model.id);

    if (effectiveDiversity === "require" && modelUsed) {
      // Cannot use this model — must be distinct
      continue;
    }

    let source: ResolutionSource;
    const roleReasons = [...reasons];

    if (c.prefIndex === 0) {
      source = "preset-preference";
      roleReasons.unshift(`first-preference selected: ${c.model.id}`);
    } else if (c.prefIndex > 0) {
      source = "availability-fallback";
      // Find the highest-preferred unavailable model for a useful message
      const firstPrefId = prefs.preferredModelIds[0];
      if (firstPrefId && firstPrefId !== c.model.id) {
        roleReasons.unshift(`preferred model "${firstPrefId}" unavailable; fallback to ${c.model.id}`);
      } else {
        roleReasons.unshift(`fallback selection: ${c.model.id}`);
      }
    } else {
      // Not in preference list
      source = "availability-fallback";
      roleReasons.unshift(`no preferred model available; selected: ${c.model.id}`);
    }

    if (effectiveDiversity === "prefer" && modelUsed) {
      source = "availability-fallback";
      roleReasons.unshift(`diversity-prefer: model "${c.model.id}" already used by another role; selected as best available`);
    }

    return {
      outcome: "success",
      assignment: {
        role,
        roleInstanceId: `ri-${delegationId}-${role}`,
        hostId: inventory.hostId,
        modelId: c.model.id,
        source,
        reasons: roleReasons,
      },
    };
  }

  // ── Step 9: No model met diversity requirement ───────────────────────────
  if (effectiveDiversity === "require") {
    return {
      outcome: "failure",
      reason: `Required diversity cannot be met for role "${role}"`,
      detail: `All eligible models [${candidates.map(m => m.id).join(", ")}] ` +
        `are already assigned to other roles: [${[...alreadyAssigned].join(", ")}]. ` +
        `Diversity is set to "require" — roles must use distinct models.`,
    };
  }

  // Should not reach here (prefer/allow should always pick something)
  return {
    outcome: "failure",
    reason: `Unexpected resolution failure for role "${role}"`,
    detail: `Could not select a model after ranking. Candidates: ${candidates.map(m => m.id).join(", ")}`,
  };
}

// ── Candidate ranking ─────────────────────────────────────────────────────────

/**
 * Rank candidates by (per ratified plan §4.3 step 5):
 * 1. Preset preference order (index in preferredModelIds) — primary
 * 2. Diversity (secondary priority for "prefer": among same preference tier,
 *    unused models rank ahead of already-assigned models)
 * 3. Cost preference match (preferredCostClass match boosts)
 * 4. Cost class ordinal (lower cost preferred when no explicit preference)
 * 5. Stable lexical tie-break (model id)
 *
 * For "require" diversity, ranking is the same but the caller enforces
 * the hard diversity block before picking a used model.
 * For "prefer", diversity is a tie-breaker AFTER preference order —
 * a higher-preference model that is already used still beats a lower-preference
 * unused model.
 */
function rankCandidates(
  candidates: HostModelDescriptor[],
  preferredModelIds: readonly string[],
  preferredCostClass: string | undefined,
  diversity: RoleModelPreference["diversity"],
  alreadyAssigned: ReadonlySet<string>,
): Candidate[] {
  const prefIndexMap = new Map<string, number>();
  for (let i = 0; i < preferredModelIds.length; i++) {
    const id = preferredModelIds[i];
    if (id !== undefined && !prefIndexMap.has(id)) {
      prefIndexMap.set(id, i);
    }
  }

  const withPref: Candidate[] = candidates.map(model => ({
    model,
    prefIndex: prefIndexMap.has(model.id) ? prefIndexMap.get(model.id)! : Number.MAX_SAFE_INTEGER,
  }));

  // Sort with stable comparator
  return withPref.sort((a, b) => {
    // 1. Preference order (lower is better; unlisted = MAX) — PRIMARY
    if (a.prefIndex !== b.prefIndex) return a.prefIndex - b.prefIndex;

    // 2. Diversity: same preference tier, unused > used (prefer/require only)
    if (diversity !== "allow") {
      const aPenalty = alreadyAssigned.has(a.model.id) ? 1 : 0;
      const bPenalty = alreadyAssigned.has(b.model.id) ? 1 : 0;
      if (aPenalty !== bPenalty) return aPenalty - bPenalty;
    }

    // 3. Cost class match (preferred cost class gets priority)
    const aCostMatch = preferredCostClass !== undefined && a.model.costClass === (preferredCostClass as string) ? 0 : 1;
    const bCostMatch = preferredCostClass !== undefined && b.model.costClass === (preferredCostClass as string) ? 0 : 1;
    if (aCostMatch !== bCostMatch) return aCostMatch - bCostMatch;

    // 4. Cost class ordinal (lower cost preferred when no explicit preference)
    const aCostOrd = a.model.costClass !== undefined ? (COST_ORDER[a.model.costClass as string] ?? 3) : 3;
    const bCostOrd = b.model.costClass !== undefined ? (COST_ORDER[b.model.costClass as string] ?? 3) : 3;
    if (aCostOrd !== bCostOrd) return aCostOrd - bCostOrd;

    // 5. Stable lexical tie-break
    return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
  });
}
