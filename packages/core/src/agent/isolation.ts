/**
 * @responsibility Computes rig isolation tiers from resolved models, never agent names.
 * US-PAIR-012 — how far apart two rig assignments actually are.
 *
 * The problem this replaces: heterogeneity used to be computed from the AGENT
 * NAME (`AGENT_VENDOR` in pairing.ts). That is wrong in both directions, and both
 * were confirmed against this repo's real config:
 *
 *   - OVER-counting (a live bug): `.roll/agents.yaml` pins BOTH `pi` and
 *     `reasonix` to `deepseek-v4-pro`. Different names, one model — yet
 *     `isHeterogeneous("pi","reasonix")` returned true, so the same model
 *     "independently" reviewed its own family's work.
 *   - UNDER-counting: one agent entry can span vendors. `cursor --list-models`
 *     offers `claude-opus-5-thinking-high` (anthropic) AND `gpt-5.3-codex`
 *     (openai), and its default is `auto`. Calling that "one vendor" is fiction.
 *
 * So distance is computed over the RESOLVED MODEL, and the vendor is derived FROM
 * the model — never guessed from the agent name.
 */

/** How far the reviewer must be from the builder. Strongest → weakest. */
export type IsolationTier = "vendor" | "model" | "session" | "off";

/** Strength order; `indexOf` gives a comparable rank (lower = stronger). */
export const ISOLATION_TIERS: readonly IsolationTier[] = ["vendor", "model", "session", "off"];

/** Is `a` at least as strong as `b`? */
export function tierAtLeast(a: IsolationTier, b: IsolationTier): boolean {
  return ISOLATION_TIERS.indexOf(a) <= ISOLATION_TIERS.indexOf(b);
}

/**
 * Who serves a model. Prefix-matched because model ids are vendor-stamped in
 * practice (`claude-*`, `gpt-*`, `deepseek-*`) and that is stable across the
 * version churn a hardcoded id list would not survive.
 *
 * MAINTENANCE: adding an agent or model to the registry must add its prefix here
 * in the SAME PR, or every comparison involving it silently degrades a tier.
 */
const MODEL_VENDOR_PREFIXES: readonly (readonly [RegExp, string])[] = [
  [/^claude-/i, "anthropic"],
  [/^(?:gpt-|o\d)/i, "openai"],
  [/^kimi-/i, "moonshot"],
  [/^deepseek-/i, "deepseek"],
  [/^mimo-/i, "xiaomi"],
  [/^gemini-/i, "google"],
  [/^(?:cursor-|composer-)/i, "cursor"],
  [/^grok-/i, "xai"],
  [/^qwen-/i, "alibaba"],
];

/**
 * The vendor behind a model id, or "" when unrecognised.
 *
 * "" is deliberately NOT a synthetic per-model vendor. Treating each unknown
 * model as its own vendor is what re-creates the over-counting bug: two
 * unrecognised models from the SAME vendor would compare as "different vendors"
 * and satisfy a tier they cannot prove. Unknown means unproven — see
 * {@link isolationBetween}, which refuses `vendor` in that case.
 */
export function vendorOfModel(modelId: string): string {
  const id = modelId.trim();
  if (id === "") return "";
  for (const [re, vendor] of MODEL_VENDOR_PREFIXES) {
    if (re.test(id)) return vendor;
  }
  return "";
}

/** One side of a comparison: which rig ran, and in which session. */
export interface RigIdentity {
  /** The agents.yaml entry name. Recorded for reporting; NEVER the distance key. */
  readonly agentEntry: string;
  /** The resolved model id (rig-declared, else the agent's registered default). */
  readonly modelId: string;
  /** Opaque per-run session token. */
  readonly sessionId: string;
}

export interface IsolationVerdict {
  /** The strongest tier these two identities actually achieve. */
  readonly tier: IsolationTier;
  /** Why it is not stronger — always populated below `vendor`. */
  readonly reason: string;
}

/**
 * The strongest tier genuinely achieved between a builder and a candidate.
 *
 * Order of proof, strongest first:
 *   - `vendor`  — both models map to a KNOWN vendor and the vendors differ.
 *   - `model`   — the model ids differ (same vendor, or vendor unknown).
 *   - `session` — same model, but demonstrably a different session.
 *   - `off`     — nothing separates them (same session = self-review).
 *
 * An unknown vendor can never yield `vendor`. It degrades to `model` with the
 * reason recorded, so "we could not tell" is never reported as "they differ".
 */
export function isolationBetween(builder: RigIdentity, candidate: RigIdentity): IsolationVerdict {
  const bModel = builder.modelId.trim();
  const cModel = candidate.modelId.trim();
  const bVendor = vendorOfModel(bModel);
  const cVendor = vendorOfModel(cModel);

  if (bModel !== "" && cModel !== "" && bModel !== cModel) {
    if (bVendor !== "" && cVendor !== "" && bVendor !== cVendor) {
      return { tier: "vendor", reason: `${bVendor} → ${cVendor}` };
    }
    const unknown = [bVendor === "" ? bModel : "", cVendor === "" ? cModel : ""].filter((x) => x !== "");
    if (unknown.length > 0) {
      return {
        tier: "model",
        reason: `different models but vendor unknown for ${unknown.join(", ")} — cannot prove a vendor split`,
      };
    }
    return { tier: "model", reason: `same vendor ${bVendor}, different models` };
  }

  // Same model (or one side has no model claim at all).
  const sameSession = builder.sessionId !== "" && builder.sessionId === candidate.sessionId;
  if (sameSession) {
    return { tier: "off", reason: "same session and same model — this is self-review" };
  }
  if (builder.sessionId === "" || candidate.sessionId === "") {
    return { tier: "off", reason: "a session identity is missing — cannot prove even a session split" };
  }
  const label = bModel === "" || cModel === "" ? "no model claim on one side" : `both on ${bModel}`;
  return { tier: "session", reason: `${label} — only a fresh session separates them` };
}

// ── US-PAIR-015: using the ladder as the selection predicate ─────────────────

/**
 * Resolves an agent entry to the model it will actually run. Injected so the pure
 * layer stays free of filesystem access — the CLI passes a reader over
 * `agents.yaml` rigs (see `configuredPeerModel`).
 */
export type ModelResolver = (agent: string) => string;

/**
 * US-PAIR-015 — the replacement for name-based `isHeterogeneous`.
 *
 * True only when the two agents' RESOLVED MODELS come from different, KNOWN
 * vendors. This is what stops `pi` vs `reasonix` (both pinned to
 * `deepseek-v4-pro`) from counting as an independent review, and what lets
 * `cursor` running a gpt model count as one against `claude`.
 *
 * Session identity is intentionally not consulted: this predicate answers "are
 * these two far enough apart to be a heterogeneous pair", and session separation
 * is a weaker, separate tier enforced downstream.
 */
export function heterogeneousByModel(a: string, b: string, resolve: ModelResolver): boolean {
  // Distinct sentinels: this predicate must not accidentally read as a session
  // split, so never let the two sides share a session token.
  return (
    isolationBetween(
      { agentEntry: a, modelId: resolve(a), sessionId: "lhs" },
      { agentEntry: b, modelId: resolve(b), sessionId: "rhs" },
    ).tier === "vendor"
  );
}

/**
 * US-PAIR-015 — is a genuinely heterogeneous reviewer reachable for `builder`?
 *
 * The model-aware counterpart of `heteroAvailable`. A pool of several agent
 * entries that all resolve to ONE model is NOT heterogeneous availability, which
 * is exactly what the name-based version got wrong.
 */
export function heteroAvailableByModel(
  installed: readonly string[],
  builder: string,
  resolve: ModelResolver,
  allowed?: Set<string> | readonly string[],
): boolean {
  const allowedSet = allowed === undefined ? undefined : new Set(allowed);
  return installed
    .filter((a) => a !== "" && (allowedSet === undefined || allowedSet.has(a)))
    .some((a) => heterogeneousByModel(builder, a, resolve));
}

// ── US-PAIR-018: reconciling the configured model against the observed one ────

export type ModelReconcileVerdict =
  | { readonly kind: "match" }
  | { readonly kind: "not_observed" }
  | { readonly kind: "mismatch"; readonly configured: string; readonly observed: string; readonly message: string };

/**
 * US-PAIR-018 — did the peer actually run the model config pinned it to?
 *
 * Reconciliation ONLY. The isolation decision was already made from the
 * configured identity before the spawn (US-PAIR-011/012) and this must never
 * revisit it, because several agents ship deliberately stubbed usage extractors
 * (pi, agy): if observation could overrule selection, those agents would be
 * permanently unable to satisfy a model/vendor tier and would degrade forever.
 *
 * So:
 *   - nothing observed        → `not_observed`, silent. NOT a mismatch, NOT a downgrade.
 *   - observed == configured  → `match`.
 *   - observed != configured  → `mismatch`, which callers WARN on and record —
 *                               never a retro-active change to the tier.
 */
export function reconcileObservedModel(configured: string, observed: string): ModelReconcileVerdict {
  const want = configured.trim();
  const got = observed.trim();
  // An absent observation carries no information — the extractor may simply be a
  // stub. Treating it as a mismatch would make honest silence look like a fault.
  if (got === "") return { kind: "not_observed" };
  if (want === "") return { kind: "not_observed" };
  if (want === got) return { kind: "match" };
  const wantVendor = vendorOfModel(want) || "unknown";
  const gotVendor = vendorOfModel(got) || "unknown";
  const crossVendor = wantVendor !== gotVendor;
  return {
    kind: "mismatch",
    configured: want,
    observed: got,
    message: crossVendor
      ? `configured ${want} (${wantVendor}) but observed ${got} (${gotVendor}) — the isolation tier recorded for this run was computed from the CONFIGURED model and may overstate the real separation`
      : `configured ${want} but observed ${got} (same vendor ${wantVendor})`,
  };
}
