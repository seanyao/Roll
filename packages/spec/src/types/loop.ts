/**
 * @responsibility Declares the loop contract types.
 */
/** Loop contracts (BC2). v3 phase one schedules main/pr/ci/alert only. */
export const LOOP_TYPES = ["main", "ci", "alert", "dream", "dep", "doc", "bug"] as const;
export type LoopType = (typeof LOOP_TYPES)[number];

export type LoopState = "idle" | "running" | "paused" | "error";

export interface LoopConfig {
  type: LoopType;
  /** Fire interval in minutes. */
  intervalMin: number;
  enabled: boolean;
}
