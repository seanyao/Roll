/** Agent routing contracts (BC3, I10). */
export const AGENT_NAMES = ["claude", "kimi", "codex", "pi", "agy", "reasonix", "cursor"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
export type AgentId = string;
export type ModelId = string;

/**
 * A concrete assignment unit: a supported agent identity paired with a model id.
 *
 * US-V4-003: `model` is OPTIONAL — a v4 Rig may omit the model to run the agent's
 * own default (arch §10). A resolved {@link Route} still always carries a model.
 */
export interface Rig {
  agent: AgentName;
  model?: ModelId;
}

export function isAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(value);
}

export function rig(agent: string, model: ModelId): Rig {
  if (!isAgentName(agent)) throw new Error(`invalid agent for Rig: ${agent}`);
  return { agent, model };
}

/** Result of a pre-spawn liveness probe (seconds-level, cached). */
export interface Availability {
  available: boolean;
  checkedAt: number;
  reason?: string;
}

/** A resolved route — deterministic for identical inputs (I10). A resolved route
 *  ALWAYS carries a concrete model, even though a v4 Rig's model is optional. */
export interface Route extends Omit<Rig, "model"> {
  model: ModelId;
  /** The policy rule that matched — auditability anchor. */
  matchedRule: string;
}

// ── US-V4-003: v4 Rig routing + execution profile contracts ──────────────────
// Route slots are POLICY LABELS, not Agent/Rig types. The same Rig can be the
// `default` slot in one project and `hard` in another. `fallback` is a pre-spawn
// availability fallback, never a failure-driven retry chain.

/** A named reference into the project route profile's `rigs:` map (v4). */
export type RigRef = string;

/** The four route slots a project route profile can bind. NOT agent/rig types. */
export const ROUTE_SLOTS = ["easy", "default", "hard", "fallback"] as const;
export type RouteSlot = (typeof ROUTE_SLOTS)[number];

/** The story-level role pipeline a Story delivery runs. */
export const EXECUTION_PROFILES = ["standard", "verified", "designed"] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

/** The roles a Story delivery can run, in pipeline order. */
export const ROLE_NAMES = ["designer", "builder", "evaluator"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** How a role binds to an execution identity: a named rig, a route slot, or the
 *  machine default agent. */
export type RoleBinding =
  | { readonly kind: "rig"; readonly rig: RigRef }
  | { readonly kind: "routing"; readonly route: RouteSlot }
  | { readonly kind: "default-agent" };

/** A story-level execution profile spec: which roles run and how each is bound. */
export interface ExecutionProfileSpec {
  readonly profile: ExecutionProfile;
  readonly roles: Partial<Record<RoleName, RoleBinding>>;
}

/** A versioned artifact reference used for role handoff (artifact channel). */
export interface ArtifactRef {
  readonly path: string;
  readonly sha256?: string;
  readonly kind: "contract" | "evidence" | "report" | "log" | "screenshot" | "diff";
}

/** A role's input/output manifest — the artifact-only handoff contract. */
export interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly storyId: string;
  readonly cycleId: string;
  readonly role: RoleName;
  readonly rig: Rig;
  readonly sessionId: string;
  readonly worktreeCwd: string;
  readonly scoreRepoCwd: string;
  readonly inputs: readonly ArtifactRef[];
  readonly outputs: readonly ArtifactRef[];
  readonly createdAt: string;
}

/** One role execution within a Delta Unit. */
export interface RoleRun {
  readonly role: RoleName;
  readonly rig: Rig;
  readonly sessionId: string;
  readonly manifest: ArtifactManifest;
}

/** One execution of a Story under a chosen execution profile. */
export interface StoryExecutionRun {
  readonly storyId: string;
  readonly cycleId: string;
  readonly profile: ExecutionProfile;
  readonly roles: readonly RoleRun[];
}

/** US-V4-008 — the structured facts Supervisor reads, gathered by
 *  DETERMINISTIC selectors (no agent call needed to build them). Project-level
 *  only — never a single Story's implementation. */
export interface SupervisorInput {
  /** Backlog rows: id + raw status cell + parsed depends-on ids. */
  readonly backlog: readonly { readonly id: string; readonly status: string; readonly dependsOn?: readonly string[] }[];
  /** Story ids confirmed delivered (merge evidence on main / queryStoryDelivery). */
  readonly delivered: readonly string[];
  /** Story ids with an OPEN PR/Cycle in flight. */
  readonly openPrStories: readonly string[];
  /** Per-story consecutive-failure counts (from terminal events). */
  readonly recentFailures: readonly { readonly storyId: string; readonly consecutiveFailures: number }[];
  /** Route-profile normalizer errors (unknown rig refs / malformed bindings). */
  readonly routeConfigErrors: readonly string[];
  /** Release-consistency blockers (e.g. backlog-says-Done but main disagrees). */
  readonly releaseBlockers: readonly string[];
  /** Optional daily budget signal: spent vs cap (same unit). */
  readonly budget?: { readonly spent: number; readonly cap: number | null };
  /** Roll metadata repo state, gathered by the CLI when available. */
  readonly rollMeta?: {
    readonly state: "clean" | "dirty" | "unknown";
    readonly detail: string;
    readonly files?: readonly string[];
  };
  /** Open PRs that intentionally require an owner/manual merge decision. */
  readonly manualMergeGates?: readonly SupervisorManualMergeGate[];
  /** Structural execution-boundary failures that must be diagnosed before retry. */
  readonly structuralFailures?: readonly SupervisorStructuralFailure[];
  /**
   * Story ids the runner's picker was holding in pending-publish (deprecated
   * by FIX-1212 — stale markers without an open PR no longer block re-picking).
   * Kept for backwards compat; supervisor ignores it for blocking decisions.
   */
  readonly pendingPublish?: readonly string[];
  /**
   * US-V4-022 — classified agent toolchain health issues observed in the event
   * stream (auth block, network block, setup/skill-root pollution, worktree
   * permission failure). Supervisor uses these for routing advice only.
   */
  readonly agentHealthIssues?: readonly AgentHealthIssue[];
}

/** A surfaced open PR gate that must be reconciled before starting new work. */
export interface SupervisorManualMergeGate {
  readonly storyId: string;
  readonly prNumber: number;
  readonly ciState: string;
  readonly reviewState: string;
  readonly mergeable: string;
  readonly action: string;
  readonly detail: string;
  readonly source: string;
}

/** A non-ordinary cycle failure that points to runner/worktree/gate structure. */
export interface SupervisorStructuralFailure {
  readonly storyId: string;
  readonly kind: "zero_tcr_dirty_worktree" | "main_checkout_dirty";
  readonly detail: string;
  readonly source: string;
  /** FIX-1068 — the preserved worktree path so recovery surfaces can point at it. */
  readonly worktreePath?: string;
}

/** US-V4-009 — an in-flight or candidate cycle for the parallel scheduler. */
export interface SchedulableCycle {
  readonly storyId: string;
  /** Files the story is expected to touch (for conflict serialization). */
  readonly files?: readonly string[];
}

/** US-V4-009 — inputs to the (pure) Supervisor parallel-cycle scheduler. */
export interface ScheduleInput {
  readonly maxParallelCycles: number;
  readonly active: readonly SchedulableCycle[];
  readonly candidates: readonly SchedulableCycle[];
  /** Stories already with an OPEN PR (single-PR-per-story invariant). */
  readonly openPrStories: readonly string[];
  readonly budgetOk: boolean;
  /** Merge queue depth + cap; when depth ≥ cap, new starts pause. */
  readonly mergeQueue?: { readonly depth: number; readonly cap: number };
}

/** US-V4-009 — the scheduler's decision: which stories may start now + why the
 *  rest must wait (serialized for conflict, capacity, budget, or merge queue). */
export interface ScheduleDecision {
  readonly start: readonly string[];
  readonly wait: readonly { readonly storyId: string; readonly reason: string }[];
}

/** US-V4-008 — Supervisor's projection over {@link SupervisorInput}. */
export interface SupervisorFacts {
  readonly counts: { readonly todo: number; readonly inProgress: number; readonly blocked: number; readonly done: number };
  /** Stories the backlog claims Done that main truth does NOT confirm. */
  readonly truthDrift: readonly string[];
  readonly openPrCount: number;
  /** Stories stuck on repeated failures (≥ the stuck threshold). */
  readonly stuckStories: readonly string[];
  readonly routeConfigErrors: readonly string[];
  readonly releaseReadiness: { readonly ready: boolean; readonly blockers: readonly string[] };
  readonly budgetHealth: { readonly ok: boolean; readonly note: string };
}

/** A Supervisor decision record — project-level coordination, never Story
 *  implementation. `requiresOwner` gates persistent policy changes. */
export interface SupervisorDecision {
  readonly kind:
    | "classify-risk"
    | "select-execution-profile"
    | "recommend-route-change"
    | "pause"
    | "resume"
    | "escalate"
    | "serialize-conflict"
    | "release-readiness";
  readonly reason: string;
  readonly evidence: readonly ArtifactRef[];
  readonly requiresOwner: boolean;
}

/** Execution policy: how Roll chooses a profile per story. */
export interface ExecutionPolicy {
  readonly mode: "standard" | "verified" | "designed" | "auto";
  readonly defaultProfile: ExecutionProfile;
}

/** Supervisor config (disabled by default in v4.0). */
export interface SupervisorConfig {
  readonly enabled: boolean;
  readonly mode: "observe" | "advise" | "schedule";
  readonly maxParallelCycles: number;
  readonly budgetPerDay: number | null;
}

/** A route slot resolved to its rig, plus the named ref when one was used (v4). */
export interface ResolvedSlot {
  readonly rig: Rig;
  readonly ref?: RigRef;
}

/** The normalized project route profile — the single shape both v3 and v4
 *  `.roll/agents.yaml` files load into. Pure normalizer output (US-V4-003). */
export interface NormalizedAgentConfig {
  readonly schema: "v3" | "v4";
  readonly rigs: Readonly<Record<string, Rig>>;
  readonly routing: Readonly<Partial<Record<RouteSlot, ResolvedSlot>>>;
  readonly executionProfiles: Readonly<Record<ExecutionProfile, ExecutionProfileSpec>>;
  readonly executionPolicy: ExecutionPolicy;
  readonly supervisor: SupervisorConfig;
}

/** Normalizer result: the config plus any fail-loud signals (unknown rig refs,
 *  malformed role bindings). Callers decide whether to fail closed. */
export interface AgentConfigParse {
  readonly config: NormalizedAgentConfig;
  readonly errors: readonly string[];
}

// ── US-V4-015: fractal Agent Scope / Role / Binding model ──────────────────

export const AGENT_SCOPE_SCHEMA = "roll-agents/v1" as const;
export type AgentScopeSchema = typeof AGENT_SCOPE_SCHEMA;

export const AGENT_SCOPE_KINDS = ["machine", "workspace", "project", "story", "skill", "review", "score"] as const;
export type AgentScopeKind = (typeof AGENT_SCOPE_KINDS)[number];

/** Minimal Role vocabulary for the recursive Agent-domain model. */
export const AGENT_SCOPE_ROLES = ["supervise", "design", "execute", "evaluate"] as const;
export type AgentScopeRole = (typeof AGENT_SCOPE_ROLES)[number];

export const AGENT_BINDING_STRATEGIES = ["first-available", "least-recent", "seeded-random", "health-aware"] as const;
export type AgentBindingStrategy = (typeof AGENT_BINDING_STRATEGIES)[number];

/** Static Agent declaration inside `~/.roll/agents.yaml`. Runtime health is not
 *  encoded here; it is supplied by the resolver/spawn path. */
export interface AgentScopeAgent {
  readonly id: AgentName;
  readonly adapter: AgentName;
  readonly home?: string;
  readonly convention?: string;
  readonly capabilities: readonly AgentScopeRole[];
  readonly models?: readonly ModelId[];
  /** US-AGENT-050 — owner-controlled availability toggle. When `true` the agent
   *  is excluded from ALL pools (builder picker, rotation, peer/evaluator, rig
   *  routing). Persisted in agents.yaml; takes effect immediately without a
   *  loop restart. Defaults to `false` when absent. */
  readonly disabled?: boolean;
}

export interface AgentScopeModel {
  readonly id: ModelId;
  readonly provider?: string;
  readonly capabilities?: readonly string[];
  readonly contextTokens?: number;
  readonly costClass?: "low" | "medium" | "high";
}

export type AgentScopeRoleBinding =
  | { readonly kind: "inherit"; readonly from?: string }
  | { readonly kind: "fixed"; readonly agent: AgentName; readonly model?: ModelId }
  | {
      readonly kind: "select";
      readonly from?: readonly AgentName[];
      readonly require?: readonly AgentScopeRole[];
      readonly avoid?: readonly AgentScopeRole[];
      readonly strategy: AgentBindingStrategy;
    };

export interface AgentScopeDefaults {
  readonly roles: Readonly<Partial<Record<AgentScopeRole, AgentScopeRoleBinding>>>;
}

/** Machine-owned process-capacity policy. Lower scopes may select an agent but
 * cannot declare or enlarge the machine's execution limits. */
export interface AgentCapacityPolicy {
  readonly global: number | "auto";
  readonly defaultPerAgent: number;
  readonly agents: Readonly<Partial<Record<AgentName, number>>>;
  readonly heartbeatSeconds: number;
  readonly staleAfterSeconds: number;
}

/** Fully derived limits used by the broker. Disabled agents have no entry. */
export interface NormalizedAgentCapacityPolicy {
  readonly global: number;
  readonly perAgent: Readonly<Partial<Record<AgentName, number>>>;
  readonly heartbeatSeconds: number;
  readonly staleAfterSeconds: number;
}

export const AGENT_CAPACITY_LEASE_SCHEMA = "roll-agent-capacity-lease/v1" as const;
export const AGENT_CAPACITY_BROKER_LOCK_SCHEMA = "roll-agent-capacity-broker-lock/v1" as const;

export interface AgentCapacityBrokerLock {
  readonly schema: typeof AGENT_CAPACITY_BROKER_LOCK_SCHEMA;
  readonly ownerToken: string;
  readonly host: string;
  readonly pid: number;
  readonly processStartedAtMs: number;
  readonly acquiredAtMs: number;
}

export interface AgentCapacityKey {
  readonly agent: AgentId;
  readonly model: ModelId;
  /** Opaque account/profile identity; never rendered in diagnostics. */
  readonly contextKey: string;
}

export interface AgentCapacityOwner {
  readonly leaseId: string;
  readonly ownerToken: string;
  readonly workspaceId: string;
  readonly storyId: string;
  readonly cycleId: string;
  readonly spawnId: string;
  readonly host: string;
  readonly pid: number;
  readonly processStartedAtMs: number;
}

export interface AgentCapacityLease {
  readonly schema: typeof AGENT_CAPACITY_LEASE_SCHEMA;
  readonly key: AgentCapacityKey;
  readonly owner: AgentCapacityOwner;
  readonly acquiredAtMs: number;
  readonly heartbeatAtMs: number;
}

export interface AgentCapacityAcquireRequest {
  readonly key: AgentCapacityKey;
  readonly owner: AgentCapacityOwner;
}

export type AgentCapacityAcquireResult =
  | { readonly kind: "acquired"; readonly lease: AgentCapacityLease }
  | {
      readonly kind: "waiting";
      readonly retryAtMs: number;
      readonly contenders: readonly { readonly agent: AgentId; readonly cycleId: string }[];
      readonly suspect: boolean;
    };

export type AgentCapacityOwnershipResult =
  | { readonly kind: "updated" | "released" | "already_released" }
  | { readonly kind: "ownership_lost"; readonly reason: string };

export type AgentScopeResolutionStrategy = AgentBindingStrategy | "fixed";

export interface AgentScopeSkippedCandidate {
  readonly agent: AgentName;
  readonly reason: string;
}

export interface AgentScopeResolutionTrace {
  readonly source: string;
  readonly bindingKind: AgentScopeRoleBinding["kind"];
  readonly action: "inherit" | "select" | "resolve" | "fail";
}

/** A concrete role assignment after scope inheritance, selection, and runtime
 *  availability checks have been resolved by the future resolver. */
export interface AgentScopeResolvedRole {
  readonly scope: AgentScopeKind;
  readonly role: AgentScopeRole;
  readonly agent: AgentName;
  readonly model?: ModelId;
  readonly binding: AgentScopeRoleBinding;
  readonly source: string;
  readonly selectedStrategy: AgentScopeResolutionStrategy;
  readonly candidates: readonly AgentName[];
  readonly skipped: readonly AgentScopeSkippedCandidate[];
  readonly trace: readonly AgentScopeResolutionTrace[];
}

export interface AgentScopeResolutionFailure {
  readonly scope: AgentScopeKind;
  readonly role: AgentScopeRole;
  readonly source?: string;
  readonly errors: readonly string[];
  readonly candidates: readonly AgentName[];
  readonly skipped: readonly AgentScopeSkippedCandidate[];
  readonly trace: readonly AgentScopeResolutionTrace[];
}

export type AgentScopeRoleResolution =
  | { readonly ok: true; readonly resolved: AgentScopeResolvedRole }
  | { readonly ok: false; readonly failure: AgentScopeResolutionFailure };

export interface AgentScopeConfig {
  readonly schema: AgentScopeSchema;
  readonly scope: AgentScopeKind;
  readonly inherits?: string;
  readonly agents: Readonly<Partial<Record<AgentName, AgentScopeAgent>>>;
  readonly models: Readonly<Record<ModelId, AgentScopeModel>>;
  readonly roles: Readonly<Partial<Record<AgentScopeRole, AgentScopeRoleBinding>>>;
  readonly defaults: Readonly<Record<string, AgentScopeDefaults>>;
  readonly capacity?: AgentCapacityPolicy;
}

export interface AgentScopeConfigParse {
  readonly config: AgentScopeConfig | null;
  readonly errors: readonly string[];
}

// ── US-AGENT-049: open role casting with health-aware candidate ranking ──────

export type CastRoleName = "designer" | "builder" | "evaluator" | "peer_reviewer";

export interface AgentCapabilityProfile {
  readonly agent: AgentName;
  readonly canExecute: boolean;
  readonly canReview: boolean;
  readonly canScore: boolean;
  readonly strengths: readonly string[];
  readonly knownShortcomings: readonly string[];
  readonly costBand?: "low" | "medium" | "high" | "unknown";
}

export interface AgentHealthSignal {
  readonly agent: AgentName;
  readonly source: "cycle" | "pair" | "score" | "probe" | "manual";
  readonly status: "healthy" | "degraded" | "blocked" | "unknown";
  readonly reason?: "auth" | "timeout" | "parser" | "no_tcr" | "publish" | "cost" | "manual";
  readonly observedAt: string;
  readonly expiresAt?: string;
}

export interface RankedRoleCandidate {
  readonly agent: AgentName;
  readonly eligible: boolean;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
}

export interface RoleCastRankingInput {
  readonly role: CastRoleName;
  readonly profiles: readonly AgentCapabilityProfile[];
  readonly healthSignals: readonly AgentHealthSignal[];
  readonly recentUse?: Readonly<Partial<Record<AgentName, number>>>;
  readonly successfulDeliveries?: Readonly<Partial<Record<AgentName, number>>>;
  readonly storyRisk?: "low" | "medium" | "high" | "unknown";
}

/** Designer contract (`design-contract.md`) a `designed` execution produces in a
 *  fresh session BEFORE the Builder. Builder consumes it via artifact refs; the
 *  Evaluator maps design-contract-vs-delivered against it. */
export interface DesignerContract {
  readonly storyId: string;
  /** What is in scope for this Story (the boundary the Builder must respect). */
  readonly scopeBoundary: readonly string[];
  /** Acceptance / evaluation contract: how the delivery will be judged. */
  readonly acceptanceContract: readonly string[];
  /** Evidence the delivery is expected to produce. */
  readonly expectedEvidence: readonly string[];
  /** Known risks the Builder should watch. */
  readonly risks: readonly string[];
  /** Explicit out-of-scope items (must NOT be done in this Story). */
  readonly outOfScope: readonly string[];
  /** Resize/split guidance when the Designer judges the Story too large. */
  readonly resizeGuidance?: string;
}

/** Design-contract-vs-delivered mapping row: each acceptance item the Designer
 *  contracted, mapped to whether the delivery satisfied it. */
export interface DesignContractDeliveryRow {
  readonly item: string;
  readonly status: "satisfied" | "missing" | "changed";
}

/** US-V4-005 — the Evaluator's recommendation (kept SEPARATE from the score and
 *  the blocking-review verdict — three distinct contracts, never one pass/fail). */
export type EvalRecommendation = "merge" | "repair" | "resize" | "hold" | "escalate";

/** US-V4-005 — the structured Evaluator report (`eval-report.md`). Blocking
 *  findings, advisory findings, score, and attest/evidence status stay separate
 *  dimensions; `recommendation` is the Evaluator's synthesis, never the Builder's. */
export interface EvalReport {
  readonly storyId: string;
  /** Findings that BLOCK merge until repaired (the gate dimension). */
  readonly blockingFindings: readonly string[];
  /** Non-blocking advice (recorded, never gating). */
  readonly advisoryFindings: readonly string[];
  /** The independent review score (separate contract) — absent when not scored. */
  readonly score?: { readonly value: number; readonly verdict: "good" | "ok" | "regression" };
  /** Whether story-scoped acceptance evidence was produced (separate contract). */
  readonly attestStatus: "produced" | "skipped" | "unknown";
  /** Design-contract-vs-delivered mapping summary (present only under `designed`). */
  readonly designContractVsDelivered?: string;
  readonly recommendation: EvalRecommendation;
}

/** US-V4-022 — a single observed agent toolchain signal (warning, auth/network
 *  block, setup/skill-root pollution, worktree permission failure). */
export interface AgentToolchainSignal {
  readonly agent: AgentId;
  readonly message: string;
  readonly source: string;
  readonly severity?: "warning" | "error";
  readonly context?: {
    readonly skillRoot?: string;
    readonly worktreePath?: string;
    readonly exitCode?: number;
  };
}

/** US-V4-022 — classified category for an agent toolchain signal. */
export type AgentToolchainClassification =
  | "auth_block"
  | "network_block"
  | "setup_skill_root_pollution"
  | "worktree_permission_failure"
  | "unknown_warning";

/** US-V4-022 — operational action class a Supervisor recommendation can carry. */
export type AgentHealthAction =
  | "continue"
  | "quarantine_for_current_card"
  | "run_doctor_setup"
  | "create_fix"
  | "pause_for_owner";

/** US-V4-022 — a routed, classified agent health issue ready for display or backlog routing. */
export interface AgentHealthIssue {
  readonly agent: AgentId;
  readonly classification: AgentToolchainClassification;
  readonly severity: "warning" | "error";
  readonly action: AgentHealthAction;
  readonly reason: string;
  readonly detail: string;
  readonly source: string;
  readonly routing: "delivery_team" | "owner" | "none";
}

/** US-V4-004 — the risk signals that drive execution-profile selection (arch §12).
 *  All fields are derivable from a story's spec + facts; none require running it. */
export interface StoryRiskInput {
  readonly storyId: string;
  readonly storyType: "US" | "FIX" | "REFACTOR" | "IDEA";
  readonly estimatedMinutes?: number;
  readonly filesHint: readonly string[];
  readonly userVisible: boolean;
  readonly visualEvidenceRequired: boolean;
  readonly crossModule: boolean;
  readonly touchesTruthOrRelease: boolean;
  readonly touchesAgentRuntime: boolean;
  readonly acceptanceAmbiguous: boolean;
  readonly historicalEvidenceRisk: boolean;
}
