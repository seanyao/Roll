/**
 * @responsibility Maintains the runtime poison-pill skip-list.
 */
/**
 * FIX-363 (loop resilience) — the runtime poison-pill skip-list.
 *
 * Before this, the cron loop (`roll loop run-once`) auto-PAUSED the WHOLE loop
 * after 3 consecutive failures. One un-deliverable card therefore halted every
 * other card and forced the owner to intervene every time. This module isolates
 * a poison pill instead: a card that fails K times is recorded here, the picker
 * (`pickStory` `shouldSkip`) skips it, and the loop keeps delivering OTHER cards.
 * The whole-loop PAUSE is reserved for genuinely SYSTEMIC failure (different
 * cards failing in a row), which the per-card isolation lets through unchanged.
 *
 * Runtime-only: `.roll/loop/skip-cards.json` is gitignored (like consecutive-fails
 * / PAUSE markers). It NEVER mutates backlog truth — the card stays `📋 Todo`; the
 * skip is a runtime overlay an owner clears (or that {@link clearCardFailure}
 * drops on a successful delivery) to re-arm the card. So a transient bad night
 * self-heals on the next clean checkout without losing the card.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureClass } from "./failure-attribution.js";

export interface SkipState {
  /** Per-card cumulative failure tally. */
  fails: Record<string, number>;
  /** Card ids the picker must skip (crossed the failure threshold). */
  skip: string[];
}

function skipFile(runtimeDir: string): string {
  return join(runtimeDir, "skip-cards.json");
}

function read(runtimeDir: string): SkipState {
  try {
    const path = skipFile(runtimeDir);
    if (!existsSync(path)) return { fails: {}, skip: [] };
    const o = JSON.parse(readFileSync(path, "utf8")) as Partial<SkipState>;
    return {
      fails: o.fails !== undefined && typeof o.fails === "object" ? o.fails : {},
      skip: Array.isArray(o.skip) ? o.skip.filter((s): s is string => typeof s === "string") : [],
    };
  } catch {
    return { fails: {}, skip: [] };
  }
}

export function readSkipState(runtimeDir: string): SkipState {
  return read(runtimeDir);
}

export function writeSkipState(runtimeDir: string, s: SkipState): void {
  write(runtimeDir, s);
}

function write(runtimeDir: string, s: SkipState): void {
  try {
    writeFileSync(skipFile(runtimeDir), JSON.stringify(s, null, 2), "utf8");
  } catch {
    /* best-effort — a write miss just means the poison pill is re-attempted */
  }
}

/** The set of poison-pill card ids the picker should skip this cycle. */
export function readSkipCards(runtimeDir: string): Set<string> {
  return new Set(read(runtimeDir).skip);
}

/**
 * Record a failed cycle for `storyId`. Returns the new cumulative fail count and
 * whether this failure just crossed `threshold` onto the skip-list (the caller
 * then alerts + resets the global consecutive-fail counter so the loop continues
 * on other cards instead of auto-pausing). Empty storyId is a no-op.
 */
export function recordCardFailure(
  runtimeDir: string,
  storyId: string,
  threshold: number,
  failureClass: FailureClass = "card",
): { count: number; nowSkipped: boolean } {
  if (failureClass !== "card") return { count: 0, nowSkipped: false };
  if (storyId === "") return { count: 0, nowSkipped: false };
  const s = read(runtimeDir);
  const count = (s.fails[storyId] ?? 0) + 1;
  s.fails[storyId] = count;
  let nowSkipped = false;
  if (count >= threshold && !s.skip.includes(storyId)) {
    s.skip.push(storyId);
    nowSkipped = true;
  }
  write(runtimeDir, s);
  return { count, nowSkipped };
}

/** Clear a card's failure tally + skip entry — called on its successful delivery
 *  (or when an owner re-arms it). A skip-listed card cannot be re-picked, so in
 *  practice this clears the tally of a card that recovered before being skipped. */
export function clearCardFailure(runtimeDir: string, storyId: string): void {
  if (storyId === "") return;
  const s = read(runtimeDir);
  if (s.fails[storyId] === undefined && !s.skip.includes(storyId)) return;
  delete s.fails[storyId];
  s.skip = s.skip.filter((id) => id !== storyId);
  write(runtimeDir, s);
}
