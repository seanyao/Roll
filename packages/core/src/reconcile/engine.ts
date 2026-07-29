/**
 * ReconcileEngine — TS port of the v2 cycle-end reconcile path (US-CORE-008).
 *
 * Invariant I4 (FIX-140/141): "backlog 是愿望，main 是真相." A cycle exiting
 * code 0, or a backlog row reading ✅ Done, NEVER means the work landed — only a
 * real merge into main does. Reconcile is the read-model that compares the
 * loop's recorded intent against git's actual merge evidence and emits DECISIONS
 * (revert plans), never performing I/O itself.
 *
 * Two distinct reconcile responsibilities, both ported here as pure functions:
 *
 * 1. 假 Done detection / merge-evidence backfill — v2 oracle
 *    `_loop_backfill_merged` (bin/roll:13713-13759). It walks runs.jsonl, and for
 *    every row whose `status == "built"` (claimed-but-unconfirmed) probes the
 *    cycle branch's REAL PR state via `gh pr view <branch> --json
 *    state,mergedAt,mergeCommit`. ONLY when the PR state is `MERGED` does it
 *    rewrite the row to `status="merged"` + stamp `merged_at` / `merge_commit`.
 *    A `built` row with no MERGED evidence stays `built` — i.e. "Done ≠ merged":
 *    the story is NOT credited until main proves it.
 *    Ported as {@link reconcileMergeEvidence}: pure (run rows + injected
 *    per-cycle merge evidence in, rewritten rows + a {@link RevertPlan} out). The
 *    `gh` fan-out is the injected adapter's job; core never spawns a process.
 *
 *    Note on FIX-140's backlog revert: with worktree isolation a cycle's ✅ Done
 *    rides only the unmerged PR diff, never the loop's main checkout
 *    (bin/roll:9244-9249), so v2 RETIRED the old "flip ✅ Done back to 📋 Todo on
 *    the main backlog" revert. Crediting is therefore done at the runs.jsonl
 *    layer (built→merged) keyed on real merge evidence — which is exactly what
 *    {@link reconcileMergeEvidence} mirrors. We expose the backlog-revert shape
 *    too ({@link RevertPlan}) for any caller that still needs to demote a row
 *    whose merge evidence never arrived.
 *
 * 2. "进行中" TTL detection (NEW v3 AC, B-group) — v2 oracle
 *    `lib/loop_unstick.py` (read FULLY; mirrored gate-for-gate). A story stuck
 *    🔨 In Progress whose LATEST cycle that picked it ended failed/aborted/blocked
 *    at least N hours ago (default 4) is reverted to 📋 Todo. Stories still
 *    running, or with no failed cycle_end, are left alone (conservative).
 *    Ported as {@link detectStuckStories}: pure (in-progress rows + the pick→
 *    cycle_end event pairing + `now`/`ttlHours` in, revert decisions out). The
 *    event read + backlog rewrite + ALERT append are the caller's.
 *
 * Reuses the BacklogStore parse model (store.ts) for row shape.
 *
 * Purity: no filesystem, no clock, no `gh`/git. All evidence is injected as
 * data; all decisions come out as plain values.
 */
import { STATUS_MARKER } from "@roll/spec";
import { type BacklogItem, parseBacklog } from "../backlog/store.js";
import { deliveryGate } from "../delivery/gate.js";

// ── 1. Merge-evidence reconcile (mirrors _loop_backfill_merged) ──────────────

/** A runs.jsonl row, as the loop writes it. Wider than RollEvent (bash-defined);
 *  we read it as an opaque record and only touch the fields the reconcile uses. */
export interface ReconcileRunRow {
  /** Terminal status the runner stamped (`built` = claimed-but-unconfirmed). */
  status?: string;
  /** Cycle id; the branch is derived as `loop/cycle-<cycleId>`. */
  cycle_id?: string;
  /** Any other columns ride through untouched on rewrite. */
  [k: string]: unknown;
}

/** Real PR merge evidence for one cycle branch (what `gh pr view` reports). The
 *  adapter fetches this; core consumes it as data.
 *  FIX-389b: extended with prNumber + prUrl for the projection engine.
 *  FIX-1032a: extended with mainCiStatus + ciRunUrl for the delivery gate. */
export interface MergeEvidence {
  /** PR state — only `MERGED` credits the row (mirrors the oracle's gate). */
  state: "MERGED" | "CLOSED" | "OPEN" | "UNKNOWN" | string;
  /** ISO merge timestamp (`mergedAt`); stamped onto the row when MERGED. */
  mergedAt?: string;
  /** Merge-commit oid (`mergeCommit.oid`); stamped when MERGED. */
  mergeCommit?: string;
  /** PR number (integer). Stamped as `pr_number` on the credited row. */
  prNumber?: number;
  /** PR URL. Stamped as `pr_url` on the credited row. */
  prUrl?: string;
  /** FIX-1032a: main CI status on the merge commit (green/red/unknown/pending). */
  mainCiStatus?: string;
  /** FIX-1032a: CI run URL for diagnostics (meaningful when CI is red). */
  ciRunUrl?: string;
}

/** Statuses the merge-evidence backfill probes (FIX-243/244): the v2 "built"
 *  claim plus v3's "published" (merge pending) and "failed" (phantom-failure
 *  rows whose PR actually merged). */
export const BACKFILL_CANDIDATE_STATUSES: ReadonlySet<string> = new Set(["built", "published", "failed"]);

/** The cycle branch name for a cycle id (mirrors `loop/cycle-${cycle_id}`). */
export function reconcileBranchName(cycleId: string): string {
  return `loop/cycle-${cycleId}`;
}

/** One row the reconcile credited from `built` → `merged`.
 *  FIX-389b: carries prNumber + prUrl for the projection engine. */
export interface CreditedRun {
  cycleId: string;
  mergedAt: string;
  mergeCommit: string;
  prNumber?: number;
  prUrl?: string;
}

/** Outcome of {@link reconcileMergeEvidence}: rewritten rows + the audit list. */
export interface MergeReconcileResult {
  /** All rows, in input order; credited ones rewritten, others byte-untouched. */
  rows: ReconcileRunRow[];
  /** The rows promoted built→merged (the merge evidence that landed). */
  credited: CreditedRun[];
}

/** Resolve merge evidence for a cycle id (injected — the `gh` fan-out). Return
 *  `undefined` when the branch / PR is unknown (treated as "no evidence"). */
export type MergeEvidenceLookup = (branch: string, cycleId: string) => MergeEvidence | undefined;

/**
 * Backfill real merge evidence into runs rows, mirroring `_loop_backfill_merged`
 * (bin/roll:13728-13754) gate-for-gate:
 *   - rows whose `status != "built"` or with an empty `cycle_id` pass through
 *     unchanged (bin/roll:13732 short-circuit).
 *   - for a `built` row, look up the cycle branch's PR evidence. No evidence, or
 *     a state other than `MERGED`, leaves the row unchanged (I4: built ≠ merged).
 *   - on `MERGED`, rewrite `status="merged"` and stamp `merged_at` /
 *     `merge_commit` (bin/roll:13752), preserving every other field.
 *
 * Pure: evidence is injected via `lookup`. Field stamping mirrors the oracle's
 * jq exactly (`merged_at`/`merge_commit`, empty string when the json field was
 * null/absent — `// ""`).
 */
export function reconcileMergeEvidence(
  rows: readonly ReconcileRunRow[],
  lookup: MergeEvidenceLookup,
): MergeReconcileResult {
  const out: ReconcileRunRow[] = [];
  const credited: CreditedRun[] = [];
  for (const row of rows) {
    const status = typeof row.status === "string" ? row.status : "";
    const cycleId = typeof row.cycle_id === "string" ? row.cycle_id : "";
    // FIX-243/244: v2 backfilled only "built". v3 widens to every claim-shaped
    // status — "published" (publish-ok, merge pending) and "failed" (phantom
    // failures: cycle judged failed, its PR merged minutes later, observed
    // 2026-06-10). The gate stays evidence-only: nothing flips without MERGED.
    if (!BACKFILL_CANDIDATE_STATUSES.has(status) || cycleId === "") {
      out.push(row);
      continue;
    }
    const branch = reconcileBranchName(cycleId);
    const ev = lookup(branch, cycleId);
    if (ev === undefined || ev.state !== "MERGED") {
      out.push(row);
      continue;
    }
    const mergedAt = ev.mergedAt ?? "";
    const mergeCommit = ev.mergeCommit ?? "";
    // FIX-1032a: check the delivery gate before writing "delivered".
    // A merge onto main is only "delivered" when main CI is not red.
    const gate = deliveryGate({
      mainCiStatus: (ev.mainCiStatus as "green" | "red" | "unknown" | "pending") ?? "unknown",
      ciRunUrl: ev.ciRunUrl,
    });
    const outcome = gate.verdict === "allowed" ? "delivered" : gate.verdict;
    // FIX-389b: stamp pr_number + pr_url onto the credited row so the
    // projection engine (FIX-389a) can rebuild deliveries from runs alone.
    const creditedRow: ReconcileRunRow = {
      ...row,
      status: "merged",
      outcome,
      merged_at: mergedAt,
      merge_commit: mergeCommit,
    };
    if (ev.prNumber !== undefined) creditedRow["pr_number"] = ev.prNumber;
    if (ev.prUrl !== undefined) creditedRow["pr_url"] = ev.prUrl;
    if (ev.ciRunUrl !== undefined) creditedRow["ci_run_url"] = ev.ciRunUrl;
    out.push(creditedRow);
    const cr: CreditedRun = { cycleId, mergedAt, mergeCommit };
    if (ev.prNumber !== undefined) cr.prNumber = ev.prNumber;
    if (ev.prUrl !== undefined) cr.prUrl = ev.prUrl;
    credited.push(cr);
  }
  return { rows: out, credited };
}

/** A decision to demote a backlog row whose claimed Done never landed on main.
 *  (FIX-140 shape — retired in the worktree-isolation path, kept for callers
 *  that still reconcile a main-checkout backlog directly.) */
export interface RevertPlan {
  storyId: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
}

// ── 2. "进行中" TTL detection (mirrors lib/loop_unstick.py) ────────────────────

/** Default TTL gate — minimum hours since a failed cycle_end before reverting a
 *  stuck story (loop_unstick.py `--ttl-hours` default 4.0). */
export const DEFAULT_UNSTICK_TTL_HOURS = 4.0;

/** Outcomes that count as a definitively-failed cycle (loop_unstick.py:138). */
export const FAILED_CYCLE_OUTCOMES: ReadonlySet<string> = new Set(["failed", "aborted", "blocked"]);

/** The 🔨 In Progress marker the unstick scan keys on (loop_unstick.py:83). */
export const IN_PROGRESS_MARK = STATUS_MARKER.in_progress;
/** The 📋 Todo status a reverted story flips back to (loop_unstick.py:162). */
export const TODO_STATUS = STATUS_MARKER.todo;

/**
 * A loop event, in the shape `loop_unstick.py` reads from events-<slug>.ndjson.
 * The unstick scanner only consults `stage`, `detail`, `label`, `outcome`, and
 * the parsed `ts` (epoch ms here; the py parses ISO → datetime). Order matters:
 * events MUST be oldest→newest, exactly as the ndjson file is appended.
 */
export interface UnstickEvent {
  stage?: string;
  label?: string;
  detail?: string;
  outcome?: string;
  /** Epoch milliseconds (the py uses tz-aware datetimes; ms keeps it pure). */
  ts?: number;
}

/**
 * Resolve the (cycle_end ts, outcome) of the LATEST cycle that picked `storyId`,
 * mirroring `_cycle_end_for_pick` (loop_unstick.py:96-113):
 *   - walk events back→front for the latest `pick_todo` whose `detail == storyId`
 *     (loop_unstick.py:101-104). None → null (never picked).
 *   - from that pick forward, find the FIRST `cycle_end` whose `label` ENDS WITH
 *     the pick's `label` (loop_unstick.py:110-112). None → null (still running /
 *     no cycle_end yet).
 * Returns `{ endTs, outcome }` or `null`.
 *
 * The `label.endsWith(pickLabel)` match mirrors the py's `.endswith(label)` and
 * a missing/empty pick label degenerates to "any cycle_end after the pick"
 * (every string endsWith "") — identical to the oracle.
 */
export function cycleEndForPick(
  events: readonly UnstickEvent[],
  storyId: string,
): { endTs: number | undefined; outcome: string } | null {
  let pickIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev !== undefined && ev.stage === "pick_todo" && ev.detail === storyId) {
      pickIdx = i;
      break;
    }
  }
  if (pickIdx < 0) return null;
  const pickLabel = events[pickIdx]?.label ?? "";
  for (let i = pickIdx + 1; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.stage === "cycle_end" && (ev.label ?? "").endsWith(pickLabel)) {
      return { endTs: ev.ts, outcome: ev.outcome ?? "" };
    }
  }
  return null;
}

/** A story the unstick gate decides to revert 🔨 In Progress → 📋 Todo. */
export interface StuckRevert {
  storyId: string;
  /** The failed cycle's outcome (failed | aborted | blocked). */
  outcome: string;
  /** Hours since that cycle ended (mirrors the py's `age_hours`, 1-dp printed). */
  ageHours: number;
}

/** Inputs for {@link detectStuckStories}. */
export interface StuckDetectInput {
  /** In-progress backlog rows (id cells) — derive via {@link inProgressStories}. */
  inProgress: readonly { id: string }[];
  /** Loop events oldest→newest (events-<slug>.ndjson order). */
  events: readonly UnstickEvent[];
  /** Current wall-clock, epoch ms (the py uses `datetime.now(utc)`). */
  now: number;
  /** TTL gate in hours (default {@link DEFAULT_UNSTICK_TTL_HOURS}). */
  ttlHours?: number;
}

/**
 * Extract the 🔨 In Progress story ids from a backlog, mirroring
 * `_scan_in_progress` (loop_unstick.py:77-94): a row must CONTAIN
 * `| 🔨 In Progress |`, start with `|`, split to ≥4 pipe-fields, and its second
 * field (the id cell) must ID-match. We reuse the store parse model for the row
 * shape and apply the in-progress + id gate. The py's ID_RE is broader than the
 * store family filter (it accepts any `[A-Z][A-Z0-9]*(-…)*-\d+`), so we anchor
 * on the same regexp here rather than the US/FIX/… family filter to stay
 * byte-faithful to the oracle's scan.
 */
const UNSTICK_ID_RE = /^\s*\[?([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+)/;

/**
 * FIX-1475: the FULL story id from an id cell (link-stripped, trimmed). The
 * {@link UNSTICK_ID_RE} capture only GATES that a row is id-bearing; its group
 * truncates a suffixed id (`US-WS-011a` → `US-WS-011`, `FIX-300-legacy` →
 * `FIX-300`), which would let unstick decide + revert the WRONG row. Identity
 * must come from the whole cell, never the truncating capture.
 */
function fullIdCell(cell: string): string {
  return cell.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").trim();
}

export function inProgressStories(backlogContent: string): { id: string; item: BacklogItem }[] {
  const out: { id: string; item: BacklogItem }[] = [];
  // We must mirror the py's RAW-line scan (it requires the literal
  // `| 🔨 In Progress |` substring AND its own ID_RE on parts[1]), not the
  // store's family-filtered parse — so scan lines directly.
  for (const raw of backlogContent.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.includes(`| ${IN_PROGRESS_MARK} |`)) continue;
    if (!line.startsWith("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 4) continue;
    const m = UNSTICK_ID_RE.exec(parts[1] ?? "");
    if (m === null || m[1] === undefined) continue;
    const id = fullIdCell(parts[1] ?? "");
    out.push({
      id,
      item: { id, desc: parts[2] ?? "", status: IN_PROGRESS_MARK },
    });
  }
  return out;
}

/**
 * Decide which stuck 🔨 In Progress stories to revert to 📋 Todo, mirroring the
 * `main()` gate of loop_unstick.py:134-149 exactly:
 *   - `cutoff = now - ttlHours`.
 *   - for each in-progress story, resolve its latest pick→cycle_end
 *     ({@link cycleEndForPick}). No result → skip (still running / no failed
 *     cycle). loop_unstick.py:140-142.
 *   - outcome NOT in {failed,aborted,blocked} → skip. loop_unstick.py:144-145.
 *   - missing end ts, OR end ts strictly AFTER cutoff (too recent) → skip.
 *     loop_unstick.py:146-147.
 *   - else revert; `ageHours = (now - endTs)/3600000`. loop_unstick.py:148-149.
 * Conservative by construction: a story with no failed cycle, or a fresh
 * failure, is left alone.
 *
 * Pure decision: returns the revert list (the caller flips the backlog rows +
 * appends the ALERT). Returns [] when nothing qualifies (the py's early return).
 */
export function detectStuckStories(input: StuckDetectInput): StuckRevert[] {
  const ttlHours = input.ttlHours ?? DEFAULT_UNSTICK_TTL_HOURS;
  const cutoff = input.now - ttlHours * 3600 * 1000;
  const reverts: StuckRevert[] = [];
  for (const { id } of input.inProgress) {
    const result = cycleEndForPick(input.events, id);
    if (result === null) continue;
    const { endTs, outcome } = result;
    if (!FAILED_CYCLE_OUTCOMES.has(outcome)) continue;
    if (endTs === undefined || endTs > cutoff) continue;
    const ageHours = (input.now - endTs) / 3_600_000;
    reverts.push({ storyId: id, outcome, ageHours });
  }
  return reverts;
}

/**
 * Convenience end-to-end stuck-story decision from RAW backlog text + events,
 * mirroring the loop_unstick.py flow without doing any I/O: scan in-progress
 * rows, then apply the TTL gate. Returns the revert list only (no file writes).
 */
export function reconcileStuckBacklog(
  backlogContent: string,
  events: readonly UnstickEvent[],
  now: number,
  ttlHours: number = DEFAULT_UNSTICK_TTL_HOURS,
): StuckRevert[] {
  const inProgress = inProgressStories(backlogContent);
  return detectStuckStories({ inProgress, events, now, ttlHours });
}

// ── 3. In-progress claim reconcile (FIX-211: Done ≡ merged, no publish抢跑) ────

/**
 * The decision for ONE 🔨 In Progress backlog claim at cycle preflight, gating
 * the ✅ Done flip on REAL merge evidence — the FIX-211 regression: FIX-198
 * anchored the Done write to the main checkout (correct), but flipped ✅ the
 * moment a PR was OPENED (publish-time), so a card read Done while its PR was
 * still open (the loop conductor merged minutes later). "Done ≡ 已合进 main"
 * (backlog.md:4) demands the flip wait for merge:
 *   - the claim's cycle PR is MERGED       → "done"  (reconcile 补翻 → ✅ Done).
 *   - no recorded delivering cycle          → "todo" (dead claim — a crashed
 *                                             cycle that never published a PR;
 *                                             the orphan-recovery reset).
 *   - its PR is CLOSED (unmerged)           → "todo" (abandoned → re-pickable).
 *   - its PR is still OPEN / state unknown  → "keep" (delivered, pending merge —
 *                                             rest at 🔨 + PR; the reconciler
 *                                             merges it, a later preflight flips).
 *
 * Conservative by construction: an unknown/unprobed PR state NEVER flips Done
 * (the whole point — no premature Done) and never reverts a live delivery (no
 * duplicate re-pick); it rests at 🔨 until merge evidence is definitive.
 */
export type ClaimReconcileDecision = "done" | "todo" | "keep";

/** Evidence the caller resolves (runs.jsonl + a gh PR-state probe) per claim. */
export interface ClaimEvidence {
  /** A delivering cycle for this story exists in runs.jsonl (its branch known). */
  hasDeliveringCycle: boolean;
  /** The cycle branch's PR state, when probed (undefined ⇒ unprobed/unknown). */
  prState?: string;
  /** FIX-397 AC2: true when runs.jsonl records a published delivering cycle
   *  WITH a real pr_number — a stronger in-flight signal than hasDeliveringCycle
   *  alone. When true, a gh probe failure (EOF/UNKNOWN) MUST NOT revert the card
   *  to Todo; it stays at 🔨 (keep) until definitive MERGED/CLOSED evidence. */
  hasPublishedPr?: boolean;
}

/** Decide the preflight reconcile action for one 🔨 claim (see type doc). */
export function decideClaimReconcile(ev: ClaimEvidence): ClaimReconcileDecision {
  if (!ev.hasDeliveringCycle) return "todo";
  if (ev.prState === "MERGED") return "done";
  if (ev.prState === "CLOSED") return "todo";
  // FIX-397 AC2: when runs.jsonl proves a published PR exists (hasPublishedPr),
  // a gh probe gap (EOF/UNKNOWN/undefined prState) is NOT evidence of absence —
  // the card stays 🔨 (keep) until definitive MERGED/CLOSED evidence arrives.
  // This is a deliberate redundancy: the final `return "keep"` already handles
  // unknown prState, but hasPublishedPr makes the intent explicit and guards
  // against a future change that flips unknown→todo by default.
  if (ev.hasPublishedPr && ev.prState !== "MERGED" && ev.prState !== "CLOSED") return "keep";
  return "keep";
}

/**
 * Resolve the latest cycle_id that DELIVERED `storyId` from runs rows — the row
 * whose `story_id` matches and whose status is a delivery (`done`/`built`/
 * `merged`). Rows are appended oldest→newest, so the LAST match wins. Returns
 * `undefined` when no delivering cycle is recorded (a dead claim that never
 * opened a PR — there is no branch to probe). The caller derives the branch via
 * {@link reconcileBranchName} and probes its PR state.
 */
export function latestDeliveringCycle(
  rows: readonly ReconcileRunRow[],
  storyId: string,
): string | undefined {
  let found: string | undefined;
  for (const row of rows) {
    const sid = typeof row["story_id"] === "string" ? (row["story_id"] as string) : "";
    if (sid !== storyId) continue;
    const status = typeof row.status === "string" ? row.status : "";
    // FIX-322: include "published" — a cycle that opened a PR (publish-ok, merge
    // pending) IS a delivering cycle whose branch is on the remote. Excluding it
    // made a story whose only delivering cycle rested at `published` look like a
    // dead claim → preflight flipped 🔨→📋 Todo → the card was re-picked and
    // re-delivered (duplicate) before merge-backfill stamped it merged. Aligns
    // with BACKFILL_CANDIDATE_STATUSES (which already includes "published").
    if (status !== "done" && status !== "built" && status !== "merged" && status !== "published") continue;
    const cid = typeof row.cycle_id === "string" ? row.cycle_id : "";
    if (cid !== "") found = cid;
  }
  return found;
}

/**
 * FIX-323 — true iff `storyId` has at least one MERGED delivery in `rows`.
 *
 * The signal is `status === "merged"` (stamped by merge-backfill when the
 * delivery PR landed — see {@link reconcileMergeEvidence}) or the legacy
 * `outcome === "delivered"`. A merged delivery means the deliverable is on main
 * and the card is Done ≡ merged. This is STRICTER than
 * {@link latestDeliveringCycle} (which also counts `published`/`built`
 * in-flight cycles): only a TRULY-merged delivery may suppress re-pick, so a
 * still-open delivery is never mistaken for done.
 *
 * Used by the picker (injected as `hasMergedDelivery`) and the preflight
 * reconcile to keep a merged-but-mis-statused card (e.g. reset to 📋 Todo by a
 * gave_up cycle) from being re-picked and re-burned forever.
 */
export function hasMergedDelivery(rows: readonly ReconcileRunRow[], storyId: string): boolean {
  for (const row of rows) {
    const sid = typeof row["story_id"] === "string" ? (row["story_id"] as string) : "";
    if (sid !== storyId) continue;
    const status = typeof row.status === "string" ? row.status : "";
    const outcome = typeof row.outcome === "string" ? row.outcome : "";
    if (status === "merged" || outcome === "delivered") return true;
  }
  return false;
}

// ── 3. Resume-prior-work candidate lookup (RESUME-PRIOR-WORK hook) ────────────

/**
 * The runs-row statuses whose cycle PUSHED real commits to a `loop/cycle-<id>`
 * branch on origin — so the branch is a candidate to RESUME from instead of
 * redoing the work on a fresh origin/main worktree:
 *   - `orphan`    : publish failed, branch+tag pushed for audit (orchestrator
 *                   push_orphan) — the FIX-284/285 stranded-work case.
 *   - `built`     : claimed-but-unconfirmed; the cycle branch holds commits.
 *   - `published` : PR opened, merge pending — the branch is on the remote.
 *   - `done`      : PR opened/ff-merged — the branch was pushed (a still-OPEN PR
 *                   that never merged is un-merged and resumable; a merged one is
 *                   filtered out by the executor's git merged-into-origin/main
 *                   probe, so listing it here is safe and correct).
 *   - `failed`    : a gate-killed cycle WITH commits pushes its branch via
 *                   push_orphan (orchestrator facts_captured failed-with-commits)
 *                   — the prior agent's real work is reachable on origin.
 * `idle` / `blocked` / `aborted` never pushed a branch with new work, so they are
 * NOT candidates.
 */
export const RESUME_CANDIDATE_STATUSES: ReadonlySet<string> = new Set([
  "orphan",
  "built",
  "published",
  "done",
  "failed",
  "merged",
]);

/**
 * Resolve the prior cycle branches that may hold un-merged real work for
 * `storyId`, MOST-RECENT-FIRST (the runs ledger links story_id ↔ cycle_id and is
 * appended oldest→newest, so we reverse). Each entry is the `loop/cycle-<id>`
 * branch name the cycle would have pushed; the caller probes git to keep only the
 * one that is (a) NOT merged into origin/main and (b) cleanly rebases onto it.
 *
 * Pure: runs rows in, ordered branch names out. The git merged/rebase probes are
 * the executor's (RESUME-PRIOR-WORK hook in create_worktree); core never spawns.
 * Distinct from {@link latestDeliveringCycle} (single delivery row for the
 * preflight claim reconcile): this returns the FULL ordered candidate list
 * across every branch-pushing terminal, because a delivery may have failed while
 * an earlier audit branch still carries the salvageable work.
 */
export function resumeCandidateBranches(
  rows: readonly ReconcileRunRow[],
  storyId: string,
): string[] {
  const cycleIds: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const sid = typeof row["story_id"] === "string" ? (row["story_id"] as string) : "";
    if (sid !== storyId) continue;
    const status = typeof row.status === "string" ? row.status : "";
    if (!RESUME_CANDIDATE_STATUSES.has(status)) continue;
    const cid = typeof row.cycle_id === "string" ? row.cycle_id : "";
    if (cid === "" || seen.has(cid)) continue;
    seen.add(cid);
    cycleIds.push(cid);
  }
  // Oldest→newest in the ledger → reverse to most-recent-first so the caller
  // prefers the freshest stranded work and only falls back to older branches.
  return cycleIds.reverse().map((id) => reconcileBranchName(id));
}

// ── 4. FIX-397 AC3: PR-info extractors from runs rows ────────────────────────

/**
 * Extract the pr_number from the latest delivering row for `storyId` in runs
 * (FIX-397 AC3). Returns a positive integer pr_number, or undefined when:
 *   - no delivering row exists for this story
 *   - the latest delivering row has no pr_number (legacy `pr=None`)
 *   - the stored pr_number is 0 / empty / NaN (falsy guard for corrupted data)
 *
 * The lookup mirrors {@link latestDeliveringCycle} (scans oldest→newest, last
 * delivering-write wins), but returns the pr_number instead of the cycle id.
 */
export function runRowPrNumber(
  rows: readonly ReconcileRunRow[],
  storyId: string,
): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row === undefined) continue;
    const sid = typeof row["story_id"] === "string" ? (row["story_id"] as string) : "";
    if (sid !== storyId) continue;
    const status = typeof row.status === "string" ? row.status : "";
    // Only delivering-status rows carry a real PR number.
    if (status !== "done" && status !== "built" && status !== "merged" && status !== "published") continue;
    const pn = typeof row["pr_number"] === "number" ? (row["pr_number"] as number) : undefined;
    if (pn !== undefined && pn > 0 && Number.isFinite(pn)) return pn;
  }
  return undefined;
}

/**
 * True when runs.jsonl records a published delivering cycle WITH a real
 * pr_number for `storyId` (FIX-397 AC3). This is the signal that feeds
 * {@link ClaimEvidence.hasPublishedPr} — a stronger in-flight proof than
 * `hasDeliveringCycle` alone, because it means the cycle not only delivered
 * but also recorded WHICH PR, so the card↔PR connection is intact.
 *
 * Legacy rows (published but pr=None) → false (no PR info to trust).
 */
export function runRowHasPublishedPr(
  rows: readonly ReconcileRunRow[],
  storyId: string,
): boolean {
  return runRowPrNumber(rows, storyId) !== undefined;
}

/** Apply a stuck-story revert to backlog text: flip the FIRST `| 🔨 In Progress |`
 *  → `| 📋 Todo |` on each reverted story's row, mirroring loop_unstick.py:162
 *  (`lines[idx].replace("| 🔨 In Progress |", "| 📋 Todo |")`, first occurrence).
 *  Returns the rewritten content. Rows are matched by the same id scan; only the
 *  marker substring is rewritten so the rest of the row is byte-preserved. */
export function applyStuckReverts(backlogContent: string, reverts: readonly StuckRevert[]): string {
  if (reverts.length === 0) return backlogContent;
  const ids = new Set(reverts.map((r) => r.storyId));
  const lines = backlogContent.split("\n");
  const out = lines.map((raw) => {
    // Match the row exactly like _scan_in_progress (trimmed parts), but rewrite
    // the RAW line verbatim like loop_unstick.py:162 (whole-line str.replace of
    // the marker substring) so all surrounding bytes are preserved.
    const line = raw.replace(/\r$/, "");
    if (!line.includes(`| ${IN_PROGRESS_MARK} |`)) return raw;
    if (!line.startsWith("|")) return raw;
    const parts = line.split("|").map((p) => p.trim());
    const m = UNSTICK_ID_RE.exec(parts[1] ?? "");
    if (m === null || m[1] === undefined) return raw;
    if (!ids.has(fullIdCell(parts[1] ?? ""))) return raw;
    // Python str.replace replaces ALL occurrences; a row carries the marker once.
    return raw.replace(`| ${IN_PROGRESS_MARK} |`, `| ${TODO_STATUS} |`);
  });
  return out.join("\n");
}

// ─── FIX-1211: human-claim expiry ────────────────────────────────────────────

/** Inputs for {@link reconcileExpiredClaims}. */
export interface ExpiredClaimInput {
  /** In-progress backlog rows. */
  inProgress: readonly { id: string }[];
  /** Lease map from `.roll/loop/story-leases.json` (empty map when absent). */
  leases: Record<string, { pid?: number; claimedAt: number; source: string }>;
  /** Current wall-clock, epoch ms. */
  now: number;
}

/** A claim whose 24h soft lease has expired. */
export interface ExpiredClaim {
  storyId: string;
  /** Hours since the claim was made (based on lease entry). */
  ageHours: number;
}

/**
 * Detect human-claimed (leaseless or supervisor/human source) In Progress
 * stories whose 24h soft lease has expired. These are candidates for auto-
 * downgrade to Todo.
 *
 * Only stories WITH a lease entry (source !== "cycle" or no pid) are checked;
 * stories without any lease entry are conservatively left alone (we lack the
 * claim timestamp). The caller resolves missing lease timestamps externally.
 */
export function reconcileExpiredClaims(input: ExpiredClaimInput): ExpiredClaim[] {
  const expired: ExpiredClaim[] = [];
  for (const { id } of input.inProgress) {
    const entry = input.leases[id];
    if (entry === undefined) continue; // no lease data -> conservative skip
    // Only expire non-cycle claims (human or supervisor preemption).
    // Cycle claims are handled by detectStuckStories (death recovery).
    if (entry.source === "cycle" && entry.pid !== undefined) continue;
    const ageHours = (input.now - entry.claimedAt) / 3_600_000;
    if (ageHours >= 24) {
      expired.push({ storyId: id, ageHours });
    }
  }
  return expired;
}
