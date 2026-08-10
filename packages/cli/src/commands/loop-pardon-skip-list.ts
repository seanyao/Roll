/**
 * @responsibility Runs the `roll loop pardon-skip-list` transition alias delegating to doctor pardon.
 */
/**
 * `roll loop pardon-skip-list` — legacy transition command.
 *
 * REFACTOR-073: the canonical surface is now `roll doctor pardon`.
 * This command delegates to the shared lib and is retained as a
 * transition alias so existing scripts/help docs don't break.
 */
import { projectIdentity } from "@roll/infra";
import { join } from "node:path";
import {
  rebuildSkipStateFromEvidence,
  readRows,
  readEvents,
  runtimeDir,
} from "../lib/pardon-skip-list.js";
import { readSkipState, writeSkipState } from "../runner/skip-cards.js";

export const LOOP_PARDON_SKIP_LIST_USAGE =
  "Usage: roll loop pardon-skip-list [--dry-run] [--include-unknown]\n" +
  "  Rebuild skip-cards from runs/events, removing env/harness pollution while keeping real card failures.\n" +
  "  --include-unknown also pardons unknown/no-evidence failures; risky because old zero-usage gave_up rows may be real card failures.\n" +
  "  Note: `roll doctor pardon` is the canonical surface for this operation.\n";

export { rebuildSkipStateFromEvidence } from "../lib/pardon-skip-list.js";

export async function loopPardonSkipListCommand(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(LOOP_PARDON_SKIP_LIST_USAGE);
    return 0;
  }
  const dryRun = args.includes("--dry-run");
  const includeUnknown = args.includes("--include-unknown");
  const id = await projectIdentity();
  const rt = runtimeDir(id.path);
  const current = readSkipState(rt);
  const rebuilt = rebuildSkipStateFromEvidence({
    currentFails: current.fails,
    currentSkip: current.skip,
    rows: readRows(join(rt, "runs.jsonl")),
    events: readEvents(join(rt, "events.ndjson")),
    threshold: 3,
    includeUnknown,
  });
  if (!dryRun) writeSkipState(rt, { fails: rebuilt.fails, skip: rebuilt.skip });
  process.stdout.write(
    `${dryRun ? "dry-run: " : ""}pardon skip-list: pardoned=${rebuilt.pardoned.join(",") || "-"} kept=${rebuilt.kept.join(",") || "-"}\n`,
  );
  return 0;
}
