/**
 * @responsibility Applies the shift-left ingest soft gate.
 */
/**
 * US-EVID-022 — SHIFT-LEFT ingest soft gate.
 *
 * A card with an AC block but no declared capture surface (and no exemption)
 * will build, honest-skip its evidence, and die an empty shell at attest — the
 * B-class discard. This catches it at authoring/ingest instead: STRUCTURAL check
 * only (never NLP of AC text), and SOFT — a failing card goes to a hold list +
 * alert, it never hard-breaks backlog ingestion (the loop keeps working other
 * cards). Runtime `pick_story` stays non-blocking (owner red line: a false
 * positive must never stall the loop). Phased: metric → alert → block-on-ingest.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acForStory } from "@roll/core";
import { declaresAnySurface } from "./attest-gate.js";

/** Phased rollout: observe-only → alert → hold at ingest. Never crashes ingest. */
export type IngestGateMode = "metric" | "alert" | "block";

export interface IngestReadiness {
  /** true when the card needs no ingest action (no AC block, or a surface is declared). */
  ready: boolean;
  /** true when a card with an AC block declares neither a surface nor an exemption. */
  needsHold: boolean;
  reason: string | null;
}

/**
 * STRUCTURAL ingest readiness. A card with no AC block is ready (nothing to
 * gate). A card WITH an AC block is ready iff it declares a capture surface
 * (deliverable_url/cmd, physical terminal) OR a valid `screenshot_exempt` —
 * reused verbatim from the attest gate's {@link declaresAnySurface}. No AC-text
 * heuristics, so a legitimate CLI/back-end card that declared its surface is
 * never held.
 */
export function ingestSurfaceReadiness(specText: string, storyId: string): IngestReadiness {
  const hasAcBlock = acForStory(specText, storyId, { fileOwned: true }).length > 0;
  if (!hasAcBlock) return { ready: true, needsHold: false, reason: null };
  if (declaresAnySurface(specText)) return { ready: true, needsHold: false, reason: null };
  return {
    ready: false,
    needsHold: true,
    reason:
      "has an AC block but declares no capture surface (deliverable_url / deliverable_cmd / physical terminal) " +
      "and no screenshot_exempt — declare one at authoring or the delivery empty-shells at attest",
  };
}

/** Phased mode from `.roll/policy.yaml` `loop_safety.ingest_gate:`; default metric. */
export function ingestGateMode(repoCwd: string): IngestGateMode {
  try {
    const raw = readFileSync(join(repoCwd, ".roll", "policy.yaml"), "utf8");
    // Require an INDENTED key (nested under a parent such as `loop_safety:`),
    // never a top-level `ingest_gate:`. Conservative default + exact alert/block
    // match keep a stray match harmless, but scoping avoids the loosest reads.
    const m = /^[ \t]+ingest_gate:[ \t]*(\w+)/m.exec(raw);
    const v = (m?.[1] ?? "").toLowerCase();
    return v === "alert" || v === "block" ? v : "metric";
  } catch {
    return "metric";
  }
}

interface IngestHold {
  storyId: string;
  reason: string;
  at: number;
}

function holdPath(runtimeDir: string): string {
  return join(runtimeDir, "ingest-hold.json");
}

/** Read the hold list (cards flagged at ingest), or [] when absent/corrupt. */
export function readIngestHolds(runtimeDir: string): IngestHold[] {
  try {
    const arr = JSON.parse(readFileSync(holdPath(runtimeDir), "utf8")) as unknown;
    if (!Array.isArray(arr)) return [];
    // Per-element validation — a hand-edited/corrupt file must not yield `null`
    // or string entries that crash callers reading `.storyId`.
    return arr.filter(
      (e): e is IngestHold =>
        typeof e === "object" && e !== null && typeof (e as IngestHold).storyId === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Record (idempotent by storyId) a card held at ingest. Best-effort write — the
 * hold list is an observability/queue artifact and must never crash ingest.
 * Returns the updated list.
 */
export function recordIngestHold(runtimeDir: string, storyId: string, reason: string, atMs: number): IngestHold[] {
  const holds = readIngestHolds(runtimeDir).filter((h) => h.storyId !== storyId);
  holds.push({ storyId, reason, at: atMs });
  try {
    mkdirSync(dirname(holdPath(runtimeDir)), { recursive: true });
    writeFileSync(holdPath(runtimeDir), `${JSON.stringify(holds, null, 2)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
  return holds;
}

/** Clear a card from the hold list once it declares a surface (idempotent). */
export function clearIngestHold(runtimeDir: string, storyId: string): void {
  const holds = readIngestHolds(runtimeDir);
  if (!holds.some((h) => h.storyId === storyId)) return;
  try {
    writeFileSync(holdPath(runtimeDir), `${JSON.stringify(holds.filter((h) => h.storyId !== storyId), null, 2)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}
