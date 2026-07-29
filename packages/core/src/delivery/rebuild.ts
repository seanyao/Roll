/**
 * FIX-389a — Projection engine: rebuild deliveries.jsonl from runs+git facts.
 *
 * deliveries.jsonl is a REBUILDABLE CACHE — never independently authoritative.
 * The authoritative sources are:
 *   - git merges on main = `done` truth
 *   - runs.jsonl rows = `pending_merge` / intent truth
 *
 * This module provides:
 *   1. {@link RunFact} / {@link MergeFact} — the two fact types.
 *   2. {@link extractRunFact} / {@link parseMergeCommitMessages} /
 *      {@link parseMergeCommitLog} — fact parsers.
 *   3. {@link rebuildDeliveriesFromFacts} — the pure, deterministic projection.
 *
 * AC1: rebuild is deterministic and idempotent.
 * AC2: delete deliveries.jsonl → rebuild → same result.
 * AC4: no separate backfill script needed; first rebuild covers all history.
 * AC7: genuinely not-delivered cards stay todo (no false positives).
 */
import type { DeliveryRecord, FactOr, FailureClass, HistoricalTerminalOutcome } from "@roll/spec";
import { present, absent, lifecycleFromFacts } from "@roll/spec";
import type { RunRow } from "../events/bus.js";
import type { ExecPort } from "./infra-default.js";
import { RUNS_FILE } from "../events/bus.js";
import { deliveriesPath } from "./store.js";
import { join } from "node:path";

// ── Fact types ───────────────────────────────────────────────────────────────

/** One run row's delivery-relevant fields, extracted from runs.jsonl. */
export interface RunFact {
  storyId: string;
  cycleId: string;
  /** Raw status field from the run row (e.g. "built", "published", "merged"). */
  status: string;
  /** Terminal outcome field (e.g. "delivered", "published_pending_merge", "failed"). */
  outcome: string;
  /** PR number, when the run published one. */
  prNumber?: number;
  /** Merge commit SHA, when the backfill already stamped it. */
  mergeCommit?: string;
  /** Merge timestamp (epoch ms), when the backfill stamped it. */
  mergedAt?: number;
  /** When this run was recorded (epoch ms). */
  recordedAt: number;
  /** REFACTOR-070: generalized failure attribution (env|harness|card|unknown). */
  failureClass?: FailureClass;
  /** REFACTOR-070: deterministic root-cause key. */
  rootCauseKey?: string;
}

/** One PR merge on main, extracted from git log. */
export interface MergeFact {
  /** PR number (parsed from "Merge pull request #N …" or "(#N)"), or 0 when git has only story-id evidence. */
  prNumber: number;
  /** Merge commit SHA on main. */
  mergeCommit: string;
  /** Merge timestamp (epoch seconds from git commit date). */
  mergedAt: number;
  /**
   * Story-ids parsed from the merge commit subject (FIX-904).
   *
   * This is the **authoritative `done` signal** — a merge whose subject names
   * a story-id proves that story shipped, regardless of whether any loop run
   * recorded the PR number (manual salvage, PR-lane direct merge, etc.).
   *
   * Shorthand like `FIX-389a/b/c` is expanded to `["FIX-389a","FIX-389b","FIX-389c"]`.
   * Subjects with no story-id (e.g. `loop cycle cycle-… (#892)`) yield `[]`.
   */
  storyIds: string[];
  /**
   * Whether the commit touches product code (any path outside `.roll/`).
   *
   * FIX-1208: in-repo `.roll` projects can have card-creation / docs-only
   * commits whose subject happens to mention a story-id. Those commits only
   * touch meta paths (`.roll/...`) and must NOT be treated as deliveries,
   * otherwise a card that was only created becomes falsely `done` and is
   * never picked up again.
   *
   * `true` / omitted for backwards compatibility: a MergeFact without this
   * field is assumed to touch product code, so existing callers and tests
   * keep their current behavior.
   */
  touchesProductCode?: boolean;
  /**
   * Whether the commit subject is a NON-delivery conventional-commit type
   * (`docs:` / `chore:`) — FIX-1270.
   *
   * A CHANGELOG sweep such as
   * `docs: CHANGELOG sweep — FIX-1259..1267, US-LOOP-107..109 (#1398)` is a
   * squash merge: it is PR-linked (`(#1398)`) and touches product code
   * (`CHANGELOG.md` lives outside `.roll/`, so the FIX-1208 gate misses it),
   * yet the card-ids in its subject are *mentions*, not deliveries. The real
   * delivery PRs are elsewhere (US-LOOP-107 shipped as 107a/#1388, 107b/#1390).
   * A `nonDelivery` merge must never be a subject-based attribution source,
   * otherwise it steals a card's delivery projection from its real PR and
   * desyncs the backlog PR refs from `queryStoryDelivery` (the 2026-07-16
   * truth-live gate red).
   *
   * Omitted / `false` = a normal delivery commit (backwards compatible).
   */
  nonDelivery?: boolean;
}

/**
 * Authoritative provenance of a merge fact (FIX-1266, GitHub #1034).
 *
 * A merge's authority to complete a card is graded by how it was attributed:
 *   - `pr_linked`   — the merge commit carries a PR reference (`(#N)` squash or
 *     `Merge pull request #N`). This is a first-class delivery signal.
 *   - `subject_only` — the commit subject merely NAMES a story-id but carries
 *     no PR reference. On its own this is NOT a delivery: a direct-to-main
 *     commit or `tcr:` micro-commit whose message mentions a card must not
 *     complete it. A subject-only mention can only CORROBORATE run/ledger
 *     evidence (see the run-correlation path in {@link rebuildDeliveriesFromFacts}).
 *
 * The third authoritative class in the AC — a run/ledger-correlated merge — is
 * not a property of a MergeFact alone; it is established in the projection by
 * matching a merge to a run row (by PR number or merge SHA), so it is handled
 * there rather than here.
 */
export type MergeProvenance = "pr_linked" | "subject_only";

/**
 * Classify a {@link MergeFact}'s provenance (FIX-1266). `pr_linked` when the
 * commit carries a PR number; `subject_only` otherwise.
 */
export function mergeProvenance(fact: MergeFact): MergeProvenance {
  return fact.prNumber > 0 ? "pr_linked" : "subject_only";
}

/**
 * A subject-only merge that names a story but has no PR link (FIX-1266).
 *
 * These are surfaced as diagnostic / unattributed truth — NOT delivery
 * records. They cannot create `lifecycleState=done`; an owner can inspect them
 * to decide whether a direct-to-main commit that mentions a card is a genuine
 * manual delivery or noise.
 */
export interface UnattributedMerge {
  /** The story-id named in the commit subject. */
  storyId: string;
  /** The merge/commit SHA on main. */
  mergeCommit: string;
  /** Commit timestamp (epoch seconds), for ordering diagnostics. */
  mergedAt: number;
}

/**
 * Surface subject-only story-bearing merges that carry no PR link (FIX-1266).
 *
 * A commit whose subject names a story-id but has no `(#N)` PR reference is a
 * subject-only mention — it does NOT produce a delivery record (see
 * {@link rebuildDeliveriesFromFacts}). This helper exposes those commits as
 * diagnostic / unattributed truth so a genuinely manual direct-to-main
 * delivery is visible rather than silently dropped.
 *
 * Meta-only (`.roll`) commits (`touchesProductCode === false`, FIX-1208) are
 * excluded — those are card-creation / docs noise, not candidate deliveries.
 *
 * **Repair path** for a genuine manual delivery: record a run/ledger fact for
 * the story (a run row carrying the merge commit SHA, or a reconcile ledger
 * entry). The run-correlation path in the projection then promotes it to
 * `done` — a subject mention alone never does.
 */
export function unattributedSubjectOnlyMerges(merges: MergeFact[]): UnattributedMerge[] {
  const out: UnattributedMerge[] = [];
  const seen = new Set<string>();
  for (const m of merges) {
    if (mergeProvenance(m) !== "subject_only") continue;
    if (m.touchesProductCode === false) continue;
    if (m.nonDelivery === true) continue; // FIX-1270: docs/chore ≠ candidate delivery
    for (const sid of m.storyIds) {
      const key = `${sid}\t${m.mergeCommit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ storyId: sid, mergeCommit: m.mergeCommit, mergedAt: m.mergedAt });
    }
  }
  return out;
}

function terminalOutcomeFromRun(outcome: string): HistoricalTerminalOutcome | undefined {
  if (outcome === "ci_red_after_merge") return outcome;
  if (outcome === "published_pending_merge") return outcome;
  if (outcome === "delivered") return outcome;
  if (outcome === "failed") return outcome;
  if (outcome === "blocked") return outcome;
  if (outcome === "aborted_no_delivery") return outcome;
  if (outcome === "gave_up") return outcome;
  if (outcome === "agent_internal_failure") return outcome;
  if (outcome === "handoff_without_tcr") return outcome;
  if (outcome === "orphan_timeout") return outcome;
  if (outcome === "idle_no_work") return outcome;
  if (outcome === "aborted_with_delivery") return outcome;
  if (outcome === "unpublished") return outcome;
  if (outcome === "needs_review") return outcome;
  if (outcome === "dormant_entered") return outcome;
  if (outcome === "unknown") return outcome;
  return undefined;
}

function isDeliveryGateBlockingOutcome(outcome: string): outcome is "ci_red_after_merge" {
  return outcome === "ci_red_after_merge";
}

function failureClassFromRow(row: RunRow): FailureClass | undefined {
  const value = row["failure_class"];
  return value === "env" || value === "harness" || value === "card" || value === "unknown"
    ? value
    : undefined;
}

/**
 * Canonical Roll story-id pattern (mirrors `STORY_ID_PATTERN` in the CLI).
 * Matches `US-…`, `FIX-…`, `REFACTOR-…`, `IDEA-…` ids with an optional
 * single trailing lowercase letter (the shorthand-suffix form, e.g. `FIX-389a`).
 */
const STORY_ID_RE = /\b(?:US|FIX|REFACTOR|IDEA)(?:-[A-Z0-9]+)*-\d+[a-z]?\b/g;

/**
 * Conventional-commit types that denote a NON-delivery change (FIX-1270):
 * `docs:` / `chore:`, with an optional scope (`docs(loop):`) and optional
 * breaking-change `!` (`chore!:`). Case-insensitive.
 *
 * These commits (CHANGELOG sweeps, housekeeping) may list many card-ids in the
 * subject, but those are mentions — not deliveries. See {@link MergeFact.nonDelivery}.
 */
const NON_DELIVERY_SUBJECT_RE = /^(?:docs|chore)(?:\([^)]*\))?!?:/i;

/**
 * `true` when a commit subject is a `docs:`/`chore:` conventional-commit type
 * (FIX-1270). Such a subject must not drive subject-based delivery attribution.
 *
 * Detection is on the subject line only, matching Roll's squash-merge flow
 * where the PR title (with its type prefix) becomes the commit subject. A
 * GitHub merge-button commit (`Merge pull request #N …`) carries the title in
 * its body and is intentionally not matched here — Roll merges with `--squash`.
 */
export function isNonDeliverySubject(subject: string): boolean {
  return NON_DELIVERY_SUBJECT_RE.test(subject.trim());
}

/**
 * Extract story-ids from a merge-commit subject, expanding `/`-joined
 * shorthand suffixes (FIX-904).
 *
 * A match that ends in a single lowercase letter (e.g. `FIX-389a`) followed
 * immediately by a `/<single-letter>` sequence (`FIX-389a/b/c`) expands to
 * `FIX-389a`, `FIX-389b`, `FIX-389c` — all sharing the numeric base.
 *
 * @returns De-duplicated story-ids in first-seen order. `[]` when none match.
 */
export function parseStoryIdsFromSubject(subject: string): string[] {
  const ids: string[] = [];
  const add = (id: string): void => {
    if (!ids.includes(id)) ids.push(id);
  };

  STORY_ID_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STORY_ID_RE.exec(subject)) !== null) {
    const id = match[0];
    add(id);

    // Shorthand expansion: only when the id carries a single-letter suffix.
    // e.g. id = "FIX-389a" → base = "FIX-389", then consume "/b/c" → 389b, 389c.
    const suffixMatch = /^(.*-\d+)([a-z])$/.exec(id);
    if (suffixMatch === null) continue;
    const base = suffixMatch[1]!;

    // Consume a run of "/<single-letter>" immediately after the match.
    let cursor = STORY_ID_RE.lastIndex;
    const shorthand = /^\/([a-z])(?![a-z0-9])/;
    for (;;) {
      const rest = subject.slice(cursor);
      const sh = shorthand.exec(rest);
      if (sh === null) break;
      add(`${base}${sh[1]}`);
      cursor += sh[0].length;
    }
    // Advance the outer scan past what we consumed so the letters don't
    // re-match (they wouldn't anyway — bare "b" isn't a story-id — but keep
    // the cursor honest).
    STORY_ID_RE.lastIndex = cursor;
  }

  return ids;
}

// ── Fact extractors ──────────────────────────────────────────────────────────

/**
 * Extract a {@link RunFact} from a lenient runs.jsonl row.
 *
 * Reads `story_id`/`routed_story`, `cycle_id`, `status`, `outcome`,
 * `pr_number`, `merge_commit`, `merged_at`, and `ts`. Returns `null` when
 * the row lacks a story+cycle identity.
 */
export function extractRunFact(row: RunRow): RunFact | null {
  const storyId = (row["story_id"] ?? row["routed_story"] ?? row["storyId"]) as string | undefined;
  const cycleId = (row["cycle_id"] ?? row["cycleId"]) as string | undefined;
  if (typeof storyId !== "string" || storyId.trim() === "") return null;
  if (typeof cycleId !== "string" || cycleId.trim() === "") return null;

  const prNum = row["pr_number"] ?? row["prNumber"];
  const mergeCommit = row["merge_commit"] ?? row["mergeCommit"];

  // mergedAt: number (epoch ms) or ISO string (from older backfill stamps)
  const mergedAtRaw = row["merged_at"] ?? row["mergedAt"];
  let mergedAt: number | undefined;
  if (typeof mergedAtRaw === "number" && Number.isFinite(mergedAtRaw)) {
    mergedAt = mergedAtRaw;
  } else if (typeof mergedAtRaw === "string") {
    const ms = Date.parse(mergedAtRaw);
    if (Number.isFinite(ms)) mergedAt = ms;
  }

  const ts = row["ts"] ?? row["recordedAt"];
  let recordedAt = 0;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) recordedAt = ms;
  } else if (typeof ts === "number" && Number.isFinite(ts)) {
    recordedAt = ts;
  }

  return {
    storyId: storyId.trim(),
    cycleId: cycleId.trim(),
    status: typeof row["status"] === "string" ? row["status"] : "",
    outcome: typeof row["outcome"] === "string" ? row["outcome"] : "",
    prNumber: typeof prNum === "number" ? prNum : undefined,
    mergeCommit: typeof mergeCommit === "string" && mergeCommit !== "" ? mergeCommit : undefined,
    mergedAt,
    recordedAt,
    failureClass: failureClassFromRow(row),
    rootCauseKey: typeof row["root_cause_key"] === "string" ? row["root_cause_key"] : undefined,
  };
}

const GIT_RECORD_SEPARATOR = "\x1e";
const GIT_FIELD_SEPARATOR = "\x1f";
const FULL_GIT_LOG_FORMAT = "%x1e%H%x1f%ct%x1f%B";

function mergeFactFromCommitMessage(
  sha: string,
  tsStr: string,
  message: string,
): MergeFact | null {
  const mergedAt = Number(tsStr);
  if (!Number.isFinite(mergedAt) || mergedAt <= 0) return null;

  const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";

  // Determine story-ids FIRST — needed to gate the body-PR search.
  // FIX-923 + FIX-1024: parse story-ids scope depends on commit format.
  //   - merge-button ("Merge pull request #N"): body carries PR title → full message
  //   - squash ("(#N)" in subject):     body is narrative/changelog → subject only
  //   - other:                          subject only
  const mergeMatch = /^Merge pull request #(\d+)/i.exec(subject);
  const isMergeButton = mergeMatch !== null;
  const parseSource = isMergeButton ? message : subject;
  const storyIds = parseStoryIdsFromSubject(parseSource);

  // "Merge pull request #N …"
  let prNum: number | undefined;
  if (mergeMatch) {
    prNum = Number(mergeMatch[1]);
  } else {
    // Squash-merge "(#N)" in the subject. FIX-1457: GitHub appends the PR
    // number as the LAST "(#N)"; any earlier "(#N)" is a manual reference
    // (e.g. a "Closes #issue" echoed into the PR title). Take the last match
    // so an embedded issue number is never mistaken for the PR identity.
    const lastSquashMatch = [...subject.matchAll(/\(#(\d+)\)/g)].at(-1);
    if (lastSquashMatch) {
      prNum = Number(lastSquashMatch[1]);
    } else if (storyIds.length > 0) {
      // FIX-1046: when the subject names a story-id but lacks a (#N) PR
      // reference, search the body for (#N). A squash-merge that carries the
      // PR number only in the narrative body is common. Only do this when the
      // commit is already recognized as story-bearing (has story-ids), so a
      // random body (#N) reference on a non-story commit is not mistaken for
      // PR identity.
      const bodyMatch = /\(#(\d+)\)/.exec(message);
      if (bodyMatch) prNum = Number(bodyMatch[1]);
    }
  }

  if (prNum !== undefined && (!Number.isFinite(prNum) || prNum <= 0)) return null;
  if (prNum === undefined && storyIds.length === 0) return null;

  // FIX-1270: flag `docs:`/`chore:` subjects so subject-based attribution can
  // skip them (a CHANGELOG sweep mentions cards it did not deliver).
  const fact: MergeFact = { prNumber: prNum ?? 0, mergeCommit: sha, mergedAt, storyIds };
  if (isNonDeliverySubject(subject)) fact.nonDelivery = true;
  return fact;
}

/**
 * Parse `git log --format='%x1e%H%x1f%ct%x1f%B'` output into {@link MergeFact}
 * array. The record/field separators make commit bodies with newlines safe.
 *
 * Last match per prNumber wins (git log is reverse-chronological, so the
 * first occurrence is newest).
 */
export function parseMergeCommitLog(text: string): MergeFact[] {
  if (!text.includes(GIT_FIELD_SEPARATOR)) {
    return parseLegacyMergeCommitLines(text.split("\n"));
  }

  const map = new Map<string, MergeFact>();

  for (const rawRecord of text.split(GIT_RECORD_SEPARATOR)) {
    const record = rawRecord.trim();
    if (record === "") continue;

    const firstSep = record.indexOf(GIT_FIELD_SEPARATOR);
    if (firstSep < 0) continue;
    const secondSep = record.indexOf(GIT_FIELD_SEPARATOR, firstSep + 1);
    if (secondSep < 0) continue;

    const sha = record.slice(0, firstSep);
    const tsStr = record.slice(firstSep + 1, secondSep);
    const message = record.slice(secondSep + 1);

    const fact = mergeFactFromCommitMessage(sha, tsStr, message);
    if (fact === null) continue;

    // First occurrence wins (reverse-chronological input). Real PR merges are
    // unique by PR number; story-only commits have prNumber=0, so they must be
    // keyed by commit SHA or every later no-PR story merge disappears.
    const key = fact.prNumber > 0 ? `pr:${fact.prNumber}` : `sha:${fact.mergeCommit}`;
    if (!map.has(key)) {
      map.set(key, fact);
    }
  }

  return [...map.values()];
}

function parseLegacyMergeCommitLines(lines: string[]): MergeFact[] {
  const records = lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return "";

      // Format: "<sha> <epoch_sec> <subject>"
      const firstSpace = trimmed.indexOf(" ");
      if (firstSpace < 0) return "";
      const secondSpace = trimmed.indexOf(" ", firstSpace + 1);
      if (secondSpace < 0) return "";

      const sha = trimmed.slice(0, firstSpace);
      const tsStr = trimmed.slice(firstSpace + 1, secondSpace);
      const subject = trimmed.slice(secondSpace + 1);
      return `${GIT_RECORD_SEPARATOR}${sha}${GIT_FIELD_SEPARATOR}${tsStr}${GIT_FIELD_SEPARATOR}${subject}`;
    })
    .join("");
  if (records === "") return [];
  return parseMergeCommitLog(records);
}

/**
 * Parse legacy `git log --first-parent --merges --format='%H %ct %s'` output
 * into {@link MergeFact} array.
 *
 * Recognises commit subjects:
 *   - "Merge pull request #N from …" (GitHub merge button)
 *   - Any subject with "(#N)" (squash-merge)
 */
export function parseMergeCommitMessages(lines: string[]): MergeFact[] {
  return parseLegacyMergeCommitLines(lines);
}

// ── Projection core ──────────────────────────────────────────────────────────

/**
 * Pure, deterministic projection: runs + git merges → DeliveryRecord[].
 *
 * Rules (AC1, AC4, AC7):
 *   - Per story, latest run wins.
 *   - If ANY run's PR is merged on main → lifecycleState: "done".
 *   - Else if latest run has outcome "published_pending_merge" → "pending_merge".
 *   - Else if latest run has terminal outcome → that lifecycleState.
 *   - Otherwise → no record emitted (= todo).
 *
 * @param runs - RunFact[] extracted from runs.jsonl.
 * @param merges - MergeFact[] from git log on main.
 * @param repoSlug - Optional "owner/repo" for constructing prUrl.
 * @returns Deterministic DeliveryRecord[] — one per delivered/in-flight story.
 */
export function rebuildDeliveriesFromFacts(
  runs: RunFact[],
  merges: MergeFact[],
  repoSlug?: string,
): DeliveryRecord[] {
  // Index merges by prNumber AND by mergeCommit SHA for cross-reference
  const mergeByPr = new Map<number, MergeFact>();
  const mergeBySha = new Map<string, MergeFact>();
  // FIX-1206: index merges by story-id parsed from the commit subject — the
  // authoritative `done` signal that does NOT depend on any loop run having
  // recorded a PR number (manual salvage, PR-lane direct merge, …).
  // Last occurrence wins: input is reverse-chronological (newest first), so
  // the oldest merge that names a story wins. This prevents a later
  // changelog/docs-only PR from overriding the original code-change PR's
  // delivery attribution (FIX-1206).
  //
  // FIX-1208: subject-based attribution is further gated on the commit
  // touching product code (any path outside `.roll/`). In-repo `.roll`
  // projects can have card-creation / docs-only commits whose subject
  // mentions a story-id; those commits only touch meta paths and must not be
  // treated as deliveries. `touchesProductCode !== false` preserves backwards
  // compatibility for MergeFacts that omit the field.
  //
  // FIX-1266 (GitHub #1034): subject-based attribution ALSO requires a PR
  // link. A merge whose subject merely names a story but carries no PR
  // reference (`mergeProvenance === "subject_only"`, prNumber === 0) is a
  // subject-only mention — a direct-to-main commit or `tcr:` micro-commit
  // whose message happens to mention a card. It can corroborate run/ledger
  // evidence (the run loop below still finds the merge by SHA/PR) but must NOT
  // by itself create `done`, otherwise a card that was only mentioned — not
  // delivered — disappears from the picker. This closes the product-code
  // subject-only path that FIX-1208 left open (it only excluded `.roll`-only
  // commits). Genuinely manual direct-main deliveries take the documented
  // repair path (record a run/ledger fact) — see unattributedSubjectOnlyMerges.
  //
  // FIX-1270: a `docs:`/`chore:` subject (`nonDelivery === true`) is excluded
  // too. A CHANGELOG sweep is PR-linked and touches product code (CHANGELOG.md
  // is outside `.roll/`), so neither the subject_only nor the touchesProductCode
  // gate catches it; its subject merely *mentions* cards delivered elsewhere.
  // The run/PR-correlation path below is untouched, so a genuine doc-update
  // *story* (delivered by a loop cycle that recorded its PR) still attributes
  // through its run — only the subject-mention fallback is denied.
  const mergeByStoryId = new Map<string, MergeFact>();
  for (const m of merges) {
    mergeByPr.set(m.prNumber, m);
    mergeBySha.set(m.mergeCommit, m);
    if (m.touchesProductCode === false) continue;
    if (mergeProvenance(m) === "subject_only") continue;
    if (m.nonDelivery === true) continue;
    for (const sid of m.storyIds) {
      mergeByStoryId.set(sid, m); // overwrite: oldest wins (reverse-chrono input)
    }
  }

  // Group runs by storyId
  const byStory = new Map<string, RunFact[]>();
  for (const r of runs) {
    const existing = byStory.get(r.storyId);
    if (existing) {
      existing.push(r);
    } else {
      byStory.set(r.storyId, [r]);
    }
  }

  const result: DeliveryRecord[] = [];

  for (const [storyId, storyRuns] of byStory) {
    // Sort by recordedAt descending — latest first
    storyRuns.sort((a, b) => b.recordedAt - a.recordedAt);
    const latest = storyRuns[0]!;

    // 1. Check if this story has a merged PR — the authoritative done signal.
    let mergedFact: MergeFact | undefined;
    let mergedPrNumber: number | undefined;
    for (const r of storyRuns) {
      // If the run already has merge data (from backfill), treat as merged
      if (r.mergeCommit !== undefined) {
        // Try to find prNumber: from run first, then git SHA lookup
        if (r.prNumber !== undefined) {
          mergedPrNumber = r.prNumber;
        } else {
          const shaMatch = mergeBySha.get(r.mergeCommit);
          if (shaMatch) mergedPrNumber = shaMatch.prNumber;
        }
        mergedFact = {
          prNumber: mergedPrNumber ?? 0,
          mergeCommit: r.mergeCommit,
          mergedAt: r.mergedAt !== undefined ? Math.floor(r.mergedAt / 1000) : 0,
          storyIds: [],
        };
        break;
      }
      // Or if the run's PR number matches a git merge
      if (r.prNumber !== undefined) {
        const m = mergeByPr.get(r.prNumber);
        if (m) {
          mergedPrNumber = r.prNumber;
          mergedFact = m;
          break;
        }
      }
    }

    // FIX-904: authoritative git-subject signal. If NO run-based merge was
    // found above (no PR number recorded, no backfill stamp), fall back to a
    // merge commit whose subject names this story-id. A merge here beats any
    // failed/in-flight run — the story demonstrably shipped on main.
    if (mergedFact === undefined) {
      const m = mergeByStoryId.get(storyId);
      if (m !== undefined) {
        mergedPrNumber = m.prNumber > 0 ? m.prNumber : undefined;
        mergedFact = m;
      }
    }

    // Done when: (a) merge evidence exists AND (b) either we have a prNumber or
    // we at least have a mergeCommit (done-without-PR is legal for backfilled history).
    // Delivery-gate outcomes are the explicit exception: they preserve the
    // structural block even when merge facts are present, so rebuild cannot turn
    // "main CI red after merge" back into a false done.
    if (mergedFact !== undefined &&
        (mergedFact.prNumber > 0 || mergedFact.mergeCommit !== "")) {
      const fact: MergeFact = mergedFact; // narrow for strict TS
      const effectivePr = fact.prNumber > 0 ? fact.prNumber : mergedPrNumber;
      const prUrl = effectivePr !== undefined && effectivePr > 0 && repoSlug !== undefined
        ? `https://github.com/${repoSlug}/pull/${effectivePr}`
        : undefined;
      const terminalOutcome = terminalOutcomeFromRun(latest.outcome);
      const lifecycleState = isDeliveryGateBlockingOutcome(latest.outcome) && terminalOutcome !== undefined
        ? lifecycleFromFacts(terminalOutcome, "merged")
        : "done";
      result.push({
        storyId,
        cycleId: latest.cycleId,
        lifecycleState,
        prNumber: effectivePr !== undefined && effectivePr > 0
          ? present(effectivePr)
          : absent("no_publish_attempted"),
        prUrl: prUrl !== undefined ? present(prUrl) : absent("not_recorded"),
        mergedAt: fact.mergedAt > 0
          ? present(fact.mergedAt * 1000)
          : absent("not_recorded"),
        mergeCommit: present(fact.mergeCommit),
        recordedAt: fact.mergedAt > 0 ? fact.mergedAt * 1000 : latest.recordedAt,
      });
      continue;
    }

    // 2. Not merged — derive lifecycle from the latest run's terminal outcome.
    const outcome = latest.outcome;
    let lifecycle: DeliveryRecord["lifecycleState"];

    if (outcome === "published_pending_merge") {
      lifecycle = "pending_merge";
    } else if (outcome === "ci_red_after_merge") {
      lifecycle = "ci_red";
    } else if (outcome === "failed") {
      lifecycle = "failed";
    } else if (outcome === "blocked") {
      lifecycle = "blocked";
    } else if (outcome === "delivered") {
      // delivered without merge evidence is unusual but possible (e.g. pre-PR era)
      lifecycle = "done";
    } else if (outcome === "aborted_no_delivery" || outcome === "gave_up") {
      lifecycle = "failed";
    } else if (outcome === "aborted_with_delivery") {
      lifecycle = "pending_merge";
    } else if (outcome === "orphan_timeout") {
      lifecycle = "blocked";
    } else if (outcome === "idle_no_work") {
      // idle = nothing happened, no record emitted
      continue;
    } else {
      // unknown / unrecognised outcome → skip (no record)
      continue;
    }

    const hasPr = latest.prNumber !== undefined;
    const prUrl = hasPr && repoSlug !== undefined
      ? `https://github.com/${repoSlug}/pull/${latest.prNumber}`
      : undefined;

    result.push({
      storyId,
      cycleId: latest.cycleId,
      lifecycleState: lifecycle,
      prNumber: hasPr ? present(latest.prNumber!) : absent("no_publish_attempted"),
      prUrl: prUrl !== undefined ? present(prUrl) : absent("not_recorded"),
      mergedAt: absent("not_recorded"),
      mergeCommit: absent("not_recorded"),
      recordedAt: latest.recordedAt,
    });
  }

  // FIX-904: emit `done` for stories that appear ONLY in merge subjects and
  // have no run at all (manual salvage / external merge with no loop run).
  // Sentinel cycleId `merge:<sha7>` marks the absence of a run cycle.
  for (const [storyId, fact] of mergeByStoryId) {
    if (byStory.has(storyId)) continue; // already handled by the run loop
    const effectivePr = fact.prNumber > 0 ? fact.prNumber : undefined;
    const prUrl = effectivePr !== undefined && repoSlug !== undefined
      ? `https://github.com/${repoSlug}/pull/${effectivePr}`
      : undefined;
    result.push({
      storyId,
      cycleId: `merge:${fact.mergeCommit.slice(0, 7)}`,
      lifecycleState: "done",
      prNumber: effectivePr !== undefined
        ? present(effectivePr)
        : absent("no_publish_attempted"),
      prUrl: prUrl !== undefined ? present(prUrl) : absent("not_recorded"),
      mergedAt: fact.mergedAt > 0 ? present(fact.mergedAt * 1000) : absent("not_recorded"),
      mergeCommit: present(fact.mergeCommit),
      recordedAt: fact.mergedAt > 0 ? fact.mergedAt * 1000 : 0,
    });
  }

  return result;
}

// ── Collection helpers (orchestration utilities) ─────────────────────────────

/**
 * Parse runs.jsonl raw text into {@link RunFact} array.
 *
 * Each line is JSON-parsed and passed to {@link extractRunFact}.
 * Bad JSON / unparseable lines and rows without story+cycle identity
 * are silently skipped.
 */
export function collectRunFacts(runsJsonlText: string): RunFact[] {
  const facts: RunFact[] = [];
  for (const line of runsJsonlText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // skip bad JSON silently
    }
    if (row === null || typeof row !== "object") continue;
    const fact = extractRunFact(row as RunRow);
    if (fact !== null) facts.push(fact);
  }
  return facts;
}

// ── Product-code gate for in-repo .roll projects (FIX-1208) ─────────────────

/**
 * Return `true` when the commit at `sha` touches at least one path outside
 * `.roll/` (i.e. genuine product code), `false` when it only touches `.roll/`
 * meta paths.
 *
 * Card-creation / docs-only commits in in-repo `.roll` projects can mention a
 * story-id in their subject. Without this gate, the subject-only `done`
 * attribution in `rebuildDeliveriesFromFacts` would falsely mark those cards
 * as delivered. Commits that only touch meta paths are therefore excluded from
 * story-id attribution.
 *
 * Fail-open: if `git diff-tree` fails or returns nothing, assume the commit
 * touches product code. Losing a real delivery is worse than keeping a
 * card-creation false positive, and the diff-tree call failing is itself a
 * signal we should not silently drop evidence.
 */
function commitTouchesProductCode(
  projectRoot: string,
  sha: string,
  exec: ExecPort,
): boolean {
  const result = exec.run("git", [
    "-C", projectRoot,
    "diff-tree", "--no-commit-id", "--name-only", "-r", sha,
  ]);
  if (result.code !== 0) return true;
  const paths = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (paths.length === 0) return true;
  return paths.some((path) => !path.startsWith(".roll/"));
}

// ── Freshness gate + rebuild orchestration ───────────────────────────────────

/**
 * Minimal port for mtime + read/write of the two JSONL files.
 *
 * Separated from {@link DeliveryStoreInterface} because the freshness gate
 * needs overwrite semantics (rebuild replaces the cache file) while the
 * store's append-only contract intentionally does not have a delete/truncate
 * method — rebuilding is the ONE sanctioned overwrite path.
 */
export interface FreshnessPort {
  /**
   * Return the file's mtime in epoch milliseconds, or `undefined` when the
   * file does not exist or the stat fails.
   */
  mtimeMs(absPath: string): number | undefined;
  /**
   * Read the full file as UTF-8 text.
   *
   * @returns The file content, or `""` when the file does not exist.
   */
  readText(absPath: string): string;
  /**
   * Overwrite (truncate + write) the full file with `text`.
   *
   * Creates parent directories and the file itself as needed.
   */
  writeText(absPath: string, text: string): void;
}

/**
 * Sidecar filename (next to `deliveries.jsonl`) holding the `origin/main` SHA
 * the cache was last rebuilt from (FIX-905).
 *
 * Kept as a separate, single-line file so the deliveries.jsonl parser never
 * has to skip a meta row — its line-by-line JSON contract is untouched.
 */
const DELIVERIES_HEAD_FILE = "deliveries.head";

/** Absolute path to the `deliveries.head` sidecar for a project root. */
function deliveriesHeadPath(projectRoot: string): string {
  return join(projectRoot, ".roll", "loop", DELIVERIES_HEAD_FILE);
}

/**
 * Resolve the authoritative `main` ref + its current SHA (FIX-905).
 *
 * The authoritative main is the **remote** `origin/main` — the PR lane merges
 * there, and a loop cycle's preflight fetches origin/main and resets its
 * worktree to it, but **never updates the local `main` branch ref**. Reading
 * local `main` therefore lags behind and makes rebuild miss cards that just
 * merged on origin/main (the FIX-905 false-`failed` / re-pick bug).
 *
 * Resolution order:
 *   1. `git rev-parse --verify origin/main` — preferred. Returns `origin/main`
 *      + the SHA so the caller can gate on remote-head changes.
 *   2. fallback `git rev-parse --verify main` — offline / no-remote / fixture.
 *      Returns `main` + (best-effort) its SHA.
 *
 * @returns `{ ref, sha }` — `ref` is always usable in `git log`; `sha` is the
 *   resolved commit (or `undefined` if even the fallback rev-parse failed, in
 *   which case `ref` is still returned so `git log` can try it).
 */
function resolveMainRef(
  projectRoot: string,
  exec: ExecPort,
  integrationBranch: string = DEFAULT_INTEGRATION_BRANCH,
): { ref: string; sha: string | undefined } {
  const originRev = exec.run("git", [
    "-C", projectRoot, "rev-parse", "--verify", "--quiet", integrationBranch,
  ]);
  if (originRev.code === 0 && originRev.stdout !== "") {
    return { ref: integrationBranch, sha: originRev.stdout.trim() };
  }

  // Fallback: the LOCAL branch (offline, no remote, or test fixtures). Derive
  // the local branch name from the integration ref (strip a leading remote).
  const localBranch = localBranchOf(integrationBranch);
  const localRev = exec.run("git", [
    "-C", projectRoot, "rev-parse", "--verify", "--quiet", localBranch,
  ]);
  const sha = localRev.code === 0 && localRev.stdout !== ""
    ? localRev.stdout.trim()
    : undefined;
  return { ref: localBranch, sha };
}

/**
 * E1: the historical hardcoded integration branch. Duplicated from
 * @roll/infra's DEFAULT_INTEGRATION_BRANCH to keep @roll/core free of an
 * @roll/infra dependency; the CLI resolves the config value and passes it in.
 */
const DEFAULT_INTEGRATION_BRANCH = "origin/main";

/** Split an integration ref into `{ remote, branch }` for a `git fetch`, and
 *  the local branch name for the offline fallback. `origin/dev` → remote
 *  `origin`, branch `dev`; a bare `main` → remote `origin`, branch `main`. */
function fetchTargetOf(integrationBranch: string): { remote: string; branch: string } {
  const slash = integrationBranch.indexOf("/");
  if (slash === -1) return { remote: "origin", branch: integrationBranch };
  return { remote: integrationBranch.slice(0, slash), branch: integrationBranch.slice(slash + 1) };
}

/** The local branch name an integration ref maps to (drops the remote prefix). */
function localBranchOf(integrationBranch: string): string {
  return fetchTargetOf(integrationBranch).branch;
}

/**
 * Ensure `deliveries.jsonl` is a fresh projection from runs+git facts.
 *
 * Rebuilds the cache deterministically from the two authoritative sources when
 * it is stale:
 *   1. `runs.jsonl` rows (intent / `pending_merge` truth)
 *   2. `git log --first-parent <main-ref>` (`done` truth)
 *
 * **Authoritative ref (FIX-905)**: `<main-ref>` is `origin/main` whenever it
 * resolves — the remote is where PRs actually merge, and a loop cycle keeps it
 * fresh via preflight fetch while leaving the local `main` branch ref stale.
 * Reading local `main` made rebuild miss just-merged cards (false `failed` →
 * the picker re-selected a card that already shipped). Falls back to local
 * `main` when there is no remote / it is unreachable / in test fixtures.
 *
 * **Staleness gate (AC2 + FIX-905)** — rebuild when ANY of:
 *   - `deliveries.jsonl` is missing, OR
 *   - it is older than `runs.jsonl` (mtime), OR
 *   - the recorded `origin/main` SHA (sidecar `deliveries.head`) differs from
 *     the current `origin/main` SHA. A remote merge does NOT touch runs.jsonl's
 *     mtime, so the mtime gate alone would keep serving a stale cache; the SHA
 *     gate catches that.
 *
 * The caller must provide:
 *   - `projectRoot` — absolute path to the git working tree
 *   - `freshness` — mtime + read/write port (typically `node:fs` wrappers)
 *   - `exec` — for `git fetch`/`rev-parse`/`log` and `git remote`
 *
 * @returns The (possibly rebuilt) DeliveryRecord array.
 */
export function ensureDeliveriesFresh(
  projectRoot: string,
  freshness: FreshnessPort,
  exec: ExecPort,
  integrationBranch: string = DEFAULT_INTEGRATION_BRANCH,
  runtimeRoot?: string,
): DeliveryRecord[] {
  const resolvedRuntimeRoot = runtimeRoot ?? join(projectRoot, ".roll", "loop");
  const runsPath = join(resolvedRuntimeRoot, RUNS_FILE);
  const delPath = runtimeRoot === undefined ? deliveriesPath(projectRoot) : join(resolvedRuntimeRoot, "deliveries.jsonl");
  const headPath = runtimeRoot === undefined ? deliveriesHeadPath(projectRoot) : join(resolvedRuntimeRoot, DELIVERIES_HEAD_FILE);

  // ── 1. Best-effort refresh the remote ref (FIX-905) ──────────────────────
  // Cheap, non-fatal: a failure (offline / no remote / no creds) just leaves
  // the existing integration-branch baseline in place, and resolveMainRef will
  // fall back to the local branch if the remote ref never existed. We do NOT
  // reset the worktree — that is the loop preflight's job; here we only need
  // the ref. E1: the remote+branch are derived from the configured integration
  // branch (default origin/main → the fetch stays `fetch origin main`).
  const { remote: fetchRemote, branch: fetchBranch } = fetchTargetOf(integrationBranch);
  exec.run("git", ["-C", projectRoot, "fetch", fetchRemote, fetchBranch, "--quiet"]);

  // ── 2. Resolve the authoritative main ref + its current SHA ──────────────
  const { ref: mainRef, sha: mainSha } = resolveMainRef(projectRoot, exec, integrationBranch);

  // ── 3. Staleness gate ────────────────────────────────────────────────────
  const runsMtime = freshness.mtimeMs(runsPath) ?? 0;
  const delMtime = freshness.mtimeMs(delPath) ?? 0;
  const recordedSha = freshness.readText(headPath).trim();
  // SHA gate fires only when we have a current SHA AND it disagrees with what
  // the cache was built from. (Unknown current SHA → don't force a rebuild on
  // that account; mtime gate still applies.)
  const shaStale = mainSha !== undefined && recordedSha !== "" && recordedSha !== mainSha;

  if (delMtime > 0 && delMtime >= runsMtime && !shaStale) {
    // Cache is fresh — read and return without rebuild.
    return parseDeliveriesFromText(freshness.readText(delPath));
  }

  // ── 4. Rebuild from facts ───────────────────────────────────────────────
  // 4a. Collect run facts
  const runsText = freshness.readText(runsPath);
  const runs = collectRunFacts(runsText);

  // 4b. Collect git merge facts from the authoritative main ref (`done` truth).
  // `mainRef` is origin/main when it resolves (see resolveMainRef), else local
  // `main`. The worktree may be on a feature branch whose history does not
  // include the merges we need, so we target the ref explicitly.
  //
  // Two passes:
  //   (a) `--merges` for GitHub merge-button commits ("Merge pull request #N")
  //   (b) without `--merges` for squash-merge commits with "(#N)" in subject
  const merges: MergeFact[] = [];
  const seenMergeKeys = new Set<string>();
  const mergeKey = (fact: MergeFact): string =>
    fact.prNumber > 0 ? `pr:${fact.prNumber}` : `sha:${fact.mergeCommit}`;

  // Pass (a): standard merge commits
  const gitLog = exec.run("git", [
    "-C", projectRoot,
    "log", "--first-parent", mainRef, "--merges",
    `--format=${FULL_GIT_LOG_FORMAT}`,
  ]);
  if (gitLog.code === 0 && gitLog.stdout !== "") {
    const parsed = parseMergeCommitLog(gitLog.stdout);
    for (const m of parsed) seenMergeKeys.add(mergeKey(m));
    merges.push(...parsed);
  }

  // Pass (b): squash-merge commits (any commit with "(#N)")
  const squashLog = exec.run("git", [
    "-C", projectRoot,
    "log", "--first-parent", mainRef,
    `--format=${FULL_GIT_LOG_FORMAT}`,
  ]);
  if (squashLog.code === 0 && squashLog.stdout !== "") {
    const parsed = parseMergeCommitLog(squashLog.stdout);
    for (const m of parsed) {
      const key = mergeKey(m);
      if (!seenMergeKeys.has(key)) {
        seenMergeKeys.add(key);
        merges.push(m);
      }
    }
  }

  // 4c. Annotate story-bearing merges with whether they touch product code.
  // FIX-1208: in-repo `.roll` projects may have card-creation / docs-only
  // commits whose subject names a story-id. Those commits only touch `.roll/`
  // paths and must not be treated as deliveries, so we exclude them from
  // subject-based attribution below.
  for (const m of merges) {
    if (m.storyIds.length === 0) continue;
    m.touchesProductCode = commitTouchesProductCode(projectRoot, m.mergeCommit, exec);
  }

  // 4d. Derive repo slug
  let repoSlug: string | undefined;
  const remote = exec.run("git", ["-C", projectRoot, "remote", "get-url", "origin"]);
  if (remote.code === 0 && remote.stdout !== "") {
    repoSlug = ghRepoSlugFromUrl(remote.stdout);
  }

  // 4e. Project
  const records = rebuildDeliveriesFromFacts(runs, merges, repoSlug);

  // 4f. Persist cache + the SHA it was built from (FIX-905 staleness gate).
  const output = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  freshness.writeText(delPath, output);
  if (mainSha !== undefined) {
    freshness.writeText(headPath, mainSha + "\n");
  }

  return records;
}

/**
 * Inline slug-from-url parser — mirrors `@roll/infra` `ghRepoSlug` but keeps
 * the core rebuild module dependency-free (zero infra imports).
 */
function ghRepoSlugFromUrl(originUrl: string): string | undefined {
  let url = originUrl.trim();
  if (url.startsWith("git@github.com:")) url = url.slice("git@github.com:".length);
  else if (url.startsWith("ssh://git@github.com/")) url = url.slice("ssh://git@github.com/".length);
  else if (url.startsWith("https://github.com/")) url = url.slice("https://github.com/".length);
  else if (url.startsWith("http://github.com/")) url = url.slice("http://github.com/".length);
  else return undefined;
  if (url.endsWith(".git")) url = url.slice(0, -".git".length);
  if (url === "") return undefined;
  return url;
}

/**
 * Parse deliveries.jsonl text into {@link DeliveryRecord}[].
 *
 * Same logic as `readDeliveries` read path (last-wins by story+cycle),
 * but operates on raw text — avoids a round-trip through the store interface
 * when we already have the text from {@link FreshnessPort.readText}.
 */
function parseDeliveriesFromText(text: string): DeliveryRecord[] {
  const map = new Map<string, DeliveryRecord>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const r = parsed as Record<string, unknown>;
    const storyId = r["storyId"];
    const cycleId = r["cycleId"];
    if (typeof storyId !== "string" || typeof cycleId !== "string") continue;
    const key = `${storyId}\t${cycleId}`;
    map.set(key, parsed as DeliveryRecord);
  }
  return [...map.values()];
}
