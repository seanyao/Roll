/**
 * @responsibility Declares the agent spec vocabulary: normalizer kinds, usage extractors, roster and scaffold seeds.
 */
// claude is KEPT here (harness): the loop runs inside Claude Code and claude is
// used for harness cost/activity normalization, even though it is NOT a member of
// the orchestrated agent POOL (see registry.ts). So "claude"/"claude-stream"
// remain in these unions as harness kinds.
export type AgentNormalizerKind = "claude" | "codex" | "kimi" | "pi" | "generic";
/**
 * US-PAIR-014: every kind here MUST have an entry in the cost tracker's
 * `REGISTRY` (typed `Record<UsageExtractorKind, Extractor>`, so a gap is a
 * compile error). `"gemini"` and `"qwen"` were removed: no agent declared either
 * — `gemini` is only a name alias for `agy` (which uses the `"agy"` extractor)
 * and `qwen` is in `REMOVED_AGENTS`. Keeping unimplemented kinds in this union is
 * what let codex's declared `"openai"` extractor go missing unnoticed.
 */
export type UsageExtractorKind = "claude-stream" | "openai" | "kimi" | "pi" | "reasonix" | "agy" | "cursor" | "generic";
export type SessionRecoveryKind = "pi" | "kimi" | "codex";
export type SessionBackfillKind = "claude-projects";
/** lever-4: how (if at all) an agent's prior session is REUSED across the next
 *  same-agent card (cross-card warm-context). Agent-AGNOSTIC capability — every
 *  engine declares its kind so the cycle path can resolve one adapter port and
 *  never branch per-agent. `'none'` (or absent) = cold no-op (the universal
 *  default — every current pool agent). */
export type SessionReuseKind = "codex-exec-resume" | "none";

export interface AgentUsageSpec {
  stdoutExtractor?: UsageExtractorKind;
  sessionRecovery?: SessionRecoveryKind;
  sessionBackfill?: SessionBackfillKind;
  /** lever-4 warm-context capability. Absent ⇒ cold no-op (the universal default
   *  for every current pool agent). */
  sessionReuse?: SessionReuseKind;
}

export interface AgentSpec {
  name: string;
  /** Alternate agent names that resolve to this first-class identity. */
  nameAliases?: readonly string[];
  /** Provider/model aliases that resolve for model/spec lookup, not registry identity. */
  providerAliases?: readonly string[];
  /** Legacy extension hook retained for callers that build ad-hoc registries. */
  aliases?: readonly string[];
  displayName: string;
  /** FIX-1249 — SCAFFOLD SEED, not a runtime default. A sensible starting model
   *  used only to write an initial `rigs:` entry into agents.yaml (so the model
   *  becomes visible + editable). The runtime model is CONFIG-DRIVEN: it comes
   *  from agents.yaml (rigs/routing or the config-rig backstop), never from this
   *  field. Read it via {@link agentScaffoldSeedModel}, never as a silent spawn
   *  fallback. */
  defaultModel: string;
  /** PATH binary candidates, in probe order. */
  cliBin: readonly string[];
  /** True iff Roll has a prompt-mode spawn profile for this agent. Runtime
   *  auth/VPN/account health is checked at spawn time, not encoded here. */
  canReviewHeadless?: boolean;
  normalizer: AgentNormalizerKind;
  usage: AgentUsageSpec;
  smokeCommand: string;
  /** FIX-1067 — raw provider model string → compact operator-facing display
   *  label. The ledger stores the raw provider model (e.g.
   *  `kimi-code/kimi-for-coding`); the human cycle surfaces show the canonical
   *  short label (`kimi-2.7`). Keyed by raw model, agent-scoped so no cross-agent
   *  collision. Raw JSON always keeps the un-normalized fact. */
  modelDisplayAliases?: Readonly<Record<string, string>>;
}

export type AgentSpecRegistry = Readonly<Record<string, AgentSpec>>;

// US-AGENT-043/048: the supported agent roster is seven first-class agents.
// Provider/model aliases stay as aliases only (openai -> codex, deepseek -> pi);
// removed tokens such as qwen/openclaw/opencode/trae do not get specs.
export const AGENTS: readonly AgentSpec[] = [
  {
    name: "claude",
    displayName: "claude",
    defaultModel: "claude-sonnet-4",
    cliBin: ["claude"],
    canReviewHeadless: true,
    normalizer: "claude",
    usage: { stdoutExtractor: "claude-stream", sessionBackfill: "claude-projects" },
    smokeCommand: 'claude -p "Reply with a single word: hello"',
  },
  {
    name: "kimi",
    displayName: "kimi",
    defaultModel: "kimi-k2",
    cliBin: ["kimi-code", "kimi-cli", "kimi"],
    canReviewHeadless: true,
    normalizer: "kimi",
    usage: { stdoutExtractor: "kimi", sessionRecovery: "kimi" },
    smokeCommand: 'kimi -p "Reply with a single word: hello"',
    // FIX-1067: the runner records kimi's raw provider model as
    // `kimi-code/kimi-for-coding`; the compact operator label is `kimi-2.7`.
    modelDisplayAliases: { "kimi-code/kimi-for-coding": "kimi-2.7" },
  },
  {
    name: "codex",
    providerAliases: ["openai"],
    displayName: "codex",
    defaultModel: "gpt-5.5",
    cliBin: ["codex"],
    canReviewHeadless: true,
    normalizer: "codex",
    usage: { stdoutExtractor: "openai", sessionRecovery: "codex", sessionReuse: "codex-exec-resume" },
    smokeCommand: 'codex exec "Reply with a single word: hello"',
  },
  {
    name: "pi",
    providerAliases: ["deepseek"],
    displayName: "pi",
    defaultModel: "deepseek-v4-pro",
    cliBin: ["pi"],
    canReviewHeadless: true,
    normalizer: "pi",
    usage: { stdoutExtractor: "pi", sessionRecovery: "pi" },
    smokeCommand: 'pi -p "Reply with a single word: hello"',
  },
  {
    name: "agy",
    nameAliases: ["antigravity", "gemini"],
    displayName: "antigravity (agy)",
    defaultModel: "gemini-2.5-pro",
    cliBin: ["agy", "gemini"],
    canReviewHeadless: true,
    normalizer: "generic",
    usage: { stdoutExtractor: "agy" },
    smokeCommand: 'agy -p "Reply with a single word: hello"',
  },
  {
    name: "reasonix",
    displayName: "reasonix",
    // FIX-1259: SCAFFOLD SEED ONLY (see the field JSDoc + model-config.ts).
    // reasonix is in REQUIRES_EXPLICIT_MODEL, so the runtime model is always
    // config-driven (agents.yaml rig) and a missing config fails loud — this
    // value is NEVER a runtime/attribution fallback. The old usage-attribution
    // leak that copied this into runs.jsonl lived in cost/tracker.ts and is fixed.
    defaultModel: "deepseek-flash",
    cliBin: ["reasonix"],
    canReviewHeadless: true,
    normalizer: "generic",
    usage: { stdoutExtractor: "reasonix" },
    smokeCommand: 'reasonix run --max-steps 1 "Reply with a single word: hello"',
  },
  {
    name: "cursor",
    displayName: "cursor",
    defaultModel: "cursor-default",
    cliBin: ["cursor-agent"],
    canReviewHeadless: true,
    normalizer: "generic",
    usage: { stdoutExtractor: "cursor" },
    smokeCommand: 'cursor-agent --print "Reply with a single word: hello"',
  },
];

function normalizeAgentKey(name: string): string {
  return name.trim().toLowerCase();
}

function canonicalSpecKey(name: string, specs: readonly AgentSpec[] = AGENTS): string {
  const raw = name.trim().toLowerCase();
  for (const spec of specs) {
    const aliases = [...(spec.nameAliases ?? []), ...(spec.providerAliases ?? []), ...(spec.aliases ?? [])];
    if (normalizeAgentKey(spec.name) === raw || aliases.map(normalizeAgentKey).includes(raw)) return normalizeAgentKey(spec.name);
  }
  return raw;
}

export function withAgentSpecs(extra: readonly AgentSpec[] = []): AgentSpecRegistry {
  const out: Record<string, AgentSpec> = {};
  const specs = [...AGENTS, ...extra];
  for (const spec of specs) {
    out[canonicalSpecKey(spec.name, specs)] = spec;
    for (const alias of [...(spec.nameAliases ?? []), ...(spec.providerAliases ?? []), ...(spec.aliases ?? [])]) {
      out[normalizeAgentKey(alias)] = spec;
      out[canonicalSpecKey(alias, specs)] = spec;
    }
  }
  return out;
}

export const AGENT_SPECS = withAgentSpecs();

export function getAgentSpec(name: string, registry: AgentSpecRegistry = AGENT_SPECS): AgentSpec | undefined {
  const raw = normalizeAgentKey(name);
  return registry[raw] ?? registry[canonicalSpecKey(name)];
}

export function canonicalAgentIdentityName(name: string): string {
  const raw = normalizeAgentKey(name);
  for (const spec of AGENTS) {
    if (
      normalizeAgentKey(spec.name) === raw ||
      (spec.nameAliases ?? []).map(normalizeAgentKey).includes(raw) ||
      (spec.providerAliases ?? []).map(normalizeAgentKey).includes(raw)
    )
      return spec.name;
  }
  return raw;
}

// ── Removed agent detection (US-AGENT-045) ───────────────────────────────────

/** Agents removed from the roster in US-AGENT-043. When found in user config
 *  these trigger a fail-loud warning, never a silent fallback. */
export const REMOVED_AGENTS: readonly string[] = ["trae", "qwen", "opencode", "openclaw"];

/** True iff NAME is a removed agent token (checked against REMOVED_AGENTS after
 *  normalisation, BEFORE canonicalisation — so `openai` (alias→codex) returns
 *  false while `cursor` returns true). */
export function isRemovedAgentName(name: string): boolean {
  const raw = normalizeAgentKey(name);
  return REMOVED_AGENTS.includes(raw);
}

export function getAgentIdentitySpec(name: string): AgentSpec | undefined {
  const canonical = canonicalAgentIdentityName(name);
  return AGENTS.find((spec) => spec.name === canonical);
}

export function agentDefaultModel(name: string, registry: AgentSpecRegistry = AGENT_SPECS): string {
  return getAgentSpec(name, registry)?.defaultModel ?? name;
}

/**
 * US-PAIR-011 — which model a peer reviewer/scorer will actually run.
 *
 * The isolation ladder compares MODELS, not agent names (two agent entries can be
 * pinned to the same model — `pi` and `reasonix` both resolve to `deepseek-v4-pro`
 * in this repo's rigs — and one agent entry can span vendors: cursor runs
 * `claude-opus-5-*` OR `gpt-5.3-codex`, and defaults to `auto`).
 *
 * Selection therefore reads the CONFIGURED identity, which is knowable before the
 * spawn: the rig-declared model wins, else the agent's registered default. Never
 * the post-hoc observed model — several agents have stub usage extractors, so
 * depending on observation would leave them permanently undeterminable.
 *
 * Pure: the caller supplies `rigModel` (read from agents.yaml at the boundary).
 */
export function peerModelFor(agent: string, rigModel: string, registry: AgentSpecRegistry = AGENT_SPECS): string {
  const pinned = rigModel.trim();
  if (pinned !== "") return pinned;
  const spec = getAgentSpec(agent, registry);
  // No spec → no claim. Returning the agent name here (as agentDefaultModel does)
  // would let an unknown agent masquerade as its own model identity.
  return spec?.defaultModel ?? "";
}

/**
 * FIX-1067 — the operator-facing runnable Builder label for an agent. The ledger
 * stores the canonical internal agent key (e.g. `kimi`); operators know the agent
 * by the CLI they run (`kimi-code`). Resolve to the primary CLI binary candidate
 * (first {@link AgentSpec.cliBin} entry — the runnable surface), falling back to
 * the canonical identity name for agents not in the roster (so an unknown agent
 * is never silently rewritten). An empty name stays empty.
 */
export function agentBuilderLabel(name: string, registry: AgentSpecRegistry = AGENT_SPECS): string {
  if (name.trim() === "") return "";
  return getAgentSpec(name, registry)?.cliBin[0] ?? canonicalAgentIdentityName(name);
}

/**
 * FIX-1067 — normalize a raw provider model string to its compact operator-facing
 * display label. Agent-scoped via {@link AgentSpec.modelDisplayAliases} so a raw
 * `kimi-code/kimi-for-coding` shows as `kimi-2.7` while every other model (and
 * every other agent) is passed through unchanged. This is DISPLAY-only — the raw
 * model fact stays intact in machine-readable output.
 */
export function normalizeModelLabel(rawModel: string, agentName?: string, registry: AgentSpecRegistry = AGENT_SPECS): string {
  if (rawModel === "") return "";
  if (agentName !== undefined) {
    const alias = getAgentSpec(agentName, registry)?.modelDisplayAliases?.[rawModel];
    if (alias !== undefined) return alias;
  }
  return rawModel;
}

export function agentNormalizerKind(name: string, registry: AgentSpecRegistry = AGENT_SPECS): AgentNormalizerKind {
  return getAgentSpec(name, registry)?.normalizer ?? "generic";
}

export function agentSmokeCommand(name: string, registry: AgentSpecRegistry = AGENT_SPECS): string {
  return getAgentSpec(name, registry)?.smokeCommand ?? `${name} --version`;
}

export function agentCanReviewHeadless(name: string, registry: AgentSpecRegistry = AGENT_SPECS): boolean {
  return getAgentSpec(name, registry)?.canReviewHeadless === true;
}
