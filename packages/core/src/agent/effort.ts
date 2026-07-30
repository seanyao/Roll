/**
 * US-PAIR-013 — the effort table: for each review gate, how far the reviewer
 * must be from the builder.
 *
 * Isolation strength and review strength are NOT two separate knobs. Both are
 * facts about rigs, so one table expresses both: the gates that appear are the
 * review strength, and each gate's value is the required rig distance. "Review
 * strength" is just how many gates are not `off` — it needs no dial of its own.
 */
import type { IsolationTier } from "./isolation.js";

/**
 * The gates that can be configured.
 *
 * ONLY `code` and `score` exist. `PairingStage` also lists `design`/`test`/`cycle`,
 * but those enum members have NO production path: the scoped config hardcodes
 * `["code","score"]` and `enabledPairingStages` then filters `score` out to its own
 * protocol. Offering them here would let someone "enable" a gate that silently
 * never runs — so configuring one is a fail-loud error, not a no-op.
 */
export type EffortGate = "code" | "score";
export const EFFORT_GATES: readonly EffortGate[] = ["code", "score"];

/** Gate → required rig distance. */
export type EffortTable = Readonly<Record<EffortGate, IsolationTier>>;

/** Shorthands for the common shapes. `standard` is the default. */
export const EFFORT_PRESETS: Readonly<Record<string, EffortTable>> = {
  // Matches what this repo actually runs today: both gates, heterogeneous peer.
  standard: { code: "vendor", score: "vendor" },
  light: { code: "vendor", score: "off" },
  off: { code: "off", score: "off" },
};

export const DEFAULT_EFFORT: EffortTable = EFFORT_PRESETS["standard"]!;

const VALID_TIERS: readonly string[] = ["vendor", "model", "session", "off"];

/** Stages that exist in the enum but have no production path (see {@link EffortGate}). */
const UNIMPLEMENTED_GATES: readonly string[] = ["design", "test", "cycle"];

export interface EffortParse {
  readonly effort: EffortTable;
  readonly errors: readonly string[];
}

/**
 * Parse an `effort:` node.
 *
 * Accepts either a preset name (`effort: standard`) or a per-gate map
 * (`effort: { code: vendor, score: model }`), and both together — a per-gate
 * entry overrides the preset it sits on.
 *
 * Absent → {@link DEFAULT_EFFORT} (`standard`). Never `off`: switching review OFF
 * has to be typed out, so it can't happen by omission or by a typo'd key.
 */
export function parseEffort(node: unknown): EffortParse {
  const errors: string[] = [];
  if (node === undefined || node === null) return { effort: DEFAULT_EFFORT, errors };

  if (typeof node === "string") {
    const preset = EFFORT_PRESETS[node.trim()];
    if (preset === undefined) {
      errors.push(`effort: unknown preset "${node.trim()}" (expected ${Object.keys(EFFORT_PRESETS).join(" | ")})`);
      return { effort: DEFAULT_EFFORT, errors };
    }
    return { effort: preset, errors };
  }

  if (typeof node !== "object" || Array.isArray(node)) {
    errors.push("effort: expected a preset name or a map of gate → tier");
    return { effort: DEFAULT_EFFORT, errors };
  }

  const rec = node as Record<string, unknown>;
  // A `preset:` key inside the map is the base; explicit gates then override it.
  let base = DEFAULT_EFFORT;
  const presetRef = rec["preset"];
  if (presetRef !== undefined) {
    if (typeof presetRef !== "string" || EFFORT_PRESETS[presetRef.trim()] === undefined) {
      errors.push(`effort.preset: unknown preset "${String(presetRef)}"`);
    } else {
      base = EFFORT_PRESETS[presetRef.trim()]!;
    }
  }

  const out: Record<EffortGate, IsolationTier> = { ...base };
  for (const [key, raw] of Object.entries(rec)) {
    if (key === "preset") continue;
    if (UNIMPLEMENTED_GATES.includes(key)) {
      // Fail loud: "enabled" but never runs is worse than not offered at all.
      errors.push(`effort.${key}: the "${key}" stage has no production path — only ${EFFORT_GATES.join(" / ")} can be configured`);
      continue;
    }
    if (!(EFFORT_GATES as readonly string[]).includes(key)) {
      errors.push(`effort.${key}: unknown gate (expected ${EFFORT_GATES.join(" | ")})`);
      continue;
    }
    const tier = typeof raw === "string" ? raw.trim() : "";
    if (!VALID_TIERS.includes(tier)) {
      errors.push(`effort.${key}: invalid tier "${String(raw)}" (expected ${VALID_TIERS.join(" | ")})`);
      continue;
    }
    out[key as EffortGate] = tier as IsolationTier;
  }
  return { effort: out, errors };
}

/** Gates that are actually on — i.e. the review strength this table expresses. */
export function enabledEffortGates(effort: EffortTable): readonly EffortGate[] {
  return EFFORT_GATES.filter((g) => effort[g] !== "off");
}
