/**
 * @responsibility Decides the narrow sweep of stranded loop/cycle remote branches.
 * Remote branch GC — narrow "delete stranded loop/cycle-* remote branches"
 * decision (US-LOOP-097, "方案 1 窄 D").
 *
 * `gh pr merge --squash --delete-branch` already removes the remote head when a
 * PR merges. This GC only sweeps the LEFTOVERS: loop/cycle branches that never
 * got (or lost) a PR. The danger (agy/cursor review) is that "no open PR" is NOT
 * sufficient — there are LEGITIMATE no-PR remote branches this must NOT delete:
 *   - FIX-1214 degraded publish: pushed, PR create deferred → in pending-pr-create.
 *   - orphan push: work deliberately parked on the remote for audit/resume.
 *   - a branch just pushed seconds ago, PR not opened yet (age grace).
 * So a branch is deletable ONLY when it clears EVERY guard below. Pure decision;
 * the adapter gathers the sets and performs `git push origin --delete`.
 */

/** Default grace before a stranded branch is eligible (env
 *  ROLL_REMOTE_GC_GRACE_MIN overrides). Protects the push→PR-create window and
 *  gives a human time to notice/rescue. */
export const DEFAULT_REMOTE_GC_GRACE_MIN = 30;

/** Only loop/cycle branches are ever swept (aligns with the ephemeral contract;
 *  rescue is a bundle now, never pushed). */
export const REMOTE_GC_PREFIX = "loop/cycle-";

/**
 * Parse the creation time a `loop/cycle-<YYYYMMDD-HHMMSS>-<pid>` branch embeds,
 * as epoch ms in the LOCAL timezone (the id is minted by `date +%Y%m%d-%H%M%S`
 * locally, so interpreting the components locally and comparing to a local
 * `nowMs` is skew-free). Returns undefined if the name doesn't carry a parseable
 * stamp — the caller treats "unknown age" as NOT deletable (conservative).
 */
export function parseCycleBranchCreatedMs(branch: string): number | undefined {
  const m = /^loop\/cycle-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-|$)/.exec(branch);
  if (m === null) return undefined;
  const t = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  ).getTime();
  return Number.isFinite(t) ? t : undefined;
}

export interface RemoteBranchGcInput {
  /** Candidate remote branch names (e.g. from `git ls-remote --heads origin`). */
  remoteBranches: readonly string[];
  /** Head refs of currently OPEN PRs — never delete these. */
  openPrHeads: ReadonlySet<string>;
  /** Branches queued for deferred PR create (FIX-1214) — never delete. */
  pendingBranches: ReadonlySet<string>;
  /** Branches the runs ledger still tracks as orphan/local/pending_merge — keep. */
  activeRunBranches: ReadonlySet<string>;
  /** Grace in ms; a branch younger than this is kept. */
  graceMs: number;
  /** Current time (epoch ms, local). */
  nowMs: number;
}

/**
 * Return the subset of `remoteBranches` safe to delete: loop/cycle- prefixed,
 * NOT in any protected set, and older than the grace window.
 */
export function selectDeletableRemoteBranches(input: RemoteBranchGcInput): string[] {
  return input.remoteBranches.filter((b) => {
    if (!b.startsWith(REMOTE_GC_PREFIX)) return false;
    if (input.openPrHeads.has(b)) return false;
    if (input.pendingBranches.has(b)) return false;
    if (input.activeRunBranches.has(b)) return false;
    const created = parseCycleBranchCreatedMs(b);
    if (created === undefined) return false; // unknown age → keep (conservative)
    return input.nowMs - created > input.graceMs;
  });
}
