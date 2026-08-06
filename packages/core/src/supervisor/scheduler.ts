/**
 * @responsibility Decides the parallel-cycle scheduling plan.
 * US-V4-009 — Supervisor parallel-cycle scheduling (PURE decision).
 *
 * SCOPE NOTE (v4.0 vs v4.1): this module is the minimal, SAFE deliverable for
 * US-V4-009 — the pure scheduling DECISION. The LIVE integration into the loop
 * runner (actually spawning concurrent cycles, parallel-cycle crash recovery)
 * is deferred to v4.1: it touches the loop's hard-won concurrency/locking
 * reliability and must not ship until Supervisor v0 (US-V4-008) is proven stable
 * in real runs. The architecture (§16 M8) and the US-V4-009 spec both mark
 * parallel scheduling v4.1-eligible. This decision layer is what that future
 * integration will call; it preserves every Loop/Cycle invariant by construction:
 *   - never exceeds `maxParallelCycles`;
 *   - one Story has at most one open PR/Cycle (single-ownership);
 *   - file/path conflicts serialize (a candidate overlapping an active cycle waits);
 *   - merge-queue depth ≥ cap, or budget exhausted, pauses NEW starts.
 * Manual override stays available because the caller decides whether to act on
 * the decision (the scheduler never spawns anything itself).
 */
import type { ScheduleDecision, ScheduleInput, SchedulableCycle } from "@roll/spec";

function fileSet(c: SchedulableCycle): Set<string> {
  return new Set((c.files ?? []).map((f) => f.replace(/\\/g, "/")));
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const f of a) if (b.has(f)) return true;
  return false;
}

/**
 * Decide which candidate stories may safely START now and which must WAIT.
 * Pure + deterministic: candidates are considered in order; a started candidate's
 * files join the conflict set so two pending candidates that touch the same file
 * also serialize against each other (not just against pre-existing active cycles).
 */
export function scheduleParallelCycles(input: ScheduleInput): ScheduleDecision {
  const start: string[] = [];
  const wait: { storyId: string; reason: string }[] = [];

  const maxParallel = Math.max(1, Math.floor(input.maxParallelCycles));
  const budgetOk = input.budgetOk;
  const mergeFull = input.mergeQueue !== undefined && input.mergeQueue.depth >= input.mergeQueue.cap;
  const openPr = new Set(input.openPrStories);
  const activeIds = new Set(input.active.map((a) => a.storyId));

  // Conflict set grows as we admit candidates (active cycles seed it).
  const claimedFiles: Set<string>[] = input.active.map(fileSet);
  let runningCount = input.active.length;

  for (const cand of input.candidates) {
    // Single-ownership: a story already active or with an open PR never double-starts.
    if (activeIds.has(cand.storyId) || openPr.has(cand.storyId)) {
      wait.push({ storyId: cand.storyId, reason: "already in flight (active cycle or open PR)" });
      continue;
    }
    if (!budgetOk) {
      wait.push({ storyId: cand.storyId, reason: "budget exhausted — new starts paused" });
      continue;
    }
    if (mergeFull) {
      wait.push({ storyId: cand.storyId, reason: `merge queue full (${input.mergeQueue?.depth}/${input.mergeQueue?.cap})` });
      continue;
    }
    if (runningCount >= maxParallel) {
      wait.push({ storyId: cand.storyId, reason: `max parallel cycles reached (${maxParallel})` });
      continue;
    }
    const candFiles = fileSet(cand);
    if (candFiles.size > 0 && claimedFiles.some((claimed) => overlaps(candFiles, claimed))) {
      wait.push({ storyId: cand.storyId, reason: "file/path conflict with an in-flight cycle — serialized" });
      continue;
    }
    // Admit.
    start.push(cand.storyId);
    claimedFiles.push(candFiles);
    runningCount += 1;
  }

  return { start, wait };
}
