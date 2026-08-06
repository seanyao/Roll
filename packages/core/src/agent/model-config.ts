/**
 * @responsibility Resolves configured agent models and fails loud when a required model is missing.
 * FIX-1249 — agent model is CONFIG-DRIVEN, not a source-baked runtime default.
 *
 * `.roll/agents.yaml` (the `rigs:` + `routing:` map, or a legacy inline slot) is
 * the single source of truth for which model an agent runs. The source no longer
 * holds a runtime model fallback: `specs.ts` `defaultModel` degrades to a
 * SCAFFOLD SEED (see {@link agentScaffoldSeedModel}) — a value used only to
 * write a starting config into agents.yaml, never a silent runtime default.
 *
 * Two rules follow:
 *   1. A configured model reaches the spawn's `--model`.
 *   2. When an agent that REQUIRES an explicit model has none configured, the
 *      spawn FAILS LOUD with actionable guidance ({@link MissingModelConfigError})
 *      instead of silently masking the missing config with a hardcoded value.
 *
 * This module is pure (no I/O): callers pass the normalized config.
 */
import type { NormalizedAgentConfig } from "@roll/spec";
import { canonicalAgentName } from "./registry.js";
import { agentDefaultModel } from "./specs.js";

/**
 * Agents whose CLI has NO usable native default model — an explicit `--model`
 * argument is mandatory at spawn. For these, a missing model config must FAIL
 * LOUD ({@link MissingModelConfigError}), never fall back to a source-baked
 * value. Every OTHER agent (pi/kimi/claude/…) omits `--model` when unconfigured
 * and runs its own CLI default, so those never need a source fallback either.
 */
const REQUIRES_EXPLICIT_MODEL: ReadonlySet<string> = new Set(["reasonix"]);

/** True iff AGENT's CLI mandates an explicit `--model` (so a missing model
 *  config is fail-loud, not a native-default omission). */
export function agentRequiresExplicitModel(agent: string): boolean {
  return REQUIRES_EXPLICIT_MODEL.has(canonicalAgentName(agent));
}

/**
 * Resolve AGENT's model from config ALONE — config is the single source of
 * truth (FIX-1249). Used as the pool-pick backstop: when a route selects an
 * agent but carries no per-route model (e.g. a `select` role pool), scan the
 * `rigs:` map for a rig that binds this agent WITH a model and return the first
 * match in declaration order. Returns undefined when no rig binds the agent with
 * a model. NEVER consults source-baked `specs.ts` defaults.
 */
export function configuredModelForAgent(
  agent: string,
  config: Pick<NormalizedAgentConfig, "rigs">,
): string | undefined {
  const canonical = canonicalAgentName(agent);
  for (const rig of Object.values(config.rigs)) {
    if (canonicalAgentName(rig.agent) === canonical && rig.model !== undefined && rig.model !== "") {
      return rig.model;
    }
  }
  return undefined;
}

/**
 * The SCAFFOLD SEED model for AGENT — a sensible starting value used ONLY to
 * write an initial `rigs:` entry into agents.yaml (so the model becomes visible
 * and editable), never a silent runtime default. Reads the (renamed-in-spirit)
 * `specs.ts` `defaultModel`.
 */
export function agentScaffoldSeedModel(agent: string): string {
  return agentDefaultModel(agent);
}

/**
 * Actionable, copy-pasteable guidance for configuring AGENT's model in
 * `.roll/agents.yaml`. Names the file, the exact keys, an example value seeded
 * from the scaffold seed, so the operator can fix a missing-model config without
 * touching source. Surfaced by {@link MissingModelConfigError}.
 */
export function modelConfigGuidance(agent: string): string {
  const canonical = canonicalAgentName(agent);
  const example = agentScaffoldSeedModel(canonical);
  return [
    `agent '${canonical}' requires an explicit model but none is configured.`,
    `Model config is the single source of truth — the source no longer ships a runtime default.`,
    `Fix it by editing .roll/agents.yaml (no source edit, no rebuild):`,
    `  rigs:`,
    `    ${canonical}-pro:`,
    `      agent: ${canonical}`,
    `      model: ${example}   # any provider/model you want`,
    `  routing:`,
    `    easy: ${canonical}-pro`,
  ].join("\n");
}

/**
 * Fail-loud error raised when an agent that {@link agentRequiresExplicitModel}
 * is about to spawn with NO model resolvable from config. The message IS the
 * actionable {@link modelConfigGuidance}; it never carries a fallback model.
 */
export class MissingModelConfigError extends Error {
  readonly agent: string;
  constructor(agent: string) {
    super(modelConfigGuidance(agent));
    this.name = "MissingModelConfigError";
    this.agent = canonicalAgentName(agent);
  }
}
