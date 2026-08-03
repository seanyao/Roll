/**
 * FIX-1273 — `roll worktree cleanup`: safe recovery for branch-canary historical
 * worktree pressure.
 *
 * The branch/worktree canary counts every ephemeral branch + every dir under
 * `.roll/loop/worktrees` and pauses the loop over threshold — INCLUDING inactive
 * worktrees deliberately preserved for unpublished commits or dirty recovery.
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
 *     the same path + head + inactive + no-tracked-dirt + merged-ancestry +
 *     `disposable_candidate` disposition. It removes only that verified worktree
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
import { DEFAULT_BRANCH_CANARY_MAX } from "@roll/core";
import type { RollEvent } from "@roll/spec";
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
  cycleId?: string;
  branch?: string;
  workspaceId?: string;
  repoId?: string;
  repositoryAlias?: string;
  cachePath?: string;
  /** HEAD the audit observed; `--apply` refuses if the fresh head differs. */
  expectedHead: string;
  /** Exact path-specific orphan material proof observed while planning. */
  expectedOrphanFingerprint?: string;
  reason: "disposable_candidate" | "orphan_reclaimable";
  /**
   * FIX-1460 (#1468): how this path is reclaimed. `git_worktree` (default) uses
   * `git worktree remove` for a registered worktree; `rm_dir` uses a bounded
   * directory delete for an ORPHAN dir that git no longer registers (there is no
   * worktree for git to remove). Absent ⇒ `git_worktree` (backwards compatible).
   */
  reclaim?: "git_worktree" | "rm_dir";
}

/**
 * FIX-1454: a standalone ephemeral branch (NOT attached to any worktree) whose
 * commits are verifiably merged, so deleting the ref safely reduces the canary
 * count. Bounded exactly like a worktree candidate: audit-derived, revalidated
 * before deletion, fail-closed on any mismatch.
 */
export interface CleanupBranchCandidate {
  branch: string;
  workspaceId?: string;
  repoId?: string;
  cachePath?: string;
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
  /** Total the canary sees: ephemeral branches + loop worktree dirs. */
  canaryTotal: number;
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
  workspaceId?: string;
  repoId?: string;
  repositoryAlias?: string;
  cachePath?: string;
  /** FIX-1460: how the path was reclaimed (git worktree remove vs bounded rm). */
  reclaim?: "git_worktree" | "rm_dir";
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
  workspaceId?: string;
  repoId?: string;
  cachePath?: string;
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

const MERGED_KINDS = new Set(["ancestor", "patch_equivalent", "final_tree"]);

/** True iff `rec` satisfies EVERY safe-removal invariant on a fresh audit. */
export function isSafelyDisposable(rec: WorktreeAuditRecord): boolean {
  if (rec.owner === "workspace") {
    return (
      rec.active === false &&
      rec.dirtyTracked === false &&
      rec.dirtyUntracked === false &&
      rec.disposition === "disposable_candidate" &&
      rec.ownershipState === "verified" &&
      (rec.deliveryProof === "delivered" || rec.deliveryProof === "abandoned") &&
      typeof rec.workspaceId === "string" && rec.workspaceId !== "" &&
      typeof rec.repoId === "string" && rec.repoId !== "" &&
      typeof rec.repositoryAlias === "string" && rec.repositoryAlias !== "" &&
      typeof rec.cachePath === "string" && rec.cachePath !== "" &&
      typeof rec.head === "string" && rec.head.length > 0
    );
  }
  return (
    rec.owner === "loop" &&
    rec.active === false &&
    rec.dirtyTracked === false &&
    rec.disposition === "disposable_candidate" &&
    MERGED_KINDS.has(rec.mergeEvidence.kind) &&
    typeof rec.head === "string" &&
    rec.head.length > 0
  );
}

/**
 * FIX-1460 (#1468): true iff `rec` is an ORPHAN loop dir the audit proved safe to
 * reclaim — loop-owned, inactive, and its owning cycle provably delivered. There
 * is no registered worktree, so it is reclaimed by a bounded directory delete.
 */
export function isReclaimableOrphan(rec: WorktreeAuditRecord): boolean {
  const proof = rec.orphanRecoveryProof;
  return (
    rec.owner === "loop" &&
    rec.active === false &&
    rec.disposition === "orphan_reclaimable" &&
    (proof?.state === "empty" || proof?.state === "trusted_generated") &&
    typeof proof.fingerprint === "string" &&
    proof.fingerprint.length > 0
  );
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
 * removes ONLY audit-proven `disposable_candidate` loop worktrees plus (FIX-1454)
 * verifiably-merged standalone ephemeral branches, and only as many
 * (worktrees lowest-path-first, then branches by name) as are needed to bring the
 * canary total back under `threshold`. It never selects a path/ref for being old
 * or merely counted.
 */
export function planWorktreeCleanup(
  audit: WorktreeAuditOutput,
  threshold: number,
  standaloneMergedBranches: readonly CleanupBranchCandidate[] = [],
  scope?: { readonly workspaceId: string },
): WorktreeCleanupPlan {
  const managedWorktrees = scope === undefined
    ? audit.records.filter((record) => record.owner === "loop")
    : audit.records.filter((record) => record.owner === "workspace");
  const canaryTotal = audit.ephemeralBranches.length + managedWorktrees.length;
  const excess = canaryTotal - threshold;

  // The removable pool: audit-proven safe candidates, deterministically ordered.
  // FIX-1460: includes reclaimable ORPHAN dirs (deregistered from git) alongside
  // disposable registered worktrees — each removal drops the canary total by one.
  const pool = audit.records
    .filter((record) => {
      if (scope !== undefined) {
        return record.owner === "workspace" && record.workspaceId === scope.workspaceId && isSafelyDisposable(record);
      }
      return isSafelyDisposable(record) || isReclaimableOrphan(record);
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const branchPool = [...standaloneMergedBranches].sort((a, b) => a.branch.localeCompare(b.branch));

  // Take the MINIMUM needed to clear pressure (never more). Worktrees first
  // (lowest-path), then merged standalone branches — each removal drops the
  // canary total by one. If already under threshold, the minimal set is empty
  // even though disposables/merged branches exist.
  const excessN = excess > 0 ? excess : 0;
  const chosen = pool.slice(0, Math.min(excessN, pool.length));
  const remainingExcess = excessN - chosen.length;
  const chosenBranches = branchPool.slice(0, Math.min(remainingExcess, branchPool.length));
  const chosenPaths = new Set(chosen.map((r) => r.path));

  const candidates: CleanupCandidate[] = chosen.map((r) => {
    const orphan = isReclaimableOrphan(r);
    return {
      path: r.path,
      ...(r.cycleId ? { cycleId: r.cycleId } : {}),
      ...(r.branch ? { branch: r.branch } : {}),
      ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
      ...(r.repoId ? { repoId: r.repoId } : {}),
      ...(r.repositoryAlias ? { repositoryAlias: r.repositoryAlias } : {}),
      ...(r.cachePath ? { cachePath: r.cachePath } : {}),
      // An orphan has no registered HEAD; apply skips the head check for rm_dir.
      expectedHead: orphan ? "" : (r.head as string),
      ...(orphan ? { expectedOrphanFingerprint: r.orphanRecoveryProof?.fingerprint as string } : {}),
      reason: orphan ? ("orphan_reclaimable" as const) : ("disposable_candidate" as const),
      reclaim: orphan ? ("rm_dir" as const) : ("git_worktree" as const),
    };
  });

  // Everything not chosen is preserved — including disposables held back because
  // the minimal set already cleared the pressure.
  const preserved: PreservedRecord[] = audit.records
    .filter((r) => !chosenPaths.has(r.path))
    .map((r) => ({ path: r.path, disposition: r.disposition, reason: r.reason }));

  const countedWorktrees = managedWorktrees.map((r) => ({
    path: r.path,
    disposition: r.disposition,
  }));

  return {
    schema: 1,
    generatedAt: audit.generatedAt,
    threshold,
    canaryTotal,
    projectedTotal: canaryTotal - candidates.length - chosenBranches.length,
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
  removeWorktree?: (repositoryRoot: string, path: string) => { ok: boolean; detail: string };
  /** FIX-1460: reclaim one orphan loop dir via a bounded rm. Injectable for tests. */
  reclaimOrphanDir?: (
    repositoryRoot: string,
    path: string,
    expectedFingerprint: string,
  ) => { ok: boolean; detail: string };
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

function defaultRemoveWorktree(repositoryRoot: string, path: string): { ok: boolean; detail: string } {
  let gitErr = "";
  try {
    // Remove ONLY this validated path. --force tolerates untracked scratch, but
    // tracked dirt was already rejected by the immediately-preceding fresh audit
    // (isSafelyDisposable requires dirtyTracked === false), and a disposable
    // candidate is merged (ancestor/pr-equivalent) so no unpublished commit is
    // pinned solely by this worktree.
    execFileSync("git", ["-C", repositoryRoot, "worktree", "remove", "--force", path], {
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
    if (!isBoundedLoopWorktreeDir(repositoryRoot, path)) {
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
    execFileSync("git", ["-C", repositoryRoot, "worktree", "prune", "--expire", "now"], {
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
function defaultReclaimOrphanDir(
  repositoryRoot: string,
  path: string,
  expectedFingerprint: string,
): { ok: boolean; detail: string } {
  if (!isBoundedLoopWorktreeDir(repositoryRoot, path)) {
    return { ok: false, detail: `refused: ${path} is outside .roll/loop/worktrees` };
  }
  const finalAudit = auditWorktrees({ repoRoot: repositoryRoot, home: homedir() });
  const record = finalAudit.records.find((candidate) => resolve(candidate.path) === resolve(path));
  if (!record) {
    return { ok: false, detail: "missing: orphan dir no longer appears in the final audit" };
  }
  if (!isReclaimableOrphan(record) || record.orphanRecoveryProof?.fingerprint !== expectedFingerprint) {
    return {
      ok: false,
      detail:
        `changed-proof: expected ${expectedFingerprint}, found ` +
        `${record.orphanRecoveryProof?.fingerprint ?? record.disposition}`,
    };
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
  const reclaimOrphanFn = options.reclaimOrphanDir ?? defaultReclaimOrphanDir;
  const removeBranchFn = options.removeBranch ?? defaultRemoveBranch;
  const emit = options.emit ?? (() => {});
  const nowMs = options.nowMs ?? (() => Date.now());

  const removed: CleanupRemoval[] = [];
  const branchesRemoved: BranchRemoval[] = [];
  const refused: CleanupRefusal[] = [];

  for (const candidate of plan.candidates) {
    // Re-derive action from a FRESH audit — never from the (possibly stale) plan.
    const fresh = auditFn();
    const rec = fresh.records.find((r) => resolve(r.path) === resolve(candidate.path));

    const refuse = (reason: string): void => {
      refused.push({ path: candidate.path, reason });
      emit({ type: "worktree_cleanup_refused", path: candidate.path, reason, ts: nowMs() });
    };

    if (!rec) {
      refuse(
        candidate.reclaim === "rm_dir"
          ? "missing: orphan dir no longer present (already reclaimed)"
          : "missing: worktree no longer registered (already removed or pruned)",
      );
      continue; // fail closed for this candidate; never substitute another
    }
    if (rec.active) {
      refuse("active: worktree activated concurrently (fresh lock/heartbeat)");
      continue;
    }

    if (
      candidate.workspaceId !== undefined &&
      (
        rec.owner !== "workspace" ||
        rec.workspaceId !== candidate.workspaceId ||
        rec.repoId !== candidate.repoId ||
        rec.repositoryAlias !== candidate.repositoryAlias ||
        rec.cachePath !== candidate.cachePath ||
        rec.ownershipState !== "verified"
      )
    ) {
      refuse("identity: fresh audit no longer matches the planned Workspace/repository ownership");
      continue;
    }

    // FIX-1460 (#1468): ORPHAN reclaim path. A deregistered dir has no git
    // metadata, so head/dirty checks do not apply — safety is the fresh audit
    // STILL classifying it `orphan_reclaimable` (owning cycle provably delivered).
    // Reclaim is a bounded directory delete, never `git worktree remove`.
    if (candidate.reclaim === "rm_dir") {
      if (!isReclaimableOrphan(rec)) {
        refuse(`disposition: fresh audit reports '${rec.disposition}' (orphan no longer provably delivered)`);
        continue;
      }
      const freshFingerprint = rec.orphanRecoveryProof?.fingerprint;
      if (
        typeof candidate.expectedOrphanFingerprint !== "string" ||
        candidate.expectedOrphanFingerprint.length === 0 ||
        freshFingerprint !== candidate.expectedOrphanFingerprint
      ) {
        refuse(
          `changed-proof: expected ${candidate.expectedOrphanFingerprint ?? "none"}, ` +
          `found ${freshFingerprint ?? "none"}`,
        );
        continue;
      }
      const removal: CleanupRemoval = {
        path: rec.path,
        expectedHead: "",
        reclaim: "rm_dir",
        ...(rec.cycleId ? { cycleId: rec.cycleId } : {}),
      };
      if (options.dryRun) {
        removed.push(removal);
        continue;
      }
      const result = reclaimOrphanFn(repositoryRoot, rec.path, freshFingerprint);
      if (!result.ok) {
        refuse(`reclaim-failed: ${result.detail}`);
        continue;
      }
      removed.push(removal);
      emit({
        type: "worktree_cleanup_applied",
        path: rec.path,
        expectedHead: "",
        ...(rec.cycleId ? { cycleId: rec.cycleId } : {}),
        ts: nowMs(),
      });
      continue;
    }

    // Registered-worktree removal path — strict git-backed revalidation.
    if (rec.head !== candidate.expectedHead) {
      refuse(`changed-head: expected ${candidate.expectedHead}, found ${rec.head ?? "none"}`);
      continue;
    }
    if (rec.dirtyTracked === true) {
      refuse("dirty: tracked changes appeared after planning");
      continue;
    }
    if (rec.dirtyTracked === "unknown") {
      refuse("dirty-unknown: could not confirm a clean tracked tree");
      continue;
    }
    if (!isSafelyDisposable(rec)) {
      refuse(`disposition: fresh audit reports '${rec.disposition}' (${rec.mergeEvidence.kind})`);
      continue;
    }

    const removal: CleanupRemoval = {
      path: rec.path,
      expectedHead: candidate.expectedHead,
      reclaim: "git_worktree",
      ...(rec.branch ? { branch: rec.branch } : {}),
      ...(rec.cycleId ? { cycleId: rec.cycleId } : {}),
      ...(rec.workspaceId ? { workspaceId: rec.workspaceId } : {}),
      ...(rec.repoId ? { repoId: rec.repoId } : {}),
      ...(rec.repositoryAlias ? { repositoryAlias: rec.repositoryAlias } : {}),
      ...(rec.cachePath ? { cachePath: rec.cachePath } : {}),
    };

    if (options.dryRun) {
      // Revalidated as removable, but perform NO git mutation under dry-run.
      removed.push(removal);
      continue;
    }

    const result = removeFn(repositoryRoot, rec.path);
    if (!result.ok) {
      refuse(`remove-failed: ${result.detail}`);
      continue;
    }
    removed.push(removal);
    emit({
      type: "worktree_cleanup_applied",
      path: rec.path,
      expectedHead: candidate.expectedHead,
      ...(rec.branch ? { branch: rec.branch } : {}),
      ...(rec.cycleId ? { cycleId: rec.cycleId } : {}),
      ts: nowMs(),
    });
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

      const removalB: BranchRemoval = {
        branch: bc.branch,
        expectedSha: bc.expectedSha,
        mergeKind: mk,
        ...(bc.workspaceId === undefined ? {} : { workspaceId: bc.workspaceId }),
        ...(bc.repoId === undefined ? {} : { repoId: bc.repoId }),
        ...(bc.cachePath === undefined ? {} : { cachePath: bc.cachePath }),
      };
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
  const worktrees = audit.records
    .filter((r) => r.owner === "loop")
    .map((r) => ({ path: r.path, disposition: r.disposition }));
  const total = audit.ephemeralBranches.length + worktrees.length;

  const disposable = worktrees.filter((w) => w.disposition === "disposable_candidate").length;
  const branchLines = audit.ephemeralBranches.length
    ? audit.ephemeralBranches.map((b) => `  - branch ${b}`).join("\n")
    : "  - (none)";
  const wtLines = worktrees.length
    ? worktrees.map((w) => `  - worktree ${w.path} [${w.disposition}]`).join("\n")
    : "  - (none)";

  const alert =
    `# ALERT — loop auto-paused: branch/worktree leak canary tripped (US-LOOP-096 / FIX-1273)\n\n` +
    `**Leak count**: ${total} (ephemeral branches ${audit.ephemeralBranches.length} + ` +
    `worktrees ${worktrees.length}) > threshold ${threshold}\n\n` +
    `**Counted ephemeral branches**:\n${branchLines}\n\n` +
    `**Counted loop worktrees (with audit disposition)**:\n${wtLines}\n\n` +
    `**Safe recovery**: ${disposable} worktree(s) audit as \`disposable_candidate\`.\n` +
    `  1. Inspect + plan (no mutation): \`roll worktree cleanup --dry-run\`\n` +
    `  2. Apply the audited minimal set:  \`roll worktree cleanup --apply\`\n` +
    `  3. Resume the loop explicitly:     \`roll loop resume\`\n` +
    `  Preserved (unpublished / dirty / active / external) worktrees are NEVER removed.\n`;

  const event: RollEvent = {
    type: "branch_canary_tripped",
    total,
    threshold,
    ephemeralBranches: [...audit.ephemeralBranches],
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

export function renderPlanHuman(
  plan: WorktreeCleanupPlan,
  mode: "dry-run" | "apply",
  scope: "loop" | "workspace" = "loop",
): string {
  const lines: string[] = [];
  const worktreeLabel = scope === "workspace" ? "Workspace Issue worktree(s)" : "loop worktree(s)";
  const worktreeHeading = scope === "workspace" ? "counted Workspace Issue worktrees" : "counted loop worktrees";
  lines.push(`Worktree cleanup (${mode})`);
  lines.push("");
  lines.push(`  canary count: ${plan.canaryTotal} (threshold ${plan.threshold})`);
  lines.push(
    `  counted: ${plan.countedBranches.length} ephemeral branch(es) + ` +
      `${plan.countedWorktrees.length} ${worktreeLabel}`,
  );
  lines.push("");

  lines.push("counted ephemeral branches");
  if (plan.countedBranches.length === 0) lines.push("  (none)");
  for (const b of plan.countedBranches) lines.push(`  ${b}`);
  lines.push("");

  lines.push(worktreeHeading);
  if (plan.countedWorktrees.length === 0) lines.push("  (none)");
  for (const w of plan.countedWorktrees) lines.push(`  ${rel(w.path)}  [${w.disposition}]`);
  lines.push("");

  if (plan.candidates.length === 0 && plan.branchCandidates.length === 0) {
    if (plan.canaryTotal <= plan.threshold) {
      lines.push("No cleanup needed — canary count is already within threshold.");
    } else {
      lines.push(
        "No disposable candidates — every counted worktree is preserved " +
          "(unpublished / dirty / active / external) and no counted standalone branch " +
          "is verifiably merged. Canary pressure cannot be cleared by cleanup; " +
          "inspect the preserved worktrees/branches manually.",
      );
    }
    lines.push("");
    return lines.join("\n").trimEnd() + "\n";
  }

  lines.push(`minimal candidate set (${plan.canaryTotal} → ${plan.projectedTotal})`);
  for (const c of plan.candidates) {
    const tags = [c.branch, c.cycleId].filter(Boolean).join(" ");
    const label = c.reclaim === "rm_dir" ? "orphan_reclaimable · bounded rm" : "disposable_candidate";
    const kind = c.reclaim === "rm_dir" ? "orphan  " : "worktree";
    lines.push(`  ${kind} ${rel(c.path)}${tags ? "  " + tags : ""}  [${label}]`);
  }
  for (const b of plan.branchCandidates) {
    lines.push(`  branch   ${b.branch}  ${b.expectedSha.slice(0, 9)}  [merged: ${b.mergeKind}]`);
  }
  lines.push("");

  // Preserved orphan dirs remain counted + visible. Cleanup offers no review-only
  // override: the operator must rescue or remove untrusted material first, then
  // rerun audit so a complete path-specific proof can authorize the exact path.
  const preservedOrphans = plan.preserved.filter((p) => p.disposition === "preserved_orphan");
  if (preservedOrphans.length > 0) {
    lines.push(`preserved orphan dirs (${preservedOrphans.length}) — visible + counted, never auto-deleted`);
    for (const p of preservedOrphans) lines.push(`  ${rel(p.path)}  — ${p.reason}`);
    lines.push("  Resolve or rescue the reported material, then rerun audit; preserved proof cannot be overridden.");
    lines.push("");
  }

  if (mode === "dry-run") {
    lines.push("Dry run — no git state changed.");
    lines.push("Apply the audited set with: roll worktree cleanup --apply");
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function renderResultHuman(result: WorktreeCleanupResult): string {
  const lines: string[] = [];
  lines.push("Worktree cleanup (apply)");
  lines.push("");
  if (result.removed.length > 0) {
    lines.push(`removed worktrees (${result.removed.length})`);
    for (const r of result.removed) lines.push(`  ${rel(r.path)}  ${r.expectedHead}`);
    lines.push("");
  }
  if (result.branchesRemoved.length > 0) {
    lines.push(`removed branches (${result.branchesRemoved.length})`);
    for (const b of result.branchesRemoved) lines.push(`  ${b.branch}  ${b.expectedSha.slice(0, 9)}  [${b.mergeKind}]`);
    lines.push("");
  }
  if (result.refused.length > 0) {
    lines.push(`refused — fail closed, no substitution (${result.refused.length})`);
    for (const r of result.refused) lines.push(`  ${rel(r.path)}  ${r.reason}`);
    lines.push("");
  }
  const anyRemoved = result.removed.length > 0 || result.branchesRemoved.length > 0;
  if (!anyRemoved && result.refused.length === 0) {
    lines.push("Nothing to remove — no revalidated candidates.");
    lines.push("");
  }
  if (anyRemoved) {
    lines.push("Resume the loop explicitly when ready: roll loop resume");
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// ─── CLI command ─────────────────────────────────────────────────────────────

export const CLEANUP_USAGE =
  "Usage: roll worktree cleanup [--dry-run | --apply] [--json] [--workspace <id|path> | --repo <path>]\n" +
  "  Safely recover from branch/worktree canary pressure using the worktree\n" +
  "  audit as the SOLE authority. Removes ONLY revalidated `disposable_candidate`\n" +
  "  legacy loop or Workspace Issue worktrees, plus standalone ephemeral\n" +
  "  branches that are verifiably delivered and attached to no worktree. Delivery\n" +
  "  is PROVEN by one of: every commit is an ancestor of the integration branch;\n" +
  "  `git cherry` shows every commit already has an equivalent patch upstream; or\n" +
  "  (FIX-1471, squash merges) the branch tip tree is byte-identical to the merge\n" +
  "  commit of the branch's OWN merged GitHub PR (matched by exact head ref) AND\n" +
  "  that merge commit is an ancestor of the integration branch. A merged PR alone\n" +
  "  is NEVER sufficient, and no arbitrary same-tree commit on the integration\n" +
  "  branch is ever used. Never a path/ref that is merely old or counted, and never\n" +
  "  a preserved (unpublished / dirty / active / external / current / protected /\n" +
  "  unmerged) one.\n" +
  "\n" +
  "  Always dry-run first. Default (no flag) is --dry-run.\n" +
  "  --dry-run  print counted refs/dirs, audit dispositions, and the minimal\n" +
  "             candidate set to clear pressure. Never mutates git state.\n" +
  "  --apply    re-run the audit before EVERY removal; remove only revalidated\n" +
  "             candidates via git, prune registration, emit events. A changed\n" +
  "             head / new dirt / missing path / concurrent activation fails\n" +
  "             closed (no substitution). Then resume explicitly: roll loop resume\n" +
  "  --json     emit the schema-1 plan (dry-run) or result (apply) as JSON\n" +
  "  --workspace resolve Issue ownership through the Workspace registry; every\n" +
  "             mutation holds the machine repository lock and requires exact\n" +
  "             Workspace/Story/repository identity plus delivery proof\n" +
  "  --repo     explicit historical repo-local/migration input (default: current directory)\n" +
  "  --reclaim-orphan <path>  legacy --repo mode only: bounded-rm ONE named orphan loop dir\n" +
  "             only when the fresh audit supplies the same complete path-specific proof\n" +
  "             required by --apply: delivered + inactive, no Git ownership metadata,\n" +
  "             trusted generated residue only, and an unchanged material fingerprint.\n" +
  "             Preserved or ambiguous orphans can never be overridden.\n" +
  "\n" +
  "  安全清理:仅移除审计判定为已合并、干净、非活跃的 disposable_candidate;\n" +
  "  先跑 --dry-run,再 --apply,最后手动 roll loop resume。";

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
      .filter((r) => (r.owner === "loop" || r.owner === "workspace") && typeof r.branch === "string" && r.branch !== "")
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
    reclaimOrphanDir?: (
      repositoryRoot: string,
      path: string,
      expectedFingerprint: string,
    ) => { ok: boolean; detail: string };
    emit?: (event: RollEvent) => void;
    nowMs?: () => number;
  },
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(CLEANUP_USAGE + "\n");
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

  const fullDeps: WorktreeAuditDeps = {
    repoRoot,
    home: deps?.home ?? homedir(),
    git: deps?.git,
    readFile: deps?.readFile,
    readDir: deps?.readDir,
    inspectOrphanDir: deps?.inspectOrphanDir,
    nowISO: deps?.nowISO,
    nowSec: deps?.nowSec,
    integrationBranch: deps?.integrationBranch,
  };

  // Legacy exact-path route. It is NOT a manual override: the same complete
  // path-specific proof required by --apply must be fresh and reclaimable.
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
    if (!isReclaimableOrphan(rec)) {
      process.stderr.write(`refused: ${named} lacks a complete reclaimable orphan proof (${rec.disposition}).\n`);
      return 2;
    }
    if (!isBoundedLoopWorktreeDir(repoRoot, rec.path)) {
      process.stderr.write(`refused: ${named} is outside .roll/loop/worktrees.\n`);
      return 2;
    }
    const reclaimFn = deps?.reclaimOrphanDir ?? defaultReclaimOrphanDir;
    const r = reclaimFn(repoRoot, rec.path, rec.orphanRecoveryProof?.fingerprint as string);
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
    ...(deps?.reclaimOrphanDir ? { reclaimOrphanDir: deps.reclaimOrphanDir } : {}),
    emit,
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
