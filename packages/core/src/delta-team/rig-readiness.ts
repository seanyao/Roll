/**
 * @responsibility Derives machine-local Delta rig readiness contracts.
 * US-DELTA-017 — pure machine-local Delta rig readiness contracts.
 *
 * This module deliberately has no filesystem, clock, process, or Delta
 * lifecycle imports. Readiness is diagnostic-only and cannot influence model
 * resolution, preparation, leases, events, or delivery truth.
 */
import { createHash } from "node:crypto";
import {
  RIG_PROBE_REASON_CODES,
  RIG_READINESS_SNAPSHOT_SCHEMA,
} from "@roll/spec";
import type {
  RigAdapterMapping,
  RigProbeObservation,
  RigProbeReasonCode,
  RigReadinessCandidate,
  RigReadinessLatest,
  RigReadinessLimits,
  RigReadinessSnapshot,
} from "@roll/spec";

export interface RigCandidateSource {
  readonly presetId: string;
  readonly role: string;
  readonly configuredModelId: string;
}

export type MappingValidationResult =
  | { readonly ok: true; readonly mappings: readonly RigAdapterMapping[] }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export function validateRigAdapterMappings(
  mappings: readonly RigAdapterMapping[],
  supportedAdapters: readonly string[],
): MappingValidationResult {
  const configuredIds = new Set<string>();
  const targets = new Map<string, string>();
  for (let index = 0; index < mappings.length; index++) {
    const mapping = mappings[index]!;
    const field = (name: string): MappingValidationResult => ({
      ok: false,
      reason: "empty_field",
      detail: `rig-adapters.yaml mappings[${index}].${name} must be non-empty`,
    });
    if (mapping.configuredModelId === "") return field("configuredModelId");
    if (mapping.adapter === "") return field("adapter");
    if (mapping.cliModelId === "") return field("cliModelId");
    if (configuredIds.has(mapping.configuredModelId)) {
      return { ok: false, reason: "duplicate_configured_model", detail: `rig-adapters.yaml duplicates configuredModelId ${JSON.stringify(mapping.configuredModelId)}` };
    }
    if (!supportedAdapters.includes(mapping.adapter)) {
      return { ok: false, reason: "unsupported_adapter", detail: `rig-adapters.yaml mapping ${JSON.stringify(mapping.configuredModelId)} uses unsupported adapter ${JSON.stringify(mapping.adapter)}` };
    }
    const target = `${mapping.adapter}\u0000${mapping.cliModelId}`;
    const existing = targets.get(target);
    if (existing !== undefined) {
      return { ok: false, reason: "target_collision", detail: `rig-adapters.yaml maps both ${JSON.stringify(existing)} and ${JSON.stringify(mapping.configuredModelId)} to the same adapter and cliModelId` };
    }
    configuredIds.add(mapping.configuredModelId);
    targets.set(target, mapping.configuredModelId);
  }
  return { ok: true, mappings };
}

/** Derive deterministic candidates by merging only exact configured model IDs. */
export function deriveRigCandidates(
  sources: readonly RigCandidateSource[],
  mappings: readonly RigAdapterMapping[],
): RigReadinessCandidate[] {
  const byConfiguredId = new Map<string, RigAdapterMapping>();
  for (const mapping of mappings) {
    if (byConfiguredId.has(mapping.configuredModelId)) {
      throw new Error(`rig-adapters.yaml has duplicate configuredModelId ${JSON.stringify(mapping.configuredModelId)}`);
    }
    byConfiguredId.set(mapping.configuredModelId, mapping);
  }
  const merged = new Map<string, { roles: Set<string>; presetIds: Set<string> }>();
  for (const source of sources) {
    const mapping = byConfiguredId.get(source.configuredModelId);
    if (mapping === undefined) {
      throw new Error(`rig-adapters.yaml has no exact mapping for configured model ${JSON.stringify(source.configuredModelId)}`);
    }
    const entry = merged.get(source.configuredModelId) ?? { roles: new Set<string>(), presetIds: new Set<string>() };
    entry.roles.add(source.role);
    entry.presetIds.add(source.presetId);
    merged.set(source.configuredModelId, entry);
  }
  return [...merged.entries()]
    .sort(([left], [right]) => compareByteStrings(left, right))
    .map(([configuredModelId, memberships]) => {
      const mapping = byConfiguredId.get(configuredModelId)!;
      return {
        adapter: mapping.adapter,
        configuredModelId,
        cliModelId: mapping.cliModelId,
        roles: sortByteStrings(memberships.roles),
        presetIds: sortByteStrings(memberships.presetIds),
      };
    });
}

/** Exact UTF-8 payload whose sha256 is the candidate configuration identity. */
export function canonicalRigCandidatePayload(candidates: readonly RigReadinessCandidate[]): string {
  return JSON.stringify([...candidates]
    .sort((left, right) => compareCandidate(left, right))
    .map((candidate) => ({
      adapter: candidate.adapter,
      configuredModelId: candidate.configuredModelId,
      cliModelId: candidate.cliModelId,
      roles: sortByteStrings(candidate.roles),
      presetIds: sortByteStrings(candidate.presetIds),
    })));
}

export function computeCandidateFingerprint(candidates: readonly RigReadinessCandidate[]): string {
  return createHash("sha256").update(canonicalRigCandidatePayload(candidates), "utf8").digest("hex");
}

export type RigCacheStatus =
  | { readonly kind: "current" }
  | { readonly kind: "missing" }
  | { readonly kind: "incompatible" }
  | { readonly kind: "stale"; readonly ageMs: number };

export function classifyRigReadiness(input: {
  readonly currentFingerprint: string;
  readonly pointer: RigReadinessLatest | null;
  readonly snapshot: RigReadinessSnapshot | null;
  readonly nowMs: number;
  readonly ttlMs: number;
}): RigCacheStatus {
  if (input.pointer === null || input.snapshot === null) return { kind: "missing" };
  if (
    input.pointer.candidateFingerprint !== input.currentFingerprint ||
    input.snapshot.candidateFingerprint !== input.currentFingerprint ||
    input.pointer.refreshId !== input.snapshot.refreshId
  ) return { kind: "incompatible" };
  const observedAtMs = Date.parse(input.snapshot.observedAt);
  if (Number.isNaN(observedAtMs)) return { kind: "incompatible" };
  const ageMs = input.nowMs - observedAtMs;
  return ageMs > input.ttlMs ? { kind: "stale", ageMs } : { kind: "current" };
}

export interface RigCandidateView {
  readonly candidate: RigReadinessCandidate;
  readonly observation: RigProbeObservation | null;
  readonly reasonCode: RigProbeReasonCode;
}

export function projectRigReadiness(
  candidates: readonly RigReadinessCandidate[],
  snapshot: RigReadinessSnapshot | null,
  status: RigCacheStatus,
): readonly RigCandidateView[] {
  if (status.kind !== "current" || snapshot === null) {
    const reasonCode: RigProbeReasonCode = status.kind === "missing" ? "cache_missing" : status.kind === "stale" ? "cache_stale" : "cache_incompatible";
    return candidates.map((candidate) => ({ candidate, observation: null, reasonCode }));
  }
  const observations = new Map(snapshot.observations.map((observation) => [observationKey(observation), observation]));
  return candidates.map((candidate) => ({
    candidate,
    observation: observations.get(candidateKey(candidate)) ?? null,
    reasonCode: observations.get(candidateKey(candidate))?.reasonCode ?? "cache_incompatible",
  }));
}

export type SnapshotValidationResult =
  | { readonly ok: true; readonly snapshot: RigReadinessSnapshot }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

/** Validate the complete immutable snapshot before it can be published. */
export function validateRigReadinessSnapshot(
  value: unknown,
  candidates: readonly RigReadinessCandidate[],
): SnapshotValidationResult {
  if (!isRecord(value)) return invalidSnapshot("shape", "snapshot must be an object");
  if (value.schema !== RIG_READINESS_SNAPSHOT_SCHEMA) return invalidSnapshot("schema", "snapshot schema is invalid");
  if (typeof value.refreshId !== "string" || value.refreshId === "") return invalidSnapshot("refresh_id", "snapshot refreshId must be non-empty");
  if (typeof value.candidateFingerprint !== "string") return invalidSnapshot("fingerprint", "snapshot candidateFingerprint must be a string");
  if (!isCanonicalIso(value.observedAt)) return invalidSnapshot("observed_at", "snapshot observedAt must be ISO-8601");
  if (!Array.isArray(value.observations)) return invalidSnapshot("observations", "snapshot observations must be an array");
  const expectedFingerprint = computeCandidateFingerprint(candidates);
  if (value.candidateFingerprint !== expectedFingerprint) return invalidSnapshot("fingerprint", "snapshot candidateFingerprint does not match current candidates");
  if (value.observations.length !== candidates.length) return invalidSnapshot("observation_count", "snapshot must contain exactly one observation per candidate");
  const expected = new Set(candidates.map(candidateKey));
  const seen = new Set<string>();
  for (const rawObservation of value.observations) {
    if (!isObservation(rawObservation)) return invalidSnapshot("observation", "snapshot has an unclassified observation");
    const key = observationKey(rawObservation);
    if (!expected.has(key)) return invalidSnapshot("observation_extra", "snapshot has an observation not matching a candidate");
    if (seen.has(key)) return invalidSnapshot("observation_duplicate", "snapshot has duplicate candidate observations");
    seen.add(key);
  }
  if (seen.size !== expected.size) return invalidSnapshot("observation_missing", "snapshot is missing a candidate observation");
  return { ok: true, snapshot: value as unknown as RigReadinessSnapshot };
}

export const DEFAULT_RIG_READINESS_LIMITS: RigReadinessLimits = {
  probeTimeoutMs: 20_000,
  maxConcurrency: 2,
  freshnessTtlMs: 900_000,
};

export type LimitsValidationResult =
  | { readonly ok: true; readonly limits: RigReadinessLimits }
  | { readonly ok: false; readonly field: string; readonly detail: string };

export function validateRigReadinessLimits(value: unknown): LimitsValidationResult {
  if (value === undefined) return { ok: true, limits: DEFAULT_RIG_READINESS_LIMITS };
  if (!isRecord(value)) return { ok: false, field: "delta_rig_readiness", detail: "delta_rig_readiness must be a mapping" };
  const limits: RigReadinessLimits = {
    probeTimeoutMs: value.probeTimeoutMs === undefined ? DEFAULT_RIG_READINESS_LIMITS.probeTimeoutMs : value.probeTimeoutMs as number,
    maxConcurrency: value.maxConcurrency === undefined ? DEFAULT_RIG_READINESS_LIMITS.maxConcurrency : value.maxConcurrency as number,
    freshnessTtlMs: value.freshnessTtlMs === undefined ? DEFAULT_RIG_READINESS_LIMITS.freshnessTtlMs : value.freshnessTtlMs as number,
  };
  for (const [field, min, max] of [["probeTimeoutMs", 1_000, 60_000], ["maxConcurrency", 1, 4], ["freshnessTtlMs", 60_000, 3_600_000]] as const) {
    const scalar = limits[field];
    if (!Number.isInteger(scalar) || scalar < min || scalar > max) {
      return { ok: false, field, detail: `${field} must be an integer from ${min} to ${max}` };
    }
  }
  return { ok: true, limits };
}

function compareCandidate(left: RigReadinessCandidate, right: RigReadinessCandidate): number {
  return compareByteStrings(left.adapter, right.adapter) ||
    compareByteStrings(left.configuredModelId, right.configuredModelId) ||
    compareByteStrings(left.cliModelId, right.cliModelId);
}

function sortByteStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareByteStrings);
}

function compareByteStrings(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function candidateKey(candidate: Pick<RigReadinessCandidate, "adapter" | "configuredModelId" | "cliModelId">): string {
  return `${candidate.adapter}\u0000${candidate.configuredModelId}\u0000${candidate.cliModelId}`;
}

function observationKey(observation: Pick<RigProbeObservation, "adapter" | "configuredModelId" | "cliModelId">): string {
  return candidateKey(observation);
}

function invalidSnapshot(reason: string, detail: string): SnapshotValidationResult {
  return { ok: false, reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function isObservation(value: unknown): value is RigProbeObservation {
  if (!isRecord(value)) return false;
  return typeof value.adapter === "string" && typeof value.configuredModelId === "string" &&
    typeof value.cliModelId === "string" && typeof value.detail === "string" &&
    (value.outcome === "ready" || value.outcome === "blocked" || value.outcome === "unknown") &&
    typeof value.reasonCode === "string" && (RIG_PROBE_REASON_CODES as readonly string[]).includes(value.reasonCode) &&
    (value.latencyMs === undefined || (typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs)));
}
