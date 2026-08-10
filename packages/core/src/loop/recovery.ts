/**
 * @responsibility Decides crash recovery and startup preflight from observed debris.
 * Loop crash-recovery & startup preflight — pure decision layer
 * (US-LOOP-002 / v2 FIX-037/040/045/104/114/125/143, invariants I2 / F2 / C2).
 *
 * This module owns the DECISIONS the v2 runner makes at loop start when it finds
 * a crashed previous cycle's debris. It is pure: every probe result (gh PR state,
 * commit counts, file ages, heartbeat liveness, hooks config) is passed in as
 * data, and the functions return an ordered list of ACTIONS for an injected
 * executor (infra) to perform. No spawning, no fs — see packages/infra/src for
 * the I/O primitives (process.ts already ports the lock/heartbeat shapes; this
 * module CONSUMES {@link livenessVerdict}'s contract rather than duplicating it).
 *
 * Three v2 oracle regions are mirrored (bin/roll, frozen):
 *
 *  (1) Orphan STATE self-heal — FIX-037/038 (bin/roll 9424-9481).
 *      At loop start, if `state.yaml` says `status: running` but the cycle is no
 *      longer alive (heartbeat stale beyond ROLL_HEARTBEAT_TIMEOUT=1800, OR lock
 *      pid dead, OR no tmux session), heal `running → idle`, remove the lock,
 *      and append an ALERT row. {@link healStatePlan} decides this from a
 *      liveness verdict (the heartbeat-age math itself lives in infra
 *      process.ts::livenessVerdict — invariant I2, "don't duplicate").
 *
 *  (2) Orphan WORKTREE recovery — FIX-040/045/114, US-LOOP-068 (bin/roll
 *      8857-8910). For each leftover `worktrees/<slug>-cycle-*` dir, in glob
 *      (chronological) order, decide ONE of:
 *        - already MERGED remotely (gh says MERGED)           → cleanup
 *        - has commits ahead of origin/main                   → rebase→publish
 *            → on publish ok: cleanup ; on publish fail: PRESERVE (audit)
 *            → on rebase fail: PRESERVE (conflict/network)
 *        - no commits ahead                                   → cleanup
 *      Contract C2 ("孤儿分支已推远端可审计"): a worktree carrying real commits is
 *      NEVER destroyed before its branch is pushed for audit — publish must
 *      succeed first; a failed publish leaves the worktree preserved.
 *      {@link orphanWorktreePlan} renders these as ordered actions.
 *
 *  (3) Stale-cycle-branch GC + tmp/backup retention — FIX-104/143 (bin/roll
 *      13019-13048 / 10577-10646). A remote ephemeral branch
 *      (`loop/cycle-*`, `worktree-agent-*`, `claude/*`) is deletable iff it is an
 *      ancestor of origin/main (fully merged). Loop-dir debris is deletable by
 *      age: `runs.jsonl.tmp.*` always, `backup-before-merge-*.tgz` > 5d,
 *      `*.migrated-*` > 7d, `*.bak` > retention (env > local.yaml > 30d).
 *      {@link staleBranchDeletable} / {@link gcRetentionVerdict} are the predicates.
 *
 *  NEW (B-group AC) — startup preflight: {@link preflightPlan} composes the
 *  orphan-state heal + a git-hooks readiness check (core.hooksPath wired to
 *  `hooks`, pre-commit present — mirrors `_ensure_hooks_path`, bin/roll
 *  1382-1392, and the TCR pre-commit gate it guards) into a single ordered
 *  action plan: self-heal what's healable, REPORT what is not.
 */
import type { TerminalOutcome } from "@roll/spec";

// ── (1) orphan STATE self-heal (bin/roll 9424-9481) ──────────────────────────

/** v2 default heartbeat liveness threshold (ROLL_HEARTBEAT_TIMEOUT, bin/roll 9430). */
export const HEARTBEAT_TIMEOUT_SEC = 1800;

/**
 * Liveness inputs for {@link healStatePlan} — the THREE signals the v2 heal path
 * consults, in priority order (bin/roll 9441-9466):
 *   1. heartbeat (primary, FIX-038 — avoids PID-reuse races),
 *   2. lock-pid `kill -0` (fallback, pre-FIX-038 cycles),
 *   3. tmux session existence (final).
 * Pass the already-computed verdicts (infra process.ts::livenessVerdict for #1,
 * process.ts PID-liveness for #2). Any ONE being true ⇒ still active ⇒ no heal.
 */
export interface LivenessSignals {
  /** state.yaml `status:` field (only `running` is a heal candidate). */
  status: string;
  /** Heartbeat verdict (infra livenessVerdict): true = fresh ⇒ alive. */
  heartbeatAlive: boolean;
  /** Lock pid `kill -0` result, or `undefined` if no lock file. */
  lockPidAlive: boolean | undefined;
  /** tmux session exists for this slug, or `undefined` if tmux unavailable. */
  tmuxSessionAlive: boolean | undefined;
}

/** A heal action — the executor performs these in order. */
export type HealAction =
  | { kind: "heal_state_to_idle" } // bin/roll 9469: write `status: idle`
  | { kind: "remove_lock" } // bin/roll 9470: `rm -f LOCK`
  | { kind: "append_alert"; message: string }; // bin/roll 9477

/**
 * Decide the orphan-state self-heal — mirrors bin/roll 9437-9480.
 *
 * Returns an empty plan UNLESS `status === "running"` AND every liveness signal
 * is dead/absent (`_still_active` stays false). In that case it heals to idle,
 * removes the lock, and emits the FIX-037 ALERT — exactly the three side effects
 * the bash block performs, in that order.
 */
export function healStatePlan(sig: LivenessSignals): HealAction[] {
  if (sig.status !== "running") return [];
  const stillActive =
    sig.heartbeatAlive || sig.lockPidAlive === true || sig.tmuxSessionAlive === true;
  if (stillActive) return [];
  return [
    { kind: "heal_state_to_idle" },
    { kind: "remove_lock" },
    {
      kind: "append_alert",
      message: "FIX-037 auto-heal | Orphan state detected and cleared (status=running → idle)",
    },
  ];
}

// ── (2) orphan WORKTREE recovery (bin/roll 8857-8910) ────────────────────────

/**
 * The probe facts for ONE leftover cycle worktree — the caller (infra) gathers
 * these per dir, mirroring the bash subshell probes:
 *   - `git rev-parse --abbrev-ref HEAD`            → branch
 *   - `gh pr view <branch> --json state -q .state` → prState (when gh present)
 *   - `git rev-list --count origin/main..HEAD`     → commitsAhead
 *   - presence of `<wt>/.roll/.git`                → containsRollMeta (US-LOOP-068)
 *   - `_loop_is_doc_only_change`                   → docOnly (publish path choice)
 */
export interface OrphanWorktree {
  /** Absolute worktree path. */
  path: string;
  /** Current branch, or `undefined` if HEAD is detached/unresolvable (skip). */
  branch: string | undefined;
  /** `gh pr view` state, or `undefined` when gh is absent / no PR. */
  prState: "MERGED" | "OPEN" | "CLOSED" | undefined;
  /** Commits ahead of origin/main (bin/roll 8878). */
  commitsAhead: number;
  /** True if the worktree embeds a roll-meta git worktree (US-LOOP-068). */
  containsRollMeta: boolean;
  /** True if the diff is documentation-only (picks the doc-PR publish path). */
  docOnly: boolean;
}

/** A worktree-recovery action — the executor performs these in order. */
export type OrphanAction =
  | { kind: "skip"; path: string; reason: string } // detached HEAD / glob no-match
  | { kind: "rebase_onto_main"; path: string; branch: string } // FIX-045
  | { kind: "publish_pr"; path: string; branch: string; docOnly: boolean } // FIX-040
  | { kind: "rollmeta_cleanup"; path: string; branch: string } // US-LOOP-068 (pre-cleanup)
  | { kind: "worktree_cleanup"; path: string; branch: string } // _worktree_cleanup
  | { kind: "preserve"; path: string; branch: string; reason: string }; // C2 audit

/**
 * Result of an attempted recovery — the executor reports rebase/publish success
 * back so the plan can decide cleanup-vs-preserve. The decision is split into
 * {@link orphanWorktreePlan} (the up-front classification) and
 * {@link orphanPostPublishPlan} (cleanup/preserve after publish) so each is pure
 * and independently testable; the executor sequences them.
 */
export interface RecoveryOutcome {
  rebaseOk: boolean;
  publishOk: boolean;
}

/**
 * Classify ONE orphan worktree and emit the leading actions — mirrors the per-dir
 * body of the FIX-040 loop (bin/roll 8861-8909). It stops at the point where the
 * executor must actually run a command whose result feeds the next decision:
 *
 *   - branch unresolvable                → [skip]            (bin/roll 8865)
 *   - prState MERGED                     → [rollmeta?, cleanup] (FIX-114, 8872-8875)
 *   - commitsAhead === 0                 → [rollmeta?, cleanup] (8902-8908)
 *   - commitsAhead > 0                   → [rebase_onto_main]  (FIX-045, 8882)
 *
 * For the commits-ahead path the caller runs the rebase, then calls
 * {@link orphanPostRebasePlan} with the outcome.
 */
export function orphanWorktreePlan(wt: OrphanWorktree): OrphanAction[] {
  if (wt.branch === undefined || wt.branch === "") {
    return [{ kind: "skip", path: wt.path, reason: "HEAD unresolvable (detached or empty)" }];
  }
  const branch = wt.branch;
  // FIX-114: already merged remotely → drop clean (gh asked first).
  if (wt.prState === "MERGED") {
    return cleanupActions(wt, branch);
  }
  // commits ahead → recover (rebase first, FIX-045).
  if (wt.commitsAhead > 0) {
    return [{ kind: "rebase_onto_main", path: wt.path, branch }];
  }
  // no commits → nothing to rescue, just clean.
  return cleanupActions(wt, branch);
}

/**
 * After a rebase attempt on a commits-ahead orphan — mirrors bin/roll 8882-8901.
 *   - rebase failed   → preserve (conflict / network, FIX-045, 8883-8884).
 *   - rebase ok       → publish (doc-PR vs normal PR per `docOnly`, 8887-8890).
 * The caller runs the publish, then calls {@link orphanPostPublishPlan}.
 */
export function orphanPostRebasePlan(wt: OrphanWorktree, rebaseOk: boolean): OrphanAction[] {
  const branch = wt.branch ?? "";
  if (!rebaseOk) {
    return [
      {
        kind: "preserve",
        path: wt.path,
        branch,
        reason: "FIX-045 rebase failed (conflict or network) — recovery skipped",
      },
    ];
  }
  return [{ kind: "publish_pr", path: wt.path, branch, docOnly: wt.docOnly }];
}

/**
 * After the publish attempt — mirrors bin/roll 8892-8901 (the C2 contract).
 *   - publish ok   → [rollmeta?, cleanup]   (orphan branch is now on remote, auditable).
 *   - publish fail → [preserve]             (NEVER destroy un-pushed commits — C2).
 */
export function orphanPostPublishPlan(wt: OrphanWorktree, publishOk: boolean): OrphanAction[] {
  const branch = wt.branch ?? "";
  if (publishOk) {
    return cleanupActions(wt, branch);
  }
  return [
    {
      kind: "preserve",
      path: wt.path,
      branch,
      reason: "FIX-040 publish failed — leaving preserved (commits not yet on remote, C2)",
    },
  ];
}

/** roll-meta-aware cleanup prefix (US-LOOP-068, bin/roll 8893-8897 / 8904-8908). */
function cleanupActions(wt: OrphanWorktree, branch: string): OrphanAction[] {
  const out: OrphanAction[] = [];
  if (wt.containsRollMeta) {
    out.push({ kind: "rollmeta_cleanup", path: wt.path, branch });
  }
  out.push({ kind: "worktree_cleanup", path: wt.path, branch });
  return out;
}

// ── (3a) ephemeral-branch recognition ────────────────────────────────────────
// The ephemeral-prefix predicate lives in delivery/pr.ts (isEphemeralBranch /
// EPHEMERAL_BRANCH_PREFIXES) — consume that, don't duplicate. US-LOOP-096
// removed the old merged-ancestry staleness predicate (no runtime caller +
// squash-merge mis-judgement); remote GC decides merged-ness by PR state
// (US-LOOP-097). Only the loop-DIR retention rules
// below (a distinct FIX-143 concern with no existing port) live here.

// ── (3b) loop-dir GC retention (bin/roll 10577-10646, FIX-143) ───────────────

/** Default backup/migrated/bak retention (days). bin/roll 10515 / 10500. */
export const GC_DEFAULT_KEEP_DAYS = 30;
/** backup-before-merge tarballs expire at 5 days (bin/roll 10605). */
export const GC_BACKUP_KEEP_DAYS = 5;
/** *.migrated-* expire at 7 days (bin/roll 10620). */
export const GC_MIGRATED_KEEP_DAYS = 7;

/**
 * Resolve the `.bak` retention window — mirrors the precedence at bin/roll
 * 10526-10532: env (ROLL_LOOP_GC_RETENTION_DAYS) > local.yaml
 * (loop_gc.retention_days) > {@link GC_DEFAULT_KEEP_DAYS}. Non-numeric / absent
 * inputs fall through to the next source.
 */
export function resolveKeepDays(envDays: string | undefined, yamlDays: number | undefined): number {
  if (envDays !== undefined && /^\d+$/.test(envDays.trim())) return Number(envDays.trim());
  if (yamlDays !== undefined && Number.isFinite(yamlDays) && yamlDays >= 0) return Math.trunc(yamlDays);
  return GC_DEFAULT_KEEP_DAYS;
}

/** A loop-dir debris file class — selects its retention rule. */
export type GcFileClass = "runs_tmp" | "backup_tgz" | "migrated" | "bak";

/**
 * Decide whether a loop-dir debris file should be removed — mirrors the four
 * phase-2 blocks (bin/roll 10594-10646). `runs_tmp` is always removable;
 * the dated classes are removable iff `mtimeSec < now - keepDays*86400`
 * (strict `<`, matching the bash `-lt`).
 *
 * @param keepDays only consulted for `bak`; backup/migrated use their fixed
 *   windows ({@link GC_BACKUP_KEEP_DAYS} / {@link GC_MIGRATED_KEEP_DAYS}).
 */
export function gcRetentionVerdict(
  cls: GcFileClass,
  mtimeSec: number,
  nowSec: number,
  keepDays: number = GC_DEFAULT_KEEP_DAYS,
): { remove: boolean; cutoffSec: number } {
  if (cls === "runs_tmp") {
    return { remove: true, cutoffSec: nowSec }; // always safe (bin/roll 10594-10602)
  }
  const days = cls === "backup_tgz" ? GC_BACKUP_KEEP_DAYS : cls === "migrated" ? GC_MIGRATED_KEEP_DAYS : keepDays;
  const cutoffSec = nowSec - days * 86400;
  return { remove: mtimeSec < cutoffSec, cutoffSec };
}

// ── NEW: startup preflight (B-group AC) ──────────────────────────────────────

/**
 * Git-hooks readiness facts — gathered by the caller (infra) mirroring
 * `_ensure_hooks_path` (bin/roll 1382-1392) and the pre-commit gate it guards:
 *   - `git config core.hooksPath`        → hooksPath
 *   - existence of `<hooksPath>/pre-commit` → preCommitPresent
 */
export interface HooksState {
  /** True if cwd is a git repo (bin/roll 1385 `rev-parse --git-dir`). */
  isGitRepo: boolean;
  /** Current `core.hooksPath` value ("" when unset). */
  hooksPath: string;
  /** True if the wired hooks dir contains an executable `pre-commit`. */
  preCommitPresent: boolean;
}

/** A preflight action — `report_*` items are NOT self-healable; the rest are. */
export type PreflightAction =
  | HealAction
  | { kind: "set_hooks_path"; value: "hooks" } // self-heal: wire core.hooksPath
  | { kind: "report_not_git_repo" } // not healable here
  | { kind: "report_missing_pre_commit"; hooksPath: string }; // not healable (template gap)

/** The composed preflight inputs: orphan-state liveness + hooks readiness. */
export interface PreflightState {
  liveness: LivenessSignals;
  hooks: HooksState;
}

/**
 * Compose the startup preflight plan (NEW B-group AC). Pure: returns an ordered
 * list of actions, healing what is healable and REPORTING what is not.
 *
 * Order (mirrors the runner's startup→preflight phase sequence, bin/roll
 * 8842-8847): orphan-state self-heal FIRST (clear a crashed cycle's state), then
 * git-hooks readiness (so the TCR pre-commit gate can't be bypassed this cycle).
 *
 *   - hooks: not a git repo            → report_not_git_repo (can't wire hooks).
 *   - hooks: hooksPath unset / `.git/hooks` → set_hooks_path "hooks"
 *        (mirrors the `_ensure_hooks_path` guard: only override default/unset).
 *   - hooks: pre-commit missing        → report_missing_pre_commit (template gap;
 *        self-heal can wire the PATH but cannot fabricate the hook script).
 */
export function preflightPlan(state: PreflightState): PreflightAction[] {
  const actions: PreflightAction[] = [];

  // 1. orphan-state self-heal (reuse the audited decision).
  actions.push(...healStatePlan(state.liveness));

  // 2. git-hooks readiness.
  const { hooks } = state;
  if (!hooks.isGitRepo) {
    actions.push({ kind: "report_not_git_repo" });
    return actions; // no point checking hooksPath outside a repo.
  }
  // _ensure_hooks_path: only set when unset or pointing at the git default.
  if (hooks.hooksPath === "" || hooks.hooksPath === ".git/hooks") {
    actions.push({ kind: "set_hooks_path", value: "hooks" });
  }
  if (!hooks.preCommitPresent) {
    // After (potentially) wiring the path, the gate still needs the script.
    const effectivePath = hooks.hooksPath === "" || hooks.hooksPath === ".git/hooks" ? "hooks" : hooks.hooksPath;
    actions.push({ kind: "report_missing_pre_commit", hooksPath: effectivePath });
  }
  return actions;
}

/** True iff a preflight plan still has un-healed (report_*) findings. */
export function preflightHasUnhealed(actions: readonly PreflightAction[]): boolean {
  return actions.some((a) => a.kind === "report_not_git_repo" || a.kind === "report_missing_pre_commit");
}

// ── shared: terminal-outcome helper (used by callers wiring recovery → events) ─

/**
 * Map a recovered orphan to its v2 cycle terminal — mirrors the runs/event rows
 * the orphan paths write (bin/roll 8738/8752): a recovered worktree that
 * published lands as `done`, the FIX-086 orphan-tag path as an orphan terminal.
 * Exposed so the caller can emit a consistent {@link TerminalOutcome} without
 * re-deriving the mapping. A recovered+published orphan is pending merge; an
 * unpublished preserved worktree is an abort with delivery material.
 */
export function recoveredOutcome(publishOk: boolean): TerminalOutcome {
  return publishOk ? "published_pending_merge" : "aborted_with_delivery";
}
