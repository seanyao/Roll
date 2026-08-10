/** US-DELTA-012 — normalized attempt outcomes and availability facts. */
import { describe, expect, it } from "vitest";
import {
  attemptCauseFromBlockReason,
  projectDeltaAttemptFacts,
} from "../src/delta-team/attempt-observation.js";
import type { RollEvent } from "@roll/spec";

const prepared = (id: string): RollEvent => ({
  type: "delta:prepared", delegationId: id, runId: `delta-${id}`, storyId: "US-DELTA-012",
  trigger: "host-guided", topology: "delta-team", qualityProfile: "verified",
  presetId: "fixture", presetSha256: "a", hostId: "host-a", ts: 1,
});

const availability = (id: string, role = "builder"): RollEvent => ({
  type: "delta:role_availability_observed", v: 1, delegationId: id, storyId: "US-DELTA-012",
  role: role as "builder", hostId: "host-a", modelId: "model-a", transportClass: "host-probe",
  probeOutcome: "passed", probeLatencyMs: 12, selection: "selected", reason: "observed health probe",
  invocationObserved: false, ts: 2,
});

const outcome = (id: string, cause: "external_liveness" | "owner_scope_change" | "artifact_protocol" | "ci_or_test_flake" | "unknown"): RollEvent => ({
  type: "delta:attempt_outcome", v: 1, delegationId: id, storyId: "US-DELTA-012", cause,
  evidenceRef: "event:fixture", terminalFact: cause === "owner_scope_change" ? "handoff_ready" : "blocked", ts: 3,
});

describe("US-DELTA-012 closed taxonomy", () => {
  it("maps only explicit protocol facts and leaves unclassified facts unknown", () => {
    expect(attemptCauseFromBlockReason("evaluation_repair_required")).toBe("evaluator_finding");
    expect(attemptCauseFromBlockReason("artifact_invalid")).toBe("artifact_protocol");
    expect(attemptCauseFromBlockReason("identity_collision")).toBe("identity_or_routing");
    expect(attemptCauseFromBlockReason("host_spawn_failed")).toBe("external_liveness");
    expect(attemptCauseFromBlockReason("unrecognised-history")).toBe("unknown");
  });
});

describe("US-DELTA-012 representative immutable fixtures", () => {
  const fixtures: Readonly<Record<string, readonly RollEvent[]>> = {
    "pi-stall": [prepared("pi-stall"), availability("pi-stall"), outcome("pi-stall", "external_liveness")],
    "token-window": [prepared("token-window"), availability("token-window"), outcome("token-window", "external_liveness")],
    "auth-blocked": [prepared("auth-blocked"), availability("auth-blocked"), outcome("auth-blocked", "external_liveness")],
    "artifact-invalid": [prepared("artifact-invalid"), outcome("artifact-invalid", "artifact_protocol")],
    "ci-race": [prepared("ci-race"), outcome("ci-race", "ci_or_test_flake")],
    "normal-merge": [prepared("normal-merge"), availability("normal-merge"), outcome("normal-merge", "unknown")],
  };

  for (const [name, events] of Object.entries(fixtures)) {
    it(`${name}: renders facts without a provider preference or invocation inference`, () => {
      expect(projectDeltaAttemptFacts(name, events)).toMatchSnapshot();
    });
  }

  it("keeps the first terminal cause and reports duplicate, contradictory, and out-of-order facts", () => {
    const view = projectDeltaAttemptFacts("diagnostic", [
      outcome("diagnostic", "artifact_protocol"),
      prepared("diagnostic"),
      outcome("diagnostic", "artifact_protocol"),
      outcome("diagnostic", "owner_scope_change"),
      availability("diagnostic"),
      availability("diagnostic"),
    ]);
    expect(view).toMatchSnapshot();
  });
});
