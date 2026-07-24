/**
 * FIX-1047 — scoped `story.execute` (Builder) routing.
 *
 * The executor used to resolve `story.execute` WITHOUT first resolving the
 * active `supervise` (Supervisor) assignment, so explicit owner routing rules
 * that reference role assignments were inert. This module resolves Supervisor
 * first, threads it in as `assignedRoles.supervise` for explicit role-aware
 * policies, and feeds recent Builder usage so selection can fairly rotate the
 * open pool.
 *
 * The full {@link AgentScopeRoleResolution} (candidate pool, skipped candidates
 * with reasons, strategy, selected Builder, source path) is returned so both
 * the executor and the route diagnostic command surface the same auditable
 * trace.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENT_REGISTRY_NAMES,
  agentsInstalled,
  canonicalAgentName,
  discoverWorkspaceForIntent,
  normalizeAgentScopeConfig,
  parsePolicy,
  rankRoleCandidates,
  resolveWorkspaceExecutionContextScope,
  resolveAgentScopeRole,
  validateResolvedTargetRequirement,
} from "@roll/core";
import type {
  AgentCapabilityProfile,
  AgentHealthSignal,
  AgentName,
  AgentScopeConfig,
  AgentScopeRole,
  AgentScopeRoleResolution,
  CastRoleName,
  CycleRepositoryExecutionContext,
  RankedRoleCandidate,
  RepositoryExecutionContext,
  WorkspaceDiscoveryDiagnosticV1,
  WorkspaceExecutionContextV1,
  RequirementHintV1,
} from "@roll/spec";
import {
  REQUIREMENT_HINT_V1,
  WORKSPACE_INTENT_V1,
} from "@roll/spec";
import type { WorkspaceDiscoveryFactsV1 } from "@roll/core";
import { realAgentEnv } from "../commands/agent-list.js";

export interface ScopedExecuteRoute {
  readonly resolution: AgentScopeRoleResolution;
  readonly castRole: CastRoleName;
  readonly scopeRole: AgentScopeRole;
  /** The active Supervisor (`supervise`) agent, if any. */
  readonly superviseAgent: AgentName | null;
  /** Recent-use input handed to the `least-recent` strategy (epoch ms per agent). */
  readonly recentUse: Readonly<Partial<Record<AgentName, number>>>;
  readonly successfulDeliveries: Readonly<Partial<Record<AgentName, number>>>;
  readonly ranked: readonly RankedRoleCandidate[];
  /** FIX-1267 — the previous cycle's Builder, excluded from this Builder
   *  resolution by the no-consecutive-repeat rotation. `null` when the rotation
   *  is off, the role is not Builder, or there is no prior builder on record. */
  readonly previousBuilder: AgentName | null;
}

export function readScopedAgentLayer(path: string): { config: AgentScopeConfig; path: string } | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (!text.includes("roll-agents/v1")) return null;
  const parsed = normalizeAgentScopeConfig(text);
  if (parsed.config === null || parsed.errors.length > 0) return null;
  return { config: parsed.config, path };
}

function runtimeDirFor(repoCwd: string): string {
  return (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim() || join(repoCwd, ".roll", "loop");
}

interface RuntimeRunRow {
  readonly agent: AgentName;
  readonly ts?: string;
  readonly status?: string;
}

function readRuntimeRunRows(runtimeDir: string): RuntimeRunRow[] {
  const path = join(runtimeDir, "runs.jsonl");
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: RuntimeRunRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: { readonly agent?: unknown; readonly ts?: unknown; readonly status?: unknown };
    try {
      row = JSON.parse(trimmed) as { readonly agent?: unknown; readonly ts?: unknown; readonly status?: unknown };
    } catch {
      continue;
    }
    if (typeof row.agent !== "string") continue;
    const agent = canonicalAgentName(row.agent) as AgentName;
    if (!(AGENT_REGISTRY_NAMES as readonly string[]).includes(agent)) continue;
    out.push({
      agent,
      ...(typeof row.ts === "string" ? { ts: row.ts } : {}),
      ...(typeof row.status === "string" ? { status: row.status } : {}),
    });
  }
  return out;
}

/**
 * Map each agent to the epoch ms of its most recent Builder run (from
 * runs.jsonl). Larger = more recently used; absent agents are "never used" and
 * the `least-recent` strategy schedules them first. Best-effort: any IO/parse
 * failure yields an empty map (degenerate but deterministic least-recent).
 */
function readRecentUse(runtimeDir: string): Partial<Record<AgentName, number>> {
  const out: Partial<Record<AgentName, number>> = {};
  for (const row of readRuntimeRunRows(runtimeDir)) {
    if (row.ts === undefined) continue;
    const when = Date.parse(row.ts);
    if (Number.isNaN(when)) continue;
    const prev = out[row.agent];
    if (prev === undefined || when > prev) out[row.agent] = when;
  }
  return out;
}

const SUCCESSFUL_RUN_STATUSES = new Set(["built", "delivered", "done", "published", "success", "merged"]);

function readSuccessfulDeliveries(runtimeDir: string): Partial<Record<AgentName, number>> {
  const out: Partial<Record<AgentName, number>> = {};
  for (const row of readRuntimeRunRows(runtimeDir)) {
    if (row.status === undefined || !SUCCESSFUL_RUN_STATUSES.has(row.status)) continue;
    out[row.agent] = (out[row.agent] ?? 0) + 1;
  }
  return out;
}

function parseHealthSignal(raw: unknown): AgentHealthSignal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Partial<Record<keyof AgentHealthSignal, unknown>>;
  if (typeof row.agent !== "string" || !(AGENT_REGISTRY_NAMES as readonly string[]).includes(row.agent)) return null;
  if (row.source !== "cycle" && row.source !== "pair" && row.source !== "score" && row.source !== "probe" && row.source !== "manual") return null;
  if (row.status !== "healthy" && row.status !== "degraded" && row.status !== "blocked" && row.status !== "unknown") return null;
  if (typeof row.observedAt !== "string") return null;
  const reason = row.reason === "auth" || row.reason === "timeout" || row.reason === "parser" || row.reason === "no_tcr" || row.reason === "publish" || row.reason === "cost" || row.reason === "manual"
    ? row.reason
    : undefined;
  return {
    agent: row.agent as AgentName,
    source: row.source,
    status: row.status,
    ...(reason !== undefined ? { reason } : {}),
    observedAt: row.observedAt,
    ...(typeof row.expiresAt === "string" ? { expiresAt: row.expiresAt } : {}),
  };
}

function readHealthSignals(runtimeDir: string): AgentHealthSignal[] {
  const path = join(runtimeDir, "agent-health.jsonl");
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: AgentHealthSignal[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = parseHealthSignal(JSON.parse(trimmed) as unknown);
      if (parsed !== null) out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

function roleToScopeRole(role: CastRoleName): AgentScopeRole {
  return role === "evaluator" || role === "peer_reviewer" ? "evaluate" : "execute";
}

function declaredCapabilities(layers: readonly { config: AgentScopeConfig; path: string }[]): Map<AgentName, readonly AgentScopeRole[]> {
  const out = new Map<AgentName, readonly AgentScopeRole[]>();
  for (const layer of layers) {
    for (const [agent, spec] of Object.entries(layer.config.agents) as [AgentName, NonNullable<AgentScopeConfig["agents"][AgentName]>][]) {
      out.set(agent, spec.capabilities);
    }
  }
  return out;
}

function defaultCostBand(agent: AgentName): AgentCapabilityProfile["costBand"] {
  if (agent === "reasonix") return "low";
  if (agent === "claude") return "high";
  if (agent === "agy") return "unknown";
  return "medium";
}

function profileFor(agent: AgentName, capabilities: readonly AgentScopeRole[]): AgentCapabilityProfile {
  const canExecute = capabilities.includes("execute");
  const canReview = capabilities.includes("evaluate");
  const strengths = agent === "reasonix" ? ["focused fixes"] : canExecute ? ["execute"] : canReview ? ["evaluate"] : [];
  const knownShortcomings = agent === "reasonix" ? ["weaker broad builder"] : [];
  return {
    agent,
    canExecute,
    canReview,
    canScore: canReview,
    strengths,
    knownShortcomings,
    costBand: defaultCostBand(agent),
  };
}

function skippedCandidates(resolution: AgentScopeRoleResolution): ReadonlyMap<AgentName, string> {
  const skipped = resolution.ok ? resolution.resolved.skipped : resolution.failure.skipped;
  return new Map(skipped.map((row) => [row.agent, row.reason]));
}

function rankedWithResolutionSkips(ranked: readonly RankedRoleCandidate[], resolution: AgentScopeRoleResolution): RankedRoleCandidate[] {
  const skipped = skippedCandidates(resolution);
  return ranked
    .map((candidate) => {
      const reason = skipped.get(candidate.agent);
      if (reason === undefined) return candidate;
      return {
        ...candidate,
        eligible: false,
        score: 0,
        reasons: [...candidate.reasons, `skipped:${reason}`],
      };
    })
    .sort((a, b) => b.score - a.score || Number(b.eligible) - Number(a.eligible) || a.agent.localeCompare(b.agent));
}

/** Test seams; production reads the real ROLL_HOME, installed agents, and runs.jsonl. */
export interface ScopedRouteDeps {
  readonly rollHome?: string;
  /** Registered Workspace root. Production also recognizes a resolved root by workspace.yaml. */
  readonly workspaceRoot?: string;
  readonly installed?: ReadonlySet<string>;
  readonly recentUse?: Readonly<Partial<Record<AgentName, number>>>;
  readonly successfulDeliveries?: Readonly<Partial<Record<AgentName, number>>>;
  readonly healthSignals?: readonly AgentHealthSignal[];
  /** FIX-1267 — override the no-consecutive-repeat rotation toggle (production
   *  reads `.roll/policy.yaml` `loop_safety.builder_no_consecutive_repeat`,
   *  default on). */
  readonly builderNoConsecutiveRepeat?: boolean;
  /** FIX-1267 — override the previous Builder. `undefined` = derive from
   *  `recentUse` (the most-recently-used agent); pass `null` to force "no prior
   *  builder" (nothing excluded). */
  readonly previousBuilder?: AgentName | null;
}

/** FIX-1267 — the most-recently-used Builder from the per-agent recent-use map
 *  (largest ms wins). This is the "previous cycle's builder" the rotation
 *  excludes. Ties (identical ms) resolve deterministically by agent name so the
 *  choice is reproducible. Returns `null` when no builder has ever run. */
export function mostRecentBuilder(recentUse: Readonly<Partial<Record<AgentName, number>>>): AgentName | null {
  let best: AgentName | null = null;
  let bestTs = Number.NEGATIVE_INFINITY;
  for (const [agent, ts] of Object.entries(recentUse) as [AgentName, number][]) {
    if (ts > bestTs || (ts === bestTs && best !== null && agent < best)) {
      bestTs = ts;
      best = agent;
    }
  }
  return best;
}

/** FIX-1267 — read the rotation toggle from `<repoCwd>/.roll/policy.yaml`.
 *  DEFAULT-ON: a missing/unreadable policy (or an absent key) leaves it on. */
function readBuilderNoConsecutiveRepeat(repoCwd: string): boolean {
  const path = join(repoCwd, ".roll", "policy.yaml");
  try {
    if (!existsSync(path)) return true;
    return parsePolicy(readFileSync(path, "utf8")).loopSafety.builderNoConsecutiveRepeat;
  } catch {
    return true;
  }
}

/**
 * Resolve the scoped Builder (`story.execute`) assignment, honoring the active
 * Supervisor binding and recent-use fairness. Returns `null` when no scoped layer is
 * present (the caller falls back to legacy tier routing).
 */
export function resolveScopedStoryExecute(repoCwd: string, deps: ScopedRouteDeps = {}): ScopedExecuteRoute | null {
  return resolveScopedCastRole(repoCwd, "builder", deps);
}

export function resolveScopedCastRole(repoCwd: string, castRole: CastRoleName, deps: ScopedRouteDeps = {}): ScopedExecuteRoute | null {
  const rollHome = deps.rollHome ?? process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  const environmentRuntime = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  const environmentWorkspace = (process.env["ROLL_WORKSPACE"] ?? "").trim() !== "" && environmentRuntime !== ""
    ? dirname(environmentRuntime)
    : undefined;
  const workspaceRoot = deps.workspaceRoot ?? environmentWorkspace;
  const workspacePath = workspaceRoot === undefined ? undefined : join(workspaceRoot, "agents.yaml");
  let workspaceLayer: { config: AgentScopeConfig; path: string } | null = null;
  if (workspacePath !== undefined && existsSync(workspacePath)) {
    const text = readFileSync(workspacePath, "utf8");
    const parsed = normalizeAgentScopeConfig(text);
    if (parsed.config === null || parsed.errors.length > 0 || parsed.config.scope !== "workspace") {
      const details = parsed.errors.length > 0 ? parsed.errors.join("; ") : `expected scope 'workspace'`;
      throw new Error(`invalid workspace agent scope at ${workspacePath}: ${details}`);
    }
    workspaceLayer = { config: parsed.config, path: workspacePath };
  }
  const layers = [
    readScopedAgentLayer(join(rollHome, "agents.yaml")),
    workspaceRoot === undefined ? readScopedAgentLayer(join(repoCwd, ".roll", "agents.yaml")) : workspaceLayer,
  ].filter((layer): layer is { config: AgentScopeConfig; path: string } => layer !== null);
  if (layers.length === 0) return null;

  const installed = deps.installed ?? new Set(agentsInstalled(realAgentEnv()).map((name) => canonicalAgentName(name)));
  const runtimeHealth = Object.fromEntries(
    AGENT_REGISTRY_NAMES.map((agent) => [
      agent,
      installed.has(agent) ? { available: true } : { available: false, reason: "not-installed" },
    ]),
  ) as Partial<Record<AgentName, { available: boolean; reason?: string }>>;

  // Resolve the active Supervisor first so explicit role-aware policies can see
  // the assignment. A supervise failure must not block Builder routing.
  const superviseResolution = resolveAgentScopeRole({ scope: "story", role: "supervise", layers, runtimeHealth });
  const superviseAgent = superviseResolution.ok ? superviseResolution.resolved.agent : null;

  const runtimeDir = runtimeDirFor(repoCwd);
  const recentUse = deps.recentUse ?? readRecentUse(runtimeDir);
  const successfulDeliveries = deps.successfulDeliveries ?? readSuccessfulDeliveries(runtimeDir);
  const healthSignals = deps.healthSignals ?? readHealthSignals(runtimeDir);
  const scopeRole = roleToScopeRole(castRole);
  // FIX-1267 — hard builder rotation: exclude the previous cycle's Builder from
  // THIS Builder resolution so no two consecutive cycles share a builder. Only
  // the Builder (`execute`) role rotates — Evaluator independence is enforced by
  // fresh sessions, not by excluding brands. Config-driven (default on); a fixed
  // owner binding ignores excludeAgents (see the resolver), so an explicit pin is
  // never overridden.
  const rotationOn = castRole === "builder" && (deps.builderNoConsecutiveRepeat ?? readBuilderNoConsecutiveRepeat(repoCwd));
  const previousBuilder = rotationOn
    ? deps.previousBuilder !== undefined
      ? deps.previousBuilder
      : mostRecentBuilder(recentUse)
    : null;
  const excludeAgents = previousBuilder !== null ? [previousBuilder] : [];
  const resolution = resolveAgentScopeRole({
    scope: "story",
    role: scopeRole,
    layers,
    runtimeHealth,
    recentUse,
    healthSignals,
    ...(excludeAgents.length > 0 ? { excludeAgents } : {}),
    ...(superviseAgent !== null ? { assignedRoles: { supervise: superviseAgent } } : {}),
  });
  const caps = declaredCapabilities(layers);
  const candidates = resolution.ok ? resolution.resolved.candidates : resolution.failure.candidates;
  const profiles = candidates.map((agent) => profileFor(agent, caps.get(agent) ?? []));
  const ranked = rankedWithResolutionSkips(rankRoleCandidates({ role: castRole, profiles, healthSignals, recentUse, successfulDeliveries }), resolution);
  return { resolution, castRole, scopeRole, superviseAgent, recentUse, successfulDeliveries, ranked, previousBuilder };
}

/** The auditable role route trace surfaced by the diagnostic command. */
export interface ScopedExecuteRouteTrace {
  readonly role: AgentScopeRole;
  readonly castRole: CastRoleName;
  readonly candidates: readonly AgentName[];
  readonly skipped: readonly { readonly agent: AgentName; readonly reason: string }[];
  readonly ranked: readonly RankedRoleCandidate[];
  readonly strategy: string;
  readonly selected: AgentName | null;
  readonly source: string | null;
  readonly supervise: AgentName | null;
  readonly recentUse: Readonly<Partial<Record<AgentName, number>>>;
  readonly successfulDeliveries: Readonly<Partial<Record<AgentName, number>>>;
  /** FIX-1267 — the previous Builder excluded by the no-consecutive-repeat
   *  rotation (audit anchor for `roll supervisor route`). */
  readonly previousBuilder: AgentName | null;
  readonly error: string | null;
}

/** Project the resolution into the stable trace shape (JSON-friendly, total). */
export function scopedExecuteRouteTrace(route: ScopedExecuteRoute): ScopedExecuteRouteTrace {
  const { resolution, superviseAgent, recentUse, successfulDeliveries, ranked, previousBuilder } = route;
  if (resolution.ok) {
    const r = resolution.resolved;
    return {
      role: route.scopeRole,
      castRole: route.castRole,
      candidates: r.candidates,
      skipped: r.skipped.map((s) => ({ agent: s.agent, reason: s.reason })),
      ranked,
      strategy: r.selectedStrategy,
      selected: r.agent,
      source: r.source,
      supervise: superviseAgent,
      recentUse,
      successfulDeliveries,
      previousBuilder,
      error: null,
    };
  }
  const f = resolution.failure;
  return {
    role: route.scopeRole,
    castRole: route.castRole,
    candidates: f.candidates,
    skipped: f.skipped.map((s) => ({ agent: s.agent, reason: s.reason })),
    ranked,
    strategy: "none",
    selected: null,
    source: f.source ?? null,
    supervise: superviseAgent,
    recentUse,
    successfulDeliveries,
    previousBuilder,
    error: f.errors[0] ?? "story.execute unresolved",
  };
}

/** Human-readable role route trace for `roll supervisor route`. */
export function renderScopedExecuteRoute(trace: ScopedExecuteRouteTrace): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${trace.castRole} route — story.${trace.role}`);
  lines.push(`  source: ${trace.source ?? "(none)"}`);
  lines.push(`  Supervisor (supervise): ${trace.supervise ?? "(unassigned)"}`);
  if (trace.previousBuilder !== null) {
    lines.push(`  previous builder (excluded — no-consecutive-repeat): ${trace.previousBuilder}`);
  }
  lines.push(`  strategy: ${trace.strategy}`);
  lines.push(`  candidates: ${trace.candidates.length > 0 ? trace.candidates.join(", ") : "(none)"}`);
  if (trace.ranked.length > 0) {
    lines.push("  ranked:");
    for (const candidate of trace.ranked) {
      const warnings = candidate.warnings.length > 0 ? ` · warnings=${candidate.warnings.join("; ")}` : "";
      lines.push(`    ${candidate.agent} score=${candidate.score} eligible=${candidate.eligible} · ${candidate.reasons.join(" · ")}${warnings}`);
    }
  }
  if (trace.skipped.length > 0) {
    lines.push("  skipped:");
    for (const s of trace.skipped) lines.push(`    ${s.agent} — ${s.reason}`);
  } else {
    lines.push("  skipped: (none)");
  }
  lines.push(`  selected: ${trace.selected ?? `(none — ${trace.error ?? "unresolved"})`}`);
  lines.push("");
  return lines.join("\n");
}

export type RequirementMatchedWorkspaceDecision = ReturnType<typeof discoverWorkspaceForIntent>;

function storyRequirement(storyIds: readonly string[]): RequirementHintV1 {
  return {
    schema: REQUIREMENT_HINT_V1,
    sources: [],
    storyIds: storyIds.map((storyId) => ({ storyId, provenance: "explicit_user" as const })),
    repositoryRemotes: [],
    paths: [],
  };
}

/** Resolve a Workspace from exact Story/requirement identity. Lifecycle is a
 * gate, never selection evidence; a sole active Workspace with no match stays
 * unselected. This is deliberately pure so CLI/loop/agent entrypoints share
 * one route before any handler or child process starts. */
export function resolveRequirementMatchedWorkspace(input: {
  readonly storyIds: readonly string[];
  readonly workspaces: readonly WorkspaceDiscoveryFactsV1[];
  readonly diagnostics: readonly WorkspaceDiscoveryDiagnosticV1[];
  readonly cwd: string;
  readonly operation: "read" | "mutation";
}): RequirementMatchedWorkspaceDecision {
  return discoverWorkspaceForIntent({
    intent: {
      schema: WORKSPACE_INTENT_V1,
      operation: input.operation,
      interaction: "non_interactive",
      scope: input.operation === "read" ? "workspace_required_read" : "workspace_required_mutation",
      cwd: input.cwd,
      requirement: storyRequirement(input.storyIds),
    },
    workspaces: input.workspaces,
    diagnostics: input.diagnostics,
  });
}

/** Explicit/environment/cwd targets retain selector precedence but still fail
 * a mutation when exact requirement ownership points at another Workspace. */
export function validateRequirementMatchedWorkspace(input: {
  readonly target: WorkspaceDiscoveryFactsV1;
  readonly workspaces: readonly WorkspaceDiscoveryFactsV1[];
  readonly storyIds: readonly string[];
  readonly operation: "read" | "mutation";
}): ReturnType<typeof validateResolvedTargetRequirement> {
  return validateResolvedTargetRequirement({
    target: input.target,
    allWorkspaces: input.workspaces,
    requirement: storyRequirement(input.storyIds),
    operation: input.operation,
  });
}

export type FrozenWorkspaceCycleContextResult =
  | { readonly ok: true; readonly context: WorkspaceExecutionContextV1 }
  | { readonly ok: false; readonly code: string };

/** Bind one already-resolved Workspace snapshot to the picked Issue exactly
 * once. The scope validator performs strict closed-shape validation and returns
 * a deep-frozen JSON snapshot, so later cwd changes or recovery cannot redirect
 * any authority path. */
export function freezeWorkspaceCycleContext(input: {
  readonly workspace: WorkspaceExecutionContextV1;
  readonly storyId: string;
  readonly execution: CycleRepositoryExecutionContext;
}): FrozenWorkspaceCycleContextResult {
  if (
    input.storyId.trim() === "" ||
    input.execution.workspaceId !== input.workspace.workspace.workspaceId ||
    input.execution.issueRoot !== join(input.workspace.workspace.canonicalRoot, "issues", input.storyId)
  ) {
    return { ok: false, code: "missing_execution_context" };
  }
  const resolved = resolveWorkspaceExecutionContextScope({
    scope: "issue_required",
    context: {
      ...input.workspace,
      issue: {
        storyId: input.storyId,
        manifestPath: join(input.execution.issueRoot, "manifest.json"),
        execution: input.execution,
      },
    },
  });
  return resolved.ok && resolved.context !== undefined
    ? { ok: true, context: resolved.context }
    : { ok: false, code: resolved.ok ? "missing_execution_context" : resolved.error.code };
}

/** Restore a serialized cycle handoff through the same strict validator used at
 * initial freeze. A malformed or Workspace-only value cannot resume an Issue
 * cycle. */
export function restoreWorkspaceCycleContext(serialized: string): FrozenWorkspaceCycleContextResult {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return { ok: false, code: "invalid_execution_context" };
  }
  const resolved = resolveWorkspaceExecutionContextScope({
    scope: "issue_required",
    context: value as WorkspaceExecutionContextV1,
  });
  return resolved.ok && resolved.context !== undefined
    ? { ok: true, context: resolved.context }
    : { ok: false, code: resolved.ok ? "missing_execution_context" : resolved.error.code };
}

/** Durable per-cycle authority snapshot. The filename is derived only from the
 * cycle id and lives under the already-scoped runtime directory, so recovery
 * never consults cwd or the active Workspace registry. */
export function workspaceCycleContextPath(runtimeDir: string, cycleId: string): string {
  return join(runtimeDir, "cycle-contexts", `${encodeURIComponent(cycleId)}.json`);
}

/** Persist an Issue-level context exactly once. Existing identical snapshots
 * are idempotent; a different or malformed snapshot fails closed instead of
 * replacing the authority chosen at cycle start. */
export function persistWorkspaceCycleContext(
  runtimeDir: string,
  cycleId: string,
  context: WorkspaceExecutionContextV1,
): FrozenWorkspaceCycleContextResult {
  if (cycleId.trim() === "") return { ok: false, code: "missing_execution_context" };
  const validated = restoreWorkspaceCycleContext(JSON.stringify(context));
  if (!validated.ok) return validated;
  const path = workspaceCycleContextPath(runtimeDir, cycleId);
  const serialized = `${JSON.stringify(validated.context)}\n`;
  let tempPath: string | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      // link(2) publishes the fully-written inode only when `path` is absent.
      // Unlike rename(2), it cannot replace a winner that raced this writer.
      linkSync(tempPath, path);
      return validated;
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== "EEXIST") return { ok: false, code: "execution_context_persist_failed" };
      const existing = restoreWorkspaceCycleContext(readFileSync(path, "utf8"));
      if (!existing.ok) return existing;
      return JSON.stringify(existing.context) === JSON.stringify(validated.context)
        ? existing
        : { ok: false, code: "execution_context_conflict" };
    }
  } catch {
    return { ok: false, code: "execution_context_persist_failed" };
  } finally {
    if (tempPath !== undefined) rmSync(tempPath, { force: true });
  }
}

/** Restore only from the cycle's durable snapshot and validate it through the
 * same issue-required boundary as the initial freeze. */
export function restorePersistedWorkspaceCycleContext(
  runtimeDir: string,
  cycleId: string,
): FrozenWorkspaceCycleContextResult {
  const path = workspaceCycleContextPath(runtimeDir, cycleId);
  if (!existsSync(path)) return { ok: false, code: "missing_execution_context" };
  try {
    return restoreWorkspaceCycleContext(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, code: "invalid_execution_context" };
  }
}

export type WorkspaceCycleRepositoryResult =
  | { readonly ok: true; readonly repoId: string; readonly repository: RepositoryExecutionContext }
  | {
      readonly ok: false;
      readonly code:
        | "missing_execution_context"
        | "repository_selector_required"
        | "unknown_repository_selector"
        | "ambiguous_repository_selector";
    };

/** Repository-required operations always name a stable repoId. Cardinality one
 * is not a selector and multi-repo order is never authority. */
export function resolveWorkspaceCycleRepository(
  context: WorkspaceExecutionContextV1,
  selector?: string,
): WorkspaceCycleRepositoryResult {
  const scoped = resolveWorkspaceExecutionContextScope({ scope: "repository_required", context });
  if (!scoped.ok || scoped.context?.issue === undefined) {
    return { ok: false, code: "missing_execution_context" };
  }
  const repositories = Object.values(scoped.context.issue.execution.repositories);
  const requested = (selector ?? "").trim();
  if (requested === "") {
    return repositories.length === 1 && repositories[0] !== undefined
      ? { ok: true, repoId: repositories[0].repoId, repository: repositories[0] }
      : { ok: false, code: "repository_selector_required" };
  }
  const byId = repositories.find((repository) => repository.repoId === requested);
  if (byId !== undefined) return { ok: true, repoId: byId.repoId, repository: byId };
  const byAlias = repositories.filter((repository) => repository.alias === requested);
  if (byAlias.length > 1) return { ok: false, code: "ambiguous_repository_selector" };
  const repository = byAlias[0];
  return repository === undefined
    ? { ok: false, code: "unknown_repository_selector" }
    : { ok: true, repoId: repository.repoId, repository };
}

export function workspaceCycleRepositorySelectorPath(runtimeDir: string, cycleId: string): string {
  return join(runtimeDir, "cycle-contexts", `${encodeURIComponent(cycleId)}.repository`);
}

export function persistWorkspaceCycleRepositorySelector(
  runtimeDir: string,
  cycleId: string,
  context: WorkspaceExecutionContextV1,
  selector?: string,
): WorkspaceCycleRepositoryResult {
  if (cycleId.trim() === "") return { ok: false, code: "missing_execution_context" };
  const resolved = resolveWorkspaceCycleRepository(context, selector);
  if (!resolved.ok) return resolved;
  const path = workspaceCycleRepositorySelectorPath(runtimeDir, cycleId);
  const serialized = `${resolved.repoId}\n`;
  let tempPath: string | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      linkSync(tempPath, path);
      return resolved;
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== "EEXIST") return { ok: false, code: "missing_execution_context" };
      const existing = readFileSync(path, "utf8").trim();
      return existing === resolved.repoId
        ? resolved
        : { ok: false, code: "unknown_repository_selector" };
    }
  } catch {
    return { ok: false, code: "missing_execution_context" };
  } finally {
    if (tempPath !== undefined) rmSync(tempPath, { force: true });
  }
}

export function restorePersistedWorkspaceCycleRepositorySelector(
  runtimeDir: string,
  cycleId: string,
  context: WorkspaceExecutionContextV1,
): WorkspaceCycleRepositoryResult {
  const path = workspaceCycleRepositorySelectorPath(runtimeDir, cycleId);
  if (!existsSync(path)) return { ok: false, code: "missing_execution_context" };
  try {
    return resolveWorkspaceCycleRepository(context, readFileSync(path, "utf8").trim());
  } catch {
    return { ok: false, code: "missing_execution_context" };
  }
}
