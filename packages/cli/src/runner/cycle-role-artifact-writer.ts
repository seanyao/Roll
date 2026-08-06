/**
 * @responsibility Writes CycleRoleSummary artifacts from the event stream at cycle end.
 */
/**
 * cycle-role-artifact-writer.ts — US-OBS-032: writes CycleRoleSummary
 * artifacts (summary.json + summary.md) from the event stream at cycle
 * wrap-up. Called best-effort from the executor's append_run handler.
 *
 * This function reads the already-written events.ndjson, builds a summary
 * for the completed cycle, and writes the artifacts to
 * `.roll/loop/cycle-logs/<cycleId>/`.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseEventLine, type RollEvent } from "@roll/spec";
import {
  buildCycleRoleSummary,
  renderCycleRoleSummaryMarkdown,
  type BuildCycleRoleSummaryInput,
} from "@roll/core";

/**
 * Best-effort: build and write cycle role summary artifacts from the event
 * stream. Never throws — failures are silently caught so they never disrupt
 * the cycle terminal.
 */
export function writeCycleRoleSummaryBestEffort(
  cycleId: string,
  eventsPath: string,
  cycleLogDir: string,
): void {
  try {
    if (!cycleId) return;

    // Read events
    let raw: string;
    try {
      raw = readFileSync(eventsPath, "utf-8");
    } catch {
      return; // no events file yet — nothing to project
    }

    // Ensure the cycle-logs subdirectory exists
    const outDir = `${cycleLogDir}/${cycleId}`;
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    // Parse all events
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const events: RollEvent[] = [];
    for (const line of lines) {
      const ev = parseEventLine(line);
      if (ev) events.push(ev);
    }

    // Build the summary
    const input: BuildCycleRoleSummaryInput = {
      cycleId,
      events,
      eventsPath,
      peerDir: cycleLogDir.replace("/cycle-logs", "/peer"),
      cycleLogDir,
    };

    const summary = buildCycleRoleSummary(input);

    // Write artifacts
    writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2), "utf-8");
    writeFileSync(`${outDir}/summary.md`, renderCycleRoleSummaryMarkdown(summary), "utf-8");
  } catch {
    // Best-effort — never disrupt the cycle terminal
  }
}
