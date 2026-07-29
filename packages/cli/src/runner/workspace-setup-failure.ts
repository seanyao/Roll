import { releaseStoryLease } from "@roll/core";
import { STATUS_MARKER } from "@roll/spec";
import type { ExecuteResult, Ports } from "./ports.js";

export function workspaceSetupFailed(input: {
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
