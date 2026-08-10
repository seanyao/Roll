/**
 * @responsibility Records a role's turn into the per-card round journal.
 */
/**
 * US-CYCLE-004 — best-effort runner hook that records a role's turn into the
 * per-card round-journal. Auto-writes from the spawn/gate paths so there is no
 * manual step. NEVER throws and NEVER blocks the cycle's critical path — a
 * journal write is pure observability.
 */
import { appendRoundEntryAsync, EVENTS_FILE, parseTestPassProof, serializeEvent } from "@roll/core";
import type { CycleContext } from "@roll/core";
import type { RollEvent } from "@roll/spec";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cardArchiveDir } from "../lib/archive.js";
import { maybeWriteSplitAdvice } from "../lib/split-advice.js";
import { maybeWriteCandidates } from "../lib/model-swap.js";
import type { Ports } from "./ports.js";

export interface RoundTurn {
  /** builder | evaluator | designer | scorer | gate | … */
  role: string;
  /** Epoch ms when the turn started. */
  start: number;
  /** Wall-clock duration in ms. */
  durMs: number;
  /** delivered | failed | timeout | passed | blocked | … */
  outcome: string;
  /** Gate (local test/lint) time attributed to this turn, ms. */
  gateTimeMs?: number;
  /** US-CYCLE-011 — the gate scope this turn's gate time / proof belongs to. */
  gateMode?: "changed" | "full";
  /** Override the model (defaults to ctx.model). */
  model?: string;
  /** US-CYCLE-008 — the DECLARED evaluation risk tier for an evaluator turn. */
  tier?: "low" | "high";
  /** US-CYCLE-008 — the ACTUAL evaluator panel composition for this turn. */
  panel?: string[];
}

/**
 * US-CYCLE-011 — read the gate SCOPE the builder's LAST gate ran at, from the
 * `.roll/last-test-pass` proof it left in the worktree, so the round-journal can
 * bucket gate time `--changed` vs `full`. Best-effort: any absent/unreadable/
 * malformed proof, or a non-canonical mode, yields `undefined` (untagged).
 */
export function readGateMode(worktreePath: string): "changed" | "full" | undefined {
  try {
    const proof = parseTestPassProof(readFileSync(join(worktreePath, ".roll", "last-test-pass"), "utf8"));
    if (proof?.mode === "full") return "full";
    if (proof?.mode === "changed") return "changed";
    return undefined;
  } catch {
    return undefined;
  }
}

/** The comparison-window label (dogfood era) — from env, else "unknown". */
function resolveEra(): string {
  const era = (process.env["ROLL_ERA"] ?? "").trim();
  return era === "" ? "unknown" : era;
}

/**
 * Append one turn to the card's round-journal. Best-effort AND non-blocking
 * (AC2): the write goes through the ASYNC append (fs.promises), fire-and-forget —
 * the caller returns immediately and the disk I/O yields the event loop instead
 * of freezing it, even on a slow/stalled filesystem. No round is computed here
 * (that would need a racy read-modify-write count); the readout DERIVES the
 * round from `cycleId`. Any rejection is swallowed — the cycle is never affected.
 *
 * The single-line jsonl append is the source of truth; the derived `.md` is NOT
 * written here (it is regenerated on demand by the readout).
 */
export function recordSpawnRound(ports: Ports, ctx: CycleContext, turn: RoundTurn): void {
  const storyId = ctx.storyId ?? "";
  if (storyId === "") return; // story-less cycles have no card to journal into
  const repoCwd = ports.repoCwd;
  const model = turn.model ?? (ctx.model !== undefined && ctx.model !== "" ? ctx.model : undefined);
  const cycleId = ctx.cycleId;
  // The ENTIRE journal write — including cardArchiveDir (which resolves the epic
  // via a synchronous .roll/features scan / index read) and the async append —
  // is deferred off the caller's tick via setImmediate. So the delivery critical
  // path (the spawn handler continuing + returning) is never delayed by any
  // filesystem work, and the append itself is async (yields the event loop).
  setImmediate(() => {
    let cardDir: string;
    try {
      cardDir = cardArchiveDir(repoCwd, storyId);
    } catch {
      return; // cannot resolve a card dir → nothing to journal
    }
    void appendRoundEntryAsync(cardDir, {
      card: storyId,
      role: turn.role,
      ...(model !== undefined ? { model } : {}),
      start: turn.start,
      durMs: turn.durMs,
      outcome: turn.outcome,
      ...(turn.gateTimeMs !== undefined ? { gateTimeMs: turn.gateTimeMs } : {}),
      ...(turn.gateMode !== undefined ? { gateMode: turn.gateMode } : {}),
      ...(turn.tier !== undefined ? { tier: turn.tier } : {}),
      ...(turn.panel !== undefined ? { panel: turn.panel } : {}),
      era: resolveEra(),
      ...(cycleId !== undefined && cycleId !== "" ? { cycleId } : {}),
    })
      .then(() => {
        // US-CYCLE-006 — AUTO-TRIGGER: after the round is persisted, if the card
        // has now crossed the repair-round threshold, write split-advice.md
        // (idempotent) and emit the signal event. Fully best-effort — a failure
        // here never affects the cycle. The manual `roll loop cycle split-advice`
        // command remains the readout / on-demand path.
        try {
          const res = maybeWriteSplitAdvice(cardDir, storyId);
          if (res !== null && res.written) {
            const loopDir = join(repoCwd, ".roll", "loop");
            mkdirSync(loopDir, { recursive: true });
            const ev: RollEvent = { type: "split:advice", card: storyId, rounds: res.advice.roundCount, path: res.path, ts: eventTsMs() };
            appendFileSync(join(loopDir, EVENTS_FILE), serializeEvent(ev) + "\n");
          }
        } catch {
          /* auto split-advice is best-effort observability */
        }
        // US-CYCLE-012 — AUTO-TRIGGER: surface a model-swap CANDIDATE when a
        // (role × model) rig crossed the consecutive-failure threshold on this
        // card. Candidate + event only — never an automatic swap. Best-effort.
        try {
          const swap = maybeWriteCandidates(cardDir, storyId);
          if (swap !== null && swap.written) {
            const loopDir = join(repoCwd, ".roll", "loop");
            mkdirSync(loopDir, { recursive: true });
            for (const cand of swap.candidates) {
              const ev: RollEvent = { type: "model:swap_candidate", card: storyId, role: cand.role, model: cand.model, streak: cand.streak, path: swap.path, ts: eventTsMs() };
              appendFileSync(join(loopDir, EVENTS_FILE), serializeEvent(ev) + "\n");
            }
          }
        } catch {
          /* auto swap-candidate is best-effort observability */
        }
      })
      .catch(() => {
        /* best-effort observability — never affect the cycle */
      });
  });
}

/** Epoch ms for the split:advice event. Isolated so the (test-injectable) clock
 *  seam stays obvious; the journal itself carries no wall-clock dependency. */
function eventTsMs(): number {
  return Date.now();
}
