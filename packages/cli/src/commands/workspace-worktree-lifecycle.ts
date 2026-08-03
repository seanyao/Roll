import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_BRANCH_CANARY_MAX,
  deriveIssueCompletion,
  isHumanSoftLeaseActive,
  isLeaseAlive,
  readLeases,
} from "@roll/core";
import {
  readIssueCompletionEvidence,
  readRepositoryBoundFacts,
  readWorkspace,
  resolveRepositoryCacheIdentity,
  withRepositoryCacheLock,
  WorkspaceRegistry,
  type InspectedWorkspace,
  type IssueCompletionEvidenceCollection,
  type PinnedTargetFacts,
} from "@roll/infra";
import {
  parseIssueManifest,
  type IssueManifest,
  type RepositoryBinding,
  type WorkspaceManifest,
} from "@roll/spec";
import {
  auditWorktrees,
  type WorktreeAuditDeps,
  type WorktreeAuditOutput,
  type WorktreeAuditRecord,
  type WorkspaceDeliveryProof,
  type WorkspaceWorktreeOwnership,
} from "./worktree-audit.js";
import {
  emitBacklogTargetError,
  resolveBacklogCommandTarget,
  type BacklogTargetDecision,
} from "./backlog-target.js";
import { workspaceRollHome } from "./workspace-target.js";
import { canonicalWorkspaceSelectorIndex } from "../lib/workspace-selector.js";
import {
  applyWorktreeCleanup,
  buildStandaloneBranchDeps,
  planWorktreeCleanup,
  renderPlanHuman,
  renderResultHuman,
  resolveStandaloneMergedBranches,
  type CleanupBranchCandidate,
  type CleanupCandidate,
  type StandaloneBranchDeps,
  type WorktreeCleanupPlan,
  type WorktreeCleanupResult,
} from "./worktree-cleanup.js";

export interface WorkspaceWorktreeAuditInput {
  readonly selectedWorkspaceId: string;
  readonly selectedWorkspaceRoot: string;
  readonly rollHome: string;
}

export interface WorkspaceCacheIdentity {
  readonly repoId: string;
  readonly cachePath: string;
  readonly integrationBranch: string;
}

export interface WorkspaceCountedBranch {
  readonly repoId: string;
  readonly cachePath: string;
  readonly branch: string;
}

export interface WorkspaceWorktreeAuditOutput {
  readonly schema: 1;
  readonly generatedAt: string;
  readonly selectedWorkspaceId: string;
  readonly records: readonly WorktreeAuditRecord[];
  readonly ephemeralBranches: readonly WorkspaceCountedBranch[];
  readonly repositories: readonly WorkspaceCacheIdentity[];
  readonly summary: {
    readonly worktrees: number;
    readonly active: number;
    readonly disposableCandidates: number;
    readonly preserved: number;
    readonly ephemeralBranches: number;
    readonly canaryTotal: number;
  };
}

export interface WorkspaceWorktreeLifecycleDeps {
  readonly inspectWorkspaces: () => readonly InspectedWorkspace[];
  readonly readWorkspace: (root: string) => WorkspaceManifest;
  readonly listIssueIds: (root: string) => readonly string[];
  readonly readIssueManifest: (issueRoot: string) => IssueManifest;
  readonly readRepositoryBoundFacts: (issueRoot: string) => ReadonlyMap<string, PinnedTargetFacts>;
  readonly readIssueCompletionEvidence: (issueRoot: string) => IssueCompletionEvidenceCollection;
  readonly storyActive: (workspaceRoot: string, storyId: string) => boolean;
  readonly resolveCache: (binding: RepositoryBinding) => WorkspaceCacheIdentity;
  readonly auditRepository: (deps: WorktreeAuditDeps) => WorktreeAuditOutput;
  readonly nowISO: () => string;
}

export interface WorkspaceWorktreeAuditCommandDeps {
  readonly resolveTarget: (args: readonly string[]) => BacklogTargetDecision;
  readonly rollHome: () => string;
  readonly auditWorkspace: typeof auditWorkspaceWorktrees;
}

export interface WorkspaceWorktreeCleanupCommandDeps {
  readonly resolveTarget: (args: readonly string[]) => BacklogTargetDecision;
  readonly rollHome: () => string;
  readonly threshold: () => number;
  readonly auditWorkspace: typeof auditWorkspaceWorktrees;
  readonly resolveStandaloneBranches: typeof resolveWorkspaceStandaloneMergedBranches;
  readonly freshBranchDeps: typeof freshWorkspaceStandaloneBranchDeps;
  readonly readSelectedWorkspace: (root: string) => WorkspaceManifest;
  readonly withRepositoryLock?: ApplyWorkspaceWorktreeCleanupOptions["withRepositoryLock"];
  readonly removeWorktree?: ApplyWorkspaceWorktreeCleanupOptions["removeWorktree"];
  readonly removeBranch?: ApplyWorkspaceWorktreeCleanupOptions["removeBranch"];
  readonly nowMs?: () => number;
}

export interface ApplyWorkspaceWorktreeCleanupOptions {
  readonly selectedWorkspaceId: string;
  readonly dryRun?: boolean;
  readonly auditWorkspace: () => WorkspaceWorktreeAuditOutput;
  readonly withRepositoryLock: <T>(candidate: CleanupCandidate | CleanupBranchCandidate, action: () => Promise<T>) => Promise<T>;
  readonly removeWorktree?: (repositoryRoot: string, path: string) => { ok: boolean; detail: string };
  readonly freshBranchDeps?: (candidate: CleanupBranchCandidate) => StandaloneBranchDeps | undefined;
  readonly removeBranch?: (repositoryRoot: string, branch: string, expectedSha: string) => { ok: boolean; detail: string };
  readonly nowMs?: () => number;
}

function listIssueIds(root: string): readonly string[] {
  const issuesRoot = join(root, "issues");
  try {
    return readdirSync(issuesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function readIssueManifest(issueRoot: string): IssueManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(issueRoot, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(`invalid_issue_manifest: ${issueRoot}`, { cause: error });
  }
  const parsed = parseIssueManifest(raw);
  if (!parsed.ok) {
    throw new Error(`invalid_issue_manifest: ${issueRoot}`);
  }
  return parsed.value;
}

function storyActive(workspaceRoot: string, storyId: string): boolean {
  const lease = readLeases(join(workspaceRoot, "runtime", "locks", "leases"))[storyId];
  if (lease === undefined) return false;
  if (lease.source === "cycle") return isLeaseAlive(lease);
  return isHumanSoftLeaseActive(lease, Date.now());
}

function realDeps(rollHome: string): WorkspaceWorktreeLifecycleDeps {
  return {
    inspectWorkspaces: () => new WorkspaceRegistry({ rollHome }).inspect(),
    readWorkspace,
    listIssueIds,
    readIssueManifest,
    readRepositoryBoundFacts,
    readIssueCompletionEvidence,
    storyActive,
    resolveCache: (binding) => {
      const identity = resolveRepositoryCacheIdentity({ rollHome, binding });
      return {
        repoId: identity.repoId,
        cachePath: identity.cachePath,
        integrationBranch: identity.integrationBranch,
      };
    },
    auditRepository: auditWorktrees,
    nowISO: () => new Date().toISOString(),
  };
}

function deliveryProof(
  manifest: IssueManifest,
  evidence: IssueCompletionEvidenceCollection,
): WorkspaceDeliveryProof {
  const projection = deriveIssueCompletion({
    workspaceId: manifest.workspaceId,
    storyId: manifest.storyId,
    repositories: manifest.repositories.map((repository) => ({
      repoId: repository.repoId,
      required: repository.requiredDelivery,
    })),
    repositoryFacts: evidence.repositoryFacts,
    integrationAcceptances: evidence.integrationAcceptances,
    backlogDone: false,
  });
  if (projection.state === "delivered") return "delivered";
  if (projection.state === "abandoned") return "abandoned";
  if (projection.state === "blocked") return "blocked";
  return "incomplete";
}

function ownershipForFact(
  workspaceRoot: string,
  manifest: IssueManifest,
  target: IssueManifest["repositories"][number],
  fact: PinnedTargetFacts,
  cache: WorkspaceCacheIdentity,
  proof: WorkspaceDeliveryProof,
  active: boolean,
): WorkspaceWorktreeOwnership {
  if (
    fact.workspaceId !== manifest.workspaceId ||
    fact.storyId !== manifest.storyId ||
    fact.repoId !== target.repoId ||
    fact.access !== target.access
  ) {
    throw new Error(`workspace_worktree_identity_mismatch: ${manifest.workspaceId}/${manifest.storyId}/${target.alias}`);
  }
  const expectedPrefix = resolve(workspaceRoot, "issues", manifest.storyId);
  const expectedPath = resolve(expectedPrefix, target.alias);
  const factPath = resolve(fact.path);
  if (factPath !== expectedPath) {
    throw new Error(`workspace_worktree_path_mismatch: ${manifest.workspaceId}/${manifest.storyId}/${target.alias}`);
  }
  if (existsSync(factPath)) {
    const canonicalExpected = resolve(realpathSync(workspaceRoot), "issues", manifest.storyId, target.alias);
    if (realpathSync(factPath) !== canonicalExpected) {
      throw new Error(`workspace_worktree_path_mismatch: ${manifest.workspaceId}/${manifest.storyId}/${target.alias}`);
    }
  }
  return {
    workspaceId: manifest.workspaceId,
    storyId: manifest.storyId,
    repoId: target.repoId,
    repositoryAlias: target.alias,
    cachePath: cache.cachePath,
    expectedBranch: fact.workBranch,
    active,
    deliveryProof: proof,
  };
}

/** Aggregate the existing repository audit over the selected Workspace's unique
 * cache set. Other registered Workspaces are inspected only to identify their
 * exact Issue-owned paths on those same caches, so cleanup/canary can preserve
 * cross-Workspace legs and never mistake them for unrelated path names. */
export function auditWorkspaceWorktrees(
  input: WorkspaceWorktreeAuditInput,
  overrides: Partial<WorkspaceWorktreeLifecycleDeps> = {},
): WorkspaceWorktreeAuditOutput {
  const defaults = realDeps(input.rollHome);
  const deps: WorkspaceWorktreeLifecycleDeps = { ...defaults, ...overrides };
  const inspected = deps.inspectWorkspaces();
  const selected = inspected.find((entry) =>
    entry.workspaceId === input.selectedWorkspaceId && entry.consistency === "consistent"
  );
  if (selected === undefined || resolve(selected.root) !== resolve(input.selectedWorkspaceRoot)) {
    throw new Error(`workspace_target_mismatch: ${input.selectedWorkspaceId}`);
  }
  const selectedManifest = deps.readWorkspace(selected.root);
  if (selectedManifest.workspaceId !== selected.workspaceId) {
    throw new Error(`workspace_manifest_mismatch: ${selected.workspaceId}`);
  }

  const caches = new Map<string, WorkspaceCacheIdentity>();
  for (const binding of selectedManifest.repositories) {
    const cache = deps.resolveCache(binding);
    if (cache.repoId !== binding.repoId) throw new Error(`workspace_cache_identity_mismatch: ${binding.repoId}`);
    caches.set(binding.repoId, cache);
  }

  const ownershipByRepo = new Map<string, Map<string, WorkspaceWorktreeOwnership>>();
  for (const workspace of inspected) {
    if (workspace.consistency !== "consistent") continue;
    const manifest = deps.readWorkspace(workspace.root);
    if (manifest.workspaceId !== workspace.workspaceId) {
      throw new Error(`workspace_manifest_mismatch: ${workspace.workspaceId}`);
    }
    for (const storyId of deps.listIssueIds(workspace.root)) {
      const issueRoot = join(workspace.root, "issues", storyId);
      if (!existsSync(join(issueRoot, "manifest.json")) && overrides.readIssueManifest === undefined) continue;
      const issue = deps.readIssueManifest(issueRoot);
      if (issue.workspaceId !== workspace.workspaceId || issue.storyId !== storyId) {
        throw new Error(`workspace_issue_identity_mismatch: ${workspace.workspaceId}/${storyId}`);
      }
      const relevantTargets = issue.repositories.filter((target) => caches.has(target.repoId));
      if (relevantTargets.length === 0) continue;
      const facts = deps.readRepositoryBoundFacts(issueRoot);
      const proof = deliveryProof(issue, deps.readIssueCompletionEvidence(issueRoot));
      const active = deps.storyActive(workspace.root, storyId);
      for (const target of relevantTargets) {
        const fact = facts.get(target.alias);
        if (fact === undefined) continue;
        const cache = caches.get(target.repoId);
        if (cache === undefined) continue;
        const ownership = ownershipForFact(workspace.root, issue, target, fact, cache, proof, active);
        const byPath = ownershipByRepo.get(target.repoId) ?? new Map<string, WorkspaceWorktreeOwnership>();
        const path = resolve(fact.path);
        const existing = byPath.get(path);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(ownership)) {
          throw new Error(`workspace_worktree_ownership_conflict: ${path}`);
        }
        byPath.set(path, ownership);
        ownershipByRepo.set(target.repoId, byPath);
      }
    }
  }

  const records: WorktreeAuditRecord[] = [];
  const branches: WorkspaceCountedBranch[] = [];
  const repositories = [...caches.values()].sort((left, right) => left.repoId.localeCompare(right.repoId));
  for (const cache of repositories) {
    const audit = deps.auditRepository({
      repoRoot: cache.cachePath,
      home: "",
      integrationBranch: `origin/${cache.integrationBranch}`,
      workspaceOwnership: ownershipByRepo.get(cache.repoId) ?? new Map(),
      nowISO: deps.nowISO,
    });
    records.push(...audit.records.filter((record) => record.owner === "workspace"));
    for (const branch of audit.ephemeralBranches) {
      branches.push({ repoId: cache.repoId, cachePath: cache.cachePath, branch });
    }
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  branches.sort((left, right) => left.repoId.localeCompare(right.repoId) || left.branch.localeCompare(right.branch));

  const summary = {
    worktrees: records.length,
    active: records.filter((record) => record.active).length,
    disposableCandidates: records.filter((record) => record.disposition === "disposable_candidate").length,
    preserved: records.filter((record) => record.disposition !== "disposable_candidate").length,
    ephemeralBranches: branches.length,
    canaryTotal: records.length + branches.length,
  };
  return {
    schema: 1,
    generatedAt: deps.nowISO(),
    selectedWorkspaceId: input.selectedWorkspaceId,
    records,
    ephemeralBranches: branches,
    repositories,
    summary,
  };
}

function repositoryAudit(
  audit: WorkspaceWorktreeAuditOutput,
  repoId?: string,
): WorktreeAuditOutput {
  const records = repoId === undefined
    ? [...audit.records]
    : audit.records.filter((record) => record.repoId === repoId);
  const branches = audit.ephemeralBranches
    .filter((branch) => repoId === undefined || branch.repoId === repoId)
    .map((branch) => repoId === undefined ? `${branch.repoId}:${branch.branch}` : branch.branch);
  return {
    schema: 1,
    generatedAt: audit.generatedAt,
    repo: `workspace:${audit.selectedWorkspaceId}${repoId === undefined ? "" : `:${repoId}`}`,
    records,
    ephemeralBranches: branches,
    summary: {
      total: records.length,
      loop: 0,
      ...(records.length > 0 ? { workspace: records.length } : {}),
      manual: 0,
      external: 0,
      active: records.filter((record) => record.active).length,
      disposableCandidates: records.filter((record) => record.disposition === "disposable_candidate").length,
      preserved: records.filter((record) => record.disposition !== "disposable_candidate").length,
      ephemeralBranches: branches.length,
    },
  };
}

export function resolveWorkspaceStandaloneMergedBranches(
  audit: WorkspaceWorktreeAuditOutput,
): readonly CleanupBranchCandidate[] {
  return audit.repositories.flatMap((repository) => {
    const scopedAudit = repositoryAudit(audit, repository.repoId);
    return resolveStandaloneMergedBranches(
      scopedAudit,
      buildStandaloneBranchDeps(
        repository.cachePath,
        scopedAudit,
        `origin/${repository.integrationBranch}`,
      ),
    ).map((candidate) => ({
      ...candidate,
      workspaceId: audit.selectedWorkspaceId,
      repoId: repository.repoId,
      cachePath: repository.cachePath,
    }));
  });
}

export function freshWorkspaceStandaloneBranchDeps(
  audit: WorkspaceWorktreeAuditOutput,
  candidate: CleanupBranchCandidate,
): StandaloneBranchDeps | undefined {
  if (candidate.repoId === undefined || candidate.cachePath === undefined) return undefined;
  const repository = audit.repositories.find((item) => item.repoId === candidate.repoId);
  if (repository === undefined || repository.cachePath !== candidate.cachePath) return undefined;
  const scopedAudit = repositoryAudit(audit, repository.repoId);
  return buildStandaloneBranchDeps(
    repository.cachePath,
    scopedAudit,
    `origin/${repository.integrationBranch}`,
  );
}

export function planWorkspaceWorktreeCleanup(
  audit: WorkspaceWorktreeAuditOutput,
  threshold: number,
  standaloneBranches: readonly CleanupBranchCandidate[] = [],
): WorktreeCleanupPlan {
  return planWorktreeCleanup(
    repositoryAudit(audit),
    threshold,
    standaloneBranches,
    { workspaceId: audit.selectedWorkspaceId },
  );
}

export async function applyWorkspaceWorktreeCleanup(
  plan: WorktreeCleanupPlan,
  options: ApplyWorkspaceWorktreeCleanupOptions,
): Promise<WorktreeCleanupResult> {
  const removed: WorktreeCleanupResult["removed"] = [];
  const branchesRemoved: WorktreeCleanupResult["branchesRemoved"] = [];
  const refused: WorktreeCleanupResult["refused"] = [];

  for (const candidate of plan.candidates) {
    if (
      candidate.workspaceId !== options.selectedWorkspaceId ||
      candidate.repoId === undefined ||
      candidate.cachePath === undefined
    ) {
      refused.push({ path: candidate.path, reason: "identity: cleanup candidate is outside the selected Workspace" });
      continue;
    }
    const result = await options.withRepositoryLock(candidate, async () => {
      const oneCandidatePlan: WorktreeCleanupPlan = {
        ...plan,
        candidates: [candidate],
        branchCandidates: [],
        preserved: [],
      };
      return applyWorktreeCleanup(oneCandidatePlan, {
        repositoryRoot: candidate.cachePath as string,
        dryRun: options.dryRun === true,
        audit: () => repositoryAudit(options.auditWorkspace(), candidate.repoId),
        ...(options.removeWorktree === undefined ? {} : { removeWorktree: options.removeWorktree }),
        ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      });
    });
    removed.push(...result.removed);
    branchesRemoved.push(...result.branchesRemoved);
    refused.push(...result.refused);
  }

  for (const candidate of plan.branchCandidates) {
    if (
      candidate.workspaceId !== options.selectedWorkspaceId ||
      candidate.repoId === undefined ||
      candidate.cachePath === undefined
    ) {
      refused.push({
        path: `branch:${candidate.branch}`,
        reason: "identity: cleanup branch candidate is outside the selected Workspace",
      });
      continue;
    }
    const cachePath = candidate.cachePath;
    const resolveFreshBranchDeps = options.freshBranchDeps;
    const result = await options.withRepositoryLock(candidate, async () => {
      const freshBranchDeps = resolveFreshBranchDeps?.(candidate);
      const oneCandidatePlan: WorktreeCleanupPlan = {
        ...plan,
        candidates: [],
        branchCandidates: [candidate],
        preserved: [],
      };
      return applyWorktreeCleanup(oneCandidatePlan, {
        repositoryRoot: cachePath,
        dryRun: options.dryRun === true,
        ...(freshBranchDeps === undefined ? {} : { freshBranchDeps: () => freshBranchDeps }),
        ...(options.removeBranch === undefined ? {} : { removeBranch: options.removeBranch }),
        ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      });
    });
    branchesRemoved.push(...result.branchesRemoved);
    refused.push(...result.refused);
  }

  return {
    schema: 1,
    dryRun: options.dryRun === true,
    removed,
    branchesRemoved,
    refused,
    preserved: [...plan.preserved],
  };
}

function renderWorkspaceAudit(output: WorkspaceWorktreeAuditOutput): string {
  const lines = [
    "Workspace worktree audit",
    "",
    `  workspace: ${output.selectedWorkspaceId}`,
    `  worktrees: ${output.summary.worktrees}`,
    `  active: ${output.summary.active}`,
    `  disposable candidates: ${output.summary.disposableCandidates}`,
    `  preserved: ${output.summary.preserved}`,
    `  ephemeral branches: ${output.summary.ephemeralBranches}`,
    `  canary total: ${output.summary.canaryTotal}`,
    "",
  ];
  for (const record of output.records) {
    lines.push(`${record.disposition}`);
    lines.push(`  ${record.workspaceId}/${record.storyId}/${record.repoId} (${record.repositoryAlias})`);
    lines.push(`  path: ${record.path}`);
    lines.push(`  branch: ${record.branch ?? "<detached>"}`);
    lines.push(`  HEAD: ${record.head ?? "<unknown>"}`);
    lines.push(`  active: ${record.active ? "yes" : "no"}`);
    lines.push(`  delivery: ${record.deliveryProof ?? "unknown"}`);
    lines.push(`  reason: ${record.reason}`);
    lines.push("");
  }
  if (output.ephemeralBranches.length > 0) {
    lines.push("ephemeral branches (canary-counted)");
    for (const branch of output.ephemeralBranches) {
      lines.push(`  ${branch.repoId}:${branch.branch}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function realCommandDeps(): WorkspaceWorktreeAuditCommandDeps {
  return {
    resolveTarget: (args) => resolveBacklogCommandTarget(args, "read"),
    rollHome: workspaceRollHome,
    auditWorkspace: auditWorkspaceWorktrees,
  };
}

export function workspaceWorktreeAuditCommand(
  args: readonly string[],
  overrides: Partial<WorkspaceWorktreeAuditCommandDeps> = {},
): number {
  if (args.includes("--repo")) {
    process.stderr.write("roll worktree audit: --repo and --workspace are mutually exclusive.\n");
    return 2;
  }
  const workspaceIndex = canonicalWorkspaceSelectorIndex(args);
  if (workspaceIndex >= 0 && (args[workspaceIndex + 1] ?? "") === "") {
    process.stderr.write("roll worktree audit: --workspace requires <id|path>.\n");
    return 2;
  }
  const deps = { ...realCommandDeps(), ...overrides };
  const decision = deps.resolveTarget(args);
  if (!decision.ok) return emitBacklogTargetError(decision);
  if ("aggregate" in decision) {
    process.stderr.write("roll worktree audit: --all is not supported; select one Workspace.\n");
    return 2;
  }
  const output = deps.auditWorkspace({
    selectedWorkspaceId: decision.workspaceId,
    selectedWorkspaceRoot: decision.workspaceRoot,
    rollHome: deps.rollHome(),
  });
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(renderWorkspaceAudit(output));
  return 0;
}

function cleanupThreshold(): number {
  const parsed = Number.parseInt(process.env["ROLL_BRANCH_CANARY_MAX"] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRANCH_CANARY_MAX;
}

function realCleanupCommandDeps(): WorkspaceWorktreeCleanupCommandDeps {
  return {
    resolveTarget: (args) => resolveBacklogCommandTarget(args, "mutation"),
    rollHome: workspaceRollHome,
    threshold: cleanupThreshold,
    auditWorkspace: auditWorkspaceWorktrees,
    resolveStandaloneBranches: resolveWorkspaceStandaloneMergedBranches,
    freshBranchDeps: freshWorkspaceStandaloneBranchDeps,
    readSelectedWorkspace: readWorkspace,
  };
}

export async function workspaceWorktreeCleanupCommand(
  args: readonly string[],
  overrides: Partial<WorkspaceWorktreeCleanupCommandDeps> = {},
): Promise<number> {
  if (args.includes("--repo")) {
    process.stderr.write("roll worktree cleanup: --repo and --workspace are mutually exclusive.\n");
    return 2;
  }
  const workspaceIndex = canonicalWorkspaceSelectorIndex(args);
  if (workspaceIndex >= 0 && (args[workspaceIndex + 1] ?? "") === "") {
    process.stderr.write("roll worktree cleanup: --workspace requires <id|path>.\n");
    return 2;
  }
  if (args.includes("--apply") && args.includes("--dry-run")) {
    process.stderr.write("roll worktree cleanup: --apply and --dry-run are mutually exclusive.\n");
    return 2;
  }
  if (args.includes("--reclaim-orphan")) {
    process.stderr.write("roll worktree cleanup: Workspace mode never reclaims unregistered orphan directories.\n");
    return 2;
  }

  const deps = { ...realCleanupCommandDeps(), ...overrides };
  const decision = deps.resolveTarget(args);
  if (!decision.ok) return emitBacklogTargetError(decision);
  if ("aggregate" in decision) {
    process.stderr.write("roll worktree cleanup: --all is not supported; select one Workspace.\n");
    return 2;
  }
  const auditInput: WorkspaceWorktreeAuditInput = {
    selectedWorkspaceId: decision.workspaceId,
    selectedWorkspaceRoot: decision.workspaceRoot,
    rollHome: deps.rollHome(),
  };
  const auditNow = deps.auditWorkspace(auditInput);
  const plan = planWorkspaceWorktreeCleanup(
    auditNow,
    deps.threshold(),
    deps.resolveStandaloneBranches(auditNow),
  );
  const json = args.includes("--json");
  if (!args.includes("--apply")) {
    if (json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else process.stdout.write(renderPlanHuman(plan, "dry-run", "workspace"));
    return 0;
  }

  const selectedManifest = deps.readSelectedWorkspace(decision.workspaceRoot);
  const bindingByRepo = new Map(selectedManifest.repositories.map((binding) => [binding.repoId, binding]));
  const withLock = deps.withRepositoryLock ?? (async <T>(
    candidate: CleanupCandidate | CleanupBranchCandidate,
    action: () => Promise<T>,
  ): Promise<T> => {
    const binding = candidate.repoId === undefined ? undefined : bindingByRepo.get(candidate.repoId);
    if (binding === undefined) throw new Error(`workspace_cleanup_binding_missing: ${candidate.repoId ?? "unknown"}`);
    return withRepositoryCacheLock({ rollHome: deps.rollHome(), binding }, action);
  });
  const result = await applyWorkspaceWorktreeCleanup(plan, {
    selectedWorkspaceId: decision.workspaceId,
    auditWorkspace: () => deps.auditWorkspace(auditInput),
    withRepositoryLock: withLock,
    freshBranchDeps: (candidate) => deps.freshBranchDeps(deps.auditWorkspace(auditInput), candidate),
    ...(deps.removeWorktree === undefined ? {} : { removeWorktree: deps.removeWorktree }),
    ...(deps.removeBranch === undefined ? {} : { removeBranch: deps.removeBranch }),
    ...(deps.nowMs === undefined ? {} : { nowMs: deps.nowMs }),
  });
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderResultHuman(result));
  const anyRemoved = result.removed.length > 0 || result.branchesRemoved.length > 0;
  return !anyRemoved && result.refused.length > 0 ? 1 : 0;
}
