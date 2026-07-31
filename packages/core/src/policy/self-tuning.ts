/**
 * @responsibility Proposes human-confirmed policy tuning candidates from feedback.
 * US-EVID-015 — second-order control loop.
 *
 * This module is pure: trend facts in, conservative tuning suggestions out.
 * It never mutates `.roll/policy.yaml`, `.roll/agents.yaml`, or rubric config.
 * The CLI/runner may decide how to present or apply proposals later; the safe
 * default is suggest-only with an auditable evidence chain and rollback command.
 */

export type MisjudgmentKind = "false_block" | "leak";
export type SelfTuningMode = "suggest";
export type SelfTuningProposalKind = "threshold" | "route_preference" | "rubric_weight";

export interface ReviewScoreTrendSample {
  score: number;
  verdict: string;
  at?: string;
}

export interface AgentSlotTrend {
  tier: string;
  storyType: string;
  agent: string;
  total: number;
  passed: number;
}

export interface MisjudgmentTrend {
  kind: MisjudgmentKind;
  count: number;
}

export interface RubricSignalTrend {
  dimension: string;
  samples: number;
  reworkCorrelation: number;
  noise: number;
}

export interface SelfTuningCurrentConfig {
  lowScoreThreshold: number;
  routePreferences?: Record<string, string>;
  rubricWeights?: Record<string, number>;
}

export interface SelfTuningInput {
  now: string;
  current: SelfTuningCurrentConfig;
  reviewScores: readonly ReviewScoreTrendSample[];
  agentSlots: readonly AgentSlotTrend[];
  misjudgments: readonly MisjudgmentTrend[];
  rubricSignals: readonly RubricSignalTrend[];
  minSamples?: number;
  cooldownHours?: number;
  lastTunedAt?: string;
  damping?: number;
}

export interface SelfTuningRollback {
  command: string;
  defaultValue: string | number;
}

export interface SelfTuningProposal {
  kind: SelfTuningProposalKind;
  target: string;
  action: "tighten" | "relax" | "prefer_agent" | "raise_weight" | "lower_weight";
  from: string | number;
  to: string | number;
  rationale: string;
  evidence: string[];
  rollback: SelfTuningRollback;
}

export interface SelfTuningStability {
  sampleCount: number;
  minSamples: number;
  sampleGate: "ok" | "insufficient";
  cooldownActive: boolean;
  cooldownHours: number;
  damping: number;
}

export interface SelfTuningPlan {
  mode: SelfTuningMode;
  generatedAt: string;
  applied: false;
  stability: SelfTuningStability;
  summary: string;
  proposals: SelfTuningProposal[];
}

const DEFAULT_MIN_SAMPLES = 8;
const DEFAULT_COOLDOWN_HOURS = 24;
const DEFAULT_DAMPING = 1;
export const DEFAULT_LOW_SCORE_THRESHOLD = 5;
export const DEFAULT_RUBRIC_WEIGHT = 1;

function finite(n: number): boolean {
  return Number.isFinite(n);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmtRate(n: number): string {
  return n.toFixed(2);
}

function boundedThresholdStep(current: number, target: number, damping: number): number {
  const step = Math.max(1, Math.trunc(Math.abs(damping)));
  if (target > current) return Math.min(current + step, target);
  if (target < current) return Math.max(current - step, target);
  return current;
}

function percentile(values: readonly number[], q: number): number | undefined {
  const nums = values.filter(finite).sort((a, b) => a - b);
  if (nums.length === 0) return undefined;
  if (nums.length === 1) return nums[0];
  const pos = (nums.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lo = nums[base];
  const hi = nums[base + 1];
  if (lo === undefined) return undefined;
  if (hi === undefined) return lo;
  return lo + rest * (hi - lo);
}

function misjudgmentCount(items: readonly MisjudgmentTrend[], kind: MisjudgmentKind): number {
  let total = 0;
  for (const item of items) {
    if (item.kind !== kind || !finite(item.count)) continue;
    total += Math.max(0, item.count);
  }
  return total;
}

function cooldownActive(now: string, lastTunedAt: string | undefined, cooldownHours: number): boolean {
  if (lastTunedAt === undefined || lastTunedAt === "") return false;
  const nowMs = Date.parse(now);
  const lastMs = Date.parse(lastTunedAt);
  if (!finite(nowMs) || !finite(lastMs)) return false;
  return nowMs - lastMs < cooldownHours * 60 * 60 * 1000;
}

function reset(target: string, value: string | number): SelfTuningRollback {
  return { command: `roll tune reset --target ${target}`, defaultValue: value };
}

function thresholdProposal(input: SelfTuningInput, damping: number): SelfTuningProposal | undefined {
  const current = input.current.lowScoreThreshold;
  const scores = input.reviewScores.map((s) => s.score).filter(finite);
  const p25 = percentile(scores, 0.25);
  const falseBlock = misjudgmentCount(input.misjudgments, "false_block");
  const leak = misjudgmentCount(input.misjudgments, "leak");
  if (falseBlock === 0 && leak === 0) return undefined;

  const distributionTarget = p25 === undefined ? current : Math.round(p25);
  if (leak > falseBlock * 1.5 && leak >= 2) {
    const raw = clamp(Math.max(current + 1, distributionTarget), 1, 9);
    const next = boundedThresholdStep(current, raw, damping);
    if (next === current) return undefined;
    return {
      kind: "threshold",
      target: "self_score.low_threshold",
      action: "tighten",
      from: current,
      to: next,
      rationale: "漏放高于误拦，低分门限收紧一档；分布目标来自 review-score P25。",
      evidence: [`review-score samples=${scores.length}`, `p25=${p25?.toFixed(2) ?? "n/a"}`, `false_block=${falseBlock}`, `leak=${leak}`],
      rollback: reset("self_score.low_threshold", DEFAULT_LOW_SCORE_THRESHOLD),
    };
  }
  if (falseBlock > leak * 1.5 && falseBlock >= 2) {
    const raw = clamp(Math.min(current - 1, distributionTarget), 1, 9);
    const next = boundedThresholdStep(current, raw, damping);
    if (next === current) return undefined;
    return {
      kind: "threshold",
      target: "self_score.low_threshold",
      action: "relax",
      from: current,
      to: next,
      rationale: "误拦高于漏放，低分门限放宽一档；分布目标来自 review-score P25。",
      evidence: [`review-score samples=${scores.length}`, `p25=${p25?.toFixed(2) ?? "n/a"}`, `false_block=${falseBlock}`, `leak=${leak}`],
      rollback: reset("self_score.low_threshold", DEFAULT_LOW_SCORE_THRESHOLD),
    };
  }
  return undefined;
}

interface AgentGroup {
  key: string;
  rows: AgentSlotTrend[];
}

function agentGroups(rows: readonly AgentSlotTrend[], minSamples: number): AgentGroup[] {
  const groups = new Map<string, AgentSlotTrend[]>();
  for (const row of rows) {
    if (row.total < minSamples || row.agent.trim() === "" || row.tier.trim() === "" || row.storyType.trim() === "") continue;
    const key = `${row.tier}/${row.storyType}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, groupRows]) => ({ key, rows: groupRows }));
}

function routeProposals(input: SelfTuningInput, minSamples: number): SelfTuningProposal[] {
  const out: SelfTuningProposal[] = [];
  for (const group of agentGroups(input.agentSlots, minSamples)) {
    if (group.rows.length < 2) continue;
    const ranked = [...group.rows].sort((a, b) => b.passed / b.total - a.passed / a.total || a.agent.localeCompare(b.agent));
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    if (best === undefined || worst === undefined) continue;
    const bestRate = best.passed / best.total;
    const worstRate = worst.passed / worst.total;
    if (bestRate - worstRate < 0.2) continue;
    const current = input.current.routePreferences?.[group.key] ?? worst.agent;
    if (current === best.agent) continue;
    out.push({
      kind: "route_preference",
      target: `route.${group.key}`,
      action: "prefer_agent",
      from: current,
      to: best.agent,
      rationale: "同复杂度/类型下 agent 槽 pass rate 差异显著，生成软路由偏好建议。",
      evidence: group.rows
        .sort((a, b) => a.agent.localeCompare(b.agent))
        .map((r) => `${r.agent} pass_rate=${fmtRate(r.passed / r.total)} n=${r.total}`),
      rollback: reset(`route.${group.key}`, "clear"),
    });
  }
  return out;
}

function rubricProposals(input: SelfTuningInput, minSamples: number): SelfTuningProposal[] {
  const out: SelfTuningProposal[] = [];
  for (const signal of input.rubricSignals) {
    if (signal.samples < minSamples) continue;
    const current = input.current.rubricWeights?.[signal.dimension] ?? DEFAULT_RUBRIC_WEIGHT;
    if (signal.reworkCorrelation >= 0.6 && signal.noise <= 0.4) {
      const next = round1(clamp(current + 0.2, 0.2, 3));
      if (next === current) continue;
      out.push({
        kind: "rubric_weight",
        target: `rubric.${signal.dimension}.weight`,
        action: "raise_weight",
        from: current,
        to: next,
        rationale: "该 rubric 维度与真实返工强相关，权重小幅上调。",
        evidence: [
          `dimension=${signal.dimension}`,
          `samples=${signal.samples}`,
          `rework_correlation=${fmtRate(signal.reworkCorrelation)}`,
          `noise=${fmtRate(signal.noise)}`,
        ],
        rollback: reset(`rubric.${signal.dimension}.weight`, DEFAULT_RUBRIC_WEIGHT),
      });
    } else if (signal.noise >= 0.6 && signal.reworkCorrelation <= 0.3) {
      const next = round1(clamp(current - 0.2, 0.2, 3));
      if (next === current) continue;
      out.push({
        kind: "rubric_weight",
        target: `rubric.${signal.dimension}.weight`,
        action: "lower_weight",
        from: current,
        to: next,
        rationale: "该 rubric 维度噪声高且与真实返工弱相关，权重小幅下调。",
        evidence: [
          `dimension=${signal.dimension}`,
          `samples=${signal.samples}`,
          `rework_correlation=${fmtRate(signal.reworkCorrelation)}`,
          `noise=${fmtRate(signal.noise)}`,
        ],
        rollback: reset(`rubric.${signal.dimension}.weight`, DEFAULT_RUBRIC_WEIGHT),
      });
    }
  }
  return out;
}

export function buildSelfTuningPlan(input: SelfTuningInput): SelfTuningPlan {
  const minSamples = Math.max(1, Math.trunc(input.minSamples ?? DEFAULT_MIN_SAMPLES));
  const cooldownHours = Math.max(0, input.cooldownHours ?? DEFAULT_COOLDOWN_HOURS);
  const damping = Math.max(0.1, input.damping ?? DEFAULT_DAMPING);
  const sampleCount = input.reviewScores.length;
  const sampleGate = sampleCount >= minSamples ? "ok" : "insufficient";
  const isCooling = cooldownActive(input.now, input.lastTunedAt, cooldownHours);
  const stability: SelfTuningStability = {
    sampleCount,
    minSamples,
    sampleGate,
    cooldownActive: isCooling,
    cooldownHours,
    damping,
  };
  if (sampleGate === "insufficient") {
    return {
      mode: "suggest",
      generatedAt: input.now,
      applied: false,
      stability,
      summary: `self-tuning held: ${sampleCount}/${minSamples} review-score samples`,
      proposals: [],
    };
  }
  if (isCooling) {
    return {
      mode: "suggest",
      generatedAt: input.now,
      applied: false,
      stability,
      summary: `self-tuning held: cooldown ${cooldownHours}h still active`,
      proposals: [],
    };
  }

  const proposals: SelfTuningProposal[] = [];
  const threshold = thresholdProposal(input, damping);
  if (threshold !== undefined) proposals.push(threshold);
  proposals.push(...routeProposals(input, minSamples));
  proposals.push(...rubricProposals(input, minSamples));
  return {
    mode: "suggest",
    generatedAt: input.now,
    applied: false,
    stability,
    summary: proposals.length === 0 ? "self-tuning: no stable adjustment suggested" : `self-tuning: ${proposals.length} suggestion(s)`,
    proposals,
  };
}
