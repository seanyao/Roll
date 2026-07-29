/**
 * StoryPicker — TS port of the v2 "pick the next workable story" path.
 *
 * v2 oracle (frozen bash, bin/roll):
 *   - `_loop_pick_next_story` (~13129-13166): iterate the type prefixes in the
 *     order FIX → US → REFACTOR; within each prefix, walk the file top-to-bottom
 *     and return the FIRST row that (a) contains the literal `📋 Todo`, (b) whose
 *     id (extracted from the FIRST column only, never the description — FIX-161)
 *     starts with `<prefix>-`, and (c) is eligible.
 *   - `_loop_story_is_eligible` (~13094-13119):
 *       Gate 0: the row's LAST non-empty cell equals exactly `📋 Todo`.
 *       Gate 1: depends-on satisfied (see below).
 *       Gate 2 (FIX-141): no open PR title references the id (token-bounded).
 *   - `_loop_check_depends_on` (~11652-11689): read the row's `depends-on:` tag
 *     (regex `depends-on:[A-Za-z][A-Za-z0-9,-]+`, first occurrence), comma-split
 *     the ids; a dep is satisfied iff its own row exists AND is ✅ Done. No
 *     depends-on tag ⇒ trivially satisfied.
 *
 * manual-only: VERIFIED ABSENT from v2 story picking. `manual-only` in bin/roll
 * only tags roll-meta routing (FIX-172~175), never the loop story pick — neither
 * `_loop_pick_next_story` nor `_loop_story_is_eligible` consults it. So this port
 * implements status + depends-on + open-PR skip ONLY, matching v2 today.
 *
 * Purity: filesystem and `gh` stay out. The open-PR check is an injected
 * predicate; done-ness is computed from the parsed items themselves (mirroring
 * bash, which re-greps the same backlog file for each dep's status).
 */
import { classifyStatus, STATUS_MARKER } from "@roll/spec";
import type { BacklogReason } from "@roll/spec";
import type { BacklogItem } from "./store.js";
import { advisoryRankItems, type PickRankingEntry } from "./pick-ranking.js";

/** Substring the oracle greps for to decide a dependency is satisfied. */
const DONE = STATUS_MARKER.done;

/** Type prefixes in oracle pick priority order. */
const PREFIXES = ["FIX", "US", "REFACTOR"] as const;

/** Injected predicates that keep the picker pure. */
export interface PickOptions {
  /**
   * True iff an open PR already references this story id (re-picking would make
   * a duplicate PR — FIX-141). Optional; defaults to "no open PRs".
   */
  hasOpenPr?: (id: string) => boolean;
  /**
   * True iff this story already has a MERGED delivery in runs.jsonl — its
   * deliverable is on main, so it is Done and must NEVER be re-picked (FIX-323).
   * The picker only reads backlog status text and is blind to delivery truth;
   * a merged card that got reset to 📋 Todo (e.g. a prior cycle gave_up after
   * finding the work already merged) would otherwise be re-picked every cycle,
   * burning cost on a zombie. Optional; defaults to "no merged delivery".
   */
  hasMergedDelivery?: (id: string) => boolean;
  /**
   * True only for the one card explicitly re-armed by supervised recovery.
   * A recovery candidate may retry a merged delivery that failed its Done guard;
   * all other merged cards remain permanently ineligible.
   */
  isRecoveryCandidate?: (id: string) => boolean;
  /**
   * FIX-363 (loop resilience): true iff this story is on the runtime skip-list —
   * it failed K times (a poison pill that, before this, halted the WHOLE loop
   * after 3 consecutive fails via the cron auto-PAUSE). The loop now SKIPS it and
   * keeps delivering OTHER cards, flagging the poison pill for owner attention
   * instead of stopping. Optional; defaults to "skip nothing". Runtime-only
   * (`.roll/loop/skip-cards.json`, gitignored) — it never mutates backlog truth.
   */
  shouldSkip?: (id: string) => boolean;
  /**
   * FIX-1018: true iff this story already has locally-committed work that failed
   * to publish (a prior cycle landed on the `local`/`unpublished` terminal). Re-
   * picking it would re-implement the same work and waste tokens. The runtime
   * pending-publish set is written when a cycle exits unpublished and cleared on
   * delivery. Optional; defaults to "nothing pending".
   */
  hasPendingPublish?: (id: string) => boolean;
  /**
   * IDEA-069: advisory semantic ranking. When present, the picker scans this
   * suggested order first, but every existing eligibility gate still applies.
   */
  ranking?: readonly PickRankingEntry[];
  /**
   * FIX-1211: true when another agent/human has claimed this story (In Progress
   * with an active lease or no lease at all). The picker skips such stories and
   * logs the reason via {@link skipClaimedReason}. Defaults to "not claimed".
   */
  isClaimedByOther?: (id: string) => boolean;
  /**
   * FIX-1211: when {@link isClaimedByOther} returns true, this provides a human-
   * readable reason for the skip (e.g. "claimed by human at 2026-07-04 13:56").
   * Optional; defaults to the story id when absent.
   */
  skipClaimedReason?: (id: string) => string | undefined;
  /**
   * US-DELIV-005 (one-card-one-lease): returns the skip reason when this story
   * is held by an active delivery lease (in_flight / awaiting_merge / ci_red /
   * delivered — see `deliveryLease` in delivery/lease.ts); undefined when the
   * card is free (or `--race` opted in). Default: no leases. Root cause: same-
   * card fan-out burned whole cycles on work only one merge could land.
   */
  deliveryLeaseBlock?: (id: string) => string | undefined;
  /**
   * FIX-1268: true when the host console is locked and physical-surface cards
   * must not be dispatched. The picker skips any story whose spec declares a
   * physical_terminal surface while this is true.
   */
  isScreenLocked?: boolean;
  /**
   * FIX-1268: true iff the story requires a physical surface (e.g. a real
   * Terminal.app screenshot). Used together with {@link isScreenLocked}.
   */
  requiresPhysicalSurface?: (id: string) => boolean;
}

/** First occurrence of a depends-on tag, mirroring the bash regex. */
const DEPENDS_ON_RE = /depends-on:([A-Za-z][A-Za-z0-9,-]+)/;
const STORY_ID_TOKEN_RE = /^(?:US|FIX|REFACTOR|IDEA)(?:-[A-Z0-9]+)*-\d+[a-z]?$/;

/**
 * E2 — first occurrence of a per-story `target-submodule:` tag. A submodule
 * path (the `.gitmodules` declared path) may contain letters, digits, dashes,
 * dots, underscores and slashes (e.g. `dukang-service-online`, `libs/foo`), so
 * the value class is broader than a story id. The value ends at the first
 * character outside that class (whitespace / backtick / end-of-string).
 */
const TARGET_SUBMODULE_RE = /target-submodule:([A-Za-z0-9._/-]+)/;

/** Token-bounded id reference, mirroring bash gate 2 `${id}([^0-9A-Za-z]|$)`. */
export function prTitleReferences(id: string, title: string): boolean {
  let from = 0;
  while (from < title.length) {
    const idx = title.indexOf(id, from);
    if (idx < 0) return false;
    const before = idx === 0 ? "" : title.charAt(idx - 1);
    const after = title.charAt(idx + id.length);
    if ((before === "" || !/[0-9A-Za-z]/.test(before)) && (after === "" || !/[0-9A-Za-z]/.test(after))) {
      return true;
    }
    from = idx + id.length;
  }
  return false;
}

export interface OpenPrReference {
  readonly number?: number;
  readonly title: string;
  readonly headRefName?: string;
  readonly body?: string;
}

export type OpenPrReferenceInput = string | OpenPrReference;

export type HasOpenPr = ((id: string) => boolean) & {
  readonly openPrBlockReason?: (id: string) => string | undefined;
};

function openPrTextValues(ref: OpenPrReferenceInput): string[] {
  if (typeof ref === "string") return [ref];
  return [ref.title, ref.headRefName ?? ""].filter((value) => value !== "");
}

function bodyRollEvidenceReferences(id: string, body: string | undefined): boolean {
  if (body === undefined) return false;
  for (const line of body.split(/\r?\n/)) {
    const match = /^Roll-Evidence:\s+(\S+)(?:\s+.*)?$/.exec(line.trim());
    const storyId = match?.[1];
    if (storyId !== undefined && STORY_ID_TOKEN_RE.test(storyId) && storyId === id) return true;
  }
  return false;
}

function openPrReferencesStory(id: string, ref: OpenPrReferenceInput): boolean {
  if (openPrTextValues(ref).some((value) => prTitleReferences(id, value))) return true;
  if (typeof ref === "string") return false;
  return bodyRollEvidenceReferences(id, ref.body);
}

function openPrReason(ref: OpenPrReferenceInput): string {
  if (typeof ref !== "string" && ref.number !== undefined && Number.isFinite(ref.number)) {
    return `awaiting merge of PR #${ref.number}`;
  }
  return "awaiting merge of open PR";
}

/**
 * Build a `hasOpenPr` predicate from the list of open PR references. The legacy
 * input is a title string; richer callers may include head branch and body so
 * loop-created PRs titled `loop cycle cycle-<id>` are still tied to their card
 * via the Roll-Evidence trailer.
 */
export function buildHasOpenPr(openPrRefs: readonly OpenPrReferenceInput[]): HasOpenPr {
  const hasOpenPr = ((id: string): boolean => openPrRefs.some((ref) => openPrReferencesStory(id, ref))) as HasOpenPr;
  Object.defineProperty(hasOpenPr, "openPrBlockReason", {
    value: (id: string): string | undefined => {
      const ref = openPrRefs.find((candidate) => openPrReferencesStory(id, candidate));
      return ref === undefined ? undefined : openPrReason(ref);
    },
  });
  return hasOpenPr;
}

export function openPrBlockReason(id: string, hasOpenPr: (id: string) => boolean): string | undefined {
  const withReason = hasOpenPr as HasOpenPr;
  const reason = withReason.openPrBlockReason?.(id);
  if (reason !== undefined) return reason;
  return hasOpenPr(id) ? "awaiting merge of open PR" : undefined;
}

/** Parse a row's depends-on ids (first tag only); empty when none. */
export function parseDependsOn(desc: string): string[] {
  const m = DEPENDS_ON_RE.exec(desc);
  if (m === null) return [];
  return (m[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * E2 — parse a row's per-story `target-submodule:` tag (first occurrence only).
 * Returns the declared submodule path, or `undefined` when the row carries no
 * such tag (the overwhelming majority — a non-submodule story routes through the
 * existing superproject path with zero behavioural change). This is METADATA,
 * not an eligibility gate: the picker still selects the story the same way; the
 * runner reads this off the picked story to decide WHERE (which submodule) the
 * worktree + delivery land.
 */
export function parseTargetSubmodule(desc: string): string | undefined {
  const m = TARGET_SUBMODULE_RE.exec(desc);
  const value = m?.[1]?.trim();
  return value !== undefined && value !== "" ? value : undefined;
}

/**
 * Build a done-ness index over the parsed items (bash re-greps the file per
 * dep; here we read the same parsed model). A dep is satisfied iff a row with
 * that id exists and its status contains the ✅ Done marker.
 *
 * Shared by `pickStory` and `assessBacklog` (US-LOOP-079b).
 */
export function buildDoneIndex(items: BacklogItem[]): (id: string) => boolean {
  return (id: string): boolean =>
    items.some((it) => it.id === id && it.status.includes(DONE));
}

/**
 * Eligibility predicate covering all 6 gates (single source of truth).
 *
 * Gates (order):
 *   0. Status classifies as `todo` (FIX-300).
 *   1. Every `depends-on` id resolves to ✅ Done.
 *   2. No open PR references the id (injected, FIX-141).
 *   3. No merged delivery for this id (injected, FIX-323).
 *   4. Not on the runtime skip-list (injected, FIX-363).
 *   5. Not claimed by another agent/human (injected, FIX-1211).
 *   6. Not held by an active delivery lease (injected, US-DELIV-005).
 *
 * Shared by `pickStory` and `assessBacklog` (US-LOOP-079b).
 */
export function isEligible(
  item: BacklogItem,
  isDone: (id: string) => boolean,
  opts: PickOptions = {},
): boolean {
  const hasOpenPr = opts.hasOpenPr ?? (() => false);
  const hasMergedDelivery = opts.hasMergedDelivery ?? (() => false);
  const shouldSkip = opts.shouldSkip ?? (() => false);
  const hasPendingPublish = opts.hasPendingPublish ?? (() => false);
  const isClaimedByOther = opts.isClaimedByOther ?? (() => false);
  const deliveryLeaseBlock = opts.deliveryLeaseBlock ?? (() => undefined);
  const isRecoveryCandidate = opts.isRecoveryCandidate?.(item.id) === true;

  // Recognize the Todo marker via the single-source classifier (FIX-300),
  // not an exact-string equality. An annotated status — the Todo marker
  // followed by parenthetical text (e.g. `📋 Todo (rebased)`) — is still a
  // Todo and must stay pickable; an exact `=== "📋 Todo"` check silently
  // dropped such rows and idled the loop (FIX-301).
  if (classifyStatus(item.status) !== "todo" && !(isRecoveryCandidate && classifyStatus(item.status) === "in_progress")) return false;
  for (const dep of parseDependsOn(item.desc)) {
    if (!isDone(dep)) return false;
  }
  if (hasOpenPr(item.id)) return false;
  // FIX-323: a card whose deliverable already MERGED is Done — never re-pick,
  // even if its backlog status was (wrongly) reset to 📋 Todo. The picker is
  // blind to delivery truth, so this guard is injected from runs.jsonl.
  const mergedDelivery = hasMergedDelivery(item.id);
  if (mergedDelivery && !isRecoveryCandidate) return false;
  // FIX-363: a poison-pill card (failed K times) is on the runtime skip-list —
  // skip it so the loop keeps delivering OTHER cards instead of halting. The
  // card stays Todo in the backlog (truth unchanged); an owner clears the
  // skip-list (or fixes the card) to re-arm it.
  if (shouldSkip(item.id)) return false;
  // FIX-1018: a story with already-committed-but-unpublished work from a prior
  // cycle must not be re-picked; that would re-implement the same work. It stays
  // Todo until the publish blocker clears and the pending marker is removed.
  // FIX-1212: pending-publish only blocks when the card ALSO has an open PR.
  // Without an open PR the marker is stale (prior cycle's unpublished work did not
  // result in a PR) — the card must remain pickable to prevent loop starvation.
  if (hasPendingPublish(item.id) && hasOpenPr(item.id)) return false;
  // FIX-1211: skip stories claimed by another agent/human (In Progress with an
  // active lease or no lease). Log the skip reason for observability.
  if (isClaimedByOther(item.id)) {
    const reason = opts.skipClaimedReason?.(item.id) ?? `claimed by other (${item.id})`;
    // The skip reason is emitted via the callback — the caller provides it
    // when observability is needed (e.g., the cycle orchestrator logs it).
    // The picker itself stays pure; the reason is injected, not written.
    return false;
  }
  // US-DELIV-005: one-card-one-lease — a card held by an active delivery
  // lease (in_flight / awaiting_merge / ci_red / delivered) is skipped; the
  // default kills same-card fan-out. `--race` is the explicit opt-in and is
  // resolved by the caller before wiring this predicate.
  if (deliveryLeaseBlock(item.id) !== undefined && !(isRecoveryCandidate && mergedDelivery)) return false;
  // FIX-1268: while the console is locked, physical-surface cards cannot be
  // dispatched because the attest gate cannot capture real evidence.
  if (opts.isScreenLocked === true && opts.requiresPhysicalSurface?.(item.id) === true) return false;
  return true;
}

/**
 * Pure pick: choose the next workable story from `items` (already in file
 * order), applying the oracle gates. Returns the chosen item or `undefined`.
 *
 * Gates per candidate:
 *   - status classifies as `todo` (FIX-300 classifier) — tolerant of an
 *     annotated marker, e.g. `📋 Todo (rebased)` (FIX-301), not exact-match
 *   - every depends-on id resolves to a row whose status contains `✅ Done`
 *   - no open PR references the id (injected predicate)
 *   - not claimed by another agent/human (injected, FIX-1211)
 * Priority: all FIX first (file order), then US, then REFACTOR.
 */
export function pickStory(items: BacklogItem[], opts: PickOptions = {}): BacklogItem | undefined {
  const isDone = buildDoneIndex(items);
  const isRecoveryCandidate = opts.isRecoveryCandidate ?? (() => false);

  if (opts.ranking !== undefined && opts.ranking.length > 0) {
    for (const it of advisoryRankItems(items, opts.ranking)) {
      if (!/^(FIX|US|REFACTOR)-/.test(it.id)) continue;
      if (isEligible(it, isDone, opts)) return it;
    }
    return undefined;
  }

  for (const prefix of PREFIXES) {
    for (const it of items) {
      if (!it.id.startsWith(`${prefix}-`)) continue;
      if (isEligible(it, isDone, opts)) return it;
    }
  }
  return undefined;
}

/** A single blocked card with the reason it wasn't picked. */
export interface BlockedCard {
  readonly id: string;
  readonly reason: string;
}

/** The assessment result returned by {@link assessBacklog}. */
export interface BacklogAssessment {
  hasWork: boolean;
  reason: BacklogReason;
  /** FIX-1215: card-level blocking detail — which cards are blocked and why.
   *  Present only when `hasWork` is false; empty when no todo rows exist. */
  blockedCards?: readonly BlockedCard[];
}

/**
 * Assess the whole backlog by scanning EVERY row's classified status (a full
 * histogram) — NOT just the eligibility gate. Without the histogram, a backlog
 * where every visible row is 🔨 In Progress is mis-reported as
 * "backlog_empty" (the pi-identified bug that drove this card).
 *
 * Priority (first match wins):
 *   has_work > all_blocked_by_deps > all_awaiting_merge >
 *   all_merged_pending > all_skip_listed > all_pending_publish >
 *   all_leased > all_in_progress > all_done > backlog_empty
 *
 * The `opts` are the same injected predicates {@link pickStory} uses so
 * `assessBacklog(…).hasWork === (pickStory(…) !== undefined)` holds for all
 * inputs (AC5).
 */
export function assessBacklog(
  items: BacklogItem[],
  opts: PickOptions = {},
): BacklogAssessment {
  const isDone = buildDoneIndex(items);
  const isRecoveryCandidate = opts.isRecoveryCandidate ?? (() => false);

  // --- histogram over ALL rows (AC2) ----------------------------------------
  let todoCount = 0;
  let inProgressCount = 0;
  let recoveryInProgressCount = 0;
  let holdCount = 0;
  let doneCount = 0;
  for (const it of items) {
    const cls = classifyStatus(it.status);
    switch (cls) {
      case "todo":
        todoCount++;
        break;
      case "in_progress":
        inProgressCount++;
        if (isRecoveryCandidate(it.id)) recoveryInProgressCount++;
        break;
      case "hold":
        holdCount++;
        break;
      case "done":
        doneCount++;
        break;
      // cut rows are excluded — they are not actionable and don't affect the verdict
    }
  }

  // --- highest priority: any item passes all 5 gates (AC3) ------------------
  let hasBlockedByDeps = false;
  let hasBlockedByPr = false;
  let hasBlockedByMerged = false;
  let hasBlockedBySkip = false;
  let hasBlockedByPendingPublish = false;
  let hasBlockedByLease = false;
  let hasBlockedByScreenLocked = false;

  if (todoCount > 0 || recoveryInProgressCount > 0) {
    const hasOpenPr = opts.hasOpenPr ?? (() => false);
    const hasMergedDelivery = opts.hasMergedDelivery ?? (() => false);
    const shouldSkip = opts.shouldSkip ?? (() => false);
    const hasPendingPublish = opts.hasPendingPublish ?? (() => false);
    const deliveryLeaseBlock = opts.deliveryLeaseBlock ?? (() => undefined);
    const requiresPhysicalSurface = opts.requiresPhysicalSurface ?? (() => false);

    for (const it of items) {
      const status = classifyStatus(it.status);
      const recoveryCandidate = isRecoveryCandidate(it.id);
      if (status !== "todo" && !(recoveryCandidate && status === "in_progress")) continue;
      if (isEligible(it, isDone, opts)) {
        return { hasWork: true, reason: "has_work" };
      }
      // Track which gate(s) blocked this todo item.
      let blockedByDeps = false;
      let blockedByPr = false;
      let blockedByMerged = false;
      let blockedBySkip = false;
      let blockedByPendingPublish = false;
      let blockedByLease = false;

      for (const dep of parseDependsOn(it.desc)) {
        if (!isDone(dep)) {
          blockedByDeps = true;
          break;
        }
      }
      if (!blockedByDeps && hasOpenPr(it.id)) blockedByPr = true;
      const mergedDelivery = hasMergedDelivery(it.id);
      if (!blockedByDeps && !blockedByPr && mergedDelivery && !recoveryCandidate) blockedByMerged = true;
      if (!blockedByDeps && !blockedByPr && !blockedByMerged && shouldSkip(it.id)) blockedBySkip = true;
      // FIX-1212: pending-publish blocks only when card also has an open PR
      // (stale marker without PR does not block — prevents starvation).
      if (
        !blockedByDeps &&
        !blockedByPr &&
        !blockedByMerged &&
        !blockedBySkip &&
        hasPendingPublish(it.id) &&
        hasOpenPr(it.id)
      )
        blockedByPendingPublish = true;
      // US-DELIV-005: an active delivery lease holds the card (one-card-one-lease).
      if (
        !blockedByDeps &&
        !blockedByPr &&
        !blockedByMerged &&
        !blockedBySkip &&
        !blockedByPendingPublish &&
        deliveryLeaseBlock(it.id) !== undefined && !(recoveryCandidate && mergedDelivery)
      )
        blockedByLease = true;
      // FIX-1268: screen-locked physical-surface gate is checked after the durable
      // eligibility gates so a card blocked by lease/PR is attributed to that gate.
      if (
        !blockedByDeps &&
        !blockedByPr &&
        !blockedByMerged &&
        !blockedBySkip &&
        !blockedByPendingPublish &&
        !blockedByLease &&
        opts.isScreenLocked === true &&
        requiresPhysicalSurface(it.id)
      )
        hasBlockedByScreenLocked = true;

      if (blockedByDeps) hasBlockedByDeps = true;
      if (blockedByPr) hasBlockedByPr = true;
      if (blockedByMerged) hasBlockedByMerged = true;
      if (blockedBySkip) hasBlockedBySkip = true;
      if (blockedByPendingPublish) hasBlockedByPendingPublish = true;
      if (blockedByLease) hasBlockedByLease = true;
    }
  }

  // --- FIX-1215: collect blocked-card details for idle output observability ---
  const blockedCards: BlockedCard[] = [];
  if (todoCount > 0 || recoveryInProgressCount > 0) {
    const hasOpenPr = opts.hasOpenPr ?? (() => false);
    const hasMergedDelivery = opts.hasMergedDelivery ?? (() => false);
    const shouldSkip = opts.shouldSkip ?? (() => false);
    const hasPendingPublish = opts.hasPendingPublish ?? (() => false);
    const deliveryLeaseBlock = opts.deliveryLeaseBlock ?? (() => undefined);
    const requiresPhysicalSurface = opts.requiresPhysicalSurface ?? (() => false);

    for (const it of items) {
      const status = classifyStatus(it.status);
      const recoveryCandidate = isRecoveryCandidate(it.id);
      if (status !== "todo" && !(recoveryCandidate && status === "in_progress")) continue;
      // Collect blocking reason per card (mirrors the isEligible gate order).
      let blockedByDeps = false;
      let unmetDeps: string[] = [];
      for (const dep of parseDependsOn(it.desc)) {
        if (!isDone(dep)) {
          blockedByDeps = true;
          unmetDeps.push(dep);
        }
      }
      if (blockedByDeps) {
        blockedCards.push({ id: it.id, reason: `unmet dependency: ${unmetDeps.join(", ")}` });
        hasBlockedByDeps = true;
        continue;
      }
      if (hasOpenPr(it.id)) {
        const prReason = openPrBlockReason(it.id, hasOpenPr) ?? "awaiting merge of open PR";
        blockedCards.push({ id: it.id, reason: prReason });
        hasBlockedByPr = true;
        continue;
      }
      const mergedDelivery = hasMergedDelivery(it.id);
      if (mergedDelivery && !recoveryCandidate) {
        blockedCards.push({ id: it.id, reason: "already merged to main" });
        hasBlockedByMerged = true;
        continue;
      }
      if (shouldSkip(it.id)) {
        blockedCards.push({ id: it.id, reason: "runtime skip-list (poison pill)" });
        hasBlockedBySkip = true;
        continue;
      }
      // FIX-1212: pending-publish blocks only when card also has an open PR.
      // Without an open PR the marker is stale — card remains pickable.
      if (hasPendingPublish(it.id) && hasOpenPr(it.id)) {
        blockedCards.push({ id: it.id, reason: "pending-publish with open PR" });
        hasBlockedByPendingPublish = true;
        continue;
      }
      // US-DELIV-005: one-card-one-lease — the card is held by an active
      // delivery lease (see delivery/lease.ts); the reason names the state.
      const leaseReason = deliveryLeaseBlock(it.id);
      if (leaseReason !== undefined && !(recoveryCandidate && mergedDelivery)) {
        blockedCards.push({ id: it.id, reason: leaseReason });
        hasBlockedByLease = true;
        continue;
      }
      // FIX-1268: screen-locked physical-surface gate.
      if (opts.isScreenLocked === true && requiresPhysicalSurface(it.id)) {
        blockedCards.push({ id: it.id, reason: "screen locked — physical surface unavailable" });
        hasBlockedByScreenLocked = true;
        continue;
      }
    }
  }

  // --- priority chain: first match wins (AC3) -------------------------------
  if (hasBlockedByDeps) return { hasWork: false, reason: "all_blocked_by_deps", blockedCards };
  if (hasBlockedByPr) return { hasWork: false, reason: "all_awaiting_merge", blockedCards };
  if (hasBlockedByMerged) return { hasWork: false, reason: "all_merged_pending", blockedCards };
  if (hasBlockedBySkip) return { hasWork: false, reason: "all_skip_listed", blockedCards };
  if (hasBlockedByPendingPublish) return { hasWork: false, reason: "all_pending_publish", blockedCards };
  if (hasBlockedByLease) return { hasWork: false, reason: "all_leased", blockedCards };
  if (hasBlockedByScreenLocked) return { hasWork: false, reason: "screen_locked", blockedCards };

  if (inProgressCount > 0 || holdCount > 0) {
    return { hasWork: false, reason: "all_in_progress" };
  }

  if (items.length === 0) return { hasWork: false, reason: "backlog_empty" };

  // No todo, no in_progress/hold → everything visible is Done (or cut).
  return { hasWork: false, reason: "all_done" };
}

// ─── US-LOOP-079k: dormancy suppression ──────────────────────────────────────


