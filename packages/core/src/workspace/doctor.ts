export const WORKSPACE_DOCTOR_REPORT_V1 = "roll.workspace-doctor/v1" as const;

export type WorkspaceDoctorStatus = "healthy" | "repairable" | "blocked" | "data_loss_risk";

export type WorkspaceDoctorRepairKind =
  | "update_registry_path"
  | "rebuild_cache"
  | "repair_requirement_projection"
  | "recreate_clean_worktree"
  | "cleanup_stale_owned_lease"
  | "cleanup_stale_capacity_broker_lock";

export interface WorkspaceDoctorRepairAction {
  readonly kind: WorkspaceDoctorRepairKind;
  readonly targetId: string;
}

interface DoctorProbeBase {
  readonly evidencePath: string;
  readonly targetId: string;
}

export interface RegistryDoctorProbe extends DoctorProbeBase {
  readonly kind: "registry";
  readonly state:
    | "consistent"
    | "stale_path"
    | "identity_mismatch"
    | "invalid_manifest"
    | "pending_journal"
    | "unsupported_schema";
}

export interface CacheDoctorProbe extends DoctorProbeBase {
  readonly kind: "cache";
  readonly state: "compatible" | "absent" | "repairable" | "conflict" | "unsupported_schema";
}

export interface RequirementProjectionDoctorProbe extends DoctorProbeBase {
  readonly kind: "requirement_projection";
  readonly state: "current" | "drift" | "pending_journal" | "unsupported_schema";
  readonly archiveStatus: "healthy" | "corrupt" | "untrusted";
}

export interface IssueDoctorProbe extends DoctorProbeBase {
  readonly kind: "issue";
  readonly state: "compatible" | "partial_journal" | "missing_worktree" | "dirty_or_unpushed" | "conflict" | "unsupported_schema";
  readonly dirty?: boolean;
}

export interface LeaseDoctorProbe extends DoctorProbeBase {
  readonly kind: "lease";
  readonly state: "active" | "stale_owned_dead" | "stale_live_or_foreign" | "unreadable" | "unsupported_schema";
}

export interface RuntimeLockDoctorProbe extends DoctorProbeBase {
  readonly kind: "runtime_lock";
  readonly state: "active" | "stale_owned_dead" | "stale_live_or_foreign" | "unreadable" | "unsupported_schema";
}

export interface CapacityBrokerLockDoctorProbe extends DoctorProbeBase {
  readonly kind: "capacity_broker_lock";
  readonly state: "active" | "stale_owned_dead" | "stale_live_or_foreign" | "unreadable";
}

export type WorkspaceDoctorProbe =
  | RegistryDoctorProbe
  | CacheDoctorProbe
  | RequirementProjectionDoctorProbe
  | IssueDoctorProbe
  | LeaseDoctorProbe
  | RuntimeLockDoctorProbe
  | CapacityBrokerLockDoctorProbe;

export type WorkspaceDoctorFindingCode =
  | "registry_stale_path"
  | "registry_identity_mismatch"
  | "registry_invalid_manifest"
  | "registry_pending_journal"
  | "registry_unsupported_schema"
  | "cache_absent"
  | "cache_repairable"
  | "cache_conflict"
  | "cache_unsupported_schema"
  | "requirement_projection_drift"
  | "requirement_projection_pending_journal"
  | "requirement_archive_corrupt"
  | "requirement_archive_untrusted"
  | "requirement_projection_unsupported_schema"
  | "issue_partial_journal"
  | "issue_worktree_missing"
  | "issue_worktree_dirty_or_unpushed"
  | "issue_conflict"
  | "issue_unsupported_schema"
  | "lease_stale_owned"
  | "lease_stale_live_or_foreign"
  | "lease_unreadable"
  | "lease_unsupported_schema"
  | "capacity_broker_lock_stale_owned"
  | "capacity_broker_lock_stale_live_or_foreign"
  | "capacity_broker_lock_unreadable"
  | "runtime_lock_stale_owned"
  | "runtime_lock_stale_live_or_foreign"
  | "runtime_lock_unreadable"
  | "runtime_lock_unsupported_schema";

export interface WorkspaceDoctorFinding {
  readonly code: WorkspaceDoctorFindingCode;
  readonly status: Exclude<WorkspaceDoctorStatus, "healthy">;
  readonly evidencePath: string;
  readonly targetId: string;
  readonly repairAction?: WorkspaceDoctorRepairAction;
}

export type WorkspaceDoctorNextAction =
  | { readonly kind: "none" }
  | { readonly kind: "repair"; readonly action: WorkspaceDoctorRepairAction }
  | {
      readonly kind: "owner_intervention";
      readonly code: WorkspaceDoctorFindingCode;
      readonly evidencePath: string;
    };

export interface WorkspaceDoctorFacts {
  readonly workspaceId: string;
  readonly probes: readonly WorkspaceDoctorProbe[];
}

export interface WorkspaceDoctorReport {
  readonly schema: typeof WORKSPACE_DOCTOR_REPORT_V1;
  readonly workspaceId: string;
  readonly status: WorkspaceDoctorStatus;
  readonly findings: readonly WorkspaceDoctorFinding[];
  readonly nextAction: WorkspaceDoctorNextAction;
}

const KIND_ORDER: Readonly<Record<WorkspaceDoctorProbe["kind"], number>> = {
  registry: 0,
  cache: 1,
  requirement_projection: 2,
  issue: 3,
  runtime_lock: 4,
  capacity_broker_lock: 5,
  lease: 6,
};

const STATUS_ORDER: Readonly<Record<WorkspaceDoctorStatus, number>> = {
  healthy: 0,
  repairable: 1,
  blocked: 2,
  data_loss_risk: 3,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finding(
  probe: WorkspaceDoctorProbe,
  code: WorkspaceDoctorFindingCode,
  status: WorkspaceDoctorFinding["status"],
  repairKind?: WorkspaceDoctorRepairKind,
): WorkspaceDoctorFinding {
  return {
    code,
    status,
    evidencePath: probe.evidencePath,
    targetId: probe.targetId,
    ...(repairKind === undefined
      ? {}
      : { repairAction: { kind: repairKind, targetId: probe.targetId } }),
  };
}

function classifyRegistry(probe: RegistryDoctorProbe): WorkspaceDoctorFinding | undefined {
  if (probe.state === "consistent") return undefined;
  if (probe.state === "stale_path") return finding(probe, "registry_stale_path", "repairable", "update_registry_path");
  if (probe.state === "identity_mismatch") return finding(probe, "registry_identity_mismatch", "data_loss_risk");
  if (probe.state === "invalid_manifest") return finding(probe, "registry_invalid_manifest", "data_loss_risk");
  if (probe.state === "pending_journal") return finding(probe, "registry_pending_journal", "blocked");
  return finding(probe, "registry_unsupported_schema", "blocked");
}

function classifyCache(probe: CacheDoctorProbe): WorkspaceDoctorFinding | undefined {
  if (probe.state === "compatible") return undefined;
  if (probe.state === "absent") return finding(probe, "cache_absent", "repairable", "rebuild_cache");
  if (probe.state === "repairable") return finding(probe, "cache_repairable", "repairable", "rebuild_cache");
  if (probe.state === "conflict") return finding(probe, "cache_conflict", "data_loss_risk");
  return finding(probe, "cache_unsupported_schema", "blocked");
}

function classifyRequirement(probe: RequirementProjectionDoctorProbe): WorkspaceDoctorFinding | undefined {
  if (probe.state === "current") return undefined;
  if (probe.state === "unsupported_schema") {
    return finding(probe, "requirement_projection_unsupported_schema", "blocked");
  }
  if (probe.archiveStatus === "untrusted") {
    return finding(probe, "requirement_archive_untrusted", "blocked");
  }
  if (probe.archiveStatus === "corrupt") {
    return finding(probe, "requirement_archive_corrupt", "data_loss_risk");
  }
  const code = probe.state === "pending_journal"
    ? "requirement_projection_pending_journal"
    : "requirement_projection_drift";
  return finding(probe, code, "repairable", "repair_requirement_projection");
}

function classifyIssue(probe: IssueDoctorProbe): WorkspaceDoctorFinding | undefined {
  if (probe.state === "compatible") return undefined;
  if (probe.state === "unsupported_schema") return finding(probe, "issue_unsupported_schema", "blocked");
  if (probe.state === "conflict") return finding(probe, "issue_conflict", "data_loss_risk");
  if (probe.state === "dirty_or_unpushed" || probe.dirty === true) {
    return finding(probe, "issue_worktree_dirty_or_unpushed", "data_loss_risk");
  }
  if (probe.state === "partial_journal") {
    return finding(probe, "issue_partial_journal", "repairable", "recreate_clean_worktree");
  }
  return finding(probe, "issue_worktree_missing", "repairable", "recreate_clean_worktree");
}

function classifyLease(probe: LeaseDoctorProbe): WorkspaceDoctorFinding | undefined {
  if (probe.state === "active") return undefined;
  if (probe.state === "stale_owned_dead") return finding(probe, "lease_stale_owned", "repairable", "cleanup_stale_owned_lease");
  if (probe.state === "stale_live_or_foreign") return finding(probe, "lease_stale_live_or_foreign", "blocked");
  if (probe.state === "unreadable") return finding(probe, "lease_unreadable", "blocked");
  return finding(probe, "lease_unsupported_schema", "blocked");
}

function classifyRuntimeLock(probe: RuntimeLockDoctorProbe): WorkspaceDoctorFinding | undefined {
  if (probe.state === "active") return undefined;
  if (probe.state === "stale_owned_dead") return finding(probe, "runtime_lock_stale_owned", "blocked");
  if (probe.state === "stale_live_or_foreign") return finding(probe, "runtime_lock_stale_live_or_foreign", "blocked");
  if (probe.state === "unreadable") return finding(probe, "runtime_lock_unreadable", "blocked");
  return finding(probe, "runtime_lock_unsupported_schema", "blocked");
}

function classifyCapacityBrokerLock(probe: CapacityBrokerLockDoctorProbe): WorkspaceDoctorFinding | undefined {
  if (probe.state === "active") return undefined;
  if (probe.state === "stale_owned_dead") {
    return finding(probe, "capacity_broker_lock_stale_owned", "repairable", "cleanup_stale_capacity_broker_lock");
  }
  if (probe.state === "stale_live_or_foreign") {
    return finding(probe, "capacity_broker_lock_stale_live_or_foreign", "blocked");
  }
  return finding(probe, "capacity_broker_lock_unreadable", "blocked");
}

function classify(probe: WorkspaceDoctorProbe): WorkspaceDoctorFinding | undefined {
  if (probe.kind === "registry") return classifyRegistry(probe);
  if (probe.kind === "cache") return classifyCache(probe);
  if (probe.kind === "requirement_projection") return classifyRequirement(probe);
  if (probe.kind === "issue") return classifyIssue(probe);
  if (probe.kind === "lease") return classifyLease(probe);
  if (probe.kind === "capacity_broker_lock") return classifyCapacityBrokerLock(probe);
  return classifyRuntimeLock(probe);
}

export function diagnoseWorkspace(facts: WorkspaceDoctorFacts): WorkspaceDoctorReport {
  const probes = [...facts.probes].sort((left, right) =>
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
    compareText(left.targetId, right.targetId) ||
    compareText(left.evidencePath, right.evidencePath)
  );
  const findings = probes.flatMap((probe) => {
    const result = classify(probe);
    return result === undefined ? [] : [result];
  });
  const status = findings.reduce<WorkspaceDoctorStatus>(
    (current, item) => STATUS_ORDER[item.status] > STATUS_ORDER[current] ? item.status : current,
    "healthy",
  );
  if (status === "healthy") {
    return {
      schema: WORKSPACE_DOCTOR_REPORT_V1,
      workspaceId: facts.workspaceId,
      status,
      findings,
      nextAction: { kind: "none" },
    };
  }
  const primary = findings.find((item) => item.status === status);
  if (primary === undefined) throw new Error("workspace_doctor_primary_finding_missing");
  const nextAction: WorkspaceDoctorNextAction = status === "repairable" && primary.repairAction !== undefined
    ? { kind: "repair", action: primary.repairAction }
    : { kind: "owner_intervention", code: primary.code, evidencePath: primary.evidencePath };
  return {
    schema: WORKSPACE_DOCTOR_REPORT_V1,
    workspaceId: facts.workspaceId,
    status,
    findings,
    nextAction,
  };
}
