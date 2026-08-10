/**
 * @responsibility Projects cycle role attempts into renderable execution-cast rows.
 */
import {
  type CycleRoleAttempt,
  type CycleRoleAttemptState,
  type CycleRoleName,
  type CycleRoleSummary,
} from "@roll/spec";

export interface ExecutionCastRow {
  readonly role: CycleRoleName;
  readonly agent: string | null;
  readonly model?: string;
  readonly state: CycleRoleAttemptState;
  readonly verdict?: string;
  readonly score?: number;
  readonly findings?: number;
  readonly cause?: string;
  readonly detail?: string;
  readonly artifactPath?: string;
  readonly logPath?: string;
  readonly acceptedByGate: boolean;
}

export interface ExecutionCastArtifactLink {
  readonly label: string;
  readonly path: string;
}

export interface ExecutionCastProjection {
  readonly builderAgent: string | null;
  readonly rows: readonly ExecutionCastRow[];
  readonly artifactLinks: readonly ExecutionCastArtifactLink[];
}

export function buildExecutionCastProjection(summary: CycleRoleSummary): ExecutionCastProjection {
  const byRole = new Map<CycleRoleName, CycleRoleAttempt[]>();
  for (const role of summary.roles) {
    const list = byRole.get(role.role) ?? [];
    list.push(role);
    byRole.set(role.role, list);
  }

  const rows: ExecutionCastRow[] = [
    ...(byRole.get("builder") ?? []).filter((r) => r.agent !== null),
    ...(byRole.get("peer_reviewer") ?? []),
    ...(byRole.get("evaluator") ?? []).filter((r) => r.state === "accepted"),
    ...(byRole.get("evaluator") ?? []).filter((r) => r.state !== "accepted"),
    ...(byRole.get("attest_gate") ?? []),
    ...(byRole.get("designer") ?? []),
  ].map((r) => ({
    role: r.role,
    agent: r.agent,
    ...(r.model !== undefined ? { model: r.model } : {}),
    state: r.state,
    ...(r.verdict !== undefined ? { verdict: r.verdict } : {}),
    ...(r.score !== undefined ? { score: r.score } : {}),
    ...(r.findings !== undefined ? { findings: r.findings } : {}),
    ...(r.cause !== undefined ? { cause: r.cause } : {}),
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
    ...(r.artifactPath !== undefined ? { artifactPath: r.artifactPath } : {}),
    ...(r.logPath !== undefined ? { logPath: r.logPath } : {}),
    acceptedByGate: r.acceptedByGate,
  }));

  const artifactLinks: ExecutionCastArtifactLink[] = [];
  for (const row of rows) {
    if (row.logPath !== undefined) addArtifactLink(artifactLinks, `builder log: ${row.agent ?? "unknown"}`, row.logPath);
    if (row.artifactPath === undefined) continue;
    if (row.role === "peer_reviewer" && row.acceptedByGate) {
      addArtifactLink(artifactLinks, `accepted peer artifact: ${row.agent ?? "unknown"}`, row.artifactPath);
    } else if (row.role === "evaluator" && row.state === "accepted") {
      addArtifactLink(artifactLinks, `accepted evaluator artifact: ${row.agent ?? "unknown"}`, row.artifactPath);
    } else if (row.state === "failed" || row.state === "rejected") {
      addArtifactLink(artifactLinks, `raw failure artifact: ${row.agent ?? row.role}`, row.artifactPath);
    } else if (row.artifactPath !== undefined && row.acceptedByGate) {
      addArtifactLink(artifactLinks, `accepted artifact: ${row.agent ?? row.role}`, row.artifactPath);
    }
  }

  return {
    builderAgent: rows.find((r) => r.role === "builder" && r.agent !== null)?.agent ?? null,
    rows,
    artifactLinks,
  };
}

function addArtifactLink(out: ExecutionCastArtifactLink[], label: string, path: string): void {
  if (path === "") return;
  if (out.some((x) => x.label === label && x.path === path)) return;
  out.push({ label, path });
}
