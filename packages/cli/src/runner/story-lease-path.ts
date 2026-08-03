import { dirname, join } from "node:path";
import type { RunnerPaths } from "./ports.js";

/** Resolve the canonical per-Story lease directory, including legacy Workspace paths. */
export function resolveStoryLeasePath(
  paths: Pick<RunnerPaths, "eventsPath" | "storyLeasePath">,
): string {
  const configured = paths.storyLeasePath;
  if (configured !== undefined) {
    return configured.endsWith(".json") ? join(dirname(configured), "leases") : configured;
  }
  return join(dirname(paths.eventsPath), "leases");
}
