/**
 * Self-downgrade (US-AGENT-042) — the PURE decision core behind the
 * `roll loop self-downgrade` command and the loop's terminal reconcile.
 *
 * Rebuilds the v2/bash self-downgrade (US-AGENT-008) + chain-depth cap
 * (US-AGENT-009) that were LOST in the v3 TS port — the skill contracts still
 * pointed at dead bash helpers (`_loop_self_downgrade`) that v3's TS `roll`
 * cannot source, so a story judged too big had no working downgrade path
 * (FIX-364's "Done-but-broken" finding).
 *
 * The model: a story too big for one cycle is RE-SPLIT rather than burned — the
 * parent is parked at 🚫 Hold (a grouping row the picker skips, since
 * `classifyStatus !== "todo"`) and its sub-stories enter the backlog as fresh
 * 📋 Todo rows. Each child inherits the parent's ORIGINAL inbound dependencies,
 * NEVER the parked parent — depending on a held parent would deadlock the child
 * forever. A chain that has already auto-split {@link CHAIN_DEPTH_CAP} times is
 * REFUSED a further split (held + ALERT for human triage) so the loop can never
 * recurse into an infinite split chain.
 *
 * Purity: everything here is (string/number/events in → plan/transform out). The
 * command wires the plan to the backlog file, the event stream, and the
 * PR/branch close side-effects.
 */
import { STATUS_MARKER, type RollEvent } from "@roll/spec";
import { appendBacklogRow, markStatusExact } from "../backlog/store.js";

/**
 * A story chain may auto-split at most this many times; the (cap+1)-th attempt
 * is refused (US-AGENT-009). `chain_depth` counts splits in the chain: an
 * original card is 0, its split children are 1, their split children are 2 — and
 * a depth-2 card splitting again (→3) is the refused case.
 */
export const CHAIN_DEPTH_CAP = 2;

const CHAIN_DEPTH_RE = /chain[_-]?depth:\s*(\d+)/i;

/**
 * Read a `chain_depth:N` tag from text — a backlog Description cell or a
 * spec.md "Agent profile" block. Returns 0 when absent or illegal (an original,
 * never-split card). Pure integer parse, no clock/fs.
 */
export function parseChainDepth(text: string): number {
  const m = CHAIN_DEPTH_RE.exec(text);
  if (m === null) return 0;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Why a split was refused. */
export type CapHitReason = "chain-cap" | "irreducible";

/** The pure decision: split the parent, or refuse (cap-hit). */
export type SelfDowngradePlan =
  | {
      kind: "split";
      parentId: string;
      /** The parent's chain depth (children are this + 1). */
      chainDepth: number;
      children: { id: string; dependsOn: string[]; chainDepth: number }[];
    }
  | {
      kind: "cap-hit";
      parentId: string;
      chainDepth: number;
      capReason: CapHitReason;
    };

export interface SelfDowngradeInput {
  parentId: string;
  /** Resolved parent chain depth (caller reads desc tag → spec.md → 0). */
  parentChainDepth: number;
  /** The parent's ORIGINAL inbound deps (parsed from its backlog desc). */
  parentDependsOn: string[];
  /** Candidate sub-story ids (from `$roll-design`). */
  subIds: string[];
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Decide the self-downgrade. The cap is checked FIRST: a parent whose chain has
 * already split {@link CHAIN_DEPTH_CAP} times is refused regardless of how many
 * sub-ids were offered. Otherwise the sub-ids are cleaned (blanks and any
 * self-reference dropped, deduped) and, if fewer than 2 remain, the story is
 * treated as irreducible → the SAME hold + ALERT path (US-AGENT-008 fallback).
 */
export function planSelfDowngrade(input: SelfDowngradeInput): SelfDowngradePlan {
  const depth = input.parentChainDepth;
  if (depth >= CHAIN_DEPTH_CAP) {
    return { kind: "cap-hit", parentId: input.parentId, chainDepth: depth, capReason: "chain-cap" };
  }
  const subs = dedupe(input.subIds.map((s) => s.trim()).filter((s) => s !== "" && s !== input.parentId));
  if (subs.length < 2) {
    return { kind: "cap-hit", parentId: input.parentId, chainDepth: depth, capReason: "irreducible" };
  }
  const childDepth = depth + 1;
  return {
    kind: "split",
    parentId: input.parentId,
    chainDepth: depth,
    children: subs.map((id) => ({ id, dependsOn: input.parentDependsOn, chainDepth: childDepth })),
  };
}

/** A child whose backlog row the command resolved a title + epic for. */
export interface ResolvedChild {
  id: string;
  title: string;
  epic: string;
  dependsOn: string[];
  chainDepth: number;
}

/**
 * Pure backlog transform for a split: flip the parent to 🚫 Hold, then append
 * each resolved child as a 📋 Todo row (carrying its `depends-on` + `chain_depth`
 * tags). For a cap-hit pass `children: []` — only the parent is parked. The
 * caller persists the result under optimistic concurrency.
 */
export function applySelfDowngradeToBacklog(
  content: string,
  parentId: string,
  children: ResolvedChild[],
): string {
  // FIX-1475: exact id — the docstring promises ONLY the parent is parked; a
  // prefix match would also flip a pre-existing `<parentId>-` descendant to Hold.
  let next = markStatusExact(content, parentId, STATUS_MARKER.hold).content;
  for (const c of children) {
    next = appendBacklogRow(next, {
      id: c.id,
      title: c.title,
      epic: c.epic,
      dependsOn: c.dependsOn,
      chainDepth: c.chainDepth,
    }).content;
  }
  return next;
}

/** Build the durable `story:split` audit event for a plan. */
export function buildStorySplitEvent(plan: SelfDowngradePlan, reason: string, ts: number): RollEvent {
  return {
    type: "story:split",
    parentStoryId: plan.parentId,
    childStoryIds: plan.kind === "split" ? plan.children.map((c) => c.id) : [],
    reason,
    chainDepth: plan.chainDepth,
    capped: plan.kind === "cap-hit",
    ts,
  };
}

/**
 * The parent's currently-open PR number from the event stream, or null. A PR is
 * "open" when a `pr:open` for `parentId` has no later `pr:merge` / `pr:close`
 * for the SAME prNumber. The most-recently-opened still-open PR wins. Used to
 * close a downgraded parent's in-flight PR (invariant I3) when a reviewer
 * triggers the downgrade AFTER a partial delivery (US-AGENT-041).
 */
export function openPrForStory(events: readonly RollEvent[], parentId: string): number | null {
  const closed = new Set<number>();
  for (const e of events) {
    if (e.type === "pr:merge" || e.type === "pr:close") closed.add(e.prNumber);
  }
  let open: number | null = null;
  for (const e of events) {
    if (e.type === "pr:open" && e.storyId === parentId && !closed.has(e.prNumber)) open = e.prNumber;
  }
  return open;
}

/**
 * Did THIS story get deliberately parked by a self-downgrade in the given event
 * window? The cycle terminal reads this so it does NOT clobber the authoritative
 * 🚫 Hold (a self-downgrade cycle ends with no commits → "idle", whose normal
 * reconcile would flip the row back to 📋 Todo and re-pick the too-big parent
 * forever). A `story:split` naming `storyId` as parent — split OR capped — means
 * the row is intentionally held.
 */
export function wasSelfDowngraded(events: readonly RollEvent[], storyId: string, sinceTs = 0): boolean {
  return events.some(
    (e) => e.type === "story:split" && e.parentStoryId === storyId && e.ts >= sinceTs,
  );
}
