import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCandidateFingerprint } from "@roll/core";
import type { RigReadinessCandidate, RigProbeObservation } from "@roll/spec";
import { loadRigAdapterMappings, parseRigAdapterMappings, SUPPORTED_RIG_ADAPTERS } from "../src/lib/rig-adapters.js";
import { loadRigReadinessLimits } from "../src/lib/rig-readiness-settings.js";
import { nodeRigStorageIo, publishRigReadinessSnapshot, readLatestRigReadiness, readRigReadinessCache, rigReadinessDirectory, writeRigReadinessSnapshot } from "../src/lib/rig-readiness-storage.js";

let root = "";

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function setup(): { candidates: readonly RigReadinessCandidate[]; observations: readonly RigProbeObservation[]; deps: { io: typeof nodeRigStorageIo; root: string; now: () => number; newRefreshId: () => string } } {
  root = join(tmpdir(), `roll-rig-${randomUUID()}`);
  const candidates = [{ adapter: "codex", configuredModelId: "model-a", cliModelId: "gpt-a", roles: ["builder"] as const, presetIds: ["p"] as const }];
  const observations = [{ ...candidates[0]!, outcome: "ready" as const, reasonCode: "probe_passed" as const, detail: "ok" }];
  return { candidates, observations, deps: { io: nodeRigStorageIo, root, now: () => Date.parse("2026-08-05T00:00:00.000Z"), newRefreshId: () => "refresh-1" } };
}

describe("US-DELTA-017 — machine-local rig readiness storage", () => {
  it("loads only a versioned mapping and validates settings limits", () => {
    root = join(tmpdir(), `roll-rig-${randomUUID()}`);
    mkdirSync(join(root, "delta-team"), { recursive: true });
    writeFileSync(join(root, "delta-team", "rig-adapters.yaml"), "schema: roll-delta-rig-adapters/v1\nmappings:\n  - configuredModelId: model-a\n    adapter: codex\n    cliModelId: gpt-a\n");
    writeFileSync(join(root, "config.yaml"), "delta_rig_readiness:\n  probeTimeoutMs: 1000\n  maxConcurrency: 4\n  freshnessTtlMs: 60000\n");
    expect(SUPPORTED_RIG_ADAPTERS).toContain("codex");
    expect(loadRigAdapterMappings(root)).toEqual([{ configuredModelId: "model-a", adapter: "codex", cliModelId: "gpt-a" }]);
    expect(loadRigReadinessLimits(root)).toEqual({ probeTimeoutMs: 1000, maxConcurrency: 4, freshnessTtlMs: 60000 });
    expect(parseRigAdapterMappings("schema: roll-delta-rig-adapters/v1\nmappings: []\n")).toEqual([]);
    expect(() => parseRigAdapterMappings("schema: unknown\nmappings: []\n", "bad.yaml")).toThrow("bad.yaml:1");
    writeFileSync(join(root, "config.yaml"), "delta_rig_readiness:\n  maxConcurrency: true\n");
    expect(() => loadRigReadinessLimits(root)).toThrow("maxConcurrency");
  });

  it("writes an immutable snapshot, publishes only a revalidated complete target, and reads only the pointer", () => {
    const { candidates, observations, deps } = setup();
    const snapshot = writeRigReadinessSnapshot(deps, candidates, observations);
    expect(snapshot.candidateFingerprint).toBe(computeCandidateFingerprint(candidates));
    expect(() => writeRigReadinessSnapshot(deps, candidates, observations)).toThrow("already exists");
    const latest = publishRigReadinessSnapshot(deps, candidates, snapshot.refreshId);
    expect(latest.refreshId).toBe(snapshot.refreshId);
    expect(readLatestRigReadiness(deps)).toEqual({ pointer: latest, snapshot });
    expect(existsSync(join(rigReadinessDirectory(deps.root), "refresh-1.json"))).toBe(true);
    expect(readdirSync(rigReadinessDirectory(deps.root)).some((name) => name.startsWith(".tmp-"))).toBe(false);
    expect(readdirSync(root, { recursive: true }).every((name) => {
      const relative = String(name);
      return relative === "delta-team" || relative.startsWith("delta-team/rig-readiness");
    })).toBe(true);
  });

  it("does not replace a prior pointer when the snapshot is malformed", () => {
    const { candidates, observations, deps } = setup();
    const snapshot = writeRigReadinessSnapshot(deps, candidates, observations);
    const first = publishRigReadinessSnapshot(deps, candidates, snapshot.refreshId);
    const path = join(rigReadinessDirectory(deps.root), "refresh-1.json");
    writeFileSync(path, "{}\n");
    expect(() => publishRigReadinessSnapshot(deps, candidates, snapshot.refreshId)).toThrow();
    expect(readFileSync(join(rigReadinessDirectory(deps.root), "latest.json"), "utf8")).toBe(JSON.stringify(first) + "\n");
  });

  it("classifies a malformed pointer or target as incompatible without scanning directory order", () => {
    const { candidates, observations, deps } = setup();
    const snapshot = writeRigReadinessSnapshot(deps, candidates, observations);
    publishRigReadinessSnapshot(deps, candidates, snapshot.refreshId);
    writeFileSync(join(rigReadinessDirectory(deps.root), "latest.json"), "not-json\n");
    expect(readRigReadinessCache(deps, candidates, 60_000).status).toEqual({ kind: "incompatible" });
    writeFileSync(join(rigReadinessDirectory(deps.root), "latest.json"), JSON.stringify({ schema: "roll-delta-rig-readiness-latest/v1", refreshId: "nonexistent", candidateFingerprint: snapshot.candidateFingerprint, publishedAt: snapshot.observedAt }) + "\n");
    expect(readRigReadinessCache(deps, candidates, 60_000).status).toEqual({ kind: "incompatible" });
  });

  it("retains the pointed snapshot and only the four newest unpointed snapshots", () => {
    const { candidates, observations, deps } = setup();
    let refreshSequence = 0;
    let nowMs = Date.parse("2026-08-05T00:00:00.000Z");
    const refreshingDeps = {
      ...deps,
      now: () => nowMs++,
      newRefreshId: () => `refresh-${++refreshSequence}`,
    };
    for (let index = 1; index <= 6; index++) {
      const snapshot = writeRigReadinessSnapshot(refreshingDeps, candidates, observations);
      publishRigReadinessSnapshot(refreshingDeps, candidates, snapshot.refreshId);
    }
    const retained = readdirSync(rigReadinessDirectory(root));
    expect(retained).not.toContain("refresh-1.json");
    for (let index = 2; index <= 6; index++) expect(retained).toContain(`refresh-${index}.json`);
  });
});
