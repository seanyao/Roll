/**
 * @responsibility Handles terminal commands for the remote publish path.
 */
import { lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  appendDelivery,
  managedWorkspaceReleaseVerdict,
  nodeDeliveryStore,
  planPublishDocPr,
  planPublishPr,
  projectCycleHandoff,
  releaseStoryLease,
  projectManagedWorkspaceRun,
  type CycleCommand,
  type CycleContext,
  type PublishResult,
} from "@roll/core";
import { absent, parseEventLine, present, type RollEvent } from "@roll/spec";
import { prNumberFromUrl, resolvePublishMode, submoduleWorktreePath } from "@roll/infra";
import { evaluateEvidenceGate, executeLocalPublish } from "./local-publish.js";
import { addPendingPrCreate } from "./pending-pr-create.js";
import { applyCleanupManifest, CLEANUP_TIMEOUT_MS, resolveCleanupManifest } from "./environment-cleanup.js";
import type { ExecuteResult, Ports } from "./ports.js";
import { publishBodyWithEvidenceTrailer, runPublishDocDriftGate, storyRequiresManualMerge } from "./publish-lifecycle.js";
import { stampTs, withRealCost } from "./run-records.js";
import { eventTs } from "./runner-time.js";
import { appendCleanupEvent, cleanupGuardResult, recordCleanupFailures } from "./sandbox-boundary.js";
import { releaseReason, releaseRecovery, releaseVerdict } from "./managed-workspace-guidance.js";
import { executeAppendRunCommand } from "./terminal-run-handler.js";
import { skillDispatchActorForCwd } from "./skill-dispatch-workspace.js";

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

function readLifecycleEvents(path: string): RollEvent[] {
  try {
    return readFileSync(path, "utf8").split("\n").flatMap((line) => {
      const event = parseEventLine(line);
      return event === null ? [] : [event];
    });
  } catch {
    return [];
  }
}

export async function executeTerminalCommand(
  cmd: TerminalCommand,
  ports: Ports,
  ctx: CycleContext,
): Promise<ExecuteResult> {
  // A child dispatch checkout is a bounded implementation input, never a
  // delivery authority. Reject actual runner publish/merge/release commands
  // from that location rather than relying on Skill prose or an actor flag.
  if (skillDispatchActorForCwd(ports.paths.worktreePath) === "child" && (
    cmd.kind === "publish_pr" || cmd.kind === "merge_back" || cmd.kind === "push_orphan" || cmd.kind === "cleanup_worktree"
  )) {
    ports.events.appendAlert(ports.paths.alertsPath, `skill-dispatch child denied ${cmd.kind}; parent DeliveryRun required`);
    return cmd.kind === "publish_pr"
      ? { event: { type: "published", result: { status: 1, manualMerge: false } } }
      : {};
  }
  switch (cmd.kind) {
    // delivery/pr planPublishPr → github.runPublishPlan → published result.
    case "publish_pr": {
      const manualMerge = cmd.manualMerge === true || storyRequiresManualMerge(ports.repoCwd, ctx.storyId);
      // US-RULE-004b — the publish-gate doc-drift check, ONCE per publish
      // attempt, for BOTH delivery modes: the cycle's delivery diff vs its
      // INTEGRATION BASE (not HEAD~1) judged against the tracked
      // policy/rules.yaml registry via the SHARED 004a verdict. A LOCAL cycle
      // delivery is still a publish attempt, so the gate runs HERE — before the
      // local/remote branch — exactly once, and the E3 local landing path never
      // bypasses it. In gates.doc_drift:soft a hit records the stable
      // doc_drift_soft_hit fact + prints the bilingual diagnostic, and SOFT
      // NEVER BLOCKS — publish continues with exit 0 (hard blocking semantics
      // arrive with US-RULE-006). Registry/base/diff unknowns are fail-loud
      // (ALERT + unresolved mode), never silently treated as "no drift". A
      // gate throw (e.g. an events-append failure) must never topple publish
      // either — alert and continue.
      try {
        runPublishDocDriftGate(ports, ctx);
      } catch (e) {
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `doc-drift gate (US-RULE-004b): unexpected failure — ${String(e)} — publish continues (soft never blocks) (cycle ${ctx.cycleId ?? "?"})`,
        );
      }
      // E3: local-only delivery mode. A `publish_mode: local` project lands the
      // cycle on its LOCAL integration branch and skips push→PR→CI→merge — but
      // the evidence gate STILL runs (a gate-block is a fault, publish or not).
      // Resolved from the MAIN checkout's project config (like E1's integration
      // branch). Default `remote` ⇒ the entire block below is byte-identical.
      if (resolvePublishMode(ports.repoCwd) === "local") {
        return executeLocalPublish(cmd, ports, ctx, manualMerge);
      }
      const slug = await ports.github.repoSlug(ports.repoCwd);
      if (slug === undefined) {
        // gh unavailable / no github remote → status 2 (gh-missing tier).
        const pub: PublishResult = { status: 2, mergedBack: false, orphanPushed: false, manualMerge, ...(cmd.draft === true ? { draft: true } : {}) };
        return { event: { type: "published", result: pub } };
      }
      // FIX-245 AC2: an agent that opened its own PR inside the cycle bypassed
      // every runner gate (observed: PR #578, single un-prefixed commit). The
      // runner detects it at publish time, ADOPTS the registration (the PR is
      // real — the books must say published) and logs the discipline breach.
      const preState = await ports.github.prState(ports.repoCwd, cmd.branch).catch(() => "UNKNOWN");
      if (preState === "OPEN" || preState === "MERGED") {
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `discipline: agent self-published a PR for ${cmd.branch} (cycle ${ctx.cycleId}) — runner adopted it; gates ran post-hoc (FIX-245)`,
        );
        const pub: PublishResult = { status: 0, manualMerge, ...(cmd.draft === true ? { draft: true } : {}) };
        return { event: { type: "published", result: pub } };
      }
      // US-DELIV-004 / RL-DELIV-010 — push-time evidence gate (fail-loud): verify the
      // acceptance evidence (attest report + ac-map) was produced BEFORE the
      // branch leaves the machine. Missing evidence ⇒ blocked_no_evidence:
      // the branch is NEVER pushed and no PR is opened — "pushed a branch but
      // opened no PR" (裸分支无 PR) stops being a normal outcome and becomes a
      // fault state (zero-TCR class). The checkpoint moves earlier; the attest
      // judgement itself is unchanged (FIX-329). Doc-only PRs and story-less
      // publishes skip the gate (nothing to attest); the FIX-245 adoption
      // short-circuit above already returned for branches that have a PR.
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
      // US-LOOP-094: the cycle worktree is DETACHED (no local branch). Push its
      // HEAD to the remote ref explicitly, FROM THE WORKTREE CWD — this replaces
      // the git-push step formerly in planPublishPr. Same short-circuit as
      // before: a push failure is a status-1 publish (PR steps never run).
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

    case "cleanup_worktree":
      // Remove only our .roll link; never its persistent target.
      try {
        const dst = join(ports.paths.worktreePath, ".roll");
        if (lstatSync(dst, { throwIfNoEntry: false })?.isSymbolicLink() === true) unlinkSync(dst);
      } catch {
        /* tolerant cleanup, mirrors _worktree_cleanup */
      }
      const managed = ports.git.managedWorktreeInspect !== undefined && ports.git.managedWorktreeRelease !== undefined;
      // US-CYCLE-013 — handoff-aware cleanup: for a cycle with a LIVE handoff
      // identity, release is DEFERRED until the resumed tail's ordinary terminal
      // cleanup — never release a handoff workspace merely because a new Builder
      // starts. `cycle:cleanup_completed` is the ONLY fact that releases the
      // workspace + story lease for the handoff path; it is appended only after
      // the identity-checked release succeeds (a failure retains W + lease with
      // a readable `cycle:serial_recovery` record).
      let handoffCleanup: { attempt: number; fence: string } | undefined;
      if (managed) {
        const events = readLifecycleEvents(ports.paths.eventsPath);
        const view = projectCycleHandoff(events, ctx.cycleId);
        if (view?.identity !== undefined) {
          const releasable = view.state === "terminal" || view.state === "publish_or_merge_wait";
          if (!releasable) {
            ports.events.appendAlert(
              ports.paths.alertsPath,
              `cycle ${ctx.cycleId}: handoff workspace release deferred — handoff still live (state ${view.state}); the resumed tail owns cleanup`,
            );
            return {};
          }
          handoffCleanup = { attempt: view.identity.attempt, fence: view.identity.fence };
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "cycle:cleanup_started",
            eventId: randomUUID(),
            idempotencyKey: `cleanup_started:${ctx.cycleId}:${view.identity.attempt}:${view.identity.fence}`,
            cycleId: ctx.cycleId,
            attempt: view.identity.attempt,
            fence: view.identity.fence,
            ts: eventTs(ports),
          });
        }
      }
      if (managed) {
        const inspect = ports.git.managedWorktreeInspect;
        const release = ports.git.managedWorktreeRelease;
        if (inspect === undefined || release === undefined) return {};
        const events = readLifecycleEvents(ports.paths.eventsPath);
        const appendCleanupCompleted = (releasedWorkspace: boolean): void => {
          if (handoffCleanup === undefined) return;
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "cycle:cleanup_completed",
            eventId: randomUUID(),
            idempotencyKey: `cleanup_completed:${ctx.cycleId}:${handoffCleanup.attempt}:${handoffCleanup.fence}`,
            cycleId: ctx.cycleId,
            attempt: handoffCleanup.attempt,
            fence: handoffCleanup.fence,
            releasedWorkspace,
            ts: eventTs(ports),
          });
        };
        const recordCleanupRecovery = (reason: string): void => {
          if (handoffCleanup === undefined) return;
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "cycle:serial_recovery",
            eventId: randomUUID(),
            idempotencyKey: `recovery:${ctx.cycleId}:${handoffCleanup.attempt}:${handoffCleanup.fence}:${reason}`,
            cycleId: ctx.cycleId,
            attempt: handoffCleanup.attempt,
            fence: handoffCleanup.fence,
            reason,
            ts: eventTs(ports),
          });
        };
        const allocation = [...events].reverse().find((event): event is Extract<typeof event, { type: "worktree:allocated" }> => event.type === "worktree:allocated" && event.workspace.runId === ctx.cycleId);
        const primary = allocation?.workspace.members[0];
        if (allocation === undefined || primary === undefined) {
          ports.events.appendAlert(ports.paths.alertsPath, releaseRecovery(ctx.cycleId, releaseReason("missing_identity")));
          return {};
        }
        const operationId = `${ctx.cycleId}:release`;
        let priorRequest = [...events].reverse().find((event): event is Extract<typeof event, { type: "worktree:release_requested" }> => event.type === "worktree:release_requested" && event.runId === ctx.cycleId && event.operationId === operationId);
        const inspections = await Promise.all(allocation.workspace.members.map(async (member) => {
          const suffix = `${primary.workspaceKey}.submodules/`;
          const submodule = member.relativeLocator.startsWith(suffix) ? member.relativeLocator.slice(suffix.length) : undefined;
          const repoCwd = submodule === undefined ? ports.repoCwd : join(ports.repoCwd, submodule);
          const path = submodule === undefined ? ports.paths.worktreePath : submoduleWorktreePath(ports.paths.worktreePath, submodule);
          return { member, repoCwd, path, inspection: await inspect(repoCwd, path) };
        }));
        const delivery = events.some((event) => event.type === "delivery:merge_confirmed" && event.cycleId === ctx.cycleId) ? "merged" : "unknown";
        const attest = events.some((event) => event.type === "attest:gate" && event.cycleId === ctx.cycleId && event.verdict === "produced") ? "accepted" : "unknown";
        if (priorRequest === undefined) {
          const ready = inspections.every(({ member, inspection: fresh }) => fresh !== undefined
            && fresh.registered
            && fresh.clean
            && fresh.repositoryId === member.repositoryId);
          if (!ready || delivery !== "merged" || attest !== "accepted") {
            ports.events.appendAlert(ports.paths.alertsPath, releaseRecovery(ctx.cycleId, releaseReason("preconditions")));
            recordCleanupRecovery("cleanup_failed");
            return {};
          }
          const expectedHeads = inspections.map(({ member, inspection: fresh }) => ({
            relativeLocator: member.relativeLocator,
            head: fresh!.head,
          }));
          priorRequest = { type: "worktree:release_requested", runId: ctx.cycleId, reason: "delivered", operationId, expectedHeads, ts: eventTs(ports) };
          ports.events.appendEvent(ports.paths.eventsPath, priorRequest);
          events.push(priorRequest);
        }
        const expectedHeads = priorRequest.expectedHeads;
        const absence = await Promise.all(inspections.map(async ({ repoCwd, path, inspection: fresh }) =>
          fresh === undefined ? ports.git.managedWorktreeAbsent?.(repoCwd, path) ?? false : false));
        if (inspections.some(({ inspection: fresh }, index) => fresh === undefined && !absence[index])) {
          ports.events.appendAlert(ports.paths.alertsPath, releaseRecovery(ctx.cycleId, releaseReason("inspection_unknown")));
          recordCleanupRecovery("cleanup_failed");
          return {};
        }
        const present = inspections.filter(({ inspection: fresh }) => fresh !== undefined) as Array<typeof inspections[number] & { inspection: NonNullable<typeof inspections[number]["inspection"]> }>;
        if (present.length === 0) {
          ports.events.appendEvent(ports.paths.eventsPath, { type: "worktree:released", runId: ctx.cycleId, operationId, expectedHeads, ts: eventTs(ports) });
          appendCleanupCompleted(true);
          if (ctx.storyId !== undefined && ctx.storyId !== "") releaseStoryLease(join(dirname(ports.paths.eventsPath), "leases"), ctx.storyId, { source: "cycle", pid: process.pid, runId: ctx.cycleId });
          return {};
        }
        const run = projectManagedWorkspaceRun(ctx.cycleId, events);
        const verdict = managedWorkspaceReleaseVerdict({
          runState: run?.state ?? "unknown",
          delivery,
          attest,
          factsAgree: true,
          members: present.map(({ member, inspection: fresh }) => ({
            relativeLocator: member.relativeLocator,
            registration: fresh.registered === true && fresh.repositoryId === member.repositoryId ? "registered" : "foreign",
            activity: "inactive",
            head: fresh.head === expectedHeads.find((expected) => expected.relativeLocator === member.relativeLocator)?.head ? "expected" : "mismatch",
            cleanliness: fresh.clean === true ? "clean" : "dirty",
          })),
        });
        if (verdict.verdict !== "safe_to_release") {
          ports.events.appendAlert(ports.paths.alertsPath, releaseRecovery(ctx.cycleId, releaseVerdict(verdict.verdict)));
          recordCleanupRecovery("cleanup_failed");
          return {};
        }
        for (const { member, repoCwd, path } of [...present].reverse()) {
          const expectedHead = expectedHeads.find((expected) => expected.relativeLocator === member.relativeLocator)?.head;
          if (expectedHead === undefined) {
            ports.events.appendAlert(ports.paths.alertsPath, releaseRecovery(ctx.cycleId, releaseReason("expected_head_incomplete")));
            recordCleanupRecovery("cleanup_failed");
            return {};
          }
          const released = await release(repoCwd, path, expectedHead, member.repositoryId, {
            allowVerifiedSubmoduleForce: true,
          });
          if (released.code !== 0) {
            ports.events.appendAlert(ports.paths.alertsPath, releaseRecovery(ctx.cycleId, releaseReason("effect_refused")));
            recordCleanupRecovery("cleanup_failed");
            return {};
          }
        }
        try {
          ports.events.appendEvent(ports.paths.eventsPath, { type: "worktree:released", runId: ctx.cycleId, operationId, expectedHeads, ts: eventTs(ports) });
          appendCleanupCompleted(true);
          if (ctx.storyId !== undefined && ctx.storyId !== "") releaseStoryLease(join(dirname(ports.paths.eventsPath), "leases"), ctx.storyId, { source: "cycle", pid: process.pid, runId: ctx.cycleId });
        } catch {
          ports.events.appendAlert(ports.paths.alertsPath, releaseRecovery(ctx.cycleId, releaseReason("event_missing")));
          recordCleanupRecovery("cleanup_failed");
        }
      } else {
        await ports.git.worktreeRemove(ports.repoCwd, ports.paths.worktreePath, cmd.branch, cmd.bundleUnpushed);
      }
      if (!managed && ctx.targetSubmodule !== undefined && ctx.targetSubmodule !== "") {
        try {
          await ports.git.worktreeRemoveInSubmodule(
            ports.repoCwd,
            ctx.targetSubmodule,
            submoduleWorktreePath(ports.paths.worktreePath, ctx.targetSubmodule),
          );
        } catch {
          /* legacy cleanup is best-effort */
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

    case "append_run":
      return executeAppendRunCommand(cmd, ports, ctx);

    case "append_alert":
      ports.events.appendAlert(ports.paths.alertsPath, cmd.message);
      return {};

    case "release_lock":
      ports.process.releaseLock(ports.paths.lockPath);
      return { lockReleased: true };
    default: {
      const _exhaustive: never = cmd;
      throw new Error(`executeTerminalCommand: unmapped command ${JSON.stringify(_exhaustive)}`);
    }
  }
}
