/**
 * @responsibility Shares the pardon-skip-list logic between the legacy command and doctor pardon.
 */
/**
 * Shared pardon-skip-list logic — consumed by both `loop pardon-skip-list`
 * (legacy transition) and `doctor pardon` (canonical surface).
 *
 * REFACTOR-073: extracted from commands/loop-pardon-skip-list.ts so doctor
 * can carry the same diagnostic without duplicating the rebuild algorithm.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEventLine, type FailureClass, type RollEvent } from "@roll/spec";
import { classifyCycleFailure } from "../runner/failure-attribution.js";

export interface RunRow {
  readonly story_id?: string;
  readonly cycle_id?: string;
  readonly run_id?: string;
  readonly status?: string;
  readonly outcome?: string;
  readonly failure_class?: FailureClass;
  readonly root_cause_key?: string;
  readonly tcr_count?: number;
  readonly tokens_in?: number;
  readonly tokens_out?: number;
}

export function runtimeDir(projectPath: string): string {
  const env = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  return env !== "" ? env : join(projectPath, ".roll", "loop");
}

export function readRows(path: string): RunRow[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunRow];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function readEvents(path: string): RollEvent[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").map(parseEventLine).filter((event): event is RollEvent => event !== null);
  } catch {
    return [];
  }
}

export function failedRow(row: RunRow): boolean {
  return row.status === "failed" || row.status === "blocked" || row.status === "gave_up" || row.outcome === "failed" || row.outcome === "blocked" || row.outcome === "gave_up";
}

export interface RebuildInput {
  readonly currentFails: Record<string, number>;
  readonly currentSkip: readonly string[];
  readonly rows: readonly RunRow[];
  readonly events: readonly RollEvent[];
  readonly threshold: number;
  readonly includeUnknown?: boolean;
}

export interface RebuildResult {
  fails: Record<string, number>;
  skip: string[];
  pardoned: string[];
  kept: string[];
}

export function rebuildSkipStateFromEvidence(input: RebuildInput): RebuildResult {
  const affected = new Set([...Object.keys(input.currentFails), ...input.currentSkip]);
  const nextFails: Record<string, number> = {};
  for (const row of input.rows) {
    const storyId = (row.story_id ?? "").trim();
    const cycleId = (row.cycle_id ?? row.run_id ?? "").trim();
    if (storyId === "" || cycleId === "" || !affected.has(storyId) || !failedRow(row)) continue;
    const rowClass = row.failure_class;
    const cycleEvents = input.events.filter((event) => (event as unknown as Record<string, unknown>)["cycleId"] === cycleId);
    const hasReplayEvidence =
      (row.tcr_count ?? 0) > 0 ||
      (row.tokens_in ?? 0) > 0 ||
      (row.tokens_out ?? 0) > 0 ||
      cycleEvents.some((event) => event.type !== "cycle:end");
    const attribution =
      hasReplayEvidence || (rowClass !== "env" && rowClass !== "harness" && rowClass !== "card" && rowClass !== "unknown")
        ? classifyCycleFailure({
            cycleId,
            terminal: row.status ?? row.outcome,
            tcrCount: row.tcr_count,
            tokensIn: row.tokens_in,
            tokensOut: row.tokens_out,
            events: cycleEvents,
          })
        : { failureClass: rowClass, rootCauseKey: row.root_cause_key ?? `${rowClass}:unknown`, confidence: rowClass === "unknown" ? "unknown" as const : "envelope" as const };
    if (attribution.failureClass === "card") {
      nextFails[storyId] = (nextFails[storyId] ?? 0) + 1;
    } else if (attribution.failureClass === "unknown" && input.includeUnknown !== true) {
      const preserved = input.currentFails[storyId] ?? (input.currentSkip.includes(storyId) ? input.threshold : 1);
      nextFails[storyId] = Math.max(nextFails[storyId] ?? 0, preserved);
    }
  }
  const nextSkip = Object.entries(nextFails)
    .filter(([, count]) => count >= input.threshold)
    .map(([storyId]) => storyId)
    .sort();
  const pardoned = [...affected].filter((storyId) => !nextSkip.includes(storyId) && (input.currentSkip.includes(storyId) || input.currentFails[storyId] !== undefined)).sort();
  const kept = [...affected].filter((storyId) => nextSkip.includes(storyId)).sort();
  return { fails: nextFails, skip: nextSkip, pardoned, kept };
}
