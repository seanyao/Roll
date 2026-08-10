/**
 * @responsibility Queues branches whose PR could not be opened due to transient faults.
 */
/**
 * FIX-1214 — durable hand-off queue for branches that were pushed but whose PR
 * could not be opened because of a transient GitHub API fault.
 *
 * The cycle runner appends an entry here when `runPublishPlan` returns a
 * degraded status-0 result. The delivery reconciler (`loop reconcile`) drains the
 * queue on each tick: it opens a PR for any queued branch that does not already
 * have an open PR, emits a `pr:open` event, and updates the DeliveryRecord.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendDelivery, branchTitleSuffix, nodeDeliveryStore } from "@roll/core";
import { absent, present } from "@roll/spec";
import type { GhResult } from "@roll/infra";

/** One queued branch waiting for a reconciler tick to open its PR. */
export interface PendingPrCreateEntry {
  storyId: string;
  cycleId: string;
  branch: string;
  slug: string;
  body: string;
  draft: boolean;
  manualMerge: boolean;
  createdAt: number;
}

/** Path to the queue file under the runtime directory. */
export function pendingPrCreatePath(runtimeDir: string): string {
  return join(runtimeDir, "pending-pr-create.json");
}

/** Read the queue, returning [] when the file is missing or unreadable. */
export function readPendingPrCreates(runtimeDir: string): PendingPrCreateEntry[] {
  try {
    const raw = readFileSync(pendingPrCreatePath(runtimeDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as PendingPrCreateEntry[];
  } catch {
    /* missing / corrupt → treat as empty */
  }
  return [];
}

function writePendingPrCreates(runtimeDir: string, entries: PendingPrCreateEntry[]): void {
  const path = pendingPrCreatePath(runtimeDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

/** Add an entry to the queue, keyed by branch (idempotent). */
export function addPendingPrCreate(runtimeDir: string, entry: PendingPrCreateEntry): void {
  const entries = readPendingPrCreates(runtimeDir).filter((e) => e.branch !== entry.branch);
  entries.push(entry);
  writePendingPrCreates(runtimeDir, entries);
}

/** Remove a branch from the queue (called after successful PR creation). */
export function removePendingPrCreate(runtimeDir: string, branch: string): void {
  const entries = readPendingPrCreates(runtimeDir).filter((e) => e.branch !== branch);
  writePendingPrCreates(runtimeDir, entries);
}

/** Dependencies injected so tests can fake `gh` and filesystem side effects. */
export interface PendingPrCreateDeps {
  gh: (args: readonly string[]) => Promise<GhResult>;
  nowMs: () => number;
  runtimeDir: string;
  projectCwd: string;
  alert: (line: string) => void;
  info: (line: string) => void;
}

function appendPendingPrEvent(
  runtimeDir: string,
  event:
    | { type: "pr:open"; prNumber: number; storyId: string; ts: number }
    | { type: "delivery:published"; cycleId: string; storyId: string; branch: string; prNumber: number; prUrl: string; ts: number },
): void {
  const eventsPath = join(runtimeDir, "events.ndjson");
  mkdirSync(dirname(eventsPath), { recursive: true });
  writeFileSync(eventsPath, `${JSON.stringify(event)}\n`, { flag: "a" });
}

/**
 * Open PRs for every queued branch that does not already have an open PR.
 * Successful creates emit `pr:open`, update the DeliveryRecord, and remove the
 * entry. Failures are left in the queue for the next tick.
 */
export async function openPendingPrCreates(
  deps: PendingPrCreateDeps,
  slug: string,
  openHeadRefs: ReadonlySet<string>,
): Promise<void> {
  const entries = readPendingPrCreates(deps.runtimeDir);
  if (entries.length === 0) return;

  for (const entry of entries) {
    if (entry.slug !== slug) continue;
    if (openHeadRefs.has(entry.branch)) {
      // The PR already exists (e.g. opened by a human or a previous tick that
      // crashed before removing the queue entry). Clean it up and move on.
      removePendingPrCreate(deps.runtimeDir, entry.branch);
      continue;
    }

    const title = `loop cycle ${branchTitleSuffix(entry.branch)}`;
    const argv = [
      "-R",
      entry.slug,
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      entry.branch,
      "--title",
      title,
      "--body",
      entry.body,
      ...(entry.draft ? ["--draft"] : []),
    ];
    const r = await deps.gh(argv);
    if (r.code !== 0) {
      deps.alert(`FIX-1214: deferred pr create for ${entry.branch} failed: ${r.stderr.trim() || "unknown"}`);
      continue;
    }

    const prUrl = r.stdout.trim();
    const prNumber = /\/pull\/(\d+)/.exec(prUrl)?.[1];
    const ts = deps.nowMs();

    appendPendingPrEvent(deps.runtimeDir, {
      type: "pr:open",
      prNumber: prNumber !== undefined ? Number(prNumber) : 0,
      storyId: entry.storyId,
      ts,
    });
    // US-DELIV-001: the deferred path carries the SAME awaiting_merge fact as
    // the happy-path publish (terminal-handlers) — one vocabulary, one
    // projection, no matter which lane opened the PR.
    if (prNumber !== undefined && prUrl !== "") {
      appendPendingPrEvent(deps.runtimeDir, {
        type: "delivery:published",
        cycleId: entry.cycleId,
        storyId: entry.storyId,
        branch: entry.branch,
        prNumber: Number(prNumber),
        prUrl,
        ts,
      });
    } else {
      deps.alert(`US-DELIV-001: deferred PR opened for ${entry.branch} but prNumber/prUrl unparsable — delivery:published NOT emitted (cycle stays out of awaiting_merge projection)`);
    }

    try {
      appendDelivery(nodeDeliveryStore, deps.projectCwd, {
        storyId: entry.storyId,
        cycleId: entry.cycleId,
        lifecycleState: "pending_merge",
        prNumber: prNumber !== undefined ? present(Number(prNumber)) : absent("not_recorded"),
        prUrl: prUrl !== "" ? present(prUrl) : absent("not_recorded"),
        mergedAt: absent("not_recorded"),
        mergeCommit: absent("not_recorded"),
        recordedAt: ts,
      });
    } catch {
      deps.alert(`FIX-1214: appendDelivery failed for ${entry.storyId} (cycle ${entry.cycleId})`);
    }

    removePendingPrCreate(deps.runtimeDir, entry.branch);
    deps.info(`FIX-1214: opened deferred PR for ${entry.branch}: ${prUrl}`);
  }
}
