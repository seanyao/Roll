import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  appendDelivery,
  nodeDeliveryStore,
  planPublishDocPr,
  planPublishPr,
  releaseStoryLease,
  type CycleCommand,
  type CycleContext,
  type PublishResult,
  type RunKey,
} from "@roll/core";
import { AWAITING_REVIEW_STATUS_MARKER, STATUS_MARKER, absent, present } from "@roll/spec";
import { prNumberFromUrl, resolvePublishMode, submoduleWorktreePath } from "@roll/infra";
import { commitInRepoBacklog, isInRepoRollLayout } from "./in-repo-backlog.js";
import { writeCycleRoleSummaryBestEffort } from "./cycle-role-artifact-writer.js";
import { evaluateEvidenceGate, executeLocalPublish } from "./local-publish.js";
import { markDoneGuarded } from "./done-guard.js";
import { addPendingPrCreate } from "./pending-pr-create.js";
import { applyCleanupManifest, CLEANUP_TIMEOUT_MS, resolveCleanupManifest } from "./environment-cleanup.js";
import type { ExecuteResult, Ports } from "./ports.js";
import { repairCoreWorktreeContamination } from "./main-checkout-guard.js";
import { publishBodyWithEvidenceTrailer, storyRequiresManualMerge } from "./publish-lifecycle.js";
import { buildRunRow, buildTerminalRecord, commitRollMetadata, stampTs, withRealCost } from "./run-records.js";
import { eventTs } from "./runner-time.js";
import { cleanStaleEvidence, isParkedAtHold, resetStaleSpecTruth, revertPrematureDone } from "./resume-truth.js";
import { appendCleanupEvent, cleanupGuardResult, recordCleanupFailures } from "./sandbox-boundary.js";
import { resolveStoryLeasePath } from "./story-lease-path.js";

type TerminalCommand = Extract<CycleCommand, { kind:
  | "publish_pr"
  | "merge_back"
  | "push_orphan"
  | "rescue_leaked"
  | "wait_merge"
  | "reconcile"
  | "cleanup_environment"
  | "cleanup_worktree"
  | "emit_event"
  | "append_run"
  | "append_alert"
  | "release_lock"
}>;

const LEGACY_REPOSITORY_TERMINAL_COMMANDS = new Set<TerminalCommand["kind"]>([
  "publish_pr",
  "merge_back",
  "push_orphan",
  "rescue_leaked",
  "wait_merge",
]);

function storyLeasePath(ports: Ports): string {
  return resolveStoryLeasePath(ports.paths);
}

function preservedIssueWorktreeFacts(ctx: CycleContext): object | undefined {
  const execution = ctx.repositoryExecution;
  if (execution === undefined) return undefined;
  const repositories = Object.values(execution.repositories)
    .sort((left, right) => left.repoId.localeCompare(right.repoId))
    .map((repository) => {
      const worktreePath = existsSync(repository.worktreePath)
        ? realpathSync(repository.worktreePath)
        : repository.worktreePath;
      let headSha = repository.headSha;
      let dirty = true;
      let commitsAheadBase = -1;
      try {
        headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        dirty = execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
        const ahead = execFileSync("git", ["-C", worktreePath, "rev-list", "--count", `${repository.baseSha}..HEAD`], {
          encoding: "utf8",
        }).trim();
        commitsAheadBase = Number.parseInt(ahead, 10);
        if (!Number.isFinite(commitsAheadBase)) commitsAheadBase = -1;
      } catch {
        // Preserve a conservative recovery record even when Git probing fails:
        // unknown work is never mislabeled clean or silently omitted.
      }
      return {
        repoId: repository.repoId,
        alias: repository.alias,
        worktreePath,
        headSha,
        baseSha: repository.baseSha,
        dirty,
        commitsAheadBase,
      };
    });
  return {
    workspaceId: execution.workspaceId,
    storyId: ctx.storyId ?? "",
    cycleId: ctx.cycleId,
    issueRoot: existsSync(execution.issueRoot) ? realpathSync(execution.issueRoot) : execution.issueRoot,
    repositories,
  };
}

export async function executeTerminalCommand(
  cmd: TerminalCommand,
  ports: Ports,
  ctx: CycleContext,
): Promise<ExecuteResult> {
  if (ctx.repositoryExecution !== undefined) {
    if (cmd.kind === "append_run") {
      const key: RunKey = { storyId: ctx.storyId ?? "", cycleId: cmd.cycleId };
      ports.events.upsertRun(ports.paths.runsPath, key, buildRunRow(cmd, ctx, ports.clock()));
      if ((ctx.storyId ?? "") !== "") {
        try {
          releaseStoryLease(resolveStoryLeasePath(ports.paths), ctx.storyId ?? "", {
            source: "cycle",
            pid: process.pid,
          });
        } catch {
          /* lease cleanup must never block terminal bookkeeping */
        }
      }
      return {};
    }
    if (cmd.kind === "cleanup_environment" || cmd.kind === "cleanup_worktree") {
      const preserved = preservedIssueWorktreeFacts(ctx);
      if (preserved !== undefined) {
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `workspace_issue_worktrees_preserved: ${JSON.stringify(preserved)}`,
        );
      }
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `workspace_repository_scope_required: ${cmd.kind} skipped legacy repo-global cleanup for cycle ${ctx.cycleId}`,
      );
      return {};
    }
    if (LEGACY_REPOSITORY_TERMINAL_COMMANDS.has(cmd.kind)) {
      throw new Error(`workspace_repository_scope_required: ${cmd.kind}`);
    }
  }
  switch (cmd.kind) {
    case "publish_pr": {
      const manualMerge = cmd.manualMerge === true || storyRequiresManualMerge(ports.repoCwd, ctx.storyId);
      if (resolvePublishMode(ports.repoCwd) === "local") {
        return executeLocalPublish(cmd, ports, ctx, manualMerge);
      }
      const slug = await ports.github.repoSlug(ports.repoCwd);
      if (slug === undefined) {
        // gh unavailable / no github remote → status 2 (gh-missing tier).
        const pub: PublishResult = { status: 2, mergedBack: false, orphanPushed: false, manualMerge, ...(cmd.draft === true ? { draft: true } : {}) };
        return { event: { type: "published", result: pub } };
      }
      const preState = await ports.github.prState(ports.repoCwd, cmd.branch).catch(() => "UNKNOWN");
      if (preState === "OPEN" || preState === "MERGED") {
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `discipline: agent self-published a PR for ${cmd.branch} (cycle ${ctx.cycleId}) — runner adopted it; gates ran post-hoc (FIX-245)`,
        );
        const pub: PublishResult = { status: 0, manualMerge, ...(cmd.draft === true ? { draft: true } : {}) };
        return { event: { type: "published", result: pub } };
      }
      const gateStoryId = ctx.storyId ?? "";
      if (gateStoryId !== "" && cmd.docOnly !== true) {
        if (!evaluateEvidenceGate(ports, ctx, gateStoryId)) {
          // FIX-908 / FIX-1256: a CI-green cycle that is only blocked by a
          // missing acceptance artifact is NOT silently unpublished. Flag the
          // result so the publish ladder classifies it as `needs_review` and
          // preserves the branch for human review.
          const pub: PublishResult = {
            status: 1,
            manualMerge,
            gateBlocked: true,
            ...(cmd.draft === true ? { draft: true } : {}),
          };
          return { event: { type: "published", result: pub } };
        }
      }
      const pushed = await ports.git.push(ports.paths.worktreePath, `HEAD:refs/heads/${cmd.branch}`);
      if (pushed.code !== 0) {
        const pub: PublishResult = { status: 1, manualMerge, ...(cmd.draft === true ? { draft: true } : {}) };
        return { event: { type: "published", result: pub } };
      }
      const body = await publishBodyWithEvidenceTrailer(ports, ctx);
      if (body === null) {
        const pub: PublishResult = { status: 1, manualMerge, ...(cmd.draft === true ? { draft: true } : {}) };
        return { event: { type: "published", result: pub } };
      }
      // US-CYCLE-009: resolve the branch's real tip from the git plane (the sha
      // just pushed to origin) so the auto-merge attach is head-sha-pinned —
      // GitHub refuses the merge if the tip moves past it (PR-API-head-lag
      // guard).
      const headSha = ports.git.remoteBranchTip !== undefined
        ? await ports.git.remoteBranchTip(ports.repoCwd, cmd.branch).catch(() => undefined)
        : undefined;
      let plan = cmd.docOnly
        ? planPublishDocPr({ branch: cmd.branch, slug, body, manualMerge, draft: cmd.draft, headSha })
        : planPublishPr({ branch: cmd.branch, slug, body, manualMerge, draft: cmd.draft, headSha });
      // US-CYCLE-009: if the real tip could NOT be resolved, refuse to arm an
      // UNPINNED auto-merge — an unpinned squash can merge a stale head. Strip
      // the merge step (the PR still opens) and alert; the reconcile path
      // self-merges once CI is green. (manualMerge plans already carry no merge
      // step, so this only affects the auto/admin merge tail.)
      if (headSha === undefined && !manualMerge) {
        plan = plan.filter((s) => s.kind !== "gh-pr-merge-auto" && s.kind !== "gh-pr-merge-admin");
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `US-CYCLE-009: could not resolve origin/${cmd.branch} tip via ls-remote — auto-merge NOT armed (refusing an unpinned merge); PR opened, reconcile self-merges once CI is green (cycle ${ctx.cycleId ?? "?"})`,
        );
      }
      const r = await ports.github.runPublishPlan(plan);
      // US-CYCLE-009: the repo does not have auto-merge enabled — the PR is open
      // and healthy; the reconcile path self-merges it once CI is green. Alert
      // (graceful degrade) instead of crashing or silently dropping the merge.
      if (r.autoMergeUnavailable === true) {
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `US-CYCLE-009: auto-merge is not enabled for ${slug} — PR for ${cmd.branch} (${ctx.storyId ?? "?"}) left open; reconcile will self-merge once CI is green (cycle ${ctx.cycleId ?? "?"})`,
        );
      }
      // US-V4-001: publish no longer mounts a PR link onto a story `index.html`
      // dossier page — the global dossier/story-page refresh is not a v4 delivery
      // side effect. The PR fact lives in the DeliveryRecord + events below and is
      // surfaced by `roll cycles` / `roll truth`; render dossier pages on demand
      // with `roll index`.
      // US-TRUTH-015 AC1 + FIX-389b: write DeliveryRecord on successful publish.
      // This is now an OPTIONAL CACHE WARM — the correctness path is runs+git
      // projection (FIX-389a). The DeliveryRecord here is immediately available
      // for readers that haven't switched to the projection yet. When FIX-389a
      // is fully adopted, this block can become a no-op or be removed.
      if (r.status === 0 && r.prUrl !== "" && ctx.storyId !== undefined && ctx.cycleId !== undefined) {
        const parsedNumber = prNumberFromUrl(r.prUrl);
        try {
          appendDelivery(nodeDeliveryStore, ports.repoCwd, {
            storyId: ctx.storyId,
            cycleId: ctx.cycleId,
            lifecycleState: "pending_merge",
            prNumber: parsedNumber !== undefined
              ? present(Number(parsedNumber))
              : absent("not_recorded"),
            prUrl: present(r.prUrl),
            mergedAt: absent("not_recorded"),
            mergeCommit: absent("not_recorded"),
            recordedAt: ports.clock(),
          });
        } catch {
          // DeliveryRecord write is best-effort — never block publish on it.
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `US-TRUTH-015: appendDelivery failed for ${ctx.storyId} (cycle ${ctx.cycleId})`,
          );
        }
        // US-DELIV-001: the PR-open fact is an EVENT — the cycle enters
        // awaiting_merge (projection: projectDeliveryState) and the loop is
        // released to pick the next card; nothing blocks on the merge. The
        // event, not the record above, is the authoritative delivery fact.
        if (parsedNumber !== undefined) {
          try {
            ports.events.appendEvent(ports.paths.eventsPath, {
              type: "delivery:published",
              cycleId: ctx.cycleId,
              storyId: ctx.storyId,
              branch: cmd.branch,
              prNumber: Number(parsedNumber),
              prUrl: r.prUrl,
              ts: eventTs(ports),
            });
          } catch {
            ports.events.appendAlert(
              ports.paths.alertsPath,
              `US-DELIV-001: delivery:published append failed for ${ctx.storyId} (cycle ${ctx.cycleId})`,
            );
          }
        } else {
          // fail-loud: a PR URL we can't parse a number from means the cycle
          // never enters awaiting_merge in the projection — surface it.
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `US-DELIV-001: PR opened for ${cmd.branch} but prNumber unparsable from ${r.prUrl} — delivery:published NOT emitted`,
          );
        }
      }
      // FIX-1214: the branch was pushed but a transient GitHub API fault kept us
      // from opening the PR. Queue the hand-off so the reconciler can retry, alert,
      // and treat the cycle as published rather than failed.
      if (r.degraded === true && r.status === 0 && ctx.storyId !== undefined && ctx.cycleId !== undefined) {
        const runtimeDir = dirname(ports.paths.eventsPath);
        addPendingPrCreate(runtimeDir, {
          storyId: ctx.storyId,
          cycleId: ctx.cycleId,
          branch: cmd.branch,
          slug,
          body,
          draft: cmd.draft === true,
          manualMerge,
          createdAt: ports.clock() * 1000,
        });
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `FIX-1214: publish degraded for ${cmd.branch} (${ctx.storyId}) — PR create/merge blocked by transient GitHub API fault; queued for reconciler retry`,
        );
        try {
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "alert:notify",
            channel: "publish-degraded",
            message: `publish degraded: ${ctx.storyId} ${cmd.branch} — env:gh_api`,
            ts: ports.clock() * 1000,
          });
        } catch {
          /* best-effort observability */
        }
        try {
          appendDelivery(nodeDeliveryStore, ports.repoCwd, {
            storyId: ctx.storyId,
            cycleId: ctx.cycleId,
            lifecycleState: "pending_merge",
            prNumber: absent("not_recorded"),
            prUrl: absent("not_recorded"),
            mergedAt: absent("not_recorded"),
            mergeCommit: absent("not_recorded"),
            recordedAt: ports.clock(),
          });
        } catch {
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `FIX-1214: appendDelivery failed for degraded publish ${ctx.storyId} (cycle ${ctx.cycleId})`,
          );
        }
      }
      const pub: PublishResult = {
        status: r.status,
        manualMerge,
        ...(cmd.draft === true ? { draft: true } : {}),
        ...(r.degraded === true ? { degraded: true, rootCauseKey: r.rootCauseKey ?? "env:gh_api" } : {}),
      };
      return {
        event: { type: "published", result: pub },
        // US-TRUTH-001: thread the PR url into the cycle context so the
        // terminal event records the publish fact instead of guessing.
        ...(r.status === 0 && r.prUrl !== "" ? { ctxPatch: { prUrl: r.prUrl } } : {}),
      };
    }

    // _worktree_merge_back (gh-missing ff tier). Drive a push + ff; report via a
    // published refinement is not needed (the orchestrator handles status 2 in
    // classifyPublish), so this is a structural side effect. The driver routes
    // the gh-missing path through publish_pr's status-2 result already.
    case "merge_back": {
      const r = await ports.git.push(ports.repoCwd, cmd.branch);
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `merge_back ${cmd.branch}: push ${r.code === 0 ? "ok" : "failed"}`,
      );
      return {};
    }

    // FIX-039 orphan branch+tag push (audit safety net, C2).
    case "push_orphan": {
      // US-LOOP-094: detached worktree → the orphan commits live on the
      // worktree's detached HEAD; push HEAD to the remote ref from the worktree.
      const r = await ports.git.push(ports.paths.worktreePath, `HEAD:refs/heads/${cmd.branch}`);
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `orphan push ${cmd.branch}: ${r.code === 0 ? "ok" : "failed"}`,
      );
      return {};
    }

    // FIX-903: save leaked main commits to a quarantine bundle for audit.
    // FIX-1475: the shared main ref is NEVER reset — recovery is manual.
    case "rescue_leaked": {
      const refName = `rescue/leaked-${cmd.cycleId}`;
      const r = await ports.git.rescueLeaked(ports.repoCwd, refName);
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `rescue_leaked ${cmd.cycleId}: saved ${r.rescuedSha.slice(0, 8)} to quarantine bundle ${refName}.bundle; shared main NOT reset (FIX-1475) — recover manually: git reset --hard origin/main`,
      );
      // FIX-903 AC3: emit an audit event so the rescue is observable.
      ports.events.appendEvent(ports.paths.eventsPath, {
        type: "cycle:rescue",
        cycleId: cmd.cycleId,
        ref: refName,
        rescuedSha: r.rescuedSha,
        ts: eventTs(ports),
      });
      return {};
    }

    // delivery/pr nextWaitAction sync merge-wait poll. Re-poll the gh state and
    // feed merge_polled back so the orchestrator's nextWaitAction drives it.
    case "wait_merge": {
      const state = await ports.github.prState(ports.repoCwd, cmd.branch);
      return { event: { type: "merge_polled", state, elapsedSec: cmd.elapsedSec } };
    }

    // reconcile/engine reconcileMergeEvidence — terminal bookkeeping only here
    // (the six-state classification already happened); ack with reconciled.
    case "reconcile":
      return { event: { type: "reconciled" } };

    // US-LOOP-088 — post-cycle environment cleanup before the worktree is removed.
    // Side effect + observable events; no feedback into the state machine.
    case "cleanup_environment": {
      try {
        if (realpathSync(ports.repoCwd) === realpathSync(ports.paths.worktreePath)) {
          appendCleanupEvent(ports, ctx, cleanupGuardResult());
          return {};
        }
      } catch {
        /* fall through; applyCleanupManifest still enforces path boundaries */
      }
      const manifestPath = join(ports.repoCwd, ".roll", "loop", "cleanup-manifest.yaml");
      const manifest = resolveCleanupManifest(ports.paths.worktreePath, manifestPath);
      const results = applyCleanupManifest(ports.paths.worktreePath, ctx.cycleId, manifest, {
        terminalStatus: cmd.terminalStatus,
        maxDurationMs: CLEANUP_TIMEOUT_MS,
      });
      for (const r of results) {
        appendCleanupEvent(ports, ctx, r);
      }
      recordCleanupFailures(ports, ctx, results);
      return {};
    }

    // _worktree_cleanup (tolerant). Side effect; no feedback (terminal path).
    // NOTE (FIX-354): the lever-4 warm-session CAPTURE used to live here, but
    // `cleanup_worktree` is SKIPPED when the worktree is preserved (publish-fail /
    // `unpublished`), so a failed cycle never captured. The capture now fires at
    // post-agent-exit in `spawn_agent` (above), unconditionally. This branch is
    // pure worktree teardown again.
    case "cleanup_worktree":
      // FIX-204C: drop OUR .roll symlink first — `git worktree remove` refuses
      // untracked entries in repos that don't gitignore .roll, and removing the
      // LINK explicitly (never the target) keeps the main .roll untouchable.
      try {
        const dst = join(ports.paths.worktreePath, ".roll");
        if (lstatSync(dst, { throwIfNoEntry: false })?.isSymbolicLink() === true) unlinkSync(dst);
      } catch {
        /* tolerant cleanup, mirrors _worktree_cleanup */
      }
      // US-LOOP-095: worktreeRemove bundles unpushed detached work unless the
      // caller marks it already-on-remote (bundleUnpushed=false).
      await ports.git.worktreeRemove(ports.repoCwd, ports.paths.worktreePath, cmd.branch, cmd.bundleUnpushed);
      // E5: a submodule cycle ALSO created a SIBLING submodule worktree
      // (`<wt>.submodules/<sub>`, E5-B). Tear it down too, or every submodule
      // cycle leaks that worktree + its git worktree admin metadata. BEST-EFFORT
      // (the port is code-0-always; the try/catch is belt-and-braces): a cleanup
      // blip must never topple the cycle's terminal path.
      if (ctx.targetSubmodule !== undefined && ctx.targetSubmodule !== "") {
        try {
          await ports.git.worktreeRemoveInSubmodule(
            ports.repoCwd,
            ctx.targetSubmodule,
            submoduleWorktreePath(ports.paths.worktreePath, ctx.targetSubmodule),
          );
        } catch {
          /* tolerant cleanup, mirrors _worktree_cleanup — the superproject
             worktree was already removed above; a submodule remove blip is
             non-fatal (leaked sibling worktree at worst, never a toppled cycle). */
        }
      }
      return {};

    // events/bus appendEvent (I8 — terminal event written unconditionally).
    case "emit_event":
      // FIX-208: the orchestrator is pure (no clock/spawn) so it builds cycle:end
      // with a zero-cost placeholder. Enrich it here with the real per-cycle cost
      // folded into liveCtx after spawn_agent, so the terminal event and the runs
      // row report the SAME cost. Other events pass through untouched.
      ports.events.appendEvent(
        ports.paths.eventsPath,
        stampTs(withRealCost(cmd.event, ctx), eventTs(ports)),
      );
      return {};

    // events/bus upsertRun — the dashboard terminal record (v2 runs.jsonl shape).
    case "append_run": {
      // FIX-1210: repair core.worktree contamination at cycle end BEFORE writing
      // terminal records, so sibling worktrees never see a poisoned config.
      // Covers ALL terminal outcomes (done/published/failed/idle/gave_up/blocked).
      const repair = repairCoreWorktreeContamination(ports.repoCwd);
      if (repair.healed) {
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "cycle:cleanup",
          cycleId: cmd.cycleId,
          rule: "core.worktree",
          path: repair.detail,
          ok: true,
          ts: eventTs(ports),
        });
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `FIX-1210: cycle ${cmd.cycleId} — core.worktree was pointing to "${repair.detail}" — auto-unset at terminal`,
        );
      }
      const metaRepair = repairCoreWorktreeContamination(join(ports.repoCwd, ".roll"));
      if (metaRepair.healed) {
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "cycle:cleanup",
          cycleId: cmd.cycleId,
          rule: "roll-meta.core-worktree",
          path: metaRepair.detail,
          ok: true,
          ts: eventTs(ports),
        });
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `FIX-1224: cycle ${cmd.cycleId} — roll-meta core.worktree was pointing to "${metaRepair.detail}" — auto-unset at terminal`,
        );
      }

      const key: RunKey = { storyId: ctx.storyId ?? "", cycleId: cmd.cycleId };
      ports.events.upsertRun(ports.paths.runsPath, key, buildRunRow(cmd, ctx, ports.clock()));
      // US-TRUTH-001: the versioned complete-or-reasoned terminal record —
      // written at the same moment, from the same facts, as the runs row.
      // Best-effort: the truth twin must never fail the cycle terminal.
      try {
        ports.events.appendEvent(
          ports.paths.eventsPath,
          // FIX-343 (step ③): resolve report/ac-map from the PERSISTENT .roll
          // (repoCwd), NOT the worktree — `append_run` runs at the terminal,
          // after the worktree may be torn down, so a worktree-rooted lookup
          // false-negatives `acmap_missing`/`not_rendered` even though the
          // evidence is on disk in the shared .roll.
          buildTerminalRecord(cmd, ctx, ports.repoCwd, ports.clock()),
        );
      } catch {
        /* the runs row above already landed; audit flags the missing twin */
      }
      // FIX-211: Done ≡ merged (backlog.md:4) — no publish-time 抢跑. A
      // publish-status-0 `done` terminal means the PR was OPENED and merge
      // handed to the reconciler, NOT that it merged. FIX-198
      // wrongly flipped the MAIN backlog ✅ the moment the PR opened, so a card
      // read Done while its PR was still open (the conductor merged minutes
      // later). Flip ✅ Done ONLY on confirmed MERGED evidence; otherwise the row
      // rests at 🔨 In Progress (delivered, pending merge) and a later
      // preflight reconcile (decideClaimReconcile) flips it once the async PR
      // loop merges. The runs row keeps `done` for v2/dashboard parity — only
      // the backlog flip waits for the merge evidence.
      const terminalStoryId = ctx.storyId ?? "";
      // FIX-1211: the cycle that owned this claim is ending — drop its lease so
      // the next preflight can recycle a legitimately dead claim. Best-effort.
      // Scoped to source="cycle": a human claim that preempted mid-flight must
      // keep its soft-lease protection past this cycle's terminal (kimi review).
      if (terminalStoryId !== "") {
        try {
          releaseStoryLease(resolveStoryLeasePath(ports.paths), terminalStoryId, {
            source: "cycle",
            pid: process.pid,
          });
        } catch {
          /* lease cleanup must never block terminal */
        }
      }
      let terminalMerged = false;
      // FIX-1475: in the in-repo layout (`.roll` tracked by the product repo, not
      // its own nested git), the pre-FIX path made the Done flip durable by
      // committing it onto the shared checkout's HEAD and pushing `HEAD:main` —
      // which advanced the local `main` ref and clobbered owner WIP / concurrent
      // dispatch. `markDoneGuarded` still writes Done into the shared working-tree
      // backlog (the loop legitimately tracks status there; setup already marked
      // it In Progress), but durability is now pushed as an ORIGIN-BASED object
      // (see commitInRepoBacklog) so the shared main ref/HEAD/index never move.
      const inRepoLayout = isInRepoRollLayout(ports.paths.worktreePath);
      let inRepoDurableFlip: { id: string; status: string } | null = null;
      if (
        (cmd.status === "done" || cmd.status === "published") &&
        terminalStoryId !== "" &&
        (ctx.publishConfirmed === true || (ctx.prUrl !== undefined && ctx.prUrl !== ""))
      ) {
        // US-TRUTH-015 AC2: use prMergeInfo for both the state check AND the
        // mergedAt/mergeCommit facts (one gh call, not two).
        const mergeInfo = await ports.github.prMergeInfo(ports.repoCwd, ctx.branch).catch(() => undefined);
        const state = mergeInfo?.state ?? "UNKNOWN";
        if (state === "MERGED") {
          terminalMerged = true;
          // Force-write a done DeliveryRecord with real mergedAt/mergeCommit.
          if (ctx.cycleId !== undefined) {
            try {
              const mergedAtVal = mergeInfo?.mergedAt !== undefined
                ? present(new Date(mergeInfo.mergedAt).getTime())
                : absent("not_recorded");
              const mergeCommitVal = mergeInfo?.mergeCommit !== undefined
                ? present(mergeInfo.mergeCommit)
                : absent("not_recorded");
              appendDelivery(nodeDeliveryStore, ports.repoCwd, {
                storyId: terminalStoryId,
                cycleId: ctx.cycleId,
                lifecycleState: "done",
                prNumber: ctx.prUrl !== undefined
                  ? present(Number(prNumberFromUrl(ctx.prUrl) ?? 0))
                  : absent("not_recorded"),
                prUrl: ctx.prUrl !== undefined
                  ? present(ctx.prUrl)
                  : absent("not_recorded"),
                mergedAt: mergedAtVal,
                mergeCommit: mergeCommitVal,
                recordedAt: ports.clock(),
              });
            } catch {
              ports.events.appendAlert(
                ports.paths.alertsPath,
                `US-TRUTH-015: appendDelivery done failed for ${terminalStoryId} (cycle ${ctx.cycleId})`,
              );
            }
          }
          const doneResult = markDoneGuarded(ports.repoCwd, terminalStoryId, { mergedToMain: true }, {
            markStatus: (projectCwd, id, status) => ports.backlog.markStatus?.(projectCwd, id, status),
            alert: (m) => ports.events.appendAlert(ports.paths.alertsPath, m),
          });
          // FIX-1475: when the guard actually marked Done, mirror the EXACT status
          // it wrote (Done vs Done · evidence_debt) onto the remote as an
          // origin-based object — the durable-commit trigger. Skipped when the
          // guard rejected the flip (missing evidence): nothing to make durable.
          if (doneResult.ok && inRepoLayout) {
            const durableStatus = doneResult.debt
              ? `${STATUS_MARKER.done} · evidence_debt`
              : STATUS_MARKER.done;
            inRepoDurableFlip = { id: terminalStoryId, status: durableStatus };
          }
        } else {
          // FIX-304: done ≡ merged. The PR did NOT merge (still OPEN / closed /
          // gh down), yet the agent may have ALREADY flipped this row ✅ Done in
          // the symlinked .roll backlog (FIX-204C → the REAL .roll). A delivered
          // row legitimately rests at 🔨 (pending merge), but a premature ✅ Done
          // is a FALSE-Done — undo it back to the pre-cycle status so the backlog
          // reflects TRUE delivery. A later reconciler tick
          // (decideClaimReconcile) flips it once the PR actually merges.
          revertPrematureDone(ports, terminalStoryId, ctx.preCycleStatus);
        }
      } else if (cmd.status === "waiting_capacity" && terminalStoryId !== "") {
        // US-WS-017b: capacity pressure is a neutral scheduler wait. Release the
        // claim back to Todo without recording a failed/abandoned delivery.
        if (!isParkedAtHold(ports, terminalStoryId)) {
          ports.backlog.markStatus?.(ports.repoCwd, terminalStoryId, STATUS_MARKER.todo);
        }
      } else if ((cmd.status === "idle" || cmd.status === "gave_up" || cmd.status === "local") && terminalStoryId !== "") {
        // idle / gave_up / local never merged → the row goes back to 📋 Todo
        // (re-pickable) — UNLESS this cycle deliberately parked it at 🚫 Hold
        // via self-downgrade (US-AGENT-042). A too-big card runs
        // `roll loop self-downgrade`, which flips the parent to Hold and
        // appends sub-stories, then exits with NO TCR commits → an idle
        // terminal. Blindly flipping it back to Todo would clobber the
        // authoritative Hold and re-pick the too-big card forever (the
        // harness-systemic failure FIX-364 was opened to prevent). A Hold at
        // the terminal is a deliberate park (self-downgrade or a manual hold),
        // never a premature claim to release — leave it.
        // FIX-1232: `local` (unpublished) — gates passed but publish could
        // not land (FIX-351). The work is sound and committed, not a failure,
        // but the story must be re-pickable so the loop does not stall.
        if (!isParkedAtHold(ports, terminalStoryId)) {
          ports.backlog.markStatus?.(ports.repoCwd, terminalStoryId, STATUS_MARKER.todo);
        }
        // US-TRUTH-015 AC2: write a delivery record when the cycle finished
        // without merging. The lifecycle reflects the terminal outcome:
        // idle/gave_up → "failed", local (unpublished, work committed) →
        // "abandoned".
        if (ctx.cycleId !== undefined) {
          try {
            appendDelivery(nodeDeliveryStore, ports.repoCwd, {
              storyId: terminalStoryId,
              cycleId: ctx.cycleId,
              lifecycleState: cmd.status === "local" ? "abandoned" : "failed",
              prNumber: ctx.prUrl !== undefined
                ? present(Number(prNumberFromUrl(ctx.prUrl) ?? 0))
                : absent("no_publish_attempted"),
              prUrl: ctx.prUrl !== undefined
                ? present(ctx.prUrl)
                : absent("no_publish_attempted"),
              mergedAt: absent("not_recorded"),
              mergeCommit: absent("not_recorded"),
              recordedAt: ports.clock(),
            });
          } catch {
            // best-effort — never block the terminal on delivery record write
          }
        }
      } else if (cmd.status === "needs_review" && terminalStoryId !== "") {
        ports.backlog.markStatus?.(ports.repoCwd, terminalStoryId, AWAITING_REVIEW_STATUS_MARKER);
        if (ctx.cycleId !== undefined) {
          try {
            appendDelivery(nodeDeliveryStore, ports.repoCwd, {
              storyId: terminalStoryId,
              cycleId: ctx.cycleId,
              lifecycleState: "pending_merge",
              prNumber: ctx.prUrl !== undefined
                ? present(Number(prNumberFromUrl(ctx.prUrl) ?? 0))
                : absent("no_publish_attempted"),
              prUrl: ctx.prUrl !== undefined
                ? present(ctx.prUrl)
                : absent("no_publish_attempted"),
              mergedAt: absent("not_recorded"),
              mergeCommit: absent("not_recorded"),
              recordedAt: ports.clock(),
            });
          } catch {
            // best-effort — never block the terminal on delivery record write
          }
        }
      } else if (terminalStoryId !== "") {
        // FIX-304: a failed / blocked / aborted / orphan terminal NEVER merged
        // this cycle's work to main. If the agent pre-flipped the row ✅ Done
        // (the FIX-284 / FIX-285 false-Done), revert it to the pre-cycle status
        // so a non-merged cycle can never leave a premature Done in the backlog.
        revertPrematureDone(ports, terminalStoryId, ctx.preCycleStatus);
        // US-TRUTH-015 AC2: write a DeliveryRecord for non-success terminals
        // (failed / blocked / aborted / orphan) so the truth stream is complete.
        if (ctx.cycleId !== undefined) {
          const terminalLcs = cmd.status === "blocked" ? "blocked" as const
            : cmd.status === "aborted" || cmd.status === "orphan" ? "abandoned" as const
            : "failed" as const;
          try {
            appendDelivery(nodeDeliveryStore, ports.repoCwd, {
              storyId: terminalStoryId,
              cycleId: ctx.cycleId,
              lifecycleState: terminalLcs,
              prNumber: ctx.prUrl !== undefined
                ? present(Number(prNumberFromUrl(ctx.prUrl) ?? 0))
                : absent("no_publish_attempted"),
              prUrl: ctx.prUrl !== undefined
                ? present(ctx.prUrl)
                : absent("no_publish_attempted"),
              mergedAt: absent("not_recorded"),
              mergeCommit: absent("not_recorded"),
              recordedAt: ports.clock(),
            });
          } catch {
            // best-effort — never block the terminal on delivery record write
          }
        }
      }
      // Hook 3 (spec-truth reconciliation): on ANY non-merged terminal
      // (idle/gave_up/failed/blocked/aborted/orphan/local) reset a stale "✅ Fixed/Done"
      // tick and the "[x]" AC checkboxes in the card's spec.md back to unchecked.
      // The agent commits a false "done" spec into the symlinked .roll on a cycle
      // whose product work never merged (FIX-284/285); FIX-304 only fixed the
      // backlog ROW, leaving the spec poisoned so every re-run reads "done" → 0
      // commits → idles forever. Resetting it here (committed via the
      // commitRollMetadata path below) closes that permanent dead-end so a re-run
      // CAN deliver. A genuinely MERGED Done spec is left untouched.
      if (!terminalMerged && terminalStoryId !== "") {
        resetStaleSpecTruth(ports, terminalStoryId);
        // FIX-1043: also move authoritative-looking delivery evidence (report,
        // ac-map, latest symlink) out of the gate-visible paths so a failed /
        // skipped-attest / unpublished cycle cannot leave roll-meta looking
        // delivered. Diagnostics are preserved under failed-diagnostics/.
        // FIX-1063: a published/built terminal is a gate-passing pending-merge
        // state, NOT a failure — its evidence must stay visible in the standard
        // latest/<ID>-report.html + ac-map.json paths until the PR actually merges.
        const pendingMerge = cmd.status === "published" || cmd.status === "built";
        cleanStaleEvidence(
          ports.repoCwd,
          terminalStoryId,
          ctx.cycleId ?? "",
          pendingMerge ? "published_pending_merge" : undefined,
        );
      }
      // US-V4-001: a cycle terminal no longer refreshes the global dossier
      // aggregate pages as a side effect. Cycle facts are durable events
      // (events.ndjson / runs.jsonl) surfaced by `roll cycles` / `roll cycle
      // watch` / `roll truth`; render dossier pages on demand with `roll index`.
      // FIX-306: the RUNNER commits + pushes the `.roll` metadata repo — the
      // sandboxed agent (codex) only WROTE its files (acceptance report, evidence,
      // ac-map, backlog marks) and CANNOT git-commit `.roll` (its git-internal dir
      // is outside the sandbox writable roots → meta-commit-blocked → failed
      // cycle). Runs LAST so it captures everything this terminal wrote (the runs
      // twin's backlog flip + the refreshed aggregates) plus the agent's files.
      // Uniform for every agent (no `if codex`). This does NOT decide the Done
      // flip — that stays gated on MERGED above; it only commits whatever `.roll`
      // state exists. A push failure is surfaced as an ALERT (never a silent
      // false-success); a clean tree no-ops without noise.
      await commitRollMetadata(ports, ctx);
      // FIX-1238: for in-repo layout (`.roll` tracked by main repo, not its own
      // git), commitRollMetadata is a no-op. Commit and push the backlog.md flip
      // to origin/main so the Done status is durable on the remote.
      if (terminalStoryId !== "" && inRepoLayout && inRepoDurableFlip !== null) {
        await commitInRepoBacklog(ports, ctx, inRepoDurableFlip.id, inRepoDurableFlip.status);
      }
      // US-OBS-032: best-effort cycle role summary from the event stream
      if (ctx.cycleId !== undefined) {
        const cycleLogDir = join(dirname(ports.paths.eventsPath), "cycle-logs");
        writeCycleRoleSummaryBestEffort(ctx.cycleId, ports.paths.eventsPath, cycleLogDir);
      }
      return {};
    }

    // _worktree_alert.
    case "append_alert":
      ports.events.appendAlert(ports.paths.alertsPath, cmd.message);
      return {};

    // infra/process releaseLock.
    case "release_lock":
      ports.process.releaseLock(ports.paths.lockPath);
      return { lockReleased: true };
    default: {
      const _exhaustive: never = cmd;
      throw new Error(`executeTerminalCommand: unmapped command ${JSON.stringify(_exhaustive)}`);
    }
  }
}
