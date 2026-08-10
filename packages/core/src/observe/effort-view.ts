/**
 * @responsibility Projects the read-only effort view per isolation tier and review gate.
 * US-PAIR-016 — the read-only effort view: for each (gate x achieved isolation
 * tier) cell, what it cost and what it caught.
 *
 * This exists because "raise isolation and review, get better results but pay
 * more" is a HYPOTHESIS. Nothing in the stream could test it before US-PAIR-020
 * started recording the achieved tier, so this view is the first place the
 * trade-off becomes visible at all.
 *
 * Two disciplines it enforces, both learned from real defects in this repo:
 *   - A cell below {@link MIN_SAMPLES_FOR_RATE} returns NO hit rate. A rate over
 *     three samples reads like a trend and isn't one; and a 0-sample cell rendered
 *     as "0%" is the "nobody reported a problem, therefore there are none"
 *     fallacy.
 *   - Observable and unobservable cost are counted SEPARATELY and never averaged
 *     together. `cost: 0` used to mean both "free" and "could not parse", so a mean
 *     over all rows silently understated spend (US-PAIR-014).
 */
import type { RollEvent } from "@roll/spec";

/** Below this, a cell reports counts only — never a rate. */
export const MIN_SAMPLES_FOR_RATE = 10;

export interface EffortCellView {
  /** Review gate, from the event's `stage`. */
  readonly gate: string;
  /** The isolation tier actually ACHIEVED (not the one asked for). */
  readonly achievedTier: string;
  readonly samples: number;
  /** Verdicts that surfaced at least one finding. */
  readonly hits: number;
  /** Undefined when `samples < MIN_SAMPLES_FOR_RATE` — deliberately not 0. */
  readonly hitRate?: number;
  /** Sum of costs whose basis was actually measured. */
  readonly observedCostUsd: number;
  /** Rows whose cost could not be observed — reported, never folded into the sum. */
  readonly unobservableCostRows: number;
  /** Rows where the observed model disagreed with the configured one. */
  readonly modelMismatches: number;
  /** Runs that degraded below the declared tier. */
  readonly degraded: number;
}

export interface EffortView {
  readonly cells: readonly EffortCellView[];
  /** Cells present but too thin to rate — named explicitly, never silently dropped. */
  readonly insufficientCells: readonly { readonly gate: string; readonly achievedTier: string; readonly samples: number }[];
  /** Verdicts carrying no achieved tier (pre-US-PAIR-020 history). */
  readonly untieredSamples: number;
}

interface Acc {
  gate: string;
  achievedTier: string;
  samples: number;
  hits: number;
  observedCostUsd: number;
  unobservableCostRows: number;
  modelMismatches: number;
  degraded: number;
}

/**
 * Fold the pair:* stream into the effort view. Pure (events to view).
 *
 * The achieved tier lives on `pair:selected` while findings/cost live on
 * `pair:verdict`, so selections are indexed by (cycleId, peer, stage) and joined
 * onto the verdict. A verdict with no matching selection is counted in
 * `untieredSamples` rather than being assigned a tier we cannot substantiate.
 */
export function effortView(events: readonly RollEvent[]): EffortView {
  const tierByKey = new Map<string, { tier: string; degraded: boolean }>();
  const key = (cycleId: string, peer: string, stage: string): string => `${cycleId} ${peer} ${stage}`;

  for (const e of events) {
    if (e.type !== "pair:selected") continue;
    if (e.achievedTier === undefined || e.achievedTier === "") continue;
    // Last selection wins: a retry re-selects the same peer with a fresh decision.
    tierByKey.set(key(e.cycleId, e.peer, e.stage), {
      tier: e.achievedTier,
      degraded: e.degradedFrom !== undefined,
    });
  }

  const cells = new Map<string, Acc>();
  let untieredSamples = 0;

  for (const e of events) {
    if (e.type !== "pair:verdict" && e.type !== "pair:score") continue;
    const stage = e.type === "pair:score" ? e.stage : (e.stage ?? "code");
    const found = tierByKey.get(key(e.cycleId, e.peer, stage));
    if (found === undefined) {
      untieredSamples += 1;
      continue;
    }
    const k = `${stage} ${found.tier}`;
    const acc =
      cells.get(k) ??
      {
        gate: stage,
        achievedTier: found.tier,
        samples: 0,
        hits: 0,
        observedCostUsd: 0,
        unobservableCostRows: 0,
        modelMismatches: 0,
        degraded: 0,
      };
    acc.samples += 1;
    if (e.type === "pair:verdict" && Number.isFinite(e.findings) && e.findings > 0) acc.hits += 1;
    // US-PAIR-014: only a measured cost joins the sum; everything else is counted.
    if (e.costBasis === "estimated" && Number.isFinite(e.cost)) acc.observedCostUsd += e.cost;
    else acc.unobservableCostRows += 1;
    if (e.modelMismatch !== undefined) acc.modelMismatches += 1;
    if (found.degraded) acc.degraded += 1;
    cells.set(k, acc);
  }

  const out: EffortCellView[] = [];
  const insufficient: { gate: string; achievedTier: string; samples: number }[] = [];
  for (const acc of [...cells.values()].sort((a, b) =>
    a.gate === b.gate ? a.achievedTier.localeCompare(b.achievedTier) : a.gate.localeCompare(b.gate),
  )) {
    const rateable = acc.samples >= MIN_SAMPLES_FOR_RATE;
    if (!rateable) insufficient.push({ gate: acc.gate, achievedTier: acc.achievedTier, samples: acc.samples });
    out.push({
      gate: acc.gate,
      achievedTier: acc.achievedTier,
      samples: acc.samples,
      hits: acc.hits,
      ...(rateable ? { hitRate: acc.hits / acc.samples } : {}),
      observedCostUsd: acc.observedCostUsd,
      unobservableCostRows: acc.unobservableCostRows,
      modelMismatches: acc.modelMismatches,
      degraded: acc.degraded,
    });
  }
  return { cells: out, insufficientCells: insufficient, untieredSamples };
}
