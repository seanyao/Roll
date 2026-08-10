/**
 * @responsibility Decides which archived acceptance-report runs are safe to retain or delete.
 * US-META-001 — archive GC verdict (pure).
 *
 * A card folder accrues one run dir per attest (`<run-id>/` + screenshots +
 * evidence), never overwritten. Left unbounded the heavy assets (screenshots)
 * pile up. The retention rule keeps the freshest runs and ages out the rest:
 *
 *   keep  iff  rank < keepLatest         (always keep the freshest N)
 *         OR   age <= keepDays           (recent runs survive regardless of rank)
 *   delete otherwise                     (old AND beyond the keep-N window)
 *
 * Conservative by construction: a run survives if EITHER it is one of the latest
 * N OR it is younger than the day window — only the old-and-surplus tail is cut.
 * Pure: the caller supplies `nowSec` and the runs' mtimes; this decides, the
 * command executes (mirrors loop/recovery's gcRetentionVerdict split).
 */

/** Defaults: keep the 10 freshest runs; age out anything older than 30 days. */
export const ARCHIVE_GC_DEFAULT_KEEP_LATEST = 10;
export const ARCHIVE_GC_DEFAULT_KEEP_DAYS = 30;

export interface ArchiveRun {
  /** Run dir name (run-id, a sortable timestamp). */
  runId: string;
  /** Last-modified time in epoch seconds. */
  mtimeSec: number;
}

export interface ArchiveGcOptions {
  keepLatest: number;
  keepDays: number;
  nowSec: number;
}

export interface ArchiveGcVerdict {
  keep: string[];
  delete: string[];
}

/**
 * Decide which runs to keep vs delete. Ranking is by recency (mtime desc, then
 * runId desc as a stable tie-break). The freshest `keepLatest` are always kept;
 * older surplus runs are deleted once their age exceeds `keepDays`.
 */
export function archiveGcVerdict(runs: ArchiveRun[], opts: ArchiveGcOptions): ArchiveGcVerdict {
  const keepLatest = Math.max(0, Math.floor(opts.keepLatest));
  const cutoffSec = opts.nowSec - Math.max(0, opts.keepDays) * 86400;
  const ranked = [...runs].sort((a, b) => b.mtimeSec - a.mtimeSec || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  const keep: string[] = [];
  const del: string[] = [];
  ranked.forEach((r, i) => {
    const inKeepWindow = i < keepLatest;
    const recent = r.mtimeSec >= cutoffSec;
    if (inKeepWindow || recent) keep.push(r.runId);
    else del.push(r.runId);
  });
  return { keep, delete: del };
}
