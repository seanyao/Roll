/**
 * PRLifecycle — TS port of the v2 loop "publish a cycle PR / dedup open PRs /
 * wait for merge / GC merged cycle branches" delivery path.
 *
 * Card AC (US-CORE-005): 开 PR、查已有 PR、等 CI、等 merge、关分支. Modelled as
 * DECISION functions (what to check, in what order) + a COMMAND-PLAN (the ordered
 * list of `gh`/git invocations to run) so core never spawns a process itself; an
 * adapter (`infra-default.ts`-style {@link ExecPort}) executes the plan in
 * integration tests.
 *
 * v2 oracle (frozen bash, bin/roll) — read fully before any change here:
 *   - branch naming: CYCLE_ID = `<date +%Y%m%d-%H%M%S>-<pid>` (bin/roll:8828);
 *     BRANCH = `loop/cycle-${CYCLE_ID}` (bin/roll:8831). {@link cycleBranchName}.
 *   - `_loop_publish_pr <branch> [title]`           (bin/roll:13498-13541): the
 *     primary publish sequence — push → reuse-or-create PR → arm auto-merge.
 *     {@link planPublishPr}. Exit codes: 0 ok / 1 push|create fail / 2 gh-missing.
 *   - `_loop_publish_doc_pr <branch> [title]`       (bin/roll:13647-13680): the
 *     doc-only variant — push → reuse-or-create → `pr merge --admin` (no CI wait).
 *     {@link planPublishDocPr}.
 *   - the cycle-end publish dispatch + multi-tier fallback (bin/roll:9200-9341):
 *     doc-only? doc-pr : pr; then branch on publish status —
 *       0 → done (hand merge progression to the reconciler);
 *       2 (gh missing) → `_worktree_merge_back` (ff) → else orphan push;
 *       other (PR-fail) → orphan push.
 *     {@link decidePublishOutcome} mirrors the status→outcome branching only
 *     (the surrounding worktree/event bookkeeping stays in the loop runner — see
 *     "documented-not-difftested" below).
 *   - `_loop_wait_pr_merge <branch>`                (bin/roll:13580-13599): poll
 *     `gh pr view --json state` every 30s up to ROLL_PR_MERGE_TIMEOUT (600s);
 *     MERGED→0, CLOSED→1, timeout→1. Reimplemented as the pure step function
 *     {@link nextWaitAction} (no real sleeps in core; the loop owns the clock).
 *   - `_loop_emit_pr_final <branch>`                (bin/roll:13557-13573): map
 *     gh state → terminal outcome (MERGED→merged / CLOSED→closed / *→open).
 *     {@link prStateToOutcome}.
 *   - `_loop_pr_claimed_stories`                    (bin/roll:12533-12562): walk
 *     open `loop/*` PRs, read each branch's .roll/backlog.md, collect 🔨 In
 *     Progress ids. The open-PR dedup the picker (US-CORE-004, FIX-141/146)
 *     consumes. {@link parseClaimedIdsFromBacklog} ports the awk id extraction;
 *     the orchestration (multiple gh calls) is the injected adapter's job.
 *   - ephemeral-branch recognition: {@link isEphemeralBranch} /
 *     {@link EPHEMERAL_BRANCH_PREFIXES}. (US-LOOP-096 removed the old
 *     ancestry-based staleness predicate — remote GC uses PR state, not
 *     `merge-base --is-ancestor`; see US-LOOP-097.)
 *
 * documented-not-difftested (entangled with worktree/event side effects, ported
 * as behaviour from a careful reading — NOT byte-diffed against bash):
 *   - the cycle-end fallback ladder bin/roll:9200-9341 (worktree cleanup, event
 *     emission, runs.jsonl rows, roll-meta branches). {@link decidePublishOutcome}
 *     captures ONLY the status→outcome decision; everything else stays in the
 *     loop runner and is out of scope for this core port.
 *   - `_loop_publish_pr`'s `_worktree_alert` side-effects and `_loop_event`
 *     emission — the command PLAN lists the gh/git steps; alert/event wiring is
 *     the caller's.
 *
 * Purity: this module never spawns `gh`/git, never sleeps, never reads the clock.
 * Branch derivation, the publish command PLAN, the wait step function, and the
 * parse helpers are all pure. {@link infra-default.ts ExecPort} wraps execFileSync
 * for the integration adapter.
 */
import { STATUS_MARKER } from "@roll/spec";

// ── Cycle branch naming (mirrors bin/roll:8828-8831) ─────────────────────────

/**
 * The cycle id the loop stamps onto a branch: `<timestamp>-<pid>`. bash builds
 * it as `$(date +%Y%m%d-%H%M%S)-$$`. Pure: the timestamp + pid are injected.
 */
export function cycleId(timestamp: string, pid: number): string {
  return `${timestamp}-${pid}`;
}

/** The ephemeral branch name for a cycle: `loop/cycle-<cycleId>`. Mirrors
 *  bin/roll:8831 `BRANCH="loop/cycle-${CYCLE_ID}"`. */
export function cycleBranchName(cid: string): string {
  return `loop/cycle-${cid}`;
}

/** Strip the `loop/` prefix the publish titles default on (`${branch#loop/}`). */
export function branchTitleSuffix(branch: string): string {
  return branch.startsWith("loop/") ? branch.slice("loop/".length) : branch;
}

// ── Publish command PLAN (mirrors _loop_publish_pr / _loop_publish_doc_pr) ────

/** One step in a publish plan: a `gh` or git invocation the adapter runs.
 *  `kind` names the oracle step so the adapter/log can map it 1:1. */
export interface PublishStep {
  kind:
    | "git-push"
    | "gh-pr-view"
    | "gh-pr-create"
    | "gh-pr-merge-auto"
    | "gh-pr-merge-admin";
  /** argv for the tool (`git`/`gh`), in oracle order. */
  argv: string[];
  /** The tool to invoke. */
  tool: "git" | "gh";
}

/** Inputs for building a publish plan. `slug` is the resolved `owner/repo` the
 *  oracle gets from `_gh_resolve`. */
export interface PublishPlanInput {
  branch: string;
  title?: string;
  slug: string;
  /** Body text for `gh pr create` (the oracle composes this with the commit
   *  count; the caller supplies the finished body so core stays string-pure). */
  body: string;
  /** US-EVID-016: auto-created repair work may open a PR, but never arm merge. */
  manualMerge?: boolean;
  /** FIX-909: visible needs-review work opens as a draft PR for independent review. */
  draft?: boolean;
  /**
   * US-CYCLE-009: the branch's real tip sha (from the git plane — the sha just
   * pushed / a `git ls-remote` read), used to head-sha-pin the auto-merge attach
   * (`--match-head-commit`). Guards the PR-API-head-lag trap: GitHub refuses the
   * merge if the branch tip has moved past this sha. Omitted ⇒ no pin
   * (backwards-compatible).
   */
  headSha?: string;
}

/**
 * The ordered command plan for the publish sequence. The adapter runs them in
 * order with the documented short-circuits:
 *   1. `gh -R <slug> pr view <branch>`       — non-empty url ⇒ REUSE, skip create.
 *   2. `gh -R <slug> pr create ...`          — empty url ⇒ return 1.
 *   3. `gh -R <slug> pr merge <branch> --auto --squash --delete-branch`
 *      — failure is non-fatal (oracle returns 0; PR left open for a human).
 * The `view` reuse short-circuit is encoded by the adapter, not the plan order;
 * the plan lists the full sequence and the adapter skips `create` on reuse.
 *
 * US-LOOP-094: the `git push` step is NO LONGER part of this plan. The cycle
 * worktree is detached (no local branch), so the push must run from the worktree
 * cwd as `git push origin HEAD:refs/heads/<branch>` — the terminal handler does
 * that BEFORE running this (gh-only) plan, keeping the same short-circuit
 * (push fail ⇒ status 1, PR steps never run).
 */
export function planPublishPr(input: PublishPlanInput): PublishStep[] {
  const title = input.title ?? `loop cycle ${branchTitleSuffix(input.branch)}`;
  const body = input.manualMerge === true && !input.body.includes("[roll:manual-merge]")
    ? `${input.body}\n\n[roll:manual-merge]`
    : input.body;
  const steps: PublishStep[] = [
    {
      tool: "gh",
      kind: "gh-pr-view",
      argv: ["-R", input.slug, "pr", "view", input.branch, "--json", "url", "-q", ".url"],
    },
    {
      tool: "gh",
      kind: "gh-pr-create",
      argv: [
        "-R",
        input.slug,
        "pr",
        "create",
        ...(input.draft === true ? ["--draft"] : []),
        "--base",
        "main",
        "--head",
        input.branch,
        "--title",
        title,
        "--body",
        body,
      ],
    },
  ];
  if (input.manualMerge === true) return steps;
  // US-CYCLE-009: head-sha-pin the auto-merge attach when the caller resolved the
  // branch tip (--match-head-commit). GitHub then refuses the merge if the tip
  // moved past this sha — closing the PR-API-head-lag window.
  const pin = input.headSha !== undefined && input.headSha !== ""
    ? ["--match-head-commit", input.headSha]
    : [];
  return [
    ...steps,
    {
      tool: "gh",
      kind: "gh-pr-merge-auto",
      argv: ["-R", input.slug, "pr", "merge", input.branch, "--auto", "--squash", "--delete-branch", ...pin],
    },
  ];
}

/**
 * The ordered command plan for `_loop_publish_doc_pr` (bin/roll:13647-13680).
 * Identical to {@link planPublishPr} except the final merge is
 * `--admin --squash --delete-branch` (immediate merge, no CI gate) and the
 * `--admin` merge failure IS fatal in the oracle (returns 1, PR left open).
 */
export function planPublishDocPr(input: PublishPlanInput): PublishStep[] {
  const title = input.title ?? `doc update ${branchTitleSuffix(input.branch)}`;
  const steps = planPublishPr({ ...input, title });
  if (input.manualMerge === true) return steps;
  // Replace the auto-merge tail with the admin merge (US-CYCLE-009: sha-pinned
  // when the tip is known, same head-lag guard as the auto path).
  const pin = input.headSha !== undefined && input.headSha !== ""
    ? ["--match-head-commit", input.headSha]
    : [];
  steps[steps.length - 1] = {
    tool: "gh",
    kind: "gh-pr-merge-admin",
    argv: ["-R", input.slug, "pr", "merge", input.branch, "--admin", "--squash", "--delete-branch", ...pin],
  };
  return steps;
}

// ── Publish outcome decision (mirrors cycle-end ladder bin/roll:9200-9341) ────

/** The publish status the loop branches on (the `_publish_status` of the
 *  `_loop_publish_pr` subshell). 0 ok / 2 gh-missing / anything-else PR-fail. */
export type PublishStatus = 0 | 2 | number;

/** The next remediation action after a publish attempt — the decision the
 *  cycle-end ladder makes, decoupled from worktree/event bookkeeping. */
export type PublishOutcome =
  | { kind: "done" } // status 0 — PR published, awaiting reconciliation.
  | { kind: "merge-back" } // status 2 (gh missing) — try ff merge_back next.
  | { kind: "orphan-push" }; // PR-fail (and the merge_back fallthrough) — push orphan.

/**
 * Decide the remediation action for a publish status, mirroring the top-level
 * branching of bin/roll:9239-9341:
 *   - 0          → done (hand to the reconciler).
 *   - 2          → merge-back (gh unavailable; try ff, then orphan on failure).
 *   - otherwise  → orphan-push (PR publish failed; orphan branch+tag safety net).
 * NOTE: the status-2 path's *secondary* fallthrough to orphan-push (when
 * merge_back itself fails) is the caller's to drive — this function returns the
 * FIRST action for each tier (the loop runner sequences merge-back → orphan).
 */
export function decidePublishOutcome(status: PublishStatus): PublishOutcome {
  if (status === 0) return { kind: "done" };
  if (status === 2) return { kind: "merge-back" };
  return { kind: "orphan-push" };
}

// ── Wait-for-merge step function (mirrors _loop_wait_pr_merge) ────────────────

/** Default merge-wait timeout in seconds (bash ROLL_PR_MERGE_TIMEOUT default). */
export const DEFAULT_PR_MERGE_TIMEOUT = 600;
/** Fixed poll interval in seconds (bash `interval=30`). */
export const PR_MERGE_POLL_INTERVAL = 30;

/** A PR's state as `gh pr view --json state -q .state` reports it. */
export type PrState = "MERGED" | "CLOSED" | "OPEN" | "UNKNOWN" | string;

/** The next action the merge-wait loop should take given the latest poll. */
export type WaitAction =
  | { kind: "merged" } // terminal success (oracle return 0).
  | { kind: "closed" } // terminal failure: PR closed unmerged (oracle return 1).
  | { kind: "timeout" } // elapsed >= timeout, never resolved (oracle return 1).
  | { kind: "wait"; sleepSeconds: number }; // keep polling.

/**
 * Pure step function for `_loop_wait_pr_merge` (bin/roll:13580-13599). Given the
 * elapsed seconds and the latest observed PR state, decide the next action — no
 * real sleeps, no clock. The loop driver calls this each tick:
 *   - MERGED            → { merged }.
 *   - CLOSED            → { closed }.
 *   - elapsed >= timeout (and not resolved) → { timeout }.
 *   - else              → { wait, sleepSeconds: interval }.
 * Mirrors the oracle's check order: the `case "$state"` MERGED/CLOSED check runs
 * at the TOP of each iteration, and the `while (( elapsed < timeout ))` guard
 * gates the next sleep. We therefore resolve a terminal state even at/after the
 * timeout boundary (the oracle reads state before sleeping).
 */
export function nextWaitAction(
  state: PrState,
  elapsedSeconds: number,
  opts: { timeout?: number; interval?: number } = {},
): WaitAction {
  const timeout = opts.timeout ?? DEFAULT_PR_MERGE_TIMEOUT;
  const interval = opts.interval ?? PR_MERGE_POLL_INTERVAL;
  if (state === "MERGED") return { kind: "merged" };
  if (state === "CLOSED") return { kind: "closed" };
  if (elapsedSeconds >= timeout) return { kind: "timeout" };
  return { kind: "wait", sleepSeconds: interval };
}

/** PR terminal outcome label for the dashboard event (mirrors
 *  `_loop_emit_pr_final`'s state→outcome map, bin/roll:13564-13569).
 *  MERGED→merged / CLOSED→closed / everything else (OPEN/UNKNOWN/error)→open. */
export function prStateToOutcome(state: PrState): "merged" | "closed" | "open" {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

// ── Open-PR dedup: claimed-story id extraction (mirrors _loop_pr_claimed_stories)

/**
 * Extract the 🔨 In Progress story ids from a branch's `.roll/backlog.md` body,
 * mirroring the awk in `_loop_pr_claimed_stories` (bin/roll:12551-12557):
 *   - split each line on `|`; consider only rows containing `🔨 In Progress`.
 *   - take field 2 (1-based; the id cell), trim surrounding whitespace.
 *   - strip a leading `[` and everything from the first `]` onward
 *     (`[US-X](url)` → `US-X`).
 *   - keep non-empty ids.
 * The orchestration (list open `loop/*` PRs, fetch each branch's backlog over the
 * gh API, sort -u) is the injected adapter's job; this is the pure parse.
 */
export function parseClaimedIdsFromBacklog(backlog: string): string[] {
  const ids: string[] = [];
  for (const line of backlog.split("\n")) {
    if (!line.includes(STATUS_MARKER.in_progress)) continue;
    const fields = line.split("|");
    // awk $2 is the SECOND field (1-based). JS split index 1.
    let cell = fields[1];
    if (cell === undefined) continue;
    cell = cell.replace(/^[\s]+|[\s]+$/g, "");
    // sub(/^\[/, "") then sub(/\].*$/, "") — strip a leading [ and from ] on.
    cell = cell.replace(/^\[/, "");
    const close = cell.indexOf("]");
    if (close >= 0) cell = cell.slice(0, close);
    if (cell !== "") ids.push(cell);
  }
  return ids;
}

/** De-dupe + sort claimed ids exactly like the oracle's trailing `awk 'NF' |
 *  sort -u` (byte/locale-independent ASCII sort over unique non-empty ids). */
export function dedupeSortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((s) => s !== ""))].sort();
}

// ── Ephemeral branch prefixes ────────────────────────────────────────────────

/** The ephemeral branch prefixes the loop creates / GCs. A branch outside these
 *  prefixes is never auto-deleted. Consumed by the branch canary (US-LOOP-096).
 *
 *  US-LOOP-096: the old ancestry-based staleness predicates (`cycleBranchStatus`
 *  / `isStaleCycleBranch`, keyed on `merge-base --is-ancestor origin/main`) were
 *  removed — they had NO runtime caller and mis-judged squash merges (a squashed
 *  branch tip is not an ancestor of main). Merged-ness for remote GC is decided
 *  by PR state instead (US-LOOP-097), not ancestry. */
export const EPHEMERAL_BRANCH_PREFIXES = ["loop/cycle-", "worktree-agent-", "claude/"] as const;

/** True iff `branch` carries one of the ephemeral prefixes the GC scans. */
export function isEphemeralBranch(branch: string): boolean {
  return EPHEMERAL_BRANCH_PREFIXES.some((p) => branch.startsWith(p));
}
