import { createHash } from "node:crypto";
import {
  WORKSPACE_MIGRATION_PLAN_V1,
  type HistoricalMigrationErrorFinding,
  type HistoricalMigrationFacts,
  type HistoricalMigrationFinding,
  type HistoricalMigrationInfoFinding,
  type HistoricalMigrationMapping,
  type HistoricalMigrationPlan,
  type HistoricalRollEntry,
  type HistoricalRollOwnership,
  type RepositoryCutoverEntry,
} from "@roll/spec";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort(compareText);
}

function storySuffix(path: string, storyId: string): string {
  const parts = path.split("/");
  const storyIndex = parts.indexOf(storyId);
  if (storyIndex < 0) return path;
  const suffix = parts.slice(storyIndex + 1).join("/");
  return suffix === "" ? "artifact" : suffix;
}

function mappingFor(entry: Extract<HistoricalRollEntry, { kind: "file" }>, ownership: HistoricalRollOwnership): HistoricalMigrationMapping {
  const preserve = ownership.kind === "independent_git" ? "copy_preserve" : "move_preserve";
  if (entry.sourceClass === "backlog") {
    return { action: preserve, source: entry.path, destination: "backlog/index.md", digest: entry.digest, reason: "backlog_authority" };
  }
  if (entry.sourceClass === "story_contract") {
    const storyId = entry.storyId;
    return {
      action: preserve,
      source: entry.path,
      destination: `backlog/legacy/${storyId}/${storySuffix(entry.path, storyId)}`,
      digest: entry.digest,
      reason: "story_contract",
    };
  }
  if (entry.sourceClass === "story_evidence") {
    const storyId = entry.storyId;
    return {
      action: preserve,
      source: entry.path,
      destination: `issues/${storyId}/evidence/legacy/${storySuffix(entry.path, storyId)}`,
      digest: entry.digest,
      reason: "story_evidence",
    };
  }
  if (entry.sourceClass === "design") {
    return { action: preserve, source: entry.path, destination: `design/legacy/${entry.path}`, digest: entry.digest, reason: "design_with_provenance" };
  }
  if (entry.sourceClass === "requirement") {
    return { action: preserve, source: entry.path, destination: `requirements/legacy/${entry.path}`, digest: entry.digest, reason: "requirement_with_digest" };
  }
  if (entry.sourceClass === "runtime") {
    return { action: "import_inactive", source: entry.path, destination: `runtime/legacy-import/${entry.path}`, digest: entry.digest, reason: "runtime_never_reactivated" };
  }
  if (entry.sourceClass === "projection") {
    return { action: "archive_regenerate", source: entry.path, destination: `runtime/legacy-import/archive/${entry.path}`, digest: entry.digest, reason: "generated_projection" };
  }
  if (entry.sourceClass === "unknown") {
    return { action: "quarantine_unclassified", source: entry.path, destination: `runtime/legacy-import/unclassified/${entry.path}`, digest: entry.digest, reason: "unknown_surface" };
  }
  return { action: "discard_rebuildable", source: entry.path, destination: null, digest: entry.digest, reason: "explicit_rebuildable_cache" };
}

function mappingsFor(facts: HistoricalMigrationFacts): readonly HistoricalMigrationMapping[] {
  return facts.rollInventory
    .filter((entry): entry is Extract<HistoricalRollEntry, { kind: "file" }> => entry.kind === "file")
    .sort((left, right) => compareText(left.path, right.path))
    .map((entry) => mappingFor(entry, facts.rollOwnership));
}

function error(code: HistoricalMigrationErrorFinding["code"], path?: string): HistoricalMigrationErrorFinding {
  return { severity: "error", code, ...(path === undefined ? {} : { path }) };
}

function errorsFor(facts: HistoricalMigrationFacts, workspaceId: string, expectedCachePath: string): readonly HistoricalMigrationErrorFinding[] {
  const findings: HistoricalMigrationErrorFinding[] = [];
  if (facts.git.state === "dirty") findings.push(error("product_dirty", sorted(facts.git.dirtyPaths)[0]));
  if (facts.git.state === "in_flight" || facts.git.operation !== "none") findings.push(error("product_operation_in_flight", facts.git.operation));
  if (facts.git.remote.kind === "blocked") findings.push(error(facts.git.remote.code));
  for (const worktree of [...facts.linkedWorktrees].sort((left, right) => compareText(left.pathToken, right.pathToken))) {
    if (worktree.state !== "clean") findings.push(error("linked_worktree_unsafe", worktree.pathToken));
  }
  for (const submodule of [...facts.submodules].sort((left, right) => compareText(left.path, right.path))) {
    if (submodule.state !== "clean" || submodule.remote === null || submodule.remote.kind !== "verified") {
      findings.push(error("submodule_unsafe", submodule.path));
    }
  }
  for (const cycleId of sorted(facts.runtime.activeCycleIds)) findings.push(error("active_runtime", `cycle:${cycleId}`));
  for (const storyId of sorted(facts.runtime.activeStoryLeases)) findings.push(error("active_runtime", `story:${storyId}`));
  for (const entry of [...facts.rollInventory].sort((left, right) => compareText(left.path, right.path))) {
    if (entry.kind === "symlink") findings.push(error("roll_symlink_unsupported", entry.path));
  }
  if (
    facts.cache.status === "conflict" || facts.cache.repoId !== facts.repoId ||
    facts.cache.cachePath !== expectedCachePath
  ) {
    findings.push(error("cache_conflict", facts.cache.cachePath));
  }
  if (
    facts.registry.status === "id_conflict" || facts.registry.status === "repo_conflict" ||
    facts.registry.workspaceId !== workspaceId
  ) {
    findings.push(error("workspace_conflict", facts.registry.workspaceId));
  }
  return findings;
}

function infoFor(facts: HistoricalMigrationFacts, expectedCachePath: string): readonly HistoricalMigrationInfoFinding[] {
  const findings: HistoricalMigrationInfoFinding[] = [];
  if (facts.requestedWorkspaceId === undefined) findings.push({ severity: "info", code: "workspace_id_defaulted" });
  if (facts.cache.status === "absent" && facts.cache.repoId === facts.repoId && facts.cache.cachePath === expectedCachePath) {
    findings.push({ severity: "info", code: "cache_create_planned", path: expectedCachePath });
  }
  return findings;
}

function normalizedOwnership(ownership: HistoricalRollOwnership): unknown {
  if (ownership.kind === "ordinary") return { kind: ownership.kind };
  if (ownership.kind === "product_tracked") return { kind: ownership.kind, trackedPaths: sorted(ownership.trackedPaths) };
  return {
    kind: ownership.kind,
    state: ownership.state,
    head: ownership.head,
    branch: ownership.branch,
    upstream: ownership.upstream,
    normalizedRemote: ownership.normalizedRemote,
  };
}

function normalizedRemote(remote: HistoricalMigrationFacts["git"]["remote"]): unknown {
  if (remote.kind === "verified") {
    return {
      kind: remote.kind,
      normalizedRemote: remote.normalizedRemote,
      defaultBranch: remote.defaultBranch,
      defaultTip: remote.defaultTip,
      headReachable: remote.headReachable,
      defaultTipPresentLocally: remote.defaultTipPresentLocally,
    };
  }
  return {
    kind: remote.kind,
    code: remote.code,
    normalizedRemote: remote.normalizedRemote ?? null,
    defaultBranch: remote.defaultBranch ?? null,
    defaultTip: remote.defaultTip ?? null,
  };
}

function identityPayload(
  facts: HistoricalMigrationFacts,
  workspaceId: string,
  repository: HistoricalMigrationPlan["repository"],
  mappings: readonly HistoricalMigrationMapping[],
  findings: readonly HistoricalMigrationFinding[],
  verdict: HistoricalMigrationPlan["verdict"],
  extra: unknown,
): string {
  const inventory = [...facts.rollInventory]
    .sort((left, right) => compareText(left.path, right.path))
    .map((entry) => entry.kind === "symlink"
      ? { kind: entry.kind, path: entry.path }
      : {
          kind: entry.kind,
          path: entry.path,
          digest: entry.digest,
          bytes: entry.bytes,
          sourceClass: entry.sourceClass,
          storyId: entry.storyId ?? null,
        });
  return JSON.stringify({
    workspaceId,
    repoId: facts.repoId,
    git: {
      head: facts.git.head,
      state: facts.git.state,
      dirtyPaths: sorted(facts.git.dirtyPaths),
      operation: facts.git.operation,
      remote: normalizedRemote(facts.git.remote),
    },
    linkedWorktrees: [...facts.linkedWorktrees]
      .sort((left, right) => compareText(left.pathToken, right.pathToken))
      .map((item) => ({ pathToken: item.pathToken, head: item.head, state: item.state })),
    submodules: [...facts.submodules]
      .sort((left, right) => compareText(left.path, right.path))
      .map((item) => ({
        path: item.path,
        head: item.head,
        state: item.state,
        remote: item.remote === null ? null : normalizedRemote(item.remote),
      })),
    runtime: {
      activeCycleIds: sorted(facts.runtime.activeCycleIds),
      activeStoryLeases: sorted(facts.runtime.activeStoryLeases),
    },
    rollOwnership: normalizedOwnership(facts.rollOwnership),
    rollInventory: inventory,
    cache: { status: facts.cache.status, repoId: facts.cache.repoId, cachePath: facts.cache.cachePath },
    registry: { status: facts.registry.status, workspaceId: facts.registry.workspaceId },
    repository,
    mappings,
    findings,
    verdict,
    extra,
  });
}

function planId(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function repositoryCutoverEntries(facts: HistoricalMigrationFacts): readonly RepositoryCutoverEntry[] {
  if (facts.rollOwnership.kind !== "product_tracked") return [];
  const inventory = new Map(
    facts.rollInventory
      .filter((entry): entry is Extract<HistoricalRollEntry, { kind: "file" }> => entry.kind === "file")
      .map((entry) => [entry.path, entry.digest]),
  );
  return sorted(facts.rollOwnership.trackedPaths).map((path) => ({ path, digest: inventory.get(path) ?? "" }));
}

/** Pure, exhaustive historical single-repository facts to standard Workspace plan. */
export function planHistoricalWorkspaceMigration(facts: HistoricalMigrationFacts): HistoricalMigrationPlan {
  const workspaceId = facts.requestedWorkspaceId ?? `ws-${facts.repoId.slice("repo-".length)}`;
  const workspaceRoot = `workspaces/${workspaceId}`;
  const expectedCachePath = `repos/${facts.repoId}.git`;
  const integrationBranch = facts.git.remote.kind === "verified" ? facts.git.remote.defaultBranch : undefined;
  const repository = {
    alias: "primary" as const,
    repoId: facts.repoId,
    ...(integrationBranch === undefined ? {} : { integrationBranch }),
    cachePath: expectedCachePath,
  };
  const mappings = mappingsFor(facts);
  const errors = errorsFor(facts, workspaceId, expectedCachePath);
  const infos = infoFor(facts, expectedCachePath);
  if (errors.length > 0) {
    const findings = [errors[0] as HistoricalMigrationErrorFinding, ...errors.slice(1), ...infos] as const;
    const verdict = "migration_blocked" as const;
    const id = planId(identityPayload(facts, workspaceId, repository, mappings, findings, verdict, null));
    return { schema: WORKSPACE_MIGRATION_PLAN_V1, planId: id, verdict, workspaceId, workspaceRoot, repository, mappings, findings };
  }
  if (integrationBranch === undefined) throw new Error("migration_verified_remote_branch_missing");
  const readyRepository = { ...repository, integrationBranch };
  if (facts.rollOwnership.kind === "product_tracked") {
    const repositoryCutover = {
      sourceHead: facts.git.head,
      trackedEntries: repositoryCutoverEntries(facts),
      requiredAction: "remove_product_tracking_through_existing_tcr_pr_push_flow" as const,
    };
    const verdict = "repository_cutover_required" as const;
    const id = planId(identityPayload(facts, workspaceId, readyRepository, mappings, infos, verdict, repositoryCutover));
    return {
      schema: WORKSPACE_MIGRATION_PLAN_V1,
      planId: id,
      verdict,
      workspaceId,
      workspaceRoot,
      repository: readyRepository,
      mappings,
      findings: infos,
      repositoryCutover,
    };
  }
  if (facts.rollOwnership.kind === "independent_git") {
    const manualHandoff = {
      gitdirToken: facts.rollOwnership.gitdirToken,
      topLevelToken: facts.rollOwnership.topLevelToken,
      state: facts.rollOwnership.state,
      head: facts.rollOwnership.head,
      branch: facts.rollOwnership.branch,
      upstream: facts.rollOwnership.upstream,
      normalizedRemote: facts.rollOwnership.normalizedRemote,
    };
    const verdict = "manual_metadata_handoff" as const;
    const identityHandoff = { ...manualHandoff, gitdirToken: null, topLevelToken: null };
    const id = planId(identityPayload(facts, workspaceId, readyRepository, mappings, infos, verdict, identityHandoff));
    return {
      schema: WORKSPACE_MIGRATION_PLAN_V1,
      planId: id,
      verdict,
      workspaceId,
      workspaceRoot,
      repository: readyRepository,
      mappings,
      findings: infos,
      manualHandoff,
    };
  }
  const verdict = "ready" as const;
  const id = planId(identityPayload(facts, workspaceId, readyRepository, mappings, infos, verdict, null));
  return {
    schema: WORKSPACE_MIGRATION_PLAN_V1,
    planId: id,
    verdict,
    workspaceId,
    workspaceRoot,
    repository: readyRepository,
    mappings,
    findings: infos,
  };
}
