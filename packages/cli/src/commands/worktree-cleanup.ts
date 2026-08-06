/**
 * FIX-1273 — `roll worktree cleanup`: safe recovery for branch-canary historical
 * worktree pressure.
 *
 * The leak-safety canary counts anomalous projection members and unattached
 * ephemeral branches; managed capacity separately reports every retained member.
 * `roll worktree audit` already proves whether a worktree is a merged, clean
 * `disposable_candidate`, but offered no actionable safe cleanup, so operators
 * force-removed by hand.
 *
 * This command adds a plan/apply route whose SOLE authority is the existing
 * audit. It NEVER removes a path merely because it is old or counted by the
 * canary — a canary count is never translated into a blanket deletion.
 *
 *   - `--dry-run` (default): print the exact counted refs/dirs, their audit
 *     disposition, and the MINIMAL candidate set needed to return under the
 *     canary threshold. It never mutates git state.
 *   - `--apply`: re-run the audit immediately before EVERY removal and require
 *     the same projection run/member, registration, expected head, clean Git
 *     state, and `safe_to_release` verdict. It removes only that verified worktree
 *     through git, prunes registration, and emits structured events. A changed
 *     head, new dirt, missing path, or concurrent activation fails closed
 *     (fail-loud refusal) without substituting a preserved worktree.
 *
 * Data contract: {@link WorktreeCleanupPlan}, {@link WorktreeCleanupResult}.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_BRANCH_CANARY_MAX, EventBus } from "@roll/core";
import { resolveLang, type RollEvent, type WorktreeLifecycleEvent } from "@roll/spec";
import { releaseSkillDispatchReservation, skillDispatchActorForCwd } from "../runner/skill-dispatch-workspace.js";
import {
  auditWorktrees,
  type WorktreeAuditDeps,
  type WorktreeAuditOutput,
  type WorktreeAuditRecord,
} from "./worktree-audit.js";

// ─── data contract ───────────────────────────────────────────────────────────

/** A single audit-proven removable worktree in a cleanup plan. */
export interface CleanupCandidate {
  path: string;
  /** Projection identity revalidated before a destructive release. */
  runId: string;
  memberLocator: string;
  cycleId?: string;
  branch?: string;
  /** HEAD the audit observed; `--apply` refuses if the fresh head differs. */
  expectedHead: string;
  /** Internal plan binding; distinguishes malformed duplicate synthetic records. */
  workspaceSetId?: string;
  reason: "disposable_candidate";
}

/**
 * FIX-1454: a standalone ephemeral branch (NOT attached to any worktree) whose
 * commits are verifiably merged, so deleting the ref safely reduces the canary
 * count. Bounded exactly like a worktree candidate: audit-derived, revalidated
 * before deletion, fail-closed on any mismatch.
 */
export interface CleanupBranchCandidate {
  branch: string;
  /** Ref SHA the plan observed; `--apply` refuses if the fresh ref differs. */
  expectedSha: string;
  /**
   * How delivery was PROVEN (FIX-1458 / #1465, FIX-1471): `ancestor` = every
   * commit is reachable from integration; `patch_equivalent` = `git cherry` shows
   * every branch commit already has an equivalent patch in integration;
   * `final_tree` = the branch tip tree is byte-identical to a merge commit
   * reachable from integration (squash-merge case). A merged PR alone never
   * qualifies — squash merges leave the exact tips undelivered unless the whole
   * final tree is provably on integration.
   */
  mergeKind: "ancestor" | "patch_equivalent" | "final_tree";
}

/** A worktree the plan leaves untouched, with the audit disposition that spared it. */
export interface PreservedRecord {
  path: string;
  disposition: string;
  reason: string;
}

export interface WorktreeCleanupPlan {
  schema: 1;
  generatedAt: string;
  /** Canary threshold in force when the plan was built. */
  threshold: number;
  /** Cleanup capacity policy input: retained members plus ephemeral branches. */
  cleanupCapacityTotal: number;
  /** Structural anomalies only; this is the loop pause circuit-breaker input. */
  leakSafetyTotal: number;
  /** All projection-managed members retained by the runtime, healthy or anomalous. */
  managedCapacity: number;
  /** Canary total once the plan's candidates are removed. */
  projectedTotal: number;
  /** The exact ephemeral branches the canary counts (enumerated, not summarised). */
  countedBranches: readonly string[];
  /** Every loop worktree dir the canary counts, with its audit disposition. */
  countedWorktrees: readonly { path: string; disposition: string }[];
  /** The MINIMAL, deterministic set of worktrees needed to clear pressure. */
  candidates: readonly CleanupCandidate[];
  /** FIX-1454: MINIMAL, deterministic set of merged standalone branches to delete. */
  branchCandidates: readonly CleanupBranchCandidate[];
  /** Everything the plan will NOT remove, with the disposition that spared it. */
  preserved: readonly PreservedRecord[];
}

/** Outcome of one candidate under `applyWorktreeCleanup`. */
export interface CleanupRemoval {
  path: string;
  expectedHead: string;
  branch?: string;
  cycleId?: string;
}

export interface CleanupRefusal {
  path: string;
  reason: string;
}

/** FIX-1454: outcome of one standalone-branch deletion under apply. */
export interface BranchRemoval {
  branch: string;
  expectedSha: string;
  mergeKind: "ancestor" | "patch_equivalent" | "final_tree";
}

export interface WorktreeCleanupResult {
  schema: 1;
  dryRun: boolean;
  /** Candidates that revalidated and were removed (or WOULD be, under dry-run). */
  removed: CleanupRemoval[];
  /** FIX-1454: standalone branches that revalidated and were deleted (or WOULD be). */
  branchesRemoved: BranchRemoval[];
  /** Candidates (worktree or branch) that failed fresh revalidation — fail-loud, no substitution. */
  refused: CleanupRefusal[];
  /** The plan's preserved set, carried through verbatim (never removed). */
  preserved: PreservedRecord[];
}

// ─── planning (pure) ─────────────────────────────────────────────────────────

/** True iff `rec` satisfies EVERY safe-removal invariant on a fresh audit. */
export function isSafelyDisposable(rec: WorktreeAuditRecord): boolean {
  return (
    rec.owner === "loop" &&
    rec.active === false &&
    rec.dirtyTracked === false &&
    rec.dirtyUntracked === false &&
    rec.disposition === "disposable_candidate" &&
    rec.runId !== undefined &&
    rec.memberLocator !== undefined &&
    rec.registration === "registered" &&
    rec.releaseVerdict === "safe_to_release" &&
    typeof rec.head === "string" &&
    rec.head.length > 0
  );
}

export interface ManagedWorkspaceMeasures {
  /** Every projection-owned member currently retained by the runtime. */
  managedCapacity: number;
  /** Only anomalous members/refs; this is the leak circuit-breaker input. */
  leakSafetyTotal: number;
  anomalousWorktrees: readonly WorktreeAuditRecord[];
  anomalousBranches: readonly string[];
  healthyWorktrees: readonly WorktreeAuditRecord[];
}

function isAnomalousManagedMember(record: WorktreeAuditRecord): boolean {
  if (record.disposition === "orphan_reclaimable" || record.disposition === "preserved_orphan") return true;
  // FIX-1521: released + missing is the completed teardown state, not a leak.
  if (record.runState === "released") return record.registration !== "missing";
  if (record.registration === "missing" || record.registration === "unknown" || record.registration === "foreign") return true;
  // Pre-cutover path-classified records have no projection run state. They stay
  // readable, but cannot be mistaken for a healthy managed reservation.
  if (record.runState === undefined) return true;
  if (record.runState === "legacy_cycle" || record.runState === "stale" || record.runState === "recovery_required" || record.runState === "unknown" || record.runState === "released") return true;
  return record.releaseVerdict === "preserve_truth_disagreement";
}

/**
 * Derive the two deliberately separate control-plane measures from the same
 * audit projection. A healthy active/handoff/release-requested member consumes
 * capacity but is not a leak; stale, unregistered, orphaned, and disagreeing
 * members remain visible to the leak-safety circuit breaker.
 */
export function managedWorkspaceMeasures(audit: WorktreeAuditOutput): ManagedWorkspaceMeasures {
  const managed = audit.records.filter((record) => record.owner === "loop");
  const anomalousWorktrees = managed.filter(isAnomalousManagedMember);
  const healthyWorktrees = managed.filter((record) => !isAnomalousManagedMember(record));
  const healthyBranches = new Set(
    healthyWorktrees
      .map((record) => record.branch?.replace(/^refs\/heads\//, ""))
      .filter((branch): branch is string => branch !== undefined),
  );
  const anomalousBranches = audit.ephemeralBranches.filter((branch) => !healthyBranches.has(branch));
  return {
    managedCapacity: managed.length,
    leakSafetyTotal: anomalousWorktrees.length + anomalousBranches.length,
    anomalousWorktrees,
    anomalousBranches,
    healthyWorktrees,
  };
}

/**
 * FIX-1460 (#1468): true iff `rec` is an ORPHAN loop dir the audit proved safe to
 * reclaim — loop-owned, inactive, and its owning cycle provably delivered. There
 * is no registered worktree, so it is reclaimed by a bounded directory delete.
 */
export function isReclaimableOrphan(rec: WorktreeAuditRecord): boolean {
  return rec.owner === "loop" && rec.active === false && rec.disposition === "orphan_reclaimable";
}

/**
 * FIX-1460: hard boundary for any directory delete — the path MUST resolve to a
 * direct child of `<repoRoot>/.roll/loop/worktrees`. Never deletes the worktrees
 * root itself, a nested path, a sibling, or anything outside the loop scratch dir.
 */
export function isBoundedLoopWorktreeDir(repoRoot: string, path: string): boolean {
  const base = resolve(join(repoRoot, ".roll", "loop", "worktrees"));
  const abs = resolve(path);
  if (abs === base) return false; // never the root
  if (!abs.startsWith(base + sep)) return false; // must be inside
  return dirname(abs) === base; // must be a DIRECT child (no nested paths)
}

/**
 * Bounded removal boundary for a projected managed member. In addition to the
 * primary direct child, declared submodule and Skill-dispatch child worktrees
 * live beneath `<key>.submodules/…` and `<key>.children/<action>`. This is not
 * used for raw orphan reclaim: those remain direct-child-only.
 */
export function isBoundedManagedWorkspacePath(repoRoot: string, path: string): boolean {
  const base = resolve(join(repoRoot, ".roll", "loop", "worktrees"));
  const abs = resolve(path);
  if (!abs.startsWith(base + sep)) return false;
  const rel = relative(base, abs);
  const segments = rel.split(sep);
  if (segments.length === 1) return segments[0] !== "" && !segments[0]!.endsWith(".submodules") && !segments[0]!.endsWith(".children");
  return (segments[0]!.endsWith(".submodules") && segments.length >= 2)
    || (segments[0]!.endsWith(".children") && segments.length === 2);
}

/** Refs the branch-recovery path must never delete, regardless of merge state. */
const PROTECTED_BRANCHES = new Set(["main", "master", "HEAD"]);

/**
 * FIX-1454: injectable git/PR probes for standalone-branch recovery. Real
 * implementations shell out to git + gh; tests inject fakes. Every probe is
 * read-only — nothing here mutates a ref.
 */
export interface StandaloneBranchDeps {
  /** Loop-worktree branches currently attached to a worktree (never deletable). */
  attachedBranches: ReadonlySet<string>;
  /** Current HEAD branch name, or null when detached. */
  currentBranch: string | null;
  /** Resolve a local branch ref to its SHA, or null if the ref is missing. */
  refSha: (branch: string) => string | null;
  /**
   * PROOF that a standalone branch's work is already delivered (FIX-1458 / #1465):
   * `ancestor` when every commit is reachable from the integration branch;
   * `patch_equivalent` when `git cherry` shows every branch commit already has an
   * equivalent patch in integration; `final_tree` (FIX-1471) when the branch tip
   * tree is byte-identical to the merge commit of the branch's OWN merged GitHub
   * PR and that merge commit is an ancestor of integration (the squash-merge case
   * `git cherry` false-negatives). `null` = cannot prove delivery → preserve (fail
   * closed). A merged GitHub PR alone is NOT proof — a squash merge leaves the
   * exact branch tips undelivered and any unique commit must be kept unless the
   * whole final tree matches the branch's own landed PR merge commit. An unrelated
   * integration commit that merely shares a tree oid is NEVER proof.
   */
  branchMerge: (branch: string, sha: string) => "ancestor" | "patch_equivalent" | "final_tree" | null;
}

/**
 * FIX-1454: resolve the standalone ephemeral branches that are safe to delete —
 * counted by the canary, NOT attached to any worktree, not the current/protected
 * branch, and verifiably merged. Pure w.r.t. the injected probes; deterministic
 * (sorted). Returns a candidate per safe branch with its observed SHA + evidence.
 */
export function resolveStandaloneMergedBranches(
  audit: WorktreeAuditOutput,
  deps: StandaloneBranchDeps,
): CleanupBranchCandidate[] {
  const out: CleanupBranchCandidate[] = [];
  for (const branch of [...audit.ephemeralBranches].sort()) {
    if (PROTECTED_BRANCHES.has(branch)) continue;
    if (deps.attachedBranches.has(branch)) continue; // a worktree pins it — worktree path owns it
    if (deps.currentBranch !== null && branch === deps.currentBranch) continue; // never the checked-out branch
    const sha = deps.refSha(branch);
    if (sha === null || sha === "") continue; // ambiguous/missing ref → fail closed
    const mergeKind = deps.branchMerge(branch, sha);
    if (mergeKind === null) continue; // not verifiably merged → preserve
    out.push({ branch, expectedSha: sha, mergeKind });
  }
  return out;
}

/**
 * Build the minimal, deterministic cleanup plan from a FRESH audit. The plan
 * removes ONLY projection-proven `safe_to_release` loop worktrees plus (FIX-1454)
 * verifiably-merged standalone ephemeral branches, and only as many
 * (worktrees lowest-path-first, then branches by name) as are needed to bring the
 * canary total back under `threshold`. It never selects a path/ref for being old
 * or merely counted.
 */
export function planWorktreeCleanup(
  audit: WorktreeAuditOutput,
  threshold: number,
  standaloneMergedBranches: readonly CleanupBranchCandidate[] = [],
): WorktreeCleanupPlan {
  const loopWorktrees = audit.records.filter((r) => r.owner === "loop");
  const measures = managedWorkspaceMeasures(audit);
  const cleanupCapacityTotal = audit.ephemeralBranches.length + loopWorktrees.length;
  const excess = cleanupCapacityTotal - threshold;

  // A WorkspaceSet is the destructive unit. Never slice a flattened member
  // list: doing so could remove a clean primary while retaining its declared
  // subordinate. The audit's all-member verdict is authoritative, but require
  // every record in the run to be safe again here as a defensive boundary.
  const safeSets = new Map<string, WorktreeAuditRecord[]>();
  for (const record of audit.records.filter((candidate) => candidate.owner === "loop" && candidate.runId !== undefined)) {
    const existing = safeSets.get(record.runId!);
    // A genuine projection has one record per locator. Keep malformed test or
    // legacy duplicates isolated rather than claiming they are one WorkspaceSet.
    const setId = existing?.some((member) => member.memberLocator === record.memberLocator)
      ? `${record.runId!}:${record.path}`
      : record.runId!;
    const set = safeSets.get(setId) ?? [];
    set.push(record);
    safeSets.set(setId, set);
  }
  const pool = [...safeSets.values()]
    .filter((set) => set.length > 0 && set.every(isSafelyDisposable))
    .sort((a, b) => a[0]!.path.localeCompare(b[0]!.path));

  const branchPool = [...standaloneMergedBranches].sort((a, b) => a.branch.localeCompare(b.branch));

  // Take the minimum number of WHOLE workspace sets needed to clear pressure.
  // A set may exceed the remaining member count; that conservative overshoot is
  // required by all-or-nothing release. Branches fill only any remaining gap.
  const excessN = excess > 0 ? excess : 0;
  const chosenSets: WorktreeAuditRecord[][] = [];
  let selectedMembers = 0;
  for (const set of pool) {
    if (selectedMembers >= excessN) break;
    chosenSets.push(set);
    selectedMembers += set.length;
  }
  const chosen = chosenSets.flat();
  const remainingExcess = Math.max(0, excessN - selectedMembers);
  const chosenBranches = branchPool.slice(0, Math.min(remainingExcess, branchPool.length));
  const chosenPaths = new Set(chosen.map((r) => r.path));

  const candidates: CleanupCandidate[] = chosen.map((r) => {
    const workspaceSetId = audit.records.filter((other) => other.runId === r.runId && other.memberLocator === r.memberLocator).length > 1
      ? `${r.runId}:${r.path}`
      : r.runId;
    return {
      path: r.path,
      runId: r.runId as string,
      memberLocator: r.memberLocator as string,
      ...(r.cycleId ? { cycleId: r.cycleId } : {}),
      ...(r.branch ? { branch: r.branch } : {}),
      expectedHead: r.head as string,
      ...(workspaceSetId === r.runId ? {} : { workspaceSetId }),
      reason: "disposable_candidate",
    };
  });

  // Everything not chosen is preserved — including disposables held back because
  // the minimal set already cleared the pressure.
  const preserved: PreservedRecord[] = audit.records
    .filter((r) => !chosenPaths.has(r.path))
    .map((r) => ({ path: r.path, disposition: r.disposition, reason: r.reason }));

  const countedWorktrees = loopWorktrees.map((r) => ({
    path: r.path,
    disposition: r.disposition,
  }));

  return {
    schema: 1,
    generatedAt: audit.generatedAt,
    threshold,
    cleanupCapacityTotal,
    leakSafetyTotal: measures.leakSafetyTotal,
    managedCapacity: measures.managedCapacity,
    projectedTotal: cleanupCapacityTotal - candidates.length - chosenBranches.length,
    countedBranches: [...audit.ephemeralBranches],
    countedWorktrees,
    candidates,
    branchCandidates: chosenBranches,
    preserved,
  };
}

// ─── apply (effectful, injectable) ───────────────────────────────────────────

export interface ApplyCleanupOptions {
  repositoryRoot: string;
  /** When true, revalidate + report but perform NO git mutation. */
  dryRun: boolean;
  /**
   * Re-run a FRESH audit; called immediately before EVERY candidate removal so
   * a state change between plan and apply is caught. Defaults to the real audit
   * over `repositoryRoot`.
   */
  audit?: () => WorktreeAuditOutput;
  /** Remove one worktree via git + prune registration. Injectable for tests. */
  removeWorktree?: (registrationRoot: string, path: string, managedStorageRoot?: string) => { ok: boolean; detail: string };
  /**
   * FIX-1454: fresh standalone-branch probes, called immediately before EVERY
   * branch deletion so a ref/merge/attach change between plan and apply is caught.
   * Required (only) when the plan carries branchCandidates.
   */
  freshBranchDeps?: () => StandaloneBranchDeps;
  /**
   * FIX-1454 / FIX-1471: delete one local branch, ATOMICALLY, only if it still
   * points at `expectedSha` (compare-and-delete closes the check→delete race).
   * Injectable for tests.
   */
  removeBranch?: (repositoryRoot: string, branch: string, expectedSha: string) => { ok: boolean; detail: string };
  /** Structured event sink (defaults to no-op; the CLI wires events.ndjson). */
  emit?: (event: RollEvent) => void;
  /**
   * Durable lifecycle sink. The release request is write-ahead: cleanup refuses
   * the whole WorkspaceSet before touching Git when this write fails. The final
   * released event is likewise required before a dispatch Story lease may close.
   */
  appendLifecycle?: (event: WorktreeLifecycleEvent) => boolean;
  /** Parent control-plane hook used only after every member is absent + released. */
  releaseDispatchReservation?: (storyId: string, runId: string) => boolean;
  /** Dispatch releases are bound to the durable allocation operation, never a time-only cleanup attempt. */
  releaseOperationId?: (runId: string) => string | undefined;
  nowISO?: () => string;
  nowMs?: () => number;
}

export function defaultRemoveBranch(
  repositoryRoot: string,
  branch: string,
  expectedSha: string,
): { ok: boolean; detail: string } {
  // FIX-1471 (supervisor review): ATOMIC compare-and-delete closes the TOCTOU
  // window between the fresh sha/merge revalidation and the delete. `git branch
  // -D` deletes whatever the ref points at NOW — if the branch advanced to new,
  // unmerged commits after the check, `-D` would silently discard them. `git
  // update-ref -d <ref> <oldvalue>` instead deletes ONLY if the ref STILL equals
  // `expectedSha` at delete time, and fails loudly otherwise. No commits are lost:
  // the proven-delivered tip lives on the integration branch.
  if (!isFullGitOid(expectedSha)) {
    return { ok: false, detail: `refused: expected sha ${expectedSha} is not a full git OID` };
  }
  try {
    execFileSync("git", ["-C", repositoryRoot, "update-ref", "-d", `refs/heads/${branch}`, expectedSha], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, detail: "" };
}

/**
 * Remove a single registered worktree. `registrationRoot` names the Git
 * repository which owns its worktree registry; `managedStorageRoot` is the
 * superproject that owns `.roll/loop/worktrees`. They intentionally differ
 * for submodules, whose checkout is stored beneath the superproject scratch
 * root but registered by the submodule repository.
 */
export function defaultRemoveWorktree(
  registrationRoot: string,
  path: string,
  managedStorageRoot = registrationRoot,
): { ok: boolean; detail: string } {
  let gitErr = "";
  try {
    // Remove ONLY this validated path. --force tolerates untracked scratch, but
    // tracked dirt was already rejected by the immediately-preceding fresh audit
    // (isSafelyDisposable requires dirtyTracked === false), and a disposable
    // candidate is merged (ancestor/pr-equivalent) so no unpublished commit is
    // pinned solely by this worktree.
    execFileSync("git", ["-C", registrationRoot, "worktree", "remove", "--force", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    gitErr = err instanceof Error ? err.message : String(err);
  }
  // FIX-1460 (#1468): `git worktree remove --force` can fail with "Directory not
  // empty" when untracked scratch (e.g. a `.next` build dir) appeared AFTER the
  // audit — that failure removes the registration but leaves the directory, which
  // is exactly how a leaked orphan is born. Finish the job with a BOUNDED rm of
  // the exact validated path (already proven disposable this apply). The path is
  // hard-bounded to a direct child of `.roll/loop/worktrees`; anything else is a
  // fail-loud refusal — never a broader delete.
  if (existsSync(path)) {
    if (!isBoundedManagedWorkspacePath(managedStorageRoot, path)) {
      return { ok: false, detail: gitErr || `refused: ${path} is outside .roll/loop/worktrees` };
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, detail: gitErr || (e instanceof Error ? e.message : String(e)) };
    }
  } else if (gitErr) {
    return { ok: false, detail: gitErr };
  }
  try {
    // Reclaim the worktree admin metadata immediately (git's default prune
    // expiry is 3 months) — but never let a prune hiccup mask a successful remove.
    execFileSync("git", ["-C", registrationRoot, "worktree", "prune", "--expire", "now"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    /* best-effort: the removal already succeeded */
  }
  return { ok: true, detail: "" };
}

/**
 * FIX-1460 (#1468): reclaim an ORPHAN loop dir (deregistered from git) with a
 * BOUNDED rm. There is no worktree for git to remove, so this deletes the exact
 * directory — but only after asserting it is a direct child of
 * `.roll/loop/worktrees`. Any path outside that boundary is a fail-loud refusal.
 */
function defaultReclaimOrphanDir(repositoryRoot: string, path: string): { ok: boolean; detail: string } {
  if (!isBoundedLoopWorktreeDir(repositoryRoot, path)) {
    return { ok: false, detail: `refused: ${path} is outside .roll/loop/worktrees` };
  }
  if (!existsSync(path)) {
    return { ok: false, detail: "missing: orphan dir already gone" };
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    execFileSync("git", ["-C", repositoryRoot, "worktree", "prune", "--expire", "now"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    /* best-effort */
  }
  return { ok: true, detail: "" };
}

/**
 * Apply (or dry-run) a cleanup plan. For EACH candidate it re-runs a FRESH audit
 * and requires the same path + head + inactive + no-tracked-dirt + merged +
 * `disposable_candidate` before touching git. Any mismatch is a fail-loud
 * refusal recorded via `worktree_cleanup_refused`; NO other worktree is
 * substituted, and NO threshold-only deletion ever happens.
 */
export async function applyWorktreeCleanup(
  plan: WorktreeCleanupPlan,
  options: ApplyCleanupOptions,
): Promise<WorktreeCleanupResult> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const auditFn =
    options.audit ?? (() => auditWorktrees({ repoRoot: repositoryRoot, home: homedir() }));
  const removeFn = options.removeWorktree ?? defaultRemoveWorktree;
  const removeBranchFn = options.removeBranch ?? defaultRemoveBranch;
  const emit = options.emit ?? (() => {});
  const appendLifecycle = options.appendLifecycle ?? (() => true);
  const nowMs = options.nowMs ?? (() => Date.now());

  const removed: CleanupRemoval[] = [];
  const branchesRemoved: BranchRemoval[] = [];
  const refused: CleanupRefusal[] = [];

  const candidateSets = new Map<string, CleanupCandidate[]>();
  for (const candidate of plan.candidates) {
    const id = candidate.workspaceSetId ?? candidate.runId;
    const set = candidateSets.get(id) ?? [];
    set.push(candidate);
    candidateSets.set(id, set);
  }

  for (const [, candidates] of candidateSets) {
    const runId = candidates[0]!.runId;
    // One fresh projection must prove every member before any member is removed.
    const fresh = auditFn();
    const isolatedLegacyRecord = candidates[0]!.workspaceSetId !== undefined;
    const freshSet = fresh.records.filter((record) => record.owner === "loop" && record.runId === runId
      && (!isolatedLegacyRecord || candidates.some((candidate) => resolve(candidate.path) === resolve(record.path))));
    const plannedLocators = new Set(candidates.map((candidate) => candidate.memberLocator));
    const freshLocators = new Set(freshSet.map((record) => record.memberLocator));
    const refuseSet = (reason: string): void => {
      for (const candidate of candidates) {
        refused.push({ path: candidate.path, reason });
        emit({ type: "worktree_cleanup_refused", path: candidate.path, reason, ts: nowMs() });
      }
    };
    if (freshSet.length === 0) {
      refuseSet("missing: workspace set is no longer registered (already removed or pruned)");
      continue;
    }
    if (freshSet.length !== candidates.length || freshSet.some((record) => record.memberLocator === undefined || !plannedLocators.has(record.memberLocator)) || [...plannedLocators].some((locator) => !freshLocators.has(locator))) {
      refuseSet("projection-changed: workspace set members no longer exactly match the planned release");
      continue;
    }

    const revalidated: Array<{ candidate: CleanupCandidate; record: WorktreeAuditRecord; removal: CleanupRemoval }> = [];
    let failure: string | undefined;
    for (const candidate of candidates) {
      const rec = freshSet.find((record) => record.memberLocator === candidate.memberLocator);
      if (rec === undefined) { failure = "missing: workspace member no longer registered (already removed or pruned)"; break; }
      if (rec.active) { failure = "active: workspace member activated concurrently (fresh lock/heartbeat)"; break; }
      if (rec.head !== candidate.expectedHead) { failure = `changed-head: expected ${candidate.expectedHead}, found ${rec.head ?? "none"}`; break; }
      if (rec.dirtyTracked === true) { failure = "dirty: tracked changes appeared after planning"; break; }
      if (rec.dirtyTracked === "unknown") { failure = "dirty-unknown: could not confirm a clean tracked tree"; break; }
      if (rec.dirtyUntracked !== false) { failure = rec.dirtyUntracked === "unknown" ? "untracked-unknown: could not confirm no untracked files" : "dirty: untracked files appeared after planning"; break; }
      if (!isSafelyDisposable(rec)) { failure = `disposition: fresh audit reports '${rec.disposition}' (${rec.mergeEvidence.kind})`; break; }
      revalidated.push({
        candidate,
        record: rec,
        removal: { path: rec.path, expectedHead: candidate.expectedHead, ...(rec.branch ? { branch: rec.branch } : {}), ...(rec.cycleId ? { cycleId: rec.cycleId } : {}) },
      });
    }
    if (failure !== undefined) { refuseSet(failure); continue; }
    if (options.dryRun) { removed.push(...revalidated.map((entry) => entry.removal)); continue; }

    const expectedHeads = revalidated.map(({ candidate }) => ({
      relativeLocator: candidate.memberLocator,
      head: candidate.expectedHead,
    }));
    const operationId = options.releaseOperationId?.(runId) ?? `${runId}:cleanup:${nowMs()}`;
    // Write intent before the first destructive effect. A failed event append
    // leaves the complete WorkspaceSet and its Story reservation intact.
    if (!appendLifecycle({
      type: "worktree:release_requested",
      runId,
      reason: "delivered",
      operationId,
      expectedHeads,
      ts: nowMs(),
    })) {
      refuseSet("lifecycle-write-failed: could not durably request workspace release");
      continue;
    }

    // Subordinate Git worktrees are registered by their own repository. Remove
    // them before the primary, keeping any failed remainder on disk for the
    // next fresh audit/recovery instead of fabricating a released set.
    let removalFailed = false;
    for (const entry of [...revalidated].sort((a, b) => b.candidate.memberLocator.length - a.candidate.memberLocator.length)) {
      const marker = ".submodules/";
      const at = entry.candidate.memberLocator.indexOf(marker);
      const memberRepository = at < 0 ? repositoryRoot : join(repositoryRoot, entry.candidate.memberLocator.slice(at + marker.length));
      const result = removeFn(memberRepository, entry.record.path, repositoryRoot);
      if (!result.ok) {
        refuseSet(`remove-failed: ${result.detail}; workspace set requires recovery`);
        removalFailed = true;
        break;
      }
      removed.push(entry.removal);
      emit({ type: "worktree_cleanup_applied", path: entry.record.path, expectedHead: entry.candidate.expectedHead, ...(entry.record.branch ? { branch: entry.record.branch } : {}), ...(entry.record.cycleId ? { cycleId: entry.record.cycleId } : {}), ts: nowMs() });
    }
    if (removalFailed || revalidated.some((entry) => existsSync(entry.record.path))) continue;
    if (!appendLifecycle({
      type: "worktree:released",
      runId,
      operationId,
      expectedHeads,
      ts: nowMs(),
    })) {
      // Git has completed, but a missing durable completion marker means the
      // lease must remain held for recovery rather than pretending closure.
      refuseSet("lifecycle-write-failed: workspace removed but release completion was not durable");
      continue;
    }
    const storyId = freshSet[0]?.storyId;
    if (storyId !== undefined && options.releaseDispatchReservation !== undefined
      && !options.releaseDispatchReservation(storyId, runId)) {
      refuseSet("reservation-release-failed: workspace released but Story lease remains held for recovery");
    }
  }

  // FIX-1454: standalone merged branches — revalidate each against FRESH probes
  // (ref sha unchanged, still merged, not attached, not current/protected) before
  // deleting the ref. Any mismatch is a fail-loud refusal; no substitution.
  if (plan.branchCandidates.length > 0) {
    const freshBranchDeps = options.freshBranchDeps;
    for (const bc of plan.branchCandidates) {
      const refuseB = (reason: string): void => {
        refused.push({ path: `branch:${bc.branch}`, reason });
        emit({ type: "worktree_cleanup_refused", path: `branch:${bc.branch}`, reason, ts: nowMs() });
      };
      if (freshBranchDeps === undefined) {
        refuseB("no-revalidation: fresh branch probes unavailable");
        continue;
      }
      const bd = freshBranchDeps();
      if (PROTECTED_BRANCHES.has(bc.branch)) { refuseB("protected: refusing to delete a protected branch"); continue; }
      if (bd.currentBranch !== null && bd.currentBranch === bc.branch) { refuseB("current: branch is checked out"); continue; }
      if (bd.attachedBranches.has(bc.branch)) { refuseB("attached: a worktree now pins this branch"); continue; }
      const sha = bd.refSha(bc.branch);
      if (sha === null || sha === "") { refuseB("missing: branch ref no longer exists"); continue; }
      if (sha !== bc.expectedSha) { refuseB(`changed-ref: expected ${bc.expectedSha}, found ${sha}`); continue; }
      const mk = bd.branchMerge(bc.branch, sha);
      if (mk === null) { refuseB("not-merged: fresh check no longer proves a merge"); continue; }

      const removalB: BranchRemoval = { branch: bc.branch, expectedSha: bc.expectedSha, mergeKind: mk };
      if (options.dryRun) { branchesRemoved.push(removalB); continue; }
      // Atomic compare-and-delete against the observed sha — a ref that advanced
      // between this check and the delete makes update-ref fail, so we refuse.
      const r = removeBranchFn(repositoryRoot, bc.branch, bc.expectedSha);
      if (!r.ok) { refuseB(`delete-failed: ${r.detail}`); continue; }
      branchesRemoved.push(removalB);
      emit({ type: "worktree_cleanup_applied", path: `branch:${bc.branch}`, expectedHead: bc.expectedSha, branch: bc.branch, ts: nowMs() });
    }
  }

  return {
    schema: 1,
    dryRun: options.dryRun,
    removed,
    branchesRemoved,
    refused,
    preserved: [...plan.preserved],
  };
}

// ─── canary-trip enumeration (pure, AC1) ─────────────────────────────────────

/**
 * Build the enumerated canary-trip report + structured event from a fresh audit.
 * The pause is thereby auditable: it lists the EXACT counted branches and loop
 * worktrees with each worktree's disposition, not a bare number.
 */
export function formatCanaryTripReport(
  audit: WorktreeAuditOutput,
  threshold: number,
  nowMs: number,
): { alert: string; event: RollEvent } {
  const zh = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] }) === "zh";
  const measures = managedWorkspaceMeasures(audit);
  const worktrees = measures.anomalousWorktrees
    .map((r) => ({ path: r.path, disposition: r.disposition }));
  const total = measures.leakSafetyTotal;

  const disposable = worktrees.filter((w) => w.disposition === "disposable_candidate").length;
  const branchLines = measures.anomalousBranches.length
    ? measures.anomalousBranches.map((b) => `  - ${zh ? "分支" : "branch"} ${b}`).join("\n")
    : "  - (none)";
  const wtLines = worktrees.length
    ? worktrees.map((w) => `  - ${zh ? "工作树" : "worktree"} ${w.path} [${w.disposition}]`).join("\n")
    : "  - (none)";
  const capacityLines = measures.healthyWorktrees.length
    ? measures.healthyWorktrees.map((w) => `  - ${w.path} [${w.runState ?? "legacy"}]`).join("\n")
    : "  - (none)";

  const alert = zh
    ? `# ALERT — loop 自动暂停：泄漏安全 canary 已触发（US-LOOP-096 / FIX-1273）\n\n` +
      `**泄漏安全计数**：${total}（异常临时分支 ${measures.anomalousBranches.length} + 异常受管工作树 ${worktrees.length}）> 阈值 ${threshold}\n` +
      `**受管容量**：${measures.managedCapacity} 个保留成员（健康 ${measures.healthyWorktrees.length}，异常 ${worktrees.length}）。健康 handoff 只占容量，不算泄漏。\n\n` +
      `**异常临时分支**：\n${branchLines}\n\n` +
      `**异常受管工作树（含审计处置）**：\n${wtLines}\n\n` +
      `**健康保留容量**：\n${capacityLines}\n\n` +
      `**安全恢复**：${disposable} 个工作树审计为 \`disposable_candidate\`。\n` +
      `  1. 检查并规划（不修改）：\`roll worktree cleanup --dry-run\`\n` +
      `  2. 应用经审计的最小集合：\`roll worktree cleanup --apply\`\n` +
      `  3. 显式恢复 loop：\`roll loop resume\`\n` +
      `  保留的（未发布 / 脏 / 活跃 / 外部）工作树绝不会被删除。\n`
    : `# ALERT — loop auto-paused: leak-safety canary tripped (US-LOOP-096 / FIX-1273)\n\n` +
      `**Leak-safety count**: ${total} (anomalous ephemeral branches ${measures.anomalousBranches.length} + ` +
      `anomalous managed worktrees ${worktrees.length}) > threshold ${threshold}\n` +
      `**Managed capacity**: ${measures.managedCapacity} retained member(s) (${measures.healthyWorktrees.length} healthy, ${worktrees.length} anomalous). Healthy handoff is capacity, not a leak.\n\n` +
      `**Anomalous ephemeral branches**:\n${branchLines}\n\n` +
      `**Anomalous managed worktrees (with audit disposition)**:\n${wtLines}\n\n` +
      `**Healthy retained capacity**:\n${capacityLines}\n\n` +
      `**Safe recovery**: ${disposable} worktree(s) audit as \`disposable_candidate\`.\n` +
      `  1. Inspect + plan (no mutation): \`roll worktree cleanup --dry-run\`\n` +
      `  2. Apply the audited minimal set:  \`roll worktree cleanup --apply\`\n` +
      `  3. Resume the loop explicitly:     \`roll loop resume\`\n` +
      `  Preserved (unpublished / dirty / active / external) worktrees are NEVER removed.\n`;

  const event: RollEvent = {
    type: "branch_canary_tripped",
    total,
    threshold,
    managedCapacity: measures.managedCapacity,
    ephemeralBranches: [...measures.anomalousBranches],
    worktrees,
    ts: nowMs,
  };
  return { alert, event };
}

// ─── human rendering ─────────────────────────────────────────────────────────

function rel(p: string): string {
  try {
    const r = relative(process.cwd(), p);
    if (!r.startsWith("..") && r.length < p.length) return r;
  } catch {
    /* keep absolute */
  }
  return p;
}

function renderPlanHuman(plan: WorktreeCleanupPlan, mode: "dry-run" | "apply"): string {
  const zh = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] }) === "zh";
  const lines: string[] = [];
  lines.push(zh ? `工作树清理（${mode === "dry-run" ? "演练" : "执行"}）` : `Worktree cleanup (${mode})`);
  lines.push("");
  lines.push(`  ${zh ? "泄漏安全计数" : "leak-safety count"}: ${plan.leakSafetyTotal} (${zh ? "阈值" : "threshold"} ${plan.threshold})`);
  lines.push(`  ${zh ? "受管容量" : "managed capacity"}: ${plan.managedCapacity} ${zh ? "个保留成员" : "retained member(s)"}`);
  lines.push(
    zh
      ? `  清理容量：${plan.countedBranches.length} 个临时分支 + ${plan.countedWorktrees.length} 个 loop 工作树`
      : `  cleanup capacity: ${plan.countedBranches.length} ephemeral branch(es) + ${plan.countedWorktrees.length} loop worktree(s)`,
  );
  lines.push("");

  lines.push(zh ? "计入清理容量的临时分支" : "counted ephemeral branches");
  if (plan.countedBranches.length === 0) lines.push("  (none)");
  for (const b of plan.countedBranches) lines.push(`  ${b}`);
  lines.push("");

  lines.push(zh ? "计入清理容量的 loop 工作树" : "counted loop worktrees");
  if (plan.countedWorktrees.length === 0) lines.push("  (none)");
  for (const w of plan.countedWorktrees) lines.push(`  ${rel(w.path)}  [${w.disposition}]`);
  lines.push("");

  if (plan.candidates.length === 0 && plan.branchCandidates.length === 0) {
    if (plan.cleanupCapacityTotal <= plan.threshold) {
      lines.push(zh ? "无需清理——清理容量已在阈值内。" : "No cleanup needed — cleanup capacity is already within threshold.");
    } else {
      lines.push(zh
        ? "没有可释放候选——所有计入的工作树均被保留（未发布 / 脏 / 活跃 / 外部），且没有可验证已交付的独立分支。请人工检查保留的工作树和分支。"
        : "No disposable candidates — every counted worktree is preserved " +
          "(unpublished / dirty / active / external) and no counted standalone branch " +
          "is verifiably delivered. Inspect the preserved worktrees/branches manually.");
    }
    lines.push("");
    return lines.join("\n").trimEnd() + "\n";
  }

  lines.push(zh ? `最小候选集（${plan.cleanupCapacityTotal} → ${plan.projectedTotal}）` : `minimal candidate set (${plan.cleanupCapacityTotal} → ${plan.projectedTotal})`);
  for (const c of plan.candidates) {
    const tags = [c.branch, c.cycleId].filter(Boolean).join(" ");
    lines.push(`  ${zh ? "工作树" : "worktree"} ${rel(c.path)}${tags ? "  " + tags : ""}  [disposable_candidate]`);
  }
  for (const b of plan.branchCandidates) {
    lines.push(`  ${zh ? "分支" : "branch"}   ${b.branch}  ${b.expectedSha.slice(0, 9)}  [${zh ? "已交付" : "merged"}: ${b.mergeKind}]`);
  }
  lines.push("");

  // FIX-1460 (#1468): surface preserved orphan dirs (deregistered, delivery not
  // provable). They are counted + visible but NEVER auto-deleted — the operator
  // reclaims one explicitly after review.
  const preservedOrphans = plan.preserved.filter((p) => p.disposition === "preserved_orphan");
  if (preservedOrphans.length > 0) {
    lines.push(zh ? `保留的孤儿目录（${preservedOrphans.length}）——可见且计数，绝不自动删除` : `preserved orphan dirs (${preservedOrphans.length}) — visible + counted, never auto-deleted`);
    for (const p of preservedOrphans) lines.push(`  ${rel(p.path)}  — ${p.reason}`);
    lines.push(zh ? "  审查后使用此命令回收一个：roll worktree cleanup --reclaim-orphan <path>" : "  Reclaim one after review with: roll worktree cleanup --reclaim-orphan <path>");
    lines.push("");
  }

  if (mode === "dry-run") {
    lines.push(zh ? "演练——未修改 Git 状态。" : "Dry run — no git state changed.");
    lines.push(zh ? "使用此命令应用经审计的集合：roll worktree cleanup --apply" : "Apply the audited set with: roll worktree cleanup --apply");
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function renderResultHuman(result: WorktreeCleanupResult): string {
  const zh = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] }) === "zh";
  const lines: string[] = [];
  lines.push(zh ? "工作树清理（执行）" : "Worktree cleanup (apply)");
  lines.push("");
  if (result.removed.length > 0) {
    lines.push(zh ? `已移除工作树（${result.removed.length}）` : `removed worktrees (${result.removed.length})`);
    for (const r of result.removed) lines.push(`  ${rel(r.path)}  ${r.expectedHead}`);
    lines.push("");
  }
  if (result.branchesRemoved.length > 0) {
    lines.push(zh ? `已移除分支（${result.branchesRemoved.length}）` : `removed branches (${result.branchesRemoved.length})`);
    for (const b of result.branchesRemoved) lines.push(`  ${b.branch}  ${b.expectedSha.slice(0, 9)}  [${b.mergeKind}]`);
    lines.push("");
  }
  if (result.refused.length > 0) {
    lines.push(zh ? `已拒绝——故障关闭，绝不替换（${result.refused.length}）` : `refused — fail closed, no substitution (${result.refused.length})`);
    for (const r of result.refused) lines.push(`  ${rel(r.path)}  ${r.reason}`);
    lines.push("");
  }
  const anyRemoved = result.removed.length > 0 || result.branchesRemoved.length > 0;
  if (!anyRemoved && result.refused.length === 0) {
    lines.push(zh ? "无可移除项——没有重新验证通过的候选。" : "Nothing to remove — no revalidated candidates.");
    lines.push("");
  }
  if (anyRemoved) {
    lines.push(zh ? "准备好后显式恢复 loop：roll loop resume" : "Resume the loop explicitly when ready: roll loop resume");
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// ─── CLI command ─────────────────────────────────────────────────────────────

export const CLEANUP_USAGE =
  "Usage: roll worktree cleanup [--dry-run | --apply] [--json] [--repo <path>]\n" +
  "  Safely release a managed WorkspaceSet; the worktree audit is the SOLE authority.\n" +
  "  A release requires confirmed merge, accepted attest, and a fresh\n" +
  "  `safe_to_release` result for EVERY registered member. `handoff_ready` is not\n" +
  "  delivery: any handoff, unknown, stale, dirty, active, external, or unregistered\n" +
  "  member means the entire Story reservation is preserved. Nothing is selected merely because\n" +
  "  it is old, and recovery is non-destructive until the owner resolves the blocker.\n" +
  "\n" +
  "  Always dry-run first. Default (no flag) is --dry-run.\n" +
  "  --dry-run  print the audit-derived release/refusal plan. Never mutates Git\n" +
  "             state or clears a reservation.\n" +
  "  --apply    re-run the audit before release; any changed head, new dirt, missing\n" +
  "             path, or concurrent activation fails closed without substitution.\n" +
  "             Resolve the blocker, then resume explicitly: roll loop resume\n" +
  "  --json     emit the same schema-1 plan (dry-run) or result (apply) as JSON\n" +
  "  --repo     override the project root (default: current directory)\n" +
  "  --reclaim-orphan <path>  (FIX-1460) bounded-rm ONE named orphan loop dir\n" +
  "             (deregistered from git; delivery not auto-provable) after you\n" +
  "             review it. Fails closed unless it is an inactive loop orphan\n" +
  "             inside .roll/loop/worktrees. Orphans never enter --apply.\n";

export function worktreeCleanupUsage(): string {
  const zh = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] }) === "zh";
  return zh
    ? "用法：roll worktree cleanup [--dry-run | --apply] [--json] [--repo <path>]\n  只以工作树审计为唯一权威安全释放受管 WorkspaceSet。释放必须同时满足已确认合并、已接受\n  attest，以及每个已注册成员重新审计为 `safe_to_release`。handoff_ready 不等于已交付；任一\n  成员处于交接、未知、过期、脏、活动、外部或未注册状态，整个 Story 预留都会保留。不会只因\n  路径陈旧而选择它；在所有者解决阻塞前，恢复始终非破坏性。\n\n  默认（无标志）为 --dry-run，绝不修改 Git 状态或清除预留。\n  --dry-run  输出由审计导出的释放/拒绝计划。\n  --apply    释放前重新审计；HEAD、脏改动、路径或并发活动变化即失败关闭，绝不替换对象。\n             解决阻塞后手动恢复：roll loop resume\n  --json     输出同一 schema-1 计划（演练）或结果（执行）JSON\n  --repo     覆盖项目根目录（默认：当前目录）\n  --reclaim-orphan <path>  审查后回收一个点名的、已解除 Git 注册的受管孤儿目录；绝不自动回收。\n"
    : CLEANUP_USAGE;
}

function resolveThreshold(): number {
  const parsed = parseInt(process.env["ROLL_BRANCH_CANARY_MAX"] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRANCH_CANARY_MAX;
}

function gitCap(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Injectable git probe for {@link classifyBranchMerge}: `ok` = exit 0. */
export type BranchGitProbe = (args: string[]) => { ok: boolean; stdout: string };

/**
 * FIX-1471: injectable lookup for the merge commit OID of a MERGED GitHub PR whose
 * head is EXACTLY `branch`. Returns the merge commit SHA, or `null` when there is
 * no such merged PR (or the probe fails). Real implementations shell out to `gh`;
 * tests inject fakes. This is the ONLY source of a squash-merge delivery anchor —
 * see {@link classifyFinalTreeDelivery}.
 */
export type PrMergeCommitProbe = (branch: string) => string | null;

/**
 * FIX-1458 (#1465), FIX-1471: classify how a standalone branch's work is
 * delivered, using ONLY fresh git evidence anchored to the branch's own PR — never
 * a merged-PR label on its own, and never an arbitrary same-tree commit.
 *
 *  - `ancestor`        — `merge-base --is-ancestor`: every commit is literally
 *                        reachable from integration; deleting the ref loses nothing.
 *  - `patch_equivalent`— `git cherry <integration> <branch>` prints `-` for every
 *                        commit (each already has an equivalent patch upstream).
 *  - `final_tree`      — (FIX-1471) the branch tip's whole-repo tree is
 *                        byte-identical to the ACTUAL merge commit of a merged
 *                        GitHub PR for THIS exact head ref, and that merge commit
 *                        is an ancestor of the integration branch. This is the
 *                        squash-merge case: `git cherry` false-negatives (the
 *                        individual TCR commits have no matching patch id
 *                        upstream), but the PR's single merge commit carries the
 *                        branch's EXACT final tree. See {@link classifyFinalTreeDelivery}.
 *  - `null`            — no ancestry, no full-patch-equivalence, and no
 *                        PR-anchored exact final-tree match (incl. a NEAR-match
 *                        that differs by even one file), or any empty/failed
 *                        probe. Fail closed: unproven ⇒ preserve.
 *
 * Pure w.r.t. the injected probes. Delivery is proven only by ancestry, full
 * patch-equivalence, or an exact final-tree match against the branch's own merged
 * PR merge commit — never by partial patch overlap, PR state alone, or an
 * unrelated integration commit that happens to share a tree oid.
 */
export function classifyBranchMerge(
  branch: string,
  integrationBranch: string,
  git: BranchGitProbe,
  prMergeCommit: PrMergeCommitProbe,
): "ancestor" | "patch_equivalent" | "final_tree" | null {
  if (git(["merge-base", "--is-ancestor", branch, integrationBranch]).ok) return "ancestor";
  const cherry = git(["cherry", integrationBranch, branch]);
  if (cherry.ok) {
    const lines = cherry.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    // Every commit already has an equivalent patch upstream ⇒ delivered.
    if (lines.length > 0 && lines.every((l) => l.startsWith("-"))) return "patch_equivalent";
    // Otherwise (a `+` unique patch — the squash-merge case — an empty diff, or
    // unrecognized output) fall through to the final-tree proof below.
  }
  return classifyFinalTreeDelivery(branch, integrationBranch, git, prMergeCommit);
}

/**
 * FIX-1471: prove delivery of a squash-merged ref by exact final-tree equality
 * against the branch's OWN merged PR merge commit.
 *
 * A squash merge collapses the branch's TCR commits into one merge commit on the
 * integration branch, so `git cherry` shows every branch commit as unique (`+`).
 * But that merge commit's whole-repo tree is byte-identical to the branch tip's
 * tree. Delivery is accepted ONLY when ALL of the following hold:
 *
 *   1. A merged GitHub PR exists for THIS exact head ref, yielding a merge commit
 *      OID (`prMergeCommit(branch)`). No merged PR / no merge OID ⇒ preserve.
 *   2. That merge commit is an ancestor of the integration branch
 *      (`merge-base --is-ancestor <merge> <integration>`) — i.e. actually landed.
 *   3. The branch tip tree oid equals the merge commit's tree oid, byte-for-byte.
 *
 * Crucially, the tree is compared ONLY against the branch's associated PR merge
 * commit — NOT against every integration-reachable commit. An unrelated commit on
 * main that coincidentally shares a tree oid (empty/trivial trees, reverts) is
 * never treated as delivery proof.
 *
 * Fail closed: absent merged PR, non-ancestor merge commit, a missing/failed tree
 * probe, or any tree mismatch (a NEAR-match differing by even one file changes the
 * tree oid) ⇒ null.
 */
function classifyFinalTreeDelivery(
  branch: string,
  integrationBranch: string,
  git: BranchGitProbe,
  prMergeCommit: PrMergeCommitProbe,
): "final_tree" | null {
  // (1) The delivery anchor is the branch's OWN merged PR merge commit — nothing else.
  const rawMerge = prMergeCommit(branch);
  if (rawMerge === null) return null; // no merged PR for this head ref → preserve
  const merge = rawMerge.trim();
  // The anchor MUST be a full git OID before it ever reaches git as a revision —
  // a ref name (`HEAD`, `main`), abbreviated sha, or malformed value could
  // otherwise resolve to an unrelated commit and forge a delivery proof.
  if (!isFullGitOid(merge)) return null;

  // (2) That merge commit must actually be on the integration branch.
  if (!git(["merge-base", "--is-ancestor", merge, integrationBranch]).ok) return null;

  // (3) The branch tip tree must be byte-identical to the merge commit's tree.
  const branchTreeProbe = git(["rev-parse", `${branch}^{tree}`]);
  if (!branchTreeProbe.ok) return null; // cannot resolve the branch tree → preserve
  const branchTree = branchTreeProbe.stdout.trim();
  if (branchTree === "") return null;

  const mergeTreeProbe = git(["rev-parse", `${merge}^{tree}`]);
  if (!mergeTreeProbe.ok) return null; // cannot resolve the merge commit tree → preserve
  const mergeTree = mergeTreeProbe.stdout.trim();
  if (mergeTree === "") return null;

  if (branchTree !== mergeTree) return null; // near-match / different tree → preserve
  return "final_tree";
}

/** FIX-1454: real git+gh probes for standalone-branch recovery over `repoRoot`. */
export function buildStandaloneBranchDeps(
  repoRoot: string,
  audit: WorktreeAuditOutput,
  integrationBranch: string,
): StandaloneBranchDeps {
  const attachedBranches = new Set(
    audit.records
      .filter((r) => r.owner === "loop" && typeof r.branch === "string" && r.branch !== "")
      .map((r) => (r.branch as string).replace(/^refs\/heads\//, "")),
  );
  let currentBranch: string | null = null;
  try {
    currentBranch = gitCap(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim() || null;
  } catch {
    currentBranch = null; // detached HEAD — no current branch to protect
  }
  return {
    attachedBranches,
    currentBranch,
    refSha: (branch) => {
      try {
        return gitCap(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]).trim() || null;
      } catch {
        return null;
      }
    },
    // FIX-1458 (#1465), FIX-1471: delivery is proven by fresh git patch evidence
    // (ancestor OR `git cherry` patch-equivalence) OR, for the squash-merge case,
    // by the branch tip tree matching the merge commit of the branch's OWN merged
    // GitHub PR (an ancestor of integration). A merged PR label alone never
    // authorizes deletion, and no arbitrary same-tree integration commit is ever
    // consulted — that would silently discard unique commits (US-ORG-003/007/004).
    branchMerge: (branch) =>
      classifyBranchMerge(
        branch,
        integrationBranch,
        (args) => {
          try {
            return { ok: true, stdout: gitCap(repoRoot, args) };
          } catch (err) {
            // execFileSync throws on non-zero exit; capture any stdout it produced
            // (git cherry exits 0 normally, so a throw here means a real failure).
            const stdout = typeof (err as { stdout?: unknown }).stdout === "string" ? (err as { stdout: string }).stdout : "";
            return { ok: false, stdout };
          }
        },
        (b) => ghMergedPrMergeCommit(repoRoot, b),
      ),
  };
}

/**
 * FIX-1471 (supervisor review): a FULL git object id — 40-hex SHA-1 or 64-hex
 * SHA-256, lowercase. Anything else (a ref name like `HEAD` or `main`, an
 * abbreviated sha, empty, or malformed) is rejected so it can NEVER be handed to
 * git as a revision, where it would resolve to an unrelated commit.
 */
export function isFullGitOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}

/**
 * FIX-1471 (supervisor review): PURE extraction of a delivery-authorizing merge
 * commit OID from a `gh pr view --json state,mergedAt,mergeCommit,headRefName`
 * payload for `branch`. Returns the oid ONLY when EVERY guard holds; otherwise
 * `null` (fail closed). Split out from the gh shell-out so the guards are unit
 * testable without a live `gh`.
 *
 * Guards:
 *   - `state === "MERGED"` and a non-empty `mergedAt` (an open / closed-unmerged
 *     PR never authorizes deletion).
 *   - `headRefName` is PRESENT (a string) and EXACTLY `branch`. A null / empty /
 *     missing / mismatched head ref is rejected — we never bind a delivery proof
 *     to a PR whose head we cannot confirm is this exact ref.
 *   - `mergeCommit.oid` is a FULL git OID (see {@link isFullGitOid}) — a ref name
 *     (`HEAD`), abbreviated sha, or malformed value is rejected.
 */
export function parseMergedPrMergeCommit(raw: string, branch: string): string | null {
  let j: {
    state?: string;
    mergedAt?: string | null;
    mergeCommit?: { oid?: string } | null;
    headRefName?: string | null;
  };
  try {
    j = JSON.parse(raw) as typeof j;
  } catch {
    return null; // unparseable gh output → fail closed
  }
  if (j.state !== "MERGED") return null; // open / closed-unmerged → not delivered
  if (typeof j.mergedAt !== "string" || j.mergedAt === "") return null;
  // Head ref MUST be present and exactly this branch — never null/empty/missing.
  if (typeof j.headRefName !== "string" || j.headRefName !== branch) return null;
  const oid = j.mergeCommit?.oid;
  if (typeof oid !== "string" || !isFullGitOid(oid)) return null; // reject HEAD/refs/short/malformed
  return oid;
}

/**
 * FIX-1471: resolve the merge commit OID of a MERGED GitHub PR whose head is
 * EXACTLY `branch`. Synchronous (matches this file's execFileSync style) and
 * fail-closed: any gh failure, a non-merged PR, a head-ref mismatch, or a
 * non-full-OID merge commit ⇒ `null`, so an unproven ref is preserved rather than
 * deleted. `gh pr view <branch>` resolves the PR associated with the head ref;
 * {@link parseMergedPrMergeCommit} applies the guards.
 */
function ghMergedPrMergeCommit(repoRoot: string, branch: string): string | null {
  let out: string;
  try {
    out = execFileSync(
      "gh",
      ["pr", "view", branch, "--json", "state,mergedAt,mergeCommit,headRefName"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return null; // no PR for this head ref, or gh failed → fail closed (preserve)
  }
  return parseMergedPrMergeCommit(out, branch);
}

function resolveIntegrationForCleanup(repoRoot: string): string {
  try {
    const head = gitCap(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trim();
    const short = head.replace(/^origin\//, "");
    if (short !== "") return short;
  } catch {
    /* fall through */
  }
  return "main";
}

export async function worktreeCleanupCommand(
  args: string[],
  deps?: Partial<WorktreeAuditDeps> & {
    removeWorktree?: (repositoryRoot: string, path: string) => { ok: boolean; detail: string };
    reclaimOrphanDir?: (repositoryRoot: string, path: string) => { ok: boolean; detail: string };
    emit?: (event: RollEvent) => void;
    nowMs?: () => number;
  },
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(worktreeCleanupUsage());
    return 0;
  }

  const jsonFlag = args.includes("--json");
  const apply = args.includes("--apply");
  if (apply && args.includes("--dry-run")) {
    process.stderr.write("roll worktree cleanup: --apply and --dry-run are mutually exclusive.\n");
    return 2;
  }
  const repoIdx = args.indexOf("--repo");
  const repoOverride = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
  const repoRoot = resolve(repoOverride ?? process.cwd());
  if (skillDispatchActorForCwd(process.cwd()) === "child") {
    process.stderr.write("roll worktree cleanup: child Skill workspaces cannot release the parent delivery run.\n");
    return 2;
  }

  const fullDeps: WorktreeAuditDeps = {
    repoRoot,
    home: deps?.home ?? homedir(),
    git: deps?.git,
    readFile: deps?.readFile,
    readDir: deps?.readDir,
    nowISO: deps?.nowISO,
    nowSec: deps?.nowSec,
    integrationBranch: deps?.integrationBranch,
  };

  // FIX-1460 (#1468): explicit operator reclaim of ONE preserved orphan dir whose
  // delivery could not be auto-proven. The operator names the exact path (having
  // reviewed it); we still fail-closed on: not-in-audit, not loop-owned, active,
  // a registered/other worktree (must use --apply), or a path outside the bounded
  // `.roll/loop/worktrees` scratch dir. Never a broad or substituted delete.
  const reclaimIdx = args.indexOf("--reclaim-orphan");
  if (reclaimIdx >= 0) {
    const named = args[reclaimIdx + 1];
    if (!named) {
      process.stderr.write("roll worktree cleanup: --reclaim-orphan requires a <path>.\n");
      return 2;
    }
    const fresh = auditWorktrees(fullDeps);
    const target = resolve(named);
    const rec = fresh.records.find((r) => resolve(r.path) === target);
    if (!rec) {
      process.stderr.write(`refused: ${named} is not in the worktree audit.\n`);
      return 2;
    }
    if (rec.owner !== "loop") {
      process.stderr.write(`refused: ${named} is not a loop worktree (owner=${rec.owner}).\n`);
      return 2;
    }
    if (rec.active) {
      process.stderr.write(`refused: ${named} has an active cycle lock.\n`);
      return 2;
    }
    if (rec.disposition !== "orphan_reclaimable" && rec.disposition !== "preserved_orphan") {
      process.stderr.write(`refused: ${named} audits as '${rec.disposition}', not an orphan dir — use --apply for registered worktrees.\n`);
      return 2;
    }
    if (!isBoundedLoopWorktreeDir(repoRoot, rec.path)) {
      process.stderr.write(`refused: ${named} is outside .roll/loop/worktrees.\n`);
      return 2;
    }
    const reclaimFn = deps?.reclaimOrphanDir ?? defaultReclaimOrphanDir;
    const r = reclaimFn(repoRoot, rec.path);
    if (!r.ok) {
      process.stderr.write(`reclaim-failed: ${r.detail}\n`);
      return 1;
    }
    process.stdout.write(`reclaimed orphan dir: ${rec.path}\n`);
    return 0;
  }

  const threshold = resolveThreshold();
  const integrationBranch = fullDeps.integrationBranch ?? resolveIntegrationForCleanup(repoRoot);
  const auditNow = auditWorktrees(fullDeps);
  // FIX-1454: real git+gh probes; a git/gh hiccup yields zero branch candidates
  // (fail closed — never guess a branch is merged).
  const standaloneBranches = resolveStandaloneMergedBranches(
    auditNow,
    buildStandaloneBranchDeps(repoRoot, auditNow, integrationBranch),
  );
  const plan = planWorktreeCleanup(auditNow, threshold, standaloneBranches);

  if (!apply) {
    // Dry-run (default): report only, never mutate git state.
    if (jsonFlag) {
      process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    } else {
      process.stdout.write(renderPlanHuman(plan, "dry-run"));
    }
    return 0;
  }

  // Apply: revalidate every candidate against a FRESH audit; emit events.
  const eventsPath = join(repoRoot, ".roll", "loop", "events.ndjson");
  const emit =
    deps?.emit ??
    ((event: RollEvent): void => {
      try {
        mkdirSync(dirname(eventsPath), { recursive: true });
        appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf8");
      } catch {
        /* best-effort observability */
      }
    });
  const appendLifecycle = (event: WorktreeLifecycleEvent): boolean => {
    try {
      new EventBus().appendEvent(eventsPath, event);
      return true;
    } catch {
      return false;
    }
  };

  const result = await applyWorktreeCleanup(plan, {
    repositoryRoot: repoRoot,
    dryRun: false,
    audit: () => auditWorktrees(fullDeps),
    // FIX-1454: fresh branch probes for per-branch revalidation before deletion.
    freshBranchDeps: () => {
      const fresh = auditWorktrees(fullDeps);
      return buildStandaloneBranchDeps(repoRoot, fresh, integrationBranch);
    },
    ...(deps?.removeWorktree ? { removeWorktree: deps.removeWorktree } : {}),
    emit,
    appendLifecycle,
    releaseDispatchReservation: (storyId, runId) => {
      // Cycle and host-delta WorkspaceSets use their own closure paths. Only a
      // durable `skill_dispatch` allocation owns the Story lease this command
      // is allowed to release.
      try {
        const allocatedDispatch = new EventBus().readEvents(eventsPath).some((event) =>
          event.type === "worktree:allocated"
          && event.workspace.runId === runId
          && event.workspace.storyId === storyId
          && event.workspace.kind === "skill_dispatch",
        );
        return !allocatedDispatch || releaseSkillDispatchReservation(repoRoot, storyId, runId, repoRoot).ok;
      } catch {
        return false;
      }
    },
    releaseOperationId: (runId) => {
      try {
        const allocated = new EventBus().readEvents(eventsPath).find((event) =>
          event.type === "worktree:allocated" && event.workspace.runId === runId && event.workspace.kind === "skill_dispatch",
        );
        return allocated?.type === "worktree:allocated" && allocated.operationId !== undefined
          ? `${allocated.operationId}:release`
          : undefined;
      } catch {
        return undefined;
      }
    },
    ...(deps?.nowMs ? { nowMs: deps.nowMs } : {}),
  });

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(renderResultHuman(result));
  }
  // Non-zero only when every attempted removal was refused — a partial success
  // (some removed, some refused) still returns 0 so the operator sees progress.
  const anyRemoved = result.removed.length > 0 || result.branchesRemoved.length > 0;
  return !anyRemoved && result.refused.length > 0 ? 1 : 0;
}
