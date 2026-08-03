import { describe, expect, it } from "vitest";
import {
  diagnoseWorkspace,
  type WorkspaceDoctorFacts,
} from "../src/workspace/doctor.js";

function diagnose(probes: WorkspaceDoctorFacts["probes"]) {
  return diagnoseWorkspace({ workspaceId: "ws-demo", probes });
}

describe("US-WS-018 Workspace doctor classification", () => {
  it("returns one deterministic healthy report when every probe is current", () => {
    expect(diagnose([
      { kind: "registry", state: "consistent", evidencePath: "workspaces.json", targetId: "ws-demo" },
      { kind: "cache", state: "compatible", evidencePath: "repos/repo-a", targetId: "repo-a" },
      { kind: "requirement_projection", state: "current", archiveStatus: "healthy", evidencePath: "requirements/jira/req-a", targetId: "req-a" },
      { kind: "issue", state: "compatible", evidencePath: "issues/US-1", targetId: "US-1" },
      { kind: "lease", state: "active", evidencePath: "agent-capacity/leases/a.json", targetId: "lease-a" },
    ])).toEqual({
      schema: "roll.workspace-doctor/v1",
      workspaceId: "ws-demo",
      status: "healthy",
      findings: [],
      nextAction: { kind: "none" },
    });
  });

  it("maps every bounded repair to an explicit typed action", () => {
    const report = diagnose([
      { kind: "registry", state: "stale_path", evidencePath: "workspaces.json", targetId: "ws-demo" },
      { kind: "cache", state: "repairable", evidencePath: "repos/repo-a", targetId: "repo-a" },
      { kind: "requirement_projection", state: "drift", archiveStatus: "healthy", evidencePath: "requirements/jira/req-a", targetId: "req-a" },
      { kind: "issue", state: "missing_worktree", dirty: false, evidencePath: "issues/US-1/product", targetId: "US-1/product" },
      { kind: "lease", state: "stale_owned_dead", evidencePath: "agent-capacity/leases/a.json", targetId: "lease-a" },
    ]);

    expect(report.status).toBe("repairable");
    expect(report.findings.map((finding) => [finding.code, finding.repairAction])).toEqual([
      ["registry_stale_path", { kind: "update_registry_path", targetId: "ws-demo" }],
      ["cache_repairable", { kind: "rebuild_cache", targetId: "repo-a" }],
      ["requirement_projection_drift", { kind: "repair_requirement_projection", targetId: "req-a" }],
      ["issue_worktree_missing", { kind: "recreate_clean_worktree", targetId: "US-1/product" }],
      ["lease_stale_owned", { kind: "cleanup_stale_owned_lease", targetId: "lease-a" }],
    ]);
    expect(report.findings.every((finding) => finding.status === "repairable")).toBe(true);
    expect(report.nextAction).toEqual({ kind: "repair", action: { kind: "update_registry_path", targetId: "ws-demo" } });
  });

  it("offers a typed repair for a stale owned capacity broker lock", () => {
    const probe = {
      kind: "capacity_broker_lock",
      state: "stale_owned_dead",
      evidencePath: "locks/capacity/broker.lock",
      targetId: "broker-lock",
    } as unknown as WorkspaceDoctorFacts["probes"][number];

    expect(diagnose([probe])).toMatchObject({
      status: "repairable",
      findings: [{
        code: "capacity_broker_lock_stale_owned",
        repairAction: { kind: "cleanup_stale_capacity_broker_lock", targetId: "broker-lock" },
      }],
    });
  });

  it.each([
    ["healthy archive permits drift repair", "drift", "healthy", "repairable", "repair_requirement_projection"],
    ["healthy archive permits interrupted repair resume", "pending_journal", "healthy", "repairable", "repair_requirement_projection"],
    ["corrupt archive makes projection drift a data risk", "drift", "corrupt", "data_loss_risk", undefined],
    ["untrusted archive blocks projection writes", "drift", "untrusted", "blocked", undefined],
    ["unsupported projection schema blocks writes", "unsupported_schema", "healthy", "blocked", undefined],
  ] as const)("%s", (_name, state, archiveStatus, expectedStatus, action) => {
    const report = diagnose([{
      kind: "requirement_projection",
      state,
      archiveStatus,
      evidencePath: "requirements/jira/req-a",
      targetId: "req-a",
    }]);

    expect(report.status).toBe(expectedStatus);
    expect(report.findings[0]?.repairAction?.kind).toBe(action);
  });

  it("lets dirty/conflicting work dominate blocked and repairable findings", () => {
    const report = diagnose([
      { kind: "cache", state: "absent", evidencePath: "repos/repo-a", targetId: "repo-a" },
      { kind: "lease", state: "stale_live_or_foreign", evidencePath: "agent-capacity/leases/b.json", targetId: "lease-b" },
      { kind: "issue", state: "missing_worktree", dirty: true, evidencePath: "issues/US-1/product", targetId: "US-1/product" },
    ]);

    expect(report.status).toBe("data_loss_risk");
    expect(report.findings.map((finding) => finding.status)).toEqual([
      "repairable",
      "data_loss_risk",
      "blocked",
    ]);
    expect(report.nextAction).toEqual({
      kind: "owner_intervention",
      code: "issue_worktree_dirty_or_unpushed",
      evidencePath: "issues/US-1/product",
    });
  });

  it("sorts probes deterministically without mutating the caller's facts", () => {
    const probes = Object.freeze([
      Object.freeze({ kind: "lease" as const, state: "unsupported_schema" as const, evidencePath: "z", targetId: "z" }),
      Object.freeze({ kind: "registry" as const, state: "invalid_manifest" as const, evidencePath: "a", targetId: "a" }),
    ]);
    const facts = Object.freeze({ workspaceId: "ws-demo", probes });

    const first = diagnoseWorkspace(facts);
    const second = diagnoseWorkspace(facts);

    expect(second).toEqual(first);
    expect(first.findings.map((finding) => finding.code)).toEqual([
      "registry_invalid_manifest",
      "lease_unsupported_schema",
    ]);
    expect(facts.probes).toEqual(probes);
  });
});
