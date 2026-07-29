/**
 * `roll loop reconcile-pending` — FIX-1052.
 *
 * Bounded, one-pass reconcile for pending-merge PRs. Polls each PR that is
 * currently `pending_merge` in `deliveries.jsonl` through the GitHub provider
 * adapter, fetches `origin/main` when a merge is detected, rebuilds the
 * delivery projection, and appends an explicit `done` record. Failure states
 * (closed-unmerged, CI-red, unreachable) are surfaced in the delivery cache
 * and printed to stdout so `roll cycles` / `roll loop watch` / `roll truth`
 * reflect the reconciled state without a manual `git fetch`.
 *
 * The command is safe to run repeatedly: already-delivered records are skipped.
 */
import { join } from "node:path";
import { resolveLang, present, STATUS_MARKER } from "@roll/spec";
import type { DeliveryRecord } from "@roll/spec";
import {
  BacklogStore,
  nodeDeliveryStore,
  nodeExecPort,
  readDeliveries,
  readDeliveriesRaw,
  appendDelivery,
  EventBus,
  type PrStatusProvider,
} from "@roll/core";
import { GitHubPrStatusProvider, resolveIntegrationBranch } from "@roll/infra";
import { markDoneGuarded } from "../runner/done-guard.js";

export const RECONCILE_PENDING_USAGE =
  "Usage: roll loop reconcile-pending [--dry-run]\n" +
  "  Poll pending-merge PRs and reconcile delivery truth.\n" +
  "  轮询待合并 PR 并调和交付真相。";

// ── Helpers ───────────────────────────────────────────────────────────────────

function runtimeDir(projectPath: string): string {
  const env = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  return env !== "" ? env : join(projectPath, ".roll", "loop");
}

function resolveRepoSlug(projectPath: string): string | undefined {
  const remote = nodeExecPort.run("git", ["-C", projectPath, "remote", "get-url", "origin"]);
  if (remote.code !== 0 || remote.stdout === "") return undefined;
  const url = remote.stdout.trim();
  // Match GitHub URLs only (the only supported provider today).
  const m =
    /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/.exec(url) ??
    /git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/.exec(url);
  if (m?.groups === undefined) return undefined;
  return `${m.groups.owner}/${m.groups.repo}`;
}

function findPendingRecords(projectPath: string): DeliveryRecord[] {
  // Use readDeliveriesRaw (no dedup) so pending records are not shadowed by
  // later "done" records for the same (storyId, cycleId). The caller handles
  // already-delivered filtering via isAlreadyDelivered against the deduped view.
  return readDeliveriesRaw(nodeDeliveryStore, projectPath).filter(
    (r) =>
      (r.lifecycleState === "pending_merge" || r.lifecycleState === "ci_red") &&
      r.prNumber.present &&
      r.prNumber.value > 0,
  );
}

function isAlreadyDelivered(existing: readonly DeliveryRecord[], storyId: string, cycleId: string): boolean {
  return existing.some((r) => r.storyId === storyId && r.cycleId === cycleId && r.lifecycleState === "done");
}

function prNumberFromRecord(r: DeliveryRecord): number | undefined {
  return r.prNumber.present && r.prNumber.value > 0 ? r.prNumber.value : undefined;
}

function doneStatusWithDeliveryRef(status: string, prNumber: number, mergeCommit: string): string {
  if (!status.includes(STATUS_MARKER.done)) return status;
  const sha = mergeCommit.trim().slice(0, 7);
  const debtSuffix = status.includes("evidence_debt") ? " · evidence_debt" : "";
  return `${STATUS_MARKER.done} · PR#${prNumber} · merged ${sha}${debtSuffix}`;
}

// ── Injectable deps for tests ─────────────────────────────────────────────────

/** Dependencies the command needs so tests can fake filesystem/provider/events. */
export interface LoopReconcilePendingDeps {
  cwd: string;
  provider: PrStatusProvider;
  bus: EventBus;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
}

function realDeps(): LoopReconcilePendingDeps {
  const cwd = process.cwd();
  return {
    cwd,
    provider: new GitHubPrStatusProvider(),
    bus: new EventBus(),
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

// ── Command ───────────────────────────────────────────────────────────────────

export async function loopReconcilePendingCommand(
  args: string[],
  deps: LoopReconcilePendingDeps = realDeps(),
): Promise<number> {
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });

  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout.write(`${RECONCILE_PENDING_USAGE}\n`);
    return 0;
  }

  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) {
    deps.stderr.write(`[roll] unknown flag: ${unknown[0]}\n${RECONCILE_PENDING_USAGE}\n`);
    return 1;
  }

  const cwd = deps.cwd;
  const slug = resolveRepoSlug(cwd);
  if (slug === undefined) {
    deps.stderr.write(
      lang === "zh"
        ? "[roll] 无法解析 GitHub owner/repo（没有 origin remote 或非 GitHub 仓库）\n"
        : "[roll] cannot resolve GitHub owner/repo (no origin remote or non-GitHub repo)\n",
    );
    return 1;
  }

  const pending = findPendingRecords(cwd);
  if (pending.length === 0) {
    deps.stdout.write(lang === "zh" ? "没有待合并的 PR。\n" : "No pending-merge PRs.\n");
    return 0;
  }

  const provider = deps.provider;
  const bus = deps.bus;
  const rt = runtimeDir(cwd);
  const eventsPath = join(rt, "events.ndjson");
  const runsPath = join(rt, "runs.jsonl");
  bus.ensureEventFiles(eventsPath, runsPath);

  const now = Date.now();
  const allExisting = readDeliveries(nodeDeliveryStore, cwd);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const record of pending) {
    const prNumber = prNumberFromRecord(record);
    if (prNumber === undefined) continue;

    if (isAlreadyDelivered(allExisting, record.storyId, record.cycleId)) {
      skipped += 1;
      deps.stdout.write(
        lang === "zh"
          ? `  ${record.storyId} · PR #${prNumber} · 已交付（跳过）\n`
          : `  ${record.storyId} · PR #${prNumber} · already delivered (skip)\n`,
      );
      continue;
    }

    deps.stdout.write(
      lang === "zh"
        ? `  ${record.storyId} · PR #${prNumber} · 轮询中…\n`
        : `  ${record.storyId} · PR #${prNumber} · polling…\n`,
    );

    if (dryRun) {
      deps.stdout.write(lang === "zh" ? "    --dry-run，未执行\n" : "    --dry-run, not executed\n");
      continue;
    }

    try {
      const state = await provider.pollPrStatus(slug, prNumber);

      if (state.kind === "merged") {
        // Fetch the integration branch so future operations (e.g. cycles view
        // rebuild) see the merge commit. We do NOT call ensureDeliveriesFresh
        // here because it would rebuild the entire cache from runs+git facts,
        // wiping the pending record before we can append the done record.
        // E1: remote+branch derive from the configured integration branch
        // (default origin/main → the fetch stays `fetch origin main`).
        const integrationBranch = resolveIntegrationBranch(cwd);
        const slash = integrationBranch.indexOf("/");
        const fetchRemote = slash === -1 ? "origin" : integrationBranch.slice(0, slash);
        const fetchBranch = slash === -1 ? integrationBranch : integrationBranch.slice(slash + 1);
        nodeExecPort.run("git", ["-C", cwd, "fetch", fetchRemote, fetchBranch, "--quiet"]);

        const newRecord: DeliveryRecord = {
          storyId: record.storyId,
          cycleId: record.cycleId,
          lifecycleState: "done",
          prNumber: record.prNumber,
          prUrl: record.prUrl,
          mergedAt: present(Date.parse(state.mergedAt) || now),
          mergeCommit: present(state.mergeCommit),
          recordedAt: now,
        };
        appendDelivery(nodeDeliveryStore, cwd, newRecord);
        bus.appendEvent(eventsPath, {
          type: "pr:merge",
          prNumber,
          storyId: record.storyId,
          ts: now,
        });

        // Flip the backlog row from 🔨 In Progress to ✅ Done so the
        // supervisor no longer treats this delivered card as blocking.
        try {
          const guarded = markDoneGuarded(cwd, record.storyId, { mergedToMain: true }, {
            markStatus: (projectCwd, id, status) => {
              const backlogPath = join(projectCwd, ".roll", "backlog.md");
              const store = new BacklogStore();
              const snap = store.readBacklog(backlogPath);
              store.markExact(backlogPath, snap.hash, id, doneStatusWithDeliveryRef(status, prNumber, state.mergeCommit));
            },
            alert: (message) =>
              bus.appendEvent(eventsPath, {
                type: "loop:error",
                loop: "main",
                error: message,
                ts: now,
              }),
          });
          if (!guarded.ok) {
            deps.stdout.write(
              lang === "zh"
                ? `    ⚠️ Done guard 拒绝翻牌 · ${guarded.missing.join(", ")}\n`
                : `    ⚠️ Done guard rejected status flip · ${guarded.missing.join(", ")}\n`,
            );
          }
        } catch {
          // Best-effort: the delivery record is the truth; backlog update is
          // a convenience signal for the supervisor. Non-fatal on failure.
        }

        updated += 1;
        deps.stdout.write(
          lang === "zh"
            ? `    ✅ 已合并 · ${state.mergeCommit.slice(0, 7)}\n`
            : `    ✅ merged · ${state.mergeCommit.slice(0, 7)}\n`,
        );
      } else if (state.kind === "closed_unmerged") {
        const newRecord: DeliveryRecord = {
          storyId: record.storyId,
          cycleId: record.cycleId,
          lifecycleState: "abandoned",
          prNumber: record.prNumber,
          prUrl: record.prUrl,
          mergedAt: { present: false, reason: "not_recorded" },
          mergeCommit: { present: false, reason: "not_recorded" },
          recordedAt: now,
        };
        appendDelivery(nodeDeliveryStore, cwd, newRecord);
        bus.appendEvent(eventsPath, {
          type: "pr:close",
          prNumber,
          reason: "closed_unmerged",
          ts: now,
        });
        updated += 1;
        deps.stdout.write(lang === "zh" ? "    🗑 已关闭未合并\n" : "    🗑 closed unmerged\n");
      } else if (state.kind === "open" && state.ci === "red") {
        const newRecord: DeliveryRecord = {
          storyId: record.storyId,
          cycleId: record.cycleId,
          lifecycleState: "ci_red",
          prNumber: record.prNumber,
          prUrl: record.prUrl,
          mergedAt: { present: false, reason: "not_recorded" },
          mergeCommit: { present: false, reason: "not_recorded" },
          recordedAt: now,
        };
        appendDelivery(nodeDeliveryStore, cwd, newRecord);
        bus.appendEvent(eventsPath, {
          type: "ci:fail",
          prNumber,
          failSummary: "pr reconcile: CI red",
          ts: now,
        });
        updated += 1;
        deps.stdout.write(lang === "zh" ? "    ❌ CI 失败\n" : "    ❌ CI red\n");
      } else if (state.kind === "open") {
        const ci = state.ci === "green" ? "green" : state.ci === "pending" ? "pending" : "unknown";
        deps.stdout.write(
          lang === "zh" ? `    ⏳ 开启中 · CI ${ci}\n` : `    ⏳ open · CI ${ci}\n`,
        );
      } else {
        // unreachable
        bus.appendEvent(eventsPath, {
          type: "loop:error",
          loop: "main",
          error: `pr ${prNumber} unreachable: ${state.reason}`,
          ts: now,
        });
        errors += 1;
        deps.stdout.write(
          lang === "zh" ? `    ⚠️ 无法访问 · ${state.reason}\n` : `    ⚠️ unreachable · ${state.reason}\n`,
        );
      }
    } catch (err) {
      errors += 1;
      const detail = err instanceof Error ? err.message : String(err);
      bus.appendEvent(eventsPath, {
        type: "loop:error",
        loop: "main",
        error: `pr ${prNumber} poll failed: ${detail}`,
        ts: now,
      });
      deps.stderr.write(
        lang === "zh" ? `    ⚠️ 轮询失败 · ${detail}\n` : `    ⚠️ poll failed · ${detail}\n`,
      );
    }
  }

  const summary =
    lang === "zh"
      ? `完成：${updated} 已更新 · ${skipped} 已跳过 · ${errors} 错误\n`
      : `done: ${updated} updated · ${skipped} skipped · ${errors} errors\n`;
  deps.stdout.write(summary);
  return errors > 0 ? 1 : 0;
}
