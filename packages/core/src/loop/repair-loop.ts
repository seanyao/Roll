/**
 * @responsibility Runs the strictly bounded repair loop between evaluate and execute.
 * US-V4-007 — bounded repair loop between evaluate and execute.
 *
 * Shape: evaluate blocking finding → execute repair → evaluate rerun. This loop
 * is STRICTLY bounded so it can never run unbounded or burn tokens re-fixing the
 * same finding forever:
 *   - max rounds;
 *   - repeated finding-signature detection (oscillation guard);
 *   - per-loop cost budget;
 *   - wall-clock timeout.
 * When ANY bound trips while blocking findings remain, the cycle ESCALATES with a
 * structured reason (it never silently keeps looping). This module is the PURE
 * decision; the runner drives execute/evaluate sessions and writes a repair note.
 *
 * NON-GOAL (per spec): no failure-driven automatic agent switching here — that is
 * a Supervisor recommendation or an explicit policy change, not a repair step.
 */

export const DEFAULT_MAX_REPAIR_ROUNDS = 3;

/** Normalize a blocking finding to a stable SIGNATURE so "the same finding again"
 *  is detectable across rounds despite cosmetic wording/whitespace differences. */
export function findingSignature(finding: string): string {
  return finding
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/\b\d+\b/g, "#") // line numbers / counts vary run to run
    .replace(/\s+/g, " ")
    .trim();
}

/** The signature SET for a round's blocking findings (order-independent). */
export function signatureSet(findings: readonly string[]): string[] {
  return [...new Set(findings.map(findingSignature))].sort();
}

export interface RepairBounds {
  readonly maxRounds: number;
  /** Per-loop cost cap (same unit as `spent`); undefined ⇒ no cost bound. */
  readonly budgetCap?: number;
  /** Wall-clock cap in ms; undefined ⇒ no time bound. */
  readonly timeoutMs?: number;
}

export interface RepairState {
  /** Repair rounds already completed (0 before the first repair). */
  readonly round: number;
  /** Signature sets of PRIOR rounds' blocking findings (most recent last). */
  readonly priorSignatures: readonly (readonly string[])[];
  /** Cost spent in the repair loop so far. */
  readonly spent: number;
  /** Wall-clock elapsed in the repair loop so far (ms). */
  readonly elapsedMs: number;
}

export type RepairAction = "done" | "repair" | "escalate";

export interface RepairDecision {
  readonly action: RepairAction;
  readonly reason: string;
  /** The round this decision applies to (the round about to run, for `repair`). */
  readonly round: number;
}

/** Same set of signatures (order-independent) as the immediately prior round. */
function repeatsLastRound(current: readonly string[], prior: readonly (readonly string[])[]): boolean {
  if (prior.length === 0) return false;
  const last = prior[prior.length - 1] as readonly string[];
  if (last.length !== current.length || current.length === 0) return false;
  const a = [...current].sort().join("|");
  const b = [...last].sort().join("|");
  return a === b;
}

/**
 * Decide the next repair action from the current Evaluator blocking findings and
 * the loop state + bounds. PURE + total:
 *   - no blocking findings → `done` (Evaluator is satisfied; proceed to merge);
 *   - blocking findings + a tripped bound → `escalate` (max rounds / repeated
 *     signature / budget / timeout) with a structured reason;
 *   - otherwise → `repair` (run another Builder→Evaluator round).
 */
export function decideRepair(
  currentBlocking: readonly string[],
  state: RepairState,
  bounds: RepairBounds,
): RepairDecision {
  const round = state.round;
  if (currentBlocking.length === 0) {
    return { action: "done", reason: "no blocking findings — evaluator satisfied", round };
  }
  // Bound checks (escalate while blocking findings remain).
  if (round >= bounds.maxRounds) {
    return { action: "escalate", reason: `max repair rounds reached (${bounds.maxRounds})`, round };
  }
  const current = signatureSet(currentBlocking);
  if (repeatsLastRound(current, state.priorSignatures)) {
    return { action: "escalate", reason: "repeated blocking finding signature — repair is oscillating", round };
  }
  if (bounds.budgetCap !== undefined && state.spent >= bounds.budgetCap) {
    return { action: "escalate", reason: `repair budget exhausted (${state.spent} >= ${bounds.budgetCap})`, round };
  }
  if (bounds.timeoutMs !== undefined && state.elapsedMs >= bounds.timeoutMs) {
    return { action: "escalate", reason: `repair loop timed out (${state.elapsedMs}ms >= ${bounds.timeoutMs}ms)`, round };
  }
  return { action: "repair", reason: `repairing ${currentBlocking.length} blocking finding(s)`, round: round + 1 };
}

/** Advance the repair state after a round runs (records the round's signatures,
 *  accrues spend + elapsed). Pure. */
export function advanceRepairState(
  state: RepairState,
  roundBlocking: readonly string[],
  delta: { spent?: number; elapsedMs?: number },
): RepairState {
  return {
    round: state.round + 1,
    priorSignatures: [...state.priorSignatures, signatureSet(roundBlocking)],
    spent: state.spent + (delta.spent ?? 0),
    elapsedMs: state.elapsedMs + (delta.elapsedMs ?? 0),
  };
}

export function initialRepairState(): RepairState {
  return { round: 0, priorSignatures: [], spent: 0, elapsedMs: 0 };
}

// ── repair note (Builder writes findings → changes) ──────────────────────────

export interface RepairNoteEntry {
  readonly finding: string;
  readonly change: string;
}

const RN_HEAD = "# Repair note";

/** Render the Builder's repair note mapping each Evaluator finding to the change
 *  that addressed it. */
export function renderRepairNote(storyId: string, round: number, entries: readonly RepairNoteEntry[]): string {
  const rows = entries.length === 0 ? "- (no findings addressed)\n" : entries.map((e) => `- ${e.finding} → ${e.change}`).join("\n") + "\n";
  return `${RN_HEAD} — ${storyId} (round ${round})\n\n## Findings addressed\n${rows}`;
}

/** Parse a repair note back into entries (fail-closed: null when it does not look
 *  like a repair note). */
export function parseRepairNote(md: string): RepairNoteEntry[] | null {
  if (typeof md !== "string" || md.indexOf(RN_HEAD) < 0) return null;
  const entries: RepairNoteEntry[] = [];
  for (const line of md.split("\n")) {
    const m = /^[-*]\s*(.+?)\s*(?:→|->)\s*(.+)$/.exec(line.trim());
    if (m !== null) entries.push({ finding: (m[1] ?? "").trim(), change: (m[2] ?? "").trim() });
  }
  return entries;
}
