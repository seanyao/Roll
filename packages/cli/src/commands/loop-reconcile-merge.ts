/**
 * US-CYCLE-009 — the async merge write-back adapter.
 *
 * When a PR was opened and auto-merge attached (the runner returned immediately —
 * see terminal-handlers `publish_pr`), GitHub merges the PR once CI is green. A
 * later reconcile pass observes the merge on the GIT PLANE and drives the
 * write-back OFF the critical path:
 *   - {@link verifyMergeGitPlane} — confirm the merge from `git` facts ONLY
 *     (ancestor / patch-id), NEVER a `gh` stdout grep (AC2).
 *   - {@link reconcileMergeConfirmed} — on a git-plane-confirmed merge: emit a
 *     `delivery:merge_confirmed` event (idempotent), flip the backlog to Done
 *     with BOUNDED retry + alert on exhaustion (AC3/AC4), and — only when the
 *     merge is verified — delete the source branch (AC3).
 *
 * The pure decisions (confirm / retry schedule / delete gate / idempotency) live
 * in `@roll/core` (`delivery/async-merge.ts`); this module is the thin IO adapter
 * that binds them to git + the event stream + the backlog store.
 */
import { join } from "node:path";
import type { DeliveryLease, RollEvent } from "@roll/spec";
import {
  BacklogStore,
  confirmMergeFromGitPlane,
  mayDeleteSourceBranch,
  nextWritebackRetry,
  shouldAppendDeliveredCredit,
  siblingCancelEvents,
  DEFAULT_WRITEBACK_MAX_ATTEMPTS,
  type GitPlaneMergeFacts,
  type MergeConfirmation,
  type ReconcileResult,
} from "@roll/core";
import { resolveIntegrationBranch } from "@roll/infra";
import { branchExists, branchPatchId, mainPatchIdsSinceBranch, offlineMergeEvidence } from "../lib/delivery-facts.js";
import { collectGitDossierFacts, type GitDossierFacts } from "../lib/story-dossier.js";
import { nodeExecPort } from "@roll/core";
import { markDoneGuarded } from "../runner/done-guard.js";
import { hostDeltaDeliveryBinding } from "../lib/delta-delivery-binding.js";

// ── AC2: git-plane merge verification ─────────────────────────────────────────

/** The git probes {@link verifyMergeGitPlane} needs — injectable for tests. */
export interface GitPlaneProbes {
  /** `git merge-base --is-ancestor origin/<branch> <integrationBranch>` == 0. */
  branchTipIsAncestorOfMain(cwd: string, branch: string, integrationBranch: string): boolean | undefined;
  /** `git patch-id(diff <integrationBranch>...origin/<branch>)`. */
  branchNetPatchId(cwd: string, branch: string, integrationBranch: string): string | undefined;
  /** patch-ids of main commits not on the branch. */
  mainPatchIdsSinceBranch(cwd: string, branch: string, integrationBranch: string): ReadonlySet<string>;
  /** Is `origin/<branch>` still present on the remote (as a local tracking ref)? */
  branchPresentOnOrigin(cwd: string, branch: string): boolean;
}

/** Real git probes (delivery-facts + a merge-base ancestor check). */
export const defaultGitPlaneProbes: GitPlaneProbes = {
  branchTipIsAncestorOfMain(cwd, branch, integrationBranch) {
    if (!branchExists(cwd, branch)) return undefined;
    const r = nodeExecPort.run("git", [
      "-C", cwd, "merge-base", "--is-ancestor", `origin/${branch}`, integrationBranch,
    ]);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    return undefined;
  },
  branchNetPatchId(cwd, branch, integrationBranch) {
    return branchPatchId(cwd, branch, integrationBranch);
  },
  mainPatchIdsSinceBranch(cwd, branch, integrationBranch) {
    return mainPatchIdsSinceBranch(cwd, branch, integrationBranch);
  },
  branchPresentOnOrigin(cwd, branch) {
    return branchExists(cwd, branch);
  },
};

/**
 * Confirm a merge from the GIT PLANE ONLY (AC2). Gathers ancestor + patch-id +
 * `(#N)`-on-main facts and delegates the decision to the pure
 * {@link confirmMergeFromGitPlane}. The gh plane is never consulted here — merge
 * truth is git, by contract.
 *
 * The `(#N)`-on-main signal (offline-L1: `offlineMergeEvidence` over main's git
 * log) is REQUIRED for correctness: a squash merge with `--delete-branch` — the
 * common post-merge state — leaves no `origin/<branch>`, so ancestor/patch-id
 * cannot fire and ONLY the merge commit on main proves the delivery. When a
 * `prNumber`/`storyId` is given, this reads main's log (git, not gh) to check it.
 * A prebuilt `dossierFacts` snapshot is reused when supplied (the reconcile
 * command already builds one) to avoid a redundant log scan.
 */
export function verifyMergeGitPlane(
  cwd: string,
  branch: string,
  opts: {
    probes?: GitPlaneProbes;
    integrationBranch?: string;
    prNumber?: number;
    storyId?: string;
    dossierFacts?: GitDossierFacts | null;
  } = {},
): MergeConfirmation {
  const probes = opts.probes ?? defaultGitPlaneProbes;
  const integrationBranch = opts.integrationBranch ?? resolveIntegrationBranch(cwd);
  const ancestor = probes.branchTipIsAncestorOfMain(cwd, branch, integrationBranch);
  // Only compute the (expensive) patch-id when the ancestor probe did not already
  // confirm — confirmMergeFromGitPlane checks ancestor first anyway.
  let branchNetPatchId: string | undefined;
  let mainPatchIds: ReadonlySet<string> = new Set();
  if (ancestor !== true) {
    branchNetPatchId = probes.branchNetPatchId(cwd, branch, integrationBranch);
    if (branchNetPatchId !== undefined) {
      mainPatchIds = probes.mainPatchIdsSinceBranch(cwd, branch, integrationBranch);
    }
  }
  // `(#N)`-on-main (offline L1) — only needed when ancestor/patch-id did not fire
  // (e.g. the branch was deleted after a squash merge).
  let mergeCommitOnMain = false;
  const patchIdHit = branchNetPatchId !== undefined && mainPatchIds.has(branchNetPatchId);
  if (ancestor !== true && !patchIdHit && (opts.prNumber !== undefined || (opts.storyId ?? "") !== "")) {
    const facts = opts.dossierFacts !== undefined ? opts.dossierFacts : collectGitDossierFacts(cwd);
    mergeCommitOnMain = offlineMergeEvidence(facts, opts.storyId ?? "", opts.prNumber) === "MERGED";
  }
  const facts: GitPlaneMergeFacts = {
    branchTipIsAncestorOfMain: ancestor,
    branchNetPatchId,
    mainPatchIds,
    branchPresentOnOrigin: probes.branchPresentOnOrigin(cwd, branch),
    mergeCommitOnMain,
  };
  return confirmMergeFromGitPlane(facts);
}

// ── AC4: idempotency helpers ──────────────────────────────────────────────────

/** True iff a `delivery:merge_confirmed` event already exists for this cycle. */
export function hasMergeConfirmedEvent(events: readonly RollEvent[], cycleId: string): boolean {
  return events.some(
    (ev) => ev.type === "delivery:merge_confirmed" && "cycleId" in ev && ev.cycleId === cycleId,
  );
}

/**
 * Derive a git-plane {@link MergeConfirmation} from a reconcile RESULT without a
 * fresh git probe — used on the hot reconcile path. Only the `patch_id` signal
 * (pure git-plane) confirms; a `pr_state` (gh) delivered is honest about NOT
 * being a git-plane confirmation and yields `none`.
 */
export function confirmationFromReconcileResult(result: ReconcileResult): MergeConfirmation {
  if (result.kind === "delivered" && result.signal === "patch_id") {
    return { merged: true, signal: "patch_id" };
  }
  return { merged: false, signal: "none" };
}

// ── AC3: bounded-retry write-back + guarded branch delete ─────────────────────

/** The backlog markStatus write, injectable for tests. */
export interface WriteBackDeps {
  cwd: string;
  eventsPath: string;
  now: number;
  appendEvent(eventsPath: string, event: RollEvent): void;
  markStatus(cwd: string, id: string, status: string): void;
  alert(message: string): void;
  /** Fresh event stream snapshot for idempotency guards. */
  events: readonly RollEvent[];
  /** Optional: sleep between retries (injected instant in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional: delete the source branch — called ONLY after a verified merge. */
  deleteSourceBranch?: (branch: string) => void | Promise<void>;
  /** Bound on write-back attempts (default {@link DEFAULT_WRITEBACK_MAX_ATTEMPTS}). */
  maxAttempts?: number;
  /**
   * The GIT-PLANE merge confirmation authority (AC2). When provided it is the
   * gate for the entire write-back — the backlog flip, branch delete, and
   * merge_confirmed record ALL require `confirmation.merged` to be true. The
   * production binding injects {@link verifyMergeGitPlane}; tests inject a fake.
   * Takes precedence over `cyc.result` (a gh `pr_state` verdict is NEVER trusted
   * to flip on its own).
   */
  verify?: () => MergeConfirmation;
}

/** The cycle being written back. `result`/`confirmation` supply the git-plane signal. */
export interface MergeConfirmedCycle {
  cycleId: string;
  storyId: string;
  branch: string;
  prNumber?: number;
  /** The reconcile verdict (source of the git-plane signal on the hot path). */
  result?: ReconcileResult;
  /** An explicit confirmation (e.g. from {@link verifyMergeGitPlane}); overrides result. */
  confirmation?: MergeConfirmation;
  /** Merge commit sha, when known. */
  mergeCommit?: string;
}

/**
 * Flip the backlog row to Done with a BOUNDED retry + alert on exhaustion (AC3).
 * Each attempt re-reads the backlog snapshot (markDoneGuarded → markExact), so a
 * concurrent write that invalidated the previous snapshot hash is retried rather
 * than silently swallowed. Returns whether the flip landed and the attempt count.
 */
export async function flipBacklogDeliveredWithRetry(
  cwd: string,
  storyId: string,
  deps: Pick<WriteBackDeps, "markStatus" | "alert" | "sleep" | "maxAttempts">,
): Promise<{ ok: boolean; attempts: number }> {
  if (storyId === "") return { ok: true, attempts: 0 };
  const maxAttempts = deps.maxAttempts ?? DEFAULT_WRITEBACK_MAX_ATTEMPTS;
  let lastErr = "unknown error";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      markDoneGuarded(cwd, storyId, { mergedToMain: true }, {
        markStatus: deps.markStatus,
        alert: deps.alert,
      });
      return { ok: true, attempts: attempt + 1 };
    } catch (e) {
      lastErr = String(e);
    }
    const decision = nextWritebackRetry(attempt, { maxAttempts });
    if (!decision.retry) break;
    if (deps.sleep !== undefined) await deps.sleep(decision.delayMs);
  }
  deps.alert(
    `US-CYCLE-009: backlog write-back for ${storyId} exhausted ${maxAttempts} attempts — ${lastErr}`,
  );
  return { ok: false, attempts: maxAttempts };
}

/**
 * Drive the write-back for a merge-confirmed cycle (AC2/AC3/AC4). Idempotent:
 *   - emits `delivery:merge_confirmed` at most ONCE per cycle (guarded on the
 *     event stream) so a duplicate merge observation never double-records;
 *   - flips the backlog to Done with bounded retry (markDoneGuarded is itself
 *     idempotent — re-marking Done is a no-op);
 *   - deletes the source branch ONLY when the merge is verified
 *     ({@link mayDeleteSourceBranch}) and a deleter was injected (production
 *     leaves branch deletion to the merge's own `--delete-branch`).
 *
 * Returns the confirmation used and whether the backlog flip landed.
 */
export async function reconcileMergeConfirmed(
  deps: WriteBackDeps,
  cyc: MergeConfirmedCycle,
): Promise<{ confirmation: MergeConfirmation; flipped: boolean; deleted: boolean }> {
  // Precedence: explicit confirmation (tests) > git-plane verify (production) >
  // the reconcile result's own signal. verify() is the authority — a gh
  // `pr_state` delivered NEVER flips unless the git plane also confirms.
  const confirmation =
    cyc.confirmation ??
    (deps.verify !== undefined
      ? deps.verify()
      : cyc.result !== undefined
        ? confirmationFromReconcileResult(cyc.result)
        : { merged: false, signal: "none" as const });

  // ── git plane could NOT confirm → never flip / delete / record on gh-state ──
  if (!confirmation.merged || confirmation.signal === "none") {
    // A delivered verdict the git plane cannot corroborate is DEFERRED, not
    // dropped: alert so a later git-plane confirmation (next reconcile) or a
    // human flips the backlog.
    if (cyc.result?.kind === "delivered") {
      deps.alert(
        `US-CYCLE-009: ${cyc.storyId || cyc.cycleId} reported merged by gh but the git plane cannot confirm ` +
          `(no ancestor / no patch-id match on main) — backlog flip DEFERRED, branch NOT deleted; ` +
          `next reconcile confirms on the git plane (cycle ${cyc.cycleId})`,
      );
    }
    return { confirmation, flipped: false, deleted: false };
  }

  // ── git plane CONFIRMED the merge → write back ─────────────────────────────
  // AC2 + AC4: record the git-plane confirmation exactly once.
  if (!hasMergeConfirmedEvent(deps.events, cyc.cycleId)) {
    deps.appendEvent(deps.eventsPath, {
      type: "delivery:merge_confirmed",
      cycleId: cyc.cycleId,
      storyId: cyc.storyId,
      branch: cyc.branch,
      ...(cyc.prNumber !== undefined ? { prNumber: cyc.prNumber } : {}),
      signal: confirmation.signal,
      ...(cyc.mergeCommit !== undefined ? { mergeCommit: cyc.mergeCommit } : {}),
      ts: deps.now,
    });
  }

  // AC3: bounded-retry backlog flip.
  const flip = await flipBacklogDeliveredWithRetry(deps.cwd, cyc.storyId, {
    markStatus: deps.markStatus,
    alert: deps.alert,
    sleep: deps.sleep,
    maxAttempts: deps.maxAttempts,
  });

  // AC3: source-branch delete ONLY after a verified merge.
  let deleted = false;
  if (deps.deleteSourceBranch !== undefined && mayDeleteSourceBranch(confirmation) && cyc.branch !== "") {
    await deps.deleteSourceBranch(cyc.branch);
    deleted = true;
  }

  return { confirmation, flipped: flip.ok, deleted };
}

// ── The SINGLE git-plane-gated terminalization decision point ─────────────────

/** The real backlog write (BacklogStore markExact against `.roll/backlog.md`). */
export function defaultBacklogMarkStatus(projectCwd: string, id: string, status: string): void {
  const backlogPath = join(projectCwd, ".roll", "backlog.md");
  const store = new BacklogStore();
  const snapshot = store.readBacklog(backlogPath);
  store.markExact(backlogPath, snapshot.hash, id, status);
}

/** A delivered reconcile verdict (carries `via` / `signal` / `mergeCommit`). */
export type DeliveredResult = Extract<ReconcileResult, { kind: "delivered" }>;

/** Outcome of {@link settleDeliveredCycle} — drives the caller's counts. */
export interface SettleOutcome {
  /** The git-plane confirmation that gated everything. */
  confirmation: MergeConfirmation;
  /**
   * Did the cycle become TERMINAL this pass? True IFF the git plane confirmed —
   * a `delivery:reconciled` credit (and thus the delivered projection) is only
   * possible when this is true. When false the cycle stays awaiting_merge and is
   * RE-INCLUDED by the reconcile filter on the next tick (deferred, not dropped).
   */
  terminal: boolean;
  /** A NEW `delivery:reconciled` credit was appended this pass. */
  credited: boolean;
  /** The backlog flip landed (only attempted when terminal). */
  flipped: boolean;
}

/** IO + policy seams for {@link settleDeliveredCycle} (injectable for tests). */
export interface SettleDeliveredDeps {
  cwd: string;
  eventsPath: string;
  now: number;
  /** Fresh event-stream snapshot for the idempotency guards. */
  events: readonly RollEvent[];
  appendEvent(eventsPath: string, event: RollEvent): void;
  alert(message: string): void;
  /** Backlog write (default: the real BacklogStore markExact); injectable for tests. */
  markStatus?: (cwd: string, id: string, status: string) => void;
  /** The git-plane confirmation authority (default: {@link verifyMergeGitPlane}). */
  verify: () => MergeConfirmation;
  /** Optional: delete the source branch — only after a verified merge. */
  deleteSourceBranch?: (branch: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/** The delivered cycle being settled. */
export interface SettleDeliveredCycle {
  cycleId: string;
  storyId: string;
  branch: string;
  prNumber?: number;
  result: DeliveredResult;
  /** Same-card sibling leases to cancel on the FIRST confirmed merge (US-DELIV-005). */
  siblingLeases: DeliveryLease[];
}

/**
 * THE single git-plane-gated decision point for a `delivered` reconcile verdict
 * (US-CYCLE-009, codex r2). EVERY terminal signal — `delivery:reconciled` (the
 * terminal marker), sibling-cancellation, the backlog flip, the
 * `delivery:merge_confirmed` record, and the source-branch delete — is emitted
 * ONLY when {@link verifyMergeGitPlane} (ancestor / patch-id / `(#N)` merge
 * commit on main) confirms the merge on the GIT PLANE.
 *
 * A gh `pr_state`-only delivered verdict that the git plane cannot yet
 * corroborate is DEFERRED: nothing terminal is emitted (no `delivery:reconciled`,
 * so the cycle stays awaiting_merge and the reconcile filter RE-INCLUDES it next
 * tick), the DEFER alert fires, and no sibling is cancelled. This closes the
 * "credited-but-unflipped, then excluded forever" gap: a genuinely (squash)
 * merged card is later confirmed via the `merge_commit` signal once the `(#N)`
 * commit lands on main and DOES go terminal + flip.
 *
 * Idempotent: `delivery:reconciled` / sibling-cancel are guarded by
 * {@link shouldAppendDeliveredCredit}; `delivery:merge_confirmed` by
 * {@link hasMergeConfirmedEvent}; the flip (markDoneGuarded) is a no-op once Done.
 */
export async function settleDeliveredCycle(
  deps: SettleDeliveredDeps,
  cyc: SettleDeliveredCycle,
): Promise<SettleOutcome> {
  const markStatus = deps.markStatus ?? defaultBacklogMarkStatus;
  const confirmation = deps.verify();

  let credited = false;
  if (confirmation.merged && shouldAppendDeliveredCredit(deps.events, cyc.cycleId)) {
    // Terminal marker — projects the cycle to `delivered` (removes it from the
    // awaiting_merge filter). Only reached once the git plane confirmed.
    const binding = hostDeltaDeliveryBinding(deps.events as readonly Record<string, unknown>[], cyc.storyId, cyc.cycleId);
    deps.appendEvent(deps.eventsPath, {
      type: "delivery:reconciled",
      cycleId: cyc.cycleId,
      storyId: cyc.storyId,
      state: cyc.result.via === "runner" ? "delivered" : "delivered_external",
      mergedBy: cyc.result.via,
      mergeCommit: cyc.result.mergeCommit ?? "unknown",
      signal: cyc.result.signal,
      ...(binding === undefined ? {} : binding),
      ts: deps.now,
    });
    // US-DELIV-005: cancel same-card siblings ONLY on a git-plane-confirmed merge.
    for (const ev of siblingCancelEvents(
      cyc.storyId,
      {
        cycleId: cyc.cycleId,
        mergeCommit: cyc.result.mergeCommit ?? "unknown",
        signal: cyc.result.signal,
        mergedBy: cyc.result.via,
      },
      cyc.siblingLeases,
      deps.now,
    )) {
      deps.appendEvent(deps.eventsPath, ev);
    }
    credited = true;
  }

  // Write-back (merge_confirmed + flip + delete) OR the DEFER alert — driven by
  // the SAME confirmation (passed explicitly so there is no second verify).
  const wb = await reconcileMergeConfirmed(
    {
      cwd: deps.cwd,
      eventsPath: deps.eventsPath,
      now: deps.now,
      events: deps.events,
      appendEvent: deps.appendEvent,
      alert: deps.alert,
      markStatus,
      ...(deps.deleteSourceBranch !== undefined ? { deleteSourceBranch: deps.deleteSourceBranch } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
    },
    {
      cycleId: cyc.cycleId,
      storyId: cyc.storyId,
      branch: cyc.branch,
      ...(cyc.prNumber !== undefined ? { prNumber: cyc.prNumber } : {}),
      confirmation,
      result: cyc.result,
      ...(cyc.result.mergeCommit !== undefined ? { mergeCommit: cyc.result.mergeCommit } : {}),
    },
  );

  return { confirmation, terminal: confirmation.merged, credited, flipped: wb.flipped };
}

/**
 * Build the production git-plane `verify` closure for {@link settleDeliveredCycle}
 * — the real {@link verifyMergeGitPlane} (ancestor / patch-id / `(#N)`-on-main),
 * reusing a prebuilt dossier snapshot when supplied.
 */
export function gitPlaneVerifier(args: {
  cwd: string;
  branch: string;
  prNumber?: number;
  storyId?: string;
  dossierFacts?: GitDossierFacts | null;
}): () => MergeConfirmation {
  return () =>
    verifyMergeGitPlane(args.cwd, args.branch, {
      prNumber: args.prNumber,
      storyId: args.storyId,
      dossierFacts: args.dossierFacts,
    });
}
