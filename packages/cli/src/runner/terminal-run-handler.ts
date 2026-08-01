/** Terminal run persistence and post-terminal truth reconciliation. */
import { dirname, join } from "node:path";
import {
  appendDelivery,
  nodeDeliveryStore,
  type CycleCommand,
  type CycleContext,
  type RunKey,
} from "@roll/core";
import { AWAITING_REVIEW_STATUS_MARKER, STATUS_MARKER, absent, present } from "@roll/spec";
import { prNumberFromUrl } from "@roll/infra";
import { commitInRepoBacklog, isInRepoRollLayout } from "./in-repo-backlog.js";
import { writeCycleRoleSummaryBestEffort } from "./cycle-role-artifact-writer.js";
import { markDoneGuarded } from "./done-guard.js";
import { repairCoreWorktreeContamination } from "./main-checkout-guard.js";
import type { ExecuteResult, Ports } from "./ports.js";
import { buildRunRow, buildTerminalRecord, commitRollMetadata } from "./run-records.js";
import { cleanStaleEvidence, isParkedAtHold, resetStaleSpecTruth, revertPrematureDone } from "./resume-truth.js";
import { eventTs } from "./runner-time.js";

type AppendRunCommand = Extract<CycleCommand, { kind: "append_run" }>;

export async function executeAppendRunCommand(
  cmd: AppendRunCommand,
  ports: Ports,
  ctx: CycleContext,
): Promise<ExecuteResult> {
  const repair = repairCoreWorktreeContamination(ports.repoCwd);
  if (repair.healed) {
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "cycle:cleanup", cycleId: cmd.cycleId, rule: "core.worktree", path: repair.detail, ok: true, ts: eventTs(ports),
    });
    ports.events.appendAlert(ports.paths.alertsPath,
      `FIX-1210: cycle ${cmd.cycleId} — core.worktree was pointing to "${repair.detail}" — auto-unset at terminal`);
  }
  const metaRepair = repairCoreWorktreeContamination(join(ports.repoCwd, ".roll"));
  if (metaRepair.healed) {
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "cycle:cleanup", cycleId: cmd.cycleId, rule: "roll-meta.core-worktree", path: metaRepair.detail, ok: true, ts: eventTs(ports),
    });
    ports.events.appendAlert(ports.paths.alertsPath,
      `FIX-1224: cycle ${cmd.cycleId} — roll-meta core.worktree was pointing to "${metaRepair.detail}" — auto-unset at terminal`);
  }

  const key: RunKey = { storyId: ctx.storyId ?? "", cycleId: cmd.cycleId };
  ports.events.upsertRun(ports.paths.runsPath, key, buildRunRow(cmd, ctx, ports.clock()));
  try {
    ports.events.appendEvent(ports.paths.eventsPath, buildTerminalRecord(cmd, ctx, ports.repoCwd, ports.clock()));
  } catch {
    /* The runs row already landed; audit flags the missing twin. */
  }

  const storyId = ctx.storyId ?? "";
  let terminalMerged = false;
  const inRepoLayout = isInRepoRollLayout(ports.paths.worktreePath);
  let inRepoDurableFlip: { id: string; status: string } | null = null;
  if (
    (cmd.status === "done" || cmd.status === "published") &&
    storyId !== "" &&
    (ctx.publishConfirmed === true || (ctx.prUrl !== undefined && ctx.prUrl !== ""))
  ) {
    const mergeInfo = await ports.github.prMergeInfo(ports.repoCwd, ctx.branch).catch(() => undefined);
    if (mergeInfo?.state === "MERGED") {
      terminalMerged = true;
      if (ctx.cycleId !== undefined) {
        try {
          appendDelivery(nodeDeliveryStore, ports.repoCwd, {
            storyId,
            cycleId: ctx.cycleId,
            lifecycleState: "done",
            prNumber: ctx.prUrl !== undefined ? present(Number(prNumberFromUrl(ctx.prUrl) ?? 0)) : absent("not_recorded"),
            prUrl: ctx.prUrl !== undefined ? present(ctx.prUrl) : absent("not_recorded"),
            mergedAt: mergeInfo.mergedAt !== undefined ? present(new Date(mergeInfo.mergedAt).getTime()) : absent("not_recorded"),
            mergeCommit: mergeInfo.mergeCommit !== undefined ? present(mergeInfo.mergeCommit) : absent("not_recorded"),
            recordedAt: ports.clock(),
          });
        } catch {
          ports.events.appendAlert(ports.paths.alertsPath, `US-TRUTH-015: appendDelivery done failed for ${storyId} (cycle ${ctx.cycleId})`);
        }
      }
      const doneResult = markDoneGuarded(ports.repoCwd, storyId, { mergedToMain: true }, {
        markStatus: (projectCwd, id, status) => ports.backlog.markStatus?.(projectCwd, id, status),
        alert: (message) => ports.events.appendAlert(ports.paths.alertsPath, message),
      });
      if (doneResult.ok && inRepoLayout) {
        inRepoDurableFlip = { id: storyId, status: doneResult.debt ? `${STATUS_MARKER.done} · evidence_debt` : STATUS_MARKER.done };
      }
    } else {
      revertPrematureDone(ports, storyId, ctx.preCycleStatus);
    }
  } else if ((cmd.status === "idle" || cmd.status === "gave_up" || cmd.status === "local") && storyId !== "") {
    if (!isParkedAtHold(ports, storyId)) ports.backlog.markStatus?.(ports.repoCwd, storyId, STATUS_MARKER.todo);
    if (ctx.cycleId !== undefined) {
      try {
        appendDelivery(nodeDeliveryStore, ports.repoCwd, {
          storyId, cycleId: ctx.cycleId, lifecycleState: cmd.status === "local" ? "abandoned" : "failed",
          prNumber: ctx.prUrl !== undefined ? present(Number(prNumberFromUrl(ctx.prUrl) ?? 0)) : absent("no_publish_attempted"),
          prUrl: ctx.prUrl !== undefined ? present(ctx.prUrl) : absent("no_publish_attempted"),
          mergedAt: absent("not_recorded"), mergeCommit: absent("not_recorded"), recordedAt: ports.clock(),
        });
      } catch { /* Best-effort terminal record. */ }
    }
  } else if (cmd.status === "needs_review" && storyId !== "") {
    ports.backlog.markStatus?.(ports.repoCwd, storyId, AWAITING_REVIEW_STATUS_MARKER);
    if (ctx.cycleId !== undefined) {
      try {
        appendDelivery(nodeDeliveryStore, ports.repoCwd, {
          storyId, cycleId: ctx.cycleId, lifecycleState: "pending_merge",
          prNumber: ctx.prUrl !== undefined ? present(Number(prNumberFromUrl(ctx.prUrl) ?? 0)) : absent("no_publish_attempted"),
          prUrl: ctx.prUrl !== undefined ? present(ctx.prUrl) : absent("no_publish_attempted"),
          mergedAt: absent("not_recorded"), mergeCommit: absent("not_recorded"), recordedAt: ports.clock(),
        });
      } catch { /* Best-effort terminal record. */ }
    }
  } else if (storyId !== "") {
    revertPrematureDone(ports, storyId, ctx.preCycleStatus);
    if (ctx.cycleId !== undefined) {
      const lifecycleState = cmd.status === "blocked" ? "blocked" as const
        : cmd.status === "aborted" || cmd.status === "orphan" ? "abandoned" as const
          : "failed" as const;
      try {
        appendDelivery(nodeDeliveryStore, ports.repoCwd, {
          storyId, cycleId: ctx.cycleId, lifecycleState,
          prNumber: ctx.prUrl !== undefined ? present(Number(prNumberFromUrl(ctx.prUrl) ?? 0)) : absent("no_publish_attempted"),
          prUrl: ctx.prUrl !== undefined ? present(ctx.prUrl) : absent("no_publish_attempted"),
          mergedAt: absent("not_recorded"), mergeCommit: absent("not_recorded"), recordedAt: ports.clock(),
        });
      } catch { /* Best-effort terminal record. */ }
    }
  }

  if (!terminalMerged && storyId !== "") {
    resetStaleSpecTruth(ports, storyId);
    cleanStaleEvidence(ports.repoCwd, storyId, ctx.cycleId ?? "", cmd.status === "published" || cmd.status === "built" ? "published_pending_merge" : undefined);
  }
  await commitRollMetadata(ports, ctx);
  if (storyId !== "" && inRepoLayout && inRepoDurableFlip !== null) {
    await commitInRepoBacklog(ports, ctx, inRepoDurableFlip.id, inRepoDurableFlip.status);
  }
  if (ctx.cycleId !== undefined) {
    writeCycleRoleSummaryBestEffort(ctx.cycleId, ports.paths.eventsPath, join(dirname(ports.paths.eventsPath), "cycle-logs"));
  }
  return {};
}
