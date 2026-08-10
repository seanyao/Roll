/**
 * @responsibility Backfills merge-evidence records into the live loop.
 */
/**
 * FIX-243 — wire the merge-evidence backfill (v2 `_loop_backfill_merged`,
 * bin/roll:13713-13759) into the live loop.
 *
 * Confirmed dead 2026-06-10: cycle 212711 ended failed, its PR #577 merged,
 * and multiple clean cycles later the runs row still read failed/failed with
 * no merge field — `reconcileMergeEvidence` (core, pure) had no live caller
 * (the executor's `reconcile` command is terminal bookkeeping only). Combined
 * with FIX-244's "published" terminal this is the credit path: a claim-shaped
 * row (built / published / failed) whose cycle branch's PR really MERGED is
 * rewritten to status=merged + outcome=delivered + merge stamps.
 *
 * Evidence-only, bounded: nothing flips without gh-confirmed MERGED, and at
 * most {@link BACKFILL_PROBE_CAP} most-recent candidates are probed per call
 * (one `gh pr view` each) so the fan-out can never stall a cycle.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  BACKFILL_CANDIDATE_STATUSES,
  type CreditedRun,
  type MergeEvidence,
  type ReconcileRunRow,
  reconcileBranchName,
  reconcileMergeEvidence,
} from "@roll/core";
import { type PrMergeInfo, ghRepoSlug, prViewMergeInfo, remoteUrl } from "@roll/infra";

/** Max candidate rows probed per call — bounds the gh fan-out. */
export const BACKFILL_PROBE_CAP = 20;

export interface BackfillDeps {
  /** Repo slug override (tests); default resolves from the project's remote. */
  slug?: string;
  /** PR merge-info fetcher (tests inject); default `gh pr view`. */
  fetchInfo?: (slug: string, ref: string) => Promise<PrMergeInfo | undefined>;
}

/** A parsed runs.jsonl line; raw is kept so non-credited lines stay byte-verbatim. */
interface ParsedLine {
  raw: string;
  row: ReconcileRunRow | null;
}

function parseLine(raw: string): ParsedLine {
  if (raw.trim() === "") return { raw, row: null };
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return { raw, row: v as ReconcileRunRow };
  } catch {
    /* junk line: preserved verbatim */
  }
  return { raw, row: null };
}

function isCandidate(row: ReconcileRunRow): boolean {
  const status = typeof row.status === "string" ? row.status : "";
  const cycleId = typeof row.cycle_id === "string" ? row.cycle_id : "";
  const hasEvidence = typeof row["merge_commit"] === "string" && row["merge_commit"] !== "";
  return BACKFILL_CANDIDATE_STATUSES.has(status) && cycleId !== "" && !hasEvidence;
}

/**
 * Probe + credit merged runs in `runsPath`. Returns the credited list (possibly
 * empty). Never throws on per-row trouble; a failed gh probe = "no evidence".
 * The file is rewritten ONLY when something was credited.
 */
export async function backfillMergedRuns(
  projectPath: string,
  runsPath: string,
  deps: BackfillDeps = {},
): Promise<CreditedRun[]> {
  let body: string;
  try {
    body = readFileSync(runsPath, "utf8");
  } catch {
    return []; // no runs file yet — nothing to credit
  }
  const trailingNewline = body.endsWith("\n");
  const lines = (trailingNewline ? body.slice(0, -1) : body).split("\n").map(parseLine);

  const candidates = lines.filter((l): l is ParsedLine & { row: ReconcileRunRow } => l.row !== null && isCandidate(l.row));
  if (candidates.length === 0) return [];
  // Most-recent candidates win the probe window (rows append chronologically).
  const window = candidates.slice(-BACKFILL_PROBE_CAP);

  const slug = deps.slug ?? ghRepoSlug(await remoteUrl(projectPath));
  if (slug === undefined) return []; // no remote slug → no gh evidence possible
  const fetchInfo = deps.fetchInfo ?? prViewMergeInfo;

  // Pre-fetch evidence (async) into a map; the core reconcile is sync + pure.
  const evidence = new Map<string, MergeEvidence>();
  for (const c of window) {
    const cycleId = typeof c.row.cycle_id === "string" ? c.row.cycle_id : "";
    const branch = reconcileBranchName(cycleId);
    try {
      const info = await fetchInfo(slug, branch);
      if (info !== undefined) {
        evidence.set(branch, {
          state: info.state,
          mergedAt: info.mergedAt,
          mergeCommit: info.mergeCommit,
          // FIX-389b: thread prNumber + prUrl from gh so reconcileMergeEvidence
          // stamps them onto the credited runs row.
          prNumber: info.prNumber,
          prUrl: info.prUrl,
        });
      }
    } catch {
      /* gh hiccup on one row must not kill the pass */
    }
  }
  if (evidence.size === 0) return [];

  const rows = lines.filter((l) => l.row !== null).map((l) => l.row as ReconcileRunRow);
  const result = reconcileMergeEvidence(rows, (branch) => evidence.get(branch));
  if (result.credited.length === 0) return [];

  // Rewrite: credited rows re-serialize; everything else stays byte-verbatim.
  const creditedIds = new Set(result.credited.map((c) => c.cycleId));
  let rowIdx = 0;
  const out = lines.map((l) => {
    if (l.row === null) return l.raw;
    const updated = result.rows[rowIdx++] as ReconcileRunRow;
    const cycleId = typeof l.row.cycle_id === "string" ? l.row.cycle_id : "";
    return creditedIds.has(cycleId) && updated.status === "merged" ? JSON.stringify(updated) : l.raw;
  });
  writeFileSync(runsPath, out.join("\n") + (trailingNewline ? "\n" : ""), "utf8");
  return result.credited;
}
