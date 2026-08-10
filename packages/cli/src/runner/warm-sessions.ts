/**
 * @responsibility Maintains warm agent sessions for the loop.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isWarmSessionEntry, type WarmSessionEntry } from "@roll/core";

/** The warm-session ledger path — under the PERSISTENT `.roll/loop` (repoCwd), NOT
 *  the cycle worktree, so a captured session survives `.roll reset` and the
 *  worktree teardown (same durability as runs.jsonl). */
export function warmSessionsLedgerPath(repoCwd: string): string {
  return join(repoCwd, ".roll", "loop", "warm-sessions.json");
}

/** Read the warm-session ledger (the captured `{storyId, sessionId, ts}` entries).
 *  Tolerant: a missing / unreadable / malformed ledger reads as `[]` — a capture
 *  store miss never resumes (cold fallback) and never fails the cycle. */
export function readWarmSessions(repoCwd: string): WarmSessionEntry[] {
  try {
    const raw = readFileSync(warmSessionsLedgerPath(repoCwd), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWarmSessionEntry);
  } catch {
    return [];
  }
}

/** Append a captured warm-session entry to the ledger (best-effort; a write slip
 *  is logged-and-tolerated, never fatal — the worst case is a cold next card). */
export function appendWarmSession(repoCwd: string, entry: WarmSessionEntry): void {
  const ledger = readWarmSessions(repoCwd);
  ledger.push(entry);
  const p = warmSessionsLedgerPath(repoCwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ledger, null, 2) + "\n");
}

/** Consume (single-use) every ledger entry keyed by `storyId` — remove them so a
 *  resumed session is used AT MOST once. Best-effort write. */
export function consumeWarmSession(repoCwd: string, storyId: string): void {
  const ledger = readWarmSessions(repoCwd).filter((e) => e.storyId !== storyId);
  const p = warmSessionsLedgerPath(repoCwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ledger, null, 2) + "\n");
}
