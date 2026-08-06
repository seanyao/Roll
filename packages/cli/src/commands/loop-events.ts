/**
 * @responsibility Runs the `roll loop events` subcommand, tailing the shared per-project event log.
 */
/**
 * `roll loop events [N]` — TS port of bin/roll's `_loop_event_log` (US-PORT-022).
 * Tails the last N events from the shared per-project event log
 * `<shared>/loop/events-<slug>.ndjson` and prints one aligned line each. Pure
 * read — no bash fallback.
 *
 * Byte-aligned with the bash oracle's python formatter: `  <ts>  <stage:12>
 * <label:20>  <detail>  <outcome>` (stage/label left-padded), malformed lines
 * skipped, and the exact "[monitor] No event log found …" miss message.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectSlug, sharedRoot } from "./dashboard.js";

function projectPath(): string {
  return (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

export function loopEventsCommand(argv: string[]): number {
  const n = argv[0] !== undefined && /^\d+$/.test(argv[0]) ? parseInt(argv[0], 10) : 20;
  const slug = projectSlug();
  const evfile = join(sharedRoot(), "loop", `events-${slug}.ndjson`);
  if (!existsSync(evfile)) {
    process.stdout.write(`[monitor] No event log found for project: ${slug}\n`);
    return 1;
  }
  let lines: string[];
  try {
    lines = readFileSync(evfile, "utf8").split("\n").filter((l) => l !== "");
  } catch {
    lines = [];
  }
  const out: string[] = [];
  for (const line of lines.slice(-n)) {
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      out.push(
        `  ${str(e["ts"])}  ${str(e["stage"]).padEnd(12)}  ${str(e["label"]).padEnd(20)}  ${str(e["detail"])}  ${str(e["outcome"])}`,
      );
    } catch {
      /* skip malformed (mirrors the bash python `except: pass`) */
    }
  }
  if (out.length > 0) process.stdout.write(out.join("\n") + "\n");
  return 0;
}
