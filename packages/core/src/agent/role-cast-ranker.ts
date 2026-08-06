/**
 * @responsibility Ranks role candidates by capability against the cast role requirements.
 */
import type {
  AgentCapabilityProfile,
  AgentHealthSignal,
  AgentName,
  CastRoleName,
  RankedRoleCandidate,
  RoleCastRankingInput,
} from "@roll/spec";

function roleCapable(profile: AgentCapabilityProfile, role: CastRoleName): boolean {
  if (role === "builder" || role === "designer") return profile.canExecute;
  if (role === "evaluator") return profile.canReview || profile.canScore;
  return profile.canReview;
}

function latestHealth(agent: AgentName, signals: readonly AgentHealthSignal[], nowMs = Date.now()): AgentHealthSignal | undefined {
  let latest: AgentHealthSignal | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const signal of signals) {
    if (signal.agent !== agent) continue;
    if (signal.expiresAt !== undefined) {
      const expires = Date.parse(signal.expiresAt);
      if (!Number.isNaN(expires) && expires < nowMs) continue;
    }
    const observed = Date.parse(signal.observedAt);
    const score = Number.isNaN(observed) ? 0 : observed;
    if (latest === undefined || score >= latestMs) {
      latest = signal;
      latestMs = score;
    }
  }
  return latest;
}

function healthDelta(signal: AgentHealthSignal | undefined): number {
  if (signal === undefined || signal.status === "unknown") return -6;
  if (signal.status === "healthy") return 20;
  if (signal.status === "degraded") return -24;
  return -120;
}

function costDelta(profile: AgentCapabilityProfile, risk: RoleCastRankingInput["storyRisk"]): number {
  const band = profile.costBand ?? "unknown";
  if (band === "low") return 2;
  if (band === "medium") return 0;
  if (band === "high") return risk === "high" ? -6 : -16;
  return -4;
}

function recentDelta(agent: AgentName, recentUse: RoleCastRankingInput["recentUse"]): number {
  if (recentUse === undefined || recentUse[agent] === undefined) return 6;
  return -4;
}

function deliveryDelta(agent: AgentName, successfulDeliveries: RoleCastRankingInput["successfulDeliveries"]): number {
  const count = successfulDeliveries?.[agent] ?? 0;
  return Math.min(count, 3) * 4;
}

function roleDelta(profile: AgentCapabilityProfile, role: CastRoleName): number {
  if (role === "evaluator") return profile.canScore ? 14 : 8;
  if (role === "peer_reviewer") return profile.canReview ? 12 : 0;
  return profile.canExecute ? 14 : 0;
}

function shortcomingDelta(profile: AgentCapabilityProfile, role: CastRoleName, risk: RoleCastRankingInput["storyRisk"]): number {
  if (role !== "builder" || risk === "low") return 0;
  const text = profile.knownShortcomings.join(" ").toLowerCase();
  if (text.includes("broad builder") || text.includes("weaker") || text.includes("focused")) return -10;
  return 0;
}

function warningFor(signal: AgentHealthSignal | undefined): string[] {
  if (signal === undefined) return ["health unknown"];
  if (signal.status === "healthy") return [];
  const reason = signal.reason === undefined ? signal.status : `${signal.status}:${signal.reason}`;
  return [`health ${reason}`];
}

function reasonsFor(input: RoleCastRankingInput, profile: AgentCapabilityProfile, signal: AgentHealthSignal | undefined): string[] {
  const reasons: string[] = [];
  if (roleCapable(profile, input.role)) reasons.push(`capable:${input.role}`);
  else reasons.push(`missing-capability:${input.role}`);
  if (signal === undefined) reasons.push("health:unknown");
  else reasons.push(`health:${signal.status}`);
  const deliveries = input.successfulDeliveries?.[profile.agent] ?? 0;
  if (deliveries > 0) reasons.push(`successful-deliveries:${deliveries}`);
  if (profile.costBand !== undefined) reasons.push(`cost:${profile.costBand}`);
  for (const strength of profile.strengths.slice(0, 2)) reasons.push(`strength:${strength}`);
  for (const shortcoming of profile.knownShortcomings.slice(0, 2)) reasons.push(`shortcoming:${shortcoming}`);
  return reasons;
}

function rankOne(input: RoleCastRankingInput, profile: AgentCapabilityProfile): RankedRoleCandidate {
  const signal = latestHealth(profile.agent, input.healthSignals);
  const capable = roleCapable(profile, input.role);
  const blocked = signal?.status === "blocked";
  const eligible = capable && !blocked;
  const raw = 50 + roleDelta(profile, input.role) + healthDelta(signal) + costDelta(profile, input.storyRisk) + recentDelta(profile.agent, input.recentUse) + deliveryDelta(profile.agent, input.successfulDeliveries) + shortcomingDelta(profile, input.role, input.storyRisk);
  const score = eligible ? Math.max(0, Math.min(100, raw)) : 0;
  return {
    agent: profile.agent,
    eligible,
    score,
    reasons: reasonsFor(input, profile, signal),
    warnings: warningFor(signal),
  };
}

/** Deterministic health-aware role-cast ranking. All candidates stay visible. */
export function rankRoleCandidates(input: RoleCastRankingInput): RankedRoleCandidate[] {
  return input.profiles
    .map((profile) => rankOne(input, profile))
    .sort((a, b) => b.score - a.score || Number(b.eligible) - Number(a.eligible) || a.agent.localeCompare(b.agent));
}
