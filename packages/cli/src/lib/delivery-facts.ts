/**
 * US-DELIV-008 — the SINGLE reconcile fact-gathering adapter, shared by the
 * `roll loop reconcile` command and the `roll loop cycles` read path so both
 * feed the SAME pure `reconcileDelivery` (packages/core/src/delivery/
 * reconcile.ts) the SAME facts. One engine, two callers — the read path no
 * longer runs a parallel subject-match probe (cycleMergeTruth, retired).
 *
 * Fact layers (design §3.3):
 *   L1  PR state — online via gh (command path) OR offline via
 *       {@link offlineMergeEvidence}: a `(#N)` squash commit reachable from
 *       main IS PR-state evidence recorded on main; gh is merely the online
 *       view of the same fact. For PR-less legacy cycles a commit subject
 *       naming the story is the fallback (cycle-accurate: never when a PR
 *       number is recorded — FIX-350).
 *   L2  patch-id equivalence — `git patch-id(diff origin/main...branch)` ∈
 *       the patch-id set of main's commits NOT on the branch. Squash/rebase
 *       safe, fully offline.
 *
 * `cycleReconcileDecision` is deliberately cheap-first: offline L1 is a pure
 * string match over the already-collected git snapshot, so a row whose merge
 * is visible in main's log costs ZERO spawns; the per-branch patch-id spawns
 * only run when L1 is silent.
 *
 * RL-TRUTH-001: registered redline in policy/rules.yaml — this module is the
 * CLI/infra adapter side of the merged-truth redline: it gathers the gh/git
 * facts and defers every verdict to the pure `reconcileDelivery` in @roll/core
 * (packages/core/src/delivery/reconcile.ts), never deciding delivery itself.
 */
import { nodeExecPort, reconcileDelivery, type ReconcileCycle, type ReconcileFacts, type ReconcileResult } from "@roll/core";
import { resolveIntegrationBranch } from "@roll/infra";
import { gitHasPrMergeCommit, storyHasMergeEvidence, type GitDossierFacts } from "./story-dossier.js";

// ── git / gh fact primitives (extracted from loop-reconcile.ts, US-DELIV-002) ──

export function resolveRepoSlug(cwd: string): string | undefined {
  const r = nodeExecPort.run("git", ["-C", cwd, "remote", "get-url", "origin"]);
  if (r.code !== 0 || r.stdout === "") return undefined;
  const url = r.stdout.trim();
  const m =
    /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/.exec(url) ??
    /git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/.exec(url);
  return m?.groups !== undefined ? `${m.groups.owner}/${m.groups.repo}` : undefined;
}

export function branchExists(cwd: string, branch: string): boolean {
  const r = nodeExecPort.run("git", [
    "-C", cwd, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`,
  ]);
  return r.code === 0 && r.stdout.trim() !== "";
}

/**
 * Compute the git patch-id of `git diff origin/main...<branch>`.
 * Returns undefined when the branch doesn't exist or the diff is empty.
 */
export function branchPatchId(
  cwd: string,
  branch: string,
  integrationBranch: string = "origin/main",
): string | undefined {
  if (!branchExists(cwd, branch)) return undefined;
  // git patch-id reads the diff from stdin. E1: the diff base is the configured
  // integration branch (default origin/main); origin/<branch> is the STORY branch
  // and is never rewritten.
  const result = nodeExecPort.run("sh", [
    "-c",
    `cd '${cwd}' && git diff ${integrationBranch}...origin/${branch} 2>/dev/null | git patch-id --stable 2>/dev/null`,
  ]);
  if (result.code !== 0 || result.stdout === "") return undefined;
  // git patch-id output is "<hash> <patch-id>".
  const parts = result.stdout.trim().split(/\s+/);
  return parts[0] ?? undefined;
}

/**
 * Collect patch-ids from candidate merge commits on main since the branch's
 * fork point — commits on main that are NOT on the branch
 * (`git log origin/main ^origin/<branch>`). US-DELIV-008 fixed the scan to
 * match this docstring: the earlier symmetric-difference form
 * (`origin/main...origin/<branch>`) ALSO walked the branch's OWN commits, so
 * an unmerged single-commit branch's patch-id self-matched and fabricated a
 * `delivered` — the exact misjudgment reconcile exists to prevent.
 */
export function mainPatchIdsSinceBranch(
  cwd: string,
  branch: string,
  integrationBranch: string = "origin/main",
): Set<string> {
  const ids = new Set<string>();
  if (!branchExists(cwd, branch)) return ids;

  // E1: walk the integration branch's commits not on the story branch
  // (`<integrationBranch> ^origin/<branch>`); the story branch stays untouched.
  const commits = nodeExecPort.run("git", [
    "-C", cwd,
    "log",
    "--format=%H",
    integrationBranch,
    `^origin/${branch}`,
  ]);
  if (commits.code !== 0 || commits.stdout === "") return ids;

  const shas = commits.stdout.trim().split("\n").filter(Boolean);
  for (const sha of shas) {
    // The diff of this one commit (vs its parent).
    const diff = nodeExecPort.run("git", ["-C", cwd, "diff", `${sha}^!`]);
    if (diff.code !== 0 || diff.stdout === "") continue;
    const pid = nodeExecPort.run("sh", [
      "-c",
      `echo '${diff.stdout.replace(/'/g, "'\\''")}' | git -C '${cwd}' patch-id --stable 2>/dev/null`,
    ]);
    if (pid.code === 0 && pid.stdout !== "") {
      const parts = pid.stdout.trim().split(/\s+/);
      if (parts[0] !== undefined) ids.add(parts[0]);
    }
  }
  return ids;
}

// ── offline L1 ──────────────────────────────────────────────────────────────

/**
 * Offline PR-state evidence from main's git log — the read-path's L1 and the
 * command path's fallback when gh is silent:
 *   - a recorded PR number: main carries a `(#N)` / `PR #N` merge commit for
 *     EXACTLY that PR (cycle-accurate — the story-id grep is NOT consulted,
 *     FIX-350), or
 *   - no recorded PR number (legacy cycles): a main commit subject names the
 *     story (FIX-278 merge evidence).
 * Returns "MERGED" or undefined — never OPEN/CLOSED: absence of a merge
 * commit proves nothing about an open PR, so the caller leaves prState unset.
 */
export function offlineMergeEvidence(
  facts: GitDossierFacts | null,
  storyId: string,
  prNumber: number | undefined,
): "MERGED" | undefined {
  if (facts === null) return undefined;
  if (prNumber !== undefined) {
    return gitHasPrMergeCommit(facts, prNumber) ? "MERGED" : undefined;
  }
  return storyId !== "" && storyHasMergeEvidence(facts, storyId) ? "MERGED" : undefined;
}

// ── the unified decision ────────────────────────────────────────────────────

/** A cycle the ledger/reconciler wants judged (branch falls back to the
 *  `loop/<cycleId>` convention when the caller has none recorded). */
export interface CycleReconcileTarget {
  cycleId: string;
  storyId: string;
  branch?: string;
  prNumber?: number;
}

/**
 * Judge one cycle through the SINGLE truth engine: gather offline facts
 * (L1 from main's log, L2 from patch-ids) and run the pure
 * `reconcileDelivery`. `git` is the dossier snapshot the caller already
 * built for the render (null → L1 silent, L2 still runs).
 *
 * Cheap-first: when offline L1 fires, L2's per-branch spawns are skipped —
 * L1 MERGED is authoritative inside reconcileDelivery anyway.
 */
export function cycleReconcileDecision(
  cwd: string,
  git: GitDossierFacts | null,
  target: CycleReconcileTarget,
): ReconcileResult {
  const branch = target.branch ?? `loop/${target.cycleId}`;
  const facts: ReconcileFacts = {
    mainPatchIds: new Set(),
    backlogDone: false,
    attestPresent: false,
  };

  // L1 (offline): merge evidence recorded on main.
  if (offlineMergeEvidence(git, target.storyId, target.prNumber) === "MERGED") {
    facts.prState = "MERGED";
  } else {
    // L2: patch-id equivalence (only when L1 is silent — it would win anyway).
    // E1: judged against the project's configured integration branch.
    const integrationBranch = resolveIntegrationBranch(cwd);
    facts.branchNetPatchId = branchPatchId(cwd, branch, integrationBranch);
    if (facts.branchNetPatchId !== undefined) {
      facts.mainPatchIds = mainPatchIdsSinceBranch(cwd, branch, integrationBranch);
    }
  }

  const cyc: ReconcileCycle = {
    cycleId: target.cycleId,
    storyId: target.storyId,
    branch,
    prNumber: target.prNumber,
    deliveryState: "awaiting_merge",
  };
  return reconcileDelivery(cyc, facts);
}
