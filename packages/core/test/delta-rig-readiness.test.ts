import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RIG_READINESS_LIMITS,
  canonicalRigCandidatePayload,
  classifyRigReadiness,
  computeCandidateFingerprint,
  deriveRigCandidates,
  projectRigReadiness,
  validateRigAdapterMappings,
  validateRigReadinessLimits,
  validateRigReadinessSnapshot,
} from "../src/delta-team/rig-readiness.js";
import type { RigAdapterMapping, RigReadinessCandidate } from "@roll/spec";

const mappings: readonly RigAdapterMapping[] = [
  { configuredModelId: "model-a", adapter: "codex", cliModelId: "gpt-a" },
  { configuredModelId: "model-b", adapter: "claude", cliModelId: "claude-b" },
];

const candidates: readonly RigReadinessCandidate[] = [
  { adapter: "claude", configuredModelId: "model-b", cliModelId: "claude-b", roles: ["evaluator"], presetIds: ["preset-b"] },
  { adapter: "codex", configuredModelId: "model-a", cliModelId: "gpt-a", roles: ["builder", "designer"], presetIds: ["preset-a", "preset-b"] },
];

describe("US-DELTA-017 — pure rig readiness contracts", () => {
  it("validates adapter mappings without normalizing configured IDs", () => {
    expect(validateRigAdapterMappings(mappings, ["claude", "codex"])).toEqual({ ok: true, mappings });
    expect(validateRigAdapterMappings([...mappings, { configuredModelId: "model-a", adapter: "codex", cliModelId: "other" }], ["claude", "codex"])).toMatchObject({ ok: false, reason: "duplicate_configured_model" });
    expect(validateRigAdapterMappings([...mappings, { configuredModelId: "other", adapter: "codex", cliModelId: "gpt-a" }], ["claude", "codex"])).toMatchObject({ ok: false, reason: "target_collision" });
    expect(validateRigAdapterMappings([{ configuredModelId: " model-a", adapter: "codex", cliModelId: "gpt-a" }], ["codex"])).toMatchObject({ ok: true });
  });

  it("derives one canonical candidate per exact configured model", () => {
    expect(deriveRigCandidates([
      { presetId: "preset-b", role: "builder", configuredModelId: "model-a" },
      { presetId: "preset-a", role: "designer", configuredModelId: "model-a" },
      { presetId: "preset-b", role: "builder", configuredModelId: "model-a" },
      { presetId: "preset-b", role: "evaluator", configuredModelId: "model-b" },
    ], mappings)).toEqual([
      { adapter: "codex", configuredModelId: "model-a", cliModelId: "gpt-a", roles: ["builder", "designer"], presetIds: ["preset-a", "preset-b"] },
      { adapter: "claude", configuredModelId: "model-b", cliModelId: "claude-b", roles: ["evaluator"], presetIds: ["preset-b"] },
    ]);
    expect(deriveRigCandidates([
      { presetId: "ä", role: "builder", configuredModelId: "model-a" },
      { presetId: "z", role: "designer", configuredModelId: "model-a" },
    ], mappings)[0]!.presetIds).toEqual(["z", "ä"]);
    expect(() => deriveRigCandidates([{ presetId: "p", role: "builder", configuredModelId: "model-a " }], mappings)).toThrow("model-a ");
  });

  it("freezes the fixed-key canonical payload and sha-256 fingerprint", () => {
    const payload = canonicalRigCandidatePayload(candidates);
    expect(payload).toBe('[{"adapter":"claude","configuredModelId":"model-b","cliModelId":"claude-b","roles":["evaluator"],"presetIds":["preset-b"]},{"adapter":"codex","configuredModelId":"model-a","cliModelId":"gpt-a","roles":["builder","designer"],"presetIds":["preset-a","preset-b"]}]');
    expect(computeCandidateFingerprint(candidates)).toBe(createHash("sha256").update(payload, "utf8").digest("hex"));
  });

  it("classifies fingerprint incompatibility before TTL and projects cache reasons", () => {
    const current = computeCandidateFingerprint(candidates);
    const snapshot = {
      schema: "roll-delta-rig-readiness/v1" as const,
      refreshId: "refresh-1",
      candidateFingerprint: current,
      observedAt: "2026-08-05T00:00:00.000Z",
      observations: candidates.map((candidate) => ({ ...candidate, outcome: "ready" as const, reasonCode: "probe_passed" as const, detail: "ok" })),
    };
    const pointer = { schema: "roll-delta-rig-readiness-latest/v1" as const, refreshId: "refresh-1", candidateFingerprint: "changed", publishedAt: "2026-08-05T00:00:00.000Z" };
    expect(classifyRigReadiness({ currentFingerprint: current, pointer, snapshot, nowMs: Date.parse(snapshot.observedAt), ttlMs: 1 })).toEqual({ kind: "incompatible" });
    const stale = classifyRigReadiness({ currentFingerprint: current, pointer: { ...pointer, candidateFingerprint: current }, snapshot, nowMs: Date.parse(snapshot.observedAt) + 2, ttlMs: 1 });
    expect(stale).toEqual({ kind: "stale", ageMs: 2 });
    expect(projectRigReadiness(candidates, snapshot, stale).every((view) => view.reasonCode === "cache_stale" && view.observation === null)).toBe(true);
  });

  it("requires a complete classified snapshot and bounded integer limits", () => {
    const fingerprint = computeCandidateFingerprint(candidates);
    const snapshot = {
      schema: "roll-delta-rig-readiness/v1" as const,
      refreshId: "refresh-1",
      candidateFingerprint: fingerprint,
      observedAt: "2026-08-05T00:00:00.000Z",
      observations: [{ ...candidates[0]!, outcome: "ready" as const, reasonCode: "probe_passed" as const, detail: "ok" }],
    };
    expect(validateRigReadinessSnapshot(snapshot, candidates)).toMatchObject({ ok: false, reason: "observation_count" });
    expect(validateRigReadinessLimits(undefined)).toEqual({ ok: true, limits: DEFAULT_RIG_READINESS_LIMITS });
    expect(validateRigReadinessLimits({ probeTimeoutMs: 1000, maxConcurrency: 4, freshnessTtlMs: 3_600_000 })).toMatchObject({ ok: true });
    expect(validateRigReadinessLimits({ probeTimeoutMs: "1000" })).toMatchObject({ ok: false, field: "probeTimeoutMs" });
    expect(validateRigReadinessLimits({ maxConcurrency: 1.5 })).toMatchObject({ ok: false, field: "maxConcurrency" });
    expect(validateRigReadinessLimits({ freshnessTtlMs: null })).toMatchObject({ ok: false, field: "freshnessTtlMs" });
  });

  it("has no dispatch, resolution, lifecycle, truth, workspace, or lease dependency", () => {
    const source = readFileSync(new URL("../src/delta-team/rig-readiness.ts", import.meta.url), "utf8");
    const imports = source.match(/^import .*$/gm)?.join("\n") ?? "";
    expect(imports).not.toMatch(/delta-allocation|model-resolution|prepare|\/events\/|\/truth\/|workspace|lease/);
  });
});
