/**
 * @responsibility Queries story delivery truth deterministically from delivery records.
 * US-TRUTH-016 / US-TRUTH-015 AC3 — queryStoryDelivery: the single deterministic
 * query entry point for delivery truth.
 *
 * queryStoryDelivery(storyId, deliveries) → StoryDeliveryTruth
 *
 * Pure function — zero I/O, zero markdown parse. Given a story ID and all
 * DeliveryRecords, returns ONE serializable verdict. This is the "工具确定性查询
 * 入口" (tool-guaranteed deterministic query entry) that replaces scattered
 * markdown parsing with a single structured read.
 *
 * US-TRUTH-015 AC3 — deriveBacklogStatus: produce the backlog status cell string
 * from StoryDeliveryTruth, so the backlog becomes a DERIVED display rather than
 * an authoritative source.
 */
import type { DeliveryRecord, LifecycleState } from "@roll/spec";
import { LIFECYCLE_STATES } from "@roll/spec";

// ── StoryDeliveryTruth (AC1) ─────────────────────────────────────────────────

/**
 * The structured delivery truth for ONE story — the one verdict every consumer
 * (picker / reconcile / dossier / watch) should read instead of parsing markdown.
 *
 * Every field is derived from the DeliveryRecord list, last-wins per cycle.
 * Missing / conflicting records produce explicit reasons, never silent defaults.
 */
export interface StoryDeliveryTruth {
  storyId: string;
  /** Machine-derived lifecycle state — the story's position in the pipeline. */
  lifecycleState: LifecycleState;
  /** True iff the story's work has been merged to main. */
  delivered: boolean;
  /** The PR number, when a publish cycle has produced one. */
  prNumber?: number;
  /** The PR URL, when a publish cycle has produced one. */
  prUrl?: string;
  /** The merge commit SHA on main, when the PR merged. */
  mergeCommit?: string;
  /** Timestamp of the most recent record for this story (epoch ms). */
  lastRecordedAt: number;
  /** The cycle IDs that have delivered work for this story (ordered, oldest→newest). */
  deliveringCycles: string[];
  /** Explicit reason when a field that SHOULD be present is missing.
   *  An absent field means the data was never recorded (not yet, or the cycle
   *  predates structured truth). The reason explains WHY. */
  missingReason?: string;
}

// ── queryStoryDelivery (AC1-3) ───────────────────────────────────────────────

/**
 * Pure, deterministic query: given all DeliveryRecords, produce ONE
 * {@link StoryDeliveryTruth} for a story.
 *
 * Rules (AC1-3):
 *   - Filters records for the given storyId.
 *   - Same (storyId, cycleId) → last-wins (later recordedAt overrides earlier).
 *   - No records → lifecycleState: "todo", delivered: false.
 *   - Multiple cycles: the LATEST record's lifecycleState wins;
 *     `delivered` is true iff ANY record has lifecycleState "done".
 *   - prNumber / prUrl / mergeCommit are taken from the latest in_flight/done
 *     record that carries them.
 *
 * Zero I/O, zero markdown parse. Deterministic for the same input.
 */
export function queryStoryDelivery(
  storyId: string,
  deliveries: readonly DeliveryRecord[],
): StoryDeliveryTruth {
  // 1. Filter to this story, dedup last-wins by cycleId
  const map = new Map<string, DeliveryRecord>();
  for (const d of deliveries) {
    if (d.storyId !== storyId) continue;
    map.set(d.cycleId, d);
  }
  const records = [...map.values()];

  // 2. No records → todo
  if (records.length === 0) {
    return {
      storyId,
      lifecycleState: "todo",
      delivered: false,
      lastRecordedAt: 0,
      deliveringCycles: [],
    };
  }

  // 3. Sort by recordedAt (oldest → newest). Multiple cycles may have delivered;
  //    use the latest overall record's lifecycleState, but delivered is true iff
  //    ANY record has lifecycleState "done".
  records.sort((a, b) => a.recordedAt - b.recordedAt);

  const latest = records[records.length - 1]!;
  const delivered = records.some((r) => r.lifecycleState === "done");
  const deliveringCycles = [...new Set(records.map((r) => r.cycleId))].sort();

  // 4. Extract PR facts from the most informative record:
  //    - Prefer a "done" record (has merge details) over "pending_merge" over others.
  //    - Within the same lifecycleState, prefer the most recent.
  const doneRecord = records.filter((r) => r.lifecycleState === "done").at(-1);
  const inFlightRecord = records.filter((r) => r.lifecycleState === "pending_merge" || r.lifecycleState === "ci_red").at(-1);
  const bestRecord = doneRecord ?? inFlightRecord ?? latest;

  let prNumber: number | undefined;
  let prUrl: string | undefined;
  let mergeCommit: string | undefined;
  let missingReason: string | undefined;

  if (bestRecord.prNumber.present) {
    prNumber = bestRecord.prNumber.value;
  } else if (bestRecord.lifecycleState === "pending_merge" || bestRecord.lifecycleState === "done") {
    missingReason = `pr_number_${bestRecord.prNumber.reason}`;
  }

  if (bestRecord.prUrl.present) {
    prUrl = bestRecord.prUrl.value;
  } else if (bestRecord.lifecycleState === "pending_merge" || bestRecord.lifecycleState === "done") {
    if (missingReason === undefined) missingReason = `pr_url_${bestRecord.prUrl.reason}`;
  }

  if (bestRecord.mergeCommit.present) {
    mergeCommit = bestRecord.mergeCommit.value;
  } else if (bestRecord.lifecycleState === "done") {
    if (missingReason === undefined) missingReason = `merge_commit_${bestRecord.mergeCommit.reason}`;
  }

  return {
    storyId,
    lifecycleState: latest.lifecycleState,
    delivered,
    prNumber,
    prUrl,
    mergeCommit,
    lastRecordedAt: latest.recordedAt,
    deliveringCycles,
    ...(missingReason !== undefined ? { missingReason } : {}),
  };
}

// ── deriveBacklogStatus (US-TRUTH-015 AC3) ──────────────────────────────────

/**
 * Derive the backlog status CELL string from structured delivery truth.
 *
 * US-TRUTH-015 AC3: backlog status becomes a DERIVED display — "给人看" (for
 * human reading), generated from structured truth, NOT an authoritative source
 * that machines parse. The emoji + text + annotation is formatted here.
 *
 * Output examples:
 *   - `📋 Todo` (no delivery records)
 *   - `🔨 In Progress · PR#878` (in_flight with PR)
 *   - `✅ Done · merged abc123` (done with merge commit)
 *   - `✅ Done` (done, no merge commit recorded)
 *   - `❌ Failed` (failed lifecycle)
 *   - `🚫 Blocked` (blocked)
 *
 * @param truth - The structured truth from {@link queryStoryDelivery}.
 * @returns A backlog status cell string suitable for display in backlog.md.
 */
export function deriveBacklogStatus(truth: StoryDeliveryTruth): string {
  const state = truth.lifecycleState;

  switch (state) {
    case "todo":
      return "📋 Todo";
    case "building":
      return "🔨 In Progress";
    case "pending_merge":
    case "ci_red": {
      const suffix = truth.prNumber !== undefined ? ` · PR#${truth.prNumber}` : "";
      return `🔨 In Progress${suffix}`;
    }
    case "done": {
      const suffix = truth.mergeCommit !== undefined
        ? ` · merged ${truth.mergeCommit.slice(0, 7)}`
        : truth.prNumber !== undefined
          ? ` · PR#${truth.prNumber}`
          : "";
      return `✅ Done${suffix}`;
    }
    case "failed":
      return "❌ Failed";
    case "blocked":
      return "🚫 Hold";
    case "on_hold":
      return "🚫 Hold";
    case "abandoned":
      return "🗑️ Abandoned";
    default: {
      // Exhaustiveness: LIFECYCLE_STATES is the closed set.
      const _exhaustive: never = state;
      return `📋 Todo`;
    }
  }
}

// ── Structural validity (LIFECYCLE_STATES is the closed set) ─────────────────
// If a new LifecycleState is added to the spec and not handled above, TypeScript
// catches it via the `never` assignment in the default branch.
const _lifecycleSet: ReadonlySet<string> = new Set<string>(LIFECYCLE_STATES);
void _lifecycleSet;
