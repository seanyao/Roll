/**
 * @responsibility Derives dossier ladder and spectrum states from snapshot facts.
 * US-OBS-016 — dossier ladder / spectrum functions moved to @roll/core.
 *
 * Pure derivation functions: delivery ladder, spectrum state, legacy count.
 * These are the read-side computation that feeds into the TruthSnapshot.
 */
import type { DossierEpic, DossierStory } from "./dossier-collect.js";
import type { TruthState } from "./selectors.js";
import { type DeliveryLadder, type StoryEvidenceFlags } from "@roll/spec";

/** The five lifecycle stations, shared with epic/story pages. */
export const SPINE_STAGES = [
  { key: "definition", en: "Definition", zh: "立项" },
  { key: "design", en: "Design", zh: "设计" },
  { key: "execution", en: "Execution", zh: "执行" },
  { key: "delivery", en: "Delivery", zh: "交付" },
  { key: "retrospective", en: "Retrospective", zh: "复盘" },
] as const;

/** Story state vocabulary for the snapshot spectrum. */
export type StoryState = "done" | "wip" | "hold" | "todo" | "fail" | "unknown";

/** The delivery ladder truth verdicts. */
export type TruthBoardVerdict = "pass" | "warn" | "fail" | "unknown";

export interface TruthBoardAudit {
  fail: number;
  warn: number;
  unknown: number;
  collectedAt?: string;
}

export interface TruthBoardCycle {
  cycles3d: number;
  failed3d: number;
  costUsd3d: number;
  costByCurrency3d?: Record<string, number>;
  collectedAt?: string;
}

export interface TruthBoardRelease {
  latestTag?: string;
  verdict: TruthBoardVerdict;
  waiver?: string;
  collectedAt?: string;
}

export interface TruthBoardInput {
  generatedAt?: string;
  collectedAt?: string;
  audit?: TruthBoardAudit;
  cycle?: TruthBoardCycle;
  release?: TruthBoardRelease;
}

/** Classify a story into the snapshot spectrum vocabulary. */
export function storySpectrumState(s: DossierStory): StoryState {
  if (s.truthState === "fail") return "fail";
  if (s.truthState === "unknown") return "unknown";
  if (s.status === "in_progress") return "wip";
  if (s.status === "hold") return "hold";
  if (s.delivered) return "done";
  if (s.status === "done") return "unknown";
  if (s.status === "cut") return "unknown";
  return "todo";
}

/** Count delivered pre-v3 stories without a v3 trail, across epics. */
export function countLegacyStories(epics: DossierEpic[]): number {
  let n = 0;
  for (const e of epics) for (const s of e.stories) if (s.legacy) n += 1;
  return n;
}

/**
 * Derive the claimed→merged→attested ladder rung a story has reached.
 *   - `attested` — delivered (merge truth) AND full attest evidence on disk
 *   - `merged`   — delivered (merge truth) but missing some attest evidence
 *   - `claimed`  — the backlog claims Done but NO merge evidence
 *   - `"none"`   — not even claimed done
 */
export function deriveDeliveryLadder(
  story: Pick<DossierStory, "delivered" | "status">,
  evidence: StoryEvidenceFlags,
): DeliveryLadder | "none" {
  if (story.delivered) {
    return evidence.report && evidence.acMap && evidence.visualEvidence ? "attested" : "merged";
  }
  return story.status === "done" ? "claimed" : "none";
}

/** Evidence flags fall back to all-false so a delivered story with no enriched
 *  flags lands on the honest `merged` rung, never a silent `attested`. */
export const NO_EVIDENCE: StoryEvidenceFlags = { report: false, acMap: false, visualEvidence: false };
