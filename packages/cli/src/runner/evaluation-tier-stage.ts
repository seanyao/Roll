/**
 * US-CYCLE-008 — the capture-stage glue that turns a card's lint-validated
 * `risk_tier` into evaluation DEPTH, kept out of capture-facts-handler.ts so that
 * hot handler stays under its module-size budget (REFACTOR-060). Pure orchestration
 * over the pure {@link resolveEvaluationTier} core:
 *
 *   • {@link resolveCycleEvaluationTier} — read the tier from the card spec and map
 *     it to a fan-out reason. `high` → parallel adversarial panel; `low`/legacy →
 *     the DEFAULT serial single-evaluator path (fanout undefined, byte-unchanged);
 *     a NEW-REGIME card with no valid tier → blocked (fail-loud, AC5).
 *   • {@link emitTierMissingBlock} — the fail-loud alert + event for a missing tier.
 *   • {@link recordEvaluatorPanelRound} — journal the DECLARED tier + ACTUAL panel
 *     composition so a readout can audit "declared vs actual" depth (AC4).
 *
 * There is NO tier override in any of these — the tier is read ONLY from the spec
 * (anti-Goodhart, AC3).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CycleContext } from "@roll/core";
import type { RollEvent } from "@roll/spec";
import { cardArchiveDir } from "../lib/archive.js";
import { resolveEvaluationTier, tierFanoutReason, type EvaluationTier } from "../lib/evaluation-tier.js";
import type { PairFanoutReason } from "./pairing-gate.js";
import { recordSpawnRound } from "./round-journal-emit.js";
import type { Ports } from "./ports.js";

export interface CycleTierInfo {
  /** Declared tier, or undefined for a legacy card (default serial path). */
  tier: EvaluationTier | undefined;
  /** true ⇒ a new-regime card declares no valid tier → fail-loud block. */
  blocked: boolean;
  /** The fan-out reason for the pairing primitive (high → panel), else undefined. */
  fanout: PairFanoutReason | undefined;
}

export const NO_TIER: CycleTierInfo = { tier: undefined, blocked: false, fanout: undefined };

const BLOCKED: CycleTierInfo = { tier: undefined, blocked: true, fanout: undefined };

/**
 * Resolve the evaluation tier for a delivering cycle from the card's
 * LINT-VALIDATED spec.
 *
 * Fail-closed on an UNREADABLE spec (AC5): if the spec file EXISTS but cannot be
 * read, we cannot verify the tier of a real card → BLOCK rather than silently
 * defaulting to the serial path. A spec that is ABSENT (no file) is treated as
 * legacy → default serial: a card can only be new-regime by DECLARING it in spec
 * content (est_min / risk_tier / created ≥ cutover), so no file ⇒ not new-regime,
 * and gating it would wrongly block genuine legacy/pre-contract cards. An
 * unresolvable card archive dir likewise degrades to legacy.
 */
export function resolveCycleEvaluationTier(repoCwd: string, storyId: string): CycleTierInfo {
  if (storyId === "") return NO_TIER;
  let specPath: string;
  try {
    specPath = join(cardArchiveDir(repoCwd, storyId), "spec.md");
  } catch {
    return NO_TIER; // cannot locate the card archive → treat as legacy (default serial)
  }
  let specText: string;
  try {
    specText = readFileSync(specPath, "utf8");
  } catch (e) {
    // Read-first (codex r2): ONLY a truly absent file (ENOENT) is legacy → default
    // serial (a card is new-regime only by DECLARING it in spec content, so no file
    // ⇒ not new-regime). ANY OTHER read failure (EACCES permission-denied, EISDIR,
    // I/O error) means the spec EXISTS but is unreadable → fail-closed BLOCK, never
    // a silent serial pass. existsSync could not distinguish these.
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return NO_TIER;
    return BLOCKED;
  }
  const decision = resolveEvaluationTier(specText, storyId);
  if (decision.kind === "tier") return { tier: decision.tier, blocked: false, fanout: tierFanoutReason(decision.tier) };
  if (decision.kind === "missing") return BLOCKED;
  return NO_TIER; // legacy → default serial
}

export interface TierGateSinks {
  alert: (message: string) => void;
  event: (event: RollEvent) => void;
  now: () => number;
}

/**
 * Capture-stage entry point (AC1/AC3/AC5): resolve the tier for a delivering
 * cycle and, when a new-regime card declares no valid tier, emit the fail-loud
 * block. Returns the {@link CycleTierInfo} the handler threads into the pairing
 * fan-out (`fanout`) and the round-journal. Scoped to real deliveries — a
 * 0-commit idle cycle has nothing to evaluate.
 */
export function applyEvaluationTierGate(
  ports: Ports,
  ctx: CycleContext,
  opts: { commitsAhead: number; cycleId: string; now: () => number },
): CycleTierInfo {
  const storyId = ctx.storyId ?? "";
  const info = opts.commitsAhead > 0 && storyId !== "" ? resolveCycleEvaluationTier(ports.repoCwd, storyId) : NO_TIER;
  if (info.blocked) {
    emitTierMissingBlock(
      { alert: (m) => ports.events.appendAlert(ports.paths.alertsPath, m), event: (e) => ports.events.appendEvent(ports.paths.eventsPath, e), now: opts.now },
      opts.cycleId,
      storyId,
    );
  }
  return info;
}

/** Fail-loud (AC5): a new-regime card with no valid risk_tier BLOCKS the cycle. */
export function emitTierMissingBlock(sinks: TierGateSinks, cycleId: string, storyId: string): void {
  sinks.alert(
    `evaluation tier gate (hard): new-regime card ${storyId} declares no valid risk_tier (low|high) in its lint-validated spec — evaluation depth is unresolved; cycle ${cycleId} BLOCKED (fail-loud, NOT defaulted to low). Add \`risk_tier: low\` or \`risk_tier: high\` to the card frontmatter.`,
  );
  sinks.event({ type: "eval:tier-missing", cycleId, card: storyId, ts: sinks.now() });
}

/**
 * Journal the DECLARED tier + ACTUAL panel composition (AC4) as an "evaluator"
 * round. No-op for a legacy card (no declared tier to reconcile). Best-effort +
 * non-blocking (recordSpawnRound never throws).
 */
export function recordEvaluatorPanelRound(
  ports: Ports,
  ctx: CycleContext,
  opts: { tier: EvaluationTier | undefined; panel: string[]; outcome: string; startMs: number; endMs: number },
): void {
  if (opts.tier === undefined) return;
  recordSpawnRound(ports, ctx, {
    role: "evaluator",
    start: opts.startMs,
    durMs: Math.max(0, opts.endMs - opts.startMs),
    outcome: opts.outcome,
    tier: opts.tier,
    panel: opts.panel,
  });
}
