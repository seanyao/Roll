/**
 * @responsibility Runs the `gc` subcommand, aging out surplus attest run directories per the archive verdict.
 */
/**
 * US-META-001 — `roll gc`: bound the size of the archive layout.
 *
 * Every attest writes a fresh, never-overwritten run dir under a card folder
 * (`features/<epic>/<ID>/<run-id>/` — plus the legacy `verification/<ID>/` tree
 * during the migration window). The heavy assets (screenshots) accrue without
 * limit. `roll gc` ages out the old surplus runs per the pure
 * {@link archiveGcVerdict} (keep freshest N OR recent; cut the old-and-surplus
 * tail). `--dry-run` previews; thresholds come from flags > env > defaults.
 */
import {
  ARCHIVE_GC_DEFAULT_KEEP_DAYS,
  ARCHIVE_GC_DEFAULT_KEEP_LATEST,
  archiveGcVerdict,
  resolveKeepDays,
  type ArchiveRun,
} from "@roll/core";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** run-id dir name: `YYYY-MM-DDThh-mm-ss` (attest's run lifecycle). */
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

interface StoryArchive {
  storyId: string;
  dir: string;
  runs: ArchiveRun[];
}

/** The run dirs directly under a story archive dir (skips `latest`, non-runs). */
function runsInDir(dir: string): ArchiveRun[] {
  const out: ArchiveRun[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !RUN_ID_RE.test(e.name)) continue;
    try {
      out.push({ runId: e.name, mtimeSec: Math.floor(statSync(join(dir, e.name)).mtimeMs / 1000) });
    } catch {
      /* unreadable run: skip */
    }
  }
  return out;
}

/** Discover every story archive dir under both layouts that holds ≥1 run. */
export function collectStoryArchives(projectPath: string): StoryArchive[] {
  const out: StoryArchive[] = [];
  // Card layout: features/<epic>/<ID>/<run-id>/
  const featuresRoot = join(projectPath, ".roll", "features");
  if (existsSync(featuresRoot)) {
    for (const epic of safeDirs(featuresRoot)) {
      const epicDir = join(featuresRoot, epic);
      for (const story of safeDirs(epicDir)) {
        const dir = join(epicDir, story);
        const runs = runsInDir(dir);
        if (runs.length > 0) out.push({ storyId: story, dir, runs });
      }
    }
  }
  // Legacy layout: verification/<ID>/<run-id>/
  const verRoot = join(projectPath, ".roll", "verification");
  if (existsSync(verRoot)) {
    for (const story of safeDirs(verRoot)) {
      const dir = join(verRoot, story);
      const runs = runsInDir(dir);
      if (runs.length > 0) out.push({ storyId: story, dir, runs });
    }
  }
  return out;
}

function safeDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function flagNum(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

const USAGE = [
  "Usage: roll gc [--dry-run] [--keep-latest N] [--keep-days M]",
  "  Age out old surplus attest runs under features/<epic>/<ID>/ (and the legacy",
  "  verification/<ID>/ tree). A run is kept if it is one of the freshest N OR",
  "  younger than M days; only the old-and-surplus tail is removed.",
  "  --dry-run        preview deletions without touching disk",
  "  --keep-latest N  always keep the N freshest runs per story (default 10)",
  "  --keep-days M    keep runs younger than M days regardless of rank (default 30)",
].join("\n");

/** `roll gc [--dry-run] [--keep-latest N] [--keep-days M]` */
export function gcCommand(args: string[], deps: { now?: () => Date } = {}): number {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const dryRun = args.includes("--dry-run");
  const keepLatest = flagNum(args, "--keep-latest") ?? ARCHIVE_GC_DEFAULT_KEEP_LATEST;
  const keepDays =
    flagNum(args, "--keep-days") ??
    resolveKeepDays(process.env.ROLL_LOOP_GC_RETENTION_DAYS, undefined) ??
    ARCHIVE_GC_DEFAULT_KEEP_DAYS;
  const nowSec = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const projectPath = process.cwd();

  let deleted = 0;
  let kept = 0;
  const lines: string[] = [];
  for (const sa of collectStoryArchives(projectPath)) {
    const v = archiveGcVerdict(sa.runs, { keepLatest, keepDays, nowSec });
    kept += v.keep.length;
    for (const runId of v.delete) {
      deleted += 1;
      lines.push(`  ${dryRun ? "would delete" : "deleted"}: ${sa.storyId}/${runId}`);
      if (!dryRun) {
        try {
          rmSync(join(sa.dir, runId), { recursive: true, force: true });
        } catch {
          /* best-effort: a failed unlink should not abort the sweep */
        }
      }
    }
  }

  const head = dryRun ? "roll gc (dry-run)\nroll gc（预演）" : "roll gc\nroll gc（垃圾回收）";
  process.stdout.write(
    `${head}\n  keep-latest=${keepLatest} keep-days=${keepDays}\n` +
      lines.join("\n") +
      (lines.length > 0 ? "\n" : "") +
      `  ${dryRun ? "would remove" : "removed"} ${deleted} run(s); kept ${kept}\n` +
      `  ${dryRun ? "将清理" : "已清理"} ${deleted} 个 run；保留 ${kept} 个\n`,
  );
  return 0;
}
