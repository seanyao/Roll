import {
  assessBacklog,
  buildClaimedByOther,
  buildHasOpenPr,
  claimStoryLease,
  cleanDeadLeases,
  decideClaimReconcile,
  hasMergedDelivery,
  isHumanSoftLeaseActive,
  isLeaseAlive,
  latestDeliveringCycle,
  leaseBlockReason,
  openPrBlockReason,
  pickStory,
  projectDeliveryLeases,
  readLeases,
  reconcileBranchName,
  releaseStoryLease,
  runRowHasPublishedPr,
  type BacklogItem,
  type CycleCommand,
  type CycleContext,
  type HasOpenPr,
  type OpenPrReferenceInput,
  type PickOptions,
} from "@roll/core";
import { classifyStatus, STATUS_MARKER, type LoopType } from "@roll/spec";
import { isScreenLocked, readWorkspace, resolveIntegrationBranch } from "@roll/infra";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { storySpecPath } from "./attest-gate.js";
import { physicalTerminalFromSpecText } from "../lib/physical-terminal.js";
import { createSubmoduleWorktreeIfDeclared } from "./submodule-worktree.js";
import { markDoneGuarded } from "./done-guard.js";
import { eventTs } from "./runner-time.js";
import { readSkipCards } from "./skip-cards.js";
import { readPendingPublish } from "./pending-publish.js";
import { appendPickRankedEvent, resolvePickRanking } from "./pick-ranking.js";
import { readRunsRows } from "./run-records.js";
import { resetStaleSpecTruth, resolveResumeBase } from "./resume-truth.js";
import { runVisualEvidencePreflight } from "./publish-lifecycle.js";
import { freezeContractSnapshot } from "./contract-snapshot.js";
import { bootstrapWorktreeDeps, bootstrapWorktreePrebuild, bootstrapWorktreeSkills, linkRollIntoWorktree, readPrebuildDistEnabled } from "./worktree-bootstrap.js";
import { planAdversarial, recordExecutionProfile, routerEstMin } from "./execution-profile.js";
import type { ExecuteResult, Ports } from "./ports.js";
import { activeRigs, probeDueSuspendedRigs, readRigLifecycleState, suspendedRigs } from "./agent-liveness.js";
import { latestScreenLockEvent } from "./screen-lock-events.js";
import { pendingRecoveryCandidateIds } from "./recovery-candidates.js";
import { resolveStoryLeasePath } from "./story-lease-path.js";
import { decideInProgressReclaim, parseLegacyClaimTimestamp, readLeaseEvents } from "./lease-reclaim.js";
import {
  freezeWorkspaceCycleContext,
  persistWorkspaceCycleContext,
  persistWorkspaceCycleRepositorySelector,
} from "./scoped-route.js";

type SetupCommand = Extract<CycleCommand, { kind:
  | "preflight"
  | "create_worktree"
  | "pick_story"
  | "resume_worktree"
  | "resolve_route"
}>;

/** Resolve Workspace and legacy runners onto the canonical per-story lease directory. */
function storyLeasePath(ports: Ports): string {
  return resolveStoryLeasePath(ports.paths);
}

function workspaceSetupFailed(input: {
  readonly ports: Ports;
  readonly storyId: string;
  readonly preCycleStatus?: string;
  readonly leasePath: string;
  readonly alert?: string;
}): ExecuteResult {
  if (input.alert !== undefined) input.ports.events.appendAlert(input.ports.paths.alertsPath, input.alert);
  input.ports.backlog.markStatus?.(input.ports.repoCwd, input.storyId, input.preCycleStatus ?? STATUS_MARKER.todo);
  try {
    releaseStoryLease(input.leasePath, input.storyId, { source: "cycle", pid: process.pid });
  } catch {
    /* terminal cleanup retries the lease release */
  }
  return {
    event: { type: "repository_setup_failed", storyId: input.storyId },
    ctxPatch: input.preCycleStatus === undefined || input.preCycleStatus === "" ? {} : { preCycleStatus: input.preCycleStatus },
  };
}
export async function executeSetupCommand(
  cmd: SetupCommand,
  ports: Ports,
  ctx: CycleContext,
): Promise<ExecuteResult> {
  switch (cmd.kind) {
    case "preflight": {
      if (ports.repositories !== undefined) return { event: { type: "preflight_done" } };
      // FIX-198/FIX-112/FIX-211 — PR-aware claim reconcile. The inner lock
      // guarantees a single live cycle per project, so a 🔨 In Progress row is
      // from a PRIOR cycle. It is NOT always a dead claim (FIX-211): a cycle
      // that delivered — opened a PR and handed merge to the reconciler
      // (US-AUTO-044) — legitimately rests at 🔨 until the PR merges; blindly
      // resetting it to 📋 Todo would re-pick and duplicate the work. Reconcile
      // each claim against REAL merge evidence (decideClaimReconcile):
      //   MERGED      → ✅ Done  (补翻 the async-merged delivery — Done ≡ merged),
      //   CLOSED/no-PR→ 📋 Todo  (genuine dead claim / abandoned — re-pickable),
      //   OPEN/unknown→ leave 🔨 (delivered, pending merge; TTL unstick is the
      //                          safety net for a claim that never resolves).
      try {
        const rows = ports.backlog.read(ports.repoCwd) as Array<{ id: string; status?: string }>;
        const runRows = readRunsRows(ports.paths.runsPath);
        // FIX-323 / FIX-906: a 📋 Todo card whose delivery already MERGED is Done
        // — its deliverable is on main (a prior gave_up reset the status text but
        // not the merge). Flip it here (cheap, local, no gh probe) so the picker
        // pool stays honest and the merged zombie is never re-picked. The merge
        // signal is the UNIFIED delivery truth ({@link mergedFromTruth}): the
        // structured projection (runs + git merges on origin/main) when wired,
        // OR'd with the runs-only `hasMergedDelivery` — so an external / manual
        // merge (claude salvage, PR-lane direct merge) flips the card too, not
        // just loop-cycle deliveries. Complements the picker's own guard.
        const mergedFromTruth = (id: string): boolean =>
          (ports.mergedDelivery?.(id) ?? false) || hasMergedDelivery(runRows, id);
        for (const r of rows) {
          if (!(r.status ?? "").includes(STATUS_MARKER.todo)) continue;
          if (mergedFromTruth(r.id)) {
            markDoneGuarded(ports.repoCwd, r.id, { mergedToMain: true }, {
              markStatus: (projectCwd, id, status) => ports.backlog.markStatus?.(projectCwd, id, status),
              alert: (m) => ports.events.appendAlert(ports.paths.alertsPath, m),
            });
          }
        }
        const claims = rows.filter((r) => (r.status ?? "").includes("🔨"));
        if (claims.length > 0) {
          const slug = await ports.github.repoSlug(ports.repoCwd).catch(() => undefined);
          const leases = readLeases(storyLeasePath(ports));
          const nowMs = Date.now();
          for (const claim of claims) {
            const cycle = latestDeliveringCycle(runRows, claim.id);
            let prState: string | undefined;
            if (cycle !== undefined && slug !== undefined) {
              prState = await ports.github
                .prState(ports.repoCwd, reconcileBranchName(cycle))
                .catch(() => undefined);
            }
            const decision = decideClaimReconcile({ hasDeliveringCycle: cycle !== undefined, prState, hasPublishedPr: runRowHasPublishedPr(runRows, claim.id) });
            if (decision === "done") {
              markDoneGuarded(ports.repoCwd, claim.id, { mergedToMain: true }, {
                markStatus: (projectCwd, id, status) => ports.backlog.markStatus?.(projectCwd, id, status),
                alert: (m) => ports.events.appendAlert(ports.paths.alertsPath, m),
              });
            }
            else if (decision === "todo") {
              // Dead claims stay immediately recoverable. Soft leases only
              // protect explicit human/supervisor claims: a lease-file entry or
              // a backlog row carrying a claim timestamp.
              const { action, reason } = decideInProgressReclaim(leases[claim.id], nowMs, claim.id, parseLegacyClaimTimestamp(claim));
              if (action === "reclaim") {
                ports.backlog.markStatus?.(ports.repoCwd, claim.id, STATUS_MARKER.todo);
                ports.events.appendAlert(ports.paths.alertsPath, `[FIX-1211] reclaim ${claim.id}: ${reason}`);
              } else {
                ports.events.appendAlert(ports.paths.alertsPath, `[FIX-1211] preserve ${claim.id}: ${reason}`);
              }
            }
            // "keep" → leave 🔨 (delivered, pending merge).
          }
        }
      } catch {
        /* heal is best-effort */
      }
      // FIX-209: refresh origin/main BEFORE the worktree branches off it. The
      // worktree is created with base `origin/main` (create_worktree below);
      // without this fetch a PR merged on the remote since the last fetch is
      // invisible locally and the cycle opens on a stale baseline → conflicts.
      // LENIENT (mirrors v2 `_worktree_fetch_origin`): a fetch failure leaves a
      // WARN trace and the cycle proceeds on the existing baseline.
      try {
        const { fetched } = await ports.git.fetchOrigin(ports.repoCwd, "main");
        if (!fetched) {
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `[WARN] cycle ${ctx.cycleId}: preflight fetch origin main failed; proceeding on existing baseline`,
          );
        }
      } catch {
        /* fetch is lenient — never topple the cycle on a network blip */
      }
      return { event: { type: "preflight_done" } };
    }

    // infra/git _worktree_create (STRICT). worktree_created on success, else
    // worktree_failed (→ failed terminal, bin/roll:9000).
    case "create_worktree": {
      if (ports.repositories !== undefined) return { event: { type: "worktree_created" } };
      // RESUME-PRIOR-WORK does NOT happen here: the story id is UNDEFINED at
      // create_worktree (the picker reads the backlog INSIDE the worktree,
      // FIX-198/FIX-204C), so resume/submodule decisions are deferred to the
      // post-pick steps (resume_worktree + the E2 submodule worktree) — FIX-284.
      // E1: base = configured integration branch (default origin/main → unchanged).
      const base = resolveIntegrationBranch(ports.repoCwd);
      const r = await ports.git.worktreeAdd(
        ports.repoCwd,
        ports.paths.worktreePath,
        cmd.branch,
        base,
      );
      if (r.code !== 0) return { event: { type: "worktree_failed" } };
      // FIX-204C: `.roll/` is a nested gitignored repo — a fresh worktree has
      // NONE of it, while the loop skill promises CWD-relative `.roll/*`. The
      // 2026-06-06 first live run showed the failure mode: the agent went
      // hunting, found the MAIN checkout's .roll, and edited THERE — worktree
      // captured zero commits and the cycle idled. Symlink the main .roll into
      // the worktree so the contract holds (single source of truth; the inner
      // lock already guarantees one cycle at a time).
      await linkRollIntoWorktree(ports.repoCwd, ports.paths.worktreePath);
      // FIX-302 root cause: a git worktree carries NONE of the parent repo's
      // submodule contents — `skills/` lands EMPTY (0 files; main has 28). The
      // full `roll test`/`pnpm -r test` reads skills/, so on an empty worktree
      // the suite can never run, AC4 stays "partial", and the cycle can never
      // honestly close a card. Populate the submodule HERE, in the runner (same
      // place deps install — network + warm caches). On failure, fail the
      // worktree setup with an honest terminal reason rather than spawn the
      // agent into an env where AC4 silently goes partial.
      const skillsOk = await bootstrapWorktreeSkills(
        ports.paths.worktreePath,
        ports.paths.alertsPath,
        ports.events,
        ports.git.worktreeSubmoduleInit,
      );
      if (!skillsOk) return { event: { type: "worktree_failed" } };
      // FIX-268 root cause: a fresh worktree has NO node_modules, and the
      // agent sandbox has no network — its own install dies on ENOTFOUND,
      // tests never run, the TCR gate never passes, and the whole cycle can
      // evaporate as idle_no_work. Install HERE, in the runner (outside the
      // sandbox, with network). If that fails, fail the worktree setup before
      // the agent spawns so the terminal reason is the dependency bootstrap.
      const depsOk = await bootstrapWorktreeDeps(
        ports.paths.worktreePath,
        ports.paths.alertsPath,
        ports.events,
        ports.depsExec,
      );
      if (!depsOk) return { event: { type: "worktree_failed" } };
      // FIX-338 (Phase B 杠杆1): with deps now present, PREBUILD the workspace
      // dist so the agent finds dist/roll.mjs already built (saving the cold
      // find/build round-trips). DEFAULT-OFF (稳字纪律) — a no-op until
      // `loop_safety.prebuild_dist: true`. Agent-agnostic + best-effort: a build
      // failure never topples the cycle, so it runs AFTER the strict deps/skills
      // gates and its outcome is intentionally ignored.
      await bootstrapWorktreePrebuild(
        ports.paths.worktreePath,
        ports.paths.alertsPath,
        ports.events,
        readPrebuildDistEnabled(ports.repoCwd),
        ports.depsExec,
      );
      return { event: { type: "worktree_created" } };
    }

    // backlog/picker pickStory (read backlog INSIDE the worktree, bin/roll:8938).
    case "pick_story": {
      // Read from the MAIN project (FIX-198): ordinary projects gitignore
      // .roll/, so the worktree has no backlog at all — a worktree read picks
      // nothing and the loop silently idles.
      const items = ports.backlog.read(ports.repoCwd);
      // FIX-323 / FIX-906: feed the picker the UNIFIED merge truth. A card whose
      // deliverable already MERGED is Done — even if its backlog row was reset to
      // 📋 Todo by a prior gave_up cycle (the agent found the work on main, made
      // no commit → gave_up → status reset → re-pick → burn). The picker reads
      // only backlog text, so without this it re-picks the merged zombie forever.
      // The signal is the structured projection (`ensureDeliveriesFresh` →
      // `queryStoryDelivery(id).delivered`, which reads runs + git merges on
      // origin/main — FIX-904/905) when wired via {@link mergedDelivery}, OR'd
      // with the runs-only `hasMergedDelivery`. The projection sees EXTERNAL /
      // manual merges (claude salvage, PR-lane direct merge of a non-loop-cycle
      // PR) that runs.jsonl is blind to — the exact case that had the picker
      // re-selecting already-merged cards (FIX-903/904/390) every cycle.
      const pickRunRows = readRunsRows(ports.paths.runsPath);
      // FIX-363 (loop resilience): skip poison-pill cards (failed K times) so a
      // single un-deliverable card no longer halts the WHOLE loop — it keeps
      // delivering the rest. Runtime overlay (.roll/loop/skip-cards.json); backlog
      // truth is untouched.
      const skipCards = readSkipCards(dirname(ports.paths.eventsPath));
      // Legacy projects de-dup picks against open PRs; Workspace delivery is repository-scoped downstream.
      let openPrTitles: OpenPrReferenceInput[] = [];
      let ghError = false;
      if (ports.repositories === undefined) {
        try {
          openPrTitles = await ports.github.openPrTitles(ports.repoCwd);
        } catch (err) {
          ghError = true;
          const msg = err instanceof Error ? err.message : String(err);
          ports.events.appendAlert(ports.paths.alertsPath, `[WARN] cycle ${ctx.cycleId}: gh pr list failed (${msg.slice(0, 120)}); proceeding with empty PR list — cards with pending-publish markers remain pickable`);
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "pick:gh_error",
            cycleId: ctx.cycleId,
            reason: msg.slice(0, 200),
            ts: eventTs(ports),
          });
        }
      }
      const githubHasOpenPr = buildHasOpenPr(openPrTitles);
      const pendingMergeReason = (id: string): string | undefined => {
        const pendingMerge = ports.pendingMergeDelivery?.(id);
        if (pendingMerge === undefined) return undefined;
        if (!githubHasOpenPr(id)) return undefined;
        return pendingMerge.prNumber === undefined ? "awaiting merge of open PR" : `awaiting merge of PR #${pendingMerge.prNumber}`;
      };
      const hasOpenPr = ((id: string): boolean => githubHasOpenPr(id)) as HasOpenPr;
      Object.defineProperty(hasOpenPr, "openPrBlockReason", {
        value: (id: string): string | undefined => {
          const githubReason = openPrBlockReason(id, githubHasOpenPr);
          if (githubReason !== "awaiting merge of open PR") return githubReason ?? pendingMergeReason(id);
          return pendingMergeReason(id) ?? githubReason;
        },
      });
      const pendingPublish = readPendingPublish(dirname(ports.paths.eventsPath));
      // FIX-1232: clean dead PID leases from the lease file before the picker
      // runs. A crashed cycle leaves a stale cycle-lease that accumulates in the
      // file. Clean it before the claim predicate reads the shared ledger so a
      // dead owner cannot keep the Story blocked.
      const leasePath = storyLeasePath(ports);
      const deadLeases = cleanDeadLeases(leasePath);
      if (deadLeases.length > 0) {
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `[FIX-1232] cleaned ${deadLeases.length} dead lease(s): ${deadLeases.join(", ")}`,
        );
      }
      // US-DELIV-005: derive delivery leases before picking; --race permits
      // parallel work, then the first merge supersedes its siblings.
      const raceMode = process.env["ROLL_LOOP_RACE"] === "1";
      const liveClaims = readLeases(leasePath);
      const claimedByOther = buildClaimedByOther(liveClaims, Date.now(), process.pid);
      const cycleEvents = readLeaseEvents(ports.paths.eventsPath);
      const recoveryCandidateIds = pendingRecoveryCandidateIds(cycleEvents);
      const activeLeases = projectDeliveryLeases(cycleEvents).filter(
        // An in_flight lease with no LIVE cycle claim is a ghost (crashed
        // cycle, no cycle:end) — a legal fix-forward retry must stay pickable.
        (l) => {
          if (l.state !== "in_flight") return true;
          const claim = liveClaims[l.storyId];
          return claim !== undefined && isLeaseAlive(claim);
        },
      );
      // FIX-1268: build a physical-surface predicate so the picker can hold
      // physical_terminal cards while the console is locked.
      const requiresPhysicalSurface = (id: string): boolean => {
        const specPath = storySpecPath(ports.repoCwd, id);
        if (specPath === null) return false;
        try {
          return physicalTerminalFromSpecText(readFileSync(specPath, "utf8")) !== null;
        } catch {
          return false;
        }
      };
      const screenLocked = await isScreenLocked();
      if (screenLocked) {
        // Emit per-card skip facts for observability BEFORE the picker runs.
        for (const item of items) {
          if (classifyStatus(item.status) !== "todo") continue;
          if (!requiresPhysicalSurface(item.id)) continue;
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "pick:skipped",
            cycleId: ctx.cycleId,
            storyId: item.id,
            reason: "screen_locked",
            ts: eventTs(ports),
          });
        }
      }
      const eligibility: PickOptions = {
        hasOpenPr,
        hasMergedDelivery: (id) =>
          (ports.mergedDelivery?.(id) ?? false) || hasMergedDelivery(pickRunRows, id),
        isRecoveryCandidate: (id) => recoveryCandidateIds.has(id),
        shouldSkip: (id) => skipCards.has(id),
        hasPendingPublish: (id) =>
          (ports.pendingPublish?.(id) ?? false) || pendingPublish.has(id),
        isClaimedByOther: (id) => {
          const lease = liveClaims[id];
          if (lease === undefined) return false;
          if (lease.source === "human" || lease.source === "supervisor") {
            return isHumanSoftLeaseActive(lease, Date.now());
          }
          return claimedByOther(id);
        },
        skipClaimedReason: (id) => {
          const lease = liveClaims[id];
          return lease === undefined ? undefined : `claimed by ${lease.source}`;
        },
        deliveryLeaseBlock: (id) => leaseBlockReason(id, activeLeases, { race: raceMode }),
        isScreenLocked: screenLocked,
        requiresPhysicalSurface,
      };
      for (const item of items) {
        if (classifyStatus(item.status) !== "todo") continue;
        const reason = openPrBlockReason(item.id, hasOpenPr) ?? eligibility.deliveryLeaseBlock?.(item.id);
        if (reason === undefined) continue;
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "pick:skipped",
          cycleId: ctx.cycleId,
          storyId: item.id,
          reason,
          ts: eventTs(ports),
        });
      }
      // FIX-1215: emit pick:blocked events for ALL eligible-but-skipped cards
      // so idle output shows WHICH cards are blocked and WHY (not just open PR).
      const assessment = assessBacklog(items as BacklogItem[], eligibility);
      const wasWaitingForScreenUnlock = latestScreenLockEvent(ports.paths.eventsPath)?.locked === true;
      if (assessment.reason === "screen_locked") {
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "loop:screen_locked",
          cycleId: ctx.cycleId,
          locked: true,
          reason: "console locked — physical-surface cards held",
          ts: eventTs(ports),
        });
      } else if (wasWaitingForScreenUnlock) {
        // FIX-1268b: the wait clears as soon as a later tick can dispatch.
        // Usually that is an unlock, but a newly eligible non-physical card also
        // means the scheduler is no longer waiting on the lock.
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "loop:screen_locked",
          cycleId: ctx.cycleId,
          locked: false,
          reason: screenLocked ? "screen lock no longer blocks dispatch" : "console unlocked — physical-surface cards eligible",
          ts: eventTs(ports),
        });
      }
      const blockedCards = assessment.blockedCards;
      if (blockedCards !== undefined && blockedCards.length > 0) {
        for (const bc of blockedCards) {
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "pick:blocked",
            cycleId: ctx.cycleId,
            storyId: bc.id,
            reason: bc.reason,
            ts: eventTs(ports),
          });
        }
      }
      // Also emit pick:skipped for the gh-error case (FIX-1215 AC1): when gh
      // failed but there is eligible work, we want the loop to know it proceeded
      // despite the blip.
      if (ghError) {
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "pick:gh_degraded",
          cycleId: ctx.cycleId,
          reason: "gh pr list failed; proceeding without open-PR de-duplication",
          ts: eventTs(ports),
        });
      }
      const semanticRanking = await resolvePickRanking(ports, ctx, items as BacklogItem[], eligibility);
      const story = pickStory(items as never, {
        ...eligibility,
        ranking: semanticRanking?.ranking,
      });
      if (story === undefined) {
        // FIX-1268: when the only blocker is a locked screen holding physical-surface
        // cards, tell the driver so it can avoid counting this as idle/dormant.
        if (assessment.reason === "screen_locked") {
          return { event: { type: "no_story" }, ctxPatch: { screenLocked: true } };
        }
        return { event: { type: "no_story" } };
      }
      appendPickRankedEvent(ports, ctx, story.id, semanticRanking);
      // Hook 3 (pre-spawn spec-truth check): the picker only returns a card whose
      // backlog row is NOT ✅ Done and that has no open PR (so by construction it
      // is NOT merged). If that card's spec.md still claims "✅ Fixed/Done / [x]
      // AC", the spec is STALE (a prior non-merged cycle left it poisoned). Reset
      // it BEFORE the agent reads it, so the agent never silently concludes "done
      // → nothing to do → idle". This is exactly the FIX-284/285 dead-end: with a
      // clean spec the re-run can deliver. A genuinely merged Done card is never
      // picked here (its row is ✅ Done), so this never touches a real Done spec.
      resetStaleSpecTruth(ports, story.id);
      // FIX-311b — the BUILD-PREFLIGHT visual-evidence gate (the shift-left of
      // the FIX-309 attest gate). Runs HERE, after the spec-truth reset and
      // BEFORE the agent spawns (pick_story → resume → resolve_route →
      // spawn_agent), so a spec that can NEVER satisfy the runtime screenshot
      // floor is flagged loud at the cheapest possible moment instead of after a
      // full build cycle honest-skips. CONSERVATIVE BY DESIGN (owner red line:
      //误杀 CLI/后端卡 = 阻断 loop, 绝不可): it ALERTs only when CONFIDENT —
      // a clear WEB-surface card that declared no `deliverable_url`, or a card
      // with NO visual-evidence AC and NO recorded exemption. A terminal/CLI/TUI
      // deliverable, an ambiguous surface, or an unreadable spec is LEFT ALONE
      // (FIX-309 backstops at delivery). It NEVER changes the cycle's control
      // flow — story_picked still returns — so a false positive cannot topple a
      // CLI/back-end card; it only raises a visible signal.
      runVisualEvidencePreflight(ports, story.id, ctx.cycleId);
      // US-EVID-021: freeze the acceptance contract from DESIGN TRUTH (the
      // persistent .roll via ports.repoCwd, NOT the builder-mutable worktree) at
      // cycle start. The attest gate later judges against this snapshot and
      // alerts (never blocks) on drift, so a mid-cycle AC/`screenshot_exempt`
      // edit in the worktree cannot silently change the contract. Best-effort,
      // never alters control flow (same owner red line as the preflight above).
      // Read the design-truth spec once here and hand it to the freeze (so the
      // freeze does not re-scan/re-read it, and contract-snapshot stays free of
      // any attest-gate import → no cycle).
      try {
        const designSpec = storySpecPath(ports.repoCwd, story.id);
        if (designSpec !== null) {
          freezeContractSnapshot(ports.repoCwd, story.id, readFileSync(designSpec, "utf8"), eventTs(ports));
        }
      } catch {
        /* best-effort: the freeze must never topple the pick */
      }
      // FIX-304: capture the story's PRE-cycle status BEFORE we claim it 🔨.
      // The terminal (append_run) uses it to UNDO a premature ✅ Done the agent
      // wrote into the symlinked .roll backlog (FIX-204C) when the cycle does
      // NOT merge — done ≡ merged. Read it from the freshly-read rows so the
      // captured value is the true pre-cycle state (typically 📋 Todo), not the
      // 🔨 we are about to write. Best-effort: an absent status leaves it unset
      // (no revert target — the terminal then leaves the row untouched).
      const preCycleStatus = (story as { status?: string }).status;
      // FIX-1211: atomically claim a cycle lease so another loop instance
      // (or a host-delegation prepare) cannot claim the same story.
      // Uses the single-truth claimStoryLease primitive — no-clobber.
      // A claim failure here means another owner already holds the lease;
      // the picker already filtered those, so this is a diagnostic guard.
      try {
        const claimResult = claimStoryLease(leasePath, story.id, {
          pid: process.pid,
          source: "cycle",
          claimedAt: Date.now(),
        });
        if (claimResult.status !== "claimed") {
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `[FIX-1211] claimStoryLease for ${story.id} returned ${claimResult.status} (source: ${claimResult.existingSource}) — another owner holds the lease`,
          );
        }
      } catch {
        /* lease claim is a safety guard; a write failure must not block the pick */
      }
      let repositoryExecution;
      if (ports.repositories !== undefined) {
        const prepared = await ports.repositories.prepare({ storyId: story.id, cycleId: ctx.cycleId });
        if (prepared.kind === "failed") {
          const workspaceId = readWorkspace(ports.repoCwd).workspaceId;
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "workspace:issue_init_failed",
            workspaceId,
            storyId: story.id,
            cycleId: ctx.cycleId,
            code: prepared.code,
            repairJournal: prepared.repairJournal,
            ts: eventTs(ports),
          });
          return workspaceSetupFailed({ ports, storyId: story.id, preCycleStatus, leasePath });
        }
        repositoryExecution = await ports.repositories.resolve(story.id);
      }
      let workspaceExecution = ctx.workspaceExecution;
      let repositorySelector = ctx.repositorySelector;
      if (workspaceExecution !== undefined) {
        const freezeExecution = repositoryExecution ?? workspaceExecution.issue?.execution;
        const frozen = freezeExecution === undefined
          ? { ok: false as const, code: "missing_execution_context" }
          : freezeWorkspaceCycleContext({ workspace: workspaceExecution, storyId: story.id, execution: freezeExecution });
        if (!frozen.ok) {
          return workspaceSetupFailed({ ports, storyId: story.id, preCycleStatus, leasePath,
            alert: `workspace cycle context blocked before spawn for ${story.id}: ${frozen.code}` });
        }
        workspaceExecution = frozen.context;
        const persisted = persistWorkspaceCycleContext(dirname(ports.paths.eventsPath), ctx.cycleId, workspaceExecution);
        if (!persisted.ok) {
          return workspaceSetupFailed({ ports, storyId: story.id, preCycleStatus, leasePath,
            alert: `workspace cycle context persistence blocked before spawn for ${story.id}: ${persisted.code}` });
        }
        workspaceExecution = persisted.context;
        const selected = persistWorkspaceCycleRepositorySelector(
          dirname(ports.paths.eventsPath),
          ctx.cycleId,
          workspaceExecution,
          repositorySelector,
        );
        if (selected.ok) {
          repositorySelector = selected.repoId;
        } else if (selected.code !== "repository_selector_required") {
          return workspaceSetupFailed({
            ports,
            storyId: story.id,
            preCycleStatus,
            leasePath,
            alert: `workspace repository selection blocked before spawn for ${story.id}: ${selected.code}`,
          });
        }
      }
      // The visible claim follows successful Workspace preparation. Legacy
      // projects retain the same pick-time status transition.
      ports.backlog.markStatus?.(ports.repoCwd, story.id, STATUS_MARKER.in_progress);
      const evidenceRunDir = ports.evidence.openFrame(ports.repoCwd, story.id, ctx.cycleId);
      ports.events.appendEvent(ports.paths.eventsPath, {
        type: "evidence:frame-opened",
        cycleId: ctx.cycleId,
        storyId: story.id,
        runDir: evidenceRunDir,
        ts: eventTs(ports),
      });
      // E2: post-pick submodule worktree (fail-loud) — see submodule-worktree.ts.
      const sub = ports.repositories === undefined
        ? await createSubmoduleWorktreeIfDeclared(ports, ctx, story)
        : { failed: false };
      if (sub.failed) return { event: { type: "worktree_failed" } };
      return {
        event: {
          type: "story_picked",
          storyId: story.id,
          ...(repositoryExecution === undefined ? {} : { repositoryExecution }),
          ...(workspaceExecution === undefined ? {} : { workspaceExecution }),
          ...(repositorySelector === undefined ? {} : { repositorySelector }),
        },
        ctxPatch: {
          evidenceRunDir,
          ...(preCycleStatus !== undefined && preCycleStatus !== "" ? { preCycleStatus } : {}),
          ...(sub.targetSubmodule !== undefined ? { targetSubmodule: sub.targetSubmodule } : {}),
        },
      };
    }

    // RESUME-PRIOR-WORK re-point (post-pick) — the ONE real resume decision point.
    // The worktree was created on origin/main (the fresh-context default) BEFORE
    // the story was picked; this is the FIRST step that has the real picked story
    // id (pick_story reads the backlog INSIDE the worktree, FIX-198/FIX-204C, so
    // the id is undefined at create_worktree — moving the decision here is the
    // FIX-284 wiring fix). resolveResumeBase keys purely on the runs ledger + git
    // (uniform for every agent — normalize-agents thesis):
    //   · returns origin/main → no resumable un-merged branch (or resume disabled
    //     / probe blip) → leave the worktree on origin/main (unchanged no-op).
    //   · returns origin/<branch> ≠ origin/main → a prior un-merged cycle branch
    //     cleanly rebases onto origin/main → RE-POINT this already-created worktree
    //     to it (fetch + reset --hard) so the agent RESUMES the prior product code
    //     rather than redoing it. The ALERT is already emitted by resolveResumeBase.
    // The symlinked .roll (FIX-204C) and the picker's 🔨 backlog mark are NOT part
    // of the worktree's tracked git content, so the hard reset leaves them intact.
    // Runs BEFORE resolve_route → spawn_agent (orchestrator command order), so the
    // worktree carries the resume tree by the time the agent spawns. Best-effort: a
    // reset failure leaves the worktree on origin/main rather than topple the cycle.
    case "resume_worktree": {
      if (ports.repositories !== undefined) return {};
      // E1: resolveResumeBase returns the configured integration branch verbatim
      // when there is no resumable prior branch → that equality is the no-op.
      const base = await resolveResumeBase(ports, cmd.storyId);
      if (base === resolveIntegrationBranch(ports.repoCwd) || base.trim() === "") return {};
      // `origin/<branch>` → derive the bare branch name for the worktree-local
      // fetch (the resume probes fetched it into the MAIN tree, not this worktree).
      const branch = base.startsWith("origin/") ? base.slice("origin/".length) : undefined;
      try {
        const r = await ports.git.resetWorktreeHard(ports.paths.worktreePath, base, branch);
        if (r.code !== 0) {
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `resume-prior-work: re-point of worktree onto ${base} for ${cmd.storyId} FAILED (git reset --hard exit ${r.code}); proceeding fresh from origin/main`,
          );
        }
      } catch {
        /* resume is an optimization — a re-point blip must never topple the cycle */
      }
      return {};
    }

    // agent/router resolveRoute (+ pre-spawn availability fallback).
    case "resolve_route": {
      const items = ports.backlog.read(ports.repoCwd);
      const story = items.find((i) => i.id === cmd.storyId);
      // FIX-1026: the spec frontmatter's `est_min` (the documented escalation
      // lever) drives tier selection, falling back to the backlog row's tag.
      const estMin = routerEstMin(ports.repoCwd, cmd.storyId, story?.desc ?? "");
      const r = ports.route.resolve(cmd.storyId, estMin);
      // FIX-1267 — hard builder rotation, fail-loud path. The route could not
      // satisfy the no-consecutive-repeat constraint: only the previous builder
      // was available. Refuse to repeat it (no silent violation) and refuse to
      // idle-spin — emit a first-class pending + ALERT so a human/self-heal adds
      // another execute-capable agent (or turns the constraint off).
      if (r.rotationBlocked !== undefined) {
        const prev = r.rotationBlocked.previous;
        const reason = `builder no-consecutive-repeat: only the previous builder '${prev}' is available — refusing to repeat (add another execute-capable agent, or set loop_safety.builder_no_consecutive_repeat: false)`;
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "loop:pending",
          loop: (ctx.loop === "" ? "main" : ctx.loop) as LoopType,
          cycleId: ctx.cycleId,
          reason,
          suspended: [{ agent: prev, cause: "no_consecutive_repeat" }],
          ts: eventTs(ports),
        });
        ports.events.appendAlert(ports.paths.alertsPath, `loop pending: ${reason}`);
        return { event: { type: "route_pending", reason } };
      }
      const runtimeDir = dirname(ports.paths.eventsPath);
      const candidateAgents = (() => {
        const installed = ports.installedAgents?.() ?? [];
        return installed.length > 0 ? installed : [r.agent];
      })();
      const nowMs = eventTs(ports);
      const stateAfterProbes = ports.agentReachable === undefined
        ? readRigLifecycleState(runtimeDir)
        : await probeDueSuspendedRigs({
            runtimeDir,
            agents: candidateAgents,
            nowMs,
            probe: ports.agentReachable,
            onProbe: ({ agent, recovered, entry, detail }) => {
              if (recovered) {
                ports.events.appendEvent(ports.paths.eventsPath, {
                  type: "rig:recovered",
                  cycleId: ctx.cycleId,
                  agent,
                  detail,
                  ts: eventTs(ports),
                });
                ports.events.appendEvent(ports.paths.eventsPath, {
                  type: "rig:probe",
                  cycleId: ctx.cycleId,
                  agent,
                  outcome: "live",
                  detail,
                  ts: eventTs(ports),
                });
                return;
              }
              ports.events.appendEvent(ports.paths.eventsPath, {
                type: "rig:probe",
                cycleId: ctx.cycleId,
                agent,
                outcome: "still_suspended",
                cause: entry.cause,
                detail,
                nextProbeAt: entry.nextProbeAt,
                ts: eventTs(ports),
              });
            },
          });
      const active = activeRigs(candidateAgents, stateAfterProbes);
      if (active.length === 0) {
        const suspended = suspendedRigs(candidateAgents, stateAfterProbes).map(({ agent, entry }) => ({
          agent,
          cause: entry.cause ?? "unknown",
          ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        }));
        const reason = `all rigs suspended: ${suspended.map((s) => `${s.agent}:${s.cause}`).join(", ")}`;
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "loop:pending",
          loop: (ctx.loop === "" ? "main" : ctx.loop) as LoopType,
          cycleId: ctx.cycleId,
          reason,
          suspended,
          ts: eventTs(ports),
        });
        ports.events.appendAlert(ports.paths.alertsPath, `loop pending: ${reason}`);
        return { event: { type: "route_pending", reason } };
      }
      // FIX-1267 — never let the availability fallback (`active[0]`) re-select a
      // rotation-excluded builder. Filter it out of the fallback pool; if that
      // leaves the routed agent suspended and only the excluded (previous) builder
      // active, fail loud (same pending + ALERT as the resolver-level exhaustion)
      // rather than silently repeating.
      const excludedBuilders = new Set(r.excluded ?? []);
      const activeForPick = excludedBuilders.size > 0 ? active.filter((a) => !excludedBuilders.has(a)) : active;
      if (excludedBuilders.size > 0 && activeForPick.length === 0) {
        const prev = [...excludedBuilders][0] ?? "";
        const reason = `builder no-consecutive-repeat: only the previous builder '${prev}' is available (others suspended) — refusing to repeat (recover another execute-capable agent, or set loop_safety.builder_no_consecutive_repeat: false)`;
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "loop:pending",
          loop: (ctx.loop === "" ? "main" : ctx.loop) as LoopType,
          cycleId: ctx.cycleId,
          reason,
          suspended: [{ agent: prev, cause: "no_consecutive_repeat" }],
          ts: eventTs(ports),
        });
        ports.events.appendAlert(ports.paths.alertsPath, `loop pending: ${reason}`);
        return { event: { type: "route_pending", reason } };
      }
      const selectedAgent = activeForPick.includes(r.agent) ? r.agent : activeForPick[0] ?? r.agent;
      const selectedModel = selectedAgent === r.agent ? r.model : "";
      // FIX-1267 — audit the rotation: when a previous builder was excluded and a
      // DIFFERENT builder was selected, record one `builder:rotation` event so an
      // operator can verify the constraint actually changed who builds.
      if (excludedBuilders.size > 0 && !excludedBuilders.has(selectedAgent)) {
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "builder:rotation",
          cycleId: ctx.cycleId ?? "",
          storyId: cmd.storyId,
          previous: [...excludedBuilders][0] ?? "",
          selected: selectedAgent,
          ts: eventTs(ports),
        });
      }
      // US-V4-004: select + RECORD the Story execution profile once, here at
      // route-resolve (before execute). Best-effort + never toppling routing: a
      // spec read/parse blip falls back to `standard` (builder-only, current
      // behavior). v4.0 records the profile but still executes standard only;
      // verified/designed add evaluator/designer stages in later stories.
      const selectedProfile = recordExecutionProfile(ports, ctx.cycleId ?? "", cmd.storyId, estMin);
      // US-LOOP-102: for a verified/designed cycle with a heterogeneous partner
      // available, hand the orchestrator an adversarial plan so it runs the
      // test_author → implementer → attack subsequence. `undefined` (standard, or
      // no hetero partner) keeps the single-builder path — zero behaviour change.
      const adversarial = planAdversarial(selectedProfile, selectedAgent, active);
      // US-LOOP-106: a verified/designed cycle that WANTED adversarial pairing but
      // could not form a heterogeneous test_author≠implementer pair degrades to a
      // standard single builder — NOT silently. Flag it so the orchestrator emits
      // adversarial:degraded{cause:"non-hetero"} before the single spawn (fail-closed,
      // auditable). A standard-profile cycle never wants adversarial → no flag.
      const wantsAdversarial = selectedProfile === "verified" || selectedProfile === "designed";
      const adversarialDegraded =
        wantsAdversarial && adversarial === undefined
          ? {
              cause: `non-hetero: no heterogeneous partner for implementer ${selectedAgent} among [${active.join(",")}]`,
              from: selectedProfile as "verified" | "designed",
            }
          : undefined;
      return {
        event: {
          type: "route_resolved",
          agent: selectedAgent,
          model: selectedModel,
          ...(adversarial !== undefined ? { adversarial } : {}),
          ...(adversarialDegraded !== undefined ? { adversarialDegraded } : {}),
        },
        ctxPatch: { selectedProfile },
      };
    }

    // execute: spawn the agent (TCR commits happen inside the worktree). The
    // exit code + timeout feed back as agent_exited; usage is captured for cost.
    default: {
      const _exhaustive: never = cmd;
      throw new Error(`executeSetupCommand: unmapped command ${JSON.stringify(_exhaustive)}`);
    }
  }
}
